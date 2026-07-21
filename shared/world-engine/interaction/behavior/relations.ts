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

import type { CreatureId } from "@shared/world-engine/interaction/behavior/creatures.js";
import { personalityComplianceFactor, type Personality } from "@shared/world-engine/interaction/behavior/personality.js";

/**
 * A directed attitude from an OBSERVER toward a SUBJECT. Three orthogonal axes,
 * each chosen because it moves compliance differently:
 *   • affinity  — do I LIKE you (−1 hostile … 0 neutral … +1 devoted).
 *   • trust     — do I believe your guidance is SOUND (0 … 1).
 *   • authority — do I recognize your RIGHT to direct me (0 … 1): a tamed pet, a
 *                 chief, a parent. This is the primary command driver; the others
 *                 modulate it.
 */
export interface Relation {
  affinity: number; // −1..1
  trust: number; // 0..1
  authority: number; // 0..1
}

/** A neutral acquaintance: no bond, mild default trust, no recognized authority. */
export const DEFAULT_RELATION: Relation = { affinity: 0, trust: 0.3, authority: 0 };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);
const clampSigned = (v: number): number => clamp(v, -1, 1);

/**
 * The relation a creature EXTENDS to a stranger, derived from its own genome
 * (mirrors social-bot `deriveParams`: warmth → rapport/valence baseline). A warm
 * creature greets strangers with goodwill; a guarded one starts near zero.
 * AUTHORITY is always 0 — a right to command is earned in play, never innate.
 */
export function baselineRelation(personality: Personality): Relation {
  return makeRelation({
    affinity: (personality.warmth - 0.5) * 0.6, // −0.3..+0.3
    trust: DEFAULT_RELATION.trust + (personality.openness - 0.5) * 0.3, // 0.15..0.45
    authority: 0,
  });
}

/** Normalize (clamp) a possibly-out-of-range relation. */
export function makeRelation(partial: Partial<Relation> = {}): Relation {
  return {
    affinity: clampSigned(partial.affinity ?? DEFAULT_RELATION.affinity),
    trust: clamp01(partial.trust ?? DEFAULT_RELATION.trust),
    authority: clamp01(partial.authority ?? DEFAULT_RELATION.authority),
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
  const base = W_AUTHORITY * clamp01(rel.authority) + W_TRUST * clamp01(rel.trust);
  const willingness = (clampSigned(rel.affinity) + 1) / 2; // 0..1
  const gate = AFFINITY_FLOOR + (1 - AFFINITY_FLOOR) * willingness;
  const temperament = personality ? personalityComplianceFactor(personality) : 1;
  const earned = clamp01(base * gate * temperament);
  const floor = personality ? clamp01(personality.obedience) : 0;
  // Floor + earned-on-top: obedience 1 pins compliance at 1; obedience 0 leaves the
  // pure earned weight (backward-compatible with the pre-dial behavior).
  return clamp01(floor + (1 - floor) * earned);
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

// ---------------------------------------------------------------------------
// Relation book — directed store with a default fallback
// ---------------------------------------------------------------------------

/** observer id → (subject id → relation). Absent entries read as DEFAULT_RELATION. */
export type RelationBook = Record<CreatureId, Record<CreatureId, Relation>>;

export function createRelationBook(): RelationBook {
  return {};
}

/** The observer's attitude toward the subject; DEFAULT_RELATION if none recorded.
 *  A creature's relation to itself is irrelevant (it never commands itself) — not
 *  special-cased. */
export function getRelation(
  book: RelationBook,
  observer: CreatureId,
  subject: CreatureId,
): Relation {
  return book[observer]?.[subject] ?? DEFAULT_RELATION;
}

/** Set (replace) a directed relation. Returns the SAME book, mutated — the book is
 *  live sim state the world owns, not a value passed through pure reducers. */
export function setRelation(
  book: RelationBook,
  observer: CreatureId,
  subject: CreatureId,
  rel: Relation,
): RelationBook {
  (book[observer] ??= {})[subject] = makeRelation(rel);
  return book;
}

/** Apply a nudge in place (get → nudge → set). Convenience for event handlers. */
export function nudgeInBook(
  book: RelationBook,
  observer: CreatureId,
  subject: CreatureId,
  delta: Partial<Relation>,
): RelationBook {
  return setRelation(book, observer, subject, nudgeRelation(getRelation(book, observer, subject), delta));
}
