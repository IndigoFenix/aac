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

// ── WHERE A SOURCE LIVES — the niche vocabulary (2026-09-01) ───────────────
// ⚖️ ONE OWNER OF THE NICHE SHAPE. `Tolerance` and `band()` were born in
// planet/ecology.ts, where the planet biosphere evaluates them per cell. A
// catalogue row can only carry a niche if that vocabulary is reachable from
// HERE, and this module is the PURE LEAF (header law: no imports) — so the
// two definitions moved DOWN rather than being copied: ecology.ts imports
// both back and re-exports them, its public surface unchanged, and there is
// exactly one band() in the engine. Two registries that share the definition
// of a niche can never disagree about what a niche MEANS, which is the whole
// reason this join is safe to make.

/** A smooth tolerance window: 0 outside [lo, hi], 1 at `opt`, cosine-eased
 *  on each shoulder. Undefined bounds = one-sided (no limit that way). */
export interface Tolerance {
  lo?: number;
  opt: number;
  hi?: number;
}

/** Cosine-eased tolerance window → 0..1. */
export function band(v: number, t: Tolerance | undefined): number {
  if (!t) return 1;
  if (t.lo !== undefined && v < t.lo) return 0;
  if (t.hi !== undefined && v > t.hi) return 0;
  const side = v <= t.opt ? t.lo : t.hi;
  if (side === undefined) return 1; // one-sided: full suitability past the opt
  const span = Math.abs(t.opt - side) || 1;
  const x = Math.min(1, Math.abs(v - t.opt) / span);
  return 0.5 + 0.5 * Math.cos(x * Math.PI); // 1 at opt, 0 at the bound
}

/** Niche tolerances over the climate/terrain fields (any subset). rain
 *  ~0..1.3, tempC in °C, elevation in height units above sea, fertility
 *  0..15 — the planet substrate's own units (planet/climate.ts writes them,
 *  planet/ecology.ts reads them). `SpeciesDef.niche` IS this type. */
export interface SpeciesNiche {
  rain?: Tolerance;
  tempC?: Tolerance;
  elevation?: Tolerance;
  fertility?: Tolerance;
  /**
   * ⛏️ THE GEOLOGY AXIS (2026-09-01). Exposed-ore richness — `grid.fields.ore`,
   * int 0..15, TECTONIC provenance (worldgen emplaces and exhumes lodes;
   * "worldgen writes; runtime only depletes"), the ONE mineral field the
   * substrate carries and the same sum the `ore_access` charter box adds up
   * over its radius-3 disk.
   *
   * MINERALS' ANALOGUE OF RAIN. A lode-bound source is bound to this field the
   * way a banana is bound to warmth, so it says where it lives in the SAME
   * niche vocabulary every plant and animal already uses — one uniform
   * suitability answer for every source, instead of a second placement rule
   * living beside the first. Anti-correlated with `fertility` BY CONSTRUCTION
   * (ore is exhumed where erosion stripped the cover off high ground; soil is
   * where the sediment settled), so an ore window and a fertility window pull
   * a source in opposite directions on real terrain — which is how the
   * economic geography the trade layer already reads (barter.ts GEO_ORE_REF vs
   * GEO_FARMLAND_REF) falls OUT of the niche instead of being asserted next to
   * it.
   */
  ore?: Tolerance;
}

/** ONE CELL'S climate/terrain in the niche's units — the input side of the
 *  join. Built from a substrate by planet/ecology.ts `climateSampleAt`,
 *  which reads the same fields `ecologyFields` does; a caller with no cell
 *  under it has no sample, and that absence is a legitimate answer — the
 *  grower's query (`usefulPlants`) takes it as OPTIONAL for exactly that
 *  reason. */
export interface ClimateSample {
  rain: number;
  tempC: number;
  elevation: number;
  fertility: number;
  /**
   * ⛏️ SUBSTRATE AXES RIDE THE CLIMATE SAMPLE (2026-09-01) — exposed ore,
   * 0..15. ONE sample type, never a climate sample plus a geology sample: a
   * source's niche is one window set evaluated in one product, and splitting
   * the input would hand every call site the job of deciding which halves to
   * pass and how to combine two answers.
   *
   * OPTIONAL, AND ABSENT MEANS 0 (`nicheSuitabilityOf`'s `?? 0`). A
   * pre-geology sample — a hand-built harness literal, a caller standing on a
   * substrate that carries no ore field — stays valid and keeps answering
   * exactly what it answered before, which is the same "absent is a legitimate
   * answer" convention `fertility` already has one rung up in `climateSampleAt`.
   */
  ore?: number;
}

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
   * WHERE IT LIVES (2026-09-01). The row that puts a plant in the catalogue
   * also says where it grows — a source is never described in one place and
   * placed from another. ABSENT = indifferent everywhere (`band(v,
   * undefined)` is 1, the ecology convention), so every pre-niche row is
   * byte-identical and a mineral never has to pretend to have a climate.
   * Evaluated by the SAME `band()` windows the planet biosphere runs over
   * its species (ecology.ts `suitability`), against the SAME fields
   * (`ClimateSample`), so the two registries cannot disagree about what a
   * niche means: a catalogue niche calibrated against TREE/GRASS reads the
   * climate those species read. `nicheSuitabilityOf` is the query — the ONE
   * query, asked of plants, animals and minerals alike (2026-09-01: the
   * livestock rows and the `ore` axis completed the set, so no kind of source
   * answers "where do I live" through machinery of its own).
   */
  niche?: SpeciesNiche;
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
    // COOL TEMPERATE ORCHARD. Read against ecology.ts TREE (rain lo .45 /
    // opt 1.0, tempC 0/18/34): the apple stands on the forest's moisture
    // floor but peaks DRY of it (opt 0.9) and stops warm at 25 °C, far
    // inside TREE's 34 — a forest-edge tree that sets no fruit in the
    // tropics. Frost-hardy to a −2 °C mean (the dormant winter is a
    // requirement of the crop, not a hazard to it), and lowland-to-foothill,
    // which is TREE's elevation window verbatim.
    niche: {
      rain: { lo: 0.45, opt: 0.9 },
      tempC: { lo: -2, opt: 12, hi: 25 },
      elevation: { opt: 0, hi: 30 },
    },
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
    // TROPICAL WET, FROST-DEAD. The hard `lo: 19` IS the join's headline
    // case: no temperate mean carries a banana, which is the plant the
    // unfiltered pick used to stand on a cold homestead. One-sided on the
    // warm shoulder (no `hi`) — the equator is simply fine. Thirstier than
    // TREE at the floor (0.6) and peaking above GRASS's whole window (1.1),
    // and a lowland plain crop like the apple.
    niche: {
      rain: { lo: 0.6, opt: 1.1 },
      tempC: { lo: 19, opt: 28 },
      elevation: { opt: 0, hi: 30 },
    },
    products: [
      { glyph: "banana", use: "food", method: "harvest", yield: { min: 1, max: 3 }, regrowDays: 1 },
    ],
  },
  {
    species: "grape_vine",
    kind: "plant",
    bodyHeightM: 3.4,
    // WARM DRYISH TEMPERATE — the Mediterranean slot, and the reason the
    // three fruits are not interchangeable. Its rain window is GRASS's
    // (.2/.5/1.1) nudged wet: the vine takes the steppe's dry middle where
    // an apple starves, and closes off at the wet end where closed forest
    // (and rot) win. Warm-loving without being tropical — it must ripen a
    // real summer (opt 19) and survives no hard freeze (lo 4).
    niche: {
      rain: { lo: 0.25, opt: 0.55, hi: 1.05 },
      tempC: { lo: 4, opt: 19, hi: 33 },
      elevation: { opt: 0, hi: 30 },
    },
    products: [
      { glyph: "grape", use: "food", method: "harvest", yield: { min: 1, max: 3 }, regrowDays: 1 },
    ],
  },
  {
    species: "sheep",
    kind: "animal",
    bodyHeightM: 0.95,
    // THE HARDY HILL GRAZER (2026-09-01 — the animal half of the niche join;
    // until this row the two livestock species answered 1 everywhere, so a
    // biome switch's "wild flocks" stood cattle on a frozen steppe). Read
    // against the sward it actually eats — ecology.ts GRASS (rain .2/.5/1.1,
    // tempC −2/16/38) and HORSE (rain .2/.5/1.0, tempC −5/14/34): sheep hold
    // BOTH shoulders wider than either grazer. Drier at the floor than any
    // grass (0.15 — rough hill grazing where the sward thins to scrub), wetter
    // at the ceiling (1.15 — wet upland pasture is famously sheep country and
    // famously not cattle country), and cold-hardy to a −12 °C mean, twice the
    // frost HORSE will take.
    // NO elevation band, and the omission IS the statement (`band(v,
    // undefined)` is 1, the ecology convention): the mountain is where sheep
    // beat everything else, so a ceiling there would say the opposite of the
    // story this row exists to tell.
    niche: {
      rain: { lo: 0.15, opt: 0.45, hi: 1.15 },
      tempC: { lo: -12, opt: 12, hi: 32 },
    },
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
    // THE LUSH-PASTURE GRAZER — the sheep's foil, and the reason the two
    // livestock rows are not interchangeable. Its whole moisture window sits
    // WET of the flock's (floor .3 vs .15, peak .6 vs .45, ceiling 1.2 vs
    // 1.15): cattle need a real sward, not rough grazing, so the dry steppe
    // edge that still carries sheep carries no herd. FROST IS THE HARD BOUND
    // and the one the scatter filter exists for — a −2 °C mean, GRASS's own
    // floor verbatim, so cattle stop exactly where the pasture does instead of
    // standing in snow. Lowland to foothill (hi 35, between GRASS's 45 and
    // TREE's 30): a heavy grazer does not work a mountain, which is the axis
    // the sheep deliberately leaves open.
    niche: {
      rain: { lo: 0.3, opt: 0.6, hi: 1.2 },
      tempC: { lo: -2, opt: 15, hi: 32 },
      elevation: { opt: 0, hi: 35 },
    },
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
    // ⛏️ NICHELESS ON PURPOSE (2026-09-01), even now that the niche carries an
    // `ore` axis. STONE IS SUBSTRATE — it is under everywhere by design, so
    // suitability 1 everywhere is the TRUE answer for this row, not a missing
    // one. And `niche.ore` would be the wrong window even so: that field is
    // METAL richness, not stone presence, and bare scree (ore-poor or not) is
    // exactly where stone is easiest to take. The scarce mineral this axis was
    // added for — the tin that writes the Bronze Age's whole trade map — is a
    // FUTURE ROW declaring `niche.ore` + `rarity` together, and it leaves this
    // one alone.
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
    // HARDY GENERALIST ROOT CROP — the food plant a founding can put in the
    // ground almost anywhere, and the reason "a growing biome with no
    // bearer" is not a normal outcome of the filter. The widest windows in
    // the catalogue: drier at the floor than GRASS (0.2) and colder than
    // anything else here (a −5 °C mean), with NO elevation band — a root crop
    // is indifferent to how high it sits, and since `band(v, undefined)` is 1,
    // declaring nothing IS that statement rather than an omission.
    //
    // 🥕 SOIL FINALLY MATTERS (2026-09-01 — suitability-as-yield). This row
    // declared NO fertility band while it was only ever a membership filter
    // ("does a carrot grow here at all"), and the honest answer to that was
    // yes nearly everywhere. It is now a YIELD MULTIPLIER on the town's whole
    // farm (`sourceSuitabilityAt`, read by the live cap AND the books), so
    // indifference to soil would mean a field on bare rock feeds a town as
    // well as a field on river silt — the one thing the substrate's fertility
    // field exists to deny.
    //   lo 1  — `fertility` is 0 on ground the substrate itself calls
    //           unfarmable (climate.ts: sea, ice cap, above the treeline,
    //           bare stone, and true desert below the rain floor). Zero
    //           there is the substrate's own verdict, restated, not a new
    //           one. `band()` reaches 0 AT the bound, so 1 — the poorest
    //           arable rung the field can hold — is barren too, and the
    //           curve climbs from just above it.
    //   opt 7 — a WORKED soil, comfortably under the rain-fed cap (12) and
    //           the river-rich premium (15), because a root crop is not a
    //           silt-hungry cereal: ordinary decent ground grows a full
    //           carrot. One-sided past the optimum (`band` returns 1 with no
    //           `hi`), so richer land is never penalized for being rich.
    niche: {
      rain: { lo: 0.2, opt: 0.6 },
      tempC: { lo: -5, opt: 14, hi: 31 },
      fertility: { lo: 1, opt: 7 },
    },
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

/**
 * Every plant that yields FOOD you can take without killing it, paired with
 * the glyph it yields. A PROPERTY QUERY over the catalogue — it authors
 * nothing and owns no list; `species` is an id into creatures/species.ts, and
 * the row that put it here is the plant's own.
 *
 * ⚖️ NAMED FOR THE PROPERTY, NEVER FOR A PLACE. This was `orchardPlants()`,
 * and "orchard" is a place type, not a property — so the moment `carrot_plant`
 * joined the catalogue the engine had a carrot in its orchard, and a hand-kept
 * `OrchardFruit = "apple" | "banana" | "grape"` union in species.ts (with an
 * unchecked `as` cast feeding it) went quietly out of step with the data it
 * claimed to describe. A property query cannot drift that way: whatever plants
 * bear harvestable food ARE the answer, and there is no second list to update.
 *
 * ⚠️ NOT BIOME-FILTERED, AND IT NEVER WILL BE. This answers "which plants
 * bear food", which is a property of the SPECIES, not a claim about a place —
 * and its consumers are FOOD VOCABULARIES (the sentence builder's food list
 * above all): a child names a banana on any continent, so filtering this by
 * where the camera happens to stand would take words out of a mouth. The
 * scatter sites that used to (mis)use it wanted a different question all
 * along — "what is worth GROWING here" — and that is `usefulPlants(climate)`
 * below, which is where the niche join landed (2026-09-01). Two properties,
 * two queries; neither is the other's filter.
 */
export function foodPlants(): { food: string; species: string }[] {
  const rows: { food: string; species: string }[] = [];
  for (const s of CATALOGUE) {
    if (s.kind !== "plant") continue;
    for (const p of s.products) {
      if (p.use === "food" && p.method === "harvest") rows.push({ food: p.glyph, species: s.species });
    }
  }
  return rows;
}

/**
 * How well this source's niche admits one cell, 0..1 — the product of the
 * `band()` windows, which is ecology.ts `suitability` minus the interaction
 * relaxation (competition is a FIELD computation over neighbours and has no
 * meaning for a single sample). No niche ⇒ 1: indifferent everywhere. Zero on
 * ANY axis is zero overall — a hard bound is a hard bound, and that is what
 * makes `> 0` a usable "lives here".
 *
 * ⚖️ THE ONE UNIFORM LAYER-1 ANSWER (2026-09-01). Plant, animal and mineral
 * alike are asked THIS question and no other: there is no per-kind query, no
 * "where do minerals go" beside "where do plants grow", and deliberately no
 * new exported query for the ore axis — a caller that wants a subset filters
 * the catalogue on the answer (`usefulPlants` is the grower's filter, plants
 * only, and stays that way). The number is also CONTINUOUS on purpose: `> 0`
 * reads as "lives here", and the magnitude itself reads as "how common here",
 * which is what lets a scatter weight its pick without a second abundance
 * table (wilderness.ts `weightedPickBySeed`).
 */
export function nicheSuitabilityOf(src: NaturalSource, c: ClimateSample): number {
  const n = src.niche;
  if (!n) return 1;
  return (
    band(c.rain, n.rain) *
    band(c.tempC, n.tempC) *
    band(c.elevation, n.elevation) *
    band(c.fertility, n.fertility) *
    // ⛏️ Absent ore on the sample is 0, not "indifferent": a substrate with no
    // ore field HAS no exposed metal, and a lode-bound source must read that
    // as barren ground rather than as a free pass. A source with no `ore`
    // window is unaffected either way (`band(v, undefined)` is 1), which is
    // why every pre-geology row and sample stays byte-identical.
    band(c.ore ?? 0, n.ore)
  );
}

/**
 * ⚖️ SUITABILITY IS A YIELD MULTIPLIER, NEVER A GATE (user ruling 2026-09-01).
 * How well the ground grows one species BY NAME, 0..1 — the ONE bridge every
 * cultivated seat multiplies by, so the visible farm and the abstract books
 * can never disagree about what a site is worth. A marginal crop grows POORLY
 * (a thin harvest off poor soil, which is what a real marginal field does);
 * it is never refused. Only truly barren ground — a breached hard bound, the
 * `band()` zero — yields nothing, and that is a fact about the ground, not a
 * veto on the player.
 *
 * ⚖️ CULTIVATION = SUITABILITY MINUS COMPETITION. The raw niche carries no
 * competition terms BY CONSTRUCTION: ecology's `suppress`/`require`
 * interactions relax WILD abundance over neighbouring cells (ecologyFields'
 * passes) and have no meaning for a single sample — which is exactly what a
 * ploughed field is. A farmer clears the competitors; what is left is the
 * niche. So this IS the cultivated answer, and wild presence keeps its
 * competition through `ecologyFields` where it belongs.
 *
 * TWO ABSENCES, ONE ANSWER (1 — indifferent):
 *   • NO CLIMATE — the caller has no cell under it (a preset town, a charter-
 *     only founding, a flat test world). Suitability is not "unknown, assume
 *     the worst"; a seat with nothing to read must be BYTE-IDENTICAL to the
 *     pre-niche world, which is the bench law.
 *   • NO CATALOGUE ROW — no row means no niche, and no niche already means
 *     indifferent everywhere (`nicheSuitabilityOf`'s own rule, `band(v,
 *     undefined)` one rung down). A game's own crop that never registered a
 *     source must not silently starve its town.
 */
export function sourceSuitabilityAt(species: string, c?: ClimateSample): number {
  if (!c) return 1;
  const src = naturalSourceOf(species);
  if (!src) return 1;
  return nicheSuitabilityOf(src, c);
}

/**
 * THE GROWER'S QUERY (2026-09-01): every plant worth PUTTING IN THE GROUND —
 * a catalogue row of kind "plant" carrying at least one `harvest` product,
 * catalogue order. With a `climate` sample, only the rows whose niche admits
 * that cell (`nicheSuitabilityOf > 0`) — the location-aware arm, and the one
 * a caller standing on real ground asks.
 *
 * ⚖️ NAMED FOR THE PROPERTY, AND THE PROPERTY IS "WORTH GROWING". Not a
 * PLACE — `orchardPlants()` was the first drift, and the day a carrot joined
 * the catalogue the engine had a carrot in its orchard. Not one USE either —
 * "food plants" is the second drift, subtler: the property that makes a plant
 * worth growing is that it yields something LIVE and RENEWABLE (you take and
 * it bears again) rather than something you must fell it for, and that holds
 * of a fibre or a dye plant exactly as it holds of an apple. Filter on `use`
 * and the fibre row falls silently out of every planting site the day it
 * lands. Coincidentally the four harvest-bearing plants are today's four food
 * plants; the queries are still different questions.
 *
 * ⚖️ A FILTER OVER THE CATALOGUE, NEVER A LIST OF ITS OWN (user ruling) —
 * it returns the ROWS themselves, so a caller reads the plant's real
 * products, niche and body off the same object the economy reads. EMPTY IS
 * AN ANSWER: nothing grows on frozen scree, and a caller must plant nothing
 * there rather than fall back to the unfiltered list, which would re-open
 * exactly the mis-placement the niche data was added to close.
 */
export function usefulPlants(climate?: ClimateSample): NaturalSource[] {
  return CATALOGUE.filter(
    (s) =>
      s.kind === "plant" &&
      s.products.some((p) => p.method === "harvest") &&
      (!climate || nicheSuitabilityOf(s, climate) > 0),
  );
}
