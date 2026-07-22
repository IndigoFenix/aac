// shared/world-engine/interaction/quest/city-hud.ts
//
// The CITY HUD (city-expansion ④) — the family HUD's civic sibling: when
// the town outgrows the tracked-resident cap (or cohort pools exist), each
// DISTRICT surfaces as ONE glanceable chip — a glyph (the zone category;
// the town's own glyph for the default district), population, an average-
// wellbeing face, and the key stocks worst-shortage-first — plus one
// city-total row. The engine COMPUTES (this module, pure signals-in
// chips-out, unit-testable without a host); a presenter renders through
// the optional `QuestPresenter.city` channel — board/HUD is engine chrome.

import { DEFAULT_DISTRICT, type CohortRow } from "@shared/world-engine/kernel/town/population.js";
import { headOf } from "../../variations.js";

/** One stock cell on a chip. */
export interface CityHudStock {
  /** Commodity glyph (shared game lang layer word — "food", "cloth"). */
  glyph: string;
  /** Units on hand (district pool; the city row adds the yard). */
  count: number;
  /** The commodity's CITY-WIDE shortage 0..1 (orders the cells). */
  shortage: number;
}

/** One district chip (or the city-total row). */
export interface CityHudChip {
  /** District id: a zone charter ord, DEFAULT_DISTRICT for unzoned ground,
   *  or "city" for the total row. */
  district: number | "city";
  /** The chip's glyph: the zone CATEGORY for a chartered district, the
   *  town glyph for the default district and the city row. */
  glyph: string;
  /** Short display label ("farm", "town", "city"). */
  label: string;
  /** Souls — tracked + pooled. */
  population: number;
  /** Individually-simulated souls (the dollhouse tier). */
  tracked: number;
  /** Statistically-pooled souls (the cohort tier). */
  pooled: number;
  /** Average wellbeing 0..1 (member-weighted across both tiers). */
  wellbeing: number;
  /** The ONE wellbeing face (family-hud's emoji language, aggregated). */
  emoji: string;
  /** Key stocks, worst city shortage first. */
  stocks: CityHudStock[];
}

/** The wellbeing face — a tiny ladder, deliberately coarse (a chip is a
 *  glance, not a gauge). */
export function wellbeingEmoji(w: number): string {
  if (w >= 0.7) return "😊";
  if (w >= 0.45) return "😐";
  if (w >= 0.25) return "😟";
  return "😫";
}

/** One tracked house's aggregate slice (host-sampled). */
export interface CityHudTrackedHouse {
  index: number;
  /** Souls counted against the cap. */
  members: number;
  /** The district governing the house's center (population.ts
   *  districtOfPoint over the town-local footprint center). */
  district: number;
  /** 0..1 — live stress-derived when the house is watched, else the
   *  content default. */
  wellbeing: number;
}

export interface CityHudInput {
  /** The tracked-resident cap (TownPlayConfig.trackedResidents). */
  cap: number;
  /** Every tracked household. */
  tracked: CityHudTrackedHouse[];
  /** The cohort pools (deltas.cohorts). */
  cohorts: readonly CohortRow[];
  /** A district's zone CATEGORY (ord → the charter's category word), null
   *  for the default district or a painted-over charter. */
  categoryOf(district: number): string | null;
  /** The town's own glyph/label (the default district + city row). */
  townGlyph: string;
  /** Street commodities with their CITY-WIDE shortage (③'s
   *  TownGrowthSignals.shortage, host-assembled) — the stock cells'
   *  vocabulary and order. */
  goods: Array<{ glyph: string; shortage: number }>;
  /** The builder's-yard stock (city row only). */
  yardStock?: Readonly<Record<string, number>>;
  /** Stock cells per chip (default 3). */
  maxStocks?: number;
}

export interface CityHudView {
  districts: CityHudChip[];
  city: CityHudChip;
}

/** Units of a glyph's head in a stack (fractional pools display floored). */
function headUnits(stack: Readonly<Record<string, number>>, glyph: string): number {
  const head = headOf(glyph);
  let n = 0;
  for (const [g, c] of Object.entries(stack)) {
    if (headOf(g) === head) n += Math.max(0, c);
  }
  return Math.floor(n);
}

/** THE UNLOCK: aggregate displays appear once the city crossed the line —
 *  pooled souls exist, or the street population exceeds the tracked cap. */
export function cityHudUnlocked(input: Pick<CityHudInput, "cap" | "tracked" | "cohorts">): boolean {
  const pooled = input.cohorts.reduce((s, r) => s + r.pop, 0);
  const tracked = input.tracked.reduce((s, h) => s + h.members, 0);
  return pooled > 0 || tracked + pooled > input.cap;
}

/**
 * Assemble the chips (pure). NULL while locked — a village under the cap
 * shows nothing (the dormancy guarantee reaches the chrome). Districts
 * come back default-first then charter-ord ascending; every district that
 * holds souls (tracked or pooled) gets a chip. Stocks are ordered by the
 * CITY-WIDE shortage, worst first — the glance answers "what are we short
 * of, and where".
 */
export function cityHudView(input: CityHudInput): CityHudView | null {
  if (!cityHudUnlocked(input)) return null;
  const maxStocks = input.maxStocks ?? 3;
  const goodsRanked = [...input.goods].sort(
    (a, b) => b.shortage - a.shortage || (a.glyph < b.glyph ? -1 : 1),
  );

  interface Agg {
    tracked: number;
    pooled: number;
    wSum: number; // member-weighted wellbeing
    stack: Record<string, number>;
  }
  const byDistrict = new Map<number, Agg>();
  const aggOf = (d: number): Agg => {
    let a = byDistrict.get(d);
    if (!a) {
      a = { tracked: 0, pooled: 0, wSum: 0, stack: {} };
      byDistrict.set(d, a);
    }
    return a;
  };
  for (const h of input.tracked) {
    const a = aggOf(h.district);
    a.tracked += h.members;
    a.wSum += h.wellbeing * h.members;
  }
  for (const r of input.cohorts) {
    const a = aggOf(r.district);
    a.pooled += r.pop;
    a.wSum += r.wellbeing * r.pop;
    for (const [g, n] of Object.entries(r.stack)) a.stack[g] = (a.stack[g] ?? 0) + n;
  }

  const stocksOf = (stack: Readonly<Record<string, number>>): CityHudStock[] =>
    goodsRanked
      .slice(0, maxStocks)
      .map((g) => ({ glyph: g.glyph, count: headUnits(stack, g.glyph), shortage: g.shortage }));

  const chip = (district: number, a: Agg): CityHudChip => {
    const category = district === DEFAULT_DISTRICT ? null : input.categoryOf(district);
    const pop = a.tracked + a.pooled;
    return {
      district,
      glyph: category ?? input.townGlyph,
      label: category ?? input.townGlyph,
      population: pop,
      tracked: a.tracked,
      pooled: a.pooled,
      wellbeing: pop > 0 ? a.wSum / pop : 0.75,
      emoji: wellbeingEmoji(pop > 0 ? a.wSum / pop : 0.75),
      stocks: stocksOf(a.stack),
    };
  };

  const districts = [...byDistrict.entries()]
    .filter(([, a]) => a.tracked + a.pooled > 0)
    .sort(([a], [b]) => a - b) // DEFAULT_DISTRICT (-1) leads, then charter ords
    .map(([d, a]) => chip(d, a));

  // The city-total row: every district folded together, plus the yard.
  const cityAgg: Agg = { tracked: 0, pooled: 0, wSum: 0, stack: {} };
  for (const a of byDistrict.values()) {
    cityAgg.tracked += a.tracked;
    cityAgg.pooled += a.pooled;
    cityAgg.wSum += a.wSum;
    for (const [g, n] of Object.entries(a.stack)) cityAgg.stack[g] = (cityAgg.stack[g] ?? 0) + n;
  }
  for (const [g, n] of Object.entries(input.yardStock ?? {})) {
    cityAgg.stack[g] = (cityAgg.stack[g] ?? 0) + n;
  }
  const city = { ...chip(DEFAULT_DISTRICT, cityAgg), district: "city" as const, label: "city" };
  return { districts, city };
}
