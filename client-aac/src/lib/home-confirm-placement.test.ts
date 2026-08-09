/**
 * Dwell safety for the smart-home confirm step.
 *
 * The press that raises the confirm is itself a dwell selection, so the gaze
 * is resting on the pressed cell when the Yes/No row appears. The one rule
 * this module owns: the band the row is allowed to draw in NEVER overlaps that
 * cell. Everything else about the confirm (fresh dwell, post-selection re-arm)
 * is the shared SelectionGate's job — see shared/selection-gate.ts and
 * server/tests/dwell-engine.test.ts.
 */

import { describe, it, expect } from "@jest/globals";
import { confirmPlacementFor, type ConfirmPlacementGrid } from "./home-confirm-placement";

/** A 3x4 board 600px tall with the renderer's real 8px gutter. */
const GRID: ConfirmPlacementGrid = { heightPx: 600, rows: 3, cols: 4, gapPx: 8 };

/** Top/bottom edges of a row's cells, in the same coordinates as the band. */
function cellSpan(row: number, grid: ConfirmPlacementGrid) {
  const cellH = (grid.heightPx - (grid.rows - 1) * grid.gapPx) / grid.rows;
  const top = row * (cellH + grid.gapPx);
  return { top, bottom: top + cellH };
}

describe("confirmPlacementFor", () => {
  it("puts the row BELOW a press in the top rows", () => {
    // index 1 = row 0. Everything under that row is clear.
    expect(confirmPlacementFor(1, GRID).place).toBe("bottom");
  });

  it("puts the row ABOVE a press in the bottom rows", () => {
    // index 9 = row 2 of 3 — the room is all above.
    expect(confirmPlacementFor(9, GRID).place).toBe("top");
  });

  it("never lets the band cover the pressed cell — any cell, any grid", () => {
    for (const grid of [GRID, { heightPx: 900, rows: 5, cols: 5, gapPx: 8 }, { heightPx: 400, rows: 2, cols: 2, gapPx: 8 }]) {
      for (let index = 0; index < grid.rows * grid.cols; index++) {
        const { place, bandPx } = confirmPlacementFor(index, grid);
        expect(bandPx).not.toBeNull();
        const { top, bottom } = cellSpan(Math.floor(index / grid.cols), grid);
        // The band runs from an edge of the grid inwards by bandPx.
        const bandStart = place === "top" ? 0 : grid.heightPx - bandPx!;
        const bandEnd = place === "top" ? bandPx! : grid.heightPx;
        const overlap = Math.min(bandEnd, bottom) - Math.max(bandStart, top);
        // Sub-pixel slack: the band is derived from the same float division
        // that lays the cell out, so the two edges meet to within rounding.
        expect(overlap).toBeLessThan(1e-6);
      }
    }
  });

  it("reports the real clearance, not the whole half", () => {
    const { bandPx } = confirmPlacementFor(0, GRID);
    const { bottom } = cellSpan(0, GRID);
    expect(bandPx).toBeCloseTo(GRID.heightPx - bottom, 5);
  });

  it("breaks a tie downwards so the same press always answers in the same place", () => {
    // Row 1 of 3 is equidistant from both edges.
    const a = confirmPlacementFor(4, GRID);
    const b = confirmPlacementFor(7, GRID);
    expect(a.place).toBe("bottom");
    expect(b.place).toBe("bottom");
    expect(a.bandPx).toBeCloseTo(b.bandPx!, 5);
  });

  it("declines to place anything it cannot measure", () => {
    // No cell (a press from outside the grid), an unlaid-out grid, and an
    // index past the end all fall back to "centre it" rather than guess.
    expect(confirmPlacementFor(undefined, GRID).bandPx).toBeNull();
    expect(confirmPlacementFor(-1, GRID).bandPx).toBeNull();
    expect(confirmPlacementFor(0, { ...GRID, heightPx: 0 }).bandPx).toBeNull();
    expect(confirmPlacementFor(99, GRID).bandPx).toBeNull();
  });
});
