/**
 * The lab's test-game registry — every entry is a COMPLETE aivota-world
 * document (manifest envelope + `game` settings). Selecting one in the
 * dropdown loads it into the world file; the lab boots whatever the file
 * says, so editing the JSON is the whole modding loop.
 *
 * Data only (the one import is the symbol game's village economy CONTENT,
 * inlined into the town document's packs — one JSON is the whole game):
 * the grand-dream test suite imports this file to pin that every shipped
 * test world actually parses and builds.
 */
import { TOWN_PLAY_ECONOMY } from "@shared/symbol-game/town-play";

export interface TestWorld {
  id: string;
  name: string;
  doc: Record<string, unknown>;
}

export const TEST_WORLDS: TestWorld[] = [
  {
    id: "earthlike",
    name: "Earthlike Planet",
    doc: {
      engine: "aivota-world",
      engineVersion: 1,
      uses: [],
      game: {
        scope: "planet",
        world: {
          topology: { kind: "cube-sphere", faceN: 24 },
          geology: { seed: 7, epochs: 350, continentR: 0.38 },
          settle: true,
          radius: 2000,
        },
        initial_focus: null,
        avatar: null,
        creative_mode: false,
      },
      packs: [],
    },
  },
  {
    id: "archipelago",
    name: "Archipelago Planet",
    doc: {
      engine: "aivota-world",
      engineVersion: 1,
      uses: [],
      game: {
        scope: "planet",
        world: {
          topology: { kind: "cube-sphere", faceN: 24 },
          geology: { seed: 11, epochs: 400, continentR: 0.25, plates: 7 },
          settle: true,
          radius: 2000,
        },
        initial_focus: null,
        avatar: null,
        creative_mode: false,
      },
      packs: [],
    },
  },
  {
    id: "focus-site",
    name: "Planet: Best Farmland (avatar)",
    doc: {
      engine: "aivota-world",
      engineVersion: 1,
      uses: [],
      game: {
        scope: "planet",
        world: {
          topology: { kind: "cube-sphere", faceN: 24 },
          geology: { seed: 7, epochs: 350, continentR: 0.38 },
          settle: true,
          radius: 2000,
        },
        // The first founding site with real farmland in its charter box —
        // the camera flies there and the avatar stands on it.
        initial_focus: { type: "site", minFertility: 40 },
        avatar: true,
        creative_mode: false,
      },
      packs: [],
    },
  },
  {
    id: "galaxy",
    name: "Spiral Galaxy",
    doc: {
      engine: "aivota-world",
      engineVersion: 1,
      uses: [],
      game: {
        scope: "galaxy",
        world: { seed: 9 }, // probed: a compact 5-arm spiral
        initial_focus: "home",
        avatar: null,
        creative_mode: false,
      },
      packs: [],
    },
  },
  {
    id: "solar",
    name: "Solar System (default: real Sol, flight)",
    doc: {
      engine: "aivota-world",
      engineVersion: 1,
      uses: [],
      game: {
        // THE DEFAULT solar_system game: the ported seagull stack at real scale.
        // A bare solar_system document (no `star` spec, no planet `initial_focus`)
        // flies the real home Sol in a ship — spawn on the most habitable world
        // (Earth), steer with the mouse, wheel = speed. Every body bakes its real
        // geography as it grows past ~1px, and you can fly star to star.
        // `world.seed` picks the system; 1337 = the pinned home Sol.
        scope: "solar_system",
        world: { seed: 1337 },
        initial_focus: null,
        avatar: "spaceship",
        creative_mode: false,
      },
      packs: [],
    },
  },
  {
    id: "solar-orrery",
    name: "Solar System (orrery: browse + descend)",
    doc: {
      engine: "aivota-world",
      engineVersion: 1,
      uses: [],
      game: {
        scope: "solar_system",
        // OPT-IN orrery view (pinning a `star` spec selects it): a compact map
        // of the system you browse from outside and DESCEND into a planet. A
        // pinned sun (the IMF would hand us a red dwarf 4 times in 5); planet-seed
        // 1 rolls a solar analogue with a temperate world at 1.01 AU — planet:2,
        // where we point the focus.
        world: { seed: 1, star: { massInit: 1, age: 4.6, feh: 0 } },
        initial_focus: "planet:2",
        avatar: null,
        creative_mode: false,
      },
      packs: [],
    },
  },
  {
    id: "full-descent",
    name: "Galaxy → Settlement (full descent)",
    doc: {
      engine: "aivota-world",
      engineVersion: 1,
      uses: ["economy"],
      game: {
        scope: "galaxy",
        world: { seed: 9 },
        // The whole ladder in one document: focus the home star, descend
        // into its system, approach a rocky world, land at a founding
        // site, found the settlement — the economy packs below are what
        // the settlement produces and eats.
        initial_focus: "home",
        avatar: true,
        creative_mode: false,
      },
      packs: [{ name: "village", economy: TOWN_PLAY_ECONOMY }],
    },
  },
  {
    id: "region",
    name: "Tectonic Region (flat map)",
    doc: {
      engine: "aivota-world",
      engineVersion: 1,
      uses: [],
      game: {
        scope: "region",
        world: {
          size: { cols: 96, rows: 64 },
          geology: { seed: 7, epochs: 350 },
          settle: true,
        },
        initial_focus: null,
        avatar: null,
        creative_mode: false,
      },
      packs: [],
    },
  },
  {
    id: "descend",
    name: "Region → Settlement (descend)",
    doc: {
      engine: "aivota-world",
      engineVersion: 1,
      uses: ["economy"],
      game: {
        scope: "region",
        world: {
          size: { cols: 96, rows: 64 },
          geology: { seed: 7, epochs: 350 },
          settle: true,
        },
        // The best-crowded site — and because this document ALSO ships
        // town-level economy content, the lab can DESCEND into it: the
        // site's charter founds the settlement, one button down.
        initial_focus: "site:0",
        avatar: true,
        creative_mode: false,
      },
      packs: [{ name: "village", economy: TOWN_PLAY_ECONOMY }],
    },
  },
  {
    id: "village",
    name: "Riverside Village (town)",
    doc: {
      engine: "aivota-world",
      engineVersion: 1,
      uses: [],
      game: {
        // A town is ALWAYS living (there is no separate "living-town" type — see
        // docs/TOWN_AND_NPCS.md): a real createTownWorld economy whose residents
        // walk the streets and whom you meet by walking up and dwelling to talk.
        // The optional quest overlay draws its givers from those residents. Walk
        // with the mouse; answer on the REAL response board (shared/symbol-game).
        scope: "town",
        world: { seed: 7, days: 220, questCount: 2, syntax: "b", locale: "en" },
        initial_focus: null,
        avatar: true,
        creative_mode: false,
      },
      packs: [],
    },
  },
  {
    id: "barren",
    name: "Barren Planet",
    doc: {
      engine: "aivota-world",
      engineVersion: 1,
      uses: [],
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
        initial_focus: null,
        avatar: null,
        creative_mode: false,
      },
      packs: [],
    },
  },
  {
    id: "spirit-puzzle",
    name: "Spirit Puzzle (structure)",
    doc: {
      engine: "aivota-world",
      engineVersion: 1,
      uses: [],
      game: {
        // A freestanding creature-quest puzzle played as a SPIRIT: stationary,
        // formless, no walking — look at an item to pick it up / put it down,
        // look at someone to talk. The simplified puzzle mode (avatar "spirit").
        scope: "structure",
        world: { seed: 3, questCount: 2 },
        initial_focus: null,
        avatar: "spirit",
        creative_mode: false,
      },
      packs: [],
    },
  },
  {
    id: "household",
    name: "Household (one building)",
    doc: {
      engine: "aivota-world",
      engineVersion: 1,
      uses: [],
      game: {
        // The one-building household: the same creature-quest puzzle mapped onto
        // a SINGLE building (a central hall with each helper a color room off
        // it) instead of a village of separate houses. Played as a SPIRIT.
        scope: "structure",
        world: { seed: 5, questCount: 3, layout: "house" },
        initial_focus: null,
        avatar: "spirit",
        creative_mode: false,
      },
      packs: [],
    },
  },
];

/** The dropdown's default selection. */
export const DEFAULT_WORLD_ID = "earthlike";
