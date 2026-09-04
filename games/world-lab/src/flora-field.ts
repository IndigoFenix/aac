/**
 * FLORA FIELD — the planet's plants as a WORLD-FIXED streaming layer.
 *
 * Tree positions are a pure function of (world seed, position on the planet):
 * the sphere is tiled in CUBE-FACE coordinates (the same six faces the terrain
 * chunks use), and every tile's scatter is seeded by hash(face, tx, ty, seed).
 * A tile therefore holds the SAME trees at the SAME world spots whether you
 * fly over it, land in it, walk into it, or come back a session later —
 * nothing is anchored to the player or to a landing.
 *
 * Tiles stream by DISTANCE from the ground focus (the surface point under the
 * player), airborne or grounded — flying low over a forest shows the forest.
 * Representation is the creature-lab plant-LOD ladder, instanced:
 *   FAR  — baked impostor billboards (bakePlantImpostor), one draw per species
 *   MID  — the STICK tier (plant-lod's `stick`): trunk and boughs as thick
 *          camera-facing lines, canopy as circles. Unlike a billboard it still
 *          TURNS, so a mid-distance forest keeps its parallax for ~a quarter of
 *          LOD1's vertices.
 *   NEAR — the species' real LOD1 static geometry (buildPlantLods), same
 *          placements, swapped in as the focus approaches (impostors RESOLVE
 *          into stick trees, then into real trees).
 * All three representations share one set of deterministic placements per tile.
 *
 * What grows where comes from the planet's ECOLOGY: each tile reads the
 * PER-SPECIES ABUNDANCE at its center (grid.fields.eco_<key>, via
 * `ecoAbundanceAt`) and stands each species at its own density × the tile's
 * area, on the real terrain, skipping water. Density rather than a count is
 * what lets this layer and the interactive wilderness scatter agree: both go
 * through `ecology.ts`'s `standDensityPerHa`, so a tile and a town rect over
 * the same ground describe the same wood however wide each of them is. A
 * substrate with no baked ecology falls back to the legacy per-biome tables.
 * Fauna stays with the interactive wilderness chunk (NPC bodies); this layer
 * is pure flora rendering.
 */
import * as THREE from "three";
import type { CelestialBody } from "@shared/world-engine/space/world-types";
import { PLANET_FACES } from "@shared/world-engine/planet/chunk";
import { ecoAbundanceAt, standCountFor } from "@shared/world-engine/planet/ecology";
import { speciesBlueprint } from "@shared/world-engine/creatures/species";
import {
  buildPlantLods,
  bakePlantImpostor,
  makeImpostorMesh,
  plantMaterial,
  plantStickMaterial,
  type PlantImpostor,
} from "@shared/world-engine/creatures/plant-lod";

const TILE_M = 200;          // tile edge (metres of arc at the face centre)
const LOAD_R = 1_500;        // tiles stream in inside this of the ground focus
const UNLOAD_R = 2_100;      // …and out past this (hysteresis)
const NEAR_R = 260;          // sticks RESOLVE to real LOD1 geometry inside this
const STICK_R = 700;         // …and impostors resolve to STICK trees inside this
const BUILD_BUDGET = 2;      // tile builds per ensure() call (spread the cost)
// Rung (stick/real geometry) BUILDS per ensure() call. Tier resolution used
// to build unbudgeted: the whole STICK_R band crosses at once when the camera
// drops to city-orbit distance, and dozens of simultaneous InstancedMesh
// builds were a visible hitch in the flight→orbit transition. A tile past the
// budget keeps its current rung (billboard stays visible) and resolves on a
// later ~4 Hz call — the band converges over a couple of seconds instead of
// one giant frame.
const RUNG_BUILD_BUDGET = 3;

/** Tile ground area in HECTARES — what a per-hectare standing density is
 *  resolved against (see the scatter below). */
const TILE_HA = (TILE_M * TILE_M) / 10_000;

// ⚖️ LEGACY per-biome scatter counts per tile (biome field: 0 barren, 1 tree,
// 2 grass, 3 grazer range). Reached ONLY by a substrate with no baked
// per-species ecology — a bake serialized before `perSpecies` was switched on
// (`planet-game.ts`), or a grid that never ran `applyEcology` at all. On a
// modern substrate the counts come from the biosphere's own density law
// (`ecology.ts standCountFor`), which varies CONTINUOUSLY across the region
// instead of stepping through four buckets, and which the wilderness scatter
// reads through the same function — the two tree authorities used to disagree
// by 5.4× where they met (15.00 oaks/ha rendered here, 2.77 oaks/ha scattered
// inside a founding town's rect).
const OAK_COUNT = [1, 60, 11, 8];
const GRASS_COUNT = [2, 16, 44, 40];
// TREES RENDER AT THE MODEL'S OWN SIZE (the blueprint is the authority — a
// grown oak builds ~24 m tall): instance scale is just the per-placement
// variation `v`. The old fixed OAK_H (4.6, a relic of matching the box
// features the interactive chunk used to place) squashed every tree to
// shrub height — from a glide camera the resolved forest looked like it had
// LOST its trees next to the fat far-field silhouettes. GRASS keeps a
// display height: its blueprint is a 0.13 m tuft, unreadable as ground
// cover at native scale, and it has no interactive twin to agree with.
const GRASS_H = 0.6;

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hashTile = (face: number, tx: number, ty: number, seed: number): number =>
  (Math.imul(face + 1, 73856093) ^ Math.imul(tx, 19349663) ^ Math.imul(ty, 83492791) ^ Math.imul(seed, 2654435761)) >>> 0;

// ── Species assets (session-lifetime; shared by every tile and body) ────────
interface SpeciesAssets {
  impostor: PlantImpostor;
  billboardGeom: THREE.BufferGeometry;
  billboardMat: THREE.Material;
  realGeom: THREE.BufferGeometry;
  realMat: THREE.Material;
  realHeightM: number;
  stickGeom: THREE.BufferGeometry;
  /** NOT `realMat` — stick geometry stores capsule endpoints and only the
   *  stick shader knows how to expand them (plant-lod's plantStickMaterial). */
  stickMat: THREE.Material;
}
const assetsCache = new Map<string, SpeciesAssets>();

function speciesAssets(renderer: THREE.WebGLRenderer, species: string): SpeciesAssets {
  let a = assetsCache.get(species);
  if (!a) {
    const blueprint = speciesBlueprint(species);
    const lods = buildPlantLods(blueprint);
    const impostor = bakePlantImpostor(renderer, lods, blueprint);
    const billboard = makeImpostorMesh(impostor);
    // Keep LOD1 (the near representation); LOD0's full leaf-card geometry is
    // not used by the field — release it.
    lods.lod0.geometry.dispose();
    a = {
      impostor,
      billboardGeom: billboard.geometry,
      billboardMat: billboard.material as THREE.Material,
      realGeom: lods.lod1.geometry,
      realMat: plantMaterial(),
      realHeightM: Math.max(0.1, lods.bounds.max.y - lods.bounds.min.y),
      stickGeom: lods.stick.geometry,
      stickMat: plantStickMaterial(),
    };
    assetsCache.set(species, a);
  }
  return a;
}

// ── Cube-face tiling (world-fixed addresses) ────────────────────────────────
function faceOf(d: THREE.Vector3): number {
  const ax = Math.abs(d.x);
  const ay = Math.abs(d.y);
  const az = Math.abs(d.z);
  if (ax >= ay && ax >= az) return d.x >= 0 ? 0 : 1;
  if (ay >= az) return d.y >= 0 ? 2 : 3;
  return d.z >= 0 ? 4 : 5;
}
/** Face-plane coords of a unit direction on `face` (u, v ∈ [-1, 1]). */
function faceUV(face: number, d: THREE.Vector3): { u: number; v: number } {
  const F = PLANET_FACES[face];
  const n = d.x * F.n[0] + d.y * F.n[1] + d.z * F.n[2];
  return {
    u: (d.x * F.u[0] + d.y * F.u[1] + d.z * F.u[2]) / n,
    v: (d.x * F.v[0] + d.y * F.v[1] + d.z * F.v[2]) / n,
  };
}
function dirOfUV(face: number, u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  const F = PLANET_FACES[face];
  out.set(F.n[0] + F.u[0] * u + F.v[0] * v, F.n[1] + F.u[1] * u + F.v[1] * v, F.n[2] + F.u[2] * u + F.v[2] * v);
  return out.normalize();
}

// ── The scatter authority (pure, deterministic) ─────────────────────────────
// ONE function decides what grows where: the render field builds its instanced
// meshes from it, and the wilderness session derives its interactive FLORA
// TWINS from it — the tree you see IS the entity you touch. Anything that
// changes this function changes both in lockstep.
interface Placement { x: number; z: number; y: number; yaw: number; v: number }
interface TileScatter {
  /** Tile-centre body-local unit direction + ground height there. */
  dir: THREE.Vector3;
  h0: number;
  /** Tile frame (UP → dir) — placements are tile-local in this frame. */
  quat: THREE.Quaternion;
  placements: Map<string, Placement[]>;
}
/** The one TWINNABLE species — what the wilderness session materializes and
 *  the field suppresses per instance. Grass stays pure scenery. */
export const FLORA_TREE_SPECIES = "oak";
const UP = new THREE.Vector3(0, 1, 0);

/** Deterministic per-tile scatter, cached (pure function of body + tile).
 *  Null = open water at the tile centre. */
const scatterCache = new Map<string, TileScatter | null>();
function tileScatterOf(body: CelestialBody, face: number, tx: number, ty: number): TileScatter | null {
  const cacheKey = `${body.id}:${face}:${tx}:${ty}`;
  const hit = scatterCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const geo = body.geography;
  if (!geo) return null; // not cached — geography may still be baking
  const surface = geo.surface;
  const R = body.radius;
  const seed = (geo.spec?.geology?.seed ?? 1) >>> 0;
  const uTile = TILE_M / R;
  const dir = dirOfUV(face, (tx + 0.5) * uTile, (ty + 0.5) * uTile, new THREE.Vector3());
  const h0raw = surface.heightAt([dir.x, dir.y, dir.z]);
  let result: TileScatter | null = null;
  if (h0raw >= 0) {
    const cell = geo.grid.topo.cellAt ? geo.grid.topo.cellAt([dir.x, dir.y, dir.z]) : 0;
    const biomeRaw = geo.grid.fields.biome ? geo.grid.fields.biome[cell] : 0;
    const biome = Math.max(0, Math.min(3, Math.round(biomeRaw)));
    const h0 = Math.max(0, h0raw);
    const quat = new THREE.Quaternion().setFromUnitVectors(UP, dir);
    // Tile-local terrain (the same tangent-walk sampler towns use).
    const east = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
    const north = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
    const _g = new THREE.Vector3();
    const dirAt = (x: number, z: number): [number, number, number] => {
      _g.copy(dir).multiplyScalar(R).addScaledVector(east, x).addScaledVector(north, z).normalize();
      return [_g.x, _g.y, _g.z];
    };
    const groundAt = (x: number, z: number): number => {
      const h = Math.max(0, surface.heightAt(dirAt(x, z)));
      return (h - h0) - (x * x + z * z) / (2 * R);
    };
    const waterAt = (x: number, z: number): boolean => surface.heightAt(dirAt(x, z)) < 0;
    // Deterministic scatter — a pure function of the tile address + the seed.
    const rng = mulberry(hashTile(face, tx, ty, seed));
    const half = TILE_M / 2;
    const scatter = (count: number): Placement[] => {
      const out: Placement[] = [];
      for (let i = 0; i < count; i++) {
        const x = (rng() * 2 - 1) * half;
        const z = (rng() * 2 - 1) * half;
        const yaw = rng() * Math.PI * 2;
        const v = 0.85 + rng() * 0.5;
        if (waterAt(x, z)) continue; // consume the draws either way — determinism
        out.push({ x, z, y: groundAt(x, z), yaw, v });
      }
      return out;
    };
    // WHAT STANDS HERE, from the cell's own PER-SPECIES ABUNDANCE — a
    // density × this tile's area, not a bucket lookup. `null` means this
    // substrate carries no baked ecology, and the legacy tables answer.
    const eco = ecoAbundanceAt(geo.grid, cell);
    const placements = new Map<string, Placement[]>();
    placements.set("oak", scatter(eco ? standCountFor("oak", eco, TILE_HA) : OAK_COUNT[biome]!));
    placements.set("grass", scatter(eco ? standCountFor("grass", eco, TILE_HA) : GRASS_COUNT[biome]!));
    result = { dir, h0, quat, placements };
  }
  scatterCache.set(cacheKey, result);
  if (scatterCache.size > 512) {
    for (const k of scatterCache.keys()) {
      scatterCache.delete(k);
      if (scatterCache.size <= 384) break;
    }
  }
  return result;
}

/** A streamed TREE near a world point — its stable instance key
 *  (`face:tx:ty:i`, the suppression/twin address) and its WORLD position.
 *  The same placements the field renders; a caller materializing session
 *  twins from this list hides exactly these instances (setTwinHidden). */
export interface FloraTreeRef { key: string; world: THREE.Vector3 }
const _ftnLocal = new THREE.Vector3();
export function floraTreesNear(body: CelestialBody, world: THREE.Vector3, r: number): FloraTreeRef[] {
  const geo = body.geography;
  if (!geo || !body.walkable) return [];
  const R = body.radius;
  const uTile = TILE_M / R;
  body.group.updateWorldMatrix(true, false);
  const local = body.group.worldToLocal(_ftnLocal.copy(world));
  const rl = local.length();
  if (rl < 1e-3) return [];
  const dir = local.clone().divideScalar(rl);
  const face = faceOf(dir);
  const { u, v } = faceUV(face, dir);
  const ctx = Math.floor(u / uTile);
  const cty = Math.floor(v / uTile);
  const reach = Math.ceil(r / TILE_M) + 1;
  const out: FloraTreeRef[] = [];
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dy = -reach; dy <= reach; dy++) {
      const tx = ctx + dx;
      const ty = cty + dy;
      const sc = tileScatterOf(body, face, tx, ty);
      if (!sc) continue;
      const pls = sc.placements.get(FLORA_TREE_SPECIES) ?? [];
      for (let i = 0; i < pls.length; i++) {
        const pl = pls[i]!;
        const p = new THREE.Vector3(pl.x, pl.y, pl.z)
          .applyQuaternion(sc.quat)
          .addScaledVector(sc.dir, R + sc.h0);
        body.group.localToWorld(p);
        if (p.distanceTo(world) <= r) out.push({ key: `${face}:${tx}:${ty}:${i}`, world: p });
      }
    }
  }
  return out;
}

// ── Per-tile state ──────────────────────────────────────────────────────────
/** Which representation a tile is drawing. Ordered far → near. */
type FloraTier = "billboard" | "stick" | "real";

interface Tile {
  /** Tile address (`face:tx:ty`) — prefix of its instances' twin keys. */
  key: string;
  group: THREE.Group;
  /** Tile centre in BODY-LOCAL coords (distance tests). */
  center: THREE.Vector3;
  placements: Map<string, Placement[]>;
  billboards: THREE.InstancedMesh[];
  /** Built LAZILY on first entry into the rung and then KEPT — a tile crossing
   *  a band toggles `visible`, never rebuilds (an InstancedMesh rebuild per
   *  crossing is the churn the creature tiers learned about the hard way). */
  sticks: THREE.InstancedMesh[] | null;
  real: THREE.InstancedMesh[] | null;
  tier: FloraTier;
  /** The TREE meshes (every rung) — the suppression rewrite targets; geomH is
   *  each mesh's un-scaled geometry height. */
  oak: { mesh: THREE.InstancedMesh; geomH: number }[];
}

export interface FloraField {
  /** Stream tiles around `focusWorld` (the surface point under the player);
   *  tiles within STICK_R of `nearWorld` swap impostors for stick trees, and
   *  within NEAR_R for real geometry.
   *  `excludes` are TOWN HOLES (each town anchor at its own plan radius) —
   *  enforced LIVE, not just at build: a tile inside a hole is skipped on the
   *  way in AND disposed if it already stands. (Build-time-only exclusion was
   *  the trees-inside-the-city defect: tiles built during the descent blend —
   *  camera kilometres up, glide already on the surface — predate the town's
   *  hole and used to survive the whole visit.) */
  ensure(focusWorld: THREE.Vector3, nearWorld: THREE.Vector3 | null, excludes?: ReadonlyArray<{ world: THREE.Vector3; r: number }>): void;
  /** SUPPRESS individual tree instances (twin keys `face:tx:ty:i` from
   *  floraTreesNear). Declarative: pass the full current set; instances
   *  leaving it re-appear.
   *
   *  ⚖️ THE FIELD'S ONE PER-INSTANCE MASK, and the driver owns the reasons.
   *  It began as the twin suppression — the wilderness session stands a real
   *  gatherable entity there, so the scenery copy must not also draw — and it
   *  now carries the town's own near stand, the felled marks, and (#49
   *  Stage 3) the DEPLETION thinning: a neighbouring stand whose record has
   *  been logged stands fewer trees. Deliberately ONE set rather than one per
   *  reason: a tree either draws or it does not, and the set is a union
   *  assembled at a single seat (`syncFloraTwins`) so no authority can
   *  un-hide another's trees. A tile streaming in later reads the CURRENT
   *  set at build time, so it builds already-thinned. */
  setTwinHidden(hidden: ReadonlySet<string>): void;
  dispose(): void;
}

export function createFloraField(renderer: THREE.WebGLRenderer, body: CelestialBody): FloraField | null {
  const geo = body.geography;
  if (!geo || !body.walkable) return null;
  const R = body.radius;
  const uTile = TILE_M / R; // face-plane tile step (exact at face centre)
  const tiles = new Map<string, Tile>();
  const _local = new THREE.Vector3();
  const _near = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  /** Session-twinned instances (`face:tx:ty:i`) drawn at zero scale — the
   *  wilderness session stands the real entity there (setTwinHidden). */
  let twinHidden: ReadonlySet<string> = new Set();

  /** Write a mesh's instance matrices; `hiddenAt` scales an instance to ~0. */
  const writeMatrices = (
    mesh: THREE.InstancedMesh,
    placements: Placement[],
    geomHeightM: number,
    targetH: number,
    hiddenAt?: (i: number) => boolean,
  ): void => {
    for (let i = 0; i < placements.length; i++) {
      const pl = placements[i]!;
      const s = hiddenAt?.(i) ? 1e-6 : (targetH / geomHeightM) * pl.v;
      _q.setFromAxisAngle(UP, pl.yaw);
      _m.compose(_p.set(pl.x, pl.y, pl.z), _q, _s.set(s, s, s));
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  };

  /** Instance a species' placements with either representation's sizing. */
  const buildMesh = (
    placements: Placement[],
    geomHeightM: number,
    targetH: number,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    hiddenAt?: (i: number) => boolean,
  ): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
    writeMatrices(mesh, placements, geomHeightM, targetH, hiddenAt);
    // Instances spread across the tile — the geometry's own bounding sphere
    // would cull them wrongly.
    mesh.frustumCulled = false;
    return mesh;
  };

  /** The tile's tree-hiding mask — reads the CURRENT twin set at write time. */
  const oakHiddenAt = (tileKey: string) => (i: number): boolean => twinHidden.has(`${tileKey}:${i}`);

  const buildTile = (face: number, tx: number, ty: number, key: string): void => {
    // The shared scatter authority — the exact placements a session twin
    // derives from (floraTreesNear), so suppression keys line up 1:1.
    const sc = tileScatterOf(body, face, tx, ty);
    if (!sc) {
      // Open water — an empty tile entry so we don't re-test every pass.
      const dir = dirOfUV(face, (tx + 0.5) * uTile, (ty + 0.5) * uTile, _dir).clone();
      tiles.set(key, { key, group: new THREE.Group(), center: dir.multiplyScalar(R), placements: new Map(), billboards: [], sticks: null, real: null, tier: "billboard", oak: [] });
      return;
    }
    const group = new THREE.Group();
    group.name = `flora:${key}`;
    group.position.copy(sc.dir).multiplyScalar(R + sc.h0);
    group.quaternion.copy(sc.quat);
    body.group.add(group);
    group.updateWorldMatrix(true, false);

    const tile: Tile = {
      key, group, center: sc.dir.clone().multiplyScalar(R + sc.h0),
      placements: sc.placements, billboards: [], sticks: null, real: null, tier: "billboard", oak: [],
    };
    for (const [species, pls] of sc.placements) {
      if (!pls.length) continue;
      const a = speciesAssets(renderer, species);
      const isTree = species === FLORA_TREE_SPECIES;
      // Trees at NATIVE model size (targetH = the geometry's own height ⇒
      // scale is the per-placement variation alone); grass at its display
      // height — see the constants note.
      const mesh = buildMesh(
        pls, a.impostor.heightM, isTree ? a.impostor.heightM : GRASS_H, a.billboardGeom, a.billboardMat,
        isTree ? oakHiddenAt(key) : undefined,
      );
      mesh.name = `flora-${species}`; // gaze-pick filter (trees cast, grass doesn't)
      group.add(mesh);
      tile.billboards.push(mesh);
      if (isTree) tile.oak.push({ mesh, geomH: a.impostor.heightM });
    }
    tiles.set(key, tile);
  };

  /** Build one rung's instanced meshes for a tile. The stick and real rungs
   *  share the plant's own bounds, so both stand at the model's native height
   *  and a rung swap never changes a tree's size. */
  const buildRung = (tile: Tile, tier: "stick" | "real"): THREE.InstancedMesh[] => {
    const out: THREE.InstancedMesh[] = [];
    for (const [species, pls] of tile.placements) {
      if (!pls.length) continue;
      const a = speciesAssets(renderer, species);
      const isTree = species === FLORA_TREE_SPECIES;
      const mesh = buildMesh(
        pls, a.realHeightM, isTree ? a.realHeightM : GRASS_H,
        tier === "stick" ? a.stickGeom : a.realGeom,
        tier === "stick" ? a.stickMat : a.realMat,
        isTree ? oakHiddenAt(tile.key) : undefined,
      );
      mesh.name = `flora-${species}`; // gaze-pick filter (trees cast, grass doesn't)
      tile.group.add(mesh);
      out.push(mesh);
      if (isTree) tile.oak.push({ mesh, geomH: a.realHeightM });
    }
    return out;
  };

  const setTier = (tile: Tile, tier: FloraTier): void => {
    if (tile.tier === tier) return;
    tile.tier = tier;
    if (tier === "stick" && !tile.sticks) tile.sticks = buildRung(tile, "stick");
    if (tier === "real" && !tile.real) tile.real = buildRung(tile, "real");
    for (const m of tile.billboards) m.visible = tier === "billboard";
    if (tile.sticks) for (const m of tile.sticks) m.visible = tier === "stick";
    if (tile.real) for (const m of tile.real) m.visible = tier === "real";
  };

  const disposeTile = (tile: Tile, key: string): void => {
    for (const m of tile.billboards) { tile.group.remove(m); m.dispose(); }
    if (tile.sticks) for (const m of tile.sticks) { tile.group.remove(m); m.dispose(); }
    if (tile.real) for (const m of tile.real) { tile.group.remove(m); m.dispose(); }
    tile.group.removeFromParent();
    tiles.delete(key);
  };

  return {
    ensure(focusWorld, nearWorld, excludes) {
      // Everything in BODY-LOCAL coordinates (the planet moves and spins).
      body.group.worldToLocal(_local.copy(focusWorld));
      const rf = _local.length();
      if (rf < 1e-3) return;
      const focusLocal = _local;
      const nearLocal = nearWorld ? body.group.worldToLocal(_near.copy(nearWorld)) : null;
      // Town holes in body-local coords. The half-diagonal margin makes the
      // TILE-CENTRE test honest: a tile whose centre clears the hole can still
      // scatter trees ~141 m past it, straight into the streets.
      const holes = excludes && excludes.length
        ? excludes.map(ex => ({
            p: body.group.worldToLocal(new THREE.Vector3().copy(ex.world)),
            r: ex.r + TILE_M * 0.71,
          }))
        : null;
      const inHole = (p: THREE.Vector3): boolean =>
        holes !== null && holes.some(h => p.distanceTo(h.p) < h.r);

      _dir.copy(focusLocal).divideScalar(rf);
      const face = faceOf(_dir);
      const { u, v } = faceUV(face, _dir);
      const ctx = Math.floor(u / uTile);
      const cty = Math.floor(v / uTile);
      const reach = Math.ceil(LOAD_R / TILE_M) + 1;

      // Stream in (budgeted): nearest rings first.
      let budget = BUILD_BUDGET;
      outer:
      for (let ring = 0; ring <= reach; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            const tx = ctx + dx;
            const ty = cty + dy;
            const key = `${face}:${tx}:${ty}`;
            if (tiles.has(key)) continue;
            dirOfUV(face, (tx + 0.5) * uTile, (ty + 0.5) * uTile, _dir);
            _p.copy(_dir).multiplyScalar(rf);
            if (_p.distanceTo(focusLocal) > LOAD_R) continue;
            if (inHole(_p)) continue;
            buildTile(face, tx, ty, key);
            if (--budget <= 0) break outer;
          }
        }
      }

      // Near-resolve + stream out. A hole is grounds for disposal exactly like
      // distance — the exclusion is live, never a build-time latch.
      // Rung BUILDS are budgeted (RUNG_BUILD_BUDGET) and spent NEAREST-FIRST:
      // map-order spending let a tile beside the player upgrade seconds late
      // while far tiles ate the budget — a tree "spontaneously appearing" in
      // the near field as its impostor finally resolved (round-2 border
      // report). Nearest-first makes late upgrades a far-field-only event,
      // where an impostor→stick swap is sub-pixel. Visibility flips between
      // already-built rungs stay free and immediate.
      let rungBudget = RUNG_BUILD_BUDGET;
      const pending: Array<{ tile: Tile; want: FloraTier; dNear: number }> = [];
      for (const [key, tile] of tiles) {
        const d = tile.center.distanceTo(focusLocal);
        if (d > UNLOAD_R || inHole(tile.center)) { disposeTile(tile, key); continue; }
        const dNear = nearLocal ? tile.center.distanceTo(nearLocal) : Infinity;
        const want: FloraTier = dNear < NEAR_R ? "real" : dNear < STICK_R ? "stick" : "billboard";
        const needsBuild =
          (want === "stick" && !tile.sticks) || (want === "real" && !tile.real);
        if (needsBuild) pending.push({ tile, want, dNear });
        else setTier(tile, want);
      }
      pending.sort((a, b) => a.dNear - b.dNear);
      for (const p of pending) {
        if (rungBudget-- <= 0) break; // the rest keep their current rung
        setTier(p.tile, p.want);
      }
    },
    setTwinHidden(hidden) {
      // Diff old vs new, group changed instance keys by TILE, rewrite only
      // the loaded tiles that actually changed (a matrix write per tree —
      // tiles hold ≤ dozens, this is nothing).
      const changedTiles = new Set<string>();
      const tileOf = (instKey: string): string => instKey.slice(0, instKey.lastIndexOf(":"));
      for (const k of twinHidden) if (!hidden.has(k)) changedTiles.add(tileOf(k));
      for (const k of hidden) if (!twinHidden.has(k)) changedTiles.add(tileOf(k));
      twinHidden = hidden;
      for (const tKey of changedTiles) {
        const tile = tiles.get(tKey);
        if (!tile || !tile.oak.length) continue;
        const pls = tile.placements.get(FLORA_TREE_SPECIES) ?? [];
        // targetH = geomH: trees render at native model size (scale = v).
        for (const o of tile.oak) writeMatrices(o.mesh, pls, o.geomH, o.geomH, oakHiddenAt(tKey));
      }
    },
    dispose() {
      for (const [key, tile] of tiles) disposeTile(tile, key);
    },
  };
}
