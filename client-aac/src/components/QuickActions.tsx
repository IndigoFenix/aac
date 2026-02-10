import { motion } from "framer-motion";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useLanguage } from "@/contexts/LanguageContext";

interface QuickActionsProps {
  onAction: (action: string, text: string) => void;
  onBack: () => void;
  boardMode: 'ai' | 'db';
  voiceType?: string;
}

export default function QuickActions({ onAction, onBack, boardMode, voiceType }: QuickActionsProps) {
  const { t, language } = useLanguage();
  const { speak } = useTextToSpeech();

  const quickActions = [
    { id: "yes", labelKey: "quickActions.yes", emoji: "✅", color: "#D1FAE5" },
    { id: "no", labelKey: "quickActions.no", emoji: "❌", color: "#FEE2E2" },
    { id: "help", labelKey: "quickActions.help", emoji: "🆘", color: "#DBEAFE" },
  ];

  const handleAction = (action: typeof quickActions[0]) => {
    const label = t(action.labelKey);
    speak(label, language, voiceType as any);
    onAction(action.id, label);
  };

  return (
    <div className="grid grid-cols-4 gap-2 p-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700">
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
          <span className="text-xl">{action.emoji}</span>
          <span className="text-xs font-semibold text-gray-800 mt-0.5">
            {t(action.labelKey)}
          </span>
        </motion.button>
      ))}

      {/* 4th button: More (AI mode) or Back (DB mode) */}
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
    </div>
  );
}
