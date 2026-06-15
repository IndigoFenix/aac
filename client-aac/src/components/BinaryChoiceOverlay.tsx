// client-aac/src/components/BinaryChoiceOverlay.tsx
// Large prominent two-option overlay triggered when someone offers the
// student a binary choice (e.g. "Do you want the apple or the banana?",
// or a simple yes/no question via `yes`/`no` SYMBOLs). The two option
// buttons are rendered through the shared SentenceButton component so
// every SENTENCE BUTTON rule applies — multi-glyph SENTENCEs, modifier
// SYMBOLs, animated SYMBOLs, default green/red coloring for yes/no.
// The third button is the always-present escape, now rendered equally sized
// and last in the row. When the two options are a yes/no pair (detected via
// the same yes/no color system) it becomes a yellow "Maybe"; otherwise it's a
// red "Neither of these" carrying the `no` SYMBOL image. All three voice their
// choice through the same path as any board button (onSelect → the student-
// voice utterance channel). A separate small "Cancel" button underneath just
// closes the overlay without voicing anything. Auto-dismisses after 30s.

import { useEffect, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLanguage } from "@/contexts/LanguageContext";
import { SentenceButton, type SentenceButtonInput } from "@/components/SentenceButton";
import { Glyph } from "@/components/Glyph";
import type { BinaryChoiceOption } from "@/hooks/dual-agent-types";

interface BinaryChoiceOverlayProps {
  options: BinaryChoiceOption[] | null;
  /** Server-supplied escape-button kind: "maybe" (yellow) when the two
   *  options form a yes/no pair; "neither" (red, no-symbol) otherwise.
   *  Decided server-side so this display layer doesn't need to know the
   *  rule. Null falls back to "neither" for the rare case of an older
   *  server build that didn't ship the field. */
  escapeKind?: "maybe" | "neither" | null;
  /** Experiment (glyphInputTranslation): a glyph-string translation of the
   *  speech this choice replies to. When present, it renders as a strip ABOVE
   *  the two option buttons so the user sees what was just said to them.
   *  Null/absent when the setting is off or the choice isn't a reply. */
  inputGlyph?: { glyph: string; fallback?: string } | null;
  onSelect: (option: BinaryChoiceOption) => void;
  /** Dismiss without voicing anything (the small Cancel button + 30s timeout). */
  onCancel: () => void;
  onDismiss: () => void;
}

export default function BinaryChoiceOverlay({ options, escapeKind, inputGlyph, onSelect, onCancel, onDismiss }: BinaryChoiceOverlayProps) {
  const { t } = useLanguage();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const active = !!options && options.length >= 2;

  // Escape button shape is driven entirely by the server-supplied
  // `escapeKind`. "maybe" = yellow + maybe-glyph; "neither" = red + no-glyph.
  // Older server builds that didn't ship the field default to "neither",
  // which matches the legacy display.
  const escapeButton = useMemo<SentenceButtonInput>(() => {
    return escapeKind === "maybe"
      ? { label: t("quickActions.maybe"), glyph: "maybe", color: "yellow" }
      : { label: t("quickActions.neitherOfThese"), glyph: "no", color: "red" };
  }, [escapeKind, t]);

  // Shrunk dimensions so three equal buttons fit across the row.
  const overlaySize = { button: "min(28vw, 240px)", icon: "min(17vw, 150px)" };

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
            {/* Experiment (glyphInputTranslation): glyph translation of the
                speech this choice replies to, shown above the buttons so the
                user sees what was just said to them. Only rendered when the
                server supplied a translation. */}
            {inputGlyph?.glyph && (
              <motion.div
                className="flex items-center justify-center rounded-2xl bg-white/85 px-5 py-3 shadow-lg"
                style={{ height: "5rem" }}
                initial={{ opacity: 0, y: -16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -16 }}
                transition={{ duration: 0.15 }}
              >
                <Glyph glyph={inputGlyph.glyph} fallback={inputGlyph.fallback} height="100%" noBackground />
              </motion.div>
            )}

            {/* Two options plus the equally-sized escape button, all rendered
                as full SENTENCE BUTTONs. The shared component handles glyph
                rendering, animated SYMBOLs, and auto-green/red coloring for
                yes/no; the escape button supplies its own color/image. All
                three voice through onSelect — the escape button has no
                sentence, so it voices its own label ("Maybe" / "Neither"). */}
            <div className="flex items-center justify-center gap-4 flex-wrap">
              {options.slice(0, 2).map((opt, i) => (
                <SentenceButton
                  key={i}
                  variant="overlay"
                  button={opt}
                  ariaLabel={opt.label}
                  overlaySize={overlaySize}
                  overlayEntranceDelay={i * 0.05}
                  extraButtonProps={{ "data-dwell": `choice-${i}` }}
                  onClick={() => onSelect(opt)}
                />
              ))}
              <SentenceButton
                variant="overlay"
                button={escapeButton}
                ariaLabel={escapeButton.label}
                overlaySize={overlaySize}
                overlayEntranceDelay={2 * 0.05}
                extraButtonProps={{ "data-dwell": "choice-2" }}
                onClick={() => onSelect(escapeButton)}
              />
            </div>

            {/* Small Cancel button — closes the overlay without voicing. */}
            <motion.button
              data-dwell="cancel"
              className="rounded-xl bg-gray-400/80 hover:bg-gray-500/80 text-white font-medium select-none py-2 px-8"
              style={{ fontSize: "clamp(0.9rem, 2.5vw, 1.2rem)" }}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              transition={{ delay: 0.2 }}
              onClick={onCancel}
            >
              {t("common.cancel")}
            </motion.button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
