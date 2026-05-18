import * as THREE from "three";

// One terrain patch — a sub-region (uMin..uMax) × (vMin..vMax) of one cube face,
// triangulated at fixed resolution and projected onto the sphere with the
// planet's height function applied at each vertex.
//
// Includes "skirts": each perimeter vertex is duplicated and pushed radially
// inward by `skirtDepth`, with the inner ring connected to the outer ring as
// vertical walls. This hides the cracks that would otherwise appear where two
// neighboring chunks render at different LOD levels (their edge vertices
// don't align because each samples height at different resolutions).
//
// All vertex positions are in PLANET-LOCAL coordinates — i.e. relative to the
// planet's center. The Planet places the resulting mesh in a Group at the
// planet's world position.

export interface ChunkParams {
  /** Cube-face outward normal (one of ±X/±Y/±Z). */
  faceNormal: THREE.Vector3;
  /** Tangent axes for this face. uAxis × vAxis must equal faceNormal so
   *  triangles wind CCW from outside the planet. */
  uAxis: THREE.Vector3;
  vAxis: THREE.Vector3;
  uMin: number; uMax: number;
  vMin: number; vMax: number;
  /** Vertices per side of the main grid. */
  resolution: number;
  /** Planet base radius (height = 0 maps to this). */
  radius: number;
  /** Sea level offset above radius. Heights below this are clamped to it for
   *  shoreline geometry; the actual heightAt may go lower (sea floor). */
  seaLevel: number;
  /** Height-above-radius for a unit direction on the sphere. */
  heightAt: (dir: THREE.Vector3) => number;
  /** Per-vertex color from height. */
  colorForHeight: (h: number, out: THREE.Color) => THREE.Color;
  /** How far below the surface to drop the skirt's bottom ring. */
  skirtDepth: number;
}

export interface ChunkGeometry {
  geometry: THREE.BufferGeometry;
  /** Planet-local position of the chunk's approximate center, used for LOD
   *  distance checks. Averaged from the main grid vertex positions. */
  center: THREE.Vector3;
  /** Half-diagonal of the chunk in planet-local space — a rough "radius" used
   *  as the numerator in the LOD subdivide test. */
  size: number;
}

export function buildChunkGeometry(params: ChunkParams): ChunkGeometry {
  const N = params.resolution;
  const mainVertCount = N * N;
  const perimVertCount = 4 * (N - 1);
  const totalVertCount = mainVertCount + perimVertCount;

  const positions = new Float32Array(totalVertCount * 3);
  const colors = new Float32Array(totalVertCount * 3);
  // We compute normals manually rather than calling computeVertexNormals
  // because three.js's helper would average in the skirt-wall triangles,
  // tilting the perimeter normals toward horizontal and creating dark bands
  // visible at chunk seams. Skirt vertex normals are copied from their
  // corresponding perimeter vertex, so the wall shades like an extension of
  // the surface above it rather than a cliff face.
  const normals = new Float32Array(totalVertCount * 3);
  const indices: number[] = [];

  const tmpDir = new THREE.Vector3();
  const tmpColor = new THREE.Color();

  let cx = 0;
  let cy = 0;
  let cz = 0;

  // ── Main grid ────────────────────────────────────────────────────────────
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const uu = lerp(params.uMin, params.uMax, i / (N - 1));
      const vv = lerp(params.vMin, params.vMax, j / (N - 1));
      tmpDir
        .copy(params.faceNormal)
        .addScaledVector(params.uAxis, uu)
        .addScaledVector(params.vAxis, vv)
        .normalize();
      const h = params.heightAt(tmpDir);
      // Render geometry follows the actual heightAt (oceans dip below
      // radius, mountains rise above). The ocean sphere is rendered
      // separately as a single sea-level shell.
      const r = params.radius + h;
      const idx = (j * N + i) * 3;
      positions[idx + 0] = tmpDir.x * r;
      positions[idx + 1] = tmpDir.y * r;
      positions[idx + 2] = tmpDir.z * r;
      params.colorForHeight(h, tmpColor);
      colors[idx + 0] = tmpColor.r;
      colors[idx + 1] = tmpColor.g;
      colors[idx + 2] = tmpColor.b;
      cx += positions[idx + 0];
      cy += positions[idx + 1];
      cz += positions[idx + 2];
    }
  }

  const center = new THREE.Vector3(cx / mainVertCount, cy / mainVertCount, cz / mainVertCount);

  // Rough size: distance from center to corner.
  const cornerOff = ((N - 1) * N + (N - 1)) * 3;
  const size = Math.hypot(
    positions[cornerOff + 0] - center.x,
    positions[cornerOff + 1] - center.y,
    positions[cornerOff + 2] - center.z,
  );

  // Track main-grid index count so we know where skirt indices begin (used
  // by the manual normal pass — we only want main-grid triangles to feed
  // perimeter normals).
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i;
      const b = j * N + i + 1;
      const c = (j + 1) * N + i;
      const d = (j + 1) * N + i + 1;
      // CCW winding from outside (uAxis × vAxis = +faceNormal).
      indices.push(a, b, c, b, d, c);
    }
  }
  const mainIndexCount = indices.length;

  // ── Normals from main-grid triangles only ────────────────────────────────
  // Loop the main triangles, compute per-face normal, accumulate weighted
  // by face area into each vertex. Then normalize.
  const triA = new THREE.Vector3();
  const triB = new THREE.Vector3();
  const triC = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const fn = new THREE.Vector3();
  const readVec = (arr: Float32Array, idx: number, out: THREE.Vector3) =>
    out.set(arr[idx * 3], arr[idx * 3 + 1], arr[idx * 3 + 2]);
  for (let t = 0; t < mainIndexCount; t += 3) {
    const i0 = indices[t];
    const i1 = indices[t + 1];
    const i2 = indices[t + 2];
    readVec(positions, i0, triA);
    readVec(positions, i1, triB);
    readVec(positions, i2, triC);
    e1.subVectors(triB, triA);
    e2.subVectors(triC, triA);
    fn.crossVectors(e1, e2); // un-normalized — magnitude = 2 × area (area-weighted)
    normals[i0 * 3 + 0] += fn.x; normals[i0 * 3 + 1] += fn.y; normals[i0 * 3 + 2] += fn.z;
    normals[i1 * 3 + 0] += fn.x; normals[i1 * 3 + 1] += fn.y; normals[i1 * 3 + 2] += fn.z;
    normals[i2 * 3 + 0] += fn.x; normals[i2 * 3 + 1] += fn.y; normals[i2 * 3 + 2] += fn.z;
  }
  // Normalize main-grid vertex normals.
  for (let v = 0; v < mainVertCount; v++) {
    const o = v * 3;
    const nx = normals[o];
    const ny = normals[o + 1];
    const nz = normals[o + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    normals[o] = nx / len;
    normals[o + 1] = ny / len;
    normals[o + 2] = nz / len;
  }

  // ── Skirt ────────────────────────────────────────────────────────────────
  // Walk the perimeter of the main grid in CCW order (viewed from outside the
  // planet — same orientation as the main triangulation), and for each
  // perimeter vertex create a duplicate dropped inward by skirtDepth.
  const perim: number[] = [];
  for (let i = 0; i < N - 1; i++) perim.push(0 * N + i);                       // bottom edge (j=0), L→R
  for (let j = 0; j < N - 1; j++) perim.push(j * N + (N - 1));                 // right edge (i=N-1), B→T
  for (let i = N - 1; i > 0; i--) perim.push((N - 1) * N + i);                 // top edge (j=N-1), R→L
  for (let j = N - 1; j > 0; j--) perim.push(j * N + 0);                       // left edge (i=0), T→B

  for (let k = 0; k < perim.length; k++) {
    const mainIdx = perim[k];
    const skirtVertIdx = mainVertCount + k;
    const mOff = mainIdx * 3;
    const px = positions[mOff + 0];
    const py = positions[mOff + 1];
    const pz = positions[mOff + 2];
    const r = Math.sqrt(px * px + py * py + pz * pz);
    const scale = (r - params.skirtDepth) / r;
    const sOff = skirtVertIdx * 3;
    positions[sOff + 0] = px * scale;
    positions[sOff + 1] = py * scale;
    positions[sOff + 2] = pz * scale;
    colors[sOff + 0] = colors[mOff + 0];
    colors[sOff + 1] = colors[mOff + 1];
    colors[sOff + 2] = colors[mOff + 2];
    // Skirt normals copy the perimeter normal — gives them surface-like
    // shading instead of "vertical cliff."
    normals[sOff + 0] = normals[mOff + 0];
    normals[sOff + 1] = normals[mOff + 1];
    normals[sOff + 2] = normals[mOff + 2];
  }

  // Skirt wall quads. Each segment of the perimeter walk gets a quad
  // (top_k, top_k+1, skirt_k+1, skirt_k). With the CCW perimeter walk above,
  // (top0, top1, skirt0) is CCW from outside the wall.
  for (let k = 0; k < perim.length; k++) {
    const k1 = (k + 1) % perim.length;
    const top0 = perim[k];
    const top1 = perim[k1];
    const skirt0 = mainVertCount + k;
    const skirt1 = mainVertCount + k1;
    indices.push(top0, top1, skirt0, top1, skirt1, skirt0);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  // Intentionally no computeVertexNormals() — normals are set above using
  // only main-grid triangles, with skirt normals copied from their
  // corresponding perimeter vertex.

  return { geometry, center, size };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
