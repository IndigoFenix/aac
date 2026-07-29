// shared/space/flight-camera.ts
//
// Seagull's chase camera rig, ported. Three profiles (WALK_STAND / WALK_RUN /
// FLY) blended by mode + speed, with a smoothed offset (so warp translation
// needs no catch-up) and a smoothed up (so frame transitions don't snap).
//
// Adapted for a host-owned camera + floating-origin rendering: `update` takes
// the camera and a `renderAnchor` (the world point that renders at the scene
// origin — the player position, so the camera math stays in Float32-precise
// coords near the origin at real interplanetary scale).

import * as THREE from "three";
import { PLAYER } from "./flight-config.js";
import type { PlayerState } from "./flight-sim.js";

type Profile = { back: number; height: number; lookAhead: number; lookHeight: number; smooth: number };

const WALK_STAND: Profile = { back: 1.5, height: 7, lookAhead: 4, lookHeight: 0, smooth: 4 };
const WALK_RUN: Profile = { back: 5, height: 3, lookAhead: 6, lookHeight: 3, smooth: 4 };
const FLY: Profile = { back: 6, height: 2, lookAhead: 8, lookHeight: 2, smooth: 6 };

export interface FlightCamera {
  /** Update `camera` from the player state. `renderAnchor` is subtracted from
   *  world positions so the rendered frame sits near the origin. */
  update(camera: THREE.PerspectiveCamera, state: PlayerState, dt: number, renderAnchor: THREE.Vector3): void;
}

export function createFlightCamera(): FlightCamera {
  const cameraOffset = new THREE.Vector3();
  const _desiredOffset = new THREE.Vector3();
  const smoothedUp = new THREE.Vector3(0, 1, 0);
  const _instantUp = new THREE.Vector3();
  const _base = new THREE.Vector3();
  const _look = new THREE.Vector3();
  const _profile: Profile = { back: 0, height: 0, lookAhead: 0, lookHeight: 0, smooth: 0 };
  let initialized = false;

  const lerpProfile = (a: Profile, b: Profile, t: number): Profile => {
    _profile.back = a.back + (b.back - a.back) * t;
    _profile.height = a.height + (b.height - a.height) * t;
    _profile.lookAhead = a.lookAhead + (b.lookAhead - a.lookAhead) * t;
    _profile.lookHeight = a.lookHeight + (b.lookHeight - a.lookHeight) * t;
    _profile.smooth = a.smooth + (b.smooth - a.smooth) * t;
    return _profile;
  };

  return {
    update(camera, state, dt, renderAnchor) {
      let profile: Profile;
      if (state.mode === "walking") {
        const f = Math.min(1, Math.max(0, state.walkSpeed) / PLAYER.runningTakeoffSpeed);
        profile = lerpProfile(WALK_STAND, WALK_RUN, f);
      } else if (state.mode === "swimming") {
        const f = Math.min(1, Math.max(0, state.walkSpeed) / PLAYER.swimSpeedMax);
        profile = lerpProfile(WALK_STAND, WALK_RUN, f);
      } else if (state.mode === "takeoff") {
        profile = lerpProfile(WALK_RUN, FLY, state.takeoffPhase);
      } else if (state.mode === "diving") {
        profile = lerpProfile(WALK_RUN, FLY, state.divePhase);
      } else {
        profile = FLY;
      }

      _instantUp.crossVectors(state.forward, state.bodyRight).normalize();
      if (!initialized) smoothedUp.copy(_instantUp);
      else smoothedUp.lerp(_instantUp, Math.min(1, 2.5 * dt)).normalize();

      _desiredOffset.set(0, 0, 0)
        .addScaledVector(state.forward, -profile.back)
        .addScaledVector(smoothedUp, profile.height);
      if (!initialized) { cameraOffset.copy(_desiredOffset); initialized = true; }
      else cameraOffset.lerp(_desiredOffset, Math.min(1, profile.smooth * dt));

      // Player position in the rendered (anchored) frame.
      _base.copy(state.position).sub(renderAnchor);
      camera.position.copy(_base).add(cameraOffset);
      _look.copy(_base)
        .addScaledVector(state.forward, profile.lookAhead)
        .addScaledVector(smoothedUp, profile.lookHeight);
      camera.up.copy(smoothedUp);
      camera.lookAt(_look);
      if (state.mode === "flying" && state.bank !== 0) camera.rotateZ(-state.bank * 0.3);
    },
  };
}
