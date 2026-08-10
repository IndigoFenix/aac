// THE IMPORT CHANNEL (economy-arc-opening.md batch 1, T3 + T4)
//
// The law this file is the test of (user, 2026-08-09): *household shopping =
// shop stocking = city/country imports — ONE mechanism.* Before it, a barter
// landed goods in the town YARD and stopped there: no household could shop an
// import, and `townShortage` never moved however many caravans arrived, so the
// whole trade tier was decoration. Two halves:
//
//  T3a THE WHERE — `createTownGoods` takes an optional import reader and
//      APPENDS (never inserts — `srcIdx` is a persistence key) a DEPOT source
//      whose shelf is the lane's own allotment on the CARAVAN's day. It is
//      excluded from everything that means "a stall a local producer supplies":
//      the served counts `produceAt` splits the town's draw by, `stallDaily`,
//      and the dawn `haul` (and so the street wear it would have worn).
//  T3b THE WHETHER — a landing CREDITS the good's drift stockpile (the
//      `creditDelivery` join), `driftFeeds` makes that stockpile relief, and
//      because `TownWorld.step` runs only in the boot fast-forward the relief
//      is ALSO read live (`townShortage`'s feed term) and banked durably
//      (`TownDeltas.driftBank`, re-injected at boot).
//
// The live case is shipped content, not a fixture: a town-play town at **day
// 15** has farms, a market and a WEAVER but no TAILOR yet — it makes cloth and
// cannot turn it into clothing. That is the unlicensed-refinery town verbatim,
// and its `clothing_got` is 0 against a real need, i.e. a shortage of 1.0.
//
// Pure logic + ONE headless boot — no DOM / GL / DB.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import { buildTownPlay, type TownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import {
  createTownGoods,
  FOOD_DAY_SEC,
  type GoodSource,
  type ImportDepotReading,
} from "@shared/world-engine/kernel/town/goods.js";
import { goodSourceEndpointId } from "@shared/world-engine/kernel/town/transfer.js";
import {
  allotmentSplit,
  createTownTrade,
  IMPORT_ALLOTMENT,
  RARE_IMPORT_KIND,
  TRADE_IMPORT_KINDS,
} from "@shared/world-engine/kernel/town/trade.js";
import { exportSpareScale } from "@shared/world-engine/kernel/town/complementary.js";
import { bookUnitsPerStreetUnit } from "@shared/world-engine/interaction/town/town-quests.js";
import { BARTER_WANT_MIN, stubPartnerSignals } from "@shared/world-engine/kernel/town/barter.js";
import { activeTradePairs } from "@shared/world-engine/kernel/town/money.js";
import { hinterlandJobs, cityLicense } from "@shared/world-engine/kernel/civ/jobs.js";
import { parasiteReading, type CeilingReading } from "@shared/world-engine/kernel/cells/ceilings.js";

const SEED = 12;
/** The age at which this content has a weaver and NO tailor (probed, and
 *  pinned below as the premise of every live case here). */
const YOUNG_DAYS = 15;

// ─────────────────────────────────────────────────────────────────────────
// ① T3a — THE DEPOT AS AN APPENDED SOURCE (pure, on a real town's geometry)
// ─────────────────────────────────────────────────────────────────────────

describe("T3a — the import depot is APPENDED, and is not a stall", () => {
  let play: TownPlay;
  /** A reader for FOOD — a good the live wiring deliberately refuses (the
   *  granary declares no `driftFeeds`), so this half controls every input. */
  const readerAt = (at: { x: number; y: number }, dailyUnits: number, phase = 0) =>
    (goodKey: string): ImportDepotReading | null =>
      goodKey === "food" ? { at, dailyUnits, dayFrac: () => phase } : null;

  const foodSpec = () => play.eco.goods.find((g) => g.key === "food")!;
  const townArgs = () => ({
    key: "milltown",
    center: { x: play.plan.radius + 40, y: play.plan.radius + 40 },
    plan: play.plan,
  });
  const build = (imports?: ReturnType<typeof readerAt>) =>
    createTownGoods(play.town, play.eco, townArgs(), SEED, foodSpec(), undefined, imports);

  beforeAll(() => {
    play = buildTownPlay({ seed: SEED, days: YOUNG_DAYS });
  });

  it("🔒 NO READER ⇒ the source list is exactly what it was", () => {
    const plain = build();
    const nulled = build(() => null);
    expect(nulled.sources).toEqual(plain.sources);
    expect(plain.sources.some((s: GoodSource) => s.depot)).toBe(false);
  });

  it("🚨 appends at the END — `srcIdx` is a persistence key, never a slot to insert into", () => {
    const plain = build();
    const withDepot = build(readerAt({ x: 10, y: 20 }, 4));
    // Every pre-existing source keeps its index, byte for byte…
    expect(withDepot.sources.slice(0, plain.sources.length)).toEqual(plain.sources);
    // …and exactly one new row lands after them.
    expect(withDepot.sources.length).toBe(plain.sources.length + 1);
    const last = withDepot.sources[withDepot.sources.length - 1]!;
    expect(last.depot).toBe(true);
    expect({ x: last.x, y: last.y }).toEqual({ x: 10, y: 20 });
    // …so the ledger spelling of every OLD shelf is untouched, and the new one
    // is the ordinary `store:<good>:<lastIdx>` with zero rule change.
    for (let i = 0; i < plain.sources.length; i++) {
      expect(goodSourceEndpointId(withDepot, i)).toBe(goodSourceEndpointId(plain, i));
    }
    expect(goodSourceEndpointId(withDepot, withDepot.sources.length - 1)).toBe(
      `store:food:${withDepot.sources.length - 1}`,
    );
  });

  it("🔒 its shelf is the LANE's allotment on the CARAVAN's day — the same closed form a stall runs", () => {
    const dawn = build(readerAt({ x: 10, y: 20 }, 4, 0));
    const dusk = build(readerAt({ x: 10, y: 20 }, 4, 0.99));
    const depotOf = (g: ReturnType<typeof build>) => g.sources[g.sources.length - 1]!;
    // A little over the day's allotment when the caravan lands…
    expect(dawn.stockOf(depotOf(dawn), 0)).toBeCloseTo(4 * 1.15, 9);
    // …drawn down across the visit, and never negative.
    expect(dusk.stockOf(depotOf(dusk), 0)).toBeCloseTo(4 * (1.15 - 0.95 * 0.99), 9);
    expect(dusk.stockOf(depotOf(dusk), 0)).toBeGreaterThan(0);
    // The lane carrying NONE of it is an EMPTY shelf, not an absent one.
    const dry = build(readerAt({ x: 10, y: 20 }, 0));
    expect(dry.stockOf(depotOf(dry), 0)).toBe(0);
    expect(goodSourceEndpointId(dry, dry.sources.length - 1)).not.toBeNull();
  });

  it("🚨 is excluded from everything that means 'a stall a producer supplies'", () => {
    const plain = build();
    const withDepot = build(readerAt({ x: 10, y: 20 }, 4));
    const depot = withDepot.sources[withDepot.sources.length - 1]!;
    // Not a market shelf: no dawn-cart volume…
    expect(withDepot.stallDaily(depot)).toBe(0);
    // …and no dawn cart (a phantom carrier out of the nearest farm, plus the
    // street wear it would have laid down every morning).
    expect(withDepot.haul(depot, 0)).toBeNull();
    // Its households are NOT part of the draw the town's producers split, so
    // no farm pile inflates because a caravan feeds the plaza.
    expect(withDepot.marketServed()).toBe(plain.marketServed());
    for (const w of plain.producerWorks()) {
      expect(withDepot.produceAt(w, 137)).toBeCloseTo(plain.produceAt(w, 137), 9);
    }
    // And one stand, at the crate — never a row of market tables.
    expect(withDepot.stands(depot)).toEqual([{ x: 10, y: 20 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ② T3 — THE LANE'S CARGO IS RE-DERIVED, not frozen on bind day (pure)
// ─────────────────────────────────────────────────────────────────────────

describe("T3 — the cargo list is a READING, and the bind is only when it starts", () => {
  let play: TownPlay;
  const center = () => ({ x: play.plan.radius + 40, y: play.plan.radius + 40 });
  const line = () =>
    createTownTrade(center(), play.plan, play.plan.streets, SEED, {
      exportGood: "food",
      exportDaily: 10,
    })!;
  /** Books that read `spare` for everything listed, `1` for everything else. */
  const books = (spare: readonly string[]) => ({
    shortage: (g: string) => (spare.includes(g) ? 0 : 1),
  });

  beforeAll(() => {
    play = buildTownPlay({ seed: SEED, days: YOUNG_DAYS });
  });

  it("splits the visit allotment across whatever the line actually carries — ONE definition", () => {
    const tr = line();
    const per = Math.floor(IMPORT_ALLOTMENT / TRADE_IMPORT_KINDS.length);
    for (const k of TRADE_IMPORT_KINDS) expect(tr.importUnitsPerVisit(k)).toBe(per);
    expect(tr.importUnitsPerVisit("clothing")).toBe(0); // not on this line
    // The rare treat rides BESIDE the allotment, on its own distance count.
    expect(tr.importUnitsPerVisit(RARE_IMPORT_KIND)).toBe(tr.route.rare.perVisit);
  });

  it("🔒 an UNBOUND line has nobody to read: refreshCargo is a no-op", () => {
    const tr = line();
    tr.refreshCargo({ us: books([]), them: books(["clothing"]), goods: ["food", "clothing"] });
    expect(tr.route.imports).toEqual(TRADE_IMPORT_KINDS);
  });

  it("🚨 a BOUND line re-derives as the books move — the one-shot bind does not freeze the cargo", () => {
    const tr = line();
    const c = center();
    tr.bindPartner({ key: "hamlet", at: { x: c.x + 600, y: c.y }, distanceM: 600 });
    // Spring: they have clothing spare, we are short of it.
    tr.refreshCargo({
      us: books(["food"]),
      them: books(["clothing"]),
      goods: ["food", "clothing"],
    });
    expect([...tr.route.imports]).toEqual(["clothing"]);
    expect([...tr.route.exports]).toEqual(["food"]);
    expect(tr.importUnitsPerVisit("clothing")).toBe(IMPORT_ALLOTMENT);
    // Autumn: their weaver failed and their granary filled — the SAME line,
    // the same partner, the opposite cargo. A bind-day list could not say this.
    tr.refreshCargo({
      us: books(["clothing"]),
      them: books(["food"]),
      goods: ["food", "clothing"],
    });
    expect([...tr.route.imports]).toEqual(["food"]);
    expect([...tr.route.exports]).toEqual(["clothing"]);
  });

  // ── batch 2 · G3 — the hold is BID FOR, not divided by headcount ──────────
  //
  // economy-arc-opening.md batch 2, G3. `complementaryTrade` ranked the cargo
  // by how badly we wanted each good and then `importUnitsPerVisit` dealt the
  // allotment EVENLY, which threw the ranking away at the one place it could
  // have mattered. The split is now largest-remainder over those same wants.

  it("🔒 EQUAL WANTS reproduce the flat split, byte for byte (the shipped 3-kind line)", () => {
    const tr = line();
    // Measured against the formula the module used to run, not asserted.
    const flat = Math.floor(IMPORT_ALLOTMENT / TRADE_IMPORT_KINDS.length);
    for (const k of TRADE_IMPORT_KINDS) expect(tr.importUnitsPerVisit(k)).toBe(flat);
    // An unbound line has no ranking behind it at all, so every kind weighs
    // the same and the shipped arithmetic is what runs.
    expect(TRADE_IMPORT_KINDS.reduce((n, k) => n + tr.importUnitsPerVisit(k), 0))
      .toBe(IMPORT_ALLOTMENT);
  });

  it("🚨 THE WORST SHORTAGE GETS THE LARGEST SHARE — and Σ is the allotment exactly", () => {
    const tr = line();
    const c = center();
    tr.bindPartner({ key: "hamlet", at: { x: c.x + 600, y: c.y }, distanceM: 600 });
    // They can spare all three; our own books rank them 1.0 / 0.5 / 0.2.
    const them = { shortage: () => 0 };
    const us = {
      shortage: (g: string) =>
        ({ cloth: 1, clothing: 0.5, wood: 0.2 } as Record<string, number>)[g] ?? 0,
    };
    tr.refreshCargo({ us, them, goods: ["cloth", "clothing", "wood"] });
    expect([...tr.route.imports]).toEqual(["cloth", "clothing", "wood"]); // ranked
    const units = tr.route.imports.map((k) => tr.importUnitsPerVisit(k));
    // 6 units weighted 1 / 0.5 / 0.2 (Σ 1.7) = 3.529 / 1.765 / 0.706 → floors
    // 3 / 1 / 0, and the two left over go to the largest remainders.
    expect(units).toEqual([3, 2, 1]);
    expect(units.reduce((a, b) => a + b, 0)).toBe(IMPORT_ALLOTMENT); // conserved
    // Strictly ordered by need — the flat split gave all three 2 apiece.
    expect(units[0]!).toBeGreaterThan(units[1]!);
    expect(units[1]!).toBeGreaterThan(units[2]!);
    // A good the line does not carry still lands nothing.
    expect(tr.importUnitsPerVisit("food")).toBe(0);
    // …and the RARE treat still rides BESIDE the allotment, untouched by any
    // of this (it is the one payload already priced by distance).
    expect(tr.importUnitsPerVisit(RARE_IMPORT_KIND)).toBe(tr.route.rare.perVisit);
  });

  it("🔒 a ONE-GOOD cargo still lands the whole allotment (the live dollhouse case)", () => {
    const tr = line();
    const c = center();
    tr.bindPartner({ key: "hamlet", at: { x: c.x + 600, y: c.y }, distanceM: 600 });
    tr.refreshCargo({
      us: books(["food"]), them: books(["clothing"]), goods: ["food", "clothing"],
    });
    expect([...tr.route.imports]).toEqual(["clothing"]);
    expect(tr.importUnitsPerVisit("clothing")).toBe(IMPORT_ALLOTMENT);
  });

  it("the split FOLLOWS the books: re-derive, and the hold is re-dealt", () => {
    const tr = line();
    const c = center();
    tr.bindPartner({ key: "hamlet", at: { x: c.x + 600, y: c.y }, distanceM: 600 });
    const them = { shortage: () => 0 };
    const goods = ["cloth", "clothing"];
    tr.refreshCargo({ us: { shortage: (g) => (g === "cloth" ? 1 : 0.2) }, them, goods });
    expect(tr.route.imports.map((k) => tr.importUnitsPerVisit(k))).toEqual([5, 1]);
    // Cloth arrives, the tailor is still idle: the SAME line re-deals the hold.
    tr.refreshCargo({ us: { shortage: (g) => (g === "cloth" ? 0.2 : 1) }, them, goods });
    expect([...tr.route.imports]).toEqual(["clothing", "cloth"]);
    expect(tr.route.imports.map((k) => tr.importUnitsPerVisit(k))).toEqual([5, 1]);
  });

  it("`dayPhase` is the CARAVAN's own day: 0 where `tradeDay` ticks over, and rises within it", () => {
    const tr = line();
    let flip = -1;
    for (let t = 0; t < FOOD_DAY_SEC * 2; t += 0.5) {
      if (tr.tradeDay(t) !== tr.tradeDay(t - 0.5) && t > 0) { flip = t; break; }
    }
    expect(flip).toBeGreaterThan(0);
    expect(tr.dayPhase(flip)).toBeLessThan(0.5 / FOOD_DAY_SEC + 1e-9); // just past 0
    expect(tr.dayPhase(flip - 0.5)).toBeGreaterThan(0.99); // just short of 1
    expect(tr.dayPhase(flip + FOOD_DAY_SEC / 2)).toBeCloseTo(0.5, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ②b BATCH 2 · G3 — `allotmentSplit`, the conserving allocator at the hold
// ─────────────────────────────────────────────────────────────────────────

describe("allotmentSplit — largest remainder over the cargo's own wants", () => {
  it("🚨 CONSERVES EXACTLY, for every weighting and every total", () => {
    const weightings = [
      [1, 1, 1], [1, 0.5, 0.2], [0.15, 0.16, 0.99], [3, 1], [1], [7, 7, 7, 7, 7],
      [0.9, 0.9, 0.9, 0.9], [1, 0, 0],
    ];
    for (const w of weightings) {
      for (const total of [0, 1, 2, 6, 7, 13, 100]) {
        const out = allotmentSplit(w, total);
        expect(out).toHaveLength(w.length);
        expect(out.reduce((a, b) => a + b, 0)).toBe(total);
        for (const n of out) expect(Number.isInteger(n) && n >= 0).toBe(true);
      }
    }
  });

  it("🚨 the bigger bid takes the bigger share, ties to the CALLER's order", () => {
    expect(allotmentSplit([1, 0.5, 0.2], 6)).toEqual([3, 2, 1]);
    expect(allotmentSplit([0.2, 0.5, 1], 6)).toEqual([1, 2, 3]); // weights, not slots
    // Equal weights, an allotment that does not divide: the remainder goes to
    // the head of the caller's order and NOTHING is dropped. (The flat split
    // this replaces silently lost those units at the depot gate.)
    expect(allotmentSplit([1, 1, 1, 1], 6)).toEqual([2, 2, 1, 1]);
    expect(allotmentSplit([1, 1, 1], 6)).toEqual([2, 2, 2]); // the shipped line
  });

  it("🔒 degenerate inputs never mint, never NaN, never throw", () => {
    expect(allotmentSplit([], 6)).toEqual([]);
    expect(allotmentSplit([0, 0, 0], 6)).toEqual([2, 2, 2]); // no opinion ⇒ share alike
    expect(allotmentSplit([NaN, 1], 6)).toEqual([0, 6]);
    expect(allotmentSplit([-3, 1], 6)).toEqual([0, 6]);
    expect(allotmentSplit([1, 1], -5)).toEqual([0, 0]);
    expect(allotmentSplit([1, 1], 5.9)).toEqual([3, 2]); // whole units only
  });

  it("🔒 PURE — same inputs, same output, and the inputs are untouched", () => {
    const w = [1, 0.5, 0.2];
    const a = allotmentSplit(w, 6);
    const b = allotmentSplit(w, 6);
    expect(a).toEqual(b);
    expect(w).toEqual([1, 0.5, 0.2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ②c BATCH 2 · G2 — the export cliff becomes a margin
// ─────────────────────────────────────────────────────────────────────────

describe("exportPile — a town ships only what it can spare", () => {
  let play: TownPlay;
  const center = () => ({ x: play.plan.radius + 40, y: play.plan.radius + 40 });
  const lineAt = (exportScale?: () => number) =>
    createTownTrade(center(), play.plan, play.plan.streets, SEED, {
      exportGood: "food",
      exportDaily: 10,
      ...(exportScale ? { exportScale } : {}),
    })!;
  /** The whole visit cycle, sampled — one number per case, comparable. */
  const pileOver = (tr: ReturnType<typeof lineAt>) => {
    const out: number[] = [];
    for (let t = 0; t < FOOD_DAY_SEC; t += FOOD_DAY_SEC / 24) out.push(tr.exportPile(t));
    return out;
  };

  beforeAll(() => {
    play = buildTownPlay({ seed: SEED, days: YOUNG_DAYS });
  });

  it("🔒 NO READER ⇒ the pile is bit-for-bit what it always was", () => {
    // Measured against the same line built without the seat — not asserted.
    expect(pileOver(lineAt())).toEqual(pileOver(lineAt(() => 1)));
    expect(Math.max(...pileOver(lineAt()))).toBeGreaterThan(0);
  });

  it("🚨 a town at the WANT GATE for its own export good ships NOTHING", () => {
    const starved = lineAt(() => exportSpareScale(BARTER_WANT_MIN));
    expect(pileOver(starved).every((v) => v === 0)).toBe(true);
  });

  it("🚨 …and THINS on the way there — the cliff is a slope now", () => {
    const peakAt = (shortage: number) =>
      Math.max(...pileOver(lineAt(() => exportSpareScale(shortage))));
    const peaks = [0, 0.03, 0.06, 0.09, 0.12, BARTER_WANT_MIN].map(peakAt);
    for (let i = 1; i < peaks.length; i++) expect(peaks[i]!).toBeLessThan(peaks[i - 1]!);
    expect(peaks[peaks.length - 1]!).toBe(0);
    // Half-way to the gate, half the surplus — the ramp is the SAME sawtooth,
    // scaled, not a different curve (the shape is what a player watches).
    const full = pileOver(lineAt());
    const half = pileOver(lineAt(() => exportSpareScale(BARTER_WANT_MIN / 2)));
    full.forEach((v, i) => expect(half[i]!).toBeCloseTo(v * 0.5, 9));
  });

  it("🔒 the scale is read LIVE, and clamped at the boundary", () => {
    // `exportDaily` is fixed at construction; scarcity is not. One line, two
    // readings, and the crate follows the books between them.
    let shortage = 0;
    const tr = lineAt(() => exportSpareScale(shortage));
    const fed = tr.exportPile(500);
    shortage = BARTER_WANT_MIN / 2;
    expect(tr.exportPile(500)).toBeCloseTo(fed * 0.5, 9);
    // A reader that misbehaves can neither mint surplus nor invert the pile.
    const wild = createTownTrade(center(), play.plan, play.plan.streets, SEED, {
      exportGood: "food", exportDaily: 10, exportScale: () => 9,
    })!;
    expect(wild.exportPile(500)).toBeCloseTo(lineAt().exportPile(500), 9);
    const negative = createTownTrade(center(), play.plan, play.plan.streets, SEED, {
      exportGood: "food", exportDaily: 10, exportScale: () => -2,
    })!;
    expect(negative.exportPile(500)).toBe(0);
    const nan = createTownTrade(center(), play.plan, play.plan.streets, SEED, {
      exportGood: "food", exportDaily: 10, exportScale: () => NaN,
    })!;
    expect(nan.exportPile(500)).toBeCloseTo(lineAt().exportPile(500), 9);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ③ T3 + T4a — THE WHOLE CHANNEL, LIVE, on a town with no tailor
// ─────────────────────────────────────────────────────────────────────────

const specPath = join(process.cwd(), "games", "dollhouse", "src", "game.spec.json");
/** The shipped document, aged DOWN to before its tailor exists. Nothing else
 *  differs — this is the real content, earlier in its life. */
const youngDoc = (): unknown => {
  const doc = JSON.parse(readFileSync(specPath, "utf8"));
  doc.game.world.days = YOUNG_DAYS;
  doc.game.world.seed = SEED;
  return doc;
};

describe("T4a — an unlicensed town with a licensed partner sees its shortage FALL", () => {
  let run: TextQuestRun;
  const host = () => run.host as unknown as { shortageProbe(good: string): number };
  const trade = () => run.session.town!.stage.trade!;
  const clothing = () => run.session.town!.stage.goods.find((g) => g.good.key === "clothing")!;
  const scalar = (n: string) => run.session.town!.town.scalar(n);

  beforeAll(() => {
    run = bootTextQuest({ world: youngDoc(), seed: SEED, dt: 1 / 20 });
    run.advanceS(6);
  });
  afterAll(() => run?.dispose());

  it("THE PREMISE: it weaves cloth and cannot sew it — no tailor, and a clothing shortage of 1", () => {
    const works = run.session.town!.plan.works.map((w) => w.type);
    expect(works).toContain("weaver"); // the raw good is made here…
    expect(works).not.toContain("tailor"); // …and nothing in town refines it
    expect(scalar("clothing_need")).toBeGreaterThan(0);
    expect(scalar("clothing_got")).toBe(0);
    expect(host().shortageProbe("clothing")).toBe(1);
  });

  // ⚖️ batch 3 · B3 — the read side's other new term, on the STAPLE's lane.
  it("🚨 B3 THE OWED TERM: a town that ships a third of its draw is not as fed as `got` says", () => {
    const t = run.session.town!;
    const tr = t.stage.trade!;
    const food = t.stage.goods.find((g) => g.good.key === "food")!;
    // THE PREMISE: the farms cover the town exactly — `got === need` — so the
    // street layer's own reading is a perfect 1 and stays that way. `fill()`
    // is UNTOUCHED by any of this: it is the street's bank-blind read, and B3
    // lands on the BOOKS' read alone.
    expect(scalar("food_got")).toBeCloseTo(scalar("food_need"), 12);
    expect(food.fill()).toBe(1);
    // …and yet a caravan takes a share of that supply out of town every single
    // day. Before B3 the books never heard about it and answered 0 forever
    // (free lunch #3). Now the committed export rate is subtracted, rate
    // against rate: shortage = clamp01(1 − (got + fed − owed)/need).
    expect([...tr.route.exports]).toEqual(["food"]);
    const owed = tr.exportDailyUnits() * bookUnitsPerStreetUnit(t.eco, "food");
    expect(owed).toBeGreaterThan(0);
    const shortage = host().shortageProbe("food");
    expect(shortage).toBeCloseTo(owed / scalar("food_need"), 9);
    // The equilibrium B4 solves for: about a tenth, and under the want gate
    // that decides whether food is on the export list at all.
    expect(shortage).toBeCloseTo(0.1005, 4);
    expect(shortage).toBeLessThan(BARTER_WANT_MIN);
  });

  it("T3a LIVE: the depot is clothing's supply — an empty shelf, not an absent one", () => {
    const g = clothing();
    // ⚖️ RE-PINNED (2026-08-09, the clothing-shopper flood): clothing now rides
    // the MARKET CHANNEL, so the plaza stall the service radius founded sells
    // it too and the depot is APPENDED after it (`srcIdx` is a persistence key
    // — a new source may only ever arrive at the end). The claim T3a makes is
    // unchanged and is about the DEPOT: a town that makes none of the good
    // still has a real, shoppable place the lane lands it. A market stall is a
    // SHELF, not a source — its presence never vetoes the depot (town-stage's
    // eligibility filters `MARKET_CHANNEL` out for exactly this reason), or the
    // lane would switch off in every town that has a market, which is every town.
    expect(g.sources).toHaveLength(2);
    const di = g.sources.findIndex((s) => s.depot);
    expect(di).toBe(1); // APPENDED, never inserted
    expect(g.sources[0]!.kind).toBe("market"); // the distribution shelf, not a maker
    // It stands at the caravan depot, and is a real openable endpoint the
    // household loop can be sent to (`goodSourceEndpointId` → the seeding).
    expect(Math.hypot(g.sources[di]!.x - trade().depot.x, g.sources[di]!.y - trade().depot.y))
      .toBeLessThan(4);
    const id = goodSourceEndpointId(g, di)!;
    expect(id).toBe("store:clothing:1");
    expect(run.state.objects[id]).toBeDefined();
    expect(run.session.marketStore.get(id)).toBe("clothing");
    // The abstract `away:` line carries trinkets, so the shelf is BARE — which
    // is the honest picture of a town nobody ships clothing to.
    expect(trade().route.partnerAt).toBeUndefined();
    expect(g.stockOf(g.sources[di]!, run.session.townClock)).toBe(0);
  });

  it("🚨 T3b THE FEED TERM IS THE NET'S OWN LAW, read live", () => {
    // `TownWorld.step` runs only in the boot fast-forward, so the stockpile a
    // landing credits would otherwise sit unread all session. A PARTIAL bank
    // must relieve exactly `min(bank, need − got)` — the flow net's formula
    // (entities.ts, granary-feed.test.ts), never more.
    const need = scalar("clothing_need");
    const got = scalar("clothing_got");
    const bank = need * 0.25;
    run.session.town!.town.inject("drapery", bank);
    expect(scalar("drapery")).toBeCloseTo(bank, 9);
    expect(host().shortageProbe("clothing")).toBeCloseTo(1 - (got + bank) / need, 6);
    // FOOD's granary keeps `driftFeeds` OFF (the SCOPE CUT), so its bank is a
    // bank and not relief — the staple's reading is untouched by all of this.
    const foodBefore = host().shortageProbe("food");
    run.session.town!.town.inject("granary", 50);
    expect(host().shortageProbe("food")).toBe(foodBefore);
    // Put the books back for the end-to-end below.
    run.session.town!.town.inject("drapery", -bank);
    expect(host().shortageProbe("clothing")).toBe(1);
  });

  it("🚨 THE END TO END: bind a partner with clothing to spare, and the shortage falls", () => {
    const tr = trade();
    const center = run.session.town!.stage.center;
    const day = Math.floor(run.session.townClock / run.session.scale.dayLengthS);
    // A REAL neighbour 600 m up a road whose OWN books say they have clothing
    // to spare and want food — the licensed refinery town, read not asserted.
    let key: string | null = null;
    for (let i = 0; i < 500 && key === null; i++) {
      const s = stubPartnerSignals(`city:${i}`, day);
      if (s.shortage("clothing") < BARTER_WANT_MIN && s.shortage("food") >= BARTER_WANT_MIN) {
        key = `city:${i}`;
      }
    }
    expect(key).not.toBeNull();
    tr.bindPartner({ key: key!, at: { x: center.x + 600, y: center.y }, distanceM: 600 });

    const before = host().shortageProbe("clothing");
    expect(before).toBe(1);
    const bucket = tr.tradeDay(run.session.townClock);
    // Walk the clock to the next CARAVAN LANDING — the sweep settles the day's
    // cargo there (nothing is poked; the visit is what the clock says it is).
    for (let i = 0; i < 40 && tr.tradeDay(run.session.townClock) === bucket; i++) run.advanceS(8);
    expect(tr.tradeDay(run.session.townClock)).toBeGreaterThan(bucket);
    run.advanceS(2); // the task sweep is throttled to a second

    // ① the LANE now carries the good this town cannot make…
    expect([...tr.route.imports]).toContain("clothing");
    // ② …② the DEPOT SHELF holds it, so a household can shop it… (the depot is
    // APPENDED after the plaza stall now that clothing rides the market
    // channel — found by its own flag, never by an index).
    const g = clothing();
    const depot = g.sources.find((s) => s.depot)!;
    expect(g.stockOf(depot, run.session.townClock)).toBeGreaterThan(0);
    // ③ …and the BOOKS saw it land: EXACTLY the visit's allotment banked into
    // the drapery, once, and the shortage fell with it.
    const landed = tr.importUnitsPerVisit("clothing");
    expect(landed).toBeGreaterThan(0);
    // ⚖️ RE-PINNED (batch 3 · B1). Both lines used to read `landed` — the raw
    // STREET count — against a books scalar, i.e. they asserted that six
    // garments off a cart are six person-days of clothing on the aggregate's
    // ledger. `bookUnitsPerStreetUnit` is the compiler's own inverse
    // (`perPersonDaily / perCapitaDaily`), and it measures 0.001 here: six
    // garments bank 0.006 book units. Same claim, honest units.
    const bridge = bookUnitsPerStreetUnit(run.session.town!.eco, "clothing");
    expect(bridge).toBeCloseTo(0.001, 12);
    expect(scalar("drapery")).toBeCloseTo(landed * bridge, 12);
    expect(run.session.town!.deltas.driftBank.drapery).toBeCloseTo(landed * bridge, 12);
    const after = host().shortageProbe("clothing");
    expect(after).toBeLessThan(before);
    // One caravan still covers this town's WHOLE clothing need the day it
    // lands, and the relief is capped at the real shortfall — UNCHANGED.
    expect(after).toBe(0);
    // ⚖️ RE-PINNED (batch 3 · B1): the same inequality, both sides in BOOK
    // units. It is the honest form of what this line always meant — one visit
    // brings more than the town wants in a day — and it is now a statement
    // about a comparable pair rather than a units mismatch that happened to
    // point the right way. What CHANGED is the margin: 0.006 against 7.66e-4
    // is eight days of cover, where 6 against 7.66e-4 was twenty-one years.
    expect(landed * bridge).toBeGreaterThan(scalar("clothing_need"));
    const daysOfCover = (landed * bridge) / scalar("clothing_need");
    expect(daysOfCover).toBeGreaterThan(7);
    expect(daysOfCover).toBeLessThan(9);
  });

  it("🔒 T3b DURABILITY: the bank rides TownDeltas, and a reboot re-injects it", () => {
    const banked = run.session.town!.deltas.driftBank.drapery;
    expect(banked).toBeGreaterThan(0);
    const saved = JSON.parse(JSON.stringify(run.session.town!.deltas.toJSON()));
    expect(saved.driftBank.drapery).toBeCloseTo(banked, 12);
    // A town rebuilt from those deltas has the credit back in its books —
    // injected AFTER the fast-forward, exactly where a founded producer
    // re-injects its count scalar.
    const reborn = buildTownPlay({ seed: SEED, days: YOUNG_DAYS, deltas: saved });
    expect(reborn.town.scalar("drapery")).toBeGreaterThanOrEqual(banked);
    // ⚖️ EXTENDED (batch 3 · B2/B5): the bank is SIGNED now — the day's eating
    // and the caravan's outbound load both write it — and town-play's replay
    // was dropping every negative entry (`units > 0`). A durable ledger that
    // only ever rounds up is not durable, so the negative half must survive the
    // same round trip. The granary row is the live proof: this run's caravans
    // have already debited it (nothing here constructs the number).
    expect(saved.driftBank.granary).toBeLessThan(0);
    expect(saved.driftBank.granary).toBeCloseTo(
      run.session.town!.deltas.driftBank.granary,
      12,
    );
    const debited = buildTownPlay({ seed: SEED, days: YOUNG_DAYS, deltas: saved });
    const fresh = buildTownPlay({ seed: SEED, days: YOUNG_DAYS });
    expect(debited.town.scalar("granary")).toBeCloseTo(
      fresh.town.scalar("granary") + saved.driftBank.granary,
      9,
    );
    // …and a save with no bank at all still loads (absent-tolerant).
    delete saved.driftBank;
    expect(() => buildTownPlay({ seed: SEED, days: YOUNG_DAYS, deltas: saved })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ③b B2 — THE BANK IS A STOCK THAT EMPTIES AS IT FEEDS (the honest sawtooth)
// ─────────────────────────────────────────────────────────────────────────
//
// The other half of the same lane. `townShortage`'s feed term (T3b-i above)
// mirrors the flow net's own law — `fed = min(stock, demand − satisfied)` —
// but the kernel's law has a SECOND clause the read side could not have: the
// fed amount IS the drain (cells/entities.ts, granary-feed.test.ts). A town
// world steps only in the boot fast-forward, so live that clause never ran and
// any bank ≥ one day's shortfall pinned the shortage at 0 forever. One caravan
// bought permanent relief; that is what this describe is the test of.
//
// ⚠️ THE CLOCK IS DRIVEN, NOT WALKED. The host clamps its own frame dt at 0.05
// (world-host.ts), so eight sim-days is 38,400 frames — twenty-odd minutes of
// wall time for one pin. The drain is a DAY-EDGE EVENT, so the pin puts the
// town clock on the eve of each edge and steps the real sweep across it: the
// same edge the loop produces, reached the way a test clock reaches things.
describe("B2 — one caravan relieves for eight days, then the shortage climbs back", () => {
  let run: TextQuestRun;
  const host = () => run.host as unknown as { shortageProbe(good: string): number };
  const scalar = (n: string) => run.session.town!.town.scalar(n);
  /** Put the clock a breath before day `d`'s edge and step the sweep over it.
   *  2.5 s guarantees at least one sweep lands AFTER the crossing whatever
   *  phase the throttle (`TASK_CLAIM_INTERVAL_S` = 1 s) happens to be in. */
  const crossInto = (d: number) => {
    run.session.townClock = d * FOOD_DAY_SEC - 0.4;
    run.advanceS(2.5);
  };

  beforeAll(() => {
    run = bootTextQuest({ world: youngDoc(), seed: SEED, dt: 1 / 20 });
    run.advanceS(4);
  });
  afterAll(() => run?.dispose());

  it("🚨 THE DRAIN IS THE KERNEL'S OWN LAW, run live on the day edge", () => {
    const t = run.session.town!;
    const bridge = bookUnitsPerStreetUnit(t.eco, "clothing");
    const need = scalar("clothing_need");
    expect(scalar("clothing_got")).toBe(0); // no tailor: the whole need is a shortfall
    // ONE caravan's landing, banked (6 street garments at the books' own rate).
    t.town.inject("drapery", IMPORT_ALLOTMENT * bridge);
    expect(scalar("drapery")).toBeCloseTo(0.006, 12);
    expect(host().shortageProbe("clothing")).toBe(0); // relieved, today
    // One economy day later the stockpile is down by EXACTLY what it fed —
    // `min(bank, need − got)`, the flow net's formula, no more.
    crossInto(1);
    expect(scalar("drapery")).toBeCloseTo(0.006 - need, 12);
    // …and the durable mirror moved with it, negative (B5's replay depends on
    // this surviving `TownDeltas`).
    expect(t.deltas.driftBank.drapery).toBeCloseTo(-need, 12);
  });

  it("🚨 THE SAWTOOTH: full relief for ~8 days, then the honest climb back", () => {
    const need = scalar("clothing_need");
    const relief = IMPORT_ALLOTMENT * bookUnitsPerStreetUnit(run.session.town!.eco, "clothing");
    // 0.006 book units against 7.66e-4/day — the caravan bought eight days.
    expect(relief / need).toBeGreaterThan(7);
    expect(relief / need).toBeLessThan(8);
    const curve: Array<{ day: number; bank: number; shortage: number }> = [];
    for (let d = 2; d <= 10; d++) {
      crossInto(d);
      curve.push({
        day: d,
        bank: scalar("drapery"),
        shortage: host().shortageProbe("clothing"),
      });
    }
    // The bank only ever falls, and the drained total is exactly d × the
    // shortfall until it runs dry (the cumulative law — a sweep that lands
    // just BEFORE an edge defers to the next one, which then drains both).
    for (const row of curve) {
      expect(row.bank).toBeCloseTo(Math.max(0, relief - row.day * need), 12);
    }
    // FULL RELIEF while the bank covers a day's shortfall…
    expect(curve.find((r) => r.day === 6)!.shortage).toBe(0);
    // …a PARTIAL day as it runs out (the last of the bank still feeds)…
    const seventh = curve.find((r) => r.day === 7)!;
    expect(seventh.shortage).toBeGreaterThan(0);
    expect(seventh.shortage).toBeCloseTo(1 - seventh.bank / need, 9);
    // …and then the town is exactly as short as it was before the caravan
    // came. The eternal 0 is gone.
    expect(curve.find((r) => r.day === 8)!.bank).toBe(0);
    expect(curve.find((r) => r.day === 8)!.shortage).toBe(1);
    expect(curve.find((r) => r.day === 10)!.shortage).toBe(1);
  });

  it("🔒 the multi-day skip is a MULTIPLIER, never a lost day", () => {
    const t = run.session.town!;
    const need = scalar("clothing_need");
    t.town.inject("drapery", 20 * need); // twenty days of cover
    const before = scalar("drapery");
    const mirrorBefore = t.deltas.driftBank.drapery!;
    const day = Math.floor(run.session.townClock / FOOD_DAY_SEC);
    crossInto(day + 5); // five economy days pass between two sweeps
    expect(scalar("drapery")).toBeCloseTo(before - 5 * need, 12);
    expect(t.deltas.driftBank.drapery).toBeCloseTo(mirrorBefore - 5 * need, 12);
  });

  it("🚨 B5 THE CARAVAN DEBIT: what leaves on the cart leaves the books", () => {
    // The staple's own lane, live: this town exports food, and until now the
    // granary never felt a single shipment (free lunch #3). The debit is the
    // day's whole load at today's spare scale, damped by producer attendance,
    // converted at the same bridge — and it rides the durable bank NEGATIVE.
    const t = run.session.town!;
    const tr = t.stage.trade!;
    expect([...tr.route.exports]).toEqual(["food"]);
    const bridge = bookUnitsPerStreetUnit(t.eco, "food");
    const before = scalar("granary");
    const mirrorBefore = t.deltas.driftBank.granary ?? 0;
    expect(mirrorBefore).toBeLessThan(0); // earlier days already charged it
    const bucket = tr.tradeDay(run.session.townClock);
    const day = Math.floor(run.session.townClock / FOOD_DAY_SEC);
    crossInto(day + 1);
    expect(tr.tradeDay(run.session.townClock)).toBeGreaterThan(bucket);
    const charged = before - scalar("granary");
    expect(charged).toBeGreaterThan(0);
    // ONE visit's load, in book units — read off the line itself, not typed.
    expect(charged).toBeCloseTo(tr.exportDailyUnits() * bridge, 9);
    expect(t.deltas.driftBank.granary).toBeCloseTo(mirrorBefore - charged, 9);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ④ T4b / T4c — the two consumers of the lane (pure, diagnostic)
// ─────────────────────────────────────────────────────────────────────────

describe("T4b — a standing trade lane is a hinterland JOB", () => {
  it("one active pair licenses `exchange`; none says nothing", () => {
    expect(hinterlandJobs({}).map((j) => j.kind)).toEqual([]);
    expect(hinterlandJobs({ tradePairs: 0 }).map((j) => j.kind)).toEqual([]);
    expect(hinterlandJobs({ tradePairs: 1 }).map((j) => j.kind)).toEqual(["exchange"]);
  });

  it("the sentence counts the lanes and prints the derivation, singular and plural", () => {
    expect(hinterlandJobs({ tradePairs: 1 })[0]!.sentence).toMatch(/1 standing trade lane runs/);
    expect(hinterlandJobs({ tradePairs: 4 })[0]!.sentence).toMatch(/4 standing trade lanes run/);
  });

  it("it comes AFTER the terrain and the graph, and never displaces them", () => {
    const jobs = hinterlandJobs({ roadDegree: 3, tradePairs: 2 });
    expect(jobs.map((j) => j.kind)).toEqual(["hub", "exchange"]);
  });

  it("…and it lifts the village cap: a jobless village that trades is a town", () => {
    expect(cityLicense(hinterlandJobs({}), 2000).licensed).toBe(false);
    const lic = cityLicense(hinterlandJobs({ tradePairs: 1 }), 2000);
    expect(lic.licensed).toBe(true);
    expect(lic.cap).toBe(Infinity);
  });

  it("the count is `activeTradePairs`, not a new number", () => {
    const row = (partnerKey: string, giveGood: string, takeGood: string) => ({
      id: `a-${partnerKey}-${giveGood}-${takeGood}`,
      from: "town:yard",
      to: `town:${partnerKey}`,
      goods: { [giveGood]: 2 },
      issuer: "__player__",
      mode: "scheduled" as const,
      status: "pending" as const,
      postedAt: 0,
      barter: {
        take: { [takeGood]: 1 },
        giveGood,
        takeGood,
        quote: { give: 2, take: 1 },
        partnerKey,
      },
    });
    const rows = [row("a", "wood", "food"), row("b", "wood", "food")];
    expect(activeTradePairs(rows)).toBe(2);
    expect(hinterlandJobs({ tradePairs: activeTradePairs(rows) }).map((j) => j.kind))
      .toEqual(["exchange"]);
    expect(hinterlandJobs({ tradePairs: activeTradePairs([]) })).toEqual([]);
  });
});

describe("T4c — the parasite names who is covering it", () => {
  const r: CeilingReading = {
    ceiling: 100, binding: "food", factors: [], truncated: false, sentence: "",
  };

  it("🔒 no partner named ⇒ the shipped wording, verbatim", () => {
    const p = parasiteReading(250, r);
    expect(p.parasite).toBe(true);
    expect(p.sentence).toMatch(/2\.5× beyond its food — a parasite/);
    expect(p.sentence).toMatch(/a partner covers the gap/);
    expect(p.sentence).toMatch(/leaves, not riots/);
  });

  it("a named partner is said out loud — same verdict, same strain", () => {
    const named = parasiteReading(250, r, "city:41");
    const anon = parasiteReading(250, r);
    expect(named.parasite).toBe(anon.parasite);
    expect(named.strain).toBe(anon.strain);
    expect(named.sentence).toMatch(/city:41 covers the gap/);
    expect(named.sentence).not.toMatch(/a partner covers/);
  });

  it("within the ceiling the name is irrelevant — nothing is being covered", () => {
    expect(parasiteReading(80, r, "city:41").sentence).toBe(parasiteReading(80, r).sentence);
  });
});
