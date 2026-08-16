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
  /** The RATIO'D refinement (resources-and-trade.md §①) — `inPerOut` units
   *  of this product make one unit of `into` ("wool" → "cloth" at 2:1).
   *  Usually on `raw` products, but not only: a PRESERVATION refinement
   *  concentrates a perishable into something that keeps ("milk" →
   *  "cheese" — the good is drinkable AND refinable). LAW, tested off the
   *  catalogue: refinement is lossy in mass (inPerOut ≥ 1) and
   *  multiplicative in value (freight.ts valueDensity of `into` exceeds
   *  this glyph's) — distance is the reason refining exists.
   *  Chained ratios compound (freight.ts chainInPerOut), which is what makes
   *  bottlenecks emerge. HOW a good travels lives in freight.ts, per GOOD —
   *  never here, where two sources of one glyph could disagree.
   *  `at` names the WORK TYPE that refines this raw quickly (phase 5's masonry
   *  split: wood mills at the "workshop", stone cuts at the "masonry"). It
   *  never GATES — stations.ts:422's law applied to refinement: with no such
   *  building standing the raw still refines, just at the yard with no station
   *  behind it. Absent ⇒ the workshop, the one refinery there has ever been. */
  refinesTo?: { into: string; inPerOut: number; at?: string };
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

/**
 * ONE GROWTH SIZE CLASS (S&D S3 — timber lifecycle). `yieldMul` scales the
 * KILL products' base `yield.min/max` (via `growthClassYield`) — 1 at the
 * LAST class, so the catalogue's own numbers stay the mature anchor and a
 * freshly-scattered (mature) feature is byte-identical to today. Render
 * (standing size per class) is a DEFERRED seam — an embodied plant's body
 * is its blueprint's business (wilderness.ts `resizeWildFeature`), not
 * this registry's; this lands the STATE (class + yield), not the model.
 */
export interface GrowthSizeClass {
  /** Content name — probe/log only, never branched on. */
  name: string;
  /** Yield multiplier at this class, 0..1, last class = 1 (mature). */
  yieldMul: number;
}

export interface NaturalSource {
  /** Species id (creatures/species.ts); minerals name their own ("rock"). */
  species: string;
  kind: NaturalSourceKind;
  products: NaturalProduct[];
  /**
   * ⚖️ THE GROWTH CLOCK (S&D S3 — feedback_world_size_resource_realism, user
   * 2026-08-12: *"trees grow and larger trees will typically be cut
   * first"*). WOOD-BEARING species only (a kill product feeds `building`) —
   * a felled feature RE-SEEDS as a sapling (class 0) instead of vanishing,
   * and climbs `classes` on a clock anchored in REAL YEARS, compressed by
   * `scale.generation` (`bioYearsGameDays` — the generation/growth family
   * precedent, NEVER `resourceCompression`: growing faster and yielding
   * more per act are orthogonal facts). Absent = no growth clock — the
   * ORIGINAL felling rule (delete on kill-exhaustion) still applies, which
   * is how stone/minerals stay finite without a special case: `rock` simply
   * never declares this.
   */
  growth?: {
    /** Real YEARS from a fresh sapling (class 0) to mature (last class). */
    maturityYears: number;
    /** Size classes, youngest (sapling) first; the LAST entry is the
     *  catalogue's own mature yield (yieldMul 1). */
    classes: readonly GrowthSizeClass[];
  };
  /** Wilderness scatter presentation — the OBJECT a source stands as when it
   *  has no grown body. Minerals live here permanently and legitimately: a
   *  rock is a thing, not an organism, so `bodyHeightM`/the creature
   *  blueprint path is the wrong shape for it (phase 5). `fixture` forces a
   *  fixture archetype; ABSENT means resolve the model from `icon`, which is
   *  what a source with its own model (🪨 → the boulder recipe) wants — only
   *  an icon with no model at all falls back to the chest. */
  feature?: { icon: string; radiusM: number; fixture?: string };
  /** Standing-body height (m) when embodied as living town scenery. */
  bodyHeightM?: number;
  /** SOURCE RARITY (resources-and-trade.md §①): relative worldgen abundance
   *  weight — 1 (the default) sits under everyone's feet; a small fraction
   *  sits in a handful of places worth traveling for. A DISTRIBUTION
   *  parameter the worldgen scatter/node-typing pass reads (step ②'s
   *  `extraction` nodes), never a flag engine code branches on. That
   *  imbalance alone writes the trade map: tin scarce + iron common = the
   *  Bronze Age's whole geography. */
  rarity?: number;
}

/** A source's worldgen abundance weight (1 = common — the default). */
export function sourceRarityOf(src: NaturalSource): number {
  return src.rarity ?? 1;
}

// The catalogue. Order is load-bearing where glyph lists are derived from it
// (FOOD_KINDS likes-hashing, SITE_MATERIAL_GLYPHS) — append, don't reorder.
const CATALOGUE: NaturalSource[] = [
  {
    species: "oak",
    kind: "plant",
    // EMBODIED (one tree authority): a wild oak stands as a real grown body —
    // the same species blueprint the flora streaming field renders, so a
    // session twin materializing under a suppressed flora instance is the
    // same tree. Height = the blueprint's NATIVE build (~23.8 m — measured
    // off buildSkeleton bounds; the field renders instances at native scale
    // too, so the swap holds size). Resize the BLUEPRINT to resize oaks,
    // never this number alone. The box `feature` stays as the fallback
    // presentation for sources that lose their body.
    bodyHeightM: 23.8,
    feature: { icon: "🌳", radiusM: 0.7 },
    products: [
      {
        glyph: "wood",
        use: "building",
        // wood → block (planks) at the carpentry bench — construction
        // phase 3's one natural→artificial path. `inPerOut` here IS the
        // tree-to-city knob the structures doc names: 2 wood per block
        // (the refinement law is STRICTLY lossy in mass), with the block
        // bills sized so a house still costs the old 6 wood. Tune the
        // ratio, never the machinery. Every `wood` row must declare the
        // SAME refinement (two sources of one glyph may never disagree —
        // the freight rule, applied to the chain).
        refinesTo: { into: "block", inPerOut: 2 },
        method: "kill",
        // WHAT A TREE IS WORTH (phase 6). This was 2–4, sized when a whole
        // house cost three blocks; against a geometry-derived bill (a 9×8
        // cottage is 120 blocks — block-bill.ts) that made a cottage eighty
        // felled oaks, which is not a build, it is a deforestation. A mature
        // oak stands 23.8 m (`bodyHeightM` above): sixteen units of timber out
        // of it is if anything modest, and it puts a cottage at ~15 trees —
        // a real winter's work for a homestead, and nothing at town scale.
        // MOVE THIS WITH THE BILL, never alone: the two numbers are one knob
        // wearing two hats (BLOCKS_PER_BAY is the other hat).
        yield: { min: 12, max: 20 },
        tool: { glyph: "axe", multiplier: 2 },
      },
    ],
    // ⚖️ S&D S3 — TIMBER LIFECYCLE. 40 real years, sapling → young → mature —
    // a working real-world anchor for "worth felling" oak timber (commercial
    // stands are typically thinned well inside a human lifetime), not tuned
    // against play numbers. Sapling yields NOTHING (class 0 — a felled
    // sapling has no wood to give, which is also what keeps a freshly-
    // reseeded tree from being immediately re-fellable); young is a quarter
    // the mature timber; the LAST class (1.0) is the catalogue's own
    // yield.min/max above, so a freshly-scattered (mature) forest is
    // byte-identical to today.
    growth: {
      maturityYears: 40,
      classes: [
        { name: "sapling", yieldMul: 0 },
        { name: "young", yieldMul: 0.25 },
        { name: "mature", yieldMul: 1 },
      ],
    },
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
        refinesTo: { into: "block", inPerOut: 2 },
        method: "kill",
        // A 3.4 m fruit tree, scaled against the oak's 23.8 m — a quarter the
        // height, a fifth the timber. Felling the orchard for building stock
        // stays the bad trade it should be.
        yield: { min: 3, max: 5 },
        tool: { glyph: "axe", multiplier: 2 },
      },
    ],
    // A fruit tree matures far faster than an oak (real orchard anchor:
    // bearing age, not the oak's timber age) — two classes, no "young"
    // middle rung, since the whole tree is a quarter the oak's size anyway.
    growth: {
      maturityYears: 8,
      classes: [
        { name: "sapling", yieldMul: 0 },
        { name: "mature", yieldMul: 1 },
      ],
    },
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
      // 2 wool → 1 cloth: lossy in mass, multiplicative in value (freight.ts
      // prices wool 2, cloth 4 — the refinement law's worked example).
      { glyph: "wool", use: "raw", refinesTo: { into: "cloth", inPerOut: 2 }, method: "harvest", yield: { min: 1, max: 2 }, regrowDays: 3 },
      { glyph: "meat", use: "food", method: "kill", yield: { min: 1, max: 2 } },
    ],
  },
  {
    species: "cow",
    kind: "animal",
    bodyHeightM: 1.3,
    products: [
      // 5 milk → 1 cheese: the PRESERVATION refinement — a fragile staple
      // (keeps a day) concentrated into a pile that crosses a winter
      // (freight.ts prices milk 1/cheese 4, keepDays 1 → 180). The dairy
      // stands at the herd: milk is a fragile INPUT (§③ siting).
      { glyph: "milk", use: "drink", refinesTo: { into: "cheese", inPerOut: 5 }, method: "harvest", yield: { min: 1, max: 1 }, regrowDays: 1 },
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
        // Stone blocks are CUT, not milled — phase 5 splits them off the
        // carpentry bench onto the masonry (`at`). Same 2:1 ratio as wood, so
        // the tree-to-city knob and the quarry-to-city knob stay comparable;
        // what differs is WHERE, and therefore which building a town has to
        // raise before stone is worth quarrying at scale.
        refinesTo: { into: "block", inPerOut: 2, at: "masonry" },
        method: "kill",
        // The oak's rescaling (phase 6), applied to the outcrop — a boulder is
        // worth quarrying repeatedly, and the shrink curve (wilderness.ts
        // wildFeatureRadius, which measures against THIS max) now has enough
        // steps in it to actually read as the rock wearing down.
        yield: { min: 6, max: 10 },
        tool: { glyph: "pick", multiplier: 2 },
      },
    ],
  },
  // 🥕 THE FIRST VEGETABLE (food-scale-round.md E-round, E-a). USER RULING
  // (2026-08-15), verbatim: *"Farmland should really be handled in the same way
  // that forests are — regions that are harvested to produce goods, which are
  // stored in town and then purchased as needed. We don't have a bread industry
  // set up, so it would probably be simpler to start with vegetables."*
  //
  // Until this row, `foodGlyphs()` yielded three FRUITS and nothing a field
  // grows, so "farmland" had no crop behind it at all — the farm's output was a
  // book identity with no glyph in it. Carrot costs nothing to add: it already
  // has a species BODY (`creatures/species.ts` `carrot`, rendered by the root
  // profile — the storage body grows DOWN) and a fully translated glyph
  // (`shared/glyph-registry.ts` `aac.glyph.carrot`, 🥕, all 11 locales), so this
  // is a data row and ZERO locale work. Turnip and wheat are deliberately
  // deferred: both need a new registry row across 11 locale files, and wheat
  // additionally needs the bread refine chain the user has put off.
  //
  // 🚨 APPENDED, NEVER INSERTED. `FOOD_KINDS` is `foodGlyphs()` in CATALOGUE
  // order and residents' favourite foods hash BY INDEX — inserting mid-list
  // re-rolls every resident's and pet's likes. New food species go HERE, last.
  {
    species: "carrot_plant",
    kind: "plant",
    bodyHeightM: 0.4,
    products: [
      { glyph: "carrot", use: "food", method: "harvest", yield: { min: 1, max: 3 }, regrowDays: 1 },
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
  return p.glyph === goodKey || p.use === goodKey || p.refinesTo?.into === goodKey;
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

/**
 * One roll of a product's yield range (uniform min..max, one `roll()`).
 *
 * ⚖️ S&D S3 H1 — THE RESOURCE-CONVERSION DIAL, multiplier ① of five: a
 * SUPPLY quantity (units per act), so it scales UP with the dial —
 * `yields × dial`, the round's declared direction. Applied to the RANGE
 * before rolling (never the rolled result), so the roll stays uniform over
 * the scaled bounds rather than a scaled-uniform value. `conversionDial`
 * defaults to 1 (`Math.round(min×1)===min` for every integer bound the
 * catalogue declares) — byte-identical to the pre-S3 signature; the ONE
 * `roll()` call this makes is unchanged, so determinism (call count) holds.
 */
export function rollYield(p: NaturalProduct, roll: () => number, conversionDial = 1): number {
  const min = Math.max(0, Math.round(p.yield.min * conversionDial));
  const max = Math.max(min, Math.round(p.yield.max * conversionDial));
  return min + Math.floor(roll() * (max - min + 1));
}

/** The stack a DESTRUCTIVE take of this source releases — every kill product
 *  rolled once, in product order (deterministic `roll()` call count). What a
 *  felled tree or quarried rock holds. Empty for pure-harvest sources.
 *  `conversionDial` — see `rollYield`; default 1, byte-identical. */
export function killStockOf(species: string, roll: () => number, conversionDial = 1): Record<string, number> {
  const src = BY_SPECIES.get(species);
  const stock: Record<string, number> = {};
  for (const p of src?.products ?? []) {
    if (p.method !== "kill") continue;
    stock[p.glyph] = (stock[p.glyph] ?? 0) + rollYield(p, roll, conversionDial);
  }
  return stock;
}

/** The stack a LIVE take of this source can bear at once — every harvest
 *  product rolled once, in product order (deterministic `roll()` call
 *  count). What the standing tree carries ripe, the ewe carries grown.
 *  Empty for kill-only sources. `conversionDial` — see `rollYield`; default
 *  1, byte-identical. */
export function harvestStockOf(species: string, roll: () => number, conversionDial = 1): Record<string, number> {
  const src = BY_SPECIES.get(species);
  const stock: Record<string, number> = {};
  for (const p of src?.products ?? []) {
    if (p.method !== "harvest") continue;
    stock[p.glyph] = (stock[p.glyph] ?? 0) + rollYield(p, roll, conversionDial);
  }
  return stock;
}

/**
 * DETERMINISTIC size-class yield (S&D S3 H2) — a felled feature's kill stock
 * at the class it just grew into. NO RNG (unlike `rollYield`'s scatter-time
 * roll): growth is a CLOCK event, not a draw, exactly as fruit regrowth
 * (`dueHarvestRegrowth`) adds fixed units rather than re-rolling. Takes the
 * product's yield MIDPOINT (the roll's own expected value) × the class's
 * `yieldMul` × the conversion dial (multiplier ① again — the same "yields ×
 * dial" direction `rollYield` uses, so a re-seeded tree and a freshly-
 * scattered one answer the dial identically at their shared mature class).
 */
export function growthClassYield(p: NaturalProduct, yieldMul: number, conversionDial = 1): number {
  const mid = (p.yield.min + p.yield.max) / 2;
  return Math.max(0, Math.round(mid * yieldMul * conversionDial));
}

/**
 * ⚖️ S&D S3 H1 — multiplier ② of five: a BILL (raw units a refined unit
 * COSTS), so it scales DOWN with the dial — `bills ÷ dial`, the direction
 * paired with `rollYield`'s `× dial` so the two ends of one conversion move
 * together (more usable resource per natural unit, however you reach it).
 * Floored at 1 raw unit: refining may get cheaper, never free. Default 1,
 * byte-identical (`effectiveInPerOut(2, 1) === 2`).
 */
export function effectiveInPerOut(inPerOut: number, conversionDial = 1): number {
  return Math.max(1, Math.round(inPerOut / conversionDial));
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

// ── THE BLOCK CHAIN (construction phase 3) ────────────────────────────
// Blocks are the ONE construction primitive; raws (wood, stone) refine
// into them at a bench. The material rides as a FACET on the block head
// (`block.material_wood` — the toys' materialFacetOf convention), so a
// head-based cost (`{ block: n }`) is paid by any material while the
// stack still knows what it is made of.

/** The construction-primitive stack head. */
export const BLOCK_GLYPH = "block";

/** The faceted stack a raw refines into (`wood` → `block.material_wood`).
 *  Hand-composed single facet — identical to composeGlyph(into,
 *  [materialFacetOf(raw)]) without breaking this module's leaf-ness. */
export function refinedGlyphOf(raw: string): string | null {
  const p = CATALOGUE.flatMap((s) => s.products).find((q) => q.glyph === raw && q.refinesTo);
  return p?.refinesTo ? `${p.refinesTo.into}.material_${raw}` : null;
}

/** The raw products refining into `head` (catalogue order, one row per
 *  raw glyph) — the refine order's sourcing menu, and the chain-aware
 *  affordability check's coverage list. */
export function rawsForRefined(head: string): NaturalProduct[] {
  const seen = new Set<string>();
  const out: NaturalProduct[] = [];
  for (const p of CATALOGUE.flatMap((s) => s.products)) {
    if (p.refinesTo?.into !== head || seen.has(p.glyph)) continue;
    seen.add(p.glyph);
    out.push(p);
  }
  return out;
}

/** The WHOLE building chain's stack heads — the building raws plus their
 *  refined targets, catalogue order, unique. The site-yard vocabulary
 *  since phase 3 (a yard holds felled wood AND milled blocks). */
export function buildingChainGlyphs(): string[] {
  const raws = CATALOGUE.flatMap((s) => s.products.filter((p) => p.use === "building"));
  return [...new Set(raws.flatMap((p) => [p.glyph, ...(p.refinesTo ? [p.refinesTo.into] : [])]))];
}

/** CHAIN-AWARE stock: the stock plus what its raws could be milled into
 *  (floor of raw units / inPerOut, credited under the refined head). The
 *  affordability boards read this so "build bedroom" stays offered when
 *  the yard holds wood but no blocks yet — the refine chain fills the
 *  bill; hiding the button would refuse work the town can do. */
export function withRefinableCredit(
  stock: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = { ...stock };
  const byHead = new Map<string, number>();
  for (const [g, n] of Object.entries(stock)) {
    const head = g.split(".")[0]!; // facted variants pay their head (headOf)
    byHead.set(head, (byHead.get(head) ?? 0) + Math.max(0, n));
  }
  const seen = new Set<string>();
  for (const p of CATALOGUE.flatMap((s) => s.products)) {
    if (!p.refinesTo || seen.has(p.glyph)) continue;
    seen.add(p.glyph);
    const credit = Math.floor((byHead.get(p.glyph) ?? 0) / p.refinesTo.inPerOut);
    if (credit > 0) out[p.refinesTo.into] = (out[p.refinesTo.into] ?? 0) + credit;
  }
  return out;
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
