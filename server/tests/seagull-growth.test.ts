// Tests for the seagull-dream GROWTH system (creatures/growth.ts + its
// blueprint.ts wiring) — the branching/spiral grammar shared by plants and
// dermal growths (horns, antlers). Pure math, no three.js, no DOM — safe
// in the default `npm test` run.
//
// Load-bearing invariants (instructions/creatures.md):
// - clamp/validate contract: clampGrowth(anything) validates; blueprints
//   WITHOUT a growths field stay valid (older stored blueprints).
// - Determinism: same blueprint (incl. seed) → bit-identical structure.
// - BUDGET-PREFIX property (the LOD trick): generateGrowth at a smaller
//   budget emits exactly the first N segments of the larger-budget run.

import { describe, it, expect } from "@jest/globals";
import {
  clampGrowth,
  defaultGrowth,
  generateGrowth,
  growthValidationErrors,
  GROWTH_STEM_RANGES,
  MAX_GROWTHS,
  MAX_GROWTH_SEGMENTS,
  MAX_GROWTH_LEAVES,
  MAX_GROWTH_FRUITS,
  type GrowthBlueprint,
  type GrowthStructure,
  type GVec3,
} from "../../games/seagull-dream/src/creatures/growth.js";
import {
  clampBlueprint,
  defaultBlueprint,
  plantBlueprint,
  validateBlueprint,
} from "../../games/seagull-dream/src/creatures/blueprint.js";
import { buildSkeleton } from "../../games/seagull-dream/src/creatures/skeleton.js";

const finite = (v: GVec3) =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** A branchy tree-ish growth that exercises every subsystem. */
function treeish(over: Partial<GrowthBlueprint> = {}): GrowthBlueprint {
  return clampGrowth({
    ...defaultGrowth(),
    seed: 7,
    stem: { ...defaultGrowth().stem, lengthFrac: 10, girth: 0.03, segments: 6, waviness: 0.4 },
    branching: {
      levels: 3,
      branchStart: 0.3,
      nodes: 3,
      whorl: 3,
      phyllotaxis: 2.4,
      branchAngle: 0.8,
      lengthRatio: 0.6,
      radiusRatio: 0.6,
      jitter: 0.5,
    },
    foliage: { ...defaultGrowth().foliage, leafDensity: 2 },
    fruitDensity: 1,
    fruitPlacement: "along",
    ...over,
  });
}

describe("growth: clamp + validate", () => {
  it("defaultGrowth validates", () => {
    expect(growthValidationErrors(defaultGrowth(), "g")).toEqual([]);
  });

  it("clampGrowth is idempotent", () => {
    const once = clampGrowth({ stem: { lengthFrac: 9999, girth: -5 }, count: 99 });
    expect(clampGrowth(once)).toEqual(once);
  });

  it("clampGrowth coerces LLM garbage into a valid growth", () => {
    const garbage = {
      attach: "roots???",
      placement: 7,
      count: "many",
      seed: 3.7,
      stem: { lengthFrac: "tall", curl: 1e9, lobes: -3 },
      branching: { levels: 99, whorl: 0 },
      foliage: { leafColor: "green", leafDensity: NaN },
      flowers: null,
      fruit: { color: "#ZZZZZZ", aspect: 0 },
      fruitPlacement: "everywhere",
    };
    const clamped = clampGrowth(garbage);
    expect(growthValidationErrors(clamped, "g")).toEqual([]);
  });

  it("blueprints WITHOUT a growths field still validate (older stored blueprints)", () => {
    const g = defaultBlueprint() as Record<string, unknown>;
    delete g.growths;
    expect(validateBlueprint(g).ok).toBe(true);
  });

  it("clampBlueprint clamps growth entries and caps the array", () => {
    const g = clampBlueprint({
      ...defaultBlueprint(),
      growths: new Array(MAX_GROWTHS + 3).fill({ stem: { lengthFrac: 1e9 } }),
    });
    expect(g.growths).toHaveLength(MAX_GROWTHS);
    expect(validateBlueprint(g).ok).toBe(true);
    expect(g.growths[0].stem.lengthFrac).toBeLessThanOrEqual(GROWTH_STEM_RANGES.lengthFrac.max);
  });

  it("plantBlueprint builds a valid limbless nub blueprint with one growth", () => {
    const p = plantBlueprint({ stem: { ...defaultGrowth().stem, lengthFrac: 40 } }, { name: "test tree" });
    expect(validateBlueprint(p).ok).toBe(true);
    expect(p.limbGroups).toEqual([]);
    expect(p.head.eyePairs).toBe(0);
    expect(p.growths).toHaveLength(1);
    expect(p.growths[0].attach).toBe("body");
  });
});

describe("growth: generator determinism + invariants", () => {
  it("same blueprint → bit-identical structure", () => {
    const g = treeish();
    const a = generateGrowth(g, 1, 240);
    const b = generateGrowth(g, 1, 240);
    expect(b).toEqual(a);
  });

  it("different seeds → different structures (jitter is live)", () => {
    const a = generateGrowth(treeish({ seed: 1 }), 1, 240);
    const b = generateGrowth(treeish({ seed: 2 }), 1, 240);
    expect(JSON.stringify(a.segments)).not.toEqual(JSON.stringify(b.segments));
  });

  it("segments are finite, connected, positive-radius, level-monotone", () => {
    const s = generateGrowth(treeish(), 1, 240);
    expect(s.segments.length).toBeGreaterThan(20);
    s.segments.forEach((seg, i) => {
      expect(finite(seg.a)).toBe(true);
      expect(finite(seg.b)).toBe(true);
      expect(seg.radiusA).toBeGreaterThan(0);
      expect(seg.radiusB).toBeGreaterThan(0);
      expect(seg.parent).toBeLessThan(i); // parents precede children in the stream
      if (seg.parent >= 0) {
        const p = s.segments[seg.parent];
        // Same-branch continuation or a child sprout: level equal or +1.
        expect(seg.level - p.level).toBeGreaterThanOrEqual(0);
        expect(seg.level - p.level).toBeLessThanOrEqual(1);
      } else {
        expect(seg.level).toBe(0);
      }
    });
  });

  it("respects budgets and hard caps", () => {
    const s = generateGrowth(treeish(), 1, 50);
    expect(s.segments.length).toBeLessThanOrEqual(50);
    const full = generateGrowth(treeish(), 1, 100000);
    expect(full.segments.length).toBeLessThanOrEqual(MAX_GROWTH_SEGMENTS);
    expect(full.leaves.length).toBeLessThanOrEqual(MAX_GROWTH_LEAVES);
    expect(full.fruits.length).toBeLessThanOrEqual(MAX_GROWTH_FRUITS);
  });

  it("scales with torso length", () => {
    const g = treeish();
    const small = generateGrowth(g, 0.25, 240);
    const big = generateGrowth(g, 2.5, 240);
    expect(big.lengthM).toBeCloseTo(small.lengthM * 10, 6);
  });
});

describe("growth: budget-prefix property (the LOD trick)", () => {
  it("smaller budgets are structural prefixes of larger ones", () => {
    const g = treeish();
    const full = generateGrowth(g, 1, 240);
    for (const n of [1, 10, 37, 60, 120, full.segments.length]) {
      const partial = generateGrowth(g, 1, n);
      expect(partial.segments).toEqual(full.segments.slice(0, Math.min(n, full.segments.length)));
    }
  });

  it("prefix holds for a plain unbranched horn too", () => {
    const g = treeish({
      branching: { ...treeish().branching, levels: 0 },
      stem: { ...treeish().stem, segments: 10, curl: 9, twist: 3 },
    });
    const full = generateGrowth(g, 1, 240);
    expect(full.segments).toHaveLength(10);
    const partial = generateGrowth(g, 1, 4);
    expect(partial.segments).toEqual(full.segments.slice(0, 4));
  });
});

describe("growth: spirals (horns)", () => {
  const horn = (curl: number, twist: number): GrowthStructure =>
    generateGrowth(
      treeish({
        seed: 3,
        branching: { ...treeish().branching, levels: 0 },
        stem: {
          ...treeish().stem,
          lengthFrac: 1,
          segments: 12,
          curl,
          twist,
          waviness: 0,
          gravitropism: 0,
          lean: 0.3,
        },
        foliage: { ...treeish().foliage, leafDensity: 0 },
        fruitDensity: 0,
      }),
      1,
      240,
    );

  /** Max distance of segment endpoints from the best plane through the
   *  first three points — 0 for a planar curve. */
  function planarity(s: GrowthStructure): number {
    const pts = [s.segments[0].a, ...s.segments.map((seg) => seg.b)];
    const [p0, p1, p2] = [pts[0], pts[4], pts[8]];
    const u = { x: p1.x - p0.x, y: p1.y - p0.y, z: p1.z - p0.z };
    const v = { x: p2.x - p0.x, y: p2.y - p0.y, z: p2.z - p0.z };
    const n = {
      x: u.y * v.z - u.z * v.y,
      y: u.z * v.x - u.x * v.z,
      z: u.x * v.y - u.y * v.x,
    };
    const nl = Math.hypot(n.x, n.y, n.z) || 1;
    let worst = 0;
    for (const p of pts) {
      const d =
        Math.abs((p.x - p0.x) * n.x + (p.y - p0.y) * n.y + (p.z - p0.z) * n.z) / nl;
      worst = Math.max(worst, d);
    }
    return worst;
  }

  it("curl alone coils in a plane (ram)", () => {
    const s = horn(9, 0);
    expect(planarity(s)).toBeLessThan(1e-6);
    // It actually curls: the tip is nowhere near lean-line-straight.
    const tip = s.segments[s.segments.length - 1].b;
    const straightTip = { x: 0, y: Math.cos(0.3), z: Math.sin(0.3) };
    const dist = Math.hypot(tip.x - straightTip.x, tip.y - straightTip.y, tip.z - straightTip.z);
    expect(dist).toBeGreaterThan(0.5);
  });

  it("curl + twist leaves the plane (kudu helix)", () => {
    expect(planarity(horn(9, 6))).toBeGreaterThan(0.01);
  });

  it("no curl, no twist stays straight (cow)", () => {
    const s = horn(0, 0);
    const base = s.segments[0].a;
    const tip = s.segments[s.segments.length - 1].b;
    const len = Math.hypot(tip.x - base.x, tip.y - base.y, tip.z - base.z);
    expect(len).toBeGreaterThan(0.99); // chord ≈ arc length ⇒ straight
  });
});

describe("growth: foliage, flowers, fruits", () => {
  it("leaves appear on the outer branch levels", () => {
    const s = generateGrowth(treeish(), 1, 240);
    expect(s.leaves.length).toBeGreaterThan(0);
    for (const leaf of s.leaves) {
      expect(finite(leaf.pos)).toBe(true);
      expect(leaf.lengthM).toBeGreaterThan(0);
      expect(leaf.widthM).toBeGreaterThan(0);
    }
  });

  it("bare growth (leafDensity 0) emits no leaves — a horn", () => {
    const s = generateGrowth(
      treeish({ foliage: { ...treeish().foliage, leafDensity: 0 }, fruitDensity: 0 }),
      1,
      240,
    );
    expect(s.leaves).toHaveLength(0);
    expect(s.fruits).toHaveLength(0);
  });

  it("flowers emit petalCount petals per flowering tip", () => {
    const g = treeish({
      branching: { ...treeish().branching, levels: 1, nodes: 2, whorl: 2, jitter: 0 },
      foliage: { ...treeish().foliage, leafDensity: 0 },
      flowers: { flowerDensity: 1, petalCount: 5, flowerSizeFrac: 0.5, flowerColor: "#ffffff" },
      fruitDensity: 0,
    });
    const s = generateGrowth(g, 1, 240);
    const petals = s.leaves.filter((l) => l.kind === "petal");
    expect(petals.length).toBeGreaterThan(0);
    expect(petals.length % 5).toBe(0);
  });

  it("mushroom: terminal oblate fruit body caps an unbranched stem", () => {
    const g = clampGrowth({
      ...defaultGrowth(),
      stem: { ...defaultGrowth().stem, lengthFrac: 1, segments: 3, girth: 0.12, curl: 0, gravitropism: 0 },
      branching: { ...defaultGrowth().branching, levels: 0 },
      foliage: { ...defaultGrowth().foliage, leafDensity: 0 },
      fruit: { ...defaultGrowth().fruit, sizeM: 0.3, aspect: 0.35, stemFrac: 0, color: "#c24a3a" },
      fruitDensity: 1,
      fruitPlacement: "terminal",
    });
    const s = generateGrowth(g, 1, 240);
    expect(s.fruits).toHaveLength(1);
    const cap = s.fruits[0];
    // A fruit body is a ring list, not a point; its equatorial radius is
    // ~sizeM/2 and it is oblate (short along its axis).
    const maxR = Math.max(...cap.rings.map((r) => r.radius));
    expect(maxR).toBeCloseTo(0.15, 2);
    // Sessile (stemFrac 0) → the body sits ABOVE the stem tip, aligned
    // with the stem (not dangling below it).
    const tipY = s.segments[s.segments.length - 1].b.y;
    expect(cap.rings.some((r) => r.center.y > tipY - 1e-6)).toBe(true);
  });

  it("skeleton: growth instances are welded geometry, not bones", () => {
    const g = clampBlueprint({
      ...defaultBlueprint(),
      growths: [{ ...defaultGrowth(), attach: "head", count: 2 }],
    });
    const bare = buildSkeleton(clampBlueprint({ ...defaultBlueprint(), growths: [] }));
    const skel = buildSkeleton(g);
    expect(skel.growths.length).toBe(2); // one bilateral pair = 2 instances
    expect(skel.bones.length).toBe(bare.bones.length); // NO new bones
    for (const gw of skel.growths) {
      expect(gw.bone).toBeGreaterThanOrEqual(0);
      expect(gw.bone).toBeLessThan(skel.bones.length);
      expect(skel.bones[gw.bone].kind).toBe("head");
      expect(gw.segments.length).toBeGreaterThan(0);
    }
  });

  it("skeleton: bilateral horn pairs mirror across the midplane", () => {
    const g = clampBlueprint({
      ...defaultBlueprint(),
      growths: [
        {
          ...defaultGrowth(),
          attach: "head",
          placement: "bilateral",
          count: 2,
          phi: 0.85,
          branching: { ...defaultGrowth().branching, levels: 0 },
          stem: { ...defaultGrowth().stem, lengthFrac: 0.8, segments: 8, curl: 6, twist: 4, waviness: 0 },
          foliage: { ...defaultGrowth().foliage, leafDensity: 0 },
        },
      ],
    });
    const skel = buildSkeleton(g);
    expect(skel.growths).toHaveLength(2);
    const [r, l] = skel.growths;
    expect(r.segments.length).toBe(l.segments.length);
    r.segments.forEach((sr, i) => {
      const sl = l.segments[i];
      // Exact reflection: x negates, y/z identical, radii identical.
      expect(sl.a.x).toBeCloseTo(-sr.a.x, 9);
      expect(sl.a.y).toBeCloseTo(sr.a.y, 9);
      expect(sl.a.z).toBeCloseTo(sr.a.z, 9);
      expect(sl.b.x).toBeCloseTo(-sr.b.x, 9);
      expect(sl.radiusA).toBeCloseTo(sr.radiusA, 12);
    });
    // The pair actually leaves the midplane (they're on opposite sides).
    const tipR = r.segments[r.segments.length - 1].b;
    expect(Math.abs(tipR.x)).toBeGreaterThan(0.01);
  });

  it("skeleton: a plant's growth dominates the bounds (camera framing)", () => {
    const p = plantBlueprint({
      stem: { ...defaultGrowth().stem, lengthFrac: 40, gravitropism: 0.6 },
      branching: { ...defaultGrowth().branching, levels: 2 },
    });
    const skel = buildSkeleton(p);
    const height = skel.bounds.max.y - skel.bounds.min.y;
    // Nub is 0.25 m long; a lengthFrac-40 tree is ~10 m — bounds must see it.
    expect(height).toBeGreaterThan(3);
    // And the plant still grounds: nothing sinks below the pad.
    expect(skel.bounds.min.y).toBeGreaterThan(-0.5);
  });

  it("skeleton: growths ride gait rebuilds deterministically (cache-safe)", () => {
    const g = clampBlueprint({
      ...defaultBlueprint(),
      growths: [{ ...defaultGrowth(), attach: "head", count: 2 }],
    });
    const a = buildSkeleton(g);
    const b = buildSkeleton(g);
    expect(b.growths).toEqual(a.growths);
  });

  it("dangling fruit (stemFrac > 0) hangs below its attach point", () => {
    const g = treeish({
      branching: { ...treeish().branching, levels: 1 },
      foliage: { ...treeish().foliage, leafDensity: 0 },
      fruit: { ...defaultGrowth().fruit, sizeM: 0.1, aspect: 1, stemFrac: 1, color: "#b5402f" },
      fruitDensity: 1,
      fruitPlacement: "terminal",
    });
    const s = generateGrowth(g, 1, 240);
    expect(s.fruits.length).toBeGreaterThan(0);
    // A hang-dial of 1 points the fruit body axis straight down.
    for (const f of s.fruits) {
      expect(f.axis.y).toBeLessThan(-0.9);
    }
  });
});

describe("growth: fruit bodies, shapes & sizing", () => {
  // stemFrac 0 → the body stands straight up on its pedicel, so shape
  // assertions read on a clean vertical axis.
  const fruitOnly = (over: Partial<GrowthBlueprint["fruit"]> = {}, type: "fruit" | "root" = "fruit"): GrowthBlueprint =>
    clampGrowth({
      ...defaultGrowth(),
      type,
      fruit: { ...defaultGrowth().fruit, stemFrac: 0, ...over },
    });

  it("fruit size is ABSOLUTE — a big fruit on a stub stem stays big", () => {
    // Same fruit (sizeM 0.3) on a tiny plant vs a huge one: the equatorial
    // radius is ~0.15 either way (decoupled from stem length).
    const g = fruitOnly({ sizeM: 0.3, aspect: 1 });
    const small = generateGrowth(g, 0.1, 240);
    const big = generateGrowth(g, 5, 240);
    const rOf = (s: GrowthStructure) => Math.max(...s.fruits[0].rings.map((r) => r.radius));
    expect(rOf(small)).toBeCloseTo(0.15, 2);
    expect(rOf(big)).toBeCloseTo(rOf(small), 6); // ground-pumpkin case
  });

  it("aspect stretches the body along its axis", () => {
    const axisLen = (s: GrowthStructure): number => {
      const rs = s.fruits[0].rings;
      const a = rs[0].center, b = rs[rs.length - 1].center;
      return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    };
    const round = generateGrowth(fruitOnly({ sizeM: 0.1, aspect: 1, curvature: 0 }), 1, 240);
    const long = generateGrowth(fruitOnly({ sizeM: 0.1, aspect: 4, curvature: 0 }), 1, 240);
    expect(axisLen(long)).toBeGreaterThan(axisLen(round) * 2.5);
  });

  it("bulge moves the widest ring along the body", () => {
    // Taper both ends so the bulge is the unique widest station.
    const widestT = (bulge: number): number => {
      const rings = generateGrowth(fruitOnly({ sizeM: 0.1, aspect: 2, bulge, neck: 0.4, tipTaper: 0.4, curvature: 0 }), 1, 240).fruits[0].rings;
      let bi = 0;
      rings.forEach((r, i) => { if (r.radius > rings[bi].radius) bi = i; });
      return bi / (rings.length - 1);
    };
    expect(widestT(0.25)).toBeLessThan(widestT(0.75)); // low bulge peaks nearer the base
  });

  it("curvature bends the body off its start axis (banana)", () => {
    const straight = generateGrowth(fruitOnly({ sizeM: 0.04, aspect: 5, curvature: 0 }), 1, 240).fruits[0];
    const bent = generateGrowth(fruitOnly({ sizeM: 0.04, aspect: 5, curvature: 1.4 }), 1, 240).fruits[0];
    // The straight body runs vertically (no horizontal drift); the bent one
    // sweeps sideways off that axis (bend plane is arbitrary, so measure
    // total horizontal displacement).
    const relTo = (f: typeof straight) => {
      const base = f.rings[0].center;
      return Math.max(...f.rings.map((r) => Math.hypot(r.center.x - base.x, r.center.z - base.z)));
    };
    expect(relTo(straight)).toBeLessThan(1e-6);
    expect(relTo(bent)).toBeGreaterThan(0.01);
  });

  it("crownLeaves at the tip, calyxLeaves at the base (pineapple / strawberry)", () => {
    const g = fruitOnly({ sizeM: 0.1, aspect: 1.5, crownLeaves: 7, calyxLeaves: 3 });
    const s = generateGrowth(g, 1, 240);
    expect(s.leaves.filter((l) => l.kind === "leaf")).toHaveLength(10);
    const rings = s.fruits[0].rings;
    const tipY = rings[rings.length - 1].center.y;
    const baseY = rings[0].center.y;
    const highLeaves = s.leaves.filter((l) => l.pos.y > (tipY + baseY) / 2).length;
    expect(highLeaves).toBeGreaterThanOrEqual(7); // the 7 crown leaves ride the top
  });

  it("root type: the storage body grows DOWN with a leafy top above it", () => {
    const g = fruitOnly({ sizeM: 0.05, aspect: 3, tipTaper: 1, calyxLeaves: 5 }, "root");
    const s = generateGrowth(g, 0.1, 240);
    expect(s.segments).toHaveLength(0); // no stem — the body IS the vegetable
    expect(s.fruits).toHaveLength(1);
    expect(s.fruits[0].axis.y).toBeLessThan(-0.9); // points into the ground
    const lowestBody = Math.min(...s.fruits[0].rings.map((r) => r.center.y));
    expect(lowestBody).toBeLessThan(0); // below the attach plane
    // Calyx leaves (the leafy top) sit at/above ground, pointing up.
    expect(s.leaves.length).toBeGreaterThanOrEqual(5);
    expect(Math.max(...s.leaves.map((l) => l.pos.y))).toBeGreaterThanOrEqual(-1e-6);
  });

  it("root builds through the skeleton as welded geometry with no bones", () => {
    const p = plantBlueprint({ type: "root", fruit: { ...defaultGrowth().fruit, sizeM: 0.06, aspect: 3, calyxLeaves: 5 } });
    // Same plant nub WITHOUT the growth — a root adds geometry, not bones.
    const bare = buildSkeleton(clampBlueprint({ ...p, growths: [] }));
    const skel = buildSkeleton(p);
    expect(skel.bones.length).toBe(bare.bones.length);
    expect(skel.growths).toHaveLength(1);
    expect(skel.growths[0].fruits).toHaveLength(1);
    expect(validateBlueprint(p).ok).toBe(true);
  });

  it("clampGrowth coerces the new fruit fields + type enum", () => {
    const g = clampGrowth({
      type: "gourd???",
      fruit: { sizeM: 99, aspect: -3, bulge: 2, neck: 5, tipTaper: -1, curvature: 1e9, lobes: 3.7, crownLeaves: 2.5, color: "#nope" },
    });
    expect(growthValidationErrors(g, "g")).toEqual([]);
    expect(g.type).toBe("shoot"); // unknown → default
  });
});
