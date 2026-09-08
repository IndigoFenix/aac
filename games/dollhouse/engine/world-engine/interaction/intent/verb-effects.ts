// shared/world-engine/interaction/intent/verb-effects.ts
//
// THE VERB → EFFECT TABLE (semantic-behavior.md §2/§5, migration steps 1-2).
//
// What a command MEANS used to be a 22-arm `switch (frame.verb)` inside
// `compileBareAction`. Every arm re-wrote the same three things by hand — which
// EFFECT the sentence names, which frame ROLE fills each of the effect's slots,
// and which GUARDS have to hold before that reading is the right one — so a new
// verb meant a new arm, and the shape of the answer was invisible under the
// prose. This module makes the shape the artefact: a verb maps to an ORDERED
// list of rows, a row is `{ guards, effect, roles, fixed }`, and the evaluator
// is a first-match loop nine lines long.
//
// ⚖️ ROW ORDER IS THE RULE. The rows for a verb are exactly the arm's own
// `if`/`else` probes in their original order, and the DEFAULT_ROWS are the
// default arm's six probes in theirs. That is not a stylistic choice: it is what
// makes the port byte-identical, and it is the invariant the round's golden
// fixture (server/tests/world-engine/fixtures/verb-effects-golden.json, 44k
// frame × binder cases recorded from the pre-port compiler) exists to defend.
// Re-ordering rows within a verb CHANGES BEHAVIOUR; adding a row at the end
// only widens what compiles.
//
// 🚨 SYNONYMS STAY ENUMERATED. `VERB_FAMILY` / `canonicalVerb` (parse-intent) is
// deliberately NOT applied here — `take` and `get` share a row LIST, they are
// not folded to one key. Folding them would be a behaviour change wearing a
// refactor's clothes (the arms differ: `carry` prefers a container destination
// where `take` prefers a recipient), so the family map stays the dialogue
// layer's business and the table names every word it serves.
//
// 🚨 NO ROW CARRIES CODE. Every guard and every role source is a NAME out of a
// closed union, resolved by the two dispatch tables below. The arms that looked
// least table-shaped — `color`'s modifier strip, `show`'s two refusals,
// `make`/`build`'s category→makeable→structure ladder, `put`'s placement
// relation — turned out to be guards and role sources, not closures, so the
// verb → rows mapping is pure data end to end.
//
// ⚖️ A ROW MAY ALSO STATE WHAT MUST BE TRUE (semantic-behavior.md §6). The
// `precond` column carries the readings a row is only HONEST under — today just
// `doing`, for the phase stage below: "stop + eat" halts an eater, and tells a
// body that is not eating so ("I am not eating") rather than landing a halt on
// nothing. A precondition never changes the compiled GoalSpec; it rides beside
// it on the CompiledIntent, and the HOST is the seat that checks it and speaks
// the failure. The one place they must not be confused: a GUARD decides WHICH
// READING the sentence has (a question about the words), a PRECONDITION decides
// whether that reading can be acted on (a question about the world).
//
// Seams left open on purpose (a later stage fills them, do not build them here):
//   • the other `Precondition` kinds (`holding`/`near`/`state`) — the union is
//     open and documented, the evaluator that answers them is the host's;
//   • a `companion` ROLE column proper: company is still gathered by
//     `companionsOf` at the compile wrapper (now for EVERY goal kind, carried on
//     `CompiledIntent.companions`), not named by a row.

import type { GoalSpec, PlaceRef, PlacementRef, PlacementRel } from "@shared/world-engine/interaction/behavior/rules.js";
import type { CreatureId } from "@shared/world-engine/interaction/behavior/creatures.js";
import { makeableGlyph } from "@shared/world-engine/interaction/content/makeable.js";
import type { IntentFrame, Ref } from "@shared/world-engine/interaction/intent/parse-intent.js";
import type { CompanionSpec } from "@shared/world-engine/interaction/behavior/rules.js";

// The binder is intent-compile's interface; the import is TYPE-ONLY, so this
// module has no runtime edge back to it and the two do not form a cycle.
import type { IntentBinder } from "@shared/world-engine/interaction/intent/intent-compile.js";

// ---------------------------------------------------------------------------
// The lexical tables the rows read (moved here from intent-compile with their
// comments intact — they are the DATA half of what the switch used to hold)
// ---------------------------------------------------------------------------

/** State a transform verb applies (fire→hot, water→cold…). */
// `wash` is the ONE verb that makes a thing clean — `clean` is not a verb (it is
// the state this transform arrives AT), and `tidy` moves things without changing
// any state, so neither belongs here.
export const TRANSFORM_STATE: Record<string, string> = {
  heat: "hot", cook: "hot", make_cold: "cold", wash: "clean", fill: "full", empty: "empty",
};

// Self-care verbs → a `satisfy` goal the actor's own need machinery serves:
// eat/drink/sleep/rest the founding motives, play the fun motive (box),
// talk the social motive (seek a housemate and chat), wash/brush_teeth the
// hygiene motive (the bath), tidy the tidy chore, sit/wake_up body poses,
// wear the dress motive (a change of clothes from the wardrobe).
// NOTE `wash` WITH an object stays a transform ("wash the cup"); the BARE verb
// is self-care ("you wash") — see the DEFAULT_ROWS below.
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
export const INGEST_VERBS = new Set(["eat", "drink"]);

// POSTURE verbs: the self-care verbs whose object is not a THING acted on but a
// STATION the body settles at ("sit on the chair", "sleep in the bed", "rest at
// the bench"). Bare they are ordinary self-needs (above); with a station bound
// they compile to `rest`, the dwell primitive rules.ts declares for exactly
// this. Kept to the three that name a posture — "play + box" stays the fun
// motive, whose own ritual owns the toy.
export const REST_VERBS = new Set(["sit", "sleep", "rest"]);

/** The relations that can name a STATION — the parser's LOCATIVES. `with` is
 *  deliberately absent: it marks COMPANY, never a place ("sleep with Mara" is a
 *  shared need, not a bed). `to`/`from`/`for` are transport and benefit
 *  markers, and neither names a spot a body settles at. */
export const STATION_RELATIONS = ["in", "on", "under", "over", "near", "behind", "front", "beside"] as const;

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
export const CATEGORY_NEEDS: Record<string, Record<string, string>> = {
  wash: { clothing: "laundry", laundry: "laundry", home: "clean", house: "clean", room: "clean" },
  tidy: { home: "tidy", house: "tidy", room: "tidy" },
  cook: { food: "cook", meal: "cook" },
  make: { food: "cook", meal: "cook" },
};

/** The `put`/`drop` relations that place a thing BESIDE an anchor rather than
 *  inside it. `beside` is what the board word "next to" parses to — the
 *  ADJACENT spot, as against `near`'s room-scaled vicinity. Both ride the goal;
 *  the placement search reads them apart (placement.ts AnchorMode). */
const SPATIAL_RELS = new Set(["near", "beside", "under", "over", "behind", "front"]);

/** The colour a `color`/recolour command names — a `color_*` value carried as a
 *  descriptor on the object (`shirt.color_red`) or a standalone colour modifier
 *  ("color shirt red"). Null when no colour was named. */
export function pickColorFacet(frame: IntentFrame): string | null {
  const mods = [
    ...(frame.object?.kind === "entity" ? frame.object.modifiers : []),
    ...frame.modifiers,
  ];
  return mods.find((m) => m.startsWith("color_")) ?? null;
}

export function quantityCap(q?: string): number {
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
/** The relation that marks COMPANY. One spelling, three readers: the company
 *  gatherer below, the endpoint reader in `makeCtx` that must skip it, and the
 *  accompany row that reads it as the one thing left in the sentence. */
const COMPANION_REL = "with";

/**
 * THE `with` PHRASE — every noun the sentence marks as company, in spoken
 * order. ONE definition, two readers: `companionsOf` (which resolves them to
 * creatures through the animacy gate) and the table's `hasBound:with` guard.
 * The bare-`relation` arm is the parser's no-`bound` shape, exactly as the
 * transport endpoints' `boundRef` treats theirs.
 */
function companionRefs(frame: IntentFrame): Ref[] {
  const out: Ref[] = [];
  for (const b of frame.bound ?? []) if (b.relation === COMPANION_REL) out.push(b.ref);
  if (!frame.bound && frame.relation === COMPANION_REL && frame.target) out.push(frame.target);
  return out;
}

export function companionsOf(frame: IntentFrame, binder: IntentBinder): CompanionSpec | null {
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
  for (const ref of companionRefs(frame)) consider(ref);

  if (ids.length) return { kind: "creatures", ids };
  return group || frame.joint ? { kind: "group" } : null;
}

/**
 * THE COMPANION AS A CREATURE — the first named member of the company, or null
 * when the sentence names company that is not a resolvable body (an unnamed
 * `we`/`together` group, or a `with`-marked THING: "go with the box" has no one
 * to go along with). Read THROUGH `companionsOf` on purpose: the animacy gate,
 * the de-duplication and the spoken order are stated once, so the party that
 * rides `CompiledIntent.companions` and the body an accompany row walks beside
 * can never be two different readings of the same phrase.
 */
function companionCreature(frame: IntentFrame, binder: IntentBinder): CreatureId | null {
  const spec = companionsOf(frame, binder);
  return spec?.kind === "creatures" ? spec.ids[0]! : null;
}

// ---------------------------------------------------------------------------
// The row vocabulary
// ---------------------------------------------------------------------------

/**
 * WHICH REF a guard probes / a role binds. Everything the old arms reached for
 * by hand, named once:
 *   `dest`    = `endpointTarget() ?? frame.object` — movement's "a bare noun
 *               after the verb IS the destination" rule, over the ENDPOINT
 *               target (⚖️ a `with`-marked companion is not a destination —
 *               see `endpointTarget` in `makeCtx`);
 *   `to/from/for` = THE TRANSPORT ENDPOINT RULE's `boundRef`: the explicitly
 *               relation-marked noun, falling back to `target` when the frame
 *               carries a bare `relation` and no `bound` list;
 *   `station` = the REST arm's "a LOCATIVE-bound noun, else the bare object";
 *   `objectNoColor` = the object with its `color_*` descriptors stripped (the
 *               target colour is not a filter on WHICH shirt to find).
 */
export type RefSrc = "object" | "target" | "dest" | "to" | "from" | "for" | "station" | "objectNoColor";

/**
 * A precondition on a row, evaluated LEFT TO RIGHT with short-circuit — later
 * guards may rely on earlier ones (`hasBound:to` before `creature:to`).
 */
export type Guard =
  // ref presence
  | "has:object" | "has:target" | "no:target" | "hasBound:to" | "hasBound:with" | "no:endpoint"
  // binder channels — does this ref resolve on that channel at all?
  | "place:dest" | "home:dest" | "creature:dest"
  | "creature:target" | "creature.not:object"
  | "creature:target|object" | "creature:object|endpoint"
  | "creature:with"
  | "creature:to" | "place:to"
  | "creature:station" | "place:station"
  | "place:target" | "place:object"
  | "item:object" | "item:objectNoColor"
  // the transport endpoints
  | "source" | "beneficiary"
  // the seven OPTIONAL binder predicates (the scope's classifiers)
  | "isDevice:object" | "isFurniture:object" | "isContainer:object"
  | "isContainer.false:target" | "isClothing:object"
  | "isStructure:object" | "isStructure.not:object" | "isFeature:object"
  // frame shape
  | "objectSymbol" | "no:objectSymbol" | "quantity:none" | "negated"
  | "noCompanions" | "spatialRelation" | "colorNamed"
  // verb-keyed lexical tables
  | "categoryNeed" | "makeable" | "transformVerb" | "ingestVerb" | "restVerb" | "selfNeed"
  | "verb:wear"
  // the PHASE stage (see PHASE_ROWS): the frame's phase word, and whether it
  // governs a main verb of its own ("stop + eat" does; a lone phase does not).
  | "phase:stop" | "has:mainVerb";

/** Where a slot's value comes from. The names ARE the old helpers. */
export type RoleSrc =
  | "place(dest)" | "creatureSpot(dest)"
  | "creature(target|object)" | "creature(object|endpoint)" | "creature(target)" | "creature(to)"
  | "creature(with)"
  | "place(target)" | "place(endpoint)?" | "place(object)" | "place(to)"
  | "place(station)" | "creatureSpot(station)"
  | "item(object)" | "item(objectNoColor)"
  | "player" | "source" | "beneficiary"
  | "objectSymbol" | "categoryNeed" | "makeableGlyph" | "quantityCap" | "transformState" | "verb"
  | "modifier:color" | "placementAt" | "trade:take" | "trade:partner";

/**
 * WHAT MUST BE TRUE OF THE WORLD for a matched row's effect to be an honest act
 * — semantic-behavior.md §6, *"preconditions ARE the response"*. The failed
 * precondition is not an error: it IS the reply, spoken in the child's own
 * words (`doing` fails ⇒ `i_me + {verb}.not`, "I am not eating"), and it is the
 * whole difference between a halt that lands on nothing and an answer.
 *
 * 🚨 A GUARD AND A PRECONDITION ANSWER DIFFERENT QUESTIONS. A guard decides
 * WHICH READING the sentence has and is therefore about the words and the
 * binder; a precondition decides whether that reading can be ACTED ON and is
 * therefore about the world at the moment of the order. Never demote one into
 * the other: a precondition written as a guard silently re-reads the sentence
 * as something else, which is exactly the guess this layer refuses to make.
 *
 * `verb: "$verb"` is the placeholder for the frame's MAIN verb, resolved when
 * the row binds — a phase row cannot name the verb it stops, the frame does.
 *
 * ⏳ ONE KIND THIS ROUND. The union is left open for the seats §6 wants next,
 * each already a fact the world can answer and a `.not` sentence the board can
 * already say:
 *   • `{ kind: "holding"; item: ItemRef }` — "give the ball" with empty hands
 *     (`i_me + have.not` — semantic-gaps 10's honest fallback);
 *   • `{ kind: "near"; place: PlaceRef }` — an act whose body is elsewhere;
 *   • `{ kind: "state"; state: string }` — a device already off, a door shut.
 * Adding one is a member here plus its answer at the host's evaluation seat;
 * no row that does not name it changes.
 */
export type Precondition = { kind: "doing"; verb: string | "$verb" };

/** ONE READING of a verb: the guards that make it right, and how to fill it in. */
export interface VerbEffectRow {
  /** ALL must hold, in order, for this row to win. */
  guards: Guard[];
  /** The GoalSpec this row emits. */
  effect: GoalSpec["kind"];
  /** slot → where its value comes from. */
  roles?: Record<string, RoleSrc>;
  /** slot → a constant (deep-copied per compile, so no caller can mutate the table). */
  fixed?: Record<string, unknown>;
  /** What must hold in the WORLD for this reading to be actionable. Absent ⇒
   *  the row asserts nothing and the act is always attemptable. Never affects
   *  WHICH row wins, and never appears in the GoalSpec. */
  precond?: Precondition[];
  /** Why this row sits where it does — the arm comment, one line. */
  note?: string;
}

// ---------------------------------------------------------------------------
// The evaluation context — the old arm-local helpers, memoised per compile
// ---------------------------------------------------------------------------

interface Ctx {
  frame: IntentFrame;
  binder: IntentBinder;
  verb: string;
  ref(src: RefSrc): Ref | undefined;
  /** The `target` slot read as an ENDPOINT of the act — see `makeCtx`. */
  endpointTarget(): Ref | undefined;
  source(): PlaceRef | null;
  beneficiary(): CreatureId | null;
  objectSymbol(): string | null;
}

function makeCtx(frame: IntentFrame, binder: IntentBinder): Ctx {
  // THE TRANSPORT ENDPOINT RULE (semantic-gaps.md §To and From): every transfer
  // verb moves a theme between a SOURCE and a DESTINATION. The verb's argument
  // frame fills its INTRINSIC endpoint (take ⇒ from, give ⇒ to); an EXPLICIT
  // relation of the OTHER direction adds the second endpoint and turns an
  // acquisition into a delivery ("take ball TO dog" ≡ carry it to the dog).
  // A marker that merely repeats the intrinsic direction changes nothing
  // ("give ball from dog" ≡ "give ball dog" — the frame slot absorbs it).
  // `with` is not one of the endpoint relations, so it can never fill a
  // source/destination HERE — which is why the acquisition rows ("get + ball +
  // with + pip") were already companion-blind and did not move.
  const boundRef = (...rels: readonly string[]): Ref | undefined =>
    frame.bound?.find((b) => rels.includes(b.relation))?.ref ??
    (frame.relation !== undefined && rels.includes(frame.relation) ? frame.target : undefined);

  // ⚖️ `with` MARKS COMPANY, NEVER AN ENDPOINT (2026-09-08 ruling; the transport
  // endpoint rule's own logic). The parser hands the `target` slot to the LAST
  // relation-marked noun, so "go home WITH Mara" leaves MARA in `target` and the
  // place the child actually said in `bound` — and every reading that took
  // `target` for a destination let the companion STEAL it ("go to the kitchen
  // with Mara" walked to Mara). The same `with` phrase is gathered as company by
  // `companionsOf` and rides `CompiledIntent.companions`, so an ENDPOINT reading
  // must see the sentence exactly as if the phrase were absent: the last
  // endpoint-marked noun before it, else nothing at all.
  //
  // ONLY endpoint readings use this. A PARTNER-shaped verb still reads
  // `frame.target` raw, because there the `with` phrase names the argument
  // itself: talk/help/hug (the addressee), trade (the partner), play (the ritual
  // company). That distinction is the rule's whole boundary, and it is data —
  // which role source a row cites — never a per-verb branch.
  const endpointTarget = (): Ref | undefined => {
    if (frame.relation !== COMPANION_REL) return frame.target;
    const rest = frame.bound?.filter((b) => b.relation !== COMPANION_REL);
    return rest?.length ? rest[rest.length - 1]!.ref : undefined;
  };

  const objSym = frame.object?.kind === "entity" ? frame.object.symbol : null;

  return {
    frame,
    binder,
    verb: frame.verb ?? "",
    endpointTarget,
    ref(src) {
      switch (src) {
        case "object": return frame.object;
        case "target": return frame.target;
        case "dest": return endpointTarget() ?? frame.object; // movement: object doubles as destination
        case "to": return boundRef("to");
        case "from": return boundRef("from");
        case "for": return boundRef("for");
        case "station": return boundRef(...STATION_RELATIONS) ?? frame.object;
        case "objectNoColor":
          return frame.object?.kind === "entity"
            ? { ...frame.object, modifiers: frame.object.modifiers.filter((m) => !m.startsWith("color_")) }
            : frame.object;
      }
    },
    /** An explicit/implied SOURCE endpoint, as a place (a container, a spot, a
     *  creature's hands). Creature-first: "take from dog" names the dog's hands
     *  (the classifier-backed binder nulls non-creatures on that channel). */
    source() {
      const ref = boundRef("from");
      if (!ref) return null;
      const c = binder.creature(ref);
      if (c) return { kind: "creature", id: c };
      return binder.place(ref);
    },
    /** WHO the act is FOR — the `for`-marked BENEFICIARY (build order L9).
     *  Only an ANIMATE can be one: a person can be fetched for, a house cannot,
     *  so a NAMED noun must clear the same animacy test COMPANY does. */
    beneficiary() {
      const ref = boundRef("for");
      if (!ref) return null;
      if (ref.kind === "entity" && binder.isCompanion?.(ref) === false) return null;
      return binder.creature(ref);
    },
    objectSymbol: () => objSym,
  };
}

// ---------------------------------------------------------------------------
// GUARDS — the closed probe set
// ---------------------------------------------------------------------------

const GUARDS: Record<Guard, (c: Ctx) => boolean> = {
  "has:object": (c) => c.frame.object !== undefined,
  "has:target": (c) => c.frame.target !== undefined,
  "no:target": (c) => c.frame.target === undefined,
  "hasBound:to": (c) => c.ref("to") !== undefined,
  "hasBound:with": (c) => companionRefs(c.frame).length > 0,
  // THE SENTENCE STATES NOWHERE TO GO. `dest` IS the endpoint reading
  // (`endpointTarget() ?? frame.object`, one definition), so this is its exact
  // negation: no endpoint-marked noun and no bare object doubling as one.
  "no:endpoint": (c) => c.ref("dest") === undefined,

  "place:dest": (c) => c.binder.place(c.ref("dest")) !== null,
  "home:dest": (c) => c.binder.place(c.ref("dest"))?.kind === "home",
  "creature:dest": (c) => c.binder.creature(c.ref("dest")) !== null,
  "creature:target": (c) => c.binder.creature(c.frame.target) !== null,
  "creature.not:object": (c) => c.binder.creature(c.frame.object) === null,
  "creature:target|object": (c) => (c.binder.creature(c.frame.target) ?? c.binder.creature(c.frame.object)) !== null,
  // PURSUIT reads its target as an ENDPOINT (whom you end up beside), so a
  // `with`-marked companion cannot be the one pursued — unlike the
  // partner-shaped row above, which is talking TO its target.
  "creature:object|endpoint": (c) => (c.binder.creature(c.frame.object) ?? c.binder.creature(c.endpointTarget())) !== null,
  // The company, read as a BODY (see `companionCreature`): a `with`-marked thing
  // and an unnamed group both fail here, so no row can walk beside a box.
  "creature:with": (c) => companionCreature(c.frame, c.binder) !== null,
  "creature:to": (c) => c.binder.creature(c.ref("to")) !== null,
  "place:to": (c) => c.binder.place(c.ref("to")) !== null,
  "creature:station": (c) => c.binder.creature(c.ref("station")) !== null,
  "place:station": (c) => c.binder.place(c.ref("station")) !== null,
  "place:target": (c) => c.binder.place(c.frame.target) !== null,
  "place:object": (c) => c.binder.place(c.frame.object) !== null,
  "item:object": (c) => c.binder.item(c.frame.object) !== null,
  "item:objectNoColor": (c) => c.binder.item(c.ref("objectNoColor")) !== null,

  source: (c) => c.source() !== null,
  beneficiary: (c) => c.beneficiary() !== null,

  "isDevice:object": (c) => !!c.binder.isDevice?.(c.frame.object),
  "isFurniture:object": (c) => !!c.binder.isFurniture?.(c.frame.object),
  "isContainer:object": (c) => !!c.binder.isContainer?.(c.frame.object),
  // The ONE three-valued predicate: `null` means "assume container" (legacy),
  // so only an explicit `false` reroutes a put into a placement.
  "isContainer.false:target": (c) => c.binder.isContainer?.(c.frame.target) === false,
  "isClothing:object": (c) => !!c.binder.isClothing?.(c.frame.object),
  "isStructure:object": (c) => !!c.binder.isStructure?.(c.frame.object),
  "isStructure.not:object": (c) => !(c.binder.isStructure?.(c.frame.object) ?? false),
  "isFeature:object": (c) => !!c.binder.isFeature?.(c.frame.object),

  objectSymbol: (c) => c.objectSymbol() !== null,
  "no:objectSymbol": (c) => c.objectSymbol() === null,
  "quantity:none": (c) => c.frame.quantity === "none",
  negated: (c) => c.frame.negated === true,
  noCompanions: (c) => companionsOf(c.frame, c.binder) === null,
  spatialRelation: (c) => c.frame.relation !== undefined && SPATIAL_RELS.has(c.frame.relation),
  colorNamed: (c) => pickColorFacet(c.frame) !== null,

  categoryNeed: (c) => {
    const s = c.objectSymbol();
    return s !== null && CATEGORY_NEEDS[c.verb]?.[s] !== undefined;
  },
  // Truthiness, exactly as the arm wrote it (`const mobile = makeableGlyph(s); if (mobile …)`).
  makeable: (c) => {
    const s = c.objectSymbol();
    return s !== null && !!makeableGlyph(s);
  },
  transformVerb: (c) => c.verb in TRANSFORM_STATE,
  ingestVerb: (c) => INGEST_VERBS.has(c.verb),
  restVerb: (c) => REST_VERBS.has(c.verb),
  selfNeed: (c) => SELF_NEEDS.has(c.verb),
  "verb:wear": (c) => c.verb === "wear",

  "phase:stop": (c) => c.frame.phase === "stop",
  // A PHASE WORD IS NOT ITS OWN MAIN VERB. The parser composes "stop + eat" into
  // `{phase:"stop", verb:"eat"}` — the verb it governs is the ACTIVITY, and that
  // is the word a precondition can be asked about. A frame whose only verb IS
  // the phase word governs nothing, so it names no activity to be doing.
  "has:mainVerb": (c) => c.frame.verb !== undefined && c.frame.verb !== c.frame.phase,
};

// ---------------------------------------------------------------------------
// ROLES — the closed value set
// ---------------------------------------------------------------------------

const creatureSpot = (id: CreatureId): PlaceRef => ({ kind: "creature", id });

/** `frame.bound`'s LOCAL lookup — trade's own, deliberately WITHOUT the bare
 *  `frame.relation` fallback the transport endpoints use. */
const tradeBound = (frame: IntentFrame, ...rels: string[]): Ref | undefined =>
  frame.bound?.find((b) => rels.includes(b.relation))?.ref;
const symOf = (r?: Ref): string | null => (r?.kind === "entity" ? r.symbol : null);

const ROLES: Record<RoleSrc, (c: Ctx) => unknown> = {
  "place(dest)": (c) => c.binder.place(c.ref("dest")),
  "creatureSpot(dest)": (c) => creatureSpot(c.binder.creature(c.ref("dest"))!),
  "creature(target|object)": (c) => c.binder.creature(c.frame.target) ?? c.binder.creature(c.frame.object),
  "creature(object|endpoint)": (c) => c.binder.creature(c.frame.object) ?? c.binder.creature(c.endpointTarget()),
  "creature(target)": (c) => c.binder.creature(c.frame.target),
  "creature(with)": (c) => companionCreature(c.frame, c.binder),
  "creature(to)": (c) => c.binder.creature(c.ref("to")),
  "place(target)": (c) => c.binder.place(c.frame.target),
  // The ONE optional slot in the table: `stay`'s place is `… ?? undefined`, so a
  // miss leaves the KEY PRESENT and undefined, exactly as the arm wrote it.
  // Read as an ENDPOINT: "wait WITH Mara" waits where you are, together — the
  // companion is not the spot to stand on.
  "place(endpoint)?": (c) => c.binder.place(c.endpointTarget()) ?? undefined,
  "place(object)": (c) => c.binder.place(c.frame.object),
  "place(to)": (c) => c.binder.place(c.ref("to")),
  "place(station)": (c) => c.binder.place(c.ref("station")),
  "creatureSpot(station)": (c) => creatureSpot(c.binder.creature(c.ref("station"))!),
  "item(object)": (c) => c.binder.item(c.frame.object),
  "item(objectNoColor)": (c) => c.binder.item(c.ref("objectNoColor")),
  player: (c) => c.binder.player,
  source: (c) => c.source(),
  beneficiary: (c) => c.beneficiary(),
  objectSymbol: (c) => c.objectSymbol(),
  categoryNeed: (c) => CATEGORY_NEEDS[c.verb]?.[c.objectSymbol()!],
  makeableGlyph: (c) => makeableGlyph(c.objectSymbol()!),
  quantityCap: (c) => quantityCap(c.frame.quantity),
  transformState: (c) => TRANSFORM_STATE[c.verb],
  verb: (c) => c.verb,
  "modifier:color": (c) => pickColorFacet(c.frame),
  /** `put`/`drop`'s placement: the spoken spatial relation, else `at` for a bare
   *  ground point, else the `on`/`in` containment default — over the bound anchor. */
  placementAt: (c): PlacementRef => {
    const anchor = c.binder.place(c.frame.target)!;
    const rel = c.frame.relation;
    const spatial = rel !== undefined && SPATIAL_RELS.has(rel) ? (rel as PlacementRel) : null;
    const relation: PlacementRel = spatial ?? (anchor.kind === "point" ? "at" : rel === "on" ? "on" : "in");
    return { relation, anchor };
  },
  "trade:take": (c) => symOf(tradeBound(c.frame, "for")),
  "trade:partner": (c) =>
    symOf(tradeBound(c.frame, "with", "to")) ??
    (c.frame.relation === "to" && !c.frame.bound ? symOf(c.frame.target) : null),
};

// ---------------------------------------------------------------------------
// THE TABLE
// ---------------------------------------------------------------------------

const ITEM = "item(object)" as const;

/** get / take / pick_up / carry, once the `to`-delivery readings are past. */
const ACQUISITION_TAIL: VerbEffectRow[] = [
  {
    // THE BENEFICIARY ("get + apple + for + mara"): fetching for somebody else
    // ENDS IN THEIR HANDS, so the order is a DELIVERY. An explicit `to`
    // OUTRANKS it (the rows above return first) and a `for`-bound PLACE stays a
    // plain fetch (`beneficiary` is animate-gated).
    guards: ["item:object", "beneficiary"], effect: "give",
    roles: { item: ITEM, to: "beneficiary" },
    note: "for-marked person ⇒ deliver to them",
  },
  {
    guards: ["item:object", "source"], effect: "fetch",
    roles: { item: ITEM, from: "source" },
    note: "named source ⇒ fetch from there",
  },
  { guards: ["item:object"], effect: "fetch", roles: { item: ITEM }, note: "plain acquisition" },
  {
    // Objectless "take from dog" — take whatever the source holds.
    guards: ["source"], effect: "fetch", roles: { from: "source" }, fixed: { item: { match: {} } },
    note: "objectless take-from",
  },
];

/** The three writings of "hand it over" — give / bring / share. */
const GIVE_ROWS: VerbEffectRow[] = [
  { guards: ["item:object", "creature:target"], effect: "give", roles: { item: ITEM, to: "creature(target)" } },
  {
    // "give/bring <goods> to <place>" (city-expansion ②): a non-creature
    // recipient is a stock DESTINATION, so the order reads as containment.
    guards: ["item:object", "place:target"], effect: "putIn", roles: { item: ITEM, container: "place(target)" },
  },
  {
    // "give X" with no recipient: hand it to the SPEAKER.
    guards: ["item:object"], effect: "give", roles: { item: ITEM, to: "player" },
  },
];

/** put / drop, minus drop's bare release row. */
const PLACEMENT_ROWS: VerbEffectRow[] = [
  // CONSTRUCTION v1: the RELATION is no longer discarded. Furniture places, a
  // spatial relation places even a non-furniture item, an explicitly
  // NON-container anchor places rather than contains — three separate readings
  // of the SAME row, written as three rows because the arm wrote them as one
  // `||` and a row is an AND.
  { guards: ["item:object", "place:target", "isFurniture:object"], effect: "place", roles: { item: ITEM, at: "placementAt" } },
  { guards: ["item:object", "place:target", "spatialRelation"], effect: "place", roles: { item: ITEM, at: "placementAt" } },
  { guards: ["item:object", "place:target", "isContainer.false:target"], effect: "place", roles: { item: ITEM, at: "placementAt" } },
  { guards: ["item:object", "place:target"], effect: "putIn", roles: { item: ITEM, container: "place(target)" } },
];

/** ⚖️ THE CLEARING READING — one row, three verbs (user ruling 2026-09-02:
 *  *"'break', 'cut' and 'fight' all redirect to this"*), gated on the OBJECT
 *  being something standing in the ground and nothing else. That gate is the
 *  whole of "`fight` DOES NOT EAT COMBAT": a body is never a feature, so
 *  "fight the wolf" cannot reach this row however the binder is implemented. */
const CLEARING_ROW: VerbEffectRow = {
  guards: ["objectSymbol", "isFeature:object"], effect: "clearFeature", roles: { feature: "objectSymbol" },
};

/**
 * ⚖️ GOING ALONG WITH SOMEBODY — one row, six movement verbs (ruling
 * 2026-09-08, semantic-behavior.md §7: *a well-formed sentence must never read
 * as "not understood"*).
 *
 * "Go with Mara" states company and no destination. `with` marks COMPANY and
 * never an endpoint, so there is nowhere to walk to — and a movement order that
 * names a body to move WITH is an order to move ALONGSIDE her, which is what
 * `follow` already is. The company is not a consolation reading of the
 * destination: it is the only place the sentence puts.
 *
 * The guards are the whole of the rule, in order: the sentence must state
 * company (`hasBound:with`), must state NO endpoint (`no:endpoint` — every
 * endpoint row above returns first, so "go to the kitchen with Mara" never
 * reaches here), and that company must be a resolvable BODY (`creature:with` —
 * "go with the box" stays the honest not-understood, because a box is not
 * somebody to go along with).
 *
 * Shared by reference across go/come/run/return/follow/chase the way the
 * synonym groups share their arrays: it is ONE reading, and six words for it.
 */
const ACCOMPANY_ROW: VerbEffectRow = {
  guards: ["hasBound:with", "no:endpoint", "creature:with"],
  effect: "follow",
  roles: { target: "creature(with)" },
  note: "movement + company − endpoint ⇒ go ALONG with them",
};

/**
 * VERB → its ordered readings. A verb absent from this map falls to
 * `DEFAULT_ROWS`; a verb present with rows that all miss compiles to null (the
 * explicit not-understood, never a guessed act).
 */
export const VERB_EFFECTS: Record<string, VerbEffectRow[]> = {
  // --- movement ---------------------------------------------------------
  // walk/run are gaits of the same movement primitive — one goTo; the gait is
  // presentation, not semantics.
  go: [
    { guards: ["home:dest"], effect: "goHome" },
    { guards: ["place:dest"], effect: "goTo", roles: { place: "place(dest)" } },
    { guards: ["creature:dest"], effect: "goTo", roles: { place: "creatureSpot(dest)" }, note: "a creature IS a place — its own spot" },
    ACCOMPANY_ROW,
  ],
  come: [
    { guards: ["home:dest"], effect: "goHome" },
    { guards: ["place:dest"], effect: "goTo", roles: { place: "place(dest)" } },
    { guards: ["creature:dest"], effect: "goTo", roles: { place: "creatureSpot(dest)" } },
    ACCOMPANY_ROW,
  ],
  run: [
    { guards: ["home:dest"], effect: "goHome" },
    { guards: ["place:dest"], effect: "goTo", roles: { place: "place(dest)" } },
    { guards: ["creature:dest"], effect: "goTo", roles: { place: "creatureSpot(dest)" } },
    ACCOMPANY_ROW,
  ],
  // `return` is the going-BACK reading: bare it means home, and a named place
  // makes it an ordinary go ("return + school"). The last row IS that "bare" —
  // and the accompany row sits ABOVE it, because "return with Mara" names
  // somebody to go back WITH and the home is only where a bare `return` would
  // have gone (the party still rides `companions`).
  return: [
    { guards: ["home:dest"], effect: "goHome" },
    { guards: ["place:dest"], effect: "goTo", roles: { place: "place(dest)" } },
    { guards: ["creature:dest"], effect: "goTo", roles: { place: "creatureSpot(dest)" } },
    ACCOMPANY_ROW,
    { guards: [], effect: "goHome", note: "bare `return` ⇒ home" },
  ],
  // chase = follow at urgency — same pursuit primitive, distinct word.
  follow: [
    { guards: ["creature:object|endpoint"], effect: "follow", roles: { target: "creature(object|endpoint)" } },
    ACCOMPANY_ROW,
  ],
  chase: [
    { guards: ["creature:object|endpoint"], effect: "follow", roles: { target: "creature(object|endpoint)" } },
    ACCOMPANY_ROW,
  ],
  stay: [{ guards: [], effect: "stay", roles: { place: "place(endpoint)?" } }],
  wait: [{ guards: [], effect: "stay", roles: { place: "place(endpoint)?" } }],
  // "stop {device}" — halt the ACTIVE THING, not the listener: a running device
  // turns off ("stop the water" shuts the tap). Anything else is a plain halt.
  // ⏳ SEAM: the precondition row (`doing(agent, verb)`, semantic-gaps 6) goes
  // ABOVE the halt row, not into a new arm.
  stop: [
    { guards: ["has:object", "isDevice:object", "item:object"], effect: "toggle", roles: { device: ITEM }, fixed: { state: "off" } },
    { guards: [], effect: "stay", roles: { place: "place(endpoint)?" } },
  ],

  // --- acquisition ------------------------------------------------------
  // get/take = possession, pick_up = the physical lift, carry = hold-and-move.
  // An explicit "to" makes it a DELIVERY. take/get prefer a RECIPIENT…
  get: [
    { guards: ["item:object", "hasBound:to", "creature:to"], effect: "give", roles: { item: ITEM, to: "creature(to)" } },
    { guards: ["item:object", "hasBound:to", "place:to"], effect: "putIn", roles: { item: ITEM, container: "place(to)" } },
    ...ACQUISITION_TAIL,
  ],
  take: [
    { guards: ["item:object", "hasBound:to", "creature:to"], effect: "give", roles: { item: ITEM, to: "creature(to)" } },
    { guards: ["item:object", "hasBound:to", "place:to"], effect: "putIn", roles: { item: ITEM, container: "place(to)" } },
    ...ACQUISITION_TAIL,
  ],
  pick_up: [
    { guards: ["item:object", "hasBound:to", "creature:to"], effect: "give", roles: { item: ITEM, to: "creature(to)" } },
    { guards: ["item:object", "hasBound:to", "place:to"], effect: "putIn", roles: { item: ITEM, container: "place(to)" } },
    ...ACQUISITION_TAIL,
  ],
  // …carry keeps its CONTAINER preference: the two rows are SWAPPED, and that
  // swap is the entire difference between `carry` and `take`.
  carry: [
    { guards: ["item:object", "hasBound:to", "place:to"], effect: "putIn", roles: { item: ITEM, container: "place(to)" } },
    { guards: ["item:object", "hasBound:to", "creature:to"], effect: "give", roles: { item: ITEM, to: "creature(to)" } },
    ...ACQUISITION_TAIL,
  ],

  // --- delivery ---------------------------------------------------------
  give: GIVE_ROWS,
  bring: GIVE_ROWS,
  // `share` is the GIVE family's third word, not a fourth primitive: what a
  // body DOES to share a thing is hand it over.
  share: GIVE_ROWS,

  // --- handling ---------------------------------------------------------
  // "color the shirt red" — recolour a NAMED item. The target COLOUR is not a
  // filter on WHICH item to find, so the object ref is probed with its `color_*`
  // descriptors STRIPPED (`objectNoColor`).
  color: [
    { guards: ["colorNamed", "item:objectNoColor"], effect: "color", roles: { item: "item(objectNoColor)", color: "modifier:color" } },
  ],
  put: PLACEMENT_ROWS,
  // Bare "drop X" (no destination) → set it down where you stand. Bare "put X"
  // has no place to go, so it stays unclear — which is the whole of the
  // difference, one row long.
  drop: [...PLACEMENT_ROWS, { guards: ["item:object"], effect: "drop", roles: { item: ITEM } }],
  // "throw the sock" = throw it AWAY: no stated destination → the trash bin.
  throw: [
    { guards: ["item:object", "place:target"], effect: "putIn", roles: { item: ITEM, container: "place(target)" } },
    { guards: ["item:object"], effect: "putIn", roles: { item: ITEM }, fixed: { container: { kind: "named", id: "bin" } } },
  ],

  // --- social -----------------------------------------------------------
  hug: [{ guards: ["creature:target|object"], effect: "socialAct", roles: { target: "creature(target|object)" }, fixed: { act: "hug" } }],
  // SHOW IS AN ATTENTION ACT, NOT A TRANSFER (build order L11): held up, looked
  // at, and still in the shower's hands afterwards. TWO REFUSALS ride the
  // guards — an audience that is not a creature is no audience ("show + ball +
  // to + box" stays not-understood), and a lone noun the world knows to be a
  // PERSON names the audience and leaves nothing to hold up ("show + mara").
  show: [
    { guards: ["has:target", "creature:target", "item:object"], effect: "socialAct", roles: { target: "creature(target)", item: ITEM }, fixed: { act: "show" } },
    { guards: ["no:target", "creature.not:object", "item:object"], effect: "socialAct", roles: { target: "player", item: ITEM }, fixed: { act: "show" }, note: "no audience ⇒ show ME (the speaker)" },
  ],
  // Adopt the target's surfaced need — the general on-behalf rule.
  help: [{ guards: ["creature:target|object"], effect: "help", roles: { target: "creature(target|object)" } }],
  // "talk to Mara" — a targeted CONVERSE; bare "talk" stays the social motive.
  talk: [
    { guards: ["creature:target|object"], effect: "converse", roles: { target: "creature(target|object)" } },
    { guards: [], effect: "satisfy", fixed: { need: "talk" } },
  ],
  // "play" is the fun motive, alone or in company — ONE behavior model. A named
  // partner rides the `with` marker `compileAction` attaches, which routes it
  // through the PLAY RITUAL. It must never become a `socialAct`: that was a
  // SECOND model of playing together, disjoint from the ritual.
  play: [{ guards: [], effect: "satisfy", fixed: { need: "play" } }],

  // --- opening ----------------------------------------------------------
  // A lidded CONTAINER opens its physical LID (`setOpen`); a DEVICE item (a
  // window, a lamp) stays a creature-world `toggle`.
  open: [
    { guards: ["isContainer:object", "place:object"], effect: "setOpen", roles: { place: "place(object)" }, fixed: { open: true } },
    { guards: ["item:object"], effect: "toggle", roles: { device: ITEM }, fixed: { state: "open" } },
  ],
  shut: [
    { guards: ["isContainer:object", "place:object"], effect: "setOpen", roles: { place: "place(object)" }, fixed: { open: false } },
    { guards: ["item:object"], effect: "toggle", roles: { device: ITEM }, fixed: { state: "closed" } },
  ],

  // --- making -----------------------------------------------------------
  // MAKE vs BUILD (user law, 2026-07-28): interchangeable verbs, opposite
  // PRIORITIES — and the priority is EXACTLY the order of these rows. `make`
  // reaches the makeable reading unconditionally; `build` reaches it only where
  // the word is not also a structure. Either verb still REACHES either goal.
  make: [
    // "make food" is the COOKING chore, never a structure (verb × category).
    { guards: ["categoryNeed"], effect: "satisfy", roles: { need: "categoryNeed" } },
    { guards: ["objectSymbol", "makeable"], effect: "craft", roles: { glyph: "makeableGlyph", cap: "quantityCap" } },
    { guards: ["objectSymbol"], effect: "build", roles: { structure: "objectSymbol", cap: "quantityCap" } },
  ],
  build: [
    { guards: ["categoryNeed"], effect: "satisfy", roles: { need: "categoryNeed" } },
    // A bare "build" is a real order — the FOUNDING flow. "make" alone stays unbound.
    { guards: ["no:objectSymbol"], effect: "build", roles: { cap: "quantityCap" }, fixed: { structure: "town" } },
    { guards: ["objectSymbol", "makeable", "isStructure.not:object"], effect: "craft", roles: { glyph: "makeableGlyph", cap: "quantityCap" } },
    { guards: ["objectSymbol"], effect: "build", roles: { structure: "objectSymbol", cap: "quantityCap" } },
  ],

  // --- unmaking ---------------------------------------------------------
  // THE UNMAKING VERBS (construction ④). Furniture is tested FIRST because it
  // is the narrower and more recoverable reading; the clearing row is LAST
  // because a felled bush is gone.
  break: [
    { guards: ["has:object", "isFurniture:object", "item:object"], effect: "breakPiece", roles: { item: ITEM } },
    { guards: ["objectSymbol", "isStructure:object"], effect: "demolish", roles: { room: "objectSymbol" } },
    CLEARING_ROW,
  ],
  cut: [CLEARING_ROW],
  fight: [CLEARING_ROW],
  // "empty the kitchen" — the stow-only half of `break`: the furniture comes
  // out, the walls stay up. Emptying a CONTAINER stays the transform.
  empty: [
    { guards: ["objectSymbol", "isStructure:object"], effect: "emptyRoom", roles: { room: "objectSymbol" } },
    { guards: ["item:object"], effect: "transform", roles: { item: ITEM, state: "transformState" } },
  ],

  // --- town orders ------------------------------------------------------
  // INTERCITY BARTER (⑤): give-good from the object; the PARTNER from the
  // with/to-marked noun; an optional "for <good>" names what we want BACK.
  // Nulls stay null — the host defaults them and SPEAKS the terms either way.
  trade: [
    { guards: ["objectSymbol"], effect: "trade", roles: { give: "objectSymbol", take: "trade:take", partner: "trade:partner" } },
  ],
  // AREA CHARTER (③): the brush is the host's focus circle at order time, so no
  // geometry rides the goal. "area none" (or a negated area) CLEARS the ground.
  area: [
    { guards: ["quantity:none"], effect: "area", fixed: { category: null } },
    { guards: ["negated"], effect: "area", fixed: { category: null } },
    { guards: ["objectSymbol"], effect: "area", roles: { category: "objectSymbol" } },
  ],
};

/**
 * THE DEFAULT ARM — the six ordered probes every verb with no rows of its own
 * walks. (Six probes, seven rows: the REST probe's creature-first station
 * disambiguation is two rows because a creature and a place are two channels.)
 */
export const DEFAULT_ROWS: VerbEffectRow[] = [
  // A CATEGORY object routes to its chore template FIRST ("wash the clothes" →
  // laundry) — before item binding would make it a one-item transform.
  { guards: ["categoryNeed"], effect: "satisfy", roles: { need: "categoryNeed" } },
  // A transform verb WITH an object transforms it ("wash the cup" → clean);
  // BARE, the same verb may be self-care ("you wash" → the hygiene motive).
  { guards: ["transformVerb", "item:object"], effect: "transform", roles: { item: ITEM, state: "transformState" } },
  // INGEST verbs NAMING a concrete item act on THAT item, never the abstract need.
  { guards: ["ingestVerb", "item:object"], effect: "consume", roles: { item: ITEM } },
  // "wear the shirt" — a targeted EQUIP of a named GARMENT. Only for clothing;
  // a non-garment "wear X" falls through to the dress self-care motive below.
  { guards: ["verb:wear", "isClothing:object", "item:object"], effect: "wear", roles: { item: ITEM } },
  // REST AT A STATION: a posture verb that NAMES where the body settles is not
  // the abstract need. COMPANY OUTRANKS THE STATION — `rest` carries no
  // companion and `satisfy` does, so "sleep with Mara" stays the SHARED need
  // (dropping a named body is the worse loss). A named BODY resolves
  // creature-first: a creature IS a place, its own spot.
  { guards: ["restVerb", "noCompanions", "creature:station"], effect: "rest", roles: { place: "creatureSpot(station)" } },
  { guards: ["restVerb", "noCompanions", "place:station"], effect: "rest", roles: { place: "place(station)" } },
  { guards: ["selfNeed"], effect: "satisfy", roles: { need: "verb" } },
];

/**
 * THE PHASE STAGE — rows walked BEFORE the verb's own, because a phase word
 * speaks about the ACTIVITY and not about what its verb means: "stop + eat" is
 * an order to CEASE, and reading it through `eat`'s rows would compile the very
 * act the child asked to end.
 *
 * ⚖️ THE HALT IS THE SAME; WHAT IS NEW IS THE HONESTY (semantic-gaps 6). Both
 * rows emit the identical `{kind:"stay"}` the pre-table intercept did — the goal
 * vocabulary still has no per-activity cancel — but the first also STATES what
 * it assumed: that the body is doing the thing it is being told to stop. When
 * it is not, the host has a true sentence to say (`i_me + {verb}.not`) instead
 * of a halt that lands on nothing.
 *
 * Row 2 is the phase with no main verb of its own (see `has:mainVerb`): nothing
 * is named, so nothing is assumed, and the plain halt stands. Bare "stop" — one
 * verb, no phase — never reaches here at all: it is the `stop` VERB, and its own
 * rows (device toggle, else halt) still own it.
 */
export const PHASE_ROWS: VerbEffectRow[] = [
  {
    guards: ["phase:stop", "has:mainVerb"], effect: "stay",
    precond: [{ kind: "doing", verb: "$verb" }],
    note: "stop + {V}: cease V — honest only if V is what the body is doing",
  },
  { guards: ["phase:stop"], effect: "stay", note: "a phase governing no verb: the plain halt" },
];

/** The ordered readings for a verb — its own rows, else the default arm's. */
export function verbEffectRows(verb: string): VerbEffectRow[] {
  return VERB_EFFECTS[verb] ?? DEFAULT_ROWS;
}

/** LEXICON directive verbs the table deliberately does not serve: they compile
 *  to null today and did before the port. Pinned by verb-effects.test.ts so a
 *  word cannot quietly gain (or lose) a meaning. */
export const UNMAPPED_VERBS = new Set(["turn", "push", "pull", "fix", "dig", "plant", "teach", "ask", "do"]);

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

/** A constant slot value, copied so nothing downstream can mutate the table. */
function copyFixed(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(copyFixed);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = copyFixed(x);
  return out;
}

function bindRow(row: VerbEffectRow, c: Ctx): GoalSpec {
  const goal: Record<string, unknown> = { kind: row.effect };
  if (row.fixed) for (const [slot, v] of Object.entries(row.fixed)) goal[slot] = copyFixed(v);
  if (row.roles) for (const [slot, src] of Object.entries(row.roles)) goal[slot] = ROLES[src](c);
  return goal as GoalSpec;
}

/** A matched row, bound: the act it names and what it assumed to name it. */
export interface EffectMatch {
  goal: GoalSpec;
  /** The row's `precond` with `$verb` RESOLVED to the frame's verb. Absent when
   *  the row asserts none — the field never appears empty. */
  preconditions?: Precondition[];
}

/** `$verb` → the frame's main verb. The one substitution the column allows. */
function resolvePreconds(row: VerbEffectRow, c: Ctx): Precondition[] | undefined {
  if (!row.precond?.length) return undefined;
  return row.precond.map((p) => (p.verb === "$verb" ? { ...p, verb: c.verb } : p));
}

/** THE LOOP. First row whose guards all hold wins. */
function matchRows(rows: readonly VerbEffectRow[], c: Ctx): EffectMatch | null {
  for (const row of rows) {
    if (!row.guards.every((g) => GUARDS[g](c))) continue;
    const preconditions = resolvePreconds(row, c);
    return preconditions ? { goal: bindRow(row, c), preconditions } : { goal: bindRow(row, c) };
  }
  return null;
}

/**
 * THE PHASE STAGE, run BEFORE the verb's rows (and before the `use` rewrite —
 * "stop using the oven" is a halt, not a cook). Null when the frame carries no
 * phase, so a caller can ask unconditionally.
 */
export function matchPhaseEffects(frame: IntentFrame, binder: IntentBinder): EffectMatch | null {
  return matchRows(PHASE_ROWS, makeCtx(frame, binder));
}

/**
 * The verb's own rows. Nothing matches ⇒ null, the explicit not-understood the
 * host speaks rather than a guessed act.
 */
export function matchVerbEffects(frame: IntentFrame, binder: IntentBinder): EffectMatch | null {
  const v = frame.verb;
  if (!v) return null;
  return matchRows(verbEffectRows(v), makeCtx(frame, binder));
}

/** The GOAL half of `matchVerbEffects` — what the compiler asked for before
 *  rows could carry preconditions, and still the whole answer for any caller
 *  that only wants the act. */
export function applyVerbEffects(frame: IntentFrame, binder: IntentBinder): GoalSpec | null {
  return matchVerbEffects(frame, binder)?.goal ?? null;
}

/** Exported for the row-order pins — the test asserts against the same table. */
export { GUARDS as VERB_EFFECT_GUARDS, ROLES as VERB_EFFECT_ROLES };
