// THE FURNITURE USE-POINT CONTRACT — the COMPOSITION-LAYER regression suite.
//
// Using furniture kept visually regressing because the visible pose is composed
// from ~5 independent layers (fixture spec → renderer anchor resolve → rig
// conventions → animator crouch/recline overlay → per-frame easing) with no
// single contract and NO test AT the composition layer. Sim-side tests always
// passed while the picture was wrong (sitters floated a hip-height above seats
// because those tests asserted `body.y ≈ anchor.y`, codifying the bug).
//
// This suite computes the COMPOSED world transform THROUGH THE REAL PRODUCTION
// FUNCTIONS — the furniture-use contract (useContractFor / useAnchorWorld), the
// render yaw mirror (sitterYaw / bedSleeperYaw), the avatar factory's slide, and
// the model's own seatDropWorld body offset — and asserts the CONTACT PART lands
// ON the USE POINT (position AND yaw), for every fixture kind that carries an
// on-fixture use × several body plans/species sizes × several facings. It is
// written to FAIL if ANY of the five layers shifts the composition: it never
// re-implements the math, it drives the real functions and reads back the pose.
//
// Plus: the sim-side stand spot for opening a fridge/chest (and a bed) sits on
// the fixture's USE-DIRECTION side — the front of a cabinet, a long side of a
// bed — never its back or a walled edge.
//
// Creature core + headless THREE groups + a flat WorldState — DB-free, runs in
// `npm run test:engine`.

import { describe, it, expect } from "@jest/globals";
import {
  createCreatureAvatarFactory,
  createDynamicCreature,
} from "@shared/world-engine/creatures/creature-model.js";
import { sitterYaw, bedSleeperYaw } from "@shared/world-engine/render3d.js";
import {
  useContractFor,
  useAnchorWorld,
  useSideDirs,
  type FixturePose,
} from "@shared/world-engine/furniture-use.js";
import { createWorldState, expandWorldBuildings } from "@shared/world-engine/engine.js";
import { standPointFor } from "@shared/world-engine/interaction/quest/stand-points.js";
import type { AvatarFrame } from "@shared/world-engine/render3d.js";
import type { AvatarActivity } from "@shared/world-engine/engine.js";
import type { FixtureKind, ObjectSpec, WorldSpec } from "@shared/world-engine/types.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Anchor = { x: number; y: number; z: number; yaw: number; contact?: "pelvis" | "torso" | "reach" };

const frame = (opts: { activity?: AvatarActivity; anchor?: Anchor } = {}): AvatarFrame =>
  ({
    state: { x: 0, y: 0, fx: 0, fy: 1, activity: opts.activity },
    speed: 0,
    activityAnchor: opts.anchor,
  } as unknown as AvatarFrame);

/** Three genuinely different body plans / sizes (biped tall, biped short,
 *  quadruped low) — the rig conventions the contract must survive. */
const BODIES: Array<{ species: string; heightM: number }> = [
  { species: "human_cute", heightM: 1.7 },
  { species: "human", heightM: 1.15 },
  { species: "sheep", heightM: 0.9 },
];

const FACINGS = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

/** Shortest angular gap (radians). */
function angGap(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

// ---------------------------------------------------------------------------
// PART A — the on-fixture pose lands the CONTACT PART on the USE POINT
// ---------------------------------------------------------------------------

describe("composition: the contact part lands ON the use point (pos + yaw), every body plan × facing", () => {
  // The kinds that carry an ON-FIXTURE use — a body slides onto them. Each with
  // the activity that drives it and the render yaw mirror it uses.
  const kinds: Array<{ kind: FixtureKind; activity: AvatarActivity["kind"]; bodyYaw: (f: number | undefined) => number }> = [
    { kind: "chair", activity: "sit", bodyYaw: sitterYaw },
    { kind: "toilet", activity: "sit", bodyYaw: sitterYaw },
    { kind: "bed", activity: "sleep", bodyYaw: bedSleeperYaw },
  ];

  for (const { kind, activity, bodyYaw } of kinds) {
    const contract = useContractFor(kind);
    it(`${kind} is an on-fixture use (${contract.contactPart})`, () => {
      expect(contract.onFixture).toBe(true);
    });

    for (const body of BODIES) {
      for (const facing of FACINGS) {
        it(`${kind} · ${body.species}(${body.heightM}m) · facing ${facing.toFixed(2)}: contact ON use-point`, () => {
          // Size the piece to the occupant (species-sized houses) so a big body
          // on a small seat never bottoms out on the floor clamp — the invariant
          // under test is the un-clamped composition.
          const radius = 0.5 * (body.heightM / 1.7);
          const groundZ = 0; // render root at origin ⇒ body-local == world
          const fixture: FixturePose = { x: 0, y: 0, radius, facing, groundZ };

          // THE CONTRACT COMPOSITION (real function) — the world use point + yaw.
          const anchor = useAnchorWorld(contract, fixture, bodyYaw);

          // THE RIG BODY-OFFSET (real model) — the crouched pelvis drop this
          // species applies for a seat; a bed re-centres via its recline (no
          // drop). Computed from a parallel dynamic body driven to steady state,
          // exactly the value the avatar factory's own dynamic body uses.
          const probe = createDynamicCreature(body.species, { heightM: body.heightM });
          for (let i = 0; i < 120; i++) probe.update(1 / 30, activity === "sit" ? { activity: "sit" } : { activity: "sleep" });
          const drop = contract.contactPart === "pelvis" ? probe.seatDropWorld : 0;
          probe.dispose();

          // THE FACTORY COMPOSITION (real slide + easing) — drive a baked NPC
          // onto the anchor to steady state and read its composed transform.
          const factory = createCreatureAvatarFactory({ speciesFor: () => body.species, heightM: body.heightM });
          const npc = factory("resident_x", false);
          npc.update(frame(), 1 / 30); // baked idle
          for (let i = 0; i < 150; i++) {
            npc.update(frame({ activity: { kind: activity, objId: "furn_0_x" }, anchor }), 1 / 30);
          }
          const b = npc.object.children[0]!;

          // Horizontal: dead-centre on the use point.
          expect(b.position.x).toBeCloseTo(anchor.x, 1);
          expect(b.position.z).toBeCloseTo(anchor.z, 1);

          // Vertical — THE CRUX: the CONTACT PART (feet-origin + the rig drop)
          // coincides with the use-point SURFACE height. A seat drops the pelvis
          // onto the surface; a bed's torso lies on it. Either way the composed
          // contact height must equal the contract's use-point height.
          const contactWorldY = b.position.y + drop;
          expect(contactWorldY).toBeCloseTo(anchor.y, 1);
          // And a seated body is genuinely dropped BELOW the surface (never left
          // floating with its feet-origin on the seat) and never punched through
          // the floor.
          if (contract.contactPart === "pelvis") {
            expect(b.position.y).toBeLessThan(anchor.y - 0.05);
            expect(b.position.y).toBeGreaterThanOrEqual(0);
          }

          // Yaw: the body faces exactly where the contract says (the fixture's
          // own heading, through the render mirror).
          expect(angGap(b.rotation.y, anchor.yaw)).toBeLessThan(0.06);

          npc.dispose();
        });
      }
    }
  }
});

// ---------------------------------------------------------------------------
// PART B — the sim stand spot sits on the USE-DIRECTION side
// ---------------------------------------------------------------------------

function worldSpec(objects: ObjectSpec[], size = 60): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: size, height: size },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 3, y: 3 }],
    objects,
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

describe("sim: the stand spot is on the fixture's use-direction side (open the fridge from the FRONT)", () => {
  // A body coming from BEHIND the fixture must still be sent to the FRONT — the
  // exact regression (a resident opening the fridge from the side/back). Placed
  // in the OPEN so no wall confounds the side choice; the only side rule is the
  // contract's use direction.
  const CX = 20;
  const CY = 20;
  const R = 0.55;

  for (const facing of FACINGS) {
    it(`a front-only chest facing ${facing.toFixed(2)} is approached from its front`, () => {
      const s = createWorldState(expandWorldBuildings(worldSpec([fixtureSpec("chest", CX, CY, R, "chest", facing)])), "me");
      // Approach from directly BEHIND the front (the opposite side).
      const front = { x: Math.cos(facing), y: Math.sin(facing) };
      const from = { x: CX - front.x * 5, y: CY - front.y * 5 };
      const p = standPointFor(s, "chest", { x: CX, y: CY }, from);
      // The spot's offset from the fixture centre points along the FRONT (a
      // strong positive dot with the front direction) — not the back, not a side.
      const off = { x: p.x - CX, y: p.y - CY };
      const dot = off.x * front.x + off.y * front.y;
      const len = Math.hypot(off.x, off.y) || 1;
      expect(dot / len).toBeGreaterThan(0.7); // within ~45° of dead-front
    });
  }

  it("a refrigerator is front-only in its contract (never opened from the side)", () => {
    expect(useContractFor("refrigerator").useDirections).toEqual([0]);
    expect(useContractFor("chest").useDirections).toEqual([0]);
    expect(useContractFor("cupboard").useDirections).toEqual([0]);
  });

  it("a bed is approached from a long side or the foot — NEVER the headboard", () => {
    // Bed facing 0 ⇒ headboard at -x (game angle π). A body coming from the
    // headboard side must be sent to a long side or the foot, not squeezed
    // against the headboard wall.
    const facing = 0;
    const bedR = 0.9;
    const s = createWorldState(expandWorldBuildings(worldSpec([fixtureSpec("bed", CX, CY, bedR, "bed", facing)])), "me");
    const from = { x: CX - 5, y: CY }; // west, behind the headboard
    const p = standPointFor(s, "bed", { x: CX, y: CY }, from);
    // The headboard side is -x; the spot must NOT be there (its x is at/beyond
    // the centre, i.e. a long side or the foot).
    expect(p.x).toBeGreaterThan(CX - (bedR + 0.3));
    // The forbidden local approach (π, the headboard) is not in the contract.
    expect(useContractFor("bed").useDirections).not.toContain(Math.PI);
  });

  it("a table's use directions cover every side (eaten at from any seat)", () => {
    expect(useContractFor("table").useDirections.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// PART C — every fixture kind gets a contract from its semantics (defaults)
// ---------------------------------------------------------------------------

describe("contract defaults: every fixture kind is covered, derived from its semantics", () => {
  const ALL: FixtureKind[] = [
    "chest", "cupboard", "table", "bed", "chair", "box",
    "barrel", "bath", "toilet", "bin", "bowl", "oven", "workbench", "refrigerator",
  ];
  it("every kind resolves a contract with a sane use point + at least one approach", () => {
    for (const k of ALL) {
      const c = useContractFor(k);
      expect(c.useDirections.length).toBeGreaterThan(0);
      expect(Number.isFinite(c.usePoint.up)).toBe(true);
      expect(["pelvis", "torso", "reach"]).toContain(c.contactPart);
    }
  });
  it("seats/bed are on-fixture; containers/appliances are beside (reach)", () => {
    for (const k of ["chair", "toilet", "bed"] as FixtureKind[]) expect(useContractFor(k).onFixture).toBe(true);
    for (const k of ["chest", "cupboard", "refrigerator", "oven", "workbench", "barrel", "bin"] as FixtureKind[]) {
      expect(useContractFor(k).onFixture).toBe(false);
      expect(useContractFor(k).contactPart).toBe("reach");
    }
  });
  it("world use directions rotate the local set by the fixture facing", () => {
    const c = useContractFor("chest");
    const dirs = useSideDirs(c, Math.PI / 2);
    // front-only chest facing +y ⇒ its one use side points at +y.
    expect(dirs.length).toBe(1);
    expect(dirs[0]!.x).toBeCloseTo(0, 5);
    expect(dirs[0]!.y).toBeCloseTo(1, 5);
  });
});
