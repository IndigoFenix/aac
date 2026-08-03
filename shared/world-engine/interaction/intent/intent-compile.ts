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
  PlacementRel,
  Rule,
  RuleBinding,
} from "@shared/world-engine/interaction/behavior/rules.js";
import { DEFAULT_RULE_PRIORITY } from "@shared/world-engine/interaction/behavior/rules.js";
import type { IntentFrame, Ref } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { makeableGlyph } from "@shared/world-engine/interaction/content/makeable.js";

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
// `wash` is the ONE verb that makes a thing clean — `clean` is not a verb (it is
// the state this transform arrives AT), and `tidy` moves things without changing
// any state, so neither belongs here.
const TRANSFORM_STATE: Record<string, string> = {
  heat: "hot", cook: "hot", make_cold: "cold", wash: "clean", fill: "full", empty: "empty",
};
// Self-care verbs → a `satisfy` goal the actor's own need machinery serves:
// eat/drink/sleep/rest the founding motives, play the fun motive (box),
// talk the social motive (seek a housemate and chat), wash/brush_teeth the
// hygiene motive (the bath), tidy the tidy chore, sit/wake_up body poses,
// wear the dress motive (a change of clothes from the wardrobe).
// NOTE `wash` WITH an object stays a transform ("wash the cup"); the BARE verb
// is self-care ("you wash") — see compileAction's default arm.
// Exported as THE activity set: these are the verbs that name something a body
// DOES for itself, and therefore the verbs that can be done in company ("eat
// with me", "play together"). The surfacing layer reads it for the same reason
// the compiler does — one list, so a new activity is commandable, shareable and
// suggestable from a single edit.
export const SELF_NEEDS = new Set([
  "eat", "drink", "rest", "sleep", "play", "talk",
  "wash", "tidy", "brush_teeth", "sit", "wake_up", "wear",
]);
// INGEST verbs: a NAMED object is the thing to consume, so the order acts on
// that specific item (fetch it) rather than raising the abstract need. Bare,
// they stay self-care (above). Kept narrow — "eat the apple" has an
// unambiguous item reading; "play"/"wear" with an object are left to the
// need machinery until a targeted use/equip primitive exists.
const INGEST_VERBS = new Set(["eat", "drink"]);

/** The colour a `color`/recolour command names — a `color_*` value carried as a
 *  descriptor on the object (`shirt.color_red`) or a standalone colour modifier
 *  ("color shirt red"). Null when no colour was named. */
function pickColorFacet(frame: IntentFrame): string | null {
  const mods = [
    ...(frame.object?.kind === "entity" ? frame.object.modifiers : []),
    ...frame.modifiers,
  ];
  return mods.find((m) => m.startsWith("color_")) ?? null;
}
// VERB × OBJECT-CATEGORY dispatch (language-expansion.md): a household chore
// named by its category object routes to the matching NEED TEMPLATE, not an
// item transform — "wash the clothes" is the LAUNDRY chore (basket → tub),
// "cook food" the oven chore, "clean the house" the tidy sweep. Lexical
// data (verb × category → need key), never a scripted phrase.
//
// The scrub and the put-away are now SEPARATE orders, because they are separate
// acts: "wash the room" runs the `clean` sweep, "tidy the room" runs the `tidy`
// chore that returns loose things to where they live. They used to share the
// verb `clean`, which meant the two chores could not be asked for apart.
const CATEGORY_NEEDS: Record<string, Record<string, string>> = {
  wash: { clothing: "laundry", laundry: "laundry", home: "clean", house: "clean", room: "clean" },
  tidy: { home: "tidy", house: "tidy", room: "tidy" },
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
 * WHO the act is to be done WITH, from a `with`-marked companion, a `we`
 * subject, or a bare `together`. Null when the utterance names no company.
 *
 * Named companions win over the group: "we eat with Mara" is about Mara, and
 * folding her into an unresolved "my group" would lose the one name the child
 * actually said. `together` / `we` alone resolve to the speaker's own group,
 * which the world layer knows and this pure layer deliberately does not.
 */
function companionsOf(frame: IntentFrame, binder: IntentBinder): CompanionSpec | null {
  const ids: CreatureId[] = [];
  let group = frame.subject?.kind === "companions";
  const consider = (ref?: Ref): void => {
    if (!ref) return;
    if (ref.kind === "companions") {
      group = true;
      return;
    }
    // A NAMED noun must clear the companion test ("trade wood WITH the city" is
    // a partner, "wash it WITH water" an instrument — neither is company).
    // Deixis is animate by construction and never consults it.
    if (ref.kind === "entity" && binder.isCompanion?.(ref) === false) return;
    const c = binder.creature(ref);
    if (c && !ids.includes(c)) ids.push(c);
  };
  for (const b of frame.bound ?? []) if (b.relation === "with") consider(b.ref);
  if (!frame.bound && frame.relation === "with") consider(frame.target);

  if (ids.length) return { kind: "creatures", ids };
  return group || frame.joint ? { kind: "group" } : null;
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
 */
export function compileAction(frame: IntentFrame, binder: IntentBinder): GoalSpec | null {
  const goal = compileBareAction(frame, binder);
  if (goal?.kind !== "satisfy") return goal;
  const company = companionsOf(frame, binder);
  return company ? { ...goal, with: company } : goal;
}

function compileBareAction(frame: IntentFrame, binder: IntentBinder): GoalSpec | null {
  const v = frame.verb;
  if (!v) return null;
  // PHASE "stop" ("stop + eat"): cease the activity — the same halt a bare
  // "stop" compiles to (the goal vocabulary has no per-activity cancel yet;
  // the phase rides the frame so the echo can still say "stop eating").
  if (frame.phase === "stop") return { kind: "stay" };
  const item = () => binder.item(frame.object);
  const destRef = frame.target ?? frame.object; // movement: object doubles as destination

  // THE TRANSPORT ENDPOINT RULE (semantic-gaps.md §To and From): every transfer
  // verb moves a theme between a SOURCE and a DESTINATION. The verb's argument
  // frame fills its INTRINSIC endpoint (take ⇒ from, give ⇒ to); an EXPLICIT
  // relation of the OTHER direction adds the second endpoint and turns an
  // acquisition into a delivery ("take ball TO dog" ≡ carry it to the dog).
  // A marker that merely repeats the intrinsic direction changes nothing
  // ("give ball from dog" ≡ "give ball dog" — the frame slot absorbs it).
  const boundRef = (...rels: string[]): Ref | undefined =>
    frame.bound?.find((b) => rels.includes(b.relation))?.ref ??
    (frame.relation !== undefined && rels.includes(frame.relation) ? frame.target : undefined);
  /** An explicit/implied SOURCE endpoint, as a place (a container, a spot, a
   *  creature's hands). Creature-first: "take from dog" names the dog's hands
   *  (the classifier-backed binder nulls non-creatures on that channel). */
  const sourceOf = (): PlaceRef | null => {
    const ref = boundRef("from");
    if (!ref) return null;
    const c = binder.creature(ref);
    if (c) return { kind: "creature", id: c };
    return binder.place(ref);
  };
  /** A DESTINATION endpoint: a creature recipient wins ("give"), else a place
   *  ("the yard", "the box"). Returns one of the two shapes or null. */
  const destOf = (ref: Ref | undefined): { to?: CreatureId; container?: PlaceRef } | null => {
    if (!ref) return null;
    const c = binder.creature(ref);
    if (c) return { to: c };
    const p = binder.place(ref);
    return p ? { container: p } : null;
  };
  /** Deliver `it` to a resolved destination — the shared arm of every
   *  transport reading (give/bring/carry-to/take-to). */
  const deliver = (it: ItemRef, dest: { to?: CreatureId; container?: PlaceRef }): GoalSpec | null =>
    dest.to ? { kind: "give", item: it, to: dest.to }
    : dest.container ? { kind: "putIn", item: it, container: dest.container }
    : null;

  switch (v) {
    case "go":
    case "come":
    case "walk":
    case "run":
    case "return": {
      // walk/run are gaits of the same movement primitive ("run home", "walk
      // to the store") — one goTo; the gait is presentation, not semantics.
      // `return` is the going-BACK reading: bare it means home, and a named
      // place makes it an ordinary go ("return + school").
      const place = binder.place(destRef);
      if (place?.kind === "home") return { kind: "goHome" };
      if (place) return { kind: "goTo", place };
      const c = binder.creature(destRef);
      if (c) return { kind: "goTo", place: { kind: "creature", id: c } };
      return v === "return" ? { kind: "goHome" } : null;
    }
    case "follow":
    case "chase": {
      // chase = follow at urgency — same pursuit primitive, distinct word.
      const c = binder.creature(frame.object) ?? binder.creature(frame.target);
      return c ? { kind: "follow", target: c } : null;
    }
    case "stay":
    case "wait":
      return { kind: "stay", place: binder.place(frame.target) ?? undefined };
    case "stop": {
      // "stop {device}" — halt the ACTIVE THING, not the listener: a running
      // device turns off ("stop the water" shuts the tap). Anything else
      // stays the plain halt command.
      if (frame.object && binder.isDevice?.(frame.object)) {
        const it = item();
        if (it) return { kind: "toggle", device: it, state: "off" };
      }
      return { kind: "stay", place: binder.place(frame.target) ?? undefined };
    }
    case "get":
    case "take":
    case "pick_up":
    case "carry": {
      // The ACQUISITION family: reach the item and take it into hand — same
      // primitive (fetch), distinct words (get/take = possession, pick_up =
      // the physical lift, carry = hold-and-move). An explicit "to" makes it
      // a DELIVERY ("take/carry ball to dog" — fetch first, then hand over /
      // stow: the give/putIn plans already regress the pickup). An explicit
      // "from" (or take's implied second noun) names the SOURCE; objectless
      // "take from dog" takes whatever the source holds. Carry keeps its
      // CONTAINER preference for the destination (hold-and-move things into
      // places); take/get prefer a RECIPIENT — the classifier-backed binder
      // settles ambiguous words either way.
      const it = item();
      const toRef = boundRef("to");
      if (it && toRef) {
        const dest =
          v === "carry"
            ? (() => {
                const p = binder.place(toRef);
                return p ? { container: p } : destOf(toRef);
              })()
            : destOf(toRef);
        if (dest) {
          const g = deliver(it, dest);
          if (g) return g;
        }
      }
      const from = sourceOf();
      if (it) return from ? { kind: "fetch", item: it, from } : { kind: "fetch", item: it };
      return from ? { kind: "fetch", item: { match: {} }, from } : null;
    }
    case "give":
    case "bring": {
      const it = item();
      if (!it) return null;
      const dest = destOf(frame.target);
      if (dest) {
        // "give/bring <goods> to <place>" (city-expansion ②): a non-creature
        // recipient is a stock DESTINATION — the yard, a house, a chest — so
        // the order reads as containment ("put wood in the yard"). The host's
        // transfer layer turns endpoint-shaped putIns into agreements.
        const g = deliver(it, dest);
        if (g) return g;
      }
      // "give X" with no recipient: hand it to the SPEAKER — the asking child
      // is the default recipient (semantic-gaps.md: "give {object}" ⇒ to me).
      return { kind: "give", item: it, to: binder.player };
    }
    case "color": {
      // "color the shirt red" — recolour a NAMED item (pick it up, carry it to a
      // coloring tub, swap its colour). GENERIC over any tintable item; the
      // colour is a `color_*` value on the object or a standalone modifier.
      const color = pickColorFacet(frame);
      if (!color) return null;
      // The target COLOUR is not a filter on WHICH item to find — strip it from
      // the object ref so "color the shirt red" recolours ANY shirt (typically a
      // differently-coloured one), not only one that is already red.
      const objRef: Ref | undefined =
        frame.object?.kind === "entity"
          ? { ...frame.object, modifiers: frame.object.modifiers.filter((m) => !m.startsWith("color_")) }
          : frame.object;
      const it = binder.item(objRef);
      return it ? { kind: "color", item: it, color } : null;
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
      // `beside` is what the board word "next to" parses to — the ADJACENT
      // spot, as against `near`'s room-scaled vicinity. Both ride the goal;
      // the placement search reads them apart (placement.ts AnchorMode).
      const spatialRel: PlacementRel | null =
        rel === "near" || rel === "beside" || rel === "under" || rel === "over" || rel === "behind" || rel === "front"
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
    case "play":
      // "play" is the fun motive, alone or in company — ONE behavior model.
      // A named partner ("play with Mara") rides the `with` marker compileAction
      // attaches, which routes it through the PLAY RITUAL: a real gathering with
      // a place, a ring and a clock, that the partner may decline.
      //
      // It used to compile to a `socialAct` instead — an instant warmth beat
      // that zeroed both fun meters where they stood. That was a SECOND model
      // of playing together, disjoint from the ritual the world already runs,
      // and two models of one concept is what this engine's own law forbids.
      // `socialAct` keeps `hug`, which is a genuine one-shot contact act.
      return { kind: "satisfy", need: "play" };
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
      if (!s) return null;
      const cap = quantityCap(frame.quantity);
      // MAKE vs BUILD (user law, 2026-07-28): interchangeable verbs, opposite
      // PRIORITIES. `build` prioritises what stays put (buildings, rooms);
      // `make` prioritises what you can pick up. Either verb still REACHES
      // either goal — a word that is only one of the two is reached by both, so
      // "build a ball" makes a ball and "make a house" raises a house. The
      // priority only decides a word that is genuinely both, and the loser is
      // never a dead end: an unresolvable `build` says so out loud at the host.
      //
      // This is also where "make + animal" becomes a TOY of that animal
      // (toys-and-song-expansion.md): a rabbit is depictable, so the makeable
      // join answers `rabbit.toy...` and there is nothing to special-case.
      const mobile = makeableGlyph(s);
      const structural = binder.isStructure?.(frame.object) ?? false;
      if (mobile && (v === "make" || !structural)) return { kind: "craft", glyph: mobile, cap };
      return { kind: "build", structure: s, cap };
    }
    case "break": {
      // THE UNMAKING VERBS (construction ④, construction-structures.md
      // §Demolishing or Changing Rooms). `break` is make/build's mirror and
      // splits the same way its makers do: a PIECE of furniture comes apart
      // where it stands ("break the bed" — `place`'s inverse, so it carries
      // `place`'s ItemRef), a ROOM or a whole structure comes DOWN ("break the
      // bedroom" — the structure board's demolish word, now sayable).
      //
      // Furniture is tested FIRST because it is the narrower reading: the
      // furniture kinds and the room words are disjoint vocabularies (a `bed`
      // is never a room, a `bedroom` never a piece), so the order only decides
      // a word that is genuinely both — and the piece is the smaller, more
      // recoverable act. Neither ⇒ null: an unbindable "break" stays the
      // explicit not-understood, never a guessed demolition.
      if (frame.object && binder.isFurniture?.(frame.object)) {
        const it = item();
        if (it) return { kind: "breakPiece", item: it };
      }
      const room = frame.object?.kind === "entity" ? frame.object.symbol : null;
      if (room && binder.isStructure?.(frame.object)) return { kind: "demolish", room };
      return null;
    }
    case "empty": {
      // "empty the kitchen" — the stow-only half of `break`: the furniture
      // comes out, the walls stay up. ONLY a room reads this way; emptying a
      // CONTAINER is the transform the default arm has always compiled
      // ("empty the box" → the `empty` state), and that reading is kept here
      // verbatim so gaining the room sense costs the box sense nothing.
      const room = frame.object?.kind === "entity" ? frame.object.symbol : null;
      if (room && binder.isStructure?.(frame.object)) return { kind: "emptyRoom", room };
      const it = item();
      return it ? { kind: "transform", item: it, state: TRANSFORM_STATE[v]! } : null;
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
