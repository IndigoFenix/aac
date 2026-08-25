/**
 * shared/aac-builder-paging.ts
 *
 * HOW THE AAC SENTENCE BUILDER'S MAIN GRID PAGES — the one rule, for both of the
 * builder's word sources (the engine surfacer and the glyph-registry fallback).
 * It used to be written twice inside `SentenceConstructorBoard`, once per source,
 * with the same algorithm copied out.
 *
 * In `shared/` rather than `client-aac/` because three callers need it and they
 * do not share a tree: the AAC component, and — through `createTextBuilder`'s
 * injectable pager — any headless driver that has to page the way the CHILD's
 * board pages rather than the way text mode's own board does. Deliberately NOT
 * in `shared/world-engine/`: games vendor a snapshot of that tree, and this is
 * platform chrome, not engine behaviour. The engine never imports it; callers
 * inject it.
 *
 * THE GRID IS A BUDGET, NOT A MENU. 18 cells, and a word that does not fit into
 * them is reachable only by paging, by a tab, or by a group chip. That extra
 * press is a real cost to a child driving this with their eyes, which is why the
 * page size is a fact this module owns rather than a number each call site picks:
 * measuring "how many presses did that word take" is only meaningful if every
 * surface pages the same way.
 *
 * PAGING WRAPS, deliberately. The controls cycle: past the last page More
 * returns to the start, and Back from the first page lands on the last, rather
 * than stopping or greying out. A student who keeps pressing keeps getting
 * words, and never lands on a dead control they have to recognise as dead — but
 * it also means there is no "last page", so a caller counting screens must count
 * presses, not pages.
 *
 * BOTH DIRECTIONS (user, 2026-08-25). The grid used to page FORWARD only, so a
 * word the student scrolled past cost a full lap of the list to see again — on a
 * 54-word budget that is two more presses, each of them a dwell. Two cells go to
 * the controls whenever the list overflows.
 *
 * ⚠️ This is NOT how the world-engine's TEXT-MODE builder pages
 * (`shared/world-engine/interaction/text/builder.ts` slices cleanly and refuses
 * to page past the end). The two are different boards on purpose — but anything
 * measuring reachability AS THE CHILD EXPERIENCES IT has to page the way this
 * module does, or it is measuring the text harness's board instead.
 */

/** Cells in the main grid: a fixed 9×2. Each cell is wider than it is tall — the
 *  square image dominates the button's identity and the label below it is a
 *  one-line hint, so the cell can afford to be narrow. */
export const BUILDER_GRID_CELLS = 18;

/** Cells the PAGING CONTROLS take when the list overflows: Back and More. */
export const BUILDER_PAGE_CONTROLS = 2;

/** Words a page can hold once the controls have their cells. */
export const BUILDER_ITEMS_WITH_MORE = BUILDER_GRID_CELLS - BUILDER_PAGE_CONTROLS;

export interface BuilderGridPage<T> {
  /** The items to draw in this page's cells. */
  items: T[];
  /** Whether the paging controls take their cells (the list overflows the grid). */
  needsMore: boolean;
  /** Cells available to WORDS on this page — `BUILDER_PAGE_CONTROLS` fewer when
   *  the controls are shown. */
  perPage: number;
}

/**
 * One page of the main grid.
 *
 * Under the cap, everything shows and there is no More button. Over it, the
 * page starts at `page * perPage` MODULO the list length and wraps around the
 * end, so every page is full — a student never sees a ragged final page with
 * three words on it, and More always has something behind it.
 */
export function pageBuilderGrid<T>(
  items: T[],
  page: number,
  cells: number = BUILDER_GRID_CELLS,
): BuilderGridPage<T> {
  const needsMore = items.length > cells;
  const perPage = needsMore ? cells - BUILDER_PAGE_CONTROLS : cells;
  if (items.length === 0) return { items: [], needsMore: false, perPage };
  if (!needsMore) return { items: items.slice(0, cells), needsMore, perPage };

  // `page` may go NEGATIVE: Back decrements it, and JS `%` keeps the sign, so
  // normalise before slicing or the first Back press would read past the start.
  const start = (((page * perPage) % items.length) + items.length) % items.length;
  const wrapped = [...items.slice(start), ...items.slice(0, start)];
  return { items: wrapped.slice(0, perPage), needsMore, perPage };
}
