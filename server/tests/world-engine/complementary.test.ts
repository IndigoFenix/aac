// COMPLEMENTARY SCARCITY, PRICED — the pair read and the LANE read
// (trade-topology round S1; resources-and-trade.md ⑤, rulings R-1..R-4).
//
// 🚨 THE GAP THIS FILE CLOSES. `complementary.ts` has shipped three rounds of
// law — the want gate, the freight gate, the landed weight — and there has
// never been a `complementary*.test.ts`. What coverage it had rode inside
// `town-barter.test.ts`'s barter block (the pair read) and
// `trade-import-channel.arc.test.ts` (the hold split), so the module's own
// rules were only ever pinned through a consumer. They are pinned here.
//
// What the trade-topology round adds, and what this file is mostly about:
//  · A THIRD MEMBERSHIP GATE — WORTHWHILE (R-2). Want says we are short of it;
//    freight says the road does not destroy it; neither asks whether the trip
//    is worth MAKING. `advantageS > 0` does, in hand-seconds.
//  · The RANKING KEY is that same price, so the hold is dealt by landed cost
//    and a dense good outbids a bulky one it merely tied with on appetite.
//  · `rankLanes` (R-3/R-4) — the same read one rung up: which NEIGHBOUR, by
//    what a lane to each is worth. Distance never forms a lane; it only
//    orders equals.
//
// Every leg below is DERIVED from the good's own freight row (its reach, its
// break-even shortage) — never a literal, so a content change moves the test
// with the world instead of reddening it.
//
// Pure logic — no DOM / GL / DB / boot.

import { describe, it, expect } from "@jest/globals";
import {
  BARTER_WANT_MIN,
  complementaryRanking,
  complementaryTrade,
  freightSurvivesLeg,
  rankLanes,
  type LaneCandidate,
} from "@shared/world-engine/kernel/town/complementary.js";
import {
  freightUnitS,
  localUnitCostS,
} from "@shared/world-engine/kernel/town/landed-cost.js";
import { carryReachM, freightOf } from "@shared/world-engine/freight.js";
import { townFillS } from "@shared/world-engine/kernel/town/pricing.js";
import { IMPORT_ALLOTMENT } from "@shared/world-engine/kernel/town/trade.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";
import type { BarterSignals } from "@shared/world-engine/kernel/town/barter.js";

const SCALE = DOLLHOUSE_SCALE;
/** Books that read the given shortages and 0 (plenty) for everything else. */
const sig = (m: Record<string, number>): BarterSignals => ({ shortage: (g) => m[g] ?? 0 });

// ─────────────────────────────────────────────────────────────────────────
// ① THE PAIR READ — perspective consistency, now including the price
// ─────────────────────────────────────────────────────────────────────────

describe("① complementaryRanking — one rule, read from either end", () => {
  const GOODS = ["food", "wood", "cloth", "clothing"];
  const us = sig({ cloth: 0.9, clothing: 0.4, food: 0.02, wood: 0 });
  const them = sig({ cloth: 0, clothing: 0.05, food: 0.8, wood: 0.3 });

  it("🔒 PERSPECTIVE CONSISTENCY — A's imports ARE B's exports, `advantageS` included", () => {
    const a = complementaryRanking(us, them, GOODS, 300, SCALE);
    const b = complementaryRanking(them, us, GOODS, 300, SCALE);
    // Not merely the same goods in the same order: the same ROWS, to the bit.
    // The price is a property of the PAIR and the road, so neither side can
    // hold a different number for the same lane and the same good.
    expect(a.imports).toEqual(b.exports);
    expect(a.exports).toEqual(b.imports);
    expect(a.imports.map((r) => r.good)).toEqual(["cloth", "clothing"]);
    expect(a.exports.map((r) => r.good)).toEqual(["food", "wood"]);
  });

  it("🔒 the names-only projection is the ranking's order — one rule, two shapes", () => {
    const rank = complementaryRanking(us, them, GOODS, 300, SCALE);
    const names = complementaryTrade(us, them, GOODS, 300, SCALE);
    expect(rank.imports.map((r) => r.good)).toEqual(names.imports);
    expect(rank.exports.map((r) => r.good)).toEqual(names.exports);
    expect(Object.keys(names).sort()).toEqual(["exports", "imports"]);
  });

  it("🚨 EVERY row on a list is worth carrying — `advantageS > 0` is the gate", () => {
    for (const legM of [0, 137, 300, 900, 1800]) {
      const rank = complementaryRanking(us, them, GOODS, legM, SCALE);
      for (const r of [...rank.imports, ...rank.exports]) {
        expect(r.advantageS).toBeGreaterThan(0);
        // …and `want` is retained, unchanged: the 0..1 landed weight, still
        // bounded by the raw shortage that admitted the row.
        expect(r.want).toBeGreaterThan(0);
        expect(r.want).toBeLessThanOrEqual(1);
      }
      // Descending in the PRICE (that is the key), not necessarily in `want`.
      const adv = rank.imports.map((r) => r.advantageS);
      expect([...adv].sort((x, y) => y - x)).toEqual(adv);
    }
  });

  it("a good neither side can spare, or neither wants, is on no list", () => {
    const both = sig({ food: 0.9, cloth: 0.9 });
    expect(complementaryTrade(both, both, ["food", "cloth"], 100, SCALE))
      .toEqual({ imports: [], exports: [] });
    const flush = sig({});
    expect(complementaryTrade(flush, flush, GOODS, 100, SCALE))
      .toEqual({ imports: [], exports: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ② THE WORTHWHILE GATE (R-2) — the third membership test
// ─────────────────────────────────────────────────────────────────────────

describe("② WORTHWHILE — a wanted good the road makes dearer than doing without", () => {
  // `wood` is the rawBulk case: durable (so the freight gates never bite —
  // "the ox never eats the cargo") and cheap per unit of bulk, so the road
  // costs real hand-seconds against a modest want. HALF its own carry reach:
  // derived from its freight row, never a literal.
  const WOOD = freightOf("wood");
  const legM = carryReachM(SCALE, WOOD) / 2;
  /** The shortage at which this good over this road exactly breaks even —
   *  freight per unit as a fraction of a street day. Half a fill, here. */
  const breakEven = freightUnitS(WOOD, legM, SCALE) / townFillS(SCALE);

  it("🔒 the premise: BOTH shipped gates admit it — the road does not eat wood", () => {
    expect(freightSurvivesLeg("wood", legM, SCALE)).toBe(true);
    expect(breakEven).toBeCloseTo(0.5, 9);
    expect(breakEven).toBeGreaterThan(BARTER_WANT_MIN); // a real want, still refused
  });

  it("🚨 below its break-even shortage the good is NOT on the lane, however much we want it", () => {
    const spare = sig({});
    const shy = complementaryRanking(sig({ wood: breakEven - 0.01 }), spare, ["wood"], legM, SCALE);
    expect(shy.imports).toEqual([]);
    // The want gate would have passed it: we are well past `BARTER_WANT_MIN`.
    expect(breakEven - 0.01).toBeGreaterThan(BARTER_WANT_MIN);
    // Exactly AT break-even is still refused — the sign is strict, and a dead
    // heat is not a reason to send a caravan.
    expect(complementaryRanking(sig({ wood: breakEven }), spare, ["wood"], legM, SCALE).imports)
      .toEqual([]);
  });

  it("🚨 one notch above it, the same good over the same road IS worth carrying", () => {
    const rank = complementaryRanking(sig({ wood: breakEven + 0.01 }), sig({}), ["wood"], legM, SCALE);
    expect(rank.imports.map((r) => r.good)).toEqual(["wood"]);
    // …and by exactly the notch: 0.01 of a street day.
    expect(rank.imports[0]!.advantageS).toBeCloseTo(0.01 * townFillS(SCALE), 6);
  });

  it("🚨 AT ITS OWN CARRY REACH nothing is worth importing — the anchor, as a gate", () => {
    // One unit's freight at `carryReachM` is one whole hunger fill
    // (landed-cost.test.ts's anchor identity) and one unit is worth at most
    // one whole street day, which on this scale is the same number. So the
    // best case in the world — we have none, they have plenty — is a dead
    // heat, and the strict sign refuses it. "Past this the trade destroys
    // value" is freight.ts's own sentence; this is where it starts.
    for (const good of ["cloth", "wood", "clothing", "cookie"]) {
      const reach = carryReachM(SCALE, freightOf(good));
      expect(freightSurvivesLeg(good, reach, SCALE)).toBe(true); // the FLOOR still admits it
      expect(complementaryRanking(sig({ [good]: 1 }), sig({}), [good], reach, SCALE).imports)
        .toEqual([]);
    }
  });

  it("🚨 THE PARTNER'S OWN BOOKS ARE IN THE PRICE — a pinched supplier prices itself out", () => {
    // Their cost per unit is `localUnitCostS(their shortage)` — the same
    // reading as ours, off their own books (real or stub: both are a
    // `BarterSignals`). A partner just under the want gate is nearly as short
    // as we are, so what we would gain by importing is nearly nothing.
    const good = "cloth";
    const legShort = carryReachM(SCALE, freightOf(good)) / 100;
    const flush = complementaryRanking(sig({ [good]: 0.5 }), sig({}), [good], legShort, SCALE);
    const pinched = complementaryRanking(
      sig({ [good]: 0.5 }),
      sig({ [good]: BARTER_WANT_MIN - 1e-9 }),
      [good],
      legShort,
      SCALE,
    );
    expect(flush.imports).toHaveLength(1);
    expect(pinched.imports).toHaveLength(1);
    // The difference is EXACTLY their own cost per unit, and nothing else.
    expect(flush.imports[0]!.advantageS - pinched.imports[0]!.advantageS)
      .toBeCloseTo(localUnitCostS(BARTER_WANT_MIN - 1e-9, SCALE), 9);
    // Same books, same road: the 0..1 `want` cannot see any of this.
    expect(pinched.imports[0]!.want).toBe(flush.imports[0]!.want);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ③ THE ORDER IS THE PRICE (R-2) — where appetite and landed cost disagree
// ─────────────────────────────────────────────────────────────────────────

describe("③ order follows landed advantage, not appetite", () => {
  it("🚨 EQUAL WANT, UNEQUAL FREIGHT — the dense good outranks the bulky one", () => {
    // `wood` is rawBulk (valueDensity 0.5), `cloth` refined (4): eight times
    // the worth on the same porter's back, so an eighth of the freight. Both
    // are DURABLE, so `want` — the 0..1 landed weight — is the raw shortage
    // for both and TIES exactly. Under the old key the tie broke toward the
    // earlier good in `goods`, which is why wood is listed first here.
    const need = sig({ wood: 0.5, cloth: 0.5 });
    const spare = sig({});
    const legM = 200;
    const rank = complementaryRanking(need, spare, ["wood", "cloth"], legM, SCALE);
    expect(rank.imports.map((r) => r.want)).toEqual([0.5, 0.5]); // a genuine tie
    expect(rank.imports.map((r) => r.good)).toEqual(["cloth", "wood"]); // …broken by PRICE
    // Derived, not asserted: the gap IS the freight difference.
    const gap = freightUnitS(freightOf("wood"), legM, SCALE)
      - freightUnitS(freightOf("cloth"), legM, SCALE);
    expect(rank.imports[0]!.advantageS - rank.imports[1]!.advantageS).toBeCloseTo(gap, 9);
  });

  it("🔒 a GENUINE tie still breaks toward the earlier good — `defaultTakeGood`'s rule", () => {
    // Two goods can only tie in price when their shortages AND their freight
    // rows agree. `ball` and `teddy` are the same row (refined, durable).
    expect(freightOf("ball")).toEqual(freightOf("teddy"));
    const rank = complementaryRanking(sig({ ball: 0.6, teddy: 0.6 }), sig({}), ["teddy", "ball"], 300, SCALE);
    expect(rank.imports.map((r) => r.good)).toEqual(["teddy", "ball"]);
    expect(rank.imports[0]!.advantageS).toBe(rank.imports[1]!.advantageS);
    // …and the input order is the whole tie-break, so reversing it reverses.
    expect(
      complementaryRanking(sig({ ball: 0.6, teddy: 0.6 }), sig({}), ["ball", "teddy"], 300, SCALE)
        .imports.map((r) => r.good),
    ).toEqual(["ball", "teddy"]);
  });

  it("🔒 with NO ROAD there is no freight, so appetite alone ranks (and prices)", () => {
    const rank = complementaryRanking(sig({ wood: 0.5, cloth: 0.4 }), sig({}), ["cloth", "wood"], 0, SCALE);
    expect(rank.imports.map((r) => r.good)).toEqual(["wood", "cloth"]);
    expect(rank.imports[0]!.advantageS).toBe(0.5 * townFillS(SCALE));
    expect(rank.imports[1]!.advantageS).toBe(0.4 * townFillS(SCALE));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ④ rankLanes — WHICH NEIGHBOUR (R-3, R-4)
// ─────────────────────────────────────────────────────────────────────────

describe("④ rankLanes — complementarity forms the lane, distance only orders equals", () => {
  const GOODS = ["clothing", "food"];
  /** The S0 acceptance fixture's own books: a young town with a weaver and no
   *  tailor (clothing shortage 1.000) whose granary is full (the owed term
   *  0.0998, under the want gate — food is never complementary at rest). */
  const US = sig({ clothing: 1, food: 0.0998 });

  it("🚨 THE ACCEPTANCE: the COMPLEMENTARY neighbour beats the NEARER same-profile one", () => {
    // `near` is another young hamlet — it wants clothing exactly as badly as
    // we do, so it can spare none and the lane carries nothing. `far` is a
    // grown one with a licensed tailor (clothing 0.000). It is 300 m further
    // away and it wins, because distance never formed a lane in the first
    // place: it is priced INSIDE the value it competes on.
    const candidates: LaneCandidate[] = [
      { key: "hamlet-near", legM: 1100, signals: sig({ clothing: 1 }) },
      { key: "hamlet-far", legM: 1400, signals: sig({}) },
    ];
    const lanes = rankLanes(US, candidates, GOODS, SCALE, IMPORT_ALLOTMENT);
    expect(lanes.map((l) => l.key)).toEqual(["hamlet-far", "hamlet-near"]);
    expect(lanes[0]!.imports.map((r) => r.good)).toEqual(["clothing"]);
    expect(lanes[0]!.units.get("clothing")).toBe(IMPORT_ALLOTMENT);
    expect(lanes[0]!.valueS).toBeGreaterThan(0);
    // …and the near one is BOUND-ABLE but empty (R-4): a lane with nothing on
    // it is a real outcome, not an absent candidate.
    expect(lanes[1]!.imports).toEqual([]);
    expect(lanes[1]!.valueS).toBe(0);
    expect(lanes[1]!.units.size).toBe(0);
  });

  it("🚨 the lane's value is Σ advantage × units over the IMPORTS — our gain, never theirs", () => {
    // A partner short of what we can spare has an export list, and it must
    // not inflate the lane: what our exports are worth is what THEY would pay
    // for them, and they are the ones who would be paying.
    const hungry = sig({ food: 0.9 });
    const lanes = rankLanes(US, [{ key: "p", legM: 600, signals: hungry }], GOODS, SCALE, IMPORT_ALLOTMENT);
    const lane = lanes[0]!;
    expect(lane.exports.map((r) => r.good)).toEqual(["food"]); // they want our grain
    expect(lane.exports[0]!.advantageS).toBeGreaterThan(0);
    const fromImports = lane.imports.reduce(
      (n, r) => n + r.advantageS * (lane.units.get(r.good) ?? 0),
      0,
    );
    expect(lane.valueS).toBeCloseTo(fromImports, 9);
  });

  it("🚨 the HOLD is dealt by advantage, and Σ is the allotment exactly", () => {
    // Two goods we are short of, one dense and one bulky, over one road.
    //   cloth  local 1.00 × 240 = 240 s, freight 600/(15.2×4)   =  9.868 s ⇒ 230.132
    //   wood   local 0.60 × 240 = 144 s, freight 600/(15.2×0.5) = 78.947 s ⇒  65.053
    //   Σ 295.184 ⇒ 6 units × (0.6777 / 0.3223) = 4.678 / 1.322
    //   ⇒ floors 4/1, the one left over to the largest remainder (cloth) ⇒ 5/1.
    const lanes = rankLanes(
      sig({ cloth: 1, wood: 0.6 }),
      [{ key: "p", legM: 600, signals: sig({}) }],
      ["cloth", "wood"],
      SCALE,
      IMPORT_ALLOTMENT,
    );
    const lane = lanes[0]!;
    expect(lane.imports.map((r) => r.good)).toEqual(["cloth", "wood"]);
    expect(lane.imports[0]!.advantageS).toBeCloseTo(230.13157894736842, 6);
    expect(lane.imports[1]!.advantageS).toBeCloseTo(65.05263157894737, 6);
    expect([...lane.units.values()]).toEqual([5, 1]);
    expect([...lane.units.values()].reduce((a, b) => a + b, 0)).toBe(IMPORT_ALLOTMENT);
    expect(lane.valueS).toBeCloseTo(230.13157894736842 * 5 + 65.05263157894737, 6);
  });

  it("🚨 ZERO-VALUE LANES ORDER BY LEG — nearest first, then the caller's own order", () => {
    // Nothing to trade with anybody: the ONLY thing left to prefer is the
    // shorter road, and it is the tie-break, never the key (R-3). Input order
    // is deliberately far-first so the sort has to do the work.
    const none = sig({ clothing: 1 }); // wants what we want, spares nothing
    const lanes = rankLanes(
      US,
      [
        { key: "far", legM: 2400, signals: none },
        { key: "near", legM: 900, signals: none },
        { key: "mid", legM: 1500, signals: none },
      ],
      GOODS,
      SCALE,
      IMPORT_ALLOTMENT,
    );
    expect(lanes.map((l) => l.key)).toEqual(["near", "mid", "far"]);
    expect(lanes.every((l) => l.valueS === 0)).toBe(true);
    // Equal value AND equal leg ⇒ the caller's own order decides, so the read
    // is deterministic all the way down.
    const tied = rankLanes(
      US,
      [
        { key: "b", legM: 900, signals: none },
        { key: "a", legM: 900, signals: none },
      ],
      GOODS,
      SCALE,
      IMPORT_ALLOTMENT,
    );
    expect(tied.map((l) => l.key)).toEqual(["b", "a"]);
  });

  it("no candidates ⇒ no lanes; and each lane carries the leg it was priced at", () => {
    expect(rankLanes(US, [], GOODS, SCALE, IMPORT_ALLOTMENT)).toEqual([]);
    const lanes = rankLanes(
      US,
      [{ key: "p", legM: 777, signals: sig({}) }],
      GOODS,
      SCALE,
      IMPORT_ALLOTMENT,
    );
    expect(lanes[0]!.legM).toBe(777);
    expect(lanes[0]!.key).toBe("p");
  });

  it("🔒 a lane is the PAIR read, unchanged — rankLanes invents no membership of its own", () => {
    const them = sig({});
    const legM = 600;
    const pair = complementaryRanking(US, them, GOODS, legM, SCALE);
    const lane = rankLanes(US, [{ key: "p", legM, signals: them }], GOODS, SCALE, IMPORT_ALLOTMENT)[0]!;
    expect(lane.imports).toEqual(pair.imports);
    expect(lane.exports).toEqual(pair.exports);
  });
});
