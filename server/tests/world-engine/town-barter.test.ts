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
// No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  BARTER_FAMINE_MAX,
  BARTER_RATIO_CAP,
  BARTER_RETRY_SEC,
  BARTER_WANT_MIN,
  GEO_FARMLAND_REF,
  barterQuote,
  barterRatio,
  barterWillingness,
  barterWorth,
  defaultTakeGood,
  geoGoodClass,
  geographyShortageBase,
  nextShortageBelow,
  runDueBarters,
  stockAbstractPartner,
  stubPartnerSignals,
  type BarterSignals,
  type PartnerGeography,
} from "@shared/world-engine/kernel/town/barter.js";
import {
  complementaryTrade,
  freightSurvivesLeg,
} from "@shared/world-engine/kernel/town/complementary.js";
import { carryReachM, freightOf } from "@shared/world-engine/freight.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";
import {
  createTransferLedger,
  runDueTransfers,
  stackUnits,
  townEndpointId,
  type PostTransferInput,
  type StockEndpoint,
} from "@shared/world-engine/kernel/town/transfer.js";
import { FOOD_DAY_SEC } from "@shared/world-engine/kernel/town/goods.js";

/** Fixed per-good signals (the test's "town books"). */
const sig = (m: Record<string, number>): BarterSignals => ({
  shortage: (g) => m[g] ?? 0,
});

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

  it("judges by THEIR books alone — our desperation never flips their answer", () => {
    const them = sig({ wood: 0.8, food: 0.1 });
    expect(barterWillingness("wood", "food", sig({}), them).ok).toBe(true);
    expect(barterWillingness("wood", "food", sig({ food: 1, wood: 1 }), them).ok).toBe(true);
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
