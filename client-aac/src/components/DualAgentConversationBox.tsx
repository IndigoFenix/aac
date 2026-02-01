// client-aac/src/components/DualAgentConversationBox.tsx
// Conversation UI for the dual-agent AAC system

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Volume2,
  VolumeX,
  MessageCircle,
  X,
  Mic,
  MicOff,
  Square,
  Brain,
  Eye,
  EyeOff,
} from "lucide-react";
import axolotlImg from "@assets/axolotl.png";
import axolotlSleepImg from "@assets/axolotl-sleep.png";
import { motion, AnimatePresence } from "framer-motion";
import type { ParsedBoardData } from "@shared/schema";
import { useDualAgentContext } from "@/contexts/DualAgentContext";

interface DualAgentConversationBoxProps {
  isVisible: boolean;
  onToggle: () => void;
  selectedSymbols?: string[];
  onClearSymbols?: () => void;
  onBoardUpdate?: (board: ParsedBoardData) => void;
  currentBoard?: ParsedBoardData | null;
}

export function DualAgentConversationBox({
  isVisible,
  onToggle,
  selectedSymbols,
  onClearSymbols,
  onBoardUpdate,
  currentBoard,
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
    detectionEnabled,
    setDetectionEnabled,
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
  } = useDualAgentContext();

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
              {/* Detection Toggle */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDetectionEnabled(!detectionEnabled)}
                className={`text-white hover:text-gray-200 hover:bg-white/10 ${detectionEnabled ? 'bg-white/20' : ''}`}
                title={detectionEnabled ? "Disable continuous detection" : "Enable continuous detection"}
              >
                {detectionEnabled ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
              </Button>
              {/* Voice Toggle */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setVoiceEnabled(!voiceEnabled)}
                className="text-white hover:text-gray-200 hover:bg-white/10"
                title={voiceEnabled ? "Disable voice input" : "Enable voice input"}
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
              <Button
                variant="ghost"
                size="sm"
                onClick={onToggle}
                className="text-white hover:text-gray-200 hover:bg-white/10"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* Message Display — hidden in silent mode */}
          {interactionMode === 'interact' && (
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
          )}

          {/* Voice Recording Section — hidden in silent mode */}
          {interactionMode === 'interact' && voiceEnabled && isInitialized && (
            <div className="mt-3 flex items-center justify-center gap-4">
              {/* Recording Button */}
              {!isRecording ? (
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={startVoiceRecording}
                  disabled={isLoading}
                  className="bg-white/20 hover:bg-white/30 text-white rounded-full w-14 h-14 p-0"
                >
                  <Mic className="w-6 h-6" />
                </Button>
              ) : (
                <div className="flex items-center gap-3">
                  {/* Audio Level Indicator */}
                  <div className="flex items-center gap-1">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <motion.div
                        key={i}
                        className="w-1 bg-white rounded-full"
                        animate={{
                          height: audioLevel > i * 0.2 ? `${12 + audioLevel * 20}px` : "4px",
                        }}
                        transition={{ duration: 0.1 }}
                      />
                    ))}
                  </div>

                  {/* Recording Duration */}
                  <span className="text-white text-sm font-mono min-w-[40px]">
                    {Math.floor(recordingDuration / 60)}:
                    {(recordingDuration % 60).toString().padStart(2, "0")}
                  </span>

                  {/* Stop Button */}
                  <Button
                    variant="secondary"
                    size="lg"
                    onClick={stopVoiceRecording}
                    className="bg-red-500 hover:bg-red-600 text-white rounded-full w-14 h-14 p-0 animate-pulse"
                  >
                    <Square className="w-5 h-5 fill-current" />
                  </Button>

                  {/* Cancel Button */}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={cancelVoiceRecording}
                    className="text-white/70 hover:text-white hover:bg-white/10"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              )}

              {/* Transcription Display */}
              {transcription && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-white/80 text-sm italic max-w-md truncate"
                >
                  "{transcription}"
                </motion.div>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

export default DualAgentConversationBox;
