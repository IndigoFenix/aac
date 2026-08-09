// STEP ④, PASS 2 — "COSTS IN THE PLANNER" and "THE BASKET QUESTION"
// (planning-docs/games/world-engine/scope-behaviors.md §2.3 PREFER, §2.4 ENABLE, §2.9 BATCH,
// §5 seats 3–4, §7 steps 3–4).
//
// Three things land here and all three are pinned below:
//
//  ③ GoalPlan.cost — every compile carries a `VerbCost` now: the walk legs
//     CHAINED (leg two starts where leg one ended) plus the hands each act
//     occupies. An UNPRICED resolver prices everything at zero, which is the
//     property that keeps the rest of the planner suites byte-identical.
//  ③ SEAT 4 — `candidates.find(compileGoal)` becomes an argmax of
//     `netValueS(taste, plan.cost)` INSIDE the first compilable group, with a
//     hysteresis margin so two near-equal sources cannot trade the body back
//     and forth at every junction.
//  ④ ENABLE — the basket question, asked at BOTH rungs with one arithmetic:
//     a body about to shop, and a porter about to haul.
//
// The three deciders are host closures bound to a live session, so they are
// MIRRORED here exactly as quest-host writes them — the convention
// `need-costs-and-claims.test.ts` established for the claim helpers and
// `town-body-carry.test.ts` for the two carry doors. Everything UNDER them is
// the real thing: `compileGoal`/`pricePlan`, `decideNeed`, the reservation
// ledger, `tasteBonusS`, so a change to any of those breaks this file rather
// than sliding past it.
//
// No DOM / GL / session / DB.
import { describe, expect, it } from "@jest/globals";
import type { CreatureId } from "@shared/world-engine/interaction/behavior/creatures.js";
import { pricePlan } from "@shared/world-engine/interaction/behavior/action-planner.js";
import {
  compileGoal,
  type GoalPlan,
  type WorldResolver,
} from "@shared/world-engine/interaction/behavior/goal-selection.js";
import {
  HOT_MEAL_TASTE_S,
  tasteBonusS,
} from "@shared/world-engine/interaction/behavior/need-goals.js";
import {
  decideNeed,
  decideNeeds,
  funTemplate,
  hungerTemplate,
  intentCost,
  NEED_PRESSURE_S,
  provisionTemplate,
  relieveTemplate,
  stowTemplate,
  tidyTemplate,
  unloadTemplate,
  type NeedCtx,
  type NeedIntent,
  type NeedPrice,
  type NeedTemplate,
  type StockCandidate,
} from "@shared/world-engine/interaction/behavior/needs.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";
import {
  createReservationLedger,
  toolClaimed,
  TOOL_CLAIM_GLYPH,
  type ReservationLedger,
} from "@shared/world-engine/kernel/town/reservations.js";
import { driveValueS, goodsValueS, journeyTimeS, netValueS, priceOf } from "@shared/world-engine/kernel/town/pricing.js";
import { costTotalS } from "@shared/world-engine/kernel/town/scope-shape.js";
import { NEED_FILL_S } from "@shared/world-engine/scale.js";

// ── The shipped constants, as the host spends them ────────────────────────
const WALK_MPS = 1.6; // ERRAND_WALK_MPS, the villager pace
const BOX_S = 1.1; // BOX_ACT_DWELL_S — the crouch at a box
const SHOP_S = 18; // SHOP_SEC — the beat at a stall
const EAT_S = 2; // EAT_SHOW_S — the meal's own show
const MARGIN_S = 6; // GOAL_SWITCH_MARGIN_S — quest-host's hysteresis margin

const P = (id: string) => ({ kind: "named" as const, id });
const at = (x: number) => ({ x, y: 0 });
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);

/** quest-host `stepPlanHandsS`, mirrored: every number is a dwell the executor
 *  already spends. A stall is a transaction, a box is a reach. */
const handsS = (step: { kind: string; fromId?: string }): number => {
  if (step.kind === "moveTo" || step.kind === "faceHold") return 0;
  if (step.kind === "withdraw") return step.fromId?.startsWith("store:") ? SHOP_S : BOX_S;
  if (step.kind === "eat" || step.kind === "consumeStack") return EAT_S;
  return BOX_S;
};

// ── The world the plans are compiled against ──────────────────────────────

interface WorldOpts {
  /** Named place → where it stands. */
  places?: Record<string, { x: number; y: number }>;
  /** Item id → where it lies. */
  items?: Record<string, { x: number; y: number }>;
  /** Which item a `{match}` ref resolves to, by wanted state ("hot" or ""). */
  byState?: Record<string, string>;
  /** Omit the price board — an UNPRICED resolver, the zero-cost path. */
  unpriced?: boolean;
  /** ⚖️ W1 — the world's own "how far is that, really" measure. Absent ⇒ the
   *  planner's chord default (a townless world), which is the byte-identical
   *  case every other test in this file runs. */
  journeyM?(from: { x: number; y: number }, to: { x: number; y: number }): number;
}

function world(o: WorldOpts = {}): WorldResolver {
  const places = o.places ?? {};
  const items = o.items ?? {};
  return {
    positionOf: (id) => (id === "bear" ? at(0) : null),
    homeOf: () => at(-5),
    place: (p) => (p.kind === "named" ? (places[p.id] ?? null) : p.kind === "point" ? { x: p.x, y: p.y } : null),
    resolveItem: (ref) => {
      if ("id" in ref) return ref.id;
      const want = ref.match.state ?? "";
      return o.byState?.[want] ?? null;
    },
    itemPosition: (id) => items[id] ?? null,
    stationFor: () => null,
    carrierOf: () => null,
    ...(o.unpriced
      ? {}
      : { price: { walkMps: WALK_MPS, handsS, ...(o.journeyM ? { journeyM: o.journeyM } : {}) } }),
  };
}

// ═══ ③ THE PRICE OF A PLAN ════════════════════════════════════════════════

describe("③ pricePlan — a plan's cost is its legs plus its hands", () => {
  it("one leg + one act: the walk, then the stall's own beat", () => {
    const r = world({ places: { "store:food": at(32) } });
    const plan = compileGoal(
      { kind: "takeUnits", from: P("store:food"), category: "food", units: 5 },
      "bear",
      r,
    )!;
    expect(plan.steps.map((s) => s.kind)).toEqual(["moveTo", "withdraw"]);
    expect(plan.cost.journeyS).toBeCloseTo(32 / WALK_MPS);
    expect(plan.cost.handsS).toBe(SHOP_S);
    // The two terms this pass does not price (chapter §3).
    expect(plan.cost.spoilageS).toBe(0);
    expect(plan.cost.forgoneS).toBe(0);
  });

  it("🚨 THE WALK IS CHAINED — leg two starts where leg one ended, so a DETOUR costs its detour", () => {
    // "Fetch the apple at 10, carry it to the box at 4" is 10 m out and 6 m
    // back, NOT 14 m of radial distance. That difference IS the ENABLE
    // comparison below — measuring every leg from the body would price a
    // detour as free and no basket would ever be worth fetching.
    const r = world({ places: { box: at(4) }, items: { apple1: at(10) } });
    const plan = compileGoal({ kind: "putIn", item: { id: "apple1" }, container: P("box") }, "bear", r)!;
    expect(plan.steps.map((s) => s.kind)).toEqual(["moveTo", "pick", "moveTo", "place"]);
    expect(plan.cost.journeyS).toBeCloseTo((10 + 6) / WALK_MPS);
    expect(plan.cost.handsS).toBeCloseTo(2 * BOX_S); // the lift and the put-in
  });

  it("an UNPRICED resolver costs nothing at all — the byte-identical property", () => {
    const r = world({ places: { "store:food": at(32) }, unpriced: true });
    const plan = compileGoal(
      { kind: "takeUnits", from: P("store:food"), category: "food", units: 5 },
      "bear",
      r,
    )!;
    expect(costTotalS(plan.cost)).toBe(0);
    // …and `pricePlan` said so directly, not by accident of the goal.
    expect(costTotalS(pricePlan(plan.steps, "bear", r))).toBe(0);
  });

  it("an unlocatable body still prices its DETOURS — the first leg is simply free", () => {
    const r = { ...world({ places: { box: at(4) }, items: { apple1: at(10) } }), positionOf: () => null };
    const plan = compileGoal({ kind: "putIn", item: { id: "apple1" }, container: P("box") }, "bear", r)!;
    expect(plan.cost.journeyS).toBeCloseTo(6 / WALK_MPS); // 10 → 4, the second leg only
  });

  // ── W1 (economy-arc-opening.md) — PAY WHAT YOU PRICE ────────────────────
  //
  // The diagnosed defect: the pursuit priced a leg by CHORD while the body
  // paid STREET. A town's street tree routes through the plaza ring, so two
  // points on different arterial subtrees are 68 m apart and 400 m of walking
  // away — and nothing in the calculus could tell, because `pricePlan` used
  // `Math.hypot`. The fix is a resolver-supplied journey measure threaded
  // through the price board; the planner itself stays engine-agnostic.

  it("W1: with no journey measure the price is the CHORD — the byte-identical default", () => {
    const r = world({ places: { box: at(4) }, items: { apple1: at(10) } });
    expect(r.price!.journeyM).toBeUndefined(); // a townless world supplies none
    const plan = compileGoal({ kind: "putIn", item: { id: "apple1" }, container: P("box") }, "bear", r)!;
    expect(plan.cost.journeyS).toBeCloseTo((10 + 6) / WALK_MPS);
  });

  it("W1: the world's OWN measure is what the legs are billed at — and it CHAINS", () => {
    // A street world where every leg costs three times its chord (the detour
    // through the hub, in miniature). Both legs must carry it, and the second
    // must still start where the first ended — pricing the detour by street
    // and the chain by chord would be a new way to lose the same money.
    const detour = (a: { x: number; y: number }, b: { x: number; y: number }) => 3 * dist(a, b);
    const r = world({ places: { box: at(4) }, items: { apple1: at(10) }, journeyM: detour });
    const plan = compileGoal({ kind: "putIn", item: { id: "apple1" }, container: P("box") }, "bear", r)!;
    expect(plan.cost.journeyS).toBeCloseTo((3 * 10 + 3 * 6) / WALK_MPS);
    // The hands are untouched — W1 moves metres, never dwells.
    expect(plan.cost.handsS).toBeCloseTo(2 * BOX_S);
    // …and it is genuinely the STEP LIST being re-billed, not the goal.
    expect(costTotalS(pricePlan(plan.steps, "bear", r))).toBeCloseTo(costTotalS(plan.cost));
  });

  it("🚨 W1: THE SELECTION MOVES — a 400 m 'bargain' stops beating a 90 m walk", () => {
    // Two stalls. `near` is 68 m as the crow flies but sits on the far side of
    // the ring, so the body must walk 400 m to it; `far` is 90 m of honest
    // street. Priced by chord the near stall wins by a mile; priced the way
    // the body will actually walk, it loses — which is the whole point of the
    // fix, and the reason selections were expected to move.
    const NEAR = at(68);
    const FAR = at(90);
    const street = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      dist(a, b) === 68 ? 400 : dist(a, b);
    const buy = (place: string) =>
      ({ kind: "takeUnits", from: P(place), category: "food", units: 5 }) as const;

    const chordWorld = world({ places: { "store:near": NEAR, "store:far": FAR } });
    const nearByChord = compileGoal(buy("store:near"), "bear", chordWorld)!;
    const farByChord = compileGoal(buy("store:far"), "bear", chordWorld)!;
    expect(costTotalS(nearByChord.cost)).toBeLessThan(costTotalS(farByChord.cost));

    const streetWorld = world({ places: { "store:near": NEAR, "store:far": FAR }, journeyM: street });
    const nearByStreet = compileGoal(buy("store:near"), "bear", streetWorld)!;
    const farByStreet = compileGoal(buy("store:far"), "bear", streetWorld)!;
    expect(costTotalS(nearByStreet.cost)).toBeGreaterThan(costTotalS(farByStreet.cost));
    // …and the number it now pays is the walk it will really take.
    expect(nearByStreet.cost.journeyS).toBeCloseTo(400 / WALK_MPS);
  });
});

// ═══ ③ SEAT 4 — which candidate the pursuit installs ══════════════════════

/** quest-host `chooseNeedGoal`, mirrored verbatim. The row's own value is
 *  SHARED by every candidate for one goal, so it cancels out of the argmax and
 *  is not read here; what survives the cancellation is the taste term and the
 *  cost. */
function chooseNeedGoal(
  standingPick: Map<string, { tplKey: string; key: string }>,
  cid: string,
  tplKey: string,
  candidates: readonly GoalSpec[],
  r: WorldResolver,
  costed = true,
): GoalSpec | undefined {
  if (!costed) return candidates.find((g) => compileGoal(g, cid as CreatureId, r));
  const standing = standingPick.get(cid);
  const keyOf = (g: GoalSpec) => JSON.stringify(g);
  let group: GoalSpec[] = [];
  let groupKind: string | null = null;
  let best: { goal: GoalSpec; net: number } | undefined;
  const settle = () => {
    if (!best) return undefined;
    standingPick.set(cid, { tplKey, key: keyOf(best.goal) });
    return best.goal;
  };
  for (let i = 0; i <= candidates.length; i++) {
    const g = candidates[i];
    if (g && (groupKind === null || g.kind === groupKind)) {
      groupKind = g.kind;
      group.push(g);
      continue;
    }
    for (const cand of group) {
      const plan: GoalPlan | null = compileGoal(cand, cid as CreatureId, r);
      if (!plan) continue;
      let net = netValueS(tasteBonusS(cand), plan.cost);
      if (standing?.tplKey === tplKey && standing.key === keyOf(cand)) net += MARGIN_S;
      if (!best || net > best.net) best = { goal: cand, net };
    }
    if (best) return settle();
    group = g ? [g] : [];
    groupKind = g ? g.kind : null;
  }
  return settle();
}

describe("③ SEAT 4 — find(compileGoal) becomes an argmax over the compiled cost", () => {
  const rest = (id: string): GoalSpec => ({ kind: "rest", place: P(id), dwellS: 30 });
  const beds = world({ places: { near: at(4), far: at(20) } });

  it("the NEARER of two compiling candidates wins, whatever the list order", () => {
    for (const list of [[rest("near"), rest("far")], [rest("far"), rest("near")]]) {
      const pick = chooseNeedGoal(new Map(), "bear", "energy", list, beds);
      expect(pick).toEqual(rest("near"));
    }
  });

  it("flag OFF keeps FIRST-COMPILABLE, byte for byte (the kill-switch)", () => {
    const pick = chooseNeedGoal(new Map(), "bear", "energy", [rest("far"), rest("near")], beds, false);
    expect(pick).toEqual(rest("far"));
  });

  it("an UNPRICED resolver also lands on first-compilable — every plan ties at zero", () => {
    const blind = world({ places: { near: at(4), far: at(20) }, unpriced: true });
    const pick = chooseNeedGoal(new Map(), "bear", "energy", [rest("far"), rest("near")], blind);
    expect(pick).toEqual(rest("far"));
  });

  it("a candidate that CANNOT compile never wins, however cheap it would be", () => {
    const pick = chooseNeedGoal(new Map(), "bear", "energy", [rest("nowhere"), rest("far")], beds);
    expect(pick).toEqual(rest("far"));
  });

  describe("the HYSTERESIS margin holds the standing candidate", () => {
    it("a challenger inside the margin does NOT take the seat", () => {
      // near 4 m vs standing 12 m ⇒ the challenger is 5 s better, under the 6 s
      // margin: the body finishes what it started rather than turning round.
      const r = world({ places: { near: at(4), standing: at(12) } });
      const held = new Map([["bear", { tplKey: "energy", key: JSON.stringify(rest("standing")) }]]);
      expect((12 - 4) / WALK_MPS).toBeLessThan(MARGIN_S);
      expect(chooseNeedGoal(held, "bear", "energy", [rest("near"), rest("standing")], r)).toEqual(
        rest("standing"),
      );
    });

    it("…and a challenger PAST the margin does", () => {
      const r = world({ places: { near: at(4), standing: at(20) } });
      const held = new Map([["bear", { tplKey: "energy", key: JSON.stringify(rest("standing")) }]]);
      expect((20 - 4) / WALK_MPS).toBeGreaterThan(MARGIN_S);
      expect(chooseNeedGoal(held, "bear", "energy", [rest("near"), rest("standing")], r)).toEqual(rest("near"));
    });

    it("the margin protects only the SAME ROW's pick — a different motive starts fresh", () => {
      const r = world({ places: { near: at(4), standing: at(12) } });
      const held = new Map([["bear", { tplKey: "hygiene", key: JSON.stringify(rest("standing")) }]]);
      expect(chooseNeedGoal(held, "bear", "energy", [rest("near"), rest("standing")], r)).toEqual(rest("near"));
    });

    it("a settled pick is REMEMBERED, so the next decide is the one that holds", () => {
      const held = new Map<string, { tplKey: string; key: string }>();
      chooseNeedGoal(held, "bear", "energy", [rest("far"), rest("near")], beds);
      expect(held.get("bear")).toEqual({ tplKey: "energy", key: JSON.stringify(rest("near")) });
    });
  });

  describe("⚠️ THE GROUPS ARE NOT INTERCHANGEABLE", () => {
    // needPursuitGoals returns alternatives for the errand FOLLOWED BY the
    // degradation fallback (a bounded takeUnits leg). The fallback is shorter by
    // construction, so a flat argmin would take it every time and no hungry body
    // would ever walk to a meal again.
    const meals = world({
      places: { "store:food": at(1) },
      items: { apple1: at(40) },
      byState: { "": "apple1" },
    });
    const eat: GoalSpec = { kind: "consume", item: { match: { category: "food" } } };
    const buy: GoalSpec = { kind: "takeUnits", from: P("store:food"), category: "food", units: 1 };

    it("the FIRST group with anything compilable wins — a cheaper fallback stays a fallback", () => {
      expect(costTotalS(compileGoal(buy, "bear", meals)!.cost)).toBeLessThan(
        costTotalS(compileGoal(eat, "bear", meals)!.cost),
      );
      expect(chooseNeedGoal(new Map(), "bear", "hunger:food", [eat, buy], meals)).toEqual(eat);
    });

    it("…and when nothing in the first group compiles, the fallback still gets its turn", () => {
      const bare = world({ places: { "store:food": at(1) } }); // no food standing anywhere
      expect(compileGoal(eat, "bear", bare)).toBeNull();
      expect(chooseNeedGoal(new Map(), "bear", "hunger:food", [eat, buy], bare)).toEqual(buy);
    });
  });

  describe("the TASTE bonus — hot-meal-first stops being a list order", () => {
    const hot: GoalSpec = { kind: "consume", item: { match: { category: "food", state: "hot" } } };
    const raw: GoalSpec = { kind: "consume", item: { match: { category: "food" } } };
    const table = (hotAtM: number) =>
      world({ items: { meal1: at(hotAtM), apple1: at(4) }, byState: { hot: "meal1", "": "apple1" } });

    it("only a cooked meal carries one, and it is the documented exchange rate", () => {
      expect(tasteBonusS(hot)).toBe(HOT_MEAL_TASTE_S);
      expect(tasteBonusS(raw)).toBe(0);
      // Stated as a distance: 30 s at 1.6 m/s ≈ 48 m of extra walking.
      expect(HOT_MEAL_TASTE_S * WALK_MPS).toBeCloseTo(48);
    });

    it("the dinner on the table wins across a house (the shipped preference, priced)", () => {
      expect(chooseNeedGoal(new Map(), "bear", "hunger:food", [hot, raw], table(40))).toEqual(hot);
    });

    it("…but not across the town: past ~48 m further, the raw unit at hand wins", () => {
      expect(chooseNeedGoal(new Map(), "bear", "hunger:food", [hot, raw], table(100))).toEqual(raw);
    });
  });
});

// ═══ ④ ENABLE — THE BASKET QUESTION ═══════════════════════════════════════

/** A portable container standing free (quest-host `IdleBag`). */
interface IdleBag {
  objId: string;
  entityId: string;
  glyph: string;
  at: { x: number; y: number };
  room: number;
}

/** quest-host `idleBagsFor`, mirrored: id order, and never one another trip has
 *  already spoken for. (The ownership / play-area / carried-by filters are world
 *  reads; what this file owns is that a CLAIMED bag is invisible.) */
function idleBagsFor(bags: readonly IdleBag[], ledger: ReservationLedger): IdleBag[] {
  return bags
    .filter((b) => b.room > 0 && !toolClaimed(ledger, b.objId))
    .sort((a, b) => (a.objId < b.objId ? -1 : a.objId > b.objId ? 1 : 0));
}

/** quest-host `bagFetchGoal`, mirrored — "price the plan twice". */
function bagFetchGoal(
  tpl: NeedTemplate,
  ctx: NeedCtx,
  intent: Extract<NeedIntent, { kind: "take" }>,
  wrld: {
    body: { x: number; y: number };
    /** Where each candidate source stands (quest-host `containerAnchor`). */
    anchors: Record<string, { x: number; y: number }>;
    bags: readonly IdleBag[];
  },
  ledger: ReservationLedger,
  costed = true,
): GoalSpec | null {
  const p = ctx.price;
  if (!costed || !p) return null;
  const branchOf = (c: StockCandidate) =>
    ctx.sources.includes(c) ? "source" : (ctx.loose ?? []).includes(c) ? "loose" : "container";
  const value = (units: number) => goodsValueS(units, p.shortage, p.unitValueS, 1);
  const bare = netValueS(
    value(intent.units),
    priceOf({
      journeyS: journeyTimeS(intent.from.d ?? 0, p.walkMps),
      handsS: p.handsS[branchOf(intent.from)],
    }),
  );
  let best: { bag: IdleBag; net: number } | null = null;
  for (const bag of idleBagsFor(wrld.bags, ledger)) {
    if (bag.room <= (ctx.room ?? 1)) continue;
    const withBag = decideNeed(tpl, { ...ctx, room: bag.room });
    if (withBag.kind !== "take") continue;
    if (withBag.units <= intent.units) continue;
    const srcAt = wrld.anchors[withBag.from.id];
    if (!srcAt) continue;
    const net = netValueS(
      value(withBag.units),
      priceOf({
        journeyS:
          journeyTimeS(dist(wrld.body, bag.at), p.walkMps) + journeyTimeS(dist(bag.at, srcAt), p.walkMps),
        handsS: BOX_S + p.handsS[branchOf(withBag.from)],
      }),
    );
    if (!best || net > best.net) best = { bag, net };
  }
  if (!best || !(best.net > bare)) return null;
  return { kind: "fetch", item: { id: best.bag.entityId } };
}

describe("④ ENABLE at the BODY rung — bring a basket when the basket pays", () => {
  const hunger = hungerTemplate("food", 1 / NEED_FILL_S.hunger);
  /** Keep the box FULL: fires below 6, caps at 6, so the shortfall and the home
   *  box's remaining room are one number at every fill level. */
  const provision = provisionTemplate("food", 6, 6);
  const price = (over: Partial<NeedPrice> = {}): NeedPrice => ({
    walkMps: WALK_MPS,
    fillS: NEED_FILL_S.hunger,
    unitValueS: 5 * NEED_PRESSURE_S,
    shortage: 1,
    handsS: { container: BOX_S, source: SHOP_S, loose: BOX_S, satisfy: EAT_S },
    ...over,
  });
  // ⚖️ WHOSE QUESTION THE BASKET IS (household-economy-and-where-is.md §2, law
  // ②). "Would a bag pay for itself" is an INVENTORY MANAGER's question: it is
  // asked of a haul, and only a haul can grow to fill a bag. A CUSTOMER's want
  // is one ration however much room it has, so `decideNeed` returns the same
  // units with a basket as without and the comparison never starts — pinned
  // below rather than assumed. The restocking cases therefore ride the
  // provision row, where the enabler is real; the hunger cases pin the
  // customer's own two answers (the famine trip still fetches; a stocked
  // house's meal never does).
  /** THE MANAGER's ctx: BARE HANDS (room 1), a pantry to fill, a house cupboard
   *  with one unit in it three metres off, and the market 60 m out. */
  const restocking = (pantryUnits: number, pantryRoom: number): NeedCtx => ({
    carried: 0,
    room: 1,
    restock: pantryRoom,
    containers: {
      home: { id: "pantry", place: P("pantry"), units: pantryUnits, room: pantryRoom, d: 3 },
      storage: { id: "cupboard", place: P("cupboard"), units: 1, free: 1, d: 3 },
    },
    sources: [{ id: "store:food", place: P("store:food"), units: 50, d: 60 }],
    stations: [],
    price: price({ shortage: pantryRoom / (pantryUnits + pantryRoom) }),
  });
  /** THE CUSTOMER's ctx: a hungry body with BARE HANDS and the same geometry.
   *  `shortage: 1` is what `needShortageOf` hands every non-deposit row. */
  const shopping = (pantryUnits: number, pantryRoom: number): NeedCtx => ({
    meter: 1,
    carried: 0,
    room: 1,
    restock: pantryRoom,
    containers: { home: { id: "pantry", place: P("pantry"), units: pantryUnits, room: pantryRoom, d: 3 } },
    sources: [{ id: "store:food", place: P("store:food"), units: 50, d: 60 }],
    stations: [],
    price: price({ shortage: 1 }),
  });
  const basket = (x: number, room = 8): IdleBag => ({
    objId: "small:basket_0",
    entityId: "e_basket_0",
    glyph: "basket",
    at: at(x),
    room,
  });
  /** Where the offers stand: the pantry and the cupboard at home, the market
   *  60 m out. */
  const shop = { body: at(0), anchors: { pantry: at(3), cupboard: at(3), "store:food": at(60) } };
  const takeOf = (tpl: NeedTemplate, ctx: NeedCtx) =>
    decideNeed(tpl, ctx) as Extract<NeedIntent, { kind: "take" }>;
  const led = () => createReservationLedger();

  it("FIVE SHORT: bare-handed the cupboard's ONE unit wins — with a basket the MARKET does", () => {
    // The whole ENABLE argument in one case. A market trip you can only bring
    // one unit back from loses to the unit three metres away; the same trip
    // with a bag brings five and pays for the detour. So the enabler does not
    // merely enlarge the trip — it CHANGES WHERE YOU SHOP, which is why the bag
    // plan is priced against its own source rather than forced onto the bare
    // plan's.
    const ctx = restocking(1, 5);
    const intent = takeOf(provision, ctx);
    expect(intent).toMatchObject({ kind: "take", units: 1 });
    expect(intent.from.id).toBe("cupboard");
    expect(decideNeed(provision, { ...ctx, room: 8 })).toMatchObject({ units: 5, from: { id: "store:food" } });
    expect(bagFetchGoal(provision, ctx, intent, { ...shop, bags: [basket(4)] }, led())).toEqual({
      kind: "fetch",
      item: { id: "e_basket_0" },
    });
  });

  it("ONE SHORT: the household wants a single unit, so a basket buys NOTHING", () => {
    // The bag's room is irrelevant when the restock target is the binding
    // constraint — the comparison never even reaches the walk.
    const ctx = restocking(5, 1);
    const intent = takeOf(provision, ctx);
    expect(decideNeed(provision, { ...ctx, room: 8 })).toMatchObject({ units: 1 });
    expect(bagFetchGoal(provision, ctx, intent, { ...shop, bags: [basket(4)] }, led())).toBeNull();
  });

  it("THE SAME WANT fetches or refuses, on the basket's DISTANCE alone", () => {
    // An empty pantry wanting two: the bag buys exactly ONE extra ration, so the
    // detour has a small budget and the metres decide it. This is the HUNGER
    // row — an empty shelf sends a customer out too, and `takeUnits` still
    // sizes that trip to the restock target (the famine-fix behaviour).
    const ctx = shopping(0, 2);
    const intent = takeOf(hunger, ctx);
    expect(intent).toMatchObject({ units: 1, from: { id: "store:food" } });
    expect(decideNeed(hunger, { ...ctx, room: 8 })).toMatchObject({ units: 2 });
    expect(bagFetchGoal(hunger, ctx, intent, { ...shop, bags: [basket(4)] }, led())).not.toBeNull();
    // …and 160 m in the WRONG direction, for one extra ration, is not worth it.
    expect(bagFetchGoal(hunger, ctx, intent, { ...shop, bags: [basket(-160)] }, led())).toBeNull();
  });

  it("🚨 A CUSTOMER NEVER FETCHES A BASKET WHILE THE SHELF HAS ANY (law ②)", () => {
    // The report's stampede, at the enabler: a hungry member of a five-short
    // household used to fetch the household's bag and walk to the market past
    // the ration in its own pantry. Its want is ONE ration, so the bag plan
    // brings back no more than the bare plan and the detour is never priced.
    const ctx = shopping(1, 5);
    const intent = takeOf(hunger, ctx);
    expect(intent).toMatchObject({ kind: "take", units: 1, from: { id: "pantry" } });
    expect(decideNeed(hunger, { ...ctx, room: 8 })).toMatchObject({ units: 1, from: { id: "pantry" } });
    expect(bagFetchGoal(hunger, ctx, intent, { ...shop, bags: [basket(4)] }, led())).toBeNull();
  });

  it("a bag with no more room than the HANDS is no enabler at all", () => {
    const ctx = restocking(1, 5);
    const intent = takeOf(provision, ctx);
    const full = { ...basket(2), room: 1 };
    expect(bagFetchGoal(provision, ctx, intent, { ...shop, bags: [full] }, led())).toBeNull();
  });

  it("a bag ANOTHER trip has spoken for is invisible — no two bodies count one basket", () => {
    const ctx = restocking(1, 5);
    const intent = takeOf(provision, ctx);
    const l = led();
    l.reserve("bag:agr_1", "small:basket_0", TOOL_CLAIM_GLYPH, 1);
    expect(bagFetchGoal(provision, ctx, intent, { ...shop, bags: [basket(4)] }, l)).toBeNull();
    // …and it comes back the moment that trip is over.
    l.release("bag:agr_1");
    expect(bagFetchGoal(provision, ctx, intent, { ...shop, bags: [basket(4)] }, l)).not.toBeNull();
  });

  it("the NEAREST usable basket wins, deterministically", () => {
    const ctx = restocking(1, 5);
    const intent = takeOf(provision, ctx);
    const near: IdleBag = { ...basket(6), objId: "small:basket_z", entityId: "e_z" };
    const far: IdleBag = { ...basket(-40), objId: "small:basket_a", entityId: "e_a" };
    const pick = bagFetchGoal(provision, ctx, intent, { ...shop, bags: [far, near] }, led());
    expect(pick).toEqual({ kind: "fetch", item: { id: "e_z" } });
    // Same inputs, same choice — no clock, no RNG.
    expect(bagFetchGoal(provision, ctx, intent, { ...shop, bags: [far, near] }, led())).toEqual(pick);
  });

  it("flag OFF: nobody ever fetches a bag (the kill-switch)", () => {
    const ctx = restocking(1, 5);
    const intent = takeOf(provision, ctx);
    expect(bagFetchGoal(provision, ctx, intent, { ...shop, bags: [basket(4)] }, led(), false)).toBeNull();
  });
});

/** quest-host `haulBagLeg`, mirrored — §2.9 BATCH: price the whole trip and
 *  DIVIDE BY THE UNITS MOVED. */
function haulBagLeg(
  units: number,
  room: number,
  body: { x: number; y: number },
  srcAt: { x: number; y: number },
  destAt: { x: number; y: number },
  bags: readonly IdleBag[],
  ledger: ReservationLedger,
  costed = true,
): IdleBag | null {
  if (!costed) return null;
  if (units <= room) return null;
  const leg = (a: { x: number; y: number }, b: { x: number; y: number }) => journeyTimeS(dist(a, b), WALK_MPS);
  const acts = 2 * BOX_S;
  const carriedBare = Math.min(units, room);
  const perUnitBare =
    carriedBare > 0 ? (leg(body, srcAt) + leg(srcAt, destAt) + acts) / carriedBare : Number.POSITIVE_INFINITY;
  let best: { bag: IdleBag; per: number } | null = null;
  for (const bag of idleBagsFor(bags, ledger)) {
    const carried = Math.min(units, bag.room);
    if (carried <= carriedBare) continue;
    const per = (leg(body, bag.at) + leg(bag.at, srcAt) + leg(srcAt, destAt) + acts + BOX_S) / carried;
    if (!best || per < best.per) best = { bag, per };
  }
  return best && best.per < perUnitBare ? best.bag : null;
}

describe("④ ENABLE at the TOWN rung — 'one block at a time' becomes a division", () => {
  const yardBasket: IdleBag = {
    objId: "small:yard_basket",
    entityId: "e_yard_basket",
    glyph: "basket",
    at: at(2),
    room: 8,
  };
  const SRC = at(10);
  const DST = at(30);
  const BODY = at(0);

  it("a SIX-BLOCK haul with bare hands picks up the yard basket", () => {
    const bag = haulBagLeg(6, 1, BODY, SRC, DST, [yardBasket], createReservationLedger());
    expect(bag?.objId).toBe("small:yard_basket");
  });

  it("…and a ONE-BLOCK haul does not: one trip covers it bare-handed", () => {
    expect(haulBagLeg(1, 1, BODY, SRC, DST, [yardBasket], createReservationLedger())).toBeNull();
  });

  it("…nor does a basket four hundred metres away, for six blocks", () => {
    const away = { ...yardBasket, at: at(-400) };
    expect(haulBagLeg(6, 1, BODY, SRC, DST, [away], createReservationLedger())).toBeNull();
  });

  it("a porter who ALREADY has a bag never detours (room already covers the bill)", () => {
    expect(haulBagLeg(6, 8, BODY, SRC, DST, [yardBasket], createReservationLedger())).toBeNull();
  });

  it("the arithmetic, spelled out: per-unit cost is what decides", () => {
    const leg = (a: { x: number; y: number }, b: { x: number; y: number }) => dist(a, b) / WALK_MPS;
    const bare = leg(BODY, SRC) + leg(SRC, DST) + 2 * BOX_S; // ÷ 1 unit
    const withBag = (leg(BODY, yardBasket.at) + leg(yardBasket.at, SRC) + leg(SRC, DST) + 2 * BOX_S + BOX_S) / 6;
    expect(withBag).toBeLessThan(bare);
    expect(haulBagLeg(6, 1, BODY, SRC, DST, [yardBasket], createReservationLedger())).not.toBeNull();
  });

  describe("TWO PORTERS, ONE BASKET — and the unobserved twin", () => {
    it("the first speaks for it; the second re-plans at bare capacity", () => {
      const led = createReservationLedger();
      const first = haulBagLeg(6, 1, BODY, SRC, DST, [yardBasket], led);
      expect(first).not.toBeNull();
      led.reserve("bag:agr_1", first!.objId, TOOL_CLAIM_GLYPH, 1); // issueTransferHaul's claim
      expect(haulBagLeg(6, 1, BODY, SRC, DST, [yardBasket], led)).toBeNull();
      // Exactly ONE claim stands — never two counting the same basket.
      expect(led.reservedUnits(yardBasket.objId, TOOL_CLAIM_GLYPH)).toBe(1);
    });

    it("THE TWIN MIRRORS THE OBSERVED ARM: a haul it resolves away gives the basket back", () => {
      // twinResolveHauls fails an unloaded, unobserved haul ("no-executor") and
      // releases BOTH its material claim and its bag claim. Without the second
      // release, a trip that never happened would retire the town's only basket
      // and the two arms would disagree about how much a haul can carry.
      const led = createReservationLedger();
      led.reserve("agr:agr_1", "yard", "wood", 6);
      led.reserve("bag:agr_1", yardBasket.objId, TOOL_CLAIM_GLYPH, 1);
      expect(toolClaimed(led, yardBasket.objId)).toBe(true);
      led.release("agr:agr_1");
      led.release("bag:agr_1");
      expect(toolClaimed(led, yardBasket.objId)).toBe(false);
      expect(haulBagLeg(6, 1, BODY, SRC, DST, [yardBasket], led)).not.toBeNull();
      expect(led.toJSON().rows).toHaveLength(0); // no residue on either side
    });

    it("the holder GC is BLIND and idempotent — a dead trip's claim never outlives it", () => {
      // The staging sweep walks `bag:` rows and releases any whose agreement is
      // no longer pending/moving. Mirrored: the holder names its own agreement.
      const led = createReservationLedger();
      led.reserve("bag:agr_dead", yardBasket.objId, TOOL_CLAIM_GLYPH, 1);
      const alive = new Set(["agr_live"]);
      for (const row of led.toJSON().rows) {
        if (row.holder.startsWith("bag:") && !alive.has(row.holder.slice(4))) led.release(row.holder);
      }
      expect(toolClaimed(led, yardBasket.objId)).toBe(false);
    });
  });

  it("flag OFF: no porter ever detours for a bag (the kill-switch)", () => {
    expect(haulBagLeg(6, 1, BODY, SRC, DST, [yardBasket], createReservationLedger(), false)).toBeNull();
  });
});

// ═══ ⑤ THE TWO REPORTED LOOPS — CLOSED ════════════════════════════════════
//
// Live report (2026-08-02, verbatim): creatures "carrying items around for no
// clear reason … moving items from containers to the floor and then back to
// containers". PASS 2 diagnosed both and fixed neither, and pinned the broken
// behavior here as evidence; PASS 3 turns those probes into pins of the fix.
// Each block keeps its diagnosis verbatim, because the diagnosis is why the
// numbers below are the numbers they are — and neither fix is a cooldown, a
// grace period or a retry budget. Both are one more term in the same
// subtraction.

describe("⑤ LOOP 1 — container → floor → container (fun ⇄ tidy), closed by forgoneS", () => {
  // PASS-2 DIAGNOSIS, verbatim: "Both rows reach for the SAME loose unit at the
  // SAME distance, so the plan costs cancel exactly and the ladder decides
  // unchanged: tidy 48 s vs fun 40 s. A bored body picks its toy up to put it
  // away; then `inUseByLiveNeed` hides it from tidy and fun sets it back out.
  // The missing number is `forgoneS` — the swept unit's placement value."
  const fun = funTemplate(1 / NEED_FILL_S.fun);
  const tidy = tidyTemplate();
  const ROWS = [fun, tidy];
  const toy: StockCandidate = { id: "small:teddy", place: P("small:teddy"), units: 1, d: 3 };
  const price = (unitValueS: number): NeedPrice => ({
    walkMps: WALK_MPS,
    fillS: NEED_FILL_S.fun,
    unitValueS,
    shortage: 1,
    handsS: { container: BOX_S, source: SHOP_S, loose: BOX_S, satisfy: BOX_S },
  });

  /** quest-host `inPlaceWants` + its per-candidate `servesS`, mirrored — WHAT
   *  THE TEDDY IS WORTH WHERE IT LIES.
   *
   *  A row wants a unit IN PLACE when it USES what it takes (any satisfy but
   *  `deposit` — the deposit family IS the removing family) and would take it
   *  AS IT LIES (an acquire `loose` branch: a row that only reaches into boxes
   *  is not served by anything on the floor). What the want is worth is
   *  `rowValueS`'s own drive arm, read at whichever HOUSEMATE's meter is
   *  highest. The glyph→row match is `matchesNeedItem` in the host; of the rows
   *  here exactly one qualifies for a teddy, and it is fun.
   *
   *  ⚠️ Not a toys list and not a boolean: the NUMBER is the boredom. */
  const servesS = (funMeters: readonly number[]): number => {
    let best = 0;
    for (const t of ROWS) {
      if (t.satisfy.kind === "deposit") continue;
      if (!t.acquire.some((a) => a.kind === "loose")) continue;
      const threshold = t.drive.kind === "meter" ? t.drive.threshold : 1;
      for (const meter of funMeters) {
        const pressure = threshold > 0 ? meter / threshold : 1;
        const clock = NEED_FILL_S.fun;
        best = Math.max(best, driveValueS((pressure * t.priority * NEED_PRESSURE_S) / clock, clock));
      }
    }
    return best;
  };

  /** A teddy on the floor, the box it belongs in, and a HOUSE whose fun meters
   *  are `funMeters` — index 0 is the deciding body, the rest are housemates.
   *  Everything below varies only that list. (Exactly what quest-host resolves:
   *  `tidy`'s storage role carries NO room, so its shortage is 1, and both rows
   *  reach for the SAME loose unit at the same 3 m.) */
  const house = (funMeters: readonly number[]) => (tpl: NeedTemplate): NeedCtx => {
    if (tpl.key === "fun") {
      return {
        meter: funMeters[0] ?? 0, carried: 0, room: 1, containers: {}, sources: [], stations: [],
        loose: [toy], price: price(1 * NEED_PRESSURE_S),
      };
    }
    const s = servesS(funMeters);
    return {
      meter: 0, carried: 0, room: 1, sources: [], stations: [],
      // THE ONE NEW FACT IN THE CTX: the sweep's candidate carries what it is
      // worth WHERE IT LIES. The host resolves it off the household's own row
      // set; needs.ts charges it to the plan that would move the thing.
      loose: [s > 0 ? { ...toy, servesS: s } : toy],
      containers: { storage: { id: "furn_0_box_0", place: P("furn_0_box_0"), units: 0, d: 3 } },
      price: price(1.2 * NEED_PRESSURE_S),
    };
  };
  /** The pickup BOTH rows plan, to the metre — it cancels, which is the whole
   *  reason a cost pass alone could not settle this. */
  const LEG_S = 3 / WALK_MPS + BOX_S;

  it("🚨 THE LOOP, CLOSED: a bored body PLAYS with its toy instead of filing it", () => {
    // What changed is ONE NUMBER and no mechanism. The legs still cancel; the
    // sweep now also pays what the teddy is doing where it lies, so tidy bids
    // 48 − 40 = 8 hand-seconds against fun's 40 and loses by a mile. The body
    // picks the toy up TO PLAY WITH IT, which is the same lift it was making
    // before and a completely different reason.
    const pick = decideNeeds(ROWS, house([1]), { costSelection: true });
    expect(pick?.tpl.key).toBe("fun");
    expect(pick?.intent).toMatchObject({ kind: "take", from: { id: "small:teddy" } });
  });

  it("THE PASS-2 EVIDENCE, kept: without the charge the ladder still says tidy", () => {
    // The probe this file shipped last pass, run against a house where nobody
    // is bored at all — which is the only state in which the old arithmetic was
    // the whole arithmetic. tidy's 48 against fun's 40, the legs cancelling.
    const funNet = 1 * NEED_PRESSURE_S - LEG_S;
    const tidyNet = 1.2 * NEED_PRESSURE_S - LEG_S;
    expect(tidyNet).toBeGreaterThan(funNet);
    expect(tidyNet - funNet).toBeCloseTo(0.2 * NEED_PRESSURE_S); // one fifth of a rung
    // …and flag OFF is still that ladder, byte for byte: the kill-switch buys
    // back the shipped behavior including the loop.
    expect(decideNeeds(ROWS, house([1]), { costSelection: false })?.tpl.key).toBe("tidy");
  });

  it("THE CHARGE, spelled out: forgoneS is the serving row's own value, and only the REMOVER pays", () => {
    const tidyCtx = house([1])(tidy);
    const sweep = decideNeed(tidy, tidyCtx, { costSelection: true });
    expect(sweep).toMatchObject({ kind: "take", from: { id: "small:teddy" } });
    const cost = intentCost(tidy, tidyCtx, sweep);
    expect(cost.forgoneS).toBeCloseTo(1 * NEED_PRESSURE_S); // fun at its threshold: 40
    expect(cost.journeyS + cost.handsS).toBeCloseTo(LEG_S); // the leg is unchanged
    // …and the row that wants the toy WHERE IT IS pays nothing for wanting it.
    // Charging both sides would deadlock the pair instead of deciding it.
    const funCtx = house([1])(fun);
    expect(intentCost(fun, funCtx, decideNeed(fun, funCtx, { costSelection: true })).forgoneS).toBe(0);
    // An UNPRICED ctx charges nothing either — the byte-identical property.
    const blind: NeedCtx = { ...tidyCtx, price: undefined };
    expect(intentCost(tidy, blind, decideNeed(tidy, blind, { costSelection: true })).forgoneS).toBe(0);
  });

  it("🚨 BOTH DIRECTIONS: a toy nobody wants is SWEPT, one a bored housemate wants is NOT", () => {
    // ① NOBODY is bored — the teddy serves nothing where it lies, the charge is
    //    zero, and the chore is exactly the chore it always was.
    expect(decideNeeds(ROWS, house([0, 0]), { costSelection: true })).toMatchObject({
      tpl: { key: "tidy" },
      intent: { kind: "take", from: { id: "small:teddy" } },
    });
    // ② THIS body isn't bored; a HOUSEMATE is. The exchange rate is the whole
    //    answer and it is honest about being an exchange: 48 hand-seconds of
    //    chore against 40 per cycle of somebody's boredom, so the want has to
    //    OUTBID the chore before the room's tidier leaves the toy out. A
    //    housemate a fifth of a cycle past its threshold does that…
    expect(servesS([0, 1.2])).toBeCloseTo(1.2 * NEED_PRESSURE_S);
    expect(decideNeeds(ROWS, house([0, 1.2]), { costSelection: true })).toBeNull();
    // …and the refusal is IDLE, never blocked: nothing is unservable here, there
    // is simply nothing worth putting away. (A blocked tidy row would demote the
    // body and surface a want nobody can help with.)
    expect(decideNeed(tidy, house([0, 1.2])(tidy), { costSelection: true })).toEqual({ kind: "idle" });
    // ③ …and a housemate only JUST at its threshold does not: a want has to be
    //    worth more than the chore, not merely exist. No cliff, no cooldown —
    //    the protection grows with the meter and vanishes with it.
    expect(decideNeeds(ROWS, house([0, 1]), { costSelection: true })?.tpl.key).toBe("tidy");
  });

  it("the CYCLE, as it now runs (nothing here is scripted — each step is one decide)", () => {
    const inBox: StockCandidate = { id: "furn_0_box_0", place: P("furn_0_box_0"), units: 1, d: 3 };
    // ① toy in the box, bored → fetch it out.
    const boxed = (tpl: NeedTemplate): NeedCtx =>
      tpl.key === "fun"
        ? { meter: 1, carried: 0, room: 1, sources: [], stations: [], loose: [],
            containers: { storage: inBox }, price: price(1 * NEED_PRESSURE_S) }
        : { meter: 0, carried: 0, room: 1, sources: [], stations: [], loose: [],
            containers: { storage: { ...inBox, units: 0 } }, price: price(1.2 * NEED_PRESSURE_S) };
    expect(decideNeeds(ROWS, boxed, { costSelection: true })?.tpl.key).toBe("fun");
    // ② toy in hand → set it out on the floor (the play area).
    const holding = (tpl: NeedTemplate): NeedCtx =>
      tpl.key === "fun" ? { ...boxed(tpl), carried: 1 } : { ...boxed(tpl), carried: 0 };
    expect(decideNeeds(ROWS, holding, { costSelection: true })).toMatchObject({
      tpl: { key: "fun" },
      intent: { kind: "setOutHere" },
    });
    // ③ ⚠️ THE STEP THAT USED TO CLOSE THE LOOP. Toy loose, body STILL bored:
    //    the old ladder swept it straight back into the box while the meter was
    //    up. Now the sweep is priced against the boredom and the body plays.
    expect(decideNeeds(ROWS, house([1]), { costSelection: true })?.tpl.key).toBe("fun");
    // ④ played out (meter 0), toy loose, nobody else bored → tidy files it, and
    //    the round trip is a LIFE CYCLE rather than a spin: fetch, play, put
    //    away, once per fun clock instead of once per decide.
    expect(decideNeeds(ROWS, house([0]), { costSelection: true })?.tpl.key).toBe("tidy");
  });
});

describe("⑤ LOOP 2 — the leftover-unit bag deadlock, closed by the outlet test", () => {
  // PASS-2 DIAGNOSIS, verbatim: "a BAG with a leftover unit is invisible to
  // every row that could put it down: `heldIdleObject` refuses a non-empty bag;
  // `carriedClutter` skips provisioned heads; the goods row blocks on a full
  // box. `decideNeeds` returns blocked with nothing actionable and the body
  // walks on carrying."
  const provision = provisionTemplate("food", 5, 6);
  const unload = unloadTemplate();
  const relieve = relieveTemplate();
  const hunger = hungerTemplate("food", 1 / NEED_FILL_S.hunger);
  const ROWS = [hunger, provision, unload, relieve];
  const CHEST = "furn_0_chest_food";
  const CAP = 6;

  /** quest-host `bagUnitsHaveAnOutlet`, mirrored — the question that replaced
   *  the flat "is the bag empty". Has some unit in it somewhere ACTIONABLE to
   *  be: ① a row on this body that will USE IT UP (firing — a want that has not
   *  asked yet is no reason to keep hold of a bag), or ② a destination with
   *  room? If neither, holding the bag buys nothing and it is idle. */
  const bagHasOutlet = (
    bag: Readonly<Record<string, number>>,
    boxRoom: number,
    firesFor: (glyph: string) => boolean,
  ): boolean => {
    for (const [glyph, n] of Object.entries(bag)) {
      if (n <= 0) continue;
      if (firesFor(glyph)) return true; // ① a row that consumes it
      if (boxRoom > 0) return true; // ② a destination with room
    }
    return false;
  };

  /** A porter holding a BASKET with one apple left in it, a home chest with
   *  `boxRoom` units of room, and a body that is `hungry` or not. Everything
   *  quest-host resolves is here: the apple is a PROVISIONED head (so
   *  `carriedClutter` skips it and unload never sees it), the basket
   *  `livesOnTheFloor` (so the put-down row gets no storage role and its only
   *  answer is `orDrop`), and the bag's idleness is the outlet test above. */
  const porter = (boxRoom: number, hungry = false) => (tpl: NeedTemplate): NeedCtx => {
    const idleBag = !bagHasOutlet({ apple: 1 }, boxRoom, () => hungry);
    const shortage = boxRoom / CAP;
    return {
      meter: tpl.key === "hunger:food" && hungry ? 1 : 0,
      carried:
        tpl.key === "provision:food" || tpl.key === "hunger:food"
          ? 1
          : tpl.key === "relieve"
            ? (idleBag ? 1 : 0)
            : 0, // unload: `carriedClutter` skips provisioned heads
      room: CAP,
      sources: [],
      stations: [],
      containers: {
        home: { id: CHEST, place: P(CHEST), units: CAP - boxRoom, room: boxRoom, d: 2 },
      },
      price: {
        walkMps: WALK_MPS,
        fillS: tpl.key === "hunger:food" ? NEED_FILL_S.hunger : NEED_FILL_S.hunger,
        // The put-down row's own weight; everything else is priced by the drive
        // the food will serve (`unitValueSOf`).
        unitValueS: (tpl.key === "relieve" ? relieve.priority : 5) * NEED_PRESSURE_S,
        shortage: tpl.key === "relieve" ? 1 : shortage,
        handsS: { container: BOX_S, source: SHOP_S, loose: BOX_S, satisfy: BOX_S },
      },
    };
  };

  it("🚨 THE DEADLOCK, CLOSED: the full box makes the basket IDLE and it goes down", () => {
    // Every row that could empty a pair of hands, and what each one now sees:
    //   provision  the food, and its home box is FULL       → blocked (honest)
    //   unload     provisioned heads are not clutter        → idle
    //   relieve    the apple has NO outlet, so the BAG is   → dropHere
    //              idle whatever is in it
    // The want still surfaces — it is real — but the body is no longer stuck
    // behind it: it sets the basket down and walks on with empty hands.
    const decided = decideNeeds(ROWS, porter(0), { costSelection: true });
    expect(decided).toMatchObject({ tpl: { key: "relieve" }, intent: { kind: "dropHere", units: 1 } });
    expect(decided?.blocked?.tpl.key).toBe("provision:food");
  });

  it("THE BAG GOES DOWN WHOLE — one intent, one unit, nothing spilled", () => {
    // `dropHere` names the ONE object in the hands (the put-down row's `carried`
    // is `heldIdleObject`, never a stack count), and the host's drop effect
    // spends that single unit on the bag arm: the basket leaves through
    // `setDownFromHands` under its own object id and its stock rides with it —
    // the water-in-the-barrel law. Nothing is ever tipped out to make a bag
    // light enough to put down.
    const intent = decideNeed(relieve, porter(0)(relieve), { costSelection: true });
    expect(intent).toEqual({ kind: "dropHere", units: 1 });
  });

  it("A ROW THAT WILL USE IT UP keeps the bag in the hands — the apple is lunch", () => {
    // Outlet ①. A hungry body's basket is not idle however full the chest is:
    // something on this body is about to eat what is in it.
    const decided = decideNeeds(ROWS, porter(0, true), { costSelection: true });
    expect(decided?.tpl.key).toBe("hunger:food");
    expect(decideNeed(relieve, porter(0, true)(relieve), { costSelection: true })).toEqual({ kind: "idle" });
  });

  it("…and the escape by the OTHER door is unchanged: any room, and the goods row banks", () => {
    // Outlet ②, and the pass-2 pin kept as-is. The moment the chest has room the
    // basket is in use again (its contents have somewhere to be), the put-down
    // row stands down, and provision walks the apple home. No cooldown was ever
    // involved on either side of this.
    expect(decideNeeds(ROWS, porter(2), { costSelection: true })).toMatchObject({
      tpl: { key: "provision:food" },
      intent: { kind: "deposit", units: 1 },
    });
    expect(decideNeed(relieve, porter(2)(relieve), { costSelection: true })).toEqual({ kind: "idle" });
  });

  it("THE WAY BACK: a set-down basket with a unit still in it is an ORDINARY idle bag", () => {
    // Nothing spills to empty a bag and no timer sends anyone back for it. The
    // basket on the floor is a container scope like any other — one apple in it,
    // seven units of room — so `idleBagsFor` keeps offering it and the
    // household's next restock trip fetches it through the ENABLE comparison in
    // ④ above. The apple rides home with the shopping the moment the chest has
    // room for it.
    const set: IdleBag = { objId: "small:basket_0", entityId: "e_basket_0", glyph: "basket", at: at(2), room: 7 };
    expect(idleBagsFor([set], createReservationLedger())).toEqual([set]);
    // …and a bag with no room left is not offered at all, which is what stops
    // the door being a revolving one.
    expect(idleBagsFor([{ ...set, room: 0 }], createReservationLedger())).toEqual([]);
  });
});

// ═══ ⑥ THE FLOOR BASKET JOINS THE SOURCE WALK (pass 4, work item B) ═══════
//
// PASS-3 GAP, verbatim: "a floor basket's contents are visible to NO acquire
// branch — `houseContainerKeys` is `furn_*` only — so a set-down basket is
// drained only by someone picking it back up, never drawn from in place."
//
// ⑤ LOOP 2 above ends with a basket standing on the floor with one apple still
// in it. That is where this picks up: the apple has to be reachable WHERE IT
// LIES, or the household's only way back to it is to lift the whole basket —
// which is the pickup the outlet test just spent its effort avoiding.
describe("⑥ the set-down basket is a SOURCE, drawn from in place", () => {
  const BASKET = "small:basket_0";
  const WARDROBE = "furn_0_chest_clothing";

  /** quest-host `floorContainerKeys`, mirrored: REGISTERED containers standing
   *  in the house (`session.containers.has` — a basket, a satchel, a loose
   *  barrel; anything bolted down has a `furn_*` id and comes through the index
   *  instead), in nobody's hands, not themselves shelved, inside the room's
   *  rect — in id order, so two bodies deciding in one tick see one list. */
  interface FloorProp {
    objId: string;
    registered: boolean;
    carriedBy?: string;
    containedIn?: string;
    at: { x: number; y: number };
  }
  const ROOM = { x: 0, y: 0, w: 10, h: 10 };
  const floorContainerKeys = (props: readonly FloorProp[]): string[] =>
    props
      .filter(
        (p) =>
          p.registered &&
          !p.carriedBy &&
          !p.containedIn &&
          p.at.x >= ROOM.x &&
          p.at.x <= ROOM.x + ROOM.w &&
          p.at.y >= ROOM.y &&
          p.at.y <= ROOM.y + ROOM.h,
      )
      .map((p) => p.objId)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const prop = (objId: string, over: Partial<FloorProp> = {}): FloorProp => ({
    objId,
    registered: true,
    at: at(2),
    ...over,
  });

  it("THE ENUMERATION: what joins the walk, and what is somebody else's business", () => {
    expect(
      floorContainerKeys([
        prop("small:basket_1"),
        prop("small:basket_0"),
        prop("small:barrel_0"), // a LOOSE barrel is as much a container as a standing one
        prop("small:apple_0", { registered: false }), // an apple is a unit, not a box
        prop("small:basket_held", { carriedBy: "resident_0_1" }), // in a pair of hands
        prop("small:basket_boxed", { containedIn: "furn_0_chest_food" }), // inside a chest
        prop("small:basket_street", { at: at(40) }), // out in the town
      ]),
    ).toEqual(["small:barrel_0", "small:basket_0", "small:basket_1"]);
  });

  it("🚨 THE PIN: the housemate's put-away row draws the apple FROM THE BASKET, in place", () => {
    // `stow` is the provision-shaped deposit row that reaches the floor at all
    // (deposit into the house box, acquire `loose`). Its take now names the
    // BASKET — a real stack draw of one garment — and its deposit still names
    // the WARDROBE. One way: the floor container is a source of opportunity,
    // never a destination of record.
    const stow = stowTemplate("clothing", 8);
    const ctx: NeedCtx = {
      carried: 0,
      room: 4,
      containers: { home: { id: WARDROBE, place: P(WARDROBE), units: 0, room: 8, d: 4 } },
      sources: [],
      stations: [],
      // The basket, listed among the loose as a BOX: real units, free-adjusted,
      // priced by its own distance — exactly the shape the furniture raid has
      // always had, and with no `servesS` (a stack in a box is not a placement).
      loose: [{ id: BASKET, place: P(BASKET), units: 1, free: 1, d: 2 }],
    };
    const intent = decideNeed(stow, ctx, { costSelection: true });
    expect(intent).toMatchObject({ kind: "take", from: { id: BASKET }, units: 1 });
    // NO RE-PICKUP: the thing the plan names is the basket as a SOURCE, and the
    // unit that moves is the garment — one unit, out of the basket's stack.
    expect((intent as Extract<NeedIntent, { kind: "take" }>).from.units).toBe(1);
  });

  it("…and the very next decide banks it in the wardrobe (the one-way move)", () => {
    const stow = stowTemplate("clothing", 8);
    expect(
      decideNeed(
        stow,
        {
          carried: 1, // the garment is in hand now
          room: 4,
          containers: { home: { id: WARDROBE, place: P(WARDROBE), units: 0, room: 8, d: 4 } },
          sources: [],
          stations: [],
          loose: [],
        },
        { costSelection: true },
      ),
    ).toMatchObject({ kind: "deposit", into: { id: WARDROBE }, units: 1 });
  });

  it("CLAIMS APPLY: a basket a housemate has spoken dry is not a source for you", () => {
    const stow = stowTemplate("clothing", 8);
    const intent = decideNeed(
      stow,
      {
        carried: 0,
        room: 4,
        containers: { home: { id: WARDROBE, place: P(WARDROBE), units: 0, room: 8, d: 4 } },
        sources: [],
        stations: [],
        loose: [{ id: BASKET, place: P(BASKET), units: 1, free: 0, d: 2 }],
      },
      { costSelection: true },
    );
    expect(intent).toEqual({ kind: "blocked" });
  });

  it("CONSERVATION: one apple, one place — the basket's stack pays for what the body gains", () => {
    // quest-host's take, mirrored on its accounting alone (take-first,
    // account-second): the unit is credited to the body and debited from the
    // container it came out of, whether that container is bolted down or not.
    const basketStock: Record<string, number> = { apple: 1 };
    const body: Record<string, number> = {};
    const before = basketStock.apple! + (body.apple ?? 0);
    if (basketStock.apple! > 0) {
      body.apple = (body.apple ?? 0) + 1;
      basketStock.apple! -= 1;
    }
    expect(basketStock.apple).toBe(0);
    expect(body.apple).toBe(1);
    expect(basketStock.apple! + body.apple!).toBe(before);
  });

  it("A CONTAINER IS A SOURCE, NOT A PICKUP — quest-host's `asContainerSource`, mirrored", () => {
    // The arm that had to change: `small:` ids used to mean "a loose prop to
    // lift", full stop, so a step naming the basket would have picked the
    // BASKET up. The OBJECT decides, and it decides unambiguously — a basket is
    // not food and affords no play.
    const asContainerSource = (
      registered: boolean,
      glyph: string,
      step: { goodKey: string; affords?: string },
    ): boolean => {
      if (!registered) return false;
      if (step.affords) return !(glyph === "teddy"); // matchesNeedItem(glyph, {affords})
      if (step.goodKey) return !["apple", "banana", "shirt"].includes(glyph); // carryKindsOf
      return false; // an UNTYPED row (tidy/relieve) means the object itself
    };
    expect(asContainerSource(true, "basket", { goodKey: "food" })).toBe(true); // draw from it
    expect(asContainerSource(true, "basket", { goodKey: "" })).toBe(false); // relieve: lift IT
    expect(asContainerSource(true, "basket", { goodKey: "", affords: "play" })).toBe(true);
    expect(asContainerSource(true, "apple", { goodKey: "food" })).toBe(false); // an apple is the unit
    expect(asContainerSource(false, "basket", { goodKey: "food" })).toBe(false); // never registered
  });

  // 🔁 THE RESIDUAL IS RESOLVED — THIS PIN IS FLIPPED (2026-08-03).
  //
  // What stood here until today, verbatim: "⚠️ THE RESIDUAL, PINNED: hunger
  // cannot reach it — the row has no floor branch … a hungry body still walks
  // past the basket. Giving hunger a `storage` branch is a TEMPLATE decision
  // with its own hazards (that role enumerates the house's furniture too, which
  // is how the pet's bowl and a housemate's private box would join a food row's
  // source walk), and it changes selection in BOTH flag paths — so it is named
  // here rather than smuggled in."
  //
  // It was named because it was the USER'S to decide, and on 2026-08-03 the
  // user decided it, verbatim: "It shouldn't be invisible to them, but they
  // should have a reduced tendency to use them. For now, a constant reduction
  // in priority will do; we'll expand on this once we get into more detailed
  // private property and personality rules."
  //
  // So the branches landed and the hazards the pin named are answered by
  // `PROPRIETY_PENALTY_S` (priced) and by BRANCH ORDER (unpriced) — pinned in
  // full in `propriety-penalty.test.ts`. All that is left here is the other
  // side of the same assertion: the hungry body no longer walks past.
  it("🔁 FLIPPED (user decision 2026-08-03): hunger REACHES it — the basket is a last resort, not a blank", () => {
    const hungry = hungerTemplate("food", 1 / NEED_FILL_S.hunger);
    expect(hungry.acquire.some((a) => a.kind === "loose")).toBe(true);
    expect(hungry.acquire.some((a) => a.kind === "container" && a.role === "storage")).toBe(true);
    // …and LAST, which is the whole of the direction on the unpriced path.
    expect(hungry.acquire.map((a) => (a.kind === "container" ? `container:${a.role}` : a.kind))).toEqual([
      "container:home",
      "source",
      "container:storage",
      "loose",
    ]);
    // Nothing else in the world; the basket is reached, penalty and all —
    // "reduced tendency", never invisible.
    expect(
      decideNeed(
        hungry,
        {
          meter: 1,
          carried: 0,
          room: 1,
          containers: {},
          sources: [],
          stations: [],
          loose: [{ id: BASKET, place: P(BASKET), units: 1, free: 1, d: 2, improper: true }],
        },
        { costSelection: true },
      ),
    ).toMatchObject({ kind: "take", from: { id: BASKET }, units: 1 });
  });
});
