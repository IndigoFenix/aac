// client-aac/src/components/DualAgentConversationBox.tsx
// Conversation UI for the dual-agent AAC system

import { useEffect, useRef, useState, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import {
  Volume2,
  VolumeX,
  MessageCircle,
  Mic,
  MicOff,
  CameraOff,
  Brain,
  Eye,
  EyeOff,
  Grid3X3,
  Speech,
  Maximize,
  LogOut,
  ArrowLeft,
  ArrowRight,
  Bug,
  SlidersHorizontal,
  AlertTriangle,
  Sun,
  Moon,
  Zap,
  ScanSearch,
  Bell,
  Siren,
  MonitorSmartphone,
  Ear,
} from "lucide-react";
import { AacAvatar, AacCave } from "@/components/AacAvatar";
import { EnergyBar } from "@/components/EnergyBar";
import { useAvatarSprite } from "@/contexts/AvatarSpriteContext";
import { useSocialBot } from "@/contexts/SocialBotContext";
import { useCallOptional } from "@/contexts/CallContext";
import { CallFace } from "@/components/CallFace";
import { SocialDebugDialog } from "@/components/SocialDebugDialog";
import { ProceduralFace } from "@shared/social-bot/ProceduralFace";
import type { ParsedBoardData } from "@shared/schema";
import type { RawTrackedFace } from "@/lib/faceTrackingTypes";
import type { RawTrackedHand } from "@/lib/handGestureTypes";
import type { RawTrackedPose } from "@/lib/poseTrackingTypes";
import { useDualAgentContext } from "@/contexts/DualAgentContext";
import { Glyph } from "@/components/Glyph";
import { glyphStripWidth } from "@/lib/glyph-layout";
import { useCameraAttentivenessOptional } from "@/contexts/CameraAttentivenessContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTheme } from "@/contexts/ThemeContext";
import { useEyeTrackingDwell } from "@/contexts/EyeTrackingDwellContext";
import { useBoardAudio } from "@/contexts/BoardAudioContext";
import { FaceMirror } from "@/components/FaceMirror";
import { useMultiCamera } from "@/hooks/useMultiCamera";
import { IdentificationBadge } from "@/components/IdentificationBadge";
import type { IdentificationResult } from "@/hooks/usePersonIdentification";

interface DualAgentConversationBoxProps {
  isVisible: boolean;
  onToggle: () => void;
  selectedSymbols?: string[];
  onClearSymbols?: () => void;
  /** Experiment (glyphInputTranslation): when true, render a glyph strip
   *  beneath the header showing a translation of the latest incoming speech.
   *  Home owns the gating (setting on + header visible + not in the builder). */
  glyphStripActive?: boolean;
  onBoardUpdate?: (board: ParsedBoardData) => void;
  onSetBoard?: (data: { board: ParsedBoardData; name: string; boardId: string }) => void;
  onUnloadBoard?: () => void;
  currentBoard?: ParsedBoardData | null;
  boardMode: 'ai' | 'db';
  onBoardModeChange: (mode: 'ai' | 'db') => void;
  recentButtonPresses?: string[];
  onVoice?: () => void;
  // App-level controls (moved from top nav bar)
  onExitStudent?: () => void;
  onLogout?: () => void;
  onManageDevices?: () => void;
  onFullScreen?: () => void;
  debugMode?: boolean;
  showDebugPanel?: boolean;
  onDebugPanelToggle?: () => void;
  /** Debug helper: fire a fake caretaker alarm so the overlay/sound can be tested locally. */
  onTestAlarm?: (level: "alert" | "emergency") => void;
  rawFaces?: RawTrackedFace[];
  rawHands?: RawTrackedHand[];
  rawPoses?: RawTrackedPose[];
  /** Client-side person identification (for the subtle name indicator). */
  identification?: IdentificationResult | null;
  /** The AI companion's display name (aacSettings.aiName), shown under its avatar. */
  aiName?: string;
}

export function DualAgentConversationBox({
  isVisible,
  onToggle,
  selectedSymbols,
  onClearSymbols,
  glyphStripActive,
  onBoardUpdate,
  onSetBoard,
  onUnloadBoard,
  currentBoard,
  boardMode,
  onBoardModeChange,
  recentButtonPresses,
  onVoice,
  onExitStudent,
  onLogout,
  onManageDevices,
  onFullScreen,
  debugMode,
  showDebugPanel,
  onDebugPanelToggle,
  onTestAlarm,
  rawFaces,
  rawHands,
  rawPoses,
  identification,
  aiName,
}: DualAgentConversationBoxProps) {
  const {
    currentMessage,
    isLoading,
    startupStage,
    isInitialized,
    error,
    audioEnabled,
    isPlaying,
    voiceEnabled,
    isRecording,
    audioLevel,
    recordingDuration,
    micActive,
    snapshotTick,
    transcription,
    interimTranscription,
    muteState,
    setMuteState,
    lastModeChange,
    budget,
    videoCaptureEnabled,
    setVideoCaptureEnabled,
    initialize,
    sendMessage,
    setAudioEnabled,
    setVoiceEnabled,
    stopAudio,
    startVoiceRecording,
    stopVoiceRecording,
    cancelVoiceRecording,
    setCurrentBoard,
    setOnBoardUpdate,
    setOnSetBoard,
    setOnUnloadBoard,
    monitorError,
    monitorConsecutiveFailures,
    utteranceConfidence,
    responseMode,
    setResponseMode,
    reconnecting,
    safetyBlocked,
    paused,
    setPaused,
    thinkingPulse,
    inputGlyphs,
    socialSession,
    socialPeerDebug,
    reconfigureSocialPeer,
    peerVoicePitch,
    setPeerVoicePitch,
    peerVoiceFormant,
    setPeerVoiceFormant,
  } = useDualAgentContext();
  const sprite = useAvatarSprite();
  const socialBot = useSocialBot();
  // Active video call takes over the avatar slot (precedence over both the idle
  // AI avatar and the social-trainer peer). Optional so the box still renders if
  // no CallProvider is mounted.
  const call = useCallOptional();
  const callActive = !!call?.active;
  // DEBUG-only: social-trainer parameter/internals inspector dialog.
  const [showSocialDebug, setShowSocialDebug] = useState(false);
  const { t, isRTL } = useLanguage();
  const { theme, toggleTheme } = useTheme();
  const { mode: dwellMode } = useEyeTrackingDwell();
  const { scanning: audioScanning, toggleScan: toggleAudioScan } = useBoardAudio();

  // Camera / microphone "off or not working" detection — drives the indicators
  // that replace the face mirror. The shared user-camera <video> readiness
  // (userVideoReady) is the authoritative signal that frames are actually
  // flowing; globalError flags a hardware/permission failure. Video capture
  // being toggled off also counts as "off". `micActive` is true only while a
  // live mic stream is acquired (false = disabled or acquisition failed).
  const { userVideoReady, globalError: cameraError } = useMultiCamera();
  const cameraOff = !videoCaptureEnabled || !userVideoReady || !!cameraError;
  // The live mic only comes up once the session is initialized; before that
  // it's intentionally idle, so don't flag it as off/broken during startup.
  // Deliberately-disabled audio capture (voiceEnabled=false) isn't an error
  // either — the avatar shows it as closed ears — so the red indicator is
  // reserved for the mic being off when it SHOULD be on (acquisition failed
  // or the OS revoked the track).
  const micOff = isInitialized && voiceEnabled && !micActive;

  // (The green "voice live" listening dot that used to sit on the avatar was
  // removed.)

  // Stable refs — prevents re-send loops when callback identities change across renders
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const onClearSymbolsRef = useRef(onClearSymbols);
  onClearSymbolsRef.current = onClearSymbols;

  // Guard: track last sent symbol string to prevent duplicate sends
  const lastSentSymbolsRef = useRef<string | null>(null);

  const hasInitializedRef = useRef(false);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Set up board update callbacks
  useEffect(() => {
    setOnBoardUpdate(onBoardUpdate || null);
  }, [onBoardUpdate, setOnBoardUpdate]);

  useEffect(() => {
    setOnSetBoard(onSetBoard || null);
  }, [onSetBoard, setOnSetBoard]);

  useEffect(() => {
    setOnUnloadBoard(onUnloadBoard || null);
  }, [onUnloadBoard, setOnUnloadBoard]);

  // Sync current board to context
  useEffect(() => {
    setCurrentBoard(currentBoard || null);
  }, [currentBoard, setCurrentBoard]);

  // Auto-start conversation when component becomes visible
  useEffect(() => {
    if (isVisible && !isInitialized && !isLoading && !hasInitializedRef.current) {
      hasInitializedRef.current = true;
      initialize();
    }
  }, [isVisible, isInitialized, isLoading, initialize]);

  // Handle initialization errors - allow retry after a delay
  useEffect(() => {
    if (error && hasInitializedRef.current && !isInitialized && !isLoading) {
      console.log("[DualAgentConversationBox] Error detected, will retry:", error);
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
      retryTimeoutRef.current = setTimeout(() => {
        hasInitializedRef.current = false;
      }, 2000);
    }
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, [error, isInitialized, isLoading]);

  // Handle symbol selection from parent — send once, guard against re-fires
  useEffect(() => {
    if (selectedSymbols && selectedSymbols.length > 0 && isInitialized) {
      const message = selectedSymbols.join(" ");
      // Skip if we already sent this exact message (effect re-fired due to other dep changes)
      if (lastSentSymbolsRef.current === message) return;
      lastSentSymbolsRef.current = message;
      sendMessageRef.current(message);
      if (onClearSymbolsRef.current) {
        setTimeout(() => onClearSymbolsRef.current?.(), 1000);
      }
    } else {
      // Symbols cleared — reset guard for next button press
      lastSentSymbolsRef.current = null;
    }
  }, [selectedSymbols, isInitialized]);

  // Avatar dwell suppression — eyegaze users naturally look at the avatar while
  // it's talking, so we don't want that to start a new turn. Suppress dwell while
  // the avatar is speaking and for 3s after it stops. Tap/click are unaffected.
  const [avatarDwellSuppressed, setAvatarDwellSuppressed] = useState(false);
  useEffect(() => {
    if (isPlaying) {
      setAvatarDwellSuppressed(true);
      return;
    }
    if (!avatarDwellSuppressed) return;
    const timer = setTimeout(() => setAvatarDwellSuppressed(false), 3000);
    return () => clearTimeout(timer);
  }, [isPlaying, avatarDwellSuppressed]);

  // Question-mark overlay shown next to the avatar when Speaker emits a
  // private_note — signals "I'm thinking" so the user doesn't read the
  // pause as broken. Auto-dismisses after ~1.6s. We track the pulse via
  // a counter (not a boolean) so back-to-back notes restart the
  // animation cleanly.
  const [showThinking, setShowThinking] = useState(false);
  useEffect(() => {
    if (thinkingPulse === 0) return;
    setShowThinking(true);
    const timer = setTimeout(() => setShowThinking(false), 1600);
    return () => clearTimeout(timer);
  }, [thinkingPulse]);

  const attentiveness = useCameraAttentivenessOptional();

  // Avatar click: send an attention message in interact mode, and always-wake
  // the sleep system regardless of state. Eyegaze dwell vs touch vs click are
  // distinguished for the message text and the always-wake trigger source.
  const handleAvatarClick = useCallback((e: React.MouseEvent) => {
    // Deep token-budget floor (<10%): the Speaker never wakes and the avatar
    // stays asleep even when tapped (board-only presence). A tap must NOT wake
    // the session here — button presses still work (separate path), but the AI
    // voice is paused until the budget recovers.
    if (budget && budget.percent < 10) return;

    const isEyegaze = dwellMode === 'eyegaze';
    attentiveness?.triggerAlwaysWake(isEyegaze ? 'avatarEyegaze' : 'avatarTap');

    if (muteState === 'muted' || !isInitialized) return;
    if (isEyegaze) {
      sendMessage("[system: the user is looking at you]");
    } else if (e.nativeEvent instanceof PointerEvent && e.nativeEvent.pointerType === 'touch') {
      sendMessage("[system: the user touched you]");
    } else {
      sendMessage("[system: the user clicked you]");
    }
  }, [muteState, isInitialized, dwellMode, sendMessage, attentiveness, budget]);

  // Cave click: user-only mute toggle. Muted → unmute & greet. Unmuted → mute & stop audio.
  // Either direction is a clear user-initiated engagement event, so it always-wakes
  // the sleep system as well (counts as an avatar tap).
  //
  // During a social-trainer session the cave is repurposed as a "cancel"
  // button — pressing it ends the current session via SocialBotContext, which
  // then handles mute-state restore + debrief message.
  const handleCaveClick = useCallback(() => {
    attentiveness?.triggerAlwaysWake('avatarTap');
    if (socialBot.active) {
      socialBot.cancel();
      return;
    }
    if (muteState === 'muted') {
      setMuteState('unmuted');
      if (isInitialized) {
        sendMessage("[system: the user has unmuted you, greet them]");
      }
    } else {
      setMuteState('muted');
      stopAudio();
    }
  }, [socialBot, muteState, isInitialized, setMuteState, sendMessage, stopAudio, attentiveness]);

  // Sprite presentation (eye/ear/mouth/focus, animation frames, sleep flags)
  // comes from <AvatarSpriteProvider> so the header avatar and the fullscreen
  // overlay render the exact same blink/ear-flap frames.
  const { isAsleep, eyeState } = sprite;

  // The AI's own avatar is visible only when awake and not handed to a social
  // peer. Its name tag follows it: under the avatar normally, under the cave
  // when the AI is silent (asleep/muted) or a social-trainer peer has the slot.
  // During a call the remote peer's face takes the avatar slot and the AI
  // retreats "into the cave" (same as a social-trainer session) — so its own
  // avatar is hidden and its name tag moves under the cave.
  const aiAvatarVisible = !isAsleep && !socialBot.active && !callActive;
  const aiNameTag = aiName ? (
    <div
      className="pointer-events-none select-none absolute left-1/2 -translate-x-1/2 bottom-0 flex items-center gap-1 rounded-full bg-black/40 px-1.5 py-0.5 text-[10px] text-white/85 max-w-[88px]"
      aria-hidden="true"
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-violet-400 shrink-0" />
      <span className="font-medium truncate">{aiName}</span>
    </div>
  ) : null;

  if (!isVisible) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-50 shadow-lg bg-primary text-white">
      <div className="px-4 py-2">
          {/* Two-row grid: cave + avatar on left, buttons top-right, text bottom-right */}
          <div className="flex items-stretch gap-3">
            {/* Token-budget energy bar — left of the cave (right in RTL: it's the
                first flex child, and the header runs under dir="rtl", so it lands
                on the right automatically). Only shown once the server has pushed
                a budget level (economizing sessions). */}
            {budget && (
              <EnergyBar
                percent={budget.percent}
                band={budget.band}
                label={`${t('aac.energyBar')}: ${budget.percent}%`}
              />
            )}
            {/* Cave (sleep toggle) — left of avatar (right in RTL). Wrapped in a
                full-height column so its name tag anchors to the header row's
                bottom while the cave image stays vertically centered. */}
            <div className="relative self-stretch shrink-0 flex flex-col items-center justify-center">
              <button type="button"
                data-dwell
                onClick={handleCaveClick}
                className="relative shrink-0 w-20 cursor-pointer hover:opacity-90 transition-opacity select-none"
                title={isAsleep ? "Unmute (tap cave to wake)" : "Mute (tap cave to silence)"}
              >
                <AacCave
                  avatar={sprite.avatar}
                  // During a social-trainer session OR an active call the
                  // companion is silent (the peer/remote face has taken the
                  // avatar slot), so show the cave occupied — the same images it
                  // shows in silent/muted mode.
                  empty={!isAsleep && !socialBot.active && !callActive}
                  eyeState={eyeState}
                  blinkTick={snapshotTick}
                />
                {/* Mode-change indicator — flashes briefly when AI changes mode */}
                {lastModeChange && lastModeChange.source === "ai" && (Date.now() - lastModeChange.at) < 4000 && (
                  <div
                    key={lastModeChange.at}
                    className="absolute -top-1 -right-1 px-1.5 py-0.5 rounded-full bg-blue-500 text-white text-[10px] font-semibold shadow animate-pulse"
                    title={lastModeChange.reason || `AI switched to ${lastModeChange.mode}`}
                  >
                    AI: {lastModeChange.mode}
                  </div>
                )}
              </button>
              {/* AI name tag lives here when the AI is silent/muted or a social
                  peer has the avatar slot — i.e. the AI is "in the cave". */}
              {!aiAvatarVisible && aiNameTag}
            </div>

            {/* Animated Avatar — hidden when sleeping. Click to send attention message in interact mode.
                data-dwell is omitted while the avatar is talking + 3s grace period so eyegaze
                doesn't accidentally start new turns when the user is just listening.
                During a social-trainer session the avatar slot is taken over by
                the bot face — the AAC AI is in muted/silent mode and has no
                visible avatar of its own. */}
            {(callActive || socialBot.active || !isAsleep) && (
            <div className="relative self-stretch shrink-0 flex flex-col items-center justify-center">
            {callActive ? (
              /* Active video call — the remote peer's face takes over the slot,
                 ahead of both the idle AI avatar and the social-trainer peer. */
              <div
                className="relative shrink-0 w-20 flex items-center justify-center select-none"
                title={call?.activeContact?.name ?? "Call"}
              >
                <CallFace />
              </div>
            ) : socialBot.active ? (
              <div
                className="relative shrink-0 w-20 flex items-center justify-center select-none"
                title={socialBot.characterName
                  ? `${socialBot.characterName}${socialBot.voiceName ? ` (voice: ${socialBot.voiceName})` : ""}`
                  : "Social peer"}
              >
                {socialBot.connected && socialBot.appearance ? (
                  <ProceduralFace
                    target={socialBot.faceTarget}
                    appearance={socialBot.appearance}
                    expressiveness={socialBot.expressiveness}
                    legibility={socialBot.legibility}
                    speakingLevel={socialBot.speakingLevel}
                    style={{ width: 80, height: 80 }}
                  />
                ) : (
                  /* Connecting — show a neutral spinner so the slot doesn't
                     collapse and the user knows something is loading. */
                  <div
                    className="rounded-full border-4 border-white/30 border-t-white/90 animate-spin"
                    style={{ width: 48, height: 48 }}
                    aria-label="Connecting"
                  />
                )}
              </div>
            ) : (
                <button type="button"
                  {...(avatarDwellSuppressed ? {} : { "data-dwell": "" })}
                  onClick={handleAvatarClick}
                  className="relative shrink-0 w-20 cursor-pointer hover:opacity-90 transition-opacity select-none"
                  title="Tap to get attention"
                >
                  <AacAvatar
                    avatar={sprite.avatar}
                    renderedEye={sprite.renderedEye}
                    renderedEar={sprite.renderedEar}
                    mouthEmote={sprite.mouthEmote}
                    mouthOpen={sprite.mouthOpen}
                    showMouth={sprite.showMouth}
                    focusActive={sprite.focusActive}
                  />
                  <AnimatePresence>
                    {showThinking && (
                      <motion.div
                        key={thinkingPulse}
                        initial={{ opacity: 0, scale: 0.4, y: 0 }}
                        animate={{
                          opacity: 1,
                          scale: 1,
                          y: [-2, -6, -2],
                        }}
                        exit={{ opacity: 0, scale: 0.6, y: -10 }}
                        transition={{
                          opacity: { duration: 0.18 },
                          scale: { type: "spring", stiffness: 300, damping: 18 },
                          y: { duration: 1.4, repeat: Infinity, ease: "easeInOut" },
                        }}
                        className="pointer-events-none absolute -top-2 -right-2 flex items-center justify-center w-7 h-7 rounded-full bg-yellow-300 text-gray-800 font-bold text-base shadow-md select-none"
                        aria-label="Thinking"
                      >
                        ?
                      </motion.div>
                    )}
                  </AnimatePresence>
                  {/* (The green "voice live" listening dot was removed.) */}
                </button>
            )}
              {/* AI name tag — under the avatar while awake & not social,
                  anchored to the header row's bottom (not the image's). */}
              {aiAvatarVisible && aiNameTag}
            </div>
            )}

            {/* Right side: two rows. relative+z so buttons stack in front of the avatar sprite. */}
            <div className="relative z-10 flex-1 min-w-0 flex flex-col justify-center gap-1">
              {/* Top row: menu buttons — aligned to end */}
              <div className="flex items-center gap-1 flex-wrap">
                <div className="flex items-center justify-end gap-1 flex-wrap ml-auto">
                  {/* Board Mode Toggle */}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onBoardModeChange(boardMode === 'ai' ? 'db' : 'ai')}
                    className={`text-white hover:text-gray-200 hover:bg-white/10 h-7 w-7 p-0 ${boardMode === 'db' ? 'bg-white/20' : ''}`}
                    title={boardMode === 'ai' ? "Switch to database boards" : "Switch to AI board"}
                  >
                    {boardMode === 'ai' ? <Grid3X3 className="w-4 h-4" /> : <Brain className="w-4 h-4" />}
                  </Button>
                  {/* Video Capture Toggle */}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setVideoCaptureEnabled(!videoCaptureEnabled)}
                    className={`text-white hover:text-gray-200 hover:bg-white/10 h-7 w-7 p-0 ${videoCaptureEnabled ? 'bg-white/20' : ''}`}
                    title={videoCaptureEnabled ? "Disable video capture" : "Enable video capture"}
                  >
                    {videoCaptureEnabled ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  </Button>
                  {/* Audio Capture Toggle */}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setVoiceEnabled(!voiceEnabled)}
                    className={`text-white hover:text-gray-200 hover:bg-white/10 h-7 w-7 p-0 ${voiceEnabled ? 'bg-white/20' : ''}`}
                    title={voiceEnabled ? t('status.disableAudioCapture') : t('status.enableAudioCapture')}
                  >
                    {voiceEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
                  </Button>
                  {/* Audio Toggle */}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setAudioEnabled(!audioEnabled)}
                    className="text-white hover:text-gray-200 hover:bg-white/10 h-7 w-7 p-0"
                    title={audioEnabled ? "Mute audio" : "Unmute audio"}
                  >
                    {audioEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                  </Button>
                  {/* Response Mode Toggle: Fast (Zap) vs Analyze (ScanSearch) */}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setResponseMode(responseMode === 'fast' ? 'analyze' : 'fast')}
                    className={`text-white hover:text-gray-200 hover:bg-white/10 h-7 w-7 p-0 ${responseMode === 'fast' ? 'bg-white/20' : ''}`}
                    title={responseMode === 'fast' ? "Fast mode (respond first)" : "Analyze mode (observe first)"}
                  >
                    {responseMode === 'fast' ? <Zap className="w-4 h-4" /> : <ScanSearch className="w-4 h-4" />}
                  </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleTheme}
                    className="text-white hover:text-gray-200 hover:bg-white/10 h-7 w-7 p-0"
                    title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                  >
                    {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                  </Button>

                  {debugMode && onDebugPanelToggle && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onDebugPanelToggle}
                      className={`h-7 w-7 p-0 ${showDebugPanel ? 'text-yellow-300 bg-white/20' : 'text-white hover:text-gray-200 hover:bg-white/10'}`}
                      title="Debug Panel"
                    >
                      <Bug className="w-4 h-4" />
                    </Button>
                  )}

                  {/* Debug: social-trainer parameter / internals inspector */}
                  {debugMode && socialSession && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowSocialDebug((v) => !v)}
                      className={`h-7 w-7 p-0 ${showSocialDebug ? 'text-yellow-300 bg-white/20' : 'text-white hover:text-gray-200 hover:bg-white/10'}`}
                      title="Social Trainer Debug"
                    >
                      <SlidersHorizontal className="w-4 h-4" />
                    </Button>
                  )}

                  {/* Debug: fire a fake caretaker alarm to test the overlay + sound */}
                  {debugMode && onTestAlarm && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onTestAlarm("alert")}
                        className="text-white hover:text-amber-300 hover:bg-white/10 h-7 w-7 p-0"
                        title="Test alert chime"
                      >
                        <Bell className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onTestAlarm("emergency")}
                        className="text-white hover:text-red-300 hover:bg-white/10 h-7 w-7 p-0"
                        title="Test emergency alarm"
                      >
                        <Siren className="w-4 h-4" />
                      </Button>
                    </>
                  )}

                  {onFullScreen && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onFullScreen}
                      className="text-white hover:text-gray-200 hover:bg-white/10 h-7 w-7 p-0"
                      title="Toggle Full Screen"
                    >
                      <Maximize className="w-4 h-4" />
                    </Button>
                  )}

                  {onManageDevices && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onManageDevices}
                      className="text-white hover:text-gray-200 hover:bg-white/10 h-7 w-7 p-0"
                      title={t("devices.title")}
                    >
                      <MonitorSmartphone className="w-4 h-4" />
                    </Button>
                  )}

                  {onExitStudent && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onExitStudent}
                      className="text-white hover:text-orange-300 hover:bg-white/10 h-7 w-7 p-0"
                      title="Switch Student"
                    >
                      {isRTL ? <ArrowRight className="w-4 h-4" /> : <ArrowLeft className="w-4 h-4" />}
                    </Button>
                  )}

                  {onLogout && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onLogout}
                      className="text-white hover:text-red-300 hover:bg-white/10 h-7 w-7 p-0"
                      title="Log Out"
                    >
                      <LogOut className="w-4 h-4" />
                    </Button>
                  )}

                  {monitorError && monitorConsecutiveFailures > 0 && (
                    <span
                      className="flex items-center gap-1 text-xs bg-red-500/80 px-2 py-0.5 rounded cursor-help"
                      title={`Monitor agent error (${monitorConsecutiveFailures} failures): ${monitorError}`}
                    >
                      <AlertTriangle className="w-3 h-3" />
                      Monitor
                    </span>
                  )}

                </div>
              </div>

              {/* Bottom row: bot text (social mode) / message (unmuted) / utterance buttons (muted) — min-h keeps header stable during loading */}
              {socialBot.active ? (
                <div className="flex items-center min-h-[2rem]">
                  <div className="text-sm text-white font-medium leading-relaxed flex-1">
                    {socialBot.botText
                      ? socialBot.botText
                      : (<span className="text-white/60 italic">{socialBot.connected ? t("social.waiting") : t("social.connecting")}</span>)
                    }
                  </div>
                </div>
              ) : muteState === 'unmuted' ? (
                <div className="flex items-center min-h-[2rem]">
                  {isLoading ? (
                    <div className="flex items-center gap-2 text-white">
                      <div className="w-2 h-2 bg-white rounded-full animate-bounce" />
                      <div
                        className="w-2 h-2 bg-white rounded-full animate-bounce"
                        style={{ animationDelay: "0.1s" }}
                      />
                      <div
                        className="w-2 h-2 bg-white rounded-full animate-bounce"
                        style={{ animationDelay: "0.2s" }}
                      />
                      <span className="ml-2 text-sm">
                        {t(`status.startup.${startupStage}`)}
                      </span>
                    </div>
                  ) : reconnecting ? (
                    <div className="flex items-center gap-2 text-white/80">
                      <div className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
                      <span className="text-sm">{t('errors.RECONNECTING')}</span>
                    </div>
                  ) : safetyBlocked ? (
                    <div className="flex items-center gap-2 text-white/80">
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                      <span className="text-sm">{t('errors.SAFETY_BLOCKED')}</span>
                    </div>
                  ) : error ? (
                    <div className="flex items-center justify-between w-full">
                      <p className="text-white/80 text-sm">
                        {error.startsWith('error:')
                          ? t(`errors.${error.slice(6)}`)
                          : error}
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          hasInitializedRef.current = false;
                        }}
                        className="text-white hover:text-gray-200 hover:bg-white/10 text-xs px-2 py-1"
                      >
                        {t('common.reset')}
                      </Button>
                    </div>
                  ) : interimTranscription ? (
                    /* Live rolling STT interim — the device is hearing words
                       RIGHT NOW; grey/tentative until the recognizer commits a
                       final (it then clears back to the yellow transcript). */
                    <div className="flex items-center justify-between w-full">
                      <div
                        className="text-sm text-white/50 italic leading-relaxed flex-1 mr-3"
                      >
                        {interimTranscription}
                      </div>
                    </div>
                  ) : transcription ? (
                    /* Someone spoke to the user (Observer transcript that
                       triggers the Board Manager) — show it in yellow to
                       distinguish it from the AI's own words (white). */
                    <div className="flex items-center justify-between w-full">
                      <div
                        className="text-sm text-yellow-300 font-medium leading-relaxed flex-1 mr-3"
                      >
                        {transcription}
                      </div>
                    </div>
                  ) : currentMessage ? (
                    <div className="flex items-center justify-between w-full">
                      <div
                        className="text-sm text-white font-medium leading-relaxed flex-1 mr-3"
                      >
                        {currentMessage.content}
                        {utteranceConfidence && (
                          <span
                            className={`inline-block w-2 h-2 rounded-full ml-2 align-middle ${
                              utteranceConfidence === 'high' ? 'bg-green-400' :
                              utteranceConfidence === 'medium' ? 'bg-amber-400' :
                              'bg-red-400'
                            }`}
                            title={`Confidence: ${utteranceConfidence}`}
                          />
                        )}
                        {audioEnabled && isPlaying && (
                          <Volume2 className="w-3 h-3 inline ml-2 opacity-60 animate-pulse" />
                        )}
                      </div>

                      {isPlaying && (
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : (
                /* Silent mode: show recent button presses + Speak button */
                <div className="flex items-center gap-2">
                  <div className="flex-1 bg-white/10 rounded-lg px-3 py-2 min-h-[36px] flex items-center">
                    {recentButtonPresses && recentButtonPresses.length > 0 ? (
                      <span className="text-sm text-white/90 truncate">
                        {recentButtonPresses.join(" · ")}
                      </span>
                    ) : (
                      <span className="text-sm text-white/40 italic">
                        {t("silentMode.placeholder")}
                      </span>
                    )}
                  </div>
                  {recentButtonPresses && recentButtonPresses.length > 0 && onVoice && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={onVoice}
                      className="bg-purple-500 hover:bg-purple-600 text-white border-0 px-3 py-2 shrink-0"
                      title="Voice selected buttons as speech"
                    >
                      <Speech className="w-4 h-4 mr-1" />
                      {t("quickActions.speak")}
                    </Button>
                  )}
                </div>
              )}
            </div>

            {/* Audio-scan toggle (the "ear") — sits next to the mirror. Reads
                every board button aloud one at a time; press again (or press any
                board button) to stop. data-audio-scan-toggle marks it so the
                stop-on-press handler ignores this button. */}
            <button
              type="button"
              data-dwell
              data-audio-scan-toggle
              onClick={toggleAudioScan}
              className={`shrink-0 self-center flex items-center justify-center rounded-lg transition-colors ${
                audioScanning
                  ? "bg-yellow-400 text-gray-900 ring-2 ring-yellow-300 animate-pulse"
                  : "bg-white/10 text-white hover:bg-white/20"
              }`}
              style={{ width: 52, height: 80 }}
              title={audioScanning ? t("audioScan.stop") : t("audioScan.start")}
              aria-label={audioScanning ? t("audioScan.stop") : t("audioScan.start")}
            >
              <Ear className="w-8 h-8" />
            </button>

            {/* Microphone-error indicator — sits to the LEFT of the mirror (right
                in RTL, since the header row follows the text direction). Shown
                only when the AAC failed to acquire the mic stream, so it's red to
                read as an error rather than a benign "off" state. */}
            {micOff && (
              <div
                className="shrink-0 self-center flex items-center justify-center text-red-500"
                style={{ width: 40, height: 80 }}
                title={t('status.microphoneOff')}
                aria-label={t('status.microphoneOff')}
              >
                <MicOff className="w-6 h-6" />
              </div>
            )}

            {/* Face Mirror — always reserves space; click/dwell to toggle pause.
                When the camera is off or not working, a camera-off icon takes
                the mirror's place in the same slot. Wrapped in a full-height
                column so the user tag anchors to the header row's bottom. */}
            <div className="relative self-stretch shrink-0 flex flex-col items-center justify-center">
              <button type="button"
                data-dwell
                onClick={() => setPaused(!paused)}
                className={`relative shrink-0 rounded-lg cursor-pointer transition-opacity ${paused ? 'ring-2 ring-red-400 opacity-80' : 'hover:opacity-90'}`}
                title={cameraOff ? t('status.cameraOff') : paused ? t('pause.resume') : t('pause.pause')}
                style={{ width: 80, height: 80 }}
              >
                {cameraOff ? (
                  <div
                    className="w-full h-full flex items-center justify-center rounded-lg bg-white/5 text-white/40"
                    aria-label={t('status.cameraOff')}
                  >
                    <CameraOff className="w-8 h-8" />
                  </div>
                ) : (
                  <FaceMirror
                    faces={rawFaces ?? []}
                    hands={rawHands ?? []}
                    poses={rawPoses ?? []}
                    size={80}
                  />
                )}
              </button>
              {/* Who the camera sees — the user tag, anchored to the row bottom. */}
              <div className="absolute left-1/2 -translate-x-1/2 bottom-0">
                <IdentificationBadge identification={identification ?? null} />
              </div>
            </div>
          </div>

          {/* Experiment (glyphInputTranslation): glyph translation of the
              speech last directed at the user. The strip stays mounted (so the
              header height is stable) and keeps its last value until the server
              sends a fresh translation. */}
          {glyphStripActive && (
            <div
              // Height MUST equal home.tsx's GLYPH_STRIP_REM (5rem) so the grown
              // header is exactly `6rem + GLYPH_STRIP_REM` tall — matching the
              // <main> top padding + board offset, with no gap underneath.
              // box-sizing: border-box keeps the border/padding inside 5rem.
              // Multiple sentences lay out left→right within this fixed height;
              // overflow is clipped (input glyphs are short gists). Each block
              // gets an explicit width because <Glyph>'s `width:100%` would
              // collapse to 0 in this auto-width row.
              className="flex items-center justify-center gap-3 overflow-hidden border-t border-white/15 pt-1"
              style={{ height: "5rem" }}
              aria-hidden={!inputGlyphs || inputGlyphs.length === 0}
            >
              {inputGlyphs && inputGlyphs.length > 0 ? (
                inputGlyphs.map((g, i) => (
                  <div key={i} className="flex h-full items-center">
                    {i > 0 && <div className="mr-3 h-3/5 w-px shrink-0 bg-white/25" />}
                    <div className="h-full shrink-0" style={{ width: glyphStripWidth(g.glyph) }}>
                      <Glyph glyph={g.glyph} fallback={g.fallback} height="100%" noBackground />
                    </div>
                  </div>
                ))
              ) : (
                <span className="text-white/30 text-2xl tracking-widest select-none">···</span>
              )}
            </div>
          )}
        </div>

      {debugMode && showSocialDebug && socialSession && (
        <SocialDebugDialog
          snapshot={socialPeerDebug}
          onApply={(params) => reconfigureSocialPeer(params)}
          voicePitch={peerVoicePitch}
          onVoicePitchChange={setPeerVoicePitch}
          voiceFormant={peerVoiceFormant}
          onVoiceFormantChange={setPeerVoiceFormant}
          onClose={() => setShowSocialDebug(false)}
        />
      )}
    </div>
  );
}

export default DualAgentConversationBox;
