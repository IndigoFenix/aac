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
} from "lucide-react";
import axolotlImg from "@assets/axolotl.png";
import axolotlSleepImg from "@assets/axolotl-sleep.png";
import { motion, AnimatePresence } from "framer-motion";
import type { ParsedBoardData } from "@shared/schema";
import { useDualAgentContext } from "@/contexts/DualAgentContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { LanguageSelector } from "@/components/LanguageSelector";

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
  } = useDualAgentContext();
  const { t } = useLanguage();

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

  // Handle symbol selection from parent
  useEffect(() => {
    if (selectedSymbols && selectedSymbols.length > 0 && isInitialized) {
      const message = selectedSymbols.join(" ");
      sendMessage(message);
      if (onClearSymbols) {
        setTimeout(() => onClearSymbols(), 1000);
      }
    }
  }, [selectedSymbols, isInitialized, sendMessage, onClearSymbols]);

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
        <div className="px-4 py-3">
          {/* Header Bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {thinkingMode ? (
                <Brain className="w-5 h-5 text-white animate-pulse" />
              ) : (
                <MessageCircle className="w-5 h-5 text-white" />
              )}
              <span className="font-medium text-white">
                {thinkingMode ? "Thinking Mode" : "Chat Assistant"}
              </span>
              {thinkingMode && (
                <span className="text-xs bg-white/20 px-2 py-0.5 rounded">
                  Deep Processing
                </span>
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
            <div className="flex items-center gap-2">
              {/* Mode Toggle */}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleToggleMode}
                className="text-white hover:text-gray-200 hover:bg-white/10"
                title={interactionMode === 'silent' ? "Switch to interact mode (device talks back)" : "Switch to silent mode (buttons only)"}
              >
                <img
                  src={interactionMode === 'silent' ? axolotlSleepImg : axolotlImg}
                  alt={interactionMode === 'silent' ? "Silent mode" : "Interactive mode"}
                  className="w-10 h-10 object-contain"
                />
              </Button>
              {/* Board Mode Toggle */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onBoardModeChange(boardMode === 'ai' ? 'db' : 'ai')}
                className={`text-white hover:text-gray-200 hover:bg-white/10 ${boardMode === 'db' ? 'bg-white/20' : ''}`}
                title={boardMode === 'ai' ? "Switch to database boards" : "Switch to AI board"}
              >
                {boardMode === 'ai' ? <Grid3X3 className="w-4 h-4" /> : <Brain className="w-4 h-4" />}
              </Button>
              {/* Video Capture Toggle */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setVideoCaptureEnabled(!videoCaptureEnabled)}
                className={`text-white hover:text-gray-200 hover:bg-white/10 ${videoCaptureEnabled ? 'bg-white/20' : ''}`}
                title={videoCaptureEnabled ? "Disable video capture" : "Enable video capture"}
              >
                {videoCaptureEnabled ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
              </Button>
              {/* Audio Capture Toggle */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setVoiceEnabled(!voiceEnabled)}
                className={`text-white hover:text-gray-200 hover:bg-white/10 ${voiceEnabled ? 'bg-white/20' : ''}`}
                title={voiceEnabled ? "Disable audio capture" : "Enable audio capture"}
              >
                {voiceEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
              </Button>
              {/* Audio Toggle */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAudioEnabled(!audioEnabled)}
                className="text-white hover:text-gray-200 hover:bg-white/10"
                title={audioEnabled ? "Mute audio" : "Unmute audio"}
              >
                {audioEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
              </Button>

              {/* Separator */}
              <div className="w-px h-5 bg-white/30 mx-1" />

              {/* App Controls */}
              <LanguageSelector className="text-xs" />

              {debugMode && onDebugPanelToggle && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onDebugPanelToggle}
                  className={showDebugPanel ? 'text-yellow-300 bg-white/20' : 'text-white hover:text-gray-200 hover:bg-white/10'}
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
                  className="text-white hover:text-gray-200 hover:bg-white/10"
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
                  className="text-white hover:text-gray-200 hover:bg-white/10"
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
                  className="text-white hover:text-orange-300 hover:bg-white/10"
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
                  className="text-white hover:text-red-300 hover:bg-white/10"
                  title="Log Out"
                >
                  <LogOut className="w-4 h-4" />
                </Button>
              )}

            </div>
          </div>

          {/* Message Display — interact mode: AI transcript, silent mode: recent presses + Speak */}
          {interactionMode === 'interact' ? (
            <div className="flex items-center justify-center mt-3">
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
              ) : error ? (
                <div className="flex items-center justify-between w-full">
                  <p className="text-white/80 text-sm">Connection issue, retrying...</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      hasInitializedRef.current = false;
                    }}
                    className="text-white hover:text-gray-200 hover:bg-white/10 text-xs px-2 py-1"
                  >
                    Retry Now
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
                    {thinkingMode ? (
                      <Brain className="w-4 h-4 inline mr-2" />
                    ) : (
                      <MessageCircle className="w-4 h-4 inline mr-2" />
                    )}
                    {currentMessage.content}
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
            <div className="flex items-center gap-2 mt-3">
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
      </motion.div>
    </AnimatePresence>
  );
}

export default DualAgentConversationBox;
