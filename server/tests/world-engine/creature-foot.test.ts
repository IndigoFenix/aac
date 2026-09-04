// THE FOOT AS A COLUMN (skeleton.ts) — `stance`, `padFrac`, and what the two
// of them together decide about where a body's weight meets the ground.
//
// 📕 THE USER'S READING, WHICH IS THE WHOLE DESIGN: "the toes of tetrapods…
//    their support function usually just makes them an extension of the foot.
//    If the stance value is high, the animal walks on its toes — it doesn't
//    press the tip of its foot against the ground and its toes splay out."
//
// So `stance` is not the ankle's pitch, it is WHERE ALONG THE COLUMN the
// contact sits — heel → sole → ball → toe tip — and the toes are a
// CONDITIONAL extension of that column, flat at low stance and in line with
// the foot at high. A cat's or a dog's digits really do hinge back at their
// bases, but from outside, and for the purpose of holding an animal up, the
// merged bases read as one flap: model the function, not the joint count (the
// same call the 3-part arthropod leg made).
//
// `padFrac` is the other half — the fat fill of the heel and ankle — and it
// does three things that are one thing: it fills the wedge so a limb reads as
// a COLUMN, it puts a broad disc on the ground for the ledger to price, and it
// runs the load path straight down instead of out along a bent lever.
//
// Pure geometry + the built ledger. No GL, no DOM.

import { describe, it, expect } from "@jest/globals";
import {
  buildSkeleton,
  resolveLimbs,
  legStaticsOf,
  footContactArea,
  restAnklePitch,
  toeAlignOf,
  type CreatureBone,
} from "@shared/world-engine/creatures/skeleton.js";
import { clampBlueprint, type Blueprint } from "@shared/world-engine/creatures/blueprint.js";
import { requireSpecies } from "@shared/world-engine/creatures/species.js";

/** A plain quadruped with ONE limb group, so every foot is the same foot. */
const body = (over: Record<string, unknown> = {}): Blueprint =>
  clampBlueprint({
    version: 1,
    spine: { torsoSegments: 5, torsoLengthM: 1, girth: 0.3 },
    limbGroups: [
      {
        placement: "bilateral",
        count: 2,
        stationStart: 0.2,
        stationEnd: 0.8,
        lengthFrac: 0.5,
        radiusFrac: 0.15,
        taper: 0.6,
        footLengthFrac: 0.25,
        stance: 0,
        padFrac: 0,
        toeCount: 3,
        toeLengthFrac: 0.6,
        toeSpread: 0.5,
        toeContrast: 0,
        opposition: 0,
        toeCurl: 0,
        ...over,
      },
    ],
  });

const len = (b: CreatureBone): number =>
  Math.hypot(b.tail.x - b.head.x, b.tail.y - b.head.y, b.tail.z - b.head.z);
/** Pitch below horizontal, degrees. */
const pitchDeg = (b: CreatureBone): number =>
  (Math.asin(Math.min(1, Math.abs(b.tail.y - b.head.y) / Math.max(len(b), 1e-9))) * 180) / Math.PI;

const bonesOf = (bp: Blueprint) => buildSkeleton(bp).bones;
const footBone = (bs: readonly CreatureBone[]): CreatureBone =>
  bs.filter((b) => b.chain === "limb0L").at(-1)!;
const digits = (bs: readonly CreatureBone[]): CreatureBone[] =>
  bs.filter((b) => /^limb0Ld\d+$/.test(b.chain));
const padBone = (bs: readonly CreatureBone[]): CreatureBone | undefined =>
  bs.find((b) => b.chain === "limb0Lpad");
/** Statics for the first limb of a blueprint — the same call the pose makes. */
const statics = (bp: Blueprint) =>
  legStaticsOf(resolveLimbs(bp).limbs[0]!, bp.spine.torsoLengthM, bp.spine.girth * bp.spine.torsoLengthM);
/** Worst support leg's ledger row. */
const worstLeg = (bp: Blueprint) => {
  const sup = buildSkeleton(bp).support.legs.filter((l) => l.role === "support");
  return sup.reduce((a, b) => (b.stress >= a.stress ? b : a));
};

describe("stance places the contact along the WHOLE foot column", () => {
  it("runs the ankle's rest pitch from flat sole to vertical column", () => {
    expect(restAnklePitch(0)).toBe(0);
    expect(restAnklePitch(1)).toBeCloseTo(1.45, 6); // ≈83°, a standing column
    expect(restAnklePitch(0.5)).toBeCloseTo(restAnklePitch(1) / 2, 6);
    // Out-of-range dials clamp rather than extrapolate past the joint.
    expect(restAnklePitch(-3)).toBe(0);
    expect(restAnklePitch(9)).toBeCloseTo(restAnklePitch(1), 6);
  });

  it("aligns the toes only in the TOP QUARTER of the dial", () => {
    // ⚖️ THE THRESHOLD IS THE COMPATIBILITY GUARANTEE. Everything authored
    // below it — a dog and a cat at 0.6, a bird-footed theropod at 0.7,
    // arthropod tarsi at 0.7 — keeps flat toes hinged at the ball, which is
    // the foot every one of them already had.
    expect(toeAlignOf(0)).toBe(0);
    expect(toeAlignOf(0.6)).toBe(0);
    expect(toeAlignOf(0.75)).toBe(0);
    expect(toeAlignOf(1)).toBeCloseTo(1, 6);
    expect(toeAlignOf(0.875)).toBeGreaterThan(0);
    expect(toeAlignOf(0.875)).toBeLessThan(1);
  });

  it("stands every HOOVED body on its toe tips, ball in the air", () => {
    // ⚠️ MEASURED ON THE REGISTRY, NOT ON A SYNTHETIC BODY, and deliberately.
    // The ankle's pitch is SOLVED, not dialled — it settles where the limb's
    // total strain is least — so a squat test quadruped with stance 1 legally
    // settles at 54° because that is what its proportions can hold. The claim
    // worth pinning is about bodies actually built to stand this way.
    for (const id of ["horse", "cow", "deer", "ungulate", "ram"]) {
      const bs = buildSkeleton(clampBlueprint(requireSpecies(id).blueprint)).bones;
      const foot = bs.filter((b) => b.chain === "limb0L").at(-1)!;
      const toe = bs.filter((b) => /^limb0Ld\d+$/.test(b.chain))[0]!;
      // The foot is a column…
      expect([id, pitchDeg(foot) > 80]).toEqual([id, true]);
      // …and the toe is the last link of it, not a flap off its front.
      expect([id, pitchDeg(toe) > 75]).toEqual([id, true]);
      // The tip is below the ball, and the ball rides most of a toe-length up
      // in the air. THIS is unguligrade, and it is the half that was missing.
      expect([id, toe.tail.y < foot.tail.y]).toEqual([id, true]);
      expect([id, foot.tail.y - toe.tail.y > len(toe) * 0.9]).toEqual([id, true]);
    }
  });

  it("leaves a stance-0 foot flat, hinged at the ball — today's foot", () => {
    const bs = bonesOf(body({ stance: 0 }));
    const foot = footBone(bs);
    // The sole lies flat: below `SOLE_FLAT_SIN`, which is what makes the
    // ledger centre its pressure mid-sole rather than at the tip.
    expect(Math.abs(foot.tail.y - foot.head.y) / len(foot)).toBeLessThan(0.25);
    // The toes dip only as far as it takes to put their tips on the ground
    // from a ball whose axis is a ball-radius up — never past the flat cap.
    for (const d of digits(bs)) expect(pitchDeg(d)).toBeLessThan(40);
  });

  it("buys standing height with the toes, and only at high stance", () => {
    // `contactY` is where the BALL sits when planted, so the toes' share of
    // the column enters every plant, reach and stand-height test for free.
    const flat = statics(body({ stance: 0.6, toeLengthFrac: 0.6 }));
    const tip = statics(body({ stance: 1, toeLengthFrac: 0.6 }));
    // The gain is a toe-length less the ball's own radius, which the foot was
    // already standing on — so between half a toe and a whole one.
    const gain = tip.contactY - flat.contactY;
    expect(gain).toBeGreaterThan(tip.toeLen * 0.5);
    expect(gain).toBeLessThan(tip.toeLen);
    // A shorter toe is a shorter column: the dial reaches the ledger.
    const shortToe = statics(body({ stance: 1, toeLengthFrac: 0.2 }));
    expect(tip.contactY).toBeGreaterThan(shortToe.contactY);
  });

  it("never sinks a foot whose toes are too short to reach the ground", () => {
    // 🚨 THE `max` THAT REPLACED A `lerp`. Blending the ball's height toward
    // the toe tip's "as the tips take over" is only true if the tips took
    // over; on an elephant's stub nails it drove the whole foot 4 cm into the
    // floor. Whichever reaches LOWER holds the body up.
    const stub = body({ stance: 1, toeLengthFrac: 0.2, radiusFrac: 0.6, taper: 0.95 });
    const s = statics(stub);
    expect(s.contactY).toBeGreaterThanOrEqual(s.ballR * 0.85);
    expect(Math.min(...bonesOf(stub).map((b) => b.tail.y))).toBeGreaterThan(0);
  });
});

describe("a hoof is DERIVED from standing on the tips", () => {
  it("caps a stance-1 digit in keratin and a stance-0.6 one in nothing", () => {
    expect(digits(bonesOf(body({ stance: 1 }))).every((d) => d.keratin === true)).toBe(true);
    expect(digits(bonesOf(body({ stance: 0.6 }))).some((d) => d.keratin === true)).toBe(false);
    expect(digits(bonesOf(body({ stance: 0 }))).some((d) => d.keratin === true)).toBe(false);
  });

  it("has NO dial of its own — only the stance decides", () => {
    for (const toeLengthFrac of [0.2, 0.5, 0.9]) {
      for (const toeCount of [1, 2, 4]) {
        const ds = digits(bonesOf(body({ stance: 1, toeLengthFrac, toeCount })));
        expect(ds.every((d) => d.keratin === true)).toBe(true);
      }
    }
  });

  it("draws the cap BLUNT — keratin does not taper to a point", () => {
    const hooved = digits(bonesOf(body({ stance: 1, toeCount: 1 })))[0]!;
    const bare = digits(bonesOf(body({ stance: 0.6, toeCount: 1 })))[0]!;
    expect(hooved.radiusTail / hooved.radiusHead).toBeGreaterThan(0.85);
    expect(bare.radiusTail / bare.radiusHead).toBeLessThan(0.6);
  });

  it("puts one on every hooved body in the registry and on no other", () => {
    const hoofed = (id: string): boolean =>
      buildSkeleton(clampBlueprint(requireSpecies(id).blueprint)).bones
        .some((b) => /d\d+$/.test(b.chain) && b.keratin === true);
    for (const id of ["horse", "cow", "deer", "sheep", "ram", "ungulate"]) {
      expect([id, hoofed(id)]).toEqual([id, true]);
    }
    for (const id of ["human", "dog", "cat", "crocodile", "elephant", "sauropod", "tyrannosaur"]) {
      expect([id, hoofed(id)]).toEqual([id, false]);
    }
  });
});

describe("the pad — the floor the toes used to carry", () => {
  it("scales its disc with LIMB GIRTH, which is what the digit floor was for", () => {
    // The migration, stated as a measurement: 5× the girth gives 5× the pad
    // and the SAME toes. (The old law gave 5× the toes and no pad at all.)
    const thin = statics(body({ radiusFrac: 0.1, padFrac: 1, stance: 0.5 }));
    const thick = statics(body({ radiusFrac: 0.5, padFrac: 1, stance: 0.5 }));
    expect(thick.padR / thin.padR).toBeCloseTo(5, 4);
    expect(thick.padR).toBeCloseTo(thick.ballR, 6); // a pad is the sole's width
    expect(statics(body({ padFrac: 0 })).padR).toBe(0);
  });

  it("enters the LEDGER as contact area — a padded foot presses a broader patch", () => {
    // `footContactArea` is what the ledger splits load by (feet against a
    // resting belly), so this is the pad becoming a fact about the body and
    // not just a shape.
    const bare = statics(body({ stance: 0.5, padFrac: 0 }));
    const full = statics(body({ stance: 0.5, padFrac: 1 }));
    expect(footContactArea(bare)).toBeCloseTo(Math.PI * bare.ballR ** 2, 9);
    expect(footContactArea(full) / footContactArea(bare)).toBeCloseTo(2, 6);
    const half = statics(body({ stance: 0.5, padFrac: 0.5 }));
    expect(footContactArea(half) / footContactArea(bare)).toBeCloseTo(1.25, 6);
  });

  it("fills the wedge as a COLUMN — a bone under the ankle, down to the sole", () => {
    const bs = bonesOf(body({ stance: 0.6, padFrac: 1 }));
    const pad = padBone(bs)!;
    const foot = footBone(bs);
    expect(pad).toBeDefined();
    // Hangs from the ankle, straight down, ending at the sole's own plane.
    expect(pad.head).toEqual(foot.head);
    expect(pad.tail.x).toBeCloseTo(pad.head.x, 9);
    expect(pad.tail.z).toBeCloseTo(pad.head.z, 9);
    expect(pad.tail.y).toBeLessThan(pad.head.y);
    expect(pad.radiusTail).toBeCloseTo(statics(body({ stance: 0.6, padFrac: 1 })).padR, 9);
    expect(padBone(bonesOf(body({ stance: 0.6, padFrac: 0 })))).toBeUndefined();
  });

  it("straightens the load path on a RAISED ankle — the ema falls", () => {
    // The pad's third job. A digitigrade foot without one takes the ground at
    // the ball, out in front of the ankle, and the knee is charged the whole
    // slanted foot as a lever.
    const bare = worstLeg(body({ stance: 0.6, padFrac: 0 }));
    const full = worstLeg(body({ stance: 0.6, padFrac: 1 }));
    expect(full.ema).toBeLessThan(bare.ema);
  });

  it("can NEVER make a foot worse — a flat sole is already bearing at both ends", () => {
    // 🚨 THE INVARIANT, and the bug it was written after. A first cut moved
    // the pressure centre TOWARD the ankle in proportion to `padFrac`, on top
    // of the flat-sole rule — which on a plantigrade foot dragged the centre
    // behind the knee and would have taken the human from σ 1.06 to ~1.3 for
    // adding a heel pad. The pad is not a second rule: it is the other way for
    // the HEEL end to be down, and `max` is how the two combine.
    const bare = worstLeg(body({ stance: 0, padFrac: 0 }));
    for (const padFrac of [0.15, 0.5, 1]) {
      expect(worstLeg(body({ stance: 0, padFrac })).ema).toBeCloseTo(bare.ema, 9);
    }
  });
});
