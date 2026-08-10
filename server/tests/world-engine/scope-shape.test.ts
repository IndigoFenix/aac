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
  allocateHands,
  bodyCarryView,
  costTotalS,
  handsFree,
  stackRoom,
  sumContainerStacks,
  townHandPool,
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

// ─────────────────────────────────────────────────────────────────────────
// ScopeHands — the organ that was declared and never produced (economy arc
// batch 2, L3/L4). `§3.2 … a town's labour pool` is now a reading and a
// conserving split, and this is where they are pinned.
// ─────────────────────────────────────────────────────────────────────────

describe("townHandPool — the town's hands, counted off the roster's own rows", () => {
  it("total is employable minus the schedules that already own bodies", () => {
    // 20 houses × 4 souls, 2 shop duties each (the goods clock owns those),
    // 6 members inside a shift window right now.
    const h = townHandPool({ employable: 80, shopDuty: 40, onShift: 6, committed: 0 });
    expect(h.total).toBe(34);
    expect(h.free).toBe(34);
  });

  it("free subtracts the bodies a claim or a live need has taken over", () => {
    const h = townHandPool({ employable: 80, shopDuty: 40, onShift: 6, committed: 9 });
    expect(h.total).toBe(34); // the town still HAS them, they are just spoken for
    expect(h.free).toBe(25);
  });

  it("never goes negative — an over-committed town reads zero, not a debt", () => {
    expect(townHandPool({ employable: 4, shopDuty: 4, onShift: 4, committed: 4 })).toEqual({
      total: 0,
      free: 0,
    });
  });
});

describe("allocateHands — one pool, N sites, conserved exactly", () => {
  it("hands to spare ⇒ every claim gets its full cap (the byte-identity arm)", () => {
    // THE ACCEPTANCE CASE of L4: one site, a normal town. It still fields 3.
    expect(allocateHands([3], 20)).toEqual([3]);
    expect(allocateHands([3, 3, 3], 20)).toEqual([3, 3, 3]);
  });

  it("a pool smaller than the demand is SHARED, never minted per site", () => {
    // Ten sites out of a twelve-hand town: the free lunch, closed. Σ = 12,
    // not 30 — and no site is starved to zero by being late in the order.
    const out = allocateHands([3, 3, 3, 3, 3, 3, 3, 3, 3, 3], 12);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(12, 9);
    expect(out.every((n) => n >= 1.2 - 1e-9)).toBe(true);
    expect(Math.max(...out)).toBeLessThanOrEqual(3);
  });

  it("caps below the even share release their slack down the order", () => {
    // A mill bench takes ONE hand however many volunteer (REFINE_CREW_CAP);
    // the two building sites split what it did not want, earliest first.
    expect(allocateHands([1, 3, 3], 6)).toEqual([1, 3, 2]);
  });

  it("conserves exactly and stays deterministic", () => {
    for (const free of [0, 1, 2.5, 7, 100]) {
      const caps = [3, 1, 3, 2];
      const out = allocateHands(caps, free);
      const demand = caps.reduce((a, b) => a + b, 0);
      expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(Math.min(free, demand), 9);
      expect(allocateHands(caps, free)).toEqual(out); // pure
    }
    expect(allocateHands([], 5)).toEqual([]);
  });
});
