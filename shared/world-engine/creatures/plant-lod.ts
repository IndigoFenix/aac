// Plant LOD — per-KIND static geometry tiers + a baked impostor.
//
// The distant-plants problem (fractal branch geometry × thousands of
// instances) is solved in three moves:
//
// 1. Plants are STATIC: bind pose == rest pose in the creature pipeline,
//    so a built plant's vertex positions are final — one non-skinned
//    BufferGeometry per kind, instanced per chunk (scatter.ts pattern)
//    instead of one skinned mesh per plant.
// 2. LOD tiers are BUDGET TRUNCATIONS of one generator run: growth.ts
//    emits segments coarse-to-fine with a prefix guarantee, so LOD1's
//    trunk and main branches are bit-identical to LOD0's — no popping,
//    no separately-authored LOD models. LOD1 replaces individual leaf
//    cards with a few "canopy blob" ellipsoids (the chunky flat-shaded
//    look survives; the fill rate doesn't care).
// 3. Beyond LOD1 the kind bakes ONCE into a small unlit texture and
//    becomes a crossed-plane billboard (the exact machinery scatter.ts
//    already instances by the thousand — this texture simply replaces
//    the hand-drawn silhouette).
//
// three.js layer — the pure math stays in growth.ts. Dispose ownership:
// whoever calls buildPlantLods()/bakePlantImpostor() owns the returned
// geometries/textures and must dispose them (the lab does; the future
// scatter integration will hold them per kind next to its resources).

import * as THREE from "three";
import type { Blueprint } from "./blueprint";
import { buildSkeleton } from "./skeleton";
import { buildCreatureMesh } from "./mesh";
import { MAX_GROWTH_SEGMENTS } from "./growth";
import { makeCrossedPlanesGeometry } from "./crossed-planes";

/** Default tier budgets (segments). LOD1 is a PREFIX of LOD0. */
export const PLANT_LOD_BUDGETS = { lod0: MAX_GROWTH_SEGMENTS, lod1: 60 };
/** Fruit-body detail per tier (0..1) — LOD1 decimates rings/sides + drops
 *  ribs (a coarse fruit is a smooth few-ring blob). */
export const PLANT_LOD_FRUIT_DETAIL = { lod0: 1, lod1: 0.4 };
/** A growth's leaf count above which its foliage is aggregated into canopy
 *  blobs at LOD1. Below it (a fruit's crown/calyx, sparse leaves) the cards
 *  are kept — blobbing a pineapple crown both inflates geometry and wrecks
 *  its silhouette. */
export const CANOPY_BLOB_MIN_LEAVES = 30;
/** Impostor bake resolution (square RGBA). */
export const IMPOSTOR_SIZE = 256;

export interface PlantLodGeometry {
  geometry: THREE.BufferGeometry;
  vertices: number;
  triangles: number;
}

export interface PlantLods {
  /** Near: full budget + individual leaf cards. */
  lod0: PlantLodGeometry;
  /** Mid: prefix budget, leaves replaced by canopy blobs. */
  lod1: PlantLodGeometry;
  /** Creature-local AABB (shared by both tiers — LOD1 ⊂ LOD0). */
  bounds: { min: THREE.Vector3; max: THREE.Vector3 };
  dispose(): void;
}

// ── Static geometry from the creature pipeline ──────────────────────────

/** Build the blueprint through the normal skeleton→mesh path and strip it to
 *  a static geometry (positions are final because bind == rest). Adds a
 *  per-vertex `sway` attribute (0 root .. 1 canopy top) so a future wind
 *  vertex shader is data-ready.
 *
 *  `fruitDetail` sets the fruit-body LOD; `blobDenseLeaves` (LOD1) removes
 *  the leaves of DENSE-canopy growths from the mesh so `appendCanopyBlobs`
 *  can stand in for them — sparse leaves (a fruit crown) are kept as cards. */
function buildStaticGeometry(
  blueprint: Blueprint,
  budget: number,
  opts: { fruitDetail: number; blobDenseLeaves: boolean },
): { geometry: THREE.BufferGeometry; bounds: { min: THREE.Vector3; max: THREE.Vector3 } } {
  const skel = buildSkeleton(blueprint, undefined, undefined, budget);
  if (opts.blobDenseLeaves) {
    for (const gw of skel.growths) {
      if (gw.leaves.length >= CANOPY_BLOB_MIN_LEAVES) gw.leaves = [];
    }
  }
  const built = buildCreatureMesh(skel, blueprint, { fruitDetail: opts.fruitDetail });
  const geometry = built.mesh.geometry;
  geometry.deleteAttribute("skinIndex");
  geometry.deleteAttribute("skinWeight");

  // Sway weight: normalized height squared — trunks stay planted, tips
  // wave. Written now so the wind shader (deferred) only needs a uniform.
  const pos = geometry.getAttribute("position");
  let maxY = 1e-6;
  for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));
  const sway = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, pos.getY(i)) / maxY;
    sway[i] = t * t;
  }
  geometry.setAttribute("sway", new THREE.BufferAttribute(sway, 1));
  geometry.computeBoundingSphere();

  const bounds = {
    min: new THREE.Vector3(skel.bounds.min.x, skel.bounds.min.y, skel.bounds.min.z),
    max: new THREE.Vector3(skel.bounds.max.x, skel.bounds.max.y, skel.bounds.max.z),
  };
  // The skinned wrapper is discarded; its geometry lives on in the result.
  built.mesh.material instanceof THREE.Material && built.mesh.material.dispose();
  return { geometry, bounds };
}

// ── Canopy blobs (LOD1 foliage) ──────────────────────────────────────────

/** Cluster the DENSE-canopy leaf cards (the ones stripped from the LOD1
 *  mesh) into a few ellipsoid blobs: voxel-grid centroids, blob radius from
 *  leaf count. Deterministic (no RNG). Sparse leaves (a fruit crown, kept
 *  as cards in the mesh) are NOT blobbed. Merges INDEXED — the old
 *  toNonIndexed path tripled the vertex count, so LOD1 came out bigger than
 *  LOD0. */
function appendCanopyBlobs(blueprint: Blueprint, target: THREE.BufferGeometry): THREE.BufferGeometry {
  const skel = buildSkeleton(blueprint); // full budget — blobs stand in for the FULL canopy
  interface Cluster { sum: THREE.Vector3; count: number; leafLen: number; color: THREE.Color }
  const clusters = new Map<string, Cluster>();
  let plantHeight = 1;
  for (const gw of skel.growths) {
    for (const s of gw.segments) plantHeight = Math.max(plantHeight, s.b.y);
  }
  const voxel = Math.max(0.4, plantHeight / 5);
  for (const gw of skel.growths) {
    if (gw.leaves.length < CANOPY_BLOB_MIN_LEAVES) continue; // sparse crown → kept as cards
    const color = new THREE.Color(gw.blueprint.foliage.leafColor);
    for (const lf of gw.leaves) {
      if (lf.kind !== "leaf") continue;
      const key = `${Math.round(lf.pos.x / voxel)},${Math.round(lf.pos.y / voxel)},${Math.round(lf.pos.z / voxel)}`;
      let c = clusters.get(key);
      if (!c) {
        c = { sum: new THREE.Vector3(), count: 0, leafLen: 0, color };
        clusters.set(key, c);
      }
      c.sum.add(new THREE.Vector3(lf.pos.x, lf.pos.y, lf.pos.z));
      c.count++;
      c.leafLen = Math.max(c.leafLen, lf.lengthM);
    }
  }
  if (clusters.size === 0) return target;

  // Build one indexed geometry: the base (indexed) + each icosahedron blob,
  // concatenating attributes and offsetting the blobs' indices.
  const parts: THREE.BufferGeometry[] = [target];
  const blobs: THREE.BufferGeometry[] = [];
  for (const c of clusters.values()) {
    const center = c.sum.multiplyScalar(1 / c.count);
    const r = Math.min(voxel * 0.9, c.leafLen * (1.2 + Math.cbrt(c.count) * 0.55));
    const blob = new THREE.IcosahedronGeometry(r, 0); // indexed
    blob.translate(center.x, center.y, center.z);
    const nv = blob.getAttribute("position").count;
    const colors = new Float32Array(nv * 3);
    const sway = new Float32Array(nv);
    const swayV = Math.min(1, center.y / Math.max(1e-6, plantHeight)) ** 2;
    for (let i = 0; i < nv; i++) {
      colors[i * 3] = c.color.r; colors[i * 3 + 1] = c.color.g; colors[i * 3 + 2] = c.color.b;
      sway[i] = swayV;
    }
    blob.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    blob.setAttribute("sway", new THREE.BufferAttribute(sway, 1));
    blobs.push(blob);
    parts.push(blob);
  }

  let vTotal = 0, iTotal = 0;
  for (const g of parts) {
    vTotal += g.getAttribute("position").count;
    const idx = g.getIndex();
    iTotal += idx ? idx.count : g.getAttribute("position").count;
  }
  const pos = new Float32Array(vTotal * 3);
  const col = new Float32Array(vTotal * 3);
  const sw = new Float32Array(vTotal);
  const index = new Uint32Array(iTotal);
  let vOff = 0, iOff = 0;
  for (const g of parts) {
    const p = g.getAttribute("position");
    const c = g.getAttribute("color");
    const s = g.getAttribute("sway");
    pos.set(p.array as Float32Array, vOff * 3);
    col.set(c.array as Float32Array, vOff * 3);
    sw.set(s.array as Float32Array, vOff);
    const idx = g.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i++) index[iOff + i] = idx.getX(i) + vOff;
      iOff += idx.count;
    } else {
      for (let i = 0; i < p.count; i++) index[iOff + i] = vOff + i;
      iOff += p.count;
    }
    vOff += p.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  merged.setAttribute("color", new THREE.BufferAttribute(col, 3));
  merged.setAttribute("sway", new THREE.BufferAttribute(sw, 1));
  merged.setIndex(new THREE.BufferAttribute(index, 1));
  // plantMaterial uses flatShading (face normals derived in-shader), so
  // vertex normals aren't needed — skip computeVertexNormals.
  merged.computeBoundingSphere();
  for (const g of blobs) g.dispose();
  target.dispose();
  return merged;
}

// ── Public builders ──────────────────────────────────────────────────────

export function buildPlantLods(blueprint: Blueprint): PlantLods {
  const l0 = buildStaticGeometry(blueprint, PLANT_LOD_BUDGETS.lod0, {
    fruitDetail: PLANT_LOD_FRUIT_DETAIL.lod0,
    blobDenseLeaves: false,
  });
  const l1raw = buildStaticGeometry(blueprint, PLANT_LOD_BUDGETS.lod1, {
    fruitDetail: PLANT_LOD_FRUIT_DETAIL.lod1,
    blobDenseLeaves: true,
  });
  const l1geo = appendCanopyBlobs(blueprint, l1raw.geometry);
  const stats = (g: THREE.BufferGeometry): PlantLodGeometry => ({
    geometry: g,
    vertices: g.getAttribute("position").count,
    triangles: (g.getIndex() ? g.getIndex()!.count : g.getAttribute("position").count) / 3,
  });
  return {
    lod0: stats(l0.geometry),
    lod1: stats(l1geo),
    bounds: l0.bounds,
    dispose() {
      l0.geometry.dispose();
      l1geo.dispose();
    },
  };
}

/** One shared material for every static plant (vertex colors carry the
 *  kind look) — the whole point of per-vertex color in the pipeline. */
export function plantMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0,
    flatShading: true,
  });
}

// ── Impostor bake ────────────────────────────────────────────────────────

export interface PlantImpostor {
  texture: THREE.Texture;
  /** World size of the billboard planes. */
  widthM: number;
  heightM: number;
  dispose(): void;
}

/**
 * Bake ONE side view of the LOD1 mesh into a small RGBA texture, once per
 * kind (lazily, at kind creation — never per instance or per frame).
 *
 * Bake rules (each prevents a real artifact):
 * - UNLIT MeshBasicMaterial + vertexColors, `toneMapped: false`: the live
 *   scatter material lights the billboard at render time — baking lights
 *   or tone mapping in would double-light / double-crush it.
 * - Renderer tone mapping is disabled for the bake and restored after.
 * - Clear color = the kind' foliage color at alpha 0: alphaTest edges
 *   dilate into leaf-colored pixels, not black fringes.
 * v1 bakes a single view reused on all 3 crossed planes (exactly what the
 * hand-drawn scatter texture does); a 3-view atlas is deferred.
 */
export function bakePlantImpostor(
  renderer: THREE.WebGLRenderer,
  lods: PlantLods,
  blueprint: Blueprint,
): PlantImpostor {
  const size = new THREE.Vector3().subVectors(lods.bounds.max, lods.bounds.min);
  const widthM = Math.max(size.x, size.z, 0.1);
  const heightM = Math.max(size.y, 0.1);

  const target = new THREE.WebGLRenderTarget(IMPOSTOR_SIZE, IMPOSTOR_SIZE, {
    format: THREE.RGBAFormat,
    // Linear bake; the scatter material samples it like any albedo map.
    colorSpace: THREE.NoColorSpace,
  });

  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(
    lods.lod1.geometry,
    new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
  );
  scene.add(mesh);

  // Ortho camera looking down -Z at the plant's full extent.
  const cx = (lods.bounds.min.x + lods.bounds.max.x) / 2;
  const cy = (lods.bounds.min.y + lods.bounds.max.y) / 2;
  const half = Math.max(widthM, heightM) / 2;
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, half * 6);
  camera.position.set(cx, cy, lods.bounds.max.z + half * 2);
  camera.lookAt(cx, cy, 0);

  // Average foliage color (fall back to the stem/skin color) for fringes.
  const fringe = new THREE.Color(0, 0, 0);
  let nc = 0;
  for (const gr of blueprint.growths) {
    if (gr.foliage.leafDensity > 0) {
      fringe.add(new THREE.Color(gr.foliage.leafColor));
      nc++;
    }
  }
  if (nc === 0) fringe.add(new THREE.Color(blueprint.skin.baseColor));
  fringe.multiplyScalar(1 / Math.max(1, nc));

  // Save → bake → restore renderer state.
  const prevTarget = renderer.getRenderTarget();
  const prevToneMapping = renderer.toneMapping;
  const prevClearColor = new THREE.Color();
  renderer.getClearColor(prevClearColor);
  const prevClearAlpha = renderer.getClearAlpha();
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(target);
  renderer.setClearColor(fringe, 0);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(prevTarget);
  renderer.toneMapping = prevToneMapping;
  renderer.setClearColor(prevClearColor, prevClearAlpha);

  mesh.material.dispose();

  return {
    texture: target.texture,
    widthM,
    heightM,
    dispose() {
      target.dispose();
    },
  };
}

/** Assemble the billboard: scatter's crossed planes + the baked texture,
 *  lit live by the same standard-material rules the scatter trees use.
 *
 *  The planes are emitted TWICE with opposed winding instead of using a
 *  DoubleSide material: a lit double-sided material flips the shared
 *  all-up normal on backfaces (planes go night-dark from behind); two
 *  front-facing copies keep the up normal from every angle. */
export function makeImpostorMesh(impostor: PlantImpostor): THREE.Mesh {
  const single = makeCrossedPlanesGeometry(impostor.widthM, impostor.heightM, 0);
  const idx = single.getIndex()!;
  const both = single.clone();
  const combined = new Uint16Array(idx.count * 2);
  combined.set(idx.array as ArrayLike<number>, 0);
  for (let i = 0; i < idx.count; i += 3) {
    combined[idx.count + i] = idx.getX(i);
    combined[idx.count + i + 1] = idx.getX(i + 2);
    combined[idx.count + i + 2] = idx.getX(i + 1);
  }
  both.setIndex(new THREE.BufferAttribute(combined, 1));
  single.dispose();
  const mat = new THREE.MeshStandardMaterial({
    map: impostor.texture,
    alphaTest: 0.5,
    roughness: 0.9,
    metalness: 0,
  });
  return new THREE.Mesh(both, mat);
}
