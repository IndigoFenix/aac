// PER-SCOPE ORDER BOOKS + THE VOCAL REFUSAL — the order-scoping round
// (planning-docs/games/world-engine/growth-phase-c-founding-loops.md,
// "### Order-scoping round"; user laws ① and ③, 2026-08-12).
//
// ① "With the house scope, all orders should be scoped to the house, not the
//    town. So while the family members going out to collect blocks may
//    technically compete with those elsewhere, it only competes in the sense
//    that both need the same resources — they shouldn't be put in the same
//    queue."
// ③ "Unaffordable build words can be demoted from the board, but should not be
//    removed from the sentence builder... Unfulfillable orders must therefore
//    be refused vocally if the player creates one, with the reason stated."
//
// THE SYMPTOM THESE PIN. `ensureRefineOrders` kept ONE standing refine order
// per refined head for the whole session. A family short of 4 blocks read the
// town's open 198-block workshop bill as `open >= n`, said "milling 4 block for
// the workbench" and posted NOTHING — so a spoken `make workbench` could not
// finish until the town's own growth had milled 198 blocks at REFINE_CREW_CAP
// = 1. One queue, two scopes, the small order always last.
//
// The "before" arm of every A/B below is the TOWN-scope call, which is exactly
// the code path as it shipped: the split is a per-scope key, so passing the
// town key reproduces the old behaviour byte for byte.
//
// No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import { workDoorstep } from "@shared/world-engine/kernel/town/goods.js";
import { TOWN_YARD_EP } from "@shared/world-engine/kernel/town/construction.js";
import { refinedGlyphOf } from "@shared/world-engine/products.js";
import {
  createConstructionDirector,
  REFINE_BATCH_UNITS,
  type ConstructionDirectorCtx,
} from "@shared/world-engine/interaction/quest/construction-director.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import type { TownWork } from "@shared/world-engine/kernel/town/plan.js";
import { REAL_SCALE } from "@shared/world-engine/scale.js";

const CONFIG = { seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 };

const workRow = (type: string, dx: number, dy: number): TownWork =>
  ({ type, dx, dy, w: 10, h: 8, door: "north", color: "#888" });

/** masonry.test.ts's stub harness (the two seams the refinement chain reads),
 *  plus a toast tape — the refusal's HUD half is an assertion here. */
function harness(
  works: TownWork[],
  boxes: Record<string, { at: { x: number; y: number }; stack: Record<string, number> }> = {},
) {
  const play = buildTownPlay(CONFIG);
  (play.plan as { works: TownWork[] }).works = works;
  const toasts: string[] = [];
  const anchors = new Map(Object.entries(boxes).map(([id, b]) => [id, b.at]));
  const session = {
    town: play,
    townClock: 0,
    scale: REAL_SCALE,
    containerRecords: new Map(
      Object.entries(boxes).map(([id, b]) => [
        id,
        { mount: "standing" as const, relation: "in" as const, stock: b.stack, owner: null },
      ]),
    ),
    wornBagIndex: new Map<string, string>(),
    marketStore: new Map<string, unknown>(),
    produceBox: new Map<string, unknown>(),
    houseShown: new Set<number>(),
    transfers: play.deltas.transfers,
    reservations: play.deltas.reservations,
    taskClock: 0,
  } as unknown as QuestSession;
  const ctx = {
    presenter: { toast: (m: string) => { toasts.push(m); } },
    familyOf: () => null,
    npcChatBubble: () => {},
    spawnLooseProp: () => null,
    removeLooseProp: () => {},
    postPooledTask: () => {},
    stockEndpointOf: () => null,
    containerAnchor: (_s: unknown, id: string) => anchors.get(id) ?? null,
    houseContainerKeys: () => [],
    playerWorldPos: () => null,
    playerFocusArea: () => null,
    townShortage: () => 0,
    invalidateTownJobs: () => {},
    questViewOf: () => null,
    spiritFocusOf: () => null,
    convoNodeId: () => null,
    handIsFree: (s: QuestSession, id: string) => !s.npcTasks?.get(id)?.length,
    townHandPool: () => ({ total: play.plan.houses.length, free: play.plan.houses.length }),
  } as unknown as ConstructionDirectorCtx;
  /** Register a container the stub `containerAnchor` can answer for — the
   *  household boxes a real session already has and this fixture does not. */
  const addBox = (id: string, at: { x: number; y: number }, stack: Record<string, number> = {}) => {
    anchors.set(id, at);
    session.containerRecords.set(id, { mount: "standing", relation: "in", stock: stack, owner: null });
  };
  return { play, session, toasts, addBox, director: createConstructionDirector(ctx) };
}

/** The first house of the fixture town — the "family" every household-scope
 *  assertion below belongs to. */
const someHouse = (play: ReturnType<typeof harness>["play"]): number => play.plan.houses[0]!.index;

describe("per-scope order books — a household's mill queue is its own", () => {
  it("🚨 THE SYMPTOM: a 4-block family bill no longer hides behind a 198-block town bill", () => {
    // One town, plenty of wood, and the town's own growth already milling.
    const carpentry = workRow("workshop", -40, -40);
    const { play, session, director } = harness([carpentry], {
      [TOWN_YARD_EP]: { at: { x: 12, y: -7 }, stack: { wood: 500 } },
    });
    const hi = someHouse(play);

    // THE TOWN'S BILL, first — a workshop's ≈198 blocks. What POSTS is one
    // batch of it: REFINE_BATCH_UNITS slices a bill into the delivery cadence
    // (④) and the remainder re-triggers when this row commits. The size of the
    // town's row is not what this test is about; that it is the TOWN's row,
    // and that the family's bill does not hide behind it, is.
    director.ensureRefineOrders(session, { block: 198 });
    expect(play.deltas.refineOrders()).toHaveLength(1);
    expect(play.deltas.refineOrders()[0]!.count).toBe(REFINE_BATCH_UNITS);
    expect(play.deltas.refineOrders()[0]!.scope).toBeUndefined(); // the town book writes no key

    // BEFORE (the town scope — the shipped path): the 4-block bill reads the
    // town's row as its own work in progress and posts nothing.
    const before = director.ensureRefineOrders(session, { block: 4 });
    expect(before).toEqual({ milling: 4, rest: {} });
    expect(play.deltas.refineOrders()).toHaveLength(1);

    // AFTER (the household's own book): a real order, sized to the FAMILY's
    // bill, standing beside the town's and not behind it.
    const after = director.ensureRefineOrders(session, { block: 4 }, undefined, `house:${hi}`);
    expect(after).toEqual({ milling: 4, rest: {} });
    const rows = play.deltas.refineOrders();
    expect(rows).toHaveLength(2);
    const mine = rows.find((r) => r.scope === `house:${hi}`)!;
    expect(mine.count).toBe(4);
    expect(mine.costs).toEqual({ wood: 8 }); // the 2:1 ratio, on the family's bill alone
    // …and the town's row is untouched: no cross-queue priority, either way.
    expect(rows.find((r) => r.scope === undefined)!.count).toBe(REFINE_BATCH_UNITS);
  });

  it("the household mills at its OWN bench, not at the town's shared carpentry", () => {
    const carpentry = workRow("workshop", -40, -40);
    const { play, session, addBox, director } = harness([carpentry], {
      [TOWN_YARD_EP]: { at: { x: 12, y: -7 }, stack: { wood: 40 } },
    });
    const hi = someHouse(play);
    const house = play.plan.houses.find((h) => h.index === hi)!;
    const c = play.stage.center;
    const homeAt = { x: c.x + house.dx + 1, y: c.y + house.dy + 1 };
    // The benchless family's craft container (`craftSpotOf`'s fallback) —
    // present in every real session, absent from this stub until now.
    addBox(`furn_${hi}_cupboard`, homeAt);

    const townSpot = director.refineSpotOf(session, undefined);
    const houseSpot = director.refineSpotOf(session, undefined, `house:${hi}`);
    expect(townSpot).toEqual(workDoorstep(c, carpentry));
    expect(houseSpot).toEqual(homeAt); // its own ground, not the shared queue's
    expect(houseSpot).not.toEqual(townSpot);
    // …and the posted order lands there.
    director.ensureRefineOrders(session, { block: 4 }, undefined, `house:${hi}`);
    expect(play.deltas.refineOrders()[0]!.at).toEqual(homeAt);
  });

  it("no bench and no box of its own ⇒ the town's mill, never nowhere (the no-gate rule)", () => {
    // `at` NEVER GATES (stations.ts:422) survives the split: a household the
    // fixture gives no container falls all the way through the town chain
    // exactly as every raw always did, rather than losing its spot.
    const carpentry = workRow("workshop", -40, -40);
    const { play, session, director } = harness([carpentry]);
    const hi = someHouse(play);
    expect(director.refineSpotOf(session, undefined, `house:${hi}`))
      .toEqual(workDoorstep(play.stage.center, carpentry));
  });

  it("two households are two books — neither reads the other's row as its own", () => {
    const { play, session, director } = harness([workRow("workshop", -40, -40)], {
      [TOWN_YARD_EP]: { at: { x: 12, y: -7 }, stack: { wood: 200 } },
    });
    const a = play.plan.houses[0]!.index;
    const b = play.plan.houses[1]!.index;
    director.ensureRefineOrders(session, { block: 6 }, undefined, `house:${a}`);
    director.ensureRefineOrders(session, { block: 6 }, undefined, `house:${b}`);
    const rows = play.deltas.refineOrders();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.scope).sort()).toEqual([`house:${a}`, `house:${b}`].sort());
    // 🚨 ONE OPEN ROW PER (head, scope) — ②c. A re-ask inside a book that
    // already has a row open posts NOTHING; the chain is the answer and the
    // remainder re-triggers when that row commits. The gate used to be
    // `open >= n`, which topped up — so any shortfall re-posted the remainder
    // every sweep, and the founding homestead ran FOUR concurrent refine rows
    // splitting one 120-block bill, piles at the same spot, porters shuttling
    // the same wood between them forever. The dedup key got a scope in the
    // split; the top-up is gone on purpose.
    expect(director.ensureRefineOrders(session, { block: 6 }, undefined, `house:${a}`))
      .toEqual({ milling: 6, rest: {} });
    expect(play.deltas.refineOrders()).toHaveLength(2);
    // A BIGGER re-ask is no different — an open row is an open row.
    expect(director.ensureRefineOrders(session, { block: 10 }, undefined, `house:${a}`))
      .toEqual({ milling: 10, rest: {} }); // `milling` is what THIS caller is owed…
    expect(play.deltas.refineOrders()).toHaveLength(2);
    expect(
      play.deltas.refineOrders()
        .filter((r) => r.scope === `house:${a}`)
        .reduce((s, r) => s + r.count, 0),
    ).toBe(6); // …not what the book has queued.
  });

  it("the town book is BYTE-IDENTICAL to the pre-split one — no key, same row", () => {
    // The compatibility arm: everything that is not a household still posts
    // exactly the row it always did, so no save round-trips differently.
    const { play, session, director } = harness([workRow("workshop", -40, -40)], {
      [TOWN_YARD_EP]: { at: { x: 12, y: -7 }, stack: { wood: 40 } },
    });
    director.ensureRefineOrders(session, { block: 3 });
    const row = play.deltas.refineOrders()[0]!;
    expect(Object.keys(row)).not.toContain("scope");
    expect(row.produces).toBe(refinedGlyphOf("wood"));
    expect(row.at).toEqual(workDoorstep(play.stage.center, workRow("workshop", -40, -40)));
  });
});

describe("deadBillHeads — SLOW is not DEAD (the refusal's one test)", () => {
  // Law ③ turns on this distinction and nothing else: a bill the world can
  // eventually cover stays a designation that waits honestly ("we still need
  // 272 block"); a bill nothing reachable can even begin is refused aloud.
  const spec = () => ({ costs: { block: 40 } });

  it("a town with WOOD and no blocks is SHORT, never dead — the chain can reach it", () => {
    const { play, session, director } = harness([workRow("workshop", -40, -40)], {
      [TOWN_YARD_EP]: { at: { x: 12, y: -7 }, stack: { wood: 14 } },
    });
    const at = play.stage.center;
    const missing = director.buildMissingMaterials(session, spec(), at);
    expect(missing).toEqual({ block: 40 }); // not one block on hand…
    expect(director.deadBillHeads(session, missing, director.siteMaterialSources(session, at)))
      .toEqual({}); // …and still not a refusal: 14 wood is a mill away
  });

  it("a town with NOTHING is dead, and the refusal names the head", () => {
    const { play, session, director } = harness([workRow("workshop", -40, -40)]);
    const at = play.stage.center;
    const missing = director.buildMissingMaterials(session, spec(), at);
    expect(director.deadBillHeads(session, missing, director.siteMaterialSources(session, at)))
      .toEqual({ block: 40 });
  });

  it("🚨 CONTESTED IS NOT DEAD — a head somebody else has reserved is still alive", () => {
    // The trap the refusal must not fall into: refusing on FREE units would
    // make a spoken order fail because an ambient one reserved first, which is
    // the shared queue wearing a new hat. The test reserves the whole yard.
    const yardAt = { x: 12, y: -7 };
    const { play, session, director } = harness([workRow("workshop", -40, -40)], {
      [TOWN_YARD_EP]: { at: yardAt, stack: { wood: 14 } },
    });
    session.reservations.reserve("someone:else", TOWN_YARD_EP, "wood", 14);
    const at = play.stage.center;
    const missing = director.buildMissingMaterials(session, spec(), at);
    expect(missing).toEqual({ block: 40 });
    expect(director.deadBillHeads(session, missing, director.siteMaterialSources(session, at)))
      .toEqual({});
  });

  it("a head no chain can reach is dead even in a stocked town", () => {
    const { play, session, director } = harness([workRow("workshop", -40, -40)], {
      [TOWN_YARD_EP]: { at: { x: 12, y: -7 }, stack: { wood: 500 } },
    });
    const at = play.stage.center;
    expect(director.deadBillHeads(session, { apple: 2 }, director.siteMaterialSources(session, at)))
      .toEqual({ apple: 2 });
  });
});
