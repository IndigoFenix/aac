// shared/space/world-types.ts
//
// The SEAM between the flight physics (player.ts) and the world it flies in.
// The physics queries the world through `PlayerWorld` and reads bodies through
// `CelestialBody`; Stage 4's real streaming world implements these, and tests
// implement a tiny mock. Faithful to seagull-dream's world.ts / body.ts
// interfaces so the port is behavior-identical.

import type * as THREE from "three";
import type { CelestialBody } from "./body.js";

// The full celestial body lives in body.ts (the transform + sampler layer);
// re-export it as the physics-facing type so consumers import from one place.
export type { CelestialBody, BodyType, BodyOrbit, BodyRotation, ScatterObject } from "./body.js";

/** Strongest-influence body + geometry at a world position. */
export interface GravityContext {
  dominant: CelestialBody | null;
  influence: number;
  up: THREE.Vector3;
  altitude: number;
}

/** Max atmospheric density (0..1, 1 at any surface) + its body. */
export interface AtmosphericReading {
  density: number;
  body: CelestialBody | null;
}

/**
 * The subset of the world the flight physics queries each frame. Stage 4's
 * streaming World is a superset; a test can implement just this.
 */
export interface PlayerWorld {
  /** Bodies in the active system (empty in interstellar mode). */
  readonly bodies: CelestialBody[];
  /** First rocky body — the player's spawn target. */
  readonly homePlanet: CelestialBody | null;
  gravityAt(worldPos: THREE.Vector3, out?: GravityContext): GravityContext;
  gravityAccelerationAt(worldPos: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  atmosphericDensityAt(worldPos: THREE.Vector3, out?: AtmosphericReading): AtmosphericReading;
  /** Summed atmospheric density normalized to 1.225 kg/m³ (the α weight). */
  atmosphericAlphaAt(worldPos: THREE.Vector3): number;
  /** Nearest body surface distance (interstellar fallback: nearest star). */
  nearestBodyAltitudeAt(worldPos: THREE.Vector3): { body: CelestialBody | null; altitude: number };
  /** Smallest hill-sphere body containing the player (the warp-gate body). */
  dominantBodyAt(worldPos: THREE.Vector3): { body: CelestialBody | null; altitude: number; hillFraction: number };
  /** Star density (stars/ly³) at the player's galactic position. */
  galacticDensityAt(worldPos: THREE.Vector3): number;
}
