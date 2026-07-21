/**
 * Large-scale climate (shared/world-engine/planet/climate.ts): per-cell
 * RAIN and TEMPERATURE fields over a planet's lattice, folded into the
 * settled substrate — rain-fed fertility (the dryness fix: green no longer
 * needs a river bank) and polar ice caps (nothing founds on them).
 *
 * Two tiers of test:
 *   - a SYNTHETIC lattice (one authored equatorial continent) isolates each
 *     curve: latitude bands, continentality, the elevation lapse;
 *   - the EARTHLIKE (faceN 24, seed 7, real radius — region-refine's
 *     config) pins the calibration: ice extent, the before/after fertility
 *     rise, founding off the caps, determinism.
 */
import { describe, it, expect } from "vitest";
import { buildPlanetWorld, parsePlanetWorld } from "@shared/world-engine/planet/planet-game";
import { refineRegion } from "@shared/world-engine/planet/refine";
import {
  climateFields, applyClimate, seaDistance, latitudeRain, latitudeTempC, ICE_TEMP_C,
} from "@shared/world-engine/planet/climate";
import { makeCubeSphereTopology } from "@shared/world-engine/kernel/cells/topology";
import { SEA_HEIGHT } from "@shared/world-engine/kernel/geology/tectonics";
import type { GameSettings } from "@shared/world-engine/kernel/manifest";

const latDeg = (topo: ReturnType<typeof makeCubeSphereTopology>, c: number): number =>
  Math.asin(Math.max(-1, Math.min(1, topo.pos3!(c)[1]))) * (180 / Math.PI);

describe("climate curves — a synthetic equatorial continent", () => {
  // One continent centered on the equator at +X, low platform (12) with a
  // high core (30); everything else deep sea.
  const topo = makeCubeSphereTopology(16);
  const height = new Float64Array(topo.n);
  for (let c = 0; c < topo.n; c++) {
    const d = topo.pos3!(c);
    const dot = d[0]; // dir · [1,0,0]
    height[c] = dot > 0.93 ? 30 : dot > 0.55 ? 12 : 0;
  }
  const opts = {
    topo, height, seaHeight: SEA_HEIGHT,
    metresPerUnit: 150, radiusM: 6_371_000, meanTempC: 14, wetness: 1,
  };
  const fields = climateFields(opts);

  const bandMean = (arr: Float64Array, lo: number, hi: number): number => {
    let s = 0, k = 0;
    for (let c = 0; c < topo.n; c++) {
      const a = Math.abs(latDeg(topo, c));
      if (a >= lo && a < hi) { s += arr[c]; k++; }
    }
    expect(k).toBeGreaterThan(0);
    return s / k;
  };

  it("latitude rain bands: wet ITCZ, dry subtropics, wetter mid-latitudes, dry poles", () => {
    expect(bandMean(fields.rain, 0, 10)).toBeGreaterThan(bandMean(fields.rain, 25, 35));
    expect(bandMean(fields.rain, 40, 60)).toBeGreaterThan(bandMean(fields.rain, 25, 35));
    expect(bandMean(fields.rain, 40, 60)).toBeGreaterThan(bandMean(fields.rain, 75, 90));
    // The pure band curve agrees (smooth, not stepped: strictly ordered).
    const eq = latitudeRain(0);
    const subtrop = latitudeRain((30 * Math.PI) / 180);
    const mid = latitudeRain((48 * Math.PI) / 180);
    const pole = latitudeRain(Math.PI / 2);
    expect(eq).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(subtrop);
    expect(subtrop).toBeGreaterThan(pole);
  });

  it("temperature: hot equator, freezing poles, meanTempC shifts the whole curve", () => {
    expect(bandMean(fields.tempC, 0, 10)).toBeGreaterThan(bandMean(fields.tempC, 75, 90));
    expect(bandMean(fields.tempC, 75, 90)).toBeLessThan(0);
    expect(latitudeTempC(0, 14)).toBeCloseTo(27, 5);
    expect(latitudeTempC(Math.PI / 2, 14)).toBeCloseTo(-17, 5);
    expect(latitudeTempC(0, -10) - latitudeTempC(0, 14)).toBeCloseTo(-24, 5);
  });

  it("elevation lapse: the high core is colder than same-latitude lowland", () => {
    let checked = 0;
    for (let c = 0; c < topo.n; c++) {
      if (height[c] !== 30) continue;
      for (let o = 0; o < topo.n; o++) {
        if (height[o] !== 12) continue;
        if (Math.abs(latDeg(topo, c) - latDeg(topo, o)) > 2) continue;
        expect(fields.tempC[c]).toBeLessThan(fields.tempC[o]);
        checked++;
        break;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("continentality: the deep interior is drier than the same-latitude coast", () => {
    const hops = seaDistance(topo, height, SEA_HEIGHT);
    // Compare at EQUAL elevation (the low platform) so orography can't
    // explain the difference.
    let checked = 0;
    for (let c = 0; c < topo.n; c++) {
      if (height[c] !== 12 || hops[c] < 4) continue;
      for (let o = 0; o < topo.n; o++) {
        if (height[o] !== 12 || hops[o] !== 1) continue;
        if (Math.abs(latDeg(topo, c) - latDeg(topo, o)) > 5) continue;
        expect(fields.rain[c]).toBeLessThan(fields.rain[o]);
        checked++;
        break;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const again = climateFields(opts);
    expect(Array.from(again.rain)).toEqual(Array.from(fields.rain));
    expect(Array.from(again.tempC)).toEqual(Array.from(fields.tempC));
  });
});

describe("climate on the earthlike — the dryness fix and the ice caps", () => {
  const game: GameSettings = {
    scope: "planet",
    world: {
      topology: { kind: "cube-sphere", faceN: 24 },
      geology: { seed: 7, epochs: 350, continentR: 0.38 },
      settle: true,
      radius: 6_371_000,
      founding: { threshold: 60, radius: 2, minSpacing: 2, maxHarvest: 600 },
    },
    initialFocus: null, avatar: false, avatarSpecies: "human", canFly: false, creativeMode: false, entities: null, scale: null,
  };
  const built = buildPlanetWorld(game);
  const { grid, topo } = built;
  const n = topo.n;
  const height = grid.fields.height;
  const isLand = (c: number): boolean => height[c] >= SEA_HEIGHT;

  it("writes rain / tempC / ice fields for downstream consumers", () => {
    expect(grid.fields.rain?.length).toBe(n);
    expect(grid.fields.tempC?.length).toBe(n);
    expect(grid.fields.ice?.length).toBe(n);
  });

  it("polar caps: high-latitude cells freeze; ice means barren and empty", () => {
    let polar = 0;
    for (let c = 0; c < n; c++) {
      if (Math.abs(latDeg(topo, c)) < 78) continue;
      polar++;
      expect(grid.fields.ice[c]).toBe(1);
    }
    expect(polar).toBeGreaterThan(20);
    let iceLand = 0;
    for (let c = 0; c < n; c++) {
      if (grid.fields.ice[c] < 1) continue;
      expect(grid.fields.tempC[c]).toBeLessThan(ICE_TEMP_C);
      expect(grid.fields.fertility[c]).toBe(0);
      expect(grid.fields.people[c]).toBe(0);
      if (isLand(c)) iceLand++;
    }
    // The caps are real (a meaningful share of land) but not a snowball.
    let land = 0;
    for (let c = 0; c < n; c++) if (isLand(c)) land++;
    expect(iceLand / land).toBeGreaterThan(0.05);
    expect(iceLand / land).toBeLessThan(0.5);
  });

  it("no founding site sits on ice", () => {
    expect(built.sites.length).toBeGreaterThan(50);
    for (const s of built.sites) expect(grid.fields.ice[s.cell]).toBeLessThan(1);
  });

  it("the dryness fix: rain-fed fertility beats the river-only substrate", () => {
    // The river-only rest state is a pure function of (river, height,
    // solid) — the substrate rules' targets — so "before" reconstructs
    // exactly from the untouched river field.
    const river = grid.fields.river;
    const solid = grid.fields.solid;
    let land = 0;
    let beforeGreen = 0; // fertility ≥ 8 = the river-"ok" band
    let afterGreen = 0;
    let beforeArable = 0; // fertility ≥ 1
    let afterArable = 0;
    for (let c = 0; c < n; c++) {
      if (!isLand(c)) continue;
      land++;
      const arableGate = height[c] < 40 && (!solid || solid[c] < 0.5);
      const riverFert = arableGate && river[c] > 45 ? 15 : arableGate && river[c] > 15 ? 8 : 0;
      if (riverFert >= 8) beforeGreen++;
      if (riverFert >= 1) beforeArable++;
      if (grid.fields.fertility[c] >= 8) afterGreen++;
      if (grid.fields.fertility[c] >= 1) afterArable++;
    }
    // Calibration on this world (probed): green 53 → 107 of 1291 land
    // cells (4.1% → 8.3%), arable 53 → ~560 (4.1% → ~43%).
    expect(afterGreen).toBeGreaterThan(beforeGreen * 1.5);
    expect(afterArable).toBeGreaterThan(beforeArable * 5);
    expect(afterArable / land).toBeGreaterThan(0.3); // rainy lowlands green without rivers
    // Deserts stay barren: dry cells keep fertility 0 unless a river bank
    // waters them (the Nile rule).
    const rain = grid.fields.rain;
    for (let c = 0; c < n; c++) {
      if (!isLand(c) || rain[c] >= 0.25 || grid.fields.ice[c] >= 1) continue;
      const arableGate = height[c] < 40 && (!solid || solid[c] < 0.5);
      const riverFert = arableGate && river[c] > 45 ? 15 : arableGate && river[c] > 15 ? 8 : 0;
      expect(grid.fields.fertility[c]).toBe(riverFert);
    }
  });

  it("rain structure holds on the real world: ITCZ > subtropics; coast > interior", () => {
    const rain = grid.fields.rain;
    const mean = (pick: (c: number) => boolean): number => {
      let s = 0, k = 0;
      for (let c = 0; c < n; c++) if (pick(c)) { s += rain[c]; k++; }
      expect(k).toBeGreaterThan(0);
      return s / k;
    };
    const eq = mean(c => Math.abs(latDeg(topo, c)) < 10);
    const subtrop = mean(c => { const a = Math.abs(latDeg(topo, c)); return a >= 25 && a < 35; });
    expect(eq).toBeGreaterThan(subtrop);
    const hops = seaDistance(topo, height, SEA_HEIGHT);
    const coast = mean(c => isLand(c) && hops[c] <= 1 && Math.abs(latDeg(topo, c)) < 35);
    const interior = mean(c => isLand(c) && hops[c] >= 4 && Math.abs(latDeg(topo, c)) < 35);
    expect(interior).toBeLessThan(coast);
  });

  it("is deterministic: recomputing the fields reproduces the grid's stored copies", () => {
    const again = climateFields({
      topo, height, seaHeight: SEA_HEIGHT,
      metresPerUnit: (built.spec.relief * built.spec.radius) / (63 - SEA_HEIGHT),
      radiusM: built.spec.radius,
    });
    expect(Array.from(again.rain)).toEqual(Array.from(grid.fields.rain));
    expect(Array.from(again.tempC)).toEqual(Array.from(grid.fields.tempC));
  });

  it("the render paints the caps: polar vertices snow-white, fertile equator green", () => {
    const out: [number, number, number] = [0, 0, 0];
    let polarChecked = 0;
    let fertileChecked = 0;
    for (let c = 0; c < n; c++) {
      const lat = Math.abs(latDeg(topo, c));
      const dir = topo.pos3!(c);
      if (lat > 80 && grid.fields.ice[c] >= 1) {
        built.surface.colorAt(built.surface.heightAt(dir), dir, out);
        // Cap interior: the interpolated ice field is 1 → exact snow.
        expect(out[0]).toBeCloseTo(0.93, 1);
        expect(out[2]).toBeCloseTo(0.96, 1);
        polarChecked++;
      } else if (lat < 15 && grid.fields.ice[c] < 1 && grid.fields.fertility[c] >= 10
        && grid.fields.river[c] <= 16 // RAIN-fed, not a channel — the dryness fix
        && height[c] >= SEA_HEIGHT + 2 && height[c] < 20) {
        // A genuine watercourse now renders bluish (a river you can SEE); this
        // asserts the LAND BETWEEN rivers — rain-fed lush lowland — stays green.
        // fertility ≥ 10 with river ≤ 16 is reachable because RAIN_FERT_MAX = 12.
        built.surface.colorAt(built.surface.heightAt(dir), dir, out);
        expect(out[1]).toBeGreaterThan(out[2]); // vegetation: green over blue
        fertileChecked++;
      }
    }
    expect(polarChecked).toBeGreaterThan(10);
    expect(fertileChecked).toBeGreaterThan(10);
  });

  it("region tier: rain passes through as a density, villages stay off the ice", { timeout: 240000 }, () => {
    const refined = refineRegion(built, built.sites[0].cell);
    const child = refined.prep.grid;
    expect(child.fields.rain?.length).toBe(refined.frame.cols * refined.frame.rows);
    expect(child.fields.tempC).toBeDefined();
    expect(child.fields.ice).toBeDefined();
    // Passthrough: a child cell's rain IS its parent cell's rain.
    const parentRainValues = new Set(Array.from(grid.fields.rain));
    for (let i = 0; i < child.fields.rain.length; i += 97) {
      expect(parentRainValues.has(child.fields.rain[i])).toBe(true);
    }
    for (const site of refined.prep.sites) {
      expect(child.fields.ice[site.cell]).toBeLessThan(1);
    }
  });
});

describe("climate spec — reject, never skip; absent = byte-identical", () => {
  it("accepts the knobs and fills their defaults", () => {
    const spec = parsePlanetWorld({ climate: { meanTempC: -5 } }, "w");
    expect(spec.climate).toEqual({ meanTempC: -5, wetness: 1 });
    const both = parsePlanetWorld({ climate: { meanTempC: 30, wetness: 2 } }, "w");
    expect(both.climate).toEqual({ meanTempC: 30, wetness: 2 });
  });

  it("refuses unknown fields and bad ranges with exact paths", () => {
    expect(() => parsePlanetWorld({ climate: { monsoon: 1 } }, "w")).toThrow(/w\.climate\.monsoon: unknown field/);
    expect(() => parsePlanetWorld({ climate: { meanTempC: 200 } }, "w")).toThrow(/w\.climate\.meanTempC: out of range/);
    expect(() => parsePlanetWorld({ climate: { wetness: -1 } }, "w")).toThrow(/w\.climate\.wetness: out of range/);
    expect(() => parsePlanetWorld({ climate: 3 }, "w")).toThrow(/w\.climate: expected an object/);
  });

  it("an absent climate leaves the spec exactly as before (no default key)", () => {
    const spec = parsePlanetWorld({}, "w");
    expect("climate" in spec).toBe(false);
  });

  it("a cold world caps over; a hot wet world stays green at the equator", () => {
    // An ocean world — the knobs under test are temperature and wetness,
    // not continentality (an all-land world is honestly interior-dry).
    const topo = makeCubeSphereTopology(8);
    const height = new Float64Array(topo.n); // all sea
    const base = { topo, height, seaHeight: SEA_HEIGHT, metresPerUnit: 150, radiusM: 6_371_000 };
    const cold = climateFields({ ...base, meanTempC: -30 });
    const warm = climateFields({ ...base, meanTempC: 20, wetness: 2 });
    let coldIcy = 0;
    for (let c = 0; c < topo.n; c++) if (cold.tempC[c] < ICE_TEMP_C) coldIcy++;
    expect(coldIcy).toBe(topo.n); // equator −17 on a −30 world: all cap
    for (let c = 0; c < topo.n; c++) {
      if (Math.abs(latDeg(topo, c)) < 10) {
        expect(warm.tempC[c]).toBeGreaterThan(20);
        expect(warm.rain[c]).toBeGreaterThan(0.5);
      }
    }
  });
});
