// client-aac/src/components/AppMiniBoard.tsx
// Compact 4-button panel shown alongside open apps and prebuilt boards.
// Renders in a narrow vertical column; positioned left (LTR) or right (RTL).

import { motion, AnimatePresence } from "framer-motion";
import type { ParsedBoardData, BoardButton } from "@shared/schema";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";

interface AppMiniBoardProps {
  board: ParsedBoardData | null;
  onButtonClick: (button: BoardButton, spokenText: string) => void;
  language?: string;
  voiceType?: string;
  suppressLocalSpeech?: boolean;
}

export default function AppMiniBoard({ board, onButtonClick, language, voiceType, suppressLocalSpeech }: AppMiniBoardProps) {
  const { speak } = useTextToSpeech();

  // Get buttons from the first page (up to 4)
  const page = board?.pages?.[0];
  const buttons = (page?.buttons || []).slice(0, 4);

  const handleClick = (button: BoardButton) => {
    const text = button.spokenText || button.label;
    if (!suppressLocalSpeech) {
      speak(text, language, voiceType as any);
    }
    onButtonClick(button, text);
  };

  return (
    <div className="flex flex-col gap-2 p-2 h-full w-28 flex-shrink-0 bg-gray-900/90">
      <AnimatePresence mode="popLayout">
        {buttons.map((button, i) => (
          <motion.button
            data-dwell
            key={button.label + i}
            className="flex-1 flex flex-col items-center justify-center rounded-xl shadow-md border border-white/20 select-none overflow-hidden"
            style={{ backgroundColor: button.color || "#3B82F6" }}
            onClick={() => handleClick(button)}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            transition={{ delay: i * 0.05 }}
          >
            {button.iconRef && (
              <span className="text-2xl leading-none">{button.iconRef}</span>
            )}
            <span className="text-xs font-semibold text-white mt-1 px-1 text-center leading-tight line-clamp-2">
              {button.label}
            </span>
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}
