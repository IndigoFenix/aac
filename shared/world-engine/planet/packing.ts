// shared/world-engine/planet/packing.ts
//
// 🌿 RESOURCE PACKING — HOW MANY PLANTS FIT IN A HECTARE, DERIVED.
//
// THE DEFECT THIS CLOSES. Standing density used to be AUTHORED: four numbers
// on `ecology.ts FORAGE_UNDERSTORY`, hand-balanced against the forage anchor,
// with a comment begging the next round to move the cadence back whenever it
// moved a density. That is a balance table wearing an ecology's clothes, and
// it could only ever be right at the ONE cell it was balanced at — the shipped
// temperate wood. A tropical cell stood 0.554 banana plants a hectare because
// nobody had authored a banana row, and a grassland stood the woodland's
// hedge because `eco_grass` happened to be non-zero.
//
// ⚖️ THE LAW INSTEAD. A plant OCCUPIES GROUND and DRINKS: it shades a crown
// disc and drains a root disc. A hectare supplies a fixed amount of light,
// water (× rain) and nutrient (× fertility). How many of each species stand
// there is then ARITHMETIC over those budgets — Liebig's law of the minimum,
// shared out by how well each species suits the cell — and the per-hectare
// FLOW the forage anchor pins falls OUT of it instead of being balanced INTO
// it. Move a crown radius and the density moves; nobody has to move a cadence
// back.
//
// ⚖️ PURE, DETERMINISTIC, BODY-BLIND. No RNG, no clock, no session. It reads
// the catalogue (products.ts) and the anchor (scale.ts) and answers plants per
// hectare. What is DRAWN, what is PLACED and what is FOLDED are three other
// modules' business.
//
// 🚫 NOT A GAMEPLAY DIAL. The gameplay dial is `resource_compression`, which
// still divides only `wildRegrowPeriodS`'s period. Everything here is a real
// figure or a scale calibrated once at the anchor cell.

import {
  crownAreaM2,
  forageYieldKcalPerM2Yr,
  nicheSuitabilityOf,
  rootAreaM2,
  sourceRarityOf,
  type ClimateSample,
  type NaturalProduct,
  type NaturalSource,
} from "../products.js";
import { RATION_KCAL, REAL_FORAGE_CAPTURE_FRACTION } from "../scale.js";
import { satiationDaysOf } from "../kernel/town/goods-kinds.js";

// ── THE THREE SUPPLY SCALES ────────────────────────────────────────────────
//
// ⚖️ ALL THREE ARE CALIBRATION SCALES, FIXED ONCE AT THE TEMPERATE ANCHOR
// CELL — `headless/text-quest.ts` `PLANET_CELL_CLIMATE` (rain 1.0, tempC 12,
// elevation 5, fertility 8, ore 2) and `PLANET_CELL_ECO` (tree 0.35). They
// are not measurable quantities in their own units; they are the constants
// that make "one hectare" mean the same thing to the packing pass that it
// means to `scale.ts REAL_FORAGE_HA_PER_PERSON`.
//
// 🚨 AND WATER AND NUTRIENT ARE DERIVED FROM THE ANCHOR COMMUNITY'S OWN ROOT
// DEMAND, which is the whole reason they are worth having. Set them higher and
// light alone would bind everywhere, so rain and fertility would be decoration.
// Set at the anchor community's demand, the reference community is CO-LIMITED —
// light and water bind together at the anchor — and a drier or poorer cell
// binds on water or nutrient FOR REAL: the grassland below stands its onions
// on a water budget, not on a light budget.

/** Light a hectare of OPEN SKY supplies, in m² of crown it can carry. */
export const LIGHT_SUPPLY_M2_PER_HA = 199.2147;

/** Water a hectare supplies PER UNIT OF RAIN, in m² of root plate. */
export const WATER_SUPPLY_M2_PER_HA_PER_RAIN = 212.9027;

/** Nutrient a hectare supplies PER UNIT OF FERTILITY, in m² of root plate. */
export const NUTRIENT_SUPPLY_M2_PER_HA_PER_FERTILITY = 26.6128;

/**
 * THE LAYER LINE, metres of standing height. At or above it a plant is CANOPY
 * and drinks the open sky (`Lc`); below it the plant is UNDERSTOREY and lives
 * on what the canopy lets through (`Lu`). 8 m is where a stem stops being
 * something you can reach into and starts being something you stand under —
 * the shipped catalogue's tallest understorey plant is the 4 m hazel and its
 * only canopy tree is the 23.8 m oak, so nothing sits near the line.
 */
export const CANOPY_HEIGHT_M = 8;

// ── THE PASS ───────────────────────────────────────────────────────────────

/** The four budgets a stand can draw on: Water, Nutrient, Canopy light,
 *  Understorey light. */
export type Pool = "W" | "N" | "Lc" | "Lu";

const POOLS: readonly Pool[] = ["W", "N", "Lc", "Lu"];

/** Floating-point slack for "this pool is spent" / "this member is capped". */
const EPS = 1e-9;

/** ONE CANDIDATE for the hectare. `fit` is how well this cell suits it
 *  (rarity × niche suitability — a relative share, never a count); `demand` is
 *  the ground ONE individual takes out of each pool, m². A pool it does not
 *  draw is 0 and is not consulted. */
export interface PackMember {
  key: string;
  fit: number;
  demand: Record<Pool, number>;
}

/** What ONE HECTARE of this cell supplies, m² per pool. */
export interface PackSupply {
  W: number;
  N: number;
  Lc: number;
  Lu: number;
}

/**
 * PACK A HECTARE — individuals per hectare, in the order the members came.
 *
 * TWO PASSES, FIT-SHARE PER POOL, LIEBIG MINIMUM, ONE RE-DEAL:
 *   · each still-unbound member is offered `fit_i / Σ fit_j` of every pool it
 *     draws (the sum over the unbound members that draw THAT pool), and takes
 *     the SMALLEST count those shares can carry — Liebig: the scarcest input
 *     sets the number, no averaging;
 *   · a member is BOUND when a pool it draws is spent, or when it has reached
 *     the count it would have standing alone (its solo ceiling) — nothing gets
 *     more room than an empty hectare would give it;
 *   · pass two re-deals whatever the bound members left behind to the members
 *     still unbound, which is what lets ONE plant fill a cell its neighbours
 *     cannot use.
 *
 * ⚖️ THE INVARIANT, and the thing the suite pins: `Σ n_i × d_ir ≤ S_r` at
 * EVERY pool. A hectare never carries more crown than it has light for.
 *
 * ⚖️ ORDER-INVARIANT BY CONSTRUCTION — every member reads the SAME `avail`
 * snapshot within a pass, so the catalogue's order decides only the order of
 * the answer, never its numbers. (The result is returned in catalogue order
 * because the caller writes it back onto mix lines in that order.)
 */
export function packStands(
  members: readonly PackMember[],
  supply: PackSupply,
): { key: string; perHa: number }[] {
  const n = members.map(() => 0);
  const done = members.map(() => false);
  const draws = members.map((m) => POOLS.filter((r) => m.demand[r] > 0));
  // The count each member would reach with the whole hectare to itself.
  const solo = members.map((m, i) => {
    let best = Infinity;
    for (const r of draws[i]!) best = Math.min(best, supply[r] / m.demand[r]);
    return best;
  });
  for (let i = 0; i < members.length; i++) {
    if (!draws[i]!.length || !(members[i]!.fit > 0)) done[i] = true;
  }

  const avail: PackSupply = { ...supply };
  for (let pass = 0; pass < 2; pass++) {
    // Per-pool fit totals over the members still competing for that pool.
    const totals: Record<Pool, number> = { W: 0, N: 0, Lc: 0, Lu: 0 };
    let open = 0;
    for (let i = 0; i < members.length; i++) {
      if (done[i]) continue;
      open += members[i]!.fit;
      for (const r of draws[i]!) totals[r] += members[i]!.fit;
    }
    if (open <= 0) break;

    for (let i = 0; i < members.length; i++) {
      if (done[i]) continue;
      const m = members[i]!;
      let inc = Infinity;
      for (const r of draws[i]!) {
        const share = totals[r] > 0 ? m.fit / totals[r] : 0;
        inc = Math.min(inc, (share * avail[r]) / m.demand[r]);
      }
      if (Number.isFinite(inc) && inc > 0) n[i] = n[i]! + inc;
    }

    const used: Record<Pool, number> = { W: 0, N: 0, Lc: 0, Lu: 0 };
    for (let i = 0; i < members.length; i++) {
      for (const r of POOLS) used[r] += n[i]! * members[i]!.demand[r];
    }
    for (let i = 0; i < members.length; i++) {
      if (done[i]) continue;
      done[i] =
        draws[i]!.some((r) => used[r] >= supply[r] - EPS) || n[i]! >= solo[i]! - EPS;
    }
    for (const r of POOLS) avail[r] = Math.max(0, supply[r] - used[r]);
    if (done.every(Boolean)) break;
  }

  return members.map((m, i) => ({ key: m.key, perHa: n[i]! }));
}

/**
 * WHAT ONE HECTARE OF THIS CELL SUPPLIES. Light is the sky (a constant);
 * understorey light is what the CANOPY lets through, so it reads the baked
 * `eco_tree` abundance — the same field `ecology.ts standDensityPerHa` stands
 * the oaks off, which is what keeps the wood and its own understorey from
 * disagreeing about how shaded the floor is. Water scales with rain and
 * nutrient with fertility, both straight off the cell's climate sample.
 */
export function packSupplyAt(
  climate: ClimateSample,
  abundance: Readonly<Record<string, number>>,
): PackSupply {
  const cover = Math.max(0, Math.min(1, abundance.tree ?? 0));
  return {
    W: WATER_SUPPLY_M2_PER_HA_PER_RAIN * Math.max(0, climate.rain),
    N: NUTRIENT_SUPPLY_M2_PER_HA_PER_FERTILITY * Math.max(0, climate.fertility),
    Lc: LIGHT_SUPPLY_M2_PER_HA,
    Lu: LIGHT_SUPPLY_M2_PER_HA * (1 - cover),
  };
}

/**
 * ONE CATALOGUE ROW as a candidate for this cell, or null when the row carries
 * no packing geometry (no `crownRadiusM`) or cannot live here at all
 * (suitability 0). MEMBERSHIP IS `fit > 0` — the pass decides how many, so a
 * plant that merely stands thinly is still a member, and a plant the niche
 * refuses is not.
 */
export function packMemberOf(
  src: NaturalSource,
  climate: ClimateSample,
): PackMember | null {
  const crown = crownAreaM2(src);
  if (crown <= 0) return null;
  const fit = sourceRarityOf(src) * nicheSuitabilityOf(src, climate);
  if (!(fit > 0)) return null;
  const root = rootAreaM2(src);
  const canopy = (src.bodyHeightM ?? 0) >= CANOPY_HEIGHT_M;
  return {
    key: src.species,
    fit,
    demand: {
      W: root,
      N: root,
      Lc: canopy ? crown : 0,
      Lu: canopy ? 0 : crown,
    },
  };
}

// ── THE BEARING LAW — WHAT ONE PLANT PUTS OUT PER CADENCE ──────────────────
//
// ⚖️ A BEARING SCALES WITH THE PLANT, and until this round it did not: a
// folded stand matured ONE UNIT PER PLANT per cadence whatever the plant was,
// so a wild-carrot patch and a hazel tree bore identically. The plant's own
// crown area and yield class say what it actually makes.

/**
 * RATIONS (person-days of food) one individual bears in ONE regrow cadence:
 * its crown's annual gross production, prorated to the cadence, times the
 * forager's real capture share, divided by the kcal in a ration.
 *
 * 🚨 DIAL-FREE. `regrowDays` is the REAL cadence; `resource_compression`
 * divides the period at the point of use (`wildRegrowPeriodS`) and must not
 * reach the amount — that is the two-clocks law, and the reason this reads
 * `p.regrowDays` rather than a compressed period.
 */
export function rationsPerBearing(src: NaturalSource, product: NaturalProduct): number {
  const days = product.regrowDays ?? 0;
  if (!(days > 0)) return 0;
  const kcal =
    forageYieldKcalPerM2Yr(src, product) *
    crownAreaM2(src) *
    (days / 365) *
    REAL_FORAGE_CAPTURE_FRACTION;
  return kcal / RATION_KCAL;
}

/**
 * ITEMS one individual bears in ONE regrow cadence — the rations above read
 * through the glyph's satiation value, which is the ONE seat that converts
 * person-days to stacks (`goods-kinds.ts satiationDaysOf`).
 *
 * ⚖️ IT IS FRACTIONAL AND THAT IS THE POINT. A berry bush bears 0.53 items a
 * cadence and a hazel 2.46: a small plant bears one item every N cadences
 * rather than one per cadence. The CARRY that makes a fraction into whole
 * items without minting or losing one lives at the two ripening seats
 * (`wild-area.ts ripenWildArea`, `wilderness.ts dueHarvestRegrowth`).
 *
 * 0 when the row carries no packing geometry — a caller keeps its legacy
 * one-unit law there, which is what makes every non-plant source byte-
 * identical.
 */
export function itemsPerBearing(src: NaturalSource, product: NaturalProduct): number {
  const days = satiationDaysOf(product.glyph);
  if (!(days > 0)) return 0;
  return rationsPerBearing(src, product) / days;
}
