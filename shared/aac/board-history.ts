/**
 * board-history.ts
 *
 * Back / forward navigation for the AI's dynamic board, plus PAUSE. Pure — no
 * React, no DOM — so the rules that carry any subtlety are testable directly.
 *
 * The model is a browser's: a list of boards and a cursor into it. Back and
 * Forward move the cursor; a board arriving from the AI truncates whatever was
 * ahead and appends.
 *
 * TWO RULES CARRY THE BEHAVIOUR:
 *
 * 1. ADDING BUTTONS IS NOT A NEW BOARD. The Board Manager rebuilds constantly
 *    and much of that is additive — the "more options" press, an ambient
 *    context button, a sentence-builder suggestion landing. If every rebuild
 *    made an entry, Back would walk the student through a dozen near-identical
 *    boards one button at a time. So a rebuild whose buttons are a SUPERSET of
 *    the current one REPLACES the current entry: same board, more on it. The
 *    moment anything is REMOVED, the topic changed — that is a new board.
 *
 * 2. PAUSED MEANS THE SCREEN DOES NOT CHANGE. Not "changes less" — at all.
 *    A paused board that grew three buttons has still changed under a student
 *    who asked it to hold still, so while paused EVERY arriving board is
 *    stored AHEAD of the cursor and none is displayed, additive or not. The
 *    Forward button is how the student chooses to see them.
 *
 * History is capped (LIMIT): Back is for "that wasn't what I meant", not for
 * browsing a whole session, and an unbounded array of board snapshots is a
 * memory leak on a device that runs for hours.
 */

import type { ParsedBoardData, BoardButton } from "@shared/schema";

/** How many boards to keep in total (behind + ahead of the cursor). */
export const BOARD_HISTORY_LIMIT = 8;

/**
 * Identity of a button for sameness comparison. Deliberately NOT the `id`:
 * the Board Manager mints fresh ids on every rebuild, so ids would make every
 * board look new. What the student perceives is the utterance, so that is what
 * we compare — falling back to the label when there is no sentence.
 */
function buttonKey(b: BoardButton): string {
  return (b.sentence ?? "").trim() || (b.label ?? "").trim();
}

/** Every button on every page, as a key set. Pages are flattened because the
 *  student experiences the board as one surface; a rebuild that reshuffles
 *  buttons between pages without dropping any is still the same board. */
export function boardKeys(board: ParsedBoardData | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const page of board?.pages ?? []) {
    for (const b of page.buttons ?? []) {
      const k = buttonKey(b);
      if (k) out.add(k);
    }
  }
  return out;
}

/**
 * Is `next` the same board as `prev`, only with things added? True when every
 * button of `prev` is still on `next`. An identical board counts — a no-op
 * rebuild should not create an entry either.
 */
export function isAdditiveRebuild(
  prev: ParsedBoardData | null | undefined,
  next: ParsedBoardData | null | undefined,
): boolean {
  const prevKeys = boardKeys(prev);
  if (prevKeys.size === 0) return false;
  const nextKeys = boardKeys(next);
  for (const k of prevKeys) {
    if (!nextKeys.has(k)) return false; // something was removed → new board
  }
  return true;
}

// ---------------------------------------------------------------------------
// The history itself
// ---------------------------------------------------------------------------

export interface BoardHistory {
  /** Oldest first. */
  entries: ParsedBoardData[];
  /** Cursor: which entry is on screen. -1 when there is nothing yet. */
  index: number;
}

export function emptyBoardHistory(): BoardHistory {
  return { entries: [], index: -1 };
}

/** The board that should be displayed, or null before the first one arrives. */
export function currentBoard(h: BoardHistory): ParsedBoardData | null {
  return h.index >= 0 ? (h.entries[h.index] ?? null) : null;
}

export function canGoBack(h: BoardHistory): boolean {
  return h.index > 0;
}

/** True when boards exist AHEAD of the cursor — which is exactly when the
 *  reload slot becomes a Forward button. */
export function canGoForward(h: BoardHistory): boolean {
  return h.index >= 0 && h.index < h.entries.length - 1;
}

export function goBack(h: BoardHistory): BoardHistory {
  return canGoBack(h) ? { ...h, index: h.index - 1 } : h;
}

export function goForward(h: BoardHistory): BoardHistory {
  return canGoForward(h) ? { ...h, index: h.index + 1 } : h;
}

/** Trim the oldest entries down to the cap, keeping the cursor on the same
 *  board. Never trims anything AHEAD of the cursor — a board the student has
 *  not seen yet is the one thing worth keeping. */
function capped(h: BoardHistory, limit: number): BoardHistory {
  const overflow = h.entries.length - limit;
  if (overflow <= 0) return h;
  // Never drop the current board or anything after it.
  const drop = Math.min(overflow, h.index);
  if (drop <= 0) return h;
  return { entries: h.entries.slice(drop), index: h.index - drop };
}

/**
 * A board arrived from the AI.
 *
 *   - Nothing on screen yet → it becomes the current board, even while paused
 *     (pausing an empty screen should not leave the student with no board).
 *   - PAUSED → whatever was ahead is cleared, the board is appended AHEAD of
 *     the cursor, and the cursor does not move. Stored, not displayed.
 *   - Additive rebuild of the current board → replaces it in place. No new
 *     entry, cursor unmoved, forward entries untouched.
 *   - Otherwise → whatever was ahead is cleared, the board is appended, and
 *     the cursor advances onto it.
 */
export function receiveBoard(
  h: BoardHistory,
  board: ParsedBoardData,
  opts: { paused?: boolean; limit?: number } = {},
): BoardHistory {
  const { paused = false, limit = BOARD_HISTORY_LIMIT } = opts;

  if (h.index < 0) return { entries: [board], index: 0 };

  if (!paused && isAdditiveRebuild(h.entries[h.index], board)) {
    const entries = h.entries.slice();
    entries[h.index] = board;
    return { ...h, entries };
  }

  // A new navigation clears the forward stack, exactly like a browser.
  const kept = h.entries.slice(0, h.index + 1);
  const entries = kept.concat(board);
  const next: BoardHistory = { entries, index: paused ? h.index : entries.length - 1 };
  return capped(next, limit);
}
