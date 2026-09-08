// shared/world-engine/interaction/behavior/relations.ts
//
// How one creature REGARDS another — the attitude that decides whether a command
// is obeyed. Society rules are NOT set in stone (society-rules.md §0): a rule the
// player installs is a SUGGESTION weighted by how the bound creature feels about
// whoever issued it. A trusted, liked, respected commander is followed; a resented
// stranger is largely ignored — the creature keeps acting on its own needs.
//
// A relation is DIRECTED (A→B need not equal B→A) and pure DATA. The player is a
// creature id like any other, so "how the bear regards the player" is just one more
// relation. This module owns the attitude and the compliance it produces; the
// goal-selection loop (rules.ts) multiplies a rule's action weight by compliance.
//
// SEAM with debts: creatures.ts already tracks transactional `debts`/`gratitude`.
// That is LEDGER (what I owe you); this is ATTITUDE (how I feel about you). They
// interact — receiving a gift should nudge affinity/trust up (nudgeFromGift) — but
// stay separate: a debt is settled and gone, an attitude persists.

import { personalityComplianceFactor, type Personality } from "@shared/world-engine/interaction/behavior/personality.js";

/**
 * A directed attitude from an OBSERVER toward a SUBJECT. Four orthogonal axes,
 * each chosen because it moves compliance differently:
 *   • affinity  — do I LIKE you (−1 hostile … 0 neutral … +1 devoted).
 *   • trust     — do I believe your guidance is SOUND (0 … 1).
 *   • authority — do I recognize your RIGHT to direct me (0 … 1): a tamed pet, a
 *                 chief, a parent. This is the primary command driver; the others
 *                 modulate it.
 *   • fear      — THE EXPECTED COST OF DEFYING YOU (0 … 1), the SECOND route to
 *                 compliance (interpersonal-politics.md §2c, owner's ruling ③).
 *                 Deliberately NOT "authority with a minus sign": authority is
 *                 obeyed because it is RECOGNIZED, fear because defiance is
 *                 expected to hurt — and the two earn and decay from opposite
 *                 events, which is why coerced compliance never earns authority.
 *                 REQUIRED on the interface, so no relation can quietly omit the
 *                 axis and read as "unafraid" by accident; `fear: 0` (the default
 *                 everywhere) makes `deference` collapse EXACTLY onto
 *                 `compliance`, which is what lets the axis land inert.
 */
export interface Relation {
  affinity: number; // −1..1
  trust: number; // 0..1
  authority: number; // 0..1
  fear: number; // 0..1
}

/** A neutral acquaintance: no bond, mild default trust, no recognized authority,
 *  nothing to be afraid of. */
export const DEFAULT_RELATION: Relation = { affinity: 0, trust: 0.3, authority: 0, fear: 0 };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);
const clampSigned = (v: number): number => clamp(v, -1, 1);

/**
 * The relation a creature EXTENDS to a stranger, derived from its own genome
 * (mirrors social-bot `deriveParams`: warmth → rapport/valence baseline). A warm
 * creature greets strangers with goodwill; a guarded one starts near zero.
 * AUTHORITY is always 0 — a right to command is earned in play, never innate.
 * FEAR is always 0 for the same reason, from the other side: a stranger has not
 * yet threatened you, and a world where the timid are born afraid of everyone
 * would coerce before it had done anything.
 */
export function baselineRelation(personality: Personality): Relation {
  return makeRelation({
    affinity: (personality.warmth - 0.5) * 0.6, // −0.3..+0.3
    trust: DEFAULT_RELATION.trust + (personality.openness - 0.5) * 0.3, // 0.15..0.45
    authority: 0,
    fear: 0,
  });
}

/** Normalize (clamp) a possibly-out-of-range relation. */
export function makeRelation(partial: Partial<Relation> = {}): Relation {
  return {
    affinity: clampSigned(partial.affinity ?? DEFAULT_RELATION.affinity),
    trust: clamp01(partial.trust ?? DEFAULT_RELATION.trust),
    authority: clamp01(partial.authority ?? DEFAULT_RELATION.authority),
    fear: clamp01(partial.fear ?? DEFAULT_RELATION.fear),
  };
}

// Compliance weighting. Authority + trust form the BASE willingness to obey; a
// low-authority stranger commands little even if trusted. Affinity then acts as a
// GATE (a factor), so a resented commander is resisted even WITH standing, and a
// beloved one is followed a bit past their formal authority. Tuned so:
//   neutral stranger (a0 t0.3 auth0)      → ~0.06  (near-ignored)
//   own pet         (a0.7 t0.8 auth0.9)   → ~0.79  (reliably obeys)
//   resented boss   (a−0.9 t0.3 auth0.9)  → ~0.28  (drags its feet)
const W_AUTHORITY = 0.65;
const W_TRUST = 0.35;
// Affinity gate: at affinity −1 the base is scaled to AFFINITY_FLOOR, at +1 to 1.
const AFFINITY_FLOOR = 0.4;

/**
 * How willing the observer is to obey a command from the subject, 0..1. Multiplied
 * into a rule's action weight in the goal-selection loop — 0 means "the rule never
 * outcompetes my own needs", 1 means "I treat it as my own strong motive".
 *
 * The RELATION (directed, per-pair) is the earned, relational component. An optional
 * PERSONALITY (intrinsic, per-creature — personality.ts) shapes it two ways:
 *   • `obedience` sets a FLOOR — innate deference to any commander regardless of
 *     relationship. At 0 (human default) obedience is fully earned; at 1 (a drone)
 *     compliance is pinned high no matter who commands. The relation adds on TOP.
 *   • the affect traits (assertiveness/patience/warmth) TILT the earned component.
 * So a drone, a soldier, a person, and a wild creature differ only by these dials —
 * no character types. Omit personality for the pure relational weight.
 */
export function compliance(rel: Relation, personality?: Personality): number {
  const earned = earnedCompliance(rel, personality);
  const floor = obedienceFloor(personality);
  // Floor + earned-on-top: obedience 1 pins compliance at 1; obedience 0 leaves the
  // pure earned weight (backward-compatible with the pre-dial behavior).
  return clamp01(floor + (1 - floor) * earned);
}

/** THE EARNED ROUTE, `L` — `base · gate · temperament`, clamped. Lifted OUT of
 *  `compliance` verbatim (same operations, same order, same floats) so that
 *  `deference` can noisy-OR against the pre-floor number without a second copy
 *  of the arithmetic drifting from this one. `compliance`'s value is unmoved. */
function earnedCompliance(rel: Relation, personality?: Personality): number {
  const base = W_AUTHORITY * clamp01(rel.authority) + W_TRUST * clamp01(rel.trust);
  const willingness = (clampSigned(rel.affinity) + 1) / 2; // 0..1
  const gate = AFFINITY_FLOOR + (1 - AFFINITY_FLOOR) * willingness;
  const temperament = personality ? personalityComplianceFactor(personality) : 1;
  return clamp01(base * gate * temperament);
}

function obedienceFloor(personality?: Personality): number {
  return personality ? clamp01(personality.obedience) : 0;
}

/**
 * ⚖️ HOW MUCH PRESSURE FULL EXPOSURE ADDS to the coerced route. 1 = being
 * watched by an audience that will follow through DOUBLES the coerced term
 * (Kakkar & Sivanathan on threat and deference under public scrutiny; owner's
 * ruling ③ ratifies the two-route form). Ordinary calls pass no `pressure` at
 * all, so this constant only bites where the host has something real to say
 * about exposure — it is a shape, not a pacing dial.
 */
export const K_PRESSURE = 1;

/**
 * DEFERENCE — compliance with the SECOND route wired in (owner's ruling ③, the
 * RATIFIED noisy-OR of interpersonal-politics.md §3a):
 *
 *   L = the EARNED route  (authority + trust, gated by affinity, tilted by temperament)
 *   C = the COERCED route = clamp01(fear · certainty · (1 + K_PRESSURE · pressure))
 *   d = 1 − (1 − L)(1 − C)          — either route alone suffices; neither cancels the other
 *   → clamp01(obedience + (1 − obedience) · d)
 *
 * `certainty` is the ONE thing the host must answer about a threat: "would my
 * defiance be SEEN, and followed through?" — not how scary the threatener is.
 * Scariness is already IN `fear` (a threat that was never backed never raised
 * it), so passing credibility here would double-count it. The host hands
 * witnessed ∈ {0,1}.
 *
 * 🚨 THE IDENTITY THAT LETS THIS LAND INERT. `certainty` defaults to 0 and
 * every relation ships `fear: 0`, so C is 0 on every existing path and this
 * returns `compliance(rel, personality)` — not "to within an epsilon", EXACTLY,
 * because the C = 0 case returns through compliance's own expression rather
 * than through `1 − (1 − L)` (which is a DIFFERENT float for most L). Every
 * gate can therefore migrate from `compliance` to `deference` one at a time
 * with the numbers provably unmoved.
 */
export function deference(
  rel: Relation,
  personality?: Personality,
  ctx?: { certainty?: number; pressure?: number },
): number {
  const earned = earnedCompliance(rel, personality);
  const floor = obedienceFloor(personality);
  const certainty = clamp01(ctx?.certainty ?? 0);
  const pressure = Math.max(0, ctx?.pressure ?? 0);
  const coerced = clamp01(clamp01(rel.fear) * certainty * (1 + K_PRESSURE * pressure));
  // No coerced route ⇒ the noisy-OR collapses; return through compliance's own
  // expression so the identity is exact rather than nearly-exact.
  if (!(coerced > 0)) return clamp01(floor + (1 - floor) * earned);
  const d = 1 - (1 - earned) * (1 - coerced);
  return clamp01(floor + (1 - floor) * d);
}

/**
 * Nudge a relation by deltas, clamped. The world layer calls this on events —
 * this module stays event-agnostic (it doesn't know WHY), so the same primitive
 * serves gifts, obeyed-and-it-helped, harm, betrayal.
 */
export function nudgeRelation(rel: Relation, delta: Partial<Relation>): Relation {
  return makeRelation({
    affinity: rel.affinity + (delta.affinity ?? 0),
    trust: rel.trust + (delta.trust ?? 0),
    authority: rel.authority + (delta.authority ?? 0),
    fear: rel.fear + (delta.fear ?? 0),
  });
}

/** Semantic helper: receiving something valued raises affinity (and a little
 *  trust). Ties the attitude layer to the shipped debt/gratitude events — the
 *  world calls this from the same path that records a debt. `value` is the item's
 *  value-to-me; the nudge saturates so a single lavish gift can't max the bond. */
export function nudgeFromGift(rel: Relation, value: number): Relation {
  const v = Math.max(0, value);
  return nudgeRelation(rel, {
    affinity: 0.08 * v,
    trust: 0.03 * v,
  });
}

/**
 * M1 — AUTHORITY IS EARNED BY OUTCOME (influence-and-authority.md M1). The
 * ACTOR's edge toward the AUTHOR moves by whether doing as it was told actually
 * HELPED: an order that worked is the only evidence a right to direct exists,
 * and an order that didn't is the only thing that takes it away (⚖️ authority
 * decays only on CONTRADICTED EXPECTATIONS).
 *
 * `nudgeFromGift`'s shape, deliberately: same signature style, same saturating
 * clamp, so the two ways a bond is built read the same in the host. Authority
 * moves faster than trust because trust is a claim about JUDGMENT, which one
 * errand barely speaks to.
 *
 * 🚨 THIS IS THE ONLY AUTHORITY PRODUCER besides `yield` and an appointment.
 * Hearsay must never reach it (`priorFromRegard` moves trust/affinity/fear and
 * pointedly not authority), and a COERCED completion must never call it at all
 * (owner's ruling ③ — the caller suppresses it on route "C").
 */
export function nudgeFromOutcome(
  rel: Relation,
  opts: { helped: boolean; magnitude?: number },
): Relation {
  const m = Math.max(0, opts.magnitude ?? 1);
  return opts.helped
    ? nudgeRelation(rel, { authority: 0.06 * m, trust: 0.02 * m })
    : nudgeRelation(rel, { authority: -0.04 * m, trust: -0.02 * m });
}

/**
 * A THREAT raises fear and costs liking — the two halves of what a threat
 * actually buys. `credibility` (0..1) is how much the threatener could plausibly
 * follow through; an empty threat moves fear barely at all, which is what makes
 * fear an EARNED axis rather than a spoken one (a threat that was never backed
 * never raised it).
 *
 * The affinity cost is FLAT: being threatened at all is the insult, and a more
 * credible threat is not a smaller one.
 */
export function nudgeFromThreat(rel: Relation, opts: { credibility: number }): Relation {
  const c = clamp01(opts.credibility);
  return nudgeRelation(rel, { fear: 0.2 * c, affinity: -0.08 });
}

/**
 * THE YIELDER'S OWN EDGE toward whoever it yielded to — and WHICH ROUTE carried
 * the yield decides what it buys (Cheng et al. on prestige vs dominance: both
 * produce deference, only prestige produces liking).
 *   • "L" (earned/prestige) — I gave way because I RECOGNIZE you ⇒ authority.
 *   • "C" (coerced/dominance) — I gave way because defying you would cost me ⇒
 *     more fear and LESS liking. Never authority: ⚖️ coerced compliance never
 *     earns the right to command.
 */
export function nudgeFromYield(rel: Relation, opts: { route: "L" | "C" }): Relation {
  return opts.route === "L"
    ? nudgeRelation(rel, { authority: 0.08 })
    : nudgeRelation(rel, { fear: 0.08, affinity: -0.04 });
}
