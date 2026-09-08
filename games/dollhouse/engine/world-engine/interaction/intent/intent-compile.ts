// shared/world-engine/interaction/intent/intent-compile.ts
//
// Wires the CONCEPT PARSER to the ACTION layer: an IntentFrame (parse-intent.ts) →
// a Rule (rules.ts, for a standing `when/if/until` command) or a GoalSpec (a one-shot
// command the addressed creature performs). This is where the parser's LAZY refs
// (player/listener/gaze/entity…) get BOUND to concrete world ids — the world layer
// supplies an `IntentBinder` (salience: gaze > selection > name), so this stays pure.
//
// Only the IMPERATIVE branch compiles to actions: `rule` → Rule, `command` → GoalSpec,
// `sequence` → each clause compiled. The CONVERSATIONAL kinds (request/offer/state/ask
// + social acts) are NOT goals — they're dialogue moves that flow to projectDialogue /
// the knowledge channel (creature-knowledge.md: `state` shares a fact, `ask` queries
// one). They pass through as `dialogue` so nothing is silently dropped.

import type { CreatureId, ItemId, NeedTarget } from "@shared/world-engine/interaction/behavior/creatures.js";
import type {
  CompanionSpec,
  Condition,
  GoalSpec,
  ItemRef,
  PlaceRef,
  Rule,
  RuleBinding,
} from "@shared/world-engine/interaction/behavior/rules.js";
import { DEFAULT_RULE_PRIORITY } from "@shared/world-engine/interaction/behavior/rules.js";
import type { IntentFrame, Ref } from "@shared/world-engine/interaction/intent/parse-intent.js";
import type { EffectMatch, Precondition } from "@shared/world-engine/interaction/intent/verb-effects.js";
import {
  REST_VERBS,
  companionsOf,
  matchPhaseEffects,
  matchVerbEffects,
} from "@shared/world-engine/interaction/intent/verb-effects.js";
import { STATION_ACTS, type StationKind } from "@shared/world-engine/kernel/town/stations.js";
import { fixtureKindForWord } from "@shared/world-engine/types.js";
import { headOf } from "@shared/world-engine/variations.js";

// ---------------------------------------------------------------------------
// Binder — the world's salience resolver (the one impure input)
// ---------------------------------------------------------------------------

export interface IntentBinder {
  /** The speaker — the rule author / who "i_me" is (the child's creature id). */
  player: CreatureId;
  /** The addressed creature — who "you" is / who a command's default actor is. */
  listener?: CreatureId;
  /** Resolve a ref to a creature id (listener/player/named/gaze-creature), or null. */
  creature(ref?: Ref): CreatureId | null;
  /** Resolve a ref to an item — an exact instance or a match predicate — or null. */
  item(ref?: Ref): ItemRef | null;
  /** Resolve a ref to a place (home / named / a creature's spot), or null. */
  place(ref?: Ref): PlaceRef | null;
  /** Resolve a ref to a ROLE name (for a group binding), or null if it's not a role. */
  role(ref?: Ref): string | null;
  /** Is this ref an ANIMATE companion — somebody an act can be shared WITH?
   *  Separates "eat with Mara" (company) from "trade wood with the city" and
   *  "wash the cup with water" (a partner-in-trade and an instrument). Absent ⇒
   *  fall back to whether the ref resolves to a creature at all. */
  isCompanion?(ref?: Ref): boolean;
  /** Does the ref name FURNITURE (a placeable station kind — construction
   *  v1)? "put chair near table" places a piece; "put apple in box" stays
   *  containment. Absent ⇒ nothing is furniture (legacy behavior). */
  isFurniture?(ref?: Ref): boolean;
  /** Is the ref a CONTAINER (a chest, a box, a table surface)? `false`
   *  reroutes an "in/on" put to a placement ("put chair in kitchen" — a
   *  room is not a box). Absent/null ⇒ assume container (legacy). */
  isContainer?(ref?: Ref): boolean | null;
  /** Does the ref name a CLOTHING kind? "wear the shirt" equips that garment
   *  (the wear primitive); a non-garment "wear" stays the dress self-care
   *  motive. Absent ⇒ nothing is clothing (legacy: bare dress motive). */
  isClothing?(ref?: Ref): boolean;
  /** Does the ref name a DEVICE (a toggleable thing — a lamp, a tap)? "stop
   *  {device}" turns it off instead of halting the listener. Absent ⇒ nothing
   *  is a device (legacy: "stop X" is a plain halt). */
  isDevice?(ref?: Ref): boolean;
  /** Does the ref name a raisable STRUCTURE (the scope's build catalog)? Only
   *  consulted to break a make/build TIE — a word that is both a structure and a
   *  mobile item — so absent ⇒ nothing is a structure, and the makeable reading
   *  wins for both verbs. Scope-dependent by nature (the catalog differs in the
   *  wilderness, at a founded site and in a town), which is why it lives on the
   *  binder rather than in a static table. */
  isStructure?(ref?: Ref): boolean;
  /**
   * ⚖️ DOES THIS WORD NAME A STANDING NATURAL FEATURE somebody could be told
   * to clear — a tree, a bush, an outcrop rooted in the ground of THIS scope?
   * (user ruling 2026-09-02: break/cut/fight redirect to a removal.)
   *
   * 🚨 THIS PREDICATE IS THE WHOLE OF "`fight` DOES NOT EAT COMBAT". `fight`
   * is a real verb with a real future (combat, the chase) and it is already the
   * word the absolute taboo is written in ("we do not fight"). It gains the
   * clearing reading ONLY where this answers yes, and a body is never a
   * feature: the wilderness keeps its creatures in a different list from the
   * things rooted in its ground, so "fight the sheep" and "fight the wolf"
   * cannot reach the clearing arm however the binder is implemented. Absent ⇒
   * nothing is a feature, and all three verbs keep exactly the meanings they
   * had (legacy behavior).
   *
   * Scope-dependent by nature — what is standing differs between the town, a
   * founded site and the open wild — which is why it lives on the binder
   * rather than in a static table.
   */
  isFeature?(ref?: Ref): boolean;
}

export interface DefaultBinderOptions {
  player: CreatureId;
  listener?: CreatureId;
  /** Symbols that name a ROLE (a group), not a specific creature. */
  roles?: Iterable<string>;
  /** Symbols meaning "home" (default just "home"). */
  homeSymbols?: Iterable<string>;
  /** What the gaze is resting on right now, if the world knows (salience). */
  gazeCreature?: CreatureId | null;
  gazeItem?: ItemId | null;
  gazePlace?: PlaceRef | null;
}

/**
 * A sensible default binder: named symbols ARE ids (a creature "bear" → "bear"), an
 * entity object becomes a match predicate (`ball.big` → `{kind:"ball",descriptors:
 * ["big"]}`), "home" → the home place, listed `roles` bind as groups. The world can
 * supply gaze resolutions; without them, gaze refs stay unbound. Good for named things
 * with no world lookup — and the base a richer world binder overrides.
 */
export function defaultBinder(opts: DefaultBinderOptions): IntentBinder {
  const roles = new Set(opts.roles ?? []);
  const homes = new Set(opts.homeSymbols ?? ["home"]);
  return {
    player: opts.player,
    listener: opts.listener,
    creature(ref) {
      if (!ref) return null;
      switch (ref.kind) {
        case "player": return opts.player;
        case "listener": return opts.listener ?? null;
        case "entity": return ref.symbol;
        case "gaze": return ref.of === "entity" ? opts.gazeCreature ?? null : null;
        default: return null;
      }
    },
    item(ref) {
      if (!ref) return null;
      if (ref.kind === "gaze" && ref.of === "entity") return opts.gazeItem != null ? { id: opts.gazeItem } : null;
      if (ref.kind === "entity") {
        return { match: { kind: ref.symbol, ...(ref.modifiers.length ? { descriptors: ref.modifiers } : {}) } };
      }
      return null;
    },
    place(ref) {
      if (!ref) return null;
      if (ref.kind === "entity") return homes.has(ref.symbol) ? { kind: "home" } : { kind: "named", id: ref.symbol };
      if (ref.kind === "gaze" && ref.of === "point") return opts.gazePlace ?? null;
      if (ref.kind === "player") return { kind: "creature", id: opts.player };
      if (ref.kind === "listener" && opts.listener) return { kind: "creature", id: opts.listener };
      return null;
    },
    role(ref) {
      if (!ref) return null;
      if (ref.kind === "group") return ref.role ?? null;
      if (ref.kind === "entity" && roles.has(ref.symbol)) return ref.symbol;
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type CompiledIntent =
  | { kind: "rule"; rule: Rule }
  | {
      kind: "goal";
      goal: GoalSpec;
      actor: CreatureId;
      /**
       * ⚖️ THE GENERAL COMPANION RULE (semantic-gaps 9 — "do anything
       * together"). WHO the order is to be carried out WITH, from a
       * `with`-marked companion, a `we` subject or a bare `together` —
       * `companionsOf`, the same helper and the same animacy gate the shared
       * `satisfy` has always used, now asked for EVERY goal kind. "go home with
       * Mara" and "get the ball with Pip" used to drop the partner on the floor;
       * the name the child said now survives the compile.
       *
       * The host fans the goal out to the companions, party-style, at the
       * member-resolution seat (wave-3 B3) — this layer stays pure and names
       * them, it does not issue anything. `satisfy` keeps `goal.with` for the
       * RITUAL path: a shared need is one performance two bodies attend, not the
       * same solo goal handed to each, and the goal vocabulary already says so.
       * The two agree wherever both are present (identical `CompanionSpec`).
       */
      companions?: CompanionSpec;
      /**
       * WHAT THE COMPILED READING ASSUMED — the matched row's `precond` with
       * `$verb` resolved (semantic-behavior.md §6). Absent when the row asserts
       * nothing, which is almost every row. The host checks these before it
       * acts, and a failure IS the reply it speaks ("stop eating" to a body that
       * is not eating ⇒ `i_me + eat.not`), never a silent halt on nothing.
       */
      preconditions?: Precondition[];
    }
  | { kind: "sequence"; items: CompiledIntent[] }
  | { kind: "dialogue"; frame: IntentFrame } // a conversational move — not an action
  /** A PROHIBITION ("no + fight") — the host installs it as a Law row
   *  (laws.ts); area/tier/issuer are the host's to assign. */
  | { kind: "law"; forbid: string; frame: IntentFrame }
  | { kind: "unbound"; reason: string; frame: IntentFrame };

export interface CompileMeta {
  /** Rule id (the caller mints it — this module is pure/Date-free). */
  id: string;
  order?: number;
  scope?: string;
  priority?: number;
  urgent?: boolean;
}

// ---------------------------------------------------------------------------
// Verb → GoalSpec vocabulary
// ---------------------------------------------------------------------------
//
// ⚖️ IT IS A DATA TABLE NOW, and it lives in `verb-effects.ts`. What used to be
// a 22-arm `switch (frame.verb)` below — plus the six lexical tables and the
// three helpers the arms shared — is an ORDERED list of `{guards, effect, roles}`
// rows per verb, evaluated first-match. The row order IS the old arm order, and
// that is what makes the move byte-identical (44k frame × binder cases are
// frozen in server/tests/world-engine/fixtures/verb-effects-golden.json and
// replayed by verb-effects.test.ts).
//
// The tables are re-exported here because they were public API of this module
// (`SELF_NEEDS` is read by the surfacing layer) and because a caller looking for
// "what does this verb mean" should still find the door on the compiler.

export {
  CATEGORY_NEEDS,
  DEFAULT_ROWS,
  INGEST_VERBS,
  PHASE_ROWS,
  REST_VERBS,
  SELF_NEEDS,
  STATION_RELATIONS,
  TRANSFORM_STATE,
  UNMAPPED_VERBS,
  VERB_EFFECTS,
  applyVerbEffects,
  companionsOf,
  matchPhaseEffects,
  matchVerbEffects,
  pickColorFacet,
  quantityCap,
  verbEffectRows,
} from "@shared/world-engine/interaction/intent/verb-effects.js";
export type {
  EffectMatch,
  Guard,
  Precondition,
  RefSrc,
  RoleSrc,
  VerbEffectRow,
} from "@shared/world-engine/interaction/intent/verb-effects.js";

/** The verb a station is FOR — the first act its registry row declares. Null for
 *  anything that is not a station, or one that declares none. */
function stationActOf(ref: Ref | undefined): string | null {
  if (ref?.kind !== "entity" && ref?.kind !== "unresolved") return null;
  const kind = fixtureKindForWord(headOf(ref.symbol));
  const acts = kind ? STATION_ACTS[kind as StationKind] : undefined;
  return acts?.[0] ?? null;
}

/**
 * The action clause (verb + object/target) → a bounded GoalSpec, or null if it can't
 * be bound. For movement, a bare noun after the verb is the DESTINATION (object), so
 * "go home" reads home as the place; for manipulation the object is the item and the
 * target (via a relation) is the recipient/container.
 *
 * COMPANY rides an activity, it never replaces one: a `with`-marked companion
 * or a `joint` frame marks the compiled `satisfy` as SHARED and changes nothing
 * else about it. That is the whole of "do it together" at this layer — the goal
 * is still the ordinary need, and the host routes a marked one through the
 * gathering machinery rather than the solo path.
 *
 * The GENERAL companion rule (semantic-gaps 9 — `with` on ANY command) rides
 * `CompiledIntent.companions` instead, because a shared `goHome` is not a
 * different goal the way a shared `satisfy` is: see `compileActionParts`.
 * `goal.with` is therefore exactly what it has always been, on exactly the one
 * kind that has ever carried it.
 */
export function compileAction(frame: IntentFrame, binder: IntentBinder): GoalSpec | null {
  return compileActionParts(frame, binder)?.goal ?? null;
}

/**
 * The same compile, keeping EVERYTHING the reading produced: the goal, the
 * preconditions the matched row asserted, and the company the sentence named.
 *
 * ⚖️ COMPANY IS GATHERED ONCE, FOR EVERY KIND. `companionsOf` is asked on every
 * compiled command now, not only where a `satisfy` could absorb it — the partner
 * in "go home with Mara" is data the sentence carries and dropping it was never
 * a decision, only a gap. Where the goal IS a `satisfy`, the ritual field
 * `goal.with` is still set exactly as before (byte-identical GoalSpec — the
 * golden fixture replays `compileAction`), and `companions` repeats it rather
 * than replacing it: one fact, two readers, and the host's ritual path keeps the
 * shape it knows.
 */
export function compileActionParts(
  frame: IntentFrame,
  binder: IntentBinder,
): { goal: GoalSpec; preconditions?: Precondition[]; companions?: CompanionSpec } | null {
  const match = compileBareAction(frame, binder);
  if (!match) return null;
  const company = companionsOf(frame, binder);
  const goal = match.goal.kind === "satisfy" && company ? { ...match.goal, with: company } : match.goal;
  return {
    goal,
    ...(match.preconditions ? { preconditions: match.preconditions } : {}),
    ...(company ? { companions: company } : {}),
  };
}

/**
 * THE COMPILER LOOP. The PHASE rows, one intercept, then the verb's own rows —
 * all three out of the effect TABLE (verb-effects.ts): the first row whose
 * guards all hold binds its roles out of the frame, and nothing matching means
 * null, the explicit not-understood the host speaks rather than a guessed act.
 */
function compileBareAction(frame: IntentFrame, binder: IntentBinder): EffectMatch | null {
  const v = frame.verb;
  if (!v) return null;
  // PHASE "stop" ("stop + eat"): cease the activity — a DATA row now
  // (`PHASE_ROWS`), walked before the verb's own because the phase speaks about
  // the activity, not about what `eat` means. Same `{kind:"stay"}` halt the
  // intercept emitted (the goal vocabulary still has no per-activity cancel; the
  // phase rides the frame so the echo can still say "stop eating") — what the
  // row adds is the PRECONDITION it assumed, `doing($verb)`, whose failure is
  // the reply "I am not eating" rather than a halt landing on nothing.
  const phase = matchPhaseEffects(frame, binder);
  if (phase) return phase;
  // USE BORROWS THE STATION'S OWN VERB (2026-08-25). `use` names no act: what
  // "use the oven" means is what an oven is FOR, and the station registry
  // already says (`STATION_ACTS`: oven → cook, bed → sleep, chair → sit). So the
  // frame is rewritten to that verb and compiled as if the child had said it —
  // one meaning, stated once, on the row that owns it. A thing with no acts row
  // (a ball) has nothing to be "used" for, and the order is refused in words
  // rather than compiled into a guess. It stays an INTERCEPT rather than a row
  // because it is the one reading that RE-ENTERS the table with another verb.
  if (v === "use") {
    const act = stationActOf(frame.object);
    return act ? compileBareAction({ ...frame, verb: act }, binder) : null;
  }
  return matchVerbEffects(frame, binder);
}

// ---------------------------------------------------------------------------
// Clause → Condition (the rule trigger)
// ---------------------------------------------------------------------------

/**
 * A condition clause → a rule Condition. Heuristic over the parsed shape:
 *   • `have`/`have.not X`      → possession
 *   • entity + state modifier  → itemState ("window open")
 *   • bare state modifier      → creatureState on the bound creature ("hungry")
 *   • bare entity token        → worldState ("night", "rain")
 */
export function compileCondition(clause: IntentFrame, binder: IntentBinder): Condition | null {
  // Conditions reference item KINDS (a predicate), so build a NeedTarget from the
  // entity ref directly rather than binding to a specific instance.
  const target = (ref?: Ref): NeedTarget | null =>
    ref?.kind === "entity" ? { kind: ref.symbol, ...(ref.modifiers.length ? { descriptors: ref.modifiers } : {}) } : null;

  const obj = clause.object;
  if (clause.verb === "have") {
    const item = target(obj);
    return item ? { kind: "possession", item, have: !clause.negated } : null;
  }
  if (obj?.kind === "entity") {
    // A STATE rides the entity's `.` modifier (window.open) or a standalone attribute
    // token → itemState; item is the bare KIND (the state is not a descriptor).
    const state = obj.modifiers[0] ?? clause.modifiers[0];
    if (state) return { kind: "itemState", item: { kind: obj.symbol }, state };
    return { kind: "worldState", token: obj.symbol }; // a bare token: night / rain
  }
  if (clause.modifiers.length > 0) {
    // A bare attribute on the bound creature ("hungry", "cold").
    return { kind: "creatureState", state: clause.modifiers[0]! };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Binding (who obeys a rule)
// ---------------------------------------------------------------------------

export function compileBinding(subject: Ref | undefined, binder: IntentBinder): RuleBinding {
  const asAgent = (): RuleBinding => ({ kind: "agent", id: binder.listener ?? binder.player });
  if (!subject) return asAgent();
  switch (subject.kind) {
    case "listener":
      return asAgent();
    case "player":
      return { kind: "agent", id: binder.player };
    case "companions":
      return { kind: "all" };
    case "group": {
      const r = binder.role(subject);
      return r ? { kind: "group", role: r } : { kind: "all" };
    }
    case "entity": {
      const r = binder.role(subject); // a known role → group; else a named creature → agent
      if (r) return { kind: "group", role: r };
      const c = binder.creature(subject);
      return c ? { kind: "agent", id: c } : asAgent();
    }
    case "gaze": {
      const c = binder.creature(subject);
      return c ? { kind: "agent", id: c } : asAgent();
    }
    default:
      return asAgent();
  }
}

// ---------------------------------------------------------------------------
// Top-level compile
// ---------------------------------------------------------------------------

export function compileRule(frame: IntentFrame, binder: IntentBinder, meta: CompileMeta): Rule | null {
  if (frame.kind !== "rule" || !frame.condition || !frame.lifetime) return null;
  // Anaphora: a transitive action with no object of its own refers to the item named
  // in the condition ("if window.open, shut [it]" → shut the window). Borrow the
  // condition's item KIND, stripped of its state modifier (we act on the window, not
  // on "open").
  //
  // A POSTURE verb never borrows: it is COMPLETE bare, so a borrowed token would be
  // read as its STATION — "when night, sleep" is a bedtime rule, not an order to
  // sleep at the night. The transitive verbs the anaphora was written for are
  // unaffected; only the verbs with nothing to do with an object opt out.
  const condObj = frame.condition.object;
  const actionFrame =
    !frame.object && condObj?.kind === "entity" && !REST_VERBS.has(frame.verb ?? "")
      ? { ...frame, object: { kind: "entity" as const, symbol: condObj.symbol, modifiers: [] } }
      : frame;
  const action = compileAction(actionFrame, binder);
  const trigger = compileCondition(frame.condition, binder);
  if (!action || !trigger) return null;
  return {
    id: meta.id,
    author: binder.player,
    binding: compileBinding(frame.subject, binder),
    trigger,
    lifetime: frame.lifetime,
    action,
    priority: meta.priority ?? DEFAULT_RULE_PRIORITY,
    urgent: meta.urgent,
    enabled: true,
    order: meta.order ?? 0,
    scope: meta.scope,
    sourceGlyph: frame.raw.join(" + "),
  };
}

/**
 * Compile a parsed intent into an executable form. Imperative kinds become a Rule or a
 * GoalSpec; conversational kinds pass through as `dialogue` (handled by projectDialogue
 * / the knowledge channel). A `sequence` compiles each clause.
 */
export function compileIntent(frame: IntentFrame, binder: IntentBinder, meta: CompileMeta): CompiledIntent {
  switch (frame.kind) {
    case "rule": {
      const rule = compileRule(frame, binder, meta);
      return rule ? { kind: "rule", rule } : { kind: "unbound", reason: "rule did not bind", frame };
    }
    case "command": {
      // Everything the reading produced travels together: the act, what it
      // assumed (preconditions), and who it is to be done with (companions).
      const parts = compileActionParts(frame, binder);
      const actor = binder.creature(frame.subject) ?? binder.listener ?? binder.player;
      // (Key order kept as it was — `kind, goal, actor` — so a serialised
      // CompiledIntent is unchanged wherever the sentence names neither.)
      return parts
        ? {
            kind: "goal",
            goal: parts.goal,
            actor,
            ...(parts.preconditions ? { preconditions: parts.preconditions } : {}),
            ...(parts.companions ? { companions: parts.companions } : {}),
          }
        : { kind: "unbound", reason: "command did not bind", frame };
    }
    case "forbid":
      return frame.verb
        ? { kind: "law", forbid: frame.verb, frame }
        : { kind: "unbound", reason: "forbid did not bind", frame };
    case "sequence":
      return {
        kind: "sequence",
        items: (frame.clauses ?? []).map((c, i) => compileIntent(c, binder, { ...meta, id: `${meta.id}.${i}` })),
      };
    default:
      // greet / affirm / ask / state / request / offer / … — a conversational move.
      return { kind: "dialogue", frame };
  }
}
