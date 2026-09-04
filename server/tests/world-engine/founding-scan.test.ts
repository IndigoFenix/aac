// FOUNDING UNIFIED — the scan as the CLOSED-FORM TWIN of Gate A
// (planning-docs/games/world-engine/growth-phase-c-founding-loops.md §1
// stage 3; growth-unification.md §4 "FOUNDING IS SETTLING — one gate, two
// arms").
//
// The unobserved arm (`findFoundingSites`, a cheap pure scan) and the
// observed arm (a band that gathers, banks and settles under Gate A) must
// agree about WHICH LAND IS WORTH SETTLING. This suite pins the algebra that
// makes them one gate, the derivation each tier now consumes, and — the
// user's "the results will often be similar" — the MEASURED overlap of the
// two arms run on one map.
//
// Pure logic + two planet builds. No DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  gateACarryRatio, gateAThreshold, gateAFoundPop, foundingScan,
  gatherBand, stepBandDay, bandCarryCapacity, boxCapacity,
  type Band, type WildSpecies,
} from "@shared/world-engine/kernel/civ/bands.js";
import {
  createGrid, findFoundingSites, type SystemSpec,
} from "@shared/world-engine/kernel/cells/index.js";
import {
  REAL_SCALE, SEASONAL_SCALE, resolveWorldScale, townSpacingM,
  needFillDays, type WorldScale,
} from "@shared/world-engine/scale.js";
import { freightOf, storedFraction, REAL_PORTER_BULK, type Freight } from "@shared/world-engine/freight.js";
import { buildPlanetWorld, planetFoundingOpts } from "@shared/world-engine/planet/planet-game.js";
import { planetCities, REGION_FOUND_POP } from "@shared/world-engine/planet/cities.js";
import { planetRoutes } from "@shared/world-engine/planet/routes.js";
import type { GameSettings } from "@shared/world-engine/kernel/manifest.js";

const FOOD = freightOf("food");
const DURABLE: Freight = { valueDensity: 1, transit: "durable" };
const MILK = freightOf("milk"); // keepDays 1 — the pastoralist's staple

// ─────────────────────────────────────────── the algebra (Gate A, solved)

describe("gateAThreshold — Gate A read as a density", () => {
  it("is the plateau store beating the backs: fill × (1 − dailyKeep) × pack × worth", () => {
    const fill = needFillDays(REAL_SCALE, "hunger");
    const keep = storedFraction(REAL_SCALE, FOOD, 1);
    expect(gateACarryRatio(REAL_SCALE, FOOD)).toBeCloseTo(
      fill * (1 - keep) * REAL_PORTER_BULK * FOOD.valueDensity, 12,
    );
    expect(gateAThreshold(REAL_SCALE, FOOD, 100)).toBeCloseTo(
      100 * (1 + gateACarryRatio(REAL_SCALE, FOOD)), 12,
    );
  });

  it("inverts exactly — the take and the density are ONE relationship", () => {
    for (const pop of [1, 25, 100, 600]) {
      expect(gateAFoundPop(REAL_SCALE, FOOD, gateAThreshold(REAL_SCALE, FOOD, pop))).toBeCloseTo(pop, 9);
    }
  });

  it("a DURABLE staple settles on any surplus at all (ratio 0)", () => {
    expect(gateACarryRatio(REAL_SCALE, DURABLE)).toBe(0);
    expect(gateAThreshold(REAL_SCALE, DURABLE, 100)).toBe(100);
  });

  it("a FRAGILE staple raises the bar by an order of magnitude — pastoralists stay mobile", () => {
    expect(gateACarryRatio(REAL_SCALE, MILK)).toBeGreaterThan(9);
    expect(gateAThreshold(REAL_SCALE, MILK, 100)).toBeGreaterThan(
      10 * gateAThreshold(REAL_SCALE, FOOD, 100),
    );
  });

  it("⚖️ THE METABOLISM CANCELS — the gate names no duration, as the law requires", () => {
    // Worth pinning because it looks like an omission. Appetite and rot ride
    // the SAME dial: `needFillDays = NEED/metabolism` while the pile's
    // half-life is `keepDays/metabolism`, so
    //     fill × (1 − 2^(−1/half))  ≈  (NEED/m) × (ln2 · m / keepDays)
    // and `m` divides out to first order. A world that eats three times as
    // fast rots its granary three times as fast and needs the same crowd —
    // which is settlement-emergence §4b's law ("no settlement rule may name
    // an absolute duration") falling out rather than being imposed.
    const real = gateACarryRatio(REAL_SCALE, FOOD);
    const seasonal = gateACarryRatio(SEASONAL_SCALE, FOOD);
    expect(Math.abs(seasonal - real) / real).toBeLessThan(0.01);
    // …and the first-order form is what both are:
    const firstOrder = (s: WorldScale): number =>
      needFillDays(s, "hunger") * (Math.LN2 / (730 / s.metabolism)) * REAL_PORTER_BULK * FOOD.valueDensity;
    expect(real).toBeCloseTo(firstOrder(REAL_SCALE), 3);
    expect(seasonal).toBeCloseTo(firstOrder(SEASONAL_SCALE), 3);
    // What DOES move it is the staple's own keeping — the dimensionless fact
    // the gate is genuinely about.
    expect(gateACarryRatio(REAL_SCALE, MILK)).toBeGreaterThan(100 * real);
  });

  it("carry is the pack: doubling the porter's load doubles what must be banked", () => {
    const a = gateACarryRatio(REAL_SCALE, FOOD, { portableBulk: REAL_PORTER_BULK });
    const b = gateACarryRatio(REAL_SCALE, FOOD, { portableBulk: 2 * REAL_PORTER_BULK });
    expect(b).toBeCloseTo(2 * a, 12);
  });
});

describe("foundingScan — the tier's whole scan, derived", () => {
  it("the take IS the harvest cap, and the threshold is Gate A's answer to it", () => {
    const scan = foundingScan({ scale: REAL_SCALE, foundPop: 25, cellSizeM: 1_000 });
    expect(scan.maxHarvest).toBe(25);
    expect(scan.threshold).toBeCloseTo(gateAThreshold(REAL_SCALE, FOOD, 25), 12);
    expect(scan.radius).toBe(2);
  });

  it("spacing is the world's own day's walk, in this tier's cells", () => {
    const scan = foundingScan({ scale: REAL_SCALE, foundPop: 25, cellSizeM: 1_000 });
    expect(scan.minSpacing).toBe(Math.round(townSpacingM(REAL_SCALE) / 1_000)); // 25
    // A compressed world crowds its settlements by the same factor.
    const tight = foundingScan({
      scale: resolveWorldScale({ gap_compression: 25 }), foundPop: 25, cellSizeM: 1_000,
    });
    expect(tight.minSpacing).toBe(1);
  });

  it("the CHART FLOOR is a chart limit, never a spacing choice", () => {
    const scan = foundingScan({
      scale: resolveWorldScale({ gap_compression: 10_000 }),
      foundPop: 25, cellSizeM: 1_000, minSpacingFloorCells: 4,
    });
    expect(scan.minSpacing).toBe(4);
  });

  it("a tier that measures in its OWN cells keeps the spacing it declares", () => {
    // No cellSizeM: the tier-0 planet chart, whose cell IS the capital
    // lattice — the day's-walk law is tier 1's.
    expect(foundingScan({ scale: REAL_SCALE, foundPop: 100, minSpacing: 6 }).minSpacing).toBe(6);
  });
});

// ─────────────────── THE CONVERGENCE: both arms, one map (the §3.1 pin) ────

const COLS = 40;
const ROWS = 28;
const SPEC: SystemSpec = {
  id: "twin-map",
  name: "Twin map",
  vars: [{ name: "forage", min: 0, max: 31, initial: 0, init: "flat", int: true }],
  rules: [],
};
const HUMANS: WildSpecies[] = [{ key: "human", field: "forage" }];

/** A deterministic patchy landscape: six fertile pockets of different
 *  richness on bare ground — some rich enough to keep a band, some not. */
function twinMap(): ReturnType<typeof createGrid> {
  const grid = createGrid(SPEC, COLS, ROWS);
  const pockets: Array<[number, number, number, number]> = [
    [7, 7, 3, 12], [18, 6, 2, 9], [30, 8, 3, 6],
    [9, 19, 2, 20], [21, 20, 3, 4], [32, 19, 2, 14],
  ];
  for (const [cx, cy, r, peak] of pockets) {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
        const fall = Math.max(0, peak - 2 * (Math.abs(x - cx) + Math.abs(y - cy)));
        const c = y * COLS + x;
        grid.fields.forage[c] = Math.max(grid.fields.forage[c]!, fall);
      }
    }
  }
  return grid;
}

/** THE OBSERVED ARM, run for real: gather the found-small take at `cell`,
 *  live it day by day off the land's own offer, and ask Gate A's STORE half
 *  every day. Returns the day it settled, or -1 within the horizon.
 *
 *  Pressure is deliberately held at "cornered" — the closed form speaks to
 *  the STORE half only. Circumscription has no density in it (the scan's
 *  stand-in for it is `minSpacing` + `occupied`), and mixing the two halves
 *  would measure the wrong disagreement. This is growth-unification §8's
 *  "the two arms agree on WHERE, never byte-for-byte", made explicit. */
function bandSettlesAt(
  grid: ReturnType<typeof createGrid>, cell: number, take: number,
  radius: number, scale: WorldScale, horizon = 4_000,
): number {
  // The capacity the band lives off is the LAND's offer, which a gather does
  // not drain (tri.ts's `bandFields`: the habitat, never the harvest
  // artifact). Read it before the take and feed it back as a flat field.
  const offer = boxCapacity(grid, ["forage"], cell, radius);
  const work = createGrid(SPEC, COLS, ROWS);
  work.fields.forage.set(grid.fields.forage);
  const band: Band = gatherBand(work, HUMANS, {
    x: cell % COLS, y: (cell / COLS) | 0, cell, density: offer, score: offer,
  }, { radius, maxHarvest: take });
  if (band.size <= 0) return -1;
  const carry = bandCarryCapacity(band, FOOD);
  // Restore the land's offer for the LIFE loop (the habitat is not drained).
  work.fields.forage.set(grid.fields.forage);
  for (let day = 0; day < horizon; day++) {
    const r = stepBandDay(work, band, { scale, radius, fields: ["forage"], freight: FOOD });
    work.fields.forage.set(grid.fields.forage); // the offer is a capacity, not a stock
    if (r.shortfall > 0) return -1; // the band walks before it starves
    if (band.store > carry) return day;
  }
  return -1;
}

describe("THE TWIN CONVERGENCE — the scan places settlements where bands settle", () => {
  const scale = REAL_SCALE;
  const FOUND_POP = 25;
  const scan = foundingScan({ scale, foundPop: FOUND_POP, minSpacing: 5 });

  it("cell for cell, the closed form and the lived gate agree", () => {
    const grid = twinMap();
    const wet = undefined;
    const scanYes = new Set<number>();
    const bandYes = new Set<number>();
    for (let c = 0; c < COLS * ROWS; c++) {
      let density = 0;
      grid.topo.disk(c, scan.radius, cell => { density += grid.fields.forage[cell]!; });
      if (density <= 0) continue; // bare ground: neither arm has an opinion
      if (density >= scan.threshold) scanYes.add(c);
      if (bandSettlesAt(grid, c, scan.maxHarvest!, scan.radius, scale) >= 0) bandYes.add(c);
    }
    void wet;
    const both = [...scanYes].filter(c => bandYes.has(c)).length;
    const union = new Set([...scanYes, ...bandYes]).size;
    // MEASURED (recorded in the ledger): the two arms are the SAME
    // inequality, so on the store half they agree exactly.
    expect(union).toBeGreaterThan(0);
    expect(both / union).toBe(1);
    expect(scanYes.size).toBe(bandYes.size);

    // AND THE METRIC IS NOT VACUOUS. A threshold that is NOT Gate A's answer
    // reads worse on the same instrument — so "1.0" is a measurement, not a
    // tautology of how the sets were built.
    const jaccardAt = (thr: number): number => {
      const yes = new Set<number>();
      for (let c = 0; c < COLS * ROWS; c++) {
        let d = 0;
        grid.topo.disk(c, scan.radius, cell => { d += grid.fields.forage[cell]!; });
        if (d > 0 && d >= thr) yes.add(c);
      }
      const hit = [...yes].filter(c => bandYes.has(c)).length;
      return hit / new Set([...yes, ...bandYes]).size;
    };
    expect(jaccardAt(24)).toBeLessThan(0.96);
    expect(jaccardAt(30)).toBeLessThan(0.94);
  }, 120_000);

  it("and the ACCEPTED SETS overlap positionally under one spacing rule", () => {
    const grid = twinMap();
    const scanSites = findFoundingSites(grid, scan);
    // The band arm, greedy under the identical spacing: settle-capable cells
    // in the scan's own ranking order.
    const capable = findFoundingSites(grid, { ...scan, threshold: 0, minSpacing: 0 })
      .filter(s => bandSettlesAt(grid, s.cell, scan.maxHarvest!, scan.radius, scale) >= 0);
    const accepted: number[] = [];
    const sp2 = scan.minSpacing * scan.minSpacing;
    for (const s of capable) {
      if (accepted.every(a => grid.topo.dist2(s.cell, a) >= sp2)) accepted.push(s.cell);
    }
    const scanCells = scanSites.map(s => s.cell);
    const both = scanCells.filter(c => accepted.includes(c)).length;
    expect(scanCells.length).toBeGreaterThan(0);
    expect(both).toBe(scanCells.length);
    expect(accepted.length).toBe(scanCells.length);
  }, 180_000);

  it("the twin is NOT perfect, and says where: pressure has no density", () => {
    // Gate A is two halves. The scan's closed form is the STORE half; the
    // circumscription half is a fact about the NEIGHBOURHOOD, which the scan
    // expresses as spacing and occupancy, not as a threshold. Pinned so the
    // approximation stays honest and documented (growth-unification §8).
    expect(scan.threshold).toBeGreaterThan(0);
    expect(scan.minSpacing).toBe(5);
  });
});

// ───────────────────────────── the tiers consume it (the planet, measured)

const planetGame = (scale: unknown): GameSettings => ({
  scope: "planet",
  world: {
    topology: { kind: "cube-sphere", faceN: 24 },
    geology: { seed: 7, epochs: 350, continentR: 0.38 },
    settle: true,
    radius: 2_000,
  },
  initialFocus: null, avatar: false, avatarSpecies: "human", canFly: false,
  creativeMode: false, entities: null, scale,
} as unknown as GameSettings);

describe("the planet tier founds by the derivation", () => {
  it("REAL scale reproduces the authored aesthetic it replaces", () => {
    const spec = planetFoundingOpts(
      { topology: { kind: "cube-sphere", faceN: 24 }, radius: 2_000 } as never, null,
    );
    // The literals this replaced were threshold 100 / minSpacing 6 /
    // maxHarvest 600. Gate A's answer to a hundred-person founding is 101.9 —
    // the aesthetic was already within 2% of the gate, and the harvest cap
    // was the one number that could never bind.
    expect(spec.threshold).toBeCloseTo(101.898, 3);
    expect(spec.minSpacing).toBe(6);
    expect(spec.maxHarvest).toBe(100);
  });

  it("a world that DECLARES its gap gets the spacing derived — and 32 is 6", () => {
    const spec = planetFoundingOpts(
      { topology: { kind: "cube-sphere", faceN: 24 }, radius: 2_000 } as never,
      { gap_compression: 32 },
    );
    // 781.25 m of spacing over a 130.9 m chart cell = 5.97 cells. The 2 km
    // test planet's authored `minSpacing: 6` was always a declaration that
    // its towns stand a compressed day's walk apart; now it says so.
    expect(spec.minSpacing).toBe(6);
  });

  it("the derived scan founds the SAME site set the literals did", () => {
    const built = buildPlanetWorld(planetGame(null));
    const legacy = findFoundingSites(built.grid, {
      threshold: 100, radius: 2, minSpacing: 6, maxHarvest: 600,
    }).filter(s => built.grid.fields.ice[s.cell]! < 1);
    expect(built.sites.map(s => s.cell)).toEqual(legacy.map(s => s.cell));
    expect(built.sites.length).toBe(33);
  }, 120_000);

  it("gap_compression 32 re-lays the ROADS, not the towns: every end becomes a port", () => {
    const R = 2_000;
    const arcM = (a: readonly number[], b: readonly number[]): number =>
      Math.acos(Math.max(-1, Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!))) * R;
    const census = (scaleSpec: unknown): { unclipped: number; ends: number; cities: number } => {
      const built = buildPlanetWorld(planetGame(scaleSpec));
      const cities = planetCities(built);
      const scale = scaleSpec ? resolveWorldScale(scaleSpec as never) : REAL_SCALE;
      const routes = planetRoutes(built, cities, { scale });
      const dirOf = new Map(cities.map(c => [c.cell, c.dir] as const));
      let unclipped = 0;
      let ends = 0;
      for (const r of routes) {
        for (const [id, d] of [[r.a, r.dirs[0]!], [r.b, r.dirs[r.dirs.length - 1]!]] as const) {
          const at = dirOf.get(id as number);
          if (!at) continue;
          ends++;
          if (arcM(at, d) < 1) unclipped++;
        }
      }
      return { unclipped, ends, cities: cities.length };
    };
    const before = census(null);
    const after = census({ gap_compression: 32 });
    // Same 22 towns either way — the SITES do not move (the spacing the
    // declaration derives is the one the chart already imposed).
    expect(after.cities).toBe(before.cities);
    expect(after.ends).toBe(before.ends);
    // What moves is the extent, and with it the ports: 16 of 34 road ends run
    // to the town centre at a 450 m extent; at the derived 195 m, none does.
    //
    // 🌲 WAS 18, AND THE TWO THAT MOVED ARE THE POINT (2026-09-02). `travel.ts`
    // has always priced an off-road step through `eco_tree` / `eco_grass`
    // ("routes squeeze through forest gaps and along open country") — and
    // those fields were NEVER WRITTEN: `planet-game.ts` called `applyEcology`
    // without `perSpecies`, so every interstate on every planet was solved as
    // if the world had no forests at all. Switching the bake on woke the
    // vegetation terms up, two routes now bend around woodland instead of
    // through it, and their ends land outside the town extent. The number
    // moved because the model started working, so the PIN moves with it —
    // re-anchoring the cost model to reproduce 18 would be pinning the
    // forest-blind net forever.
    expect(before.unclipped).toBe(16);
    expect(after.unclipped).toBe(0);
  }, 240_000);

  it("the tier-1 take is a hamlet's, not a capital's", () => {
    expect(REGION_FOUND_POP).toBeLessThan(100);
    expect(gateAThreshold(REAL_SCALE, FOOD, REGION_FOUND_POP)).toBeCloseTo(25.475, 3);
  });
});
