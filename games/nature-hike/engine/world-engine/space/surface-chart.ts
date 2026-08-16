// shared/world-engine/space/surface-chart.ts
//
// THE ONE TRANSFORM between the engine's two coordinate "modes":
//   • the WORLD / flight frame — 3D positions + orientations around a planet
//     (the spirit drone, the flight sim, floating-origin space).
//   • a GROUND / town frame — a flat 2D chart (x = east, z = north, y = up in
//     metres) + a heading ANGLE, anchored at one spot on the planet surface.
//     This is what the quest/town host, the dollhouse camera, and every 2D
//     town plan live in.
//
// The CANONICAL coordinate of any surface thing is planet-relative — a body plus
// a body-local direction (+ elevation). A chart is stood at ANY such point (a
// town, a wilderness patch, a whole one-city planet — the anchor is not a
// settlement) by rotating its up (+Y) onto the surface normal via the shortest
// arc (`setFromUnitVectors`), lifting to the terrain radius, then carrying it by
// the body's own orientation (so the planet's spin/orbit moves it for free).
// This matches the streamed town mesh / city-anchor convention byte-for-byte, so
// where a live town happens to be mounted a chart's (x, z) coincide with its plan
// coordinates — but the chart needs no town: convert a point or heading between
// the two modes AT ANY location, mounted or not.
//
// PRECISION: keep canonical positions in planet-local Float64 (safe to sub-mm
// past 1 AU). The Float32 jitter that forces a floating origin is a RENDER
// concern — rebase the scene on the CAMERA so drawn coordinates stay within a few
// km of 0 (sub-mm in Float32) — NOT a reason to root coordinates on a town.
//
// The body spins and orbits, so a chart is a snapshot of the CURRENT frame:
// rebuild it (cheap) whenever you need an up-to-date mapping.

import * as THREE from "three";

const _UP = /*#__PURE__*/ new THREE.Vector3(0, 1, 0);
const _EAST = /*#__PURE__*/ new THREE.Vector3(1, 0, 0);
const _NORTH = /*#__PURE__*/ new THREE.Vector3(0, 0, 1);

/** The minimal slice of a CelestialBody a chart needs (kept structural so callers
 *  aren't forced to import the whole body type). */
export interface ChartBody {
  worldPosition: THREE.Vector3;
  orientation: THREE.Quaternion;
  radius: number;
}

/**
 * The CANONICAL address of anything on a body's surface: the body, a body-LOCAL
 * unit surface direction, and an elevation (metres above the sea-level radius).
 * A town, a wilderness patch, a lone feature, a whole one-city planet are all
 * just a `SurfacePoint`; `chartAtPoint` stands a chart there. The `body` type is
 * generic so callers holding a richer body (e.g. a full `CelestialBody`) keep it.
 */
export interface SurfacePoint<B extends ChartBody = ChartBody> {
  readonly body: B;
  /** Body-local unit direction of the point on the sphere. */
  readonly localDir: THREE.Vector3;
  /** Terrain height at the point (metres above the sea-level radius). */
  readonly elevation: number;
}

/** Stand a `SurfaceChart` at a `SurfacePoint` (the body spins/orbits → rebuild). */
export function chartAtPoint(point: SurfacePoint): SurfaceChart {
  return createSurfaceChart(point.body, point.localDir, point.elevation);
}

export interface SurfaceChart {
  /** World point at the chart's ground origin (its local 0,0). */
  readonly origin: THREE.Vector3;
  /** Ground-local → world rotation (its columns are east/up/north). */
  readonly quat: THREE.Quaternion;
  readonly east: THREE.Vector3;
  readonly north: THREE.Vector3;
  readonly up: THREE.Vector3;
  /** Ground-local (x = east, z = north, y = up metres) → world position. */
  toWorld(x: number, z: number, y?: number, out?: THREE.Vector3): THREE.Vector3;
  /** World position → ground-local (result: x = east, y = up, z = north). */
  fromWorld(p: THREE.Vector3, out?: THREE.Vector3): THREE.Vector3;
  /** A ground-plane heading (radians, 0 = +north, turning toward +east) → a
   *  world quaternion (the chart rotation composed with the yaw). */
  headingToWorldQuat(angle: number, out?: THREE.Quaternion): THREE.Quaternion;
  /** A world direction → its ground-plane heading (radians), the inverse of
   *  `headingToWorldQuat`'s yaw. */
  worldDirToHeading(worldDir: THREE.Vector3): number;
}

/**
 * Build a ground chart on `body` at a body-LOCAL surface direction. `groundH` is
 * the terrain elevation at that spot (metres above the sea-level radius) — pass
 * `body.geography.surface.heightAt(localDir)` (clamped ≥ 0) to sit on the real
 * ground, or 0 for sea level.
 */
export function createSurfaceChart(
  body: ChartBody, localDir: THREE.Vector3, groundH = 0,
): SurfaceChart {
  const dir = localDir.clone().normalize();
  // Local placement rotation: stand the chart's +Y up on the surface normal,
  // shortest-arc — the same quaternion the streamed town mesh uses, so chart
  // coordinates coincide with the town plan's.
  const localQuat = new THREE.Quaternion().setFromUnitVectors(_UP, dir);
  const quat = body.orientation.clone().multiply(localQuat);
  const invQuat = quat.clone().invert();
  const origin = dir.clone().multiplyScalar(body.radius + groundH)
    .applyQuaternion(body.orientation).add(body.worldPosition);
  const east = _EAST.clone().applyQuaternion(quat).normalize();
  const north = _NORTH.clone().applyQuaternion(quat).normalize();
  const up = _UP.clone().applyQuaternion(quat).normalize();
  const _yaw = new THREE.Quaternion();
  const _tmp = new THREE.Vector3();
  return {
    origin, quat, east, north, up,
    toWorld(x, z, y = 0, out = new THREE.Vector3()) {
      return out.set(x, y, z).applyQuaternion(quat).add(origin);
    },
    fromWorld(p, out = new THREE.Vector3()) {
      return out.copy(p).sub(origin).applyQuaternion(invQuat);
    },
    headingToWorldQuat(angle, out = new THREE.Quaternion()) {
      return out.copy(quat).multiply(_yaw.setFromAxisAngle(_UP, angle));
    },
    worldDirToHeading(worldDir) {
      _tmp.copy(worldDir).applyQuaternion(invQuat); // → ground-local
      return Math.atan2(_tmp.x, _tmp.z);            // +north → +east
    },
  };
}
