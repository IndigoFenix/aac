// THE DESTINY CONVENTIONS (states round S0 — states-round.md §4/§10/§14):
// the coordinate-keyed draw (one definition, bit-pinned against the court's
// old inline literal), the fading-memory flux law (user ruling §14-②:
// "a locale's creation/destruction flux IS the noise floor"), the exact-zero
// decay date (law 3 — quantized, never asymptotic), the channel membrane
// skeleton, and the elapsed-days band arm (the engine's one per-call decay,
// given its timestamped API).
// Slice: `npm run test:engine -- destiny`

import { describe, it, expect } from "@jest/globals";
import {
  hash01, memoryLifespan, stampMemory, memoryAlive, filterMemories,
  registerCoarseChannel, coarseChannels, isCoarseChannel,
  MEMORY_TURNOVER_DEFAULT, type DestinyMemory,
} from "@shared/world-engine/kernel/destiny.js";
import {
  stepBandDay, stepBandDays, type Band,
} from "@shared/world-engine/kernel/civ/bands.js";
import { REAL_SCALE } from "@shared/world-engine/scale.js";
import { createGrid, type SystemSpec } from "@shared/world-engine/kernel/cells/index.js";
import type { Freight } from "@shared/world-engine/freight.js";

// ── The draw ────────────────────────────────────────────────────────────────

/** The court's ORIGINAL inline literal (planet/history.ts before S0 moved
 *  it) — kept here as the bit-identity reference so the extraction can
 *  never drift the draw. */
function referenceHash01(seed: number, a: number, b: number, c: number, salt: number): number {
  let h = (seed ^ (a * 0x9e3779b9) ^ (b * 0x85ebca6b) ^ (c * 0xc2b2ae35) ^ (salt * 0x27d4eb2f)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 0x1_0000_0000;
}

describe("the draw — coordinate-keyed, order-free, bit-stable", () => {
  it("is bit-identical to the court's original literal across a sweep", () => {
    for (let seed = 0; seed < 5; seed++) {
      for (let a = 0; a < 20; a++) {
        expect(hash01(seed * 7919, a, a * 3 + 1, a * a, a % 5)).toBe(
          referenceHash01(seed * 7919, a, a * 3 + 1, a * a, a % 5),
        );
      }
    }
    // Negative and large coordinates too (years, cell keys).
    expect(hash01(1, -3, 1e9, 0, 101)).toBe(referenceHash01(1, -3, 1e9, 0, 101));
  });

  it("stays in [0, 1) and carries no sequential state", () => {
    const first = hash01(42, 7, 8, 9, 13);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
    // Interleave unrelated draws, then re-ask: identical — evaluation
    // order can never matter (a warp and a watch draw the same values).
    hash01(1, 2, 3, 4, 5);
    hash01(99, 98, 97, 96, 95);
    expect(hash01(42, 7, 8, 9, 13)).toBe(first);
  });

  it("distinct tuples draw distinct values (no accidental key folding)", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(hash01(5, i, 0, 0, 1));
    expect(seen.size).toBe(200);
  });
});

// ── The flux law ────────────────────────────────────────────────────────────

describe("the flux law — a locale's churn IS the noise floor (§14-②)", () => {
  it("zero or non-finite flux ⇒ permanent (the wilderness artifact)", () => {
    expect(memoryLifespan(5, 0)).toBe(Infinity);
    expect(memoryLifespan(5, -1)).toBe(Infinity);
    expect(memoryLifespan(5, Number.NaN)).toBe(Infinity);
    expect(memoryLifespan(5, Infinity)).toBe(0); // an infinite churn absorbs instantly
    const mark = stampMemory("relic", 1, 1000, 0);
    expect(mark.expiresAt).toBe(Infinity);
    expect(memoryAlive(mark, 1e12)).toBe(true);
  });

  it("a nothing was never a mark", () => {
    expect(memoryLifespan(0, 3)).toBe(0);
    const mark = stampMemory("dust", 0, 50, 3);
    expect(memoryAlive(mark, 50)).toBe(false);
  });

  it("retention = magnitude over flux, scaled by the turnover dial", () => {
    expect(memoryLifespan(10, 2)).toBe((10 / 2) * MEMORY_TURNOVER_DEFAULT);
    expect(memoryLifespan(10, 2, 1)).toBe(5);
    // Monotone in magnitude, anti-monotone in flux.
    expect(memoryLifespan(20, 2)).toBeGreaterThan(memoryLifespan(10, 2));
    expect(memoryLifespan(10, 4)).toBeLessThan(memoryLifespan(10, 2));
  });

  it("the user's calibration cases order themselves", () => {
    // Small consumables into a city WITH that industry: huge flux ⇒ gone
    // fast. Same delta where the kind is RARE: tiny flux ⇒ durable. Left
    // in wilderness: no flux ⇒ forever.
    const intoIndustry = memoryLifespan(3, 100);
    const whereRare = memoryLifespan(3, 0.01);
    const inWilderness = memoryLifespan(3, 0);
    expect(intoIndustry).toBeLessThan(whereRare);
    expect(whereRare).toBeLessThan(inWilderness);
    expect(inWilderness).toBe(Infinity);
  });
});

// ── Law 3: exact zero at the stamped date; warp = filter ────────────────────

describe("decay by timestamp — exactly zero at the date, never asymptotic", () => {
  it("alive strictly before expiresAt, dead AT it", () => {
    const mark = stampMemory("toast", 4, 100, 1, 1); // expires at 104
    expect(mark.expiresAt).toBe(104);
    expect(memoryAlive(mark, 103.999)).toBe(true);
    expect(memoryAlive(mark, 104)).toBe(false);
    expect(memoryAlive(mark, 105)).toBe(false);
  });

  it("a century-warp over memories is a filter by date", () => {
    const marks: DestinyMemory[] = [
      stampMemory("gossip", 1, 0, 1, 1),   // dies at 1
      stampMemory("barn", 10, 0, 1, 1),    // dies at 10
      stampMemory("grave", 10, 0, 0.01, 1), // dies at 1000
      stampMemory("relic", 1, 0, 0),       // never
    ];
    // Watched at every instant or warped straight to t=100: the same
    // survivors on the same day — nothing integrates, nothing drifts.
    const at100 = filterMemories(marks, 100);
    expect(at100.map(m => m.kind)).toEqual(["grave", "relic"]);
    expect(filterMemories(marks, 1000).map(m => m.kind)).toEqual(["relic"]);
    // Filtering is per-item aliveness, nothing else.
    for (const m of marks) expect(at100.includes(m)).toBe(memoryAlive(m, 100));
  });
});

// ── The membrane skeleton ───────────────────────────────────────────────────

describe("the channel registry — an enumerable membrane (law 2)", () => {
  it("registers, enumerates sorted, and refuses duplicate laws", () => {
    registerCoarseChannel({ id: "test:zeta", description: "z first to prove sorting" });
    registerCoarseChannel({ id: "test:alpha", description: "a registered second" });
    expect(isCoarseChannel("test:alpha")).toBe(true);
    expect(isCoarseChannel("test:never")).toBe(false);
    const ids = coarseChannels().map(c => c.id);
    // Deterministic regardless of registration order…
    expect(ids.indexOf("test:alpha")).toBeLessThan(ids.indexOf("test:zeta"));
    expect([...ids].sort()).toEqual(ids);
    // …and one name is one law, forever.
    expect(() => registerCoarseChannel({ id: "test:alpha", description: "impostor" }))
      .toThrow(/already registered/);
  });
});

// ── The elapsed band arm (the one per-call decay, timestamped) ──────────────

const COLS = 24;
const ROWS = 18;
const at = (x: number, y: number): number => y * COLS + x;
const spec: SystemSpec = {
  id: "destiny-band-test",
  name: "Destiny band test",
  vars: [{ name: "forage", min: 0, max: 31, initial: 0, init: "flat", int: true }],
  rules: [],
};
const GRAIN: Freight = { valueDensity: 1, transit: "selfConsuming" };
const mkBand = (cell: number, size: number, store = 0): Band =>
  ({ cell, mix: { human: size }, size, store, mode: "forager" });

describe("stepBandDays — elapsed days ≡ repeated day calls", () => {
  it("seven elapsed days match seven single steps, store bit-for-bit", () => {
    const grid = createGrid(spec, COLS, ROWS);
    for (let y = 5; y <= 7; y++) for (let x = 5; x <= 7; x++) grid.fields.forage[at(x, y)] = 3;
    const opts = { scale: REAL_SCALE, radius: 1, fields: ["forage"], freight: GRAIN };

    const ticked = mkBand(at(6, 6), 10, 12);
    let need = 0, yielded = 0, banked = 0, shortfall = 0;
    for (let d = 0; d < 7; d++) {
      const r = stepBandDay(grid, ticked, opts);
      need += r.need; yielded += r.yield; banked += r.banked; shortfall += r.shortfall;
    }

    const warped = mkBand(at(6, 6), 10, 12);
    const sum = stepBandDays(grid, warped, 7, opts);

    expect(warped.store).toBe(ticked.store); // same float ops, same order
    expect(sum.need).toBe(need);
    expect(sum.yield).toBe(yielded);
    expect(sum.banked).toBe(banked);
    expect(sum.shortfall).toBe(shortfall);
  });

  it("zero, negative, and fractional day counts floor to whole edges", () => {
    const grid = createGrid(spec, COLS, ROWS);
    const opts = { scale: REAL_SCALE, radius: 1, fields: ["forage"], freight: GRAIN };
    const band = mkBand(at(6, 6), 10, 100);
    const s0 = band.store;
    expect(stepBandDays(grid, band, 0, opts).need).toBe(0);
    expect(stepBandDays(grid, band, -3, opts).need).toBe(0);
    expect(band.store).toBe(s0); // nothing moved
    // 2.9 elapsed days is two day EDGES (the clock-warp doctrine).
    const twin = mkBand(at(6, 6), 10, 100);
    stepBandDay(grid, twin, opts);
    stepBandDay(grid, twin, opts);
    stepBandDays(grid, band, 2.9, opts);
    expect(band.store).toBe(twin.store);
  });
});
