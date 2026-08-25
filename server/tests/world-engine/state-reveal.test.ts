// THE REVEAL (states round S3): the internal candidate scan is the spill
// mechanism one rung up (one law, three rungs — §1), and the reveal is a
// pure replay of the state's own event line into fabric — founding years
// from crossings, ruins where the abandonment year says, walls from the war
// era, roads as old as the towns, re-foundings rising on the SAME cell with
// the SAME name (rank is the address; the name chain is cell-keyed).
// Slice: `npm run test:engine -- state-reveal`

import { describe, it, expect } from "@jest/globals";
import {
  internalTownCandidates, revealState, type RevealStateOpts,
} from "@shared/world-engine/planet/state-reveal.js";
import { simulateStateBooks } from "@shared/world-engine/planet/state-books.js";
import { settlementNameOf } from "@shared/world-engine/planet/cities.js";
import type { StateAdjacency } from "@shared/world-engine/planet/states.js";
import { createGrid, type SystemSpec, type FoundingSite } from "@shared/world-engine/kernel/cells/index.js";
import { TIER_POP_CAP } from "@shared/world-engine/scale.js";

// ── The scan: the state's own land, below the capital bar ──────────────────

const COLS = 16;
const ROWS = 12;
const at = (x: number, y: number): number => y * COLS + x;
const spec: SystemSpec = {
  id: "reveal-test",
  name: "Reveal test",
  vars: [{ name: "forage", min: 0, max: 63, initial: 0, init: "flat" }],
  rules: [],
};
// Left half is state 0, right half state 1.
const stateOf = Int32Array.from({ length: COLS * ROWS }, (_, c) => (c % COLS < 8 ? 0 : 1));

describe("internalTownCandidates — the spill, one rung up", () => {
  const build = () => {
    const grid = createGrid(spec, COLS, ROWS);
    grid.fields.forage[at(2, 6)] = 30;  // the capital's own crowd (occupied)
    grid.fields.forage[at(6, 3)] = 12;  // marginal — below 20, above 20×0.5
    grid.fields.forage[at(6, 9)] = 12;  // marginal too
    grid.fields.forage[at(5, 6)] = 8;   // below even the relaxed bar
    grid.fields.forage[at(12, 5)] = 50; // RICH — but the neighbour crown's land
    return grid;
  };
  const founding = { threshold: 20, radius: 1, minSpacing: 3 };
  const capital = [{ x: 2, y: 6 }];

  it("finds marginal sites on the state's OWN cells only, capitals held out", () => {
    const sites = internalTownCandidates({
      grid: build(), states: { stateOf }, stateIdx: 0,
      capitalSites: capital, founding,
    });
    // A radius-1 disk makes every neighbour of a spike score the spike's
    // value, so the site lands IN the spike's neighbourhood (tie order is
    // the scan's own) — one site per seeded marginal spot, none anywhere
    // else: not on the sub-bar spot, not on the rich neighbour's land, not
    // on the capital.
    expect(sites).toHaveLength(2);
    const near = (s: FoundingSite, sx: number, sy: number): boolean => {
      const x = s.cell % COLS;
      const y = Math.floor(s.cell / COLS);
      return Math.abs(x - sx) <= 1 && Math.abs(y - sy) <= 1;
    };
    expect(sites.some((s) => near(s, 6, 3))).toBe(true);
    expect(sites.some((s) => near(s, 6, 9))).toBe(true);
    for (const s of sites) {
      expect(stateOf[s.cell]).toBe(0);   // never the neighbour crown's land
      expect(s.density).toBe(12);        // the marginal crowd, not the 8 or the 50
    }
  });

  it("is deterministic, and the relax floor is the Stage β one", () => {
    const a = internalTownCandidates({
      grid: build(), states: { stateOf }, stateIdx: 0,
      capitalSites: capital, founding,
    });
    const b = internalTownCandidates({
      grid: build(), states: { stateOf }, stateIdx: 0,
      capitalSites: capital, founding,
    });
    expect(b).toEqual(a);
    // Un-relaxed (relax 1): the marginal 12s fall below the full bar of 20.
    const strict = internalTownCandidates({
      grid: build(), states: { stateOf }, stateIdx: 0,
      capitalSites: capital, founding, relax: 1,
    });
    expect(strict.map((s) => s.cell)).not.toContain(at(6, 3));
  });
});

// ── The reveal: events → fabric ─────────────────────────────────────────────

const SEED = 424242;
const cand = (cell: number, x: number, density: number): FoundingSite =>
  ({ cell, x, y: 0, density } as unknown as FoundingSite);

const fixture = (overrides?: Partial<RevealStateOpts>): RevealStateOpts => ({
  candidates: [cand(101, 10, 90), cand(102, 20, 80), cand(103, 30, 70)],
  economy: {
    // Founding condition: 1 town already implied (pop 1500 > 1104).
    booksAt: () => [{ pop: 1500, potential: 9000, fill: 1, imports: 0, exports: 0 }],
    events: [
      { year: 40, kind: "founding", state: 0, count: 2 },
      { year: 90, kind: "abandonment", state: 0, count: 1 },
      { year: 150, kind: "founding", state: 0, count: 2 },
      { year: 170, kind: "founding", state: 1, count: 1 }, // another crown's history
    ],
  },
  warYears: [60],
  stateIdx: 0,
  year: 200,
  seatCell: 100,
  seatAt: { x: 0, y: 0 },
  nameSeed: SEED,
  ...overrides,
});

describe("revealState — a map built out of real history", () => {
  it("the founding condition stands from year 0; crossings attach their years", () => {
    const r = revealState(fixture());
    expect(r.towns).toHaveLength(2);
    expect(r.unplaced).toBe(0);
    const [t1, t2] = r.towns;
    expect(t1!.rank).toBe(1);
    expect(t1!.foundedYear).toBe(0);      // as old as the state — eventless
    expect(t1!.abandonedYear).toBeUndefined();
    expect(t1!.ageYears).toBe(200);
    expect(t2!.rank).toBe(2);
    expect(t2!.foundedYear).toBe(150);    // the RE-founding — the latest life
    expect(t2!.ageYears).toBe(50);
  });

  it("a ruin stands at its rank's address between its lives", () => {
    const r = revealState(fixture({ year: 100 })); // after the fall, before the re-rise
    const t2 = r.towns.find((t) => t.rank === 2)!;
    expect(t2.foundedYear).toBe(40);
    expect(t2.abandonedYear).toBe(90);
    expect(t2.ageYears).toBe(50);         // how long it LIVED — its remains' size
    // …and the same cell, the same name, at every year (the identity law).
    const later = revealState(fixture());
    const risen = later.towns.find((t) => t.rank === 2)!;
    expect(risen.site.cell).toBe(t2.site.cell);
    expect(risen.name).toBe(t2.name);
    expect(risen.name).toBe(settlementNameOf(SEED, 102));
  });

  it("walls come from wars that crossed a life; a later-born town wears none", () => {
    const r100 = revealState(fixture({ year: 100 }));
    expect(r100.towns.find((t) => t.rank === 1)!.walls).toBe(true);  // 60 ∈ [0, 100]
    expect(r100.towns.find((t) => t.rank === 2)!.walls).toBe(true);  // 60 ∈ [40, 90]
    const r200 = revealState(fixture());
    expect(r200.towns.find((t) => t.rank === 2)!.walls).toBe(false); // born 150, war was 60
  });

  it("roads join the elder network at founding, and are as old as the town", () => {
    const r = revealState(fixture());
    const [t1, t2] = r.towns;
    expect(t1!.road).toEqual({ toCell: 100, builtYear: 0 });   // to the seat
    expect(t2!.road).toEqual({ toCell: 101, builtYear: 150 }); // nearest elder is town 1
  });

  it("two reveals agree on their shared past (the destiny property)", () => {
    const early = revealState(fixture({ year: 50 }));
    const late = revealState(fixture());
    for (const t of early.towns) {
      const then = late.towns.find((x) => x.rank === t.rank)!;
      expect(then.site.cell).toBe(t.site.cell);
      expect(then.name).toBe(t.name);
      // Rank 2's later life differs by DESIGN (it fell and re-rose); rank 1's
      // founding is shared history and must match exactly.
      if (t.rank === 1) expect(then.foundedYear).toBe(t.foundedYear);
    }
  });

  it("land that cannot seat the count is REPORTED, never silently capped", () => {
    const r = revealState(fixture({
      economy: {
        booksAt: () => [{ pop: 0, potential: 0, fill: 1, imports: 0, exports: 0 }],
        events: [
          { year: 10, kind: "founding", state: 0, count: 1 },
          { year: 20, kind: "founding", state: 0, count: 2 },
          { year: 30, kind: "founding", state: 0, count: 3 },
          { year: 40, kind: "founding", state: 0, count: 4 },
          { year: 50, kind: "founding", state: 0, count: 5 },
        ],
      },
    }));
    expect(r.towns).toHaveLength(3); // the candidate list's whole length
    expect(r.unplaced).toBe(2);
  });

  it("another crown's events are not this state's history", () => {
    const r = revealState(fixture({ stateIdx: 1, candidates: [cand(201, 5, 50)] }));
    // State 1's only event is its year-170 founding; its books imply nothing
    // at year 0 (the stub booksAt rows are read at index 1 → undefined → 0).
    expect(r.towns).toHaveLength(1);
    expect(r.towns[0]!.foundedYear).toBe(170);
  });
});

// ── S1 ↔ S3: the reveal rides the real trajectory ──────────────────────────

describe("the reveal over a real state-books trajectory", () => {
  it("the breadbasket's crossings attach ascending years and all stand", () => {
    const adjacency: StateAdjacency[] = [{ a: 0, b: 1, costM: 1000 }];
    const econ = simulateStateBooks({
      seats: [{ startPop: 500 }, { startPop: 1500 }],
      states: { stateOf: Int32Array.of(0, 1), adjacency },
      sites: [
        { cell: 0, density: 300 }, { cell: 0, density: 300 }, { cell: 0, density: 300 },
        { cell: 1, density: 40 },
      ],
      years: 400,
    });
    const foundings = econ.events.filter((e) => e.kind === "founding" && e.state === 0);
    expect(foundings.length).toBeGreaterThan(0);
    const r = revealState({
      candidates: [cand(11, 10, 60), cand(12, 20, 55), cand(13, 30, 50), cand(14, 40, 45)],
      economy: econ,
      stateIdx: 0,
      year: 400,
      seatCell: 0,
      seatAt: { x: 0, y: 0 },
      nameSeed: SEED,
    });
    expect(r.towns.length).toBe(Math.min(foundings.length, 4));
    expect(r.unplaced).toBe(Math.max(0, foundings.length - 4));
    for (let i = 1; i < r.towns.length; i++) {
      expect(r.towns[i]!.foundedYear).toBeGreaterThanOrEqual(r.towns[i - 1]!.foundedYear);
    }
    // Population only grew in this window: nothing is a ruin.
    expect(r.towns.every((t) => t.abandonedYear === undefined)).toBe(true);
    // The town count at the horizon IS the books' implied count.
    const implied = Math.floor(econ.booksAt(400)[0]!.pop / TIER_POP_CAP.town);
    expect(r.towns.filter((t) => !t.abandonedYear).length).toBe(Math.min(implied, 4));
  });

  it("S4 — THE PAST STANDS under intervention: destiny recomputes forward only, at the FABRIC level", () => {
    const opts = {
      seats: [{ startPop: 500 }, { startPop: 1500 }],
      states: {
        stateOf: Int32Array.of(0, 1),
        adjacency: [{ a: 0, b: 1, costM: 1000 }] as StateAdjacency[],
      },
      sites: [
        { cell: 0, density: 300 }, { cell: 0, density: 300 }, { cell: 0, density: 300 },
        { cell: 1, density: 40 },
      ],
      years: 400,
    };
    const base = simulateStateBooks(opts);
    const bumped = simulateStateBooks({
      ...opts,
      interventions: [{ year: 250, state: 0, popDelta: 3000 }],
    });
    const candidates = [cand(11, 10, 60), cand(12, 20, 55), cand(13, 30, 50), cand(14, 40, 45), cand(15, 50, 40)];
    const revealOf = (economy: typeof base, year: number) => revealState({
      candidates, economy, stateIdx: 0, year,
      seatCell: 0, seatAt: { x: 0, y: 0 }, nameSeed: SEED,
    });
    // Before the intervention year, the two worlds are ONE world — the whole
    // map, byte-equal.
    expect(revealOf(bumped, 249)).toEqual(revealOf(base, 249));
    // After it, every town founded BEFORE the intervention stands untouched
    // (site, name, year — the past is not renegotiated)…
    const after = revealOf(bumped, 400);
    const control = revealOf(base, 400);
    for (const t of control.towns.filter((x) => x.foundedYear < 250)) {
      const same = after.towns.find((x) => x.rank === t.rank)!;
      expect(same.site.cell).toBe(t.site.cell);
      expect(same.name).toBe(t.name);
      expect(same.foundedYear).toBe(t.foundedYear);
    }
    // …and the bump's own history is NEW towns, founded at or after year 250.
    expect(after.towns.length).toBeGreaterThan(control.towns.length);
    for (const t of after.towns.filter((x) => !control.towns.some((c) => c.rank === x.rank))) {
      expect(t.foundedYear).toBeGreaterThanOrEqual(250);
    }
  });
});
