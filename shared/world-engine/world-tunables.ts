// shared/world-engine/world-tunables.ts
//
// Live-tunable constants for the eye-gaze movement + camera system, split into
// three groups (gaze interpreter, camera director, motion comfort). Kept PURE
// (no DOM, no three.js) so the headless gaze interpreter and the unit tests can
// import the defaults without pulling in WebGL — render3d.ts imports the camera +
// comfort types from here, gaze-intent.ts imports the gaze type.
//
// These are exposed live through the debug menu (WorldDebugPanel) while we tune
// the feel; a per-student settings surface replaces that later, so the SHAPE here
// is the contract the future settings system will serialise. See
// planning-docs/eyegaze-3d-movement.md for the why behind each knob.

// ---------------------------------------------------------------------------
// Gaze interpreter (shared/world-engine/gaze-intent.ts)
// ---------------------------------------------------------------------------

export interface GazeTunables {
  /** Pointer/gaze speed (CSS px/sec) above which motion is a saccade/flick: the
   *  committed aim is HELD (not chased) until the eyes/cursor settle again, so a
   *  fast glance never lurches the avatar. Eye saccades are far above this; mouse
   *  drags and smooth pursuit are below it (so they track live). */
  saccadeSpeedPx: number;
  /** Milliseconds of sub-saccade motion required after a flick before the aim
   *  re-commits to the new point — a short settle so the aim doesn't ride the
   *  cursor THROUGH a flick. */
  settleMs: number;
  /** Ease rate (1/sec) of the committed aim toward the live point while settled.
   *  High ⇒ responsive (good for mouse); the saccade gate is what tames jitter. */
  commitEase: number;
  /** Ease rate (1/sec) of the "unsettled" weakening scalar in/out. */
  unsettleEase: number;
  /** How strongly an unsettled gaze pulls the aim back toward the avatar (0..1):
   *  0 = hold the old aim through a flick, 1 = fully brake to the avatar. The
   *  doc's "weakening". */
  weakenStrength: number;
  /** World units: an aim within this of the avatar counts as "not travelling"
   *  (feeds the auto-sit idle timer; the avatar is just turning/watching). */
  sitGazeRadius: number;
  /** Milliseconds with no travel intent (aim within sitGazeRadius, or absent)
   *  before the avatar auto-sits (WATCH mode). */
  idleSitMs: number;
  /** Once SITTING, milliseconds of sustained far-gaze DWELL required to stand up
   *  and move (a glance away won't do it — standing is a deliberate commitment). */
  standDwellMs: number;
}

export const DEFAULT_GAZE_TUNABLES: GazeTunables = {
  saccadeSpeedPx: 1800,
  settleMs: 90,
  commitEase: 18,
  unsettleEase: 16,
  weakenStrength: 0.5,
  sitGazeRadius: 2.5,
  idleSitMs: 2500,
  standDwellMs: 550,
};

// ---------------------------------------------------------------------------
// Camera director (shared/world-engine/render3d.ts)
// ---------------------------------------------------------------------------

/** One camera-rig pose. The camera sits `back` behind + `height` above the
 *  followed point and looks `lookAhead` in front at `lookHeight`; `fov` is the
 *  vertical field of view. Overhead = high+near+steep; shoulder = low+far+shallow. */
export interface CameraRigPose {
  height: number;
  back: number;
  lookAhead: number;
  lookHeight: number;
  fov: number;
}

export interface CameraTunables {
  /** WATCH / local-navigation home base: near-top-down, translate in any
   *  direction with no rotation needed. */
  overhead: CameraRigPose;
  /** TRAVEL mode: tilted down behind the avatar, revealing the destination
   *  ahead. Entered only on sustained forward travel intent. */
  shoulder: CameraRigPose;
  /** Ease rate (1/sec) the followed centre tracks the local avatar (position). */
  follow: number;
  /** Ease stiffness (1/sec) of the heading toward the travel direction. The
   *  per-frame turn is then capped by the gaze-distance rule + comfort.maxYawSpeed. */
  yawStiffness: number;
  /** Gaze-distance turn rule: effective max turn (rad/sec) = yawDistGain /
   *  max(gazeDistance, yawDistMin), itself capped by comfort.maxYawSpeed. So far
   *  gaze ⇒ slow turn, near gaze ⇒ fast pivot (up to the comfort ceiling). */
  yawDistGain: number;
  yawDistMin: number;
  /** Below this avatar speed (units/sec) the heading is HELD (a near-stationary
   *  velocity/aim direction is noisy). */
  moveThreshold: number;
  // --- Overhead ↔ shoulder transition (hysteresis bands) --------------------
  /** Gaze distance (world units) above which sustained forward gaze commits to
   *  TRAVEL (shoulder). Must be > travelExitDist. Kept SMALL — a gaze even a
   *  little above the avatar means "going somewhere"; overhead is for rest,
   *  pivoting, and walking toward the bottom of the screen (the ahead gates). */
  travelEnterDist: number;
  /** Gaze distance below which we drop back to overhead. */
  travelExitDist: number;
  /** dot(aimDir, camForward) above which the gaze counts as "toward the top of the
   *  screen" (ahead) — required to enter shoulder. Kept low so facing forward even
   *  a little bit (well shy of straight ahead) commits to travel. */
  travelAheadEnter: number;
  /** dot(aimDir, camForward) below which the gaze counts as "behind" — drops to
   *  overhead (never whips the shoulder cam 180°). */
  travelAheadExit: number;
  /** Ease rate (1/sec) of the overhead↔shoulder rig morph — slow + gentle. */
  travelEase: number;
}

export const DEFAULT_CAMERA_TUNABLES: CameraTunables = {
  // Pulled in ~20–25% for the human-scale (1.8 m) avatars — the old distances
  // were framed for the larger balloon-headed figures and read too far away.
  overhead: { height: 24, back: 2.5, lookAhead: 2.5, lookHeight: 0.6, fov: 50 },
  shoulder: { height: 11, back: 10.5, lookAhead: 6.5, lookHeight: 1.1, fov: 50 },
  follow: 5,
  yawStiffness: 2.2,
  yawDistGain: 4.0,
  yawDistMin: 2.0,
  moveThreshold: 0.35,
  travelEnterDist: 3.5,
  travelExitDist: 2,
  travelAheadEnter: 0.15,
  travelAheadExit: -0.1,
  travelEase: 1.5,
};

// ---------------------------------------------------------------------------
// INTERACT intent (shared/world-engine/interact.ts)
// ---------------------------------------------------------------------------

export interface InteractTunables {
  /** Gaze within this of a toy (world units) snaps the aim onto it (walk in /
   *  grab). Combined with the toy's own touchRadius (whichever is larger). */
  toyPickRadius: number;
  /** Gaze within this of a person (NPC/peer) engages an approach to them. */
  avatarPickRadius: number;
  /** Stop this far from a person and face them (conversation distance). */
  npcStopDistance: number;
}

export const DEFAULT_INTERACT_TUNABLES: InteractTunables = {
  toyPickRadius: 1.2,
  avatarPickRadius: 1.6,
  npcStopDistance: 2.0,
};

// ---------------------------------------------------------------------------
// Motion comfort (the vignette + rotation clamp in render3d.ts)
// ---------------------------------------------------------------------------

export interface ComfortTunables {
  /** Peak peripheral dim applied WHILE the camera is in motion (0 disables the
   *  vignette). The single biggest anti-nausea lever. */
  maxVignette: number;
  /** Radius (fraction of the half-diagonal) at which the vignette starts. */
  vignetteInner: number;
  /** Linear / angular speeds mapped to "full" optical flow for the vignette. */
  refSpeed: number;
  refYaw: number;
  /** Hard ceiling on camera turn rate (rad/sec) — rotation is the worst trigger,
   *  so this caps even a near-gaze pivot. */
  maxYawSpeed: number;
  /** Ignore heading changes below this (rad) so a glance doesn't wobble the view. */
  yawDeadband: number;
  /** How fast the vignette eases in/out (1/sec) — gentle, so it never flickers. */
  vignetteEase: number;
}

export const DEFAULT_COMFORT_TUNABLES: ComfortTunables = {
  maxVignette: 0.5,
  vignetteInner: 0.55,
  refSpeed: 5,
  refYaw: 0.6,
  maxYawSpeed: 0.7, // ~40°/s
  yawDeadband: 0.05,
  vignetteEase: 6,
};

// ---------------------------------------------------------------------------
// Combined
// ---------------------------------------------------------------------------

export interface WorldTunables {
  gaze: GazeTunables;
  camera: CameraTunables;
  comfort: ComfortTunables;
  interact: InteractTunables;
}

export const DEFAULT_WORLD_TUNABLES: WorldTunables = {
  gaze: DEFAULT_GAZE_TUNABLES,
  camera: DEFAULT_CAMERA_TUNABLES,
  comfort: DEFAULT_COMFORT_TUNABLES,
  interact: DEFAULT_INTERACT_TUNABLES,
};

/** Deep-clone the defaults so callers can mutate a private copy (the debug menu
 *  edits one of these and pushes it live). */
export function cloneWorldTunables(t: WorldTunables = DEFAULT_WORLD_TUNABLES): WorldTunables {
  return {
    gaze: { ...t.gaze },
    camera: {
      ...t.camera,
      overhead: { ...t.camera.overhead },
      shoulder: { ...t.camera.shoulder },
    },
    comfort: { ...t.comfort },
    interact: { ...t.interact },
  };
}
