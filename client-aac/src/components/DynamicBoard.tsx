import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { ParsedBoardData, BoardButton } from "@shared/schema";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useDualAgentContextOptional } from "@/contexts/DualAgentContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { ArrowLeft } from "lucide-react";
import { apiUrl } from "@/lib/queryClient";

export interface BoardPatch {
  add: Array<{ label: string; iconRef: string }>;
  remove: string[];
}

interface DynamicBoardProps {
  board: ParsedBoardData | null;
  boardPatch?: BoardPatch | null;
  /** Auto-generated symbol ready — update the button's image */
  symbolUpdate?: { buttonLabel: string; symbolPath: string } | null;
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
 * iconScale/textScale are fractions of the computed row height used for font-size.
 * imgSize controls symbol/face image size as percentage.
 */
const RATIO_LEVELS: Record<number, {
  iconFlex: number;
  textFlex: number;
  iconScale: number;
  textScale: number;
  imgSize: string;
}> = {
  1: { iconFlex: 9, textFlex: 1, iconScale: 0.55, textScale: 0.08, imgSize: "70%" },
  2: { iconFlex: 4, textFlex: 1, iconScale: 0.50, textScale: 0.09, imgSize: "65%" },
  3: { iconFlex: 3, textFlex: 1, iconScale: 0.45, textScale: 0.10, imgSize: "60%" },
  4: { iconFlex: 2, textFlex: 1, iconScale: 0.35, textScale: 0.12, imgSize: "50%" },
  5: { iconFlex: 1, textFlex: 2, iconScale: 0.25, textScale: 0.15, imgSize: "40%" },
};

/** Slot state for the grid */
type SlotState =
  | { type: "occupied"; button: BoardButton; anim: "stable" | "entering" }
  | { type: "fading"; button: BoardButton; replaceWith?: BoardButton }
  | { type: "blank" };

const DEFAULT_ROWS = 3;
const DEFAULT_COLS = 4;
const BLANK_SLOT: SlotState = { type: "blank" };

/** Returns true if the string should be rendered as text (emoji or single character/number) rather than a Font Awesome icon class */
function isDisplayableIcon(str: string): boolean {
  if (!str || str.startsWith("fa") || str.includes(" ")) return false;
  // Single characters (letters, numbers, punctuation) are displayable as-is
  if ([...str].length === 1) return true;
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
function makeBoardButton(entry: { label: string; iconRef: string; symbolPath?: string; sentence?: string }, index: number): BoardButton {
  return {
    id: `btn-patch-${Date.now()}-${index}`,
    label: entry.label,
    spokenText: entry.label,
    ...(entry.sentence ? { sentence: entry.sentence } : {}),
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
  symbolUpdate,
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
  const dualAgent = useDualAgentContextOptional();
  const isRTL = language === "he" || language === "ar";

  // Icon/text sizing based on ratio level
  const level = RATIO_LEVELS[Math.max(1, Math.min(5, iconTextRatio))] || RATIO_LEVELS[3];

  // Grid dimensions from board data — needed before computing sizes
  const gridRows = board?.grid?.rows || DEFAULT_ROWS;
  const gridCols = board?.grid?.cols || DEFAULT_COLS;
  const totalSlots = gridRows * gridCols;

  // Compute icon/text font sizes dynamically based on available height and row count.
  // Available height ≈ 100dvh - header (6rem) - quickActions (~3.5rem) - padding (~1rem) = 100dvh - 10.5rem
  const iconFontSize = `clamp(1rem, calc((100dvh - 10.5rem) / ${gridRows} * ${level.iconScale}), 8rem)`;
  const textFontSize = `clamp(0.5rem, calc((100dvh - 10.5rem) / ${gridRows} * ${level.textScale}), 1.5rem)`;

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

    // Use row/col placement if buttons have position data (e.g. imported boards),
    // otherwise fall back to sequential placement (e.g. AI-generated boards)
    const hasPositions = buttons.length > 0 && buttons.some(b => b.row != null && b.col != null);

    setSlots(
      Array.from({ length: totalSlots }, (_, i): SlotState => {
        if (hasPositions) {
          const row = Math.floor(i / gridCols);
          const col = i % gridCols;
          const button = buttons.find(b => b.row === row && b.col === col);
          if (button) {
            return { type: "occupied", button, anim: "entering" };
          }
        } else if (i < buttons.length) {
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

      // Step 1.5: Deduplicate — filter out buttons that already exist on the board
      // (same label AND same icon). This prevents the AI from adding duplicates.
      const existingButtons = new Set(
        next
          .filter((s): s is { type: "occupied"; button: BoardButton; anim: "stable" | "entering" } => s.type === "occupied")
          .map(s => `${s.button.label.toLowerCase().trim()}|${(s.button.iconRef || "").toLowerCase().trim()}`),
      );
      const dedupedAdd = add.filter(
        btn => !existingButtons.has(`${btn.label.toLowerCase().trim()}|${(btn.iconRef || "").toLowerCase().trim()}`),
      );

      // Step 2: Place new buttons in blank slots first
      let addIndex = 0;
      for (let i = 0; i < next.length && addIndex < dedupedAdd.length; i++) {
        if (next[i].type === "blank") {
          next[i] = {
            type: "occupied",
            button: makeBoardButton(dedupedAdd[addIndex], addIndex),
            anim: "entering",
          };
          addIndex++;
        }
      }

      // Step 3: Queue remaining new buttons as replacements for fading slots
      for (let i = 0; i < next.length && addIndex < dedupedAdd.length; i++) {
        if (next[i].type === "fading" && !(next[i] as any).replaceWith) {
          next[i] = {
            type: "fading",
            button: (next[i] as { type: "fading"; button: BoardButton }).button,
            replaceWith: makeBoardButton(dedupedAdd[addIndex], addIndex),
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

  // Symbol update — auto-generated symbol is ready, update the button's image
  useEffect(() => {
    if (!symbolUpdate) return;
    const { buttonLabel, symbolPath } = symbolUpdate;
    setSlots((prev) =>
      prev.map((slot) => {
        if (slot.type !== "occupied" && slot.type !== "fading") return slot;
        if (slot.button.label.toLowerCase() !== buttonLabel.toLowerCase()) return slot;
        return { ...slot, button: { ...slot.button, symbolPath } };
      })
    );
  }, [symbolUpdate]);

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

      // Handle exit action or exitBoard flag — send to server for unloading
      if (action?.type === "exit" || (button as any).exitBoard) {
        onButtonClick(button, button.label);
        return;
      }

      // Handle open_website action — open the in-frame browser app
      if (action?.type === "open_website" && action.url) {
        dualAgent?.launchApp("browser", { url: action.url, label: button.label });
        return;
      }

      // Default: speak action
      const textToSpeak = button.spokenText || button.label;
      if (!suppressLocalSpeech) {
        speak(textToSpeak, language, voiceType as any);
      }
      onButtonClick(button, textToSpeak);
    },
    [speak, language, voiceType, onButtonClick, navigateToPage, navigateBack, navigateHome, suppressLocalSpeech, dualAgent]
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
          className="flex flex-col items-center justify-center p-1 rounded-xl shadow-sm border border-gray-200 pointer-events-none min-h-0 min-w-0 overflow-hidden"
          style={{ backgroundColor: getButtonColor(button.color) }}
        >
          <div className="flex items-center justify-center min-h-0 w-full overflow-hidden" style={{ flex: `${level.iconFlex} 1 0px` }}>
            {renderIcon(button)}
          </div>
          <div className="flex items-center justify-center w-full overflow-hidden" style={{ flex: `${level.textFlex} 1 0px` }}>
            <span className="font-medium text-center text-gray-800 leading-tight" style={{ fontSize: textFontSize }}>
              {button.label}
            </span>
          </div>
        </motion.div>
      );
    }

    // occupied
    const { button, anim } = slot;
    const isEntering = anim === "entering";
    const actionType = button.action?.type;
    const isLinkButton = actionType === "link";
    const isBackButton = actionType === "back" || actionType === "home";

    const isGuessButton = (button as any).buttonType === "guess";

    const borderClass = isGuessButton
      ? "border-amber-400 border-2 ring-2 ring-amber-300/50"
      : isLinkButton
      ? "border-blue-400 border-2"
      : isBackButton
        ? "border-amber-400 border-2"
        : "border-gray-200";

    return (
      <motion.button
        data-dwell
        data-dwell-cell={`grid-${index}`}
        key={`btn-${button.label}-${index}`}
        initial={isEntering ? { opacity: 0, scale: 0.8 } : { opacity: 1, scale: 1 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: isEntering ? 0.3 : 0.15 }}
        onClick={() => handleButtonClick(button)}
        className={`flex flex-col items-center justify-center p-1 rounded-xl shadow-sm border min-h-0 min-w-0 overflow-hidden relative ${borderClass}`}
        style={{ backgroundColor: getButtonColor(button.color) }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
      >
        <div className="flex items-center justify-center min-h-0 w-full overflow-hidden" style={{ flex: `${level.iconFlex} 1 0px` }}>
          {isBackButton
            ? <i className={`fas ${actionType === "home" ? "fa-house" : isRTL ? "fa-arrow-right" : "fa-arrow-left"} text-gray-700`} style={{ fontSize: iconFontSize }} />
            : renderIcon(button)}
        </div>
        <div className="flex items-center justify-center w-full overflow-hidden" style={{ flex: `${level.textFlex} 1 0px` }}>
          <span className="font-medium text-center text-gray-800 leading-tight line-clamp-2" style={{ fontSize: textFontSize }}>
            {button.label}
          </span>
        </div>
        {/* Action type indicator */}
        {isLinkButton && (
          <span className="absolute top-0.5 right-0.5 text-blue-600 opacity-70" style={{ fontSize: '0.55em' }}>▶</span>
        )}
      </motion.button>
    );
  };

  const renderIcon = (button: BoardButton) => {
    // Images constrained to the icon area: height fills the flex-basis:0 container, width scales proportionally
    const imgStyle = { maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", objectFit: "contain" as const };
    const emojiStyle = { fontSize: iconFontSize, lineHeight: 1 };

    const renderLoadingOverlay = (emoji: string, halfSize = false) => (
      <span style={{ ...emojiStyle, ...(halfSize ? { fontSize: `calc(${iconFontSize} * 0.5)` } : {}), position: "relative" as const, display: "inline-block" }}>
        {emoji}
        <span style={{
          position: "absolute", top: -2, right: -6, width: 10, height: 10, borderRadius: "50%",
          border: "2px solid rgba(59,130,246,0.5)", borderTopColor: "transparent",
          display: "inline-block",
          animation: "dynamic-board-spin 1s linear infinite",
        }} />
      </span>
    );

    // Resolve __FACE__:contactId to cached face image
    if (button.symbolPath?.startsWith("__FACE__:")) {
      const contactId = button.symbolPath.substring(9);
      const cached = getFaceImage?.(contactId);
      if (cached) {
        return <img src={cached} alt={button.label} className="rounded-full" style={imgStyle} />;
      }
      return <span style={emojiStyle}>👤</span>;
    }
    // Resolve __SYMBOL__:symbolId to custom symbol image
    if (button.symbolPath?.startsWith("__SYMBOL__:")) {
      const symbolId = button.symbolPath.substring(11);
      return <img src={apiUrl(`/api/custom-symbols/${symbolId}/image`)} alt={button.label} style={imgStyle} loading="lazy" />;
    }
    if (button.symbolPath) {
      return <img src={button.symbolPath} alt={button.label} style={imgStyle} />;
    }
    // Show emoji with loading spinner while symbol is being generated
    if ((button as any).imageKey) {
      const emoji = button.iconRef && isDisplayableIcon(button.iconRef) ? button.iconRef : getEmojiForLabel(button.label);
      return renderLoadingOverlay(emoji, emoji.length > 2);
    }
    if (button.iconRef && isDisplayableIcon(button.iconRef)) {
      // If icon contains multiple emojis (e.g. "🏞️🌳"), halve the font size
      const style = button.iconRef.length > 2 ? { ...emojiStyle, fontSize: `calc(${iconFontSize} * 0.5)` } : emojiStyle;
      return <span style={style}>{button.iconRef}</span>;
    }
    if (button.iconRef) {
      return <i className={button.iconRef} style={emojiStyle} />;
    }
    return <span style={emojiStyle}>{getEmojiForLabel(button.label)}</span>;
  };

  return (
    <div className="h-full p-2 flex flex-col">
      <style>{`@keyframes dynamic-board-spin { to { transform: rotate(360deg); } }`}</style>
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
      <div className="flex-1 min-h-0 overflow-hidden">
        <div
          className="grid gap-2 w-full h-full"
          style={{
            gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${gridRows}, minmax(0, 1fr))`,
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
