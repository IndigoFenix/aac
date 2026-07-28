// shared/world-engine/variations.ts
//
// THE CANONICAL FACET TAXONOMY for item glyphs — the one module every layer
// imports to read a composed glyph, so head-routing never re-derives a head and
// mis-handles a facet (the class of bug that made the tidy chore livelock on
// coloured clothing). It imports NOTHING from the engine (a pure data + function
// leaf), so clothing, goods-kinds and object-models can all sit above it without
// a cycle.
//
// A glyph is `head.facet1.facet2…`:
//   • HEAD       — the KIND (what the thing IS: shirt, chair, apple). Every
//                  good / affordance / routing / tidy decision keys off the head.
//   • VARIATIONS — orthogonal DESCRIPTOR dimensions (form, colour, size, material)
//                  that make distinct, stackable variants but do NOT change the
//                  kind. A red shirt and a blue shirt are two variants of one kind;
//                  a toy rabbit is a variant of `rabbit`, not a kind called "doll".
//   • STATES     — transient conditions (dirty, hot, open…) a transform adds or
//                  removes. The mutable facet dimension.
//
// Variations vs states is the split `glyphFacets`/`parseDescriptors` used to make
// independently; this module is now their shared source of truth.

// ── Head ────────────────────────────────────────────────────────────────────

/** The KIND head of a composed glyph (`shirt.color_red.dirty` → `shirt`). The
 *  ONE head extractor — never inline `.split(".")[0]` at a routing site. */
export function headOf(glyph: string): string {
  return glyph.split(".")[0] ?? glyph;
}

// ── State facets ─────────────────────────────────────────────────────────────

/** Transient conditions a transform adds/removes (behavior/creatures.ts
 *  re-exports this as `STATE_TAGS`). Everything dotted that is NOT one of these
 *  and NOT a known variation value is still treated as a state by default (a new
 *  condition is transient until proven a variation). */
export const STATE_FACETS: ReadonlySet<string> = new Set([
  "hot", "cold", "clean", "dirty", "wet", "dry",
  "smelly",
  "on", "off", "open", "closed",
]);

// ── Variation dimensions ─────────────────────────────────────────────────────

/** How a single variation facet looks, as plain (THREE-free) data — object-models
 *  turns this into materials/scale. `scale` composes multiplicatively across
 *  facets; `hex`/`roughness`/`metalness` are last-wins. */
export interface FacetAppearance {
  hex?: string;
  scale?: readonly [number, number, number];
  roughness?: number;
  metalness?: number;
}

export interface VariationDimension {
  key: string;
  /** The facet glyphs this dimension can take (order is stable — enumerations
   *  and index spaces depend on it). */
  values: readonly string[];
  /** value glyph → its appearance contribution. */
  look: Record<string, FacetAppearance>;
}

/** COLOUR — the board's 10 (+gray) `color_*` glyphs. The single colour palette
 *  the flat prop tint (object-models), the garment shades (clothing.ts, richer
 *  fabric+accent keyed by these) and the house-wall matcher (directions.ts) all
 *  draw from. The curated dress default keeps the first four. */
export const COLOR_DIMENSION: VariationDimension = {
  key: "color",
  values: [
    "color_red", "color_blue", "color_green", "color_yellow",
    "color_orange", "color_purple", "color_pink", "color_brown",
    "color_black", "color_white", "color_gray",
  ],
  look: {
    color_red: { hex: "#DC2626" }, color_orange: { hex: "#EA580C" }, color_yellow: { hex: "#FACC15" },
    color_green: { hex: "#16A34A" }, color_blue: { hex: "#2563EB" }, color_purple: { hex: "#9333EA" },
    color_pink: { hex: "#EC4899" }, color_brown: { hex: "#92400E" }, color_black: { hex: "#111827" },
    color_white: { hex: "#F3F4F6" }, color_gray: { hex: "#6B7280" },
  },
};

/** SIZE — the exaggerated per-axis scale modifiers (unifies object-models
 *  `SIZE_SCALE`). Multiple compose. */
export const SIZE_DIMENSION: VariationDimension = {
  key: "size",
  values: ["big", "small", "tall_high", "short_low", "length_long", "length_short", "wide", "thin"],
  look: {
    big: { scale: [1.7, 1.7, 1.7] }, small: { scale: [0.5, 0.5, 0.5] },
    tall_high: { scale: [1, 1.8, 1] }, short_low: { scale: [1, 0.55, 1] },
    length_long: { scale: [1.8, 1, 1] }, length_short: { scale: [0.55, 1, 1] },
    wide: { scale: [1, 1, 1.8] }, thin: { scale: [1, 1, 0.5] },
  },
};

/** MATERIAL — the registered PLUG (foundation scope): a full appearance dimension
 *  (base tint + PBR roughness/metalness) ready for furniture/tools to opt into.
 *  No good declares it yet (goods-kinds `GOOD_DIMENSIONS`), so nothing enumerates
 *  material variants — but `material_*` on a glyph already renders. */
export const MATERIAL_DIMENSION: VariationDimension = {
  key: "material",
  values: ["material_wood", "material_iron", "material_stone", "material_cloth", "material_gold"],
  look: {
    material_wood: { hex: "#8a6238", roughness: 0.85, metalness: 0 },
    material_iron: { hex: "#8a919c", roughness: 0.4, metalness: 0.6 },
    material_stone: { hex: "#9a968f", roughness: 0.95, metalness: 0 },
    material_cloth: { hex: "#c9bfa8", roughness: 0.9, metalness: 0 },
    material_gold: { hex: "#d4af37", roughness: 0.3, metalness: 0.85 },
  },
};

/**
 * FORM — what a thing is a REPRESENTATION of rather than an instance of. Today
 * one value: `toy`, the DOLL facet (toys-and-song-expansion.md). A doll is not
 * its own kind — it is the SAME head word as the thing it depicts, wearing this
 * descriptor: `rabbit.toy` is a toy rabbit, `car.toy` a toy car. That is what
 * keeps a doll speakable with a word the child already has, and what lets one
 * rule cover every creature and vehicle in the spec instead of a hand-written
 * doll per species.
 *
 * The `look` carries the MINIATURISATION, because a doll's whole visual claim is
 * "the same shape, small": loose item props all spawn at a uniform ~0.3 m radius
 * regardless of glyph, so without a scale here a toy rabbit would be built at
 * life size by the very recipe that makes it recognisable. 0.4 of the prop radius
 * lands a ~24 cm doll — small in the hand, still legible on the floor. Matte
 * roughness reads as stuffed/carved rather than live.
 *
 * FIRST in the dimension order deliberately: form sits immediately after the
 * head (`rabbit.toy.material_cloth`), so the descriptor that changes WHAT THE
 * THING IS is never buried behind a colour.
 */
export const FORM_DIMENSION: VariationDimension = {
  key: "form",
  values: ["toy"],
  look: {
    toy: { scale: [0.4, 0.4, 0.4], roughness: 0.9, metalness: 0 },
  },
};

/** Every variation dimension, keyed by dimension key. Order is CANONICAL GLYPH
 *  ORDER (composeGlyph sorts by it) — form, then colour, size, material. */
export const VARIATION_DIMENSIONS: Record<string, VariationDimension> = {
  form: FORM_DIMENSION,
  color: COLOR_DIMENSION,
  size: SIZE_DIMENSION,
  material: MATERIAL_DIMENSION,
};

/** The dimension a given variation VALUE belongs to (`color_red` → "color"). */
export const DIMENSION_OF_VALUE: ReadonlyMap<string, string> = new Map(
  Object.values(VARIATION_DIMENSIONS).flatMap((d) => d.values.map((v) => [v, d.key] as const)),
);

/** All known variation facet values across every dimension. */
export const VARIATION_VALUES: ReadonlySet<string> = new Set(DIMENSION_OF_VALUE.keys());

/** Is this facet a known variation value (vs a state / unknown)? */
export const isVariationFacet = (facet: string): boolean => VARIATION_VALUES.has(facet);
/** Is this facet a transient state? */
export const isStateFacet = (facet: string): boolean => STATE_FACETS.has(facet);

// ── The split ────────────────────────────────────────────────────────────────

export interface GlyphFacets {
  head: string;
  /** Variation facets, in glyph order (colour/size/material values). */
  variations: string[];
  /** State facets, in glyph order (dirty/hot/…). */
  states: string[];
}

/** Split a composed glyph into head + variations + states. STATES are the CLOSED
 *  registered set (`STATE_FACETS`); a VARIATION (aka descriptor) is any other
 *  dotted mod — this preserves the historical `glyphFacets` rule ("a descriptor
 *  is a mod that is NOT a state tag") exactly, so an unknown modifier stays a
 *  descriptor, never a state. `DIMENSION_OF_VALUE`/`appearanceOf` further
 *  recognise the KNOWN variation values (colour/size/material); unknown
 *  descriptors ride along untouched. */
export function facetsOf(glyph: string): GlyphFacets {
  const parts = glyph.split(".");
  const mods = parts.slice(1);
  return {
    head: parts[0] ?? glyph,
    variations: mods.filter((m) => !isStateFacet(m)),
    states: mods.filter(isStateFacet),
  };
}

/** The variation facets of a glyph (colour/size/material), glyph order. */
export const variationFacetsOf = (glyph: string): string[] => facetsOf(glyph).variations;
/** The state facets of a glyph, glyph order. */
export const stateFacetsOf = (glyph: string): string[] => facetsOf(glyph).states;

/** Compose a glyph from parts — head, then variations, then states. Canonical
 *  order so equal items stringify identically (variations sorted by dimension
 *  order, then value order; states as given). */
export function composeGlyph(head: string, variations: readonly string[], states: readonly string[] = []): string {
  const dims = Object.keys(VARIATION_DIMENSIONS);
  const orderedVars = [...variations].sort((a, b) => {
    const da = dims.indexOf(DIMENSION_OF_VALUE.get(a) ?? ""), db = dims.indexOf(DIMENSION_OF_VALUE.get(b) ?? "");
    if (da !== db) return da - db;
    const dim = VARIATION_DIMENSIONS[DIMENSION_OF_VALUE.get(a) ?? ""];
    return (dim?.values.indexOf(a) ?? 0) - (dim?.values.indexOf(b) ?? 0);
  });
  return [head, ...orderedVars, ...states].join(".");
}

/** Replace one dimension's value on a glyph (the DYE/re-material operation): drop
 *  any existing facet of `value`'s dimension, add `value`, keep everything else.
 *  A colourless `shirt` dyed `color_red` → `shirt.color_red`. */
export function withVariation(glyph: string, value: string): string {
  const dim = DIMENSION_OF_VALUE.get(value);
  const { head, variations, states } = facetsOf(glyph);
  const kept = dim ? variations.filter((v) => DIMENSION_OF_VALUE.get(v) !== dim) : variations;
  return composeGlyph(head, [...kept, value], states);
}

// ── Appearance ───────────────────────────────────────────────────────────────

export interface ComposedAppearance {
  scale: [number, number, number];
  hex?: string;
  roughness?: number;
  metalness?: number;
}

/** Compose the appearance of a glyph's VARIATION facets: scale multiplies across
 *  facets; hex/roughness/metalness are last-wins. States (temperature etc.) are
 *  handled by the caller off `stateFacetsOf`. */
export function appearanceOf(glyph: string | undefined): ComposedAppearance {
  const out: ComposedAppearance = { scale: [1, 1, 1] };
  if (!glyph) return out;
  for (const v of variationFacetsOf(glyph)) {
    const look = VARIATION_DIMENSIONS[DIMENSION_OF_VALUE.get(v) ?? ""]?.look[v];
    if (!look) continue;
    if (look.scale) {
      out.scale[0] *= look.scale[0];
      out.scale[1] *= look.scale[1];
      out.scale[2] *= look.scale[2];
    }
    if (look.hex !== undefined) out.hex = look.hex;
    if (look.roughness !== undefined) out.roughness = look.roughness;
    if (look.metalness !== undefined) out.metalness = look.metalness;
  }
  return out;
}

// ── Variant enumeration (the stack-kind expansion) ───────────────────────────

/** The stack-kind glyphs a head takes, given the ACTIVE values per dimension it
 *  varies in — the generic replacement for the hard-coded `head × colour`
 *  product. A head that varies in no dimension is just `[head]` (fruit, water).
 *  `dims` names the dimensions the head varies in (goods-kinds owns that map);
 *  `active` supplies the values to enumerate (a culture palette, else the whole
 *  dimension). Cartesian across multiple dimensions, canonical order. */
export function variantKindsOf(
  head: string,
  dims: readonly string[],
  active?: Partial<Record<string, readonly string[]>>,
): string[] {
  const live = dims.filter((d) => VARIATION_DIMENSIONS[d]);
  if (!live.length) return [head];
  let combos: string[][] = [[]];
  for (const d of live) {
    const values = active?.[d]?.length ? active[d]! : VARIATION_DIMENSIONS[d]!.values;
    combos = combos.flatMap((c) => values.map((v) => [...c, v]));
  }
  return combos.map((vars) => composeGlyph(head, vars));
}
