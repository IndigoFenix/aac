// shared/world-engine/interaction/content/vocab-order.ts
//
// WHERE A NOUN STANDS IN THE VOCABULARY — read off the SPEC, never off a list
// of its own.
//
// THE RULE THIS EXISTS FOR (user law, 2026-08-24): almost every noun — its
// context, its icon, its translations and what it does — comes from the game
// spec, because that is also where clinicians will inject new ones, and a
// noun's physical parameters are what decide both its game role and where it
// appears on a board. A hand-written list of specific nouns anywhere else is a
// SECOND SOURCE OF TRUTH, and the two drift: the board ends up ranking a word
// the game has never heard of, or ignoring one a clinician just added.
//
// So the order is DERIVED. Every registry that can define a noun is walked in
// a fixed precedence, and a noun's position in that walk is its default rank:
//
//   1. CATEGORY WORDS  — the general nouns (`food`, `drink`, `toy`, `place`…).
//      The only nouns that legitimately live in a list here, because they name
//      the CLASSES rather than any member of them: they have no spec row to
//      ride (they are not objects), they are what the group chips are labelled
//      with, and they are sayable in their own right — "I want food" is a
//      complete request, and often the one a child can reach fastest.
//   2. CORE CONCEPTS  — the frame words with no spec row by law (home, person,
//      water, and the kinship words a child names people by).
//   3. POOLS          — the taught vocabulary (pools.ts), authored child-first:
//      treats, drinks, staples, toys, friends, containers… Its declaration
//      order IS the priority statement, which is why the everyday food and
//      drink stubs were inserted beside the treats rather than appended.
//   4. SPECIES        — the animals a sentence can name (a species row without
//      `words` is a body the world builds, not a word a child says).
//   5. PLACES         — structure programs, then room programs.
//   6. FURNITURE      — the built world's fixtures (stations.ts).
//   7. ITEM_WORDS     — the catalog for items whose defining registry cannot
//      carry words (materials, the town-play structures, the place stubs).
//
// Pure and deterministic: fixed registries walked in a fixed order, never the
// scene. Adding a spec row adds the word AND its rank in one edit — which is
// the whole point.

import { POOLS } from "./pools.js";
import { ITEM_WORDS } from "./words.js";
import { DEFAULT_ROOM_PROGRAMS, DEFAULT_STRUCTURE_PROGRAMS } from "../../kernel/town/programs.js";
import { FURNITURE_ITEMS, NEED_STATIONS, type StationKind } from "../../kernel/town/stations.js";
import { listSpecies } from "../../creatures/species.js";
import { CORE_CONCEPTS, OBJECT_PROPERTIES } from "../../object-properties.js";
import { fixtureWord } from "../../types.js";
import { headOf } from "../../variations.js";

/**
 * THE GENERAL NOUNS — the category words, which are the only "prototype nouns"
 * there really are (user framing, 2026-08-24). Each names a class of things
 * rather than a thing, so no spec row owns it; every one is already a lang-layer
 * word (the group chips wear them) and every one is sayable on its own.
 *
 * The object properties in their own display order, then the kind words the
 * noun library files things under.
 */
export const CATEGORY_NOUNS: readonly string[] = [
  ...OBJECT_PROPERTIES,
  "thing",
  "place",
  "person",
  "people",
  "animal",
];

/** Every noun the spec defines, in the precedence walk described above. First
 *  appearance wins — a head named by two registries keeps its earliest rank. */
export const SPEC_NOUN_ORDER: readonly string[] = (() => {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (head: string | undefined) => {
    if (!head) return;
    const h = headOf(head);
    if (!h || seen.has(h)) return;
    seen.add(h);
    out.push(h);
  };

  for (const c of CATEGORY_NOUNS) push(c);
  // The CORE ENGINE CONCEPTS — the frame words (home, room, person, mom, water)
  // that have no spec row BY LAW and so cannot be reached by any walk below.
  // They rank high on purpose: a child names a mother and a home far more often
  // than a barrel, and no registry order would ever say so.
  for (const c of CORE_CONCEPTS) push(c);
  for (const pool of Object.values(POOLS)) for (const m of pool.members) push(m.symbol);
  for (const sp of listSpecies()) if (sp.words) push(sp.id);
  for (const b of DEFAULT_STRUCTURE_PROGRAMS) push(b.word ?? b.type);
  for (const r of DEFAULT_ROOM_PROGRAMS) push(r.word ?? r.kind);
  for (const f of FURNITURE_ITEMS) push(fixtureWord(f.kind));
  for (const h of Object.keys(ITEM_WORDS)) push(h);

  return out;
})();

const RANK: ReadonlyMap<string, number> = new Map(SPEC_NOUN_ORDER.map((h, i) => [h, i] as const));

/**
 * A noun's default position, lower first. `Number.MAX_SAFE_INTEGER` for a head
 * no registry defines — a word the world does not know, which sorts last and
 * should be reported rather than ranked (a game host's scene noun is the
 * legitimate case; anything else is a spec gap).
 */
export const nounRank = (head: string): number =>
  RANK.get(headOf(head)) ?? Number.MAX_SAFE_INTEGER;

/**
 * THE WORDS A BODILY NEED IS ASKED FOR BY — the stations `NEED_STATIONS` names,
 * spoken as the words the board uses. A desire board keeps these one press away
 * whatever else it is withholding: "I need the toilet" is a complete sentence,
 * and the one a child cannot afford to page for.
 */
export const NEED_NOUNS: ReadonlySet<string> = new Set(
  Object.keys(NEED_STATIONS).map((kind) => headOf(fixtureWord(kind as StationKind))),
);

/**
 * WHICH KIND OF PLACE — the sub-category a place word belongs to, read off the
 * repository that declares it: a ROOM program makes a room, a STRUCTURE program
 * a building, and a place word with neither (the `PLACE_STUBS`: school, park,
 * playground) is somewhere you go OUTSIDE both.
 *
 * The `go` board is the one board that is all places and nothing else — 22 of
 * them — and "rooms · buildings · outside" is the split a child can actually
 * navigate. Ids are lang-layer words already (`room`, `building`, `outside` are
 * core concepts), so the chips localize with no new vocabulary.
 */
export function placeGroupOf(head: string): "room" | "building" | "outside" {
  const h = headOf(head);
  if (DEFAULT_STRUCTURE_PROGRAMS.some((b) => headOf(b.word ?? b.type) === h)) return "building";
  if (DEFAULT_ROOM_PROGRAMS.some((r) => headOf(r.word ?? r.kind) === h)) return "room";
  return "outside";
}

/** Does the spec define this noun at all? (The conformance question, separate
 *  from the ranking one.) */
export const isSpecNoun = (head: string): boolean => RANK.has(headOf(head));
