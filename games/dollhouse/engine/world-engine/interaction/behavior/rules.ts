// shared/world-engine/interaction/behavior/rules.ts
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
} from "@shared/world-engine/interaction/behavior/creatures.js";
import { compliance, type Relation } from "@shared/world-engine/interaction/behavior/relations.js";
import type { Personality } from "@shared/world-engine/interaction/behavior/personality.js";

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
export type PlaceRef =
  | { kind: "home" }
  | { kind: "named"; id: string }
  | { kind: "creature"; id: CreatureId }
  | { kind: "point"; x: number; y: number }; // a concrete ground point (a gaze "there")

/** An item a goal names — either an EXACT instance (`id`, for a specific need item)
 *  or a PREDICATE (`match`, "any food"). The world resolver turns it into a concrete
 *  item id (goal-selection.ts). */
export type ItemRef = { id: ItemId } | { match: NeedTarget };

/** WHO a goal is to be done WITH ("eat with Mara", "we eat together").
 *
 *  ⚠️ Company is a MODIFIER on an ordinary goal, never a goal of its own —
 *  there is no `eatTogether` primitive and there must never be one. A
 *  companion-marked `satisfy` is still "satisfy your hunger"; the marker only
 *  says WHOSE CONTEXT it shares, which is precisely what a ritual coordinates
 *  (rituals.ts: a ritual introduces no new action).
 *
 *  `group` is the SPEAKER'S OWN GROUP — what "we"/"us" names — left unresolved
 *  here because only the world knows who is in it (a party, a household, the
 *  body the player is riding). It is also the one shape a formless player can
 *  honestly utter: the spirit is nobody's roster member, but it HAS a group. */
export type CompanionSpec =
  | { kind: "creatures"; ids: CreatureId[] }
  | { kind: "group" };

/** The spatial relation a PLACEMENT preserves from the sentence (construction
 *  v1 — "put chair NEAR table"). `at` = a bare point destination ("put it
 *  here"). The vocabulary is deliberately the parser's relation set; the
 *  world layer maps it onto the placement search.
 *
 *  `beside` and `near` are the PROXIMITY PAIR, and they mean different
 *  searches — the same distinction the workstation registry already draws with
 *  its `besideAnchor` rule, now sayable. `beside` ("next to the table") is the
 *  ADJACENT band: right against the anchor's footprint, nothing further out.
 *  `near` SCALES with the room: any feasible spot in the anchor's vicinity,
 *  ranked by how close it got. Scope-agnostic: the same vocabulary later
 *  parameterizes city-scale build orders ("build house near well"). */
export type PlacementRel = "in" | "on" | "near" | "beside" | "under" | "over" | "behind" | "front" | "at";

/** WHERE a placement lands: a relation + the anchor it's relative to. */
export interface PlacementRef {
  relation: PlacementRel;
  anchor: PlaceRef;
}

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
  // FETCH: reach the item and take it into hand. `from` = an explicit SOURCE
  // ("take ball from box", "take from dog") — the resolver restricts matching
  // instances to that endpoint (in the container / at the place / held by the
  // creature), and an objectless take-from resolves to whatever the source
  // holds. Absent ⇒ nearest match anywhere (the classic fetch).
  | { kind: "fetch"; item: ItemRef; from?: PlaceRef }
  | { kind: "give"; item: ItemRef; to: CreatureId }
  | { kind: "putIn"; item: ItemRef; container: PlaceRef }
  // DROP (physical carrying): set the HELD item down where you stand — the
  // bare "drop X" with no named destination. Distinct from `putIn` (a named
  // container) — this is the release primitive, reusing the ground-putdown
  // the `place` step already performs when no container is in reach.
  | { kind: "drop"; item: ItemRef }
  | { kind: "toggle"; device: ItemRef; state: string }
  | { kind: "transform"; item: ItemRef; state: string }
  // SATISFY a self-need (eat / rest / sleep / play). `with` marks it as a
  // SHARED act — the host routes it through the company machinery (a ritual)
  // instead of the solo satisfy. Same need, same performance, different
  // context; see CompanionSpec for why this is a field and not a verb.
  | { kind: "satisfy"; need: string; with?: CompanionSpec }
  // REST at a station ("go to bed", "rest at the chair"): occupy the fixture and
  // DWELL there posed — sleep at a bed, play at a box, else sit. The pursuit
  // walks to the station, then the dwell primitive holds + poses the body.
  // Distinct from `satisfy` (which raises a resident's meter and hands off to
  // the need walker): this drives the DWELL directly through the pursuit engine,
  // so it works for any commanded body, and is the shape a need-derived rest
  // will emit once needs become self-assigned commands (S2).
  // `dwellS` = seconds the dwell holds (a need-born rest passes its motive's
  // dwell — a nap is longer than a commanded sit); absent = the command default.
  // `pose` OVERRIDES the executor's fixture-derived pose (a doze in the open is
  // a SLEEP, fun's toy-play is a PLAY — no fixture nearby to say so).
  | { kind: "rest"; place: PlaceRef; dwellS?: number; pose?: "sleep" | "sit" | "play" }
  // OPEN / SHUT a container LID ("open the chest", "shut the box"): a first-class
  // primitive over the physical lid state (`heldOpen`), NOT a creature-world
  // device toggle. A command PINS the lid open (stays open with nobody near).
  // Capability-gated — a graspless body (a pet) can't work a lid, so the plan
  // blocks with the honest reason. (Doors are a later increment.)
  | { kind: "setOpen"; place: PlaceRef; open: boolean }
  // WEAR / EQUIP a garment ("wear the shirt"): pick up a clean garment and put
  // it ON — the one being worn comes off as a `.dirty` unit (the laundry chain's
  // first link). Distinct from bare "wear" (the dress self-care motive): this
  // equips the NAMED garment, through the pursuit engine, for any commanded body.
  | { kind: "wear"; item: ItemRef }
  // COLOR / recolor an item ("color the shirt red"): pick up the item, carry it
  // to a coloring tub (a water barrel/bath doubling as the dye vat), and swap its
  // colour facet (`shirt.color_blue` → `shirt.color_red`; a colourless `shirt` →
  // `shirt.color_red`). GENERIC — the same verb recolours a garment now and any
  // tintable object later (variations.withVariation is kind-agnostic). `color` is
  // a `color_*` value from the colour dimension.
  | { kind: "color"; item: ItemRef; color: string }
  // CONVERSE with a creature ("talk to Mara"): walk to the partner and EXCHANGE
  // (gossip spreads, relations warm, both loneliness meters ease). Distinct from
  // bare "talk" (the social self-care motive that seeks any housemate) — this
  // targets the NAMED partner, through the pursuit engine.
  | { kind: "converse"; target: CreatureId }
  // CONSUME a SPECIFIC item ("eat the banana", "drink the juice"): go to the
  // named thing (or eat from hand) and use it up. Distinct from `satisfy`
  // (the abstract hunger/thirst motive served by the need machinery) — this
  // acts on the ITEM the player pointed at, so it works for any creature the
  // command reaches, not only household residents with a firing meter.
  // `at` = DINING preference (station kinds, in order): when present and such a
  // station resolves nearby, the plan carries the item there and eats seated —
  // the need templates' `satisfy.at` riding the pursuit engine (S2). Absent
  // (every spoken "eat X"), the item is consumed where it lies — unchanged.
  | { kind: "consume"; item: ItemRef; at?: readonly string[] }
  // THE STACK ECONOMY'S TWO MANIPULATION PRIMITIVES (S3 — "take N = WITHDRAW ×N,
  // deposit N = STOW ×N"; the economy is a units count, not new machinery):
  // walk to the source/container and move `units` of `category` between it and
  // WHAT THE BODY IS CARRYING — the container in its hands or on its back, or,
  // with neither, one whole thing in its hands (scope-unification.md §2.1). The
  // executor delegates to the needs walker's own effects, which own the doors.
  // `affords` selects by FUNCTION instead of category (fun's toy). `tplKey`
  // names the need row acting (kind selection, strike keys, logs) — a spoken
  // command would omit it. Both are TERMINAL micro-goals: one leg + one act,
  // then the SELECTOR (decideNeeds) chooses the next leg — exactly the legacy
  // walker's bounded-step granularity, now driven by the unified pursuit.
  | { kind: "takeUnits"; from: PlaceRef; category: string; units: number; affords?: string; tplKey?: string }
  | { kind: "putUnits"; into: PlaceRef; category: string; units: number; tplKey?: string }
  // The DWELLED stack-transform (S3 slice 2 — the wash at the tub, the pot at
  // the oven): walk to the station, dwell the work out posed, and the facet
  // edit (`drop` dirty / `add` hot) lands on every matching carried unit.
  | { kind: "processUnits"; at: PlaceRef; category: string; drop?: string; add?: string; dwellS?: number; tplKey?: string }
  // In-place stack acts: put the carried garment ON (the change of clothes —
  // doffs the worn one as a `.dirty` unit in hand), or set carried units DOWN
  // as real loose props at the feet (the unload row's "put it down" answer).
  | { kind: "equipUnits"; category: string; tplKey?: string }
  | { kind: "dropUnits"; category: string; units: number; tplKey?: string }
  // EAT WHAT YOU ARE CARRYING (S4): consume one carried unit of `category` — at
  // the dining station when `at` resolves (the seat show), else where you stand.
  // The single-item `consume` can't express this: it plans toward an item the
  // resolver can SEE in the world, and a body's own carry is not on that list.
  | { kind: "consumeUnits"; category: string; at?: readonly string[]; tplKey?: string }
  // A ONE-SHOT CONTACT/ATTENTION act at another body: walk to the target, and
  // the act lands on arrival. `hug` is the warmth beat; `show` is the ATTENTION
  // beat, and it is the reason this variant carries an optional `item`.
  //
  // ⚖️ THE LAW OF THE SHOWN THING: A SHOWN THING IS PRESENTED, NEVER
  // TRANSFERRED. `show` holds the item UP — it stays in the shower's hands, the
  // target's attention snaps to it, and one knowledge beat lands ("you have
  // that"). The moment it changes hands it is `give`, which is a different word
  // one board press away and a different outcome (the child loses the ball).
  // So this field is an act ARGUMENT, never a transfer endpoint: no arm of the
  // executor may move it, and `give` may never be reached from here.
  | { kind: "socialAct"; target: CreatureId; act: string; item?: ItemRef }
  | { kind: "help"; target: CreatureId } // adopt the target's surfaced need (the general on-behalf rule)
  // PLACE furniture (construction v1): stand `item` at a spot the world's
  // placement search picks near/in `at` — GUIDANCE, not coordinates: the
  // creature weighs the spot by the same rules the house generator obeys.
  | { kind: "place"; item: ItemRef; at: PlacementRef }
  | { kind: "build"; structure: string; cap: number } // cap = max increments per fire (bounds civ-scale orders)
  // MAKE A MOBILE ITEM (toys-and-song-expansion.md): craft `glyph` through the
  // construction pipeline's craft job — real inputs off real stacks, the labor
  // clock, the bench discount, and an honest wait (with a haul, then the
  // construction chain) when a material is missing. The sibling of `build`:
  // `build` raises something that STAYS PUT, `craft` makes something you can
  // pick up. Both verbs reach both goals — "make" and "build" are
  // interchangeable and differ only in which they try FIRST (intent-compile) —
  // so a child who says the wrong one still gets the thing. Host-routed like
  // `build`: the craft is house-scoped work, not a body errand.
  | { kind: "craft"; glyph: string; cap: number }
  // THE TWO ROOM VERBS (construction ④, construction-structures.md §Demolishing
  // or Changing Rooms), spoken instead of pressed: `demolish` takes the room
  // down whole ("break the bedroom"), `emptyRoom` takes only its furniture out
  // and leaves the walls standing ("empty the kitchen"). `room` is the SPOKEN
  // WORD, resolved by the host against the focused building's plan exactly as
  // `build` resolves `structure` against the catalog — a goal never carries
  // world ids, and which building is meant is the host's scope question, not
  // the parser's. Host-routed: both post a DESIGNATION for builders to work,
  // never a body errand.
  | { kind: "demolish"; room: string }
  | { kind: "emptyRoom"; room: string }
  // BREAK ONE PIECE ("break the bed") — `place`'s exact inverse, and it carries
  // the same ItemRef for the same reason: the piece is named by KIND and the
  // host finds a standing one. Host-routed like the room verbs.
  | { kind: "breakPiece"; item: ItemRef }
  // WORK A CONSTRUCTION SITE (pipeline ⑥): stand at the staged site and
  // BUILD — labor banks only while builders are present, and more of them
  // build faster (capped). `site` = "f:<ord>" (a founded building) or
  // "a:<ord>" (a pending annex/interior room). Host-routed like `build`.
  | { kind: "buildwork"; site: string }
  // An AREA CHARTER (city-expansion ③): designate the ISSUER's focus area
  // for one structure category ("area farm here"); null = clear the ground
  // back to undesignated ("area none"). The area is the issuer's focus circle
  // at order time — the host's brush, never geometry on the goal. Host-routed
  // like `build`: a charter is world policy, not a body errand.
  // (The spoken word is `area`, not `zone` — `area` is the registry's territory
  // noun. The zoning KERNEL keeps its `zone` geometry names; this is vocabulary.)
  | { kind: "area"; category: string | null }
  // A STOCK TRANSFER (city-expansion ②): execute transfer agreement
  // `agreementId` (kernel/town/transfer.ts — the mutation row holds the
  // endpoints). `goods` + `to` ride along so the intent line can be phrased
  // without the ledger ("I'll put the wood in the yard"). Host-routed like
  // `build` — never a compileGoal body errand.
  | { kind: "transfer"; agreementId: string; goods: Record<string, number>; to: PlaceRef }
  // INTERCITY BARTER (city-expansion ⑤): "trade wood with the city" —
  // `give` = what we send; `take` = what we ask back (null = the town's
  // worst shortage, the clerk says the terms either way); `partner` = the
  // spoken partner word (null = the bound trade partner). Host-routed like
  // `area`: the exchange is town policy — the ratio quote, the willingness
  // gate and the caravan are the host's, never a body errand.
  | { kind: "trade"; give: string; take: string | null; partner: string | null };

/**
 * ★ ⑫⑧ — STOP AND FACE SOMEBODY. ★
 *
 * `target` is a FELLOW MEMBER of the speaker's own conversation, and the goal
 * is a turn IN PLACE: no walk, no reach, no station. (`converse` is the one
 * that walks to a partner and exchanges; this buys the *channel*, which is the
 * whole of conversation-in-motion law ②.) Its price is one turn of the circle
 * — see the host's `ADDRESS_DWELL_S`.
 *
 * 🚨 IT IS DELIBERATELY NOT A `GoalSpec`, AND THAT IS ONE OF THE CHAPTER'S TWO
 * FREE CONSEQUENCES MADE STRUCTURAL. `GoalSpec` is "the CLOSED set of goal
 * primitives a RULE ACTION may compile to" — the vocabulary a player-authored
 * rule and a spoken command are written in. **An order is not negotiable**:
 * you cannot tell somebody to stop and face somebody, because stopping to face
 * somebody is the thing a creature decides FOR ITSELF against its own work
 * (the consolidation's north star read backwards — only a self-assigned
 * command can be un-assigned). Keeping `address` out of the command vocabulary
 * is that law expressed in the type system rather than in a guard somebody has
 * to remember: a `source: "command"` pursuit can never carry one.
 */
export type AddressGoal = { kind: "address"; target: CreatureId };

/**
 * WHAT A PURSUIT MAY DRIVE — the command vocabulary plus the goals a creature
 * can only ever assign itself. The unified `pursue` loop, the planner and the
 * plan pricer all speak this; `GoalSpec` alone stays the AUTHORING vocabulary
 * (rules, spoken orders, and the intent lines that read them back).
 */
export type PursuitGoal = GoalSpec | AddressGoal;

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
