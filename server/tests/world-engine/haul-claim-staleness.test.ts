// 🚨 A CLAIM IS NOT A CARRIER (2026-08-13) — the HAUL twin of the build-work
// claim rule (`claimStale` in the director's `workSite`, pinned by
// civic-labor-locality).
//
// THE DEFECT, measured in text mode (frontier seed 12, spoken `build farm`,
// dt 0.5): the farm's pile climbed 0 → 102 of a 272-block bill and then went
// permanently quiet for the remaining 3 000 sim-seconds, with ~200 blocks
// standing in the town yard (170 of them spoken for by the row below, 26 of
// them plainly free). The probe found ONE agreement behind it —
// `agr_42`, status `moving`, 170 blocks, executor `resident_24_1`, carried {},
// the body frozen on one spot for 1 400 s with `npcErrandActive` TRUE and one
// queued step. Nothing could retire it:
//
//   • the pool never expires a CLAIMED task (`expire` only walks OPEN rows),
//     and the FILLED→DONE sweep completes a transfer task off the AGREEMENT's
//     status — which was `moving`;
//   • the staging sweep's re-aim needs the body to hold neither errand nor
//     queued step, and this one held both;
//   • `twinResolveHauls` runs on the UNOBSERVED arm only, and deliberately
//     skips a carrier inside the observation reach;
//   • so `pileShortfall` — which subtracts every pending/moving row's goods —
//     answered the 170-block shortfall with {} and `postPileHauls` posted
//     nothing, forever.
//
// What this file pins:
//  ① A MOVING row whose carrier does not MOVE for one CLAIM WINDOW is failed
//     `no-executor`, and BOTH its claims (source units, basket) are released.
//  ② WALKING IS MOTION, not the errand flag: a body that steps each sweep keeps
//     its haul however long the trip takes.
//  ③ A LOADED row is never retired — the goods are on the body.
//  ④ CONSERVATION: the expiry moves no goods. The source stack is untouched and
//     the freed units become drawable again exactly once.
//
// Pure logic — no DOM / GL / DB.

import { describe, it, expect } from "@jest/globals";
import {
  createConstructionDirector,
  type ConstructionDirectorCtx,
} from "@shared/world-engine/interaction/quest/construction-director.js";
import { createTaskPool, DEFAULT_TASK_TTL_S } from "@shared/world-engine/interaction/behavior/task-pool.js";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import { TOWN_YARD_EP } from "@shared/world-engine/kernel/town/construction.js";
import { BLOCK_GLYPH } from "@shared/world-engine/products.js";
import { REAL_SCALE } from "@shared/world-engine/scale.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import type { ContainerRecord } from "@shared/world-engine/kernel/town/containers.js";

const CONFIG = { seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 };
const PILE = "orderpile:0";
const PORTER = "porter_1";
const YARD_AT = { x: 0, y: 0 };
const PILE_AT = { x: 30, y: 0 };
/** The bill one haul spoke for — the shape of the defect: ONE row draws the
 *  whole remaining shortfall, so ONE dead row hides the whole bill. */
const LOAD = 10;

function harness() {
  const play = buildTownPlay(CONFIG);
  const toasts: string[] = [];
  /** The yard's live stack — the thing conservation is asserted against. */
  const yard: Record<string, number> = { [BLOCK_GLYPH]: 40 };
  const body = { x: 5, y: 5 };
  const session = {
    town: play,
    townClock: 0,
    taskClock: 0,
    scale: REAL_SCALE,
    containerRecords: new Map<string, ContainerRecord>([[TOWN_YARD_EP, { stock: yard } as ContainerRecord]]),
    wornBagIndex: new Map<string, string>(),
    marketStore: new Map<string, unknown>(),
    produceBox: new Map<string, unknown>(),
    houseShown: new Set<number>(),
    transfers: play.deltas.transfers,
    reservations: play.deltas.reservations,
    taskPool: createTaskPool(),
    buildTaskOrds: new Map<string, number>(),
    npcTasks: new Map<string, unknown[]>([[PORTER, [{}]]]), // a queued step: the re-aim is blocked
    needPoseShow: new Map<string, unknown>(),
  } as unknown as QuestSession;
  const ctx = {
    presenter: { toast: (m: string) => { toasts.push(m); } },
    familyOf: () => null,
    avatarIdOf: (cid: string) => cid,
    buildingUnits: () => 0,
    npcChatBubble: () => {},
    spawnLooseProp: () => null,
    removeLooseProp: () => {},
    postPooledTask: () => {},
    stockEndpointOf: (_s: QuestSession, id: string) =>
      id === TOWN_YARD_EP
        ? { id, kind: "yard", at: YARD_AT, stack: yard, owner: null }
        : id === PILE
          ? { id, kind: "site", at: PILE_AT, stack: {}, owner: null }
          : null,
    containerAnchor: () => null,
    houseContainerKeys: () => [],
    playerWorldPos: () => null,
    playerFocusArea: () => null,
    townShortage: () => 0,
    invalidateTownJobs: () => {},
    questViewOf: () => null,
    spiritFocusOf: () => null,
    convoNodeId: () => null,
    issueTransferHaul: () => { throw new Error("the re-aim must not fire: the body holds a queued step"); },
    handIsFree: () => true,
    townHandPool: () => ({ total: 1, free: 1 }),
    bodyCarryOf: () => ({ hands: null, bags: [] }),
  } as unknown as ConstructionDirectorCtx;
  const director = createConstructionDirector(ctx);
  // A body with a LIVE ERRAND that never advances — the measured shape of the
  // stall. `npcErrandActive` true is exactly what made the errand flag useless
  // as a liveness signal.
  director.setWorld({
    state: { avatars: { [PORTER]: body }, objects: {}, spec: { objects: [] } },
    npcRadiusOf: () => 0.3,
    npcErrandActive: () => true,
    removeObject: () => {},
    setDragZones: () => {},
  } as never);
  return { play, session, toasts, yard, body, director };
}

/** Post the pile haul the way `postPileHauls` does — agreement + the source
 *  reservation that rides it — and let a porter claim it. */
function claimedHaul(h: ReturnType<typeof harness>) {
  const a = h.session.transfers.post({
    from: TOWN_YARD_EP,
    to: PILE,
    goods: { [BLOCK_GLYPH]: LOAD },
    issuer: "__player__",
    mode: "haul",
    now: h.session.taskClock,
    sourceGlyph: `bring ${LOAD} ${BLOCK_GLYPH}`,
  });
  h.session.reservations.reserve(h.director.agrHolder(a.id), TOWN_YARD_EP, BLOCK_GLYPH, LOAD);
  expect(h.session.transfers.begin(a.id, PORTER)).toBe(true);
  return a;
}

/** Run the staging sweep for `seconds` of task clock, one second a sweep (the
 *  sweep's own cadence), stepping the body by `stepM` each time. */
function sweep(h: ReturnType<typeof harness>, seconds: number, stepM = 0) {
  for (let i = 0; i < seconds; i++) {
    h.session.taskClock += 1;
    h.body.x += stepM;
    h.director.stepFoundedConstruction(h.session, 1);
  }
}

describe("① a haul whose carrier stops WALKING is retired after one claim window", () => {
  it("fails no-executor, releases both claims, and says so — once", () => {
    const h = harness();
    const a = claimedHaul(h);
    const reserved = () => h.session.reservations.reservedUnits(TOWN_YARD_EP, BLOCK_GLYPH);
    expect(reserved()).toBe(LOAD);

    // WITHIN the window the promise stands — a claimant gets one whole window
    // to get going, exactly as a build-work claim does.
    sweep(h, DEFAULT_TASK_TTL_S - 2);
    expect(h.session.transfers.get(a.id)!.status).toBe("moving");
    expect(reserved()).toBe(LOAD);
    expect(h.toasts).toHaveLength(0);

    // PAST it, the row is dead.
    sweep(h, 4);
    const dead = h.session.transfers.get(a.id)!;
    expect(dead.status).toBe("failed");
    expect(dead.failReason).toBe("no-executor");
    expect(reserved()).toBe(0);
    expect(h.toasts.filter((t) => t.includes("nobody came"))).toHaveLength(1);

    // ④ CONSERVATION: nothing moved. The yard still holds every block, the
    // pile got none, and the freed units are drawable again — exactly once
    // (the release is idempotent; further sweeps cannot free them twice).
    expect(h.yard[BLOCK_GLYPH]).toBe(40);
    sweep(h, 10);
    expect(reserved()).toBe(0);
    expect(h.toasts.filter((t) => t.includes("nobody came"))).toHaveLength(1);
  });
});

describe("② WALKING IS MOTION — a moving body keeps its haul however long the trip", () => {
  it("a carrier that steps every sweep is never retired", () => {
    const h = harness();
    const a = claimedHaul(h);
    // Four whole windows of honest walking.
    sweep(h, DEFAULT_TASK_TTL_S * 4, 0.5);
    expect(h.session.transfers.get(a.id)!.status).toBe("moving");
    expect(h.session.reservations.reservedUnits(TOWN_YARD_EP, BLOCK_GLYPH)).toBe(LOAD);
    expect(h.toasts).toHaveLength(0);
  });

  it("…and a body that stops MID-TRIP is retired even though its errand stays active", () => {
    // The measured case: `npcErrandActive` says a trip was ORDERED, never that
    // anyone is making it. The world stub answers true throughout.
    const h = harness();
    const a = claimedHaul(h);
    sweep(h, 20, 0.5); // walks…
    expect(h.session.transfers.get(a.id)!.status).toBe("moving");
    sweep(h, DEFAULT_TASK_TTL_S + 2); // …then stands still
    expect(h.session.transfers.get(a.id)!.status).toBe("failed");
  });
});

describe("③ a LOADED haul is never retired — the goods are on the body", () => {
  it("a frozen carrier holding the load keeps its row (the twin's own split)", () => {
    const h = harness();
    const a = claimedHaul(h);
    // The load left the yard and rides the porter (what `issueTransferHaul`
    // records at the pick-up leg).
    h.yard[BLOCK_GLYPH] = 40 - LOAD;
    h.session.reservations.consume(h.director.agrHolder(a.id), TOWN_YARD_EP, BLOCK_GLYPH, LOAD);
    h.session.transfers.load(a.id, { [BLOCK_GLYPH]: LOAD });

    sweep(h, DEFAULT_TASK_TTL_S * 3);
    const row = h.session.transfers.get(a.id)!;
    expect(row.status).toBe("moving");
    expect(row.carried).toEqual({ [BLOCK_GLYPH]: LOAD });
    // …and nothing was minted to replace it: the yard is still short by the
    // armful the porter is holding, never topped back up by the sweep.
    expect(h.yard[BLOCK_GLYPH]).toBe(40 - LOAD);
    expect(h.toasts).toHaveLength(0);
  });
});
