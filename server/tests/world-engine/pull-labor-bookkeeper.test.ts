// ⚖️ PULL-MODEL LABOR (task #51) — THE BOOKKEEPER SIDE, Stage 1.
//
// USER RULING (2026-09-04, near-verbatim): *"The idea of the building issuing
// tasks for individuals feels a little bit awkward… no order is issued per
// person; instead the need exists as a QUANTITY of required materials, like a
// stocking bill. Each individual who has no urgent personal need sees that
// there is an open stocking task (WHICH INCLUDES A FULL CHAIN), determines how
// they can contribute and issues the specific task to themselves."*
//
// So the construction director stops ISSUING and becomes a BOOKKEEPER. This
// file pins the half of that which lives in the director + the town kernel —
// the other half (the reader, the decider, the executors) is `contribute.ts`
// and quest-host, and has its own suite.
//
// What this file pins:
//  ① THE BILL READS ARE THE KERNEL'S NOW. `pileShortfall` and `refineBookOf`
//     were closures inside `createConstructionDirector`, so a BODY could not
//     ask them. Hoisted beside `stagingMissing`, and still exactly the same
//     arithmetic: in-flight netting, the legacy endpoint alias, the ⑤ 1+1
//     ladder split.
//  ② A DONOR PILE'S SURPLUS IS A SOURCE, and lane ③ dissolves into it. With
//     the never-both invariant that makes ping-pong structurally impossible:
//     for ONE head a pile is either short or spare, never the two at once.
//  ③ THE REACH READ NEVER RESERVES. `resolveMaterials` reserves every draw it
//     plans, which under push was paid for by handing the draw to a porter in
//     the same breath. Under pull there is no porter in that breath, so the
//     bookkeeper asks and never takes.
//  ④ PRESENCE IS BY PURSUIT. The old `present` counted bodies whose CLAIMED
//     POOLED TASK named the site — remove the rows without replacing that read
//     and construction silently stops.
//  ⑤ FALSIFICATION — the whole point of the round: under the capability the
//     four staging/labour seats post NOTHING, and off it every one of them
//     posts exactly what it always did.
//
// Pure logic — no DOM / GL / DB. Runs under `npm run test:engine`.

import { describe, it, expect } from "@jest/globals";
import {
  contributeCrewAt,
  createConstructionDirector,
  ORDER_PILE_EP,
  SITE_HAUL_RETRY_S,
  type ConstructionDirectorCtx,
} from "@shared/world-engine/interaction/quest/construction-director.js";
import {
  pileShortfall,
  refineBookOf,
  stagingMissing,
  TOWN_ORDER_SCOPE,
  TOWN_YARD_EP,
  type FoundingCandidate,
  type RefineOrder,
  type TownDeltas,
} from "@shared/world-engine/kernel/town/construction.js";
import { createTaskPool } from "@shared/world-engine/interaction/behavior/task-pool.js";
import { pullLaborOn, type ContributeBill } from "@shared/world-engine/kernel/town/pull-labor.js";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import { BLOCK_GLYPH } from "@shared/world-engine/products.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import type { ContainerRecord } from "@shared/world-engine/kernel/town/containers.js";

const CONFIG = { seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 };
/** The plot every seat test builds on — offset from the stage centre so its
 *  rect and the yard can be placed at a chosen distance from each other. */
const LOT: FoundingCandidate = { type: "house", slot: 3, dx: 10, dy: -20, w: 9, h: 8, door: "south" };
const BILL = 12;

// ═══════════════════════════════════════════════════════════════════════════
// ① THE BILL READS — pure, and now callable by anybody
// ═══════════════════════════════════════════════════════════════════════════

describe("① pileShortfall — the bill BEYOND the stacks and the live hauls", () => {
  const agr = (to: string, status: string, goods: Record<string, number>) => ({ to, status, goods });

  it("subtracts pending AND moving rows aimed at the pile, and nothing else", () => {
    const missing = { [BLOCK_GLYPH]: 20, wood: 5 };
    const rows = [
      agr("orderpile:1", "pending", { [BLOCK_GLYPH]: 8 }),
      agr("orderpile:1", "moving", { [BLOCK_GLYPH]: 4 }),
      // …and three that must NOT count: a finished row (its units already
      // landed and are in the pile the caller measured), a failed one, and a
      // live row aimed somewhere else entirely.
      agr("orderpile:1", "done", { [BLOCK_GLYPH]: 100 }),
      agr("orderpile:1", "failed", { [BLOCK_GLYPH]: 100 }),
      agr("orderpile:2", "pending", { [BLOCK_GLYPH]: 100 }),
    ];
    expect(pileShortfall(rows, { pileId: "orderpile:1", missing })).toEqual({
      [BLOCK_GLYPH]: 8,
      wood: 5,
    });
  });

  it("counts the LEGACY endpoint alias — an adapted save's hauls still pay the bill", () => {
    // A pre-phase-2 agreement targets `sitepile:<ord>`; if the netting missed
    // it the sweep would double-order the same load.
    const rows = [agr("sitepile:1", "moving", { [BLOCK_GLYPH]: 6 })];
    expect(
      pileShortfall(rows, { pileId: "orderpile:1", legacyPileId: "sitepile:1", missing: { [BLOCK_GLYPH]: 10 } }),
    ).toEqual({ [BLOCK_GLYPH]: 4 });
    // …and without the alias the same row is invisible, which is exactly why
    // the option exists.
    expect(pileShortfall(rows, { pileId: "orderpile:1", missing: { [BLOCK_GLYPH]: 10 } })).toEqual({
      [BLOCK_GLYPH]: 10,
    });
  });

  it("folds FACTED variants onto their head and drops a covered head entirely", () => {
    const rows = [agr("orderpile:1", "pending", { "wood.wet": 4, [BLOCK_GLYPH]: 10 })];
    expect(
      pileShortfall(rows, { pileId: "orderpile:1", missing: { wood: 4, [BLOCK_GLYPH]: 12 } }),
    ).toEqual({ [BLOCK_GLYPH]: 2 });
  });

  it("agrees with stagingMissing about a bill — the two arms never disagree", () => {
    const row = { costs: { [BLOCK_GLYPH]: 12, wood: 3 }, pile: { [BLOCK_GLYPH]: 12 } };
    const missing = stagingMissing(row);
    expect(missing).toEqual({ wood: 3 });
    expect(pileShortfall([], { pileId: "orderpile:1", missing })).toEqual({ wood: 3 });
  });
});

describe("① refineBookOf — ONE (head, scope) book, split by ladder phase", () => {
  const row = (over: Partial<RefineOrder>): RefineOrder =>
    ({
      kind: "refine",
      ord: 0,
      produces: BLOCK_GLYPH,
      count: 12,
      costs: { wood: 36 },
      pile: {},
      at: { x: 0, y: 0 },
      startedDay: 0,
      buildDays: 1,
      ...over,
    }) as RefineOrder;
  const deltasOf = (rows: RefineOrder[]): Pick<TownDeltas, "refineOrders"> =>
    ({ refineOrders: () => rows }) as Pick<TownDeltas, "refineOrders">;

  it("splits staging (no laborStartDay) from laboring, and keeps both in rows", () => {
    const gathering = row({ ord: 1 });
    const milling = row({ ord: 2, laborStartDay: 3 });
    const book = refineBookOf(deltasOf([gathering, milling]), BLOCK_GLYPH, TOWN_ORDER_SCOPE);
    expect(book.rows).toHaveLength(2);
    expect(book.staging.map((r) => r.ord)).toEqual([1]);
    expect(book.laboring.map((r) => r.ord)).toEqual([2]);
  });

  it("a row in ANOTHER book is not this book's work — and an absent scope IS the town's", () => {
    const townRow = row({ ord: 1 }); // no `scope` key: the civic book's own shape
    const houseRow = row({ ord: 2, scope: "house:4" });
    const all = deltasOf([townRow, houseRow]);
    expect(refineBookOf(all, BLOCK_GLYPH, TOWN_ORDER_SCOPE).rows.map((r) => r.ord)).toEqual([1]);
    expect(refineBookOf(all, BLOCK_GLYPH, "house:4").rows.map((r) => r.ord)).toEqual([2]);
  });

  it("filters on the produced HEAD, not the glyph", () => {
    const blocks = row({ ord: 1, produces: BLOCK_GLYPH });
    const planks = row({ ord: 2, produces: "plank" });
    expect(refineBookOf(deltasOf([blocks, planks]), BLOCK_GLYPH, TOWN_ORDER_SCOPE).rows).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE DIRECTOR HARNESS — one town, one plot, one yard whose distance to the
// plot is a knob (co-located vs a real walk), and a `wilderness` switch that
// IS the pull capability (a town with a scatter — the text frontier's shape).
// ═══════════════════════════════════════════════════════════════════════════

function harness(opts: { pull: boolean; yardOffsetM?: number }) {
  const play = buildTownPlay(CONFIG);
  const toasts: string[] = [];
  const posted: Array<{ goal: unknown; sourceGlyph: string }> = [];
  const yard: Record<string, number> = { [BLOCK_GLYPH]: 40 };
  /** Site centre — where the plot's rect sits, and what the camera watches. */
  const siteAt = {
    x: play.stage.center.x + LOT.dx + LOT.w / 2,
    y: play.stage.center.y + LOT.dy + LOT.h / 2,
  };
  const yardAt = { x: siteAt.x + (opts.yardOffsetM ?? 30), y: siteAt.y };
  /** `orderpile:<ord>` → its live stack; materialized on first ask, exactly as
   *  the host's own endpoint registry answers one. */
  const piles = new Map<string, Record<string, number>>();
  const session = {
    town: play,
    // ⚖️ THE CAPABILITY, in its Stage-1 shape: a town WITH a wilderness
    // scatter (the text `frontier.spec` young town). The dollhouse — a town
    // with none — is the `pull: false` fixture, and reads false through the
    // same one derivation.
    wilderness: opts.pull ? ({ features: [] } as unknown) : null,
    foundedSite: null,
    townClock: 0,
    taskClock: 0,
    scale: DOLLHOUSE_SCALE,
    containerRecords: new Map<string, ContainerRecord>([
      [TOWN_YARD_EP, { stock: yard, relation: "in", owner: null } as unknown as ContainerRecord],
    ]),
    wornBagIndex: new Map<string, string>(),
    marketStore: new Map<string, unknown>(),
    produceBox: new Map<string, unknown>(),
    houseShown: new Set<number>(),
    transfers: play.deltas.transfers,
    reservations: play.deltas.reservations,
    taskPool: createTaskPool(),
    buildTaskOrds: new Map<string, number>(),
    npcTasks: new Map<string, unknown[]>(),
    needPoseShow: new Map<string, unknown>(),
    pursuits: new Map<string, { tplKey?: string; bill?: ContributeBill }>(),
  } as unknown as QuestSession;
  /** ⚖️ THE ONE-CONTAINER LAW, in the fixture: `orderpile:<ord>`'s endpoint
   *  stack ALIASES the order row's own `pile` map (the host answers it that
   *  way), so what a co-located move writes is what `stagingMissing` reads
   *  back. A pile id with no row behind it gets a throwaway map. */
  const stackOf = (id: string): Record<string, number> => {
    const row = play.deltas
      .orders()
      .find((o) => o.ord === Number(id.slice(ORDER_PILE_EP.length))) as
      | { pile?: Record<string, number> }
      | undefined;
    if (row) return (row.pile ??= {});
    let s = piles.get(id);
    if (!s) piles.set(id, (s = {}));
    return s;
  };
  const ctx = {
    presenter: { toast: (m: string) => { toasts.push(m); } },
    familyOf: () => null,
    avatarIdOf: (cid: string) => cid,
    buildingUnits: () => 0,
    npcChatBubble: () => {},
    spawnLooseProp: () => null,
    removeLooseProp: () => {},
    postPooledTask: (_s: QuestSession, goal: unknown, _i: string, _f: unknown, sourceGlyph: string) => {
      posted.push({ goal, sourceGlyph });
    },
    stockEndpointOf: (_s: QuestSession, id: string) =>
      id === TOWN_YARD_EP
        ? { id, kind: "yard", at: yardAt, stack: yard, owner: null }
        : id.startsWith(ORDER_PILE_EP)
          ? { id, kind: "site", at: siteAt, stack: stackOf(id), owner: null }
          : null,
    containerAnchor: (_s: QuestSession, id: string) => (id === TOWN_YARD_EP ? yardAt : null),
    houseContainerKeys: () => [],
    playerWorldPos: () => siteAt, // the plot is OBSERVED — the rendered-cause arm
    playerFocusArea: () => null,
    townShortage: () => 0,
    invalidateTownJobs: () => {},
    bumpStockEpoch: () => {},
    questViewOf: () => null,
    spiritFocusOf: () => null,
    convoNodeId: () => null,
    issueTransferHaul: () => {},
    handIsFree: () => true,
    townHandPool: () => ({ total: 4, free: 4 }),
    bodyCarryOf: () => ({ hands: null, bags: [] }),
  } as unknown as ConstructionDirectorCtx;
  const director = createConstructionDirector(ctx);
  const avatars: Record<string, { x: number; y: number; fx: number; fy: number }> = {};
  director.setWorld({
    state: { avatars, objects: {}, spec: { objects: [] } },
    npcRadiusOf: () => 0.3,
    npcErrandActive: () => false,
    removeObject: () => {},
    setDragZones: () => {},
  } as never);
  /** Run the founded sweep for `seconds`, one second a sweep. */
  const sweep = (seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      session.taskClock += 1;
      session.townClock += 1;
      director.stepFoundedConstruction(session, 1);
    }
  };
  return { play, session, toasts, posted, yard, piles, siteAt, yardAt, avatars, director, sweep, stackOf };
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ FALSIFICATION — the seats, both ways round
// ═══════════════════════════════════════════════════════════════════════════

describe("the capability itself — ONE derivation, fail-closed", () => {
  it("a town with a wilderness scatter is ON; a town without one is OFF", () => {
    expect(pullLaborOn({ foundedSite: null, town: {}, wilderness: {} })).toBe(true);
    expect(pullLaborOn({ foundedSite: null, town: {}, wilderness: null })).toBe(false);
    // A founded site alone is enough (founding is a MID-SESSION act — which is
    // why every seat re-reads this rather than caching a boot boolean).
    expect(pullLaborOn({ foundedSite: {}, town: null, wilderness: null })).toBe(true);
    // Bare wilderness with no settlement — nature-hike — has no bill at all.
    expect(pullLaborOn({ foundedSite: null, town: null, wilderness: {} })).toBe(false);
  });
});

describe("⑤ seat ④ (staging hauls) + seat ⑧ (buildwork slots)", () => {
  it("OFF the capability the site posts its hauls AND its build-work slots", () => {
    const h = harness({ pull: false });
    h.play.deltas.foundBuilding(LOT, 0, 0.5, { [BLOCK_GLYPH]: BILL });
    h.sweep(1);
    // The bill is short, the yard is 30 m away and stocked ⇒ a real haul, with
    // its agreement and its source reservation.
    expect(h.posted.filter((p) => p.sourceGlyph.startsWith("bring")).length).toBeGreaterThan(0);
    expect(h.session.transfers.all().length).toBeGreaterThan(0);
    expect(h.session.reservations.reservedUnits(TOWN_YARD_EP, BLOCK_GLYPH)).toBeGreaterThan(0);
  });

  it("UNDER the capability it posts NOTHING — no task, no agreement, no reservation", () => {
    const h = harness({ pull: true });
    h.play.deltas.foundBuilding(LOT, 0, 0.5, { [BLOCK_GLYPH]: BILL });
    h.sweep(SITE_HAUL_RETRY_S * 3);
    expect(h.posted).toHaveLength(0);
    expect(h.session.taskPool.open()).toHaveLength(0);
    expect(h.session.transfers.all()).toHaveLength(0);
    // 🚨 THE DEADLOCK THIS AVOIDS: a reservation with no body walking to it.
    expect(h.session.reservations.reservedUnits(TOWN_YARD_EP, BLOCK_GLYPH)).toBe(0);
    // …and the yard is untouched: the bookkeeper moved nothing it could not
    // move as arithmetic.
    expect(h.yard[BLOCK_GLYPH]).toBe(40);
  });

  it("…and a STAGED site posts no build-work slot either, but still keeps its books", () => {
    const off = harness({ pull: false });
    const b0 = off.play.deltas.foundBuilding(LOT, 0, 0.5);
    off.sweep(1);
    expect(off.session.taskPool.open().filter((t) => t.goal.kind === "buildwork").length).toBe(3);
    expect(b0.laborStartDay).toBeDefined();

    const on = harness({ pull: true });
    on.play.deltas.foundBuilding(LOT, 0, 0.5);
    on.sweep(1);
    expect(on.session.taskPool.open().filter((t) => t.goal.kind === "buildwork")).toHaveLength(0);
  });
});

describe("⑤ THE CHAIN still gets ensured — from the sweep, not from a failed draw", () => {
  it("a bill no stock in reach can cover posts its refine order and SAYS it is milling", () => {
    // ⚖️ Item ②. `ensureRefineOrders` used to fire only INSIDE the two haul
    // posters, after `resolveMaterials` came back empty — a chain link
    // materialized as the consequence of a failed draw. Under pull nobody
    // draws, so the trigger is stated positively: shortfall MINUS the free head
    // stock standing within the site's reach. The #50 ⑤ 1+1 bound and the #43
    // anti-runaway law are `ensureRefineOrders`' own and are untouched.
    const h = harness({ pull: true });
    delete h.yard[BLOCK_GLYPH];
    h.yard.wood = 60; // raws, no blocks: only the chain can answer this bill
    const b = h.play.deltas.foundBuilding(LOT, 0, 0.5, { [BLOCK_GLYPH]: BILL });
    (b as { spoken?: boolean }).spoken = true; // a player asked: the mill may draw the reserve
    expect(h.director.freeHeadStockWithinReach(h.session, h.siteAt, BLOCK_GLYPH)).toBe(0);
    h.sweep(1);
    const book = refineBookOf(h.play.deltas, BLOCK_GLYPH, TOWN_ORDER_SCOPE);
    expect(book.rows).toHaveLength(1);
    expect(book.staging).toHaveLength(1); // gathering its raws — the ⑤ ladder's first rung
    expect(h.toasts.filter((t) => t.includes("milling"))).toHaveLength(1);
    // …and it STILL posted nothing: the mill is a bill with its own pile, not
    // an errand handed to anybody.
    expect(h.posted).toHaveLength(0);
    expect(h.session.taskPool.open()).toHaveLength(0);
  });

  it("…and stays QUIET while the stock it needs is standing in reach", () => {
    // Honest waiting is quiet: 40 blocks in the yard is not a chain problem,
    // it is a carrying problem, and carrying is the body's decision now.
    const h = harness({ pull: true });
    h.play.deltas.foundBuilding(LOT, 0, 0.5, { [BLOCK_GLYPH]: BILL });
    h.sweep(SITE_HAUL_RETRY_S * 3);
    expect(h.play.deltas.refineOrders()).toHaveLength(0);
    expect(h.toasts).toHaveLength(0);
  });
});

describe("⑤ the CO-LOCATED move is bookkeeping and survives the capability", () => {
  it("a source shelf ON the site's own spot fills the pile as arithmetic, silently", () => {
    // ⚖️ #50 ②: "the units change column, not place" — that was never a trip
    // and must not become one now. The push path skips the errand here; the
    // pull path must make the same move without one.
    const h = harness({ pull: true, yardOffsetM: 1 });
    const b = h.play.deltas.foundBuilding(LOT, 0, 0.5, { [BLOCK_GLYPH]: BILL });
    h.sweep(1);
    expect(h.posted).toHaveLength(0);
    expect(h.session.transfers.all()).toHaveLength(0);
    // The bill is covered out of the co-located shelf, and CONSERVED: what
    // left the yard is exactly what the pile gained.
    expect(h.yard[BLOCK_GLYPH]).toBe(40 - BILL);
    expect(h.stackOf(`${ORDER_PILE_EP}${b.ord}`)[BLOCK_GLYPH]).toBe(BILL);
    // …and it is SILENT: nothing happened in the world a player can see.
    expect(h.toasts.filter((t) => t.includes("bring"))).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ② DONOR-PILE SURPLUS — lane ③ dissolves into the ordinary supply
// ═══════════════════════════════════════════════════════════════════════════

describe("② a donor pile's SURPLUS is a source, and only its surplus", () => {
  /** Stand a second order up with a stocked pile, and answer its endpoint. */
  function withDonor(pull: boolean, donorCosts: Record<string, number>, donorPile: Record<string, number>) {
    const h = harness({ pull });
    const mine = h.play.deltas.foundBuilding(LOT, 0, 0.5, { [BLOCK_GLYPH]: BILL });
    const donor = h.play.deltas.foundBuilding({ ...LOT, slot: 4, dx: 40 }, 0, 0.5, donorCosts);
    Object.assign(h.stackOf(`${ORDER_PILE_EP}${donor.ord}`), donorPile);
    return { h, mine, donor };
  }

  it("lists the units the donor's OWN bill does not want", () => {
    // 20 blocks held against a 12-block bill ⇒ 8 spare, and 8 is what the
    // supply walk offers.
    const { h, donor } = withDonor(true, { [BLOCK_GLYPH]: 12 }, { [BLOCK_GLYPH]: 20 });
    const src = h.director
      .siteMaterialSources(h.session, h.siteAt)
      .find((s) => s.id === `${ORDER_PILE_EP}${donor.ord}`);
    expect(src).toBeDefined();
    expect(src!.stack[BLOCK_GLYPH]).toBe(8);
  });

  it("🚨 NEVER BOTH — a pile SHORT of a head offers zero of it (ping-pong is impossible)", () => {
    // The same subtraction read in both directions: 5 held against a 12 bill is
    // a 7-block SHORTFALL, therefore a 0-block surplus. There is no arrangement
    // of numbers in which a pile both asks for and offers one head, so units
    // cannot cycle between two piles.
    const { h, donor } = withDonor(true, { [BLOCK_GLYPH]: 12 }, { [BLOCK_GLYPH]: 5 });
    const id = `${ORDER_PILE_EP}${donor.ord}`;
    expect(stagingMissing(donor)[BLOCK_GLYPH]).toBe(7);
    expect(h.director.siteMaterialSources(h.session, h.siteAt).find((s) => s.id === id)).toBeUndefined();
  });

  it("a CO-LOCATED donor pile pays the bill as arithmetic — nobody walks a 0 m leg", () => {
    // ⚖️ ②b, arriving through supply instead of arbitration. `releaseStarvedPile`
    // used to be the only way one pile could hand another its bill; under pull
    // the surplus is an ordinary source, and when the two heaps stand on the
    // same spot the units change COLUMN, not place. A puller must never be
    // sent to walk that.
    const { h, mine, donor } = withDonor(true, { [BLOCK_GLYPH]: 12 }, { [BLOCK_GLYPH]: 20 });
    h.sweep(1);
    expect(h.posted).toHaveLength(0);
    expect(h.session.transfers.all()).toHaveLength(0);
    // The donor's 8 spare blocks move; its own 12 stay put.
    expect(h.stackOf(`${ORDER_PILE_EP}${donor.ord}`)[BLOCK_GLYPH]).toBe(12);
    expect(h.stackOf(`${ORDER_PILE_EP}${mine.ord}`)[BLOCK_GLYPH]).toBe(8);
  });

  it("OFF the capability no pile is a source at all — a plot never raids another plot's heap", () => {
    const { h, donor } = withDonor(false, { [BLOCK_GLYPH]: 12 }, { [BLOCK_GLYPH]: 20 });
    const id = `${ORDER_PILE_EP}${donor.ord}`;
    expect(h.director.siteMaterialSources(h.session, h.siteAt).find((s) => s.id === id)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ THE REACH READ NEVER RESERVES
// ═══════════════════════════════════════════════════════════════════════════

describe("③ freeHeadStockWithinReach — a question, never a claim", () => {
  it("counts the free units in reach and leaves the ledger exactly as it found it", () => {
    const h = harness({ pull: true });
    const before = JSON.stringify(h.session.reservations.toJSON());
    expect(h.director.freeHeadStockWithinReach(h.session, h.siteAt, BLOCK_GLYPH)).toBe(40);
    expect(JSON.stringify(h.session.reservations.toJSON())).toBe(before);
    expect(h.session.reservations.reservedUnits(TOWN_YARD_EP, BLOCK_GLYPH)).toBe(0);
  });

  it("…and it subtracts what somebody else has already spoken for", () => {
    const h = harness({ pull: true });
    h.session.reservations.reserve("agr:test", TOWN_YARD_EP, BLOCK_GLYPH, 15);
    expect(h.director.freeHeadStockWithinReach(h.session, h.siteAt, BLOCK_GLYPH)).toBe(25);
    // Reading it twice answers the same number — a read that reserved would
    // count itself out the second time round.
    expect(h.director.freeHeadStockWithinReach(h.session, h.siteAt, BLOCK_GLYPH)).toBe(25);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ PRESENCE BY PURSUIT
// ═══════════════════════════════════════════════════════════════════════════

describe("④ contributeCrewAt — who is working this site's bill", () => {
  const bill = (over: Partial<ContributeBill>): ContributeBill => ({
    siteId: "o:1",
    link: "build",
    spoken: false,
    issuer: "__player__",
    ...over,
  });
  const pursuits = (rows: Array<[string, { tplKey?: string; bill?: ContributeBill }]>) => new Map(rows);

  it("counts the two DWELL links at this site, sorted by cid", () => {
    const p = pursuits([
      ["settler_1", { tplKey: "contribute", bill: bill({ link: "build" }) }],
      ["resident_2_0", { tplKey: "contribute", bill: bill({ link: "refine" }) }],
    ]);
    expect(contributeCrewAt(p, "o:1")).toEqual(["resident_2_0", "settler_1"]);
  });

  it("🚨 a HAUL for the same site is contribution but NOT labour at the bench", () => {
    // Its work is the trip. Counting it would bank build-days for somebody
    // walking a road.
    const p = pursuits([
      ["settler_1", { tplKey: "contribute", bill: bill({ link: "haul", head: "wood", units: 8 }) }],
      ["settler_2", { tplKey: "contribute", bill: bill({ link: "fell", head: "wood" }) }],
    ]);
    expect(contributeCrewAt(p, "o:1")).toEqual([]);
  });

  it("another site's bill, a plain need pursuit and a bill-less pursuit all count for nothing", () => {
    const p = pursuits([
      ["settler_1", { tplKey: "contribute", bill: bill({ siteId: "o:9" }) }],
      ["settler_2", { tplKey: "rest", bill: bill({}) }],
      ["settler_3", { tplKey: "contribute" }],
      ["settler_4", {}],
    ]);
    expect(contributeCrewAt(p, "o:1")).toEqual([]);
  });

  it("the sweep banks labour for a body standing at the work WITH a bill, and none without", () => {
    const h = harness({ pull: true });
    const b = h.play.deltas.foundBuilding(LOT, 0, 0.5); // no costs ⇒ straight to labour
    h.sweep(1);
    expect(b.laborStartDay).toBeDefined();
    const banked0 = b.labor ?? 0;

    // A body standing exactly at the work, with NO pursuit: it is a passer-by.
    h.avatars["settler_0"] = { x: h.siteAt.x, y: h.siteAt.y, fx: 1, fy: 0 };
    h.sweep(1);
    const banked1 = b.labor ?? 0;

    // …the same body, now working the site's own bill. Written through the
    // `ContributePursuitLike` shape on purpose: `tplKey` + `bill` is the WHOLE
    // of what the bookkeeper reads off a pursuit (the director never imports
    // quest-host's `Pursuit`), so the fixture states exactly that contract.
    const pursuits = h.session.pursuits as unknown as Map<
      string,
      { tplKey?: string; bill?: ContributeBill }
    >;
    pursuits.set("settler_0", {
      tplKey: "contribute",
      bill: bill({ siteId: h.director.orderSiteId(b.ord) }),
    });
    h.sweep(1);
    const banked2 = b.labor ?? 0;
    expect(banked2 - banked1).toBeGreaterThan(banked1 - banked0);
    expect(h.session.needPoseShow.get("settler_0")).toBeDefined();
  });
});
