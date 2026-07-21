// THE POLITY LEDGER (nations P1) — the mutation layer over the derived
// cost-Voronoi states: founding = every state its own city-state; merge and
// cession are RELABELS (never geometry); the union ledger is append-only;
// borders filter to polity-different pairs; toJSON round-trips. Pure — the
// PlanetStates here is hand-made, no planet bake.

import { describe, it, expect } from "@jest/globals";
import {
  createPolities, claimReader, polityColor,
  type SerializedPolities,
} from "@shared/world-engine/planet/polities.js";
import type { PlanetStates } from "@shared/world-engine/planet/states.js";
import type { PlanetCity } from "@shared/world-engine/planet/cities.js";

/** Three capitals on a six-cell strip: cells 0,1 → state 0; 2,3 → state 1;
 *  4 → state 2; 5 unclaimed sea. Borders at (1,2) and (3,4). */
const CITIES: PlanetCity[] = [
  { cell: 0, name: "Alster", dir: [1, 0, 0], density: 100, charter: { farmland: 60, ore_access: 0, timberland: 0 }, startPop: 50 },
  { cell: 2, name: "Borhold", dir: [0, 1, 0], density: 90, charter: { farmland: 50, ore_access: 5, timberland: 0 }, startPop: 40 },
  { cell: 4, name: "Corvell", dir: [0, 0, 1], density: 80, charter: { farmland: 40, ore_access: 9, timberland: 2 }, startPop: 30 },
];
const STATES: PlanetStates = {
  stateOf: Int32Array.from([0, 0, 1, 1, 2, -1]),
  costM: Float64Array.from([0, 1, 0, 1, 0, Infinity]),
  adjacency: [
    { a: 0, b: 1, costM: 1000 },
    { a: 1, b: 2, costM: 1200 },
  ],
  borderCells: [[1, 2], [3, 4]],
};

describe("founding — a planet of city-states", () => {
  const p = createPolities(CITIES);

  it("one polity per state, named for its capital, deterministic colors", () => {
    expect(p.rows().map(r => r.name)).toEqual(["Alster", "Borhold", "Corvell"]);
    expect(p.rows().map(r => r.id)).toEqual([0, 1, 2]);
    expect(p.rows().map(r => r.color)).toEqual([polityColor(0), polityColor(1), polityColor(2)]);
    expect(p.polityOfState(0)).toBe(0);
    expect(p.polityOfState(2)).toBe(2);
    expect(p.polityOfState(99)).toBe(-1);
  });

  it("claimReader maps cells through the derived states (-1 for sea)", () => {
    const claim = claimReader(p, STATES);
    expect([0, 1, 2, 3, 4, 5].map(claim)).toEqual([0, 0, 1, 1, 2, -1]);
  });

  it("every state border is a polity border at founding", () => {
    expect(p.claimBorderCells(STATES)).toEqual(STATES.borderCells);
  });
});

describe("merge — a relabel, never new geometry", () => {
  it("moves the loser's whole holding, records the union, erases the internal border", () => {
    const p = createPolities(CITIES);
    expect(p.merge(0, 1)).toBe(true);
    expect(p.polityOfState(1)).toBe(0);
    expect(p.statesOf(0)).toEqual([0, 1]);
    expect(p.statesOf(1)).toEqual([]);
    expect(p.living().map(r => r.id)).toEqual([0, 2]);
    expect(p.unions()).toEqual([{ winner: 0, loser: 1 }]);
    // The (1,2) cell border was state 0|state 1 — same crown now, no ink;
    // the (3,4) border to Corvell stands.
    expect(p.claimBorderCells(STATES)).toEqual([[3, 4]]);
    expect(p.version).toBe(1);
  });

  it("refuses self-merges, unknown ids, and landless losers", () => {
    const p = createPolities(CITIES);
    expect(p.merge(0, 0)).toBe(false);
    expect(p.merge(0, 99)).toBe(false);
    p.merge(0, 1);
    expect(p.merge(2, 1)).toBe(false); // 1 already landless
    expect(p.unions()).toHaveLength(1);
  });
});

describe("cession — the single-state relabel", () => {
  it("moves one state and leaves the rest", () => {
    const p = createPolities(CITIES);
    expect(p.cede(1, 2)).toBe(true);
    expect(p.statesOf(2)).toEqual([1, 2]);
    expect(p.statesOf(0)).toEqual([0]);
    expect(p.cede(1, 2)).toBe(false); // already theirs
    expect(p.cede(9, 2)).toBe(false);
    expect(p.cede(0, 99)).toBe(false);
  });
});

describe("serialization — the mutation-layer transport", () => {
  it("round-trips relabels + unions exactly, deep-copied", () => {
    const p = createPolities(CITIES);
    p.merge(2, 0);
    p.cede(2, 2); // no-op (already 2's)? state 2 belongs to polity 2 — false
    p.cede(3, 2); // unknown state (only 3 states) — false
    const json = JSON.parse(JSON.stringify(p.toJSON())) as SerializedPolities;
    const revived = createPolities(CITIES, json);
    expect(revived.toJSON()).toEqual(p.toJSON());
    expect(revived.polityOfState(0)).toBe(2);
    expect(revived.unions()).toEqual([{ winner: 2, loser: 0 }]);
    // Mutating the revived store never touches the source JSON.
    revived.merge(2, 1);
    expect(json.unions).toHaveLength(1);
  });

  it("a save trailing the city list founds the missing city-states prefix-stably", () => {
    const p = createPolities(CITIES.slice(0, 2));
    p.merge(1, 0);
    const grown = createPolities(CITIES, p.toJSON());
    expect(grown.rows().map(r => r.name)).toEqual(["Alster", "Borhold", "Corvell"]);
    expect(grown.polityOfState(0)).toBe(1); // the old union survives
    expect(grown.polityOfState(2)).toBe(2); // the newcomer is its own crown
  });
});
