// THE TOWN'S LABOUR POOL IS FINITE (economy arc, batch 2 — L4)
//
// The free lunch this closes, verbatim from the survey: `availableCrew` read
// `if (session.town) return BUILDERS_CAP` — EVERY open site was told three
// builders, unconditionally — and `clockArm` banked `laborRatePerS(...)` PER
// SITE ROW. Ten sites therefore banked THIRTY builder-equivalents out of a
// town of twelve residents, so a settlement could out-build its own
// population simply by opening more sites. That is the opposite of what a
// labour constraint means.
//
// What this file pins, at the DIRECTOR (the seat that banks):
//  ① ONE SITE, HANDS TO SPARE IS BYTE-IDENTICAL — the acceptance criterion.
//     It banks exactly `elapsed × CLOCK_SCHEDULE_RATE × BUILDERS_CAP /
//     dayLengthS`, which is what the constant produced.
//  ② TEN SITES SHARE ONE POOL — Σ banked is the POOL's rate, not ten crews',
//     and it does NOT grow when you open more sites.
//  ③ THE SPLIT IS THE ALLOCATOR'S — deterministic, conserving, capped.
//  ④ OFF A TOWN NOTHING MOVED — the wilderness arm still counts bodies.
//
// Pure logic — no DOM / GL / DB. The pool itself is the harness's knob
// (the host's own reading is pinned in scope-shape.test.ts).

import { describe, it, expect } from "@jest/globals";
import { createTaskPool } from "@shared/world-engine/interaction/behavior/task-pool.js";
import {
  BUILDERS_CAP,
  createConstructionDirector,
  type ConstructionDirectorCtx,
} from "@shared/world-engine/interaction/quest/construction-director.js";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import type { FoundingCandidate } from "@shared/world-engine/kernel/town/construction.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import { CLOCK_SCHEDULE_RATE } from "@shared/world-engine/npc-controller.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";

const CONFIG = { seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 };

/** The director's own rate, restated: what ONE tick of `elapsedS` banks for
 *  `crew` abstract builders on the schedule arm. */
const bankedFor = (crew: number, elapsedS: number) =>
  elapsedS * CLOCK_SCHEDULE_RATE * (Math.min(BUILDERS_CAP, Math.max(0, crew)) / DOLLHOUSE_SCALE.dayLengthS);

/** A director over the smalltown fixture with the town's free hands as a
 *  KNOB. Nothing is observed (no player, no view, no spirit focus), so every
 *  site runs on the clock arm — which is the arm that used to mint. */
function harness(freeHands: number, inTown = true) {
  const play = buildTownPlay(CONFIG);
  const session = {
    town: inTown ? play : null,
    foundedSite: inTown ? null : { deltas: play.deltas },
    townClock: 0,
    taskClock: 0,
    scale: DOLLHOUSE_SCALE,
    containerStock: new Map<string, Record<string, number>>(),
    containers: new Map<string, "in" | "on">(),
    containerOwner: new Map<string, string | null>(),
    marketStore: new Map<string, unknown>(),
    produceBox: new Map<string, unknown>(),
    houseShown: new Set<number>(),
    transfers: play.deltas.transfers,
    reservations: play.deltas.reservations,
    taskPool: createTaskPool(),
    buildTaskOrds: new Map<string, number>(),
    npcTasks: new Map<string, unknown[]>(),
    needPoseShow: new Map<string, unknown>(),
    party: new Set<string>(),
    escorting: new Set<string>(),
    creatures: null,
  } as unknown as QuestSession;
  const ctx = {
    presenter: { toast: () => {} },
    familyOf: () => null,
    buildingUnits: () => 0,
    npcChatBubble: () => {},
    spawnLooseProp: () => null,
    removeLooseProp: () => {},
    postPooledTask: () => {},
    stockEndpointOf: () => null,
    containerAnchor: () => null,
    houseContainerKeys: () => [],
    playerWorldPos: () => null,
    playerFocusArea: () => null,
    townShortage: () => 0,
    invalidateTownJobs: () => {},
    questViewOf: () => null,
    spiritFocusOf: () => null,
    convoNodeId: () => null,
    handIsFree: (s: QuestSession, id: string) => !s.npcTasks?.get(id)?.length,
    townHandPool: () => ({ total: freeHands, free: freeHands }),
  } as unknown as ConstructionDirectorCtx;
  return { play, session, director: createConstructionDirector(ctx) };
}

/** `n` staked lots on distinct street slots, each a long build so none of
 *  them completes mid-measurement. */
function stakeSites(play: ReturnType<typeof buildTownPlay>, n: number) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const lot: FoundingCandidate = {
      type: "house",
      slot: 3 + i,
      dx: 10 + i * 20,
      dy: -20,
      w: 9,
      h: 8,
      door: "south",
    };
    out.push(play.deltas.foundBuilding(lot, 0, 50));
  }
  return out;
}

/** Total build-days banked across the staked rows. */
const banked = (rows: ReadonlyArray<{ labor?: number }>) =>
  rows.reduce((s, b) => s + (b.labor ?? 0), 0);

// ─────────────────────────────────────────────────────────────────────────
// ① and ② — the acceptance criteria, measured
// ─────────────────────────────────────────────────────────────────────────

describe("the abstract crew is drawn from the town's pool, not minted per site", () => {
  it("ONE site with hands to spare banks exactly what BUILDERS_CAP always banked", () => {
    const { play, session, director } = harness(20);
    const [b] = stakeSites(play, 1);
    director.stepFoundedConstruction(session, 1); // adopt + stage, banks 0
    const before = b!.labor ?? 0;
    session.townClock += 1;
    director.stepFoundedConstruction(session, 1);
    expect((b!.labor ?? 0) - before).toBeCloseTo(bankedFor(BUILDERS_CAP, 1), 12);
  });

  it("🚨 TEN sites out of a THREE-hand town bank THREE builders between them", () => {
    const { play, session, director } = harness(3);
    const rows = stakeSites(play, 10);
    director.stepFoundedConstruction(session, 1);
    const before = banked(rows);
    session.townClock += 1;
    director.stepFoundedConstruction(session, 1);
    // The measured number: Σ over ten sites of their SHARE — 0.3 builders
    // each — which sums to the three hands the town actually has. Before the
    // fix this was ten × 3 = thirty builder-equivalents.
    expect(banked(rows) - before).toBeCloseTo(bankedFor(3, 1) , 12);
  });

  it("📏 BEFORE vs AFTER, measured in one run: 10× the pool, or the pool", () => {
    // A pool of 30 hands gives every one of ten sites its full BUILDERS_CAP —
    // which is EXACTLY what `if (session.town) return BUILDERS_CAP` produced
    // for any town at all. A pool of 3 is the same ten sites in a town that
    // actually has three spare hands. The ratio is the free lunch, weighed.
    const rateAt = (freeHands: number) => {
      const { play, session, director } = harness(freeHands);
      const rows = stakeSites(play, 10);
      director.stepFoundedConstruction(session, 1);
      const before = banked(rows);
      session.townClock += 1;
      director.stepFoundedConstruction(session, 1);
      return banked(rows) - before;
    };
    const shipped = rateAt(10 * BUILDERS_CAP); // the old constant, reproduced
    const pooled = rateAt(3);
    expect(shipped).toBeCloseTo(bankedFor(BUILDERS_CAP, 1) * 10, 12);
    expect(pooled).toBeCloseTo(bankedFor(3, 1), 12);
    expect(shipped / pooled).toBeCloseTo(10, 9);
  });

  it("…and opening MORE sites does not make the town build faster", () => {
    const rate = (sites: number) => {
      const { play, session, director } = harness(6);
      const rows = stakeSites(play, sites);
      director.stepFoundedConstruction(session, 1);
      const before = banked(rows);
      session.townClock += 1;
      director.stepFoundedConstruction(session, 1);
      return banked(rows) - before;
    };
    // Two sites already saturate a six-hand pool (2 × BUILDERS_CAP), so the
    // town's total build rate is FLAT from there on. The old code's rate grew
    // linearly with the number of holes in the ground.
    expect(rate(4)).toBeCloseTo(rate(2), 12);
    expect(rate(10)).toBeCloseTo(rate(2), 12);
    expect(rate(1)).toBeLessThan(rate(2)); // …and one site still cannot use six hands
  });

  it("a town with NO free hands banks nothing on the clock arm — honestly stalled", () => {
    const { play, session, director } = harness(0);
    const rows = stakeSites(play, 3);
    director.stepFoundedConstruction(session, 1);
    const before = banked(rows);
    session.townClock += 1;
    director.stepFoundedConstruction(session, 1);
    expect(banked(rows) - before).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ③ — the split itself
// ─────────────────────────────────────────────────────────────────────────

describe("the split across sites", () => {
  it("is deterministic — the same town banks the same way twice", () => {
    const run = () => {
      const { play, session, director } = harness(5);
      const rows = stakeSites(play, 4);
      for (let i = 0; i < 4; i++) {
        session.townClock += 1;
        director.stepFoundedConstruction(session, 1);
      }
      return rows.map((b) => b.labor ?? 0);
    };
    expect(run()).toEqual(run());
  });

  it("no site is starved to zero by being late in the founding order", () => {
    const { play, session, director } = harness(5);
    const rows = stakeSites(play, 4);
    for (let i = 0; i < 4; i++) {
      session.townClock += 1;
      director.stepFoundedConstruction(session, 1);
    }
    // The even FLOOR first, then the remainder poured in order — so the last
    // lot is working, just more slowly than the first.
    expect(rows.every((b) => (b.labor ?? 0) > 0)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ④ — the wilderness arm
// ─────────────────────────────────────────────────────────────────────────

describe("off a town nothing changed", () => {
  it("a founded SITE with no town has no pool to share — the body count still rules", () => {
    // No town ⇒ `availableCrew` walks the willing/ambient bodies exactly as
    // it always did, and with no world attached that is nobody.
    const { play, session, director } = harness(99, false);
    const rows = stakeSites(play, 2);
    director.stepFoundedConstruction(session, 1);
    const before = banked(rows);
    session.townClock += 1;
    director.stepFoundedConstruction(session, 1);
    expect(banked(rows) - before).toBe(0);
  });
});
