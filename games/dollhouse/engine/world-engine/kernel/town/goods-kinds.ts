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
// ── ONE stack-counting core (unification pass) ─────────────────────────────
//
// Five functions in this module, transfer.ts and scope.ts count units in a
// glyph→count stack, and disagree ON PURPOSE — three match rules, each
// load-bearing for its own caller. This is the ONE arithmetic core; every
// counting function below (plus transfer.ts's `stackUnits`/`stackTotal` and
// scope.ts's `unitsOf`) is a thin, documented call into it. Lives here
// (rather than in transfer.ts or scope.ts) because this is the lower-level
// module: transfer.ts and scope-shape.ts both already sit above it, and
// scope.ts imports it here rather than the reverse to avoid a cycle.

/** The material HEAD of a stack glyph ("wood.wet" → "wood") — the
 *  structures.ts / founding.ts convention: facted variants pay toward and
 *  count toward their head. Canonical home for the HEAD match rule (moved
 *  here from transfer.ts so this counting core can use it without an import
 *  cycle back into transfer.ts); transfer.ts re-exports this under its
 *  original name, so every existing caller of `stackHead` is unaffected.
 *
 *  🚨 A STORED PIECE IS HEADED BY ITS KIND. Furniture stacks under the prefix
 *  `furn.<kind>`, so the plain head made every piece the same material: a bill
 *  for a bed counted the chairs, and `takeStock` for a bed could take one and
 *  install it as the bed. The kind is the first modifier; anything after it
 *  (a colour) is an ordinary facet and still pays toward its kind. */
export function stackHead(glyph: string): string {
  if (glyph.startsWith("furn.")) {
    const kind = glyph.split(".")[1];
    return kind ? `furn.${kind}` : glyph;
  }
  return headOf(glyph);
}

/**
 * WHICH match rule a counting call uses — the three ways this codebase asks
 * "does this stack row count toward what I'm asking for", named so they can
 * never blur together again:
 *
 *  · `head` — HEAD match (`stackHead(row) === stackHead(target)`): a facted
 *    variant counts toward its material/kind (transfer.ts's order and haul
 *    arithmetic — `stackUnits`, and `stackTotal`'s sibling total).
 *  · `prefix` — PREFIX match (`row === target || row.startsWith(target+".")`):
 *    this glyph, or a further-facted EXTENSION of it (scope.ts `unitsOf`).
 *    🚨 Deliberately NOT head-matching: furniture is spelled `furn.<kind>`
 *    with the SAME dot the facet grammar uses, so every piece of furniture
 *    shares the head `furn` — head-matching a bench query would answer yes
 *    for a stored chair, and the bench-first bootstrap would stop on the
 *    first chair the household owned. The prefix rule degrades to exactly
 *    head-matching for an ordinary undotted glyph, so nothing else changes.
 *  · `kinds` — an explicit KIND LIST, exact key membership (this module's own
 *    `stackTotalOf`/`carryTotalOf`): the caller already knows precisely which
 *    stack keys count (a good's kind vocabulary, or its carry projection).
 *  · `all` — every row counts (`stackTotal`/`totalStackUnits`); `clampNegatives`
 *    is the one knob where two near-duplicate totals genuinely disagree — see
 *    those two functions' own docstrings for which is which.
 */
export type UnitSelector =
  | { all: true; clampNegatives?: boolean }
  | { head: string }
  | { prefix: string }
  | { kinds: readonly string[] };

/** Does stack row `rowGlyph` count toward `selector`? The three match rules,
 *  written once — see {@link UnitSelector}. */
export function matchesGlyph(rowGlyph: string, selector: UnitSelector): boolean {
  if ("all" in selector) return true;
  if ("head" in selector) return stackHead(rowGlyph) === stackHead(selector.head);
  if ("prefix" in selector) return rowGlyph === selector.prefix || rowGlyph.startsWith(`${selector.prefix}.`);
  return selector.kinds.includes(rowGlyph);
}

/**
 * THE core: sum a stack's rows matching `selector`. Negative rows clamp to 0
 * for `head`/`prefix` matches and for `{all, clampNegatives: true}` — the
 * defensive floor those original call sites carried (`stackUnits`, `unitsOf`,
 * `stackTotal`). `kinds` matches and a plain `{all}` sum raw values,
 * UNCLAMPED, exactly as `stackTotalOf`/`carryTotalOf`/`totalStackUnits`
 * always did — that difference from `stackTotal` is real and preserved (see
 * `totalStackUnits`'s own docstring).
 */
export function countUnits(stack: Readonly<Record<string, number>>, selector: UnitSelector): number {
  const clamp = "all" in selector ? selector.clampNegatives === true : !("kinds" in selector);
  let n = 0;
  for (const [g, c] of Object.entries(stack)) {
    if (matchesGlyph(g, selector)) n += clamp ? Math.max(0, c) : c;
  }
  return n;
}

/** Total units of a good across its kind stacks — the KIND-LIST selector. */
export const stackTotalOf = (stock: Record<string, number> | undefined, goodKey: string): number =>
  countUnits(stock ?? {}, { kinds: kindsOf(goodKey) });
/** The kinds a body may CARRY of a good — kindsOf plus, for FOOD, the treats.
 *  THE PROJECTION RULE (DEBUG-CREATURE-BEHAVIOR §4): everything that reads a
 *  HAND — ctx.carried, the deposit effect, the carry prop — projects through
 *  THIS list, or a gifted cookie reads as 0 to every row the creature owns and
 *  gets carried forever. Pantry counts and market baskets keep the strict
 *  kindsOf: treats are never dealt into mixes or counted toward provisioning. */
export const carryKindsOf = (goodKey: string): readonly string[] =>
  goodKey === "food" ? [...FOOD_KINDS, ...TREAT_KINDS] : kindsOf(goodKey);
/** Total CARRIED units of a good — the KIND-LIST selector over the carry
 *  projection (stackTotalOf's sibling). */
export const carryTotalOf = (stock: Record<string, number> | undefined, goodKey: string): number =>
  countUnits(stock ?? {}, { kinds: carryKindsOf(goodKey) });
// ── ITEM SIZE — what may ride in a bag at all ──────────────────────────────
//
// A body's HANDS hold exactly ONE item (the thing it is visibly using or
// hauling); everything else it has on it rides in a CONTAINER it carries or
// wears — a basket, a satchel — exactly like any other container
// (scope-unification.md §2.1). The ONE datum that decides what a bag will take
// is SIZE: a fruit, a garment, a toy are SMALL; furniture is LARGE and stays
// hands-only (you carry a chair, you do not put it in a satchel). Default is
// SMALL — stack goods are small by nature, so a new good needs no size row;
// only bulky things opt in.
//
// 🚨 There is NO per-species slot count here any more. `INVENTORY_SLOTS = 6`
// died with `needCarried`: capacity is a fact about what a body is HOLDING
// (containers.ts `ContainerDef.capacity`, folded by scope-shape.ts
// `stackRoom`), never a constant on the creature.

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
  // The work-station furniture (stations.ts STATION_PROPERTIES): an anvil, a
  // loom, an altar and a stonecutter's slab are rooms' worth of iron, timber
  // and dressed stone, not pocket goods — every furniture-property station must
  // appear here (the size-registries-agree conformance test).
  "anvil", "loom", "altar", "stonecutter",
  // The DOOR LEAF (construction phase 5) — furniture you HAUL. A leaf is a slab
  // of block the height of a doorway; a body carries it to the opening in its
  // hands and hangs it there. Nothing about being flat makes it pocketable, and
  // it carries the `furniture` property like every kind above, so the
  // size-registries-agree test demands this row too.
  "door",
];
/** Is this stack glyph too large to go in a creature's inventory? A STORED
 *  furniture piece stacks under `furn.<kind>` (stations.ts furnitureGlyph), so
 *  its head is the bookkeeping prefix, not the kind — and furniture is large by
 *  definition. The head test covers loose props whose stack IS the kind. */
export const isLargeGlyph = (glyph: string): boolean =>
  glyph.startsWith("furn.") || LARGE_KINDS.includes(headOf(glyph));
/** Total units a stack map holds, across every glyph in it — the `all`
 *  selector, UNCLAMPED (raw sum, negatives and all). Distinct from
 *  transfer.ts's `stackUnits(stack, glyph)`, which counts ONE glyph's head;
 *  and from transfer.ts's `stackTotal`, its own near-duplicate total, which
 *  clamps negative rows to 0 — that clamp is the one place the two totals
 *  genuinely disagree, and it is preserved per-name, not merged away. */
export const totalStackUnits = (stock: Record<string, number> | undefined): number =>
  countUnits(stock ?? {}, { all: true });

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
