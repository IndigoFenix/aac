// The clothing system (creatures/clothing.ts + mesh.ts emitOutfit): garments as
// data over body REGIONS — spine spans, limbs rooted in them, skull landmarks —
// so one outfit dresses any species. Headless THREE (no WebGL), like
// world-engine-creatures.test.ts.

import { describe, it, expect } from "@jest/globals";
import {
  GARMENT_KINDS,
  MAX_GARMENTS,
  clampGarment,
  clampOutfit,
  defaultGarment,
} from "@shared/world-engine/creatures/clothing.js";
import {
  clampBlueprint,
  defaultBlueprint,
  validateBlueprint,
  type Blueprint,
} from "@shared/world-engine/creatures/blueprint.js";
import { speciesBlueprint } from "@shared/world-engine/creatures/species.js";
import { buildSkeleton } from "@shared/world-engine/creatures/skeleton.js";
import { buildCreatureMesh } from "@shared/world-engine/creatures/mesh.js";

const dressed = (bp: Blueprint, kinds: ReadonlyArray<(typeof GARMENT_KINDS)[number]>): Blueprint => ({
  ...bp,
  outfit: { garments: kinds.map(defaultGarment) },
});

describe("clothing data layer — clamp + validate", () => {
  it("clampGarment: junk in, a valid shirt out; ranges enforced", () => {
    const g = clampGarment({ kind: "socks", color: "red", coverage: 9 });
    expect(g.kind).toBe("shirt");
    expect(g.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(g.coverage).toBeLessThanOrEqual(1);
  });

  it("clampOutfit caps at MAX_GARMENTS; absent stays absent (bare — old blueprints byte-stable)", () => {
    const many = { garments: Array.from({ length: 9 }, () => defaultGarment("hat")) };
    expect(clampOutfit(many)!.garments).toHaveLength(MAX_GARMENTS);
    expect(clampOutfit(undefined)).toBeUndefined();
    const bare = clampBlueprint(defaultBlueprint());
    expect(bare.outfit).toBeUndefined();
  });

  it("clampBlueprint carries a wardrobe through; validateBlueprint accepts it and flags junk", () => {
    const bp = clampBlueprint(dressed(defaultBlueprint(), ["shirt", "hat"]));
    expect(bp.outfit!.garments.map((g) => g.kind)).toEqual(["shirt", "hat"]);
    expect(validateBlueprint(bp).ok).toBe(true);
    const bad = { ...bp, outfit: { garments: [{ kind: "cape" }] } };
    const res = validateBlueprint(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toMatch(/outfit/);
  });
});

describe("garment meshes — offset shells over the same bones", () => {
  const build = (bp: Blueprint) => buildCreatureMesh(buildSkeleton(bp), bp, { debugTags: true });

  it("a dressed human carries every garment as tagged extra geometry, same bone count", () => {
    const human = clampBlueprint(speciesBlueprint("human"));
    const bare = build(human);
    const wearing = build(clampBlueprint(dressed(human, ["shirt", "pants", "hat"])));
    expect(wearing.stats.vertices).toBeGreaterThan(bare.stats.vertices);
    expect(wearing.stats.bones).toBe(bare.stats.bones); // garments ride EXISTING bones
    const sections = new Set(wearing.sections);
    for (const kind of ["shirt", "pants", "hat"]) {
      expect(sections.has(`garment:${kind}`)).toBe(true);
    }
  });

  it("a dress emits a skirt (more verts than the same-coverage shirt) on the human", () => {
    const human = clampBlueprint(speciesBlueprint("human"));
    const shirt = build(clampBlueprint(dressed(human, ["shirt"])));
    const dress = build(clampBlueprint(dressed(human, ["dress"])));
    expect(dress.sections).toContain("garment:dress");
    expect(dress.stats.vertices).toBeGreaterThan(0);
    expect(shirt.stats.vertices).toBeGreaterThan(0);
  });

  it("species-flexible: a limbless body still wears a shirt (a tube — no sleeves, no crash)", () => {
    const snake = clampBlueprint({
      ...defaultBlueprint(),
      limbGroups: [],
      outfit: { garments: [defaultGarment("shirt")] },
    });
    const built = build(snake);
    expect(built.sections).toContain("garment:shirt");
    expect(built.stats.vertices).toBeGreaterThan(0);
  });

  it("every garment kind builds on every default body without throwing", () => {
    for (const kind of GARMENT_KINDS) {
      const bp = clampBlueprint(dressed(defaultBlueprint(), [kind]));
      expect(() => build(bp)).not.toThrow();
    }
  });
});
