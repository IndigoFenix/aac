/**
 * The TOWN scope builder — a living town loaded from a JSON document.
 *
 * There is ONE kind of town, and it is always living: a real `createTownWorld`
 * economy simulation whose RESIDENTS walk the streets, whose goods are what the
 * town produces, and which the player enters embodied to walk and talk. It IS
 * the sandbox's 🏘️ town mode, `buildTownPlay` (shared/symbol-game/town-play.ts),
 * reached from a world document. See docs/TOWN_AND_NPCS.md.
 *
 * (There is NO `living-town` world kind — that was a mis-fork. The static
 * aggregate viewer in shared/engine/town/town-game.ts is a far-LOD analysis
 * build, not an alternative town.)
 *
 * Validation follows the module law: the kernel gated `game`'s shape; this
 * builder owns the deep validation of the town-scoped `world` object,
 * path-exact, reject-never-skip.
 */
import type { GameSettings } from "../engine/manifest.js";
import { buildTownPlay, type TownPlay, type TownPlayConfig } from "./town-play.js";
import { certifyCreatureQuestWorld } from "./creature-quests.js";

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

function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    fail(path, `must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

const TOWN_FIELDS = ["seed", "days", "questCount", "buildUp", "syntax", "locale"] as const;

export interface TownScopeWorldSpec {
  config: TownPlayConfig;
}

/** Deep gate for a town-scoped `world` object. */
export function parseTownWorld(raw: unknown, path: string): TownScopeWorldSpec {
  if (!isObj(raw)) fail(path, "expected an object (the town definition)");
  for (const k of Object.keys(raw)) {
    if (!(TOWN_FIELDS as readonly string[]).includes(k)) {
      fail(`${path}.${k}`, `unknown field (allowed: ${TOWN_FIELDS.join(", ")})`);
    }
  }
  // The seed is REQUIRED: one seed reproduces the whole town (its plan, its
  // residents, its quests). Omitting it would let the document lie about what
  // it loads.
  if (!("seed" in raw)) fail(`${path}.seed`, "required — one seed reproduces the whole town");
  const seed = num(raw.seed, `${path}.seed`, 0, 0xffffffff);
  if (!Number.isInteger(seed)) fail(`${path}.seed`, "must be an integer");

  const config: TownPlayConfig = { seed };
  if ("days" in raw) {
    config.days = num(raw.days, `${path}.days`, 1, 5000);
    if (!Number.isInteger(config.days)) fail(`${path}.days`, "must be an integer");
  }
  if ("questCount" in raw) {
    config.questCount = num(raw.questCount, `${path}.questCount`, 1, 3);
    if (!Number.isInteger(config.questCount)) fail(`${path}.questCount`, "must be an integer");
  }
  if ("buildUp" in raw) config.buildUp = num(raw.buildUp, `${path}.buildUp`, 0, 12);
  if ("syntax" in raw) config.syntax = oneOf(raw.syntax, `${path}.syntax`, ["a", "b", "c"] as const);
  if ("locale" in raw) {
    config.locale = typeof raw.locale === "string" && raw.locale
      ? raw.locale
      : fail(`${path}.locale`, "must be a BCP-47 locale string");
  }
  return { config };
}

export interface BuiltTownScope {
  spec: TownScopeWorldSpec;
  /** The live session the quest host plays (config + town + plan + quests + stage). */
  play: TownPlay;
}

/** Build the living town a `scope: "town"` document describes. Deterministic
 *  end to end (same seed ⇒ same town). */
export function buildTownScope(settings: GameSettings, label = "game"): BuiltTownScope {
  if (settings.scope !== "town") {
    fail(`${label}.scope`, `buildTownScope builds "town" games (got "${settings.scope}")`);
  }
  const spec = parseTownWorld(settings.world, `${label}.world`);
  // A town is played embodied — you walk it and talk to its residents; a
  // spectator view of it is meaningless.
  if (settings.avatar !== true) {
    fail(`${label}.avatar`, "a town is played embodied — set avatar to true");
  }
  // The player spawns at the village square; residents are met by walking to
  // them, not by focusing a sub-object.
  if (settings.initialFocus !== null) {
    fail(`${label}.initial_focus`, "a town always opens at the village square — use null");
  }

  const play = buildTownPlay(spec.config);
  // The quest bundle drawn from the town's residents/goods must PROVE itself
  // (the goal-tree gauntlet + the greedy-sim playthrough) — a town whose
  // quests aren't winnable is refused, not shipped.
  const cert = certifyCreatureQuestWorld(play.bundle.game);
  if (!cert.ok) {
    fail(`${label}.world`, `town failed ${cert.stage} certification: ${cert.errors.join("; ")}`);
  }
  return { spec, play };
}
