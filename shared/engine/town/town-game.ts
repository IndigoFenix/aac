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

/** Deep gate for a town-scoped `world` object. */
export function parseTownWorld(raw: unknown, path: string): TownWorldSpec {
  if (!isObj(raw)) fail(path, "expected an object (the town definition)");
  for (const k of Object.keys(raw)) {
    if (!["key", "seed", "days", "startPop", "charter", "seedScalars", "buildUp"].includes(k)) {
      fail(`${path}.${k}`, "unknown field (allowed: key, seed, days, startPop, charter, seedScalars, buildUp)");
    }
  }

  let key = "town";
  if ("key" in raw) {
    if (typeof raw.key !== "string" || !raw.key.length) fail(`${path}.key`, "must be a non-empty string");
    key = raw.key;
  }
  const seed = "seed" in raw ? num(raw.seed, `${path}.seed`, 0, Number.MAX_SAFE_INTEGER) : 1;
  const days = "days" in raw ? Math.floor(num(raw.days, `${path}.days`, 1, 5000)) : 220;
  const startPop = "startPop" in raw ? Math.floor(num(raw.startPop, `${path}.startPop`, 1, 100_000)) : 120;

  const charter = { farmland: 420, ore_access: 0, timberland: 0 };
  if ("charter" in raw) {
    const c = raw.charter;
    if (!isObj(c)) fail(`${path}.charter`, "expected an object");
    for (const k of Object.keys(c)) {
      if (!["farmland", "ore_access", "timberland"].includes(k)) {
        fail(`${path}.charter.${k}`, "unknown field (allowed: farmland, ore_access, timberland)");
      }
    }
    if ("farmland" in c) charter.farmland = num(c.farmland, `${path}.charter.farmland`, 0, 1e6);
    if ("ore_access" in c) charter.ore_access = num(c.ore_access, `${path}.charter.ore_access`, 0, 1e6);
    if ("timberland" in c) charter.timberland = num(c.timberland, `${path}.charter.timberland`, 0, 1e6);
  }

  let seedScalars: Record<string, number> = { farms: 1 };
  if ("seedScalars" in raw) {
    const s = raw.seedScalars;
    if (!isObj(s)) fail(`${path}.seedScalars`, "expected an object of scalar grants");
    seedScalars = {};
    for (const [k, v] of Object.entries(s)) {
      seedScalars[k] = num(v, `${path}.seedScalars.${k}`, 0, 1e9);
    }
  }
  const buildUp = "buildUp" in raw ? num(raw.buildUp, `${path}.buildUp`, 0, 4) : 0;

  return { key, seed, days, startPop, charter, seedScalars, buildUp };
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
  const plan = townPlan(town, eco, spec.key, spec.seed, spec.buildUp);

  return { spec, eco, town, plan };
}
