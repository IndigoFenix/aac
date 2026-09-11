/**
 * ⚖️ SKILLS AT THE DIRECTOR'S BANKING SEAT (skill-learning-round.md §3.3).
 *
 * The seat: `construction-director.ts` `workSite` — the OBSERVED arm used to
 * bank `elapsedS × laborRatePerS(session, min(cap, present), cap)` where
 * `present` is a HEAD COUNT. It now banks the crew's SKILL SUM: one novice
 * banks `1 / dayLengthS` build-days a second (unchanged, which is what keeps
 * day one byte-identical), and a body at multiplier `m` banks `m` of them. The
 * clamp is still the row's SEATS, so competence buys speed per seat and never
 * an extra seat.
 *
 * And the same sweep CREDITS the practice: every body that actually stood at
 * the work gains the sweep's own elapsed seconds — the METABOLIC clock, never
 * divided by `dayLengthS` (that factor is `laborRatePerS`'s own, and it turns
 * seconds into BUILD-DAYS; a practice second is a second).
 *
 * What this file pins:
 *  ① 🚨 A NOVICE CREW BANKS EXACTLY WHAT IT ALWAYS BANKED — the falsification.
 *  ② A PRACTISED BUILDER BANKS `m×` — measured as the ratio between two arms of
 *    one world, with `m` read from the kernel rather than typed in.
 *  ③ PRACTICE ACCRUES AT THE SECONDS SPENT, and inherits up to `labour` at ½.
 *  ④ 🚫 A BODY THAT IS NOT AT THE WORK BANKS AND LEARNS NOTHING.
 *
 * Pure logic — no DOM / GL / DB. The world is a stub with avatars in it, which
 * is all the observed arm reads. `npm run test:engine -- skills`.
 */
import { describe, it, expect } from "@jest/globals";
import { createTaskPool } from "@shared/world-engine/interaction/behavior/task-pool.js";
import {
  createConstructionDirector,
  type ConstructionDirectorCtx,
} from "@shared/world-engine/interaction/quest/construction-director.js";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import type { FoundingCandidate } from "@shared/world-engine/kernel/town/construction.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import type { ContainerRecord } from "@shared/world-engine/kernel/town/containers.js";
import { CONTRIBUTE_TPL_KEY } from "@shared/world-engine/kernel/town/pull-labor.js";
import {
  DEFAULT_SKILL_CATALOGUE,
  INHERIT_SHARE,
  practiceSkill,
  skillMultiplier,
  type BodySkillRow,
} from "@shared/world-engine/kernel/town/skills.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";

const CONFIG = { seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 };
const LOT: FoundingCandidate = { type: "house", slot: 3, dx: 10, dy: -20, w: 9, h: 8, door: "south" };
const BUILDER = "resident_0_0";
const npcOf = (cid: string) => `npc_${cid}`;

interface Harness {
  session: QuestSession;
  director: ReturnType<typeof createConstructionDirector>;
  row: { ord: number; labor?: number };
  /** Walk the sweep `n` seconds and return what the row banked. */
  bankOver(n: number): number;
}

/**
 * A town with ONE staked lot, ONE body standing on it holding a contribute
 * pursuit for that site, and the player watching it — which is the whole of
 * what the observed arm needs to fire.
 */
function harness(opts: { atWork?: boolean } = {}): Harness {
  const play = buildTownPlay(CONFIG);
  const c = play.stage.center;
  const lotAt = { x: c.x + LOT.dx + LOT.w / 2, y: c.y + LOT.dy + LOT.h / 2 };
  // At the work, or a hundred metres off it (④'s falsification).
  const bodyAt = opts.atWork === false ? { x: lotAt.x + 100, y: lotAt.y } : { ...lotAt };

  const avatars: Record<string, { x: number; y: number; fx: number; fy: number }> = {
    [npcOf(BUILDER)]: { ...bodyAt, fx: 0, fy: 1 },
  };

  const session = {
    town: play,
    // 🚨 THE CAPABILITY: `pullLaborOn` needs a town AND a wilderness, so the
    // director takes the pull arm and "who is staffing this" becomes a question
    // about bodies rather than about pool rows.
    wilderness: { features: [] } as unknown,
    foundedSite: null,
    townClock: 0,
    taskClock: 0,
    scale: DOLLHOUSE_SCALE,
    containerRecords: new Map<string, ContainerRecord>(),
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
    party: new Set<string>(),
    escorting: new Set<string>(),
    creatures: null,
    pursuits: new Map<string, unknown>(),
    bodySkills: new Map<string, Map<string, BodySkillRow>>(),
    skills: DEFAULT_SKILL_CATALOGUE,
  } as unknown as QuestSession;

  const ctx = {
    presenter: { toast: () => {} },
    familyOf: () => null,
    avatarIdOf: npcOf,
    buildingUnits: () => 0,
    npcChatBubble: () => {},
    spawnLooseProp: () => null,
    removeLooseProp: () => {},
    postPooledTask: () => {},
    stockEndpointOf: () => null,
    containerAnchor: () => null,
    houseContainerKeys: () => [],
    // THE PLAYER IS WATCHING THE LOT — which is what makes `observedRect` true
    // and puts the sweep on the observed arm rather than the clock arm.
    playerWorldPos: () => lotAt,
    playerFocusArea: () => null,
    townShortage: () => 0,
    invalidateTownJobs: () => {},
    questViewOf: () => null,
    spiritFocusOf: () => null,
    convoNodeId: () => null,
    handIsFree: () => true,
    townHandPool: () => ({ total: 20, free: 20 }),
  } as unknown as ConstructionDirectorCtx;

  const director = createConstructionDirector(ctx);
  director.setWorld({
    state: { avatars },
    npcRadiusOf: () => 0.4,
    npcErrandActive: () => true,
    setNpcErrand: () => {},
  } as never);

  const row = play.deltas.foundBuilding(LOT, 0, 50) as unknown as { ord: number; labor?: number };
  // Adopt + stage (banks nothing), then declare the body a contributor at the
  // row's own site id — the exact string `workSite` counts presence with.
  director.stepFoundedConstruction(session, 1);
  session.pursuits.set(BUILDER, {
    source: "need",
    tplKey: CONTRIBUTE_TPL_KEY,
    goal: { kind: "buildwork", site: `o:${row.ord}` },
    glyph: "build",
    bill: { siteId: `o:${row.ord}`, link: "build", spoken: false, issuer: "town" },
  } as never);

  const bankOver = (n: number): number => {
    const before = row.labor ?? 0;
    session.townClock += n;
    session.taskClock += n;
    director.stepFoundedConstruction(session, n);
    return (row.labor ?? 0) - before;
  };

  return { session, director, row, bankOver };
}

const practiceOf = (s: QuestSession, cid: string, key: string): number =>
  s.bodySkills.get(cid)?.get(key)?.practiceS ?? 0;

describe("the observed crew banks its SKILL SUM, not its head count", () => {
  it("① 🚨 a NOVICE banks exactly one hand's rate — day one is unmoved", () => {
    const h = harness();
    expect(skillMultiplier(h.session, BUILDER, "building")).toBe(1);
    const banked = h.bankOver(1);
    // ONE novice at `laborRatePerS` = 1 / dayLengthS build-days a second.
    expect(banked).toBeCloseTo(1 / DOLLHOUSE_SCALE.dayLengthS, 12);
  });

  it("② 📏 a PRACTISED builder banks m× — the same world, the same second", () => {
    const green = harness();
    const novice = green.bankOver(1);
    expect(novice).toBeGreaterThan(0);

    const skilled = harness();
    // Enough practice to be visibly better, and read from the kernel rather
    // than asserted: whatever the curve says, the bank must match it.
    practiceSkill(skilled.session, BUILDER, "building", 20_000);
    const m = skillMultiplier(skilled.session, BUILDER, "building");
    expect(m).toBeGreaterThan(1.2);
    const banked = skilled.bankOver(1);
    expect(banked / novice).toBeCloseTo(m, 6);
  });

  it("③ PRACTICE IS THE SECONDS SPENT, and inherits up to `labour` at ½", () => {
    const h = harness();
    expect(practiceOf(h.session, BUILDER, "building")).toBe(0);
    h.bankOver(4);
    expect(practiceOf(h.session, BUILDER, "building")).toBeCloseTo(4, 6);
    expect(practiceOf(h.session, BUILDER, "labour")).toBeCloseTo(4 * INHERIT_SHARE, 6);
    h.bankOver(6);
    expect(practiceOf(h.session, BUILDER, "building")).toBeCloseTo(10, 6);
    // 🚨 THE TWO CLOCKS: ten sim seconds are ten practice seconds, whatever the
    // day length is. Nothing here was divided by `dayLengthS`.
    expect(practiceOf(h.session, BUILDER, "building")).toBeLessThan(DOLLHOUSE_SCALE.dayLengthS);
  });

  it("④ 🚫 a body a hundred metres off the lot banks nothing and learns nothing", () => {
    const away = harness({ atWork: false });
    practiceSkill(away.session, BUILDER, "building", 20_000);
    const beforePractice = practiceOf(away.session, BUILDER, "building");
    const banked = away.bankOver(1);
    // The site is UNSTAFFED-but-not-yet-timed-out: nobody stands at the work,
    // so the observed arm banks zero — exactly as it did before skills existed.
    expect(banked).toBe(0);
    expect(practiceOf(away.session, BUILDER, "building")).toBe(beforePractice);
  });
});
