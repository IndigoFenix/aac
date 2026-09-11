/**
 * 📜 THE DECLARED CELL — a town document may CARRY what the ground under it
 * says, and the file that does is a transcript of a real measurement
 * (planning-docs/games/world-engine/planet-boot-round.md §6a).
 *
 * 🚨 WHY THIS EXISTS. A headless boot of the frontier planet used to read four
 * hand-written constants (`text-quest.ts PLANET_CELL_*`) that described a wet
 * temperate wood — and the world the browser bakes has no such cell anywhere.
 * The fix is not "type better constants": it is that the record has ONE shape
 * (`planet-scope.ts SiteEnvironment`) with three producers, and the second of
 * them reads it off a DOCUMENT. `scripts/worlds/frontier-cell.spec.json` is
 * that document, and it is GENERATED — `npm run world:lower -- --declare-cell
 * --preset frontier-planet --out scripts/worlds/frontier-cell.spec.json
 * --force` — so it cannot drift from the planet it claims to describe.
 *
 * WHAT THIS FILE PINS:
 *   ① REGENERATE = THE PIN. The checked-in file equals a fresh generation
 *      BYTE-FOR-BYTE. A hand edit is a red, not a drift.
 *   ② THE TWO PRODUCERS AGREE. `declaredEnvironment` of the document's own
 *      config deep-equals `measuredEnvironment`'s answer on the real planet.
 *   ③ THE GATE IS PATH-EXACT. A malformed partner row is refused at its own
 *      path, not swallowed into a default.
 *   ④ ALL FIVE OR NONE — a half-declared cell reads as no cell at all, which
 *      is the sampled-constants defect refused in its new costume.
 *
 * 💰 COST: this is the ONE place a planetary bake (24–29 s) runs in the FAST
 * HALF. It happens once, at `beforeAll`, and the process memo means the second
 * `buildPlanetScope` below is a map lookup.
 *
 * DB-free / GL-free — `npm run test:engine -- declared-cell`.
 */
import { describe, it, expect, beforeAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTownWorld } from "@shared/world-engine/interaction/town/town-play-game.js";
import {
  buildPlanetScope, declaredEnvironment, type SiteEnvironment,
} from "@shared/world-engine/interaction/town/planet-scope.js";
import { parseGameSettings } from "@shared/world-engine/kernel/manifest.js";

const CELL_PATH = join(process.cwd(), "scripts", "worlds", "frontier-cell.spec.json");
const PLANET_PATH = join(process.cwd(), "scripts", "worlds", "frontier-planet.spec.json");

type Doc = { game: { world: Record<string, unknown> } };

/** The record without its optional terrain half — `ground` is the one field a
 *  DOCUMENT can never carry (only a producer with a real surface answers it),
 *  so it is excluded from the comparison rather than faked on either side. */
const withoutGround = (env: SiteEnvironment): Omit<SiteEnvironment, "ground"> => {
  const { ground: _ground, ...rest } = env;
  return rest;
};

describe("📜 the declared cell", () => {
  let checkedIn: string;
  let fresh: string;
  let freshDoc: Doc;
  let measured: SiteEnvironment;

  beforeAll(async () => {
    checkedIn = readFileSync(CELL_PATH, "utf8");
    // THE GENERATOR ITSELF, imported — not a second implementation of it. A
    // pin that rebuilt the document its own way would be pinning its own
    // opinion of what a declared cell looks like.
    const gen = await import("../../../scripts/dev/lower-world.js");
    freshDoc = (await gen.declaredCellDocument("frontier-planet")) as unknown as Doc;
    fresh = gen.serializeDocument(freshDoc);
    const planetGame = parseGameSettings(
      (JSON.parse(readFileSync(PLANET_PATH, "utf8")) as { game: unknown }).game, "game",
    );
    measured = buildPlanetScope(planetGame).env;
  }, 900_000);

  it("① the checked-in file IS a fresh generation, byte for byte", () => {
    // 🚨 REGENERATE = THE PIN (feedback_game_spec_json_is_generated). If this
    // fails, the fix is `npm run world:lower -- --declare-cell --preset
    // frontier-planet --out scripts/worlds/frontier-cell.spec.json --force` —
    // never an edit to the JSON.
    expect(fresh).toBe(checkedIn);
  });

  it("② the DECLARED record equals the MEASURED one", () => {
    const config = parseTownWorld((JSON.parse(checkedIn) as Doc).game.world, "game.world").config;
    const declared = declaredEnvironment(config);
    expect(declared).not.toBeNull();
    // ONE RECORD, TWO PRODUCERS. Every number in the file came off the
    // substrate, so a difference here means the document and the planet have
    // parted company — which is the whole failure mode this round closed.
    expect(withoutGround(declared!)).toEqual(withoutGround(measured));
    // …and the headline values, spelled out so a regression reads as a number
    // rather than as a diff: the real founding cell 12755.
    expect(declared!.biome).toBe(1);
    expect(declared!.charter).toEqual({ farmland: 516, ore_access: 0, timberland: 302 });
    expect(declared!.climate.tempC).toBeCloseTo(28.4125, 4);
    expect(declared!.eco.tree).toBeCloseTo(0.24, 6);
    expect(declared!.partners.map((p) => p.key)).toEqual(["city:12804", "city:12706", "city:12708"]);
    expect(declared!.partners[0]!.distanceM).toBeCloseTo(280723.98, 1);
  });

  it("③ a malformed partner row is refused at its OWN path", () => {
    const doc = JSON.parse(checkedIn) as Doc;
    (doc.game.world.partners as Array<Record<string, unknown>>)[0]!.at = "over there";
    expect(() => parseTownWorld(doc.game.world, "game.world")).toThrow(
      /^game\.world\.partners\[0\]\.at: expected an object of sim coordinates/,
    );
    // …and the same gate reaches inside the point.
    const doc2 = JSON.parse(checkedIn) as Doc;
    ((doc2.game.world.partners as Array<{ at: Record<string, unknown> }>)[1]!.at).y = null;
    expect(() => parseTownWorld(doc2.game.world, "game.world")).toThrow(
      /^game\.world\.partners\[1\]\.at\.y: must be a finite number/,
    );
  });

  it("④ a HALF-declared cell reads as no cell at all", () => {
    // A document that says one thing about its ground and defaults the rest is
    // the sampled-constants defect in a new costume: the boot would then
    // scatter from a charter it never measured while claiming a climate it did.
    // `declaredEnvironment` refuses the whole record instead.
    for (const missing of ["climate", "biome", "eco", "charter", "partners"]) {
      const doc = JSON.parse(checkedIn) as Doc;
      delete doc.game.world[missing];
      const config = parseTownWorld(doc.game.world, "game.world").config;
      expect(declaredEnvironment(config)).toBeNull();
    }
    // …and an ordinary town document (no declared cell at all) is likewise
    // null, which is what keeps every shipped world byte-identical.
    const plain = parseTownWorld({ seed: 11, days: 4, wilderness: true }, "game.world").config;
    expect(declaredEnvironment(plain)).toBeNull();
  });
});
