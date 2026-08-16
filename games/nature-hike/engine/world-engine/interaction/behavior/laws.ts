/**
 * laws.ts (interaction) — the behavior layer's face of the LAW SUBSTRATE.
 *
 * The pure core (Law rows, tiers, areas, governingLaw resolution) lives in
 * the KERNEL (`kernel/laws.ts`) so `SerializedTownDeltas` can persist
 * authored rows without an interaction import. This module re-exports it
 * and adds the one bridge that needs behavior vocabulary: GoalSpec → the
 * lexicon verb a law can forbid.
 */

import type { GoalSpec } from "./rules.js";

export {
  absoluteLaws, addLaw, absolutelyForbidden, governingLaw,
  type AreaRef, type AreaTest, type Law, type LawTier,
} from "../../kernel/laws.js";

// ── Goal → verb (the veto's vocabulary bridge) ─────────────────────────────

/** The lexicon verb a GoalSpec answers to, for law checks — null when the
 *  goal has no single forbidding word yet (extend as laws need it; an
 *  unmapped goal is never vetoed by accident). */
export function goalVerb(goal: GoalSpec): string | null {
  switch (goal.kind) {
    case "goTo": case "goHome": return "go";
    case "follow": return "follow";
    case "fetch": return "get";
    case "give": return "give";
    case "putIn": return "put";
    case "build": return "build";
    case "trade": return "trade";
    case "area": return "area";
    case "help": return "help";
    default: return null;
  }
}
