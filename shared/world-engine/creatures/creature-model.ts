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
import { probesOn } from "../perf-probes.js";
import type { Blueprint } from "./blueprint";
import { clampBlueprint } from "./blueprint";
import { buildSkeleton, type CreatureSkeleton } from "./skeleton";
import { buildCreatureMesh, type BuiltCreature } from "./mesh";
import { CreatureAnimator, type BodyActivity } from "./animation";
import type { GaitPattern } from "./gait";
import { requireSpecies, type Species } from "./species";
import { clampOutfit, outfitPresetFor, type OutfitBlueprint } from "./clothing";
import { buildStickGeometry, creatureSticks, stickMaterial } from "./stick-lod";
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
 *  and stripping the skin attributes (a baked frame is a plain, static Mesh).
 *
 *  The STICK tier hands the same seam a different builder: no loft at all, one
 *  camera-facing capsule per merged bone (stick-lod.ts). Everything downstream
 *  — the clip, the shared material, BakedCreatureModel's per-frame geometry
 *  swap — is untouched, which is the whole reason the tier slots in here. */
function snapshot(
  skel: CreatureSkeleton,
  bp: Blueprint,
  toon: boolean | undefined,
  matRef: { mat?: THREE.Material },
  detail: CreatureDetail = "full",
): THREE.BufferGeometry {
  if (detail === "stick") {
    // UNLIT (stick-lod.ts) — so `toon` has nothing to act on here: there is no
    // lighting at this tier to quantise. One shared material, one compiled
    // program, however many species are on screen.
    if (!matRef.mat) matRef.mat = stickMaterial();
    return buildStickGeometry(creatureSticks(skel, bp));
  }
  const sides = detail === "simple" ? SIMPLE_SIDES : undefined;
  const built = buildCreatureMesh(skel, bp, { toon, ...(sides !== undefined ? { sides } : {}) });
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
  detail: CreatureDetail = "full",
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
    frames.push({ phase: i / frameCount, geometry: snapshot(last.skel, bp, toon, matRef, detail) });
  }
  return { name: "walk", frames, loopSeconds: frameCount * stride * dt, loops: true };
}

/** Bake the static rest pose as a one-frame clip (idle / plants / fruit). */
function bakeIdle(bp: Blueprint, toon: boolean | undefined, matRef: { mat?: THREE.Material }, detail: CreatureDetail = "full"): BakedClip {
  const skel = buildSkeleton(bp);
  return { name: "idle", frames: [{ phase: 0, geometry: snapshot(skel, bp, toon, matRef, detail) }], loopSeconds: 1, loops: false };
}

const WALK_FRAMES = 14;
const WALK_SPEED01 = 0.42;

/** DETAIL TIERS (view-distance-lod-tiers.md Phase 3): `simple` is the
 *  mid-distance body — fewer loft sides and fewer baked walk frames; `stick`
 *  drops the loft entirely for a handful of camera-facing capsules along the
 *  bones (stick-lod.ts). A RENDER-ONLY choice each client makes from ITS OWN
 *  camera (multiplayer peers dress the same replicated bodies at their own
 *  fidelity); never sim state. */
export type CreatureDetail = "full" | "simple" | "stick";
const SIMPLE_SIDES = 5;
const SIMPLE_WALK_FRAMES = 7;
/** Stick walk frames. Not lower than `simple`'s: at this tier a frame costs
 *  ~0.1 ms of stick derivation against the clip's fixed ~35 ms of animator
 *  warm-up, so cutting frames buys nothing and costs gait legibility. */
const STICK_WALK_FRAMES = 7;

/** The species' clamped blueprint, dressed in `outfit` when given. Fresh
 *  object per call (bake steps mutate posture). Absent outfit = the species
 *  record untouched — the bare path stays byte-identical. */
function dressedBlueprint(species: Species, outfit?: OutfitBlueprint): Blueprint {
  return clampBlueprint(outfit ? { ...species.blueprint, outfit } : species.blueprint);
}

function buildSpeciesAssets(
  species: Species,
  look: CreatureLook,
  outfit?: OutfitBlueprint,
  detail: CreatureDetail = "full",
): SpeciesAssets {
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
  // A VOCABULARY STUB has the same empty blueprint for a different reason: the
  // word ships ahead of the body. Clamping it would stand a default quadruped
  // in the world and call it a lion, which is worse than not building it.
  if (species.stub) {
    throw new Error(
      `creature-model: species "${species.id}" is a vocabulary stub — no body plan is authored yet`,
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

  const walkFrames = detail === "simple" ? SIMPLE_WALK_FRAMES : detail === "stick" ? STICK_WALK_FRAMES : WALK_FRAMES;
  clips.set("idle", bakeIdle(dressedBlueprint(species, outfit), toon, matRef, detail));
  if (species.kind === "creature" && canWalk(dressedBlueprint(species, outfit))) {
    clips.set("walk", bakeLocomotion(dressedBlueprint(species, outfit), walkFrames, WALK_SPEED01, "trot", toon, matRef, detail));
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

/** THE STICK TIER IS OUTFIT-BLIND — one bake per species, not per garment.
 *  A body at 45 m is ~44 px tall and its clothes are a couple of pixels of
 *  colour, so dressing the capsules would buy nothing and cost the town its
 *  whole wardrobe again (the `simple` tier warms one bake per head × palette
 *  colour, staggered off the critical path because each is ~60 ms).
 *
 *  ONE definition, applied at the cache doors, so the key and the bake can
 *  never disagree about what was baked — normalising in `assetKey` alone would
 *  hand every outfit the FIRST one's capsules while claiming a shared key. */
function outfitForDetail(outfit: OutfitBlueprint | undefined, detail: CreatureDetail): OutfitBlueprint | undefined {
  return detail === "stick" ? undefined : outfit;
}

function assetKey(id: string, look: CreatureLook, outfit?: OutfitBlueprint, detail: CreatureDetail = "full"): string {
  // Key on the EFFECTIVE mode, not the raw field: an unset `toon` follows the
  // engine-wide mode, so keying on `look.toon` alone would hand a global-toon
  // creature the cached assets of an explicitly-standard one.
  const toon = look.toon ?? (getShadingMode() === "toon");
  const lod = detail === "simple" ? "|lod:s" : detail === "stick" ? "|lod:k" : "";
  return `${id}|${toon ? "toon" : "std"}${outfitHash(outfit)}${lod}`;
}

/** Get (building + caching on first call) the shared assets for a species. Call
 *  this at load time for every species a scene will use to PRELOAD the bakes.
 *  `outfit` bakes the species WEARING it (cached separately per outfit). */
export function getSpeciesAssets(
  id: string,
  look: CreatureLook = {},
  rawOutfit?: OutfitBlueprint,
  detail: CreatureDetail = "full",
): SpeciesAssets {
  const outfit = outfitForDetail(rawOutfit, detail);
  const key = assetKey(id, look, outfit, detail);
  let assets = ASSET_CACHE.get(key);
  if (!assets) {
    // TEMP bake probe (view-distance-lod-tiers.md Phase 3): each MISS is a
    // 14-frame locomotion bake (+120 warmup skeleton solves) — the per-stream-in
    // lag suspect. If a town's ~40 residents log ~40 misses, outfits aren't
    // collapsing to presets (the fix is to quantize resident dress); a handful
    // of misses means the bake is shared and the cost lies elsewhere. Remove
    // with the descent probe. `__bakeCount` / `__bakeMs` readable in the console.
    const _t0 = typeof performance !== "undefined" ? performance.now() : 0;
    assets = buildSpeciesAssets(requireSpecies(id), look, outfit, detail);
    ASSET_CACHE.set(key, assets);
    if (probesOn() && typeof console !== "undefined") {
      const g = globalThis as unknown as { __bakeCount?: number; __bakeMs?: number };
      const ms = (typeof performance !== "undefined" ? performance.now() : 0) - _t0;
      g.__bakeCount = (g.__bakeCount ?? 0) + 1;
      g.__bakeMs = (g.__bakeMs ?? 0) + ms;
      console.log(`[bake-probe] #${g.__bakeCount} ${key} ${ms.toFixed(0)}ms (cache=${ASSET_CACHE.size}, total=${g.__bakeMs.toFixed(0)}ms)`);
    }
  }
  return assets;
}

/** Drop a cached species' assets (frees GPU geometry + material). */
export function disposeSpeciesAssets(
  id: string,
  look: CreatureLook = {},
  rawOutfit?: OutfitBlueprint,
  detail: CreatureDetail = "full",
): void {
  const key = assetKey(id, look, outfitForDetail(rawOutfit, detail), detail);
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

/** The creature-local height of the body's LOWEST torso underside (meters) —
 *  the belly/seat that should rest on a surface. Walks the torso bones and
 *  takes the lowest (centre − loft radius) point. Measured on whatever pose the
 *  skeleton is in, so read on a SEATED (crouched) skeleton it gives the seated
 *  butt height above the feet-origin — the drop needed to land the body ON a
 *  seat instead of floating a hip-height above it. Body-plan-agnostic (a
 *  quadruped's belly, a biped's hips both fall out of the same walk). */
function torsoUndersideY(skel: CreatureSkeleton): number {
  let lo = Infinity;
  for (const b of skel.bones) {
    if (b.kind !== "torso") continue;
    lo = Math.min(lo, b.head.y - b.radiusHead, b.tail.y - b.radiusTail);
  }
  return Number.isFinite(lo) ? Math.max(0, lo) : 0;
}

// ── Recline (lying flat) — a body-plan-agnostic root transform ──────────────
// Lying down is not a solver pose: the animator only reports how far along the
// recline is (AnimFrame.recline) and the MODEL tips the whole rig. What it tips
// BY has to come from the body itself — a fixed quarter-turn lays a PERSON on
// their back but stands a horse on its tail.

/** The torso's own pitch in the pose the skeleton was built at: radians off
 *  horizontal, + = chest raised (the blueprint's `posture.bodyPitch`, but
 *  MEASURED off the built spine so it follows whatever the solvers did). Runs
 *  rear-most torso bone head → front-most torso bone tail. */
function torsoPitch(skel: CreatureSkeleton, fallback: number): number {
  const torso = skel.bones.filter((b) => b.kind === "torso");
  if (torso.length === 0) return fallback;
  const dy = torso[torso.length - 1].tail.y - torso[0].head.y;
  const dz = torso[torso.length - 1].tail.z - torso[0].head.z;
  return Math.hypot(dy, dz) < 1e-6 ? fallback : Math.atan2(dy, dz);
}

/** How far the root must turn (radians about X) for a body whose rest spine
 *  pitch is `restPitch` to be `recline` (0..1) of the way onto its BACK.
 *
 *  Full recline is `restPitch - π`: the SHORTEST turn that takes the body's
 *  dorsal direction — (0, cos p, −sin p) for a spine pitched at p — onto
 *  straight down, whatever the rest posture is. An upright body (a person,
 *  p ≈ 1.39) tips ~100° backward onto its back, which is what the old fixed
 *  −90° roughly did; a HORIZONTAL body (a horse, p ≈ 0.08) rolls the whole
 *  ~175° over rather than being stood on its tail, which is what a fixed −90°
 *  did to it. Either way the spine ends horizontal, back to the ground.
 *  Exported for tests. */
export function reclinePitch(restPitch: number, recline: number): number {
  return (restPitch - Math.PI) * recline;
}

/** Where a turned body has to SLIDE to sit on its anchor: lift it until its
 *  lowest point rests on the plane it stood on, and shift it fore/aft until it
 *  is centred where it stood. Both are differences against the UN-turned pose,
 *  so an angle of 0 gives (0, 0) — a standing body never shifts.
 *
 *  Measured over the built skin's own vertices (`pos` = an x,y,z triple array),
 *  not a bone hull or a bounding box: fur, fins, horns and the skull's dome are
 *  all in there, and a rotated AABB would hang the body off an empty corner.
 *  One pass, and only while a body is actually lying down. Exported for tests. */
export function reclineSeat(
  pos: ArrayLike<number>,
  count: number,
  angle: number,
): { y: number; z: number } {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let lowY = Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let restLowY = Infinity;
  let restMinZ = Infinity;
  let restMaxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    const ry = y * cos - z * sin;
    const rz = y * sin + z * cos;
    if (ry < lowY) lowY = ry;
    if (rz < minZ) minZ = rz;
    if (rz > maxZ) maxZ = rz;
    if (y < restLowY) restLowY = y;
    if (z < restMinZ) restMinZ = z;
    if (z > restMaxZ) restMaxZ = z;
  }
  if (!Number.isFinite(lowY)) return { y: 0, z: 0 };
  return { y: restLowY - lowY, z: (restMinZ + restMaxZ) / 2 - (minZ + maxZ) / 2 };
}

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
  /** The body's own rest spine pitch — how far the recline must tip it to land
   *  the back on the ground (a person ~100°, a horse ~175°). Read from the REST
   *  skeleton: it is the species' normal posture, not the frame's. */
  private readonly restPitch: number;
  /** Rest neck lift / tail droop, so the recline can relax them into line with
   *  the lying spine and put them back on waking. */
  private readonly restNeckLift: number;
  private readonly restTailDroop: number;
  /** Creature-local underside of the torso in the CURRENT pose — a SEATED body
   *  reads its crouched hip height here so the anchor slide can drop it onto the
   *  seat surface (see `seatDropWorld`). Refreshed every rebuild. */
  private seatContactLocal: number;
  private time = 0;

  /** Loft sides for the rebuild — set when built at reduced detail, so even
   *  the per-frame dynamic path lofts cheaper at distance. The STICK tier has
   *  no dynamic form (the avatar factory never spins one up that far out —
   *  see createCreatureAvatarFactory), so it falls back to the simple loft
   *  rather than silently lofting at full fidelity. */
  private readonly sides: number | undefined;

  constructor(species: Species, look: CreatureLook, scale: number, outfit?: OutfitBlueprint, detail: CreatureDetail = "full") {
    this.bp = dressedBlueprint(species, outfit);
    this.toon = look.toon;
    this.sides = detail === "full" ? undefined : SIMPLE_SIDES;
    this.animator = new CreatureAnimator(this.bp);
    this.object.scale.setScalar(scale);
    this.object.add(this.rig);
    const rest = buildSkeleton(this.bp);
    this.restPitch = torsoPitch(rest, this.bp.posture.bodyPitch);
    this.restNeckLift = this.bp.neck.lift;
    this.restTailDroop = this.bp.tail.droop;
    this.seatContactLocal = torsoUndersideY(rest);
    this.rebuild(rest);
  }

  /** World-meter drop that lands a SEATED body's underside on the seat surface
   *  the anchor points at: the crouched torso underside (creature-local) scaled
   *  to world. The factory subtracts this from a sit anchor's height and eases
   *  it in with the same slide level, so the body settles ON the chair/toilet
   *  (feet hanging toward the floor) rather than floating a hip-height above it.
   *  Sleep does not use it (its recline transform re-centres the lying body). */
  get seatDropWorld(): number {
    return this.seatContactLocal * this.object.scale.x;
  }

  update(dt: number, opts?: CreatureDriveOptions): void {
    this.time += Math.max(0, dt);
    this.animator.setSpeed(opts?.speed01 ?? 0);
    this.animator.setActivity(opts?.activity ?? "none");
    if (opts?.pattern) this.animator.pattern = opts.pattern;
    const f = this.animator.update(dt);
    const recline = f.recline ?? 0;
    this.bp.posture.bodyPitch = f.posture.bodyPitch;
    this.bp.posture.bodyHeight = f.posture.bodyHeight;
    // LYING: a neck or tail that is normally HELD UP (a horse's neck, a cat's
    // raised tail) points at the ground once the body is on its back, and drives
    // straight through it. Relax both into line with the (now horizontal) spine
    // as the recline eases in — solver INPUT, so it costs no per-species pose.
    this.bp.neck.lift = this.restNeckLift * (1 - recline);
    this.bp.tail.droop = this.restTailDroop * (1 - recline);
    const skel = buildSkeleton(this.bp, f.gait, f.pose);
    this.rebuild(skel);
    this.animator.observe(skel);
    if (opts?.yaw !== undefined) this.object.rotation.y = opts.yaw;
    // RECLINE (sleep): tip the whole body onto its BACK by its own rest pitch
    // (reclinePitch), raised so the back rests ON the anchor surface and
    // shifted so the lying body is CENTERED on the root (reclineSeat, read off
    // the skin just rebuilt above — so the seating follows the pose it is
    // actually in: legs folded by the sleep crouch, neck and tail relaxed).
    // A gentle bob breathes it. Pure root transform: works for any body plan,
    // no per-species keyframes.
    const pitch = reclinePitch(this.restPitch, recline);
    this.rig.rotation.x = pitch;
    if (recline > 0) {
      const attr = this.built!.mesh.geometry.getAttribute("position");
      const seat = reclineSeat(attr.array as ArrayLike<number>, attr.count, pitch);
      this.rig.position.set(0, seat.y + recline * 0.02 * Math.sin(this.time * 1.7), seat.z);
    } else {
      this.rig.position.set(0, 0, 0);
    }
  }

  private rebuild(skel: CreatureSkeleton): void {
    this.seatContactLocal = torsoUndersideY(skel);
    const built = buildCreatureMesh(skel, this.bp, {
      toon: this.toon,
      ...(this.sides !== undefined ? { sides: this.sides } : {}),
    });
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
  /** Loft fidelity (Phase 3 view tiers). Default "full"; "simple" lofts fewer
   *  sides and bakes fewer walk frames — the mid-distance body. */
  detail?: CreatureDetail;
}

/** A cheap preloaded creature (baked clips). Use for residents, distant
 *  creatures, plants and fruit — anything that doesn't need per-frame fidelity. */
export function createBakedCreature(id: string, opts: CreateCreatureOptions = {}): CreatureModel {
  const assets = getSpeciesAssets(id, opts.look ?? {}, opts.outfit, opts.detail);
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
  return new DynamicCreatureModel(species, opts.look ?? {}, resolveScale(assets, opts), opts.outfit, opts.detail);
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
  /** Loft fidelity for NEW models, read PER BODY at model-creation time
   *  (Phase 3 view tiers): return "simple" for the mid-distance band. A LOCAL
   *  client-camera choice — re-tier an existing body via render3d's
   *  `resetAvatarModel`, which rebuilds it through this factory at the
   *  then-current answer. */
  detailFor?: (avatarId: string) => CreatureDetail;
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
 *  bed/toilet at full strength while its pose faded, then teleported to
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
  /** Which body part the anchor's use-point names (the furniture-use contract).
   *  "pelvis" (a seat/toilet) → the crouched hip underside is DROPPED onto the
   *  surface (seatDropWorld); "torso" (a bed) → the recline re-centres the lying
   *  body, no drop; "reach"/absent → no drop. Selecting the drop from the
   *  CONTRACT (not `activity === "sit"`) keeps every layer reading one contract. */
  contact?: "pelvis" | "torso" | "reach";
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
    // Detail is sampled ONCE per model build (the local player is always full);
    // a tier change re-enters here through resetAvatarModel.
    const detail = isLocal ? "full" : (opts.detailFor?.(id) ?? "full");
    const mopts = { look: opts.look, heightM, outfit: opts.outfitFor?.(id), detail };
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
        // STICK TIER: never spin up a dynamic body. A gesture or an activity
        // normally buys a per-frame re-lofted body so the NPC can point, reach
        // or lie down — but this body is 18-44 px tall, none of that is
        // legible, and paying a full-fidelity rebuild EVERY FRAME for a figure
        // this small is the exact cost the tier exists to stop. Distant bodies
        // stand and walk; the pose returns with the body the moment it crosses
        // back into the simple band (a tier change re-enters this factory).
        const poseable = detail !== "stick";
        const needsDyn = poseable && ((g && g.id !== lastGestureId) || drive.activity !== "none");
        // A fresh gesture or a live activity on a baked NPC: spin up a dynamic
        // body to perform it (retired below once it settles).
        if (needsDyn && !dyn) {
          dyn = createDynamicCreature(speciesId, mopts);
          container.remove(baked!.object);
          container.add(dyn.object);
        }
        if (g && g.id !== lastGestureId) {
          // Consumed even at the stick tier (which has no animator to drive),
          // so a held gesture is not re-tested every frame; the body walks on.
          lastGestureId = g.id;
          if (poseable) {
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
        }
        if (dyn) {
          // ONTO THE FURNITURE: the renderer resolved the fixture the activity
          // names (frame.activityAnchor — its top center + its heading): the BED
          // a sleeper lies on, the CHAIR or TOILET a sitter takes. Slide the body
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
          // snapping between it and the sim body. Drive the dissolve off the
          // animator's SMOOTHED speed (speedLevel), not the raw sim velocity: a
          // body that stands to walk off spikes its sim speed in one frame, which
          // — read raw — would zero the slide and TELEPORT it off the seat before
          // the pose eased out. The eased dial ramps with the gait, so the body
          // slides off in step with standing up ("ease out, then walk").
          const lie = anchorSlideLevel(posed, dyn.animator.speedLevel());
          const at = latchAnchor(anchor, lie);
          if (at) {
            // A SITTER's anchor names the seat SURFACE; the body's origin is its
            // FEET, so parking the origin there floats it a hip-height above the
            // seat. Drop it by the crouched torso underside (seatDropWorld) so the
            // body rests ON the seat with its feet hanging toward the floor. The
            // drop rides the SAME `lie` slide as the rest of the move (and clamps
            // at the floor while the crouch is still blending in), so it eases on
            // and off exactly like the slide — never a snap or a sink. Sleep keeps
            // its own recline re-centering and takes no drop.
            // The DROP is selected by the anchor's CONTACT part (the use-point
            // contract), not the activity name: only a "pelvis" contact (a
            // seat/toilet) drops the crouched hip underside onto the surface. A
            // "torso" bed re-centres via its recline (no drop); a "reach" never
            // anchors here. Falls back to the old activity test for a legacy
            // anchor with no contact set.
            const drops = at.contact ? at.contact === "pelvis" : drive.activity === "sit";
            const sitDrop = drops ? dyn.seatDropWorld : 0;
            const localY = Math.max(0, at.y - sitDrop - container.position.y);
            dyn.object.position.set(
              (at.x - container.position.x) * lie,
              localY * lie,
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
