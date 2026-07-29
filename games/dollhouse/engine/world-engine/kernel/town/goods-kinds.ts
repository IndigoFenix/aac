// shared/world-engine/kernel/town/goods-kinds.ts
//
// THE STACK-KIND VOCABULARY — which glyphs a GOOD comes in, and the two
// projections everything counts hands and boxes through. Extracted from
// quest-host (which stays the only mutator of stacks) so the pure rules are
// importable without the 3D host: tests and future headless harnesses read
// the SAME vocabulary the live loop runs.
//
// Items are FUNGIBLE STACKS (§12b): a container/hand is a glyph→count map.
// A glyph's HEAD (before the first `.`) names the kind; dotted FACETS are
// state variants (`shirt.dirty`, `apple.hot`) — distinct stack keys whose
// head still routes them to their good's flow.

import { RARE_IMPORT_KIND } from "./trade.js";
import { GARMENT_WEARABLE_HEADS, GARMENT_COLORS } from "../../creatures/clothing.js";
import { headOf, variantKindsOf } from "../../variations.js";
import { foodGlyphs } from "../../products.js";

/** WHICH GOOD VARIES IN WHICH variation dimension(s) — the generic replacement
 *  for hand-writing each good's `head × values` product. Clothing varies in
 *  COLOUR today; a future material good (furniture) adds `["material"]` here and
 *  its kinds enumerate automatically (no head-conflation surface to re-audit).
 *  A good absent from this map has no variation dimension (fruit, water). */
export const GOOD_DIMENSIONS: Record<string, readonly string[]> = {
  clothing: ["color"],
};

// FOOD comes in KINDS (fruit): stacks hold kind glyphs under the "food" category,
// and residents' LIKES pick among them (creatures.ts preferredOf). Other goods
// are their own single kind. The kind names are translated glyphs — DERIVED
// from the natural-sources registry (products.ts): the orchard plants' harvest
// yields ARE the food kinds, so the vocabulary and the living sources can
// never disagree. Registry order is pinned (likes hash by index).
export const FOOD_KINDS: readonly string[] = foodGlyphs();
// CLOTHING comes in GARMENT kinds the same way, and each garment now carries a
// COLOUR as a facet (`shirt.color_red`) — so a clothing KIND is a (head × colour)
// pair, exactly like fruit is a kind of food. `CLOTHING_HEADS` names the bare
// garments (shirt/dress) for head-based routing; `CLOTHING_KINDS` is the full
// coloured product every count/deal/carry projection enumerates through
// (`kindsOf` → `stackTotalOf`/`splitStock`/`carryKindsOf`/`kindOrder`). The
// palette + heads live in creatures/clothing.ts (the garment-appearance owner);
// a culture can narrow the palette later (Phase 2). A worn garment dirties into
// its `.dirty` STATE VARIANT — a distinct stack key `shirt.color_red.dirty` (so
// it never counts as clean clothing) whose HEAD still names the garment (so
// head-based rules — tidy's provisioned-heads skip, evict banking — keep routing
// it to the clothing flow; the colour is a MIDDLE facet, untouched by the wash's
// `dirty` drop). "laundry" is the CATEGORY of those dirty variants: the laundry
// template's item type.
export const CLOTHING_HEADS: readonly string[] = GARMENT_WEARABLE_HEADS;
/** The clothing stack-kind vocabulary — every garment head × the colour
 *  dimension, via the GENERIC variant enumeration (variations.ts). Same result
 *  as the old hand-written `head × colour` product, but now one code path with
 *  every other varying good. */
export const CLOTHING_KINDS: readonly string[] = CLOTHING_HEADS.flatMap((h) =>
  variantKindsOf(h, GOOD_DIMENSIONS.clothing!, { color: GARMENT_COLORS }),
);
export const LAUNDRY_KINDS: readonly string[] = CLOTHING_KINDS.map((k) => `${k}.dirty`);
/** Is this glyph a DIRTY garment (the laundry category), colour and facet-order
 *  tolerant — a garment head plus a `dirty` state facet anywhere in it. Robust
 *  where an exact `LAUNDRY_KINDS.includes` would miss a colourless or
 *  differently-ordered authored glyph. */
export const isLaundryGlyph = (glyph: string): boolean =>
  CLOTHING_HEADS.includes(headOf(glyph)) && glyph.split(".").slice(1).includes("dirty");
export const kindsOf = (goodKey: string): readonly string[] =>
  goodKey === "food" ? FOOD_KINDS
  : goodKey === "clothing" ? CLOTHING_KINDS
  : goodKey === "laundry" ? LAUNDRY_KINDS
  : goodKey === "meal" ? MEAL_KINDS
  : [goodKey];
export const isKindOf = (glyph: string, goodKey: string): boolean => {
  // Clothing kinds are (head × colour) pairs, so a glyph's HEAD (never its full
  // coloured key) is what names its garment; laundry is head + a `dirty` facet.
  // Other goods' kinds ARE their heads (fruit) — the plain membership test.
  if (goodKey === "clothing") return CLOTHING_HEADS.includes(headOf(glyph));
  if (goodKey === "laundry") return isLaundryGlyph(glyph);
  return kindsOf(goodKey).includes(headOf(glyph));
};
/** TREATS: rare imported food kinds — never dealt into pantry mixes or counted
 *  toward provisioning, but they ARE food (a gifted cookie satisfies a food
 *  want, and a hungry soul will eat one from its hand). */
export const TREAT_KINDS: readonly string[] = [RARE_IMPORT_KIND];
// MEALS (round 7): COOKED food — a raw kind's `.hot` STATE VARIANT, the
// laundry pattern over the cook's transform (the oven ADDS the facet;
// treats bake too — a hot cookie is a meal). "meal" is the CATEGORY of
// the hot variants: the serve template's item type, DISJOINT from "food"
// so the pantry/market vocabulary never deals or counts cooked units —
// and the type change at the oven is itself the cook → serve handoff.
export const MEAL_KINDS: readonly string[] = [...FOOD_KINDS, ...TREAT_KINDS].map((k) => `${k}.hot`);
/** The GOOD a stack glyph belongs to (apple → food; cookie → food; shirt →
 *  clothing — and shirt.dirty too: the head routes, so a dirty garment banks
 *  into the wardrobe chest, not a phantom laundry box). */
export const goodKeyOfGlyph = (glyph: string): string => {
  const head = headOf(glyph);
  if (FOOD_KINDS.includes(head) || TREAT_KINDS.includes(head)) return "food";
  if (CLOTHING_HEADS.includes(head)) return "clothing";
  return head;
};
/** Total units of a good across its kind stacks. */
export const stackTotalOf = (stock: Record<string, number> | undefined, goodKey: string): number =>
  kindsOf(goodKey).reduce((s, k) => s + (stock?.[k] ?? 0), 0);
/** The kinds a body may CARRY of a good — kindsOf plus, for FOOD, the treats.
 *  THE PROJECTION RULE (DEBUG-CREATURE-BEHAVIOR §4): everything that reads a
 *  HAND — ctx.carried, the deposit effect, the carry prop — projects through
 *  THIS list, or a gifted cookie reads as 0 to every row the creature owns and
 *  gets carried forever. Pantry counts and market baskets keep the strict
 *  kindsOf: treats are never dealt into mixes or counted toward provisioning. */
export const carryKindsOf = (goodKey: string): readonly string[] =>
  goodKey === "food" ? [...FOOD_KINDS, ...TREAT_KINDS] : kindsOf(goodKey);
/** Total CARRIED units of a good — stackTotalOf over the carry projection. */
export const carryTotalOf = (stock: Record<string, number> | undefined, goodKey: string): number =>
  carryKindsOf(goodKey).reduce((s, k) => s + (stock?.[k] ?? 0), 0);
// ── ITEM SIZE — what may ride in the hidden INVENTORY ──────────────────────
//
// A body's HANDS hold exactly ONE item (the thing it is visibly using or
// hauling); everything else it has on it rides in a hidden INVENTORY — a bag
// it may reach into at any time, exactly like a container. The ONE datum that
// decides what the bag will take is SIZE: a fruit, a garment, a toy are
// SMALL; furniture is LARGE and stays hands-only (you carry a chair, you do
// not pocket it). Default is SMALL — stack goods are small by nature, so a new
// good needs no size row; only bulky things opt in.

/** Glyph HEADS that are too big for a bag — the furniture/fixture kinds
 *  (stations.ts `StationKind` + the fixtures that render as world props).
 *  Named here rather than imported so the stack vocabulary keeps its "bottom
 *  of the kernel" position; town-stations.test.ts pins the two in sync. */
export const LARGE_KINDS: readonly string[] = [
  "bed", "table", "chair", "chest", "cupboard", "barrel", "box",
  "bin", "bowl", "bath", "toilet", "oven", "refrigerator", "workbench", "shelf",
  // The VOCABULARY's word for the cupboard kind (types.ts FIXTURE_WORD) — a
  // piece reaches the stack vocabulary as the word it is spoken by, and a
  // cabinet is no more pocketable than the cupboard it names.
  "cabinet",
];
/** Is this stack glyph too large to go in a creature's inventory? A STORED
 *  furniture piece stacks under `furn.<kind>` (stations.ts furnitureGlyph), so
 *  its head is the bookkeeping prefix, not the kind — and furniture is large by
 *  definition. The head test covers loose props whose stack IS the kind. */
export const isLargeGlyph = (glyph: string): boolean =>
  glyph.startsWith("furn.") || LARGE_KINDS.includes(headOf(glyph));
/** How many SMALL items a body may keep on it (hands + bag). The bound is what
 *  makes a shopping trip a real decision — a full bag is a legible reason a
 *  creature can SAY ("I can't carry any more") instead of hoarding the market.
 *  Bodies differ later (species/child); one constant until they need to. */
export const INVENTORY_SLOTS = 6;
/** Total units a stack map holds, across every glyph in it. (Distinct from
 *  transfer.ts's `stackUnits(stack, glyph)`, which counts ONE glyph.) */
export const totalStackUnits = (stock: Record<string, number> | undefined): number =>
  Object.values(stock ?? {}).reduce((s, n) => s + n, 0);
/** Room left in a body's inventory, given everything already on it. */
export const inventoryRoom = (carried: Record<string, number> | undefined): number =>
  Math.max(0, INVENTORY_SLOTS - totalStackUnits(carried));

/** Deal `n` units of a good across its kinds, deterministically (salt varies the mix). */
export function splitStock(goodKey: string, n: number, salt: number): Record<string, number> {
  const kinds = kindsOf(goodKey);
  const out: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const k = kinds[(salt + i) % kinds.length]!;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
