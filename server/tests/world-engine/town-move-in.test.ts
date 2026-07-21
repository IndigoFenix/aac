// RESIDENT MOVE-IN (city-expansion ④ scope 1) at the pure layer — the exact
// pieces quest-host wires: a completed founded HOUSE admits a household when
// food is not scarce (population.ts moveInStep — deterministic, famine
// blocks, oldest-first, one per tick), the admission is a SERIALIZED FACT
// (TownDeltas.admitHousehold, toJSON round-trip), and materialization deals
// a real plan.houses row instead of the ①b empty work row — on the live
// conversion and on every rebuild (applyFoundedBuildings / buildTownPlay).
// No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  createTownDeltas,
  type FoundingCandidate,
  type TownDeltas,
} from "@shared/world-engine/kernel/town/construction.js";
import {
  MOVE_IN_FOOD_SHORTAGE_MAX,
  moveInStep,
} from "@shared/world-engine/kernel/town/population.js";
import type { TownGrowthSignals } from "@shared/world-engine/kernel/town/zoning.js";
import {
  applyFoundedBuildings,
  buildTownPlay,
  foundedHouseRow,
  TOWN_PLAY_STRUCTURES,
  type TownPlayConfig,
} from "@shared/world-engine/interaction/town/town-play.js";
import type { TownPlan } from "@shared/world-engine/kernel/town/plan.js";

const HOUSE_SPEC = TOWN_PLAY_STRUCTURES.find((s) => s.type === "house")!;
const FARM_SPEC = TOWN_PLAY_STRUCTURES.find((s) => s.type === "farm")!;

const houseCandidate = (slot: number): FoundingCandidate => ({
  type: "house",
  slot,
  dx: 6 + slot * 14,
  dy: -4,
  w: HOUSE_SPEC.footprint.w,
  h: HOUSE_SPEC.footprint.d,
  door: "south",
});

const signals = (foodShortage: number): TownGrowthSignals => ({
  crowding: 0,
  shortage: (good) => (good === "food" ? foodShortage : 0),
});

/** A founded house, completed, in a fresh store. */
function deltasWithHouses(n: number, complete = true): TownDeltas {
  const deltas = createTownDeltas();
  for (let i = 0; i < n; i++) {
    const b = deltas.foundBuilding(houseCandidate(i), 0, 1);
    if (complete) deltas.completeFounding(b.ord);
  }
  return deltas;
}

describe("moveInStep — the immigration rule", () => {
  it("admits a household into a finished empty house on surplus", () => {
    const deltas = deltasWithHouses(1);
    const admitted = moveInStep({ deltas, catalog: TOWN_PLAY_STRUCTURES, signals: signals(0) });
    expect(admitted?.ord).toBe(0);
    expect(deltas.founded()[0]!.household).toBe(true);
  });

  it("does NOT admit during famine (food shortage past the gate)", () => {
    const deltas = deltasWithHouses(1);
    const admitted = moveInStep({
      deltas,
      catalog: TOWN_PLAY_STRUCTURES,
      signals: signals(MOVE_IN_FOOD_SHORTAGE_MAX + 0.01),
    });
    expect(admitted).toBeNull();
    expect(deltas.founded()[0]!.household).toBeUndefined();
  });

  it("admits AT the gate boundary (shortage == max is still livable)", () => {
    const deltas = deltasWithHouses(1);
    expect(
      moveInStep({
        deltas,
        catalog: TOWN_PLAY_STRUCTURES,
        signals: signals(MOVE_IN_FOOD_SHORTAGE_MAX),
      }),
    ).not.toBeNull();
  });

  it("never admits into an unfinished house", () => {
    const deltas = deltasWithHouses(1, false);
    expect(moveInStep({ deltas, catalog: TOWN_PLAY_STRUCTURES, signals: signals(0) })).toBeNull();
  });

  it("never admits into a work-role structure", () => {
    const deltas = createTownDeltas();
    const b = deltas.foundBuilding(
      { type: "farm", slot: 0, dx: 6, dy: -4, w: FARM_SPEC.footprint.w, h: FARM_SPEC.footprint.d, door: "south" },
      0,
      1,
    );
    deltas.completeFounding(b.ord);
    expect(moveInStep({ deltas, catalog: TOWN_PLAY_STRUCTURES, signals: signals(0) })).toBeNull();
  });

  it("is oldest-first and one household per tick (a trickle, not a flood)", () => {
    const deltas = deltasWithHouses(2);
    const first = moveInStep({ deltas, catalog: TOWN_PLAY_STRUCTURES, signals: signals(0) });
    expect(first?.ord).toBe(0);
    expect(deltas.founded()[1]!.household).toBeUndefined();
    const second = moveInStep({ deltas, catalog: TOWN_PLAY_STRUCTURES, signals: signals(0) });
    expect(second?.ord).toBe(1);
    // Every house full — nothing left to admit.
    expect(moveInStep({ deltas, catalog: TOWN_PLAY_STRUCTURES, signals: signals(0) })).toBeNull();
  });

  it("is deterministic — same store, same signals, same admission", () => {
    const run = () => {
      const deltas = deltasWithHouses(3);
      moveInStep({ deltas, catalog: TOWN_PLAY_STRUCTURES, signals: signals(0.1) });
      return deltas.toJSON();
    };
    expect(run()).toEqual(run());
  });
});

describe("the household fact — serialization", () => {
  it("admitHousehold is idempotent and bumps the version once", () => {
    const deltas = deltasWithHouses(1);
    const v = deltas.version;
    deltas.admitHousehold(0);
    expect(deltas.version).toBe(v + 1);
    deltas.admitHousehold(0);
    expect(deltas.version).toBe(v + 1);
  });

  it("rides toJSON → createTownDeltas round-trip", () => {
    const deltas = deltasWithHouses(1);
    deltas.admitHousehold(0);
    const revived = createTownDeltas(deltas.toJSON());
    expect(revived.founded()[0]!.household).toBe(true);
    expect(revived.toJSON()).toEqual(deltas.toJSON());
  });
});

describe("materialization — the plan row", () => {
  const bare = (): TownPlan =>
    ({ houses: [], works: [], radius: 30 }) as unknown as TownPlan;

  it("an EMPTY founded house stays a work row (the ①b behavior)", () => {
    const deltas = deltasWithHouses(1);
    const plan = bare();
    applyFoundedBuildings(plan, deltas.founded(), TOWN_PLAY_STRUCTURES);
    expect(plan.works).toHaveLength(1);
    expect(plan.works[0]!.type).toBe("house");
    expect(plan.houses).toHaveLength(0);
  });

  it("a HOUSEHOLDED founded house becomes a real plan.houses row", () => {
    const deltas = deltasWithHouses(1);
    deltas.admitHousehold(0);
    const plan = bare();
    applyFoundedBuildings(plan, deltas.founded(), TOWN_PLAY_STRUCTURES);
    expect(plan.works).toHaveLength(0);
    expect(plan.houses).toHaveLength(1);
    const b = deltas.founded()[0]!;
    expect(plan.houses[0]).toMatchObject({
      index: 0, slot: b.slot, dx: b.dx, dy: b.dy, w: b.w, h: b.h, door: b.door, floors: 1,
    });
  });

  it("foundedHouseRow indexes max+1, never colliding past base-index gaps", () => {
    const plan = { houses: [{ index: 0 }, { index: 4 }] } as unknown as TownPlan;
    const deltas = deltasWithHouses(1);
    const row = foundedHouseRow(plan, deltas.founded()[0]!, HOUSE_SPEC);
    expect(row.index).toBe(5);
  });

  it("buildTownPlay raises the household on rebuild (zero-pop founded site)", () => {
    const deltas = deltasWithHouses(2);
    deltas.admitHousehold(0); // house 0 filled; house 1 still empty
    const config: TownPlayConfig = {
      seed: 77, days: 5, questCount: 0, key: "outpost", startPop: 0,
      deltas: deltas.toJSON(),
    };
    const play = buildTownPlay(config);
    // The householded founding is a HOUSE; the empty one stays a work row.
    expect(play.plan.houses).toHaveLength(1);
    expect(play.plan.houses[0]!.slot).toBe(0);
    expect(play.plan.works.filter((w) => w.type === "house")).toHaveLength(1);
    expect(play.plan.works.find((w) => w.type === "house")!.foundedOrd).toBe(1);
    // Deterministic: the same config builds the same town again.
    const again = buildTownPlay(config);
    expect(again.plan.houses).toEqual(play.plan.houses);
  });
});
