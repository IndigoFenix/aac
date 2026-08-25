// SPILL FOUNDING — Stage β3 of the food-scale round
// (planning-docs/games/world-engine/food-scale-round.md "# STAGE β",
// survey correction 8 + "The β stages" › β3).
//
// The user's law: "the region answers with more towns, never overstuffed
// ones". A first-pass founding site's potential crowd is the startPop
// formula min(2000, round(density × 5)); the village tier seats only
// TIER_POP_CAP.village (140) of it. The excess — the SPILL BUDGET — funds a
// SECOND founding pass over marginal land: threshold × SPILL_THRESHOLD_RELAX
// (0.5, the floor), SAME spacing (the priced staple catchment never shrinks),
// first-pass sites as occupied fixed points, rank-ordered take until the
// added seats cover the budget or candidates exhaust, APPENDED after the
// first pass (the name-collision fallback in foundCitiesFromSites is
// order-dependent, so the prefix must stay byte-stable).
//
// WHAT IS PINNED WHERE (noted per the task): the pure mechanism —
// spillBudget / spillFoundingSites / foundCitiesFromSites, the EXACT code
// refine.ts runs — is behavior-pinned on constructed fields below.
// refine.ts's own wiring (seam position before the hub pass, append order,
// ice-veto mirroring) is pinned by SOURCE TEXT: importing refine.ts costs a
// planet build + region refine per fixture (the region-refine vitest suite
// carries the real-path exercise at 240 s timeouts), far too heavy for this
// DB-free jest slice on the slow box. Same for geo-bake's cache keys.
//
// Pure logic. No DB / LLM / GL / planet builds.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SPILL_THRESHOLD_RELAX, spillBudget, spillFoundingSites, foundCitiesFromSites,
} from "@shared/world-engine/planet/cities.js";
import {
  createGrid, findFoundingSites,
  type CellGrid, type FoundingOpts, type FoundingSite, type SystemSpec,
} from "@shared/world-engine/kernel/cells/index.js";
import { TIER_POP_CAP } from "@shared/world-engine/scale.js";

const SEATS = TIER_POP_CAP.village; // 140 — the seats one spill village adds

// ─────────────────────────────────────────────── the budget (pure algebra)

describe("spillBudget — the crowd the village tier turns away", () => {
  it("is ZERO when every site's potential fits the tier (≤ 140)", () => {
    // density 28 is the boundary: round(28 × 5) = 140 = the cap exactly.
    expect(spillBudget([{ density: 0 }, { density: 10 }, { density: 28 }])).toBe(0);
    expect(spillBudget([])).toBe(0);
  });

  it("is the exact Σ of per-site excesses over the tier cap", () => {
    // potentials 250 / 500 / 150 / 25 → excesses 110 / 360 / 10 / 0 = 480.
    // The 25-potential site contributes 0, never −115 (per-site floor).
    expect(spillBudget([
      { density: 50 }, { density: 100 }, { density: 30 }, { density: 5 },
    ])).toBe(480);
  });

  it("applies the 2000 startPop clamp BEFORE the subtraction", () => {
    // density 1000 → round(5000) = 5000, clamped to 2000 → 2000 − 140 =
    // 1860 (never 4860): a site can only spill the crowd it could have
    // SEATED under the startPop formula, not the raw arithmetic.
    expect(spillBudget([{ density: 1000 }])).toBe(2000 - SEATS);
  });
});

// ──────────────────────────────── constructed fields (the twin-map method)

const COLS = 48;
const ROWS = 36;
const SPEC: SystemSpec = {
  id: "spill-map",
  name: "Spill map",
  vars: [
    { name: "forage", min: 0, max: 63, initial: 0, init: "flat", int: true },
    { name: "fertility", min: 0, max: 63, initial: 0, init: "flat", int: true },
  ],
  rules: [],
};

/** A grid of isolated forage SPIKES: each spike's radius-2 candidate cloud
 *  collapses to one accepted site under the spacing rule, and spikes stand
 *  ≥ 12 cells apart so clouds never contest each other at minSpacing 6. */
function spikeGrid(spikes: Array<[number, number, number]>): CellGrid {
  const grid = createGrid(SPEC, COLS, ROWS);
  grid.fields.fertility.fill(2); // uniform farmland: minFarmland never bites
  for (const [x, y, v] of spikes) grid.fields.forage[y * COLS + x] = v;
  return grid;
}

const FOUNDING: FoundingOpts = { threshold: 30, radius: 2, minSpacing: 6 };

// RICH spikes (60 → density 60 ≥ 30): potential 300, excess 160 each.
const RICH: Array<[number, number, number]> = [[6, 6, 60], [22, 6, 60], [38, 6, 60]];
// MARGINAL spikes (20): below the 30 gate, above the relaxed 15 gate.
const MARGINAL: Array<[number, number, number]> =
  [[6, 18, 20], [22, 18, 20], [38, 18, 20], [6, 30, 20], [22, 30, 20]];

/** The exact composition refine.ts runs: first pass → budget → spill pass →
 *  one combined ordered site list, first-pass prefix intact. */
function runBothPasses(grid: CellGrid): {
  first: FoundingSite[]; budget: number;
  candidates: FoundingSite[]; taken: FoundingSite[]; combined: FoundingSite[];
} {
  const first = findFoundingSites(grid, FOUNDING);
  const budget = spillBudget(first);
  const { candidates, taken } = spillFoundingSites(grid, FOUNDING, first, budget);
  return { first, budget, candidates, taken, combined: [...first, ...taken] };
}

describe("spillFoundingSites — the second pass over marginal land", () => {
  it("takes rank-ordered marginal sites until seats cover the budget: ceil(budget/140)", () => {
    const { first, budget, candidates, taken } = runBothPasses(spikeGrid([...RICH, ...MARGINAL]));
    expect(first.length).toBe(3);
    expect(budget).toBe(3 * (300 - SEATS)); // 480
    // Every candidate is genuinely MARGINAL: under the gate, over the floor,
    // and never a first-pass cell (correction 8: relaxation is the ONE
    // honest lever — above-gate land was already taken or spacing-blocked).
    const firstCells = new Set(first.map(s => s.cell));
    for (const c of candidates) {
      expect(c.density).toBeLessThan(FOUNDING.threshold);
      expect(c.density).toBeGreaterThanOrEqual(FOUNDING.threshold * SPILL_THRESHOLD_RELAX);
      expect(firstCells.has(c.cell)).toBe(false);
    }
    expect(candidates.length).toBe(5); // all five marginal pockets answer
    // 480 seats wanted, 140 per village → 4 villages, LITERALLY (an
    // over-founding mutation that forgets the −140 subtraction would want
    // ceil(900/140) = 7 here and drain every candidate).
    expect(taken.length).toBe(4);
    expect(taken.length).toBe(Math.ceil(budget / SEATS));
    // Coverage is MINIMAL: these seats cover the budget, one fewer would not.
    expect(taken.length * SEATS).toBeGreaterThanOrEqual(budget);
    expect((taken.length - 1) * SEATS).toBeLessThan(budget);
  });

  it("keeps the declared lattice: every pair (spill↔first, spill↔spill) ≥ minSpacing", () => {
    const grid = spikeGrid([...RICH, ...MARGINAL]);
    const { first, taken, combined } = runBothPasses(grid);
    expect(taken.length).toBeGreaterThan(0); // the pin must not be vacuous
    const sp2 = FOUNDING.minSpacing * FOUNDING.minSpacing;
    for (let i = 0; i < combined.length; i++) {
      for (let j = i + 1; j < combined.length; j++) {
        expect(grid.topo.dist2(combined[i]!.cell, combined[j]!.cell)).toBeGreaterThanOrEqual(sp2);
      }
    }
    void first;
  });

  it("exhausts gracefully when marginal land runs out before the budget is covered", () => {
    // Same three rich pockets (budget 480 → wants 4) but only TWO marginal
    // pockets exist: take both, stop — the region answered with all the
    // land it honestly had.
    const { budget, candidates, taken } = runBothPasses(
      spikeGrid([...RICH, [6, 18, 20], [22, 18, 20]]),
    );
    expect(budget).toBe(480);
    expect(candidates.length).toBe(2);
    expect(taken.length).toBe(2);
    expect(taken.length * SEATS).toBeLessThan(budget); // honest under-coverage
  });

  it("budget 0 ⇒ NO second scan: the site list is byte-identical to single-pass", () => {
    // threshold 25 with 27-spikes: sites found, potential 135 ≤ 140 → no
    // excess anywhere → the marginal band (which EXISTS on this grid) is
    // never even scanned.
    const grid = spikeGrid([[6, 6, 27], [22, 6, 27], [6, 18, 20]]);
    const f: FoundingOpts = { ...FOUNDING, threshold: 25 };
    const first = findFoundingSites(grid, f);
    expect(first.length).toBe(2);
    expect(spillBudget(first)).toBe(0);
    const { candidates, taken } = spillFoundingSites(grid, f, first, spillBudget(first));
    expect(candidates).toEqual([]);
    expect(taken).toEqual([]);
    expect(JSON.stringify([...first, ...taken])).toBe(JSON.stringify(findFoundingSites(grid, f)));
  });

  it("is deterministic: the same field twice → identical JSON", () => {
    const a = runBothPasses(spikeGrid([...RICH, ...MARGINAL]));
    const b = runBothPasses(spikeGrid([...RICH, ...MARGINAL]));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ──────────────── the append-only law THROUGH the founding path (names!)

describe("append-only founding — first-pass names are byte-stable under spill", () => {
  it("one combined ordered call keeps the first-pass village prefix byte-identical", () => {
    const grid = spikeGrid([...RICH, ...MARGINAL]);
    const { first, combined, taken } = runBothPasses(grid);
    const found = (sites: FoundingSite[]) => foundCitiesFromSites({
      sites, grid, seedBase: 0xc0ffee, dirOf: () => [0, 0, 1] as const, minFarmland: 1,
    });
    const single = found(first);
    const both = found(combined);
    expect(single.length).toBe(first.length);
    expect(both.length).toBe(combined.length);
    // THE LAW: whether or not the region spilled, the first-pass villages —
    // order, cells AND NAMES (the collision fallback and `taken` set are
    // order-dependent) — are the same bytes. Spill rows strictly append.
    expect(JSON.stringify(both.slice(0, single.length))).toBe(JSON.stringify(single));
    expect(taken.length).toBeGreaterThan(0);
    const spillCells = new Set(taken.map(s => s.cell));
    for (const v of both.slice(single.length)) expect(spillCells.has(v.cell)).toBe(true);
  });
});

// ──────────────────────────────── source pins (refine wiring + cache keys)

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), "utf8");

describe("source pins — the wiring jest cannot afford to execute", () => {
  const refineSrc = read("shared", "world-engine", "planet", "refine.ts");
  const citiesSrc = read("shared", "world-engine", "planet", "cities.ts");
  const geoBakeSrc = read("games", "world-lab", "src", "geo-bake.ts");

  it("SPILL_THRESHOLD_RELAX is the named 0.5 floor", () => {
    expect(SPILL_THRESHOLD_RELAX).toBe(0.5);
    expect(citiesSrc).toMatch(/export const SPILL_THRESHOLD_RELAX = 0\.5;/);
  });

  it("refine.ts wires the second pass in the seam: after the first-pass scan, before founding and the hub/road pass", () => {
    const budgetAt = refineSrc.indexOf("spillBudget(prep.sites)");
    const spillAt = refineSrc.indexOf("spillFoundingSites(");
    const foundAt = refineSrc.indexOf("const villages: PlanetCity[] = foundCitiesFromSites");
    const hubAt = refineSrc.indexOf("const hubSet = new Set<number>(capHubs)");
    expect(budgetAt).toBeGreaterThan(-1);
    expect(spillAt).toBeGreaterThan(budgetAt); // budget from FIRST-PASS sites only
    expect(foundAt).toBeGreaterThan(spillAt); // spill villages found with everyone
    expect(hubAt).toBeGreaterThan(foundAt); // …and hub/road/port/stitch like any village
  });

  it("refine.ts APPENDS spill sites — never prepends (the name-determinism law)", () => {
    expect(refineSrc).toContain("prep.sites = [...prep.sites, ...spill.taken]");
  });

  it("geo-bake cache keys moved: refine10 / stitch12 (stale pre-spill payloads unreachable)", () => {
    expect(geoBakeSrc).toContain("`refine10:${");
    expect(geoBakeSrc).toContain("`stitch12:${");
    expect(geoBakeSrc).not.toContain("`refine9:${");
    expect(geoBakeSrc).not.toContain("`stitch11:${");
  });
});
