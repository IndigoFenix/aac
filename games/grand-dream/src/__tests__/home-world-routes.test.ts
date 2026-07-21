/**
 * Intercity routes on the HOME-WORLD path — solar-physics geography (real
 * radius, minSpacing-2 founding = ~150 cities), not the earthlike demo doc
 * the main suite pins. This is the pipeline the flight scene actually runs;
 * the log line gives the live numbers when eyeballs and code disagree.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { DEFAULT_GALAXY_PARAMS, type StarRecord } from "@shared/world-engine/space/galaxy";
import { generateSolarSystem, pickHomePlanet } from "@shared/world-engine/space/solar-system";
import { planetCities } from "@shared/world-engine/planet/cities";
import { planetRoutes, caravanCount } from "@shared/world-engine/planet/routes";
import { planetStates, statePairs, stateBorders } from "@shared/world-engine/planet/states";

const SUN: StarRecord = {
  id: "home_star", systemSeed: 1337, feh: 0, massInit: 1, age: 4.6, radius: 1, intrinsic: 1,
  galacticPosition: new THREE.Vector3(0, 0, 0), color: new THREE.Color(1, 1, 1),
};

describe("home-world intercity routes (diagnostic)", () => {
  it("founds cities and joins them", { timeout: 600_000 }, () => {
    const system = generateSolarSystem({
      star: SUN, galaxyParams: DEFAULT_GALAXY_PARAMS,
      centerPosition: new THREE.Vector3(0, 0, 0), faceN: 24,
    });
    const home = pickHomePlanet(system);
    expect(home).toBeTruthy();
    home!.materialize!();
    const built = home!.geography!;
    expect(built).toBeTruthy();

    const t0 = performance.now();
    const cities = planetCities(built);
    const t1 = performance.now();
    // The flight path: territory → adjacency pairs → routes (trade-roads.ts).
    const states = planetStates(built, cities);
    const t2 = performance.now();
    const pairs = statePairs(states);
    const routes = planetRoutes(built, cities, pairs.length ? { pairs } : {});
    const t3 = performance.now();
    const borders = stateBorders(built, states);
    const t4 = performance.now();

    const lens = routes.map(r => r.lengthM).sort((a, b) => a - b);
    const caravans = routes.reduce((n, r) => n + caravanCount(r), 0);
    console.log(`home=${home!.id} radius=${(home!.radius / 1e6).toFixed(2)}e6 m`);
    console.log(`sites=${built.sites.length} cities=${cities.length} (${(t1 - t0).toFixed(0)} ms)`);
    console.log(`states: adjacency=${states.adjacency.length} pairs=${pairs.length} borderCells=${states.borderCells.length} (${(t2 - t1).toFixed(0)} ms)`);
    console.log(`routes=${routes.length} (${(t3 - t2).toFixed(0)} ms) caravans=${caravans}`);
    console.log(`border polylines=${borders.length} (${(t4 - t3).toFixed(0)} ms)`);
    if (lens.length) {
      console.log(`route km: min=${(lens[0]! / 1e3).toFixed(0)} med=${(lens[lens.length >> 1]! / 1e3).toFixed(0)} max=${(lens[lens.length - 1]! / 1e3).toFixed(0)}`);
      const far = routes.reduce((n, r) => n + Math.ceil(r.lengthM / 2500) + 1, 0);
      console.log(`far ribbon samples total=${far}`);
    }
    expect(cities.length).toBeGreaterThan(1);
    expect(states.adjacency.length).toBeGreaterThan(0);
    expect(routes.length).toBeGreaterThan(0);
    expect(borders.length).toBeGreaterThan(0);
  });
});
