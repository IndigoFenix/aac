// THE TRIP SPAN — a household errand survives abstraction
// (stocking-offload-and-carry.md §1)
//
// The user's question, verbatim: *"Stocking the household is still running
// into issues, ultimately leading to an empty refrigerator and everyone
// leaving on a shopping trip and never coming back. Is it possible they're
// just getting offloaded?"*
//
// THE ANSWER IS NO, and ① below is the pin for it: a WATCHED house's member is
// exempt from the resident streamer's distance cull by construction, so
// `f.remove` can never name one however far it walks. (Measured alongside:
// 354 `[doll]` heartbeats over 600 sim-s of seed 12, zero NOT-EMBODIED.)
//
// What was really lost is the RETURN LEG. A live errand is a REAL WALK and
// nothing bounded it: seed 12's shopper was out 355 s and still walking, on a
// trip whose own natural span is 104 s, while the pantry it left to fill
// drained behind it. So the EPISODE now ends once the haul is in hand and the
// span is spent: the body is handed back to its schedule and walks home.
//
// ⚖️ LAW (user, 2026-08-09) — CLOCK OWNS MOTION; DISRUPTION DISRUPTS. The arm
// used to BANK the haul into the home boxes on its way out. That converted an
// interrupted errand into a delivered one — the delivery-side twin of
// construction's "deserted site finishing" sin — so it is gone: on overrun the
// GOODS STAY IN THE BASKET. They come home the ordinary way (the next
// provisioning/tidy row, or the drop law), the shortage persists, and the cycle
// retries. Still legal and deliberately distinct: the LOD FOLD, where a body
// CEASES TO EXIST and has no basket left to ride in.
//
// What this file pins:
//  ① THE VERDICT: a watched house's member is never culled, at any distance.
//  ② THE SPAN IS THE CLOCK'S OWN closed form (`cycle().trip` = both walk legs
//     + the shop dwell), never a literal — so it scales with the real route.
//  ③ THE DISRUPTION, live: the template claim released, the unit reservation
//     released, `liveNeedBodies` cleared, the trip clock cleared — AND the haul
//     still in the basket, the home box untouched.
//  ④ …and it does NOT fire inside the span (a body that just bought something
//     round the corner walks its own last leg).
//
// Pure logic + one headless boot — no DOM / GL / DB.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest } from "@shared/world-engine/headless/text-quest.js";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import { createResidentModel, residentId } from "@shared/world-engine/kernel/town/residents.js";
import { streetGoods } from "@shared/world-engine/kernel/town/goods.js";
import { RARE_IMPORT_KIND } from "@shared/world-engine/kernel/town/trade.js";

const specPath = join(process.cwd(), "games", "dollhouse", "src", "game.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8"));

const DT = 1 / 20;
const CONFIG = { seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 };

// ─────────────────────────────────────────────────────────────────────────
// ① THE VERDICT — a watched house's member is NOT offloaded, at any distance
// ─────────────────────────────────────────────────────────────────────────

describe("the resident streamer — a WATCHED house's member is never culled", () => {
  it("keeps its body a quarter of a town away, so `f.remove` can never name it", () => {
    const play = buildTownPlay(CONFIG);
    const center = { x: play.plan.radius + 40, y: play.plan.radius + 40 };
    const goods = streetGoods(play.town, play.eco, { key: CONFIG.key, center, plan: play.plan }, CONFIG.seed);
    const watched = play.plan.houses[0]!;
    const model = createResidentModel({ center, plan: play.plan, goods, seed: CONFIG.seed });
    const me = { x: center.x + watched.dx + watched.w / 2, y: center.y + watched.dy + watched.h / 2 };
    const id = residentId(watched.index, 0);
    const isVisible = (hi: number) => hi === watched.index; // the dollhouse answer: always true

    // Frame 0 populates freely; the member of the on-show house embodies.
    let pos: { x: number; y: number } = { ...me };
    const bodyPos = (bid: string) => (bid === id ? pos : null);
    let up = model.update(me, 0, 40, bodyPos, 120, isVisible);
    expect(up.spawn.some((s) => s.id === id)).toBe(true);

    // …and now it walks clean out of the band and stays there. No despawn,
    // ever — which is exactly why the removal site needs no ownership guard.
    for (let t = 1; t <= 40; t++) {
      pos = { x: me.x + 20 * t, y: me.y + 20 * t }; // hundreds of metres out
      up = model.update(me, t, 40, bodyPos, 120, isVisible);
      expect(up.despawn).not.toContain(id);
    }

    // The control: the SAME body, the same distance, with the house no longer
    // on show — now the ordinary cull takes it. So the exemption is the house's
    // watched-ness, nothing else.
    const culled = model.update(me, 41, 40, bodyPos, 120, () => false);
    expect(culled.despawn).toContain(id);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ② THE SPAN IS THE GOODS CLOCK'S OWN — derived, never a literal
// ─────────────────────────────────────────────────────────────────────────

describe("the natural trip span", () => {
  it("IS both walk legs plus the shop dwell — the clock every abstracted house shops on", () => {
    const play = buildTownPlay(CONFIG);
    const center = { x: play.plan.radius + 40, y: play.plan.radius + 40 };
    const goods = streetGoods(play.town, play.eco, { key: CONFIG.key, center, plan: play.plan }, CONFIG.seed);
    const food = goods.find((g) => g.good.key === "food")!;
    for (const h of play.plan.houses.slice(0, 8)) {
      const c = food.cycle(h);
      expect(c.trip).toBeCloseTo(c.walk * 2 + food.good.shopSec, 6);
      expect(c.trip).toBeGreaterThan(0);
      // A span shorter than its own period — a household is not permanently
      // out shopping, which is the whole point of bounding the live walk.
      expect(c.trip).toBeLessThan(c.period);
    }
  });

  it("scales with the ROUTE, so a far household gets a longer span (no constant)", () => {
    const play = buildTownPlay(CONFIG);
    const center = { x: play.plan.radius + 40, y: play.plan.radius + 40 };
    const goods = streetGoods(play.town, play.eco, { key: CONFIG.key, center, plan: play.plan }, CONFIG.seed);
    const food = goods.find((g) => g.good.key === "food")!;
    const spans = play.plan.houses.map((h) => food.cycle(h).trip);
    expect(Math.max(...spans)).toBeGreaterThan(Math.min(...spans));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ③ + ④ THE DISRUPTION, on the live host
// ─────────────────────────────────────────────────────────────────────────

describe("a live trip that overruns its span is DISRUPTED, never delivered", () => {
  it("releases the claims and frees the body — and the haul stays in the basket", () => {
    const run = bootTextQuest({ world: doc, dt: DT });
    try {
      run.advance(6); // let the town settle and the household embody
      const session = run.session;
      const houseIndex = session.dollhouse!;
      expect(houseIndex).not.toBeNull();
      const cid = `resident_${houseIndex}_0`;
      expect(run.state.avatars[cid]).toBeDefined();

      const chestId = `furn_${houseIndex}_chest_food`;
      const chestBefore = { ...(session.containerStock.get(chestId) ?? {}) };
      const treats = 3;

      // A HAUL IN HAND: a basket holding three treats. A treat is food (it
      // banks into the food chest) but is never dealt into a pantry mix, so
      // nothing else in the household can add or eat one behind the assertion.
      const bag = run.host.giveBag(cid, "basket");
      expect(bag).not.toBeNull();
      session.containerStock.set(bag!, { [RARE_IMPORT_KIND]: treats });
      expect(run.host.carryOf(cid)[RARE_IMPORT_KIND]).toBe(treats);

      // …a long way from home, on a trip that started long ago, owned by the
      // live loop, holding both kinds of claim.
      const body = run.state.avatars[cid]!;
      body.x += 400;
      session.liveNeedBodies.add(cid);
      session.liveTripAt.set(cid, session.townClock - 10_000);
      session.errandClaims.set(`${houseIndex}|provision:food`, cid);
      session.needClaims.reserve(`need:${cid}`, "store:food", "food", 5);
      expect(session.needClaims.holderRows(`need:${cid}`).length).toBeGreaterThan(0);

      run.advance(1);

      // ⚖️ THE DELIVERY HONESTLY FAILED: the home box gained NOTHING, and the
      // three treats are exactly where the body left them — in the basket. An
      // abstraction that emptied the hands here would be telling the economy a
      // trip completed that never did.
      const chestAfter = session.containerStock.get(chestId) ?? {};
      expect((chestAfter[RARE_IMPORT_KIND] ?? 0) - (chestBefore[RARE_IMPORT_KIND] ?? 0)).toBe(0);
      expect(run.host.carryOf(cid)[RARE_IMPORT_KIND] ?? 0).toBe(treats);
      // …and the basket itself is still in the hands, carrying them home.
      expect(run.host.handsOf(cid)).toMatchObject({ objId: bag!, glyph: "basket", bag: true });

      // …while the episode IS over: no claim, no reservation, no live ownership,
      // no trip clock. The body itself is untouched — embodiment is the
      // streamer's business, and it walks home on its own feet.
      expect(session.liveNeedBodies.has(cid)).toBe(false);
      expect(session.errandClaims.get(`${houseIndex}|provision:food`)).toBeUndefined();
      expect(session.needClaims.holderRows(`need:${cid}`)).toHaveLength(0);
      expect(session.liveTripAt.has(cid)).toBe(false);
      expect(run.state.avatars[cid]).toBeDefined();
    } finally {
      run.dispose();
    }
  });

  it("does NOT fire inside the span — the body walks its own last leg", () => {
    const run = bootTextQuest({ world: doc, dt: DT });
    try {
      run.advance(6);
      const session = run.session;
      const houseIndex = session.dollhouse!;
      const cid = `resident_${houseIndex}_0`;
      const chestId = `furn_${houseIndex}_chest_food`;
      const before = { ...(session.containerStock.get(chestId) ?? {}) };

      const bag = run.host.giveBag(cid, "basket");
      expect(bag).not.toBeNull();
      session.containerStock.set(bag!, { [RARE_IMPORT_KIND]: 2 });
      const body = run.state.avatars[cid]!;
      body.x += 400;
      session.liveNeedBodies.add(cid);
      // Left just now: the trip clock is fresh, so the span cannot be spent.
      session.liveTripAt.set(cid, session.townClock);

      run.advance(1);

      const after = session.containerStock.get(chestId) ?? {};
      expect((after[RARE_IMPORT_KIND] ?? 0) - (before[RARE_IMPORT_KIND] ?? 0)).toBe(0);
      expect(run.host.carryOf(cid)[RARE_IMPORT_KIND] ?? 0).toBe(2);
    } finally {
      run.dispose();
    }
  });
});
