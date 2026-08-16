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
import { headOf } from "../../variations.js";
import type { FoundedBuilding, TownDeltas } from "./construction.js";
import {
  registerFoldCodec,
  type FoldCodec, type FoldCtx, type FoldRecord, type FoldRefusal,
} from "./fold.js";
import { parseScopeId, type ScopeId } from "./scope.js";

// ---------------------------------------------------------------------------
// Move-in — the immigration rule (deterministic, data-driven)
// ---------------------------------------------------------------------------

/** Food scarcer than this blocks immigration (shortage = 1 − got/need,
 *  ③'s TownGrowthSignals.shortage). A town at ≥75% fed admits; famine
 *  turns newcomers away — surplus attracts, hunger repels. */
export const MOVE_IN_FOOD_SHORTAGE_MAX = 0.25;

/**
 * ⚖️ THE PUSH FLOOR (growth-motive law ②, S&D S1): pressure somewhere ELSE
 * must read at least this before anybody uproots. Nobody leaves a place that
 * is fine — a pull with no push is a household conjured out of nowhere, which
 * is precisely what `moveInStep` used to do on every fed day.
 *
 * Low (0.1) on purpose: this is a MINIMUM, and the reading it gates is a real
 * neighbour's real distress, not a knob.
 */
export const MOVE_IN_PUSH_MIN = 0.1;

export interface MoveInInput {
  /** The town's serialized store — the founded rows + the admission fact. */
  deltas: TownDeltas;
  /** The session's structure catalog (which founded types are HOUSES). */
  catalog: ReadonlyArray<StructureSpec>;
  /** The ③ growth signals (host-assembled off the live books). */
  signals: TownGrowthSignals;
  /**
   * ⚖️ THE PUSH, 0..1 (S&D S1) — how much WORSE it is somewhere else: the
   * worst distress among the origins this town can actually see (cluster
   * neighbours' and trade partners' own shortage/crowding books). A migrant
   * needs an origin, and this is the honest v1 of one.
   *
   * 🚨 IT IS NOT AN ORIGIN LEDGER. Nothing is debited from the place the
   * household left, because no place is named — the reading says only "it is
   * worse out there". What a conserving migration needs is recorded in the
   * S&D landing notes: a named origin, a soul debited there and credited
   * here, and a refusal when the origin cannot spare the family.
   *
   * REQUIRED (not optional-with-a-default) so no caller can migrate by
   * forgetting: a fixture that wants the historical behaviour states `1`.
   */
  push: number;
}

/**
 * ONE move-in tick (call once per credited town day, beside the growth
 * steps): when food is not scarce AND somewhere else is worse, the OLDEST
 * completed, still-empty founded house admits a household —
 * `admitHousehold` writes the serialized fact and the caller materializes it
 * (a plan.houses row live; applyFoundedBuildings on every rebuild). At most
 * one household a day — immigration is a trickle, not a flood. Null =
 * nothing admitted (famine, nowhere worse, or no empty finished house).
 * Deterministic given (deltas, signals, push).
 */
export function moveInStep(input: MoveInInput): FoundedBuilding | null {
  // THE PULL (unchanged): a town that cannot feed itself turns newcomers away.
  if (input.signals.shortage("food") > MOVE_IN_FOOD_SHORTAGE_MAX) return null;
  // ⚖️ THE PUSH (S&D S1): and somebody has to have a reason to leave.
  if (!(input.push >= MOVE_IN_PUSH_MIN)) return null;
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
  /**
   * ⚖️ ENDOGENOUS POPULATION v1 (growth-motive law ②, S&D S1) — the CIV
   * TIER'S OWN Malthus policy, adopted verbatim in shape at the live rung.
   *
   * The live cohort step has never written `row.pop`: souls only ever entered
   * a pool by demotion and left by promotion, so no town on any map had a
   * birth. This is the one closed-form law the engine already trusts
   * (`kernel/civ/plan.ts` and `town-world.ts` run it clause for clause):
   *
   *     births = pop × birthRate × fill
   *     deaths = pop × (deathRate + starvation × (1 − fill))
   *
   * FILL GATES BIRTHS — a starving pool has no children and buries more, which
   * is what makes population growth a consequence of the food economy instead
   * of a clock. `diet` names the commodity whose satisfaction is the fill
   * (absent ⇒ the mean over every need integrated this window; a pool with no
   * needs at all reads fill 1).
   *
   * ABSENT ⇒ the shipped step to the byte: no pop write, no rounding, nothing.
   */
  vitals?: {
    birthRate: number;
    deathRate: number;
    /** Extra death rate at zero fill, scaled by (1 − fill). */
    starvation?: number;
    /** The commodity whose satisfaction gates births. */
    diet?: string;
  };
}

/** Fractional head-aware draw (takeStock floors to integers; pool
 *  quantities are continuous). Plain glyph first, facted variants in
 *  stable key order — the spendCosts convention. Returns units drawn. */
function drawStock(stack: Record<string, number>, glyph: string, n: number): number {
  const head = headOf(glyph);
  let left = Math.max(0, n);
  let drawn = 0;
  const keys = Object.keys(stack)
    .filter((k) => headOf(k) === head)
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
 *
 * ⚖️ AND THEN THE POOL BREATHES (S&D S1, `rates.vitals`) — births and deaths
 * on the fill this window just delivered, exactly where `town-world.ts` puts
 * them ("day end: vitals on the diet fill the settlement just delivered").
 * Compounded over the window (`(1 + r)^elapsed`), so a pool that slept a year
 * catches up in one step like everything else here.
 *
 * ⚠️ ONE HONEST CAVEAT, and it is the reason vitals are OPT-IN. Without them
 * this step is slice-EXACT: one call over N days moves the same stock as N
 * daily calls, and the test pins that. With them it cannot be, because the
 * population that eats in the second day depends on the fill of the first —
 * feedback has no slice-invariant closed form. One call reads the whole window
 * at one fill; N calls re-read it N times. Both are deterministic and both are
 * honest; they are not identical, and nothing may assume they are.
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
  // ⚖️ VITALS (S&D S1) — the civ tier's closed form at the live rung.
  if (rates.vitals && row.pop > 0) {
    const v = rates.vitals;
    // The fill THIS window delivered: the diet's own satisfaction when one is
    // named, else the mean over everything the pool needed. A pool with no
    // needs integrated (nothing to eat, nothing owed) reads 1 — it is not
    // starving, it simply has no diet in the books.
    const fill =
      v.diet !== undefined
        ? Math.max(0, Math.min(1, row.needs[v.diet] ?? 1))
        : satN > 0
          ? satSum / satN
          : 1;
    const r =
      Math.max(0, v.birthRate) * fill -
      (Math.max(0, v.deathRate) + Math.max(0, v.starvation ?? 0) * (1 - fill));
    // Compounded over the window, never negative-per-day (a rate that would
    // take a pool below zero in one day takes it to zero instead).
    const next = row.pop * Math.pow(Math.max(0, 1 + r), elapsed);
    // 🚨 CONSERVE-TOTALS DISCIPLINE FOR TRANSITIONS. `promoteHousehold` gives
    // a demoted household back exactly the members it pooled, so the pool may
    // never hold fewer souls than its housed base owes — a starved pool that
    // dipped under it would MINT people on the next promotion. Deaths bite the
    // street population above that base; below it, a full model would have to
    // age the households themselves (recorded, S&D landing notes).
    const housed = row.houses.reduce((s, h) => s + h.members, 0);
    row.pop = Math.max(housed, next);
  }
}

// ---------------------------------------------------------------------------
// Tier transitions — hysteretic, deterministic, one per sweep
// ---------------------------------------------------------------------------

/** Souls the tracked tier carries at most (TownPlayConfig.trackedResidents
 *  override). ABSTRACTION IS FOR CITIES (user, 2026-07-22): a village's
 *  people are real residents, never a district statistic — the old cap of
 *  30 pooled two-thirds of a 24-house demo town, and its sampled cosmetic
 *  walkers blinked on the plaza. 150 keeps every village/small-town demo
 *  fully tracked (dormant tier, byte-identical) and reserves cohorts for
 *  genuine city scale. */
export const TRACKED_RESIDENTS_DEFAULT = 150;

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

// ---------------------------------------------------------------------------
// The registered codec (F2 — fold-round.md) — households ⇄ the district pool
// ---------------------------------------------------------------------------
//
// ⚖️ F-② — population is the SECOND codec through the one fold (F1: wild,
// wild-area.ts). `demoteHousehold`/`promoteHousehold` above are UNTOUCHED
// and byte-stable: the one live caller (quest-host.ts `demoteHouse`/
// `promoteHouse`) keeps calling them directly. What follows is the same
// thin second front door F1 cut for wild — the generic dispatch
// (`kernel/town/fold.ts` `condense`/`expand`) — registered so `kind:
// "district"` is foldable through it too.
//
// 🚨 UNLIKE WILD, THIS DOOR PLUGS NO AUDIT GAP. A cohort row is ALWAYS a
// live `StockEndpoint` (`cohortEndpoint`, above) whether or not any
// household is pooled in it — a session's own scope tree already lists
// `cohortEndpointId(row.district)` for every row it holds (quest-host.ts
// `scopeTreeOf`), so `auditScopeTree` counts a pool's stack the ordinary
// way. An unloaded WILD AREA has no live stack at all (the standing
// features it would otherwise be are simply gone), which is the actual gap
// `foldedStock("wild", …)` bridges. Nothing here needs that bridge; this
// codec exists only to make `kind: "district"` dispatchable, exactly as
// wild's does for `kind: "wild"` — quest-host's real audit and real
// demote/promote call sites are untouched by either.
//
// THE SCOPE THE CODEC OWNS: the DISTRICT (`cohort:<district>`, kind
// "district" — scope.ts `COHORT_PREFIX`), never the household. A TRACKED
// household's own id (`h_<index>`, kind "building") is a DIFFERENT
// `ScopeKind` — scope.ts gives it no shared discriminator with "district"
// the way `wild:area:*` and `wild:oak_3` share `kind: "wild"` with a `form`
// field telling the area from its trees. So `condense`/`expand` here fold
// exactly what the wild precedent folds: what stands UNDER an aggregate
// scope (an area's trees; a district's currently-tracked households, named
// by `ctx.households`) into that aggregate's OWN closed form
// (`WildAreaRecord`; `CohortRow`) — never a household's own id, which this
// codec never receives and never answers for. A pooled household has no
// scope id of its own in this grammar either way (`scopeTreeOf` never lists
// one per house once pooled — only the district row), so there is nothing
// this codec is declining to speak for.

/**
 * What the codec's `condense`/`expand` need from the live host, beyond the
 * base clock (`FoldCtx.now`) — the union of what `demoteHousehold` and
 * `promoteHousehold` themselves take, minus what the scope id already
 * answers (the district number is the id's own tail).
 */
export interface CohortFoldCtx extends FoldCtx {
  /** condense: households to fold into this district right now — the same
   *  triple `demoteHousehold` already takes (house, carried stack,
   *  wellbeing). Absent ⇒ none fold (an empty condense of a fresh or
   *  already-empty pool). */
  households?: readonly {
    house: CohortHouse;
    carried: Readonly<Record<string, number>>;
    wellbeing: number;
  }[];
  /** condense: the pool this district already holds, when there is one —
   *  carried forward exactly as `demoteHousehold`'s own `rows` array
   *  accumulates a pre-existing row. Read-only: condense never mutates it
   *  (a clone folds households in), matching wild's own `prev` contract. */
  prev?: CohortRow | null;
  /**
   * condense: the town STREET-DAY `demoteHousehold`'s own `day` param wants
   * — NOT `now` (`FoldCtx`'s clock is absolute taskClock SECONDS; a
   * cohort's rate-integration clock is a different unit entirely, exactly
   * as `cohortRatesStep`'s own `day` is, and the live caller's conversion —
   * `session.townClock / FOOD_DAY_SEC` — is a host constant this pure
   * kernel module never sees). Default 0, matching `demoteHousehold`'s own.
   */
  day?: number;
  /** expand: receives each promoted household back — the live host's hook
   *  to re-track it, a test's hook to collect the results. Optional: omit
   *  for a dry run that only wants the ids back. */
  place?(district: number, house: CohortHouse): void;
}

/** A defensive copy — condense/expand read `prev`/`record.payload` without
 *  ever mutating the caller's own row (demoteHousehold/promoteHousehold
 *  mutate their `rows` array in place, so the codec must hand them a copy). */
function cloneCohortRow(row: CohortRow): CohortRow {
  return {
    district: row.district,
    pop: row.pop,
    wellbeing: row.wellbeing,
    needs: { ...row.needs },
    stack: { ...row.stack },
    houses: row.houses.map((h) => ({ ...h })),
    ratesDay: row.ratesDay,
  };
}

function condenseCohortPayload(id: ScopeId, ctx: CohortFoldCtx): CohortRow | FoldRefusal {
  const ref = parseScopeId(id);
  if (ref.kind !== "district") {
    return { refused: true, kind: "district", id, blockers: [], note: `not a cohort/district id ("${id}")` };
  }
  const rows: CohortRow[] = ctx.prev ? [cloneCohortRow(ctx.prev)] : [];
  const day = ctx.day ?? 0;
  for (const h of ctx.households ?? []) {
    demoteHousehold(rows, ref.district, h.house, h.carried, h.wellbeing, day);
  }
  return cohortRowOf(rows, ref.district) ?? emptyCohortRow(ref.district, day);
}

function expandCohortPayload(
  record: FoldRecord<CohortRow>,
  ctx: CohortFoldCtx,
): ScopeId[] | FoldRefusal {
  const rows: CohortRow[] = [cloneCohortRow(record.payload)];
  const out: ScopeId[] = [];
  for (const h of record.payload.houses) {
    const promoted = promoteHousehold(rows, h.index);
    if (!promoted) continue;
    ctx.place?.(promoted.district, promoted.house);
    out.push(`h_${promoted.house.index}`);
  }
  return out;
}

/** Every unit a cohort row holds, by glyph — the read side `foldedStock`
 *  sums over (a session's own `t.deltas.cohorts` plugs in exactly as
 *  `session.wildAreas.values()` plugs into wild's). Population itself is
 *  not a glyph — `cohortPopulation`/`cohortTotals` answer that question;
 *  this is the MATERIAL half only, matching `wildAreaStock`'s own scope. */
function cohortRowStock(row: CohortRow): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [g, n] of Object.entries(row.stack)) if (n > 0) out[g] = n;
  return out;
}

/**
 * THE COHORT CODEC — registered below at module load, so importing this
 * module (already the whole game does, for `demoteHousehold`/
 * `promoteHousehold` themselves) is enough to make `kind: "district"`
 * foldable through the generic dispatch.
 */
export const COHORT_CODEC: FoldCodec<CohortRow, CohortFoldCtx> = {
  kind: "district",
  condense: condenseCohortPayload,
  expand: expandCohortPayload,
  stockOf: cohortRowStock,
};

registerFoldCodec(COHORT_CODEC);
