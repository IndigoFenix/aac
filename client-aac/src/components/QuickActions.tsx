import { motion } from "framer-motion";
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
  const speakLabel = inSentenceBuilder ? t("quickActions.back") : t("quickActions.speak");
  // Back arrow points opposite reading direction (away from "forward") —
  // ▶ in RTL so it still reads as "go back", ◀ in LTR.
  const speakIcon = inSentenceBuilder ? (isRTL ? "▶" : "◀") : "💬";
  const speakColor = inSentenceBuilder ? "#E5E7EB" : "#FEF3C7";

  return (
    <div
      className={`grid gap-2 p-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 ${
        showSpeakSlot ? "grid-cols-5" : "grid-cols-4"
      }`}
    >
      {/* 1st button: More (AI mode) or Back (DB mode) */}
      {boardMode === 'ai' ? (
        <motion.button
          data-dwell
          onClick={() => onAction("more", t("quickActions.more"))}
          className="flex flex-col items-center justify-center py-3 rounded-xl shadow-sm border border-gray-200 dark:border-gray-600 bg-gray-200 dark:bg-gray-700"
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <span className="text-xl">➕</span>
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 mt-0.5">
            {t("quickActions.more")}
          </span>
        </motion.button>
      ) : (
        <motion.button
          data-dwell
          onClick={onBack}
          className="flex flex-col items-center justify-center py-3 rounded-xl shadow-sm border border-gray-300 dark:border-gray-600 bg-gray-200 dark:bg-gray-700"
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <span className="text-xl">◀</span>
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 mt-0.5">
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
          className="flex flex-col items-center justify-center py-3 rounded-xl shadow-sm border border-gray-200 dark:border-gray-600"
          style={{ backgroundColor: action.color }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <YesNoSprite variant={action.id} size={36} />
          <span className="text-xs font-semibold text-gray-800 mt-0.5">
            {t(action.labelKey)}
          </span>
        </motion.button>
      ))}

      {/* 4th button: Home / Back / Board / Exit */}
      <motion.button
        data-dwell
        onClick={() => onAction(endButton.id, t(endButton.labelKey))}
        className="flex flex-col items-center justify-center py-3 rounded-xl shadow-sm border border-gray-200 dark:border-gray-600"
        style={{ backgroundColor: endButton.color }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
      >
        <span className="text-xl">{endButton.emoji}</span>
        <span className="text-xs font-semibold text-gray-800 mt-0.5">
          {t(endButton.labelKey)}
        </span>
      </motion.button>

      {/* 5th button: Speak (opens sentence builder) / Back (closes it) */}
      {showSpeakSlot && (
        <motion.button
          data-dwell
          data-testid="quick-speak"
          onClick={onSpeak}
          className="flex flex-col items-center justify-center py-3 rounded-xl shadow-sm border border-gray-200 dark:border-gray-600"
          style={{ backgroundColor: speakColor }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <span className="text-xl">{speakIcon}</span>
          <span className="text-xs font-semibold text-gray-800 mt-0.5">
            {speakLabel}
          </span>
        </motion.button>
      )}
    </div>
  );
}
