/**
 * Tileable value noise — the generator the land detail textures are baked from.
 *
 * Separate from water for a real reason, not tidiness: waves ARE sinusoids, so
 * water-normals.ts sums sines and gets an analytic slope for free. Ground is
 * not sinusoidal at any scale, and a sum of sines that tries to look like soil
 * comes out as the same plaid the wave field had to be argued out of. So land
 * gets lattice noise instead.
 *
 * It inherits water's one hard constraint, though. Every frequency is an
 * INTEGER number of cycles across the tile, and the lattice hash is taken
 * modulo that frequency, so the pattern meets itself exactly at the wrap. That
 * is what lets chunk.ts offset `detailUv` by whole tiles (see DETAIL_TILE_M):
 * seamlessness here and the planet-scale float32 fix there are one mechanism.
 * A non-integer frequency doesn't look slightly wrong — it draws a hard seam
 * down every chunk border.
 *
 * FRAMEWORK-FREE on purpose: no THREE import. This is arithmetic, and the
 * callers that bake it into a DataTexture are the ones that touch a renderer.
 */

/** Integer hash → [0,1). Math.imul throughout: the same expression with `*`
 *  silently leaves the int32 range and returns float garbage, which shows up as
 *  a noise field with visible structure rather than as an error. */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Value noise at (u,v) ∈ [0,1)², with `freq` cycles across the tile.
 *
 *  `freq` MUST be a positive integer — the wrap is `% freq`, so a fractional
 *  frequency puts a discontinuity at the tile edge. Returns [0,1). */
export function tileNoise(u: number, v: number, freq: number, seed: number): number {
  const x = u * freq;
  const y = v * freq;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  // Wrap the lattice, not the sample: cell freq-1 must border cell 0.
  const x0 = ((xi % freq) + freq) % freq;
  const y0 = ((yi % freq) + freq) % freq;
  const x1 = (x0 + 1) % freq;
  const y1 = (y0 + 1) % freq;
  const sx = fade(fx);
  const sy = fade(fy);
  const top = lerp(hash2(x0, y0, seed), hash2(x1, y0, seed), sx);
  const bot = lerp(hash2(x0, y1, seed), hash2(x1, y1, seed), sx);
  return lerp(top, bot, sy);
}

/** Fractal sum of `octaves` tileNoise layers, each double the frequency and
 *  half the amplitude. Normalized to [0,1).
 *
 *  Frequencies stay integer by construction (base × 2ⁿ), so the tiling survives
 *  the sum — which is exactly why the base must be an integer too. */
export function tileFbm(u: number, v: number, base: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = base;
  for (let o = 0; o < octaves; o++) {
    sum += tileNoise(u, v, freq, seed + o * 101) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}
