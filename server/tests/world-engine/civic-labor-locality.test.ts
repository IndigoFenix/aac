// CIVIC LABOR IS **LOCAL** (civic-labor-and-polish.md §1 + §2)
//
// The user's question, verbatim: *"Why was the player's house specifically
// conscripted for everything? Wouldn't a house closer to the construction site
// make more sense?"* — and the answer, from the code: the pooled task's
// candidates are registered creatures plus **embodied** street residents, and
// embodiment follows the CAMERA. For a site the camera is not standing at, the
// only bodies inside a TOWN-WIDE radius were the player's always-embodied
// family, so `chooseClaimant`'s "nearest wins" elected them BY FORFEIT. The
// craft leg did not even need the forfeit — it named `familyOf(session).house`
// outright.
//
// Measured before the fix (text mode, seed 7, a spoken `build workshop`, 480
// sim-s): mara spent 66 of 95 sampled frames on `drive=transfer`, walking a
// ~520 m round trip to the town yard for a site 292 m from her door. After:
// **zero** transfer frames, same completion time, and the shell got its
// workbench (the neighbourhood made and delivered it).
//
// What this file pins:
//  ① THE RADIUS is the district sizer's own `serviceRadiusM`, with no town
//     term and no literal — a neighbourhood, not a town.
//  ② THE POOL under that radius: out-of-radius family is not eligible even as
//     the ONLY candidate; nearest-in-radius still wins.
//  ③ THE CRAFT HOUSEHOLD: nearest LOCAL household, benched first; never the
//     focus family by fiat; `"held"` when one already exists anywhere in the
//     neighbourhood (§2's mint-forever break — the piece that left its box).
//  ④ THE CLOCK ARM: an OBSERVED site whose neighbourhood has no embodied hand
//     banks on the schedule instead of stalling at 0 %, and COMPLETES.
//
// Pure logic — no DOM / GL / DB.

import { describe, it, expect } from "@jest/globals";
import {
  chooseClaimant,
  createTaskPool,
  eligibleForTask,
  type PooledTask,
  type TaskCandidate,
} from "@shared/world-engine/interaction/behavior/task-pool.js";
import {
  civicRecruitRadiusM,
  createConstructionDirector,
  SITE_HAUL_FOCUS_R,
  type ConstructionDirectorCtx,
} from "@shared/world-engine/interaction/quest/construction-director.js";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import { houseDoorstep } from "@shared/world-engine/kernel/town/goods.js";
import { foundedBuildingDone, type FoundingCandidate } from "@shared/world-engine/kernel/town/construction.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import { DOLLHOUSE_SCALE, serviceRadiusM } from "@shared/world-engine/scale.js";

const CONFIG = { seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 };

// ─────────────────────────────────────────────────────────────────────────
// ① THE RADIUS — derived, and it is a NEIGHBOURHOOD
// ─────────────────────────────────────────────────────────────────────────

describe("civicRecruitRadiusM — the site's own neighbourhood, derived", () => {
  it("IS the district sizer's social radius — no town term, no literal", () => {
    // The whole change, as one equation: the reach a body ranges to be among
    // its neighbours (scale.ts serviceRadiusM, the same function that sizes a
    // market's clientele) and nothing else. 76.8 m on the street profile.
    expect(civicRecruitRadiusM(DOLLHOUSE_SCALE, true)).toBeCloseTo(
      serviceRadiusM(DOLLHOUSE_SCALE, "social"),
      9,
    );
    expect(civicRecruitRadiusM(DOLLHOUSE_SCALE, true)).toBeCloseTo(76.8, 6);
  });

  it("does not grow with the town — the plan.radius × 2 term is GONE", () => {
    // It used to be `plan.radius * 2 + margin`, which is why a site 292 m from
    // the player's door was still "nearby" to the player's family. A pure
    // function of the scale cannot know how big the town is, and that is the
    // point: the reach of a shout does not depend on the size of the city.
    const seed5 = buildTownPlay(CONFIG);
    const seed9 = buildTownPlay({ ...CONFIG, seed: 9, startPop: 120 });
    expect(seed9.plan.radius).not.toBeCloseTo(seed5.plan.radius, 3);
    expect(civicRecruitRadiusM(DOLLHOUSE_SCALE, true)).toBeLessThan(seed5.plan.radius * 2);
  });

  it("off a town the WILDERNESS EARSHOT rule stays, and it is the floor in town", () => {
    expect(civicRecruitRadiusM(DOLLHOUSE_SCALE, false)).toBe(SITE_HAUL_FOCUS_R);
    // A world whose social clock runs four times faster wants a radius of
    // 19.2 m; nobody recruits from less than shouting distance.
    const fast = { ...DOLLHOUSE_SCALE, metabolism: 4 };
    expect(serviceRadiusM(fast, "social")).toBeLessThan(SITE_HAUL_FOCUS_R);
    expect(civicRecruitRadiusM(fast, true)).toBe(SITE_HAUL_FOCUS_R);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ② THE POOL under the bounded focus
// ─────────────────────────────────────────────────────────────────────────

describe("the claim pool under a NEIGHBOURHOOD focus", () => {
  const SITE = { x: 0, y: 0 };
  const focus = { ...SITE, radius: civicRecruitRadiusM(DOLLHOUSE_SCALE, true) };
  const task = (): PooledTask => ({
    id: "task_0",
    goal: { kind: "buildwork", site: "o:0" },
    issuer: "__player__",
    focus,
    createdAt: 0,
    expiresAt: 45,
    status: "open",
  });
  const cand = (id: string, d: number): TaskCandidate => ({
    id,
    pos: { x: d, y: 0 },
    capable: true,
    willing: true,
  });

  it("the family 292 m away is NOT eligible — not even as the ONLY embodied body", () => {
    // 292 m is the measured distance from the focus house to the workshop site
    // in the seed-7 repro; the family were the only bodies in the old radius,
    // so "nearest" meant "them". Now nobody is nearest, and the site says so.
    const t = task();
    expect(eligibleForTask(t, cand("resident_99_0", 292))).toBe(false);
    expect(chooseClaimant(t, [cand("resident_99_0", 292)])).toBeNull();
    expect(chooseClaimant(t, [cand("resident_99_0", 292), cand("resident_99_1", 400)])).toBeNull();
  });

  it("nearest-in-radius still wins — locality narrows the field, it does not empty it", () => {
    const t = task();
    expect(chooseClaimant(t, [cand("resident_7_0", 70), cand("resident_3_0", 40)])).toBe(
      "resident_3_0",
    );
    // …and the far family loses to a neighbour rather than beating them by
    // being the only body anyone modelled.
    expect(chooseClaimant(t, [cand("resident_99_0", 292), cand("resident_3_0", 40)])).toBe(
      "resident_3_0",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The director harness (town-construction-phase4.test.ts's, with the knobs
// this file turns: the session SCALE, who the family are, where the player is
// standing, and what each building holds).
// ─────────────────────────────────────────────────────────────────────────

function harness(opts?: { family?: number | null }) {
  const play = buildTownPlay(CONFIG);
  const toasts: string[] = [];
  /** buildingKey → glyph → units, as `buildingUnits(…, "anywhere")` answers. */
  const held = new Map<string, Record<string, number>>();
  const me = { at: null as { x: number; y: number } | null };
  const session = {
    town: play,
    townClock: 0,
    taskClock: 0,
    // THE STREET PROFILE, not REAL_SCALE: locality is a statement about
    // distances, and under REAL_SCALE the service radius (~35 km) swallows
    // every town, which is exactly the "one district" case scale.ts documents.
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
  } as unknown as QuestSession;
  const ctx = {
    presenter: { toast: (m: string) => { toasts.push(m); } },
    familyOf: () =>
      opts?.family === undefined || opts.family === null
        ? null
        : { house: opts.family, mode: "some", members: [] },
    buildingUnits: (_s: QuestSession, key: string, glyph: string) => held.get(key)?.[glyph] ?? 0,
    npcChatBubble: () => {},
    spawnLooseProp: () => null,
    removeLooseProp: () => {},
    postPooledTask: () => {},
    stockEndpointOf: () => null,
    containerAnchor: () => null,
    houseContainerKeys: () => [],
    playerWorldPos: () => me.at,
    playerFocusArea: () => null,
    townShortage: () => 0,
    invalidateTownJobs: () => {},
    questViewOf: () => null,
    spiritFocusOf: () => null,
    convoNodeId: () => null,
  } as unknown as ConstructionDirectorCtx;
  return { play, session, toasts, held, me, director: createConstructionDirector(ctx) };
}

/** The world point of a house's doorstep — what `craftHouseholdFor` measures to. */
function doorstepOf(play: ReturnType<typeof buildTownPlay>, index: number) {
  const h = play.plan.houses.find((q) => q.index === index)!;
  return houseDoorstep(play.stage.center, h);
}

/** Straight-line doorstep distances from `at`, nearest first. The chooser
 *  measures by STREET (`sourceDistanceM`), which is never SHORTER than this —
 *  so "chord ≤ reach" is the honest necessary condition to assert against. */
function byChord(play: ReturnType<typeof buildTownPlay>, at: { x: number; y: number }) {
  return play.plan.houses
    .map((h) => {
      const d0 = houseDoorstep(play.stage.center, h);
      return { index: h.index, d: Math.hypot(d0.x - at.x, d0.y - at.y) };
    })
    .sort((a, b) => a.d - b.d);
}

/** The fixture is deterministic per CONFIG, so a probe plan reads the same
 *  indices the harness will build. */
const PLAN = buildTownPlay(CONFIG).plan;

// ─────────────────────────────────────────────────────────────────────────
// ③ THE CRAFT HOUSEHOLD
// ─────────────────────────────────────────────────────────────────────────

describe("craftHouseholdFor — the shell's piece is made in the shell's own street", () => {
  /** A shell standing on the first house's street, and the household living
   *  furthest from it (whom the old line would have put to work). */
  const SITE = { at: null as unknown as { x: number; y: number }, far: -1 };
  {
    const probe = buildTownPlay(CONFIG);
    SITE.at = houseDoorstep(probe.stage.center, probe.plan.houses[0]!);
    SITE.far = byChord(probe, SITE.at).slice(-1)[0]!.index;
  }

  it("picks a household of the SITE'S neighbourhood, never the family across town", () => {
    const reach = civicRecruitRadiusM(DOLLHOUSE_SCALE, true);
    const { play, session, director } = harness({ family: SITE.far });
    const ranked = byChord(play, SITE.at);
    expect(ranked.slice(-1)[0]!.d).toBeGreaterThan(reach); // the family ARE out of reach
    const hand = director.craftHouseholdFor(session, SITE.at, "furn.door");
    expect(hand.kind).toBe("make");
    const chosen = hand.kind === "make" ? hand.house : -1;
    // LOCAL: street metres are never shorter than the chord, so a chosen
    // household inside the reach must be inside it as the crow flies too.
    expect(ranked.find((r) => r.index === chosen)!.d).toBeLessThanOrEqual(reach);
    // …and emphatically not the family, who are the ONLY household the old
    // code could name.
    expect(chosen).not.toBe(SITE.far);
  });

  it("nobody local ⇒ NONE — the want waits; it does not fall back to the family", () => {
    const { play, session, director } = harness({ family: PLAN.houses[0]!.index });
    // A point out in the fields, further from every doorstep than the reach.
    const away = { x: play.stage.center.x + 5000, y: play.stage.center.y + 5000 };
    expect(director.craftHouseholdFor(session, away, "furn.door")).toEqual({ kind: "none" });
  });

  it("a household already holding one answers HELD — never a second piece", () => {
    // §2's break: a finished craft on a SHOWN house leaves its box the instant
    // it is made (it becomes a floor prop), so the "is one stored" question the
    // haul leg asks says no over a door lying right there — and the sweep
    // designated another, every window, forever. The scope answers honestly.
    const { session, held, director } = harness();
    const first = director.craftHouseholdFor(session, SITE.at, "furn.door");
    expect(first.kind).toBe("make");
    held.set(`h_${first.kind === "make" ? first.house : -1}`, { "furn.door": 1 });
    expect(director.craftHouseholdFor(session, SITE.at, "furn.door")).toEqual({ kind: "held" });
    // A DIFFERENT piece is unaffected — the question is per-glyph, never
    // "does that house own any furniture".
    expect(director.craftHouseholdFor(session, SITE.at, "furn.bed").kind).toBe("make");
  });

  it("a household whose one craft slot is busy is skipped, not queued behind", () => {
    const { play, session, director } = harness();
    const first = director.craftHouseholdFor(session, SITE.at, "furn.door");
    expect(first.kind).toBe("make");
    const busy = first.kind === "make" ? first.house : -1;
    play.deltas.craftJobs.set(busy, {
      label: "chair", produces: "furn.chair", consumes: {}, spotId: "x", agreements: [], laborS: 0,
    } as never);
    const second = director.craftHouseholdFor(session, SITE.at, "furn.door");
    // Either a different LOCAL household takes it or nobody local is free —
    // never the busy one, and never a body from outside the neighbourhood.
    expect(second.kind === "make" && second.house).not.toBe(busy);
    if (second.kind === "make") {
      expect(byChord(play, SITE.at).find((r) => r.index === second.house)!.d).toBeLessThanOrEqual(
        civicRecruitRadiusM(DOLLHOUSE_SCALE, true),
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ④ THE CLOCK ARM — an unstaffed site is not a stalled site
// ─────────────────────────────────────────────────────────────────────────

describe("an OBSERVED site with no local hand banks on the clock arm and finishes", () => {
  const LOT: FoundingCandidate = { type: "house", slot: 3, dx: 10, dy: -20, w: 9, h: 8, door: "south" };

  it("posts its call, waits ONE claim window, then schedule-banks to completion", () => {
    const { play, session, me, director } = harness();
    // The player is standing AT the plot (so the order is observed — the
    // rendered-cause arm), but no body in the world may claim: the harness has
    // no avatars at all, which is exactly the far-neighbourhood case.
    const b = play.deltas.foundBuilding(LOT, 0, 0.5);
    me.at = { x: play.stage.center.x + b.dx + b.w / 2, y: play.stage.center.y + b.dy + b.h / 2 };

    // FIRST WINDOW: the site puts its call out (BUILDERS_CAP slots) and banks
    // NOTHING — an observed site does not build itself while hands may still
    // be coming.
    director.stepFoundedConstruction(session, 1);
    expect(session.taskPool.open()).toHaveLength(3);
    expect(b.labor ?? 0).toBe(0);

    // …the window passes with nobody answering.
    for (let s = 0; s < 200 && !foundedBuildingDone(b, session.townClock / session.scale.dayLengthS); s++) {
      session.taskClock += 1;
      session.townClock += 1;
      session.taskPool.expire(session.taskClock);
      director.stepFoundedConstruction(session, 1);
    }
    expect(b.labor ?? 0).toBeGreaterThanOrEqual(b.buildDays);
    expect(b.completed).toBe(true);
    // And it never nagged: an unstaffed site keeps ONE standing call out, not
    // three expiries a window forever.
    expect(session.taskPool.open().length).toBeLessThanOrEqual(1);
  });
});
