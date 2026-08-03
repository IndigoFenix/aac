/**
 * THE UNIVERSAL SHAPE (kernel/town/scope-shape.ts) — step ③ of
 * scope-unification.md: the organs, and the body's binding of them.
 *
 * The load-bearing rule under test is the ACTIVE BAG: a body routes stack
 * operations to exactly ONE container at a time, because StockEndpoint.stack
 * must alias a live map and a merged view could never be one. Everything
 * else here is arithmetic consequences of that rule.
 *
 * No DOM / GL / session.
 */
import { describe, it, expect } from "@jest/globals";
import {
  activeBag,
  bodyCarryView,
  costTotalS,
  handsFree,
  stackRoom,
  sumContainerStacks,
  type BagRef,
  type BodyCarry,
} from "@shared/world-engine/kernel/town/scope-shape.js";
import { PORTABLE_CONTAINERS } from "@shared/world-engine/kernel/town/containers.js";

const bag = (objId: string, glyph: "basket" | "satchel", stock: Record<string, number>): BagRef => ({
  objId,
  glyph,
  stock,
  capacity: PORTABLE_CONTAINERS[glyph].capacity,
});

const EMPTY: BodyCarry = { inHand: null, worn: null };

describe("the active bag — one writable stack at a time", () => {
  it("a carried basket wins over a worn satchel", () => {
    const basket = bag("small:b1", "basket", {});
    const satchel = bag("small:s1", "satchel", {});
    const carry: BodyCarry = {
      inHand: { objId: basket.objId, glyph: "basket", bag: basket },
      worn: satchel,
    };
    expect(activeBag(carry)).toBe(basket);
  });

  it("a worn satchel alone is the bag; nothing at all is null", () => {
    const satchel = bag("small:s1", "satchel", {});
    expect(activeBag({ inHand: null, worn: satchel })).toBe(satchel);
    expect(activeBag(EMPTY)).toBeNull();
  });

  it("🚨 THE ALIAS LAW — the bag's stock IS the map handed in, never a copy", () => {
    // Every stack mutation in the engine writes through StockEndpoint.stack
    // as an alias. If this ever returns a copy, units written to the body
    // vanish from the container — the water-in-the-barrel bug, relived.
    const stock = { apple: 2 };
    const satchel = bag("small:s1", "satchel", stock);
    expect(activeBag({ inHand: null, worn: satchel })!.stock).toBe(stock);
  });

  it("a plain object in hand is NOT a bag", () => {
    const carry: BodyCarry = { inHand: { objId: "small:a1", glyph: "apple" }, worn: null };
    expect(activeBag(carry)).toBeNull();
  });
});

describe("hands and room", () => {
  it("empty hands are free; anything in them is not", () => {
    expect(handsFree(EMPTY)).toBe(true);
    expect(handsFree({ inHand: { objId: "small:a1", glyph: "apple" }, worn: null })).toBe(false);
  });

  it("no bag → one unit through the one door, and only with free hands", () => {
    // The number that makes "bring a basket to market" a decision: without
    // one, every trip moves a single unit as a real instance.
    expect(stackRoom(EMPTY)).toBe(1);
    expect(stackRoom({ inHand: { objId: "small:a1", glyph: "apple" }, worn: null })).toBe(0);
  });

  it("with a bag, room is the bag's remaining capacity", () => {
    const basket = bag("small:b1", "basket", { apple: 3 });
    const carry: BodyCarry = { inHand: { objId: basket.objId, glyph: "basket", bag: basket }, worn: null };
    expect(stackRoom(carry)).toBe(PORTABLE_CONTAINERS.basket.capacity - 3);
  });

  it("an over-full bag reports zero, never negative", () => {
    const satchel = bag("small:s1", "satchel", { rock: 99 });
    expect(stackRoom({ inHand: null, worn: satchel })).toBe(0);
  });

  it("the worn satchel leaves the hands free — that is the whole point of it", () => {
    const satchel = bag("small:s1", "satchel", {});
    const carry: BodyCarry = { inHand: null, worn: satchel };
    expect(handsFree(carry)).toBe(true);
    expect(stackRoom(carry)).toBe(PORTABLE_CONTAINERS.satchel.capacity);
  });
});

describe("the fold — inventory is the sum of the containers", () => {
  it("merges stacks and drops empty tallies", () => {
    expect(sumContainerStacks([{ apple: 2, water: 0 }, { apple: 1, bread: 3 }, {}])).toEqual({
      apple: 3,
      bread: 3,
    });
  });

  it("the merged view is a copy — mutating it touches no container", () => {
    const a = { apple: 2 };
    const view = sumContainerStacks([a]);
    view["apple"] = 99;
    expect(a["apple"]).toBe(2);
  });

  it("bodyCarryView shows the hands instance as one unit and the bags' goods", () => {
    const satchel = bag("small:s1", "satchel", { bread: 2 });
    const carry: BodyCarry = { inHand: { objId: "small:a1", glyph: "apple" }, worn: satchel };
    expect(bodyCarryView(carry)).toEqual({ apple: 1, bread: 2 });
  });

  it("a held BAG is the shelf, not the goods — its contents show, it does not", () => {
    const basket = bag("small:b1", "basket", { apple: 3 });
    const carry: BodyCarry = { inHand: { objId: basket.objId, glyph: "basket", bag: basket }, worn: null };
    expect(bodyCarryView(carry)).toEqual({ apple: 3 });
  });

  it("empty-handed is an empty view", () => {
    expect(bodyCarryView(EMPTY)).toEqual({});
  });
});

describe("the cost shape", () => {
  it("totals its four terms — the seat step ④ fills", () => {
    expect(costTotalS({ journeyS: 10, handsS: 4, spoilageS: 1, forgoneS: 5 })).toBe(20);
  });
});
