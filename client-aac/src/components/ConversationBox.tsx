import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Volume2, VolumeX, MessageCircle, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { ParsedBoardData } from "@shared/schema";
import { useConversation } from "@/contexts/ConversationContext";

interface ConversationBoxProps {
  studentId: string;
  userProfile?: {
    name?: string;
    age?: number;
  };
  isVisible: boolean;
  onToggle: () => void;
  selectedSymbols?: string[];
  onClearSymbols?: () => void;
  visualContext?: string;
  language?: string;
  captureFrame?: () => Promise<Blob | null>;
  onBoardUpdate?: (board: ParsedBoardData) => void;
  currentBoard?: ParsedBoardData | null;
}

export function ConversationBox({
  studentId,
  userProfile,
  isVisible,
  onToggle,
  selectedSymbols,
  onClearSymbols,
  visualContext,
  language = "en",
  captureFrame,
  onBoardUpdate,
  currentBoard
}: ConversationBoxProps) {
  const {
    currentMessage,
    isLoading,
    isInitialized,
    error,
    audioEnabled,
    isPlaying,
    initialize,
    sendMessage,
    clearConversation,
    setAudioEnabled,
    playMessageAudio,
    setCaptureFrame,
    setCurrentBoard,
    setOnBoardUpdate,
  } = useConversation();

  const hasInitializedRef = useRef(false);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Set up capture frame function
  useEffect(() => {
    setCaptureFrame(captureFrame || null);
  }, [captureFrame, setCaptureFrame]);

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
      console.log('[ConversationBox] Initialization error detected, will retry in 2s:', error);
      // Clear any existing retry timeout
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
      // Reset the ref after a delay to allow retry
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

  // Handle symbol selection from parent - works even when panel is hidden
  useEffect(() => {
    if (selectedSymbols && selectedSymbols.length > 0 && isInitialized) {
      // Send symbols as user response
      const message = selectedSymbols.join(' ');
      sendMessage(message, true);
      // Clear the symbols in parent
      if (onClearSymbols) {
        setTimeout(() => onClearSymbols(), 1000);
      }
    }
  }, [selectedSymbols, isInitialized, sendMessage, onClearSymbols]);

  const handleReplayAudio = () => {
    if (currentMessage && !isPlaying) {
      playMessageAudio(currentMessage);
    }
  };

  const handleClearConversation = async () => {
    hasInitializedRef.current = false;
    await clearConversation();
  };

  if (!isVisible) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: "-100%" }}
        animate={{ y: 0 }}
        exit={{ y: "-100%" }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className="fixed top-0 left-0 right-0 z-50 bg-primary text-white shadow-lg"
      >
        <div className="px-4 py-3">
          {/* Floating Header Bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <MessageCircle className="w-5 h-5 text-white" />
              <span className="font-medium text-white">Chat Assistant</span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAudioEnabled(!audioEnabled)}
                className="text-white hover:text-gray-200 hover:bg-white/10"
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

          {/* Message Display */}
          <div className="flex items-center justify-center mt-3">
            {isLoading ? (
              <div className="flex items-center gap-2 text-white">
                <div className="w-2 h-2 bg-white rounded-full animate-bounce" />
                <div className="w-2 h-2 bg-white rounded-full animate-bounce" style={{animationDelay: '0.1s'}} />
                <div className="w-2 h-2 bg-white rounded-full animate-bounce" style={{animationDelay: '0.2s'}} />
                <span className="ml-2 text-sm">Thinking...</span>
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
                  onClick={audioEnabled ? handleReplayAudio : undefined}
                  className={`text-sm text-white font-medium leading-relaxed flex-1 mr-3 ${
                    audioEnabled ? 'cursor-pointer hover:text-gray-200 transition-colors' : ''
                  }`}
                >
                  <MessageCircle className="w-4 h-4 inline mr-2" />
                  {currentMessage.content}
                  {audioEnabled && (
                    <Volume2 className="w-3 h-3 inline ml-2 opacity-60" />
                  )}
                </motion.div>

                <div className="flex items-center gap-2">
                  {isPlaying && (
                    <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleClearConversation}
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

        </div>
      </motion.div>
    </AnimatePresence>
  );
}
