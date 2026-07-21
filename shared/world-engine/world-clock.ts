// shared/world-engine/world-clock.ts
//
// The living world's CLOCK — the one new signal society rules need
// (society-rules.md §3.1). Puzzle mode is frozen and time-free (creatures.ts owns
// no coordinates OR time); a living town runs a clock, and rule CONDITIONS read it
// ("when night, go home"). Kept pure and headless: advance returns a NEW clock,
// and the world-condition set is a pure projection — so a seeded sim replays
// identically (the determinism the rule system depends on).
//
// v1 ships one cycle: day/night with dawn/dusk transition bands. Weather (rain,
// cold snaps) is a SEPARATE future source that merges into the same condition set;
// `worldConditions` returns a plain string set precisely so more signals can union
// in without a type change.

/** A phase of the day/night cycle. Dawn/dusk are short transition bands at the
 *  edges of daylight — useful for lighting and for "at dawn" rules later. */
export type DayPhase = "dawn" | "day" | "dusk" | "night";

import { REAL_DAY_S } from "./scale.js";

export interface WorldClockConfig {
  /** Length of one full day+night, in sim seconds. Default REAL_DAY_S
   *  (86 400 — realism is the anchor, space-time-compression.md §1); a
   *  compressed world passes its own day (e.g. the town session's 60 s
   *  observed day, creature-goal-runtime.ts). */
  dayLength: number;
  /** Fraction of the cycle that is DAYLIGHT (dawn→dusk inclusive), 0..1. */
  daylightFraction: number;
  /** Fraction of the cycle each transition band (dawn, dusk) occupies. Two bands,
   *  so 2×transition must be < daylightFraction. */
  transition: number;
}

export const DEFAULT_WORLD_CLOCK_CONFIG: WorldClockConfig = {
  dayLength: REAL_DAY_S,
  daylightFraction: 0.6,
  transition: 0.08,
};

export interface WorldClock {
  /** Total elapsed sim seconds (monotonic). */
  time: number;
  config: WorldClockConfig;
}

/** A fresh clock. `startTime` seeds the phase (default 0 = midnight, deep night). */
export function createWorldClock(
  config: Partial<WorldClockConfig> = {},
  startTime = 0,
): WorldClock {
  return { time: startTime, config: { ...DEFAULT_WORLD_CLOCK_CONFIG, ...config } };
}

/** Advance the clock by `dtSeconds` (clamped ≥ 0). PURE — returns a new clock. */
export function advanceClock(clock: WorldClock, dtSeconds: number): WorldClock {
  return { ...clock, time: clock.time + Math.max(0, dtSeconds) };
}

/** Whole days elapsed since time 0. */
export function dayCount(clock: WorldClock): number {
  return Math.floor(clock.time / clock.config.dayLength);
}

/**
 * Position through the current cycle, 0..1. 0 = midnight (deep night), 0.5 =
 * midday. Daylight is centered on midday: [0.5 - d/2, 0.5 + d/2] for daylight
 * fraction d. So a bigger `daylightFraction` widens day symmetrically around noon.
 */
export function timeOfDay(clock: WorldClock): number {
  const t = clock.time % clock.config.dayLength;
  return (t < 0 ? t + clock.config.dayLength : t) / clock.config.dayLength;
}

/** The current phase, from `timeOfDay` and the config's daylight/transition bands. */
export function dayPhase(clock: WorldClock): DayPhase {
  const { daylightFraction, transition } = clock.config;
  const f = timeOfDay(clock);
  const dayStart = 0.5 - daylightFraction / 2; // dawn begins
  const dayEnd = 0.5 + daylightFraction / 2; // dusk ends
  if (f < dayStart || f >= dayEnd) return "night";
  if (f < dayStart + transition) return "dawn";
  if (f >= dayEnd - transition) return "dusk";
  return "day";
}

/**
 * The set of WORLD-STATE condition tokens active right now — what rule conditions
 * of kind `worldState` match against (rules.ts). Always the EXACT phase token
 * ("dawn"/"day"/"dusk"/"night"); plus the coarse token "day" or "night" only for
 * those two stable phases, so a curfew "when night" fires through the night proper
 * while "when dusk" catches the transition. Weather sources later UNION their own
 * tokens ("rain", "cold") into this same set — hence a plain string set, not an enum.
 */
export function worldConditions(clock: WorldClock): Set<string> {
  const phase = dayPhase(clock);
  const set = new Set<string>([phase]);
  if (phase === "day" || phase === "night") set.add(phase); // coarse == exact here
  return set;
}

/** True for anything but full daylight (dawn/dusk/night) — a convenience some
 *  callers (lighting) want without matching against the token set. */
export function isDark(clock: WorldClock): boolean {
  return dayPhase(clock) !== "day";
}
export function isNight(clock: WorldClock): boolean {
  return dayPhase(clock) === "night";
}
