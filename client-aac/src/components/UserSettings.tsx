import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, User, Save, Volume2, LogOut, Sun, Moon, Crosshair, LayoutGrid, Zap, Search, RotateCcw, RefreshCw, Accessibility } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "@/contexts/ThemeContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { LanguageSelector } from "@/components/LanguageSelector";

import type { EyeGazeProviderType } from "@/lib/eyegaze/types";

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
  const queryClient = useQueryClient();

  // AI identity
  const [aiName, setAiName] = useState("");

  // Voice settings
  const [customVoiceId, setCustomVoiceId] = useState<string | null>(null);
  const [customStudentVoiceId, setCustomStudentVoiceId] = useState<string | null>(null);
  const [geminiAiVoice, setGeminiAiVoice] = useState("");
  const [geminiStudentVoice, setGeminiStudentVoice] = useState("");
  const [useLocalTts, setUseLocalTts] = useState(false);
  const [elevenlabsEnabled, setElevenlabsEnabled] = useState(true);
  const [elevenlabsAiVoiceId, setElevenlabsAiVoiceId] = useState("");
  const [elevenlabsStudentVoiceId, setElevenlabsStudentVoiceId] = useState("");
  const [aiVoicePitch, setAiVoicePitch] = useState(0);
  const [studentVoicePitch, setStudentVoicePitch] = useState(0);

  // Fetch active ElevenLabs voices
  const { data: activeVoices } = useQuery({
    queryKey: ['/api/voices/active'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/voices/active');
      const data = await res.json();
      return data.voices as Array<{ id: string; name: string; externalId: string; source: string }>;
    },
  });

  // Board settings
  const [iconTextRatio, setIconTextRatio] = useState(3);
  const [startupMode, setStartupMode] = useState(0);

  // Eyegaze (stored in DB)
  const [eyegazeEnabled, setEyegazeEnabled] = useState(false);
  const [eyegazeTimeout, setEyegazeTimeout] = useState(2000);
  const [eyegazeProvider, setEyegazeProvider] = useState<EyeGazeProviderType | "auto">("mouse");

  // Accessibility (stored in DB as JSON blob)
  const [accessFontSize, setAccessFontSize] = useState(100);
  const [accessHighContrast, setAccessHighContrast] = useState(false);
  const [accessReduceAnimations, setAccessReduceAnimations] = useState(false);
  const [accessEnhancedFocus, setAccessEnhancedFocus] = useState(false);

  // Track whether restart-required settings have changed since last save
  const [needsRestart, setNeedsRestart] = useState(false);
  const savedValuesRef = useRef<Record<string, any>>({});

  // Show restart confirmation dialog
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);

  // Load from student profile (AAC settings are nested under aacSettings)
  useEffect(() => {
    if (userProfile) {
      const aac = userProfile.aacSettings;
      setAiName(aac?.aiName || "");
      setCustomVoiceId(aac?.customVoiceId || null);
      setCustomStudentVoiceId(aac?.customStudentVoiceId || null);
      setGeminiAiVoice(aac?.geminiAiVoice || "");
      setGeminiStudentVoice(aac?.geminiStudentVoice || "");
      setUseLocalTts(aac?.useLocalTts ?? false);
      setElevenlabsEnabled(aac?.elevenlabsEnabled !== false);
      setElevenlabsAiVoiceId(aac?.elevenlabsAiVoiceId || "");
      setElevenlabsStudentVoiceId(aac?.elevenlabsStudentVoiceId || "");
      setAiVoicePitch(aac?.aiVoicePitch ?? 0);
      setStudentVoicePitch(aac?.studentVoicePitch ?? 0);
      const itr = aac?.iconTextRatio ?? 3;
      const sm = aac?.startupMode ?? 0;
      const ee = aac?.eyegazeEnabled ?? false;
      const et = aac?.eyegazeTimeout ?? 2000;
      const ep = aac?.eyegazeProvider ?? "mouse";

      setIconTextRatio(itr);
      setStartupMode(sm);
      setEyegazeEnabled(ee);
      setEyegazeTimeout(et);
      setEyegazeProvider(ep);

      const acc = aac?.accessibility || {};
      setAccessFontSize(acc.fontSize ?? 100);
      setAccessHighContrast(acc.highContrast ?? false);
      setAccessReduceAnimations(acc.reduceAnimations ?? false);
      setAccessEnhancedFocus(acc.enhancedFocusIndicator ?? false);

      // Store saved values for dirty detection
      savedValuesRef.current = { sm };
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
    return startupMode !== saved.sm;
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
        sm: startupMode,
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
      useLocalTts,
      elevenlabsEnabled,
      elevenlabsAiVoiceId: elevenlabsAiVoiceId.trim() || undefined,
      elevenlabsStudentVoiceId: elevenlabsStudentVoiceId.trim() || undefined,
      aiVoicePitch,
      studentVoicePitch,
      iconTextRatio,
      startupMode,
      eyegazeEnabled,
      eyegazeTimeout,
      eyegazeProvider,
      accessibility: {
        fontSize: accessFontSize,
        highContrast: accessHighContrast,
        reduceAnimations: accessReduceAnimations,
        enhancedFocusIndicator: accessEnhancedFocus,
      },
    });
  };

  const handleResetDefaults = () => {
    if (!window.confirm(t("settings.confirmResetDefaults"))) return;
    setAiName("");
    setCustomVoiceId(null);
    setCustomStudentVoiceId(null);
    setGeminiAiVoice("");
    setGeminiStudentVoice("");
    setUseLocalTts(false);
    setElevenlabsAiVoiceId("");
    setElevenlabsStudentVoiceId("");
    setAiVoicePitch(0);
    setStudentVoicePitch(0);
    setIconTextRatio(3);
    setStartupMode(0);
    setEyegazeEnabled(false);
    setEyegazeTimeout(2000);
    setEyegazeProvider("auto");
    setAccessFontSize(100);
    setAccessHighContrast(false);
    setAccessReduceAnimations(false);
    setAccessEnhancedFocus(false);
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

              {/* Accessibility */}
              <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <Accessibility className="h-5 w-5" />
                  {t("settings.accessibility")}
                </h3>

                {/* Font Size */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">{t("settings.fontSize")}</Label>
                    <span className="text-sm text-gray-500">{accessFontSize}%</span>
                  </div>
                  <Slider
                    min={75}
                    max={200}
                    step={25}
                    value={[accessFontSize]}
                    onValueChange={(v) => setAccessFontSize(v[0])}
                    className="w-full"
                  />
                  <p className="text-xs text-gray-500">{t("settings.fontSizeDesc")}</p>
                </div>

                {/* High Contrast */}
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label className="text-sm font-medium">{t("settings.contrastMode")}</Label>
                    <p className="text-xs text-gray-500">{t("settings.contrastModeDesc")}</p>
                  </div>
                  <Switch checked={accessHighContrast} onCheckedChange={setAccessHighContrast} />
                </div>

                {/* Reduce Animations */}
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label className="text-sm font-medium">{t("settings.reduceAnimations")}</Label>
                    <p className="text-xs text-gray-500">{t("settings.reduceAnimationsDesc")}</p>
                  </div>
                  <Switch checked={accessReduceAnimations} onCheckedChange={setAccessReduceAnimations} />
                </div>

                {/* Enhanced Focus Indicator */}
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label className="text-sm font-medium">{t("settings.enhancedFocus")}</Label>
                    <p className="text-xs text-gray-500">{t("settings.enhancedFocusDesc")}</p>
                  </div>
                  <Switch checked={accessEnhancedFocus} onCheckedChange={setAccessEnhancedFocus} />
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
                    <Select value={geminiStudentVoice || "_default"} onValueChange={(v) => { setGeminiStudentVoice(v === "_default" ? "" : v); if (v === "_default") setStudentVoicePitch(0); }}>
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
                    <Select value={geminiAiVoice || "_default"} onValueChange={(v) => { setGeminiAiVoice(v === "_default" ? "" : v); if (v === "_default") setAiVoicePitch(0); }}>
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

                {/* Voice Pitch Adjustment — only shown when at least one voice is explicitly set */}
                {(geminiStudentVoice || geminiAiVoice) && (
                <div className="space-y-3 mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
                  <Label className="text-sm font-semibold">{t("settings.voicePitch")}</Label>
                  <p className="text-xs text-gray-500">{t("settings.voicePitchDesc")}</p>

                  {geminiStudentVoice && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-medium text-gray-500">{t("settings.studentVoice")}</Label>
                      <span className="text-xs text-gray-500">{studentVoicePitch > 0 ? `+${studentVoicePitch}` : studentVoicePitch}</span>
                    </div>
                    <Slider
                      min={-6}
                      max={6}
                      step={1}
                      value={[studentVoicePitch]}
                      onValueChange={(v) => setStudentVoicePitch(v[0])}
                      className="w-full"
                    />
                  </div>
                  )}

                  {geminiAiVoice && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-medium text-gray-500">{t("settings.aiVoice")}</Label>
                      <span className="text-xs text-gray-500">{aiVoicePitch > 0 ? `+${aiVoicePitch}` : aiVoicePitch}</span>
                    </div>
                    <Slider
                      min={-6}
                      max={6}
                      step={1}
                      value={[aiVoicePitch]}
                      onValueChange={(v) => setAiVoicePitch(v[0])}
                      className="w-full"
                    />
                  </div>
                  )}
                </div>
                )}

                {/* Local Browser TTS */}
                <div className="space-y-2 mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-sm font-semibold">{t("settings.localTtsTitle")}</Label>
                      <p className="text-xs text-gray-500">{t("settings.localTtsDesc")}</p>
                    </div>
                    <Switch checked={useLocalTts} onCheckedChange={setUseLocalTts} />
                  </div>
                </div>

                {/* ElevenLabs Direct Voice Settings */}
                <div className="space-y-3 mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-sm font-semibold">{t("settings.elevenlabsTitle")}</Label>
                      <p className="text-xs text-gray-500">{t("settings.elevenlabsDesc")}</p>
                    </div>
                    {(elevenlabsAiVoiceId.trim() || elevenlabsStudentVoiceId.trim()) && (
                      <Switch checked={elevenlabsEnabled} onCheckedChange={setElevenlabsEnabled} />
                    )}
                  </div>

                  <div className={`space-y-3 ${!elevenlabsEnabled ? "opacity-50 pointer-events-none" : ""}`}>
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
                          <SelectItem value="mouse">{t("settings.inputSourceCursor")}</SelectItem>
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
