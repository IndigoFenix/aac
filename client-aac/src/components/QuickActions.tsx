import { motion } from "framer-motion";
import type { CSSProperties } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { YesNoSprite } from "@/components/YesNoSprite";

interface QuickActionsProps {
  onAction: (action: string, text: string) => void;
  onBack: () => void;
  boardMode: 'ai' | 'db';
  voiceType?: string;
  hasActiveApp?: boolean;
  hasPrebuiltBoard?: boolean;
  currentTier?: "home" | "context" | "latest";
  isGuessingMode?: boolean;
  /** Toggle the sentence-builder overlay. When already open, this should
   *  dismiss it (the underlying board is preserved by the overlay model). */
  onSpeak?: () => void;
  /** When true, the Speak button renders as a Back button. */
  inSentenceBuilder?: boolean;
}

export default function QuickActions({ onAction, onBack, boardMode, hasActiveApp, currentTier = "latest", isGuessingMode = false, onSpeak, inSentenceBuilder = false }: QuickActionsProps) {
  const { t, isRTL } = useLanguage();

  const quickActions: Array<{ id: "yes" | "no"; labelKey: string; color: string }> = [
    { id: "yes", labelKey: "quickActions.yes", color: "#D1FAE5" },
    { id: "no", labelKey: "quickActions.no", color: "#FEE2E2" },
  ];

  const handleAction = (action: typeof quickActions[0]) => {
    const label = t(action.labelKey);
    onAction(action.id, label);
  };

  // Determine what the last button should be based on navigation tier
  const getEndButton = () => {
    if (hasActiveApp) {
      return { id: "exit", labelKey: "quickActions.exit", emoji: "✖️", color: "#FCA5A5" };
    }
    if (isGuessingMode) {
      return { id: "home", labelKey: "quickActions.back", emoji: "↩️", color: "#C4B5FD" };
    }
    switch (currentTier) {
      case "home":
        return { id: "home", labelKey: "quickActions.back", emoji: "↩️", color: "#C4B5FD" };
      case "context":
        return { id: "home", labelKey: "quickActions.home", emoji: "🏠", color: "#DBEAFE" };
      case "latest":
      default:
        return { id: "home", labelKey: "quickActions.board", emoji: "📋", color: "#E0E7FF" };
    }
  };

  const endButton = getEndButton();

  // Speak button toggles to Back when the sentence builder is open. Only
  // rendered when a handler is wired — keeps the row at 4 cols otherwise so
  // existing screens are unaffected.
  const showSpeakSlot = !!onSpeak;
  // "Guess" is the Word Finder entry — always visible in the AI dynamic
  // board when no app is open and we're not inside the sentence builder
  // (the builder has its own Word Finder button). Click toggles entry/exit
  // based on isGuessingMode (single source of truth from the server).
  const showGuessSlot =
    boardMode === "ai" && !hasActiveApp && !inSentenceBuilder;
  const columns = 4 + (showSpeakSlot ? 1 : 0) + (showGuessSlot ? 1 : 0);
  const speakLabel = inSentenceBuilder ? t("quickActions.back") : t("quickActions.speak");
  // Back arrow points opposite reading direction (away from "forward") —
  // ▶ in RTL so it still reads as "go back", ◀ in LTR.
  const speakIcon = inSentenceBuilder ? (isRTL ? "▶" : "◀") : "💬";
  const speakColor = inSentenceBuilder ? "#E5E7EB" : "#FEF3C7";

  // Definite row height (responsive, capped) so the buttons have a real box
  // for their icons to fill — `grid-auto-rows: 1fr` makes the single row take
  // the whole container height so each button stretches to fill it.
  const rowStyle: CSSProperties = { height: "clamp(6rem, 16.5dvh, 10.5rem)", gridAutoRows: "1fr" };
  // Shared button shell: fills its grid cell; icon area grows, label is a
  // content-height strip below it — same fill model as the board buttons.
  const btnClass =
    "h-full flex flex-col items-center justify-center p-1 rounded-xl shadow-sm border overflow-hidden";
  const labelClass = "text-xs font-semibold text-center leading-tight line-clamp-2 shrink-0";

  return (
    <div
      className="grid gap-2 p-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 shrink-0"
      style={{ ...rowStyle, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {/* 1st button: More (AI mode) or Back (DB mode) */}
      {boardMode === 'ai' ? (
        <motion.button
          data-dwell
          onClick={() => onAction("more", t("quickActions.more"))}
          className={`${btnClass} border-gray-200 dark:border-gray-600 bg-gray-200 dark:bg-gray-700`}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <div className="icon-fill-area"><span className="icon-fill-emoji">➕</span></div>
          <span className={`${labelClass} text-gray-700 dark:text-gray-300`}>
            {t("quickActions.more")}
          </span>
        </motion.button>
      ) : (
        <motion.button
          data-dwell
          onClick={onBack}
          className={`${btnClass} border-gray-300 dark:border-gray-600 bg-gray-200 dark:bg-gray-700`}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <div className="icon-fill-area"><span className="icon-fill-emoji">◀</span></div>
          <span className={`${labelClass} text-gray-700 dark:text-gray-300`}>
            {t("quickActions.back")}
          </span>
        </motion.button>
      )}

      {/* Yes and No buttons */}
      {quickActions.map((action) => (
        <motion.button
          data-dwell
          key={action.id}
          onClick={() => handleAction(action)}
          className={`${btnClass} border-gray-200 dark:border-gray-600`}
          style={{ backgroundColor: action.color }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <div className="icon-fill-area"><YesNoSprite variant={action.id} size="92cqmin" /></div>
          <span className={`${labelClass} text-gray-800`}>
            {t(action.labelKey)}
          </span>
        </motion.button>
      ))}

      {/* 4th button: Home / Back / Board / Exit */}
      <motion.button
        data-dwell
        onClick={() => onAction(endButton.id, t(endButton.labelKey))}
        className={`${btnClass} border-gray-200 dark:border-gray-600`}
        style={{ backgroundColor: endButton.color }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
      >
        <div className="icon-fill-area"><span className="icon-fill-emoji">{endButton.emoji}</span></div>
        <span className={`${labelClass} text-gray-800`}>
          {t(endButton.labelKey)}
        </span>
      </motion.button>

      {/* Word Finder: the same button enters and exits guessing mode. When
          active, an extra ring + thicker border highlights it across every
          surface that exposes the button (this row + the sentence builder). */}
      {showGuessSlot && (
        <motion.button
          data-dwell
          data-testid="quick-guess"
          data-active={isGuessingMode ? "true" : undefined}
          onClick={() => onAction("guess", t("quickActions.guess"))}
          className={`${btnClass} ${
            isGuessingMode
              ? "border-violet-600 border-2 ring-2 ring-violet-400 dark:border-violet-300"
              : "border-violet-300 dark:border-violet-500"
          }`}
          style={{ backgroundColor: isGuessingMode ? "#C4B5FD" : "#EDE9FE" }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <div className="icon-fill-area"><span className="icon-fill-emoji">🔍</span></div>
          <span className={`${labelClass} text-gray-800`}>
            {t("quickActions.guess")}
          </span>
        </motion.button>
      )}

      {/* Speak (opens sentence builder) / Back (closes it) */}
      {showSpeakSlot && (
        <motion.button
          data-dwell
          data-testid="quick-speak"
          onClick={onSpeak}
          className={`${btnClass} border-gray-200 dark:border-gray-600`}
          style={{ backgroundColor: speakColor }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <div className="icon-fill-area"><span className="icon-fill-emoji">{speakIcon}</span></div>
          <span className={`${labelClass} text-gray-800`}>
            {speakLabel}
          </span>
        </motion.button>
      )}
    </div>
  );
}
