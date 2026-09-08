// client-aac/src/lib/board-paging.ts
//
// HOW MANY BUTTONS MAY BE ON SCREEN AT ONCE, and where the paging controls go.
//
// The board renderer sizes every button to fill the area it is given, so the
// GRID SHAPE IS THE BUTTON SIZE. A grid built to hold everything therefore
// shrinks its buttons without limit: twenty-five pizza places nearby came out
// as a 4 × 7 wall of tiles too small to read, let alone aim an eye tracker at.
// A screen has a floor on how small a button may usefully be, and past that
// floor the answer is another PAGE, never another row.
//
// So: three rows, four columns, twelve cells — and anything past that is
// reached with a Previous/Next pair rather than by making the buttons smaller
// (user, 2026-09-07). The same shape the server already builds menu boards in
// (`menu-board-builder.ts`, 4 cols × 2 item rows + an essentials row), which is
// why the two halves of the restaurant app now look like one app.
//
// ── THE RULES THE ARITHMETIC ENCODES ────────────────────────────────────────
//
//  1. A PAGING CONTROL COSTS A CELL. It is a button among the buttons, the same
//     size and reachable by the same selection method — not a strip of chrome
//     under the grid that a dwell user cannot hit. So a page that overflows
//     shows one FEWER item, exactly as the sidebar pager does
//     (client-shared/src/builder/sidebar-layout.ts).
//
//  2. BACK LEADS THE LIST (user, 2026-08-27). Whatever leaves this list — the
//     lane's own "back to the food grid", say — is pinned to cell 0 of EVERY
//     page, and Previous follows it. "What came before" must not sit after
//     everything that comes after, and a control that moves between pages is a
//     control the student has to hunt for.
//
//  3. NEXT FOLLOWS THE CONTENT. On a full page that IS the last cell; on a
//     short one it sits immediately after the last item rather than leaving a
//     hole for the eye to cross.
//
//  4. A SINGLE PAGE KEEPS ITS SQUARE-ISH SHAPE. Three places should be three
//     BIG buttons, not three small ones in a row of four. Only once the content
//     overflows does the grid open out to the full 3 × 4.
//
// Pure arithmetic, no React and no DOM: the lane owns what the buttons say and
// what pressing one does, this file owns only where they land.

/** The most buttons that may share the screen, per the rule above. */
export const MAX_PAGE_ROWS = 3;
export const MAX_PAGE_COLS = 4;

export interface GridShape {
  rows: number;
  cols: number;
}

/**
 * Lay `count` cells out in as square a grid as fits, never exceeding the cap.
 *
 * Capped at 4 columns because past that the buttons get narrow enough that a
 * gaze cannot separate them, and at 3 rows because past that they get short
 * enough that the word under the picture stops being readable.
 */
export function gridFor(
  count: number,
  maxRows: number = MAX_PAGE_ROWS,
  maxCols: number = MAX_PAGE_COLS,
): GridShape {
  if (count <= 0) return { rows: 1, cols: 1 };
  const capped = Math.min(count, maxRows * maxCols);
  const cols = Math.min(maxCols, Math.ceil(Math.sqrt(capped)));
  const rows = Math.min(maxRows, Math.ceil(capped / cols));
  return { rows, cols };
}

export interface PageLayoutInput {
  /** How many content items there are in total, across every page. */
  itemCount: number;
  /** Which page is showing. Out-of-range values are clamped, never thrown. */
  page: number;
  /**
   * Buttons pinned to the front of EVERY page — the lane's own way out of this
   * list. They are not content and are never paged.
   */
  leading?: number;
  maxRows?: number;
  maxCols?: number;
}

export interface PageLayout extends GridShape {
  /** The clamped page index. */
  page: number;
  pageCount: number;
  /** Half-open range of `items` on this page. */
  start: number;
  end: number;
  /** Cell index the content starts at (after the leading and Previous cells). */
  firstItemCell: number;
  /** Cell index of the Previous control, or -1 when this page has none. */
  prevCell: number;
  /** Cell index of the Next control, or -1 when this page has none. */
  nextCell: number;
  /** Total cells this page actually uses — content plus every control. */
  usedCells: number;
}

/**
 * Where everything on one page goes.
 *
 * Page capacity is not a constant, because the controls that make paging
 * possible are themselves cells: page 0 has no Previous, the last page has no
 * Next. The boundaries are therefore walked rather than divided — the same
 * do/while the server's menu paginator uses, for the same reason.
 */
export function pageLayout({
  itemCount,
  page,
  leading = 0,
  maxRows = MAX_PAGE_ROWS,
  maxCols = MAX_PAGE_COLS,
}: PageLayoutInput): PageLayout {
  const cells = maxRows * maxCols;
  const total = Math.max(0, itemCount);

  // Walk the page boundaries. Each entry is the half-open range of items on
  // that page; the control layout follows from the page's index.
  const slices: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  let pageNo = 0;
  do {
    const fixed = leading + (pageNo > 0 ? 1 : 0);
    const room = cells - fixed;
    const remaining = total - cursor;
    // No room for content at all — a caller pinning more leading buttons than
    // the grid holds. Stop rather than loop forever on a zero-length slice.
    if (room <= 0) break;
    const needsNext = remaining > room;
    const take = needsNext ? room - 1 : remaining;
    if (take <= 0) break;
    slices.push({ start: cursor, end: cursor + take });
    cursor += take;
    pageNo++;
    if (!needsNext) break;
  } while (cursor < total);

  if (!slices.length) slices.push({ start: 0, end: 0 });

  const pageCount = slices.length;
  const current = Math.min(Math.max(0, Math.floor(page) || 0), pageCount - 1);
  const slice = slices[current];

  const hasPrev = current > 0;
  const hasNext = current < pageCount - 1;
  const firstItemCell = leading + (hasPrev ? 1 : 0);
  const shown = slice.end - slice.start;
  const usedCells = firstItemCell + shown + (hasNext ? 1 : 0);

  // A single page keeps its square-ish shape; a paged one opens out to the full
  // grid so the buttons do not change size underneath the student at a turn.
  const shape = pageCount > 1 ? { rows: maxRows, cols: maxCols } : gridFor(usedCells, maxRows, maxCols);

  return {
    ...shape,
    page: current,
    pageCount,
    start: slice.start,
    end: slice.end,
    firstItemCell,
    prevCell: hasPrev ? leading : -1,
    nextCell: hasNext ? firstItemCell + shown : -1,
    usedCells,
  };
}

/** Cell index → grid position, for the caller's `row`/`col` fields. */
export function cellPosition(index: number, cols: number): { row: number; col: number } {
  return { row: Math.floor(index / cols), col: index % cols };
}
