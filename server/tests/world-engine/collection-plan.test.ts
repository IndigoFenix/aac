/**
 * 🛒 THE COLLECTION-TRIP PLANNER — one kernel, every kind of source.
 *
 * ⚖️ THE USER'S RULING (2026-09-09), verbatim: *"the solution to the foraging …
 * really should be part of the kernel rather than a foraging-specific rule.
 * Consider — the math determining which bushes to visit is basically the same
 * as that of a shopper visiting stores or cities where they can collect
 * resources."*
 *
 * So `kernel/town/collection-plan.ts` owns the arithmetic and forage is only
 * its FIRST consumer. These pins exist to make the SECOND consumer a WIRING
 * rather than a design: every one of them feeds the planner candidates shaped
 * like something that is NOT a bush — a priced market shelf, a city at caravan
 * scale — and asks whether the answer is the one a shopper would give.
 *
 * 🚫 The planner names no kind and no good, so neither does this file: a
 * candidate is an id and four numbers.
 *
 * Pure / DB-free / GL-free — `npm run test:engine -- collection-plan`.
 */
import { describe, it, expect } from "@jest/globals";
import {
  planCollection,
  rankCollection,
  type CollectionCandidate,
} from "@shared/world-engine/kernel/town/collection-plan.js";

/** A source with no price — a wild stand, a set-down basket, a free heap. */
const free = (id: string, units: number, costS: number, unitValueS = 40): CollectionCandidate => ({
  id,
  free: units,
  unitValueS,
  costS,
});
/** A source that CHARGES — a market shelf, a city's terms. */
const priced = (
  id: string,
  units: number,
  costS: number,
  price: number,
  unitValueS = 40,
): CollectionCandidate => ({ ...free(id, units, costS, unitValueS), price });

describe("① the trip has a SIZE, and the size is what pays for the walk", () => {
  it("takes what the want and the room allow, not one unit", () => {
    const p = planCollection({ want: 5, room: 3 }, [free("a", 10, 20)]);
    expect(p.legs).toHaveLength(1);
    expect(p.legs[0]!.units).toBe(3); // the room binds
    expect(p.units).toBe(3);
    // value − cost, in hand-seconds: 3 × 40 − 20.
    expect(p.netS).toBeCloseTo(3 * 40 - 20, 9);
  });

  it("a FULLER source beats a nearer thin one once the walk is amortised", () => {
    // 🚨 THE DEFECT THIS TERM EXISTS FOR (PART 5d): with the size out of the
    // value, a stand holding one unit and a stand holding four are the same
    // trip — so a party walks the near one to zero and then walks it again.
    const near = free("near", 1, 10);
    const far = free("far", 4, 30);
    expect(rankCollection({ want: 4, room: 4 }, [near, far]).map((l) => l.id)[0]).toBe("far");
    // …and with only one unit wanted the near one wins again: the size is a
    // term, not a thumb on the scale.
    expect(rankCollection({ want: 1, room: 1 }, [near, far]).map((l) => l.id)[0]).toBe("near");
  });

  it("a trip that costs more than it brings is not a trip", () => {
    expect(planCollection({ want: 1, room: 1 }, [free("far", 10, 500)]).legs).toEqual([]);
    // …unless the caller models no geometry at all, where every cost is 0 and
    // the honest answer is the unpriced one rather than an empty plan.
    expect(planCollection({ want: 1, room: 1 }, [free("x", 10, 0)]).legs).toHaveLength(1);
  });
});

describe("② A SHOP IS A CANDIDATE — the price is just another cost", () => {
  it("a priced shelf beats a farther free source when the price is under the walk", () => {
    // The shopper's own question: four units at 5 s each from the stall next
    // door, or the same four free from the wood twenty minutes away?
    const shelf = priced("shelf", 10, 10, 5);
    const wood = free("wood", 10, 150);
    // 4 × (40 − 5) − 10 = 130 against 4 × 40 − 150 = 10.
    expect(rankCollection({ want: 4, room: 4 }, [shelf, wood]).map((l) => l.id)[0]).toBe("shelf");
  });

  it("…and loses when the price outruns the walk it saves", () => {
    const dear = priced("dear", 10, 10, 38);
    const wood = free("wood", 10, 100);
    expect(rankCollection({ want: 4, room: 4 }, [dear, wood]).map((l) => l.id)[0]).toBe("wood");
  });

  it("a price at or above the unit's own worth is never worth paying", () => {
    expect(planCollection({ want: 4, room: 4 }, [priced("gouge", 10, 0, 40)]).legs).toEqual([]);
  });
});

describe("③ A CITY IS A CANDIDATE TOO — a want bigger than one source SPANS them", () => {
  it("fills a caravan-scale want across two sources, best first", () => {
    // Neither city can fill the order; the planner takes what each has, in the
    // order that pays best, and stops when the want is met.
    const p = planCollection(
      { want: 100, room: 100 },
      [free("cityA", 60, 200), free("cityB", 70, 300)],
      { maxLegs: 3 },
    );
    // cityB first on worth (70 x 40 - 300 = 2500 against 60 x 40 - 200 = 2200),
    // then cityA for the balance — the order is the arithmetic's, not the list's.
    expect(p.legs.map((l) => l.id)).toEqual(["cityB", "cityA"]);
    expect(p.legs.map((l) => l.units)).toEqual([70, 30]);
    expect(p.units).toBe(100);
  });

  it("ONE LEG unless the caller says its taker can chain", () => {
    // A body on an errand makes one trip; a caravan is what `maxLegs` is for.
    const p = planCollection({ want: 100, room: 100 }, [free("a", 60, 10), free("b", 70, 20)]);
    expect(p.legs).toHaveLength(1);
    expect(p.legs[0]!.id).toBe("b"); // the fuller source, its extra 10 units
    expect(p.units).toBe(70);        // worth more than the 10 s of walk it costs
  });

  it("stops as soon as the want is met, however much is standing", () => {
    const p = planCollection({ want: 10, room: 99 }, [free("a", 999, 10), free("b", 999, 20)], {
      maxLegs: 5,
    });
    expect(p.units).toBe(10);
    expect(p.legs).toHaveLength(1);
  });
});

describe("④ A BOOKED LEG IS FROZEN — the measured reason the size is not re-read", () => {
  it("keeps the size it was claimed at, whatever the room says now", () => {
    // 🚨 Valuing a candidate at `min(free, room)` with room read off the HANDS
    // cost 4.84 → 2.76 rations/day (PART 5b): room moves as a body picks things
    // up, two near-tied sources swap places mid-walk, and the trip never ends.
    const booked: CollectionCandidate = { ...free("mine", 10, 10), booked: 4 };
    const p = planCollection({ want: 1, room: 0 }, [booked]);
    expect(p.legs).toHaveLength(1);
    expect(p.legs[0]!.units).toBe(4); // NOT clipped to the want or the room
  });

  it("…but never more than is still really there — a claim is an intent", () => {
    const booked: CollectionCandidate = { ...free("thinned", 2, 10), booked: 4 };
    expect(planCollection({ want: 9, room: 9 }, [booked]).legs[0]!.units).toBe(2);
  });
});

describe("⑤ DETERMINISM — two peers over one world plan the same trip", () => {
  it("ties break on the id, never on input order", () => {
    const a = free("aaa", 5, 10);
    const b = free("bbb", 5, 10);
    expect(rankCollection({ want: 5, room: 5 }, [b, a]).map((l) => l.id)).toEqual(["aaa", "bbb"]);
    expect(rankCollection({ want: 5, room: 5 }, [a, b]).map((l) => l.id)).toEqual(["aaa", "bbb"]);
  });

  it("an empty source is not a candidate at all", () => {
    expect(rankCollection({ want: 5, room: 5 }, [free("empty", 0, 1)])).toEqual([]);
  });
});

describe("⑥ AN ENABLER IS A PRICED OPTION, NEVER A PRECONDITION", () => {
  // 🚨 THE MEASURED LAW (emergent-plans-round.md E-8): claiming a bag at decide
  // time so nobody else could take it cost 4.60 → 3.54 rations/day, because it
  // turned one body's option into everybody else's blocker. So the planner
  // COMPARES: bare-handed against with-the-thing, over the same want.
  const cart = { id: "cart", costS: 30, roomWith: 10 };

  it("is chosen when the units it buys pay for its fetch", () => {
    // A ten-unit want over a long leg: bare hands bring 1 (40 − 100 = −60, not
    // worth going at all), the cart brings 10 (400 − 100 − 30 = 270).
    const p = planCollection({ want: 10, room: 1 }, [free("wood", 50, 100)], { enablers: [cart] });
    expect(p.enabler).toBe("cart");
    expect(p.units).toBe(10);
    expect(p.netS).toBeCloseTo(10 * 40 - 100 - 30, 9);
  });

  it("is NOT chosen for a top-up the hands can already carry", () => {
    // One unit wanted: the cart's extra room buys nothing and its fetch is
    // pure cost. The plan is bare, and the bare plan is always in the running.
    const p = planCollection({ want: 1, room: 1 }, [free("wood", 50, 20)], { enablers: [cart] });
    expect(p.enabler).toBeUndefined();
    expect(p.units).toBe(1);
  });

  it("is NOT chosen when its fetch outruns what the extra units are worth", () => {
    const dearCart = { id: "far-cart", costS: 5000, roomWith: 10 };
    const p = planCollection({ want: 10, room: 1 }, [free("wood", 50, 20)], {
      enablers: [dearCart],
    });
    expect(p.enabler).toBeUndefined();
  });

  it("an enabler with no more room than the hands is never even priced", () => {
    const useless = { id: "pocket", costS: 0, roomWith: 1 };
    expect(planCollection({ want: 5, room: 1 }, [free("w", 9, 10)], { enablers: [useless] })
      .enabler).toBeUndefined();
  });

  it("picks the best of several, deterministically, and bare beats a tie", () => {
    const a = { id: "cartA", costS: 30, roomWith: 10 };
    const b = { id: "cartB", costS: 10, roomWith: 10 };
    const p = planCollection({ want: 10, room: 1 }, [free("w", 50, 100)], { enablers: [a, b] });
    expect(p.enabler).toBe("cartB"); // same room, cheaper fetch
  });
});
