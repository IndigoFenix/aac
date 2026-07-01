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
import { AACSettingsCustomApps } from '@/components/AACSettingsCustomApps';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { apiRequest } from '@/lib/queryClient';
import type { DefinedGesture, PermittedWebsite, PermittedYoutubeItem, PermittedYoutubeItemType } from '@shared/schema';
import { resolvePermittedYoutubeItems } from '@shared/youtube-items';
import { LANGUAGE_LEVELS, DEFAULT_LANGUAGE_LEVEL_INT } from '@shared/aac-language-level';
import { tierByKey } from '@shared/aac/budget-tiers';
import { BudgetMeters } from '@/components/BudgetMeters';
import { type SeizureConfig, type SeizureSensitivity, DEFAULT_SEIZURE_CONFIG, coerceSeizureConfig } from '@shared/aac/seizure-config';
import { COMPETENCY_LABEL } from '@shared/social-bot/state';

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
  ImageIcon,
  AppWindow,
  Link,
  Unlink,
  Accessibility,
  Globe,
  Hand,
  Plus,
  Trash2,
  Video,
  ListVideo,
  Sparkles,
  ChevronDown,
  Activity,
} from 'lucide-react';
import { cn } from '@/lib/utils';

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
 * A settings Card whose header doubles as a collapse toggle. The header (icon +
 * title + optional description) stays visible at all times; clicking it shows or
 * hides the body. Pass the existing `<CardContent>` as children so each section
 * keeps its own padding/spacing. Defaults to collapsed so the long panel reads
 * as a scannable list of section titles.
 */
function CollapsibleSection({
  icon,
  title,
  description,
  defaultOpen = false,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button type="button" className="w-full text-start">
            <CardHeader
              className={cn(
                'cursor-pointer transition-colors hover:bg-muted/40',
                open ? 'rounded-t-lg' : 'rounded-lg',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                  {icon}
                  {title}
                </CardTitle>
                <ChevronDown
                  className={cn(
                    'w-5 h-5 shrink-0 text-muted-foreground transition-transform',
                    open && 'rotate-180',
                  )}
                />
              </div>
              {description && <CardDescription>{description}</CardDescription>}
            </CardHeader>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

/**
 * A nested collapsible group used INSIDE a CollapsibleSection's content (e.g. the
 * "Visibility" group under Accessibility, or "YouTube" / "Websites" under Apps).
 * Visually a bordered box with a clickable header; pass the existing
 * `<CardContent>` as children so the body keeps its own padding/spacing.
 */
function CollapsibleSubSection({
  icon,
  title,
  description,
  defaultOpen = false,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border bg-card">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button type="button" className="w-full text-start">
            <div className="flex items-center justify-between gap-2 px-6 py-4 transition-colors hover:bg-muted/40">
              <div className="space-y-1">
                <div className="flex items-center gap-2 font-semibold leading-none">
                  {icon}
                  {title}
                </div>
                {description && (
                  <p className="text-sm text-muted-foreground">{description}</p>
                )}
              </div>
              <ChevronDown
                className={cn(
                  'w-4 h-4 shrink-0 text-muted-foreground transition-transform',
                  open && 'rotate-180',
                )}
              />
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
    </div>
  );
}


export function AACSettingsPanel({ isOpen = true, onClose }: AACSettingsPanelProps) {
  const { student, refetchStudent } = useStudent();
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
  const [singleGlyphButtons, setSingleGlyphButtons] = useState(false);
  const [glyphInputTranslation, setGlyphInputTranslation] = useState(false);
  const [eyegazeEnabled, setEyegazeEnabled] = useState(false);
  const [eyegazeTimeout, setEyegazeTimeout] = useState(2000);
  const [eyegazeProvider, setEyegazeProvider] = useState<string>('mouse');
  const [allowReadProgress, setAllowReadProgress] = useState(true);
  const [allowReadReports, setAllowReadReports] = useState(true);
  const [allowNotes, setAllowNotes] = useState(true);
  const [shareMonitorNotesWithInstitute, setShareMonitorNotesWithInstitute] = useState(true);
  const [useApprovedSymbols, setUseApprovedSymbols] = useState(false);
  const [useUnapprovedSymbols, setUseUnapprovedSymbols] = useState(false);
  const [appConfig, setAppConfig] = useState<Record<string, any>>({});
  const [permittedWebsites, setPermittedWebsites] = useState<PermittedWebsite[]>([]);
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

  const { data: elevenlabsVoices, isLoading: elevenlabsLoading, isError: elevenlabsError } = useQuery({
    queryKey: ['/api/voices/elevenlabs-list', debouncedApiKey],
    queryFn: async () => {
      const res = await apiRequest('POST', '/api/voices/elevenlabs-list', { apiKey: debouncedApiKey });
      const data = await res.json();
      return data.voices as Array<{ voice_id: string; name: string; category: string; labels: Record<string, string> }>;
    },
    enabled: debouncedApiKey.length > 0,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  // Voice preview state
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const previewVoice = useCallback(async (voiceId: string) => {
    if (!voiceId || previewingVoice) return;
    setPreviewingVoice(voiceId);
    try {
      const res = await apiRequest('POST', '/api/voices/preview', {
        voiceId,
        text: t('aacSettings.elevenlabsTestPhrase'),
        apiKey: elevenlabsApiKey.trim() || undefined,
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      audio.onended = () => {
        setPreviewingVoice(null);
        URL.revokeObjectURL(url);
        previewAudioRef.current = null;
      };
      audio.onerror = () => {
        setPreviewingVoice(null);
        URL.revokeObjectURL(url);
        previewAudioRef.current = null;
      };
      await audio.play();
    } catch {
      setPreviewingVoice(null);
    }
  }, [previewingVoice, elevenlabsApiKey, t]);

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
      setSingleGlyphButtons(aac?.singleGlyphButtons ?? false);
      setGlyphInputTranslation(aac?.glyphInputTranslation ?? false);
      setEyegazeEnabled(aac?.eyegazeEnabled ?? false);
      setEyegazeTimeout(aac?.eyegazeTimeout ?? 2000);
      setEyegazeProvider(aac?.eyegazeProvider ?? 'mouse');
      setAllowReadProgress(aac?.allowReadProgress ?? true);
      setAllowReadReports(aac?.allowReadReports ?? true);
      setAllowNotes(aac?.allowNotes ?? true);
      setShareMonitorNotesWithInstitute(aac?.shareMonitorNotesWithInstitute ?? true);
      setUseApprovedSymbols(aac?.useApprovedSymbols ?? false);
      setUseUnapprovedSymbols(aac?.useUnapprovedSymbols ?? false);
      setAppConfig(aac?.appConfig || {});
      setPermittedWebsites(Array.isArray(aac?.permittedWebsites) ? aac.permittedWebsites : []);
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
      const originalSingleGlyphButtons = aac?.singleGlyphButtons ?? false;
      const originalGlyphInputTranslation = aac?.glyphInputTranslation ?? false;
      const originalEyegazeEnabled = aac?.eyegazeEnabled ?? false;
      const originalEyegazeTimeout = aac?.eyegazeTimeout ?? 2000;
      const originalEyegazeProvider = aac?.eyegazeProvider ?? 'mouse';
      const originalAllowReadProgress = aac?.allowReadProgress ?? true;
      const originalAllowReadReports = aac?.allowReadReports ?? true;
      const originalAllowNotes = aac?.allowNotes ?? true;
      const originalShareMonitorNotesWithInstitute = aac?.shareMonitorNotesWithInstitute ?? true;
      const originalUseApprovedSymbols = aac?.useApprovedSymbols ?? false;
      const originalUseUnapprovedSymbols = aac?.useUnapprovedSymbols ?? false;
      const originalAppConfig = aac?.appConfig || {};
      const originalPermittedWebsites = Array.isArray(aac?.permittedWebsites) ? aac.permittedWebsites : [];
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
        singleGlyphButtons !== originalSingleGlyphButtons ||
        glyphInputTranslation !== originalGlyphInputTranslation ||
        eyegazeEnabled !== originalEyegazeEnabled ||
        eyegazeTimeout !== originalEyegazeTimeout ||
        eyegazeProvider !== originalEyegazeProvider ||
        allowReadProgress !== originalAllowReadProgress ||
        allowReadReports !== originalAllowReadReports ||
        allowNotes !== originalAllowNotes ||
        shareMonitorNotesWithInstitute !== originalShareMonitorNotesWithInstitute ||
        useApprovedSymbols !== originalUseApprovedSymbols ||
        useUnapprovedSymbols !== originalUseUnapprovedSymbols ||
        JSON.stringify(appConfig) !== JSON.stringify(originalAppConfig) ||
        JSON.stringify(permittedWebsites) !== JSON.stringify(originalPermittedWebsites) ||
        JSON.stringify(definedGestures) !== JSON.stringify(originalDefinedGestures) ||
        JSON.stringify(permittedYoutubeItems) !== JSON.stringify(originalPermittedYoutubeItems) ||
        accessFontSize !== origAccessFontSize ||
        accessHighContrast !== origAccessHighContrast ||
        accessReduceAnimations !== origAccessReduceAnimations ||
        accessEnhancedFocus !== origAccessEnhancedFocus
      );
    }
  }, [aiName, chatAgentPrompt, autoAacPrompt, liveAudioSpeaker, fullAttentionMode, allowFacilitatorControl, boardManagerLiveModel, budgetTier, seizureDetection, elevenlabsEnabled, elevenlabsApiKey, elevenlabsAiVoiceId, elevenlabsStudentVoiceId, geminiAiVoice, geminiStudentVoice, aiVoicePitch, studentVoicePitch, useLocalTts, iconTextRatio, languageLevel, singleGlyphButtons, glyphInputTranslation, eyegazeEnabled, eyegazeTimeout, eyegazeProvider, allowReadProgress, allowReadReports, allowNotes, shareMonitorNotesWithInstitute, useApprovedSymbols, useUnapprovedSymbols, appConfig, permittedWebsites, definedGestures, permittedYoutubeItems, accessFontSize, accessHighContrast, accessReduceAnimations, accessEnhancedFocus, student]);

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: async (data: {
      aiName?: string;
      chatAgentPrompt: string[];
      autoAacPrompt: string[];
      liveAudioSpeaker?: boolean;
      seizureDetection?: { config: SeizureConfig };
      elevenlabsEnabled?: boolean;
      elevenlabsApiKey?: string;
      elevenlabsAiVoiceId?: string;
      elevenlabsStudentVoiceId?: string;
      geminiAiVoice?: string;
      geminiStudentVoice?: string;
      aiVoicePitch?: number;
      studentVoicePitch?: number;
      useLocalTts?: boolean;
      iconTextRatio: number;
      languageLevel: number;
      singleGlyphButtons: boolean;
      glyphInputTranslation: boolean;
      eyegazeEnabled: boolean;
      eyegazeTimeout: number;
      eyegazeProvider: string;
      allowReadProgress: boolean;
      allowReadReports: boolean;
      allowNotes: boolean;
      shareMonitorNotesWithInstitute: boolean;
      useApprovedSymbols: boolean;
      useUnapprovedSymbols: boolean;
      appConfig?: Record<string, any>;
      permittedWebsites?: PermittedWebsite[];
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
      toast({
        title: t('common.error'),
        description: error.message || t('aacSettings.updateError'),
        variant: 'destructive',
      });
    },
  });

  const handleSave = () => {
    if (!student) return;
    updateMutation.mutate({
      aiName: aiName.trim() || undefined,
      chatAgentPrompt,
      autoAacPrompt,
      liveAudioSpeaker,
      seizureDetection: { config: seizureDetection },
      elevenlabsEnabled,
      elevenlabsApiKey: elevenlabsApiKey.trim() || undefined,
      elevenlabsAiVoiceId: elevenlabsAiVoiceId.trim() || undefined,
      elevenlabsStudentVoiceId: elevenlabsStudentVoiceId.trim() || undefined,
      geminiAiVoice: geminiAiVoice || undefined,
      geminiStudentVoice: geminiStudentVoice || undefined,
      aiVoicePitch,
      studentVoicePitch,
      useLocalTts,
      iconTextRatio,
      languageLevel,
      singleGlyphButtons,
      glyphInputTranslation,
      eyegazeEnabled,
      eyegazeTimeout,
      eyegazeProvider,
      allowReadProgress,
      allowReadReports,
      allowNotes,
      shareMonitorNotesWithInstitute,
      useApprovedSymbols,
      useUnapprovedSymbols,
      appConfig,
      permittedWebsites,
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
      setSingleGlyphButtons(aac?.singleGlyphButtons ?? false);
      setGlyphInputTranslation(aac?.glyphInputTranslation ?? false);
      setEyegazeEnabled(aac?.eyegazeEnabled ?? false);
      setEyegazeTimeout(aac?.eyegazeTimeout ?? 2000);
      setEyegazeProvider(aac?.eyegazeProvider ?? 'mouse');
      setAllowReadProgress(aac?.allowReadProgress ?? true);
      setAllowReadReports(aac?.allowReadReports ?? true);
      setAllowNotes(aac?.allowNotes ?? true);
      setShareMonitorNotesWithInstitute(aac?.shareMonitorNotesWithInstitute ?? true);
      setUseApprovedSymbols(aac?.useApprovedSymbols ?? false);
      setUseUnapprovedSymbols(aac?.useUnapprovedSymbols ?? false);
      setAppConfig(aac?.appConfig || {});
      setPermittedWebsites(Array.isArray(aac?.permittedWebsites) ? aac.permittedWebsites : []);
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

          {/* AI Assistant — name, language level, and chat behavior */}
          <CollapsibleSection
            icon={<MessageSquare className="w-5 h-5" />}
            title={t('aacSettings.aiAssistant')}
            description={t('aacSettings.chatBehaviorDesc')}
            defaultOpen
          >
            <CardContent className="space-y-6">
              {/* AI Name */}
              <div className="space-y-2">
                <Label className="text-base font-medium">{t('aacSettings.aiName')}</Label>
                <p className="text-xs text-muted-foreground">{t('aacSettings.aiNameDesc')}</p>
                <Input
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
              {/* Live Audio Speaker — when on, AI voice comes from Gemini Live
                  native audio and the ElevenLabs section is hidden. */}
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">{t('aacSettings.liveAudioSpeakerTitle')}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.liveAudioSpeakerDesc')}
                  </p>
                </div>
                <Switch checked={liveAudioSpeaker} onCheckedChange={setLiveAudioSpeaker} />
              </div>

              {/* Gemini Voice Settings */}
              <div className="space-y-4 pt-4 border-t">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">{t('aacSettings.voiceSettings')}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.geminiVoiceDesc')}
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <Label className="text-sm text-muted-foreground">{t('aacSettings.aiVoice')}</Label>
                  <Select value={geminiAiVoice || "_default"} onValueChange={(v) => { setGeminiAiVoice(v === "_default" ? "" : v); if (v === "_default") setAiVoicePitch(0); }}>
                    <SelectTrigger className="w-full md:w-[200px]">
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_default">Default</SelectItem>
                      <SelectItem value="Puck">Puck — Young, energetic</SelectItem>
                      <SelectItem value="Charon">Charon — Calm, mature male</SelectItem>
                      <SelectItem value="Kore">Kore — Clear, friendly female</SelectItem>
                      <SelectItem value="Fenrir">Fenrir — Deep, confident male</SelectItem>
                      <SelectItem value="Aoede">Aoede — Warm, expressive female</SelectItem>
                      <SelectItem value="Leda">Leda — Gentle, youthful female</SelectItem>
                      <SelectItem value="Orus">Orus — Steady, reassuring male</SelectItem>
                      <SelectItem value="Zephyr">Zephyr — Light, neutral</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between">
                  <Label className="text-sm text-muted-foreground">{t('aacSettings.studentVoice')}</Label>
                  <Select value={geminiStudentVoice || "_default"} onValueChange={(v) => { setGeminiStudentVoice(v === "_default" ? "" : v); if (v === "_default") setStudentVoicePitch(0); }}>
                    <SelectTrigger className="w-full md:w-[200px]">
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_default">Default</SelectItem>
                      <SelectItem value="Puck">Puck — Young, energetic</SelectItem>
                      <SelectItem value="Charon">Charon — Calm, mature male</SelectItem>
                      <SelectItem value="Kore">Kore — Clear, friendly female</SelectItem>
                      <SelectItem value="Fenrir">Fenrir — Deep, confident male</SelectItem>
                      <SelectItem value="Aoede">Aoede — Warm, expressive female</SelectItem>
                      <SelectItem value="Leda">Leda — Gentle, youthful female</SelectItem>
                      <SelectItem value="Orus">Orus — Steady, reassuring male</SelectItem>
                      <SelectItem value="Zephyr">Zephyr — Light, neutral</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Voice Pitch Adjustment — only shown when at least one voice is explicitly set */}
              {(geminiAiVoice || geminiStudentVoice) && (
              <div className="pt-4 border-t space-y-3">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">{t('aacSettings.voicePitch')}</Label>
                  <p className="text-sm text-muted-foreground">{t('aacSettings.voicePitchDesc')}</p>
                </div>

                {geminiAiVoice && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm text-muted-foreground">{t('aacSettings.aiVoice')}</Label>
                    <span className="text-sm text-muted-foreground">{aiVoicePitch > 0 ? `+${aiVoicePitch}` : aiVoicePitch}</span>
                  </div>
                  <Slider
                    min={-6}
                    max={6}
                    step={1}
                    value={[aiVoicePitch]}
                    onValueChange={(v: number[]) => setAiVoicePitch(v[0])}
                    className="w-full"
                  />
                </div>
                )}

                {geminiStudentVoice && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm text-muted-foreground">{t('aacSettings.studentVoice')}</Label>
                    <span className="text-sm text-muted-foreground">{studentVoicePitch > 0 ? `+${studentVoicePitch}` : studentVoicePitch}</span>
                  </div>
                  <Slider
                    min={-6}
                    max={6}
                    step={1}
                    value={[studentVoicePitch]}
                    onValueChange={(v: number[]) => setStudentVoicePitch(v[0])}
                    className="w-full"
                  />
                </div>
                )}
              </div>
              )}

              {/* Local Browser TTS */}
              <div className="pt-4 border-t space-y-2">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label className="text-base font-medium">{t('aacSettings.localTtsTitle')}</Label>
                    <p className="text-sm text-muted-foreground">{t('aacSettings.localTtsDesc')}</p>
                  </div>
                  <Switch checked={useLocalTts} onCheckedChange={setUseLocalTts} />
                </div>
              </div>

              {/* ElevenLabs Direct Voice Settings. The whole block stays
                  visible regardless of live-audio mode — only the AI voice
                  picker is hidden when live audio is on (the AI then speaks
                  via Gemini Live native audio). Student voice + API key stay
                  applicable since the student-press TTS pipeline is the same
                  in both modes. */}
              <div className="pt-4 border-t space-y-4">
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
                  <Input
                    type="password"
                    value={elevenlabsApiKey}
                    onChange={(e) => setElevenlabsApiKey(e.target.value)}
                    placeholder={t('aacSettings.elevenlabsApiKeyPlaceholder')}
                    className="w-full md:w-[280px]"
                  />
                </div>

                {elevenlabsError && debouncedApiKey && (
                  <p className="text-sm text-destructive">{t('aacSettings.elevenlabsInvalidKey')}</p>
                )}

                {debouncedApiKey && !elevenlabsError && (
                  <>
                    {!liveAudioSpeaker && (
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label className="text-sm text-muted-foreground">
                          {t('aacSettings.elevenlabsAiVoiceId')}
                        </Label>
                      </div>
                      {elevenlabsLoading ? (
                        <p className="text-sm text-muted-foreground w-full md:w-[280px]">{t('aacSettings.elevenlabsLoadingVoices')}</p>
                      ) : elevenlabsVoices && elevenlabsVoices.length > 0 ? (
                        <div className="flex gap-2 items-center">
                          {elevenlabsAiVoiceId && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => previewVoice(elevenlabsAiVoiceId)}
                              disabled={!!previewingVoice}
                              title={t('aacSettings.elevenlabsTestVoice')}
                              className="shrink-0 h-8 w-8 p-0"
                            >
                              {previewingVoice === elevenlabsAiVoiceId ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Play className="w-4 h-4" />
                              )}
                            </Button>
                          )}
                          <Select
                            value={elevenlabsAiVoiceId || '_none'}
                            onValueChange={(v) => setElevenlabsAiVoiceId(v === '_none' ? '' : v)}
                          >
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
                    )}

                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label className="text-sm text-muted-foreground">
                          {t('aacSettings.elevenlabsStudentVoiceId')}
                        </Label>
                      </div>
                      {elevenlabsLoading ? (
                        <p className="text-sm text-muted-foreground w-full md:w-[280px]">{t('aacSettings.elevenlabsLoadingVoices')}</p>
                      ) : elevenlabsVoices && elevenlabsVoices.length > 0 ? (
                        <div className="flex gap-2 items-center">
                          {elevenlabsStudentVoiceId && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => previewVoice(elevenlabsStudentVoiceId)}
                              disabled={!!previewingVoice}
                              title={t('aacSettings.elevenlabsTestVoice')}
                              className="shrink-0 h-8 w-8 p-0"
                            >
                              {previewingVoice === elevenlabsStudentVoiceId ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Play className="w-4 h-4" />
                              )}
                            </Button>
                          )}
                          <Select
                            value={elevenlabsStudentVoiceId || '_none'}
                            onValueChange={(v) => setElevenlabsStudentVoiceId(v === '_none' ? '' : v)}
                          >
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
                  </>
                )}

                {!debouncedApiKey && (
                  <>
                    {!liveAudioSpeaker && (
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label className="text-sm text-muted-foreground">
                          {t('aacSettings.elevenlabsAiVoiceId')}
                        </Label>
                      </div>
                      <Input
                        type="text"
                        value={elevenlabsAiVoiceId}
                        onChange={(e) => setElevenlabsAiVoiceId(e.target.value)}
                        placeholder={t('aacSettings.elevenlabsVoiceIdPlaceholder')}
                        className="w-full md:w-[280px] font-mono"
                      />
                    </div>
                    )}
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label className="text-sm text-muted-foreground">
                          {t('aacSettings.elevenlabsStudentVoiceId')}
                        </Label>
                      </div>
                      <Input
                        type="text"
                        value={elevenlabsStudentVoiceId}
                        onChange={(e) => setElevenlabsStudentVoiceId(e.target.value)}
                        placeholder={t('aacSettings.elevenlabsVoiceIdPlaceholder')}
                        className="w-full md:w-[280px] font-mono"
                      />
                    </div>
                  </>
                )}
                </div>
              </div>
            </CardContent>
          </CollapsibleSection>

          {/* Seizure Detection — TECHNICAL config for the on-device motion
              detectors (when they flag a possible seizure to the AI). Tune per
              student so their usual movements don't trip false warnings. Clinical
              guidance (what their seizures look like, what to do) belongs in the
              AAC prompt, not here. Opt-in / off by default. */}
          <CollapsibleSection
            icon={<Activity className="w-5 h-5" />}
            title={t('aacSettings.seizureDetection')}
            description={t('aacSettings.seizureDetectionDesc')}
          >
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">{t('aacSettings.seizureDetectionEnable')}</Label>
                  <p className="text-sm text-muted-foreground">{t('aacSettings.seizureDetectionEnableDesc')}</p>
                </div>
                <Switch
                  checked={seizureDetection.enabled}
                  onCheckedChange={(v) => setSeizureDetection(s => ({ ...s, enabled: v }))}
                  data-testid="switch-seizure-detection"
                />
              </div>

              {seizureDetection.enabled && (
                <>
                  {/* Rhythmic / convulsive (tonic-clonic) detector sensitivity. */}
                  <div className="space-y-1 pt-4 border-t">
                    <Label className="text-base font-medium">{t('aacSettings.seizureRhythmic')}</Label>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.seizureRhythmicDesc')}</p>
                    <Select
                      value={seizureDetection.rhythmic}
                      onValueChange={(v) => setSeizureDetection(s => ({ ...s, rhythmic: v as SeizureSensitivity }))}
                    >
                      <SelectTrigger data-testid="select-seizure-rhythmic"><SelectValue /></SelectTrigger>
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
                      <SelectTrigger data-testid="select-seizure-atonic"><SelectValue /></SelectTrigger>
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
                    <div className="flex gap-2 md:gap-3 justify-center">
                      {([1, 2, 3, 4, 5] as const).map((lvl) => {
                        const isActive = iconTextRatio === lvl;
                        // Preview sizing: icon flex vs text flex
                        const iconFlex = [9, 4, 3, 2, 1][lvl - 1];
                        const textFlex = [1, 1, 1, 1, 2][lvl - 1];
                        const emojiSize = ['text-2xl', 'text-xl', 'text-lg', 'text-base', 'text-sm'][lvl - 1];
                        const labelSize = ['text-[6px]', 'text-[7px]', 'text-[8px]', 'text-[9px]', 'text-xs'][lvl - 1];
                        return (
                          <button
                            key={lvl}
                            type="button"
                            onClick={() => setIconTextRatio(lvl)}
                            className={cn(
                              "flex flex-col items-center justify-center flex-1 min-w-0 max-w-16 h-20 rounded-lg border-2 transition-all",
                              isActive
                                ? "border-primary bg-primary/10 ring-2 ring-primary/30"
                                : "border-border hover:border-primary/50 bg-card"
                            )}
                          >
                            <div className="flex items-center justify-center w-full" style={{ flex: iconFlex }}>
                              <span className={`${emojiSize} leading-none`}>😊</span>
                            </div>
                            <div className="flex items-center justify-center w-full overflow-hidden" style={{ flex: textFlex }}>
                              <span className={`${labelSize} font-medium text-center leading-tight text-foreground`}>Hello</span>
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
                    </div>
                  )}
                </CardContent>
              </CollapsibleSubSection>
            </CardContent>
          </CollapsibleSection>

          {/* Symbol Generation Settings */}
          <CollapsibleSection
            icon={<ImageIcon className="w-5 h-5" />}
            title={t('aacSettings.symbolGeneration')}
            description={t('aacSettings.symbolGenerationDesc')}
          >
            <CardContent className="space-y-4">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">
                    {t('aacSettings.useApprovedSymbols')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.useApprovedSymbolsDesc')}
                  </p>
                </div>
                <Switch
                  checked={useApprovedSymbols}
                  onCheckedChange={setUseApprovedSymbols}
                />
              </div>
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">
                    {t('aacSettings.useUnapprovedSymbols')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.useUnapprovedSymbolsDesc')}
                  </p>
                </div>
                <Switch
                  checked={useUnapprovedSymbols}
                  onCheckedChange={setUseUnapprovedSymbols}
                />
              </div>
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

              {/* Custom Apps (Games) subsection */}
              {student?.id && <AACSettingsCustomApps studentId={student.id} />}

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
                    <Label htmlFor="aac-app-spotify" className="text-sm font-medium">Spotify</Label>
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

              {/* Sandbox Farm */}
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

              {/* Social Trainer's enable toggle lives in its own customization
                  section above (it surfaces as "Practice friend" on the home
                  board, not the Apps page). */}
            </CardContent>
              </CollapsibleSubSection>
            </CardContent>
          </CollapsibleSection>

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
