// SPECIES-AGNOSTIC body ACTIVITIES (sleep / eat / sit / play) for the creature
// rig — the visuals the Spirit Dollhouse uses to SHOW what a family member is
// doing. Everything is posture/pose modulation through the same solvers every
// body plan rides (no per-species keyframes), so the suite runs each activity
// over several registry species.
//
// Uses the creature core (blueprint / animator / avatar factory) — pure math
// plus headless THREE groups, like world-engine-pointing.test.ts.

import { describe, it, expect } from "@jest/globals";
import { CreatureAnimator, type BodyActivity } from "@shared/world-engine/creatures/animation.js";
import { speciesBlueprint } from "@shared/world-engine/creatures/species.js";
import { createCreatureAvatarFactory } from "@shared/world-engine/creatures/creature-model.js";
import type { AvatarFrame } from "@shared/world-engine/render3d.js";
import type { AvatarActivity } from "@shared/world-engine/engine.js";

const SPECIES = ["human_cute", "frog_person"] as const;

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

      it("play bounces — bodyHeight oscillates around the settled pose", () => {
        const anim = new CreatureAnimator(speciesBlueprint(sp));
        anim.setActivity("play");
        settle(anim, 2); // blend fully in
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < 60; i++) {
          const f = anim.update(1 / 30);
          min = Math.min(min, f.posture.bodyHeight);
          max = Math.max(max, f.posture.bodyHeight);
        }
        expect(max - min).toBeGreaterThan(0.02);
      });

      it("eat rhythm: a handed kind carries a hand to its mouth", () => {
        const anim = new CreatureAnimator(speciesBlueprint(sp));
        anim.setActivity("eat");
        settle(anim, 2);
        let sawHand = false;
        let maxHandY = -Infinity;
        for (let i = 0; i < 60; i++) {
          const f = anim.update(1 / 30);
          const lt = f.pose.limbTargets ?? [];
          if (lt.length === 1) {
            sawHand = true;
            maxHandY = Math.max(maxHandY, lt[0]!.target.y);
          }
        }
        expect(sawHand).toBe(true); // every people species has a graspable hand
        expect(maxHandY).toBeGreaterThan(0); // rises toward the mouth, not the floor
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
    for (const sp of ["human_cute", "frog_person"]) {
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
