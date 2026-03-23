import { useState, useEffect, useRef, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStudent } from '@/hooks/useStudent';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { apiRequest } from '@/lib/queryClient';
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
  Brain,
  Zap,
  Search,
  Crosshair,
  Play,
  Shield,
  ImageIcon,
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
  const { isRTL, t } = useLanguage();
  const { theme } = useTheme();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isDark = theme === 'dark';


  // Form state
  const [aiName, setAiName] = useState('');
  const [chatAgentPrompt, setChatAgentPrompt] = useState('');
  const [elevenlabsApiKey, setElevenlabsApiKey] = useState('');
  const [elevenlabsAiVoiceId, setElevenlabsAiVoiceId] = useState('');
  const [elevenlabsStudentVoiceId, setElevenlabsStudentVoiceId] = useState('');
  const [geminiAiVoice, setGeminiAiVoice] = useState('');
  const [geminiStudentVoice, setGeminiStudentVoice] = useState('');
  const [iconTextRatio, setIconTextRatio] = useState(3);
  const [interpretationLevel, setInterpretationLevel] = useState(2);
  const [startupMode, setStartupMode] = useState(0);
  const [eyegazeEnabled, setEyegazeEnabled] = useState(false);
  const [eyegazeTimeout, setEyegazeTimeout] = useState(2000);
  const [allowReadProgress, setAllowReadProgress] = useState(true);
  const [allowReadReports, setAllowReadReports] = useState(true);
  const [allowNotes, setAllowNotes] = useState(true);
  const [generateSymbols, setGenerateSymbols] = useState(false);
  const [useApprovedSymbols, setUseApprovedSymbols] = useState(false);
  const [useUnapprovedSymbols, setUseUnapprovedSymbols] = useState(false);
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

  // Load student data into form (AAC settings are nested under aacSettings)
  useEffect(() => {
    if (student) {
      const aac = (student as any).aacSettings;
      setAiName(aac?.aiName || '');
      setChatAgentPrompt(aac?.chatAgentPrompt || DEFAULT_AAC_PROMPT);
      setElevenlabsApiKey(aac?.elevenlabsApiKey || '');
      setElevenlabsAiVoiceId(aac?.elevenlabsAiVoiceId || '');
      setElevenlabsStudentVoiceId(aac?.elevenlabsStudentVoiceId || '');
      setGeminiAiVoice(aac?.geminiAiVoice || '');
      setGeminiStudentVoice(aac?.geminiStudentVoice || '');
      setIconTextRatio(aac?.iconTextRatio ?? 3);
      setInterpretationLevel(aac?.interpretationLevel ?? 2);
      setStartupMode(aac?.startupMode ?? 0);
      setEyegazeEnabled(aac?.eyegazeEnabled ?? false);
      setEyegazeTimeout(aac?.eyegazeTimeout ?? 2000);
      setAllowReadProgress(aac?.allowReadProgress ?? true);
      setAllowReadReports(aac?.allowReadReports ?? true);
      setAllowNotes(aac?.allowNotes ?? true);
      setGenerateSymbols(aac?.generateSymbols ?? false);
      setUseApprovedSymbols(aac?.useApprovedSymbols ?? false);
      setUseUnapprovedSymbols(aac?.useUnapprovedSymbols ?? false);
      setHasChanges(false);
    }
  }, [student]);

  // Track changes
  useEffect(() => {
    if (student) {
      const aac = (student as any).aacSettings;
      const originalAiName = aac?.aiName || '';
      const originalPrompt = aac?.chatAgentPrompt || DEFAULT_AAC_PROMPT;
      const originalElevenlabsApiKey = aac?.elevenlabsApiKey || '';
      const originalElevenlabsAiVoiceId = aac?.elevenlabsAiVoiceId || '';
      const originalElevenlabsStudentVoiceId = aac?.elevenlabsStudentVoiceId || '';
      const originalGeminiAiVoice = aac?.geminiAiVoice || '';
      const originalGeminiStudentVoice = aac?.geminiStudentVoice || '';
      const originalIconTextRatio = aac?.iconTextRatio ?? 3;
      const originalInterpretationLevel = aac?.interpretationLevel ?? 2;
      const originalStartupMode = aac?.startupMode ?? 0;
      const originalEyegazeEnabled = aac?.eyegazeEnabled ?? false;
      const originalEyegazeTimeout = aac?.eyegazeTimeout ?? 2000;
      const originalAllowReadProgress = aac?.allowReadProgress ?? true;
      const originalAllowReadReports = aac?.allowReadReports ?? true;
      const originalAllowNotes = aac?.allowNotes ?? true;
      const originalGenerateSymbols = aac?.generateSymbols ?? false;
      const originalUseApprovedSymbols = aac?.useApprovedSymbols ?? false;
      const originalUseUnapprovedSymbols = aac?.useUnapprovedSymbols ?? false;
      setHasChanges(
        aiName !== originalAiName ||
        chatAgentPrompt !== originalPrompt ||
        elevenlabsApiKey !== originalElevenlabsApiKey ||
        elevenlabsAiVoiceId !== originalElevenlabsAiVoiceId ||
        elevenlabsStudentVoiceId !== originalElevenlabsStudentVoiceId ||
        geminiAiVoice !== originalGeminiAiVoice ||
        geminiStudentVoice !== originalGeminiStudentVoice ||
        iconTextRatio !== originalIconTextRatio ||
        interpretationLevel !== originalInterpretationLevel ||
        startupMode !== originalStartupMode ||
        eyegazeEnabled !== originalEyegazeEnabled ||
        eyegazeTimeout !== originalEyegazeTimeout ||
        allowReadProgress !== originalAllowReadProgress ||
        allowReadReports !== originalAllowReadReports ||
        allowNotes !== originalAllowNotes ||
        generateSymbols !== originalGenerateSymbols ||
        useApprovedSymbols !== originalUseApprovedSymbols ||
        useUnapprovedSymbols !== originalUseUnapprovedSymbols
      );
    }
  }, [aiName, chatAgentPrompt, elevenlabsApiKey, elevenlabsAiVoiceId, elevenlabsStudentVoiceId, geminiAiVoice, geminiStudentVoice, iconTextRatio, interpretationLevel, startupMode, eyegazeEnabled, eyegazeTimeout, allowReadProgress, allowReadReports, allowNotes, generateSymbols, useApprovedSymbols, useUnapprovedSymbols, student]);

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: async (data: {
      aiName?: string;
      chatAgentPrompt: string;
      voiceType?: string;
      studentVoiceType?: string;
      customVoiceId?: string | null;
      customStudentVoiceId?: string | null;
      elevenlabsApiKey?: string;
      elevenlabsAiVoiceId?: string;
      elevenlabsStudentVoiceId?: string;
      geminiAiVoice?: string;
      geminiStudentVoice?: string;
      iconTextRatio: number;
      interpretationLevel: number;
      startupMode: number;
      eyegazeEnabled: boolean;
      eyegazeTimeout: number;
      allowReadProgress: boolean;
      allowReadReports: boolean;
      allowNotes: boolean;
      generateSymbols: boolean;
      useApprovedSymbols: boolean;
      useUnapprovedSymbols: boolean;
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
      elevenlabsApiKey: elevenlabsApiKey.trim() || undefined,
      elevenlabsAiVoiceId: elevenlabsAiVoiceId.trim() || undefined,
      elevenlabsStudentVoiceId: elevenlabsStudentVoiceId.trim() || undefined,
      geminiAiVoice: geminiAiVoice || undefined,
      geminiStudentVoice: geminiStudentVoice || undefined,
      iconTextRatio,
      interpretationLevel,
      startupMode,
      eyegazeEnabled,
      eyegazeTimeout,
      allowReadProgress,
      allowReadReports,
      allowNotes,
      generateSymbols,
      useApprovedSymbols,
      useUnapprovedSymbols,
    });
  };

  const handleReset = () => {
    if (student) {
      const aac = (student as any).aacSettings;
      setAiName(aac?.aiName || '');
      setChatAgentPrompt(aac?.chatAgentPrompt || DEFAULT_AAC_PROMPT);
      setElevenlabsApiKey(aac?.elevenlabsApiKey || '');
      setElevenlabsAiVoiceId(aac?.elevenlabsAiVoiceId || '');
      setElevenlabsStudentVoiceId(aac?.elevenlabsStudentVoiceId || '');
      setGeminiAiVoice(aac?.geminiAiVoice || '');
      setGeminiStudentVoice(aac?.geminiStudentVoice || '');
      setIconTextRatio(aac?.iconTextRatio ?? 3);
      setInterpretationLevel(aac?.interpretationLevel ?? 2);
      setStartupMode(aac?.startupMode ?? 0);
      setEyegazeEnabled(aac?.eyegazeEnabled ?? false);
      setEyegazeTimeout(aac?.eyegazeTimeout ?? 2000);
      setAllowReadProgress(aac?.allowReadProgress ?? true);
      setAllowReadReports(aac?.allowReadReports ?? true);
      setAllowNotes(aac?.allowNotes ?? true);
      setGenerateSymbols(aac?.generateSymbols ?? false);
      setUseApprovedSymbols(aac?.useApprovedSymbols ?? false);
      setUseUnapprovedSymbols(aac?.useUnapprovedSymbols ?? false);
    }
  };

  const handleResetToDefault = () => {
    setChatAgentPrompt(DEFAULT_AAC_PROMPT);
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
          <div className={isRTL ? "text-right" : ""}>
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
              <CardTitle className={cn(
                "flex items-center gap-2 text-base",
                isRTL && "flex-row-reverse"
              )}>
                <User className="w-4 h-4" />
                {t('aacSettings.currentStudent')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className={cn(
                "flex items-center gap-3",
                isRTL && "flex-row-reverse"
              )}>
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <User className="w-5 h-5 text-primary" />
                </div>
                <div className={cn("flex-1", isRTL && "text-right")}>
                  <p className="font-medium">{student.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {student.gender === 'male' ? t('aacSettings.genderMale') : student.gender === 'female' ? t('aacSettings.genderFemale') : t('aacSettings.genderNotSpecified')}
                    {student.birthDate && ` • ${t('aacSettings.yearsOld').replace('{age}', String(new Date().getFullYear() - new Date(student.birthDate).getFullYear()))}`}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* AI Name */}
          <Card>
            <CardHeader>
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
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
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
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
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
                  <Label className="text-base font-medium">{t('aacSettings.voiceSettings')}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.geminiVoiceDesc')}
                  </p>
                </div>

                <div className={cn("flex items-center justify-between", isRTL && "flex-row-reverse")}>
                  <Label className="text-sm text-muted-foreground">{t('aacSettings.aiVoice')}</Label>
                  <Select value={geminiAiVoice || "_default"} onValueChange={(v) => setGeminiAiVoice(v === "_default" ? "" : v)}>
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

                <div className={cn("flex items-center justify-between", isRTL && "flex-row-reverse")}>
                  <Label className="text-sm text-muted-foreground">{t('aacSettings.studentVoice')}</Label>
                  <Select value={geminiStudentVoice || "_default"} onValueChange={(v) => setGeminiStudentVoice(v === "_default" ? "" : v)}>
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

              {/* ElevenLabs Direct Voice Settings */}
              <div className="pt-4 border-t space-y-4">
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
                  <Label className="text-base font-medium">
                    {t('aacSettings.elevenlabsTitle')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.elevenlabsDesc')}
                  </p>
                </div>

                <div className={cn(
                  "flex items-center justify-between",
                  isRTL && "flex-row-reverse"
                )}>
                  <div className={cn("space-y-0.5", isRTL && "text-right")}>
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
                    <div className={cn(
                      "flex items-center justify-between",
                      isRTL && "flex-row-reverse"
                    )}>
                      <div className={cn("space-y-0.5", isRTL && "text-right")}>
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

                    <div className={cn(
                      "flex items-center justify-between",
                      isRTL && "flex-row-reverse"
                    )}>
                      <div className={cn("space-y-0.5", isRTL && "text-right")}>
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
                  </>
                )}

                {!debouncedApiKey && (
                  <>
                    <div className={cn(
                      "flex items-center justify-between",
                      isRTL && "flex-row-reverse"
                    )}>
                      <div className={cn("space-y-0.5", isRTL && "text-right")}>
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

                    <div className={cn(
                      "flex items-center justify-between",
                      isRTL && "flex-row-reverse"
                    )}>
                      <div className={cn("space-y-0.5", isRTL && "text-right")}>
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
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Icon-Text Ratio */}
          <Card>
            <CardHeader>
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
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
            </CardContent>
          </Card>

          {/* Interpretation Level */}
          <Card>
            <CardHeader>
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
                <Brain className="w-5 h-5" />
                {t('aacSettings.interpretation')}
              </CardTitle>
              <CardDescription>
                {t('aacSettings.interpretationDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2 justify-center flex-wrap">
                {([
                  { level: 0, tKey: 'aacSettings.interpNone' as const, short: '0' },
                  { level: 1, tKey: 'aacSettings.interpMinimal' as const, short: '1' },
                  { level: 2, tKey: 'aacSettings.interpConservative' as const, short: '2' },
                  { level: 3, tKey: 'aacSettings.interpCreative' as const, short: '3' },
                  { level: 4, tKey: 'aacSettings.interpAutonomous' as const, short: '4' },
                ] as const).map(({ level, tKey, short }) => {
                  const isActive = interpretationLevel === level;
                  return (
                    <button
                      key={level}
                      type="button"
                      onClick={() => setInterpretationLevel(level)}
                      className={cn(
                        "flex flex-col items-center justify-center px-3 py-2 rounded-lg border-2 transition-all min-w-[56px] md:min-w-[70px]",
                        isActive
                          ? "border-primary bg-primary/10 ring-2 ring-primary/30"
                          : "border-border hover:border-primary/50 bg-card"
                      )}
                    >
                      <span className="text-lg font-bold">{short}</span>
                      <span className="text-[10px] font-medium text-muted-foreground">{t(tKey)}</span>
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground text-center mt-3">
                {interpretationLevel === 0 && t('aacSettings.interpNoneDesc')}
                {interpretationLevel === 1 && t('aacSettings.interpMinimalDesc')}
                {interpretationLevel === 2 && t('aacSettings.interpConservativeDesc')}
                {interpretationLevel === 3 && t('aacSettings.interpCreativeDesc')}
                {interpretationLevel === 4 && t('aacSettings.interpAutonomousDesc')}
              </p>
            </CardContent>
          </Card>

          {/* Startup Mode */}
          <Card>
            <CardHeader>
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
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
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
                <Crosshair className="w-5 h-5" />
                {t('aacSettings.eyegaze')}
              </CardTitle>
              <CardDescription>
                {t('aacSettings.eyegazeDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className={cn(
                "flex flex-col gap-2 md:flex-row md:items-center md:justify-between",
                isRTL && "md:flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
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
              )}
            </CardContent>
          </Card>

          {/* Privacy */}
          <Card>
            <CardHeader>
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
                <Shield className="w-5 h-5" />
                {t('aacSettings.privacy')}
              </CardTitle>
              <CardDescription>
                {t('aacSettings.privacyDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className={cn(
                "flex flex-col gap-2 md:flex-row md:items-center md:justify-between",
                isRTL && "md:flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
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
              <div className={cn(
                "flex flex-col gap-2 md:flex-row md:items-center md:justify-between",
                isRTL && "md:flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
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
              <div className={cn(
                "flex flex-col gap-2 md:flex-row md:items-center md:justify-between",
                isRTL && "md:flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
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
            </CardContent>
          </Card>

          {/* Symbol Generation Settings */}
          <Card>
            <CardHeader>
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
                <ImageIcon className="w-5 h-5" />
                {t('aacSettings.symbolGeneration')}
              </CardTitle>
              <CardDescription>
                {t('aacSettings.symbolGenerationDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className={cn(
                "flex flex-col gap-2 md:flex-row md:items-center md:justify-between",
                isRTL && "md:flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
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
              <div className={cn(
                "flex flex-col gap-2 md:flex-row md:items-center md:justify-between",
                isRTL && "md:flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
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
              <div className={cn(
                "flex flex-col gap-2 md:flex-row md:items-center md:justify-between",
                isRTL && "md:flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
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

          {/* Chat Agent Prompt */}
          <Card>
            <CardHeader>
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
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
                <RotateCcw className="w-3 h-3 mr-1" />
                {t('aacSettings.resetToDefault')}
              </Button>
            </CardContent>
          </Card>

          {/* Action Buttons */}
          <div className={cn(
            "flex gap-3 pt-2",
            isRTL ? "flex-row-reverse" : ""
          )}>
            <Button
              onClick={handleSave}
              disabled={!hasChanges || updateMutation.isPending}
              className="flex-1"
            >
              {updateMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              {t('aacSettings.saveChanges')}
            </Button>
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={!hasChanges || updateMutation.isPending}
            >
              <RotateCcw className="w-4 h-4 mr-2" />
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
