// client-aac/src/components/HomeActionConfirm.tsx
//
// The confirm step for a smart-home action the clinician flagged
// `requiresConfirmation`. Pressing such a button actuates NOTHING on its own —
// it raises this, and only a deliberate Yes press fires the action (see the
// `run_home_action` branch in DynamicBoard).
//
// Presentation is the house yes/no shape, not a new one: the same overlay the
// binary choice and the game-exit confirm already use (full-area scrim,
// `data-dwell-trap`, two `SentenceButton variant="overlay"` carrying the `yes`
// and `no` SYMBOLs with their default green/red coloring, Yes first). A student
// who has learned to answer the AI's questions answers this the same way.
//
// DWELL SAFETY — this is why the overlay is not simply centred.
// The press that raises it was itself a dwell selection, so the gaze is
// resting on the button that was just pressed. Two rules keep that from
// running the action by accident:
//   1. The shared SelectionGate (shared/selection-gate.ts) disarms selection
//      the instant a dwell fires and re-arms only after the point travels
//      `reactivationPx`, and a freshly-mounted button is a new element, so its
//      dwell timer starts at zero. That is inherited, not restated here.
//   2. PLACEMENT — the Yes/No row is pinned to whichever edge of the board has
//      more clear space BEYOND the pressed button, so the targets never render
//      over the spot the gaze is already parked on. `bandPx` is that clear
//      space; the buttons shrink to fit it rather than spill back across the
//      pressed cell. `null` means the caller could not measure (no grid yet) —
//      then the row centres at full size and rule 1 stands alone.
//
// Declining or letting it time out dismisses it: nothing is spoken and nothing
// is reported to the server.

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLanguage } from "@/contexts/LanguageContext";
import { SentenceButton } from "@/components/SentenceButton";
import { Glyph } from "@/components/Glyph";
import { glyphStripWidth } from "@/lib/glyph-layout";
import type { ConfirmPlacement } from "@/lib/home-confirm-placement";
import type { BoardButton, BoardButtonAction } from "@shared/schema";

/** A flagged press waiting on the student's answer. */
export interface PendingHomeAction extends ConfirmPlacement {
  /** The pressed button's action — actuated verbatim once confirmed. */
  action: BoardButtonAction;
  /** The pressed button, so the confirm can show what it is being asked about. */
  button: BoardButton;
}

/** Matches BinaryChoiceOverlay — the only auto-dismiss the student meets today. */
const AUTO_DISMISS_MS = 30000;

/** Vertical room the prompt pill and the row gap need inside the band. */
const PROMPT_ALLOWANCE_PX = 84;

/** Never shrink a target below this, however tight the band. */
const MIN_BUTTON_PX = 96;
const MAX_BUTTON_PX = 240;

interface HomeActionConfirmProps {
  pending: PendingHomeAction | null;
  /** Yes — run the action for real, with `confirmed: true` on the report. */
  onConfirm: () => void;
  /** No — dismiss. Nothing spoken, nothing sent. */
  onDecline: () => void;
  /** Unanswered for AUTO_DISMISS_MS. Same outcome as declining. */
  onTimeout: () => void;
}

export default function HomeActionConfirm({ pending, onConfirm, onDecline, onTimeout }: HomeActionConfirmProps) {
  const { t } = useLanguage();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  // Keyed on the action id so a second flagged press restarts the clock rather
  // than inheriting the remains of the first one's.
  const actionId = pending?.action.actionId ?? null;
  useEffect(() => {
    if (!actionId) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onTimeoutRef.current(), AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [actionId]);

  // Fit the pair into the clear band. Unmeasured (null) keeps the binary
  // choice's own size, which is what the student sees everywhere else.
  const fitted =
    pending?.bandPx == null
      ? MAX_BUTTON_PX
      : Math.max(MIN_BUTTON_PX, Math.min(MAX_BUTTON_PX, pending.bandPx - PROMPT_ALLOWANCE_PX));
  const overlaySize = {
    button: `min(28vw, ${Math.round(fitted)}px)`,
    icon: `min(17vw, ${Math.round(fitted * 0.62)}px)`,
  };

  const button = pending?.button;
  const label = pending?.action.label || button?.label || "";
  const hasGlyph = !!(button?.glyph || button?.glyphFallback);

  return (
    <AnimatePresence>
      {pending && (
        <motion.div
          data-dwell-trap
          data-testid="home-action-confirm"
          className="absolute inset-0 z-40 flex justify-center px-2 py-2 bg-black/40 backdrop-blur-md"
          style={{
            alignItems:
              pending.bandPx == null ? "center" : pending.place === "top" ? "flex-start" : "flex-end",
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="flex flex-col items-center gap-2 min-h-0">
            {/* What is being confirmed — the action's own icon and name above
                the question, never spliced into it (word order is the
                translator's to choose). Deliberately NOT a button: a third
                large target beside Yes/No is a third thing a gaze can land on.
                The glyph needs an explicit width — it renders as an absolutely
                positioned SVG whose `width:100%` collapses to 0 in a
                shrink-to-fit row — so it is sized to its own slot count. */}
            <div className="flex flex-col items-center gap-1 rounded-2xl bg-white/90 px-5 py-2 shadow-lg dark:bg-gray-800/90">
              <div className="flex items-center gap-3">
                {hasGlyph ? (
                  <span className="shrink-0" style={{ height: "2.5rem", width: glyphStripWidth(button!.glyph || button!.glyphFallback, 2.5, 40) }}>
                    <Glyph glyph={button!.glyph} fallback={button!.glyphFallback} noBackground ariaLabel={label} />
                  </span>
                ) : button?.iconRef ? (
                  <span aria-hidden="true" style={{ fontSize: "clamp(1.2rem, 3vw, 2rem)", lineHeight: 1 }}>
                    {button.iconRef}
                  </span>
                ) : null}
                {label && (
                  <span
                    className="font-bold text-gray-800 dark:text-gray-100 text-center"
                    style={{ fontSize: "clamp(0.9rem, 2.4vw, 1.5rem)" }}
                  >
                    {label}
                  </span>
                )}
              </div>
              <span
                className="text-gray-700 dark:text-gray-200 text-center"
                style={{ fontSize: "clamp(0.8rem, 2vw, 1.2rem)" }}
              >
                {t("quickActions.homeActionConfirm")}
              </span>
            </div>

            <div className="flex items-center justify-center gap-4 min-h-0">
              <SentenceButton
                variant="overlay"
                button={{ label: t("quickActions.yes"), glyph: "yes" }}
                ariaLabel={t("quickActions.yes")}
                overlaySize={overlaySize}
                extraButtonProps={{ "data-dwell": "home-confirm-yes", "data-testid": "home-confirm-yes" }}
                onClick={onConfirm}
              />
              <SentenceButton
                variant="overlay"
                button={{ label: t("quickActions.no"), glyph: "no" }}
                ariaLabel={t("quickActions.no")}
                overlaySize={overlaySize}
                overlayEntranceDelay={0.05}
                extraButtonProps={{ "data-dwell": "home-confirm-no", "data-testid": "home-confirm-no" }}
                onClick={onDecline}
              />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
