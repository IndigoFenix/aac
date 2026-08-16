/**
 * The TOWN scope builder — a world document whose whole game is ONE town:
 * the standalone TownWorld (no composition layer) grown for `days`, then
 * laid out at real scale by townPlan. Unlike the planet scope, a town
 * world's CONTENT comes through the manifest proper: it must declare
 * `uses: ["economy"]` and ship economy packs — the town's goods,
 * buildings and species are the document's, not the engine's.
 *
 * Validation follows the module law: the kernel gated `game`'s shape;
 * this builder owns the deep validation of the town-scoped `world`
 * object, path-exact, reject-never-skip.
 */
import type { GameSettings, LoadedWorld } from "../manifest";
import { docsFor } from "../manifest";
import { ECONOMY_MODULE } from "../modules/economy/index";
import { compileEconomy, type CompiledEconomy, type EconomyDoc } from "../modules/economy/economy";
import { createTownWorld, type TownWorld } from "./town-world";
import { townPlan, type TownPlan } from "./plan";
import { validateFields, type FieldSpec, type GroupSpec } from "../spec-schema";

export interface TownWorldSpec {
  key: string;
  /** Street-plan seed. */
  seed: number;
  /** Days the town lives before the player arrives (1..5000). */
  days: number;
  /** Founding population (primary species). */
  startPop: number;
  /** The site's endowment — what a substrate would have chartered. */
  charter: { farmland: number; ore_access: number; timberland: number };
  /** Founding grants (content's call — a world seeded with nothing that
   *  produces its staple starves, honestly). Default: one farm. */
  seedScalars: Record<string, number>;
  /** Build-up knob (upper storeys under housing pressure, 0..4). */
  buildUp: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

function num(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, `must be a number (${min}..${max})`);
  if (v < min || v > max) fail(path, `out of range (${min}..${max})`);
  return v;
}

/** The site endowment a substrate would have chartered — SHARED shape with the
 *  founding charter box (farmland/ore_access/timberland). */
const CHARTER_FIELDS: readonly FieldSpec[] = [
  { key: "farmland", kind: "number", min: 0, max: 1e6, default: 420, facet: "boundary", label: "Farmland" },
  { key: "ore_access", kind: "number", min: 0, max: 1e6, default: 0, facet: "boundary", label: "Ore access" },
  { key: "timberland", kind: "number", min: 0, max: 1e6, default: 0, facet: "boundary", label: "Timberland" },
];

/** Founding grants — a dynamic-key map of scalar grants (`{ farms: 1 }`). A
 *  present value REPLACES the default map wholesale. */
function parseSeedScalars(raw: unknown, path: string): Record<string, number> {
  if (!isObj(raw)) fail(path, "expected an object of scalar grants");
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = num(v, `${path}.${k}`, 0, 1e9);
  return out;
}

/** The far-LOD town scope's `world` descriptor (the static-aggregate build —
 *  distinct from the living-town `TOWN_WORLD_FIELDS`). */
export const TOWN_LOD_WORLD_FIELDS: GroupSpec = {
  objectMessage: "expected an object (the town definition)",
  fields: [
    { key: "key", kind: "string", default: "town", facet: "interior", label: "Key" },
    { key: "seed", kind: "number", min: 0, max: Number.MAX_SAFE_INTEGER, default: 1, facet: "boundary", ui: "seed", label: "Seed" },
    { key: "days", kind: "floor", min: 1, max: 5000, default: 220, facet: "interior", label: "Days grown" },
    { key: "startPop", kind: "floor", min: 1, max: 100_000, default: 120, facet: "interior", label: "Start population" },
    { key: "charter", kind: "object", fields: CHARTER_FIELDS, default: { farmland: 420, ore_access: 0, timberland: 0 },
      facet: "boundary", label: "Charter" },
    { key: "seedScalars", kind: "custom", validate: parseSeedScalars, default: { farms: 1 },
      facet: "interior", label: "Seed grants" },
    { key: "buildUp", kind: "number", min: 0, max: 4, default: 0, facet: "interior", label: "Build-up" },
  ],
};

/** Deep gate for a town-scoped `world` object. */
export function parseTownWorld(raw: unknown, path: string): TownWorldSpec {
  return validateFields(raw, TOWN_LOD_WORLD_FIELDS, path) as unknown as TownWorldSpec;
}

export interface BuiltTown {
  spec: TownWorldSpec;
  eco: CompiledEconomy;
  town: TownWorld;
  plan: TownPlan;
}

/** Build the town a `scope: "town"` game plays in, from a loaded world
 *  document (the economy comes from its packs). Deterministic. */
export function buildTownGame(loaded: LoadedWorld, label = "game"): BuiltTown {
  const game: GameSettings | null = loaded.game;
  if (!game) fail(label, "document has no game settings");
  if (game.scope !== "town") {
    fail(`${label}.scope`, `buildTownGame builds "town" games (got "${game.scope}")`);
  }
  const spec = parseTownWorld(game.world, `${label}.world`);

  const docs = docsFor<EconomyDoc>(loaded, ECONOMY_MODULE);
  if (!docs.length) {
    fail(label, `a town world needs an economy — declare uses:["economy"] and ship an economy pack`);
  }
  const eco = compileEconomy(docs, { construction: true });

  const town = createTownWorld({
    economy: eco,
    charter: spec.charter,
    startPop: spec.startPop,
    seedScalars: spec.seedScalars,
    key: spec.key,
  });
  town.step(spec.days);
  // The town is BUILT BY its residents' species (manifest avatarSpecies) —
  // rooms, doors and furniture lanes size to that body.
  const plan = townPlan(town, eco, spec.key, spec.seed, spec.buildUp, undefined, [], game.avatarSpecies);

  return { spec, eco, town, plan };
}
