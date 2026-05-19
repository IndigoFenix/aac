// client-aac/src/components/BinaryChoiceOverlay.tsx
// Large prominent two-option overlay triggered when someone offers the
// student a binary choice (e.g. "Do you want the apple or the banana?").
// Mirrors YesNoOverlay's animation and auto-dismiss behavior, but the two
// option buttons are AI-supplied (glyph + label) and there's a "Neither"
// button instead of "Skip".

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLanguage } from "@/contexts/LanguageContext";
import { Glyph } from "@/components/Glyph";
import type { BinaryChoiceOption } from "@/hooks/dual-agent-types";

interface BinaryChoiceOverlayProps {
  options: BinaryChoiceOption[] | null;
  onSelect: (option: BinaryChoiceOption) => void;
  onNeither: () => void;
  onDismiss: () => void;
}

export default function BinaryChoiceOverlay({ options, onSelect, onNeither, onDismiss }: BinaryChoiceOverlayProps) {
  const { t } = useLanguage();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const active = !!options && options.length >= 2;

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
      {active && options && (
        <motion.div
          data-dwell-trap
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="flex flex-col items-center gap-3">
            {/* Two options side by side */}
            <div className="flex items-center justify-center gap-6">
              {options.slice(0, 2).map((opt, i) => (
                <motion.button
                  key={i}
                  data-dwell={`choice-${i}`}
                  className="flex flex-col items-center justify-center rounded-3xl shadow-2xl border-4 border-blue-400 bg-blue-50 text-blue-900 font-bold select-none p-3"
                  style={{ width: "min(45vw, 300px)", height: "min(45vw, 300px)", fontSize: "clamp(1.1rem, 3.5vw, 1.8rem)" }}
                  initial={{ scale: 0.3, y: 120, opacity: 0 }}
                  animate={{ scale: 1, y: 0, opacity: 1 }}
                  exit={{ scale: 0.3, y: 120, opacity: 0 }}
                  transition={{ type: "spring", stiffness: 400, damping: 25, delay: i * 0.05 }}
                  onClick={() => onSelect(opt)}
                >
                  <div
                    className="mb-2 flex items-center justify-center"
                    style={{ width: "min(28vw, 180px)", height: "min(28vw, 180px)" }}
                  >
                    {opt.glyph ? (
                      <Glyph
                        glyph={opt.glyph}
                        fallback={opt.glyphFallback}
                        noBackground
                        ariaLabel={opt.label}
                      />
                    ) : opt.iconRef ? (
                      <i className={`${opt.iconRef} text-6xl`} />
                    ) : null}
                  </div>
                  {opt.label}
                </motion.button>
              ))}
            </div>

            {/* Neither button — spans full width of the option row */}
            <motion.button
              data-dwell="neither"
              className="rounded-xl bg-gray-400/80 hover:bg-gray-500/80 text-white font-medium select-none py-2"
              style={{ width: "calc(min(90vw, 600px) + 1.5rem)", fontSize: "clamp(0.9rem, 2.5vw, 1.2rem)" }}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              transition={{ delay: 0.15 }}
              onClick={onNeither}
            >
              {t("quickActions.neither")}
            </motion.button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
