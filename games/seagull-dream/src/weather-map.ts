import { createNoise3D } from "simplex-noise";

// Synoptic weather engine — the single authority on planet-scale cloud
// structure.
//
// Real weather is organized in 2D: pressure systems, fronts, jets and
// vortices live on the sphere, and vertical structure (cloud tops, towers,
// decks) derives from what the 2D field is doing. This module models that
// 2D synoptic field as a pure function of (seed, lon, lat, time), then
// bakes it progressively into an equirect RGBA map that BOTH renderers
// consume:
//
//   • the orbital shell shader samples the baked DataTexture in GLSL
//   • the billboard sampler bilinear-samples the same bytes in JS
//
// One set of bytes → the planet looks identical from orbit, from flight
// altitude, and from the ground. (The old system evaluated two unrelated
// noise functions and visibly morphed at the LOD crossfade.)
//
// Channels:
//   R — cover  : 0..1 cloud coverage/optical density
//   G — vigor  : 0..1 convective vertical development (lifts cloud tops,
//                 turns flat decks into towers, drives cumuliform detail)
//   B — zoneT  : 0..1 belt↔zone color blend (banding + vortex identity)
//   A — storm  : 0..1 storminess (darkens bases; future rain/lightning)
//
// Structure ingredients (all continuous — no discrete weather "types"):
//   • banding with meander — wavy belt/zone boundaries (Rossby-wave look)
//   • flow-stretched coverage noise — anisotropic sampling along the
//     zonal direction turns blobs into wind-sheared streaks and fronts
//   • a deterministic vortex population — seeded, advected by the local
//     jet, growing and decaying on a lifecycle; each vortex spiral-warps
//     the noise around it (comma clouds / hurricanes / GRS-style ovals)
//     and boosts vigor + storm
//   • an ITCZ-style equatorial vigor band for convective worlds
//
// Drift model — bake/scroll split:
//   synopticAt() evaluates the pattern ADVECTED to absolute time t (each
//   latitude's noise coordinates slide east at the local jet speed; the
//   vortices slide with them). The renderers then add only the RESIDUAL
//   drift since the texel was baked: sample at lon − drift·(now − epoch).
//   When a row re-bakes, the new bytes already contain the drift the
//   residual was covering, so motion is continuous across sweeps — no
//   snap-back, and the residual offset stays bounded by one sweep period.
//
// This module is deliberately three.js-free (pure math + typed arrays) so
// it can be unit-tested in the server test suite without GL or DOM.

// ── Params ─────────────────────────────────────────────────────────────────

export interface SynopticParams {
  seed: number;
  planetRadiusM: number;
  /** 0..1 — base cloud coverage (threshold on the coverage noise). */
  coverage: number;
  /** Base wavelength (m) of synoptic features — cyclone/front scale,
   *  NOT puff scale. Earth ≈ 1500 km; detail noise lives elsewhere. */
  synopticScaleM: number;
  /** Circulation cells per hemisphere (Earth ≈ 3, Jupiter ≈ 8). */
  bandCells: number;
  /** 0..1 — how strongly banding modulates density and color. */
  bandStrength: number;
  /** 0..1 — longitudinal meander of belt boundaries. Earth-likes wavy,
   *  fast-rotating giants nearly straight. */
  bandWaviness: number;
  /** Peak zonal jet speed (m/s) at circulation-cell boundaries. */
  jetSpeedMs: number;
  /** 0..1 — zonal anisotropy of the coverage noise. 0 = isotropic blobs,
   *  1 = strongly wind-sheared streaks. */
  streakiness: number;
  /** 0..1 — overall vortex population strength (count + amplitude). */
  vortexActivity: number;
  /** Characteristic vortex radius in radians of arc on the sphere. */
  vortexRadiusRad: number;
  /** Vortex lifecycle length in weather-days. Earth storms ~ a few days;
   *  giant-planet ovals effectively persistent (hundreds of days). */
  vortexLifetimeDays: number;
  /** Swirl wrap strength (radians of rotation at vortex center). */
  vortexSpin: number;
  /** 0..1 — global convective vigor ceiling (G channel). Water worlds
   *  high, photochemical haze decks ~0. */
  convectiveVigor: number;
  /** 0..1 — extra vigor in an equatorial ITCZ-like band. */
  equatorVigorBoost: number;
  /** Sim-seconds → weather-days conversion for vortex lifecycles and slow
   *  field morphing. 1/86400 would be realtime; default runs faster so
   *  evolution is visible within a play session. */
  weatherDaysPerSecond: number;
}

export interface SynopticSample {
  cover: number;
  vigor: number;
  zoneT: number;
  storm: number;
}

// ── Small deterministic helpers (local copies — keeps this module free of
// the galaxy.ts → three dependency chain) ──────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TWO_PI = Math.PI * 2;

/** Wrap an angle to (-π, π]. */
function wrapPi(a: number): number {
  a = a % TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  if (a <= -Math.PI) a += TWO_PI;
  return a;
}

// ── Zonal drift ────────────────────────────────────────────────────────────

/** Eastward zonal wind speed (m/s) at a latitude. Matches the convention
 *  used by cloud-field's windAtLocal: speed = −jet × sin(2N × lat); max
 *  at cell boundaries, zero at zone/belt centers, alternating direction
 *  between adjacent cells, zero at poles for integer N. */
export function zonalSpeedMs(params: SynopticParams, latRad: number): number {
  const N = Math.max(1, params.bandCells);
  return -params.jetSpeedMs * Math.sin(2 * N * latRad);
}

/** Longitude drift rate (rad/s) of the cloud pattern at a latitude.
 *  cos(lat) is clamped so the (physically ~zero-wind) polar caps don't
 *  divide toward infinity. */
export function zonalDriftRadPerSec(params: SynopticParams, latRad: number): number {
  const cosLat = Math.max(0.08, Math.cos(latRad));
  return zonalSpeedMs(params, latRad) / (params.planetRadiusM * cosLat);
}

// ── Vortex population ──────────────────────────────────────────────────────
//
// A fixed roster of deterministic vortex "slots". Each slot has a home
// latitude, base longitude, lifecycle phase and spin. At any time t, a
// slot's amplitude follows a smooth grow→peak→decay pulse over its
// lifecycle; longitudes advect with the local jet (plus a small relative
// drift) so vortices ride their band exactly like the background noise.
// Slots whose pulse is near zero contribute nothing — storms continuously
// being born and dying is what makes the weather feel alive.

interface VortexSlot {
  latRad: number;
  lonRad0: number;
  radiusRad: number;
  /** Swirl direction × strength multiplier. */
  spin: number;
  /** Lifecycle phase offset 0..1. */
  phase: number;
  /** Amplitude multiplier (some storms are weak). */
  strength: number;
  /** Slow drift relative to the jet (rad/weather-day). */
  relDriftRadPerDay: number;
  /** Pushes zoneT toward 0 or 1 — gives big ovals a distinct tint. */
  zonePush: number;
}

function buildVortexSlots(params: SynopticParams): VortexSlot[] {
  const rng = mulberry32((params.seed ^ 0x9e3779b9) >>> 0);
  const count = Math.round(params.vortexActivity * (6 + params.bandCells * 2));
  const slots: VortexSlot[] = [];
  for (let i = 0; i < count; i++) {
    // Home latitudes biased toward mid-latitudes of either hemisphere —
    // sin-distributed so vortices avoid the exact poles (chart math
    // degenerates there and real cyclones don't sit on the pole either).
    const hemi = rng() < 0.5 ? -1 : 1;
    const latRad = hemi * (0.12 + 0.85 * rng()) * (Math.PI / 2) * 0.82;
    slots.push({
      latRad,
      lonRad0: (rng() - 0.5) * TWO_PI,
      radiusRad: params.vortexRadiusRad * (0.6 + 0.8 * rng()),
      spin: (rng() < 0.5 ? -1 : 1) * params.vortexSpin * (0.7 + 0.6 * rng()),
      phase: rng(),
      strength: 0.5 + 0.5 * rng(),
      relDriftRadPerDay: (rng() - 0.5) * 0.05,
      zonePush: (rng() - 0.5) * 1.6,
    });
  }
  return slots;
}

// ── The synoptic field ─────────────────────────────────────────────────────

export interface SynopticField {
  params: SynopticParams;
  /** Evaluate the field at (lon, lat) and absolute sim-time t (seconds),
   *  with drift scaled by windMult. Fills and returns `out`. */
  sampleAt(
    lonRad: number,
    latRad: number,
    timeSec: number,
    windMult: number,
    out: SynopticSample,
  ): SynopticSample;
}

export function createSynopticField(params: SynopticParams): SynopticField {
  const noise = createNoise3D(mulberry32(params.seed >>> 0));
  const vortices = buildVortexSlots(params);

  // Frequencies in cycles-per-radian on the unit sphere.
  const freqIso = Math.max(0.5, params.planetRadiusM / params.synopticScaleM);
  // Streak chart: long in longitude, short in latitude.
  const freqLon = freqIso / (1 + 6 * params.streakiness);
  const freqLat = freqIso * (1 + 1.5 * params.streakiness);

  function sampleAt(
    lonRad: number,
    latRad: number,
    timeSec: number,
    windMult: number,
    out: SynopticSample,
  ): SynopticSample {
    const p = params;
    const weatherDays = timeSec * p.weatherDaysPerSecond * Math.max(0, windMult);

    // ── Advected longitude — the co-moving coordinate. The pattern at
    // this latitude has slid east by drift·t, so we sample the static
    // noise at lon − drift·t.
    const driftT = timeSec * windMult;
    let lon = lonRad - zonalDriftRadPerSec(p, latRad) * driftT;
    let lat = latRad;

    // ── Vortices: spiral-warp the sample coordinate, accumulate boosts.
    let coverBoost = 0;
    let vigorBoost = 0;
    let stormBoost = 0;
    let zoneBoost = 0;
    let eyeMul = 1;
    for (let i = 0; i < vortices.length; i++) {
      const v = vortices[i];
      const dy = lat - v.latRad;
      const reach = v.radiusRad * 3;
      if (dy > reach || dy < -reach) continue;

      // Lifecycle pulse — smooth birth → peak → decay, repeating with a
      // per-slot phase so the population is staggered.
      const cycleT = (weatherDays / p.vortexLifetimeDays + v.phase) % 1;
      const amp = Math.pow(Math.sin(Math.PI * cycleT), 0.75) * v.strength;
      if (amp < 0.05) continue;

      // Vortex longitude advects with its band's jet + small own drift.
      const vLon = v.lonRad0
        - zonalDriftRadPerSec(p, v.latRad) * driftT
        + v.relDriftRadPerDay * weatherDays;
      const cosV = Math.max(0.2, Math.cos(v.latRad));
      const dx = wrapPi(lon - vLon) * cosV;
      const r2 = dx * dx + dy * dy;
      const sigma2 = v.radiusRad * v.radiusRad;
      if (r2 > sigma2 * 9) continue;

      const falloff = Math.exp(-r2 / sigma2);
      // Spiral warp: rotate the offset around the vortex center. This is
      // what wraps background cloud bands into comma/spiral arms.
      const swirl = v.spin * amp * falloff;
      const cosS = Math.cos(swirl);
      const sinS = Math.sin(swirl);
      const rx = dx * cosS - dy * sinS;
      const ry = dx * sinS + dy * cosS;
      lon = vLon + rx / cosV;
      lat = v.latRad + ry;

      coverBoost += 0.55 * amp * falloff;
      vigorBoost += 0.9 * amp * falloff;
      stormBoost += 0.8 * amp * falloff;
      zoneBoost += v.zonePush * amp * falloff;
      // Strong, tight vortices develop a clear eye at the very center.
      if (v.spin * v.spin > 1.5 && v.radiusRad < 0.25) {
        eyeMul *= 1 - 0.85 * amp * Math.exp(-r2 / (sigma2 * 0.04));
      }
    }
    lat = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, lat));

    // ── Unit vector of the (warped) sample point. +Y is the spin axis.
    const cosLat = Math.cos(lat);
    const ux = cosLat * Math.cos(lon);
    const uy = Math.sin(lat);
    const uz = cosLat * Math.sin(lon);

    // Slow morphing: noise coordinates creep along a fixed diagonal as
    // weather-time advances, so the pattern reshapes (not just drifts).
    const morph = weatherDays * 0.12;

    // ── Banding with meander.
    const N = Math.max(1, p.bandCells);
    const meander = p.bandWaviness > 0.001
      ? noise(ux * 1.7 + morph, uy * 1.7, uz * 1.7 - morph) * p.bandWaviness * (Math.PI / (2 * N)) * 1.4
      : 0;
    const vertical = Math.cos(2 * N * lat + 2 * N * meander);
    const circulationFactor = 1 + p.bandStrength * vertical;
    let zoneT = (vertical + 1) * 0.5;

    // ── Coverage noise: isotropic base blended with a zonally-stretched
    // streak chart. The streak chart is periodic in lon by construction
    // (it samples on a circle) and its weight fades toward the poles
    // where the zonal direction degenerates.
    let nIso = noise(ux * freqIso + morph, uy * freqIso, uz * freqIso)
      + 0.5 * noise(ux * freqIso * 2.07, uy * freqIso * 2.07 + morph, uz * freqIso * 2.07);
    nIso /= 1.5;

    let n = nIso;
    const streakW = p.streakiness * Math.sqrt(Math.max(0, cosLat));
    if (streakW > 0.01) {
      let nStreak = noise(Math.cos(lon) * freqLon, Math.sin(lon) * freqLon, lat * freqLat + morph)
        + 0.5 * noise(Math.cos(lon) * freqLon * 2.07 + 11.3, Math.sin(lon) * freqLon * 2.07, lat * freqLat * 2.07);
      nStreak /= 1.5;
      n = nIso * (1 - streakW) + nStreak * streakW;
    }
    const n01 = (n + 1) * 0.5;

    // ── Coverage threshold + modulation. The ramp is deliberately
    // steeper than the threshold-to-1 distance: real clouds are mostly
    // OPAQUE with clear gaps, not a field of ghosts — values saturate
    // quickly once the noise clears the threshold, so `coverage`
    // controls the cloudy areal fraction rather than cloud thinness.
    const threshold = 1 - p.coverage;
    const span = Math.max(0.08, (1 - threshold) * 0.45);
    let cover = Math.max(0, (n01 - threshold) / span) * circulationFactor;
    cover = (cover + coverBoost) * eyeMul;
    if (cover > 1) cover = 1;
    if (cover < 0) cover = 0;

    // ── Convective vigor: low-frequency field × global ceiling, plus the
    // equatorial ITCZ band and vortex cores. Vigor only matters where
    // there is cloud to develop, so it's gated softly by cover.
    let vigor = 0;
    if (p.convectiveVigor > 0.005 || vigorBoost > 0) {
      const vn = (noise(ux * freqIso * 0.6 + 47.1, uy * freqIso * 0.6, uz * freqIso * 0.6 + morph) + 1) * 0.5;
      const itcz = p.equatorVigorBoost * Math.exp(-(lat * lat) / (0.22 * 0.22));
      vigor = p.convectiveVigor * (0.3 + 0.7 * vn) + itcz * p.convectiveVigor + vigorBoost;
      vigor *= 0.25 + 0.75 * Math.min(1, cover * 2.5);
      if (vigor > 1) vigor = 1;
      if (vigor < 0) vigor = 0;
    }

    // ── Storminess: vortex cores + the most vigorous convection.
    let storm = stormBoost + Math.max(0, vigor - 0.72) * 1.8;
    if (storm > 1) storm = 1;

    zoneT += zoneBoost;
    if (zoneT > 1) zoneT = 1;
    if (zoneT < 0) zoneT = 0;

    out.cover = cover;
    out.vigor = vigor;
    out.zoneT = zoneT;
    out.storm = storm;
    return out;
  }

  return { params, sampleAt };
}

// ── Baked map ──────────────────────────────────────────────────────────────

export interface WeatherMap {
  readonly width: number;
  readonly height: number;
  /** RGBA bytes, row 0 = south pole (v = 0). Shared with the renderer's
   *  DataTexture — bake() mutates in place. */
  readonly data: Uint8Array;
  readonly field: SynopticField;
  /** Reference time (sim-seconds) of the current bytes. Renderers apply
   *  residual drift of (now − epochSec) on top of the baked pattern. */
  epochSec: number;
  /** Bake up to `maxRows` rows at sim-time `timeSec`. Returns the number
   *  of rows actually baked and whether the sweep wrapped (the renderer
   *  re-uploads the texture and refreshes the epoch on wrap). */
  bake(maxRows: number, timeSec: number, windMult: number): { rows: number; wrapped: boolean };
  /** Bilinear sample with residual drift applied — the JS twin of the
   *  shell shader's lookup. Fills and returns `out`. */
  sample(
    lonRad: number,
    latRad: number,
    timeSec: number,
    windMult: number,
    out: SynopticSample,
  ): SynopticSample;
}

/** Map resolution by body size — texels stay comfortably finer than the
 *  synoptic feature scale without wasting bake time on small bodies. */
export function weatherMapWidth(planetRadiusM: number): number {
  if (planetRadiusM < 1.5e6) return 256;
  if (planetRadiusM < 2e7) return 512;
  return 1024;
}

export function createWeatherMap(params: SynopticParams): WeatherMap {
  const width = weatherMapWidth(params.planetRadiusM);
  const height = width / 2;
  const data = new Uint8Array(width * height * 4);
  const field = createSynopticField(params);
  const sampleTmp: SynopticSample = { cover: 0, vigor: 0, zoneT: 0, storm: 0 };

  let cursor = 0; // next row to bake
  let sweepStartSec = 0;

  function bakeRow(row: number, timeSec: number, windMult: number): void {
    const lat = ((row + 0.5) / height - 0.5) * Math.PI;
    let o = row * width * 4;
    for (let x = 0; x < width; x++) {
      const lon = ((x + 0.5) / width - 0.5) * TWO_PI;
      field.sampleAt(lon, lat, timeSec, windMult, sampleTmp);
      data[o++] = Math.min(255, Math.max(0, Math.round(sampleTmp.cover * 255)));
      data[o++] = Math.min(255, Math.max(0, Math.round(sampleTmp.vigor * 255)));
      data[o++] = Math.min(255, Math.max(0, Math.round(sampleTmp.zoneT * 255)));
      data[o++] = Math.min(255, Math.max(0, Math.round(sampleTmp.storm * 255)));
    }
  }

  const map: WeatherMap = {
    width,
    height,
    data,
    field,
    epochSec: 0,

    bake(maxRows: number, timeSec: number, windMult: number) {
      let rows = 0;
      let wrapped = false;
      while (rows < maxRows) {
        if (cursor === 0) sweepStartSec = timeSec;
        bakeRow(cursor, timeSec, windMult);
        rows++;
        cursor++;
        if (cursor >= height) {
          cursor = 0;
          // The finished sweep's bytes reference (approximately) the time
          // the sweep started; residual drift is measured from there. The
          // per-row error within one sweep is bounded by the sweep period
          // — a few seconds of differential drift, invisible at synoptic
          // scale.
          map.epochSec = sweepStartSec;
          wrapped = true;
        }
      }
      return { rows, wrapped };
    },

    sample(lonRad, latRad, timeSec, windMult, out) {
      // Residual drift since the bytes were baked.
      const drift = zonalDriftRadPerSec(params, latRad) * (timeSec - map.epochSec) * windMult;
      const lon = lonRad - drift;

      let u = lon / TWO_PI + 0.5;
      u -= Math.floor(u);
      const v = Math.min(1, Math.max(0, latRad / Math.PI + 0.5));

      const fx = u * width - 0.5;
      const fy = v * height - 0.5;
      let x0 = Math.floor(fx);
      let y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      x0 = ((x0 % width) + width) % width;
      const x1 = (x0 + 1) % width;
      if (y0 < 0) y0 = 0;
      let y1 = y0 + 1;
      if (y1 > height - 1) y1 = height - 1;
      if (y0 > height - 1) y0 = height - 1;

      const i00 = (y0 * width + x0) * 4;
      const i10 = (y0 * width + x1) * 4;
      const i01 = (y1 * width + x0) * 4;
      const i11 = (y1 * width + x1) * 4;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;

      const inv = 1 / 255;
      out.cover = (data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11) * inv;
      out.vigor = (data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11) * inv;
      out.zoneT = (data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11) * inv;
      out.storm = (data[i00 + 3] * w00 + data[i10 + 3] * w10 + data[i01 + 3] * w01 + data[i11 + 3] * w11) * inv;
      return out;
    },
  };

  return map;
}

/** Synchronous first fill at creation — bakes every STRIDE-th row and
 *  copies it into the skipped rows, so the map is immediately usable at
 *  reduced vertical resolution. The progressive sweep then refines it.
 *  Keeps the materialize-time hitch to a few milliseconds. */
export function prebakeWeatherMap(map: WeatherMap, timeSec: number, windMult: number): void {
  const STRIDE = 4;
  const { width, height, data } = map;
  // Use the map's own row baker through bake()? bake() walks sequentially;
  // for the strided prefill we sample directly via the field.
  const tmp: SynopticSample = { cover: 0, vigor: 0, zoneT: 0, storm: 0 };
  for (let row = 0; row < height; row += STRIDE) {
    const lat = ((row + 0.5) / height - 0.5) * Math.PI;
    let o = row * width * 4;
    for (let x = 0; x < width; x++) {
      const lon = ((x + 0.5) / width - 0.5) * TWO_PI;
      map.field.sampleAt(lon, lat, timeSec, windMult, tmp);
      data[o++] = Math.min(255, Math.max(0, Math.round(tmp.cover * 255)));
      data[o++] = Math.min(255, Math.max(0, Math.round(tmp.vigor * 255)));
      data[o++] = Math.min(255, Math.max(0, Math.round(tmp.zoneT * 255)));
      data[o++] = Math.min(255, Math.max(0, Math.round(tmp.storm * 255)));
    }
    // Replicate into the skipped rows below (clamped at the top edge).
    const srcStart = row * width * 4;
    const srcEnd = srcStart + width * 4;
    for (let f = 1; f < STRIDE && row + f < height; f++) {
      data.copyWithin((row + f) * width * 4, srcStart, srcEnd);
    }
  }
  map.epochSec = timeSec;
}
