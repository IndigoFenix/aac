// shared/world-engine/interaction/behavior/need-goals.ts
//
// NEED → SELF-ASSIGNED COMMAND (action-consolidation S2): the pure mapping from
// a decided need (template + intent, the walker's own choice) to the GoalSpec a
// unified pursuit drives. The consolidation's north star made literal — "a
// need-derived action is essentially a self-assigned command": SELECTION stays
// with `decideNeeds` (meters, priorities, claims, blocked surfacing), and the
// DRIVE becomes the same `pursue` loop a spoken command runs.
//
// Deliberately PARTIAL — this is the S2 slice, behind a flag:
//   • Only the CLEAN motives route (NEED_PURSUIT_MOTIVES): hunger/thirst
//     (consume-shaped), energy/waste/hygiene (rest-shaped), social (converse).
//     The stack-economy motives (provision, tidy, laundry, dress, cook, fun's
//     affordance acquire…) return [] and stay on the legacy needStep walker
//     until S3 puts `units` + reach budgets on the goal vocabulary.
//   • A body already carrying matching units in its ABSTRACT bag (needCarried)
//     returns [] too: the item resolver sees props and container stocks, never
//     the bag, so the legacy walker keeps those eats (seat show intact).
//   • The caller must COMPILE-CHECK the returned candidates in order and fall
//     through to the legacy path when none plans — that is the degradation
//     seam: market shelves and the town well are invisible to the resolver on
//     purpose (a hungry body with an empty pantry still takes its legacy
//     shopping trip, restock sizing and purse accounting included).
//
// Candidates are ORDERED (first compilable wins). A food want prefers a HOT
// unit — the cook's work is worth eating (round 7's eatOrder) — so it tries
// `state: "hot"` before plain; stacked units carry no states, so the hot pass
// finds only VISIBLE served meals (the dinner on the table), exactly the units
// the preference exists for.

import type { NeedIntent, NeedTemplate } from "@shared/world-engine/interaction/behavior/needs.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";

/** Motives (the template key's prefix before ":") that ride the unified pursuit
 *  engine. THE S2 FLAG: remove a motive to revert it to the legacy walker. */
export const NEED_PURSUIT_MOTIVES: ReadonlySet<string> = new Set([
  "hunger",
  "thirst",
  "energy",
  "waste",
  "hygiene",
  "social",
]);

export interface NeedGoalOpts {
  /** Units in the creature's ABSTRACT bag matching the template's item — > 0
   *  keeps the eat on the legacy walker (the bag is invisible to the resolver). */
  carriedMatching: number;
  /** The motive's dwell length (restDwellFor) — a nap, the privy, the scrub. */
  restDwellS: number;
  /** Where the body stands now (a restHere doze dwells in place). */
  body: { x: number; y: number };
}

/**
 * The GoalSpec candidates for one decided need, best first — [] means "not this
 * slice; run the legacy needStep path". The caller tries each with compileGoal
 * and installs the first that plans (source: "need").
 */
export function needPursuitGoals(tpl: NeedTemplate, intent: NeedIntent, opts: NeedGoalOpts): GoalSpec[] {
  const motive = tpl.key.split(":")[0]!;
  if (!NEED_PURSUIT_MOTIVES.has(motive)) return [];
  switch (intent.kind) {
    case "take":
    case "consumeAt": {
      // The acquire-and-eat family (hunger/thirst). Only CONSUME-shaped rows —
      // an equip/transform row's `take` belongs to its own legacy chain.
      if (tpl.satisfy.kind !== "consume") return [];
      if (opts.carriedMatching > 0) return []; // bag eats stay legacy (see header)
      const cat = tpl.item.category;
      if (!cat) return [];
      const at = tpl.satisfy.at;
      const mk = (match: { category: string; state?: string }): GoalSpec => ({
        kind: "consume",
        item: { match },
        ...(at ? { at } : {}),
      });
      // Food reaches for the served HOT meal first, raw as the fallback.
      return cat === "food" ? [mk({ category: cat, state: "hot" }), mk({ category: cat })] : [mk({ category: cat })];
    }
    case "restAt":
      return [{ kind: "rest", place: { kind: "named", id: intent.station.id }, dwellS: opts.restDwellS }];
    case "restHere":
      // No station — doze where the body stands (a point place; the executor
      // poses in place when no rest fixture is within reach).
      return [{ kind: "rest", place: { kind: "point", x: opts.body.x, y: opts.body.y }, dwellS: opts.restDwellS }];
    case "socialize":
      // The partner IS the station candidate (the ctx lists housemates there).
      return [{ kind: "converse", target: intent.station.id }];
    default:
      // consumeHere only fires while carrying (bag — legacy); deposit / drop /
      // equip / process are the stack economy (S3).
      return [];
  }
}
