// shared/world-engine/planet/growth.ts
//
// THE CIVILIZATION AGES ON THE WORLD CLOCK. Until now a settlement's age was
// frozen at founding (`days` fixed per city) — the world was the same on
// every visit, forever. This module makes ABSOLUTE TIME the third input of
// the world law (seed, clock, mutation): every client sharing the clock
// derives the same town ages, the same storeys, the same sprawl — nothing on
// a wire, exactly like the caravans.
//
// The growth arc, tuned for a world that VISIBLY settles over real months:
//   - POPULATION: world age adds town-days; Malthus regrows each town toward
//     its charter capacity — young towns visibly spread within weeks.
//     (Capped: founding cost is bounded, and Malthus saturates anyway.)
//   - STOREYS: once the spread saturates, dense settlements RISE — buildUp
//     climbs a storey at a time (a village spreads, a city rises).
//   - SPRAWL: the FOOTPRINT keeps growing without cap (it is data, not
//     founding cost) — and when two neighbours' footprints touch, they are a
//     CONURBATION: the possible metropolis outcome. Dense settlements a
//     day's walk apart merge roughly a year into the settling era.
//
// DETERMINISM & MULTIPLAYER: growth is QUANTIZED (one town-day per quantum),
// so two clients disagree only across a quantum boundary, and only until the
// town is next founded (sessions cache their towns; a mid-session flip never
// rebuilds anything). A real multiplayer shard will want an agreed rebuild
// beat; the quantum is where it plugs in.

import type { PlanetCity } from "./cities.js";

/** The shared world epoch — ambient motion's t=0 (caravans, and any future
 *  closed-form life). */
export const WORLD_EPOCH_MS = Date.UTC(2026, 0, 1);

/** The SETTLING ERA's t=0 — growth is anchored here (later than the world
 *  epoch, so the era begins "now" rather than pre-aged by half a year). */
export const GROWTH_EPOCH_MS = Date.UTC(2026, 6, 1);

/** One town-day of growth accrues per quantum of real time. */
export const GROWTH_QUANTUM_MS = 6 * 60 * 60 * 1000; // 4 town-days / real day

/** Cap on CLOCK-GROWN town-days fed to founding (bounds the fast-forward
 *  and the plan; Malthus saturates near here anyway). */
export const GROWN_DAYS_CAP = 400;

/** Clock-grown town-days at `nowMs` — quantized, non-negative, uncapped
 *  (callers that feed founding apply GROWN_DAYS_CAP; sprawl does not). */
export function worldGrowthDays(nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - GROWTH_EPOCH_MS) / GROWTH_QUANTUM_MS));
}

/** Founding-safe grown age: the settlement's base days plus the capped
 *  clock accrual. */
export function grownDays(baseDays: number, nowMs: number): number {
  return baseDays + Math.min(GROWN_DAYS_CAP, worldGrowthDays(nowMs));
}

/** How long the spread phase lasts before storeys/sprawl begin (town-days):
 *  the young town fills its charter before anything rises. */
const SPREAD_PHASE_DAYS = 120;

/** THE RISE: storeys above ground once the spread saturates — scaled by the
 *  founding crowd, so a hamlet stays flat while a dense seat climbs to its
 *  cap within the settling era's first months. */
export function grownBuildUp(density: number, nowMs: number): number {
  const crowd01 = Math.min(1, density / 400);
  const beyond = Math.max(0, Math.min(GROWN_DAYS_CAP, worldGrowthDays(nowMs)) - SPREAD_PHASE_DAYS);
  return Math.min(3, Math.floor((beyond / 140) * (0.4 + 0.6 * crowd01)));
}

/** Sprawl pace at full crowd (metres of footprint radius per town-day) —
 *  tuned so two dense settlements a day's walk (24 km) apart conurbate just
 *  under a year into the settling era. */
const SPRAWL_M_PER_DAY = 9;
/** No settlement outgrows this radius — a metropolis, not a continent. */
const FOOTPRINT_CAP_M = 15_000;

/** The settlement's BUILT FOOTPRINT radius at `nowMs` (metres): the founding
 *  core (≈ how far its lots reach) plus UNCAPPED clock sprawl. This is data
 *  for maps, beacons and conurbation — the street-level render stays the
 *  bounded town; sprawl is the halo it administers. */
export function settlementFootprintM(city: PlanetCity, nowMs: number): number {
  const core = 140 * Math.sqrt(Math.max(40, city.startPop) / 40);
  const crowd01 = Math.min(1, city.density / 400);
  const beyond = Math.max(0, worldGrowthDays(nowMs) - SPREAD_PHASE_DAYS);
  return Math.min(FOOTPRINT_CAP_M, core + SPRAWL_M_PER_DAY * beyond * (0.25 + 0.75 * crowd01));
}

/** Settlement pairs whose footprints TOUCH at `nowMs` — the conurbations.
 *  Index pairs (i < j) into `cities`; `radiusM` is the planet radius the
 *  city dirs live on. O(n²) over the live beacon set — call it per growth
 *  quantum, not per frame. */
export function conurbations(
  cities: readonly PlanetCity[],
  radiusM: number,
  nowMs: number,
): Array<[number, number]> {
  const foot = cities.map(c => settlementFootprintM(c, nowMs));
  const out: Array<[number, number]> = [];
  for (let i = 0; i < cities.length; i++) {
    const a = cities[i]!;
    for (let j = i + 1; j < cities.length; j++) {
      const b = cities[j]!;
      const dp = Math.max(-1, Math.min(1,
        a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2]));
      if (Math.acos(dp) * radiusM <= foot[i]! + foot[j]!) out.push([i, j]);
    }
  }
  return out;
}

/** The conurbation's display name: the denser partner leads (ties break by
 *  name, so both clients print the same thing). */
export function conurbationName(a: PlanetCity, b: PlanetCity): string {
  const [lead, tail] = b.density > a.density || (b.density === a.density && b.name < a.name)
    ? [b, a] : [a, b];
  return `Greater ${lead.name}–${tail.name}`;
}
