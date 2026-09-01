// Tests for the creature builder ported into shared/world-engine/creatures.
//
// Covers the three new layers on top of the copied seagull geometry core:
//   • the SPECIES REGISTRY (species.ts) — the game-facing lookup by stable id,
//   • the runtime CreatureModel (creature-model.ts) — dynamic rebuild vs. the
//     PRELOADED baked-clip path, and the shared per-species asset cache,
//   • the render3d AvatarModelFactory bridge.
//
// Uses THREE (buildCreatureMesh + the models) but never a WebGL context, so it
// runs headless like world-render3d.test.ts / world-object-models.test.ts.

import { describe, it, expect } from "@jest/globals";
import {
  getSpecies,
  requireSpecies,
  listSpecies,
  speciesOfKind,
  speciesBlueprint,
  registerSpecies,
} from "@shared/world-engine/creatures/species.js";
import { foodPlants } from "@shared/world-engine/products.js";
import { buildSkeleton } from "@shared/world-engine/creatures/skeleton.js";
import { buildCreatureMesh } from "@shared/world-engine/creatures/mesh.js";
import {
  getSpeciesAssets,
  createBakedCreature,
  createDynamicCreature,
  createCreatureAvatarFactory,
} from "@shared/world-engine/creatures/creature-model.js";
import type { AvatarFrame } from "@shared/world-engine/render3d.js";

describe("species registry", () => {
  it("knows the human and tags its kind", () => {
    const human = getSpecies("human");
    expect(human).toBeDefined();
    expect(human!.kind).toBe("creature");
  });

  it("throws on an unknown id (a spec naming an unknown species is an error)", () => {
    expect(() => requireSpecies("dragon-that-does-not-exist")).toThrow();
    expect(getSpecies("dragon-that-does-not-exist")).toBeUndefined();
  });

  it("catalogues creatures, plants and fruit", () => {
    expect(listSpecies().length).toBeGreaterThan(3);
    expect(speciesOfKind("fruit").map((s) => s.id)).toContain("apple");
    expect(speciesOfKind("plant").map((s) => s.id)).toContain("oak");
  });

  it("clamps a species blueprint into a full body plan", () => {
    const bp = speciesBlueprint("human");
    expect(bp.version).toBe(1);
    // The human is a biped with hands: two bilateral limb groups.
    expect(bp.limbGroups.length).toBe(2);
  });

  it("lets a game register its own species", () => {
    registerSpecies({ id: "test-critter", name: "Test Critter", kind: "creature", blueprint: {} });
    expect(getSpecies("test-critter")?.name).toBe("Test Critter");
  });
});

describe("sheep species", () => {
  it("is a registered creature", () => {
    const sheep = getSpecies("sheep");
    expect(sheep).toBeDefined();
    expect(sheep!.kind).toBe("creature");
  });

  it("is a stocky short-legged quadruped that builds a mesh", () => {
    const bp = speciesBlueprint("sheep");
    // TWO bilateral groups, one pair each: a forelimb and a hindlimb are not
    // copies of one limb, because the knee's fore/aft fold is a per-GROUP dial
    // and a tetrapod folds its two pairs opposite ways. See
    // server/tests/world-engine/creature-limbs.test.ts for the law.
    expect(bp.limbGroups.length).toBe(2);
    expect(bp.limbGroups.map((g) => g.count)).toEqual([1, 1]);
    expect(bp.limbGroups[0].restFlexion).toBeLessThan(0); // fore: elbow BACK
    expect(bp.limbGroups[1].restFlexion).toBeGreaterThan(0); // hind: knee FORWARD
    const built = buildCreatureMesh(buildSkeleton(bp), bp);
    expect(built.mesh.isSkinnedMesh).toBe(true);
    expect(built.mesh.geometry.getAttribute("position").count).toBeGreaterThan(0);
  });

  it("bakes idle + walk clips like other creatures", () => {
    const assets = getSpeciesAssets("sheep");
    expect(assets.clips.has("idle")).toBe(true);
    expect(assets.clips.has("walk")).toBe(true);
    expect(assets.clips.get("walk")!.frames.length).toBeGreaterThan(1);
    expect(assets.naturalHeight).toBeGreaterThan(0.3);
  });
});

/** Derived once — the describe below builds one `it` per entry. */
const FOOD_PLANTS = foodPlants();

describe("foodPlants — the bodies behind the food registry", () => {
  // Was `FRUIT_TREES`, a hand-kept `["apple","banana","grape"]` union that went
  // stale the moment `carrot_plant` joined the catalogue — a fruit tree that
  // was neither. The list is now derived, so this describe asserts the BODY
  // invariants (which are the real content) and never the membership, which
  // products.ts owns and natural-products.test.ts pins.

  it("is not empty, and every entry names a distinct food", () => {
    const foods = FOOD_PLANTS.map((e) => e.food);
    expect(foods.length).toBeGreaterThan(0);
    expect(new Set(foods).size).toBe(foods.length);
  });

  it("each food is also a fruit-body species (the market/ground item)", () => {
    for (const { food } of FOOD_PLANTS) {
      expect(requireSpecies(food).kind).toBe("fruit");
    }
  });

  for (const { food, species } of FOOD_PLANTS) {
    it(`${food}: source species "${species}" is a plant bearing visible fruit and builds a mesh`, () => {
      expect(requireSpecies(species).kind).toBe("plant");
      const bp = speciesBlueprint(species);
      const skel = buildSkeleton(bp);
      // Visible fruit: the growth system emitted fruit-body instances.
      const fruitCount = skel.growths.reduce((n, g) => n + g.fruits.length, 0);
      expect(fruitCount).toBeGreaterThan(0);
      const built = buildCreatureMesh(skel, bp);
      expect(built.mesh.geometry.getAttribute("position").count).toBeGreaterThan(0);
    });
  }
});

describe("geometry build (human)", () => {
  it("is deterministic — same blueprint, same skeleton", () => {
    const bp = speciesBlueprint("human");
    const a = buildSkeleton(bp);
    const b = buildSkeleton(bp);
    expect(a.bounds).toEqual(b.bounds);
    expect(a.bones.length).toBe(b.bones.length);
  });

  it("lofts a skinned mesh with bones and vertices", () => {
    const bp = speciesBlueprint("human");
    const built = buildCreatureMesh(buildSkeleton(bp), bp);
    expect(built.mesh.isSkinnedMesh).toBe(true);
    expect(built.skeleton.bones.length).toBeGreaterThan(0);
    expect(built.mesh.geometry.getAttribute("position").count).toBeGreaterThan(0);
  });
});

describe("preloaded (baked) assets", () => {
  it("bakes an idle + walk clip for a walking creature, shared material", () => {
    const assets = getSpeciesAssets("human");
    expect(assets.clips.has("idle")).toBe(true);
    expect(assets.clips.has("walk")).toBe(true);
    expect(assets.clips.get("idle")!.frames.length).toBe(1);
    expect(assets.clips.get("walk")!.frames.length).toBeGreaterThan(1);
    expect(assets.naturalHeight).toBeGreaterThan(0.5);
    expect(assets.material).toBeDefined();
    for (const f of assets.clips.get("walk")!.frames) {
      expect(f.geometry.getAttribute("position").count).toBeGreaterThan(0);
    }
  });

  it("caches assets — a second lookup returns the same instance (one bake)", () => {
    expect(getSpeciesAssets("human")).toBe(getSpeciesAssets("human"));
  });

  it("bakes only a static idle for a fruit body (no walk)", () => {
    const assets = getSpeciesAssets("apple");
    expect(assets.clips.has("idle")).toBe(true);
    expect(assets.clips.has("walk")).toBe(false);
  });
});

describe("runtime models", () => {
  it("baked model swaps to a walk frame when moving", () => {
    const model = createBakedCreature("human", { heightM: 1.7 });
    expect(model.object.children.length).toBeGreaterThan(0);
    const mesh = model.object.children[0] as { geometry: unknown };
    model.update(0, { speed01: 0 });
    const idleGeom = mesh.geometry;
    // Advance a while at a walk — the geometry should leave the idle frame.
    for (let i = 0; i < 20; i++) model.update(0.05, { speed01: 0.6 });
    expect(mesh.geometry).not.toBe(idleGeom);
    model.dispose();
  });

  it("dynamic model rebuilds each frame without throwing", () => {
    const model = createDynamicCreature("human", { heightM: 1.7 });
    expect(model.object.children.length).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) model.update(1 / 30, { speed01: 0.5 });
    expect(() => model.dispose()).not.toThrow();
  });

  it("avatar factory produces a drivable model from an AvatarFrame", () => {
    const factory = createCreatureAvatarFactory({ speciesFor: () => "human", heightM: 1.7 });
    const avatar = factory("participant-1", false);
    expect(avatar.object).toBeDefined();
    const frame = { state: { fx: 0, fy: 1 }, speed: 1.2 } as unknown as AvatarFrame;
    expect(() => avatar.update(frame, 1 / 30)).not.toThrow();
    avatar.dispose();
  });
});
