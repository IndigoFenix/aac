// shared/world-engine/scale.ts
//
// THE one place real↔game scale lives (planning-docs/games/space-time-compression.md).
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

// -------------------------------------------------------------- the WorldScale

/**
 * Need fill times in GAME-DAYS (rate/sec = 1 / (days × dayLengthS)). These are
 * the RELATIVE pacings — a person eats daily, changes clothes every two days —
 * and they hold at any day length; compression changes the day, not the
 * ratios (the ecosystem-is-one-ledger law, doc §4).
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
  /** Real seconds per game-day — THE clock. Real world: 86 400. */
  dayLengthS: number;
  /** Fraction of the day spent asleep (the rest dwell). Real world: ⅓. */
  sleepFraction: number;
  /** Construction acceleration beyond the day: game-days to build =
   *  relative buildDays × REAL_HOUSE_BUILD_DAYS ÷ construction. 1 = a house
   *  takes half a year of game-days; 180 = a house rises in one game-day. */
  construction: number;
  /** Planet miniaturization: body radii ÷ this (masses ÷ this², so surface
   *  gravity is preserved). 1 = real-size planets. */
  planetCompression: number;
}

/** The engine default: realism. A world that declares nothing gets this. */
export const REAL_SCALE: WorldScale = {
  dayLengthS: REAL_DAY_S,
  sleepFraction: REAL_SLEEP_FRACTION,
  construction: 1,
  planetCompression: 1,
};

/**
 * The shipped street-clock profile: the 240 s day every current town demo
 * runs (the dollhouse motive pacing, buildings up in a game-day). Town-scope
 * documents declare this EXPLICITLY — the street machinery (goods.ts
 * FOOD_DAY_SEC closed-form schedules) is hard-paced to this day, so a town
 * world's `day_length_s` should match it until goods.ts is parameterized.
 */
export const DOLLHOUSE_SCALE: WorldScale = {
  dayLengthS: 240,
  sleepFraction: 0.05, // 12 s at the bed — sleep compressed past the day itself
  construction: 180, // a house in one street-day
  planetCompression: 1,
};

/** Seconds for a need meter to fill under a scale (rate = 1/this). */
export function needFillS(scale: WorldScale, key: NeedKey): number {
  return NEED_FILL_DAYS[key] * scale.dayLengthS;
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

// ------------------------------------------------- the `game.scale` block

/**
 * The authored form (snake_case, like the rest of the `game` envelope).
 * Every field optional — omissions fall back to REALISM, never to a
 * compressed profile: compression is always a declaration.
 */
export interface WorldScaleSpec {
  day_length_s?: number;
  sleep_fraction?: number;
  construction?: number;
  planet_compression?: number;
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
  const allowed = ["day_length_s", "sleep_fraction", "construction", "planet_compression"];
  for (const k of Object.keys(raw)) {
    if (!allowed.includes(k)) fail(`${path}.${k}`, `unknown field (allowed: ${allowed.join(", ")})`);
  }
  const out: WorldScaleSpec = {};
  if ("day_length_s" in raw) out.day_length_s = num(raw.day_length_s, `${path}.day_length_s`, 1, REAL_DAY_S);
  if ("sleep_fraction" in raw) out.sleep_fraction = num(raw.sleep_fraction, `${path}.sleep_fraction`, 0, 0.9);
  if ("construction" in raw) out.construction = num(raw.construction, `${path}.construction`, 0.01, 100_000);
  if ("planet_compression" in raw) {
    out.planet_compression = num(raw.planet_compression, `${path}.planet_compression`, 1, 10_000);
  }
  return out;
}

/** A document's declaration → the world's resolved physics profile.
 *  Absent fields anchor to realism. */
export function resolveWorldScale(spec?: WorldScaleSpec | null): WorldScale {
  return {
    dayLengthS: spec?.day_length_s ?? REAL_SCALE.dayLengthS,
    sleepFraction: spec?.sleep_fraction ?? REAL_SCALE.sleepFraction,
    construction: spec?.construction ?? REAL_SCALE.construction,
    planetCompression: spec?.planet_compression ?? REAL_SCALE.planetCompression,
  };
}

/** The authored form of a profile — what a document writes to declare it. */
export function scaleSpecOf(scale: WorldScale): Required<WorldScaleSpec> {
  return {
    day_length_s: scale.dayLengthS,
    sleep_fraction: scale.sleepFraction,
    construction: scale.construction,
    planet_compression: scale.planetCompression,
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
export function serviceRadiusM(scale: WorldScale, need: NeedKey, walkMps: number = ERRAND_WALK_MPS): number {
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
export function realDaysPerGameYear(dayS: number = DAY_S): number {
  return (365 * dayS) / REAL_DAY_S;
}
