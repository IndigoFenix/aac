// FURNITURE-USE ANCHORING + slide-in easing (regression suite).
//
// A resident that SLEEPS on a bed, SITS on a chair or a toilet (toilet), or eats
// at a table must settle ONTO the piece's use-point — never float beside it,
// sink into it, or teleport on/off. The anchor is display-only (the sim keeps
// the body standing beside the solid fixture; the renderer slides it on), so
// this locks the pure pieces that decide WHERE it lands and HOW it eases there:
//   • the seat/bed use-point fractions (object-models.ts),
//   • the sitter/sleeper YAW derived purely from the fixture's own facing —
//     so an axis-aligned (axisFaceInto) piece is seated square, not on the old
//     diagonal (render3d.ts),
//   • the avatar factory's slide onto the anchor and the EASED slide off it when
//     the body stands to walk (creature-model.ts), which used to SNAP.
//
// Creature core + headless THREE groups, like world-engine-activities.test.ts —
// DB-free, runs in `npm run test:engine`.

import { describe, it, expect } from "@jest/globals";
import { CreatureAnimator } from "@shared/world-engine/creatures/animation.js";
import { speciesBlueprint } from "@shared/world-engine/creatures/species.js";
import { buildSkeleton } from "@shared/world-engine/creatures/skeleton.js";
import { createCreatureAvatarFactory, createDynamicCreature } from "@shared/world-engine/creatures/creature-model.js";
import { sitterYaw, bedSleeperYaw, rigYawTo } from "@shared/world-engine/render3d.js";
import { SEAT_TOP_FRAC, BED_TOP_FRAC } from "@shared/world-engine/object-models.js";
import type { AvatarFrame } from "@shared/world-engine/render3d.js";
import type { AvatarActivity } from "@shared/world-engine/engine.js";

type Anchor = { x: number; y: number; z: number; yaw: number };

const frame = (opts: {
  activity?: AvatarActivity;
  anchor?: Anchor;
  speed?: number;
} = {}): AvatarFrame =>
  ({
    state: { x: 0, y: 0, fx: 0, fy: 1, activity: opts.activity },
    speed: opts.speed ?? 0,
    activityAnchor: opts.anchor,
  } as unknown as AvatarFrame);

const AXES = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

describe("seat/bed use-points exist for every sittable/sleepable piece", () => {
  it("a chair and a toilet (toilet) both carry a seat-top fraction", () => {
    expect(SEAT_TOP_FRAC.chair).toBeGreaterThan(0);
    expect(SEAT_TOP_FRAC.toilet).toBeGreaterThan(0);
  });
  it("a bed carries a lie-on fraction", () => {
    expect(BED_TOP_FRAC).toBeGreaterThan(0);
    expect(BED_TOP_FRAC).toBeLessThan(1); // the body lies ON the mattress, not above it
  });
});

describe("anchor YAW follows the piece's OWN facing (axis-aligned, not diagonal)", () => {
  it("a sitter faces exactly where the chair faces", () => {
    for (const facing of AXES) {
      expect(sitterYaw(facing)).toBeCloseTo(rigYawTo(facing), 6);
    }
  });
  it("distinct axis facings give distinct seated yaws (no collapse to one heading)", () => {
    const yaws = AXES.map((f) => ((sitterYaw(f) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
    expect(new Set(yaws.map((y) => y.toFixed(4))).size).toBe(AXES.length);
  });
  it("a sleeper's heading is a pure function of the bed's facing (deterministic)", () => {
    for (const facing of AXES) {
      expect(bedSleeperYaw(facing)).toBeCloseTo(bedSleeperYaw(facing), 6);
      expect(Number.isFinite(bedSleeperYaw(facing))).toBe(true);
    }
  });
  it("undefined facing is tolerated (a piece placed without an explicit angle)", () => {
    expect(Number.isFinite(sitterYaw(undefined))).toBe(true);
    expect(Number.isFinite(bedSleeperYaw(undefined))).toBe(true);
  });
});

describe("the body settles ON the use-point, centred, and RESTS on a seat (never floats)", () => {
  // A non-local id is baked until it acts; the activity spins up a dynamic body
  // that slides onto the anchor. With the render root at the origin (x:0,y:0) the
  // body's LOCAL position IS the anchor coords — an exact XZ match means no
  // horizontal offset. The Y is the crux this suite exists for: the anchor names
  // the seat SURFACE, but the body's origin is its FEET, so parking the origin on
  // the surface (the old behaviour) FLOATED a seated body a hip-height above the
  // chair/toilet. A sitter must be DROPPED so its underside rests on the seat and
  // its feet hang toward the floor; a sleeper (its recline re-centres the lying
  // body) keeps its origin ON the mattress. `restsOn` marks the drop cases.
  const cases: Array<{ name: string; kind: AvatarActivity["kind"]; objId: string; restsOn: boolean; anchorOf: (f: number) => Anchor }> = [
    { name: "sleep on a bed", kind: "sleep", objId: "furn_0_bed_0", restsOn: false, anchorOf: (f) => ({ x: 1.0, y: 0.55, z: -0.4, yaw: bedSleeperYaw(f) }) },
    { name: "sit on a chair", kind: "sit", objId: "furn_0_chair_0", restsOn: true, anchorOf: (f) => ({ x: 0.6, y: 0.45, z: 0.3, yaw: sitterYaw(f) }) },
    { name: "sit on a toilet", kind: "sit", objId: "furn_0_toilet_0", restsOn: true, anchorOf: (f) => ({ x: -0.5, y: 0.4, z: 0.2, yaw: sitterYaw(f) }) },
  ];
  for (const c of cases) {
    for (const facing of [0, Math.PI / 2]) {
      it(`${c.name} (facing ${facing.toFixed(2)}) is centred on the piece and ${c.restsOn ? "dropped onto the seat" : "lies on the surface"}`, () => {
        const factory = createCreatureAvatarFactory({ speciesFor: () => "human_cute", heightM: 1.7 });
        const npc = factory("resident_0_1", false);
        npc.update(frame(), 1 / 30); // baked idle
        const anchor = c.anchorOf(facing);
        for (let i = 0; i < 120; i++) npc.update(frame({ activity: { kind: c.kind, objId: c.objId }, anchor }), 1 / 30);
        const body = npc.object.children[0]!;
        // Horizontal: dead-centre on the fixture, every facing.
        expect(body.position.x).toBeCloseTo(anchor.x, 1);
        expect(body.position.z).toBeCloseTo(anchor.z, 1);
        if (c.restsOn) {
          // The FIX: the sitter is dropped a real hip-height below the seat
          // SURFACE so it rests on it — never left with its feet-origin on the
          // surface (the float). And never punched through the floor.
          expect(body.position.y).toBeLessThan(anchor.y - 0.15);
          expect(body.position.y).toBeGreaterThanOrEqual(0);
        } else {
          // The sleeper's origin stays ON the mattress (recline re-centres it).
          expect(body.position.y).toBeCloseTo(anchor.y, 1);
        }
        npc.dispose();
      });
    }
  }

  it("a seated body's underside lands ON the seat surface (drop ≈ crouched hip height)", () => {
    // The unit under the integration above: a dynamic body exposes the world-meter
    // drop that lands its torso underside on the seat. Seated, it is a real,
    // POSITIVE hip-height and SMALLER than when the same body stands (the crouch
    // lowers the torso) — the exact quantity resolveActivityAnchor's seat-surface
    // height is offset by, so `anchor.y - drop` is where the origin ends up.
    const model = createDynamicCreature("human_cute", { heightM: 1.7 });
    for (let i = 0; i < 60; i++) model.update(1 / 30); // steady stand
    const standing = model.seatDropWorld;
    for (let i = 0; i < 120; i++) model.update(1 / 30, { activity: "sit" });
    const seated = model.seatDropWorld;
    expect(standing).toBeGreaterThan(0);
    expect(seated).toBeGreaterThan(0.1); // a real drop, not ~0 (which would float)
    expect(seated).toBeLessThan(standing); // crouching into the seat lowers the underside
    expect(seated).toBeLessThan(1.7); // below full body height — a hip, not the head
    model.dispose();
  });

  it("an eat-at-table meal with no seat poses in place (no phantom slide beside the table)", () => {
    // "eat" is NOT an anchored activity — the diner stands at its table stand-point
    // and reaches; the body must not be dragged to any fixture centre.
    const factory = createCreatureAvatarFactory({ speciesFor: () => "human_cute", heightM: 1.7 });
    const npc = factory("resident_0_2", false);
    for (let i = 0; i < 60; i++) npc.update(frame({ activity: { kind: "eat", objId: "furn_0_table_0" } }), 1 / 30);
    const body = npc.object.children[0]!;
    expect(body.position.x).toBe(0);
    expect(body.position.z).toBe(0);
    npc.dispose();
  });
});

describe("the slide onto and off a seat EASES — no snap (LAW: no snap while visible)", () => {
  const anchor: Anchor = { x: 1.2, y: 0.45, z: 0.6, yaw: sitterYaw(0) };

  it("slides IN over several frames (an intermediate frame is partway, not already seated)", () => {
    const factory = createCreatureAvatarFactory({ speciesFor: () => "human_cute", heightM: 1.7 });
    const npc = factory("resident_0_3", false);
    npc.update(frame(), 1 / 30);
    const xs: number[] = [];
    for (let i = 0; i < 20; i++) {
      npc.update(frame({ activity: { kind: "sit", objId: "furn_0_chair_0" }, anchor }), 1 / 30);
      xs.push(npc.object.children[0]!.position.x);
    }
    // An early frame is genuinely BETWEEN the stand point (0) and the seat — a
    // snap would jump 0 → anchor in one frame with nothing in between.
    const partway = xs.slice(0, 8).some((x) => x > 0.05 && x < anchor.x * 0.9);
    expect(partway).toBe(true);
    expect(xs.at(-1)!).toBeCloseTo(anchor.x, 1); // fully seated by the end
    npc.dispose();
  });

  it("slides OFF as the body stands to walk — the sim-speed spike does NOT teleport it off", () => {
    const factory = createCreatureAvatarFactory({ speciesFor: () => "human_cute", heightM: 1.7 });
    const npc = factory("resident_0_4", false);
    // Seat it.
    for (let i = 0; i < 120; i++) npc.update(frame({ activity: { kind: "sit", objId: "furn_0_chair_0" }, anchor }), 1 / 30);
    expect(npc.object.children[0]!.position.x).toBeCloseTo(anchor.x, 1);
    // Stand up: clear the activity AND spike the sim velocity to a full walk in
    // ONE frame (exactly what the sim does when the dwell ends and the next
    // errand issues). Read raw, that speed would zero the slide and SNAP the body
    // off the seat; eased off the animator's smoothed dial it must still be near
    // the seat this first frame.
    npc.update(frame({ speed: 3.5 }), 1 / 30);
    const firstX = npc.object.children[0]!.position.x;
    expect(firstX).toBeGreaterThan(anchor.x * 0.4); // did NOT snap to the stand point
    // …then it eases off over the next frames and returns toward the stand point.
    for (let i = 0; i < 30; i++) npc.update(frame({ speed: 3.5 }), 1 / 30);
    expect(npc.object.children[0]!.position.x).toBeLessThan(anchor.x * 0.3);
    npc.dispose();
  });
});

describe("a carry/reach gesture crouch RELEASES when the body starts to move (item 1)", () => {
  // The crouch feedback is a closed LOOP: it deepens until the observed hand
  // reaches the target, so the animator must be driven with its skeleton, like
  // the bake path. A body still crouched over a just-opened container must stand
  // up the moment its next travel begins — never glide off locked in the crouch.
  function driver(sp: string) {
    const bp = speciesBlueprint(sp);
    const anim = new CreatureAnimator(bp);
    const step = (dt: number) => {
      const f = anim.update(dt);
      bp.posture.bodyPitch = f.posture.bodyPitch;
      bp.posture.bodyHeight = f.posture.bodyHeight;
      anim.observe(buildSkeleton(bp, f.gait, f.pose));
      return f;
    };
    return { anim, step };
  }

  it("stands up while walking away instead of gliding along crouched", () => {
    const { anim, step } = driver("human_cute");
    const base = anim.update(0).posture.bodyHeight;
    // Reach low for a container's contents — the hand can't get there upright, so
    // the feedback folds the body into a deep crouch while it stands still.
    anim.pickUp({ x: 0.1, y: 0.05, z: 0.45 }, 0);
    let f = step(1 / 60);
    for (let t = 0; t < 0.8; t += 1 / 60) f = step(1 / 60);
    const crouchedHeight = f.posture.bodyHeight;
    expect(crouchedHeight).toBeLessThan(base * 0.9); // genuinely crouched

    // The next leg begins — the body accelerates to a walk.
    anim.setSpeed(0.7);
    for (let t = 0; t < 0.5; t += 1 / 60) f = step(1 / 60);
    // The crouch has released: the body rose well back toward standing height
    // (a body still stuck in the reach crouch would stay near crouchedHeight).
    expect(f.posture.bodyHeight).toBeGreaterThan((crouchedHeight + base) / 2);
  });
});
