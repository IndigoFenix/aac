// ⚠️ ADDING A NEW AAC SETTING? It will SILENTLY NOT SAVE unless you also update
// the SERVER whitelist. Saving goes PATCH /api/students/:id → studentController
// → studentService.updateStudent, which splits the body against the
// `AAC_SETTINGS_FIELDS` allow-list in `server/services/studentService.ts` and
// DROPS any field not in it. So for each new aac_settings column, do ALL of:
//   1. Add the column in `shared/schema-private.ts` (+ a drizzle migration).
//   2. Add the field name to `AAC_SETTINGS_FIELDS` in server/services/studentService.ts
//      ← the step that's been missed repeatedly (the panel save no-ops without it).
//   3. Wire it here: useState + load-from-aac + dirty-check + the mutation
//      type + the handleSave payload + the cancel/reset.
//   4. (If the AI should read/write it too) expose it in
//      `server/services/memory-schema/aac-settings-memory-schema.ts`
//      (WRITABLE_COLUMNS + AAC_SETTINGS_FIELD.properties).
// Settings nested inside `appConfig` (e.g. socialTrainer) DON'T need step 2 —
// `appConfig` is already whitelisted; only brand-new top-level columns do.
import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStudent } from '@/hooks/useStudent';
import { useAuth } from '@/hooks/useAuth';
import { AACSettingsCustomApps } from '@/components/AACSettingsCustomApps';
import { AACSettingsPackages } from '@/components/AACSettingsPackages';
import { AACSettingsCaretakerPin } from '@/components/AACSettingsCaretakerPin';
import { CollapsibleSection, CollapsibleSubSection } from '@/components/ui/collapsible-section';
import { BetaBadge } from '@/components/ui/beta-badge';
import { MenuReviewCard } from '@/components/venue-menus/MenuReviewCard';
import { VenueMenuSettingsCard } from '@/components/venue-menus/VenueMenuSettingsCard';
import { normalizeVenueMenuSettings, type VenueMenuSettings } from '@shared/venue-menus';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { apiRequest, ServiceUnavailableError } from '@/lib/queryClient';
import type { DefinedGesture, HomeAction, PermittedWebsite, PermittedYoutubeItem, PermittedYoutubeItemType } from '@shared/schema';
import { resolvePermittedYoutubeItems } from '@shared/youtube-items';
import { normalizeHomeActions } from '@shared/home-actions';
import {
  DEFAULT_SESSION_RECORDING,
  IDLE_TAIL_SECONDS_MAX,
  IDLE_TAIL_SECONDS_MIN,
  MAX_AGE_DAYS_MAX,
  MAX_AGE_DAYS_MIN,
  MAX_CLIP_MINUTES_MAX,
  MAX_CLIP_MINUTES_MIN,
  MAX_STORAGE_MB_MAX,
  MAX_STORAGE_MB_MIN,
  PRE_ROLL_SECONDS_MAX,
  PRE_ROLL_SECONDS_MIN,
  normalizeSessionRecordingSettings,
  type RecordingQuality,
  type SessionRecordingSettings,
} from '@shared/aac/session-recording';
import { LANGUAGE_LEVELS, DEFAULT_LANGUAGE_LEVEL_INT } from '@shared/aac-language-level';
import { tierByKey } from '@shared/aac/budget-tiers';
import { processVoice } from '@shared/aac/pitch-shifter';
import { BudgetMeters } from '@/components/BudgetMeters';
import { type SeizureConfig, type SeizureSensitivity, DEFAULT_SEIZURE_CONFIG, coerceSeizureConfig } from '@shared/aac/seizure-config';
import { MARKER_KINDS, kindTakesSide, type MarkerKind, type MarkerSide, type SeizureMarker } from '@shared/aac/seizure-markers';
import { COMPETENCY_LABEL } from '@shared/social-bot/state';
import {
  parseSmoothingSettings,
  serializeSmoothingSettings,
  settingsForPreset,
  defaultSmoothingSettings,
  type GazeSmoothingSettings,
  type GazeSmoothingPreset,
} from '@shared/gaze-smoothing';

// All trainable social-skill keys, in canonical order. Sourced from the shared
// competency-label map so this list grows automatically as competencies are added.
const SOCIAL_SKILLS = Object.keys(COMPETENCY_LABEL);
const DEFAULT_SOCIAL_CEILING = 0.4;

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { DEFAULT_MAX_RESULTS, MAX_RESULTS_CEILING, MIN_RESULTS } from '@shared/picture-search';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { useToast } from '@/hooks/use-toast';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  MessageSquare,
  Volume2,
  Gauge,
  Save,
  RotateCcw,
  User,
  Loader2,
  LayoutGrid,
  Crosshair,
  Play,
  Shield,
  AppWindow,
  Link,
  Unlink,
  Accessibility,
  Globe,
  Hand,
  Home,
  Plus,
  Trash2,
  Video,
  ListVideo,
  Sparkles,
  ChevronDown,
  Activity,
  AlertTriangle,
  MapPin,
  Lock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ratioLevel, labelFontSize, labelLines } from '@shared/button-sizing';

interface AACSettingsPanelProps {
  isOpen?: boolean;
  onClose?: () => void;
}

// The custom AAC prompt is now a LIST of rules (one caretaker request per
// entry) rather than one block of text. "Reset to default" seeds the list with
// these starter rules.
const DEFAULT_AAC_RULES: string[] = [
  'Respond in a friendly, supportive manner',
  'Keep responses concise and clear',
  "Help expand on the user's symbol selections to form complete thoughts",
  'Ask clarifying questions when needed',
  'Be patient and encouraging',
];

/**
 * Coerce a stored prompt field into a clean string[] of rules. The columns are
 * jsonb arrays now, but legacy rows / device storage may still hold a single
 * string — treat that whole string as one rule so nothing is lost.
 */
function toRuleArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}

/**
 * A stable id for a new smart-home action slot. Same shape the board store uses
 * for local ids — random enough to be unique within one student's list, and
 * fixed once created (the server gates presses on it, so it must NEVER be
 * derived from the editable label).
 */
const createHomeActionId = () =>
  'home-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// Gemini / Google Chirp 3 HD voice catalogue — the same names exist on both
// providers, so one picked name serves Live native audio AND Google TTS.
// i18n-ignore — official voice names with vendor-provided descriptors.
const GEMINI_VOICE_OPTIONS = [
  { value: 'Puck', label: 'Puck — Young, energetic' },
  { value: 'Charon', label: 'Charon — Calm, mature male' },
  { value: 'Kore', label: 'Kore — Clear, friendly female' },
  { value: 'Fenrir', label: 'Fenrir — Deep, confident male' },
  { value: 'Aoede', label: 'Aoede — Warm, expressive female' },
  { value: 'Leda', label: 'Leda — Gentle, youthful female' },
  { value: 'Orus', label: 'Orus — Steady, reassuring male' },
  { value: 'Zephyr', label: 'Zephyr — Light, neutral' },
];

// Seizure detection is built but not yet clinically tuned, so the settings
// section renders read-only (see the section for why it stays visible at all).
// Flip this to true — and drop the `disabled`/`checked={false}` props on the
// controls below — the day the detectors are ready to be switched on.
const SEIZURE_DETECTION_AVAILABLE = false;

export function AACSettingsPanel({ isOpen = true, onClose }: AACSettingsPanelProps) {
  const { student, refetchStudent } = useStudent();
  // SLP MODE is the ONE setting on this panel that belongs to the logged-in
  // USER rather than the student, so it reads/writes the profile endpoint and
  // must never enter the per-student PATCH payload / AAC_SETTINGS_FIELDS.
  const { user, refetchUser } = useAuth();
  const { t, isRTL } = useLanguage();
  const { theme } = useTheme();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isDark = theme === 'dark';


  // Form state
  const [aiName, setAiName] = useState('');
  // Custom AAC prompt — a LIST of caretaker-requested rules (one per entry).
  const [chatAgentPrompt, setChatAgentPrompt] = useState<string[]>([]);
  // Auto-generated AAC prompt — AI-owned list of notes. Shown read-only;
  // clinicians can delete entries but don't hand-edit them (the assistant
  // maintains them as it learns).
  const [autoAacPrompt, setAutoAacPrompt] = useState<string[]>([]);
  const [liveAudioSpeaker, setLiveAudioSpeaker] = useState(true);
  const [fullAttentionMode, setFullAttentionMode] = useState(false);
  // Allow a clinician on a video call to facilitate button presses on the
  // student's mirrored board (guided communication). Off by default.
  const [allowFacilitatorControl, setAllowFacilitatorControl] = useState(false);
  const [boardManagerLiveModel, setBoardManagerLiveModel] = useState(false);
  // Cost budget tier ("" = inherit the deployment default). The meters below
  // are computed live from the persisted budget snapshot + the SELECTED tier,
  // so changing this previews the new caps before saving.
  const [budgetTier, setBudgetTier] = useState('');
  // Seizure detection — TECHNICAL config for the client motion detectors (master
  // switch + per-detector sensitivity + audio corroboration). The learned
  // baseline lives in the same JSON server-side and is NOT edited here.
  const [seizureDetection, setSeizureDetection] = useState<SeizureConfig>(DEFAULT_SEIZURE_CONFIG);
  const [elevenlabsEnabled, setElevenlabsEnabled] = useState(true);
  const [elevenlabsApiKey, setElevenlabsApiKey] = useState('');
  const [elevenlabsAiVoiceId, setElevenlabsAiVoiceId] = useState('');
  const [elevenlabsStudentVoiceId, setElevenlabsStudentVoiceId] = useState('');
  const [geminiAiVoice, setGeminiAiVoice] = useState('');
  const [geminiStudentVoice, setGeminiStudentVoice] = useState('');
  const [aiVoicePitch, setAiVoicePitch] = useState(0);
  const [studentVoicePitch, setStudentVoicePitch] = useState(0);
  const [useLocalTts, setUseLocalTts] = useState(false);
  const [iconTextRatio, setIconTextRatio] = useState(3);
  const [languageLevel, setLanguageLevel] = useState(DEFAULT_LANGUAGE_LEVEL_INT);
  // startupMode: false = 0 (quick — cached session plan), true = 1 (thorough — regenerate every session)
  const [thoroughStartup, setThoroughStartup] = useState(false);
  const [singleGlyphButtons, setSingleGlyphButtons] = useState(false);
  const [glyphInputTranslation, setGlyphInputTranslation] = useState(false);
  // Press pacing — how long the AI waits before answering a press (0 = at once,
  // above zero lets the student chain buttons into one thought) and whether a
  // different button pressed over an in-flight answer abandons it.
  const [pressResponseDelay, setPressResponseDelay] = useState(0);
  const [interruptOnNewPress, setInterruptOnNewPress] = useState(false);
  const [eyegazeEnabled, setEyegazeEnabled] = useState(false);
  const [eyegazeTimeout, setEyegazeTimeout] = useState(2000);
  const [eyegazeProvider, setEyegazeProvider] = useState<string>('mouse');
  const [selectionMethod, setSelectionMethod] = useState<string>('whole_button');
  const [restSpace, setRestSpace] = useState<string>('large');
  const [autoAudioScan, setAutoAudioScan] = useState(false);
  const [autoAudioScanDelay, setAutoAudioScanDelay] = useState(15000);
  const [gazeSmoothing, setGazeSmoothing] = useState<GazeSmoothingSettings>(defaultSmoothingSettings());
  const [gazeAdvancedOpen, setGazeAdvancedOpen] = useState(false);
  const [allowReadProgress, setAllowReadProgress] = useState(true);
  const [allowReadReports, setAllowReadReports] = useState(true);
  const [allowNotes, setAllowNotes] = useState(true);
  const [shareMonitorNotesWithInstitute, setShareMonitorNotesWithInstitute] = useState(true);
  const [autoAddContacts, setAutoAddContacts] = useState(true);
  const [deviceLocationEnabled, setDeviceLocationEnabled] = useState(false);
  const [appConfig, setAppConfig] = useState<Record<string, any>>({});
  const [permittedWebsites, setPermittedWebsites] = useState<PermittedWebsite[]>([]);
  const [homeActions, setHomeActions] = useState<HomeAction[]>([]);
  const [venueMenus, setVenueMenus] = useState<VenueMenuSettings>(() => normalizeVenueMenuSettings(undefined));
  // One settings OBJECT, held whole and edited through setSessionRecording —
  // mirroring how it is stored. See shared/aac/session-recording.ts.
  const [sessionRecording, setSessionRecording] =
    useState<SessionRecordingSettings>(DEFAULT_SESSION_RECORDING);
  const [definedGestures, setDefinedGestures] = useState<DefinedGesture[]>([]);
  const [permittedYoutubeItems, setPermittedYoutubeItems] = useState<PermittedYoutubeItem[]>([]);
  const [youtubeInput, setYoutubeInput] = useState('');
  const [resolvingYoutube, setResolvingYoutube] = useState(false);
  const [accessFontSize, setAccessFontSize] = useState(100);
  const [accessHighContrast, setAccessHighContrast] = useState(false);
  const [accessReduceAnimations, setAccessReduceAnimations] = useState(false);
  const [accessEnhancedFocus, setAccessEnhancedFocus] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Fetch ElevenLabs voices when API key is present
  const [debouncedApiKey, setDebouncedApiKey] = useState('');
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => setDebouncedApiKey(elevenlabsApiKey.trim()), 600);
    return () => clearTimeout(debounceTimerRef.current);
  }, [elevenlabsApiKey]);

  const { data: elevenlabsVoices, isLoading: elevenlabsLoading, isError: elevenlabsError, error: elevenlabsErrorObj } = useQuery({
    queryKey: ['/api/voices/elevenlabs-list', debouncedApiKey],
    queryFn: async () => {
      try {
        const res = await apiRequest('POST', '/api/voices/elevenlabs-list', { apiKey: debouncedApiKey });
        const data = await res.json();
        return data.voices as Array<{ voice_id: string; name: string; category: string; labels: Record<string, string> }>;
      } catch (e: any) {
        // The server passes through ElevenLabs' machine code for key mistakes
        // (e.g. "api_key_id_used_as_api_key" — the dashboard's 64-hex key ID
        // pasted where the once-shown "sk_" secret belongs). apiRequest buries
        // the body in the error message as "400: {json}" — dig the code out so
        // the UI can name the actual mistake instead of "invalid key".
        const err = e instanceof Error ? (e as Error & { keyErrorCode?: string }) : new Error(String(e));
        if (e instanceof ServiceUnavailableError) {
          (err as any).keyErrorCode = 'upstream_error';
        } else {
          try {
            (err as any).keyErrorCode = JSON.parse(e.message.replace(/^\d+:\s*/, '')).code;
          } catch {
            // no machine code in the body — the generic message will show
          }
        }
        throw err;
      }
    },
    enabled: debouncedApiKey.length > 0,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  // Each recognized code gets a message that says what was pasted and how to
  // fix it — the generic "invalid key" reads as a false alarm to a clinician
  // who just copied "the key" from the ElevenLabs dashboard.
  const elevenlabsErrorKey = (() => {
    switch ((elevenlabsErrorObj as { keyErrorCode?: string } | null)?.keyErrorCode) {
      case 'api_key_id_used_as_api_key': return 'aacSettings.elevenlabsKeyIdHint';
      case 'invalid_api_key_prefix': return 'aacSettings.elevenlabsKeyFormatHint';
      case 'upstream_error': return 'aacSettings.elevenlabsUnreachable';
      default: return 'aacSettings.elevenlabsInvalidKey';
    }
  })();
  // ElevenLabs only actually speaks when the section is enabled AND a key
  // ElevenLabs itself accepted is in hand: the server's student-level path
  // needs key + voice ID together, so an ID on its own is config that does
  // nothing. This gates the voice-ID rows and decides whether the Google
  // pickers are the real voice or only the fallback behind ElevenLabs.
  const elevenlabsActive = elevenlabsEnabled && !!debouncedApiKey && !elevenlabsError;

  // Voice preview state
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // Play a preview blob. A nonzero pitch runs the SAME shared pitch shifter
  // the AAC player applies to live audio (shared/aac/pitch-shifter), so the
  // preview sounds exactly like the session will — the Google/Chirp API's own
  // pitch parameter is NOT used (Chirp 3 HD rejects it and would fall back to
  // a different voice). Resolves when playback finishes.
  const playPreviewBlob = useCallback(async (blob: Blob, pitchSemitones: number): Promise<void> => {
    if (!pitchSemitones) {
      const url = URL.createObjectURL(blob);
      await new Promise<void>((resolve) => {
        const audio = new Audio(url);
        previewAudioRef.current = audio;
        const done = () => {
          URL.revokeObjectURL(url);
          previewAudioRef.current = null;
          resolve();
        };
        audio.onended = done;
        audio.onerror = done;
        audio.play().catch(done);
      });
      return;
    }
    const ctx = new AudioContext();
    try {
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      const shifted = ctx.createBuffer(decoded.numberOfChannels, decoded.length, decoded.sampleRate);
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        shifted.copyToChannel(processVoice(decoded.getChannelData(ch), decoded.sampleRate, pitchSemitones), ch);
      }
      await new Promise<void>((resolve) => {
        const src = ctx.createBufferSource();
        src.buffer = shifted;
        src.connect(ctx.destination);
        src.onended = () => resolve();
        src.start();
      });
    } finally {
      void ctx.close();
    }
  }, []);

  // ElevenLabs preview — voiced with the clinician-UI test phrase, then
  // pitched like the session would pitch it (pitchByTag applies to ALL
  // utterance/avatar audio in the AAC, ElevenLabs included).
  const previewVoice = useCallback(async (voiceId: string, pitchSemitones = 0) => {
    if (!voiceId || previewingVoice) return;
    setPreviewingVoice(voiceId);
    try {
      const res = await apiRequest('POST', '/api/voices/preview', {
        voiceId,
        text: t('aacSettings.elevenlabsTestPhrase'),
        apiKey: elevenlabsApiKey.trim() || undefined,
      });
      await playPreviewBlob(await res.blob(), pitchSemitones);
    } catch {
      // fall through to the spinner reset
    } finally {
      setPreviewingVoice(null);
    }
  }, [previewingVoice, elevenlabsApiKey, t, playPreviewBlob]);

  // Preview a Google/Gemini voice. The test line is chosen SERVER-side from
  // the student's language (the voice will speak that language in sessions,
  // so that's the language to judge it in), and the synthesis is billed to
  // the selected student's budget. `slotKey` keeps the AI and student rows'
  // spinners distinct even when both use the same voice name.
  const previewGoogleVoice = useCallback(async (voiceName: string, slotKey: string, pitchSemitones = 0) => {
    if (!voiceName || previewingVoice || !student?.id) return;
    setPreviewingVoice(slotKey);
    try {
      const res = await apiRequest('POST', '/api/voices/preview-google', {
        voiceName,
        studentId: student.id,
        language: (student as any)?.primaryLanguage || undefined,
      });
      await playPreviewBlob(await res.blob(), pitchSemitones);
    } catch {
      // fall through to the spinner reset
    } finally {
      setPreviewingVoice(null);
    }
  }, [previewingVoice, student, playPreviewBlob]);

  // Effective Gemini voice per role — what the session will actually use when
  // nothing is explicitly picked (mirrors the server's resolveVoices defaults),
  // so the preview button can play the REAL default, not stay hidden.
  const studentGender = String(student?.gender || '').toLowerCase();
  const effectiveGeminiAiVoice = geminiAiVoice || 'Zephyr';
  const effectiveGeminiStudentVoice = geminiStudentVoice || (studentGender === 'female' ? 'Leda' : 'Puck');

  // One ElevenLabs voice picker row, reused by the AI and student sub-sections.
  // Rendered only while ElevenLabs is live (see `elevenlabsActive`) — with no
  // usable key there is nothing to pick from and nothing the ID would reach.
  const renderElevenlabsVoicePicker = (labelKey: string, value: string, setValue: (v: string) => void, pitchSemitones = 0) => {
    if (!elevenlabsActive) return null;
    return (
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label className="text-sm text-muted-foreground">{t(labelKey)}</Label>
        </div>
        {elevenlabsLoading ? (
          <p className="text-sm text-muted-foreground w-full md:w-[280px]">{t('aacSettings.elevenlabsLoadingVoices')}</p>
        ) : elevenlabsVoices && elevenlabsVoices.length > 0 ? (
          <div className="flex gap-2 items-center">
            {value && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => previewVoice(value, pitchSemitones)}
                disabled={!!previewingVoice}
                title={t('aacSettings.elevenlabsTestVoice')}
                className="shrink-0 h-8 w-8 p-0"
              >
                {previewingVoice === value ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
              </Button>
            )}
            <Select value={value || '_none'} onValueChange={(v) => setValue(v === '_none' ? '' : v)}>
              <SelectTrigger className="w-full md:w-[280px]">
                <SelectValue placeholder={t('aacSettings.elevenlabsSelectVoice')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">{t('aacSettings.elevenlabsSelectVoice')}</SelectItem>
                {elevenlabsVoices.map((v) => (
                  <SelectItem key={v.voice_id} value={v.voice_id}>
                    {v.name} {v.category ? `(${v.category})` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground w-full md:w-[280px]">{t('aacSettings.elevenlabsNoVoices')}</p>
        )}
      </div>
    );
  };

  // One Gemini/Google voice row: preview button (plays the EFFECTIVE voice —
  // the gender-based default when none is picked) + the picker itself.
  const renderGeminiVoiceRow = (
    labelKey: string,
    value: string,
    effectiveVoice: string,
    slotKey: string,
    onChange: (v: string) => void,
    pitchSemitones = 0,
  ) => (
    <div className="flex items-center justify-between">
      <Label className="text-sm text-muted-foreground">{t(labelKey)}</Label>
      <div className="flex gap-2 items-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => previewGoogleVoice(effectiveVoice, slotKey, pitchSemitones)}
          disabled={!!previewingVoice}
          title={t('aacSettings.elevenlabsTestVoice')}
          className="shrink-0 h-8 w-8 p-0"
        >
          {previewingVoice === slotKey ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Play className="w-4 h-4" />
          )}
        </Button>
        <Select value={value || '_default'} onValueChange={onChange}>
          <SelectTrigger className="w-full md:w-[200px]">
            <SelectValue placeholder="Default" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_default">Default</SelectItem>
            {GEMINI_VOICE_OPTIONS.map((v) => (
              <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );

  // Per-role pitch slider (semitones), shown only when that role's Gemini
  // voice is explicitly set — the "_default" pick resets pitch to 0.
  const renderPitchRow = (value: number, onChange: (v: number) => void) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between" title={t('aacSettings.voicePitchDesc')}>
        <Label className="text-sm text-muted-foreground">{t('aacSettings.voicePitch')}</Label>
        <span className="text-sm text-muted-foreground">{value > 0 ? `+${value}` : value}</span>
      </div>
      <Slider
        min={-6}
        max={6}
        step={1}
        value={[value]}
        onValueChange={(v: number[]) => onChange(v[0])}
        className="w-full"
      />
    </div>
  );

  // Listen for Spotify OAuth popup completion
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'spotify-connected') {
        refetchStudent();
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [refetchStudent]);

  // Load student data into form (AAC settings are nested under aacSettings)
  useEffect(() => {
    if (student) {
      const aac = (student as any).aacSettings;
      setAiName(aac?.aiName || '');
      setChatAgentPrompt(toRuleArray(aac?.chatAgentPrompt));
      setAutoAacPrompt(toRuleArray(aac?.autoAacPrompt));
      setLiveAudioSpeaker(aac?.liveAudioSpeaker ?? true);
      setFullAttentionMode(aac?.fullAttentionMode ?? false);
      setAllowFacilitatorControl(aac?.allowFacilitatorControl ?? false);
      setBoardManagerLiveModel(aac?.boardManagerLiveModel ?? false);
      setBudgetTier(aac?.budgetTier || '');
      setSeizureDetection(coerceSeizureConfig((aac as any)?.seizureDetection?.config));
      setElevenlabsEnabled(aac?.elevenlabsEnabled !== false);
      setElevenlabsApiKey(aac?.elevenlabsApiKey || '');
      setElevenlabsAiVoiceId(aac?.elevenlabsAiVoiceId || '');
      setElevenlabsStudentVoiceId(aac?.elevenlabsStudentVoiceId || '');
      setGeminiAiVoice(aac?.geminiAiVoice || '');
      setGeminiStudentVoice(aac?.geminiStudentVoice || '');
      setAiVoicePitch(aac?.aiVoicePitch ?? 0);
      setStudentVoicePitch(aac?.studentVoicePitch ?? 0);
      setUseLocalTts(aac?.useLocalTts ?? false);
      setIconTextRatio(aac?.iconTextRatio ?? 3);
      setLanguageLevel(aac?.languageLevel ?? DEFAULT_LANGUAGE_LEVEL_INT);
      setThoroughStartup((aac?.startupMode ?? 0) === 1);
      setSingleGlyphButtons(aac?.singleGlyphButtons ?? false);
      setGlyphInputTranslation(aac?.glyphInputTranslation ?? false);
      setPressResponseDelay(aac?.pressResponseDelay ?? 0);
      setInterruptOnNewPress(aac?.interruptOnNewPress ?? false);
      setEyegazeEnabled(aac?.eyegazeEnabled ?? false);
      setEyegazeTimeout(aac?.eyegazeTimeout ?? 2000);
      setEyegazeProvider(aac?.eyegazeProvider ?? 'mouse');
      setSelectionMethod(aac?.selectionMethod ?? 'whole_button');
      setRestSpace(aac?.restSpace ?? 'large');
      setAutoAudioScan(aac?.autoAudioScan ?? false);
      setAutoAudioScanDelay(aac?.autoAudioScanDelay ?? 15000);
      setGazeSmoothing(parseSmoothingSettings(aac?.eyegazeSmoothing));
      setAllowReadProgress(aac?.allowReadProgress ?? true);
      setAllowReadReports(aac?.allowReadReports ?? true);
      setAllowNotes(aac?.allowNotes ?? true);
      setShareMonitorNotesWithInstitute(aac?.shareMonitorNotesWithInstitute ?? true);
      setAutoAddContacts(aac?.autoAddContacts ?? true);
      setDeviceLocationEnabled(aac?.deviceLocationEnabled ?? false);
      setAppConfig(aac?.appConfig || {});
      setPermittedWebsites(Array.isArray(aac?.permittedWebsites) ? aac.permittedWebsites : []);
      setHomeActions(normalizeHomeActions(aac?.homeActions));
      setVenueMenus(normalizeVenueMenuSettings(aac?.venueMenus));
      setSessionRecording(normalizeSessionRecordingSettings(aac?.sessionRecording));
      setDefinedGestures(Array.isArray(aac?.definedGestures) ? aac.definedGestures : []);
      setPermittedYoutubeItems(resolvePermittedYoutubeItems(aac));
      const acc = aac?.accessibility || {};
      setAccessFontSize(acc.fontSize ?? 100);
      setAccessHighContrast(acc.highContrast ?? false);
      setAccessReduceAnimations(acc.reduceAnimations ?? false);
      setAccessEnhancedFocus(acc.enhancedFocusIndicator ?? false);
      setHasChanges(false);
    }
  }, [student]);

  // Track changes
  useEffect(() => {
    if (student) {
      const aac = (student as any).aacSettings;
      const originalAiName = aac?.aiName || '';
      const originalPrompt = toRuleArray(aac?.chatAgentPrompt);
      const originalAutoPrompt = toRuleArray(aac?.autoAacPrompt);
      const originalLiveAudioSpeaker = aac?.liveAudioSpeaker ?? true;
      const originalFullAttentionMode = aac?.fullAttentionMode ?? false;
      const originalAllowFacilitatorControl = aac?.allowFacilitatorControl ?? false;
      const originalBoardManagerLiveModel = aac?.boardManagerLiveModel ?? false;
      const originalBudgetTier = aac?.budgetTier || '';
      const originalSeizureDetection = JSON.stringify(coerceSeizureConfig((aac as any)?.seizureDetection?.config));
      const originalElevenlabsEnabled = aac?.elevenlabsEnabled !== false;
      const originalElevenlabsApiKey = aac?.elevenlabsApiKey || '';
      const originalElevenlabsAiVoiceId = aac?.elevenlabsAiVoiceId || '';
      const originalElevenlabsStudentVoiceId = aac?.elevenlabsStudentVoiceId || '';
      const originalGeminiAiVoice = aac?.geminiAiVoice || '';
      const originalGeminiStudentVoice = aac?.geminiStudentVoice || '';
      const originalAiVoicePitch = aac?.aiVoicePitch ?? 0;
      const originalStudentVoicePitch = aac?.studentVoicePitch ?? 0;
      const originalUseLocalTts = aac?.useLocalTts ?? false;
      const originalIconTextRatio = aac?.iconTextRatio ?? 3;
      const originalLanguageLevel = aac?.languageLevel ?? DEFAULT_LANGUAGE_LEVEL_INT;
      const originalThoroughStartup = (aac?.startupMode ?? 0) === 1;
      const originalSingleGlyphButtons = aac?.singleGlyphButtons ?? false;
      const originalGlyphInputTranslation = aac?.glyphInputTranslation ?? false;
      const originalPressResponseDelay = aac?.pressResponseDelay ?? 0;
      const originalInterruptOnNewPress = aac?.interruptOnNewPress ?? false;
      const originalEyegazeEnabled = aac?.eyegazeEnabled ?? false;
      const originalEyegazeTimeout = aac?.eyegazeTimeout ?? 2000;
      const originalEyegazeProvider = aac?.eyegazeProvider ?? 'mouse';
      const originalSelectionMethod = aac?.selectionMethod ?? 'whole_button';
      const originalRestSpace = aac?.restSpace ?? 'large';
      const originalAutoAudioScan = aac?.autoAudioScan ?? false;
      const originalAutoAudioScanDelay = aac?.autoAudioScanDelay ?? 15000;
      const originalGazeSmoothing = serializeSmoothingSettings(parseSmoothingSettings(aac?.eyegazeSmoothing));
      const originalAllowReadProgress = aac?.allowReadProgress ?? true;
      const originalAllowReadReports = aac?.allowReadReports ?? true;
      const originalAllowNotes = aac?.allowNotes ?? true;
      const originalShareMonitorNotesWithInstitute = aac?.shareMonitorNotesWithInstitute ?? true;
      const originalAutoAddContacts = aac?.autoAddContacts ?? true;
      const originalDeviceLocationEnabled = aac?.deviceLocationEnabled ?? false;
      const originalAppConfig = aac?.appConfig || {};
      const originalPermittedWebsites = Array.isArray(aac?.permittedWebsites) ? aac.permittedWebsites : [];
      // Normalized on BOTH sides of this comparison (state is seeded from the same
      // helper), so an untouched list compares equal instead of showing dirty.
      const originalHomeActions = normalizeHomeActions(aac?.homeActions);
      const originalVenueMenus = normalizeVenueMenuSettings(aac?.venueMenus);
      const originalSessionRecording = normalizeSessionRecordingSettings(aac?.sessionRecording);
      const originalDefinedGestures = Array.isArray(aac?.definedGestures) ? aac.definedGestures : [];
      const originalPermittedYoutubeItems = resolvePermittedYoutubeItems(aac);
      const origAcc = aac?.accessibility || {};
      const origAccessFontSize = origAcc.fontSize ?? 100;
      const origAccessHighContrast = origAcc.highContrast ?? false;
      const origAccessReduceAnimations = origAcc.reduceAnimations ?? false;
      const origAccessEnhancedFocus = origAcc.enhancedFocusIndicator ?? false;
      setHasChanges(
        aiName !== originalAiName ||
        JSON.stringify(chatAgentPrompt) !== JSON.stringify(originalPrompt) ||
        JSON.stringify(autoAacPrompt) !== JSON.stringify(originalAutoPrompt) ||
        liveAudioSpeaker !== originalLiveAudioSpeaker ||
        fullAttentionMode !== originalFullAttentionMode ||
        allowFacilitatorControl !== originalAllowFacilitatorControl ||
        boardManagerLiveModel !== originalBoardManagerLiveModel ||
        budgetTier !== originalBudgetTier ||
        JSON.stringify(seizureDetection) !== originalSeizureDetection ||
        elevenlabsEnabled !== originalElevenlabsEnabled ||
        elevenlabsApiKey !== originalElevenlabsApiKey ||
        elevenlabsAiVoiceId !== originalElevenlabsAiVoiceId ||
        elevenlabsStudentVoiceId !== originalElevenlabsStudentVoiceId ||
        geminiAiVoice !== originalGeminiAiVoice ||
        geminiStudentVoice !== originalGeminiStudentVoice ||
        aiVoicePitch !== originalAiVoicePitch ||
        studentVoicePitch !== originalStudentVoicePitch ||
        useLocalTts !== originalUseLocalTts ||
        iconTextRatio !== originalIconTextRatio ||
        languageLevel !== originalLanguageLevel ||
        thoroughStartup !== originalThoroughStartup ||
        singleGlyphButtons !== originalSingleGlyphButtons ||
        glyphInputTranslation !== originalGlyphInputTranslation ||
        pressResponseDelay !== originalPressResponseDelay ||
        interruptOnNewPress !== originalInterruptOnNewPress ||
        eyegazeEnabled !== originalEyegazeEnabled ||
        eyegazeTimeout !== originalEyegazeTimeout ||
        eyegazeProvider !== originalEyegazeProvider ||
        selectionMethod !== originalSelectionMethod ||
        restSpace !== originalRestSpace ||
        autoAudioScan !== originalAutoAudioScan ||
        autoAudioScanDelay !== originalAutoAudioScanDelay ||
        serializeSmoothingSettings(gazeSmoothing) !== originalGazeSmoothing ||
        allowReadProgress !== originalAllowReadProgress ||
        allowReadReports !== originalAllowReadReports ||
        allowNotes !== originalAllowNotes ||
        shareMonitorNotesWithInstitute !== originalShareMonitorNotesWithInstitute ||
        autoAddContacts !== originalAutoAddContacts ||
        deviceLocationEnabled !== originalDeviceLocationEnabled ||
        JSON.stringify(appConfig) !== JSON.stringify(originalAppConfig) ||
        JSON.stringify(permittedWebsites) !== JSON.stringify(originalPermittedWebsites) ||
        JSON.stringify(homeActions) !== JSON.stringify(originalHomeActions) ||
        JSON.stringify(venueMenus) !== JSON.stringify(originalVenueMenus) ||
        JSON.stringify(sessionRecording) !== JSON.stringify(originalSessionRecording) ||
        JSON.stringify(definedGestures) !== JSON.stringify(originalDefinedGestures) ||
        JSON.stringify(permittedYoutubeItems) !== JSON.stringify(originalPermittedYoutubeItems) ||
        accessFontSize !== origAccessFontSize ||
        accessHighContrast !== origAccessHighContrast ||
        accessReduceAnimations !== origAccessReduceAnimations ||
        accessEnhancedFocus !== origAccessEnhancedFocus
      );
    }
  }, [aiName, chatAgentPrompt, autoAacPrompt, liveAudioSpeaker, fullAttentionMode, allowFacilitatorControl, boardManagerLiveModel, budgetTier, seizureDetection, elevenlabsEnabled, elevenlabsApiKey, elevenlabsAiVoiceId, elevenlabsStudentVoiceId, geminiAiVoice, geminiStudentVoice, aiVoicePitch, studentVoicePitch, useLocalTts, iconTextRatio, languageLevel, thoroughStartup, singleGlyphButtons, glyphInputTranslation, pressResponseDelay, interruptOnNewPress, eyegazeEnabled, eyegazeTimeout, eyegazeProvider, selectionMethod, restSpace, autoAudioScan, autoAudioScanDelay, allowReadProgress, allowReadReports, allowNotes, shareMonitorNotesWithInstitute, autoAddContacts, deviceLocationEnabled, appConfig, permittedWebsites, homeActions, venueMenus, sessionRecording, definedGestures, permittedYoutubeItems, accessFontSize, accessHighContrast, accessReduceAnimations, accessEnhancedFocus, student]);

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: async (data: {
      // Required, not optional: these must always be present in the payload so
      // a cleared field reaches the server as '' instead of vanishing.
      aiName: string;
      chatAgentPrompt: string[];
      autoAacPrompt: string[];
      liveAudioSpeaker?: boolean;
      seizureDetection?: { config: SeizureConfig };
      elevenlabsEnabled?: boolean;
      elevenlabsApiKey: string;
      elevenlabsAiVoiceId: string;
      elevenlabsStudentVoiceId: string;
      geminiAiVoice: string;
      geminiStudentVoice: string;
      aiVoicePitch?: number;
      studentVoicePitch?: number;
      useLocalTts?: boolean;
      iconTextRatio: number;
      languageLevel: number;
      startupMode: number;
      singleGlyphButtons: boolean;
      glyphInputTranslation: boolean;
      pressResponseDelay: number;
      interruptOnNewPress: boolean;
      eyegazeEnabled: boolean;
      eyegazeTimeout: number;
      eyegazeProvider: string;
      eyegazeSmoothing: string;
      selectionMethod: string;
      restSpace: string;
      autoAudioScan: boolean;
      autoAudioScanDelay: number;
      allowReadProgress: boolean;
      allowReadReports: boolean;
      allowNotes: boolean;
      shareMonitorNotesWithInstitute: boolean;
      autoAddContacts: boolean;
      deviceLocationEnabled: boolean;
      appConfig?: Record<string, any>;
      permittedWebsites?: PermittedWebsite[];
      homeActions?: HomeAction[];
      venueMenus?: VenueMenuSettings;
      sessionRecording?: SessionRecordingSettings;
      definedGestures?: DefinedGesture[];
      permittedYoutubeItems?: PermittedYoutubeItem[];
      accessibility?: Record<string, any>;
    }) => {
      const response = await apiRequest('PATCH', `/api/students/${student?.id}`, data);
      return response.json();
    },
    onSuccess: async () => {
      await refetchStudent();
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: t('aacSettings.settingsUpdated'),
        description: t('aacSettings.settingsUpdatedDesc'),
      });
      setHasChanges(false);
    },
    onError: (error: Error) => {
      // A validation rejection arrives as "400: {json}" whose body carries the
      // "error:CODE" convention (e.g. a pasted ElevenLabs key ID) — translate
      // the code so the toast says what was actually wrong with the save.
      const code = error.message.match(/error:([A-Z_]+)/)?.[1];
      toast({
        title: t('common.error'),
        description: code ? t(`errors.${code}`) : (error.message || t('aacSettings.updateError')),
        variant: 'destructive',
      });
    },
  });

  // SLP MODE — its OWN mutation against the profile endpoint, deliberately
  // separate from updateMutation above. It is a property of the logged-in
  // clinician (it follows them from student to student), so it is NOT part of
  // the per-student save, has no dirty-check entry, and saves on toggle.
  const slpMode = user?.slpMode === true;
  const slpModeMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const response = await apiRequest('PATCH', '/api/profile/slp-mode', { slpMode: enabled });
      return response.json();
    },
    onSuccess: async (data: { slpMode?: boolean }) => {
      await refetchUser();
      queryClient.invalidateQueries({ queryKey: ['/auth/user'] });
      toast({
        title: t('aacSettings.slpModeSaved'),
        description: data?.slpMode ? t('aacSettings.slpModeOnDesc') : t('aacSettings.slpModeOffDesc'),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t('common.error'),
        description: error.message || t('aacSettings.slpModeError'),
        variant: 'destructive',
      });
    },
  });

  const handleSave = () => {
    if (!student) return;
    updateMutation.mutate({
      // Cleared text/voice fields go out as '' — NEVER `|| undefined`.
      // JSON.stringify drops undefined keys, PATCH /api/students/:id merges
      // only the keys it receives, and the panel then re-seeds its state from
      // the refetched student — so a dropped key reads to the clinician as
      // "I deleted the AI name and it came back". Empty string is the clear.
      aiName: aiName.trim(),
      chatAgentPrompt,
      autoAacPrompt,
      liveAudioSpeaker,
      seizureDetection: { config: seizureDetection },
      elevenlabsEnabled,
      elevenlabsApiKey: elevenlabsApiKey.trim(),
      elevenlabsAiVoiceId: elevenlabsAiVoiceId.trim(),
      elevenlabsStudentVoiceId: elevenlabsStudentVoiceId.trim(),
      // '' is reachable from the UI here too: the Gemini pickers' `_default`
      // row and the ElevenLabs pickers' `_none` row both set state to ''.
      geminiAiVoice,
      geminiStudentVoice,
      aiVoicePitch,
      studentVoicePitch,
      useLocalTts,
      iconTextRatio,
      languageLevel,
      startupMode: thoroughStartup ? 1 : 0,
      singleGlyphButtons,
      glyphInputTranslation,
      pressResponseDelay,
      interruptOnNewPress,
      eyegazeEnabled,
      eyegazeTimeout,
      eyegazeProvider,
      eyegazeSmoothing: serializeSmoothingSettings(gazeSmoothing),
      selectionMethod,
      restSpace,
      autoAudioScan,
      autoAudioScanDelay,
      allowReadProgress,
      allowReadReports,
      allowNotes,
      shareMonitorNotesWithInstitute,
      autoAddContacts,
      deviceLocationEnabled,
      appConfig,
      permittedWebsites,
      // Sanitized through the shared chokepoint so half-filled rows (a slot the
      // clinician added but never named) never reach the stored blob.
      homeActions: normalizeHomeActions(homeActions),
      // Normalized on the way out for the same reason as the others: a value
      // typed into a number field can never be stored outside its range.
      venueMenus: normalizeVenueMenuSettings(venueMenus),
      // Clamped through the shared chokepoint on the way out too, so a value
      // typed into a number field can never be stored outside its range.
      sessionRecording: normalizeSessionRecordingSettings(sessionRecording),
      definedGestures,
      permittedYoutubeItems,
      accessibility: {
        fontSize: accessFontSize,
        highContrast: accessHighContrast,
        reduceAnimations: accessReduceAnimations,
        enhancedFocusIndicator: accessEnhancedFocus,
      },
    });
  };

  const handleReset = () => {
    if (student) {
      const aac = (student as any).aacSettings;
      setAiName(aac?.aiName || '');
      setChatAgentPrompt(toRuleArray(aac?.chatAgentPrompt));
      setAutoAacPrompt(toRuleArray(aac?.autoAacPrompt));
      setLiveAudioSpeaker(aac?.liveAudioSpeaker ?? true);
      setFullAttentionMode(aac?.fullAttentionMode ?? false);
      setAllowFacilitatorControl(aac?.allowFacilitatorControl ?? false);
      setBoardManagerLiveModel(aac?.boardManagerLiveModel ?? false);
      setBudgetTier(aac?.budgetTier || '');
      setSeizureDetection(coerceSeizureConfig((aac as any)?.seizureDetection?.config));
      setElevenlabsEnabled(aac?.elevenlabsEnabled !== false);
      setElevenlabsApiKey(aac?.elevenlabsApiKey || '');
      setElevenlabsAiVoiceId(aac?.elevenlabsAiVoiceId || '');
      setElevenlabsStudentVoiceId(aac?.elevenlabsStudentVoiceId || '');
      setGeminiAiVoice(aac?.geminiAiVoice || '');
      setGeminiStudentVoice(aac?.geminiStudentVoice || '');
      setAiVoicePitch(aac?.aiVoicePitch ?? 0);
      setStudentVoicePitch(aac?.studentVoicePitch ?? 0);
      setUseLocalTts(aac?.useLocalTts ?? false);
      setIconTextRatio(aac?.iconTextRatio ?? 3);
      setLanguageLevel(aac?.languageLevel ?? DEFAULT_LANGUAGE_LEVEL_INT);
      setThoroughStartup((aac?.startupMode ?? 0) === 1);
      setSingleGlyphButtons(aac?.singleGlyphButtons ?? false);
      setGlyphInputTranslation(aac?.glyphInputTranslation ?? false);
      setPressResponseDelay(aac?.pressResponseDelay ?? 0);
      setInterruptOnNewPress(aac?.interruptOnNewPress ?? false);
      setEyegazeEnabled(aac?.eyegazeEnabled ?? false);
      setEyegazeTimeout(aac?.eyegazeTimeout ?? 2000);
      setEyegazeProvider(aac?.eyegazeProvider ?? 'mouse');
      setSelectionMethod(aac?.selectionMethod ?? 'whole_button');
      setRestSpace(aac?.restSpace ?? 'large');
      setAutoAudioScan(aac?.autoAudioScan ?? false);
      setAutoAudioScanDelay(aac?.autoAudioScanDelay ?? 15000);
      setGazeSmoothing(parseSmoothingSettings(aac?.eyegazeSmoothing));
      setAllowReadProgress(aac?.allowReadProgress ?? true);
      setAllowReadReports(aac?.allowReadReports ?? true);
      setAllowNotes(aac?.allowNotes ?? true);
      setShareMonitorNotesWithInstitute(aac?.shareMonitorNotesWithInstitute ?? true);
      setAutoAddContacts(aac?.autoAddContacts ?? true);
      setDeviceLocationEnabled(aac?.deviceLocationEnabled ?? false);
      setAppConfig(aac?.appConfig || {});
      setPermittedWebsites(Array.isArray(aac?.permittedWebsites) ? aac.permittedWebsites : []);
      setHomeActions(normalizeHomeActions(aac?.homeActions));
      setVenueMenus(normalizeVenueMenuSettings(aac?.venueMenus));
      setSessionRecording(normalizeSessionRecordingSettings(aac?.sessionRecording));
      setDefinedGestures(Array.isArray(aac?.definedGestures) ? aac.definedGestures : []);
      setPermittedYoutubeItems(resolvePermittedYoutubeItems(aac));
      const accR = aac?.accessibility || {};
      setAccessFontSize(accR.fontSize ?? 100);
      setAccessHighContrast(accR.highContrast ?? false);
      setAccessReduceAnimations(accR.reduceAnimations ?? false);
      setAccessEnhancedFocus(accR.enhancedFocusIndicator ?? false);
    }
  };

  const handleResetToDefault = () => {
    setChatAgentPrompt([...DEFAULT_AAC_RULES]);
  };

  // ── Custom prompt rule-list editing ──
  const updateChatRule = (index: number, value: string) => {
    setChatAgentPrompt((prev) => prev.map((r, i) => (i === index ? value : r)));
  };
  const removeChatRule = (index: number) => {
    setChatAgentPrompt((prev) => prev.filter((_, i) => i !== index));
  };
  const addChatRule = () => {
    setChatAgentPrompt((prev) => [...prev, '']);
  };
  // Auto-notes list — clinicians can only delete entries, not edit them.
  const removeAutoNote = (index: number) => {
    setAutoAacPrompt((prev) => prev.filter((_, i) => i !== index));
  };

  // Resolve any pasted YouTube link (channel / playlist / video) via the
  // unified resolver, then add it to the single permitted-content list. The
  // server detects the type from the URL and returns the canonical id +
  // title/description so the clinician doesn't have to know which is which.
  const handleAddYoutube = async () => {
    const raw = youtubeInput.trim();
    if (!raw) return;
    setResolvingYoutube(true);
    try {
      const res = await apiRequest('POST', '/api/aac/youtube/resolve', { input: raw });
      const data = await res.json();
      if (!data.id || !data.type) {
        toast({
          title: t('aacSettings.permittedYoutubeContentResolveFailedTitle'),
          description: t('aacSettings.permittedYoutubeContentResolveFailedDesc'),
          variant: 'destructive',
        });
        return;
      }
      if (permittedYoutubeItems.some(it => it.id === data.id && it.type === data.type)) {
        toast({
          title: t('aacSettings.permittedYoutubeContentDuplicate'),
          variant: 'destructive',
        });
        return;
      }
      // Use fetched title/description as the default label/description; the
      // clinician can still edit them. Fall back to the pasted input if the
      // scrape came up empty.
      const label = (data.title || raw).trim();
      const description = (data.description || '').trim();
      setPermittedYoutubeItems(prev => [
        ...prev,
        { type: data.type as PermittedYoutubeItemType, id: data.id, label, description },
      ]);
      setYoutubeInput('');
    } catch (err: any) {
      toast({
        title: t('aacSettings.permittedYoutubeContentResolveFailedTitle'),
        description: err?.message || '',
        variant: 'destructive',
      });
    } finally {
      setResolvingYoutube(false);
    }
  };

  if (!isOpen) return null;

  if (!student) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <User className="w-12 h-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-medium mb-2">{t('aacSettings.noStudent')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('aacSettings.noStudentDesc')}
        </p>
      </div>
    );
  }

  // Social Trainer per-app config (appConfig.social_trainer). Edited directly
  // through appConfig, which is already in the dirty-check + save payload.
  const social = (appConfig.social_trainer ?? {}) as {
    targetSkills?: string[]; lockedSkills?: string[]; maxChallengeIntensity?: number; liveAudio?: boolean;
  };
  const socialTargets = social.targetSkills ?? [];
  const socialLocked = social.lockedSkills ?? [];
  const socialCeiling = typeof social.maxChallengeIntensity === 'number' ? social.maxChallengeIntensity : DEFAULT_SOCIAL_CEILING;
  const setSocial = (patch: Record<string, unknown>) =>
    setAppConfig((prev) => ({ ...prev, social_trainer: { ...(prev.social_trainer ?? {}), ...patch } }));
  const toggleSkill = (list: string[], key: string) =>
    list.includes(key) ? list.filter((k) => k !== key) : [...list, key];

  return (
    <ScrollArea dir={isRTL ? 'rtl' : 'ltr'} className="h-full">
      <div className={cn(
        "p-4 md:p-6",
        isDark ? "bg-background" : "bg-gray-50/50"
      )}>
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Header */}
          <div>
            <h1 className="text-2xl font-bold text-foreground mb-1">
              {t('aacSettings.title')}
            </h1>
            <p className="text-muted-foreground">
              {t('aacSettings.subtitle').replace('{name}', student.name)}
            </p>
          </div>

          {/* Student Info Card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <User className="w-4 h-4" />
                {t('aacSettings.currentStudent')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <User className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1">
                  <p className="font-medium">{student.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {(() => {
                      const g = String(student.gender || '').toLowerCase();
                      if (g === 'male') return t('aacSettings.genderMale');
                      if (g === 'female') return t('aacSettings.genderFemale');
                      return t('aacSettings.genderNotSpecified');
                    })()}
                    {student.birthDate && ` • ${t('aacSettings.yearsOld').replace('{age}', String(new Date().getFullYear() - new Date(student.birthDate).getFullYear()))}`}
                  </p>
                </div>
              </div>
              {/* Remotely reload the student's AAC so changed settings take effect
                  without them having to restart the app. */}
              <div className="mt-3 flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={async () => {
                    try {
                      const res = await apiRequest('POST', `/api/students/${student.id}/reload-aac`);
                      const data = await res.json().catch(() => ({}));
                      toast({
                        title: t('aacSettings.reloadAac'),
                        description: data?.online ? t('aacSettings.reloadAacOnline') : t('aacSettings.reloadAacOffline'),
                      });
                    } catch {
                      toast({ title: t('aacSettings.reloadAacFailed'), variant: 'destructive' });
                    }
                  }}
                >
                  <RotateCcw className="w-4 h-4" />
                  {t('aacSettings.reloadAac')}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* SLP MODE — the ONE control on this panel scoped to YOUR ACCOUNT
              rather than this student. Its own card (not a CollapsibleSection)
              and its own immediate save, so it never reads as part of the
              student settings the Save button below writes. */}
          <Card className="border-primary/40">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="w-4 h-4" />
                {t('aacSettings.slpModeTitle')}
              </CardTitle>
              <CardDescription>{t('aacSettings.slpModeScope')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">
                    {t('aacSettings.slpModeLabel')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.slpModeDesc')}
                  </p>
                </div>
                <Switch
                  checked={slpMode}
                  disabled={slpModeMutation.isPending}
                  onCheckedChange={(checked) => slpModeMutation.mutate(checked)}
                />
              </div>
            </CardContent>
          </Card>

          {/* AI Assistant — name, language level, and chat behavior */}
          <CollapsibleSection
            icon={<MessageSquare className="w-5 h-5" />}
            title={t('aacSettings.aiAssistant')}
            description={t('aacSettings.chatBehaviorDesc')}
            defaultOpen
          >
            <CardContent className="space-y-6">
              {/* AI Name.
                  Named, labelled and autofill-proofed on purpose: this used to
                  be an anonymous text input (no id/name/autoComplete, label not
                  associated) sitting ahead of the ElevenLabs password field, so
                  a browser could classify it as the username box and fill a
                  caretaker's saved email into it. That name goes straight into
                  the live system prompts ("You are <email>"), so a stray
                  autofill leaks a real address into every LLM call. */}
              <div className="space-y-2">
                <Label htmlFor="aac-ai-name" className="text-base font-medium">{t('aacSettings.aiName')}</Label>
                <p className="text-xs text-muted-foreground">{t('aacSettings.aiNameDesc')}</p>
                <Input
                  id="aac-ai-name"
                  name="aac-ai-name"
                  autoComplete="off"
                  data-lpignore="true"
                  data-1p-ignore
                  data-testid="input-ai-name"
                  value={aiName}
                  onChange={(e) => setAiName(e.target.value)}
                  placeholder={t('aacSettings.aiNamePlaceholder')}
                  className="max-w-sm"
                />
              </div>

              {/* Language Level */}
              <div className="space-y-2 border-t pt-4">
                <Label className="text-base font-medium">{t('aacSettings.languageLevel')}</Label>
                <p className="text-xs text-muted-foreground">{t('aacSettings.languageLevelDesc')}</p>
                <Select
                  value={String(languageLevel)}
                  onValueChange={(v) => setLanguageLevel(Number(v))}
                >
                  <SelectTrigger data-testid="select-language-level">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGE_LEVELS.map((key, i) => (
                      <SelectItem key={key} value={String(i + 1)}>
                        {t(`aacSettings.languageLevel_${key}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-2">
                  {t(`aacSettings.languageLevel_${LANGUAGE_LEVELS[languageLevel - 1] ?? 'full_sentences'}_desc`)}
                </p>
              </div>

              {/* Response timing — how long the AI waits before answering a
                  press (so the student can chain buttons into one thought),
                  and whether a new press abandons an answer already underway. */}
              <div className="space-y-4 border-t pt-4">
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <Label className="text-base font-medium">{t('aacSettings.pressResponseDelay')}</Label>
                    <span className="text-sm text-muted-foreground">
                      {pressResponseDelay === 0
                        ? t('aacSettings.pressResponseDelayOff')
                        : `${(pressResponseDelay / 1000).toFixed(1)}s`}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('aacSettings.pressResponseDelayDesc')}</p>
                  <Slider
                    min={0}
                    max={8000}
                    step={500}
                    value={[pressResponseDelay]}
                    onValueChange={(v) => setPressResponseDelay(v[0])}
                    data-testid="slider-press-response-delay"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{t('aacSettings.pressResponseDelayOff')}</span>
                    <span>2s</span>
                    <span>4s</span>
                    <span>8s</span>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex-1 pe-4">
                    <Label htmlFor="interrupt-on-new-press" className="text-sm font-medium">
                      {t('aacSettings.interruptOnNewPress')}
                    </Label>
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('aacSettings.interruptOnNewPressDesc')}
                    </p>
                  </div>
                  <Switch
                    id="interrupt-on-new-press"
                    checked={interruptOnNewPress}
                    onCheckedChange={setInterruptOnNewPress}
                    data-testid="switch-interrupt-on-new-press"
                  />
                </div>
              </div>

              {/* Chat behavior — custom prompt rules + AI-owned auto notes */}
              <div className="space-y-4 border-t pt-4">
                {/* Custom prompt — a LIST of caretaker-requested rules, one row
                    each. Clinicians add/edit/remove individual rules rather than
                    rewriting one block of text, so the AI never clobbers the set. */}
                <div className="space-y-2">
                  <Label className="text-base font-medium">
                    {t('aacSettings.systemPrompt')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('aacSettings.systemPromptHint')}
                  </p>
                  {chatAgentPrompt.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic py-2">
                      {t('aacSettings.promptRulesEmpty')}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {chatAgentPrompt.map((rule, i) => (
                        <div key={i} className="flex items-start gap-2">
                          <Textarea
                            value={rule}
                            onChange={(e) => updateChatRule(i, e.target.value)}
                            placeholder={t('aacSettings.promptRulePlaceholder')}
                            rows={1}
                            className="min-h-[44px] text-sm flex-1"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => removeChatRule(i)}
                            aria-label={t('aacSettings.removeRule')}
                            className="shrink-0 mt-1 text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={addChatRule}
                      className="text-xs"
                    >
                      <Plus className="w-3 h-3 me-1" />
                      {t('aacSettings.addRule')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleResetToDefault}
                      className="text-xs"
                    >
                      <RotateCcw className="w-3 h-3 me-1" />
                      {t('aacSettings.resetToDefault')}
                    </Button>
                  </div>
                </div>

                {/* Auto-generated notes — AI-owned list, shown read-only. The
                    assistant maintains these as it learns about the student;
                    clinicians can delete individual notes. */}
                <div className="space-y-2 border-t pt-4">
                  <Label className="text-base font-medium flex items-center gap-2">
                    <Sparkles className="w-4 h-4" />
                    {t('aacSettings.autoPromptLabel')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('aacSettings.autoPromptHint')}
                  </p>
                  {autoAacPrompt.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic py-2">
                      {t('aacSettings.autoPromptEmpty')}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {autoAacPrompt.map((note, i) => (
                        <div
                          key={i}
                          className="flex items-start gap-2 rounded-md border bg-muted/50 p-2"
                        >
                          <p className="text-sm flex-1 whitespace-pre-wrap break-words">
                            {note}
                          </p>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => removeAutoNote(i)}
                            aria-label={t('aacSettings.removeNote')}
                            className="shrink-0 text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  {autoAacPrompt.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAutoAacPrompt([])}
                      className="text-xs"
                    >
                      <Trash2 className="w-3 h-3 me-1" />
                      {t('aacSettings.clearAutoPrompt')}
                    </Button>
                  )}
                </div>
              </div>

              {/* Startup mode — quick (cached session plan) vs thorough (fresh every session) */}
              <div className="flex items-center justify-between border-t pt-4">
                <div className="flex-1 pr-4">
                  <Label htmlFor="thorough-startup" className="text-sm font-medium">
                    {t('aacSettings.thoroughStartup')}
                  </Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('aacSettings.thoroughStartupDesc')}
                  </p>
                </div>
                <Switch
                  id="thorough-startup"
                  checked={thoroughStartup}
                  onCheckedChange={setThoroughStartup}
                  data-testid="switch-thorough-startup"
                />
              </div>
            </CardContent>
          </CollapsibleSection>

          {/* Token Budget — READ-ONLY for clinicians. The spend tier and the
              cost controls (attention/facilitator/live model) are managed by the
              system administrator via the Licenses panel; here we only surface
              the active tier and the live usage meters. */}
          <CollapsibleSection
            icon={<Gauge className="w-5 h-5" />}
            title={t('aacSettings.tokenBudget')}
            description={t('aacSettings.tokenBudgetDesc')}
          >
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">{t('aacSettings.budgetTier')}</Label>
                  <p className="text-sm text-muted-foreground">{t('aacSettings.budgetManagedByAdmin')}</p>
                </div>
                <span className="text-sm font-medium" data-testid="text-budget-tier">
                  {tierByKey(budgetTier).key.charAt(0).toUpperCase() + tierByKey(budgetTier).key.slice(1)} — ${tierByKey(budgetTier).priceMonthly}/mo
                </span>
              </div>

              {/* Live usage meters — how much of each rolling window remains and
                  roughly when it refills, at the active tier's caps. */}
              <div className="space-y-3 pt-4 border-t">
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium">{t('aacSettings.budgetMetersTitle')}</Label>
                  <p className="text-sm text-muted-foreground">{t('aacSettings.budgetMetersDesc')}</p>
                </div>
                <BudgetMeters meters={(student as any)?.budgetMeters} tierKey={budgetTier || null} />
              </div>
            </CardContent>
          </CollapsibleSection>

          {/* Voice Settings */}
          <CollapsibleSection
            icon={<Volume2 className="w-5 h-5" />}
            title={t('aacSettings.voiceSettings')}
            description={t('aacSettings.voiceSettingsDesc')}
          >
            <CardContent className="space-y-6">
              {/* Shared ElevenLabs connection — ONE key feeds both voice
                  sub-sections below; the per-role voice pickers live inside
                  their sections. The shared/admin key never appears here. */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label className="text-base font-medium">
                      {t('aacSettings.elevenlabsTitle')}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {t('aacSettings.elevenlabsDesc')}
                    </p>
                  </div>
                  {(elevenlabsApiKey.trim() || elevenlabsStudentVoiceId.trim()) && (
                    <Switch checked={elevenlabsEnabled} onCheckedChange={setElevenlabsEnabled} />
                  )}
                </div>

                <div className={elevenlabsEnabled ? 'space-y-4' : 'space-y-4 opacity-50 pointer-events-none'}>
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label className="text-sm text-muted-foreground">
                        {t('aacSettings.elevenlabsApiKey')}
                      </Label>
                    </div>
                    {/* An API key, not a credential — `new-password` stops the
                        browser offering to save/fill it (and stops it hunting
                        the page for a username field to pair it with). */}
                    <Input
                      type="password"
                      id="aac-elevenlabs-api-key"
                      name="aac-elevenlabs-api-key"
                      autoComplete="new-password"
                      data-lpignore="true"
                      data-1p-ignore
                      value={elevenlabsApiKey}
                      onChange={(e) => setElevenlabsApiKey(e.target.value)}
                      placeholder={t('aacSettings.elevenlabsApiKeyPlaceholder')}
                      className="w-full md:w-[280px]"
                    />
                  </div>

                  {elevenlabsError && debouncedApiKey && (
                    <p className="text-sm text-destructive">{t(elevenlabsErrorKey)}</p>
                  )}
                </div>
              </div>

              {/* AI voice settings — everything that shapes how the ASSISTANT
                  sounds: live native audio, the Gemini/Google voice + pitch,
                  and the ElevenLabs AI voice (hidden when live audio speaks
                  natively). */}
              <div className="pt-4 border-t space-y-4">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">{t('aacSettings.aiVoiceSettings')}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.aiVoiceSettingsDesc')}
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label className="text-sm font-medium">{t('aacSettings.liveAudioSpeakerTitle')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('aacSettings.liveAudioSpeakerDesc')}
                    </p>
                  </div>
                  <Switch checked={liveAudioSpeaker} onCheckedChange={setLiveAudioSpeaker} />
                </div>

                {/* ElevenLabs leads when it's live — it IS the AI's voice then,
                    and the Google picker below only speaks if it fails. Live
                    native audio bypasses TTS entirely: no ElevenLabs voice
                    applies, and Google is the real voice, not a fallback. */}
                {!liveAudioSpeaker && renderElevenlabsVoicePicker('aacSettings.elevenlabsAiVoiceId', elevenlabsAiVoiceId, setElevenlabsAiVoiceId, aiVoicePitch)}

                {renderGeminiVoiceRow(
                  elevenlabsActive && !liveAudioSpeaker ? 'aacSettings.aiVoiceFallback' : 'aacSettings.aiVoice',
                  geminiAiVoice,
                  effectiveGeminiAiVoice,
                  'g:ai',
                  (v) => { setGeminiAiVoice(v === '_default' ? '' : v); if (v === '_default') setAiVoicePitch(0); },
                  aiVoicePitch,
                )}

                {geminiAiVoice && renderPitchRow(aiVoicePitch, setAiVoicePitch)}
              </div>

              {/* Student voice settings — how the student's OWN words sound
                  when a press / composed sentence is voiced. */}
              <div className="pt-4 border-t space-y-4">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">{t('aacSettings.studentVoiceSettings')}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.studentVoiceSettingsDesc')}
                  </p>
                </div>

                {/* Same order as the AI section. Live native audio never speaks
                    the student's own words, so it doesn't apply here. */}
                {renderElevenlabsVoicePicker('aacSettings.elevenlabsStudentVoiceId', elevenlabsStudentVoiceId, setElevenlabsStudentVoiceId, studentVoicePitch)}

                {renderGeminiVoiceRow(
                  elevenlabsActive ? 'aacSettings.studentVoiceFallback' : 'aacSettings.studentVoice',
                  geminiStudentVoice,
                  effectiveGeminiStudentVoice,
                  'g:student',
                  (v) => { setGeminiStudentVoice(v === '_default' ? '' : v); if (v === '_default') setStudentVoicePitch(0); },
                  studentVoicePitch,
                )}

                {geminiStudentVoice && renderPitchRow(studentVoicePitch, setStudentVoicePitch)}
              </div>

              {/* Local Browser TTS — applies to both voices */}
              <div className="pt-4 border-t space-y-2">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label className="text-base font-medium">{t('aacSettings.localTtsTitle')}</Label>
                    <p className="text-sm text-muted-foreground">{t('aacSettings.localTtsDesc')}</p>
                  </div>
                  <Switch checked={useLocalTts} onCheckedChange={setUseLocalTts} />
                </div>
              </div>
            </CardContent>
          </CollapsibleSection>

          {/* Seizure Detection — TECHNICAL config for the on-device motion
              detectors (when they flag a possible seizure to the AI). Tune per
              student so their usual movements don't trip false warnings. Clinical
              guidance (what their seizures look like, what to do) belongs in the
              AAC prompt, not here. Opt-in / off by default.

              LOCKED while the detectors are still being tuned: the section stays
              visible (clinicians ask for it, and the controls are the spec for
              what it will do) but every control is disabled so nobody can switch
              on a feature that isn't ready to be trusted clinically. To ship it,
              drop the `disabled` props and restore the real description key. */}
          <CollapsibleSection
            icon={<Activity className="w-5 h-5" />}
            title={t('aacSettings.seizureDetection')}
            description={t('common.inDevelopment')}
          >
            <CardContent className="space-y-6 opacity-60">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">{t('aacSettings.seizureDetectionEnable')}</Label>
                  <p className="text-sm text-muted-foreground">{t('aacSettings.seizureDetectionEnableDesc')}</p>
                </div>
                <Switch
                  checked={false}
                  disabled
                  data-testid="switch-seizure-detection"
                />
              </div>

              {SEIZURE_DETECTION_AVAILABLE && seizureDetection.enabled && (
                <>
                  {/* Rhythmic / convulsive (tonic-clonic) detector sensitivity. */}
                  <div className="space-y-1 pt-4 border-t">
                    <Label className="text-base font-medium">{t('aacSettings.seizureRhythmic')}</Label>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.seizureRhythmicDesc')}</p>
                    <Select
                      value={seizureDetection.rhythmic}
                      onValueChange={(v) => setSeizureDetection(s => ({ ...s, rhythmic: v as SeizureSensitivity }))}
                    >
                      <SelectTrigger disabled data-testid="select-seizure-rhythmic"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(['off', 'low', 'medium', 'high'] as const).map(k => (
                          <SelectItem key={k} value={k}>{t(`aacSettings.seizureSensitivity_${k}`)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Atonic / drop-attack detector sensitivity. */}
                  <div className="space-y-1 pt-4 border-t">
                    <Label className="text-base font-medium">{t('aacSettings.seizureAtonic')}</Label>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.seizureAtonicDesc')}</p>
                    <Select
                      value={seizureDetection.atonic}
                      onValueChange={(v) => setSeizureDetection(s => ({ ...s, atonic: v as SeizureSensitivity }))}
                    >
                      <SelectTrigger disabled data-testid="select-seizure-atonic"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(['off', 'low', 'medium', 'high'] as const).map(k => (
                          <SelectItem key={k} value={k}>{t(`aacSettings.seizureSensitivity_${k}`)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Audio corroboration — only ever raises confidence of a motion event. */}
                  <div className="flex items-center justify-between pt-4 border-t">
                    <div className="space-y-0.5">
                      <Label className="text-base font-medium">{t('aacSettings.seizureAudioCorroboration')}</Label>
                      <p className="text-sm text-muted-foreground">{t('aacSettings.seizureAudioCorroborationDesc')}</p>
                    </div>
                    <Switch
                      checked={seizureDetection.audioCorroboration}
                      onCheckedChange={(v) => setSeizureDetection(s => ({ ...s, audioCorroboration: v }))}
                      data-testid="switch-seizure-audio"
                    />
                  </div>

                  {/* Per-student motor markers. These are NOT another
                      sensitivity dial: the generic convulsive detector requires
                      both sides of the body to move together, so a student whose
                      seizure is one-sided or is a held posture can never trip it
                      at ANY sensitivity. A marker gives that student their own
                      path. See shared/aac/seizure-markers.ts. */}
                  <div className="pt-4 border-t space-y-3">
                    <div className="space-y-0.5">
                      <Label className="text-base font-medium">{t('aacSettings.seizureMarkers')}</Label>
                      <p className="text-sm text-muted-foreground">{t('aacSettings.seizureMarkersDesc')}</p>
                    </div>

                    {seizureDetection.markers.length === 0 && (
                      <p className="text-sm text-muted-foreground">{t('aacSettings.seizureMarkersEmpty')}</p>
                    )}

                    {seizureDetection.markers.map((marker, idx) => {
                      const update = (patch: Partial<SeizureMarker>) =>
                        setSeizureDetection(s => ({
                          ...s,
                          markers: s.markers.map((m, i) => (i === idx ? { ...m, ...patch } : m)),
                        }));
                      return (
                        <div
                          key={marker.id}
                          className={cn(
                            'rounded-lg border p-3 space-y-2',
                            isDark ? 'bg-gray-800/50 border-gray-700' : 'bg-gray-50 border-gray-200',
                          )}
                        >
                          <div className="space-y-1">
                            <Label className="text-xs">{t('aacSettings.seizureMarkerLabel')}</Label>
                            <Input
                              value={marker.label}
                              onChange={(e) => update({ label: e.target.value })}
                              placeholder={t('aacSettings.seizureMarkerLabelPlaceholder')}
                              data-testid={`input-seizure-marker-label-${idx}`}
                            />
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                            <div className="space-y-1">
                              <Label className="text-xs">{t('aacSettings.seizureMarkerSign')}</Label>
                              <Select
                                value={marker.cue.kind}
                                onValueChange={(v) => {
                                  const kind = v as MarkerKind;
                                  update({
                                    cue: (kindTakesSide(kind)
                                      ? { kind, side: (marker.cue as { side?: MarkerSide }).side ?? 'either' }
                                      : { kind }) as SeizureMarker['cue'],
                                  });
                                }}
                              >
                                <SelectTrigger data-testid={`select-seizure-marker-kind-${idx}`}><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  {MARKER_KINDS.map(k => (
                                    <SelectItem key={k} value={k}>{t(`aacSettings.seizureMarkerKind_${k}`)}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            {/* Side is the student's OWN left/right, never the
                                left of the video image. */}
                            {kindTakesSide(marker.cue.kind) && (
                              <div className="space-y-1">
                                <Label className="text-xs">{t('aacSettings.seizureMarkerSide')}</Label>
                                <Select
                                  value={(marker.cue as { side?: MarkerSide }).side ?? 'either'}
                                  onValueChange={(v) => update({ cue: { ...marker.cue, side: v as MarkerSide } as SeizureMarker['cue'] })}
                                >
                                  <SelectTrigger data-testid={`select-seizure-marker-side-${idx}`}><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    {(['left', 'right', 'either'] as MarkerSide[]).map(sd => (
                                      <SelectItem key={sd} value={sd}>{t(`aacSettings.seizureMarkerSide_${sd}`)}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            )}
                            <div className="space-y-1">
                              <Label className="text-xs">{t('aacSettings.seizureMarkerWeight')}</Label>
                              <Select
                                value={marker.weight}
                                onValueChange={(v) => update({ weight: v as SeizureMarker['weight'] })}
                              >
                                <SelectTrigger data-testid={`select-seizure-marker-weight-${idx}`}><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="supportive">{t('aacSettings.seizureMarkerWeight_supportive')}</SelectItem>
                                  <SelectItem value="strong">{t('aacSettings.seizureMarkerWeight_strong')}</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSeizureDetection(s => ({ ...s, markers: s.markers.filter((_, i) => i !== idx) }))}
                          >
                            <Trash2 className="w-3 h-3 me-1" />
                            {t('aacSettings.seizureMarkerRemove')}
                          </Button>
                        </div>
                      );
                    })}

                    <Button
                      variant="outline"
                      onClick={() => setSeizureDetection(s => ({
                        ...s,
                        markers: [...s.markers, {
                          id: `mk_${Date.now().toString(36)}_${s.markers.length}`,
                          label: '',
                          cue: { kind: 'limb_elevation', side: 'either' },
                          weight: 'supportive',
                        }],
                      }))}
                      data-testid="button-add-seizure-marker"
                    >
                      <Plus className="w-4 h-4 me-2" />
                      {t('aacSettings.seizureMarkerAdd')}
                    </Button>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.seizureMarkersHint')}</p>
                  </div>
                </>
              )}
            </CardContent>
          </CollapsibleSection>

          {/* Social Trainer */}
          <CollapsibleSection
            icon={<MessageSquare className="w-5 h-5" />}
            title={t('aacSettings.socialTrainerTitle')}
            description={t('aacSettings.socialTrainerDesc')}
          >
            <CardContent className="space-y-6">
              {/* Enable toggle — surfaces as the "Practice friend" button on the
                  home board (enabled by default). */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">🧑‍🤝‍🧑</span>
                  <div>
                    <Label className="text-sm font-medium">{t('aacSettings.appSocialTrainer')}</Label>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.appSocialTrainerDesc')}</p>
                  </div>
                </div>
                <Switch
                  checked={appConfig.social_trainer?.enabled ?? true}
                  onCheckedChange={(checked) => setSocial({ enabled: checked })}
                />
              </div>

              {/* Live audio — when on (and a live model is configured), the
                  practice friend speaks via Gemini Live native audio: lower
                  latency (no TTS warm-up), more natural voice, higher cost.
                  The skills engine runs unchanged. */}
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium">{t('aacSettings.socialTrainerLiveAudioTitle')}</Label>
                  <p className="text-xs text-muted-foreground">{t('aacSettings.socialTrainerLiveAudioDesc')}</p>
                </div>
                <Switch
                  checked={social.liveAudio ?? false}
                  onCheckedChange={(checked) => setSocial({ liveAudio: checked })}
                  data-testid="social-live-audio"
                />
              </div>

              {/* Focus skills (default goals) */}
              <div>
                <Label className="text-sm font-medium">{t('aacSettings.socialTrainerFocus')}</Label>
                <p className="text-xs text-muted-foreground mb-2">{t('aacSettings.socialTrainerFocusHint')}</p>
                <div className="flex flex-wrap gap-2">
                  {SOCIAL_SKILLS.map((key) => {
                    const active = socialTargets.includes(key);
                    const locked = socialLocked.includes(key);
                    return (
                      <button
                        key={key}
                        type="button"
                        disabled={locked}
                        onClick={() => setSocial({ targetSkills: toggleSkill(socialTargets, key) })}
                        className={cn(
                          "px-2.5 py-1 rounded-full text-xs border transition-colors",
                          locked
                            ? "opacity-40 cursor-not-allowed border-border"
                            : active
                              ? "border-primary bg-primary/10 text-foreground"
                              : "border-border hover:border-primary/50 text-muted-foreground"
                        )}
                        data-testid={`social-focus-${key}`}
                      >
                        {t(`aacSettings.socialSkill_${key}`)}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* Off-limits skills (locked) */}
              <div className="pt-4 border-t">
                <Label className="text-sm font-medium">{t('aacSettings.socialTrainerLocked')}</Label>
                <p className="text-xs text-muted-foreground mb-2">{t('aacSettings.socialTrainerLockedHint')}</p>
                <div className="flex flex-wrap gap-2">
                  {SOCIAL_SKILLS.map((key) => {
                    const active = socialLocked.includes(key);
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          const nextLocked = toggleSkill(socialLocked, key);
                          // A newly-locked skill can't also be a focus goal.
                          setSocial({
                            lockedSkills: nextLocked,
                            targetSkills: nextLocked.includes(key)
                              ? socialTargets.filter((k) => k !== key)
                              : socialTargets,
                          });
                        }}
                        className={cn(
                          "px-2.5 py-1 rounded-full text-xs border transition-colors",
                          active
                            ? "border-destructive bg-destructive/10 text-foreground"
                            : "border-border hover:border-destructive/50 text-muted-foreground"
                        )}
                        data-testid={`social-locked-${key}`}
                      >
                        {t(`aacSettings.socialSkill_${key}`)}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* Challenge ceiling */}
              <div className="pt-4 border-t">
                <Label className="text-sm font-medium">{t('aacSettings.socialTrainerCeiling')}</Label>
                <p className="text-xs text-muted-foreground mb-2">{t('aacSettings.socialTrainerCeilingHint')}</p>
                <div className="flex items-center gap-3">
                  <Slider
                    min={0}
                    max={1}
                    step={0.05}
                    value={[socialCeiling]}
                    onValueChange={([v]) => setSocial({ maxChallengeIntensity: v })}
                    className="flex-1"
                    data-testid="social-challenge-ceiling"
                  />
                  <span className="text-xs tabular-nums w-10 text-right">{Math.round(socialCeiling * 100)}%</span>
                </div>
              </div>
            </CardContent>
          </CollapsibleSection>

          {/* Accessibility — visibility & eyegaze subsections */}
          <CollapsibleSection
            icon={<Accessibility className="w-5 h-5" />}
            title={t('settings.accessibility')}
            description={t('settings.accessibilityDesc')}
          >
            <CardContent className="space-y-4">
              {/* Visibility — display preferences + button sizing */}
              <CollapsibleSubSection
                icon={<LayoutGrid className="w-5 h-5" />}
                title={t('aacSettings.accessibilityVisibility')}
              >
                <CardContent className="space-y-4">
                  {/* Font Size */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-base font-medium">{t('settings.fontSize')}</Label>
                      <span className="text-sm text-muted-foreground">{accessFontSize}%</span>
                    </div>
                    <Slider
                      min={75}
                      max={200}
                      step={25}
                      value={[accessFontSize]}
                      onValueChange={(v) => setAccessFontSize(v[0])}
                      className="w-full"
                    />
                    <p className="text-sm text-muted-foreground">{t('settings.fontSizeDesc')}</p>
                  </div>

                  {/* High Contrast */}
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div className="space-y-0.5">
                      <Label className="text-base font-medium">{t('settings.contrastMode')}</Label>
                      <p className="text-sm text-muted-foreground">{t('settings.contrastModeDesc')}</p>
                    </div>
                    <Switch checked={accessHighContrast} onCheckedChange={setAccessHighContrast} />
                  </div>

                  {/* Reduce Animations */}
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div className="space-y-0.5">
                      <Label className="text-base font-medium">{t('settings.reduceAnimations')}</Label>
                      <p className="text-sm text-muted-foreground">{t('settings.reduceAnimationsDesc')}</p>
                    </div>
                    <Switch checked={accessReduceAnimations} onCheckedChange={setAccessReduceAnimations} />
                  </div>

                  {/* Enhanced Focus Indicator */}
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div className="space-y-0.5">
                      <Label className="text-base font-medium">{t('settings.enhancedFocus')}</Label>
                      <p className="text-sm text-muted-foreground">{t('settings.enhancedFocusDesc')}</p>
                    </div>
                    <Switch checked={accessEnhancedFocus} onCheckedChange={setAccessEnhancedFocus} />
                  </div>

                  {/* Button size (icon-to-text ratio) */}
                  <div className="border-t pt-4 space-y-3">
                    <div className="space-y-0.5">
                      <Label className="text-base font-medium">{t('aacSettings.buttonSize')}</Label>
                      <p className="text-sm text-muted-foreground">{t('aacSettings.buttonSizeDesc')}</p>
                    </div>
                    {/* Preview. Uses the SAME level table, the same flex split
                        and the same container-relative label sizing as the
                        student's board, so it is accurate by construction
                        rather than by two tables being kept in step by hand.
                        (It previously had its own copy of the numbers and drew
                        a layout the board renderer no longer used.) */}
                    <div className="flex gap-2 md:gap-3 justify-center">
                      {([1, 2, 3, 4, 5] as const).map((lvl) => {
                        const isActive = iconTextRatio === lvl;
                        const level = ratioLevel(lvl);
                        const previewLabel = t('aacSettings.buttonSizePreviewLabel');
                        const lines = labelLines(previewLabel, level);
                        return (
                          <button
                            key={lvl}
                            type="button"
                            onClick={() => setIconTextRatio(lvl)}
                            className={cn(
                              "flex flex-col items-center justify-center flex-1 min-w-0 max-w-16 h-20 rounded-lg border-2 transition-all p-1",
                              isActive
                                ? "border-primary bg-primary/10 ring-2 ring-primary/30"
                                : "border-border hover:border-primary/50 bg-card"
                            )}
                          >
                            <div className="icon-fill-area" style={{ flex: `${level.iconFlex} 1 0` }}>
                              <span className="icon-fill-emoji">😊</span>
                            </div>
                            <div className="label-fill-area" style={{ flex: `${level.textFlex} 1 0` }}>
                              <span
                                className="font-medium text-center leading-tight text-foreground"
                                style={{
                                  fontSize: labelFontSize(previewLabel, level),
                                  display: '-webkit-box',
                                  WebkitBoxOrient: 'vertical',
                                  WebkitLineClamp: lines,
                                  overflow: 'hidden',
                                  overflowWrap: 'break-word',
                                }}
                              >
                                {previewLabel}
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground text-center mt-3">
                      {iconTextRatio === 1 && t('aacSettings.buttonSizeXlIcon')}
                      {iconTextRatio === 2 && t('aacSettings.buttonSizeLgIcon')}
                      {iconTextRatio === 3 && t('aacSettings.buttonSizeBalanced')}
                      {iconTextRatio === 4 && t('aacSettings.buttonSizeSmIcon')}
                      {iconTextRatio === 5 && t('aacSettings.buttonSizeMinIcon')}
                    </p>
                  </div>
                  <div className="flex items-center justify-between mt-6 pt-4 border-t">
                    <div className="flex-1 pr-4">
                      <Label htmlFor="single-glyph-buttons" className="text-sm font-medium">
                        {t('aacSettings.singleGlyphButtons')}
                      </Label>
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('aacSettings.singleGlyphButtonsDesc')}
                      </p>
                    </div>
                    <Switch
                      id="single-glyph-buttons"
                      checked={singleGlyphButtons}
                      onCheckedChange={setSingleGlyphButtons}
                      data-testid="switch-single-glyph-buttons"
                    />
                  </div>
                  <div className="flex items-center justify-between mt-6 pt-4 border-t">
                    <div className="flex-1 pr-4">
                      <Label htmlFor="glyph-input-translation" className="text-sm font-medium">
                        {t('aacSettings.glyphInputTranslation')}
                      </Label>
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('aacSettings.glyphInputTranslationDesc')}
                      </p>
                    </div>
                    <Switch
                      id="glyph-input-translation"
                      checked={glyphInputTranslation}
                      onCheckedChange={setGlyphInputTranslation}
                      data-testid="switch-glyph-input-translation"
                    />
                  </div>
                </CardContent>
              </CollapsibleSubSection>

              {/* Eyegaze / Dwell Selection */}
              <CollapsibleSubSection
                icon={<Crosshair className="w-5 h-5" />}
                title={t('aacSettings.eyegaze')}
                description={t('aacSettings.eyegazeDesc')}
              >
                <CardContent className="space-y-4">
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div className="space-y-0.5">
                      <Label className="text-base font-medium">
                        {t('aacSettings.enableEyegaze')}
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        {t('aacSettings.enableEyegazeDesc')}
                      </p>
                    </div>
                    <Switch
                      checked={eyegazeEnabled}
                      onCheckedChange={setEyegazeEnabled}
                    />
                  </div>
                  {eyegazeEnabled && (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label className="text-sm font-medium">
                          {t('aacSettings.inputSource')}
                        </Label>
                        <Select value={eyegazeProvider} onValueChange={setEyegazeProvider}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="mouse">{t('aacSettings.inputSourceCursor')}</SelectItem>
                            <SelectItem value="tobii">{t('aacSettings.inputSourceTobii')}</SelectItem>
                            <SelectItem value="eyetech">{t('aacSettings.inputSourceEyetech')}</SelectItem>
                            <SelectItem value="lctech">{t('aacSettings.inputSourceLctech')}</SelectItem>
                            <SelectItem value="gazepoint">{t('aacSettings.inputSourceGazepoint')}</SelectItem>
                            <SelectItem value="webhid">{t('aacSettings.inputSourceWebhid')}</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          {t('aacSettings.inputSourceHint')}
                        </p>
                      </div>
                      {eyegazeProvider !== 'mouse' && (
                        <div className="space-y-3">
                          <div className="space-y-2">
                            <Label className="text-sm font-medium">
                              {t('aacSettings.gazeSmoothing')}
                            </Label>
                            <Select
                              value={gazeSmoothing.preset}
                              onValueChange={(v) => {
                                if (v === 'custom') return;
                                const preset = v as GazeSmoothingPreset;
                                // The strength preset drives the filter values only —
                                // keep the independent viewing-distance settings.
                                setGazeSmoothing((prev) => ({
                                  ...settingsForPreset(preset),
                                  distanceMode: prev.distanceMode,
                                  fixedDistanceCm: prev.fixedDistanceCm,
                                }));
                              }}
                            >
                              <SelectTrigger className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="off">{t('aacSettings.gazeSmoothingOff')}</SelectItem>
                                <SelectItem value="light">{t('aacSettings.gazeSmoothingLight')}</SelectItem>
                                <SelectItem value="medium">{t('aacSettings.gazeSmoothingMedium')}</SelectItem>
                                <SelectItem value="strong">{t('aacSettings.gazeSmoothingStrong')}</SelectItem>
                                {gazeSmoothing.preset === 'custom' && (
                                  <SelectItem value="custom">{t('aacSettings.gazeSmoothingCustom')}</SelectItem>
                                )}
                              </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">
                              {t('aacSettings.gazeSmoothingHint')}
                            </p>
                          </div>

                          {gazeSmoothing.preset !== 'off' && (
                            <Collapsible open={gazeAdvancedOpen} onOpenChange={setGazeAdvancedOpen}>
                              <CollapsibleTrigger asChild>
                                <button
                                  type="button"
                                  className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
                                >
                                  <ChevronDown className={cn('w-4 h-4 transition-transform', gazeAdvancedOpen && 'rotate-180')} />
                                  {t('aacSettings.gazeAdvancedTuning')}
                                </button>
                              </CollapsibleTrigger>
                              <CollapsibleContent className="space-y-5 pt-3">
                                <p className="text-xs text-muted-foreground">
                                  {t('aacSettings.gazeAdvancedTuningHint')}
                                </p>

                                {/* Responsiveness — One-Euro minimum cutoff */}
                                <div className="space-y-2">
                                  <div className="flex justify-between items-center">
                                    <Label className="text-sm font-medium">{t('aacSettings.gazeResponsiveness')}</Label>
                                    <span className="text-sm text-muted-foreground">{gazeSmoothing.minCutoff.toFixed(1)}</span>
                                  </div>
                                  <Slider
                                    min={0.3} max={4} step={0.1}
                                    value={[gazeSmoothing.minCutoff]}
                                    onValueChange={(val) => setGazeSmoothing((p) => ({ ...p, minCutoff: val[0], preset: 'custom' }))}
                                  />
                                  <p className="text-xs text-muted-foreground">{t('aacSettings.gazeResponsivenessHint')}</p>
                                </div>

                                {/* Fast-movement tracking — One-Euro beta */}
                                <div className="space-y-2">
                                  <div className="flex justify-between items-center">
                                    <Label className="text-sm font-medium">{t('aacSettings.gazeFastTracking')}</Label>
                                    <span className="text-sm text-muted-foreground">{gazeSmoothing.beta.toFixed(2)}</span>
                                  </div>
                                  <Slider
                                    min={0} max={1} step={0.02}
                                    value={[gazeSmoothing.beta]}
                                    onValueChange={(val) => setGazeSmoothing((p) => ({ ...p, beta: val[0], preset: 'custom' }))}
                                  />
                                  <p className="text-xs text-muted-foreground">{t('aacSettings.gazeFastTrackingHint')}</p>
                                </div>

                                {/* Fixation lock toggle */}
                                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                                  <div className="space-y-0.5">
                                    <Label className="text-sm font-medium">{t('aacSettings.gazeFixationLock')}</Label>
                                    <p className="text-xs text-muted-foreground">{t('aacSettings.gazeFixationLockHint')}</p>
                                  </div>
                                  <Switch
                                    checked={gazeSmoothing.fixationEnabled}
                                    onCheckedChange={(c) => setGazeSmoothing((p) => ({ ...p, fixationEnabled: c, preset: 'custom' }))}
                                  />
                                </div>

                                {gazeSmoothing.fixationEnabled && (
                                  <>
                                    {/* Fixation zone — dispersion threshold in degrees */}
                                    <div className="space-y-2">
                                      <div className="flex justify-between items-center">
                                        <Label className="text-sm font-medium">{t('aacSettings.gazeFixationZone')}</Label>
                                        <span className="text-sm text-muted-foreground">{gazeSmoothing.dispersionDeg.toFixed(1)}°</span>
                                      </div>
                                      <Slider
                                        min={0.2} max={2.5} step={0.1}
                                        value={[gazeSmoothing.dispersionDeg]}
                                        onValueChange={(val) => setGazeSmoothing((p) => ({ ...p, dispersionDeg: val[0], preset: 'custom' }))}
                                      />
                                      <p className="text-xs text-muted-foreground">{t('aacSettings.gazeFixationZoneHint')}</p>
                                    </div>

                                    {/* Hold time — minimum fixation duration */}
                                    <div className="space-y-2">
                                      <div className="flex justify-between items-center">
                                        <Label className="text-sm font-medium">{t('aacSettings.gazeFixationHold')}</Label>
                                        <span className="text-sm text-muted-foreground">{gazeSmoothing.minDurationMs} ms</span>
                                      </div>
                                      <Slider
                                        min={80} max={400} step={10}
                                        value={[gazeSmoothing.minDurationMs]}
                                        onValueChange={(val) => setGazeSmoothing((p) => ({ ...p, minDurationMs: val[0], preset: 'custom' }))}
                                      />
                                      <p className="text-xs text-muted-foreground">{t('aacSettings.gazeFixationHoldHint')}</p>
                                    </div>
                                  </>
                                )}

                                {/* Viewing distance — feeds the degree↔pixel conversion */}
                                <div className="space-y-2">
                                  <Label className="text-sm font-medium">{t('aacSettings.gazeDistanceMode')}</Label>
                                  <Select
                                    value={gazeSmoothing.distanceMode}
                                    onValueChange={(v) => setGazeSmoothing((p) => ({ ...p, distanceMode: v === 'fixed' ? 'fixed' : 'face' }))}
                                  >
                                    <SelectTrigger className="w-full">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="face">{t('aacSettings.gazeDistanceAuto')}</SelectItem>
                                      <SelectItem value="fixed">{t('aacSettings.gazeDistanceFixed')}</SelectItem>
                                    </SelectContent>
                                  </Select>
                                  <p className="text-xs text-muted-foreground">{t('aacSettings.gazeDistanceModeHint')}</p>
                                </div>

                                {gazeSmoothing.distanceMode === 'fixed' && (
                                  <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                      <Label className="text-sm font-medium">{t('aacSettings.gazeFixedDistance')}</Label>
                                      <span className="text-sm text-muted-foreground">{gazeSmoothing.fixedDistanceCm} cm</span>
                                    </div>
                                    <Slider
                                      min={30} max={120} step={5}
                                      value={[gazeSmoothing.fixedDistanceCm]}
                                      onValueChange={(val) => setGazeSmoothing((p) => ({ ...p, fixedDistanceCm: val[0] }))}
                                    />
                                    <p className="text-xs text-muted-foreground">{t('aacSettings.gazeFixedDistanceHint')}</p>
                                  </div>
                                )}
                              </CollapsibleContent>
                            </Collapsible>
                          )}
                        </div>
                      )}
                      <div className="space-y-2">
                        <div className="flex justify-between items-center">
                          <Label className="text-sm font-medium">
                            {t('aacSettings.selectionTimeout')}
                          </Label>
                          <span className="text-sm text-muted-foreground">{eyegazeTimeout / 1000}s</span>
                        </div>
                        <Slider
                          min={1000}
                          max={10000}
                          step={500}
                          value={[eyegazeTimeout]}
                          onValueChange={(v) => setEyegazeTimeout(v[0])}
                        />
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <span>1s</span>
                          <span>2s</span>
                          <span>5s</span>
                          <span>10s</span>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-sm font-medium">
                          {t('aacSettings.selectionMethod')}
                        </Label>
                        <Select value={selectionMethod} onValueChange={setSelectionMethod}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="whole_button">{t('aacSettings.selectionMethodWholeButton')}</SelectItem>
                            <SelectItem value="selection_area">{t('aacSettings.selectionMethodSelectionArea')}</SelectItem>
                            <SelectItem value="intent">{t('aacSettings.selectionMethodIntent')}</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          {t('aacSettings.selectionMethodHint')}
                        </p>
                      </div>
                      {/* Rest areas — the circle of empty space cut from where
                          four buttons meet, so there is always somewhere close
                          by to look that selects nothing. */}
                      <div className="space-y-2">
                        <Label className="text-sm font-medium">
                          {t('aacSettings.restSpace')}
                        </Label>
                        <Select value={restSpace} onValueChange={setRestSpace}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="large">{t('aacSettings.restSpaceLarge')}</SelectItem>
                            <SelectItem value="small">{t('aacSettings.restSpaceSmall')}</SelectItem>
                            <SelectItem value="none">{t('aacSettings.restSpaceNone')}</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          {t('aacSettings.restSpaceHint')}
                        </p>
                      </div>
                      {/* Automated audio scan — fires the ear button's readout on
                          its own when the student has been hunting across the
                          board without selecting anything. */}
                      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                        <div className="space-y-0.5">
                          <Label className="text-sm font-medium">
                            {t('aacSettings.autoAudioScan')}
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            {t('aacSettings.autoAudioScanHint')}
                          </p>
                        </div>
                        <Switch
                          checked={autoAudioScan}
                          onCheckedChange={setAutoAudioScan}
                        />
                      </div>
                      {autoAudioScan && (
                        <div className="space-y-2">
                          <div className="flex justify-between items-center">
                            <Label className="text-sm font-medium">
                              {t('aacSettings.autoAudioScanDelay')}
                            </Label>
                            <span className="text-sm text-muted-foreground">{autoAudioScanDelay / 1000}s</span>
                          </div>
                          <Slider
                            min={5000}
                            max={60000}
                            step={1000}
                            value={[autoAudioScanDelay]}
                            onValueChange={(v) => setAutoAudioScanDelay(v[0])}
                          />
                          <div className="flex justify-between text-xs text-muted-foreground">
                            <span>5s</span>
                            <span>15s</span>
                            <span>30s</span>
                            <span>60s</span>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {t('aacSettings.autoAudioScanDelayHint')}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </CollapsibleSubSection>
            </CardContent>
          </CollapsibleSection>

          {/* Defined Gestures */}
          <CollapsibleSection
            icon={<Hand className="w-5 h-5" />}
            title={t('aacSettings.definedGesturesTitle')}
            description={t('aacSettings.definedGesturesDescription')}
          >
            <CardContent className="space-y-4">
              {definedGestures.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('aacSettings.definedGesturesEmpty')}</p>
              )}
              {definedGestures.map((gesture, idx) => (
                <div
                  key={idx}
                  className={cn(
                    "rounded-lg border p-3 space-y-2",
                    isDark ? "bg-gray-800/50 border-gray-700" : "bg-gray-50 border-gray-200",
                  )}
                >
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">{t('aacSettings.definedGesturesName')}</Label>
                      <Input
                        value={gesture.name}
                        onChange={(e) =>
                          setDefinedGestures((prev) =>
                            prev.map((g, i) => (i === idx ? { ...g, name: e.target.value } : g)),
                          )
                        }
                        placeholder={t('aacSettings.definedGesturesNamePlaceholder')}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('aacSettings.definedGesturesMeaning')}</Label>
                      <Input
                        value={gesture.meaning}
                        onChange={(e) =>
                          setDefinedGestures((prev) =>
                            prev.map((g, i) => (i === idx ? { ...g, meaning: e.target.value } : g)),
                          )
                        }
                        placeholder={t('aacSettings.definedGesturesMeaningPlaceholder')}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('aacSettings.definedGesturesDescriptionField')}</Label>
                    <Input
                      value={gesture.description || ''}
                      onChange={(e) =>
                        setDefinedGestures((prev) =>
                          prev.map((g, i) => (i === idx ? { ...g, description: e.target.value } : g)),
                        )
                      }
                      placeholder={t('aacSettings.definedGesturesDescriptionPlaceholder')}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setDefinedGestures((prev) => prev.filter((_, i) => i !== idx))
                    }
                  >
                    <Trash2 className="w-3 h-3 me-1" />
                    {t('aacSettings.definedGesturesRemove')}
                  </Button>
                </div>
              ))}

              <Button
                variant="outline"
                onClick={() =>
                  setDefinedGestures((prev) => [...prev, { name: '', meaning: '' }])
                }
              >
                <Plus className="w-4 h-4 me-2" />
                {t('aacSettings.definedGesturesAdd')}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t('aacSettings.definedGesturesHint')}
              </p>
            </CardContent>
          </CollapsibleSection>

          {/* Apps (content, games, add-ons) */}
          <CollapsibleSection
            icon={<AppWindow className="w-5 h-5" />}
            title={t('aacSettings.apps')}
            description={t('aacSettings.appsDescription')}
          >
            <CardContent className="space-y-4">

              {/* Permitted YouTube Content (channels, playlists, videos) */}
              <CollapsibleSubSection
                icon={<span className="text-xl">▶️</span>}
                title={t('aacSettings.permittedYoutubeContentTitle')}
                description={t('aacSettings.permittedYoutubeContentDescription')}
              >
            <CardContent className="space-y-4">
              {permittedYoutubeItems.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('aacSettings.permittedYoutubeContentEmpty')}</p>
              )}
              {permittedYoutubeItems.map((item, idx) => {
                const typeLabel = t(
                  item.type === 'channel'
                    ? 'aacSettings.permittedYoutubeTypeChannel'
                    : item.type === 'playlist'
                      ? 'aacSettings.permittedYoutubeTypePlaylist'
                      : 'aacSettings.permittedYoutubeTypeVideo',
                );
                return (
                  <div
                    key={idx}
                    className={cn(
                      "rounded-lg border p-3 space-y-2",
                      isDark ? "bg-gray-800/50 border-gray-700" : "bg-gray-50 border-gray-200",
                    )}
                  >
                    <div className="flex gap-3">
                      {item.type === 'video' ? (
                        <img
                          src={`https://img.youtube.com/vi/${encodeURIComponent(item.id)}/mqdefault.jpg`}
                          alt=""
                          className="w-24 h-[54px] object-cover rounded-md bg-black shrink-0"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-24 h-[54px] rounded-md bg-black/80 flex items-center justify-center shrink-0">
                          {item.type === 'playlist'
                            ? <ListVideo className="w-7 h-7 text-amber-400" />
                            : <Video className="w-7 h-7 text-red-500" />}
                        </div>
                      )}
                      <div className="flex-1 space-y-2">
                        <span className={cn(
                          "inline-block text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded",
                          isDark ? "bg-gray-700 text-gray-200" : "bg-gray-200 text-gray-700",
                        )}>
                          {typeLabel}
                        </span>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <Label className="text-xs">{t('aacSettings.permittedYoutubeContentLabel')}</Label>
                            <Input
                              value={item.label}
                              onChange={(e) =>
                                setPermittedYoutubeItems(prev =>
                                  prev.map((it, i) => (i === idx ? { ...it, label: e.target.value } : it)),
                                )
                              }
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">{t('aacSettings.permittedYoutubeContentId')}</Label>
                            <Input
                              value={item.id}
                              onChange={(e) =>
                                setPermittedYoutubeItems(prev =>
                                  prev.map((it, i) => (i === idx ? { ...it, id: e.target.value } : it)),
                                )
                              }
                              className="font-mono text-xs"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('aacSettings.permittedYoutubeContentDescriptionField')}</Label>
                      <Input
                        value={item.description || ''}
                        onChange={(e) =>
                          setPermittedYoutubeItems(prev =>
                            prev.map((it, i) => (i === idx ? { ...it, description: e.target.value } : it)),
                          )
                        }
                        placeholder={t('aacSettings.permittedYoutubeContentDescriptionPlaceholder')}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setPermittedYoutubeItems(prev => prev.filter((_, i) => i !== idx))
                      }
                    >
                      <Trash2 className="w-3 h-3 me-1" />
                      {t('aacSettings.permittedYoutubeContentRemove')}
                    </Button>
                  </div>
                );
              })}

              <div className="flex gap-2">
                <Input
                  placeholder={t('aacSettings.permittedYoutubeContentAddPlaceholder')}
                  value={youtubeInput}
                  onChange={(e) => setYoutubeInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !resolvingYoutube) {
                      e.preventDefault();
                      handleAddYoutube();
                    }
                  }}
                  className="flex-1"
                />
                <Button
                  variant="outline"
                  onClick={handleAddYoutube}
                  disabled={!youtubeInput.trim() || resolvingYoutube}
                >
                  {resolvingYoutube ? (
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4 me-2" />
                  )}
                  {t('aacSettings.permittedYoutubeContentAdd')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('aacSettings.permittedYoutubeContentHint')}
              </p>
            </CardContent>
              </CollapsibleSubSection>

              {/* Permitted Websites */}
              <CollapsibleSubSection
                icon={<Globe className="w-5 h-5" />}
                title={t('aacSettings.permittedWebsitesTitle')}
                description={t('aacSettings.permittedWebsitesDescription')}
              >
            <CardContent className="space-y-4">
              {permittedWebsites.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('aacSettings.permittedWebsitesEmpty')}</p>
              )}
              {permittedWebsites.map((site, idx) => (
                <div
                  key={idx}
                  className={cn(
                    "rounded-lg border p-3 space-y-2",
                    isDark ? "bg-gray-800/50 border-gray-700" : "bg-gray-50 border-gray-200",
                  )}
                >
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">{t('aacSettings.permittedWebsitesLabel')}</Label>
                      <Input
                        value={site.label}
                        onChange={(e) =>
                          setPermittedWebsites((prev) =>
                            prev.map((s, i) => (i === idx ? { ...s, label: e.target.value } : s)),
                          )
                        }
                        placeholder={t('aacSettings.permittedWebsitesLabelPlaceholder')}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('aacSettings.permittedWebsitesUrl')}</Label>
                      <Input
                        value={site.url}
                        onChange={(e) =>
                          setPermittedWebsites((prev) =>
                            prev.map((s, i) => (i === idx ? { ...s, url: e.target.value } : s)),
                          )
                        }
                        placeholder="https://example.com/"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('aacSettings.permittedWebsitesDescriptionField')}</Label>
                    <Input
                      value={site.description || ''}
                      onChange={(e) =>
                        setPermittedWebsites((prev) =>
                          prev.map((s, i) => (i === idx ? { ...s, description: e.target.value } : s)),
                        )
                      }
                      placeholder={t('aacSettings.permittedWebsitesDescriptionPlaceholder')}
                    />
                  </div>

                  {/* Subpages */}
                  {(site.subpages || []).map((sub, subIdx) => (
                    <div
                      key={subIdx}
                      className={cn(
                        "ms-6 rounded-md border p-2 space-y-2",
                        isDark ? "bg-gray-900/50 border-gray-700" : "bg-white border-gray-200",
                      )}
                    >
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label className="text-xs">{t('aacSettings.permittedWebsitesLabel')}</Label>
                          <Input
                            value={sub.label}
                            onChange={(e) =>
                              setPermittedWebsites((prev) =>
                                prev.map((s, i) =>
                                  i === idx
                                    ? {
                                        ...s,
                                        subpages: (s.subpages || []).map((ss, j) =>
                                          j === subIdx ? { ...ss, label: e.target.value } : ss,
                                        ),
                                      }
                                    : s,
                                ),
                              )
                            }
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">{t('aacSettings.permittedWebsitesUrl')}</Label>
                          <Input
                            value={sub.url}
                            onChange={(e) =>
                              setPermittedWebsites((prev) =>
                                prev.map((s, i) =>
                                  i === idx
                                    ? {
                                        ...s,
                                        subpages: (s.subpages || []).map((ss, j) =>
                                          j === subIdx ? { ...ss, url: e.target.value } : ss,
                                        ),
                                      }
                                    : s,
                                ),
                              )
                            }
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">{t('aacSettings.permittedWebsitesDescriptionField')}</Label>
                        <Input
                          value={sub.description || ''}
                          onChange={(e) =>
                            setPermittedWebsites((prev) =>
                              prev.map((s, i) =>
                                i === idx
                                  ? {
                                      ...s,
                                      subpages: (s.subpages || []).map((ss, j) =>
                                        j === subIdx ? { ...ss, description: e.target.value } : ss,
                                      ),
                                    }
                                  : s,
                              ),
                            )
                          }
                        />
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setPermittedWebsites((prev) =>
                            prev.map((s, i) =>
                              i === idx
                                ? { ...s, subpages: (s.subpages || []).filter((_, j) => j !== subIdx) }
                                : s,
                            ),
                          )
                        }
                      >
                        <Trash2 className="w-3 h-3 me-1" />
                        {t('aacSettings.permittedWebsitesRemoveSubpage')}
                      </Button>
                    </div>
                  ))}

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setPermittedWebsites((prev) =>
                          prev.map((s, i) =>
                            i === idx
                              ? { ...s, subpages: [...(s.subpages || []), { url: '', label: '' }] }
                              : s,
                          ),
                        )
                      }
                    >
                      <Plus className="w-3 h-3 me-1" />
                      {t('aacSettings.permittedWebsitesAddSubpage')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setPermittedWebsites((prev) => prev.filter((_, i) => i !== idx))
                      }
                    >
                      <Trash2 className="w-3 h-3 me-1" />
                      {t('aacSettings.permittedWebsitesRemove')}
                    </Button>
                  </div>
                </div>
              ))}

              <Button
                variant="outline"
                onClick={() =>
                  setPermittedWebsites((prev) => [...prev, { url: '', label: '' }])
                }
              >
                <Plus className="w-4 h-4 me-2" />
                {t('aacSettings.permittedWebsitesAddWebsite')}
              </Button>
            </CardContent>
              </CollapsibleSubSection>

              {/* Smart Home Actions — clinician-authored slots the AAC can fire
                  from a board. The authored type is still `spoken` ONLY: the
                  device utters `command` aloud and the family's own smart
                  speaker hears it, so there is no account to link and no type
                  selector to show. `requiresConfirmation` is now offered
                  because it is now ENFORCED — the AAC asks the student before
                  the action runs, and the server refuses a flagged press that
                  arrives without that answer. Deliberately not AI-editable —
                  see shared/home-actions.ts. */}
              {/* Captured restaurant menus awaiting a caretaker's confirmation.
                  Self-contained component — see
                  client/src/components/venue-menus/MenuReviewCard.tsx. */}
              {/* Location Menus. Controlled by this panel like every other
                  setting — it feeds `venueMenus` into the shared payload and
                  the dirty check, so the page's own Save is the only one. */}
              <CollapsibleSubSection
                icon={<MapPin className="w-5 h-5" />}
                title={<span className="flex items-center gap-2">{t('venueMenus.settings.title')}<BetaBadge size="md" /></span>}
                description={t('venueMenus.settings.description')}
              >
                <CardContent className="space-y-4">
                  <VenueMenuSettingsCard
                    settings={venueMenus}
                    onChange={setVenueMenus}
                    student={student}
                  />
                  {student?.id && <MenuReviewCard studentId={student.id} />}
                </CardContent>
              </CollapsibleSubSection>

              <CollapsibleSubSection
                icon={<Home className="w-5 h-5" />}
                title={<span className="flex items-center gap-2">{t('aacSettings.homeActionsTitle')}<BetaBadge size="md" /></span>}
                description={t('aacSettings.homeActionsDescription')}
              >
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">{t('aacSettings.homeActionsHint')}</p>
              {homeActions.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('aacSettings.homeActionsEmpty')}</p>
              )}
              {homeActions.map((action, idx) => (
                <div
                  key={action.id}
                  className={cn(
                    "rounded-lg border p-3 space-y-2",
                    isDark ? "bg-gray-800/50 border-gray-700" : "bg-gray-50 border-gray-200",
                  )}
                >
                  <div className="grid grid-cols-1 md:grid-cols-[1fr_7rem] gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">{t('aacSettings.homeActionsLabel')}</Label>
                      <Input
                        value={action.label}
                        onChange={(e) =>
                          setHomeActions((prev) =>
                            prev.map((a, i) => (i === idx ? { ...a, label: e.target.value } : a)),
                          )
                        }
                        placeholder={t('aacSettings.homeActionsLabelPlaceholder')}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('aacSettings.homeActionsIcon')}</Label>
                      <Input
                        value={action.icon || ''}
                        onChange={(e) =>
                          setHomeActions((prev) =>
                            prev.map((a, i) => (i === idx ? { ...a, icon: e.target.value } : a)),
                          )
                        }
                        placeholder={t('aacSettings.homeActionsIconPlaceholder')}
                        maxLength={4}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('aacSettings.homeActionsCommand')}</Label>
                    <Input
                      value={action.command}
                      onChange={(e) =>
                        setHomeActions((prev) =>
                          prev.map((a, i) => (i === idx ? { ...a, command: e.target.value } : a)),
                        )
                      }
                      placeholder={t('aacSettings.homeActionsCommandPlaceholder')}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('aacSettings.homeActionsCommandHelp')}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('aacSettings.homeActionsDescriptionField')}</Label>
                    <Input
                      value={action.description || ''}
                      onChange={(e) =>
                        setHomeActions((prev) =>
                          prev.map((a, i) => (i === idx ? { ...a, description: e.target.value } : a)),
                        )
                      }
                      placeholder={t('aacSettings.homeActionsDescriptionPlaceholder')}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-4 flex-wrap">
                      <div className="flex items-center gap-2">
                        <Switch
                          id={`home-action-enabled-${action.id}`}
                          checked={action.enabled !== false}
                          onCheckedChange={(checked) =>
                            setHomeActions((prev) =>
                              prev.map((a, i) => (i === idx ? { ...a, enabled: checked } : a)),
                            )
                          }
                        />
                        <Label htmlFor={`home-action-enabled-${action.id}`} className="text-xs">
                          {t('aacSettings.homeActionsEnabled')}
                        </Label>
                      </div>
                      {/* Enforced from phase 1 on: the AAC shows a Yes/No confirm
                          step before the action runs, and the press it sends is
                          refused server-side without that answer. */}
                      <div className="flex items-center gap-2">
                        <Switch
                          id={`home-action-confirm-${action.id}`}
                          checked={action.requiresConfirmation === true}
                          onCheckedChange={(checked) =>
                            setHomeActions((prev) =>
                              prev.map((a, i) => (i === idx ? { ...a, requiresConfirmation: checked } : a)),
                            )
                          }
                        />
                        <Label htmlFor={`home-action-confirm-${action.id}`} className="text-xs">
                          {t('aacSettings.homeActionsRequiresConfirmation')}
                        </Label>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setHomeActions((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      <Trash2 className="w-3 h-3 me-1" />
                      {t('aacSettings.homeActionsRemove')}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('aacSettings.homeActionsRequiresConfirmationHelp')}
                  </p>
                </div>
              ))}

              <Button
                variant="outline"
                onClick={() =>
                  setHomeActions((prev) => [
                    ...prev,
                    { id: createHomeActionId(), label: '', type: 'spoken', command: '', enabled: true },
                  ])
                }
              >
                <Plus className="w-4 h-4 me-2" />
                {t('aacSettings.homeActionsAdd')}
              </Button>
            </CardContent>
              </CollapsibleSubSection>

              {/* Custom Apps (Games) subsection */}
              {student?.id && <AACSettingsCustomApps studentId={student.id} />}

              {/* Content Packages used to sit here, buried under Apps. It is now
                  a top-level section of its own — see below. */}

              {/* Other Apps subsection */}
              <CollapsibleSubSection
                icon={<AppWindow className="w-5 h-5" />}
                title={t('aacSettings.otherApps')}
                description={t('aacSettings.appsDescription')}
              >
            <CardContent className="space-y-4">
              {/* YouTube */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">▶️</span>
                  <div>
                    <Label htmlFor="aac-app-youtube" className="text-sm font-medium">YouTube</Label>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.appYoutubeDesc')}</p>
                  </div>
                </div>
                <Switch
                  id="aac-app-youtube"
                  checked={appConfig.youtube?.enabled ?? false}
                  onCheckedChange={(checked) =>
                    setAppConfig(prev => ({ ...prev, youtube: { ...prev.youtube, enabled: checked } }))
                  }
                />
              </div>

              {/* Spotify */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">🎧</span>
                  <div>
                    <div className="flex items-center gap-2">
                      <Label htmlFor="aac-app-spotify" className="text-sm font-medium">Spotify</Label>
                      <BetaBadge />
                    </div>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.appSpotifyDesc')}</p>
                  </div>
                </div>
                <Switch
                  id="aac-app-spotify"
                  checked={appConfig.spotify?.enabled ?? false}
                  onCheckedChange={(checked) =>
                    setAppConfig(prev => ({ ...prev, spotify: { ...prev.spotify, enabled: checked } }))
                  }
                />
              </div>

              {/* Spotify Account Connection — only visible when Spotify is enabled */}
              {appConfig.spotify?.enabled && (
                <div className={cn("ms-10 p-3 rounded-lg border", isDark ? "bg-gray-800 border-gray-700" : "bg-gray-50 border-gray-200")}>
                  {appConfig.spotify?.connected ? (
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-green-600 dark:text-green-400">
                          {t('aacSettings.spotifyConnected')}
                        </p>
                        {appConfig.spotify?.accountEmail && (
                          <p className="text-xs text-muted-foreground">{appConfig.spotify.accountEmail}</p>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          try {
                            await apiRequest('DELETE', `/api/aac/spotify/disconnect?studentId=${student?.id}`);
                            setAppConfig(prev => ({
                              ...prev,
                              spotify: { ...prev.spotify, connected: false, accountEmail: undefined, refreshToken: undefined },
                            }));
                            await refetchStudent();
                          } catch { /* ignore */ }
                        }}
                      >
                        <Unlink className="w-3 h-3 me-1" />
                        {t('aacSettings.spotifyDisconnect')}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-muted-foreground">
                        {t('aacSettings.spotifyConnectHint')}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          try {
                            const res = await apiRequest('GET', `/api/aac/spotify/auth-url?studentId=${student?.id}`);
                            const { url } = await res.json();
                            window.open(url, '_blank', 'width=500,height=700');
                          } catch { /* ignore */ }
                        }}
                      >
                        <Link className="w-3 h-3 me-1" />
                        {t('aacSettings.spotifyConnect')}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* Drawing */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">🎨</span>
                  <div>
                    <Label className="text-sm font-medium">{t('aacSettings.appDrawing')}</Label>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.appDrawingDesc')}</p>
                  </div>
                </div>
                <Switch
                  checked={appConfig.drawing?.enabled ?? true}
                  onCheckedChange={(checked) =>
                    setAppConfig(prev => ({ ...prev, drawing: { ...prev.drawing, enabled: checked } }))
                  }
                />
              </div>

              {/* Music Maker */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">🎵</span>
                  <div>
                    <Label className="text-sm font-medium">{t('aacSettings.appMusic')}</Label>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.appMusicDesc')}</p>
                  </div>
                </div>
                <Switch
                  checked={appConfig.music?.enabled ?? true}
                  onCheckedChange={(checked) =>
                    setAppConfig(prev => ({ ...prev, music: { ...prev.music, enabled: checked } }))
                  }
                />
              </div>

              {/* Sandbox */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">🌱</span>
                  <div>
                    <Label className="text-sm font-medium">{t('aacSettings.appSandboxGame')}</Label>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.appSandboxGameDesc')}</p>
                  </div>
                </div>
                <Switch
                  checked={appConfig.sandbox_game?.enabled ?? false}
                  onCheckedChange={(checked) =>
                    setAppConfig(prev => ({ ...prev, sandbox_game: { ...prev.sandbox_game, enabled: checked } }))
                  }
                />
              </div>

              {/* Bubbles */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">🫧</span>
                  <div>
                    <Label className="text-sm font-medium">{t('aacSettings.appBubblesGame')}</Label>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.appBubblesGameDesc')}</p>
                  </div>
                </div>
                <Switch
                  checked={appConfig.bubbles_game?.enabled ?? false}
                  onCheckedChange={(checked) =>
                    setAppConfig(prev => ({ ...prev, bubbles_game: { ...prev.bubbles_game, enabled: checked } }))
                  }
                />
              </div>

              {/* Musical Microbes */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">🎶</span>
                  <div>
                    <Label className="text-sm font-medium">{t('aacSettings.appMusicalMicrobes')}</Label>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.appMusicalMicrobesDesc')}</p>
                  </div>
                </div>
                <Switch
                  checked={appConfig.musical_microbes?.enabled ?? false}
                  onCheckedChange={(checked) =>
                    setAppConfig(prev => ({ ...prev, musical_microbes: { ...prev.musical_microbes, enabled: checked } }))
                  }
                />
              </div>

              {/* Space Trader */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">🚀</span>
                  <div>
                    <Label className="text-sm font-medium">{t('aacSettings.appSpaceTrader')}</Label>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.appSpaceTraderDesc')}</p>
                  </div>
                </div>
                <Switch
                  checked={appConfig.space_trader?.enabled ?? false}
                  onCheckedChange={(checked) =>
                    setAppConfig(prev => ({ ...prev, space_trader: { ...prev.space_trader, enabled: checked } }))
                  }
                />
              </div>

              {/* Dollhouse */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">🏠</span>
                  <div>
                    <Label className="text-sm font-medium">{t('aacSettings.appDollhouse')}</Label>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.appDollhouseDesc')}</p>
                  </div>
                </div>
                <Switch
                  checked={appConfig.dollhouse?.enabled ?? true}
                  onCheckedChange={(checked) =>
                    setAppConfig(prev => ({ ...prev, dollhouse: { ...prev.dollhouse, enabled: checked } }))
                  }
                />
              </div>

              {/* Nature Hike — hyphenated app id (matches CallGame.appId), so
                  index with bracket access rather than a dotted property. */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">🥾</span>
                  <div>
                    <div className="flex items-center gap-2">
                      <Label className="text-sm font-medium">{t('aacSettings.appNatureHike')}</Label>
                      <BetaBadge />
                    </div>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.appNatureHikeDesc')}</p>
                  </div>
                </div>
                <Switch
                  checked={appConfig["nature-hike"]?.enabled ?? false}
                  onCheckedChange={(checked) =>
                    setAppConfig(prev => ({ ...prev, "nature-hike": { ...prev["nature-hike"], enabled: checked } }))
                  }
                />
              </div>

              {/* Family Photos — the student's OWN album.
                  It had no toggle at all until now, which meant `photos`
                  (enabledByDefault: false) could never be turned on by anyone:
                  the app, its server resolution and its prompt block all worked
                  and none of it was reachable. Sits directly above Find a
                  Picture on purpose — "their own people" vs "the open web" is
                  the distinction a clinician most needs to see side by side. */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">🖼️</span>
                  <div>
                    <div className="flex items-center gap-2">
                      <Label className="text-sm font-medium">{t('aacSettings.appPhotos')}</Label>
                      <BetaBadge />
                    </div>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.appPhotosDesc')}</p>
                  </div>
                </div>
                <Switch
                  checked={appConfig.photos?.enabled ?? false}
                  onCheckedChange={(checked) =>
                    setAppConfig(prev => ({ ...prev, photos: { ...prev.photos, enabled: checked } }))
                  }
                />
              </div>

              {/* Find a Picture — web image search.
                  Off unless deliberately turned on: unlike every other app in
                  this list, its content is not ours and nobody has reviewed it.
                  The sub-panel only appears once it is on, so the extra
                  controls do not imply the feature is running. */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">🔍</span>
                  <div>
                    <div className="flex items-center gap-2">
                      <Label className="text-sm font-medium">{t('aacSettings.appPictureSearch')}</Label>
                      <BetaBadge />
                    </div>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.appPictureSearchDesc')}</p>
                  </div>
                </div>
                <Switch
                  checked={appConfig.picture_search?.enabled ?? false}
                  onCheckedChange={(checked) =>
                    setAppConfig(prev => ({ ...prev, picture_search: { ...prev.picture_search, enabled: checked } }))
                  }
                />
              </div>

              {appConfig.picture_search?.enabled && (
                <div className={cn("ms-10 p-3 rounded-lg border space-y-3", isDark ? "bg-gray-800 border-gray-700" : "bg-gray-50 border-gray-200")}>
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
                    <p className="text-xs text-muted-foreground">{t('aacSettings.appPictureSearchWarning')}</p>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-sm font-medium">{t('aacSettings.pictureSearchBlocked')}</Label>
                    <Textarea
                      rows={3}
                      placeholder={t('aacSettings.pictureSearchBlockedPlaceholder')}
                      value={(appConfig.picture_search?.blockedTerms ?? []).join('\n')}
                      onChange={(e) =>
                        setAppConfig(prev => ({
                          ...prev,
                          picture_search: {
                            ...prev.picture_search,
                            // Split on save, not on keystroke shape: a clinician
                            // mid-word must not have their blank line eaten.
                            blockedTerms: e.target.value.split('\n').map(term => term.trim()).filter(Boolean),
                          },
                        }))
                      }
                    />
                    <p className="text-xs text-muted-foreground">{t('aacSettings.pictureSearchBlockedDesc')}</p>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-sm font-medium">{t('aacSettings.pictureSearchMaxResults')}</Label>
                    <Input
                      type="number"
                      min={MIN_RESULTS}
                      max={MAX_RESULTS_CEILING}
                      className="w-24"
                      value={appConfig.picture_search?.maxResults ?? DEFAULT_MAX_RESULTS}
                      onChange={(e) =>
                        setAppConfig(prev => ({
                          ...prev,
                          picture_search: {
                            ...prev.picture_search,
                            maxResults: Math.min(
                              MAX_RESULTS_CEILING,
                              Math.max(MIN_RESULTS, Number(e.target.value) || DEFAULT_MAX_RESULTS),
                            ),
                          },
                        }))
                      }
                    />
                    <p className="text-xs text-muted-foreground">{t('aacSettings.pictureSearchMaxResultsDesc')}</p>
                  </div>
                </div>
              )}

              {/* Game options — how world-engine games (Dollhouse, …) use the
                  live AI and the student's voice. Stored in appConfig.gameOptions. */}
              <div className="pt-4 mt-4 border-t space-y-4">
                <div>
                  <Label className="text-sm font-semibold">{t('aacSettings.gameOptions')}</Label>
                  <p className="text-xs text-muted-foreground">{t('aacSettings.gameOptionsDesc')}</p>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label className="text-sm font-medium">{t('aacSettings.gameUseAi')}</Label>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.gameUseAiDesc')}</p>
                  </div>
                  <Select
                    value={appConfig.gameOptions?.useAi ?? "energy"}
                    onValueChange={(v) =>
                      setAppConfig(prev => ({ ...prev, gameOptions: { ...prev.gameOptions, useAi: v } }))
                    }
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="on">{t('aacSettings.gameUseAiOn')}</SelectItem>
                      <SelectItem value="energy">{t('aacSettings.gameUseAiEnergy')}</SelectItem>
                      <SelectItem value="off">{t('aacSettings.gameUseAiOff')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label className="text-sm font-medium">{t('aacSettings.gameStudentVoice')}</Label>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.gameStudentVoiceDesc')}</p>
                  </div>
                  <Switch
                    checked={appConfig.gameOptions?.studentVoice ?? true}
                    onCheckedChange={(checked) =>
                      setAppConfig(prev => ({ ...prev, gameOptions: { ...prev.gameOptions, studentVoice: checked } }))
                    }
                  />
                </div>
              </div>

              {/* Social Trainer's enable toggle lives in its own customization
                  section above (it surfaces as "Practice friend" on the home
                  board, not the Apps page). */}
            </CardContent>
              </CollapsibleSubSection>
            </CardContent>
          </CollapsibleSection>

          {/* Content Packages — its own section. Packages are shared CONTENT
              with their own lifecycle (an organization publishes them, other
              organizations attach them), not a kind of app, so burying them
              under Apps made them hard to find. Renders nothing without the
              packages license. */}
          {student?.id && <AACSettingsPackages studentId={student.id} />}

          {/* Privacy */}
          <CollapsibleSection
            icon={<Shield className="w-5 h-5" />}
            title={t('aacSettings.privacy')}
            description={t('aacSettings.privacyDesc')}
          >
            <CardContent className="space-y-4">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">
                    {t('aacSettings.allowReadProgress')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.allowReadProgressDesc')}
                  </p>
                </div>
                <Switch
                  checked={allowReadProgress}
                  onCheckedChange={setAllowReadProgress}
                />
              </div>
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">
                    {t('aacSettings.allowReadReports')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.allowReadReportsDesc')}
                  </p>
                </div>
                <Switch
                  checked={allowReadReports}
                  onCheckedChange={setAllowReadReports}
                />
              </div>
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">
                    {t('aacSettings.allowNotes')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.allowNotesDesc')}
                  </p>
                </div>
                <Switch
                  checked={allowNotes}
                  onCheckedChange={setAllowNotes}
                />
              </div>
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">
                    {t('aacSettings.shareMonitorNotesWithInstitute')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.shareMonitorNotesWithInstituteDesc')}
                  </p>
                </div>
                <Switch
                  checked={shareMonitorNotesWithInstitute}
                  onCheckedChange={setShareMonitorNotesWithInstitute}
                />
              </div>
              {/* Device location. Off means the AAC client never asks the device
                  for a position at all — so no OS permission prompt reaches the
                  student either. */}
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">
                    {t('aacSettings.deviceLocation')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.deviceLocationDesc')}
                  </p>
                </div>
                <Switch
                  checked={deviceLocationEnabled}
                  onCheckedChange={setDeviceLocationEnabled}
                  data-testid="switch-device-location"
                />
              </div>

              {/* Session recording. It sits under Privacy because that is what
                  it is: a camera pointed at a child, writing to a disk. What it
                  produces never leaves the device — no route uploads it. See
                  shared/aac/session-recording.ts. */}
              <CollapsibleSubSection
                icon={<Video className="w-4 h-4" />}
                title={t('aacSettings.sessionRecordingTitle')}
                description={t('aacSettings.sessionRecordingDesc')}
              >
                <CardContent className="space-y-4">
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                    {t('aacSettings.sessionRecordingConsentNotice')}
                  </div>

                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div className="space-y-0.5">
                      <Label className="text-base font-medium">
                        {t('aacSettings.sessionRecordingEnable')}
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        {t('aacSettings.sessionRecordingEnableDesc')}
                      </p>
                    </div>
                    <Switch
                      checked={sessionRecording.enabled}
                      onCheckedChange={(enabled) =>
                        setSessionRecording((prev) => ({ ...prev, enabled }))}
                      data-testid="switch-session-recording"
                    />
                  </div>

                  {sessionRecording.enabled && (
                    <div className="space-y-4 border-s-2 border-muted ps-4">
                      <div className="space-y-1.5">
                        <Label className="text-sm font-medium">
                          {t('aacSettings.sessionRecordingQuality')}
                        </Label>
                        <Select
                          value={sessionRecording.quality}
                          onValueChange={(quality) =>
                            setSessionRecording((prev) => ({
                              ...prev, quality: quality as RecordingQuality,
                            }))}
                        >
                          <SelectTrigger data-testid="select-session-recording-quality">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="720p">{t('aacSettings.sessionRecordingQuality720')}</SelectItem>
                            <SelectItem value="1080p">{t('aacSettings.sessionRecordingQuality1080')}</SelectItem>
                            <SelectItem value="max">{t('aacSettings.sessionRecordingQualityMax')}</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          {t('aacSettings.sessionRecordingQualityDesc')}
                        </p>
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label className="text-sm font-medium">
                            {t('aacSettings.sessionRecordingPreRoll')}
                          </Label>
                          <Input
                            type="number"
                            min={PRE_ROLL_SECONDS_MIN}
                            max={PRE_ROLL_SECONDS_MAX}
                            value={sessionRecording.preRollSeconds}
                            onChange={(e) => setSessionRecording((prev) => ({
                              ...prev, preRollSeconds: Number(e.target.value),
                            }))}
                            data-testid="input-session-recording-preroll"
                          />
                          <p className="text-xs text-muted-foreground">
                            {t('aacSettings.sessionRecordingPreRollDesc')}
                          </p>
                        </div>

                        <div className="space-y-1.5">
                          <Label className="text-sm font-medium">
                            {t('aacSettings.sessionRecordingIdleTail')}
                          </Label>
                          <Input
                            type="number"
                            min={IDLE_TAIL_SECONDS_MIN}
                            max={IDLE_TAIL_SECONDS_MAX}
                            value={sessionRecording.idleTailSeconds}
                            onChange={(e) => setSessionRecording((prev) => ({
                              ...prev, idleTailSeconds: Number(e.target.value),
                            }))}
                            data-testid="input-session-recording-idle-tail"
                          />
                          <p className="text-xs text-muted-foreground">
                            {t('aacSettings.sessionRecordingIdleTailDesc')}
                          </p>
                        </div>

                        <div className="space-y-1.5">
                          <Label className="text-sm font-medium">
                            {t('aacSettings.sessionRecordingMaxClip')}
                          </Label>
                          <Input
                            type="number"
                            min={MAX_CLIP_MINUTES_MIN}
                            max={MAX_CLIP_MINUTES_MAX}
                            value={sessionRecording.maxClipMinutes}
                            onChange={(e) => setSessionRecording((prev) => ({
                              ...prev, maxClipMinutes: Number(e.target.value),
                            }))}
                            data-testid="input-session-recording-max-clip"
                          />
                          <p className="text-xs text-muted-foreground">
                            {t('aacSettings.sessionRecordingMaxClipDesc')}
                          </p>
                        </div>

                        <div className="space-y-1.5">
                          <Label className="text-sm font-medium">
                            {t('aacSettings.sessionRecordingStorage')}
                          </Label>
                          <Input
                            type="number"
                            min={MAX_STORAGE_MB_MIN}
                            max={MAX_STORAGE_MB_MAX}
                            step={1024}
                            value={sessionRecording.maxStorageMb}
                            onChange={(e) => setSessionRecording((prev) => ({
                              ...prev, maxStorageMb: Number(e.target.value),
                            }))}
                            data-testid="input-session-recording-storage"
                          />
                          <p className="text-xs text-muted-foreground">
                            {t('aacSettings.sessionRecordingStorageDesc')
                              .replace('{gb}', String(Math.round(sessionRecording.maxStorageMb / 1024)))}
                          </p>
                        </div>

                        <div className="space-y-1.5">
                          <Label className="text-sm font-medium">
                            {t('aacSettings.sessionRecordingMaxAge')}
                          </Label>
                          <Input
                            type="number"
                            min={MAX_AGE_DAYS_MIN}
                            max={MAX_AGE_DAYS_MAX}
                            step={1}
                            value={sessionRecording.maxAgeDays}
                            onChange={(e) => setSessionRecording((prev) => ({
                              ...prev, maxAgeDays: Number(e.target.value),
                            }))}
                            data-testid="input-session-recording-max-age"
                          />
                          <p className="text-xs text-muted-foreground">
                            {t('aacSettings.sessionRecordingMaxAgeDesc')
                              .replace('{days}', String(sessionRecording.maxAgeDays))}
                          </p>
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-sm font-medium">
                          {t('aacSettings.sessionRecordingFolder')}
                        </Label>
                        <Input
                          value={sessionRecording.folder ?? ''}
                          onChange={(e) => setSessionRecording((prev) => ({
                            ...prev, folder: e.target.value,
                          }))}
                          placeholder={t('aacSettings.sessionRecordingFolderPlaceholder')}
                          data-testid="input-session-recording-folder"
                        />
                        <p className="text-xs text-muted-foreground">
                          {t('aacSettings.sessionRecordingFolderDesc')}
                        </p>
                      </div>
                    </div>
                  )}
                </CardContent>
              </CollapsibleSubSection>

              {/* Caretaker PIN — the AAC device stays signed in for a year;
                  this is what keeps switch-student / manage-devices / sign-out
                  away from the child at the keyboard. */}
              {student?.id && (
                <CollapsibleSubSection
                  icon={<Lock className="w-5 h-5" />}
                  title={t('aacSettings.caretakerPinTitle')}
                  description={t('aacSettings.caretakerPinDesc')}
                >
                  <CardContent className="space-y-4">
                    <AACSettingsCaretakerPin studentId={student.id} />
                  </CardContent>
                </CollapsibleSubSection>
              )}

              {/* AI Learning — what the AI is allowed to record about the
                  people and world around the student, on its own initiative. */}
              <CollapsibleSubSection
                icon={<Sparkles className="w-4 h-4" />}
                title={t('aacSettings.aiLearning')}
                description={t('aacSettings.aiLearningDesc')}
              >
                <CardContent className="space-y-4">
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div className="space-y-0.5">
                      <Label className="text-base font-medium">
                        {t('aacSettings.autoAddContacts')}
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        {t('aacSettings.autoAddContactsDesc')}
                      </p>
                    </div>
                    <Switch
                      checked={autoAddContacts}
                      onCheckedChange={setAutoAddContacts}
                      data-testid="switch-auto-add-contacts"
                    />
                  </div>
                </CardContent>
              </CollapsibleSubSection>
            </CardContent>
          </CollapsibleSection>

          {/* Action Buttons */}
          <div className="flex gap-3 pt-2">
            <Button
              onClick={handleSave}
              disabled={!hasChanges || updateMutation.isPending}
              className="flex-1"
            >
              {updateMutation.isPending ? (
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 me-2" />
              )}
              {t('aacSettings.saveChanges')}
            </Button>
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={!hasChanges || updateMutation.isPending}
            >
              <RotateCcw className="w-4 h-4 me-2" />
              {t('aacSettings.discard')}
            </Button>
          </div>

          {hasChanges && (
            <p className="text-sm text-amber-600 dark:text-amber-400 text-center">
              {t('aacSettings.unsavedChanges')}
            </p>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}
