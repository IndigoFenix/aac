/**
 * World Lab test worlds + the scope builders — every document the lab's
 * dropdown ships must parse through the manifest kernel and build its
 * world (planet: shared/planet/planet-game.ts; town:
 * shared/engine/town/town-game.ts), and the focus/avatar semantics must
 * resolve. The suite is the proving ground; the lab page is the viewer.
 */
import { describe, it, expect } from "vitest";
import { loadWorldManifest, type LoadedWorld } from "@shared/world-engine/kernel/manifest";
import { ECONOMY_MODULE } from "@shared/world-engine/kernel/modules/economy/index";
import { buildPlanetWorld, parsePlanetWorld, resolvePlanetFocus } from "@shared/world-engine/planet/planet-game";
import { buildTownGame, parseTownWorld } from "@shared/world-engine/kernel/town/town-game";
import { buildRegionWorld, parseRegionWorld } from "@shared/world-engine/kernel/civ/region-game";
import { resolveSiteFocus } from "@shared/world-engine/kernel/cells/site-focus";
import {
  buildGalaxyWorld, resolveGalaxyFocus, buildSolarWorld, resolveSolarFocus,
  parseGalaxyWorld, parseSolarWorld,
} from "@shared/world-engine/space/space-game";
import { generateSystem } from "@shared/world-engine/space/solar";
import {
  buildTownScope, parseTownWorld as parseTownScopeWorld,
} from "@shared/world-engine/interaction/town/town-play-game";
import { buildCreatureQuestWorld, certifyCreatureQuestWorld } from "@shared/world-engine/interaction/quest/creature-quests";
import { planetCities } from "@shared/world-engine/planet/cities";
import {
  planetRoutes, caravanArc, caravanCount, CARAVAN_SPEED_MPS,
} from "@shared/world-engine/planet/routes";
import { planetStates, statePairs, stateBorders } from "@shared/world-engine/planet/states";
import { buildTownPlay, buildTownPlayStaged } from "@shared/world-engine/interaction/town/town-play";
import { TEST_WORLDS, DEFAULT_WORLD_ID } from "../../../world-lab/src/worlds";
import { subtractSpans } from "../../../world-lab/src/trade-roads";
import { cityTownConfig } from "../../../world-lab/src/city-towns";
import type { FlightCity } from "../../../world-lab/src/space-fly";
import {
  GROWTH_EPOCH_MS, GROWTH_QUANTUM_MS, GROWN_DAYS_CAP,
  worldGrowthDays, grownDays, grownBuildUp, settlementFootprintM,
  conurbations, conurbationName,
} from "@shared/world-engine/planet/growth";
import type { PlanetCity } from "@shared/world-engine/planet/cities";

const load = (doc: unknown, label?: string): LoadedWorld => loadWorldManifest(doc, [ECONOMY_MODULE], label);

// ENGINE-CAPABILITY FIXTURES: the lab's dropdown ships only verified-working
// demos, but the galaxy/solar/planet BUILDERS remain engine surface — pinned
// here with local documents (the former demo docs) instead of dropdown
// entries.
const FIXTURES: Record<string, Record<string, unknown>> = {
  earthlike: {
    engine: "aivota-world", engineVersion: 1, uses: [], packs: [],
    game: {
      scope: "planet",
      world: {
        topology: { kind: "cube-sphere", faceN: 24 },
        geology: { seed: 7, epochs: 350, continentR: 0.38 },
        settle: true,
        radius: 2000,
      },
      initial_focus: null, avatar: null, creative_mode: false,
    },
  },
  barren: {
    engine: "aivota-world", engineVersion: 1, uses: [], packs: [],
    game: {
      scope: "planet",
      world: {
        topology: { kind: "cube-sphere", faceN: 24 },
        geology: { seed: 3, epochs: 500, continentR: 0.8 },
        settle: false, // no rivers, no fertility — dust and stone
        rain: 0,
        radius: 2000,
        detail: 1.2,
      },
      initial_focus: null, avatar: null, creative_mode: false,
    },
  },
  galaxy: {
    engine: "aivota-world", engineVersion: 1, uses: [], packs: [],
    game: {
      scope: "galaxy",
      world: { seed: 9 }, // probed: a compact 5-arm spiral
      initial_focus: "home", avatar: null, creative_mode: false,
    },
  },
  "solar-orrery": {
    engine: "aivota-world", engineVersion: 1, uses: [], packs: [],
    game: {
      scope: "solar_system",
      world: { seed: 1, star: { massInit: 1, age: 4.6, feh: 0 } },
      initial_focus: "planet:2", avatar: null, creative_mode: false,
    },
  },
};

describe("world-lab test worlds", () => {
  it("the default is the solar-system spirit demo", () => {
    expect(DEFAULT_WORLD_ID).toBe("solar-spirit");
    expect(TEST_WORLDS[0].id).toBe("solar-spirit");
  });

  it("every shipped world parses, builds, and resolves its focus", { timeout: 240000 }, () => {
    for (const w of TEST_WORLDS) {
      const loaded = load(w.doc, w.id);
      expect(loaded.game, w.id).not.toBeNull();
      if (loaded.game!.scope === "planet") {
        const built = buildPlanetWorld(loaded.game!, w.id);
        expect(built.topo.n).toBe(6 * built.spec.topology.faceN ** 2);
        let land = 0;
        let sea = 0;
        for (let c = 0; c < built.topo.n; c++) {
          if (built.grid.fields.height[c] >= 3) land++; else sea++;
        }
        expect(land, w.id).toBeGreaterThan(built.topo.n * 0.1);
        expect(sea, w.id).toBeGreaterThan(built.topo.n * 0.1);
        const focus = resolvePlanetFocus(built, loaded.game!.initialFocus, w.id);
        if (loaded.game!.initialFocus !== null) {
          expect(focus, w.id).not.toBeNull();
          expect(built.sites.some(s => s.cell === focus!.cell), w.id).toBe(true);
        }
      } else if (loaded.game!.scope === "galaxy") {
        const built = buildGalaxyWorld(loaded.game!, w.id);
        expect(built.stars.length, w.id).toBeGreaterThan(0);
        expect(built.universe.homeStar, w.id).toBeDefined();
        const focus = resolveGalaxyFocus(built, loaded.game!.initialFocus, w.id);
        if (loaded.game!.initialFocus !== null) expect(focus, w.id).not.toBeNull();
      } else if (loaded.game!.scope === "solar_system") {
        const built = buildSolarWorld(loaded.game!, w.id);
        expect(built.system.planets.length, w.id).toBeGreaterThanOrEqual(3);
        expect(built.system.star.state.teff, w.id).toBeGreaterThan(0);
        const focus = resolveSolarFocus(built, loaded.game!.initialFocus, w.id);
        if (loaded.game!.initialFocus !== null) expect(focus, w.id).not.toBeNull();
      } else if (loaded.game!.scope === "region") {
        const built = buildRegionWorld(loaded.game!, w.id);
        expect(built.grid.topo.n).toBe(built.spec.size.cols * built.spec.size.rows);
        let land = 0;
        let sea = 0;
        for (let c = 0; c < built.grid.topo.n; c++) {
          if (built.grid.fields.height[c] >= 3) land++; else sea++;
        }
        expect(land, w.id).toBeGreaterThan(built.grid.topo.n * 0.1);
        expect(sea, w.id).toBeGreaterThan(built.grid.topo.n * 0.05);
        expect(built.sites.length, w.id).toBeGreaterThan(0);
        const focus = resolveSiteFocus(built.grid, built.sites, loaded.game!.initialFocus, w.id);
        if (loaded.game!.initialFocus !== null) expect(focus, w.id).not.toBeNull();
      } else if (loaded.game!.scope === "town") {
        // A town is ALWAYS the living town: a real economy whose residents walk
        // the streets, with an optional quest overlay drawn from them.
        // buildTownScope returns only after the greedy-sim playthrough certifies
        // the resident quests are winnable.
        const built = buildTownScope(loaded.game!, w.id);
        expect(built.play.town.scalar("population"), w.id).toBeGreaterThan(0);
        expect(built.play.bundle.cast.length, w.id).toBeGreaterThan(0);
        expect(built.play.bundle.game.entities.length, w.id).toBeGreaterThan(0);
      } else if (loaded.game!.scope === "structure") {
        // A freestanding creature-quest puzzle (played by a walker or a SPIRIT).
        const sw = (loaded.game!.world ?? {}) as Record<string, unknown>;
        const game = buildCreatureQuestWorld({
          seed: typeof sw.seed === "number" ? sw.seed : 1,
          questCount: typeof sw.questCount === "number" ? sw.questCount : 0,
        });
        const cert = certifyCreatureQuestWorld(game);
        expect(cert.ok, w.id).toBe(true);
        expect(game.entities.length, w.id).toBeGreaterThan(0);
      } else {
        throw new Error(`${w.id}: unexpected scope ${loaded.game!.scope}`);
      }
    }
  });

  it("the earthlike world settles into founding candidates; the barren one doesn't", { timeout: 240000 }, () => {
    const earthBuilt = buildPlanetWorld(load(FIXTURES.earthlike).game!);
    const barrenBuilt = buildPlanetWorld(load(FIXTURES.barren).game!);
    expect(earthBuilt.sites.length).toBeGreaterThan(0); // crowds pooled — a civ can land here
    expect(barrenBuilt.sites.length).toBe(0); // nothing settled, nothing lives
  });
});

describe("planet focus — initial_focus resolves against the built world", () => {
  const built = buildPlanetWorld(load(FIXTURES.earthlike).game!);

  it("null focus = the whole planet", () => {
    expect(resolvePlanetFocus(built, null)).toBeNull();
  });

  it("an ID picks a site by rank; a parameter set picks the first match", () => {
    const byId = resolvePlanetFocus(built, "site:0")!;
    expect(byId.cell).toBe(built.sites[0].cell);

    const byParams = resolvePlanetFocus(built, { type: "site", minFertility: 40 })!;
    let fert = 0;
    built.grid.topo.disk(byParams.cell, 3, c => { fert += built.grid.fields.fertility[c]; });
    expect(fert).toBeGreaterThanOrEqual(40);
    // First match wins: no earlier-ranked site also qualifies.
    const rank = built.sites.findIndex(s => s.cell === byParams.cell);
    for (let i = 0; i < rank; i++) {
      let f = 0;
      built.grid.topo.disk(built.sites[i].cell, 3, c => { f += built.grid.fields.fertility[c]; });
      expect(f).toBeLessThan(40);
    }
  });

  it("refuses unknown IDs, out-of-range ranks, unknown params, and unmatchable params", () => {
    expect(() => resolvePlanetFocus(built, "city:3")).toThrow(/game\.initial_focus: unknown object ID/);
    expect(() => resolvePlanetFocus(built, `site:${built.sites.length}`)).toThrow(/settled only/);
    expect(() => resolvePlanetFocus(built, { biome: "swamp" })).toThrow(/game\.initial_focus\.biome: unknown parameter/);
    expect(() => resolvePlanetFocus(built, { minDensity: 1e9 })).toThrow(/no founding site matches/);
  });
});

describe("space scopes — the top of the ladder", () => {
  it("a galaxy's focusable neighbourhood is deterministic, home first", () => {
    const doc = FIXTURES.galaxy;
    const a = buildGalaxyWorld(load(doc).game!);
    const b = buildGalaxyWorld(load(doc).game!);
    expect(a.stars.length).toBe(b.stars.length);
    expect(a.stars[0].id).toBe(b.stars[0].id);
    expect(a.stars[0].id).toBe(a.universe.homeStar.id); // rank 0 = home
    expect(resolveGalaxyFocus(a, "home")!.star.id).toBe(a.universe.homeStar.id);
  });

  it("a system is deterministic stellar physics: same seed, same planets", () => {
    const a = generateSystem(1337);
    const b = generateSystem(1337);
    expect(a.planets.map(p => [p.kind, p.orbitAU, p.seed])).toEqual(
      b.planets.map(p => [p.kind, p.orbitAU, p.seed]));
    expect(a.star.state.luminosity).toBe(b.star.state.luminosity);
    // Pinning the star (galaxy → system) reproduces its stellar state.
    const pinned = generateSystem(7, { star: { massInit: 1, age: 4.6, feh: 0 } });
    expect(pinned.star.state.phase).toBe("main_sequence");
    expect(pinned.star.state.teff).toBeGreaterThan(4000);
    expect(pinned.star.state.teff).toBeLessThan(7000);
  });

  it("space specs and focus refuse, never skip", () => {
    expect(() => parseGalaxyWorld({ blackHoles: 3 }, "w")).toThrow(/w\.blackHoles: unknown field/);
    expect(() => parseSolarWorld({ star: { color: "red" } }, "w")).toThrow(/w\.star\.color: unknown field/);
    const g = buildGalaxyWorld(load(FIXTURES.galaxy).game!);
    expect(() => resolveGalaxyFocus(g, "nebula:1")).toThrow(/unknown object ID/);
    expect(() => resolveGalaxyFocus(g, `star:${g.stars.length}`)).toThrow(/focusable neighbourhood/);
    const s = buildSolarWorld(load(FIXTURES["solar-orrery"]).game!);
    expect(() => resolveSolarFocus(s, "planet:99")).toThrow(/has \d+ planets/);
    expect(() => resolveSolarFocus(s, { kind: "lava" })).toThrow(/must be "rocky", "gas" or "ice"/);
  });
});

describe("region world spec — reject, never skip", () => {
  it("refuses unknown fields and out-of-range sizes with exact paths", () => {
    expect(() => parseRegionWorld({ biomes: [] }, "w")).toThrow(/w\.biomes: unknown field/);
    expect(() => parseRegionWorld({ size: { cols: 4 } }, "w")).toThrow(/w\.size\.cols: out of range/);
    expect(() => parseRegionWorld({ size: { depth: 2 } }, "w")).toThrow(/w\.size\.depth: unknown field/);
    expect(() => parseRegionWorld({ geology: { magma: 1 } }, "w")).toThrow(/w\.geology\.magma: unknown field/);
  });

  it("refuses to build a non-region game", () => {
    const game = load({
      engine: "aivota-world", engineVersion: 1, uses: [], packs: [],
      game: { scope: "planet", world: {} },
    }).game!;
    expect(() => buildRegionWorld(game)).toThrow(/game\.scope: buildRegionWorld builds "region" games/);
  });
});

describe("town world spec — reject, never skip", () => {
  it("refuses unknown fields and bad values with exact paths", () => {
    expect(() => parseTownWorld({ mayor: "bob" }, "w")).toThrow(/w\.mayor: unknown field/);
    expect(() => parseTownWorld({ days: 0 }, "w")).toThrow(/w\.days: out of range/);
    expect(() => parseTownWorld({ charter: { gold: 5 } }, "w")).toThrow(/w\.charter\.gold: unknown field/);
    expect(() => parseTownWorld({ seedScalars: { farms: "one" } }, "w")).toThrow(/w\.seedScalars\.farms: must be a number/);
  });

  it("a town world without an economy pack refuses to build", () => {
    const loaded = load({
      engine: "aivota-world", engineVersion: 1, uses: [], packs: [],
      game: { scope: "town", world: {} },
    });
    expect(() => buildTownGame(loaded)).toThrow(/needs an economy/);
  });

});

describe("town scope — a town is always the living town", () => {
  it("refuses unknown fields, a missing seed, and spectator/focused play", () => {
    expect(() => parseTownScopeWorld({ mayor: "bob" }, "w")).toThrow(/w\.mayor: unknown field/);
    expect(() => parseTownScopeWorld({ questCount: 2 }, "w")).toThrow(/w\.seed: required/);
    expect(() => parseTownScopeWorld({ seed: 1, questCount: 9 }, "w")).toThrow(/w\.questCount: out of range/);
    expect(() => parseTownScopeWorld({ seed: 1, syntax: "z" }, "w")).toThrow(/w\.syntax: must be one of/);

    const world = { seed: 7, questCount: 1 };
    const base = { engine: "aivota-world", engineVersion: 1, uses: [], packs: [] };
    const spectate = load({ ...base, game: { scope: "town", world, avatar: null } }).game!;
    expect(() => buildTownScope(spectate)).toThrow(/game\.avatar: .*embodied/);
    // initial_focus now frames the dollhouse (house IDs) — anything else
    // is still refused, with the town's ID vocabulary in the message.
    const focused = load({ ...base, game: { scope: "town", world, initial_focus: "site:0", avatar: true } }).game!;
    expect(() => buildTownScope(focused)).toThrow(/game\.initial_focus: unknown object ID .*house:<index>/);
    const notTown = load({ ...base, game: { scope: "planet", world: {}, avatar: true } }).game!;
    expect(() => buildTownScope(notTown)).toThrow(/game\.scope: buildTownScope builds "town" games/);
  });

  it("one seed reproduces the whole town; its resident quests certify", { timeout: 120000 }, () => {
    const doc = TEST_WORLDS.find(w => w.id === "village")!.doc;
    const a = buildTownScope(load(doc).game!);
    const b = buildTownScope(load(doc).game!);
    // Deterministic end to end: same seed ⇒ same town, plan, and quests.
    expect(b.play.town.scalar("population")).toBe(a.play.town.scalar("population"));
    expect(b.play.plan.houses.length).toBe(a.play.plan.houses.length);
    expect(JSON.stringify(b.play.bundle.game)).toBe(JSON.stringify(a.play.bundle.game));
    // The quest-givers are the town's real residents (drawn from its cast).
    expect(a.play.bundle.cast.length).toBeGreaterThan(0);
  });
});

describe("planet cities — a settled world's founding sites become its cities", () => {
  const earthDoc = FIXTURES.earthlike;
  const built = buildPlanetWorld(load(earthDoc).game!);

  it("founds deterministic, named, self-feeding cities on real sites", () => {
    const a = planetCities(built);
    const b = planetCities(built);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a)); // an address, not a session artifact

    expect(a.length).toBeGreaterThan(1); // MANY cities — the demo's whole point
    expect(a.length).toBeLessThanOrEqual(built.sites.length); // uncapped, but only real sites
    expect(new Set(a.map(c => c.name)).size).toBe(a.length); // unique names
    for (const city of a) {
      expect(built.sites.some(s => s.cell === city.cell), city.name).toBe(true);
      const [x, y, z] = city.dir;
      expect(Math.abs(Math.hypot(x, y, z) - 1), city.name).toBeLessThan(1e-6);
      expect(city.charter.farmland, city.name).toBeGreaterThanOrEqual(40); // it can feed itself
      expect(city.startPop, city.name).toBeGreaterThanOrEqual(40);
      expect(city.startPop, city.name).toBeLessThanOrEqual(2000);
      expect(city.name).toMatch(/^[A-Z]/);
    }
  });

  it("the cap and the farmland floor hold", () => {
    const few = planetCities(built, { maxCities: 3 });
    expect(few.length).toBeLessThanOrEqual(3);
    const rich = planetCities(built, { minFarmland: 1e9 });
    expect(rich.length).toBe(0); // nothing can charter that much — no cities
  });

  it("the founding spec sets settlement density (map defaults were capital-spaced)", { timeout: 240000 }, () => {
    const dense = buildPlanetWorld(load({
      ...earthDoc,
      game: {
        ...(earthDoc.game as Record<string, unknown>),
        world: {
          ...((earthDoc.game as Record<string, unknown>).world as Record<string, unknown>),
          founding: { threshold: 60, radius: 2, minSpacing: 2, maxHarvest: 600 },
        },
      },
    }).game!);
    // Halving the spacing more than doubles the candidates — density is a
    // real knob now, not a hard-coded constant.
    expect(dense.sites.length).toBeGreaterThan(built.sites.length * 2);
    expect(planetCities(dense).length).toBeGreaterThan(planetCities(built).length * 2);
  });

  it("founding spec refuses unknown fields and bad ranges", () => {
    expect(() => parsePlanetWorld({ founding: { spacing: 2 } }, "w")).toThrow(/w\.founding\.spacing: unknown field/);
    expect(() => parsePlanetWorld({ founding: { minSpacing: 0 } }, "w")).toThrow(/w\.founding\.minSpacing: out of range/);
  });

  describe("intercity routes — the capitals join into a road net", () => {
    const cities = planetCities(built);
    const routes = planetRoutes(built, cities);

    it("joins real cities with well-formed surface polylines, deterministically", () => {
      expect(routes.length).toBeGreaterThan(0);
      // PURE: deriving the net again (any client, any time) yields the SAME
      // net — the grid is never mutated by the derivation.
      expect(JSON.stringify(planetRoutes(built, cities))).toBe(JSON.stringify(routes));

      const cells = new Set(cities.map(c => c.cell));
      for (const r of routes) {
        expect(cells.has(r.a)).toBe(true);
        expect(cells.has(r.b)).toBe(true);
        expect(r.dirs.length).toBeGreaterThanOrEqual(2);
        expect(r.cum.length).toBe(r.dirs.length);
        expect(r.cum[0]).toBe(0);
        for (let i = 1; i < r.cum.length; i++) {
          expect(r.cum[i]).toBeGreaterThanOrEqual(r.cum[i - 1]!);
        }
        expect(r.lengthM).toBeCloseTo(r.cum[r.cum.length - 1]!, 6);
        expect(r.lengthM).toBeGreaterThan(0);
        for (const d of r.dirs) {
          expect(Math.abs(Math.hypot(d[0], d[1], d[2]) - 1)).toBeLessThan(1e-6);
        }
        // Endpoints pinned to the cities' own cell directions.
        const cityA = cities.find(c => c.cell === r.a)!;
        const cityB = cities.find(c => c.cell === r.b)!;
        expect(r.dirs[0]).toEqual(cityA.dir);
        expect(r.dirs[r.dirs.length - 1]).toEqual(cityB.dir);
      }
    });

    it("caravans are a closed form of the clock — bounded, shared, and moving at pace", () => {
      const r = routes[0]!;
      expect(caravanCount(r)).toBeGreaterThanOrEqual(2);
      for (const t of [0, 1234.5, 86_400, 1e8]) {
        const arc = caravanArc(r, 0, t);
        expect(arc.s).toBeGreaterThanOrEqual(0);
        expect(arc.s).toBeLessThanOrEqual(r.lengthM);
        expect(Math.abs(arc.sign)).toBe(1);
      }
      // Same clock, same cart — the multiplayer law needs no wire.
      expect(caravanArc(r, 1, 777)).toEqual(caravanArc(r, 1, 777));
      // Between turnarounds it travels at the advertised pace.
      const t0 = 5000;
      const p0 = caravanArc(r, 0, t0);
      const p1 = caravanArc(r, 0, t0 + 10);
      if (p0.sign === p1.sign) {
        expect(Math.abs(p1.s - p0.s)).toBeCloseTo(CARAVAN_SPEED_MPS * 10, 6);
      }
    });
  });

  describe("clock-anchored growth — the civilization ages on the world clock", () => {
    const mkCity = (over: Partial<PlanetCity>): PlanetCity => ({
      cell: 1, name: "Testford", dir: [1, 0, 0], density: 400,
      charter: { farmland: 100, ore_access: 10, timberland: 20 },
      startPop: 400,
      ...over,
    });

    it("growth is quantized, monotone, and capped for founding", () => {
      expect(worldGrowthDays(GROWTH_EPOCH_MS - 1)).toBe(0); // the era hasn't begun
      expect(worldGrowthDays(GROWTH_EPOCH_MS)).toBe(0);
      expect(worldGrowthDays(GROWTH_EPOCH_MS + GROWTH_QUANTUM_MS)).toBe(1);
      // Within one quantum every client derives the SAME day count.
      expect(worldGrowthDays(GROWTH_EPOCH_MS + GROWTH_QUANTUM_MS + 1))
        .toBe(worldGrowthDays(GROWTH_EPOCH_MS + 2 * GROWTH_QUANTUM_MS - 1));
      // Founding age caps; the base always rides on top.
      const far = GROWTH_EPOCH_MS + 10_000 * GROWTH_QUANTUM_MS;
      expect(grownDays(220, far)).toBe(220 + GROWN_DAYS_CAP);
      expect(grownDays(220, GROWTH_EPOCH_MS)).toBe(220);
    });

    it("a village spreads, a city rises: buildUp waits out the spread phase then climbs, bounded", () => {
      const dense = 400;
      const hamlet = 40;
      expect(grownBuildUp(dense, GROWTH_EPOCH_MS)).toBe(0); // young towns are flat
      const later = GROWTH_EPOCH_MS + 300 * GROWTH_QUANTUM_MS;
      const far = GROWTH_EPOCH_MS + 100_000 * GROWTH_QUANTUM_MS;
      expect(grownBuildUp(dense, later)).toBeGreaterThan(0);
      expect(grownBuildUp(dense, later)).toBeGreaterThanOrEqual(grownBuildUp(hamlet, later));
      expect(grownBuildUp(dense, far)).toBeLessThanOrEqual(3);
      // The town spec's validator allows at most 4 storeys — never exceed it.
      expect(grownBuildUp(1e9, far)).toBeLessThanOrEqual(4);
    });

    it("footprints sprawl without the founding cap, bounded at metropolis scale", () => {
      const c = mkCity({});
      const f0 = settlementFootprintM(c, GROWTH_EPOCH_MS);
      const f1 = settlementFootprintM(c, GROWTH_EPOCH_MS + 1000 * GROWTH_QUANTUM_MS);
      const fFar = settlementFootprintM(c, GROWTH_EPOCH_MS + 1_000_000 * GROWTH_QUANTUM_MS);
      expect(f0).toBeGreaterThan(0);
      expect(f1).toBeGreaterThan(f0 + 1000); // sprawl outruns the founding cap
      expect(fFar).toBeLessThanOrEqual(15_000);
      // Denser settlements sprawl faster.
      const thin = mkCity({ density: 40, startPop: 40 });
      expect(settlementFootprintM(thin, GROWTH_EPOCH_MS + 1000 * GROWTH_QUANTUM_MS)).toBeLessThan(f1);
    });

    it("conurbation: two dense neighbours a day's walk apart merge about a year in — the metropolis outcome", () => {
      const R = 6_370_000;
      const sep = 24_000 / R; // 24 km apart, in radians
      const a = mkCity({ cell: 1, name: "Velford", dir: [1, 0, 0] });
      const b = mkCity({ cell: 2, name: "Marburg", dir: [Math.cos(sep), Math.sin(sep), 0], density: 410 });
      const farAway = mkCity({ cell: 3, name: "Umbrige", dir: [0, 0, 1] });
      const young = conurbations([a, b, farAway], R, GROWTH_EPOCH_MS);
      expect(young).toEqual([]); // nothing merges on day one
      const yearIn = GROWTH_EPOCH_MS + 366 * 24 * 3600 * 1000;
      const grown = conurbations([a, b, farAway], R, yearIn);
      expect(grown).toEqual([[0, 1]]); // the dense pair — and ONLY the pair
      // The shared name leads with the denser partner, on every client.
      expect(conurbationName(a, b)).toBe("Greater Marburg–Velford");
      expect(conurbationName(b, a)).toBe("Greater Marburg–Velford");
    });

    it("the visit config ages with the clock — same quantum, same town", () => {
      const fc = { city: mkCity({ cell: 77, name: "Velford" }) } as FlightCity;
      const t0 = GROWTH_EPOCH_MS + 5 * GROWTH_QUANTUM_MS;
      const c0 = cityTownConfig(fc, t0);
      const c0b = cityTownConfig(fc, t0 + GROWTH_QUANTUM_MS - 1);
      expect(c0b).toEqual(c0); // within a quantum, every client founds the same town
      const later = cityTownConfig(fc, GROWTH_EPOCH_MS + 400 * GROWTH_QUANTUM_MS);
      expect(later.days!).toBeGreaterThan(c0.days!); // it grew
      expect(later.buildUp!).toBeGreaterThan(c0.buildUp ?? 0); // and it rose
      expect(later.days!).toBeLessThanOrEqual(220 + GROWN_DAYS_CAP);
    });
  });

  describe("near-window span subtraction (highway overrides)", () => {
    it("cuts override intervals out of drawn spans, exactly", () => {
      // No cuts → unchanged.
      expect(subtractSpans([[0, 100]], [])).toEqual([[0, 100]]);
      // A middle cut splits.
      expect(subtractSpans([[0, 100]], [{ s0: 40, s1: 60 }])).toEqual([[0, 40], [60, 100]]);
      // Edge cuts trim.
      expect(subtractSpans([[0, 100]], [{ s0: 0, s1: 30 }])).toEqual([[30, 100]]);
      expect(subtractSpans([[0, 100]], [{ s0: 70, s1: 100 }])).toEqual([[0, 70]]);
      // A covering cut deletes; a disjoint cut is a no-op.
      expect(subtractSpans([[10, 20]], [{ s0: 0, s1: 30 }])).toEqual([]);
      expect(subtractSpans([[10, 20]], [{ s0: 30, s1: 40 }])).toEqual([[10, 20]]);
      // Multiple spans × multiple cuts compose.
      expect(subtractSpans(
        [[0, 50], [60, 100]],
        [{ s0: 20, s1: 70 }, { s0: 90, s1: 95 }],
      )).toEqual([[0, 20], [70, 90], [95, 100]]);
    });
  });

  describe("states — the capitals claim territory by travel cost", () => {
    const cities = planetCities(built);
    const states = planetStates(built, cities);

    it("claims deterministically: every capital owns its seat, land beyond the seats", () => {
      const again = planetStates(built, cities);
      expect(Array.from(again.stateOf)).toEqual(Array.from(states.stateOf));
      expect(again.adjacency).toEqual(states.adjacency);

      cities.forEach((c, i) => expect(states.stateOf[c.cell]).toBe(i));
      let claimed = 0;
      for (let i = 0; i < states.stateOf.length; i++) {
        const s = states.stateOf[i]!;
        expect(s).toBeLessThan(cities.length);
        if (s >= 0) { claimed++; expect(Number.isFinite(states.costM[i])).toBe(true); }
        else expect(states.costM[i]).toBe(Infinity); // unclaimed = unreachable
      }
      expect(claimed).toBeGreaterThan(cities.length); // territory, not just seats
    });

    it("adjacency is a real border graph: ordered, crossing-priced, with border cells to match", () => {
      expect(states.adjacency.length).toBeGreaterThan(0);
      const borderStates = new Set(states.borderCells.map(([a, b]) => {
        const sa = states.stateOf[a]!;
        const sb = states.stateOf[b]!;
        return `${Math.min(sa, sb)}:${Math.max(sa, sb)}`;
      }));
      for (const adj of states.adjacency) {
        expect(adj.a).toBeLessThan(adj.b);
        // Infinity is honest: a sea-locked seed borders its neighbour with
        // no passable crossing (statePairs is where traversability gates).
        expect(adj.costM).toBeGreaterThan(0);
        expect(borderStates.has(`${adj.a}:${adj.b}`)).toBe(true);
      }
      // Every bordering pair is in the adjacency — nothing dropped silently.
      expect(borderStates.size).toBe(states.adjacency.length);
      // And the world is mostly traversable — Infinity is the exception.
      const passable = states.adjacency.filter(x => Number.isFinite(x.costM));
      expect(passable.length).toBeGreaterThan(0);
    });

    it("borders drape as unit polylines, deterministically", () => {
      const borders = stateBorders(built, states);
      expect(borders.length).toBeGreaterThan(0);
      for (const line of borders) {
        expect(line.length).toBeGreaterThanOrEqual(2);
        for (const d of line) {
          expect(Math.abs(Math.hypot(d[0], d[1], d[2]) - 1)).toBeLessThan(1e-6);
        }
      }
      expect(JSON.stringify(stateBorders(built, states))).toBe(JSON.stringify(borders));
    });

    it("statePairs keeps the neighbour graph but caps the wasteland crossings", () => {
      const pairs = statePairs(states);
      expect(pairs.length).toBeGreaterThan(0);
      expect(pairs.length).toBeLessThanOrEqual(states.adjacency.length);
      const byKey = new Map(states.adjacency.map(x => [`${x.a}:${x.b}`, x.costM]));
      for (const [a, b] of pairs) {
        // Every pair is a real adjacency AND a passable one — a route the
        // Dijkstra can actually pave.
        expect(Number.isFinite(byKey.get(`${a}:${b}`))).toBe(true);
      }
      // A tighter cap can only prune harder.
      expect(statePairs(states, { maxCostFactor: 1 }).length).toBeLessThanOrEqual(pairs.length);
    });

    it("adjacency topology routes join exactly the adjacent capitals", () => {
      const pairs = statePairs(states);
      const routes = planetRoutes(built, cities, { pairs });
      expect(routes.length).toBeGreaterThan(0);
      expect(routes.length).toBeLessThanOrEqual(pairs.length);
      const wanted = new Set(pairs.map(([i, j]) => {
        const a = cities[i]!.cell;
        const b = cities[j]!.cell;
        return a < b ? `${a}:${b}` : `${b}:${a}`;
      }));
      for (const r of routes) {
        const key = r.a < r.b ? `${r.a}:${r.b}` : `${r.b}:${r.a}`;
        expect(wanted.has(key)).toBe(true);
      }
    });
  });
});

describe("landing in a city — the flight→town join", () => {
  it("a city's config founds ITS town (site charter, crowd, cell-seed), deterministically", { timeout: 240000 }, () => {
    const built = buildPlanetWorld(load(FIXTURES.earthlike).game!);
    const city = planetCities(built)[0];

    const config = {
      seed: city.cell,
      key: city.name.toLowerCase().replace(/\s+/g, "-"),
      charter: city.charter,
      startPop: city.startPop,
      questCount: 1,
    };
    const a = buildTownPlay(config);
    const b = buildTownPlay(config);
    expect(a.town.scalar("population")).toBeGreaterThan(0);
    expect(b.town.scalar("population")).toBe(a.town.scalar("population"));
    expect(b.plan.houses.length).toBe(a.plan.houses.length);
    expect(JSON.stringify(b.bundle.game)).toBe(JSON.stringify(a.bundle.game));
    // The quest overlay drawn from the city's residents proves itself.
    expect(certifyCreatureQuestWorld(a.bundle.game).ok).toBe(true);
    // And it is the CITY's town, not brookmill: the key names the plan.
    expect(a.plan.key).toBe(config.key);
  });

  it("the brookmill default is untouched — a bare config still builds the standalone village", { timeout: 240000 }, () => {
    const play = buildTownPlay({ seed: 7, days: 220, questCount: 1 });
    expect(play.plan.key).toBe("brookmill");
    expect(play.town.scalar("population")).toBeGreaterThan(0);
  });

  it("the staged builder (approach-load) is byte-identical to the sync one", { timeout: 240000 }, async () => {
    const config = { seed: 7, days: 220, questCount: 1 as const };
    const sync = buildTownPlay(config);
    const notes: string[] = [];
    const staged = await buildTownPlayStaged(config, n => { notes.push(n); });
    expect(staged.town.scalar("population")).toBe(sync.town.scalar("population"));
    expect(staged.plan.houses.length).toBe(sync.plan.houses.length);
    expect(JSON.stringify(staged.bundle.game)).toBe(JSON.stringify(sync.bundle.game));
    // The stages actually reported (the flight status rides these). The
    // founding yields FINE steps now (plan/stage generators) — the stage's
    // furniture batches close it out.
    expect(notes[0]).toBe("chartering");
    expect(notes).toContain("laying streets");
    expect(notes).toContain("raising the town");
    expect(notes[notes.length - 1]).toBe("furnishing homes");
  });
});

describe("planet world spec — reject, never skip", () => {
  it("refuses unknown fields, bad lattices and out-of-range numbers with exact paths", () => {
    expect(() => parsePlanetWorld({ oceans: 3 }, "w")).toThrow(/w\.oceans: unknown field/);
    expect(() => parsePlanetWorld({ topology: { kind: "flat" } }, "w")).toThrow(/w\.topology\.kind/);
    expect(() => parsePlanetWorld({ topology: { kind: "cube-sphere", faceN: 0 } }, "w")).toThrow(/w\.topology\.faceN: out of range/);
    expect(() => parsePlanetWorld({ geology: { seed: 1, magma: true } }, "w")).toThrow(/w\.geology\.magma: unknown field/);
    expect(() => parsePlanetWorld({ radius: -5 }, "w")).toThrow(/w\.radius: out of range/);
    expect(() => parsePlanetWorld({ settle: "yes" }, "w")).toThrow(/w\.settle: must be true or false/);
  });

  it("an empty world object is a valid planet (all defaults)", () => {
    const spec = parsePlanetWorld({}, "w");
    expect(spec).toEqual({
      topology: { kind: "cube-sphere", faceN: 24 },
      geology: { seed: 1, epochs: 350 },
      settle: true,
      rain: 1,
      radius: 2000,
      relief: 0.005,
      detail: 0.6,
    });
  });

  it("refuses to build a non-planet game", () => {
    const game = load({
      engine: "aivota-world", engineVersion: 1, uses: [], packs: [],
      game: { scope: "town", world: {} },
    }).game!;
    expect(() => buildPlanetWorld(game)).toThrow(/game\.scope: buildPlanetWorld builds "planet" games/);
  });
});
