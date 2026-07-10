import * as THREE from "three";
import type { RockyPalette } from "./palettes";

// Per-chunk scatter: trees, rocks, surface clutter streamed in/out with the
// terrain quadtree's leaf chunks. A leaf at depth ≥ MIN_SCATTER_DEPTH owns
// the scatter in its surface region; when it subdivides, the children pick
// up scatter for their quadrants and the parent's scatter is disposed.
//
// Stable cell grid
// ────────────────
// Candidates are anchored to a FIXED N_GRID × N_GRID cell grid per cube
// face — they do not depend on which chunk owns them. Each (face, cu, cv)
// cell maps to a deterministic hash that controls whether a candidate
// exists there, its sub-cell jitter, and its kind/scale/yaw. As a chunk
// subdivides, its cells are partitioned among children — the same world
// positions reappear in the children with no flicker.
//
// Collision spheres
// ─────────────────
// Each placed object writes a `ScatterObject` into the shared registry
// passed by the planet; the player resolves obstacle collisions in
// planet-local space against that registry. The registry is a Set so chunk
// disposal can remove its entries in O(n_chunk) without scanning a flat
// list.

export type ScatterKind = "tree" | "rock";

export interface ScatterObject {
  kind: ScatterKind;
  /** Center of the collision sphere in planet-LOCAL coords. */
  localPosition: THREE.Vector3;
  /** Collision-sphere radius (m). */
  collisionRadius: number;
}

/**
 * Shared GPU resources for a planet's scatter. Created once per planet,
 * passed to every chunk's scatter so the geometry + materials are reused
 * across many InstancedMesh instances.
 */
export interface ScatterResources {
  /** Crossed-plane "X-billboard" geometry — 3 vertical planes at 0°/60°/120°
   *  around Y, sharing one alpha-tested tree silhouette texture. Cheaper
   *  per instance than separate trunk + canopy meshes, and good enough at
   *  any walking distance. */
  treeGeom: THREE.BufferGeometry;
  treeMat: THREE.Material;
  /** Tree texture — exposed only so it can be disposed with the resources. */
  treeTex: THREE.Texture;
  rockGeom: THREE.BufferGeometry;
  rockMat: THREE.Material;
}

export interface ChunkScatterOpts {
  /** 0..5; matches the planet's face index ordering. Used as a hash channel
   *  so cells on different faces don't collide. */
  faceIndex: number;
  uAxis: THREE.Vector3;
  vAxis: THREE.Vector3;
  faceNormal: THREE.Vector3;
  /** Chunk's bounds on the face, in [-1, 1] per axis. */
  uMin: number; uMax: number;
  vMin: number; vMax: number;

  seed: number;
  radius: number;
  seaLevel: number;
  maxElevation: number;
  hasOcean: boolean;
  palette: RockyPalette;
  heightAt(localDir: THREE.Vector3): number;

  /** Planet's THREE group — scatter meshes parent here so they ride the
   *  planet's rotation + orbital translation automatically. */
  group: THREE.Group;
  resources: ScatterResources;
  /** The planet-level registry. New scatter objects are added on build,
   *  removed on dispose. */
  registry: Set<ScatterObject>;
}

export interface ChunkScatter {
  /** InstancedMesh instances owned by this chunk; disposed on teardown. */
  meshes: THREE.InstancedMesh[];
  /** ScatterObjects this chunk added to the planet-level registry — kept
   *  here so the chunk's dispose can remove them from the registry. */
  objects: ScatterObject[];
}

// ── Tuning ──────────────────────────────────────────────────────────────────

// Cells per face side. Total candidates per planet (pre-biome) ≈ N_GRID² × 6.
// At N_GRID = 1024 and a 50 km home planet, the densest cells correspond to
// roughly 70 m surface spacing — close enough to read as "forest" when in a
// vegetation band, sparser elsewhere after biome rejection.
const N_GRID = 1024;
const HALF_N_GRID = N_GRID / 2;
// Depth threshold below which leaf chunks generate no scatter. With
// crossed-plane billboards (cheap per instance) we can push this down to
// depth 5 — chunks ~1.5 km across — so scatter appears in the player's
// view well before they descend to walking altitude, instead of popping in
// chunk-by-chunk at close range.
export const MIN_SCATTER_DEPTH = 5;

// Base sizes for placed scatter (before per-instance scale variation).
// Trees here are billboard quads — width × height of one plane.
const TREE_PLANE_W = 2.5;
const TREE_PLANE_H = 5.5;
const TREE_BURY = 0.4;

// Match the biome bands used by planet.ts colorForHeight.
const SHORE_SHALLOW = 40;

// ── Scatter resources (per planet) ──────────────────────────────────────────

export function createScatterResources(palette: RockyPalette): ScatterResources {
  const canopyColor = palette.forest ?? palette.grass ?? new THREE.Color("#2e5e2a");

  const treeTex = makeTreeTexture(canopyColor);
  const treeGeom = makeCrossedPlanesGeometry(TREE_PLANE_W, TREE_PLANE_H, TREE_BURY);
  const treeMat = new THREE.MeshStandardMaterial({
    map: treeTex,
    // Alpha-tested rather than transparent so depth sorting Just Works and
    // we don't need a custom render-order pass. The cutoff is high enough
    // that the canopy silhouette stays opaque and low enough that the edge
    // antialiasing on the canvas doesn't get clipped to a hard fringe.
    alphaTest: 0.5,
    // Both sides — otherwise from one of the three rotations we'd see
    // through the tree as we walked around it.
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0.0,
  });

  const rockGeom = new THREE.IcosahedronGeometry(1.0, 0);
  rockGeom.scale(1.0, 0.7, 1.0);
  rockGeom.translate(0, 0.3, 0);
  const rockMat = new THREE.MeshStandardMaterial({
    color: palette.rock,
    roughness: 0.95,
    flatShading: true,
  });

  return { treeGeom, treeMat, treeTex, rockGeom, rockMat };
}

export function disposeScatterResources(r: ScatterResources): void {
  r.treeGeom.dispose();
  r.rockGeom.dispose();
  r.treeMat.dispose();
  r.rockMat.dispose();
  r.treeTex.dispose();
}

// 3 vertical planes at 0°/60°/120° around Y, each `width` wide and `height`
// tall, base buried `bury` metres below local origin (to mask LOD
// interpolation mismatches at the footprint). All-up normals so lighting
// stays consistent as the player walks around — perpendicular per-plane
// normals would flip the shading from "front-lit" to "edge-on" every 30°
// and look terrible.
export function makeCrossedPlanesGeometry(width: number, height: number, bury: number): THREE.BufferGeometry {
  const halfW = width / 2;
  const yBase = -bury;
  const yTop = height - bury;
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < 3; i++) {
    const angle = (Math.PI / 3) * i;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const baseIdx = i * 4;
    // 4 corners: BL, BR, TL, TR. Rotate (x, ·, 0) around Y by `angle`.
    const corners: ReadonlyArray<[number, number]> = [
      [-halfW, yBase], [halfW, yBase], [-halfW, yTop], [halfW, yTop],
    ];
    const cornerUVs: ReadonlyArray<[number, number]> = [
      [0, 0], [1, 0], [0, 1], [1, 1],
    ];
    for (let j = 0; j < 4; j++) {
      const [x, y] = corners[j];
      positions.push(x * c, y, x * s);
      uvs.push(cornerUVs[j][0], cornerUVs[j][1]);
      normals.push(0, 1, 0);
    }
    indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
    indices.push(baseIdx + 1, baseIdx + 3, baseIdx + 2);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geom.setIndex(indices);
  return geom;
}

// Procedural tree silhouette — brown trunk + green canopy on a transparent
// background. Drawn once, used for every tree on the planet (canopy tint
// varies per palette via the material's color, not the texture).
function makeTreeTexture(canopyColor: THREE.Color): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  const trunkW = size * 0.07;
  const trunkTop = size * 0.55;
  ctx.fillStyle = "#5a3a22";
  ctx.fillRect(cx - trunkW / 2, trunkTop, trunkW, size - trunkTop);

  // Canopy: irregular blob of overlapping ovals.
  const canopyMain = `#${canopyColor.getHexString()}`;
  const canopyDark = `#${canopyColor.clone().multiplyScalar(0.65).getHexString()}`;
  const canopyLight = `#${canopyColor.clone().multiplyScalar(1.15).getHexString()}`;

  // Big base ellipse.
  ctx.fillStyle = canopyMain;
  ctx.beginPath();
  ctx.ellipse(cx, size * 0.42, size * 0.42, size * 0.38, 0, 0, Math.PI * 2);
  ctx.fill();

  // Dark patches for depth.
  ctx.fillStyle = canopyDark;
  ctx.beginPath();
  ctx.ellipse(size * 0.38, size * 0.5, size * 0.18, size * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(size * 0.62, size * 0.6, size * 0.16, size * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();

  // Highlight blobs.
  ctx.fillStyle = canopyLight;
  ctx.beginPath();
  ctx.ellipse(size * 0.42, size * 0.25, size * 0.14, size * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(size * 0.65, size * 0.32, size * 0.12, size * 0.10, 0, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ── Chunk scatter ───────────────────────────────────────────────────────────

interface Placement {
  local: THREE.Vector3;
  scale: number;
  yaw: number;
}

const _dir = new THREE.Vector3();
const _cubePoint = new THREE.Vector3();

export function createChunkScatter(opts: ChunkScatterOpts): ChunkScatter {
  const {
    faceIndex, uAxis, vAxis, faceNormal,
    uMin, uMax, vMin, vMax,
    seed, radius, seaLevel, maxElevation, hasOcean,
    palette, heightAt, group, resources, registry,
  } = opts;

  const hasVegetation = !!palette.grass;
  const treeLine = maxElevation * 0.5;
  const snowLine = maxElevation * 0.75;

  // [-1, 1] face coords → [0, N_GRID] cell indices.
  const cellU0 = Math.max(0, Math.floor((uMin + 1) * HALF_N_GRID));
  const cellU1 = Math.min(N_GRID, Math.ceil((uMax + 1) * HALF_N_GRID));
  const cellV0 = Math.max(0, Math.floor((vMin + 1) * HALF_N_GRID));
  const cellV1 = Math.min(N_GRID, Math.ceil((vMax + 1) * HALF_N_GRID));

  const treePlacements: Placement[] = [];
  const rockPlacements: Placement[] = [];
  const objects: ScatterObject[] = [];

  for (let cu = cellU0; cu < cellU1; cu++) {
    for (let cv = cellV0; cv < cellV1; cv++) {
      // Four hash channels for jitter / kind / scale / yaw — all from the
      // same (face, cu, cv, seed) so the per-cell variation is stable across
      // LOD transitions.
      const h0 = hashCell(faceIndex, cu, cv, seed ^ 0x68f31b1c);
      const h1 = hashCell(faceIndex, cu, cv, seed ^ 0x2c41a3d7);
      const h2 = hashCell(faceIndex, cu, cv, seed ^ 0xc8e64b91);
      const h3 = hashCell(faceIndex, cu, cv, seed ^ 0x9a3f1de2);

      const jitterU = (h0 & 0xffff) / 0xffff;
      const jitterV = ((h0 >>> 16) & 0xffff) / 0xffff;
      const u = ((cu + jitterU) / HALF_N_GRID) - 1;
      const v = ((cv + jitterV) / HALF_N_GRID) - 1;

      // After jitter, the candidate might land outside this chunk's bounds
      // (it ROUNDS in by half a cell). Keep it only if it does — otherwise
      // the neighbouring chunk will pick it up.
      if (u < uMin || u >= uMax || v < vMin || v >= vMax) continue;

      // Cube → sphere.
      _cubePoint.copy(faceNormal).addScaledVector(uAxis, u).addScaledVector(vAxis, v);
      _dir.copy(_cubePoint).normalize();

      const elev = heightAt(_dir);
      // Skip underwater (only meaningful when the body has an ocean shell;
      // on barren bodies the seaLevel is at the basin floor anyway, so the
      // check is a no-op there).
      if (hasOcean && elev <= seaLevel + 5) continue;
      // Skip extreme peaks — visually clashes with snowcaps.
      if (elev > snowLine) continue;

      const inTreeBand = hasVegetation && elev > SHORE_SHALLOW && elev < treeLine;
      const rnd1 = (h1 & 0xffff) / 0xffff;
      const rnd2 = ((h1 >>> 16) & 0xffff) / 0xffff;
      let kind: ScatterKind;
      if (inTreeBand) {
        kind = rnd1 < 0.78 ? "tree" : "rock";
      } else {
        // Sand band + treeline+: rocks only, at reduced density to avoid a
        // uniform rock field.
        if (rnd1 > 0.33) continue;
        kind = "rock";
      }

      const scaleRnd = (h2 & 0xffff) / 0xffff;
      const yawRnd = ((h3 & 0xffff) / 0xffff) * Math.PI * 2;
      // Tree scale 1.5..3.0 → 8m..16m tall (planes are 5.5m base height),
      // visible from the air. Rocks stay smaller — 0.5..2.4m boulders.
      const scale = kind === "tree" ? 1.5 + scaleRnd * 1.5 : 0.5 + scaleRnd * 1.9;
      // Voiding unused rnd2 — keeps the channel reserved for later
      // (e.g. tilted rocks) without changing the hash schedule now.
      void rnd2;

      // Tree collision uses the geometry half-width as the base; rocks use
      // their visual radius. Both scale with the per-instance scale factor.
      const collisionRadius = kind === "tree" ? (TREE_PLANE_W / 2) * scale * 0.6 : 0.9 * scale;
      const localPos = _dir.clone().multiplyScalar(radius + elev);

      const placement: Placement = { local: localPos, scale, yaw: yawRnd };
      (kind === "tree" ? treePlacements : rockPlacements).push(placement);

      const obj: ScatterObject = { kind, localPosition: localPos, collisionRadius };
      objects.push(obj);
      registry.add(obj);
    }
  }

  const meshes: THREE.InstancedMesh[] = [];

  if (treePlacements.length > 0) {
    const treeMesh = new THREE.InstancedMesh(resources.treeGeom, resources.treeMat, treePlacements.length);
    treeMesh.name = "scatter_trees";
    fillInstanceMatrices(treeMesh, treePlacements);
    // InstancedMesh.boundingSphere defaults to null → frustum culling falls
    // back to geometry.boundingSphere, which only covers the geometry's
    // local origin. computeBoundingSphere walks the instance matrices to
    // build a real bounding sphere for the whole instance set.
    treeMesh.computeBoundingSphere();
    group.add(treeMesh);
    meshes.push(treeMesh);
  }

  if (rockPlacements.length > 0) {
    const rockMesh = new THREE.InstancedMesh(resources.rockGeom, resources.rockMat, rockPlacements.length);
    rockMesh.name = "scatter_rocks";
    fillInstanceMatrices(rockMesh, rockPlacements);
    rockMesh.computeBoundingSphere();
    group.add(rockMesh);
    meshes.push(rockMesh);
  }

  return { meshes, objects };
}

export function disposeChunkScatter(
  scatter: ChunkScatter,
  group: THREE.Group,
  registry: Set<ScatterObject>,
): void {
  for (const m of scatter.meshes) {
    group.remove(m);
    m.dispose();
  }
  for (const o of scatter.objects) registry.delete(o);
  scatter.meshes.length = 0;
  scatter.objects.length = 0;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const _xAxis = new THREE.Vector3();
const _yAxis = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _seedUp = new THREE.Vector3(0, 1, 0);
const _seedX = new THREE.Vector3(1, 0, 0);
const _basis = new THREE.Matrix4();
const _yawM = new THREE.Matrix4();
const _scaleM = new THREE.Matrix4();
const _full = new THREE.Matrix4();

function fillInstanceMatrices(
  mesh: THREE.InstancedMesh,
  placements: ReadonlyArray<Placement>,
): void {
  for (let i = 0; i < placements.length; i++) {
    const { local, scale, yaw } = placements[i];
    _yAxis.copy(local).normalize();
    const seed = Math.abs(_yAxis.y) < 0.9 ? _seedUp : _seedX;
    _zAxis.crossVectors(seed, _yAxis).normalize();
    _xAxis.crossVectors(_yAxis, _zAxis).normalize();
    _basis.makeBasis(_xAxis, _yAxis, _zAxis);
    _yawM.makeRotationY(yaw);
    _scaleM.makeScale(scale, scale, scale);
    _full.copy(_basis).multiply(_yawM).multiply(_scaleM);
    _full.setPosition(local);
    mesh.setMatrixAt(i, _full);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

// Mulberry-style integer hash specialised for (face, cu, cv, seed) inputs.
// Returns an unsigned 32-bit integer.
function hashCell(face: number, cu: number, cv: number, seed: number): number {
  let h = (face * 73856093) ^ (cu * 19349663) ^ (cv * 83492791) ^ (seed | 0);
  h = (h + 0x6d2b79f5) | 0;
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return (h ^ (h >>> 14)) >>> 0;
}
