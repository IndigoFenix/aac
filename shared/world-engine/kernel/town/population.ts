/**
 * population.ts — RESIDENT MOVE-IN + PER-DISTRICT COHORTS (city-expansion
 * phase ④): the two tiers a growing city's people live at, with the
 * deterministic machinery that moves souls between them.
 *
 * MOVE-IN (the ①b `role:"house"` half completed): a FINISHED founded house
 * ADMITS A HOUSEHOLD when the town can feed one — a data-driven immigration
 * rule over the signals the growth machinery already reads (③'s
 * TownGrowthSignals). Admission is a SERIALIZED FACT on the FoundedBuilding
 * (`household`, the `completed` pattern), so a rebuilt session raises the
 * same household forever; materialization (plan.houses row instead of a
 * work row) is applyFoundedBuildings' job, live conversion the host's.
 *
 * COHORTS (the LOD tier): past the TRACKED cap, whole HOUSEHOLDS aggregate
 * into per-district pools — {population, pooled needs satisfaction,
 * wellbeing average, an inventory STACK (a real StockEndpoint — ② transfers
 * reach it), production/consumption as RATES off the same street books
 * individuals project}. A DISTRICT is the governing zone charter's ord
 * (zoning.ts zoneAt — the stable ③ ordinals); unzoned ground is ONE default
 * district. Promotion/demotion CONSERVES TOTALS: a demoted household's
 * carried stacks fold into the pool (house pantries stay with the HOUSE —
 * they are the building's, not the souls'), promotion returns exactly the
 * pooled members; nothing is created or destroyed by a transition. The
 * planner is hysteretic (a margin gates every swap) so the boundary never
 * flaps. BELOW THE CAP THE TIER IS STRICTLY DORMANT — no rows, no
 * transitions, byte-identical behavior.
 *
 * Kernel layering: pure data + arithmetic; imports stay inside kernel/town
 * (construction.ts sees CohortRow through `import type` alone — the rows
 * just live in the same serialized store, the ZoneCharter pattern).
 */

import { resolveStructure, type StructureSpec } from "./structures.js";
import { zoneAt, type TownGrowthSignals, type ZoneCharter } from "./zoning.js";
import { stackTotal, stackUnits, type StockEndpoint } from "./transfer.js";
import type { FoundedBuilding, TownDeltas } from "./construction.js";

// ---------------------------------------------------------------------------
// Move-in — the immigration rule (deterministic, data-driven)
// ---------------------------------------------------------------------------

/** Food scarcer than this blocks immigration (shortage = 1 − got/need,
 *  ③'s TownGrowthSignals.shortage). A town at ≥75% fed admits; famine
 *  turns newcomers away — surplus attracts, hunger repels. */
export const MOVE_IN_FOOD_SHORTAGE_MAX = 0.25;

export interface MoveInInput {
  /** The town's serialized store — the founded rows + the admission fact. */
  deltas: TownDeltas;
  /** The session's structure catalog (which founded types are HOUSES). */
  catalog: ReadonlyArray<StructureSpec>;
  /** The ③ growth signals (host-assembled off the live books). */
  signals: TownGrowthSignals;
}

/**
 * ONE move-in tick (call once per credited town day, beside the growth
 * steps): when food is not scarce, the OLDEST completed, still-empty
 * founded house admits a household — `admitHousehold` writes the
 * serialized fact and the caller materializes it (a plan.houses row live;
 * applyFoundedBuildings on every rebuild). At most one household a day —
 * immigration is a trickle, not a flood. Null = nothing admitted (famine,
 * or no empty finished house). Deterministic given (deltas, signals).
 */
export function moveInStep(input: MoveInInput): FoundedBuilding | null {
  if (input.signals.shortage("food") > MOVE_IN_FOOD_SHORTAGE_MAX) return null;
  for (const b of input.deltas.founded()) {
    if (!b.completed || b.household) continue;
    const spec = resolveStructure(input.catalog, b.type);
    if (!spec || spec.role !== "house") continue;
    input.deltas.admitHousehold(b.ord);
    return b;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Districts — a district IS a zone charter ordinal (③'s stable ids)
// ---------------------------------------------------------------------------

/** The ONE default district: all unzoned ground (labeled by the town
 *  itself, not a charter). */
export const DEFAULT_DISTRICT = -1;

/** The district governing a TOWN-LOCAL point: the winning charter's ord
 *  (zoneAt — later charters paint over), or the default district. */
export function districtOfPoint(zones: readonly ZoneCharter[], x: number, y: number): number {
  return zoneAt(zones, x, y)?.ord ?? DEFAULT_DISTRICT;
}

// ---------------------------------------------------------------------------
// Cohort rows — the serializable per-district pool
// ---------------------------------------------------------------------------

/** One pooled household (promotion returns exactly these members). */
export interface CohortHouse {
  /** The house's plan index (its walls stand either way — only the SOULS
   *  pool; the building, furniture and pantry closed forms stay put). */
  index: number;
  /** Souls this household pooled (HOUSEHOLD, minus authored exclusions). */
  members: number;
}

/** One district's cohort pool — a serializable row (TownDeltas pattern,
 *  plain JSON, no RNG). `stack` is a LIVE stack map (fractional units are
 *  legal — rates integrate continuously) aliased by the ② endpoint view. */
export interface CohortRow {
  /** District id: a zone charter ord, or DEFAULT_DISTRICT. */
  district: number;
  /** Pooled street population (souls). */
  pop: number;
  /** Average wellbeing of the pooled souls, 0..1. */
  wellbeing: number;
  /** Pooled needs satisfaction per commodity glyph, 0..1 (last integrated
   *  window: 1 = the pool fully fed that need). */
  needs: Record<string, number>;
  /** The pool's INVENTORY — a real stack map (glyph → units). A
   *  StockEndpoint view aliases it, so ② transfers reach the pool. */
  stack: Record<string, number>;
  /** The households this pool absorbed, in demotion order. */
  houses: CohortHouse[];
  /** Town street-day the rates last integrated to (idle-safe: elapsed
   *  time integrates in one closed step, however long). */
  ratesDay: number;
}

export function emptyCohortRow(district: number, day = 0): CohortRow {
  return { district, pop: 0, wellbeing: 0.75, needs: {}, stack: {}, houses: [], ratesDay: day };
}

export function cohortRowOf(rows: readonly CohortRow[], district: number): CohortRow | undefined {
  return rows.find((r) => r.district === district);
}

export function ensureCohortRow(rows: CohortRow[], district: number, day = 0): CohortRow {
  const hit = cohortRowOf(rows, district);
  if (hit) return hit;
  const row = emptyCohortRow(district, day);
  rows.push(row);
  // District order stays stable (default first, then charter ord) so
  // serialization and the HUD read the same sequence on every replay.
  rows.sort((a, b) => a.district - b.district);
  return row;
}

/** House indices currently pooled (the resident model's exclusion set). */
export function pooledHouseIndices(rows: readonly CohortRow[]): Set<number> {
  const out = new Set<number>();
  for (const r of rows) for (const h of r.houses) out.add(h.index);
  return out;
}

/** Total pooled souls across every district. */
export function cohortPopulation(rows: readonly CohortRow[]): number {
  return rows.reduce((s, r) => s + r.pop, 0);
}

/** Conservation probe: total souls + merged stacks across the pools. */
export function cohortTotals(rows: readonly CohortRow[]): { pop: number; stack: Record<string, number> } {
  const stack: Record<string, number> = {};
  for (const r of rows) {
    for (const [g, n] of Object.entries(r.stack)) stack[g] = (stack[g] ?? 0) + n;
  }
  return { pop: cohortPopulation(rows), stack };
}

/**
 * DEMOTE one household into a district pool: members join the population,
 * the household's CARRIED stacks (hands/pockets — never the house pantry,
 * which belongs to the standing building) fold into the pool inventory,
 * and the pool wellbeing takes the member-weighted average. Conserving by
 * construction — everything added here came out of the tracked tier.
 */
export function demoteHousehold(
  rows: CohortRow[],
  district: number,
  house: CohortHouse,
  carried: Readonly<Record<string, number>>,
  wellbeing: number,
  day = 0,
): CohortRow {
  const row = ensureCohortRow(rows, district, day);
  const prevPop = row.pop;
  row.pop += house.members;
  row.houses.push({ index: house.index, members: house.members });
  for (const [g, n] of Object.entries(carried)) {
    if (n > 0) row.stack[g] = (row.stack[g] ?? 0) + n;
  }
  row.wellbeing =
    row.pop > 0 ? (row.wellbeing * prevPop + wellbeing * house.members) / row.pop : wellbeing;
  return row;
}

/**
 * PROMOTE one household back out of its pool: exactly the pooled members
 * return (population conserved to the soul). The pool KEEPS its inventory
 * — a demoted hand's stack became district property (transferable via ②);
 * promoted souls re-embody empty-handed, so no unit is ever minted or
 * lost across any demote/promote cycle. A fully-drained row is dropped.
 */
export function promoteHousehold(
  rows: CohortRow[],
  houseIndex: number,
): { district: number; house: CohortHouse } | null {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const hi = row.houses.findIndex((h) => h.index === houseIndex);
    if (hi < 0) continue;
    const house = row.houses.splice(hi, 1)[0]!;
    row.pop = Math.max(0, row.pop - house.members);
    const district = row.district;
    if (row.pop <= 0 && row.houses.length === 0 && stackTotal(row.stack) <= 1e-9) {
      rows.splice(i, 1);
    }
    return { district, house };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The ② endpoint view — the pool is a StockEndpoint
// ---------------------------------------------------------------------------

export const COHORT_ENDPOINT_PREFIX = "cohort:";

/** A district pool's endpoint id ("cohort:-1" = the default district). */
export function cohortEndpointId(district: number): string {
  return `${COHORT_ENDPOINT_PREFIX}${district}`;
}

export function parseCohortEndpointId(id: string): number | null {
  if (!id.startsWith(COHORT_ENDPOINT_PREFIX)) return null;
  const n = Number(id.slice(COHORT_ENDPOINT_PREFIX.length));
  return Number.isInteger(n) ? n : null;
}

/** The pool as a LIVE StockEndpoint (the ONE-container law: `stack`
 *  ALIASES the row's real map — a ② transfer moves what the HUD reads).
 *  Communal scope; `at` = the district's walk-to anchor (charter center /
 *  the town center for the default district). */
export function cohortEndpoint(row: CohortRow, at: { x: number; y: number }): StockEndpoint {
  return { id: cohortEndpointId(row.district), kind: "cohort", at, owner: "town", stack: row.stack };
}

// ---------------------------------------------------------------------------
// Rates — production/consumption integrated on the town-day clock
// ---------------------------------------------------------------------------

/** Per-district rates, host-assembled off the SAME street books individual
 *  residents project (goods.ts): production = the district's producer
 *  works' dawn-cart daily units (cartRations — the dawnCartAgreementInput
 *  number); consumption = the street perCapitaDaily each soul eats. */
export interface CohortRates {
  /** Units/day flowing INTO the pool, per glyph. */
  production: Record<string, number>;
  /** Units/person/day the pooled souls consume, per glyph. */
  perCapita: Record<string, number>;
  /** Pool cap per glyph (a district pantry norm) — overflow is the
   *  surplus the market/export flows carry off abstractly. Absent =
   *  uncapped. */
  stackCap?: Record<string, number>;
}

/** Fractional head-aware draw (takeStock floors to integers; pool
 *  quantities are continuous). Plain glyph first, facted variants in
 *  stable key order — the spendCosts convention. Returns units drawn. */
function drawStock(stack: Record<string, number>, glyph: string, n: number): number {
  const head = glyph.split(".")[0] ?? glyph;
  let left = Math.max(0, n);
  let drawn = 0;
  const keys = Object.keys(stack)
    .filter((k) => (k.split(".")[0] ?? k) === head)
    .sort((a, b) => (a === head ? -1 : b === head ? 1 : a < b ? -1 : 1));
  for (const k of keys) {
    if (left <= 1e-9) break;
    const take = Math.min(left, Math.max(0, stack[k] ?? 0));
    if (take <= 0) continue;
    stack[k]! -= take;
    left -= take;
    drawn += take;
    if (stack[k]! <= 1e-9) delete stack[k];
  }
  return drawn;
}

/**
 * Integrate one pool up to town street-day `day` (idle-safe CLOSED FORM —
 * however many days elapsed, one call catches up; production and
 * consumption integrate exactly, so slicing the same window into daily
 * calls moves the identical stock). Production lands first, the souls
 * eat second (need = pop × perCapita × elapsed, head-aware, honest
 * partial service), the cap trims last. Needs satisfaction is the served
 * fraction of the window; wellbeing drifts toward what the satisfaction
 * earns (fed pools brighten, starved pools sink). No RNG.
 */
export function cohortRatesStep(row: CohortRow, day: number, rates: CohortRates): void {
  const elapsed = Math.max(0, day - row.ratesDay);
  row.ratesDay = Math.max(row.ratesDay, day);
  if (elapsed <= 0) return;
  for (const [g, r] of Object.entries(rates.production)) {
    if (r > 0) row.stack[g] = (row.stack[g] ?? 0) + r * elapsed;
  }
  let satSum = 0;
  let satN = 0;
  for (const [g, r] of Object.entries(rates.perCapita)) {
    const need = row.pop * Math.max(0, r) * elapsed;
    if (need <= 0) continue;
    const served = drawStock(row.stack, g, need);
    const sat = Math.max(0, Math.min(1, served / need));
    row.needs[g] = sat;
    satSum += sat;
    satN++;
  }
  if (satN > 0) {
    // A fully-fed pool settles ≈0.95; a starved one sinks toward 0.2.
    const target = 0.2 + 0.75 * (satSum / satN);
    row.wellbeing += (target - row.wellbeing) * Math.min(1, 0.35 * elapsed);
  }
  if (rates.stackCap) {
    for (const [g, cap] of Object.entries(rates.stackCap)) {
      const have = stackUnits(row.stack, g);
      if (have > cap) drawStock(row.stack, g, have - cap);
    }
  }
}

// ---------------------------------------------------------------------------
// Tier transitions — hysteretic, deterministic, one per sweep
// ---------------------------------------------------------------------------

/** Souls the tracked tier carries at most (TownPlayConfig.trackedResidents
 *  override). 30 = six full households — exactly the historical 6-house
 *  village floor, so the smallest towns are ALWAYS fully tracked and the
 *  tier stays dormant (byte-identical) below city scale. */
export const TRACKED_RESIDENTS_DEFAULT = 30;

/** Keep-score margin (meters of focus distance) a pooled household must
 *  beat a tracked one by before they SWAP — the no-flap hysteresis: after
 *  a swap the score gap points the other way, so the pair can never trade
 *  places again until the player genuinely moves. */
export const COHORT_SWAP_MARGIN = 40;

export interface CohortHouseCandidate {
  /** House plan index. */
  index: number;
  /** Souls the household counts against the cap. */
  members: number;
  /** KEEP-desire — higher stays tracked (host: −distance to the player's
   *  focus; the dollhouse lives where the player looks). */
  score: number;
  /** Never demote: the family/dollhouse, watched interiors, houses with
   *  party/possessed/busy members (in-flight tasks stay tracked). */
  pinned?: boolean;
  /** Currently pooled (a promotion candidate). */
  pooled: boolean;
}

export type CohortTransition =
  | { kind: "demote"; index: number }
  | { kind: "promote"; index: number }
  | { kind: "swap"; demote: number; promote: number };

/**
 * AT MOST ONE tier transition per sweep (turnover is gradual — never a
 * mass demotion in one frame), pure and deterministic in its input:
 *
 *   over cap  → demote the worst-scored unpinned tracked house
 *               (ties: the higher index — younger lots pool first);
 *   room free → promote the best-scored pooled house that FITS under the
 *               cap (ties: the lower index);
 *   otherwise → SWAP only when the best pooled house outscores the worst
 *               tracked one by COHORT_SWAP_MARGIN (the hysteresis band).
 *
 * Below the cap with no pools this returns null without touching anything
 * — the dormancy guarantee.
 */
export function planCohortTransition(
  cap: number,
  houses: readonly CohortHouseCandidate[],
): CohortTransition | null {
  const tracked = houses.filter((h) => !h.pooled);
  const pooled = houses.filter((h) => h.pooled);
  const count = tracked.reduce((s, h) => s + h.members, 0);
  if (count <= cap && pooled.length === 0) return null; // dormant
  const demotable = tracked
    .filter((h) => !h.pinned)
    .sort((a, b) => a.score - b.score || b.index - a.index);
  if (count > cap && demotable.length) return { kind: "demote", index: demotable[0]!.index };
  const promotable = [...pooled].sort((a, b) => b.score - a.score || a.index - b.index);
  if (!promotable.length) return null;
  const cand = promotable[0]!;
  if (count + cand.members <= cap) return { kind: "promote", index: cand.index };
  if (demotable.length && cand.score > demotable[0]!.score + COHORT_SWAP_MARGIN) {
    return { kind: "swap", demote: demotable[0]!.index, promote: cand.index };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sampled street life — cosmetic-only walkers (hash, never Math.random)
// ---------------------------------------------------------------------------

function hashSeed(seed: number, key: string): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Sampled walkers a district's pool shows on its streets (a FEW bodies —
 *  the streets don't die visually; the pool itself never walks). */
export function cohortWalkerCount(pop: number): number {
  if (pop <= 0) return 0;
  return Math.max(1, Math.min(3, Math.ceil(pop / 12)));
}

/** Deterministic walker anchor spots inside the district disc, hashed off
 *  (seed, day, district, k) — same day, same spots, every replay; a new
 *  day deals new ones. Pure sampling: COSMETIC ONLY, no economy effect. */
export function cohortWalkerSpots(
  seed: number,
  day: number,
  district: number,
  anchor: { x: number; y: number; r: number },
  n: number,
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let k = 0; k < n; k++) {
    const a = (hashSeed(seed, `cohort:${district}:${day}:${k}:a`) / 4294967296) * Math.PI * 2;
    const f = 0.25 + (hashSeed(seed, `cohort:${district}:${day}:${k}:r`) / 4294967296) * 0.65;
    out.push({ x: anchor.x + Math.cos(a) * anchor.r * f, y: anchor.y + Math.sin(a) * anchor.r * f });
  }
  return out;
}
