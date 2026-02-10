import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { ParsedBoardData, BoardButton } from "@shared/schema";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useLanguage } from "@/contexts/LanguageContext";

export interface BoardPatch {
  add: Array<{ label: string; iconRef: string }>;
  remove: string[];
}

interface DynamicBoardProps {
  board: ParsedBoardData | null;
  boardPatch?: BoardPatch | null;
  onButtonClick: (button: BoardButton, spokenText: string) => void;
  onBack?: () => void;
  language?: string;
  voiceType?: string;
}

/** Slot state for the fixed 12-slot grid */
type SlotState =
  | { type: "occupied"; button: BoardButton; anim: "stable" | "entering" }
  | { type: "fading"; button: BoardButton; replaceWith?: BoardButton }
  | { type: "blank" };

const TOTAL_SLOTS = 12;
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
function makeBoardButton(entry: { label: string; iconRef: string }, index: number): BoardButton {
  return {
    id: `btn-patch-${Date.now()}-${index}`,
    label: entry.label,
    spokenText: entry.label,
    row: 0,
    col: 0,
    iconRef: entry.iconRef,
    action: { type: "speak", text: entry.label },
  } as BoardButton;
}

export default function DynamicBoard({
  board,
  boardPatch,
  onButtonClick,
  onBack,
  language = "en",
  voiceType,
}: DynamicBoardProps) {
  const { speak } = useTextToSpeech();
  const { t } = useLanguage();

  const [slots, setSlots] = useState<SlotState[]>(Array(TOTAL_SLOTS).fill(BLANK_SLOT));
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPatchRef = useRef<BoardPatch | null>(null);

  // Full board update — from board prop (button presses / chat)
  useEffect(() => {
    if (!board || !board.pages || board.pages.length === 0) {
      setSlots(Array(TOTAL_SLOTS).fill(BLANK_SLOT));
      return;
    }

    const currentPage = board.pages[0];
    const buttons: BoardButton[] = currentPage?.buttons || [];

    setSlots(
      Array.from({ length: TOTAL_SLOTS }, (_, i): SlotState => {
        if (i < buttons.length) {
          return { type: "occupied", button: buttons[i], anim: "entering" };
        }
        return BLANK_SLOT;
      })
    );
  }, [board]);

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

    // After fade completes: replace with queued button or go blank
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    if (remove.length > 0) {
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

  const handleButtonClick = useCallback(
    (button: BoardButton) => {
      const textToSpeak = button.spokenText || button.label;
      speak(textToSpeak, language, voiceType as any);
      onButtonClick(button, textToSpeak);
    },
    [speak, language, voiceType, onButtonClick]
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
          {renderIcon(button)}
          <span className="text-xs font-medium text-center text-gray-800 leading-tight mt-1">
            {button.label}
          </span>
        </motion.div>
      );
    }

    // occupied
    const { button, anim } = slot;
    const isEntering = anim === "entering";

    return (
      <motion.button
        data-dwell
        key={`btn-${button.label}-${index}`}
        initial={isEntering ? { opacity: 0, scale: 0.8 } : { opacity: 1, scale: 1 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: isEntering ? 0.3 : 0.15 }}
        onClick={() => handleButtonClick(button)}
        className="flex flex-col items-center justify-center p-2 rounded-xl shadow-sm border border-gray-200 min-h-0 overflow-hidden"
        style={{ backgroundColor: getButtonColor(button.color) }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
      >
        <div className="flex-1 flex items-center justify-center min-h-0">
          {renderIcon(button)}
        </div>
        <span className="flex-shrink-0 text-xs font-medium text-center text-gray-800 leading-tight mt-0.5">
          {button.label}
        </span>
      </motion.button>
    );
  };

  const renderIcon = (button: BoardButton) => {
    if (button.symbolPath) {
      return <img src={button.symbolPath} alt={button.label} className="w-[60%] h-[60%] object-contain" />;
    }
    if (button.iconRef && isEmoji(button.iconRef)) {
      return <span className="text-[3rem] sm:text-[5rem] md:text-[7rem] leading-none">{button.iconRef}</span>;
    }
    if (button.iconRef) {
      return <i className={`${button.iconRef} text-[3rem] sm:text-[5rem] md:text-[7rem] leading-none`} />;
    }
    return <span className="text-[3rem] sm:text-[5rem] md:text-[7rem] leading-none">{getEmojiForLabel(button.label)}</span>;
  };

  return (
    <div className="h-full p-2 flex items-center justify-center">
      <div
        className="grid gap-2 w-full h-full"
        style={{ gridTemplateColumns: "repeat(4, 1fr)", gridTemplateRows: "repeat(3, 1fr)" }}
      >
        <AnimatePresence mode="popLayout">
          {slots.map((slot, i) => renderSlot(slot, i))}
        </AnimatePresence>
      </div>
    </div>
  );
}
