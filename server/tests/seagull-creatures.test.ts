// Tests for the seagull-dream creature generator's pure-math layers
// (creatures/genome.ts + creatures/skeleton.ts). No three.js, no DOM —
// safe in the default `npm test` run.
//
// The genome is the system's interchange format (instructions/
// creatures.md): producers include a hallucination-prone LLM, so the
// clamp/validate contract — clampGenome(anything shaped like a genome)
// always yields a validateGenome-passing genome — is the load-bearing
// invariant here, alongside determinism and grounded rest poses.

import { describe, it, expect } from "@jest/globals";
import {
  clampGenome,
  defaultGenome,
  randomGenome,
  validateGenome,
  MAX_LIMB_GROUPS,
  MAX_LIMB_COUNT,
  MAX_CHAINS,
  MAX_CHAIN_COUNT,
  MAX_MEMBRANES,
  type Genome,
  type LimbGroupGenome,
} from "../../games/seagull-dream/src/creatures/genome.js";
import {
  buildSkeleton,
  resolveLimbs,
  torsoRadiusAt,
} from "../../games/seagull-dream/src/creatures/skeleton.js";
import { CREATURE_EXAMPLES } from "../../games/seagull-dream/src/creatures/examples.js";
import {
  footCycle,
  legPhaseOffset,
  DEFAULT_GAIT,
  type GaitParams,
} from "../../games/seagull-dream/src/creatures/gait.js";
import {
  convexHull2D,
  supportMargin,
  balanceShift,
} from "../../games/seagull-dream/src/creatures/balance.js";

const SEEDS = [1, 2, 42, 1337, 0xCAFE, 987654321];

describe("genome: validate + clamp", () => {
  it("default genome validates", () => {
    const r = validateGenome(defaultGenome());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rejects non-objects and structurally impossible input", () => {
    expect(validateGenome(null).ok).toBe(false);
    expect(validateGenome(42).ok).toBe(false);
    expect(validateGenome([]).ok).toBe(false);
    expect(validateGenome({}).ok).toBe(false);
    expect(validateGenome({ version: 2 }).ok).toBe(false);
  });

  it("flags out-of-range and wrong-typed fields with paths", () => {
    const g = defaultGenome() as unknown as Record<string, Record<string, unknown>>;
    g.spine.girth = 99;
    g.head.eyePairs = "two";
    const r = validateGenome(g);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith("spine.girth"))).toBe(true);
    expect(r.errors.some((e) => e.startsWith("head.eyePairs"))).toBe(true);
  });

  it("clamp turns LLM-grade garbage into a valid genome", () => {
    const garbage = {
      version: 1,
      spine: { torsoSegments: 999, torsoLengthM: -5, girth: "fat", girthPeak: NaN },
      neck: "long",
      head: { sizeFrac: 100, eyePairs: 7.3 },
      limbGroups: new Array(10).fill({ count: 99, stationStart: 2, segments: 0, placement: "spiral" }),
      skin: { baseColor: "blue", bellyColor: "#GGGGGG" },
      posture: null,
    };
    const clamped = clampGenome(garbage);
    const r = validateGenome(clamped);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(clamped.limbGroups.length).toBeLessThanOrEqual(MAX_LIMB_GROUPS);
    expect(clamped.limbGroups[0].count).toBeLessThanOrEqual(MAX_LIMB_COUNT);
    // Unknown placement is coerced to a valid one, not left invalid.
    expect(clamped.limbGroups.every((l) => ["bilateral", "radial"].includes(l.placement))).toBe(true);
    expect(clamped.spine.torsoSegments).toBeLessThanOrEqual(12);
    expect(clamped.spine.torsoLengthM).toBeGreaterThan(0);
    expect(clamped.skin.baseColor).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("clamps the trunk profile: caps, ranges, sorts, drops non-arrays", () => {
    const clamped = clampGenome({
      version: 1,
      spine: {
        profile: [
          { at: 0.9, scale: 99 },
          { at: -1, scale: "fat" },
          { at: 0.5, scale: 0.05 },
          ...new Array(12).fill({ at: 0.3, scale: 1 }),
        ],
      },
    });
    const prof = clamped.spine.profile;
    expect(prof.length).toBeLessThanOrEqual(8);
    // Sorted ascending by station, every point in range.
    for (let i = 1; i < prof.length; i++) expect(prof[i].at).toBeGreaterThanOrEqual(prof[i - 1].at);
    for (const p of prof) {
      expect(p.at).toBeGreaterThanOrEqual(0);
      expect(p.at).toBeLessThanOrEqual(1);
      expect(p.scale).toBeGreaterThanOrEqual(0.15);
      expect(p.scale).toBeLessThanOrEqual(3);
    }
    expect(validateGenome(clamped).ok).toBe(true);
    // A non-array profile becomes empty, not invalid.
    expect(clampGenome({ version: 1, spine: { profile: "waist" } }).spine.profile).toEqual([]);
    expect(clampGenome({ version: 1, spine: {} }).spine.profile).toEqual([]);
  });

  it("clamp is idempotent", () => {
    const once = clampGenome({ version: 1, spine: { girth: 99 } });
    const twice = clampGenome(once);
    expect(twice).toEqual(once);
  });

  it("clamp preserves in-range values untouched", () => {
    const g = defaultGenome();
    expect(clampGenome(g)).toEqual(g);
  });
});

describe("genome: seeded random producer", () => {
  it("is deterministic per seed", () => {
    for (const seed of SEEDS) {
      expect(randomGenome(seed)).toEqual(randomGenome(seed));
    }
  });

  it("differs across seeds", () => {
    expect(randomGenome(1)).not.toEqual(randomGenome(2));
  });

  it("always emits a validateGenome-passing genome", () => {
    for (const seed of SEEDS) {
      const r = validateGenome(randomGenome(seed));
      expect(r.errors).toEqual([]);
    }
  });
});

describe("lab examples", () => {
  it("every showcase genome clamps to a valid, buildable creature", () => {
    expect(CREATURE_EXAMPLES.length).toBeGreaterThan(0);
    for (const ex of CREATURE_EXAMPLES) {
      const clamped = clampGenome(ex.genome);
      const r = validateGenome(clamped);
      expect(r.errors).toEqual([]);
      const skel = buildSkeleton(clamped);
      expect(skel.bones.length).toBeGreaterThan(0);
      for (const b of skel.bones) {
        expect(Number.isFinite(b.head.x + b.head.y + b.head.z)).toBe(true);
        expect(Number.isFinite(b.tail.x + b.tail.y + b.tail.z)).toBe(true);
        expect(b.radiusHead).toBeGreaterThan(0);
      }
    }
  });
});

describe("torso radius profile", () => {
  it("peaks at girthPeak and tapers toward the ends", () => {
    const g = defaultGenome();
    g.spine.girth = 0.2;
    g.spine.torsoLengthM = 2;
    g.spine.girthPeak = 0.4;
    g.spine.frontTaper = 0.6;
    g.spine.rearTaper = 0.6;
    const peak = torsoRadiusAt(g, 0.4);
    expect(peak).toBeCloseTo(0.4, 10); // girth × length
    expect(torsoRadiusAt(g, 0)).toBeLessThan(peak);
    expect(torsoRadiusAt(g, 1)).toBeLessThan(peak);
    // Smooth and positive everywhere.
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const r = torsoRadiusAt(g, Math.min(t, 1));
      expect(r).toBeGreaterThan(0);
      expect(r).toBeLessThanOrEqual(peak + 1e-12);
    }
  });

  it("a profile waist pinches the radius between two body sections", () => {
    const g = defaultGenome();
    g.spine.girth = 0.2;
    g.spine.girthPeak = 0.5;
    g.spine.frontTaper = 0.1;
    g.spine.rearTaper = 0.1;
    // No profile: roughly even thorax/abdomen radii.
    const flatWaist = torsoRadiusAt(g, 0.5);
    // Add a wasp waist at station 0.5.
    g.spine.profile = [
      { at: 0.34, scale: 1 },
      { at: 0.5, scale: 0.25 },
      { at: 0.66, scale: 1 },
    ];
    const pinched = torsoRadiusAt(g, 0.5);
    expect(pinched).toBeCloseTo(flatWaist * 0.25, 6);
    // The sections on either side of the waist stay full.
    expect(torsoRadiusAt(g, 0.34)).toBeGreaterThan(pinched * 2);
    expect(torsoRadiusAt(g, 0.66)).toBeGreaterThan(pinched * 2);
    // Flat 1 outside the points' span.
    expect(torsoRadiusAt(g, 0.1)).toBeCloseTo(torsoRadiusAt({ ...g, spine: { ...g.spine, profile: [] } }, 0.1), 9);
  });
});

describe("skeleton", () => {
  it("is deterministic for the same genome", () => {
    for (const seed of SEEDS) {
      const g = randomGenome(seed);
      expect(buildSkeleton(g)).toEqual(buildSkeleton(g));
    }
  });

  it("produces finite, positively-sized bones with valid parent links", () => {
    for (const seed of SEEDS) {
      const skel = buildSkeleton(randomGenome(seed));
      expect(skel.bones.length).toBeGreaterThan(0);
      skel.bones.forEach((b, i) => {
        for (const p of [b.head, b.tail]) {
          expect(Number.isFinite(p.x)).toBe(true);
          expect(Number.isFinite(p.y)).toBe(true);
          expect(Number.isFinite(p.z)).toBe(true);
        }
        expect(b.radiusHead).toBeGreaterThan(0);
        expect(b.radiusTail).toBeGreaterThan(0);
        // Parents come before children; exactly one root.
        expect(b.parent).toBeLessThan(i);
        if (i === 0) expect(b.parent).toBe(-1);
        else expect(b.parent).toBeGreaterThanOrEqual(0);
      });
    }
  });

  it("keeps chains contiguous (each bone starts where the previous ends)", () => {
    for (const seed of SEEDS) {
      const skel = buildSkeleton(randomGenome(seed));
      for (let i = 1; i < skel.bones.length; i++) {
        const b = skel.bones[i];
        const prev = skel.bones[i - 1];
        if (b.chain !== prev.chain) continue;
        expect(b.head.x).toBeCloseTo(prev.tail.x, 9);
        expect(b.head.y).toBeCloseTo(prev.tail.y, 9);
        expect(b.head.z).toBeCloseTo(prev.tail.z, 9);
      }
    }
  });

  it("grounds the rest pose: a support touches down, nothing sinks, bellies rest", () => {
    for (const seed of SEEDS) {
      const g = randomGenome(seed);
      const skel = buildSkeleton(g);
      // The axial body never sinks below the ground. Limbs (whose feet
      // and digits press the skin onto the ground) and flexible chains
      // (hanging tentacles/trunks) are exempt.
      for (const b of skel.bones) {
        if (b.kind === "limb" || b.kind === "chain") continue;
        expect(b.tail.y - b.radiusTail).toBeGreaterThanOrEqual(-1e-6);
        expect(b.head.y - b.radiusHead).toBeGreaterThanOrEqual(-1e-6);
      }
      // The creature REST on SOMETHING: either a limb contact touches down
      // or (legless) the belly does. Lifted limbs (arms) may float — but
      // at least one support reaches the ground.
      const lowest = Math.min(
        ...skel.bones.flatMap((b) => [b.head.y - b.radiusHead, b.tail.y - b.radiusTail]),
      );
      expect(lowest).toBeLessThanOrEqual(1e-6);
    }
  });

  it("renders feet and digits: leg chains gain a foot bone + digit chains", () => {
    const g = defaultGenome();
    const grp = g.limbGroups[0];
    grp.count = 1;
    grp.footLengthFrac = 0.25;
    grp.toeCount = 3;
    const skel = buildSkeleton(g);
    for (const side of ["L", "R"]) {
      const chain = skel.bones.filter((b) => b.chain === `limb0${side}`);
      // The limb is a fixed 3-section chain lofted as femur(2)+tibia(2)
      // bones, + 1 foot bone in the same chain = 5.
      expect(chain.length).toBe(5);
      expect(chain[chain.length - 1].id).toBe(`limb0${side}foot`);
      const digits = skel.bones.filter((b) => b.chain.startsWith(`limb0${side}d`));
      expect(digits.length).toBe(3);
      // Digits parent to the foot bone and fan from the ball point.
      const footIdx = skel.bones.findIndex((b) => b.id === `limb0${side}foot`);
      for (const d of digits) expect(d.parent).toBe(footIdx);
    }
  });

  it("stance raises the ankle (plantigrade → unguligrade continuum)", () => {
    const ankleY = (stance: number): number => {
      const g = defaultGenome();
      g.limbGroups.forEach((grp) => {
        grp.count = 1;
        grp.footLengthFrac = 0.3;
        grp.stance = stance;
      });
      const skel = buildSkeleton(g);
      const foot = skel.bones.find((b) => b.id === "limb0Lfoot")!;
      return foot.head.y; // the ankle
    };
    const plantigrade = ankleY(0);
    const digitigrade = ankleY(0.5);
    const unguligrade = ankleY(1);
    expect(digitigrade).toBeGreaterThan(plantigrade);
    expect(unguligrade).toBeGreaterThan(digitigrade);
  });

  it("a levated limb rides the knee up (sprawl) vs a depressed one (tuck under)", () => {
    // Knee elevation is no longer authored — it emerges from how the limb is
    // CARRIED (restLevation): a levated (sprawled) limb plants its foot wide
    // and arches the knee out and UP; a depressed limb stands narrow and
    // folds the knee down and under.
    const archLeg: LimbGroupGenome = {
      placement: "bilateral",
      count: 1, stationStart: 0.5, stationEnd: 0.5, sizePeak: 1, sizeContrast: 0,
      lengthFrac: 0.9, radiusFrac: 0.1, taper: 0.6,
      membrane: 0, attachHeight: 0.4, restProtraction: 0, restLevation: 0.3, restFlexion: 0,
      flexRange: 1, legTwist: 0, legBalance: 0,
      footLengthFrac: 0.1, stance: 0.8, ankleRange: 1, toeCount: 1, toeLengthFrac: 0.3, toeSpread: 0,
      toeContrast: 0, opposition: 0, toeCurl: 0,
    };
    const kneePeak = (restLevation: number): { peak: number; hipY: number } => {
      const g = defaultGenome();
      g.posture.bodyHeight = 0.1; // slung low so the bend shows
      g.limbGroups = [{ ...archLeg, restLevation }];
      const chain = buildSkeleton(g).bones.filter((b) => b.chain === "limb0L" && !b.id.endsWith("foot"));
      return { peak: Math.max(...chain.slice(0, -1).map((b) => b.tail.y)), hipY: chain[0].head.y };
    };
    const high = kneePeak(0.3);
    const low = kneePeak(-0.5);
    // The levated limb carries its knee higher than the depressed one...
    expect(high.peak).toBeGreaterThan(low.peak);
    // ...and the depressed (mammal) limb keeps the joint tucked below the hip.
    expect(low.peak).toBeLessThan(low.hipY);
  });

  it("load recruitment: a capable manipulator stays raised when other legs support, and deploys when they are removed", () => {
    // Forelegs are mounted low (so they CAN reach the ground) but aimed like
    // a manipulator (reaching forward, raised, folded). With enough walking
    // legs the body is already supported, so the forelegs stay raised; strip
    // the walkers and the forelegs must deploy to keep the body up.
    const foreFootY = (walkRows: number): { fore: number; walk: number } => {
      const g = defaultGenome();
      g.posture.bodyHeight = 0.5;
      g.tail.segments = 0; // keep the CoM mid-body
      const walk = {
        ...g.limbGroups[0], attachHeight: 0.45, restProtraction: 0, restLevation: 0.2,
        restFlexion: 0, lengthFrac: 0.6, radiusFrac: 0.05, footLengthFrac: 0.1, toeCount: 1,
      };
      const fore = { ...walk, restProtraction: 0.2, restLevation: 0.85, restFlexion: 0.2 };
      g.limbGroups = [
        // count 2 → a rear row (0.85) + a front row (0.4); count 1 → rear only.
        { ...walk, count: walkRows, stationStart: 0.85, stationEnd: 0.4 },
        { ...fore, count: 1, stationStart: 0.18, stationEnd: 0.18 },
      ];
      const skel = buildSkeleton(g);
      const foreFoot = skel.bones.find((b) => b.id === `limb${walkRows}Lfoot`)!; // group1 copy0
      const walkFoot = skel.bones.find((b) => b.id === "limb0Lfoot")!;
      return { fore: foreFoot.tail.y, walk: walkFoot.tail.y };
    };
    const supported = foreFootY(3); // 6 walking legs hold the body
    expect(supported.fore).toBeGreaterThan(supported.walk + 0.1); // foreleg held UP, not planted
    const stripped = foreFootY(1); // only 2 walking legs — the forelegs must deploy
    expect(stripped.fore).toBeLessThan(supported.fore - 0.1); // dropped toward the ground
  });

  it("stance width grows with restLevation (stability sprawl)", () => {
    // A levated (sprawled) limb plants its foot WIDER for a stable base; a
    // depressed limb stands narrow, straight under the body.
    const footX = (restLevation: number): number => {
      const g = defaultGenome();
      g.posture.bodyHeight = 0.5;
      g.limbGroups = [{ ...g.limbGroups[0], count: 1, stationStart: 0.5, stationEnd: 0.5, restLevation }];
      const foot = buildSkeleton(g).bones.find((b) => b.id === "limb0Lfoot")!;
      return Math.abs(foot.head.x); // ankle lateral offset from the centerline
    };
    expect(footX(0.3)).toBeGreaterThan(footX(-0.5) + 0.02);
  });

  it("restProtraction swings both legs the same way (mirror-symmetric, not one fore/one aft)", () => {
    const feet = (restProtraction: number) => {
      const g = defaultGenome();
      g.posture.bodyHeight = 0.5;
      g.limbGroups = [{ ...g.limbGroups[0], count: 1, stationStart: 0.5, stationEnd: 0.5, restLevation: 0.3, restProtraction, footLengthFrac: 0.15 }];
      const skel = buildSkeleton(g);
      const l = skel.bones.find((b) => b.id === "limb0Lfoot")!.tail;
      const r = skel.bones.find((b) => b.id === "limb0Rfoot")!.tail;
      return { l, r };
    };
    const fwd = feet(0.6);
    const neutral = feet(0);
    // Left and right feet stay mirror-symmetric: same z (fore/aft), opposite x.
    expect(fwd.l.z).toBeCloseTo(fwd.r.z, 6);
    expect(fwd.l.x).toBeCloseTo(-fwd.r.x, 6);
    // And +protraction carries BOTH feet forward of their neutral position.
    expect(fwd.l.z).toBeGreaterThan(neutral.l.z + 0.05);
    expect(fwd.r.z).toBeGreaterThan(neutral.r.z + 0.05);
  });

  it("legBalance moves the knee without changing where the foot lands", () => {
    const kneeAndFoot = (legBalance: number) => {
      const g = defaultGenome();
      g.limbGroups = [{ ...g.limbGroups[0], count: 1, stationStart: 0.5, stationEnd: 0.5, legBalance, footLengthFrac: 0.1 }];
      const skel = buildSkeleton(g);
      const chain = skel.bones.filter((b) => b.chain === "limb0L" && !b.id.endsWith("foot"));
      const knee = chain[1].tail; // femur/tibia junction (4 loft bones: knee at index 1's tail)
      const foot = skel.bones.find((b) => b.id === "limb0Lfoot")!.tail;
      return { kneeY: knee.y, footY: foot.y, footZ: foot.z };
    };
    const longFemur = kneeAndFoot(-0.8);
    const longShank = kneeAndFoot(0.8);
    // The total length is unchanged, so the foot lands in the same place...
    expect(longFemur.footY).toBeCloseTo(longShank.footY, 4);
    expect(longFemur.footZ).toBeCloseTo(longShank.footZ, 4);
    // ...but the knee sits at a different height.
    expect(Math.abs(longFemur.kneeY - longShank.kneeY)).toBeGreaterThan(0.02);
  });

  it("stance emerges from posture: held high the foot rises onto its tip, held low it stays flat", () => {
    const ankleRise = (bodyHeight: number): number => {
      const g = defaultGenome();
      g.posture.bodyHeight = bodyHeight;
      g.limbGroups = [{ ...g.limbGroups[0], stance: 0.15, footLengthFrac: 0.28, ankleRange: 1 }];
      const foot = buildSkeleton(g).bones.find((b) => b.id === "limb0Lfoot")!;
      return foot.head.y - foot.tail.y; // ankle height above the ground contact (ball)
    };
    expect(ankleRise(1.0)).toBeGreaterThan(ankleRise(0.3) + 0.02);
  });

  it("legTwist rotates a held limb out of its plane (3D curl)", () => {
    const tip = (legTwist: number) => {
      const g = defaultGenome();
      // membrane → not leggy → always held (forward kinematics), so the twist shows.
      g.limbGroups = [{ ...g.limbGroups[0], count: 1, membrane: 0.9, footLengthFrac: 0, restFlexion: 0.6, attachHeight: 0.5, legTwist }];
      const chain = buildSkeleton(g).bones.filter((b) => b.chain === "limb0L");
      return chain[chain.length - 1].tail;
    };
    const t0 = tip(0);
    const t1 = tip(1.0);
    expect(Math.hypot(t1.x - t0.x, t1.y - t0.y, t1.z - t0.z)).toBeGreaterThan(0.02);
  });

  it("strain solve: a heavy load straightens the bent rest knee toward a pillar", () => {
    // Same bent rest knee; under a heavy share the joint springs are overrun
    // and the knee straightens (a load-cheap column), while a light,
    // thick-legged limb relaxes back to its bent rest crouch.
    // Both have strong (thick) legs — only the body weight differs.
    const kneeAngle = (girth: number): number => {
      const g = defaultGenome();
      g.spine.girth = girth; // body weight
      g.posture.bodyHeight = 0.5;
      g.limbGroups = [{ ...g.limbGroups[0], radiusFrac: 0.18, restFlexion: -0.7, stance: 0.5, footLengthFrac: 0.2, ankleRange: 1 }];
      const chain = buildSkeleton(g).bones.filter((b) => b.chain === "limb0L" && !b.id.endsWith("foot"));
      const hip = chain[0].head, knee = chain[1].tail, ankle = chain[chain.length - 1].tail;
      const a = [hip.x - knee.x, hip.y - knee.y, hip.z - knee.z];
      const b = [ankle.x - knee.x, ankle.y - knee.y, ankle.z - knee.z];
      const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const la = Math.hypot(...a), lb = Math.hypot(...b);
      return Math.acos(Math.max(-1, Math.min(1, dot / (la * lb)))); // π = straight
    };
    const heavy = kneeAngle(0.42); // heavy trunk → straightens toward a pillar
    const light = kneeAngle(0.08); // light trunk → relaxes to its bent rest
    expect(heavy).toBeGreaterThan(light + 0.05);
  });

  it("a heavy body on thin legs stands lower than on thick legs", () => {
    // Girth → weight (body) and strength (legs): give a fat trunk spindly
    // legs and it sags toward belly-rest instead of standing tall.
    const standHeight = (radiusFrac: number): number => {
      const g = defaultGenome();
      g.spine.girth = 0.4; // heavy trunk
      g.posture.bodyHeight = 1; // ask to stand as tall as possible
      g.limbGroups = [{ ...g.limbGroups[0], radiusFrac }];
      const skel = buildSkeleton(g);
      const torso = skel.bones.filter((b) => b.kind === "torso");
      return Math.max(...torso.map((b) => b.head.y)); // top of the trunk
    };
    expect(standHeight(0.06)).toBeLessThan(standHeight(0.22));
  });

  it("resolveLimbs duplicates a leg type into evenly-spaced rows", () => {
    const g = defaultGenome();
    g.limbGroups = [{
      ...g.limbGroups[0], count: 4, stationStart: 0.1, stationEnd: 0.9,
      sizePeak: 1, sizeContrast: 0,
    }];
    const { limbs } = resolveLimbs(g);
    expect(limbs.length).toBe(4);
    expect(limbs.map((l) => l.station)).toEqual([0.1, 0.1 + 0.8 / 3, 0.1 + 1.6 / 3, 0.9]);
    // All copies belong to the one group, indexed front→back.
    expect(limbs.every((l) => l.group === 0)).toBe(true);
    expect(limbs.map((l) => l.index)).toEqual([0, 1, 2, 3]);
  });

  it("size gravitation scales rows toward the peak", () => {
    const g = defaultGenome();
    g.limbGroups = [{
      ...g.limbGroups[0], count: 3, stationStart: 0.1, stationEnd: 0.9,
      sizePeak: 0, sizeContrast: 0.5, lengthFrac: 1,
    }];
    const front = resolveLimbs(g).limbs;
    // Peak at front (row 0) → front largest, back smallest.
    expect(front[0].lengthFrac).toBeGreaterThan(front[1].lengthFrac);
    expect(front[1].lengthFrac).toBeGreaterThan(front[2].lengthFrac);
    expect(front[0].lengthFrac).toBeCloseTo(1, 10);
    expect(front[2].lengthFrac).toBeCloseTo(0.5, 10); // 1 - contrast at the far row

    // Peak in the middle → middle row largest.
    g.limbGroups[0].sizePeak = 0.5;
    const mid = resolveLimbs(g).limbs;
    expect(mid[1].lengthFrac).toBeGreaterThan(mid[0].lengthFrac);
    expect(mid[1].lengthFrac).toBeGreaterThan(mid[2].lengthFrac);
  });

  it("role is emergent: a membranous limb carries flatten; a short forelimb lifts off and hangs", () => {
    const leg: LimbGroupGenome = { ...defaultGenome().limbGroups[0] };
    const g = defaultGenome();
    // limb0 = long rear legs (lead, ground), limb1 = membranous forelimb
    // (a wing), limb2 = a short forelimb (an arm) that can't reach.
    g.posture.bodyHeight = 1; // ride high so short forelimbs lift off
    g.limbGroups = [
      { ...leg, count: 1, stationStart: 0.85, stationEnd: 0.85, lengthFrac: 0.9 },
      { ...leg, count: 1, stationStart: 0.2, stationEnd: 0.2, lengthFrac: 0.45, membrane: 0.9, footLengthFrac: 0 },
      { ...leg, count: 1, stationStart: 0.3, stationEnd: 0.3, lengthFrac: 0.4, membrane: 0, footLengthFrac: 0 },
    ];
    const skel = buildSkeleton(g);
    // The membranous limb's bones carry the membrane as flatten.
    const wing = skel.bones.filter((b) => b.chain === "limb1L");
    expect(wing.length).toBeGreaterThan(0);
    expect(wing.every((b) => b.flatten > 0.5)).toBe(true);
    // The short forelimbs can't reach the ground at this height, so they
    // hang: their tips sit below their shoulders (and above the foot of a
    // grounded rear leg, i.e. they didn't ground-solve to y≈0).
    const arm = skel.bones.filter((b) => b.chain === "limb2L");
    expect(arm[arm.length - 1].tail.y).toBeLessThan(arm[0].head.y);
    expect(arm[arm.length - 1].tail.y).toBeGreaterThan(0.05);
    // The long rear leg DID ground (a foot tip near y=0).
    const rearTip = skel.bones.filter((b) => b.chain.startsWith("limb0L")).pop()!;
    expect(rearTip.tail.y).toBeLessThan(0.05);
  });

  it("builds flexible chains as 'chain*' bone chains rooted on the attach point", () => {
    const g = defaultGenome();
    g.chains = [{
      attach: "head", station: 0.5, count: 2, radial: false, segments: 5,
      lengthFrac: 0.8, radiusFrac: 0.05, taper: 0.2, aim: 0.5, spread: 0.5, curl: 0.5, tip: "none",
    }];
    const skel = buildSkeleton(g);
    const chainNames = new Set(skel.bones.filter((b) => b.kind === "chain").map((b) => b.chain));
    expect(chainNames.size).toBe(2); // a bilateral pair
    const headIdx = skel.bones.findIndex((b) => b.kind === "head");
    for (const name of chainNames) {
      const cbones = skel.bones.filter((b) => b.chain === name);
      expect(cbones.length).toBe(5);
      expect(cbones[0].parent).toBe(headIdx);
      expect(cbones.every((b) => b.kind === "chain")).toBe(true);
      expect(cbones.every((b) => b.radiusHead > 0 && b.radiusTail > 0)).toBe(true);
    }
    // Chains never get feet and don't lift the body.
    expect(skel.bones.some((b) => b.kind === "chain" && b.id.includes("foot"))).toBe(false);
  });

  it("a radial chain crown spawns `count` chains fanned around the attach axis", () => {
    const g = defaultGenome();
    g.chains = [{
      attach: "head", station: 0.5, count: 6, radial: true, segments: 4,
      lengthFrac: 0.6, radiusFrac: 0.05, taper: 0.3, aim: -0.5, spread: 0.4, curl: 0.3, tip: "none",
    }];
    const skel = buildSkeleton(g);
    const names = [...new Set(skel.bones.filter((b) => b.kind === "chain").map((b) => b.chain))];
    expect(names.length).toBe(6);
    // The roots fan out — they don't all share one position.
    const roots = names.map((n) => skel.bones.find((b) => b.chain === n)!.head);
    expect(new Set(roots.map((h) => `${h.x.toFixed(4)},${h.y.toFixed(4)}`)).size).toBeGreaterThan(1);
  });

  it("chain tips become details: eye → eyeball welded to the chain tip", () => {
    const g = defaultGenome();
    g.head.eyePairs = 0; // isolate the eyestalk eyes from head eyes
    g.chains = [{
      attach: "head", station: 0.5, count: 2, radial: false, segments: 4,
      lengthFrac: 0.5, radiusFrac: 0.05, taper: 0.3, aim: 0.8, spread: 0.4, curl: 0.2, tip: "eye",
    }];
    const skel = buildSkeleton(g);
    const eyes = skel.details.filter((d) => d.kind === "eye");
    expect(eyes.length).toBe(2); // one per eyestalk
    for (const e of eyes) expect(skel.bones[e.bone].kind).toBe("chain");
  });

  it("clamps flexible chains: caps count, coerces enums/bools, drops extras", () => {
    const clamped = clampGenome({
      version: 1,
      chains: new Array(9).fill({ attach: "sky", tip: "laser", radial: "yes", count: 99, segments: 0, taper: 0 }),
    });
    expect(clamped.chains.length).toBeLessThanOrEqual(MAX_CHAINS);
    for (const ch of clamped.chains) {
      expect(["head", "body"]).toContain(ch.attach);
      expect(["none", "club", "eye", "stinger"]).toContain(ch.tip);
      expect(typeof ch.radial).toBe("boolean");
      expect(ch.count).toBeLessThanOrEqual(MAX_CHAIN_COUNT);
      expect(ch.taper).toBeGreaterThan(0); // floored so the tip stays solid
    }
    expect(validateGenome(clamped).ok).toBe(true);
    expect(clampGenome({ version: 1 }).chains).toEqual([]);
  });

  it("builds a dorsal midline membrane that rises from the body and tapers at its ends", () => {
    const g = defaultGenome();
    g.membranes = [{ edge: "dorsal", start: 0.3, end: 0.8, height: 0.4, heightPeak: 0.5, rays: 0 }];
    const skel = buildSkeleton(g);
    expect(skel.membranes.length).toBe(1);
    const ribs = skel.membranes[0].ribs;
    expect(ribs.length).toBeGreaterThanOrEqual(5);
    const h = (r: typeof ribs[number]): number =>
      Math.hypot(r.tip.x - r.base.x, r.tip.y - r.base.y, r.tip.z - r.base.z);
    // Dorsal: every tip sits at or above its base; ends taper to ~0, the
    // middle is tall.
    for (const r of ribs) {
      expect(r.tip.y).toBeGreaterThanOrEqual(r.base.y - 1e-9);
      expect(r.bone).toBeGreaterThanOrEqual(0);
    }
    expect(h(ribs[0])).toBeLessThan(0.02);
    expect(h(ribs[ribs.length - 1])).toBeLessThan(0.02);
    expect(Math.max(...ribs.map(h))).toBeGreaterThan(0.2);
  });

  it("a ventral membrane hangs below the body", () => {
    const g = defaultGenome();
    g.membranes = [{ edge: "ventral", start: 0.3, end: 0.7, height: 0.3, heightPeak: 0.5, rays: 0 }];
    const skel = buildSkeleton(g);
    const ribs = skel.membranes[0].ribs;
    for (const r of ribs) expect(r.tip.y).toBeLessThanOrEqual(r.base.y + 1e-9);
  });

  it("clamps membranes: caps count, coerces edge, drops a zero-height web at build", () => {
    const clamped = clampGenome({
      version: 1,
      membranes: new Array(9).fill({ edge: "sideways", height: 99, heightPeak: 5, rays: -3 }),
    });
    expect(clamped.membranes.length).toBeLessThanOrEqual(MAX_MEMBRANES);
    for (const m of clamped.membranes) {
      expect(["dorsal", "ventral"]).toContain(m.edge);
      expect(m.height).toBeLessThanOrEqual(1.2);
      expect(m.rays).toBeGreaterThanOrEqual(0);
    }
    expect(validateGenome(clamped).ok).toBe(true);
    expect(clampGenome({ version: 1 }).membranes).toEqual([]);
    // A zero-height membrane produces no panel.
    const g = defaultGenome();
    g.membranes = [{ edge: "dorsal", start: 0.3, end: 0.8, height: 0, heightPeak: 0.5, rays: 0 }];
    expect(buildSkeleton(g).membranes.length).toBe(0);
  });

  it("stays within the limb-group cap from the random producer", () => {
    for (const seed of SEEDS) {
      expect(randomGenome(seed).limbGroups.length).toBeLessThanOrEqual(MAX_LIMB_GROUPS);
    }
  });

  it("radial placement spawns `count` ground-solved spokes (no L/R mirror)", () => {
    const g = defaultGenome();
    g.limbGroups = [{ ...g.limbGroups[0], placement: "radial", count: 5 }];
    const skel = buildSkeleton(g);
    const legChains = new Set(
      skel.bones.filter((b) => b.kind === "limb" && /^limb\d+r$/.test(b.chain)).map((b) => b.chain),
    );
    expect(legChains.size).toBe(5);
    // Each radial leg grounds its foot.
    for (const name of legChains) {
      const foot = skel.bones.find((b) => b.id === `${name}foot`)!;
      expect(foot.tail.y - foot.radiusTail).toBeLessThanOrEqual(1e-6);
    }
  });

  it("digits emerge from continuous properties: hoof=1, claw=pair, hand=many; membrane flattens", () => {
    const base = defaultGenome().limbGroups[0];
    const build = (over: Partial<LimbGroupGenome>): ReturnType<typeof buildSkeleton> =>
      buildSkeleton({ ...defaultGenome(), limbGroups: [{ ...base, count: 1, footLengthFrac: 0.2, ...over }] });
    const digitCount = (skel: ReturnType<typeof buildSkeleton>): number =>
      new Set(skel.bones.filter((b) => b.chain.startsWith("limb0Ld")).map((b) => b.chain)).size;

    expect(digitCount(build({ toeCount: 1 }))).toBe(1); // hoof
    expect(digitCount(build({ toeCount: 2, toeCurl: 0.8 }))).toBe(2); // pincer pair
    expect(digitCount(build({ toeCount: 5, opposition: 0.8 }))).toBe(5); // hand (thumb is one)

    // A membranous leg flattens into a blade (a flipper / wing).
    const flip = build({ membrane: 0.9 });
    expect(flip.bones.filter((b) => b.chain === "limb0L").some((b) => b.flatten > 0.5)).toBe(true);
  });

  it("a lifted forelimb grows digits (a hand) at its hanging tip", () => {
    const leg = defaultGenome().limbGroups[0];
    const g = defaultGenome();
    g.posture.bodyHeight = 1; // ride high so the short forelimb lifts off
    g.limbGroups = [
      { ...leg, count: 1, stationStart: 0.85, stationEnd: 0.85, lengthFrac: 0.9 },
      { ...leg, count: 1, stationStart: 0.2, stationEnd: 0.2, lengthFrac: 0.45, footLengthFrac: 0, toeCount: 4, opposition: 0.8 },
    ];
    const skel = buildSkeleton(g);
    const digits = new Set(skel.bones.filter((b) => b.chain.startsWith("limb1Ld")).map((b) => b.chain));
    expect(digits.size).toBe(4);
  });

  it("clamp truncates to the limb-group cap", () => {
    const clamped = clampGenome({ version: 1, limbGroups: new Array(9).fill({ placement: "bilateral" }) });
    expect(clamped.limbGroups.length).toBe(MAX_LIMB_GROUPS);
    expect(validateGenome(clamped).ok).toBe(true);
  });

  it("scales with the genome (bigger torso → bigger skeleton)", () => {
    const small = defaultGenome();
    small.spine.torsoLengthM = 0.3;
    const big = defaultGenome();
    big.spine.torsoLengthM = 3;
    const sk1 = buildSkeleton(clampGenome(small) as Genome);
    const sk2 = buildSkeleton(clampGenome(big) as Genome);
    const span = (s: typeof sk1) => s.bounds.max.z - s.bounds.min.z;
    expect(span(sk2)).toBeGreaterThan(span(sk1) * 5);
  });

  it("carries body cross-section onto the trunk, easing back to round at the head", () => {
    const g = defaultGenome();
    g.spine.crossSection = 2.4; // wide & flat (ray-like)
    g.tail.segments = 4;
    g.neck.segments = 3;
    const skel = buildSkeleton(g);
    // Torso and tail bones take the full ratio.
    for (const b of skel.bones) {
      if (b.kind === "torso" || b.kind === "tail") {
        expect(b.aspect).toBeCloseTo(2.4, 9);
      }
    }
    // The head bulb is round regardless of body flattening.
    const head = skel.bones.find((b) => b.kind === "head")!;
    expect(head.aspect).toBeCloseTo(1, 9);
    // The neck eases from the body ratio toward round, monotonically.
    const neck = skel.bones.filter((b) => b.kind === "neck");
    for (let i = 1; i < neck.length; i++) {
      expect(neck[i].aspect).toBeLessThan(neck[i - 1].aspect);
    }
    // Limbs are unaffected by body cross-section.
    for (const b of skel.bones) {
      if (b.kind === "limb") expect(b.aspect).toBeCloseTo(1, 9);
    }
  });

  it("clamps body cross-section into range and defaults when absent", () => {
    expect(clampGenome({ version: 1, spine: { crossSection: 99 } }).spine.crossSection).toBeLessThanOrEqual(3);
    expect(clampGenome({ version: 1, spine: { crossSection: -5 } }).spine.crossSection).toBeGreaterThanOrEqual(0.3);
    expect(clampGenome({ version: 1, spine: {} }).spine.crossSection).toBe(1);
  });

  it("emits head details: a beak and the genome's eye pairs", () => {
    const g = defaultGenome();
    const skel = buildSkeleton(g);
    const eyes = skel.details.filter((d) => d.kind === "eye");
    const beaks = skel.details.filter((d) => d.kind === "beak");
    expect(beaks.length).toBe(1);
    expect(eyes.length).toBe(g.head.eyePairs * 2);
    // Eyes mirror across the sagittal plane.
    const xs = eyes.map((e) => e.position.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-xs[xs.length - 1], 9);
  });
});

describe("gait (procedural walk)", () => {
  it("foot cycle is continuous at the stance↔swing seam", () => {
    const p: GaitParams = { ...DEFAULT_GAIT, dutyFactor: 0.6 };
    // Just before / after the seam (u = duty) the foot neither jumps nor
    // is mid-air: advance ≈ -0.5 and lift ≈ 0 on both sides.
    const before = footCycle(0.6 - 1e-4, { ...p, phase: 0 });
    const after = footCycle(0.6 + 1e-4, { ...p, phase: 0 });
    expect(before.planted).toBe(true);
    expect(after.planted).toBe(false);
    expect(before.advance).toBeCloseTo(-0.5, 2);
    expect(after.advance).toBeCloseTo(-0.5, 2);
    expect(before.lift).toBeCloseTo(0, 2);
    expect(after.lift).toBeCloseTo(0, 2);
  });

  it("a foot is planted for the duty fraction of the cycle", () => {
    const p: GaitParams = { ...DEFAULT_GAIT, dutyFactor: 0.7 };
    let planted = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) planted += footCycle(0, { ...p, phase: i / N }).planted ? 1 : 0;
    expect(planted / N).toBeCloseTo(0.7, 1);
  });

  it("the swing foot lifts; the planted one stays down", () => {
    let lifted = 0;
    let down = 0;
    let maxLift = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const c = footCycle(0, { ...DEFAULT_GAIT, phase: i / N });
      if (c.planted) { down++; expect(c.lift).toBe(0); } else { lifted++; maxLift = Math.max(maxLift, c.lift); }
    }
    expect(lifted).toBeGreaterThan(0);
    expect(down).toBeGreaterThan(0);
    expect(maxLift).toBeGreaterThan(0.9); // mid-swing reaches full step height
  });

  it("trot phases diagonal legs together, antiphase to the other pair", () => {
    const fl = legPhaseOffset({ stationFrac: 0.2, side: -1 }, "trot"); // front-left
    const fr = legPhaseOffset({ stationFrac: 0.2, side: 1 }, "trot"); // front-right
    const hl = legPhaseOffset({ stationFrac: 0.8, side: -1 }, "trot"); // hind-left
    const hr = legPhaseOffset({ stationFrac: 0.8, side: 1 }, "trot"); // hind-right
    expect(fl).toBeCloseTo(hr, 9); // one diagonal pair shares a phase
    expect(fr).toBeCloseTo(hl, 9); // the other diagonal pair shares a phase
    expect(Math.abs(fl - fr)).toBeCloseTo(0.5, 9); // pairs are antiphase
  });

  it("pace phases by side (left legs together, right legs together)", () => {
    const fl = legPhaseOffset({ stationFrac: 0.2, side: -1 }, "pace");
    const hl = legPhaseOffset({ stationFrac: 0.8, side: -1 }, "pace");
    const fr = legPhaseOffset({ stationFrac: 0.2, side: 1 }, "pace");
    expect(fl).toBeCloseTo(hl, 9); // same side → same phase
    expect(Math.abs(fl - fr)).toBeCloseTo(0.5, 9); // opposite sides antiphase
  });

  it("a walking skeleton lifts the swing foot and keeps a planted foot down", () => {
    // Default quadruped: limb0 = front pair (station 0.18), limb1 = hind
    // (0.85). Under a trot at phase 0.8 the front-left foot is mid-swing
    // and the front-right is planted.
    const g = defaultGenome();
    const restY = buildSkeleton(g).bones.find((b) => b.id === "limb0Lfoot")!.tail.y;
    const gait: GaitParams = { phase: 0.8, strideFrac: 0.5, stepHeight: 0.3, dutyFactor: 0.6, pattern: "trot" };
    const walk = buildSkeleton(g, gait);
    const swing = walk.bones.find((b) => b.id === "limb0Lfoot")!;
    const stance = walk.bones.find((b) => b.id === "limb0Rfoot")!;
    expect(swing.tail.y).toBeGreaterThan(restY + 0.03); // lifted off the ground
    expect(stance.tail.y).toBeLessThan(swing.tail.y); // its diagonal partner stays down
  });

  it("the gait is deterministic for the same genome + params", () => {
    const g = defaultGenome();
    const gait: GaitParams = { ...DEFAULT_GAIT, phase: 0.37 };
    const a = buildSkeleton(g, gait).bones.map((b) => b.tail.y);
    const b = buildSkeleton(g, gait).bones.map((b) => b.tail.y);
    expect(a).toEqual(b);
  });

  it("with no gait the rest pose is unchanged (gait is purely additive)", () => {
    const g = defaultGenome();
    const rest = buildSkeleton(g).bones.map((b) => `${b.tail.x},${b.tail.y},${b.tail.z}`);
    const restAgain = buildSkeleton(g, undefined).bones.map((b) => `${b.tail.x},${b.tail.y},${b.tail.z}`);
    expect(rest).toEqual(restAgain);
  });
});

describe("balance (CoM over the support polygon)", () => {
  it("convexHull2D returns the outer corners of a point cloud", () => {
    const hull = convexHull2D([
      { x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }, { x: 1, z: 1 }, // interior point
    ]);
    expect(hull.length).toBe(4); // the square's 4 corners; the interior point is dropped
  });

  it("supportMargin is positive inside the polygon, negative outside", () => {
    const hull = convexHull2D([{ x: -1, z: -1 }, { x: 1, z: -1 }, { x: 1, z: 1 }, { x: -1, z: 1 }]);
    expect(supportMargin({ x: 0, z: 0 }, hull)).toBeGreaterThan(0); // centre
    expect(supportMargin({ x: 2, z: 0 }, hull)).toBeLessThan(0); // outside
    // A degenerate support (a line — two feet) is never strictly inside.
    expect(supportMargin({ x: 0, z: 0 }, [{ x: -1, z: 0 }, { x: 1, z: 0 }])).toBeLessThanOrEqual(0);
  });

  it("balanceShift moves an off-balance CoM toward the feet, and leaves a balanced one alone", () => {
    const feet = [{ x: -1, z: 0 }, { x: 1, z: 0 }, { x: 0, z: 2 }];
    const inside = balanceShift({ x: 0, z: 0.8 }, feet, 0.1); // already over the support
    expect(Math.hypot(inside.x, inside.z)).toBeLessThan(1e-6);
    const out = balanceShift({ x: 0, z: -2 }, feet, 0.1); // behind the feet
    expect(out.z).toBeGreaterThan(0.1); // shifts forward, toward the support
  });

  it("a biped leans its body so the CoM rides over its two feet", () => {
    const g = defaultGenome();
    g.posture = { bodyPitch: 1.0, bodyHeight: 0.8 };
    g.tail.segments = 0;
    g.neck = { segments: 3, lengthFrac: 1.0, radiusFrac: 0.5, lift: 0.2 }; // long neck → CoM would pull forward
    g.limbGroups = [{ ...g.limbGroups[0], count: 1, stationStart: 0.82, stationEnd: 0.82, lengthFrac: 0.9, attachHeight: 0.3, restLevation: -0.5 }];
    const skel = buildSkeleton(g);
    // Mass-weighted centre of the posed trunk.
    let mx = 0, mz = 0, m = 0;
    for (const b of skel.bones) {
      if (b.kind !== "torso") continue;
      const r = (b.radiusHead + b.radiusTail) / 2;
      const len = Math.hypot(b.tail.x - b.head.x, b.tail.y - b.head.y, b.tail.z - b.head.z);
      const w = r * r * len;
      mx += w * (b.head.x + b.tail.x) / 2; mz += w * (b.head.z + b.tail.z) / 2; m += w;
    }
    mx /= m; mz /= m;
    const feet = ["limb0Lfoot", "limb0Rfoot"].map((id) => {
      const f = skel.bones.find((b) => b.id === id)!;
      return { x: f.tail.x, z: f.tail.z };
    });
    // The trunk centre should sit near the foot line (leaned over the feet),
    // not far in front of it.
    const margin = supportMargin({ x: mx, z: mz }, convexHull2D(feet));
    expect(Math.abs(margin)).toBeLessThan(0.18 * g.spine.torsoLengthM);
  });
});
