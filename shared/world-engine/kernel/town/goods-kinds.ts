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

// FOOD comes in KINDS (fruit): stacks hold kind glyphs under the "food" category,
// and residents' LIKES pick among them (creatures.ts preferredOf). Other goods
// are their own single kind. The kind names are translated glyphs.
export const FOOD_KINDS: readonly string[] = ["apple", "banana", "grape"];
// CLOTHING comes in GARMENT kinds the same way (wardrobes hold shirts and
// dresses, not abstract "clothing" units). A worn garment dirties into its
// `.dirty` STATE VARIANT — a distinct stack key (so it never counts as clean
// clothing) whose HEAD still names the garment (so head-based rules — tidy's
// provisioned-heads skip, evict banking — keep routing it to the clothing
// flow). "laundry" is the CATEGORY of those dirty variants: the laundry
// template's item type.
export const CLOTHING_KINDS: readonly string[] = ["shirt", "dress"];
export const LAUNDRY_KINDS: readonly string[] = CLOTHING_KINDS.map((k) => `${k}.dirty`);
export const kindsOf = (goodKey: string): readonly string[] =>
  goodKey === "food" ? FOOD_KINDS
  : goodKey === "clothing" ? CLOTHING_KINDS
  : goodKey === "laundry" ? LAUNDRY_KINDS
  : goodKey === "meal" ? MEAL_KINDS
  : [goodKey];
export const isKindOf = (glyph: string, goodKey: string): boolean =>
  kindsOf(goodKey).includes(glyph.split(".")[0] ?? glyph);
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
  const head = glyph.split(".")[0] ?? glyph;
  if (FOOD_KINDS.includes(head) || TREAT_KINDS.includes(head)) return "food";
  if (CLOTHING_KINDS.includes(head)) return "clothing";
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
  "bin", "bowl", "bath", "privy", "oven", "refrigerator", "workbench", "shelf",
];
/** Is this stack glyph too large to go in a creature's inventory? */
export const isLargeGlyph = (glyph: string): boolean =>
  LARGE_KINDS.includes(glyph.split(".")[0] ?? glyph);
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
