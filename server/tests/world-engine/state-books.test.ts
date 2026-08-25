// THE STATE'S BOOKS (states round S1 — states-round.md §11/§14): the yearly
// closed-form economic trajectory over the tier-0 states — potential from
// claimed sites under the founding formula, imports chosen by GEOGRAPHY
// (deficit vs the trade net), float-Malthus vitals, economic events on the
// political ledger's year line, the replay contract, and the MARKOV
// RE-ROUTE pin (perturb at year Y ⇒ byte-identical before, recomputed after).
// Slice: `npm run test:engine -- state-books`

import { describe, it, expect } from "@jest/globals";
import {
  simulateStateBooks, STATE_VITALS, type StateBooksOpts,
} from "@shared/world-engine/planet/state-books.js";
import { simulateHistory } from "@shared/world-engine/planet/history.js";
import type { PlanetCity } from "@shared/world-engine/planet/cities.js";
import type { StateAdjacency } from "@shared/world-engine/planet/states.js";
import { TIER_POP_CAP } from "@shared/world-engine/scale.js";
import { isCoarseChannel } from "@shared/world-engine/kernel/destiny.js";

// ── The fixture: four crowns on a line, one cut off by sea ─────────────────
//
//   0 (breadbasket) —1000— 1 (crowded) —1200— 2 (modest)  ×Infinity×  3 (isolated, crowded)
//
// Potentials by the founding formula min(2000, round(density × 5)):
//   state 0: 3 sites × density 300  → 4500 souls of land
//   state 1: 1 site  × density 40   → 200   (startPop 1500 — an importer by geography)
//   state 2: 1 site  × density 100  → 500
//   state 3: 1 site  × density 40   → 200   (startPop 3000, no passable border — starves)

const stateOf = Int32Array.of(0, 1, 2, 3, -1);
const adjacency: StateAdjacency[] = [
  { a: 0, b: 1, costM: 1000 },
  { a: 1, b: 2, costM: 1200 },
  { a: 2, b: 3, costM: Infinity }, // a border with no crossing — sea-locked
];
const baseOpts = (): StateBooksOpts => ({
  seats: [{ startPop: 500 }, { startPop: 1500 }, { startPop: 400 }, { startPop: 3000 }],
  states: { stateOf, adjacency },
  sites: [
    { cell: 0, density: 300 }, { cell: 0, density: 300 }, { cell: 0, density: 300 },
    { cell: 1, density: 40 },
    { cell: 2, density: 100 },
    { cell: 3, density: 40 },
    { cell: 4, density: 500 },   // unclaimed land feeds nobody's books
    { cell: 999, density: 500 }, // off the map entirely — ignored
  ],
  years: 200,
});

describe("potential — the engine's own accounting of claimed land", () => {
  it("sums claimed sites under the founding formula; unclaimed sites feed nobody", () => {
    const econ = simulateStateBooks(baseOpts());
    expect(econ.potentials).toEqual([4500, 200, 500, 200]);
  });

  it("the intervention channel is on the destiny membrane", () => {
    expect(isCoarseChannel("state-books:intervention")).toBe(true);
  });
});

describe("the replay contract — derived, deterministic, clamped", () => {
  it("same inputs, same books, same events — twice", () => {
    const a = simulateStateBooks(baseOpts());
    const b = simulateStateBooks(baseOpts());
    expect(b.events).toEqual(a.events);
    expect(b.booksAt(50)).toEqual(a.booksAt(50));
    expect(b.booksAt(200)).toEqual(a.booksAt(200));
  });

  it("booksAt is a pure read: repeated queries agree, years clamp", () => {
    const econ = simulateStateBooks(baseOpts());
    expect(econ.booksAt(50)).toEqual(econ.booksAt(50));
    expect(econ.booksAt(-5)).toEqual(econ.booksAt(0));
    expect(econ.booksAt(9999)).toEqual(econ.booksAt(200));
    // Year 0 is the founding condition itself.
    expect(econ.booksAt(0).map(r => r.pop)).toEqual([500, 1500, 400, 3000]);
  });
});

describe("trade — geography chooses the importers (the T5 direction)", () => {
  it("a crowded neighbour of a breadbasket imports; the books conserve", () => {
    const econ = simulateStateBooks(baseOpts());
    // The deficit exists from the first year, so the lane opens at year 1.
    expect(econ.events[0]).toEqual({ year: 1, kind: "trade-open", state: 0, partner: 1 });
    const rows = econ.booksAt(10);
    expect(rows[1]!.imports).toBeGreaterThan(0);
    expect(rows[1]!.fill).toBe(1); // fed by the lane, not its own land
    expect(rows[0]!.exports).toBe(rows[1]!.imports);
    // Lossless v1: what leaves the exporters is what reaches the importers.
    const totalIn = rows.reduce((sum, r) => sum + r.imports, 0);
    const totalOut = rows.reduce((sum, r) => sum + r.exports, 0);
    expect(totalIn).toBeCloseTo(totalOut, 10);
  });

  it("an impassable border trades nothing: the isolated crown starves down", () => {
    const econ = simulateStateBooks(baseOpts());
    const early = econ.booksAt(0)[3]!;
    const later = econ.booksAt(30)[3]!;
    expect(early.imports).toBe(0);
    expect(later.imports).toBe(0);
    expect(later.pop).toBeLessThan(400); // collapsed toward its own 200 souls of land
    expect(later.pop).toBeGreaterThan(0);
    // Its two implied towns emptied on the way down, oldest first.
    const falls = econ.events.filter(e => e.kind === "abandonment" && e.state === 3);
    expect(falls.map(e => e.count)).toEqual([1, 0]);
    expect(falls[0]!.year).toBeLessThanOrEqual(falls[1]!.year);
  });

  it("growth writes foundings with ascending years — the reveal's fabric", () => {
    const econ = simulateStateBooks(baseOpts());
    const rises = econ.events.filter(e => e.kind === "founding");
    expect(rises.length).toBeGreaterThan(0);
    for (let i = 1; i < rises.length; i++) {
      expect(rises[i]!.year).toBeGreaterThanOrEqual(rises[i - 1]!.year);
    }
    // The breadbasket's crowd crosses its first town bar somewhere in two
    // centuries of ~0.5%/yr growth (the pre-modern anchor).
    expect(rises.some(e => e.state === 0 && e.count === 1)).toBe(true);
    // Nobody records the founding condition as an event: state 1 started
    // ABOVE one town bar, and no founding names its count 1.
    expect(econ.events.some(e => e.kind === "founding" && e.state === 1 && e.count === 1)).toBe(false);
    expect(Math.floor(1500 / TIER_POP_CAP.town)).toBe(1); // the premise of the line above
  });
});

describe("Markov — destiny recomputes forward from an intervention", () => {
  it("byte-identical before year Y, recomputed after; loud on bad input", () => {
    const base = simulateStateBooks(baseOpts());
    const bumped = simulateStateBooks({
      ...baseOpts(),
      interventions: [{ year: 50, state: 0, popDelta: 5000 }],
    });
    // History BEFORE the intervention never saw it.
    const before = (events: typeof base.events) => events.filter(e => e.year < 50);
    expect(before(bumped.events)).toEqual(before(base.events));
    expect(bumped.booksAt(49)).toEqual(base.booksAt(49));
    // From year 50 on, the trajectory is a new one.
    expect(bumped.booksAt(50)[0]!.pop).toBeGreaterThan(base.booksAt(50)[0]!.pop + 4000);
    expect(bumped.potentials).toEqual(base.potentials); // geography never moved
    // A typoed intervention fails loudly, never silently.
    expect(() => simulateStateBooks({ ...baseOpts(), interventions: [{ year: 0, state: 0, popDelta: 1 }] }))
      .toThrow(/outside/);
    expect(() => simulateStateBooks({ ...baseOpts(), interventions: [{ year: 5, state: 99, popDelta: 1 }] }))
      .toThrow(/unknown state/);
  });
});

describe("the court rides the books — the stateWeight bridge", () => {
  it("stateWeight is the population at the year, floored at the court's 1", () => {
    const econ = simulateStateBooks(baseOpts());
    expect(econ.stateWeight(0, 10)).toBe(Math.max(1, econ.booksAt(10)[0]!.pop));
    expect(econ.stateWeight(3, 200)).toBeGreaterThanOrEqual(1);
    expect(econ.stateWeight(-1, 10)).toBe(1);
  });

  it("simulateHistory accepts the bridge and stays deterministic", () => {
    const econ = simulateStateBooks(baseOpts());
    const cities = baseOpts().seats.map((s, i) => ({
      cell: i, name: `crown-${i}`, startPop: s.startPop,
    })) as unknown as PlanetCity[];
    const states = { stateOf, adjacency, costM: new Float64Array(0), borderCells: [] };
    const run = () => simulateHistory({
      cities, states, seed: 7, years: 120, stateWeight: econ.stateWeight,
    });
    expect(run().events).toEqual(run().events);
    // The default path never sees the year parameter — a year-blind
    // custom weight still typechecks (compile-time fact, exercised here).
    const blind = simulateHistory({ cities, states, seed: 7, years: 40, stateWeight: (s) => s + 1 });
    expect(blind.events).toEqual(simulateHistory({ cities, states, seed: 7, years: 40, stateWeight: (s) => s + 1 }).events);
  });

  it("the yearly vitals equilibrium is the capacity law, not the transient", () => {
    // fill* solves birth·f = death + starvation·(1−f): the crowd settles a
    // hair above what the land (plus lanes) feeds — population follows
    // capacity (Stage β's law, restated at the year grain).
    const f = (STATE_VITALS.deathRate + STATE_VITALS.starvation)
      / (STATE_VITALS.birthRate + STATE_VITALS.starvation);
    const econ = simulateStateBooks({ ...baseOpts(), years: 2000 });
    const settled = econ.booksAt(2000)[3]!; // the isolated crown has ONLY its land
    expect(settled.pop).toBeCloseTo(200 / f, 0);
  });
});
