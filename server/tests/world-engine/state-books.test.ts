// THE STATE'S BOOKS (states round S1 — states-round.md §11/§14): the yearly
// closed-form economic trajectory over the tier-0 states — potential from
// claimed sites under the founding formula, imports chosen by GEOGRAPHY
// (deficit vs the trade net), float-Malthus vitals, economic events on the
// political ledger's year line, the replay contract, and the MARKOV
// RE-ROUTE pin (perturb at year Y ⇒ byte-identical before, recomputed after).
// Slice: `npm run test:engine -- state-books`

import { describe, it, expect } from "@jest/globals";
import {
  simulateStateBooks, routeStateDelta, STATE_VITALS, STATE_POP_KIND,
  type StateBooksOpts, type StateGoodSpec,
} from "@shared/world-engine/planet/state-books.js";
import { memoryLifespan } from "@shared/world-engine/kernel/destiny.js";
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
    // (Per-kind round ⑬ — THE round's one pin edit: trade events carry
    // their kind; the default catalogue's feeder is "food".)
    expect(econ.events[0]).toEqual({ year: 1, kind: "trade-open", state: 0, partner: 1, good: "food" });
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

// ── The per-kind round (task #40, states-round.md §15–§20) ─────────────────

/** Frozen population (zero vitals) makes kind arithmetic exact. */
const DEAD_VITALS = { birthRate: 0, deathRate: 0, starvation: 0 };

/** Two crowns, one lane — a FABRICATED kind (§20 primitives-only law: the
 *  engine must run a catalogue it has never heard of). State 0's one site
 *  carries the axis; state 1 is bare ground. Finite: reserve = 1000 × 2. */
const obsidianOpts = (goods: readonly StateGoodSpec[], years = 5): StateBooksOpts => ({
  seats: [{ startPop: 500 }, { startPop: 1000 }],
  states: {
    stateOf: Int32Array.of(0, 1),
    adjacency: [{ a: 0, b: 1, costM: 1000 }],
  },
  sites: [
    { cell: 0, density: 0, charter: { obsidian_veins: 10 } },
    { cell: 1, density: 0 },
  ],
  years,
  vitals: DEAD_VITALS,
  goods,
});

const OBSIDIAN: StateGoodSpec = {
  id: "obsidian", potential: { axis: "obsidian_veins", perAxis: 100 }, reserveYears: 2,
};

describe("per-kind books — generic over a fabricated catalogue (§20)", () => {
  it("axis potentials read the charter box; bare sites stay inert", () => {
    const econ = simulateStateBooks(obsidianOpts([OBSIDIAN]));
    expect(econ.goodPotentials["obsidian"]).toEqual([1000, 0]);
    // No feedsPopulation kind ⇒ the feeding projection is empty ground.
    expect(econ.potentials).toEqual([0, 0]);
    expect(econ.booksAt(1)[0]!.fill).toBe(1);
  });

  it("the full finite arc: trade-open → exact-zero depletion (once) → trade-close", () => {
    const econ = simulateStateBooks(obsidianOpts([OBSIDIAN]));
    // reserve₀ 2000; extraction = local 500 + exports 500 = 1000/yr
    // (demand-driven — never drawn to waste), so year 2 lands on EXACT zero.
    expect(econ.events).toEqual([
      { year: 1, kind: "trade-open", state: 0, partner: 1, good: "obsidian" },
      { year: 2, kind: "depletion", state: 0, good: "obsidian" },
      { year: 3, kind: "trade-close", state: 0, partner: 1, good: "obsidian" },
    ]);
    const y1 = econ.booksAt(1)[0]!.goods["obsidian"]!;
    expect(y1.reserve).toBe(1000);
    expect(y1.exports).toBe(500);
    expect(econ.booksAt(1)[1]!.goods["obsidian"]!.imports).toBe(500); // lossless
    // After exhaustion the locale churns NOTHING for the kind — the flux
    // quote goes to zero, which is exactly ruling ②'s durable-impact case.
    const y3 = econ.booksAt(3)[0]!.goods["obsidian"]!;
    expect(y3.supply).toBe(0);
    expect(y3.reserve).toBe(0);
    expect(y3.flux).toBe(0);
  });

  it("a reserve intervention moves the depletion year (Markov, stock arm)", () => {
    const econ = simulateStateBooks({
      ...obsidianOpts([OBSIDIAN]),
      interventions: [{ year: 1, state: 0, good: "obsidian", delta: 1000 }],
    });
    const depletion = econ.events.filter((e) => e.kind === "depletion");
    expect(depletion).toEqual([{ year: 3, kind: "depletion", state: 0, good: "obsidian" }]);
  });

  it("a flow intervention feeds its one year only — a ledger event, not a snapshot", () => {
    const GRAIN2: StateGoodSpec = { id: "grain2", potential: { axis: "loam", perAxis: 1 } };
    const opts = obsidianOpts([GRAIN2], 8);
    const econ = simulateStateBooks({
      ...opts,
      sites: [{ cell: 0, density: 0 }, { cell: 1, density: 0 }], // NO axis anywhere
      interventions: [{ year: 5, state: 0, good: "grain2", delta: 2000 }],
    });
    expect(econ.events).toEqual([
      { year: 5, kind: "trade-open", state: 0, partner: 1, good: "grain2" },
      { year: 6, kind: "trade-close", state: 0, partner: 1, good: "grain2" },
    ]);
    // The snapshot quotes the year's implied flows off geography — the
    // bump was that year's EVENT (visible above), never part of the quote.
    expect(econ.booksAt(5)[0]!.goods["grain2"]!.supply).toBe(0);
  });

  it("loud validation: unknown goods, unpaired deltas, empty moves, duplicate ids", () => {
    const opts = obsidianOpts([OBSIDIAN]);
    expect(() => simulateStateBooks({
      ...opts, interventions: [{ year: 1, state: 0, good: "mithril", delta: 5 }],
    })).toThrow(/unknown good/);
    expect(() => simulateStateBooks({
      ...opts, interventions: [{ year: 1, state: 0, good: "obsidian" }],
    })).toThrow(/one without the other/);
    expect(() => simulateStateBooks({
      ...opts, interventions: [{ year: 1, state: 0 }],
    })).toThrow(/moves nothing/);
    expect(() => simulateStateBooks({
      ...opts, goods: [OBSIDIAN, { id: "obsidian", potential: { foundingCrowd: true } }],
    })).toThrow(/repeats id/);
  });
});

describe("feeders combine by MINIMUM — Liebig, the binding constraint", () => {
  it("population equilibrates on the SCARCER feeder, never the sum", () => {
    const econ = simulateStateBooks({
      seats: [{ startPop: 500 }],
      states: { stateOf: Int32Array.of(0), adjacency: [] },
      sites: [{ cell: 0, density: 300, charter: { aquifer: 600 } }],
      years: 2000,
      goods: [
        { id: "crop", potential: { foundingCrowd: true }, feedsPopulation: true },
        { id: "water", potential: { axis: "aquifer", perAxis: 1 }, feedsPopulation: true },
      ],
    });
    // crop feeds 1500, water only 600 — the projection SUMS potential but
    // the vitals bind on the minimum fill, so the crowd settles on water.
    expect(econ.booksAt(0)[0]!.potential).toBe(2100);
    const f = (STATE_VITALS.deathRate + STATE_VITALS.starvation)
      / (STATE_VITALS.birthRate + STATE_VITALS.starvation);
    expect(econ.booksAt(2000)[0]!.pop).toBeCloseTo(600 / f, 0);
    const row = econ.booksAt(2000)[0]!;
    expect(row.fill).toBeCloseTo(row.goods["water"]!.fill, 12);
    expect(row.goods["crop"]!.fill).toBe(1);
  });

  it("the default catalogue's projection IS the food row (one feeder ≡ S1)", () => {
    const econ = simulateStateBooks(baseOpts());
    const row = econ.booksAt(10)[1]!;
    expect(row.imports).toBe(row.goods["food"]!.imports);
    expect(row.fill).toBe(row.goods["food"]!.fill);
    expect(row.goods["timber"]!.potential).toBe(0); // no charter in the fixture
    expect(row.goods["ore"]!.reserve).toBe(0);      // finite quote present
    expect([...econ.goodPotentials["food"]!]).toEqual([...econ.potentials]);
  });
});

describe("the θ router — rulings ② + ④ made mechanical (the four cases)", () => {
  const econ = simulateStateBooks(baseOpts());

  it("② case 1: a small consumable into a churning locale is erased quickly", () => {
    const flux = econ.fluxAt(0, "food", 10);
    expect(flux).toBeGreaterThan(0); // the breadbasket produces AND feeds
    const out = routeStateDelta(econ, { year: 10, state: 0, good: "food", delta: flux * 0.001 });
    expect(out.route).toBe("memory");
    if (out.route === "memory") {
      expect(out.memory.kind).toBe("food");
      expect(Number.isFinite(out.memory.expiresAt)).toBe(true);
      // magnitude/flux × turnover — a blink against the locale's own churn.
      expect(out.memory.expiresAt - out.memory.writtenAt).toBeLessThan(1);
    }
  });

  it("② case 2: a delta the churn cannot hide writes coarse (Markov forward)", () => {
    const flux = econ.fluxAt(0, "food", 10);
    const out = routeStateDelta(econ, { year: 10, state: 0, good: "food", delta: flux });
    expect(out).toEqual({
      route: "coarse",
      intervention: { year: 10, state: 0, good: "food", delta: flux },
    });
  });

  it("② cases 3+4: where the kind is RARE the flux is zero — every delta is durable", () => {
    // Nobody in the fixture has timberland: no production, no trade, no churn.
    expect(econ.fluxAt(0, "timber", 10)).toBe(0);
    const out = routeStateDelta(econ, { year: 10, state: 0, good: "timber", delta: 5 });
    expect(out.route).toBe("coarse"); // θ = 0 — the books never forget it
    // And the wilderness clause is the same law one step further: a memory
    // stamped against zero flux never expires (destiny's own pin, quoted
    // here because the state books are what hand destiny that flux).
    expect(memoryLifespan(5, 0)).toBe(Infinity);
  });

  it("the pop arm: flat-% θ (④), but the stamp fades on the honest vital churn", () => {
    const pop = econ.booksAt(10)[0]!.pop;
    const small = routeStateDelta(econ, { year: 10, state: 0, popDelta: pop * 0.001 });
    expect(small.route).toBe("memory");
    if (small.route === "memory") {
      expect(small.memory.kind).toBe(STATE_POP_KIND);
      expect(Number.isFinite(small.memory.expiresAt)).toBe(true);
    }
    const big = routeStateDelta(econ, { year: 10, state: 0, popDelta: -pop * 0.5 });
    expect(big).toEqual({
      route: "coarse",
      intervention: { year: 10, state: 0, popDelta: -pop * 0.5 },
    });
  });

  it("routes exactly one variable, loudly", () => {
    expect(() => routeStateDelta(econ, { year: 10, state: 0 })).toThrow(/exactly one/);
    expect(() => routeStateDelta(econ, { year: 10, state: 0, popDelta: 1, good: "food", delta: 1 }))
      .toThrow(/exactly one/);
    expect(() => routeStateDelta(econ, { year: 10, state: 0, good: "food" }))
      .toThrow(/one without the other/);
  });
});
