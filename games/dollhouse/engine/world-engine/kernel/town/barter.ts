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
/** Below this, a town doesn't WANT a good ("they have enough wood"). */
export const BARTER_WANT_MIN = 0.15;
/** At/above this, a town won't PART with a good (its own famine). */
export const BARTER_FAMINE_MAX = 0.7;
/** Travel time of one shipment leg, as a fraction of a street day — the
 *  caravan is on the road before goods land (FOOD_DAY_SEC × this). */
export const BARTER_LEG_DAY_FRAC = 0.35;

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

/**
 * Scarcity proxy for a partner that ISN'T fully simulated (the abstract
 * `away:<seed>` line, a flight-tier `city:<cell>`): a hash-seeded BASE per
 * (partner, good) plus a slow TRIANGULAR season over the town day — pure
 * f(partnerKey, good, day), so replays and both ends of a call agree, and
 * the terms a player hears SHIFT over time even against a stub.
 */
export function stubPartnerSignals(partnerKey: string, day: number): BarterSignals {
  return {
    shortage(good: string): number {
      const h = fnv(`${partnerKey}|${good}`);
      const base = ((h >>> 8) % 1000) / 1000; // 0..1 — the partner's standing bias
      const phase = (h % STUB_SEASON_DAYS) / STUB_SEASON_DAYS;
      const u = (day / STUB_SEASON_DAYS + phase) % 1;
      const tri = u < 0.5 ? u * 2 : 2 - u * 2; // 0→1→0 across a season
      return clamp01(base * 0.55 + tri * 0.45);
    },
  };
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
  for (const a of ledger.due(now)) {
    const b = a.barter;
    if (!b) continue; // plain rows belong to runDueTransfers
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
    // clock; one-shots WAIT visibly (re-armed a day out) instead of rotting.
    const retryLeg = () => {
      if (a.every !== undefined) ledger.advance(a.id, now);
      else reArmOneShot(a, now);
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
      retryLeg();
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
      retryLeg();
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
    if (a.every !== undefined) ledger.advance(a.id, now);
    else ledger.complete(a.id);
  }
  return out;
}

/** How long a stalled one-shot waits before retrying (one street day —
 *  scarcities move on the day clock). */
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
 *  Real partners never pass through here — their shelves are their books. */
export function stockAbstractPartner(
  stack: Record<string, number>,
  takeGood: string,
  floor: number,
): void {
  const have = stackUnits(stack, takeGood);
  if (have < floor) stack[takeGood] = (stack[takeGood] ?? 0) + (floor - have);
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
