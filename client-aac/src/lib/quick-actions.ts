/**
 * quick-actions.ts
 *
 * WHICH BUTTONS ARE IN THE FIXED QUICK-ACTION ROW, and in what order. Pure — no
 * React, no JSX, no i18n — so the row's composition can be tested directly and,
 * more importantly, so there is exactly ONE definition of it.
 *
 * There used to be two. `QuickActions.tsx` derived the row once for the render
 * (`showGuessSlot`, `showBoardNavSlots`, `getEndButton`, …) and a second time in
 * `quickActionsMirror()` for the clinician's mirrored view. The two drifted:
 * the mirror offered Back + Pause whenever the board was in AI mode, while the
 * student's actual row hid them while an app was open. A clinician watching the
 * mirror saw two buttons that were not on the child's screen.
 *
 * So: this module decides, `QuickActions.tsx` draws, and the mirror projects.
 * A rule added here reaches all three at once.
 *
 * ORDER IS LOAD-BEARING. The row is a CSS grid with auto-placement, which never
 * walks backwards — a slot emitted after Yes/No cannot be placed in a track
 * before them. The array order here IS the DOM order, and the component must
 * render it in sequence rather than re-sorting.
 *
 * Labels are returned as i18n KEYS, not text, so nothing here needs a `t`.
 */

import { MORE_OPTIONS_COLOR, MORE_OPTIONS_ICON } from "@shared/button-color";
import type { MirrorQuickButton } from "@shared/call/call-data-messages";

export type QuickActionId =
  | "speak"
  | "boardback"
  | "boardpause"
  | "boardforward"
  | "more"
  | "back"
  | "yes"
  | "no"
  | "home"
  | "exit"
  | "guess";

/**
 * How the icon is drawn. `emoji` is always populated — the row uses it for the
 * plain cases, and the MIRROR uses it for every case, because the data channel
 * has no way to carry an SVG the AAC draws itself.
 */
export type QuickActionIcon =
  /** Draw the emoji directly. */
  | { draw: "emoji"; emoji: string }
  /** Draw `<PauseGlyph/>` — the ⏸️ emoji renders as a coloured platform badge. */
  | { draw: "pause"; emoji: string }
  /** Draw `<YesNoSprite variant/>`. */
  | { draw: "yesno"; variant: "yes" | "no"; emoji: string };

export interface QuickActionSlot {
  id: QuickActionId;
  /** i18n key for the visible label. */
  labelKey: string;
  /** i18n key for `aria-label` when it must differ from the visible label —
   *  Pause keeps its label when held but announces "resume". */
  ariaLabelKey?: string;
  icon: QuickActionIcon;
  /** Background hex. */
  color: string;
  /** Lit-control state: guessing on, board held, builder open. */
  active: boolean;
  /**
   * False = the slot is RENDERED but dimmed and inert. Board Back and Forward
   * keep their track even with nowhere to go, so no button beside them moves
   * under an eye-gaze user mid-session; `data-dwell` comes off so gaze cannot
   * select a dead target.
   */
  enabled: boolean;
  testId?: string;
}

export interface QuickActionsState {
  boardMode: "ai" | "db";
  /** An app owns the screen. Excludes the social trainer at the call site. */
  hasActiveApp?: boolean;
  currentTier?: "home" | "context" | "latest";
  isGuessingMode?: boolean;
  /** The sentence builder is open — Speak becomes Back. */
  inSentenceBuilder?: boolean;
  /** Whether the Speak slot exists at all (the component: `!!onSpeak`). */
  showSpeakSlot?: boolean;
  /** A world-engine game owns the screen — the row becomes four tracks. */
  worldEngineGame?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  boardPaused?: boolean;
}

/** Speak, or the Back it becomes while the sentence builder is open. The back
 *  arrow points AGAINST the reading direction so it still reads as "go back". */
function speakSlot(inSentenceBuilder: boolean, isRTL: boolean): QuickActionSlot {
  return inSentenceBuilder
    ? {
        id: "speak",
        labelKey: "quickActions.back",
        icon: { draw: "emoji", emoji: isRTL ? "▶" : "◀" },
        color: "#FDE68A",
        active: true,
        enabled: true,
        testId: "quick-speak",
      }
    : {
        id: "speak",
        labelKey: "quickActions.speak",
        icon: { draw: "emoji", emoji: "💬" },
        color: "#FEF3C7",
        active: false,
        enabled: true,
        testId: "quick-speak",
      };
}

/** The trailing navigation slot: Exit an app, Back out of guessing / the home
 *  tier, Home from a context board, or Board from the latest page. */
function endSlot(s: QuickActionsState): QuickActionSlot {
  const base = { active: false, enabled: true, testId: "quick-end" } as const;
  if (s.hasActiveApp) {
    return { id: "exit", labelKey: "quickActions.exit", icon: { draw: "emoji", emoji: "✖️" }, color: "#FCA5A5", ...base };
  }
  if (s.isGuessingMode || (s.currentTier ?? "latest") === "home") {
    return { id: "home", labelKey: "quickActions.back", icon: { draw: "emoji", emoji: "↩️" }, color: "#C4B5FD", ...base };
  }
  if (s.currentTier === "context") {
    return { id: "home", labelKey: "quickActions.home", icon: { draw: "emoji", emoji: "🏠" }, color: "#DBEAFE", ...base };
  }
  return { id: "home", labelKey: "quickActions.board", icon: { draw: "emoji", emoji: "📋" }, color: "#E0E7FF", ...base };
}

/**
 * The row, in DOM order.
 *
 * In-game the row is FOUR tracks with Speak leading, so it sits directly under
 * the button sidebar it opens; everywhere else Speak trails. Grid auto-placement
 * is why that is an order change rather than a style one.
 */
export function quickActionSlots(state: QuickActionsState, isRTL: boolean): QuickActionSlot[] {
  const {
    boardMode,
    hasActiveApp = false,
    isGuessingMode = false,
    inSentenceBuilder = false,
    showSpeakSlot = true,
    worldEngineGame = false,
    canGoBack = false,
    canGoForward = false,
    boardPaused = false,
  } = state;

  // Navigating AI boards is meaningless inside a game or a prebuilt board, and
  // while an app owns the screen there is no AI board under it to step through.
  const showBoardNavSlots = boardMode === "ai" && !hasActiveApp && !worldEngineGame;
  const showMoreSlot = !worldEngineGame;
  // The builder carries its own Word Finder button, so the row drops it there.
  const showGuessSlot = boardMode === "ai" && !hasActiveApp && !inSentenceBuilder && !worldEngineGame;

  const out: QuickActionSlot[] = [];

  if (worldEngineGame && showSpeakSlot) out.push(speakSlot(inSentenceBuilder, isRTL));

  // Board navigation trio in reading order: Back, Pause, then Forward-or-More.
  // Back leads because it is what the student reaches for after a board changed
  // under them.
  if (showBoardNavSlots) {
    out.push({
      id: "boardback",
      labelKey: "quickActions.previous",
      icon: { draw: "emoji", emoji: isRTL ? "▶" : "◀" },
      color: "#E5E7EB",
      active: canGoBack,
      enabled: canGoBack,
      testId: "quick-board-back",
    });
    // Held or not, this stays the PAUSE button — lit, not swapped for a play
    // icon. "This button is what is holding the board still" is the thing the
    // student has to be able to read; a changing icon hides it.
    out.push({
      id: "boardpause",
      labelKey: "quickActions.pauseBoard",
      ariaLabelKey: boardPaused ? "quickActions.resumeBoard" : "quickActions.pauseBoard",
      icon: { draw: "pause", emoji: "⏸️" },
      color: boardPaused ? "#FDE68A" : "#E5E7EB",
      active: boardPaused,
      enabled: true,
      testId: "quick-board-pause",
    });
  }

  if (showMoreSlot) {
    if (boardMode === "ai") {
      // One slot, two jobs, so the row never changes width: Forward whenever
      // boards wait ahead, otherwise the reload that asks for more options.
      out.push(
        canGoForward
          ? {
              id: "boardforward",
              labelKey: "quickActions.forward",
              icon: { draw: "emoji", emoji: isRTL ? "◀" : "▶" },
              color: "#E5E7EB",
              active: true,
              enabled: true,
              testId: "quick-board-forward",
            }
          : {
              id: "more",
              labelKey: "quickActions.more",
              icon: { draw: "emoji", emoji: MORE_OPTIONS_ICON },
              color: MORE_OPTIONS_COLOR,
              active: false,
              enabled: true,
              testId: "quick-more",
            },
      );
    } else {
      out.push({
        id: "back",
        labelKey: "quickActions.back",
        icon: { draw: "emoji", emoji: "◀" },
        color: "#E5E7EB",
        active: false,
        enabled: true,
      });
    }
  }

  out.push({
    id: "yes",
    labelKey: "quickActions.yes",
    icon: { draw: "yesno", variant: "yes", emoji: "✓" },
    color: "#D1FAE5",
    active: false,
    enabled: true,
  });
  out.push({
    id: "no",
    labelKey: "quickActions.no",
    icon: { draw: "yesno", variant: "no", emoji: "✗" },
    color: "#FEE2E2",
    active: false,
    enabled: true,
  });

  out.push(endSlot({ ...state, hasActiveApp, isGuessingMode }));

  if (showGuessSlot) {
    out.push({
      id: "guess",
      labelKey: "quickActions.guess",
      icon: { draw: "emoji", emoji: "🔍" },
      color: isGuessingMode ? "#C4B5FD" : "#EDE9FE",
      active: isGuessingMode,
      enabled: true,
      testId: "quick-guess",
    });
  }

  if (!worldEngineGame && showSpeakSlot) out.push(speakSlot(inSentenceBuilder, isRTL));

  return out;
}

/**
 * Serialize the row for the clinician's mirrored view — the same slots, flattened
 * to label + emoji + colour. Derived, never re-decided: this is why the mirror
 * cannot drift from the child's screen again.
 */
export function quickActionsMirror(
  state: QuickActionsState,
  t: (k: string) => string,
  isRTL: boolean,
): MirrorQuickButton[] {
  return quickActionSlots(state, isRTL).map((slot) => ({
    id: slot.id,
    label: t(slot.labelKey),
    emoji: slot.icon.emoji,
    color: slot.color,
    active: slot.active,
  }));
}
