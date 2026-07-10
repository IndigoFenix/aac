// shared/space/solar-system.ts
//
// Generate a whole solar system as physics CelestialBodies from a star, and
// expose it as a `PlayerWorld` the flight sim can fly. Ported from seagull's
// solar-system.ts (orbit/Kepler/phase wiring) over the ported physics
// generator (materializeSystem/resolveSystem/buildHomeBlueprint) and the
// physics body factory (celestial-body.ts). No scene — the meshes come in
// Stage 4c; Stage 4d's world.ts adds the galaxy streaming + floating origin
// around this.

import * as THREE from "three";
import type { StarRecord, GalaxyParams } from "./galaxy.js";
import { GALAXY } from "./galaxy.js";
import {
  materializeSystem, resolveSystem, buildHomeBlueprint, type ResolvedBody,
} from "./physics/index.js";
import type { CelestialBody, BodyOrbit } from "./body.js";
import { advanceBodyTransform, atmosphericDensityForBody } from "./body.js";
import { createCelestialBody } from "./celestial-body.js";
import type { PlayerWorld, GravityContext, AtmosphericReading } from "./world-types.js";

const AU_M = 1.495978707e11;
const RHO_REF_AIR = 1.225;

export interface SolarSystem {
  /** The system primary (the luminous root). */
  star: CelestialBody;
  /** Every body, parents strictly before children. */
  bodies: CelestialBody[];
}

export interface GenerateSystemOpts {
  star: StarRecord;
  galaxyParams: GalaxyParams;
  /** World position the primary spawns at (floating-origin frame). */
  centerPosition: THREE.Vector3;
  /** Cube-sphere face resolution for rocky geography (orbital = 24). */
  faceN?: number;
}

/** Deterministic 0..2π phase from a body id (siblings don't stack at angle 0). */
function phaseFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h = (h ^ id.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ((h >>> 0) % 6283) / 1000;
}

/** Every body after its parent. */
function topoSortByParent(resolved: ResolvedBody[]): ResolvedBody[] {
  const byId = new Map(resolved.map((rb) => [rb.body.id, rb]));
  const sorted: ResolvedBody[] = [];
  const seen = new Set<string>();
  const visit = (rb: ResolvedBody): void => {
    if (seen.has(rb.body.id)) return;
    if (rb.body.parentId !== null) {
      const parent = byId.get(rb.body.parentId);
      if (parent) visit(parent);
    }
    seen.add(rb.body.id);
    sorted.push(rb);
  };
  for (const rb of resolved) visit(rb);
  return sorted;
}

/** Build the full system as physics bodies (Sol → the pinned home blueprint). */
export function generateSolarSystem(opts: GenerateSystemOpts): SolarSystem {
  const { star, galaxyParams, centerPosition } = opts;
  const isHome = star.systemSeed === GALAXY.homeSystemSeed;
  const blueprint = isHome ? buildHomeBlueprint(star, galaxyParams) : materializeSystem(star, galaxyParams);
  const resolved = resolveSystem(blueprint, galaxyParams.galaxyAgeGyr);
  const ordered = topoSortByParent(resolved);

  const built = new Map<string, CelestialBody>();
  const bodies: CelestialBody[] = [];
  let primary: CelestialBody | null = null;

  for (const rb of ordered) {
    const pb = rb.body;
    const parentCB = pb.parentId !== null ? built.get(pb.parentId) ?? null : null;
    let initialPosition: THREE.Vector3;
    let orbit: BodyOrbit | null = null;
    if (parentCB) {
      const aMeters = pb.formationSemiMajor * AU_M;
      initialPosition = parentCB.worldPosition.clone().add(new THREE.Vector3(aMeters, 0, 0));
      const period = 2 * Math.PI * Math.sqrt(aMeters ** 3 / Math.max(1, parentCB.gm));
      orbit = { parent: parentCB, semiMajorAxis: aMeters, period, phase: phaseFromId(pb.id), inclination: pb.formationInclination };
    } else {
      initialPosition = centerPosition.clone();
    }
    const { body } = createCelestialBody({ resolved: rb, systemSeed: star.systemSeed, initialPosition, orbit, faceN: opts.faceN });
    built.set(pb.id, body);
    bodies.push(body);
    if (!primary && pb.parentId === null) primary = body;
  }
  if (!primary) throw new Error(`generateSolarSystem: ${star.id} produced no root body`);
  // Seed transforms (dt=0) so worldPositions sit on their orbits from frame 0.
  for (const b of bodies) advanceBodyTransform(b, 0, 0);
  return { star: primary, bodies };
}

/** The spawn/home world of a system: the most habitable rocky body, else the
 *  first rocky, else null. */
export function pickHomePlanet(system: SolarSystem): CelestialBody | null {
  const hab = (b: CelestialBody) => b.resolvedPhysics?.features.life.habitability ?? 0;
  const rocky = system.bodies.filter((b) => b.walkable);
  return rocky.length ? rocky.reduce((best, b) => (hab(b) > hab(best) ? b : best)) : null;
}

// ── The system as a PlayerWorld ──────────────────────────────────────────────

const _tmpUp = new THREE.Vector3();
const _accTmp = new THREE.Vector3();

export interface SystemWorld extends PlayerWorld {
  /** The materialized system. */
  readonly system: SolarSystem;
  /** Advance all body transforms one frame (parent-before-child). */
  advance(simTime: number, dt: number): void;
}

/**
 * A single materialized system exposed as the flight sim's world. This is the
 * STAR-mode world before the galaxy streaming + floating origin (Stage 4d)
 * wrap it — enough to fly a real Sol with real gravity, air, and terrain.
 */
export function createSystemWorld(system: SolarSystem, galaxyParams: GalaxyParams): SystemWorld {
  const bodies = system.bodies;
  const homePlanet = pickHomePlanet(system);
  // The home world's geography is baked NOW (its samplers are needed the moment
  // the player spawns on it); every other body defers to approach.
  homePlanet?.materialize?.();

  const dominantBodyAt = (worldPos: THREE.Vector3) => {
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
    // Fallback: nearest body, hill gate fully open (fraction > 1).
    let near: CelestialBody | null = null;
    let nearD = Infinity;
    for (const b of bodies) {
      const d = worldPos.distanceTo(b.worldPosition);
      if (d < nearD) { nearD = d; near = b; }
    }
    return { body: near, altitude: near ? near.altitudeAt(worldPos) : Infinity, hillFraction: 2 };
  };

  return {
    system,
    bodies,
    homePlanet,
    advance(simTime, dt) {
      for (const b of bodies) advanceBodyTransform(b, simTime, dt);
    },
    gravityAt(worldPos, out) {
      const g: GravityContext = out ?? { dominant: null, influence: 0, up: new THREE.Vector3(0, 1, 0), altitude: Infinity };
      const dom = dominantBodyAt(worldPos);
      g.dominant = dom.body;
      if (dom.body) {
        dom.body.upAt(worldPos, _tmpUp);
        g.up.copy(_tmpUp);
        g.altitude = dom.altitude;
        g.influence = Math.max(0, Math.min(1, 1 - (dom.altitude) / Math.max(1, dom.body.hillRadius - dom.body.radius)));
      } else {
        g.up.set(0, 1, 0); g.altitude = Infinity; g.influence = 0;
      }
      return g;
    },
    gravityAccelerationAt(worldPos, out) {
      out.set(0, 0, 0);
      for (const b of bodies) {
        _accTmp.copy(b.worldPosition).sub(worldPos);
        const r = Math.max(b.radius, _accTmp.length());
        if (r < 1) continue;
        out.addScaledVector(_accTmp.normalize(), b.gm / (r * r));
      }
      return out;
    },
    atmosphericDensityAt(worldPos, out) {
      const g: AtmosphericReading = out ?? { density: 0, body: null };
      let maxD = 0;
      let maxB: CelestialBody | null = null;
      for (const b of bodies) {
        const d = atmosphericDensityForBody(b, worldPos);
        if (d > maxD) { maxD = d; maxB = b; }
      }
      g.density = maxD;
      g.body = maxD > 0.001 ? maxB : null;
      return g;
    },
    atmosphericAlphaAt(worldPos) {
      let sum = 0;
      for (const b of bodies) sum += b.surfaceAirDensity * atmosphericDensityForBody(b, worldPos);
      return sum / RHO_REF_AIR;
    },
    nearestBodyAltitudeAt(worldPos) {
      let near: CelestialBody | null = null;
      let nearAlt = Infinity;
      for (const b of bodies) {
        const alt = b.altitudeAt(worldPos);
        if (alt < nearAlt) { nearAlt = alt; near = b; }
      }
      return { body: near, altitude: near ? nearAlt : Infinity };
    },
    dominantBodyAt,
    galacticDensityAt() {
      // Single-system world: a fixed local disc density (the galaxy streaming
      // world computes this from the real position). Keeps the hyperdrive cap
      // sane without a galaxy.
      return galaxyParams.discDensity;
    },
  };
}
