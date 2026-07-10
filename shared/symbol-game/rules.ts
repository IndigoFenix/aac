// shared/symbol-game/rules.ts
//
// Player-authored STANDING RULES — Axis B (society-rules.md), the world-sim mirror
// of a one-shot command. A rule is a CONDITIONAL GOAL: "when <condition>, <action>",
// bound to a creature / role / everyone. Crucially it is NOT set in stone — a rule
// competes with the creature's OWN needs as a weighted CANDIDATE, and its weight is
// scaled by how the bound creature regards whoever issued it (relations.ts,
// `compliance`). A resented commander's rule rarely wins; a trusted one's does.
//
// This module is PURE: the Rule type, the closed CONDITION vocabulary, the closed
// (bounded) GOAL vocabulary, the condition evaluator, and the candidate producer.
// Time comes from the world clock's condition set (world-clock.ts `worldConditions`)
// — creatures.ts stays time-free. Lifetime bookkeeping (`edge`/`until` transitions,
// removal) is a THIN stateful wrapper the living loop owns; the pure core here
// answers only "does this rule fire right now, and at what weight".

import type {
  CreatureId,
  CreatureState,
  CreatureWorld,
  ItemId,
  ItemState,
  NeedTarget,
} from "./creatures.js";
import { compliance, type Relation } from "./relations.js";
import type { Personality } from "./personality.js";

// ---------------------------------------------------------------------------
// Bindings, conditions, goals — closed vocabularies
// ---------------------------------------------------------------------------

/** WHO obeys a rule. `group` is resolved by a LIVE membership query (a new farmer
 *  inherits "farmers eat when hungry"); `all` is everyone at the rule's scope. */
export type RuleBinding =
  | { kind: "agent"; id: CreatureId }
  | { kind: "group"; role: string }
  | { kind: "all" };

/** WHEN a rule applies — a pure predicate over world state. Mirrors the causal
 *  `Clause` vocabulary (creatures.ts) plus the one new family, `worldState`
 *  (day/night/weather), which is what non-monotone living time buys us. */
export type Condition =
  | { kind: "creatureState"; state: string } // self is cold/hungry/tired…
  | { kind: "itemState"; item: NeedTarget; state: string } // a matching item carries the state ("window open")
  | { kind: "possession"; item: NeedTarget; have: boolean } // self has / lacks a matching item
  | { kind: "worldState"; token: string } // "night"/"day"/"rain" — from the world clock
  | { kind: "presence"; place: string } // self is at a place  (resolved by the world layer)
  | { kind: "social"; event: "asked" | "threatened" }; // reuses the React tier

/** The connective the child tapped picks the lifetime (society-rules.md §5):
 *   • while  (`when`)  — the goal WHILE the condition holds.
 *   • edge   (`if`)    — fires ONCE per rising edge; re-arms when the condition clears.
 *   • until  (`until`) — the goal UNTIL the condition becomes true, then self-removes. */
export type RuleLifetime = "while" | "edge" | "until";

/** A place the sim can resolve to a point. `home` is the creature's own home. */
export type PlaceRef = { kind: "home" } | { kind: "named"; id: string } | { kind: "creature"; id: CreatureId };

/** An item a goal names — either an EXACT instance (`id`, for a specific need item)
 *  or a PREDICATE (`match`, "any food"). The world resolver turns it into a concrete
 *  item id (goal-selection.ts). */
export type ItemRef = { id: ItemId } | { match: NeedTarget };

/**
 * The CLOSED set of goal primitives a rule action may compile to (society-rules.md
 * §2). Each is a BOUNDED goal — one destination, one transfer, one toggle, one
 * capped build increment — so a rule can never install an unbounded/oscillating
 * goal. Anything the parser can't map into this set is rejected at authoring.
 */
export type GoalSpec =
  | { kind: "goTo"; place: PlaceRef }
  | { kind: "goHome" }
  | { kind: "follow"; target: CreatureId }
  | { kind: "stay"; place?: PlaceRef }
  | { kind: "fetch"; item: ItemRef }
  | { kind: "give"; item: ItemRef; to: CreatureId }
  | { kind: "putIn"; item: ItemRef; container: PlaceRef }
  | { kind: "toggle"; device: ItemRef; state: string }
  | { kind: "transform"; item: ItemRef; state: string }
  | { kind: "satisfy"; need: string } // eat / rest / sleep — a self-need
  | { kind: "build"; structure: string; cap: number }; // cap = max increments per fire (bounds civ-scale orders)

export interface Rule {
  id: string;
  /** WHO issued it — a creature id (the player is one). Drives compliance: the
   *  bound creature weighs the rule by how it regards THIS author. */
  author: CreatureId;
  binding: RuleBinding;
  trigger: Condition;
  lifetime: RuleLifetime;
  action: GoalSpec;
  /** Base pull of this rule BEFORE compliance scaling — comparable to a need's
   *  `value` (needs are ~2–5). Default DEFAULT_RULE_PRIORITY. */
  priority?: number;
  /** Sit ABOVE ordinary needs when it fires (a standing direct command like
   *  "always follow me"). Still yields to survival needs + active conversation. */
  urgent?: boolean;
  enabled: boolean;
  /** Tie-break order within the rule band (the Rules Tray order). Lower first. */
  order: number;
  /** The authoring zoom this rule belongs to (house … civilization). */
  scope?: string;
  /** The composed causal glyph, for the tray card render. */
  sourceGlyph?: string;
}

/** Default base pull — mid-range against needs (~2–5), so a fully-compliant rule
 *  (compliance 1) competes with a moderate need and a poorly-regarded one loses. */
export const DEFAULT_RULE_PRIORITY = 3;

// ---------------------------------------------------------------------------
// Condition evaluation (pure, total)
// ---------------------------------------------------------------------------

export interface RuleContext {
  self: CreatureState;
  world: CreatureWorld;
  /** Active world-state tokens (world-clock.ts `worldConditions`) — "night"… */
  worldConditions: ReadonlySet<string>;
  /** The bound creature's intrinsic personality — tilts its compliance (an
   *  assertive creature obeys less). Absent ⇒ temperament-neutral (relation only). */
  personality?: Personality;
  /** Live role membership for `group` bindings. Absent ⇒ no creature has any role. */
  rolesOf?: (id: CreatureId) => ReadonlySet<string>;
  /** Escape hatch for conditions the pure layer can't see (presence/social live in
   *  the world/position layer). Absent ⇒ those conditions read false. */
  resolveExtra?: (cond: Condition) => boolean;
}

/** Does an item's facets satisfy a target predicate (kind/category/descriptors +
 *  live state)? Local to keep rules decoupled from the need-matching path. */
function targetMatches(item: ItemState, t: NeedTarget): boolean {
  if (t.kind && item.kind !== t.kind) return false;
  if (t.category && item.category !== t.category) return false;
  if (t.descriptors && !t.descriptors.every((d) => item.descriptors?.includes(d))) return false;
  if (t.state && !item.states.includes(t.state)) return false;
  return true;
}

/** PURE: whether the condition holds right now. Total — unknown/unsupported
 *  conditions fall to `resolveExtra` (then false), never throw. */
export function conditionHolds(cond: Condition, ctx: RuleContext): boolean {
  switch (cond.kind) {
    case "worldState":
      return ctx.worldConditions.has(cond.token);
    case "creatureState":
      return ctx.self.condition === cond.state;
    case "possession": {
      const has = Object.values(ctx.world.items).some(
        (it) => it.ownerId === ctx.self.id && targetMatches(it, cond.item),
      );
      return has === cond.have;
    }
    case "itemState": {
      const target: NeedTarget = { ...cond.item, state: cond.state };
      return Object.values(ctx.world.items).some((it) => targetMatches(it, target));
    }
    case "presence":
    case "social":
      return ctx.resolveExtra?.(cond) ?? false;
  }
}

/** Does this rule BIND to `self`? (Scope filtering is the caller's concern.) */
export function ruleBinds(rule: Rule, ctx: RuleContext): boolean {
  switch (rule.binding.kind) {
    case "agent":
      return rule.binding.id === ctx.self.id;
    case "all":
      return true;
    case "group":
      return ctx.rolesOf?.(ctx.self.id)?.has(rule.binding.role) ?? false;
  }
}

// ---------------------------------------------------------------------------
// Weighted candidates — the "not set in stone" mechanism
// ---------------------------------------------------------------------------

export type GoalSource =
  | { kind: "rule"; ruleId: string; author: CreatureId; urgent: boolean }
  | { kind: "need" }
  | { kind: "react"; partner: CreatureId }; // hard tier: answering a conversation partner

export interface GoalCandidate {
  goal: GoalSpec;
  /** Priority × compliance for a rule; the need's value for a need. Higher wins. */
  weight: number;
  source: GoalSource;
}

/**
 * A rule's candidate goal for `self`, or null if it doesn't fire for this creature
 * right now. Weight = base priority × the creature's COMPLIANCE toward the author
 * (relations.ts). A creature that doesn't recognize the author (compliance ~0)
 * yields ~0 weight — the rule can't outcompete its own needs, so it keeps doing
 * its own thing. THIS is what makes rules suggestions, not law.
 *
 * PURE and `while`-semantics only: it reports whether the condition holds NOW. The
 * living loop wraps this for `edge`/`until` (rising-edge memory, self-removal).
 */
export function ruleCandidate(
  rule: Rule,
  ctx: RuleContext,
  relationToAuthor: Relation,
): GoalCandidate | null {
  if (!rule.enabled) return null;
  if (!ruleBinds(rule, ctx)) return null;
  if (!conditionHolds(rule.trigger, ctx)) return null;
  const weight = ruleComplianceWeight(rule, ctx, relationToAuthor);
  if (weight <= 0) return null;
  return {
    goal: rule.action,
    weight,
    source: { kind: "rule", ruleId: rule.id, author: rule.author, urgent: rule.urgent ?? false },
  };
}

/**
 * A rule's action weight = base priority × the bound creature's COMPLIANCE toward the
 * author. A creature effectively self-issuing a rule (author === self) is full-weight;
 * otherwise it's the directed relation × its own temperament (personality.ts). Shared
 * by `ruleCandidate` (pure while-only) and the lifetime-aware chooser (goal-selection.ts).
 */
export function ruleComplianceWeight(rule: Rule, ctx: RuleContext, relationToAuthor: Relation): number {
  const c = rule.author === ctx.self.id ? 1 : compliance(relationToAuthor, ctx.personality);
  return (rule.priority ?? DEFAULT_RULE_PRIORITY) * c;
}

/**
 * Deterministic argmax over candidates: highest weight wins; ties break toward the
 * EARLIER candidate (callers pass rule-band candidates in tray order, needs first
 * or last per the priority-band policy of society-rules.md §6). Null if empty.
 */
export function chooseCandidate(candidates: readonly GoalCandidate[]): GoalCandidate | null {
  let best: GoalCandidate | null = null;
  for (const c of candidates) {
    if (best === null || c.weight > best.weight) best = c;
  }
  return best;
}
