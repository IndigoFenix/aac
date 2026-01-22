import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, User, Save, Trash2, Camera, Volume2, MessageSquare, LogOut, Sun, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { CameraSelection } from "@/components/CameraSelection";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "@/contexts/ThemeContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { LanguageSelector } from "@/components/LanguageSelector";

interface UserSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  studentId: string;
  userProfile: any;
  onProfileUpdate: (profile: any) => void;
  debugMode?: boolean;
  onDebugModeChange?: (enabled: boolean) => void;
}

export default function UserSettings({
  isOpen,
  onClose,
  studentId,
  userProfile,
  onProfileUpdate,
  debugMode = false,
  onDebugModeChange
}: UserSettingsProps) {
  const { t, language, isRTL, direction } = useLanguage();
  const [name, setName] = useState("");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("male");
  const [preferences, setPreferences] = useState("");
  const [clinicalInfo, setClinicalInfo] = useState("");
  const [demoMode, setDemoMode] = useState(false);
  const [demoScenario, setDemoScenario] = useState("");
  const [therapyMode, setTherapyMode] = useState(false);
  const [signLanguageReading, setSignLanguageReading] = useState(false);
  const [usePcsSymbols, setUsePcsSymbols] = useState(false);
  const [audioMonitoring, setAudioMonitoring] = useState(true);
  const [chatgpt5Enabled, setChatgpt5Enabled] = useState(false);
  const [voiceType, setVoiceType] = useState("auto");
  const [chatAgentPrompt, setChatAgentPrompt] = useState("");
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);
  const [userType, setUserType] = useState("Individual");
  const [condition, setCondition] = useState("");
  const [audioSettings, setAudioSettings] = useState({
    speed: 1,
    volume: 80,
  });
  const [partsOfSpeechColors, setPartsOfSpeechColors] = useState(false);
  const [partsOfSpeechOrdering, setPartsOfSpeechOrdering] = useState("english");
  const [objectDetectionEnabled, setObjectDetectionEnabled] = useState(false);
  const [eyegazeEnabled, setEyegazeEnabled] = useState(false);
  const [eyegazeTimeout, setEyegazeTimeout] = useState(3000);

  const { theme, setTheme } = useTheme();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Load current profile data
  useEffect(() => {
    if (userProfile) {
      setName(userProfile.name || "");
      setAge(userProfile.age?.toString() || "");
      setGender(userProfile.gender || "male");
      setPreferences(userProfile.preferences || "");
      setClinicalInfo(userProfile.clinicalInfo || "");
      setDemoMode(userProfile.demoMode || false);
      setDemoScenario(userProfile.demoScenario || "You are demonstrating an AAC system to potential customers. The user is a child who wants to communicate about their day at school. Focus on school-related symbols like 'teacher', 'playground', 'lunch', 'friends', and 'learning'. Keep responses encouraging and educational, showing how the system helps with daily communication needs.");
      setTherapyMode(userProfile.therapyMode || false);
      setSignLanguageReading(userProfile.signLanguageReading || false);
      setUsePcsSymbols(userProfile.usePcsSymbols || false);
      setAudioMonitoring(userProfile.audioMonitoring !== undefined ? userProfile.audioMonitoring : true);
      setChatgpt5Enabled(userProfile.chatgpt5Enabled || false);
      setVoiceType(userProfile.voiceType || "auto");
      setChatAgentPrompt(userProfile.chatAgentPrompt || "You are an advanced conversational AI designed to engage with a human user in a dynamic, personalized, and continuously evolving conversation.");
      setUserType(userProfile.userType || userProfile.user_type || "Individual");
      setCondition(userProfile.condition || "");
      setPartsOfSpeechColors(userProfile.partsOfSpeechColors || false);
      setPartsOfSpeechOrdering(userProfile.partsOfSpeechOrdering || "english");
      setObjectDetectionEnabled(userProfile.objectDetectionEnabled || userProfile.object_detection_enabled || false);
      setEyegazeEnabled(userProfile.eyegazeEnabled || false);
      setEyegazeTimeout(userProfile.eyegazeTimeout || 3000);

    }
  }, [userProfile]);

  // Update user mutation using authenticated user
  const updateUserMutation = useMutation({
    mutationFn: async (userData: any) => {
      // Get current authenticated user first
      const userResponse = await apiRequest("GET", "/auth/user");
      const currentAuthUser = await userResponse.json();
      
      return apiRequest("PUT", `/api/students/${currentAuthUser.id}`, userData);
    },
    onSuccess: async (response) => {
      const updatedProfile = await response.json();
      onProfileUpdate(updatedProfile);
      
      // Invalidate auth cache to refresh user data
      queryClient.invalidateQueries({ queryKey: ["/auth/user"] });
      queryClient.invalidateQueries({ queryKey: [`/api/students/${studentId}`] });
      
      toast({
        title: t("settings.settingsUpdated"),
        description: t("settings.settingsUpdatedDescription"),
      });
      onClose();
    },
    onError: (error) => {
      console.error("Profile update error:", error);
      toast({
        title: t("common.error"),
        description: t("settings.errorUpdating"),
        variant: "destructive",
      });
    },
  });

  // Logout mutation
  const logoutMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/auth/logout");
      return response.json();
    },
    onSuccess: () => {
      // Clear all cached data
      queryClient.clear();
      // Clear any local storage
      localStorage.removeItem('synapse_user_profile');
      localStorage.removeItem('synapse_user_id');
      // Reload the page to reset authentication state
      window.location.reload();
    },
    onError: (error: any) => {
      toast({
        title: t("common.error"),
        description: error.message || t("settings.logoutError"),
        variant: "destructive",
      });
    },
  });

  // Delete user mutation
  const deleteUserMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("DELETE", `/api/students/${studentId}`);
    },
    onSuccess: () => {
      localStorage.removeItem('synapse_user_id');
      localStorage.removeItem('synapse_user_profile');
      
      toast({
        title: t("settings.profileDeleted"),
        description: t("settings.profileDeletedDescription"),
      });

      // Refresh page to reset state
      window.location.reload();
    },
    onError: (error) => {
      toast({
        title: t("common.error"),
        description: t("settings.errorDeleting"),
        variant: "destructive",
      });
    },
  });

  const handleSave = () => {
    const userData = {
      name: name.trim(),
      age: age ? parseInt(age) : undefined,
      gender: gender || undefined,
      preferences: preferences.trim() || undefined,
      clinicalInfo: clinicalInfo.trim() || undefined,
      demoMode: demoMode,
      demoScenario: demoScenario.trim() || undefined,
      therapyMode: therapyMode,
      signLanguageReading: signLanguageReading,
      usePcsSymbols: usePcsSymbols,
      audioMonitoring: audioMonitoring,
      chatgpt5Enabled: chatgpt5Enabled,
      voiceType: voiceType,
      chatAgentPrompt: chatAgentPrompt.trim() || undefined,
      userType: userType,
      condition: condition.trim() || undefined,
      partsOfSpeechColors: partsOfSpeechColors,
      partsOfSpeechOrdering: partsOfSpeechOrdering,
      objectDetectionEnabled: objectDetectionEnabled,
      eyegazeEnabled: eyegazeEnabled,
      eyegazeTimeout: eyegazeTimeout,

    };

    updateUserMutation.mutate(userData);
  };

  const handleDelete = () => {
    if (window.confirm(t("settings.confirmDelete"))) {
      deleteUserMutation.mutate();
    }
  };

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
          
          {/* Settings Panel */}
          <motion.div
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
              {/* Language Selector */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t("settings.language")}</Label>
                <LanguageSelector variant="full" className="w-full justify-start" />
              </div>

              {/* Name */}
              <div className="space-y-2">
                <Label htmlFor="name" className="text-sm font-medium">{t("settings.name")}</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("settings.namePlaceholder")}
                  className="w-full"
                />
              </div>

              {/* Age */}
              <div className="space-y-2">
                <Label htmlFor="age" className="text-sm font-medium">{t("settings.age")}</Label>
                <Input
                  id="age"
                  type="number"
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  placeholder={t("settings.agePlaceholder")}
                  min="1"
                  max="120"
                  className="w-full"
                />
              </div>

              {/* Gender */}
              <div className="space-y-2">
                <Label htmlFor="gender" className="text-sm font-medium">{t("settings.gender")}</Label>
                <Select value={gender} onValueChange={setGender}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t("settings.selectGender")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="male">{t("settings.male")}</SelectItem>
                    <SelectItem value="female">{t("settings.female")}</SelectItem>
                    <SelectItem value="other">{t("settings.other")}</SelectItem>
                    <SelectItem value="prefer-not-to-say">{t("settings.preferNotToSay")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Preferences */}
              <div className="space-y-2">
                <Label htmlFor="preferences" className="text-sm font-medium">
                  {t("settings.interests")}
                </Label>
                <Textarea
                  id="preferences"
                  value={preferences}
                  onChange={(e) => setPreferences(e.target.value)}
                  placeholder={t("settings.interestsPlaceholder")}
                  rows={3}
                  className="w-full resize-none"
                />
              </div>

              {/* Clinical Information */}
              <div className="space-y-2">
                <Label htmlFor="clinicalInfo" className="text-sm font-medium">
                  {t("settings.communicationNotes")}
                </Label>
                <Textarea
                  id="clinicalInfo"
                  value={clinicalInfo}
                  onChange={(e) => setClinicalInfo(e.target.value)}
                  placeholder={t("settings.communicationNotesPlaceholder")}
                  rows={3}
                  className="w-full resize-none"
                />
              </div>

              {/* User Type */}
              <div className="space-y-2">
                <Label htmlFor="userType" className="text-sm font-medium">{t("settings.userType")}</Label>
                <Select value={userType} onValueChange={setUserType}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t("settings.selectUserType")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Individual">{t("settings.individual")}</SelectItem>
                    <SelectItem value="Family">{t("settings.family")}</SelectItem>
                    <SelectItem value="School">{t("settings.school")}</SelectItem>
                    <SelectItem value="Healthcare">{t("settings.healthcare")}</SelectItem>
                    <SelectItem value="Enterprise">{t("settings.enterprise")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Condition */}
              <div className="space-y-2">
                <Label htmlFor="condition" className="text-sm font-medium">{t("settings.condition")}</Label>
                <Input
                  id="condition"
                  value={condition}
                  onChange={(e) => setCondition(e.target.value)}
                  placeholder={t("settings.conditionPlaceholder")}
                  className="w-full"
                />
              </div>

              {/* Theme Selector */}
              <div className="space-y-4 pt-6 border-t border-gray-200 dark:border-gray-700">
                <div className="space-y-2">
                  <Label className="text-sm font-medium flex items-center gap-2">
                    {theme === "dark" ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
                    {t("settings.appearance")}
                  </Label>
                  <p className="text-xs text-gray-500">
                    {t("settings.appearanceDescription")}
                  </p>
                </div>

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

              {/* Demo Mode Section */}
              <div className="space-y-4 pt-6 border-t border-gray-200 dark:border-gray-700">
                <div className="space-y-2">
                  <Label className="text-sm font-medium text-blue-600 dark:text-blue-400">
                    Demo Mode Settings
                  </Label>
                  <p className="text-xs text-gray-500">
                    Configure demonstration scenarios for customer presentations
                  </p>
                </div>

                {/* Demo Mode Toggle */}
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label htmlFor="demoMode" className="text-sm font-medium">
                      Enable Demo Mode
                    </Label>
                    <p className="text-xs text-gray-500">
                      Follow specific conversation scenarios for demonstrations
                    </p>
                  </div>
                  <Switch
                    id="demoMode"
                    checked={demoMode}
                    onCheckedChange={setDemoMode}
                  />
                </div>

                {/* Demo Scenario Input */}
                {demoMode && (
                  <div className="space-y-2">
                    <Label htmlFor="demoScenario" className="text-sm font-medium">
                      Demo Scenario Prompt
                    </Label>
                    <Textarea
                      id="demoScenario"
                      value={demoScenario}
                      onChange={(e) => setDemoScenario(e.target.value)}
                      placeholder="Describe the specific scenario for the demonstration..."
                      rows={4}
                      className="w-full resize-none text-sm"
                    />
                    <p className="text-xs text-gray-500">
                      This scenario will guide the AI conversation during demonstrations
                    </p>
                  </div>
                )}
              </div>

              {/* Camera Settings */}
              <div className="space-y-4">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <Camera className="h-5 w-5" />
                  {t("settings.cameraSettings")}
                </h3>
                <CameraSelection />


                {/* Sign Language Reading Toggle */}
                <div className="flex items-center space-x-3">
                  <Label htmlFor="signLanguageReading" className="text-sm font-medium flex-1">
                    {t("settings.signLanguageReading")}
                  </Label>
                  <Switch
                    id="signLanguageReading"
                    checked={signLanguageReading}
                    onCheckedChange={setSignLanguageReading}
                  />
                </div>
                <p className="text-xs text-gray-500">
                  {t("settings.signLanguageReadingHint")}
                </p>

                {/* PCS Symbols Toggle */}
                <div className="flex items-center space-x-3">
                  <Label htmlFor="usePcsSymbols" className="text-sm font-medium flex-1">
                    {t("settings.usePcsSymbols")}
                  </Label>
                  <Switch
                    id="usePcsSymbols"
                    checked={usePcsSymbols}
                    onCheckedChange={setUsePcsSymbols}
                  />
                </div>
                <p className="text-xs text-gray-500">
                  {t("settings.usePcsSymbolsHint")}
                </p>

                {/* Parts of Speech Color-Coding */}
                <div className="flex items-center space-x-3">
                  <Label htmlFor="partsOfSpeechColors" className="text-sm font-medium flex-1">
                    {t("settings.partsOfSpeechColors")}
                  </Label>
                  <Switch
                    id="partsOfSpeechColors"
                    checked={partsOfSpeechColors}
                    onCheckedChange={setPartsOfSpeechColors}
                  />
                </div>
                <p className="text-xs text-gray-500">
                  {t("settings.partsOfSpeechColorsHint")}
                </p>

                {/* Parts of Speech Language Ordering */}
                {partsOfSpeechColors && (
                  <div className={`${isRTL ? 'mr-4' : 'ml-4'} space-y-2`}>
                    <Label className="text-sm font-medium">
                      {t("settings.partsOfSpeechOrdering")}
                    </Label>
                    <Select value={partsOfSpeechOrdering} onValueChange={setPartsOfSpeechOrdering}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={t("settings.selectLanguageOrdering")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="english">
                          {t("settings.englishOrdering")}
                        </SelectItem>
                        <SelectItem value="hebrew">
                          {t("settings.hebrewOrdering")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-gray-500">
                      {t("settings.orderingHint")}
                    </p>
                  </div>
                )}
              </div>

              {/* Audio Settings */}
              <div className="space-y-4">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <Volume2 className="h-5 w-5" />
                  {t("settings.audioSettings")}
                </h3>
                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <Label className="text-sm font-medium">{t("settings.voiceSpeed")}</Label>
                      <span className="text-sm text-gray-500">{audioSettings.speed}x</span>
                    </div>
                    <Slider
                      value={[audioSettings.speed]}
                      onValueChange={(value) => setAudioSettings(prev => ({ ...prev, speed: value[0] }))}
                      min={0.5}
                      max={2}
                      step={0.1}
                      className="w-full"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <Label className="text-sm font-medium">{t("settings.volume")}</Label>
                      <span className="text-sm text-gray-500">{audioSettings.volume}%</span>
                    </div>
                    <Slider
                      value={[audioSettings.volume]}
                      onValueChange={(value) => setAudioSettings(prev => ({ ...prev, volume: value[0] }))}
                      min={0}
                      max={100}
                      step={5}
                      className="w-full"
                    />
                  </div>

                  {/* Voice Type Selector */}
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">
                      {t("settings.voiceType")}
                    </Label>
                    <Select value={voiceType} onValueChange={setVoiceType}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={t("settings.selectVoiceType")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">
                          {t("settings.voiceAuto")}
                        </SelectItem>
                        <SelectItem value="man">
                          {t("settings.voiceMan")}
                        </SelectItem>
                        <SelectItem value="woman">
                          {t("settings.voiceWoman")}
                        </SelectItem>
                        <SelectItem value="boy">
                          {t("settings.voiceBoy")}
                        </SelectItem>
                        <SelectItem value="girl">
                          {t("settings.voiceGirl")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-gray-500">
                      {t("settings.voiceTypeHint")}
                    </p>
                  </div>

                  <div className="flex items-center space-x-3">
                    <Label htmlFor="audioMonitoring" className="text-sm font-medium flex-1">
                      Audio Monitoring
                      <span className="text-xs bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 px-2 py-0.5 rounded-full font-medium ml-2">
                        BETA
                      </span>
                    </Label>
                    <Switch
                      id="audioMonitoring"
                      checked={audioMonitoring}
                      onCheckedChange={setAudioMonitoring}
                    />
                  </div>
                  <p className="text-xs text-gray-500">
                    Enable continuous ambient audio analysis for contextual awareness
                  </p>

                  <div className="flex items-center space-x-3">
                    <Label htmlFor="therapyMode" className="text-sm font-medium flex-1">
                      Therapy Mode
                    </Label>
                    <Switch
                      id="therapyMode"
                      checked={therapyMode}
                      onCheckedChange={setTherapyMode}
                    />
                  </div>
                  <p className="text-xs text-gray-500">
                    Enable enhanced speech therapy features
                  </p>

                  <div className="flex items-center space-x-3">
                    <Label htmlFor="objectDetectionEnabled" className="text-sm font-medium flex-1">
                      Smart Object Detection
                      <span className="text-xs bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 px-2 py-0.5 rounded-full font-medium ml-2">
                        NEW
                      </span>
                    </Label>
                    <Switch
                      id="objectDetectionEnabled"
                      checked={objectDetectionEnabled}
                      onCheckedChange={setObjectDetectionEnabled}
                    />
                  </div>
                  <p className="text-xs text-gray-500">
                    Automatically detect objects in your hands and replace symbol suggestions with detected items
                  </p>



                  <div className="flex items-center space-x-3">
                    <Label htmlFor="eyegazeEnabled" className="text-sm font-medium flex-1">
                      Eyegaze Symbol Selection
                      <span className="text-xs bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full font-medium ml-2">
                        ACCESSIBILITY
                      </span>
                    </Label>
                    <Switch
                      id="eyegazeEnabled"
                      checked={eyegazeEnabled}
                      onCheckedChange={setEyegazeEnabled}
                    />
                  </div>
                  <p className="text-xs text-gray-500">
                    Enable symbol selection by hovering over symbols for a set duration
                  </p>

                  {eyegazeEnabled && (
                    <div className="ml-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg space-y-3">
                      <div className="space-y-2">
                        <Label htmlFor="eyegazeTimeout" className="text-sm font-medium">
                          Selection Timeout: {eyegazeTimeout / 1000}s
                        </Label>
                        <Slider
                          id="eyegazeTimeout"
                          min={1000}
                          max={10000}
                          step={500}
                          value={[eyegazeTimeout]}
                          onValueChange={(value) => setEyegazeTimeout(value[0])}
                          className="w-full"
                        />
                        <div className="flex justify-between text-xs text-gray-500">
                          <span>1s</span>
                          <span>Fast (2s)</span>
                          <span>Normal (3s)</span>
                          <span>Slow (5s)</span>
                          <span>10s</span>
                        </div>
                      </div>
                      <p className="text-xs text-blue-600 dark:text-blue-400">
                        💡 Hover over any symbol for {eyegazeTimeout / 1000} seconds to select it automatically
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Chat Agent Settings */}
              <div className="space-y-4">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <MessageSquare className="h-5 w-5" />
                  Chat Agent Behavior
                </h3>
                <div className="space-y-4">
                  {/* ChatGPT 5 Override Toggle */}
                  <div className="space-y-3 p-4 border border-orange-200 dark:border-orange-700 bg-orange-50 dark:bg-orange-900/20 rounded-lg">
                    <div className="flex items-center justify-between">
                      <div className="space-y-1">
                        <Label htmlFor="chatgpt5Enabled" className="text-sm font-medium text-orange-900 dark:text-orange-200">
                          Enable ChatGPT 5 ⚡
                        </Label>
                        <p className="text-xs text-orange-700 dark:text-orange-300">
                          Override all AI features to use ChatGPT 5 regardless of other model settings
                        </p>
                      </div>
                      <Switch
                        id="chatgpt5Enabled"
                        checked={chatgpt5Enabled}
                        onCheckedChange={setChatgpt5Enabled}
                      />
                    </div>
                    <p className="text-xs text-orange-600 dark:text-orange-400 italic">
                      When enabled: Conversation, Visual Analysis, Symbols, Voice, and Audio will all use ChatGPT 5
                    </p>
                  </div>

                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">Agent Conversation Style</Label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setIsEditingPrompt(!isEditingPrompt)}
                    >
                      {isEditingPrompt ? "Cancel" : "Edit"}
                    </Button>
                  </div>
                  
                  {isEditingPrompt ? (
                    <div className="space-y-3">
                      <Textarea
                        value={chatAgentPrompt}
                        onChange={(e) => setChatAgentPrompt(e.target.value)}
                        placeholder="Enter the chat agent's behavior instructions..."
                        className="min-h-[120px] text-sm"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const defaultPrompt = "You are an advanced conversational AI designed to engage with a human user in a dynamic, personalized, and continuously evolving conversation.";
                          setChatAgentPrompt(defaultPrompt);
                        }}
                      >
                        Reset to Default
                      </Button>
                    </div>
                  ) : (
                    <div className="p-3 bg-gray-50 rounded-md">
                      <p className="text-sm text-gray-600 line-clamp-3">
                        {chatAgentPrompt || "Default conversation behavior"}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Debug Mode Section */}
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-5 h-5 bg-gray-200 dark:bg-gray-700 rounded flex items-center justify-center">
                    <span className="text-xs">🔧</span>
                  </div>
                  <Label className="text-sm font-semibold">Developer Options</Label>
                </div>
                
                <div className="space-y-4 p-4 border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <Label htmlFor="debugMode" className="text-sm font-medium">
                        Debug Mode
                      </Label>
                      <p className="text-xs text-gray-600 dark:text-gray-400">
                        Show debug windows and developer controls
                      </p>
                    </div>
                    <Switch
                      id="debugMode"
                      checked={debugMode}
                      onCheckedChange={onDebugModeChange}
                    />
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    When enabled: AudioBETA, Object Detection, and Camera debug windows become available
                  </p>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col gap-3 pt-4">
                <Button
                  onClick={handleSave}
                  disabled={updateUserMutation.isPending}
                  className="w-full flex items-center gap-2"
                >
                  <Save className="w-4 h-4" />
                  {updateUserMutation.isPending ? t("settings.saving") : t("settings.saveSettings")}
                </Button>

                <Button
                  variant="secondary"
                  onClick={() => {
                    if (window.confirm(t("settings.confirmLogout"))) {
                      logoutMutation.mutate();
                    }
                  }}
                  disabled={logoutMutation.isPending}
                  className="w-full flex items-center gap-2"
                >
                  <LogOut className="w-4 h-4" />
                  {logoutMutation.isPending ? t("auth.loggingOut") : t("common.logout")}
                </Button>

                <Button
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={deleteUserMutation.isPending}
                  className="w-full flex items-center gap-2"
                >
                  <Trash2 className="w-4 h-4" />
                  {deleteUserMutation.isPending ? t("settings.deleting") : t("settings.deleteProfile")}
                </Button>
              </div>

              {/* User ID Info */}
              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                <Label className="text-xs text-gray-500">{t("settings.userId")}</Label>
                <p className="text-xs text-gray-400 font-mono break-all">{studentId}</p>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}