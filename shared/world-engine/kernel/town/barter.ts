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
 * food it buys — bargaining position is part of the lesson.
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
  stackUnits,
  transferStock,
  type StockEndpoint,
  type TransferAgreement,
  type TransferLedger,
} from "./transfer.js";
// ⚖️ §7 step 6: `journeyS` into the barter leg. The region rung already owns
// "how far one day of legs carries you" — the town stops inventing it.
import { dailyTravelM, type WorldScale } from "../../scale.js";
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
 */
export const BARTER_LEG_DAY_FRAC = 0.35;

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

export type BarterRefusal = "has-enough" | "wont-part";

/**
 * Would the PARTNER accept this deal? Derived from the same signals the
 * ratio reads: it must WANT what we give more than what it gives up.
 *   • its own famine on the take-good refuses "wont-part"
 *     ("they won't part with food") — checked first: famine dominates.
 *   • too little need for the give-good — or no more need for it than for
 *     what it surrenders — refuses "has-enough" ("they have enough wood").
 * Our own side's refusal (can we COVER the give-goods) is the caller's
 * stock check — honesty about our shelves isn't the partner's business.
 */
export function barterWillingness(
  give: string,
  take: string,
  us: BarterSignals,
  them: BarterSignals,
): { ok: true } | { ok: false; reason: BarterRefusal } {
  void us; // the partner judges by ITS OWN books alone (honest refusals)
  const wantGive = clamp01(them.shortage(give));
  const partTake = clamp01(them.shortage(take));
  if (partTake >= BARTER_FAMINE_MAX) return { ok: false, reason: "wont-part" };
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
// The scheduled executor — shipments both ways, terms re-derived per leg
// ---------------------------------------------------------------------------

export type BarterLegStatus =
  | "shipped" // goods moved both ways at the re-derived terms
  | "suspended" // the partner refused this shipment (standing: retry next leg)
  | "resumed" // it had been suspended; this leg shipped again
  | "short"; // OUR side can't cover one quote batch right now

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
  park?(a: TransferAgreement, why: BarterRefusal | "short"): boolean;
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
 *   3. SHIP in whole quote batches, bounded by our stock, the ordered
 *      amount, AND the partner's own shelf (a real partner can run short) —
 *      goods move BOTH WAYS between the live endpoints via transferStock.
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
    const retryLeg = (why: BarterRefusal | "short") => {
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
    //    units (a one-shot keeps its strict order).
    const ordered = Math.max(0, Math.floor(a.goods[b.giveGood] ?? 0));
    const wantBatches =
      a.every !== undefined
        ? Math.max(1, Math.floor(ordered / quote.give))
        : Math.floor(ordered / quote.give);
    const batches = Math.min(
      wantBatches,
      Math.floor(stackUnits(us.stack, b.giveGood) / quote.give),
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
