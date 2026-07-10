// Anatomically-aware POINTING for the creature system: which limb a creature
// raises to point ("furthest-extendable limb not needed for balance"), and the
// point() action's raise → hold → drop dynamics.
//
// Uses the creature core (blueprint / animator) — pure math, no GL — so it runs
// headless in `npm test`.

import { describe, it, expect } from "@jest/globals";
import { CreatureAnimator, pickPointLimb } from "@shared/world-engine/creatures/animation.js";
import { speciesBlueprint } from "@shared/world-engine/creatures/species.js";
import {
  createCreatureAvatarFactory,
  gestureLocalDir,
} from "@shared/world-engine/creatures/creature-model.js";
import type { Blueprint, LimbGroupBlueprint } from "@shared/world-engine/creatures/blueprint.js";
import type { AvatarFrame } from "@shared/world-engine/render3d.js";

/** A limb group carrying only the fields pickPointLimb reads. */
function limb(p: { lengthFrac: number; stationStart: number; membrane?: number }): LimbGroupBlueprint {
  return { placement: "bilateral", membrane: 0, ...p } as unknown as LimbGroupBlueprint;
}
const body = (limbGroups: LimbGroupBlueprint[]): Blueprint => ({ limbGroups } as unknown as Blueprint);

describe("pickPointLimb — anatomy, not a hardcoded arm", () => {
  it("a humanoid points with its arm (the free limb shorter than its legs)", () => {
    const legs = limb({ lengthFrac: 1.0, stationStart: 0.85 });
    const arms = limb({ lengthFrac: 0.6, stationStart: 0.2 });
    // group 0 = legs, group 1 = arms → the arm is chosen.
    expect(pickPointLimb(body([legs, arms]))).toBe(1);
  });

  it("a quadruped (all legs) spares and raises a FRONT limb", () => {
    // Two full-length leg groups, none clearly shorter → front pair (lower
    // stationStart = nearer the chest) is sparable on tripod balance.
    const front = limb({ lengthFrac: 1.0, stationStart: 0.2 });
    const back = limb({ lengthFrac: 1.0, stationStart: 0.85 });
    expect(pickPointLimb(body([front, back]))).toBe(0);
  });

  it("picks the FURTHEST-reaching of several free limbs", () => {
    const legs = limb({ lengthFrac: 1.2, stationStart: 0.85 });
    const shortArm = limb({ lengthFrac: 0.5, stationStart: 0.2 });
    const longArm = limb({ lengthFrac: 0.8, stationStart: 0.2 });
    expect(pickPointLimb(body([legs, shortArm, longArm]))).toBe(2);
  });

  it("ignores membranous limbs (a wing can't point)", () => {
    const legs = limb({ lengthFrac: 1.0, stationStart: 0.85 });
    const wings = limb({ lengthFrac: 0.9, stationStart: 0.2, membrane: 0.8 });
    // Only the legs remain — one leg group, nothing sparable → no point limb.
    expect(pickPointLimb(body([legs, wings]))).toBe(-1);
  });

  it("a single leg group has nothing to spare (returns -1 → host turns the body)", () => {
    expect(pickPointLimb(body([limb({ lengthFrac: 1.0, stationStart: 0.85 })]))).toBe(-1);
  });

  it("human_cute (a real NPC body) can point", () => {
    expect(pickPointLimb(speciesBlueprint("human_cute"))).toBeGreaterThanOrEqual(0);
  });
});

describe("point() action — raise, hold, drop", () => {
  function step(anim: CreatureAnimator, seconds: number, dt = 1 / 30) {
    let f = anim.update(0);
    for (let t = 0; t < seconds; t += dt) f = anim.update(dt);
    return f;
  }

  it("raises the chosen limb toward the direction, upright, hand open", () => {
    const anim = new CreatureAnimator(speciesBlueprint("human_cute"));
    expect(anim.canPoint()).toBe(true);
    const base = anim.update(0);

    expect(anim.point({ x: 1, y: 0, z: 0.2 }, 1.0)).toBe(true); // point +x (right)
    const f = step(anim, 0.5); // through the raise, into the hold

    expect(["point", "point-hold"]).toContain(f.action);
    const lt = f.pose.limbTargets ?? [];
    expect(lt).toHaveLength(1);
    expect(lt[0]!.target.x).toBeGreaterThan(0); // arm extends toward +x
    expect(lt[0]!.grip ?? 0).toBeLessThan(0.3); // open hand, not a fist
    // Upright: pointing must not crouch/fold like a pick-up.
    expect(f.posture.bodyHeight).toBeCloseTo(base.posture.bodyHeight, 1);
  });

  it("mirrors to the other side when pointing the other way", () => {
    const right = new CreatureAnimator(speciesBlueprint("human_cute"));
    right.point({ x: 1, y: 0, z: 0 });
    right.update(0);
    const rf = right.update(0.2);
    const left = new CreatureAnimator(speciesBlueprint("human_cute"));
    left.point({ x: -1, y: 0, z: 0 });
    left.update(0);
    const lf = left.update(0.2);
    expect(rf.pose.limbTargets![0]!.side).toBe(1);
    expect(lf.pose.limbTargets![0]!.side).toBe(-1);
  });

  it("drops the limb and returns to rest after the hold", () => {
    const anim = new CreatureAnimator(speciesBlueprint("human_cute"));
    anim.point({ x: 0, y: 0, z: 1 }, 0.4);
    const f = step(anim, 2.5); // raise + hold + drop + settle
    expect(f.action).toBe("none");
    expect(f.pose.limbTargets ?? []).toHaveLength(0);
  });

  it("won't start a second point while one is running", () => {
    const anim = new CreatureAnimator(speciesBlueprint("human_cute"));
    expect(anim.point({ x: 1, y: 0, z: 0 })).toBe(true);
    anim.update(0.1);
    expect(anim.point({ x: -1, y: 0, z: 0 })).toBe(false);
  });
});

describe("gestureLocalDir — world target → body-local frame (+Z forward, +X right)", () => {
  it("a target dead ahead reads as forward (+Z)", () => {
    // Facing north (+y); target to the north.
    const d = gestureLocalDir({ targetX: 0, targetY: 10 }, 0, 0, 0, 1);
    expect(d.z).toBeGreaterThan(0);
    expect(Math.abs(d.x)).toBeLessThan(1e-6);
  });

  it("a target to the avatar's right reads as +X", () => {
    // Facing north (+y); target due east → the avatar's right hand.
    const d = gestureLocalDir({ targetX: 10, targetY: 0 }, 0, 0, 0, 1);
    expect(d.x).toBeGreaterThan(0);
    expect(Math.abs(d.z)).toBeLessThan(1e-6);
  });

  it("rotates with the avatar's facing", () => {
    // Facing EAST (+x); a target to the north is now on the avatar's LEFT (−X).
    const d = gestureLocalDir({ targetX: 0, targetY: 10 }, 0, 0, 1, 0);
    expect(d.x).toBeLessThan(0);
    expect(Math.abs(d.z)).toBeLessThan(1e-6);
  });
});

describe("creature avatar factory — NPC gesture drive", () => {
  const frame = (gesture?: AvatarFrame["state"]["gesture"]): AvatarFrame =>
    ({ state: { x: 0, y: 0, fx: 0, fy: 1, gesture }, speed: 0 } as unknown as AvatarFrame);

  it("performs a one-shot point on a baked NPC without throwing, then settles", () => {
    const factory = createCreatureAvatarFactory({ speciesFor: () => "human_cute", heightM: 1.7 });
    const npc = factory("resident_1", false); // non-local → baked until it gestures
    expect(() => npc.update(frame(), 1 / 30)).not.toThrow();

    // Fire the point, then drive through raise + hold + drop.
    npc.update(frame({ kind: "point", targetX: 10, targetY: 0, holdS: 0.4, id: 1 }), 1 / 30);
    for (let i = 0; i < 120; i++) npc.update(frame(), 1 / 30);
    // Still a live, drawable object afterward.
    expect(npc.object.children.length).toBeGreaterThan(0);
    npc.dispose();
  });
});
