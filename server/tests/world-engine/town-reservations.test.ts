// SPOKEN-FOR ledger + material resolution (reservations.ts, construction
// pipeline ①): units of abstract stock reserved by pending tasks so two
// orders never draw the same wood. Pins the ledger arithmetic (heads, merge,
// consume, release), nearest-first resolution over FREE units (parity with
// planTransferSources on an empty ledger), honest shortfall, serialization
// round-trip, and the TownDeltas carriage.

import { describe, it, expect } from "@jest/globals";
import {
  createReservationLedger,
  freeUnits,
  resolveMaterials,
  type ReservationLedger,
} from "@shared/world-engine/kernel/town/reservations.js";
import {
  planTransferSources,
  type TransferSource,
} from "@shared/world-engine/kernel/town/transfer.js";
import { createTownDeltas } from "@shared/world-engine/kernel/town/construction.js";

const src = (id: string, d: number, stack: Record<string, number>): TransferSource => ({
  id,
  d,
  stack,
});

describe("reservation ledger — arithmetic", () => {
  it("reserves by material HEAD and counts facted stock toward it", () => {
    const led = createReservationLedger();
    led.reserve("task_1", "yard", "wood.wet", 2); // facted cost pays toward wood
    expect(led.reservedUnits("yard", "wood")).toBe(2);
    expect(led.reservedUnits("yard", "wood.wet")).toBe(2); // head-keyed either way
    expect(led.reservedUnits("yard", "stone")).toBe(0);
    expect(led.reservedUnits("crate", "wood")).toBe(0); // per-endpoint
    // Free = stack units (head-matched, facted included) minus spoken-for.
    const stack = { wood: 2, "wood.wet": 3 };
    expect(freeUnits(stack, led, "yard", "wood")).toBe(3);
    expect(freeUnits(stack, led, "crate", "wood")).toBe(5);
  });

  it("merges a holder's repeat reserves into one row; other holders stay separate", () => {
    const led = createReservationLedger();
    led.reserve("task_1", "yard", "wood", 1);
    led.reserve("task_1", "yard", "wood.dry", 2); // same head → same row
    led.reserve("task_2", "yard", "wood", 1);
    expect(led.holderRows("task_1")).toHaveLength(1);
    expect(led.holderRows("task_1")[0]!.qty).toBe(3);
    expect(led.reservedUnits("yard", "wood")).toBe(4);
    expect(led.reserve("task_1", "yard", "wood", 0)).toBeNull(); // qty ≤ 0 no-ops
    expect(led.reservedUnits("yard", "wood")).toBe(4);
  });

  it("consume shrinks the reservation as units leave the stack, clamped, row gone at 0", () => {
    const led = createReservationLedger();
    led.reserve("task_1", "yard", "wood", 3);
    expect(led.consume("task_1", "yard", "wood", 2)).toBe(2);
    expect(led.reservedUnits("yard", "wood")).toBe(1);
    expect(led.consume("task_1", "yard", "wood", 5)).toBe(1); // clamp
    expect(led.holderRows("task_1")).toHaveLength(0);
    expect(led.consume("task_1", "yard", "wood", 1)).toBe(0); // nothing left
  });

  it("release drops only that holder's rows", () => {
    const led = createReservationLedger();
    led.reserve("task_1", "yard", "wood", 2);
    led.reserve("task_1", "crate", "stone", 1);
    led.reserve("task_2", "yard", "wood", 1);
    led.release("task_1");
    expect(led.holderRows("task_1")).toHaveLength(0);
    expect(led.reservedUnits("yard", "wood")).toBe(1);
    expect(led.reservedUnits("crate", "stone")).toBe(0);
  });

  it("a stack that shrank under its reservations reads free 0, never negative", () => {
    const led = createReservationLedger();
    led.reserve("task_1", "yard", "wood", 3);
    expect(freeUnits({ wood: 1 }, led, "yard", "wood")).toBe(0);
  });
});

describe("resolveMaterials — nearest-first over free units", () => {
  it("matches planTransferSources exactly when nothing is reserved", () => {
    const sources = [
      src("crate_b", 5, { wood: 2 }),
      src("crate_a", 5, { wood: 2 }), // distance tie → lexicographic id
      src("yard", 12, { wood: 9 }),
    ];
    const plain = planTransferSources(sources, "wood", 5);
    const led = createReservationLedger();
    const res = resolveMaterials({ holder: "t", costs: { wood: 5 }, sources, ledger: led });
    expect(res.draws.map((d) => ({ id: d.endpoint, take: d.take }))).toEqual(plain.draws);
    expect(res.draws).toEqual([
      { endpoint: "crate_a", glyph: "wood", take: 2 },
      { endpoint: "crate_b", glyph: "wood", take: 2 },
      { endpoint: "yard", glyph: "wood", take: 1 },
    ]);
    expect(res.shortfall).toEqual({});
  });

  it("never draws spoken-for units — the second order walks past them", () => {
    const sources = [src("crate", 3, { wood: 3 }), src("yard", 10, { wood: 4 })];
    const led = createReservationLedger();
    const first = resolveMaterials({ holder: "t1", costs: { wood: 2 }, sources, ledger: led });
    expect(first.draws).toEqual([{ endpoint: "crate", glyph: "wood", take: 2 }]);
    // t2 wants 3: only 1 free in the near crate, the rest comes from the yard.
    const second = resolveMaterials({ holder: "t2", costs: { wood: 3 }, sources, ledger: led });
    expect(second.draws).toEqual([
      { endpoint: "crate", glyph: "wood", take: 1 },
      { endpoint: "yard", glyph: "wood", take: 2 },
    ]);
    expect(led.reservedUnits("crate", "wood")).toBe(3);
    expect(led.reservedUnits("yard", "wood")).toBe(2);
  });

  it("reports honest shortfall and still reserves what it found (the recursion seam)", () => {
    const sources = [src("yard", 4, { wood: 1, stone: 2 })];
    const led = createReservationLedger();
    const res = resolveMaterials({
      holder: "t1",
      costs: { wood: 3, stone: 2 },
      sources,
      ledger: led,
    });
    expect(res.draws).toEqual([
      { endpoint: "yard", glyph: "wood", take: 1 },
      { endpoint: "yard", glyph: "stone", take: 2 },
    ]);
    expect(res.shortfall).toEqual({ wood: 2 });
    // All-or-nothing callers release; the partial reservation must vanish.
    led.release("t1");
    expect(led.reservedUnits("yard", "wood")).toBe(0);
    expect(led.reservedUnits("yard", "stone")).toBe(0);
  });

  it("merges facted costs by head and draws facted stock toward them", () => {
    const sources = [src("yard", 1, { "wood.wet": 2, wood: 1 })];
    const led = createReservationLedger();
    const res = resolveMaterials({
      holder: "t1",
      costs: { "wood.wet": 1, wood: 2 }, // one merged head-need of 3
      sources,
      ledger: led,
    });
    expect(res.draws).toEqual([{ endpoint: "yard", glyph: "wood", take: 3 }]);
    expect(res.shortfall).toEqual({});
  });
});

describe("serialization", () => {
  it("round-trips byte-stable and resumes mid-flight reservations", () => {
    const led = createReservationLedger();
    led.reserve("t1", "yard", "wood", 3);
    led.reserve("t2", "crate", "stone", 1);
    led.consume("t1", "yard", "wood", 1);
    const json = led.toJSON();
    const back = createReservationLedger(json);
    expect(back.toJSON()).toEqual(json);
    expect(JSON.stringify(back.toJSON())).toBe(JSON.stringify(json));
    expect(back.reservedUnits("yard", "wood")).toBe(2);
    // Fresh rows after reload keep unique ids (serial persisted).
    const fresh = back.reserve("t3", "yard", "wood", 1)!;
    expect(led.holderRows("t1")[0]!.id).not.toBe(fresh.id);
  });

  it("rides the TownDeltas store", () => {
    const deltas = createTownDeltas();
    deltas.reservations.reserve("t1", "yard", "wood", 2);
    const reloaded = createTownDeltas(deltas.toJSON());
    expect(reloaded.reservations.reservedUnits("yard", "wood")).toBe(2);
    expect(reloaded.reservations.toJSON()).toEqual(deltas.reservations.toJSON());
  });
});
