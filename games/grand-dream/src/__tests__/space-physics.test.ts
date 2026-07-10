/**
 * Seagull-dream's planetary PHYSICS, ported into shared/space/physics. Pure
 * feature generation: a system seed → each body's evolved state + derived
 * BodyFeatures (tectonic activity, hydrosphere, atmosphere, temperature,
 * terrain relief budget). These features are the SOURCE that will parameterize
 * the shared world model's geography — so the port must reproduce the Sol
 * system's character deterministically.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { DEFAULT_GALAXY_PARAMS } from "@shared/space/galaxy";
import type { StarRecord } from "@shared/space/galaxy";
import { buildHomeBlueprint, resolveSystem, type ResolvedBody } from "@shared/space/physics/index";
import { buildPlanetGeography, geographyParamsFromFeatures, hasOceanFeatures } from "@shared/space/planet-geography";

const SUN: StarRecord = {
  id: "home_star", systemSeed: 1337, feh: 0, massInit: 1, age: 4.6, radius: 1, intrinsic: 1,
  galacticPosition: new THREE.Vector3(0, 0, 0), color: new THREE.Color(1, 1, 1),
};

function sol(): ResolvedBody[] {
  const bp = buildHomeBlueprint(SUN, DEFAULT_GALAXY_PARAMS);
  return resolveSystem(bp, DEFAULT_GALAXY_PARAMS.galaxyAgeGyr);
}
const byId = (r: ResolvedBody[], id: string) => r.find((b) => b.body.id === id)!;

describe("physics-system — Sol produces the right planetary characters", () => {
  it("Earth (Ap2) is a habitable, tectonically active, oceaned world with air", () => {
    const earth = byId(sol(), "Ap2").features;
    expect(earth.tectonicActivity).toBeGreaterThan(0.4); // active plates → mountains
    expect(earth.effectiveSurfaceTempK).toBeGreaterThan(255); // greenhouse-warmed
    expect(earth.effectiveSurfaceTempK).toBeLessThan(320);
    expect(earth.life.habitability).toBeGreaterThan(0.2);
    expect(earth.atmosphere.surfacePressureBar).toBeGreaterThan(0.3); // has real air
    expect(earth.terrain.maxReliefKm).toBeGreaterThan(0); // has a surface with relief
  });

  it("Mars (Ap3) is colder, thinner-aired and less active than Earth", () => {
    const r = sol();
    const earth = byId(r, "Ap2").features;
    const mars = byId(r, "Ap3").features;
    expect(mars.tectonicActivity).toBeLessThan(earth.tectonicActivity);
    expect(mars.effectiveSurfaceTempK).toBeLessThan(earth.effectiveSurfaceTempK);
    expect(mars.atmosphere.surfacePressureBar).toBeLessThan(earth.atmosphere.surfacePressureBar);
    expect(mars.terrain.maxReliefKm).toBeGreaterThan(0); // rocky — has a surface
  });

  it("Venus (Ap1) is a runaway greenhouse — thick CO2, scorching", () => {
    const venus = byId(sol(), "Ap1").features;
    expect(venus.atmosphere.surfacePressureBar).toBeGreaterThan(10);
    expect(venus.atmosphere.greenhouseDeltaK).toBeGreaterThan(200);
    expect(venus.effectiveSurfaceTempK).toBeGreaterThan(500);
    expect(venus.life.habitability).toBeLessThan(0.1);
  });

  it("Jupiter (Ap4) is a gas giant — massive, no solid surface", () => {
    const jup = byId(sol(), "Ap4");
    expect(jup.state.totalMass).toBeGreaterThan(50); // ≫ Earth masses
    expect(jup.features.terrain.maxReliefKm).toBe(0); // no surface to walk
  });

  it("the whole system is deterministic from the seed", () => {
    const a = sol();
    const b = sol();
    for (let i = 0; i < a.length; i++) {
      expect(b[i]!.features.tectonicActivity).toBe(a[i]!.features.tectonicActivity);
      expect(b[i]!.features.effectiveSurfaceTempK).toBe(a[i]!.features.effectiveSurfaceTempK);
      expect(b[i]!.state.radius).toBe(a[i]!.state.radius);
    }
  });
});

describe("geography seam — physics features drive the world model's terrain", () => {
  it("Earth's features grow a real oceaned, mountainous, settled world", { timeout: 120000 }, () => {
    const earth = byId(sol(), "Ap2");
    expect(hasOceanFeatures(earth)).toBe(true);
    const g = buildPlanetGeography(earth, SUN.systemSeed);
    expect(g.radiusM).toBeGreaterThan(5e6); // real Earth-scale metres
    expect(g.hasOcean).toBe(true);
    // Land AND sea: the substrate has cells above and below sea level.
    const n = g.built.topo.n;
    let land = 0, sea = 0;
    for (let c = 0; c < n; c++) (g.built.grid.fields.height[c]! >= 3 ? land++ : sea++);
    expect(land).toBeGreaterThan(n * 0.1);
    expect(sea).toBeGreaterThan(n * 0.1);
    // Mountains scaled to the physics relief budget (maxReliefKm), not noise.
    expect(g.built.spec.relief * g.radiusM).toBeCloseTo(earth.features.terrain.maxReliefKm * 1000, -3);
    // Settled → founding sites (the cities the civ layer will raise).
    expect(g.built.sites.length).toBeGreaterThan(0);
  });

  it("Mars' features grow a drier, unsettled world; the mapping reflects it", () => {
    const r = sol();
    const mars = byId(r, "Ap3");
    const earthP = geographyParamsFromFeatures(byId(r, "Ap2"), SUN.systemSeed).world as Record<string, number | object>;
    const marsP = geographyParamsFromFeatures(mars, SUN.systemSeed).world as Record<string, unknown>;
    expect(hasOceanFeatures(mars)).toBe(false);
    expect(marsP.settle).toBe(false); // no life+water → no rivers/cities
    expect(marsP.rain).toBe(0);
    // Fewer colliding plates than active Earth.
    expect((marsP.geology as { plates: number }).plates)
      .toBeLessThan(((earthP.geology as { plates: number }).plates));
  });

  it("a gas giant has no geography to build", () => {
    const jup = byId(sol(), "Ap4");
    expect(() => buildPlanetGeography(jup, SUN.systemSeed)).toThrow(/no solid surface/);
  });

  it("geography is deterministic from the body + system seed", { timeout: 120000 }, () => {
    const earth = byId(sol(), "Ap2");
    const a = buildPlanetGeography(earth, SUN.systemSeed);
    const b = buildPlanetGeography(earth, SUN.systemSeed);
    expect(b.built.sites.length).toBe(a.built.sites.length);
    expect(b.built.grid.fields.height[100]).toBe(a.built.grid.fields.height[100]);
  });
});
