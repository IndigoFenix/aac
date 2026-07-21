// shared/world-engine/render3d.ts
//
// A Three.js view of the world engine — the 3D counterpart to render2d.ts. It
// consumes the SAME headless WorldState (positions are 2D ground coords) and the
// SAME control contract (pointer → world ground point → avatar "arrive" steering),
// so switching 2D↔3D changes only how the world LOOKS, never how it plays.
//
// Controls follow the seagull-dream WALKING feel, minus flight: a camera tilted
// down over the player's shoulder; aiming further from the avatar walks it
// faster, aiming near it stops. Unlike the seagull chase rig the camera keeps a
// FIXED world heading (it follows position but never rotates with the avatar) —
// the avatar turns constantly to face wherever the gaze rests, and a rotating
// world under an eye-gaze cursor would be unusable. The aim mapping therefore
// stays stable: a screen pixel always means the same ground point.
//
// Avatar models are pluggable (`AvatarModelFactory`) so the creature-builder can
// drop richer bodies in later; the built-in `defaultAvatarModelFactory` is a
// deliberately simple capsule with a billboarded face disc.
//
// DOM/WebGL-typed: like render2d.ts this is NOT re-exported from index.js so the
// headless server never pulls it in.

import * as THREE from "three";
import type { BuildingSpec, Rect, RoadPath, StructureSpec, Vec2, WorldSpec } from "./types.js";
import {
  accessibleBuildings,
  buildingAt,
  visibleBuildings,
  type AvatarState,
  type GroundSampler,
  type WorldState,
} from "./engine.js";
import type { RenderIntent, ScreenPick, WorldView, WorldViewDeps } from "./world-view.js";
import { bubbleAlpha, imageAspect, layoutBubble, paintBubble, type GlyphImage } from "./speech-bubble.js";
import { BED_TOP_FRAC, SEAT_TOP_FRAC, buildObjectModel, TABLE_TOP_Y, type ObjectModel } from "./object-models.js";
import {
  getShadingMode, propMaterial, roadMaterial, structureMaterial, terrainMaterial, type LitMaterial,
} from "./materials.js";
import {
  DEFAULT_CAMERA_TUNABLES,
  DEFAULT_COMFORT_TUNABLES,
  type CameraRigPose,
  type CameraTunables,
  type ComfortTunables,
} from "./world-tunables.js";

// ---------------------------------------------------------------------------
// Tunables. The camera rig + comfort knobs now live in world-tunables.ts (so the
// debug menu can push them live and the future settings system can serialise
// them); only the placeholder avatar model's geometry stays a local constant.
// World units; the ground plane is XZ with +Y up. A world point (x, y) maps to
// the 3D point (x, 0, y).
// ---------------------------------------------------------------------------

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Shared white, for lightening tints toward white-hot (never mutate). */
const WHITE = new THREE.Color(0xffffff);

const MODEL = {
  bodyRadius: 0.45,
  /** Cylinder length of the capsule (total height = length + 2·radius = 1.8 m). */
  bodyLength: 0.9,
  /** The face disc sits ON the capsule's head region (not floated above it), so
   *  the whole figure keeps a realistic ~1.8 m human height. */
  faceY: 1.5,
  faceRadius: 0.34,
} as const;

const BACKDROP = "#0f172a";

// Roads. Painted as flat opaque ribbons sitting a hair ABOVE the field (so they
// never z-fight the ground) in ONE uniform colour — the 2D map's packed-earth
// tan. A single colour is deliberate: overlapping ribbons (a junction, a
// crossing) then paint the SAME pixel colour, so the overlap is invisible
// instead of doubling up the way the semi-transparent 2D lanes do.
const ROAD_COLOR = "#c9b487";
/** World-Y the road ribbons sit at — above the grid (0.01), below the border
 *  (0.03), so they read as paint on the field without fighting its depth. */
const ROAD_Y = 0.02;

// Structure geometry. World units are METERS — the default avatar is a 1.8 m
// capsule, so buildings use real-house dimensions: 3 m storeys (walls reach the
// slab/roof above them; keep wallHeight == FLOOR_HEIGHT) and 2.1 m door leaves
// with a wall lintel filling the rest of the doorway. A door's leaf swings up
// to DOOR_SWING radians about its hinge as it opens.
const STRUCTURE = {
  wallHeight: 3.0,
  doorHeight: 2.1,
  wallColor: 0x9ca3af,
  doorColor: 0xb45309,
  doorLockedColor: 0x7c2d12,
  // Dollhouse cutaway cues (shown where a wall's tall body fades away):
  ridgeHeight: 0.2, // the low floor footing left in a cut wall's place
  stubHeight: 1.5, // the diagonal corner stub's tall end (at a standing wall)
  stubRun: 0.7, // horizontal length over which the stub tapers to the ridge
} as const;
const DOOR_SWING = Math.PI * 0.55;

/** World height of one storey (meters) — the renderer lifts a body/object on
 *  floor `f` by `f * FLOOR_HEIGHT`. Purely a render constant (the engine keeps
 *  floor unitless). */
export const FLOOR_HEIGHT = 3.0;

// ── GAME ANGLE → THREE YAW: the one conversion, named ────────────────────────
//    `facing` (kernel/town/placement.ts, furniture.ts) is a GAME angle:
//    atan2 over game x/y, pointing where the piece's FRONT looks. The renderer
//    lays game y onto THREE +z (positively — see syncObjects' position.set), so
//    a THREE yaw of θ aims a +X-forward recipe (object-models.ts: "forward (+X)
//    faces INTO the room") at game angle −θ. The axes are MIRRORED, hence the
//    negation. Assigning `facing` raw is the bug this replaced: invisible at
//    facing ≈ 0 or ±π, a full 180° at ±π/2 — chairs backed onto their table,
//    cupboards and privies nosed into the wall they stand against.

/** THREE yaw that aims a +X-forward fixture recipe at game angle `facing`. */
export function fixtureYaw(facing: number | undefined): number {
  return -(facing ?? 0);
}

/** THREE yaw that turns a CREATURE rig's forward onto game angle `a`. The rig
 *  faces its local +Z (creature-model.ts facingYaw), which under a yaw of ψ
 *  looks at game angle π/2 − ψ — so ψ = π/2 − a. Same mirror as `fixtureYaw`,
 *  a quarter-turn apart because the rig's forward axis is +Z and a fixture
 *  recipe's is +X. */
export function rigYawTo(a: number): number {
  return Math.PI / 2 - a;
}

/** THREE yaw laying a creature rig on a bed of game angle `facing`, head on the
 *  pillow. The bed recipe is long in local X with the pillow at the −X end, so
 *  under `fixtureYaw` the pillow points at game angle `facing + π` — the rig's
 *  head is its local −Z (opposite its forward), so pointing the rig's FORWARD
 *  at `facing` (down the bed, toward the foot) lands the head on the pillow.
 *  Paired with `fixtureYaw` BY CONSTRUCTION — flip one and the head leaves the
 *  pillow (the old raw-facing pair was self-consistent while both were mirrored,
 *  which is exactly why the mirror survived so long). */
export function bedSleeperYaw(facing: number | undefined): number {
  return rigYawTo(facing ?? 0);
}

/** THREE yaw seating a creature rig on a chair/privy of game angle `facing`.
 *  A seat's front IS where its occupant looks, so the rig's forward simply
 *  takes the fixture's own facing — a chair at its table faces the table, and
 *  the sitter with it. */
export function sitterYaw(facing: number | undefined): number {
  return rigYawTo(facing ?? 0);
}

// ── The DOLLHOUSE rig, as pure math (the spirit branch of updateCamera and
//    the public dollhousePose both call these — one formula, provably) ──────

export interface DollhouseBounds {
  cx: number;
  cz: number;
  span: number;
}

/** Span (world units, pre-×1.2) framed around the FOCUS body when there is
 *  neither a frame nor any building — open ground. A manifold-sized frame out
 *  in the wild parks the camera hundreds of metres up; a body-scale window is
 *  what "look at the ground here" means. */
export const DOLLHOUSE_OPEN_GROUND_SPAN = 30;

/** The framed centre + span: an explicit frame beats the building scan
 *  (a streamed town's building bounds are the whole town), which beats a
 *  body-scale window at `focus` (open ground — wilderness, an unbuilt chunk),
 *  which beats the bare manifold (no focus to frame: legacy standalone). */
export function resolveDollhouseBounds(
  frame: { x: number; y: number; w: number; h: number } | null,
  buildings: readonly { footprint: { x: number; y: number; w: number; h: number } }[],
  manifoldW: number,
  manifoldH: number,
  focus?: { x: number; y: number } | null,
): DollhouseBounds {
  let minX = 0;
  let minZ = 0;
  let maxX = manifoldW;
  let maxZ = manifoldH;
  if (frame) {
    minX = frame.x;
    minZ = frame.y;
    maxX = frame.x + frame.w;
    maxZ = frame.y + frame.h;
  } else if (!buildings.length && focus) {
    const r = DOLLHOUSE_OPEN_GROUND_SPAN / 2;
    minX = focus.x - r;
    minZ = focus.y - r;
    maxX = focus.x + r;
    maxZ = focus.y + r;
  } else if (buildings.length) {
    minX = Infinity;
    minZ = Infinity;
    maxX = -Infinity;
    maxZ = -Infinity;
    for (const b of buildings) {
      const f = b.footprint;
      minX = Math.min(minX, f.x);
      minZ = Math.min(minZ, f.y);
      maxX = Math.max(maxX, f.x + f.w);
      maxZ = Math.max(maxZ, f.y + f.h);
    }
  }
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, span: Math.max(maxX - minX, maxZ - minZ) * 1.2 };
}

/** Gaze terrain-march tuning (screenToWorld / marchGroundHit). */
const GAZE_GROUND_EPS = 0.05;
const GAZE_GROUND_STEP = 4;
const GAZE_GROUND_MAX = 600;
const GAZE_GROUND_ITERS = 18;

export const DOLLHOUSE_FOV = 40;
const DOLLHOUSE_PITCH = 0.5; // ~29° below horizontal — the low dollhouse angle

/** The dollhouse pose in MANIFOLD-LOCAL coordinates: a fixed low 3/4 angle
 *  framing the bounds at azimuth `PI/2 + spiritAz`, look-point at the
 *  framed centre riding the ground (`gy`). */
export function dollhousePoseMath(
  bounds: DollhouseBounds,
  gy: number,
  spiritAz: number,
  out: { pos: THREE.Vector3; look: THREE.Vector3; up: THREE.Vector3; fov: number },
): void {
  const lookY = FLOOR_HEIGHT * 0.55;
  const az = Math.PI / 2 + spiritAz; // default camera on the +Z "front" side
  const dist = bounds.span / (2 * Math.tan((DOLLHOUSE_FOV * Math.PI) / 180 / 2));
  const horiz = dist * Math.cos(DOLLHOUSE_PITCH);
  out.pos.set(
    bounds.cx + Math.cos(az) * horiz,
    dist * Math.sin(DOLLHOUSE_PITCH) + lookY + gy,
    bounds.cz + Math.sin(az) * horiz,
  );
  out.look.set(bounds.cx, lookY + gy, bounds.cz);
  out.up.set(0, 1, 0);
  out.fov = DOLLHOUSE_FOV;
}
/** Ray-depth (world units) within which a picked OBJECT is treated as "at the same
 *  spot" as a creature and wins the pick — item-priority for co-located entities. */
const PICK_ITEM_MARGIN = 1.5;
/** Opacity a faded-out plane settles at (roof/slab/storey wall/object of the
 *  OCCUPIED building sitting between the occupant and the camera). */
const FADE_OPACITY = 0.07;
/** At/above this roof opacity the building reads as SEALED (fully opaque). Below
 *  it the see-inside fade is active — transparent or still easing — so the
 *  interior is on show. `fadeToward` snaps a sealing roof to exactly 1, so any
 *  value < 1 is unambiguously "opening/open". */
const ROOF_SEALED_OPACITY = 0.999;
/** Ease rate (1/s) of the see-inside fade — clears the view in ~a third of a
 *  second but still reads as a fade, never a pop. */
const FADE_RATE = 9;
/** A plane starts fading a little BEFORE the camera actually rises past it, so
 *  the reveal leads the camera instead of trailing it. */
const CAM_FADE_MARGIN = 0.4;

/** Sprite height (world units) of an object's icon — both sprite factories
 *  below scale to this. */
const ICON_SPRITE_H = 1.3;

/** Local Y for a model-less object's icon so the symbol STANDS on the ground
 *  (its bottom edge at the object's floor) instead of hovering over an absent
 *  body — the object's mesh origin sits `radius` above the floor. */
function iconStandY(radius: number): number {
  return ICON_SPRITE_H / 2 - radius;
}

/** A billboarded emoji sprite floated over a world object (an `ObjectSpec.iconRef`)
 *  so carryable props read as what they ARE. OffscreenCanvas so it builds in the
 *  render worker. Caller positions the sprite and disposes tex+mat. */
function makeEmojiSprite(emoji: string): { sprite: THREE.Sprite; tex: THREE.CanvasTexture; mat: THREE.SpriteMaterial } {
  const SIZE = 128;
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const c = canvas.getContext("2d");
  if (c) {
    c.clearRect(0, 0, SIZE, SIZE);
    c.font = "96px sans-serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(emoji, SIZE / 2, SIZE / 2 + 6);
  }
  const tex = new THREE.CanvasTexture(canvas as unknown as HTMLCanvasElement);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(ICON_SPRITE_H, ICON_SPRITE_H, ICON_SPRITE_H);
  return { sprite, tex, mat };
}

/** A billboarded sprite from a PRE-COMPOSED glyph image (`ObjectSpec.glyph`,
 *  resolved by the game's glyphFor) — variant items (ball.big vs ball.small)
 *  must read as their composed glyph, which a shared emoji can't show. */
function makeGlyphIconSprite(img: GlyphImage): { sprite: THREE.Sprite; tex: THREE.CanvasTexture; mat: THREE.SpriteMaterial } {
  const H = 128;
  const aspect = Math.min(imageAspect(img) || 1, 2);
  const W = Math.max(1, Math.round(H * aspect));
  const canvas = new OffscreenCanvas(W, H);
  const c = canvas.getContext("2d");
  if (c) c.drawImage(img, 0, 0, W, H);
  const tex = new THREE.CanvasTexture(canvas as unknown as HTMLCanvasElement);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(ICON_SPRITE_H * aspect, ICON_SPRITE_H, 1);
  return { sprite, tex, mat };
}

/**
 * The see-inside context: the set of building ids whose interior is currently
 * revealed to the local player (visibleBuildings — the room they stand in plus
 * every room reachable through an open door), the storey they stand on, and how
 * high the camera sits. Null when there's no local avatar. An empty `visible`
 * set ⇒ outdoors with nothing open nearby — nothing fades.
 */
interface FadeContext {
  visible: Set<string>;
  floor: number;
  camY: number;
}

/** Does a revealed building's horizontal plane at `planeY` block the camera's
 *  view inside? It must lie above the occupant's storey AND at/below the camera
 *  — a ceiling the camera hasn't risen past yet hides nothing. */
function planeBlocks(fade: FadeContext, planeY: number): boolean {
  return planeY > fade.floor * FLOOR_HEIGHT + 0.1 && fade.camY > planeY - CAM_FADE_MARGIN;
}

/** Do the 2D segments p1→p2 and p3→p4 cross (proper or on-boundary)? */
function segmentsCross(
  p1x: number, p1z: number, p2x: number, p2z: number,
  p3x: number, p3z: number, p4x: number, p4z: number,
): boolean {
  const side = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) =>
    (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d1 = side(p3x, p3z, p4x, p4z, p1x, p1z);
  const d2 = side(p3x, p3z, p4x, p4z, p2x, p2z);
  const d3 = side(p1x, p1z, p2x, p2z, p3x, p3z);
  const d4 = side(p1x, p1z, p2x, p2z, p4x, p4z);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** Does the horizontal segment (ax,az)→(bx,bz) enter the axis-aligned rect —
 *  either endpoint inside, or it crosses an edge? (Camera→player line of sight
 *  passing through a room's footprint.) */
function segmentEntersRect(ax: number, az: number, bx: number, bz: number, r: Rect): boolean {
  const inside = (x: number, z: number) => x >= r.x && x <= r.x + r.w && z >= r.y && z <= r.y + r.h;
  if (inside(ax, az) || inside(bx, bz)) return true;
  const x0 = r.x, z0 = r.y, x1 = r.x + r.w, z1 = r.y + r.h;
  return (
    segmentsCross(ax, az, bx, bz, x0, z0, x1, z0) ||
    segmentsCross(ax, az, bx, bz, x1, z0, x1, z1) ||
    segmentsCross(ax, az, bx, bz, x1, z1, x0, z1) ||
    segmentsCross(ax, az, bx, bz, x0, z1, x0, z0)
  );
}

/** EASE an element toward faded (near-transparent, no depth write, so it stops
 *  occluding what's behind it) or back to opaque. Depth write flips early
 *  (~0.6) so a half-faded roof already reveals the room. */
function fadeToward(
  mat: THREE.Material & { opacity: number },
  faded: boolean,
  dt: number,
): void {
  const target = faded ? FADE_OPACITY : 1;
  if (mat.opacity !== target) {
    const k = 1 - Math.exp(-FADE_RATE * Math.max(0, dt));
    const next = mat.opacity + (target - mat.opacity) * k;
    mat.opacity = Math.abs(next - target) < 0.004 ? target : next;
  }
  mat.transparent = mat.opacity < 0.999;
  mat.depthWrite = mat.opacity > 0.6;
}

// Speech-bubble placement/scale. The bubble floats above the speaker in SCREEN
// space (offset along the camera's up vector from the head anchor) so it never
// covers the speaker — physical +Y offsets project onto the speaker under the
// steep overhead camera. Its pixel texture maps to world units by pxPerWorld.
const BUBBLE = {
  headY: 2.0,        // world Y of the head anchor the screen-up offset starts from
  clearance: 0.9,    // gap (world units, along screen-up) between head and bubble edge
  pxPerWorld: 64,
  texDpr: 2,         // oversample the texture so text stays crisp
  tailPx: 12,        // extra texture height for the downward tail
} as const;

/**
 * One avatar's speech bubble: a billboarded sprite whose texture is the shared
 * 2D bubble drawing. Re-rasterised only when the utterance (or its decoded glyph
 * count) changes; opacity + position are updated cheaply each frame.
 */
class Bubble3D {
  readonly sprite: THREE.Sprite;
  private readonly canvas = new OffscreenCanvas(8, 8);
  private tex: THREE.CanvasTexture;
  private key = "";
  private worldW = 1;
  private worldH = 1;

  constructor() {
    this.tex = new THREE.CanvasTexture(this.canvas as unknown as HTMLCanvasElement);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.renderOrder = 20; // over avatars/toys
  }

  /** Redraw the texture only when the content key changes (text + said-time +
   *  how many glyph images are available, which grows as they decode in). */
  setContent(text: string, at: number, glyphImages: GlyphImage[], variant: "speech" | "thought" = "speech"): void {
    const key = `${at}|${glyphImages.length}|${variant}|${text}`;
    if (key === this.key) return;
    this.key = key;
    const measureCtx = this.canvas.getContext("2d") as unknown as CanvasRenderingContext2D | null;
    if (!measureCtx) return;
    const aspect = glyphImages[0] ? imageAspect(glyphImages[0]) : 0;
    const layout = layoutBubble(measureCtx, text, aspect);
    const texW = layout.width;
    const texH = layout.height + BUBBLE.tailPx;
    const cw = Math.max(1, Math.round(texW * BUBBLE.texDpr));
    const ch = Math.max(1, Math.round(texH * BUBBLE.texDpr));
    // The bubble starts text-only and grows when its glyph image decodes in (async,
    // a frame or more later). THREE does NOT reallocate a CanvasTexture's GPU storage
    // when its source canvas changes SIZE — it keeps the old dimensions and the sprite
    // shows the stale content stretched to the new scale. So on a size change we throw
    // the texture away and make a fresh one; only an in-place repaint reuses it.
    const sizeChanged = cw !== this.canvas.width || ch !== this.canvas.height;
    this.canvas.width = cw;
    this.canvas.height = ch;
    const ctx = this.canvas.getContext("2d") as unknown as CanvasRenderingContext2D | null;
    if (!ctx) return;
    ctx.setTransform(BUBBLE.texDpr, 0, 0, BUBBLE.texDpr, 0, 0);
    ctx.clearRect(0, 0, texW, texH);
    paintBubble(ctx, layout, glyphImages, 1, variant);
    if (sizeChanged) {
      this.tex.dispose();
      this.tex = new THREE.CanvasTexture(this.canvas as unknown as HTMLCanvasElement);
      this.tex.colorSpace = THREE.SRGBColorSpace;
      const mat = this.sprite.material as THREE.SpriteMaterial;
      mat.map = this.tex;
      mat.needsUpdate = true;
    } else {
      this.tex.needsUpdate = true;
    }
    this.worldW = texW / BUBBLE.pxPerWorld;
    this.worldH = texH / BUBBLE.pxPerWorld;
    this.sprite.scale.set(this.worldW, this.worldH, 1);
  }

  /** Place above the speaker in SCREEN space: anchor at the head over (cx,cz)
   *  (lifted by `yOffset`, the anchor's storey elevation), then offset along
   *  `up` — the camera's up vector, i.e. screen-up — so the bubble reads above
   *  the speaker from every rig pose (a physical +Y offset sits ON the speaker
   *  under the near-top-down overhead camera). Fade with `alpha`. */
  place(cx: number, cz: number, alpha: number, yOffset: number, up: THREE.Vector3): void {
    const lift = BUBBLE.clearance + this.worldH / 2;
    this.sprite.position.set(
      cx + up.x * lift,
      BUBBLE.headY + yOffset + up.y * lift,
      cz + up.z * lift,
    );
    (this.sprite.material as THREE.SpriteMaterial).opacity = alpha;
  }

  dispose(): void {
    this.tex.dispose();
    (this.sprite.material as THREE.SpriteMaterial).dispose();
  }
}

// ---------------------------------------------------------------------------
// Pure math (no DOM/GL) — unit-testable.
// ---------------------------------------------------------------------------

/** Stable hue from a participant id (FNV-1a), as a THREE colour. Matches the 2D
 *  renderer's palette so a participant is the same colour in both views. */
export function colorForId(id: string): THREE.Color {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h = (h ^ id.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return new THREE.Color().setHSL((h % 360) / 360, 0.6, 0.55);
}

// --- Irregular ground (state.ground) -----------------------------------------
// The sim is plan-view 2D; a world's optional GroundSampler affects VERTICAL
// placement only. Everything below adds a per-entity lift on top of the storey
// lift (floor × FLOOR_HEIGHT); no sampler ⇒ every lift is 0 (flat, unchanged).

/** Ground height a BUILDING sits at: sampled ONCE at its footprint center, so
 *  the whole shell (walls, doors, slabs, roof) shares one base and walls stay
 *  vertical on a sloped site. */
export function buildingBaseY(ground: GroundSampler | undefined, footprint: Rect): number {
  return ground?.(footprint.x + footprint.w / 2, footprint.y + footprint.h / 2) ?? 0;
}

/** Ground height a BODY/OBJECT stands at: its building's (flat) base when the
 *  point is inside one — interior floors don't follow the terrain — else the
 *  terrain under it. 0 when the world has no sampler. */
export function standHeightAt(state: WorldState, x: number, y: number): number {
  if (!state.ground) return 0;
  const b = buildingAt(state, x, y);
  return b ? buildingBaseY(state.ground, b.footprint) : state.ground(x, y);
}

/**
 * Cast a ray from a normalized device coord (x,y ∈ [-1,1]) through `camera` and
 * intersect the ground plane (Y=0), returning the world ground point (x, z)→Vec2,
 * or null if the ray runs parallel to / away from the ground. The control-mapping
 * core of the 3D view; pure THREE math, so it runs headless in tests.
 */
export function screenRayToGround(
  camera: THREE.Camera,
  ndcX: number,
  ndcY: number,
  raycaster: THREE.Raycaster = new THREE.Raycaster(),
  plane: THREE.Plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
  out: THREE.Vector3 = new THREE.Vector3(),
): Vec2 | null {
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  const hit = raycaster.ray.intersectPlane(plane, out);
  if (!hit) return null;
  return { x: hit.x, y: hit.z };
}

/**
 * Flat ground ribbon for a road: the centerline `points` (world coords) swept to
 * `width`, laid in the XZ plane at y=ROAD_Y. Pure geometry (no GL state), so it's
 * unit-testable headless. Joins are MITERED — each vertex offsets along the
 * average of its two adjacent segment normals, scaled by 1/cos(half-angle) and
 * clamped — so the ribbon keeps constant width around the gentle street bends
 * without gaps or overlap seams inside one road. <2 distinct points ⇒ empty
 * geometry (nothing to draw). All normals point +Y; the caller uses a
 * double-sided material, so winding is irrelevant. `ground` lifts each
 * centerline vertex to its terrain height (both edge vertices share it, so the
 * ribbon banks along the path but stays flat across its width).
 */
export function buildRoadRibbon(
  points: Vec2[],
  width: number,
  ground?: GroundSampler,
): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  // Drop consecutive duplicates — a zero-length segment has no normal.
  const pts: Vec2[] = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) pts.push(p);
  }
  if (pts.length < 2 || width <= 0) return geom;

  const half = width / 2;
  // Unit normal (in XZ) of the segment a→b, left-hand side.
  const segN = (a: Vec2, b: Vec2): { x: number; z: number } => {
    const dx = b.x - a.x;
    const dz = b.y - a.y;
    const l = Math.hypot(dx, dz) || 1;
    return { x: -dz / l, z: dx / l };
  };

  const positions: number[] = [];
  const normals: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    let nx: number;
    let nz: number;
    let scale = 1;
    if (i === 0) {
      const n = segN(pts[0], pts[1]);
      nx = n.x;
      nz = n.z;
    } else if (i === pts.length - 1) {
      const n = segN(pts[i - 1], pts[i]);
      nx = n.x;
      nz = n.z;
    } else {
      const n1 = segN(pts[i - 1], pts[i]);
      const n2 = segN(pts[i], pts[i + 1]);
      let mx = n1.x + n2.x;
      let mz = n1.z + n2.z;
      const ml = Math.hypot(mx, mz);
      if (ml < 1e-4) {
        // A ~180° switchback — fall back to the outgoing normal (no miter).
        nx = n2.x;
        nz = n2.z;
      } else {
        mx /= ml;
        mz /= ml;
        // 1/cos(half-angle) keeps the offset edge parallel; clamp the spike on a
        // sharp corner so a hairpin can't shoot the ribbon out to infinity.
        scale = Math.min(3, 1 / Math.max(0.34, mx * n2.x + mz * n2.z));
        nx = mx;
        nz = mz;
      }
    }
    const ox = nx * half * scale;
    const oz = nz * half * scale;
    const gy = ROAD_Y + (ground?.(pts[i].x, pts[i].y) ?? 0);
    // Left then right vertex for this centerline point.
    positions.push(pts[i].x + ox, gy, pts[i].y + oz);
    positions.push(pts[i].x - ox, gy, pts[i].y - oz);
    normals.push(0, 1, 0, 0, 1, 0);
  }

  const index: number[] = [];
  for (let s = 0; s < pts.length - 1; s++) {
    const a = 2 * s; // left  @ s
    const b = 2 * s + 1; // right @ s
    const c = 2 * s + 2; // left  @ s+1
    const d = 2 * s + 3; // right @ s+1
    index.push(a, c, b, b, c, d);
  }

  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geom.setIndex(index);
  return geom;
}

/** Soft, NEUTRAL-WHITE radial glow for the gaze spark and its embers. Kept white
 *  so the user-specific tint can be applied per-material via `material.color`
 *  (additive blending multiplies the texture by the color). OffscreenCanvas so it
 *  builds in the render worker. */
function makeSparkTexture(): THREE.CanvasTexture {
  const S = 64;
  const canvas = new OffscreenCanvas(S, S);
  const c = canvas.getContext("2d");
  if (c) {
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.85)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);
  }
  const tex = new THREE.CanvasTexture(canvas as unknown as HTMLCanvasElement);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The GAZE SPARK — the player's cursor reimagined as a tiny glowing ball that
 * marks the effective gaze point (the same `aim` the engine steers toward) and,
 * when the gaze rests on a creature or object, hovers over that target. Purely
 * cosmetic: it reflects intent the engine already computed and never feeds back
 * into the simulation.
 *
 * Visual model (this population is motion/flicker-sensitive — see
 * [[project_seizure_recognition]]):
 *   • A small BRIGHT CORE at CONSTANT brightness — it never gets noticeably
 *     brighter (the 3–20 Hz brightness band is a discomfort/photosensitivity
 *     trigger). It only changes SIZE.
 *   • A slightly larger, DIM HALO of fixed size/brightness around the core.
 *   • On a rapid gaze jump (saccade) or a hop onto a new hover target, it PAUSES,
 *     the core shrinks to nothing, DARTS to the new spot leaving glowing embers in
 *     its wake, then quickly grows back to full size. Between darts it just holds
 *     position (gently tracking small drift), so it never streaks across the field.
 *     The dart's vertical trajectory is SHAPED by the transition (see `SparkArc`):
 *       – onto a hover target: dip slightly, curve up, lightly touch down;
 *       – hover→hover: bounce (fly up, curve down onto the point);
 *       – off a hover target: the "onto" arc in reverse (up, dip below, float up).
 *   • While hovering an object/creature it lights a small point light on the target
 *     to illuminate what's focused; the light is OFF while moving (never sweeps).
 *   • Every element (core, halo, embers, light) carries a single user-specific TINT.
 */
const SPARK = {
  /** Presence fade in/out rate. */
  fadeK: 8,
  /** Gentle position tracking (per-second lerp rate) while holding — absorbs small
   *  gaze drift without a dart. */
  followK: 26,
  /** Base world-scale of the bright core (at full size). */
  coreBase: 0.36,
  /** CONSTANT core brightness — never blooms. */
  coreOpacity: 0.95,
  /** Fractional extra core size at full dwell-to-select (size, not brightness). */
  selectGrow: 0.5,
  /** Fixed size + brightness of the surrounding dim halo. */
  haloScale: 0.9,
  haloOpacity: 0.22,
  /** Squared world distance a new target must jump to trigger a dart. */
  dartThresh2: 0.5 * 0.5,
  /** Seconds to shrink the core to nothing before darting. */
  shrinkTime: 0.07,
  /** Seconds to grow the core back to full after arriving. */
  growTime: 0.13,
  /** Seconds to fly the arc from the old spot to the new one. */
  dartDur: 0.28,
  /** Main upward-arc amplitude (world units) at reference distance. */
  arcRise: 0.5,
  /** Small dip/undershoot amplitude (world units) at reference distance. */
  arcDip: 0.13,
  /** Distance at which the arc reaches full amplitude (shorter hops arc less). */
  arcRefDist: 1.6,
  /** Seconds between ember spawns while darting. */
  emberInterval: 0.02,
  /** Ember lifetime (seconds) — a few frames, floating down then gone. */
  emberLife: 0.36,
  emberOpacity: 0.85,
  emberScale: 0.18,
  /** Downward acceleration on embers so they settle as they fade. */
  emberGravity: 2.4,
  /** SLIPSTREAM (see `setDrift`). Seconds between stream-ember spawns — slower
   *  than a dart's, so the two can run at once inside the pool. */
  streamInterval: 0.03,
  /** Drift speed (group units/sec) below which no stream embers spawn at all:
   *  a resting spark must not fizz. */
  streamMin: 0.4,
  /** Stream-ember lifetime — shorter than a dart ember's, so the streak reads
   *  as a taut line rather than a lingering cloud. */
  streamLife: 0.28,
  /** Sideways scatter given to a stream ember, as a fraction of drift speed.
   *  Small: the DIRECTION is the whole signal. */
  streamSpread: 0.12,
  /** Point-light intensity while resting on a hovered object (0 while moving).
   *  Deliberately faint: it should say "this is what you are dwelling on",
   *  not floodlight the thing. */
  hoverLight: 0.45,
  /** Reach of the hover light. */
  hoverLightDist: 2.8,
  /** Ease rate for the hover light fading in/out. */
  lightK: 9,
  /** Default tint (warm gold). Swapped per-user later via `setTint`. */
  tint: 0xffd27a,
} as const;

/** Smoothstep ease (accelerate then decelerate onto the target). */
const easeInOut = (t: number): number => t * t * (3 - 2 * t);

/** Clearance between a hovered object's top and the spark resting over it. */
const SPARK_HOVER_GAP = 0.35;

const _topBox = new THREE.Box3();
const _topPart = new THREE.Box3();
const _topInv = new THREE.Matrix4();
const _topM = new THREE.Matrix4();

/** How tall `root`'s visible shell stands above its OWN origin, in its own
 *  local frame. Unions the geometry bounding boxes rather than
 *  `Box3.setFromObject`, which reports WORLD space — on a spinning planet that
 *  answer is in the wrong frame (and its `max.y` is not even "up" locally).
 *  Frame-independent by construction, so the planet's orientation never
 *  enters. Falls back to a sane hover for a shell-less object. */
export function localTopY(root: THREE.Object3D, fallback: number): number {
  root.updateWorldMatrix(false, true);
  _topInv.copy(root.matrixWorld).invert();
  _topBox.makeEmpty();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    const gb = m.geometry.boundingBox;
    if (!gb) return;
    _topPart.copy(gb).applyMatrix4(_topM.multiplyMatrices(_topInv, m.matrixWorld));
    _topBox.union(_topPart);
  });
  return _topBox.isEmpty() || !Number.isFinite(_topBox.max.y) ? fallback : _topBox.max.y;
}

/** The "land" arc for the gaze spark, as a vertical offset over q∈[0,1]:
 *  a small early DIP, then a big arc that TOUCHES DOWN (returns to 0) at q=1.
 *  Reversed in time (q→1-q) it becomes the "lift" arc. Zero at both ends. */
function sparkLandCurve(q: number, rise: number, dip: number): number {
  if (q <= 0 || q >= 1) return 0;
  if (q < 0.25) return -dip * Math.sin((Math.PI * q) / 0.25);
  return rise * Math.sin((Math.PI * (q - 0.25)) / 0.75);
}

interface SparkEmber {
  readonly sprite: THREE.Sprite;
  readonly mat: THREE.SpriteMaterial;
  readonly pos: THREE.Vector3;
  readonly vel: THREE.Vector3;
  life: number;
  /** Total lifetime this ember was spawned with — darts and the slipstream use
   *  different spans, and the fade is `life / span`. */
  span: number;
  /** A SLIPSTREAM ember (see `setDrift`): it carries the apparent motion of the
   *  world, so gravity must not bend it — the direction IS the signal. */
  stream: boolean;
}

type SparkPhase = "idle" | "shrink" | "dart" | "grow";
/** Vertical shape of a dart, chosen from the hover-state transition. */
type SparkArc = "land" | "lift" | "bounce" | "hop";

export class GazeSpark {
  readonly group = new THREE.Group();
  private readonly coreSprite: THREE.Sprite;
  private readonly haloSprite: THREE.Sprite;
  private readonly coreMat: THREE.SpriteMaterial;
  private readonly haloMat: THREE.SpriteMaterial;
  private readonly light: THREE.PointLight;
  private readonly tex: THREE.CanvasTexture;
  private readonly embers: SparkEmber[] = [];
  private emberCursor = 0;
  private emberTimer = 0;
  /** Apparent velocity of the world past the spark, in GROUP units/sec — the
   *  slipstream (see `setDrift`). Zero = still. */
  private readonly drift = new THREE.Vector3();
  private streamTimer = 0;
  private readonly pos = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly dartFrom = new THREE.Vector3();
  private readonly tint = new THREE.Color(SPARK.tint);
  private shown = false;
  /** Whether the current target is a hovered object/creature (vs a ground point). */
  private hovering = false;
  /** Eased presence 0..1 — fades the spark in/out as the gaze appears/leaves. */
  private amp = 0;
  /** Eased 0..1 hover-light level (rises only once resting on a hovered target). */
  private lightAmp = 0;
  /** 0..1 core-size factor: 1 at full size, 0 mid-dart while the core is gone. */
  private core = 1;
  /** Dart state machine. */
  private phase: SparkPhase = "idle";
  /** Seconds elapsed in the current shrink/grow phase. */
  private phaseT = 0;
  /** Seconds elapsed into the current dart (drives the arc). */
  private dartT = 0;
  /** Vertical shape + amplitude of the current dart. */
  private arc: SparkArc = "hop";
  private arcAmp = 1;
  /** 0..1 dwell-to-SELECT progress fed from the game (carry pick/place, converse
   *  dwell). GROWS the core (size only, never brighter) so it reads as the
   *  selection indicator over the very item being chosen. */
  private select = 0;

  constructor() {
    this.tex = makeSparkTexture();
    this.coreMat = new THREE.SpriteMaterial({
      map: this.tex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    this.haloMat = new THREE.SpriteMaterial({
      map: this.tex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    this.coreSprite = new THREE.Sprite(this.coreMat);
    this.coreSprite.renderOrder = 19;
    this.haloSprite = new THREE.Sprite(this.haloMat);
    this.haloSprite.renderOrder = 17;
    this.haloSprite.scale.setScalar(SPARK.haloScale);
    // Illuminates the object under the gaze while resting on it (off while moving).
    this.light = new THREE.PointLight(SPARK.tint, 0, SPARK.hoverLightDist, 2);
    this.group.add(this.haloSprite, this.coreSprite, this.light);

    // Pre-allocate a small ember pool. Embers live in the group (fixed at origin),
    // positioned in absolute world coords, so they stay put as the spark darts on.
    // Sized so a dart and a full slipstream can burn at once without either
    // recycling a live ember (which pops as a mid-flight ember teleports):
    // dart = emberLife/emberInterval = 18, stream = streamLife/streamInterval = 10.
    for (let i = 0; i < 32; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.tex,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.renderOrder = 18;
      sprite.visible = false;
      sprite.scale.setScalar(SPARK.emberScale);
      this.group.add(sprite);
      this.embers.push({
        sprite, mat, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        life: 0, span: SPARK.emberLife, stream: false,
      });
    }
    this.applyTint();
  }

  /** Set the user-specific tint for the core, halo, and embers. */
  setTint(color: THREE.ColorRepresentation): void {
    this.tint.set(color);
    this.applyTint();
  }

  /** Draw the spark ON TOP (depthTest off) — for hosts whose scene uses a
   *  logarithmic depth buffer (real-scale space flight), where sprite depth
   *  comparison against a round planet is unreliable and would hide the cursor
   *  behind the surface. The spark is a HUD cursor, so drawing over is correct. */
  setDepthTest(enabled: boolean): void {
    this.coreMat.depthTest = enabled;
    this.haloMat.depthTest = enabled;
    for (const e of this.embers) e.mat.depthTest = enabled;
  }

  /** CHART REBASE: the coordinate frame this spark's group lives in moved —
   *  re-express every eased/remembered position through `m` (new-frame ←
   *  old-frame) so the spark stays put on screen instead of darting by the
   *  full anchor shift. Ember velocities ride the rotation via the pool's
   *  positions being remapped (their drift is cosmetic, frames apart). */
  rebase(m: THREE.Matrix4): void {
    this.pos.applyMatrix4(m);
    this.target.applyMatrix4(m);
    this.dartFrom.applyMatrix4(m);
    for (const e of this.embers) {
      if (e.life > 0) e.pos.applyMatrix4(m);
    }
  }

  /** DIAGNOSTICS: is THIS spark the one on screen, and what is it doing?
   *  `amp` is the eased presence — 0 means invisible however `shown` reads.
   *  Two GazeSparks exist in an embedded spirit run (the ladder's overlay and
   *  the live host's own); the ONE-CURSOR rule says only one may have amp > 0
   *  at a time, so this is how you catch both being drawn. */
  debugState(): string {
    return `${this.shown ? "on" : "off"}/a${this.amp.toFixed(2)}/${this.hovering ? "hov" : "flat"}/dt${
      this.coreMat.depthTest ? 1 : 0
    }/${this.phase}/c${this.core.toFixed(2)}`;
  }

  /** DIAGNOSTICS: the eased spark position in its GROUP's frame — camera-LOCAL
   *  while the group is parented to the camera (the planet path). Paired with
   *  the group's world matrix this answers the only question worth asking when
   *  no spark is on screen: is it never DRAWN (amp/core 0), or is it drawn at a
   *  point that misses the frustum? `debugState` alone cannot tell those apart.
   *  Read-only; copies into `out`. */
  debugPose(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.pos);
  }

  private applyTint(): void {
    // Keep the core near white-hot (tint lightened) so the bright ball still reads
    // as a spark; the halo and embers take the full tint.
    this.coreMat.color.copy(this.tint).lerp(WHITE, 0.55);
    this.haloMat.color.copy(this.tint);
    this.light.color.copy(this.tint);
    for (const e of this.embers) e.mat.color.copy(this.tint);
  }

  /** Aim the spark at a world point. `hovering` = the point sits on a hovered
   *  object/creature (vs a bare ground point). Small drift is tracked gently; a
   *  large jump — or any change of hover state — triggers a dart whose arc is
   *  shaped by that transition (pause → shrink → arc-with-embers → grow).
   *
   *  `worldJumped` — the caller's WORLD-frame jump verdict, for sparks whose
   *  group rides a MOVING frame (the camera-parented planet cursor): the
   *  internal threshold compares group-LOCAL targets, so frame motion aliases
   *  into "the target jumped" (a 0.01 rad/frame camera yaw moves a stationary
   *  50 m target half a metre in camera coords — dart-storming the core to
   *  size 0, the border flicker). When supplied, a dart needs BOTH verdicts:
   *  a genuine gaze flick jumps in both frames; camera rotation only in one;
   *  a HUD point (world-moving, camera-stable) only in the other. Omitted ⇒
   *  internal threshold alone (world-stable groups: hosts, flat overlays). */
  setTarget(x: number, y: number, z: number, hovering: boolean, worldJumped?: boolean): void {
    this.tmp.set(x, y, z);
    if (!this.shown) {
      // Appear at the target — don't streak in.
      this.target.copy(this.tmp);
      this.pos.copy(this.tmp);
      this.shown = true;
      this.hovering = hovering;
      this.phase = "idle";
      this.core = 1;
      return;
    }
    const jumped =
      (worldJumped ?? true) && this.target.distanceToSquared(this.tmp) > SPARK.dartThresh2;
    const hoverChanged = hovering !== this.hovering;
    if (this.phase === "idle" && (jumped || hoverChanged)) {
      // Pick the arc from the hover-state transition.
      this.arc =
        !this.hovering && hovering
          ? "land" // onto a hover target: dip, curve up, touch down
          : this.hovering && !hovering
            ? "lift" // off a hover target: the "land" arc reversed
            : this.hovering && hovering
              ? "bounce" // between hover targets: fly up, curve down
              : "hop"; // ground → ground: a light, neutral hop
      const dist = Math.sqrt(this.target.distanceToSquared(this.tmp));
      this.arcAmp = Math.min(1, Math.max(0.2, dist / SPARK.arcRefDist));
      this.phase = "shrink";
      this.phaseT = 0;
    }
    this.hovering = hovering;
    this.target.copy(this.tmp);
  }

  /** 0..1 dwell-to-select progress for this frame (0 when nothing is selecting). */
  setSelect(p: number): void {
    this.select = Math.min(1, Math.max(0, p));
  }

  /** THE SLIPSTREAM — apparent velocity of the world PAST the spark, in this
   *  spark's GROUP frame, units/sec. While it is fast enough the spark trails
   *  embers ALONG it, so they streak away the way sparks off a moving torch do.
   *
   *  This is a DELIBERATE ILLUSION and the caller must treat it as one. Where
   *  the group is parented to the camera (the spirit flight rung), the spark
   *  rides along with the camera and so does everything it emits — real motion
   *  is unreadable no matter how fast the camera actually flies. So the caller
   *  passes a made-up, screen-scaled velocity that merely POINTS the right way
   *  and reads fast, and this class asks no questions about where it came from.
   *  Pass null (or a zero vector) when the camera is still. */
  setDrift(vel: THREE.Vector3 | null): void {
    if (vel) this.drift.copy(vel);
    else this.drift.set(0, 0, 0);
  }

  /** No gaze to represent this frame — fade out in place. */
  hide(): void {
    this.shown = false;
  }

  update(dt: number): void {
    const step = Math.max(0, dt);
    this.amp += ((this.shown ? 1 : 0) - this.amp) * (1 - Math.exp(-SPARK.fadeK * step));

    switch (this.phase) {
      case "idle":
        this.pos.lerp(this.target, 1 - Math.exp(-SPARK.followK * step));
        this.core = Math.min(1, this.core + step / SPARK.growTime);
        break;
      case "shrink":
        // PAUSE at the old spot while the core shrinks to nothing.
        this.phaseT += step;
        this.core = Math.max(0, 1 - this.phaseT / SPARK.shrinkTime);
        if (this.phaseT >= SPARK.shrinkTime) {
          this.core = 0;
          this.phase = "dart";
          this.emberTimer = 0;
          this.dartT = 0;
          this.dartFrom.copy(this.pos); // launch point for the arc
        }
        break;
      case "dart": {
        // Fly the shaped arc to the new spot, dropping glowing embers along the way.
        this.dartT += step;
        const p = Math.min(1, this.dartT / SPARK.dartDur);
        // Ease horizontally from launch to target, decelerating onto the point...
        this.pos.lerpVectors(this.dartFrom, this.target, easeInOut(p));
        // ...then add the transition's vertical arc on top.
        this.pos.y += this.arcOffset(p);
        this.emberTimer += step;
        while (this.emberTimer >= SPARK.emberInterval) {
          this.emberTimer -= SPARK.emberInterval;
          this.spawnEmber();
        }
        if (p >= 1) {
          this.pos.copy(this.target);
          this.phase = "grow";
        }
        break;
      }
      case "grow":
        this.pos.lerp(this.target, 1 - Math.exp(-SPARK.followK * step));
        this.core = Math.min(1, this.core + step / SPARK.growTime);
        if (this.core >= 1) this.phase = "idle";
        break;
    }

    // Core: constant brightness, size varies (dart shrink/grow + a touch of select).
    const coreSize = SPARK.coreBase * this.core * (1 + this.select * SPARK.selectGrow);
    this.coreSprite.position.copy(this.pos);
    this.coreSprite.scale.setScalar(coreSize);
    this.coreMat.opacity = this.amp * SPARK.coreOpacity;
    // Halo: fixed size + brightness, rides along with the core.
    this.haloSprite.position.copy(this.pos);
    this.haloMat.opacity = this.amp * SPARK.haloOpacity;
    // Hover light: illuminate the focused object, but ONLY once settled on it (idle)
    // so the light never sweeps the scene while darting.
    const wantLight = this.hovering && this.phase === "idle" ? SPARK.hoverLight : 0;
    this.lightAmp += (wantLight - this.lightAmp) * (1 - Math.exp(-SPARK.lightK * step));
    this.light.position.copy(this.pos);
    this.light.intensity = this.amp * this.lightAmp;

    this.streamEmbers(step);
    this.updateEmbers(step);
  }

  /** Trail the slipstream. Runs in EVERY phase, dart included — a spark darting
   *  across a fast-moving view is doing both things at once, and the two ember
   *  kinds read as one plume. Gated on `shown`: a hidden spark leaves no wake. */
  private streamEmbers(step: number): void {
    const speed = this.drift.length();
    if (!this.shown || speed < SPARK.streamMin) {
      // Don't bank up a burst for the moment motion resumes.
      this.streamTimer = 0;
      return;
    }
    this.streamTimer += step;
    while (this.streamTimer >= SPARK.streamInterval) {
      this.streamTimer -= SPARK.streamInterval;
      this.spawnStreamEmber(speed);
    }
  }

  private spawnStreamEmber(speed: number): void {
    const e = this.embers[this.emberCursor];
    this.emberCursor = (this.emberCursor + 1) % this.embers.length;
    e.life = SPARK.streamLife;
    e.span = SPARK.streamLife;
    e.stream = true;
    e.pos.copy(this.pos);
    // Born on the spark, thrown along the drift with a little scatter so the
    // trail has width. No gravity (see `updateEmbers`): it would bend every
    // ember toward group -Y and blunt the one thing this conveys.
    const jitter = speed * SPARK.streamSpread;
    e.vel.copy(this.drift);
    e.vel.x += (Math.random() - 0.5) * jitter;
    e.vel.y += (Math.random() - 0.5) * jitter;
    e.vel.z += (Math.random() - 0.5) * jitter;
    e.sprite.visible = true;
  }

  /** Vertical offset of the dart arc at progress `p` (0→1). Zero at both ends so
   *  the spark launches from and lands on its designated point. */
  private arcOffset(p: number): number {
    const rise = SPARK.arcRise * this.arcAmp;
    const dip = SPARK.arcDip * this.arcAmp;
    switch (this.arc) {
      case "land":
        return sparkLandCurve(p, rise, dip);
      case "lift":
        return sparkLandCurve(1 - p, rise, dip); // the landing arc, time-reversed
      case "bounce":
        return rise * Math.sin(Math.PI * p); // fly up, curve down onto the point
      default:
        return 0.45 * rise * Math.sin(Math.PI * p); // neutral: a light hop
    }
  }

  private spawnEmber(): void {
    const e = this.embers[this.emberCursor];
    this.emberCursor = (this.emberCursor + 1) % this.embers.length;
    e.life = SPARK.emberLife;
    e.span = SPARK.emberLife;
    e.stream = false;
    e.pos.copy(this.pos);
    e.pos.x += (Math.random() - 0.5) * 0.12;
    e.pos.y += (Math.random() - 0.5) * 0.12;
    e.pos.z += (Math.random() - 0.5) * 0.12;
    // A small lively puff; gravity then floats them down as they fade. Plus the
    // slipstream, so a dart into a fast-moving view sheds its embers DOWNWIND
    // with the streamed ones instead of hanging beside them in a still puff.
    e.vel.set((Math.random() - 0.5) * 0.35, 0.08 + Math.random() * 0.12, (Math.random() - 0.5) * 0.35);
    e.vel.add(this.drift);
    e.sprite.visible = true;
  }

  private updateEmbers(step: number): void {
    for (const e of this.embers) {
      if (e.life <= 0) continue;
      e.life -= step;
      if (e.life <= 0) {
        e.sprite.visible = false;
        e.mat.opacity = 0;
        continue;
      }
      if (!e.stream) e.vel.y -= SPARK.emberGravity * step;
      e.pos.addScaledVector(e.vel, step);
      e.sprite.position.copy(e.pos);
      const t = e.life / e.span; // 1 → 0 over the ember's life
      e.mat.opacity = this.amp * SPARK.emberOpacity * t;
      e.sprite.scale.setScalar(SPARK.emberScale * (0.4 + 0.6 * t));
    }
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    this.tex.dispose();
    this.coreMat.dispose();
    this.haloMat.dispose();
    for (const e of this.embers) e.mat.dispose();
  }
}

// ---------------------------------------------------------------------------
// Pluggable avatar model
// ---------------------------------------------------------------------------

/** Per-frame inputs handed to an avatar model so it can pose/animate itself. The
 *  renderer has already placed `object` at the avatar's ground position. */
export interface AvatarFrame {
  state: AvatarState;
  isLocal: boolean;
  /** Current speed (world units/sec) — for motion-driven animation. */
  speed: number;
  /** A drawable face (decoded photo / live video), or null for the disc fallback. */
  faceSource: CanvasImageSource | null;
  /** Display name — its initial is the no-face fallback. */
  label: string;
  /** The scene camera, so face cards can billboard toward the viewer. */
  camera: THREE.Camera;
  /** This avatar is in the WATCH/sitting pose (local-only for now). Drives the
   *  seated idle animation. */
  sitting: boolean;
  /** The local player's gaze is resting on this avatar (INTERACT target) — draw a
   *  highlight so they can see who they're about to engage. */
  highlighted: boolean;
  /** Resolved scene-space anchor for `state.activity` when it names a fixture
   *  that exists (a sleeper's BED): the fixture's sleeping-surface center plus
   *  the lying heading (a rotation.y along the bed's long axis, head at the
   *  pillow). The renderer resolves the activity's objId against the spec so
   *  models stay spec-blind; null/absent ⇒ the activity plays out where the
   *  body stands (a doze in place). */
  activityAnchor?: { x: number; y: number; z: number; yaw: number } | null;
}

/** A swappable avatar body. `object` is added to the scene once; `update` runs
 *  each frame; `dispose` frees its GPU resources when the avatar leaves. */
export interface AvatarModel {
  readonly object: THREE.Object3D;
  update(frame: AvatarFrame, dt: number): void;
  dispose(): void;
}

export type AvatarModelFactory = (id: string, isLocal: boolean) => AvatarModel;

/**
 * The built-in placeholder body: a coloured capsule, a billboarded face disc
 * (the 2D "face circle" lifted into 3D — shows the live photo/video, else a
 * coloured disc with the name initial), a small nose marking the facing
 * direction, and a soft blob shadow grounding it. The local avatar gets a bright
 * ring so you can pick yourself out. Intentionally minimal — the creature-builder
 * will replace this via a custom AvatarModelFactory.
 */
export const defaultAvatarModelFactory: AvatarModelFactory = (id, isLocal) => {
  const tint = isLocal ? new THREE.Color("#2f6fed") : colorForId(id);
  const root = new THREE.Group();

  // ── Body (oriented to face the avatar's heading) ──────────────────────────
  const body = new THREE.Group();
  root.add(body);
  const capsuleGeom = new THREE.CapsuleGeometry(MODEL.bodyRadius, MODEL.bodyLength, 6, 14);
  const bodyMat = propMaterial(tint, {
    roughness: 0.65,
    emissive: isLocal ? new THREE.Color("#1d4ed8") : new THREE.Color("#000000"),
    emissiveIntensity: isLocal ? 0.25 : 0,
  });
  const capsule = new THREE.Mesh(capsuleGeom, bodyMat);
  capsule.position.y = MODEL.bodyRadius + MODEL.bodyLength / 2; // feet at y=0
  body.add(capsule);

  // A small nose on the body front (local -Z) so facing reads even though the
  // face card billboards toward the camera.
  const noseGeom = new THREE.ConeGeometry(0.1, 0.28, 8);
  const nose = new THREE.Mesh(noseGeom, bodyMat);
  nose.rotation.x = -Math.PI / 2; // cone (+Y) → points -Z (the body's forward)
  nose.position.set(0, MODEL.bodyRadius + MODEL.bodyLength / 2, -(MODEL.bodyRadius + 0.05));
  body.add(nose);

  // ── Face card (billboarded) ───────────────────────────────────────────────
  const faceGroup = new THREE.Group();
  faceGroup.position.y = MODEL.faceY;
  root.add(faceGroup);

  // Border ring: bright + thick for "you", thin + dark for everyone else.
  const ringOuter = MODEL.faceRadius * (isLocal ? 1.16 : 1.07);
  const ringInner = MODEL.faceRadius * (isLocal ? 1.0 : 1.0);
  const ringGeom = new THREE.RingGeometry(ringInner, ringOuter, 48);
  const ringMat = new THREE.MeshBasicMaterial({
    color: isLocal ? new THREE.Color("#38bdf8") : new THREE.Color("#0f172a"),
    transparent: true,
    opacity: isLocal ? 1 : 0.55,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.position.z = -0.005;
  faceGroup.add(ring);

  // The disc itself. Its material map is swapped between a live face texture and
  // a fallback canvas (coloured disc + initial) as availability changes.
  const discGeom = new THREE.CircleGeometry(MODEL.faceRadius, 48);
  const discMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false });
  const disc = new THREE.Mesh(discGeom, discMat);
  faceGroup.add(disc);

  // Fallback texture (coloured disc + initial), drawn lazily and cached by label.
  // OffscreenCanvas (not document.createElement) so the model builds in a worker.
  const fallbackCanvas = new OffscreenCanvas(128, 128);
  const fallbackTex = new THREE.CanvasTexture(fallbackCanvas as unknown as HTMLCanvasElement);
  fallbackTex.colorSpace = THREE.SRGBColorSpace;
  let fallbackLabel: string | null = null;
  const drawFallback = (label: string): void => {
    const c = fallbackCanvas.getContext("2d");
    if (!c) return;
    c.clearRect(0, 0, 128, 128);
    c.fillStyle = `#${tint.getHexString()}`;
    c.beginPath();
    c.arc(64, 64, 64, 0, Math.PI * 2);
    c.fill();
    const initial = label.trim().charAt(0).toUpperCase();
    if (initial) {
      c.fillStyle = "#ffffff";
      c.font = "bold 72px sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(initial, 64, 70);
    }
    fallbackTex.needsUpdate = true;
    fallbackLabel = label;
  };

  // Live face texture (photo or video frame). Re-uploaded each frame while a
  // source is present; cover-fit cropped to the square so faces aren't squished.
  const faceTex = new THREE.Texture();
  faceTex.colorSpace = THREE.SRGBColorSpace;
  faceTex.center.set(0.5, 0.5);
  const fitCover = (srcW: number, srcH: number, flipV: boolean): void => {
    if (!srcW || !srcH) return;
    const aspect = srcW / srcH;
    let rx: number, ry: number, ox: number, oy: number;
    if (aspect >= 1) {
      rx = 1 / aspect; ry = 1; ox = (1 - 1 / aspect) / 2; oy = 0;
    } else {
      rx = 1; ry = aspect; ox = 0; oy = (1 - aspect) / 2;
    }
    // ImageBitmap sources can't be flipped at upload time — THREE.Texture.flipY
    // is ignored for ImageBitmap (it must be baked in at createImageBitmap time,
    // which we can't do because the SAME bitmap also feeds the 2D drawImage path).
    // So mirror V here instead: negating both repeat.y and offset.y reflects the
    // sampled window about v=0.5 (center is 0.5), giving the upright orientation
    // the <img>/<video> path gets for free from flipY.
    if (flipV) { ry = -ry; oy = -oy; }
    faceTex.repeat.set(rx, ry);
    faceTex.offset.set(ox, oy);
  };

  const srcSize = (src: CanvasImageSource): { w: number; h: number } => {
    const s = src as unknown as {
      videoWidth?: number; naturalWidth?: number; width?: number;
      videoHeight?: number; naturalHeight?: number; height?: number;
    };
    return {
      w: s.videoWidth ?? s.naturalWidth ?? (typeof s.width === "number" ? s.width : 0),
      h: s.videoHeight ?? s.naturalHeight ?? (typeof s.height === "number" ? s.height : 0),
    };
  };

  let usingFace = false;

  // Animation state for the seated idle + INTERACT highlight (eased, not snapped).
  let seatedAmt = 0;
  let animClock = 0;
  const baseRingOpacity = ringMat.opacity;
  const baseFaceY = MODEL.faceY;
  // Scratch vectors for the per-frame face push-out (no per-frame allocation).
  const faceOut = new THREE.Vector3();
  const rootWorld = new THREE.Vector3();

  // ── Blob shadow ───────────────────────────────────────────────────────────
  const shadowGeom = new THREE.CircleGeometry(MODEL.bodyRadius * 1.25, 24);
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 });
  const shadow = new THREE.Mesh(shadowGeom, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  root.add(shadow);

  return {
    object: root,
    update(frame, dt) {
      const step = Math.max(0, dt || 0);
      // Face body toward heading: map the body's -Z to (fx, fy). yaw such that
      // (0,0,-1) rotated about +Y lands on (fx, 0, fy) is atan2(-fx, -fy).
      const { fx, fy } = frame.state;
      body.rotation.y = Math.atan2(-fx, -fy);

      // Choose live face vs fallback disc.
      const { w, h } = frame.faceSource ? srcSize(frame.faceSource) : { w: 0, h: 0 };
      if (frame.faceSource && w > 0 && h > 0) {
        // <img>/<video>/<canvas> are flipped correctly by the GPU upload (flipY);
        // ImageBitmap is not (flipY ignored) — disable the upload flip for it and
        // mirror V via the texture transform in fitCover instead. Disabling flipY
        // here (rather than relying on it being a no-op) keeps us correct even if a
        // future THREE starts honouring flipY for ImageBitmap.
        const isBitmap = typeof ImageBitmap !== "undefined" && frame.faceSource instanceof ImageBitmap;
        faceTex.image = frame.faceSource;
        faceTex.flipY = !isBitmap;
        fitCover(w, h, isBitmap);
        faceTex.needsUpdate = true;
        if (!usingFace) {
          discMat.map = faceTex;
          discMat.needsUpdate = true;
          usingFace = true;
        }
      } else {
        if (fallbackLabel !== frame.label) drawFallback(frame.label);
        if (usingFace || discMat.map !== fallbackTex) {
          discMat.map = fallbackTex;
          discMat.needsUpdate = true;
          usingFace = false;
        }
      }

      // Seated idle (WATCH): sink down + gently bob, eased so it never snaps. The
      // creature-builder will replace this with a real seated pose later.
      animClock += step;
      seatedAmt += ((frame.sitting ? 1 : 0) - seatedAmt) * (1 - Math.exp(-6 * step));
      body.position.y = -0.3 * seatedAmt;
      const bob = Math.sin(animClock * 1.8) * 0.04 * seatedAmt;

      // INTERACT highlight: brighten the face ring + a soft scale pulse so the
      // player sees who/what they're about to engage.
      const hi = frame.highlighted ? 1 : 0;
      ringMat.opacity = baseRingOpacity + (1 - baseRingOpacity) * hi;
      ring.scale.setScalar(1 + 0.08 * hi * (0.5 + 0.5 * Math.sin(animClock * 5)));

      // Billboard the face card toward the camera, PUSHED OUT past the body:
      // the card anchors at head height INSIDE the capsule silhouette, so slide
      // it toward the camera just beyond the surface — from any angle it reads
      // as the face ON the head instead of being buried in the body.
      faceGroup.quaternion.copy(frame.camera.quaternion);
      faceOut
        .copy(frame.camera.position)
        .sub(root.getWorldPosition(rootWorld))
        .normalize()
        .multiplyScalar(MODEL.bodyRadius + 0.1);
      faceGroup.position.set(
        faceOut.x,
        baseFaceY - 0.45 * seatedAmt + bob + faceOut.y,
        faceOut.z,
      );
    },
    dispose() {
      capsuleGeom.dispose();
      noseGeom.dispose();
      bodyMat.dispose();
      ringGeom.dispose();
      ringMat.dispose();
      discGeom.dispose();
      discMat.dispose();
      shadowGeom.dispose();
      shadowMat.dispose();
      faceTex.dispose();
      fallbackTex.dispose();
    },
  };
};

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * A pluggable extra layer drawn in the SAME scene as the world (sharing its
 * camera, ground, and lighting). The world engine knows nothing about what an
 * overlay contains — this is how an embedded content layer (a goal-tree quest's
 * zones/figures/items today; the symbol game's demonstration props later) rides
 * the 3D view without world-engine taking a dependency on it. Coordinates are
 * world-engine ground coords: a world point (x, y) is the 3D point (x, 0, y).
 */
export interface SceneOverlay {
  /** Called once during construction; add meshes to `scene`. */
  mount(scene: THREE.Scene): void;
  /** Called each rendered frame (after world meshes sync, before the draw). */
  update(dt: number): void;
  dispose(): void;
}

export interface World3DRendererOptions {
  localId: string;
  backdrop?: string;
  /** Swap in richer avatar bodies (e.g. the creature-builder). */
  modelFactory?: AvatarModelFactory;
  /** Camera-rig + transition overrides (merged over DEFAULT_CAMERA_TUNABLES). */
  camera?: Partial<CameraTunables>;
  /** Motion-comfort overrides (merged over DEFAULT_COMFORT_TUNABLES). */
  comfort?: Partial<ComfortTunables>;
  /** An embedded content layer drawn in the world scene (see SceneOverlay). */
  overlay?: SceneOverlay;
  /** Roads to paint on the ground (streets of a streamed town). Render-only flat
   *  ribbons; see RoadPath. Built once, on the first render (so an irregular
   *  world's `state.ground` can lift each vertex to the terrain). */
  roads?: RoadPath[];
  /** Override the road ribbon colour (hex). Defaults to ROAD_COLOR (packed-earth
   *  tan, matching the 2D map). */
  roadColor?: string;
  /** SPIRIT avatar: a FIXED angled-overhead camera that frames the whole scene
   *  (the formless player never moves, so the follow-rig is replaced by a static
   *  vantage over the manifold). */
  spirit?: boolean;
  /** SPIRIT frame override (world rect): what the spirit camera frames. A TOWN
   *  dollhouse passes its focused HOUSE here — without it the camera frames the
   *  bounds of every streamed building (the whole town), which is right only
   *  when the scene IS one structure. Orbit/pitch behavior is identical. */
  spiritFrame?: { x: number; y: number; w: number; h: number };
  /** Embed the town INTO a host scene (the space-flight composer) rather than
   *  owning a renderer/camera/canvas. See SEAMLESS_FLIGHT_PLAN.md (Piece 2). */
  host?: RenderHost;
}

/** Injection context for embedding a World3DRenderer in another scene. When
 *  present the renderer hangs all its world content under `anchor` (positioned
 *  at the town's site on the planet), shares `camera` for its fade / pick math,
 *  and does NOT draw — the host's own loop composes the frame. `scene` is the
 *  host's root scene (kept for parity with the flight composer; the renderer
 *  only needs `anchor` + `camera`). */
export interface RenderHost {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  anchor: THREE.Object3D;
  /** Optional: raycast the HOST's drawn world (streamed terrain, roads,
   *  flora) along a WORLD-space ray. An embedded world (a wilderness chunk
   *  or town riding the flight scene) draws no ground of its own — the gaze
   *  pick prefers this hit over the analytic terrain-march, because the
   *  cursor must sit on the pixels the player actually sees (the LOD meshes
   *  can sit metres off the analytic sampler). */
  castGroundRay?(origin: THREE.Vector3, dir: THREE.Vector3, far: number): THREE.Vector3 | null;
}

/** Merge partial camera/comfort overrides over the defaults (nested poses too). */
function mergeCamera(p?: Partial<CameraTunables>): CameraTunables {
  return {
    ...DEFAULT_CAMERA_TUNABLES,
    ...p,
    overhead: { ...DEFAULT_CAMERA_TUNABLES.overhead, ...p?.overhead },
    shoulder: { ...DEFAULT_CAMERA_TUNABLES.shoulder, ...p?.shoulder },
  };
}
function mergeComfort(p?: Partial<ComfortTunables>): ComfortTunables {
  return { ...DEFAULT_COMFORT_TUNABLES, ...p };
}

/**
 * Owns a Three.js scene that mirrors a WorldState: a ground field, a follow
 * camera, one pluggable model per avatar, and a sphere per toy. Stateful by
 * nature (GPU meshes are created once and transformed each frame), unlike the
 * stateless 2D draw call.
 */
export class World3DRenderer {
  private readonly spec: WorldSpec;
  private readonly localId: string;
  private readonly modelFactory: AvatarModelFactory;
  private cameraCfg: CameraTunables;

  // Injected logical size (CSS px) + DPR — set by resize(). Stored (not read from
  // canvas.clientWidth / window) so the renderer runs on an OffscreenCanvas in a
  // worker. screenToWorld + the camera aspect derive from these.
  private vw = 1;
  private vh = 1;

  /** Undefined in HOST mode — the flight composer owns the GL renderer + canvas. */
  private readonly renderer?: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  /** Injection context when embedded in a host scene; undefined = owns its own
   *  renderer/camera/canvas (the default AAC-symbol-game path). */
  private readonly host?: RenderHost;
  /** HOST mode: does THIS renderer drive the shared camera? Off while the flight
   *  camera owns the view (airborne); flipped on when WALKING owns it. */
  private driveCamera = false;
  /** OWNER-mode camera opt-out (setExternalCamera): the spirit ladder owns
   *  the camera while this renderer keeps drawing. Never set by the AAC. */
  private externalCamera = false;
  /** CURSOR opt-out (setExternalCursor): the PLANET owns the one spark — the
   *  player is on a planet, and a town drawing the player's cursor is a frame
   *  leak. With this on, updateSpark still computes the full cursor target
   *  (hover snap to heads / localTopY, select progress) but REPORTS it via
   *  externalCursorWorld instead of driving this renderer's own spark: the
   *  town supplies content under the pointer, the planet draws. Never set by
   *  the AAC (frameless whole-world sessions keep their own spark). */
  private externalCursor = false;
  /** Do occupants/accessibility reveal building INTERIORS (cutaway walls, open
   *  roofs)? Default on — every existing path keeps its behaviour. Turned off
   *  for the spirit GROUND rung, whose local avatar is a parked stand-in
   *  rather than someone actually standing inside the house. */
  private interiorReveal = true;
  /** Last computed cursor target while externalCursor is on — anchor-LOCAL
   *  coords (lifted to world at READ time so a rebase between the host's step
   *  and the ladder's read cannot skew it). */
  private extCursorHas = false;
  private readonly extCursorPos = new THREE.Vector3();
  private extCursorHovering = false;
  private extCursorSelect = 0;
  private readonly _dollPose = {
    pos: new THREE.Vector3(),
    look: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0),
    fov: DOLLHOUSE_FOV,
  };
  /** HOST mode scratch: the shared camera's position pulled into the anchor's
   *  LOCAL (town) frame, where all the fade / pick math is authored. */
  private readonly _localCam = new THREE.Vector3();
  /** HOST mode: the LOCAL-FRAME CAMERA all in-scene math reads. In owner mode
   *  it IS `this.camera`; in host mode it's a stand-in whose pose is the
   *  shared camera mapped through the anchor's inverse — wall cuts, roof
   *  fades, face/bubble billboards and the blackout sightline all live in
   *  town-local coords, and reading the planet-frame camera there hid the
   *  WRONG side of houses (and sent the gaze pick behind them). Refreshed at
   *  the top of every render(). */
  private camLocalFrame: THREE.Camera;
  private readonly _hostCam = new THREE.PerspectiveCamera();
  private readonly _invAnchorM = new THREE.Matrix4();
  private readonly _invAnchorQ = new THREE.Quaternion();
  /** Avatars forced invisible regardless of sim state — the walk↔fly coordinator
   *  hides the town's local body while it's airborne (the flight shows the bird). */
  private readonly hiddenAvatars = new Set<string>();
  /** HOST mode scratch for mapping the LOCAL chase pose into the shared camera's
   *  WORLD frame (placeCamera) and the gaze ray back the other way. */
  private readonly _camPos = new THREE.Vector3();
  private readonly _camLook = new THREE.Vector3();
  private readonly _camUp = new THREE.Vector3();
  /** HOST mode scratch: the town ground plane raised into the planet world frame
   *  for the gaze raycast (screenToWorld). */
  private readonly _hostPlane = new THREE.Plane();
  private readonly raycaster = new THREE.Raycaster();
  /** Last frame's interior-visibility set + the state it was computed against, so
   *  the gaze pick can refuse anything inside a HIDDEN room (see pickScreen). */
  private pickVisible = new Set<string>();
  private pickState: WorldState | null = null;
  /** Hidden (non-visible) rooms drawn as the blackout cube instead of being
   *  revealed by the cutaway. SPIRIT: every hidden room. AVATAR: only the ones the
   *  camera→player sightline would expose. Recomputed each frame. */
  private readonly cutawayBlackout = new Set<string>();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  /** Scratches for the gaze terrain-march (screenToWorld). */
  private readonly _gazeMarchO = new THREE.Vector3();
  private readonly _gazeMarchD = new THREE.Vector3();
  private readonly _pickInv = new THREE.Matrix4();
  /** Bumped once per render — the picks use it to refresh the host's world
   *  matrices at most once a frame (see `syncHostPickMatrices`). */
  private frameSeq = 0;
  private pickSyncSeq = -1;
  /** Scratch for the gaze ground-plane intersection (screenToWorld). */
  private readonly _gazeGround = new THREE.Vector3();
  private readonly _scratch = new THREE.Vector3();
  /** Screen-up in world space, recomputed each frame for bubble placement. */
  private readonly _bubbleUp = new THREE.Vector3(0, 1, 0);

  private readonly avatars = new Map<string, AvatarModel>();
  private readonly objectMeshes = new Map<
    string,
    {
      /** Pick root + positioned node. A real 3D model (a Group) or the generic
       *  box/sphere Mesh fallback. */
      mesh: THREE.Object3D;
      shadow: THREE.Mesh;
      icon?: THREE.Sprite;
      glyphKey?: string;
      /** Every standard material in `mesh` — highlight/fade touch all of them. */
      materials: LitMaterial[];
      /** The procedural model (present unless this object fell back to box/sphere);
       *  owns descriptor application, particle animation, and its own disposal. */
      model?: ObjectModel;
      /** Cached shell HEIGHT above the mesh's own origin (local frame), for the
       *  gaze spark's hover point. `radius` can't serve: it is the FOOTPRINT
       *  half-extent, so a tall cabinet reported a short one and the spark
       *  hovered INSIDE it. Invalidated when the model's glyph changes. */
      topY?: number;
    }
  >();
  /** Walls (static) + doors (a hinge pivot whose yaw tracks the door's `open`).
   *  `mats` = every material the see-inside fade eases (wall, or leaf+lintel). */
  private readonly structureMeshes = new Map<
    string,
    {
      object: THREE.Object3D;
      mats: LitMaterial[];
      door?: { pivot: THREE.Group; thetaClosed: number; leafMat: LitMaterial };
      /** SPIRIT dollhouse: the fadeable TALL wall body. When present, the group
       *  ALSO holds a persistent floor ridge + diagonal corner stubs that remain
       *  visible after the tall body fades — the "a wall is here" cue. */
      tall?: THREE.Mesh;
    }
  >();
  /** Per-building render meshes: upper floor slabs (by storey) + a roof. */
  private readonly buildingMeshes = new Map<
    string,
    {
      slabs: { floor: number; mesh: THREE.Mesh }[];
      roof: THREE.Mesh;
      /** SPIRIT dollhouse stand-in for a HIDDEN (locked) room: a black floor +
       *  translucent cube shown in place of its walls/roof so it reads as a
       *  sealed volume without blocking the rooms behind it. */
      hidden: { floor: THREE.Mesh; cube: THREE.Mesh };
    }
  >();
  /** Last-seen spec lists — a swapped reference (streaming) triggers the
   *  removal sweep for meshes whose structure/building left the world. */
  private lastStructureList?: StructureSpec[];
  private lastBuildingList?: BuildingSpec[];
  /** Roads held until the FIRST render — the world's ground sampler rides the
   *  state (state.ground), which the constructor hasn't seen yet. */
  private pendingRoads?: RoadPath[];
  private pendingRoadColor?: string;
  /** The playable field mesh + its motion grid (buildGround). On an
   *  irregular world the field CONFORMS to the terrain on the first render
   *  (same deferral as roads); flat worlds keep the y=0 plane untouched. */
  private fieldMesh!: THREE.Mesh;
  private fieldGrid!: THREE.GridHelper;
  private voidPlane!: THREE.Mesh;
  private fieldConformed = false;
  private readonly bubbles = new Map<string, Bubble3D>();
  /** The player's gaze cursor rendered as a small flying light (see GazeSpark). */
  private readonly spark = new GazeSpark();

  // --- Motion comfort ---------------------------------------------------------
  private comfort: ComfortTunables;
  /** Fullscreen vignette drawn over the scene; its strength tracks camera motion. */
  private overlayScene!: THREE.Scene;
  private overlayCamera!: THREE.Camera;
  private vignetteUniforms!: { uStrength: { value: number }; uInner: { value: number }; uColor: { value: THREE.Color } };
  /** Angular speed (rad/s) actually applied to the camera last frame. */
  private lastYawSpeed = 0;
  /** Eased vignette strength (0..maxVignette), so it fades rather than snaps. */
  private vignetteStrength = 0;

  /** The smoothed ground point the camera is following (eased toward the local
   *  avatar). Null until the first frame, when it snaps. */
  /** SPIRIT: a fixed angled-overhead vantage over the whole manifold (the
   *  formless player never moves, so the follow rig is bypassed). */
  private spiritCamera = false;
  /** Last visibility-pass snapshot (debugCutaway) — diagnostics only. */
  private cutawayDebug = "";
  /** DIAGNOSTICS (dollhouse handoff): what the last sync pass DECIDED vs what
   *  it managed to APPLY. `hideW` = walls whose cutaway test said "cut" —
   *  if hideW > 0 while `cut:` stays 0, the decision is right and the fade is
   *  the broken link (frozen dt, or opacity reset by a rebuild). `built` =
   *  meshes constructed that frame: > 0 every frame = rebuild thrash, which
   *  resets opacity to 1 and would freeze every fade while leaving instant
   *  booleans (doors) working. */
  private dbgWallHide = 0;
  private dbgBuilt = 0;
  private dbgRoofRev = 0;
  private dbgRoofMinOp = 1;
  private dbgDt = 0;
  /** SPIRIT frame override (a town dollhouse's focused house). */
  private spiritFrame: { x: number; y: number; w: number; h: number } | null = null;
  private camCenter: THREE.Vector3 | null = null;
  // SPIRIT dollhouse camera state: orbit offset (rad). `_camScratch` projects the
  // gaze fixation to screen space for the edge (orbit) trigger.
  private spiritAz = 0;
  private readonly _camScratch = new THREE.Vector3();
  /** The smoothed camera HEADING (unit, on the XZ ground plane). The camera sits
   *  behind it and looks ahead along it, so it swings to reveal what's in front of
   *  the avatar as it moves. Defaults to -Z (north), matching the spawn framing. */
  private readonly camForward = new THREE.Vector3(0, 0, -1);

  // --- Overhead ↔ shoulder rig --------------------------------------------------
  /** 0 = overhead (home/watch), 1 = over-the-shoulder (travel). Eased toward
   *  `travelTarget`; the rig pose is lerp(overhead, shoulder, travelCommit). */
  private travelCommit = 0;
  private travelTarget = 0;
  /** The current interpolated rig pose (placeCamera reads it each frame). */
  private readonly rig: CameraRigPose;

  private readonly disposables: { dispose(): void }[] = [];

  /** Optional embedded content layer (goal-tree quest, symbol-game props, …). */
  private readonly overlay?: SceneOverlay;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, spec: WorldSpec, opts: World3DRendererOptions) {
    this.spec = spec;
    this.localId = opts.localId;
    this.modelFactory = opts.modelFactory ?? defaultAvatarModelFactory;
    this.overlay = opts.overlay;
    this.spiritCamera = !!opts.spirit;
    this.spiritFrame = opts.spiritFrame ?? null;
    this.cameraCfg = mergeCamera(opts.camera);
    this.comfort = mergeComfort(opts.comfort);
    // Start at the overhead "home" pose (the avatar spawns at rest → watch/overhead).
    this.rig = { ...this.cameraCfg.overhead };

    const backdrop = opts.backdrop ?? BACKDROP;
    this.host = opts.host;
    this.scene = new THREE.Scene();

    if (this.host) {
      // EMBEDDED: the flight composer owns the renderer + canvas; we share its
      // camera and hang all town content under the city anchor. No own fog (a
      // child scene's fog is ignored by the renderer) and no vignette draw.
      this.camera = this.host.camera;
      this.camLocalFrame = this._hostCam;
      this.host.anchor.add(this.scene);
    } else {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      this.renderer.setClearColor(new THREE.Color(backdrop), 1);
      // We draw the scene then a vignette pass, so take over clearing.
      this.renderer.autoClear = false;
      this.scene.fog = new THREE.Fog(new THREE.Color(backdrop), 40, 150);
      this.camera = new THREE.PerspectiveCamera(this.rig.fov, 1, 0.1, 1000);
      this.camLocalFrame = this.camera; // owner mode: local frame IS world frame
    }

    this.buildLights();
    this.buildGround(backdrop);
    this.pendingRoads = opts.roads;
    this.pendingRoadColor = opts.roadColor;
    // The vignette scene is built even in host mode (updateComfort touches its
    // uniforms), but its draw pass is skipped — see render().
    this.buildVignette(backdrop);
    this.scene.add(this.spark.group);
    // HOST-EMBED: the flight composer draws this scene with a logarithmic
    // depth buffer, where sprite depth against the planet is unreliable —
    // the spark's POINT LIGHT showed while its core/halo sprites z-failed.
    // Draw the cursor ON TOP there (the standalone owner-mode canvas keeps
    // true 3D occlusion).
    if (this.host) this.spark.setDepthTest(false);
    this.overlay?.mount(this.scene);

    // Pre-position the camera over the field centre so a screenToWorld call that
    // lands before the first render (camCenter still null) still casts a sane ray.
    // The first render's updateCamera snaps the follow to the local avatar. In
    // host mode the camera belongs to the flight composer — don't touch it.
    if (!this.host) this.placeCamera(spec.manifold.width / 2, spec.manifold.height / 2);
    // Size is injected by the host via resize() right after construction (the
    // renderer never measures the canvas itself, so it works off-thread).
  }

  /** Position + aim the camera behind the followed ground point, along the current
   *  smoothed heading, using the current (overhead↔shoulder) rig pose. Shared by
   *  the constructor pre-placement and updateCamera. `gy` = the site's ground level
   *  at the followed point — the whole rig rides the terrain with the avatar. */
  private placeCamera(cx: number, cz: number, gy = 0): void {
    const f = this.camForward;
    const r = this.rig;
    this._camPos.set(cx - f.x * r.back, gy + r.height, cz - f.z * r.back);
    this._camLook.set(cx + f.x * r.lookAhead, gy + r.lookHeight, cz + f.z * r.lookAhead);
    if (this.host) {
      // The chase pose is authored in the town's LOCAL flat frame; the shared
      // camera lives in the planet's WORLD frame — map the pose (and up vector)
      // through the city anchor so the walking rig sits on the sphere at the town.
      this.host.anchor.updateWorldMatrix(true, false);
      this._camPos.applyMatrix4(this.host.anchor.matrixWorld);
      this._camLook.applyMatrix4(this.host.anchor.matrixWorld);
      this.camera.up.copy(this._camUp.set(0, 1, 0).transformDirection(this.host.anchor.matrixWorld));
    }
    this.camera.position.copy(this._camPos);
    this.camera.lookAt(this._camLook);
  }

  /** Toon quantizes only DIRECT light through its ramp — hemisphere/ambient
   *  light lands as flat, un-banded irradiance. The standard rig is deliberately
   *  ambient-dominant (0.95 vs 0.7) for soft readable faces, but under toon that
   *  floods the ramp and the bands wash out into near-flat colour. So the toon
   *  rig inverts the balance and lets the key light carry the shading. */
  private buildLights(): void {
    const toon = getShadingMode() === "toon";
    const hemi = new THREE.HemisphereLight(0xffffff, 0x4a5a44, toon ? 0.35 : 0.95);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, toon ? 1.6 : 0.7);
    dir.position.set(0.5, 1, 0.3).normalize().multiplyScalar(50);
    this.scene.add(dir);
  }

  private buildGround(backdrop: string): void {
    const { width, height } = this.spec.manifold;
    const cx = width / 2;
    const cz = height / 2;

    // Void backdrop far beneath/around the field so edges read as an horizon.
    const voidGeom = new THREE.PlaneGeometry(2000, 2000);
    const voidMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(backdrop) });
    const voidPlane = new THREE.Mesh(voidGeom, voidMat);
    voidPlane.rotation.x = -Math.PI / 2;
    voidPlane.position.set(cx, -0.1, cz);
    this.scene.add(voidPlane);
    this.disposables.push(voidGeom, voidMat);
    this.voidPlane = voidPlane;

    // The playable field. Stays a FLAT y=0 plane even on an irregular world —
    // a host with real terrain (world-lab) draws its own conformed ground mesh;
    // this built-in field is the flat-world backdrop.
    const fieldGeom = new THREE.PlaneGeometry(width, height);
    const fieldMat = terrainMaterial({
      color: new THREE.Color(this.spec.terrain.groundColor ?? "#6db36b"),
    });
    const field = new THREE.Mesh(fieldGeom, fieldMat);
    field.rotation.x = -Math.PI / 2;
    field.position.set(cx, 0, cz);
    this.scene.add(field);
    this.disposables.push(fieldGeom, fieldMat);
    this.fieldMesh = field;

    // Subtle grid for a sense of motion (faces glide; the ground needs texture).
    const gridSize = Math.max(width, height);
    const grid = new THREE.GridHelper(gridSize, Math.round(gridSize / 5), 0xffffff, 0xffffff);
    (grid.material as THREE.Material).opacity = 0.08;
    (grid.material as THREE.Material).transparent = true;
    grid.position.set(cx, 0.01, cz);
    this.scene.add(grid);
    this.disposables.push(grid.geometry, grid.material as THREE.Material);
    this.fieldGrid = grid;

    // Field border.
    const border = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0.03, 0),
        new THREE.Vector3(width, 0.03, 0),
        new THREE.Vector3(width, 0.03, height),
        new THREE.Vector3(0, 0.03, height),
      ]),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }),
    );
    this.scene.add(border);
    this.disposables.push(border.geometry, border.material as THREE.Material);

    // HOST mode: the town is EMBEDDED in a host world whose terrain IS the
    // ground — the built-in backdrop (void horizon, flat field, grid, border)
    // would sit as a huge dark slab over the real landscape. Keep the objects
    // (conformField and the motion math still reference them) but never draw.
    if (this.host) {
      voidPlane.visible = false;
      field.visible = false;
      grid.visible = false;
      border.visible = false;
    }
  }

  /** Paint the town's roads as flat ground ribbons — one mesh per path, all
   *  sharing a single opaque tan material at ROAD_Y. Built once (streamed worlds
   *  aren't a consumer of this view); ribbons overlap harmlessly because they're
   *  one flat colour. */
  private buildRoads(roads: RoadPath[] | undefined, roadColor?: string, ground?: GroundSampler): void {
    if (!roads || roads.length === 0) return;
    const mat = roadMaterial(new THREE.Color(roadColor ?? ROAD_COLOR));
    this.disposables.push(mat);
    for (const road of roads) {
      const geom = buildRoadRibbon(road.points, road.width, ground);
      if (!geom.getIndex()) {
        // Empty ribbon (fewer than two distinct points) — nothing to add.
        geom.dispose();
        continue;
      }
      const mesh = new THREE.Mesh(geom, mat);
      // Ground paint never occludes anything above it; drawn early, under bodies.
      mesh.renderOrder = -1;
      this.scene.add(mesh);
      this.disposables.push(geom);
    }
  }

  /** A fullscreen radial vignette drawn on top of the scene. Its alpha is driven
   *  by camera motion (updateComfort) to cut peripheral optical flow — the main
   *  anti-nausea lever — and fades to nothing when the camera is still. */
  private buildVignette(backdrop: string): void {
    this.overlayScene = new THREE.Scene();
    this.overlayCamera = new THREE.Camera(); // shader writes clip coords directly
    this.vignetteUniforms = {
      uStrength: { value: 0 },
      uInner: { value: this.comfort.vignetteInner },
      uColor: { value: new THREE.Color(backdrop) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.vignetteUniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform float uStrength;
        uniform float uInner;
        uniform vec3 uColor;
        void main() {
          vec2 p = (vUv - 0.5) * 2.0;          // -1..1, corners ~1.41
          float a = smoothstep(uInner, 1.0, length(p)) * uStrength;
          gl_FragColor = vec4(uColor, a);
        }
      `,
    });
    const geom = new THREE.PlaneGeometry(2, 2);
    this.overlayScene.add(new THREE.Mesh(geom, mat));
    this.disposables.push(geom, mat);
  }

  /** Set the drawing buffer from the host-supplied logical size × DPR and fix the
   *  aspect. The host owns measurement (DOM on main, stored values in a worker). */
  resize(width: number, height: number, dpr: number): void {
    // vw/vh are kept in both modes (screenToWorld needs them). In host mode the
    // flight composer owns the GL size + the shared camera's aspect.
    this.vw = Math.max(1, width);
    this.vh = Math.max(1, height);
    if (this.host) return;
    this.renderer!.setPixelRatio(dpr || 1);
    this.renderer!.setSize(this.vw, this.vh, false);
    this.camera.aspect = this.vw / this.vh;
    this.camera.updateProjectionMatrix();
  }

  /** HOST mode: hand the shared camera to (true) or away from (false) the town's
   *  chase rig. The walk↔fly coordinator flips this — WALKING drives it, the
   *  flight camera owns it airborne. No-op in owner mode (always drives).
   *  Taking the camera RESETS the follow: the rig snaps to the avatar's current
   *  spot (updateCamera's null-centre snap) instead of easing in from wherever
   *  the previous grounded session left it. */
  setDriveCamera(on: boolean): void {
    if (this.host && on && !this.driveCamera) this.camCenter = null;
    this.driveCamera = on;
  }

  /** CHART REBASE (host mode): the anchor this scene hangs under was moved to
   *  a new surface chart with world poses preserved (WorldHost.rebase carried
   *  the sim). `delta` = newAnchorWorld⁻¹ · oldAnchorWorld. Every LOCAL-frame
   *  cache the renderer eases across frames is re-expressed here so the camera
   *  and cursor don't lurch by the anchor shift: the follow centre, the
   *  smoothed heading, and the spark's eased positions. Everything else is
   *  re-derived from state each frame. */
  rebaseLocal(delta: THREE.Matrix4): void {
    if (this.camCenter) this.camCenter.applyMatrix4(delta);
    // Heading is a ground-plane direction: rotate, flatten, renormalise.
    this.camForward.transformDirection(delta);
    this.camForward.y = 0;
    if (this.camForward.lengthSq() > 1e-12) this.camForward.normalize();
    else this.camForward.set(0, 0, -1);
    this.spark.rebase(delta);
  }

  /** Turn the SPIRIT (dollhouse) rendering on/off at runtime WITHOUT taking the
   *  camera — the cutaway (near/interior walls dropped, hidden rooms cubed) and
   *  the framed focus follow `spiritCamera`, while the camera WRITE stays gated
   *  on `driveCamera` (see updateCamera). So a host that owns its own camera
   *  (the spirit-mode flight world orbiting a building) can reveal that
   *  building's interior by calling `setSpiritFocus(footprint)` and clear it
   *  with `setSpiritFocus(null)`. `frame` = the focused building's footprint (for
   *  the dollhouse framing, used only if this renderer also drives the camera). */
  setSpiritFocus(frame: { x: number; y: number; w: number; h: number } | null): void {
    this.spiritCamera = frame !== null;
    this.spiritFrame = frame;
  }

  /** OWNER-mode camera opt-out: an external rig (the spirit ladder) owns the
   *  camera while this renderer keeps rendering. Owner mode normally always
   *  drives (`driveCamera || !host`); with this ON, the camera write is
   *  skipped unless `driveCamera` explicitly grants it. The AAC product
   *  never calls this — its paths are untouched. */
  setExternalCamera(on: boolean): void {
    this.externalCamera = on;
  }

  /** The render camera — for an EXTERNAL rig (the spirit ladder) that owns
   *  its pose while this renderer keeps drawing. */
  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  /** CURSOR opt-out: the planet's one spark draws the cursor; this renderer
   *  computes and REPORTS its cursor target (externalCursorWorld) instead of
   *  drawing its own. See the field doc — never called by the AAC. */
  setExternalCursor(on: boolean): void {
    this.externalCursor = on;
    if (on) this.spark.hide();
    else this.extCursorHas = false;
  }

  /** Reveal building interiors from occupancy/accessibility (see the field).
   *  Off = ordinary sealed buildings, whoever is standing where. */
  setInteriorReveal(on: boolean): void {
    this.interiorReveal = on;
  }

  /** The cursor target this renderer computed on its LAST render while
   *  externalCursor is on — WORLD coords (host mode lifts through the anchor's
   *  CURRENT matrix), plus what the display needs: `hovering` (snapped to a
   *  creature head / object top vs skimming bare ground) and `select` (dwell
   *  progress for the bloom). Null = no cursor this frame (no gaze, or the
   *  opt-out is off). */
  externalCursorWorld(out: THREE.Vector3): { hovering: boolean; select: number } | null {
    if (!this.externalCursor || !this.extCursorHas) return null;
    out.copy(this.extCursorPos);
    if (this.host) {
      this.host.anchor.updateWorldMatrix(true, false);
      out.applyMatrix4(this.host.anchor.matrixWorld);
    }
    return { hovering: this.extCursorHovering, select: this.extCursorSelect };
  }

  /** One-line snapshot of the LAST visibility pass (see the render() probe)
   *  — the lab surfaces it while diagnosing the descended dollhouse. */
  debugCutaway(): string {
    return this.cutawayDebug;
  }

  /** The DOLLHOUSE rig pose for `frame` at orbit azimuth `spiritAz`, in
   *  WORLD coordinates (host mode lifts through the anchor; owner mode's
   *  manifold-local IS world) — the same numbers the spirit branch writes,
   *  WITHOUT touching the camera. The spirit ladder blends toward/away from
   *  this pose so a structure looks identical standalone and descended-to. */
  dollhousePose(
    frame: { x: number; y: number; w: number; h: number } | null,
    spiritAz: number,
    out: { pos: THREE.Vector3; look: THREE.Vector3; up: THREE.Vector3; fov: number },
  ): void {
    const state = this.pickState;
    const bounds = resolveDollhouseBounds(
      frame,
      state?.spec.buildings ?? this.spec.buildings ?? [],
      this.spec.manifold.width,
      this.spec.manifold.height,
      // Open ground (no frame, no buildings): frame the driven body, not the
      // whole manifold — the rect is content extent, not a subject.
      state ? state.avatars[state.drivenId] ?? null : null,
    );
    const gy = state ? standHeightAt(state, bounds.cx, bounds.cz) : 0;
    dollhousePoseMath(bounds, gy, spiritAz, out);
    if (this.host) {
      this.host.anchor.updateWorldMatrix(true, false);
      out.pos.applyMatrix4(this.host.anchor.matrixWorld);
      out.look.applyMatrix4(this.host.anchor.matrixWorld);
      out.up.transformDirection(this.host.anchor.matrixWorld);
    }
  }

  /** Drop an avatar's cached body model so the NEXT frame rebuilds it through
   *  the modelFactory — the POSSESSION seam: a factory that reads live session
   *  state (the possessed creature) re-skins the local walker without tearing
   *  the world down. No-op for an unknown id. */
  resetAvatarModel(id: string): void {
    const model = this.avatars.get(id);
    if (!model) return;
    this.scene.remove(model.object);
    model.dispose();
    this.avatars.delete(id);
  }

  /** Force an avatar's body (in)visible regardless of sim/cull state. Used by the
   *  walk↔fly coordinator to hide the town's local walker while airborne (the
   *  flight scene draws the flying body). Idempotent. */
  setAvatarHidden(id: string, hidden: boolean): void {
    if (hidden) this.hiddenAvatars.add(id);
    else this.hiddenAvatars.delete(id);
    const model = this.avatars.get(id);
    if (model) model.object.visible = !hidden;
  }

  /** Pointer (CSS px) → world point. The gaze STOPS at the first VISIBLE surface —
   *  a kept wall/door or an opaque roof/slab — so looking at a wall lands ON the
   *  wall, not the floor behind it; CUT walls (invisible) and LIFTED roofs (faded)
   *  are skipped, so the ray falls through them to whatever is actually visible.
   *  Falls back to the ground plane when nothing is hit. */
  /** HOST mode: put the town's meshes where the CURRENT camera frame says they
   *  are, before any raycast reads their `matrixWorld`.
   *
   *  The picks run during the host's step — BEFORE render() syncs the graph —
   *  and they ray in WORLD space off the live camera. But the planet spins and
   *  the flight rebases the world on the camera EVERY frame, so a town mesh
   *  still holding last frame's `matrixWorld` sits a full frame of planetary
   *  sweep away from where it is drawn. The ground plane below is rebuilt from
   *  the fresh anchor, so a stale mesh set made the pick flip between fresh
   *  plane and stale geometry — the gaze point jumped, the spark read the jump
   *  as travel and darted, walls blocked unreliably, and hovers flickered.
   *
   *  `updateWorldMatrix(true, true)` — parents AND descendants; the `false`
   *  child flag is exactly what left the town behind. Gated to once per frame:
   *  both picks in a step share one refresh, and render() bumps the counter. */
  private syncHostPickMatrices(): void {
    if (!this.host || this.pickSyncSeq === this.frameSeq) return;
    this.host.anchor.updateWorldMatrix(true, true);
    this.pickSyncSeq = this.frameSeq;
  }

  screenToWorld(px: number, py: number): Vec2 | null {
    this.syncHostPickMatrices();
    const ndcX = (px / this.vw) * 2 - 1;
    const ndcY = -((py / this.vh) * 2 - 1);
    this.raycaster.setFromCamera({ x: ndcX, y: ndcY } as THREE.Vector2, this.camera);
    // Gaze-blocking surfaces: visible tall wall bodies + doors, opaque roofs/slabs
    // (skip the low ridge/stubs so they don't stop the gaze).
    const targets: THREE.Object3D[] = [];
    for (const e of this.structureMeshes.values()) {
      if (e.tall) {
        if (e.tall.visible) targets.push(e.tall);
      } else if (e.object.visible) {
        targets.push(e.object);
      }
    }
    const OPAQUE = 0.5;
    for (const e of this.buildingMeshes.values()) {
      if (e.roof.visible && (e.roof.material as LitMaterial).opacity > OPAQUE) targets.push(e.roof);
      for (const s of e.slabs) {
        if (s.mesh.visible && (s.mesh.material as LitMaterial).opacity > OPAQUE) targets.push(s.mesh);
      }
    }
    const hits = this.raycaster.intersectObjects(targets, true);
    const geo = hits.length ? hits[0]! : null;
    // Ground plane: local (y = player level) in owner mode; in HOST mode the ray
    // + meshes live in the planet's WORLD frame, so raise the plane into world
    // (anchor up, through the local ground level) before intersecting.
    let groundPlane = this.groundPlane;
    if (this.host) {
      this.host.anchor.updateWorldMatrix(true, false);
      const localY = -this.groundPlane.constant; // n·p + c = 0 with n=+Y ⇒ y = -c
      const p0 = this._camPos.set(0, localY, 0).applyMatrix4(this.host.anchor.matrixWorld);
      const n = this._camUp.set(0, 1, 0).transformDirection(this.host.anchor.matrixWorld);
      groundPlane = this._hostPlane.setFromNormalAndCoplanarPoint(n, p0);
    }
    let ground = this.raycaster.ray.intersectPlane(groundPlane, this._gazeGround);
    // TERRAIN-TRUE refinement: worlds with a ground sampler march the ray
    // against the actual terrain. The single player-level plane displaces a
    // shallow ray by ~Δh/tan(depression) wherever the gazed ground sits
    // above/below the player's own level — over rolling country that is tens
    // of metres of cursor drift (below the pixel on rises, above it on
    // falls, growing away from the flat town site). Flat worlds keep the
    // plane (it IS the terrain there).
    const marched = this.marchGroundHit();
    if (marched) ground = marched;
    // DRAWN-WORLD override (embedded hosts): what the player SEES wins over
    // the analytic sampler — the streamed LOD meshes (and trees/roads) can
    // sit metres off it. The nearest-of logic below still lets this world's
    // own geometry (walls, roofs) beat the terrain hit.
    if (this.host?.castGroundRay) {
      const drawn = this.host.castGroundRay(
        this.raycaster.ray.origin, this.raycaster.ray.direction, GAZE_GROUND_MAX,
      );
      if (drawn) ground = drawn;
    }
    // The nearest of (first visible surface, ground).
    let point: THREE.Vector3 | null = null;
    if (geo && ground) {
      point = geo.distance < this.raycaster.ray.origin.distanceTo(ground) ? geo.point : ground;
    } else {
      point = geo ? geo.point : ground;
    }
    if (!point) return null;
    // HOST mode: the hit is in WORLD coords — pull it back to town-local, where
    // the sim's (x, y) live (y ← local z).
    if (this.host) this.host.anchor.worldToLocal(point);
    return { x: point.x, y: point.z };
  }

  /** Gaze ray → the TERRAIN under it, by bracketed bisection on the world's
   *  ground sampler (the ladder's rule: a bracket cannot diverge on the
   *  steep-hillside case that breaks plane-iterate schemes). Runs in the
   *  MANIFOLD-LOCAL frame (host mode pulls the ray through the anchor — a
   *  rigid transform, so ray parameters equal world metres). Returns the hit
   *  in the ray's own frame (world in host mode), or null when the world has
   *  no sampler / the ray grazes past all ground — callers keep the flat
   *  player-level plane as the fallback, which is exact on flat worlds. */
  private marchGroundHit(): THREE.Vector3 | null {
    const ground = this.pickState?.ground;
    if (!ground) return null;
    const o = this._gazeMarchO.copy(this.raycaster.ray.origin);
    const d = this._gazeMarchD.copy(this.raycaster.ray.direction);
    if (this.host) {
      this.host.anchor.updateWorldMatrix(true, false);
      this._pickInv.copy(this.host.anchor.matrixWorld).invert();
      o.applyMatrix4(this._pickInv);
      d.transformDirection(this._pickInv);
    }
    if (Math.abs(d.y) < 1e-9) return null;
    const above = (t: number): number =>
      o.y + t * d.y - ground(o.x + t * d.x, o.z + t * d.z);
    // Bracket seed: the player-level plane hit (the old v1 answer).
    const t0 = (-this.groundPlane.constant - o.y) / d.y;
    if (t0 <= 0) return null; // gaze above the horizon
    const h0 = above(t0);
    let tHit: number;
    if (Math.abs(h0) < GAZE_GROUND_EPS) {
      tHit = t0; // level ground: the plane IS the terrain
    } else {
      let lo = t0; // airborne end
      let hi = t0; // underground end
      let step = GAZE_GROUND_STEP;
      let bracketed = false;
      if (h0 > 0) {
        while (hi < GAZE_GROUND_MAX) {
          hi = Math.min(GAZE_GROUND_MAX, hi + step);
          if (above(hi) <= 0) { bracketed = true; break; }
          lo = hi;
          step *= 2;
        }
      } else {
        while (lo > 0) {
          lo = Math.max(0, lo - step);
          if (above(lo) > 0) { bracketed = true; break; }
          hi = lo;
          step *= 2;
        }
      }
      if (!bracketed) return null; // grazing over falling ground — plane fallback
      for (let i = 0; i < GAZE_GROUND_ITERS; i++) {
        const mid = (lo + hi) / 2;
        if (above(mid) > 0) lo = mid; else hi = mid;
      }
      tHit = (lo + hi) / 2;
    }
    const p = this._gazeGround.set(o.x + tHit * d.x, o.y + tHit * d.y, o.z + tHit * d.z);
    if (this.host) p.applyMatrix4(this.host.anchor.matrixWorld);
    return p;
  }

  /** What the pixel rests on VISUALLY — a speech bubble, an avatar's body/head
   *  sprite, or an object's mesh — nearest hit first. Pick roots are tagged with
   *  `userData.pick` at creation; a hit resolves by walking up to the tagged
   *  ancestor, so child meshes/sprites (emoji heads) count as their avatar. */
  pickScreen(px: number, py: number, opts?: { includeLocal?: boolean }): ScreenPick | null {
    this.syncHostPickMatrices(); // same stale-frame trap as screenToWorld
    const ndc = { x: (px / this.vw) * 2 - 1, y: -((py / this.vh) * 2 - 1) };
    this.raycaster.setFromCamera(ndc as THREE.Vector2, this.camera);
    const roots: THREE.Object3D[] = [];
    for (const b of this.bubbles.values()) roots.push(b.sprite);
    for (const m of this.avatars.values()) roots.push(m.object);
    for (const { mesh } of this.objectMeshes.values()) roots.push(mesh);
    // Resolve the nearest pick overall + the nearest OBJECT + nearest (non-local)
    // AVATAR, so item-priority can prefer a co-located item over a creature.
    let best: { pick: ScreenPick; dist: number } | null = null;
    let obj: { pick: ScreenPick; dist: number } | null = null;
    let av: { pick: ScreenPick; dist: number } | null = null;
    for (const hit of this.raycaster.intersectObjects(roots, true)) {
      // A fully-faded bubble sprite still raycasts — skip invisible hits.
      if (hit.object instanceof THREE.Sprite && (hit.object.material as THREE.SpriteMaterial).opacity <= 0.05) {
        continue;
      }
      let node: THREE.Object3D | null = hit.object;
      let pick: ScreenPick | undefined;
      while (node) {
        const p = node.userData.pick as ScreenPick | undefined;
        if (p) { pick = p; break; }
        node = node.parent;
      }
      if (!pick) continue;
      // The gaze can't rest on anything inside a HIDDEN room — an interior whose
      // roof is still on (a puzzle-locked area, or a room no open door reveals).
      // Refuse the hit and let the ray fall through to whatever's visible behind
      // it, so the player can neither dwell on nor select what they can't see.
      if (this.pickState) {
        const hitB = buildingAt(this.pickState, hit.point.x, hit.point.z);
        if (hitB && !this.pickVisible.has(hitB.id)) continue;
      }
      const isLocal = pick.kind === "avatar" && pick.id === this.localId;
      // The local avatar fills the lower screen in the shoulder view; by default the
      // ray passes THROUGH it to whatever's behind. Callers wanting to know the gaze
      // rests on the player (the spark) pass includeLocal.
      if (isLocal && !opts?.includeLocal) continue;
      if (!best) best = { pick, dist: hit.distance };
      if (pick.kind === "object" && !obj) obj = { pick, dist: hit.distance };
      if (pick.kind === "avatar" && !isLocal && !av) av = { pick, dist: hit.distance };
    }
    if (!best) return null;
    // A directly-gazed bubble wins (it asks for the shoulder framing).
    if (best.pick.kind === "bubble") return best.pick;
    // Item priority: an object at ~the same depth as (or nearer than) a creature
    // wins, so "dwell where an item sits on a creature" engages the item.
    if (obj && (!av || obj.dist <= av.dist + PICK_ITEM_MARGIN)) return obj.pick;
    return best.pick;
  }

  /** Live-update the camera/comfort tunables (the debug menu pushes these). */
  setTunables(t: { camera?: CameraTunables; comfort?: ComfortTunables }): void {
    if (t.camera) this.cameraCfg = mergeCamera(t.camera);
    if (t.comfort) {
      this.comfort = mergeComfort(t.comfort);
      this.vignetteUniforms.uInner.value = this.comfort.vignetteInner;
    }
  }

  /** Building ids whose roof is NOT fully opaque this frame — the see-inside fade
   *  has it transparent or still easing back, so the interior is on show. The
   *  town streamer keys interior population on this: a room's residents + furniture
   *  stay present while its roof is open and abstract only once it SEALS, so
   *  nobody/nothing pops out from under a still-transparent roof. */
  roofRevealedBuildings(): Set<string> {
    const out = new Set<string>();
    for (const [id, entry] of this.buildingMeshes) {
      const mat = entry.roof.material as LitMaterial;
      if (mat.opacity < ROOF_SEALED_OPACITY) out.add(id);
    }
    return out;
  }

  render(
    state: WorldState,
    dt: number,
    faceFor: (id: string) => CanvasImageSource | null,
    labelFor: (id: string) => string,
    glyphFor?: (glyph: string) => CanvasImageSource[] | null,
    intent?: RenderIntent,
    /** Bare (plate-less) glyph images for model-less objects; falls back to
     *  `glyphFor` when the host has no separate icon resolver. */
    glyphIconFor?: (glyph: string) => CanvasImageSource[] | null,
  ): void {
    this.frameSeq++; // next frame's picks must re-sync the host's world matrices
    // See-inside fade: reveal the interior of every building currently visible,
    // fading exactly the planes that sit between it and the camera. Visibility —
    // not the player's own building — is the single signal. AVATAR mode uses
    // visibleBuildings (the room you're in + every room an open door joins to
    // it) and the camera HEIGHT then decides which planes block the view. SPIRIT
    // mode is the "dollhouse": a formless overhead viewer sees every ACCESSIBLE
    // room (reachable through unlocked doors) unconditionally, while a puzzle
    // that LOCKS an area keeps its roof — so it reveals accessibleBuildings.
    const me = state.avatars[this.localId];
    // Roads build on the first frame, once the world's ground sampler is known.
    if (this.pendingRoads) {
      this.buildRoads(this.pendingRoads, this.pendingRoadColor, state.ground);
      this.pendingRoads = undefined;
    }
    // So does the FIELD: an irregular world's ground plane conforms to the
    // terrain (a hillside reads as a hillside, not bodies floating over a
    // flat sheet). Flat worlds keep the y=0 plane byte-identical.
    if (!this.fieldConformed) {
      this.fieldConformed = true;
      if (state.ground) this.conformField(state.ground);
    }
    // HOST mode: the shared camera lives in the planet's WORLD frame, but every
    // in-scene test below (fade, blackout, wall cuts, billboards) is authored
    // in town-LOCAL coords — refresh the LOCAL-FRAME camera stand-in once per
    // frame: pose = the shared camera mapped through the anchor's inverse.
    // Owner mode: camLocalFrame IS this.camera (one frame, no mapping).
    if (this.host) {
      this.host.anchor.updateWorldMatrix(true, false);
      this._invAnchorM.copy(this.host.anchor.matrixWorld).invert();
      this._invAnchorQ.setFromRotationMatrix(this._invAnchorM);
      this._hostCam.position.copy(this.camera.position).applyMatrix4(this._invAnchorM);
      this._hostCam.quaternion.multiplyQuaternions(this._invAnchorQ, this.camera.quaternion);
      this._hostCam.updateMatrixWorld();
    }
    const camPos = this.camLocalFrame.position;
    // Gaze picking intersects the ground at the PLAYER'S local level — a single
    // plane (v1): exact where the player stands, approximate for far aims on a
    // slope. Flat worlds keep the y=0 plane.
    this.groundPlane.constant = -(me ? standHeightAt(state, me.x, me.y) : 0);
    // INTERIOR REVEAL OFF = ordinary sealed buildings. The spirit GROUND rung
    // needs this: its local avatar is a parked stand-in, not an occupant, so
    // gliding past a house must not strip its walls — you are outside, in the
    // street. (A frameless spirit with reveal ON is still the whole-world
    // stationary dollhouse, which is why this is a flag and not a rule about
    // `spiritFrame`.)
    const visible = !this.interiorReveal
      ? new Set<string>()
      : this.spiritCamera
        ? accessibleBuildings(state, me ? { x: me.x, y: me.y } : undefined)
        : me
          ? visibleBuildings(state, { x: me.x, y: me.y })
          : new Set<string>();
    // FOCUSED dollhouse (a spirit focus WITH a frame — the ladder's structure
    // rung, the Sims dollhouse): only the focused footprint's interior is on
    // show. Accessible rooms OUTSIDE the frame render as ordinary sealed
    // buildings — roofs on, no cutaway, no blackout cube — so a town around
    // the focused house never strips its walls at a distance. A frameless
    // spirit focus (the whole-world stationary spirit) keeps the full reveal.
    if (this.spiritCamera && this.spiritFrame) {
      const sf = this.spiritFrame;
      for (const b of state.spec.buildings ?? []) {
        if (!visible.has(b.id)) continue;
        const f = b.footprint;
        const inFrame = f.x < sf.x + sf.w && f.x + f.w > sf.x && f.y < sf.y + sf.h && f.y + f.h > sf.y;
        if (!inFrame) visible.delete(b.id);
      }
    }
    // camY is RELATIVE to the occupant's ground level, so the storey-plane fade
    // math (floor × FLOOR_HEIGHT, ground-free) still holds on a sloped site.
    const fade: FadeContext = {
      visible,
      floor: me?.floor ?? 0,
      // Subtract the flight altitude too, so the storey-fade math stays rig-relative
      // (not "way above the roofs") while airborne.
      camY: camPos.y - (me ? standHeightAt(state, me.x, me.y) + (me.altitude ?? 0) : 0),
    };
    // The gaze pick reads these to refuse hits inside a hidden room.
    this.pickVisible = visible;
    this.pickState = state;

    // BLACKOUT set: hidden rooms drawn as the sealed cube (their walls/roof drop).
    // SPIRIT blacks out every hidden room; AVATAR only the ones the camera→player
    // sightline would expose, so a room the player isn't in stays a normal roofed
    // room. Uses last frame's camera (updateCamera runs at frame end).
    this.cutawayBlackout.clear();
    if (!this.interiorReveal) {
      // Nothing is revealed, so nothing may be blacked out either — with an
      // empty `visible` set the spirit branch below would swap EVERY building
      // for its sealed cube.
    } else if (this.spiritCamera) {
      const sf = this.spiritFrame;
      for (const b of state.spec.buildings ?? []) {
        if (visible.has(b.id)) continue;
        if (sf) {
          // Outside the focused frame: an ordinary sealed building, not a cube.
          const f = b.footprint;
          const inFrame = f.x < sf.x + sf.w && f.x + f.w > sf.x && f.y < sf.y + sf.h && f.y + f.h > sf.y;
          if (!inFrame) continue;
        }
        this.cutawayBlackout.add(b.id);
      }
    } else if (me) {
      const cxp = camPos.x;
      const czp = camPos.z;
      for (const b of state.spec.buildings ?? []) {
        if (visible.has(b.id)) continue;
        if (segmentEntersRect(cxp, czp, me.x, me.y, b.footprint)) this.cutawayBlackout.add(b.id);
      }
    }

    // LIVE CUTAWAY PROBE (debugCutaway): what the visibility pass actually
    // computed this frame — surfaced on the lab status line while diagnosing
    // the descended dollhouse. String only; no behaviour.
    {
      const dbgB = state.spec.buildings ?? [];
      const sf = this.spiritFrame;
      // What the WALL/DOOR sync actually applied LAST frame (mesh states).
      let tallN = 0;
      let tallCut = 0;
      let doorN = 0;
      let doorVis = 0;
      let roofOpen = 0;
      for (const e of this.structureMeshes.values()) {
        if (e.tall) {
          tallN++;
          if (!e.tall.visible) tallCut++;
        }
        if (e.door) {
          doorN++;
          if (e.object.visible) doorVis++;
        }
      }
      for (const e of this.buildingMeshes.values()) {
        const m = e.roof.material as LitMaterial;
        if (!e.roof.visible || m.opacity < 0.9) roofOpen++;
      }
      this.cutawayDebug =
        `${this.host ? "host" : "own"} ${this.vw}x${this.vh} ` +
        //`sp:${this.spiritCamera ? (sf ? `f(${Math.round(sf.x)},${Math.round(sf.y)},${Math.round(sf.w)}x${Math.round(sf.h)})` : "all") : "off"} ` +
        //`vis:${visible.size}/${dbgB.length} blk:${this.cutawayBlackout.size} ` +
        //`cut:${tallCut}/${tallN} door:${doorVis}/${doorN} roofOpen:${roofOpen} ` +
        // DECIDED-vs-APPLIED (last frame): hideW = walls the cutaway test wants
        // cut; built = meshes constructed that frame (>0 every frame = rebuild
        // thrash resetting opacity); rev = roofs asked to open, minOp = the
        // lowest revealed-roof opacity (stuck at 1.00 = the fade never ran).
        `hideW:${this.dbgWallHide} built:${this.dbgBuilt} ` +
        // ONE-CURSOR check: the HOST's spark. The ladder's overlay spark is
        // reported separately (main.ts `prov:`) — both with amp > 0 = two
        // cursors drawn, which reads as one spark with the wrong behaviour.
        `spk:${this.spark.debugState()} ` +
        //`rev:${this.dbgRoofRev} minOp:${this.dbgRoofMinOp.toFixed(2)} dt:${this.dbgDt.toFixed(4)} ` +
        `me:${me ? `${Math.round(me.x)},${Math.round(me.y)}@${buildingAt(state, me.x, me.y)?.id ?? "out"}` : "none"}`;
    }

    this.syncAvatars(state, dt, faceFor, labelFor, intent?.sitting ?? false, intent?.interactId, visible);
    this.syncStructures(state, fade, dt);
    this.syncObjects(state, intent?.interactId, fade, glyphIconFor ?? glyphFor, dt);
    this.syncBuildings(state, fade, dt);
    this.syncBubbles(state, glyphFor);
    this.updateCamera(state, dt, intent);
    this.updateComfort(state, dt);
    this.updateSpark(state, intent);
    this.spark.update(dt);
    this.overlay?.update(dt);

    // Scene, then the comfort vignette on top (autoClear is off). In HOST mode
    // the meshes are updated above but the flight composer draws the shared
    // scene — we neither clear nor draw (and skip the fullscreen vignette).
    if (!this.host) {
      this.renderer!.clear();
      this.renderer!.render(this.scene, this.camera);
      this.renderer!.clearDepth();
      this.renderer!.render(this.overlayScene, this.overlayCamera);
    }
  }

  /** Point the gaze spark at what the player is engaging: hovering over a
   *  highlighted creature/object, else resting at the effective gaze ground
   *  point, else fading out (no gaze this frame). Runs after syncObjects so the
   *  target object's mesh is placed. */
  private updateSpark(state: WorldState, intent?: RenderIntent): void {
    const cur = intent?.cursor;
    this.extCursorHas = false; // a frame with no target must read null, not stale
    if (!cur) {
      this.spark.hide();
      return;
    }
    const select = cur.selectProgress ?? 0;
    this.spark.setSelect(select);
    // Hover over whatever the gaze RESTS on (a creature's head / an object), else
    // skim the fixated ground point. Keyed on the cursor payload — NOT interactId —
    // so it never sticks to the carried item or the person being spoken to.
    const av = cur.hoverKind === "avatar" && cur.hoverId ? state.avatars[cur.hoverId] : undefined;
    if (av) {
      this.placeCursor(
        av.x,
        BUBBLE.headY + av.floor * FLOOR_HEIGHT + standHeightAt(state, av.x, av.y) + 0.15,
        av.y,
        true, // hovering a creature
        select,
      );
      return;
    }
    const entry = cur.hoverKind === "object" && cur.hoverId ? this.objectMeshes.get(cur.hoverId) : undefined;
    if (entry) {
      // Hover over the object's TOP, not its radius: `radius` is the footprint
      // half-extent, so a tall cabinet sank the spark inside itself. Measured
      // once per model and cached.
      const radius = state.spec.objects.find((o) => o.id === cur.hoverId)?.radius ?? 0.5;
      entry.topY ??= localTopY(entry.mesh, radius);
      const p = entry.mesh.position;
      this.placeCursor(p.x, p.y + entry.topY + SPARK_HOVER_GAP, p.z, true, select); // hovering an object
      return;
    }
    if (cur.point) {
      const floorY = (state.avatars[this.localId]?.floor ?? 0) * FLOOR_HEIGHT;
      this.placeCursor(
        cur.point.x,
        floorY + standHeightAt(state, cur.point.x, cur.point.y) + 0.45,
        cur.point.y,
        false, // skimming a bare ground point — not hovering anything
        select,
      );
      return;
    }
    this.spark.hide();
  }

  /** The one chokepoint every cursor target passes through: drive this
   *  renderer's own spark, or — under the external-cursor opt-out — stash the
   *  target (anchor-local) for the planet's spark to read and draw nothing. */
  private placeCursor(x: number, y: number, z: number, hovering: boolean, select: number): void {
    if (this.externalCursor) {
      this.extCursorPos.set(x, y, z);
      this.extCursorHovering = hovering;
      this.extCursorSelect = select;
      this.extCursorHas = true;
      this.spark.hide();
      return;
    }
    this.spark.setTarget(x, y, z, hovering);
  }

  /** Drive the vignette from how fast the camera is translating + rotating, so
   *  the periphery dims during motion (rotation weighted heaviest — it's the
   *  worst nausea trigger) and clears when you settle. */
  private updateComfort(state: WorldState, dt: number): void {
    const me = state.avatars[this.localId];
    const speed = me ? Math.hypot(me.vx, me.vy) : 0;
    const linT = Math.min(1, speed / this.comfort.refSpeed);
    const angT = Math.min(1, this.lastYawSpeed / this.comfort.refYaw);
    const motion = Math.min(1, linT * 0.5 + angT * 1.0);
    const targetStrength = motion * this.comfort.maxVignette;
    this.vignetteStrength +=
      (targetStrength - this.vignetteStrength) * (1 - Math.exp(-this.comfort.vignetteEase * Math.max(0, dt)));
    this.vignetteUniforms.uStrength.value = this.vignetteStrength;
  }

  /** The scene-space anchor a body's ACTIVITY poses onto: the BED a sleeper lies
   *  on ("sleep" naming a bed), or the SEAT a sitter takes ("sit" naming a chair
   *  or a privy — SEAT_TOP_FRAC). The body slides onto it and adopts the
   *  fixture's own heading, so a diner faces the table its chair faces.
   *
   *  Only a fixture present in BOTH the live objects and the spec resolves, and
   *  only one the recipes give a resolvable surface. Anything else — a doze in
   *  place, a scrub at the tub, an unknown id — returns null and the body
   *  performs the activity where it stands (the pre-existing behavior). */
  private resolveActivityAnchor(
    state: WorldState,
    a: AvatarState,
  ): { x: number; y: number; z: number; yaw: number } | null {
    const act = a.activity;
    if (!act || !act.objId) return null;
    const obj = state.objects[act.objId];
    const spec = state.spec.objects.find((o) => o.id === act.objId);
    if (!obj || !spec?.fixture) return null;
    const ground = standHeightAt(state, obj.x, obj.y) + obj.floor * FLOOR_HEIGHT;
    if (act.kind === "sleep") {
      if (spec.fixture !== "bed") return null;
      return { x: obj.x, y: ground + spec.radius * BED_TOP_FRAC, z: obj.y, yaw: bedSleeperYaw(spec.facing) };
    }
    if (act.kind === "sit") {
      const frac = SEAT_TOP_FRAC[spec.fixture];
      if (frac === undefined) return null; // no seat surface (a tub, a workbench)
      return { x: obj.x, y: ground + spec.radius * frac, z: obj.y, yaw: sitterYaw(spec.facing) };
    }
    return null;
  }

  private syncAvatars(
    state: WorldState,
    dt: number,
    faceFor: (id: string) => CanvasImageSource | null,
    labelFor: (id: string) => string,
    sitting: boolean,
    interactId: string | undefined,
    visible: Set<string>,
  ): void {
    // THE INDOOR CULL (render-only — mechanics never depend on the view):
    // a body inside a building is hidden unless that building's interior is
    // VISIBLE (visibleBuildings — the player's room + every room an open door
    // connects to it). Same rule the 2D overhead view runs — homebodies exist
    // behind their walls without costing a draw. Keying on visibility (not "the
    // player's own building") is what lets an adjacent room, seen through an
    // open door, show its people.
    // Add models for new avatars; update all present ones.
    for (const a of Object.values(state.avatars)) {
      const isLocal = a.id === this.localId;
      let model = this.avatars.get(a.id);
      if (!model) {
        model = this.modelFactory(a.id, isLocal);
        model.object.userData.pick = { kind: "avatar", id: a.id } satisfies ScreenPick;
        // A body-sized INVISIBLE pick target so looking anywhere on the whole
        // body (not just the head) engages the avatar — starting a conversation
        // is the default action. `colorWrite:false` keeps it unseen but still
        // raycastable; the pick tag on the root resolves the hit to the avatar.
        if (!isLocal) {
          const pickGeom = new THREE.BoxGeometry(0.8, 1.9, 0.8);
          const pickMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
          const pickBox = new THREE.Mesh(pickGeom, pickMat);
          pickBox.position.y = 0.95;
          model.object.add(pickBox);
          this.disposables.push(pickGeom, pickMat);
        }
        this.avatars.set(a.id, model);
        this.scene.add(model.object);
      }
      if (!isLocal) {
        const inBuilding = buildingAt(state, a.x, a.y);
        model.object.visible = !inBuilding || visible.has(inBuilding.id);
      }
      // Coordinator override (walk↔fly): a hidden avatar stays hidden this frame,
      // whatever the sim/cull decided above.
      if (this.hiddenAvatars.has(a.id)) model.object.visible = false;
      // Feet on the ground: terrain height under the body + the storey lift +
      // any FLIGHT altitude (metres above the ground; 0 for a grounded body).
      model.object.position.set(
        a.x,
        standHeightAt(state, a.x, a.y) + a.floor * FLOOR_HEIGHT + (a.altitude ?? 0),
        a.y,
      );
      model.update(
        {
          state: a,
          isLocal,
          speed: Math.hypot(a.vx, a.vy),
          faceSource: faceFor(a.id),
          label: labelFor(a.id),
          // LOCAL-frame camera — face/name billboards orient in scene-local
          // coords (under a host anchor the raw camera is planet-frame).
          camera: this.camLocalFrame,
          // Sitting is the local player's WATCH state (not networked yet).
          sitting: isLocal && sitting,
          highlighted: a.id === interactId,
          activityAnchor: this.resolveActivityAnchor(state, a),
        },
        dt,
      );
    }
    // Remove models for avatars that left.
    for (const [id, model] of this.avatars) {
      if (!state.avatars[id]) {
        this.scene.remove(model.object);
        model.dispose();
        this.avatars.delete(id);
      }
    }
  }

  /** Build each structure's mesh once, then (for doors) swing its leaf to match the
   *  live `open`. Walls are static; door pivots rotate from state.doors[id].open.
   *  STREAMED worlds replace the set (setStructures/setBuildings) — meshes whose
   *  structure left the spec are removed and disposed, or a long walk leaks the
   *  whole town behind you. */
  private syncStructures(state: WorldState, fade: FadeContext, dt: number): void {
    const structures = state.spec.structures;
    this.dbgWallHide = 0;
    this.dbgBuilt = 0;
    this.dbgDt = dt;
    if (!structures) return;
    if (structures !== this.lastStructureList) {
      this.lastStructureList = structures;
      const live = new Set(structures.map((s) => s.id));
      for (const [id, entry] of this.structureMeshes) {
        if (live.has(id)) continue;
        this.scene.remove(entry.object);
        entry.object.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          const m = mesh.material;
          if (m) (Array.isArray(m) ? m : [m]).forEach((mm) => mm.dispose());
        });
        this.structureMeshes.delete(id);
      }
    }
    for (const s of structures) {
      let entry = this.structureMeshes.get(s.id);
      if (!entry) {
        entry = this.buildStructure(s, this.structureBaseY(state, s));
        this.structureMeshes.set(s.id, entry);
        this.scene.add(entry.object);
        this.dbgBuilt++;
      }
      if (entry.door) {
        const door = state.doors[s.id];
        const open = door?.open ?? 0;
        entry.door.pivot.rotation.y = entry.door.thetaClosed + open * DOOR_SWING;
        // A still-locked door reads in a darker, "barred" colour. (A building's
        // color tints the LINTEL, not the leaf — the leaf must read as a door.)
        entry.door.leafMat.color.setHex(door?.locked ? STRUCTURE.doorLockedColor : STRUCTURE.doorColor);
      }
      const sFloor = s.kind === "stairs" ? undefined : s.floor;
      const b = s.kind === "stairs" ? null : buildingAt(state, (s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2);
      const inVisible = !!b && fade.visible.has(b.id);
      // Same cutaway for SPIRIT and AVATAR — open up the REVEALED room's interior
      // (cut the near/interior walls, keep the backmost), leaving the floor RIDGE +
      // corner STUBS behind. A wall bordering a blacked-out room goes too; a LOCKED
      // gate door is always kept. Collision is unaffected (engine-side, not mesh).
      let hide = false;
      if (s.kind === "wall" || s.kind === "door") {
        const lockedGate = s.kind === "door" && (state.doors[s.id]?.locked ?? false);
        hide = !lockedGate && this.wallHidden(state, s, fade.visible);
      }
      const storeyFade = inVisible && sFloor !== undefined && planeBlocks(fade, sFloor * FLOOR_HEIGHT);
      if (entry.tall && hide) this.dbgWallHide++;
      if (entry.tall) {
        // WALL: fade only the tall body; the ridge + stubs (group children) stay.
        // Cut → fully drop it (0, no ghost); else the storey see-inside fade.
        const target = hide ? 0 : storeyFade ? FADE_OPACITY : 1;
        const mat = entry.mats[0];
        if (mat) {
          const kk = 1 - Math.exp(-FADE_RATE * Math.max(0, dt));
          mat.opacity += (target - mat.opacity) * kk;
          if (Math.abs(mat.opacity - target) < 0.004) mat.opacity = target;
          mat.transparent = mat.opacity < 0.999;
          mat.depthWrite = mat.opacity > 0.6;
          entry.tall.visible = mat.opacity > 0.02;
        }
      } else {
        // DOOR / other: hide the whole group when cut, else the storey see-inside.
        entry.object.visible = !hide;
        if (!hide) for (const mat of entry.mats) fadeToward(mat, storeyFade, dt);
      }
    }
  }

  /** Cutaway: should this wall be HIDDEN so the REVEALED room's interior shows?
   *  Decided by sampling a point a hair to EACH side (robust for shared walls,
   *  where `buildingAt(mid)` on the boundary is ambiguous). A wall is cut only
   *  when it touches the revealed (`visible`) space:
   *   • borders a BLACKED-OUT room → hide (its cube stands in);
   *   • INTERIOR partition between two revealed rooms → hide (open the space);
   *   • a revealed room's boundary with a hidden room we're KEEPING → keep;
   *   • one side OUTDOORS → EXTERIOR wall: keep only the BACKMOST (outward face
   *     points away from the camera).
   *  Same rule for SPIRIT (visible = all accessible) and AVATAR (visible = the
   *  player's connected rooms) — only the visible/blackout sets differ. */
  private wallHidden(state: WorldState, s: { a: Vec2; b: Vec2 }, visible: Set<string>): boolean {
    const midX = (s.a.x + s.b.x) / 2;
    const midY = (s.a.y + s.b.y) / 2; // world Y (three.js Z)
    let nx = -(s.b.y - s.a.y);
    let ny = s.b.x - s.a.x;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const eps = 0.5; // just past the wall (thickness ~0.4) into whatever's on each side
    const plus = buildingAt(state, midX + nx * eps, midY + ny * eps);
    const minus = buildingAt(state, midX - nx * eps, midY - ny * eps);
    // Borders a blacked-out room → gone (its translucent cube stands in).
    if ((plus && this.cutawayBlackout.has(plus.id)) || (minus && this.cutawayBlackout.has(minus.id))) {
      return true;
    }
    const pv = !!plus && visible.has(plus.id);
    const mv = !!minus && visible.has(minus.id);
    // Only cut walls that touch the revealed space; everything else stays normal.
    if (!pv && !mv) return false;
    // Interior partition between two revealed rooms → open it up.
    if (pv && mv) return true;
    // Touches exactly ONE revealed room R (other side outdoors OR a hidden room).
    // Cut it if it's a NEAR wall of R — its outward face (away from R's center)
    // points toward the camera — so you see into R; keep the far/backmost walls.
    // A hidden room exposed this way is blacked out (sightline test in render()).
    const R = (pv ? plus : minus)!;
    const rcx = R.footprint.x + R.footprint.w / 2;
    const rcy = R.footprint.y + R.footprint.h / 2;
    let ox = nx;
    let oy = ny;
    if (ox * (midX - rcx) + oy * (midY - rcy) < 0) {
      ox = -ox; // outward = away from the revealed room's center
      oy = -oy;
    }
    // LOCAL-frame camera: in host mode the shared camera lives in the planet
    // frame — reading it raw here cut the WRONG side of every house.
    let cx = this.camLocalFrame.position.x - midX;
    let cy = this.camLocalFrame.position.z - midY;
    const cl = Math.hypot(cx, cy) || 1;
    cx /= cl;
    cy /= cl;
    return ox * cx + oy * cy > -0.15; // near (outward toward camera) → hide
  }

  /** Build each building's floor slabs + roof once, then ease exactly the planes
   *  of the OCCUPIED building that sit between the occupant and the camera —
   *  a slab above the camera still hides nothing, other buildings never fade. */
  private syncBuildings(state: WorldState, fade: FadeContext, dt: number): void {
    const buildings = state.spec.buildings;
    this.dbgRoofRev = 0;
    this.dbgRoofMinOp = 1;
    if (!buildings) return;
    // Streamed worlds swap the set — drop the roofs/slabs of buildings gone.
    if (buildings !== this.lastBuildingList) {
      this.lastBuildingList = buildings;
      const live = new Set(buildings.map((b) => b.id));
      for (const [id, entry] of this.buildingMeshes) {
        if (live.has(id)) continue;
        for (const s of entry.slabs) {
          this.scene.remove(s.mesh);
          s.mesh.geometry.dispose();
          (s.mesh.material as THREE.Material).dispose();
        }
        this.scene.remove(entry.roof);
        entry.roof.geometry.dispose();
        (entry.roof.material as THREE.Material).dispose();
        for (const m of [entry.hidden.floor, entry.hidden.cube]) {
          this.scene.remove(m);
          m.geometry.dispose();
          (m.material as THREE.Material).dispose();
        }
        this.buildingMeshes.delete(id);
      }
    }
    for (const b of buildings) {
      let entry = this.buildingMeshes.get(b.id);
      if (!entry) {
        entry = this.buildBuilding(b, buildingBaseY(state.ground, b.footprint));
        this.buildingMeshes.set(b.id, entry);
        for (const s of entry.slabs) this.scene.add(s.mesh);
        this.scene.add(entry.roof);
        this.scene.add(entry.hidden.floor);
        this.scene.add(entry.hidden.cube);
      }
      // A REVEALED room (the player's connected space in avatar mode, every
      // accessible room in spirit) opens up: its ROOF lifts so you see the whole
      // interior. A BLACKED-OUT hidden room swaps its walls/roof for the sealed
      // cube. An upper-storey SLAB still gates on camera height (the see-inside of
      // floors above the occupant). Non-revealed, non-blackout rooms keep roofs.
      const revealed = fade.visible.has(b.id);
      const ghost = this.cutawayBlackout.has(b.id);
      entry.hidden.floor.visible = ghost;
      entry.hidden.cube.visible = ghost;
      for (const { floor, mesh } of entry.slabs) {
        mesh.visible = !ghost;
        if (!ghost) {
          fadeToward(
            mesh.material as LitMaterial,
            revealed && (this.spiritCamera || planeBlocks(fade, floor * FLOOR_HEIGHT)),
            dt,
          );
        }
      }
      entry.roof.visible = !ghost;
      if (!ghost) fadeToward(entry.roof.material as LitMaterial, revealed, dt);
      // DIAGNOSTIC: is any roof even ASKED to open, and is its opacity moving?
      if (revealed) {
        this.dbgRoofRev++;
        this.dbgRoofMinOp = Math.min(
          this.dbgRoofMinOp,
          (entry.roof.material as LitMaterial).opacity,
        );
      }
    }
  }

  /** `baseY` = the site's ground level at the footprint center (buildingBaseY);
   *  every plane of the shell is lifted by it, so walls stay vertical. */
  private buildBuilding(b: BuildingSpec, baseY = 0): {
    slabs: { floor: number; mesh: THREE.Mesh }[];
    roof: THREE.Mesh;
    hidden: { floor: THREE.Mesh; cube: THREE.Mesh };
  } {
    const { x, y, w, h } = b.footprint;
    const cx = x + w / 2;
    const cz = y + h / 2;
    const slabs: { floor: number; mesh: THREE.Mesh }[] = [];
    // Upper-storey floor planes (the ground storey is the field itself).
    for (let f = 1; f < b.floors; f++) {
      const geom = new THREE.PlaneGeometry(w, h);
      const mat = structureMaterial(0x94a3b8, { side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(cx, baseY + f * FLOOR_HEIGHT, cz);
      this.disposables.push(geom, mat);
      slabs.push({ floor: f, mesh });
    }
    const roofGeom = new THREE.PlaneGeometry(w, h);
    // A colored building's roof carries its tint, darkened — "the blue house"
    // must read from the overhead camera too, where the roof IS the house.
    const roofColor = b.color
      ? new THREE.Color(b.color).multiplyScalar(0.65)
      : new THREE.Color(0x475569);
    const roofMat = structureMaterial(roofColor, { side: THREE.DoubleSide });
    const roof = new THREE.Mesh(roofGeom, roofMat);
    roof.rotation.x = -Math.PI / 2;
    roof.position.set(cx, baseY + b.floors * FLOOR_HEIGHT, cz);
    this.disposables.push(roofGeom, roofMat);

    // HIDDEN-room stand-in (spirit dollhouse): a locked room the player can't see
    // into is drawn as a black floor + a see-through cube — present + sealed, but
    // transparent so it never blocks the revealed rooms behind it. Hidden until a
    // frame decides this building is out of the visible set.
    const H = b.floors * FLOOR_HEIGHT;
    const hFloorGeom = new THREE.PlaneGeometry(w, h);
    const hFloorMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
    const hiddenFloor = new THREE.Mesh(hFloorGeom, hFloorMat);
    hiddenFloor.rotation.x = -Math.PI / 2;
    hiddenFloor.position.set(cx, baseY + 0.03, cz);
    hiddenFloor.visible = false;
    const cubeGeom = new THREE.BoxGeometry(w, H, h);
    const cubeMat = structureMaterial(0x334155, {
      transparent: true,
      opacity: 0.33,
      depthWrite: false,
    });
    const cube = new THREE.Mesh(cubeGeom, cubeMat);
    cube.position.set(cx, baseY + H / 2, cz);
    cube.visible = false;
    this.disposables.push(hFloorGeom, hFloorMat, cubeGeom, cubeMat);

    return { slabs, roof, hidden: { floor: hiddenFloor, cube } };
  }

  /** Replace the flat field with a terrain-conformed grid (world-frame
   *  vertices at ground height, a hair below placement level so feet/roads
   *  sit ON it) and retire the flat-world motion grid, which would slice
   *  through relief. */
  private conformField(ground: GroundSampler): void {
    const { width, height } = this.spec.manifold;
    const step = Math.max(2, Math.min(8, Math.max(width, height) / 160));
    const nx = Math.max(2, Math.ceil(width / step) + 1);
    const nz = Math.max(2, Math.ceil(height / step) + 1);
    const positions = new Float32Array(nx * nz * 3);
    let minY = Infinity;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = (i / (nx - 1)) * width;
        const z = (j / (nz - 1)) * height;
        const o = (j * nx + i) * 3;
        const gy = ground(x, z) - 0.05;
        positions[o] = x;
        positions[o + 1] = gy;
        positions[o + 2] = z;
        if (gy < minY) minY = gy;
      }
    }
    // The void backdrop must stay BENEATH the terrain everywhere — at its
    // flat-world −0.1 it would occlude every dip below it.
    this.voidPlane.position.y = Math.min(-0.1, minY - 2);
    const indices: number[] = [];
    for (let j = 0; j + 1 < nz; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    this.fieldMesh.geometry.dispose();
    this.fieldMesh.geometry = geom;
    this.fieldMesh.rotation.x = 0;
    this.fieldMesh.position.set(0, 0, 0);
    this.fieldGrid.visible = false;
  }

  /** Base height a structure is built at: its building's base when its midpoint
   *  falls inside one (the whole shell shares the footprint-center level), else
   *  the terrain under the midpoint. 0 on a flat world. */
  private structureBaseY(state: WorldState, s: StructureSpec): number {
    if (!state.ground) return 0;
    return s.kind === "stairs"
      ? standHeightAt(state, s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h / 2)
      : standHeightAt(state, (s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2);
  }

  /** A wall = an oriented box on the segment; a door = a hinged leaf box pivoted at
   *  its hinge endpoint (yaw updated each frame in syncStructures). World (x,y) →
   *  (x, baseY, y) — `baseY` is the site's ground level (structureBaseY). */
  private buildStructure(s: StructureSpec, baseY = 0): {
    object: THREE.Object3D;
    mats: LitMaterial[];
    door?: { pivot: THREE.Group; thetaClosed: number; leafMat: LitMaterial };
    tall?: THREE.Mesh;
  } {
    if (s.kind === "stairs") {
      // A tilted slab spanning the footprint, inclined so it rises one storey
      // along its ascent axis (read as a ramp; steps are a later refinement).
      const rise = (s.toFloor - s.fromFloor) * FLOOR_HEIGHT;
      const alongY = s.axis === "+y" || s.axis === "-y";
      const run = alongY ? s.rect.h : s.rect.w;
      const slope = Math.hypot(run, rise);
      const geom = new THREE.BoxGeometry(alongY ? s.rect.w : slope, 0.25, alongY ? slope : s.rect.h);
      const mat = structureMaterial(0x64748b, { roughness: 0.9 });
      const ramp = new THREE.Mesh(geom, mat);
      ramp.position.set(
        s.rect.x + s.rect.w / 2,
        baseY + ((s.fromFloor + s.toFloor) / 2) * FLOOR_HEIGHT,
        s.rect.y + s.rect.h / 2,
      );
      const angle = Math.atan2(rise, run);
      if (alongY) ramp.rotation.x = (s.axis === "+y" ? -1 : 1) * angle;
      else ramp.rotation.z = (s.axis === "+x" ? 1 : -1) * angle;
      this.disposables.push(geom, mat);
      return { object: ramp, mats: [mat] };
    }
    const dx = s.b.x - s.a.x;
    const dz = s.b.y - s.a.y;
    const len = Math.hypot(dx, dz);
    const floorY = (s.floor ?? 0) * FLOOR_HEIGHT;
    if (s.kind === "wall") {
      // A group in the wall's local frame (+X along the segment, +Y up, +Z across
      // thickness): a fadeable TALL body, plus a persistent floor RIDGE + a
      // diagonal corner STUB at each end. The ridge/stubs sit INSIDE the tall body
      // (thinner + shorter), so they're hidden until the dollhouse cut fades it —
      // then they read as "a wall is here".
      const group = new THREE.Group();
      group.position.set((s.a.x + s.b.x) / 2, baseY + floorY, (s.a.y + s.b.y) / 2);
      group.rotation.y = Math.atan2(-dz, dx);
      const wallColor = s.color ? new THREE.Color(s.color) : new THREE.Color(STRUCTURE.wallColor);

      const tallGeom = new THREE.BoxGeometry(len, STRUCTURE.wallHeight, s.thickness);
      const tallMat = structureMaterial(wallColor.clone(), { roughness: 0.9 });
      const tall = new THREE.Mesh(tallGeom, tallMat);
      tall.position.set(0, STRUCTURE.wallHeight / 2, 0);
      group.add(tall);

      const ridgeGeom = new THREE.BoxGeometry(len, STRUCTURE.ridgeHeight, s.thickness * 0.9);
      const ridgeMat = structureMaterial(wallColor.clone().multiplyScalar(0.7));
      const ridge = new THREE.Mesh(ridgeGeom, ridgeMat);
      ridge.position.set(0, STRUCTURE.ridgeHeight / 2, 0);
      group.add(ridge);
      this.disposables.push(tallGeom, tallMat, ridgeGeom, ridgeMat);

      for (const end of [-1, 1] as const) {
        const stub = this.buildWallStub(s.thickness * 0.9, wallColor);
        stub.position.set((end * len) / 2, 0, 0);
        if (end > 0) stub.rotation.y = Math.PI; // tall edge at the +X end, tapering inward
        group.add(stub);
      }
      return { object: group, mats: [tallMat], tall };
    }
    // Door: hinge at the chosen endpoint, leaf extends toward the other.
    const hinge = s.hinge === "b" ? s.b : s.a;
    const other = s.hinge === "b" ? s.a : s.b;
    const hdx = other.x - hinge.x;
    const hdz = other.y - hinge.y;
    const thetaClosed = Math.atan2(-hdz, hdx);
    const group = new THREE.Group();
    const pivot = new THREE.Group();
    pivot.position.set(hinge.x, baseY + floorY, hinge.y);
    pivot.rotation.y = thetaClosed;
    group.add(pivot);
    const geom = new THREE.BoxGeometry(len, STRUCTURE.doorHeight, s.thickness);
    const leafMat = structureMaterial(STRUCTURE.doorColor, { roughness: 0.7 });
    const leaf = new THREE.Mesh(geom, leafMat);
    // Centre the box so its near edge sits at the hinge and it spans toward `other`.
    leaf.position.set(len / 2, STRUCTURE.doorHeight / 2, 0);
    pivot.add(leaf);
    this.disposables.push(geom, leafMat);
    const mats: LitMaterial[] = [leafMat];
    // A real doorway: the leaf is door-height (2.1 m), the wall continues above
    // it as a LINTEL up to the storey height, tinted like the wall it sits in.
    const lintelH = STRUCTURE.wallHeight - STRUCTURE.doorHeight;
    if (lintelH > 0.05) {
      const lintelGeom = new THREE.BoxGeometry(len, lintelH, s.thickness);
      const lintelMat = structureMaterial(s.color ? new THREE.Color(s.color) : STRUCTURE.wallColor, {
        roughness: 0.9,
      });
      const lintel = new THREE.Mesh(lintelGeom, lintelMat);
      lintel.position.set(
        (s.a.x + s.b.x) / 2,
        STRUCTURE.doorHeight + lintelH / 2 + floorY + baseY,
        (s.a.y + s.b.y) / 2,
      );
      lintel.rotation.y = Math.atan2(-dz, dx);
      group.add(lintel);
      this.disposables.push(lintelGeom, lintelMat);
      mats.push(lintelMat);
    }
    return { object: group, mats, door: { pivot, thetaClosed, leafMat } };
  }

  /** A triangular corner stub for the dollhouse cutaway: full stub-height at local
   *  X=0 (the standing-wall corner), tapering down to the ridge over `stubRun`
   *  toward +X. Extruded across `thickness`, centered on Z, in the wall's frame. */
  private buildWallStub(thickness: number, color: THREE.Color): THREE.Mesh {
    const shape = new THREE.Shape();
    shape.moveTo(0, STRUCTURE.ridgeHeight);
    shape.lineTo(STRUCTURE.stubRun, STRUCTURE.ridgeHeight);
    shape.lineTo(0, STRUCTURE.stubHeight);
    shape.closePath();
    const geom = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
    geom.translate(0, 0, -thickness / 2); // center across the wall thickness
    const mat = structureMaterial(color.clone().multiplyScalar(0.85), { roughness: 0.9 });
    this.disposables.push(geom, mat);
    return new THREE.Mesh(geom, mat);
  }

  private syncObjects(
    state: WorldState,
    interactId?: string,
    fade: FadeContext | null = null,
    iconFor?: (glyph: string) => CanvasImageSource[] | null,
    dt = 0,
  ): void {
    // Streamed objects (furniture) leave with their house — drop their meshes.
    for (const [id, entry] of this.objectMeshes) {
      if (state.objects[id]) continue;
      this.scene.remove(entry.mesh);
      this.scene.remove(entry.shadow);
      entry.model?.dispose();
      this.objectMeshes.delete(id);
    }
    for (const obj of Object.values(state.objects)) {
      const spec = state.spec.objects.find((o) => o.id === obj.id);
      const radius = spec?.radius ?? 0.5;
      let entry = this.objectMeshes.get(obj.id);
      if (!entry) {
        // Prefer a real procedural 3D model for the object's identity; FAILSAFE
        // to the generic box/sphere when there's no recipe (a new/queued type).
        let mesh: THREE.Object3D;
        let materials: LitMaterial[];
        const model =
          buildObjectModel({ iconRef: spec?.iconRef, glyph: spec?.glyph, fixture: spec?.fixture, radius }) ?? undefined;
        if (model) {
          mesh = model.object;
          materials = model.materials;
        } else {
          // No recipe: the object IS its glyph — a bare billboarded symbol, with
          // no generic body under it (a sphere/box reads as a different thing
          // than the symbol says). An empty group carries the pick tag and the
          // icon sprite; the sprite itself raycasts, and pickScreen resolves a
          // hit by walking up to this tagged root.
          mesh = new THREE.Group();
          materials = [];
        }
        const shadowGeom = new THREE.CircleGeometry(radius * 1.1, 20);
        const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.2 });
        const shadow = new THREE.Mesh(shadowGeom, shadowMat);
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = 0.02;
        this.scene.add(mesh);
        this.scene.add(shadow);
        this.disposables.push(shadowGeom, shadowMat);
        entry = { mesh, shadow, materials, model };
        // A modeled object shows its descriptors PHYSICALLY (color/size/heat), so
        // it needs no floating symbol. Only the FAILSAFE (generic shape) wears the
        // emoji icon so it still reads as what it is.
        if (!model && spec?.iconRef) {
          const icon = makeEmojiSprite(spec.iconRef);
          icon.sprite.position.set(0, iconStandY(radius), 0);
          mesh.add(icon.sprite);
          this.disposables.push(icon.tex, icon.mat);
          entry.icon = icon.sprite;
        }
        mesh.userData.pick = { kind: "object", id: obj.id } satisfies ScreenPick;
        this.objectMeshes.set(obj.id, entry);
      }
      if (entry.model) {
        // A live glyph change (a transformed item apple.cold → apple.hot, or a
        // descriptor edit) re-applies color/size/temperature to the model.
        if (entry.glyphKey !== spec?.glyph) {
          entry.model.applyDescriptors(spec?.glyph);
          entry.glyphKey = spec?.glyph;
          entry.topY = undefined; // descriptors resize the shell — re-measure
        }
        entry.model.update(state.time);
        // A lidded fixture's swing follows its eased `open`; a fixture
        // faces INTO the room (spec.facing), not its carrier.
        if (spec?.fixture) {
          entry.model.setOpen?.(obj.open);
          entry.mesh.rotation.y = fixtureYaw(spec.facing);
        }
        // Carried objects turn to face the way their carrier faces (a recipe's
        // forward is +X; align it with the possessor's facing vector).
        const holder = obj.possessedBy ?? obj.carriedBy;
        if (holder) {
          const carrier = state.avatars[holder];
          if (carrier) entry.mesh.rotation.y = Math.atan2(-carrier.fy, carrier.fx);
        }
      } else if (spec?.glyph && entry.glyphKey !== spec.glyph && iconFor) {
        // Failsafe object: swap the emoji for the composed glyph image once the
        // game's resolver has decoded it (async), keyed on the glyph string.
        const images = iconFor(spec.glyph);
        const img = images?.[0];
        if (img) {
          if (entry.icon) entry.mesh.remove(entry.icon);
          const icon = makeGlyphIconSprite(img as GlyphImage);
          icon.sprite.position.set(0, iconStandY(radius), 0);
          entry.mesh.add(icon.sprite);
          this.disposables.push(icon.tex, icon.mat);
          entry.icon = icon.sprite;
          entry.glyphKey = spec.glyph;
        }
      }
      // Containment lifts/lowers the object so on/in/under read as relations.
      let y = radius;
      if (obj.carriedBy) {
        // HELD: ride at hand height — the carry-pose arms grip about here
        // (a grounded "carried" object read as pushed along, not held).
        y = 0.75;
      } else if (obj.containedIn) {
        const container = state.spec.objects.find((o) => o.id === obj.containedIn!.objectId);
        const cr = container?.radius ?? 0.5;
        // A table's top is LOW (decoupled from its footprint radius — see
        // TABLE_TOP_Y); every other container is a full cube, top at 2×r.
        const topY = container?.fixture === "table" ? TABLE_TOP_Y : cr * 2;
        if (obj.containedIn.relation === "on") y = topY + radius;
        else if (obj.containedIn.relation === "in") y = cr;
        // "under" stays on the ground (beneath the container's top).
      }
      const floorY = obj.floor * FLOOR_HEIGHT + standHeightAt(state, obj.x, obj.y);
      entry.mesh.position.set(obj.x, y + floorY, obj.y);
      entry.shadow.position.set(obj.x, 0.02 + floorY, obj.y);
      // Possession tint marks the owner; an INTERACT highlight (gaze on a free
      // object) pulses cyan. Applied across every material of the model.
      // Objects fade with the storey they stand on (same plane rule as slabs),
      // only inside a REVEALED building.
      const objBuilding = fade ? buildingAt(state, obj.x, obj.y) : null;
      const faded =
        !!fade &&
        obj.floor > fade.floor &&
        !!objBuilding &&
        fade.visible.has(objBuilding.id) &&
        fade.camY > obj.floor * FLOOR_HEIGHT - CAM_FADE_MARGIN;
      for (const mat of entry.materials) {
        if (obj.possessedBy) {
          mat.emissive = colorForId(obj.possessedBy);
          mat.emissiveIntensity = 0.35;
        } else if (obj.id === interactId) {
          mat.emissive.set("#38bdf8");
          mat.emissiveIntensity = 0.35 + 0.2 * Math.sin(state.time * 5);
        } else {
          mat.emissiveIntensity = 0;
        }
        // Floor-fade objects sitting on a storey above the occupant.
        fadeToward(mat, faded, dt);
      }
      entry.shadow.visible = !faded;
    }
  }

  /** Draw every live world bubble (state.bubbles), keyed by its caller id and
   *  floated over its anchor — an avatar (tracked each frame) or a fixed world
   *  point (a character/object/caption). One path for networked utterances and
   *  in-game speech alike. Bubbles live directly in the scene (auto-billboarded). */
  private syncBubbles(state: WorldState, glyphFor?: (glyph: string) => CanvasImageSource[] | null): void {
    // Screen-up in world space, shared by every bubble this frame.
    const up = this._bubbleUp.set(0, 1, 0).applyQuaternion(this.camLocalFrame.quaternion);
    const live = new Set<string>();
    for (const [key, b] of Object.entries(state.bubbles)) {
      const pos = b.anchor.kind === "avatar" ? state.avatars[b.anchor.id] : b.anchor;
      const alpha = pos ? bubbleAlpha(b.at, state.time, b.ttl) : 0;
      if (alpha <= 0 || !pos) continue;
      live.add(key);
      let bubble = this.bubbles.get(key);
      if (!bubble) {
        bubble = new Bubble3D();
        bubble.sprite.userData.pick = { kind: "bubble", id: key } satisfies ScreenPick;
        this.bubbles.set(key, bubble);
        this.scene.add(bubble.sprite);
      }
      const glyphs = b.glyph ? glyphFor?.(b.glyph) ?? [] : [];
      const floor = b.anchor.kind === "avatar" ? state.avatars[b.anchor.id]?.floor ?? 0 : 0;
      bubble.setContent(b.text, b.at, glyphs, b.style ?? "speech");
      bubble.place(pos.x, pos.y, alpha, floor * FLOOR_HEIGHT + standHeightAt(state, pos.x, pos.y), up);
    }
    // Drop sprites whose bubble expired or was removed.
    for (const [key, bubble] of this.bubbles) {
      if (!live.has(key)) {
        this.scene.remove(bubble.sprite);
        bubble.dispose();
        this.bubbles.delete(key);
      }
    }
  }

  private updateCamera(state: WorldState, dt: number, intent?: RenderIntent): void {
    // SPIRIT: a FIXED angled-overhead vantage that frames the whole manifold. The
    // formless player never moves, so there is nothing to follow — a static
    // camera over the scene lets the gaze reach every object/person (the spirit
    // interacts at any distance). Set once; cheap to re-assert each frame.
    if (this.spiritCamera) {
      // DOLLHOUSE: frame the house at a fixed LOW 3/4 angle. Slice-2 control,
      // ORBIT-ONLY for now (room-dolly + pull-up disabled pending feel tuning):
      // gaze far LEFT/RIGHT rotates the camera around the house; the screen center
      // is a dead-zone so a resting gaze just interacts. The orbit direction
      // depends on which HALF of the turntable the gaze sits on (see below) so a
      // side gaze always swings that point toward center.
      const step = Math.max(0, dt);
      const lookY = FLOOR_HEIGHT * 0.55;
      // One bounds/pose formula shared with the public dollhousePose()
      // (the spirit ladder blends against the SAME numbers).
      const bounds = resolveDollhouseBounds(
        this.spiritFrame, state.spec.buildings ?? [],
        this.spec.manifold.width, this.spec.manifold.height,
        // Open ground: frame the driven body (see resolveDollhouseBounds).
        state.avatars[state.drivenId] ?? null,
      );
      const cx = bounds.cx;
      const cz = bounds.cz;
      // The fixed vantage rides the site's ground level at the framed center.
      const gy = standHeightAt(state, cx, cz);

      // ORBIT: project the gaze fixation to screen NDC (via last frame's camera);
      // far left/right past the dead-zone rotates the camera, ramped by distance.
      const gaze = intent?.cursor?.point ?? null;
      if (gaze) {
        const v = this._camScratch.set(gaze.x, lookY + gy, gaze.y).project(this.camera);
        if (Number.isFinite(v.x) && Number.isFinite(v.y)) {
          const EDGE = 0.62;
          const ORBIT = 1.3; // rad/s at full deflection
          const VBAND = 0.28; // v.y span over which the near/far flip eases through 0
          // The rotation center projects to the screen middle (the camera looks
          // straight at it), so v.y's sign says which HALF of the turntable the
          // gaze is on: BELOW center (near side, v.y<0) a left gaze orbits one way;
          // ABOVE center (far side) the same screen edge is the OPPOSITE rim, so the
          // spin reverses — either way the gazed point swings toward center.
          //
          // That crossover row is NOT fixed on screen, though: the gaze point rides
          // the ground plane, so orbiting the house slides its re-projected v.y
          // around. A hard sign flip there chatters (rapid vibration) when the gaze
          // rests near it. Instead RAMP the direction smoothly through zero across a
          // band around the crossover — so vertical gaze still reverses the spin (and
          // scales its speed), but right at the crossover the rate eases to nothing,
          // so jitter there barely moves the house.
          const dir = -Math.max(-1, Math.min(1, v.y / VBAND));
          if (v.x < -EDGE) this.spiritAz += dir * ORBIT * ((-EDGE - v.x) / (1 - EDGE)) * step;
          else if (v.x > EDGE) this.spiritAz -= dir * ORBIT * ((v.x - EDGE) / (1 - EDGE)) * step;
        }
      }

      // host mode: don't stomp the shared camera; owner mode drives unless an
      // external rig (the spirit ladder) claimed the camera.
      const drive = this.driveCamera || (!this.host && !this.externalCamera);
      if (drive) {
        // Build the pose in MANIFOLD-LOCAL coords (the ONE formula)…
        dollhousePoseMath(bounds, gy, this.spiritAz, this._dollPose);
        if (Math.abs(this._dollPose.fov - this.camera.fov) > 1e-3) {
          this.camera.fov = this._dollPose.fov;
          this.camera.updateProjectionMatrix();
        }
        this._camPos.copy(this._dollPose.pos);
        this._camLook.copy(this._dollPose.look);
        this._camUp.copy(this._dollPose.up);
        // …then, when EMBEDDED on a planet, lift it into world space through the
        // host anchor (positioned + oriented on the body) — the same transform the
        // grounded chase rig applies (see ~1446). Without this, a host-driven
        // dollhouse (the spirit street-level handoff) would place the camera in raw
        // manifold coords, kilometres off the town on the planet's surface. Gated
        // on `this.host` so standalone (owner-mode) framing is byte-identical.
        if (this.host) {
          this.host.anchor.updateWorldMatrix(true, false);
          this._camPos.applyMatrix4(this.host.anchor.matrixWorld);
          this._camLook.applyMatrix4(this.host.anchor.matrixWorld);
          this._camUp.transformDirection(this.host.anchor.matrixWorld);
        }
        this.camera.position.copy(this._camPos);
        this.camera.up.copy(this._camUp);
        this.camera.lookAt(this._camLook);
      }
      this.lastYawSpeed = 0;
      if (!this.camCenter) this.camCenter = new THREE.Vector3(cx, 0, cz);
      return;
    }
    const me = state.avatars[this.localId];
    const step = Math.max(0, dt);
    const cam = this.cameraCfg;
    // The camera's heading follows the GAZE FIXATION (cursor.point), not the engine
    // `aim`. So it keeps responding to where you look even when the avatar is frozen
    // — while SITTING (aim null) you can still look around; only the body stays put.
    const gaze = intent?.cursor?.point ?? intent?.aim ?? null;

    // Position: ease the followed centre toward the local avatar.
    const target = this._scratch.set(
      me ? me.x : this.spec.manifold.width / 2,
      0,
      me ? me.y : this.spec.manifold.height / 2,
    );
    if (!this.camCenter) {
      this.camCenter = target.clone();
      // HOST mode (fresh grab of the shared camera — e.g. just landed): start
      // the heading BEHIND the avatar along its facing, so the first grounded
      // frame looks the way the landing was moving instead of slewing across
      // the town from a stale heading. Owner mode keeps the -Z spawn framing.
      if (this.host && me) {
        const l = Math.hypot(me.fx, me.fy);
        if (l > 1e-3) this.camForward.set(me.fx / l, 0, me.fy / l);
      }
    } else {
      this.camCenter.lerp(target, 1 - Math.exp(-cam.follow * step));
    }

    // Travel direction + gaze distance from the AIM (not raw velocity): the camera
    // commits to where the player is steering, which is what makes the rig
    // predictable (driving heading from twitchy velocity feeds the spin loop).
    let gazeDistance = 0;
    let aimx = 0;
    let aimz = 0;
    let haveDir = false;
    if (me && gaze) {
      const dx = gaze.x - me.x;
      const dz = gaze.y - me.y;
      gazeDistance = Math.hypot(dx, dz);
      if (gazeDistance > 1e-3) {
        aimx = dx / gazeDistance;
        aimz = dz / gazeDistance;
        haveDir = true;
      }
    }
    // How aligned the aim is with the current heading: + = ahead (screen-top), − =
    // behind. Decides the overhead↔shoulder transition (computed pre-turn).
    const ahead = haveDir ? aimx * this.camForward.x + aimz * this.camForward.z : -1;

    // Heading: ease toward the gaze direction. Held when the gaze is on the avatar
    // (gd ≤ moveThreshold) or absent — so a watcher's glances never rotate the world
    // — but NOT gated on sitting (a seated player still looks around). Turn rate is
    // capped BOTH by the gaze-distance rule (near gaze ⇒ fast pivot, far gaze ⇒ slow
    // reveal) AND comfort.maxYawSpeed. A `faceTarget` (NPC conversation) OVERRIDES
    // the gaze: the avatar is frozen but the view slews to face the speaker.
    const faceTarget = intent?.faceTarget ?? null;
    let tgtAngle: number | null = null;
    let facing = false;
    if (faceTarget && this.camCenter) {
      const dx = faceTarget.x - this.camCenter.x;
      const dz = faceTarget.y - this.camCenter.z;
      if (Math.hypot(dx, dz) > 1e-3) { tgtAngle = Math.atan2(dx, dz); facing = true; }
    } else if (haveDir && gazeDistance > cam.moveThreshold) {
      tgtAngle = Math.atan2(aimx, aimz);
    }
    let appliedYaw = 0;
    if (tgtAngle !== null) {
      const cur = Math.atan2(this.camForward.x, this.camForward.z);
      let delta = Math.atan2(Math.sin(tgtAngle - cur), Math.cos(tgtAngle - cur)); // shortest turn
      if (Math.abs(delta) < this.comfort.yawDeadband) delta = 0;
      let stepAngle = delta * (1 - Math.exp(-cam.yawStiffness * step));
      const effMax = facing
        ? this.comfort.maxYawSpeed
        : Math.min(this.comfort.maxYawSpeed, cam.yawDistGain / Math.max(gazeDistance, cam.yawDistMin));
      const maxStep = effMax * step;
      if (stepAngle > maxStep) stepAngle = maxStep;
      else if (stepAngle < -maxStep) stepAngle = -maxStep;
      const next = cur + stepAngle;
      this.camForward.set(Math.sin(next), 0, Math.cos(next));
      appliedYaw = stepAngle;
    }
    this.lastYawSpeed = step > 0 ? Math.abs(appliedYaw) / step : 0;

    // Over-the-shoulder is the DEFAULT; the camera lifts to overhead ONLY when the
    // gaze points behind the avatar — so "look behind me" pivots the world from
    // above instead of whipping the shoulder cam 180°. Two thresholds give a
    // hysteresis band (travelAheadExit … travelAheadEnter) so a gaze hovering near
    // straight-across doesn't flip-flop. No aim ⇒ shoulder (there's no "behind").
    const gazeBehind = haveDir && ahead < cam.travelAheadExit; // clearly behind → overhead
    const gazeAhead = !haveDir || ahead > cam.travelAheadEnter; // clearly ahead → shoulder
    // An explicit shoulder REQUEST (gaze on a speech bubble / conversation speaker)
    // always wins.
    if (intent?.shoulder || gazeAhead) this.travelTarget = 1;
    else if (gazeBehind) this.travelTarget = 0;
    // else: inside the band — hold the current pose.
    this.travelCommit += (this.travelTarget - this.travelCommit) * (1 - Math.exp(-cam.travelEase * step));

    // Interpolate the rig pose and (only when it actually moved) the FOV.
    const t = this.travelCommit;
    const o = cam.overhead;
    const s = cam.shoulder;
    this.rig.height = lerp(o.height, s.height, t);
    this.rig.back = lerp(o.back, s.back, t);
    this.rig.lookAhead = lerp(o.lookAhead, s.lookAhead, t);
    this.rig.lookHeight = lerp(o.lookHeight, s.lookHeight, t);
    const fov = lerp(o.fov, s.fov, t);
    // HOST mode: only write the shared camera when WALKING owns the view
    // (driveCamera); while the flight camera is in charge we just ease our rig
    // state so the handoff back to walking is smooth. Owner mode drives
    // unless an external rig (the spirit ladder) claimed the camera.
    const drive = this.driveCamera || (!this.host && !this.externalCamera);
    if (drive && Math.abs(fov - this.camera.fov) > 1e-3) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.rig.fov = fov;

    const c = this.camCenter;
    // FLIGHT: the follow camera rides the followed body's altitude, so lifting
    // off raises the whole rig with the avatar (no scene swap). 0 when grounded.
    const followAlt = state.avatars[this.localId]?.altitude ?? 0;
    if (drive) this.placeCamera(c.x, c.z, standHeightAt(state, c.x, c.z) + followAlt);
  }

  dispose(): void {
    this.overlay?.dispose();
    for (const model of this.avatars.values()) {
      this.scene.remove(model.object);
      model.dispose();
    }
    this.avatars.clear();
    for (const entry of this.objectMeshes.values()) {
      this.scene.remove(entry.mesh);
      this.scene.remove(entry.shadow);
      entry.model?.dispose();
    }
    this.objectMeshes.clear();
    for (const { object } of this.structureMeshes.values()) {
      this.scene.remove(object);
    }
    this.structureMeshes.clear();
    for (const { slabs, roof } of this.buildingMeshes.values()) {
      for (const s of slabs) this.scene.remove(s.mesh);
      this.scene.remove(roof);
    }
    this.buildingMeshes.clear();
    for (const bubble of this.bubbles.values()) {
      this.scene.remove(bubble.sprite);
      bubble.dispose();
    }
    this.bubbles.clear();
    this.spark.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    // HOST mode: detach our content root from the shared scene; the flight
    // composer owns (and disposes) the GL renderer.
    if (this.host) this.host.anchor.remove(this.scene);
    else this.renderer!.dispose();
  }
}

// ---------------------------------------------------------------------------
// WorldView adapter
// ---------------------------------------------------------------------------

/** Wrap the Three.js renderer as a WorldView so SocialWorldCanvas can drive it
 *  identically to the 2D view (same screenToWorld / render / resize / dispose). */
export function createWorld3DView(
  deps: WorldViewDeps,
  spec: WorldSpec,
  opts?: {
    modelFactory?: AvatarModelFactory;
    backdrop?: string;
    overlay?: SceneOverlay;
    roads?: RoadPath[];
    roadColor?: string;
    spirit?: boolean;
    spiritFrame?: { x: number; y: number; w: number; h: number };
    /** Embed into a host scene (space flight) instead of owning a canvas. */
    host?: RenderHost;
  },
): WorldView {
  const { canvas, localId, faceFor, labelFor, glyphFor, glyphIconFor } = deps;
  const renderer = new World3DRenderer(canvas, spec, {
    localId,
    overlay: opts?.overlay,
    modelFactory: opts?.modelFactory,
    backdrop: opts?.backdrop,
    roads: opts?.roads,
    roadColor: opts?.roadColor,
    spirit: opts?.spirit,
    spiritFrame: opts?.spiritFrame,
    host: opts?.host,
  });
  return {
    screenToWorld: (px, py) => renderer.screenToWorld(px, py),
    pickScreen: (px, py) => renderer.pickScreen(px, py),
    revealedBuildings: () => renderer.roofRevealedBuildings(),
    render: (state, dt, intent) => renderer.render(state, dt, faceFor, labelFor, glyphFor, intent, glyphIconFor),
    resize: (width, height, dpr) => renderer.resize(width, height, dpr),
    setTunables: (t) => renderer.setTunables({ camera: t.camera, comfort: t.comfort }),
    setDriveCamera: (on) => renderer.setDriveCamera(on),
    setSpiritFocus: (frame) => renderer.setSpiritFocus(frame),
    setExternalCamera: (on) => renderer.setExternalCamera(on),
    setExternalCursor: (on) => renderer.setExternalCursor(on),
    setInteriorReveal: (on) => renderer.setInteriorReveal(on),
    externalCursorWorld: (out) => renderer.externalCursorWorld(out),
    camera: renderer.getCamera(),
    dollhousePose: (frame, spiritAz, out) => renderer.dollhousePose(frame, spiritAz, out),
    debugCutaway: () => renderer.debugCutaway(),
    setAvatarHidden: (id, hidden) => renderer.setAvatarHidden(id, hidden),
    resetAvatarModel: (id) => renderer.resetAvatarModel(id),
    rebaseLocal: (delta) => renderer.rebaseLocal(delta),
    dispose: () => renderer.dispose(),
  };
}
