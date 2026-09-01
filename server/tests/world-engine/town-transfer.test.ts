// THE TRANSFER PRIMITIVE (city-expansion phase ②), at the pure layer — the
// exact pieces quest-host wires: ONE scope-agnostic agreement between two
// STOCK ENDPOINTS, executed by a haul. Pins: endpoints are VIEWS over the
// real stack maps (container stacks, TownDeltas.stock, a founded site's
// crate, pockets — mutate through the endpoint, observe in the original
// store, NEVER a shadow copy); the agreement ledger is a serializable
// mutation layer (TownDeltas pattern — toJSON round-trip, no RNG,
// deterministic given the clock); house↔house transfer runs end to end over
// the ①a task pool with an announced intent; a yard deposit funds a build
// order; refusals are honest and named ("we don't have 3 wood", "it's not
// ours"); the shipped dawn-cart/caravan flows are EXPRESSIBLE as standing
// agreements (the bridge — bindPartner keeps working). No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  createTransferLedger,
  dawnCartAgreementInput,
  depotEndpointId,
  orderQuantity,
  planTransferSources,
  putStock,
  rankPricedSources,
  runDueTransfers,
  stackUnits,
  takeGoods,
  takeStock,
  townEndpointId,
  tradeRouteAgreementInputs,
  transferStock,
  type StockEndpoint,
  type TransferSource,
} from "@shared/world-engine/kernel/town/transfer.js";
import { createTownDeltas } from "@shared/world-engine/kernel/town/construction.js";
import {
  costsMet,
  resolveStructure,
  spendCostsChain,
  structureCosts,
} from "@shared/world-engine/kernel/town/structures.js";
import { BLOCK_GLYPH, withRefinableCredit } from "@shared/world-engine/products.js";
import { foundSite } from "@shared/world-engine/interaction/town/founding.js";
import { TOWN_PLAY_STRUCTURES } from "@shared/world-engine/interaction/town/town-play.js";
import { FOOD_DAY_SEC } from "@shared/world-engine/kernel/town/goods.js";
import type { TradeRoute } from "@shared/world-engine/kernel/town/trade.js";
import { rarePerVisit, RARE_IMPORT_KIND, TRADE_IMPORT_KINDS } from "@shared/world-engine/kernel/town/trade.js";
import { chooseClaimant, createTaskPool, type TaskCandidate } from "@shared/world-engine/interaction/behavior/task-pool.js";
import { goalIntentLine, type IntentLineSyms } from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import { compileGoal, type WorldResolver } from "@shared/world-engine/interaction/behavior/goal-selection.js";
import { houseScope, mayUse } from "@shared/world-engine/interaction/behavior/ownership.js";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { compileIntent, defaultBinder } from "@shared/world-engine/interaction/intent/intent-compile.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";

const ep = (id: string, stack: Record<string, number>, over?: Partial<StockEndpoint>): StockEndpoint => ({
  id,
  kind: "container",
  at: { x: 0, y: 0 },
  stack,
  ...over,
});

const syms: IntentLineSyms = {
  item: (ref) => ("id" in ref ? ref.id : ref.match.kind ?? "thing"),
  place: (p) => (p.kind === "named" ? p.id : "there"),
  creature: (id) => id,
};

// ── 1. ENDPOINTS are views over the REAL stack maps — no shadow copies ─────

describe("stock endpoints — one view over every holder kind", () => {
  it("a container stack map: takes/puts through the endpoint land in the original map", () => {
    const containerStock = new Map<string, Record<string, number>>();
    containerStock.set("furn_3_chest_food", { apple: 2, banana: 1 });
    const view = ep("furn_3_chest_food", containerStock.get("furn_3_chest_food")!);
    const taken = takeStock(view.stack, "apple", 1);
    expect(taken).toEqual({ apple: 1 });
    expect(containerStock.get("furn_3_chest_food")).toEqual({ apple: 1, banana: 1 });
    putStock(view, { grape: 2 });
    expect(containerStock.get("furn_3_chest_food")).toEqual({ apple: 1, banana: 1, grape: 2 });
  });

  it("the town builder's yard (TownDeltas.stock): endpoint puts fund the SERIALIZED stock", () => {
    const deltas = createTownDeltas();
    const yard = ep("town:yard", deltas.stock, { kind: "yard" });
    putStock(yard, { wood: 6, stone: 2 });
    expect(deltas.stock).toEqual({ wood: 6, stone: 2 });
    expect(deltas.toJSON().stock).toEqual({ wood: 6, stone: 2 }); // rides the deltas
    takeStock(yard.stack, "wood", 2);
    expect(deltas.stock.wood).toBe(4);
  });

  it("a founded site's crate (site.stock) and a pocket: the same shape, the same aliasing", () => {
    const site = foundSite({ seed: 7, at: { x: 10, y: 10 } });
    const crate = ep("site:stock", site.stock, { kind: "site" });
    putStock(crate, { stone: 3 });
    expect(site.stock.stone).toBe(3);

    const pocket: Record<string, number> = { wood: 5 };
    const hands = ep("pocket:__player__", pocket, { kind: "pocket" });
    const moved = transferStock(hands, crate, { wood: 4 });
    expect(moved.moved).toEqual({ wood: 4 });
    expect(pocket).toEqual({ wood: 1 }); // the original map drained
    expect(site.stock).toEqual({ stone: 3, wood: 4 }); // the original map filled
  });

  it("facted stack variants count toward and pay toward their HEAD (wood.wet is wood)", () => {
    const stack = { "wood.wet": 2, wood: 1 };
    expect(stackUnits(stack, "wood")).toBe(3);
    const taken = takeStock(stack, "wood", 2);
    expect(taken).toEqual({ wood: 1, "wood.wet": 1 }); // plain stack first
    expect(stack).toEqual({ "wood.wet": 1 });
  });

  it("capacity refuses honestly and conservation holds — nothing vanishes", () => {
    const from = ep("a", { wood: 5 });
    const to = ep("b", { wood: 14 }, { capacity: 15 });
    const { moved, missing } = transferStock(from, to, { wood: 5 });
    expect(moved).toEqual({ wood: 1 }); // room for exactly one
    expect(missing).toEqual({ wood: 4 });
    expect(from.stack.wood).toBe(4); // refused units RETURNED to the source
    expect(to.stack.wood).toBe(15);
    expect(from.stack.wood + to.stack.wood).toBe(19); // conserved
  });
});

// ── 2. AGREEMENTS — the serializable mutation layer ────────────────────────

describe("transfer agreements — lifecycle, serialization, determinism", () => {
  it("post → begin → load → complete, with the executor tracked (one haul per body)", () => {
    const ledger = createTransferLedger();
    const a = ledger.post({
      from: "furn_1_chest_food", to: "furn_2_chest_food",
      goods: { apple: 2 }, issuer: "__player__", mode: "haul", now: 5,
      sourceGlyph: "bring + apple + to + house",
    });
    expect(a.status).toBe("pending");
    expect(ledger.begin(a.id, "resident_1_0")).toBe(true);
    expect(ledger.begin(a.id, "resident_1_1")).toBe(false); // already moving
    expect(ledger.executing("resident_1_0")?.id).toBe(a.id);
    ledger.load(a.id, { apple: 2 });
    expect(ledger.get(a.id)?.carried).toEqual({ apple: 2 });
    ledger.complete(a.id);
    expect(ledger.get(a.id)).toMatchObject({ status: "done" });
    expect(ledger.get(a.id)?.carried).toBeUndefined();
  });

  it("failure is NAMED — never a silent rot", () => {
    const ledger = createTransferLedger();
    const a = ledger.post({ from: "x", to: "y", goods: { wood: 1 }, issuer: "i", mode: "haul", now: 0 });
    ledger.begin(a.id, "c");
    ledger.fail(a.id, "missing");
    expect(ledger.get(a.id)).toMatchObject({ status: "failed", failReason: "missing" });
  });

  it("toJSON round-trips the ledger (TownDeltas pattern) and serials never reuse", () => {
    const ledger = createTransferLedger();
    const a = ledger.post({ from: "x", to: "y", goods: { wood: 2 }, issuer: "i", mode: "haul", now: 0 });
    ledger.begin(a.id, "c");
    ledger.load(a.id, { wood: 2 });
    ledger.post({ from: "p", to: "q", goods: { stone: 1 }, issuer: "j", mode: "scheduled", every: 10, now: 3 });
    const revived = createTransferLedger(ledger.toJSON());
    expect(revived.toJSON()).toEqual(ledger.toJSON());
    expect(revived.executing("c")?.carried).toEqual({ wood: 2 }); // a reload never loses a load
    expect(revived.post({ from: "a", to: "b", goods: {}, issuer: "k", mode: "haul", now: 4 }).id).toBe("agr_2");
    // The snapshot is a copy, not a live alias.
    const snap = ledger.toJSON();
    ledger.complete(a.id);
    expect(snap.agreements.find((r) => r.id === a.id)?.status).toBe("moving");
  });

  it("source planning is pure + deterministic: nearest first, ties to the lower id, shortfall reported", () => {
    const sources: TransferSource[] = [
      { id: "chest_b", stack: { wood: 2 }, d: 4 },
      { id: "chest_a", stack: { wood: 2 }, d: 4 }, // tie — id wins
      { id: "chest_c", stack: { wood: 9 }, d: 9 },
    ];
    const plan = planTransferSources(sources, "wood", 5);
    expect(plan.draws).toEqual([
      { id: "chest_a", take: 2 },
      { id: "chest_b", take: 2 },
      { id: "chest_c", take: 1 },
    ]);
    expect(plan.shortfall).toBe(0);
    for (let i = 0; i < 20; i++) expect(planTransferSources(sources, "wood", 5)).toEqual(plan);
    expect(planTransferSources(sources, "wood", 20).shortfall).toBe(7); // "we don't have 20 wood"
  });

  it("orderQuantity maps the spoken quantity words", () => {
    expect(orderQuantity()).toBe(1);
    expect(orderQuantity("three")).toBe(3);
    expect(orderQuantity("all")).toBe(Infinity);
  });

  // ── S&D S3 H2 — `rankKey`: policy priority ahead of cost (transfer.ts)
  it("rankKey (absent) is byte-identical to the pre-S3 walk", () => {
    const sources: TransferSource[] = [
      { id: "chest_b", stack: { wood: 2 }, d: 4 },
      { id: "chest_a", stack: { wood: 2 }, d: 4 },
      { id: "chest_c", stack: { wood: 9 }, d: 9 },
    ];
    expect(rankPricedSources(sources, (s) => stackUnits(s.stack, "wood")))
      .toEqual([sources[1], sources[0], sources[2]]); // chest_a, chest_b, chest_c
  });

  it("rankKey ranks BEFORE cost — a lower key wins even against a nearer source", () => {
    const near: TransferSource = { id: "near", stack: { wood: 5 }, d: 1 };
    const far: TransferSource = { id: "far", stack: { wood: 5 }, d: 500 };
    const ranked = rankPricedSources(
      [near, far], (s) => stackUnits(s.stack, "wood"),
      { rankKey: (s) => (s.id === "far" ? -1 : 0) }, // "far" is policy-preferred
    );
    expect(ranked).toEqual([far, near]);
  });

  it("equal (including every-source-absent) rankKey falls through to cost then id, unchanged", () => {
    const a: TransferSource = { id: "a", stack: { wood: 5 }, d: 10 };
    const b: TransferSource = { id: "b", stack: { wood: 5 }, d: 5 };
    const ranked = rankPricedSources(
      [a, b], (s) => stackUnits(s.stack, "wood"),
      { rankKey: () => 0 }, // every source ties
    );
    expect(ranked).toEqual([b, a]); // b is nearer — cost still decides
  });
});

// ── 3. HOUSE↔HOUSE end to end, over the ①a task pool ───────────────────────

describe("house↔house transfer — order → agreement → pooled task → claim → announce → haul → done", () => {
  it("moves stock between the two houses' REAL chests", () => {
    // The two households' boxes, exactly as containerStock holds them.
    const containerStock = new Map<string, Record<string, number>>();
    containerStock.set("furn_1_chest_food", { apple: 3 });
    containerStock.set("furn_2_chest_food", { banana: 1 });

    // ── ORDER: "bring two apple to house" — quantity + a house endpoint.
    const qty = orderQuantity("two");
    const plan = planTransferSources(
      [{ id: "furn_1_chest_food", stack: containerStock.get("furn_1_chest_food")!, d: 3 }],
      "apple",
      qty,
    );
    expect(plan.shortfall).toBe(0);

    // ── AGREEMENT + pooled TASK (untargeted → anyone appropriate).
    const ledger = createTransferLedger();
    const a = ledger.post({
      from: "furn_1_chest_food", to: "furn_2_chest_food",
      goods: { apple: plan.draws[0]!.take }, issuer: "__player__", mode: "haul", now: 0,
      sourceGlyph: "bring + two + apple + to + house",
    });
    const goal: GoalSpec = { kind: "transfer", agreementId: a.id, goods: a.goods, to: { kind: "named", id: "house" } };
    const pool = createTaskPool();
    const task = pool.post({ goal, issuer: "__player__", focus: { x: 0, y: 0, radius: 26 }, now: 0 });

    // Transfer capability is HOST-checked (endpoints + stock), never a
    // compileGoal body errand — the build handoff pattern.
    const nullResolver: WorldResolver = {
      positionOf: () => null, homeOf: () => null, place: () => null,
      resolveItem: () => null, itemPosition: () => null, stationFor: () => null,
    };
    expect(compileGoal(goal, "resident_2_0", nullResolver)).toBeNull();

    // ── CLAIM: deterministic (nearest, ties by id).
    const cands: TaskCandidate[] = [
      { id: "resident_2_0", pos: { x: 1, y: 0 }, capable: true, willing: true },
      { id: "resident_1_0", pos: { x: 6, y: 0 }, capable: true, willing: true },
    ];
    const winner = chooseClaimant(task, cands)!;
    expect(winner).toBe("resident_2_0");
    expect(pool.claim(task.id, winner)).toBe(true);
    expect(ledger.begin(a.id, winner)).toBe(true);

    // ── ANNOUNCE: the intent line names the goods and the destination.
    const line = goalIntentLine(goal, syms)!;
    expect(line.c).toContain("apple");
    expect(line.c).toContain("house");

    // ── HAUL: load at the source, unload at the destination — through the
    // SAME maps the session holds (observe the originals).
    const from = ep(a.from, containerStock.get(a.from)!);
    const to = ep(a.to, containerStock.get(a.to)!);
    const carried = takeGoods(from.stack, a.goods);
    ledger.load(a.id, carried);
    expect(containerStock.get("furn_1_chest_food")).toEqual({ apple: 1 }); // visibly left
    putStock(to, carried);
    ledger.complete(a.id);
    expect(containerStock.get("furn_2_chest_food")).toEqual({ banana: 1, apple: 2 }); // visibly arrived
    expect(ledger.get(a.id)?.status).toBe("done");

    // The pooled task retires off the LEDGER's status (host sweep contract).
    pool.complete(task.id);
    expect(pool.claimed()).toHaveLength(0);
  });
});

// ── 4. YARD DEPOSIT funds a BUILD ORDER (the ①b gap) ───────────────────────

describe("yard deposit → a build order can spend it", () => {
  it("wood hauled into deltas.stock makes costsMet flip and spendCosts succeed", () => {
    const deltas = createTownDeltas();
    const spec = resolveStructure(TOWN_PLAY_STRUCTURES, "house")!;
    expect(costsMet(spec, deltas.stock)).toBe(false); // nothing in the yard yet

    // The player's pocket → the yard crate (whose stack IS deltas.stock).
    // Sized off the house's OWN bill (phase 6 — derived from its footprint),
    // so "enough wood for a house, and two left over" stays true whatever the
    // bay knobs are tuned to.
    const HOUSE_WOOD = structureCosts(spec)[BLOCK_GLYPH]! * 2;
    const pocket: Record<string, number> = { wood: HOUSE_WOOD + 4 };
    const hands = ep("pocket:__player__", pocket, { kind: "pocket" });
    const yard = ep("town:yard", deltas.stock, { kind: "yard" });
    const ledger = createTransferLedger();
    const a = ledger.post({
      from: hands.id, to: yard.id, goods: { wood: HOUSE_WOOD + 2 },
      issuer: "__player__", mode: "haul", now: 0, sourceGlyph: "put + wood + in + yard",
    });
    ledger.begin(a.id, "resident_0_1");
    const carried = takeGoods(hands.stack, a.goods);
    ledger.load(a.id, carried);
    putStock(yard, carried);
    ledger.complete(a.id);

    expect(pocket.wood).toBe(2);
    expect(deltas.stock.wood).toBe(HOUSE_WOOD + 2);
    // Phase 3: the bill is BLOCKS — raw wood affords it at the 2:1 milled
    // value (chain-aware), and the chain spend mills implicitly.
    expect(costsMet(spec, withRefinableCredit(deltas.stock))).toBe(true);
    expect(spendCostsChain(spec, deltas.stock)).toBe(true);
    expect(deltas.stock.wood ?? 0).toBe(2);
  });
});

// ── 5. REFUSAL MATRIX — honest, named, deterministic ───────────────────────

describe("refusals", () => {
  it('shortfall: "we don\'t have 3 wood" — the plan reports exactly how short', () => {
    const plan = planTransferSources([{ id: "crate", stack: { wood: 1 }, d: 0 }], "wood", 3);
    expect(plan.shortfall).toBe(2);
    expect(plan.draws).toEqual([{ id: "crate", take: 1 }]);
  });

  it('"it\'s not ours": another house\'s communal store never enters the source set', () => {
    // ownership.ts is the gate the host filters with: the player (house 1)
    // may use its own house tier and the town tier, never house 2's.
    expect(mayUse("__player__", 1, houseScope(1))).toBe(true);
    expect(mayUse("__player__", 1, houseScope(2))).toBe(false);
    expect(mayUse("__player__", 1, "town")).toBe(true);
    // With the foreign chest filtered out, the order over "wood" is a
    // NAMED refusal: zero available + foreign stock exists.
    const foreign = { id: "furn_2_cupboard", stack: { wood: 4 }, owner: houseScope(2) };
    const usable = [foreign].filter((s) => mayUse("__player__", 1, s.owner));
    expect(usable).toHaveLength(0);
    const plan = planTransferSources(usable, "wood", 1);
    expect(plan.shortfall).toBe(1); // nothing OURS holds it — "it's not ours"
  });

  it("a source emptied during the walk fails the haul as 'missing' — aloud, not silently", () => {
    const ledger = createTransferLedger();
    const stack: Record<string, number> = { wood: 1 };
    const a = ledger.post({ from: "crate", to: "yard", goods: { wood: 1 }, issuer: "p", mode: "haul", now: 0 });
    ledger.begin(a.id, "c");
    stack.wood = 0; // raided mid-walk
    delete stack.wood;
    const taken = takeGoods(stack, a.goods);
    expect(Object.keys(taken)).toHaveLength(0);
    ledger.fail(a.id, "missing");
    expect(ledger.get(a.id)).toMatchObject({ status: "failed", failReason: "missing" });
  });
});

// ── 6. STANDING agreements + the shipped-flow bridges ──────────────────────

describe("standing agreements — scheduled abstract legs (market restock shape)", () => {
  it("runDueTransfers executes due legs over live endpoints and advances the clock", () => {
    const shelf: Record<string, number> = {};
    const pile: Record<string, number> = { food: 9 };
    const endpoints = new Map<string, StockEndpoint>([
      ["produce:food:0", ep("produce:food:0", pile)],
      ["store:food:0", ep("store:food:0", shelf)],
    ]);
    const ledger = createTransferLedger();
    ledger.post(dawnCartAgreementInput({ goodKey: "food", producerWork: 0, sourceIdx: 0, dailyUnits: 4 }));
    // Not due before its first dawn.
    expect(runDueTransfers(ledger, (id) => endpoints.get(id) ?? null, 1)).toHaveLength(0);
    // The dawn leg runs: pile → shelf, exactly the daily units.
    const r1 = runDueTransfers(ledger, (id) => endpoints.get(id) ?? null, FOOD_DAY_SEC);
    expect(r1).toHaveLength(1);
    expect(r1[0]!.moved).toEqual({ food: 4 });
    expect(shelf.food).toBe(4);
    expect(pile.food).toBe(5);
    // Same clock, second call: nothing due (advanced) — deterministic replay.
    expect(runDueTransfers(ledger, (id) => endpoints.get(id) ?? null, FOOD_DAY_SEC)).toHaveLength(0);
    // Next day, it runs again — a STANDING leg, the restock shape.
    const r2 = runDueTransfers(ledger, (id) => endpoints.get(id) ?? null, FOOD_DAY_SEC * 2);
    expect(r2[0]!.moved).toEqual({ food: 4 });
    expect(r2[0]!.missing).toEqual({});
  });

  it("an endpoint the resolver can't produce fails the agreement NAMED", () => {
    const ledger = createTransferLedger();
    const a = ledger.post({ from: "gone", to: "also-gone", goods: { wood: 1 }, issuer: "t", mode: "scheduled", every: 10, now: 0 });
    runDueTransfers(ledger, () => null, 10);
    expect(ledger.get(a.id)).toMatchObject({ status: "failed", failReason: "no-endpoint" });
  });
});

describe("intercity bridge — trade.ts route legs as standing agreements (bindPartner keeps working)", () => {
  const route = (partnerKey: string, distanceM: number): Pick<TradeRoute, "partnerKey" | "imports" | "exports" | "rare"> => ({
    partnerKey,
    imports: TRADE_IMPORT_KINDS,
    exports: ["food"],
    rare: { kind: RARE_IMPORT_KIND, perVisit: rarePerVisit(distanceM) },
  });

  it("expresses the two legs between town-scale endpoints, imports + rare cargo per visit", () => {
    const legs = tradeRouteAgreementInputs(route("away:21", 3000), "brookmill", { exportDaily: 12 });
    expect(legs).toHaveLength(2);
    const [imp, exp] = legs;
    expect(imp!.from).toBe(townEndpointId("away:21"));
    expect(imp!.to).toBe(depotEndpointId("brookmill"));
    expect(imp!.every).toBe(FOOD_DAY_SEC);
    expect(imp!.goods[RARE_IMPORT_KIND]).toBe(rarePerVisit(3000)); // far partner — scarce treat
    for (const k of TRADE_IMPORT_KINDS) expect(imp!.goods[k]).toBeGreaterThan(0);
    expect(exp!.from).toBe(depotEndpointId("brookmill"));
    expect(exp!.to).toBe(townEndpointId("away:21"));
    expect(exp!.goods.food).toBe(12);
  });

  // ── batch 2 · G2 — the export leg splits, and follows the books ──────────
  //
  // economy-arc-opening.md batch 2, G2. The import line above divides ONE
  // allotment across the kinds the route carries; the export line handed
  // EVERY export good the whole `exportDaily`, so the moment
  // `complementaryTrade` derived a second export good the row claimed twice
  // the town's daily surplus. Latent (no callers) — pinned now so the on-ramp
  // cannot land on it.

  it("🚨 ONE DAY'S SURPLUS IS ONE DAY'S SURPLUS, however many crates it packs into", () => {
    const two = { ...route("away:21", 3000), exports: ["food", "cloth"] };
    const exp = tradeRouteAgreementInputs(two, "brookmill", { exportDaily: 12 })[1]!;
    expect(exp.goods).toEqual({ food: 6, cloth: 6 });
    expect(Object.values(exp.goods).reduce((a, b) => a + b, 0)).toBe(12);
    // A SINGLE export good is byte-identical to the shipped row (measured).
    expect(tradeRouteAgreementInputs(route("away:21", 3000), "brookmill", { exportDaily: 12 })[1]!
      .goods).toEqual({ food: 12 });
    // …and an empty export list still produces the leg, carrying nothing.
    const none = { ...route("away:21", 3000), exports: [] as string[] };
    expect(tradeRouteAgreementInputs(none, "brookmill", { exportDaily: 12 })[1]!.goods).toEqual({});
  });

  it("🔒 the export SCALE rides the same opts — absent ⇒ 1 ⇒ the shipped number", () => {
    const base = route("away:21", 3000);
    const plain = tradeRouteAgreementInputs(base, "brookmill", { exportDaily: 12 })[1]!;
    expect(tradeRouteAgreementInputs(base, "brookmill", { exportDaily: 12, exportScale: 1 })[1]!
      .goods).toEqual(plain.goods);
    // A town short of its own export good ships proportionally less…
    expect(tradeRouteAgreementInputs(base, "brookmill", { exportDaily: 12, exportScale: 0.5 })[1]!
      .goods).toEqual({ food: 6 });
    // …and nothing at all at the gate. Out-of-range readings are clamped.
    expect(tradeRouteAgreementInputs(base, "brookmill", { exportDaily: 12, exportScale: 0 })[1]!
      .goods).toEqual({ food: 0 });
    expect(tradeRouteAgreementInputs(base, "brookmill", { exportDaily: 12, exportScale: 4 })[1]!
      .goods).toEqual({ food: 12 });
    expect(tradeRouteAgreementInputs(base, "brookmill", { exportDaily: 12, exportScale: -1 })[1]!
      .goods).toEqual({ food: 0 });
  });

  it("re-derives after bindPartner — the partner endpoint follows the bound key and distance", () => {
    const before = tradeRouteAgreementInputs(route("away:21", 3000), "brookmill")[0]!;
    // bindPartner re-aims the route at a REAL near neighbor (trade.ts seam).
    const after = tradeRouteAgreementInputs(route("hamlet:east", 700), "brookmill")[0]!;
    expect(before.from).toBe("town:away:21");
    expect(after.from).toBe("town:hamlet:east");
    expect(after.goods[RARE_IMPORT_KIND]!).toBeGreaterThan(before.goods[RARE_IMPORT_KIND]!); // nearer carries more
  });
});

// ── 7. The SPOKEN surface — verbs, quantity, endpoint-shaped compiles ───────

describe("player surface — give/bring compile to transfers' shapes", () => {
  // A binder where "yard"/"house" are PLACES, never creatures (the host's
  // classify wrap): creature() refuses place nouns, place() resolves them.
  const placeAwareBinder = () => {
    const b = defaultBinder({ player: "__player__", listener: "resident_1_0" });
    const places = new Set(["yard", "house"]);
    const innerC = b.creature.bind(b);
    b.creature = (ref) => (ref?.kind === "entity" && places.has(ref.symbol) ? null : innerC(ref));
    return b;
  };

  it('"bring + wood + to + yard" compiles to a putIn at the yard (give\'s place fallback)', () => {
    const frame = parseSentence("bring + wood + to + yard");
    expect(frame.verb).toBe("bring");
    const compiled = compileIntent(frame, placeAwareBinder(), { id: "t" });
    expect(compiled.kind).toBe("goal");
    if (compiled.kind !== "goal") return;
    expect(compiled.goal).toMatchObject({
      kind: "putIn",
      item: { match: { kind: "wood" } },
      container: { kind: "named", id: "yard" },
    });
  });

  it('"give + three + apple + to + house" keeps the quantity on the frame for the transfer layer', () => {
    const frame = parseSentence("give + three + apple + to + house");
    expect(frame.quantity).toBe("three");
    expect(orderQuantity(frame.quantity)).toBe(3);
    const compiled = compileIntent(frame, placeAwareBinder(), { id: "t" });
    expect(compiled.kind).toBe("goal");
    if (compiled.kind !== "goal") return;
    expect(compiled.goal.kind).toBe("putIn"); // house = endpoint, not creature
  });

  it('"give + apple + to + mara" stays the shipped creature give (legacy path)', () => {
    const frame = parseSentence("give + apple + to + mara");
    const compiled = compileIntent(frame, placeAwareBinder(), { id: "t" });
    expect(compiled.kind).toBe("goal");
    if (compiled.kind !== "goal") return;
    expect(compiled.goal).toMatchObject({ kind: "give", to: "mara" });
  });

  it("the transfer intent line phrases goods + destination (announce surface)", () => {
    // phrase() caps level c at 3 CONTENT slots — the subject drops when a
    // tail complement would push past three (dialogue-gen law).
    //
    // CARRY, not PUT, for a place destination: the line is spoken at CLAIM
    // time, before the hauler has touched the goods, and a haul IS a carry
    // (and unlike `bring` it has board art). A creature recipient stays a give.
    const toYard: GoalSpec = { kind: "transfer", agreementId: "agr_0", goods: { wood: 3 }, to: { kind: "named", id: "yard" } };
    expect(goalIntentLine(toYard, syms)!.c).toBe("carry + wood + to + yard");
    const toMara: GoalSpec = { kind: "transfer", agreementId: "agr_1", goods: { apple: 2 }, to: { kind: "creature", id: "mara" } };
    expect(goalIntentLine(toMara, syms)!.c).toBe("give + apple + to + mara");
    // Level b keeps the VERB — a bare "apple + to + mara" reads as the
    // verbless on-behalf fragment, not as a delivery the speaker will make.
    expect(goalIntentLine(toMara, syms)!.b).toBe("give + apple + to + mara");
  });
});

// ── FIRST-ARRIVAL EVIDENCE (resource-access round Stage 3, 2026-09-01) ──────
// The durable flow memory the user's seed-availability ruling derives from:
// "a place may plant a species only once the good has landed there —
// derivable from flow memory, NEVER a new list". It joins the ledger's OWN
// serialized record family (a sibling array beside `agreements`, which is the
// one durable per-good record the town already kept forever) and it is
// EDGE-TRIGGERED on the state books' "trade-open" precedent: the opening is
// recorded once, the rate is never accumulated. These pins are the bound.
describe("first-arrival evidence — the edge, and only the edge", () => {
  it("appends on the first landing and never again — the good is the key, the lane is colour", () => {
    const led = createTransferLedger();
    expect(led.everArrived("apple")).toBe(false);
    expect(led.noteArrival("apple", "caravan", 3)).toBe(true);
    expect(led.arrivals()).toEqual([{ kind: "first-arrival", good: "apple", via: "caravan", day: 3 }]);
    expect(led.everArrived("apple")).toBe(true);
    // The SAME good again — same lane, other lane, later day: no second row.
    expect(led.noteArrival("apple", "caravan", 4)).toBe(false);
    expect(led.noteArrival("apple", "barter", 90)).toBe(false);
    expect(led.arrivals()).toHaveLength(1);
    // A DIFFERENT good opens its own row, in landing order.
    expect(led.noteArrival("cookie", "barter", 5)).toBe(true);
    expect(led.arrivals().map((r) => r.good)).toEqual(["apple", "cookie"]);
  });

  it("is BOUNDED — N landings of one good are one row (the ledger cannot grow with traffic)", () => {
    const led = createTransferLedger();
    for (let day = 0; day < 500; day++) led.noteArrival("banana", day % 2 ? "caravan" : "barter", day);
    expect(led.arrivals()).toHaveLength(1);
    expect(led.arrivals()[0]).toEqual({ kind: "first-arrival", good: "banana", via: "barter", day: 0 });
  });

  it("head-matches like every other stack read — a facted variant is still the good", () => {
    const led = createTransferLedger();
    expect(led.noteArrival("wood.wet", "caravan", 1)).toBe(true);
    expect(led.arrivals()[0]!.good).toBe("wood"); // the HEAD is what is recorded
    expect(led.everArrived("wood")).toBe(true);
    expect(led.noteArrival("wood", "barter", 2)).toBe(false);
  });

  it("round-trips through the ledger's own serialize/restore, and stays deduped after", () => {
    const led = createTransferLedger();
    led.noteArrival("apple", "caravan", 3);
    led.noteArrival("cookie", "barter", 5);
    const json = JSON.parse(JSON.stringify(led.toJSON())) as ReturnType<typeof led.toJSON>;
    const back = createTransferLedger(json);
    expect(back.arrivals()).toEqual(led.arrivals());
    expect(back.everArrived("apple")).toBe(true);
    expect(back.noteArrival("apple", "barter", 40)).toBe(false); // the edge stays spent
    expect(back.toJSON()).toEqual(led.toJSON());
    // Deep-copied on load: the restored rows are not the JSON's rows.
    expect(back.arrivals()[0]).not.toBe(json.arrivals![0]);
  });

  it("a ledger nothing ever landed in emits NO `arrivals` key — every older save is byte-identical", () => {
    const led = createTransferLedger();
    expect(led.arrivals()).toEqual([]);
    expect(Object.keys(led.toJSON())).toEqual(["serial", "agreements"]);
    expect("arrivals" in led.toJSON()).toBe(false);
    // …and the agreement views never see an arrival row: they are siblings.
    led.noteArrival("apple", "caravan", 1);
    expect(led.all()).toEqual([]);
    expect(led.active()).toEqual([]);
    expect(led.due(1e9)).toEqual([]);
  });
});
