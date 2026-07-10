// shared/symbol-game/intent-compile.ts
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

import type { CreatureId, ItemId, NeedTarget } from "./creatures.js";
import type {
  Condition,
  GoalSpec,
  ItemRef,
  PlaceRef,
  Rule,
  RuleBinding,
} from "./rules.js";
import { DEFAULT_RULE_PRIORITY } from "./rules.js";
import type { IntentFrame, Ref } from "./parse-intent.js";

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
  | { kind: "goal"; goal: GoalSpec; actor: CreatureId }
  | { kind: "sequence"; items: CompiledIntent[] }
  | { kind: "dialogue"; frame: IntentFrame } // a conversational move — not an action
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

/** State a transform verb applies (fire→hot, water→cold…). */
const TRANSFORM_STATE: Record<string, string> = {
  heat: "hot", cook: "hot", cool: "cold", wash: "clean", fill: "full", empty: "empty",
};
const SELF_NEEDS = new Set(["eat", "drink", "rest", "sleep"]);

function quantityCap(q?: string): number {
  switch (q) {
    case "two": return 2;
    case "three": return 3;
    case "many": return 3;
    default: return 1; // "more"/"one"/absent → one increment
  }
}

/**
 * The action clause (verb + object/target) → a bounded GoalSpec, or null if it can't
 * be bound. For movement, a bare noun after the verb is the DESTINATION (object), so
 * "go home" reads home as the place; for manipulation the object is the item and the
 * target (via a relation) is the recipient/container.
 */
export function compileAction(frame: IntentFrame, binder: IntentBinder): GoalSpec | null {
  const v = frame.verb;
  if (!v) return null;
  const item = () => binder.item(frame.object);
  const destRef = frame.target ?? frame.object; // movement: object doubles as destination

  switch (v) {
    case "go":
    case "come": {
      const place = binder.place(destRef);
      if (place?.kind === "home") return { kind: "goHome" };
      if (place) return { kind: "goTo", place };
      const c = binder.creature(destRef);
      return c ? { kind: "goTo", place: { kind: "creature", id: c } } : null;
    }
    case "follow": {
      const c = binder.creature(frame.object) ?? binder.creature(frame.target);
      return c ? { kind: "follow", target: c } : null;
    }
    case "stay":
    case "wait":
    case "stop":
      return { kind: "stay", place: binder.place(frame.target) ?? undefined };
    case "get":
    case "take": {
      const it = item();
      return it ? { kind: "fetch", item: it } : null;
    }
    case "give": {
      const it = item();
      const to = binder.creature(frame.target);
      return it && to ? { kind: "give", item: it, to } : null;
    }
    case "put":
    case "drop": {
      const it = item();
      const container = binder.place(frame.target);
      return it && container ? { kind: "putIn", item: it, container } : null;
    }
    case "open":
    case "close": {
      const it = item();
      return it ? { kind: "toggle", device: it, state: v === "open" ? "open" : "closed" } : null;
    }
    case "make":
    case "build": {
      const s = frame.object?.kind === "entity" ? frame.object.symbol : null;
      return s ? { kind: "build", structure: s, cap: quantityCap(frame.quantity) } : null;
    }
    default: {
      if (v in TRANSFORM_STATE) {
        const it = item();
        return it ? { kind: "transform", item: it, state: TRANSFORM_STATE[v]! } : null;
      }
      if (SELF_NEEDS.has(v)) return { kind: "satisfy", need: v };
      return null;
    }
  }
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
  // in the condition ("if window.open, close [it]" → close the window). Borrow the
  // condition's item KIND, stripped of its state modifier (we act on the window, not
  // on "open").
  const condObj = frame.condition.object;
  const actionFrame =
    !frame.object && condObj?.kind === "entity"
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
      const goal = compileAction(frame, binder);
      const actor = binder.creature(frame.subject) ?? binder.listener ?? binder.player;
      return goal ? { kind: "goal", goal, actor } : { kind: "unbound", reason: "command did not bind", frame };
    }
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
