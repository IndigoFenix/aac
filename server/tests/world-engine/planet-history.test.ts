// THE COURT (nations P5) — deep political history over the tier-0 states:
// deterministic centuries of fusion and fission (the dispute machine's
// channels in closed form), ownership by REPLAY, cede-only scrubbing onto
// the live ledger, and the live dispute→relabel binding. Pure — states are
// hand-made, no planet bake.

import { describe, it, expect } from "@jest/globals";
import {
  simulateHistory, stateAdjacency, applyResolutions,
  type DisputeResolutionRow, type PolityEvent,
} from "@shared/world-engine/planet/history.js";
import { createPolities } from "@shared/world-engine/planet/polities.js";
import { channelTaboos } from "@shared/world-engine/kernel/civ/dual.js";
import type { PlanetStates } from "@shared/world-engine/planet/states.js";
import type { PlanetCity } from "@shared/world-engine/planet/cities.js";

/** A 4×5 grid of 20 city-states (cell i = state i), varied founding
 *  populations so strength ratios differ — enough graph for empires. */
const COLS = 4;
const ROWS = 5;
const N = COLS * ROWS;

const CITIES: PlanetCity[] = Array.from({ length: N }, (_, i) => ({
  cell: i,
  name: `State-${i}`,
  dir: [1, 0, 0] as const,
  density: 50,
  charter: { farmland: 50, ore_access: 0, timberland: 0 },
  startPop: 30 + ((i * 37) % 51), // 30..80, deterministic spread
}));

const STATES: PlanetStates = {
  stateOf: Int32Array.from(Array.from({ length: N }, (_, i) => i)),
  costM: new Float64Array(N),
  adjacency: (() => {
    const pairs: Array<{ a: number; b: number; costM: number }> = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = r * COLS + c;
        if (c + 1 < COLS) pairs.push({ a: i, b: i + 1, costM: 1000 });
        if (r + 1 < ROWS) pairs.push({ a: i, b: i + COLS, costM: 1000 });
      }
    }
    return pairs;
  })(),
  borderCells: [],
};

const YEARS = 600;

describe("state adjacency — the tier-0 political graph", () => {
  it("per-state neighbor lists from the derived adjacency pairs", () => {
    const adj = stateAdjacency(STATES, N);
    expect(adj[0]).toEqual([1, COLS]); // corner: right + down
    expect(adj[5]).toEqual([1, 4, 6, 9]); // interior: all four
    expect(adj).toHaveLength(N);
  });
});

describe("deep history — nations rise and fall (P5 gate)", () => {
  const history = simulateHistory({ cities: CITIES, states: STATES, seed: 7, years: YEARS });

  it("is deterministic — same inputs, same events", () => {
    const again = simulateHistory({ cities: CITIES, states: STATES, seed: 7, years: YEARS });
    expect(again.events).toEqual(history.events);
    const other = simulateHistory({ cities: CITIES, states: STATES, seed: 8, years: YEARS });
    expect(other.events).not.toEqual(history.events);
  });

  it("events are ordered, well-formed, and both fusion AND fission occur", () => {
    let last = 0;
    for (const ev of history.events) {
      expect(ev.year).toBeGreaterThanOrEqual(last);
      last = ev.year;
      expect(ev.from).not.toBe(ev.to);
      if (ev.kind !== "merge") {
        expect(ev.state).toBeGreaterThanOrEqual(0);
        expect(ev.state).toBeLessThan(N);
      }
      if (ev.kind === "secede") expect(ev.to).toBe(ev.state); // the reborn founding crown
    }
    const fusion = history.events.filter(e => e.kind === "cede" || e.kind === "merge");
    const fission = history.events.filter(e => e.kind === "secede");
    expect(fusion.length).toBeGreaterThan(0);
    expect(fission.length).toBeGreaterThan(0);
  });

  it("empires assemble: some year holds a crown of at least 4 states", () => {
    let biggest = 0;
    for (let y = 0; y <= YEARS; y += 25) {
      const owner = history.ownerAt(y);
      const held = new Map<number, number>();
      for (let s = 0; s < N; s++) held.set(owner[s]!, (held.get(owner[s]!) ?? 0) + 1);
      biggest = Math.max(biggest, ...held.values());
    }
    expect(biggest).toBeGreaterThanOrEqual(4);
  });

  it("consolidation is real: the living-crown count dips well below founding", () => {
    let fewest = N;
    for (let y = 0; y <= YEARS; y += 25) {
      fewest = Math.min(fewest, history.livingAt(y).length);
    }
    expect(history.livingAt(0)).toHaveLength(N); // founding: every state its own crown
    expect(fewest).toBeLessThanOrEqual(Math.floor(N * 0.6));
  });

  it("ownership is replay: ownerAt reflects exactly the events up to the year", () => {
    // Pick the first cede/secede event and check before/after.
    const ev = history.events.find(e => e.kind !== "merge") as PolityEvent;
    const before = history.ownerAt(ev.year - 1);
    const after = history.ownerAt(ev.year);
    expect(after[ev.state!]).toBe(ev.to);
    expect(before[ev.state!]).not.toBe(ev.to);
  });
});

describe("the violence taboo writes a BLOODLESS history (nations §6)", () => {
  it("no war events; fusion still happens through prestige and union", () => {
    const history = simulateHistory({
      cities: CITIES, states: STATES, seed: 7, years: YEARS,
      taboos: channelTaboos(new Set(["fight"])),
    });
    expect(history.events.some(e => e.channel === "war")).toBe(false);
    expect(history.events.some(e => e.channel === "prestige" || e.channel === "union")).toBe(true);
    expect(history.events.some(e => e.kind === "secede")).toBe(true);
  });
});

describe("scrubbing — cede-only relabels onto the live ledger", () => {
  it("applyTo moves the ledger to any year and back, unions ledger untouched", () => {
    const history = simulateHistory({ cities: CITIES, states: STATES, seed: 7, years: YEARS });
    const p = createPolities(CITIES);

    const moved = history.applyTo(p); // the end of history
    expect(moved).toBeGreaterThan(0);
    const target = history.ownerAt(YEARS);
    for (let s = 0; s < N; s++) expect(p.polityOfState(s)).toBe(target[s]);
    expect(p.version).toBe(moved);

    // Scrub back mid-way, then to founding — the general relabel both ways.
    history.applyTo(p, Math.floor(YEARS / 2));
    const mid = history.ownerAt(Math.floor(YEARS / 2));
    for (let s = 0; s < N; s++) expect(p.polityOfState(s)).toBe(mid[s]);
    history.applyTo(p, 0);
    for (let s = 0; s < N; s++) expect(p.polityOfState(s)).toBe(s);

    // The unions ledger is reserved for real consented merges — a scrub
    // never writes it.
    expect(p.unions()).toHaveLength(0);
  });
});

describe("the live binding — disputes decide relabels (the P1 hook retired)", () => {
  const SITE_STATE = new Map([["alpha", 0], ["beta", 1], ["gamma", 2]]);
  const siteState = (k: string): number | undefined => SITE_STATE.get(k);
  const CITIES3 = CITIES.slice(0, 3);

  const row = (partial: Partial<DisputeResolutionRow>): DisputeResolutionRow => ({
    day: 1, edge: 0, channel: "war", loser: "beta", winner: "alpha",
    civ: "member_a", mode: "political", casualties: 0, ...partial,
  });

  it("political and physical falls cede the loser's state to the winner's crown", () => {
    const p = createPolities(CITIES3);
    const applied = applyResolutions(p, [
      row({ mode: "political", loser: "beta", winner: "alpha" }),
      row({ mode: "physical", loser: "gamma", winner: "beta", channel: "war", day: 2 }),
    ], siteState);
    expect(applied).toBe(2);
    expect(p.polityOfState(1)).toBe(0); // beta's state joined alpha's crown
    // gamma fell to beta — but beta's state ALREADY belongs to crown 0 now.
    expect(p.polityOfState(2)).toBe(0);
  });

  it("a union resolution merges whole crowns; awards write nothing", () => {
    const p = createPolities(CITIES3);
    applyResolutions(p, [
      row({ mode: "award", channel: "arbitration" }),
      row({ mode: "political", channel: "union", loser: "gamma", winner: "alpha" }),
    ], siteState);
    expect(p.polityOfState(2)).toBe(0);
    expect(p.unions()).toEqual([{ winner: 0, loser: 2 }]);
  });

  it("rows are append-only: fromIndex is the high-water mark, unknown sites skip", () => {
    const p = createPolities(CITIES3);
    const rows = [row({ loser: "nowhere" })];
    let mark = applyResolutions(p, rows, siteState);
    expect(mark).toBe(1);
    expect(p.version).toBe(0); // unknown site — nothing written
    rows.push(row({ mode: "political", loser: "beta", winner: "alpha", day: 3 }));
    mark = applyResolutions(p, rows, siteState, mark);
    expect(mark).toBe(2);
    expect(p.polityOfState(1)).toBe(0); // only the new row applied
    expect(p.version).toBe(1);
  });
});
