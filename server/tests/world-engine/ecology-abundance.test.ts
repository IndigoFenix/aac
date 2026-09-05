// PER-SPECIES ECOLOGY — the one source of "how much of species X lives here".
//
// `applyEcology` has always COMPUTED a per-cell abundance for every species
// and then, unless asked for `perSpecies`, thrown it away — one dominance
// integer per cell survived. `planet-game.ts` never asked, so FIVE consumers
// sat on dead branches or approximated the fact:
//
//   1. `kernel/civ/tri.ts`  — timberland fell back to the generic `plant`
//   2. `kernel/civ/plan.ts`   halo, and PASTURE WAS 0 FOR EVERY SITE.
//   3. `kernel/civ/travel.ts` — priced forest/grass off-road steps against
//      fields that did not exist, so every interstate was solved on a planet
//      with no woods.
//   4. `games/world-lab/src/flora-field.ts` — a four-bucket count table.
//   5. `interaction/quest/wilderness.ts` — ABSOLUTE counts, so extent and
//      abundance were the same number and the two tree authorities disagreed
//      by 5.4× where they met.
//
// This suite pins the shape of the switched-on fact: the encoding, the
// density law, the two authorities agreeing, and the legacy arm staying
// byte-identical wherever no ecology is baked. DB-free and planet-free —
// a field bag stands in for a substrate, as `natural-products.test.ts` does.

import { describe, it, expect } from "@jest/globals";
import type { CellGrid } from "@shared/world-engine/kernel/cells/index.js";
import {
  applyEcology, ecoAbundanceAt, ecoFieldName, standDensityPerHa, standCountFor,
  DEFAULT_BIOSPHERE, TREE, GRASS,
} from "@shared/world-engine/planet/ecology.js";
import {
  buildWilderness, wildMixForBiome, LEGACY_SCATTER_SIDE_M,
} from "@shared/world-engine/interaction/quest/wilderness.js";
import {
  charterBoxAt, charterReachCells, FOUNDING_CHARTER_R,
} from "@shared/world-engine/planet/cities.js";

/** Only `fields` is read by the readers under test. */
const bag = (fields: Record<string, Float64Array>): CellGrid =>
  ({ fields }) as unknown as CellGrid;

/** A 1-D lattice whose `disk` is a clamped window — enough for a box sum. */
function lineGrid(fields: Record<string, Float64Array>, n: number): CellGrid {
  return {
    fields,
    topo: {
      n,
      disk(i: number, r: number, visit: (c: number, d: number) => void) {
        for (let c = Math.max(0, i - r); c <= Math.min(n - 1, i + r); c++) visit(c, Math.abs(c - i));
      },
    },
  } as unknown as CellGrid;
}

const TILE_HA = 4; // the flora field's 200 m tile

describe("① the abundance is KEPT — applyEcology's perSpecies switch", () => {
  /** Two climated land cells: one wet-and-warm (forest), one drier (steppe). */
  const climated = (): CellGrid => lineGrid({
    height: Float64Array.from([9, 9]),
    rain: Float64Array.from([1.0, 0.5]),
    tempC: Float64Array.from([18, 16]),
    fertility: Float64Array.from([5, 5]),
  }, 2);

  it("writes eco_<key> ×100 for every species — and NOTHING without the flag", () => {
    const off = climated();
    applyEcology(off, { species: DEFAULT_BIOSPHERE, seaHeight: 3 });
    expect(off.fields.biome).toBeDefined();
    for (const s of DEFAULT_BIOSPHERE) expect(off.fields[ecoFieldName(s.key)]).toBeUndefined();

    const on = climated();
    const res = applyEcology(on, { species: DEFAULT_BIOSPHERE, seaHeight: 3, perSpecies: true });
    for (const s of DEFAULT_BIOSPHERE) {
      const arr = on.fields[ecoFieldName(s.key)];
      expect(arr).toBeDefined();
      // The encoding: abundance ×100, rounded — and nobody outside
      // ecology.ts may spell it (`ecoAbundanceAt` is the only reader).
      expect(arr![0]).toBe(Math.round(res.abundance[s.key]![0]! * 100));
    }
    // The biome integer is IDENTICAL either way — the switch adds, never moves.
    expect(Array.from(on.fields.biome!)).toEqual(Array.from(off.fields.biome!));
  });

  it("ecoAbundanceAt is the ONE reader — 0..1, and null on a substrate with none", () => {
    const g = climated();
    applyEcology(g, { species: DEFAULT_BIOSPHERE, seaHeight: 3, perSpecies: true });
    const a = ecoAbundanceAt(g, 0)!;
    expect(a).not.toBeNull();
    for (const s of DEFAULT_BIOSPHERE) {
      expect(a[s.key]).toBeGreaterThanOrEqual(0);
      expect(a[s.key]).toBeLessThanOrEqual(1);
    }
    // The forest cell is tree-dominant, the drier one is not.
    expect(a.tree).toBeGreaterThan(ecoAbundanceAt(g, 1)!.tree!);
    // A grid that never baked one answers NULL — a real answer, so a caller
    // keeps its legacy arm instead of inventing an abundance from the biome.
    expect(ecoAbundanceAt(bag({ height: Float64Array.from([9]) }), 0)).toBeNull();
  });
});

describe("② one density law — the two tree authorities cannot disagree", () => {
  // A tree-dominant cell at the MEASURED median of the shipped biosphere
  // (eco_tree 0.35 over seeds 1 / 7 / 42, faceN 24) — the abundance the
  // `standPerHa` constants are calibrated at.
  const MEDIAN_FOREST = { tree: 0.35, grass: 0.0, horse: 0.0 };

  it("reproduces the SHIPPED flora densities at the abundance they were read at", () => {
    // 60 oaks on a 4 ha tile = the shipped OAK_COUNT[forest]; 44 tufts on a
    // grass-dominant tile = the shipped GRASS_COUNT[steppe].
    expect(standCountFor("oak", MEDIAN_FOREST, TILE_HA)).toBe(60);
    expect(standCountFor("grass", { tree: 0, grass: 0.37, horse: 0 }, TILE_HA)).toBe(44);
    expect(TREE.standPerHa).toBe(43);
    expect(GRASS.standPerHa).toBe(30);
  });

  it("is LINEAR in abundance and answers 0 for ground nothing claims", () => {
    expect(standDensityPerHa("oak", { tree: 0 })).toBe(0);
    expect(standDensityPerHa("oak", { tree: 1 })).toBe(TREE.standPerHa!);
    expect(standDensityPerHa("oak", { tree: 0.5 })).toBeCloseTo(TREE.standPerHa! / 2, 10);
    // A model no species claims stands nowhere — never a silent default.
    expect(standDensityPerHa("rock", { tree: 1 })).toBe(0);
    expect(standDensityPerHa("ungulate", { horse: 1 })).toBe(0); // HORSE declares no stand
  });

  it("🎯 THE SEAM: the flora tile and the scatter answer the same oaks/ha at ANY extent", () => {
    const eco = MEDIAN_FOREST;
    const perHa = standDensityPerHa("oak", eco);
    const mix = wildMixForBiome(1, 4242, undefined, eco);
    const oakLine = mix.find((m) => m.species === "oak")!;
    // Same law, same number — not two tables that happen to agree.
    expect(oakLine.perHa).toBe(perHa);
    // …and the FLORA tile reads it too.
    expect(standCountFor("oak", eco, TILE_HA) / TILE_HA).toBeCloseTo(perHa, 1);
    // Resolved through the real builder at three extents, the DENSITY holds.
    for (const side of [LEGACY_SCATTER_SIDE_M, 240, 320]) {
      const w = buildWilderness({ seed: 4242, side, mix });
      const oaks = w.features.filter((f) => f.species === "oak").length;
      expect(oaks / ((side * side) / 10_000)).toBeCloseTo(perHa, 0);
    }
  });

  it("extent no longer thins the land — the ABSOLUTE arm shows what it used to do", () => {
    const legacy = wildMixForBiome(1, 4242); // no eco ⇒ absolute counts
    expect(legacy.every((m) => m.perHa === undefined)).toBe(true);
    const small = buildWilderness({ seed: 4242, side: 190, mix: legacy });
    const big = buildWilderness({ seed: 4242, side: 320, mix: legacy });
    const oaksOf = (w: { features: Array<{ species: string }> }): number =>
      w.features.filter((f) => f.species === "oak").length;
    // The same ten trees, spread over 2.8× the ground — extent and abundance
    // were one number, which is the defect this round closed.
    expect(oaksOf(small)).toBe(10);
    expect(oaksOf(big)).toBe(10);
  });

  it("the non-vegetation lines reproduce their legacy counts at the reference area", () => {
    // 🚫 NO BALANCE MOVED. Rock, sheep and cow have no biosphere row to read,
    // so their densities are the switch's own counts re-expressed at
    // LEGACY_SCATTER_SIDE_M — a founding-age town scatters exactly what it
    // always did on every line except the trees.
    const eco = { tree: 0.12, grass: 0.65, horse: 0.79 }; // a grazer-range cell
    const withEco = buildWilderness({
      seed: 4242, side: LEGACY_SCATTER_SIDE_M, mix: wildMixForBiome(3, 4242, undefined, eco),
    });
    const legacy = buildWilderness({
      seed: 4242, side: LEGACY_SCATTER_SIDE_M, mix: wildMixForBiome(3, 4242),
    });
    const tally = (w: typeof withEco): Record<string, number> => {
      const t: Record<string, number> = {};
      for (const f of w.features) if (f.species !== "oak") t[f.species] = (t[f.species] ?? 0) + 1;
      for (const c of w.creatures) if (c.species) t[c.species] = (t[c.species] ?? 0) + 1;
      return t;
    };
    expect(tally(withEco)).toEqual(tally(legacy));
  });

  it("⚖️ NOTHING REACHABLE WITHOUT AN ECOLOGY MOVED — the legacy arm, verbatim", () => {
    for (const biome of [0, 1, 2, 3]) {
      for (const seed of [0, 1, 7, 4242]) {
        const mix = wildMixForBiome(biome, seed);
        expect(mix.every((m) => m.perHa === undefined)).toBe(true);
        expect(buildWilderness({ seed, side: 240, mix })).toEqual(
          buildWilderness({ seed, side: 240, mix: wildMixForBiome(biome, seed) }),
        );
      }
    }
    // The shipped per-biome shape is untouched (the pins in
    // symbol-game-wilderness.test.ts read the same numbers).
    //
    // 🌿 MOVED BY THE WILD LARDER (2026-09-04): the forage lines sit between the
    // sprinkle and the rock, so the SWITCH'S OWN content is named rather than
    // counted positionally. Those numbers — and the sprinkle's — are unchanged;
    // what moved is the length of the array they used to sit in. (This case is
    // about the ECOLOGY arm, and no forage line reads `eco` at all: the whole
    // "nothing reachable without an ecology moved" claim above is intact.)
    const structural = (b: number): string[] =>
      wildMixForBiome(b, 0)
        .filter((e) => ["oak", "rock", "sheep", "cow"].includes(e.species))
        .map((e) => `${e.species}:${e.count}`);
    expect(structural(1)).toEqual(["oak:10", "rock:6"]);
    expect(wildMixForBiome(1, 0)[1]!.count).toBe(2);
    expect(structural(3)).toEqual(["oak:3", "rock:5", "sheep:2", "cow:1"]);
    expect(wildMixForBiome(3, 0)[1]!.count).toBe(1);
  });
});

describe("③ the charter is a MEASUREMENT, with one derivation", () => {
  /** A 21-cell line of ground, so a widening box keeps finding more of it.
   *  The site sits at cell 10 — the middle, clear of both ends. */
  const N = 21;
  const SITE = 10;
  const grid = lineGrid({
    fertility: Float64Array.from({ length: N }, () => 1),
    ore: Float64Array.from({ length: N }, (_, i) => (i === SITE + 1 ? 2 : 0)),
    plant: Float64Array.from({ length: N }, () => 7),
  }, N);

  it("charterBoxAt sums the radius the caller asks for — and defaults to a founding's", () => {
    expect(FOUNDING_CHARTER_R).toBe(3);
    // Radius 3 = 7 cells of the line: 7 fertility, 7x7 plant, the one lode.
    expect(charterBoxAt(grid, SITE)).toEqual({ farmland: 7, ore_access: 2, timberland: 49 });
    expect(charterBoxAt(grid, SITE, FOUNDING_CHARTER_R)).toEqual(charterBoxAt(grid, SITE));
    // A narrower reach reads less ground; a field the grid lacks reads 0.
    expect(charterBoxAt(grid, SITE, 1)).toEqual({ farmland: 3, ore_access: 2, timberland: 21 });
    expect(charterBoxAt(lineGrid({}, N), SITE).farmland).toBe(0);
  });

  it("the growth law is DISCRETE and MONOTONE — a charter that changes HAPPENED", () => {
    // One more cell per doubling of the settlement's structures. The answer
    // is an integer over a counter that only rises, so it steps at 1/3/7/15
    // and can never drift or reverse — the hysteresis is structural, which
    // is what a number feeding founding decisions and state-book potential
    // needs.
    expect(charterReachCells(0)).toBe(FOUNDING_CHARTER_R);
    expect([1, 2].map(charterReachCells)).toEqual([4, 4]);
    expect([3, 6].map(charterReachCells)).toEqual([5, 5]);
    expect([7, 14].map(charterReachCells)).toEqual([6, 6]);
    expect(charterReachCells(15)).toBe(7);
    let prev = 0;
    for (let b = 0; b < 4000; b++) {
      const r = charterReachCells(b);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
    expect(charterReachCells(1e9)).toBe(8); // capped at the founding-scan ceiling
    expect(charterReachCells(-5)).toBe(FOUNDING_CHARTER_R); // never below a founding
  });

  it("a grown site measures MORE ground, and re-derives it from `buildings` alone", () => {
    // 🚨 NOTHING IS STORED. The charter is (cell, buildings) → charterBoxAt,
    // and `buildings` already rides `SerializedFoundedSite`, so a reloaded
    // site reproduces its charter exactly.
    const at = (buildings: number) => charterBoxAt(grid, SITE, charterReachCells(buildings));
    expect(at(0).timberland).toBeLessThan(at(7).timberland);
    expect(at(0).farmland).toBeLessThan(at(7).farmland);
    expect(at(7)).toEqual(at(14)); // same reach ⇒ the SAME number, twice
    expect(at(3)).toEqual(charterBoxAt(grid, SITE, 5)); // derived, not remembered
  });
});
