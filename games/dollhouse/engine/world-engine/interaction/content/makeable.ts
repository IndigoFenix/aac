// shared/world-engine/interaction/content/makeable.ts
//
// THE MAKEABLE JOIN — given a noun SYMBOL, what MOBILE ITEM would "make it"
// produce? The sibling of the structure catalog: `build` raises something that
// stays put, `make` produces something you can pick up, and this module owns the
// second list.
//
// A bridge in the concepts.ts sense (world-engine-board-organization.md §3): the
// three sources stay authoritative for their own facets and this module only
// joins them —
//   • toys.ts        the authored toys and the DOLL rule,
//   • stations.ts    the craftable furniture rows,
//   • species/pools  what EXISTS to be depicted (a doll is a miniature of a real
//                    thing, so the species registry and the vehicle pool decide
//                    which heads can wear the `toy` facet at all).
//
// MAKE vs BUILD (user law, 2026-07-28): the two verbs are INTERCHANGEABLE — both
// reach both kinds of goal, so a child who says the wrong one still gets the
// thing — but they differ in PRIORITY: `make` tries the mobile item first,
// `build` tries the structure first. The priority only decides a word that is
// BOTH; a word that is only one is reached by either verb. That is why this
// module answers "what would make produce" without knowing anything about
// structures: the caller (intent-compile) holds the two answers and picks.

import { listSpecies } from "../../creatures/species.js";
import {
  FURNITURE_ITEMS,
  furnitureGlyph,
  furnitureKindOfGlyph,
  type StationKind,
} from "../../kernel/town/stations.js";
import {
  DOLL_RECIPE,
  dollGlyph,
  isDollableHead,
  materialFacetOf,
  toyCraftRecipe,
  toyItemOf,
  toyMaterialOf,
  toyMaterialsOf,
} from "../../toys.js";
import { composeGlyph, headOf } from "../../variations.js";
import { fixtureKindForWord, fixtureWord } from "../../types.js";
import { POOLS } from "./pools.js";

/**
 * Every head a DOLL can depict — the world's creatures and vehicles.
 *
 * CREATURES come from the POOL AFFORDANCE, not from the species registry. That
 * registry is keyed by BODY PLAN (`quadruped`, `human`, `deer`), while the
 * speakable creature vocabulary is keyed by WORD (`rabbit`, `bear`, `frog`), so
 * `getSpecies("rabbit")` is undefined and a species filter here would silently
 * empty the whole set. What actually means "this word names a creature" is the
 * `receptive-npc` affordance — the pool tag for something you can talk to — so
 * that is what is read. Registered `creature`-kind species join too, which is how
 * the livestock words (deer, sheep, ram, cow) become dollable.
 *
 * VEHICLES come from the vehicle pool; they are the reason `car`/`train`/`boat`
 * keep their `toy` KIND_CATEGORY filing, which is what makes `car.toy` a doll of
 * a real thing rather than a word with nothing behind it.
 *
 * Deterministic: pool authoring order, then registry order.
 */
export function depictableHeads(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (h: string) => {
    if (seen.has(h)) return;
    seen.add(h);
    out.push(h);
  };
  for (const pool of Object.values(POOLS)) {
    if (pool.affordance !== "receptive-npc" && pool.affordance !== "startable-movable") continue;
    for (const m of pool.members) add(m.symbol);
  }
  for (const s of listSpecies()) if (s.kind === "creature" && !s.bodiless) add(s.id);
  return out;
}

/** Craftable furniture kinds, as a set for the head test. */
const CRAFTABLE_FURNITURE: ReadonlySet<string> = new Set(
  FURNITURE_ITEMS.filter((f) => f.craft).map((f) => f.kind),
);

/**
 * The GLYPH "make <symbol>" produces, or null when the symbol names nothing
 * makeable. Three families, checked in order of specificity:
 *
 *   1. an AUTHORED TOY  → the toy, in its default material (`ball.material_cloth`)
 *   2. a CRAFTABLE PIECE of furniture → its unplaced stack glyph (`furn.chair`)
 *   3. anything DEPICTABLE → a DOLL of it (`rabbit.toy.material_cloth`) — this is
 *      "make + animal means make a toy of that animal" (toys-and-song-expansion.md)
 *
 * The material is the recipe's DEFAULT, because no material word is speakable
 * yet: `wood` and `cloth` have no glyph records (they are part of the M4 motif
 * art gap), so an order cannot name one. When those words ship, the caller can
 * pass the named material straight through — that is the whole reason this takes
 * an optional `material` rather than hard-coding the default inside.
 */
export function makeableGlyph(symbol: string, material?: string): string | null {
  const toy = toyItemOf(symbol);
  if (toy) {
    const m = material && toy.materials.includes(material) ? material : toy.materials[0];
    return m ? composeGlyph(symbol, [materialFacetOf(m)]) : symbol;
  }
  // The order arrives as the board's WORD, and `spokenMakeable` below speaks
  // the vocabulary's word for a made piece — so "make + cabinet" has to reach
  // the `cupboard` recipe, or the board offers a word it can't act on.
  const furnKind = fixtureKindForWord(symbol);
  if (CRAFTABLE_FURNITURE.has(furnKind)) return furnitureGlyph(furnKind as StationKind);
  if (isDollableHead(symbol, depictableHeads())) {
    const m =
      material && DOLL_RECIPE.materials.includes(material) ? material : DOLL_RECIPE.materials[0];
    return dollGlyph(symbol, m);
  }
  return null;
}

/** Does "make <symbol>" produce anything? The cheap predicate for the surfacer's
 *  verb→noun filter, without composing the glyph. */
export const isMakeable = (symbol: string): boolean => makeableGlyph(symbol) !== null;

/**
 * The WORD a made glyph is SPOKEN as — the inverse of `makeableGlyph` for
 * dialogue. `furn.chair` → "chair" (a furniture stack's head is the bookkeeping
 * prefix `furn`, not the piece, so `headOf` alone would say "furn");
 * `rabbit.toy.material_cloth` → "rabbit"; `ball.material_cloth` → "ball".
 *
 * A piece speaks the VOCABULARY's word for its kind (`fixtureWord`), exactly as
 * a standing one does: the sim keeps `chest` and `box` apart, the board does not
 * — and a word the glyph registry never heard of is a button with a label and no
 * icon (the `chest`/`cupboard` bug, types.ts FIXTURE_WORD).
 */
export const spokenMakeable = (glyph: string): string => {
  const kind = furnitureKindOfGlyph(glyph);
  return kind ? fixtureWord(kind) : headOf(glyph);
};

/**
 * The GLYPH a stored stack is DRAWN as — what `spokenMakeable` is for words.
 * A furniture stack's `furn.` head is storage bookkeeping with no artwork behind
 * it, so the piece draws as its own vocabulary word (`furn.chest` → `box`);
 * every other stack draws as ITSELF, facets and all, so a red shirt keeps its
 * colour and a hot apple its steam.
 */
export const drawnMakeable = (glyph: string): string =>
  furnitureKindOfGlyph(glyph) ? spokenMakeable(glyph) : glyph;

/**
 * The RECIPE that makes a given glyph — the shape the construction pipeline's
 * craft job runs (inputs, the accelerating station, the finished stack). This is
 * what lets ONE job serve furniture and toys alike: the host resolves a glyph to
 * a recipe here and never learns what kind of thing it is making.
 *
 * Null when the glyph names nothing craftable (a food kind, a raw material, a
 * structure) — the host's honest "I can't make that".
 */
export function craftRecipeOf(
  glyph: string,
): { produces: string; consumes: Record<string, number>; at?: StationKind; label: string } | null {
  const furnKind = furnitureKindOfGlyph(glyph);
  if (furnKind) {
    const def = FURNITURE_ITEMS.find((f) => f.kind === furnKind);
    if (!def?.craft) return null;
    return {
      produces: glyph,
      consumes: def.craft.consumes,
      ...(def.craft.at ? { at: def.craft.at } : {}),
      label: furnKind,
    };
  }
  const head = headOf(glyph);
  const material = toyMaterialOf(glyph) ?? toyMaterialsOf(head, depictableHeads())[0];
  if (!material) return null;
  const recipe = toyCraftRecipe(head, material, depictableHeads());
  if (!recipe) return null;
  return {
    // The ORDER's glyph is what gets made, not the recipe's reconstruction of
    // it: an order that named a colour or a size keeps it.
    produces: glyph,
    consumes: recipe.consumes,
    ...(recipe.at ? { at: recipe.at as StationKind } : {}),
    label: spokenMakeable(glyph),
  };
}

