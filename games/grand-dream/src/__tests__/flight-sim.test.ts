/**
 * The ported seagull flight physics (shared/space/flight-sim), driven against a
 * minimal mock world (one spherical planet with an atmosphere). Verifies the
 * behaviors that define the model: spawn, flight, the mouse-wheel throttle
 * (the addition), and the WARP-INHIBITION gate — hyperdrive is suppressed in
 * atmosphere / near a body and opens up in vacuum.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { createPlayer, type Input } from "@shared/space/flight-sim";
import type {
  CelestialBody, GravityContext, AtmosphericReading, PlayerWorld,
} from "@shared/space/world-types";

const R_EARTH = 6.371e6;
const GM_EARTH = 3.986e14;
const H_ATM = 8500; // atmospheric scale height (m)
const HILL = 1.5e9; // Earth hill radius (m)

function mockWorld(): { world: PlayerWorld; planet: CelestialBody } {
  const center = new THREE.Vector3(0, 0, 0);
  const _up = new THREE.Vector3();
  const alt = (p: THREE.Vector3) => p.distanceTo(center) - R_EARTH;
  const V = () => new THREE.Vector3();
  const planet: CelestialBody = {
    id: "earth", type: "rocky", radius: R_EARTH, influenceFalloff: HILL, gm: GM_EARTH,
    atmosphereScaleHeight: H_ATM, surfaceAirDensity: 1.225, walkable: true,
    hasOcean: false, seaLevel: 0, hillRadius: HILL, visualHillRadius: HILL,
    warpDensity: 1, bulkDensity: 5500, orbit: null, group: new THREE.Group(),
    rotation: { axis: new THREE.Vector3(0, 1, 0), rate: 0 },
    worldPosition: center.clone(), prevWorldPosition: center.clone(),
    orientation: new THREE.Quaternion(), inverseOrientation: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    upAt: (p, out = V()) => out.copy(p).sub(center).normalize(),
    altitudeAt: alt,
    surfaceAt: (p, out = V()) => out.copy(p).sub(center).normalize().multiplyScalar(R_EARTH).add(center),
    groundNormalAt: (p, _e, out = V()) => out.copy(p).sub(center).normalize(),
    heightAt: () => 0,
    update: () => {},
  };
  const density = (p: THREE.Vector3) => { const a = alt(p); return a <= 0 ? 1 : Math.exp(-a / H_ATM); };
  const world: PlayerWorld = {
    bodies: [planet],
    homePlanet: planet,
    gravityAt: (p, out) => {
      const g: GravityContext = out ?? { dominant: null, influence: 0, up: new THREE.Vector3(0, 1, 0), altitude: Infinity };
      const a = alt(p);
      g.dominant = a < HILL - R_EARTH ? planet : null;
      g.influence = Math.max(0, Math.min(1, 1 - a / (HILL - R_EARTH)));
      _up.copy(p).sub(center).normalize();
      g.up.copy(_up);
      g.altitude = a;
      return g;
    },
    gravityAccelerationAt: (p, out) => {
      const r = Math.max(1, p.distanceTo(center));
      return out.copy(center).sub(p).normalize().multiplyScalar(GM_EARTH / (r * r));
    },
    atmosphericDensityAt: (p, out) => {
      const g: AtmosphericReading = out ?? { density: 0, body: null };
      g.density = density(p);
      g.body = g.density > 0.001 ? planet : null;
      return g;
    },
    atmosphericAlphaAt: (p) => (1.225 * density(p)) / 1.225,
    nearestBodyAltitudeAt: (p) => ({ body: planet, altitude: alt(p) }),
    dominantBodyAt: (p) => ({ body: planet, altitude: alt(p), hillFraction: alt(p) / (HILL - R_EARTH) }),
    galacticDensityAt: () => 0.04,
  };
  return { world, planet };
}

const centeredGaze = (over: Partial<Input> = {}): Input => ({ mouseX: 0.5, mouseY: 0.5, ...over });

describe("flight-sim — the ported seagull physics against a mock world", () => {
  it("spawns airborne over the home planet", () => {
    const { world } = mockWorld();
    const p = createPlayer(world);
    expect(p.state.mode).toBe("flying");
    const alt = p.state.position.length() - R_EARTH;
    expect(alt).toBeGreaterThan(1000); // ~1500 m spawn altitude
    expect(alt).toBeLessThan(3000);
    expect(p.state.wheelFactor).toBe(1);
  });

  it("flies — position advances and wing speed holds", () => {
    const { world } = mockWorld();
    const p = createPlayer(world);
    const p0 = p.state.position.clone();
    for (let i = 0; i < 60; i++) p.update(centeredGaze(), 0.05);
    expect(p.state.position.distanceTo(p0)).toBeGreaterThan(100); // moved
    expect(p.state.wingSpeed).toBeGreaterThan(0);
  });

  it("the mouse wheel is an exponential throttle, clamped", () => {
    const { world } = mockWorld();
    const p = createPlayer(world);
    p.update(centeredGaze({ wheel: 4 }), 0.05);
    expect(p.state.wheelFactor).toBeCloseTo(Math.exp(0.15 * 4), 3);
    const up = p.state.wheelFactor;
    p.update(centeredGaze({ wheel: -4 }), 0.05);
    expect(p.state.wheelFactor).toBeCloseTo(up * Math.exp(-0.15 * 4), 3);
    for (let i = 0; i < 400; i++) p.update(centeredGaze({ wheel: 10 }), 0.05);
    expect(p.state.wheelFactor).toBeLessThanOrEqual(1e6 + 1);
  });

  it("WARP INHIBITION: the hyperdrive gate is shut in atmosphere, open in vacuum", () => {
    const { world } = mockWorld();
    const p = createPlayer(world);

    // Deep in a body's atmosphere (low altitude): warp gate ≈ 0.
    p.state.position.set(0, R_EARTH + 500, 0);            // ~500 m up, α high
    p.state.forward.set(1, 0, 0); p.state.bodyRight.set(0, 0, -1);
    p.update(centeredGaze(), 0.05);
    const gateLow = p.state.flightDebug.warpGate;

    // Far out in vacuum, well outside the atmosphere and hill's grip.
    p.state.position.set(0, R_EARTH + 5e8, 0);            // 500 Mm up, α≈0
    p.state.forward.set(1, 0, 0); p.state.bodyRight.set(0, 0, -1);
    p.update(centeredGaze(), 0.05);
    const gateHigh = p.state.flightDebug.warpGate;

    expect(gateLow).toBeLessThan(0.05);   // suppressed near the surface
    expect(gateHigh).toBeGreaterThan(0.5); // open in deep space
  });

  it("hyperdrive builds only in vacuum with a centered gaze", () => {
    const { world } = mockWorld();
    const p = createPlayer(world);
    // In atmosphere: centered gaze must NOT spin up hyperMult (gate shut).
    p.state.position.set(0, R_EARTH + 300, 0);
    p.state.forward.set(1, 0, 0); p.state.bodyRight.set(0, 0, -1);
    for (let i = 0; i < 30; i++) p.update(centeredGaze(), 0.05);
    expect(p.state.hyperMult).toBeCloseTo(1, 1);

    // In vacuum: centered gaze grows hyperMult.
    p.state.position.set(0, R_EARTH + 5e8, 0);
    p.state.forward.set(1, 0, 0); p.state.bodyRight.set(0, 0, -1);
    for (let i = 0; i < 60; i++) p.update(centeredGaze(), 0.05);
    expect(p.state.hyperMult).toBeGreaterThan(1.2);
  });
});
