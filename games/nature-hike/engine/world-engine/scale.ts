// shared/world-engine/scale.ts
//
// THE one place real↔game scale lives (planning-docs/games/world-engine/space-time-compression.md).
//
// Law (§1 of the doc): compression is PHYSICS of the world, not playback —
// real-world values are the anchor, and every game value is (real anchor ×
// declared factor). Playback rate is a property of the observer and never
// appears here.
//
// The ENGINE DEFAULT is realism (`REAL_SCALE`): a world that declares nothing
// eats daily on a 24-hour day, sleeps a third of it, and raises a house in
// half a year. Games declare their compression in the document's `game.scale`
// block (parsed here, gated by kernel/manifest.ts); `DOLLHOUSE_SCALE` is the
// shipped street-clock profile every current town demo declares explicitly.

// ---------------------------------------------------------------- real anchors

/** One real day, in seconds. */
export const REAL_DAY_S = 86_400;
/** Real humans sleep about a third of the day. */
export const REAL_SLEEP_FRACTION = 1 / 3;
/** Historical market-town spacing — literally "a day's walk apart". */
export const REAL_TOWN_SPACING_M = 25_000;
/**
 * A market town's DECLARED BUILT EXTENT at real scale — how far out its
 * buildings may reach. The town-side twin of `REAL_TOWN_SPACING_M`, and THE
 * one definition of the number (`kernel/town/dimensions.ts` `townRMax` reads
 * it, so "how big is a town" is said once).
 *
 * Content, not physics: it is the size a town is ALLOWED to grow to, which
 * `townExtentM` then caps by the size the world can actually hold.
 */
export const REAL_TOWN_EXTENT_M = 450;
/**
 * THE TIER ANCHORS — a settlement's declared BUILT extent BY TIER, at real
 * scale (food-scale-round.md Q3). `REAL_TOWN_EXTENT_M` was never wrong; it was
 * wrong *applied to every tier*, hamlets included, so a hamlet and a market
 * town declared the same 450 m body and only the clip law told them apart.
 *
 * Content, not physics — the same kind of truth as `REAL_TOWN_EXTENT_M`, which
 * IS the `town` row (one definition, read here). USER RULING (2026-08-15):
 * *"Villages are often about 100-300 meters across in typical adventure
 * games"* — the `village` row is 120 m of radius, 240 m across, dead centre of
 * that band. A real village's BUILT radius is already ~120 m, so the town BODY
 * never needed compressing: only the GAP between bodies and the FIELD YIELD
 * did.
 */
export const REAL_TIER_EXTENT_M = {
  hamlet: 60,
  village: 120,
  town: REAL_TOWN_EXTENT_M,
  city: 1_500,
} as const;

export type SettlementTier = keyof typeof REAL_TIER_EXTENT_M;

/**
 * THE TIER CAPACITIES — how many souls a settlement of each tier can HOUSE,
 * the popCap the founding scan founds TOWARD (`kernel/civ/bands.ts
 * foundingScan`: the staple catchment prices the settlement the site becomes, not
 * the founding party).
 *
 * These are MEASURED street-tree capacities, not design estimates
 * (food-scale-round.md LANDING NOTE, step-0 measurement 2026-08-15): headless
 * `buildTownPlay` at each tier's extent, 4 seeds, mean frontage slots ×
 * `HOUSEHOLD` 5, at dial `resource_compression 20` / `gap_compression 10`.
 * The town row is the measured 1 104 (Q3's analytic lower bound was 1 065 —
 * the ladder is ask-bound above E ~ 300, so the analytic figure survives only
 * as a floor). `city` is UNMEASURED — carried from the design table until an
 * extent that large is reachable in play.
 */
export const TIER_POP_CAP: Record<SettlementTier, number> = {
  hamlet: 14,
  village: 140,
  town: 1_104,
  city: 5_000,
};

/**
 * THE GEOMETRIC FLOOR, stated once so no tier is declared under it by
 * accident: the street tree grows to `gate = extentM − BUILT_MARGIN 46`
 * (`kernel/town/streets.ts`), and below `PLAZA_R 30` plus two lot pitches the
 * gate is its own plaza — the tree yields a handful of frontage slots and the
 * town cannot house anybody. **≈106 m of extent is where a town starts being a
 * town.**
 *
 * MEASURED (food-scale-round step 0, headless `buildTownPlay`, 4 seeds,
 * startPop 200 / 160 d): extent 60 ⇒ 1-4 slots / 0-1 houses; extent 106 ⇒ 9-12
 * slots / 5-8 houses; extent 120 ⇒ 12-34 slots / 8-32 houses; extent 150 ⇒
 * 63-70 slots; extent 208 ⇒ 136-156 slots. The 71 m Earthlike extent of
 * `earthlike-city-regression.md` sat under this floor, and that is the whole
 * of that regression.
 *
 * ⚖️ THIS IS NOT A FLOOR ON `townExtentM` — see the no-floor law there. It is a
 * fact about the street tree that the TIER ANCHORS respect: `hamlet 60` is
 * deliberately below it and must be handled as a CLUSTER OF LOTS with no
 * street tree, never as a shrunken town.
 */
export const STREET_TREE_MIN_EXTENT_M = 106;
/** A real house takes roughly half a year to raise — the construction
 *  factor's anchor (a structure's relative buildDays are multiples of it). */
export const REAL_HOUSE_BUILD_DAYS = 180;
/**
 * A garment lasts roughly half a year — THE CLOTHING ANCHOR.
 *
 * USER LAW (2026-08-09), verbatim: *"How much clothing do these people need,
 * anyway? I think people need new food a lot more than they need new clothes.
 * Ground it in a roughly normal value (we'll handle adjustments later), and
 * assume that the need scales at the metabolic multiplier."*
 *
 * One garment per person per half-year, against one ration per person per day:
 * the food:clothing daily need is **180 : 1**. This is the ONE absolute; every
 * clothing rate downstream is a ratio off it (`clothingFillDays`, and through
 * that the books' `perPersonDaily` and the street's food-normalized
 * `perCapitaDaily`). It is deliberately NOT tuned — a roughly normal value,
 * adjusted later if play asks.
 */
export const REAL_CLOTHING_DAYS = 180;
/** Earth. */
export const REAL_PLANET_RADIUS_M = 6_371_000;
export const REAL_LAND_FRACTION = 0.29;
/** Real days in a real orbit — the anchor for the SEASONAL clock, which is a
 *  dial of its own (settlement-emergence.md §4a: the year is not the day; the
 *  quarter day is why leap years exist). */
export const REAL_YEAR_DAYS = 365.25;
/** One real orbit, in seconds. */
export const REAL_YEAR_S = REAL_YEAR_DAYS * REAL_DAY_S;
/** Share of a temperate year that yields nothing to a forager — the reason a
 *  store exists at all. Earth-temperate anchor; per-biome values are the
 *  spec's business (ratios in the engine, absolutes in the spec). */
export const REAL_LEAN_FRACTION = 0.4;
/** A real human lifespan, in years — the `generation` factor's anchor. */
export const REAL_LIFESPAN_YEARS = 70;
/** Childhood's share of a real lifespan (~18 of 70). Expressed as a FRACTION
 *  on purpose: compressing the lifespan then compresses the growth stage with
 *  it, so the dependency ratio survives compression by construction
 *  (settlement-emergence.md §4c invariant 3). */
export const REAL_GROWTH_FRACTION = 18 / 70;

// -------------------------------------------------------------- the WorldScale

/**
 * Need fill times in GAME-DAYS AT METABOLISM 1 (rate/sec = 1 / (days ×
 * dayLengthS ÷ metabolism)). These are the RELATIVE pacings — a person eats
 * daily, changes clothes every two days — and they hold at any day length;
 * compression changes the day, not the ratios (the ecosystem-is-one-ledger
 * law, doc §4).
 *
 * The eating PERIOD is a separate dial from the day (`WorldScale.metabolism`,
 * settlement-emergence.md §4a) — a world may see sunrise every four minutes
 * and eat every eighty seconds. These ratios hold across that too: metabolism
 * scales the whole motive set together, so a hungry creature is still hungry
 * before it is tired.
 */
export const NEED_FILL_DAYS = {
  hunger: 1, // one ration per day — THE anchor
  energy: 1.6, // tiredness over ~1.6 days
  social: 0.8, // loneliness is the visible dynamic
  fun: 1, // restlessness over ~1 day
  thirst: 1.25, // a touch behind hunger
  waste: 2.5, // base drift (meals/drinks bump it)
  hygiene: 35 / 12, // ~2.9 days — the slowest burn
  dirt: 2, // clothes last ~2 days
} as const;

export type NeedKey = keyof typeof NEED_FILL_DAYS;

/**
 * A world's space-time compression — the resolved physics profile every
 * pacing-sensitive system reads. One per world, chosen at creation,
 * effectively immutable (changing the day length mid-world would silently
 * invalidate every rate in it).
 */
export interface WorldScale {
  /**
   * Real seconds per game-day — THE clock every rate is quoted per.
   *
   * DERIVED, not declared: `REAL_DAY_S / rotation`. It lives on the resolved
   * profile because every pacing consumer reads it, but the authored truth is
   * the multiplier. Never set it independently of `rotation`.
   */
  dayLengthS: number;
  /**
   * PLANET SPIN multiplier — how many times faster than Earth the world turns.
   * 1 = a real 24-hour day; 360 = the 240 s street day.
   *
   * LAW (user, 2026-07-29): **every compression variable is a multiplier over
   * a real anchor, never an absolute.** The core physics model spins up a real
   * Earth-like planet and these factors scale the rotation and revolution of
   * bodies across the universe — so a world's clock is a property of its
   * planet turning faster, not of a number someone typed in seconds.
   */
  rotation: number;
  /**
   * ORBITAL multiplier — how many times faster than Earth the world goes
   * round. 1 = a real year. INDEPENDENT of `rotation`: spin the planet 360×
   * and leave the orbit alone and a year still takes a real year, only now it
   * contains 131 490 short days. `yearGameDays` is the ratio of the two, and
   * it is the number seasons are actually felt in.
   */
  revolution: number;
  /** Fraction of the day spent asleep (the rest dwell). Real world: ⅓. */
  sleepFraction: number;
  /** Construction acceleration beyond the day: game-days to build =
   *  relative buildDays × REAL_HOUSE_BUILD_DAYS ÷ construction. 1 = a house
   *  takes half a year of game-days; 180 = a house rises in one game-day. */
  construction: number;
  /**
   * BODY-SIZE compression: radii ÷ this (masses ÷ this², so surface gravity is
   * preserved). 1 = real-size bodies.
   *
   * LAW (user, 2026-07-29): **space and time compression scales EVERY body in
   * the universe, not just the home world.** Compression is presentation — the
   * relative scales of a system must come out unchanged, so a compressed world
   * looks exactly like the real one until you measure it. That is why the two
   * distance dials below default to THIS value rather than to 1: declaring a
   * miniature planet miniaturizes its whole sky by the same factor.
   */
  planetCompression: number;
  /**
   * INTERPLANETARY distance compression: orbital semi-major axes ÷ this.
   * Defaults to `planetCompression` (uniform shrink, relative scales
   * preserved).
   *
   * Setting it ABOVE `planetCompression` is the deliberate exception the law
   * allows: angular size is radius ÷ distance, so pulling orbits in faster
   * than bodies shrink makes moons and neighbouring planets **loom large in
   * the sky** — the storybook sky, bought explicitly rather than by accident.
   * `apparentSizeGain` reports the factor.
   */
  interplanetary: number;
  /** INTERSTELLAR distance compression: star-to-star separations ÷ this.
   *  Defaults to `planetCompression`, same law — a miniature universe brings
   *  its neighbours in too, so the night sky keeps its proportions. */
  interstellar: number;
  /**
   * SETTLEMENT-GAP compression: the distance between neighbouring towns ÷
   * this (`townSpacingM`), and through the CLIP LAW the extent each town may
   * build out to (`townExtentM`). Defaults to `planetCompression`, the same
   * uniform-shrink law the two sky dials follow: miniaturize a world and its
   * settled map comes in with it, so the whole thing keeps its proportions.
   *
   * This is the dial a MINIATURE PLANET needs and nothing else provides. A
   * 2 km test world founds its towns a few hundred metres apart; at the real
   * 25 km spacing every road between them is shorter than the two towns'
   * own extents put together, so the port law finds no open country to cross
   * and hands every road back unclipped — roads through buildings, by
   * arithmetic. Declaring the gap compression is how such a world says the
   * true size of its towns instead of pretending to be Earth.
   *
   * Its own dial rather than a read of `planetCompression` because the two
   * are genuinely separable: a real-radius world may still want crowded
   * settlements (a dense medieval province), and a miniature world that
   * hosts exactly one town does not care at all.
   */
  gapCompression: number;
  /**
   * ⚖️ THE RESOURCE-CONVERSION DIAL (S&D round, S3 — feedback_world_size_
   * resource_realism, user 2026-08-12): **"a single value that multiplies
   * the conversion of natural resources to usable ones (which was one of
   * the main reasons for the block paradigm in the first place)."**
   *
   * NOT a distance/time compression like the dials above — it multiplies
   * NATURAL→USABLE YIELD: how much a wild source gives up per act, how few
   * raw units a refined unit costs, how much a town's raw-material buffer
   * needs to hold. `farmAreaPerPersonM2`'s `conversionDial` argument (S2)
   * is this field, read at the call site (S2 had no `WorldScaleSpec` field
   * to read yet); the S3 five-multiplier round (oak yield, refine
   * `inPerOut`, the block bill, `STOREHOUSE_RAW_PAR`/`commonsReserveOf`,
   * `homesteadWildMix` counts) is the same seam, generalized — THE
   * BLOCK PARADIGM'S ORIGINAL PURPOSE, named directly in the law.
   *
   * Default 1 = the real anchors verbatim (byte-identical to a world that
   * declares nothing). Independent of `generation` — tree GROWTH TIMING
   * rides the ecosystem-wide life-acceleration dial (the same clock a
   * creature ages on), never this one, because growing faster and
   * yielding more per act are orthogonal facts about a compressed world.
   */
  resourceCompression: number;

  // ---- the independently-moving clocks (settlement-emergence.md §4a) ----
  // Each is its own declaration: a world may see sunrise every four minutes,
  // eat every eighty seconds, walk at a real pace, pass a year in twenty
  // minutes and live sixty of them. No settlement rule may read any of these
  // as an absolute — the gates read the RATIOS below (§4b).

  /** Share of the year that yields nothing to a forager. Real temperate: 0.4.
   *  A world PROPERTY (a fraction of its own year), not a compression factor.
   *  With `yearGameDays` and the hunger period this sets `leanSeasonMeals` —
   *  the number that decides whether settling is worth it (§4c invariant 1). */
  leanFraction: number;
  /** Metabolic acceleration beyond the day: need meters fill in
   *  NEED_FILL_DAYS ÷ metabolism game-days. 1 = one ration per game-day
   *  (real). 3 = three meals per game-day. ECOSYSTEM-WIDE, never per species
   *  (doc §4's one-ledger law, refined: one factor per PROCESS CLASS applied
   *  to every species at once — a wolf may breed slower than a rabbit, but
   *  may not run on a different metabolic clock than the rabbits it eats). */
  metabolism: number;
  /** Gait multiplier over the real villager pace (ERRAND_WALK_MPS). 1 = real
   *  legs. This is the one dial that moves SPEED, where space and time meet
   *  (doc §3) — raise it and every reach in the world grows. */
  locomotion: number;
  /** Life acceleration: lifespan = REAL_LIFESPAN_YEARS ÷ generation game-
   *  years, and maturation and reproduction ride with it. 1 = a real ~70-year
   *  life. ECOSYSTEM-WIDE, same law as `metabolism`. Splitting it FROM
   *  metabolism is legal and moves `mealsPerLifetime` — the lifetime food
   *  cost of a person, which sets the surplus needed to carry a non-producer.
   *  That is a diagnostic (§4b), never an accident. */
  generation: number;
  /** Childhood's share of a lifespan. Real: ~0.257 (18/70). A FRACTION (again
   *  a world property, not a compression), so compressing `generation`
   *  compresses the growth stage with it and the dependency ratio survives by
   *  construction (§4c invariant 3). */
  growthFraction: number;
}

/** Real seconds per game-day under a spin multiplier. */
export function dayLengthFor(rotation: number): number {
  return REAL_DAY_S / rotation;
}

/** Real seconds per game-YEAR under an orbit multiplier. */
export function yearLengthS(scale: WorldScale): number {
  return REAL_YEAR_S / scale.revolution;
}

/** Game-days in a year — `REAL_YEAR_DAYS × rotation / revolution`. THE
 *  seasonal number: how many days of world a creature lives between one
 *  spring and the next. Spin and orbit move independently, so this is a
 *  ratio, never a declaration. */
export function yearGameDays(scale: WorldScale): number {
  return (REAL_YEAR_DAYS * scale.rotation) / scale.revolution;
}

/** The `revolution` a world must declare to get `days` game-days per year at
 *  a given spin — the authoring helper, so a target season length never has
 *  to be typed as an absolute. */
export function revolutionForYearDays(rotation: number, days: number): number {
  return (REAL_YEAR_DAYS * rotation) / days;
}

/** The engine default: realism. A world that declares nothing gets this. */
export const REAL_SCALE: WorldScale = {
  dayLengthS: REAL_DAY_S, // = dayLengthFor(1)
  rotation: 1,
  revolution: 1,
  sleepFraction: REAL_SLEEP_FRACTION,
  construction: 1,
  planetCompression: 1,
  interplanetary: 1,
  interstellar: 1,
  gapCompression: 1,
  resourceCompression: 1,
  leanFraction: REAL_LEAN_FRACTION,
  metabolism: 1,
  locomotion: 1,
  generation: 1,
  growthFraction: REAL_GROWTH_FRACTION,
};

/**
 * The shipped street-clock profile: the 240 s day every current town demo
 * runs (the dollhouse motive pacing, buildings up in a game-day). Town-scope
 * documents declare this EXPLICITLY — the street machinery (goods.ts
 * FOOD_DAY_SEC closed-form schedules) is hard-paced to this day, so a town
 * world's `rotation` should resolve to it (360) until goods.ts is
 * parameterized. That same coupling is why `metabolism` cannot yet bite at
 * town scope: the dial exists and is asserted, but a town session still eats
 * on the fixed 240 s schedule.
 */
export const DOLLHOUSE_SCALE: WorldScale = {
  dayLengthS: 240, // = dayLengthFor(360)
  rotation: 360, // the planet turns 360× — THIS is the 240 s day
  // The dollhouse spins its planet and NOTHING ELSE: the orbit, the
  // metabolism, the legs and the lifespan stay at their real anchors, because
  // compression is always a declaration. The honest consequence is a world
  // whose year still takes a real year while containing 131 490 short days —
  // seasons are unreachable, which is exactly why the shipped profile has
  // none. The diagnostics say so out loud rather than hiding it;
  // SEASONAL_SCALE below is the worked profile that fixes it.
  revolution: 1,
  sleepFraction: 0.05, // 12 s at the bed — sleep compressed past the day itself
  construction: 180, // a house in one street-day
  planetCompression: 1,
  interplanetary: 1,
  interstellar: 1,
  gapCompression: 1,
  resourceCompression: 1,
  leanFraction: REAL_LEAN_FRACTION,
  metabolism: 1,
  locomotion: 1,
  generation: 1,
  growthFraction: REAL_GROWTH_FRACTION,
};

/**
 * WORKED EXAMPLE — the first profile that satisfies BOTH the granary and the
 * session invariants at once (settlement-emergence.md §4c). Not yet booted by
 * any world; it exists so the invariant band is demonstrably reachable and so
 * step ② (seasonality) has something to run against.
 *
 * The tension it resolves is real and was found by writing these diagnostics:
 * a session must see a year turn (≈20–60 real minutes ⇒ ~5–15 game-days per
 * year at a 240 s day), but a lean season must cost 10–60 stored meals or
 * nobody ever needs a granary. At metabolism 1 those two demands are
 * INCOMPATIBLE — 12 days of eating once a day is 12 meals a year, and 40% of
 * that is 4.8. `metabolism` is the dial that reconciles them: eat three times
 * a game-day and a 12-day year holds 36 meals, of which the lean share is
 * 14.4. This is exactly why the eating period had to stop being welded to the
 * day, and why every one of these is its own multiplier.
 */
export const SEASONAL_SCALE: WorldScale = {
  dayLengthS: 240, // = dayLengthFor(360)
  rotation: 360,
  // revolutionForYearDays(360, 12) — the orbit runs ~30× faster than the spin
  // does, which is what puts 12 days in a year (48 real minutes).
  revolution: (REAL_YEAR_DAYS * 360) / 12,
  sleepFraction: 0.05,
  construction: 180,
  planetCompression: 1,
  interplanetary: 1,
  interstellar: 1,
  gapCompression: 1,
  resourceCompression: 1,
  leanFraction: REAL_LEAN_FRACTION,
  metabolism: 3, // a meal every 80 s ⇒ 36 meals/year, lean share 14.4
  locomotion: 1,
  generation: 10, // a 7-game-year life ≈ 5.6 real hours — generations ride the scrubber
  growthFraction: REAL_GROWTH_FRACTION,
};

/** Game-days for a need meter to fill under a scale — the RELATIVE pacing
 *  divided by the world's metabolic acceleration. */
export function needFillDays(scale: WorldScale, key: NeedKey): number {
  return NEED_FILL_DAYS[key] / scale.metabolism;
}

/** Seconds for a need meter to fill under a scale (rate = 1/this). */
export function needFillS(scale: WorldScale, key: NeedKey): number {
  return needFillDays(scale, key) * scale.dayLengthS;
}

/** Meter rate per second for a need under a scale. */
export function needRate(scale: WorldScale, key: NeedKey): number {
  return 1 / needFillS(scale, key);
}

/** Seconds asleep at the bed before the energy meter clears. */
export function restDwellS(scale: WorldScale): number {
  return scale.sleepFraction * scale.dayLengthS;
}

/** Game-days a structure takes to build, from its RELATIVE buildDays
 *  (house = 1; see town-play.ts TOWN_PLAY_STRUCTURES). */
export function constructionGameDays(relativeBuildDays: number, scale: WorldScale): number {
  return (relativeBuildDays * REAL_HOUSE_BUILD_DAYS) / scale.construction;
}

/**
 * Game-days a garment lasts under a scale — `REAL_CLOTHING_DAYS ÷ metabolism`.
 *
 * WEAR IS A METABOLIC PROCESS (the user's law): one factor per process class
 * applied to every species at once, exactly as `needFillDays` divides the need
 * pacings and `constructionGameDays` divides the build anchor. A world that
 * eats three times a game-day wears its clothes out three times as fast, so
 * the food:clothing ratio a household actually feels — 180 meals per garment —
 * survives compression by construction.
 *
 * Named rather than generic (`wearDays(realDays, scale)`): the codebase's own
 * shape for this is ANCHOR + NAMED DERIVATION (`REAL_HOUSE_BUILD_DAYS` /
 * `constructionGameDays`, `NEED_FILL_DAYS` / `needFillDays`), and there is
 * exactly ONE durable anchor today — a free function with a single caller
 * would be indirection without a second instance to justify it. The generic
 * shape is one rename away the day a second durable arrives.
 */
export function clothingFillDays(scale: WorldScale): number {
  return REAL_CLOTHING_DAYS / scale.metabolism;
}

/** A lifespan in GAME-YEARS (the real ~70 divided by the life acceleration).
 *  Also the number of seasonal cycles one creature witnesses — the memory of
 *  famine, and the window culture has to transmit in. */
export function lifespanGameYears(scale: WorldScale): number {
  return REAL_LIFESPAN_YEARS / scale.generation;
}

/** A lifespan in GAME-DAYS. */
export function lifespanGameDays(scale: WorldScale): number {
  return lifespanGameYears(scale) * yearGameDays(scale);
}

/**
 * ⚖️ THE GENERATION/GROWTH FAMILY PRECEDENT, generalized (S&D S3 — timber
 * lifecycle). A tree's REAL-DECADES maturity is a BIOLOGICAL clock, exactly
 * like a creature's lifespan (`lifespanGameYears`) — so it compresses on the
 * SAME ecosystem-wide `generation` dial, never `resourceCompression` (which
 * multiplies YIELD conversion, an orthogonal axis: how much a mature source
 * gives up per act, not how long it takes to become mature). The
 * "ecosystem = one ledger" law (space-time-compression.md): accelerating one
 * species' life clock without the others breaks the trophic ratios, and a
 * standing forest is as much part of that ledger as the herd grazing under it.
 *
 * Named generically (unlike `lifespanGameYears`, which has one durable
 * caller): this is the SAME shape a second biological-maturity anchor would
 * want (a herd's breeding cycle, a coppice's regrowth), so it takes its
 * anchor as a parameter from the start.
 */
export function bioYearsGameDays(scale: WorldScale, realYears: number): number {
  return (realYears / scale.generation) * yearGameDays(scale);
}

/** Game-days from birth to producing adult — the growth stage. Rides the
 *  lifespan by construction (growthFraction is a FRACTION, not a duration). */
export function growthGameDays(scale: WorldScale): number {
  return scale.growthFraction * lifespanGameDays(scale);
}


// ------------------------------------------------- the `game.scale` block

/**
 * The authored form (snake_case, like the rest of the `game` envelope).
 * Every field optional — omissions fall back to REALISM, never to a
 * compressed profile: compression is always a declaration.
 */
export interface WorldScaleSpec {
  /** Spin multiplier — 360 gives the 240 s street day. (Replaced the old
   *  absolute `day_length_s`: every compression variable is a multiplier.) */
  rotation?: number;
  /** Orbit multiplier — independent of `rotation`. */
  revolution?: number;
  sleep_fraction?: number;
  construction?: number;
  planet_compression?: number;
  /** Orbital distances ÷ this. Absent ⇒ `planet_compression` (uniform). */
  interplanetary?: number;
  /** Star separations ÷ this. Absent ⇒ `planet_compression` (uniform). */
  interstellar?: number;
  /** Town-to-town spacing ÷ this. Absent ⇒ `planet_compression` (uniform). */
  gap_compression?: number;
  /** THE RESOURCE-CONVERSION DIAL (S&D S3) — multiplies natural→usable
   *  yield (wild source yields, refine ratios, raw-material buffers).
   *  Absent ⇒ 1, the real anchors verbatim. See `WorldScale.resourceCompression`. */
  resource_compression?: number;
  lean_fraction?: number;
  metabolism?: number;
  locomotion?: number;
  generation?: number;
  growth_fraction?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

function num(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "must be a number");
  if (v < min || v > max) fail(path, `must be in ${min}..${max}`);
  return v;
}

/** Structural gate for `game.scale` — path-exact refusals, never skips. */
export function parseWorldScaleSpec(raw: unknown, path: string): WorldScaleSpec {
  if (!isObj(raw)) fail(path, "expected an object (the space-time compression declaration)");
  const allowed = [
    "rotation", "revolution", "sleep_fraction", "construction", "planet_compression",
    "interplanetary", "interstellar", "gap_compression", "resource_compression",
    "lean_fraction", "metabolism", "locomotion", "generation", "growth_fraction",
  ];
  for (const k of Object.keys(raw)) {
    // The retired absolute, named explicitly: a world that still declares it
    // gets told what to write instead, not a bare "unknown field".
    if (k === "day_length_s") {
      fail(
        `${path}.day_length_s`,
        `retired — compression is declared as a MULTIPLIER: write ` +
          `rotation: ${REAL_DAY_S} / <seconds> (240 s ⇒ rotation: 360)`,
      );
    }
    if (!allowed.includes(k)) fail(`${path}.${k}`, `unknown field (allowed: ${allowed.join(", ")})`);
  }
  const out: WorldScaleSpec = {};
  if ("rotation" in raw) out.rotation = num(raw.rotation, `${path}.rotation`, 1, REAL_DAY_S);
  if ("revolution" in raw) out.revolution = num(raw.revolution, `${path}.revolution`, 1, 10_000_000);
  if ("sleep_fraction" in raw) out.sleep_fraction = num(raw.sleep_fraction, `${path}.sleep_fraction`, 0, 0.9);
  if ("construction" in raw) out.construction = num(raw.construction, `${path}.construction`, 0.01, 100_000);
  if ("planet_compression" in raw) {
    out.planet_compression = num(raw.planet_compression, `${path}.planet_compression`, 1, 10_000);
  }
  if ("interplanetary" in raw) out.interplanetary = num(raw.interplanetary, `${path}.interplanetary`, 1, 10_000_000);
  if ("interstellar" in raw) out.interstellar = num(raw.interstellar, `${path}.interstellar`, 1, 10_000_000);
  if ("gap_compression" in raw) out.gap_compression = num(raw.gap_compression, `${path}.gap_compression`, 1, 10_000);
  // The resource-conversion dial is a YIELD multiplier, not a distance/time
  // one — legal below 1 (a world that wants scarcer conversion, testing the
  // famine end), same floor as `metabolism`/`locomotion`.
  if ("resource_compression" in raw) {
    out.resource_compression = num(raw.resource_compression, `${path}.resource_compression`, 0.01, 10_000);
  }
  // The independently-moving clocks. `rotation`/`revolution`/`planet_compression`
  // floor at 1 (the celestial dials only ever speed a world up, as the shipped
  // day length already did); the creature dials may go below 1, because a
  // slower metabolism or a longer life is a legitimate world, not a mistake.
  if ("lean_fraction" in raw) out.lean_fraction = num(raw.lean_fraction, `${path}.lean_fraction`, 0, 0.9);
  if ("metabolism" in raw) out.metabolism = num(raw.metabolism, `${path}.metabolism`, 0.01, 10_000);
  if ("locomotion" in raw) out.locomotion = num(raw.locomotion, `${path}.locomotion`, 0.01, 1_000);
  if ("generation" in raw) out.generation = num(raw.generation, `${path}.generation`, 0.01, 100_000);
  if ("growth_fraction" in raw) out.growth_fraction = num(raw.growth_fraction, `${path}.growth_fraction`, 0, 0.9);
  return out;
}

/** A document's declaration → the world's resolved physics profile.
 *  Absent fields anchor to realism. */
export function resolveWorldScale(spec?: WorldScaleSpec | null): WorldScale {
  const rotation = spec?.rotation ?? REAL_SCALE.rotation;
  // The distance dials fall back to the BODY scale, not to 1 — the universe
  // shrinks uniformly unless a world deliberately says otherwise.
  const planetCompression = spec?.planet_compression ?? REAL_SCALE.planetCompression;
  return {
    rotation,
    // DERIVED — the planet's spin IS the clock (see WorldScale.dayLengthS).
    dayLengthS: dayLengthFor(rotation),
    revolution: spec?.revolution ?? REAL_SCALE.revolution,
    sleepFraction: spec?.sleep_fraction ?? REAL_SCALE.sleepFraction,
    construction: spec?.construction ?? REAL_SCALE.construction,
    planetCompression,
    interplanetary: spec?.interplanetary ?? planetCompression,
    interstellar: spec?.interstellar ?? planetCompression,
    gapCompression: spec?.gap_compression ?? planetCompression,
    // THE PLANET_COMPRESSION-FALLBACK PRECEDENT, but the SIMPLE case: unlike
    // interplanetary/interstellar/gapCompression (which default to the BODY
    // scale, uniform-shrink), resource_compression has no parent dial to
    // cascade from — it is its own axis (yield, not distance) — so it
    // resolves exactly like `planetCompression` itself: spec value, else the
    // real anchor. Never falls back to `gapCompression` or any other dial.
    resourceCompression: spec?.resource_compression ?? REAL_SCALE.resourceCompression,
    leanFraction: spec?.lean_fraction ?? REAL_SCALE.leanFraction,
    metabolism: spec?.metabolism ?? REAL_SCALE.metabolism,
    locomotion: spec?.locomotion ?? REAL_SCALE.locomotion,
    generation: spec?.generation ?? REAL_SCALE.generation,
    growthFraction: spec?.growth_fraction ?? REAL_SCALE.growthFraction,
  };
}

/** The authored form of a profile — what a document writes to declare it. */
export function scaleSpecOf(scale: WorldScale): Required<WorldScaleSpec> {
  return {
    // `dayLengthS` is NOT emitted — it is derived from rotation, and writing
    // both would give a world two ways to say one thing.
    rotation: scale.rotation,
    revolution: scale.revolution,
    sleep_fraction: scale.sleepFraction,
    construction: scale.construction,
    planet_compression: scale.planetCompression,
    interplanetary: scale.interplanetary,
    interstellar: scale.interstellar,
    gap_compression: scale.gapCompression,
    resource_compression: scale.resourceCompression,
    lean_fraction: scale.leanFraction,
    metabolism: scale.metabolism,
    locomotion: scale.locomotion,
    generation: scale.generation,
    growth_fraction: scale.growthFraction,
  };
}

// --------------------------------------- street-clock constants (compat layer)

/**
 * The dollhouse street day — kept as named constants because the town
 * street machinery (goods.ts schedules, activity.ts meal cycles) is
 * closed-form over this fixed day and is not yet WorldScale-parameterized.
 */
export const DAY_S = DOLLHOUSE_SCALE.dayLengthS;
/** How much faster the street clock runs than reality (~360×). */
export const TIME_COMPRESSION = REAL_DAY_S / DAY_S;
/** Town behavior sessions show a 60 s observed day — playback ×4 over the
 *  street day, not different physics (doc §6). */
export const TOWN_SESSION_PLAYBACK = 4;
export const TOWN_SESSION_DAY_S = DAY_S / TOWN_SESSION_PLAYBACK; // 60

/** Street-clock need fill times in seconds (the shipped dollhouse pacing). */
export const NEED_FILL_S = {
  hunger: needFillS(DOLLHOUSE_SCALE, "hunger"), // 240
  energy: needFillS(DOLLHOUSE_SCALE, "energy"), // 384
  social: needFillS(DOLLHOUSE_SCALE, "social"), // 192
  fun: needFillS(DOLLHOUSE_SCALE, "fun"), // 240
  thirst: needFillS(DOLLHOUSE_SCALE, "thirst"), // 300
  waste: needFillS(DOLLHOUSE_SCALE, "waste"), // 600
  hygiene: needFillS(DOLLHOUSE_SCALE, "hygiene"), // 700
  dirt: needFillS(DOLLHOUSE_SCALE, "dirt"), // 480
} as const;

/** The street-clock sleep dwell (12 s). */
export const REST_DWELL_S = restDwellS(DOLLHOUSE_SCALE);

// ------------------------------------------------------------------- movement

/** Villager walking pace (m/s) — realistic, groceries in hand (goods.ts). */
export const ERRAND_WALK_MPS = 1.6;

/** The villager pace under a world's `locomotion` dial (m/s). Gait is its own
 *  declaration: a world may compress its clock hard and keep real legs (which
 *  is the shipped dollhouse, and the reason the walking trilemma exists). */
export function walkSpeedMps(scale: WorldScale, baseMps: number = ERRAND_WALK_MPS): number {
  return baseMps * scale.locomotion;
}

// ------------------------------------------- needs-aware town construction

/**
 * Share of ONE fill cycle of the served need a body may spend on the
 * round-trip errand walk before service breaks down: leave at half-empty,
 * arrive before the meter fills, be home before the next pang. Past this,
 * the household "lives on the road" — hungry again mid-commute.
 */
export const ERRAND_SHARE = 0.5;

/**
 * THE DISTRICT SIZER: one-way street metres a service point (market stall,
 * well) may sit from a household it serves. The same derivation as town
 * spacing ("a day's walk apart"), one rung down: a district is "a need
 * cycle's walk across". Faster-draining needs ⇒ smaller radius ⇒ denser
 * facilities; under REAL_SCALE the radius (~35 km) exceeds any town, so the
 * whole town is ONE district with one central market and well — the
 * historical village. Compression shrinks the radius with the clock, never
 * by a hand-tuned literal.
 */
export function serviceRadiusM(
  scale: WorldScale,
  need: NeedKey,
  walkMps: number = walkSpeedMps(scale),
): number {
  return (walkMps * needFillS(scale, need) * ERRAND_SHARE) / 2;
}

// ---------------------------------------------------- the settled map's scale
//
// The rung ABOVE serviceRadiusM: how far apart towns stand, and how big each
// one may get. Both are ANCHOR + NAMED DERIVATION — the shape this file uses
// everywhere (REAL_HOUSE_BUILD_DAYS/constructionGameDays,
// REAL_CLOTHING_DAYS/clothingFillDays) — so "a day's walk apart" stays a real
// fact about Earth and every world states its own departure as a multiplier.

/**
 * THE TOWN SPACING: metres between neighbouring settlements on this world.
 *
 * `REAL_TOWN_SPACING_M × locomotion ÷ gapCompression` — the historical
 * day's-walk anchor, carried by this world's legs, divided by its declared
 * settlement-gap compression. REAL reproduces 25 000 m EXACTLY (the identity
 * `townSpacingM(REAL_SCALE) === REAL_TOWN_SPACING_M`).
 *
 * `locomotion` is the one dial in it: gait is where space and time meet
 * (see `walkSpeedMps`), so a world with twice the legs really does put its
 * market towns twice as far apart.
 *
 * THE CLOCK IS DELIBERATELY ABSENT, and this is the load-bearing decision.
 * Reading the spacing off the world's own day (`dailyTravelM × ERRAND_SHARE`,
 * which lands within 8% of the anchor at REAL) is arithmetically tempting and
 * physically wrong here, because the shipped street clock compresses the day
 * 360× while keeping REAL legs and REAL houses — the walking trilemma this
 * file documents. A clock-derived spacing would stand a dollhouse town 91 m
 * from its neighbour while its own houses are 10 m wide and its extent is
 * 450: the town would swallow four of its neighbours. Distance compression is
 * `gapCompression`'s job, and time compression must not do it by the back
 * door.
 *
 * THE 1/360, WRITTEN OUT, because it is the reason the clock stays out
 * (food-scale-round.md Q1). The compression ratio is not a tuning choice; it
 * IS `rotation`:
 *
 * ```
 * food-derived one-way reach = walk × hungerPeriodS × ERRAND_SHARE / 2
 * REAL      : 1.6 × 86 400 × 0.5 / 2 = 34 560 m   (1.38× the 25 km anchor)
 * DOLLHOUSE : 1.6 ×    240 × 0.5 / 2 =     96 m
 * ratio     : 34 560 / 96 = 360      ← EXACTLY `rotation`
 * ```
 *
 * The day is compressed 360× while legs (`locomotion 1`) and need-days
 * (`metabolism 1`) stay real, so EVERY food-PACED distance is 1/360 of its
 * real self. That is the shrink this function refuses to inherit.
 *
 * BUT FOOD DOES ENTER — THROUGH THE CATCHMENT, NEVER THROUGH THE DAY. `popCap`
 * turns the declared lattice into `max(declared, catchmentSpacingM(popCap))`:
 * how far apart these settlements must stand for each to have LAND enough to
 * eat. That term is pure AREA — population × acres ÷ arable share — with no
 * clock in it at all, which is exactly why it is allowed in where
 * `dailyTravelM` is not. Absent `popCap` the answer is the declared lattice,
 * byte-identical to every existing caller.
 */
export function townSpacingM(scale: WorldScale, popCap?: number): number {
  const declared = (REAL_TOWN_SPACING_M * scale.locomotion) / scale.gapCompression;
  if (popCap === undefined || !(popCap > 0)) return declared;
  return Math.max(declared, catchmentSpacingM(popCap, scale));
}

/**
 * Share of a settlement's territory that is FIELD. The rest is wood, pasture,
 * water and rock — the wilds the resource catchment needs, and the reason a town's
 * hinterland is not a disc of wheat. Earth-temperate anchor (the F4 pattern);
 * a biome that knows better is the spec's business.
 */
export const REAL_ARABLE_FRACTION = 0.25;

/**
 * Share of its arable territory a settlement keeps UNPLOUGHED — lean-season
 * slack, which is what makes a granary worth building rather than mandatory to
 * survive. Sized against `REAL_LEAN_FRACTION`: a third of the lean season's
 * bite, carried as land rather than as store.
 */
export const REAL_FOOD_HEADROOM = 0.3;

/**
 * THE STAPLE CATCHMENT: metres between neighbouring settlements of `pop` souls at
 * which each still has the LAND to feed itself, at this world's conversion
 * dial (food-scale-round.md Q3).
 *
 * ```
 * territory   = spacing²                       (a site owns its lattice cell)
 * field need  = pop × farmAreaPerPersonM2(tier, resourceCompression) × (1 + σ)
 * usable      = territory × REAL_ARABLE_FRACTION × (1 − REAL_FOOD_HEADROOM)
 * ⇒ spacing   = sqrt(field need / (arable × (1 − headroom)))
 * ```
 *
 * ⚖️ THE FAMINE TRAP BECOMES UNREPRESENTABLE. A world that declares a tight gap
 * and a stingy `resource_compression` no longer starves — the catchment pushes its
 * towns apart until they can eat. Same inversion `serviceRadiusM` performs one
 * rung down: the need sizes the space, the space is not hand-tuned and then
 * hoped over.
 *
 * ⚖️ σ IS THE PRODUCER'S, NOT A DIAL (`REAL_SURPLUS_FRAC`) — `staple` here,
 * because a settlement's catchment is sized by its staple, and `resource_compression`
 * is applied ONCE inside `farmAreaPerPersonM2` and never multiplied into σ.
 *
 * ⚖️ "SOURCE" AND "CATCHMENT" ARE ROLES, NOT TYPES — the same region that is
 * a settlement's catchment for its staple is a source when goods are drawn
 * FROM it (a depot both stores the harvest locally and is the source it is
 * distributed from).
 */
export function catchmentSpacingM(
  pop: number,
  scale: WorldScale,
  tier: FarmTechTier = "ancient",
  surplusFrac: number = REAL_SURPLUS_FRAC.staple,
): number {
  if (!(pop > 0)) return 0;
  const needM2 = pop * farmAreaPerPersonM2(tier, scale.resourceCompression) * (1 + surplusFrac);
  return Math.sqrt(needM2 / (REAL_ARABLE_FRACTION * (1 - REAL_FOOD_HEADROOM)));
}

/**
 * Share of the road between two neighbouring towns that must stay OPEN
 * COUNTRY. At ½ the road divides evenly — a town's extent at each end, and as
 * much country between them as the two towns take together.
 *
 * This is what makes a PORT mean something. `planet/routes.ts` clips a road
 * at each town's extent, and a port is by definition "the crossing of a
 * boundary into open country"; where the two extents swallow the whole road
 * there is no country to cross, so the road comes back unclipped and runs
 * through the buildings. Declaring how much of the gap belongs to the country
 * is how the extent learns to stay out of the way.
 */
export const OPEN_COUNTRY_SHARE = 0.5;

/**
 * THE TOWN EXTENT: how far out a town on this world may build.
 *
 *   `min(REAL_TOWN_EXTENT_M, spacing × (1 − OPEN_COUNTRY_SHARE) / 2)`
 *
 * Two terms, two kinds of truth. The first is CONTENT — the size a town is
 * allowed to grow to at all (dimensions.ts's declared extent). The second is
 * PHYSICS — the size this particular world can hold without its towns eating
 * the roads between them.
 *
 * THE CLIP LAW, which the second term exists to satisfy:
 *
 *   `2 × extent + MIN_PORT_ROUTE_M < the shortest route on the world served`
 *
 * It holds by construction for any spacing above 20 m, since
 * `2 × spacing/4 + 10 = spacing/2 + 10 < spacing`, and a route is never
 * shorter than the spacing that founded its endpoints. There is deliberately
 * NO floor under the result: a floor would be a licence to swallow the road,
 * and `growStreets` already clamps its own gate for a town too small to grow.
 *
 * REAL reproduces 450 m EXACTLY (25 km of spacing puts the clip ceiling at
 * 6 250 m, so the declared extent is what binds) — the identity
 * `townExtentM(REAL_SCALE) === REAL_TOWN_EXTENT_M`.
 *
 * `spacingM` overrides the declared spacing for a caller that knows the gap
 * its OWN tier actually enforces — the village tiers of `planet/refine.ts`
 * and `planet/border.ts` round the spacing to a whole number of chart cells
 * and floor it at 4, so on a small world the gap they really impose can be
 * narrower than the world declares, and the extent must follow the gap that
 * exists rather than the one that was asked for.
 */
export function townExtentM(
  scale: WorldScale,
  spacingM: number = townSpacingM(scale),
): number {
  return tierExtentM("town", scale, spacingM);
}

/**
 * THE TOWN EXTENT, BY TIER — `townExtentM`'s clip law applied to the tier's own
 * declared body (`REAL_TIER_EXTENT_M`) instead of to the market town's.
 * `townExtentM` IS `tierExtentM("town", …)`, so there is still exactly one clip
 * and one place the extent is decided.
 *
 * A hamlet is not a market town: before the tier anchors, every settlement on a
 * world declared 450 m and only the clip law (a physics term, about roads) told
 * them apart — so a compressed world shrank its CITY to hamlet size while its
 * hamlets stayed 450. The tier is CONTENT ("how big is this kind of place"),
 * the clip is PHYSICS ("how big can this world hold"), and the answer is the
 * smaller of the two, as it always was.
 *
 * The geometric floor lives at the TIER (see `STREET_TREE_MIN_EXTENT_M`), never
 * here: no floor under the clip, for the reason stated above.
 */
export function tierExtentM(
  tier: SettlementTier,
  scale: WorldScale,
  spacingM: number = townSpacingM(scale),
): number {
  return Math.min(REAL_TIER_EXTENT_M[tier], (spacingM * (1 - OPEN_COUNTRY_SHARE)) / 2);
}

// ------------------------------------------------------------ farmland realism
//
// THE AREA SEAM (economy-arc-opening.md, SUPPLY & DEMAND ROUND S2). USER LAW
// (feedback_world_size_resource_realism, 2026-08-12), verbatim: *"The amount
// of farmland needed per person varied by technology and diet but ranged
// from 12 acres in ancient times to 0.5 acres in modern times... this should
// be anchored in realism and adjusted by the world's compression parameters,
// which probably can be handled by a single value that multiplies the
// conversion of natural resources to usable ones."*

/** One acre, in square metres — the unit the anchor below is quoted in. */
export const M2_PER_ACRE = 4_046.8564224;

/**
 * REAL_ anchor (the F4 pattern): acres of farmland one person needs to eat,
 * by technology tier — the user's own two data points, verbatim. Nothing
 * shipped needs a tier between them yet, so the table carries only the two;
 * a caller naming a third tier is a content error, not a silent guess.
 */
export const REAL_FARM_ACRES_PER_PERSON = {
  ancient: 12,
  modern: 0.5,
} as const;

export type FarmTechTier = keyof typeof REAL_FARM_ACRES_PER_PERSON;

/**
 * Acres of farmland one person needs at a tech tier, ÷ the natural→usable
 * conversion dial. THE S3 SEAT, NOW WIRED: `resource_compression`
 * (`WorldScale.resourceCompression`) is the `conversionDial` argument —
 * `plan.ts`'s field geometry and `town-play.ts`'s farm process both pass
 * `scale.resourceCompression` (S2 had no field to read yet and passed the
 * default 1 everywhere; the formula was written divisor-first for exactly
 * this reason). Default 1 stays the real anchor, byte-identical.
 */
export function farmAcresPerPerson(tier: FarmTechTier, conversionDial = 1): number {
  return REAL_FARM_ACRES_PER_PERSON[tier] / conversionDial;
}

/** The same anchor, in square metres — what area math over `TownField` rects
 *  actually wants. */
export function farmAreaPerPersonM2(tier: FarmTechTier, conversionDial = 1): number {
  return farmAcresPerPerson(tier, conversionDial) * M2_PER_ACRE;
}

/**
 * ITEMS one square metre of crop hands over per day — the FIELD'S MINT RATE
 * (food-scale-round.md E-round §E2②), and the closed form that turns the field
 * from a coloured slab into a resource source with a real output.
 *
 * ```
 * yieldPerM2Daily = 1 / ( farmAreaPerPersonM2(tier, dial) × satiationDays )
 *                 = 1 / ( 2 428 × 0.2 )  =  1 carrot per 485.6 m² per day
 * ```
 *
 * ⚖️ IT IS THE TWO ANCHORS DIVIDED, NOT A THIRD NUMBER. `farmAreaPerPersonM2`
 * says how much land feeds one person for a day; `satiationDays` says how much
 * of that person-day ONE ITEM is (`kernel/town/goods-kinds.ts satiationDaysOf`,
 * passed in rather than imported — this module sits under the glyph
 * vocabulary). Their product is "land per item per day", and this is its
 * reciprocal. Nothing here is tuned.
 *
 * THE σ IDENTITY, which is what makes it safe to size a region this way: a
 * field sized for `pop` at surplus σ is `pop × A × (1 + σ)` m², so its output
 * is `pop × (1 + σ) / satiationDays` items/day against a table demand of
 * `pop / satiationDays` — the ratio is EXACTLY `1 + σ`, at any dial, any tier
 * and any crop. The Q3 village: 1 092 651 m² ÷ 485.6 = 2 250 items/day against
 * 375 ÷ 0.2 = 1 875 wanted, and 2 250 / 1 875 = 1.20 = σ.
 *
 * ⚖️ GROWTH TIMING IS NOT THIS. How fast a crop ripens rides `generation` (the
 * ecosystem-wide life-acceleration dial every creature ages on); only YIELD PER
 * ACT reads `resource_compression`. Growing faster and yielding more are
 * orthogonal facts about a compressed world — see the dial law above.
 */
export function yieldPerM2Daily(
  tier: FarmTechTier,
  scale: WorldScale,
  satiationDays: number,
): number {
  if (!(satiationDays > 0)) return 0;
  return 1 / (farmAreaPerPersonM2(tier, scale.resourceCompression) * satiationDays);
}

// ------------------------------------------------------------ σ, THE SURPLUS
//
// THE SURPLUS FRACTION (economy-arc-opening.md, SUPPLY & DEMAND ROUND — the
// σ close). USER LAW (feedback_order_scoping_and_growth_motive.md, addendum σ,
// 2026-08-12): *anchor σ in realism; σ is PER-PRODUCER (a spec-side seat on
// the producer row); the deciding machinery — the risk/growth adjustment a
// settlement actually makes — belongs to the scope's GOVERNMENT
// (influence-and-authority), and the anchor here is the DEFAULT that a future
// government adjusts.*
//
// WHY IT HAD TO EXIST. S2 sized a town's fields at exactly `pop × acres`, so
// the books closed at `food_got ≡ food_need` to the last bit — an economy
// with no slack at all. Nothing drifted into the granary, so no work was ever
// funded out of it: weavers = tailors = 0, `clothing_got` = 0, and (through
// `prosperitySignals`' unmet-demand gate) no household on the map could ever
// bank again. A producer that plans for EXACTLY the table is not realism; it
// is the one thing no farmer has ever done.

/**
 * REAL_ anchor (the F4 pattern): the fraction ABOVE the demand it is sized
 * against that a producer honestly plans to make.
 *
 * **`staple` = 0.20 — the reasoning, recorded.** Pre-industrial agrarian
 * societies carried a non-farming population of roughly 10–20% (medieval
 * Europe ~10–15% urban, Roman Egypt ~20%), and a farmer sows past the family
 * table for four more reasons that have nothing to do with towns: SEED CORN
 * for next spring, STORAGE LOSS in the granary, the TITHE/rent, and the lean
 * year. Measured against TOTAL consumption — which is what `food_need`
 * already counts, farmers included — the honest band a good year leaves above
 * the table is 10–30%; 0.20 is its middle and the value the shipped
 * hand-farmed "ancient" tier (`REAL_FARM_ACRES_PER_PERSON.ancient`) can
 * actually hold. It is deliberately NOT tuned to a play outcome.
 *
 * **`craft` = 0.10 — half the staple, and why.** A workshop plans a smaller
 * cushion than a farm: its input is bought rather than sown a season ahead,
 * its output does not rot, and cloth nobody wants is capital tied up rather
 * than a hedge against famine. This is the CLASS DEFAULT every producer that
 * declares nothing inherits.
 *
 * ⚖️ NOT A DIAL. σ is a producer's declared plan, not a world conversion
 * factor — `resource_compression` is applied ONCE at the natural→usable
 * boundary (S3's review correction) and these two must never be multiplied
 * into each other. A world that compresses conversion still leaves its
 * farmers the same 20% margin above whatever the table then costs.
 */
export const REAL_SURPLUS_FRAC = {
  staple: 0.2,
  craft: 0.1,
} as const;

export type SurplusClass = keyof typeof REAL_SURPLUS_FRAC;

/**
 * The surplus fraction a producer actually plans for: ITS OWN declared seat
 * when the spec named one, else its class anchor.
 *
 * ⚖️ THE GOVERNMENT SEAM. `declared` is where a settlement's own decision
 * lands. Today nothing writes it but the content document itself; the
 * ADJUSTER — a scope that raises its margin against a remembered famine or
 * lowers it to free hands for the walls — is the government tier
 * (planning-docs/games/world-engine/influence-and-authority.md), which does
 * not exist yet. Everything downstream reads THIS function, so when that tier
 * lands it has exactly one seat to write and no formula to re-derive.
 */
export function producerSurplusFrac(
  declared: number | undefined,
  cls: SurplusClass = "craft",
): number {
  return typeof declared === "number" && Number.isFinite(declared) && declared >= 0
    ? declared
    : REAL_SURPLUS_FRAC[cls];
}

// --------------------------------------------------------------------- space

/**
 * Metres per HEIGHT-FIELD unit — the default travel.ts uses for slope grades.
 * NOTE: this is a fallback for grids that don't say better. The height bake's
 * true value is derived (climate.ts documents it as relief × radius / (63 −
 * seaHeight), ~150 on a real-radius planet); callers that know their bake
 * should pass it rather than lean on this default.
 */
export const METRES_PER_HEIGHT_UNIT = 10;
/** Metres per cell-center distance unit — travel.ts default (refine cellSizeM). */
export const METRES_PER_CELL = 1_000;

// ------------------------------------------------------- diagnostics (doc §7)
// Pure helpers that turn the spec values into the dimensionless ratios where
// incoherence hides. Asserted in server/tests/world-scale.test.ts so the
// numbers are documentation, not surprises.

/** Game-days to cover a distance at a speed. */
export function gameDaysToCross(distanceM: number, speedMps: number, dayS: number = DAY_S): number {
  return distanceM / speedMps / dayS;
}

/** Distance one game-day of travel covers, in metres. */
export function dailyRangeM(speedMps: number, dayS: number = DAY_S): number {
  return speedMps * dayS;
}

/**
 * Effective road speed with a mount, from the travel.ts cost model: a road
 * divides step cost by 1/roadFactor and a full mount divides again by
 * mountFactor — the mounted courier on a road is the fastest thing in the world.
 */
export function roadMountSpeedMps(walkMps: number, roadFactor = 0.35, mountFactor = 2): number {
  return (walkMps / roadFactor) * mountFactor;
}

/** Settlements a planet supports at a given spacing (doc §5's derived count). */
export function townsOnPlanet(radiusM: number, spacingM: number, landFraction: number): number {
  return (4 * Math.PI * radiusM * radiusM * landFraction) / (spacingM * spacingM);
}

/** Real days for one game-year to pass — the multiplayer aging cadence. */
export function realDaysPerGameYear(dayS: number = DAY_S, yearDays: number = REAL_YEAR_DAYS): number {
  return (yearDays * dayS) / REAL_DAY_S;
}

// ------------------------------------ settlement ratios (settlement-emergence §4b)
//
// THE LAW these serve: no settlement rule may name an absolute duration,
// distance or quantity, because metabolism, gait, the day, the year, the
// lifespan and the growth stage are INDEPENDENT declarations. Every gate is a
// ratio between two of them, and these are the ratios.

/** Rations one creature eats per game-year — one year's consumption. */
export function mealsPerYear(scale: WorldScale): number {
  return yearGameDays(scale) / needFillDays(scale, "hunger");
}

/**
 * THE GRANARY NUMBER: rations one creature must have stored to cross the lean
 * season. The single quantity that decides whether settling is worth doing —
 * too small and nobody ever needs a granary (so nobody ever stops moving), too
 * large and the store can never be accumulated (so everyone starves first).
 */
export function leanSeasonMeals(scale: WorldScale): number {
  return scale.leanFraction * mealsPerYear(scale);
}

/**
 * THE OX PARADOX, dimensionless: game-days a hauler can travel on a payload of
 * `portableRations` before it has eaten the cargo. Halve it for a round trip.
 * This is what makes Gate A's `store > carryCapacity` a real constraint, and
 * it is the same arithmetic resources-and-trade.md reads at caravan scale.
 */
export function carryDays(scale: WorldScale, portableRations: number): number {
  return portableRations * needFillDays(scale, "hunger");
}

/** Metres of ground a creature covers in one game-day of waking travel. */
export function dailyTravelM(scale: WorldScale, mps: number = walkSpeedMps(scale)): number {
  return mps * scale.dayLengthS * (1 - scale.sleepFraction);
}

/** The one-way radius a band can work from camp and still sleep there — half
 *  a day's travel out, half back. The forage-side twin of serviceRadiusM. */
export function forageRadiusM(scale: WorldScale, mps: number = walkSpeedMps(scale)): number {
  return dailyTravelM(scale, mps) / 2;
}

/** Non-producing mouths per producing adult, from the growth stage alone.
 *  The floor under Gate B: surplus per producer must clear 1 + this before
 *  anyone can eat without farming. */
export function dependencyRatio(scale: WorldScale): number {
  return scale.growthFraction / (1 - scale.growthFraction);
}

/** Rations one creature consumes over a whole life — the lifetime food cost
 *  of a person. THE coupling check between `metabolism` and `generation`:
 *  moving those dials apart moves this number, and this number sets how much
 *  surplus a society needs to carry anyone at all. */
export function mealsPerLifetime(scale: WorldScale): number {
  return mealsPerYear(scale) * lifespanGameYears(scale);
}

/** Real minutes for one game-year to pass — does a play session see a season
 *  turn? (The AAC/teaching stake: a cycle a child can watch complete.) */
export function realMinutesPerYear(scale: WorldScale): number {
  return yearLengthS(scale) / 60;
}

/** Real hours one creature's whole life takes — can a generation be LIVED, or
 *  must it be read on the history scrubber? */
export function realHoursPerLifespan(scale: WorldScale): number {
  return (lifespanGameDays(scale) * scale.dayLengthS) / 3600;
}

/**
 * How much larger a neighbouring body looms than it really would — angular
 * size is radius ÷ distance, so this is `interplanetary / planetCompression`.
 * 1 = the honest sky (the uniform default, relative scales preserved); >1 =
 * the storybook sky, moons filling the horizon. Reported rather than assumed,
 * because a world that wants that look should have ASKED for it.
 */
export function apparentSizeGain(scale: WorldScale): number {
  return scale.interplanetary / scale.planetCompression;
}

/** The same for the night sky: how much brighter/nearer the stars sit than
 *  their real proportions. */
export function apparentStarGain(scale: WorldScale): number {
  return scale.interstellar / scale.planetCompression;
}

// ---- the invariant bands (settlement-emergence §4c) ----
// Provisional and playtest-owned; named so the tests, the diagnostics and any
// future world spec argue over ONE pair of numbers.

/** Lean-season rations per creature: below this a granary is pointless — the
 *  store is a pocketful, nothing has to be guarded, and nothing ever settles.
 *  This is the load-bearing half of the invariant. */
export const GRANARY_MEALS_MIN = 10;
/**
 * ...and above this the store is absurd. A SOFT ceiling: the real anchor is
 * ~146 (a temperate winter at one ration a day) and real granaries really did
 * hold that, so realism sits comfortably inside. What it catches is the
 * degenerate case — a fast spin with an uncompressed orbit, where a "year"
 * holds 131 490 days and no band could ever bank the winter.
 *
 * The true ceiling is not a scale property at all: whether a store can be
 * ACCUMULATED depends on fat-season surplus, which is yield, which is Gate A's
 * business, not the clock's. This number only flags the impossible.
 */
export const GRANARY_MEALS_MAX = 400;
/** Real minutes per game-year: below this seasons flicker past unread. */
export const SESSION_YEAR_MIN_MINUTES = 20;
/** ...above this a sitting never sees the cycle close. */
export const SESSION_YEAR_MAX_MINUTES = 60;
/** Built extent below which a town is not a town: it cannot hold a plaza and
 *  the ring of frontage around it, so `gap_compression` has been declared
 *  past the point where settlements exist. Reported, never enforced. */
export const TOWN_EXTENT_VIABLE_M = 60;
/** Generations over which coercion turns net-negative on state capacity
 *  (exploitation-economics.md §Q4) — the arc a world must be able to SHOW,
 *  whether by living it or by scrubbing it. */
export const GENERATIONS_FOR_RATCHET = 10;

/** Every §4b ratio for a scale, in one object — for tests, the lab HUD, and
 *  the pedagogy anchor ("in this world a year is 48 minutes; really it is
 *  365 days"). */
export function scaleRatios(scale: WorldScale) {
  return {
    mealsPerYear: mealsPerYear(scale),
    leanSeasonMeals: leanSeasonMeals(scale),
    dependencyRatio: dependencyRatio(scale),
    mealsPerLifetime: mealsPerLifetime(scale),
    yearGameDays: yearGameDays(scale),
    lifespanGameYears: lifespanGameYears(scale),
    growthGameDays: growthGameDays(scale),
    forageRadiusM: forageRadiusM(scale),
    townSpacingM: townSpacingM(scale),
    townExtentM: townExtentM(scale),
    apparentSizeGain: apparentSizeGain(scale),
    apparentStarGain: apparentStarGain(scale),
    realMinutesPerYear: realMinutesPerYear(scale),
    realHoursPerLifespan: realHoursPerLifespan(scale),
    realHoursForRatchet: realHoursPerLifespan(scale) * GENERATIONS_FOR_RATCHET,
  };
}

/**
 * Invariant breaches for a scale, as readable sentences (empty = coherent).
 * Deliberately NOT a throw: an incoherent world is legal and sometimes
 * intended (the shipped dollhouse has no seasons at all). The doctrine is that
 * incoherence must be a visible number, never an ambush — so this reports, and
 * the tests pin what it reports.
 */
export function scaleWarnings(scale: WorldScale): string[] {
  const out: string[] = [];
  const lean = leanSeasonMeals(scale);
  if (lean < GRANARY_MEALS_MIN) {
    out.push(
      `granary: a lean season costs ${lean.toFixed(1)} rations (< ${GRANARY_MEALS_MIN}) — ` +
        `storing is pointless, so nothing ever settles`,
    );
  } else if (lean > GRANARY_MEALS_MAX) {
    out.push(
      `granary: a lean season costs ${lean.toFixed(1)} rations (> ${GRANARY_MEALS_MAX}) — ` +
        `no band can bank that, so nothing survives the winter`,
    );
  }
  const yr = realMinutesPerYear(scale);
  if (yr < SESSION_YEAR_MIN_MINUTES) {
    out.push(`session: a year passes in ${yr.toFixed(1)} real minutes — seasons flicker past unread`);
  } else if (yr > SESSION_YEAR_MAX_MINUTES) {
    out.push(`session: a year takes ${yr.toFixed(1)} real minutes — a sitting never sees the cycle close`);
  }
  // THE SETTLED MAP: a gap so compressed that a town cannot hold its own
  // buildings. `townExtentM` will honour it (the clip law has no floor —
  // that is the point), so the world should hear about it out loud.
  const extent = townExtentM(scale);
  if (extent < TOWN_EXTENT_VIABLE_M) {
    out.push(
      `gap: towns stand ${Math.round(townSpacingM(scale))} m apart, so each may build ` +
        `only ${Math.round(extent)} m out (< ${TOWN_EXTENT_VIABLE_M}) — ` +
        `smaller than a plaza, and the settled map cannot hold buildings`,
    );
  }
  if (scale.growthFraction <= 0) {
    out.push(`growth: no childhood — nothing is inherited, taught, or transmitted`);
  } else if (dependencyRatio(scale) > 1) {
    out.push(
      `growth: ${dependencyRatio(scale).toFixed(2)} dependents per producer — ` +
        `childhood outweighs adulthood and no surplus can form`,
    );
  }
  return out;
}

// ------------------------------------------------------ transaction pacing
//
// THE GENERIC TRANSACTION-PACING SEAT.
//
// USER LAW (2026-08-13), verbatim: *"Food per day isn't meant to be a
// constant, and other forms of barter aren't either - they are supposed to
// emerge from the needs of the entities performing the transaction, whether
// they are people, people and livestock, caravans, cities, countries, or
// otherwise. So... these constants probably SHOULD be merged, or more
// accurately, tied to a generic variable that is given specific values by
// the transaction in question."*
//
// WHY THIS LIVES HERE, NOT IN kernel/town. `barter.ts`'s standing-route
// shipment leg (`BARTER_LEG_DAY_FRAC`) and `trade.ts`'s abstract caravan's
// in-town visit budget (the day-fraction its speed is sized against) were two
// separately-declared `0.35`s — the same number, meaning the same thing
// (how much of a street day one shipment's travel/dwell eats), typed twice
// because neither module could import the other's home without closing
// barter → transfer → trade into a cycle. `scale.ts` sits BELOW that whole
// chain (both `barter.ts` and `trade.ts` already import it directly, and it
// imports nothing from `kernel/town`), so it is the one place both call
// sites can reach without adding an edge either has to worry about.
// `kernel/town/pricing.ts` was the first candidate — the codebase's own
// "one-formula-home" for cross-rung pricing seats — but it transitively
// depends on `trade.ts` already (`pricing.ts` → `scope-shape.ts` →
// `goods-kinds.ts` → `import { RARE_IMPORT_KIND } from "./trade.js"`, a real
// value import), so `trade.ts` importing `pricing.ts` would close exactly
// the cycle this seat exists to avoid. `scale.ts` has no imports of its own
// and is the one module already legal on both sides of the chain.
//
// ⚖️ THE VALUE BELONGS TO THE TRANSACTION AND ITS PARTIES, not the clock.
// A day-fraction like this is not a fact about the WORLD (unlike
// `dayLengthS` or `metabolism` above it in this file) — it is a fact about
// WHO IS TRADING: a caravan's own carry capacity and the hunger of its
// porters, a household's own time-elasticity between a chore and a errand, a
// city's own logistics and standing garrisons, a country's own diplomatic
// patience. Two people trading a basket of eggs across a fence do not
// share a shipment leg with a caravan crossing a kingdom, even though both
// are "a transaction" — the FRACTION OF A DAY either one spends in the act
// is a property of the entities doing it, not a constant the calendar hands
// down.
//
// ⚖️ ENTITY-DERIVED VALUES ARRIVE WITH THE DETAILED SUPPLY-AND-DEMAND
// ECONOMICS, not before, and not as a guess. A caravan's real pacing wants
// its own carry-capacity and appetite (the Ox Paradox this file's
// `carryDays` already prices); a city's wants its own granary and
// population; a nation's wants its own logistics network. None of that
// exists yet at the transaction rung, so v1 of this seat answers every
// `kind` with the SAME shipped default — `TRANSACTION_DAY_FRAC_DEFAULT`,
// bit-identical to the two `0.35`s it replaces. This seat changes WHO ASKS
// (both call sites now name their transaction kind explicitly), never WHAT
// IS ANSWERED, until an entity actually has needs to derive from.
//
// ⚖️ AND `FOOD_DAY_SEC` ITSELF IS INDICTED THE SAME WAY. The street day a
// transaction's fraction multiplies (`goods.ts` `FOOD_DAY_SEC`) is its own
// flat, undeclared constant — every shipment leg and every caravan visit
// answers "how long is a day" with one hard-coded number regardless of who
// is asking, exactly the fault this seat was built to fix one rung up. That
// is RECORDED here, not fixed: `FOOD_DAY_SEC` is unquestioned by this round,
// its own future seat for a later pass.

/** Every transaction kind this seat answers today — barter.ts's standing
 *  shipment leg and trade.ts's abstract caravan visit. Both anchor to the
 *  SAME shipped default until either has entity-derived needs to read
 *  instead (see the section header above). */
export type TransactionKind = "shipment-leg" | "caravan-visit";

/** The flat day-fraction every transaction kind anchors to today — the ONE
 *  number `BARTER_LEG_DAY_FRAC` (barter.ts) and the caravan visit budget
 *  (trade.ts, sizing the abstract caravan's on-street speed) separately
 *  declared before this seat existed. */
export const TRANSACTION_DAY_FRAC_DEFAULT = 0.35;

/**
 * THE SEAT: a transaction's day-fraction, keyed by what kind of transaction
 * it is. v1 answers every kind with the shipped default — bit-identical to
 * the two constants this merges — because no `kind` yet carries the
 * entities' own needs, time-elasticity or carry arrangements to derive a
 * real answer from (see the section header for what changes when one does).
 */
export function transactionDayFrac(txn: { kind: TransactionKind }): number {
  void txn; // v1: every kind reads the same anchor — see the header above.
  return TRANSACTION_DAY_FRAC_DEFAULT;
}
