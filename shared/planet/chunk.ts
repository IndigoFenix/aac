/**
 * One terrain patch — seagull-dream's chunk.ts, ported framework-free (the
 * client-as-display-engine rule: geometry is plain typed arrays; the THREE
 * adapter in three.ts is the only file that touches a renderer).
 *
 * A sub-region (uMin..uMax) × (vMin..vMax) of one cube face, triangulated at
 * fixed resolution and projected onto the sphere with the surface's height
 * applied at each vertex.
 *
 * Includes "skirts": each perimeter vertex is duplicated and pushed radially
 * inward by `skirtDepth`, with the inner ring connected to the outer ring as
 * vertical walls — hiding the cracks where neighbouring chunks render at
 * different LOD levels. Normals are computed from MAIN-GRID triangles only,
 * and skirt vertices copy their perimeter vertex's normal, so walls shade
 * like an extension of the surface instead of a cliff (averaging in the
 * skirt walls would tilt perimeter normals and draw dark seam bands).
 *
 * All vertex positions are PLANET-LOCAL (relative to the planet's center).
 */
import type { PlanetSurface, Vec3 } from "./surface";

/** The 6 cube-face frames, right-handed (u × v = outward normal) so main
 *  triangles wind CCW seen from outside the planet. */
export const PLANET_FACES: ReadonlyArray<{ n: Vec3; u: Vec3; v: Vec3 }> = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

export interface ChunkParams {
  face: number; // index into PLANET_FACES
  uMin: number; uMax: number;
  vMin: number; vMax: number;
  /** Vertices per side of the main grid. */
  resolution: number;
  surface: PlanetSurface;
  /** How far below the surface to drop the skirt's bottom ring. */
  skirtDepth: number;
  /** Ocean worlds: clamp the rendered surface UP to sea level (a flat water
   *  surface) instead of dipping into basins. Color still uses the real
   *  (negative) height, so water is depth-shaded — and there's no separate
   *  translucent sphere to z-fight the seabed. */
  seaClamp?: boolean;
}

export interface ChunkGeometryData {
  positions: Float32Array;
  colors: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Planet-local position of the chunk's approximate center (LOD checks). */
  center: Vec3;
  /** Half-diagonal in planet-local space — the LOD test's numerator. */
  size: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function buildChunkGeometry(params: ChunkParams): ChunkGeometryData {
  const N = params.resolution;
  const F = PLANET_FACES[params.face];
  const { surface } = params;
  const radius = surface.radius;
  const mainVertCount = N * N;
  const perimVertCount = 4 * (N - 1);
  const totalVertCount = mainVertCount + perimVertCount;

  const positions = new Float32Array(totalVertCount * 3);
  const colors = new Float32Array(totalVertCount * 3);
  const normals = new Float32Array(totalVertCount * 3);
  const indices: number[] = [];

  const dir: [number, number, number] = [0, 0, 0];
  const rgb: [number, number, number] = [0, 0, 0];

  let cx = 0;
  let cy = 0;
  let cz = 0;

  // ── Main grid ────────────────────────────────────────────────────────────
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const uu = lerp(params.uMin, params.uMax, i / (N - 1));
      const vv = lerp(params.vMin, params.vMax, j / (N - 1));
      let dx = F.n[0] + F.u[0] * uu + F.v[0] * vv;
      let dy = F.n[1] + F.u[1] * uu + F.v[1] * vv;
      let dz = F.n[2] + F.u[2] * uu + F.v[2] * vv;
      const m = Math.hypot(dx, dy, dz);
      dx /= m; dy /= m; dz /= m;
      dir[0] = dx; dir[1] = dy; dir[2] = dz;
      const h = surface.heightAt(dir);
      // Water renders as a flat sea-level surface (clamp up); color still uses
      // the real height below, so oceans are depth-shaded without a z-fighting
      // shell.
      const r = radius + (params.seaClamp && h < 0 ? 0 : h);
      const idx = (j * N + i) * 3;
      positions[idx + 0] = dx * r;
      positions[idx + 1] = dy * r;
      positions[idx + 2] = dz * r;
      surface.colorAt(h, dir, rgb);
      colors[idx + 0] = rgb[0];
      colors[idx + 1] = rgb[1];
      colors[idx + 2] = rgb[2];
      cx += positions[idx + 0];
      cy += positions[idx + 1];
      cz += positions[idx + 2];
    }
  }

  const center: Vec3 = [cx / mainVertCount, cy / mainVertCount, cz / mainVertCount];

  // Rough size: distance from center to corner.
  const cornerOff = ((N - 1) * N + (N - 1)) * 3;
  const size = Math.hypot(
    positions[cornerOff + 0] - center[0],
    positions[cornerOff + 1] - center[1],
    positions[cornerOff + 2] - center[2],
  );

  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i;
      const b = j * N + i + 1;
      const c = (j + 1) * N + i;
      const d = (j + 1) * N + i + 1;
      // CCW winding from outside (u × v = +faceNormal).
      indices.push(a, b, c, b, d, c);
    }
  }
  const mainIndexCount = indices.length;

  // ── Normals from main-grid triangles only ────────────────────────────────
  for (let t = 0; t < mainIndexCount; t += 3) {
    const i0 = indices[t] * 3;
    const i1 = indices[t + 1] * 3;
    const i2 = indices[t + 2] * 3;
    const e1x = positions[i1] - positions[i0];
    const e1y = positions[i1 + 1] - positions[i0 + 1];
    const e1z = positions[i1 + 2] - positions[i0 + 2];
    const e2x = positions[i2] - positions[i0];
    const e2y = positions[i2 + 1] - positions[i0 + 1];
    const e2z = positions[i2 + 2] - positions[i0 + 2];
    // Un-normalized cross — magnitude = 2 × area (area-weighted accumulate).
    const fx = e1y * e2z - e1z * e2y;
    const fy = e1z * e2x - e1x * e2z;
    const fz = e1x * e2y - e1y * e2x;
    normals[i0] += fx; normals[i0 + 1] += fy; normals[i0 + 2] += fz;
    normals[i1] += fx; normals[i1 + 1] += fy; normals[i1 + 2] += fz;
    normals[i2] += fx; normals[i2 + 1] += fy; normals[i2 + 2] += fz;
  }
  for (let v = 0; v < mainVertCount; v++) {
    const o = v * 3;
    const len = Math.hypot(normals[o], normals[o + 1], normals[o + 2]) || 1;
    normals[o] /= len;
    normals[o + 1] /= len;
    normals[o + 2] /= len;
  }

  // ── Skirt ────────────────────────────────────────────────────────────────
  // Perimeter of the main grid in CCW order (viewed from outside), each
  // vertex duplicated and dropped radially inward by skirtDepth.
  const perim: number[] = [];
  for (let i = 0; i < N - 1; i++) perim.push(0 * N + i);
  for (let j = 0; j < N - 1; j++) perim.push(j * N + (N - 1));
  for (let i = N - 1; i > 0; i--) perim.push((N - 1) * N + i);
  for (let j = N - 1; j > 0; j--) perim.push(j * N + 0);

  for (let k = 0; k < perim.length; k++) {
    const mOff = perim[k] * 3;
    const sOff = (mainVertCount + k) * 3;
    const px = positions[mOff];
    const py = positions[mOff + 1];
    const pz = positions[mOff + 2];
    const r = Math.hypot(px, py, pz);
    const scale = (r - params.skirtDepth) / r;
    positions[sOff] = px * scale;
    positions[sOff + 1] = py * scale;
    positions[sOff + 2] = pz * scale;
    colors[sOff] = colors[mOff];
    colors[sOff + 1] = colors[mOff + 1];
    colors[sOff + 2] = colors[mOff + 2];
    normals[sOff] = normals[mOff];
    normals[sOff + 1] = normals[mOff + 1];
    normals[sOff + 2] = normals[mOff + 2];
  }

  for (let k = 0; k < perim.length; k++) {
    const k1 = (k + 1) % perim.length;
    indices.push(perim[k], perim[k1], mainVertCount + k, perim[k1], mainVertCount + k1, mainVertCount + k);
  }

  return {
    positions, colors, normals,
    indices: Uint32Array.from(indices),
    center, size,
  };
}
