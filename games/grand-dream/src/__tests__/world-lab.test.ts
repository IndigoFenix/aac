/**
 * World Lab test worlds + the scope builders — every document the lab's
 * dropdown ships must parse through the manifest kernel and build its
 * world (planet: shared/planet/planet-game.ts; town:
 * shared/engine/town/town-game.ts), and the focus/avatar semantics must
 * resolve. The suite is the proving ground; the lab page is the viewer.
 */
import { describe, it, expect } from "vitest";
import { loadWorldManifest, type LoadedWorld } from "@shared/engine/manifest";
import { ECONOMY_MODULE } from "@shared/engine/modules/economy/index";
import { buildPlanetWorld, parsePlanetWorld, resolvePlanetFocus } from "@shared/planet/planet-game";
import { buildTownGame, parseTownWorld } from "@shared/engine/town/town-game";
import { buildRegionWorld, parseRegionWorld } from "@shared/engine/civ/region-game";
import { resolveSiteFocus } from "@shared/engine/cells/site-focus";
import {
  buildGalaxyWorld, resolveGalaxyFocus, buildSolarWorld, resolveSolarFocus,
  parseGalaxyWorld, parseSolarWorld,
} from "@shared/space/space-game";
import { generateSystem } from "@shared/space/solar";
import {
  buildTownScope, parseTownWorld as parseTownScopeWorld,
} from "@shared/symbol-game/town-play-game";
import { buildCreatureQuestWorld, certifyCreatureQuestWorld } from "@shared/symbol-game/creature-quests";
import { TEST_WORLDS, DEFAULT_WORLD_ID } from "../../../world-lab/src/worlds";
import {
  canDescend, descendToSite, solarGameFromStar, planetGameFromPlanet,
} from "../../../world-lab/src/descend";

const load = (doc: unknown, label?: string): LoadedWorld => loadWorldManifest(doc, [ECONOMY_MODULE], label);

describe("world-lab test worlds", () => {
  it("the default is the earthlike planet", () => {
    expect(DEFAULT_WORLD_ID).toBe("earthlike");
    expect(TEST_WORLDS[0].id).toBe("earthlike");
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
          questCount: typeof sw.questCount === "number" ? sw.questCount : 2,
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
    const earth = TEST_WORLDS.find(w => w.id === "earthlike")!;
    const barren = TEST_WORLDS.find(w => w.id === "barren")!;
    const earthBuilt = buildPlanetWorld(load(earth.doc).game!);
    const barrenBuilt = buildPlanetWorld(load(barren.doc).game!);
    expect(earthBuilt.sites.length).toBeGreaterThan(0); // crowds pooled — a civ can land here
    expect(barrenBuilt.sites.length).toBe(0); // nothing settled, nothing lives
  });
});

describe("planet focus — initial_focus resolves against the built world", () => {
  const earth = TEST_WORLDS.find(w => w.id === "earthlike")!;
  const built = buildPlanetWorld(load(earth.doc).game!);

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
    const doc = TEST_WORLDS.find(w => w.id === "galaxy")!.doc;
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
    const g = buildGalaxyWorld(load(TEST_WORLDS.find(w => w.id === "galaxy")!.doc).game!);
    expect(() => resolveGalaxyFocus(g, "nebula:1")).toThrow(/unknown object ID/);
    expect(() => resolveGalaxyFocus(g, `star:${g.stars.length}`)).toThrow(/focusable neighbourhood/);
    const s = buildSolarWorld(load(TEST_WORLDS.find(w => w.id === "solar-orrery")!.doc).game!);
    expect(() => resolveSolarFocus(s, "planet:99")).toThrow(/has \d+ planets/);
    expect(() => resolveSolarFocus(s, { kind: "lava" })).toThrow(/must be "rocky", "gas" or "ice"/);
  });
});

describe("the full descent — galaxy to settlement, one document", () => {
  it("star → system → rocky planet → founding site → town, deterministically", { timeout: 480000 }, () => {
    const doc = TEST_WORLDS.find(w => w.id === "full-descent")!.doc;
    const loaded = load(doc);
    expect(canDescend(loaded)).toBe(true);

    // Rung 1: the galaxy, focused on the home star.
    const g = buildGalaxyWorld(loaded.game!);
    const star = resolveGalaxyFocus(g, loaded.game!.initialFocus)!.star;

    // Rung 2: the star's system — its stellar identity rides down.
    const solarGame = solarGameFromStar(star, true);
    const sys = buildSolarWorld(solarGame);
    expect(sys.system.star.massInit).toBe(star.massInit);
    const planet = resolveSolarFocus(sys, { type: "planet", kind: "rocky" })!.planet;

    // Rung 3: the planet — its seed IS the geology seed.
    const planetGame = planetGameFromPlanet(planet, true);
    const world = buildPlanetWorld(planetGame);
    expect(world.spec.geology.seed).toBe(planet.seed);
    expect(world.sites.length).toBeGreaterThan(0);

    // Rung 4: the settlement at the best site, from the SAME document's packs.
    const site = world.sites[0];
    const a = descendToSite(loaded, world.grid, site);
    const b = descendToSite(loaded, world.grid, site);
    expect(a.plan.houses.length).toBeGreaterThan(0);
    expect(b.plan.houses.length).toBe(a.plan.houses.length);
    expect(b.town.scalar("population")).toBe(a.town.scalar("population"));
  });

  it("gas giants refuse the approach", () => {
    const sys = generateSystem(9);
    const gas = sys.planets.find(p => p.kind === "gas");
    if (gas) expect(() => planetGameFromPlanet(gas, false)).toThrow(/gas giant/);
  });
});

describe("descend — the scope ladder's zoom-in", () => {
  it("a region document with economy packs founds a deterministic town at its focused site", { timeout: 240000 }, () => {
    const doc = TEST_WORLDS.find(w => w.id === "descend")!.doc;
    const loaded = load(doc);
    expect(canDescend(loaded)).toBe(true);
    const built = buildRegionWorld(loaded.game!);
    const focus = resolveSiteFocus(built.grid, built.sites, loaded.game!.initialFocus)!;

    const a = descendToSite(loaded, built.grid, focus.site);
    const b = descendToSite(loaded, built.grid, focus.site);
    // The town is the SITE's town: charter from its box, plan seeded by its cell.
    expect(a.charter.farmland).toBeGreaterThan(0);
    expect(a.startPop).toBeGreaterThanOrEqual(40);
    expect(a.plan.houses.length).toBeGreaterThan(0);
    expect(b.plan.houses.length).toBe(a.plan.houses.length);
    expect(b.town.scalar("population")).toBe(a.town.scalar("population"));
    // A different site founds a different town.
    if (built.sites.length > 1) {
      const c = descendToSite(loaded, built.grid, built.sites[1]);
      expect(c.key).not.toBe(a.key);
    }
  });

  it("a document without economy packs cannot descend", () => {
    const doc = TEST_WORLDS.find(w => w.id === "region")!.doc;
    expect(canDescend(load(doc))).toBe(false);
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
    const focused = load({ ...base, game: { scope: "town", world, initial_focus: "site:0", avatar: true } }).game!;
    expect(() => buildTownScope(focused)).toThrow(/game\.initial_focus: .*village square/);
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
