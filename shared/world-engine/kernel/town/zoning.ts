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
   *  FoundedBuilding lots use). Unused (0) on non-disc shapes. */
  x: number;
  y: number;
  /** Disc radius (the issuer's focus-brush radius at charter time).
   *  Unused (0) on non-disc shapes. */
  r: number;
  /** The admitted structure category: a StructureSpec.type or an economy
   *  district class (free strings). NULL = a CLEARING charter — ground it
   *  covers reads unzoned again (the "unzone" verb's row). */
  category: string | null;
  /** WHO chartered it — a creature id (the player is one, never special). */
  issuer: string;
  /** SHAPE BACKEND (nations §3c — areas snap to NAMEABLE UNITS; the disc
   *  brush is legacy, readable forever, never authored again):
   *   • absent/"disc" — the legacy disc (x/y/r).
   *   • "town" — the WHOLE TOWN: a STEERING PREFERENCE row. Never
   *     ground-exclusive: containment (zoneAt) skips it entirely; the
   *     growth step WEIGHS it (laws steer, need builds).
   *   • "over" — the ground governed by charter `of` at this row's turn:
   *     re-designating an EXISTING district by reference — extent comes
   *     from the charter tree itself, selection over drawing. */
  shape?: "disc" | "town" | "over";
  /** "over" rows: the charter ord whose governed ground this row repaints
   *  (chains — repainting a repaint follows the same rule). */
  of?: number;
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
    const shape = z.shape ?? "disc";
    if (shape === "town") continue; // a steering preference, never ground
    if (shape === "over") {
      // Repaints the CURRENT winner's ground when that winner is its
      // referent — chains naturally (over-of-over follows the same rule).
      if (hit && hit.ord === z.of) hit = z;
      continue;
    }
    const dx = x - z.x;
    const dy = y - z.y;
    if (dx * dx + dy * dy <= z.r * z.r) hit = z;
  }
  return hit && hit.category !== null ? hit : null;
}

/** The TOWN-WIDE steering preferences in force: "town"-shaped charters in
 *  ord order — a category row ADDS, a clearing row (category null) WIPES.
 *  These never bind ground (zoneAt skips them); the growth step weighs
 *  them — a preferred category is licensed to rise at rest on open ground
 *  and outranks equal-need rivals. */
export function townPreferredCategories(zones: readonly ZoneCharter[]): Set<string> {
  const out = new Set<string>();
  for (const z of zones) {
    if ((z.shape ?? "disc") !== "town") continue;
    if (z.category === null) out.clear();
    else out.add(z.category);
  }
  return out;
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

// ── NEED-STEERED AUTO-EXPANSION (①b deferred piece + city-founding) ─────
// The town founds NEW structures through the SAME FoundedBuilding path
// the player's build order takes (same scaffolds, same completion sweep,
// same roster staffing). The house annex ladder (construction.ts
// nextAnnexWant) is untouched. Two funding modes:
//   • URGENT NEED (survival) — a homeless population raises a house, a
//     hungry one a farm, without banking anything (city-founding.md: "if
//     there is sufficient need the people will perform actions
//     autonomously").
//   • BANKED PROSPERITY (surplus) — the historical threshold spend.
// Charters CONSTRAIN when present (nations-and-empires §3a: a zoning
// charter is a build-law); with none, growth follows real need on open
// ground — the street tree picks the lot, never a painted shape.

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
/** NEED URGENCY (city-founding): a need past these gates builds NOW,
 *  bypassing the prosperity bank — prosperity funds surplus growth, never
 *  survival. Crowding is ~0..2 (1 = every house exactly full; the
 *  established-town equilibrium hovers there, so urgency starts above it);
 *  shortage is 0..1. */
export const URGENT_CROWDING = 1.25;
export const URGENT_SHORTAGE = 0.6;
/** OPEN-GROUND growth (no charters) only follows a REAL need — at least
 *  this score. Zoned ground keeps the legacy fill-at-rest (a charter is
 *  the player saying "build here eventually"); open ground never sprawls
 *  content towns. */
export const OPEN_GROWTH_MIN = 0.9;
/** A town-preference's need-score bump (city-founding areas): enough to
 *  outrank equal-need rivals, never enough to drown a real shortage. */
export const TOWN_PREFERENCE_BOOST = 0.25;

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
   *  the enumeration). `zone: null` = OPEN GROUND (an unchartered town) —
   *  no zone filter, the street tree's own enumeration. */
  candidatesFor(spec: StructureSpec, zone: ZoneCharter | null): FoundingCandidate[];
}

export interface FoundingGrowthOrder {
  spec: StructureSpec;
  building: FoundedBuilding;
  /** The chartered zone the lot fell in, or -1 for open ground. */
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
 * ord; open ground ranks as ord -1), gated by the economy cap (count <
 * by × rate), the yard stock, and geometric capacity. URGENT need founds
 * before the bank fills; otherwise the threshold decides. An unzoned,
 * content, well-housed town founds nothing — need is the license.
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
  const banked = d.civic.prosperity >= FOUNDING_PROSPERITY_THRESHOLD;
  // Ground-binding charters only — "town" rows are steering preferences,
  // weighed below, never iterated as zones.
  const zones = d.zones().filter((z) => z.category !== null && (z.shape ?? "disc") !== "town");
  const townPref = townPreferredCategories(d.zones());

  const districtOf = (k: string): string | null => input.economyOf(k)?.district ?? null;
  interface RankRow {
    zone: ZoneCharter | null;
    spec: StructureSpec;
    idx: number;
    score: number;
    urgent: boolean;
  }
  const ranked: RankRow[] = [];
  const consider = (zone: ZoneCharter | null, spec: StructureSpec, idx: number): void => {
    const eco = spec.economy ? input.economyOf(spec.economy) : null;
    let worst = 0;
    for (const g of eco?.sells ?? []) worst = Math.max(worst, input.signals.shortage(g));
    // NEED URGENCY (city-founding): survival builds bypass the bank —
    // a homeless population raises a house, a hungry one a farm, TODAY
    // (materials and the one-per-day tick still gate).
    const urgent =
      spec.role === "house"
        ? input.signals.crowding >= URGENT_CROWDING
        : worst >= URGENT_SHORTAGE;
    let score = structureNeedScore(spec, eco, input.signals);
    if (!zone) {
      // TOWN PREFERENCE (city-founding areas): a "town"-shaped charter
      // names a category the whole town favors — LICENSED to rise at rest
      // on open ground (the fill-at-rest license a ground charter grants),
      // and boosted past equal-need rivals. Steering, never exclusion.
      const preferred = [...categoriesOfSpec(spec, districtOf)].some((c) => townPref.has(c));
      if (preferred) {
        score += TOWN_PREFERENCE_BOOST;
      } else {
        // OPEN GROUND (no charter constrains this town — nations §3c: laws
        // constrain when present, absence is not a freeze): only REAL need
        // builds here — a house for a crowded town, a producer for a real
        // shortage. Zoned fill-at-rest (markets, workshops) needs a charter.
        if (spec.role !== "house" && !(eco?.sells ?? []).length) return;
        if (!urgent && score < OPEN_GROWTH_MIN) return;
      }
    }
    ranked.push({ zone, spec, idx, score, urgent });
  };
  if (zones.length) {
    for (const zone of zones) {
      input.catalog.forEach((spec, idx) => {
        if (!categoriesOfSpec(spec, districtOf).has(zone.category!)) return;
        consider(zone, spec, idx);
      });
    }
    // Open ground stays STEERED even in a chartered town — the town
    // preference licenses its category beside the district zones.
    if (townPref.size) input.catalog.forEach((spec, idx) => consider(null, spec, idx));
  } else {
    input.catalog.forEach((spec, idx) => consider(null, spec, idx));
  }
  // Need first; ties break toward catalog row order, then the OLDER zone.
  ranked.sort(
    (a, b) => b.score - a.score || a.idx - b.idx || (a.zone?.ord ?? -1) - (b.zone?.ord ?? -1),
  );

  for (const r of ranked) {
    // Without a banked threshold, only URGENT need founds (survival now;
    // surplus growth waits for the bank).
    if (!banked && !r.urgent) continue;
    // The economy cap (the pasture-charter precedent), read DISCRETELY:
    // the next whole building must fit under by × rate (a 0.5 cap
    // charters nothing — buildings aren't fractional).
    const eco = r.spec.economy ? input.economyOf(r.spec.economy) : null;
    if (eco && input.countOf(r.spec.type) + 1 > input.capValueOf(eco.cap.by) * eco.cap.rate) continue;
    // Real materials — the yard must cover it (missing wood halts growth).
    if (!costsMet(r.spec, d.stock)) continue;
    // Geometric capacity — feasibility inside the enumeration.
    const candidate = input.candidatesFor(r.spec, r.zone)[0];
    if (!candidate) continue;
    if (!spendCosts(r.spec, d.stock)) continue;
    const building = d.foundBuilding(candidate, input.day, r.spec.buildDays);
    // The bank pays only when it can — an urgent build before the
    // threshold is materials-paid, never a negative balance.
    if (banked) {
      d.civic.prosperity = Math.max(0, d.civic.prosperity - FOUNDING_PROSPERITY_THRESHOLD);
    }
    return { spec: r.spec, building, zoneOrd: r.zone?.ord ?? -1 };
  }
  return null; // every admitted structure capped/short/full — keep banking
}
