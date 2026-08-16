// shared/world-engine/interaction/quest/board-chrome.ts
//
// THE TWO BUTTONS EVERY LIST NEEDS — once, for every board.
//
// A button board that shows a LIST has two problems no individual board should
// have to solve for itself: the list can be longer than the board, and the
// player needs a way out of it. Every surface that grew one of those answers
// grew its own ("stop building", a cancel gesture, a silently truncated list),
// and the ones that didn't simply dropped options off the end.
//
// So it lives here, once: a pure function that takes the options a board wants
// to show and returns the page the player should see, with MORE appended when
// the list genuinely doesn't fit and BACK appended when there is somewhere to
// go back to. Every `presenter.board` call in the host goes through it, so a
// new board gets both for free and no board special-cases either.
//
// WHY EIGHT. That is the board's comfortable row count; a ninth item is what
// makes paging worth its own button. EXACTLY eight fits, so a list of eight
// shows eight and no MORE — a "more" that leads back to the same page is a lie
// about there being anything else.
//
// The words are the AAC vocabulary's own: `more` (the board's existing
// next/continue word) and `return` (🔙 — go back), never bespoke chrome art.

// TYPE-ONLY (erased at build): the option shape belongs to the host's public
// board view; this module is a leaf that shapes it, never a runtime dependant.
import type { QuestBoardOption } from "./quest-host.js";

/** Content buttons a single page shows. A ninth item is what earns paging. */
export const BOARD_PAGE = 8;

/** Board ids the chrome owns. The host intercepts these before any board's
 *  own handler sees them — no producer ever handles paging itself. */
export const BOARD_MORE_ID = "board:more";
export const BOARD_BACK_ID = "board:back";

export const BOARD_MORE_GLYPH = "more";
export const BOARD_BACK_GLYPH = "return";

export interface BoardChromeInput {
  /** The board's own options, in its own order. */
  options: readonly QuestBoardOption[];
  /** Which page to show. Out-of-range wraps — pressing MORE past the end
   *  returns to the first page rather than dead-ending. */
  page?: number;
  /** Is there somewhere to go back to? Adds the BACK button. */
  back?: boolean;
  /** Translated captions/TTS for the two chrome words (the host passes
   *  `translateGlyph`'s output — this module knows no locales). */
  moreText?: string;
  backText?: string;
}

export interface BoardChrome {
  /** What the board shows: this page's options, then MORE, then BACK. */
  options: QuestBoardOption[];
  /** How many pages the list needs (1 when it fits). */
  pages: number;
  /** The page actually shown (input page wrapped into range). */
  page: number;
}

/**
 * One page of a board, with its chrome. Pure — same input, same buttons.
 *
 * The chrome sits AFTER the content so the options a player is looking for
 * never move when a list grows past one page: page one still opens with the
 * same first button it always did.
 */
export function boardChrome(input: BoardChromeInput): BoardChrome {
  const all = [...input.options];
  const pages = Math.max(1, Math.ceil(all.length / BOARD_PAGE));
  const page = pages <= 1 ? 0 : ((Math.floor(input.page ?? 0) % pages) + pages) % pages;
  const shown = pages <= 1 ? all : all.slice(page * BOARD_PAGE, page * BOARD_PAGE + BOARD_PAGE);
  const options = [...shown];
  if (pages > 1) {
    options.push({
      id: BOARD_MORE_ID,
      label: input.moreText || "more",
      glyph: BOARD_MORE_GLYPH,
      spokenText: input.moreText ?? "",
    });
  }
  if (input.back) {
    options.push({
      id: BOARD_BACK_ID,
      label: input.backText || "back",
      glyph: BOARD_BACK_GLYPH,
      spokenText: input.backText ?? "",
    });
  }
  return { options, pages, page };
}

/** A board's CONTENT signature — the page resets to the first whenever the
 *  list itself changes, so a player is never left paging an old list. */
export function boardContentKey(options: readonly QuestBoardOption[]): string {
  return options.map((o) => o.id).join("|");
}
