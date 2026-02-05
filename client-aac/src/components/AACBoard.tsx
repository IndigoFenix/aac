import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, Home, Volume2 } from "lucide-react";
import type { ParsedBoardData, BoardButton, BoardPage } from "@shared/schema";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";

interface AACBoardProps {
  board: ParsedBoardData | null;
  onButtonClick: (button: BoardButton, spokenText: string) => void;
  language?: string;
  voiceType?: string;
}

// Color palette for buttons (similar to Grid3 style)
const BUTTON_COLORS: Record<string, string> = {
  yellow: "#FFD93D",
  blue: "#6ECBF5",
  green: "#7DD87D",
  red: "#FF6B6B",
  orange: "#FFA94D",
  purple: "#B197FC",
  pink: "#F783AC",
  white: "#FFFFFF",
  gray: "#CED4DA",
};

function getButtonColor(color?: string): string {
  if (!color) return BUTTON_COLORS.white;
  return BUTTON_COLORS[color.toLowerCase()] || color;
}

export default function AACBoard({ board, onButtonClick, language = "en", voiceType }: AACBoardProps) {
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);
  const [pageHistory, setPageHistory] = useState<string[]>([]);
  const { speak, isSpeaking } = useTextToSpeech();

  // Get current page
  const getCurrentPage = useCallback((): BoardPage | null => {
    if (!board || !board.pages || board.pages.length === 0) return null;

    const pageId = currentPageId || board.currentPageId || board.pages[0]?.id;
    return board.pages.find(p => p.id === pageId) || board.pages[0];
  }, [board, currentPageId]);

  const currentPage = getCurrentPage();

  // Handle button click
  const handleButtonClick = useCallback((button: BoardButton) => {
    const textToSpeak = button.spokenText || button.label;

    // Handle action
    if (button.action) {
      switch (button.action.type) {
        case "link":
          if (button.action.toPageId) {
            // Save current page to history for back navigation
            if (currentPage) {
              setPageHistory(prev => [...prev, currentPage.id]);
            }
            setCurrentPageId(button.action.toPageId);
          }
          return; // Don't speak or send for navigation

        case "speak":
          // Use action text if provided, otherwise use button text
          const speakText = button.action.text || textToSpeak;
          speak(speakText, language, voiceType as any);
          onButtonClick(button, speakText);
          return;
      }
    }

    // Default: speak and send
    speak(textToSpeak, language, voiceType as any);
    onButtonClick(button, textToSpeak);
  }, [currentPage, speak, language, onButtonClick]);

  // Navigate back
  const handleBack = useCallback(() => {
    if (pageHistory.length > 0) {
      const newHistory = [...pageHistory];
      const previousPageId = newHistory.pop();
      setPageHistory(newHistory);
      setCurrentPageId(previousPageId || null);
    }
  }, [pageHistory]);

  // Navigate to home (first page)
  const handleHome = useCallback(() => {
    if (board && board.pages.length > 0) {
      setPageHistory([]);
      setCurrentPageId(board.pages[0].id);
    }
  }, [board]);

  // Loading/empty state
  if (!board || !currentPage) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center"
        >
          <div className="text-6xl mb-4">🎯</div>
          <h2 className="text-2xl font-bold text-gray-700 dark:text-gray-200 mb-2">
            Loading Board...
          </h2>
          <p className="text-gray-500 dark:text-gray-400">
            Start a conversation to generate your communication board
          </p>
        </motion.div>
      </div>
    );
  }

  const { rows, cols } = board.grid;

  return (
    <div className="flex flex-col h-full">
      {/* Navigation header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-100 dark:bg-gray-800 border-b">
        <div className="flex items-center gap-2">
          {pageHistory.length > 0 && (
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              onClick={handleBack}
              className="p-2 rounded-lg bg-white dark:bg-gray-700 shadow-sm hover:shadow-md transition-shadow"
            >
              <ChevronLeft className="w-6 h-6" />
            </motion.button>
          )}
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={handleHome}
            className="p-2 rounded-lg bg-white dark:bg-gray-700 shadow-sm hover:shadow-md transition-shadow"
          >
            <Home className="w-6 h-6" />
          </motion.button>
        </div>

        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">
          {currentPage.name}
        </h2>

        <div className="flex items-center gap-2">
          {isSpeaking && (
            <motion.div
              animate={{ scale: [1, 1.2, 1] }}
              transition={{ repeat: Infinity, duration: 0.8 }}
            >
              <Volume2 className="w-6 h-6 text-blue-500" />
            </motion.div>
          )}
        </div>
      </div>

      {/* Board grid */}
      <div className="flex-1 p-4 overflow-auto">
        <div
          className="grid gap-3 h-full max-w-4xl mx-auto"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
        >
          {Array.from({ length: rows * cols }, (_, index) => {
            const row = Math.floor(index / cols);
            const col = index % cols;

            // Find button at this position
            const button = currentPage.buttons.find(
              (b) => b.row === row && b.col === col
            );

            if (button) {
              return (
                <motion.button
                  key={button.id}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: index * 0.02 }}
                  whileHover={{ scale: 1.05, boxShadow: "0 8px 25px rgba(0,0,0,0.15)" }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => handleButtonClick(button)}
                  className="relative flex flex-col items-center justify-center p-3 rounded-2xl shadow-lg transition-all cursor-pointer touch-manipulation"
                  style={{
                    backgroundColor: getButtonColor(button.color),
                    minHeight: "80px",
                  }}
                >
                  {/* Symbol/Icon */}
                  {button.symbolPath ? (
                    <img
                      src={button.symbolPath}
                      alt={button.label}
                      className="w-12 h-12 object-contain mb-1"
                    />
                  ) : button.iconRef && isEmoji(button.iconRef) ? (
                    <span className="text-3xl mb-1">{button.iconRef}</span>
                  ) : button.iconRef ? (
                    <i className={`${button.iconRef} text-3xl mb-1`} />
                  ) : (
                    <div className="text-3xl mb-1">
                      {getEmojiForLabel(button.label)}
                    </div>
                  )}

                  {/* Label */}
                  <span className="text-sm font-semibold text-center leading-tight text-gray-800">
                    {button.label}
                  </span>

                  {/* Link indicator */}
                  {button.action?.type === "link" && (
                    <div className="absolute top-1 right-1 w-3 h-3 bg-blue-500 rounded-full" />
                  )}
                </motion.button>
              );
            }

            // Empty cell
            return (
              <div
                key={`empty-${row}-${col}`}
                className="rounded-2xl bg-gray-100 dark:bg-gray-800 opacity-30"
              />
            );
          })}
        </div>
      </div>

      {/* Page indicator */}
      {board.pages.length > 1 && (
        <div className="flex justify-center gap-2 py-2 bg-gray-100 dark:bg-gray-800 border-t">
          {board.pages.map((page) => (
            <motion.button
              key={page.id}
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              onClick={() => {
                if (currentPage) {
                  setPageHistory(prev => [...prev, currentPage.id]);
                }
                setCurrentPageId(page.id);
              }}
              className={`w-3 h-3 rounded-full transition-colors ${
                page.id === currentPage.id
                  ? "bg-blue-500"
                  : "bg-gray-400 hover:bg-gray-500"
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Simple emoji mapping for common words (fallback when no symbol)
// Check if a string is an emoji (not a FontAwesome class)
function isEmoji(str: string): boolean {
  if (!str || str.startsWith('fa') || str.includes(' ')) return false;
  return /[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FEFF}]|[\u{1F900}-\u{1F9FF}]|[\u{2702}-\u{27B0}]|[\u{E000}-\u{F8FF}]|[\u{200D}]|[\u{20E3}]|[\u{FE0F}]|[\u{2190}-\u{21FF}]|[\u{2300}-\u{23FF}]|[\u{2460}-\u{24FF}]|[\u{25A0}-\u{25FF}]|[\u{2B00}-\u{2BFF}]|[\u{3000}-\u{303F}]|[\u{3200}-\u{32FF}]|[\u{1F100}-\u{1F1FF}]|[\u{1F200}-\u{1F2FF}]|[\u{1F300}-\u{1F5FF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F700}-\u{1F77F}]/u.test(str);
}

function getEmojiForLabel(label: string): string {
  const emojiMap: Record<string, string> = {
    // Common AAC words
    "yes": "✅",
    "no": "❌",
    "help": "🆘",
    "more": "➕",
    "stop": "🛑",
    "go": "🚀",
    "want": "👋",
    "like": "❤️",
    "eat": "🍽️",
    "drink": "🥤",
    "play": "🎮",
    "sleep": "😴",
    "happy": "😊",
    "sad": "😢",
    "angry": "😠",
    "hurt": "🤕",
    "bathroom": "🚽",
    "home": "🏠",
    "school": "🏫",
    "mom": "👩",
    "dad": "👨",
    "friend": "👫",
    "hello": "👋",
    "goodbye": "👋",
    "please": "🙏",
    "thank you": "🙏",
    "sorry": "😔",
    "i": "👤",
    "you": "👉",
    "we": "👥",
    "they": "👥",
  };

  const lowerLabel = label.toLowerCase();
  return emojiMap[lowerLabel] || "💬";
}
