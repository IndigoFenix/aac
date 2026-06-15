import * as THREE from "three";
import type { ScatterObject } from "./scatter";
import type { CloudSystem } from "./cloud-system";
import type { ResolvedBody } from "./physics-system/system";

// A celestial body — anything with mass and position in the world. Stars,
// rocky planets, gas planets, moons all share this shape; the differences
// are in their visuals and which optional samplers they expose.
//
// Bodies form a parent chain: a moon's `orbit.parent` is its planet, the
// planet's `orbit.parent` is its star, and the star has no orbit (it sits
// at the solar system's center of gravity, which is the system root).
//
// Each frame, `world.update` advances every body's transform in
// parent-before-child order so a moon's worldPosition is correctly
// derived from its planet's just-updated worldPosition.

export type BodyType = "star" | "rocky" | "gas";

export interface BodyOrbit {
  parent: CelestialBody;
  /** Distance from the parent body's center, in world units (m). */
  semiMajorAxis: number;
  /** Seconds for one full revolution. */
  period: number;
  /** Initial phase angle, radians. */
  phase: number;
  /** Tilt relative to the parent's equatorial plane, radians. */
  inclination: number;
}

export interface BodyRotation {
  /** Axis of rotation in WORLD coords (unit vector). */
  axis: THREE.Vector3;
  /** Radians/sec. Sign determines direction (right-hand rule on axis). */
  rate: number;
}

export interface CelestialBody {
  id: string;
  type: BodyType;
  /** Body radius (m). For walkable bodies this is the sphere radius before
   *  terrain displacement; for stars/gas planets it's the visible disc. */
  radius: number;
  /** Gravity influence falloff distance — used by the legacy `gravityAt`
   *  dominant-body query. Real gravity now uses `gm` / r² and reaches
   *  arbitrarily far; this just defines where "in this body's well enough
   *  to attach to it" begins. */
  influenceFalloff: number;
  /** Standard gravitational parameter — GM (G times mass). Gravity at
   *  distance r is `gm / r²` toward the body. */
  gm: number;
  /** e-folding scale height of the body's atmosphere (m). Density at altitude
   *  h above surface is `exp(-h/scaleHeight)`. Stars and small moons still
   *  have nominal atmospheres — very thick for stars, very thin for moons. */
  atmosphereScaleHeight: number;

  orbit: BodyOrbit | null;
  rotation: BodyRotation;

  /** Whether the player can land on / walk this body. Only walkable bodies
   *  have surfaceAt / groundNormalAt. */
  walkable: boolean;

  /** Whether this body has a liquid ocean shell above its terrain. When
   *  true, `heightAt` returning a negative value at a sample direction
   *  means there's water above terrain at that point. False for barren
   *  rocky bodies and all stars/gas giants. */
  hasOcean: boolean;

  /** Sea level expressed as a height (same units as heightAt). Water
   *  exists from `seaLevel` down to the ocean floor at directions where
   *  `heightAt(dir) < seaLevel`. Meaningless when `hasOcean` is false. */
  seaLevel: number;

  /** Root group containing the body's visual mesh(es). Positioned and rotated
   *  by world.update each frame. */
  group: THREE.Group;

  // ── Mutable transform state ─────────────────────────────────────────────
  worldPosition: THREE.Vector3;
  /** Previous frame's world position. Used by player frame-attach to apply
   *  the right translation delta as the body orbits. */
  prevWorldPosition: THREE.Vector3;
  /** Current axial orientation (cumulative rotation around the body's axis). */
  orientation: THREE.Quaternion;
  /** Cached inverse of `orientation`. Updated by `refreshTransform`. */
  inverseOrientation: THREE.Quaternion;
  /**
   * Hill sphere radius (m) — the region within which this body's gravity
   * dominates over its parent's. Computed once at construction from
   * Kepler's parameters: `a × (gm / (3 × gm_parent))^(1/3)`. `Infinity`
   * for the system root (no parent → infinite sphere).
   *
   * Used by `world.findDominantBody` to assign a "local frame" to the
   * player based on which body's neighborhood they're in.
   */
  hillRadius: number;
  /**
   * Angular-size dominance radius (m) — the distance from this body's
   * center at which it subtends the same angle in the sky as its parent.
   * `a × r / (r + r_parent)`. Useful for diagnostic / debug purposes;
   * the warp picker now sums density-weighted contributions across all
   * bodies rather than gating on a single Hill containment test.
   */
  visualHillRadius: number;
  /**
   * Warp-restriction density factor. Rocky planets/moons = 1.0 (their
   * angular footprint maps fully to navigation restriction). Gas
   * planets and stars contribute less per unit angular size, so the
   * player can dive through them at higher warp than rocky surfaces of
   * the same apparent size allow.
   *
   *   rocky / moon: 1.0
   *   gas planet:   0.4
   *   star:         0.2
   */
  warpDensity: number;
  /**
   * Bulk mass density (kg/m³). Drives the warp-impedance contribution:
   * impedance per body = (bulkDensity / RHO_REF_BULK)^0.25 × radius/distance.
   * Rocky ≈ 5500 (Earth), gas ≈ 1300 (Jupiter), star ≈ 1400 (sun),
   * moon ≈ 3300. Independent of the warp-restriction density above —
   * that one is a game-feel weight, this one is a physical material
   * property.
   */
  bulkDensity: number;
  /**
   * Atmospheric surface density (kg/m³ at altitude=0). Multiplied by
   * exp(-altitude/scaleHeight) for the density at any point above the
   * surface, then summed across bodies and normalized to Earth's
   * 1.225 kg/m³ to feed the wing/rocket/warp blend. Earthlike rocky
   * ≈ 1.225; barren rocky ≈ 0.02 (Mars-ish); gas ≈ 50; star ≈ 1000;
   * moon ≈ 0.001.
   */
  surfaceAirDensity: number;
  /** Body's linear velocity in world frame (m/s). Derived each frame from
   *  the position delta over dt. Used to compute "wind" at points in the
   *  body's atmosphere. */
  velocity: THREE.Vector3;

  // ── Common samplers ─────────────────────────────────────────────────────
  /** Unit vector from body center to worldPos, in WORLD frame. */
  upAt(worldPos: THREE.Vector3, out?: THREE.Vector3): THREE.Vector3;
  /** Signed altitude above the body's surface (m). */
  altitudeAt(worldPos: THREE.Vector3): number;

  // ── Walkable-body samplers (optional) ───────────────────────────────────
  surfaceAt?(worldPos: THREE.Vector3, out?: THREE.Vector3): THREE.Vector3;
  groundNormalAt?(worldPos: THREE.Vector3, epsilon: number, out?: THREE.Vector3): THREE.Vector3;
  heightAt?(localDir: THREE.Vector3): number;

  /** Per-body internal update (e.g. LOD walk for rocky planets). Called by
   *  world.update AFTER the body's transform has been advanced for the frame.
   *  cameraForwardWorld (optional, normalized, world space) lets the body pass a
   *  view direction to its cloud system for view-cone culling. */
  update(cameraWorldPos: THREE.Vector3, dt: number, cameraForwardWorld?: THREE.Vector3): void;

  // ── Optional visual hints used by the sky / atmosphere ──────────────────
  /** Daytime sky background color (zenith — directly overhead, used by
   *  createSky if this body is the player's dominant body). Rocky bodies
   *  set this from a hybrid of palette override + physics-derived
   *  atmosphere color; stars and gas planets leave it undefined. */
  skyDay?: THREE.Color;
  /** Nighttime sky background color. Same conventions as skyDay. */
  skyNight?: THREE.Color;
  /** Daytime sky color near the horizon — longer light path, hazier
   *  tone. Used for vertical gradient against skyDay (zenith). */
  skyHorizon?: THREE.Color;
  /** Visible top of the atmosphere above the body's surface (m). Drives
   *  the atmosphere shell radius + the sky→space fade. */
  atmosphereTopAltitude?: number;
  /** Horizontal visibility through the atmosphere (m). Drives fog far
   *  plane when the camera is inside the atmosphere. */
  visibilityRange?: number;
  /** Cloud-deck base altitude above the body's surface (m). null if no
   *  significant cloud layer. */
  cloudBaseAltitude?: number;
  /** Cloud layer vertical extent (m). */
  cloudThickness?: number;
  /** Fractional cloud coverage 0..1. */
  cloudCoverage?: number;
  /** Cloud albedo color — water=white, sulfuric=cream, ammonia=tan, etc. */
  cloudColor?: THREE.Color;
  /** Apparent color of this body when viewed from a distance — used by the
   *  halo system to brighten the body as a fixed-pixel-size sprite that
   *  fades out once the player is close enough to see the real geometry.
   *  Stars don't get a halo (their emissive disc is already bright). */
  haloColor?: THREE.Color;

  /** Per-body cloud renderer. Created lazily by `materialize()` for bodies
   *  with a meaningful cloud field; null/undefined for airless or thin-
   *  atmosphere bodies. The system's group lives under `body.group`, so
   *  the planet's rotation carries clouds with it automatically. */
  cloudSystem?: CloudSystem;

  /** Active scatter objects (trees / rocks) for this body. Streamed in/out
   *  by the terrain quadtree: each leaf chunk at depth ≥ MIN_SCATTER_DEPTH
   *  contributes its objects on build and removes them on dispose. All
   *  positions are in planet-LOCAL coords; the player converts its world
   *  position into local before iterating. Set lookup is O(1) for
   *  add/delete on chunk lifecycle. */
  scatter?: Set<ScatterObject>;

  /** Resolved physics blueprint for this body — state + features as
   *  computed by `resolveSystem`. Set at construction time so the
   *  object-readout / UI can present authoritative property values
   *  (mass, temperature, atmosphere, life, etc.) without re-running the
   *  evolution pipeline. Stars left this undefined for the system root
   *  (`buildLuminousBody` does set it). */
  resolvedPhysics?: ResolvedBody;

  /** Idempotent heavy-construction trigger. Bodies are built in two
   *  stages: an eager stage at createCelestialBody time (body record,
   *  empty group, samplers, star light) and a deferred stage triggered
   *  the first time the body's apparent size approaches one pixel
   *  (sphere meshes, ocean, scatter resources, terrain root chunks).
   *  Sub-pixel bodies are represented by the halo / registry projection
   *  alone and never need their geometry built. Cleared to undefined
   *  after the first call so subsequent updateHalos triggers no-op. */
  materialize?: () => void;
}

// ── Orbital position ────────────────────────────────────────────────────────

const _orbitTmp = new THREE.Vector3();

/**
 * Compute the world-space position of a body whose orbit is defined by
 * `orbit` at the given simulation time. Assumes circular orbits in a plane
 * tilted by `inclination` around the parent's local X-axis.
 *
 * The parent's `worldPosition` must already be up-to-date for this frame
 * (so we update bodies in parent → child order).
 */
export function computeOrbitalPosition(
  orbit: BodyOrbit,
  time: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const angle = orbit.phase + (time / orbit.period) * Math.PI * 2;
  const r = orbit.semiMajorAxis;
  const x = Math.cos(angle) * r;
  const z = Math.sin(angle) * r;
  // Tilt the orbit plane around the parent's local X-axis by inclination.
  const cosI = Math.cos(orbit.inclination);
  const sinI = Math.sin(orbit.inclination);
  out.set(x, sinI * z, cosI * z);
  out.add(orbit.parent.worldPosition);
  return out;
}

// ── Frame-by-frame transform update ─────────────────────────────────────────

const _rotationDelta = new THREE.Quaternion();

/**
 * Advance a body's transform for the current frame:
 *   1. Cache previous worldPosition (used by player to apply translation delta).
 *   2. Compute new worldPosition from orbit (if any).
 *   3. Advance orientation by axial rotation × dt.
 *   4. Refresh cached inverseOrientation.
 *   5. Apply both to `body.group`.
 */
export function advanceBodyTransform(body: CelestialBody, time: number, dt: number): void {
  body.prevWorldPosition.copy(body.worldPosition);

  if (body.orbit) {
    computeOrbitalPosition(body.orbit, time, body.worldPosition);
  }

  // Linear velocity from the position delta. Zero on the initialization
  // call (dt=0); otherwise reflects orbital motion this frame.
  if (dt > 0) {
    body.velocity.copy(body.worldPosition).sub(body.prevWorldPosition).divideScalar(dt);
  } else {
    body.velocity.set(0, 0, 0);
  }

  if (body.rotation.rate !== 0 && dt > 0) {
    _rotationDelta.setFromAxisAngle(body.rotation.axis, body.rotation.rate * dt);
    body.orientation.multiply(_rotationDelta);
  }
  body.inverseOrientation.copy(body.orientation).invert();

  body.group.position.copy(body.worldPosition);
  body.group.quaternion.copy(body.orientation);
}

// ── Hill sphere ─────────────────────────────────────────────────────────────

/**
 * Compute Hill sphere radius for a body given its orbit. For non-orbiting
 * bodies (like the system root star) returns Infinity — they have no
 * parent so their "neighborhood" extends arbitrarily.
 */
export function computeHillRadius(orbit: BodyOrbit | null, gm: number): number {
  if (!orbit) return Infinity;
  const ratio = gm / (3 * orbit.parent.gm);
  return orbit.semiMajorAxis * Math.pow(ratio, 1 / 3);
}

/**
 * Compute the angular-size dominance radius — the distance from the body
 * (along the body↔parent line) at which body and parent subtend equal
 * angles in the sky. Derived from r_body / d_body = r_parent / d_parent
 * with d_body + d_parent = a:
 *
 *   d_body = a × r_body / (r_body + r_parent)
 *
 * For the system root (no parent), there's no comparator — returns
 * Infinity, but stars typically override this with a finite "system
 * boundary" so the player can reach interstellar drift.
 */
export function computeVisualHillRadius(
  orbit: BodyOrbit | null,
  radius: number,
): number {
  if (!orbit) return Infinity;
  return (orbit.semiMajorAxis * radius) / (radius + orbit.parent.radius);
}

// ── Atmosphere density + wind ───────────────────────────────────────────────

/**
 * Atmospheric density at a world position relative to one body. Returns
 * `exp(-altitude / scaleHeight)`, clamped to 1 below the surface. Drops to
 * effectively zero by ~5 scale heights up.
 */
export function atmosphericDensityForBody(body: CelestialBody, worldPos: THREE.Vector3): number {
  const dist = worldPos.distanceTo(body.worldPosition);
  const altitude = dist - body.radius;
  if (altitude <= 0) return 1;
  return Math.exp(-altitude / body.atmosphereScaleHeight);
}

const _windOffset = new THREE.Vector3();
const _angularVel = new THREE.Vector3();
const _angularPart = new THREE.Vector3();

/**
 * Local "wind" velocity at a world position in a body's atmosphere — the
 * velocity of a co-rotating, co-orbiting parcel of air at that point.
 *
 * = body's linear velocity (orbital motion of the whole body)
 * + body's angular velocity × (worldPos − body center)
 *
 * At the body's surface this matches the surface velocity. At higher
 * altitude the angular contribution grows (radius is larger), but in
 * practice the player rarely flies far enough above to notice.
 */
export function windAt(body: CelestialBody, worldPos: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.copy(body.velocity);
  _angularVel.copy(body.rotation.axis).multiplyScalar(body.rotation.rate);
  _windOffset.copy(worldPos).sub(body.worldPosition);
  _angularPart.crossVectors(_angularVel, _windOffset);
  out.add(_angularPart);
  return out;
}
