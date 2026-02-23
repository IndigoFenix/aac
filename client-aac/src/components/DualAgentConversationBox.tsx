// client-aac/src/components/DualAgentConversationBox.tsx
// Conversation UI for the dual-agent AAC system

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Volume2,
  VolumeX,
  MessageCircle,
  Mic,
  MicOff,
  Brain,
  Eye,
  EyeOff,
  Grid3X3,
  Speech,
  Settings,
  Maximize,
  LogOut,
  ArrowLeft,
  Bug,
  AlertTriangle,
  Sun,
  Moon,
  Zap,
  ScanSearch,
} from "lucide-react";
// Emotion-based avatar body images
import avatarHappy from "@assets/axolotl-happy.png";
import avatarSad from "@assets/axolotl-sad.png";
import avatarNeutral from "@assets/axolotl-neutral.png";
// Mouth overlays (closed)
import mouthHappy from "@assets/axolotl-mouth-happy.png";
import mouthSad from "@assets/axolotl-mouth-sad.png";
import mouthNeutral from "@assets/axolotl-mouth-neutral.png";
// Mouth overlays (open — speaking)
import mouthHappyOpen from "@assets/axolotl-mouth-happy-open.png";
import mouthSadOpen from "@assets/axolotl-mouth-sad-open.png";
import mouthNeutralOpen from "@assets/axolotl-mouth-neutral-open.png";
// Sleep image
import avatarSleep from "@assets/axolotl-sleep.png";
// Error image
import avatarError from "@assets/axolotl-error.png";
import { motion, AnimatePresence } from "framer-motion";
import type { ParsedBoardData } from "@shared/schema";
import { useDualAgentContext } from "@/contexts/DualAgentContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTheme } from "@/contexts/ThemeContext";
import { LanguageSelector } from "@/components/LanguageSelector";

// Avatar image maps by emotion
const AVATAR_BODY: Record<string, string> = {
  happy: avatarHappy,
  sad: avatarSad,
  neutral: avatarNeutral,
};
const MOUTH_CLOSED: Record<string, string> = {
  happy: mouthHappy,
  sad: mouthSad,
  neutral: mouthNeutral,
};
const MOUTH_OPEN: Record<string, string> = {
  happy: mouthHappyOpen,
  sad: mouthSadOpen,
  neutral: mouthNeutralOpen,
};

const MOUTH_OPEN_THRESHOLD = 0.08;

interface DualAgentConversationBoxProps {
  isVisible: boolean;
  onToggle: () => void;
  selectedSymbols?: string[];
  onClearSymbols?: () => void;
  onBoardUpdate?: (board: ParsedBoardData) => void;
  currentBoard?: ParsedBoardData | null;
  boardMode: 'ai' | 'db';
  onBoardModeChange: (mode: 'ai' | 'db') => void;
  recentButtonPresses?: string[];
  onInterpret?: () => void;
  // App-level controls (moved from top nav bar)
  onSettings?: () => void;
  onExitStudent?: () => void;
  onLogout?: () => void;
  onFullScreen?: () => void;
  debugMode?: boolean;
  showDebugPanel?: boolean;
  onDebugPanelToggle?: () => void;
}

export function DualAgentConversationBox({
  isVisible,
  onToggle,
  selectedSymbols,
  onClearSymbols,
  onBoardUpdate,
  currentBoard,
  boardMode,
  onBoardModeChange,
  recentButtonPresses,
  onInterpret,
  onSettings,
  onExitStudent,
  onLogout,
  onFullScreen,
  debugMode,
  showDebugPanel,
  onDebugPanelToggle,
}: DualAgentConversationBoxProps) {
  const {
    currentMessage,
    isLoading,
    isInitialized,
    error,
    thinkingMode,
    audioEnabled,
    isPlaying,
    voiceEnabled,
    isRecording,
    audioLevel,
    recordingDuration,
    transcription,
    interactionMode,
    setInteractionMode,
    videoCaptureEnabled,
    setVideoCaptureEnabled,
    initialize,
    sendMessage,
    clearSession,
    setAudioEnabled,
    setVoiceEnabled,
    stopAudio,
    startVoiceRecording,
    stopVoiceRecording,
    cancelVoiceRecording,
    setCurrentBoard,
    setOnBoardUpdate,
    monitorError,
    monitorConsecutiveFailures,
    emote,
    speakingVolume,
    interpretConfidence,
    responseMode,
    setResponseMode,
    reconnecting,
    safetyBlocked,
  } = useDualAgentContext();
  const { t } = useLanguage();
  const { theme, toggleTheme } = useTheme();

  // Stable refs — prevents re-send loops when callback identities change across renders
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const onClearSymbolsRef = useRef(onClearSymbols);
  onClearSymbolsRef.current = onClearSymbols;

  // Guard: track last sent symbol string to prevent duplicate sends
  const lastSentSymbolsRef = useRef<string | null>(null);

  const hasInitializedRef = useRef(false);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Set up board update callback
  useEffect(() => {
    setOnBoardUpdate(onBoardUpdate || null);
  }, [onBoardUpdate, setOnBoardUpdate]);

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

  const handleClearSession = async () => {
    hasInitializedRef.current = false;
    clearSession();
  };

  const handleToggleMode = () => {
    if (interactionMode === 'silent') {
      // Switching to interact mode — trigger a greeting
      setInteractionMode('interact');
      if (isInitialized) {
        sendMessage("[system: the device has been switched to interactive mode, greet the user]");
      }
    } else {
      // Switching to silent mode — stop all audio
      setInteractionMode('silent');
      stopAudio();
    }
  };

  // Determine if avatar should show asleep
  const isAsleep = interactionMode === 'silent';
  // Mouth is open when audio is playing and volume exceeds threshold
  const isMouthOpen = isPlaying && speakingVolume > MOUTH_OPEN_THRESHOLD;

  if (!isVisible) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: "-100%" }}
        animate={{ y: 0 }}
        exit={{ y: "-100%" }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className={`fixed top-0 left-0 right-0 z-50 shadow-lg ${
          thinkingMode ? "bg-purple-700" : "bg-primary"
        } text-white`}
      >
        <div className="px-4 py-2">
          {/* Two-row grid: avatar spans both rows on left, buttons top-right, text bottom-right */}
          <div className="flex items-stretch gap-3">
            {/* Animated Avatar — spans both rows, click to toggle silent/interact mode */}
            <button
              onClick={handleToggleMode}
              className="relative shrink-0 w-20 self-center cursor-pointer hover:opacity-90 transition-opacity select-none"
              title={interactionMode === 'silent' ? "Switch to interact mode (device talks back)" : "Switch to silent mode (buttons only)"}
            >
                <>
                  {error ? (
                    <img
                      src={avatarError}
                      alt="Error"
                      className="w-full h-full object-contain"
                    />
                  ) : isAsleep ? (
                    <img
                      src={avatarSleep}
                      alt="Sleeping"
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <img
                      src={AVATAR_BODY[emote] || AVATAR_BODY.happy}
                      alt={`Avatar (${emote})`}
                      className="w-full h-full object-contain"
                    />
                  )}
                  {!error && (
                    <img
                      src={isMouthOpen
                        ? (MOUTH_OPEN[emote] || MOUTH_OPEN.happy)
                        : (MOUTH_CLOSED[emote] || MOUTH_CLOSED.happy)
                      }
                      alt=""
                      className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                    />
                  )}
                </>
            </button>

            {/* Right side: two rows */}
            <div className="flex-1 min-w-0 flex flex-col justify-center gap-1">
              {/* Top row: menu buttons — aligned to end */}
              <div className="flex items-center justify-end gap-1 flex-wrap">
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
                  title={voiceEnabled ? "Disable audio capture" : "Enable audio capture"}
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

                <div className="w-px h-4 bg-white/30 mx-0.5" />

                <LanguageSelector className="text-xs" />

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

                {onSettings && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onSettings}
                    className="text-white hover:text-gray-200 hover:bg-white/10 h-7 w-7 p-0"
                    title="Settings"
                  >
                    <Settings className="w-4 h-4" />
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
                    <ArrowLeft className="w-4 h-4" />
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

              {/* Bottom row: message / silent content — min-h keeps header stable during loading */}
              {interactionMode === 'interact' ? (
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
                        {thinkingMode ? "Thinking carefully..." : "Processing..."}
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
                  ) : currentMessage ? (
                    <div className="flex items-center justify-between w-full">
                      <motion.div
                        key={currentMessage.id}
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="text-sm text-white font-medium leading-relaxed flex-1 mr-3"
                      >
                        {currentMessage.content}
                        {interpretConfidence && (
                          <span
                            className={`inline-block w-2 h-2 rounded-full ml-2 align-middle ${
                              interpretConfidence === 'high' ? 'bg-green-400' :
                              interpretConfidence === 'medium' ? 'bg-amber-400' :
                              'bg-red-400'
                            }`}
                            title={`Confidence: ${interpretConfidence}`}
                          />
                        )}
                        {audioEnabled && isPlaying && (
                          <Volume2 className="w-3 h-3 inline ml-2 opacity-60 animate-pulse" />
                        )}
                      </motion.div>

                      <div className="flex items-center gap-2">
                        {isPlaying && (
                          <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleClearSession}
                          disabled={isLoading}
                          className="text-white hover:text-gray-200 hover:bg-white/10 text-xs px-2 py-1"
                        >
                          New
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-white/80 text-sm">Starting conversation...</p>
                  )}
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
                  {recentButtonPresses && recentButtonPresses.length > 0 && onInterpret && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={onInterpret}
                      className="bg-purple-500 hover:bg-purple-600 text-white border-0 px-3 py-2 shrink-0"
                      title="Interpret selected buttons as speech"
                    >
                      <Speech className="w-4 h-4 mr-1" />
                      {t("quickActions.speak")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

export default DualAgentConversationBox;
