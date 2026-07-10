// shared/symbol-game/town-play.ts
//
// ONE SERIALIZABLE CONFIG → a whole live town session. The config crosses
// the games bridge (an iframe boundary — no live objects), and the player
// rebuilds the identical session from it: same seed ⇒ same town, same
// plan, same quests, same stage. Determinism IS the transport.
//
// The payload rides the existing `load_game` channel, discriminated by
// `engine: "town-play"` — hosts that predate it reject it harmlessly.

import { compileEconomy, type CompiledEconomy, type EconomyDoc } from "@shared/engine/modules/economy/index.js";
import { createTownWorld, type TownWorld } from "@shared/engine/town/town-world.js";
import { townPlan, type TownPlan } from "@shared/engine/town/plan.js";
import { buildTownQuestGame, type TownQuestBundle } from "./town-quests.js";
import { createTownStage, type TownStage } from "./town-stage.js";
import { TOWN_HOUSE_PALETTE } from "./town-directions.js";

export interface TownPlayConfig {
  seed: number;
  /** Days the town has lived before the visit (default 220). */
  days?: number;
  /** Quest-giving residents (1..3; default 2). */
  questCount?: number;
  /** THE BUILD-UP KNOB (storeys above ground under housing pressure) —
   *  capability × cost, the host's judgment. Default 0: a village
   *  spreads, it doesn't rise. */
  buildUp?: number;
  syntax?: "a" | "b" | "c";
  locale?: string;
}

/** The bridge payload: the config plus its discriminant. */
export interface TownPlayPayload extends TownPlayConfig {
  engine: "town-play";
  engineVersion: 1;
}

export function isTownPlayPayload(v: unknown): v is TownPlayPayload {
  return (
    typeof v === "object" && v !== null &&
    (v as { engine?: unknown }).engine === "town-play" &&
    (v as { engineVersion?: unknown }).engineVersion === 1 &&
    typeof (v as { seed?: unknown }).seed === "number"
  );
}

/**
 * The symbol game's own village CONTENT: two goods whose vocabularies the
 * quest pools already speak (food → treats, cloth → clothing). Farms grow
 * the food (banked in the granary — the stockpile session deliveries
 * credit); the weaver clothes the town. Content, not machinery: a game
 * that wants a richer village swaps this doc, nothing else.
 */
export const TOWN_PLAY_ECONOMY: EconomyDoc = {
  stockpiles: [{ key: "granary", max: 400, construction: true }],
  commodities: [
    {
      key: "food", scalarMax: 200, perPersonDaily: 0.001,
      transport: { drift: "granary", driftRequiresConstruction: true },
      street: {
        capDays: 3, shopSec: 18, cartRations: 25, unit: "rations", producers: ["farm"], market: true,
        stockColor: "#e0b25c", boxLabel: "Pantry", errandName: "shopping",
      },
    },
    {
      key: "cloth", scalarMax: 50, perPersonDaily: 0.0003,
      transport: {},
      street: {
        capDays: 12, shopSec: 20, cartRations: 12, unit: "bolts", producers: ["weaver"],
        stockColor: "#b8c4de", boxLabel: "Linen chest", errandName: "linens",
      },
    },
  ],
  buildings: [
    {
      key: "farm", countScalar: "farms", cap: { by: "farmland", rate: 1 / 60 },
      processes: [
        { id: "farm", input: "farmland", output: "grain_out", efficiency: 0.08, capacityRate: 5 },
        { id: "mill", input: "grain_out", output: "food_out", efficiency: 1 },
      ],
      vars: [{ name: "grain_out", max: 200 }],
      construction: { tier: "base", costs: [{ stockpile: "granary", amount: 20 }] },
      sells: ["food"], leansToward: "fertility", mapCap: 8, district: "farm",
      style: { color: "#7d9c53", w: 18, h: 12 }, vignette: { w: 5, h: 4 },
      glyph: "🌾", title: "🌾 Farmstead", info: ["{farms} farms."],
    },
    {
      key: "weaver", countScalar: "weavers", cap: { by: "population", rate: 0.002 },
      processes: [{ id: "weave", input: "farmland", output: "cloth_out", efficiency: 0.001, capacityRate: 2 }],
      construction: { tier: "industry", costs: [{ stockpile: "granary", amount: 25 }] },
      sells: ["cloth"], shelved: true, leansToward: null, mapCap: 2, district: "craft",
      style: { color: "#8a7fae", w: 14, h: 10 }, vignette: { w: 4, h: 4 },
      glyph: "🧵", title: "🧵 Weaver", info: ["{weavers} weavers."],
    },
  ],
};

const TOWN_KEY = "brookmill";
const CHARTER = { farmland: 420, ore_access: 0 };
const START_POP = 120;

export interface TownPlay {
  /** The config this session rebuilds from (replay = build again). */
  config: TownPlayConfig;
  town: TownWorld;
  eco: CompiledEconomy;
  plan: TownPlan;
  bundle: TownQuestBundle;
  stage: TownStage;
}

/** Build the live session a config describes. Deterministic end to end. */
export function buildTownPlay(config: TownPlayConfig): TownPlay {
  const eco = compileEconomy([TOWN_PLAY_ECONOMY], { construction: true });
  const town = createTownWorld({
    economy: eco,
    charter: CHARTER,
    startPop: START_POP,
    seedScalars: { farms: 1 }, // the founding farm (villageSeed's shape)
    key: TOWN_KEY,
  });
  town.step(Math.max(1, Math.min(5000, Math.floor(config.days ?? 220))));
  // Distinct, nameable house colours so residents can point you to "the blue
  // house" (and the wall the player sees matches what they're told).
  const plan = townPlan(town, eco, TOWN_KEY, config.seed, config.buildUp ?? 0, TOWN_HOUSE_PALETTE);
  const bundle = buildTownQuestGame(town, eco, plan, TOWN_KEY, {
    seed: config.seed,
    questCount: config.questCount,
    ...(config.syntax ? { syntax: config.syntax } : {}),
    ...(config.locale ? { locale: config.locale } : {}),
  });
  // The goal-tree player embodies the cast itself (npc_{nodeId} bodies at
  // the cast anchors), so the stage ships without spec-time cast NPCs.
  const stage = createTownStage(town, eco, plan, bundle, { seed: config.seed, castNpcs: false });
  return { config, town, eco, plan, bundle, stage };
}
