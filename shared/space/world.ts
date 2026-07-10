// shared/space/world.ts
//
// The STREAMING WORLD — seagull's world.ts ported: a galaxy the player flies
// through star to star. It holds the persistent star registry (galaxy.ts), the
// currently-active solar system, and does the two things that make real-scale
// interstellar flight work:
//
//   • FLOATING ORIGIN — every frame the player is collapsed back to the scene
//     origin and all bodies are rebased relative to it, so Float32 stays
//     precise no matter how far the player has flown (galactic coords live in
//     `sceneAnchorGalactic`, accumulated in light-years).
//   • SYSTEM STREAMING — as the player nears a star it materializes that star's
//     whole system (a rebase puts the star at the scene origin); as they leave,
//     the system tears down and the frame goes GALACTIC (just the star field).
//
// Per-body materialization (mesh + the DEFERRED geography bake) is still gated
// by apparent pixel size in `updateHalos` — the load-radius story.

import * as THREE from "three";
import {
  GALAXY, generateUniverse, findNearestStar, densityAt,
  type Universe, type StarRecord, type GalaxyParams,
} from "./galaxy.js";
import { generateSolarSystem, pickHomePlanet, type SolarSystem } from "./solar-system.js";
import { advanceBodyTransform, atmosphericDensityForBody, type CelestialBody } from "./body.js";
import type { PlayerWorld, GravityContext, AtmosphericReading } from "./world-types.js";

const RHO_REF = 1.225;
const MATERIALIZE_TRIGGER_PX = 0.5; // seagull's per-body mesh/geology gate

export type FrameMode = "STAR" | "GALACTIC";

export interface StreamingWorld extends PlayerWorld {
  /** The scene subtree holding the active system's body groups. */
  readonly sceneGroup: THREE.Group;
  readonly bodies: CelestialBody[];
  readonly homePlanet: CelestialBody | null;
  readonly frameMode: FrameMode;
  readonly activeStar: StarRecord | null;
  /** The galactic position (light-years) of the scene origin. */
  readonly sceneAnchorGalactic: THREE.Vector3;
  readonly universe: Universe;
  /** Advance every body's orbit/spin for the frame (before player.update). */
  advanceBodies(simTime: number, dt: number): void;
  /** Resolve system transitions for the player's position, then apply the
   *  floating-origin rebase. MUTATES `playerPos` (→ scene origin). */
  checkActiveSystem(playerPos: THREE.Vector3): void;
  /** Materialize bodies (mesh + deferred geology) whose apparent size crosses
   *  the pixel gate, and run their terrain LOD. */
  updateHalos(cameraPos: THREE.Vector3, screenHeightPx: number, fovRad: number): void;
}

export function createWorld(seed: number, params: GalaxyParams, faceN = 12): StreamingWorld {
  const universe = generateUniverse(seed, params);
  const sceneGroup = new THREE.Group();
  sceneGroup.name = "universe";
  const sceneAnchor = universe.homeStar.galacticPosition.clone();
  const lyM = GALAXY.lyToSceneMeters;

  let frameMode: FrameMode = "GALACTIC";
  let activeStar: StarRecord | null = null;
  let activeSystem: SolarSystem | null = null;
  let bodies: CelestialBody[] = [];
  let homePlanet: CelestialBody | null = null;

  const _gal = new THREE.Vector3();
  const galacticOf = (worldPos: THREE.Vector3): THREE.Vector3 =>
    _gal.copy(worldPos).divideScalar(lyM).add(sceneAnchor);

  function tearDown(): void {
    for (const b of bodies) sceneGroup.remove(b.group);
    activeSystem = null; activeStar = null; bodies = []; homePlanet = null;
  }

  function materializeAt(star: StarRecord, forceHome = false): void {
    activeSystem = generateSolarSystem({
      star, galaxyParams: params, centerPosition: new THREE.Vector3(0, 0, 0), faceN,
    });
    bodies = activeSystem.bodies;
    homePlanet = pickHomePlanet(activeSystem);
    for (const b of bodies) sceneGroup.add(b.group);
    activeStar = star;
    frameMode = "STAR";
    activeSystem.star.materialize?.(); // the primary is visible immediately
    // Only the SPAWN system's home world bakes eagerly (the player materializes
    // on it at once); every other body — here and in systems entered later —
    // defers its geology to the pixel-gated approach (updateHalos).
    if (forceHome) homePlanet?.materialize?.();
  }

  const _deltaScene = new THREE.Vector3();
  function applyRebase(newAnchor: THREE.Vector3, playerPos: THREE.Vector3): void {
    _deltaScene.copy(newAnchor).sub(sceneAnchor).multiplyScalar(lyM);
    sceneAnchor.copy(newAnchor);
    playerPos.sub(_deltaScene);
  }

  function transitionToStar(star: StarRecord, playerPos: THREE.Vector3): void {
    applyRebase(star.galacticPosition, playerPos);
    tearDown();
    materializeAt(star);
  }
  function transitionToGalactic(): void {
    tearDown();
    frameMode = "GALACTIC";
  }

  function applyFloatingOrigin(playerPos: THREE.Vector3): void {
    if (playerPos.lengthSq() < 1e-4) return;
    sceneAnchor.addScaledVector(playerPos, 1 / lyM);
    for (const b of bodies) {
      b.worldPosition.sub(playerPos);
      b.prevWorldPosition.sub(playerPos);
      b.group.position.copy(b.worldPosition);
    }
    playerPos.set(0, 0, 0);
  }

  // Boot: materialize the home system so the player spawns in it (home world
  // eager for the spawn samplers).
  materializeAt(universe.homeStar, true);

  // ── PlayerWorld query helpers (over the active system) ─────────────────────
  const _up = new THREE.Vector3();
  const _acc = new THREE.Vector3();

  function dominantBodyAt(worldPos: THREE.Vector3) {
    let best: CelestialBody | null = null;
    let bestHill = Infinity;
    for (const b of bodies) {
      const dist = worldPos.distanceTo(b.worldPosition);
      if (dist < b.hillRadius && b.hillRadius < bestHill) { best = b; bestHill = b.hillRadius; }
    }
    if (best) {
      const alt = best.altitudeAt(worldPos);
      return { body: best, altitude: alt, hillFraction: alt / Math.max(1, best.hillRadius - best.radius) };
    }
    let near: CelestialBody | null = null;
    let nearD = Infinity;
    for (const b of bodies) {
      const d = worldPos.distanceTo(b.worldPosition);
      if (d < nearD) { nearD = d; near = b; }
    }
    return { body: near, altitude: near ? near.altitudeAt(worldPos) : Infinity, hillFraction: 2 };
  }

  return {
    sceneGroup,
    get bodies() { return bodies; },
    get homePlanet() { return homePlanet; },
    get frameMode() { return frameMode; },
    get activeStar() { return activeStar; },
    sceneAnchorGalactic: sceneAnchor,
    universe,

    advanceBodies(simTime, dt) {
      for (const b of bodies) advanceBodyTransform(b, simTime, dt);
    },

    checkActiveSystem(playerPos) {
      const galactic = galacticOf(playerPos).clone();
      const nearest = findNearestStar(universe, galactic, GALAXY.materializeLy * 1.5);
      if (activeStar) {
        const dist = activeStar.galacticPosition.distanceTo(galactic);
        if (dist > GALAXY.dematerializeLy) {
          if (nearest && nearest.star.id !== activeStar.id && nearest.distanceLy < GALAXY.materializeLy) {
            transitionToStar(nearest.star, playerPos);
          } else {
            transitionToGalactic();
          }
        }
      } else if (nearest && nearest.distanceLy < GALAXY.materializeLy) {
        transitionToStar(nearest.star, playerPos);
      }
      applyFloatingOrigin(playerPos);
    },

    updateHalos(cameraPos, screenHeightPx, fovRad) {
      const pxPerRad = screenHeightPx / fovRad;
      for (const b of bodies) {
        const dist = b.worldPosition.distanceTo(cameraPos);
        const px = 2 * Math.atan(b.radius / Math.max(dist, b.radius)) * pxPerRad;
        if (px > MATERIALIZE_TRIGGER_PX && b.materialize) b.materialize();
        b.update(cameraPos, 0);
      }
    },

    // ── PlayerWorld ──────────────────────────────────────────────────────────
    gravityAt(worldPos, out) {
      const g: GravityContext = out ?? { dominant: null, influence: 0, up: new THREE.Vector3(0, 1, 0), altitude: Infinity };
      const dom = dominantBodyAt(worldPos);
      g.dominant = dom.body;
      if (dom.body) {
        dom.body.upAt(worldPos, _up); g.up.copy(_up);
        g.altitude = dom.altitude;
        g.influence = Math.max(0, Math.min(1, 1 - dom.altitude / Math.max(1, dom.body.hillRadius - dom.body.radius)));
      } else { g.up.set(0, 1, 0); g.altitude = Infinity; g.influence = 0; }
      return g;
    },
    gravityAccelerationAt(worldPos, out) {
      out.set(0, 0, 0);
      for (const b of bodies) {
        _acc.copy(b.worldPosition).sub(worldPos);
        const r = Math.max(b.radius, _acc.length());
        if (r < 1) continue;
        out.addScaledVector(_acc.normalize(), b.gm / (r * r));
      }
      return out;
    },
    atmosphericDensityAt(worldPos, out) {
      const g: AtmosphericReading = out ?? { density: 0, body: null };
      let maxD = 0; let maxB: CelestialBody | null = null;
      for (const b of bodies) { const d = atmosphericDensityForBody(b, worldPos); if (d > maxD) { maxD = d; maxB = b; } }
      g.density = maxD; g.body = maxD > 0.001 ? maxB : null;
      return g;
    },
    atmosphericAlphaAt(worldPos) {
      let sum = 0;
      for (const b of bodies) sum += b.surfaceAirDensity * atmosphericDensityForBody(b, worldPos);
      return sum / RHO_REF;
    },
    nearestBodyAltitudeAt(worldPos) {
      let near: CelestialBody | null = null; let nearAlt = Infinity;
      for (const b of bodies) { const alt = b.altitudeAt(worldPos); if (alt < nearAlt) { nearAlt = alt; near = b; } }
      // Interstellar fallback: the distance to the nearest REGISTRY star (so the
      // altitude-target speed keeps growing between systems).
      const reg = findNearestStar(universe, galacticOf(worldPos), 100);
      const regAlt = reg ? reg.distanceLy * lyM : Infinity;
      if (near && nearAlt < regAlt) return { body: near, altitude: nearAlt };
      return { body: null, altitude: regAlt };
    },
    dominantBodyAt,
    galacticDensityAt(worldPos) {
      const g = galacticOf(worldPos);
      return densityAt(params, g.x, g.y, g.z);
    },
  };
}
