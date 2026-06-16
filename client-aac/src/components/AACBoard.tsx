import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, Home, Volume2 } from "lucide-react";
import type { ParsedBoardData, BoardButton, BoardPage } from "@shared/schema";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useDualAgentContextOptional } from "@/contexts/DualAgentContext";
import { resolveStaticIconPath } from "@/lib/utils";
import { Glyph } from "@/components/Glyph";

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
  const dualAgent = useDualAgentContextOptional();
  const isRTL = language === "he" || language === "ar";

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

        case "open_website":
          if (button.action.url) {
            dualAgent?.launchApp("browser", { url: button.action.url, label: button.label });
          }
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
              {isRTL ? <ChevronRight className="w-6 h-6" /> : <ChevronLeft className="w-6 h-6" />}
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
      {/*
        AnimatePresence wraps the grid contents so a button removed by the
        server-side smart merge fades out (exit animation on motion.button)
        instead of disappearing instantly. AnimatePresence tracks children
        by `key`, so each motion.button must be keyed by button.id (which
        the server now keeps stable for surviving buttons across rebuilds).
        Non-motion empty cells just appear/disappear with no animation —
        that's fine, they're inert placeholders.
      */}
      <div className="flex-1 p-4 overflow-auto">
        <div
          className="grid gap-3 h-full max-w-4xl mx-auto"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
        >
          <AnimatePresence initial={false}>
          {Array.from({ length: rows * cols }, (_, index) => {
            const row = Math.floor(index / cols);
            const col = index % cols;

            // Check for spanning button covering this cell
            const spanningButton = currentPage.buttons.find(
              (b) =>
                ((b.rowSpan ?? 1) > 1 || (b.colSpan ?? 1) > 1) &&
                row >= b.row &&
                row < b.row + (b.rowSpan ?? 1) &&
                col >= b.col &&
                col < b.col + (b.colSpan ?? 1)
            );

            // If this cell is covered by a spanning button but is not its origin, skip it
            if (spanningButton && (row !== spanningButton.row || col !== spanningButton.col)) {
              return null;
            }

            // Find button at this position
            const button = currentPage.buttons.find(
              (b) => b.row === row && b.col === col
            );

            if (button) {
              const btnRowSpan = button.rowSpan ?? 1;
              const btnColSpan = button.colSpan ?? 1;
              const isSpanning = btnRowSpan > 1 || btnColSpan > 1;
              return (
                <motion.button
                  key={button.id}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: 0.18, delay: index * 0.02 }}
                  whileHover={{ scale: 1.05, boxShadow: "0 8px 25px rgba(0,0,0,0.15)" }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => handleButtonClick(button)}
                  className={`relative flex flex-col items-center justify-center p-3 rounded-2xl shadow-lg transition-all cursor-pointer touch-manipulation ${
                    button.action?.type === "link" ? "border-2 border-blue-400" :
                    button.action?.type === "back" || button.action?.type === "home" ? "border-2 border-amber-400" :
                    // Conversational role indicator: "bid" buttons (questions /
                    // requests that hand the turn over) get a violet ring so the
                    // user can tell them apart from plain replies.
                    button.role === "bid" ? "border-2 border-violet-400" :
                    ""
                  }`}
                  style={{
                    backgroundColor: getButtonColor(button.color),
                    minHeight: "80px",
                    ...(isSpanning ? {
                      gridColumn: `span ${btnColSpan}`,
                      gridRow: `span ${btnRowSpan}`,
                    } : {}),
                  }}
                >
                  {/* Symbol/Icon — priority chain:
                       1. back/home FA icon (special navigation)
                       2. button.glyph + glyphFallback (sentence-meaning glyph;
                          Glyph component swaps between them per-slot as
                          generated symbols arrive)
                       3. button.symbolPath (custom symbol / generated image)
                       4. button.iconRef (emoji or FA class)
                       5. label-derived emoji fallback */}
                  <div className="flex-1 flex items-center justify-center min-h-0 w-full">
                    {(button.action?.type === "back" || button.action?.type === "home") ? (
                      <i className={`fas ${button.action.type === "home" ? "fa-house" : isRTL ? "fa-arrow-right" : "fa-arrow-left"} text-[2.5rem] sm:text-[3rem] md:text-[3.5rem] leading-none text-gray-700`} />
                    ) : (button.glyph || button.glyphFallback) ? (
                      <Glyph
                        glyph={button.glyph}
                        fallback={button.glyphFallback}
                        noBackground
                        ariaLabel={button.label}
                      />
                    ) : button.symbolPath ? (
                      <img
                        src={resolveStaticIconPath(button.symbolPath)}
                        alt={button.label}
                        className="w-[60%] h-[60%] object-contain"
                      />
                    ) : button.iconRef && isDisplayableIcon(button.iconRef) ? (
                      <span className="text-[2.5rem] sm:text-[3rem] md:text-[3.5rem] leading-none">{button.iconRef}</span>
                    ) : button.iconRef ? (
                      <i className={`${button.iconRef} text-[2.5rem] sm:text-[3rem] md:text-[3.5rem] leading-none`} />
                    ) : (
                      <span className="text-[2.5rem] sm:text-[3rem] md:text-[3.5rem] leading-none">
                        {getEmojiForLabel(button.label)}
                      </span>
                    )}
                  </div>

                  {/* Label */}
                  <span className="flex-shrink-0 text-xs sm:text-sm font-semibold text-center leading-tight text-gray-800">
                    {button.label}
                  </span>

                  {/* Action type indicators */}
                  {button.action?.type === "link" && (
                    <span className="absolute top-1 right-1 text-blue-600 opacity-70 text-[0.6rem]">▶</span>
                  )}
                  {(button.action?.type === "back" || button.action?.type === "home") && (
                    <span className="absolute top-1 left-1 text-amber-600 opacity-70 text-[0.6rem]">◀</span>
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
          </AnimatePresence>
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

/** Returns true if the string should be rendered as text (emoji or single character) rather than a Font Awesome icon class */
function isDisplayableIcon(str: string): boolean {
  if (!str || str.startsWith('fa') || str.includes(' ')) return false;
  if ([...str].length === 1) return true;
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
