// shared/glyph-place-art.ts
//
// PLACE ART — the words whose SYMBOL is a CONTAINER FRAME with an inner symbol.
//
// A room or a building is ONE WORD in a sentence (`bedroom`, `smithy`) and one
// SYMBOL on a button — a symbol that happens to be drawn from two PNGs: the
// shell plate (`places/room-bg`, `places/building-bg`) and the fixture planted
// on it that says which place it is. `bedroom` IS "the bed in a room"; there is
// no state of the world in which it should draw as a bare bed.
//
// WHY THIS TABLE EXISTS (the bug it fixes). The composition used to ride a SIDE
// CHANNEL: the engine handed boards a display glyph (`roomDisplayGlyph`,
// `structureDisplayGlyph` → "room(bed)") beside the word, and only surfaces
// wired to that channel drew the shell. Everywhere the WORD travelled alone —
// a staged sentence slot, a speech bubble (`structureDoneLine(spec.glyph)`
// speaks "smithy", not "building(anvil)"), a caption, an AI-strip candidate —
// the composition was lost: a word with a furniture-ish emoji in the registry
// drew that emoji with no shell (`bedroom` → 🛌, `kitchen` → 🍳), and a word
// with no registry entry at all (`smithy`, `forge`, `farm`, `masonry`) drew ❓.
//
// A sentence CANNOT carry the composed form: the token has to stay the WORD, or
// TTS speaks parentheses and `tokenizeSentence` can't parse it (the builder
// never emits them — ENABLE_GLYPH_ARGUMENTS is off). So the resolution has to
// happen where the drawing happens, keyed on the word. That is this table, and
// `drawnSlot` (glyph-compositor.ts) is the one place it is applied — so every
// renderer that goes through the compositor gets the shell for free and none of
// them can disagree.
//
// The word is never rewritten: place art is DISPLAY ONLY and never reaches
// `serializeGlyph`, the parser, TTS or any rule.
//
// Dependency-free on purpose (a local splitter instead of `parseGlyph`) so the
// compositor's pure half can import it without a cycle.

/** A resolved piece of place art: the frame to draw, and what sits in it. */
export interface PlaceArt {
  /** The container-frame key — `room` / `building` (or a plain symbol key). */
  key: string;
  /** The inner symbol, absent when the art is a bare symbol. */
  payload?: string;
}

/**
 * THE DEFAULT-CULTURE TABLE. Every entry mirrors what the engine's own display
 * helpers produce for that word — `roomDisplayGlyph` / `structureProgramDisplayGlyph`
 * (kernel/town/programs.ts) and `structureDisplayGlyph` (kernel/town/structures.ts).
 * `server/tests/world-engine/place-art.test.ts` is the GATE: it derives the
 * expected map from those specs and fails when a row here drifts or when a new
 * room program / structure / catalogue spec ships with no art and no exemption.
 * Do not hand-edit a row to disagree with its spec — change the spec.
 *
 * A word that is BOTH a room kind and a building type (`workshop`, `masonry`)
 * draws the BUILDING, matching `placeBuilderNouns`' buildings-first rule: what a
 * player builds and speaks about is the building.
 *
 * ONE WORD, ONE SENSE. Where the AAC and the engine used the same English word
 * for different things, the SENSE was split at the source rather than fudged
 * here, because a word can only draw one picture:
 *   - `store` is the SHOP (the AAC's own word — "Store" / "חנות" — and a place a
 *     student goes), so it draws trade. The STORAGE sense became `storeroom`,
 *     its own lexicon key in all four rulesets and the room program's `word`.
 *   - `bath` is the TUB (a `what`, art at things/furniture/bath): "I want a
 *     bath" is the fixture. The FLOOR is `bathroom`, which is what the room
 *     program speaks and `ROOM_GLYPH` already said.
 *
 * DELIBERATELY ABSENT: `building` — already a composed-frame symbol in its own
 * right (`places/building`); and every fixture word (`bath`, `bed`, `box`,
 * `book`…), which name things, not places.
 *
 * A registry row that IS listed here also carries `exposeToAi`, so the AI writes
 * the word rather than the fixture emoji beside it (a bare 🛌 on a board button
 * was the same bug from the model's side). `place-art.test.ts` pins that pairing.
 */
const DEFAULT_PLACE_ART: Readonly<Record<string, string>> = {
  // ── BUILDINGS (the town's structures) ──────────────────────────────────
  // A DWELLING is drawn by who lives in it. `home` and `house` are one referent
  // (the house program's `word` IS `home`), so they draw one symbol.
  home: "building(family)",
  house: "building(family)",
  farm: "building(grain)",
  market: "building(money)",
  // A SHOP is trade under a roof. `store` is the AAC's word for the same place.
  shop: "building(trade)",
  store: "building(trade)",
  workshop: "building(workbench)",
  masonry: "building(stonecutter)",
  smithy: "building(anvil)",
  weaver: "building(loom)",
  // The BOOK, not the `shelf` station: the shelf derives the STUDY room inside;
  // a library is a building of books.
  library: "building(book)",
  temple: "building(altar)",
  storehouse: "building(box)",
  // ── ROOMS (a floor inside one) ─────────────────────────────────────────
  bedroom: "room(bed)",
  kitchen: "room(oven)",
  // The BATHROOM reads by its toilet (user law) — `bath` is the tub.
  bathroom: "room(toilet)",
  // STORAGE: a room of boxes. The word the storage sense now owns outright.
  storeroom: "room(box)",
  living: "room(table)",
  forge: "room(anvil)",
  shrine: "room(altar)",
  weaving: "room(loom)",
  study: "room(shelf)",
  // THE HALL — the kind a room DERIVES when nothing in it defines a function
  // (`roomKindOf`'s fallback). No program declares it, so the engine hands
  // boards the bare word; a room with no fixture worth naming is exactly the
  // generic room plate, with nothing planted on it.
  hall: "room",
};

/** Session overlay — culture-authored rows and swapped catalogues (see
 *  `registerPlaceArt`). Checked before the default table. */
const registered = new Map<string, string>();

/** Split cache for both maps. Holds `undefined` for a miss so a word that has
 *  no art costs one lookup, not one regex, per render. */
const splitCache = new Map<string, PlaceArt | undefined>();

/** `frame(symbol)` or a bare `symbol`. Anything else is not place art. */
const ART_RE = /^([a-z][a-z0-9_]*)(?:\(([a-z][a-z0-9_]*)\))?$/;

function split(art: string): PlaceArt | undefined {
  const m = ART_RE.exec(art.trim());
  if (!m) return undefined;
  return m[2] ? { key: m[1], payload: m[2] } : { key: m[1] };
}

/**
 * The composed-art glyph string for a place word (`bedroom` → "room(bed)"), or
 * undefined when the word draws as itself. Session registrations win over the
 * default table.
 */
export function placeArtGlyph(word: string): string | undefined {
  if (!word) return undefined;
  return registered.get(word) ?? DEFAULT_PLACE_ART[word];
}

/**
 * The resolved frame + inner symbol for a place word, or undefined. This is the
 * form renderers want; `drawnSlot` in the compositor is the caller.
 */
export function placeArt(word: string): PlaceArt | undefined {
  if (!word) return undefined;
  if (splitCache.has(word)) return splitCache.get(word);
  const art = placeArtGlyph(word);
  const parsed = art ? split(art) : undefined;
  splitCache.set(word, parsed);
  return parsed;
}

/**
 * Declare (or override) the art for a place word at runtime — the seam for the
 * data the static table cannot know:
 *   - a session's STRUCTURE CATALOGUE (`TownPlayConfig.structures`), whose rows
 *     carry their own `frame`/`symbol`;
 *   - CULTURE-AUTHORED room/building programs (`game.culture.architecture`),
 *     which may rename a kind or flip its shell — the same bath program is a
 *     bathroom in a house and a bathhouse in a town that bathes together.
 * Passing an empty/unparseable art string — or art that IS the word (a spec with
 * no frame, like the bare `building` shell) — removes the registration rather
 * than poisoning the word or pointing it at itself.
 */
export function registerPlaceArt(word: string, art: string | undefined): void {
  if (!word) return;
  const trimmed = art?.trim();
  const parsed = trimmed && trimmed !== word ? split(trimmed) : undefined;
  if (parsed) registered.set(word, trimmed!);
  else registered.delete(word);
  splitCache.delete(word);
}

/** Drop every runtime registration (session teardown, tests). */
export function clearRegisteredPlaceArt(): void {
  for (const word of registered.keys()) splitCache.delete(word);
  registered.clear();
}

/** Every word the DEFAULT table draws — the gate test's subject. */
export function defaultPlaceArtWords(): string[] {
  return Object.keys(DEFAULT_PLACE_ART);
}
