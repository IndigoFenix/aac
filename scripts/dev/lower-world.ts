/**
 * lower-world.ts — GENERATE a `scripts/worlds/*.spec.json` document.
 *
 *   npm run world:lower -- --preset frontier-planet --out scripts/worlds/frontier-planet.spec.json [--force]
 *   npm run world:lower -- --declare-cell --preset frontier-planet --out scripts/worlds/frontier-cell.spec.json [--force]
 *
 * ⚖️ WORLD DOCUMENTS ARE GENERATED, NOT HAND-AUTHORED
 * (feedback_game_spec_json_is_generated). A shipped game's `game.spec.json`
 * has been generated from its preset since `scripts/sync-game-engine.ts`
 * landed; the documents in `scripts/worlds/` — the ones text mode and the arc
 * runner boot — were the one family still typed by hand, and they drifted:
 * `frontier-planet.spec.json` described a five-settler TOWN at seed 11 while
 * the preset it is named after is a SOLAR SYSTEM at seed 1337 with a founding
 * premise. Two worlds, one name, and every headless measurement of "the
 * frontier planet" was taken on the world the browser never boots.
 *
 * TWO GENERATORS, ONE CHAIN:
 *   • `--preset` LOWERS the world-lab preset. The fold is `lowerTreeWorld` —
 *     the same function the lab's own "run" button and the game sync call,
 *     imported the way `sync-game-engine.ts` imports it (dynamic import; the
 *     module is deliberately DOM-free so tsx and jest can both load it).
 *   • `--declare-cell` BOOTS that lowered planet document through
 *     `buildPlanetScope` — the real bake, the real forest cell, the real
 *     charter/climate/ecology/partners — and writes the MEASURED record out as
 *     a TOWN document (`frontier-cell.spec.json`). A suite that only wants a
 *     founding CAMP boots that instead of paying 25 s of planetary geology per
 *     boot, and it is the SAME cell either way: `declared-cell.test.ts` asserts
 *     the checked-in file equals a fresh generation byte-for-byte, and that its
 *     record deep-equals what `buildPlanetScope` measures.
 *
 * 🚨 THE ASSEMBLY IS EXPORTED, NOT INLINED IN THE CLI, and the module runs its
 * CLI only when it IS the process entry — so the pin can regenerate the
 * document in-process instead of re-implementing the writer and pinning a
 * second opinion about what a declared cell looks like.
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

type Dict = Record<string, unknown>;

/** THE ONE SERIALIZATION — two writers, one byte layout (and the pin compares
 *  bytes, so this is load-bearing). */
export function serializeDocument(doc: unknown): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

/** The world-lab preset, LOWERED — `lowerTreeWorld`, the lab's own fold. */
export async function lowerPresetDocument(presetId: string): Promise<Dict> {
  // THE SAME FOLD the world-lab's "run" button uses — one function, because a
  // second copy of it silently dropped every session field it did not know.
  const { TEST_WORLDS } = await import("../../games/world-lab/src/worlds.ts");
  const { lowerTreeWorld } = await import("../../games/world-lab/src/lower-world.ts");
  const { parseGameSettings } = await import("../../shared/world-engine/kernel/manifest.ts");

  const preset = (TEST_WORLDS as Array<{ id: string; world: unknown }>).find((w) => w.id === presetId);
  if (!preset) {
    throw new Error(
      `preset "${presetId}" not found in games/world-lab/src/worlds.ts ` +
      `(have: ${(TEST_WORLDS as Array<{ id: string }>).map((w) => w.id).join(", ")})`,
    );
  }
  const doc = lowerTreeWorld(preset.world as never) as Dict;
  // Fail the GENERATION, not somebody's boot three days later, on a document
  // the engine will not accept.
  parseGameSettings(doc.game as Dict, "game");
  return doc;
}

/**
 * 📜 THE DECLARED CELL — the founding cell of a lowered PLANET preset, measured
 * once and written down as a town document.
 *
 * Every field is a transcript of `SiteEnvironment` (`planet-scope.ts`) or of
 * the premise the solar document declares. Nothing here is chosen: the seed,
 * the kit and the party size are the premise's; the climate, biome, ecology,
 * charter and partners are what the substrate said when it was asked.
 *
 * ⚠️ IT IS A CAMP, NOT THE PLANET. `days: 0` / `population: N` builds the
 * founding party's town from the document the way every other town document
 * does — the planet arm's own `siteTownConfig` town (day one, the site key, the
 * kit riding construction deltas) is a different object, and this one does not
 * pretend to be it. What the two DO share, exactly, is the ground: the same
 * five records, so the same scatter, the same farm yield and the same partners.
 */
export async function declaredCellDocument(presetId: string): Promise<Dict> {
  const planetDoc = await lowerPresetDocument(presetId);
  const { parseGameSettings } = await import("../../shared/world-engine/kernel/manifest.ts");
  const { parseSolarWorld } = await import("../../shared/world-engine/space/space-game.ts");
  const { buildPlanetScope } = await import("../../shared/world-engine/interaction/town/planet-scope.ts");

  const game = parseGameSettings(planetDoc.game as Dict, "game");
  if (game.scope !== "solar_system") {
    throw new Error(`--declare-cell needs a solar_system preset (preset "${presetId}" lowers to "${game.scope}")`);
  }
  const premise = parseSolarWorld(game.world, "game.world");
  const scope = buildPlanetScope(game);
  const { climate, biome, eco, charter, partners } = scope.env;

  // KEY ORDER IS THE FILE'S ORDER — written out rather than spread, so the
  // bytes are a decision and not whatever the measurement happened to build.
  return {
    engine: "aivota-world",
    engineVersion: 1,
    uses: [],
    packs: [],
    game: {
      scope: "town",
      world: {
        // THE PREMISE, transcribed.
        seed: premise.seed,
        days: 0,
        population: premise.premise_population ?? 0,
        wilderness: true,
        // The ground character — the town rect is CONTENT on a planet, never
        // the world's edge (`town-stage onPlanet`, the invisible-wall defect).
        terrain: "planet",
        stock: { ...(premise.premise_stock ?? {}) },
        // THE MEASURED CELL — all five, or `declaredEnvironment` returns null.
        climate: {
          rain: climate.rain,
          tempC: climate.tempC,
          elevation: climate.elevation,
          fertility: climate.fertility,
          // `ClimateSample.ore` is optional (absent = 0) but a declared cell is
          // a transcript of a MEASUREMENT: one that found no ore says 0.
          ore: climate.ore ?? 0,
        },
        biome,
        eco: { ...eco },
        charter: {
          farmland: charter.farmland,
          ore_access: charter.ore_access,
          timberland: charter.timberland,
        },
        partners: partners.map((p) => ({
          key: p.key,
          at: { x: p.at.x, y: p.at.y },
          geo: { ...p.geo },
          distanceM: p.distanceM,
        })),
      },
      avatar: "spirit",
      // The preset's own clock, verbatim — a camp on this planet keeps the
      // planet's day, or the two documents pace differently.
      scale: (planetDoc.game as Dict).scale,
    },
  };
}

// ── THE CLI ─────────────────────────────────────────────────────────────────
// Runs only when this module IS the entry point, so `declared-cell.test.ts` can
// import the assembly above without a script executing under it.

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const presetId = argOf("--preset");
  const outArg = argOf("--out");
  const force = process.argv.includes("--force");
  const declareCell = process.argv.includes("--declare-cell");

  if (!presetId || !outArg) {
    console.error(
      "usage: npm run world:lower -- --preset <id> --out <path> [--declare-cell] [--force]",
    );
    process.exit(2);
  }

  const outPath = resolve(ROOT, outArg);
  if (existsSync(outPath) && !force) {
    console.error(`refusing to overwrite ${outArg} (pass --force)`);
    process.exit(1);
  }

  const doc = declareCell ? await declaredCellDocument(presetId) : await lowerPresetDocument(presetId);
  const text = serializeDocument(doc);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text);

  const sha1 = createHash("sha1").update(text).digest("hex");
  console.log(
    `wrote ${outArg} ${declareCell ? "as the DECLARED CELL of" : "from"} preset "${presetId}" — ` +
    `${Buffer.byteLength(text)} bytes, sha1 ${sha1}`,
  );
}

// 🚫 NO TOP-LEVEL `await` — the pin imports this module under jest, and a
// module that awaits at load makes every consumer pay for the decision.
const entry = process.argv[1];
if (entry && pathToFileURL(resolve(entry)).href === import.meta.url) {
  void main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
