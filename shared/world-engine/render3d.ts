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
import type { Vec2, WorldSpec } from "./types.js";
import type { AvatarState, WorldState } from "./engine.js";
import type { RenderIntent, WorldView, WorldViewDeps } from "./world-view.js";
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
  /** Cylinder length of the capsule (total height = length + 2·radius = 1.8). */
  bodyLength: 0.9,
  faceY: 2.1,
  faceRadius: 0.62,
} as const;

const BACKDROP = "#0f172a";

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
      faceGroup.position.y = baseFaceY - 0.45 * seatedAmt + bob;

      // INTERACT highlight: brighten the face ring + a soft scale pulse so the
      // player sees who/what they're about to engage.
      const hi = frame.highlighted ? 1 : 0;
      ringMat.opacity = baseRingOpacity + (1 - baseRingOpacity) * hi;
      ring.scale.setScalar(1 + 0.08 * hi * (0.5 + 0.5 * Math.sin(animClock * 5)));

      // Billboard the face card toward the camera.
      faceGroup.quaternion.copy(frame.camera.quaternion);
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

export interface World3DRendererOptions {
  localId: string;
  backdrop?: string;
  /** Swap in richer avatar bodies (e.g. the creature-builder). */
  modelFactory?: AvatarModelFactory;
  /** Camera-rig + transition overrides (merged over DEFAULT_CAMERA_TUNABLES). */
  camera?: Partial<CameraTunables>;
  /** Motion-comfort overrides (merged over DEFAULT_COMFORT_TUNABLES). */
  comfort?: Partial<ComfortTunables>;
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

  private readonly avatars = new Map<string, AvatarModel>();
  private readonly toys = new Map<string, { mesh: THREE.Mesh; shadow: THREE.Mesh }>();

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

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, spec: WorldSpec, opts: World3DRendererOptions) {
    this.spec = spec;
    this.localId = opts.localId;
    this.modelFactory = opts.modelFactory ?? defaultAvatarModelFactory;
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
    intent?: RenderIntent,
  ): void {
    this.syncAvatars(state, dt, faceFor, labelFor, intent?.sitting ?? false, intent?.interactId);
    this.syncToys(state, intent?.interactId);
    this.updateCamera(state, dt, intent);
    this.updateComfort(state, dt);

    // Scene, then the comfort vignette on top (autoClear is off).
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.overlayScene, this.overlayCamera);
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
        this.avatars.set(a.id, model);
        this.scene.add(model.object);
      }
      model.object.position.set(a.x, 0, a.y);
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

  private syncToys(state: WorldState, interactId?: string): void {
    for (const toy of Object.values(state.toys)) {
      const spec = state.spec.toys.find((t) => t.id === toy.id);
      const radius = spec?.radius ?? 0.5;
      let entry = this.toys.get(toy.id);
      if (!entry) {
        const geom = new THREE.SphereGeometry(radius, 24, 16);
        const mat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.5, metalness: 0 });
        const mesh = new THREE.Mesh(geom, mat);
        const shadowGeom = new THREE.CircleGeometry(radius * 1.1, 20);
        const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.2 });
        const shadow = new THREE.Mesh(shadowGeom, shadowMat);
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = 0.02;
        this.scene.add(mesh);
        this.scene.add(shadow);
        this.disposables.push(geom, mat, shadowGeom, shadowMat);
        entry = { mesh, shadow };
        this.toys.set(toy.id, entry);
      }
      entry.mesh.position.set(toy.x, radius, toy.y);
      entry.shadow.position.set(toy.x, 0.02, toy.y);
      // Possession tint on the ball's emissive so the owner is readable; an
      // INTERACT highlight (the local gaze resting on a FREE toy) pulses cyan.
      const mat = entry.mesh.material as THREE.MeshStandardMaterial;
      if (toy.possessedBy) {
        mat.emissive = colorForId(toy.possessedBy);
        mat.emissiveIntensity = 0.35;
      } else if (toy.id === interactId) {
        mat.emissive.set("#38bdf8");
        mat.emissiveIntensity = 0.35 + 0.2 * Math.sin(state.time * 5);
      } else {
        mat.emissiveIntensity = 0;
      }
    }
  }

  private updateCamera(state: WorldState, dt: number, intent?: RenderIntent): void {
    const me = state.avatars[this.localId];
    const step = Math.max(0, dt);
    const cam = this.cameraCfg;
    const sitting = intent?.sitting ?? false;
    const aim = intent?.aim ?? null;

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
    if (me && aim) {
      const dx = aim.x - me.x;
      const dz = aim.y - me.y;
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

    // Heading: ease toward the aim direction. Held while sitting, when the gaze is
    // on the avatar (gd ≤ moveThreshold), or with no aim — so a watcher's glances
    // never rotate the world. Turn rate is capped BOTH by the gaze-distance rule
    // (near gaze ⇒ fast pivot, far gaze ⇒ slow reveal) AND comfort.maxYawSpeed.
    let appliedYaw = 0;
    if (!sitting && haveDir && gazeDistance > cam.moveThreshold) {
      const cur = Math.atan2(this.camForward.x, this.camForward.z);
      const tgt = Math.atan2(aimx, aimz);
      let delta = Math.atan2(Math.sin(tgt - cur), Math.cos(tgt - cur)); // shortest turn
      if (Math.abs(delta) < this.comfort.yawDeadband) delta = 0;
      let stepAngle = delta * (1 - Math.exp(-cam.yawStiffness * step));
      const effMax = Math.min(
        this.comfort.maxYawSpeed,
        cam.yawDistGain / Math.max(gazeDistance, cam.yawDistMin),
      );
      const maxStep = effMax * step;
      if (stepAngle > maxStep) stepAngle = maxStep;
      else if (stepAngle < -maxStep) stepAngle = -maxStep;
      const next = cur + stepAngle;
      this.camForward.set(Math.sin(next), 0, Math.cos(next));
      appliedYaw = stepAngle;
    }
    this.lastYawSpeed = step > 0 ? Math.abs(appliedYaw) / step : 0;

    // Overhead ↔ shoulder transition (hysteresis bands). Commit to TRAVEL only on a
    // sustained forward far gaze; drop to OVERHEAD when sitting, stopped, gaze
    // pulled in, or gaze behind (so "look behind me" lifts to overhead to pivot,
    // never whips the shoulder cam 180°).
    const enterTravel =
      !sitting && haveDir && gazeDistance > cam.travelEnterDist && ahead > cam.travelAheadEnter;
    const exitTravel =
      sitting || !haveDir || gazeDistance < cam.travelExitDist || ahead < cam.travelAheadExit;
    if (enterTravel) this.travelTarget = 1;
    else if (exitTravel) this.travelTarget = 0;
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
    for (const model of this.avatars.values()) {
      this.scene.remove(model.object);
      model.dispose();
    }
    this.avatars.clear();
    for (const { mesh, shadow } of this.toys.values()) {
      this.scene.remove(mesh);
      this.scene.remove(shadow);
    }
    this.toys.clear();
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
  opts?: { modelFactory?: AvatarModelFactory; backdrop?: string },
): WorldView {
  const { canvas, localId, faceFor, labelFor } = deps;
  const renderer = new World3DRenderer(canvas, spec, {
    localId,
    modelFactory: opts?.modelFactory,
    backdrop: opts?.backdrop,
  });
  return {
    screenToWorld: (px, py) => renderer.screenToWorld(px, py),
    render: (state, dt, intent) => renderer.render(state, dt, faceFor, labelFor, intent),
    resize: (width, height, dpr) => renderer.resize(width, height, dpr),
    setTunables: (t) => renderer.setTunables({ camera: t.camera, comfort: t.comfort }),
    dispose: () => renderer.dispose(),
  };
}
