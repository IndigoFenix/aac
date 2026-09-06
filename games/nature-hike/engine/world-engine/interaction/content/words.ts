// shared/world-engine/interaction/content/words.ts
//
// THE WORD JOINER (user decision 2026-08-12): given a locale, the lexemes of
// every SPEC-DEFINED ITEM, read from the spec side — the same law as
// properties.ts, applied to words. An item's translations live ON ITS OWN
// DEFINITION (`words: ItemWords` on the registry row), so adding an item
// brings its words along in the same edit, instead of touching four central
// language files. The central lexicons (lang/en·he·es·pt) keep what is NOT an
// item: grammar, verbs, adjectives, function words, and the CORE ENGINE
// CONCEPTS (place/room/house/home/water/fire/person… — object-properties.ts
// CORE_CONCEPTS), which have no spec by law and no row to ride.
//
// ONE DEFINITION PER HEAD. The spec is a federation, and several registries
// can name the same head (`box` is a station kind AND a pool member), so the
// sources below are walked in a FIXED precedence order and the first
// definition wins — but a head defined twice is an authoring error, not a
// feature: `duplicateSpecWordHeads()` exists so a conformance test can keep
// the federation honest. Author each item's words in exactly one place:
//   1. FURNITURE — FurnitureItemDef rows (stations.ts), under the SPOKEN word
//      (`fixtureWord`: the chest row folds to "box", so the words for "box"
//      ride the box row and the chest row carries none).
//   2. ROOM PROGRAMS — RoomProgramDef rows (programs.ts), under `word ?? kind`.
//   3. STRUCTURE PROGRAMS — StructureProgramDef rows, under `word ?? type`.
//   4. SPECIES — Species rows (creatures/species.ts), under the species id.
//   5. POOL MEMBERS — PoolMember rows (pools.ts), under the member's head.
//   6. ITEM_WORDS — the catalog below: items whose defining registry is a
//      plain string array (goods-kinds), lives in a file another workstream
//      owns right now (products.ts, town-play.ts), or is a word beside the
//      registry key (`store` beside the store room's "storeroom").
//
// A USER-ADDED ITEM (the coming feature) is the same shape: its record
// carries an ItemWords map and enters through this joiner — one more source,
// no new machinery.
//
// Pure and deterministic: fixed data joined in a fixed order, never the scene.

import type { ItemWords, Lexeme, WordLocale } from "../lang/core.js";
import { headOf } from "../../variations.js";
import { fixtureWord } from "../../types.js";
import { FURNITURE_ITEMS } from "../../kernel/town/stations.js";
import { DEFAULT_ROOM_PROGRAMS, DEFAULT_STRUCTURE_PROGRAMS } from "../../kernel/town/programs.js";
import { listSpecies } from "../../creatures/species.js";
import { POOLS } from "./pools.js";

export type { ItemWords, WordLocale } from "../lang/core.js";

// ---------------------------------------------------------------------------
// The catalog — items with no row of their own to carry words
// ---------------------------------------------------------------------------

/**
 * Materials and natural products (products.ts mints the glyphs but its rows
 * repeat per source — wood grows on the oak AND the apple tree — so the words
 * live here, once per item); the town-play structures (town-play.ts is owned
 * by the town workstream this round — fold these onto StructureSpec rows when
 * that settles); the garment the pools don't list (dress); and the words that
 * stand BESIDE a registry key (`store` — the store room SPEAKS "storeroom",
 * which rides the program row; "store" itself is this entry).
 */
export const ITEM_WORDS: Readonly<Record<string, ItemWords>> = {
  // Materials + natural products (products.ts CATALOGUE / goods-kinds).
  // `wood`/`stone` are mass ("we don't have wood", never "a wood"); `block`
  // and `tree` count. Hebrew's עץ is both the tree and the timber — two
  // entries on purpose: same word, different grammar, which is exactly what
  // the lexeme card is for.
  wood: {
    en: { w: "wood", mass: true },
    he: { w: "עץ", g: "m", mass: true },
    es: { w: "madera", g: "f", mass: true },
    pt: { w: "madeira", g: "f", mass: true },
  },
  stone: {
    en: { w: "stone", mass: true },
    he: { w: "אבן", g: "f", plw: "אבנים", mass: true },
    es: { w: "piedra", g: "f", mass: true },
    pt: { w: "pedra", g: "f", mass: true },
  },
  block: {
    en: { w: "block" },
    he: { w: "לבנה", g: "f", plw: "לבנים" },
    es: { w: "bloque", g: "m" },
    pt: { w: "bloco", g: "m" },
  },
  tree: {
    en: { w: "tree" },
    he: { w: "עץ", g: "m", plw: "עצים" },
    es: { w: "árbol", g: "m", plw: "árboles" },
    pt: { w: "árvore", g: "f" },
  },
  // The wild outcrop, NOT the material: you quarry `stone` out of a `rock`.
  // Two words because they are two things — one is a place in the world you
  // walk to, the other is what ends up in your hands.
  rock: {
    en: { w: "rock" },
    he: { w: "סלע", g: "m" },
    es: { w: "roca", g: "f" },
    pt: { w: "rocha", g: "f" },
  },
  // ── 🌿 THE WILD LARDER (2026-09-04) ────────────────────────────────────
  // The three foods the wilderness scatter's forage plants yield (products.ts:
  // the berry bush, the hazel, the wild onion). They live HERE for the reason
  // this catalog exists — products.ts mints the glyph and its rows repeat per
  // source — and for the reason `carrot`'s comment in species.ts records: with
  // no spec word the CONTAINER BOARD renders the raw English head in he/es/pt,
  // and that miss is invisible to all three validators (no `t()` call, no
  // builder head, and locale files that agree with each other about a key none
  // of them has). The fourth forage food, `mushroom`, already carries its
  // lexemes on its own species row.
  //
  // COUNT NOUNS, all three: you pick a berry, crack a nut, pull an onion.
  // (`berry` is `gargar ya'ar` — "forest grain" — the ordinary Hebrew for a
  // wild berry, and its plural is the form a child will actually meet.)
  berry: {
    en: { w: "berry", plw: "berries" },
    he: { w: "גרגר יער", g: "m", plw: "גרגרי יער" },
    es: { w: "baya", g: "f" },
    pt: { w: "baga", g: "f" },
  },
  nut: {
    en: { w: "nut" },
    he: { w: "אגוז", g: "m", plw: "אגוזים" },
    es: { w: "nuez", g: "f", plw: "nueces" },
    pt: { w: "noz", g: "f", plw: "nozes" },
  },
  onion: {
    en: { w: "onion" },
    he: { w: "בצל", g: "m", plw: "בצלים" },
    es: { w: "cebolla", g: "f" },
    pt: { w: "cebola", g: "f" },
  },
  // The worked materials beside the raw ones. `cloth` and `wool` are what the
  // loom eats and makes; `paper` is the school-side material with no craft row
  // yet. All three are mass, like wood and stone.
  cloth: {
    en: { w: "cloth", mass: true },
    he: { w: "בד", g: "m", mass: true },
    es: { w: "tela", g: "f", mass: true },
    pt: { w: "tecido", g: "m", mass: true },
  },
  wool: {
    en: { w: "wool", mass: true },
    he: { w: "צמר", g: "m", mass: true },
    es: { w: "lana", g: "f", mass: true },
    pt: { w: "lã", g: "f", mass: true },
  },
  paper: {
    en: { w: "paper", mass: true },
    he: { w: "נייר", g: "m", mass: true },
    es: { w: "papel", g: "m", mass: true },
    pt: { w: "papel", g: "m", mass: true },
  },
  // ── AAC PLACE STUBS (2026-08-24) ─────────────────────────────────────────
  // The places a child's week actually contains, which the town has no PROGRAM
  // for yet (a program derives a building from the rooms in it, and none of
  // these derive from anything the generator builds today). They live here for
  // the same reason the town-play structures above do: the word is real and
  // needed now, the spec row lands when the workstream that owns those places
  // gets to them (planning-docs/sentence-builder-default-vocabulary.md §9 W3).
  school: {
    en: { w: "school" },
    he: { w: "בית ספר", g: "m", plw: "בתי ספר" },
    es: { w: "escuela", g: "f" },
    pt: { w: "escola", g: "f" },
  },
  park: {
    en: { w: "park" },
    he: { w: "פארק", g: "m" },
    es: { w: "parque", g: "m" },
    pt: { w: "parque", g: "m" },
  },
  playground: {
    en: { w: "playground" },
    he: { w: "גן משחקים", g: "m", plw: "גני משחקים" },
    es: { w: "parque infantil", g: "m", plw: "parques infantiles" },
    pt: { w: "parquinho", g: "m" },
  },
  garden: {
    en: { w: "garden" },
    he: { w: "גינה", g: "f" },
    es: { w: "jardín", g: "m", plw: "jardines" },
    pt: { w: "jardim", g: "m", plw: "jardins" },
  },
  // Town-play structures (town-play.ts TOWN_PLAY_STRUCTURES).
  farm: {
    en: { w: "farm" },
    he: { w: "חווה", g: "f", plw: "חוות" },
    es: { w: "granja", g: "f" },
    pt: { w: "fazenda", g: "f" },
  },
  market: {
    en: { w: "market" },
    he: { w: "שוק" },
    es: { w: "mercado" },
    pt: { w: "mercado" },
  },
  storehouse: {
    en: { w: "storehouse" },
    he: { w: "מחסן", g: "m" },
    es: { w: "almacén", g: "m", plw: "almacenes" },
    pt: { w: "armazém", g: "m", plw: "armazéns" },
  },
  well: {
    en: { w: "well" },
    he: { w: "באר", g: "f" },
    es: { w: "pozo", g: "m" },
    pt: { w: "poço", g: "m" },
  },
  // The garment CLOTHING_HEADS carries that no pool member row does.
  dress: {
    en: { w: "dress" },
    he: { w: "שמלה", g: "f" },
    es: { w: "vestido", g: "m" },
    pt: { w: "vestido", g: "m" },
  },
  // The shop-sense word beside the store ROOM's "storeroom".
  store: {
    en: { w: "store" },
    he: { w: "חנות", g: "f" },
    es: { w: "tienda", g: "f", plw: "tiendas" },
    pt: { w: "loja", g: "f" },
  },
};

/**
 * THE PLACE WORDS WITH NO PROGRAM ROW (2026-08-24) — heads defined in
 * `ITEM_WORDS` above that name a PLACE rather than a thing, so the sentence
 * board offers them as places (`affords: ["go"]`, drawn as themselves) instead
 * of as objects.
 *
 * Two reasons a place lands here rather than on a `StructureProgramDef`:
 *  - THE TOWN CANNOT RAISE IT (school, park, playground). A structure program
 *    derives a building from the rooms inside it and none of these derive from
 *    anything the generator raises. The word, the icon and the four
 *    translations are real; the row graduates when the town workstream models
 *    the place, and its words move onto the program row (a head is defined
 *    once).
 *  - THE TOWN RAISES IT FROM ANOTHER FILE (farm, market, storehouse — the
 *    `TOWN_PLAY_STRUCTURES` catalog, whose rows live in `town-play.ts`, a file
 *    another workstream owns; that is exactly why their words are in
 *    `ITEM_WORDS` above rather than on their specs). ⚖️ ONE WORD BANK (user
 *    law, 2026-09-06): these three used to reach a board ONLY through
 *    `pushKnownNouns`, which pushed them at a town or a founded site and
 *    nowhere else — so a child could say "market" in one session and not in
 *    the next. They are default vocabulary now; the host pushes names only.
 *    All three already draw (`glyph-place-art.ts`: building(grain) /
 *    building(money) / building(box)).
 */
export const PLACE_STUBS: readonly string[] = [
  "school", "park", "playground",
  "farm", "market", "storehouse",
];
// `garden` is authored above and deliberately NOT here: it has no bundled
// artwork yet, and a place button with no picture is a blank one. It joins the
// list when the art queue reaches it (`npm run validate-glyphs:art`).
// `well` and `store` likewise wait on a decision about which sense ships.

/**
 * THE THING WORDS WITH NO REGISTRY ROW (2026-09-06) — `PLACE_STUBS`' sibling:
 * heads defined in `ITEM_WORDS` above that name an OBJECT and belong on the
 * sentence board, but whose defining registry is a plain string array or a file
 * another workstream owns, so no station / program / species / pool row carries
 * them and the builder's spec walk cannot find them.
 *
 * ⚖️ ONE WORD BANK (user law, 2026-09-06). Every one of these was a word the
 * quest host pushed from inside a scope — the build materials at a town or a
 * founded site, the wardrobe garment inside a dollhouse — so the same child had
 * them on Monday's board and not on Tuesday's. The bank does not move with the
 * session: they are default vocabulary, and the host pushes names only.
 *
 * ART IS THE ENTRY GATE, exactly as it is for `PLACE_STUBS` and for
 * `KIND_CATEGORY` (pools.ts `paper`): a button with no picture is a blank one.
 * `wood` 🪵, `stone` 🪨 and `block` 🧱 resolve through `emoji-registry`; `dress`
 * has a glyph-registry row of its own. `cloth`, `wool`, `rock` and `paper`
 * deliberately stay out — the first two have no artwork, `rock` is the wild
 * outcrop rather than a thing in hand, and `paper` is already default
 * vocabulary through its `KIND_CATEGORY` tag.
 */
export const ITEM_STUBS: readonly string[] = ["wood", "stone", "block", "dress"];

// ---------------------------------------------------------------------------
// The joiner
// ---------------------------------------------------------------------------

/** Every (head, words) pair the spec declares, in precedence order. */
function* specWordEntries(): Generator<readonly [string, ItemWords]> {
  for (const f of FURNITURE_ITEMS) {
    if (f.words) yield [fixtureWord(f.kind), f.words];
  }
  for (const r of DEFAULT_ROOM_PROGRAMS) {
    if (r.words) yield [headOf(r.word ?? r.kind), r.words];
  }
  for (const s of DEFAULT_STRUCTURE_PROGRAMS) {
    if (s.words) yield [headOf(s.word ?? s.type), s.words];
  }
  for (const sp of listSpecies()) {
    if (sp.words) yield [sp.id, sp.words];
  }
  for (const pool of Object.values(POOLS)) {
    for (const m of pool.members) {
      if (m.words) yield [headOf(m.symbol), m.words];
    }
  }
  for (const [head, words] of Object.entries(ITEM_WORDS)) {
    yield [head, words];
  }
}

/** The spec's word overlay for one ruleset: head → lexeme, first source wins.
 *  Only locales an item actually authors appear — a missing locale keeps the
 *  ruleset's own fallback (`baseWord`'s raw head), exactly as before. */
export function specWords(locale: WordLocale): Record<string, Lexeme> {
  const out: Record<string, Lexeme> = {};
  for (const [head, words] of specWordEntries()) {
    const lex = words[locale];
    if (lex && !(head in out)) out[head] = lex;
  }
  return out;
}

/** Every head the spec defines words for (any locale). */
export function specWordHeads(): Set<string> {
  const out = new Set<string>();
  for (const [head] of specWordEntries()) out.add(head);
  return out;
}

/** Heads defined by MORE than one source — authoring errors for the
 *  conformance pin (one definition per head, precedence never a tiebreak). */
export function duplicateSpecWordHeads(): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const [head] of specWordEntries()) {
    if (seen.has(head)) dup.add(head);
    seen.add(head);
  }
  return [...dup].sort();
}
