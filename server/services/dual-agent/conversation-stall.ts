/**
 * Conversation STALL accumulator.
 *
 * Decides when the Board Manager's next rebuild should carry conversation
 * seeds. Pure, in the shape of `./idle-watchdog` — the "what should happen"
 * decision is isolated from the Coordinator's "do it" so the thresholds are
 * unit-testable without standing up a live session.
 *
 * A stall is not one event, it is an accumulation:
 *   - the board named nothing (see ./board-content-signal),
 *   - the user pressed [MORE] — they looked at eight buttons and none of
 *     them was the thing they wanted, which is the strongest signal the
 *     system gets and is already labelled `more_options_requested`,
 *   - a rebuild recycled the same referents as the board before it.
 *
 * And it cools off on its own: a board that introduces a fresh referent, or
 * a press on a button that names something, means the conversation is moving
 * and no intervention is due.
 *
 * NOTHING here rejects or blocks a board. The only consequence of a stall is
 * that the next rebuild gets seeds to draw on.
 */

import type { BoardContentSignal, ButtonContentVerdict } from "./board-content-signal";

/** Score at which the next rebuild carries seeds. */
export const STALL_THRESHOLD = 4;

/** Ceiling, so a long dry patch can't bank an unbounded score and then
 *  keep firing after the conversation recovers. */
export const STALL_SCORE_MAX = 8;

/** Weights. Two contentless boards, or one [MORE] plus one contentless
 *  board, reach the threshold — the exact sequence in the logged session. */
export const WEIGHTS = {
  contentlessBoard: 2,
  morePress: 2,
  recycledHeads: 1,
  freshBoard: -1,
  payloadPress: -2,
} as const;

export interface StallState {
  score: number;
  /** Content heads of the most recent board, to spot a rebuild that
   *  recycles the same referents. */
  lastHeads: string[];
  /** Every content head surfaced this session, oldest first. Passed to the
   *  Board Manager so a seed doesn't re-offer what has already been tried.
   *  This is also what rations the seed bank: a spent seed's referents land
   *  here via the board it produced, and the prompt block lists them as
   *  already used. No seed-id parsing, so nothing depends on the model
   *  echoing an identifier back. */
  seenHeads: string[];
  /** How many times seeds have been handed over this session. Logging and
   *  test visibility only. */
  seedInjections: number;
}

/** How many distinct heads to remember. Bounds the prompt block. */
const SEEN_HEADS_MAX = 40;

export function initialStallState(): StallState {
  return { score: 0, lastHeads: [], seenHeads: [], seedInjections: 0 };
}

function clamp(score: number): number {
  return Math.max(0, Math.min(STALL_SCORE_MAX, score));
}

function remember(seen: string[], heads: string[]): string[] {
  const next = [...seen];
  for (const h of heads) {
    const at = next.indexOf(h);
    if (at >= 0) next.splice(at, 1);
    next.push(h);
  }
  return next.slice(-SEEN_HEADS_MAX);
}

/**
 * A board was just pushed. Returns the new state and what drove the change
 * (for the flow log — a stall that fires with no visible cause is not
 * debuggable in a live session).
 */
export function noteBoardBuilt(
  state: StallState,
  signal: BoardContentSignal,
): { state: StallState; reason: string | null } {
  if (signal.total === 0) return { state, reason: null };

  let delta = 0;
  let reason: string | null = null;

  if (signal.contentless) {
    delta = WEIGHTS.contentlessBoard;
    const empties = signal.buttons.filter((b) => !b.hasPayload).map((b) => b.label);
    reason = `board named nothing (${signal.withPayload}/${signal.total} buttons carry a referent: ${empties.slice(0, 4).join(", ")})`;
  } else if (
    state.lastHeads.length > 0
    && signal.heads.every((h) => state.lastHeads.includes(h))
  ) {
    delta = WEIGHTS.recycledHeads;
    reason = `rebuild recycled the previous board's referents (${signal.heads.join(", ")})`;
  } else {
    delta = WEIGHTS.freshBoard;
  }

  return {
    state: {
      ...state,
      score: clamp(state.score + delta),
      lastHeads: signal.heads,
      seenHeads: remember(state.seenHeads, signal.heads),
    },
    reason,
  };
}

/** The user pressed [MORE] — the board failed them and they said so. */
export function noteMorePress(state: StallState): { state: StallState; reason: string } {
  return {
    state: { ...state, score: clamp(state.score + WEIGHTS.morePress) },
    reason: "user pressed More — nothing on the board was what they wanted",
  };
}

/** The user pressed a button. One that names something means the board did
 *  its job; a contentless press tells us nothing (they had no better
 *  option), so it neither heats nor cools. */
export function noteButtonPress(state: StallState, verdict: ButtonContentVerdict): StallState {
  if (!verdict.hasPayload) return state;
  return {
    ...state,
    score: clamp(state.score + WEIGHTS.payloadPress),
    seenHeads: remember(state.seenHeads, verdict.heads),
  };
}

/** Someone said something with a referent in it — a person entering, a new
 *  topic raised aloud. Real conversation is happening; stand down. */
export function noteExternalTopic(state: StallState, heads: string[] = []): StallState {
  return { ...state, score: 0, seenHeads: remember(state.seenHeads, heads) };
}

export function isStalling(state: StallState): boolean {
  return state.score >= STALL_THRESHOLD;
}

/** Seeds were handed to the Board Manager. Reset the score — without this
 *  the next rebuild would spend a second seed on the same stall, which is
 *  the generic-board failure one level up. */
export function noteSeedsSpent(state: StallState): StallState {
  return { ...state, score: 0, seedInjections: state.seedInjections + 1 };
}
