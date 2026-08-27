// shared/world-engine/creatures/portrait.ts
//
// CREATURE PORTRAITS — a body's own head, baked into a small PNG a BOARD
// BUTTON can wear.
//
// The sentence builder draws a word's picture through the glyph compositor's
// injected `ImageResolver`. A named individual ("Mara") and a species nobody
// drew artwork for resolve to nothing there, and the slot falls to the unknown
// "❓" placeholder — the child is offered a button for somebody they can SEE in
// the world, wearing no face. This module answers that with the one picture the
// world already holds: the creature's own procedural body, framed on the head.
//
// The bake is the plant-impostor trick (plant-lod.ts bakePlantImpostor) aimed at
// a face: the species' CACHED idle-pose geometry (getSpeciesAssets — no extra
// loft, no extra bake) under an orthographic camera placed off the skull's own
// landmarks, cleared transparent so the compositor's tone plate shows through.
//
// TWO HALVES, deliberately split:
//   • framing + scene assembly — PURE three (no GL context), so the camera
//     placement is unit-testable headless for every species in the registry.
//   • the bake itself — needs a WebGLRenderer and a DOM canvas. MAIN THREAD
//     ONLY; returns null anywhere else rather than throwing.
//
// ⚠️ GL/DOM-bound — like glyph-images.ts, NOT re-exported from
// world-engine/index.ts, so the headless host never drags a renderer in. Import
// it directly:  import { bakeCreaturePortrait } from "@shared/world-engine/creatures/portrait";
//
// The portrait is an IDENTITY icon, not a live mirror: it is baked from the
// body's spawn wardrobe and never re-baked when the creature changes clothes.
// A button whose picture flickered every time a resident did the laundry would
// be a worse target than one that holds still.

import * as THREE from "three";
import { clampBlueprint, type Blueprint } from "./blueprint";
import { outfitPresetFor } from "./clothing";
import { getSpeciesAssets, type CreatureLook } from "./creature-model";
import { buildSkeleton, type CreatureSkeleton } from "./skeleton";
import { getSpecies } from "./species";

/** Square edge (px) a portrait bakes at. Sized for the biggest a board button
 *  ever draws it (~128 CSS px at 2× DPR); the compositor downsamples. */
export const PORTRAIT_SIZE = 256;

/** Degrees off dead-on, around the body's up axis. A three-quarter turn reads as
 *  a face; a straight-on symmetric render reads as a mask. */
export const PORTRAIT_YAW_DEG = 22;

/** Degrees the camera stands ABOVE a BODY SHOT, looking slightly down — enough
 *  that a four-legged animal reads as a solid standing in a world rather than as
 *  a flat side elevation. Head portraits stay level: a person's face is the
 *  subject, and looking down at it just shortens the forehead. */
export const BODY_SHOT_PITCH_DEG = 12;

/** Head half-size (the largest skull half-axis) → ortho frustum half-extent.
 *  Above 1 by enough to admit the shoulders the crop needs to say WHO this is:
 *  the clothing colour is what tells two residents of one species apart. */
const HEAD_FRAME_SCALE = 1.75;

/** Fraction of the frustum half-extent the look-at point drops below the
 *  braincase centre — the portrait convention of head high, shoulders low. */
const CHIN_DROP = 0.28;

/** A BODY SHOT (a four-legged animal, a plant) frames its whole bounds, padded. */
const BODY_FRAME_PAD = 1.06;

/** A spine is UPRIGHT when its rise beats its run by this much — the test that
 *  decides whether a creature gets a head portrait or a body shot. */
const UPRIGHT_SPINE_RATIO = 1;

/** Portrait lighting: a hemisphere fill so nothing reads as a black hole, plus a
 *  key light over the camera's shoulder so the muzzle keeps its form. Values are
 *  soft on purpose — a hard key turns a cheek into a highlight, and the board's
 *  other icons are flat artwork. */
const HEMI_SKY = 0xffffff;
const HEMI_GROUND = 0x8899aa;
const HEMI_INTENSITY = 1.35;
const KEY_INTENSITY = 1.15;

/** Which body a portrait is OF — the same two dials the avatar factory dresses a
 *  creature with (`speciesFor` / `outfitFor`), and nothing else. */
export interface CreaturePortraitSpec {
  /** Registered species id (creatures/species.ts). */
  speciesId: string;
  /** Wardrobe preset index (clothing.ts outfitPresetFor). Absent = bare body. */
  outfit?: number;
  look?: CreatureLook;
}

/** How the camera stands relative to the face. */
export interface PortraitAngle {
  /** Turn off dead-on, degrees. Default PORTRAIT_YAW_DEG. */
  yawDeg?: number;
  /** Height above the head, degrees. Default PORTRAIT_PITCH_DEG. */
  pitchDeg?: number;
  /** How loose the crop is. On a head portrait: the frustum half-extent as a
   *  multiple of the head's own half-size (default HEAD_FRAME_SCALE — bigger
   *  admits more shoulders and more background). On a body shot: padding around
   *  the whole animal (default BODY_FRAME_PAD). */
  frameScale?: number;
}

export interface PortraitOptions extends CreaturePortraitSpec, PortraitAngle {
  /** Square edge of the baked PNG. Default PORTRAIT_SIZE. */
  size?: number;
}

/** Stable cache key for one portrait — two creatures wearing the same species
 *  and preset share a bake, exactly as they share a body. */
export function portraitKey(spec: CreaturePortraitSpec): string {
  const toon = spec.look?.toon;
  return `${spec.speciesId}|${spec.outfit ?? "bare"}|${toon === undefined ? "" : toon ? "toon" : "std"}`;
}

/** Where the portrait camera stands, in creature-local meters. */
export interface PortraitFrame {
  /** The look-at point. */
  target: THREE.Vector3;
  /** UNIT direction from the target out to the camera. */
  eye: THREE.Vector3;
  /** Half-WIDTH of the orthographic frustum. */
  halfW: number;
  /** Half-HEIGHT of the orthographic frustum. A head portrait is square; a body
   *  shot takes the subject's own proportions, so a dachshund of a picture is
   *  wide rather than a square with a small dog adrift in it. */
  halfH: number;
  /** True when this is a HEAD portrait; false when it is a whole-body shot. */
  framedHead: boolean;
}

/** How far from square a body shot may go. Beyond this the picture stops
 *  reading as an icon and starts reading as a strip. */
const MIN_ASPECT = 0.6;
const MAX_ASPECT = 1.8;

const UP = (): THREE.Vector3 => new THREE.Vector3(0, 1, 0);
const v3 = (p: { x: number; y: number; z: number }): THREE.Vector3 => new THREE.Vector3(p.x, p.y, p.z);

/** The spine's rear→front direction (NOT levelled — its rise is what tells an
 *  upright body from a four-legged one). Null when the skeleton has no spine to
 *  read (fruit, some growths). */
function spineForward(skel: CreatureSkeleton): THREE.Vector3 | null {
  const spine = skel.bones.filter((b) => b.chain === "spine");
  if (!spine.length) return null;
  const dir = v3(spine[spine.length - 1]!.tail).sub(v3(spine[0]!.head));
  return dir.lengthSq() > 1e-8 ? dir : null;
}

/**
 * Place the portrait camera off the skeleton's OWN landmarks.
 *
 * TWO PICTURES, because two body plans:
 *
 *   UPRIGHT bodies (people, and the animal-people the dollhouse is full of)
 *   get a HEAD PORTRAIT — out along the way the face looks, level, turned
 *   `yawDeg` for the three-quarter view, cropped head-and-shoulders. Their body
 *   hangs BELOW the head, so the face reads against clear air, and the shoulders
 *   bring in the clothing colour that says WHICH person this is.
 *
 *   FOUR-LEGGED bodies get a BODY SHOT — the whole animal from the front
 *   quarter, slightly above. A dog's body runs BACKWARD from its head, straight
 *   down the barrel of a face-on lens, so a head crop puts the animal's own back
 *   behind its face and reads as a brown smear; and a dog is known by its
 *   silhouette anyway — four legs, tail, ears — not by its portrait.
 *
 * Levelling the face direction is not cosmetic: a grazing quadruped's head
 * points at the grass, and a camera that followed it would bake the ground.
 *
 * A body with no skull at all (plants, fruit) takes the body shot too — those
 * species have no face to find, and their whole shape IS their identity.
 */
export function framePortrait(skel: CreatureSkeleton, angle: PortraitAngle = {}): PortraitFrame {
  const yaw = ((angle.yawDeg ?? PORTRAIT_YAW_DEG) * Math.PI) / 180;
  const head = skel.head;
  const spine = spineForward(skel);
  // Upright = the spine rises faster than it runs. Absent spine ⇒ treat as
  // upright only if there is a head to point at (a bodiless growth is a shape).
  const upright = spine ? Math.abs(spine.y) > Math.hypot(spine.x, spine.z) * UPRIGHT_SPINE_RATIO : !!head;

  if (head && upright) {
    const center = v3(head.center);
    // The face's own direction: braincase → muzzle where there is a muzzle, the
    // braincase axis where the head is a bare bulb.
    const snout = v3(head.rostrumTip).sub(center);
    const dir = snout.lengthSq() > 1e-8 ? snout : v3(head.braincaseAxis);
    const full = dir.length();
    dir.y = 0; // eye level — never follow a head's pitch
    // A head that points almost straight up or down leaves a levelled remainder
    // that is mostly rounding error — normalizing THAT would aim the camera at
    // an arbitrary side of the face. Fall back to the builder's own facing.
    const forward = dir.length() > full * 0.25 ? dir.normalize() : new THREE.Vector3(0, 0, 1);
    const half = Math.max(head.radius, head.domeHalf, head.halfLen) * (angle.frameScale ?? HEAD_FRAME_SCALE);
    const target = center.addScaledVector(UP(), -half * CHIN_DROP);
    const eye = aim(forward, yaw, ((angle.pitchDeg ?? 0) * Math.PI) / 180);
    const side = Math.max(half, 0.01);
    return { target, eye, halfW: side, halfH: side, framedHead: true };
  }

  // ── Body shot ──────────────────────────────────────────────────────────────
  const min = v3(skel.bounds.min);
  const max = v3(skel.bounds.max);
  const target = min.clone().add(max).multiplyScalar(0.5);
  // Stand off the animal's SIDE and turn `yaw` toward its front: side-on shows
  // the silhouette, the turn toward the head keeps a face in the picture.
  let base = new THREE.Vector3(0, 0, 1);
  if (spine) {
    const forward = new THREE.Vector3(spine.x, 0, spine.z);
    if (forward.lengthSq() > 1e-8) {
      forward.normalize();
      const side = forward.clone().cross(UP()).normalize();
      base = side.multiplyScalar(Math.cos(yaw)).addScaledVector(forward, Math.sin(yaw)).normalize();
    }
  }
  const eye = aim(base, 0, ((angle.pitchDeg ?? BODY_SHOT_PITCH_DEG) * Math.PI) / 180);
  // Fit the frame to what the camera ACTUALLY SEES: the bounds projected onto
  // the view plane. A square frame sized to the longest edge would sit a dog in
  // a box twice its own height, and the button would draw the empty half.
  const right = eye.clone().cross(UP()).normalize();
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0); // straight-down view: any right
  const camUp = right.clone().cross(eye).normalize();
  let halfW = 0;
  let halfH = 0;
  for (const cx of [min.x, max.x]) {
    for (const cy of [min.y, max.y]) {
      for (const cz of [min.z, max.z]) {
        const d = new THREE.Vector3(cx, cy, cz).sub(target);
        halfW = Math.max(halfW, Math.abs(d.dot(right)));
        halfH = Math.max(halfH, Math.abs(d.dot(camUp)));
      }
    }
  }
  const pad = angle.frameScale ?? BODY_FRAME_PAD;
  halfW = Math.max(halfW * pad, 0.01);
  halfH = Math.max(halfH * pad, 0.01);
  // Keep it icon-shaped: widen/heighten the short side rather than crop.
  const aspect = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, halfW / halfH));
  if (halfW / halfH > aspect) halfH = halfW / aspect;
  else halfW = halfH * aspect;
  return { target, eye, halfW, halfH, framedHead: false };
}

/** Turn `forward` by `yaw` about world up, then raise it by `pitch`. */
function aim(forward: THREE.Vector3, yaw: number, pitch: number): THREE.Vector3 {
  const eye = forward.clone().applyAxisAngle(UP(), yaw).normalize();
  return eye.multiplyScalar(Math.cos(pitch)).addScaledVector(UP(), Math.sin(pitch)).normalize();
}

/** The species' clamped blueprint, dressed — the same body creature-model bakes
 *  its idle clip from, so the skeleton this measures matches that geometry. */
function dressedBlueprint(base: Record<string, unknown>, outfit?: number): Blueprint {
  if (outfit === undefined) return clampBlueprint(base);
  return clampBlueprint({ ...base, outfit: outfitPresetFor(outfit) });
}

/** A portrait scene + its camera. `dispose` drops what THIS view made and NOT
 *  the shared species assets (cached geometry + material outlive every view). */
export interface PortraitView {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  frame: PortraitFrame;
  dispose(): void;
}

/**
 * Assemble the portrait scene: the species' cached idle geometry, lit, under a
 * camera framed on its head. Pure three — no GL context needed, so this is the
 * half a headless test can drive.
 *
 * Null for an unregistered or BODILESS species (the player's spark has no body;
 * building one would stand a stranger in the world's place — creature-model's
 * own law).
 */
export function buildPortraitView(spec: CreaturePortraitSpec, angle: PortraitAngle = {}): PortraitView | null {
  const species = getSpecies(spec.speciesId);
  // A stub is a word with no body plan yet — there is nothing to photograph.
  if (!species || species.bodiless || species.stub) return null;

  const look = spec.look ?? {};
  const assets = getSpeciesAssets(
    spec.speciesId,
    look,
    spec.outfit === undefined ? undefined : outfitPresetFor(spec.outfit),
  );
  const geometry = assets.clips.get("idle")?.frames[0]?.geometry;
  if (!geometry) return null;

  const skel = buildSkeleton(dressedBlueprint(species.blueprint, spec.outfit));
  const frame = framePortrait(skel, angle);

  // Camera distance only has to clear the body — an ortho frustum's scale comes
  // from the frame, not from how far back it stands.
  const bounds = skel.bounds;
  const span =
    Math.hypot(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z) || 1;
  const dist = span + Math.max(frame.halfW, frame.halfH) * 2;
  const camera = new THREE.OrthographicCamera(
    -frame.halfW, frame.halfW, frame.halfH, -frame.halfH,
    0.01, dist * 2 + span,
  );
  camera.position.copy(frame.target).addScaledVector(frame.eye, dist);
  camera.up.set(0, 1, 0);
  camera.lookAt(frame.target);
  camera.updateMatrixWorld();

  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(geometry, assets.material);
  scene.add(mesh);
  const hemi = new THREE.HemisphereLight(HEMI_SKY, HEMI_GROUND, HEMI_INTENSITY);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, KEY_INTENSITY);
  // Over the camera's left shoulder, above eye line.
  key.position.copy(camera.position).addScaledVector(UP(), frame.halfH * 3);
  key.target.position.copy(frame.target);
  scene.add(key, key.target);

  return {
    scene,
    camera,
    frame,
    dispose() {
      scene.remove(mesh, hemi, key, key.target);
      // geometry + material belong to the species asset cache — never disposed here.
    },
  };
}

// ── The bake (main thread, GL) ──────────────────────────────────────────────

let renderer: THREE.WebGLRenderer | null = null;
let rendererW = 0;
let rendererH = 0;

/** The portrait renderer: a private, offscreen GL context of its own rather than
 *  the world's.
 *
 *  Borrowing the live renderer would mean reaching through the host for it and
 *  saving/restoring its state around every bake; a context this small (a handful
 *  of small renders, then released) can never disturb a frame of play.
 *  `preserveDrawingBuffer` so `toDataURL` reads a finished picture instead of a
 *  racing one. */
function ensureRenderer(w: number, h: number): THREE.WebGLRenderer | null {
  if (typeof document === "undefined") return null;
  if (!renderer) {
    try {
      const canvas = document.createElement("canvas");
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1); // the size IS the pixel count — never a DPR multiple
    } catch {
      renderer = null;
      return null;
    }
  }
  if (rendererW !== w || rendererH !== h) {
    renderer.setSize(w, h, false);
    rendererW = w;
    rendererH = h;
  }
  return renderer;
}

/** Release the portrait GL context. Call once a batch of bakes is drained — a
 *  browser gives a page only so many contexts, and this one is a visitor. */
export function disposeCreaturePortraitRenderer(): void {
  if (!renderer) return;
  renderer.dispose();
  renderer.forceContextLoss();
  renderer = null;
  rendererW = 0;
  rendererH = 0;
}

/**
 * Bake ONE portrait to a PNG data URL, transparent behind the body. Null when
 * there is no body to draw, no DOM, or no GL — every caller of this is
 * decorating a button that already renders without it.
 *
 * `size` is the LONG edge: the picture takes the frame's own proportions (a head
 * portrait is square, a standing animal is wide), and the compositor fits it
 * into the slot without stretching.
 */
export function bakeCreaturePortrait(opts: PortraitOptions): string | null {
  const view = buildPortraitView(opts, opts);
  if (!view) return null;
  const size = opts.size ?? PORTRAIT_SIZE;
  const aspect = view.frame.halfW / view.frame.halfH;
  const w = Math.max(1, Math.round(aspect >= 1 ? size : size * aspect));
  const h = Math.max(1, Math.round(aspect >= 1 ? size / aspect : size));
  const gl = ensureRenderer(w, h);
  if (!gl) {
    view.dispose();
    return null;
  }
  try {
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(view.scene, view.camera);
    return gl.domElement.toDataURL("image/png");
  } catch {
    return null; // a lost context / tainted canvas: the button keeps its emoji
  } finally {
    view.dispose();
  }
}
