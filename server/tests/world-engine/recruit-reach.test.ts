// RECRUITMENT IS BOUNDED BY REACH, NOT BY A CHORD
// (planning-docs/games/world-engine/pull-labor-round.md — DOLLHOUSE
//  UNREACHABLE-RECRUIT, 2026-09-08)
//
// The user's report, verbatim: *"the dollhouse has the town recruiting family
// members to projects that I think they can't reach."*
//
// MEASURED (text-mode headless, dollhouse seed 12, 900 sim-s, no player
// command): 53 civic claims. 17 of them were aimed at a work point INSIDE a
// pending annex room — a box whose walls the delta-applied plan already stands
// and whose doorway is not cut until the annex commits. EXACTLY ONE body ever
// got inside. Every no-door-chain haul ended
// `[haul] … ABANDONED — set down N× wood`, and the family member
// `resident_161_0` (task_24 → `h_211_a0`, chord 70.3 m ≤ the 76.8 m recruiting
// radius, NO door chain) stood at the outside of that wall holding six wood for
// the last 460 s of the run.
//
// The mechanism was one line: `eligibleForTask` asked `capable && willing &&
// hypot(pos − focus) ≤ radius` — a CHORD, which goes through walls. Nothing in
// the push-labour path had ever asked whether a body could WALK to the work
// (the pull model's `visibleBills` asks its half — `rungs.has(row.scopeId)` —
// and the pool simply never did).
//
// What this file pins:
//  ① UNMEASURED IS ADMITTED. `reach` absent ⇒ byte-identical to the shipped
//     rule, which is why every pin written before this still holds.
//  ② AN UNROUTABLE BODY IS NOT ELIGIBLE — even capable, willing, and nearest.
//  ③ REACH IS A FACT ABOUT THE BODY, not the task: one focus, two bodies,
//     opposite answers — which is why the record rides on the candidate.
//  ④ THE CHOOSER SKIPS IT: a routable body further away beats an unroutable
//     body standing on top of the work, and an all-unreachable field elects
//     NOBODY (the row expires and the site falls to its clock arm).
//  ⑤ THE RADIUS STILL BINDS — reach is not a replacement for locality.
//  ⑥ THE DOOR GRAPH IS THE ROUTE TEST, over a real `WorldState`: two rooms
//     joined by a door are reachable; a walled box with no doorway is not, and
//     `routeThroughDoors` answers `[to]` for BOTH cases — which is exactly why
//     the caller has to ask rather than read the polyline.
//
// 🚧 The SCOPE-WALK half of reach is deliberately NOT shipped — see
// `TaskReach`'s own doc block for the measurement that ruled it out for now.
//
// Pure logic — no DOM / GL / DB.

import { describe, it, expect } from "@jest/globals";
import {
  chooseClaimant,
  eligibleForTask,
  reachableForTask,
  type PooledTask,
  type TaskCandidate,
} from "@shared/world-engine/interaction/behavior/task-pool.js";
import { civicRecruitRadiusM } from "@shared/world-engine/interaction/quest/construction-director.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";
import {
  buildingAt,
  createWorldState,
  expandWorldBuildings,
  routeThroughDoors,
} from "@shared/world-engine/engine.js";
import type { WorldSpec, WorldState } from "@shared/world-engine/types.js";

const R = civicRecruitRadiusM(DOLLHOUSE_SCALE, true); // 76.8 m — the shipped reach

const task = (): PooledTask => ({
  id: "task_0",
  goal: { kind: "buildwork", site: "o:0" },
  issuer: "__player__",
  focus: { x: 0, y: 0, radius: R },
  createdAt: 0,
  expiresAt: 45,
  status: "open",
});

const cand = (id: string, d: number, reach?: TaskCandidate["reach"]): TaskCandidate => ({
  id,
  pos: { x: d, y: 0 },
  capable: true,
  willing: true,
  ...(reach ? { reach } : {}),
});

// ─────────────────────────────────────────────────────────────────────────
// ① UNMEASURED IS ADMITTED — the compatibility law
// ─────────────────────────────────────────────────────────────────────────

describe("reach is OPTIONAL, and an unmeasured claim is admitted", () => {
  it("a candidate with no `reach` behaves exactly as it did before the field existed", () => {
    const t = task();
    expect(reachableForTask(cand("a", 10))).toBe(true);
    expect(eligibleForTask(t, cand("a", 10))).toBe(true);
    expect(eligibleForTask(t, cand("a", R + 1))).toBe(false); // …and the radius still decides
  });

  it("`{routed:true}` is the same answer as absent — measuring cannot change a good claim", () => {
    const t = task();
    const measured = cand("a", 10, { routed: true });
    expect(eligibleForTask(t, measured)).toBe(eligibleForTask(t, cand("a", 10)));
    expect(chooseClaimant(t, [measured, cand("b", 40)])).toBe("a");
  });

  it("capability and willingness are asked FIRST — a reachable body that cannot still cannot", () => {
    const t = task();
    const reach = { routed: true };
    expect(eligibleForTask(t, { ...cand("a", 5, reach), capable: false })).toBe(false);
    expect(eligibleForTask(t, { ...cand("a", 5, reach), willing: false })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ② + ③ REACH REFUSES, AND IT REFUSES PER BODY
// ─────────────────────────────────────────────────────────────────────────

describe("an unroutable body is NOT eligible", () => {
  it("a wall between the body and the work is not reach — however short the chord", () => {
    // The measured case: `resident_161_0`, 70.3 m from a pile inside a doorless
    // annex room, elected because 70.3 ≤ 76.8, then pinned at the wall for 460 s.
    const t = task();
    const atWall = cand("resident_161_0", 70.3, { routed: false });
    expect(reachableForTask(atWall)).toBe(false);
    expect(eligibleForTask(t, atWall)).toBe(false);
    // …and standing ON the work changes nothing: the wall is the fact, not the
    // distance.
    expect(eligibleForTask(t, cand("resident_161_0", 0.5, { routed: false }))).toBe(false);
  });
});

describe("reach is a fact about the BODY, measured per body", () => {
  it("the same task admits the routable body and refuses the walled one", () => {
    // Not a property of the task: two bodies, one focus, opposite answers —
    // which is why the record rides on the CANDIDATE and not on `PooledTask`.
    const t = task();
    expect(eligibleForTask(t, cand("resident_142_0", 71.6, { routed: true }))).toBe(true);
    expect(eligibleForTask(t, cand("resident_161_0", 70.3, { routed: false }))).toBe(false);
  });

  it("`routed:false` is the ONLY thing that refuses — measuring is otherwise inert", () => {
    expect(reachableForTask(cand("a", 1, { routed: false }))).toBe(false);
    expect(reachableForTask(cand("a", 1, { routed: true }))).toBe(true);
    expect(reachableForTask(cand("a", 1))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ④ THE CHOOSER
// ─────────────────────────────────────────────────────────────────────────

describe("chooseClaimant skips what it cannot reach", () => {
  it("a routable neighbour beats an unroutable body standing on the work", () => {
    const t = task();
    const winner = chooseClaimant(t, [
      cand("walled", 0.5, { routed: false }),
      cand("neighbour", 60, { routed: true }),
    ]);
    expect(winner).toBe("neighbour");
  });

  it("an all-unreachable field elects NOBODY — the row stays open, expires, and the clock arm takes it", () => {
    // This is the honest answer for a site nothing local can walk to, and it is
    // the path the director already owns (`unstaffed` ⇒ `clockArm`). Before the
    // fix this field elected the nearest body and spent it on a wall.
    const t = task();
    expect(
      chooseClaimant(t, [
        cand("resident_161_0", 10, { routed: false }),
        cand("resident_161_1", 20, { routed: false }),
        cand("resident_161_2", 30, { routed: false }),
      ]),
    ).toBeNull();
  });

  it("reach narrows the field; it does not reorder what is left", () => {
    // Among reachable candidates the shipped rule is untouched: nearest wins,
    // ties by the lexicographic id.
    const t = task();
    const reach = { routed: true };
    expect(
      chooseClaimant(t, [cand("far", 70, reach), cand("near", 12, reach), cand("walled", 1, { routed: false })]),
    ).toBe("near");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ⑤ REACH IS NOT A RADIUS
// ─────────────────────────────────────────────────────────────────────────

describe("locality still binds", () => {
  it("a perfectly routable body across town is still out of the neighbourhood", () => {
    const t = task();
    expect(eligibleForTask(t, cand("resident_99_0", 292, { routed: true }))).toBe(false);
    expect(chooseClaimant(t, [cand("resident_99_0", 292, { routed: true })])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ⑥ THE ROUTE TEST OVER A REAL WORLD — why the caller has to ask
// ─────────────────────────────────────────────────────────────────────────

describe("the door graph is what `routed` measures", () => {
  /** Two 10×10 rooms side by side. `joined` cuts a doorway in the shared wall;
   *  otherwise the east room is a sealed box — the shape a pending annex has
   *  before its doorway is cut. */
  const twoRooms = (joined: boolean): WorldState =>
    createWorldState(
      expandWorldBuildings({
        engine: "world",
        engineVersion: 1,
        meta: { title: "t", locale: "en", theme: "t" },
        manifold: { kind: "flat", width: 60, height: 60 },
        terrain: { kind: "flat" },
        spawns: [{ id: "s", x: 30, y: 30 }],
        objects: [],
        buildings: [
          {
            id: "west",
            footprint: { x: 4, y: 4, w: 10, h: 10 },
            floors: 1,
            wallThickness: 0.3,
            doorways: [{ edge: "south", offset: 5, width: 1.4 }], // out to the street
          },
          {
            id: "east",
            footprint: { x: 14, y: 4, w: 10, h: 10 },
            floors: 1,
            wallThickness: 0.3,
            ...(joined ? { doorways: [{ edge: "west", offset: 5, width: 1.4 }] } : {}),
          },
        ],
        multiplayer: { maxPlayers: 2, authority: "distributed" },
        content: { kind: "sandbox" },
      } as WorldSpec),
      "you",
    );

  const inWest = { x: 9, y: 9 };
  const inEast = { x: 19, y: 9 };
  const outside = { x: 9, y: 24 };

  /** The host's own predicate, spelled here exactly as the claim sweep spells
   *  it — same room, else a door chain longer than the bare endpoint. */
  const routed = (state: WorldState, a: { x: number; y: number }, b: { x: number; y: number }) => {
    const na = buildingAt(state, a.x, a.y)?.id ?? "";
    const nb = buildingAt(state, b.x, b.y)?.id ?? "";
    return na === nb || routeThroughDoors(state, a, b).length > 1;
  };

  it("a doorway makes the far room reachable from the street", () => {
    const state = twoRooms(true);
    expect(buildingAt(state, inEast.x, inEast.y)?.id).toBe("east");
    expect(buildingAt(state, outside.x, outside.y)).toBeNull(); // the street
    expect(routed(state, outside, inEast)).toBe(true);
    expect(routed(state, inWest, inEast)).toBe(true);
  });

  it("a sealed box is NOT reachable — and `routeThroughDoors` still hands back a straight line", () => {
    const state = twoRooms(false);
    // The whole reason this cannot be read off the polyline: the engine returns
    // `[to]` for "no chain" and `[to]` for "same room" alike (engine.ts), so a
    // body handed this walks into the wall and its haul is abandoned there.
    expect(routeThroughDoors(state, outside, inEast)).toHaveLength(1);
    expect(routed(state, outside, inEast)).toBe(false);
    expect(routed(state, inWest, inEast)).toBe(false);
    // …while the room the body is standing in is trivially its own reach.
    expect(routed(state, inEast, inEast)).toBe(true);
    expect(routed(state, outside, inWest)).toBe(true); // the west door still opens
  });
});
