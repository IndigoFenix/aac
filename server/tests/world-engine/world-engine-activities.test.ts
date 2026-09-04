// SPECIES-AGNOSTIC body ACTIVITIES (sleep / eat / sit / play) for the creature
// rig — the visuals the Spirit Dollhouse uses to SHOW what a family member is
// doing. Everything is posture/pose modulation through the same solvers every
// body plan rides (no per-species keyframes), so the suite runs each activity
// over several registry species.
//
// Uses the creature core (blueprint / animator / avatar factory) — pure math
// plus headless THREE groups, like world-engine-pointing.test.ts.

import { describe, it, expect } from "@jest/globals";
import * as THREE from "three";
import {
  CreatureAnimator,
  pickHandGroup,
  type BodyActivity,
} from "@shared/world-engine/creatures/animation.js";
import { speciesBlueprint } from "@shared/world-engine/creatures/species.js";
import {
  createCreatureAvatarFactory,
  createDynamicCreature,
  reclinePitch,
  reclineSeat,
} from "@shared/world-engine/creatures/creature-model.js";
import type { AvatarFrame } from "@shared/world-engine/render3d.js";
import type { AvatarActivity } from "@shared/world-engine/engine.js";

// A HANDED kind and a HANDLESS one — the pair is the point: these activities
// are posture modulation over whatever body plan the builder made, so the suite
// is only honest if the cast spans body plans. (`frog_person` stood here until
// 2026-09-01; the authored animal people retired into the `animal_people` mod,
// and a person derived from an undrawn stub base is itself a stub.)
const SPECIES = ["human_cute", "dog"] as const;

function settle(anim: CreatureAnimator, seconds: number, dt = 1 / 30) {
  let f = anim.update(0);
  for (let t = 0; t < seconds; t += dt) f = anim.update(dt);
  return f;
}

describe("CreatureAnimator activities — rig-level, species-agnostic", () => {
  for (const sp of SPECIES) {
    describe(sp, () => {
      it("sit folds the legs (lower bodyHeight), no recline", () => {
        const anim = new CreatureAnimator(speciesBlueprint(sp));
        const base = anim.update(0).posture.bodyHeight;
        anim.setActivity("sit");
        const f = settle(anim, 2);
        expect(f.posture.bodyHeight).toBeLessThan(base * 0.7);
        expect(f.recline ?? 0).toBe(0);
        expect(anim.currentActivity).toBe("sit");
      });

      it("sleep reclines fully, then blends back out on wake", () => {
        const anim = new CreatureAnimator(speciesBlueprint(sp));
        anim.setActivity("sleep");
        const asleep = settle(anim, 2);
        expect(asleep.recline).toBeCloseTo(1, 1);
        expect(anim.activityBusy()).toBe(true);
        // Wake: the pose eases out and the temporary-body guard clears.
        anim.setActivity("none");
        const awake = settle(anim, 2);
        expect(awake.recline ?? 0).toBe(0);
        expect(anim.activityBusy()).toBe(false);
        expect(anim.currentActivity).toBe("none");
      });

      // PLAY is a body DOWN OVER A SPOT, not a bounce in place
      // (toys-and-song-expansion.md): the legs fold, the trunk bows forward, and
      // the front limbs work at something on the ground just ahead.
      it("play crouches and bows over the play spot", () => {
        const anim = new CreatureAnimator(speciesBlueprint(sp));
        const base = anim.update(0).posture;
        anim.setActivity("play");
        const f = settle(anim, 2);
        expect(f.posture.bodyHeight).toBeLessThan(base.bodyHeight);
        // Negative pitch = bowed forward, over the toy.
        expect(f.posture.bodyPitch).toBeLessThan(base.bodyPitch);
        expect(anim.currentActivity).toBe("play");
      });

      it("play works the front limbs at a low spot IN FRONT, in alternation", () => {
        const anim = new CreatureAnimator(speciesBlueprint(sp));
        const rest = anim.update(0);
        anim.setActivity("play");
        settle(anim, 2); // blend fully in
        const restY = rest.pose.limbTargets?.[0]?.target.y;
        let sawPair = false;
        let minY = Infinity;
        let maxForward = -Infinity;
        let maxSideSpread = 0;
        for (let i = 0; i < 60; i++) {
          const lt = anim.update(1 / 30).pose.limbTargets ?? [];
          if (lt.length !== 2) continue;
          sawPair = true;
          for (const t of lt) {
            minY = Math.min(minY, t.target.y);
            maxForward = Math.max(maxForward, t.target.z);
          }
          // The two sides stroke half a cycle apart, so at almost every instant
          // they are at DIFFERENT heights — the alternation the plan asks for
          // ("moving the items"), not a synchronised paw-press.
          maxSideSpread = Math.max(maxSideSpread, Math.abs(lt[0]!.target.y - lt[1]!.target.y));
        }
        expect(sawPair).toBe(true); // both front limbs drive, hands or legs
        expect(maxForward).toBeGreaterThan(0); // the spot is FORWARD (+Z) of the body
        expect(maxSideSpread).toBeGreaterThan(0);
        // And the working hands come down near the ground — well below wherever
        // they hang at rest.
        if (restY !== undefined) expect(minY).toBeLessThan(restY);
      });

      it("play releases: the pose blends back out when the activity clears", () => {
        const anim = new CreatureAnimator(speciesBlueprint(sp));
        const base = anim.update(0).posture;
        anim.setActivity("play");
        settle(anim, 2);
        anim.setActivity("none");
        const done = settle(anim, 2);
        expect(done.posture.bodyHeight).toBeCloseTo(base.bodyHeight, 1);
        expect(done.pose.limbTargets ?? []).toHaveLength(0);
      });

      it("eat rhythm: a handed kind carries a hand to its mouth, a handless one bows", () => {
        // The rig's own rule (animation.ts): eat is "a periodic hand-to-mouth
        // for a handed kind, a bow for the rest". Handedness is DERIVED from
        // the blueprint via pickHandGroup — never a list of species names, or
        // the pin would go stale the next time the registry moves.
        const bp = speciesBlueprint(sp);
        const handed = pickHandGroup(bp) >= 0;
        const anim = new CreatureAnimator(bp);
        const restPitch = anim.update(0).posture.bodyPitch;
        anim.setActivity("eat");
        settle(anim, 2);
        let sawHand = false;
        let maxHandY = -Infinity;
        let maxBow = 0;
        for (let i = 0; i < 60; i++) {
          const f = anim.update(1 / 30);
          const lt = f.pose.limbTargets ?? [];
          if (lt.length === 1) {
            sawHand = true;
            maxHandY = Math.max(maxHandY, lt[0]!.target.y);
          }
          maxBow = Math.max(maxBow, Math.abs(f.posture.bodyPitch - restPitch));
        }
        expect(sawHand).toBe(handed);
        if (handed) {
          expect(maxHandY).toBeGreaterThan(0); // rises toward the mouth, not the floor
        } else {
          expect(maxBow).toBeGreaterThan(0); // the trunk bows instead
        }
      });
    });
  }

  it("eat on a handless kind bows to the plate instead (pitch dips)", () => {
    const anim = new CreatureAnimator(speciesBlueprint("sheep"));
    const base = anim.update(0).posture.bodyPitch;
    anim.setActivity("eat");
    settle(anim, 2);
    let minPitch = Infinity;
    for (let i = 0; i < 60; i++) minPitch = Math.min(minPitch, anim.update(1 / 30).posture.bodyPitch);
    expect(minPitch).toBeLessThan(base - 0.1);
  });

  it("walking dissolves the activity pose (a woken sleeper stands and goes)", () => {
    const anim = new CreatureAnimator(speciesBlueprint("human_cute"));
    anim.setActivity("sleep");
    settle(anim, 2);
    anim.setSpeed(0.6);
    const f = settle(anim, 2);
    expect(f.recline ?? 0).toBe(0);
  });

  it("a kind change blends through zero (sleep → play never snaps)", () => {
    const anim = new CreatureAnimator(speciesBlueprint("human_cute"));
    anim.setActivity("sleep");
    settle(anim, 2);
    anim.setActivity("play");
    // Immediately after the switch the OLD pose is still easing out.
    const f = anim.update(1 / 30);
    expect(f.recline ?? 0).toBeGreaterThan(0.5);
    expect(anim.currentActivity).toBe("sleep");
    settle(anim, 2);
    expect(anim.currentActivity).toBe("play");
  });
});

// LYING DOWN is a root transform, and it has to work for a body plan that is
// already HORIZONTAL: a fixed quarter-turn lays a person on their back but
// stands a horse on its tail. The rule is "put the BACK on the ground", which
// for any rest spine pitch p is a turn of p − π about the body's X axis.
describe("recline — the back goes to the ground for any posture", () => {
  /** The body's dorsal (back) direction for a spine pitched at `p`, turned by
   *  the recline's root pitch: where the creature's back ends up pointing. */
  const dorsalAfter = (p: number, pitch: number): THREE.Vector3 =>
    new THREE.Vector3(0, Math.cos(p), -Math.sin(p)).applyAxisAngle(new THREE.Vector3(1, 0, 0), pitch);

  // A rough body's skin: a slab standing on the plane, deeper at the front than
  // the back, so its AABB corners are demonstrably NOT on the body.
  const skin = [0, 0, 0, 0, 0, 0.4, 0, 1, -0.5, 0, 1, 0.1, 0, 0.5, -0.2];
  const verts = skin.length / 3;
  const lowest = (angle: number, seatY: number): number => {
    let low = Infinity;
    for (let i = 0; i < verts; i++) {
      const v = new THREE.Vector3(0, skin[i * 3 + 1], skin[i * 3 + 2])
        .applyAxisAngle(new THREE.Vector3(1, 0, 0), angle);
      low = Math.min(low, v.y + seatY);
    }
    return low;
  };

  it("standing (recline 0) moves nothing", () => {
    for (const p of [0.08, 0.85, 1.386]) {
      expect(reclinePitch(p, 0)).toBeCloseTo(0, 6);
      const seat = reclineSeat(skin, verts, 0);
      expect(seat.y).toBeCloseTo(0, 6);
      expect(seat.z).toBeCloseTo(0, 6);
    }
  });

  it("lands the back facing straight down from UPRIGHT, HORIZONTAL and between", () => {
    // 1.386 = a person; 0.0845 = a horse; 0.85 = a raptor's slant.
    for (const p of [1.386, 0.85, 0.3, 0.0845, -0.2]) {
      expect(dorsalAfter(p, reclinePitch(p, 1)).y).toBeCloseTo(-1, 6);
    }
  });

  it("a horizontal body rolls the whole way over — it is NOT stood on its tail", () => {
    const pitch = reclinePitch(0.0845, 1);
    // The old fixed −π/2 left a horizontal spine VERTICAL. The spine must end
    // flat: its axis (0, sin p, cos p) has no height left after the turn.
    const spine = new THREE.Vector3(0, Math.sin(0.0845), Math.cos(0.0845))
      .applyAxisAngle(new THREE.Vector3(1, 0, 0), pitch);
    expect(spine.y).toBeCloseTo(0, 6);
    expect(Math.abs(pitch)).toBeGreaterThan(Math.PI / 2); // well past the old quarter-turn
  });

  it("eases in — half a recline is half the turn", () => {
    expect(reclinePitch(1.386, 0.5)).toBeCloseTo(reclinePitch(1.386, 1) / 2, 6);
  });

  it("rests the lying body ON the surface and centres it where it stood", () => {
    const restLow = Math.min(...Array.from({ length: verts }, (_, i) => skin[i * 3 + 1]));
    const zs = Array.from({ length: verts }, (_, i) => skin[i * 3 + 2]);
    const restMid = (Math.min(...zs) + Math.max(...zs)) / 2;
    // Upright, horizontal, and the DIAGONAL between — where a rotated bounding
    // box would hang the body off a corner that holds no geometry, floating it.
    for (const p of [1.386, 0.85, 0.0845]) {
      const pitch = reclinePitch(p, 1);
      const seat = reclineSeat(skin, verts, pitch);
      expect(lowest(pitch, seat.y)).toBeCloseTo(restLow, 6); // on it, not sunk in it
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < verts; i++) {
        const v = new THREE.Vector3(0, skin[i * 3 + 1], skin[i * 3 + 2])
          .applyAxisAngle(new THREE.Vector3(1, 0, 0), pitch);
        minZ = Math.min(minZ, v.z + seat.z);
        maxZ = Math.max(maxZ, v.z + seat.z);
      }
      // Centred fore/aft where the STANDING body already was — the offsets are
      // differences against the un-turned pose, so recline 0 shifts nothing.
      expect((minZ + maxZ) / 2).toBeCloseTo(restMid, 6);
    }
  });
});

describe("a sleeping body lies down on the surface it sleeps on", () => {
  /** Vertex-exact world bounds of the drawn body after `seconds` of `activity`
   *  (`precise`, or three unions the mesh's own AABB rotated corner-wise —
   *  which for a reclined body is a box full of air). */
  const bodyBox = (species: string, activity: BodyActivity, seconds: number): THREE.Box3 => {
    const model = createDynamicCreature(species, { heightM: 1.7 });
    for (let t = 0; t < seconds; t += 1 / 30) model.update(1 / 30, { activity });
    model.object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model.object, true);
    model.dispose();
    return box;
  };

  // human_cute is upright; horse is horizontal with a HIGH neck and a raised
  // tail — the two ends that used to drive through the floor. cat carries a
  // long tail and a low slung body.
  for (const sp of ["human_cute", "horse", "cat"]) {
    it(`${sp}: down along the ground, and nothing through it`, () => {
      const box = bodyBox(sp, "sleep", 2);
      const size = box.getSize(new THREE.Vector3());
      // Lying, not standing and not balancing on its tail: the body reaches
      // much further along the ground than it does up from it.
      expect(size.y).toBeLessThan(size.z * 0.6);
      // And it rests ON the surface — the neck, tail or back never sink
      // through it (only the breathing bob dips, a couple of centimetres).
      expect(box.min.y).toBeGreaterThan(-0.05);
      expect(box.min.y).toBeLessThan(0.05);
    });

    it(`${sp}: stands unchanged when it is not sleeping`, () => {
      const box = bodyBox(sp, "none", 1);
      const size = box.getSize(new THREE.Vector3());
      expect(size.y).toBeGreaterThan(size.z * 0.25); // still up on its legs
      expect(Math.abs(box.min.y)).toBeLessThan(0.05); // feet on the ground
    });
  }
});

describe("creature avatar factory — the activity channel end-to-end", () => {
  const frame = (
    activity?: AvatarActivity,
    activityAnchor?: AvatarFrame["activityAnchor"],
  ): AvatarFrame =>
    ({ state: { x: 0, y: 0, fx: 0, fy: 1, activity }, speed: 0, activityAnchor } as unknown as AvatarFrame);

  it("a sleeping baked NPC lies onto its resolved bed anchor, then retires on wake", () => {
    const factory = createCreatureAvatarFactory({ speciesFor: () => "human_cute", heightM: 1.7 });
    const npc = factory("resident_0_1", false); // non-local → baked until it acts
    npc.update(frame(), 1 / 30);
    const bakedBody = npc.object.children[0]!;

    // Fall asleep on a bed 1 world unit away, top at 0.6.
    const anchor = { x: 1, y: 0.6, z: 0, yaw: Math.PI / 2 };
    for (let i = 0; i < 90; i++) npc.update(frame({ kind: "sleep", objId: "furn_0_bed_0" }, anchor), 1 / 30);
    const sleeping = npc.object.children[0]!;
    expect(sleeping).not.toBe(bakedBody); // a dynamic body was spun up
    // The body slid onto the bed: its local offset approaches the anchor delta
    // (the renderer keeps the root at the avatar's stand position, 0,0,0 here).
    expect(sleeping.position.x).toBeCloseTo(1, 1);
    expect(sleeping.position.y).toBeCloseTo(0.6, 1);

    // Wake: activity clears, the pose blends out, the dynamic body retires.
    for (let i = 0; i < 120; i++) npc.update(frame(), 1 / 30);
    expect(npc.object.children[0]).toBe(bakedBody);
    npc.dispose();
  });

  it("an activity without an anchor plays out in place for every species", () => {
    for (const sp of ["human_cute", "dog"]) {
      const factory = createCreatureAvatarFactory({ speciesFor: () => sp, heightM: 1.7 });
      const npc = factory("resident_0_2", false);
      for (const kind of ["sleep", "eat", "sit", "play"] as Exclude<BodyActivity, "none">[]) {
        for (let i = 0; i < 60; i++) {
          expect(() => npc.update(frame({ kind }), 1 / 30)).not.toThrow();
        }
        const body = npc.object.children[0]!;
        expect(body.position.x).toBe(0); // no anchor → no slide
      }
      npc.dispose();
    }
  });
});
