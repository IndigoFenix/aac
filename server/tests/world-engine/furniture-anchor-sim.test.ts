// THE FURNITURE-USE ANCHOR — the SIM-SIDE state machine (regression suite).
//
// Its sibling `furniture-use-contract.test.ts` proves the COMPOSED POSE lands on
// the use point; `town-furniture-anchor.test.ts` proves the render slide eases.
// This suite proves the missing half: getting the SIM BODY legally ONTO the use
// point so the two agree and the pose settles, and back OFF to a valid spot.
//
// The chronic bug: a bed / toilet is a SOLID collider when not in use, so a body
// walking up to sleep/sit collides with its edge and stops a body-radius IN FRONT
// of it — the animation then plays there. The fix (furniture-anchor.ts): on the
// contact handoff the anchor eases the body to the use point BYPASSING that one
// fixture's collision (solid to every other body), pins it there out of the
// crowding pass, and on release eases it to a VALIDATED dismount spot.
//
// Drives the REAL production functions over a flat WorldState — DB-free / GL-free,
// runs in `npm run test:engine`.

import { describe, it, expect } from "@jest/globals";
import {
  createWorldState,
  expandWorldBuildings,
  addLocalAvatar,
  steerAvatar,
  fixturesWalkable,
  WORLD_ENGINE_DEFAULTS,
  type WorldState,
  type AvatarState,
} from "@shared/world-engine/engine.js";
import {
  tickFurnitureAnchor,
  engageFurnitureAnchor,
  releaseFurnitureAnchor,
  isFurnitureAnchored,
  dismountSpot,
} from "@shared/world-engine/interaction/quest/furniture-anchor.js";
import { standClear, bodiesClear, separateBodies } from "@shared/world-engine/interaction/quest/stand-points.js";
import { useContractFor, useSideDirs, useAnchorPlan, furnitureUsePoseDump, type UseDumpWorld } from "@shared/world-engine/furniture-use.js";
import type { FixtureKind, ObjectSpec, StructureSpec, WorldSpec } from "@shared/world-engine/types.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function worldSpec(objects: ObjectSpec[], structures: StructureSpec[] = [], size = 60): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: size, height: size },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 3, y: 3 }],
    objects,
    structures,
    buildings: [],
    multiplayer: { maxPlayers: 2, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

const fixtureSpec = (id: string, x: number, y: number, radius: number, kind: FixtureKind, facing: number): ObjectSpec => ({
  id,
  x,
  y,
  shape: "box",
  radius,
  fixture: kind,
  facing,
  interactions: [],
});

const CX = 25;
const CY = 25;

/** A world with one fixture at (CX,CY) + a resident, its activity set to use it. */
function useWorld(kind: FixtureKind, radius: number, facing: number, opts: { at?: { x: number; y: number }; structures?: StructureSpec[] } = {}): {
  state: WorldState;
  id: string;
  center: { x: number; y: number };
} {
  const state = createWorldState(
    expandWorldBuildings(worldSpec([fixtureSpec("fix", CX, CY, radius, kind, facing)], opts.structures ?? [])),
    "me",
  );
  // Place the resident at the realistic stand spot beside the fixture (the
  // standPointFor stand-off: radius + body radius + a small gap), within reach.
  const at = opts.at ?? { x: CX, y: CY - (radius + WORLD_ENGINE_DEFAULTS.avatarRadius + 0.2) };
  const a = addLocalAvatar(state, "resident_a", at.x, at.y, 0);
  a.activity = { kind: kind === "bed" ? "sleep" : "sit", objId: "fix" };
  return { state, id: "resident_a", center: { x: CX, y: CY } };
}

/** Drive the anchor to a terminal phase (anchored, or cleared). Returns the body. */
function driveAnchor(state: WorldState, id: string, until: (a: AvatarState) => boolean, maxSteps = 600): AvatarState {
  const a = state.avatars[id]!;
  for (let i = 0; i < maxSteps; i++) {
    tickFurnitureAnchor(state, id, 1 / 30, WORLD_ENGINE_DEFAULTS, { bodyR: WORLD_ENGINE_DEFAULTS.avatarRadius });
    if (until(a)) return a;
  }
  return a;
}

const planarDelta = (a: { x: number; y: number }, p: { x: number; y: number }) => Math.hypot(a.x - p.x, a.y - p.y);

/** Max dot of the (normalized) offset from centre with any of the fixture's use
 *  side directions — > ~0.7 means the spot is squarely on a USE side. */
function useSideAlignment(kind: FixtureKind, facing: number, center: { x: number; y: number }, p: { x: number; y: number }): number {
  const dirs = useSideDirs(useContractFor(kind), facing);
  const off = { x: p.x - center.x, y: p.y - center.y };
  const len = Math.hypot(off.x, off.y) || 1;
  return Math.max(...dirs.map((d) => (off.x * d.x + off.y * d.y) / len));
}

// ---------------------------------------------------------------------------
// PART A — claimed collision → anchored → the SIM BODY ends ON the use point
// ---------------------------------------------------------------------------

describe("claimed collision hands off to the anchor and eases the body ONTO the use point", () => {
  const cases: Array<{ kind: FixtureKind; radius: number }> = [
    { kind: "bed", radius: 0.9 }, // solid + torso
    { kind: "toilet", radius: 0.55 }, // solid + pelvis
    { kind: "chair", radius: 0.5 }, // pass-through + pelvis
  ];
  for (const { kind, radius } of cases) {
    for (const facing of [0, Math.PI / 2]) {
      it(`${kind} (facing ${facing.toFixed(2)}): body slides to the use point and anchors`, () => {
        const { state, id, center } = useWorld(kind, radius, facing);
        const usePoint = useAnchorPlan(useContractFor(kind), { x: CX, y: CY, radius, facing, groundZ: 0 });
        const a = driveAnchor(state, id, (b) => b.anchor?.phase === "anchored");
        expect(a.anchor?.phase).toBe("anchored");
        // The sim body is ON the use point (for a bed/seat that IS the fixture centre).
        expect(planarDelta(a, usePoint)).toBeLessThan(0.15);
        expect(planarDelta(a, center)).toBeLessThan(0.15);
        // It is pinned — velocity zero, held there.
        expect(Math.hypot(a.vx, a.vy)).toBeLessThan(1e-6);
      });
    }
  }

  it("a solid bed's use point is UNREACHABLE by a steered walk, yet the anchor's interpolation lands ON it", () => {
    // The exact contrast: the fixture centre is BLOCKED to the collision-gated walk
    // (that is why the body used to stop in front) — the anchor gets there by
    // interpolating the position straight onto it, not by steering.
    const { state, id, center } = useWorld("bed", 0.9, 0);
    expect(fixturesWalkable(state, { x: CX, y: CY }, WORLD_ENGINE_DEFAULTS.avatarRadius)).toBe(false);
    const a = driveAnchor(state, id, (b) => b.anchor?.phase === "anchored");
    expect(planarDelta(a, center)).toBeLessThan(0.05); // dead on the (still-solid) centre
  });
});

// ---------------------------------------------------------------------------
// PART A2 — the engage reach must cover WHERE A WALK ACTUALLY ENDS
// ---------------------------------------------------------------------------

/** The arrival tolerance the one walk primitive counts as "arrived"
 *  (quest-host COMMAND_ARRIVE / WALK_ARRIVE). A body is legally parked anywhere
 *  inside this radius of its stand spot, and the stand spot is itself a body
 *  radius clear of the fixture — so this is the real spread the anchor must
 *  cover, not the ideal spot. */
const WALK_ARRIVE_TOLERANCE = 1.3;

describe("engagement covers the whole legal arrival spread, not just the ideal stand spot", () => {
  // REGRESSION (2026-07-27): the engage margin only covered the stand spot, so a
  // sleeper that stopped a metre short of it — an ordinary arrival — kept
  // CLAIMING its bed while the anchor silently refused to engage. Nothing was
  // left to move the body (the rest dwell pins it where it stands), so it slept
  // on the FLOOR beside its own bed, forever. Observed live at 2.24 m from a
  // 0.9 m-radius bed, i.e. barely a step past the stand spot.
  const cases: Array<{ kind: FixtureKind; radius: number }> = [
    { kind: "bed", radius: 0.9 },
    { kind: "toilet", radius: 0.55 },
    { kind: "chair", radius: 0.5 },
  ];
  for (const { kind, radius } of cases) {
    it(`${kind}: a body parked a full arrival tolerance past its stand spot still anchors`, () => {
      const standOff = radius + WORLD_ENGINE_DEFAULTS.avatarRadius + 0.2;
      const at = { x: CX, y: CY - (standOff + WALK_ARRIVE_TOLERANCE) };
      const { state, id, center } = useWorld(kind, radius, 0, { at });
      // Precondition: this really is the far edge of a legal arrival, not a body
      // that wandered off — it is beyond the stand spot but inside the tolerance.
      expect(planarDelta(at, center)).toBeGreaterThan(standOff);
      const a = driveAnchor(state, id, (b) => b.anchor?.phase === "anchored");
      expect(a.anchor?.phase).toBe("anchored");
      expect(planarDelta(a, center)).toBeLessThan(0.15); // on the piece, not beside it
    });
  }
});

// ---------------------------------------------------------------------------
// PART B — an UNCLAIMED body still collides (the fixture is solid to everyone else)
// ---------------------------------------------------------------------------

describe("the fixture stays fully solid to bodies that have NOT claimed it", () => {
  it("a body with no claim never anchors and cannot reach the bed centre", () => {
    const { state } = useWorld("bed", 0.9, 0);
    // A second resident RIGHT beside the bed but NOT using it.
    const other = addLocalAvatar(state, "resident_b", CX, CY - 1.4, 0);
    // No activity → no claim → the anchor refuses to engage.
    expect(engageFurnitureAnchor(state, "resident_b")).toBe(false);
    expect(tickFurnitureAnchor(state, "resident_b", 1 / 30)).toBe(false);
    expect(other.anchor).toBeUndefined();
    // Steer it straight AT the bed centre for 3 s — it is held OUTSIDE the box.
    for (let i = 0; i < 180; i++) steerAvatar(state, "resident_b", { x: CX, y: CY }, 1 / 30);
    expect(planarDelta(other, { x: CX, y: CY })).toBeGreaterThan(0.9); // never reached the centre
    expect(fixturesWalkable(state, { x: other.x, y: other.y }, WORLD_ENGINE_DEFAULTS.avatarRadius)).toBe(true);
  });

  it("the claiming body sitting on the centre does NOT make the fixture walkable for anyone", () => {
    const { state, id } = useWorld("bed", 0.9, 0);
    driveAnchor(state, id, (b) => b.anchor?.phase === "anchored");
    // The bed is still solid — the anchor never touched the collision layer.
    expect(fixturesWalkable(state, { x: CX, y: CY }, WORLD_ENGINE_DEFAULTS.avatarRadius)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PART C — every exit path lands on a VALIDATED dismount (walkable, use-side,
// collider-free, body-clear) — including bed-against-wall / corner placements
// ---------------------------------------------------------------------------

function assertValidDismount(state: WorldState, a: AvatarState, kind: FixtureKind, facing: number, center: { x: number; y: number }, bodyR = WORLD_ENGINE_DEFAULTS.avatarRadius) {
  // Walkable (clear of walls AND solid fixtures) and clear of the OTHER bodies.
  expect(standClear(state, a, bodyR)).toBe(true);
  expect(bodiesClear(state, a, a.id, bodyR)).toBe(true);
  // Genuinely OUTSIDE the fixture footprint (never left inside the geometry).
  expect(fixturesWalkable(state, a, bodyR)).toBe(true);
  // On a declared USE side (a long side / foot of a bed — never the headboard).
  expect(useSideAlignment(kind, facing, center, a)).toBeGreaterThan(0.6);
}

describe("dismount lands the body on a validated spot — every exit path, every placement", () => {
  it("need satisfied (activity cleared while anchored) → slides out to a valid side", () => {
    const { state, id, center } = useWorld("bed", 0.9, 0);
    const a = driveAnchor(state, id, (b) => b.anchor?.phase === "anchored");
    delete a.activity; // the need is met — the claim drops
    const done = driveAnchor(state, id, (b) => !b.anchor);
    expect(done.anchor).toBeUndefined();
    assertValidDismount(state, done, "bed", 0, center);
  });

  it("a toilet dismount lands on its front (its only use side)", () => {
    const { state, id, center } = useWorld("toilet", 0.55, Math.PI / 2);
    const a = driveAnchor(state, id, (b) => b.anchor?.phase === "anchored");
    delete a.activity;
    const done = driveAnchor(state, id, (b) => !b.anchor);
    assertValidDismount(state, done, "toilet", Math.PI / 2, center);
  });

  it("a bed with a WALL behind the headboard dismounts to a long side / the foot", () => {
    // Bed facing 0 ⇒ headboard at -x. A wall just past it (and the -y long side
    // blocked too) forces the dismount onto the +y long side or the +x foot.
    const walls: StructureSpec[] = [
      { kind: "wall", id: "wx", a: { x: CX - 1.4, y: CY - 4 }, b: { x: CX - 1.4, y: CY + 4 }, thickness: 1 },
      { kind: "wall", id: "wy", a: { x: CX - 4, y: CY - 1.9 }, b: { x: CX + 4, y: CY - 1.9 }, thickness: 1 },
    ];
    const { state, id, center } = useWorld("bed", 0.9, 0, { structures: walls, at: { x: CX, y: CY + 1.5 } });
    const a = driveAnchor(state, id, (b) => b.anchor?.phase === "anchored");
    expect(a.anchor?.phase).toBe("anchored"); // reached the mattress despite the walls
    delete a.activity;
    const done = driveAnchor(state, id, (b) => !b.anchor);
    expect(done.anchor).toBeUndefined();
    assertValidDismount(state, done, "bed", 0, center);
    // NOT squeezed against either wall: north of the -y wall and east of the -x wall.
    expect(done.y).toBeGreaterThan(CY - 1.9 + 0.5);
    expect(done.x).toBeGreaterThan(CX - 1.4 + 0.5);
  });
});

// ---------------------------------------------------------------------------
// PART D — a mid-slide interruption still exits through the validated dismount
// ---------------------------------------------------------------------------

describe("an interruption mid-use exits through the validated dismount", () => {
  it("commanded away DURING the slide-in → releases and lands on a valid side", () => {
    const { state, id, center } = useWorld("bed", 0.9, 0);
    // Engage + a few slide-in frames, but interrupt BEFORE it fully anchors.
    tickFurnitureAnchor(state, id, 1 / 30, WORLD_ENGINE_DEFAULTS, {});
    const a = state.avatars[id]!;
    expect(a.anchor?.phase).toBe("sliding-in");
    for (let i = 0; i < 5; i++) tickFurnitureAnchor(state, id, 1 / 30);
    // The command to walk away: force the dismount (also clear the claim).
    delete a.activity;
    releaseFurnitureAnchor(state, id, { bodyR: WORLD_ENGINE_DEFAULTS.avatarRadius });
    expect(a.anchor?.phase).toBe("sliding-out");
    const done = driveAnchor(state, id, (b) => !b.anchor);
    expect(done.anchor).toBeUndefined();
    assertValidDismount(state, done, "bed", 0, center);
  });

  it("dismountSpot itself always returns an outside-the-collider, use-side point", () => {
    const { state, id, center } = useWorld("bed", 0.9, 0);
    const a = driveAnchor(state, id, (b) => b.anchor?.phase === "anchored");
    const spot = dismountSpot(state, a, "fix", { bodyR: WORLD_ENGINE_DEFAULTS.avatarRadius });
    expect(fixturesWalkable(state, spot, WORLD_ENGINE_DEFAULTS.avatarRadius)).toBe(true);
    expect(useSideAlignment("bed", 0, center, spot)).toBeGreaterThan(0.6);
  });
});

// ---------------------------------------------------------------------------
// PART E — an anchored body is immune to the crowding-separation pass
// ---------------------------------------------------------------------------

describe("an anchored body is held out of the separation pass (never shoved off its fixture)", () => {
  it("isFurnitureAnchored gates it out, and it does not move under separateBodies", () => {
    const { state, id } = useWorld("bed", 0.9, 0);
    const a = driveAnchor(state, id, (b) => b.anchor?.phase === "anchored");
    expect(isFurnitureAnchored(a)).toBe(true);
    // A neighbour piles right onto the anchored body's spot — a raw separation
    // pass would try to shove the pair apart.
    const nb = addLocalAvatar(state, "resident_b", a.x + 0.05, a.y, 0);
    const before = { x: a.x, y: a.y };
    // world-host EXCLUDES anchored bodies from the pass — reproduce that filter.
    const bodies = Object.values(state.avatars)
      .filter((b) => !isFurnitureAnchored(b))
      .map((b) => ({ id: b.id, x: b.x, y: b.y, floor: b.floor }));
    for (let i = 0; i < 60; i++) {
      separateBodies(bodies, 1 / 30, { radiusOf: () => WORLD_ENGINE_DEFAULTS.avatarRadius });
      for (const bd of bodies) {
        const av = state.avatars[bd.id]!;
        av.x = bd.x;
        av.y = bd.y;
      }
    }
    // The anchored body never entered the pass — dead still on its use point.
    expect(a.x).toBeCloseTo(before.x, 6);
    expect(a.y).toBeCloseTo(before.y, 6);
    expect(nb).toBeDefined();
    // The exclusion is LOAD-BEARING: had the anchored body been in the pass, the
    // same overlap WOULD have shoved it off (proving the filter is what protects
    // it — not some accident of the geometry).
    const naive = [
      { id: a.id, x: a.x, y: a.y, floor: a.floor },
      { id: nb.id, x: nb.x + 0.05, y: nb.y, floor: nb.floor },
    ];
    separateBodies(naive, 1 / 30, { radiusOf: () => WORLD_ENGINE_DEFAULTS.avatarRadius });
    expect(Math.hypot(naive[0]!.x - a.x, naive[0]!.y - a.y)).toBeGreaterThan(0);
  });

  it("after dismount the body rejoins the pass (isFurnitureAnchored false)", () => {
    const { state, id } = useWorld("bed", 0.9, 0);
    const a = driveAnchor(state, id, (b) => b.anchor?.phase === "anchored");
    delete a.activity;
    driveAnchor(state, id, (b) => !b.anchor);
    expect(isFurnitureAnchored(a)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PART F — the __questLab_pose() ground truth: with the anchor engaged, the pose
// dump (the SAME function the browser hook prints) reads planar/yaw delta ≈ 0
// ---------------------------------------------------------------------------

describe("__questLab_pose() ground truth: anchored bodies read delta ≈ 0 in the pose dump", () => {
  it("bed / chair / toilet all sit dead-on their use point (planar + yaw ~0)", () => {
    // One world, all three on-fixture kinds, each with a resident using it.
    const specs: ObjectSpec[] = [
      fixtureSpec("bed", 15, 15, 0.9, "bed", 0),
      fixtureSpec("chair", 30, 15, 0.5, "chair", Math.PI / 2),
      fixtureSpec("toilet", 45, 15, 0.55, "toilet", Math.PI),
    ];
    const state = createWorldState(expandWorldBuildings(worldSpec(specs)), "me", 0, undefined);
    const seats: Array<{ id: string; oid: string; kind: AvatarState["activity"] }> = [
      { id: "resident_bed", oid: "bed", kind: { kind: "sleep", objId: "bed" } },
      { id: "resident_chair", oid: "chair", kind: { kind: "sit", objId: "chair" } },
      { id: "resident_toilet", oid: "toilet", kind: { kind: "sit", objId: "toilet" } },
    ];
    for (const s of seats) {
      const o = state.objects[s.oid]!;
      const sp = state.spec.objects.find((x) => x.id === s.oid)!;
      const av = addLocalAvatar(state, s.id, o.x, o.y - (sp.radius + 0.6), 0);
      av.activity = s.kind;
    }
    // Drive every anchor to its pinned phase.
    for (const s of seats) driveAnchor(state, s.id, (b) => b.anchor?.phase === "anchored");

    const rows = furnitureUsePoseDump(state as unknown as UseDumpWorld);
    // The exact table __questLab_pose() prints in the browser.
    // eslint-disable-next-line no-console
    console.log(
      "[furniture-anchor pose dump]\n" +
        rows
          .map((r) => `  ${r.id.padEnd(16)} ${r.fixture.padEnd(7)} contact=${r.contactPart.padEnd(6)} dPlanar=${r.planarDelta.toFixed(3)} dYaw=${r.yawDelta.toFixed(3)}`)
          .join("\n"),
    );
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.planarDelta).toBeLessThan(0.15); // the body IS on the use point
      expect(r.yawDelta).toBeLessThan(0.05); // and faces exactly where the contract wants
    }
  });
});
