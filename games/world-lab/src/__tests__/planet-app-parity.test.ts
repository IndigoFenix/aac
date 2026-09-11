/**
 * planet-app-parity.test.ts — THE APP'S OLD ARITHMETIC vs THE ENGINE'S.
 *
 * ⚖️ The user's law: *"world-lab renders; text mode narrates; nothing else may
 * differ."* S3 turned the browser's founding premise, its partner enumeration
 * and its three ground samplers into CALLS into
 * `shared/world-engine/interaction/town/planet-scope.ts`. This suite is what
 * says the browser's BEHAVIOUR did not move: the pre-S3 bodies are pasted in
 * below VERBATIM — THREE, mutation-in-place and all — and held against the
 * engine's answers on the real frontier planet.
 *
 * 💰 ONE geology bake (~24 s), taken once at module level through the engine's
 * own memo and shared by every case. Vitest's timeout here is 60 s per test
 * (vitest.config.ts), and the bake happens before the first one runs.
 *
 * NOT a unit test of the engine — `server/tests/world-engine/planet-scope.test.ts`
 * pins the record's literals. This one only asks: is the app's answer the same
 * answer it used to give?
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as THREE from "three";
import { loadWorldManifest, type GameSettings } from "@shared/world-engine/kernel/manifest";
import { ECONOMY_MODULE } from "@shared/world-engine/kernel/modules/economy/index";
import {
  buildPlanetScope, partnerRows, partnerGeographyOf, sphereGeometry,
  type PlanetScope,
} from "@shared/world-engine/interaction/town/planet-scope";
import { climateSampleAt, ecoAbundanceAt } from "@shared/world-engine/planet/ecology";
import type { PlanetCity } from "@shared/world-engine/planet/cities";
import type { PlanetRoute } from "@shared/world-engine/planet/routes";
import type { PartnerGeography } from "@shared/world-engine/kernel/town/barter";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(
  readFileSync(path.resolve(HERE, "..", "..", "..", "..", "scripts", "worlds", "frontier-planet.spec.json"), "utf8"),
) as Record<string, unknown>;

/** The app's synthetic beacon id (`main.ts FOUNDED_CELL_BASE + site.seed`). */
const FOUNDED_CELL_BASE = 1_000_000_000;

let planet: PlanetScope;
/**
 * The row list the BROWSER enumerates — `flight.cities()`, IN ITS REAL ORDER.
 *
 * 🚨 THE BEACON IS FIRST, and that is a fact about the frame, not a choice
 * here. `flightCities` is append-only and the home planet's geology bakes in a
 * WORKER, so on the first frame after it resolves: `stepSpirit`
 * (main.ts:6668) → `stepFoundingPremise` (:4548) sees `body.geography`, founds,
 * and `flight.addCities` pushes the beacon into an EMPTY list; only later that
 * same frame does `flight.stepStreaming` (:6696) → `refreshCities` →
 * `syncNewCities` → `foundCitiesOn` push the 1757 capitals behind it. The F-1
 * case below turns on exactly this.
 */
let appCities: PlanetCity[];
let beacon: PlanetCity;
let beaconCell = 0;

beforeAll(() => {
  const loaded = loadWorldManifest(structuredClone(DOC), [ECONOMY_MODULE]);
  planet = buildPlanetScope(loaded.game as GameSettings);
  beaconCell = FOUNDED_CELL_BASE + planet.site.seed;
  // `foundedPlanetCity(...)` — the beacon row, at the homestead's dir.
  beacon = {
    cell: beaconCell, name: "frontier", dir: planet.body.dir, density: 0,
    charter: planet.env.charter, startPop: 0,
    node: { type: null, types: [], freshWater: false, sentence: "" },
  };
  appCities = [beacon, ...planet.cities];
}, 120_000);

// ─────────────────────────────────── (a) the partner rows, old body vs new

/**
 * `main.ts nearbyCityPartners`, PRE-S3, pasted verbatim — only the plumbing
 * changed (a plain row list instead of `flight.cities()`, an explicit radius
 * instead of `body.radius`, and the incident routes handed in). The
 * ARITHMETIC below is untouched: `angleTo`, the in-place `addScaledVector`
 * projection, the `ang < 1e-9` and `lengthSq < 1e-12` skips, the two dots
 * against a quaternion-derived east/north, the sort by angle, `maxN`.
 */
function legacyNearbyCityPartners(
  cities: readonly PlanetCity[],
  radius: number,
  selfDir: THREE.Vector3,
  quat: THREE.Quaternion,
  simCenter: { x: number; y: number },
  excludeCell: number | null,
  roads: Array<{ route: PlanetRoute; end: "a" | "b" }>,
  maxN = 3,
): Array<{ key: string; at: { x: number; y: number }; geo: PartnerGeography; distanceM: number }> {
  const east = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
  const north = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
  const other = new THREE.Vector3();
  const rows: Array<{
    key: string; ang: number; at: { x: number; y: number };
    geo: PartnerGeography; distanceM: number;
  }> = [];
  for (const city of cities) {
    if (city.cell === excludeCell) continue;
    other.set(city.dir[0], city.dir[1], city.dir[2]);
    const ang = selfDir.angleTo(other);
    if (ang < 1e-9) continue;
    const toward = other.addScaledVector(selfDir, -other.dot(selfDir));
    if (toward.lengthSq() < 1e-12) continue;
    toward.normalize();
    const distM = ang * radius;
    const road = roads.find(({ route, end }) => (end === "a" ? route.b : route.a) === city.cell);
    rows.push({
      key: `city:${city.cell}`,
      ang,
      at: {
        x: simCenter.x + toward.dot(east) * distM,
        y: simCenter.y + toward.dot(north) * distM,
      },
      // `cityPartnerGeography`, pre-S3.
      geo: { node: city.node?.type ?? null, farmland: city.charter?.farmland, ore: city.charter?.ore_access },
      distanceM: road?.route.lengthM ?? distM,
    });
  }
  rows.sort((a, b) => a.ang - b.ang);
  return rows.slice(0, maxN).map(({ key, at, geo, distanceM }) => ({ key, at, geo, distanceM }));
}

/** `main.ts townFrameOf`'s quaternion — the anchor convention the pre-S3
 *  partner scan was handed as its second argument. */
function anchorQuat(dir: readonly [number, number, number]): THREE.Quaternion {
  const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
}

/** Two partner rows agree: key and geo exactly, `at` to 1e-9 RELATIVE (these
 *  are metres on a 6,384 km planet — one ULP there is already 4e-9 m), and
 *  `distanceM` to 1e-6. */
function expectRowsEqual(
  got: ReturnType<typeof legacyNearbyCityPartners>,
  want: ReturnType<typeof legacyNearbyCityPartners>,
): void {
  expect(got.map((r) => r.key)).toEqual(want.map((r) => r.key));
  expect(got.map((r) => r.geo)).toEqual(want.map((r) => r.geo));
  for (let i = 0; i < want.length; i++) {
    const rel = (a: number, b: number): void => {
      expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(b)));
    };
    rel(got[i]!.at.x, want[i]!.at.x);
    rel(got[i]!.at.y, want[i]!.at.y);
    expect(got[i]!.distanceM).toBeCloseTo(want[i]!.distanceM, 6);
  }
}

describe("(a) the partner rows — the app's pre-S3 arithmetic vs the engine's", () => {
  it("THE HOMESTEAD: no city identity, no roads ⇒ chords", () => {
    const selfDir = new THREE.Vector3(...planet.body.dir).normalize();
    const legacy = legacyNearbyCityPartners(
      appCities, planet.body.radiusM, selfDir.clone(), anchorQuat(planet.body.dir),
      { x: 0, y: 0 }, beaconCell, [],
    );
    const engine = partnerRows(
      appCities, sphereGeometry(planet.body.radiusM),
      [selfDir.x, selfDir.y, selfDir.z], { x: 0, y: 0 }, beaconCell, [],
    );
    expect(engine.length).toBe(3);
    expectRowsEqual(engine, legacy);
    // …and it is the SAME board the engine's own record carries.
    expect(engine).toEqual(planet.env.partners);
  });

  it("ISTRIDGE (the co-located capital): the same three, priced at its ROADS", () => {
    const incident = planet.routes
      .filter((r) => r.a === planet.cell || r.b === planet.cell)
      .map((r) => ({ route: r, end: (r.a === planet.cell ? "a" : "b") as "a" | "b" }));
    expect(incident.length).toBe(4);
    const selfDir = new THREE.Vector3(...planet.body.dir).normalize();
    const legacy = legacyNearbyCityPartners(
      appCities, planet.body.radiusM, selfDir.clone(), anchorQuat(planet.body.dir),
      { x: 0, y: 0 }, planet.cell, incident,
    );
    const engine = partnerRows(
      appCities, sphereGeometry(planet.body.radiusM),
      [selfDir.x, selfDir.y, selfDir.z], { x: 0, y: 0 }, planet.cell,
      incident.map(({ route }) => route),
    );
    expectRowsEqual(engine, legacy);
    // The road arm is LIVE here and the chord arm was live above — the same
    // three cities, the same places, a different price.
    expect(engine.map((r) => Math.round(r.distanceM))).toEqual([363304, 366282, 366785]);
    expect(engine.map((r) => r.at)).toEqual(planet.env.partners.map((r) => r.at));
  });

  it("`partnerGeographyOf` IS `cityPartnerGeography`", () => {
    for (const c of [...planet.cities.slice(0, 50), beacon]) {
      expect(partnerGeographyOf(c)).toEqual({
        node: c.node?.type ?? null, farmland: c.charter?.farmland, ore: c.charter?.ore_access,
      });
    }
  });
});

// ─────────────────────────────────── (b) the three samplers

describe("(b) cityClimate / cityBiome / cityEcology — the app's reads vs the record", () => {
  it("are the same three reads on the same grid at the same cell", () => {
    const grid = planet.built.grid;
    const cellAt = grid.topo.cellAt!;
    const cell = cellAt(planet.body.dir);
    // `main.ts cityClimate` / `cityBiome` / `cityEcology`, pre-S3 bodies.
    const legacyClimate = climateSampleAt(grid, cell);
    const legacyBiome = grid.fields.biome ? grid.fields.biome[cell] ?? null : null;
    const legacyEco = ecoAbundanceAt(grid, cell);
    expect(cell).toBe(planet.cell);
    expect(legacyClimate).toEqual(planet.env.climate);
    expect(legacyBiome).toBe(planet.env.biome);
    expect(legacyEco).toEqual(planet.env.eco);
  });
});

// ─────────────────────────────────── (c) the forest cell

describe("(c) the forest-cell choice", () => {
  it("the app's pre-S3 eight lines pick the engine's cell", () => {
    const built = planet.built;
    // `main.ts stepFoundingPremise`, pre-S3 — verbatim.
    const biome = built.grid.fields.biome;
    const dry = (built.sites ?? []).filter((s) => {
      const d = built.topo.pos3?.(s.cell);
      return !!d && built.surface.heightAt(d) >= 0;
    });
    const site0 = dry.find((s) => biome?.[s.cell] === 1) ?? dry[0];
    expect(site0).toBeTruthy();
    expect(site0!.cell).toBe(planet.cell);
    const dirArr = built.topo.pos3!(site0!.cell);
    expect([dirArr[0], dirArr[1], dirArr[2]]).toEqual(planet.body.dir);
    // …and the surface radius the beacon stands at.
    expect(planet.body.radiusM + Math.max(0, built.surface.heightAt(dirArr)))
      .toBeCloseTo(planet.body.surfaceR, 6);
  });
});

// ─────────────────────────────────── (d) the beacon row carries a node

describe("(d) the founded beacon row", () => {
  it("declares an EMPTY node reading rather than omitting the field (tsc #7)", () => {
    expect(beacon.cell).toBe(beaconCell);
    expect(beacon.node).toEqual({ type: null, types: [], freshWater: false, sentence: "" });
    // Which is exactly what the partner geography already assumed.
    expect(partnerGeographyOf(beacon).node).toBeNull();
  });
});

// ─────────────────────────────────── (e) F-1: the co-located capital

describe("(e) F-1 — the homestead shares a cell with a 2000-pop capital (C-4)", () => {
  it("REPLICATED, not fixed: cities[0] IS the premise's cell", () => {
    // `foundCitiesFromSites` keeps every site with farmland ≥ 40, so the best
    // forest cell on the planet is also the best CITY site on it. R-3: the
    // engine replicates the browser exactly this round; withholding the
    // premise's cell from `cities` is a one-line browser change, main's call.
    expect(planet.cities[0]!.cell).toBe(planet.cell);
    expect(planet.cities[0]!.name).toBe("Istridge");
    expect(planet.cities[0]!.startPop).toBe(2000);
    // The beacon stands at the SAME direction, under a different key.
    expect(beacon.dir).toEqual(planet.cities[0]!.dir);
    expect(beaconCell).not.toBe(planet.cities[0]!.cell);
  });

  it("🔎 `nearestCity` at the homestead resolves to THE BEACON, not to Istridge", () => {
    // THE ANSWER C-4 ASKED FOR, measured rather than assumed.
    //
    // `space-fly.ts nearestCity` (:375-386) keeps a new best only on a
    // STRICTLY smaller distance (`if (distM < bestDist)`), walking
    // `flightCities` in INSERTION order — so at a dead tie the EARLIER entry
    // stands. And the beacon is the earlier entry: see the note on
    // `appCities` above (stepSpirit's premise seat runs before that frame's
    // streaming pass, so it pushes into an empty list).
    //
    // ⇒ the co-location is BENIGN for this query: the player's homestead wins
    // its own position, which is the behaviour the premise wants. R-3 stands
    // — nothing is changed here, and withholding the premise's cell from
    // `cities` remains main's call (U-3).
    const d2 = (a: readonly [number, number, number], b: readonly [number, number, number]): number =>
      (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    const query = planet.body.dir;
    let best: PlanetCity | null = null;
    let bestD = Infinity;
    for (const c of appCities) {
      const d = d2(c.dir, query);
      if (d < bestD) { bestD = d; best = c; }   // strict `<` — the app's rule
    }
    expect(bestD).toBe(0);
    expect(best!.cell).toBe(beaconCell);
    expect(best!.name).toBe("frontier");
    // …and the tie is REAL: Istridge sits at the same distance, and only the
    // strictness of the comparison keeps it from taking the query.
    expect(d2(planet.cities[0]!.dir, query)).toBe(0);
  });
});
