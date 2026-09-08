/**
 * ⚖️ F2 RE-PINNED ON THE MEASUREMENT (body-needs-round.md D4, wave 2 builder C).
 *
 * `pull-labor-decider.test.ts` ⑨ F2 pins the exchange rate SYNTHETICALLY — it
 * hands `decideContribution` a `beatS` the test computed and asks which side
 * wins. That pin STAYS EXACTLY AS IT IS. This file pins the other half, the one
 * the round made real: that the numbers the synthetic pin assumes are the
 * numbers the SHIPPED RATES and the SHIPPED TEMPLATES actually produce.
 *
 * Every rival here is derived, never typed in:
 *   · the rows come from `bodyNeedTemplates` / `hungerTemplate` / `energyTemplate`
 *     at their shipped priorities (needs.ts, body-needs.ts);
 *   · their clocks come from `needRate(DOLLHOUSE_SCALE, key)` and
 *     `needFillS(DOLLHOUSE_SCALE, key)` — `scale.ts NEED_FILL_DAYS` over the
 *     metabolism, times the day: the ONE rate source;
 *   · the rival price is `netValueS(rowValueS, intentCost)` behind the real
 *     `decideNeeds` walker — `needRivalNetS`'s own shape, the number quest-host
 *     hands `tryContribute` as `beatS`;
 *   · the bill is `CONTRIBUTE_PRIORITY × NEED_PRESSURE_S × urgency × w`
 *     (contribute.ts's ② line, verbatim), `w = 1` civic and
 *     `w = 1 + compliance(FAMILY_RELATION)` spoken.
 *
 * WHY IT MATTERS THAT THESE ARE MEASURED. `beatS` used to be `−Infinity` for
 * every body outside the observed household — the settlers by construction, the
 * frontier's pullers because their meters FROZE while their house was dark
 * (D4(b)). The bill therefore won unopposed, and "a hungry body eats first" was
 * a rule about a currency only one side ever quoted. This round gives those
 * bodies a real number; these are the numbers.
 *
 * THE LADDER IT PINS, in hand-seconds, at DOLLHOUSE_SCALE:
 *
 *   firing hunger (priority 5)   200 s   = 1 × 5 × 40, under its 240 s clock
 *   firing energy (priority 4)   160 s   = 1 × 4 × 40, under its 384 s clock
 *   spoken FAMILY bill           134.4 s = 2 × 40 × 1 × 1.68
 *   civic bill at urgency 1       80 s   = 2 × 40 × 1 × 1
 *   a row below threshold         −∞     (a want is not an activity)
 *
 * PURE — no host, no boot, no DB, no GL. `npm run test:engine -- body-needs`.
 */
import { describe, it, expect } from "@jest/globals";
import {
  NEED_PRESSURE_S,
  decideNeeds,
  energyTemplate,
  hungerTemplate,
  intentCost,
  rowValueS,
  type NeedCtx,
  type NeedTemplate,
} from "@shared/world-engine/interaction/behavior/needs.js";
import {
  REST_QUALITY,
  bodyNeedTemplates,
  restClear,
} from "@shared/world-engine/interaction/behavior/body-needs.js";
import { compliance, type Relation } from "@shared/world-engine/interaction/behavior/relations.js";
import { ingestMeterAfter } from "@shared/world-engine/kernel/town/goods-kinds.js";
import {
  CONTRIBUTE_PRIORITY,
  bodyNeedsOn,
  pullLaborOn,
} from "@shared/world-engine/kernel/town/pull-labor.js";
import { netValueS, priceOf } from "@shared/world-engine/kernel/town/pricing.js";
import { DOLLHOUSE_SCALE, needFillS, needRate, walkSpeedMps } from "@shared/world-engine/scale.js";

// ── THE WORLD'S OWN NUMBERS ────────────────────────────────────────────────
const HUNGER_RATE = needRate(DOLLHOUSE_SCALE, "hunger");
const ENERGY_RATE = needRate(DOLLHOUSE_SCALE, "energy");
const HUNGER_FILL_S = needFillS(DOLLHOUSE_SCALE, "hunger"); // 240 s
const ENERGY_FILL_S = needFillS(DOLLHOUSE_SCALE, "energy"); // 384 s

/** quest-host's `FAMILY_RELATION`, restated — the host is not purely
 *  importable, and the pin is precisely that `compliance` over THESE three
 *  numbers is where ⑨ F2's stubbed `motiveWeight: () => 1.68` comes from. If
 *  the host's relation ever moves, this test's 134.4 s moves with it and the
 *  stub is the thing that has gone stale. */
const FAMILY_RELATION: Relation = { affinity: 0.5, trust: 0.8, authority: 0.8, fear: 0 };

/** contribute.ts:912 ② verbatim — what taking a piece of the bill is worth to
 *  THIS BODY, on the same ladder its hunger is written on. `cost` is the
 *  claim's leg + forgone; a body standing AT the work pays neither, which is
 *  the hardest case for a need to win and therefore the one to pin. */
const billNetS = (urgency: number, w: number): number =>
  netValueS(CONTRIBUTE_PRIORITY * NEED_PRESSURE_S * urgency * w, priceOf({}));

const CIVIC_BILL_S = billNetS(1, 1); // 80
const FAMILY_W = 1 + compliance(FAMILY_RELATION); // 1.68
const SPOKEN_BILL_S = billNetS(1, FAMILY_W); // 134.4

/** The price board a body standing at its own satisfier carries: no leg to
 *  walk, no hand-seconds to spend, so the row is worth exactly its own rung
 *  under its own clock and `netValueS` subtracts nothing. Any real geometry
 *  can only make the need CHEAPER to beat, so this is the need's best case and
 *  the bill's worst — the pin that matters. */
function priceBoard(fillS: number): NonNullable<NeedCtx["price"]> {
  return {
    walkMps: walkSpeedMps(DOLLHOUSE_SCALE),
    fillS,
    unitValueS: HUNGER_FILL_S,
    shortage: 1,
    handsS: { container: 0, source: 0, loose: 0, satisfy: 0 },
  };
}

/** A ctx for ONE row: its level, whether a unit is in hand, and the price
 *  board. No stations and no containers — a body at a camp / a dark house,
 *  which is exactly the D4 case (`restHere`, `consumeHere`). */
function ctxFor(tpl: NeedTemplate, meter: number, carried = 0): NeedCtx {
  return {
    meter,
    carried,
    containers: {},
    sources: [],
    stations: [],
    price: priceBoard(tpl.key.startsWith("hunger") ? HUNGER_FILL_S : ENERGY_FILL_S),
  };
}

/**
 * `needRivalNetS` (quest-host) in its own shape: run the REAL walker over the
 * row set, then price the row it chose over the very ctx the decision was made
 * on. `−Infinity` for idle/blocked/nothing — *"a parked or blocked need is a
 * want, not an activity"*.
 */
function rivalNetS(templates: readonly NeedTemplate[], levels: Record<string, number>, carried = 0): number {
  const seen = new Map<string, NeedCtx>();
  const decided = decideNeeds(templates, (tpl) => {
    const c = ctxFor(tpl, levels[tpl.key] ?? 0, tpl.key.startsWith("hunger") ? carried : 0);
    seen.set(tpl.key, c);
    return c;
  });
  if (!decided || decided.intent.kind === "blocked" || decided.intent.kind === "idle") {
    return Number.NEGATIVE_INFINITY;
  }
  const ctx = seen.get(decided.tpl.key)!;
  return netValueS(rowValueS(decided.tpl, ctx, decided.intent), intentCost(decided.tpl, ctx, decided.intent));
}

const HUNGER = hungerTemplate("food", HUNGER_RATE, []); // eat in place — no table at a dark house
const ENERGY = energyTemplate(ENERGY_RATE);

describe("⑨ F2 over the REAL rates — the two currencies meet on one ladder", () => {
  it("the clocks are the SCALE's: hunger fills in 240 s, energy in 384 s, and rate is 1/fill", () => {
    expect(HUNGER_FILL_S).toBeCloseTo(240, 6);
    expect(ENERGY_FILL_S).toBeCloseTo(384, 6);
    expect(HUNGER_RATE).toBeCloseTo(1 / 240, 12);
    expect(ENERGY_RATE).toBeCloseTo(1 / 384, 12);
  });

  it("the bill's two weights are 80 s civic (2 × 40 × 1 × 1) and 134.4 s spoken (× 1.68 family compliance)", () => {
    expect(CONTRIBUTE_PRIORITY).toBe(2);
    expect(NEED_PRESSURE_S).toBe(40);
    expect(compliance(FAMILY_RELATION)).toBeCloseTo(0.68, 6);
    expect(FAMILY_W).toBeCloseTo(1.68, 6);
    expect(CIVIC_BILL_S).toBeCloseTo(80, 6);
    expect(SPOKEN_BILL_S).toBeCloseTo(134.4, 6);
  });

  it("🚨 A FIRING HUNGER PRICES AT 200 s (1 × 5 × 40, under its 240 s clock) and beats the 80 s civic bill", () => {
    const rival = rivalNetS([HUNGER], { "hunger:food": 1 }, 1);
    expect(rival).toBeCloseTo(200, 6);
    expect(rival).toBeGreaterThan(CIVIC_BILL_S);
  });

  it("…and beats the 134.4 s SPOKEN FAMILY bill too — 200 > 134.4, the ruling's own ordering", () => {
    expect(rivalNetS([HUNGER], { "hunger:food": 1 }, 1)).toBeGreaterThan(SPOKEN_BILL_S);
  });

  it("an OVER-URGENT hunger never buys more than its whole clock: level 2 prices at 240 s, not 400 s", () => {
    // `driveValueS` clamps urgency×ladder/fill to 1 before multiplying by the
    // clock — the chapter's ceiling. It still beats both bills.
    const rival = rivalNetS([HUNGER], { "hunger:food": 2 }, 1);
    expect(rival).toBeCloseTo(HUNGER_FILL_S, 6);
    expect(rival).toBeGreaterThan(SPOKEN_BILL_S);
  });

  it("🚨 A FIRING ENERGY ROW PRICES AT 160 s (1 × 4 × 40, under its 384 s clock) and beats the 80 s civic bill", () => {
    // No bed in the ctx — a dark household stands no furniture — so the walker
    // answers `restHere`, whose cost is a leg of zero: the D4(c) case exactly.
    const rival = rivalNetS([ENERGY], { energy: 1 });
    expect(rival).toBeCloseTo(160, 6);
    expect(rival).toBeGreaterThan(CIVIC_BILL_S);
  });

  it("…and at these rates a tired body also outbids the 134.4 s spoken family bill (160 > 134.4)", () => {
    // Stated because it is what makes D4(c) reachable at all: were it the other
    // way, a housed body would keep working through every dark night and the
    // demote-home arm would never run.
    expect(rivalNetS([ENERGY], { energy: 1 })).toBeGreaterThan(SPOKEN_BILL_S);
  });

  it("HUNGER OUTRANKS REST at equal fill — 200 s vs 160 s — so a tired AND hungry body eats first", () => {
    const both = bodyNeedTemplates(DOLLHOUSE_SCALE, { pullOn: true });
    const seen = new Map<string, NeedCtx>();
    const decided = decideNeeds(both, (tpl) => {
      const c = ctxFor(tpl, tpl.key.startsWith("hunger") || tpl.key === "energy" ? 1 : 0, tpl.key.startsWith("hunger") ? 1 : 0);
      seen.set(tpl.key, c);
      return c;
    });
    expect(decided?.tpl.key).toBe("hunger:food");
    expect(decided?.intent.kind).toBe("consumeHere");
  });

  it("🚨 A ROW BELOW THRESHOLD DOES NOT FIRE — the rival is −∞ and the 80 s civic bill wins", () => {
    // The shape `needRivalNetS` returns for idle/blocked/nothing. This is the
    // state a body spends most of its day in, and it is why an idle body works.
    const rival = rivalNetS([HUNGER, ENERGY], { "hunger:food": 0.99, energy: 0.99 }, 1);
    expect(rival).toBe(Number.NEGATIVE_INFINITY);
    expect(CIVIC_BILL_S).toBeGreaterThan(rival);
  });

  it("A BLOCKED hunger is also −∞ — no unit in hand, no source, no container: the bill wins", () => {
    const rival = rivalNetS([HUNGER], { "hunger:food": 3 }, 0);
    expect(rival).toBe(Number.NEGATIVE_INFINITY);
    expect(CIVIC_BILL_S).toBeGreaterThan(rival);
  });

  it("🚨 AFTER A FULL MEAL (`ingestMeterAfter`, 1 satiation-day) the row is 0, the rival is −∞ and the bill wins again", () => {
    const after = ingestMeterAfter(1, 1);
    expect(after).toBe(0);
    const rival = rivalNetS([HUNGER], { "hunger:food": after }, 1);
    expect(rival).toBe(Number.NEGATIVE_INFINITY);
    expect(CIVIC_BILL_S).toBeGreaterThan(rival);
  });

  it("…but a PARTIAL meal that leaves the row firing keeps the body eating: 1.5 − 0.2 = 1.3 still prices at 240 s", () => {
    const after = ingestMeterAfter(1.5, 0.2);
    expect(after).toBeCloseTo(1.3, 6);
    expect(rivalNetS([HUNGER], { "hunger:food": after }, 1)).toBeGreaterThan(SPOKEN_BILL_S);
  });

  it("🚨 AFTER A BED REST (`restClear`, quality 1) energy is 0, the rival is −∞ and the 80 s bill wins", () => {
    const after = restClear(1.2, REST_QUALITY.bed);
    expect(after).toBe(0);
    const rival = rivalNetS([ENERGY], { energy: after });
    expect(rival).toBe(Number.NEGATIVE_INFINITY);
    expect(CIVIC_BILL_S).toBeGreaterThan(rival);
  });

  it("…after a GROUND rest (quality 0.5) a deficit of 1.6 is still firing at 1.1, and still outbids the bill", () => {
    // The satisfier's quality is a PRICE, not a boolean: half a rest leaves the
    // body still tired enough to refuse the bill, which is what "bad rest is
    // more of the day spent sleeping" means at the ladder.
    const after = restClear(1.6, REST_QUALITY.ground);
    expect(after).toBeCloseTo(1.1, 6);
    expect(rivalNetS([ENERGY], { energy: after })).toBeGreaterThan(CIVIC_BILL_S);
  });

  it("THE WHOLE LADDER, in one line: 200 > 160 > 134.4 > 80 > −∞", () => {
    const hunger = rivalNetS([HUNGER], { "hunger:food": 1 }, 1);
    const energy = rivalNetS([ENERGY], { energy: 1 });
    const quiet = rivalNetS([HUNGER, ENERGY], { "hunger:food": 0, energy: 0 }, 1);
    expect(hunger).toBeGreaterThan(energy);
    expect(energy).toBeGreaterThan(SPOKEN_BILL_S);
    expect(SPOKEN_BILL_S).toBeGreaterThan(CIVIC_BILL_S);
    expect(CIVIC_BILL_S).toBeGreaterThan(quiet);
  });
});

describe("D4 — the capability is ONE derivation, and the dollhouse reads FALSE", () => {
  it("`bodyNeedsOn` answers exactly `pullLaborOn` over every shape of session", () => {
    const shapes = [
      {},
      { foundedSite: null, town: null, wilderness: null },
      { foundedSite: {}, town: null, wilderness: null },
      { foundedSite: null, town: {}, wilderness: null }, // ← the dollhouse
      { foundedSite: null, town: null, wilderness: {} },
      { foundedSite: null, town: {}, wilderness: {} }, // ← the frontier
    ];
    for (const s of shapes) expect(bodyNeedsOn(s)).toBe(pullLaborOn(s));
  });

  it("🚫 THE DOLLHOUSE IS FALSE and a PARTIAL fixture is false — fail-closed, so every D4 hunk is inert there", () => {
    expect(bodyNeedsOn({ foundedSite: null, town: {}, wilderness: null })).toBe(false);
    expect(bodyNeedsOn({})).toBe(false);
    expect(bodyNeedsOn({ foundedSite: null, town: null, wilderness: null })).toBe(false);
  });

  it("…and TRUE for a founded site and for a wilderness town — the two worlds D4 is written for", () => {
    expect(bodyNeedsOn({ foundedSite: {}, town: null, wilderness: null })).toBe(true);
    expect(bodyNeedsOn({ foundedSite: null, town: {}, wilderness: {} })).toBe(true);
  });
});
