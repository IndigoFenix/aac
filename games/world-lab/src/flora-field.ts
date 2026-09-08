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
import { growthAgeOf, standGrowthClass } from "@shared/world-engine/products";
import { floraTwinFeatureId } from "@shared/world-engine/interaction/quest/wilderness";
import { speciesBlueprint } from "@shared/world-engine/creatures/species";
import { agePlantBody, growthHeightFactor } from "@shared/world-engine/creatures/growth";
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

/**
 * ⚖️ ONE STAGE'S GEOMETRY — a species' body built at ONE rung of its growth
 * ladder (`agePlantBody`, the ONE age→body map; `growthAgeOf`, the ONE
 * class→age map — neither is forked here). Cached for the session beside the
 * adult's, keyed `<species>|<class>`, so a stand's understory costs one extra
 * geometry build per rung the field actually shows and nothing per instance.
 *
 * 🚫 NO EXTRA IMPOSTOR BAKE. The billboard rung keeps the ADULT's baked card
 * and scales it by the stage's own height factor: past `STICK_R` (700 m) a
 * juvenile oak is a couple of pixels tall, and a bake per stage would treble
 * the one GPU cost this field pays up front for a difference nobody can see.
 * The SHAPE — the thing the user asked for, a shoot that branches out — lands
 * the moment the tile resolves to the stick rung, which is where shape starts
 * to read at all. That is a LOD decision, not a second age authority: the age
 * is the same per-placement number at every rung, only the representation of
 * it changes.
 */
interface StageAssets {
  realGeom: THREE.BufferGeometry;
  realMat: THREE.Material;
  realHeightM: number;
  stickGeom: THREE.BufferGeometry;
  stickMat: THREE.Material;
}
const stageCache = new Map<string, StageAssets>();

/** The stage's drawn height as a fraction of the adult's — `growthHeightFactor`,
 *  the ONE height curve (PART 1: *"It is exported; don't re-derive"*). 1 at the
 *  mature rung, so an adult's matrices are byte-identical to before. */
function stageHeightRatio(species: string, cls: number | undefined): number {
  if (cls === undefined) return 1;
  return growthHeightFactor(growthAgeOf(species, cls));
}

function stageAssets(
  renderer: THREE.WebGLRenderer, species: string, cls: number | undefined,
): StageAssets {
  const adult = speciesAssets(renderer, species);
  if (cls === undefined) return adult; // the mature rung IS the adult's assets
  const key = `${species}|${cls}`;
  let a = stageCache.get(key);
  if (!a) {
    const lods = buildPlantLods(agePlantBody(speciesBlueprint(species), growthAgeOf(species, cls)));
    lods.lod0.geometry.dispose(); // same as the adult's: the field never draws LOD0
    a = {
      realGeom: lods.lod1.geometry,
      realMat: adult.realMat,   // one material per species — the stage is GEOMETRY
      realHeightM: Math.max(0.1, lods.bounds.max.y - lods.bounds.min.y),
      stickGeom: lods.stick.geometry,
      stickMat: adult.stickMat,
    };
    stageCache.set(key, a);
  }
  return a;
}

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
interface Placement {
  x: number; z: number; y: number; yaw: number; v: number;
  /**
   * ⚖️ THE GROWTH RUNG THIS TREE STANDS AT — `undefined` = MATURE, the
   * wilderness's own scatter law read into the picture (products.ts
   * `standGrowthClass`). Drawn from a HASH of the instance's own feature id,
   * never from the tile rng: the scatter's draw sequence is untouched, so
   * every placement is at the exact coordinate it has always been at, and the
   * twin the wilderness materialises from this instance (`floraTwinFeatureId`
   * — the same string, hashed the same way) stands at the same rung.
   */
  cls?: number;
}
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
    // ⚖️ THE AGE STRUCTURE IS STAMPED AFTER THE SCATTER, on the OUTPUT index —
    // which is the index the instance key (`face:tx:ty:i`) is built from, and
    // it is NOT the draw index (a placement over water is dropped while its
    // draws are still consumed). Getting that wrong would hand the twin a
    // different rung than the field draws.
    const aged = (species: string, pls: Placement[]): Placement[] => {
      for (let i = 0; i < pls.length; i++) {
        const cls = standGrowthClass(species, floraTwinFeatureId(species, `${face}:${tx}:${ty}:${i}`));
        if (cls !== undefined) pls[i]!.cls = cls;
      }
      return pls;
    };
    placements.set("oak", aged("oak", scatter(eco ? standCountFor("oak", eco, TILE_HA) : OAK_COUNT[biome]!)));
    placements.set("grass", aged("grass", scatter(eco ? standCountFor("grass", eco, TILE_HA) : GRASS_COUNT[biome]!)));
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
export type FloraTier = "billboard" | "stick" | "real";

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
  /** The TREE meshes (every rung) — the suppression rewrite targets. */
  oak: OakMesh[];
}

/**
 * One instanced TREE mesh and how to write its matrices back.
 *
 * `idx` is the STAGE BUCKET: the global placement indices this mesh draws, in
 * order, or `null` for "every placement in order" (the billboard rung, which
 * is one card for the whole tile). It exists because the instance key —
 * `face:tx:ty:<global index>` — is the address every other authority in the
 * driver suppresses through, so a bucketed mesh must be able to say which
 * global tree each of its instances is.
 */
interface OakMesh {
  mesh: THREE.InstancedMesh;
  geomH: number;
  targetH: number;
  idx: number[] | null;
  /** TRUE on the billboard rung only: the adult card, scaled per instance by
   *  the stage's own height factor (`stageHeightRatio`). The stick/real rungs
   *  carry the STAGE'S geometry, which is already the right size. */
  ageScaled: boolean;
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
  /** ⚖️ STAGE OVERRIDES (instance key → growth class), the companion of the
   *  mask above and declarative in exactly the same way: pass the full current
   *  map, and an instance leaving it goes back to the rung the SCATTER gives
   *  it. It is separate from the mask because it answers a different question
   *  — the mask says whether a tree draws, this says WHAT it draws as — and a
   *  tree can be staged and hidden at once (a felled twin's sapling standing
   *  under the town's own stand). Today's one writer is the felled mark: the
   *  tree you cut regrows through its rungs in the picture instead of hiding
   *  for the whole growth span. */
  setTwinStages(staged: ReadonlyMap<string, number>): void;
  /** 🐞 DEBUG-ONLY (`__flora.audit` in world-lab): every TREE instance the
   *  field currently holds within `r` of a world point, with the rung its TILE
   *  is drawing and whether the finer rungs are warmed. Pure read — it
   *  materialises nothing, hides nothing and touches no matrices; the tier is
   *  reported, never decided here. Cheap enough for a ~5 Hz overlay (a walk of
   *  the loaded tiles' placement arrays), never called on the sim path. */
  debugTrees(nearWorld: THREE.Vector3, r: number): FloraTreeDebug[];
  dispose(): void;
}

/** 🐞 One row of `FloraField.debugTrees` — what the FIELD is doing with one
 *  streamed instance right now. `tier` is the TILE's rung (the field bands per
 *  TILE, not per instance — a 200 m tile against a 260 m NEAR_R is why two
 *  trees at the same camera distance can draw at different rungs);
 *  `stickWarm`/`realWarm` say whether that rung's InstancedMesh has been built
 *  yet, so a tile still on billboards because RUNG_BUILD_BUDGET has not reached
 *  it is distinguishable from one that is correctly far. */
export interface FloraTreeDebug {
  /** Instance key `face:tx:ty:i` — the twin/suppression address. */
  key: string;
  /** Tile address `face:tx:ty`. */
  tile: string;
  world: THREE.Vector3;
  tier: FloraTier;
  stickWarm: boolean;
  realWarm: boolean;
  /** In the one per-instance mask (a twin/town stand/felled mark/depletion
   *  stands here) ⇒ drawn at scale 1e-6, i.e. not drawn at all. */
  hidden: boolean;
  /** The per-placement scale jitter (0.85–1.35). */
  v: number;
  /** The growth rung it is DRAWING at — `undefined` = mature. The scatter's
   *  own (`standGrowthClass`) unless the driver has staged it (a felled tree
   *  regrowing). */
  cls?: number;
  /** …and that rung's height as a fraction of the adult's (1 at mature). */
  ageScale: number;
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

  /** Per-instance STAGE OVERRIDE (`setTwinStages`) — instance key → the growth
   *  class the driver says that tree stands at right now, which outranks the
   *  scatter's own for as long as it is set. Today's one writer is the felled
   *  mark: a tree that was cut regrows through its rungs in the picture. */
  let twinStaged: ReadonlyMap<string, number> = new Map();

  /** Write a mesh's instance matrices; `hiddenAt` scales an instance to ~0.
   *  `idx` maps this mesh's instance j to a GLOBAL placement index (null =
   *  identity); `extraAt` is the billboard rung's per-stage height factor. */
  const writeMatrices = (
    mesh: THREE.InstancedMesh,
    placements: Placement[],
    geomHeightM: number,
    targetH: number,
    opts?: {
      idx?: number[] | null;
      hiddenAt?: (gi: number) => boolean;
      extraAt?: (gi: number) => number;
    },
  ): void => {
    const idx = opts?.idx ?? null;
    const n = idx ? idx.length : placements.length;
    for (let j = 0; j < n; j++) {
      const gi = idx ? idx[j]! : j;
      const pl = placements[gi]!;
      const s = opts?.hiddenAt?.(gi)
        ? 1e-6
        : (targetH / geomHeightM) * pl.v * (opts?.extraAt?.(gi) ?? 1);
      _q.setFromAxisAngle(UP, pl.yaw);
      _m.compose(_p.set(pl.x, pl.y, pl.z), _q, _s.set(s, s, s));
      mesh.setMatrixAt(j, _m);
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
    opts?: {
      idx?: number[] | null;
      hiddenAt?: (gi: number) => boolean;
      extraAt?: (gi: number) => number;
    },
  ): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(
      geometry, material, opts?.idx ? opts.idx.length : placements.length,
    );
    writeMatrices(mesh, placements, geomHeightM, targetH, opts);
    // Instances spread across the tile — the geometry's own bounding sphere
    // would cull them wrongly.
    mesh.frustumCulled = false;
    return mesh;
  };

  /** The tile's tree-hiding mask — reads the CURRENT twin set at write time. */
  const oakHiddenAt = (tileKey: string) => (gi: number): boolean => twinHidden.has(`${tileKey}:${gi}`);

  /** ⚖️ THE RUNG ONE INSTANCE ACTUALLY DRAWS AT: the driver's override if it
   *  has one, else the scatter's own (`Placement.cls`). ONE answer, asked by
   *  the bucket partition and by the billboard's height factor alike. */
  const clsAt = (tileKey: string, pls: Placement[], gi: number): number | undefined =>
    twinStaged.get(`${tileKey}:${gi}`) ?? pls[gi]?.cls;

  const oakAgeAt = (tileKey: string, pls: Placement[]) => (gi: number): number =>
    stageHeightRatio(FLORA_TREE_SPECIES, clsAt(tileKey, pls, gi));

  /** Partition a tile's tree placements into STAGE BUCKETS (mature first —
   *  `undefined` sorts to the front so the common case is bucket 0 and a
   *  ladder-less world produces exactly one bucket, as it always did). */
  const stageBuckets = (tileKey: string, pls: Placement[]): Array<{ cls?: number; idx: number[] }> => {
    const by = new Map<number, number[]>();
    for (let gi = 0; gi < pls.length; gi++) {
      const c = clsAt(tileKey, pls, gi);
      const k = c ?? -1;
      const list = by.get(k);
      if (list) list.push(gi);
      else by.set(k, [gi]);
    }
    return [...by.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([k, idx]) => (k < 0 ? { idx } : { cls: k, idx }));
  };

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
    buildBillboards(tile, sc.placements);
    tiles.set(key, tile);
  };

  /** The FAR rung: one card per species over the whole tile. Trees at NATIVE
   *  model size (targetH = the geometry's own height ⇒ scale is the
   *  per-placement variation), times the STAGE's height factor; grass at its
   *  display height — see the constants note. */
  const buildBillboards = (tile: Tile, placements: Map<string, Placement[]>): void => {
    for (const [species, pls] of placements) {
      if (!pls.length) continue;
      const a = speciesAssets(renderer, species);
      const isTree = species === FLORA_TREE_SPECIES;
      const mesh = buildMesh(
        pls, a.impostor.heightM, isTree ? a.impostor.heightM : GRASS_H, a.billboardGeom, a.billboardMat,
        isTree ? { hiddenAt: oakHiddenAt(tile.key), extraAt: oakAgeAt(tile.key, pls) } : undefined,
      );
      mesh.name = `flora-${species}`; // gaze-pick filter (trees cast, grass doesn't)
      tile.group.add(mesh);
      tile.billboards.push(mesh);
      if (isTree) {
        tile.oak.push({
          mesh, geomH: a.impostor.heightM, targetH: a.impostor.heightM, idx: null, ageScaled: true,
        });
      }
    }
  };

  /** Build one rung's instanced meshes for a tile. The stick and real rungs
   *  share the plant's own bounds, so both stand at the model's native height
   *  and a rung swap never changes a tree's size.
   *
   *  ⚖️ …AND THE TREE SPECIES BUILDS ONE MESH PER STAGE BUCKET. A rung is where
   *  SHAPE starts to read, so a sapling here is the sapling's own geometry
   *  (`stageAssets` → `agePlantBody`) rather than a shrunken adult — the user's
   *  whole ask ("they should grow in the manner of real plants"). A stand with
   *  no juveniles produces exactly one bucket and exactly one mesh, i.e. what
   *  this function has always built. */
  const buildRung = (tile: Tile, tier: "stick" | "real"): THREE.InstancedMesh[] => {
    const out: THREE.InstancedMesh[] = [];
    for (const [species, pls] of tile.placements) {
      if (!pls.length) continue;
      const isTree = species === FLORA_TREE_SPECIES;
      const buckets: Array<{ cls?: number; idx: number[] | null }> =
        isTree ? stageBuckets(tile.key, pls) : [{ idx: null }];
      for (const b of buckets) {
        const a = stageAssets(renderer, species, b.cls);
        const mesh = buildMesh(
          pls, a.realHeightM, isTree ? a.realHeightM : GRASS_H,
          tier === "stick" ? a.stickGeom : a.realGeom,
          tier === "stick" ? a.stickMat : a.realMat,
          isTree ? { idx: b.idx, hiddenAt: oakHiddenAt(tile.key) } : undefined,
        );
        mesh.name = `flora-${species}`; // gaze-pick filter (trees cast, grass doesn't)
        tile.group.add(mesh);
        out.push(mesh);
        if (isTree) {
          tile.oak.push({
            mesh, geomH: a.realHeightM, targetH: a.realHeightM, idx: b.idx ?? null, ageScaled: false,
          });
        }
      }
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

  /** Repaint one tile's tree matrices in place (mask + stage height factor) —
   *  no allocation, no rebuild. */
  const rewriteTreeMatrices = (tKey: string): void => {
    const tile = tiles.get(tKey);
    if (!tile || !tile.oak.length) return;
    const pls = tile.placements.get(FLORA_TREE_SPECIES) ?? [];
    for (const o of tile.oak) {
      writeMatrices(o.mesh, pls, o.geomH, o.targetH, {
        idx: o.idx,
        hiddenAt: oakHiddenAt(tKey),
        ...(o.ageScaled ? { extraAt: oakAgeAt(tKey, pls) } : {}),
      });
    }
  };

  /** Re-partition and rebuild ONE warmed rung's tree meshes after a stage
   *  override moved an instance between buckets. The billboard rung and the
   *  other geometry rung are left exactly as they are. */
  const rebuildRungTrees = (tile: Tile, tier: "stick" | "real"): THREE.InstancedMesh[] => {
    const old = tier === "stick" ? tile.sticks : tile.real;
    const keep: THREE.InstancedMesh[] = [];
    const drop = new Set<THREE.InstancedMesh>();
    for (const m of old ?? []) {
      if (m.name === `flora-${FLORA_TREE_SPECIES}`) { drop.add(m); tile.group.remove(m); m.dispose(); }
      else keep.push(m);
    }
    tile.oak = tile.oak.filter((o) => !drop.has(o.mesh));
    const pls = tile.placements.get(FLORA_TREE_SPECIES) ?? [];
    const out = [...keep];
    if (pls.length) {
      for (const b of stageBuckets(tile.key, pls)) {
        const a = stageAssets(renderer, FLORA_TREE_SPECIES, b.cls);
        const mesh = buildMesh(
          pls, a.realHeightM, a.realHeightM,
          tier === "stick" ? a.stickGeom : a.realGeom,
          tier === "stick" ? a.stickMat : a.realMat,
          { idx: b.idx, hiddenAt: oakHiddenAt(tile.key) },
        );
        mesh.name = `flora-${FLORA_TREE_SPECIES}`;
        mesh.visible = tile.tier === tier;
        tile.group.add(mesh);
        out.push(mesh);
        tile.oak.push({ mesh, geomH: a.realHeightM, targetH: a.realHeightM, idx: b.idx, ageScaled: false });
      }
    }
    return out;
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
      for (const tKey of changedTiles) rewriteTreeMatrices(tKey);
    },
    setTwinStages(staged) {
      // Same declarative shape as `setTwinHidden`, and the same diff: an
      // instance whose rung moved (a felled tree climbing back through its
      // classes) repaints, everything else is untouched.
      const changedTiles = new Set<string>();
      const tileOf = (instKey: string): string => instKey.slice(0, instKey.lastIndexOf(":"));
      for (const [k, v] of twinStaged) if (staged.get(k) !== v) changedTiles.add(tileOf(k));
      for (const [k, v] of staged) if (twinStaged.get(k) !== v) changedTiles.add(tileOf(k));
      twinStaged = staged;
      for (const tKey of changedTiles) {
        const tile = tiles.get(tKey);
        if (!tile || !tile.oak.length) continue;
        // The BILLBOARD rung is one card whose per-instance height factor
        // moved — a matrix rewrite. The geometry rungs carry the stage IN the
        // mesh, so their buckets have to be re-partitioned and rebuilt; that
        // happens at most once per tree per growth-class period, and only for
        // the handful of tiles inside `STICK_R` that have warmed a rung.
        rewriteTreeMatrices(tKey);
        if (tile.sticks) tile.sticks = rebuildRungTrees(tile, "stick");
        if (tile.real) tile.real = rebuildRungTrees(tile, "real");
      }
    },
    debugTrees(nearWorld, r) {
      const out: FloraTreeDebug[] = [];
      const w = new THREE.Vector3();
      for (const [tKey, tile] of tiles) {
        const pls = tile.placements.get(FLORA_TREE_SPECIES);
        if (!pls || !pls.length) continue;
        tile.group.updateWorldMatrix(true, false);
        for (let i = 0; i < pls.length; i++) {
          const pl = pls[i]!;
          w.set(pl.x, pl.y, pl.z).applyMatrix4(tile.group.matrixWorld);
          if (w.distanceTo(nearWorld) > r) continue;
          const key = `${tKey}:${i}`;
          const cls = clsAt(tKey, pls, i);
          out.push({
            key, tile: tKey, world: w.clone(), tier: tile.tier,
            stickWarm: tile.sticks !== null, realWarm: tile.real !== null,
            hidden: twinHidden.has(key), v: pl.v,
            ...(cls === undefined ? {} : { cls }),
            ageScale: stageHeightRatio(FLORA_TREE_SPECIES, cls),
          });
        }
      }
      return out;
    },
    dispose() {
      for (const [key, tile] of tiles) disposeTile(tile, key);
    },
  };
}
