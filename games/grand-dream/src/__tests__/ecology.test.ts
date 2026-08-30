/**
 * Ecology (planet/ecology.ts): biomes emerge from species niches +
 * interactions. THE HEADLINE CHECK — trees and horses occupy DIFFERENT
 * places even though both like temperate, non-frozen land, because forest
 * shades out the grass horses graze.
 */
import { describe, it, expect } from "vitest";
import { buildPlanetWorld } from "@shared/world-engine/planet/planet-game";
import {
  ecologyFields, applyEcology, DEFAULT_BIOSPHERE, band,
} from "@shared/world-engine/planet/ecology";
import type { GameSettings } from "@shared/world-engine/kernel/manifest";

const game: GameSettings = {
  scope: "planet",
  world: {
    topology: { kind: "cube-sphere", faceN: 24 },
    geology: { seed: 7, epochs: 350, continentR: 0.38 },
    settle: true,
    radius: 6_371_000,
  },
  initialFocus: null, avatar: false, avatarSpecies: "human", mods: [], canFly: false, creativeMode: false, entities: null, scale: null,
};

describe("ecology — biomes from species", () => {
  const built = buildPlanetWorld(game);
  const res = ecologyFields(built.grid, { species: DEFAULT_BIOSPHERE, seaHeight: 3 });
  const ti = res.keys.indexOf("tree");
  const gi = res.keys.indexOf("grass");
  const hi = res.keys.indexOf("horse");

  const cellsWithBiome = (i: number) => {
    const out: number[] = [];
    for (let c = 0; c < built.grid.topo.n; c++) if (res.biome[c] === i) out.push(c);
    return out;
  };

  it("builds a forest belt AND a steppe belt (neither empty)", () => {
    expect(cellsWithBiome(ti).length).toBeGreaterThan(20);
    expect(cellsWithBiome(gi).length).toBeGreaterThan(20);
  });

  it("TREES AND HORSES DON'T LIVE IN THE SAME PLACE (the check)", () => {
    // Horses live where grass dominates — count how many horse-viable cells
    // are also forest-dominant. Competition should make that ~none.
    let horseCells = 0;
    let horseInForest = 0;
    for (let c = 0; c < built.grid.topo.n; c++) {
      if (res.abundance.horse[c] < 0.3) continue;
      horseCells++;
      if (res.biome[c] === ti) horseInForest++;
    }
    expect(horseCells).toBeGreaterThan(10); // horses do exist
    // Overwhelmingly disjoint: forest is not where the horses are.
    expect(horseInForest / horseCells).toBeLessThan(0.05);
  });

  it("forest suppresses grass: where forest DOMINATES, grass is held down", () => {
    // Grass in forest-dominant cells vs grass in open (grass-dominant) cells:
    // the canopy rule must make the former markedly lower.
    let forestGrass = 0, forestN = 0, openGrass = 0, openN = 0;
    for (let c = 0; c < built.grid.topo.n; c++) {
      if (res.biome[c] === ti) { forestGrass += res.abundance.grass[c]; forestN++; }
      else if (res.biome[c] === gi) { openGrass += res.abundance.grass[c]; openN++; }
    }
    expect(forestN).toBeGreaterThan(0);
    expect(openN).toBeGreaterThan(0);
    expect(forestGrass / forestN).toBeLessThan(0.5 * (openGrass / openN));
  });

  it("horses require grass: no horses where grass is absent", () => {
    for (let c = 0; c < built.grid.topo.n; c++) {
      if (res.abundance.grass[c] < 0.05) expect(res.abundance.horse[c]).toBeLessThan(0.05);
    }
  });

  it("is deterministic and writes a biome field (0 = barren/sea/ice)", () => {
    const again = ecologyFields(built.grid, { species: DEFAULT_BIOSPHERE, seaHeight: 3 });
    expect(Array.from(again.biome)).toEqual(Array.from(res.biome));
    const b2 = buildPlanetWorld(game);
    applyEcology(b2.grid, { species: DEFAULT_BIOSPHERE, seaHeight: 3, perSpecies: true });
    expect(b2.grid.fields.biome).toBeDefined();
    expect(b2.grid.fields.eco_tree).toBeDefined();
    // Sea/ice cells are barren (0) in the folded field.
    for (let c = 0; c < b2.grid.topo.n; c++) {
      if (b2.grid.fields.height[c] < 3) expect(b2.grid.fields.biome[c]).toBe(0);
    }
  });

  it("every organism links to a real model in the creature registry", async () => {
    const { getSpecies } = await import("@shared/world-engine/creatures/species");
    for (const s of DEFAULT_BIOSPHERE) {
      expect(s.model, s.key).toBeDefined();
      expect(getSpecies(s.model!), `${s.key} → ${s.model}`).toBeDefined();
    }
    // Plants AND animals both resolve — the ecology field is the WHERE, the
    // model is the WHAT that grows/grazes there.
    expect(getSpecies(DEFAULT_BIOSPHERE.find(s => s.key === "tree")!.model!)!.kind).toBe("plant");
    expect(getSpecies(DEFAULT_BIOSPHERE.find(s => s.key === "horse")!.model!)!.kind).toBe("creature");
  });

  it("the tolerance window is a smooth 0..1 hump", () => {
    expect(band(1.0, { lo: 0, opt: 1.0, hi: 2.0 })).toBeCloseTo(1, 6);
    expect(band(0, { lo: 0, opt: 1.0, hi: 2.0 })).toBeCloseTo(0, 6);
    expect(band(-1, { lo: 0, opt: 1.0 })).toBe(0);
    expect(band(5, { opt: 1.0 })).toBe(1); // one-sided past the opt
  });
});
