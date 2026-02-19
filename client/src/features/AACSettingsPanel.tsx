import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useStudent } from '@/hooks/useStudent';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { apiRequest } from '@/lib/queryClient';
import { useActiveVoices } from '@/hooks/useAdminData';
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

// Voice option keys — labels resolved via t() at render time
const STUDENT_VOICE_KEYS = [
  { value: 'boy', tKey: 'aacSettings.voiceBoy' },
  { value: 'girl', tKey: 'aacSettings.voiceGirl' },
  { value: 'man', tKey: 'aacSettings.voiceMan' },
  { value: 'woman', tKey: 'aacSettings.voiceWoman' },
] as const;

const AI_VOICE_KEYS = [
  { value: 'auto', tKey: 'aacSettings.voiceAuto' },
  { value: 'man', tKey: 'aacSettings.voiceMan' },
  { value: 'woman', tKey: 'aacSettings.voiceWoman' },
  { value: 'boy', tKey: 'aacSettings.voiceBoy' },
  { value: 'girl', tKey: 'aacSettings.voiceGirl' },
] as const;

export function AACSettingsPanel({ isOpen = true, onClose }: AACSettingsPanelProps) {
  const { student, refetchStudent } = useStudent();
  const { isRTL, t } = useLanguage();
  const { theme } = useTheme();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isDark = theme === 'dark';
  const { data: activeVoices } = useActiveVoices();

  // Form state
  const [aiName, setAiName] = useState('');
  const [chatAgentPrompt, setChatAgentPrompt] = useState('');
  const [voiceType, setVoiceType] = useState('auto');
  const [studentVoiceType, setStudentVoiceType] = useState('boy');
  const [customVoiceId, setCustomVoiceId] = useState<string | null>(null);
  const [customStudentVoiceId, setCustomStudentVoiceId] = useState<string | null>(null);
  const [elevenlabsApiKey, setElevenlabsApiKey] = useState('');
  const [elevenlabsAiVoiceId, setElevenlabsAiVoiceId] = useState('');
  const [elevenlabsStudentVoiceId, setElevenlabsStudentVoiceId] = useState('');
  const [iconTextRatio, setIconTextRatio] = useState(3);
  const [interpretationLevel, setInterpretationLevel] = useState(2);
  const [startupMode, setStartupMode] = useState(0);
  const [eyegazeEnabled, setEyegazeEnabled] = useState(false);
  const [eyegazeTimeout, setEyegazeTimeout] = useState(2000);
  const [hasChanges, setHasChanges] = useState(false);

  // Load student data into form (AAC settings are nested under aacSettings)
  useEffect(() => {
    if (student) {
      const aac = (student as any).aacSettings;
      setAiName(aac?.aiName || '');
      setChatAgentPrompt(aac?.chatAgentPrompt || DEFAULT_AAC_PROMPT);
      setVoiceType(aac?.voiceType || 'auto');
      setStudentVoiceType(aac?.studentVoiceType || 'boy');
      setCustomVoiceId(aac?.customVoiceId || null);
      setCustomStudentVoiceId(aac?.customStudentVoiceId || null);
      setElevenlabsApiKey(aac?.elevenlabsApiKey || '');
      setElevenlabsAiVoiceId(aac?.elevenlabsAiVoiceId || '');
      setElevenlabsStudentVoiceId(aac?.elevenlabsStudentVoiceId || '');
      setIconTextRatio(aac?.iconTextRatio ?? 3);
      setInterpretationLevel(aac?.interpretationLevel ?? 2);
      setStartupMode(aac?.startupMode ?? 0);
      setEyegazeEnabled(aac?.eyegazeEnabled ?? false);
      setEyegazeTimeout(aac?.eyegazeTimeout ?? 2000);
      setHasChanges(false);
    }
  }, [student]);

  // Track changes
  useEffect(() => {
    if (student) {
      const aac = (student as any).aacSettings;
      const originalAiName = aac?.aiName || '';
      const originalPrompt = aac?.chatAgentPrompt || DEFAULT_AAC_PROMPT;
      const originalVoice = aac?.voiceType || 'auto';
      const originalStudentVoice = aac?.studentVoiceType || 'boy';
      const originalCustomVoice = aac?.customVoiceId || null;
      const originalCustomStudentVoice = aac?.customStudentVoiceId || null;
      const originalElevenlabsApiKey = aac?.elevenlabsApiKey || '';
      const originalElevenlabsAiVoiceId = aac?.elevenlabsAiVoiceId || '';
      const originalElevenlabsStudentVoiceId = aac?.elevenlabsStudentVoiceId || '';
      const originalIconTextRatio = aac?.iconTextRatio ?? 3;
      const originalInterpretationLevel = aac?.interpretationLevel ?? 2;
      const originalStartupMode = aac?.startupMode ?? 0;
      const originalEyegazeEnabled = aac?.eyegazeEnabled ?? false;
      const originalEyegazeTimeout = aac?.eyegazeTimeout ?? 2000;
      setHasChanges(
        aiName !== originalAiName ||
        chatAgentPrompt !== originalPrompt ||
        voiceType !== originalVoice ||
        studentVoiceType !== originalStudentVoice ||
        customVoiceId !== originalCustomVoice ||
        customStudentVoiceId !== originalCustomStudentVoice ||
        elevenlabsApiKey !== originalElevenlabsApiKey ||
        elevenlabsAiVoiceId !== originalElevenlabsAiVoiceId ||
        elevenlabsStudentVoiceId !== originalElevenlabsStudentVoiceId ||
        iconTextRatio !== originalIconTextRatio ||
        interpretationLevel !== originalInterpretationLevel ||
        startupMode !== originalStartupMode ||
        eyegazeEnabled !== originalEyegazeEnabled ||
        eyegazeTimeout !== originalEyegazeTimeout
      );
    }
  }, [aiName, chatAgentPrompt, voiceType, studentVoiceType, customVoiceId, customStudentVoiceId, elevenlabsApiKey, elevenlabsAiVoiceId, elevenlabsStudentVoiceId, iconTextRatio, interpretationLevel, startupMode, eyegazeEnabled, eyegazeTimeout, student]);

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: async (data: {
      aiName?: string;
      chatAgentPrompt: string;
      voiceType: string;
      studentVoiceType: string;
      customVoiceId: string | null;
      customStudentVoiceId: string | null;
      elevenlabsApiKey?: string;
      elevenlabsAiVoiceId?: string;
      elevenlabsStudentVoiceId?: string;
      iconTextRatio: number;
      interpretationLevel: number;
      startupMode: number;
      eyegazeEnabled: boolean;
      eyegazeTimeout: number;
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
      voiceType,
      studentVoiceType,
      customVoiceId,
      customStudentVoiceId,
      elevenlabsApiKey: elevenlabsApiKey.trim() || undefined,
      elevenlabsAiVoiceId: elevenlabsAiVoiceId.trim() || undefined,
      elevenlabsStudentVoiceId: elevenlabsStudentVoiceId.trim() || undefined,
      iconTextRatio,
      interpretationLevel,
      startupMode,
      eyegazeEnabled,
      eyegazeTimeout,
    });
  };

  const handleReset = () => {
    if (student) {
      const aac = (student as any).aacSettings;
      setAiName(aac?.aiName || '');
      setChatAgentPrompt(aac?.chatAgentPrompt || DEFAULT_AAC_PROMPT);
      setVoiceType(aac?.voiceType || 'auto');
      setStudentVoiceType(aac?.studentVoiceType || 'boy');
      setCustomVoiceId(aac?.customVoiceId || null);
      setCustomStudentVoiceId(aac?.customStudentVoiceId || null);
      setElevenlabsApiKey(aac?.elevenlabsApiKey || '');
      setElevenlabsAiVoiceId(aac?.elevenlabsAiVoiceId || '');
      setElevenlabsStudentVoiceId(aac?.elevenlabsStudentVoiceId || '');
      setIconTextRatio(aac?.iconTextRatio ?? 3);
      setInterpretationLevel(aac?.interpretationLevel ?? 2);
      setStartupMode(aac?.startupMode ?? 0);
      setEyegazeEnabled(aac?.eyegazeEnabled ?? false);
      setEyegazeTimeout(aac?.eyegazeTimeout ?? 2000);
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
        "p-6",
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
              <div className={cn(
                "flex items-center justify-between",
                isRTL && "flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
                  <Label className="text-base font-medium">
                    {t('aacSettings.studentVoice')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.studentVoiceDesc')}
                  </p>
                </div>
                <Select value={studentVoiceType} onValueChange={setStudentVoiceType}>
                  <SelectTrigger className="w-[200px]">
                    <SelectValue placeholder={t('aacSettings.selectVoice')} />
                  </SelectTrigger>
                  <SelectContent>
                    {STUDENT_VOICE_KEYS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {t(option.tKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {activeVoices && activeVoices.length > 0 && (
                <div className={cn(
                  "flex items-center justify-between",
                  isRTL && "flex-row-reverse"
                )}>
                  <div className={cn("space-y-0.5", isRTL && "text-right")}>
                    <Label className="text-sm text-muted-foreground">
                      {t('aacSettings.customStudentVoice')}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t('aacSettings.customStudentVoiceHint')}
                    </p>
                  </div>
                  <Select
                    value={customStudentVoiceId || "_none"}
                    onValueChange={(v) => setCustomStudentVoiceId(v === "_none" ? null : v)}
                  >
                    <SelectTrigger className="w-[200px]">
                      <SelectValue placeholder={t('common.none')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">{t('aacSettings.noneFallback')}</SelectItem>
                      {activeVoices.map((v) => (
                        <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className={cn(
                "flex items-center justify-between",
                isRTL && "flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
                  <Label className="text-base font-medium">
                    {t('aacSettings.aiVoice')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('aacSettings.aiVoiceDesc')}
                  </p>
                </div>
                <Select value={voiceType} onValueChange={setVoiceType}>
                  <SelectTrigger className="w-[200px]">
                    <SelectValue placeholder={t('aacSettings.selectVoice')} />
                  </SelectTrigger>
                  <SelectContent>
                    {AI_VOICE_KEYS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {t(option.tKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {activeVoices && activeVoices.length > 0 && (
                <div className={cn(
                  "flex items-center justify-between",
                  isRTL && "flex-row-reverse"
                )}>
                  <div className={cn("space-y-0.5", isRTL && "text-right")}>
                    <Label className="text-sm text-muted-foreground">
                      {t('aacSettings.customAiVoice')}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t('aacSettings.customAiVoiceHint')}
                    </p>
                  </div>
                  <Select
                    value={customVoiceId || "_none"}
                    onValueChange={(v) => setCustomVoiceId(v === "_none" ? null : v)}
                  >
                    <SelectTrigger className="w-[200px]">
                      <SelectValue placeholder={t('common.none')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">{t('aacSettings.noneFallback')}</SelectItem>
                      {activeVoices.map((v) => (
                        <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

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
                    className="w-[280px]"
                  />
                </div>

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
                    className="w-[280px] font-mono"
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
                    className="w-[280px] font-mono"
                  />
                </div>
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
              <div className="flex gap-3 justify-center">
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
                        "flex flex-col items-center justify-center w-16 h-20 rounded-lg border-2 transition-all",
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
              <div className="flex gap-2 justify-center">
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
                        "flex flex-col items-center justify-center px-3 py-2 rounded-lg border-2 transition-all min-w-[70px]",
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
                "flex items-center justify-between",
                isRTL && "flex-row-reverse"
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
