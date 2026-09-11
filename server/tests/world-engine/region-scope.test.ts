/**
 * 🌍 THE REGION PRODUCER — a baked FLAT map boots the same founding camp
 * headless (planning-docs/games/world-engine/planet-boot-round.md, S3b).
 *
 * ⚖️ THE USER'S RULING (2026-09-10, verbatim): *"it's not that important, but
 * it is a feature we'll want in the spec. Could also help with faster
 * testing since we don't have to build the whole planet every time."* A
 * `region`-scope document with declared geology + rain boots the SAME
 * founding camp headless as the planet document does — real cells, sites,
 * cities, routes and partners, no planet.
 *
 * WHAT THIS FILE PINS:
 *   ① THE SPHERE DID NOT MOVE. `planet/surface-metric.ts`'s `sphereMetric`
 *      is the exact math `interaction/town/planet-scope.ts` shipped in S1
 *      (moved, not rewritten) — the byte-hold is
 *      `npm run test:engine -- planet-scope` (S1's own 35 pins: checksum
 *      `ece0d9ba`, 1757 cities, 2708 routes); this file does not repeat
 *      those numbers, it only proves the RE-EXPORT still resolves.
 *   ② `planeMetric` unit facts — Euclidean `distM`, `inside` at the exact
 *      boundary, `latRad` at three rows, `offsetM`.
 *   ③ `buildRegionScope` on the generated `frontier-region.spec.json` — a
 *      forest-scan cell exists, the charter/climate/eco/biome are measured
 *      (not defaulted), ≥ 2 cities, ≥ 1 plane-framed route whose length is
 *      the Euclidean chord (± the port clip), ≥ 1 partner with a positive
 *      distance, two builds are digest-identical, and a plane route's
 *      `routePointAt` never re-normalises.
 *
 * DB-free — `npm run test:engine -- region-scope`.
 */
import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorldManifest, type GameSettings } from "@shared/world-engine/kernel/manifest.js";
import { ECONOMY_MODULE } from "@shared/world-engine/kernel/modules/economy/index.js";
import {
  buildRegionScope, sphereMetric, type RegionScope, type SiteEnvironment,
} from "@shared/world-engine/interaction/town/planet-scope.js";
import { planeMetric } from "@shared/world-engine/planet/surface-metric.js";
import { routePointAt, routeFrom } from "@shared/world-engine/planet/routes.js";
import { foundedSiteToJSON } from "@shared/world-engine/interaction/town/founding.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOC_PATH = path.join(ROOT, "scripts", "worlds", "frontier-region.spec.json");
const RAW_DOC = readFileSync(DOC_PATH, "utf8");
const DOC = JSON.parse(RAW_DOC) as Record<string, unknown>;

function gameOf(doc: unknown = DOC): GameSettings {
  const loaded = loadWorldManifest(structuredClone(doc) as Record<string, unknown>, [ECONOMY_MODULE]);
  if (!loaded.game) throw new Error("the frontier-region document has no `game`");
  return loaded.game;
}

// THE ONE BUILD every describe below reads (region builds are cheap — no
// bake — so re-deriving per `it` is unnecessary, not merely slow).
const SCOPE: RegionScope = buildRegionScope(gameOf());

function digest(s: RegionScope): string {
  return JSON.stringify({
    cell: s.cell,
    env: s.env,
    wildMix: s.wildMix,
    site: foundedSiteToJSON(s.site),
    townConfig: s.townConfig,
    counts: [s.cities.length, s.states.adjacency.length, s.pairs.length, s.routes.length],
  });
}

// ─────────────────────────────────────────── ① THE SPHERE RE-EXPORT RESOLVES

describe("the sphere half moved, not rewritten", () => {
  it("planet-scope.ts still exports a working sphereMetric (re-exported from planet/surface-metric.ts)", () => {
    // A trivial two-cell topology — this is a RESOLUTION check (the import
    // still works after the move), not a re-run of S1's substrate pins,
    // which live in `npm run test:engine -- planet-scope` and are the
    // actual byte-hold this round protects.
    const topo = {
      pos3: (i: number): readonly [number, number, number] => (i === 0 ? [1, 0, 0] : [0, 1, 0]),
      n: 2, maxDegree: 0, neighbours: () => 0,
    };
    const m = sphereMetric(topo, 1000);
    expect(m.kind).toBe("sphere");
    expect(m.distM(m.posOf(0), m.posOf(1))).toBeCloseTo((Math.PI / 2) * 1000, 6);
  });
});

// ─────────────────────────────────────────────────── ② planeMetric UNIT FACTS

describe("planeMetric — the flat half of the seam", () => {
  const metric = planeMetric(10, 8, 100, 2000, 20);

  it("posOf is the cell's centre in metres, row-major", () => {
    expect(metric.posOf(0)).toEqual([50, 50, 0]);
    expect(metric.posOf(3)).toEqual([350, 50, 0]); // col 3, row 0
    expect(metric.posOf(13)).toEqual([350, 150, 0]); // col 3, row 1 (13 = 1*10+3)
  });

  it("distM is plain Euclidean distance", () => {
    const a = metric.posOf(0);
    const b = metric.posOf(3);
    expect(metric.distM(a, b)).toBeCloseTo(300, 9);
  });

  it("inside is a flat disc, exact at the boundary", () => {
    const c: readonly [number, number, number] = [0, 0, 0];
    expect(metric.inside([99, 0, 0], c, 100)).toBe(true);
    expect(metric.inside([100, 0, 0], c, 100)).toBe(false); // exactly on the boundary
    expect(metric.inside([101, 0, 0], c, 100)).toBe(false);
  });

  it("latRad reads the declared centre latitude at the middle row, and offsets it elsewhere", () => {
    const lat0 = (20 * Math.PI) / 180;
    // Row 4 is the map's centre (rows/2 = 4) — latRad(cell) at row 4 === lat0.
    expect(metric.latRad(4 * 10)).toBeCloseTo(lat0, 12);
    // Row 0 is 4 rows north of centre (rows/2 - row = 4) at 100 m/cell.
    const R_EARTH_M = 6_371_000;
    expect(metric.latRad(0)).toBeCloseTo(lat0 - (4 * 100) / R_EARTH_M, 12);
    expect(metric.latRad(7 * 10)).toBeCloseTo(lat0 + (3 * 100) / R_EARTH_M, 12);
  });

  it("offsetM is a plain subtraction, null only when the two points coincide", () => {
    const from = metric.posOf(0);
    const to = metric.posOf(3);
    expect(metric.offsetM(from, to)).toEqual({ x: 300, y: 0 });
    expect(metric.offsetM(from, from)).toBeNull();
  });

  it("project is the identity (a plane point is already on the plane)", () => {
    const v: readonly [number, number, number] = [12.5, -3.25, 0];
    expect(metric.project(v)).toEqual(v);
  });

  it("metresPerCell/metresPerUnit are the fixture's own numbers", () => {
    expect(metric.metresPerCell).toBe(100);
    expect(metric.metresPerUnit).toBeCloseTo(2000 / (63 - 3), 9);
    expect(metric.pitchM).toBe(100);
  });
});

// ───────────────────────────────────────── ③ buildRegionScope ON THE FIXTURE

describe("buildRegionScope — the flat sibling of buildPlanetScope", () => {
  it("finds a forest-scan founding cell on the settled substrate", () => {
    expect(SCOPE.cell).toBeGreaterThanOrEqual(0);
    expect(SCOPE.site.key).toBe("frontier");
    expect(SCOPE.site.stock).toEqual({ wood: 14, stone: 6, basket: 2 });
  });

  it("MEASURES the environment — charter/climate/biome/eco off the real cell (literals from the first run)", () => {
    const env: SiteEnvironment = SCOPE.env;
    expect(env.charter).toEqual({ farmland: 274, ore_access: 0, timberland: 215 });
    expect(env.climate.rain).toBeCloseTo(0.34809643183589434, 9);
    expect(env.climate.tempC).toBeCloseTo(25.122244546815217, 9);
    expect(env.climate.elevation).toBe(5);
    expect(env.climate.fertility).toBe(8);
    expect(env.climate.ore).toBe(0);
    expect(env.biome).toBe(2);
    expect(env.eco.grass).toBeCloseTo(0.3, 6);
    // FLAT, and says so — no `ground` sampler headless, same as the planet arm.
    expect(env.ground).toBeUndefined();
  });

  it("founds ≥ 2 cities on the flat substrate", () => {
    expect(SCOPE.cities.length).toBeGreaterThanOrEqual(2);
  });

  it("routes are PLANE-framed, and their length is at least the Euclidean chord (a polyline can only be ≥ its own endpoint chord)", () => {
    expect(SCOPE.routes.length).toBeGreaterThanOrEqual(1);
    const r = SCOPE.routes[0]!;
    expect(r.frame).toBe("plane");
    const a = r.dirs[0]!;
    const b = r.dirs[r.dirs.length - 1]!;
    const chord = Math.hypot(a[0] - b[0], a[1] - b[1]);
    // Triangle inequality: any polyline through its own endpoints is at
    // least as long as the straight line between them.
    expect(r.lengthM).toBeGreaterThanOrEqual(chord - 1e-6);
    expect(r.lengthM).toBeGreaterThan(0);
  });

  it("≥ 1 partner, priced at a positive distance", () => {
    expect(SCOPE.env.partners.length).toBeGreaterThanOrEqual(1);
    for (const p of SCOPE.env.partners) {
      expect(p.key.startsWith("city:")).toBe(true);
      expect(p.distanceM).toBeGreaterThan(0);
    }
  });

  it("two builds of the document are digest-identical", () => {
    const second = buildRegionScope(gameOf());
    expect(digest(second)).toBe(digest(SCOPE));
  });

  it("routePointAt on a plane route never re-normalises — a midpoint sample lies on the segment", () => {
    // A synthetic 3-point plane route (not chaikin-smoothed) so the midpoint
    // math is checkable by hand: (0,0) -> (300,0) -> (300,400), 300+400=700 m.
    const metric = planeMetric(10, 10, 100, 2000, 0);
    const dirs: Array<readonly [number, number, number]> = [[0, 0, 0], [300, 0, 0], [300, 400, 0]];
    const route = routeFrom(dirs, metric, 0, 1)!;
    expect(route.frame).toBe("plane");
    expect(route.lengthM).toBeCloseTo(700, 6);
    const mid = routePointAt(route, route.lengthM / 2); // s = 350 -> (300, 50, 0)
    expect(mid[0]).toBeCloseTo(300, 6);
    expect(mid[1]).toBeCloseTo(50, 6);
    expect(mid[2]).toBe(0); // a sphere's nlerp+normalise would have pulled this off the plane
  });
});
