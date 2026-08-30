/**
 * Game settings — the `game` envelope field of the world manifest
 * (shared/engine/manifest.ts). The game-maker's session shape: scope on
 * the object ladder, the scope-typed world, initial focus, avatar,
 * creative mode. The kernel gates the SHAPE with path-exact refusals;
 * `world`'s deep validation belongs to the scope's builder.
 */
import { describe, it, expect } from "vitest";
import { loadWorldManifest, parseGameSettings, avatarKind, GAME_SCOPES } from "@shared/world-engine/kernel/manifest";

const envelope = (game: unknown): Record<string, unknown> => ({
  engine: "aivota-world",
  engineVersion: 1,
  uses: [],
  packs: [],
  ...(game === undefined ? {} : { game }),
});

describe("game settings — the session shape parses", () => {
  it("a planet game with an ID focus, an avatar, and creative mode", () => {
    const loaded = loadWorldManifest(envelope({
      scope: "planet",
      world: { topology: { kind: "cube-sphere", faceN: 16 }, geologySeed: 7 },
      initial_focus: "town:riverton",
      avatar: true,
      creative_mode: true,
    }), []);
    expect(loaded.game).toEqual({
      scope: "planet",
      world: { topology: { kind: "cube-sphere", faceN: 16 }, geologySeed: 7 },
      initialFocus: "town:riverton",
      avatar: true,
      avatarSpecies: "human",
      mods: [],
      canFly: false,
      creativeMode: true,
      entities: null,
      scale: null,
      transport: null,
      culture: null,
    });
  });

  it("a parameter-set focus: the first matching object wins", () => {
    const loaded = loadWorldManifest(envelope({
      scope: "galaxy",
      world: { seed: 42 },
      initial_focus: { type: "planet", habitable: true },
    }), []);
    expect(loaded.game!.initialFocus).toEqual({ type: "planet", habitable: true });
  });

  it("defaults: no focus (the world itself), no avatar (overview), no creative", () => {
    const loaded = loadWorldManifest(envelope({ scope: "town", world: { seed: 1 } }), []);
    expect(loaded.game).toEqual({
      scope: "town",
      world: { seed: 1 },
      initialFocus: null,
      avatar: false,
      avatarSpecies: "human",
      mods: [],
      canFly: false,
      creativeMode: false,
      entities: null,
      scale: null,
      transport: null,
      culture: null,
    });
  });

  it("avatar_species: defaults to human, or takes an explicit species id", () => {
    const def = loadWorldManifest(envelope({ scope: "town", world: { seed: 1 } }), []);
    expect(def.game!.avatarSpecies).toBe("human");
    const explicit = loadWorldManifest(envelope({
      scope: "town", world: { seed: 1 }, avatar_species: "cow",
    }), []);
    expect(explicit.game!.avatarSpecies).toBe("cow");
  });

  it("avatar kinds: walker / spirit / none — the pilot is a walker with can_fly", () => {
    const mk = (avatar: unknown) => parseGameSettings({ scope: "structure", world: {}, avatar }, "s");
    expect(avatarKind(mk(true))).toBe("walker");
    expect(avatarKind(mk("spirit"))).toBe("spirit");
    expect(avatarKind(mk(false))).toBe("none");
    // "spaceship" was RETIRED: flight is a walker capability, not a kind.
    expect(() => mk("spaceship")).toThrow(/"spaceship" was retired/);
    const flyer = parseGameSettings({ scope: "solar_system", world: {}, avatar: true, can_fly: true }, "s");
    expect(avatarKind(flyer)).toBe("walker");
    expect(flyer.canFly).toBe(true);
    expect(() => parseGameSettings({ scope: "town", world: {}, can_fly: "up" }, "s"))
      .toThrow(/s\.can_fly: must be true or false/);
  });

  it("explicit nulls read as the defaults (avatar: null = whole-area view)", () => {
    const loaded = loadWorldManifest(envelope({
      scope: "structure", world: {}, initial_focus: null, avatar: null,
    }), []);
    expect(loaded.game!.initialFocus).toBeNull();
    expect(loaded.game!.avatar).toBe(false);
  });

  it("every scope rung parses", () => {
    for (const scope of GAME_SCOPES) {
      expect(loadWorldManifest(envelope({ scope, world: {} }), []).game!.scope).toBe(scope);
    }
  });

  it("a document without `game` (or game: null) is a bare content world", () => {
    expect(loadWorldManifest(envelope(undefined), []).game).toBeNull();
    expect(loadWorldManifest(envelope(null), []).game).toBeNull();
  });
});

describe("game settings — reject, never skip", () => {
  const load = (game: unknown) => () => loadWorldManifest(envelope(game), []);

  it("refuses an unknown scope with the ladder in the message", () => {
    expect(load({ scope: "continent", world: {} }))
      .toThrow(/world\.game\.scope: must be one of: structure, town, region, planet, solar_system, star_cluster, galaxy/);
  });

  it("refuses a missing or malformed world", () => {
    expect(load({ scope: "town" })).toThrow(/world\.game\.world: required/);
    expect(load({ scope: "town", world: "cozy" })).toThrow(/world\.game\.world: must be an object/);
    expect(load({ scope: "town", world: [1, 2] })).toThrow(/world\.game\.world: must be an object/);
  });

  it("refuses malformed focus, avatar and creative_mode with exact paths", () => {
    expect(load({ scope: "town", world: {}, initial_focus: 42 }))
      .toThrow(/world\.game\.initial_focus: must be an object ID/);
    expect(load({ scope: "town", world: {}, initial_focus: "" }))
      .toThrow(/world\.game\.initial_focus: an object ID must be a non-empty string/);
    expect(load({ scope: "town", world: {}, avatar: "yes" }))
      .toThrow(/world\.game\.avatar: must be true, "spirit", or null/);
    expect(load({ scope: "town", world: {}, creative_mode: "on" }))
      .toThrow(/world\.game\.creative_mode: must be true or false/);
    expect(load({ scope: "town", world: {}, avatar_species: "" }))
      .toThrow(/world\.game\.avatar_species: must be a non-empty species id string/);
    expect(load({ scope: "town", world: {}, avatar_species: 7 }))
      .toThrow(/world\.game\.avatar_species: must be a non-empty species id string/);
  });

  it("refuses unknown fields inside game, and a non-object game", () => {
    expect(load({ scope: "town", world: {}, dificulty: "hard" }))
      .toThrow(/world\.game\.dificulty: unknown field/);
    expect(load("planet")).toThrow(/world\.game: expected an object/);
    expect(load([])).toThrow(/world\.game: expected an object/);
  });

  it("parseGameSettings is exported for loaders gating bare settings", () => {
    expect(parseGameSettings({ scope: "region", world: { seed: 9 } }, "settings").scope).toBe("region");
    expect(() => parseGameSettings({ scope: "region" }, "settings")).toThrow(/settings\.world: required/);
  });
});

describe("the ladder law — initial_focus must be at or below the scope", () => {
  const settings = (scope: string, focus: unknown): Record<string, unknown> => ({
    scope, world: {}, initial_focus: focus,
  });

  it("a focus below (or at) the scope passes", () => {
    expect(parseGameSettings(settings("town", "house:3"), "g").initialFocus).toBe("house:3");
    expect(parseGameSettings(settings("planet", "site:0"), "g").initialFocus).toBe("site:0");
    expect(parseGameSettings(settings("galaxy", "home"), "g").initialFocus).toBe("home");
    expect(parseGameSettings(settings("solar_system", { type: "planet", kind: "rocky" }), "g").initialFocus)
      .toEqual({ type: "planet", kind: "rocky" });
  });

  it("a focus ABOVE the scope is refused, path-exact", () => {
    expect(() => parseGameSettings(settings("structure", "site:0"), "g"))
      .toThrow(/g\.initial_focus: a structure game cannot focus a town/);
    expect(() => parseGameSettings(settings("planet", "star:1"), "g"))
      .toThrow(/g\.initial_focus: a planet game cannot focus a solar_system/);
    expect(() => parseGameSettings(settings("town", { type: "planet" }), "g"))
      .toThrow(/g\.initial_focus: a town game cannot focus a planet/);
  });

  it("owner-specific vocabulary passes the shape gate (the resolver judges it)", () => {
    expect(parseGameSettings(settings("planet", "town:riverton"), "g").initialFocus).toBe("town:riverton");
    expect(parseGameSettings(settings("structure", "door:west"), "g").initialFocus).toBe("door:west");
    expect(parseGameSettings(settings("region", { minFertility: 40 }), "g").initialFocus)
      .toEqual({ minFertility: 40 });
  });
});
