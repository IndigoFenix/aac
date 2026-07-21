/**
 * placement-will.ts — WILL THE CREATURE PLACE IT THERE? (construction v1)
 *
 * The placement mirror of willingness.ts's generosity gate: a directed
 * "put the chair near the table" is GUIDANCE, not an RTS order. The
 * kernel's placement search (kernel/town/placement.ts) supplies the
 * candidates — spots that are physically POSSIBLE, each scored by the
 * same aesthetic rules the house generator obeys — and this gate decides
 * the creature's answer, in three grades:
 *
 *   place   — a spot clears the creature's taste (natural), or falls
 *             short but the requester's standing overrides mild distaste
 *             (obliging — the obedience floor at work).
 *   cannot  — no feasible spot at all: "I cannot — because <reason>".
 *             The reason is the kernel's machine-readable failure.
 *   wont    — feasible but it strains sensibilities past what compliance
 *             overrides: "I don't want to — because <factor>".
 *
 * Pure and deterministic; the caller (quest-host) pre-gates ownership
 * ("not-mine" — placing in a stranger's house) and stock ("have-not")
 * before ever running the search.
 */

import { compliance, type Relation } from "./relations.js";
import type { Personality } from "./personality.js";
import type {
  PlacementFactor,
  PlacementFailure,
  RatedSpot,
} from "@shared/world-engine/kernel/town/placement.js";

export type PlaceResponse =
  | { kind: "place"; spot: RatedSpot; reason: "natural" | "obliging" }
  | { kind: "cannot"; reason: PlacementFailure | "not-mine" | "have-not" }
  | { kind: "wont"; reason: PlacementFactor };

/** A spot scoring at least this is NATURAL — the creature simply agrees.
 *  (The generator's own placements score well above it — the parity
 *  test's floor is 0.35 for the tightest hovels.) */
export const NATURAL_FLOOR = 0.55;

export interface PlaceWillInput {
  /** The kernel search's feasible spots, best-first (placementCandidates). */
  candidates: ReadonlyArray<RatedSpot>;
  /** The dominant kernel failure when `candidates` is empty (the caller
   *  probes placementFeasible at the anchor for it). */
  failure?: PlacementFailure;
  /** The creature's relation to the REQUESTER (relations.ts) — authority
   *  and trust are what override mild distaste. Absent ⇒ a stranger. */
  relation?: Relation;
  personality?: Personality;
}

export function willingnessToPlace(input: PlaceWillInput): PlaceResponse {
  const best = input.candidates[0];
  if (!best) return { kind: "cannot", reason: input.failure ?? "service" };
  if (best.score >= NATURAL_FLOOR) return { kind: "place", spot: best, reason: "natural" };
  // Below the taste floor: compliance shrinks the shortfall the creature
  // will still swallow. A fully-compliant family member (obedience floor
  // 1) obliges ANY feasible spot; a stranger's request only lands on
  // genuinely natural ones.
  const comp = input.relation ? compliance(input.relation, input.personality) : 0;
  const threshold = NATURAL_FLOOR * (1 - comp);
  if (best.score >= threshold) return { kind: "place", spot: best, reason: "obliging" };
  return { kind: "wont", reason: best.gripe ?? "crowded" };
}
