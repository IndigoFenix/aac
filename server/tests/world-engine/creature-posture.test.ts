// POSTURE NEGOTIATION + THE NECK REACH CHANNEL (phase 3).
//
// `bodyPitch` and `bodyHeight` are DESIRES that the support legs can veto:
// the body may not stand where a leg it stands on cannot reach the ground.
// The visible consequence is that a quadruped lowering its mouth performs a
// PLAY BOW — front legs folding, hind legs planted — instead of the shipped
// handstand, where the hind hips rose out of reach and the animal balanced on
// its forelegs. `PoseOverrides.snoutTarget` is the other half: a neck that can
// actually reach, so the trunk no longer has to dive to lower a snout.
//
// The pins here are of three kinds:
//   1. NO-OP — the negotiation and the reach channel must be inert wherever
//      they are not needed. Every shipped body at rest, every degenerate body
//      plan, every pose override that isn't a snout target.
//   2. TIMELINE — the animator driven for whole actions against real built
//      skeletons (the update / buildSkeleton / observe loop the model runs),
//      asserting the ledger at EVERY frame rather than at the end.
//   3. CHANNEL — the neck bends within a documented budget, approaches an
//      out-of-reach target without folding into the body, and hands the head
//      assembly along with it.

import { describe, it, expect } from "@jest/globals";
import { speciesBlueprint, listSpecies } from "@shared/world-engine/creatures/species.js";
import {
  buildSkeleton,
  limbTip,
  resolveLimbs,
  type CreatureSkeleton,
  type PoseOverrides,
  type Vec3,
} from "@shared/world-engine/creatures/skeleton.js";
import { CreatureAnimator } from "@shared/world-engine/creatures/animation.js";
import type { Blueprint } from "@shared/world-engine/creatures/blueprint.js";
import type { GaitParams } from "@shared/world-engine/creatures/gait.js";

const QUADRUPEDS = ["dog", "cow", "horse", "sheep", "cat"] as const;
/** Body plans with nothing to negotiate: no legs, radial legs, or two. */
const DEGENERATE = ["snake", "octopus", "fish", "jellyfish", "parrot", "human"] as const;

const bones = (skel: CreatureSkeleton) =>
  skel.bones.map((b) => [
    b.id, b.head.x, b.head.y, b.head.z, b.tail.x, b.tail.y, b.tail.z,
  ]);

const supportLegs = (skel: CreatureSkeleton) =>
  skel.support.legs.filter((l) => l.role === "support");

/** The BALL — the last bone of a leg chain, the bit that meets the ground.
 *  Read off the built skeleton rather than off `LegSupport.foot`, because
 *  `foot` reports the contact plane the reach test used (the ankle's) for a
 *  planted leg and the ball itself for a splayed one; the bone is unambiguous
 *  and it is what a viewer actually sees hanging in the air. */
const ballOf = (skel: CreatureSkeleton, chain: string): Vec3 | undefined => {
  const foot = skel.bones.find((b) => b.chain === chain && b.id.endsWith("foot"));
  if (foot) return foot.tail;
  const segs = skel.bones.filter((b) => b.chain === chain);
  return segs.length > 0 ? segs[segs.length - 1].tail : undefined;
};

const hipOf = (skel: CreatureSkeleton, chain: string): Vec3 | undefined =>
  skel.bones.find((b) => b.chain === chain && b.id === `${chain}0`)?.head;

/** How far a leg can reach, measured off the BUILT chain: the sum of its own
 *  bone lengths, hip to ball. Taken from the skeleton rather than recomputed
 *  from the blueprint because the resolved limb's length is not the group's
 *  (size peak, contrast and count all scale it) — and a reach test that
 *  disagrees with the leg it is testing proves nothing. Invariant to the
 *  pose: the bones follow the bent path, so the sum is the same straight. */
const chainReach = (skel: CreatureSkeleton, chain: string): number => {
  let total = 0;
  for (const b of skel.bones) {
    if (b.chain !== chain) continue;
    total += Math.hypot(b.tail.x - b.head.x, b.tail.y - b.head.y, b.tail.z - b.head.z);
  }
  return total;
};

const mouthChain = (bp: Blueprint): string =>
  bp.head.snoutLengthFrac > 0 ? "snout" : "jaw";

/** The model's own loop: emit a frame, write the posture into the (scratch)
 *  blueprint, build, feed the skeleton back. Exactly `creature-model.ts`. */
function driver(id: string) {
  const bp = speciesBlueprint(id);
  const anim = new CreatureAnimator(bp);
  const step = (dt = 1 / 60) => {
    const f = anim.update(dt);
    bp.posture.bodyPitch = f.posture.bodyPitch;
    bp.posture.bodyHeight = f.posture.bodyHeight;
    const skel = buildSkeleton(bp, f.gait, f.pose);
    anim.observe(skel);
    return { f, skel };
  };
  return { bp, anim, step };
}

// ── 1. The no-op pins ────────────────────────────────────────────────────

describe("the negotiation is INERT wherever no support leg is losing the ground", () => {
  const ALL = listSpecies().map((s) => s.id);

  it.each(ALL)("%s stands at rest with every support leg planted", (id) => {
    // This is WHY the clamps are no-ops on shipped content, not a coincidence
    // to be re-derived: the lift clamp is a clamp, and a body whose support
    // legs all reach is already inside the window it clamps to.
    const skel = buildSkeleton(speciesBlueprint(id));
    const legs = supportLegs(skel);
    if (legs.length === 0) return; // no legs at all (a fish, a plant)
    if (skel.support.body.bellyRest) return; // the ground under the trunk has it
    for (const leg of legs) {
      expect(leg.grounded).toBe(true);
      expect(leg.bearing).toBe("ground");
    }
  });

  it.each(ALL)("%s poses identically with an empty pose and with none", (id) => {
    const bp = speciesBlueprint(id);
    expect(bones(buildSkeleton(bp, undefined, {}))).toEqual(bones(buildSkeleton(bp)));
  });

  it.each(ALL)("%s poses identically when restPitch restates the blueprint's own", (id) => {
    // `restPitch` defaults to `g.posture.bodyPitch`, so saying it out loud
    // must change nothing — the animator passes it on EVERY frame.
    const bp = speciesBlueprint(id);
    const pose: PoseOverrides = { restPitch: bp.posture.bodyPitch };
    expect(bones(buildSkeleton(bp, undefined, pose))).toEqual(bones(buildSkeleton(bp)));
  });

  it.each(ALL)("%s poses identically under a gait with and without an empty pose", (id) => {
    const bp = speciesBlueprint(id);
    const gait: GaitParams = {
      phase: 0.37, strideFrac: 0.45, stepHeight: 0.2, dutyFactor: 0.6, pattern: "trot",
    };
    expect(bones(buildSkeleton(bp, gait, { armSwing: 0 })))
      .toEqual(bones(buildSkeleton(bp, gait)));
  });

  it.each(DEGENERATE)("%s passes a nose-down pitch straight through", (id) => {
    // Fewer than two DISTINCT support stations = nothing to negotiate
    // BETWEEN. A snake has no legs, an octopus's arms are all at one station,
    // a biped's legs are one pair. None of them may acquire a clamp.
    const bp = speciesBlueprint(id);
    const dived: Blueprint = { ...bp, posture: { ...bp.posture, bodyPitch: -0.4 } };
    const skel = buildSkeleton(dived);
    const stations = new Set(supportLegs(skel).map((l) => l.chain.replace(/[LRr]$/, "")));
    if (stations.size >= 2) return; // (the human's arms are excluded by role)
    // The pitch survived intact: the torso really is lying along it.
    const torso = skel.bones.filter((b) => b.kind === "torso");
    const dz = torso[torso.length - 1].tail.z - torso[0].head.z;
    const dy = torso[torso.length - 1].tail.y - torso[0].head.y;
    expect(Math.atan2(dy, dz)).toBeCloseTo(-0.4, 6);
  });

  it("keeps a human's arms OUT of the stance set, however they hang", () => {
    // 🚨 The one classification that can wreck this: a human's arms mount low
    // enough and hang straight enough that the weight-bearing heuristic calls
    // them natural standers — they ARE legs on all fours. Constrain the
    // posture for them and an upright human folds to the floor to keep its
    // hands down. They must read as manipulators at the body's rest pitch.
    const skel = buildSkeleton(speciesBlueprint("human"));
    const roles = new Map(skel.support.legs.map((l) => [l.chain, l.role]));
    expect(roles.get("limb0R")).toBe("support"); // legs
    expect(roles.get("limb1R")).toBe("manipulator"); // arms
    for (const leg of skel.support.legs) {
      if (leg.role === "manipulator" && !leg.grounded) {
        expect(leg.force).toBe(0);
        expect(leg.bearing === "slack" || leg.bearing === "unreachable").toBe(true);
      }
    }
  });
});

// ── 2. The negotiated bow ────────────────────────────────────────────────

describe("a nose-down trunk bows over its rear feet", () => {
  it.each(QUADRUPEDS)("%s keeps all four planted through a −0.4 rad dive", (id) => {
    const bp = speciesBlueprint(id);
    const bowed = buildSkeleton({ ...bp, posture: { ...bp.posture, bodyPitch: -0.4 } });
    const legs = supportLegs(bowed);
    expect(legs.length).toBeGreaterThanOrEqual(4);
    for (const leg of legs) {
      expect(leg.grounded).toBe(true);
      expect(leg.force).toBeGreaterThan(0);
      expect(leg.bearing).toBe("ground");
    }
    expect(bowed.support.body.tipping).toBeCloseTo(0, 6);
    expect(bowed.support.body.bellyRest).toBe(false);
  });

  it("clamps the PITCH itself only when no lift can satisfy every leg", () => {
    // The pitch clamp is the negotiation's last resort — it fires when the
    // front hips would have to go through the floor before the hind ones came
    // back into reach. The horse at −1.05 rad is that case; the dog at −0.4 is
    // not, and its pitch must arrive untouched.
    const torsoPitch = (skel: CreatureSkeleton): number => {
      const t = skel.bones.filter((b) => b.kind === "torso");
      return Math.atan2(t[t.length - 1].tail.y - t[0].head.y, t[t.length - 1].tail.z - t[0].head.z);
    };
    const dog = speciesBlueprint("dog");
    expect(torsoPitch(buildSkeleton({ ...dog, posture: { ...dog.posture, bodyPitch: -0.4 } })))
      .toBeCloseTo(-0.4, 6);
    const horse = speciesBlueprint("horse");
    const dived = torsoPitch(buildSkeleton({ ...horse, posture: { ...horse.posture, bodyPitch: -1.05 } }));
    expect(dived).toBeGreaterThan(-1.05); // pulled back
    expect(dived).toBeLessThan(0); // but still nose-down
  });
});

// ── 3. The neck reach channel ────────────────────────────────────────────

describe("snoutTarget bends the neck and the head rides it", () => {
  const NECKED = ["dog", "cow", "horse", "parrot"] as const;

  it.each(NECKED)("%s builds byte-identically with no target", (id) => {
    const bp = speciesBlueprint(id);
    expect(bones(buildSkeleton(bp, undefined, { gape: 0.4 })))
      .toEqual(bones(buildSkeleton(bp, undefined, { gape: 0.4, snoutTarget: undefined })));
  });

  it.each(NECKED)("%s lowers its mouth toward a target on the ground", (id) => {
    const bp = speciesBlueprint(id);
    const rest = buildSkeleton(bp);
    const chain = mouthChain(bp);
    const tip0 = limbTip(rest, chain)!;
    const target: Vec3 = { x: 0, y: 0.02, z: tip0.z };
    const bent = buildSkeleton(bp, undefined, { snoutTarget: target });
    const tip1 = limbTip(bent, chain)!;
    // A real drop, and toward the target rather than away from it.
    expect(tip1.y).toBeLessThan(tip0.y - 0.1);
    expect(Math.abs(tip1.y - target.y)).toBeLessThan(Math.abs(tip0.y - target.y));
    // The WHOLE head came along: the skull, not just the neck's last bone.
    const skullY = (s: CreatureSkeleton) => s.bones.find((b) => b.id === "head")!.head.y;
    expect(skullY(bent)).toBeLessThan(skullY(rest));
    expect(bent.head!.rostrumTip.y).toBeLessThan(rest.head!.rostrumTip.y);
  });

  it.each(NECKED)("%s APPROACHES an impossible target instead of folding into itself", (id) => {
    // A target at the centre of the earth must bend the neck to its budget and
    // stop there — never past it, and never through the body.
    const bp = speciesBlueprint(id);
    const chain = mouthChain(bp);
    const deep = buildSkeleton(bp, undefined, { snoutTarget: { x: 0, y: -50, z: 0.3 } });
    const tip = limbTip(deep, chain)!;
    expect(Number.isFinite(tip.y)).toBe(true);
    // Bounded by the neck's own geometry: the mouth cannot end up further
    // from the neck root than the neck plus the head is long.
    const neck = deep.bones.filter((b) => b.kind === "neck");
    const root = neck.length > 0 ? neck[0].head : deep.bones.find((b) => b.id === "head")!.head;
    const span = deep.bones
      .filter((b) => b.kind === "neck" || b.kind === "head")
      .reduce((a, b) => a + Math.hypot(b.tail.x - b.head.x, b.tail.y - b.head.y, b.tail.z - b.head.z), 0);
    expect(Math.hypot(tip.x - root.x, tip.y - root.y, tip.z - root.z)).toBeLessThanOrEqual(span + 1e-6);
    // And it stops AT the ground, not under it.
    expect(tip.y).toBeGreaterThan(-0.05);
  });

  it("spends its bend budget per JOINT, capped, and per TUBE", () => {
    // The documented shape of the budget, both halves of it.
    const base = speciesBlueprint("dog");
    const drop = (patch: Partial<Blueprint["neck"]>): number => {
      const bp: Blueprint = { ...base, neck: { ...base.neck, ...patch } };
      const rest = limbTip(buildSkeleton(bp), "snout")!;
      const bent = limbTip(buildSkeleton(bp, undefined, { snoutTarget: { x: 0, y: -50, z: rest.z } }), "snout")!;
      return rest.y - bent.y;
    };
    // A single hinge is limited by NECK_JOINT_CAP; cut the same neck in two
    // and it reaches further.
    expect(drop({ segments: 2 })).toBeGreaterThan(drop({ segments: 1 }));
    // Past that, joint count buys a smoother curve and nothing else — the
    // no-fold law is joint-count-blind (Σ segLen/r is the same however finely
    // the neck is sliced), so these must NOT drift apart.
    for (const n of [3, 4, 6, 10]) {
      expect(Math.abs(drop({ segments: n }) - drop({ segments: 2 }))).toBeLessThan(0.05);
    }
    // What genuinely buys reach is a longer, slimmer neck.
    expect(drop({ lengthFrac: base.neck.lengthFrac * 2 }))
      .toBeGreaterThan(drop({}) + 0.05);
    expect(drop({ radiusFrac: base.neck.radiusFrac * 0.5 }))
      .toBeGreaterThan(drop({}));
  });
});

// ── 4. Whole actions, every frame ────────────────────────────────────────

describe("a mouth pick-up never stands the animal on its forelegs", () => {
  it.each(["dog", "cow"] as const)("%s: four feet, no tipping, and it gets the object", (id) => {
    const { bp, anim, step } = driver(id);
    for (let i = 0; i < 30; i++) step(); // settle, and observe a rest snout
    const chain = mouthChain(bp);
    const restTip = limbTip(buildSkeleton(bp), chain)!;
    // 🚨 THE OBJECT IS PLACED IN BODY UNITS, NOT IN METRES. It used to sit at
    // `restTip.z + 0.15` with a size of 0.1 — numbers fitted when the dog's
    // torso was 1.7 m, i.e. 0.088 and 0.059 of the body. The re-proportioning
    // made the same animal a real 0.55 m labrador, so those constants became a
    // reach of 0.27 of its body: three times the errand, from a snout that
    // reaches the same fraction of its own length as before. The residual pin
    // below is stated as a fraction of the reach, so it caught the change —
    // correctly, and about the wrong thing. Restated in body units the errand
    // is the one this test was written against, on any size of animal.
    const L = bp.spine.torsoLengthM;
    const object: Vec3 = { x: 0, y: 0.03 * L, z: restTip.z + 0.09 * L };
    // ⚖️ WEIGHTLESS ON PURPOSE (phase 5). This test is about the REACH — that
    // the mouth path never lifts a support leg off the ground — and the mass
    // of the thing being fetched is nothing to do with it. It has to be said
    // out loud because `pickUp` refuses a load the body cannot bear, and a
    // body the ledger already reads as over capacity refuses every real mass.
    // Refusal has its own suite — creature-loads.test.ts.
    expect(anim.pickUp(object, 0.06 * L, 0)).toBe(true);

    let held = false;
    let closest = Infinity;
    let lowest = Infinity;
    let frames = 0;
    for (let i = 0; i < 60 * 8; i++) {
      const { f, skel } = step();
      frames++;
      // (a) every support leg stays on the ground, carrying something.
      for (const leg of supportLegs(skel)) {
        expect(leg.grounded).toBe(true);
        expect(leg.bearing).toBe("ground");
        expect(leg.force).toBeGreaterThan(0);
      }
      // (b) the body never overhangs its own feet.
      expect(skel.support.body.tipping).toBeLessThan(1e-6);
      expect(skel.support.body.bellyRest).toBe(false);
      const tip = limbTip(skel, chain)!;
      lowest = Math.min(lowest, tip.y);
      closest = Math.min(closest, Math.hypot(tip.x - object.x, tip.y - object.y, tip.z - object.z));
      if (f.holding) held = true;
      // "carry" is the end of a pick-up — the object is in the mouth and the
      // timeline holds there until something asks for a put-down.
      if (f.action === "carry") break;
    }
    // (c) the action completed: the snout converged on the object and the
    // creature took it. ⚖️ The residual is the rig's own approach limit and is
    // NOT a phase-3 regression — the shipped mouth reach, handstand and all,
    // closed to the same fraction. What changed is the posture it closes from.
    // Measured: dog 0.22 of the reach (0.14 of its torso), cow 0.14 (0.11).
    // The snout drops nearly all the way and closes almost none of the
    // FORWARD gap, which is why the residual tracks the errand's z-offset.
    const reachStart = Math.hypot(restTip.y - object.y, restTip.z - object.z);
    expect(held).toBe(true);
    expect(closest).toBeLessThan(reachStart * 0.35);
    expect(closest).toBeLessThan(0.2 * L);
    expect(lowest).toBeLessThan(restTip.y * 0.4); // the head really went down
    expect(frames).toBeLessThan(60 * 8);
  });

  it("still lets a human pitch forward over its two feet and pick up by hand", () => {
    // A biped leaning over its own feet is LEGITIMATE — it has one pair of
    // legs, nothing to negotiate between, and its tipping is the ordinary
    // fore/aft overhang of a two-point support. The negotiation must allow it
    // rather than flatten it.
    const { anim, step } = driver("human");
    for (let i = 0; i < 30; i++) step();
    expect(anim.pickUp({ x: 0.1, y: 0.05, z: 0.45 }, 0.05)).toBe(true);
    let held = false;
    let minPitch = Infinity;
    for (let i = 0; i < 60 * 8; i++) {
      const { f, skel } = step();
      minPitch = Math.min(minPitch, f.posture.bodyPitch);
      for (const leg of supportLegs(skel)) expect(leg.grounded).toBe(true);
      expect(skel.support.body.bellyRest).toBe(false);
      if (f.holding) held = true;
      // "carry" is the end of a pick-up — the object is in the mouth and the
      // timeline holds there until something asks for a put-down.
      if (f.action === "carry") break;
    }
    expect(held).toBe(true);
    // It really did stoop — the crouch and the lean are still doing the work.
    expect(minPitch).toBeLessThan(speciesBlueprint("human").posture.bodyPitch - 0.5);
  });

  it.each(["dog", "sheep", "horse"] as const)("%s bows to eat with its hind feet still loaded", (id) => {
    const { bp, anim, step } = driver(id);
    const chain = mouthChain(bp);
    for (let i = 0; i < 60; i++) step();
    const restY = limbTip(step().skel, chain)!.y;
    anim.setActivity("eat");
    let lowest = Infinity;
    for (let i = 0; i < 60 * 5; i++) {
      const { skel } = step();
      lowest = Math.min(lowest, limbTip(skel, chain)!.y);
      for (const leg of supportLegs(skel)) {
        expect(leg.grounded).toBe(true);
        expect(leg.force).toBeGreaterThan(0);
      }
      expect(skel.support.body.tipping).toBeLessThan(1e-6);
    }
    // The bow is VISIBLE — the mouth goes most of the way to the ground,
    // where the old trunk-only bow moved it about a quarter of the way.
    expect(restY - lowest).toBeGreaterThan(restY * 0.5);
  });
});

// ── 5. The ledger's new columns ──────────────────────────────────────────

describe("the ledger says WHY a leg carries nothing", () => {
  it("labels a hanging arm slack and a planted leg ground", () => {
    const skel = buildSkeleton(speciesBlueprint("human"));
    for (const leg of skel.support.legs) {
      if (leg.grounded) expect(leg.bearing).toBe("ground");
      else expect(leg.foot ? "slack" : "unreachable").toBe(leg.bearing);
    }
  });

  it("rests a too-short body on its belly and splays its legs at the floor", () => {
    // 🚨 THE GENUINE CUTE FLOAT, FLIPPED (phase 4). Legs at 0.2× — far too
    // short for the body, so it sits down and the ground under the trunk is
    // what holds it up. Phase 3 left this pin describing the BUG: every leg
    // read force 0 and the ones that could not reach were folded to their
    // neutral pose in MID-AIR under a body lying on the floor.
    //
    // What must be true now: the belly is a real support carrying a real
    // measured share, and no leg is left hanging. A leg either plants, or —
    // when its hip is genuinely too high for any plant — it EXTENDS at the
    // floor along its sprawl, which is what a resting animal's legs do.
    const base = speciesBlueprint("dog");
    const squat: Blueprint = {
      ...base,
      limbGroups: base.limbGroups.map((g) => ({ ...g, lengthFrac: g.lengthFrac * 0.2 })),
    };
    const skel = buildSkeleton(squat);
    const sup = skel.support;
    expect(sup.body.bellyRest).toBe(true);

    // The belly is a MEASURED support, not a flag: a real patch, a real
    // centroid, and a share in (0, 1].
    expect(sup.body.bellyArea).toBeGreaterThan(0);
    expect(sup.body.bellyContact).not.toBeNull();
    expect(sup.body.bellyShare).toBeGreaterThan(0);
    expect(sup.body.bellyShare).toBeLessThanOrEqual(1);

    // THE FORCE INVARIANT. Nothing falls through the floor: what the legs
    // carry plus what the belly carries is exactly what the body weighs.
    const legSum = sup.legs.reduce((a, l) => a + l.force, 0);
    expect(legSum + sup.body.bellyShare * sup.body.weight)
      .toBeCloseTo(sup.body.weight, 12);

    // A wide patch is a strong support, so it is not working hard.
    expect(sup.chainStress.belly).toBeGreaterThan(0);
    expect(sup.chainStress.belly).toBeLessThan(1);

    const L = squat.spine.torsoLengthM;
    for (const leg of supportLegs(skel)) {
      // NOTHING IS "unreachable" ANYMORE. That label is the flying sense now
      // — a wing, a limb that cannot bear — never a resting body's leg.
      expect(leg.bearing).toBe("belly-rest");
      expect(leg.foot).toBeDefined();
      expect(leg.force).toBeGreaterThanOrEqual(0);

      const ball = ballOf(skel, leg.chain);
      expect(ball).toBeDefined();
      const hip = hipOf(skel, leg.chain)!;
      const reach = chainReach(skel, leg.chain);

      if (leg.grounded) {
        // Planted: the ball is ON the ground, sunk into it by its own skin
        // exactly as any standing foot is.
        expect(ball!.y).toBeLessThan(0.05 * L);
      } else {
        // SPLAYED, and this is the assertion the old dangle could not pass.
        // The leg is SPENT — hip to ball is its whole length, so it cannot be
        // folded; a neutral FK fold bends the knee and comes up short. And it
        // is spent DOWNWARD: the ball hangs most of a leg below the hip
        // instead of being tucked up beside it.
        const span = Math.hypot(ball!.x - hip.x, ball!.y - hip.y, ball!.z - hip.z);
        expect(span).toBeGreaterThan(reach * 0.99);
        expect(hip.y - ball!.y).toBeGreaterThan(reach * 0.5);
        // …and there was no reach left over to spend: the ball is as low as
        // this hip can put it.
        expect(ball!.y).toBeLessThan(hip.y - reach * 0.5);
      }
    }
  });

  it("gives the belly a wide footprint and the feet what is left", () => {
    // The split is MEASURED, not asserted: the patch is the trunk's own
    // silhouette where it lies on the floor, and load lands in proportion to
    // what each contact can carry. So the belly — orders of magnitude wider
    // than a paw — takes the bulk, and every contact ends up working about
    // equally hard rather than one of them being crushed.
    const base = speciesBlueprint("dog");
    const squat: Blueprint = {
      ...base,
      limbGroups: base.limbGroups.map((g) => ({ ...g, lengthFrac: g.lengthFrac * 0.2 })),
    };
    const skel = buildSkeleton(squat);
    const sup = skel.support;
    // The belly patch dwarfs any one foot — the ball's own footprint, which
    // is what presses on the ground (a paw, not a thigh).
    const ball = skel.bones.find((b) => b.chain === "limb0L" && b.id.endsWith("foot"))!;
    const paw = Math.PI * ball.radiusTail * ball.radiusTail;
    expect(sup.body.bellyArea).toBeGreaterThan(paw * 10);
    // Nothing anywhere near capacity — a lying animal is comfortable.
    expect(sup.chainStress.belly).toBeLessThan(1);
    for (const leg of sup.legs) expect(leg.stress).toBeLessThan(1);
  });

  it("keeps the belly out of it entirely for a body standing clear", () => {
    // The no-op guarantee, stated as a pin: every belly reading is off for a
    // body on its legs, so nothing in phase 4 can perturb a standing pose.
    for (const id of QUADRUPEDS) {
      const sup = buildSkeleton(speciesBlueprint(id)).support;
      expect(sup.body.bellyRest).toBe(false);
      expect(sup.body.bellyShare).toBe(0);
      expect(sup.body.bellyArea).toBe(0);
      expect(sup.body.bellyContact).toBeNull();
      expect(sup.chainStress.belly).toBe(0);
      // …and the legs still carry the whole body between them.
      const legSum = sup.legs.reduce((a, l) => a + l.force, 0);
      expect(legSum).toBeCloseTo(sup.body.weight, 9);
    }
  });

  it("exposes the centre of pressure the tipping was measured from", () => {
    const dog = buildSkeleton(speciesBlueprint("dog")).support;
    expect(dog.body.centerOfPressure).not.toBeNull();
    // Balanced: the ground pushes right under the CoM. (`tipDir` stays a UNIT
    // vector down to solveFootForces' own 1e-9 threshold, so it is direction
    // only — `tipping` is what says whether there is anything to fall toward,
    // and a consumer must read the two together.)
    expect(dog.body.centerOfPressure!.x).toBeCloseTo(dog.body.com.x, 6);
    expect(dog.body.centerOfPressure!.z).toBeCloseTo(dog.body.com.z, 6);
    expect(dog.body.tipping).toBeLessThan(1e-6);
  });

  it("reports supportMargin === −tipping once the CoM is outside the hull", () => {
    // ⚖️ The documented identity. The optimal centre of pressure is the
    // projection of the CoM onto the support hull, so the leftover moment arm
    // IS the distance to the hull — which is what the margin measures from
    // the other side. A biped standing on a two-foot LINE is the easiest case
    // to see it in: the CoM is essentially never exactly on that line.
    const human = buildSkeleton(speciesBlueprint("human")).support;
    expect(human.body.tipping).toBeGreaterThan(0);
    expect(human.body.supportMargin).toBeCloseTo(-human.body.tipping, 9);
    expect(Math.hypot(human.body.tipDir.x, human.body.tipDir.z)).toBeCloseTo(1, 6);
  });

  it("gives every flexible chain its own cantilever reading", () => {
    // An octopus is eight chains, not one average of eight.
    const skel = buildSkeleton(speciesBlueprint("octopus"));
    const chains = new Set(skel.bones.filter((b) => b.kind === "chain").map((b) => b.chain));
    expect(chains.size).toBeGreaterThan(0);
    for (const name of chains) {
      expect(skel.support.chainStress[name]).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(skel.support.chainStress[name])).toBe(true);
    }
    expect(skel.support.chainStress.spine).toBeDefined();
  });
});

/**
 * ⚖️ A TUCKED LIMB'S KNEE BELONGS IN THE SAGITTAL PLANE.
 *
 * The companion to the four SIGN pins in creature-limbs.test.ts. Those assert
 * which WAY the knee folds (fore limbs back, hind limbs forward) and they were
 * always green — the knee pointed forward, and also 96% sideways, and no pin
 * ever looked at the magnitude. Measured across the registry, 100 of 100
 * grounded legs carried the knee OUTWARD and 94 of them were more than 90%
 * lateral: a cow's stifle sat 16 cm out and 4.5 cm forward. A bow-legged cow.
 *
 * Two solver terms did it, both since fixed in `skeleton.ts`:
 *   • `normalize(side)` gave the arch a FULL unit vote however weak it actually
 *     was, so the knee's lateral share was a function of `restFlexion` alone.
 *     The elephant and sauropod convict it: levation −1 makes their pole
 *     exactly vertical, its in-plane residue is ~0.02, and normalization
 *     promoted that to a weight of 0.85.
 *   • the pole's OUT term was ungated, and the Bernstein middle weight is still
 *     ~0.23 at a horse's levation of −0.73, so it put 0.22 of sideways against
 *     a fold of 0.13.
 *
 * The dial has to MEAN something: a limb tucked under the body arches its knee
 * fore/aft, a sprawled one carries it out to the side. So the assertion is a
 * GRADIENT, not a threshold — and the sprawlers are asserted too, or "fix" the
 * mammals by killing the arch everywhere and a spider stands like a table.
 */
describe("the knee arches by levation, not sideways by default", () => {
  /** |lateral| / |total| of the knee's offset from the hip→ankle chord. */
  const kneeLateralFrac = (bp: Blueprint, chain: string): number | null => {
    const skel = buildSkeleton(bp);
    const bones = skel.bones.filter((b) => b.chain === chain);
    if (bones.length < 4) return null;
    const H = bones[0]!.head, K = bones[1]!.tail, A = bones[3]!.tail;
    const d = { x: A.x - H.x, y: A.y - H.y, z: A.z - H.z };
    const dl = Math.hypot(d.x, d.y, d.z) || 1;
    const kv = { x: K.x - H.x, y: K.y - H.y, z: K.z - H.z };
    const t = (kv.x * d.x + kv.y * d.y + kv.z * d.z) / (dl * dl);
    const off = { x: kv.x - d.x * t, y: kv.y - d.y * t, z: kv.z - d.z * t };
    const tot = Math.hypot(off.x, off.y, off.z);
    return tot > 1e-9 ? Math.abs(off.x) / tot : null;
  };

  it("keeps a TUCKED tetrapod's knee near the sagittal plane, on both sides", () => {
    // Every shipped bilateral tetrapod that folds its knee (restFlexion != 0)
    // and tucks its limbs under the body (restLevation <= -0.45).
    // ⚠️ GROUNDED SUPPORT LEGS ONLY. A limb that never reaches the ground is
    // posed by the HANGING branch, not the ground IK this fix lives in — a
    // human's hanging arm still reads 0.99 lateral at its elbow, which is that
    // branch's business and not pinned here.
    const cases: Array<[string, string]> = [];
    for (const id of ["horse", "cow", "elephant", "deer", "dog", "cat", "human",
      "sheep", "ram", "ungulate", "quadruped", "sauropod", "tyrannosaur"]) {
      const bp = speciesBlueprint(id);
      const limbs = resolveLimbs(bp).limbs;
      for (const leg of buildSkeleton(bp).support.legs) {
        if (leg.role !== "support" || !leg.grounded) continue;
        const m = /^limb(\d+)[LR]$/.exec(leg.chain);
        if (!m) continue;
        const lm = limbs[Number(m[1])]!;
        if (lm.placement !== "bilateral") continue;
        if (lm.restLevation > -0.45 || Math.abs(lm.restFlexion) < 1e-6) continue;
        cases.push([id, leg.chain]);
      }
    }
    expect(cases.length).toBeGreaterThan(30);
    for (const [id, chain] of cases) {
      const f = kneeLateralFrac(speciesBlueprint(id), chain);
      if (f === null) continue;
      // 0.5 is generous — the registry's worst is the quadruped at 0.43, and
      // the fully tucked elephant reads 0.01 — but it is far below the 0.96
      // mean this replaced, and it fails the instant the arch starts dominating
      // the fold again.
      expect(`${id} ${chain} lateralFrac<=0.5`).toBe(
        `${id} ${chain} ${f <= 0.5 ? "lateralFrac<=0.5" : `WAS ${f.toFixed(3)}`}`);
    }
  });

  it("STILL carries a sprawler's knee out to the side", () => {
    // The other half of the law. A spider/crab/beetle plants its feet far
    // outboard and its knees belong out there with them.
    for (const id of ["spider", "crab", "beetle", "centipede"]) {
      const bp = speciesBlueprint(id);
      const lm = resolveLimbs(bp).limbs.find((l) => l.placement === "bilateral" && l.restLevation > 0);
      if (!lm) continue;
      const f = kneeLateralFrac(bp, `limb${resolveLimbs(bp).limbs.indexOf(lm)}L`);
      if (f === null) continue;
      expect(`${id} sprawl lateralFrac>0.7`).toBe(
        `${id} ${f > 0.7 ? "sprawl lateralFrac>0.7" : `WAS ${f.toFixed(3)}`}`);
    }
  });
});
