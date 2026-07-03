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
import type { BuildingSpec, StructureSpec, Vec2, WorldSpec } from "./types.js";
import { buildingAt, insideBuilding, type AvatarState, type WorldState } from "./engine.js";
import type { RenderIntent, ScreenPick, WorldView, WorldViewDeps } from "./world-view.js";
import { bubbleAlpha, imageAspect, layoutBubble, paintBubble, type GlyphImage } from "./speech-bubble.js";
import { buildObjectModel, type ObjectModel } from "./object-models.js";
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
} as const;
const DOOR_SWING = Math.PI * 0.55;

/** World height of one storey (meters) — the renderer lifts a body/object on
 *  floor `f` by `f * FLOOR_HEIGHT`. Purely a render constant (the engine keeps
 *  floor unitless). */
export const FLOOR_HEIGHT = 3.0;
/** Ray-depth (world units) within which a picked OBJECT is treated as "at the same
 *  spot" as a creature and wins the pick — item-priority for co-located entities. */
const PICK_ITEM_MARGIN = 1.5;
/** Opacity a faded-out plane settles at (roof/slab/storey wall/object of the
 *  OCCUPIED building sitting between the occupant and the camera). */
const FADE_OPACITY = 0.07;
/** Ease rate (1/s) of the see-inside fade — clears the view in ~a third of a
 *  second but still reads as a fade, never a pop. */
const FADE_RATE = 9;
/** A plane starts fading a little BEFORE the camera actually rises past it, so
 *  the reveal leads the camera instead of trailing it. */
const CAM_FADE_MARGIN = 0.4;

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
  sprite.scale.set(1.2, 1.2, 1.2);
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
  sprite.scale.set(1.3 * aspect, 1.3, 1);
  return { sprite, tex, mat };
}

/**
 * The local avatar's occupancy, for the see-inside fade: which building it is
 * in, which storey it stands on, and how high the camera sits. Null when the
 * avatar is outdoors — nothing fades.
 */
interface FadeContext {
  building: BuildingSpec;
  floor: number;
  camY: number;
}

/** Does the OCCUPIED building's horizontal plane at `planeY` block the camera's
 *  view of the occupant? It must lie above the occupant AND at/below the camera
 *  — a ceiling the camera hasn't risen past yet hides nothing. */
function planeBlocks(fade: FadeContext, planeY: number): boolean {
  return planeY > fade.floor * FLOOR_HEIGHT + 0.1 && fade.camY > planeY - CAM_FADE_MARGIN;
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

/** Soft radial glow (white core → warm gold → transparent) for the gaze spark.
 *  OffscreenCanvas so it builds in the render worker. */
function makeSparkTexture(): THREE.CanvasTexture {
  const S = 64;
  const canvas = new OffscreenCanvas(S, S);
  const c = canvas.getContext("2d");
  if (c) {
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.3, "rgba(255,224,150,0.9)");
    g.addColorStop(1, "rgba(255,190,80,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);
  }
  const tex = new THREE.CanvasTexture(canvas as unknown as HTMLCanvasElement);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The GAZE SPARK — the player's cursor reimagined as a small flying light that
 * LEADS the avatar. It chases the effective gaze point (the same `aim` the engine
 * steers toward) and, when the gaze rests on a creature or object, lifts to hover
 * over that target. Purely cosmetic: it reflects intent the engine already computed
 * and never feeds back into the simulation.
 *
 * Tuned for MOTION COMFORT (this population is motion/flicker-sensitive):
 *   • It chases its target near-instantly, so it doesn't streak across the field
 *     on a gaze jump — while moving it only parallaxes with the camera, like any
 *     world object.
 *   • It's a DIM, steady marker while moving, and BLOOMS brighter the longer it
 *     rests still on one spot (`dwell`). No flicker (the 3–20 Hz band is a
 *     discomfort/photosensitivity trigger).
 *   • Its point light rises ONLY with that dwell — i.e. only once the spark is
 *     stationary — so the light's shading never sweeps across the scene.
 */
const SPARK = {
  /** Seconds of stillness to bloom from dim to full. */
  dwellFull: 0.45,
  dimOpacity: 0.3,
  fullOpacity: 0.95,
  scaleMin: 0.5,
  scaleMax: 0.78,
  /** Point-light intensity at full dwell (0 while moving). */
  maxLight: 1.3,
  /** Squared world distance under which the spark counts as "at rest". */
  restDist2: 0.06 * 0.06,
} as const;

class GazeSpark {
  readonly group = new THREE.Group();
  private readonly sprite: THREE.Sprite;
  private readonly light: THREE.PointLight;
  private readonly mat: THREE.SpriteMaterial;
  private readonly tex: THREE.CanvasTexture;
  private readonly pos = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private shown = false;
  /** Eased presence 0..1 — fades the spark in/out as the gaze appears/leaves. */
  private amp = 0;
  /** Seconds the spark has been at rest — drives the brightness bloom; drops fast
   *  once it starts moving again. */
  private dwell = 0;
  /** 0..1 dwell-to-SELECT progress fed from the game (carry pick/place, converse
   *  dwell). Blooms the spark like the old dwell ring's fill, so it reads as the
   *  selection indicator over the very item being chosen. */
  private select = 0;

  constructor() {
    this.tex = makeSparkTexture();
    this.mat = new THREE.SpriteMaterial({
      map: this.tex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    this.sprite = new THREE.Sprite(this.mat);
    this.sprite.renderOrder = 18;
    this.light = new THREE.PointLight(0xffe6a8, 0, 3.5, 2);
    this.group.add(this.sprite, this.light);
  }

  /** Aim the spark at a world point. It flies there; `amp` handles fade-in. */
  setTarget(x: number, y: number, z: number): void {
    this.target.set(x, y, z);
    if (!this.shown) this.pos.copy(this.target); // appear at the target, don't streak in
    this.shown = true;
  }

  /** 0..1 dwell-to-select progress for this frame (0 when nothing is selecting). */
  setSelect(p: number): void {
    this.select = Math.min(1, Math.max(0, p));
  }

  /** No gaze to represent this frame — fade out in place. */
  hide(): void {
    this.shown = false;
  }

  update(dt: number): void {
    const step = Math.max(0, dt);
    this.amp += ((this.shown ? 1 : 0) - this.amp) * (1 - Math.exp(-8 * step));
    // Snappy chase — a near-locked spark only parallaxes with the camera instead of
    // streaking across the field on a gaze jump.
    this.pos.lerp(this.target, 1 - Math.exp(-30 * step));
    // Bloom brighter the longer it holds still; drop fast the moment it moves.
    const still = this.pos.distanceToSquared(this.target) < SPARK.restDist2;
    this.dwell = still
      ? Math.min(SPARK.dwellFull, this.dwell + step)
      : Math.max(0, this.dwell - step * 4);
    const c = this.dwell / SPARK.dwellFull;
    const stillFocus = c * c * (3 - 2 * c); // smoothstep 0..1
    // The stronger of "held still" and an explicit dwell-to-select drives the bloom.
    const focus = Math.max(stillFocus, this.select);
    this.sprite.position.copy(this.pos);
    this.light.position.copy(this.pos);
    this.mat.opacity = this.amp * lerp(SPARK.dimOpacity, SPARK.fullOpacity, focus);
    this.sprite.scale.setScalar(lerp(SPARK.scaleMin, SPARK.scaleMax, focus));
    // Light only with focus ⇒ only when stationary ⇒ its shading never sweeps.
    this.light.intensity = this.amp * focus * SPARK.maxLight;
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    this.tex.dispose();
    this.mat.dispose();
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
  const bodyMat = new THREE.MeshStandardMaterial({
    color: tint,
    roughness: 0.65,
    metalness: 0.0,
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

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
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
      materials: THREE.MeshStandardMaterial[];
      /** The procedural model (present unless this object fell back to box/sphere);
       *  owns descriptor application, particle animation, and its own disposal. */
      model?: ObjectModel;
    }
  >();
  /** Walls (static) + doors (a hinge pivot whose yaw tracks the door's `open`).
   *  `mats` = every material the see-inside fade eases (wall, or leaf+lintel). */
  private readonly structureMeshes = new Map<
    string,
    {
      object: THREE.Object3D;
      mats: THREE.MeshStandardMaterial[];
      door?: { pivot: THREE.Group; thetaClosed: number; leafMat: THREE.MeshStandardMaterial };
    }
  >();
  /** Per-building render meshes: upper floor slabs (by storey) + a roof. */
  private readonly buildingMeshes = new Map<string, { slabs: { floor: number; mesh: THREE.Mesh }[]; roof: THREE.Mesh }>();
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
  private camCenter: THREE.Vector3 | null = null;
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
    this.cameraCfg = mergeCamera(opts.camera);
    this.comfort = mergeComfort(opts.comfort);
    // Start at the overhead "home" pose (the avatar spawns at rest → watch/overhead).
    this.rig = { ...this.cameraCfg.overhead };

    const backdrop = opts.backdrop ?? BACKDROP;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setClearColor(new THREE.Color(backdrop), 1);
    // We draw the scene then a vignette pass, so take over clearing.
    this.renderer.autoClear = false;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(new THREE.Color(backdrop), 40, 150);

    this.camera = new THREE.PerspectiveCamera(this.rig.fov, 1, 0.1, 1000);

    this.buildLights();
    this.buildGround(backdrop);
    this.buildVignette(backdrop);
    this.scene.add(this.spark.group);
    this.overlay?.mount(this.scene);

    // Pre-position the camera over the field centre so a screenToWorld call that
    // lands before the first render (camCenter still null) still casts a sane ray.
    // The first render's updateCamera snaps the follow to the local avatar.
    this.placeCamera(spec.manifold.width / 2, spec.manifold.height / 2);
    // Size is injected by the host via resize() right after construction (the
    // renderer never measures the canvas itself, so it works off-thread).
  }

  /** Position + aim the camera behind the followed ground point, along the current
   *  smoothed heading, using the current (overhead↔shoulder) rig pose. Shared by
   *  the constructor pre-placement and updateCamera. */
  private placeCamera(cx: number, cz: number): void {
    const f = this.camForward;
    const r = this.rig;
    this.camera.position.set(cx - f.x * r.back, r.height, cz - f.z * r.back);
    this.camera.lookAt(cx + f.x * r.lookAhead, r.lookHeight, cz + f.z * r.lookAhead);
  }

  private buildLights(): void {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x4a5a44, 0.95);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
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

    // The playable field.
    const fieldGeom = new THREE.PlaneGeometry(width, height);
    const fieldMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.spec.terrain.groundColor ?? "#6db36b"),
      roughness: 1,
      metalness: 0,
    });
    const field = new THREE.Mesh(fieldGeom, fieldMat);
    field.rotation.x = -Math.PI / 2;
    field.position.set(cx, 0, cz);
    this.scene.add(field);
    this.disposables.push(fieldGeom, fieldMat);

    // Subtle grid for a sense of motion (faces glide; the ground needs texture).
    const gridSize = Math.max(width, height);
    const grid = new THREE.GridHelper(gridSize, Math.round(gridSize / 5), 0xffffff, 0xffffff);
    (grid.material as THREE.Material).opacity = 0.08;
    (grid.material as THREE.Material).transparent = true;
    grid.position.set(cx, 0.01, cz);
    this.scene.add(grid);
    this.disposables.push(grid.geometry, grid.material as THREE.Material);

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
    this.vw = Math.max(1, width);
    this.vh = Math.max(1, height);
    this.renderer.setPixelRatio(dpr || 1);
    this.renderer.setSize(this.vw, this.vh, false);
    this.camera.aspect = this.vw / this.vh;
    this.camera.updateProjectionMatrix();
  }

  /** Pointer (CSS px, origin top-left) → world ground point, via a camera ray. */
  screenToWorld(px: number, py: number): Vec2 | null {
    const ndcX = (px / this.vw) * 2 - 1;
    const ndcY = -((py / this.vh) * 2 - 1);
    return screenRayToGround(this.camera, ndcX, ndcY, this.raycaster, this.groundPlane, this._scratch);
  }

  /** What the pixel rests on VISUALLY — a speech bubble, an avatar's body/head
   *  sprite, or an object's mesh — nearest hit first. Pick roots are tagged with
   *  `userData.pick` at creation; a hit resolves by walking up to the tagged
   *  ancestor, so child meshes/sprites (emoji heads) count as their avatar. */
  pickScreen(px: number, py: number, opts?: { includeLocal?: boolean }): ScreenPick | null {
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

  render(
    state: WorldState,
    dt: number,
    faceFor: (id: string) => CanvasImageSource | null,
    labelFor: (id: string) => string,
    glyphFor?: (glyph: string) => CanvasImageSource[] | null,
    intent?: RenderIntent,
  ): void {
    // See-inside floor fade — purely GEOMETRIC: when the local avatar is inside
    // a building, fade exactly the planes of THAT building that sit between it
    // and the camera (roof / slabs / storey walls above the occupant that the
    // camera has risen past). The camera HEIGHT decides, not the rig pose — an
    // overhead cam is above every roof, a shoulder cam may or may not be, and
    // either way only what actually blocks the view fades. Other buildings
    // never fade. null ⇒ outdoors, nothing fades.
    const me = state.avatars[this.localId];
    const myBuilding = me ? buildingAt(state, me.x, me.y) : null;
    const fade: FadeContext | null =
      me && myBuilding
        ? { building: myBuilding, floor: me.floor, camY: this.camera.position.y }
        : null;

    this.syncAvatars(state, dt, faceFor, labelFor, intent?.sitting ?? false, intent?.interactId);
    this.syncStructures(state, fade, dt);
    this.syncObjects(state, intent?.interactId, fade, glyphFor, dt);
    this.syncBuildings(state, fade, dt);
    this.syncBubbles(state, glyphFor);
    this.updateCamera(state, dt, intent);
    this.updateComfort(state, dt);
    this.updateSpark(state, intent);
    this.spark.update(dt);
    this.overlay?.update(dt);

    // Scene, then the comfort vignette on top (autoClear is off).
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.overlayScene, this.overlayCamera);
  }

  /** Point the gaze spark at what the player is engaging: hovering over a
   *  highlighted creature/object, else resting at the effective gaze ground
   *  point, else fading out (no gaze this frame). Runs after syncObjects so the
   *  target object's mesh is placed. */
  private updateSpark(state: WorldState, intent?: RenderIntent): void {
    const cur = intent?.cursor;
    if (!cur) {
      this.spark.hide();
      return;
    }
    this.spark.setSelect(cur.selectProgress ?? 0);
    // Hover over whatever the gaze RESTS on (a creature's head / an object), else
    // skim the fixated ground point. Keyed on the cursor payload — NOT interactId —
    // so it never sticks to the carried item or the person being spoken to.
    const av = cur.hoverKind === "avatar" && cur.hoverId ? state.avatars[cur.hoverId] : undefined;
    if (av) {
      this.spark.setTarget(av.x, BUBBLE.headY + av.floor * FLOOR_HEIGHT + 0.15, av.y);
      return;
    }
    const entry = cur.hoverKind === "object" && cur.hoverId ? this.objectMeshes.get(cur.hoverId) : undefined;
    if (entry) {
      const radius = state.spec.objects.find((o) => o.id === cur.hoverId)?.radius ?? 0.5;
      const p = entry.mesh.position;
      this.spark.setTarget(p.x, p.y + radius + 0.5, p.z);
      return;
    }
    if (cur.point) {
      const floorY = (state.avatars[this.localId]?.floor ?? 0) * FLOOR_HEIGHT;
      this.spark.setTarget(cur.point.x, floorY + 0.45, cur.point.y);
      return;
    }
    this.spark.hide();
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

  private syncAvatars(
    state: WorldState,
    dt: number,
    faceFor: (id: string) => CanvasImageSource | null,
    labelFor: (id: string) => string,
    sitting: boolean,
    interactId?: string,
  ): void {
    // Add models for new avatars; update all present ones.
    for (const a of Object.values(state.avatars)) {
      const isLocal = a.id === this.localId;
      let model = this.avatars.get(a.id);
      if (!model) {
        model = this.modelFactory(a.id, isLocal);
        model.object.userData.pick = { kind: "avatar", id: a.id } satisfies ScreenPick;
        this.avatars.set(a.id, model);
        this.scene.add(model.object);
      }
      model.object.position.set(a.x, a.floor * FLOOR_HEIGHT, a.y);
      model.update(
        {
          state: a,
          isLocal,
          speed: Math.hypot(a.vx, a.vy),
          faceSource: faceFor(a.id),
          label: labelFor(a.id),
          camera: this.camera,
          // Sitting is the local player's WATCH state (not networked yet).
          sitting: isLocal && sitting,
          highlighted: a.id === interactId,
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
   *  live `open`. Walls are static; door pivots rotate from state.doors[id].open. */
  private syncStructures(state: WorldState, fade: FadeContext | null, dt: number): void {
    const structures = state.spec.structures;
    if (!structures) return;
    for (const s of structures) {
      let entry = this.structureMeshes.get(s.id);
      if (!entry) {
        entry = this.buildStructure(s);
        this.structureMeshes.set(s.id, entry);
        this.scene.add(entry.object);
      }
      if (entry.door) {
        const door = state.doors[s.id];
        const open = door?.open ?? 0;
        entry.door.pivot.rotation.y = entry.door.thetaClosed + open * DOOR_SWING;
        // A still-locked door reads in a darker, "barred" colour. (A building's
        // color tints the LINTEL, not the leaf — the leaf must read as a door.)
        entry.door.leafMat.color.setHex(door?.locked ? STRUCTURE.doorLockedColor : STRUCTURE.doorColor);
      }
      // A wall/door of a storey ABOVE the occupant, in the occupant's OWN
      // building, fades once the camera is above that storey. Exterior
      // (floorless) walls and stairs never fade.
      const sFloor = s.kind === "stairs" ? undefined : s.floor;
      const inMyBuilding =
        !!fade &&
        s.kind !== "stairs" &&
        insideBuilding(fade.building, (s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2);
      const faded =
        !!fade && inMyBuilding && sFloor !== undefined && planeBlocks(fade, sFloor * FLOOR_HEIGHT);
      for (const mat of entry.mats) fadeToward(mat, faded, dt);
    }
  }

  /** Build each building's floor slabs + roof once, then ease exactly the planes
   *  of the OCCUPIED building that sit between the occupant and the camera —
   *  a slab above the camera still hides nothing, other buildings never fade. */
  private syncBuildings(state: WorldState, fade: FadeContext | null, dt: number): void {
    const buildings = state.spec.buildings;
    if (!buildings) return;
    for (const b of buildings) {
      let entry = this.buildingMeshes.get(b.id);
      if (!entry) {
        entry = this.buildBuilding(b);
        this.buildingMeshes.set(b.id, entry);
        for (const s of entry.slabs) this.scene.add(s.mesh);
        this.scene.add(entry.roof);
      }
      const occupied = fade && fade.building.id === b.id ? fade : null;
      for (const { floor, mesh } of entry.slabs) {
        fadeToward(
          mesh.material as THREE.MeshStandardMaterial,
          !!occupied && planeBlocks(occupied, floor * FLOOR_HEIGHT),
          dt,
        );
      }
      fadeToward(
        entry.roof.material as THREE.MeshStandardMaterial,
        !!occupied && planeBlocks(occupied, b.floors * FLOOR_HEIGHT),
        dt,
      );
    }
  }

  private buildBuilding(b: BuildingSpec): { slabs: { floor: number; mesh: THREE.Mesh }[]; roof: THREE.Mesh } {
    const { x, y, w, h } = b.footprint;
    const cx = x + w / 2;
    const cz = y + h / 2;
    const slabs: { floor: number; mesh: THREE.Mesh }[] = [];
    // Upper-storey floor planes (the ground storey is the field itself).
    for (let f = 1; f < b.floors; f++) {
      const geom = new THREE.PlaneGeometry(w, h);
      const mat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 1, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(cx, f * FLOOR_HEIGHT, cz);
      this.disposables.push(geom, mat);
      slabs.push({ floor: f, mesh });
    }
    const roofGeom = new THREE.PlaneGeometry(w, h);
    // A colored building's roof carries its tint, darkened — "the blue house"
    // must read from the overhead camera too, where the roof IS the house.
    const roofColor = b.color
      ? new THREE.Color(b.color).multiplyScalar(0.65)
      : new THREE.Color(0x475569);
    const roofMat = new THREE.MeshStandardMaterial({ color: roofColor, roughness: 1, side: THREE.DoubleSide });
    const roof = new THREE.Mesh(roofGeom, roofMat);
    roof.rotation.x = -Math.PI / 2;
    roof.position.set(cx, b.floors * FLOOR_HEIGHT, cz);
    this.disposables.push(roofGeom, roofMat);
    return { slabs, roof };
  }

  /** A wall = an oriented box on the segment; a door = a hinged leaf box pivoted at
   *  its hinge endpoint (yaw updated each frame in syncStructures). World (x,y) → (x,0,y). */
  private buildStructure(s: StructureSpec): {
    object: THREE.Object3D;
    mats: THREE.MeshStandardMaterial[];
    door?: { pivot: THREE.Group; thetaClosed: number; leafMat: THREE.MeshStandardMaterial };
  } {
    if (s.kind === "stairs") {
      // A tilted slab spanning the footprint, inclined so it rises one storey
      // along its ascent axis (read as a ramp; steps are a later refinement).
      const rise = (s.toFloor - s.fromFloor) * FLOOR_HEIGHT;
      const alongY = s.axis === "+y" || s.axis === "-y";
      const run = alongY ? s.rect.h : s.rect.w;
      const slope = Math.hypot(run, rise);
      const geom = new THREE.BoxGeometry(alongY ? s.rect.w : slope, 0.25, alongY ? slope : s.rect.h);
      const mat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.9, metalness: 0 });
      const ramp = new THREE.Mesh(geom, mat);
      ramp.position.set(
        s.rect.x + s.rect.w / 2,
        ((s.fromFloor + s.toFloor) / 2) * FLOOR_HEIGHT,
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
      const geom = new THREE.BoxGeometry(len, STRUCTURE.wallHeight, s.thickness);
      const mat = new THREE.MeshStandardMaterial({
        color: s.color ? new THREE.Color(s.color) : STRUCTURE.wallColor,
        roughness: 0.9,
        metalness: 0,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set((s.a.x + s.b.x) / 2, STRUCTURE.wallHeight / 2 + floorY, (s.a.y + s.b.y) / 2);
      // Align the box's +X (length) axis with the segment: yaw mapping +X→(dx,dz).
      mesh.rotation.y = Math.atan2(-dz, dx);
      this.disposables.push(geom, mat);
      return { object: mesh, mats: [mat] };
    }
    // Door: hinge at the chosen endpoint, leaf extends toward the other.
    const hinge = s.hinge === "b" ? s.b : s.a;
    const other = s.hinge === "b" ? s.a : s.b;
    const hdx = other.x - hinge.x;
    const hdz = other.y - hinge.y;
    const thetaClosed = Math.atan2(-hdz, hdx);
    const group = new THREE.Group();
    const pivot = new THREE.Group();
    pivot.position.set(hinge.x, floorY, hinge.y);
    pivot.rotation.y = thetaClosed;
    group.add(pivot);
    const geom = new THREE.BoxGeometry(len, STRUCTURE.doorHeight, s.thickness);
    const leafMat = new THREE.MeshStandardMaterial({ color: STRUCTURE.doorColor, roughness: 0.7, metalness: 0 });
    const leaf = new THREE.Mesh(geom, leafMat);
    // Centre the box so its near edge sits at the hinge and it spans toward `other`.
    leaf.position.set(len / 2, STRUCTURE.doorHeight / 2, 0);
    pivot.add(leaf);
    this.disposables.push(geom, leafMat);
    const mats: THREE.MeshStandardMaterial[] = [leafMat];
    // A real doorway: the leaf is door-height (2.1 m), the wall continues above
    // it as a LINTEL up to the storey height, tinted like the wall it sits in.
    const lintelH = STRUCTURE.wallHeight - STRUCTURE.doorHeight;
    if (lintelH > 0.05) {
      const lintelGeom = new THREE.BoxGeometry(len, lintelH, s.thickness);
      const lintelMat = new THREE.MeshStandardMaterial({
        color: s.color ? new THREE.Color(s.color) : STRUCTURE.wallColor,
        roughness: 0.9,
        metalness: 0,
      });
      const lintel = new THREE.Mesh(lintelGeom, lintelMat);
      lintel.position.set(
        (s.a.x + s.b.x) / 2,
        STRUCTURE.doorHeight + lintelH / 2 + floorY,
        (s.a.y + s.b.y) / 2,
      );
      lintel.rotation.y = Math.atan2(-dz, dx);
      group.add(lintel);
      this.disposables.push(lintelGeom, lintelMat);
      mats.push(lintelMat);
    }
    return { object: group, mats, door: { pivot, thetaClosed, leafMat } };
  }

  private syncObjects(
    state: WorldState,
    interactId?: string,
    fade: FadeContext | null = null,
    glyphFor?: (glyph: string) => CanvasImageSource[] | null,
    dt = 0,
  ): void {
    for (const obj of Object.values(state.objects)) {
      const spec = state.spec.objects.find((o) => o.id === obj.id);
      const radius = spec?.radius ?? 0.5;
      let entry = this.objectMeshes.get(obj.id);
      if (!entry) {
        // Prefer a real procedural 3D model for the object's identity; FAILSAFE
        // to the generic box/sphere when there's no recipe (a new/queued type).
        let mesh: THREE.Object3D;
        let materials: THREE.MeshStandardMaterial[];
        const model = buildObjectModel({ iconRef: spec?.iconRef, glyph: spec?.glyph, radius }) ?? undefined;
        if (model) {
          mesh = model.object;
          materials = model.materials;
        } else {
          const geom =
            obj.shape === "box"
              ? new THREE.BoxGeometry(radius * 2, radius * 2, radius * 2)
              : new THREE.SphereGeometry(radius, 24, 16);
          const mat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.5, metalness: 0 });
          mesh = new THREE.Mesh(geom, mat);
          materials = [mat];
          this.disposables.push(geom, mat);
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
          icon.sprite.position.set(0, radius + 0.7, 0);
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
        }
        entry.model.update(state.time);
        // Carried objects turn to face the way their carrier faces (a recipe's
        // forward is +X; align it with the possessor's facing vector).
        if (obj.possessedBy) {
          const carrier = state.avatars[obj.possessedBy];
          if (carrier) entry.mesh.rotation.y = Math.atan2(-carrier.fy, carrier.fx);
        }
      } else if (spec?.glyph && entry.glyphKey !== spec.glyph && glyphFor) {
        // Failsafe object: swap the emoji for the composed glyph image once the
        // game's resolver has decoded it (async), keyed on the glyph string.
        const images = glyphFor(spec.glyph);
        const img = images?.[0];
        if (img) {
          if (entry.icon) entry.mesh.remove(entry.icon);
          const icon = makeGlyphIconSprite(img as GlyphImage);
          icon.sprite.position.set(0, radius + 0.7, 0);
          entry.mesh.add(icon.sprite);
          this.disposables.push(icon.tex, icon.mat);
          entry.icon = icon.sprite;
          entry.glyphKey = spec.glyph;
        }
      }
      // Containment lifts/lowers the object so on/in/under read as relations.
      let y = radius;
      if (obj.containedIn) {
        const cr = state.spec.objects.find((o) => o.id === obj.containedIn!.objectId)?.radius ?? 0.5;
        if (obj.containedIn.relation === "on") y = cr * 2 + radius;
        else if (obj.containedIn.relation === "in") y = cr;
        // "under" stays on the ground (beneath the container's top).
      }
      const floorY = obj.floor * FLOOR_HEIGHT;
      entry.mesh.position.set(obj.x, y + floorY, obj.y);
      entry.shadow.position.set(obj.x, 0.02 + floorY, obj.y);
      // Possession tint marks the owner; an INTERACT highlight (gaze on a free
      // object) pulses cyan. Applied across every material of the model.
      // Objects fade with the storey they stand on (same plane rule as slabs),
      // only inside the occupant's own building.
      const faded =
        !!fade &&
        obj.floor > fade.floor &&
        insideBuilding(fade.building, obj.x, obj.y) &&
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
    const up = this._bubbleUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
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
      bubble.place(pos.x, pos.y, alpha, floor * FLOOR_HEIGHT, up);
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
    if (Math.abs(fov - this.camera.fov) > 1e-3) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.rig.fov = fov;

    const c = this.camCenter;
    this.placeCamera(c.x, c.z);
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
    this.renderer.dispose();
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
  opts?: { modelFactory?: AvatarModelFactory; backdrop?: string; overlay?: SceneOverlay },
): WorldView {
  const { canvas, localId, faceFor, labelFor, glyphFor } = deps;
  const renderer = new World3DRenderer(canvas, spec, {
    localId,
    overlay: opts?.overlay,
    modelFactory: opts?.modelFactory,
    backdrop: opts?.backdrop,
  });
  return {
    screenToWorld: (px, py) => renderer.screenToWorld(px, py),
    pickScreen: (px, py) => renderer.pickScreen(px, py),
    render: (state, dt, intent) => renderer.render(state, dt, faceFor, labelFor, glyphFor, intent),
    resize: (width, height, dpr) => renderer.resize(width, height, dpr),
    setTunables: (t) => renderer.setTunables({ camera: t.camera, comfort: t.comfort }),
    dispose: () => renderer.dispose(),
  };
}
