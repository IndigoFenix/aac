import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { ParsedBoardData, BoardButton } from "@shared/schema";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useLanguage } from "@/contexts/LanguageContext";
import { ArrowLeft } from "lucide-react";

export interface BoardPatch {
  add: Array<{ label: string; iconRef: string }>;
  remove: string[];
}

interface DynamicBoardProps {
  board: ParsedBoardData | null;
  boardPatch?: BoardPatch | null;
  /** AI pressed a navigation button — navigate to target page */
  aiButtonPress?: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: BoardButton[] } | null;
  onButtonClick: (button: BoardButton, spokenText: string) => void;
  onBack?: () => void;
  /** Called when user or AI navigates to a different page within a multi-page board */
  onNavigate?: (pageId: string, pageName: string, buttons: BoardButton[]) => void;
  language?: string;
  voiceType?: string;
  /** Resolve a contact face image from client-side cache */
  getFaceImage?: (contactId: string) => string | null;
  /** When true, skip local speechSynthesis — let the AI handle speech via [INTERPRET] */
  suppressLocalSpeech?: boolean;
  /** Icon-to-text size ratio 1–5 (1=mostly icon, 5=mostly text). Default 3 (balanced). */
  iconTextRatio?: number;
}

/**
 * Sizing config for each icon-text ratio level.
 * iconFlex/textFlex control vertical space allocation.
 * iconClass controls emoji/FA font size, textClass controls label font size.
 * imgSize controls symbol/face image size as percentage.
 */
const RATIO_LEVELS: Record<number, {
  iconFlex: number;
  textFlex: number;
  iconClass: string;
  textClass: string;
  imgSize: string;
}> = {
  1: { iconFlex: 9, textFlex: 1, iconClass: "text-[4rem] sm:text-[6rem] md:text-[8rem]", textClass: "text-[8px] sm:text-[9px]", imgSize: "70%" },
  2: { iconFlex: 4, textFlex: 1, iconClass: "text-[3.5rem] sm:text-[5.5rem] md:text-[7.5rem]", textClass: "text-[9px] sm:text-[10px]", imgSize: "65%" },
  3: { iconFlex: 3, textFlex: 1, iconClass: "text-[3rem] sm:text-[5rem] md:text-[7rem]", textClass: "text-xs", imgSize: "60%" },
  4: { iconFlex: 2, textFlex: 1, iconClass: "text-[2rem] sm:text-[3.5rem] md:text-[5rem]", textClass: "text-xs sm:text-sm", imgSize: "50%" },
  5: { iconFlex: 1, textFlex: 2, iconClass: "text-[1.5rem] sm:text-[2.5rem] md:text-[3.5rem]", textClass: "text-sm sm:text-base md:text-lg", imgSize: "40%" },
};

/** Slot state for the grid */
type SlotState =
  | { type: "occupied"; button: BoardButton; anim: "stable" | "entering" }
  | { type: "fading"; button: BoardButton; replaceWith?: BoardButton }
  | { type: "blank" };

const DEFAULT_ROWS = 3;
const DEFAULT_COLS = 4;
const BLANK_SLOT: SlotState = { type: "blank" };

// Check if a string is an emoji (not a FontAwesome class)
function isEmoji(str: string): boolean {
  if (!str || str.startsWith("fa") || str.includes(" ")) return false;
  return /[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FEFF}]|[\u{1F900}-\u{1F9FF}]|[\u{2702}-\u{27B0}]|[\u{E000}-\u{F8FF}]|[\u{200D}]|[\u{20E3}]|[\u{FE0F}]|[\u{2190}-\u{21FF}]|[\u{2300}-\u{23FF}]|[\u{2460}-\u{24FF}]|[\u{25A0}-\u{25FF}]|[\u{2B00}-\u{2BFF}]|[\u{3000}-\u{303F}]|[\u{3200}-\u{32FF}]|[\u{1F100}-\u{1F1FF}]|[\u{1F200}-\u{1F2FF}]|[\u{1F300}-\u{1F5FF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F700}-\u{1F77F}]/u.test(str);
}

// Map label to emoji fallback
function getEmojiForLabel(label: string): string {
  const emojiMap: { [key: string]: string } = {
    hello: "👋", hi: "👋", hey: "👋",
    yes: "✅", no: "❌", maybe: "🤔",
    help: "🆘", please: "🙏", "thank you": "🙏", thanks: "🙏",
    more: "➕", less: "➖", stop: "🛑",
    eat: "🍽️", food: "🍽️", hungry: "🍽️",
    drink: "🥤", water: "💧", thirsty: "💧",
    happy: "😊", sad: "😢", angry: "😠", tired: "😴",
    play: "🎮", game: "🎮", fun: "🎉",
    home: "🏠", school: "🏫", outside: "🌳",
    mom: "👩", dad: "👨", family: "👨‍👩‍👧",
    love: "❤️", like: "👍", want: "👆",
    go: "🚶", come: "👋", wait: "⏳",
    bath: "🛁", toilet: "🚽", sleep: "😴",
  };
  const lower = label.toLowerCase();
  for (const [key, emoji] of Object.entries(emojiMap)) {
    if (lower.includes(key)) return emoji;
  }
  return "💬";
}

function getButtonColor(color?: string): string {
  const colorMap: { [key: string]: string } = {
    yellow: "#FEF3C7", blue: "#DBEAFE", green: "#D1FAE5",
    red: "#FEE2E2", orange: "#FFEDD5", purple: "#EDE9FE",
    pink: "#FCE7F3", white: "#FFFFFF", gray: "#F3F4F6",
  };
  return colorMap[color?.toLowerCase() || "white"] || color || "#FFFFFF";
}

/** Create a BoardButton from a patch add entry */
function makeBoardButton(entry: { label: string; iconRef: string; symbolPath?: string }, index: number): BoardButton {
  return {
    id: `btn-patch-${Date.now()}-${index}`,
    label: entry.label,
    spokenText: entry.label,
    row: 0,
    col: 0,
    iconRef: entry.iconRef,
    symbolPath: entry.symbolPath,
    action: { type: "speak", text: entry.label },
  } as BoardButton;
}

export default function DynamicBoard({
  board,
  boardPatch,
  aiButtonPress,
  onButtonClick,
  onBack,
  onNavigate,
  language = "en",
  voiceType,
  getFaceImage,
  suppressLocalSpeech = false,
  iconTextRatio = 3,
}: DynamicBoardProps) {
  const { speak } = useTextToSpeech();
  const { t } = useLanguage();

  // Icon/text sizing based on ratio level
  const level = RATIO_LEVELS[Math.max(1, Math.min(5, iconTextRatio))] || RATIO_LEVELS[3];

  // Grid dimensions from board data
  const gridRows = board?.grid?.rows || DEFAULT_ROWS;
  const gridCols = board?.grid?.cols || DEFAULT_COLS;
  const totalSlots = gridRows * gridCols;

  // Multi-page navigation state
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);
  const [pageHistory, setPageHistory] = useState<string[]>([]);
  const isMultiPage = (board?.pages?.length || 0) > 1;

  const [slots, setSlots] = useState<SlotState[]>(Array(totalSlots).fill(BLANK_SLOT));
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPatchRef = useRef<BoardPatch | null>(null);
  const prevBoardRef = useRef<ParsedBoardData | null>(null);

  // Reset page state when board identity changes
  useEffect(() => {
    if (board && board !== prevBoardRef.current) {
      // Different board object — reset navigation
      const firstPageId = board.pages?.[0]?.id || null;
      setCurrentPageId(firstPageId);
      setPageHistory([]);
      prevBoardRef.current = board;
    }
  }, [board]);

  // Get current page based on navigation state
  const getCurrentPage = useCallback(() => {
    if (!board?.pages?.length) return null;
    if (currentPageId) {
      const found = board.pages.find(p => p.id === currentPageId);
      if (found) return found;
    }
    return board.pages[0];
  }, [board, currentPageId]);

  // Full board update — from board prop or page navigation
  useEffect(() => {
    if (!board || !board.pages || board.pages.length === 0) {
      setSlots(Array(totalSlots).fill(BLANK_SLOT));
      return;
    }

    const page = getCurrentPage();
    const buttons: BoardButton[] = page?.buttons || [];

    setSlots(
      Array.from({ length: totalSlots }, (_, i): SlotState => {
        if (i < buttons.length) {
          return { type: "occupied", button: buttons[i], anim: "entering" };
        }
        return BLANK_SLOT;
      })
    );
  }, [board, currentPageId, totalSlots, getCurrentPage]);

  // Patch update — from boardPatch prop (detection)
  useEffect(() => {
    if (!boardPatch || boardPatch === lastPatchRef.current) return;
    lastPatchRef.current = boardPatch;

    const { add, remove } = boardPatch;
    if (add.length === 0 && remove.length === 0) return;

    const removeLower = new Set(remove.map((r) => r.toLowerCase().trim()));

    setSlots((prev) => {
      const next = [...prev];

      // Step 1: Mark buttons to remove as fading
      for (let i = 0; i < next.length; i++) {
        const slot = next[i];
        if (
          (slot.type === "occupied") &&
          removeLower.has(slot.button.label.toLowerCase().trim())
        ) {
          next[i] = { type: "fading", button: slot.button };
        }
      }

      // Step 2: Place new buttons in blank slots first
      let addIndex = 0;
      for (let i = 0; i < next.length && addIndex < add.length; i++) {
        if (next[i].type === "blank") {
          next[i] = {
            type: "occupied",
            button: makeBoardButton(add[addIndex], addIndex),
            anim: "entering",
          };
          addIndex++;
        }
      }

      // Step 3: Queue remaining new buttons as replacements for fading slots
      for (let i = 0; i < next.length && addIndex < add.length; i++) {
        if (next[i].type === "fading" && !(next[i] as any).replaceWith) {
          next[i] = {
            type: "fading",
            button: (next[i] as { type: "fading"; button: BoardButton }).button,
            replaceWith: makeBoardButton(add[addIndex], addIndex),
          };
          addIndex++;
        }
      }

      return next;
    });

    // After fade animation completes: replace fading slots with queued buttons or blank.
    // Only reset timer when this patch includes removes (which creates new fading slots).
    // Add-only patches must NOT clear an existing timer — otherwise fading slots from a
    // previous remove would never complete their transition (stuck invisible forever).
    if (remove.length > 0) {
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = setTimeout(() => {
        setSlots((prev) =>
          prev.map((s): SlotState => {
            if (s.type !== "fading") return s;
            if (s.replaceWith) {
              return { type: "occupied", button: s.replaceWith, anim: "entering" };
            }
            return BLANK_SLOT;
          })
        );
      }, 1500);
    }
  }, [boardPatch]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, []);

  // Navigate to a linked page
  const navigateToPage = useCallback((targetPageId: string) => {
    if (!board?.pages) return;
    const targetPage = board.pages.find(p => p.id === targetPageId);
    if (!targetPage) return;

    // Push current page to history
    if (currentPageId) {
      setPageHistory(prev => [...prev, currentPageId]);
    }
    setCurrentPageId(targetPageId);

    // Notify parent about navigation
    onNavigate?.(targetPageId, targetPage.name || "Page", targetPage.buttons || []);
  }, [board, currentPageId, onNavigate]);

  // Go back to previous page
  const navigateBack = useCallback(() => {
    if (pageHistory.length === 0) return;
    const prevPageId = pageHistory[pageHistory.length - 1];
    setPageHistory(prev => prev.slice(0, -1));
    setCurrentPageId(prevPageId);

    const prevPage = board?.pages?.find(p => p.id === prevPageId);
    if (prevPage) {
      onNavigate?.(prevPageId, prevPage.name || "Page", prevPage.buttons || []);
    }
  }, [pageHistory, board, onNavigate]);

  // Go to home (first) page
  const navigateHome = useCallback(() => {
    const firstPage = board?.pages?.[0];
    if (!firstPage) return;
    setPageHistory([]);
    setCurrentPageId(firstPage.id);
    onNavigate?.(firstPage.id, firstPage.name || "Home", firstPage.buttons || []);
  }, [board, onNavigate]);

  // Handle AI button press — navigate to the target page
  const lastAiPressRef = useRef(aiButtonPress);
  useEffect(() => {
    if (!aiButtonPress || aiButtonPress === lastAiPressRef.current) return;
    lastAiPressRef.current = aiButtonPress;

    if (aiButtonPress.action === "link" && aiButtonPress.targetPageId) {
      navigateToPage(aiButtonPress.targetPageId);
    } else if (aiButtonPress.action === "back") {
      navigateBack();
    } else if (aiButtonPress.action === "home") {
      navigateHome();
    }
  }, [aiButtonPress, navigateToPage, navigateBack, navigateHome]);

  const handleButtonClick = useCallback(
    (button: BoardButton) => {
      const action = button.action;

      // Handle navigation actions
      if (action?.type === "link" && action.toPageId) {
        navigateToPage(action.toPageId);
        return;
      }
      if (action?.type === "back") {
        navigateBack();
        return;
      }
      if (action?.type === "home") {
        navigateHome();
        return;
      }

      // Default: speak action
      const textToSpeak = button.spokenText || button.label;
      if (!suppressLocalSpeech) {
        speak(textToSpeak, language, voiceType as any);
      }
      onButtonClick(button, textToSpeak);
    },
    [speak, language, voiceType, onButtonClick, navigateToPage, navigateBack, navigateHome, suppressLocalSpeech]
  );

  // Render nothing if completely empty
  const hasAnyContent = slots.some((s) => s.type !== "blank") || board;

  if (!hasAnyContent) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        <p className="text-sm">AI suggestions will appear here</p>
      </div>
    );
  }

  const currentPage = getCurrentPage();
  const canGoBack = pageHistory.length > 0;

  const renderSlot = (slot: SlotState, index: number) => {
    if (slot.type === "blank") {
      return (
        <div
          key={`blank-${index}`}
          className="flex items-center justify-center rounded-xl border-2 border-dashed border-gray-200 dark:border-gray-700 min-h-0"
        />
      );
    }

    if (slot.type === "fading") {
      const { button } = slot;
      return (
        <motion.div
          key={`fading-${button.label}-${index}`}
          initial={{ opacity: 1, scale: 1 }}
          animate={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 1.5 }}
          className="flex flex-col items-center justify-center p-2 rounded-xl shadow-sm border border-gray-200 pointer-events-none min-h-0"
          style={{ backgroundColor: getButtonColor(button.color) }}
        >
          <div className="flex items-center justify-center min-h-0 w-full" style={{ flex: level.iconFlex }}>
            {renderIcon(button)}
          </div>
          <div className="flex items-center justify-center w-full overflow-hidden" style={{ flex: level.textFlex }}>
            <span className={`${level.textClass} font-medium text-center text-gray-800 leading-tight`}>
              {button.label}
            </span>
          </div>
        </motion.div>
      );
    }

    // occupied
    const { button, anim } = slot;
    const isEntering = anim === "entering";
    const isLinkButton = button.action?.type === "link";

    return (
      <motion.button
        data-dwell
        key={`btn-${button.label}-${index}`}
        initial={isEntering ? { opacity: 0, scale: 0.8 } : { opacity: 1, scale: 1 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: isEntering ? 0.3 : 0.15 }}
        onClick={() => handleButtonClick(button)}
        className={`flex flex-col items-center justify-center p-2 rounded-xl shadow-sm border min-h-0 overflow-hidden ${isLinkButton ? "border-blue-300 ring-1 ring-blue-200" : "border-gray-200"}`}
        style={{ backgroundColor: getButtonColor(button.color) }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
      >
        <div className="flex items-center justify-center min-h-0 w-full" style={{ flex: level.iconFlex }}>
          {renderIcon(button)}
        </div>
        <div className="flex items-center justify-center w-full overflow-hidden" style={{ flex: level.textFlex }}>
          <span className={`${level.textClass} font-medium text-center text-gray-800 leading-tight line-clamp-2`}>
            {button.label}
          </span>
        </div>
      </motion.button>
    );
  };

  const renderIcon = (button: BoardButton) => {
    const imgStyle = { width: level.imgSize, height: level.imgSize };
    // Resolve __FACE__:contactId to cached face image
    if (button.symbolPath?.startsWith("__FACE__:")) {
      const contactId = button.symbolPath.substring(9);
      const cached = getFaceImage?.(contactId);
      if (cached) {
        return <img src={cached} alt={button.label} className="object-contain rounded-full" style={imgStyle} />;
      }
      return <span className={`${level.iconClass} leading-none`}>👤</span>;
    }
    // Resolve __SYMBOL__:symbolId to custom symbol image
    if (button.symbolPath?.startsWith("__SYMBOL__:")) {
      const symbolId = button.symbolPath.substring(11);
      return <img src={`/api/custom-symbols/${symbolId}/image`} alt={button.label} className="object-contain" style={imgStyle} loading="lazy" />;
    }
    if (button.symbolPath) {
      return <img src={button.symbolPath} alt={button.label} className="object-contain" style={imgStyle} />;
    }
    if (button.iconRef && isEmoji(button.iconRef)) {
      return <span className={`${level.iconClass} leading-none`}>{button.iconRef}</span>;
    }
    if (button.iconRef) {
      return <i className={`${button.iconRef} ${level.iconClass} leading-none`} />;
    }
    return <span className={`${level.iconClass} leading-none`}>{getEmojiForLabel(button.label)}</span>;
  };

  return (
    <div className="h-full p-2 flex flex-col">
      {/* Navigation header — only shown for multi-page boards */}
      {isMultiPage && canGoBack && (
        <div className="flex items-center gap-2 mb-1 px-1 flex-shrink-0">
          <button
            onClick={navigateBack}
            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 px-2 py-1 rounded-md hover:bg-blue-50"
          >
            <ArrowLeft className="w-3 h-3" />
            Back
          </button>
          {currentPage?.name && (
            <span className="text-xs text-gray-500 truncate">{currentPage.name}</span>
          )}
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 flex items-center justify-center min-h-0">
        <div
          className="grid gap-2 w-full h-full"
          style={{
            gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
            gridTemplateRows: `repeat(${gridRows}, 1fr)`,
          }}
        >
          <AnimatePresence mode="popLayout">
            {slots.map((slot, i) => renderSlot(slot, i))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
