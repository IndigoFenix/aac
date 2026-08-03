import { motion } from "framer-motion";
import type { CSSProperties } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { YesNoSprite } from "@/components/YesNoSprite";
// The MORE OPTIONS look is shared with the AI's `button_type: "more"` board
// buttons (see DynamicBoard) so the student learns ONE visual for "show me
// other things I could say". Never re-state the hex/emoji here.
import { MORE_OPTIONS_COLOR, MORE_OPTIONS_ICON } from "@shared/button-color";

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

/** A serialized quick-action button for the call board-mirror (read-only). */
export interface QuickActionMirror {
  id: string;
  label: string;
  emoji?: string;
  color?: string;
  active?: boolean;
}

/** Build the quick-action row descriptor (same decisions as the rendered row),
 *  for streaming to a clinician's mirrored view. Pure — no JSX. */
export function quickActionsMirror(
  opts: { boardMode: "ai" | "db"; hasActiveApp?: boolean; currentTier?: "home" | "context" | "latest"; isGuessingMode?: boolean; inSentenceBuilder?: boolean; showSpeakSlot?: boolean; worldEngineGame?: boolean; canGoBack?: boolean; canGoForward?: boolean; boardPaused?: boolean },
  t: (k: string) => string,
  isRTL: boolean,
): QuickActionMirror[] {
  const { boardMode, hasActiveApp, currentTier = "latest", isGuessingMode = false, inSentenceBuilder = false, showSpeakSlot = true, worldEngineGame = false, canGoBack = false, canGoForward = false, boardPaused = false } = opts;
  const out: QuickActionMirror[] = [];
  // In-game, Speak leads the row (under the sidebar board it opens).
  if (worldEngineGame && showSpeakSlot) {
    out.push(inSentenceBuilder
      ? { id: "speak", label: t("quickActions.back"), emoji: isRTL ? "▶" : "◀", color: "#E5E7EB" }
      : { id: "speak", label: t("quickActions.speak"), emoji: "💬", color: "#FEF3C7" });
  }
  // Board navigation trio, in reading order: Back, Pause, then Forward-or-More.
  // Back leads because it is the one the student reaches for after a board
  // changed under them.
  if (boardMode === "ai" && !worldEngineGame) {
    out.push({
      id: "boardback",
      label: t("quickActions.previous"),
      emoji: isRTL ? "▶" : "◀",
      color: "#E5E7EB",
      active: canGoBack,
    });
    // Label and icon stay put when held — only the colour changes (see the
    // rendered button). The mirror has no SVG channel, so it carries the emoji
    // as an approximation of a glyph the AAC draws itself.
    out.push({
      id: "boardpause",
      label: t("quickActions.pauseBoard"),
      emoji: "⏸️",
      color: boardPaused ? "#FDE68A" : "#E5E7EB",
      active: boardPaused,
    });
  }
  if (!worldEngineGame) {
    out.push(boardMode === "ai"
      // One slot, two jobs — Forward whenever boards wait ahead, otherwise the
      // reload that asks the AI for more options.
      ? (canGoForward
          ? { id: "boardforward", label: t("quickActions.forward"), emoji: isRTL ? "◀" : "▶", color: "#E5E7EB", active: true }
          : { id: "more", label: t("quickActions.more"), emoji: MORE_OPTIONS_ICON, color: MORE_OPTIONS_COLOR })
      : { id: "back", label: t("quickActions.back"), emoji: "◀", color: "#E5E7EB" });
  }
  out.push({ id: "yes", label: t("quickActions.yes"), emoji: "✓", color: "#D1FAE5" });
  out.push({ id: "no", label: t("quickActions.no"), emoji: "✗", color: "#FEE2E2" });
  out.push(
    hasActiveApp ? { id: "exit", label: t("quickActions.exit"), emoji: "✖️", color: "#FCA5A5" }
    : isGuessingMode || currentTier === "home" ? { id: "home", label: t("quickActions.back"), emoji: "↩️", color: "#C4B5FD" }
    : currentTier === "context" ? { id: "home", label: t("quickActions.home"), emoji: "🏠", color: "#DBEAFE" }
    : { id: "home", label: t("quickActions.board"), emoji: "📋", color: "#E0E7FF" });
  if (boardMode === "ai" && !hasActiveApp && !inSentenceBuilder && !worldEngineGame) {
    out.push({ id: "guess", label: t("quickActions.guess"), emoji: "🔍", color: isGuessingMode ? "#C4B5FD" : "#EDE9FE", active: isGuessingMode });
  }
  if (showSpeakSlot && !worldEngineGame) {
    out.push(inSentenceBuilder
      ? { id: "speak", label: t("quickActions.back"), emoji: isRTL ? "▶" : "◀", color: "#E5E7EB" }
      : { id: "speak", label: t("quickActions.speak"), emoji: "💬", color: "#FEF3C7" });
  }
  return out;
}

export default function QuickActions({ onAction, onBack, boardMode, hasActiveApp, currentTier = "latest", isGuessingMode = false, onSpeak, inSentenceBuilder = false, worldEngineGame = false, canGoBack = false, canGoForward = false, boardPaused = false }: QuickActionsProps) {
  const { t, isRTL } = useLanguage();

  const quickActions: Array<{ id: "yes" | "no"; labelKey: string; color: string }> = [
    { id: "yes", labelKey: "quickActions.yes", color: "#D1FAE5" },
    { id: "no", labelKey: "quickActions.no", color: "#FEE2E2" },
  ];

  const handleAction = (action: typeof quickActions[0]) => {
    const label = t(action.labelKey);
    onAction(action.id, label);
  };

  // Determine what the last button should be based on navigation tier
  const getEndButton = () => {
    if (hasActiveApp) {
      return { id: "exit", labelKey: "quickActions.exit", emoji: "✖️", color: "#FCA5A5" };
    }
    if (isGuessingMode) {
      return { id: "home", labelKey: "quickActions.back", emoji: "↩️", color: "#C4B5FD" };
    }
    switch (currentTier) {
      case "home":
        return { id: "home", labelKey: "quickActions.back", emoji: "↩️", color: "#C4B5FD" };
      case "context":
        return { id: "home", labelKey: "quickActions.home", emoji: "🏠", color: "#DBEAFE" };
      case "latest":
      default:
        return { id: "home", labelKey: "quickActions.board", emoji: "📋", color: "#E0E7FF" };
    }
  };

  const endButton = getEndButton();

  // Speak button toggles to Back when the sentence builder is open. Only
  // rendered when a handler is wired — keeps the row at 4 cols otherwise so
  // existing screens are unaffected.
  const showSpeakSlot = !!onSpeak;
  // "Guess" is the Word Finder entry — always visible in the AI dynamic
  // board when no app is open and we're not inside the sentence builder
  // (the builder has its own Word Finder button). Click toggles entry/exit
  // based on isGuessingMode (single source of truth from the server).
  const showGuessSlot =
    boardMode === "ai" && !hasActiveApp && !inSentenceBuilder && !worldEngineGame;
  const showMoreSlot = !worldEngineGame;
  // Board Back + Pause — same visibility rule as Guess, minus the builder
  // exclusion: navigating AI boards is meaningless in a game or a prebuilt board.
  const showBoardNavSlots = boardMode === "ai" && !hasActiveApp && !worldEngineGame;
  // In-game the bar is FOUR tracks: Speak first at the sidebar's own width, so
  // it sits directly under the board it opens (28rem board − the bar's 0.5rem
  // padding on each side = 27rem, which lines its edges up with the board
  // buttons), then Yes / No / Exit sharing the rest — Exit last, in the lower
  // corner at the reading-direction end (the grid mirrors with dir in RTL).
  const columns = worldEngineGame
    ? 4
    : 4 + (showSpeakSlot ? 1 : 0) + (showGuessSlot ? 1 : 0) + (showBoardNavSlots ? 2 : 0);
  const gridTemplateColumns = worldEngineGame
    ? `27rem repeat(3, minmax(0, 1fr))`
    : `repeat(${columns}, minmax(0, 1fr))`;
  const speakLabel = inSentenceBuilder ? t("quickActions.back") : t("quickActions.speak");
  // Back arrow points opposite reading direction (away from "forward") —
  // ▶ in RTL so it still reads as "go back", ◀ in LTR.
  const speakIcon = inSentenceBuilder ? (isRTL ? "▶" : "◀") : "💬";
  const speakColor = inSentenceBuilder ? "#E5E7EB" : "#FEF3C7";

  // Definite row height (responsive, capped) so the buttons have a real box
  // for their icons to fill — `grid-auto-rows: 1fr` makes the single row take
  // the whole container height so each button stretches to fill it.
  const rowStyle: CSSProperties = { height: "clamp(6rem, 16.5dvh, 10.5rem)", gridAutoRows: "1fr" };
  // Shared button shell: fills its grid cell; icon area grows, label is a
  // content-height strip below it — same fill model as the board buttons.
  const btnClass =
    "h-full flex flex-col items-center justify-center p-1 rounded-xl shadow-sm border overflow-hidden";
  const labelClass = "text-xs font-semibold text-center leading-tight line-clamp-2 shrink-0";

  // Speak (opens the sentence builder) / Back (closes it). Rendered FIRST in
  // the in-game row and last everywhere else — grid auto-placement never walks
  // backwards, so a Speak that trails Yes/No in the DOM would be pushed onto a
  // second row rather than into the leading track.
  const speakButton = showSpeakSlot ? (
    <motion.button
      data-dwell
      data-testid="quick-speak"
      onClick={onSpeak}
      className={`${btnClass} border-gray-200 dark:border-gray-600`}
      style={{ backgroundColor: speakColor }}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
    >
      <div className="icon-fill-area"><span className="icon-fill-emoji">{speakIcon}</span></div>
      <span className={`${labelClass} text-gray-800`}>
        {speakLabel}
      </span>
    </motion.button>
  ) : null;

  return (
    <div
      className="grid gap-2 p-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 shrink-0"
      style={{ ...rowStyle, gridTemplateColumns }}
    >
      {/* In-game, Speak leads the row in the sidebar-wide first track. */}
      {worldEngineGame && speakButton}

      {/* Board navigation trio, in reading order: Back, Pause, Forward-or-More.
          Back leads because it is what the student reaches for after a board
          changed under them; the third slot is shared so the row never changes
          width. Back and Forward render even with nowhere to go — dimmed and
          inert — so the buttons beside them never move under an eye-gaze user.
          data-dwell is dropped while inert so gaze can't dwell-select a dead
          target. */}
      {showBoardNavSlots && (
        <motion.button
          {...(canGoBack ? { "data-dwell": true } : {})}
          data-testid="quick-board-back"
          disabled={!canGoBack}
          aria-disabled={!canGoBack}
          onClick={() => canGoBack && onAction("boardback", t("quickActions.previous"))}
          className={`${btnClass} border-gray-200 dark:border-gray-600 ${canGoBack ? "" : "opacity-40 pointer-events-none"}`}
          style={{ backgroundColor: "#E5E7EB" }}
          whileHover={canGoBack ? { scale: 1.05 } : undefined}
          whileTap={canGoBack ? { scale: 0.95 } : undefined}
        >
          <div className="icon-fill-area"><span className="icon-fill-emoji">{isRTL ? "▶" : "◀"}</span></div>
          <span className={`${labelClass} text-gray-800`}>
            {t("quickActions.previous")}
          </span>
        </motion.button>
      )}

      {/* Pause the board: arriving boards are stored, not shown.
          The icon and label DON'T change when held — it stays the pause button,
          lit yellow, and the board section picks up a matching yellow frame.
          Swapping it to a play icon would say "this is now the play button",
          which hides the thing the student needs to understand: THIS button is
          what is holding the board still. Lit control + framed board reads as
          one statement; two changing icons read as two unrelated ones. */}
      {showBoardNavSlots && (
        <motion.button
          data-dwell
          data-testid="quick-board-pause"
          data-active={boardPaused ? "true" : undefined}
          aria-pressed={boardPaused}
          aria-label={t(boardPaused ? "quickActions.resumeBoard" : "quickActions.pauseBoard")}
          onClick={() => onAction("boardpause", t("quickActions.pauseBoard"))}
          className={`${btnClass} ${boardPaused ? "border-amber-500 border-2 ring-2 ring-amber-300" : "border-gray-200 dark:border-gray-600"}`}
          style={{ backgroundColor: boardPaused ? "#FDE68A" : "#E5E7EB" }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <div className="icon-fill-area"><PauseGlyph /></div>
          <span className={`${labelClass} text-gray-800`}>
            {t("quickActions.pauseBoard")}
          </span>
        </motion.button>
      )}

      {/* Shared slot: Forward when boards wait ahead, otherwise the reload that
          asks the AI for more options. DB mode keeps its own Back here. */}
      {showMoreSlot && (boardMode === 'ai' ? (canGoForward ? (
        <motion.button
          data-dwell
          data-testid="quick-board-forward"
          onClick={() => onAction("boardforward", t("quickActions.forward"))}
          className={`${btnClass} border-gray-200 dark:border-gray-600`}
          style={{ backgroundColor: "#E5E7EB" }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <div className="icon-fill-area"><span className="icon-fill-emoji">{isRTL ? "◀" : "▶"}</span></div>
          <span className={`${labelClass} text-gray-800`}>
            {t("quickActions.forward")}
          </span>
        </motion.button>
      ) : (
        <motion.button
          data-dwell
          data-testid="quick-more"
          onClick={() => onAction("more", t("quickActions.more"))}
          className={`${btnClass} border-gray-200 dark:border-gray-600`}
          style={{ backgroundColor: MORE_OPTIONS_COLOR }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <div className="icon-fill-area"><span className="icon-fill-emoji">{MORE_OPTIONS_ICON}</span></div>
          <span className={`${labelClass} text-gray-800`}>
            {t("quickActions.more")}
          </span>
        </motion.button>
      )) : (
        <motion.button
          data-dwell
          onClick={onBack}
          className={`${btnClass} border-gray-300 dark:border-gray-600 bg-gray-200 dark:bg-gray-700`}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <div className="icon-fill-area"><span className="icon-fill-emoji">◀</span></div>
          <span className={`${labelClass} text-gray-700 dark:text-gray-300`}>
            {t("quickActions.back")}
          </span>
        </motion.button>
      ))}

      {/* Yes and No buttons */}
      {quickActions.map((action) => (
        <motion.button
          data-dwell
          key={action.id}
          onClick={() => handleAction(action)}
          className={`${btnClass} border-gray-200 dark:border-gray-600`}
          style={{ backgroundColor: action.color }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <div className="icon-fill-area"><YesNoSprite variant={action.id} size="92cqmin" /></div>
          <span className={`${labelClass} text-gray-800`}>
            {t(action.labelKey)}
          </span>
        </motion.button>
      ))}

      {/* 4th button: Home / Back / Board / Exit. During a world-engine game
          (endButton is always Exit there — an app is active) it's pinned into
          the last grid track so it sits in the lower corner of the screen. */}
      <motion.button
        data-dwell
        data-testid="quick-end"
        onClick={() => onAction(endButton.id, t(endButton.labelKey))}
        className={`${btnClass} border-gray-200 dark:border-gray-600`}
        style={{
          backgroundColor: endButton.color,
          ...(worldEngineGame ? { gridColumnStart: columns } : {}),
        }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
      >
        <div className="icon-fill-area"><span className="icon-fill-emoji">{endButton.emoji}</span></div>
        <span className={`${labelClass} text-gray-800`}>
          {t(endButton.labelKey)}
        </span>
      </motion.button>

      {/* Word Finder: the same button enters and exits guessing mode. When
          active, an extra ring + thicker border highlights it across every
          surface that exposes the button (this row + the sentence builder). */}
      {showGuessSlot && (
        <motion.button
          data-dwell
          data-testid="quick-guess"
          data-active={isGuessingMode ? "true" : undefined}
          onClick={() => onAction("guess", t("quickActions.guess"))}
          className={`${btnClass} ${
            isGuessingMode
              ? "border-violet-600 border-2 ring-2 ring-violet-400 dark:border-violet-300"
              : "border-violet-300 dark:border-violet-500"
          }`}
          style={{ backgroundColor: isGuessingMode ? "#C4B5FD" : "#EDE9FE" }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <div className="icon-fill-area"><span className="icon-fill-emoji">🔍</span></div>
          <span className={`${labelClass} text-gray-800`}>
            {t("quickActions.guess")}
          </span>
        </motion.button>
      )}

      {/* Speak (opens sentence builder) / Back (closes it) — trailing slot
          outside a world-engine game, where it leads the row instead. */}
      {!worldEngineGame && speakButton}
    </div>
  );
}
