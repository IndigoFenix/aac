// shared/world-engine/interaction/behavior/social-acts.ts
//
// THE ACT VOCABULARY of interpersonal politics (interpersonal-politics.md §3;
// influence-and-authority.md M2) — the ONE place that says what a social event
// DOES to the book, to what people believe, and to whose needs got met.
//
// PURE, and aggressively so: no session, no world geometry, no clock, no RNG,
// no `Math.random`. It takes an ACT plus a way to READ the directed relation
// book, and hands back three lists the host applies (`nudges`, `facts`,
// `credits`). That split is the whole design: WHO CAN SEE WHOM is a world
// question the host answers by handing over a witness list, and WHAT BEING SEEN
// MEANS is this module's, so the social rules can be read, tested and argued
// about without booting a town.
//
// 🚨 THE NAME. `applySocialAct` ALREADY EXISTS in quest-host (the hug/play/show
// door). This is `applySocialEvent`, a different function in a different layer;
// do not merge them.
//
// FOUR LAWS, ENFORCED BY CONSTRUCTION rather than by the caller remembering:
//
//  ① NO SELF-EDGE, EVER. An act whose `author === actor` (you ordered yourself)
//     writes no author edges at all, and no emitted nudge ever has
//     `observer === subject`. 🚨 Self-authorship is not a compliance bypass and
//     it is not a way to nudge your own standing either: a body that could
//     author its own orders and collect the authority for finishing them would
//     bootstrap a chief out of nothing.
//
//  ② THE ACTOR EARNS AFFINITY, THE AUTHOR EARNS TRUST AND AUTHORITY (⚖️ the
//     round's asymmetry law). The one who DID the thing is liked for it; the one
//     who called for it is credited with having been right. This is what makes a
//     leader a different social object from a helper.
//
//  ③ COERCED COMPLIANCE NEVER EARNS AUTHORITY (owner's ruling ③). An
//     `order-done` that arrived by route "C" writes no authority at all — it
//     costs the author a little affinity instead. Obeying because defiance would
//     hurt is evidence about the threat, never about the right to command.
//
//  ④ A BYSTANDER LEARNS LESS THAN A PARTY (`WITNESS_FRACTION`), and only the
//     nearest `WITNESS_CAP` of them learn anything. Both halves matter: an
//     uncapped crowd would make one loud act worth more than a lifetime of
//     quiet ones, which is how a reputation system becomes a shouting contest.

import type { CreatureId } from "@shared/world-engine/interaction/behavior/creatures.js";
import type { Fact } from "@shared/world-engine/interaction/behavior/facts.js";
import type { Personality } from "@shared/world-engine/interaction/behavior/personality.js";
import {
  deference,
  nudgeFromGift,
  nudgeFromOutcome,
  nudgeFromThreat,
  nudgeFromYield,
  type Relation,
} from "@shared/world-engine/interaction/behavior/relations.js";

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * EVERY social event the substrate knows how to price. Sixteen words, and the
 * list is deliberately CLOSED: a world that wants a new social move describes it
 * as one of these (a bribe is a `gift`, a rescue is `help`, taking someone's
 * side in an argument is `side`), because a table small enough to hold in the
 * head is the only kind anyone can reason about when a creature does something
 * surprising.
 *
 * A CONTEST is not in the list, on purpose: it is request ↔ refuse ↔ (threaten)
 * ↔ `yield` across acts that already exist. Nothing scripted.
 */
export type SocialActKind =
  | "attend"
  | "thank"
  | "praise"
  | "insult"
  | "threaten"
  | "yield"
  | "apologize"
  | "side"
  | "gift"
  | "help"
  | "harm"
  | "order-done"
  | "order-failed"
  | "order-refused"
  | "request-granted"
  | "request-refused";

export interface SocialAct {
  kind: SocialActKind;
  /** WHO DID IT — the body whose hands moved. Earns affinity (law ②). */
  actor: CreatureId;
  /** WHO CALLED FOR IT, when that is somebody else — the leader whose order the
   *  actor carried out. Earns trust/authority (law ②). Omitted, or equal to
   *  `actor`, means the act was self-directed and NO author edge is written. */
  author?: CreatureId;
  /** THE OTHER PARTY — who it was done to, for, or at. */
  addressee: CreatureId;
  /** WHO SAW IT, NEAREST FIRST. The caller owns this list (it is the only side
   *  that knows about eyes, walls and conversation circles); this module only
   *  caps it, de-duplicates it and drops the two parties out of it. */
  witnesses: readonly CreatureId[];
  /** WHICH ROUTE produced the compliance/yield: "L" earned, "C" coerced. Drives
   *  law ③ and which sentiment a `yield` publishes. Default "L". */
  route?: "L" | "C";
  /** HOW BIG — 1 = ordinary. Scales the arms whose table entry says `·m`. */
  magnitude?: number;
  /** `side` only: whom the actor took the addressee's side AGAINST. */
  third?: CreatureId;
}

/** What the host must apply. Three lists, no side effects, no session. */
export interface SocialOutcome {
  /** DIRECTED and ASYMMETRIC — `observer`'s attitude toward `subject` moves by
   *  `delta`. Never the other way round unless a second entry says so. */
  nudges: Array<{ observer: CreatureId; subject: CreatureId; delta: Partial<Relation> }>;
  /** Beliefs the act PUBLISHES — a regard fact, written into every viewer. */
  facts: Array<{ viewer: CreatureId; fact: Fact }>;
  /** NEEDS THE ACT MET (or cost). `levelAfter` pins the meter; `delta` moves it
   *  (a standing LOSS raises the meter — you now need standing you did not need
   *  a moment ago). Exactly one of the two per entry. */
  credits: Array<{
    cid: CreatureId;
    key: "social" | "standing" | "security";
    delta?: number;
    levelAfter?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Shape constants
// ---------------------------------------------------------------------------

/**
 * ⚖️ HOW MANY WITNESSES AN ACT CAN REACH (M2). Six, and the number is a shape
 * rather than a performance budget: past about half a dozen people the marginal
 * bystander does not change what happened socially, and an UNCAPPED crowd would
 * make a single act in a market square outweigh a season of private ones. The
 * caller passes witnesses NEAREST FIRST and the surplus is dropped from the
 * far end — the people at the back genuinely did not see it.
 */
export const WITNESS_CAP = 6;

/**
 * ⚖️ WHAT A BYSTANDER TAKES AWAY, as a share of what a PARTY does (M2, law ④):
 * half of a COMPETENCE axis (trust / authority / fear) and half of that again
 * for affinity — a bystander sees competence, not intimacy. Watching you keep a
 * promise tells me a lot about whether you can be relied on and very little
 * about whether I like you.
 *
 * The witness column of the S-4 table is AUTHORED per act rather than computed,
 * because affinity between people who merely watched is not a scaled copy of
 * affinity between people who took part. This constant is applied where the
 * authored number IS exactly the share (the two fear edges), and it is the law
 * every other authored number is checked against: no witness edge may exceed
 * the party's edge on the same axis.
 */
export const WITNESS_FRACTION = 0.5;

/**
 * ⚖️ HOW MUCH DEFERENCE COUNTS AS BEING LOOKED UP TO (S-3). At or above this,
 * a partner's attention SATISFIES the seeker's standing need — the meter is
 * cleared by being deferred to, not by being talked at. Below it the
 * conversation is company (the `social` meter) and nothing more, which is the
 * distinction the standing need exists to draw.
 */
export const STANDING_DEFER_AT = 0.35;

/** ⚖️ AN ALLY, for the security need (S-3): a partner who likes me this much is
 *  someone I am safer for having been with. The same 0.3 the regard channel
 *  treats as "worth saying" — a feeling below it is not one you would count on.
 *
 *  EXPORTED because the HOST must ask the same question one step earlier: a
 *  partner who cannot supply this row is not a station for it (otherwise a body
 *  walks across the camp, holds a conversation, collects nothing, and walks
 *  again — the row would spin forever). The credit arm below stays as the
 *  belt-and-braces check; this constant is what keeps the two answers one
 *  answer. Same reason `STANDING_DEFER_AT` is public. */
export const SECURITY_ALLY_AT = 0.3;

/** How much standing a public loss COSTS, in meter units added (the meter rises
 *  as standing is lost). An insult and a refused order land the same; a yield —
 *  publicly giving way — costs more than either, because everyone watched you
 *  do it and it was your own act. */
const STANDING_LOSS = { insult: 0.3, orderRefused: 0.3, requestRefused: 0.2, yielded: 0.5 } as const;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const AXES = ["affinity", "trust", "authority", "fear"] as const;

/** The DELTA a nudge helper's before/after pair represents. Going through the
 *  helper and differencing (rather than re-authoring its coefficients here) is
 *  what keeps `nudgeFromGift`/`nudgeFromOutcome`/… the single owner of those
 *  numbers — and it means a delta near a bound is honestly SMALLER than the
 *  nominal coefficient, because the host will apply it to the same value. */
function diffRelation(before: Relation, after: Relation): Partial<Relation> {
  const d: Partial<Relation> = {};
  for (const ax of AXES) {
    const v = after[ax] - before[ax];
    if (v !== 0) d[ax] = v;
  }
  return d;
}

function isEmpty(delta: Partial<Relation>): boolean {
  return AXES.every((ax) => (delta[ax] ?? 0) === 0);
}

export function applySocialEvent(
  act: SocialAct,
  lookup: (observer: CreatureId, subject: CreatureId) => Relation,
  opts?: { witnessCap?: number; mood?: (cid: CreatureId) => Personality },
): SocialOutcome {
  const out: SocialOutcome = { nudges: [], facts: [], credits: [] };

  const actor = act.actor;
  const addressee = act.addressee;
  // Law ①: an author that IS the actor is no author at all.
  const author = act.author && act.author !== actor ? act.author : undefined;
  const route = act.route ?? "L";
  const m = Math.max(0, act.magnitude ?? 1);

  // Witnesses: de-duplicated, parties removed, nearest-first, then capped. The
  // parties are dropped HERE rather than trusted to the caller because a party
  // that also counted as a witness would collect its edge twice.
  const cap = Math.max(0, opts?.witnessCap ?? WITNESS_CAP);
  const wit: CreatureId[] = [];
  for (const w of act.witnesses) {
    if (!w || w === actor || w === addressee) continue;
    if (wit.includes(w)) continue;
    wit.push(w);
    if (wit.length >= cap) break;
  }

  const nudge = (observer: CreatureId | undefined, subject: CreatureId | undefined, delta: Partial<Relation>): void => {
    if (!observer || !subject || observer === subject) return; // law ①
    if (isEmpty(delta)) return;
    out.nudges.push({ observer, subject, delta });
  };
  /** Fan a delta out over the capped witness list, toward one subject. */
  const witNudge = (subject: CreatureId | undefined, delta: Partial<Relation>): void => {
    for (const w of wit) nudge(w, subject, delta);
  };
  /** Run a relation through one of relations.ts' semantic nudges and emit the
   *  difference as a directed delta. */
  const semantic = (
    observer: CreatureId | undefined,
    subject: CreatureId | undefined,
    fn: (rel: Relation) => Relation,
  ): void => {
    if (!observer || !subject || observer === subject) return;
    const before = lookup(observer, subject);
    nudge(observer, subject, diffRelation(before, fn(before)));
  };
  const credit = (cid: CreatureId | undefined, key: "social" | "standing" | "security", v: { delta?: number; levelAfter?: number }): void => {
    if (!cid) return;
    out.credits.push({ cid, key, ...v });
  };

  switch (act.kind) {
    case "attend": {
      // Company: symmetric and small. The two parties' `social` meters clear
      // whatever else is true — being with somebody IS the satisfier.
      nudge(actor, addressee, { affinity: 0.03 });
      nudge(addressee, actor, { affinity: 0.03 });
      credit(actor, "social", { levelAfter: 0 });
      credit(addressee, "social", { levelAfter: 0 });
      // …but STANDING and SECURITY are only met if the partner's own attitude
      // supplies them. ⚖️ The satisfier of a social need is ANOTHER ENTITY'S
      // ACT, and an act that was not what you needed does not count.
      const partnerToSeeker = lookup(addressee, actor);
      if (deference(partnerToSeeker, opts?.mood?.(addressee)) >= STANDING_DEFER_AT) {
        credit(actor, "standing", { levelAfter: 0 });
      }
      if (partnerToSeeker.affinity >= SECURITY_ALLY_AT) {
        credit(actor, "security", { levelAfter: 0 });
      }
      break;
    }
    case "thank": {
      nudge(addressee, actor, { affinity: 0.04 });
      nudge(actor, addressee, { affinity: 0.04, trust: 0.02 });
      credit(addressee, "standing", { levelAfter: 0 });
      break;
    }
    case "praise": {
      nudge(addressee, actor, { affinity: 0.05 * m });
      // Hearsay reaches AFFINITY only (⚖️ hearsay never moves authority): the
      // bystanders think better of the praised body, they do not start obeying it.
      witNudge(addressee, { affinity: 0.02 * m });
      credit(addressee, "standing", { levelAfter: 0 });
      break;
    }
    case "insult": {
      nudge(addressee, actor, { affinity: -0.1, trust: -0.03 });
      witNudge(actor, { affinity: -0.03 });
      // Standing LOST ⇒ the meter RISES. Unanswered, for now — answering an
      // insult is a later round's act.
      credit(addressee, "standing", { delta: STANDING_LOSS.insult });
      break;
    }
    case "threaten": {
      semantic(addressee, actor, (rel) => nudgeFromThreat(rel, { credibility: m }));
      // The one place `WITNESS_FRACTION` is applied literally: a bystander's
      // fear is exactly half the threatened party's (0.20 · m ⇒ 0.10 · m).
      witNudge(actor, { fear: WITNESS_FRACTION * 0.2 * m });
      break;
    }
    case "yield": {
      // The yielder's own edge toward the winner — and the ROUTE decides what it
      // buys (prestige raises standing, dominance raises fear).
      semantic(actor, addressee, (rel) => nudgeFromYield(rel, { route }));
      witNudge(addressee, route === "L" ? { trust: 0.03 } : { fear: 0.03 });
      // 🚨 A YIELD IS PUBLISHED. This is the act that seeds the regard channel:
      // everyone who saw it — AND both parties — now holds the belief that the
      // yielder respects (or fears) the winner, which is exactly the fact a
      // third body can later repeat. Reputation is these facts plus the book;
      // there is no reputation number.
      const fact: Fact = {
        kind: "regard",
        observer: actor,
        subject: addressee,
        sentiment: route === "L" ? "respect" : "fear",
      };
      for (const viewer of [actor, addressee, ...wit]) out.facts.push({ viewer, fact });
      credit(addressee, "standing", { levelAfter: 0 });
      credit(actor, "standing", { delta: STANDING_LOSS.yielded });
      break;
    }
    case "apologize": {
      nudge(addressee, actor, { affinity: 0.05, trust: 0.02 });
      break;
    }
    case "side": {
      nudge(addressee, actor, { affinity: 0.06, trust: 0.03 });
      nudge(act.third, actor, { affinity: -0.06 });
      // Being taken up for is the security need's satisfier, exactly.
      credit(addressee, "security", { levelAfter: 0 });
      break;
    }
    case "gift":
    case "help": {
      semantic(addressee, actor, (rel) => nudgeFromGift(rel, m));
      // Law ②: the AUTHOR of the help is trusted for it, the actor is liked.
      nudge(addressee, author, { trust: 0.03 });
      witNudge(actor, { affinity: 0.02 });
      witNudge(author, { trust: 0.01 });
      break;
    }
    case "harm": {
      nudge(addressee, actor, { affinity: -0.15, fear: 0.1 });
      witNudge(actor, { fear: WITNESS_FRACTION * 0.1, affinity: -0.05 });
      break;
    }
    case "order-done": {
      // M1 — THE AUTHORITY PRODUCER. It fires on the OUTCOME, from the actor's
      // side, toward the author.
      if (route === "C") {
        // Law ③: coerced compliance earns nothing but resentment.
        nudge(actor, author, { affinity: -0.02 });
      } else {
        semantic(actor, author, (rel) => nudgeFromOutcome(rel, { helped: true, magnitude: m }));
      }
      witNudge(author, { trust: 0.02 });
      break;
    }
    case "order-failed": {
      semantic(actor, author, (rel) => nudgeFromOutcome(rel, { helped: false, magnitude: m }));
      break;
    }
    case "order-refused": {
      // A refusal only costs the author standing IF SOMEBODY SAW IT. An order
      // nobody heard refused is a private disagreement.
      if (wit.length > 0) credit(author, "standing", { delta: STANDING_LOSS.orderRefused });
      witNudge(author, { trust: -0.01 });
      break;
    }
    case "request-granted": {
      // actor = the granter, addressee = the requester.
      nudge(addressee, actor, { affinity: 0.04 });
      break;
    }
    case "request-refused": {
      if (wit.length > 0) credit(addressee, "standing", { delta: STANDING_LOSS.requestRefused });
      break;
    }
  }

  return out;
}

/**
 * ⚖️ M1's GATE, AND THE ONE COPY OF IT — who (if anyone) an order's outcome is
 * about. Every seat that retires a piece of ordered work asks the same three
 * questions, so they are asked HERE rather than once per seat (a pooled task
 * retiring, a pull slice dying, a director's commit):
 *
 *  ① A SELF-ISSUED ROW. `applySocialEvent` refuses the self-edge anyway;
 *    stopping here says why — a body that authored its own errands and
 *    collected the authority for finishing them would bootstrap a chief out of
 *    nothing.
 *  ② A ROW NOBODY SPOKE. Every civic sweep posts as the local player, so an
 *    ambient row would make the spirit chief of a town it never addressed.
 *    `spoken` separates "somebody asked" from "the ledger noticed".
 *  ③ AN ISSUER THAT IS NOT A PERSON — `"world"` (absolute laws), a site or
 *    civic bill id, anything with no body and no creature row. There is nobody
 *    for the actor's edge to point at. The CALLER answers `issuerIsPerson`,
 *    because only the host knows who has a body.
 */
export function orderOutcomeParties(
  row: { issuer: string; claimedBy?: string | null; spoken?: boolean },
  issuerIsPerson: boolean,
): { actor: CreatureId; author: CreatureId } | null {
  const actor = row.claimedBy ?? "";
  const author = row.issuer;
  if (!actor || !author || actor === author) return null; // ①
  if (!row.spoken) return null; // ②
  if (author === "world" || !issuerIsPerson) return null; // ③
  return { actor, author };
}

/**
 * ⚖️ L-4 — WAS THE POINT ANY GOOD? The one expression BOTH halves of a
 * delegation's window read, so the sweep that fails an order and the claim that
 * completes it cannot disagree about where the window's edge is.
 *
 * A delegation is a CLAIM ABOUT THE WORLD ("there is work over there"), and the
 * follower's own next claim is the evidence. Three states, and the third is the
 * one worth spelling:
 *
 *  ① STILL WALKING (`arrivedAt` unset). The sweep says nothing — a body on the
 *    way has not yet been given the chance to disagree. A CLAIM in this state
 *    is `order-done` all the same: taking the work before you even got there is
 *    the strongest possible confirmation the pile was worth pointing at.
 *  ② INSIDE THE WINDOW. A claim completes it; the sweep leaves it open.
 *  ③ PAST THE WINDOW. The sweep fails it — pointing at an empty pile costs the
 *    leader (M1's whole point: being right about what the town needs is the
 *    skill). And a claim that arrives AFTER the edge earns the leader NOTHING:
 *    the body stood there doing nothing for a whole decide window and then
 *    found work of its own, which is a coincidence and not obedience. Returning
 *    `null` there leaves the row for the sweep to fail rather than crediting it.
 *
 * ⚠️ `windowS` is the caller's decide window (`CONTRIBUTE_IDLE_DECIDE_S`) —
 * never a constant of this module. The window is "how long until this body
 * would have re-decided anyway", which only the host's own loop knows.
 */
export function orderWindowOutcome(
  order: { arrivedAt?: number },
  now: number,
  windowS: number,
  event: "claim" | "sweep",
): "order-done" | "order-failed" | null {
  if (order.arrivedAt === undefined) return event === "claim" ? "order-done" : null; // ①
  const lapsed = now - order.arrivedAt > windowS;
  if (!lapsed) return event === "claim" ? "order-done" : null; // ②
  return event === "claim" ? null : "order-failed"; // ③
}
