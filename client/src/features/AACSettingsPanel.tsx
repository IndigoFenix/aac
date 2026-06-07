import { useState, useEffect, useRef, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStudent } from '@/hooks/useStudent';
import { AACSettingsCustomApps } from '@/components/AACSettingsCustomApps';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { apiRequest } from '@/lib/queryClient';
import type { PermittedWebsite, PermittedYoutubeItem, PermittedYoutubeItemType } from '@shared/schema';
import { resolvePermittedYoutubeItems } from '@shared/youtube-items';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  Save,
  RotateCcw,
  User,
  Loader2,
  LayoutGrid,
  Zap,
  Search,
  Crosshair,
  Play,
  Shield,
  ImageIcon,
  AppWindow,
  Link,
  Unlink,
  Accessibility,
  Globe,
  Plus,
  Trash2,
  Video,
  ListVideo,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface AACSettingsPanelProps {
  isOpen?: boolean;
  onClose?: () => void;
}

const DEFAULT_AAC_PROMPT = `You are an advanced conversational AI designed to assist AAC (Augmentative and Alternative Communication) users.
You should:
- Respond in a friendly, supportive manner
- Keep responses concise and clear
- Help expand on the user's symbol selections to form complete thoughts
- Ask clarifying questions when needed
- Be patient and encouraging`;


export function AACSettingsPanel({ isOpen = true, onClose }: AACSettingsPanelProps) {
  const { student, refetchStudent } = useStudent();
  const { t } = useLanguage();
  const { theme } = useTheme();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isDark = theme === 'dark';


  // Form state
  const [aiName, setAiName] = useState('');
  const [chatAgentPrompt, setChatAgentPrompt] = useState('');
  // Auto-generated AAC prompt — AI-owned digest. Shown read-only; clinicians
  // can clear it but don't hand-edit it (it's regenerated as the assistant learns).
  const [autoAacPrompt, setAutoAacPrompt] = useState('');
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
  const [singleGlyphButtons, setSingleGlyphButtons] = useState(false);
  const [startupMode, setStartupMode] = useState(0);
  const [eyegazeEnabled, setEyegazeEnabled] = useState(false);
  const [eyegazeTimeout, setEyegazeTimeout] = useState(2000);
  const [eyegazeProvider, setEyegazeProvider] = useState<string>('mouse');
  const [allowReadProgress, setAllowReadProgress] = useState(true);
  const [allowReadReports, setAllowReadReports] = useState(true);
  const [allowNotes, setAllowNotes] = useState(true);
  const [shareMonitorNotesWithInstitute, setShareMonitorNotesWithInstitute] = useState(true);
  const [generateSymbols, setGenerateSymbols] = useState(false);
  const [useApprovedSymbols, setUseApprovedSymbols] = useState(false);
  const [useUnapprovedSymbols, setUseUnapprovedSymbols] = useState(false);
  const [dynamicBoardsEnabled, setDynamicBoardsEnabled] = useState(false);
  const [appConfig, setAppConfig] = useState<Record<string, any>>({});
  const [permittedWebsites, setPermittedWebsites] = useState<PermittedWebsite[]>([]);
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
      setChatAgentPrompt(aac?.chatAgentPrompt || DEFAULT_AAC_PROMPT);
      setAutoAacPrompt(aac?.autoAacPrompt || '');
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
      setSingleGlyphButtons(aac?.singleGlyphButtons ?? false);
      setStartupMode(aac?.startupMode ?? 0);
      setEyegazeEnabled(aac?.eyegazeEnabled ?? false);
      setEyegazeTimeout(aac?.eyegazeTimeout ?? 2000);
      setEyegazeProvider(aac?.eyegazeProvider ?? 'mouse');
      setAllowReadProgress(aac?.allowReadProgress ?? true);
      setAllowReadReports(aac?.allowReadReports ?? true);
      setAllowNotes(aac?.allowNotes ?? true);
      setShareMonitorNotesWithInstitute(aac?.shareMonitorNotesWithInstitute ?? true);
      setGenerateSymbols(aac?.generateSymbols ?? false);
      setUseApprovedSymbols(aac?.useApprovedSymbols ?? false);
      setDynamicBoardsEnabled(aac?.dynamicBoardsEnabled ?? false);
      setUseUnapprovedSymbols(aac?.useUnapprovedSymbols ?? false);
      setAppConfig(aac?.appConfig || {});
      setPermittedWebsites(Array.isArray(aac?.permittedWebsites) ? aac.permittedWebsites : []);
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
      const originalPrompt = aac?.chatAgentPrompt || DEFAULT_AAC_PROMPT;
      const originalAutoPrompt = aac?.autoAacPrompt || '';
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
      const originalSingleGlyphButtons = aac?.singleGlyphButtons ?? false;
      const originalStartupMode = aac?.startupMode ?? 0;
      const originalEyegazeEnabled = aac?.eyegazeEnabled ?? false;
      const originalEyegazeTimeout = aac?.eyegazeTimeout ?? 2000;
      const originalEyegazeProvider = aac?.eyegazeProvider ?? 'mouse';
      const originalAllowReadProgress = aac?.allowReadProgress ?? true;
      const originalAllowReadReports = aac?.allowReadReports ?? true;
      const originalAllowNotes = aac?.allowNotes ?? true;
      const originalShareMonitorNotesWithInstitute = aac?.shareMonitorNotesWithInstitute ?? true;
      const originalGenerateSymbols = aac?.generateSymbols ?? false;
      const originalUseApprovedSymbols = aac?.useApprovedSymbols ?? false;
      const originalUseUnapprovedSymbols = aac?.useUnapprovedSymbols ?? false;
      const originalAppConfig = aac?.appConfig || {};
      const originalPermittedWebsites = Array.isArray(aac?.permittedWebsites) ? aac.permittedWebsites : [];
      const originalPermittedYoutubeItems = resolvePermittedYoutubeItems(aac);
      const origAcc = aac?.accessibility || {};
      const origAccessFontSize = origAcc.fontSize ?? 100;
      const origAccessHighContrast = origAcc.highContrast ?? false;
      const origAccessReduceAnimations = origAcc.reduceAnimations ?? false;
      const origAccessEnhancedFocus = origAcc.enhancedFocusIndicator ?? false;
      setHasChanges(
        aiName !== originalAiName ||
        chatAgentPrompt !== originalPrompt ||
        autoAacPrompt !== originalAutoPrompt ||
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
        singleGlyphButtons !== originalSingleGlyphButtons ||
        startupMode !== originalStartupMode ||
        eyegazeEnabled !== originalEyegazeEnabled ||
        eyegazeTimeout !== originalEyegazeTimeout ||
        eyegazeProvider !== originalEyegazeProvider ||
        allowReadProgress !== originalAllowReadProgress ||
        allowReadReports !== originalAllowReadReports ||
        allowNotes !== originalAllowNotes ||
        shareMonitorNotesWithInstitute !== originalShareMonitorNotesWithInstitute ||
        generateSymbols !== originalGenerateSymbols ||
        useApprovedSymbols !== originalUseApprovedSymbols ||
        useUnapprovedSymbols !== originalUseUnapprovedSymbols ||
        JSON.stringify(appConfig) !== JSON.stringify(originalAppConfig) ||
        JSON.stringify(permittedWebsites) !== JSON.stringify(originalPermittedWebsites) ||
        JSON.stringify(permittedYoutubeItems) !== JSON.stringify(originalPermittedYoutubeItems) ||
        accessFontSize !== origAccessFontSize ||
        accessHighContrast !== origAccessHighContrast ||
        accessReduceAnimations !== origAccessReduceAnimations ||
        accessEnhancedFocus !== origAccessEnhancedFocus
      );
    }
  }, [aiName, chatAgentPrompt, autoAacPrompt, elevenlabsEnabled, elevenlabsApiKey, elevenlabsAiVoiceId, elevenlabsStudentVoiceId, geminiAiVoice, geminiStudentVoice, aiVoicePitch, studentVoicePitch, useLocalTts, iconTextRatio, singleGlyphButtons, startupMode, eyegazeEnabled, eyegazeTimeout, eyegazeProvider, allowReadProgress, allowReadReports, allowNotes, shareMonitorNotesWithInstitute, generateSymbols, useApprovedSymbols, useUnapprovedSymbols, appConfig, permittedWebsites, permittedYoutubeItems, accessFontSize, accessHighContrast, accessReduceAnimations, accessEnhancedFocus, student]);

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: async (data: {
      aiName?: string;
      chatAgentPrompt: string;
      autoAacPrompt: string;
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
      singleGlyphButtons: boolean;
      startupMode: number;
      eyegazeEnabled: boolean;
      eyegazeTimeout: number;
      eyegazeProvider: string;
      allowReadProgress: boolean;
      allowReadReports: boolean;
      allowNotes: boolean;
      shareMonitorNotesWithInstitute: boolean;
      generateSymbols: boolean;
      useApprovedSymbols: boolean;
      useUnapprovedSymbols: boolean;
      dynamicBoardsEnabled: boolean;
      appConfig?: Record<string, any>;
      permittedWebsites?: PermittedWebsite[];
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
      singleGlyphButtons,
      startupMode,
      eyegazeEnabled,
      eyegazeTimeout,
      eyegazeProvider,
      allowReadProgress,
      allowReadReports,
      allowNotes,
      shareMonitorNotesWithInstitute,
      generateSymbols,
      useApprovedSymbols,
      useUnapprovedSymbols,
      dynamicBoardsEnabled,
      appConfig,
      permittedWebsites,
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
      setChatAgentPrompt(aac?.chatAgentPrompt || DEFAULT_AAC_PROMPT);
      setAutoAacPrompt(aac?.autoAacPrompt || '');
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
      setSingleGlyphButtons(aac?.singleGlyphButtons ?? false);
      setStartupMode(aac?.startupMode ?? 0);
      setEyegazeEnabled(aac?.eyegazeEnabled ?? false);
      setEyegazeTimeout(aac?.eyegazeTimeout ?? 2000);
      setEyegazeProvider(aac?.eyegazeProvider ?? 'mouse');
      setAllowReadProgress(aac?.allowReadProgress ?? true);
      setAllowReadReports(aac?.allowReadReports ?? true);
      setAllowNotes(aac?.allowNotes ?? true);
      setShareMonitorNotesWithInstitute(aac?.shareMonitorNotesWithInstitute ?? true);
      setGenerateSymbols(aac?.generateSymbols ?? false);
      setUseApprovedSymbols(aac?.useApprovedSymbols ?? false);
      setDynamicBoardsEnabled(aac?.dynamicBoardsEnabled ?? false);
      setUseUnapprovedSymbols(aac?.useUnapprovedSymbols ?? false);
      setAppConfig(aac?.appConfig || {});
      setPermittedWebsites(Array.isArray(aac?.permittedWebsites) ? aac.permittedWebsites : []);
      setPermittedYoutubeItems(resolvePermittedYoutubeItems(aac));
      const accR = aac?.accessibility || {};
      setAccessFontSize(accR.fontSize ?? 100);
      setAccessHighContrast(accR.highContrast ?? false);
      setAccessReduceAnimations(accR.reduceAnimations ?? false);
      setAccessEnhancedFocus(accR.enhancedFocusIndicator ?? false);
    }
  };

  const handleResetToDefault = () => {
    setChatAgentPrompt(DEFAULT_AAC_PROMPT);
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

  return (
    <ScrollArea className="h-full">
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
            </CardContent>
          </Card>

          {/* AI Name */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <User className="w-5 h-5" />
                {t('aacSettings.aiName')}
              </CardTitle>
              <CardDescription>
                {t('aacSettings.aiNameDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Input
                value={aiName}
                onChange={(e) => setAiName(e.target.value)}
                placeholder={t('aacSettings.aiNamePlaceholder')}
                className="max-w-sm"
              />
            </CardContent>
          </Card>

          {/* Voice Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Volume2 className="w-5 h-5" />
                {t('aacSettings.voiceSettings')}
              </CardTitle>
              <CardDescription>
                {t('aacSettings.voiceSettingsDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Gemini Voice Settings */}
              <div className="space-y-4">
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

              {/* ElevenLabs Direct Voice Settings */}
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

                <div className={elevenlabsEnabled ? '' : 'opacity-50 pointer-events-none'}>
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
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground w-full md:w-[280px]">{t('aacSettings.elevenlabsNoVoices')}</p>
                      )}
                    </div>

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
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground w-full md:w-[280px]">{t('aacSettings.elevenlabsNoVoices')}</p>
                      )}
                    </div>
                  </>
                )}

                {!debouncedApiKey && (
                  <>
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
          </Card>

          {/* Icon-Text Ratio */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <LayoutGrid className="w-5 h-5" />
                {t('aacSettings.buttonSize')}
              </CardTitle>
              <CardDescription>
                {t('aacSettings.buttonSizeDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>

          {/* Startup Mode */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="w-5 h-5" />
                {t('aacSettings.startupMode')}
              </CardTitle>
              <CardDescription>
                {t('aacSettings.startupModeDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-3 justify-center">
                {([
                  { mode: 0, tKey: 'aacSettings.startupFast' as const, icon: Zap },
                  { mode: 1, tKey: 'aacSettings.startupThorough' as const, icon: Search },
                ] as const).map(({ mode, tKey, icon: Icon }) => {
                  const isActive = startupMode === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setStartupMode(mode)}
                      className={cn(
                        "flex flex-col items-center justify-center px-6 py-3 rounded-lg border-2 transition-all min-w-[120px]",
                        isActive
                          ? "border-primary bg-primary/10 ring-2 ring-primary/30"
                          : "border-border hover:border-primary/50 bg-card"
                      )}
                    >
                      <Icon className="w-6 h-6 mb-1" />
                      <span className="text-sm font-medium">{t(tKey)}</span>
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground text-center mt-3">
                {startupMode === 0 && t('aacSettings.startupFastDesc')}
                {startupMode === 1 && t('aacSettings.startupThoroughDesc')}
              </p>
            </CardContent>
          </Card>

          {/* Eyegaze / Dwell Selection */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Crosshair className="w-5 h-5" />
                {t('aacSettings.eyegaze')}
              </CardTitle>
              <CardDescription>
                {t('aacSettings.eyegazeDesc')}
              </CardDescription>
            </CardHeader>
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
          </Card>

          {/* Accessibility */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Accessibility className="w-5 h-5" />
                {t('settings.accessibility')}
              </CardTitle>
              <CardDescription>
                {t('settings.accessibilityDesc')}
              </CardDescription>
            </CardHeader>
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
            </CardContent>
          </Card>

          {/* Privacy */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="w-5 h-5" />
                {t('aacSettings.privacy')}
              </CardTitle>
              <CardDescription>
                {t('aacSettings.privacyDesc')}
              </CardDescription>
            </CardHeader>
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
          </Card>

          {/* Symbol Generation Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ImageIcon className="w-5 h-5" />
                {t('aacSettings.symbolGeneration')}
              </CardTitle>
              <CardDescription>
                {t('aacSettings.symbolGenerationDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">
                    {t('aacSettings.generateSymbols')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.generateSymbolsDesc')}
                  </p>
                </div>
                <Switch
                  checked={generateSymbols}
                  onCheckedChange={setGenerateSymbols}
                />
              </div>
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
          </Card>

          {/* Custom Apps (Games) Assignment */}
          {student?.id && <AACSettingsCustomApps studentId={student.id} />}

          {/* Dynamic Boards */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('aacSettings.dynamicBoards') || 'Dynamic Boards'}</CardTitle>
              <CardDescription>
                {t('aacSettings.dynamicBoardsDesc') || 'Allow the AI to create and edit AAC boards based on the situation.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">
                    {t('aacSettings.dynamicBoardsEnabled') || 'Enable Dynamic Boards'}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.dynamicBoardsEnabledDesc') || 'When enabled, the AI monitor can generate situation-specific boards during AAC sessions.'}
                  </p>
                </div>
                <Switch
                  checked={dynamicBoardsEnabled}
                  onCheckedChange={setDynamicBoardsEnabled}
                />
              </div>
            </CardContent>
          </Card>

          {/* Chat Agent Prompt */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="w-5 h-5" />
                {t('aacSettings.chatBehavior')}
              </CardTitle>
              <CardDescription>
                {t('aacSettings.chatBehaviorDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="chatPrompt" className="text-base font-medium">
                  {t('aacSettings.systemPrompt')}
                </Label>
                <Textarea
                  id="chatPrompt"
                  value={chatAgentPrompt}
                  onChange={(e) => setChatAgentPrompt(e.target.value)}
                  placeholder={t('aacSettings.systemPromptPlaceholder')}
                  className="min-h-[200px] font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  {t('aacSettings.systemPromptHint')}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleResetToDefault}
                className="text-xs"
              >
                <RotateCcw className="w-3 h-3 me-1" />
                {t('aacSettings.resetToDefault')}
              </Button>

              {/* Auto-generated context — AI-owned digest, shown read-only. The
                  assistant keeps this current as it learns about the student. */}
              <div className="space-y-2 border-t pt-4">
                <Label className="text-base font-medium flex items-center gap-2">
                  <Sparkles className="w-4 h-4" />
                  {t('aacSettings.autoPromptLabel')}
                </Label>
                <Textarea
                  value={autoAacPrompt}
                  readOnly
                  placeholder={t('aacSettings.autoPromptEmpty')}
                  className="min-h-[140px] font-mono text-sm bg-muted/50"
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {t('aacSettings.autoPromptHint')}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setAutoAacPrompt('')}
                    disabled={!autoAacPrompt}
                    className="text-xs shrink-0"
                  >
                    <Trash2 className="w-3 h-3 me-1" />
                    {t('aacSettings.clearAutoPrompt')}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Permitted YouTube Content (channels, playlists, videos) */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="text-xl">▶️</span>
                {t('aacSettings.permittedYoutubeContentTitle')}
              </CardTitle>
              <CardDescription>{t('aacSettings.permittedYoutubeContentDescription')}</CardDescription>
            </CardHeader>
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
          </Card>

          {/* Permitted Websites */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Globe className="w-5 h-5" />
                {t('aacSettings.permittedWebsitesTitle')}
              </CardTitle>
              <CardDescription>{t('aacSettings.permittedWebsitesDescription')}</CardDescription>
            </CardHeader>
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
          </Card>

          {/* Apps */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AppWindow className="w-5 h-5" />
                {t('aacSettings.apps')}
              </CardTitle>
              <CardDescription>{t('aacSettings.appsDescription')}</CardDescription>
            </CardHeader>
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

              {/* Social Trainer */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">🧑‍🤝‍🧑</span>
                  <div>
                    <Label className="text-sm font-medium">{t('aacSettings.appSocialTrainer')}</Label>
                    <p className="text-xs text-muted-foreground">{t('aacSettings.appSocialTrainerDesc')}</p>
                  </div>
                </div>
                <Switch
                  checked={appConfig.social_trainer?.enabled ?? false}
                  onCheckedChange={(checked) =>
                    setAppConfig(prev => ({ ...prev, social_trainer: { ...prev.social_trainer, enabled: checked } }))
                  }
                />
              </div>
            </CardContent>
          </Card>

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
