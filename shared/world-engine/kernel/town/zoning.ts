/**
 * zoning.ts — ZONE CHARTERS (city-expansion phase ③): a zone is a SPATIAL
 * CHARTER — a designated patch of town ground plus the one structure
 * CATEGORY allowed to rise there — steering WHERE and WHAT the town builds.
 * Zones steer the EXISTING growth machinery (foundingOptions enumeration,
 * constructionStep-day auto-expansion, the spoken build order), never a new
 * construction path — so re-zoning an established city gradually reshapes
 * it as growth lands somewhere new.
 *
 * THE MODEL. A charter is a DISC in town-local coordinates (the player's
 * focus circle is the natural zoning brush — TaskFocus's exact shape), with
 * a monotone ordinal (stable forever — phase ④ districts will reference
 * zone ords) and a free-string category. OVERLAP RULE: charters apply in
 * ord order and the LATEST charter covering a point WINS — re-zoning is
 * painting over, and "unzone" is a charter whose category is NULL (cleared
 * ground reads as unzoned again). Nothing is ever deleted, so replay over
 * the serialized charter list reproduces the identical ground everywhere
 * (seed + clock + mutations).
 *
 * CATEGORY VOCABULARY. A category names either a StructureSpec.type
 * ("farm", "house") or an economy DISTRICT class (BuildingDef.district —
 * free strings both, ①b/prep). A structure ANSWERS to a zone when the
 * zone's category is the spec's own type or its economy row's district —
 * so "zone craft here" admits every craft-district workshop the catalog
 * carries, while "zone farm here" admits exactly the farm.
 *
 * ABSENCE IS PERMISSIVE: unzoned ground admits anything (today's
 * behavior); zones CONSTRAIN — there is no requirement to zone before
 * building, and a town with no charters behaves byte-identically to ②.
 *
 * Kernel layering: pure data + arithmetic. Runtime imports go DOWN the
 * stack only (structures.ts helpers); construction.ts sees this module
 * through `import type` alone — no runtime cycle.
 */

import { costsMet, resolveStructure, spendCosts, type StructureSpec } from "./structures.js";
import type { FoundedBuilding, FoundingCandidate, TownDeltas } from "./construction.js";

/** One zone charter — a serializable row (TownDeltas pattern, no RNG). */
export interface ZoneCharter {
  /** Charter ordinal — zone k chartered at this town, forever (the stable
   *  id phase-④ districts reference). Monotone, never reused. */
  ord: number;
  /** Disc center, TOWN-LOCAL (relative the town center — the same frame
   *  FoundedBuilding lots use). */
  x: number;
  y: number;
  /** Disc radius (the issuer's focus-brush radius at charter time). */
  r: number;
  /** The admitted structure category: a StructureSpec.type or an economy
   *  district class (free strings). NULL = a CLEARING charter — ground it
   *  covers reads unzoned again (the "unzone" verb's row). */
  category: string | null;
  /** WHO chartered it — a creature id (the player is one, never special). */
  issuer: string;
}

/**
 * The charter governing a point: charters apply in ord order and the
 * LATEST one covering the point wins (overlap rule — re-zoning paints
 * over). A winning CLEARING charter (category null) means the ground is
 * unzoned: null comes back, exactly like virgin ground.
 */
export function zoneAt(
  zones: readonly ZoneCharter[],
  x: number,
  y: number,
): ZoneCharter | null {
  let hit: ZoneCharter | null = null;
  for (const z of zones) {
    // zones() is ord order — the last containing charter is the latest.
    const dx = x - z.x;
    const dy = y - z.y;
    if (dx * dx + dy * dy <= z.r * z.r) hit = z;
  }
  return hit && hit.category !== null ? hit : null;
}

/** The categories a structure ANSWERS to: its own type plus its economy
 *  row's district class (when it has an economy half). */
export function categoriesOfSpec(
  spec: Pick<StructureSpec, "type" | "economy">,
  districtOf?: (economyKey: string) => string | null,
): Set<string> {
  const cats = new Set([spec.type]);
  const d = spec.economy ? (districtOf?.(spec.economy) ?? null) : null;
  if (d) cats.add(d);
  return cats;
}

/**
 * Resolve a SPOKEN category word to its canonical charter string: a
 * structure name resolves through the catalog to its type ("farms",
 * "farm", the glyph, the label — resolveStructure's forgiving match);
 * else a district class any catalog spec files under. NULL for an
 * unknown word — the caller phrases a NAMED refusal (the workProgram()
 * lesson: never a silent generic fallback).
 */
export function resolveZoneCategory(
  catalog: ReadonlyArray<StructureSpec>,
  districtOf: ((economyKey: string) => string | null) | undefined,
  word: string,
): string | null {
  const spec = resolveStructure(catalog, word);
  if (spec) return spec.type;
  const n = word.trim().toLowerCase();
  if (!n) return null;
  for (const s of catalog) {
    const d = s.economy ? (districtOf?.(s.economy) ?? null) : null;
    if (d && d.toLowerCase() === n) return d;
  }
  return null;
}

/** How a candidate lot stands toward the charters, for ONE structure:
 *  `match` = inside a zone that admits it (preferred ground), `open` =
 *  unzoned (always admitted), `blocked` = zoned for something else
 *  (infeasible — the annexOptions law keeps it out of the enumeration). */
export type SlotZoning = "match" | "open" | "blocked";

/** The zoning classifier foundingOptions consumes (its optional `zoning`
 *  input): a pure closure over (charters, the structure's categories). */
export function slotZoningFn(
  zones: readonly ZoneCharter[],
  categories: ReadonlySet<string>,
): (x: number, y: number) => SlotZoning {
  return (x, y) => {
    const z = zoneAt(zones, x, y);
    if (!z) return "open";
    return z.category !== null && categories.has(z.category) ? "match" : "blocked";
  };
}

/** Does this candidate's lot stand under EXACTLY this charter (the latest
 *  charter over its center is `zone`)? A zone fully painted over by a
 *  later charter governs no ground — its candidates dry up honestly. */
export function candidateInZone(
  zones: readonly ZoneCharter[],
  zone: ZoneCharter,
  c: Pick<FoundingCandidate, "dx" | "dy" | "w" | "h">,
): boolean {
  return zoneAt(zones, c.dx + c.w / 2, c.dy + c.h / 2)?.ord === zone.ord;
}

// ── ZONE-STEERED AUTO-EXPANSION (the ①b deferred piece) ─────────────────
// Prosperity founds NEW structures inside zones, through the SAME
// FoundedBuilding path the player's build order takes (same scaffolds,
// same completion sweep, same roster staffing). The house annex ladder
// (construction.ts nextAnnexWant) is untouched — this is the TOWN-scope
// twin of the household accumulator, and it only ever builds INSIDE
// zones: an unzoned town auto-grows exactly as before (annexes only).

/** Town prosperity banked before ONE founding is spent (≈ 5-8 healthy
 *  days at the daily cap — a town founds slower than a household annexes). */
export const FOUNDING_PROSPERITY_THRESHOLD = 8;
/** Accrual cap per credited day (hysteresis, the household pattern). */
export const FOUNDING_PROSPERITY_DAILY_CAP = 2;
/** The score floor every admitted structure keeps — zones eventually fill
 *  even in a content town; NEED reorders what rises first. */
export const FOUNDING_NEED_FLOOR = 0.1;
/** The flat score of a structure with no economy half (market, workshop)
 *  — above the floor, below any real shortage, so towns diversify at rest. */
export const FOUNDING_NEED_DEFAULT = 0.2;

/** Deterministic town-need signals (the host reads them off the live
 *  books — town.scalar / eco.fills — all replay-stable). */
export interface TownGrowthSignals {
  /** Population pressure on housing, ~0..2 (1 = every house full). */
  crowding: number;
  /** A commodity's shortage 0..1 (1 − got/need, clamped). */
  shortage(good: string): number;
}

/** The slice of an economy BuildingDef the growth step reads (kept
 *  structural so this module never imports the economy compiler). */
export interface ZoneEconomyRef {
  /** The charter-cap precedent (pasture charter): count < by × rate. */
  cap: { by: string; rate: number };
  sells?: string[];
  district: string | null;
}

/**
 * The WANT-LADDER philosophy generalized to town needs, data-driven off
 * the catalog + economy rows: a HOUSE scores the crowding signal; a
 * producing structure scores the worst SHORTAGE among the commodities it
 * sells (farm ← food, weaver ← cloth — whatever the doc declares); a
 * structure with no economy half scores the flat default. Everything
 * keeps the floor, so zones fill even at rest — need only reorders.
 */
export function structureNeedScore(
  spec: Pick<StructureSpec, "role">,
  eco: ZoneEconomyRef | null,
  signals: TownGrowthSignals,
): number {
  if (spec.role === "house") return Math.max(FOUNDING_NEED_FLOOR, signals.crowding);
  if (!eco || !(eco.sells ?? []).length) return FOUNDING_NEED_DEFAULT;
  let worst = 0;
  for (const g of eco.sells ?? []) worst = Math.max(worst, signals.shortage(g));
  return Math.max(FOUNDING_NEED_FLOOR, worst);
}

export interface FoundingGrowthInput {
  /** The town's construction overlay — the accumulator (`civic`), the
   *  charters, and the YARD STOCK the founding spends live here. */
  deltas: TownDeltas;
  catalog: ReadonlyArray<StructureSpec>;
  /** The day's raw prosperity gain (host: the mean household gain — the
   *  same proxy signals constructionStep accrues). Capped inside. */
  gain: number;
  /** Town street-day (fractional) — stamps the founded row's clock. */
  day: number;
  signals: TownGrowthSignals;
  /** Economy row lookup for a spec's `economy` key (cap/sells/district). */
  economyOf(key: string): ZoneEconomyRef | null;
  /** A charter attr / "population" value (town.scalar) for cap:{by,rate}. */
  capValueOf(by: string): number;
  /** Standing + building count of a structure type (plan works incl.
   *  founded rows) — the cap's left-hand side. */
  countOf(type: string): number;
  /** Feasible lots for `spec` INSIDE `zone` right now, best-first — the
   *  host's zone-aware foundingOptions filtered by candidateInZone. Empty
   *  = that zone's ground is full (geometric capacity, feasibility inside
   *  the enumeration). */
  candidatesFor(spec: StructureSpec, zone: ZoneCharter): FoundingCandidate[];
}

export interface FoundingGrowthOrder {
  spec: StructureSpec;
  building: FoundedBuilding;
  zoneOrd: number;
}

/**
 * ONE town-growth tick (call once per credited town day, beside
 * constructionStep): accrue the town's prosperity (capped), and when a
 * full FOUNDING_PROSPERITY_THRESHOLD is banked, spend it founding the
 * most-needed admitted structure inside the zone that has ground for it.
 * AUTO-GROWTH SPENDS REAL YARD STOCK (deltas.stock) — the same materials
 * player orders spend, so a town out of wood honestly stops growing and a
 * haul to the yard visibly restarts it.
 *
 * Deterministic given its input: charters in ord order × the catalog in
 * row order, ranked by structureNeedScore (ties: catalog order, then zone
 * ord), gated by the economy cap (count < by × rate), the yard stock, and
 * geometric zone capacity. No zones (or none feasible) ⇒ null and the
 * bank keeps accruing harmlessly — an unzoned town never auto-founds.
 *
 * Mutates `deltas` (accrual; on an order: spendCosts + foundBuilding +
 * the threshold deducted) and returns the order for the host to reflect
 * (plan row → stage scaffold → completion sweep → roster staffing — the
 * player-order path).
 */
export function foundingGrowthStep(input: FoundingGrowthInput): FoundingGrowthOrder | null {
  const d = input.deltas;
  d.civic.prosperity += Math.min(
    FOUNDING_PROSPERITY_DAILY_CAP,
    Math.max(0, input.gain),
  );
  if (d.civic.prosperity < FOUNDING_PROSPERITY_THRESHOLD) return null;
  const zones = d.zones().filter((z) => z.category !== null);
  if (!zones.length) return null; // unzoned towns: today's behavior exactly

  const districtOf = (k: string): string | null => input.economyOf(k)?.district ?? null;
  const ranked: Array<{ zone: ZoneCharter; spec: StructureSpec; idx: number; score: number }> = [];
  for (const zone of zones) {
    input.catalog.forEach((spec, idx) => {
      if (!categoriesOfSpec(spec, districtOf).has(zone.category!)) return;
      const eco = spec.economy ? input.economyOf(spec.economy) : null;
      ranked.push({ zone, spec, idx, score: structureNeedScore(spec, eco, input.signals) });
    });
  }
  // Need first; ties break toward catalog row order, then the OLDER zone.
  ranked.sort((a, b) => b.score - a.score || a.idx - b.idx || a.zone.ord - b.zone.ord);

  for (const r of ranked) {
    // The economy cap (the pasture-charter precedent), read DISCRETELY:
    // the next whole building must fit under by × rate (a 0.5 cap
    // charters nothing — buildings aren't fractional).
    const eco = r.spec.economy ? input.economyOf(r.spec.economy) : null;
    if (eco && input.countOf(r.spec.type) + 1 > input.capValueOf(eco.cap.by) * eco.cap.rate) continue;
    // Real materials — the yard must cover it (missing wood halts growth).
    if (!costsMet(r.spec, d.stock)) continue;
    // Geometric zone capacity — feasibility inside the enumeration.
    const candidate = input.candidatesFor(r.spec, r.zone)[0];
    if (!candidate) continue;
    if (!spendCosts(r.spec, d.stock)) continue;
    const building = d.foundBuilding(candidate, input.day, r.spec.buildDays);
    d.civic.prosperity = Math.max(0, d.civic.prosperity - FOUNDING_PROSPERITY_THRESHOLD);
    return { spec: r.spec, building, zoneOrd: r.zone.ord };
  }
  return null; // every admitted structure capped/short/full — keep banking
}
