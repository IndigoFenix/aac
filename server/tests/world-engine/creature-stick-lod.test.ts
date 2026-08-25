// STICK LOD (stick-lod.ts + view-tiers.ts): the tier between the cheap loft
// and the placeholder capsule — a body reduced to a handful of tapered
// capsules, and the distance ladder that decides when it is used.
//
// Headless THREE (no WebGL), like the sibling creature suites: everything
// asserted here is geometry and pure banding, so no GL context is needed.
// What a GL context WOULD add (that the shader compiles, that the silhouette
// SDF carves round caps) is verified in the creature-lab's "LOD preview →
// stick" — see planning-docs/games/world-engine/view-distance-lod-tiers.md.

import { describe, it, expect } from "@jest/globals";
import { buildSkeleton } from "@shared/world-engine/creatures/skeleton.js";
import { clampBlueprint } from "@shared/world-engine/creatures/blueprint.js";
import { requireSpecies } from "@shared/world-engine/creatures/species.js";
import { outfitPresetFor } from "@shared/world-engine/creatures/clothing.js";
import {
  creatureSticks,
  buildStickGeometry,
  STICK_LOD,
} from "@shared/world-engine/creatures/stick-lod.js";
import { getSpeciesAssets } from "@shared/world-engine/creatures/creature-model.js";
import {
  TIER_BANDS,
  TIER_RANK,
  seedTier,
  steppedTier,
  detailForTier,
  type CreatureTier,
} from "@shared/world-engine/creatures/view-tiers.js";

const bpOf = (id: string) => clampBlueprint(requireSpecies(id).blueprint);
const figOf = (id: string) => {
  const bp = bpOf(id);
  return creatureSticks(buildSkeleton(bp), bp);
};
const lenOf = (s: { a: { x: number; y: number; z: number }; b: { x: number; y: number; z: number } }): number =>
  Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y, s.b.z - s.a.z);

describe("creatureSticks — a body reduced to capsules", () => {
  it("collapses a creature to a couple of dozen capsules, not one per bone", () => {
    const bp = bpOf("human_cute");
    const skel = buildSkeleton(bp);
    const fig = creatureSticks(skel, bp);
    // 54 bones (spine, neck, head region, 4 limbs, 18 digit chains) reduce to
    // a figure a person could sketch.
    expect(skel.bones.length).toBeGreaterThan(40);
    expect(fig.segments.length).toBeGreaterThan(6);
    expect(fig.segments.length).toBeLessThan(25);
  });

  it("keeps every body plan legible — a quadruped stays a quadruped", () => {
    // The whole point of the tier over the capsule: four legs still read as
    // four legs. Count sticks whose span is mostly VERTICAL and low.
    const bp = bpOf("quadruped");
    const skel = buildSkeleton(bp);
    const fig = creatureSticks(skel, bp);
    const legs = fig.segments.filter((s) => {
      const dy = Math.abs(s.b.y - s.a.y);
      return dy > lenOf(s) * 0.55 && Math.min(s.a.y, s.b.y) < 0.35;
    });
    expect(legs.length).toBeGreaterThanOrEqual(4);
  });

  it("drops the digit chains (fingers and toes are invisible at this range)", () => {
    const bp = bpOf("human_cute");
    const skel = buildSkeleton(bp);
    const digits = skel.bones.filter((b) => /d\d+$/.test(b.chain));
    expect(digits.length).toBeGreaterThan(10); // the mint site really is producing them
    const fig = creatureSticks(skel, bp);
    // No stick may sit at a digit's exact span — the merge never produces one
    // because digits never enter the chain map at all.
    for (const d of digits) {
      const hit = fig.segments.some(
        (s) => Math.hypot(s.a.x - d.head.x, s.a.y - d.head.y, s.a.z - d.head.z) < 1e-6
          && Math.hypot(s.b.x - d.tail.x, s.b.y - d.tail.y, s.b.z - d.tail.z) < 1e-6,
      );
      expect(hit).toBe(false);
    }
  });

  it("draws the skull from the head LANDMARKS, not the four head chains", () => {
    const bp = bpOf("human_cute");
    const skel = buildSkeleton(bp);
    const fig = creatureSticks(skel, bp);
    // The head region (chains head/snout/nose/jaw all carry kind "head") is
    // skipped; the braincase capsule stands in for all of it.
    const lm = skel.head!;
    const headR = (lm.radius + lm.domeHalf) * 0.5;
    const cranium = fig.segments.find(
      (s) => Math.abs(s.ra - headR) < 1e-6 && Math.abs(s.rb - headR) < 1e-6,
    );
    expect(cranium).toBeDefined();
    // It is the FATTEST thing on the body relative to its length — that is
    // what makes it read as a circle at 20 px.
    expect(cranium!.ra).toBeGreaterThan(lenOf(cranium!) * 0.5);
  });

  it("keeps the bent joints and merges the straight runs", () => {
    // A 6-bone spine is nearly straight, a leg bends at the knee: the spine
    // must collapse further than the leg does.
    const bp = bpOf("human_cute");
    const skel = buildSkeleton(bp);
    const fig = creatureSticks(skel, bp);
    const spineBones = skel.bones.filter((b) => b.chain === "spine").length;
    const spineSticks = fig.segments.filter((s) =>
      Math.abs(s.a.x) < 1e-6 && Math.abs(s.b.x) < 1e-6 && s.a.y > 0.4 && s.b.y > 0.4,
    ).length;
    expect(spineBones).toBeGreaterThanOrEqual(6);
    expect(spineSticks).toBeLessThan(spineBones);
    // …and no chain ever exceeds its cap, however jagged the pose.
    expect(fig.segments.length).toBeLessThanOrEqual(
      new Set(skel.bones.map((b) => b.chain)).size * STICK_LOD.maxPerChain + 8,
    );
  });

  it("drops a plant's vestigial spine and draws its trunk instead", () => {
    // Every PLANT carries a 4 mm nub of a spine under its trunk (the growth
    // hangs off it). Drawing it would put a stub in the soil.
    const bp = bpOf("oak");
    const skel = buildSkeleton(bp);
    const spine = skel.bones.filter((b) => b.chain === "spine");
    expect(spine.length).toBeGreaterThan(0);
    expect(Math.max(...spine.map((b) => b.radiusTail))).toBeLessThan(0.01);
    const fig = creatureSticks(skel, bp);
    expect(fig.segments.length).toBeGreaterThan(20); // the tree itself survived
    // Nothing is drawn at the nub's radius…
    for (const s of fig.segments) expect(Math.max(s.ra, s.rb)).toBeGreaterThan(0.01);
    // …and the tree still stands its full height.
    expect(fig.bounds.max.y - fig.bounds.min.y).toBeGreaterThan(10);
  });

  it("truncates growth structure to a PREFIX, so the trunk never moves", () => {
    // growth.ts emits coarse-to-fine with a prefix guarantee (plant-lod.ts):
    // the sticks' trunk must be the SAME line the full tree lofts.
    const bp = bpOf("oak");
    const skel = buildSkeleton(bp);
    const fig = creatureSticks(skel, bp);
    const first = skel.growths[0].segments[0];
    const trunk = fig.segments.find(
      (s) => Math.hypot(s.a.x - first.a.x, s.a.y - first.a.y, s.a.z - first.a.z) < 1e-9,
    );
    expect(trunk).toBeDefined();
    expect(trunk!.b.y).toBeCloseTo(first.b.y, 9);
    expect(trunk!.ra).toBeCloseTo(first.radiusA, 9);
  });

  it("turns a dense canopy into CIRCLES (zero-length capsules)", () => {
    const bp = bpOf("oak");
    const fig = creatureSticks(buildSkeleton(bp), bp);
    const circles = fig.segments.filter((s) => lenOf(s) < 1e-9);
    expect(circles.length).toBeGreaterThan(0);
    // A canopy blob is FAT — that is what makes it read as foliage and not a
    // stray dot on a branch.
    for (const c of circles) expect(c.ra).toBeGreaterThan(0.2);
  });

  it("is deterministic — the same blueprint reduces to the same figure", () => {
    const a = figOf("ungulate");
    const b = figOf("ungulate");
    expect(a.segments.length).toBe(b.segments.length);
    for (let i = 0; i < a.segments.length; i++) {
      expect(a.segments[i].a).toEqual(b.segments[i].a);
      expect(a.segments[i].ra).toBe(b.segments[i].ra);
    }
  });
});

describe("buildStickGeometry — one quad per capsule", () => {
  it("emits 4 verts / 2 triangles per capsule, with the shader's attributes", () => {
    const fig = figOf("human_cute");
    const g = buildStickGeometry(fig);
    const n = fig.segments.length;
    expect(g.getAttribute("position").count).toBe(n * 4);
    expect(g.getIndex()!.count).toBe(n * 6);
    for (const attr of ["aSegA", "aSegB", "aRadii", "aCorner", "color"]) {
      expect(g.getAttribute(attr)).toBeDefined();
    }
  });

  it("carries NO normals — the tier is unlit, and that is a quarter of the buffer", () => {
    // Deliberate (see stick-lod.ts's header): nothing reads a normal here, so
    // shipping one would be dead weight on a tier whose whole job is crowds.
    // The pairing this rests on — that only `stickMaterial` ever sees this
    // geometry — is asserted by the next case.
    expect(buildStickGeometry(figOf("oak")).getAttribute("normal")).toBeUndefined();
  });

  it("is inseparable from its material: `position` is an ANCHOR, not a surface", () => {
    // The guard behind dropping normals. Every vertex of a capsule's quad sits
    // on one of its two ENDPOINTS — the shader expands them. So this geometry
    // is meaningless to any other material, which is why it owes none of them
    // a normal, and why nothing may hand it to a lit one.
    const fig = figOf("human_cute");
    const g = buildStickGeometry(fig);
    const pos = g.getAttribute("position");
    for (let s = 0; s < fig.segments.length; s++) {
      const seg = fig.segments[s];
      for (let c = 0; c < 4; c++) {
        const end = c < 2 ? seg.a : seg.b;
        const i = s * 4 + c;
        // 1e-5, not 0: the buffer is Float32 and the figure is Float64. Still
        // ~5 orders tighter than any real offset on a body a couple of m tall.
        expect(Math.hypot(pos.getX(i) - end.x, pos.getY(i) - end.y, pos.getZ(i) - end.z)).toBeLessThan(1e-5);
      }
    }
  });

  it("gives every corner of a quad the WHOLE segment (the shader needs it)", () => {
    const fig = figOf("quadruped");
    const g = buildStickGeometry(fig);
    const segA = g.getAttribute("aSegA");
    const radii = g.getAttribute("aRadii");
    for (let s = 0; s < fig.segments.length; s++) {
      for (let c = 1; c < 4; c++) {
        expect(segA.getX(s * 4 + c)).toBe(segA.getX(s * 4));
        expect(radii.getX(s * 4 + c)).toBe(radii.getX(s * 4));
      }
    }
  });

  it("bounds are INFLATED by radius — the shader expands past `position`", () => {
    // Bounds read off `position` alone would cull a body a frame early at the
    // screen edge, because the drawn quads reach a radius further out.
    const fig = figOf("human_cute");
    const g = buildStickGeometry(fig);
    const pos = g.getAttribute("position");
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));
    expect(g.boundingBox!.max.y).toBeGreaterThan(maxY);
    expect(g.boundingSphere!.radius).toBeGreaterThan(0);
  });

  it("costs a fraction of the loft it replaces", () => {
    // The tier only earns its place if it is dramatically cheaper than
    // `simple`; a regression that fattens it should fail here loudly.
    const stickVerts = buildStickGeometry(figOf("human_cute")).getAttribute("position").count;
    const simpleVerts = getSpeciesAssets("human_cute", {}, undefined, "simple")
      .clips.get("idle")!.frames[0].geometry.getAttribute("position").count;
    expect(stickVerts * 4).toBeLessThan(simpleVerts);
  });
});

describe("stick bakes — outfit-blind, one per species", () => {
  it("hands two DIFFERENT outfits the same cached assets", () => {
    // The payoff of the tier: `simple` warms one bake per head × palette
    // colour; stick warms one, full stop.
    const a = getSpeciesAssets("human_cute", {}, outfitPresetFor(0), "stick");
    const b = getSpeciesAssets("human_cute", {}, outfitPresetFor(3), "stick");
    expect(a).toBe(b);
    expect(a).toBe(getSpeciesAssets("human_cute", {}, undefined, "stick"));
  });

  it("does NOT collapse outfits at the tiers that can still show them", () => {
    const a = getSpeciesAssets("human_cute", {}, outfitPresetFor(0), "simple");
    const b = getSpeciesAssets("human_cute", {}, outfitPresetFor(3), "simple");
    expect(a).not.toBe(b);
  });

  it("bakes a walk clip, so a distant body still walks", () => {
    const assets = getSpeciesAssets("human_cute", {}, undefined, "stick");
    const walk = assets.clips.get("walk");
    expect(walk).toBeDefined();
    expect(walk!.frames.length).toBeGreaterThan(1);
    // Frames must actually DIFFER — a bake that sampled one pose would look
    // like a body sliding along the ground.
    const f0 = walk!.frames[0].geometry.getAttribute("aSegB");
    const f1 = walk!.frames[Math.floor(walk!.frames.length / 2)].geometry.getAttribute("aSegB");
    let moved = 0;
    for (let i = 0; i < Math.min(f0.count, f1.count); i++) {
      if (Math.abs(f0.getZ(i) - f1.getZ(i)) > 1e-4) moved++;
    }
    expect(moved).toBeGreaterThan(0);
  });
});

describe("view-tiers — the distance ladder", () => {
  it("coarsens monotonically with distance", () => {
    let last = -1;
    for (const d of [0, 5, 20, 44, 46, 100, 120, 5000]) {
      const rank = TIER_RANK[seedTier(TIER_BANDS, d)];
      expect(rank).toBeGreaterThanOrEqual(last);
      last = rank;
    }
    expect(seedTier(TIER_BANDS, 0)).toBe("full");
    expect(seedTier(TIER_BANDS, 60)).toBe("stick");
    expect(seedTier(TIER_BANDS, 5000)).toBe("capsule");
  });

  it("puts the STICK tier where the loft stops being worth it", () => {
    const stick = TIER_BANDS.find((b) => b.tier === "stick")!;
    const capsule = TIER_BANDS.find((b) => b.tier === "capsule")!;
    expect(stick.from).toBeLessThan(capsule.from);
    expect(seedTier(TIER_BANDS, stick.from)).toBe("stick");
    expect(seedTier(TIER_BANDS, stick.from - 0.001)).toBe("simple");
  });

  it("holds its tier inside the hysteresis margin (no rebuild flap)", () => {
    const hyst = 10;
    const edge = TIER_BANDS.find((b) => b.tier === "stick")!.from;
    // Sitting just past the boundary must NOT coarsen…
    expect(steppedTier(TIER_BANDS, "simple", edge + hyst - 0.1, hyst)).toBe("simple");
    // …and just inside it must NOT refine.
    expect(steppedTier(TIER_BANDS, "stick", edge - hyst + 0.1, hyst)).toBe("stick");
    // Clearing the margin flips, both ways.
    expect(steppedTier(TIER_BANDS, "simple", edge + hyst + 0.1, hyst)).toBe("stick");
    expect(steppedTier(TIER_BANDS, "stick", edge - hyst - 0.1, hyst)).toBe("simple");
  });

  it("crosses SEVERAL rungs in one step (a fast descent never stalls)", () => {
    expect(steppedTier(TIER_BANDS, "capsule", 0, 10)).toBe("full");
    expect(steppedTier(TIER_BANDS, "full", 5000, 10)).toBe("capsule");
  });

  it("never oscillates: a distance held still is a fixed point", () => {
    for (const d of [0, 14, 25, 45, 60, 109, 200]) {
      for (const start of ["full", "simple", "stick", "capsule"] as CreatureTier[]) {
        const once = steppedTier(TIER_BANDS, start, d, 10);
        expect(steppedTier(TIER_BANDS, once, d, 10)).toBe(once);
      }
    }
  });

  it("maps every tier to a BUILD detail, capsule included", () => {
    expect(detailForTier("full")).toBe("full");
    expect(detailForTier("simple")).toBe("simple");
    expect(detailForTier("stick")).toBe("stick");
    // A body still built under the capsule tier (a fresh spawn mid-cross)
    // takes the cheapest skinned form, never full fidelity.
    expect(detailForTier("capsule")).toBe("stick");
    expect(detailForTier(undefined)).toBe("full");
  });
});
