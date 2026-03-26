import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, User, Save, Volume2, MessageSquare, LogOut, Sun, Moon, Crosshair, LayoutGrid, Brain, Zap, Search, RotateCcw, RefreshCw, Target, Play, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "@/contexts/ThemeContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { LanguageSelector } from "@/components/LanguageSelector";

import type { EyeGazeProviderType } from "@/lib/eyegaze/types";
import { useEyeTrackingDwell } from "@/contexts/EyeTrackingDwellContext";

export interface EyegazeSettings {
  enabled: boolean;
  provider: EyeGazeProviderType | "auto";
  timeout: number;
}

interface UserSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  studentId: string;
  userProfile: any;
  onProfileUpdate: (profile: any) => void;
  debugMode?: boolean;
  onDebugModeChange?: (enabled: boolean) => void;
  onEyegazeChange?: (settings: EyegazeSettings) => void;
  onRestartSession?: () => void;
}

const DEFAULT_AAC_PROMPT = `You are an advanced conversational AI designed to assist AAC (Augmentative and Alternative Communication) users.
You should:
- Respond in a friendly, supportive manner
- Keep responses concise and clear
- Help expand on the user's symbol selections to form complete thoughts
- Ask clarifying questions when needed
- Be patient and encouraging`;

export default function UserSettings({
  isOpen,
  onClose,
  studentId,
  userProfile,
  onProfileUpdate,
  debugMode = false,
  onDebugModeChange,
  onEyegazeChange,
  onRestartSession,
}: UserSettingsProps) {
  const { t, isRTL, direction } = useLanguage();
  const { theme, setTheme } = useTheme();
  const { toast } = useToast();
  const { startCalibration, isCalibrated, isCalibrating } = useEyeTrackingDwell();
  const queryClient = useQueryClient();

  // AI identity
  const [aiName, setAiName] = useState("");

  // Voice settings
  const [customVoiceId, setCustomVoiceId] = useState<string | null>(null);
  const [customStudentVoiceId, setCustomStudentVoiceId] = useState<string | null>(null);
  const [geminiAiVoice, setGeminiAiVoice] = useState("");
  const [geminiStudentVoice, setGeminiStudentVoice] = useState("");
  const [elevenlabsEnabled, setElevenlabsEnabled] = useState(true);
  const [elevenlabsApiKey, setElevenlabsApiKey] = useState("");
  const [elevenlabsAiVoiceId, setElevenlabsAiVoiceId] = useState("");
  const [elevenlabsStudentVoiceId, setElevenlabsStudentVoiceId] = useState("");

  // Fetch active ElevenLabs voices
  const { data: activeVoices } = useQuery({
    queryKey: ['/api/voices/active'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/voices/active');
      const data = await res.json();
      return data.voices as Array<{ id: string; name: string; externalId: string; source: string }>;
    },
  });

  // Fetch ElevenLabs voices when API key is present
  const [debouncedApiKey, setDebouncedApiKey] = useState("");
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

  // Board settings
  const [iconTextRatio, setIconTextRatio] = useState(3);
  const [interpretationLevel, setInterpretationLevel] = useState(2);
  const [startupMode, setStartupMode] = useState(0);

  // Chat agent
  const [chatAgentPrompt, setChatAgentPrompt] = useState("");
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);

  // Eyegaze (stored in DB)
  const [eyegazeEnabled, setEyegazeEnabled] = useState(false);
  const [eyegazeTimeout, setEyegazeTimeout] = useState(2000);
  const [eyegazeProvider, setEyegazeProvider] = useState<EyeGazeProviderType | "auto">("auto");

  // Track whether restart-required settings have changed since last save
  const [needsRestart, setNeedsRestart] = useState(false);
  const savedValuesRef = useRef<Record<string, any>>({});

  // Show restart confirmation dialog
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);

  // Voice preview state
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const previewVoice = useCallback(async (voiceId: string) => {
    if (!voiceId || !debouncedApiKey) return;
    if (previewingVoice) return;
    setPreviewingVoice(voiceId);
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: {
          "xi-api-key": debouncedApiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: t("settings.elevenlabsTestPhrase"),
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      });
      if (!res.ok) throw new Error(`ElevenLabs error ${res.status}`);
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
  }, [debouncedApiKey, previewingVoice, t]);

  // Load from student profile (AAC settings are nested under aacSettings)
  useEffect(() => {
    if (userProfile) {
      const aac = userProfile.aacSettings;
      setAiName(aac?.aiName || "");
      setCustomVoiceId(aac?.customVoiceId || null);
      setCustomStudentVoiceId(aac?.customStudentVoiceId || null);
      setGeminiAiVoice(aac?.geminiAiVoice || "");
      setGeminiStudentVoice(aac?.geminiStudentVoice || "");
      setElevenlabsEnabled(aac?.elevenlabsEnabled !== false);
      setElevenlabsApiKey(aac?.elevenlabsApiKey || "");
      setElevenlabsAiVoiceId(aac?.elevenlabsAiVoiceId || "");
      setElevenlabsStudentVoiceId(aac?.elevenlabsStudentVoiceId || "");
      const itr = aac?.iconTextRatio ?? 3;
      const il = aac?.interpretationLevel ?? 2;
      const sm = aac?.startupMode ?? 0;
      const cap = aac?.chatAgentPrompt || DEFAULT_AAC_PROMPT;
      const ee = aac?.eyegazeEnabled ?? false;
      const et = aac?.eyegazeTimeout ?? 2000;
      const ep = aac?.eyegazeProvider ?? "auto";

      setIconTextRatio(itr);
      setInterpretationLevel(il);
      setStartupMode(sm);
      setChatAgentPrompt(cap);
      setEyegazeEnabled(ee);
      setEyegazeTimeout(et);
      setEyegazeProvider(ep);

      // Store saved values for dirty detection
      savedValuesRef.current = { il, sm, cap };
      setNeedsRestart(false);
    }
  }, [userProfile]);

  // Push eyegaze changes live to parent (no save required)
  useEffect(() => {
    onEyegazeChange?.({ enabled: eyegazeEnabled, provider: eyegazeProvider, timeout: eyegazeTimeout });
  }, [eyegazeEnabled, eyegazeTimeout, eyegazeProvider, onEyegazeChange]);

  // Check if restart-required settings changed
  const checkRestartNeeded = () => {
    const saved = savedValuesRef.current;
    return (
      interpretationLevel !== saved.il ||
      startupMode !== saved.sm ||
      chatAgentPrompt !== saved.cap
    );
  };

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: async (userData: any) => {
      return apiRequest("PATCH", `/api/students/${studentId}`, userData);
    },
    onSuccess: async (response) => {
      const result = await response.json();
      // API returns { success, message, student } — extract the student object
      const updatedProfile = result.student || result;
      onProfileUpdate(updatedProfile);
      queryClient.invalidateQueries({ queryKey: [`/api/students/${studentId}`] });
      toast({
        title: t("settings.settingsUpdated"),
        description: t("settings.settingsUpdatedDescription"),
      });

      // Check if restart-required settings changed
      if (checkRestartNeeded()) {
        setShowRestartConfirm(true);
      } else {
        onClose();
      }

      // Update saved values reference
      savedValuesRef.current = {
        il: interpretationLevel,
        sm: startupMode,
        cap: chatAgentPrompt,
      };
      setNeedsRestart(false);
    },
    onError: (error: any) => {
      toast({
        title: t("common.error"),
        description: error.message || t("settings.errorUpdating"),
        variant: "destructive",
      });
    },
  });

  // Logout — client-side only (does NOT destroy the server session,
  // so the admin client stays logged in)
  const handleLogout = () => {
    queryClient.clear();
    localStorage.removeItem('synapse_user_profile');
    localStorage.removeItem('synapse_user_id');
    localStorage.setItem('aac_signed_out', 'true');
    window.location.reload();
  };

  const handleSave = () => {
    updateMutation.mutate({
      aiName: aiName.trim() || undefined,
      customVoiceId,
      customStudentVoiceId,
      geminiAiVoice: geminiAiVoice || undefined,
      geminiStudentVoice: geminiStudentVoice || undefined,
      elevenlabsEnabled,
      elevenlabsApiKey: elevenlabsApiKey.trim() || undefined,
      elevenlabsAiVoiceId: elevenlabsAiVoiceId.trim() || undefined,
      elevenlabsStudentVoiceId: elevenlabsStudentVoiceId.trim() || undefined,
      iconTextRatio,
      interpretationLevel,
      startupMode,
      chatAgentPrompt: chatAgentPrompt.trim() || undefined,
      eyegazeEnabled,
      eyegazeTimeout,
      eyegazeProvider,
    });
  };

  const handleResetDefaults = () => {
    if (!window.confirm(t("settings.confirmResetDefaults"))) return;
    setAiName("");
    setCustomVoiceId(null);
    setCustomStudentVoiceId(null);
    setGeminiAiVoice("");
    setGeminiStudentVoice("");
    setElevenlabsApiKey("");
    setElevenlabsAiVoiceId("");
    setElevenlabsStudentVoiceId("");
    setIconTextRatio(3);
    setInterpretationLevel(2);
    setStartupMode(0);
    setChatAgentPrompt(DEFAULT_AAC_PROMPT);
    setEyegazeEnabled(false);
    setEyegazeTimeout(2000);
    setEyegazeProvider("auto");
  };

  const handleRestartConfirm = () => {
    setShowRestartConfirm(false);
    onClose();
    onRestartSession?.();
  };

  const handleRestartDismiss = () => {
    setShowRestartConfirm(false);
    onClose();
  };

  const buttonSizeDescs = [
    t("settings.buttonSizeExtraLarge"),
    t("settings.buttonSizeLarge"),
    t("settings.buttonSizeBalanced"),
    t("settings.buttonSizeSmall"),
    t("settings.buttonSizeMinimal"),
  ];

  const interpretLevels = [
    { level: 0, label: t("settings.interpretNone"), short: '0' },
    { level: 1, label: t("settings.interpretMinimal"), short: '1' },
    { level: 2, label: t("settings.interpretBalanced"), short: '2' },
    { level: 3, label: t("settings.interpretCreative"), short: '3' },
    { level: 4, label: t("settings.interpretAuto"), short: '4' },
  ];

  const interpretDescs = [
    t("settings.interpretDesc0"),
    t("settings.interpretDesc1"),
    t("settings.interpretDesc2"),
    t("settings.interpretDesc3"),
    t("settings.interpretDesc4"),
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-40"
            onClick={onClose}
          />

          {/* Settings Panel — data-dwell-trap prevents dwell selection outside */}
          <motion.div
            data-dwell-trap
            initial={{ opacity: 0, x: isRTL ? "100%" : "-100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: isRTL ? "100%" : "-100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className={`fixed ${isRTL ? "right-0" : "left-0"} top-0 h-full w-full max-w-md bg-white dark:bg-gray-900 shadow-2xl z-50 overflow-y-auto`}
            dir={direction}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-3">
                <User className="w-6 h-6 text-blue-600" />
                <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
                  {t("settings.title")}
                </h2>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              >
                <X className="w-5 h-5" />
              </Button>
            </div>

            {/* Content */}
            <div className="p-6 space-y-6">
              {/* Language & Theme */}
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-sm font-medium">{t("settings.language")}</Label>
                  <LanguageSelector
                    variant="full"
                    className="w-full justify-start text-gray-900 dark:text-white hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800"
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-sm font-medium flex items-center gap-2">
                    {theme === "dark" ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
                    {t("settings.appearance")}
                  </Label>
                  <div className="flex gap-2">
                    <Button
                      variant={theme === "light" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setTheme("light")}
                      className="flex-1 flex items-center justify-center gap-2"
                    >
                      <Sun className="w-4 h-4" />
                      {t("settings.light")}
                    </Button>
                    <Button
                      variant={theme === "dark" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setTheme("dark")}
                      className="flex-1 flex items-center justify-center gap-2"
                    >
                      <Moon className="w-4 h-4" />
                      {t("settings.dark")}
                    </Button>
                  </div>
                </div>
              </div>

              {/* AI Name */}
              <div className="space-y-2 pt-4 border-t border-gray-200 dark:border-gray-700">
                <Label className="text-sm font-medium">{t("aacSettings.aiName")}</Label>
                <input
                  type="text"
                  value={aiName}
                  onChange={(e) => setAiName(e.target.value)}
                  placeholder={t("aacSettings.aiNamePlaceholder")}
                  className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"
                />
                <p className="text-xs text-gray-500">{t("aacSettings.aiNameDesc")}</p>
              </div>

              {/* Voice Settings */}
              <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <Volume2 className="h-5 w-5" />
                  {t("settings.voiceSettings")}
                </h3>

                {activeVoices && activeVoices.length > 0 && (
                  <>
                    <div className="space-y-2">
                      <Label className="text-sm font-medium text-gray-500">{t("settings.customStudentVoice")}</Label>
                      <Select
                        value={customStudentVoiceId || "_none"}
                        onValueChange={(v) => setCustomStudentVoiceId(v === "_none" ? null : v)}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="_none">{t("settings.noneFallback")}</SelectItem>
                          {activeVoices.map((v) => (
                            <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-gray-500">{t("settings.customStudentVoiceHint")}</p>
                    </div>

                    <div className="space-y-2">
                      <Label className="text-sm font-medium text-gray-500">{t("settings.customAiVoice")}</Label>
                      <Select
                        value={customVoiceId || "_none"}
                        onValueChange={(v) => setCustomVoiceId(v === "_none" ? null : v)}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="_none">{t("settings.noneFallback")}</SelectItem>
                          {activeVoices.map((v) => (
                            <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-gray-500">{t("settings.customAiVoiceHint")}</p>
                    </div>
                  </>
                )}

                {/* Gemini Voice Settings */}
                <div className="space-y-3 mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
                  <Label className="text-sm font-semibold">{t("settings.geminiVoice")}</Label>
                  <p className="text-xs text-gray-500">{t("settings.geminiVoiceDesc")}</p>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium text-gray-500">{t("settings.studentVoice")}</Label>
                    <Select value={geminiStudentVoice || "_default"} onValueChange={(v) => setGeminiStudentVoice(v === "_default" ? "" : v)}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Default" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_default">{t("settings.voiceDefault")}</SelectItem>
                        <SelectItem value="Puck">Puck — {t("settings.voicePuckDesc")}</SelectItem>
                        <SelectItem value="Charon">Charon — {t("settings.voiceCharonDesc")}</SelectItem>
                        <SelectItem value="Kore">Kore — {t("settings.voiceKoreDesc")}</SelectItem>
                        <SelectItem value="Fenrir">Fenrir — {t("settings.voiceFenrirDesc")}</SelectItem>
                        <SelectItem value="Aoede">Aoede — {t("settings.voiceAoedeDesc")}</SelectItem>
                        <SelectItem value="Leda">Leda — {t("settings.voiceLedaDesc")}</SelectItem>
                        <SelectItem value="Orus">Orus — {t("settings.voiceOrusDesc")}</SelectItem>
                        <SelectItem value="Zephyr">Zephyr — {t("settings.voiceZephyrDesc")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium text-gray-500">{t("settings.aiVoice")}</Label>
                    <Select value={geminiAiVoice || "_default"} onValueChange={(v) => setGeminiAiVoice(v === "_default" ? "" : v)}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Default" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_default">{t("settings.voiceDefault")}</SelectItem>
                        <SelectItem value="Puck">Puck — {t("settings.voicePuckDesc")}</SelectItem>
                        <SelectItem value="Charon">Charon — {t("settings.voiceCharonDesc")}</SelectItem>
                        <SelectItem value="Kore">Kore — {t("settings.voiceKoreDesc")}</SelectItem>
                        <SelectItem value="Fenrir">Fenrir — {t("settings.voiceFenrirDesc")}</SelectItem>
                        <SelectItem value="Aoede">Aoede — {t("settings.voiceAoedeDesc")}</SelectItem>
                        <SelectItem value="Leda">Leda — {t("settings.voiceLedaDesc")}</SelectItem>
                        <SelectItem value="Orus">Orus — {t("settings.voiceOrusDesc")}</SelectItem>
                        <SelectItem value="Zephyr">Zephyr — {t("settings.voiceZephyrDesc")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* ElevenLabs Direct Voice Settings */}
                <div className="space-y-3 mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-sm font-semibold">{t("settings.elevenlabsTitle")}</Label>
                      <p className="text-xs text-gray-500">{t("settings.elevenlabsDesc")}</p>
                    </div>
                    {(elevenlabsApiKey.trim() || elevenlabsAiVoiceId.trim() || elevenlabsStudentVoiceId.trim()) && (
                      <Switch checked={elevenlabsEnabled} onCheckedChange={setElevenlabsEnabled} />
                    )}
                  </div>

                  <div className={`space-y-3 ${!elevenlabsEnabled ? "opacity-50 pointer-events-none" : ""}`}>
                  <div className="space-y-2">
                    <Label className="text-xs font-medium text-gray-500">{t("settings.elevenlabsApiKey")}</Label>
                    <input
                      type="password"
                      value={elevenlabsApiKey}
                      onChange={(e) => setElevenlabsApiKey(e.target.value)}
                      placeholder={t("settings.elevenlabsApiKeyPlaceholder")}
                      className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"
                    />
                  </div>

                  {elevenlabsError && debouncedApiKey && (
                    <p className="text-xs text-red-500">{t("settings.elevenlabsInvalidKey")}</p>
                  )}

                  {debouncedApiKey && !elevenlabsError && (
                    <>
                      <div className="space-y-2">
                        <Label className="text-xs font-medium text-gray-500">{t("settings.elevenlabsStudentVoiceId")}</Label>
                        {elevenlabsLoading ? (
                          <p className="text-xs text-gray-400">{t("settings.elevenlabsLoadingVoices")}</p>
                        ) : elevenlabsVoices && elevenlabsVoices.length > 0 ? (
                          <div className="flex gap-2 items-center">
                            <Select
                              value={elevenlabsStudentVoiceId || "_none"}
                              onValueChange={(v) => setElevenlabsStudentVoiceId(v === "_none" ? "" : v)}
                            >
                              <SelectTrigger className="w-full">
                                <SelectValue placeholder={t("settings.elevenlabsSelectVoice")} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="_none">{t("settings.elevenlabsSelectVoice")}</SelectItem>
                                {elevenlabsVoices.map((v) => (
                                  <SelectItem key={v.voice_id} value={v.voice_id}>
                                    {v.name} {v.category ? `(${v.category})` : ""}
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
                                title={t("settings.elevenlabsTestVoice")}
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
                          <p className="text-xs text-gray-400">{t("settings.elevenlabsNoVoices")}</p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label className="text-xs font-medium text-gray-500">{t("settings.elevenlabsAiVoiceId")}</Label>
                        {elevenlabsLoading ? (
                          <p className="text-xs text-gray-400">{t("settings.elevenlabsLoadingVoices")}</p>
                        ) : elevenlabsVoices && elevenlabsVoices.length > 0 ? (
                          <div className="flex gap-2 items-center">
                            <Select
                              value={elevenlabsAiVoiceId || "_none"}
                              onValueChange={(v) => setElevenlabsAiVoiceId(v === "_none" ? "" : v)}
                            >
                              <SelectTrigger className="w-full">
                                <SelectValue placeholder={t("settings.elevenlabsSelectVoice")} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="_none">{t("settings.elevenlabsSelectVoice")}</SelectItem>
                                {elevenlabsVoices.map((v) => (
                                  <SelectItem key={v.voice_id} value={v.voice_id}>
                                    {v.name} {v.category ? `(${v.category})` : ""}
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
                                title={t("settings.elevenlabsTestVoice")}
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
                          <p className="text-xs text-gray-400">{t("settings.elevenlabsNoVoices")}</p>
                        )}
                      </div>
                    </>
                  )}

                  {!debouncedApiKey && (
                    <>
                      <div className="space-y-2">
                        <Label className="text-xs font-medium text-gray-500">{t("settings.elevenlabsStudentVoiceId")}</Label>
                        <input
                          type="text"
                          value={elevenlabsStudentVoiceId}
                          onChange={(e) => setElevenlabsStudentVoiceId(e.target.value)}
                          placeholder={t("settings.elevenlabsVoiceIdPlaceholder")}
                          className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm font-mono"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label className="text-xs font-medium text-gray-500">{t("settings.elevenlabsAiVoiceId")}</Label>
                        <input
                          type="text"
                          value={elevenlabsAiVoiceId}
                          onChange={(e) => setElevenlabsAiVoiceId(e.target.value)}
                          placeholder={t("settings.elevenlabsVoiceIdPlaceholder")}
                          className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm font-mono"
                        />
                      </div>
                    </>
                  )}
                  </div>
                </div>
              </div>

              {/* Button Size */}
              <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <LayoutGrid className="h-5 w-5" />
                  {t("settings.buttonSize")}
                </h3>
                <div className="flex gap-3 justify-center">
                  {([1, 2, 3, 4, 5] as const).map((lvl) => {
                    const isActive = iconTextRatio === lvl;
                    const emojiSize = ['text-2xl', 'text-xl', 'text-lg', 'text-base', 'text-sm'][lvl - 1];
                    const labelSize = ['text-[6px]', 'text-[7px]', 'text-[8px]', 'text-[9px]', 'text-xs'][lvl - 1];
                    const iconFlex = [9, 4, 3, 2, 1][lvl - 1];
                    const textFlex = [1, 1, 1, 1, 2][lvl - 1];
                    return (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => setIconTextRatio(lvl)}
                        className={`flex flex-col items-center justify-center w-14 h-18 rounded-lg border-2 transition-all ${
                          isActive
                            ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30 ring-2 ring-blue-300"
                            : "border-gray-200 dark:border-gray-600 hover:border-blue-300"
                        }`}
                      >
                        <div className="flex items-center justify-center w-full" style={{ flex: iconFlex }}>
                          <span className={`${emojiSize} leading-none`}>😊</span>
                        </div>
                        <div className="flex items-center justify-center w-full overflow-hidden" style={{ flex: textFlex }}>
                          <span className={`${labelSize} font-medium text-center leading-tight`}>Hello</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-gray-500 text-center">
                  {buttonSizeDescs[iconTextRatio - 1]}
                </p>
              </div>

              {/* Interpretation Level */}
              <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <Brain className="h-5 w-5" />
                  {t("settings.interpretationLevel")}
                </h3>
                <div className="flex gap-2 justify-center">
                  {interpretLevels.map(({ level, label, short }) => {
                    const isActive = interpretationLevel === level;
                    return (
                      <button
                        key={level}
                        type="button"
                        onClick={() => setInterpretationLevel(level)}
                        className={`flex flex-col items-center justify-center px-3 py-2 rounded-lg border-2 transition-all min-w-[56px] ${
                          isActive
                            ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30 ring-2 ring-blue-300"
                            : "border-gray-200 dark:border-gray-600 hover:border-blue-300"
                        }`}
                      >
                        <span className="text-lg font-bold">{short}</span>
                        <span className="text-[9px] font-medium text-gray-500">{label}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-gray-500 text-center">
                  {interpretDescs[interpretationLevel]}
                </p>
              </div>

              {/* Startup Mode */}
              <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <Zap className="h-5 w-5" />
                  {t("settings.startupMode")}
                </h3>
                <div className="flex gap-3 justify-center">
                  {([
                    { mode: 0 as const, label: t("settings.startupFast"), Icon: Zap },
                    { mode: 1 as const, label: t("settings.startupThorough"), Icon: Search },
                  ]).map(({ mode, label, Icon }) => {
                    const isActive = startupMode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setStartupMode(mode)}
                        className={`flex flex-col items-center justify-center px-6 py-3 rounded-lg border-2 transition-all min-w-[110px] ${
                          isActive
                            ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30 ring-2 ring-blue-300"
                            : "border-gray-200 dark:border-gray-600 hover:border-blue-300"
                        }`}
                      >
                        <Icon className="w-6 h-6 mb-1" />
                        <span className="text-sm font-medium">{label}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-gray-500 text-center">
                  {startupMode === 0 ? t("settings.startupFastDesc") : t("settings.startupThoroughDesc")}
                </p>
              </div>

              {/* Eyegaze / Dwell Selection */}
              <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <Crosshair className="h-5 w-5" />
                  {t("settings.eyegazeSelection")}
                </h3>

                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label htmlFor="eyegazeEnabled" className="text-sm font-medium">
                      {t("settings.enableEyegaze")}
                    </Label>
                    <p className="text-xs text-gray-500">
                      {t("settings.enableEyegazeHint")}
                    </p>
                  </div>
                  <Switch
                    id="eyegazeEnabled"
                    checked={eyegazeEnabled}
                    onCheckedChange={setEyegazeEnabled}
                  />
                </div>

                {eyegazeEnabled && (
                  <div className="space-y-3 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                    {/* Provider selection */}
                    <div className="space-y-1">
                      <Label className="text-sm font-medium">{t("settings.inputSource")}</Label>
                      <Select value={eyegazeProvider} onValueChange={(v) => setEyegazeProvider(v as EyeGazeProviderType | "auto")}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">{t("settings.inputSourceAuto")}</SelectItem>
                          <SelectItem value="mouse">{t("settings.inputSourceCursor")}</SelectItem>
                          <SelectItem value="camera">{t("settings.inputSourceCamera")}</SelectItem>
                          <SelectItem value="tobii">{t("settings.inputSourceTobii")}</SelectItem>
                          <SelectItem value="eyetech">{t("settings.inputSourceEyetech")}</SelectItem>
                          <SelectItem value="lctech">{t("settings.inputSourceLctech")}</SelectItem>
                          <SelectItem value="gazepoint">{t("settings.inputSourceGazepoint")}</SelectItem>
                          <SelectItem value="webhid">{t("settings.inputSourceWebhid")}</SelectItem>
                        </SelectContent>
                      </Select>
                      {eyegazeProvider === "mouse" && (
                        <p className="text-xs text-blue-600 dark:text-blue-400">
                          {t("settings.inputSourceCursorHint")}
                        </p>
                      )}
                    </div>

                    {/* Dwell timeout */}
                    <div className="flex justify-between items-center">
                      <Label className="text-sm font-medium">
                        {t("settings.selectionTimeout")}
                      </Label>
                      <span className="text-sm text-gray-500">{eyegazeTimeout / 1000}s</span>
                    </div>
                    <Slider
                      min={1000}
                      max={10000}
                      step={500}
                      value={[eyegazeTimeout]}
                      onValueChange={(v) => setEyegazeTimeout(v[0])}
                      className="w-full"
                    />
                    <div className="flex justify-between text-xs text-gray-500">
                      <span>1s</span>
                      <span>2s</span>
                      <span>5s</span>
                      <span>10s</span>
                    </div>
                    <p className="text-xs text-blue-600 dark:text-blue-400">
                      {t("settings.eyegazeTip", { seconds: String(eyegazeTimeout / 1000) })}
                    </p>

                    {/* Recalibrate button — only for camera provider */}
                    {eyegazeProvider !== "mouse" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          onClose();
                          setTimeout(() => startCalibration(), 300);
                        }}
                        disabled={isCalibrating}
                        className="w-full flex items-center gap-2"
                      >
                        <Target className="w-4 h-4" />
                        {isCalibrating ? t("calibration.calibrating") : isCalibrated ? t("calibration.recalibrate") : t("calibration.calibrate")}
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {/* Chat Agent Behavior */}
              <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <MessageSquare className="h-5 w-5" />
                  {t("settings.chatAgentBehavior")}
                </h3>

                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">{t("settings.systemPrompt")}</Label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setIsEditingPrompt(!isEditingPrompt)}
                  >
                    {isEditingPrompt ? t("common.cancel") : t("common.edit")}
                  </Button>
                </div>

                {isEditingPrompt ? (
                  <div className="space-y-3">
                    <Textarea
                      value={chatAgentPrompt}
                      onChange={(e) => setChatAgentPrompt(e.target.value)}
                      placeholder={t("settings.agentPromptPlaceholder")}
                      className="min-h-[120px] text-sm"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setChatAgentPrompt(DEFAULT_AAC_PROMPT)}
                    >
                      <RotateCcw className="w-3 h-3 mr-1" />
                      {t("settings.resetToDefault")}
                    </Button>
                  </div>
                ) : (
                  <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-md">
                    <p className="text-sm text-gray-600 dark:text-gray-300 line-clamp-3">
                      {chatAgentPrompt || t("settings.defaultConversationBehavior")}
                    </p>
                  </div>
                )}
              </div>

              {/* Debug Mode */}
              <div className="space-y-3 pt-4 border-t border-gray-200 dark:border-gray-700">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label htmlFor="debugMode" className="text-sm font-medium">
                      {t("settings.debugMode")}
                    </Label>
                    <p className="text-xs text-gray-500">
                      {t("settings.debugModeDescription")}
                    </p>
                  </div>
                  <Switch
                    id="debugMode"
                    checked={debugMode}
                    onCheckedChange={onDebugModeChange}
                  />
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col gap-3 pt-4">
                <Button
                  onClick={handleSave}
                  disabled={updateMutation.isPending}
                  className="w-full flex items-center gap-2"
                >
                  <Save className="w-4 h-4" />
                  {updateMutation.isPending ? t("settings.saving") : t("settings.saveSettings")}
                </Button>

                <Button
                  variant="outline"
                  onClick={() => {
                    if (window.confirm(t("settings.restartSessionHint") + "?")) {
                      onClose();
                      onRestartSession?.();
                    }
                  }}
                  className="w-full flex items-center gap-2"
                >
                  <RefreshCw className="w-4 h-4" />
                  {t("settings.restartSession")}
                </Button>

                <Button
                  variant="outline"
                  onClick={handleResetDefaults}
                  className="w-full flex items-center gap-2"
                >
                  <RotateCcw className="w-4 h-4" />
                  {t("settings.resetDefaults")}
                </Button>

                <Button
                  variant="secondary"
                  onClick={() => {
                    if (window.confirm(t("settings.confirmLogout"))) {
                      handleLogout();
                    }
                  }}
                  className="w-full flex items-center gap-2"
                >
                  <LogOut className="w-4 h-4" />
                  {t("common.logout")}
                </Button>
              </div>

              {/* User ID */}
              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                <Label className="text-xs text-gray-500">{t("settings.userId")}</Label>
                <p className="text-xs text-gray-400 font-mono break-all">{studentId}</p>
              </div>
            </div>
          </motion.div>

          {/* Restart Confirmation Dialog */}
          <AnimatePresence>
            {showRestartConfirm && (
              <>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 bg-black/60 z-[60]"
                  onClick={handleRestartDismiss}
                />
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-6 z-[61] w-[90vw] max-w-sm"
                  dir={direction}
                >
                  <h3 className="text-lg font-semibold mb-3 text-gray-900 dark:text-white">
                    {t("settings.restartSession")}
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-300 mb-5">
                    {t("settings.confirmRestart")}
                  </p>
                  <div className="flex gap-3">
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={handleRestartDismiss}
                    >
                      {t("common.no")}
                    </Button>
                    <Button
                      className="flex-1"
                      onClick={handleRestartConfirm}
                    >
                      <RefreshCw className="w-4 h-4 mr-1" />
                      {t("common.yes")}
                    </Button>
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </>
      )}
    </AnimatePresence>
  );
}
