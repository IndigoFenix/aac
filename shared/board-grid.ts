// shared/board-grid.ts
//
// Where a board's buttons are allowed to sit.
//
// THE GRID IS PER PAGE. Each page carries its own `layout`; the board's `grid`
// is only the DEFAULT for a page that hasn't declared one. A quick 2x3 yes/no
// page and a 5x6 vocabulary page belong in the same board, and forcing both
// onto one grid is what makes boards come out mostly-empty. Every renderer and
// every validator must go through `pageGrid` rather than reading `board.grid`
// directly, or the two disagree about which cells exist and buttons vanish.

export interface GridSize {
  rows: number;
  cols: number;
}

/** The board-level default, used by any page with no `layout` of its own. */
export const DEFAULT_PAGE_GRID: GridSize = { rows: 3, cols: 3 };

interface GridLike {
  rows?: unknown;
  cols?: unknown;
}

function readGrid(grid: GridLike | null | undefined): GridSize | null {
  if (!grid) return null;
  const rows = Number(grid.rows);
  const cols = Number(grid.cols);
  if (!Number.isFinite(rows) || !Number.isFinite(cols)) return null;
  if (rows < 1 || cols < 1) return null;
  return { rows: Math.floor(rows), cols: Math.floor(cols) };
}

/**
 * The grid a page is drawn on: its own `layout`, or the board's `grid`.
 * This is THE definition — the AAC's DynamicBoard, the clinician canvas, the
 * store's validator and the AI's edit guard all resolve it here.
 */
export function pageGrid(
  board: { grid?: GridLike | null } | null | undefined,
  page: { layout?: GridLike | null } | null | undefined,
  /** Last resort when neither is usable. Renderers differ here (the AAC board
   *  opens 3x4, the call mirror 1x1), and that is theirs to decide — the
   *  ORDER of preference is what has to be shared. */
  fallback: GridSize = DEFAULT_PAGE_GRID,
): GridSize {
  return readGrid(page?.layout) ?? readGrid(board?.grid) ?? fallback;
}

/**
 * The smallest grid that holds `buttons` — what a page's layout SHOULD be
 * once it is done being edited. Spans count: a 2-wide button at col 3 needs
 * five columns, not four. An empty page keeps the fallback rather than
 * collapsing to 0x0, which no renderer can draw.
 */
export function fitGrid(
  buttons: Array<{ row?: unknown; col?: unknown; rowSpan?: unknown; colSpan?: unknown }>,
  fallback: GridSize = DEFAULT_PAGE_GRID,
): GridSize {
  let rows = 0;
  let cols = 0;
  for (const button of buttons ?? []) {
    const row = Number(button?.row);
    const col = Number(button?.col);
    const rowSpan = Number(button?.rowSpan);
    const colSpan = Number(button?.colSpan);
    if (Number.isFinite(row)) {
      rows = Math.max(rows, row + (Number.isFinite(rowSpan) && rowSpan > 0 ? rowSpan : 1));
    }
    if (Number.isFinite(col)) {
      cols = Math.max(cols, col + (Number.isFinite(colSpan) && colSpan > 0 ? colSpan : 1));
    }
  }
  if (rows < 1 || cols < 1) return fallback;
  return { rows, cols };
}

/** A button its own page's grid has no cell for. */
export interface OutOfBoundsButton {
  pageId: string;
  pageName: string;
  buttonId: string;
  label: string;
  row: number;
  col: number;
  /** The page grid the button had to fit inside. */
  rows: number;
  cols: number;
}

/**
 * Stable identity for one violation, so a caller can tell a violation an edit
 * just INTRODUCED from one the board already carried.
 */
export function outOfBoundsKey(v: OutOfBoundsButton): string {
  return `${v.pageId} ${v.buttonId}`;
}

/**
 * Every button that would be cut off — i.e. sits outside its own page's grid.
 * Spans are included: a button whose last column falls off the edge is only
 * half-drawn, which is no better than being gone.
 */
export function findOutOfBoundsButtons(board: any): OutOfBoundsButton[] {
  if (!board || !Array.isArray(board.pages)) return [];

  const out: OutOfBoundsButton[] = [];

  for (const page of board.pages) {
    if (!page || !Array.isArray(page.buttons)) continue;
    const { rows, cols } = pageGrid(board, page);

    for (const button of page.buttons) {
      if (!button) continue;
      const row = Number(button.row);
      const col = Number(button.col);
      const rowSpan = Number(button.rowSpan);
      const colSpan = Number(button.colSpan);
      const rowEnd = row + (Number.isFinite(rowSpan) && rowSpan > 0 ? rowSpan : 1);
      const colEnd = col + (Number.isFinite(colSpan) && colSpan > 0 ? colSpan : 1);
      // A row/col we cannot read bounds nothing — never invent a violation
      // from a missing number, or a board mid-edit is rejected for being partial.
      const rowBad = Number.isFinite(row) && (row < 0 || rowEnd > rows);
      const colBad = Number.isFinite(col) && (col < 0 || colEnd > cols);
      if (!rowBad && !colBad) continue;
      out.push({
        pageId: String(page.id ?? ""),
        pageName: String(page.name ?? page.id ?? ""),
        buttonId: String(button.id ?? ""),
        label: String(button.label ?? ""),
        row,
        col,
        rows,
        cols,
      });
    }
  }

  return out;
}
