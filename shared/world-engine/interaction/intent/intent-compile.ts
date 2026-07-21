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
  Condition,
  GoalSpec,
  ItemRef,
  PlaceRef,
  PlacementRel,
  Rule,
  RuleBinding,
} from "@shared/world-engine/interaction/behavior/rules.js";
import { DEFAULT_RULE_PRIORITY } from "@shared/world-engine/interaction/behavior/rules.js";
import type { IntentFrame, Ref } from "@shared/world-engine/interaction/intent/parse-intent.js";

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

/** State a transform verb applies (fire→hot, water→cold…). */
const TRANSFORM_STATE: Record<string, string> = {
  heat: "hot", cook: "hot", cool: "cold", wash: "clean", clean: "clean", fill: "full", empty: "empty",
};
// Self-care verbs → a `satisfy` goal the actor's own need machinery serves:
// eat/drink/sleep/rest the founding motives, play the fun motive (box),
// talk the social motive (seek a housemate and chat), wash/brush_teeth the
// hygiene motive (the bath), clean the tidy chore, sit/wake_up body poses,
// wear the dress motive (a change of clothes from the wardrobe).
// NOTE `wash`/`clean` WITH an object stay transforms ("wash the cup"); the
// BARE verb is self-care ("you wash") — see compileAction's default arm.
const SELF_NEEDS = new Set([
  "eat", "drink", "rest", "sleep", "play", "talk",
  "wash", "clean", "brush_teeth", "sit", "wake_up", "wear",
]);
// INGEST verbs: a NAMED object is the thing to consume, so the order acts on
// that specific item (fetch it) rather than raising the abstract need. Bare,
// they stay self-care (above). Kept narrow — "eat the apple" has an
// unambiguous item reading; "play"/"wear" with an object are left to the
// need machinery until a targeted use/equip primitive exists.
const INGEST_VERBS = new Set(["eat", "drink"]);
// VERB × OBJECT-CATEGORY dispatch (language-expansion.md): a household chore
// named by its category object routes to the matching NEED TEMPLATE, not an
// item transform — "wash the clothes" is the LAUNDRY chore (basket → tub),
// "cook food" the oven chore, "clean the house" the tidy sweep. Lexical
// data (verb × category → need key), never a scripted phrase.
const CATEGORY_NEEDS: Record<string, Record<string, string>> = {
  wash: { clothing: "laundry", laundry: "laundry" },
  clean: { home: "clean", house: "clean", room: "clean", clothing: "laundry" },
  cook: { food: "cook", meal: "cook" },
  make: { food: "cook", meal: "cook" },
};

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
  // PHASE "stop" ("stop + eat"): cease the activity — the same halt a bare
  // "stop" compiles to (the goal vocabulary has no per-activity cancel yet;
  // the phase rides the frame so the echo can still say "stop eating").
  if (frame.phase === "stop") return { kind: "stay" };
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
    case "take":
    case "pick_up": {
      // get/take = acquire POSSESSION; pick_up = the physical lift. Both reach
      // the item and take it into hand — same primitive (fetch), distinct word.
      const it = item();
      return it ? { kind: "fetch", item: it } : null;
    }
    case "carry": {
      // "carry X" = pick it up and hold (fetch). "carry X to Y" = carry it
      // there — putIn stows it in a real container Y, else the place step sets
      // it down on the ground at Y (carrying it across the room, then release).
      const it = item();
      if (!it) return null;
      const to = binder.place(frame.target);
      return to ? { kind: "putIn", item: it, container: to } : { kind: "fetch", item: it };
    }
    case "give":
    case "bring": {
      const it = item();
      const to = binder.creature(frame.target);
      if (it && to) return { kind: "give", item: it, to };
      // "give/bring <goods> to <place>" (city-expansion ②): a non-creature
      // recipient is a stock DESTINATION — the yard, a house, a chest — so
      // the order reads as containment ("put wood in the yard"). The host's
      // transfer layer turns endpoint-shaped putIns into agreements.
      const place = binder.place(frame.target);
      return it && place ? { kind: "putIn", item: it, container: place } : null;
    }
    case "put":
    case "drop": {
      // CONSTRUCTION v1: the RELATION is no longer discarded. Furniture
      // places ("put chair near table" — a placement the creature judges
      // by the house generator's own rules); a spatial relation places
      // even a non-furniture item ("put ball near tree" — it lands BESIDE
      // the anchor, not inside it); everything else stays the classic
      // containment putIn ("put apple in box", "put cup on table").
      const it = item();
      if (!it) return null;
      const anchor = binder.place(frame.target);
      if (!anchor) {
        // Bare "drop X" (no destination) → set it down where you stand. Bare
        // "put X" has no place to go, so it stays unclear.
        return frame.verb === "drop" ? { kind: "drop", item: it } : null;
      }
      const rel = frame.relation;
      const spatialRel: PlacementRel | null =
        rel === "near" || rel === "under" || rel === "over" || rel === "behind" || rel === "front"
          ? rel
          : null;
      const furniture = binder.isFurniture?.(frame.object) === true;
      const nonContainer = binder.isContainer?.(frame.target) === false;
      if (furniture || spatialRel || nonContainer) {
        const relation: PlacementRel =
          spatialRel ?? (anchor.kind === "point" ? "at" : rel === "on" ? "on" : "in");
        return { kind: "place", item: it, at: { relation, anchor } };
      }
      return { kind: "putIn", item: it, container: anchor };
    }
    case "throw": {
      // "throw the sock" = throw it AWAY: no stated destination → the trash
      // bin (the resolver finds the nearest object answering to "bin");
      // "throw ball to X" keeps the stated target as the drop place.
      const it = item();
      if (!it) return null;
      const container = binder.place(frame.target) ?? { kind: "named" as const, id: "bin" };
      return { kind: "putIn", item: it, container };
    }
    case "hug": {
      const to = binder.creature(frame.target) ?? binder.creature(frame.object);
      return to ? { kind: "socialAct", target: to, act: "hug" } : null;
    }
    case "help": {
      // Adopt the target's surfaced need — the general on-behalf rule; the
      // host holds the order open until the want clears.
      const to = binder.creature(frame.target) ?? binder.creature(frame.object);
      return to ? { kind: "help", target: to } : null;
    }
    case "talk": {
      // "talk to Mara" — a targeted CONVERSE (the converse primitive): walk to
      // the named partner and exchange. Bare "talk" (no partner) stays the
      // social self-care motive — seek any housemate and chat.
      const to = binder.creature(frame.target) ?? binder.creature(frame.object);
      return to ? { kind: "converse", target: to } : { kind: "satisfy", need: "talk" };
    }
    case "open":
    case "shut": {
      const open = v === "open";
      // A lidded CONTAINER (chest/box/cupboard…) opens its physical LID — the
      // `setOpen` primitive over `heldOpen`, capability-gated. A DEVICE item (a
      // window, a lamp) stays a creature-world `toggle`.
      if (binder.isContainer?.(frame.object)) {
        const place = binder.place(frame.object);
        if (place) return { kind: "setOpen", place, open };
      }
      const it = item();
      return it ? { kind: "toggle", device: it, state: open ? "open" : "closed" } : null;
    }
    case "make":
    case "build": {
      const s = frame.object?.kind === "entity" ? frame.object.symbol : null;
      // "make food" is the COOKING chore, never a structure (verb × category).
      const catNeed = s ? CATEGORY_NEEDS[v]?.[s] : undefined;
      if (catNeed) return { kind: "satisfy", need: catNeed };
      // A bare "build" is a real order — the FOUNDING flow: staking a new
      // settlement needs no named structure ("town" is the default target;
      // the wilderness host founds a site, the civ layer reads it as the
      // settlement order). "make" alone stays unbound.
      if (!s && v === "build") return { kind: "build", structure: "town", cap: quantityCap(frame.quantity) };
      return s ? { kind: "build", structure: s, cap: quantityCap(frame.quantity) } : null;
    }
    case "trade": {
      // INTERCITY BARTER (⑤): "trade wood with the city" — give-good from the
      // object; the PARTNER from the with/to-marked noun (or the bare second
      // noun the argument frame bound); an optional "for <good>" names what
      // we want BACK. Nulls stay null — the host defaults the take-good to
      // the town's worst shortage and names the bound partner, then SPEAKS
      // the terms either way. A bare "trade" stays unbound (explicit
      // not-understood, never a silent guess).
      const give = frame.object?.kind === "entity" ? frame.object.symbol : null;
      if (!give) return null;
      const sym = (r?: Ref): string | null => (r?.kind === "entity" ? r.symbol : null);
      const boundRef = (...rels: string[]): Ref | undefined =>
        frame.bound?.find((b) => rels.includes(b.relation))?.ref;
      const partner =
        sym(boundRef("with", "to")) ??
        (frame.relation === "to" && !frame.bound ? sym(frame.target) : null);
      return { kind: "trade", give, take: sym(boundRef("for")), partner };
    }
    case "area": {
      // AREA CHARTER (③): "area farm here" charters the issuer's FOCUS AREA
      // for a category — the brush is the host's focus circle at order time, so
      // no geometry rides the goal (here/there stay deixis). "area none" (or a
      // negated area) CLEARS the ground back to undesignated; a bare "area"
      // stays unbound (the explicit not-understood, never a silent guess).
      if (frame.quantity === "none" || frame.negated) return { kind: "area", category: null };
      const s = frame.object?.kind === "entity" ? frame.object.symbol : null;
      return s ? { kind: "area", category: s } : null;
    }
    default: {
      // A CATEGORY object routes to its chore template first ("wash the
      // clothes" → laundry, "clean the house" → tidy) — before item binding
      // would turn it into a one-item transform.
      const objSym = frame.object?.kind === "entity" ? frame.object.symbol : null;
      const catNeed = objSym ? CATEGORY_NEEDS[v]?.[objSym] : undefined;
      if (catNeed) return { kind: "satisfy", need: catNeed };
      // A transform verb WITH an object transforms it ("wash the cup" → clean);
      // BARE, the same verb may be self-care ("you wash" → the hygiene motive).
      if (v in TRANSFORM_STATE) {
        const it = item();
        if (it) return { kind: "transform", item: it, state: TRANSFORM_STATE[v]! };
      }
      // INGEST verbs NAMING a concrete item ("eat the banana", "drink the
      // juice") act on THAT item — go to it and use it up (the action planner's
      // `consumed` target) — never the abstract self-care need (which drops the
      // object and only household residents can serve). BARE "eat"/"drink"
      // stays the hunger/thirst motive.
      if (INGEST_VERBS.has(v)) {
        const it = item();
        if (it) return { kind: "consume", item: it };
      }
      // "wear the shirt" — a targeted EQUIP of a named GARMENT (the wear
      // primitive): pick it up and put it on. Only for clothing; a non-garment
      // "wear X" falls through to the dress self-care motive below.
      if (v === "wear" && binder.isClothing?.(frame.object)) {
        const it = item();
        if (it) return { kind: "wear", item: it };
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
  // in the condition ("if window.open, shut [it]" → shut the window). Borrow the
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
