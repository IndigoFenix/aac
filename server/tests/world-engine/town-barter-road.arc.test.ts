// THE ROAD THE HOST CARRIES INTO BARTER (economy-arc-opening.md batch 1, T1)
//
// `bindPartner` has measured the road between two settlements since trade
// v1.5 — and `tradePartnersOf` then re-pushed that very line as a PLACE-LESS
// STUB (`distanceM: null`), so every caravan, next door or eight days out, was
// priced at the same flat `BARTER_LEG_DAY_FRAC` day. The kernel half is pinned
// in town-stage.test.ts (the bind records the partner); THIS file pins the
// half no pure test can reach: that the LIVE host reads it.
//
// The probe is the standing route's own re-derived clock. `runDueBarters`
// advances a standing row by `max(every, legSecondsOf(partner))` — so the
// interval between two legs IS the host's answer to "how far away are they?",
// with no spoken parse, no willingness gamble and no yard stock in the way (a
// refused or short leg advances the clock exactly the same).
//
// Headless boot only — no DOM / GL / DB.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import { townEndpointId } from "@shared/world-engine/kernel/town/transfer.js";
import { FOOD_DAY_SEC } from "@shared/world-engine/kernel/town/goods.js";
import { barterLegSeconds } from "@shared/world-engine/kernel/town/barter.js";

const specPath = join(process.cwd(), "games", "dollhouse", "src", "game.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8"));

const DT = 1 / 20;

/** Post a STANDING barter route to `partnerKey`, due immediately, and step
 *  frames until the host's throttled task sweep runs it. Returns the seconds
 *  the host put between this leg and the next — the number T1 is about.
 *  Measured against the clock AT THE FRAME THE ROW MOVED, so the answer is the
 *  interval itself and not the interval plus however long the sweep waited. */
function legIntervalS(run: TextQuestRun, partnerKey: string): number {
  const t0 = run.session.taskClock;
  const a = run.session.transfers.post({
    from: "town:yard",
    to: townEndpointId(partnerKey),
    goods: { wood: 2 },
    issuer: "__player__",
    mode: "scheduled",
    now: t0,
    every: FOOD_DAY_SEC,
    dueAt: t0,
    sourceGlyph: "trade + wood",
    barter: {
      take: { food: 0 },
      giveGood: "wood",
      takeGood: "food",
      quote: { give: 1, take: 1 },
      partnerKey,
    },
  });
  // The pool sweep is throttled to TASK_CLAIM_INTERVAL_S (1 s); step one frame
  // at a time so we catch the exact frame the leg clock is rewritten.
  const row = run.session.transfers.get(a.id)!;
  expect(row.nextDueAt).toBe(t0);
  let moved = 0;
  for (let i = 0; i < Math.ceil(3 / run.frameDt) && moved === 0; i++) {
    run.advance(1); // stepTaskPool → stepBarters
    if (row.nextDueAt !== t0) moved = row.nextDueAt;
  }
  // The row must have RUN, not died: a failed row never reaches the leg clock.
  expect(row.status).not.toBe("failed");
  expect(moved).toBeGreaterThan(0); // the sweep DID execute this route
  return moved - run.session.taskClock;
}

// ONE boot for the whole file (a dollhouse boot costs ~12 s): the three cases
// are the same line's LIFE — abstract, bound far, rebound near — in order, and
// each rebinding is exactly what `bindPartner` does mid-session anyway.
describe("T1 — the caravan leg is priced on the road the bound route holds", () => {
  let run: TextQuestRun;
  let far = 0;

  beforeAll(() => {
    run = bootTextQuest({ world: doc, dt: DT });
    run.advance(6);
  });
  afterAll(() => run?.dispose());

  it("an UNBOUND line keeps the flat fallback (its `gate` is our own street, not a place)", () => {
    const tr = run.session.town?.stage.trade;
    expect(tr).toBeDefined();
    expect(tr!.route.partnerKey).toMatch(/^away:/);
    expect(tr!.route.partnerAt).toBeUndefined();

    // The flat leg (84 s on this scale) is SHORTER than the route's own
    // recurrence, so an unbound partner is paced by `every` — exactly the
    // shipped behaviour, and the thing a bound partner must break out of.
    const flat = barterLegSeconds(run.session.scale, null);
    expect(flat).toBeLessThan(FOOD_DAY_SEC);
    expect(legIntervalS(run, tr!.route.partnerKey)).toBeCloseTo(FOOD_DAY_SEC, 6);
  });

  it("🔒 a BOUND partner's leg is the ROAD — not the flat fallback, not the recurrence", () => {
    const tr = run.session.town!.stage.trade!;
    const center = run.session.town!.stage.center;
    // A real neighbour three km up a real road (the length `bindPartner`
    // receives from the region's route graph).
    const ROAD_M = 3000;
    tr.bindPartner({
      key: "hamlet-far",
      at: { x: center.x + 2100, y: center.y + 900 },
      distanceM: ROAD_M,
    });
    expect(tr.route.partnerAt).toBeDefined();

    const expected = barterLegSeconds(run.session.scale, ROAD_M);
    expect(expected).toBeGreaterThan(FOOD_DAY_SEC); // the premise: the road binds
    far = legIntervalS(run, "hamlet-far");
    // ① It is the road, exactly.
    expect(far).toBeCloseTo(expected, 6);
    // ② …and emphatically NOT either of the two numbers the bug produced.
    expect(far).toBeGreaterThan(FOOD_DAY_SEC);
    expect(far).toBeGreaterThan(barterLegSeconds(run.session.scale, null) + 1);
  });

  it("a NEARER bound partner ships sooner — the road is re-derived PER LEG", () => {
    const tr = run.session.town!.stage.trade!;
    const center = run.session.town!.stage.center;
    // The SAME line rebound to a nearer neighbour re-prices itself.
    tr.bindPartner({ key: "hamlet-near", at: { x: center.x + 600, y: center.y }, distanceM: 600 });
    const near = legIntervalS(run, "hamlet-near");
    expect(far).toBeGreaterThan(0); // the previous case ran (ordering premise)
    expect(near).toBeLessThan(far);
    expect(near).toBeCloseTo(barterLegSeconds(run.session.scale, 600), 6);
  });
});
