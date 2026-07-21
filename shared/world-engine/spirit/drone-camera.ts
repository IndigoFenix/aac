/**
 * The SPIRIT drone — an INVISIBLE DRONE flown over a body by the same brain
 * that steers the AAC avatar (`gaze-intent.ts` produces the aim; the shared
 * `GazeSpark` marks the gaze point with the same dart/saccade animation).
 * This module owns only the drone's BODY + a top-down chase camera:
 *
 *   • the drone rides a UNIT DIRECTION on the sphere (`pos`) with a tangent
 *     `heading` and an `altitude`; motion is a great-circle rotation of
 *     (pos, heading), never lat/long — no pole singularity;
 *   • the chase camera looks STRAIGHT DOWN, drone at screen centre;
 *   • streaming anchors on the drone's GROUND POINT (rebased to the scene
 *     origin), so the camera is only ~altitude metres from the origin
 *     (Float32-precise) and there is no sphere-limb wildness.
 *
 * The HOST drives movement from the gaze's continuous NDC regimes
 * (rotate/pan/climb — the spirit ladder's flight level); altitude zones and
 * dwell logic live there, not here.
 */
import * as THREE from "three";

export interface DroneCamera {
  /** Drone ground direction (unit, on the sphere). */
  readonly pos: THREE.Vector3;
  /** Drone forward heading (unit tangent). */
  readonly heading: THREE.Vector3;
  altitude: number;
  /** World ground point under the drone (bodyCentre + pos·R). */
  groundPoint(bodyCenter: THREE.Vector3, R: number, out: THREE.Vector3): THREE.Vector3;
  /** The drone's tangent basis (east, north=heading, up=radial) — the host maps
   *  the gaze pixel and the spark point through it. */
  basis(east: THREE.Vector3, north: THREE.Vector3, up: THREE.Vector3): void;
  /** Change altitude (rate>0 climb, <0 dive; magnitude = per-second fraction),
   *  clamped to [min, max]. */
  climb(rate: number, dt: number, min: number, max: number): void;
  /** Turn the heading by `angle` rad about the local up (+ = turn right). */
  rotate(angle: number): void;
  /** Rotate the drone's ground direction AND heading bodily about a world
   *  axis through the body centre — the host's seat for the co-rotation
   *  regime (feed it a fraction of the body's spin; see the provider). This
   *  is not steering: the drone keeps its altitude and its heading relative
   *  to the ground it is over. */
  precess(axis: THREE.Vector3, angle: number): void;
  /** Move along the heading by `dist` m on the sphere of radius `R` (great
   *  circle; + forward, − backward). */
  panForward(dist: number, R: number): void;
  /** Strafe along east/right by `dist` m (+ right, − left). */
  panSide(dist: number, R: number): void;
  /** Reset the drone over a new ground direction at a given altitude — e.g.
   *  dropping back into flight above a town after city-focus. `heading`
   *  (optional, world-frame; tangentialised) carries the view's facing
   *  through the transition; omitted = the previous heading is kept. */
  setGround(dir: THREE.Vector3, altitude: number, heading?: THREE.Vector3): void;
  /** Camera pose relative to the (origin) ground point → camWorld for streaming. */
  cameraOffset(out: THREE.Vector3): THREE.Vector3;
  /** Place the shared camera: top-down chase framing the drone lower-centre. */
  place(camera: THREE.PerspectiveCamera): void;
}

const AHEAD = 0; // camera sits directly over the drone, looking STRAIGHT
                 // DOWN (drone at screen centre). A tangential offset that
                 // scales with altitude pushes the look-point off the limb.

export function createDroneCamera(
  pos: THREE.Vector3, heading: THREE.Vector3, altitude: number,
): DroneCamera {
  const _pos = pos.clone().normalize();
  const _up = _pos.clone();
  const _fwd = heading.clone().addScaledVector(_up, -heading.dot(_up));
  if (_fwd.lengthSq() < 1e-9) _fwd.set(0, 0, 1).addScaledVector(_up, -_up.z);
  _fwd.normalize();
  let alt = altitude;

  const _east = new THREE.Vector3();
  const _axis = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _look = new THREE.Vector3();

  const retangent = (): void => {
    _up.copy(_pos);
    _fwd.addScaledVector(_up, -_fwd.dot(_up));
    if (_fwd.lengthSq() < 1e-12) _fwd.set(0, 0, 1).addScaledVector(_up, -_up.z);
    _fwd.normalize();
    _east.crossVectors(_fwd, _up).normalize();
  };

  return {
    get pos() { return _pos; },
    get heading() { return _fwd; },
    get altitude() { return alt; },
    set altitude(v) { alt = v; },

    groundPoint(bc, R, out) {
      return out.copy(bc).addScaledVector(_pos, R);
    },
    basis(east, north, up) {
      retangent();
      east.copy(_east);
      north.copy(_fwd);
      up.copy(_up);
    },
    climb(rate, dt, min, max) {
      alt = Math.max(min, Math.min(max, alt * Math.exp(rate * dt)));
    },
    setGround(dir, altitude, heading) {
      _pos.copy(dir).normalize();
      _up.copy(_pos);
      alt = altitude;
      if (heading) _fwd.copy(heading);
      retangent();
    },
    rotate(angle) {
      if (Math.abs(angle) < 1e-7) return;
      retangent();
      _q.setFromAxisAngle(_up, -angle); // +angle → heading turns toward +east (right)
      _fwd.applyQuaternion(_q).normalize();
    },
    precess(axis, angle) {
      if (Math.abs(angle) < 1e-12) return; // spin steps are tiny — no 1e-7 gate
      _q.setFromAxisAngle(axis, angle);
      _pos.applyQuaternion(_q).normalize();
      _fwd.applyQuaternion(_q);
      retangent();
    },
    panForward(dist, R) {
      if (Math.abs(dist) < 1e-6 || R < 1e-6) return;
      retangent();
      _axis.crossVectors(_up, _fwd).normalize(); // moving along fwd = rotate about up×fwd
      _q.setFromAxisAngle(_axis, dist / R);
      _pos.applyQuaternion(_q).normalize();
      _fwd.applyQuaternion(_q).normalize();
      _up.copy(_pos);
    },
    panSide(dist, R) {
      if (Math.abs(dist) < 1e-6 || R < 1e-6) return;
      retangent();
      _axis.crossVectors(_up, _east).normalize(); // moving along east = rotate about up×east
      _q.setFromAxisAngle(_axis, dist / R);
      _pos.applyQuaternion(_q).normalize();
      _fwd.applyQuaternion(_q).normalize();
      _up.copy(_pos);
    },
    cameraOffset(out) {
      retangent();
      return out.copy(_up).multiplyScalar(alt).addScaledVector(_fwd, alt * AHEAD);
    },
    place(camera) {
      retangent();
      // STRAIGHT DOWN: the camera sits directly above a point AHEAD of the drone
      // and looks vertically down at it. The drone (the origin ground point) is
      // then BEHIND that sub-camera point → it frames in the lower-centre (with
      // `up = fwd`, forward is up-screen, so "behind" is down-screen).
      camera.position.copy(_up).multiplyScalar(alt).addScaledVector(_fwd, alt * AHEAD);
      camera.up.copy(_fwd);
      _look.copy(_fwd).multiplyScalar(alt * AHEAD); // the ground point directly below → view is −up
      camera.lookAt(_look);
    },
  };
}
