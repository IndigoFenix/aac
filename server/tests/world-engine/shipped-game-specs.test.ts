/**
 * THE SPECIES/MOD PIN for every SHIPPED game document.
 *
 * `games/<game>/src/game.spec.json` is regenerated from a world-lab preset
 * (`npm run sync:game-engine -- <game>`), so a species id authored in the
 * preset reaches players verbatim. Nothing between the preset and the bundle
 * checks that the id still EXISTS: `getSpecies` returns undefined and the
 * consumer falls through to a default body, so a retired species reads as a
 * cosmetic oddity rather than an error.
 *
 * That is exactly how the Dollhouse shipped `species: "frog_person"` after the
 * hand-drawn animal people were retired into the `animal_people` mod (which
 * the Dollhouse does not declare — it declares `cute`). Caught by eye, in
 * play, long after the fact.
 *
 * So this file owns the CROSS-GAME invariant: for each shipped spec, the mods
 * it declares must install, and EVERY species id it names — the avatar's and
 * each authored creature's — must resolve WITH THOSE MODS INSTALLED and no
 * others. A game that wants `frog_person` must declare `animal_people`.
 *
 * Per-game shape lives with the game (`dollhouse-spec.test.ts`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGameSettings } from "@shared/world-engine/kernel/manifest";
import { applyWorldCreatureMods } from "@shared/world-engine/creatures/world-mods.js";
import { getSpecies } from "@shared/world-engine/creatures/species.js";

/** Every game with a vendored spec (the two `engine.sync.json` games). */
const SHIPPED = ["dollhouse", "nature-hike"] as const;

const specOf = (game: string) =>
  JSON.parse(readFileSync(join(process.cwd(), "games", game, "src", "game.spec.json"), "utf8"));

/** Every species id the document NAMES (avatar + authored creatures/pets). */
function speciesIdsIn(doc: any): { where: string; id: string }[] {
  const out: { where: string; id: string }[] = [];
  if (typeof doc.game?.avatar_species === "string") {
    out.push({ where: "avatar_species", id: doc.game.avatar_species });
  }
  const list: any[] = doc.game?.entities?.creatures?.list ?? [];
  list.forEach((c, i) => {
    if (typeof c?.species === "string") out.push({ where: `creatures.list[${i}] (${c.name ?? "?"})`, id: c.species });
  });
  return out;
}

// The registry is process-global; hand it back to the authored rows so a later
// suite doesn't read a world's derived species.
afterAll(() => { applyWorldCreatureMods([]); });

describe.each(SHIPPED)("shipped spec: %s", (game) => {
  const doc = specOf(game);

  it("is a document the engine accepts", () => {
    expect(doc.engine).toBe("aivota-world");
    parseGameSettings(doc.game, "game");
  });

  it("declares only mods that install", () => {
    const mods = parseGameSettings(doc.game, "game").mods;
    expect(() => applyWorldCreatureMods(mods)).not.toThrow();
  });

  it("names only species that resolve under its OWN declared mods", () => {
    const mods = parseGameSettings(doc.game, "game").mods;
    applyWorldCreatureMods(mods);
    const unknown = speciesIdsIn(doc)
      .filter(({ id }) => !getSpecies(id))
      .map(({ where, id }) => `${where} → "${id}"`);
    // A failure here means the spec names a retired/never-registered species,
    // or names a DERIVED one (e.g. `frog_person`) without declaring the mod
    // that derives it (`animal_people`).
    expect(unknown).toEqual([]);
  });
});
