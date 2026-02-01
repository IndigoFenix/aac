import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { ParsedBoardData, BoardButton } from "@shared/schema";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useLanguage } from "@/contexts/LanguageContext";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface DynamicBoardProps {
  board: ParsedBoardData | null;
  onButtonClick: (button: BoardButton, spokenText: string) => void;
  onBack?: () => void;
  onMore?: () => void;
  language?: string;
}

/** Display state for a button during reconciliation */
interface DisplayButton {
  button: BoardButton;
  state: 'stable' | 'entering' | 'exiting';
  position: number; // visual order index
  key: string; // stable unique key for animation
}

// Check if a string is an emoji (not a FontAwesome class)
function isEmoji(str: string): boolean {
  // FontAwesome classes start with "fa" or contain spaces (e.g., "fas fa-home")
  if (!str || str.startsWith('fa') || str.includes(' ')) return false;
  // If it's short and contains non-ASCII, it's likely an emoji
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
    "bath": "🛁", "toilet": "🚽", "sleep": "😴",
  };

  const lowerLabel = label.toLowerCase();
  for (const [key, emoji] of Object.entries(emojiMap)) {
    if (lowerLabel.includes(key)) {
      return emoji;
    }
  }
  return "💬";
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
  };
  return colorMap[color?.toLowerCase() || "white"] || color || "#FFFFFF";
}

/** Normalize label for matching (case-insensitive, trimmed) */
function normalizeLabel(label: string): string {
  return (label || "").toLowerCase().trim();
}

/** Create a unique key from label, deduplicating with index suffix */
function makeUniqueKey(label: string, index: number, usedKeys: Set<string>): string {
  let key = normalizeLabel(label) || `btn-${index}`;
  if (usedKeys.has(key)) {
    key = `${key}-${index}`;
  }
  usedKeys.add(key);
  return key;
}

export default function DynamicBoard({ board, onButtonClick, onBack, onMore, language = "en" }: DynamicBoardProps) {
  const { speak } = useTextToSpeech();
  const { t, isRTL } = useLanguage();

  // Reconciliation state
  const [displayButtons, setDisplayButtons] = useState<DisplayButton[]>([]);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reconcile when board prop changes
  useEffect(() => {
    if (!board || !board.pages || board.pages.length === 0) {
      setDisplayButtons([]);
      return;
    }

    const currentPage = board.pages[0];
    if (!currentPage) {
      setDisplayButtons([]);
      return;
    }
    const newButtons: BoardButton[] = currentPage.buttons || [];

    setDisplayButtons(prev => {
      try {
        // Build lookup of old buttons by normalized label
        const oldByLabel = new Map<string, DisplayButton>();
        for (const db of prev) {
          if (db.state !== 'exiting') {
            const label = normalizeLabel(db.button.label);
            // Only use first occurrence if duplicates exist
            if (!oldByLabel.has(label)) {
              oldByLabel.set(label, db);
            }
          }
        }

        // Build lookup of new buttons by normalized label
        const newLabels = new Set(newButtons.map(b => normalizeLabel(b.label)));

        // Phase 1: Match — new buttons that exist in old set keep their position
        const matched = new Map<string, DisplayButton>();
        const unmatchedNew: { btn: BoardButton; index: number }[] = [];
        const usedKeys = new Set<string>();

        for (let i = 0; i < newButtons.length; i++) {
          const btn = newButtons[i];
          const label = normalizeLabel(btn.label);
          const existing = oldByLabel.get(label);
          if (existing && !matched.has(label)) {
            const key = makeUniqueKey(btn.label, i, usedKeys);
            matched.set(label, {
              button: btn,
              state: 'stable',
              position: existing.position,
              key,
            });
          } else {
            unmatchedNew.push({ btn, index: i });
          }
        }

        // Phase 2: Exit — old buttons not in new set get 'exiting' state
        const exiting: DisplayButton[] = [];
        for (const db of prev) {
          if (db.state === 'exiting') continue;
          const label = normalizeLabel(db.button.label);
          if (!newLabels.has(label)) {
            exiting.push({ ...db, state: 'exiting' });
          }
        }

        // Phase 3: Enter — unmatched new buttons fill empty positions
        const usedPositions = new Set<number>();
        for (const [, db] of matched) {
          usedPositions.add(db.position);
        }
        let nextPos = 0;
        const getNextPosition = () => {
          while (usedPositions.has(nextPos)) nextPos++;
          usedPositions.add(nextPos);
          return nextPos;
        };

        const entering: DisplayButton[] = unmatchedNew.map(({ btn, index }) => ({
          button: btn,
          state: 'entering' as const,
          position: getNextPosition(),
          key: makeUniqueKey(btn.label, index, usedKeys),
        }));

        // Combine: matched + entering + exiting
        const result = [
          ...Array.from(matched.values()),
          ...entering,
          ...exiting,
        ];

        result.sort((a, b) => a.position - b.position);
        return result;
      } catch (err) {
        console.error("[DynamicBoard] Reconciliation error:", err);
        // Fallback: just display new buttons directly
        const usedKeys = new Set<string>();
        return newButtons.map((btn, i) => ({
          button: btn,
          state: 'stable' as const,
          position: i,
          key: makeUniqueKey(btn.label, i, usedKeys),
        }));
      }
    });
  }, [board]);

  // Remove exiting buttons after animation completes (400ms)
  useEffect(() => {
    const hasExiting = displayButtons.some(db => db.state === 'exiting');
    if (!hasExiting) return;

    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
    }

    exitTimerRef.current = setTimeout(() => {
      setDisplayButtons(prev => prev.filter(db => db.state !== 'exiting'));
    }, 400);

    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
      }
    };
  }, [displayButtons]);

  if (!board || !board.pages || board.pages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        <p className="text-sm">AI suggestions will appear here</p>
      </div>
    );
  }

  const handleButtonClick = (button: BoardButton) => {
    const textToSpeak = button.spokenText || button.label;
    speak(textToSpeak, language);
    onButtonClick(button, textToSpeak);
  };

  const BackIcon = isRTL ? ChevronRight : ChevronLeft;

  const renderDisplayButton = (db: DisplayButton) => {
    const { button, state, key } = db;

    const initial = state === 'entering'
      ? { opacity: 0, scale: 0.8 }
      : { opacity: 1, scale: 1 };

    const animate = state === 'exiting'
      ? { opacity: 0, scale: 0.8 }
      : { opacity: 1, scale: 1 };

    const transition = state === 'exiting'
      ? { duration: 0.4 }
      : state === 'entering'
      ? { duration: 0.3 }
      : { duration: 0.15 };

    return (
      <motion.button
        key={key}
        initial={initial}
        animate={animate}
        transition={transition}
        onClick={() => state !== 'exiting' && handleButtonClick(button)}
        className={`flex flex-col items-center justify-center p-3 rounded-xl shadow-sm border border-gray-200 min-w-[80px] max-w-[100px] ${
          state === 'exiting' ? 'pointer-events-none' : ''
        }`}
        style={{ backgroundColor: getButtonColor(button.color) }}
        whileHover={state !== 'exiting' ? { scale: 1.05 } : undefined}
        whileTap={state !== 'exiting' ? { scale: 0.95 } : undefined}
      >
        {button.symbolPath ? (
          <img
            src={button.symbolPath}
            alt={button.label}
            className="w-10 h-10 object-contain mb-1"
          />
        ) : button.iconRef && isEmoji(button.iconRef) ? (
          <span className="text-2xl mb-1">{button.iconRef}</span>
        ) : button.iconRef ? (
          <i className={`${button.iconRef} text-2xl mb-1`} />
        ) : (
          <span className="text-2xl mb-1">
            {getEmojiForLabel(button.label)}
          </span>
        )}
        <span className="text-xs font-medium text-center text-gray-800 leading-tight">
          {button.label}
        </span>
      </motion.button>
    );
  };

  return (
    <div className="flex flex-wrap gap-2 p-2 justify-center items-start content-start h-full overflow-y-auto">
      {onBack && (
        <motion.button
          onClick={onBack}
          className="flex flex-col items-center justify-center p-3 rounded-xl shadow-sm border border-gray-300 bg-gray-200 dark:bg-gray-700 min-w-[80px] max-w-[100px]"
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <BackIcon className="w-6 h-6 text-gray-700 dark:text-gray-300 mb-1" />
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 leading-tight">
            {t("quickActions.back")}
          </span>
        </motion.button>
      )}
      <AnimatePresence>
        {displayButtons.map(renderDisplayButton)}
      </AnimatePresence>
      {onMore && (
        <motion.button
          onClick={onMore}
          className="flex flex-col items-center justify-center p-3 rounded-xl shadow-sm border border-gray-200 min-w-[80px] max-w-[100px]"
          style={{ backgroundColor: "#DBEAFE" }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <span className="text-2xl mb-1">➕</span>
          <span className="text-xs font-medium text-center text-gray-800 leading-tight">
            {t("quickActions.more")}
          </span>
        </motion.button>
      )}
    </div>
  );
}
