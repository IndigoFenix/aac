import { motion } from "framer-motion";
import type { CSSProperties } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { YesNoSprite } from "@/components/YesNoSprite";
// WHICH slots the row has, and in what order, is decided in one place — this
// component only draws them. The clinician's mirror projects the same slots,
// so the two can no longer disagree about what is on the child's screen.
import { quickActionSlots, type QuickActionSlot } from "@shared/aac/quick-actions";

// Re-exported so existing importers (home.tsx → the call mirror) keep working.
export { quickActionsMirror } from "@shared/aac/quick-actions";

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
  /**
   * In-game chrome (a world-engine game is the active app): Speak takes the
   * first track, sized and aligned to the button SIDEBAR above it (the board
   * it opens), and Yes / No / Exit share the rest of the bar — Exit last, in
   * the lower corner at the reading-direction end. "More" and "Guess" are
   * dropped (the AI board they feed isn't in front of the student).
   */
  worldEngineGame?: boolean;
  /**
   * Whether stepping back to a previous AI board is possible. The Back slot is
   * rendered either way (a slot that appears and disappears would move every
   * other button under an eye-gaze user mid-session) — this only decides
   * whether it is live or dimmed.
   */
  canGoBack?: boolean;
  /**
   * Boards exist AHEAD of the current one — because the student went back, or
   * because boards arrived while the board was paused. When true the reload
   * ("more options") slot becomes Forward instead: one slot, two jobs, so the
   * row never changes width.
   */
  canGoForward?: boolean;
  /** Board updates are held: arriving boards are stored, not displayed. */
  boardPaused?: boolean;
}

/**
 * Pause glyph, drawn rather than typed. The ⏸️ emoji renders as a coloured,
 * platform-specific badge (and is missing outright on some Android builds),
 * which reads as decoration beside the flat quick-action icons. Two bars in
 * `currentColor`, so it inherits the label's ink in both themes.
 *
 * Sized in `cqmin` against `.icon-fill-area`'s size container — the same unit
 * the emoji and YesNoSprite use, at the same 92% that leaves the ink a hair of
 * breathing room. (A percentage height would be at the mercy of the centred
 * flex parent; cqmin resolves against the container regardless.)
 */
function PauseGlyph() {
  return (
    <svg
      viewBox="0 0 100 100"
      style={{ width: "92cqmin", height: "92cqmin" }}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="26" y="18" width="17" height="64" rx="5" fill="currentColor" />
      <rect x="57" y="18" width="17" height="64" rx="5" fill="currentColor" />
    </svg>
  );
}

/**
 * Per-slot border treatment. Purely presentational, so it stays here rather
 * than in the slot table: `active` is the state, this is how the state looks.
 * Lit controls (Pause held, Guess on, Speak while the builder is open) share
 * one visual language across every surface that exposes them.
 */
function borderClassFor(slot: QuickActionSlot): string {
  if (slot.id === "back") return "border-gray-300 dark:border-gray-600 bg-gray-200 dark:bg-gray-700";
  if (slot.id === "guess") {
    return slot.active
      ? "border-violet-600 border-2 ring-2 ring-violet-400 dark:border-violet-300"
      : "border-violet-300 dark:border-violet-500";
  }
  if (slot.active && (slot.id === "boardpause" || slot.id === "speak")) {
    return "border-amber-500 border-2 ring-2 ring-amber-300";
  }
  return "border-gray-200 dark:border-gray-600";
}

export default function QuickActions({ onAction, onBack, boardMode, hasActiveApp, currentTier = "latest", isGuessingMode = false, onSpeak, inSentenceBuilder = false, worldEngineGame = false, canGoBack = false, canGoForward = false, boardPaused = false }: QuickActionsProps) {
  const { t, isRTL } = useLanguage();

  const slots = quickActionSlots(
    {
      boardMode,
      hasActiveApp,
      currentTier,
      isGuessingMode,
      inSentenceBuilder,
      showSpeakSlot: !!onSpeak,
      worldEngineGame,
      canGoBack,
      canGoForward,
      boardPaused,
    },
    isRTL,
  );

  // In-game the bar is FOUR tracks: Speak first at the sidebar's own width, so
  // it sits directly under the board it opens (28rem board − the bar's 0.5rem
  // padding on each side = 27rem, which lines its edges up with the board
  // buttons), then Yes / No / Exit sharing the rest — Exit last, in the lower
  // corner at the reading-direction end (the grid mirrors with dir in RTL).
  const columns = slots.length;
  const gridTemplateColumns = worldEngineGame
    ? `27rem repeat(${Math.max(0, columns - 1)}, minmax(0, 1fr))`
    : `repeat(${columns}, minmax(0, 1fr))`;

  // Definite row height (responsive, capped) so the buttons have a real box
  // for their icons to fill — `grid-auto-rows: 1fr` makes the single row take
  // the whole container height so each button stretches to fill it.
  const rowStyle: CSSProperties = { height: "clamp(6rem, 16.5dvh, 10.5rem)", gridAutoRows: "1fr" };
  // Shared button shell: fills its grid cell; icon area grows, label is a
  // content-height strip below it — same fill model as the board buttons.
  const btnClass =
    "h-full flex flex-col items-center justify-center p-1 rounded-xl shadow-sm border overflow-hidden";
  const labelClass = "text-xs font-semibold text-center leading-tight line-clamp-2 shrink-0";

  const press = (slot: QuickActionSlot) => {
    if (slot.id === "speak") return onSpeak?.();
    if (slot.id === "back") return onBack();
    if (!slot.enabled) return;
    onAction(slot.id, t(slot.labelKey));
  };

  return (
    <div
      className="grid gap-2 p-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 shrink-0"
      style={{ ...rowStyle, gridTemplateColumns }}
    >
      {slots.map((slot, i) => {
        const label = t(slot.labelKey);
        const aria = slot.ariaLabelKey ? t(slot.ariaLabelKey) : undefined;
        // The DB-mode Back button paints from Tailwind classes so it follows
        // dark mode; every other slot carries a fixed hex from the slot table.
        const inlineBg = slot.id === "back" ? undefined : slot.color;
        // Dimmed-and-inert slots keep their track (so nothing beside them moves
        // under an eye-gaze user) but drop `data-dwell` so gaze cannot select a
        // dead target.
        const inert = !slot.enabled;
        return (
          <motion.button
            key={`${slot.id}-${i}`}
            {...(inert ? {} : { "data-dwell": true })}
            {...(slot.testId ? { "data-testid": slot.testId } : {})}
            {...(slot.active ? { "data-active": "true" } : {})}
            {...(slot.id === "boardpause" || slot.id === "speak" ? { "aria-pressed": slot.active } : {})}
            {...(aria ? { "aria-label": aria } : {})}
            disabled={inert}
            aria-disabled={inert}
            onClick={() => press(slot)}
            className={`${btnClass} ${borderClassFor(slot)} ${inert ? "opacity-40 pointer-events-none" : ""}`}
            style={{
              ...(inlineBg ? { backgroundColor: inlineBg } : {}),
              // In-game, the trailing nav slot is pinned to the last track so it
              // lands in the lower corner of the screen.
              ...(worldEngineGame && (slot.id === "home" || slot.id === "exit")
                ? { gridColumnStart: columns }
                : {}),
            }}
            whileHover={inert ? undefined : { scale: 1.05 }}
            whileTap={inert ? undefined : { scale: 0.95 }}
          >
            <div className="icon-fill-area">
              {slot.icon.draw === "pause" ? (
                <PauseGlyph />
              ) : slot.icon.draw === "yesno" ? (
                <YesNoSprite variant={slot.icon.variant} size="92cqmin" />
              ) : (
                <span className="icon-fill-emoji">{slot.icon.emoji}</span>
              )}
            </div>
            <span
              className={`${labelClass} ${slot.id === "back" ? "text-gray-700 dark:text-gray-300" : "text-gray-800"}`}
            >
              {label}
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}
