// shared/world-engine/creatures/creature-model.ts
//
// The RUNTIME bridge between the creature builder (pure body-plan geometry) and a
// live THREE scene. It offers the two-tier animation strategy the world needs:
//
//   • DYNAMIC  — a live CreatureAnimator drives buildSkeleton + buildCreatureMesh
//     EVERY frame, so gait, reach/pick-up feedback and mouth gape re-loft at full
//     fidelity. Expensive (a full mesh rebuild per frame). Reserved for the player
//     avatar and creatures right next to them.
//
//   • PRELOADED — an animation clip is BAKED ONCE per species into a handful of
//     posed geometry snapshots; at runtime an instance just swaps its shared
//     BufferGeometry by a loop clock. Effectively free per frame, and faithful
//     (the snapshots come from the same builder). This is what every distant
//     creature and every town resident uses.
//
// Baked geometries + the material are SHARED, cached per (species, look) in
// SpeciesAssets — a hundred town humans cost one bake and one material, differing
// only by their draw call and animation phase.
//
// Graphics-touching (THREE, SkinnedMesh) — like render3d.ts this is deliberately
// NOT re-exported from world-engine/index.ts, so the headless server never loads
// it. The pure body-plan data (species.ts, blueprint.ts) is safe to import
// anywhere.

import * as THREE from "three";
import type { Blueprint } from "./blueprint";
import { clampBlueprint } from "./blueprint";
import { buildSkeleton, type CreatureSkeleton } from "./skeleton";
import { buildCreatureMesh, type BuiltCreature } from "./mesh";
import { CreatureAnimator } from "./animation";
import type { GaitPattern } from "./gait";
import { requireSpecies, type Species } from "./species";
// Type-only — no runtime coupling to the (DOM/GL-heavy) renderer.
import type { AvatarFrame, AvatarModel, AvatarModelFactory } from "../render3d";

/** Visual options shared by every creature model. */
export interface CreatureLook {
  /** Cel/toon shading (the candidate game default look). */
  toon?: boolean;
}

/** Common creature-model interface: a positioned Object3D + a per-frame update. */
export interface CreatureModel {
  readonly object: THREE.Object3D;
  /** Advance the model. `speed01` 0..1 drives locomotion (0 = idle); `yaw`
   *  (radians) faces the body; `pattern` picks the footfall pattern. */
  update(dt: number, opts?: CreatureDriveOptions): void;
  dispose(): void;
}

export interface CreatureDriveOptions {
  /** 0 = stand, ~0.3 = walk, 1 = full run. */
  speed01?: number;
  /** Body heading in radians (about +Y). */
  yaw?: number;
  /** Footfall pattern (dynamic model only; baked bakes one). */
  pattern?: GaitPattern;
}

// A human runs ~3.5 m/s at full tilt — map a world speed to the 0..1 dial.
const RUN_SPEED_MPS = 3.5;

// ---------------------------------------------------------------------------
// Baked (preloaded) clips
// ---------------------------------------------------------------------------

interface BakedFrame {
  /** Even loop position 0..1 this snapshot represents. */
  phase: number;
  /** Posed geometry (skin attributes stripped) — SHARED across instances. */
  geometry: THREE.BufferGeometry;
}

interface BakedClip {
  name: string;
  frames: BakedFrame[];
  /** Wall-clock seconds for one loop. */
  loopSeconds: number;
  loops: boolean;
}

/** Per-species shared assets: one material + baked clips + the rest height.
 *  Cached by (speciesId, look); reused by every instance of the species. */
export interface SpeciesAssets {
  species: Species;
  material: THREE.Material;
  clips: Map<string, BakedClip>;
  /** Natural standing height (meters) from the rest skeleton's bone AABB. */
  naturalHeight: number;
  dispose(): void;
}

/** Does this body plan have legs to walk on (vs. a plant/fruit/limbless kind)? */
function canWalk(bp: Blueprint): boolean {
  return bp.limbGroups.some((l) => l.membrane < 0.55 && l.count > 0);
}

/** Build a posed geometry snapshot from a skeleton, harvesting the builder's
 *  material into `matRef` on first call (so every snapshot shares one material)
 *  and stripping the skin attributes (a baked frame is a plain, static Mesh). */
function snapshot(
  skel: CreatureSkeleton,
  bp: Blueprint,
  toon: boolean,
  matRef: { mat?: THREE.Material },
): THREE.BufferGeometry {
  const built = buildCreatureMesh(skel, bp, { toon });
  const geom = built.mesh.geometry;
  geom.deleteAttribute("skinIndex");
  geom.deleteAttribute("skinWeight");
  const mat = built.mesh.material as THREE.Material;
  if (!matRef.mat) matRef.mat = mat;
  else mat.dispose(); // reuse the first; the skeleton/bones are plain objects (GC'd)
  return geom;
}

/** Bake a locomotion clip: `frames` posed snapshots spanning one gait cycle. The
 *  animator is warmed to steady state, its cadence measured, then sampled evenly.
 *  Terminating by construction (fixed sample count, no phase-wrap hunting). */
function bakeLocomotion(
  bp: Blueprint,
  frameCount: number,
  speed01: number,
  pattern: GaitPattern,
  toon: boolean,
  matRef: { mat?: THREE.Material },
): BakedClip {
  const animator = new CreatureAnimator(bp);
  animator.setSpeed(speed01);
  animator.pattern = pattern;
  const dt = 1 / 60;
  const step = (): { phase: number; skel: CreatureSkeleton } => {
    const f = animator.update(dt);
    bp.posture.bodyPitch = f.posture.bodyPitch;
    bp.posture.bodyHeight = f.posture.bodyHeight;
    const skel = buildSkeleton(bp, f.gait, f.pose);
    animator.observe(skel);
    return { phase: f.gait?.phase ?? 0, skel };
  };
  // Warm up (~2 s) so the eased speed dial and gait reach steady state.
  for (let i = 0; i < 120; i++) step();
  // Estimate cadence from one step's phase advance.
  const p0 = step().phase;
  const p1 = step().phase;
  let dPhase = p1 - p0;
  if (dPhase <= 0) dPhase += 1;
  const cycleSteps = Math.max(frameCount, Math.round(1 / Math.max(dPhase, 1e-3)));
  const stride = Math.max(1, Math.floor(cycleSteps / frameCount));
  const frames: BakedFrame[] = [];
  for (let i = 0; i < frameCount; i++) {
    let last = step();
    for (let s = 1; s < stride; s++) last = step();
    frames.push({ phase: i / frameCount, geometry: snapshot(last.skel, bp, toon, matRef) });
  }
  return { name: "walk", frames, loopSeconds: frameCount * stride * dt, loops: true };
}

/** Bake the static rest pose as a one-frame clip (idle / plants / fruit). */
function bakeIdle(bp: Blueprint, toon: boolean, matRef: { mat?: THREE.Material }): BakedClip {
  const skel = buildSkeleton(bp);
  return { name: "idle", frames: [{ phase: 0, geometry: snapshot(skel, bp, toon, matRef) }], loopSeconds: 1, loops: false };
}

const WALK_FRAMES = 14;
const WALK_SPEED01 = 0.42;

function buildSpeciesAssets(species: Species, look: CreatureLook): SpeciesAssets {
  const toon = !!look.toon;
  const matRef: { mat?: THREE.Material } = {};
  const clips = new Map<string, BakedClip>();
  // Rest height from the bone AABB (feet ~0).
  const restSkel = buildSkeleton(clampBlueprint(species.blueprint));
  const naturalHeight = Math.max(0.1, restSkel.bounds.max.y - restSkel.bounds.min.y);

  clips.set("idle", bakeIdle(clampBlueprint(species.blueprint), toon, matRef));
  if (species.kind === "creature" && canWalk(clampBlueprint(species.blueprint))) {
    clips.set("walk", bakeLocomotion(clampBlueprint(species.blueprint), WALK_FRAMES, WALK_SPEED01, "trot", toon, matRef));
  }

  const material = matRef.mat!;
  return {
    species,
    material,
    clips,
    naturalHeight,
    dispose() {
      material.dispose();
      for (const clip of clips.values()) for (const f of clip.frames) f.geometry.dispose();
      clips.clear();
    },
  };
}

// Cache: one asset set per (speciesId, look). Games call getSpeciesAssets to
// warm this up front (preloading) so no bake happens mid-gameplay.
const ASSET_CACHE = new Map<string, SpeciesAssets>();

function assetKey(id: string, look: CreatureLook): string {
  return `${id}|${look.toon ? "toon" : "std"}`;
}

/** Get (building + caching on first call) the shared assets for a species. Call
 *  this at load time for every species a scene will use to PRELOAD the bakes. */
export function getSpeciesAssets(id: string, look: CreatureLook = {}): SpeciesAssets {
  const key = assetKey(id, look);
  let assets = ASSET_CACHE.get(key);
  if (!assets) {
    assets = buildSpeciesAssets(requireSpecies(id), look);
    ASSET_CACHE.set(key, assets);
  }
  return assets;
}

/** Drop a cached species' assets (frees GPU geometry + material). */
export function disposeSpeciesAssets(id: string, look: CreatureLook = {}): void {
  const key = assetKey(id, look);
  const assets = ASSET_CACHE.get(key);
  if (assets) {
    assets.dispose();
    ASSET_CACHE.delete(key);
  }
}

/** Uniform scale so the model stands `heightM` tall (falls back to species.scale
 *  or 1). */
function resolveScale(assets: SpeciesAssets, opts?: { scale?: number; heightM?: number }): number {
  if (opts?.scale !== undefined) return opts.scale;
  if (opts?.heightM !== undefined) return opts.heightM / assets.naturalHeight;
  return assets.species.scale ?? 1;
}

// ---------------------------------------------------------------------------
// Baked (preloaded) model — the cheap default
// ---------------------------------------------------------------------------

function nearestFrame(frames: BakedFrame[], t: number): THREE.BufferGeometry {
  // frames are evenly spaced on [0,1); pick the bucket.
  const i = Math.min(frames.length - 1, Math.floor(t * frames.length));
  return frames[i].geometry;
}

class BakedCreatureModel implements CreatureModel {
  readonly object = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private t = 0;

  constructor(private readonly assets: SpeciesAssets, scale: number) {
    const idle = assets.clips.get("idle")!;
    this.mesh = new THREE.Mesh(idle.frames[0].geometry, assets.material);
    this.mesh.frustumCulled = true;
    this.object.add(this.mesh);
    this.object.scale.setScalar(scale);
  }

  update(dt: number, opts?: CreatureDriveOptions): void {
    if (opts?.yaw !== undefined) this.object.rotation.y = opts.yaw;
    const moving = (opts?.speed01 ?? 0) > 0.05 && this.assets.clips.has("walk");
    const clip = this.assets.clips.get(moving ? "walk" : "idle")!;
    this.t += Math.max(0, dt) / clip.loopSeconds;
    if (clip.loops) this.t -= Math.floor(this.t);
    else this.t = Math.min(this.t, 0);
    const geom = nearestFrame(clip.frames, this.t);
    if (this.mesh.geometry !== geom) this.mesh.geometry = geom;
  }

  dispose(): void {
    // Geometry + material are SHARED assets — never disposed here.
    this.object.removeFromParent();
  }
}

// ---------------------------------------------------------------------------
// Dynamic model — full-fidelity rebuild, for the player + nearby creatures
// ---------------------------------------------------------------------------

class DynamicCreatureModel implements CreatureModel {
  readonly object = new THREE.Group();
  /** The live animator — exposed so a host can drive pickUp/putDown reaches. */
  readonly animator: CreatureAnimator;
  private readonly bp: Blueprint;
  private readonly toon: boolean;
  private built?: BuiltCreature;

  constructor(species: Species, look: CreatureLook, scale: number) {
    this.bp = clampBlueprint(species.blueprint);
    this.toon = !!look.toon;
    this.animator = new CreatureAnimator(this.bp);
    this.object.scale.setScalar(scale);
    this.rebuild(buildSkeleton(this.bp));
  }

  update(dt: number, opts?: CreatureDriveOptions): void {
    this.animator.setSpeed(opts?.speed01 ?? 0);
    if (opts?.pattern) this.animator.pattern = opts.pattern;
    const f = this.animator.update(dt);
    this.bp.posture.bodyPitch = f.posture.bodyPitch;
    this.bp.posture.bodyHeight = f.posture.bodyHeight;
    const skel = buildSkeleton(this.bp, f.gait, f.pose);
    this.rebuild(skel);
    this.animator.observe(skel);
    if (opts?.yaw !== undefined) this.object.rotation.y = opts.yaw;
  }

  private rebuild(skel: CreatureSkeleton): void {
    const built = buildCreatureMesh(skel, this.bp, { toon: this.toon });
    if (this.built) {
      this.object.remove(this.built.mesh);
      this.built.mesh.geometry.dispose();
      (this.built.mesh.material as THREE.Material).dispose();
    }
    this.object.add(built.mesh);
    this.built = built;
  }

  dispose(): void {
    if (this.built) {
      this.built.mesh.geometry.dispose();
      (this.built.mesh.material as THREE.Material).dispose();
    }
    this.object.removeFromParent();
  }
}

// ---------------------------------------------------------------------------
// Public factories
// ---------------------------------------------------------------------------

export interface CreateCreatureOptions {
  look?: CreatureLook;
  /** Explicit uniform scale (wins over heightM). */
  scale?: number;
  /** Scale so the model stands this many meters tall. */
  heightM?: number;
}

/** A cheap preloaded creature (baked clips). Use for residents, distant
 *  creatures, plants and fruit — anything that doesn't need per-frame fidelity. */
export function createBakedCreature(id: string, opts: CreateCreatureOptions = {}): CreatureModel {
  const assets = getSpeciesAssets(id, opts.look ?? {});
  return new BakedCreatureModel(assets, resolveScale(assets, opts));
}

/** A full-fidelity creature that rebuilds every frame. Use ONLY for the player
 *  avatar and creatures right next to them. Returns the concrete type so callers
 *  can reach `.animator` for reach/pick-up. */
export function createDynamicCreature(id: string, opts: CreateCreatureOptions = {}): DynamicCreatureModel {
  const species = requireSpecies(id);
  // naturalHeight for scaling still comes from the (cached) assets.
  const assets = getSpeciesAssets(id, opts.look ?? {});
  return new DynamicCreatureModel(species, opts.look ?? {}, resolveScale(assets, opts));
}

export type { DynamicCreatureModel };

// ---------------------------------------------------------------------------
// render3d AvatarModelFactory bridge
// ---------------------------------------------------------------------------

/** Map an avatar's facing (its ground heading fx,fy) to a body yaw. The creature
 *  builder faces +Z, so yaw = atan2(fx, fy) turns +Z onto (fx, fy). */
function facingYaw(fx: number, fy: number): number {
  return Math.atan2(fx, fy);
}

export interface CreatureAvatarFactoryOptions {
  /** Which species backs a given participant (id, isLocal). */
  speciesFor: (id: string, isLocal: boolean) => string;
  look?: CreatureLook;
  /** Stand every avatar this tall (meters). Default 1.7. */
  heightM?: number;
  /** The LOCAL avatar uses the dynamic (full-fidelity) model. Others use baked
   *  clips. Default true. */
  dynamicLocal?: boolean;
}

/** A gesture's WORLD target, rotated into the body-local frame (+Z forward, +X
 *  right) from the avatar's ground position + facing. Exported for tests. */
export function gestureLocalDir(g: { targetX: number; targetY: number }, x: number, y: number, fx: number, fy: number) {
  const dx = g.targetX - x;
  const dy = g.targetY - y;
  const len = Math.hypot(fx, fy) || 1;
  const nfx = fx / len;
  const nfy = fy / len;
  // forward = d·facing (local +Z); right = d×facing (local +X).
  return { x: dx * nfy - dy * nfx, y: 0, z: dx * nfx + dy * nfy };
}

/** Build an AvatarModelFactory (for World3DRenderer) that renders participants as
 *  creature-builder bodies instead of the placeholder capsule. The local player
 *  gets the dynamic model; everyone else gets the cheap baked one — EXCEPT while
 *  a baked NPC is performing a gesture (e.g. pointing the way), when a dynamic
 *  body is spun up just for the gesture and retired afterward, so the cost is
 *  bounded to one body at a time. */
export function createCreatureAvatarFactory(opts: CreatureAvatarFactoryOptions): AvatarModelFactory {
  const heightM = opts.heightM ?? 1.7;
  const dynamicLocal = opts.dynamicLocal ?? true;
  return (id, isLocal): AvatarModel => {
    const speciesId = opts.speciesFor(id, isLocal);
    const mopts = { look: opts.look, heightM };
    const container = new THREE.Group();
    // The local player is always dynamic; NPCs are baked until they gesture.
    const baked: CreatureModel | null = isLocal && dynamicLocal ? null : createBakedCreature(speciesId, mopts);
    let dyn: DynamicCreatureModel | null = baked ? null : createDynamicCreature(speciesId, mopts);
    container.add((dyn ?? baked!).object);
    let lastGestureId = 0;
    return {
      object: container,
      update(frame: AvatarFrame, dt: number): void {
        const drive = {
          speed01: Math.min(1, frame.speed / RUN_SPEED_MPS),
          yaw: facingYaw(frame.state.fx, frame.state.fy),
        };
        const g = frame.state.gesture;
        // A fresh gesture: on a baked NPC, spin up a dynamic body to perform it.
        if (g && g.id !== lastGestureId) {
          lastGestureId = g.id;
          if (!dyn) {
            dyn = createDynamicCreature(speciesId, mopts);
            container.remove(baked!.object);
            container.add(dyn.object);
          }
          if (g.kind === "point") {
            const s = frame.state;
            dyn.animator.point(gestureLocalDir(g, s.x, s.y, s.fx, s.fy), g.holdS);
          }
        }
        if (dyn) {
          dyn.update(dt, drive);
          // Gesture finished on a baked NPC → retire the temporary dynamic body.
          if (baked && dyn.animator.currentAction === "none") {
            container.remove(dyn.object);
            dyn.dispose();
            dyn = null;
            container.add(baked.object);
          }
        } else {
          baked!.update(dt, drive);
        }
      },
      dispose(): void {
        dyn?.dispose();
        baked?.dispose();
        container.removeFromParent();
      },
    };
  };
}
