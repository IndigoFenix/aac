/**
 * Stage 4b end-to-end: the ported physics generator + body factory build a real
 * Sol as CelestialBodies (gravity, atmosphere, geography-seam terrain), exposed
 * as a PlayerWorld, and the ported flight sim (Stage 3) flies it. This is the
 * first time all three ported layers run together against a real universe.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { DEFAULT_GALAXY_PARAMS, type StarRecord } from "@shared/space/galaxy";
import { generateSolarSystem, createSystemWorld } from "@shared/space/solar-system";
import { createPlayer } from "@shared/space/flight-sim";

const SUN: StarRecord = {
  id: "home_star", systemSeed: 1337, feh: 0, massInit: 1, age: 4.6, radius: 1, intrinsic: 1,
  galacticPosition: new THREE.Vector3(0, 0, 0), color: new THREE.Color(1, 1, 1),
};
const R_EARTH_M = 6.371e6;

function sol() {
  return generateSolarSystem({
    star: SUN, galaxyParams: DEFAULT_GALAXY_PARAMS,
    centerPosition: new THREE.Vector3(0, 0, 0), faceN: 12, // small for test speed
  });
}

describe("Stage 4b — a real Sol as physics bodies + a flyable world", () => {
  it("generates a luminous star and rocky planets with real gravity + terrain", { timeout: 120000 }, () => {
    const system = sol();
    expect(system.star.type).toBe("star");
    expect(system.bodies.length).toBeGreaterThan(4);

    const earth = system.bodies.find((b) => b.id === "Ap2")!;
    expect(earth.type).toBe("rocky");
    expect(earth.walkable).toBe(true);
    // Real Earth-scale physics.
    expect(earth.radius).toBeGreaterThan(5e6);
    expect(earth.radius).toBeLessThan(8e6);
    expect(earth.gm).toBeGreaterThan(2e14); // GM_earth ≈ 3.986e14
    expect(earth.gm).toBeLessThan(6e14);
    expect(earth.surfaceAirDensity).toBeGreaterThan(0.3); // has real air
    // Geography is DEFERRED — no terrain samplers until the planet materializes.
    expect(earth.heightAt).toBeUndefined();
    earth.materialize!();
    // Terrain from the geography seam: heightAt varies across the sphere.
    const h1 = earth.heightAt!(new THREE.Vector3(1, 0, 0));
    const h2 = earth.heightAt!(new THREE.Vector3(0, 1, 0));
    const h3 = earth.heightAt!(new THREE.Vector3(0, 0, 1));
    expect(new Set([h1, h2, h3].map((h) => Math.round(h))).size).toBeGreaterThan(1);
  });

  it("planets sit on their orbits at real AU distances from the star", { timeout: 120000 }, () => {
    const system = sol();
    const star = system.star;
    const earth = system.bodies.find((b) => b.id === "Ap2")!;
    const d = earth.worldPosition.distanceTo(star.worldPosition);
    // Earth ≈ 1 AU = 1.496e11 m (within a few × for the home blueprint's a).
    expect(d).toBeGreaterThan(3e10);
    expect(d).toBeLessThan(1e12);
  });

  it("the flight sim spawns on the home planet and flies", { timeout: 120000 }, () => {
    const system = sol();
    const world = createSystemWorld(system, DEFAULT_GALAXY_PARAMS);
    expect(world.homePlanet).not.toBeNull();
    const player = createPlayer(world);
    expect(player.state.mode).toBe("flying");
    // Spawned just above the home planet's surface.
    const alt0 = world.homePlanet!.altitudeAt(player.state.position);
    expect(alt0).toBeGreaterThan(500);
    expect(alt0).toBeLessThan(4000);

    const p0 = player.state.position.clone();
    let simTime = 0;
    for (let i = 0; i < 120; i++) {
      simTime += 0.05;
      world.advance(simTime, 0.05);
      player.update({ mouseX: 0.5, mouseY: 0.5 }, 0.05);
    }
    expect(player.state.position.distanceTo(p0)).toBeGreaterThan(50); // moved under real gravity/air
  });

  it("materialize builds meshes: rocky terrain, star disc + light, gas sphere", { timeout: 120000 }, () => {
    const system = sol();
    const earth = system.bodies.find((b) => b.id === "Ap2")!;
    const star = system.star;
    const gas = system.bodies.find((b) => b.type === "gas");

    // Rocky: materialize adds the terrain group; a near-camera LOD pass grows chunks.
    expect(earth.group.children.length).toBe(0);
    earth.materialize!();
    expect(earth.materialize).toBeUndefined(); // idempotent (self-cleared)
    expect(earth.group.children.length).toBeGreaterThan(0);
    const camNear = earth.worldPosition.clone().add(new THREE.Vector3(earth.radius * 1.4, 0, 0));
    for (let i = 0; i < 8; i++) earth.update(camNear, 0.016);
    // The terrain quadtree built at least the 6 face roots.
    const terrainGroup = earth.group.children.find((c) => c.name === "planet");
    expect(terrainGroup).toBeDefined();
    expect(terrainGroup!.children.length).toBeGreaterThan(0);
    // Earth has air → the slant-path limb-glow shell (+ pressure-scaled veil).
    expect(earth.group.children.some((c) => c.name === "atmosphere_halo")).toBe(true);
    expect(earth.group.children.some((c) => c.name === "atmosphere_veil")).toBe(true);

    // Star: a bright disc + a light.
    star.materialize!();
    const hasLight = star.group.children.some((c) => (c as THREE.Object3D).type === "PointLight");
    const hasDisc = star.group.children.some((c) => (c as THREE.Mesh).isMesh);
    expect(hasLight).toBe(true);
    expect(hasDisc).toBe(true);

    // Gas giant: a sphere mesh.
    if (gas) {
      gas.materialize!();
      expect(gas.group.children.some((c) => (c as THREE.Mesh).isMesh)).toBe(true);
    }
  });

  it("warp is inhibited near a planet, open in deep space (real world)", { timeout: 120000 }, () => {
    const system = sol();
    const world = createSystemWorld(system, DEFAULT_GALAXY_PARAMS);
    const player = createPlayer(world);
    const home = world.homePlanet!;

    // Low over the home planet: gate shut.
    home.upAt(player.state.position, player.state.forward); // will be re-derived; set a sane frame
    player.state.position.copy(home.worldPosition).addScaledVector(new THREE.Vector3(1, 0, 0), home.radius + 400);
    player.state.forward.set(0, 0, 1); player.state.bodyRight.set(0, 1, 0);
    world.advance(0.1, 0.05);
    player.update({ mouseX: 0.5, mouseY: 0.5 }, 0.05);
    const gateLow = player.state.flightDebug.warpGate;

    // Far from every body (interplanetary void): gate open.
    player.state.position.set(0, 0, -5e13);
    player.state.forward.set(1, 0, 0); player.state.bodyRight.set(0, 1, 0);
    world.advance(0.15, 0.05);
    player.update({ mouseX: 0.5, mouseY: 0.5 }, 0.05);
    const gateHigh = player.state.flightDebug.warpGate;

    expect(gateLow).toBeLessThan(0.2);
    expect(gateHigh).toBeGreaterThan(0.8);
  });
});
