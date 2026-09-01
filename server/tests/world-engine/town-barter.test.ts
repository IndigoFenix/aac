// INTERCITY BARTER (city-expansion phase ⑤), at the pure layer — the exact
// kernel quest-host wires. Pins:
//   • the RATIO model: perspective consistency (A's view of the A↔B deal is
//     B's inverse), monotone in scarcity (the scarcer their need for what we
//     give, the better our ratio), bounded (the clamp), deterministic (pure
//     arithmetic; the stub proxy replays).
//   • the SPOKEN QUOTE: small integer pairs inside the speakable quantity
//     words, and whole-batch execution — spoken terms ARE executed terms.
//   • WILLINGNESS: the partner accepts only when the deal relieves its own
//     worst shortages; famine refuses "wont-part", no-need "has-enough".
//   • the AGREEMENT lifecycle on the ② ledger: barter rows serialize round-
//     trip, runDueTransfers SKIPS them, runDueBarters re-derives terms per
//     shipment (shifting scarcities shift the terms), suspends/resumes on
//     the partner's famine (visible, edge-flagged), moves stock BOTH WAYS
//     between the live endpoints, and CONSERVES every unit.
//   • IMPORT DISPLACEMENT (Stage C): the landed-cost min() at quantity
//     fidelity — a lane parks when this town's own ground bears as much of the
//     take-good per day as the caravan hauls in, holds through a hysteresis
//     band, resumes when the orchard is chopped, and can NEVER fire before the
//     orchard stands (supply-based, glyph-specific, never want-based).
// No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  BARTER_DISPLACE_AT,
  BARTER_DISPLACE_RESUME_AT,
  BARTER_FAMINE_MAX,
  BARTER_RATIO_CAP,
  BARTER_RETRY_SEC,
  BARTER_WANT_MIN,
  GEO_FARMLAND_REF,
  barterQuote,
  barterRatio,
  barterSpareFraction,
  barterSpareUnits,
  barterTakePerVisit,
  barterVisitPeriodDays,
  barterWantBatches,
  barterWillingness,
  barterWorth,
  defaultTakeGood,
  geoGoodClass,
  geographyShortageBase,
  importedFlowPerDay,
  localSupplyAtHead,
  localSupplyDisplaces,
  nextShortageBelow,
  runDueBarters,
  stockAbstractPartner,
  stubPartnerSignals,
  type BarterSignals,
  type PartnerGeography,
} from "@shared/world-engine/kernel/town/barter.js";
import {
  complementaryRanking,
  complementaryTrade,
  exportSpareScale,
  freightArrivalFraction,
  freightSurvivesLeg,
} from "@shared/world-engine/kernel/town/complementary.js";
import { carryReachM, freightOf } from "@shared/world-engine/freight.js";
import { dailyTravelM, DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";
import {
  createTransferLedger,
  runDueTransfers,
  stackUnits,
  townEndpointId,
  type PostTransferInput,
  type StockEndpoint,
} from "@shared/world-engine/kernel/town/transfer.js";
import { FOOD_DAY_SEC } from "@shared/world-engine/kernel/town/goods.js";
import { compileEconomy, type EconomyDoc } from "@shared/world-engine/kernel/modules/economy/index.js";
import { createTownWorld } from "@shared/world-engine/kernel/town/town-world.js";
import {
  bookUnitsPerStreetUnit,
  creditDelivery,
  debitDelivery,
} from "@shared/world-engine/interaction/town/town-quests.js";

/** Fixed per-good signals (the test's "town books"). */
const sig = (m: Record<string, number>): BarterSignals => ({
  shortage: (g) => m[g] ?? 0,
});

/** ⚖️ batch 3 · B6 — a two-good village with a REAL granary, so the pairwise
 *  transfer below has two actual ledgers to move book units between (food
 *  banks; cloth banks nothing — the null-leg case). The same minimal document
 *  town-quests.test.ts uses, and for the same reason: the bridge must work for
 *  any compiled content. */
const BOOKS_DOC: EconomyDoc = {
  stockpiles: [{ key: "granary", max: 400, construction: true }],
  commodities: [
    {
      key: "food", scalarMax: 200, perPersonDaily: 0.001,
      transport: { drift: "granary", driftRequiresConstruction: true },
      street: {
        capDays: 3, shopSec: 18, cartRations: 25, unit: "rations", producers: ["farm"], market: true,
        stockColor: "#e0b25c", boxLabel: "Pantry", errandName: "shopping",
      },
    },
    {
      key: "cloth", scalarMax: 50, perPersonDaily: 0.0003,
      transport: {},
      street: {
        capDays: 12, shopSec: 20, cartRations: 12, unit: "bolts", producers: ["weaver"],
        stockColor: "#b8c4de", boxLabel: "Linen chest", errandName: "linens",
      },
    },
  ],
  buildings: [
    {
      key: "farm", countScalar: "farms", cap: { by: "farmland", rate: 1 / 60 },
      processes: [
        { id: "farm", input: "farmland", output: "grain_out", efficiency: 0.08, capacityRate: 5 },
        { id: "mill", input: "grain_out", output: "food_out", efficiency: 1 },
      ],
      vars: [{ name: "grain_out", max: 200 }],
      construction: { tier: "base", costs: [{ stockpile: "granary", amount: 20 }] },
      sells: ["food"], leansToward: "fertility", mapCap: 8, district: "farm",
      style: { color: "#7d9c53", w: 18, h: 12 }, vignette: { w: 5, h: 4 },
      glyph: "🌾", title: "🌾 Farmstead", info: ["{farms} farms."],
    },
    {
      key: "weaver", countScalar: "weavers", cap: { by: "population", rate: 0.002 },
      processes: [{ id: "weave", input: "farmland", output: "cloth_out", efficiency: 0.001, capacityRate: 2 }],
      construction: { tier: "industry", costs: [{ stockpile: "granary", amount: 25 }] },
      sells: ["cloth"], shelved: true, leansToward: null, mapCap: 2, district: "craft",
      style: { color: "#8a7fae", w: 14, h: 10 }, vignette: { w: 4, h: 4 },
      glyph: "🧵", title: "🧵 Weaver", info: ["{weavers} weavers."],
    },
  ],
};
const BOOKS_ECO = compileEconomy([BOOKS_DOC], { construction: true });
/** A stepped town with a stocked granary (its farms banked the overproduction
 *  the flow net drifts — nothing here injects a number by hand). */
const booksTown = (startPop: number) => {
  const town = createTownWorld({
    economy: BOOKS_ECO,
    charter: { farmland: 420, ore_access: 0 },
    startPop,
    seedScalars: { farms: 1 },
    key: `books-${startPop}`,
  });
  town.step(120);
  return town;
};

const ep = (id: string, stack: Record<string, number>): StockEndpoint => ({
  id,
  kind: "town",
  stack,
});

/** A ready-to-post barter agreement input (one-shot unless `every`). */
function barterInput(opts: {
  give: string;
  take: string;
  giveN: number;
  quote: { give: number; take: number };
  partnerKey: string;
  now?: number;
  every?: number;
  dueAt?: number;
}): PostTransferInput {
  return {
    from: "town:yard",
    to: townEndpointId(opts.partnerKey),
    goods: { [opts.give]: opts.giveN },
    issuer: "__player__",
    mode: "scheduled",
    now: opts.now ?? 0,
    ...(opts.every !== undefined ? { every: opts.every } : {}),
    ...(opts.dueAt !== undefined ? { dueAt: opts.dueAt } : {}),
    sourceGlyph: "trade + wood",
    barter: {
      take: { [opts.take]: 0 },
      giveGood: opts.give,
      takeGood: opts.take,
      quote: opts.quote,
      partnerKey: opts.partnerKey,
    },
  };
}

// ── 1. The ratio model — the four pinned properties ─────────────────────────

describe("barterRatio — the scarcity price at the boundary", () => {
  const cases: Array<[Record<string, number>, Record<string, number>]> = [
    [{ wood: 0.0, food: 0.8 }, { wood: 0.9, food: 0.1 }],
    [{ wood: 0.5, food: 0.5 }, { wood: 0.5, food: 0.5 }],
    [{ wood: 1.0, food: 0.0 }, { wood: 0.0, food: 1.0 }],
    [{ wood: 0.2, food: 0.3 }, { wood: 0.7, food: 0.05 }],
  ];

  it("PERSPECTIVE CONSISTENCY — A's view of the deal is exactly B's inverse", () => {
    for (const [a, b] of cases) {
      const rA = barterRatio("wood", "food", sig(a), sig(b));
      const rB = barterRatio("food", "wood", sig(b), sig(a));
      expect(rA * rB).toBeCloseTo(1, 10);
    }
  });

  it("MONOTONE — the scarcer their need for what we give, the better our ratio", () => {
    const us = sig({ wood: 0.1, food: 0.3 });
    let prev = -Infinity;
    for (const need of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const r = barterRatio("wood", "food", us, sig({ wood: need, food: 0.3 }));
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
    // Strict somewhere in the middle (not everything clamped flat).
    expect(barterRatio("wood", "food", us, sig({ wood: 1, food: 0.3 }))).toBeGreaterThan(
      barterRatio("wood", "food", us, sig({ wood: 0, food: 0.3 })),
    );
  });

  it("BOUNDED — no deal goes infinite or free, even at the extremes", () => {
    const desperate = sig({ wood: 1, food: 0 });
    const flush = sig({ wood: 0, food: 1 });
    const r1 = barterRatio("wood", "food", flush, desperate);
    const r2 = barterRatio("food", "wood", desperate, flush);
    for (const r of [r1, r2]) {
      expect(r).toBeGreaterThanOrEqual(1 / BARTER_RATIO_CAP);
      expect(r).toBeLessThanOrEqual(BARTER_RATIO_CAP);
    }
  });

  it("DETERMINISTIC — pure arithmetic of the signals (and worth is pair-symmetric)", () => {
    const [a, b] = cases[3]!;
    const r1 = barterRatio("wood", "food", sig(a), sig(b));
    const r2 = barterRatio("wood", "food", sig(a), sig(b));
    expect(r1).toBe(r2);
    expect(barterWorth("wood", sig(a), sig(b))).toBe(barterWorth("wood", sig(b), sig(a)));
  });

  it("a food-rich, wood-poor town gives more food per wood than a balanced one", () => {
    const balanced = sig({ wood: 0.3, food: 0.3 });
    const woodPoor = sig({ wood: 0.9, food: 0.0 }); // rich in food, starving for wood
    const us = sig({ wood: 0.0, food: 0.5 }); // we have wood, we want food
    // Our wood buys MORE food from the wood-poor town.
    expect(barterRatio("wood", "food", us, woodPoor)).toBeGreaterThan(
      barterRatio("wood", "food", us, balanced),
    );
  });
});

describe("barterQuote — the spoken integer pair", () => {
  it("stays inside the speakable quantity words (1..3 a side) and tracks the ratio", () => {
    const grid = [0, 0.25, 0.5, 0.75, 1];
    for (const uw of grid) {
      for (const tw of grid) {
        const q = barterQuote("wood", "food", sig({ wood: uw, food: 0.2 }), sig({ wood: tw, food: 0.6 }));
        expect(q.give).toBeGreaterThanOrEqual(1);
        expect(q.give).toBeLessThanOrEqual(3);
        expect(q.take).toBeGreaterThanOrEqual(1);
        expect(q.take).toBeLessThanOrEqual(3);
        // The pair is a faithful small-integer read of the ratio.
        expect(Math.abs(q.take / q.give - q.ratio)).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it("balanced towns quote 1-for-1; a partner starving for our good pays more", () => {
    const even = barterQuote("wood", "food", sig({}), sig({}));
    expect(even).toMatchObject({ give: 1, take: 1 });
    const starved = barterQuote(
      "wood",
      "food",
      sig({ wood: 0, food: 0.2 }),
      sig({ wood: 1, food: 0 }),
    );
    expect(starved.take / starved.give).toBeGreaterThan(1); // our wood buys extra
  });
});

// ── 2. Willingness — the partner's honest accept/refuse matrix ──────────────

describe("barterWillingness — the deal must relieve THEIR worst shortages", () => {
  const us = sig({ wood: 0, food: 0.6 });

  it("accepts when they want our give-good more than what they give up", () => {
    expect(barterWillingness("wood", "food", us, sig({ wood: 0.8, food: 0.1 }))).toEqual({ ok: true });
  });

  it('refuses "has-enough" when they barely need what we give', () => {
    const w = barterWillingness("wood", "food", us, sig({ wood: BARTER_WANT_MIN - 0.01, food: 0 }));
    expect(w).toEqual({ ok: false, reason: "has-enough" });
  });

  it('refuses "has-enough" when they need what they give up MORE than our offer', () => {
    const w = barterWillingness("wood", "food", us, sig({ wood: 0.3, food: 0.5 }));
    expect(w).toEqual({ ok: false, reason: "has-enough" });
  });

  it('refuses "wont-part" during their famine on the take-good — famine dominates', () => {
    const w = barterWillingness("wood", "food", us, sig({ wood: 0.9, food: BARTER_FAMINE_MAX }));
    expect(w).toEqual({ ok: false, reason: "wont-part" });
  });

  // ⚖️ RE-PINNED (G1, 2026-08-09). The shipped title was "judges by THEIR books
  // alone — our desperation never flips their answer", and its second line
  // asserted that a town starving for BOTH goods still shipped. That was the
  // one-sided famine law: `barterWillingness` opened with `void us`, so their
  // hunger suspended a route and ours shipped the last of the harvest. The
  // claim the pin was REALLY making — hunger for what we are BUYING is not
  // the partner's business, and never sweetens or sours their verdict — is
  // unchanged and pinned below; what moved is that a famine on what we are
  // SELLING now refuses from our side, by the same constant.
  it("our hunger for what we BUY never flips their answer (their books judge their side)", () => {
    const them = sig({ wood: 0.8, food: 0.1 });
    expect(barterWillingness("wood", "food", sig({}), them).ok).toBe(true);
    // Desperate for the take-good, right up to the extreme: still a deal.
    expect(barterWillingness("wood", "food", sig({ food: 1 }), them).ok).toBe(true);
    expect(barterWillingness("wood", "food", sig({ food: BARTER_FAMINE_MAX }), them).ok).toBe(true);
    // …and a shortage of the GIVE-good short of our own famine changes nothing.
    const nearly = sig({ wood: BARTER_FAMINE_MAX - 1e-9, food: 1 });
    expect(barterWillingness("wood", "food", nearly, them).ok).toBe(true);
  });

  it("🚨 G1 THE MIRROR — OUR famine on the give-good refuses, by the same constant", () => {
    const them = sig({ wood: 0.8, food: 0.1 }); // they would happily take it
    const starving = sig({ wood: BARTER_FAMINE_MAX });
    expect(barterWillingness("wood", "food", starving, them)).toEqual({
      ok: false,
      reason: "we-wont-part",
    });
    // The gate is theirs, exactly: a hair under it and the deal stands.
    expect(barterWillingness("wood", "food", sig({ wood: BARTER_FAMINE_MAX - 1e-9 }), them).ok)
      .toBe(true);
    // THEIR famine still dominates — the shipped precedence is untouched, so a
    // deal where both sides are starving still names the partner first.
    const bothStarved = barterWillingness(
      "wood", "food", sig({ wood: 1 }), sig({ wood: 0.8, food: 1 }),
    );
    expect(bothStarved).toEqual({ ok: false, reason: "wont-part" });
  });

  it("🔒 G1 SYMMETRY — the famine half of the predicate survives the swap", () => {
    // The pair's OWN law, read from either end: swap (give, us) with
    // (take, them) and whether a famine blocks the deal cannot change — only
    // WHICH side is named. This is the property the `void us` line broke.
    const famineCases: Array<[Record<string, number>, Record<string, number>]> = [
      [{ wood: 0.9 }, { wood: 0.8, food: 0.1 }],
      [{ wood: 0 }, { wood: 0.8, food: 0.95 }],
      [{ wood: 0.75 }, { wood: 0.8, food: 0.9 }],
      [{ wood: 0.2 }, { wood: 0.8, food: 0.2 }],
    ];
    const blockedByFamine = (r: ReturnType<typeof barterWillingness>) =>
      !r.ok && (r.reason === "wont-part" || r.reason === "we-wont-part");
    for (const [u, t] of famineCases) {
      const ours = barterWillingness("wood", "food", sig(u), sig(t));
      const theirs = barterWillingness("food", "wood", sig(t), sig(u));
      expect(blockedByFamine(ours)).toBe(blockedByFamine(theirs));
    }
  });
});

// ── 3. The stub proxy — deterministic scarcity for an unsimulated partner ───

describe("stubPartnerSignals — the closed-form partner proxy", () => {
  it("replays: same (partner, good, day) → the same shortage, in [0, 1]", () => {
    const a = stubPartnerSignals("city:14", 40);
    const b = stubPartnerSignals("city:14", 40);
    for (const g of ["wood", "food", "cloth"]) {
      expect(a.shortage(g)).toBe(b.shortage(g));
      expect(a.shortage(g)).toBeGreaterThanOrEqual(0);
      expect(a.shortage(g)).toBeLessThanOrEqual(1);
    }
  });

  it("shifts over the days (terms drift even against a stub) and by partner", () => {
    const days = [0, 3, 6, 9, 12].map((d) => stubPartnerSignals("hamlet-1", d).shortage("wood"));
    expect(new Set(days.map((v) => v.toFixed(6))).size).toBeGreaterThan(1);
    expect(stubPartnerSignals("hamlet-1", 5).shortage("wood")).not.toBe(
      stubPartnerSignals("hamlet-2", 5).shortage("wood"),
    );
  });
});

// ── 3b. GEOGRAPHY CHOOSES WHAT A DISTANT TOWN HAS TO SELL (R&T ⑤ T5) ────────
//
// The hash proxy was BLIND: it made a river-mouth granary as likely to be
// starving as a mining camp. These pin that the terrain now speaks, that it
// speaks THROUGH the same closed form (so the derived wakes still agree with
// the refusals), and — the one that matters most — that a partner whose
// terrain is unknown reads EXACTLY as it did before.

describe("stubPartnerSignals + geography — terrain biases what a stub can spare", () => {
  const KEYS = ["city:14", "hamlet-1", "away:7"];
  const GOODS = ["food", "wood", "stone", "cloth", "clothing", "widget"];

  it("🔒 ABSENT geography is byte-identical to the shipped hash proxy", () => {
    for (const key of KEYS) {
      for (const day of [0, 3, 11, 40]) {
        const shipped = stubPartnerSignals(key, day);
        for (const geo of [undefined, null, {} as PartnerGeography]) {
          const s = stubPartnerSignals(key, day, geo);
          for (const g of GOODS) expect(s.shortage(g)).toBe(shipped.shortage(g));
        }
      }
    }
  });

  it("classes a good by its FREIGHT ROW, never by its name", () => {
    expect(geoGoodClass("food")).toBe("staple"); // the hauler eats the cargo
    expect(geoGoodClass("apple")).toBe("staple");
    expect(geoGoodClass("wood")).toBe("rawBulk"); // barely repays its own haul
    expect(geoGoodClass("stone")).toBe("rawBulk");
    expect(geoGoodClass("cloth")).toBe("refined");
    expect(geoGoodClass("clothing")).toBe("refined");
    // An undeclared good sits at the staple anchor and durable — no class,
    // therefore no geographic opinion (the honest "we don't know").
    expect(geoGoodClass("widget")).toBeNull();
    expect(geographyShortageBase("widget", { node: "surplus" })).toBeNull();
  });

  it("SURPLUS/MOUTH country has food to sell; EXTRACTION country does not", () => {
    for (const key of KEYS) {
      for (const day of [0, 5, 9]) {
        const surplus = stubPartnerSignals(key, day, { node: "surplus" }).shortage("food");
        const mouth = stubPartnerSignals(key, day, { node: "mouth" }).shortage("food");
        const mine = stubPartnerSignals(key, day, { node: "extraction" }).shortage("food");
        expect(surplus).toBeLessThan(mine);
        expect(mouth).toBeLessThan(mine);
      }
    }
  });

  it("EXTRACTION country has ore/stone to sell; a SHADOW town is desperate for refined goods", () => {
    for (const key of KEYS) {
      const mine = stubPartnerSignals(key, 4, { node: "extraction" });
      const port = stubPartnerSignals(key, 4, { node: "mouth" });
      expect(mine.shortage("stone")).toBeLessThan(port.shortage("stone"));
      expect(mine.shortage("wood")).toBeLessThan(port.shortage("wood"));
      // Shadow: grows its own food, cannot get manufactures — the refining
      // license, read from the other side of the road.
      const shadow = stubPartnerSignals(key, 4, { node: "shadow" });
      const rich = stubPartnerSignals(key, 4, { node: "surplus" });
      expect(shadow.shortage("cloth")).toBeGreaterThan(rich.shortage("cloth"));
      expect(shadow.shortage("food")).toBeLessThan(mine.shortage("food"));
    }
  });

  it("the CONTINUOUS charter reading is monotone — more farmland, less hunger", () => {
    let prev = Infinity;
    for (const farmland of [0, 45, 90, GEO_FARMLAND_REF, GEO_FARMLAND_REF * 3]) {
      const s = stubPartnerSignals("city:14", 6, { farmland }).shortage("food");
      expect(s).toBeLessThanOrEqual(prev);
      prev = s;
    }
    expect(stubPartnerSignals("city:14", 6, { farmland: 0 }).shortage("food")).toBeGreaterThan(
      stubPartnerSignals("city:14", 6, { farmland: GEO_FARMLAND_REF * 3 }).shortage("food"),
    );
  });

  it("stays a PURE function of (key, day, geography) — replays, drifts, bounded", () => {
    const geo: PartnerGeography = { node: "extraction", farmland: 20, ore: 120 };
    for (const g of GOODS) {
      expect(stubPartnerSignals("city:2", 7, geo).shortage(g)).toBe(
        stubPartnerSignals("city:2", 7, { ...geo }).shortage(g),
      );
      for (const day of [0, 4, 8, 12, 16]) {
        const v = stubPartnerSignals("city:2", day, geo).shortage(g);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    // The season still moves the terms — geography is a BASE, not a freeze.
    const days = [0, 3, 6, 9, 12].map((d) => stubPartnerSignals("city:2", d, geo).shortage("food"));
    expect(new Set(days.map((v) => v.toFixed(6))).size).toBeGreaterThan(1);
  });

  it("the FORWARD SAMPLERS still read the same closed form a geo partner quotes from", () => {
    const geo: PartnerGeography = { node: "extraction" };
    const atDay = (d: number) => stubPartnerSignals("city:33", d, geo);
    const day = nextShortageBelow(atDay, "food", BARTER_FAMINE_MAX, 0);
    // Whatever it answers, the answer must be TRUE of the very signal the
    // refusal read — a wake that disagreed with its predicate is the bug.
    if (day !== null) expect(atDay(day).shortage("food")).toBeLessThan(BARTER_FAMINE_MAX);
  });
});

// ── 3c. COMPLEMENTARY SCARCITY — what this pair has for each other (T2) ─────

describe("complementaryTrade — their surplus ∩ our shortage, over a real road", () => {
  const SCALE = DOLLHOUSE_SCALE;
  const GOODS = ["food", "wood", "cloth", "clothing"];
  const us = sig({ cloth: 0.9, clothing: 0.4, food: 0.02, wood: 0 });
  const them = sig({ cloth: 0, clothing: 0.05, food: 0.8, wood: 0.3 });

  it("lists what they can spare that we lack, best first — and the mirror", () => {
    const pair = complementaryTrade(us, them, GOODS, 300, SCALE);
    expect(pair.imports).toEqual(["cloth", "clothing"]);
    expect(pair.exports).toEqual(["food", "wood"]);
  });

  it("🔒 PERSPECTIVE CONSISTENCY — A's imports from B ⊆ B's exports to A", () => {
    const a = complementaryTrade(us, them, GOODS, 300, SCALE);
    const b = complementaryTrade(them, us, GOODS, 300, SCALE);
    for (const g of a.imports) expect(b.exports).toContain(g);
    for (const g of a.exports) expect(b.imports).toContain(g);
    expect(a.imports).toEqual(b.exports); // in fact the same list, same order
  });

  it("a good NEITHER side can spare, or neither wants, is on no list", () => {
    const both = sig({ food: 0.9, cloth: 0.9 });
    const pair = complementaryTrade(both, both, ["food", "cloth"], 100, SCALE);
    expect(pair).toEqual({ imports: [], exports: [] });
    const flush = sig({});
    expect(complementaryTrade(flush, flush, GOODS, 100, SCALE)).toEqual({
      imports: [], exports: [],
    });
  });

  it("🔒 THE FREIGHT FILTER — a fragile good never makes the list, however short they are", () => {
    // The leg is past MILK's own reach (it sours before it lands) but well
    // inside CLOTH's — derived from the freight rows, not from a literal.
    const legM = carryReachM(SCALE, freightOf("milk")) * 1.5;
    expect(freightSurvivesLeg("milk", legM, SCALE)).toBe(false);
    expect(freightSurvivesLeg("cloth", legM, SCALE)).toBe(true);
    // Maximum desperation on our side, maximum surplus on theirs: it changes
    // nothing. Desperation is not a preservative.
    const desperate = sig({ milk: 1, cloth: 1 });
    const flush = sig({ milk: 0, cloth: 0 });
    const pair = complementaryTrade(desperate, flush, ["milk", "cloth"], legM, SCALE);
    expect(pair.imports).toEqual(["cloth"]);
    expect(pair.imports).not.toContain("milk");
    // Short enough a road and the same milk DOES travel — the filter is the
    // road's arithmetic, never a ban on the good.
    expect(
      complementaryTrade(desperate, flush, ["milk"], legM / 10, SCALE).imports,
    ).toEqual(["milk"]);
  });

  it("ranks by NEED and breaks ties toward the earlier good (deterministic)", () => {
    const need = sig({ wood: 0.5, cloth: 0.5, clothing: 0.9 });
    const spare = sig({});
    const pair = complementaryTrade(need, spare, ["wood", "cloth", "clothing"], 200, SCALE);
    expect(pair.imports).toEqual(["clothing", "wood", "cloth"]);
    expect(complementaryTrade(need, spare, ["wood", "cloth", "clothing"], 200, SCALE)).toEqual(pair);
  });

  it("reads the WANT LINE the willingness refusal reads — one threshold, not two", () => {
    const spare = sig({ cloth: BARTER_WANT_MIN - 1e-9 }); // just barely "enough"
    const need = sig({ cloth: BARTER_WANT_MIN });
    expect(complementaryTrade(need, spare, ["cloth"], 100, SCALE).imports).toEqual(["cloth"]);
    // Nudge their own need up to the line and they no longer have it spare.
    const holding = sig({ cloth: BARTER_WANT_MIN });
    expect(complementaryTrade(need, holding, ["cloth"], 100, SCALE).imports).toEqual([]);
  });

  // ⚖️ G3 — the ranking's own evidence, kept instead of discarded.
  it("🔒 `complementaryTrade` IS `complementaryRanking`'s names — one rule, two shapes", () => {
    const rank = complementaryRanking(us, them, GOODS, 300, SCALE);
    const names = complementaryTrade(us, them, GOODS, 300, SCALE);
    expect(rank.imports.map((r) => r.good)).toEqual(names.imports);
    expect(rank.exports.map((r) => r.good)).toEqual(names.exports);
    // The names-only shape is UNCHANGED — no field crept onto it.
    expect(Object.keys(names).sort()).toEqual(["exports", "imports"]);
  });

  it("🚨 the `want` carried is the needing side's shortage AS LANDED, in ranked order", () => {
    const rank = complementaryRanking(us, them, GOODS, 300, SCALE);
    // ⚖️ IMPORT-DISPLACEMENT ROUND, STAGE B — the row weight is now
    // `shortage × freightArrivalFraction`, the continuous producer+freight
    // half of landed cost. cloth and clothing are DURABLE (the ox never eats
    // the cargo) so their fraction is exactly 1 and these two numbers are the
    // pre-Stage-B ones, unchanged, to the bit.
    expect(freightArrivalFraction("cloth", 300, SCALE)).toBe(1);
    expect(freightArrivalFraction("clothing", 300, SCALE)).toBe(1);
    expect(rank.imports).toEqual([
      { good: "cloth", want: 0.9 },
      { good: "clothing", want: 0.4 },
    ]);
    // The mirror reads THEIR shortages, not ours — and FOOD is selfConsuming,
    // so a day-fraction of road eats part of the cart and it bids that much
    // lower. Derived from the freight row, never a literal (0.8 × ~0.918).
    const landedFood = 0.8 * freightArrivalFraction("food", 300, SCALE);
    expect(landedFood).toBeLessThan(0.8);
    expect(rank.exports).toEqual([
      { good: "food", want: landedFood },
      { good: "wood", want: 0.3 }, // rawBulk but DURABLE ⇒ 1
    ]);
    // Descending, and each row still bounded by the raw shortage that admitted
    // it — the ADMISSION gate reads the shortage, the BID reads what lands, so
    // a weight below `BARTER_WANT_MIN` is legal where a shortage below it is
    // not (nothing here is: the fractions are all near 1).
    for (const r of rank.imports) expect(r.want).toBeLessThanOrEqual(us.shortage(r.good));
    for (const r of rank.exports) expect(r.want).toBeLessThanOrEqual(them.shortage(r.good));
    for (const r of [...rank.imports, ...rank.exports]) expect(r.want).toBeGreaterThan(0);
  });

  // ⚖️ STAGE B — the freight term in the rank, on its own.
  it("🚨 THE LANDED BID: a lossy good re-ranks below a durable one it outweighed", () => {
    // Both wanted the same on paper. `cloth` is durable; `food` is eaten by
    // its own haulers, and far enough out it lands less than the cloth does.
    // 0.4 of reach — INSIDE the 0.5 survival floor (a selfConsuming good loses
    // linearly to its reach, so the floor sits at half of it), which is the
    // whole point: the re-rank happens on legs the gate still admits.
    const legM = carryReachM(SCALE, freightOf("food")) * 0.4;
    expect(freightSurvivesLeg("food", legM, SCALE)).toBe(true); // the FLOOR holds
    expect(freightArrivalFraction("food", legM, SCALE)).toBeLessThan(1);
    expect(freightArrivalFraction("cloth", legM, SCALE)).toBe(1);
    const need = sig({ food: 0.6, cloth: 0.5 });
    const spare = sig({});
    // On no road at all, appetite alone ranks them: food first.
    expect(complementaryTrade(need, spare, ["food", "cloth"], 0, SCALE).imports)
      .toEqual(["food", "cloth"]);
    // Over the long leg the cart arrives smaller, and cloth outbids it.
    expect(0.6 * freightArrivalFraction("food", legM, SCALE)).toBeLessThan(0.5);
    expect(complementaryTrade(need, spare, ["food", "cloth"], legM, SCALE).imports)
      .toEqual(["cloth", "food"]);
  });

  it("🔒 the degenerate legs deliver EVERYTHING — the gate's own two reads", () => {
    // No road between them, and a world whose legs take no time: fraction 1,
    // so the weight is the raw shortage and nothing re-ranks. These are
    // `freightSurvivesLeg`'s `m > 0` and `perDay > 0` guards verbatim (the
    // reach test is the FLOOR's business, not the slope's — a leg past reach
    // is refused outright and never reaches a weight at all).
    expect(freightArrivalFraction("food", 0, SCALE)).toBe(1);
    expect(freightArrivalFraction("food", -50, SCALE)).toBe(1);
    expect(freightSurvivesLeg("food", 0, SCALE)).toBe(true);
    const still = { ...SCALE, dayLengthS: 0 };
    expect(dailyTravelM(still)).toBe(0);
    expect(freightArrivalFraction("food", 300, still)).toBe(1);
    // A ranked row over that leg carries its raw shortage, unweighted.
    expect(complementaryRanking(sig({ food: 0.6 }), sig({}), ["food"], 0, SCALE).imports)
      .toEqual([{ good: "food", want: 0.6 }]);
  });
});

// ── 3d. G2 — the export cliff, converted to a margin ────────────────────────

describe("exportSpareScale — the want gate as a slope", () => {
  it("🔒 a fully fed town exports everything, to the bit", () => {
    expect(exportSpareScale(0)).toBe(1);
    expect(exportSpareScale(-1)).toBe(1); // clamped — never over 1
  });

  it("🚨 hits ZERO exactly at BARTER_WANT_MIN — the same line the list draws", () => {
    expect(exportSpareScale(BARTER_WANT_MIN)).toBe(0);
    expect(exportSpareScale(0.5)).toBe(0);
    expect(exportSpareScale(1)).toBe(0);
    // The gate is shared with the derived list, so the volume can never
    // disagree with whether the good is listed at all: at the exact shortage
    // where a good stops being spare, its scale is already 0.
    const need = sig({ cloth: 0.9 });
    const atGate = sig({ cloth: BARTER_WANT_MIN });
    expect(complementaryTrade(need, atGate, ["cloth"], 100, DOLLHOUSE_SCALE).imports).toEqual([]);
    expect(exportSpareScale(BARTER_WANT_MIN)).toBe(0);
  });

  it("🚨 the approach is CONTINUOUS — a margin, not a cliff", () => {
    const step = 0.0005;
    let prev = exportSpareScale(0);
    let biggestDrop = 0;
    for (let s = step; s <= 1 + 1e-9; s += step) {
      const v = exportSpareScale(s);
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      biggestDrop = Math.max(biggestDrop, prev - v);
      prev = v;
    }
    expect(biggestDrop).toBeLessThan(step / BARTER_WANT_MIN + 1e-9);
    expect(exportSpareScale(BARTER_WANT_MIN / 2)).toBeCloseTo(0.5, 12);
  });

  it("🔒 it is the FAMINE slope's twin — one shape, two gates", () => {
    // Both are `(gate − shortage) / gate`; only the constant differs, which is
    // the whole claim (a want gate governs the surplus, a famine gate the
    // shelf). Checked at the same FRACTION of each gate, where they agree.
    for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
      expect(exportSpareScale(BARTER_WANT_MIN * frac))
        .toBeCloseTo(barterSpareFraction(BARTER_FAMINE_MAX * frac), 12);
    }
  });
});

describe("defaultTakeGood — the clerk answers with what the town needs", () => {
  it("picks our worst shortage, never the give-good; ties to the earlier good", () => {
    const us = sig({ food: 0.7, cloth: 0.2, wood: 0.9 });
    expect(defaultTakeGood(["food", "cloth", "wood"], "wood", us)).toBe("food");
    expect(defaultTakeGood(["food", "cloth"], "wood", sig({ food: 0.5, cloth: 0.5 }))).toBe("food");
    expect(defaultTakeGood(["wood"], "wood", us)).toBeNull();
  });
});

// ── 4. Agreement lifecycle on the ② ledger ──────────────────────────────────

describe("barter agreements — the ⑤ flavor on the ② ledger", () => {
  it("serializes round-trip: terms, quote, partner and the suspended flag survive", () => {
    const led = createTransferLedger();
    const a = led.post(
      barterInput({ give: "wood", take: "food", giveN: 4, quote: { give: 2, take: 1 }, partnerKey: "hamlet-1", every: FOOD_DAY_SEC }),
    );
    a.barter!.suspended = true;
    const revived = createTransferLedger(JSON.parse(JSON.stringify(led.toJSON())));
    const back = revived.get(a.id)!;
    expect(back.barter).toEqual({
      take: { food: 0 },
      giveGood: "wood",
      takeGood: "food",
      quote: { give: 2, take: 1 },
      partnerKey: "hamlet-1",
      suspended: true,
    });
    expect(back.every).toBe(FOOD_DAY_SEC);
  });

  it("honors an explicit dueAt — the caravan takes travel time before landing", () => {
    const led = createTransferLedger();
    led.post(barterInput({ give: "wood", take: "food", giveN: 2, quote: { give: 1, take: 1 }, partnerKey: "p", dueAt: 84 }));
    expect(led.due(50)).toHaveLength(0);
    expect(led.due(84)).toHaveLength(1);
  });

  it("runDueTransfers SKIPS barter rows — they belong to the barter executor", () => {
    const led = createTransferLedger();
    const yard = ep("town:yard", { wood: 5 });
    const partner = ep("town:p", { food: 5 });
    led.post(barterInput({ give: "wood", take: "food", giveN: 2, quote: { give: 1, take: 1 }, partnerKey: "p", dueAt: 0 }));
    const reports = runDueTransfers(led, (id) => (id === "town:yard" ? yard : partner), 10);
    expect(reports).toHaveLength(0);
    expect(yard.stack.wood).toBe(5); // untouched — no one-way leak
  });
});

// ── 5. Caravan execution — stock moves BOTH ways, terms re-derive per leg ───

describe("runDueBarters — the shipment executor", () => {
  const resolver = (yard: StockEndpoint, partner: StockEndpoint) => (id: string) =>
    id === "town:yard" ? yard : id === partner.id ? partner : null;

  it("ships whole quote batches both ways between the REAL endpoints, conserving", () => {
    const led = createTransferLedger();
    const yard = ep("town:yard", { wood: 5 });
    const partner = ep(townEndpointId("hamlet-1"), { food: 9 });
    // us: wood-rich food-poor; them: wood-poor food-rich → wood buys food 2:1-ish.
    const us = sig({ wood: 0, food: 1 });
    const them = sig({ wood: 1, food: 0 });
    led.post(barterInput({ give: "wood", take: "food", giveN: 5, quote: { give: 1, take: 1 }, partnerKey: "hamlet-1", dueAt: 0 }));
    const [r] = runDueBarters(led, resolver(yard, partner), 1, { us, themOf: () => them });
    expect(r!.status).toBe("shipped");
    const q = barterQuote("wood", "food", us, them);
    expect(r!.quote).toEqual({ give: q.give, take: q.take }); // terms re-derived off live signals
    const batches = Math.floor(5 / q.give);
    expect(r!.sent).toEqual({ wood: batches * q.give });
    expect(r!.received).toEqual({ food: batches * q.take });
    // Whole batches only — the remainder honestly stays home.
    expect(yard.stack.wood ?? 0).toBe(5 - batches * q.give);
    expect(partner.stack.wood ?? 0).toBe(batches * q.give);
    // CONSERVATION across the pair, both goods.
    expect((yard.stack.food ?? 0) + (partner.stack.food ?? 0)).toBe(9);
    expect((yard.stack.wood ?? 0) + (partner.stack.wood ?? 0)).toBe(5);
    // One-shot → done.
    expect(led.active()).toHaveLength(0);
  });

  it("re-derives terms per shipment on a standing route — shifting scarcity shifts the deal", () => {
    const led = createTransferLedger();
    const yard = ep("town:yard", { wood: 40 });
    const partner = ep(townEndpointId("hamlet-1"), { food: 40 });
    const us = sig({ wood: 0, food: 0.2 });
    let theirNeed = 0.1; // barely wants wood… then a shortage bites
    const them: BarterSignals = { shortage: (g) => (g === "wood" ? theirNeed : 0) };
    led.post(
      barterInput({ give: "wood", take: "food", giveN: 3, quote: { give: 1, take: 1 }, partnerKey: "hamlet-1", every: FOOD_DAY_SEC, dueAt: 0 }),
    );
    theirNeed = 0.3;
    const [leg1] = runDueBarters(led, resolver(yard, partner), 0, { us, themOf: () => them });
    expect(leg1!.status).toBe("shipped");
    theirNeed = 1; // their wood famine deepens — our wood is worth more now
    const [leg2] = runDueBarters(led, resolver(yard, partner), FOOD_DAY_SEC, { us, themOf: () => them });
    expect(leg2!.status).toBe("shipped");
    const value = (q: { give: number; take: number }) => q.take / q.give;
    expect(value(leg2!.quote)).toBeGreaterThan(value(leg1!.quote)); // better terms for us
    // The row itself shows the re-derived terms (attached to the agreement).
    expect(led.active()[0]!.barter!.quote).toEqual(leg2!.quote);
  });

  it("suspends a standing route on the partner's famine (edge-flagged) and RESUMES after", () => {
    const led = createTransferLedger();
    const yard = ep("town:yard", { wood: 30 });
    const partner = ep(townEndpointId("hamlet-1"), { food: 30 });
    const us = sig({ wood: 0, food: 0.4 });
    let famine = 0;
    const them: BarterSignals = { shortage: (g) => (g === "wood" ? 0.8 : famine) };
    const a = led.post(
      barterInput({ give: "wood", take: "food", giveN: 2, quote: { give: 1, take: 1 }, partnerKey: "hamlet-1", every: FOOD_DAY_SEC, dueAt: 0 }),
    );
    famine = 0.9; // their food famine: "they won't part with food"
    const [s1] = runDueBarters(led, resolver(yard, partner), 0, { us, themOf: () => them });
    expect(s1).toMatchObject({ status: "suspended", reason: "wont-part", newlySuspended: true });
    expect(yard.stack.wood).toBe(30); // nothing moved
    expect(led.get(a.id)!.barter!.suspended).toBe(true); // status VISIBLE on the row
    const [s2] = runDueBarters(led, resolver(yard, partner), FOOD_DAY_SEC, { us, themOf: () => them });
    expect(s2).toMatchObject({ status: "suspended", newlySuspended: false }); // nags once
    famine = 0.1; // the famine ends — the route comes back by itself
    const [s3] = runDueBarters(led, resolver(yard, partner), FOOD_DAY_SEC * 2, { us, themOf: () => them });
    expect(s3!.status).toBe("resumed");
    expect(s3!.sent.wood).toBeGreaterThan(0);
    expect(led.get(a.id)!.barter!.suspended).toBe(false);
  });

  it("a stalled ONE-SHOT waits (re-armed a day out) instead of failing or vanishing", () => {
    const led = createTransferLedger();
    const yard = ep("town:yard", { wood: 4 });
    const partner = ep(townEndpointId("p"), { food: 9 });
    const us = sig({});
    const them = sig({ wood: 0.8, food: 0.9 }); // famine on food → wont-part
    const a = led.post(barterInput({ give: "wood", take: "food", giveN: 2, quote: { give: 1, take: 1 }, partnerKey: "p", dueAt: 0 }));
    runDueBarters(led, resolver(yard, partner), 0, { us, themOf: () => them });
    expect(led.get(a.id)!.status).toBe("pending"); // still alive, visibly waiting
    expect(led.get(a.id)!.nextDueAt).toBe(BARTER_RETRY_SEC);
  });

  it('reports "short" (edge-flagged pause) when OUR yard can\'t cover one batch — nothing minted, nothing lost', () => {
    const led = createTransferLedger();
    const yard = ep("town:yard", { wood: 1 });
    const partner = ep(townEndpointId("p"), { food: 9 });
    // We offer CLOTH we don't hold — our stock can't cover a single batch.
    const a = led.post(
      barterInput({ give: "cloth", take: "food", giveN: 2, quote: { give: 1, take: 1 }, partnerKey: "p", every: FOOD_DAY_SEC, dueAt: 0 }),
    );
    const them = () => sig({ cloth: 0.9, food: 0.1 });
    const [r1] = runDueBarters(led, resolver(yard, partner), 0, { us: sig({}), themOf: them });
    expect(r1).toMatchObject({ status: "short", newlySuspended: true }); // paused VISIBLY
    expect(led.get(a.id)!.barter!.suspended).toBe(true);
    const [r2] = runDueBarters(led, resolver(yard, partner), FOOD_DAY_SEC, { us: sig({}), themOf: them });
    expect(r2).toMatchObject({ status: "short", newlySuspended: false }); // nags once
    expect(yard.stack).toEqual({ wood: 1 });
    expect(partner.stack).toEqual({ food: 9 });
    // Stock the yard — the route comes back by itself, reported "resumed".
    yard.stack.cloth = 4;
    const [r3] = runDueBarters(led, resolver(yard, partner), FOOD_DAY_SEC * 2, { us: sig({}), themOf: them });
    expect(r3!.status).toBe("resumed");
    expect(r3!.sent.cloth).toBeGreaterThan(0);
  });

  it("a STANDING route flexes to at least one batch when re-derived terms outgrow its units", () => {
    const led = createTransferLedger();
    const yard = ep("town:yard", { wood: 20 });
    const partner = ep(townEndpointId("hamlet-1"), { food: 20 });
    // Terms 2:1 against us (they barely want wood… but still willing), while
    // the standing order carries only 1 wood — a one-shot would stall; the
    // standing route ships ONE whole batch instead (the route stays alive).
    const us = sig({ wood: 0, food: 1 }); // we're desperate for food — worse terms
    const them = sig({ wood: 0.4, food: 0 });
    led.post(
      barterInput({ give: "wood", take: "food", giveN: 1, quote: { give: 1, take: 1 }, partnerKey: "hamlet-1", every: FOOD_DAY_SEC, dueAt: 0 }),
    );
    const [r] = runDueBarters(led, resolver(yard, partner), 0, { us, themOf: () => them });
    const q = barterQuote("wood", "food", us, them);
    expect(q.give).toBeGreaterThan(1); // the premise: one ordered unit < one batch
    expect(r!.status).toBe("shipped");
    expect(r!.sent).toEqual({ wood: q.give }); // exactly one whole batch
    expect(r!.received).toEqual({ food: q.take });
  });

  it("clamps to the PARTNER's real shelf too — a real neighbor can run dry", () => {
    const led = createTransferLedger();
    const yard = ep("town:yard", { wood: 9 });
    const partner = ep(townEndpointId("hamlet-1"), { food: 1 });
    const us = sig({});
    const them = sig({ wood: 0.9, food: 0.1 });
    led.post(barterInput({ give: "wood", take: "food", giveN: 9, quote: { give: 1, take: 1 }, partnerKey: "hamlet-1", dueAt: 0 }));
    const [r] = runDueBarters(led, resolver(yard, partner), 0, { us, themOf: () => them });
    const q = barterQuote("wood", "food", us, them);
    const batches = Math.min(Math.floor(9 / q.give), Math.floor(1 / q.take));
    if (batches > 0) {
      expect(r!.status).toBe("shipped");
      expect(r!.received.food).toBe(batches * q.take);
    } else {
      expect(r!.status).toBe("short");
    }
    expect((yard.stack.food ?? 0) + (partner.stack.food ?? 0)).toBe(1); // conserved either way
  });

  it("fails NAMED when the partner endpoint/signals can't resolve", () => {
    const led = createTransferLedger();
    const yard = ep("town:yard", { wood: 5 });
    const a = led.post(barterInput({ give: "wood", take: "food", giveN: 2, quote: { give: 1, take: 1 }, partnerKey: "ghost", dueAt: 0 }));
    runDueBarters(led, (id) => (id === "town:yard" ? yard : null), 0, { us: sig({}), themOf: () => null });
    expect(led.get(a.id)).toMatchObject({ status: "failed", failReason: "no-endpoint" });
  });

  it("is deterministic and replayable — same ledger JSON + clock ⇒ identical reports", () => {
    const build = () => {
      const led = createTransferLedger();
      led.post(
        barterInput({ give: "wood", take: "food", giveN: 6, quote: { give: 1, take: 1 }, partnerKey: "city:9", every: FOOD_DAY_SEC, dueAt: 0 }),
      );
      return led;
    };
    const run = (led: ReturnType<typeof createTransferLedger>) => {
      const yard = ep("town:yard", { wood: 12 });
      const partner = ep(townEndpointId("city:9"), {});
      stockAbstractPartner(partner.stack, "food", 9); // the stub's deterministic mint
      const out: unknown[] = [];
      for (const t of [0, FOOD_DAY_SEC, FOOD_DAY_SEC * 2]) {
        out.push(
          runDueBarters(led, resolver(yard, partner), t, {
            us: sig({ food: 0.5 }),
            themOf: (k) => stubPartnerSignals(k, Math.floor(t / FOOD_DAY_SEC)),
          }),
        );
      }
      return JSON.stringify({ out, yard: yard.stack, ledger: led.toJSON() });
    };
    const first = run(build());
    const revived = createTransferLedger(JSON.parse(JSON.stringify(build().toJSON())));
    expect(run(revived)).toBe(first);
  });
});

// ── 6. G1 — THE SPARE (the famine law as a volume, not only a verdict) ──────
//
// economy-arc-opening.md batch 2, G1. `runDueBarters` used to bound a shipment
// by raw `stackUnits`, so the executor and the willingness predicate disagreed
// about whether a town may starve itself — and only the ungated one moved
// stock. The bound is now the SPARE: the shelf above the reserve the same
// famine constant implies, which reaches zero exactly where the refusal fires.

describe("barterSpareFraction — the famine wall, read as a slope", () => {
  it("🔒 a FED town spares everything, to the bit", () => {
    // Not "close to 1" — EXACTLY 1, which is what makes every shipped
    // shipment's arithmetic byte-identical to the pre-G1 line.
    expect(barterSpareFraction(0)).toBe(1);
    expect(barterSpareFraction(-5)).toBe(1); // clamped, never over-spared
    expect(barterSpareUnits({ wood: 7 }, "wood", 0)).toBe(7);
    expect(barterSpareUnits({}, "wood", 0)).toBe(0);
  });

  it("🚨 reaches ZERO exactly AT the gate the refusal fires at — and stays there", () => {
    expect(barterSpareFraction(BARTER_FAMINE_MAX)).toBe(0);
    expect(barterSpareFraction(0.9)).toBe(0);
    expect(barterSpareFraction(1)).toBe(0);
    expect(barterSpareUnits({ wood: 40 }, "wood", BARTER_FAMINE_MAX)).toBe(0);
  });

  it("🚨 THE APPROACH IS CONTINUOUS — no cliff anywhere on the way to the gate", () => {
    // Sampled finely across the whole range: strictly decreasing before the
    // gate, and no single step ever drops more than the step size warrants
    // (the shipped behaviour was a 1 → 0 cliff AT the gate with a flat 1
    // everywhere below it).
    const step = 0.001;
    let prev = barterSpareFraction(0);
    let biggestDrop = 0;
    for (let s = step; s <= 1 + 1e-9; s += step) {
      const v = barterSpareFraction(s);
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      biggestDrop = Math.max(biggestDrop, prev - v);
      prev = v;
    }
    // One step of shortage can only cost one step's worth of spare.
    expect(biggestDrop).toBeLessThan(step / BARTER_FAMINE_MAX + 1e-9);
    // Halfway to famine, half the shelf stays home.
    expect(barterSpareFraction(BARTER_FAMINE_MAX / 2)).toBeCloseTo(0.5, 12);
  });
});

describe("runDueBarters — batches are bounded by the SPARE, not the shelf", () => {
  const resolver = (yard: StockEndpoint, partner: StockEndpoint) => (id: string) =>
    id === "town:yard" ? yard : id === partner.id ? partner : null;
  /** They want wood badly and have food to spare — willing at every step, so
   *  the only thing that moves below is OUR side's hunger. */
  const THEM = sig({ wood: 0.8, food: 0 });
  const ship = (ourShortage: number, stock = 12) => {
    const led = createTransferLedger();
    const yard = ep("town:yard", { wood: stock });
    const partner = ep(townEndpointId("hamlet-1"), { food: 99 });
    led.post(
      barterInput({
        give: "wood", take: "food", giveN: stock, quote: { give: 1, take: 1 },
        partnerKey: "hamlet-1", every: FOOD_DAY_SEC, dueAt: 0,
      }),
    );
    const us = sig({ wood: ourShortage });
    const [r] = runDueBarters(led, resolver(yard, partner), 0, { us, themOf: () => THEM });
    return { report: r!, quote: barterQuote("wood", "food", us, THEM) };
  };

  it("🔒 a FED town's shipment is EXACTLY the pre-G1 raw-shelf arithmetic", () => {
    const { report, quote } = ship(0);
    // Measured against the formula the module used to run, not asserted.
    expect(report.status).toBe("shipped");
    expect(report.sent.wood).toBe(Math.floor(12 / quote.give) * quote.give);
  });

  it("🚨 A TOWN AT FAMINE ON G SHIPS ZERO G ON A STANDING ROUTE", () => {
    const { report } = ship(BARTER_FAMINE_MAX);
    expect(report.status).toBe("suspended");
    expect(report.reason).toBe("we-wont-part");
    expect(report.sent).toEqual({});
    expect(report.received).toEqual({});
  });

  it("🚨 and it THINS on the way down — the standing route never jumps full → nothing", () => {
    // The same shelf, the same partner, the same order: only our own hunger
    // moves. The volume falls step by step instead of surviving intact until
    // the gate and vanishing there (which is what the raw-shelf bound did).
    const sent: number[] = [];
    for (const s of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) {
      const { report } = ship(s, 20);
      expect(report.status).toBe("shipped");
      sent.push(report.sent.wood ?? 0);
    }
    expect(sent).toEqual([20, 17, 14, 11, 8, 5, 2]); // measured, not asserted
    for (let i = 1; i < sent.length; i++) expect(sent[i]!).toBeLessThan(sent[i - 1]!);
    // Nearer still, the spare can no longer cover one whole batch and the
    // route pauses VISIBLY — the shipped "whole batches only" law, met on the
    // way down rather than at a wall.
    const nearly = ship(BARTER_FAMINE_MAX - 0.01, 20);
    expect(nearly.report.status).toBe("short");
    expect(nearly.report.sent).toEqual({});
  });

  it("the SPARE, not the order, is what binds — a hungry town under-ships a full order", () => {
    // Half-starved: the yard holds 20 and the order asks for all 20, but only
    // the spare half may go. Nothing is minted and nothing vanishes.
    const led = createTransferLedger();
    const yard = ep("town:yard", { wood: 20 });
    const partner = ep(townEndpointId("hamlet-1"), { food: 99 });
    led.post(
      barterInput({
        give: "wood", take: "food", giveN: 20, quote: { give: 1, take: 1 },
        partnerKey: "hamlet-1", every: FOOD_DAY_SEC, dueAt: 0,
      }),
    );
    const us = sig({ wood: BARTER_FAMINE_MAX / 2 });
    // Read the bound BEFORE the shipment drains the very shelf it is read off.
    const q = barterQuote("wood", "food", us, THEM);
    const spare = barterSpareUnits({ ...yard.stack }, "wood", BARTER_FAMINE_MAX / 2);
    expect(spare).toBeCloseTo(10, 9); // half-starved ⇒ half the shelf stays home
    const [r] = runDueBarters(led, resolver(yard, partner), 0, { us, themOf: () => THEM });
    expect(r!.sent.wood).toBe(Math.floor(spare / q.give) * q.give);
    expect(r!.sent.wood).toBeLessThan(20);
    expect((yard.stack.wood ?? 0) + (partner.stack.wood ?? 0)).toBe(20); // conserved
  });

  // ⚖️ batch 3 · B6 — THE CONSERVATION PIN GROWS A BOOKS LEG.
  //
  // The pin above conserves the YARDS. Until B6 the BOOKS were a one-way
  // valve beside them: an arriving shipment credited our stockpile
  // (`creditDelivery`, batch 1) and a departing one debited nothing at all,
  // anywhere. So a standing route could ship the granary away all season while
  // the aggregate reported the same supply — free lunch #3, at the barter
  // rung. The mechanism is PAIRWISE (the tribe-mode scope test): debit our
  // ledger, credit theirs, conserved. Both towns here are REAL `TownWorld`s,
  // so nothing is stubbed and nothing is minted.
  it("🚨 B6 THE PAIRWISE LEG: yard + partner yard + BOTH books, conserved end to end", () => {
    const ourTown = booksTown(80);
    const theirTown = booksTown(60);
    theirTown.inject("granary", -50); // room below the stockpile cap to receive into
    const bridge = bookUnitsPerStreetUnit(BOOKS_ECO, "food");
    const led = createTransferLedger();
    const yard = ep("town:yard", { food: 12 });
    const partner = ep(townEndpointId("hamlet-1"), { cloth: 99 });
    led.post(
      barterInput({
        give: "food", take: "cloth", giveN: 12, quote: { give: 1, take: 1 },
        partnerKey: "hamlet-1", every: FOOD_DAY_SEC, dueAt: 0,
      }),
    );
    // They are short of food and have cloth to spare; we are fed, so our own
    // spare law lets the whole order go.
    const us = sig({ food: 0, cloth: 0.5 });
    const them = sig({ food: 0.8, cloth: 0 });
    const yard0 = yard.stack.food ?? 0;
    const ourBooks0 = ourTown.scalar("granary");
    const theirBooks0 = theirTown.scalar("granary");
    expect(ourBooks0).toBeGreaterThan(0); // a real bank to ship out of
    const [r] = runDueBarters(led, resolver(yard, partner), 0, { us, themOf: () => them });
    const sent = r!.sent.food ?? 0;
    expect(sent).toBeGreaterThan(0);
    // THE TWO WRITES the host performs on the report's `sent` leg, in order.
    const debit = debitDelivery(ourTown, BOOKS_ECO, "food", sent);
    const credited = creditDelivery(theirTown, BOOKS_ECO, "food", sent);
    expect(debit.scalar).toBe("granary");
    expect(credited).toBe("granary");
    // ① THE YARDS — the shipped law, unchanged.
    expect((yard.stack.food ?? 0) + (partner.stack.food ?? 0)).toBe(yard0);
    // ② THE BOOKS — the same units, at the books' own rate, out of one ledger
    // and into the other. Nothing minted, nothing lost.
    expect(debit.units).toBeCloseTo(sent * bridge, 12);
    expect(ourTown.scalar("granary")).toBeCloseTo(ourBooks0 - sent * bridge, 12);
    expect(theirTown.scalar("granary")).toBeCloseTo(theirBooks0 + sent * bridge, 12);
    expect(ourTown.scalar("granary") + theirTown.scalar("granary")).toBeCloseTo(
      ourBooks0 + theirBooks0,
      12,
    );
  });

  it("🔒 B6 a debit can never overdraw: an empty bank ships its yard and says so", () => {
    // The books are bounded by the books. A town whose stockpile is dry still
    // has a yard and may still trade out of it — the aggregate simply has
    // nothing left to charge, and the debit reports the 0 rather than driving
    // the scalar negative (which `inject` would clamp away silently, leaving
    // the durable mirror disagreeing with the books it mirrors).
    const town = booksTown(80);
    town.inject("granary", -town.scalar("granary"));
    expect(town.scalar("granary")).toBe(0);
    expect(debitDelivery(town, BOOKS_ECO, "food", 5)).toEqual({ scalar: "granary", units: 0 });
    expect(town.scalar("granary")).toBe(0);
    // A partial bank gives what it has and no more.
    const partial = booksTown(80);
    const bank = partial.scalar("granary");
    const huge = (bank / bookUnitsPerStreetUnit(BOOKS_ECO, "food")) * 2;
    expect(debitDelivery(partial, BOOKS_ECO, "food", huge).units).toBeCloseTo(bank, 12);
    expect(partial.scalar("granary")).toBe(0);
    // A good the books bank nothing for is not an error — it is a null leg.
    expect(debitDelivery(partial, BOOKS_ECO, "cloth", 5)).toEqual({ scalar: null, units: 0 });
  });
});

// ── 10. IMPORT DISPLACEMENT (Stage C) — the lane fades when the ground wins ──
//
// The arc's last beat: "expensive import → local planting → import dies".
// #47's Layer-3 law is landed cost = min(local production cost, producer +
// freight); with no money and quantity as the whole story that min() is a
// comparison of RATES, and these pin it end to end — the bare arithmetic, the
// head-matched supply projection, the visit readers the flow is built from,
// and the executor's park/resume edges.

describe("localSupplyDisplaces — the min(), at quantity fidelity", () => {
  it("🚨 PARKS AT PARITY and not one unit below — coverage 1.0 is the line", () => {
    // 2 units a visit, every 1 day ⇒ 2 imported units/day.
    expect(localSupplyDisplaces(2, 2, 1)).toBe(true); // exactly covered
    expect(localSupplyDisplaces(5, 2, 1)).toBe(true); // more than covered
    expect(localSupplyDisplaces(1.999, 2, 1)).toBe(false); // a hair short
    // The PERIOD is half the story: the same ground beats a weekly caravan it
    // cannot beat a daily one.
    expect(localSupplyDisplaces(0.5, 2, 7)).toBe(true); // 2/7 ≈ 0.286 a day
    expect(localSupplyDisplaces(0.25, 2, 7)).toBe(false);
    expect(BARTER_DISPLACE_AT).toBe(1);
  });

  it("🚨 HYSTERESIS BOTH WAYS — parking needs parity, resuming needs a real loss", () => {
    const flow = 4; // 4 units a visit, daily
    // Coverage 0.8: not enough to park…
    expect(localSupplyDisplaces(3.2, flow, 1, false)).toBe(false);
    // …but enough to STAY parked once the lane is displaced.
    expect(localSupplyDisplaces(3.2, flow, 1, true)).toBe(true);
    // The resume edge is the band's floor, exclusive: at it we hold, under it
    // the caravan comes back.
    expect(localSupplyDisplaces(flow * BARTER_DISPLACE_RESUME_AT, flow, 1, true)).toBe(true);
    expect(localSupplyDisplaces(flow * BARTER_DISPLACE_RESUME_AT - 1e-9, flow, 1, true)).toBe(false);
    // The band is a band — the two thresholds are not the same number.
    expect(BARTER_DISPLACE_RESUME_AT).toBeLessThan(BARTER_DISPLACE_AT);
    expect(BARTER_DISPLACE_RESUME_AT).toBe(0.75);
  });

  it("🚨 NEVER BEFORE THE ORCHARD — no local supply is never a displacement", () => {
    // 0 ≥ 0 is true in arithmetic and false in this law: a lane that brings
    // nothing measurable, judged by ground that bears nothing, stays.
    expect(localSupplyDisplaces(0, 0, 1)).toBe(false);
    expect(localSupplyDisplaces(0, 2, 1)).toBe(false);
    expect(localSupplyDisplaces(0, 2, 1, true)).toBe(false);
    expect(localSupplyDisplaces(-5, 2, 1)).toBe(false);
  });

  it("🔒 DEGENERATE READINGS ARE NEVER GROUNDS — a rate nobody can read kills nothing", () => {
    expect(importedFlowPerDay(2, 1)).toBe(2);
    expect(importedFlowPerDay(2, 0)).toBe(0); // no period
    expect(importedFlowPerDay(0, 1)).toBe(0); // no take
    expect(importedFlowPerDay(-2, 1)).toBe(0);
    expect(importedFlowPerDay(2, -1)).toBe(0);
    expect(importedFlowPerDay(Infinity, 1)).toBe(0);
    expect(importedFlowPerDay(2, NaN)).toBe(0);
    const degenerate: Array<[number, number]> =
      [[2, 0], [0, 1], [-2, 1], [2, -1], [Infinity, 1], [2, NaN]];
    for (const [take, period] of degenerate) {
      expect(localSupplyDisplaces(1e6, take, period)).toBe(false);
      expect(localSupplyDisplaces(1e6, take, period, true)).toBe(false);
    }
    // …and the SUPPLY side answers the same way: an unreadable field is not
    // evidence that the caravan is redundant.
    expect(localSupplyDisplaces(NaN, 2, 1)).toBe(false);
    expect(localSupplyDisplaces(Infinity, 2, 1)).toBe(false);
  });
});

describe("localSupplyAtHead — the supply side is glyph-specific", () => {
  it("🚨 a banana field answers a BANANA lane and nothing else", () => {
    const ground = { banana: 4, apple: 9, carrot: 40 };
    expect(localSupplyAtHead(ground, "banana")).toBe(4);
    expect(localSupplyAtHead(ground, "apple")).toBe(9);
    // 🚨 NO GOOD-KEY COINCIDENCE: carrots, bananas and apples are all "food",
    // and a carrot field must never kill a banana caravan.
    expect(localSupplyAtHead({ carrot: 40 }, "banana")).toBe(0);
    expect(localSupplyAtHead({ carrot: 40 }, "apple")).toBe(0);
    expect(localSupplyAtHead(ground, "wood")).toBe(0);
  });

  it("🔒 matches through the ONE extractor — variations of a head are that head", () => {
    expect(localSupplyAtHead({ "apple.ripe": 3, "apple.green": 2 }, "apple")).toBe(5);
    expect(localSupplyAtHead({ apple: 3 }, "apple.ripe")).toBe(3);
    expect(localSupplyAtHead({ "apple.ripe": 3 }, "banana")).toBe(0);
    // Nothing, no ground, no lane — all 0, none of them an error.
    expect(localSupplyAtHead({}, "apple")).toBe(0);
    expect(localSupplyAtHead({ apple: 0, banana: -2 }, "apple")).toBe(0);
    expect(localSupplyAtHead({ apple: 3 }, "")).toBe(0);
  });
});

describe("the visit readers — how big a visit is, and how far apart", () => {
  const row = (o: { giveN: number; every?: number }) =>
    createTransferLedger().post(
      barterInput({
        give: "wood", take: "banana", giveN: o.giveN, quote: { give: 1, take: 1 },
        partnerKey: "p", ...(o.every !== undefined ? { every: o.every } : {}), dueAt: 0,
      }),
    );

  it("🔒 ONE OWNER with the executor: a STANDING route flexes to a batch, a one-shot does not", () => {
    // The exact split runDueBarters ships — the flow reader and the shipment
    // read the same line, so they cannot disagree about a visit's size.
    expect(barterWantBatches(row({ giveN: 6, every: FOOD_DAY_SEC }), { give: 2, take: 3 })).toBe(3);
    expect(barterWantBatches(row({ giveN: 1, every: FOOD_DAY_SEC }), { give: 3, take: 1 })).toBe(1); // flexes
    expect(barterWantBatches(row({ giveN: 1 }), { give: 3, take: 1 })).toBe(0); // strict order
    expect(barterWantBatches(row({ giveN: 6 }), { give: 2, take: 3 })).toBe(3);
    expect(barterWantBatches(row({ giveN: 6 }), { give: 0, take: 3 })).toBe(0); // not a quote
    // The take side is the flow's numerator.
    expect(barterTakePerVisit(row({ giveN: 6 }), { give: 2, take: 3 })).toBe(9);
    expect(barterTakePerVisit(row({ giveN: 6 }), { give: 2, take: 0 })).toBe(0);
  });

  it("🔒 the PERIOD is the recurrence or the road, whichever is longer", () => {
    const standing = row({ giveN: 4, every: FOOD_DAY_SEC });
    expect(barterVisitPeriodDays(standing, undefined)).toBe(1); // its own clock
    expect(barterVisitPeriodDays(standing, FOOD_DAY_SEC * 0.35)).toBe(1); // a near partner
    expect(barterVisitPeriodDays(standing, FOOD_DAY_SEC * 8)).toBe(8); // no daily caravan from 8 days away
    const oneShot = row({ giveN: 4 });
    expect(barterVisitPeriodDays(oneShot, FOOD_DAY_SEC * 2)).toBe(2); // the road alone
    // 🚨 No recurrence AND no road ⇒ 0 ⇒ no measurable import ⇒ a kernel-only
    // caller (no `legSecondsOf`) never displaces a one-shot.
    expect(barterVisitPeriodDays(oneShot, undefined)).toBe(0);
    expect(localSupplyDisplaces(1e6, 2, barterVisitPeriodDays(oneShot, undefined))).toBe(false);
    expect(barterVisitPeriodDays(standing, undefined, 0)).toBe(0);
  });
});

describe("runDueBarters — the fade: a lane parks when the town's own ground covers it", () => {
  const resolve = (yard: StockEndpoint, partner: StockEndpoint) => (id: string) =>
    id === "town:yard" ? yard : id === partner.id ? partner : null;
  // Terms that quote 1-for-1 and pass willingness: they want our wood (0.5,
  // over BARTER_WANT_MIN and over their banana need) and neither side is in
  // famine. worth(wood) = 1+(0+0.5) = worth(banana) = 1+(0.4+0.1).
  const us = sig({ wood: 0, banana: 0.4 });
  const them = sig({ wood: 0.5, banana: 0.1 });

  /** The whole fixture: a standing daily banana lane, plus the HOST's own
   *  session-lived displacement bit wired exactly as quest-host wires it. */
  function lane(o: { giveN?: number; supply: () => number }) {
    const led = createTransferLedger();
    const yard = ep("town:yard", { wood: 200 });
    const partner = ep(townEndpointId("hamlet-1"), { banana: 200 });
    const a = led.post(
      barterInput({
        give: "wood", take: "banana", giveN: o.giveN ?? 2, quote: { give: 1, take: 1 },
        partnerKey: "hamlet-1", every: FOOD_DAY_SEC, dueAt: 0,
      }),
    );
    const displacedLanes = new Set<string>();
    const run = (now: number) => {
      const reports = runDueBarters(led, resolve(yard, partner), now, {
        us,
        themOf: () => them,
        localSupplyPerDay: () => o.supply(),
        displaced: (r) => displacedLanes.has(r.id),
      });
      for (const r of reports) {
        if (r.status === "displaced") displacedLanes.add(r.id);
        else displacedLanes.delete(r.id);
      }
      return reports[0]!;
    };
    // The lane's own imported flow, derived rather than asserted.
    const quote = barterQuote("wood", "banana", us, them);
    const flow = importedFlowPerDay(
      barterTakePerVisit(a, quote),
      barterVisitPeriodDays(a, undefined),
    );
    return { led, yard, partner, a, run, flow, displacedLanes };
  }

  it("🚨 THE FADE: local supply at parity parks the lane, says so ONCE, and moves nothing", () => {
    const f = lane({ supply: () => 99 });
    expect(f.flow).toBeGreaterThan(0);
    const r1 = f.run(0);
    expect(r1).toMatchObject({ status: "displaced", newlySuspended: true, sent: {}, received: {} });
    expect(f.yard.stack.wood).toBe(200); // nothing left, nothing came back
    expect(f.partner.stack.banana).toBe(200);
    // It rides the ONE pause bit — no new serialized field anywhere.
    expect(f.led.get(f.a.id)!.barter!.suspended).toBe(true);
    expect(Object.keys(f.led.get(f.a.id)!.barter!).sort()).toEqual(
      ["giveGood", "partnerKey", "quote", "suspended", "take", "takeGood"],
    );
    // …and it nags exactly once: the edge is the DISPLACEMENT edge.
    expect(f.run(FOOD_DAY_SEC)).toMatchObject({ status: "displaced", newlySuspended: false });
    expect(f.run(FOOD_DAY_SEC * 2)).toMatchObject({ status: "displaced", newlySuspended: false });
    // The row is alive and scheduled, not dead — the lane can come back.
    expect(f.led.get(f.a.id)!.status).toBe("pending");
  });

  it("🚨 AND IT COMES BACK when the orchard is chopped — but only past the band", () => {
    let supply = 99;
    const f = lane({ supply: () => supply });
    expect(f.run(0).status).toBe("displaced");
    // Most of the orchard gone, still inside the hysteresis band: the lane holds.
    supply = f.flow * 0.8;
    expect(f.run(FOOD_DAY_SEC)).toMatchObject({ status: "displaced", newlySuspended: false });
    expect(f.yard.stack.wood).toBe(200);
    // Chopped past the resume line — the caravan goes again, and the ledger's
    // own resume idiom reports it.
    supply = f.flow * 0.5;
    const back = f.run(FOOD_DAY_SEC * 2);
    expect(back.status).toBe("resumed");
    expect(back.sent.wood).toBeGreaterThan(0);
    expect(back.received.banana).toBeGreaterThan(0);
    expect(f.led.get(f.a.id)!.barter!.suspended).toBe(false);
    expect(f.displacedLanes.size).toBe(0);
    // Replant: parity again ⇒ it parks again, and the edge fires afresh.
    supply = 99;
    expect(f.run(FOOD_DAY_SEC * 3)).toMatchObject({ status: "displaced", newlySuspended: true });
  });

  it("🚨 NEVER BEFORE THE ORCHARD — a lane whose take nothing local grows never fades", () => {
    // The naive want-based park dies here: a fruit glyph has no fill row, so
    // OUR shortage of it can be anything at all and must not matter.
    for (const ourBanana of [0, 0.4, 1]) {
      const led = createTransferLedger();
      const yard = ep("town:yard", { wood: 50 });
      const partner = ep(townEndpointId("hamlet-1"), { banana: 50 });
      led.post(
        barterInput({
          give: "wood", take: "banana", giveN: 2, quote: { give: 1, take: 1 },
          partnerKey: "hamlet-1", every: FOOD_DAY_SEC, dueAt: 0,
        }),
      );
      const [r] = runDueBarters(led, resolve(yard, partner), 0, {
        us: sig({ wood: 0, banana: ourBanana }),
        themOf: () => sig({ wood: 0.5, banana: 0.1 }),
        localSupplyPerDay: () => 0, // nothing sown: the ground bears nothing
        displaced: () => false,
      });
      expect(r!.status).toBe("shipped");
    }
  });

  it("🚨 HEAD-MATCHED THROUGH THE EXECUTOR — the banana lane fades, the apple lane sails", () => {
    // ONE field bearing bananas only; two lanes side by side on one ledger.
    const ground = { banana: 99 };
    const led = createTransferLedger();
    const yard = ep("town:yard", { wood: 400 });
    const partner = ep(townEndpointId("hamlet-1"), { banana: 200, apple: 200 });
    const bananaLane = led.post(
      barterInput({
        give: "wood", take: "banana", giveN: 2, quote: { give: 1, take: 1 },
        partnerKey: "hamlet-1", every: FOOD_DAY_SEC, dueAt: 0,
      }),
    );
    const appleLane = led.post(
      barterInput({
        give: "wood", take: "apple", giveN: 2, quote: { give: 1, take: 1 },
        partnerKey: "hamlet-1", every: FOOD_DAY_SEC, dueAt: 0,
      }),
    );
    const reports = runDueBarters(led, resolve(yard, partner), 0, {
      us: sig({ wood: 0, banana: 0.4, apple: 0.4 }),
      themOf: () => sig({ wood: 0.5, banana: 0.1, apple: 0.1 }),
      // The host's own reader, at this seam: the ground, projected onto THIS
      // row's take-good.
      localSupplyPerDay: (r) => localSupplyAtHead(ground, r.barter!.takeGood),
      displaced: () => false,
    });
    const byId = new Map(reports.map((r) => [r.id, r]));
    expect(byId.get(bananaLane.id)!.status).toBe("displaced");
    expect(byId.get(appleLane.id)!.status).toBe("shipped");
    expect(partner.stack.banana).toBe(200); // no bananas hauled
    expect(partner.stack.apple).toBeLessThan(200); // apples still arrive
  });

  it("🚨 PRECEDENCE: displacement outranks a refusal — the durable fact is the one told", () => {
    // Their famine on the take-good WOULD suspend this leg ("wont-part"); our
    // own orchard makes the lane pointless regardless of what they do.
    const led = createTransferLedger();
    const yard = ep("town:yard", { wood: 60 });
    const partner = ep(townEndpointId("p"), { banana: 60 });
    led.post(
      barterInput({
        give: "wood", take: "banana", giveN: 6, quote: { give: 1, take: 1 },
        partnerKey: "p", every: FOOD_DAY_SEC, dueAt: 0,
      }),
    );
    const opts = {
      us: sig({ wood: 0, banana: 0.4 }),
      themOf: () => sig({ wood: 0.5, banana: 0.9 }), // famine on banana
      displaced: () => false,
    };
    // Without the supply seat this is the shipped refusal, unchanged…
    const [refused] = runDueBarters(led, resolve(yard, partner), 0, opts);
    expect(refused).toMatchObject({ status: "suspended", reason: "wont-part" });
    // …and with it, the lane fades instead.
    const [faded] = runDueBarters(led, resolve(yard, partner), FOOD_DAY_SEC, {
      ...opts,
      localSupplyPerDay: () => 99,
    });
    expect(faded!.status).toBe("displaced");
    expect(faded!.newlySuspended).toBe(true); // the pause bit was already set — the EDGE is ours
  });

  it("🔒 BYTE-IDENTITY: no sown ground ⇒ the executor's every answer is the shipped one", () => {
    // The whole displacement arm, run three ways over identical worlds: absent,
    // present-but-barren, and present-but-barren with the hysteresis bit set.
    const play = (extra: Parameters<typeof runDueBarters>[3]) => {
      const led = createTransferLedger();
      const yard = ep("town:yard", { wood: 9 });
      const partner = ep(townEndpointId("hamlet-1"), { banana: 9 });
      led.post(
        barterInput({
          give: "wood", take: "banana", giveN: 4, quote: { give: 1, take: 1 },
          partnerKey: "hamlet-1", every: FOOD_DAY_SEC, dueAt: 0,
        }),
      );
      const reports = [0, 1, 2].map(
        (d) => runDueBarters(led, resolve(yard, partner), FOOD_DAY_SEC * d, extra)[0],
      );
      return { reports, yard: yard.stack, partner: partner.stack, json: led.toJSON() };
    };
    const base = { us, themOf: () => them };
    const shipped = play(base);
    expect(shipped.reports.every((r) => r && r.status === "shipped")).toBe(true);
    expect(play({ ...base, localSupplyPerDay: () => 0, displaced: () => false })).toEqual(shipped);
    expect(play({ ...base, localSupplyPerDay: () => 0, displaced: () => true })).toEqual(shipped);
    // …and a save written by the barren run is byte-identical to the shipped one.
    expect(JSON.stringify(play({ ...base, localSupplyPerDay: () => 0 }).json)).toBe(
      JSON.stringify(shipped.json),
    );
  });
});
