// PLANET BOOT — the boot of a planet world as ONE engine definition (S1).
//
// ⚖️ The user's law (2026-09-10): *"Text mode isn't supposed to be different
// from visual mode except for the visual rendering."* Founding a homestead on
// a real planet was a BROWSER procedure; it is now
// `shared/world-engine/interaction/town/planet-scope.ts`, and this suite is
// what says the engine's copy IS the browser's — every literal below was
// recorded off the browser's own chain (the S0 recon probe, run headless
// against `games/world-lab/src/main.ts`'s exact call order) before a line of
// the engine definition existed.
//
// 💰 COST: ONE geology bake (~24 s on this box), taken once at module level
// and shared by every case. `buildPlanetScope` memoises it per process, so a
// second boot in the same worker is free — which is what makes the
// two-builds-are-identical and restore cases cheap.
//
// Pure logic. No DB, no LLM, no GL, no DOM.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorldManifest, type GameSettings } from "@shared/world-engine/kernel/manifest.js";
import { ECONOMY_MODULE } from "@shared/world-engine/kernel/modules/economy/index.js";
import {
  buildPlanetScope, planetScopeOn, measuredEnvironment, declaredEnvironment,
  sphereMetric, sphereGeometry, partnerRows, planetChecksum, partnerGeographyOf, PREMISE_KEY,
  type PlanetScope, type SiteEnvironment,
} from "@shared/world-engine/interaction/town/planet-scope.js";
import type { PlanetCity } from "@shared/world-engine/planet/cities.js";
import {
  foundSite, foundedSiteToJSON, createFoundedSite,
} from "@shared/world-engine/interaction/town/founding.js";
import { parseSolarWorld, SOLAR_WORLD_FIELDS, PREMISE_FIELDS } from "@shared/world-engine/space/space-game.js";
import type { TownPlayConfig } from "@shared/world-engine/interaction/town/town-play.js";
import { TEST_WORLDS } from "../../../games/world-lab/src/worlds.js";
import { lowerTreeWorld } from "../../../games/world-lab/src/lower-world.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOC_PATH = path.join(ROOT, "scripts", "worlds", "frontier-planet.spec.json");
const RAW_DOC = readFileSync(DOC_PATH, "utf8");
const DOC = JSON.parse(RAW_DOC) as Record<string, unknown>;

/** The document's `game`, loaded exactly as every headless boot loads it. */
function gameOf(doc: unknown = DOC): GameSettings {
  const loaded = loadWorldManifest(structuredClone(doc) as Record<string, unknown>, [ECONOMY_MODULE]);
  if (!loaded.game) throw new Error("the frontier-planet document has no `game`");
  return loaded.game;
}

// THE ONE BAKE. Everything below reads this.
const SCOPE: PlanetScope = buildPlanetScope(gameOf());

/** A comparable digest of the record — everything but the substrate itself
 *  (which is shared by reference) and the built town (typed arrays + closures). */
function digest(s: PlanetScope): string {
  return JSON.stringify({
    body: s.body,
    geologySeed: s.geologySeed,
    checksum: s.checksum,
    cell: s.cell,
    env: s.env,
    wildMix: s.wildMix,
    site: foundedSiteToJSON(s.site),
    townConfig: s.townConfig,
    counts: [s.cities.length, s.states.adjacency.length, s.pairs.length, s.routes.length],
  });
}

// ───────────────────────────────────────────────── ① THE SUBSTRATE (parity)

describe("the substrate the engine bakes IS the one the browser bakes", () => {
  it("resolves the home system's most habitable walkable body", () => {
    // `generateUniverse(seed).homeStar.systemSeed` is the CONSTANT
    // `GALAXY.homeSystemSeed`, so the planet is the same at every document
    // seed (R-2): the document's seed is the CAMP's, not the world's.
    expect(SCOPE.body.id).toBe("Ap2");
    expect(SCOPE.geologySeed).toBe(2232455333);
    expect(SCOPE.body.radiusM).toBeCloseTo(6384755.564817732, 6);
  });

  it("bakes at faceN 48, compression 1", () => {
    expect(SCOPE.built.spec.topology.faceN).toBe(48);
    expect(SCOPE.built.grid.topo.n).toBe(13824);
    // compression 1 ⇒ the REAL radius (STREET_CLOCK declares no
    // `planet_compression`); a compressed bake would divide it.
    expect(SCOPE.built.spec.radius).toBeCloseTo(6384755.564817732, 6);
  });

  it("finds the same founding sites, and the same dry half", () => {
    const pos3 = SCOPE.built.topo.pos3!;
    const dry = SCOPE.built.sites.filter((s) => SCOPE.built.surface.heightAt(pos3(s.cell)) >= 0);
    expect(SCOPE.built.sites.length).toBe(2177);
    expect(dry.length).toBe(1685);
  });

  it("hashes to the recorded field checksum", () => {
    expect(SCOPE.checksum).toBe("ece0d9ba");
    expect(planetChecksum(SCOPE.built.grid)).toBe("ece0d9ba");
  });
});

// ───────────────────────────────────────────────── ② THE FOUNDING CELL

describe("the forest cell the premise founds on", () => {
  it("is the top-ranked dry forest site — cell 12755", () => {
    expect(SCOPE.cell).toBe(12755);
    expect(SCOPE.env.biome).toBe(1); // 1 = forest (DEFAULT_BIOSPHERE index + 1)
  });

  it("stands where the browser stands it", () => {
    const [x, y, z] = SCOPE.body.dir;
    expect(x).toBeCloseTo(-0.36713294723022294, 12);
    expect(y).toBeCloseTo(0.045641203990156205, 12);
    expect(z).toBeCloseTo(-0.9290480501870607, 12);
    expect(SCOPE.body.surfaceR).toBeCloseTo(6385838.377953383, 6);
  });

  it("measures the charter the ground actually has", () => {
    // 🚨 R-4 / C-3: `text-quest.ts` used to declare {60, 0, 0}-ish constants
    // for a temperate wood. The real cell is a TROPICAL highland forest.
    expect(SCOPE.env.charter).toEqual({ farmland: 516, ore_access: 0, timberland: 302 });
  });

  it("samples the real climate, not the four hand-written constants", () => {
    expect(SCOPE.env.climate.rain).toBeCloseTo(1.0753296100845404, 12);
    expect(SCOPE.env.climate.tempC).toBeCloseTo(28.412460127278745, 12);
    expect(SCOPE.env.climate.elevation).toBe(7);
    expect(SCOPE.env.climate.fertility).toBe(12);
    expect(SCOPE.env.climate.ore).toBe(0);
  });

  it("reads the cell's per-species abundance", () => {
    expect(SCOPE.env.eco).toEqual({ tree: 0.24, grass: 0, horse: 0 });
  });

  it("scatters the countryside the real cell grows — BANANAS, not a temperate larder", () => {
    // 🌿 …AND IT STANDS THEM AT A DENSITY THE CELL CAN ACTUALLY CARRY (the
    // resource-packing round). This line read `banana_plant ×2` at 0.554/ha —
    // `forageBase`'s biome COUNT re-expressed at a fixed 3.61 ha, because no
    // `FORAGE_UNDERSTORY` row had ever been authored for a banana. Half a
    // banana plant a hectare on a wet tropical cell was the authored table's
    // failure mode in one number. `planet/packing.ts` now packs the cell's own
    // light/water/nutrient budget: **11.671/ha, 21.1× what it stood.**
    //
    // 🥕 AND THE CARROT JOINS AT COUNT 0, WHICH IS THE POINT. Membership on the
    // packed arm is `fit > 0`, never a rounded count: `10 × rarity 0.1 ×
    // suitability` rounds to zero, and under the old law the line was DELETED
    // before anything qualified to count it ever saw it. The pass stands 6.04
    // patches a hectare of it. `count` is dead weight on this arm (the density
    // is what `buildWilderness` reads) and is left as the rounding it was.
    expect(SCOPE.wildMix.map((m) => [m.species, m.count])).toEqual([
      ["oak", 10], ["banana_plant", 2], ["carrot_plant", 0], ["rock", 6],
    ]);
    // The BAKED canopy and the mineral are untouched — the pass places neither.
    expect(SCOPE.wildMix[0]!.perHa).toBeCloseTo(10.32, 9);                 // 43 × eco_tree 0.24
    expect(SCOPE.wildMix[1]!.perHa).toBeCloseTo(11.670540829296439, 9);
    expect(SCOPE.wildMix[2]!.perHa).toBeCloseTo(6.043852519996517, 9);
    expect(SCOPE.wildMix[3]!.perHa).toBeCloseTo(1.662049861495845, 9);
  });
});

// ───────────────────────────────────────────────── ③ THE CIV LAYER

describe("the civ layer over the founding substrate", () => {
  it("founds the planet's cities and roads BARE, like every other producer", () => {
    expect(SCOPE.cities.length).toBe(1757);
    expect(SCOPE.states.adjacency.length).toBe(3673);
    expect(SCOPE.pairs.length).toBe(2708);
    expect(SCOPE.routes.length).toBe(2708);
  });

  it("🚨 CO-LOCATES the homestead with a capital (C-4, replicated not fixed)", () => {
    // `foundCitiesFromSites` keeps every site with farmland ≥ 40, so the best
    // forest cell on the planet is ALSO cities[0]. The premise's beacon stands
    // at the same direction and the partner scan drops it (a zero-length
    // bearing), which is exactly what the browser does. Withholding the
    // premise's cell from `cities` is a BROWSER change, proposed not taken.
    expect(SCOPE.cities[0]!.cell).toBe(12755);
    expect(SCOPE.cities[0]!.name).toBe("Istridge");
  });
});

// ───────────────────────────────────────────────── ④ THE PARTNER ROWS

describe("the trade partners a founding boots with", () => {
  it("names the three nearest cities, at the CHORD (C-5)", () => {
    // A founded site's registered cell is synthetic and never a route
    // endpoint, so no interstate is incident to the PREMISE however many run
    // through its lattice cell. Every row is honest geometry.
    expect(SCOPE.env.partners.map((p) => p.key)).toEqual(["city:12804", "city:12706", "city:12708"]);
    expect(SCOPE.env.partners[0]!.distanceM).toBeCloseTo(280723.97883350885, 6);
    expect(SCOPE.env.partners[1]!.distanceM).toBeCloseTo(284459.2757856926, 6);
    expect(SCOPE.env.partners[2]!.distanceM).toBeCloseTo(286171.67415044835, 6);
  });

  it("forwards each partner's terrain verdict", () => {
    // ⚖️ REGIONAL slice: `partnerGeographyOf` forwards `yields`, the land's
    // per-good presence packed at founding (`planet/packing.ts landYieldsAt`)
    // — not farmland/ore/timber — user law 2026-09-11: "all simulation
    // should treat each good as its own thing individually"; the node is
    // naming ONLY. Pin the taxon exactly and, for `yields`, the three
    // heaviest goods per row (read off this same bake, not typed) plus the
    // shape: every catalogue good has an entry.
    const geos = SCOPE.env.partners.map((p) => p.geo);
    expect(geos.map((g) => g!.node)).toEqual(["junction", "mouth", "anchorage"]);
    for (const g of geos) expect(Object.keys(g!.yields!).length).toBe(15);

    const top3 = (yields: Record<string, number>) =>
      Object.entries(yields).sort((a, b) => b[1] - a[1]).slice(0, 3);
    expect(top3(geos[0]!.yields!)).toEqual([
      ["wood", expect.closeTo(0.41261458259359474, 6)],
      ["block", expect.closeTo(0.20630729129679737, 6)],
      ["banana", expect.closeTo(0.10749127298928933, 6)],
    ]);
    expect(top3(geos[1]!.yields!)).toEqual([
      ["wood", expect.closeTo(0.4774601464411625, 6)],
      ["block", expect.closeTo(0.23873007322058126, 6)],
      ["banana", expect.closeTo(0.18021106755462915, 6)],
    ]);
    expect(top3(geos[2]!.yields!)).toEqual([
      ["wood", expect.closeTo(0.5084149010808463, 6)],
      ["block", expect.closeTo(0.25420745054042315, 6)],
      ["banana", expect.closeTo(0.1756184586542009, 6)],
    ]);

    expect(partnerGeographyOf(SCOPE.cities.find((c) => c.cell === 12804)!)).toEqual(geos[0]);
  });

  it("places each partner in the town's own sim frame", () => {
    // Recorded from this build (the tangent-frame projection); the reference
    // check against real THREE lives in the world-lab vitest half
    // (`games/world-lab/src/__tests__/planet-frame.test.ts`).
    const at = SCOPE.env.partners.map((p) => p.at);
    expect(at[0]!.x).toBeCloseTo(-124667.60987197873, 6);
    expect(at[0]!.y).toBeCloseTo(251523.23817276882, 6);
    expect(at[1]!.x).toBeCloseTo(123385.83944489846, 6);
    expect(at[1]!.y).toBeCloseTo(-256306.48490623367, 6);
    expect(at[2]!.x).toBeCloseTo(-266189.37510955514, 6);
    expect(at[2]!.y).toBeCloseTo(-105059.2388362629, 6);
    // …and the offset IS the distance: |at| = the chord, to the metre.
    for (const p of SCOPE.env.partners) {
      expect(Math.hypot(p.at.x, p.at.y)).toBeCloseTo(p.distanceM, 3);
    }
  });

  it("⚖️ D-A3 — `partnerRows` answers the APP's row list, from BOTH sides of the co-location", () => {
    // The browser enumerates `flight.cities()`, which is the 1757 planet
    // cities PLUS the founded beacon: a row at a SYNTHETIC cell carrying the
    // homestead's dir, which is Istridge's dir. `partnerRows` reads each row's
    // POSITION off the row (never a lattice lookup), takes only
    // `distM`/`offsetM`, and takes `self` as a position — so the app hands it
    // `sphereGeometry(body.radius)` and its own list, with no topology at all.
    const geom = sphereGeometry(SCOPE.body.radiusM);
    const FOUNDED_CELL = 1_000_001_337;
    const beacon: PlanetCity = {
      cell: FOUNDED_CELL, name: PREMISE_KEY, dir: SCOPE.body.dir, density: 0,
      charter: SCOPE.env.charter, startPop: 0,
      // The app's beacon row (`foundedPlanetCity`) declares no node — the
      // player founded it, no founding scan classified its terrain.
      node: { type: null, types: [], freshWater: false, sentence: "" },
    };
    const appRows = [...SCOPE.cities, beacon];

    // ① FROM THE HOMESTEAD: no city identity, no roads ⇒ chords, and Istridge
    //    drops out through the null offset even though its row is present.
    const fromSite = partnerRows(appRows, geom, SCOPE.body.dir, { x: 0, y: 0 }, FOUNDED_CELL, []);
    expect(fromSite).toEqual(SCOPE.env.partners);

    // ② FROM ISTRIDGE: same three cities, priced at its incident interstates —
    //    and now it is the BEACON that drops out through the null offset, from
    //    the other side of the very same co-location.
    const incident = SCOPE.routes.filter((r) => r.a === 12755 || r.b === 12755);
    expect(incident.length).toBe(4);
    const fromCity = partnerRows(appRows, geom, SCOPE.body.dir, { x: 0, y: 0 }, 12755, incident);
    expect(fromCity.map((p) => p.key)).toEqual(["city:12804", "city:12706", "city:12708"]);
    expect(fromCity.map((p) => Math.round(p.distanceM))).toEqual([363304, 366282, 366785]);
    expect(fromCity.map((p) => p.at)).toEqual(SCOPE.env.partners.map((p) => p.at));
  });

  it("⚖️ prices the ROAD for a town that IS a city (the road arm)", () => {
    // Same cell, same three nearest — but this caller says WHICH city it is,
    // so each row carries the incident interstate's length instead of the
    // chord. A road round a mountain runs longer than the line of sight.
    const metric = sphereMetric(SCOPE.built.topo, SCOPE.body.radiusM);
    const istridge = measuredEnvironment(
      { grid: SCOPE.built.grid, cities: SCOPE.cities, routes: SCOPE.routes },
      metric, 12755, 0, { x: 0, y: 0 }, 12755,
    );
    expect(istridge.partners.map((p) => p.key)).toEqual(["city:12804", "city:12706", "city:12708"]);
    expect(istridge.partners.map((p) => Math.round(p.distanceM))).toEqual([363304, 366282, 366785]);
    // The PLACES are unchanged — only the price moved.
    expect(istridge.partners.map((p) => p.at)).toEqual(SCOPE.env.partners.map((p) => p.at));
  });
});

// ───────────────────────────────────────────────── ⑤ THE KIT

describe("the founders' kit (foundSite's one new seat)", () => {
  it("lands on the site's stock — which IS the overlay's yard", () => {
    expect(SCOPE.site.stock).toEqual({ wood: 14, stone: 6, basket: 2 });
    expect(SCOPE.site.stock).toBe(SCOPE.site.deltas.stock);
    expect(SCOPE.site.key).toBe(PREMISE_KEY);
    expect(SCOPE.site.seed).toBe(1337);
  });

  it("carries BASKETS — the material filter is deliberately not applied", () => {
    // `depositSiteStock` would drop a basket (a yard is a builder's yard);
    // a KIT is a declaration, and founders carry what the spec says (#43).
    const site = foundSite({ seed: 7, at: { x: 0, y: 0 }, stock: { wood: 3, basket: 1 } });
    expect(site.stock).toEqual({ wood: 3, basket: 1 });
  });

  it("ignores a zero or negative entry, and is byte-identical when absent", () => {
    expect(foundSite({ seed: 7, at: { x: 0, y: 0 }, stock: { wood: 0, stone: -4 } }).stock).toEqual({});
    const bare = foundSite({ seed: 7, at: { x: 1, y: 2 }, key: "k", day: 3 });
    const empty = foundSite({ seed: 7, at: { x: 1, y: 2 }, key: "k", day: 3, stock: {} });
    expect(foundedSiteToJSON(empty)).toEqual(foundedSiteToJSON(bare));
  });

  it("survives the durable form unchanged", () => {
    const json = foundedSiteToJSON(SCOPE.site);
    expect(json.stock).toEqual({ wood: 14, stone: 6, basket: 2 });
    const back = createFoundedSite(json, { restS: 0 });
    expect(back.stock).toEqual({ wood: 14, stone: 6, basket: 2 });
    expect(back.stock).toBe(back.deltas.stock);
    expect(foundedSiteToJSON(back)).toEqual(json);
  });
});

// ───────────────────────────────────────────────── ⑥ THE TOWN CONFIG

describe("the town config the founding hands town-play", () => {
  it("is siteTownConfig's own record, with the cell's climate filled in", () => {
    const c = SCOPE.townConfig;
    expect(c.seed).toBe(1337);
    expect(c.key).toBe("frontier");
    expect(c.days).toBe(1);
    expect(c.startPop).toBe(5);
    expect(c.charter).toEqual({ farmland: 516, ore_access: 0, timberland: 302 });
    expect(c.wilderness).toBe(true);
    expect(c.terrain).toBe("planet");
    // C-7: `siteTownConfig` has no climate seat, so the boot fills it — the
    // city loader's own line (city-towns.ts:241-244), replicated once.
    expect(c.climate).toEqual(SCOPE.env.climate);
    // The document's declared scale, resolved.
    expect(c.scale?.gapCompression).toBe(10);
    expect(c.scale?.resourceCompression).toBe(7.5);
    expect(c.scale?.construction).toBe(720);
  });

  it("builds and CERTIFIES a town scope of the shape text mode already runs", () => {
    expect(SCOPE.scope.focus).toBeNull();
    expect(SCOPE.scope.spec.config).toBe(SCOPE.townConfig);
    expect(SCOPE.scope.play.stage).toBeTruthy();
    expect(SCOPE.scope.play.plan).toBeTruthy();
  });
});

// ───────────────────────────────────────────────── ⑦ DETERMINISM & RESTORE

describe("the boot is one definition, however it is reached", () => {
  it("two builds in one process are digest-identical", () => {
    expect(digest(buildPlanetScope(gameOf()))).toBe(digest(SCOPE));
  });

  it("`planetScopeOn` on a substrate the caller already holds gives the same record", () => {
    // The BROWSER's entrance (S3): its geology worker already produced the
    // substrate, so it never re-bakes — it hands it straight in.
    const same = planetScopeOn(
      SCOPE.built,
      { id: SCOPE.body.id, radiusM: SCOPE.body.radiusM },
      { seed: 1337, stock: { wood: 14, stone: 6, basket: 2 }, startPop: 5 },
      gameOf().scale,
    );
    expect(digest(same)).toBe(digest(SCOPE));
  });

  it("a restored site reproduces its cell, charter, environment and partners", () => {
    const restored = buildPlanetScope(gameOf(), {
      restore: { site: foundedSiteToJSON(SCOPE.site), cell: 1_000_001_337, dir: SCOPE.body.dir },
    });
    expect(restored.cell).toBe(SCOPE.cell);
    expect(restored.checksum).toBe(SCOPE.checksum);
    expect(restored.env).toEqual(SCOPE.env);
    expect(restored.site.stock).toEqual(SCOPE.site.stock);
    expect(restored.body).toEqual(SCOPE.body);
    // …and the SAME town config minus `startPop`: a restored site registers
    // at 0 and the host re-registers with the premise's population (the
    // app's own two-step — S3's business, not the engine's).
    expect(restored.townConfig.startPop).toBe(0);
    expect({ ...restored.townConfig, startPop: 0 }).toEqual({ ...SCOPE.townConfig, startPop: 0 });
  });
});

// ───────────────────────────────────────────────── ⑧ THE DECLARED READER

describe("declaredEnvironment — the SAME record, read off a document", () => {
  const full = {
    climate: SCOPE.env.climate,
    biome: 1,
    eco: { tree: 0.24 },
    charter: { farmland: 516, ore_access: 0, timberland: 302 },
    partners: SCOPE.env.partners,
  } as unknown as TownPlayConfig;

  it("returns the record when all five fields are declared", () => {
    const env = declaredEnvironment(full) as SiteEnvironment;
    expect(env.biome).toBe(1);
    expect(env.charter).toEqual({ farmland: 516, ore_access: 0, timberland: 302 });
    expect(env.partners).toEqual(SCOPE.env.partners);
    expect(env.climate).toEqual(SCOPE.env.climate);
  });

  it("returns null when ANY of the five is missing — a half-declared cell is not a cell", () => {
    for (const drop of ["climate", "biome", "eco", "charter", "partners"] as const) {
      const partial = { ...(full as unknown as Record<string, unknown>) };
      delete partial[drop];
      expect(declaredEnvironment(partial as unknown as TownPlayConfig)).toBeNull();
    }
    expect(declaredEnvironment({ seed: 1 } as TownPlayConfig)).toBeNull();
  });
});

// ───────────────────────────────────────────────── ⑨ THE SPEC SAYS THE PREMISE

describe("the solar document's premise fields", () => {
  it("parses the frontier planet's declaration", () => {
    expect(parseSolarWorld(
      { seed: 1337, premise: "founding", premise_stock: { wood: 14, stone: 6, basket: 2 }, premise_population: 5 },
      "game.world",
    )).toEqual({ seed: 1337, premise: "founding", premise_stock: { wood: 14, stone: 6, basket: 2 }, premise_population: 5 });
  });

  it("rejects an unknown premise and a non-positive kit, path-exact", () => {
    expect(() => parseSolarWorld({ seed: 1, premise: "x" }, "game.world"))
      .toThrow("game.world.premise: must be one of: founding");
    expect(() => parseSolarWorld({ seed: 1, premise_stock: { wood: -1 } }, "game.world"))
      .toThrow("game.world.premise_stock.wood: must be a positive integer count");
    expect(() => parseSolarWorld({ seed: 1, premise_population: 0 }, "game.world"))
      .toThrow("game.world.premise_population: out of range (1..50)");
  });

  it("leaves a document that declares none byte-identical", () => {
    expect(parseSolarWorld({ seed: 11 }, "game.world")).toEqual({ seed: 11 });
    expect(parseSolarWorld({}, "game.world")).toEqual({ seed: 1 });
  });

  it("is ONE group, appended (S3b appends the same three to the region)", () => {
    expect(PREMISE_FIELDS.map((f) => f.key)).toEqual(["premise", "premise_stock", "premise_population"]);
    expect(SOLAR_WORLD_FIELDS.fields.map((f) => f.key))
      .toEqual(["seed", "star", "premise", "premise_stock", "premise_population"]);
  });

  it("refuses to boot a system that declares no founding premise", () => {
    const doc = structuredClone(DOC) as { game: { world: Record<string, unknown> } };
    delete doc.game.world.premise;
    expect(() => buildPlanetScope(gameOf(doc)))
      .toThrow('game.world.premise: required — buildPlanetScope boots a founding premise (expected "founding")');
  });
});

// ───────────────────────────────────────────────── ⑩ THE DOCUMENT IS GENERATED

describe("scripts/worlds/frontier-planet.spec.json is GENERATED from the preset", () => {
  it("equals `lowerTreeWorld(preset)` byte for byte", () => {
    // feedback_game_spec_json_is_generated: a hand edit here is silently
    // reverted by the next `npm run world:lower`. This is the gate that says
    // the checked-in document is the preset the browser boots — which it was
    // NOT before this round (a five-settler town at seed 11 wearing a planet's
    // name).
    const preset = TEST_WORLDS.find((w) => w.id === "frontier-planet");
    expect(preset).toBeTruthy();
    // Newlines are normalised and NOTHING else: `core.autocrlf` is true on
    // Windows, and a CRLF checkout is git presenting the same document, not a
    // drift. Every other byte — key order, indentation, the trailing newline —
    // must match the generator exactly.
    const lf = (s: string): string => s.replace(/\r\n/g, "\n");
    expect(lf(RAW_DOC)).toBe(JSON.stringify(lowerTreeWorld(preset!.world), null, 2) + "\n");
  });

  it("declares the solar scope, the premise and the earthlike dials", () => {
    const g = (DOC as { game: Record<string, unknown> }).game;
    expect(g.scope).toBe("solar_system");
    expect(g.world).toEqual({
      seed: 1337, premise: "founding",
      premise_stock: { wood: 14, stone: 6, basket: 2 }, premise_population: 5,
    });
    expect(g.avatar).toBe("spirit");
  });
});
