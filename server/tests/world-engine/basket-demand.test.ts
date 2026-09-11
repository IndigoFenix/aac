/**
 * 🧺 BASKETS MAKEABLE — THE RECIPE, AND THE DEMAND THAT ASKS FOR ONE.
 *
 * User ruling, 2026-09-09, verbatim: *"making baskets makeable would be a
 * better solution"* — chosen over shipping a bigger founding kit, because the
 * ⚖️ rider law says FOUNDERS CARRY WHAT THE SPEC SAYS AND NOTHING ELSE.
 *
 * 🚨 THE MEASURED COMPLAINT (plant-growth-render-round.md PART 5e). The frontier
 * camp ships TWO baskets for FIVE settlers, so 108 of 117 bag lookups saw no
 * idle basket and a bare-handed forager's room is ONE ITEM — 0.20 rations. Five
 * baskets reach 4.86 rations/day against two baskets' 3.80, *with half the
 * trips*. The enabler seat (`bagFetchGoal`) was honest all along; what the world
 * lacked was a way to contain a third basket.
 *
 * FOUR THINGS HAVE TO BE TRUE FOR THAT TO BE MORE THAN A RECIPE, and each one is
 * a way this could ship broken and LOOK fine:
 *
 *  ① THE ROW — one row of `PORTABLE_CONTAINERS`, its bill DERIVED from the
 *     vessel's own size, and the haul ceiling unmoved (⚖️ C3).
 *  ② THE DEMAND — nobody in a founding camp says "make a basket", so a makeable
 *     basket that waits to be ASKED FOR is never made and the ceiling stands
 *     exactly where it was. It gets made because it PAYS, and the inequality
 *     that says so must have TEETH in both directions.
 *  ③ CONSERVATION — 2 wood in, 1 basket out, atomically; short stock makes
 *     NOTHING (an item minted from an empty crate is the conservation law's own
 *     worst case).
 *  ④ NO KIND IS NAMED — a cart must go down the identical path with a bigger
 *     room and a bigger bill, or "the decider names the enabler kind the planner
 *     asked for" is a comment rather than a fact.
 *
 * PURE: no session boot, no DOM, no GL. Everything below is the kernel's own
 * arithmetic over hand-made numbers.
 */
import { describe, it, expect } from "@jest/globals";
import {
  BASKET_HALF_EXTENT_M,
  CART_HALF_EXTENT_M,
  PORTABLE_CONTAINERS,
  haulTripUnits,
  portableCraftOf,
  type PortableCraftDef,
} from "@shared/world-engine/kernel/town/containers.js";
import { blockCosts, furnitureBlocks } from "@shared/world-engine/kernel/town/block-bill.js";
import { craftRecipeOf, isMakeable, makeableGlyph } from "@shared/world-engine/interaction/content/makeable.js";
import {
  enablerSurplusS,
  planCollection,
  type CollectionCandidate,
  type CollectionEnabler,
} from "@shared/world-engine/kernel/town/collection-plan.js";
import { craftItems } from "@shared/world-engine/kernel/town/item-move.js";
import type { StockEndpoint } from "@shared/world-engine/kernel/town/transfer.js";
import { craftLaborDaysFor } from "@shared/world-engine/kernel/town/stations.js";
import { goodsValueS, townFillS } from "@shared/world-engine/kernel/town/pricing.js";
import { constructionGameDays, resolveWorldScale } from "@shared/world-engine/scale.js";
import { rawsForRefined, BLOCK_GLYPH } from "@shared/world-engine/products.js";

/** The frontier camp's own scale — a 240 s street day, construction 720. */
const SCALE = resolveWorldScale({ rotation: 360, sleep_fraction: 0.05, construction: 720 });

/**
 * WHAT MAKING ONE COSTS THE SETTLEMENT — the host's `craftCostS`, transcribed,
 * and deliberately built out of the SHIPPED helpers rather than out of numbers:
 * if `craftLaborDaysFor`, `constructionGameDays`, `goodsValueS` or `townFillS`
 * moves, this moves with it and the two directions pinned in ② stay honest
 * about the tree they are measured on.
 */
function craftCostS(craft: PortableCraftDef, shortage: number): number {
  const labourS =
    constructionGameDays(craftLaborDaysFor(craft.at, false), SCALE) * SCALE.dayLengthS;
  let materialsS = 0;
  for (const n of Object.values(craft.consumes)) {
    materialsS += n * goodsValueS(1, shortage, townFillS(SCALE), 1);
  }
  return labourS + materialsS;
}

// ═══════════════════════════════════════════════════════════════════════════
describe("① the basket is a row of the portable-container table, and a MAKEABLE one", () => {
  it("still holds 8 units in your hands, and the world still stocks it", () => {
    const basket = PORTABLE_CONTAINERS.basket!;
    expect({
      capacity: basket.capacity,
      relation: basket.relation,
      hold: basket.hold,
      seeded: basket.seeded,
    }).toEqual({ capacity: 8, relation: "in", hold: "carry", seeded: true });
  });

  it("🚨 being makeable did NOT make it unseeded — the two facts are independent", () => {
    // `seeded` says the WORLD LAYS THESE DOWN (container-seeds.ts still does),
    // and `haulTripUnits()` reads the seeded rows. A row that quietly went
    // `seeded: false` would drop the global haul ceiling to the satchel's 5 and
    // under-promise every pile-haul in every world.
    expect(PORTABLE_CONTAINERS.basket!.seeded).toBe(true);
    expect(haulTripUnits()).toBe(8);
  });

  it("2 wood at the workbench — and the bill is DERIVED, never painted", () => {
    expect(craftRecipeOf("basket")).toEqual({
      produces: "basket",
      consumes: { wood: 2 },
      at: "workbench",
      label: "basket",
    });
    // The derivation, restated from its two ends: a 0.2 m half-extent through
    // the rule furniture is billed by is ONE block, and a WOVEN vessel is billed
    // in the RAW that block is milled from rather than in the block itself.
    const raw = rawsForRefined(BLOCK_GLYPH).find((p) => p.use === "building")!;
    expect(furnitureBlocks(BASKET_HALF_EXTENT_M)).toBe(1);
    expect(portableCraftOf("basket")!.consumes).toEqual({
      [raw.glyph]: furnitureBlocks(BASKET_HALF_EXTENT_M) * raw.refinesTo!.inPerOut,
    });
  });

  it("…and it is a QUARTER of the cart's bill for a THIRD of its room", () => {
    // The cart is carpentered — blocks, milled first. The basket is woven, one
    // rung earlier in the same chain, which is the whole of "cheaper".
    const cartWood = blockCosts(furnitureBlocks(CART_HALF_EXTENT_M))[BLOCK_GLYPH]! * 2;
    expect(cartWood).toBe(8);
    expect(portableCraftOf("basket")!.consumes.wood).toBe(cartWood / 4);
    expect(PORTABLE_CONTAINERS.basket!.capacity * 3).toBe(PORTABLE_CONTAINERS.cart!.capacity);
  });

  it("'make basket' produces a basket — not a doll of one, not `furn.basket`", () => {
    expect(makeableGlyph("basket")).toBe("basket");
    expect(isMakeable("basket")).toBe(true);
    expect(makeableGlyph("basket")!.includes(".toy")).toBe(false);
  });

  it("an ORDER's facets survive the recipe — a red basket is what gets made", () => {
    expect(craftRecipeOf("basket.color_red")?.produces).toBe("basket.color_red");
  });

  it("🧵 the SATCHEL still has none — no leatherworker, and that stays honest", () => {
    expect(portableCraftOf("satchel")).toBeNull();
    expect(makeableGlyph("satchel")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("② THE DEMAND RULE — surplus over a day against what making one costs", () => {
  /** A far, full stand: the shape a founding camp forages, where the walk is
   *  the whole cost and the hands are the whole limit. */
  const FAR: CollectionCandidate[] = [
    { id: "tile-1-0", free: 40, unitValueS: 200, costS: 90 },
  ];
  /** ONE STREET DAY of a settler's food: the meter's own draw, and the horizon
   *  the host passes. Deliberately the stingy choice — a vessel that cannot
   *  repay itself inside a day is not made. */
  const DAY_RATIONS = 1;
  /** Bare hands hold ONE fruit, and a fruit is 0.2 of a day's eating. */
  const BARE = 0.2;
  const basketRoom = PORTABLE_CONTAINERS.basket!.capacity * 0.2;

  it("POSTS: a day's food off a far stand pays for a basket several times over", () => {
    const vessel: CollectionEnabler = { id: "basket", costS: 40, roomWith: basketRoom };
    const gain = enablerSurplusS({ want: DAY_RATIONS, room: BARE }, FAR, vessel, DAY_RATIONS);
    // Five bare trips become one: four walks of 90 s saved, less the 40 s fetch.
    expect(Math.round(gain)).toBe(320);
    // …against a bill of 21 hand-seconds of weaving on a camp whose books carry
    // no timber row (`townShortage("wood") === 0` — measured on
    // frontier-planet). Fifteen times over, which is why the first bill posts
    // inside three sim-minutes.
    const craft = portableCraftOf("basket")!;
    expect(Math.round(craftCostS(craft, 0))).toBe(21);
    expect(gain).toBeGreaterThan(craftCostS(craft, 0));
  });

  it("🚨 REFUSES: a stand at the door saves nothing worth two sticks of timber", () => {
    // Same want, same vessel — a source 3 hand-seconds away. The trips it saves
    // are free, so the surplus collapses and the recipe's own cost binds. This
    // is the direction that proves the inequality has teeth: without it the rule
    // would read "always make one", and the note would be a lie.
    const NEAR: CollectionCandidate[] = [{ id: "bush", free: 40, unitValueS: 200, costS: 3 }];
    const vessel: CollectionEnabler = { id: "basket", costS: 40, roomWith: basketRoom };
    const gain = enablerSurplusS({ want: DAY_RATIONS, room: BARE }, NEAR, vessel, DAY_RATIONS);
    expect(gain).toBeLessThan(craftCostS(portableCraftOf("basket")!, 1));
    expect(gain).toBeLessThanOrEqual(0);
  });

  it("🚨 REFUSES: a vessel that adds no room is never even priced", () => {
    // `roomWith` at or below the hands ⇒ zero, without touching a candidate —
    // the same guard `planCollection`'s enabler arm applies, for the same
    // reason: a pocket must cost no cycles and no walk.
    const pocket: CollectionEnabler = { id: "pocket", costS: 0, roomWith: BARE };
    expect(enablerSurplusS({ want: DAY_RATIONS, room: BARE }, FAR, pocket, DAY_RATIONS)).toBe(0);
  });

  it("🚨 REFUSES: nothing free to collect ⇒ no gain to report, whatever the room", () => {
    const empty: CollectionCandidate[] = [{ id: "picked", free: 0, unitValueS: 200, costS: 90 }];
    const vessel: CollectionEnabler = { id: "basket", costS: 0, roomWith: basketRoom };
    expect(enablerSurplusS({ want: DAY_RATIONS, room: BARE }, empty, vessel, DAY_RATIONS)).toBe(0);
  });

  it("the horizon is a MULTIPLIER, not a switch — half a day is half the gain", () => {
    const vessel: CollectionEnabler = { id: "basket", costS: 0, roomWith: basketRoom };
    const whole = enablerSurplusS({ want: DAY_RATIONS, room: BARE }, FAR, vessel, DAY_RATIONS);
    const half = enablerSurplusS({ want: DAY_RATIONS, room: BARE }, FAR, vessel, DAY_RATIONS / 2);
    expect(half * 2).toBeCloseTo(whole, 6);
  });

  it("🚨 the ONE-TRIP arm is NOT this question, and the difference is the point", () => {
    // `planCollection`'s enabler arm charges the fetch against a SINGLE trip,
    // which is right for detouring to a basket that already exists and wrong for
    // deciding whether one should be made: a vessel is not consumed by the trip
    // it serves. The one-trip reading here declines the fetch outright; the
    // horizon reading pays for the whole basket.
    const vessel: CollectionEnabler = { id: "basket", costS: 200, roomWith: basketRoom };
    const oneTrip = planCollection({ want: DAY_RATIONS, room: BARE }, FAR, { enablers: [vessel] });
    expect(oneTrip.enabler).toBeUndefined();
    expect(enablerSurplusS({ want: DAY_RATIONS, room: BARE }, FAR, vessel, DAY_RATIONS * 5))
      .toBeGreaterThan(0);
  });

  it("a settlement that is SHORT of the timber charges for it, and can refuse", () => {
    // The materials term is the town's own price for a unit it wants. A camp
    // whose books carry no row for the raw prices it at nothing (measured: the
    // frontier camp does exactly that); a town in famine for timber prices two
    // sticks at two street-days and the same basket stops being worth weaving.
    const craft = portableCraftOf("basket")!;
    expect(craftCostS(craft, 0)).toBeLessThan(craftCostS(craft, 1));
    expect(craftCostS(craft, 1) - craftCostS(craft, 0)).toBeCloseTo(2 * townFillS(SCALE), 6);
    const vessel: CollectionEnabler = { id: "basket", costS: 40, roomWith: basketRoom };
    const gain = enablerSurplusS({ want: DAY_RATIONS, room: BARE }, FAR, vessel, DAY_RATIONS);
    expect(gain).toBeGreaterThan(craftCostS(craft, 0));
    // 🚨 AND THE FAMINE ARM ACTUALLY BINDS: the same trip-saving that pays for a
    // basket fifteen times over on the camp's books does NOT pay for it in a
    // town that is completely out of timber (320 s of walking against 501 s of
    // wood). This is the term that stops a settlement weaving its last plank.
    expect(gain).toBeLessThan(craftCostS(craft, 1));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("③ CONSERVATION — 2 wood in, 1 basket out, or nothing at all", () => {
  const spotOf = (stack: Record<string, number>): StockEndpoint =>
    ({ id: "town:yard", kind: "yard", stack });

  it("the craft is a TRANSACTION: the wood is gone and the basket is there", () => {
    const stack: Record<string, number> = { wood: 14, stone: 6 };
    const ep = spotOf(stack);
    const r = craftItems(() => ep, { kind: "container", id: "town:yard" }, { wood: 2 }, "basket");
    expect(r.ok).toBe(true);
    expect(stack).toEqual({ wood: 12, stone: 6, basket: 1 });
  });

  it("🚨 SHORT ⇒ NOTHING HAPPENS — no basket, and the timber untouched", () => {
    const stack: Record<string, number> = { wood: 1 };
    const ep = spotOf(stack);
    const r = craftItems(() => ep, { kind: "container", id: "town:yard" }, { wood: 2 }, "basket");
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual({ wood: 1 });
    expect(stack).toEqual({ wood: 1 });
  });

  it("seven baskets is what a founding camp's 14 wood buys, and then it stops", () => {
    // The camp ships `wood: 14` (frontier-planet.spec.json). Weaving is bounded
    // by the timber like everything else — there is no arm in which a basket
    // comes from nowhere.
    const stack: Record<string, number> = { wood: 14 };
    const ep = spotOf(stack);
    let made = 0;
    for (let i = 0; i < 10; i++) {
      if (craftItems(() => ep, { kind: "container", id: "town:yard" }, { wood: 2 }, "basket").ok) made++;
    }
    expect(made).toBe(7);
    expect(stack.wood ?? 0).toBe(0);
    expect(stack.basket).toBe(7);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("④ NO KIND IS NAMED — a cart is the same path with a bigger room", () => {
  it("the demand walks the TABLE, and both makeable rows are on it", () => {
    const makeable = Object.entries(PORTABLE_CONTAINERS)
      .filter(([, d]) => !!d.craft)
      .map(([head]) => head);
    expect(makeable).toEqual(["basket", "cart"]);
  });

  it("a cart's own numbers price through the identical arithmetic", () => {
    const FAR: CollectionCandidate[] = [{ id: "tile", free: 400, unitValueS: 200, costS: 90 }];
    const ask = { want: 24, room: 1 };
    const priced = Object.entries(PORTABLE_CONTAINERS)
      .filter(([, d]) => !!d.craft)
      .map(([head, d]) => ({
        head,
        margin:
          enablerSurplusS(ask, FAR, { id: head, costS: 40, roomWith: d.capacity }, 24) -
          craftCostS(d.craft!, 0),
      }));
    // On a caravan-scale want the CART wins on its own merits: three times the
    // room for four times the timber, and nothing in the loop knows either word.
    const best = priced.reduce((a, b) => (b.margin > a.margin ? b : a));
    expect(best.head).toBe("cart");
    expect(priced.every((p) => p.margin > 0)).toBe(true);
  });

  it("…and on a ONE-ITEM want neither is worth making — the gate is the gate", () => {
    const NEAR: CollectionCandidate[] = [{ id: "shelf", free: 40, unitValueS: 20, costS: 2 }];
    const ask = { want: 1, room: 1 };
    for (const [head, d] of Object.entries(PORTABLE_CONTAINERS)) {
      if (!d.craft) continue;
      const margin =
        enablerSurplusS(ask, NEAR, { id: head, costS: 5, roomWith: d.capacity }, 1) -
        craftCostS(d.craft, 0);
      expect([head, margin > 0]).toEqual([head, false]);
    }
  });
});
