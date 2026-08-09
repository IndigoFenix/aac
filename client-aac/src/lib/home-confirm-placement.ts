// client-aac/src/lib/home-confirm-placement.ts
//
// Where a board-level confirm step may draw its Yes/No row.
//
// An eye-gaze dwell fires on the button it is resting on and then keeps
// resting there. So a confirm raised BY that press must not put a target on
// the same spot: the student would be looking at "Yes" from the moment it
// appears. The shared SelectionGate already refuses to fire again until the
// point has travelled (shared/selection-gate.ts, rule 1) and a freshly-mounted
// button starts its timer at zero — this is the second line: the row is pinned
// to whichever edge of the grid has more clear board BEYOND the pressed cell,
// and told how much room that is so it can shrink to fit rather than spill
// back across the cell the gaze is parked on.
//
// Pure so the invariant "the band never covers the pressed cell" is testable
// without a DOM — see home-confirm-placement.test.ts.

export interface ConfirmPlacement {
  /** Which edge of the grid the confirm row is pinned to. */
  place: "top" | "bottom";
  /** Clear px between the pressed cell and that edge, or null when unmeasurable. */
  bandPx: number | null;
}

export interface ConfirmPlacementGrid {
  /** Measured height of the button grid in px. */
  heightPx: number;
  rows: number;
  cols: number;
  /** Gutter between cells, in px (the grid's `gap`). */
  gapPx: number;
}

/** Nothing to measure against — centre and lean on the SelectionGate alone. */
const UNPLACED: ConfirmPlacement = { place: "bottom", bandPx: null };

/**
 * @param index slot index of the pressed button (row-major), or undefined when
 *              the press didn't come from a grid cell.
 */
export function confirmPlacementFor(index: number | undefined, grid: ConfirmPlacementGrid): ConfirmPlacement {
  const { heightPx, rows, cols, gapPx } = grid;
  if (index === undefined || index < 0 || rows < 1 || cols < 1) return UNPLACED;
  if (!(heightPx > 0)) return UNPLACED;

  const row = Math.floor(index / cols);
  if (row >= rows) return UNPLACED;

  const cellH = (heightPx - (rows - 1) * gapPx) / rows;
  if (!(cellH > 0)) return UNPLACED;

  const top = row * (cellH + gapPx);
  const above = top;
  const below = heightPx - (top + cellH);

  // Ties go to the bottom: below the press is where a hand or a head is least
  // likely to be occluding the screen, and it keeps the choice deterministic.
  return below >= above ? { place: "bottom", bandPx: below } : { place: "top", bandPx: above };
}
