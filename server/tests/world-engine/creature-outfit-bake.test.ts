// Worn outfits on BAKED creatures (creature-model.ts + clothing.ts presets):
// a resident can be baked WEARING an outfit, cached per (species, look,
// outfit-hash) so a town in N presets costs N bakes; outfitPresetFor maps a
// stable hash to the same outfit forever; the avatar factory dresses via the
// `outfitFor` hook. Headless THREE (no WebGL), like the sibling suites.

import { describe, it, expect } from "@jest/globals";
import type * as THREE from "three";
import {
  OUTFIT_PRESET_COUNT,
  outfitPresetFor,
  clampOutfit,
} from "@shared/world-engine/creatures/clothing.js";
import {
  getSpeciesAssets,
  createBakedCreature,
  createDynamicCreature,
  createCreatureAvatarFactory,
} from "@shared/world-engine/creatures/creature-model.js";
import type { AvatarFrame } from "@shared/world-engine/render3d.js";

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Vertex count of a baked clip frame. */
const idleVerts = (assets: ReturnType<typeof getSpeciesAssets>): number =>
  assets.clips.get("idle")!.frames[0].geometry.getAttribute("position").count;

/** First Mesh found under an object tree (the baked avatar's shared-geometry mesh). */
function findMesh(root: THREE.Object3D): THREE.Mesh {
  let mesh: THREE.Mesh | undefined;
  root.traverse((o) => {
    if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
  });
  if (!mesh) throw new Error("no mesh under avatar object");
  return mesh;
}

describe("outfitPresetFor — deterministic wardrobe", () => {
  it("offers 4–6 presets, each a valid clamped outfit", () => {
    expect(OUTFIT_PRESET_COUNT).toBeGreaterThanOrEqual(4);
    expect(OUTFIT_PRESET_COUNT).toBeLessThanOrEqual(6);
    for (let i = 0; i < OUTFIT_PRESET_COUNT; i++) {
      const outfit = outfitPresetFor(i);
      expect(outfit.garments.length).toBeGreaterThan(0);
      // Clamp is a no-op: the presets are already in range.
      expect(clampOutfit(outfit)).toEqual(outfit);
      for (const g of outfit.garments) {
        expect(g.color).toMatch(HEX);
        expect(g.accentColor).toMatch(HEX);
      }
    }
  });

  it("same hash → same outfit forever (fresh copies, wrap-around, negatives)", () => {
    const a = outfitPresetFor(3);
    const b = outfitPresetFor(3);
    expect(b).toEqual(a); // identical content...
    expect(b).not.toBe(a); // ...but a fresh copy (safe to tweak)
    expect(b.garments[0]).not.toBe(a.garments[0]);
    expect(outfitPresetFor(3 + OUTFIT_PRESET_COUNT * 7)).toEqual(a);
    expect(outfitPresetFor(-1)).toEqual(outfitPresetFor(OUTFIT_PRESET_COUNT - 1));
    expect(() => outfitPresetFor(Number.NaN)).not.toThrow();
  });

  it("presets are varied — includes shirt+pants combos and a dress", () => {
    const wardrobes = Array.from({ length: OUTFIT_PRESET_COUNT }, (_, i) =>
      outfitPresetFor(i).garments.map((g) => g.kind).sort().join("+"),
    );
    expect(wardrobes.some((w) => w.includes("shirt") && w.includes("pants"))).toBe(true);
    expect(wardrobes.some((w) => w.includes("dress"))).toBe(true);
    // Distinct outfits, not one preset repeated (colors differ even when kinds match).
    const fullFingerprints = new Set(
      Array.from({ length: OUTFIT_PRESET_COUNT }, (_, i) => JSON.stringify(outfitPresetFor(i))),
    );
    expect(fullFingerprints.size).toBe(OUTFIT_PRESET_COUNT);
  });
});

describe("dressed bakes — cached per (species, look, outfit)", () => {
  it("a dressed bake has more vertices than the bare one (garment shells)", () => {
    const bare = getSpeciesAssets("human");
    const dressed = getSpeciesAssets("human", {}, outfitPresetFor(0));
    expect(idleVerts(dressed)).toBeGreaterThan(idleVerts(bare));
    // Dressed walk frames carry the garments too.
    expect(dressed.clips.has("walk")).toBe(true);
    for (const f of dressed.clips.get("walk")!.frames) {
      expect(f.geometry.getAttribute("position").count).toBeGreaterThan(0);
    }
  });

  it("bare path is unchanged: no-outfit lookups hit the same cache entry", () => {
    expect(getSpeciesAssets("human")).toBe(getSpeciesAssets("human", {}));
    expect(getSpeciesAssets("human")).toBe(getSpeciesAssets("human", {}, undefined));
    // An EMPTY outfit is bare too — no phantom extra bake.
    expect(getSpeciesAssets("human", {}, { garments: [] })).toBe(getSpeciesAssets("human"));
  });

  it("one cache entry per preset: same preset shares a bake, different presets don't", () => {
    const p0a = getSpeciesAssets("human", {}, outfitPresetFor(0));
    const p0b = getSpeciesAssets("human", {}, outfitPresetFor(0));
    const p1 = getSpeciesAssets("human", {}, outfitPresetFor(1));
    expect(p0b).toBe(p0a); // same outfit content → same bake (town-scale sharing)
    expect(p1).not.toBe(p0a); // distinct preset → distinct bake
    expect(p0a).not.toBe(getSpeciesAssets("human")); // and distinct from bare
  });

  it("createBakedCreature and createDynamicCreature accept an outfit", () => {
    const baked = createBakedCreature("human", { heightM: 1.7, outfit: outfitPresetFor(2) });
    expect(findMesh(baked.object).geometry.getAttribute("position").count).toBeGreaterThan(
      idleVerts(getSpeciesAssets("human")),
    );
    baked.dispose();
    const dyn = createDynamicCreature("human", { heightM: 1.7, outfit: outfitPresetFor(4) });
    const dynVerts = findMesh(dyn.object).geometry.getAttribute("position").count;
    const bareDyn = createDynamicCreature("human", { heightM: 1.7 });
    expect(dynVerts).toBeGreaterThan(findMesh(bareDyn.object).geometry.getAttribute("position").count);
    for (let i = 0; i < 3; i++) dyn.update(1 / 30, { speed01: 0.5 });
    dyn.dispose();
    bareDyn.dispose();
  });
});

describe("avatar factory — outfitFor hook", () => {
  it("dresses residents per avatar id without touching the internals", () => {
    const factory = createCreatureAvatarFactory({
      speciesFor: () => "human",
      heightM: 1.7,
      outfitFor: (avatarId) => (avatarId === "bare-npc" ? undefined : outfitPresetFor(avatarId.length)),
    });
    const dressedAvatar = factory("resident-7", false);
    const bareAvatar = factory("bare-npc", false);
    const dressedVerts = findMesh(dressedAvatar.object).geometry.getAttribute("position").count;
    const bareVerts = findMesh(bareAvatar.object).geometry.getAttribute("position").count;
    expect(dressedVerts).toBeGreaterThan(bareVerts);
    // Still drivable like any avatar.
    const frame = { state: { fx: 0, fy: 1 }, speed: 1.2 } as unknown as AvatarFrame;
    expect(() => dressedAvatar.update(frame, 1 / 30)).not.toThrow();
    dressedAvatar.dispose();
    bareAvatar.dispose();
  });
});
