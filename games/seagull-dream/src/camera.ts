import * as THREE from "three";
import { PLAYER } from "./config";
import type { PlayerState } from "./player";

// Three camera profiles:
//
// - Walk-stand: bird is grounded, ~stationary. Camera sits above and
//   tilts downward — aim point reads as a ground position so the player
//   can pick where the bird walks toward.
//
// - Walk-run / takeoff: as walk speed grows, the camera swings BEHIND
//   the bird (closer to the flight chase rig) so the takeoff zone at
//   the top of the screen reads as "above the horizon" rather than
//   "behind the bird."
//
// - Fly: chase camera trailing the bird, looking at a point slightly
//   ahead so the horizon is visible.
//
// Walking smoothly interpolates between walk-stand and walk-run based
// on `walkSpeed / runningTakeoffSpeed`, then walking → flying is
// another smooth blend during takeoff. All transitions go through the
// `cameraOffset` lerp so the user never sees a snap.

// Each profile has:
//   back       — camera distance behind the bird (along -forward)
//   height     — camera height above the bird (along up)
//   lookAhead  — distance along +forward to the look-at point
//   lookHeight — height OFFSET of the look-at point (along up). If
//                lookHeight == height, the camera's view direction is
//                EXACTLY along bird forward → screen center = motion
//                direction (no parallax tilt). Lower lookHeight tilts
//                the view downward (useful when walking, so the player
//                can aim at ground points).
//   smooth     — per-second rate the camera offset lerps toward the
//                target offset.

// "Walk stand" — the bird is barely moving. Camera sits high and close,
// looking steeply down so the mouse aim picks ground points.
const WALK_STAND = {
  back: 1.5,
  height: 7,
  lookAhead: 4,
  lookHeight: 0, // look at ground for walking-aim
  smooth: 4,
};

// "Walk run" — bird is at takeoff speed. Camera is behind and lower —
// almost identical to the flight chase, so the transition to "flying"
// at takeoff doesn't jolt the camera.
const WALK_RUN = {
  back: 5,
  height: 3,
  lookAhead: 6,
  lookHeight: 3, // matches height → view parallel to forward
  smooth: 4,
};

const FLY = {
  back: 6,
  height: 2,
  lookAhead: 8,
  lookHeight: 2, // matches height → screen center == bird forward
  smooth: 6,
};

export interface CameraRig {
  camera: THREE.PerspectiveCamera;
  update(state: PlayerState, dt: number): void;
}

export function createCameraRig(): CameraRig {
  // Far clip needs to span the entire universe at our scale: home galaxy
  // is ~30 ly in radius at 1 Gm/ly = 30 Gm, plus the direction-locked
  // starfield-on-a-sphere sits at 10 Gm from the camera so depth
  // testing can naturally cull it behind closer geometry. We're using
  // logarithmicDepthBuffer on the renderer, which keeps precision
  // usable across the full near→far range without z-fighting.
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1e15);
  const targetLook = new THREE.Vector3();

  // Camera offset, expressed in WORLD coords but conceptually a vector in the
  // player's frame (forward/up). At any player position the camera lives at
  // `player.position + cameraOffset`. By smoothing the OFFSET rather than the
  // absolute world position, translation at any speed (including warp) costs
  // no catch-up — the camera moves with the player automatically — and the
  // smoothing only kicks in when the player turns or transitions modes.
  // This is what eliminates the snap/lerp oscillation flicker.
  const cameraOffset = new THREE.Vector3();
  const _desiredOffset = new THREE.Vector3();
  // Smoothed "up" vector the camera trails — both POSITION (height in
  // this direction) and ORIENTATION (camera.up) read from it, so the
  // two stay consistent. It tracks the bird's body-up (forward ×
  // bodyRight) but with a rate-limited lerp so abrupt body-up changes
  // — both from rapid pitch/yaw input AND from reference-frame
  // transitions (planet → star → galactic, each of which can swing
  // state.up and re-align bodyRight) — translate to a smooth camera
  // re-orientation over ~0.5 s rather than a 1-frame snap.
  const smoothedUp = new THREE.Vector3(0, 1, 0);
  const _instantUp = new THREE.Vector3();

  let initialized = false;

  // Resolve the active profile each frame. Walking blends WALK_STAND →
  // WALK_RUN with `walkSpeed / runningTakeoffSpeed`. Takeoff blends
  // WALK_RUN → FLY across the 250 ms animation. Flying & drifting use
  // FLY directly. The blended profile is written into a scratch object
  // and returned (single allocation, mutated each frame).
  const _profile = { back: 0, height: 0, lookAhead: 0, lookHeight: 0, smooth: 0 };
  function lerpProfile(a: typeof FLY, b: typeof FLY, t: number) {
    _profile.back = a.back + (b.back - a.back) * t;
    _profile.height = a.height + (b.height - a.height) * t;
    _profile.lookAhead = a.lookAhead + (b.lookAhead - a.lookAhead) * t;
    _profile.lookHeight = a.lookHeight + (b.lookHeight - a.lookHeight) * t;
    _profile.smooth = a.smooth + (b.smooth - a.smooth) * t;
    return _profile;
  }

  return {
    camera,
    update(state, dt) {
      let profile: typeof FLY;
      if (state.mode === "walking") {
        // Speed fraction: 0 at standstill, 1 at running-takeoff speed.
        // Backward walking stays at the stand profile.
        const fwd = Math.max(0, state.walkSpeed);
        const f = Math.min(1, fwd / PLAYER.runningTakeoffSpeed);
        profile = lerpProfile(WALK_STAND, WALK_RUN, f);
      } else if (state.mode === "swimming") {
        // Swimming uses the same overhead profile as standing — the
        // player still aims downward to pick water points to drift
        // toward. Speed scaling matches the swim cap.
        const fwd = Math.max(0, state.walkSpeed);
        const f = Math.min(1, fwd / PLAYER.swimSpeedMax);
        profile = lerpProfile(WALK_STAND, WALK_RUN, f);
      } else if (state.mode === "takeoff") {
        // takeoffPhase 0..1 across the 250 ms animation — bridge from
        // WALK_RUN to FLY so the chase camera is in position by the
        // time the bird is airborne.
        profile = lerpProfile(WALK_RUN, FLY, state.takeoffPhase);
      } else if (state.mode === "diving") {
        // Diving bridges swim → underwater. Lerp from WALK_RUN to FLY
        // along divePhase so the chase is in place by the time the
        // bird is underwater.
        profile = lerpProfile(WALK_RUN, FLY, state.divePhase);
      } else {
        // Flying / drifting / underwater / stunned share FLY —
        // interstellar transit and aquatic exploration both read as
        // continued chase rather than an overhead view.
        profile = FLY;
      }

      // Update the smoothed up vector. Target = body-up (forward ×
      // bodyRight, guaranteed perpendicular to forward so the camera's
      // lookAt never degenerates). Lerp rate is slow enough that
      // reference-frame transitions and rapid bird rotation translate
      // to smooth camera re-orientation, not visible snaps.
      _instantUp.crossVectors(state.forward, state.bodyRight).normalize();
      if (!initialized) {
        smoothedUp.copy(_instantUp);
      } else {
        const upK = Math.min(1, 2.5 * dt);
        smoothedUp.lerp(_instantUp, upK).normalize();
      }

      _desiredOffset
        .set(0, 0, 0)
        .addScaledVector(state.forward, -profile.back)
        .addScaledVector(smoothedUp, profile.height);

      if (!initialized) {
        cameraOffset.copy(_desiredOffset);
        initialized = true;
      } else {
        const k = Math.min(1, profile.smooth * dt);
        cameraOffset.lerp(_desiredOffset, k);
      }

      camera.position.copy(state.position).add(cameraOffset);

      // Look point sits along the forward axis (lookAhead) AND at
      // lookHeight along the smoothed up — putting it at the same
      // height as the camera (when lookHeight == height) makes the
      // view direction PARALLEL to bird forward, so screen center
      // exactly maps to motion direction. The bird itself sits
      // below screen center by atan(height / (back+lookAhead)).
      targetLook
        .copy(state.position)
        .addScaledVector(state.forward, profile.lookAhead)
        .addScaledVector(smoothedUp, profile.lookHeight);

      // camera.up = smoothedUp keeps the camera's orientation and
      // position in the same reference, so the horizon reads correctly.
      camera.up.copy(smoothedUp);
      camera.lookAt(targetLook);

      // Banking: in flight, gently roll the camera with the player's bank.
      // Sign: camera.rotateZ around local +Z is CCW from the user, which
      // tilts the horizon's right side UP; we want the horizon to drop on
      // the right when banking right, so we negate.
      if (state.mode === "flying" && state.bank !== 0) {
        camera.rotateZ(-state.bank * 0.3);
      }
    },
  };
}
