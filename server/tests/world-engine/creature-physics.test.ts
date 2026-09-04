// THE STRESS LEDGER — what a body weighs, what holds it up, and what that
// costs each leg (shared/world-engine/creatures/physio.ts + the `support`
// block skeleton.ts hangs off every built skeleton).
//
// ⚖️ PHASE 1 IS DIAGNOSTICS ONLY. Nothing in the ledger may move a bone. The
// pins at the bottom of this file are the guarantee: gravity ×2 doubles every
// force and leaves every bone point untouched, and passing the `phys` param at
// all changes nothing about the pose.
//
// The two shipped defects this ledger exists to make visible:
//   • THE HANDSTAND — pitch the trunk nose-down and the hind hips rise out of
//     leg reach; `solveFoot` returns null, the hind legs drop out of support
//     for FREE, and the body stands on its forelegs. The ledger now says so
//     numerically (hind force 0, fore stress up ~60%, tipping ≈ 0.2 m).
//   • THE CUTE FLOATS — girth ×2.25 makes the belly the floor and the legs
//     that cannot reach dangle. Same signature.
// The handstand pin has since FLIPPED (phase 3): posture negotiates with the
// ledger, so a nose-down trunk now bows over its rear feet instead of standing
// on its forelegs, and the test asserts the fix. The float pin still describes
// the bug — a body whose belly is on the ground is not a posture to bargain
// over, and phase 4 owns it.

import { describe, it, expect } from "@jest/globals";
import { clampBlueprint, type Blueprint } from "@shared/world-engine/creatures/blueprint.js";
import {
  buildSkeleton,
  type CreatureSkeleton,
  type LegSupport,
} from "@shared/world-engine/creatures/skeleton.js";
import { speciesBlueprint } from "@shared/world-engine/creatures/species.js";
import {
  boneMass,
  contactStrength,
  legStrength,
  massProperties,
  solveFootForces,
  stress,
  BEND_STRENGTH,
  boneFraction,
  boneStressPa,
  buckleCapacity,
  BUCKLE_STRENGTH,
  campioneCircumferenceMm,
  campioneLimbRadiusM,
  campioneMassKg,
  cantileverStress,
  emaMultiplier,
  legCapacity,
  massKg,
  proxyMassOf,
  EMA_REF,
  K_BONE,
  K_BONE_EXO,
  MUSCLE_MOMENT_FRAC,
  MUSCLE_STRENGTH,
  PROXY_FORCE_N,
  SAFETY_FACTOR,
} from "@shared/world-engine/creatures/physio.js";

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const bone = (
  head: [number, number, number],
  tail: [number, number, number],
  r0: number,
  r1 = r0,
) => ({
  head: { x: head[0], y: head[1], z: head[2] },
  tail: { x: tail[0], y: tail[1], z: tail[2] },
  radiusHead: r0,
  radiusTail: r1,
});

// ── solveFootForces ──────────────────────────────────────────────────────

describe("solveFootForces distributes a body's weight over its feet", () => {
  const square = [
    { x: -0.2, z: 0.5 },
    { x: 0.2, z: 0.5 },
    { x: -0.2, z: -0.5 },
    { x: 0.2, z: -0.5 },
  ];

  it("splits a centered load evenly over four feet", () => {
    const r = solveFootForces({ feet: square, com: { x: 0, z: 0 }, weight: 100 });
    for (const f of r.forces) expect(f).toBeCloseTo(25, 6);
    expect(sum(r.forces)).toBeCloseTo(100, 9);
    expect(r.tipping).toBeCloseTo(0, 9);
    expect(r.centerOfPressure!.z).toBeCloseTo(0, 9);
  });

  it("loads the near feet harder when the CoM shifts toward one end", () => {
    // CoM 0.3 forward of center: the front pair is 0.2 away, the back pair
    // 0.8 — so the front pair must carry four times as much.
    const r = solveFootForces({ feet: square, com: { x: 0, z: 0.3 }, weight: 100 });
    expect(sum(r.forces)).toBeCloseTo(100, 9);
    for (const f of r.forces) expect(f).toBeGreaterThanOrEqual(0);
    expect(r.forces[0]).toBeCloseTo(r.forces[1], 6); // left/right symmetric
    expect(r.forces[2]).toBeCloseTo(r.forces[3], 6);
    expect(r.forces[0]).toBeGreaterThan(r.forces[2]);
    expect(r.forces[0] / r.forces[2]).toBeCloseTo(4, 1);
    expect(r.tipping).toBeLessThan(1e-6); // still balanced: no moment left over
  });

  it("gives a lone foot the whole weight", () => {
    const r = solveFootForces({ feet: [{ x: 0.1, z: -0.2 }], com: { x: 0, z: 0 }, weight: 42 });
    expect(r.forces).toEqual([42]);
    // One foot cannot balance a CoM anywhere but directly above it, and the
    // tipping measure is exactly that offset.
    expect(r.tipping).toBeCloseTo(Math.hypot(0.1, 0.2), 9);
    expect(r.tipDir.x).toBeCloseTo(-0.1 / Math.hypot(0.1, 0.2), 6);
  });

  it("returns nothing at all with no feet — the belly bears the body", () => {
    const r = solveFootForces({ feet: [], com: { x: 0, z: 0 }, weight: 100 });
    expect(r.forces).toEqual([]);
    expect(r.centerOfPressure).toBeNull();
    expect(r.tipping).toBe(0); // there is no support polygon to fall out of
  });

  it("balances a collinear pair along their line", () => {
    // Two feet on the z axis, CoM a third of the way from the front one.
    const feet = [{ x: 0, z: 1 }, { x: 0, z: -1 }];
    const r = solveFootForces({ feet, com: { x: 0, z: 0.5 }, weight: 90 });
    expect(sum(r.forces)).toBeCloseTo(90, 9);
    expect(r.forces[0]).toBeCloseTo(67.5, 4); // lever 1.5 vs 0.5
    expect(r.forces[1]).toBeCloseTo(22.5, 4);
    expect(r.tipping).toBeLessThan(1e-6);
  });

  it("tips ACROSS a collinear pair — the line is not a polygon", () => {
    const feet = [{ x: 0, z: 1 }, { x: 0, z: -1 }];
    const r = solveFootForces({ feet, com: { x: 0.4, z: 0 }, weight: 90 });
    expect(sum(r.forces)).toBeCloseTo(90, 9);
    expect(r.tipping).toBeCloseTo(0.4, 6); // the whole lateral offset is unbalanced
    expect(r.tipDir.x).toBeCloseTo(1, 6);
  });

  it("zeroes the far feet and reports the overhang when the CoM leaves the polygon", () => {
    // 🚨 THE HANDSTAND SHAPE. CoM 0.4 m ahead of the front feet: no
    // non-negative force set can zero the moment, the back pair goes to
    // zero, and what is left over is the tipping distance.
    const r = solveFootForces({ feet: square, com: { x: 0, z: 0.9 }, weight: 100 });
    expect(sum(r.forces)).toBeCloseTo(100, 9);
    expect(r.forces[2]).toBeCloseTo(0, 9);
    expect(r.forces[3]).toBeCloseTo(0, 9);
    expect(r.forces[0]).toBeCloseTo(50, 6);
    expect(r.forces[1]).toBeCloseTo(50, 6);
    expect(r.tipping).toBeCloseTo(0.4, 6); // CoP pinned at the front edge, z = 0.5
    expect(r.tipDir.z).toBeCloseTo(1, 6); // it falls forward
    expect(r.centerOfPressure!.z).toBeCloseTo(0.5, 6);
  });

  it("never asks a foot to pull, whatever the CoM does", () => {
    for (const cz of [-2, -0.9, -0.3, 0, 0.3, 0.9, 2]) {
      for (const cx of [-1.5, -0.21, 0, 0.21, 1.5]) {
        const r = solveFootForces({ feet: square, com: { x: cx, z: cz }, weight: 7 });
        expect(sum(r.forces)).toBeCloseTo(7, 9);
        for (const f of r.forces) expect(f).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(r.tipping)).toBe(true);
      }
    }
  });

  it("is deterministic — the same input gives byte-identical forces", () => {
    const inp = { feet: square, com: { x: 0.07, z: -0.31 }, weight: 13.5 };
    expect(solveFootForces(inp).forces).toEqual(solveFootForces(inp).forces);
  });
});

// ── Mass properties + strength ───────────────────────────────────────────

describe("stiffness lets a BELLY share the load with the feet", () => {
  // Phase 4's pure-math half. `stiffness` is a capacity per contact — it does
  // not touch the moment balance, it only decides how a moment-TIED family of
  // force sets is split. Handed contact areas, that split is "every contact
  // reaches the same ground pressure", which is what puts ~all of a lying
  // animal's weight on its belly and almost none on its toes.
  const square = [
    { x: -0.2, z: 0.5 },
    { x: 0.2, z: 0.5 },
    { x: -0.2, z: -0.5 },
    { x: 0.2, z: -0.5 },
  ];

  it("is a strict no-op when every contact has the same capacity", () => {
    // The regression guard for the whole registry: identical weights must
    // reproduce the unweighted answer, or every shipped body's forces move.
    const plain = solveFootForces({ feet: square, com: { x: 0, z: 0.3 }, weight: 100 });
    const flat = solveFootForces({
      feet: square, com: { x: 0, z: 0.3 }, weight: 100, stiffness: [7, 7, 7, 7],
    });
    for (let i = 0; i < 4; i++) expect(flat.forces[i]).toBeCloseTo(plain.forces[i], 9);
  });

  it("splits a load in proportion to capacity when every lever cancels", () => {
    // 🚨 THE TIE-BREAK, ISOLATED. With all four contacts stacked on the CoM
    // there is no moment to balance at all, so nothing but the capacity share
    // can decide — and it lands on it exactly. (Spread them out and the
    // moment takes over, which is the next pin.)
    const stacked = [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }];
    const r = solveFootForces({
      feet: stacked, com: { x: 0, z: 0 }, weight: 100, stiffness: [1, 1, 3, 5],
    });
    expect(r.forces[0]).toBeCloseTo(10, 5);
    expect(r.forces[1]).toBeCloseTo(10, 5);
    expect(r.forces[2]).toBeCloseTo(30, 5);
    expect(r.forces[3]).toBeCloseTo(50, 5);
    expect(sum(r.forces)).toBeCloseTo(100, 9);
    expect(r.tipping).toBeCloseTo(0, 9);
  });

  it("gives a wide belly nearly everything and the paws nearly nothing", () => {
    // The shape of a real belly rest: four small feet and a broad patch, all
    // laid out symmetrically about the CoM so the capacity split is ALSO the
    // balanced one — which is exactly the situation an animal lying still is
    // in, and the reason its toes come off load.
    const feet = [
      ...square,
      { x: 0, z: 0.25 }, { x: 0, z: -0.25 },
    ];
    const r = solveFootForces({
      feet, com: { x: 0, z: 0 }, weight: 100, stiffness: [1, 1, 1, 1, 100, 100],
    });
    const belly = r.forces[4] + r.forces[5];
    expect(belly / 100).toBeGreaterThan(0.97);
    for (let i = 0; i < 4; i++) expect(r.forces[i]).toBeLessThan(1);
    expect(sum(r.forces)).toBeCloseTo(100, 9);
    expect(r.tipping).toBeCloseTo(0, 6);
  });

  it("still puts the MOMENT first — capacity only breaks ties", () => {
    // A strong contact far from the CoM does not get to drag the centre of
    // pressure off it. Balance is a CONSTRAINT; capacity is a preference, and
    // a preference never outranks a constraint. Here the moment fixes the
    // split at 25/75 outright and the 100:1 capacity ratio cannot move it.
    const r = solveFootForces({
      feet: [{ x: 0, z: -1 }, { x: 0, z: 1 }],
      com: { x: 0, z: 0.5 }, weight: 100, stiffness: [100, 1],
    });
    expect(r.tipping).toBeLessThan(1e-5); // ε is a real, bounded perturbation
    expect(r.centerOfPressure!.z).toBeCloseTo(0.5, 4);
    expect(r.forces[0]).toBeCloseTo(25, 3);
    expect(r.forces[1]).toBeCloseTo(75, 3); // the NEAR foot, weak as it is
    expect(sum(r.forces)).toBeCloseTo(100, 9);
  });

  it("treats a capacity-less contact as carrying nothing, never NaN", () => {
    const stacked = [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }];
    const r = solveFootForces({
      feet: stacked, com: { x: 0, z: 0 }, weight: 100, stiffness: [0, 1, 1, 1],
    });
    expect(r.forces.every((f) => Number.isFinite(f))).toBe(true);
    expect(r.forces[0]).toBeLessThan(0.01);
    for (let i = 1; i < 4; i++) expect(r.forces[i]).toBeCloseTo(100 / 3, 2);
    expect(sum(r.forces)).toBeCloseTo(100, 9);
  });

  it("ignores a stiffness list that does not match the contacts", () => {
    const plain = solveFootForces({ feet: square, com: { x: 0, z: 0.3 }, weight: 100 });
    const bad = solveFootForces({
      feet: square, com: { x: 0, z: 0.3 }, weight: 100, stiffness: [1, 2],
    });
    for (let i = 0; i < 4; i++) expect(bad.forces[i]).toBeCloseTo(plain.forces[i], 12);
  });
});

describe("contactStrength is the one bearing law", () => {
  it("is what legStrength is built out of", () => {
    // A belly and a hoof are only comparable because they are measured the
    // same way — an area against the same muscle constant.
    const r = 0.07;
    expect(legStrength(r)).toBeCloseTo(contactStrength(Math.PI * r * r), 12);
    expect(contactStrength(1)).toBeCloseTo(MUSCLE_STRENGTH, 12);
    expect(contactStrength(-3)).toBe(0);
  });
});

describe("mass properties are a volume proxy over EVERY bone kind", () => {
  it("weighs a cylinder as r²·len and centres it at the midpoint", () => {
    const b = bone([0, 0, 0], [0, 0, 2], 0.5);
    expect(boneMass(b)).toBeCloseTo(0.25 * 2, 9);
    const p = massProperties([b]);
    expect(p.mass).toBeCloseTo(0.5, 9);
    expect(p.com.z).toBeCloseTo(1, 9);
  });

  it("pulls a tapered bone's centre toward its THICK end", () => {
    // A cone tapering to a point has its centroid a quarter of the way along.
    const p = massProperties([bone([0, 0, 0], [0, 0, 4], 1, 0)]);
    expect(p.com.z).toBeCloseTo(1, 6);
  });

  it("counts head, neck and limb bones the legacy bodyMass ignores", () => {
    const trunk = bone([0, 1, -0.5], [0, 1, 0.5], 0.3);
    const head = bone([0, 1.2, 0.5], [0, 1.2, 0.8], 0.2);
    const both = massProperties([trunk, head]);
    expect(both.mass).toBeCloseTo(boneMass(trunk) + boneMass(head), 9);
    expect(both.com.z).toBeGreaterThan(massProperties([trunk]).com.z);
  });
});

describe("leg strength is an absolute cross-section", () => {
  it("scales with area, not radius", () => {
    expect(legStrength(0.2) / legStrength(0.1)).toBeCloseTo(4, 6);
    expect(legStrength(0.1)).toBeCloseTo(Math.PI * 0.01 * MUSCLE_STRENGTH, 9);
  });

  it("discounts a membranous limb — a wing is skin, not a pillar", () => {
    expect(legStrength(0.1, 1)).toBeCloseTo(legStrength(0.1) * 0.3, 9);
    expect(legStrength(0.1, 0.5)).toBeLessThan(legStrength(0.1));
  });

  it("reads 1.0 as at capacity and never returns NaN for a strengthless part", () => {
    expect(stress(5, 10)).toBeCloseTo(0.5, 9);
    expect(stress(10, 10)).toBeCloseTo(1, 9);
    expect(stress(1, 0)).toBe(Infinity);
    expect(stress(0, 0)).toBe(0);
  });
});

// ── Integration on the shipped species ───────────────────────────────────

const SPECIES = ["dog", "horse", "human", "cow"] as const;
/** The bodies the muscle constant was calibrated ON. */
const CALIBRATED = ["dog", "horse"] as const;

const standing = (skel: CreatureSkeleton) => skel.support.legs.filter((l) => l.grounded);

describe("every built skeleton carries a stress ledger", () => {
  it.each(SPECIES)("%s reports a coherent support block", (id) => {
    const skel = buildSkeleton(speciesBlueprint(id));
    const s = skel.support;
    expect(s.body.mass).toBeGreaterThan(0);
    expect(s.body.weight).toBeCloseTo(s.body.mass * 1, 9);
    expect(s.body.gravity).toBe(1);
    expect(Number.isFinite(s.body.com.y)).toBe(true);
    expect(s.legs.length).toBeGreaterThan(0);
    // At least one leg is holding the body up.
    expect(standing(skel).length).toBeGreaterThan(0);
    for (const leg of s.legs) {
      expect(leg.strength).toBeGreaterThan(0);
      expect(Number.isFinite(leg.force)).toBe(true);
      expect(leg.force).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(leg.stress)).toBe(true);
      // A lifted leg bears nothing; a standing one bears something.
      if (leg.grounded) {
        expect(leg.force).toBeGreaterThan(0);
        expect(leg.foot).toBeDefined(); // it planted somewhere
      } else {
        expect(leg.force).toBe(0);
      }
    }
    for (const k of ["spine", "neck", "tail"]) {
      expect(Number.isFinite(s.chainStress[k])).toBe(true);
      expect(s.chainStress[k]).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(SPECIES)("%s hands its whole weight to its feet when it is not belly-resting", (id) => {
    const skel = buildSkeleton(speciesBlueprint(id));
    const s = skel.support;
    if (s.body.bellyRest) {
      // The ground under the trunk carries it — the legs are along for the ride.
      expect(s.body.bellyShare).toBe(1);
      return;
    }
    expect(s.body.bellyShare).toBe(0);
    expect(sum(standing(skel).map((l) => l.force))).toBeCloseTo(s.body.weight, 9);
  });

  it.each(CALIBRATED)("%s reads as a MEASUREMENT against the Campione line", (id) => {
    // 🚨 THIS IS NO LONGER A CALIBRATION TARGET. `MUSCLE_STRENGTH` used to be
    // fitted to these two bodies ("a healthy quadruped works at about half its
    // strength"), which made the test circular: it asserted that the constant
    // had been fitted to the thing it was fitted to. The constant is now
    // derived from Campione & Evans' allometric line and Biewener's safety
    // factor (physio.ts), so what these two bodies read is an OUTPUT.
    //
    // 🚨 THE RE-PROPORTIONING LANDED, AND THESE TWO NUMBERS MOVED WITH IT.
    // Before it, both bodies shipped a torso long enough to weigh ~880 kg and
    // read 0.36–1.4. They are now a real 30 kg labrador on a 0.55 m torso and a
    // real 500 kg horse on a 1.35 m one, and they read:
    //
    //     dog   0.247      horse  0.749
    //
    // 0.25 IS THE RIGHT NEIGHBOURHOOD FOR THE DOG, and the reason is that the
    // dog IS this module's anchor animal. `MUSCLE_STRENGTH` is derived by
    // requiring a line-conforming 30 kg quadruped, in a real quadruped's
    // posture, to read exactly 1/SAFETY_FACTOR ≈ 0.364 (physio.ts). The shipped
    // dog is that animal to within its own posture: it stands a little
    // straighter than the EMA_REF = 2 the constant assumes (measured ema 1.80
    // fore / 2.09 hind), and 0.364 × 1.80/2 ≈ 0.33 on the hardest-worked leg —
    // against a measured 0.295. `chainStress.spine` is the MEAN over the
    // stance, and the hind pair carries less, which brings the mean to 0.247.
    // So the anchor animal reads just under the anchor value because it stands
    // just straighter than the anchor posture. That is the constant being
    // measured back, not a body being flattered.
    //
    // The horse's 0.749 is the allometric residual doing exactly what physio.ts
    // says it does: (500/30)^0.272 ≈ 2.1, and 0.36 × 2.1 ≈ 0.75. A
    // line-conforming half-tonne animal genuinely stands nearer its limit than
    // a 30 kg one. Both are under 1 — neither has spent its margin.
    const s = buildSkeleton(speciesBlueprint(id)).support;
    expect(s.chainStress.spine).toBeGreaterThan(0.15);
    expect(s.chainStress.spine).toBeLessThan(1.2);
    for (const leg of standing(buildSkeleton(speciesBlueprint(id)))) {
      expect(leg.stress).toBeGreaterThan(0);
      expect(leg.stress).toBeLessThan(3);
      // Every leg now reports which failure mode bound it and what its posture
      // costs. A shipped quadruped's legs are stout enough to crush, not
      // buckle, and stand near-columnar.
      expect(leg.bind).toBe("crush");
      expect(leg.ema).toBeGreaterThanOrEqual(1);
      expect(leg.ema).toBeLessThan(4);
    }
  });

  it("reads the re-proportioned cow as a VIABLE 700 kg animal", () => {
    // 🚨 THIS PIN IS FLIPPED, AND THE OLD PREMISE IS RETIRED. It used to assert
    // that the cow was over capacity (σ > 1) — a measurement, not a calibration
    // failure: the cow shipped radiusFrac 0.132/0.150 where the dog and horse
    // shipped 0.432, so its legs had ~1/13 the cross-section under 70% of the
    // mass, and the ledger's job was to SAY so. The comment ended "if the cow's
    // body plan is ever re-authored, this expectation should move with it."
    // It was, so it does.
    //
    // The cow is now a 702 kg Holstein on a 1.6 m torso with limbs ON the
    // Campione line (r/line 1.00), and it reads 0.731 — loaded, as a
    // half-tonne animal on a line-conforming skeleton must be (the same
    // M^0.272 residual that puts the horse at 0.749), and INSIDE its margin.
    // A dairy cow that could not stand up would have been a strange thing for
    // the ledger to keep insisting on.
    //
    // ⚖️ THE TEST'S REAL JOB IS UNCHANGED: the number is finite and the ledger
    // is MEASURING this body rather than special-casing it. Nothing here says
    // "the cow is fine"; it says the cow lands where a body of its mass and
    // thickness lands, which is what makes the number worth reading at all.
    // The refusal gate's over-capacity body is now the tyrannosaur — see
    // creature-loads.test.ts.
    const s = buildSkeleton(speciesBlueprint("cow")).support;
    expect(Number.isFinite(s.chainStress.spine)).toBe(true);
    expect(s.chainStress.spine).toBeLessThan(1);
    // …and not trivially safe either: it is a 700 kg animal, and the ledger
    // must not have averaged that away. Well clear of the 30 kg dog's 0.247.
    expect(s.chainStress.spine).toBeGreaterThan(0.4);
    const dog = buildSkeleton(speciesBlueprint("dog")).support;
    expect(s.chainStress.spine).toBeGreaterThan(dog.chainStress.spine * 2);
  });

  it("holds a human's head over its shoulders, not out front", () => {
    // The neck cantilever is a real load only when the head is CARRIED
    // forward; an upright biped's is nearly free, a quadruped's is not.
    const human = buildSkeleton(speciesBlueprint("human")).support;
    const horse = buildSkeleton(speciesBlueprint("horse")).support;
    expect(human.chainStress.neck).toBeLessThan(0.1);
    expect(horse.chainStress.neck).toBeGreaterThan(human.chainStress.neck);
  });
});

// ── Square-cube ──────────────────────────────────────────────────────────

describe("square-cube scaling falls out of absolute units", () => {
  it("grows standing stress about linearly with body scale", () => {
    // Mass ∝ L³, leg cross-section ∝ L², so stress ∝ L. Everything in the
    // ledger is in absolute meters, so no code anywhere does this on purpose.
    const base = speciesBlueprint("dog");
    const at = (k: number): number => {
      const bp = clampBlueprint({
        ...base,
        spine: { ...base.spine, torsoLengthM: base.spine.torsoLengthM * k },
      } as Blueprint);
      return buildSkeleton(bp).support.chainStress.spine;
    };
    const half = at(0.5);
    const one = at(1);
    const twice = at(2);
    expect(half).toBeGreaterThan(0);
    // Loose band — this is a proxy model and the pose re-solves at each size.
    expect(one / half).toBeGreaterThan(1.6);
    expect(one / half).toBeLessThan(2.5);
    expect(twice / one).toBeGreaterThan(1.6);
    expect(twice / one).toBeLessThan(2.5);
  });
});

// ── The two defects the ledger exists to see ─────────────────────────────

describe("the ledger sees the defects posture cannot", () => {
  it("REFUSES the handstand: a pitched trunk keeps every support leg down", () => {
    // 🚨 THIS PIN IS FLIPPED (phase 3). It used to assert the BUG: pitch the
    // dog nose-down, the hind hips rise past the hind legs' reach, the hind
    // legs plant nothing and the two forelegs take the whole body — hind
    // `force: 0`, hind `foot: undefined`, foreleg stress 0.56 → 0.90, tipping
    // 0 → 0.196 m. Posture now NEGOTIATES with the ledger: the commanded
    // pitch is a desire, and the body may not stand where a support leg
    // cannot reach the ground, so the trunk pitches about the rear feet and
    // the FORELEGS fold instead. The play bow, not the handstand.
    const base = speciesBlueprint("dog");
    const level = buildSkeleton(base).support;
    const pitched = buildSkeleton(clampBlueprint({
      ...base,
      posture: { ...base.posture, bodyPitch: -1.05 },
    } as Blueprint)).support;

    expect(level.legs.filter((l) => l.grounded)).toHaveLength(4);
    expect(level.body.tipping).toBeCloseTo(0, 6);

    // All four, still planted, still carrying — where the old pin counted the
    // ones that had dropped out.
    const supportLegs = pitched.legs.filter((l) => l.role === "support");
    expect(supportLegs).toHaveLength(4);
    for (const leg of supportLegs) {
      expect(leg.grounded).toBe(true);
      expect(leg.bearing).toBe("ground");
      expect(leg.foot).toBeDefined();
      expect(leg.force).toBeGreaterThan(0);
    }
    expect(sum(supportLegs.map((l) => l.force))).toBeCloseTo(pitched.body.weight, 9);
    // Nothing overhangs its own support any more: the CoM is back inside the
    // feet, so there is no residual moment for the ground to fail to balance.
    expect(pitched.body.tipping).toBeCloseTo(0, 6);
    expect(pitched.body.supportMargin).toBeGreaterThan(0);
    // 🚨 THE BOW IS CHEAP IN FORCE AND EXPENSIVE IN POSTURE, and separating
    // those two is exactly what EMA bought. Four legs still share the load, so
    // the hardest-working leg's FORCE is within 2% of standing level — which is
    // all the pre-EMA ledger could see, and why it called the bow free.
    const maxOf = (legs: readonly LegSupport[], f: (l: LegSupport) => number): number =>
      Math.max(...legs.map(f));
    const levelSupport = level.legs.filter((l) => l.role === "support");
    expect(maxOf(supportLegs, (l) => l.force))
      .toBeCloseTo(maxOf(levelSupport, (l) => l.force), 2);
    // But bowing FOLDS the front knees, and a folded knee moves the ground
    // reaction off the joint's axis: the muscles take the moment and the bone
    // takes their force. So the posture multiplier rises (2.09 → 2.72) and the
    // hardest-working leg goes from 0.92 to 1.39 — a real 50% cost that the
    // force sum alone cannot see. This is the whole point of the EMA term.
    expect(maxOf(supportLegs, (l) => l.ema)).toBeGreaterThan(maxOf(levelSupport, (l) => l.ema));
    expect(maxOf(supportLegs, (l) => l.stress))
      .toBeGreaterThan(maxOf(levelSupport, (l) => l.stress) * 1.2);
  });

  it("bows by FOLDING the forelegs and EXTENDING the hind ones", () => {
    // The shape of the fix, measured rather than described. What the clamp
    // actually enforces is CONTACT — every support foot stays down — and the
    // play bow is what falls out of it: the ceiling on the body's lift is the
    // first hip to run out of leg, so a nose-down pitch walks the hind legs
    // out toward straight while the front hips drop into a fold. Chest down
    // on folded forelegs, rump up on straightened hind legs, which is the
    // posture a dog actually takes.
    //
    // ⚖️ NOT a rigid pivot about the rear hips: they rise ~0.17 m as their
    // legs straighten. Pinning them exactly would mean clamping the lift to
    // the hind leg's REST extension rather than its reach limit, and that
    // ceiling binds on shipped rest poses — it would move bodies that are
    // standing perfectly well today.
    const base = speciesBlueprint("dog");
    const at = (skel: CreatureSkeleton, chain: string) => {
      const chainBones = skel.bones.filter((b) => b.chain === chain);
      if (chainBones.length === 0) throw new Error(`no ${chain}`);
      const hip = chainBones[0].head;
      const foot = chainBones[chainBones.length - 1].tail;
      return { hipY: hip.y, span: Math.hypot(foot.x - hip.x, foot.y - hip.y, foot.z - hip.z) };
    };
    const level = buildSkeleton(base);
    const bowed = buildSkeleton({ ...base, posture: { ...base.posture, bodyPitch: -0.4 } });
    // limb0 = the front pair (station 0.14), limb1 = the hind pair (0.61).
    const front = { level: at(level, "limb0R"), bowed: at(bowed, "limb0R") };
    const hind = { level: at(level, "limb1R"), bowed: at(bowed, "limb1R") };

    // 🚨 EVERY THRESHOLD HERE IS A FRACTION OF THE BODY, NOT A NUMBER OF
    // METRES. Both of these were `> 0.1` — absolute metres, fitted to a dog
    // whose torso was 1.7 m. The re-proportioning made the same animal a real
    // 30 kg labrador at 0.55 m, and the identical bow now moves the identical
    // fraction of a body one third the size: chest down 0.063 m = 0.114 × the
    // torso, foreleg folded 0.062 m = 0.227 × its own level span. An absolute
    // pin here was measuring the dog's SIZE and calling it a posture.
    const L = base.spine.torsoLengthM;
    expect(front.level.hipY - front.bowed.hipY).toBeGreaterThan(0.08 * L); // chest comes down
    expect(front.level.span - front.bowed.span) // foreleg folds
      .toBeGreaterThan(0.15 * front.level.span);
    expect(hind.bowed.span).toBeGreaterThan(hind.level.span); // hind leg straightens
    // …toward, but never past, what the leg can actually span (femur + tibia,
    // plus the sole out to the ball the chain's last bone ends on).
    const hindGroup = base.limbGroups[1];
    const hindLen = hindGroup.lengthFrac * base.spine.torsoLengthM;
    expect(hind.bowed.span).toBeLessThan(hindLen * (1 + hindGroup.footLengthFrac));
    expect(bowed.support.legs.every((l) => l.role !== "support" || l.grounded)).toBe(true);
  });

  it("stands the `cute` proportions up — that float was the handstand again", () => {
    // 🚨 THIS PIN IS FLIPPED TOO, and it turned out to be mislabelled. THE
    // `cute` MOD'S SIGNATURE (girth ×2.25, legs ×0.85), reproduced directly on
    // the blueprint so the test does not depend on the mod library, was filed
    // as a BELLY float — the fat belly becomes the floor and the legs dangle.
    // It never was: `bellyRest` read FALSE the whole time. What actually
    // happened is the handstand's own mechanism with no pitch involved — the
    // hind pair's straight-leg reach set the stand height, the FRONT hips
    // ended up above what their shortened legs could span, the forelegs went
    // `unreachable`, and the body balanced on its hind pair with tipping
    // 0.37 m and its spine stress at 0.95. The same contact clamp fixes it:
    // the body stands lower, all four reach, and the load halves.
    const base = speciesBlueprint("dog");
    const round = clampBlueprint({
      ...base,
      spine: { ...base.spine, girth: base.spine.girth * 2.25 },
      limbGroups: base.limbGroups.map((g) => ({ ...g, lengthFrac: g.lengthFrac * 0.85 })),
    } as Blueprint);
    const s = buildSkeleton(round).support;
    expect(s.body.bellyRest).toBe(false);
    for (const leg of s.legs.filter((l) => l.role === "support")) {
      expect(leg.foot).toBeDefined();
      expect(leg.grounded).toBe(true);
      expect(leg.force).toBeGreaterThan(0);
    }
    expect(s.body.tipping).toBeCloseTo(0, 6);
    // 🚨 THE OLD PIN HERE WAS WRONG, AND REAL PHYSICS EXPOSED IT. It asserted
    // that the rounder, shorter-legged body reads MORE stressed. It does not,
    // and the reason is a fact about the blueprint parameterisation rather than
    // about the body: a limb's `radiusFrac` is a fraction of the TORSO radius,
    // so the girth dial that tripled this body's mass (0.278 → 0.923) also
    // thickened every leg with it, and cross-section grew about as fast as
    // weight did. Shortening the legs then made them MORE columnar (max ema
    // 2.09 → 1.57), and the mean stress actually FALLS, 0.76 → 0.64.
    //
    // So what is pinned is what is true: the body got heavier, every foot
    // carries much more force, and it is still standing — while the per-leg
    // stress went down, because you cannot fatten this body without also
    // fattening its legs. A future re-proportioning that decouples limb radius
    // from torso girth should flip this back, and this comment is the warning
    // that the flip would be a real change and not a regression.
    const baseSup = buildSkeleton(base).support;
    expect(s.body.mass).toBeGreaterThan(baseSup.body.mass);
    const maxForce = (d: typeof s): number =>
      Math.max(...d.legs.filter((l) => l.grounded).map((l) => l.force));
    expect(maxForce(s)).toBeGreaterThan(maxForce(baseSup) * 2);
    expect(s.chainStress.spine).toBeLessThan(baseSup.chainStress.spine);
    // ⚖️ THE GENUINE CUTE FLOAT — a belly actually on the ground with legs too
    // short to reach it — is untouched and still phase 4's: see
    // creature-posture.test.ts, "labels every leg belly-rest".
  });
});

// ── Phase-1 pins: the ledger must not touch the pose ──────────────────────

describe("the ledger is diagnostics ONLY", () => {
  const deep = (skel: CreatureSkeleton) =>
    skel.bones.map((b) => [b.id, b.head.x, b.head.y, b.head.z, b.tail.x, b.tail.y, b.tail.z]);

  it.each(SPECIES)("%s poses identically with and without the phys param", (id) => {
    const bp = speciesBlueprint(id);
    expect(deep(buildSkeleton(bp, undefined, undefined, undefined, { gravity: 3.7 })))
      .toEqual(deep(buildSkeleton(bp)));
  });

  it.each(SPECIES)("%s doubles every force under double gravity and moves NO bone", (id) => {
    const bp = speciesBlueprint(id);
    const earth = buildSkeleton(bp);
    const heavy = buildSkeleton(bp, undefined, undefined, undefined, { gravity: 2 });
    expect(deep(heavy)).toEqual(deep(earth));
    expect(heavy.support.body.gravity).toBe(2);
    expect(heavy.support.body.weight).toBeCloseTo(earth.support.body.weight * 2, 9);
    expect(heavy.support.body.mass).toBeCloseTo(earth.support.body.mass, 12);
    for (let i = 0; i < earth.support.legs.length; i++) {
      expect(heavy.support.legs[i].force).toBeCloseTo(earth.support.legs[i].force * 2, 9);
      expect(heavy.support.legs[i].strength).toBeCloseTo(earth.support.legs[i].strength, 12);
      expect(heavy.support.legs[i].stress).toBeCloseTo(earth.support.legs[i].stress * 2, 9);
    }
    expect(heavy.support.chainStress.spine).toBeCloseTo(earth.support.chainStress.spine * 2, 9);
    // Geometry-only readings are untouched by gravity.
    expect(heavy.support.body.supportMargin).toBeCloseTo(earth.support.body.supportMargin, 12);
    expect(heavy.support.body.tipping).toBeCloseTo(earth.support.body.tipping, 12);
  });
});

// ── The real-physics calibration ─────────────────────────────────────────
// 🚨 THESE TESTS CHECK THE CONSTANTS AGAINST AN ANATOMY TABLE, NOT AGAINST THE
// REGISTRY. Every number below traces to Campione & Evans (2012), to Biewener's
// EMA / safety-factor work, or to a stated anatomical measurement — the sources
// in planning-docs/games/world-engine/creature-physics.md. Nothing here may be
// "fixed" by changing a constant to suit a shipped body; if a shipped body
// disagrees with these, the body is what is wrong.

/** The notes' own table: mass (kg) → summed humerus+femur minimum shaft
 *  circumference (mm), as printed there. The line is checked against this. */
const NOTES_TABLE: readonly (readonly [string, number, number])[] = [
  ["shrew", 0.002, 3.2], ["mouse", 0.02, 7.5], ["rat", 0.3, 20],
  ["cat", 4.5, 54], ["labrador", 30, 107], ["human", 70, 146],
  ["horse", 500, 298], ["hippo", 2000, 494], ["elephant", 6000, 737],
  ["paraceratherium", 17000, 1076],
];

/** Biewener's posture trend across that table — crouched when small, columnar
 *  when large — as the knee's horizontal offset over leg length. Stated here so
 *  it is visible as an INPUT to the model rather than an output of it. */
const CROUCH: Record<string, number> = {
  shrew: 0.30, mouse: 0.28, rat: 0.24, cat: 0.18, labrador: 0.13,
  human: 0.12, horse: 0.09, hippo: 0.07, elephant: 0.055, paraceratherium: 0.05,
};

/** A SYNTHETIC line animal: real mass, the limb thickness the line prescribes
 *  for it, isometric leg length (the notes: lengths are isometric, thicknesses
 *  are not), and a posture. No registry body is involved. */
function lineAnimal(kg: number, crouch: number): { sigma: number; ema: number; bind: string } {
  const radius = campioneLimbRadiusM(kg);
  const legLen = 0.4 * Math.cbrt(kg / 30); // 30 kg ⇒ a 0.40 m leg
  const ema = emaMultiplier({
    kneeArm: crouch * legLen, limbRadius: radius,
    hipArm: 0.05 * legLen, hipSpan: 0.5 * legLen,
  });
  const cap = legCapacity(radius, legLen);
  return { sigma: (proxyMassOf(kg) / 4) * ema / cap.strength, ema, bind: cap.bind };
}

/** The line's own quantity — one proximal bone's diameter, mm. */
const lineBoneDiameterMm = (kg: number): number => (campioneLimbRadiusM(kg) / K_BONE) * 2000;

describe("real units — the proxy is π-dropped cubic metres and nothing else", () => {
  it("converts proxy mass to kilograms as π · proxy · ρ", () => {
    expect(massKg(1)).toBeCloseTo(Math.PI * 1000, 6);
    expect(massKg(0.278)).toBeCloseTo(Math.PI * 278, 6);
    // A sphere 1 m across is π/6 m³ of tissue ⇒ 523.6 kg.
    expect(massKg(1 / 6)).toBeCloseTo((Math.PI / 6) * 1000, 6);
  });

  it("round-trips kilograms through the proxy, at any density", () => {
    for (const kg of [0.002, 30, 6000]) {
      for (const d of [0.6, 1, 1.3]) {
        expect(massKg(proxyMassOf(kg, d), d)).toBeCloseTo(kg, 6);
      }
    }
  });

  it("makes DENSITY a mass-only dial — a bird weighs less and is no stronger", () => {
    // A pneumatised body (a modern bird ≈ 0.65) has 65% of the mass of the same
    // shape in solid tissue and exactly the same legs. That it then needs less
    // leg is the WHOLE effect, and it falls out of weighing less.
    const bones = [bone([0, 0, 0], [1, 0, 0], 0.1, 0.1)];
    expect(massProperties(bones, 0.65).mass).toBeCloseTo(massProperties(bones).mass * 0.65, 12);
    // The CoM does not move: density is uniform, so it divides back out.
    expect(massProperties(bones, 0.65).com).toEqual(massProperties(bones).com);
  });

  it("one proxy force unit is π · ρ · g newtons", () => {
    expect(PROXY_FORCE_N).toBeCloseTo(30819, 0);
  });
});

describe("the Campione & Evans line", () => {
  it.each(NOTES_TABLE)("reproduces the notes' own table row: %s", (_n, kg, cMm) => {
    // log₁₀(M_g) = 2.749·log₁₀(C) − 1.104. The notes print C to 2–3 significant
    // figures, so agreeing to 2% is agreeing to the last digit they show — the
    // shrew's "3.2 mm" is only two figures, and half a unit in the last place
    // there is already 1.5%.
    expect(Math.abs(campioneCircumferenceMm(kg) / cMm - 1)).toBeLessThan(0.02);
  });

  it("inverts", () => {
    for (const [, kg] of NOTES_TABLE) {
      expect(campioneMassKg(campioneCircumferenceMm(kg))).toBeCloseTo(kg, 6);
    }
  });

  it("puts the human row on a real human femur — the notes' sanity check", () => {
    // Predicted ~146 mm summed, against a measured ~147 (femur 85 + humerus 62).
    expect(campioneCircumferenceMm(70)).toBeGreaterThan(140);
    expect(campioneCircumferenceMm(70)).toBeLessThan(152);
  });

  it("gives C ∝ M^0.364 — thickness is allometric, and that is NOT isometry", () => {
    const perDecade = campioneCircumferenceMm(1000) / campioneCircumferenceMm(100);
    expect(Math.log10(perDecade)).toBeCloseTo(1 / 2.749, 9);
    expect(1 / 2.749).toBeGreaterThan(1 / 3); // geometric similarity would be 1/3
  });

  it("k_bone lands a line limb on a real animal's real thickness", () => {
    // A 30 kg dog: a 17 mm femur shaft inside a ~104 mm thigh. A 70 kg human:
    // a ~23 mm bone inside a ~142 mm limb. Both are the real animals.
    expect(lineBoneDiameterMm(30)).toBeCloseTo(17.1, 1);
    expect(campioneLimbRadiusM(30) * 2000).toBeCloseTo(104, 0);
    expect(campioneLimbRadiusM(70) * 2000).toBeCloseTo(142, 0);
  });
});

describe("the crushing constant is anchored, not tuned", () => {
  it("puts the REFERENCE animal at exactly 1/safety-factor", () => {
    // The whole derivation in one line: a 30 kg quadruped, on the line, at its
    // real scale, in a real quadruped's posture (EMA_REF), reads 1/2.75.
    const sigma = (proxyMassOf(30) / 4) * EMA_REF / legStrength(campioneLimbRadiusM(30));
    expect(sigma).toBeCloseTo(1 / SAFETY_FACTOR, 9);
    expect(sigma).toBeCloseTo(0.364, 3);
  });

  it("means something checkable in real units at σ = 1", () => {
    // ≈1.77 MPa of static bone stress — a CONFORMANCE threshold, ~1% of
    // cortical bone's ~200 MPa failure strength. The gap is the dynamic factor:
    // peak locomotor stress is 40–80 MPa, and Biewener's 2–4 safety factor
    // lives up THERE, not in a standing animal.
    expect(boneStressPa(1) / 1e6).toBeCloseTo(1.77, 2);
    expect(boneStressPa(1)).toBeLessThan(0.02 * 200e6);
    expect(boneStressPa(2)).toBeCloseTo(2 * boneStressPa(1), 6);
  });

  it("is what the shipped MUSCLE_STRENGTH is, to the digit", () => {
    expect(MUSCLE_STRENGTH).toBeCloseTo(1.543, 3);
    // The old hand-fitted 1.4 was within 10% of it. Worth naming as a
    // coincidence — and no longer the reason for the number.
    expect(Math.abs(MUSCLE_STRENGTH / 1.4 - 1)).toBeLessThan(0.12);
  });
});

describe("the line at real scale — every real animal, and where it lands", () => {
  const rows = NOTES_TABLE.map(([n, kg]) => ({ n, kg, ...lineAnimal(kg, CROUCH[n]) }));

  it("orders by mass — a bigger animal on the line is always nearer its limit", () => {
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].sigma).toBeGreaterThan(rows[i - 1].sigma);
    }
  });

  it("keeps everything up to the elephant inside the band", () => {
    for (const r of rows) {
      if (r.kg > 10000) continue; // Paraceratherium — see below
      expect(r.sigma).toBeLessThan(1.5);
      expect(r.sigma).toBeGreaterThan(0.05);
      expect(r.bind).toBe("crush"); // a real animal's limb is never spindly
    }
    // The middle of the range — rat to horse — sits squarely in the band.
    for (const r of rows.filter((x) => x.kg >= 0.3 && x.kg <= 500)) {
      expect(r.sigma).toBeGreaterThan(0.25);
      expect(r.sigma).toBeLessThan(1.0);
    }
  });

  it("puts the largest land mammal that ever lived AT the limit — which is why there is none bigger", () => {
    const p = rows[rows.length - 1];
    expect(p.n).toBe("paraceratherium");
    expect(p.sigma).toBeGreaterThan(1);
    expect(p.sigma).toBeLessThan(2);
  });

  it("agrees with a COMPLETELY INDEPENDENT anchor to within 10%", () => {
    // Re-derive from an unrelated premise: instead of "a 30 kg quadruped keeps a
    // 2.75× margin", require "the biggest land mammal that ever existed sits
    // exactly at σ = 1". The labrador then reads 0.336 where the shipped anchor
    // puts it at 0.364. Two unrelated calibrations landing 8% apart is the
    // strongest evidence available that the anchor is not arbitrary.
    const paracer = rows[rows.length - 1].sigma;
    const labradorAlt = rows.find((r) => r.n === "labrador")!.sigma / paracer;
    expect(labradorAlt).toBeCloseTo(0.336, 2);
    expect(Math.abs(labradorAlt / (1 / SAFETY_FACTOR) - 1)).toBeLessThan(0.1);
  });
});

describe("EMA — what posture costs", () => {
  it("charges a COLUMNAR limb exactly nothing", () => {
    // Foot straight under the hip, knee straight: the bone is a pillar, it
    // carries the weight and not one newton more. This is the definition the
    // whole multiplier is measured from.
    expect(emaMultiplier({ kneeArm: 0, limbRadius: 0.05, hipArm: 0, hipSpan: 0.3 })).toBe(1);
  });

  it("rises with the knee's moment arm and falls with the limb's thickness", () => {
    const at = (kneeArm: number, r: number): number =>
      emaMultiplier({ kneeArm, limbRadius: r, hipArm: 0, hipSpan: 1 });
    expect(at(0.10, 0.05)).toBeGreaterThan(at(0.05, 0.05));
    expect(at(0.10, 0.10)).toBeLessThan(at(0.10, 0.05));
    // 🚨 A THIN LIMB IS PENALISED TWICE, and that is the physics, not a bug: it
    // has a small cross-section AND a short muscle lever, so σ ∝ 1/r³ off-axis
    // where it is only 1/r² straight down. It is why a spindly leg is so much
    // worse than its area alone says.
    expect(at(0.1, 0.025) - 1).toBeCloseTo(2 * (at(0.1, 0.05) - 1), 9);
  });

  it("reads R/r at the muscle's own lever", () => {
    // 1 + R/(κ·r), with κ the tendon's wrap fraction.
    expect(emaMultiplier({ kneeArm: 0.09, limbRadius: 0.05, hipArm: 0, hipSpan: 1 }))
      .toBeCloseTo(1 + 0.09 / (MUSCLE_MOMENT_FRAC * 0.05), 9);
  });

  it("catches a STRAIGHT-LEGGED sprawler at the hip, which the knee cannot see", () => {
    // A limb planted far outside its hip but held straight has no knee arm at
    // all. The hip term is what makes it expensive — and it works across the
    // TRUNK, so it takes a real sprawl to bind rather than any bent knee.
    const sprawled = emaMultiplier({ kneeArm: 0, limbRadius: 0.05, hipArm: 0.9, hipSpan: 0.3 });
    expect(sprawled).toBeGreaterThan(5);
    expect(sprawled).toBeCloseTo(1 + 0.9 / (MUSCLE_MOMENT_FRAC * 0.3), 9);
  });

  it("agrees with an INDEPENDENT cantilever treatment of the same load", () => {
    // 🚨 CROSS-VALIDATION, not a restatement. Route (a): the EMA muscle model —
    // compression, multiplied. Route (b): treat the same off-axis ground force
    // as pure BENDING about the limb, moment F·R against a section modulus ∝ r³
    // (`cantileverStress`, which knows nothing about EMA). The two share no
    // constant. They agree exactly in SCALING — both ∝ F·R/r³ — and within
    // ~40% in magnitude, so the multiplier is not an artifact of choosing the
    // muscle picture.
    for (const [r, R, F] of [[0.002, 0.02, 5e-4], [2e-4, 7e-3, 1e-6]] as const) {
      const viaEma = (F * emaMultiplier({ kneeArm: R, limbRadius: r, hipArm: 0, hipSpan: 1 }))
        / legStrength(r);
      const viaBending = cantileverStress(F, R, r);
      expect(viaEma / viaBending).toBeGreaterThan(1);
      expect(viaEma / viaBending).toBeLessThan(2);
    }
    // The closed form of that ratio in the R ≫ κr limit, from the constants.
    expect(BEND_STRENGTH / (MUSCLE_MOMENT_FRAC * Math.PI * MUSCLE_STRENGTH))
      .toBeCloseTo(1.375, 2);
  });
});

describe("EMA closes part of the allometric residual — the emergent-exponent check", () => {
  const exponent = (a: readonly [number, number], b: readonly [number, number]): number =>
    Math.log(b[1] / a[1]) / Math.log(b[0] / a[0]);

  it("leaves σ ∝ M^0.272 when POSTURE IS FROZEN — the notes' un-closed law", () => {
    // Thickness on the 0.364 line and nothing else: cross-section goes as
    // M^0.728, so stress still climbs as M^0.272. This is the notes' own
    // "the rule doesn't close on its own", reproduced exactly.
    const frozen = NOTES_TABLE.map(([, kg]) =>
      [kg, (proxyMassOf(kg) / 4) * EMA_REF / legStrength(campioneLimbRadiusM(kg))] as const);
    expect(exponent(frozen[0], frozen[frozen.length - 1])).toBeCloseTo(0.272, 3);
  });

  it("flattens to ~0.18 once posture straightens with size — a THIRD of the way", () => {
    // 🚨 THE HONEST RESULT, AND IT IS NOT THE NOTES' NUMBER. Biewener's EMA ∝
    // W^0.25 would close 0.272 → 0.02. Measuring posture geometrically instead
    // of regressing it, we close 0.272 → 0.177.
    //
    // The notes over-claim, and the notes' own source shows why: W^0.25 across
    // the table's eight orders of magnitude demands an EMA range of 8.5e6^0.25
    // ≈ 54×, while Biewener's MEASURED limb EMA spans only ~4× from a mouse to
    // a horse (0.2 → 0.8) — an exponent of ~0.137 over that range, not 0.25. A
    // residual is therefore real, and it is the reason the top of the table
    // sits at its limit while the bottom has room to spare.
    const real = NOTES_TABLE.map(([n, kg]) => [kg, lineAnimal(kg, CROUCH[n]).sigma] as const);
    const closed = exponent(real[0], real[real.length - 1]);
    expect(closed).toBeCloseTo(0.177, 2);
    expect(closed).toBeLessThan(0.272);   // posture really does close some of it
    expect(closed).toBeGreaterThan(0.02); // but not all of it, and not close
  });

  it("makes a CROUCHED body cost more than an UPRIGHT one at every scale", () => {
    // Scale one body geometrically (isometric — thickness and length together)
    // and hold each posture fixed. Both then climb as σ ∝ L, because EMA is
    // scale-invariant under geometric scaling — but the crouched body starts
    // ~3.8× higher and so the ABSOLUTE gap widens with every doubling, and it
    // crosses σ = 1 several sizes earlier. That is the notes' constraint in its
    // real form: a sprawler may be small, or thick-limbed, or neither.
    const at = (crouch: number, scale: number): number => {
      const kg = 30 * scale ** 3;
      const r = 0.052 * scale, legLen = 0.4 * scale;
      const ema = emaMultiplier({
        kneeArm: crouch * legLen, limbRadius: r, hipArm: 0.05 * legLen, hipSpan: 0.5 * legLen,
      });
      return (proxyMassOf(kg) / 4) * ema / legCapacity(r, legLen).strength;
    };
    let prevGap = 0;
    for (const scale of [1, 2, 4, 8]) {
      const upright = at(0.05, scale);
      const crouched = at(0.35, scale);
      expect(crouched).toBeGreaterThan(upright);
      expect(crouched - upright).toBeGreaterThan(prevGap); // the gap widens
      prevGap = crouched - upright;
    }
    // The upright body is viable at a size where the crouched one is not.
    expect(at(0.05, 2)).toBeLessThan(1);
    expect(at(0.35, 2)).toBeGreaterThan(1);
  });
});

describe("Euler buckling — the other way a leg fails", () => {
  it("scales as r⁴/L², which crushing does not", () => {
    expect(buckleCapacity(0.02, 1) / buckleCapacity(0.01, 1)).toBeCloseTo(16, 6);
    expect(buckleCapacity(0.01, 2) / buckleCapacity(0.01, 1)).toBeCloseTo(0.25, 6);
    // whereas crushing is r², length-blind
    expect(legStrength(0.02) / legStrength(0.01)).toBeCloseTo(4, 6);
  });

  it("reproduces the notes' safe-length ∝ D^(2/3) boundary", () => {
    // Greenhill's self-buckling length for this same composite column:
    // L_cr = (7.8373·EI/(ρAg))^⅓. The EXPONENT is what the notes state, and it
    // falls out of Euler by construction rather than being matched to it.
    const selfBucklingLen = (D: number): number => {
      const r = D / 2;
      const I = (Math.PI * (r / K_BONE) ** 4) / 4;
      return Math.cbrt((7.8373 * 17e9 * I) / (1000 * Math.PI * r * r * 9.81));
    };
    const coeff = [0.01, 0.1, 1].map((D) => selfBucklingLen(D) / D ** (2 / 3));
    for (const c of coeff) expect(c).toBeCloseTo(coeff[0], 9); // pure D^(2/3)
    expect(coeff[0]).toBeCloseTo(8.5, 1);
    // Solid bone would be 95·D^(2/3); the ratio is exactly the flesh dilution.
    const dilution = (0.792 * Math.cbrt(17e9 / (1000 * 9.81))) / coeff[0];
    expect(Math.abs(dilution / K_BONE ** (4 / 3) - 1)).toBeLessThan(0.01);
  });

  it("binds below r:L ≈ 0.04 and hands over to crushing above it", () => {
    const crossover = Math.sqrt(legStrength(1) / BUCKLE_STRENGTH);
    expect(crossover).toBeCloseTo(0.0396, 3);
    // A stout limb crushes; a spindly one buckles, and by a wide margin.
    expect(legCapacity(0.05, 0.5).bind).toBe("crush");   // r:L = 0.10
    expect(legCapacity(0.005, 0.5).bind).toBe("buckle"); // r:L = 0.01
    expect(legCapacity(0.005, 0.5).strength).toBeLessThan(legStrength(0.005));
  });

  it("takes the MINIMUM, and reports which one it was", () => {
    const stout = legCapacity(0.05, 0.5);
    expect(stout.strength).toBe(Math.min(stout.crush, stout.buckle));
    const spindly = legCapacity(0.005, 0.5);
    expect(spindly.strength).toBe(Math.min(spindly.crush, spindly.buckle));
    expect(spindly.strength).toBe(spindly.buckle);
  });

  it("falls back to crushing alone when no built length is known", () => {
    // A capacity estimate made before a pose exists can honestly ask only the
    // crushing question, and says so rather than inventing a length.
    expect(legCapacity(0.005).bind).toBe("crush");
    expect(legCapacity(0.005).strength).toBe(legStrength(0.005));
    expect(legCapacity(0.005).buckle).toBe(Infinity);
  });
});

describe("the arthropods — the exoskeleton seam, and the mantis miss it closed", () => {
  /** The same shipped mantis blueprint at two torso lengths. Nothing but the
   *  one size dial changes; the limb proportions are the registry's. */
  const mantisAt = (torsoLengthM: number) => {
    const base = speciesBlueprint("mantis");
    const skel = buildSkeleton(clampBlueprint({
      ...base, spine: { ...base.spine, torsoLengthM },
    } as Blueprint));
    const support = skel.support.legs.filter((l) => l.role === "support" && l.grounded);
    return {
      kg: massKg(skel.support.body.mass),
      worst: support.reduce((a, b) => (b.stress > a.stress ? b : a)),
    };
  };

  it("reads the metre-long mantis as IMPOSSIBLE — and now it CRUSHES, not buckles", () => {
    // 🚨 THE MODEL IS STILL WORKING, AND THE BIND SWAPPED. Held at a 1 m torso
    // the mantis is an 18.8 kg animal on legs 7.4 mm across, and it reads
    // σ ≈ 6.5 — six and a half times capacity, eighteen times a real animal's
    // resting read of 1/SAFETY_FACTOR. No insect is a metre long, and the
    // ledger still says so.
    //
    // WHAT MOVED IS *WHICH* FAILURE BINDS, from "buckle" to "crush", and that
    // is the exoskeleton seam and nothing else. Buckling carries k⁴ and
    // crushing k², so flipping k from the mammalian 6.1 to the arthropod 1.3
    // multiplies the buckling capacity by (6.1/1.3)⁴ ≈ 484 and the crushing
    // capacity by only ≈ 22. The crossover moves with it: a mammal's limb
    // buckles below r:L ≈ 0.040, an arthropod's only below ≈ 0.0086. This limb
    // sits between the two, so a tube carrying its own outside no longer folds
    // — it is simply asked to bear more than its cross-section can. If this
    // ever reads "buckle" again, either `spine.skeleton` stopped reaching
    // `legCapacity` or the k⁴ term was dropped.
    //
    // ⚖️ NOT "by orders of magnitude" any more, and the old title said it was.
    // 6.5 IS the honest number: `boneStressPa` reads it back as ~11.6 MPa of
    // static structural stress (that conversion is plan-independent — the k²
    // in the capacity and the k² in the area cancel), against a sclerotised
    // cuticle that yields near 80–100 MPa. Static, it does not shatter; but
    // peak locomotor stress runs tens of times the standing value, which is
    // where Biewener's safety factor lives, and this body has already spent
    // 6.5× of it standing still.
    const m = mantisAt(1);
    expect(m.kg).toBeGreaterThan(10);
    expect(m.worst.bind).toBe("crush");
    expect(m.worst.stress).toBeGreaterThan(5);
    expect(m.worst.stress).toBeLessThan(10);
    expect(m.worst.stress).toBeGreaterThan(1); // over capacity — the claim
    expect(boneStressPa(m.worst.stress)).toBeGreaterThan(5e6);
  });

  it("stands the REAL 7 cm mantis up — the miss this round exists to close", () => {
    // 🚨 THIS PIN IS FLIPPED. It used to assert `> 1` and was titled "…but NOT
    // yet trivially safe": the same body at 7 cm read ~40 000, and the test
    // recorded the miss instead of hiding it. It named the two causes and said
    // neither belonged in a constant:
    //
    //  1. THE BLUEPRINT'S LEGS WERE TOO THIN EVEN FOR AN INSECT — 0.079 of
    //     what the Campione line gives an animal of that mass.
    //  2. K_BONE = 6.1 IS A MAMMAL NUMBER. An arthropod wears its skeleton
    //     outside, so nearly the whole capsule is structural.
    //
    // Both landed. (1) is the re-proportioning: the mantis now ships a 7 cm
    // torso as its real size, with limbs on the line. (2) is `SkeletonPlan` —
    // the mantis carries `spine.skeleton: "exo"`, so `boneFraction` hands
    // `legCapacity` k = 1.3 instead of 6.1.
    //
    // A real 7 cm mantis weighs 6.4 g and reads σ ≈ 0.46: VIABLE, inside its
    // margin, and in the same neighbourhood as the 1/SAFETY_FACTOR ≈ 0.36 a
    // line-conforming quadruped reads. It is not "trivially safe" in the sense
    // of vanishing — an insect is not built with a huge margin — but it is a
    // body that stands, which is what the miss was about.
    const small = mantisAt(0.07);
    expect(small.kg).toBeLessThan(0.01);
    expect(small.kg).toBeGreaterThan(0.001);
    expect(small.worst.stress).toBeLessThan(1); // THE FIX: under capacity
    expect(small.worst.stress).toBeGreaterThan(0.2);
    expect(small.worst.bind).toBe("crush");
    // …and still enormously better than the impossible one.
    expect(small.worst.stress).toBeLessThan(mantisAt(1).worst.stress);
  });

  it("holds its POSTURE across scales, so σ is pure square-cube", () => {
    // 🚨 THIS PIN IS REPLACED, AND WHAT REPLACES IT IS THE STRONGER STATEMENT.
    // It used to assert that the SMALL body crouches more (`small.ema >
    // big.ema × 2`, measured 88.1 against 17.6) and read that as Biewener's
    // size-dependent posture trend falling out of the pose pass for free.
    //
    // It no longer holds, and the reason is the re-proportioning rather than a
    // regression: the old mantis's legs were 0.079 of the line, so the pose
    // pass's load term — the leg's share of body weight against the leg's
    // ABSOLUTE strength — was large at 1 m and negligible at 7 cm, and the
    // small body sagged into its rest crouch while the large one was pushed
    // straight. With the limb ON the line at both sizes that sag never engages
    // at either, and the two bodies stand in the SAME pose: ema 14.52 at 1 m
    // and 14.52 at 7 cm, equal to the last digit the solver carries.
    //
    // What that buys is a cleaner law than the one it replaces. With posture
    // held constant, nothing is left in σ but geometry — mass ∝ L³ over leg
    // cross-section ∝ L² — so σ ∝ L exactly, and the ratio of the two stresses
    // must BE the ratio of the two lengths. It is: 14.279 against 14.286, four
    // parts in ten thousand. No code anywhere computes that; it falls out of
    // every length in the module being an absolute metre.
    //
    // ⚖️ NO "SMALL BODIES CROUCH MORE" CLAIM IS KEPT, because no body in the
    // registry still shows one. The pose pass can still produce it — it is the
    // same mechanism, and a body authored well off the line would show it
    // again — but asserting it here would mean inventing a body to assert it
    // on, and a pin with a fixture built to satisfy it is not a measurement.
    const big = mantisAt(1);
    const small = mantisAt(0.07);
    expect(small.worst.ema).toBeCloseTo(big.worst.ema, 6);
    const sigmaRatio = big.worst.stress / small.worst.stress;
    const lengthRatio = 1 / 0.07;
    expect(sigmaRatio / lengthRatio).toBeGreaterThan(0.98);
    expect(sigmaRatio / lengthRatio).toBeLessThan(1.02);
  });
});

// ── Falsifiability pins for the re-proportioning round ────────────────────
// Four claims the round makes that would be invisible if they were only true
// on paper. Each is written the same way: what would be TRUE IN THE WORLD if
// the assertion failed, then the assertion.

describe("the exoskeleton seam is what saves the arthropods", () => {
  it("swings the SAME spider ~86× on `spine.skeleton` alone", () => {
    // IF THIS FAILS: either `spine.skeleton` is no longer reaching
    // `legCapacity` (in which case every arthropod is silently being measured
    // as a mammal again, and the 7 cm mantis pin above is passing for the
    // wrong reason), or k has stopped entering buckling as k⁴ — the term that
    // makes a thin tube stiff.
    //
    // Nothing about the body changes here but one enum. Same 3 cm torso, same
    // 2.2 g, same eight legs, same 0.4 mm limbs, same pose, same ema (35.07 —
    // a spider is a sprawler and stays one).
    const spider = speciesBlueprint("spider");
    expect(spider.spine.skeleton).toBe("exo");
    const asEndo = clampBlueprint({
      ...spider, spine: { ...spider.spine, skeleton: "endo" },
    } as Blueprint);

    const worstOf = (bp: Blueprint) => {
      const skel = buildSkeleton(bp);
      const legs = skel.support.legs.filter((l) => l.role === "support" && l.grounded);
      expect(legs.length).toBe(8);
      return legs.reduce((a, b) => (b.stress > a.stress ? b : a));
    };
    const exo = worstOf(spider);
    const endo = worstOf(asEndo);

    // The real spider stands (σ ≈ 0.40); the same body wearing a mammal's
    // anatomy is impossible (σ ≈ 34.9) and fails the OTHER way — a 0.4 mm
    // flesh capsule around a 0.07 mm bone is a hair, and a hair folds.
    expect(exo.stress).toBeGreaterThan(0.2);
    expect(exo.stress).toBeLessThan(0.8);
    expect(exo.bind).toBe("crush");
    expect(endo.stress).toBeGreaterThan(20);
    expect(endo.bind).toBe("buckle");
    expect(endo.stress / exo.stress).toBeGreaterThan(50);
    expect(endo.stress / exo.stress).toBeLessThan(150);
    // The pose is untouched — this is a capacity seam, not a posture one.
    expect(exo.ema).toBeCloseTo(endo.ema, 6);
  });

  it("makes a body opt OUT of vertebrate anatomy, never into it by omission", () => {
    // IF THIS FAILS: an unmarked blueprint — every mammal in the registry, and
    // every body a game or the lab authors without thinking about skeletons —
    // is being measured with an insect's bone fraction, which is ~22× too much
    // crushing capacity and ~484× too much buckling capacity. The default has
    // to be the conservative one, and the conservative one is the mammal.
    expect(boneFraction(undefined)).toBe(K_BONE);
    expect(boneFraction("endo")).toBe(K_BONE);
    expect(boneFraction("exo")).toBe(K_BONE_EXO);
    expect(K_BONE_EXO).toBeLessThan(K_BONE);
    // And a blueprint that says nothing gets "endo" written onto it, so the
    // default is visible in the data rather than only in the reader.
    expect(speciesBlueprint("dog").spine.skeleton).toBe("endo");
  });
});

describe("the tyrannosaur — a seven-tonne biped at authored proportions", () => {
  const trex = () => buildSkeleton(speciesBlueprint("tyrannosaur"));

  it("stands on two legs whose arms never take a newton", () => {
    // IF THIS FAILS: either a 7 t theropod has stopped being buildable at
    // line-conforming limb thickness (the whole point of the body — it is the
    // registry's stress test for the upper end), or the famous tiny arms have
    // been recruited into support, which would be the handstand's own bug
    // wearing a dinosaur: a limb that cannot reach the ground quietly counted
    // as a leg.
    const s = trex().support;
    const support = s.legs.filter((l) => l.role === "support");
    expect(support).toHaveLength(2);
    for (const leg of support) {
      expect(leg.grounded).toBe(true);
      expect(leg.bearing).toBe("ground");
      expect(leg.force).toBeGreaterThan(0);
    }
    expect(sum(support.map((l) => l.force))).toBeCloseTo(s.body.weight, 9);

    // The arms: socketed high on the chest, 17% of the trunk long, and they
    // must be reported as MANIPULATORS carrying exactly zero.
    const fore = s.legs.filter((l) => l.chain.startsWith("limb0"));
    expect(fore).toHaveLength(2);
    for (const arm of fore) {
      expect(arm.role).toBe("manipulator");
      expect(arm.force).toBe(0);
    }

    // σ ≈ 1.88. Over 1 and REPORTED, not tuned away: a biped's leg carries W/2
    // where a quadruped's carries W/4, and (7000/30)^0.272 ≈ 4.4 of allometric
    // residual sits on top of that. The model saying T. rex was at the upper
    // size limit for a bipedal walker is the model agreeing with palaeontology.
    // Banded, not pinned — the body is still being tuned upstream.
    expect(s.chainStress.spine).toBeGreaterThan(1.4);
    expect(s.chainStress.spine).toBeLessThan(2.6);
    expect(massKg(s.body.mass)).toBeGreaterThan(5500);
    expect(massKg(s.body.mass)).toBeLessThan(8500);
  });

  it("records its TIPPING as a known measurement, not a balanced body", () => {
    // ⚠️ THIS IS THE ONE PLACE THE ROUND'S OWN NOTES AND THE LEDGER DISAGREE,
    // AND THE LEDGER IS RIGHT. The tail is authored as a counterweight and the
    // intent was tipping ≈ 0 — the skull balanced over the hips. It measures
    // ~0.52 m, and it CANNOT be authored away.
    //
    // WHY (diagnosed with the pose layer's owner, not fixed this round): the
    // pose layer balances the body over its feet using skeleton.ts's LEGACY
    // mass — torso + tail only, head, neck and limbs invisible — while
    // `support.body.com` is the true whole-body CoM this module computes over
    // every bone. On a quadruped the two sit close enough to hide the gap. On a
    // horizontal-trunked biped with a heavy skull cantilevered metres in front
    // of the hips they do not, and the lean cannot close it: leaning translates
    // the trunk, the hips ride on the trunk, the feet re-plant under the
    // shifted hips, and the CoM↔CoP gap is invariant under the shift. Adding
    // tail mass makes it WORSE, because a heavier tail drags the LEGACY point
    // backwards and the lean pushes the body further forward in answer.
    //
    // IF THIS FAILS UPWARD, the gap has widened. IF IT FAILS DOWNWARD — down
    // to a human's ~0.007 m — the pose layer has been moved onto the ledger's
    // CoM, which is the fix, and this pin should be rewritten as the balance
    // assertion it was always meant to be.
    const s = trex().support;
    expect(s.body.tipping).toBeGreaterThan(0.2);
    expect(s.body.tipping).toBeLessThan(1);
    expect(s.body.supportMargin).toBeCloseTo(-s.body.tipping, 9);
    // The scale of the discrepancy, stated relative to the body so it survives
    // a re-proportioning: ~0.2 of the trunk, against ~0.01 on the human, which
    // is the same two-footed support with a light head over its hips.
    const L = speciesBlueprint("tyrannosaur").spine.torsoLengthM;
    expect(s.body.tipping / L).toBeGreaterThan(0.05);
    const human = buildSkeleton(speciesBlueprint("human")).support;
    expect(human.body.tipping / speciesBlueprint("human").spine.torsoLengthM)
      .toBeLessThan(0.05);
  });

  it("gets much worse when its hind legs are thinned ×0.5 — crushing is r²", () => {
    // IF THIS FAILS: leg thickness has stopped being the dominant term in the
    // ledger, which would mean the whole Campione anchor is decorative. Halving
    // a radius quarters a cross-section, and crushing capacity is that
    // cross-section, so σ must rise by ≈ 4× and nothing else about the body
    // changes. Measured 1.88 → 8.83, a factor of 4.69 — the extra 17% is the
    // posture cost of standing the same body on legs that now sag further.
    const base = speciesBlueprint("tyrannosaur");
    const worstOf = (bp: Blueprint) => {
      const legs = buildSkeleton(bp).support.legs
        .filter((l) => l.role === "support" && l.grounded);
      expect(legs).toHaveLength(2);
      return legs.reduce((a, b) => (b.stress > a.stress ? b : a));
    };
    const thin = clampBlueprint({
      ...base,
      limbGroups: base.limbGroups.map((g, i) =>
        i === 1 ? { ...g, radiusFrac: g.radiusFrac * 0.5 } : g),
    } as Blueprint);
    expect(thin.limbGroups[1]!.radiusFrac).toBeCloseTo(base.limbGroups[1]!.radiusFrac / 2, 9);

    const before = worstOf(base);
    const after = worstOf(thin);
    expect(after.stress / before.stress).toBeGreaterThan(3.5);
    expect(after.stress / before.stress).toBeLessThan(6);
    expect(after.bind).toBe("crush"); // still crushing, still the r² law
    expect(after.stress).toBeGreaterThan(1); // and far past capacity
  });
});

describe("the sauropod — columnar is why twenty-five tonnes works", () => {
  const supportOf = (bp: Blueprint) => {
    const s = buildSkeleton(bp).support;
    const legs = s.legs.filter((l) => l.role === "support" && l.grounded);
    return { s, legs, worst: legs.reduce((a, b) => (b.stress > a.stress ? b : a)) };
  };

  it("carries 25 t on four columns, and the ema is the reason", () => {
    // IF THIS FAILS: a body that only exists because its limbs are pillars has
    // stopped standing on pillars. EMA is the half of the allometric law that
    // thickness cannot do (physio.ts): bone circumference rises as M^0.364, so
    // σ still climbs as M^0.272, and the only thing left to pay for it is
    // posture. This body is Biewener's endpoint — the limb straightened until
    // the ground reaction runs through the joints and the bone carries little
    // but the weight. Take that away and 25 t is not buildable at any thickness
    // the blueprint can express.
    const base = speciesBlueprint("sauropod");
    const { s, legs, worst } = supportOf(base);
    expect(legs).toHaveLength(4);
    expect(sum(legs.map((l) => l.force))).toBeCloseTo(s.body.weight, 9);
    expect(massKg(s.body.mass)).toBeGreaterThan(20000);
    expect(massKg(s.body.mass)).toBeLessThan(30000);

    // Columnar by the registry's own scale: the human stands at 2.2, the dog at
    // 1.8–2.2, the mantis at 14.5.
    //
    // ⚖️ RE-PRICED TWICE, AND BOTH TIMES BY THE LEDGER RATHER THAN BY THIS BODY.
    //
    // The knee-arch fix priced the HIND pair's real 33 cm knee bulge honestly
    // (1.99 → 2.29) and made it the worst leg; the FORE pair stayed 1.41 and
    // HIP-bound, the only limbs in the registry straight enough at the knee for
    // the hip to bind.
    //
    // 🚨 THE FOOT-FUNCTION ROUND RETIRED THE HACK THIS BODY WAS STANDING ON.
    // `footLengthFrac: 0.1` was never a fact about a sauropod — it was a
    // 25-tonne animal given a stub for a foot because a raised sole pushed at
    // its TIP and charged the knee the whole foot as a lever. The honest cure
    // is the one it always was: a sauropod stands on a broad fibro-fatty PAD,
    // so `padFrac: 1` runs the load straight down through it and the foot is
    // back to a believable 0.2 of the leg. MEASURED, at rest, gravity 1:
    //   • foot 0.1, no pad  → 25 843 kg, worst σ 2.251, worst ema 2.29 (knee)
    //   • foot 0.2, pad 1   → 25 877 kg, worst σ 2.145, worst ema 1.48 (hip)
    // A longer foot and a pad both ADD mass, and it still comes out ahead on
    // every number — which is what it means for a hack to have been paying for
    // something a real mechanism does better.
    //
    // What that changes here: the HIND pair's knee lever is largely gone
    // (2.29 → 1.87), so the worst leg is once again the fore pair, hip-bound.
    // The assertion below is therefore about the MAGNITUDE, and the identity of
    // the binding joint is recorded per pair rather than pinned globally.
    for (const leg of legs) {
      expect(leg.ema).toBeGreaterThanOrEqual(1);
      expect(leg.ema).toBeLessThan(2.4);
    }
    const fore = legs.filter((l) => l.chain.startsWith("limb0"));
    expect(fore).toHaveLength(2);
    for (const leg of fore) {
      expect(leg.ema).toBeLessThan(1.5);
      expect(leg.emaJoint).toBe("hip"); // still the columnar pair
    }
    // The foot is honest, and the pad is what pays for it.
    const grp = clampBlueprint(base).limbGroups[0]!;
    expect(grp.footLengthFrac).toBeGreaterThanOrEqual(0.2);
    expect(grp.padFrac).toBe(1);
    // Every leg is now columnar enough that the worst one is hip-bound.
    expect(worst.ema).toBeLessThan(1.5);
    expect(worst.emaJoint).toBe("hip");
    expect(s.chainStress.spine).toBeGreaterThan(1.6);
    expect(s.chainStress.spine).toBeLessThan(2.5);
    expect(s.body.tipping).toBeCloseTo(0, 5); // four feet, and it balances

    // ⚠️ THE NECK NUMBER IS RECORDED, NOT ASSERTED TIGHTLY. σ ≈ 3.94 on the
    // longest cantilever in the registry — but it is measured against
    // BEND_STRENGTH = 3, which physio.ts flags as the one constant still FITTED
    // rather than derived. Deriving it the way the crushing side was derived
    // gives ≈ 0.20, fifteen times stricter, and would re-decide every carry
    // refusal in `canBear` at the same time. So this is NOT on the anatomical
    // scale the leg numbers are on, and a band around 3.94 would be pinning a
    // number nobody has calibrated. All that is asserted is that it is finite,
    // positive, and the biggest cantilever on the body.
    expect(Number.isFinite(s.chainStress.neck)).toBe(true);
    expect(s.chainStress.neck).toBeGreaterThan(0);
    expect(BEND_STRENGTH).toBe(3); // the scale this was read against
  });

  it("reads WORSE the moment those knees are bent", () => {
    // IF THIS FAILS: the ema term has stopped charging for a crouch, and the
    // "columnar is why it works" claim above is a coincidence rather than a
    // mechanism. Nothing changes here but `restFlexion` — same mass, same limb
    // thickness, same foot, same four contacts — so every bit of the difference
    // is posture.
    //
    // ⚖️ ONLY THE KNEE ANGLE. Shortening the legs into a crouch was tried and
    // is NOT a fair dial in this parameterisation: a shorter limb is a lighter
    // limb, so the body loses mass at the same time it loses height and σ goes
    // DOWN (0.85× at legs ×0.7). The knee is the isolated variable.
    const base = speciesBlueprint("sauropod");
    const bent = clampBlueprint({
      ...base,
      limbGroups: base.limbGroups.map((g) => ({
        ...g,
        restFlexion: Math.sign(g.restFlexion || 1), // ±0.08 → ±1, the clamp's limit
        flexRange: 1,
      })),
    } as Blueprint);

    const straight = supportOf(base);
    const crouched = supportOf(bent);
    expect(crouched.legs).toHaveLength(4); // still standing, just badly
    const maxEma = (r: typeof straight) => Math.max(...r.legs.map((l) => l.ema));
    expect(maxEma(crouched)).toBeGreaterThan(maxEma(straight));
    // ⚠️ THE MARGIN IS NOW THIN, AND THAT IS A RECORDED FINDING, NOT A LOOSENED
    // PIN. This used to clear 1.05× because the STRAIGHT case was under-priced:
    // its hind knee bulge was thrown sideways and partly cancelled. Priced
    // honestly, straight already pays most of what the crouch costs, so the
    // ratio is 1.005. The law — bending the knee costs more — still holds and
    // is asserted; the MECHANISM assertion above (`maxEma`) is the load-bearing
    // one, because stress also moves with how the four contacts share the load.
    // If this ever inverts, the ema term has stopped charging for a crouch.
    expect(crouched.worst.stress).toBeGreaterThan(straight.worst.stress);
  });
});
