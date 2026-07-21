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
import { CreatureAnimator, type BodyActivity } from "./animation";
import type { GaitPattern } from "./gait";
import { requireSpecies, type Species } from "./species";
import { clampOutfit, outfitPresetFor, type OutfitBlueprint } from "./clothing";
import { getShadingMode } from "../materials";
// Type-only — no runtime coupling to the (DOM/GL-heavy) renderer.
import type { AvatarFrame, AvatarModel, AvatarModelFactory } from "../render3d";

/** Visual options shared by every creature model. */
export interface CreatureLook {
  /** FORCE cel/toon shading on (or off) for this creature, overriding the
   *  engine-wide mode — for side-by-side comparison in the labs. Leave UNSET in
   *  game code so the creature follows `setShadingMode()` like the rest of the
   *  world; a hard `false` here pins it to standard while everything around it
   *  cel-shades. */
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
  /** Sustained body activity (sleep / eat / sit / play — animation.ts). Held
   *  set while it runs; the dynamic model rides the animator's rig-level pose
   *  (and lays the body flat for sleep). Baked models ignore it — the avatar
   *  factory swaps in a dynamic body while an activity runs, gesture-style. */
  activity?: BodyActivity;
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
  toon: boolean | undefined,
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
  toon: boolean | undefined,
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
function bakeIdle(bp: Blueprint, toon: boolean | undefined, matRef: { mat?: THREE.Material }): BakedClip {
  const skel = buildSkeleton(bp);
  return { name: "idle", frames: [{ phase: 0, geometry: snapshot(skel, bp, toon, matRef) }], loopSeconds: 1, loops: false };
}

const WALK_FRAMES = 14;
const WALK_SPEED01 = 0.42;

/** The species' clamped blueprint, dressed in `outfit` when given. Fresh
 *  object per call (bake steps mutate posture). Absent outfit = the species
 *  record untouched — the bare path stays byte-identical. */
function dressedBlueprint(species: Species, outfit?: OutfitBlueprint): Blueprint {
  return clampBlueprint(outfit ? { ...species.blueprint, outfit } : species.blueprint);
}

function buildSpeciesAssets(species: Species, look: CreatureLook, outfit?: OutfitBlueprint): SpeciesAssets {
  // BODILESS (the player's "spark"): there is no body to build. Its blueprint is
  // empty, and clampBlueprint fills every unset field — so building it would
  // silently produce a DEFAULT body and stand a stranger in the world where the
  // player should be an unrendered light. Fail loudly instead: a spark is drawn
  // by the gaze-spark renderer, never by the creature builder.
  if (species.bodiless) {
    throw new Error(
      `creature-model: species "${species.id}" is bodiless — it renders as a light, not a mesh`,
    );
  }
  // NOT `!!look.toon` — an unset `toon` means "follow the engine-wide shading
  // mode", and coercing it to false would FORCE standard on every creature
  // while the rest of the world cel-shades.
  const toon = look.toon;
  const matRef: { mat?: THREE.Material } = {};
  const clips = new Map<string, BakedClip>();
  // Rest height from the bone AABB (feet ~0).
  const restSkel = buildSkeleton(dressedBlueprint(species, outfit));
  const naturalHeight = Math.max(0.1, restSkel.bounds.max.y - restSkel.bounds.min.y);

  clips.set("idle", bakeIdle(dressedBlueprint(species, outfit), toon, matRef));
  if (species.kind === "creature" && canWalk(dressedBlueprint(species, outfit))) {
    clips.set("walk", bakeLocomotion(dressedBlueprint(species, outfit), WALK_FRAMES, WALK_SPEED01, "trot", toon, matRef));
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

// Cache: one asset set per (speciesId, look, outfit-hash). Games call
// getSpeciesAssets to warm this up front (preloading) so no bake happens
// mid-gameplay. A town of humans in 4 outfit presets = 4 bakes, shared by
// every resident wearing that preset.
const ASSET_CACHE = new Map<string, SpeciesAssets>();

/** Stable content hash of an outfit for the asset-cache key. Empty string for
 *  bare (no/empty outfit) so bare keys are unchanged from before outfits. */
function outfitHash(outfit?: OutfitBlueprint): string {
  const clamped = outfit ? clampOutfit(outfit) : undefined;
  if (!clamped || clamped.garments.length === 0) return "";
  // FNV-1a over the clamped JSON — clampGarment emits fields in a fixed
  // order, so equal outfits stringify identically.
  const json = JSON.stringify(clamped);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `|o:${(h >>> 0).toString(36)}`;
}

function assetKey(id: string, look: CreatureLook, outfit?: OutfitBlueprint): string {
  // Key on the EFFECTIVE mode, not the raw field: an unset `toon` follows the
  // engine-wide mode, so keying on `look.toon` alone would hand a global-toon
  // creature the cached assets of an explicitly-standard one.
  const toon = look.toon ?? (getShadingMode() === "toon");
  return `${id}|${toon ? "toon" : "std"}${outfitHash(outfit)}`;
}

/** Get (building + caching on first call) the shared assets for a species. Call
 *  this at load time for every species a scene will use to PRELOAD the bakes.
 *  `outfit` bakes the species WEARING it (cached separately per outfit). */
export function getSpeciesAssets(id: string, look: CreatureLook = {}, outfit?: OutfitBlueprint): SpeciesAssets {
  const key = assetKey(id, look, outfit);
  let assets = ASSET_CACHE.get(key);
  if (!assets) {
    assets = buildSpeciesAssets(requireSpecies(id), look, outfit);
    ASSET_CACHE.set(key, assets);
  }
  return assets;
}

/** Drop a cached species' assets (frees GPU geometry + material). */
export function disposeSpeciesAssets(id: string, look: CreatureLook = {}, outfit?: OutfitBlueprint): void {
  const key = assetKey(id, look, outfit);
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
  /** Unset = follow the engine-wide shading mode (see buildSpeciesAssets). */
  private readonly toon: boolean | undefined;
  private built?: BuiltCreature;
  /** Inner rig the mesh hangs from — the RECLINE (lying flat for sleep) is a
   *  root transform here, body-local, under the yaw on `object`. */
  private readonly rig = new THREE.Group();
  /** Rest-pose extents (blueprint meters) the recline transform needs: body
   *  height (to center the lying body on its anchor) and how far the back of
   *  the body sits behind the origin (so it rests ON the surface, not in it). */
  private readonly restHeight: number;
  private readonly backDepth: number;
  private time = 0;

  constructor(species: Species, look: CreatureLook, scale: number, outfit?: OutfitBlueprint) {
    this.bp = dressedBlueprint(species, outfit);
    this.toon = look.toon;
    this.animator = new CreatureAnimator(this.bp);
    this.object.scale.setScalar(scale);
    this.object.add(this.rig);
    const rest = buildSkeleton(this.bp);
    this.restHeight = Math.max(0.1, rest.bounds.max.y - rest.bounds.min.y);
    this.backDepth = Math.max(0, -rest.bounds.min.z);
    this.rebuild(rest);
  }

  update(dt: number, opts?: CreatureDriveOptions): void {
    this.time += Math.max(0, dt);
    this.animator.setSpeed(opts?.speed01 ?? 0);
    this.animator.setActivity(opts?.activity ?? "none");
    if (opts?.pattern) this.animator.pattern = opts.pattern;
    const f = this.animator.update(dt);
    this.bp.posture.bodyPitch = f.posture.bodyPitch;
    this.bp.posture.bodyHeight = f.posture.bodyHeight;
    const skel = buildSkeleton(this.bp, f.gait, f.pose);
    this.rebuild(skel);
    this.animator.observe(skel);
    if (opts?.yaw !== undefined) this.object.rotation.y = opts.yaw;
    // RECLINE (sleep): tip the whole body onto its back — feet-forward pivot at
    // the root — raised so the back rests ON the anchor surface and shifted so
    // the lying body is CENTERED on the root. A gentle bob breathes it. Pure
    // root transform: works for any body plan, no per-species keyframes.
    const recline = f.recline ?? 0;
    this.rig.rotation.x = -(Math.PI / 2) * recline;
    const breathe = recline * 0.02 * Math.sin(this.time * 1.7);
    this.rig.position.y = recline * this.backDepth + breathe;
    this.rig.position.z = recline * (this.restHeight / 2);
  }

  private rebuild(skel: CreatureSkeleton): void {
    const built = buildCreatureMesh(skel, this.bp, { toon: this.toon });
    if (this.built) {
      this.rig.remove(this.built.mesh);
      this.built.mesh.geometry.dispose();
      (this.built.mesh.material as THREE.Material).dispose();
    }
    this.rig.add(built.mesh);
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
  /** Dress the creature in this outfit (clothing.ts). Baked models bake it in
   *  (one bake per (species, look, outfit) — see outfitPresetFor for a small
   *  shared wardrobe); dynamic models re-loft it every frame. Absent = bare. */
  outfit?: OutfitBlueprint;
}

/** A cheap preloaded creature (baked clips). Use for residents, distant
 *  creatures, plants and fruit — anything that doesn't need per-frame fidelity. */
export function createBakedCreature(id: string, opts: CreateCreatureOptions = {}): CreatureModel {
  const assets = getSpeciesAssets(id, opts.look ?? {}, opts.outfit);
  return new BakedCreatureModel(assets, resolveScale(assets, opts));
}

/** A full-fidelity creature that rebuilds every frame. Use ONLY for the player
 *  avatar and creatures right next to them. Returns the concrete type so callers
 *  can reach `.animator` for reach/pick-up. */
export function createDynamicCreature(id: string, opts: CreateCreatureOptions = {}): DynamicCreatureModel {
  const species = requireSpecies(id);
  // naturalHeight for scaling still comes from the (cached) BARE assets —
  // clothes must not change a creature's height, and a dynamic model should
  // never trigger a dressed bake just to measure one.
  const assets = getSpeciesAssets(id, opts.look ?? {});
  return new DynamicCreatureModel(species, opts.look ?? {}, resolveScale(assets, opts), opts.outfit);
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

/** Activities whose body rides a FIXTURE (render3d.resolveActivityAnchor hands
 *  one back): the slide-on + yaw-align runs for these and no others. "eat" is
 *  absent on purpose — a diner stands at the table's edge rather than on it. */
const ANCHORED_ACTIVITIES: ReadonlySet<string> = new Set(["sleep", "sit"]);

export interface CreatureAvatarFactoryOptions {
  /** Which species backs a given participant (id, isLocal). */
  speciesFor: (id: string, isLocal: boolean) => string;
  look?: CreatureLook;
  /** Stand every avatar this tall (meters). Default 1.7. */
  heightM?: number;
  /** The LOCAL avatar uses the dynamic (full-fidelity) model. Others use baked
   *  clips. Default true. */
  dynamicLocal?: boolean;
  /** What a given avatar WEARS — return an outfit (e.g. `outfitPresetFor` of a
   *  stable resident hash) to dress them, undefined for bare. Baked avatars
   *  sharing a preset share one bake. */
  outfitFor?: (avatarId: string) => OutfitBlueprint | undefined;
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

/** Shortest-path yaw blend (radians), so a lying body eases onto its bed's
 *  heading without whipping the long way around. */
function mixYaw(a: number, b: number, t: number): number {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
}

/** The root-slide strength for an anchored activity: the animator's eased pose
 *  level, dissolved by movement with the SAME dial the pose itself uses
 *  (animation.ts: `1 - clamp01(speed / 0.2)`). Without the speed term a body
 *  dragged off mid-activity (a command, the next errand) stayed GLUED to the
 *  bed/privy at full strength while its pose faded, then teleported to
 *  wherever the sim body had walked — the observed to/from-fixture teleport.
 *  Exported for tests. */
export function anchorSlideLevel(activityLevel: number, speed01: number): number {
  return activityLevel * (1 - Math.min(1, Math.max(0, speed01 / 0.2)));
}

export interface ActivityAnchor {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Latch the activity anchor across the pose's WIND-DOWN: the sim clears
 *  `state.activity` the instant a dwell ends, so the renderer's per-frame
 *  anchor goes null while the animator is still easing the pose out — snapping
 *  the root from the fixture to the stand point in one frame (the teleport OFF
 *  the bed). The latch keeps the last anchor alive while any slide strength
 *  remains, releasing it only once the blend reaches zero. Exported for tests. */
export function createAnchorLatch(): (anchor: ActivityAnchor | null, level: number) => ActivityAnchor | null {
  let last: ActivityAnchor | null = null;
  return (anchor, level) => {
    if (anchor) last = anchor;
    else if (level <= 0) last = null;
    return level > 0 ? last : null;
  };
}

/** Build an AvatarModelFactory (for World3DRenderer) that renders participants as
 *  creature-builder bodies instead of the placeholder capsule. The local player
 *  gets the dynamic model; everyone else gets the cheap baked one — EXCEPT while
 *  a baked NPC is performing a gesture (e.g. pointing the way) or holding an
 *  ACTIVITY (asleep / eating / sitting / playing — state.activity), when a
 *  dynamic body is spun up just for it and retired afterward, so the cost is
 *  bounded to the few bodies actually doing something. */
export function createCreatureAvatarFactory(opts: CreatureAvatarFactoryOptions): AvatarModelFactory {
  const heightM = opts.heightM ?? 1.7;
  const dynamicLocal = opts.dynamicLocal ?? true;
  return (id, isLocal): AvatarModel => {
    const speciesId = opts.speciesFor(id, isLocal);
    const mopts = { look: opts.look, heightM, outfit: opts.outfitFor?.(id) };
    const container = new THREE.Group();
    // The local player is always dynamic; NPCs are baked until they gesture.
    let baked: CreatureModel | null = isLocal && dynamicLocal ? null : createBakedCreature(speciesId, mopts);
    let dyn: DynamicCreatureModel | null = baked ? null : createDynamicCreature(speciesId, mopts);
    container.add((dyn ?? baked!).object);
    let lastGestureId = 0;
    let wornIdx: number | undefined; // last-applied `state.wearing` override
    const latchAnchor = createAnchorLatch(); // survives the pose's wind-down
    return {
      object: container,
      update(frame: AvatarFrame, dt: number): void {
        // LIVE RE-DRESS (AvatarState.wearing): a dressed body whose worn
        // preset changed swaps to the new outfit's (cached) bake — the
        // visible change of clothes. Only bodies this factory DRESSES react
        // (bare species — pets, puzzle NPCs — ignore the channel).
        const wearing = frame.state.wearing;
        if (opts.outfitFor && wearing !== undefined && wearing !== wornIdx) {
          wornIdx = wearing;
          mopts.outfit = outfitPresetFor(wearing);
          if (baked) {
            const showing = !dyn; // dyn may be temporarily on show (gesture)
            container.remove(baked.object);
            baked.dispose();
            baked = createBakedCreature(speciesId, mopts);
            if (showing) container.add(baked.object);
          }
          if (dyn) {
            container.remove(dyn.object);
            dyn.dispose();
            dyn = createDynamicCreature(speciesId, mopts);
            container.add(dyn.object);
          }
        }
        const drive: CreatureDriveOptions = {
          speed01: Math.min(1, frame.speed / RUN_SPEED_MPS),
          yaw: facingYaw(frame.state.fx, frame.state.fy),
          activity: frame.state.activity?.kind ?? "none",
        };
        const g = frame.state.gesture;
        const needsDyn = (g && g.id !== lastGestureId) || drive.activity !== "none";
        // A fresh gesture or a live activity on a baked NPC: spin up a dynamic
        // body to perform it (retired below once it settles).
        if (needsDyn && !dyn) {
          dyn = createDynamicCreature(speciesId, mopts);
          container.remove(baked!.object);
          container.add(dyn.object);
        }
        if (g && g.id !== lastGestureId) {
          lastGestureId = g.id;
          const s = frame.state;
          const local = gestureLocalDir(g, s.x, s.y, s.fx, s.fy);
          if (g.kind === "point") {
            dyn!.animator.point(local, g.holdS);
          } else if (g.kind === "pickup") {
            // Reach → grasp → lift; the carry pose then HOLDS (the body stays
            // dynamic — see the retire check below) until a putdown gesture.
            // Target at about box-top height where the item sits.
            dyn!.animator.pickUp({ x: local.x, y: 0.45, z: local.z }, g.sizeM ?? 0);
          } else if (g.kind === "putdown") {
            // No-op unless carrying (animation.ts guard) — hosts fire freely.
            dyn!.animator.putDown({ x: local.x, y: 0.45, z: local.z });
          }
        }
        if (dyn) {
          // ONTO THE FURNITURE: the renderer resolved the fixture the activity
          // names (frame.activityAnchor — its top center + its heading): the BED
          // a sleeper lies on, the CHAIR or PRIVY a sitter takes. Slide the body
          // from where it stands onto the surface and align it to the fixture's
          // axis, synced to the animator's own blend so it settles as it slides
          // on — and slides back off as it wakes/stands. An activity with no
          // anchor (a doze in place, a scrub at the tub) poses where it stands.
          const anchor =
            drive.activity && ANCHORED_ACTIVITIES.has(drive.activity) ? (frame.activityAnchor ?? null) : null;
          const cur = dyn.animator.currentActivity;
          const posed = cur && ANCHORED_ACTIVITIES.has(cur) ? dyn.animator.activityLevel() : 0;
          // Movement dissolves the slide exactly like it dissolves the pose
          // (anchorSlideLevel), and the LAST anchor is latched through the
          // wind-down (createAnchorLatch) — so waking, standing up, and being
          // walked off mid-activity all SLIDE off the fixture instead of
          // snapping between it and the sim body.
          const lie = anchorSlideLevel(posed, drive.speed01 ?? 0);
          const at = latchAnchor(anchor, lie);
          if (at) {
            dyn.object.position.set(
              (at.x - container.position.x) * lie,
              (at.y - container.position.y) * lie,
              (at.z - container.position.z) * lie,
            );
            drive.yaw = mixYaw(drive.yaw!, at.yaw, lie);
          } else {
            dyn.object.position.set(0, 0, 0);
          }
          dyn.update(dt, drive);
          // Gesture + activity finished on a baked NPC → retire the temporary
          // dynamic body.
          if (baked && dyn.animator.currentAction === "none" && !dyn.animator.activityBusy()) {
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
