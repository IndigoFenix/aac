/**
 * barter.ts — INTERCITY BARTER (city-expansion phase ⑤): real economics at
 * the town boundary, executed on the ② transfer ledger.
 *
 * THE ECONOMY STANCE, at last enforced in code: towns stay COMMUNAL inside
 * (roster/needs allocate — no currency, no prices, ever), and price
 * discovery happens only BETWEEN towns, as goods-for-goods EXCHANGE RATIOS
 * driven by relative scarcity. A food-rich, wood-poor town gives more food
 * per wood than a balanced one — so specializing a town via zoning (③) and
 * importing what it lacks becomes a real strategy layer.
 *
 * THE RATIO MODEL. Each good carries a pair-WORTH: 1 + W·(our shortage +
 * their shortage) — symmetric in the two towns, so the model is one price
 * per good PER PAIR, not per side. The ratio for a deal (how many take-units
 * one give-unit buys) is worth(give)/worth(take), clamped to
 * [1/BARTER_RATIO_CAP, BARTER_RATIO_CAP]. Properties, all test-pinned:
 *   • PERSPECTIVE CONSISTENCY — A's view of the A↔B deal is exactly B's
 *     inverse (worth is pair-symmetric; the clamp bounds are reciprocal).
 *   • MONOTONE IN SCARCITY — the scarcer their need for what we give, the
 *     better our ratio (worth(give) rises with their shortage of it).
 *   • BOUNDED — no deal ever goes infinite or free (the clamp).
 *   • DETERMINISTIC — pure arithmetic of the signals; no RNG anywhere.
 * Both sides' desperation counts: a town in famine gets WORSE terms for the
 * food it buys — bargaining position is part of the lesson. ⚖️ AND SO DOES
 * OURS ON THE VOLUME (G1): the famine that refuses to sell is a law of TOWNS,
 * not of partners, so it reads on both sides of every deal — the refusal
 * (`barterWillingness`'s mirror) and the batch bound (`barterSpareUnits`,
 * which thins a route continuously as we approach our own gate).
 *
 * THE SPOKEN QUOTE. Ratios surface as small integer pairs ("3 wood for
 * 2 food") built from the speakable quantity words (one/two/three), and
 * shipments move in WHOLE quote batches — the spoken terms are exactly the
 * executed terms, remainder honestly left at home.
 *
 * PARTNERS. A real-sim partner (a cluster hamlet's live TownPlay) supplies
 * real shortage signals; an abstract partner (`away:<seed>` / a flight-tier
 * `city:<cell>` stub) gets a CLOSED-FORM PROXY: a hash-seeded base per
 * (partner, good) plus a slow triangular season over the town day — so
 * terms shift over time against a stub too, deterministically.
 * ⚖️ AND THE TWO ARE ONE TYPE (F-⑤, fold-round.md F3): the "abstract partner"
 * is a town nobody has EXPANDED, its whole state the `TownRecord` at the
 * bottom of this file, its shelf mint `condense` of a town that has never run.
 * See the codec section's own header.
 *
 * EXECUTION rides the ② ledger: a barter agreement is a TransferAgreement
 * whose `barter` field carries the return flow + quote; `runDueBarters`
 * (this module) is its scheduled executor — re-derives terms per shipment,
 * re-checks the partner's WILLINGNESS (famine suspends a standing route,
 * visibly; recovery resumes it), and moves stock BOTH WAYS between the live
 * endpoints. runDueTransfers skips barter rows by contract.
 *
 * Kernel layering: pure data + arithmetic; imports stay inside kernel/town.
 */

import { FOOD_DAY_SEC } from "./goods.js";
import {
  stackHead,
  stackUnits,
  transferStock,
  type StockEndpoint,
  type TransferAgreement,
  type TransferLedger,
} from "./transfer.js";
// ⚖️ §7 step 6: `journeyS` into the barter leg. The region rung already owns
// "how far one day of legs carries you" — the town stops inventing it.
// ⚖️ THE TRANSACTION-PACING SEAT (user law, 2026-08-13): `transactionDayFrac`
// is the ONE place `BARTER_LEG_DAY_FRAC` now anchors — see its own doc
// comment below and the seat's header in scale.ts for why the merge lives
// there and not in kernel/town/pricing.ts.
import { dailyTravelM, transactionDayFrac, type WorldScale } from "../../scale.js";
// ⚖️ R&T ⑤ (T5): the freight registry classes a good by how it travels, so the
// geography term never has to name one. Read-only from here, exactly as
// trade.ts reads it — the town rung asks, it never re-derives.
import { freightOf, VALUE_TIER } from "../../freight.js";
// TYPE ONLY (erased at build): the node taxonomy is kernel/cells' vocabulary
// and this module borrows the NOUN, never the module — no runtime edge.
import type { NodeType } from "../cells/node-typing.js";
// ⚖️ R&T ⑤ (T2): the pair's complementary read lives in a leaf sibling so
// `bindPartner` can call it without closing barter → transfer → trade into a
// cycle (see complementary.ts's header). `BARTER_WANT_MIN` is defined there —
// ONE definition — and keeps its established name here.
import { BARTER_WANT_MIN } from "./complementary.js";
export { BARTER_WANT_MIN };
// ⚖️ F3 (fold-round.md): the TOWN codec at the bottom of this file registers
// itself with the one fold, exactly as wild-area.ts and population.ts do.
import {
  registerFoldCodec,
  type FoldCodec, type FoldCommitment, type FoldCtx, type FoldRecord, type FoldRefusal,
  type FoldScope,
} from "./fold.js";
import { parseScopeId, scopeIdOf, TOWN_YARD_ID, type ScopeId } from "./scope.js";

// ---------------------------------------------------------------------------
// Signals — the model's whole input
// ---------------------------------------------------------------------------

/** ONE town's per-commodity scarcity view (③'s TownGrowthSignals.shortage
 *  shape): 0 = plenty, 1 = starving for it. The host supplies real books
 *  (townShortage) or the stub proxy below. */
export interface BarterSignals {
  shortage(good: string): number;
}

/** Scarcity weight in a good's pair-worth (worth = 1 + W·(us + them)). */
export const BARTER_SCARCITY_WEIGHT = 1;
/** Ratio clamp — no deal goes infinite/free, and every quote stays inside
 *  the speakable quantity words (one/two/three per side). */
export const BARTER_RATIO_CAP = 3;
// `BARTER_WANT_MIN` ("below this a town doesn't WANT a good") is re-exported
// from complementary.ts at the top of this file — the derived-trade read and
// the willingness refusal are the SAME line, declared once.
/** At/above this, a town won't PART with a good (its own famine). */
export const BARTER_FAMINE_MAX = 0.7;
/**
 * Travel time of one shipment leg, as a fraction of a street day — the
 * caravan is on the road before goods land (FOOD_DAY_SEC × this).
 *
 * ⚖️ DEMOTED (scope-behaviors.md §2.7: "what the town's own EXCHANGE lacks —
 * distance-blind quotes, the FLAT `BARTER_LEG_DAY_FRAC` leg time — is §2.2's
 * pricing, not new exchange logic"). This is no longer the leg: it is the leg
 * of a partner with NO GEOMETRY, and the floor under every other leg. See
 * `barterLegSeconds`.
 *
 * ⚖️ MERGED INTO THE GENERIC TRANSACTION-PACING SEAT (user law, 2026-08-13 —
 * scale.ts `transactionDayFrac`'s own doc comment carries the law verbatim
 * and the reasoning for why the value belongs to the transaction and its
 * parties, not the clock). This is no longer an independent literal: it is
 * `transactionDayFrac({ kind: "shipment-leg" })`, read once at module load,
 * bit-identical to the `0.35` this constant has always held — a standing
 * barter route's shipment leg is ONE transaction kind the seat now names,
 * trade.ts's caravan visit budget is the other.
 */
export const BARTER_LEG_DAY_FRAC = transactionDayFrac({ kind: "shipment-leg" });

/**
 * ⚖️ HOW LONG ONE SHIPMENT LEG TAKES — `journeyS` at caravan scale.
 *
 * `distanceM / dailyTravelM(scale)` is travel DAYS (the region rung's own
 * function: gait × the waking day), and a day is `scale.dayLengthS` of clock.
 * So a 3 km partner's caravan is visibly longer on the road than a 300 m one's,
 * which is precisely what "a partner 3 km away and one next door quote
 * identically" (§2.2) was the complaint about.
 *
 * A partner with NO REAL GEOMETRY — the abstract `away:<seed>` line, a
 * flight-tier `city:<cell>` stub — passes `null` and gets the old flat
 * `BARTER_LEG_DAY_FRAC` day, unchanged: a stub's distance is a fiction, and
 * pricing a fiction is worse than admitting we don't know. That same constant
 * floors every real leg too, so nobody's caravan teleports.
 */
export function barterLegSeconds(
  scale: WorldScale,
  distanceM: number | null | undefined,
  dayS: number = FOOD_DAY_SEC,
): number {
  const flat = dayS * BARTER_LEG_DAY_FRAC;
  if (distanceM === null || distanceM === undefined || !Number.isFinite(distanceM)) return flat;
  const perDay = dailyTravelM(scale);
  if (!(perDay > 0)) return flat;
  return Math.max(flat, (Math.max(0, distanceM) / perDay) * scale.dayLengthS);
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** A good's worth WITHIN one town pair: 1 + W·(our shortage + theirs).
 *  Pair-symmetric by construction — swap `us`/`them` and nothing moves. */
export function barterWorth(good: string, us: BarterSignals, them: BarterSignals): number {
  return (
    1 + BARTER_SCARCITY_WEIGHT * (clamp01(us.shortage(good)) + clamp01(them.shortage(good)))
  );
}

/**
 * The exchange RATIO: take-units one give-unit buys, from OUR perspective.
 * worth(give)/worth(take), clamped to [1/CAP, CAP]. Perspective-consistent:
 * barterRatio(t, g, them, us) === 1 / barterRatio(g, t, us, them) exactly
 * (worth is pair-symmetric and the clamp bounds are reciprocal).
 */
export function barterRatio(
  give: string,
  take: string,
  us: BarterSignals,
  them: BarterSignals,
): number {
  const r = barterWorth(give, us, them) / barterWorth(take, us, them);
  return Math.max(1 / BARTER_RATIO_CAP, Math.min(BARTER_RATIO_CAP, r));
}

/**
 * The SPOKEN QUOTE: the ratio as a small integer pair — `give` units of the
 * give-good for `take` units of the take-good, both within the speakable
 * quantity words (1..3). Deterministic: the pair minimizing |take/give − r|,
 * ties toward the SMALLER batch (give+take), then the smaller give.
 */
export function barterQuote(
  give: string,
  take: string,
  us: BarterSignals,
  them: BarterSignals,
): { give: number; take: number; ratio: number } {
  const r = barterRatio(give, take, us, them);
  let best = { give: 1, take: 1 };
  let bestErr = Infinity;
  for (let g = 1; g <= 3; g++) {
    for (let t = 1; t <= 3; t++) {
      const err = Math.abs(t / g - r);
      const better =
        err < bestErr - 1e-12 ||
        (Math.abs(err - bestErr) <= 1e-12 &&
          (g + t < best.give + best.take ||
            (g + t === best.give + best.take && g < best.give)));
      if (better) {
        best = { give: g, take: t };
        bestErr = err;
      }
    }
  }
  return { ...best, ratio: r };
}

// ---------------------------------------------------------------------------
// Willingness — the partner accepts only when the deal relieves ITS needs
// ---------------------------------------------------------------------------

export type BarterRefusal = "has-enough" | "wont-part" | "we-wont-part";

/**
 * ⚖️ G1 — HOW MUCH OF A GOOD WE MAY SPARE, as a fraction of what we hold: the
 * famine refusal below, read as a SLOPE instead of a wall.
 *
 *   spare = clamp01((BARTER_FAMINE_MAX − ourShortage) / BARTER_FAMINE_MAX)
 *
 * 1 while we are fed, 0 exactly AT the famine gate, linear between — so the
 * approach to a suspension is continuous and a route thins before it stops.
 * The gate itself is unchanged: at/above `BARTER_FAMINE_MAX` this is 0 AND
 * `barterWillingness` refuses, which is the same fact said twice on purpose
 * (a volume the willingness disagreed with would be the old free lunch back
 * in a new place).
 *
 * `ourShortage = 0` returns EXACTLY 1 (x/x in IEEE-754), so a fed town's
 * shipment arithmetic is bit-for-bit what it was before this existed.
 *
 * The want-side twin, one gate up, is complementary.ts's `exportSpareScale` —
 * identical formula over `BARTER_WANT_MIN`. One shape, two gates.
 */
export function barterSpareFraction(ourShortage: number): number {
  return clamp01((BARTER_FAMINE_MAX - clamp01(ourShortage)) / BARTER_FAMINE_MAX);
}

/** ⚖️ G1 — UNITS OF `good` A STACK MAY SPARE at our own shortage of it: the
 *  stock above the local-need reserve the famine law implies. `runDueBarters`
 *  bounds every batch by THIS, never by raw `stackUnits` — a town in famine
 *  shipping its last grain was the trade tier's largest free lunch. */
export function barterSpareUnits(
  stack: Record<string, number>,
  good: string,
  ourShortage: number,
): number {
  return stackUnits(stack, good) * barterSpareFraction(ourShortage);
}

/**
 * Would this deal happen? Derived from the same signals the ratio reads: the
 * partner must WANT what we give more than what it gives up, and NEITHER side
 * may be starving for what it is being asked to hand over.
 *   • their famine on the take-good refuses "wont-part"
 *     ("they won't part with food") — checked first: famine dominates.
 *   • ⚖️ G1 THE MIRROR: OUR famine on the give-good refuses "we-wont-part",
 *     by the same constant and the same comparison. The reading used to be
 *     `void us` — "the partner judges by ITS OWN books alone" — which made
 *     the law one-sided: their famine suspended a route, ours shipped the
 *     last of the harvest. Symmetry is the pin: swap (give, us) with
 *     (take, them) and the famine half of this predicate is unchanged.
 *     The REASON is not swapped, because the player must be told WHO
 *     refused; a shared "wont-part" would have every toast blaming the
 *     neighbour for our own hunger.
 *   • too little need for the give-good — or no more need for it than for
 *     what it surrenders — refuses "has-enough" ("they have enough wood").
 * Our ability to COVER the give-goods is still the caller's stock check —
 * how full our shelves are is a different question from whether we dare
 * empty them.
 */
export function barterWillingness(
  give: string,
  take: string,
  us: BarterSignals,
  them: BarterSignals,
): { ok: true } | { ok: false; reason: BarterRefusal } {
  const wantGive = clamp01(them.shortage(give));
  const partTake = clamp01(them.shortage(take));
  if (partTake >= BARTER_FAMINE_MAX) return { ok: false, reason: "wont-part" };
  if (clamp01(us.shortage(give)) >= BARTER_FAMINE_MAX) {
    return { ok: false, reason: "we-wont-part" };
  }
  if (wantGive < BARTER_WANT_MIN || wantGive <= partTake) {
    return { ok: false, reason: "has-enough" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Stub partner signals — the closed-form proxy for an unsimulated neighbor
// ---------------------------------------------------------------------------

function fnv(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Days of one full stub-scarcity season (terms drift over ~weeks). */
export const STUB_SEASON_DAYS = 16;

// ─── GEOGRAPHY CHOOSES WHAT A DISTANT TOWN HAS TO SELL (R&T ⑤, T5) ──────────
//
// The hash base above is honest but BLIND: it makes a river-mouth granary as
// likely to be starving as a mining camp is. "Geography chooses, spec marks"
// (node-typing.ts) already decided what each settlement IS — this extends that
// same verdict to what it can spare. The reading stays a PURE function of
// (partnerKey, good, day, geography): no books, no session, no clock.
//
// The hash never leaves: where geography has no opinion about a good it is the
// whole base (byte-identical to the shipped proxy), and where geography DOES
// speak the hash still supplies the per-good texture, so two food-ish goods in
// one town are never numerically identical.

/**
 * The compact terrain reading a partner can carry — every field optional,
 * because a partner that declares none is exactly the shipped stub.
 * Whatever the tier knows, it passes; whatever it doesn't, the hash covers.
 */
export interface PartnerGeography {
  /** The economic node its terrain makes it (kernel/cells node-typing). */
  node?: NodeType | null;
  /** Charter-box FARMLAND sum, as `PlanetCity.charter.farmland` holds it. */
  farmland?: number;
  /** Charter-box ORE sum (`PlanetCity.charter.ore_access`). */
  ore?: number;
}

/** The farmland sum at which a charter box is SURPLUS COUNTRY — node-typing's
 *  own `surplusFarmland` line, so the continuous reading and the taxon that
 *  was derived from it agree instead of drifting apart. */
export const GEO_FARMLAND_REF = 180;
/** The ore sum at which the ground is worth traveling for — node-typing's
 *  `extractionOre` line, same reason. */
export const GEO_ORE_REF = 50;
/** How loudly geography speaks over the hash where it has an opinion at all
 *  (the remainder stays the hash's per-good texture). */
export const GEO_BASE_WEIGHT = 0.75;

/**
 * The three FREIGHT classes geography has an opinion about — derived from the
 * good's own freight row, never from its name (freight.ts's law, honored one
 * rung up): the staple is the good the hauler eats, raw bulk is what barely
 * repays its own haul, refined is what a workshop's work concentrated. A good
 * in none of them (a plain durable at the staple anchor — an undeclared good)
 * gets no geographic opinion, which is the honest answer.
 */
export type GeoGoodClass = "staple" | "rawBulk" | "refined";

export function geoGoodClass(good: string): GeoGoodClass | null {
  const f = freightOf(good);
  if (f.transit === "selfConsuming") return "staple";
  if (f.valueDensity >= VALUE_TIER.refined) return "refined";
  if (f.valueDensity < VALUE_TIER.staple) return "rawBulk";
  return null;
}

/**
 * PER-NODE SHORTAGE BASES — one row per taxon, read straight off the sentence
 * node-typing prints for it:
 *   • `surplus` "grows more here than its farmers can eat" ⇒ food to sell, and
 *     no workshop of its own ⇒ it wants refined goods.
 *   • `shadow` is surplus country that CANNOT ship its grain — food cheap,
 *     manufactures desperately wanted (that lack is the refining license).
 *   • `extraction` "yields what the lowlands lack" ⇒ raw bulk to sell; mine
 *     country does not farm, so its own food runs thin.
 *   • `mouth`/`anchorage`/`junction`/`chokepoint` are TRAFFIC nodes: everything
 *     passes over their quays, so nothing is desperate — mildest at the mouth,
 *     where both a river and a sea deliver.
 * A blank cell = no opinion for that class (the hash keeps it).
 */
const NODE_SHORTAGE_BASES: Record<NodeType, Partial<Record<GeoGoodClass, number>>> = {
  mouth: { staple: 0.25, rawBulk: 0.35, refined: 0.35 },
  anchorage: { staple: 0.35, rawBulk: 0.4, refined: 0.4 },
  chokepoint: { staple: 0.4, rawBulk: 0.45, refined: 0.45 },
  junction: { staple: 0.35, rawBulk: 0.4, refined: 0.4 },
  extraction: { staple: 0.7, rawBulk: 0.1, refined: 0.55 },
  surplus: { staple: 0.15, refined: 0.6 },
  shadow: { staple: 0.2, refined: 0.85 },
};

/**
 * ⚖️ THE GEOGRAPHY TERM — the standing shortage base a partner's TERRAIN
 * implies for one good, or null when its terrain says nothing about that good
 * (⇒ the caller keeps the hash). Pure, side-effect free, and independent of
 * the day: the season rides on top of whatever this returns.
 *
 * Where both the taxon and a continuous charter reading speak, they are
 * AVERAGED — the taxon is a threshold verdict off the very sums the charter
 * carries, so the two are the same evidence at two resolutions, and averaging
 * lets a barely-surplus box read differently from a drowning-in-grain one.
 */
export function geographyShortageBase(good: string, geo: PartnerGeography): number | null {
  const cls = geoGoodClass(good);
  if (!cls) return null;
  const reads: number[] = [];
  const byNode = geo.node ? NODE_SHORTAGE_BASES[geo.node]?.[cls] : undefined;
  if (byNode !== undefined) reads.push(byNode);
  if (cls === "staple" && typeof geo.farmland === "number" && Number.isFinite(geo.farmland)) {
    reads.push(clamp01(1 - Math.max(0, geo.farmland) / GEO_FARMLAND_REF));
  }
  if (cls === "rawBulk" && typeof geo.ore === "number" && Number.isFinite(geo.ore)) {
    reads.push(clamp01(1 - Math.max(0, geo.ore) / GEO_ORE_REF));
  }
  if (!reads.length) return null;
  return clamp01(reads.reduce((a, b) => a + b, 0) / reads.length);
}

/**
 * Scarcity proxy for a partner that ISN'T fully simulated (the abstract
 * `away:<seed>` line, a flight-tier `city:<cell>`): a BASE per (partner, good)
 * plus a slow TRIANGULAR season over the town day — pure
 * f(partnerKey, good, day, geography), so replays and both ends of a call
 * agree, and the terms a player hears SHIFT over time even against a stub.
 *
 * The base is the partner's terrain where it has an opinion (T5 —
 * `geographyShortageBase`, blended with the hash for texture) and the bare
 * hash where it doesn't. `geo` ABSENT ⇒ the hash alone, bit for bit as it
 * shipped: a tier that knows nothing about its neighbour must not be made to
 * pretend it does.
 */
export function stubPartnerSignals(
  partnerKey: string,
  day: number,
  geo?: PartnerGeography | null,
): BarterSignals {
  return {
    shortage(good: string): number {
      const h = fnv(`${partnerKey}|${good}`);
      const hash = ((h >>> 8) % 1000) / 1000; // 0..1 — the partner's standing bias
      const terrain = geo ? geographyShortageBase(good, geo) : null;
      const base =
        terrain === null ? hash : clamp01(GEO_BASE_WEIGHT * terrain + (1 - GEO_BASE_WEIGHT) * hash);
      const phase = (h % STUB_SEASON_DAYS) / STUB_SEASON_DAYS;
      const u = (day / STUB_SEASON_DAYS + phase) % 1;
      const tri = u < 0.5 ? u * 2 : 2 - u * 2; // 0→1→0 across a season
      return clamp01(base * 0.55 + tri * 0.45);
    },
  };
}

// ---------------------------------------------------------------------------
// ⏸️ DERIVED WAKES — when will this partner say yes? (scope-behaviors.md §2.5.1)
// ---------------------------------------------------------------------------
//
// The chapter, on the barter re-arm: "the DERIVED WAKE is already sitting there
// and is the honest version of `BARTER_RETRY_SEC`: the partner's own goods
// clock says when its famine lifts, so the day-timer becomes
// `nextShortageBelow(partner, takeGood, threshold)` off the same closed form
// the quote read."
//
// THE GRID, stated once for both samplers below. A stub partner's shortage is
// `stubPartnerSignals`: a hash base plus a triangular season of
// STUB_SEASON_DAYS. That is a pure function of the DAY, with no closed inverse
// (a clamped triangle), so it is SAMPLED FORWARD on the DAY grid — the same
// discipline `shelfRestockAt` uses on the market shelf, and the same honesty:
// evaluated once, at park time, from the very formula the refusal read. The
// horizon is ONE FULL SEASON, because the season IS the closed form's period —
// a shortage that does not clear inside one has no derived wake at all, and
// the park's `staleAt` backstop takes over. Real partners (live town books) are
// not closed forms and return null by construction: an honest "no derived
// wake", never an invented one.
//
// Both return a fractional DAY (the caller multiplies by its own day length),
// or null for "not inside the horizon".

/** Sample days `from + 1 … from + horizon` at one-day resolution. */
function forwardDays(fromDay: number, horizonDays: number): number[] {
  const out: number[] = [];
  const n = Math.max(0, Math.floor(horizonDays));
  for (let i = 1; i <= n; i++) out.push(Math.floor(fromDay) + i);
  return out;
}

/**
 * ⏸️ WHEN DOES THIS PARTNER'S SHORTAGE OF `good` FALL BELOW `threshold`? — the
 * derived wake for a `wont-part` refusal ("they won't part with food"), whose
 * whole content is `shortage(take) ≥ BARTER_FAMINE_MAX`. The answer is when
 * their famine lifts, which their own goods clock knows.
 */
export function nextShortageBelow(
  signalsAtDay: (day: number) => BarterSignals,
  good: string,
  threshold: number,
  fromDay: number,
  horizonDays: number = STUB_SEASON_DAYS,
): number | null {
  for (const d of forwardDays(fromDay, horizonDays)) {
    if (clamp01(signalsAtDay(d).shortage(good)) < threshold) return d;
  }
  return null;
}

/**
 * ⏸️ WHEN WOULD THIS PARTNER TAKE THE DEAL? — the general form, and the one a
 * `has-enough` refusal needs (`wantGive < BARTER_WANT_MIN || wantGive ≤
 * partTake` is a statement about TWO of their shortages at once). Evaluates the
 * REAL predicate — `barterWillingness` itself — forward on the same grid, so
 * the wake can never disagree with the refusal that produced it.
 *
 * ⚖️ G1: `us` is held FIXED across the sample (our own books are a live sim,
 * not a closed form), so a `we-wont-part` refusal correctly yields NO derived
 * wake here — the honest answer, and the park's backstop carries it.
 */
export function nextBarterWillingAt(
  give: string,
  take: string,
  us: BarterSignals,
  signalsAtDay: (day: number) => BarterSignals,
  fromDay: number,
  horizonDays: number = STUB_SEASON_DAYS,
): number | null {
  for (const d of forwardDays(fromDay, horizonDays)) {
    if (barterWillingness(give, take, us, signalsAtDay(d)).ok) return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// ⚖️ IMPORT DISPLACEMENT — the lane fades when our own ground covers it
// ---------------------------------------------------------------------------
//
// (import-displacement-round.md Stage C — the arc's last beat, "expensive
// import → local planting → import dies".) The binding model is #47's Layer-3
// law: LANDED COST = min(local production cost, producer + freight). At this
// rung there is no money and quantity is the whole story, so the min() reads
// as a comparison of RATES — when the town's own ground bears at least as much
// of the take-good per day as the standing agreement hauls in per day, local
// wins the min() and the import has nothing left to do.
//
// 🚨 GLYPH-SPECIFIC SUPPLY, NEVER A WANT. The cheap version — "park the route
// when our shortage of the take-good is low" — kills a banana agreement on its
// FIRST due leg: a fruit glyph has no fill row, so the books answer shortage 0
// for it and every fruit lane reads as unwanted before a seed is in the
// ground. A SUPPLY reading cannot lie that way. A stand that does not stand
// bears nothing (`localYieldPerDay` is Σ cap, and Stage A made a sapling
// orchard's cap 0), so this can never fire before the orchard does.
//
// 🚨 THE PAUSE BIT IS THE ONE THAT ALREADY EXISTS. A displaced route rides
// `BarterTerms.suspended` exactly as a famine-refused one does — same flag,
// same edge-gated narration, same `resumed` leg when it clears — so NOTHING
// NEW IS SERIALIZED and every save round-trips byte for byte. What the row
// deliberately does not carry is the REASON: which rows are currently
// displaced is the caller's own session-lived state (`RunBartersOpts.
// displaced`), re-derived after a reload rather than stored, exactly as
// `TownPark` is. The reason is what gates the fade line, so the displacement
// EDGE is its own edge and not the shared bit's.

/**
 * PARK AT PARITY. Coverage = our units/day ÷ the lane's units/day; at 1 the
 * ground already answers the whole standing order, which is precisely where
 * min() stops naming the caravan.
 */
export const BARTER_DISPLACE_AT = 1;
/**
 * RESUME BELOW THREE QUARTERS — the hysteresis band, and why there is one.
 * BOTH rates move on their own: a stand climbs a growth class, and the quote
 * is RE-DERIVED every leg off shifting scarcities, so the take can change by a
 * whole unit between visits (the speakable pair is 1..3 a side — a one-unit
 * step is a 33%–50% swing in the flow). A bare 1.0 read from both directions
 * would flip a lane park→resume→park across that wobble and spend one toast
 * per flip. A quarter of the flow is wider than any single-unit quote step at
 * this tier's batch sizes, so a parked lane stays parked until the ground has
 * REALLY lost the argument — an orchard chopped, not an orchard breathing.
 */
export const BARTER_DISPLACE_RESUME_AT = 0.75;

/**
 * IMPORTED UNITS PER DAY — the agreement's own flow, the right-hand side of
 * the min(). Every degenerate reading answers 0 ("no measurable import"),
 * which makes displacement IMPOSSIBLE rather than certain: a rate nobody can
 * read is never grounds for killing a lane.
 */
export function importedFlowPerDay(takeUnitsPerVisit: number, visitPeriodDays: number): number {
  if (!Number.isFinite(takeUnitsPerVisit) || !Number.isFinite(visitPeriodDays)) return 0;
  if (!(takeUnitsPerVisit > 0) || !(visitPeriodDays > 0)) return 0;
  return takeUnitsPerVisit / visitPeriodDays;
}

/**
 * ⚖️ THE DECISION: does what grows here cover what the caravan brings?
 *
 * DUMB BY DESIGN — both rates are the caller's to supply, in the SAME units
 * (units of the take-good's own glyph head, per day). This function knows
 * nothing about stands, glyphs, records or towns; it is the min() and the
 * hysteresis and nothing else, which is why it can be pinned outright.
 *
 * `alreadyDisplaced` is the state the band needs: a lane not yet displaced
 * must reach `BARTER_DISPLACE_AT` to park, and one already displaced holds
 * until coverage falls under `BARTER_DISPLACE_RESUME_AT`.
 *
 * 🚨 GROUND THAT BEARS NOTHING — or a supply reading nobody can read — IS
 * ALWAYS FALSE, before anything else is asked. The never-before-the-orchard
 * law, stated in code rather than trusted to arithmetic (a 0-flow lane would
 * otherwise satisfy 0 ≥ 0), and the same conservatism `importedFlowPerDay`
 * applies to its own side: an unreadable rate is never evidence that the
 * caravan has become redundant.
 */
export function localSupplyDisplaces(
  localPerDay: number,
  takeUnitsPerVisit: number,
  visitPeriodDays: number,
  alreadyDisplaced = false,
): boolean {
  if (!Number.isFinite(localPerDay) || !(localPerDay > 0)) return false;
  const flow = importedFlowPerDay(takeUnitsPerVisit, visitPeriodDays);
  if (!(flow > 0)) return false; // nothing arrives ⇒ nothing to displace
  const coverage = localPerDay / flow;
  return coverage >= (alreadyDisplaced ? BARTER_DISPLACE_RESUME_AT : BARTER_DISPLACE_AT);
}

/**
 * ⚖️ THE SUPPLY SIDE, HEAD-MATCHED — units/day of ONE take-good out of a
 * glyph→units/day reading of some ground (`localYieldPerDay`'s shape, which is
 * the interaction rung's to produce; this rung only projects it).
 *
 * 🚨 THE HEAD, NOT THE GOOD KEY. A barter take is a SPOKEN GLYPH ("banana"),
 * and local bananas displace a banana lane — never an apple one. Matching on
 * the commodity key instead would let a carrot field kill a banana caravan on
 * nothing but a shared class ("both are food"), which is exactly the
 * coincidence this projection refuses. `stackHead` is the ONE extractor, so
 * "apple.ripe" on the ground answers an "apple" lane and nothing else does.
 */
export function localSupplyAtHead(
  perGlyphPerDay: Readonly<Record<string, number>>,
  takeGood: string,
): number {
  const head = stackHead(takeGood);
  if (!head) return 0;
  let units = 0;
  for (const [glyph, n] of Object.entries(perGlyphPerDay)) {
    if (n > 0 && stackHead(glyph) === head) units += n;
  }
  return units;
}

/**
 * HOW MANY QUOTE BATCHES ONE VISIT INTENDS at `quote`, before any stock bound
 * — `runDueBarters`'s own line, extracted so the flow reader above and the
 * shipment below can never disagree about how big a visit is. A STANDING
 * route's intent is "keep trading", so it flexes to at least one batch when
 * re-derived terms outgrow the ordered units; a one-shot keeps its strict
 * order. A quote with no give side is not a quote — 0 batches.
 */
export function barterWantBatches(
  a: TransferAgreement,
  quote: { give: number; take: number },
): number {
  if (!(quote.give > 0)) return 0;
  const ordered = Math.max(0, Math.floor(a.goods[a.barter?.giveGood ?? ""] ?? 0));
  return a.every !== undefined
    ? Math.max(1, Math.floor(ordered / quote.give))
    : Math.floor(ordered / quote.give);
}

/** UNITS OF THE TAKE-GOOD ONE VISIT BRINGS at `quote` — the numerator of the
 *  lane's flow. The INTENDED load, not the last one shipped: `BarterTerms.take`
 *  is history (what a stock-bounded leg happened to manage), and a lane is
 *  displaced by what it is FOR. */
export function barterTakePerVisit(
  a: TransferAgreement,
  quote: { give: number; take: number },
): number {
  return barterWantBatches(a, quote) * Math.max(0, quote.take);
}

/**
 * DAYS BETWEEN VISITS — `runDueBarters`'s own `advanceLeg` arithmetic read as
 * a period: the recurrence the player ordered, or the road, whichever is
 * longer. A ONE-SHOT has no recurrence and its period is the road alone; where
 * the caller supplies no road either the period is 0, and `importedFlowPerDay`
 * reads that as "no measurable import" — so a kernel-only caller (no
 * `legSecondsOf`) never displaces a one-shot, which is the honest answer.
 *
 * `dayS` defaults to `FOOD_DAY_SEC` because that is the day BOTH sides of the
 * comparison are already denominated in: a standing route's `every` is
 * FOOD_DAY_SEC and the host ripens a stand on one FOOD_DAY_SEC pulse (which is
 * what makes `localYieldPerDay`'s cap a per-DAY rate).
 */
export function barterVisitPeriodDays(
  a: TransferAgreement,
  legSeconds: number | undefined,
  dayS: number = FOOD_DAY_SEC,
): number {
  if (!(dayS > 0)) return 0;
  const every = a.every !== undefined && Number.isFinite(a.every) ? Math.max(0, a.every) : 0;
  const leg = legSeconds !== undefined && Number.isFinite(legSeconds) ? Math.max(0, legSeconds) : 0;
  return Math.max(every, leg) / dayS;
}

// ---------------------------------------------------------------------------
// The scheduled executor — shipments both ways, terms re-derived per leg
// ---------------------------------------------------------------------------

export type BarterLegStatus =
  | "shipped" // goods moved both ways at the re-derived terms
  | "suspended" // the partner refused this shipment (standing: retry next leg)
  | "resumed" // it had been suspended; this leg shipped again
  | "short" // OUR side can't cover one quote batch right now
  | "displaced"; // ⚖️ our own ground now covers the take — the lane fades

/** Every named reason a due leg did not ship: the partner's three refusals,
 *  our own empty yard, and our own ground having outgrown the lane. */
export type BarterStall = BarterRefusal | "short" | "displaced";

export interface BarterLegReport {
  id: string;
  partnerKey: string;
  status: BarterLegStatus;
  /** Refusal reason when suspended (named — never a silent rot). */
  reason?: BarterRefusal;
  /** True on the suspension EDGE (this leg is what paused the route) —
   *  the caller's toast gate, so a long famine nags only once. */
  newlySuspended?: boolean;
  /** What left us / what came back (empty maps unless "shipped"/"resumed"). */
  sent: Record<string, number>;
  received: Record<string, number>;
  /** The terms THIS leg ran at (re-derived — they shift with scarcity). */
  quote: { give: number; take: number };
}

export interface RunBartersOpts {
  /** OUR town's live scarcity signals. */
  us: BarterSignals;
  /** A partner's signals by key — real books for a simulated neighbor,
   *  stubPartnerSignals for an abstract one. Null fails the row NAMED. */
  themOf(partnerKey: string): BarterSignals | null;
  /** ⚖️ Seconds one shipment leg takes for this partner (`barterLegSeconds`
   *  over its real geometry). Absent ⇒ the row's own `every` alone paces it,
   *  which is the shipped behaviour. A STANDING route re-derives this PER LEG
   *  — a partner that moved (bindPartner) re-prices its road. */
  legSecondsOf?(partnerKey: string): number;
  /** ⏸️ IS THIS ROW PARKED? Asked BEFORE the terms are re-derived, exactly as
   *  `decideNeeds` asks `parked(tpl)` before `ctxOf(tpl)` — the park exists to
   *  skip work, and re-quoting a deal nobody will take is the work. Only
   *  ONE-SHOT rows are ever parked (a standing route's own `every` IS its
   *  wait; §2.5.1 sentences `reArmOneShot` alone). */
  parked?(a: TransferAgreement): boolean;
  /** ⏸️ PARK a stalled one-shot on the condition that stalled it. Return true
   *  when the host took ownership of the wait — the row then stays DUE and is
   *  skipped by `parked` until its wake fires, instead of being pushed a flat
   *  `BARTER_RETRY_SEC` into the future. False/absent ⇒ `reArmOneShot`, the
   *  shipped day-timer, unchanged. */
  park?(a: TransferAgreement, why: BarterStall): boolean;
  /** ⚖️ IMPORT DISPLACEMENT — UNITS PER DAY OF THIS ROW'S TAKE-GOOD THAT OUR
   *  OWN GROUND BEARS, head-matched (`localYieldPerDay` summed over the glyphs
   *  whose head is the take's). The kernel cannot read ground: only the host
   *  knows which record is this town's field, and the FIELD-RECORD-ONLY ruling
   *  (Stage B) says it is the only record that may answer. ABSENT ⇒ no
   *  displacement check runs at all, which is every kernel-only caller and
   *  every world with nothing sown. */
  localSupplyPerDay?(a: TransferAgreement): number;
  /** ⚖️ IS THIS ROW ALREADY PARKED FOR DISPLACEMENT? — the hysteresis band's
   *  one bit of state, held by the caller because it is SESSION-LIVED and
   *  never serialized (the `TownPark` precedent: a lost park costs one wasted
   *  leg, a persisted stale one would silence a live lane). It is also what
   *  gates the fade line: the report's `newlySuspended` on a `displaced` leg
   *  is the DISPLACEMENT edge, read off this, not off the shared pause bit.
   *  Supply it whenever `localSupplyPerDay` is supplied. */
  displaced?(a: TransferAgreement): boolean;
}

/**
 * Run every DUE barter agreement once (creation order — deterministic given
 * the clock and the mutation record). Per shipment:
 *   1. RE-DERIVE the quote from the CURRENT signals (terms shift over time)
 *      and rewrite the row's barter terms — the agreement always shows what
 *      the next shipment will actually run at.
 *   2. RE-CHECK the partner's willingness: a refusal SUSPENDS the leg
 *      (standing routes retry next period, visibly; one-shots wait too —
 *      the caravan simply doesn't go). Acceptance after a suspension
 *      reports "resumed".
 *   3. SHIP in whole quote batches, bounded by our SPARE (⚖️ G1 — the stock
 *      above the reserve our own famine law implies, never the raw shelf),
 *      the ordered amount, AND the partner's own shelf (a real partner can
 *      run short) — goods move BOTH WAYS via transferStock.
 * One-shots complete after their shipment; standing rows advance their
 * clock. Endpoints the resolver can't produce fail the row NAMED.
 */
export function runDueBarters(
  ledger: TransferLedger,
  resolve: (id: string) => StockEndpoint | null,
  now: number,
  opts: RunBartersOpts,
): BarterLegReport[] {
  const out: BarterLegReport[] = [];
  /** ⚖️ A STANDING route's clock, re-derived per leg: the recurrence the player
   *  ordered, or the road, whichever is longer. You cannot have a daily caravan
   *  from eight days away, and pretending otherwise is exactly the
   *  distance-blindness §2.2 sentences. A stub partner's leg is the flat
   *  fraction of a day, which is shorter than any `every` a route carries — so
   *  stub pacing is untouched. */
  const advanceLeg = (a: TransferAgreement, partnerKey: string): void => {
    ledger.advance(a.id, now);
    const legS = opts.legSecondsOf?.(partnerKey);
    if (legS !== undefined && legS > (a.every ?? 0)) a.nextDueAt = now + legS;
  };
  for (const a of ledger.due(now)) {
    const b = a.barter;
    if (!b) continue; // plain rows belong to runDueTransfers
    // ⏸️ PARKED ROWS ARE SKIPPED BEFORE ANY WORK — the park's whole point.
    if (a.every === undefined && opts.parked?.(a)) continue;
    const us = resolve(a.from);
    const them = resolve(a.to);
    const themSig = opts.themOf(b.partnerKey);
    if (!us || !them || !themSig) {
      ledger.fail(a.id, "no-endpoint");
      continue;
    }
    // 1. Terms re-derive off the CURRENT books — the row shows live terms.
    const q = barterQuote(b.giveGood, b.takeGood, opts.us, themSig);
    const quote = { give: q.give, take: q.take };
    b.quote = quote;
    // A stalled leg retries next period: standing rows through their own
    // clock; one-shots WAIT visibly instead of rotting — PARKED on the
    // condition that stalled them where the host offers a park (§2.5.1),
    // re-armed a flat day out where it doesn't.
    const retryLeg = (why: BarterStall) => {
      if (a.every !== undefined) {
        advanceLeg(a, b.partnerKey);
        return;
      }
      // The park OWNS the wait: the row stays due and `parked` skips it until
      // the partner's own goods clock (or an epoch, or the backstop) says the
      // answer can have changed. `BARTER_RETRY_SEC` survives as that backstop.
      if (opts.park?.(a, why)) {
        a.nextDueAt = now;
        return;
      }
      reArmOneShot(a, now);
    };
    // 1b. ⚖️ IMPORT DISPLACEMENT — asked BEFORE willingness, and the ORDER IS
    //     THE PRECEDENCE. A refusal is a statement about THIS LEG (their
    //     famine lifts, the caravan goes); displacement is a statement about
    //     the LANE (we grow it now, and nothing the partner does changes
    //     that), so when both apply the durable fact is the one the player is
    //     told. It sits after the re-derive so a displaced row still SHOWS the
    //     terms its next shipment would run at, and it can never move a
    //     shipped world: with nothing sown `localSupplyPerDay` is 0 and this
    //     whole arm is skipped.
    if (opts.localSupplyPerDay) {
      const wasDisplaced = opts.displaced?.(a) === true;
      const perVisit = barterTakePerVisit(a, quote);
      const periodDays = barterVisitPeriodDays(a, opts.legSecondsOf?.(b.partnerKey));
      if (localSupplyDisplaces(opts.localSupplyPerDay(a), perVisit, periodDays, wasDisplaced)) {
        // The ONE pause bit, shared with every other pause (see the section
        // header) — but the EDGE is the displacement edge, so the fade line
        // still speaks for a lane that was already paused for some other
        // reason when the orchard came in.
        b.suspended = true;
        out.push({
          id: a.id,
          partnerKey: b.partnerKey,
          status: "displaced",
          newlySuspended: !wasDisplaced,
          sent: {},
          received: {},
          quote,
        });
        retryLeg("displaced");
        continue;
      }
    }
    // 2. Willingness re-checks per shipment — famine suspends, visibly.
    const will = barterWillingness(b.giveGood, b.takeGood, opts.us, themSig);
    if (!will.ok) {
      const newly = b.suspended !== true;
      b.suspended = true;
      out.push({
        id: a.id,
        partnerKey: b.partnerKey,
        status: "suspended",
        reason: will.reason,
        newlySuspended: newly,
        sent: {},
        received: {},
        quote,
      });
      retryLeg(will.reason);
      continue;
    }
    const resumed = b.suspended === true;
    // 3. Whole batches only — the spoken terms are the executed terms. A
    //    STANDING route's intent is "keep trading" — its daily volume flexes
    //    to at least one batch when re-derived terms outgrow the ordered
    //    units (a one-shot keeps its strict order). ⚖️ ONE OWNER: the same
    //    `barterWantBatches` the displacement flow reader above measures a
    //    visit with, so "how big is a visit" cannot be answered two ways.
    const wantBatches = barterWantBatches(a, quote);
    //    ⚖️ G1: OUR bound is the SPARE, not the shelf. `stackUnits` counted
    //    every unit in the yard as shippable, so a hungry town emptied itself
    //    on a standing route while the SAME famine on the partner's side
    //    suspended one — the two trade paths disagreed about whether a town
    //    may starve itself, and only the ungated one moved stock. At shortage
    //    0 the fraction is exactly 1 and this line is the shipped one.
    const batches = Math.min(
      wantBatches,
      Math.floor(barterSpareUnits(us.stack, b.giveGood, opts.us.shortage(b.giveGood)) / quote.give),
      Math.floor(stackUnits(them.stack, b.takeGood) / quote.take),
    );
    if (batches <= 0) {
      // A stock stall pauses the route VISIBLY too (the suspended flag is
      // the one pause bit — the next successful leg reports "resumed").
      const newly = b.suspended !== true;
      b.suspended = true;
      out.push({
        id: a.id,
        partnerKey: b.partnerKey,
        status: "short",
        newlySuspended: newly,
        sent: {},
        received: {},
        quote,
      });
      retryLeg("short");
      continue;
    }
    b.suspended = false;
    const giveN = batches * quote.give;
    const takeN = batches * quote.take;
    b.take = { [b.takeGood]: takeN };
    const outbound = transferStock(us, them, { [b.giveGood]: giveN });
    const inbound = transferStock(them, us, { [b.takeGood]: takeN });
    out.push({
      id: a.id,
      partnerKey: b.partnerKey,
      status: resumed ? "resumed" : "shipped",
      sent: outbound.moved,
      received: inbound.moved,
      quote,
    });
    if (a.every !== undefined) advanceLeg(a, b.partnerKey);
    else ledger.complete(a.id);
  }
  return out;
}

/** ⏸️ How long a stalled one-shot waits before retrying (one street day —
 *  scarcities move on the day clock).
 *
 *  DEMOTED FROM MECHANISM TO BACKSTOP (§2.5.1: "`staleAt` = ... exactly today's
 *  constant, demoted from mechanism to backstop"). Where a host supplies
 *  `RunBartersOpts.park`, this is the park's `staleAt` and nothing else — the
 *  wait itself is the partner's own goods clock. Where it doesn't, this is
 *  still the whole timer, so a kernel-only caller (every test below) behaves
 *  exactly as it shipped. */
export const BARTER_RETRY_SEC = FOOD_DAY_SEC;

/** A one-shot deal that couldn't run re-arms one leg out (it WAITS, visibly,
 *  instead of failing — the partner's famine ends, the caravan goes). */
function reArmOneShot(a: TransferAgreement, now: number): void {
  a.nextDueAt = now + BARTER_RETRY_SEC;
}

// ---------------------------------------------------------------------------
// Order-time helpers (the host's spoken-order half)
// ---------------------------------------------------------------------------

/** Our WORST shortage among `goods`, excluding the give-good — the default
 *  take-good when the player names none ("trade wood with the city" and the
 *  clerk answers with what the town actually needs). Deterministic: ties
 *  break toward the earlier good in the list. Null when nothing is listed. */
export function defaultTakeGood(
  goods: readonly string[],
  give: string,
  us: BarterSignals,
): string | null {
  let best: string | null = null;
  let bestS = -1;
  for (const g of goods) {
    if (g === give) continue;
    const s = clamp01(us.shortage(g));
    if (s > bestS) {
      best = g;
      bestS = s;
    }
  }
  return best;
}

/** Seed/refresh an ABSTRACT partner's shelf so the executor's honest
 *  partner-stock clamp never binds on a town that exists only as a proxy:
 *  the stub's one mint, at the boundary, deterministic (top up to `floor`).
 *  Real partners never pass through here — their shelves are their books.
 *
 *  ⏸️ RETURNS THE UNITS MINTED (0 = the shelf was already full). One of the two
 *  events that credit a partner stack, and therefore one of the two that bump
 *  `partnerStockEpoch` (§2.5.1's town-rung twin of `needsStockEpoch`) — a caller
 *  that bumped unconditionally would tick the epoch on every due row and no
 *  agreement park would ever hold. */
export function stockAbstractPartner(
  stack: Record<string, number>,
  takeGood: string,
  floor: number,
): number {
  const have = stackUnits(stack, takeGood);
  if (have >= floor) return 0;
  const minted = floor - have;
  stack[takeGood] = (stack[takeGood] ?? 0) + minted;
  return minted;
}

// ---------------------------------------------------------------------------
// The embargo's face on the shelf (nations P6)
// ---------------------------------------------------------------------------

/**
 * INBOUND ROUTE HEALTH for one good: the share of the standing routes that
 * BRING it here which are still running (1 = all flowing, 0 = every one
 * paused).
 *
 * This is how a blockade becomes visible from the street without any new
 * machinery (nations-and-empires.md §5 channel 2, law #6 "visible causation
 * is the pedagogy"): the market shelf is already damped by
 * `producerAttendance` — "yesterday's absent farmer thins today's stock" —
 * and a suspended trade route is the SAME shape of fact one tier up. Thin
 * the shelf by this factor and the town's existing market remark speaks
 * "less + food" on its own; nobody had to script an embargo announcement.
 *
 * A town with NO inbound route for the good reads 1: an unconnected village
 * cannot be embargoed, which is the honest answer (and keeps every
 * pre-trade town byte-identical).
 */
export function inboundRouteHealth(
  agreements: readonly TransferAgreement[],
  good: string,
): number {
  let total = 0;
  let running = 0;
  for (const a of agreements) {
    const b = a.barter;
    if (!b || b.takeGood !== good) continue;
    if (a.status === "done" || a.status === "failed") continue;
    total++;
    if (b.suspended !== true) running++;
  }
  return total === 0 ? 1 : running / total;
}

// ---------------------------------------------------------------------------
// ⚖️ F-⑤ — THE TOWN CODEC: A STUB IS A NEVER-EXPANDED TOWN
// ---------------------------------------------------------------------------
//
// (fold-round.md stage F3, law F-⑤: *"`stockAbstractPartner` becomes 'condense
// of a town that has never run'; `TradePartner.real` dissolves into 'is this
// partner currently expanded'."*) The THIRD codec registered with the one fold
// (`kernel/town/fold.ts`), after wild-area's and population's, and the one the
// round names its whole point: the condensed-twin doctrine this module has
// carried in prose since ⑤ stops being a doctrine and becomes the type.
//
// WHAT A CONDENSED TOWN IS — everything the trade tier ever asks a partner, in
// one record: what stands on its shelf (UNITS), what its terrain declares,
// where it is, how long the road is, and — only where it has actually RUN —
// what its own books last read. Everything else is closed form:
// `stubPartnerSignals` answers "how short is it of X on day D" with no
// simulation behind it, which is precisely what lets a record stand in for a
// town.
//
// ⚖️ F-③ THE INTEGRAL LIVES AT THE FOLD. A condensed scope reports FLOWS and an
// expanded one UNITS, and `condense` is the only place one becomes the other:
// `ctx.floors` is what this town's unsimulated production would have put on the
// shelf by `now`, and topping the shelf up to it IS that integral. The
// arithmetic is `stockAbstractPartner` above, byte-unchanged and still the ONE
// boundary mint — this codec gives it its name, not a second implementation.
// No rate the books do not carry is invented anywhere below.
//
// 🚨 NOT A SECOND COPY OF THE SHELF, AND NOT IN A SESSION'S `foldedStock` SUM.
// A condensed partner's `stack` IS the live object the `town:<key>` endpoint
// aliases and `TownDeltas.partnerStock` persists (a frozen save shape: partner
// key → glyph stack), minted into IN PLACE exactly as it always was. It is
// therefore already a live `StockEndpoint` in the host's audit tree — the same
// structural difference F2 recorded for cohort rows, one rung up — so a
// session that ALSO added `foldedStock("town", …)` to its audit would count
// every unit twice. `stockOf` exists because the codec interface owes it, for
// the caller that holds a record the tree cannot walk.

/**
 * A TOWN, CONDENSED — the payload of `condense(town:<key>)`, and the whole of
 * what a partner nobody is simulating consists of.
 */
export interface TownRecord {
  /** Its partner key — what `town:<key>` endpoint ids are built from. */
  key: string;
  /** UNITS on its shelf. THE LIVE OBJECT, not a copy: the same stack the
   *  `town:<key>` endpoint aliases, so a shipment executed against the
   *  endpoint and the mint at this fold are writing one shelf. */
  stack: Record<string, number>;
  /** What its terrain declares (T5). Null ⇒ the pure-hash proxy, byte for
   *  byte as the stub shipped: a tier that knows nothing about its neighbour
   *  must not be made to pretend it does. */
  geo: PartnerGeography | null;
  /** Where it stands (world metres), or null when nobody bound a place. */
  at: { x: number; y: number } | null;
  /** Its ROAD (world metres) for `barterLegSeconds`, or null for NO REAL
   *  GEOMETRY — the honest unknown that takes the flat leg. */
  distanceM: number | null;
  /** ⚖️ F-③ — WHAT ITS OWN BOOKS READ, at the fold, for the goods it was
   *  condensed over. Present only for a town that HAS run: folding a live
   *  neighbour into a hash would replace its real scarcity with a fiction, so
   *  the books' own numbers ride the record instead (and unlisted goods read
   *  0, exactly as a books read of a good with no fill does). NULL for a
   *  never-expanded town — F-⑤'s subject — whose shortage is the closed form
   *  and nothing else. */
  shortages: Record<string, number> | null;
}

/**
 * ⚖️ F-⑤ — THE ONE SHORTAGE READING, off the record.
 *
 * Before F3 a partner's scarcity was read two ways at two construction sites —
 * a live-books read for a cluster neighbour, `stubPartnerSignals` for a stub —
 * and the fork between them was the scar law F-⑤ names. This is where the two
 * meet: a record that carries its town's own books answers with THOSE (the
 * fold conserved them), and one that does not is a town that has never run,
 * whose scarcity is the closed form. Same signature either way, so no caller
 * can tell which state its partner is in — which is the point.
 *
 * BIT-IDENTICAL for the never-expanded case: `stubPartnerSignals(key,
 * Math.floor(day), geo)`, the shipped call, unchanged including the day floor.
 */
export function townRecordSignals(rec: TownRecord, day: number): BarterSignals {
  const books = rec.shortages;
  if (books) return { shortage: (good) => clamp01(books[good] ?? 0) };
  return stubPartnerSignals(rec.key, Math.floor(day), rec.geo);
}

/** What `condense` of a town needs, minus the key (which comes from the scope
 *  id). Split out from `TownFoldCtx` so the PURE half can be called directly —
 *  the hot partner table builds a record per partner per read and has no
 *  business allocating an envelope for it — exactly as `condenseWildArea` is
 *  callable beside `WILD_AREA_CODEC.condense`. */
export interface CondenseTownInput {
  /** The partner key this record is for. */
  key: string;
  /** THE RECORD THIS TOWN CONDENSED TO LAST TIME (wild's own `prev`
   *  contract): every field below defaults to what it already said, so a
   *  re-fold that only mints does not have to restate the town. */
  prev?: TownRecord | null;
  /** Its live shelf, when there is no `prev` to take one from (the first
   *  touch — the host's `partnerStock[key]`). Absent ⇒ an empty one. */
  stack?: Record<string, number>;
  /** ⚖️ F-③ THE INTEGRAL: units of each good this town's unsimulated
   *  production has put on the shelf by now — the shelf is topped UP to each
   *  (`stockAbstractPartner`), never beyond, and never down. Absent ⇒ no mint,
   *  which is what a plain read of the partner table wants. */
  floors?: Readonly<Record<string, number>>;
  /** Called with what the integral actually added, per good (never with 0):
   *  the epoch bump `partnerStockEpoch` needs, without this module knowing
   *  what an epoch is. */
  minted?(good: string, units: number): void;
  /** Its terrain / place / road, for a town with no prior record. */
  geo?: PartnerGeography | null;
  at?: { x: number; y: number } | null;
  distanceM?: number | null;
  /** ⚖️ F-③ — ITS OWN BOOKS' SHORTAGE READ, for a town that is EXPANDED as it
   *  folds. Supplying it (with `goods`, the vocabulary to sample) is what
   *  makes the record answer with the books instead of the closed form; a
   *  never-expanded town supplies neither. */
  shortageOf?(good: string): number;
  goods?: readonly string[];
}

/**
 * ⚖️ CONDENSE A TOWN — the pure half. Mints the integral into the live shelf
 * and answers the record. Deterministic; the only mutation is the mint, which
 * is `stockAbstractPartner`'s, in place, as it has always been.
 */
export function condenseTown(input: CondenseTownInput): TownRecord {
  const prev = input.prev ?? null;
  const stack = input.stack ?? prev?.stack ?? {};
  for (const [good, floor] of Object.entries(input.floors ?? {})) {
    const minted = stockAbstractPartner(stack, good, floor);
    if (minted > 0) input.minted?.(good, minted);
  }
  const read = input.shortageOf;
  let shortages: Record<string, number> | null = prev?.shortages ?? null;
  if (read) {
    shortages = {};
    for (const good of input.goods ?? []) shortages[good] = clamp01(read(good));
  }
  return {
    key: input.key,
    stack,
    geo: input.geo !== undefined ? input.geo : prev?.geo ?? null,
    at: input.at !== undefined ? input.at : prev?.at ?? null,
    distanceM: input.distanceM !== undefined ? input.distanceM : prev?.distanceM ?? null,
    shortages,
  };
}

/**
 * ⚖️ F5 — A STANDING LEG IS SERVICED BY THE CLOSED FORM (`FoldCodec.services`;
 * law F-④'s serviceability split, fold-round.md F4's 🔶 finding).
 *
 * THE FINDING: partner shelf endpoints ARE the `from`/`to` of standing trade
 * legs, and a standing route sits `pending` between visits forever — so a fold
 * that treats every leg as a blocker refuses every trading partner, which is
 * every partner worth folding.
 *
 * THE ANSWER, and why it is not a special case: a standing scheduled leg is
 * ALREADY run against the condensed form. The host's caravan arms mint a
 * CONDENSED partner's shelf and ship from it — `p.record` is exactly the test
 * they make (quest-host `stepBarters` / `stepLedgerSweeps`) — and the clock
 * warp settles whole days of those legs with no body anywhere near them. A
 * partner is condensed *while it trades*, so "the closed form can keep this
 * promise" is not a hope about this row: it is a description of the code that
 * has been keeping it all along.
 *
 * WHAT STILL REFUSES, unchanged from F4:
 *   · HANDS — a task books a body, and no record stands in for one.
 *   · A `moving` LEG — goods in somebody's hands on a road.
 *   · A `haul` LEG — a leg waiting for a body to walk it, pending or not.
 *   · Anything booked against something OTHER than the scope itself (matched
 *     through an executor or an issuer): the record answers for the shelf, not
 *     for whoever mentioned it.
 *
 * ONE PREDICATE, TWO CODECS. The town's is the case the finding named, but the
 * fact is about the LEG and the SCOPE it is booked against, not about towns:
 * the region source's own draw legs (wild-area.ts, F5's other half) are serviced
 * by exactly the same arm on exactly the same terms, so `WILD_AREA_CODEC`
 * shares this predicate rather than growing a second copy of it.
 */
export function standingLegServiced(c: FoldCommitment, scope: FoldScope): boolean {
  if (c.book !== "transfer") return false; // hands never; stock rides (fold.ts)
  if (c.against !== scope.id) return false;
  return c.payload?.["mode"] === "scheduled" && c.payload?.["status"] === "pending";
}

/** The codec's context: everything `condenseTown` takes (the key comes from
 *  the scope id) plus `expand`'s placer. */
export interface TownFoldCtx extends FoldCtx, Omit<CondenseTownInput, "key"> {
  /** expand: receives the town's shelf back — the live host's hook to hand it
   *  to the sim that is about to run it, a test's hook to collect it.
   *  Optional: omit for a dry run that only wants the ids back. */
  place?(key: string, stack: Record<string, number>): void;
}

function townRefusal(id: ScopeId, blockers: readonly string[], note: string): FoldRefusal {
  return { refused: true, kind: "town", id, blockers, note };
}

function condenseTownPayload(id: ScopeId, ctx: TownFoldCtx): TownRecord | FoldRefusal {
  const ref = parseScopeId(id);
  // 🚨 THE PARSE IS SYNTACTIC (scope.ts) — `town:` covers OUR OWN root and OUR
  // OWN builder yard as well as a partner's shelf, and neither of those is a
  // town this session could stop simulating. Both refuse NAMED rather than
  // being condensed into a partner nobody trades with.
  if (ref.kind !== "town") {
    return townRefusal(id, [], `not a town id ("${id}")`);
  }
  if (!ref.key) {
    return townRefusal(id, ["local"], `the local town is the one we ARE simulating ("${id}")`);
  }
  if (id === TOWN_YARD_ID) {
    return townRefusal(id, ["yard"], `"${id}" is our own builder yard, not a partner town`);
  }
  return condenseTown({ ...ctx, key: ref.key });
}

function expandTownPayload(
  record: FoldRecord<TownRecord>,
  ctx: TownFoldCtx,
): ScopeId[] | FoldRefusal {
  const rec = record.payload;
  if (!rec.key) {
    return townRefusal(record.id, ["local"], "a town record with no partner key names nobody");
  }
  // ⚖️ F-① NOTHING EVAPORATES: the shelf goes to the placer BEFORE the id is
  // answered, so a caller that materializes the town materializes its goods
  // with it. The record itself is not emptied — expand is pure, and the host
  // owns the transition (wild's `unfoldWildArea` deleting its own map entry is
  // the precedent).
  ctx.place?.(rec.key, rec.stack);
  return [scopeIdOf({ kind: "town", key: rec.key })];
}

/** Every unit a condensed town holds, by glyph — see the 🚨 above for why a
 *  session's own audit must NOT add this on top of its tree. */
function townRecordStock(rec: TownRecord): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [g, n] of Object.entries(rec.stack)) if (n > 0) out[g] = n;
  return out;
}

/**
 * THE TOWN CODEC — registered below at module load, so importing this module
 * (already the whole game does, for `stockAbstractPartner`/`barterQuote`
 * themselves) is enough to make `kind: "town"` foldable through the generic
 * dispatch.
 */
export const TOWN_CODEC: FoldCodec<TownRecord, TownFoldCtx> = {
  kind: "town",
  condense: condenseTownPayload,
  expand: expandTownPayload,
  stockOf: townRecordStock,
  services: standingLegServiced,
};

registerFoldCodec(TOWN_CODEC);
