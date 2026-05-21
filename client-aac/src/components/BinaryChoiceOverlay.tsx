// client-aac/src/components/BinaryChoiceOverlay.tsx
// Large prominent two-option overlay triggered when someone offers the
// student a binary choice (e.g. "Do you want the apple or the banana?",
// or a simple yes/no question via `yes`/`no` SYMBOLs). The two option
// buttons are rendered through the shared SentenceButton component so
// every SENTENCE BUTTON rule applies — multi-glyph SENTENCEs, modifier
// SYMBOLs, animated SYMBOLs, default green/red coloring for yes/no.
// "Neither" is the always-present escape; auto-dismisses after 30s.

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLanguage } from "@/contexts/LanguageContext";
import { SentenceButton } from "@/components/SentenceButton";
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
            {/* Two options side by side, rendered as full SENTENCE BUTTONs.
                The shared component handles glyph rendering, animated
                SYMBOLs, and auto-green/red coloring for yes/no — no
                option-specific tinting needed here. */}
            <div className="flex items-center justify-center gap-6">
              {options.slice(0, 2).map((opt, i) => (
                <SentenceButton
                  key={i}
                  variant="overlay"
                  button={opt}
                  ariaLabel={opt.label}
                  overlayEntranceDelay={i * 0.05}
                  extraButtonProps={{ "data-dwell": `choice-${i}` }}
                  onClick={() => onSelect(opt)}
                />
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
