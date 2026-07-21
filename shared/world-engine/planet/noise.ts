/**
 * Planet noise — ported from seagull-dream's noise.ts (verbatim math): a
 * deterministic mulberry32-seeded simplex FBM pair. The `continent` channel
 * shapes pure-noise planets; the `detail` channel adds sub-cell relief on
 * substrate-backed surfaces (surface.ts).
 */
import { createNoise3D } from "simplex-noise";

/** Mulberry32 — small deterministic PRNG used to seed the noise generator. */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PlanetNoise {
  /** Continent shape: low-frequency, decides land vs ocean. Returns -1..1. */
  continent: (x: number, y: number, z: number) => number;
  /** Roughness: higher-frequency detail layered on top. Returns -1..1. */
  detail: (x: number, y: number, z: number) => number;
  /** ONE raw simplex octave (the detail channel's base) — for callers that
   *  assemble their own frequency bands and can't afford a full FBM per
   *  band (surface.ts metric relief, sampled per terrain vertex). */
  octave: (x: number, y: number, z: number) => number;
}

export function makePlanetNoise(seed: number): PlanetNoise {
  const rngA = mulberry32(seed);
  const rngB = mulberry32(seed ^ 0x9e3779b9);
  const continentBase = createNoise3D(rngA);
  const detailBase = createNoise3D(rngB);

  // Fractal Brownian Motion — sum octaves of noise at increasing frequencies.
  const fbm = (
    base: (x: number, y: number, z: number) => number,
    octaves: number,
    lacunarity: number,
    gain: number,
  ) => (x: number, y: number, z: number) => {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * base(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  };

  return {
    continent: fbm(continentBase, 4, 2.0, 0.5),
    detail: fbm(detailBase, 5, 2.1, 0.55),
    octave: detailBase,
  };
}
