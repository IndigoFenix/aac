// CARRIED LOADS + REFUSAL — phase 5 of the creature stress model
// (shared/world-engine/creatures/physio.ts, the `loads` half of
// `SkeletonPhysics`, and `CreatureAnimator`'s emission of them).
//
// 🚨 THE CENTRAL CLAIM: a carried load is extra WEIGHT AT AN ATTACHMENT, not
// a ground contact. It raises the total the legs hold, drags the CoM toward
// itself, and bends the part it hangs from — and every one of those goes
// through machinery that already existed (`solveFootForces`, the combined
// CoM, the same cantilever law the neck has always been measured by). Nothing
// in this file asks the solver to know that loads exist.
//
// The other half is REFUSAL: `pickUp` returns false when the body cannot bear
// the mass. The gate is `physio.canBear`, its threshold is the ledger's own
// `MAX_BEARABLE_STRESS` (1.0 = at capacity), and it is absolute — a body the
// ledger already reads as overloaded (the tyrannosaur, at σ ≈ 1.88 standing
// empty) refuses everything, deliberately.
//
// 🚨 2026-09-03: THE OVER-CAPACITY BODY USED TO BE THE COW (σ ~3.8, from legs
// with ~1/13 the dog's cross-section). The re-proportioning round put every
// limb in the registry on the Campione line and the cow now reads 0.73 —
// viable — so the refusal pins moved to the tyrannosaur, which is over
// capacity for a reason no amount of authoring removes: a biped's leg carries
// W/2, and 7 t is past where that works.
//
// ⚠️ EVERY MASS IN THIS FILE IS A FRACTION OF THE BODY'S OWN, never a literal
// proxy number. Proxy mass goes as L³, so the shipped dog's fell ~27× when its
// torso went from 1.7 m to a real labrador's 0.55 m, and three hardcoded
// masses here silently became "several times the whole animal".

import { describe, it, expect } from "@jest/globals";
import { buildSkeleton, type CreatureSkeleton } from "@shared/world-engine/creatures/skeleton.js";
import { speciesBlueprint } from "@shared/world-engine/creatures/species.js";
import { CreatureAnimator } from "@shared/world-engine/creatures/animation.js";
import {
  canBear,
  combinedCoM,
  loadMassTotal,
  objectMassFromSize,
  MAX_BEARABLE_STRESS,
  type CarriedLoad,
} from "@shared/world-engine/creatures/physio.js";

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const legForce = (skel: CreatureSkeleton, prefix: string): number =>
  sum(skel.support.legs.filter((l) => l.chain.startsWith(prefix)).map((l) => l.force));
/** Highest torso bone — the stand height, in the ledger's own frame. */
const standY = (skel: CreatureSkeleton): number =>
  Math.max(...skel.bones.filter((b) => b.kind === "torso").map((b) => b.head.y));

/** The load the shipped dog's mouth is at: the snout tip, ahead and up. */
function snoutTip(skel: CreatureSkeleton): CarriedLoad["at"] {
  const snout = skel.bones.filter((b) => b.chain === "snout" || b.chain === "jaw");
  const last = snout[snout.length - 1] ?? skel.bones.filter((b) => b.kind === "head").pop()!;
  return last.tail;
}

/** Top of the fattest torso bone — where `setBackLoad` puts a pack. */
function girthPeak(skel: CreatureSkeleton): CarriedLoad["at"] {
  let fat = skel.bones.find((b) => b.kind === "torso")!;
  for (const b of skel.bones) {
    if (b.kind === "torso" && b.radiusHead + b.radiusTail > fat.radiusHead + fat.radiusTail) fat = b;
  }
  return {
    x: (fat.head.x + fat.tail.x) / 2,
    y: (fat.head.y + fat.tail.y) / 2 + (fat.radiusHead + fat.radiusTail) / 2,
    z: (fat.head.z + fat.tail.z) / 2,
  };
}

/**
 * Drive the animator the way a host does — update, build, observe — for
 * `seconds`, merging the frame's loads into `phys` exactly as the contract on
 * `AnimFrame.loads` says to. Same shape as world-engine-activities.test.ts's
 * loop, with the build in it (loads only exist on a built body).
 */
function run(
  anim: CreatureAnimator,
  bp: ReturnType<typeof speciesBlueprint>,
  seconds: number,
  gravity = 1,
  dt = 1 / 30,
): CreatureSkeleton {
  let skel = buildSkeleton(bp, undefined, undefined, undefined, { gravity });
  anim.observe(skel);
  for (let t = 0; t < seconds; t += dt) {
    const frame = anim.update(dt);
    bp.posture.bodyPitch = frame.posture.bodyPitch;
    bp.posture.bodyHeight = frame.posture.bodyHeight;
    skel = buildSkeleton(bp, frame.gait, frame.pose, undefined, { gravity, loads: frame.loads });
    anim.observe(skel);
  }
  return skel;
}

// ── The ledger with a load in it ─────────────────────────────────────────

describe("a carried load enters the force balance", () => {
  it("Σ leg forces (+ the belly's share) = (body + load) × gravity, exactly", () => {
    const bp = speciesBlueprint("dog");
    const bare = buildSkeleton(bp);
    const load: CarriedLoad[] = [{ mass: 0.02, at: snoutTip(bare) }];
    for (const gravity of [1, 2.5]) {
      const skel = buildSkeleton(bp, undefined, undefined, undefined, { gravity, loads: load });
      const s = skel.support;
      expect(s.body.loadMass).toBeCloseTo(0.02, 12);
      expect(s.body.weight).toBeCloseTo((s.body.mass + 0.02) * gravity, 12);
      const carriedByLegs = sum(s.legs.map((l) => l.force));
      const carriedByBelly = s.body.bellyShare * s.body.weight;
      expect(carriedByLegs + carriedByBelly).toBeCloseTo(s.body.weight, 12);
    }
  });

  it("the balanced CoM is the body's own plus the load's, mass-weighted", () => {
    const bp = speciesBlueprint("dog");
    const bare = buildSkeleton(bp);
    const at = snoutTip(bare);
    const loads: CarriedLoad[] = [{ mass: 0.05, at }];
    const laden = buildSkeleton(bp, undefined, undefined, undefined, { loads });
    const expected = combinedCoM(bare.support.body.mass, bare.support.body.com, loads);
    // The body's own CoM moved a little (the stance sags under the load), so
    // this is a direction check, not an equality: the system CoM sits between
    // the body's and the load's, and the load is out front.
    expect(laden.support.body.com.z).toBeGreaterThan(bare.support.body.com.z);
    expect(laden.support.body.com.z).toBeLessThan(at.z);
    expect(expected.com.z).toBeGreaterThan(bare.support.body.com.z);
  });

  it("a mouth-carried load shifts the dog's fore/hind split FORWARD", () => {
    const bp = speciesBlueprint("dog");
    const bare = buildSkeleton(bp);
    const before = legForce(bare, "limb0") / legForce(bare, "limb1");
    const skel = buildSkeleton(bp, undefined, undefined, undefined, {
      loads: [{ mass: 0.02, at: snoutTip(bare) }],
    });
    const after = legForce(skel, "limb0") / legForce(skel, "limb1");
    expect(after).toBeGreaterThan(before * 1.02);
    // …and the neck is the chain that pays for it.
    expect(skel.support.chainStress.neck).toBeGreaterThan(bare.support.chainStress.neck * 1.1);
  });

  it("a back load at the girth peak loads every standing leg, spine up, neck untouched", () => {
    const bp = speciesBlueprint("dog");
    const bare = buildSkeleton(bp);
    const skel = buildSkeleton(bp, undefined, undefined, undefined, {
      loads: [{ mass: 0.5 * bare.support.body.mass, at: girthPeak(bare) }],
    });
    for (const leg of skel.support.legs) {
      if (!leg.grounded) continue;
      const was = bare.support.legs.find((l) => l.chain === leg.chain)!;
      expect(leg.force).toBeGreaterThan(was.force);
    }
    // Every leg is more loaded, and the split does NOT run forward the way a
    // mouth carry's does — that is the difference between a pack and a bite.
    const beforeSplit = legForce(bare, "limb0") / legForce(bare, "limb1");
    const afterSplit = legForce(skel, "limb0") / legForce(skel, "limb1");
    expect(afterSplit).toBeLessThan(beforeSplit);
    expect(skel.support.chainStress.spine).toBeGreaterThan(bare.support.chainStress.spine * 1.2);
    // A pack is not on the neck: the head's cantilever is exactly what it was.
    expect(skel.support.chainStress.neck).toBeCloseTo(bare.support.chainStress.neck, 12);
  });

  it("a hand-carried load stresses the LIMB that holds it, un-grounded or not", () => {
    const bp = speciesBlueprint("human_cute");
    const bare = buildSkeleton(bp);
    // Out at an arm's tip: pick the arm's own last bone so the attribution is
    // unambiguous (nearest-bone, so a point ON the arm is the arm's).
    const arm = bare.bones.filter((b) => b.kind === "limb" && b.chain.startsWith("limb1R"));
    expect(arm.length).toBeGreaterThan(0);
    const at = arm[arm.length - 1].tail;
    const skel = buildSkeleton(bp, undefined, undefined, undefined, { loads: [{ mass: 0.004, at }] });
    const row = skel.support.legs.find((l) => l.chain === "limb1R")!;
    const was = bare.support.legs.find((l) => l.chain === "limb1R")!;
    expect(row.stress).toBeGreaterThan(was.stress);
    // The arm carries no ground force at all — the stress is pure bending,
    // which is exactly the reading a `force: 0` limb could not give before.
    expect(row.force).toBe(0);
    expect(row.stress).toBeGreaterThan(0);
  });

  it("the stance SAGS under a load, and only under a load", () => {
    const bp = speciesBlueprint("dog");
    const bare = buildSkeleton(bp);
    // 🚨 BOTH LOADS ARE FRACTIONS OF THE BODY. `light` used to be the literal
    // proxy mass 0.02, which was ~7% of the 1.7 m dog this test was written on.
    // The re-proportioning made the same animal a real 30 kg labrador at
    // 0.55 m, and a body's proxy mass goes as L³ — so the dog's own mass fell
    // to 0.0094 and the hardcoded "light" load became 2.1× the whole animal,
    // i.e. four times the "heavy" one. The pin failed because the two were the
    // wrong way round, which is exactly what an absolute mass on a re-sized
    // body will always eventually do.
    const light = buildSkeleton(bp, undefined, undefined, undefined, {
      loads: [{ mass: 0.02 * bare.support.body.mass, at: girthPeak(bare) }],
    });
    const heavy = buildSkeleton(bp, undefined, undefined, undefined, {
      loads: [{ mass: 0.5 * bare.support.body.mass, at: girthPeak(bare) }],
    });
    expect(standY(light)).toBeLessThan(standY(bare));
    expect(standY(heavy)).toBeLessThan(standY(light));
    // Gravity is NOT in the sag — it may never move a bone (phase 1's law).
    const g3 = buildSkeleton(bp, undefined, undefined, undefined, { gravity: 3 });
    expect(standY(g3)).toBe(standY(bare));
    // An empty load list is not a load.
    const none = buildSkeleton(bp, undefined, undefined, undefined, { loads: [] });
    expect(standY(none)).toBe(standY(bare));
  });
});

// ── physio's own units and gate ──────────────────────────────────────────

describe("load units and the bearing gate", () => {
  it("objectMassFromSize is a sphere of that diameter, π dropped", () => {
    expect(objectMassFromSize(0.6)).toBeCloseTo(0.6 ** 3 / 6, 12);
    expect(objectMassFromSize(0.6, 0.5)).toBeCloseTo(objectMassFromSize(0.6) / 2, 12);
    expect(objectMassFromSize(-1)).toBe(0);
    // Cubes an object's size: twice as wide is eight times as heavy.
    expect(objectMassFromSize(0.4) / objectMassFromSize(0.2)).toBeCloseTo(8, 9);
  });

  it("loadMassTotal / combinedCoM are no-ops with nothing carried", () => {
    expect(loadMassTotal(undefined)).toBe(0);
    expect(loadMassTotal([])).toBe(0);
    expect(loadMassTotal([{ mass: -1, at: { x: 0, y: 0, z: 0 } }])).toBe(0);
    const com = { x: 1, y: 2, z: 3 };
    expect(combinedCoM(5, com, undefined).com).toBe(com); // same object, untouched
    expect(combinedCoM(5, com, []).mass).toBe(5);
  });

  it("canBear binds on whichever of stance and carrier gives out first", () => {
    const strongLegs = [10, 10, 10, 10];
    expect(canBear({ totalWeight: 1, stanceStrengths: strongLegs }).ok).toBe(true);
    const crushed = canBear({ totalWeight: 100, stanceStrengths: strongLegs });
    expect(crushed.ok).toBe(false);
    expect(crushed.bind).toBe("stance");
    // Legs to spare, but the arm holding it out front cannot.
    const bent = canBear({
      totalWeight: 1,
      stanceStrengths: strongLegs,
      carrier: { load: 5, lever: 0.5, radius: 0.05 },
    });
    expect(bent.ok).toBe(false);
    expect(bent.bind).toBe("carrier");
    expect(bent.limit).toBe(MAX_BEARABLE_STRESS);
    // No legs on the ground = the legs are not what holds this body up (a
    // belly rest, a swimmer): the stance side cannot bind.
    expect(canBear({ totalWeight: 1e6 }).ok).toBe(true);
  });
});

// ── Refusal, through the animator ────────────────────────────────────────

describe("CreatureAnimator refuses what it cannot carry", () => {
  it("an absurd mass is refused and starts NOTHING; a modest one completes", () => {
    const bp = speciesBlueprint("dog");
    const anim = new CreatureAnimator(bp);
    run(anim, bp, 0.5);
    const target = { x: 0, y: 0.05, z: 0.7 * bp.spine.torsoLengthM };

    expect(anim.pickUp(target, 0.2, 50)).toBe(false);
    expect(anim.currentAction).toBe("none");
    const why = anim.lastRefusal();
    expect(why?.ok).toBe(false);
    expect(why?.bind).toBe("carrier"); // a dog's neck, not its legs
    // A refused pick-up leaves the animator exactly as it was.
    expect(anim.update(0).loads).toBeUndefined();

    expect(anim.pickUp(target, 0.2)).toBe(true);
    expect(anim.lastRefusal()).toBeNull();
    const skel = run(anim, bp, 6);
    expect(anim.currentAction).toBe("carry");
    expect(skel.support.body.loadMass).toBeCloseTo(objectMassFromSize(0.2), 12);
    // The load rides at the snout, and the ledger says the neck is holding it.
    expect(skel.support.chainStress.neck).toBeGreaterThan(
      buildSkeleton(speciesBlueprint("dog")).support.chainStress.neck);
  });

  it("emits AnimFrame.loads only while actually holding", () => {
    const bp = speciesBlueprint("dog");
    const anim = new CreatureAnimator(bp);
    run(anim, bp, 0.5);
    expect(anim.update(0).loads).toBeUndefined();
    expect(anim.pickUp({ x: 0, y: 0.05, z: 0.7 * bp.spine.torsoLengthM }, 0.2)).toBe(true);
    // Still reaching: the object is on the GROUND, and a thing on the ground
    // is not a load.
    expect(anim.update(1 / 30).loads).toBeUndefined();
    run(anim, bp, 6);
    const carrying = anim.update(0);
    expect(carrying.loads).toHaveLength(1);
    expect(carrying.loads![0].mass).toBeCloseTo(objectMassFromSize(0.2), 12);
    expect(carrying.loads![0].at.z).toBeGreaterThan(0); // out at the muzzle
    expect(anim.carriedMass()).toBeCloseTo(objectMassFromSize(0.2), 12);
  });

  it("a pack rides the back every frame until it is cleared, and is never refused", () => {
    const bp = speciesBlueprint("dog");
    const anim = new CreatureAnimator(bp);
    const bare = run(anim, bp, 0.5);
    const pack = 0.5 * bare.support.body.mass;
    anim.setBackLoad(pack);
    expect(anim.backLoadMass).toBe(pack);
    const laden = run(anim, bp, 1);
    expect(laden.support.body.loadMass).toBeCloseTo(pack, 12);
    const peak = girthPeak(laden);
    const emitted = anim.update(0).loads![0];
    expect(emitted.at.z).toBeCloseTo(peak.z, 6);
    expect(emitted.at.y).toBeCloseTo(peak.y, 6);
    expect(laden.support.chainStress.spine).toBeGreaterThan(bare.support.chainStress.spine);
    anim.setBackLoad(0);
    expect(run(anim, bp, 1).support.body.loadMass).toBe(0);
  });

  it("an already-overloaded body (the tyrannosaur) refuses everything", () => {
    // 🚨 THE BODY CHANGED, THE GATE DID NOT. This pin used to run on the cow,
    // which shipped legs with ~1/13 the dog's cross-section and read a mean leg
    // stress of ~3.8 standing empty. The re-proportioning put the cow's limbs
    // on the Campione line and it now reads 0.73 — a viable 700 kg Holstein
    // (creature-physics.test.ts) — so it is no longer an example of anything
    // here, and the gate would have been tested against a body that passes it.
    //
    // The registry's over-capacity body is now the tyrannosaur, and it is over
    // capacity for a reason that cannot be authored away: a 7 t biped's leg
    // carries W/2 where a quadruped's carries W/4, and the allometric residual
    // at 7000 kg is another ~4.4×. It reads σ ≈ 1.88 standing empty.
    //
    // ⚖️ WHAT IS BEING TESTED IS THE POLICY, and physio.ts states it out loud:
    // NO EXEMPTION FOR AN ALREADY-OVERLOADED BODY. Such a body refuses EVERY
    // load, including a weightless one, because measuring a load against a body
    // the ledger already calls overloaded is a silent exemption that would make
    // the gate mean nothing for exactly the bodies it should be loudest about.
    // The refusal must bind on the STANCE — not on the carrier — because it is
    // the legs that are out of margin, and `lastRefusal` must say so.
    const bp = speciesBlueprint("tyrannosaur");
    const anim = new CreatureAnimator(bp);
    const skel = run(anim, bp, 0.5);
    // The premise: it ships over capacity standing empty.
    expect(skel.support.chainStress.spine).toBeGreaterThan(MAX_BEARABLE_STRESS);
    expect(anim.pickUp({ x: 0, y: 0.05, z: 0.7 * bp.spine.torsoLengthM }, 0.05)).toBe(false);
    expect(anim.lastRefusal()?.bind).toBe("stance");
    expect(anim.lastRefusal()?.stance).toBeGreaterThan(MAX_BEARABLE_STRESS);
    expect(anim.currentAction).toBe("none");

    // …and the retired premise, asserted so nobody re-points this at the cow:
    // the cow now passes the gate it used to fail.
    const cow = speciesBlueprint("cow");
    const cowAnim = new CreatureAnimator(cow);
    const cowSkel = run(cowAnim, cow, 0.5);
    expect(cowSkel.support.chainStress.spine).toBeLessThan(MAX_BEARABLE_STRESS);
  });

  it("gravity ×2 roughly halves what the body will pick up", () => {
    /** Coarse bisection on the biggest mass the dog will accept. */
    const boundary = (gravity: number): number => {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        const bp = speciesBlueprint("dog");
        const anim = new CreatureAnimator(bp);
        run(anim, bp, 0.4, gravity);
        if (anim.pickUp({ x: 0, y: 0.05, z: 0.7 * bp.spine.torsoLengthM }, 0.2, mid)) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    const g1 = boundary(1);
    const g2 = boundary(2);
    expect(g1).toBeGreaterThan(0);
    // Twice the gravity, at most half the load — and in fact less, because the
    // neck's own doubled head eats into the same budget.
    expect(g2).toBeLessThan(g1 / 2);
    expect(g2).toBeGreaterThan(0);
  });

  it("a heavier object takes longer to lift", () => {
    // 🚨 THE MASSES ARE FRACTIONS OF THE BODY. They used to be the literal
    // proxy masses 0.001 and 0.03 ("~11% of the dog's body mass", said the
    // comment, and it was — of a 1.7 m dog). The re-proportioned 0.55 m
    // labrador's whole proxy mass is 0.0094, so 0.03 became 3.2× the animal
    // and `pickUp` refused it outright on the CARRIER: the dog's neck cannot
    // hold three of itself out at the muzzle, and it is right not to.
    // Restated as fractions, the comparison is the one the test means.
    const lift = (fraction: number): number => {
      const bp = speciesBlueprint("dog");
      const anim = new CreatureAnimator(bp);
      const bare = run(anim, bp, 0.5);
      const mass = fraction * bare.support.body.mass;
      expect(anim.pickUp({ x: 0, y: 0.05, z: 0.7 * bp.spine.torsoLengthM }, 0.2, mass)).toBe(true);
      const dt = 1 / 60;
      let t = 0;
      let sawLift = false;
      let skel = buildSkeleton(bp);
      for (let i = 0; i < 60 * 20; i++) {
        const frame = anim.update(dt);
        bp.posture.bodyPitch = frame.posture.bodyPitch;
        bp.posture.bodyHeight = frame.posture.bodyHeight;
        skel = buildSkeleton(bp, frame.gait, frame.pose, undefined, { loads: frame.loads });
        anim.observe(skel);
        if (frame.action === "lift") { sawLift = true; t += dt; }
        else if (sawLift) break;
      }
      expect(sawLift).toBe(true);
      return t;
    };
    const light = lift(0.004); // 0.4% of the body — near enough to nothing
    const heavy = lift(0.11); // ~11% of the dog's body mass, still legal
    // Measured 1.27 s against 1.53 s.
    expect(heavy).toBeGreaterThan(light * 1.1);
  });
});
