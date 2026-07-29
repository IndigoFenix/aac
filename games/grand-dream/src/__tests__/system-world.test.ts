/**
 * Stage 4b end-to-end: the ported physics generator + body factory build a real
 * Sol as CelestialBodies (gravity, atmosphere, geography-seam terrain), exposed
 * as a PlayerWorld, and the ported flight sim (Stage 3) flies it. This is the
 * first time all three ported layers run together against a real universe.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { DEFAULT_GALAXY_PARAMS, type StarRecord } from "@shared/world-engine/space/galaxy";
import { generateSolarSystem, createSystemWorld } from "@shared/world-engine/space/solar-system";
import { createPlayer } from "@shared/world-engine/space/flight-sim";

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

describe("miniature system — planet compression (space-time-compression.md §5)", () => {
  it("shrinks radii and orbits ÷s, preserves surface gravity, shortens periods ÷√s", { timeout: 120000 }, () => {
    const s = 25;
    const real = sol();
    const mini = generateSolarSystem({
      star: SUN, galaxyParams: DEFAULT_GALAXY_PARAMS,
      centerPosition: new THREE.Vector3(0, 0, 0), faceN: 12, compression: s,
    });
    const re = real.bodies.find((b) => b.id === "Ap2")!;
    const me = mini.bodies.find((b) => b.id === "Ap2")!;
    // A ~250 km Earth — the storybook small planet.
    expect(me.radius / (re.radius / s)).toBeCloseTo(1, 9);
    expect(me.radius).toBeLessThan(3.5e5);
    // Surface gravity EXACTLY preserved (mass ÷ s² against radius ÷ s).
    const g = (b: typeof re) => b.gm / (b.radius * b.radius);
    expect(g(me) / g(re)).toBeCloseTo(1, 9);
    // The whole system shrinks uniformly; Kepler over the scaled gm
    // shortens periods by √s.
    expect(me.orbit!.semiMajorAxis / (re.orbit!.semiMajorAxis / s)).toBeCloseTo(1, 9);
    expect(me.orbit!.period / (re.orbit!.period / Math.sqrt(s))).toBeCloseTo(1, 6);
    // The air at the ground is the real planet's air (density rides gm/r²).
    expect(me.surfaceAirDensity / re.surfaceAirDensity).toBeCloseTo(1, 6);
  });

  // LAW (settlement-emergence.md §4a): compression scales EVERY body, and
  // relative scales come out unchanged — compression is presentation. The
  // distance dials exist so a world can BUY a storybook sky on purpose.
  it("interplanetary distance is its own dial — big moons are bought, not stumbled into", { timeout: 120000 }, () => {
    const base = generateSolarSystem({
      star: SUN, galaxyParams: DEFAULT_GALAXY_PARAMS,
      centerPosition: new THREE.Vector3(0, 0, 0), faceN: 12, compression: 25,
    });
    const near = generateSolarSystem({
      star: SUN, galaxyParams: DEFAULT_GALAXY_PARAMS,
      centerPosition: new THREE.Vector3(0, 0, 0), faceN: 12, compression: 25, interplanetary: 100,
    });
    const b = base.bodies.find((x) => x.id === "Ap2")!;
    const n = near.bodies.find((x) => x.id === "Ap2")!;
    // Same body, four times closer in ⇒ it subtends 4× the angle: the sky
    // grows without the planet shrinking.
    expect(n.radius).toBeCloseTo(b.radius, 6);
    expect(b.orbit!.semiMajorAxis / n.orbit!.semiMajorAxis).toBeCloseTo(4, 9);
    const apparent = (x: typeof b) => x.radius / x.orbit!.semiMajorAxis;
    expect(apparent(n) / apparent(b)).toBeCloseTo(4, 6);
  });

  it("revolution and rotation accelerate the sky, preserving relative ratios", { timeout: 120000 }, () => {
    const real = sol();
    const fast = generateSolarSystem({
      star: SUN, galaxyParams: DEFAULT_GALAXY_PARAMS,
      centerPosition: new THREE.Vector3(0, 0, 0), faceN: 12, revolution: 30, rotation: 360,
    });
    // EVERY orbiting body speeds up by the same factor — the ratio between
    // two planets' years is exactly what it was.
    const pairs = real.bodies.filter((b) => b.orbit).map((b) => [b, fast.bodies.find((f) => f.id === b.id)!] as const);
    expect(pairs.length).toBeGreaterThan(1);
    for (const [r, f] of pairs) {
      expect(f.orbit!.period).toBeCloseTo(r.orbit!.period / 30, 3);
      expect(f.orbit!.semiMajorAxis).toBeCloseTo(r.orbit!.semiMajorAxis, 3); // distance untouched
    }
    const ratio = (sys: typeof real) => {
      const o = sys.bodies.filter((b) => b.orbit);
      return o[0].orbit!.period / o[1].orbit!.period;
    };
    expect(ratio(fast)).toBeCloseTo(ratio(real), 9);
    // Spin likewise — a slow world stays relatively slow.
    const spun = real.bodies.map((b) => [b, fast.bodies.find((f) => f.id === b.id)!] as const);
    for (const [r, f] of spun) {
      if (Math.abs(r.rotation.rate) < 1e-12) continue;
      expect(Math.abs(f.rotation.rate / r.rotation.rate)).toBeCloseTo(360, 6);
    }
  });

  it("the terrain builds at the COMPRESSED radius — the ground is where the body is", { timeout: 120000 }, () => {
    // The invisible-terrain bug: the geography bake once built the surface at
    // the REAL radius around a miniature body, leaving the camera deep inside
    // a terrain sphere 25× the planet. The surface must sit at body.radius.
    const mini = generateSolarSystem({
      star: SUN, galaxyParams: DEFAULT_GALAXY_PARAMS,
      centerPosition: new THREE.Vector3(0, 0, 0), faceN: 12, compression: 25,
    });
    const me = mini.bodies.find((b) => b.id === "Ap2")!;
    me.materialize!();
    const p = me.surfaceAt!(new THREE.Vector3(me.radius * 2, 0, 0), new THREE.Vector3());
    const d = p.distanceTo(me.worldPosition);
    expect(d).toBeGreaterThan(me.radius * 0.95);
    expect(d).toBeLessThan(me.radius * 1.1); // radius + real-height relief, not 25× out
  });
});

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
    const light = star.group.children.find((c) => (c as THREE.PointLight).isPointLight) as THREE.PointLight;
    const disc = star.group.children.find((c) => c.name === "lum_disc") as THREE.Mesh;
    expect(light).toBeDefined();
    expect(disc).toBeDefined();
    // The sky layer reddens these from a stored base colour each frame; without
    // the base to scale from, the reddening would compound to black.
    expect(light.name).toBe("star_light");
    expect(light.userData.baseColor).toBeInstanceOf(THREE.Color);
    expect(disc.userData.baseColor).toBeInstanceOf(THREE.Color);

    // Gas giant: a sphere mesh.
    if (gas) {
      gas.materialize!();
      expect(gas.group.children.some((c) => (c as THREE.Mesh).isMesh)).toBe(true);
    }
  });

  it("drives the atmosphere's sun direction at the star, so the limb glow is a lit crescent", { timeout: 120000 }, () => {
    // Without this the shell/veil are radially symmetric — the midnight limb
    // glows as brightly as noon and there is no sunrise from orbit. The body's
    // update must point uSunDir (world-space, planet→star) at the star.
    const system = sol();
    const earth = system.bodies.find((b) => b.id === "Ap2")!;
    const star = system.star;
    earth.materialize!();
    // A single update tick is enough — uSunDir is set from world positions, not
    // integrated over time.
    earth.update(earth.worldPosition.clone().add(new THREE.Vector3(earth.radius * 2, 0, 0)), 0.016);

    const expected = star.worldPosition.clone().sub(earth.worldPosition).normalize();
    for (const name of ["atmosphere_halo", "atmosphere_veil"]) {
      const mesh = earth.group.children.find((c) => c.name === name) as THREE.Mesh;
      expect(mesh).toBeDefined();
      const mat = mesh.material as THREE.ShaderMaterial;
      const sunDir = mat.uniforms.uSunDir.value as THREE.Vector3;
      expect(sunDir.length()).toBeCloseTo(1, 5);
      expect(sunDir.dot(expected)).toBeGreaterThan(0.999);
      // Guard the sun-modulation itself against a silent revert to the symmetric halo.
      expect(mat.fragmentShader).toContain("uSunDir");
      expect(mat.fragmentShader).toContain("dayFactor");
    }
  });

  it("warp is inhibited near a planet, open in deep space (real world)", { timeout: 120000 }, () => {
    const system = sol();
    const world = createSystemWorld(system, DEFAULT_GALAXY_PARAMS);
    const player = createPlayer(world);
    const home = world.homePlanet!;

    // Low over the home planet: gate shut. 400 m above the actual TERRAIN —
    // radius+400 along +x̂ can sit inside a hill, and a terrain clip now
    // resolves as a real landing/stun (the low-speed dispatch got decisive),
    // which would freeze the mode through the deep-space probe below.
    home.upAt(player.state.position, player.state.forward); // will be re-derived; set a sane frame
    const lowDir = new THREE.Vector3(1, 0, 0);
    const lowProbe = home.worldPosition.clone().addScaledVector(lowDir, home.radius + 400);
    const lowPos = home.surfaceAt
      ? home.surfaceAt(lowProbe, new THREE.Vector3()).addScaledVector(lowDir, 400)
      : lowProbe;
    player.state.position.copy(lowPos);
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
