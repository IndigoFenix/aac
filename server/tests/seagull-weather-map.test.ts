// Tests for the seagull-dream synoptic weather engine (weather-map.ts).
// Pure math — no three.js, no GL, no DOM — safe in the default `npm test`
// run. The module is the single authority for planet-scale cloud
// structure; these tests pin down the invariants the renderers rely on:
// determinism, value ranges, pole/seam safety, and the bake/scroll drift
// split (no snap-back when a row re-bakes).

import { describe, it, expect } from "@jest/globals";
import {
  createSynopticField,
  createWeatherMap,
  prebakeWeatherMap,
  weatherMapWidth,
  zonalSpeedMs,
  zonalDriftRadPerSec,
  type SynopticParams,
  type SynopticSample,
} from "../../games/seagull-dream/src/weather-map.js";

function makeParams(overrides: Partial<SynopticParams> = {}): SynopticParams {
  return {
    seed: 1337,
    planetRadiusM: 6_371_000,
    coverage: 0.55,
    synopticScaleM: 1_400_000,
    bandCells: 3,
    bandStrength: 0.4,
    bandWaviness: 0.5,
    jetSpeedMs: 25,
    streakiness: 0.4,
    vortexActivity: 0.65,
    vortexRadiusRad: 0.18,
    vortexLifetimeDays: 6,
    vortexSpin: 2.2,
    convectiveVigor: 0.85,
    equatorVigorBoost: 0.5,
    weatherDaysPerSecond: 1 / 240,
    ...overrides,
  };
}

const out = (): SynopticSample => ({ cover: 0, vigor: 0, zoneT: 0, storm: 0 });

describe("synoptic field", () => {
  it("is deterministic across instances for the same params", () => {
    const a = createSynopticField(makeParams());
    const b = createSynopticField(makeParams());
    const sa = out();
    const sb = out();
    for (let i = 0; i < 50; i++) {
      const lon = (i / 50 - 0.5) * Math.PI * 2;
      const lat = Math.sin(i * 1.7) * 1.4;
      a.sampleAt(lon, lat, 123.4, 1, sa);
      b.sampleAt(lon, lat, 123.4, 1, sb);
      expect(sa.cover).toBe(sb.cover);
      expect(sa.vigor).toBe(sb.vigor);
      expect(sa.zoneT).toBe(sb.zoneT);
      expect(sa.storm).toBe(sb.storm);
    }
  });

  it("produces different weather for different seeds", () => {
    const a = createSynopticField(makeParams({ seed: 1 }));
    const b = createSynopticField(makeParams({ seed: 2 }));
    const sa = out();
    const sb = out();
    let differs = 0;
    for (let i = 0; i < 20; i++) {
      const lon = (i / 20 - 0.5) * Math.PI * 2;
      a.sampleAt(lon, 0.5, 0, 1, sa);
      b.sampleAt(lon, 0.5, 0, 1, sb);
      if (Math.abs(sa.cover - sb.cover) > 1e-6) differs++;
    }
    expect(differs).toBeGreaterThan(10);
  });

  it("stays in range and finite everywhere, including poles and seam", () => {
    const field = createSynopticField(makeParams());
    const s = out();
    const lats = [-Math.PI / 2, -1.2, -0.3, 0, 0.3, 1.2, Math.PI / 2];
    const lons = [-Math.PI, -Math.PI + 1e-9, -1, 0, 1, Math.PI - 1e-9, Math.PI];
    const times = [0, 60, 3600, 86_400];
    for (const t of times) {
      for (const lat of lats) {
        for (const lon of lons) {
          field.sampleAt(lon, lat, t, 1, s);
          for (const v of [s.cover, s.vigor, s.zoneT, s.storm]) {
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("is continuous across the longitude wrap seam", () => {
    const field = createSynopticField(makeParams({ vortexActivity: 0 }));
    const sa = out();
    const sb = out();
    const eps = 1e-5;
    for (const lat of [-0.9, 0, 0.7]) {
      field.sampleAt(Math.PI - eps, lat, 50, 1, sa);
      field.sampleAt(-Math.PI + eps, lat, 50, 1, sb);
      // Same physical point (lon wraps) — noise charts are periodic by
      // construction. The points sit 2ε apart, so values differ by
      // gradient·2ε (amplified by the steep cover ramp); a genuine seam
      // discontinuity would be O(0.5).
      expect(Math.abs(sa.cover - sb.cover)).toBeLessThan(0.01);
      expect(Math.abs(sa.zoneT - sb.zoneT)).toBeLessThan(0.01);
    }
  });

  it("advects the pattern at the zonal drift rate (no-snap-back invariant)", () => {
    // With morphing and vortices disabled, the field at (lon, t) must
    // exactly equal the field at (lon + drift·dt, t + dt) — the pattern
    // is rigid per-latitude and slides east at the jet speed. This is
    // the invariant that lets renderers bake at one time and apply only
    // residual scroll afterwards without clouds jumping when rows
    // re-bake.
    const params = makeParams({ vortexActivity: 0, weatherDaysPerSecond: 0 });
    const field = createSynopticField(params);
    const sa = out();
    const sb = out();
    const dt = 300;
    for (const lat of [-1.1, -0.4, 0.2, 0.9]) {
      const drift = zonalDriftRadPerSec(params, lat) * dt;
      for (const lon of [-2, 0.5, 3]) {
        field.sampleAt(lon, lat, 1000, 1, sa);
        field.sampleAt(lon + drift, lat, 1000 + dt, 1, sb);
        expect(Math.abs(sa.cover - sb.cover)).toBeLessThan(1e-9);
        expect(Math.abs(sa.vigor - sb.vigor)).toBeLessThan(1e-9);
      }
    }
  });

  it("vortices add storminess somewhere on the globe", () => {
    const calm = createSynopticField(makeParams({ vortexActivity: 0 }));
    const stormy = createSynopticField(makeParams({ vortexActivity: 1 }));
    const s = out();
    let maxCalmStorm = 0;
    let maxStormyStorm = 0;
    // Vigor-driven storm can exist without vortices; compare the maxima
    // with vigor switched off so only vortex cores contribute.
    const calmNoVigor = createSynopticField(makeParams({ vortexActivity: 0, convectiveVigor: 0, equatorVigorBoost: 0 }));
    const stormyNoVigor = createSynopticField(makeParams({ vortexActivity: 1, convectiveVigor: 0, equatorVigorBoost: 0 }));
    for (let i = 0; i < 4000; i++) {
      const lon = ((i % 80) / 80 - 0.5) * Math.PI * 2;
      const lat = (Math.floor(i / 80) / 50 - 0.5) * Math.PI * 0.9;
      calmNoVigor.sampleAt(lon, lat, 120, 1, s);
      maxCalmStorm = Math.max(maxCalmStorm, s.storm);
      stormyNoVigor.sampleAt(lon, lat, 120, 1, s);
      maxStormyStorm = Math.max(maxStormyStorm, s.storm);
    }
    expect(maxCalmStorm).toBe(0);
    expect(maxStormyStorm).toBeGreaterThan(0.1);
    void calm;
    void stormy;
  });

  it("banding modulates zoneT across latitude", () => {
    const field = createSynopticField(makeParams({ bandStrength: 1, bandWaviness: 0 }));
    const s = out();
    let min = 1;
    let max = 0;
    for (let i = 0; i <= 60; i++) {
      const lat = (i / 60 - 0.5) * Math.PI;
      field.sampleAt(0.3, lat, 0, 1, s);
      min = Math.min(min, s.zoneT);
      max = Math.max(max, s.zoneT);
    }
    // 3 cells per hemisphere should sweep zoneT through most of 0..1.
    expect(max - min).toBeGreaterThan(0.7);
  });
});

describe("zonal wind profile", () => {
  it("is zero at equator and poles, peaks at cell boundaries", () => {
    const params = makeParams({ bandCells: 3, jetSpeedMs: 25 });
    expect(zonalSpeedMs(params, 0)).toBeCloseTo(0, 9);
    expect(zonalSpeedMs(params, Math.PI / 2)).toBeCloseTo(0, 6);
    const boundaryLat = Math.PI / (4 * 3); // sin(2·3·lat) = 1
    expect(Math.abs(zonalSpeedMs(params, boundaryLat))).toBeCloseTo(25, 6);
  });

  it("drift rate never blows up near the poles", () => {
    const params = makeParams();
    for (const lat of [1.55, 1.57, Math.PI / 2]) {
      expect(Number.isFinite(zonalDriftRadPerSec(params, lat))).toBe(true);
      expect(Math.abs(zonalDriftRadPerSec(params, lat))).toBeLessThan(1);
    }
  });
});

describe("weather map bake", () => {
  it("sizes the map to the body", () => {
    expect(weatherMapWidth(200_000)).toBe(256);   // small moon
    expect(weatherMapWidth(6_371_000)).toBe(512); // Earth
    expect(weatherMapWidth(7e7)).toBe(1024);      // Jupiter
  });

  it("prebake fills the map and bilinear sampling matches the field", () => {
    // Vortex-free + frozen evolution so field values are time-stable and
    // the only error sources are byte quantization + bilinear filtering.
    const params = makeParams({
      vortexActivity: 0,
      weatherDaysPerSecond: 0,
      coverage: 0.8,
    });
    const map = createWeatherMap(params);
    // Full-resolution bake (prebake strides rows; bake all rows exactly).
    map.bake(map.height, 0, 1);

    const s = out();
    const ref = out();
    let covered = 0;
    let totalErr = 0;
    let n = 0;
    // Sample exactly at texel centers — bilinear weights collapse and
    // the only difference from the field is the 8-bit quantization.
    for (let y = 4; y < map.height; y += 16) {
      for (let x = 0; x < map.width; x += 16) {
        const lon = ((x + 0.5) / map.width - 0.5) * Math.PI * 2;
        const lat = ((y + 0.5) / map.height - 0.5) * Math.PI;
        map.sample(lon, lat, 0, 1, s);
        map.field.sampleAt(lon, lat, 0, 1, ref);
        totalErr += Math.abs(s.cover - ref.cover);
        n++;
        if (s.cover > 0.05) covered++;
      }
    }
    expect(covered).toBeGreaterThan(n * 0.2); // coverage 0.8 → plenty of cloud
    expect(totalErr / n).toBeLessThan(0.01);  // ≈ quantization error only
  });

  it("progressive bake sweeps and wraps, updating the epoch", () => {
    const params = makeParams({ planetRadiusM: 200_000 }); // small → 256×128
    const map = createWeatherMap(params);
    prebakeWeatherMap(map, 10, 1);
    expect(map.epochSec).toBe(10);
    // Sweep all rows at t=50 → epoch becomes the sweep start time.
    let wrapped = false;
    for (let i = 0; i < map.height; i += 16) {
      wrapped = map.bake(16, 50, 1).wrapped || wrapped;
    }
    expect(wrapped).toBe(true);
    expect(map.epochSec).toBe(50);
  });

  it("residual scroll keeps the sampled pattern continuous across a re-bake", () => {
    // Bake everything at t0; sample a point at t1 (residual scroll
    // covers the gap); re-bake everything at t1 and sample again — the
    // two reads must agree (drift baked-in == drift scrolled-at-read).
    const params = makeParams({ vortexActivity: 0, weatherDaysPerSecond: 0 });
    const map = createWeatherMap(params);
    map.bake(map.height, 0, 1);

    const before = out();
    const after = out();
    const t1 = 120;
    const probes: Array<[number, number]> = [[0.4, 0.6], [-2.1, -0.8], [1.3, 0.25]];
    const beforeVals = probes.map(([lon, lat]) => {
      map.sample(lon, lat, t1, 1, before);
      return before.cover;
    });
    map.bake(map.height, t1, 1);
    probes.forEach(([lon, lat], i) => {
      map.sample(lon, lat, t1, 1, after);
      // Bilinear-resample error: the drifted pattern lands at different
      // texel offsets, so allow a small filtering tolerance.
      expect(Math.abs(after.cover - beforeVals[i])).toBeLessThan(0.08);
    });
  });
});
