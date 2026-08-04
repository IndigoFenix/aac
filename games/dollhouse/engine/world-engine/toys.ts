// shared/world-engine/toys.ts
//
// THE TOY REGISTRY — what a toy IS, what it is made of, and the DOLL rule
// (planning-docs/games/world-engine/toys-and-song-expansion.md).
//
// Two families, one mechanic:
//
//   1. AUTHORED toys — a ball, a set of blocks, a puzzle. Their own heads, their
//      own models, nothing else in the world shares the word.
//   2. DOLLS — a miniature of something that already exists. A doll is NOT its
//      own kind: it is the SAME HEAD WORD as the thing it depicts wearing the
//      `toy` FORM facet (variations.ts) — `rabbit.toy` is a toy rabbit, `car.toy`
//      a toy car. That is the whole design: a child asking for a toy rabbit uses
//      the word they already have for a rabbit, and ONE rule covers every
//      creature and vehicle a spec declares instead of a hand-authored doll per
//      species. The form facet's `look` handles the miniaturisation, so a doll
//      renders through the SAME recipe as the real thing.
//
// MATERIALS: wood and cloth only. Both have real natural sources in the
// registry that owns that question (products.ts — wood fells an oak, cloth
// refines from wool, which comes off a sheep you can watch being sheared), so
// "make a cloth rabbit" bottoms out in something visible. PLASTIC is in the
// planning doc and deliberately NOT here: nothing on the planet produces it and
// there is no refine chain to it, and a material that appears from nowhere breaks
// the rule products.ts exists to enforce — that a resource's abstract and visible
// accounts must coincide. Plastic wants an input product and a refining station
// first; it is a resource question, not a toy question.
//
// PURE LEAF like products.ts and variations.ts: the only import is the facet
// taxonomy, so the kernel, the interaction layer and the renderer can all read
// this without a cycle. The JOIN that decides WHICH heads a given world can make
// dolls of is deliberately NOT here — `isDollableHead` takes the candidate set as
// a parameter, and the concept/property bridges (which already hold the species
// registry and the pools) supply it. Specs stay authoritative for their own
// facets; this module only says what a toy is.

import { composeGlyph, facetsOf } from "./variations.js";

/** The FORM facet that marks a glyph as a depiction rather than the thing —
 *  the `form` dimension's one value (variations.ts FORM_DIMENSION). */
export const TOY_FORM_FACET = "toy";

/** Material glyphs a toy may be made OF. Both are real products (module doc);
 *  order is the preference order when an order names no material. */
export const TOY_MATERIALS: readonly string[] = ["wood", "cloth"];

/** The `material_*` VARIATION facet a material glyph rides as on the finished
 *  toy (`cloth` → `material_cloth` — MATERIAL_DIMENSION's value naming). */
export const materialFacetOf = (material: string): string => `material_${material}`;

/**
 * An AUTHORED toy — its own head, with its own model. `materials` is what it can
 * be made of, first = the default; `cost` is units consumed per toy; `at` is the
 * station that SPEEDS the work and NEVER gates it (the FurnitureItemDef law —
 * every craftable thing can be made by hand, just slower).
 */
export interface ToyItemDef {
  head: string;
  materials: readonly string[];
  cost: number;
  at?: string;
}

/**
 * The authored toys. A ball is sewn and stuffed (cloth); blocks and puzzles are
 * cut and shaped (wood) — the material is not decoration, it is what the shape
 * plausibly comes from, so a town with no sheep can still make blocks.
 *
 * Order is load-bearing where toy lists are derived from it (the pool's member
 * order, the surfacer's ordering) — append, don't reorder.
 */
export const TOY_ITEMS: readonly ToyItemDef[] = [
  // WOOD FIRST, EVERYWHERE, and the reason is supply rather than taste: a town's
  // stock actually holds wood and stone; CLOTH is currently produced by nothing
  // (its wool→cloth chain yields none), so a cloth-only recipe is a craft that
  // can be ordered and can never be finished — the job waits on a material that
  // will never exist. A carved ball is perfectly ordinary; cloth stays listed as
  // an alternative so a stuffed one becomes possible the moment the chain runs.
  { head: "ball", materials: ["wood", "cloth"], cost: 1, at: "workbench" },
  { head: "blocks", materials: ["wood"], cost: 1, at: "workbench" },
  { head: "puzzle", materials: ["wood"], cost: 1, at: "workbench" },
] as const;

/** An authored toy's def, or undefined for anything else (including dolls —
 *  a doll has no row, it has the rule). */
export const toyItemOf = (head: string): ToyItemDef | undefined =>
  TOY_ITEMS.find((t) => t.head === head);

/** Every authored toy head, in registry order. */
export const TOY_HEADS: readonly string[] = TOY_ITEMS.map((t) => t.head);

/** A DOLL takes one unit of either material — a rag doll or a carved figure —
 *  and, like every craft, goes faster at the bench. Dolls are a RULE, not rows:
 *  this is the recipe for a doll of ANY head. */
export const DOLL_RECIPE: { materials: readonly string[]; cost: number; at?: string } = {
  materials: TOY_MATERIALS,
  cost: 1,
  at: "workbench",
};

/** The glyph for a DOLL of `head` — the head plus the form facet, canonically
 *  ordered (`rabbit` → `rabbit.toy`). With a material: `rabbit.toy.material_cloth`. */
export function dollGlyph(head: string, material?: string): string {
  const vars = [TOY_FORM_FACET, ...(material ? [materialFacetOf(material)] : [])];
  return composeGlyph(head, vars);
}

/** Is this glyph a DOLL — i.e. does it wear the form facet? (`rabbit.toy` yes,
 *  `rabbit` no, `ball` no — a ball is a toy but it is not a depiction.) */
export const isDollGlyph = (glyph: string): boolean =>
  facetsOf(glyph).variations.includes(TOY_FORM_FACET);

/** What a doll DEPICTS — its head — or null when the glyph isn't a doll. The
 *  inverse of `dollGlyph`, and the reason a doll needs no model of its own: the
 *  renderer builds THIS head's recipe and the form facet shrinks it. */
export const dollHeadOf = (glyph: string): string | null =>
  isDollGlyph(glyph) ? facetsOf(glyph).head : null;

/** Is this glyph a TOY of either family — an authored toy or a doll? The one
 *  predicate the `toy` object property and the fun need's affordance read. */
export const isToyGlyph = (glyph: string): boolean =>
  isDollGlyph(glyph) || TOY_HEADS.includes(facetsOf(glyph).head);

/**
 * May `head` be made into a doll, given the heads this world HAS? A doll is a
 * miniature of something real, so the answer is "yes if the world contains one" —
 * the caller supplies its creature and vehicle heads (the species registry, the
 * vehicle pool), because only the spec side knows what exists. A head that is
 * already a toy is never dollable: there is no toy of a toy.
 */
export function isDollableHead(head: string, depictable: Iterable<string>): boolean {
  if (TOY_HEADS.includes(head)) return false;
  for (const d of depictable) if (d === head) return true;
  return false;
}

/** The materials a toy of `head` can be made from — the authored row's list, or
 *  the doll rule's for anything depictable. Empty when `head` is neither. */
export function toyMaterialsOf(head: string, depictable: Iterable<string>): readonly string[] {
  const def = toyItemOf(head);
  if (def) return def.materials;
  return isDollableHead(head, depictable) ? DOLL_RECIPE.materials : [];
}

/**
 * The craft recipe for one toy of `head` in `material` — input glyphs plus the
 * accelerating station, the exact shape `FurnitureItemDef.craft` carries, so the
 * town's existing craft job (gather → labour → produce, with the construction
 * chain when an input is missing) runs a toy without knowing it is one.
 * Returns null when `head` can't be a toy, or can't be made of that material.
 */
export function toyCraftRecipe(
  head: string,
  material: string,
  depictable: Iterable<string>,
): { at?: string; consumes: Record<string, number>; produces: string } | null {
  const allowed = toyMaterialsOf(head, depictable);
  if (!allowed.includes(material)) return null;
  const def = toyItemOf(head);
  const cost = def?.cost ?? DOLL_RECIPE.cost;
  const at = def?.at ?? DOLL_RECIPE.at;
  // An authored toy IS its head; a doll wears the form facet. Both carry the
  // material they were made of, so a cloth ball and a wooden one differ on sight.
  const produces = def
    ? composeGlyph(head, [materialFacetOf(material)])
    : dollGlyph(head, material);
  return { ...(at ? { at } : {}), consumes: { [material]: cost }, produces };
}

/** The material a toy was MADE of, read back off its glyph — null when it wears
 *  no material facet (an authored toy from before the material rode along, or a
 *  spec-placed one). */
export function toyMaterialOf(glyph: string): string | null {
  for (const v of facetsOf(glyph).variations) {
    if (v.startsWith("material_")) return v.slice("material_".length);
  }
  return null;
}
