// shared/world-engine/products.ts
//
// NATURAL SOURCES — the one registry of what plants, animals (and bare
// mineral outcrops) YIELD. Every product declares what it is FOR (food,
// drink, building material, or a raw that needs further processing) and HOW
// it comes off the organism: `harvest` is a LIVE take — the source survives
// and regrows it (fruit, milk, wool); `kill` is DESTRUCTIVE — taking it
// consumes the source (wood fells the tree, meat is the animal, stone
// quarries out the rock).
//
// THE POINT (city-founding ④ foundation): resource logic must never key on
// species names or name substrings scattered through code. The abstract
// economy (worldgen charters, town goods) and the visible collection acts
// (wilderness gathering, grazing herds, orchards) both READ this registry,
// so the two accounts of a resource always coincide — a town whose cloth
// abstractly comes from wool shows sheep, and the sheep IS where wool
// would visibly come from.
//
// PURE LEAF like variations.ts: no imports, safe from kernel and
// interaction alike. Species ids reference creatures/species.ts by string
// (the ecology.ts `model` convention) — no body-plan dependency here.

/** What a product is FOR — the demand side. `raw` is useless until
 *  processed (see `refinesTo`). */
export type ProductUse = "food" | "drink" | "building" | "raw";

/** How the product comes off its source. `harvest` = live and renewable —
 *  the plant/creature survives and regrows it. `kill` = destructive — the
 *  take consumes the source itself. */
export type AcquisitionMethod = "harvest" | "kill";

export interface NaturalProduct {
  /** The stack glyph one take mints ("wood", "wool", "apple", "milk"). */
  glyph: string;
  use: ProductUse;
  /** `raw` only: the processed commodity it becomes ("wool" → "cloth"). */
  refinesTo?: string;
  method: AcquisitionMethod;
  /** Units one acquisition act releases, rolled uniformly min..max. */
  yield: { min: number; max: number };
  /** `harvest` only: days until the source bears it again. */
  regrowDays?: number;
  /** The TOOL that speeds this take (city-founding: "more effective with an
   *  axe or pick, but can be done by hand"): holding the named glyph moves
   *  `multiplier` units per act instead of one. Spec data, never an engine
   *  constant — a new tool is a new row here, not new machinery. */
  tool?: { glyph: string; multiplier: number };
}

export type NaturalSourceKind = "plant" | "animal" | "mineral";

export interface NaturalSource {
  /** Species id (creatures/species.ts); minerals name their own ("rock"). */
  species: string;
  kind: NaturalSourceKind;
  products: NaturalProduct[];
  /** Wilderness scatter presentation — the placeholder container feature a
   *  source stands as until it has a real grown body (step ④ closes this). */
  feature?: { icon: string; radiusM: number };
  /** Standing-body height (m) when embodied as living town scenery. */
  bodyHeightM?: number;
}

// The catalogue. Order is load-bearing where glyph lists are derived from it
// (FOOD_KINDS likes-hashing, SITE_MATERIAL_GLYPHS) — append, don't reorder.
const CATALOGUE: NaturalSource[] = [
  {
    species: "oak",
    kind: "plant",
    feature: { icon: "🌳", radiusM: 0.7 },
    products: [
      {
        glyph: "wood",
        use: "building",
        method: "kill",
        yield: { min: 2, max: 4 },
        tool: { glyph: "axe", multiplier: 2 },
      },
    ],
  },
  {
    species: "apple_tree",
    kind: "plant",
    bodyHeightM: 3.4,
    products: [
      { glyph: "apple", use: "food", method: "harvest", yield: { min: 1, max: 3 }, regrowDays: 1 },
      {
        glyph: "wood",
        use: "building",
        method: "kill",
        yield: { min: 1, max: 2 },
        tool: { glyph: "axe", multiplier: 2 },
      },
    ],
  },
  {
    species: "banana_plant",
    kind: "plant",
    bodyHeightM: 3.4,
    products: [
      { glyph: "banana", use: "food", method: "harvest", yield: { min: 1, max: 3 }, regrowDays: 1 },
    ],
  },
  {
    species: "grape_vine",
    kind: "plant",
    bodyHeightM: 3.4,
    products: [
      { glyph: "grape", use: "food", method: "harvest", yield: { min: 1, max: 3 }, regrowDays: 1 },
    ],
  },
  {
    species: "sheep",
    kind: "animal",
    bodyHeightM: 0.95,
    products: [
      { glyph: "wool", use: "raw", refinesTo: "cloth", method: "harvest", yield: { min: 1, max: 2 }, regrowDays: 3 },
      { glyph: "meat", use: "food", method: "kill", yield: { min: 1, max: 2 } },
    ],
  },
  {
    species: "cow",
    kind: "animal",
    bodyHeightM: 1.3,
    products: [
      { glyph: "milk", use: "drink", method: "harvest", yield: { min: 1, max: 1 }, regrowDays: 1 },
      { glyph: "meat", use: "food", method: "kill", yield: { min: 2, max: 3 } },
    ],
  },
  {
    species: "rock",
    kind: "mineral",
    feature: { icon: "🪨", radiusM: 0.55 },
    products: [
      {
        glyph: "stone",
        use: "building",
        method: "kill",
        yield: { min: 1, max: 2 },
        tool: { glyph: "pick", multiplier: 2 },
      },
    ],
  },
];

const BY_SPECIES = new Map(CATALOGUE.map((s) => [s.species, s]));

/** Every registered source, catalogue order. */
export function naturalSources(): readonly NaturalSource[] {
  return CATALOGUE;
}

export function naturalSourceOf(species: string): NaturalSource | undefined {
  return BY_SPECIES.get(species);
}

/** Add (or override) a source at runtime — a game contributing its own
 *  ecology (the registerSpecies pattern). */
export function registerNaturalSource(src: NaturalSource): void {
  const prev = BY_SPECIES.get(src.species);
  if (prev) CATALOGUE.splice(CATALOGUE.indexOf(prev), 1, src);
  else CATALOGUE.push(src);
  BY_SPECIES.set(src.species, src);
}

/** Does this product FEED the named good/commodity — directly (its glyph or
 *  its use category IS the good) or through processing (`refinesTo`)? The
 *  seam that lets the abstract goods economy find its living sources. */
export function productFeedsGood(p: NaturalProduct, goodKey: string): boolean {
  return p.glyph === goodKey || p.use === goodKey || p.refinesTo === goodKey;
}

/** Sources with a product feeding the good, optionally of one kind and/or
 *  one acquisition method. `method: "harvest"` is the LIVING-SCENERY query:
 *  sources that stand ALIVE beside the producer (wool on the hoof, fruit on
 *  the bough) — kill products come from features/hunting, never a herd. */
export function sourcesForGood(
  goodKey: string,
  opts?: { kind?: NaturalSourceKind; method?: AcquisitionMethod },
): NaturalSource[] {
  return CATALOGUE.filter(
    (s) =>
      (!opts?.kind || s.kind === opts.kind) &&
      s.products.some(
        (p) => productFeedsGood(p, goodKey) && (!opts?.method || p.method === opts.method),
      ),
  );
}

/** One roll of a product's yield range (uniform min..max, one `roll()`). */
export function rollYield(p: NaturalProduct, roll: () => number): number {
  return p.yield.min + Math.floor(roll() * (p.yield.max - p.yield.min + 1));
}

/** The stack a DESTRUCTIVE take of this source releases — every kill product
 *  rolled once, in product order (deterministic `roll()` call count). What a
 *  felled tree or quarried rock holds. Empty for pure-harvest sources. */
export function killStockOf(species: string, roll: () => number): Record<string, number> {
  const src = BY_SPECIES.get(species);
  const stock: Record<string, number> = {};
  for (const p of src?.products ?? []) {
    if (p.method !== "kill") continue;
    stock[p.glyph] = (stock[p.glyph] ?? 0) + rollYield(p, roll);
  }
  return stock;
}

/** The stack a LIVE take of this source can bear at once — every harvest
 *  product rolled once, in product order (deterministic `roll()` call
 *  count). What the standing tree carries ripe, the ewe carries grown.
 *  Empty for kill-only sources. */
export function harvestStockOf(species: string, roll: () => number): Record<string, number> {
  const src = BY_SPECIES.get(species);
  const stock: Record<string, number> = {};
  for (const p of src?.products ?? []) {
    if (p.method !== "harvest") continue;
    stock[p.glyph] = (stock[p.glyph] ?? 0) + rollYield(p, roll);
  }
  return stock;
}

/** Is the source CONSUMED when its yield is taken — i.e. does it carry any
 *  kill product? An emptied consumable feature is felled/quarried out. */
export function sourceIsConsumable(src: NaturalSource): boolean {
  return src.products.some((p) => p.method === "kill");
}

/** THE FELLING TEST: consumable, and every kill glyph at zero in the live
 *  stock. The last wood taken IS the felling — even while fruit still hangs
 *  (a felled tree bears nothing; its harvest stock dies with it). Never
 *  true for pure-harvest sources, which persist picked clean. */
export function sourceKillExhausted(
  src: NaturalSource,
  stock: Record<string, number> | undefined,
): boolean {
  return (
    sourceIsConsumable(src) &&
    !src.products.some((p) => p.method === "kill" && (stock?.[p.glyph] ?? 0) > 0)
  );
}

export function harvestProductsOf(species: string): NaturalProduct[] {
  return (BY_SPECIES.get(species)?.products ?? []).filter((p) => p.method === "harvest");
}

/** UNITS ONE TAKE ACT MOVES for this source's glyph: 1 bare-handed, the
 *  product's declared tool multiplier when `hasTool` answers yes for its
 *  tool glyph ("more effective with an axe or pick, but can be done by
 *  hand"). 1 for glyphs the source doesn't yield. */
export function takeUnitsOf(
  src: NaturalSource | undefined,
  glyph: string,
  hasTool: (toolGlyph: string) => boolean,
): number {
  const p = src?.products.find((q) => q.glyph === glyph);
  if (!p?.tool) return 1;
  return hasTool(p.tool.glyph) ? Math.max(1, Math.floor(p.tool.multiplier)) : 1;
}

const uniqueGlyphs = (ps: NaturalProduct[]): string[] => [...new Set(ps.map((p) => p.glyph))];

/** Building-material stack glyphs, catalogue order — the site-yard
 *  vocabulary (founding.ts SITE_MATERIAL_GLYPHS reads this). */
export function buildingMaterialGlyphs(): string[] {
  return uniqueGlyphs(CATALOGUE.flatMap((s) => s.products.filter((p) => p.use === "building")));
}

/** Fruit kinds — the PLANT harvest food glyphs, catalogue order. Feeds
 *  goods-kinds FOOD_KINDS (order is likes-hashing-load-bearing). */
export function foodGlyphs(): string[] {
  return uniqueGlyphs(
    CATALOGUE.filter((s) => s.kind === "plant").flatMap((s) =>
      s.products.filter((p) => p.use === "food" && p.method === "harvest"),
    ),
  );
}

/** Drinkable glyphs the sources yield (milk) — unioned into the ingest
 *  routing's drink set. */
export function drinkGlyphs(): string[] {
  return uniqueGlyphs(CATALOGUE.flatMap((s) => s.products.filter((p) => p.use === "drink")));
}

/** The orchard mapping — each plant bearing a harvest food, with the fruit
 *  it yields (species.ts FRUIT_TREES derives from this). */
export function orchardPlants(): { fruit: string; species: string }[] {
  const rows: { fruit: string; species: string }[] = [];
  for (const s of CATALOGUE) {
    if (s.kind !== "plant") continue;
    for (const p of s.products) {
      if (p.use === "food" && p.method === "harvest") rows.push({ fruit: p.glyph, species: s.species });
    }
  }
  return rows;
}
