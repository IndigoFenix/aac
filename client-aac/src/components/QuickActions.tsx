import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useLanguage } from "@/contexts/LanguageContext";

interface QuickActionsProps {
  onAction: (action: string, text: string) => void;
  onBack: () => void;
}

export default function QuickActions({ onAction, onBack }: QuickActionsProps) {
  const { t, language, isRTL } = useLanguage();
  const { speak } = useTextToSpeech();

  const quickActions = [
    { id: "yes", labelKey: "quickActions.yes", emoji: "✅", color: "#D1FAE5" },
    { id: "no", labelKey: "quickActions.no", emoji: "❌", color: "#FEE2E2" },
    { id: "more", labelKey: "quickActions.more", emoji: "➕", color: "#DBEAFE" },
  ];

  const handleAction = (action: typeof quickActions[0]) => {
    const label = t(action.labelKey);
    speak(label, language);
    onAction(action.id, label);
  };

  const handleBack = () => {
    speak(t("quickActions.back"), language);
    onBack();
  };

  // Choose correct chevron icon based on RTL
  const BackIcon = isRTL ? ChevronRight : ChevronLeft;

  return (
    <div className="flex items-center justify-center gap-2 p-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700">
      {quickActions.map((action) => (
        <motion.button
          key={action.id}
          onClick={() => handleAction(action)}
          className="flex flex-col items-center justify-center px-4 py-2 rounded-xl shadow-sm border border-gray-200 dark:border-gray-600 min-w-[70px]"
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

      <motion.button
        onClick={handleBack}
        className="flex flex-col items-center justify-center px-4 py-2 rounded-xl shadow-sm border border-gray-300 dark:border-gray-600 bg-gray-200 dark:bg-gray-700 min-w-[70px]"
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
      >
        <BackIcon className="w-5 h-5 text-gray-700 dark:text-gray-300" />
        <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 mt-0.5">
          {t("quickActions.back")}
        </span>
      </motion.button>
    </div>
  );
}
