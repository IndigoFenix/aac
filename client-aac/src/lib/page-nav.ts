/**
 * page-nav.ts
 *
 * Navigation BETWEEN THE PAGES OF ONE BOARD — the link buttons on a
 * clinician-authored multi-page board, plus the Back and Home that undo them.
 * Pure, so the rules are testable without a DOM.
 *
 * NOT to be confused with `board-history.ts`, which is the browser-style
 * back/forward across whole AI-generated BOARDS. Two different stacks:
 *   board-history — "show me the board I had a minute ago"   (across boards)
 *   page-nav      — "go back out of the folder I opened"     (within a board)
 * A board arriving from the AI resets this one; that is the only coupling.
 *
 * The AI can drive this too (`ai_button_press`), which is why the reducer takes
 * the same actions from either source and reports back which page it landed on
 * — the caller has to tell the server where the student now is, whoever moved
 * them.
 */

import type { ParsedBoardData } from "@shared/schema";

type BoardPage = NonNullable<ParsedBoardData["pages"]>[number];

export interface PageNav {
  /** Which page is showing. Null before any board has arrived. */
  currentPageId: string | null;
  /** Pages walked THROUGH to get here, oldest first. Back pops it. */
  history: string[];
}

export type PageNavAction =
  | { type: "to"; pageId: string }
  | { type: "back" }
  | { type: "home" };

/** A board arrived (or its identity changed): open its first page, forget the
 *  trail. An unanswered confirm belongs to the board it was raised from, so
 *  callers drop that here too. */
export function initPageNav(board: ParsedBoardData | null | undefined): PageNav {
  return { currentPageId: board?.pages?.[0]?.id ?? null, history: [] };
}

export function emptyPageNav(): PageNav {
  return { currentPageId: null, history: [] };
}

/** The page to draw: the current one, else the board's first. Null only when
 *  the board has no pages at all. */
export function resolvePage(
  board: ParsedBoardData | null | undefined,
  nav: PageNav,
): BoardPage | null {
  const pages = board?.pages;
  if (!pages?.length) return null;
  if (nav.currentPageId) {
    const found = pages.find((p) => p.id === nav.currentPageId);
    if (found) return found;
  }
  return pages[0];
}

/** Whether the in-board Back arrow has anywhere to go. */
export function canGoBackPage(nav: PageNav): boolean {
  return nav.history.length > 0;
}

export interface PageNavResult {
  nav: PageNav;
  /**
   * The page navigated ONTO, or null when the action was a no-op (an unknown
   * target, Back with an empty trail, Home on a board with no pages). Non-null
   * is exactly the condition for telling the server the student moved.
   */
  landed: BoardPage | null;
  /** i18n key to name the page when it has no name of its own. Differs by
   *  action, which is why it travels with the result instead of being guessed. */
  fallbackLabelKey: string;
}

/**
 * Apply one navigation. Never throws and never lands somewhere that does not
 * exist — an unknown page id leaves the student exactly where they were, which
 * matters because the AI can drive this and does occasionally name a page that
 * a newer board no longer has.
 */
export function pageNavReducer(
  nav: PageNav,
  board: ParsedBoardData | null | undefined,
  action: PageNavAction,
): PageNavResult {
  const pages = board?.pages;

  if (action.type === "to") {
    const target = pages?.find((p) => p.id === action.pageId);
    if (!target) return { nav, landed: null, fallbackLabelKey: "builder.untitledPage" };
    return {
      // A null current page contributes nothing to the trail — there is no
      // page to come back to.
      nav: {
        currentPageId: action.pageId,
        history: nav.currentPageId ? [...nav.history, nav.currentPageId] : nav.history,
      },
      landed: target,
      fallbackLabelKey: "builder.untitledPage",
    };
  }

  if (action.type === "back") {
    if (nav.history.length === 0) {
      return { nav, landed: null, fallbackLabelKey: "builder.untitledPage" };
    }
    const prevPageId = nav.history[nav.history.length - 1];
    // The cursor moves even if the page has since vanished from the board —
    // the trail is the student's own path, and stranding them on a page they
    // navigated away from would be worse than landing on the board's first.
    const next: PageNav = { currentPageId: prevPageId, history: nav.history.slice(0, -1) };
    return {
      nav: next,
      landed: pages?.find((p) => p.id === prevPageId) ?? null,
      fallbackLabelKey: "builder.untitledPage",
    };
  }

  const first = pages?.[0];
  if (!first) return { nav, landed: null, fallbackLabelKey: "quickActions.home" };
  return {
    nav: { currentPageId: first.id, history: [] },
    landed: first,
    fallbackLabelKey: "quickActions.home",
  };
}
