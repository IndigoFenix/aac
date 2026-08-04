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
/** A real house takes roughly half a year to raise — the construction
 *  factor's anchor (a structure's relative buildDays are multiples of it). */
export const REAL_HOUSE_BUILD_DAYS = 180;
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
    "interplanetary", "interstellar",
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
