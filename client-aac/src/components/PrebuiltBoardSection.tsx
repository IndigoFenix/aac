import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, Grid3X3, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BoardButton, BoardPage } from "@shared/schema";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useBoards, type BoardData, type ButtonIR } from "@/contexts/BoardsContext";

interface PrebuiltBoardSectionProps {
  studentId: string;
  onSpeakAction: (text: string) => void;
  language?: string;
  voiceType?: string;
  onBack: () => void;
  /** When true, skip local speechSynthesis — let the AI handle speech */
  suppressLocalSpeech?: boolean;
}

// Get button background color
function getButtonColor(color?: string): string {
  const colorMap: { [key: string]: string } = {
    "yellow": "#FEF3C7",
    "blue": "#DBEAFE",
    "green": "#D1FAE5",
    "red": "#FEE2E2",
    "orange": "#FFEDD5",
    "purple": "#EDE9FE",
    "pink": "#FCE7F3",
    "white": "#FFFFFF",
    "gray": "#F3F4F6",
    "#FEF3C7": "#FEF3C7",
    "#DBEAFE": "#DBEAFE",
    "#D1FAE5": "#D1FAE5",
    "#FEE2E2": "#FEE2E2",
    "#FFEDD5": "#FFEDD5",
    "#EDE9FE": "#EDE9FE",
    "#FCE7F3": "#FCE7F3",
  };
  return colorMap[color?.toLowerCase() || "white"] || color || "#FFFFFF";
}

/** Returns true if the string should be rendered as text (emoji or single character) rather than a Font Awesome icon class */
function isDisplayableIcon(str: string): boolean {
  if (!str || str.startsWith('fa') || str.includes(' ')) return false;
  if ([...str].length === 1) return true;
  return /[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FEFF}]|[\u{1F900}-\u{1F9FF}]|[\u{2702}-\u{27B0}]|[\u{E000}-\u{F8FF}]|[\u{200D}]|[\u{20E3}]|[\u{FE0F}]|[\u{2190}-\u{21FF}]|[\u{2300}-\u{23FF}]|[\u{2460}-\u{24FF}]|[\u{25A0}-\u{25FF}]|[\u{2B00}-\u{2BFF}]|[\u{3000}-\u{303F}]|[\u{3200}-\u{32FF}]|[\u{1F100}-\u{1F1FF}]|[\u{1F200}-\u{1F2FF}]|[\u{1F300}-\u{1F5FF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F700}-\u{1F77F}]/u.test(str);
}

// Map label to emoji
function getEmojiForLabel(label: string): string {
  const emojiMap: { [key: string]: string } = {
    "hello": "👋", "hi": "👋", "hey": "👋",
    "yes": "✅", "no": "❌", "maybe": "🤔",
    "help": "🆘", "please": "🙏", "thank you": "🙏", "thanks": "🙏",
    "more": "➕", "less": "➖", "stop": "🛑",
    "eat": "🍽️", "food": "🍽️", "hungry": "🍽️",
    "drink": "🥤", "water": "💧", "thirsty": "💧",
    "happy": "😊", "sad": "😢", "angry": "😠", "tired": "😴",
    "play": "🎮", "game": "🎮", "fun": "🎉",
    "home": "🏠", "school": "🏫", "outside": "🌳",
    "mom": "👩", "dad": "👨", "family": "👨‍👩‍👧",
    "love": "❤️", "like": "👍", "want": "👆",
    "go": "🚶", "come": "👋", "wait": "⏳",
  };

  const lowerLabel = label.toLowerCase();
  for (const [key, emoji] of Object.entries(emojiMap)) {
    if (lowerLabel.includes(key)) {
      return emoji;
    }
  }
  return "💬";
}

export default function PrebuiltBoardSection({
  studentId,
  onSpeakAction,
  language = "en",
  voiceType,
  onBack,
  suppressLocalSpeech = false,
}: PrebuiltBoardSectionProps) {
  const [selectedBoard, setSelectedBoard] = useState<BoardData | null>(null);
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);
  const [pageHistory, setPageHistory] = useState<string[]>([]);
  const { speak } = useTextToSpeech();

  // Get boards from context (pre-fetched during initialization)
  const { boards, isLoading } = useBoards();

  // Get current page
  const currentPage = selectedBoard?.irData?.pages?.find(
    (p) => p.id === currentPageId
  ) || selectedBoard?.irData?.pages?.[0];

  // Get grid dimensions
  const grid = currentPage?.layout || selectedBoard?.irData?.grid || { rows: 4, cols: 4 };

  // Compute icon/text font sizes dynamically based on available height and row count.
  // Available height ≈ 100dvh - header (6rem) - quickActions (~3.5rem) - board header (~2.5rem) - padding (~1rem) = 100dvh - 13rem
  const iconFontSize = `clamp(1rem, calc((100dvh - 13rem) / ${grid.rows} * 0.42), 6rem)`;
  const textFontSize = `clamp(0.5rem, calc((100dvh - 13rem) / ${grid.rows} * 0.10), 1rem)`;

  // Navigate to a page
  const navigateToPage = useCallback((pageId: string) => {
    if (currentPageId) {
      setPageHistory((prev) => [...prev, currentPageId]);
    }
    setCurrentPageId(pageId);
  }, [currentPageId]);

  // Go back to previous page
  const goBack = useCallback(() => {
    if (pageHistory.length > 0) {
      const prevPageId = pageHistory[pageHistory.length - 1];
      setPageHistory((prev) => prev.slice(0, -1));
      setCurrentPageId(prevPageId);
    } else if (selectedBoard) {
      // If no history, go back to board selection
      setSelectedBoard(null);
      setCurrentPageId(null);
    } else {
      // If no board selected, call parent onBack
      onBack();
    }
  }, [pageHistory, selectedBoard, onBack]);

  // Expose goBack to parent
  useEffect(() => {
    // Store the goBack function on window for parent access
    (window as any).__prebuiltBoardGoBack = goBack;
    return () => {
      delete (window as any).__prebuiltBoardGoBack;
    };
  }, [goBack]);

  // Handle button click
  const handleButtonClick = (button: ButtonIR) => {
    // Handle navigation actions (don't speak or send to chat)
    if (button.action?.type === "link" && button.action.toPageId) {
      navigateToPage(button.action.toPageId);
      return;
    }

    // Handle back action (navigate back without speaking)
    if (button.action?.type === "back") {
      goBack();
      return;
    }

    // Handle home action (go to first page without speaking)
    if (button.action?.type === "home") {
      if (selectedBoard?.irData?.pages?.[0]?.id) {
        setPageHistory([]);
        setCurrentPageId(selectedBoard.irData.pages[0].id);
      }
      return;
    }

    // Speak the text and send to chat
    const textToSpeak = button.action?.text || button.spokenText || button.label;
    if (!suppressLocalSpeech) {
      speak(textToSpeak, language, voiceType as any);
    }
    onSpeakAction(textToSpeak);
  };

  // Select a board
  const selectBoard = (board: BoardData) => {
    setSelectedBoard(board);
    setCurrentPageId(board.irData?.pages?.[0]?.id || null);
    setPageHistory([]);
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  // No boards available
  if (!boards || boards.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 p-4">
        <Grid3X3 className="w-8 h-8 mb-2" />
        <p className="text-sm text-center">No boards available</p>
        <p className="text-xs text-center mt-1">Create boards in the admin panel</p>
      </div>
    );
  }

  // Board selection view
  if (!selectedBoard) {
    return (
      <div className="h-full flex flex-col">
        <div className="p-2 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Select a Board
          </h3>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          <div className="grid grid-cols-2 gap-2">
            {boards.filter(b => b.irData).map((board) => (
              <motion.button
                key={board.id}
                onClick={() => selectBoard(board)}
                className="flex flex-col items-center justify-center p-3 rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-sm"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                <Grid3X3 className="w-8 h-8 text-primary mb-2" />
                <span className="text-sm font-medium text-gray-800 dark:text-gray-200 text-center">
                  {board.name}
                </span>
              </motion.button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Board navigation view
  if (!currentPage) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        <p className="text-sm">Board has no pages</p>
      </div>
    );
  }

  // Create grid cells
  const cells: (ButtonIR | null)[][] = Array(grid.rows)
    .fill(null)
    .map(() => Array(grid.cols).fill(null));

  currentPage.buttons.forEach((button) => {
    if (button.row < grid.rows && button.col < grid.cols) {
      cells[button.row][button.col] = button;
    }
  });

  return (
    <div className="h-full flex flex-col">
      {/* Header with board name and back button */}
      <div className="flex items-center justify-between p-2 border-b border-gray-200 dark:border-gray-700">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSelectedBoard(null);
            setCurrentPageId(null);
            setPageHistory([]);
          }}
          className="text-xs"
        >
          <ChevronLeft className="w-4 h-4 mr-1" />
          Boards
        </Button>
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400 truncate">
          {currentPage.name || selectedBoard.name}
        </span>
      </div>

      {/* Board grid */}
      <div className="flex-1 p-2 overflow-hidden min-h-0">
        <div
          className="grid gap-1 h-full"
          style={{
            gridTemplateColumns: `repeat(${grid.cols}, 1fr)`,
            gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))`,
          }}
        >
          {cells.flat().map((button, index) => {
            if (!button) {
              return (
                <div
                  key={`empty-${index}`}
                  className="rounded-lg bg-gray-100 dark:bg-gray-800 opacity-30"
                />
              );
            }

            const isLink = button.action?.type === "link";

            return (
              <motion.button
                key={button.id}
                onClick={() => handleButtonClick(button)}
                className="flex flex-col items-center justify-center p-1 rounded-lg shadow-sm border border-gray-200 dark:border-gray-600 relative overflow-hidden min-h-0"
                style={{ backgroundColor: getButtonColor(button.color) }}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.95 }}
              >
                <div className="flex-[3] flex items-center justify-center min-h-0 w-full overflow-hidden">
                  {button.symbolPath ? (
                    <img
                      src={button.symbolPath}
                      alt={button.label}
                      className="object-contain"
                      style={{ width: "55%", height: "55%", maxHeight: "100%" }}
                    />
                  ) : button.iconRef && isDisplayableIcon(button.iconRef) ? (
                    <span style={{ fontSize: iconFontSize, lineHeight: 1 }}>{button.iconRef}</span>
                  ) : button.iconRef ? (
                    <i className={button.iconRef} style={{ fontSize: iconFontSize, lineHeight: 1 }} />
                  ) : (
                    <span style={{ fontSize: iconFontSize, lineHeight: 1 }}>
                      {getEmojiForLabel(button.label)}
                    </span>
                  )}
                </div>
                <span className="font-medium text-center text-gray-800 leading-tight line-clamp-2" style={{ fontSize: textFontSize }}>
                  {button.label}
                </span>
                {isLink && (
                  <div className="absolute top-0.5 right-0.5 w-2 h-2 bg-blue-500 rounded-full" />
                )}
              </motion.button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
