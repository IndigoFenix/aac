// BELLY REST AS A REAL SUPPORT (phase 4) — driven at PLAY level.
//
// The user-visible bug this file pins shut: the `cute` appearance mod fattens
// a sheep's girth until its belly becomes the body's floor, and once the body
// was lying down, every leg that could not reach the ground was folded to its
// neutral pose IN MID-AIR. Measured across every shipped quadruped, plain and
// cute, through sit / play / eat / mouth-pick-up, the cute sheep was the last
// body still doing it: 2 of 4 stance legs planted and the other two dangling.
//
// Two things had to become true, and both are asserted here against the real
// animator loop (update → buildSkeleton → observe) rather than a static pose,
// because the bug only appeared a second into an action:
//
//   1. THE BELLY BEARS. It is a contact patch with a measured area, it sits
//      in the same force balance the feet are in, and
//          Σ legForces + bellyShare · weight = weight
//      exactly, every frame. A body lying down is SUPPORTED, not a body whose
//      weight quietly went nowhere.
//   2. NO LEG DANGLES. Every stance leg keeps a foot, and a leg whose hip is
//      too high to plant is SPLAYED — spent to its full length, aimed at the
//      floor — the way a resting animal's legs are.
//
// 🚨 2026-09-03, THE RE-PROPORTIONING ROUND: THE CUTE SHEEP NO LONGER LIES
// DOWN. Every body in the registry was re-authored to real dimensions, and the
// sheep became an 80 kg animal on a 0.85 m torso whose legs are long enough
// that `cute`'s girth ceiling (0.45) cannot put its belly on the floor.
// `bellyRest` is now false for it in every frame, which is asserted below
// rather than left to make the guards silently vacuous. The body that
// exercises the belly path now is the CROCODILE — a sprawler with a long low
// trunk — and the load and clearance pins have moved onto it.
//
// ⚖️ WHAT IS DELIBERATELY *NOT* ASSERTED: that every splayed hoof touches.
// In the deepest frames of `play` the animator commands a bow that props the
// rump higher than the hind legs are long, and the belly floor outranks the
// pitch negotiation (phase 3's rule), so no leg can reach. The honest
// statement is the one below — the leg is fully spent downward — plus a
// measured bound on the residual. See the note at the end of the file.

import { describe, it, expect } from "@jest/globals";
import { speciesBlueprint, requireSpecies } from "@shared/world-engine/creatures/species.js";
import { getCreatureMod } from "@shared/world-engine/creatures/mod-library.js";
import { applyAppearanceMods } from "@shared/world-engine/creatures/mods.js";
import { buildSkeleton, type CreatureSkeleton } from "@shared/world-engine/creatures/skeleton.js";
import { CreatureAnimator } from "@shared/world-engine/creatures/animation.js";
import type { Blueprint } from "@shared/world-engine/creatures/blueprint.js";

type Activity = "sit" | "play" | "eat";

const cuteBlueprint = (id: string): Blueprint => {
  const cute = getCreatureMod("cute");
  expect(cute).toBeDefined();
  return applyAppearanceMods(requireSpecies(id), speciesBlueprint(id), [cute!]);
};

/** Sum of a leg chain's own bone lengths — how far it can reach, measured off
 *  the body being tested rather than recomputed from the blueprint. */
const chainReach = (skel: CreatureSkeleton, chain: string): number => {
  let total = 0;
  for (const b of skel.bones) {
    if (b.chain !== chain) continue;
    total += Math.hypot(b.tail.x - b.head.x, b.tail.y - b.head.y, b.tail.z - b.head.z);
  }
  return total;
};

const ballOf = (skel: CreatureSkeleton, chain: string) => {
  const foot = skel.bones.find((b) => b.chain === chain && b.id.endsWith("foot"));
  if (foot) return foot.tail;
  const segs = skel.bones.filter((b) => b.chain === chain);
  return segs[segs.length - 1]?.tail;
};

/** 🚨 THE LIMB'S LOWEST *SURFACE* POINT — the sole, not the ankle.
 *
 *  `ballOf` returns the end of the `…foot` BONE, which is where the sole stops
 *  and the toes begin. That is the right landmark for "is this leg folded or
 *  spent", and the wrong one for "is this leg on the ground": the contact is
 *  made further down the chain, by a DIGIT, and the capsule that digit is drawn
 *  as touches the floor at its centre-line minus its radius.
 *
 *  The re-proportioning is what made the difference matter. A cute sheep's
 *  hoof capsule is now 46 mm across, so the foot bone's tail sits 89 mm up
 *  while the sheep is standing squarely on the ground — and a pin that read
 *  `ball.y < 0.05 × torsoLength` was measuring how THICK the foot had become.
 *  This walks the leg chain and its digit chains and takes min(y − radius),
 *  which is the surface a viewer sees against the floor, and is ≤ 0 on every
 *  grounded leg on every shipped body regardless of how fat its toes are. */
const soleY = (skel: CreatureSkeleton, chain: string): number => {
  let lowest = Infinity;
  for (const b of skel.bones) {
    if (b.chain !== chain && !b.chain.startsWith(`${chain}d`)) continue;
    lowest = Math.min(lowest, b.head.y - b.radiusHead, b.tail.y - b.radiusTail);
  }
  return lowest;
};

const hipOf = (skel: CreatureSkeleton, chain: string) =>
  skel.bones.find((b) => b.chain === chain && b.id === `${chain}0`)?.head;

/** The model's own loop, exactly as `creature-model.ts` runs it. */
function drive(bp: Blueprint, activity: Activity, seconds: number): CreatureSkeleton[] {
  const g: Blueprint = structuredClone(bp);
  const anim = new CreatureAnimator(g);
  anim.setActivity(activity);
  const frames: CreatureSkeleton[] = [];
  const DT = 1 / 60;
  for (let t = 0; t < seconds; t += DT) {
    const f = anim.update(DT);
    g.posture = f.posture;
    const skel = buildSkeleton(g, f.gait, f.pose);
    anim.observe(skel);
    frames.push(skel);
  }
  return frames;
}

describe("a cute sheep lies on its belly with its legs on the floor", () => {
  const ACTIONS: Activity[] = ["sit", "play", "eat"];

  it.each(ACTIONS)("%s: no stance leg ever loses its foot", (act) => {
    // 🚨 THE REGRESSION GUARD. `unreachable` on a support leg is the float /
    // handstand signature: the ground is out of reach and the limb has folded
    // into the air. Since phase 4 that label is the FLYING sense only, so a
    // body with legs must never produce it.
    const bp = cuteBlueprint("sheep");
    for (const skel of drive(bp, act, 4)) {
      for (const leg of skel.support.legs) {
        if (leg.role !== "support") continue;
        expect(leg.bearing).not.toBe("unreachable");
        expect(leg.foot).toBeDefined();
        expect(leg.force).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it.each(ACTIONS)("%s: every leg is either planted or spent at the floor", (act) => {
    const bp = cuteBlueprint("sheep");
    const L = bp.spine.torsoLengthM;
    for (const skel of drive(bp, act, 4)) {
      for (const leg of skel.support.legs) {
        if (leg.role !== "support") continue;
        const ball = ballOf(skel, leg.chain)!;
        const hip = hipOf(skel, leg.chain)!;
        if (leg.grounded) {
          // On the ground — measured at the SOLE (see `soleY`), which is the
          // surface that touches it, rather than at the ankle, which since the
          // re-proportioning sits a fat hoof's radius above it.
          expect(soleY(skel, leg.chain)).toBeLessThan(0.01 * L);
          continue;
        }
        // Splayed: the leg is at FULL extension (a fold cannot be) and aimed
        // down (a fold is not). Both fail for the neutral mid-air pose that
        // this whole phase exists to remove.
        const reach = chainReach(skel, leg.chain);
        const span = Math.hypot(ball.x - hip.x, ball.y - hip.y, ball.z - hip.z);
        expect(span).toBeGreaterThan(reach * 0.99);
        expect(hip.y - ball.y).toBeGreaterThan(reach * 0.5);
      }
    }
  });

  it.each(ACTIONS)("%s: the force ledger balances every frame", (act) => {
    // THE INVARIANT. Whatever the legs do not carry, the belly does — and the
    // two add up to the body's weight to the last bit the solver can hold.
    const bp = cuteBlueprint("sheep");
    for (const skel of drive(bp, act, 4)) {
      const sup = skel.support;
      const legSum = sup.legs.reduce((a, l) => a + l.force, 0);
      expect(legSum + sup.body.bellyShare * sup.body.weight)
        .toBeCloseTo(sup.body.weight, 10);
      expect(sup.body.bellyShare).toBeGreaterThanOrEqual(0);
      expect(sup.body.bellyShare).toBeLessThanOrEqual(1);
      // The belly is only ever a support when it is actually on the ground.
      if (!sup.body.bellyRest) {
        expect(sup.body.bellyShare).toBe(0);
        expect(sup.body.bellyArea).toBe(0);
      }
    }
  });

  it.each(ACTIONS)("%s: nothing tips over", (act) => {
    // A body lying on a wide patch CANNOT fall over, and the ledger has to
    // agree — which is why the patch enters the balance quantised across its
    // real extent instead of collapsed to its centroid. Collapsed, this read
    // several centimetres of tipping on a sheep that was lying still.
    const bp = cuteBlueprint("sheep");
    const L = bp.spine.torsoLengthM;
    for (const skel of drive(bp, act, 4)) {
      expect(skel.support.body.tipping).toBeLessThan(0.01 * L);
    }
  });

  it("no longer reaches the floor at all — the re-proportioning stood it up", () => {
    // 🚨 THIS PIN IS FLIPPED, AND ITS PREMISE IS RETIRED BY A BODY CHANGE.
    // It used to assert that this body DOES lie down during play and eat —
    // that was the shipped symptom the whole phase existed for. The sheep is
    // now a real 80 kg animal on a 0.85 m torso with legs on the Campione
    // line, and `cute`'s girth rule tops out at the engine's 0.45 ceiling, so
    // the fattest sheep the mod can make still stands clear of the ground:
    // `bellyRest` is false in every frame of every activity.
    //
    // ⚖️ WHY THIS IS STILL A PIN AND NOT A DELETION. The pins above it — no
    // stance leg loses its foot, the force ledger balances, nothing tips —
    // are the regression guards, and they only mean something if somebody can
    // see WHY they now pass so easily. If this body starts belly-resting
    // again, the guards go back to being load-bearing and this comment is the
    // note that says so.
    const bp = cuteBlueprint("sheep");
    for (const act of ["sit", "play", "eat"] as const) {
      for (const skel of drive(bp, act, 4)) {
        expect(skel.support.body.bellyRest).toBe(false);
        expect(skel.support.body.bellyShare).toBe(0);
      }
    }
  });

  it("still bears a real belly on the body that DOES lie down — the crocodile", () => {
    // The machinery this file exists to pin is unchanged; what changed is
    // which body exercises it. The crocodile is the anatomically obvious one —
    // a sprawler with a long low trunk on short legs — and it goes down onto
    // its belly through the deepest frames of `play`, plain or cute.
    //
    // When it does, the belly is a MEASURED PATCH carrying a MEASURED SHARE,
    // not a flag: real area, a real contact point, a real cantilever reading,
    // and roughly a third of the body's weight off the legs.
    const bp = speciesBlueprint("crocodile");
    let resting = 0;
    let sawShare = 0;
    for (const skel of drive(bp, "play", 4)) {
      const b = skel.support.body;
      if (!b.bellyRest) {
        expect(b.bellyShare).toBe(0);
        expect(b.bellyArea).toBe(0);
        continue;
      }
      resting++;
      expect(b.bellyArea).toBeGreaterThan(0);
      expect(b.bellyContact).not.toBeNull();
      // ⚠️ RECORDED, NOT BANDED TIGHTLY. `chainStress.belly` runs 1.3–2.5 here.
      // It is `contactStrength` applied to a lofted trunk footprint, which is
      // the same bearing law the legs use but on an area nobody has calibrated
      // the way the Campione line calibrates a limb — so its absolute level is
      // not on the anatomical scale the leg numbers are on. All that is worth
      // asserting is that it is finite, positive, and not running away.
      expect(Number.isFinite(skel.support.chainStress.belly)).toBe(true);
      expect(skel.support.chainStress.belly).toBeGreaterThan(0);
      expect(skel.support.chainStress.belly).toBeLessThan(10);
      sawShare = Math.max(sawShare, b.bellyShare);
    }
    expect(resting).toBeGreaterThan(0);
    expect(sawShare).toBeGreaterThan(0.2);
  });

  it("leaves every OTHER shipped quadruped standing on all four", () => {
    // The no-op guarantee at play level: phase 4 engages only at the belly
    // floor, and no other shipped body — plain or cute — goes near it.
    for (const id of ["dog", "cat", "horse", "cow", "deer"] as const) {
      for (const bp of [speciesBlueprint(id), cuteBlueprint(id)]) {
        for (const act of ["sit", "play", "eat"] as const) {
          for (const skel of drive(bp, act, 3)) {
            for (const leg of skel.support.legs) {
              if (leg.role !== "support") continue;
              expect(leg.grounded).toBe(true);
              expect(leg.bearing).toBe("ground");
            }
          }
        }
      }
    }
  });
});

describe("the splay's residual is bounded and measured", () => {
  // ⚖️ THE KNOWN GAP, PINNED SO IT CANNOT SILENTLY WIDEN. While eating, the
  // sheep's splayed hind hooves come within a few centimetres of the floor —
  // visually on it. During the deepest play-bow frames they do not, because
  // the commanded bow props the rump higher than the legs are long and the
  // belly floor outranks the pitch negotiation, so there is no lift or pitch
  // at which those legs could reach. The leg is fully spent downward either
  // way (asserted above); this bounds how much air is left under it.
  //
  // A later phase that lets a belly-bound body negotiate its PITCH would
  // shrink the play bound toward the eat one. Until then these are the
  // measured numbers, not aspirations.
  //
  // ⚖️ RE-POINTED FROM THE CUTE SHEEP TO THE CROCODILE. The sheep no longer
  // belly-rests at all after the re-proportioning (see the pin above), so this
  // measurement had quietly become vacuous — `worst` never left its initial 0
  // and both bounds passed on a body that never went down. The crocodile is
  // the body that exercises the path now, and it reproduces the same two
  // regimes on the same two activities: ~0.24 of a leg of air in the deepest
  // play bow, and none at all while eating.
  const worstClearance = (act: Activity): number => {
    const bp = speciesBlueprint("crocodile");
    let worst = 0;
    for (const skel of drive(bp, act, 4)) {
      if (!skel.support.body.bellyRest) continue;
      for (const leg of skel.support.legs) {
        if (leg.role !== "support" || leg.grounded) continue;
        const ball = ballOf(skel, leg.chain)!;
        worst = Math.max(worst, ball.y / chainReach(skel, leg.chain));
      }
    }
    return worst;
  };

  it("eating: the splayed foot is at the floor", () => {
    expect(worstClearance("eat")).toBeLessThan(0.1); // measured 0 — every leg planted
  });

  it("the deep play bow leaves air, but less than a third of a leg", () => {
    expect(worstClearance("play")).toBeLessThan(0.3); // measured ~0.24
    expect(worstClearance("play")).toBeGreaterThan(0); // and it is not vacuous
  });
});
