import { motion, AnimatePresence } from "framer-motion";
import { EyegazeState } from "@/hooks/useEyegazeSelection";

interface EyegazeCursorProps {
  eyegazeState: EyegazeState;
  timeout: number;
}

export function EyegazeCursor({ eyegazeState, timeout }: EyegazeCursorProps) {
  if (!eyegazeState.isSelecting) return null;

  const { mousePosition, progress } = eyegazeState;
  const timeRemaining = Math.ceil((100 - progress) / 100 * timeout / 1000);

  return (
    <AnimatePresence>
      <motion.div
        className="fixed pointer-events-none z-[9999]"
        style={{
          left: mousePosition.x + 20, // Offset from cursor
          top: mousePosition.y - 20,
        }}
        initial={{ opacity: 0, scale: 0.5 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.5 }}
        transition={{ duration: 0.2 }}
      >
        {/* Progress circle */}
        <div className="relative w-12 h-12">
          {/* Background circle */}
          <svg className="w-12 h-12 transform -rotate-90" viewBox="0 0 36 36">
            <path
              className="text-gray-300"
              d="M18 2.0845
                a 15.9155 15.9155 0 0 1 0 31.831
                a 15.9155 15.9155 0 0 1 0 -31.831"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            {/* Progress circle */}
            <path
              className="text-blue-500"
              d="M18 2.0845
                a 15.9155 15.9155 0 0 1 0 31.831
                a 15.9155 15.9155 0 0 1 0 -31.831"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeDasharray={`${progress}, 100`}
              strokeLinecap="round"
            />
          </svg>
          
          {/* Center content */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center">
              <span className="text-white text-xs font-bold">
                {timeRemaining}
              </span>
            </div>
          </div>
        </div>
        
        {/* Tooltip */}
        <div className="absolute -bottom-8 left-1/2 transform -translate-x-1/2 bg-black/80 text-white text-xs px-2 py-1 rounded whitespace-nowrap">
          👀 Selecting in {timeRemaining}s
        </div>
      </motion.div>
    </AnimatePresence>
  );
}