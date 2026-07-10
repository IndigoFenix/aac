// Tests for the seagull-dream creature generator's pure-math layers
// (creatures/blueprint.ts + creatures/skeleton.ts). No three.js, no DOM —
// safe in the default `npm test` run.
//
// The blueprint is the system's interchange format (instructions/
// creatures.md): producers include a hallucination-prone LLM, so the
// clamp/validate contract — clampBlueprint(anything shaped like a blueprint)
// always yields a validateBlueprint-passing blueprint — is the load-bearing
// invariant here, alongside determinism and grounded rest poses.

import { describe, it, expect } from "@jest/globals";
import {
  clampBlueprint,
  defaultBlueprint,
  randomBlueprint,
  validateBlueprint,
  MAX_LIMB_GROUPS,
  MAX_LIMB_COUNT,
  MAX_CHAINS,
  MAX_CHAIN_COUNT,
  MAX_MEMBRANES,
  type Blueprint,
  type LimbGroupBlueprint,
} from "../../games/seagull-dream/src/creatures/blueprint.js";
import {
  buildSkeleton,
  resolveLimbs,
  torsoRadiusAt,
} from "../../games/seagull-dream/src/creatures/skeleton.js";
import { CREATURE_EXAMPLES } from "../../games/seagull-dream/src/creatures/examples.js";
import {
  limbChainName,
  limbTip,
  type Vec3,
} from "../../games/seagull-dream/src/creatures/skeleton.js";
import {
  footCycle,
  legPhaseOffset,
  locomotionGait,
  bodyBob,
  DEFAULT_GAIT,
  type GaitParams,
} from "../../games/seagull-dream/src/creatures/gait.js";
import {
  CreatureAnimator,
  pickHandGroup,
  pickArmGroup,
  type AnimFrame,
} from "../../games/seagull-dream/src/creatures/animation.js";
import {
  convexHull2D,
  supportMargin,
  balanceShift,
} from "../../games/seagull-dream/src/creatures/balance.js";

const SEEDS = [1, 2, 42, 1337, 0xCAFE, 987654321];

describe("blueprint: validate + clamp", () => {
  it("default blueprint validates", () => {
    const r = validateBlueprint(defaultBlueprint());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rejects non-objects and structurally impossible input", () => {
    expect(validateBlueprint(null).ok).toBe(false);
    expect(validateBlueprint(42).ok).toBe(false);
    expect(validateBlueprint([]).ok).toBe(false);
    expect(validateBlueprint({}).ok).toBe(false);
    expect(validateBlueprint({ version: 2 }).ok).toBe(false);
  });

  it("flags out-of-range and wrong-typed fields with paths", () => {
    const g = defaultBlueprint() as unknown as Record<string, Record<string, unknown>>;
    g.spine.girth = 99;
    g.head.eyePairs = "two";
    const r = validateBlueprint(g);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith("spine.girth"))).toBe(true);
    expect(r.errors.some((e) => e.startsWith("head.eyePairs"))).toBe(true);
  });

  it("clamp turns LLM-grade garbage into a valid blueprint", () => {
    const garbage = {
      version: 1,
      spine: { torsoSegments: 999, torsoLengthM: -5, girth: "fat", girthPeak: NaN },
      neck: "long",
      head: { sizeFrac: 100, eyePairs: 7.3 },
      limbGroups: new Array(10).fill({ count: 99, stationStart: 2, segments: 0, placement: "spiral" }),
      skin: { baseColor: "blue", bellyColor: "#GGGGGG" },
      posture: null,
    };
    const clamped = clampBlueprint(garbage);
    const r = validateBlueprint(clamped);
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
    const clamped = clampBlueprint({
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
    expect(validateBlueprint(clamped).ok).toBe(true);
    // A non-array profile becomes empty, not invalid.
    expect(clampBlueprint({ version: 1, spine: { profile: "waist" } }).spine.profile).toEqual([]);
    expect(clampBlueprint({ version: 1, spine: {} }).spine.profile).toEqual([]);
  });

  it("clamp is idempotent", () => {
    const once = clampBlueprint({ version: 1, spine: { girth: 99 } });
    const twice = clampBlueprint(once);
    expect(twice).toEqual(once);
  });

  it("clamp preserves in-range values untouched", () => {
    const g = defaultBlueprint();
    expect(clampBlueprint(g)).toEqual(g);
  });
});

describe("blueprint: seeded random producer", () => {
  it("is deterministic per seed", () => {
    for (const seed of SEEDS) {
      expect(randomBlueprint(seed)).toEqual(randomBlueprint(seed));
    }
  });

  it("differs across seeds", () => {
    expect(randomBlueprint(1)).not.toEqual(randomBlueprint(2));
  });

  it("always emits a validateBlueprint-passing blueprint", () => {
    for (const seed of SEEDS) {
      const r = validateBlueprint(randomBlueprint(seed));
      expect(r.errors).toEqual([]);
    }
  });
});

describe("lab examples", () => {
  it("every showcase blueprint clamps to a valid, buildable creature", () => {
    expect(CREATURE_EXAMPLES.length).toBeGreaterThan(0);
    for (const ex of CREATURE_EXAMPLES) {
      const clamped = clampBlueprint(ex.blueprint);
      const r = validateBlueprint(clamped);
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
    const g = defaultBlueprint();
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
    const g = defaultBlueprint();
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
  it("is deterministic for the same blueprint", () => {
    for (const seed of SEEDS) {
      const g = randomBlueprint(seed);
      expect(buildSkeleton(g)).toEqual(buildSkeleton(g));
    }
  });

  it("produces finite, positively-sized bones with valid parent links", () => {
    for (const seed of SEEDS) {
      const skel = buildSkeleton(randomBlueprint(seed));
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
      const skel = buildSkeleton(randomBlueprint(seed));
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
      const g = randomBlueprint(seed);
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
    const g = defaultBlueprint();
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
      const g = defaultBlueprint();
      g.limbGroups.forEach((grp) => {
        grp.count = 1;
        grp.footLengthFrac = 0.3;
        grp.stance = stance;
        // Tight ankle range so the joint's anatomical window follows its
        // rest. With a free range, the load term (deliberately) rides the
        // ankle to max pitch at ANY stance — emergent, but it leaves this
        // comparison to millimeter noise.
        grp.ankleRange = 0.2;
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
    const archLeg: LimbGroupBlueprint = {
      placement: "bilateral",
      count: 1, stationStart: 0.5, stationEnd: 0.5, sizePeak: 1, sizeContrast: 0,
      lengthFrac: 0.9, radiusFrac: 0.1, taper: 0.6,
      membrane: 0, attachHeight: 0.4, restProtraction: 0, restLevation: 0.3, restFlexion: 0,
      flexRange: 1, legTwist: 0, legBalance: 0,
      footLengthFrac: 0.1, stance: 0.8, ankleRange: 1, toeCount: 1, toeLengthFrac: 0.3, toeSpread: 0,
      toeContrast: 0, opposition: 0, toeCurl: 0,
    };
    const kneePeak = (restLevation: number): { peak: number; hipY: number } => {
      const g = defaultBlueprint();
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
      const g = defaultBlueprint();
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
      const g = defaultBlueprint();
      g.posture.bodyHeight = 0.5;
      g.limbGroups = [{ ...g.limbGroups[0], count: 1, stationStart: 0.5, stationEnd: 0.5, restLevation }];
      const foot = buildSkeleton(g).bones.find((b) => b.id === "limb0Lfoot")!;
      return Math.abs(foot.head.x); // ankle lateral offset from the centerline
    };
    expect(footX(0.3)).toBeGreaterThan(footX(-0.5) + 0.02);
  });

  it("restProtraction swings both legs the same way (mirror-symmetric, not one fore/one aft)", () => {
    const feet = (restProtraction: number) => {
      const g = defaultBlueprint();
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
      const g = defaultBlueprint();
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
      const g = defaultBlueprint();
      g.posture.bodyHeight = bodyHeight;
      g.limbGroups = [{ ...g.limbGroups[0], stance: 0.15, footLengthFrac: 0.28, ankleRange: 1 }];
      const foot = buildSkeleton(g).bones.find((b) => b.id === "limb0Lfoot")!;
      return foot.head.y - foot.tail.y; // ankle height above the ground contact (ball)
    };
    expect(ankleRise(1.0)).toBeGreaterThan(ankleRise(0.3) + 0.02);
  });

  it("legTwist rotates a held limb out of its plane (3D curl)", () => {
    const tip = (legTwist: number) => {
      const g = defaultBlueprint();
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
      const g = defaultBlueprint();
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
      const g = defaultBlueprint();
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
    const g = defaultBlueprint();
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
    const g = defaultBlueprint();
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
    const leg: LimbGroupBlueprint = { ...defaultBlueprint().limbGroups[0] };
    const g = defaultBlueprint();
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
    const g = defaultBlueprint();
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
    const g = defaultBlueprint();
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
    const g = defaultBlueprint();
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
    const clamped = clampBlueprint({
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
    expect(validateBlueprint(clamped).ok).toBe(true);
    expect(clampBlueprint({ version: 1 }).chains).toEqual([]);
  });

  it("builds a dorsal midline membrane that rises from the body and tapers at its ends", () => {
    const g = defaultBlueprint();
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
    const g = defaultBlueprint();
    g.membranes = [{ edge: "ventral", start: 0.3, end: 0.7, height: 0.3, heightPeak: 0.5, rays: 0 }];
    const skel = buildSkeleton(g);
    const ribs = skel.membranes[0].ribs;
    for (const r of ribs) expect(r.tip.y).toBeLessThanOrEqual(r.base.y + 1e-9);
  });

  it("clamps membranes: caps count, coerces edge, drops a zero-height web at build", () => {
    const clamped = clampBlueprint({
      version: 1,
      membranes: new Array(9).fill({ edge: "sideways", height: 99, heightPeak: 5, rays: -3 }),
    });
    expect(clamped.membranes.length).toBeLessThanOrEqual(MAX_MEMBRANES);
    for (const m of clamped.membranes) {
      expect(["dorsal", "ventral"]).toContain(m.edge);
      expect(m.height).toBeLessThanOrEqual(1.2);
      expect(m.rays).toBeGreaterThanOrEqual(0);
    }
    expect(validateBlueprint(clamped).ok).toBe(true);
    expect(clampBlueprint({ version: 1 }).membranes).toEqual([]);
    // A zero-height membrane produces no panel.
    const g = defaultBlueprint();
    g.membranes = [{ edge: "dorsal", start: 0.3, end: 0.8, height: 0, heightPeak: 0.5, rays: 0 }];
    expect(buildSkeleton(g).membranes.length).toBe(0);
  });

  it("stays within the limb-group cap from the random producer", () => {
    for (const seed of SEEDS) {
      expect(randomBlueprint(seed).limbGroups.length).toBeLessThanOrEqual(MAX_LIMB_GROUPS);
    }
  });

  it("radial placement spawns `count` ground-solved spokes (no L/R mirror)", () => {
    const g = defaultBlueprint();
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
    const base = defaultBlueprint().limbGroups[0];
    const build = (over: Partial<LimbGroupBlueprint>): ReturnType<typeof buildSkeleton> =>
      buildSkeleton({ ...defaultBlueprint(), limbGroups: [{ ...base, count: 1, footLengthFrac: 0.2, ...over }] });
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
    const leg = defaultBlueprint().limbGroups[0];
    const g = defaultBlueprint();
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
    const clamped = clampBlueprint({ version: 1, limbGroups: new Array(9).fill({ placement: "bilateral" }) });
    expect(clamped.limbGroups.length).toBe(MAX_LIMB_GROUPS);
    expect(validateBlueprint(clamped).ok).toBe(true);
  });

  it("scales with the blueprint (bigger torso → bigger skeleton)", () => {
    const small = defaultBlueprint();
    small.spine.torsoLengthM = 0.3;
    const big = defaultBlueprint();
    big.spine.torsoLengthM = 3;
    const sk1 = buildSkeleton(clampBlueprint(small) as Blueprint);
    const sk2 = buildSkeleton(clampBlueprint(big) as Blueprint);
    const span = (s: typeof sk1) => s.bounds.max.z - s.bounds.min.z;
    expect(span(sk2)).toBeGreaterThan(span(sk1) * 5);
  });

  it("carries body cross-section onto the trunk, easing back to round at the head", () => {
    const g = defaultBlueprint();
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
    expect(clampBlueprint({ version: 1, spine: { crossSection: 99 } }).spine.crossSection).toBeLessThanOrEqual(3);
    expect(clampBlueprint({ version: 1, spine: { crossSection: -5 } }).spine.crossSection).toBeGreaterThanOrEqual(0.3);
    expect(clampBlueprint({ version: 1, spine: {} }).spine.crossSection).toBe(1);
  });

  it("emits head parts: a lofted snout chain and the blueprint's eye pairs", () => {
    const g = defaultBlueprint();
    const skel = buildSkeleton(g);
    // The muzzle/beak is real loft bones now, not a rigid cone detail. The
    // "snout" chain is the upper jaw = forehead bridge bones + the snout proper.
    expect(skel.bones.filter((b) => b.id.startsWith("snout")).length).toBe(2);
    expect(skel.bones.some((b) => b.chain === "snout")).toBe(true);
    expect(skel.details.filter((d) => d.kind === "beak").length).toBe(0);
    const eyes = skel.details.filter((d) => d.kind === "eye");
    expect(eyes.length).toBe(g.head.eyePairs * 2);
    // Eyes mirror across the sagittal plane.
    const xs = eyes.map((e) => e.position.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-xs[xs.length - 1], 9);
    // No snout when the blueprint says none.
    g.head.beakLengthFrac = 0;
    expect(buildSkeleton(g).bones.some((b) => b.chain === "snout")).toBe(false);
  });
});

describe("head variety (braincase + rostrum + mandible skull)", () => {
  const headBone = (skel: ReturnType<typeof buildSkeleton>) =>
    skel.bones.find((b) => b.id === "head")!;
  const boneLen = (b: { head: Vec3; tail: Vec3 }): number =>
    Math.hypot(b.tail.x - b.head.x, b.tail.y - b.head.y, b.tail.z - b.head.z);

  it("lengthFrac elongates the skull bulb; crossSection sets its aspect", () => {
    const g = defaultBlueprint();
    const round = headBone(buildSkeleton(g));
    g.head.lengthFrac = 2;
    g.head.crossSection = 1.6;
    const long = headBone(buildSkeleton(g));
    expect(boneLen(long)).toBeCloseTo(boneLen(round) * 2, 6);
    expect(long.aspect).toBeCloseTo(1.6, 9);
    expect(round.aspect).toBeCloseTo(1, 9);
  });

  it("snoutCurve hooks the snout tip down (and up when negative)", () => {
    const tipY = (curve: number): number => {
      const g = defaultBlueprint();
      g.head.beakLengthFrac = 1.5;
      g.head.snoutCurve = curve;
      const skel = buildSkeleton(g);
      return limbTip(skel, "snout")!.y;
    };
    expect(tipY(0.8)).toBeLessThan(tipY(0) - 1e-3);
    expect(tipY(-0.8)).toBeGreaterThan(tipY(0) + 1e-3);
  });

  it("snoutFlatten reaches the loft as the snout bones' aspect", () => {
    const g = defaultBlueprint();
    g.head.snoutFlatten = 2.0;
    const skel = buildSkeleton(g);
    for (const b of skel.bones.filter((x) => x.id.startsWith("snout"))) {
      expect(b.aspect).toBeCloseTo(2.0, 9);
    }
  });

  it("the rostrum springs from the cranium's LOWER-FRONT, running level", () => {
    // The muzzle is NOT the front of a head tube — it roots below the
    // cranium's front pole and projects forward. With no curve or pitch its
    // first segment runs level (parallel to the braincase axis).
    const g = defaultBlueprint();
    g.head.beakLengthFrac = 1.2;
    g.head.snoutCurve = 0;
    g.head.facePitch = 0;
    const skel = buildSkeleton(g);
    const h = headBone(skel);
    const s = skel.bones.find((b) => b.id === "snout0")!;
    // Roots BELOW the cranium front pole (the lower-front), not at it.
    expect(s.head.y).toBeLessThan(h.tail.y - 1e-4);
    // ...and its axis is level (dead ahead) when uncurved/unpitched.
    const sa = { x: s.tail.x - s.head.x, y: s.tail.y - s.head.y, z: s.tail.z - s.head.z };
    expect(Math.abs(sa.y) / boneLen(s)).toBeLessThan(1e-6);
    expect(sa.z).toBeGreaterThan(0);
  });

  it("neck lift only positions the head — never reshapes it", () => {
    // The head's ORIENTATION and internal shape are invariant to neck lift
    // (lift moves headBase; the head hangs off it at the same angle). This
    // is the decoupling the horse needed.
    const headData = (lift: number) => {
      const g = defaultBlueprint();
      g.head.beakLengthFrac = 1;
      g.neck.lift = lift;
      const skel = buildSkeleton(g);
      const h = headBone(skel);
      const tip = limbTip(skel, "snout")!;
      const dir = { x: h.tail.x - h.head.x, y: h.tail.y - h.head.y, z: h.tail.z - h.head.z };
      const L = boneLen(h);
      return {
        dir: { x: dir.x / L, y: dir.y / L, z: dir.z / L },
        // Snout tip RELATIVE to the head base (shape, not position).
        tipRel: { x: tip.x - h.head.x, y: tip.y - h.head.y, z: tip.z - h.head.z },
        len: L,
      };
    };
    const lo = headData(0.2), hi = headData(1.5);
    expect(hi.dir.y).toBeCloseTo(lo.dir.y, 9); // orientation unchanged
    expect(hi.len).toBeCloseTo(lo.len, 9);      // length unchanged
    expect(hi.tipRel.y).toBeCloseTo(lo.tipRel.y, 9); // shape unchanged
    expect(hi.tipRel.z).toBeCloseTo(lo.tipRel.z, 9);
  });

  it("the lower jaw is a separate cut bone; gape swings it open about the joint", () => {
    const g = defaultBlueprint();
    g.head.mouthOpen = 0;
    // mouthOpen 0 = a fused mouth: the jaw never swings, even at full gape.
    expect(buildSkeleton(g, undefined, { gape: 1 }).mouth!.gapeAngle).toBeCloseTo(0, 9);
    g.head.mouthOpen = 0.7;
    const closed = buildSkeleton(g, undefined, { gape: 0 });
    const open = buildSkeleton(g, undefined, { gape: 1 });
    // A closed mouth doesn't swing (gapeAngle 0); gape swings the lower jaw.
    expect(closed.mouth!.gapeAngle).toBeCloseTo(0, 9);
    expect(open.mouth!.gapeAngle).toBeGreaterThan(0.3);
    // The lower jaw is a SEPARATE "jaw" chain (upper jaw is the "snout" chain).
    expect(open.bones.some((b) => b.chain === "jaw")).toBe(true);
    expect(open.bones.some((b) => b.id === "ramus0")).toBe(true); // links to the skull
    // The jaw joint sits BELOW the eyes (the mandible hangs below it).
    const eye = open.details.find((d) => d.kind === "eye")!;
    expect(open.mouth!.hinge.y).toBeLessThan(eye.position.y);
  });

  it("mouthOpen scales how WIDE the (rigid) jaw can swing", () => {
    // With a hinged mandible the jaw always spans the full bite line; a
    // bigger mouthOpen lets it swing WIDER (a horse barely opens, a croc
    // opens all the way). Measured at full gape.
    const gapeAt = (mouthOpen: number): number => {
      const g = defaultBlueprint();
      g.head.beakLengthFrac = 1.6;
      g.head.mouthOpen = mouthOpen;
      return buildSkeleton(g, undefined, { gape: 1 }).mouth!.gapeAngle;
    };
    expect(gapeAt(1)).toBeGreaterThan(gapeAt(0.3) + 0.1); // croc opens far wider than a horse
  });

  it("the nose is its OWN feature, positioned independently of the muzzle", () => {
    const g = defaultBlueprint();
    expect(buildSkeleton(g).bones.some((b) => b.chain === "nose")).toBe(false);
    g.head.noseLengthFrac = 1.5;
    g.head.noseSegments = 4;
    const skel = buildSkeleton(g);
    const noseBones = skel.bones.filter((b) => b.chain === "nose");
    expect(noseBones.length).toBe(4);
    // The nose is stuck on the snout tip; noseHeight slides its root UP toward
    // the crown (a blowhole on top vs a nose on the front of the face).
    const rootY = (noseHeight: number): number => {
      const g2 = defaultBlueprint();
      g2.head.noseLengthFrac = 1; g2.head.beakLengthFrac = 1.5; g2.head.noseHeight = noseHeight;
      return buildSkeleton(g2).bones.find((b) => b.id === "nose0")!.head.y;
    };
    expect(rootY(1)).toBeGreaterThan(rootY(0) + 0.02); // higher root when noseHeight is up top
  });

  it("eyeHeight climbs the eyes toward the crown; eyeBulge pushes them proud", () => {
    const eye = (patch: Partial<Blueprint["head"]>) => {
      const g = defaultBlueprint();
      Object.assign(g.head, patch);
      const skel = buildSkeleton(g);
      const e = skel.details.filter((d) => d.kind === "eye")[0]!;
      const h = headBone(skel);
      const c = {
        x: (h.head.x + h.tail.x) / 2,
        y: (h.head.y + h.tail.y) / 2,
        z: (h.head.z + h.tail.z) / 2,
      };
      return {
        y: e.position.y,
        fromCenter: Math.hypot(e.position.x - c.x, e.position.y - c.y, e.position.z - c.z),
      };
    };
    expect(eye({ eyeHeight: 1.0 }).y).toBeGreaterThan(eye({ eyeHeight: 0 }).y + 1e-3);
    expect(eye({ eyeBulge: 1 }).fromCenter).toBeGreaterThan(eye({ eyeBulge: 0 }).fromCenter + 1e-3);
  });

  it("a round skull holds its face at the horizon; facePitch tips the carriage", () => {
    // Default quadruped with a lifted neck: the snout points dead level
    // (elevation 0) by rule, and facePitch offsets from there.
    const tipYAt = (facePitch: number): number => {
      const g = defaultBlueprint();
      g.head.facePitch = facePitch;
      return limbTip(buildSkeleton(g), "snout")!.y;
    };
    const level = (): { dy: number } => {
      const g = defaultBlueprint();
      const skel = buildSkeleton(g);
      const s = skel.bones.find((b) => b.id === "snout0")!;
      return { dy: (s.tail.y - s.head.y) / Math.hypot(s.tail.x - s.head.x, s.tail.y - s.head.y, s.tail.z - s.head.z) };
    };
    expect(Math.abs(level().dy)).toBeLessThan(1e-9);
    expect(tipYAt(0.5)).toBeGreaterThan(tipYAt(0) + 1e-3);
    expect(tipYAt(-0.5)).toBeLessThan(tipYAt(0) - 1e-3);
  });

  it("faceHeight moves the eyes down the face (cranium rises above)", () => {
    const eyeY = (faceHeight: number): number => {
      const g = defaultBlueprint();
      g.head.faceHeight = faceHeight;
      return buildSkeleton(g).details.filter((d) => d.kind === "eye")[0]!.position.y;
    };
    // Lower faceHeight → eyes sit lower on the skull (more dome above).
    expect(eyeY(-0.8)).toBeLessThan(eyeY(0) - 1e-3);
    expect(eyeY(0.8)).toBeGreaterThan(eyeY(0) + 1e-3);
  });

  it("snoutRadiusFrac sets the muzzle girth directly", () => {
    const baseR = (frac: number): number => {
      const g = defaultBlueprint();
      g.head.snoutRadiusFrac = frac;
      return buildSkeleton(g).bones.find((b) => b.id === "snout0")!.radiusHead;
    };
    expect(baseR(0.2) / baseR(0.4)).toBeCloseTo(0.5, 6);
  });

  it("snoutSegments builds the muzzle from N bones (a bendable trunk)", () => {
    const segs = (n: number): number => {
      const g = defaultBlueprint();
      g.head.snoutSegments = n;
      g.head.beakLengthFrac = 2;
      return buildSkeleton(g).bones.filter((b) => b.id.startsWith("snout")).length;
    };
    expect(segs(2)).toBe(2);
    expect(segs(6)).toBe(6);
  });

  it("muzzleSquash keeps the muzzle tip blunt instead of tapering to a point", () => {
    const tipR = (squash: number): number => {
      const g = defaultBlueprint();
      g.head.muzzleSquash = squash;
      g.head.beak = 0;
      const snout = buildSkeleton(g).bones.filter((b) => b.id.startsWith("snout"));
      return snout[snout.length - 1].radiusTail;
    };
    expect(tipR(1)).toBeGreaterThan(tipR(0) * 1.8);
  });

  it("the human example reads as a face: a separate nose, mouth below eyes, cranium above", () => {
    const g = clampBlueprint(CREATURE_EXAMPLES.find((e) => e.name.startsWith("Human"))!.blueprint);
    const skel = buildSkeleton(g);
    const h = skel.bones.find((b) => b.id === "head")!;
    const eye = skel.details.filter((d) => d.kind === "eye")[0]!;
    // The nose is its OWN protrusion (not the muzzle), a thin bump.
    const nose = skel.bones.filter((b) => b.chain === "nose");
    expect(nose.length).toBeGreaterThan(0);
    expect(nose[0].radiusHead).toBeLessThan(0.3 * h.radiusHead);
    // It protrudes forward of the muzzle front (a nose that sticks out).
    const noseTip = nose[nose.length - 1].tail;
    expect(noseTip.z).toBeGreaterThan(h.tail.z);
    // The mouth seam sits below the eyes.
    expect(skel.mouth).toBeDefined();
    expect(eye.position.y).toBeGreaterThan(skel.mouth!.hinge.y);
    // Cranium: a good dome of skull rises above the eye line.
    const topY = Math.max(h.head.y, h.tail.y) + h.radiusHead;
    expect(topY - eye.position.y).toBeGreaterThan(0.4 * h.radiusHead);
  });

  it("eyes seat on the skull's ellipsoid surface (not floating, not buried)", () => {
    const g = defaultBlueprint();
    g.head.lengthFrac = 1.8;
    g.head.crossSection = 1.5;
    g.head.eyeHeight = 0.6;
    const skel = buildSkeleton(g);
    const h = headBone(skel);
    const c = {
      x: (h.head.x + h.tail.x) / 2,
      y: (h.head.y + h.tail.y) / 2,
      z: (h.head.z + h.tail.z) / 2,
    };
    const eyeR = g.head.eyeSizeFrac * h.radiusHead;
    for (const e of skel.details.filter((d) => d.kind === "eye")) {
      const d = Math.hypot(e.position.x - c.x, e.position.y - c.y, e.position.z - c.z);
      // Within an eye radius of the surface band the seat formula allows
      // (the face-frame ellipsoid is a stand-in for the loft's exact hull).
      const rMin = h.radiusHead / Math.sqrt(1.5) - eyeR * 1.5;
      const rMax = h.radiusHead * g.head.lengthFrac + eyeR * 1.5;
      expect(d).toBeGreaterThan(rMin);
      expect(d).toBeLessThan(rMax);
    }
  });

  it("braincaseDome raises the cranium without moving the muzzle", () => {
    const dome = (d: number) => {
      const g = defaultBlueprint();
      g.head.braincaseDome = d;
      const skel = buildSkeleton(g);
      return { crownY: skel.head!.crown.y, domeHalf: skel.head!.domeHalf, tipZ: limbTip(skel, "snout")!.z };
    };
    const lo = dome(0.7), hi = dome(1.3);
    expect(hi.domeHalf).toBeGreaterThan(lo.domeHalf);
    expect(hi.crownY).toBeGreaterThan(lo.crownY + 1e-3); // a taller skull vault
    expect(hi.tipZ).toBeCloseTo(lo.tipZ, 6); // the muzzle is untouched
  });

  it("facePitch tips the ROSTRUM off the braincase, leaving the braincase level", () => {
    // The braincase holds the horizon at any facePitch (its bone stays
    // level); only the muzzle hinges.
    const braincaseDir = (fp: number): number => {
      const g = defaultBlueprint();
      g.head.facePitch = fp;
      const h = headBone(buildSkeleton(g));
      return (h.tail.y - h.head.y) / boneLen(h);
    };
    expect(Math.abs(braincaseDir(0))).toBeLessThan(1e-9);
    expect(Math.abs(braincaseDir(0.6))).toBeLessThan(1e-9);
    const tipY = (fp: number): number => {
      const g = defaultBlueprint();
      g.head.beakLengthFrac = 1.4;
      g.head.facePitch = fp;
      return limbTip(buildSkeleton(g), "snout")!.y;
    };
    expect(tipY(0.6)).toBeGreaterThan(tipY(0) + 1e-3); // +pitch lifts the muzzle
  });

  it("jawDepth deepens the lower jaw (a thicker mandible)", () => {
    // The lower jaw is a separate bone whose rings are the muzzle shape
    // deepened by jawDepth, so a deeper jaw = a bigger jaw-body radius.
    const jawR = (jawDepth: number): number => {
      const g = defaultBlueprint();
      g.head.beakLengthFrac = 1;
      g.head.mouthOpen = 0.6;
      g.head.jawDepth = jawDepth;
      return buildSkeleton(g).bones.find((x) => x.id === "jaw0")!.radiusHead;
    };
    expect(jawR(0.4)).toBeGreaterThan(jawR(0.05));
  });

  it("mouthVertical slides the mouth (bite) line down (subterminal) or up (superior)", () => {
    const bite = (mv: number): number => {
      const g = defaultBlueprint();
      g.head.beakLengthFrac = 1;
      g.head.mouthOpen = 0.7;
      g.head.mouthVertical = mv;
      return buildSkeleton(g).mouth!.biteFrac;
    };
    expect(bite(-1)).toBeLessThan(bite(0));
    expect(bite(1)).toBeGreaterThan(bite(0));
  });

  it("eyeAngle (orbit convergence) spreads the eyes frontal → lateral", () => {
    const spread = (ang: number): number => {
      const g = defaultBlueprint();
      g.head.eyeAngle = ang;
      const eyes = buildSkeleton(g).details.filter((d) => d.kind === "eye");
      return Math.abs(eyes[0]!.position.x);
    };
    expect(spread(1.3)).toBeGreaterThan(spread(0.3) + 1e-3);
  });

  it("exposes skull landmarks + a level frame for the soft-tissue layer", () => {
    const g = defaultBlueprint();
    g.head.beakLengthFrac = 1.2;
    const skel = buildSkeleton(g);
    expect(skel.head).toBeDefined();
    // rostrum tip is forward of the braincase front, which is forward of center.
    expect(skel.head!.rostrumTip.z).toBeGreaterThan(skel.head!.rostrumBase.z);
    expect(skel.head!.rostrumBase.z).toBeGreaterThan(skel.head!.center.z);
    // The braincase frame is world-aligned (level head).
    expect(skel.head!.braincaseAxis.z).toBeCloseTo(1, 9);
    expect(skel.head!.up.y).toBeCloseTo(1, 9);
  });

  it("mouthOpen places the commissure: cheek-flagged stations close the jaw behind it", () => {
    // The VISIBLE mouth is smaller than the mandible's gape: only stations
    // forward of the commissure (mouthOpen = lips-part fraction from the
    // tip) open; the rest are cheek-covered (a horse's long closed jaw).
    const skullFor = (mouthOpen: number) => {
      const g = defaultBlueprint();
      g.head.beakLengthFrac = 1.5;
      g.head.snoutSegments = 4;
      g.head.mouthOpen = mouthOpen;
      return buildSkeleton(g).skull!;
    };
    const stationsFor = (mouthOpen: number) => {
      const sk = skullFor(mouthOpen);
      return sk.stations.slice(sk.muzzleFrom);
    };
    // 5 joints (fTip = 1, .75, .5, .25, 0) + the SLIDING corner ring
    // inserted at exactly 0.3 — the commissure moves continuously, it
    // does not snap between segments.
    const horse = stationsFor(0.3);
    expect(horse.length).toBe(6);
    expect(horse[0].cheek).toBe(true); // jaw root always cheek-covered
    expect(horse[horse.length - 1].cheek).toBe(false); // tip parts
    expect(horse.filter((s) => s.cheek).length).toBe(4); // joints 1,.75,.5 + corner
    // A croc-style full split (corner exactly at the root): no insert,
    // only the root corner stays covered…
    const croc = stationsFor(1);
    expect(croc.length).toBe(5);
    expect(croc.filter((s) => s.cheek).length).toBe(1);
    // …and a fused mouth (mouthOpen 0) is cheek all the way to the tip.
    const fused = stationsFor(0);
    expect(fused.every((s) => s.cheek)).toBe(true);
    // Past 1 the corner slides BEHIND the root along the jawline toward
    // the hinge (snake/croc whole-head gape): every muzzle station opens
    // and the guide exposes the corner's longitudinal position.
    const snake = skullFor(1.4);
    const snakeSts = snake.stations.slice(snake.muzzleFrom);
    expect(snakeSts.every((s) => s.cheek === false)).toBe(true);
    expect(snake.mouthCorner).toBeDefined();
    expect(snake.mouthCorner!.z).toBeLessThan(snakeSts[0].center.z);
    // Deeper mouthOpen → the corner sits further back.
    const snake2 = skullFor(1.2);
    expect(snake.mouthCorner!.z).toBeLessThan(snake2.mouthCorner!.z);
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
    const g = defaultBlueprint();
    const restY = buildSkeleton(g).bones.find((b) => b.id === "limb0Lfoot")!.tail.y;
    const gait: GaitParams = { phase: 0.8, strideFrac: 0.5, stepHeight: 0.3, dutyFactor: 0.6, pattern: "trot" };
    const walk = buildSkeleton(g, gait);
    const swing = walk.bones.find((b) => b.id === "limb0Lfoot")!;
    const stance = walk.bones.find((b) => b.id === "limb0Rfoot")!;
    expect(swing.tail.y).toBeGreaterThan(restY + 0.03); // lifted off the ground
    expect(stance.tail.y).toBeLessThan(swing.tail.y); // its diagonal partner stays down
  });

  it("the gait is deterministic for the same blueprint + params", () => {
    const g = defaultBlueprint();
    const gait: GaitParams = { ...DEFAULT_GAIT, phase: 0.37 };
    const a = buildSkeleton(g, gait).bones.map((b) => b.tail.y);
    const b = buildSkeleton(g, gait).bones.map((b) => b.tail.y);
    expect(a).toEqual(b);
  });

  it("with no gait the rest pose is unchanged (gait is purely additive)", () => {
    const g = defaultBlueprint();
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
    const g = defaultBlueprint();
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

// ── Animation layer: gait selection, pose overrides, the animator ────────

const humanBlueprint = (): Blueprint =>
  clampBlueprint(CREATURE_EXAMPLES.find((e) => e.name.startsWith("Human"))!.blueprint);

const raptorBlueprint = (): Blueprint =>
  clampBlueprint(CREATURE_EXAMPLES.find((e) => e.name.startsWith("Winged biped"))!.blueprint);

/** Drive the animator the way the lab does: update → build → observe. */
function runAnim(
  anim: CreatureAnimator,
  g: Blueprint,
  seconds: number,
  cb?: (frame: AnimFrame, skel: ReturnType<typeof buildSkeleton>) => void,
): void {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    const frame = anim.update(dt);
    const scratch: Blueprint = { ...g, posture: { ...frame.posture } };
    const skel = buildSkeleton(scratch, frame.gait, frame.pose);
    anim.observe(skel);
    cb?.(frame, skel);
  }
}

describe("gait selection (locomotionGait)", () => {
  it("slow speeds walk (duty > 0.5), fast speeds run (duty < 0.5)", () => {
    expect(locomotionGait(0.1, 0.8).dutyFactor).toBeGreaterThan(0.5);
    expect(locomotionGait(1, 0.8).dutyFactor).toBeLessThan(0.5);
  });

  it("stride, lift, cadence and ground speed all grow with the dial", () => {
    const lo = locomotionGait(0.2, 0.8);
    const hi = locomotionGait(0.9, 0.8);
    expect(hi.strideFrac).toBeGreaterThan(lo.strideFrac);
    expect(hi.stepHeight).toBeGreaterThan(lo.stepHeight);
    expect(hi.cadenceHz).toBeGreaterThan(lo.cadenceHz);
    expect(hi.speedMps).toBeGreaterThan(lo.speedMps);
  });

  it("longer legs cycle slower at the same dial (pendulum scaling)", () => {
    expect(locomotionGait(0.5, 2.0).cadenceHz).toBeLessThan(locomotionGait(0.5, 0.5).cadenceHz);
  });

  it("a running gait bobs harder than a walking one", () => {
    const at = (duty: number): number =>
      bodyBob({ phase: 0.25, strideFrac: 0.5, stepHeight: 0.2, dutyFactor: duty, pattern: "trot" }, 2).dy;
    expect(at(0.35)).toBeGreaterThan(at(0.65));
  });
});

describe("pose overrides (reach IK + arm swing)", () => {
  it("limbChainName names the human's limbs the way the skeleton builds them", () => {
    const g = humanBlueprint();
    expect(limbChainName(g, 0, 0, -1)).toBe("limb0L"); // legs
    expect(limbChainName(g, 1, 0, 1)).toBe("limb1R"); // arms
    const skel = buildSkeleton(g);
    expect(limbTip(skel, "limb1R")).not.toBeNull();
    expect(limbTip(skel, "limb1L")).not.toBeNull();
  });

  it("a limb-target override brings the hand tip to the target", () => {
    const g = humanBlueprint();
    const rest = buildSkeleton(g);
    const shoulder = rest.bones.find((b) => b.chain === "limb1R")!.head;
    // A point in front of the chest, well inside the arm's reach.
    const target: Vec3 = { x: shoulder.x, y: shoulder.y - 0.2, z: shoulder.z + 0.3 };
    const skel = buildSkeleton(g, undefined, {
      limbTargets: [{ group: 1, index: 0, side: 1, target, grip: 0.8 }],
    });
    const tip = limbTip(skel, "limb1R")!;
    const d = Math.hypot(tip.x - target.x, tip.y - target.y, tip.z - target.z);
    expect(d).toBeLessThan(0.05);
    // The other arm is untouched (still hanging near its rest position).
    const restL = limbTip(rest, "limb1L")!;
    const stillL = limbTip(skel, "limb1L")!;
    expect(Math.hypot(stillL.x - restL.x, stillL.y - restL.y, stillL.z - restL.z)).toBeLessThan(1e-9);
  });

  it("an unreachable target is approached along the reach line, not overshot", () => {
    const g = humanBlueprint();
    const target: Vec3 = { x: 3, y: 1.2, z: 3 }; // meters away
    const skel = buildSkeleton(g, undefined, {
      limbTargets: [{ group: 1, index: 0, side: 1, target }],
    });
    const tip = limbTip(skel, "limb1R")!;
    const shoulder = skel.bones.find((b) => b.chain === "limb1R")!.head;
    const armLen = g.limbGroups[1].lengthFrac * g.spine.torsoLengthM * 1.2; // + palm slack
    expect(Math.hypot(tip.x - shoulder.x, tip.y - shoulder.y, tip.z - shoulder.z)).toBeLessThan(armLen);
  });

  it("a planted foot keeps its facing through the stride (no outward twist)", () => {
    // The foot azimuth is solved in the unshifted rest frame, so neither
    // the stride nor the balance sway may rotate a planted foot. Front-left
    // (trot offset 0) stays planted for phase < duty; sample early vs late
    // stance and compare the foot bone's horizontal direction.
    const g = defaultBlueprint();
    const azimuthAt = (phase: number): number => {
      const gait: GaitParams = { phase, strideFrac: 0.6, stepHeight: 0.25, dutyFactor: 0.6, pattern: "trot" };
      const foot = buildSkeleton(g, gait).bones.find((b) => b.id === "limb0Lfoot")!;
      return Math.atan2(foot.tail.x - foot.head.x, foot.tail.z - foot.head.z);
    };
    expect(Math.abs(azimuthAt(0.05) - azimuthAt(0.5))).toBeLessThan(1e-6);
  });

  it("the body does not lurch with the step cycle (balance over rest support)", () => {
    // The support polygon is every recruited foot at its rest plant, so the
    // horizontal body position is identical at every gait phase — only the
    // vertical bob varies. Chasing the planted subset used to sway the body
    // fore/aft and sideways every step.
    const g = humanBlueprint();
    const torsoAt = (phase: number): Vec3 => {
      const gait: GaitParams = { phase, strideFrac: 0.6, stepHeight: 0.25, dutyFactor: 0.6, pattern: "trot" };
      return buildSkeleton(g, gait).bones.find((b) => b.id === "torso0")!.head;
    };
    const a = torsoAt(0.1);
    const b = torsoAt(0.35); // opposite single-support half of the cycle
    expect(Math.abs(a.x - b.x)).toBeLessThan(1e-9);
    expect(Math.abs(a.z - b.z)).toBeLessThan(1e-9);
  });

  it("hanging arms counter-swing with the gait, in antiphase", () => {
    const g = humanBlueprint();
    const gait: GaitParams = { phase: 0.25, strideFrac: 0.5, stepHeight: 0.2, dutyFactor: 0.6, pattern: "trot" };
    const still = buildSkeleton(g, gait);
    const swung = buildSkeleton(g, gait, { armSwing: 0.5 });
    const dzR = limbTip(swung, "limb1R")!.z - limbTip(still, "limb1R")!.z;
    const dzL = limbTip(swung, "limb1L")!.z - limbTip(still, "limb1L")!.z;
    expect(Math.abs(dzR)).toBeGreaterThan(0.05); // the swing visibly moves the hand
    expect(Math.sign(dzR)).toBe(-Math.sign(dzL)); // arms alternate
    // The legs are unaffected by armSwing (they are recruited, gait-driven).
    expect(limbTip(swung, "limb0R")!.z).toBeCloseTo(limbTip(still, "limb0R")!.z, 9);
  });
});

describe("creature animator (stand / walk / run / pick up / put down)", () => {
  it("picks the human's arms as the grasping hand group", () => {
    expect(pickHandGroup(humanBlueprint())).toBe(1);
    expect(pickHandGroup(defaultBlueprint())).toBe(-1); // a plain quadruped can't grasp
  });

  it("stands at speed 0 (no gait), walks then runs as the dial rises", () => {
    const g = humanBlueprint();
    const anim = new CreatureAnimator(g);
    let frame = anim.update(1 / 60);
    expect(frame.gait).toBeUndefined();
    expect(frame.speedMps).toBe(0);
    anim.setSpeed(0.35);
    runAnim(anim, g, 1.0, (f) => { frame = f; });
    expect(frame.gait).toBeDefined();
    const walkDuty = frame.gait!.dutyFactor;
    expect(walkDuty).toBeGreaterThan(0.5);
    anim.setSpeed(1);
    runAnim(anim, g, 2.0, (f) => { frame = f; });
    expect(frame.gait!.dutyFactor).toBeLessThan(0.5); // flight phases
    expect(frame.speedMps).toBeGreaterThan(0.5);
    // Running leans the trunk forward of its standing pitch.
    expect(frame.posture.bodyPitch).toBeLessThan(g.posture.bodyPitch);
  });

  it("the animator is deterministic for the same inputs", () => {
    const g = humanBlueprint();
    const run = (): string => {
      const anim = new CreatureAnimator(g);
      anim.setSpeed(0.6);
      let last: AnimFrame | null = null;
      runAnim(anim, g, 0.8, (f) => { last = f; });
      return JSON.stringify(last);
    };
    expect(run()).toBe(run());
  });

  it("picks up: crouches to the object, grips it, and carries it back up", () => {
    const g = humanBlueprint();
    const L = g.spine.torsoLengthM;
    const legLen = g.limbGroups[0].lengthFrac * L;
    const object: Vec3 = { x: 0.3 * L, y: 0.05, z: 0.45 * L };
    const anim = new CreatureAnimator(g);
    runAnim(anim, g, 0.5); // settle, capture the resting hand
    expect(anim.pickUp(object)).toBe(true);
    expect(anim.pickUp(object)).toBe(false); // one action at a time

    let minHeight = Infinity;
    let minGrabDist = Infinity;
    let sawHold = false;
    let carryFrame: AnimFrame | null = null;
    runAnim(anim, g, 4.0, (f, skel) => {
      minHeight = Math.min(minHeight, f.posture.bodyHeight);
      if (f.action === "grasp" && f.handChain) {
        const tip = limbTip(skel, f.handChain);
        if (tip) {
          minGrabDist = Math.min(minGrabDist,
            Math.hypot(tip.x - object.x, tip.y - object.y, tip.z - object.z));
        }
      }
      if (f.action === "carry") { sawHold = f.holding; carryFrame = f; }
    });
    expect(anim.currentAction).toBe("carry");
    expect(sawHold).toBe(true);
    // It crouched to reach the ground-level object…
    expect(minHeight).toBeLessThan(g.posture.bodyHeight * 0.5);
    // …the hand actually closed on it…
    expect(minGrabDist).toBeLessThan(0.12 * legLen);
    // …and it stood back up to carry.
    expect(carryFrame!.posture.bodyHeight).toBeGreaterThan(g.posture.bodyHeight * 0.8);
  });

  it("puts down: releases the object and returns to a clean stand", () => {
    const g = humanBlueprint();
    const L = g.spine.torsoLengthM;
    const object: Vec3 = { x: 0.3 * L, y: 0.05, z: 0.45 * L };
    const anim = new CreatureAnimator(g);
    runAnim(anim, g, 0.5);
    anim.pickUp(object);
    runAnim(anim, g, 4.0);
    expect(anim.currentAction).toBe("carry");
    expect(anim.putDown({ x: -0.3 * L, y: 0.05, z: 0.45 * L })).toBe(true);
    let lastHolding = true;
    runAnim(anim, g, 4.0, (f) => { lastHolding = f.holding; });
    expect(anim.currentAction).toBe("none");
    expect(lastHolding).toBe(false);
    const rest = anim.update(1 / 60);
    expect(rest.pose.limbTargets).toBeUndefined(); // the arm is FK again
    expect(rest.posture.bodyHeight).toBeGreaterThan(g.posture.bodyHeight * 0.85);
  });

  it("can walk while carrying (gait + hand target compose)", () => {
    const g = humanBlueprint();
    const L = g.spine.torsoLengthM;
    const anim = new CreatureAnimator(g);
    runAnim(anim, g, 0.5);
    anim.pickUp({ x: 0.3 * L, y: 0.05, z: 0.45 * L });
    runAnim(anim, g, 4.0);
    anim.setSpeed(0.5);
    let frame: AnimFrame | null = null;
    runAnim(anim, g, 1.5, (f) => { frame = f; });
    expect(frame!.action).toBe("carry");
    expect(frame!.gait).toBeDefined();
    expect(frame!.holding).toBe(true);
    expect(frame!.pose.limbTargets).toHaveLength(1);
  });

  it("a large object takes both hands, bracketing it from opposite sides", () => {
    const g = humanBlueprint();
    const L = g.spine.torsoLengthM;
    const size = 0.28; // well past a palm-width
    const object: Vec3 = { x: 0.1 * L, y: size / 2, z: 0.45 * L };
    const anim = new CreatureAnimator(g);
    runAnim(anim, g, 0.5);
    expect(anim.pickUp(object, size)).toBe(true);
    let bracketOk = false;
    let carryFrame: AnimFrame | null = null;
    runAnim(anim, g, 5.0, (f, skel) => {
      if (f.action === "grasp" && f.handChains?.length === 2) {
        const [l, r] = f.handChains.map((c) => limbTip(skel, c)!);
        // Palms on opposite sides of the object, about a size apart.
        if (l && r && r.x - l.x > size * 0.6 &&
          Math.abs((l.x + r.x) / 2 - object.x) < 0.15) bracketOk = true;
      }
      if (f.action === "carry") carryFrame = f;
    });
    expect(anim.currentAction).toBe("carry");
    expect(bracketOk).toBe(true);
    expect(carryFrame!.holding).toBe(true);
    expect(carryFrame!.pose.limbTargets).toHaveLength(2);
    expect(carryFrame!.handChains).toEqual(["limb1L", "limb1R"]);
  });

  it("a thumbless kind lifts with two hands (palms are the pincer)", () => {
    const g = humanBlueprint();
    g.limbGroups[1].opposition = 0; // no thumbs
    expect(pickHandGroup(g)).toBe(-1); // one hand can't grip…
    expect(pickArmGroup(g)).toBe(1); // …but the free forelimb pair can
    const L = g.spine.torsoLengthM;
    const anim = new CreatureAnimator(g);
    expect(anim.hasHands()).toBe(true);
    runAnim(anim, g, 0.5);
    // Even a small object goes two-handed without opposable digits.
    expect(anim.pickUp({ x: 0.2 * L, y: 0.05, z: 0.45 * L }, 0.08)).toBe(true);
    let frame: AnimFrame | null = null;
    runAnim(anim, g, 5.0, (f) => { frame = f; });
    expect(anim.currentAction).toBe("carry");
    expect(frame!.pose.limbTargets).toHaveLength(2);
    // A plain quadruped still can't pick things up either way.
    expect(pickArmGroup(defaultBlueprint())).toBe(-1);
  });

  it("bulk slows the lift (size-scaled timeline)", () => {
    const g = humanBlueprint();
    const L = g.spine.torsoLengthM;
    const liftTime = (size: number): number => {
      const anim = new CreatureAnimator(g);
      runAnim(anim, g, 0.5);
      anim.pickUp({ x: 0.2 * L, y: Math.max(0.05, size / 2), z: 0.45 * L }, size);
      let tLiftStart = -1, tCarry = -1, t = 0;
      runAnim(anim, g, 8.0, (f) => {
        t += 1 / 60;
        if (f.action === "lift" && tLiftStart < 0) tLiftStart = t;
        if (f.action === "carry" && tCarry < 0) tCarry = t;
      });
      return tCarry - tLiftStart;
    };
    expect(liftTime(0.4)).toBeGreaterThan(liftTime(0.0) + 0.15);
  });

  it("a beaked kind with no usable limbs picks up with its mouth", () => {
    const g = raptorBlueprint();
    // No thumbs, no free non-membrane forelimb pair (the wings are
    // membrane) — but a jaw.
    expect(pickHandGroup(g)).toBe(-1);
    expect(pickArmGroup(g)).toBe(-1);
    const anim = new CreatureAnimator(g);
    expect(anim.hasHands()).toBe(false);
    expect(anim.canGrasp()).toBe(true);

    const L = g.spine.torsoLengthM;
    const size = 0.06;
    // Under the beak's descent arc — positioning the BODY relative to the
    // object is the host's job (locomotion), not the reach controller's.
    const object: Vec3 = { x: 0, y: size / 2, z: 0.7 * L };
    runAnim(anim, g, 0.5);
    expect(anim.pickUp(object, size)).toBe(true);

    const legLen = Math.max(...g.limbGroups.filter((l) => l.membrane < 0.55).map((l) => l.lengthFrac)) * L;
    let maxGape = 0;
    let minBeakDist = Infinity;
    let carryFrame: AnimFrame | null = null;
    let carrySkel: ReturnType<typeof buildSkeleton> | null = null;
    runAnim(anim, g, 6.0, (f, skel) => {
      maxGape = Math.max(maxGape, f.pose.gape ?? 0);
      if (f.action === "grasp") {
        const tip = limbTip(skel, "snout");
        if (tip) minBeakDist = Math.min(minBeakDist, Math.hypot(tip.x - object.x, tip.y - object.y, tip.z - object.z));
      }
      if (f.action === "carry") { carryFrame = f; carrySkel = skel; }
    });
    expect(anim.currentAction).toBe("carry");
    // The jaw gaped wide on approach…
    expect(maxGape).toBeGreaterThan(0.6);
    // …and the beak tip actually met the object's surface.
    expect(minBeakDist).toBeLessThan(0.05 * legLen + size * 0.55 + 0.06);
    // The object rides in the mouth: snout chain, clamped jaw, no arm IK.
    expect(carryFrame!.holding).toBe(true);
    expect(carryFrame!.handChains).toEqual(["snout"]);
    expect(carryFrame!.pose.limbTargets).toBeUndefined();
    expect(carryFrame!.pose.gape).toBeGreaterThan(0.05);
    expect(carryFrame!.pose.gape).toBeLessThan(0.5);
    expect(limbTip(carrySkel!, "snout")).not.toBeNull();
  });

  it("a mouth carry puts down and lets go (gape opens, then closes)", () => {
    const g = raptorBlueprint();
    const L = g.spine.torsoLengthM;
    const anim = new CreatureAnimator(g);
    runAnim(anim, g, 0.5);
    anim.pickUp({ x: 0, y: 0.03, z: 0.6 * L }, 0.06);
    runAnim(anim, g, 6.0);
    expect(anim.currentAction).toBe("carry");
    expect(anim.putDown({ x: 0.15 * L, y: 0.03, z: 0.55 * L })).toBe(true);
    let releaseGape = 0;
    let lastHolding = true;
    runAnim(anim, g, 6.0, (f) => {
      if (f.action === "release") releaseGape = Math.max(releaseGape, f.pose.gape ?? 0);
      lastHolding = f.holding;
    });
    expect(anim.currentAction).toBe("none");
    expect(lastHolding).toBe(false);
    expect(releaseGape).toBeGreaterThan(0.5); // let go = jaw cracked open
    const rest = anim.update(1 / 60);
    expect(rest.pose.gape ?? 0).toBe(0); // mouth closed again at rest
  });
});
