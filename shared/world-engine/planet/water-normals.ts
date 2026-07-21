/**
 * The wave field — generated, never loaded.
 *
 * The 3D engine has no image assets and no TextureLoader; every texture in it
 * is procedural (the toon ramp in materials.ts, the weather map in
 * cloud-system.ts). Water keeps that property: this bakes a summed-sine wave
 * field into one texture — tangent-space normal in RGB, height in ALPHA. Both
 * shading modes read the same texture: standard perturbs normals with RGB,
 * toon cuts foam bands out of A.
 *
 * SEAMLESS BY CONSTRUCTION: every wave's frequency is an INTEGER lattice
 * vector, i.e. a whole number of cycles across the tile, so the pattern meets
 * itself exactly at the wrap. That is what lets chunk.ts wrap `detailUv` to whole
 * tiles and get away with it — the two facts are one mechanism, so anything
 * here that breaks exact tiling shows up as seams at chunk borders rather than
 * as a wrong-looking texture.
 *
 * WHY IT ISN'T A GRID: a small set of sines all peaking at the origin sums to a
 * regular lattice of square cells — it reads as woven plaid, not water. Three
 * things prevent that, and all three are load-bearing:
 *   - many waves, not a handful;
 *   - directions spread by the golden angle, so no two are parallel or
 *     perpendicular (a near-90° pair is what draws the right angles);
 *   - a varied PHASE per wave, so they do not all crest at the same point.
 * Directions still snap to the integer lattice (they must, see SEAMLESS), but
 * at these magnitudes the lattice is dense enough in angle that the rounding
 * doesn't re-align them.
 */
import * as THREE from "three";

const SIZE = 256;
const WAVE_COUNT = 28;
/** Cycles-across-tile of the lowest band.
 *
 *  NOT a free knob — it trades against DETAIL_TILE_M, and it must stay high.
 *  Directions must land on the integer lattice (see SEAMLESS), and the lattice
 *  is nearly EMPTY of directions at small |k|: at |k|≈2 the only options are
 *  the axes and the diagonals, so any angular spread rounds onto them. Since
 *  amplitude goes as 1/|k|, those low waves are the STRONGEST ones — which put
 *  the field's dominant energy into perpendicular, axis-aligned pairs and drew
 *  a visible plaid. Keeping the base frequency high keeps the strong waves in a
 *  part of the lattice that has angles to offer; DETAIL_TILE_M is raised to match
 *  so the longest wave stays the same size in METRES. */
const BASE_FREQ = 4;
/** Spread of frequencies across the set — the spectrum's width. */
const FREQ_SPREAD = 14;
/** Slope of the wave field, before the normal encode. Small on purpose: this
 *  is the knob that decides how hard the specular glint moves, and glint that
 *  moves hard is a seizure risk (see terrain-shading.ts). */
const SLOPE = 0.0045;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export interface Wave { kx: number; ky: number; amp: number; phase: number; }

/** Deterministic — same field every run, no Math.random.
 *
 *  Exported for tests: baking the texture needs no GL, but asserting on 256²
 *  encoded texels says little, whereas the wave SET is where the "it looks like
 *  a woven grid" failure actually lives. */
const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));

/** Canonical travel direction: reduced by GCD and sign-normalized, so (1,2),
 *  (2,4) and (-1,-2) all collapse to one key.
 *
 *  Parallel is as bad as duplicate here. Rounding a spread of angles onto the
 *  integer lattice quietly produces parallel pairs — (1,2) and (2,4) look like
 *  different waves but travel the same line, so their ridges stack along one
 *  axis. That stacking is a good part of what reads as "square". Antiparallel
 *  counts too: a wave and its reverse ridge along the same line. */
function dirKey(kx: number, ky: number): string {
  const g = gcd(kx, ky) || 1;
  let rx = kx / g;
  let ry = ky / g;
  if (rx < 0 || (rx === 0 && ry < 0)) { rx = -rx; ry = -ry; }
  return `${rx},${ry}`;
}

export function buildWaves(): Wave[] {
  const waves: Wave[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < WAVE_COUNT; i++) {
    const theta = i * GOLDEN_ANGLE;
    // Frequencies climb across the set, so low bands carry the swell and high
    // bands the chop.
    const baseF = BASE_FREQ + (i / WAVE_COUNT) * FREQ_SPREAD;
    // On a collision, walk the frequency out rather than dropping the wave:
    // near the low end the lattice is coarse in angle and collisions are
    // common, so dropping would thin the swell band — exactly where the energy
    // is meant to be.
    for (let attempt = 0; attempt < 10; attempt++) {
      const f = baseF + attempt * 0.8;
      const kx = Math.round(f * Math.cos(theta));
      const ky = Math.round(f * Math.sin(theta));
      if (kx === 0 && ky === 0) continue;
      // Refuse the lattice's symmetry directions — axis-aligned and exact 45°.
      // They are what the eye reads as "square", they are over-represented
      // because rounding pulls toward them, and they are the ones that pair up
      // perpendicular with each other. Every other direction is fair game.
      if (kx === 0 || ky === 0 || Math.abs(kx) === Math.abs(ky)) continue;
      const key = dirKey(kx, ky);
      if (seen.has(key)) continue;
      seen.add(key);
      const mag = Math.hypot(kx, ky);
      waves.push({
        kx,
        ky,
        // ~1/|k|: long waves carry the energy, like real wind waves.
        amp: 1 / mag,
        // Irrational stride — no repeat, no accidental in-phase cluster.
        phase: (i * GOLDEN_ANGLE * 7.3) % (Math.PI * 2),
      });
      break;
    }
  }
  return waves;
}

let waveField: THREE.DataTexture | null = null;

/** Lazy shared singleton — every water surface samples this one texture. Never
 *  disposed with a mesh (it outlives any single world), like the toon ramp. */
export function getWaveField(): THREE.DataTexture {
  if (waveField) return waveField;

  const waves = buildWaves();
  const heights = new Float32Array(SIZE * SIZE);
  const data = new Uint8Array(SIZE * SIZE * 4);

  let hMin = Infinity;
  let hMax = -Infinity;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      let h = 0;
      let dhdu = 0;
      let dhdv = 0;
      for (const w of waves) {
        const p = 2 * Math.PI * (w.kx * u + w.ky * v) + w.phase;
        h += Math.sin(p) * w.amp;
        // Analytic slope — a finite difference at this resolution rounds the
        // high-frequency waves away and the map comes out flat.
        const c = Math.cos(p) * w.amp * 2 * Math.PI;
        dhdu += c * w.kx;
        dhdv += c * w.ky;
      }
      heights[y * SIZE + x] = h;
      if (h < hMin) hMin = h;
      if (h > hMax) hMax = h;

      let nx = -dhdu * SLOPE;
      let ny = -dhdv * SLOPE;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const o = (y * SIZE + x) * 4;
      data[o + 0] = Math.round((nx / len * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
    }
  }

  // Alpha = height, normalized against the field's ACTUAL range. The
  // theoretical range (sum of amplitudes) is never reached, and normalizing
  // against it would leave the toon foam threshold with nothing to cut.
  const span = hMax - hMin || 1;
  for (let i = 0; i < heights.length; i++) {
    data[i * 4 + 3] = Math.round(((heights[i] - hMin) / span) * 255);
  }

  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // Mipmaps ARE the distance treatment: as the tile goes sub-pixel from flight
  // altitude the chain averages to flat, so the ocean settles into smooth
  // shading instead of aliasing into sparkling noise — which matters for more
  // than looks (see the seizure note in terrain-shading.ts).
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  waveField = tex;
  return tex;
}
