// client-aac/src/components/YesNoOverlay.tsx
// Large prominent Yes/No overlay triggered when someone asks the student a yes/no question.
// Animates in with a skip button underneath, auto-dismisses after 30 seconds.

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLanguage } from "@/contexts/LanguageContext";

interface YesNoOverlayProps {
  active: boolean;
  onSelect: (choice: "Yes" | "No") => void;
  onDismiss: () => void;
}

export default function YesNoOverlay({ active, onSelect, onDismiss }: YesNoOverlayProps) {
  const { t } = useLanguage();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Use a ref for onDismiss so the timer effect only depends on [active]
  // (prevents timer reset from parent re-renders due to face tracking / gaze updates)
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // Auto-dismiss after 30 seconds (reset on re-trigger)
  useEffect(() => {
    if (active) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        onDismissRef.current();
      }, 30000);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [active]);

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          data-dwell-trap
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="flex flex-col items-center gap-3">
            {/* Yes / No row */}
            <div className="flex items-center justify-center gap-6">
              {/* Yes button */}
              <motion.button
                data-dwell="yes"
                className="flex flex-col items-center justify-center rounded-3xl shadow-2xl border-4 border-green-400 bg-green-100 text-green-800 font-bold select-none"
                style={{ width: "min(45vw, 300px)", height: "min(45vw, 300px)", fontSize: "clamp(1.5rem, 5vw, 2.5rem)" }}
                initial={{ scale: 0.3, y: 120, opacity: 0 }}
                animate={{ scale: 1, y: 0, opacity: 1 }}
                exit={{ scale: 0.3, y: 120, opacity: 0 }}
                transition={{ type: "spring", stiffness: 400, damping: 25 }}
                onClick={() => onSelect("Yes")}
              >
                <span className="text-7xl mb-2">✅</span>
                {t("quickActions.yes")}
              </motion.button>

              {/* No button */}
              <motion.button
                data-dwell="no"
                className="flex flex-col items-center justify-center rounded-3xl shadow-2xl border-4 border-red-400 bg-red-100 text-red-800 font-bold select-none"
                style={{ width: "min(45vw, 300px)", height: "min(45vw, 300px)", fontSize: "clamp(1.5rem, 5vw, 2.5rem)" }}
                initial={{ scale: 0.3, y: 120, opacity: 0 }}
                animate={{ scale: 1, y: 0, opacity: 1 }}
                exit={{ scale: 0.3, y: 120, opacity: 0 }}
                transition={{ type: "spring", stiffness: 400, damping: 25, delay: 0.05 }}
                onClick={() => onSelect("No")}
              >
                <span className="text-7xl mb-2">❌</span>
                {t("quickActions.no")}
              </motion.button>
            </div>

            {/* Skip button — spans full width of Yes/No row */}
            <motion.button
              data-dwell="skip"
              className="rounded-xl bg-gray-400/80 hover:bg-gray-500/80 text-white font-medium select-none py-2"
              style={{ width: "calc(min(90vw, 600px) + 1.5rem)", fontSize: "clamp(0.9rem, 2.5vw, 1.2rem)" }}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              transition={{ delay: 0.15 }}
              onClick={onDismiss}
            >
              {t("quickActions.skip")}
            </motion.button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
