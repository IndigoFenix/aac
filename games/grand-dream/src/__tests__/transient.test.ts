/**
 * Interpolated transients (timescales.md §5b) — the substrate presenter.
 *
 * The live river field JUMPS when terrain changes (it is a derived solve);
 * the presenter's shown field must (a) carve new channels headwaters →
 * mouth, (b) dwindle abandoned beds in place, (c) survive the substrate
 * changing again MID-TRANSIENT (ease-toward retargets for free), and
 * (d) converge exactly onto the live field and rest there. The sim never
 * reads the shown field — these tests only ever assert on presentation.
 */
import { describe, it, expect } from "vitest";
import { createGrid, worldStep, pendingCount, injectTile, worldgenSubstrate, type CellGrid } from "@cells/index";
import { createSubstratePresenter } from "../substrate-render";

const COLS = 48, ROWS = 32;

function ridgeValley(x: number, y: number): number {
  return x < 8 ? 50 : Math.min(63, Math.max(3, 26 - (x - 8)) + Math.abs(y - 16));
}

function settledGrid(): CellGrid {
  const g = createGrid(worldgenSubstrate, COLS, ROWS);
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) g.fields.height[y * COLS + x] = ridgeValley(x, y);
  g.flowDirty = true;
  for (let i = 0; i < 20000 && pendingCount(g) > 0; i++) worldStep(g);
  return g;
}

/** Dig a new descending channel along row `y` so drainage concentrates
 *  into a river that did not exist before. Gentle CONTINUOUS descent —
 *  a channel that bottoms out into a flat with no outlet is a sink and
 *  stops accumulating (correct engine behaviour, wrong test terrain). */
function digChannel(g: CellGrid, y: number): void {
  for (let x = 8; x < COLS; x++) {
    const c = y * COLS + x;
    const want = Math.max(3, Math.round(18 - (x - 8) * 0.35));
    injectTile(g, c, "height", want - g.fields.height[c]);
  }
  for (let i = 0; i < 20000 && pendingCount(g) > 0; i++) worldStep(g);
}

const fakeImg = (): ImageData =>
  ({ data: new Uint8ClampedArray(COLS * ROWS * 4), width: COLS, height: ROWS } as unknown as ImageData);

describe("substrate presenter — interpolated transients", () => {
  it("a new channel CARVES headwaters → mouth, then rests exactly on the live field", () => {
    const g = settledGrid();
    const p = createSubstratePresenter(g);
    const img = fakeImg();
    p.paint(img, 0); // prime the clock on the settled state

    digChannel(g, 2); // the canyon captures the north slope's drainage
    const live = g.fields.river;

    // The ridge-valley slopes already run parallel streams, so pick the
    // NEWLY WET reach data-driven: channel cells whose shown state starts
    // below the paint threshold but whose live target is a real river.
    // head = most upstream such cell, mouth = most downstream.
    let head = -1;
    let mouth = -1;
    for (let x = 9; x < COLS; x++) {
      const c = 2 * COLS + x;
      if (p.river(c) <= 10 && live[c] > 20) {
        if (head < 0) head = c;
        mouth = c;
      }
    }
    expect(head).toBeGreaterThan(-1);
    expect(mouth).toBeGreaterThan(head + 5); // a reach worth watching
    expect(live[mouth]).toBeGreaterThan(live[head]); // accumulation grows downstream

    // Record when each cell crosses HALF its target (front progress) and
    // when it crosses the PAINT threshold (river > 10 — what the player
    // sees). The paint ordering is the one that regressed: a target-
    // proportional trickle let the mouth (huge accumulation) self-reveal
    // in under a second, so rivers appeared far downstream and "extended
    // uphill".
    let ts = 0;
    let headAt = -1;
    let mouthAt = -1;
    let headVisAt = -1;
    let mouthVisAt = -1;
    for (let step = 0; step < 1200 && (headAt < 0 || mouthAt < 0 || headVisAt < 0 || mouthVisAt < 0); step++) {
      ts += 0.05;
      p.paint(img, ts);
      if (headAt < 0 && p.river(head) >= live[head] / 2) headAt = ts;
      if (mouthAt < 0 && p.river(mouth) >= live[mouth] / 2) mouthAt = ts;
      if (headVisAt < 0 && p.river(head) > 10) headVisAt = ts;
      if (mouthVisAt < 0 && p.river(mouth) > 10) mouthVisAt = ts;
    }
    expect(headAt).toBeGreaterThan(0); // the head DID wet up
    expect(mouthAt).toBeGreaterThan(0); // ...and the mouth after it
    expect(headAt).toBeLessThan(mouthAt); // the front swept downstream
    expect(headVisAt).toBeGreaterThan(0);
    expect(mouthVisAt).toBeGreaterThan(0);
    expect(headVisAt).toBeLessThan(mouthVisAt); // ...and VISIBLY so

    // Long tail: shown must land EXACTLY on live (snap) and rest.
    for (let step = 0; step < 400; step++) {
      ts += 0.25;
      p.paint(img, ts);
    }
    const settled = fakeImg();
    p.paint(settled, ts + 0.01);
    const reference = fakeImg();
    // A fresh presenter on the same grid starts AT the live field — the
    // converged transient must paint the identical image.
    createSubstratePresenter(g).paint(reference, 0);
    expect(Array.from(settled.data)).toEqual(Array.from(reference.data));
  });

  it("vegetation eases in and out instead of snapping with the sim's time-lapse cadence", () => {
    const g = settledGrid();
    const p = createSubstratePresenter(g);
    const img = fakeImg();
    p.paint(img, 0);

    // Digging a channel makes the sim's plant field JUMP (the lab steps
    // the grid at frame rate — here the settle loop plays it all at once).
    // Pick a NEWLY GREENED bank data-driven: live plant real, shown still
    // under half of it (the slopes carry old streams with old halos, so
    // hand-picked coordinates lie).
    digChannel(g, 2);
    let bank = -1;
    for (let y = 1; y <= 4 && bank < 0; y++) {
      for (let x = 9; x < COLS; x++) {
        const c = y * COLS + x;
        if (g.fields.plant[c] >= 2 && p.plant(c) < g.fields.plant[c] / 2) { bank = c; break; }
      }
    }
    expect(bank).toBeGreaterThan(-1);

    let ts = 0;
    let half = -1;
    for (let step = 0; step < 400; step++) {
      ts += 0.05;
      p.paint(img, ts);
      if (half < 0 && p.plant(bank) >= g.fields.plant[bank] / 2) half = ts;
    }
    expect(half).toBeGreaterThan(0.5); // took visible time, did not snap
    expect(p.plant(bank)).toBe(g.fields.plant[bank]); // ...and landed exactly
  });

  it("an abandoned bed dwindles; retargeting mid-transient converges cleanly", () => {
    const g = settledGrid();
    const p = createSubstratePresenter(g);
    const img = fakeImg();
    p.paint(img, 0);

    // Dam the valley: downstream of x=19 the old channel dries.
    for (let y = 0; y < ROWS; y++) {
      for (let x = 17; x <= 19; x++) {
        const c = y * COLS + x;
        injectTile(g, c, "height", 60 - g.fields.height[c]);
      }
    }
    for (let i = 0; i < 20000 && pendingCount(g) > 0; i++) worldStep(g);
    const bed = 16 * COLS + 30;
    expect(g.fields.river[bed]).toBeLessThanOrEqual(15); // authoritative: dry

    // Mid-dwindle, change the world AGAIN (dig a fresh channel elsewhere):
    // the presenter must keep easing without reset artifacts.
    let ts = 0;
    for (let step = 0; step < 20; step++) { ts += 0.05; p.paint(img, ts); }
    digChannel(g, 24);

    for (let step = 0; step < 400; step++) { ts += 0.25; p.paint(img, ts); }
    const settled = fakeImg();
    p.paint(settled, ts + 0.01);
    const reference = fakeImg();
    createSubstratePresenter(g).paint(reference, 0);
    expect(Array.from(settled.data)).toEqual(Array.from(reference.data)); // converged onto the new truth
  });
});
