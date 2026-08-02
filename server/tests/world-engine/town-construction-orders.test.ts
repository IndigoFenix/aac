// ONE CONSTRUCTION ORDER (rewrite phase 2 — construction-phase2-plan.md
// step 2): founded buildings, ordered rooms and demolitions live in ONE
// persisted list with ONE town-wide ordinal sequence; the kind-scoped reads
// (founded / annexSites / demolitionSites) are filtered views of it. A
// pre-phase-2 save (the legacy trio) adapts in at load with founding
// ordinals preserved (f_<ord> keys are immortal) and old per-kind ordinals
// remembered (`legacyOrd` — in-flight `annexpile:` agreements resolve).
// No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  bankLabor,
  createTownDeltas,
  demolitionLaborDone,
  demolitionStage,
  foundedBuildingDone,
  foundedStage,
  foundingOptions,
  orderDone,
  orderStage,
  pendingAnnexStage,
  pendingLaborDone,
  type ConstructionOrder,
  type FoundedBuilding,
  type PendingAnnex,
  type PendingDemolition,
  type SerializedTownDeltas,
} from "@shared/world-engine/kernel/town/construction.js";
import { resolveStructure } from "@shared/world-engine/kernel/town/structures.js";
import { TOWN_PLAY_STRUCTURES } from "@shared/world-engine/interaction/town/town-play.js";
import { putStock } from "@shared/world-engine/kernel/town/transfer.js";

const SEED = 21;
const KEY = "millbrook";
const HOUSE = resolveStructure(TOWN_PLAY_STRUCTURES, "house")!;

function lot() {
  return foundingOptions({
    seed: SEED, key: KEY, footprint: HOUSE.footprint, type: HOUSE.type,
    occupied: [], claimedSlots: new Set(),
  })[0]!;
}

const ANNEX_CANDIDATE = {
  side: "rear" as const,
  cluster: "sleep" as const,
  u0: 0, u1: 3.2, v0: 6, v1: 9,
  doorInto: "r0",
  doorAt: { u: 1.6, v: 6, width: 0.9 },
};

const INTERIOR_CANDIDATE = {
  hostId: "r0",
  kind: "bedroom" as const,
  u0: 0, u1: 2.5, v0: 0, v1: 2.5,
  doorAt: { u: 2.5, v: 1.2, width: 0.9 },
};

/** A synthesized PRE-phase-2 save carrying all three legacy row families. */
function legacySave(): SerializedTownDeltas {
  const founded: FoundedBuilding[] = [
    {
      ord: 0, type: "house", slot: 2, dx: 10, dy: -4, w: 7, h: 6, door: "south",
      startedDay: 1, buildDays: 2, completed: true,
    },
    {
      ord: 3, type: "farm", slot: 5, dx: -18, dy: 8, w: 9, h: 7, door: "north",
      startedDay: 4, buildDays: 3, costs: { wood: 4 }, pile: { wood: 1 },
    },
  ];
  const annexSites: PendingAnnex[] = [
    {
      ord: 0, buildingKey: "h_2", cluster: "sleep", candidate: ANNEX_CANDIDATE,
      costs: { wood: 2 }, pile: { wood: 2 }, startedDay: 5, buildDays: 0.5,
      laborStartDay: 6, labor: 0.2,
    },
    {
      ord: 1, buildingKey: "h_4", candidate: INTERIOR_CANDIDATE,
      costs: { wood: 2 }, pile: {}, startedDay: 6, buildDays: 0.5,
    },
  ];
  const demolitionSites: PendingDemolition[] = [
    { ord: 0, buildingKey: "h_2", roomId: "r1", startedDay: 7, buildDays: 0.25, labor: 0.1 },
  ];
  return { version: 41, buildings: {}, founded, annexSites, demolitionSites };
}

describe("the one order list (phase 2)", () => {
  it("mints ONE town-wide monotone ordinal sequence across every kind", () => {
    const deltas = createTownDeltas();
    const a = deltas.foundBuilding(lot(), 0, 2, { wood: 3 });
    const b = deltas.postAnnexSite({
      buildingKey: "h_1", cluster: "sleep", candidate: ANNEX_CANDIDATE,
      costs: { wood: 2 }, pile: {}, startedDay: 0, buildDays: 0.5,
    });
    const c = deltas.postDemolitionSite({
      buildingKey: "h_1", roomId: "r2", startedDay: 0, buildDays: 0.25,
    });
    const d = deltas.foundBuilding(lot(), 1, 2, { wood: 3 });
    expect([a.ord, b.ord, c.ord, d.ord]).toEqual([0, 1, 2, 3]);
    expect(deltas.orders().map((o) => o.kind)).toEqual(["found", "annex", "demolish", "found"]);
    // The kind tag follows the candidate: an interior cut is its own kind.
    const e = deltas.postAnnexSite({
      buildingKey: "h_2", candidate: INTERIOR_CANDIDATE,
      costs: { wood: 2 }, pile: {}, startedDay: 0, buildDays: 0.5,
    });
    expect(deltas.orders().find((o) => o.ord === e.ord)?.kind).toBe("interior");
  });

  it("the kind-scoped reads are LIVE views — mutation through them is mutation of the list", () => {
    const deltas = createTownDeltas();
    deltas.foundBuilding(lot(), 0, 2, { wood: 1 });
    deltas.postDemolitionSite({ buildingKey: "h_0", roomId: "r1", startedDay: 0, buildDays: 0.25 });
    const b = deltas.founded()[0]!;
    putStock({ stack: b.pile! }, { wood: 1 });
    bankLabor(b, 0.5);
    const o = deltas.orders().find((q) => q.kind === "found")!;
    expect(o).toBe(b); // the very same row, not a copy
    expect(deltas.demolitionSites()).toHaveLength(1);
    expect(deltas.annexSites()).toHaveLength(0);
  });

  it("removal APIs are kind-blind underneath — one remove, views follow", () => {
    const deltas = createTownDeltas();
    const p = deltas.postAnnexSite({
      buildingKey: "h_1", cluster: "sleep", candidate: ANNEX_CANDIDATE,
      costs: { wood: 2 }, pile: {}, startedDay: 0, buildDays: 0.5,
    });
    const dm = deltas.postDemolitionSite({
      buildingKey: "h_1", roomId: "r2", startedDay: 0, buildDays: 0.25,
    });
    deltas.removeAnnexSite(p.ord);
    expect(deltas.annexSites()).toHaveLength(0);
    expect(deltas.orders().map((o) => o.ord)).toEqual([dm.ord]);
    deltas.removeOrder(dm.ord);
    expect(deltas.orders()).toHaveLength(0);
  });

  it("cancelFounding refunds the pile and drops the row; a completed row refuses", () => {
    const deltas = createTownDeltas();
    const b = deltas.foundBuilding(lot(), 0, 2, { wood: 3 });
    putStock({ stack: b.pile! }, { wood: 2 });
    expect(deltas.cancelFounding(b.ord)).toEqual({ wood: 2 });
    expect(deltas.orders()).toHaveLength(0);
    const done = deltas.foundBuilding(lot(), 0, 1, { wood: 1 });
    deltas.stageOrder(done.ord, 0);
    deltas.completeFounding(done.ord);
    expect(deltas.cancelFounding(done.ord)).toBeNull();
  });
});

describe("the legacy-save adapter (pre-phase-2 → orders)", () => {
  it("adapts the trio into one list — founding ords preserved, others renumbered with legacyOrd", () => {
    const deltas = createTownDeltas(legacySave());
    const ords = deltas.orders().map((o) => o.ord);
    expect(new Set(ords).size).toBe(ords.length); // one sequence, unique
    // Founding ordinals are IMMORTAL — 0 and 3 survive verbatim.
    expect(deltas.founded().map((b) => b.ord)).toEqual([0, 3]);
    // Room/demolition rows renumber ABOVE the founding ords and remember
    // their old per-kind ordinal (the annexpile:<old> resolution seam).
    const rooms = deltas.annexSites() as Array<PendingAnnex & { legacyOrd?: number }>;
    expect(rooms.map((p) => p.legacyOrd)).toEqual([0, 1]);
    expect(Math.min(...rooms.map((p) => p.ord))).toBeGreaterThan(3);
    const dem = deltas.demolitionSites() as Array<PendingDemolition & { legacyOrd?: number }>;
    expect(dem[0]!.legacyOrd).toBe(0);
    // The interior candidate adapts to its own kind.
    expect(deltas.orders().filter((o) => o.kind === "interior")).toHaveLength(1);
    expect(deltas.orders().filter((o) => o.kind === "annex")).toHaveLength(1);
  });

  it("adapts BEHAVIOR-identically: stage state, banked labor, piles all survive", () => {
    const deltas = createTownDeltas(legacySave());
    const [h, farm] = deltas.founded();
    expect(h!.completed).toBe(true);
    expect(farm!.pile).toEqual({ wood: 1 });
    expect(farm!.laborStartDay).toBeUndefined();
    const annex = deltas.annexSites().find((p) => p.cluster === "sleep")!;
    expect(annex.laborStartDay).toBe(6);
    expect(annex.labor).toBe(0.2);
    expect(pendingLaborDone(annex)).toBe(false);
    expect(demolitionLaborDone(deltas.demolitionSites()[0]!)).toBe(false);
  });

  it("round-trips: the save writes ONLY `orders`, and a reload is byte-stable", () => {
    const first = createTownDeltas(legacySave()).toJSON();
    expect(first.orders).toBeDefined();
    expect(first.founded).toBeUndefined();
    expect(first.annexSites).toBeUndefined();
    expect(first.demolitionSites).toBeUndefined();
    const second = createTownDeltas(first).toJSON();
    expect(second.orders).toEqual(first.orders);
  });

  it("new rows mint ords past every adapted row — no collision with legacy numbering", () => {
    const deltas = createTownDeltas(legacySave());
    const top = Math.max(...deltas.orders().map((o) => o.ord));
    const p = deltas.postAnnexSite({
      buildingKey: "h_9", cluster: "kitchen", candidate: ANNEX_CANDIDATE,
      costs: { wood: 2 }, pile: {}, startedDay: 8, buildDays: 0.5,
    });
    expect(p.ord).toBe(top + 1);
  });
});

describe("orderStage / orderDone — the one ladder over every kind", () => {
  it("matches the per-kind projections across the whole lifecycle", () => {
    const deltas = createTownDeltas(legacySave());
    for (const o of deltas.orders() as ConstructionOrder[]) {
      for (const day of [0, 5, 6.5, 100]) {
        switch (o.kind) {
          case "found":
            expect(orderStage(o, day)).toBe(foundedStage(o, day));
            expect(orderDone(o, day)).toBe(foundedBuildingDone(o, day));
            break;
          case "annex":
          case "interior":
            expect(orderStage(o, day)).toBe(pendingAnnexStage(o));
            expect(orderDone(o, day)).toBe(pendingLaborDone(o));
            break;
          case "demolish":
            expect(orderStage(o, day)).toBe(demolitionStage(o));
            expect(orderDone(o, day)).toBe(demolitionLaborDone(o));
            break;
        }
      }
    }
  });

  it("walks a room order up the ladder as labor banks — and demolition down it", () => {
    const deltas = createTownDeltas();
    const p = deltas.postAnnexSite({
      buildingKey: "h_1", cluster: "sleep", candidate: ANNEX_CANDIDATE,
      costs: { wood: 2 }, pile: { wood: 2 }, startedDay: 0, buildDays: 1,
    });
    const row = deltas.orders()[0]!;
    expect(orderStage(row, 0)).toBe(0); // marked ground — unstaged
    deltas.stageOrder(p.ord, 1);
    expect(orderStage(row, 1)).toBe(1); // floor at first worked moment
    bankLabor(p, 0.6);
    expect(orderStage(row, 1)).toBe(2); // pillars past the halfway mark
    bankLabor(p, 0.4);
    expect(orderStage(row, 1)).toBe(3);
    expect(orderDone(row, 1)).toBe(true);
    const d = deltas.postDemolitionSite({
      buildingKey: "h_1", roomId: "r2", startedDay: 0, buildDays: 1,
    });
    const drow = deltas.orders().find((o) => o.ord === d.ord)!;
    expect(orderStage(drow, 0)).toBe(3); // walls stand until work begins
    bankLabor(d, 0.5);
    expect(orderStage(drow, 0)).toBe(2);
    bankLabor(d, 0.5);
    expect(orderStage(drow, 0)).toBe(0); // gone — the row commits
    expect(orderDone(drow, 0)).toBe(true);
  });

  it("an ADOPTED no-cost row (staged, step 3) is labor-driven; an unadopted one keeps its clock", () => {
    const deltas = createTownDeltas();
    // Unadopted: the pre-pipeline pure clock, byte-identical (worldgen
    // twins and driver-less sessions).
    const legacy = deltas.foundBuilding(lot(), 3, 2);
    expect(foundedBuildingDone(legacy, 4.9)).toBe(false);
    expect(foundedBuildingDone(legacy, 5.01)).toBe(true);
    expect(foundedStage(legacy, 3.5)).toBe(1); // a quarter in — floor laid
    expect(foundedStage(legacy, 4)).toBe(2); // half in — pillars
    // Adopted: the driver stages it and banks where the clock stood — from
    // then on ONLY labor moves it (nothing may be its own clock).
    const adopted = deltas.foundBuilding(lot(), 3, 2);
    deltas.stageOrder(adopted.ord, 4);
    bankLabor(adopted, 1); // the elapsed half, banked at adoption
    expect(foundedStage(adopted, 4)).toBe(2); // pillars at the banked fraction
    expect(foundedBuildingDone(adopted, 1_000_000)).toBe(false); // clock alone: never
    bankLabor(adopted, 1);
    expect(foundedBuildingDone(adopted, 4)).toBe(true);
  });

  it("stageOrder is idempotent and refuses demolitions (nothing to stage)", () => {
    const deltas = createTownDeltas();
    const b = deltas.foundBuilding(lot(), 0, 2, { wood: 1 });
    deltas.stageOrder(b.ord, 4);
    deltas.stageOrder(b.ord, 9);
    expect(b.laborStartDay).toBe(4);
    const d = deltas.postDemolitionSite({
      buildingKey: "h_1", roomId: "r2", startedDay: 0, buildDays: 0.25,
    });
    deltas.stageOrder(d.ord, 4);
    expect((deltas.orders().find((o) => o.ord === d.ord) as PendingDemolition & { laborStartDay?: number }).laborStartDay).toBeUndefined();
  });
});
