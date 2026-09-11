/**
 * collection-plan.ts — ONE scope-agnostic COLLECTION-TRIP PLANNER: which
 * sources a taker visits, in what order, and HOW MUCH it takes at each.
 *
 * ⚖️ THE USER'S RULING (2026-09-09), verbatim: *"the solution to the foraging …
 * really should be part of the kernel rather than a foraging-specific rule.
 * Consider — the math determining which bushes to visit is basically the same
 * as that of a shopper visiting stores or cities where they can collect
 * resources."* This file is that math, once.
 *
 * It is the same law the round already writes from the other side —
 * *"wilderness = a RENDERER of a resource source, treated the same as a
 * storeroom, shop or city; household shopping = shop stocking = city imports =
 * harvesting"*. A berry bush, a set-down basket, a pantry chest, a market
 * shelf and a neighbouring city are all one thing here: something that HOLDS
 * FREE UNITS, sits at a COST, and may charge a PRICE.
 *
 * ── WHAT IT DECIDES, AND WHAT IT DELIBERATELY DOES NOT ────────────────────
 *
 * DECIDES: the ORDER and the SIZE of a collection trip's legs.
 * DOES NOT: what a unit is worth, how far anything is, whether the taker may
 * use a source, or what happens when it arrives. Every one of those is a WORLD
 * question and the caller answers it on the candidate — the `TaskCandidate.cost`
 * / `StockCandidate.d` convention this codebase already uses ("the caller
 * resolves the world question and carries the answer on the candidate").
 *
 * 🚫 NO LOGIC HERE NAMES A KIND. There is no "bush", no "shelf", no "city" and
 * no good key in this file: a candidate is four numbers and an id. That is the
 * whole of what makes forage its FIRST consumer rather than its owner.
 *
 * ── WHY A PLAN AND NOT A PICK (measured) ──────────────────────────────────
 *
 * The forage lane shipped an argmax over `value − cost` and it was not enough,
 * twice over, and both failures are what this file's shape is FOR:
 *
 *  ① A PICK HAS NO SIZE, so a body that had walked 90 m to a wood took one
 *     berry and walked back — the trip was priced as if it were free
 *     (plant-growth-render-round.md PART 5 §5, PART 5b). A leg carries `units`,
 *     so the walk is amortised over what the trip is actually FOR.
 *  ② A SIZE READ PER TICK DESTABILISES THE ORDER. Valuing candidates at
 *     `min(free, room)` — room read off the hands, which moves as the body
 *     picks things up — cost 4.84 → 2.76 rations/day, because two near-tied
 *     sources swapped places mid-walk and the trip never ended (PART 5b §2 Ⓑ).
 *     So the caller FREEZES a leg once it is claimed and hands the frozen size
 *     back in (`CollectionCandidate.booked`), and the planner honours it.
 *
 * ── DETERMINISM ───────────────────────────────────────────────────────────
 *
 * Pure, allocation-light, no RNG, no clock. Ties break on the candidate id, so
 * two peers over the same world produce the identical plan — which is what lets
 * the caller read free units and reserve them in ONE synchronous step
 * (`ReservationLedger`), with takers visited in sorted order.
 */

/** WHAT A TAKER WANTS AND WHAT IT CAN CARRY, in the caller's own unit (items,
 *  rations, tonnes — the planner never asks). */
export interface CollectionAsk {
  /** Units the trip is FOR: this body's own deficit for the day, plus whatever
   *  it is provisioning for others. The planner never invents it. */
  want: number;
  /** Units it can carry away RIGHT NOW. Absent ⇒ unbounded (a caller that
   *  models no body: a scheduled haul, a caravan sized by its own contract). */
  room?: number;
}

/**
 * ONE PLACE UNITS CAN BE COLLECTED FROM. Four numbers and an id, and every one
 * of them is the CALLER's answer to a world question.
 */
export interface CollectionCandidate {
  /** Endpoint id — the deterministic tie-break, and what a claim is keyed by. */
  id: string;
  /** Units this taker may honestly plan against: what is there, minus what
   *  other takers have spoken for. */
  free: number;
  /** What ONE unit is worth to the want being served, in hand-seconds. */
  unitValueS: number;
  /** Hand-seconds to GET there and handle it: the walk plus the act. Paid
   *  ONCE per leg however much is taken — which is precisely why size matters. */
  costS: number;
  /** Hand-seconds paid PER UNIT to acquire (a shelf's price, a city's terms).
   *  Absent ⇒ free for the taking, which is what a wild stand is. */
  price?: number;
  /**
   * ⚖️ THE FROZEN LEG. Units this taker has ALREADY CLAIMED here and is walking
   * toward. Present ⇒ the planner may not re-size or re-price this leg away:
   * it is a promise the body has made, and re-deciding it every tick is the
   * measured defect ② in the header. Absent ⇒ an ordinary candidate.
   */
  booked?: number;
}

/** One leg of a trip: go here, take this much, and this is what it was worth. */
export interface CollectionLeg {
  id: string;
  units: number;
  /** `units × (unitValueS − price) − costS`, in hand-seconds. */
  netS: number;
}

export interface CollectionPlan {
  /** Best first. Empty ⇒ nothing here is worth the trip. */
  legs: CollectionLeg[];
  /** Σ of the legs' units. */
  units: number;
  /** Σ of the legs' net worth, in hand-seconds, MINUS any enabler's cost. */
  netS: number;
  /** The enabler this plan fetches first, when one paid for itself. Absent ⇒
   *  bare-handed, which is always one of the plans compared. */
  enabler?: string;
}

/**
 * ⚖️ AN ENABLER — something that makes the trip CARRY MORE, at a cost.
 *
 * A basket a forager fetches on the way, a cart a shopper wheels, a pack animal,
 * a second wagon on a caravan. It is not a source and holds nothing: it changes
 * ONE number, the room, and charges for the privilege.
 *
 * 🚨 A PRICED OPTION, NEVER A PRECONDITION — and that is a MEASURED law, not a
 * preference (emergent-plans-round.md E-8): claiming a bag at decide time so no
 * other body could take it cost **4.60 → 3.54 rations/day** (seed 11), because
 * it turned one body's option into everybody else's blocker. The planner
 * therefore prices the enabler against the SAME want and takes it only when the
 * units it buys pay for the fetch — a five-unit want over a long leg amortises
 * a nearby basket; a one-unit top-up does not.
 */
export interface CollectionEnabler {
  /** The enabler's own id — what a caller books a claim on when it is chosen. */
  id: string;
  /** Hand-seconds to GO AND GET IT and take it up: the detour, once. */
  costS: number;
  /** The room the taker has WITH it — an absolute figure, not a bonus, so a
   *  caller never has to decide whether hands still count. */
  roomWith: number;
}

export interface CollectionOpts {
  /** Enablers the taker could pick up first. Empty/absent ⇒ the bare plan is
   *  the only plan, byte-identical to a caller that models none. */
  enablers?: readonly CollectionEnabler[];
  /**
   * How many legs one trip may carry. Default 1 — a trip is one errand unless
   * the caller says its taker can chain (a caravan, a scheduled haul). Raising
   * it is what makes "a caravan-scale want spans two sources" fall out of the
   * same arithmetic instead of a second code path.
   */
  maxLegs?: number;
  /**
   * Admit a leg whose net worth is ≤ 0? Default false — a trip that costs more
   * than it brings is not a trip (`acquireFrom`'s own "never destroy more than
   * you make"). A caller with no geometry passes every cost as 0 and every
   * candidate then ties at `units × unitValueS`, which is the honest unpriced
   * answer rather than an empty plan.
   */
  allowUnworthwhile?: boolean;
}

/** What one leg would take and what it would be worth. */
function legFor(
  c: CollectionCandidate,
  wantLeft: number,
  roomLeft: number,
): CollectionLeg {
  // ⚖️ A BOOKED LEG IS THE SIZE IT WAS BOOKED AT — bounded only by what is
  // still really there, because a claim is an intent and the world may have
  // shrunk under it (the reservation ledger's own law: "stock can still shrink
  // underneath a reservation; the honest shortfall surfaces at take time").
  const units =
    c.booked !== undefined
      ? Math.max(0, Math.min(c.booked, c.free))
      : Math.max(0, Math.min(c.free, wantLeft, roomLeft));
  const perUnit = c.unitValueS - (c.price ?? 0);
  return { id: c.id, units, netS: units * perUnit - c.costS };
}

/** Best first, ties on the id — never input order, which is a caller's history
 *  and not a fact about the world. */
function better(a: CollectionLeg, b: CollectionLeg): number {
  return b.netS - a.netS || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * ⚖️ PLAN THE TRIP. Greedy over `value − cost`, re-priced after every leg
 * because taking somewhere spends room and want and therefore changes what the
 * NEXT source is worth — which is the whole reason a plan is not a sorted list.
 *
 * The greed is honest at this size: a leg's worth is monotone in the units it
 * can still take, so taking the best leg first can never make a later one worth
 * more than it was. (A caller whose candidates PRICE differently per unit —
 * a bulk discount, a tariff — would need the exact solve; nothing in this
 * engine does, and this note is where that would be argued.)
 */
export function planCollection(
  ask: CollectionAsk,
  candidates: readonly CollectionCandidate[],
  opts?: CollectionOpts,
): CollectionPlan {
  // ⚖️ THE ENABLER IS PRICED, NOT ASSUMED (see `CollectionEnabler`). Plan the
  // trip BARE, then plan the same want again with each enabler's room and its
  // fetch charged once, and keep the best. Bare is always in the comparison, so
  // an enabler that buys nothing can never be chosen — which is the whole
  // content of "a priced OPTION, never a precondition".
  //
  // Deterministic: enablers are tried in the order given and a tie keeps the
  // EARLIER plan, with bare first — so an enabler must strictly beat going
  // without one, and equal enablers resolve by the caller's own sorted list.
  const enablers = opts?.enablers ?? [];
  if (enablers.length > 0) {
    const bare = planBare(ask, candidates, opts);
    let best = bare;
    for (const e of enablers) {
      if (!(e.roomWith > (ask.room ?? Number.POSITIVE_INFINITY))) continue; // no more room than now
      const withIt = planBare({ ...ask, room: e.roomWith }, candidates, opts);
      const net = withIt.netS - e.costS;
      if (net > best.netS) best = { ...withIt, netS: net, enabler: e.id };
    }
    return best;
  }
  return planBare(ask, candidates, opts);
}

/** The trip as planned with the room the taker has — the enabler-free core. */
function planBare(
  ask: CollectionAsk,
  candidates: readonly CollectionCandidate[],
  opts?: CollectionOpts,
): CollectionPlan {
  const maxLegs = Math.max(1, Math.floor(opts?.maxLegs ?? 1));
  const legs: CollectionLeg[] = [];
  let wantLeft = Math.max(0, ask.want);
  let roomLeft = ask.room === undefined ? Number.POSITIVE_INFINITY : Math.max(0, ask.room);
  const left = candidates.filter((c) => c.free > 0);
  while (legs.length < maxLegs && left.length > 0) {
    // A BOOKED leg is still planned even with no want or room left: the body
    // has already spoken for it, and dropping it here would strand the claim.
    if (wantLeft <= 0 || roomLeft <= 0) {
      if (!left.some((c) => c.booked !== undefined)) break;
    }
    let bestI = -1;
    let best: CollectionLeg | null = null;
    for (let i = 0; i < left.length; i++) {
      const leg = legFor(left[i]!, wantLeft, roomLeft);
      if (leg.units <= 0) continue;
      if (!best || better(leg, best) < 0) {
        best = leg;
        bestI = i;
      }
    }
    if (!best || bestI < 0) break;
    if (best.netS <= 0 && !opts?.allowUnworthwhile && left[bestI]!.booked === undefined) break;
    legs.push(best);
    left.splice(bestI, 1);
    wantLeft -= best.units;
    roomLeft -= best.units;
  }
  return {
    legs,
    units: legs.reduce((n, l) => n + l.units, 0),
    netS: legs.reduce((n, l) => n + l.netS, 0),
  };
}

/**
 * ⚖️ WHAT AN ENABLER IS WORTH OVER A HORIZON — `planCollection`'s enabler arm
 * asked as a QUESTION instead of answered as a choice, and the seam the DEMAND
 * for one hangs off (pull-labor-round.md, baskets makeable, 2026-09-09).
 *
 * 🚨 THE DIFFERENCE THAT MAKES THIS A SECOND FUNCTION AND NOT A FLAG.
 * `planCollection` prices an enabler for ONE TRIP: fetch it, use it, and the
 * fetch is charged against that trip alone. That is the right reading when the
 * thing already exists in the world and the only question is whether to detour
 * for it. It is the WRONG reading when the question is whether the thing should
 * EXIST: a vessel is not consumed by the trip it serves, so what it is worth is
 * what it saves over a horizon — and a one-trip reading systematically
 * undercounts that by the number of trips.
 *
 * ── THE ARITHMETIC, and every term is the planner's own ────────────────────
 *
 * Over `horizonUnits` the taker must bring home that many units whatever it
 * carries. It does so in trips, each costing the leg's `costS` once and
 * bringing what the room allows, so the overhead per unit is `costS / units` —
 * and a plan's `netS / units` IS `unitValue − price − costS/units`, the same
 * quantity with the value term attached. The surplus is therefore
 *
 *     horizonUnits × (netS_with / units_with − netS_bare / units_bare) − costS
 *
 * which reads, with the value terms cancelling whenever both plans take from
 * the same source, as *the hand-seconds of WALKING the horizon stops paying* —
 * and keeps the value difference when the bigger room lets a BETTER source win
 * (`bagFetchGoal`'s "the source may change under it", which is the point).
 *
 * ⚖️ WORTHWHILENESS IS DELIBERATELY SUSPENDED HERE (`allowUnworthwhile`), and
 * only here. This is a COMPARISON of two arrangements, not a decision to go: a
 * bare trip that is not worth taking must still be SIZED, or the case the whole
 * question exists for — *bare brings one unit and is not worth going at all,
 * the vessel brings ten* — would answer "no gain" because the bare plan came
 * back empty. The caller's own gate decides whether anything happens.
 *
 * 🚫 AND IT NAMES NO KIND, exactly as the arm it reads. A basket, a cart, a
 * pack animal and a second wagon are one thing: something that changes the room
 * and charges for it.
 *
 * Zero — never negative — when the enabler buys no room at all, or when either
 * arrangement can collect nothing: there is no gain to report, and a caller
 * comparing against a cost should see "no" rather than a magnitude.
 */
export function enablerSurplusS(
  ask: CollectionAsk,
  candidates: readonly CollectionCandidate[],
  enabler: CollectionEnabler,
  /** Units the taker must collect over the span being priced — a day's draw,
   *  a contract, a season. The caller owns the horizon; the planner never
   *  invents one. */
  horizonUnits: number,
  opts?: CollectionOpts,
): number {
  if (!(enabler.roomWith > (ask.room ?? Number.POSITIVE_INFINITY))) return 0;
  const o: CollectionOpts = { ...(opts ?? {}), allowUnworthwhile: true };
  const bare = planBare(ask, candidates, o);
  const withIt = planBare({ ...ask, room: enabler.roomWith }, candidates, o);
  if (!(bare.units > 0) || !(withIt.units > 0)) return 0;
  const perUnitGain = withIt.netS / withIt.units - bare.netS / bare.units;
  return Math.max(0, horizonUnits) * perUnitGain - enabler.costS;
}

/**
 * THE ORDER ALONE — every candidate ranked as a first leg, best first.
 *
 * For a caller whose execution layer sizes its own take (the needs walker's
 * `takeUnits`) but whose CHOICE must still be the planner's: the ranking is
 * `planCollection`'s own comparison over the same numbers, so the list a body
 * reads and the plan it would make can never disagree.
 */
export function rankCollection(
  ask: CollectionAsk,
  candidates: readonly CollectionCandidate[],
): CollectionLeg[] {
  const room = ask.room === undefined ? Number.POSITIVE_INFINITY : Math.max(0, ask.room);
  return candidates
    .filter((c) => c.free > 0)
    .map((c) => legFor(c, Math.max(0, ask.want), room))
    .sort(better);
}
