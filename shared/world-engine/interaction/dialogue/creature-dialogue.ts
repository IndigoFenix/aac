// shared/world-engine/interaction/dialogue/creature-dialogue.ts
//
// Dialogue as a PROJECTION of creature state, following the condition-based
// dialogue states of planning-docs/symbol-learning-game/dialogue-states.md:
//
//   STATE 1 — creature has a (visible) need: "I want / give me {thing}", with
//     player acts: I give (offer) · I will help (agree) · I won't / give.not
//     (refuse → sad) · I don't have it (cant → a calm parting) · trade (single-known) or
//     trade-for-what menu (multi-known) · where-is (own need + heard wants;
//     answers: holder clue / "I have it" / "you have it" / don't-know) ·
//     confused · bye.
//   STATE 2 — no need, or hiding it (announce "after"): greet only (no
//     advertising mumble): "hi" / "you want something?" (vendor), with acts:
//     how-are-you (reveals a hidden need) · give-me (request, may be priced =
//     the trade counter) · I don't have it (when priced) · where-is for things
//     other creatures asked for · offers · confused · bye.
//
// Registry-backed question words + acts: where-is → "place#question + {thing}"
// ("where [is] X") · trade-for-what → "thing#question" ("what") · trade →
// the `trade` symbol (crossing arrows) · bye → "goodbye" (waving hand).
// Remaining interim: I-don't-know → "think.not" (`know` is a queued symbol).

import {
  causalPhrase,
  giveAsk,
  giveOffer,
  noStock,
  phrase,
  requestAsk,
  VENDOR_GREET,
  wantAsk,
  REJECTED_LINE,
  type LeveledGlyphs,
  type PhraseSpec,
  type SyntaxLevel,
} from "@shared/world-engine/interaction/dialogue/dialogue-gen.js";
import {
  giveItem,
  grantItem,
  itemMatchesNeed,
  knownHoldings,
  knownProvider,
  needStateOk,
  openNeeds,
  requestItem,
  settleObligations,
  STATE_TAGS,
  tellAbout,
  valueTo,
  type Clause,
  type CreatureEvent,
  type CreatureId,
  type CreatureNeed,
  type CreatureState,
  type CreatureWorld,
  type ItemId,
  type ItemState,
  type NeedTarget,
} from "@shared/world-engine/interaction/behavior/creatures.js";
import { headOf } from "../../variations.js";
import { willingnessToGive, type GiveResponse } from "@shared/world-engine/interaction/behavior/willingness.js";
import type { Relation } from "@shared/world-engine/interaction/behavior/relations.js";
import type { Personality } from "@shared/world-engine/interaction/behavior/personality.js";
import {
  knowsFact,
  tellFact,
  type Fact,
  type FactQuery,
} from "@shared/world-engine/interaction/behavior/facts.js";
import { canonicalVerb } from "@shared/world-engine/interaction/intent/parse-intent.js";

// ---------------------------------------------------------------------------
// Projection shapes
// ---------------------------------------------------------------------------

export type DialogueActKind =
  | "offer" // hand over an item in hand ("I give {thing}")
  | "agree" // "I will help" — closes; go do it
  | "refuse" // "I won't / give.not {thing}" — NPC is sad; closes
  | "cant" // "I don't have {thing}" — NPC parts calmly; closes
  | "request" // "give me {thing}" (any known holding; may be priced)
  | "trade" // propose the swap directly (single known holding)
  | "trade-menu" // "trade for what?" — opens the pick list
  | "trade-pick" // a pick inside the trade menu
  | "back" // leave an open sub-menu (trade / directions list)
  | "more" // advance to the next page of an open list
  | "how-are-you" // small talk; reveals a hidden need
  | "where-is" // information request about an ITEM (who holds it)
  | "ask-directions" // ask where a PLACE is, directly (a single known subject)
  | "directions-menu" // open the "where is…" list (several known subjects)
  | "directions-pick" // a pick inside the "where is…" list
  | "why" // ask WHY a need exists — reveals the cause clause (narration)
  | "tell" // ASSERT a fact to the listener (a location the speaker knows) — inform
  | "ask-fact" // query the listener's KNOWLEDGE for a generic Fact (facts.ts)
  | "tell-fact" // ASSERT a generic Fact (itemState/condition/presence) — inform
  | "where-going" // ask a MOVING creature where it's headed (answered from its errand)
  | "what-doing" // ask what a creature is DOING ("what dog eat?") — answered from the live world
  | "dont-understand" // the LISTENER can't interpret the utterance — honest floor, never silence
  | "deny-doing" // asked "why are you X-ing" while verifiably NOT X-ing — "I don't X"
  | "confused" // re-model one level down (presentation-level)
  | "bye"; // close the conversation

/** Where a creature is HEADED, for the "where are you going?" answer — read from
 *  its errand/goal by the world layer (this pure layer only phrases it). */
export type GoingDest =
  | { kind: "fetch"; good: string } // off to acquire a resource ("going to get food")
  | { kind: "home" } // heading home ("going home") — only from OUTSIDE it
  | { kind: "place"; place: string } // bound for a named place ("going to the market")
  /** Crossing the house to a ROOM ("going to the bedroom") — the honest answer
   *  for a body already at home, where "going home" reads as nonsense. */
  | { kind: "room"; room: string }
  /** Off to DO something ("I will eat", "I will wash the clothing") — the answer
   *  when the destination has no name worth speaking but the errand does. */
  | { kind: "activity"; verb: string; object?: string };

export interface DialogueAct {
  kind: DialogueActKind;
  itemId?: ItemId;
  /** A resource-TYPE reference (semantic-behavior.md §2b): the asker named a SORT
   *  ("food"), not an instance — the evaluator resolves it against the listener's
   *  own holdings (request) or knowledge → providers (where-is). */
  target?: NeedTarget;
  /** For directions acts: the place-fact SUBJECT id the player is asking about
   *  (resolved to geometry by the host, not by this pure layer). */
  subjectId?: string;
  /** where-is: the asker asked where to GET it ("where + get + apple") —
   *  prefer the provider/source answer over an instance location clue. */
  source?: boolean;
  /** ask-fact: the knowledge QUERY (facts.ts) the listener should answer. */
  query?: FactQuery;
  /** tell-fact: the asserted Fact the speaker shares. */
  fact?: Fact;
  /** ask-fact, POLAR ("apple hot?"): the claimed value — answered yes/no. */
  expect?: string;
  /** deny-doing: the activity verb the asker wrongly presumed.
   *  what-doing: the SPECIFIC activity asked about ("what dog EAT?"); absent =
   *  the broad ask ("what are you doing?"). */
  verb?: string;
  /** what-doing: WHO the question is about — the spoken symbol plus the
   *  resolved creature. An absent `id` = no such creature ("there is no dog"). */
  about?: { symbol: string; id?: CreatureId };
  glyph: string;
}

export interface DialogueProjection {
  lineGlyph: string;
  acts: DialogueAct[];
}

/** Per-conversation presentation state the CALLER holds (resets on walk-away). */
export interface ConversationMemo {
  /** A price the creature stated this conversation (the trade counter). */
  statedPrice?: { kind: "need" | "return"; itemId: ItemId };
  /** A hidden (announce:"after") need revealed by small talk this conversation. */
  revealed?: boolean;
  /** The trade-for-what pick list is open. */
  tradeMenu?: boolean;
  /** A generic paginated pick-list is open (e.g. the "where is…" directions
   *  menu). `menu` selects the item provider; `page` is the 0-based page,
   *  wrapped on overflow. */
  list?: { menu: string; page: number };
}

export interface ProjectionOpts {
  /** Does this creature volunteer its need unprompted ("before", default),
   *  only when asked ("after"), or NEVER ("never" — Request c: it just looks
   *  sad; the player must infer the want and OFFER it)? */
  announce?: "before" | "after" | "never";
  /** Resolve an item id to its glyph SYMBOL (world layer owns the mapping). */
  symbolOf: (itemId: ItemId) => string;
  /** Resolve a creature id to its glyph SYMBOL (for "the rabbit has it" clues). */
  symbolOfCreature?: (creatureId: CreatureId) => string;
  /** Items OTHER creatures asked for — the state-2 where-is menu. */
  askableWhere?: ItemId[];
  /** The player's KNOWN direction subjects (places they've heard of), MOST-
   *  RECENT FIRST, each with the glyph naming what they'd ask about ("where is
   *  the blue house?"). Already filtered to subjects THIS creature can answer
   *  (town common knowledge + own). Empty/undefined = no directions option. */
  askDirections?: { id: string; glyph: string }[];
  /** Physical gate on OFFERS/trades: only items actually IN HAND. */
  offerFilter?: (itemId: ItemId) => boolean;
  /**
   * Resolve an item to its PLACE symbol ("home.color_blue") — the building the
   * item (or its holder) is in. World layer owns the mapping; undefined = no
   * building clue (the answer falls back to the bare holder / "there").
   */
  placeOf?: (itemId: ItemId) => string | undefined;
  /**
   * For a resource-TYPE need (a shopper's "food"/"cloth" want) whose instance is
   * unknown: the place-fact SUBJECT id where that good is SOLD (the market). A
   * creature on an errand KNOWS where it's headed, so "where is food?" answers with
   * DIRECTIONS to the source instead of "I don't know" — symmetric with the
   * ask-directions channel (npc-behavior-and-town-economy.md §8, bug #2). Undefined
   * ⇒ fall back to the not-knowing line.
   */
  directionsForNeed?: (need: CreatureNeed) => string | undefined;
  /** Is this creature currently EN ROUTE somewhere? Returns its destination (from the
   *  errand/goal, resolved by the world layer), or undefined when it isn't going
   *  anywhere. Present ⇒ the board offers "where are you going?" and the reply names
   *  the destination (fetch a good / home / a place). */
  goingOf?: (creatureId: CreatureId) => GoingDest | undefined;
  /** The activity verbs a creature is VERIFIABLY doing right now — the premise
   *  check for "why are you X-ing?". `[]` = known idle (a denial is truthful);
   *  undefined / hook absent = can't tell (answered "I don't understand"). */
  doingOf?: (creatureId: CreatureId) => string[] | undefined;
  /** What a creature is doing right now WITH the activity's object — the
   *  "what is X doing / eating?" answer ("eat" + "apple" → "dog + eat +
   *  apple"). `null` = verifiably idle; `undefined` = can't tell. Hook absent
   *  ⇒ fall back to doingOf (verb only, no object). */
  activityOf?: (creatureId: CreatureId) => { verb: string; object?: string } | null | undefined;
  /** The listener's directed ATTITUDE toward a speaker (relations.ts) — feeds the
   *  §4b generosity gate on requests. Absent = a neutral stranger. */
  relationOf?: (observer: CreatureId, subject: CreatureId) => Relation;
  /** A creature's intrinsic dials (personality.ts) — warmth is the disposition to
   *  give. Absent = the neutral midpoint. */
  personalityOf?: (creatureId: CreatureId) => Personality;
  /** Resolve a spoken symbol/NAME to a creature id ("mara" → its resident cid) —
   *  the household name book. Drives the third-party fact questions. */
  creatureOf?: (symbol: string) => CreatureId | undefined;
  /** ROSTER-seeded presence (household-duties: the duty schedule is common
   *  knowledge): a household member's current place WORD ("home"/"work"), or
   *  undefined to fall back to perceived/told facts. Answers "where is Mara?"
   *  without a dollhouse full of don't-knows. */
  presenceOf?: (creatureId: CreatureId) => string | undefined;
  /** Board capacity. Default 8 (the response board is 2×4). */
  maxActs?: number;
}

const at = (g: LeveledGlyphs, level: SyntaxLevel): string => g[level];

// -- descriptor helpers (Item b) ---------------------------------------------
// Variant items carry COMPOSED glyphs ("ball.big"): head = the kind, dot
// modifiers = the descriptors. Same head + different modifiers = right kind,
// wrong variant — the corrective-response case.

/** State-aware views over the static entity symbols (transformations): `base`
 *  strips STATE tags (an item's INITIAL state travels in its entity glyph),
 *  `now` re-composes the item's CURRENT states, `want` composes a need's
 *  REQUIRED state ("apple.hot" while the world only holds a cold one). */
function makeSyms(world: CreatureWorld, sym: (id: ItemId) => string, likes?: readonly string[]) {
  const base = (id: ItemId): string => {
    const parts = sym(id).split(".");
    return [parts[0]!, ...parts.slice(1).filter((m) => !STATE_TAGS.has(m))].join(".");
  };
  const now = (id: ItemId): string => [base(id), ...(world.items[id]?.states ?? [])].join(".");
  // The WANTED composition: base (kind + immutable descriptors) + the required
  // state, if any — NEVER the item's baked spawn state ("apple.cold" for a
  // hot-need item). A stateless need is just its base identity.
  const want = (n: Pick<CreatureNeed, "itemId" | "requiresState">): string =>
    n.requiresState ? `${base(n.itemId)}.${n.requiresState}` : base(n.itemId);
  // What the creature WANTS, decoupled from the designated instance: a TARGET
  // need reads as its predicate ("something hot" / "food"), never the specific
  // item the generator picked; an exact need reads as its item. A LIKED kind
  // VOICES a category want ("i_me want apple", not "… food") — voice only,
  // matching stays category-loose.
  const wantOf = (n: CreatureNeed): string => {
    if (!n.target) return want(n);
    const liked = likes ? likedKindFor(world, likes, n.target) : undefined;
    return targetGlyph(liked ? { ...n.target, kind: liked } : n.target);
  };
  return { base, now, want, wantOf };
}

/** Verbalize a causal CLAUSE as a phrase() spec — the deixis-resolved subject
 *  (whoSym) plus a state-aware object (syms). Used for the WHY answer and (later)
 *  the in_order_to need line. */
function clauseSpec(
  cl: Clause,
  whoSym: (id: CreatureId) => string,
  syms: { base: (id: ItemId) => string; now: (id: ItemId) => string },
): PhraseSpec {
  switch (cl.kind) {
    case "possessionLack":
      return { subject: whoSym(cl.creature), verb: "have.not", object: syms.base(cl.item) };
    case "creatureState":
      return { subject: whoSym(cl.creature), verb: cl.state, key: cl.state };
    case "itemState":
      // Base symbol + the state as separate glyphs ("window + open"), NOT the
      // composed now() form (which would double the state: "window.open + open").
      return { subject: syms.base(cl.item), verb: cl.state, key: cl.state };
    case "likes":
      // Preference (motive batch): "i_me + like + {item|facet}" — the facet is
      // a bare quality symbol ("color_red" — "I like red").
      return { subject: whoSym(cl.creature), verb: "like", object: cl.item ? syms.base(cl.item) : (cl.facet ?? "thing") };
    case "wantsTo":
      // Desire (motive batch): "i_me + want + {verb}" — "I want to play".
      return { subject: whoSym(cl.creature), verb: "want", object: cl.verb };
  }
}

// -- interim templates (registry gaps noted in the header) -------------------

const BYE: LeveledGlyphs = { a: "goodbye", b: "goodbye", c: "goodbye" };
// The generic pick-list controls (shared by the directions "where is…" menu):
// "more" advances a page, "no" backs out, "place?" opens the menu.
const MORE_PAGE: LeveledGlyphs = { a: "more", b: "more", c: "more" };
const LIST_BACK: LeveledGlyphs = { a: "no", b: "no", c: "no" };
const CONFUSED_GLYPH: LeveledGlyphs = { a: "confused", b: "confused", c: "confused" };
const WHERE_MENU: LeveledGlyphs = { a: "place#question", b: "place#question", c: "place#question" };
// "no" would read as refusal — the honest single glyph is the not-knowing.
const DONT_KNOW: LeveledGlyphs = phrase({ subject: "i_me", verb: "think.not", key: "think.not" });
// The explicit can't-interpret line (phase ①a §1) — a question with no honest
// read gets THIS, never silence and never a non-sequitur small-talk answer.
const NOT_UNDERSTOOD: LeveledGlyphs = phrase({ subject: "i_me", verb: "understand.not", key: "understand.not" });
const HOW_ARE_YOU: LeveledGlyphs = {
  a: "ok#question",
  b: "you + ok#question",
  c: "you + ok#question",
};

function agreeHelp(): LeveledGlyphs {
  return phrase({ subject: "i_me", verb: "help", object: "you", key: "yes" });
}
function refuseGlyph(holding: string | null): LeveledGlyphs {
  return holding
    ? phrase({ subject: "i_me", verb: "give.not", object: holding, key: "no" })
    : phrase({ subject: "i_me", verb: "help.not", object: "you", key: "no" });
}
function cantGlyph(thing: string): LeveledGlyphs {
  return phrase({ subject: "i_me", verb: "have.not", object: thing, key: "have.not" });
}
/** Ask a MOVING creature where it's headed ("where are you going?"). `place#question`
 *  is the registry's "where"; the question word LEADS ("where + you + go"), so
 *  the button reads as the question, not the command "you go place". */
function whereGoingAsk(): LeveledGlyphs {
  return { a: "place#question + go", b: "place#question + you + go", c: "place#question + you + go" };
}
/** A moving creature's answer to "where are you going?", from its errand destination:
 *  fetching a good, heading home, or bound for a named place. */
function goingLine(dest: GoingDest): LeveledGlyphs {
  switch (dest.kind) {
    case "fetch":
      return { a: `get + ${dest.good}`, b: `go + get + ${dest.good}`, c: `i_me + go + get + ${dest.good}` };
    case "home":
      return { a: "home", b: "go + home", c: "i_me + go + home" };
    case "place":
      return { a: dest.place, b: `go + ${dest.place}`, c: `i_me + go + to + ${dest.place}` };
    case "room":
      // Room words are ordinary place nouns, so the movement frame already
      // speaks them ("I'm going to the bedroom") in every ruleset.
      return { a: dest.room, b: `go + ${dest.room}`, c: `i_me + go + to + ${dest.room}` };
    case "activity":
      // The INTENT form (`.will`) — what the walk is FOR, when the place it
      // ends at has no word of its own ("I will wash the clothing").
      return phrase({
        subject: "i_me",
        verb: `${dest.verb}.will`,
        ...(dest.object ? { object: dest.object } : {}),
        key: dest.verb,
      });
  }
}
/** A creature that isn't going anywhere: "I'm here" (staying put). */
const HERE_STAY: LeveledGlyphs = { a: "here", b: "i_me + here", c: "i_me + here" };
/** The asked-about creature isn't here at all ("no + dog" — there is no dog). */
function noSuch(symbol: string): LeveledGlyphs {
  return { a: "no", b: `no + ${symbol}`, c: `no + ${symbol}` };
}
/** Premise-corrected activity denial, deixis-resolved subject ("dog + eat.not"
 *  — the dog is not eating; "i_me + eat.not" — I'm not eating). */
function notDoing(who: string, verb: string): LeveledGlyphs {
  return phrase({ subject: who, verb: `${verb}.not`, key: `${verb}.not` });
}
function whereIs(thing: string): LeveledGlyphs {
  // `place#question` is the registry's "where" question word; the full form is
  // the §Specifics "where + get + {item}" frame. Level a (single-glyph mode)
  // puts the THING in focus with the question badge ("cookie?") — the where
  // icon alone doesn't say where WHAT, and several where-is buttons side by
  // side would be identical.
  return {
    a: `${thing}#question`,
    b: `place#question + ${thing}`,
    c: `place#question + get + ${thing}`,
  };
}
/** The WHY ask BUTTON (puzzle-types §Specifics "Ask for reason"). `why` is a
 *  queued question word (glyph-symbol-vocabulary.md); it renders as its label
 *  until the symbol ships. The creature's ANSWER is the two-clause causal line. */
function whyAsk(thing: string): LeveledGlyphs {
  return { a: "why", b: `why + ${thing}`, c: `why + you + want + ${thing}` };
}
/** Multi-item needs: a same-kind need already fulfilled → the ask reads MORE. */
function wantMore(thing: string): LeveledGlyphs {
  return { a: "more", b: `more + ${thing}`, c: `want + more + ${thing}` };
}
/** Placement (state) need: "I want {thing} in {dest}". */
function wantPlace(thing: string, dest: string): LeveledGlyphs {
  return phrase({ subject: "i_me", verb: "want", object: thing, tail: { join: "in", symbol: dest } });
}
/** DISPOSAL placement (motive batch): "throw {thing} in {garbage}" — a DISTINCT
 *  statement from an ordinary placement (the `throw` verb leads, not `want`). */
function wantThrow(thing: string, dest: string): LeveledGlyphs {
  return { a: "throw", b: `throw + ${thing}`, c: `you + throw + ${thing} + in + ${dest}` };
}
/** Device-state need (§5): "I want the {device} {state}" (on/off/open/closed).
 *  Level a is the STATE alone — the ON/OFF concept under test. */
function wantDevice(device: string, state: string): LeveledGlyphs {
  return { a: state, b: `${device} + ${state}`, c: `i_me + want + ${device} + ${state}` };
}
/** Presence (go-to) need (§5): "you + go + to + {dest}" — the player navigates
 *  to the destination creature. Level a is the destination alone. */
function wantGo(dest: string): LeveledGlyphs {
  return { a: dest, b: `go + ${dest}`, c: `you + go + to + ${dest}` };
}
/** STAY-WITH want (motive batch): "you + stay + with + i_me" — the company ask. */
function wantStay(): LeveledGlyphs {
  return { a: "stay", b: "stay + with + i_me", c: "you + stay + with + i_me" };
}
/** ESCORT want (motive batch): "you + take + i_me + to + {dest}". Level b keeps
 *  the destination (the clarity exception — "take me" without WHERE says nothing). */
function wantEscort(dest: string): LeveledGlyphs {
  return { a: dest, b: `take + i_me + to + ${dest}`, c: `you + take + i_me + to + ${dest}` };
}
/** The stay-with COMPLETION line — the world layer speaks it when the dwell
 *  finishes ("I'm okay, thank you!"). Exported for the player. */
export const STAY_DONE_LINE = "i_me + ok + thank_you";
/** A bare WHY ask (stay-with — there's no want OBJECT to name). */
const WHY_PLAIN: LeveledGlyphs = { a: "why", b: "why", c: "why" };
/** The GLYPH for a parameter want (motive-driven-needs.md): a kind composes with
 *  its descriptors + state ("apple.hot"); a kind-less want is the salient facet
 *  alone ("hot" = "something hot"; "food"; "color_red"). */
function targetGlyph(t: NeedTarget): string {
  if (t.kind) return [t.kind, ...(t.descriptors ?? []), ...(t.state ? [t.state] : [])].join(".");
  return t.category ?? t.state ?? ((t.descriptors ?? []).join(".") || "thing");
}
/** PREFERENCE voice (fruit likes): the first of `likes` naming a KIND of the
 *  target's CATEGORY (membership read off the world's item facets), for a
 *  category want with no kind of its own. Voice + choice only — matching stays
 *  category-loose (any food still satisfies). */
export function likedKindFor(
  world: CreatureWorld,
  likes: readonly string[],
  target: NeedTarget,
): string | undefined {
  if (target.kind || !target.category) return undefined;
  return likes.find((like) =>
    Object.values(world.items).some((i) => i.kind === like && i.category === target.category),
  );
}
/** The liked KIND behind a possession want, if any: the target's own kind when
 *  the creature likes it, else the like that voices its category. Gates the
 *  preference WHY ("because I like apple"). */
function likedWantKind(
  world: CreatureWorld,
  creature: Pick<CreatureState, "likes">,
  need: CreatureNeed,
): string | undefined {
  if (!need.target || need.placedAt || need.forCreature || need.deviceState || need.atPlace) return undefined;
  if (need.target.kind) return creature.likes.includes(need.target.kind) ? need.target.kind : undefined;
  return likedKindFor(world, creature.likes, need.target);
}
/** A MOTIVE line (§C): "i_me + {condition}" — just the plight ("I am cold"),
 *  the want left to be inferred. The WASTE motive isn't an adjective — it
 *  speaks as the need it is ("I need the bathroom", core AAC vocabulary). */
function conditionLine(condition: string): LeveledGlyphs {
  if (condition === "need_toilet") {
    return { a: "bathroom", b: "i_me + need + bathroom", c: "i_me + need + bathroom" };
  }
  return { a: condition, b: `i_me + ${condition}`, c: `i_me + ${condition}` };
}
/** The FACETS a need wants — its parameter TARGET, or (for an exact need) the
 *  designated item's own facets. Used to judge an OFFERED/CARRIED item against
 *  the want WITHOUT referencing the designated instance directly. */
function wantFacets(
  need: CreatureNeed,
  world: CreatureWorld,
): { kind?: string; category?: string; descriptors?: string[]; state?: string } {
  if (need.target) return need.target;
  const it = world.items[need.itemId];
  return { kind: it?.kind, descriptors: it?.descriptors, state: need.requiresState };
}
/** Is `item` the RIGHT SORT of thing for `want` (kind + category match)? A
 *  descriptor/state correction only makes sense for the same sort. */
function sameSort(want: { kind?: string; category?: string }, item: ItemState): boolean {
  return (!want.kind || item.kind === want.kind) && (!want.category || item.category === want.category);
}
/** On-behalf need: "give {thing} to {who}" — the first recipient frame. */
function wantFor(thing: string, who: string): LeveledGlyphs {
  return phrase({ subject: "you", verb: "give", object: thing, tail: { join: "to", symbol: who } });
}
function tradeGlyph(give: string, get: string): LeveledGlyphs {
  return { a: get, b: `trade + ${get}`, c: `${give} + for + ${get}` };
}
function tradeWhat(give: string): LeveledGlyphs {
  // `thing#question` is the registry's "what" question word: "trade… for what?"
  return { a: "trade", b: `trade + thing#question`, c: `${give} + for + thing#question` };
}
/** Someone (deixis-resolved: "you" / a creature's symbol) has the thing. */
function clueHolder(holder: string, thing: string): LeveledGlyphs {
  return phrase({ subject: holder, verb: "have", object: thing, key: holder, bFull: true });
}
/** The asked creature holds it itself ("I have it!") — first person. */
function clueSelf(thing: string): LeveledGlyphs {
  return phrase({ subject: "i_me", verb: "have", object: thing, key: "have" });
}
/** A building location clue: "{thing} + in + home.color_blue" — "the ball is
 *  in the blue house". Level a shows just the house (the map answer). */
function cluePlace(thing: string, place: string): LeveledGlyphs {
  const g = `${thing} + in + ${place}`;
  return { a: place, b: g, c: g };
}
/** Verbalize a generic Fact (facts.ts) as an answer line — the shape every
 *  ask-fact reply and gossip line shares. Deixis-resolved (whoSym), state-aware
 *  (syms). */
function factLine(
  fact: Fact,
  whoSym: (id: CreatureId) => string,
  syms: { base: (id: ItemId) => string; now: (id: ItemId) => string },
): LeveledGlyphs {
  switch (fact.kind) {
    case "location": {
      if (fact.where.kind === "held") return clueHolder(whoSym(fact.where.by), syms.now(fact.item));
      const thing = syms.now(fact.item);
      return { a: "there", b: `${thing} + here`, c: `${thing} + here` };
    }
    case "want":
      return phrase({ subject: whoSym(fact.creature), verb: "want", object: syms.base(fact.item) });
    case "itemState":
      // Base symbol + the state as separate glyphs ("window + open") — the
      // clauseSpec itemState shape, never the doubled now() composition.
      return phrase({ subject: syms.base(fact.item), verb: fact.state, key: fact.state });
    case "condition":
      return fact.condition
        ? phrase({ subject: whoSym(fact.creature), verb: fact.condition, key: fact.condition })
        : phrase({ subject: whoSym(fact.creature), verb: "ok", key: "ok" });
    case "presence":
      return phrase({
        subject: whoSym(fact.creature),
        tail: { join: "in", symbol: fact.place },
        key: fact.place,
      });
  }
}

/** Creature declines an OFFERED item ("no thanks, I don't want the sock"). */
function declineOffer(thing: string): LeveledGlyphs {
  return phrase({ subject: "i_me", verb: "want.not", object: thing, key: "no" });
}
/** Right KIND, wrong DESCRIPTOR: "{item} + {wanted-descriptor}.not" —
 *  "ball, not big" — names exactly what the offered variant is missing. */
function wrongVariant(head: string, wantedMod: string): LeveledGlyphs {
  const g = `${head} + ${wantedMod}.not`;
  return { a: `${wantedMod}.not`, b: g, c: g };
}
/** Creature refuses to part with a BOUND possession ("no — my cookie"). */
function mineDecline(thing: string): LeveledGlyphs {
  return { a: `${thing}.my`, b: `no + ${thing}.my`, c: `no + ${thing}.my` };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** The creature's currently-VISIBLE need (a hidden one shows after small talk;
 *  a NEVER-announced one stays hidden for good — inference territory). */
function visibleNeed(
  world: CreatureWorld,
  creatureId: CreatureId,
  opts: ProjectionOpts,
  memo: ConversationMemo,
) {
  const creature = world.creatures[creatureId];
  const need = creature ? openNeeds(creature)[0] : undefined;
  if (!need) return undefined;
  if (opts.announce === "never") return undefined;
  return opts.announce === "after" && !memo.revealed ? undefined : need;
}

/** The persistent sad emote of a creature that never states its want. */
const SAD_GREET: LeveledGlyphs = { a: "sad", b: "i_me + sad", c: "i_me + sad" };

/** A problem-free creature's "how are you" answer — the simple positive state
 *  (phase ①a §1: a THIN emotional-state report; richer moods come later). */
const CONTENT_LINE: LeveledGlyphs = { a: "happy", b: "i_me + happy", c: "i_me + happy" };

export function projectDialogue(
  world: CreatureWorld,
  creatureId: CreatureId,
  playerId: CreatureId,
  level: SyntaxLevel,
  opts: ProjectionOpts,
  memo: ConversationMemo = {},
): DialogueProjection {
  const creature = world.creatures[creatureId];
  if (!creature) return { lineGlyph: "hi", acts: [] };
  const sym = opts.symbolOf;
  const syms = makeSyms(world, sym, creature.likes);
  // Person deixis: a reference to the SPEAKER is "i_me", to the LISTENER
  // (the player) "you"; only third parties keep their creature symbol.
  const whoSym = (id: CreatureId): string =>
    id === creatureId ? "i_me" : id === playerId ? "you" : (opts.symbolOfCreature?.(id) ?? "there");
  const carried = Object.values(world.items)
    .filter((i) => i.ownerId === playerId && (opts.offerFilter?.(i.id) ?? true))
    .map((i) => i.id)
    .sort();
  const known = knownHoldings(world, playerId, creatureId);
  const need = visibleNeed(world, creatureId, opts, memo);
  // ANY carried instance matching an open possession need counts as "holding
  // the need" — multi-item needs share one symbol across instances, and the
  // visible need is merely the first. State needs (placement / on-behalf) are
  // never hand-overs to THIS creature, and a transformed-state requirement
  // must be MET before the hand-over line/offer appears.
  const isStateNeed = (n: {
    placedAt?: string;
    forCreature?: string;
    deviceState?: string;
    atPlace?: string;
  }) => !!n.placedAt || !!n.forCreature || !!n.deviceState || !!n.atPlace;
  const holdingNeed =
    need && !isStateNeed(need)
      ? (carried.find((c) => {
          const it = world.items[c];
          // Parameter-aware: a carried item that MATCHES an open possession need
          // (loose target or exact instance) counts as "holding the need".
          return !!it && creature.needs.some((n) => !n.fulfilled && itemMatchesNeed(n, it));
        }) ?? null)
      : null;

  // -- the line ---------------------------------------------------------------
  let lineGlyph: string;
  if (memo.statedPrice) {
    lineGlyph =
      memo.statedPrice.kind === "return"
        ? at(giveAsk(syms.now(memo.statedPrice.itemId)), level)
        : at(wantAsk(syms.now(memo.statedPrice.itemId)), level);
  } else if (memo.tradeMenu && need) {
    lineGlyph = at(tradeWhat(syms.want(need)), level); // "cookie for…?"
  } else if (need) {
    if (need.placedAt) {
      lineGlyph = at(
        need.dispose
          ? wantThrow(syms.now(need.itemId), sym(need.placedAt))
          : wantPlace(syms.want(need), sym(need.placedAt)),
        level,
      );
    } else if (need.forCreature) {
      const purpose = need.causalFact?.connective === "in_order_to" ? need.causalFact : undefined;
      if (purpose) {
        // The remedy→goal LINE: "give {thing} to {who} + in_order_to + {goal}".
        const action: PhraseSpec = {
          subject: "you",
          verb: "give",
          object: syms.want(need),
          tail: { join: "to", symbol: whoSym(need.forCreature) },
        };
        lineGlyph = at(causalPhrase(action, purpose.connective, clauseSpec(purpose.cause, whoSym, syms)), level);
      } else {
        lineGlyph = at(wantFor(syms.want(need), whoSym(need.forCreature)), level);
      }
    } else if (need.atPlace) {
      if (need.stay) {
        // STAY-WITH (motive batch): the want ("stay with me") or, at reveal
        // "motive", just the plight ("I am lonely") — the player infers.
        lineGlyph =
          creature.condition && (need.reveal ?? "want") === "motive"
            ? at(conditionLine(creature.condition), level)
            : at(wantStay(), level);
      } else if (need.escort) {
        // ESCORT (motive batch): "take me to {dest}" — agree, and it follows.
        lineGlyph = at(wantEscort(whoSym(need.atPlace)), level);
      } else {
        // Presence (go-to) need (§5): "you + go + to + {dest}".
        lineGlyph = at(wantGo(whoSym(need.atPlace)), level);
      }
    } else if (need.deviceState) {
      // Device-state need (§5): "i_me want {device} {state}". WHY reveals the
      // device's current bad state as the cause.
      lineGlyph = at(wantDevice(syms.base(need.itemId), need.deviceState), level);
    } else if (holdingNeed) {
      lineGlyph = at(giveAsk(syms.now(holdingNeed)), level);
    } else if (creature.condition && !isStateNeed(need)) {
      // MOTIVE need (feedback): the OPENING is either the WANT ("I want something
      // hot") or just the MOTIVE ("I am cold") — never the two-clause "want
      // because" as an UNPROMPTED greeting (that reads backwards). The causal
      // link is the WHY answer; the motive's acts are the same want acts.
      lineGlyph =
        (need.reveal ?? "want") === "motive"
          ? at(conditionLine(creature.condition), level)
          : at(wantAsk(syms.wantOf(need)), level);
    } else {
      // A same-kind need already fulfilled → "more"; else the want (a parameter
      // target reads as "something hot", never the designated item).
      const wantG = syms.wantOf(need);
      const again = creature.needs.some((n) => n.fulfilled && sym(n.itemId) === sym(need.itemId));
      lineGlyph = at(again ? wantMore(wantG) : wantAsk(wantG), level);
    }
  } else if (opts.announce === "never" && openNeeds(creature).length > 0) {
    // Request c: the unstated need shows as a persistent EMOTE, never words —
    // the player reads the sadness + the staged evidence and offers.
    lineGlyph = at(SAD_GREET, level);
  } else {
    // No visible need: greet only — never an advertising mumble.
    const isVendor = Object.values(world.items).some((i) => i.ownerId === creatureId && i.displayed);
    lineGlyph = isVendor ? at(VENDOR_GREET, level) : "hi";
  }

  // -- the acts ---------------------------------------------------------------
  const acts: DialogueAct[] = [];
  const push = (kind: DialogueActKind, glyphs: LeveledGlyphs, itemId?: ItemId) =>
    acts.push({ kind, itemId, glyph: at(glyphs, level) });

  const maxActs = opts.maxActs ?? 8;

  // A generic paginated pick-list is open (the "where is…" directions menu, and
  // future list menus): show ONLY that page — picks + more + back — like the
  // trade menu's own early return below.
  if (memo.list) {
    return { lineGlyph, acts: listActs(memo.list, opts, level, maxActs) };
  }

  if (memo.tradeMenu && need) {
    // The trade pick list: "cookie for {item}?" per known holding, plus back.
    for (const itemId of known) {
      if (world.items[itemId]?.bound) continue;
      push("trade-pick", tradeGlyph(syms.want(need), syms.now(itemId)), itemId);
    }
    push("back", { a: "no", b: "no", c: "no" });
    push("confused", { a: "confused", b: "confused", c: "confused" });
    return { lineGlyph, acts };
  }

  if (need) {
    // STATE 1 — a visible need.
    if (holdingNeed) {
      push("offer", giveOffer(syms.now(holdingNeed)), holdingNeed);
      const tradeable = known.filter((k) => !world.items[k]?.bound);
      if (tradeable.length === 1) {
        push("trade", tradeGlyph(syms.now(holdingNeed), syms.now(tradeable[0]!)), tradeable[0]);
      } else if (tradeable.length > 1) {
        push("trade-menu", tradeWhat(syms.now(holdingNeed)));
      }
    } else {
      push("agree", agreeHelp());
      // "I don't have it" makes no sense while visibly holding a state need's
      // item — the missing step is the box / the recipient, not finding it — nor
      // for a presence need (there's no item to have).
      if (!need.atPlace && !(isStateNeed(need) && carried.includes(need.itemId))) {
        // "I don't have {want}" names the WANT ("something hot"), not the item.
        push("cant", cantGlyph(syms.wantOf(need)), need.itemId);
      }
    }
    // WRONG-VARIANT offers: surface a CARRIED item that is the right SORT of
    // thing for the want but doesn't fully satisfy it (a cold "hot" item, a
    // small "big" one) — the corrective decline is the lesson. Judged by the
    // want's FACETS against the item actually carried, not the designated one.
    if (!need.placedAt && !need.atPlace) {
      const w = wantFacets(need, world);
      // Only surface near-misses of a real SORT (a named kind/category); a
      // kind-less want ("something hot") has no "wrong variant" to offer — the
      // player offers a matching item (holdingNeed) instead.
      const hasSort = !!(w.kind || w.category);
      for (const c of hasSort ? carried : []) {
        if (c === holdingNeed) continue;
        const cItem = world.items[c];
        if (!cItem || !sameSort(w, cItem) || itemMatchesNeed(need, cItem)) continue;
        if (acts.some((a) => a.kind === "offer" && a.itemId === c)) continue;
        push("offer", giveOffer(syms.now(c)), c);
      }
    }
    push("refuse", refuseGlyph(holdingNeed ? syms.now(holdingNeed) : null), need.itemId);
    // Where-is is about finding what's WANTED — "where is something hot" — not
    // the designated item; a presence (go-to) need has no item to find. For a
    // resource-TYPE want the creature can't locate an instance for, carry the
    // SOURCE directions subject (the market) so the answer POINTS the way instead
    // of "I don't know" — a shopper knows where it shops (bug #2).
    if (!need.atPlace) {
      const dirSubj = need.target ? opts.directionsForNeed?.(need) : undefined;
      acts.push({
        kind: "where-is",
        itemId: need.itemId,
        ...(dirSubj ? { subjectId: dirSubj } : {}),
        glyph: at(whereIs(syms.wantOf(need)), level),
      });
    }
    // Information requests aren't gated on MY need: heard wants are askable
    // here too — the ask-around loop, where any creature may hold the clue.
    for (const itemId of opts.askableWhere ?? []) {
      if (itemId === need.itemId) continue;
      if (carried.includes(itemId) || world.items[itemId]?.ownerId === playerId) continue;
      push("where-is", whereIs(syms.base(itemId)), itemId);
    }
    // WHY: a REVEAL-style because fact (the reason isn't in the line) can be
    // asked — item lack, a device's bad state, a preference ("I like it"), a
    // desire ("I want to play"), or the item's own spoilage. A creature-state
    // because LEADS in the line already, so it gets no why act. The ask names
    // the WANT (predicate-decoupled), never the designated instance.
    const fact = need.causalFact;
    if (
      (fact?.connective === "because" || fact?.connective === "therefore") &&
      fact.cause.kind !== "creatureState"
    ) {
      push("why", whyAsk(syms.wantOf(need)), need.itemId);
    }
    // PREFERENCE why (fruit likes): a want VOICED through a like ("i_me want
    // apple" for a food want) is askable without an authored fact — the like IS
    // the reason. Authored facts and motive conditions keep their own gates.
    if (!fact && !creature.condition && likedWantKind(world, creature, need)) {
      push("why", whyAsk(syms.wantOf(need)), need.itemId);
    }
    // MOTIVE need: when the want is stated, WHY reveals the motive ("I want hot
    // because I am cold"). A motive-only opening already shows the plight. The
    // stay-with need ("stay with me… why? …because I'm lonely") is a state
    // need, so it gets its own bare WHY.
    if (creature.condition && (need.reveal ?? "want") !== "motive") {
      if (!isStateNeed(need)) {
        push("why", whyAsk(syms.wantOf(need)), need.itemId);
      } else if (need.stay) {
        push("why", WHY_PLAIN, need.itemId);
      }
    }
  } else {
    // STATE 2 — no visible need: small talk, requests, information.
    push("how-are-you", HOW_ARE_YOU);
    for (const itemId of known) {
      push("request", requestAsk(syms.now(itemId)), itemId);
    }
    if (memo.statedPrice && !carried.includes(memo.statedPrice.itemId)) {
      push("cant", cantGlyph(syms.now(memo.statedPrice.itemId)), memo.statedPrice.itemId);
    }
    for (const itemId of opts.askableWhere ?? []) {
      if (carried.includes(itemId) || world.items[itemId]?.ownerId === playerId) continue;
      push("where-is", whereIs(syms.base(itemId)), itemId);
    }
    // Gifts are still possible (the creature may decline what it doesn't value).
    for (const itemId of carried) {
      if (acts.some((a) => a.kind === "offer" && a.itemId === itemId)) continue;
      push("offer", giveOffer(syms.now(itemId)), itemId);
    }
  }
  // WHERE ARE YOU GOING — only for a creature actually EN ROUTE (the world layer
  // reports its errand destination). Its answer names where it's headed; a
  // stationary creature has no such ask. Available in both dialogue states.
  if (opts.goingOf?.(creatureId)) {
    push("where-going", whereGoingAsk());
  }
  // ASK FOR DIRECTIONS — the town places the player has heard of that THIS
  // person can point to (host-filtered). One subject → a direct "where is X?";
  // several → open the paginated "where is…" list. Available in both states:
  // anyone in town can be asked the way.
  const askDirs = opts.askDirections ?? [];
  if (askDirs.length === 1) {
    acts.push({
      kind: "ask-directions",
      subjectId: askDirs[0]!.id,
      glyph: at(whereIs(askDirs[0]!.glyph), level),
    });
  } else if (askDirs.length > 1) {
    push("directions-menu", WHERE_MENU);
  }

  push("confused", { a: "confused", b: "confused", c: "confused" });
  push("bye", BYE);

  // Cap to the board: confused + bye always stand, and the NATURAL QUESTIONS (why /
  // where-are-you-going) survive the cut ahead of the optional acts — a traveler can
  // ALWAYS be asked where it's off to and why, however crowded the want board is
  // (they used to be pushed last and fall off exactly when a shopper was out
  // fetching — the busiest, most askable moment). One of each; order preserved.
  const standing = acts.filter((a) => a.kind === "confused" || a.kind === "bye");
  const natural: DialogueAct[] = [];
  for (const kind of ["why", "where-going"] as const) {
    const a = acts.find((x) => x.kind === kind);
    if (a) natural.push(a); // first of each — a fact-why and a motive-why answer alike
  }
  const rest = acts.filter(
    (a) => a.kind !== "confused" && a.kind !== "bye" && a.kind !== "why" && a.kind !== "where-going",
  );
  const keep = new Set<DialogueAct>([
    ...rest.slice(0, Math.max(0, maxActs - standing.length - natural.length)),
    ...natural,
    ...standing,
  ]);
  return { lineGlyph, acts: acts.filter((a) => keep.has(a)) };
}

/**
 * Render one page of an open pick-list (the directions "where is…" menu, and
 * any future list menu). Picks + a MORE button (only when there's more than one
 * page, wrapping) + a BACK button, sized to leave board room for the controls.
 */
function listActs(
  list: { menu: string; page: number },
  opts: ProjectionOpts,
  level: SyntaxLevel,
  maxActs: number,
): DialogueAct[] {
  // The menu's item provider. Only "where is…" today; keyed so more can be added.
  const items: { id: string; glyph: string }[] =
    list.menu === "where-is" ? (opts.askDirections ?? []) : [];
  // Reserve slots for more + back + confused.
  const pageSize = Math.max(1, maxActs - 3);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = ((list.page % pages) + pages) % pages;
  const slice = items.slice(page * pageSize, page * pageSize + pageSize);
  const acts: DialogueAct[] = slice.map((it) => ({
    kind: "directions-pick",
    subjectId: it.id,
    glyph: at(whereIs(it.glyph), level),
  }));
  if (pages > 1) acts.push({ kind: "more", glyph: at(MORE_PAGE, level) });
  acts.push({ kind: "back", glyph: at(LIST_BACK, level) });
  acts.push({ kind: "confused", glyph: at(CONFUSED_GLYPH, level) });
  return acts;
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

export interface ActResult {
  events: CreatureEvent[];
  responseGlyph?: string;
  /** A second line spoken right after the response (the building clue that
   *  follows "the bear has it" — "the ball is in the blue house"). */
  followUpGlyph?: string;
  /** The player asked for directions to this place-fact SUBJECT. The pure layer
   *  can't compute distance/bearing, so it hands the subject up to the host,
   *  which resolves the geometry, speaks the phrase, and swivels the camera. */
  askedDirections?: string;
  close?: boolean;
  memo: ConversationMemo;
}

/** Apply a selected act; the caller re-projects afterwards (or closes). */
export function selectAct(
  world: CreatureWorld,
  creatureId: CreatureId,
  playerId: CreatureId,
  act: DialogueAct,
  level: SyntaxLevel,
  opts: ProjectionOpts,
  memo: ConversationMemo = {},
): ActResult {
  const sym = opts.symbolOf;
  const syms = makeSyms(world, sym, world.creatures[creatureId]?.likes);
  const whoSym = (id: CreatureId): string =>
    id === creatureId ? "i_me" : id === playerId ? "you" : (opts.symbolOfCreature?.(id) ?? "there");
  const creature = world.creatures[creatureId];
  switch (act.kind) {
    case "offer": {
      if (!act.itemId) return { events: [], memo };
      // A state need is not fulfilled hand-to-hand — redirect to the box /
      // the recipient.
      const placeNeed = creature?.needs.find((n) => !n.fulfilled && n.placedAt && n.itemId === act.itemId);
      if (placeNeed) {
        return {
          events: [],
          responseGlyph: at(
            placeNeed.dispose
              ? wantThrow(syms.now(placeNeed.itemId), sym(placeNeed.placedAt!))
              : wantPlace(syms.want(placeNeed), sym(placeNeed.placedAt!)),
            level,
          ),
          memo,
        };
      }
      const behalfNeed = creature?.needs.find((n) => !n.fulfilled && n.forCreature && n.itemId === act.itemId);
      if (behalfNeed) {
        return {
          events: [],
          responseGlyph: at(wantFor(syms.want(behalfNeed), whoSym(behalfNeed.forCreature!)), level),
          memo,
        };
      }
      const res = giveItem(world, playerId, creatureId, act.itemId);
      if (!res.accepted) {
        // Name the OFFERED item by its LIVE composition ("apple.hot" after the
        // fire), never its baked spawn glyph — the reason must read true NOW.
        const offered = syms.now(act.itemId);
        const oItem = world.items[act.itemId];
        // Predicate-driven decline: judge the ACTUALLY-OFFERED item's facets
        // against each open possession need's WANT. Same SORT of thing but the
        // wrong state/descriptor → name what's missing ("apple + hot.not",
        // "ball + big.not"); else a plain "don't want it".
        if (oItem && creature) {
          for (const n of creature.needs) {
            if (n.fulfilled || n.placedAt || n.forCreature || n.deviceState || n.atPlace) continue;
            const w = wantFacets(n, world);
            if (!sameSort(w, oItem)) continue;
            if (w.state && !oItem.states.includes(w.state)) {
              return { events: [], responseGlyph: at(wrongVariant(headOf(offered), w.state), level), memo };
            }
            const missing = (w.descriptors ?? []).find((d) => !(oItem.descriptors ?? []).includes(d));
            if (missing) {
              return { events: [], responseGlyph: at(wrongVariant(headOf(offered), missing), level), memo };
            }
          }
        }
        return { events: [], responseGlyph: at(declineOffer(offered), level), memo };
      }
      const settled = settleObligations(world, creatureId);
      const cleared = memo.statedPrice?.itemId === act.itemId ? { revealed: memo.revealed } : memo;
      return { events: [...res.events, ...settled], responseGlyph: "thank_you", memo: cleared };
    }
    case "request": {
      if (!creature || (!act.itemId && !act.target)) return { events: [], memo };
      // §4b — the GENEROSITY GATE decides give / redirect / decline; the debt-only
      // `requestItem` stays the FOUNDATION (it teaches the want and covers the
      // settlement path); relational gives (affinity/surplus) grant ABOVE it via
      // the bare consent primitive. The asked-for thing is an INSTANCE, or a
      // resource TYPE (§2b "transfer(type) under WANT") resolved against the
      // owner's OWN holdings — every candidate is gated and the best verdict wins,
      // so the owner parts with a SPARE it's willing to lose, not whichever
      // instance happens to sort first.
      const typeNeed: CreatureNeed | undefined = act.target
        ? { itemId: "", value: 0, target: act.target }
        : undefined;
      const candidates = typeNeed
        ? Object.values(world.items)
            .filter((i) => i.ownerId === creatureId && itemMatchesNeed(typeNeed, i))
            .sort((a, b) => (a.id < b.id ? -1 : 1))
        : world.items[act.itemId!]?.ownerId === creatureId
          ? [world.items[act.itemId!]!]
          : [];
      const askedItem = act.itemId ? world.items[act.itemId] : undefined;
      const provider = knownProvider(
        creature,
        act.target ? [act.target.kind, act.target.category] : [askedItem?.kind, askedItem?.category],
      );
      if (candidates.length === 0) {
        // Can't give what it doesn't have (§6 — the failed precondition IS the
        // reply): a known PROVIDER turns it into directions; else the honest no.
        if (provider) return { events: [], askedDirections: provider, memo };
        const thing = act.target ? targetGlyph(act.target) : syms.now(act.itemId!);
        return { events: [], responseGlyph: at(noStock(thing), level), memo };
      }
      const gateInput = {
        relation: opts.relationOf?.(creatureId, playerId),
        personality: opts.personalityOf?.(creatureId),
        knowsSource: !!provider,
      };
      let best: { item: ItemState; verdict: GiveResponse } = {
        item: candidates[0]!,
        verdict: willingnessToGive(creature, candidates[0]!, playerId, world, gateInput),
      };
      for (const cand of candidates.slice(1)) {
        if (best.verdict.kind === "give") break;
        const verdict = willingnessToGive(creature, cand, playerId, world, gateInput);
        if (verdict.kind === "give" || (verdict.kind === "redirect" && best.verdict.kind === "decline")) {
          best = { item: cand, verdict };
        }
      }
      // The debt path (and a previously-granted pending item) accepts as before —
      // and asking TEACHES the want either way (knownWants), so obligations still
      // settle later even after a no.
      const out = requestItem(world, playerId, creatureId, best.item.id);
      if (out.kind === "accept") return { events: out.events, responseGlyph: "yes", memo };
      // Friendship beats commerce: a warm owner gifts a liked asker outright.
      if (best.verdict.kind === "give" && best.verdict.reason === "affinity") {
        return { events: grantItem(world, creatureId, playerId, best.item.id), responseGlyph: "yes", memo };
      }
      // Commerce beats charity: an owner with something to ask for TRADES (the
      // stated price / return counter) before gifting a mere spare — this keeps a
      // vendor's displayed stock a lesson, not a giveaway.
      if (out.kind === "price") {
        return { events: [], memo: { ...memo, statedPrice: out.price } };
      }
      if (best.verdict.kind === "give") {
        // surplus — nothing to ask in return, so the spare is simply given.
        return { events: grantItem(world, creatureId, playerId, best.item.id), responseGlyph: "yes", memo };
      }
      if (best.verdict.kind === "redirect" && provider) {
        return { events: [], askedDirections: provider, memo };
      }
      // A plain decline, with the honest reason: a keepsake ("my X"), its own
      // need ("I want X"), or simple unwillingness ("I won't give X") — never a
      // false "have.not" while visibly holding the thing.
      const refusal =
        best.verdict.kind === "decline" && best.verdict.reason === "bound"
          ? mineDecline(syms.now(best.item.id))
          : best.verdict.kind === "decline" && best.verdict.reason === "own-need"
            ? wantAsk(syms.now(best.item.id))
            : refuseGlyph(syms.now(best.item.id));
      return { events: [], responseGlyph: at(refusal, level), memo };
    }
    case "trade":
    case "trade-pick": {
      // Give the needed thing, receive the picked thing: the give creates the
      // debt, the recorded want (this IS the ask) pends the item. Prefer the
      // need instance the player actually HOLDS (multi-item needs share a
      // symbol); placement needs are never hand-overs.
      // State needs and unmet transformed-state requirements can't be paid
      // hand-to-hand — the give would bounce.
      const tradeNeeds = creature
        ? openNeeds(creature).filter(
            (n) =>
              !n.placedAt &&
              !n.forCreature &&
              needStateOk(n, world.items[n.itemId]?.states ?? []),
          )
        : [];
      const needItemId =
        tradeNeeds.map((n) => n.itemId).find((id) => world.items[id]?.ownerId === playerId) ??
        tradeNeeds[0]?.itemId;
      if (!act.itemId || !needItemId) return { events: [], memo: { ...memo, tradeMenu: false } };
      const give = giveItem(world, playerId, creatureId, needItemId);
      if (!give.accepted) {
        return { events: [], responseGlyph: "no", memo: { ...memo, tradeMenu: false } };
      }
      const ask = requestItem(world, playerId, creatureId, act.itemId);
      const askEvents = ask.kind === "accept" ? ask.events : [];
      const settled = settleObligations(world, creatureId);
      return {
        events: [...give.events, ...askEvents, ...settled],
        responseGlyph: "yes",
        memo: { revealed: memo.revealed },
      };
    }
    case "trade-menu":
      return { events: [], memo: { ...memo, tradeMenu: true } };
    case "back":
      // Leave whichever sub-menu is open (trade counter / directions list).
      return { events: [], memo: { ...memo, tradeMenu: false, list: undefined } };
    case "directions-menu":
      // Open the "where is…" pick list at its first page.
      return { events: [], memo: { ...memo, list: { menu: "where-is", page: 0 } } };
    case "more":
      // Advance the open list a page (projection wraps on overflow).
      return {
        events: [],
        memo: { ...memo, list: memo.list ? { ...memo.list, page: memo.list.page + 1 } : undefined },
      };
    case "ask-directions":
    case "directions-pick":
      // The pure layer can't measure distance/bearing — hand the subject to the
      // host, which resolves the town geometry, speaks the phrase, and points.
      // Close any open list; the answer is a single spoken turn.
      return act.subjectId
        ? { events: [], askedDirections: act.subjectId, memo: { ...memo, list: undefined } }
        : { events: [], memo: { ...memo, list: undefined } };
    case "agree":
      return { events: [], responseGlyph: "thank_you", close: true, memo };
    case "refuse":
      return { events: [], responseGlyph: at(REJECTED_LINE, level), close: true, memo };
    case "cant":
      // "I don't have it" — a calm parting, distinct from the refusal's sad.
      // "ok" is RESERVED for confirming an accepted order (phase ①a §1) and is
      // no longer a generic acknowledgment.
      return { events: [], responseGlyph: "goodbye", close: true, memo };
    case "how-are-you": {
      // "Are you okay?" surfaces the creature's EMOTIONAL STATE (dialogue-states +
      // phase ①a §1 — a THIN layer over the needs/mood machinery). A NEVER-announcer
      // only emotes — the want must be inferred. Otherwise the WORST PRESSING need
      // leads: a bad self-condition ("I am hungry" — quest-host mirrors the highest
      // firing motive into `condition`), else the open WANT is stated (which also
      // flips an "after"-hidden need to shown); with no problems at all, a simple
      // positive state ("I am happy") — never a generic "ok".
      const need = creature ? openNeeds(creature)[0] : undefined;
      if (need && opts.announce === "never") {
        return { events: [], responseGlyph: at(SAD_GREET, level), memo };
      }
      if (creature?.condition) {
        return { events: [], responseGlyph: at(conditionLine(creature.condition), level), memo: { ...memo, revealed: true } };
      }
      if (need) {
        return {
          events: [],
          responseGlyph: at(
            need.placedAt
              ? wantPlace(syms.want(need), sym(need.placedAt))
              : need.forCreature
                ? wantFor(syms.want(need), whoSym(need.forCreature))
                : need.atPlace
                  ? need.stay
                    ? wantStay()
                    : need.escort
                      ? wantEscort(whoSym(need.atPlace))
                      : wantGo(whoSym(need.atPlace))
                  : wantAsk(syms.wantOf(need)),
            level,
          ),
          memo: { ...memo, revealed: true },
        };
      }
      return { events: [], responseGlyph: at(CONTENT_LINE, level), memo };
    }
    case "where-is": {
      if (!creature) return { events: [], memo };
      // A TYPE question ("where is food?" — §2b query(type)) follows the fallback
      // CHAIN: a KNOWN instance matching the predicate → its location clue; else a
      // known PROVIDER (`provides` fact) → directions to the source; else the
      // honest not-knowing. `act.target` rides the act when the asker named a
      // SORT, not a thing.
      let itemId = act.itemId;
      if (!itemId && act.target) {
        // The SOURCE ask ("where do we get an apple?") answers with the
        // PROVIDER first — where one GETS the sort, not where an instance
        // happens to lie; the instance clue stays the fallback.
        if (act.source) {
          const provider = knownProvider(creature, [act.target.kind, act.target.category]);
          if (provider) return { events: [], askedDirections: provider, memo };
        }
        const typeNeed: CreatureNeed = { itemId: "", value: 0, target: act.target };
        itemId = Object.keys(creature.knowledge)
          .sort()
          .find((id) => {
            const it = world.items[id];
            return !!it && itemMatchesNeed(typeNeed, it);
          });
        if (!itemId) {
          const provider = knownProvider(creature, [act.target.kind, act.target.category]);
          return provider
            ? { events: [], askedDirections: provider, memo }
            : { events: [], responseGlyph: at(DONT_KNOW, level), memo };
        }
      }
      // Nothing resolved (the asker named something this world has no instance
      // of) — the honest don't-know, never silence.
      if (!itemId) return { events: [], responseGlyph: at(DONT_KNOW, level), memo };
      // DECOUPLED from the designated instance: a TARGET need is answered by a
      // KNOWN item that ACTUALLY MATCHES the want IN ITS CURRENT STATE — a cold
      // apple never answers "where is something hot" (the creature simply
      // doesn't know where something hot is). Exact needs + heard wants resolve
      // the specific item as before.
      const ownTargetNeed = creature.needs.find(
        (n) => !n.fulfilled && n.itemId === itemId && n.target,
      );
      if (ownTargetNeed) {
        const match = Object.keys(creature.knowledge)
          .sort()
          .find((id) => {
            const it = world.items[id];
            return !!it && itemMatchesNeed(ownTargetNeed, it);
          });
        if (!match) {
          // No known instance — but a shopper on an errand KNOWS where to GET it:
          // if the projection attached a source directions subject, answer with the
          // way to the market (host resolves geometry), symmetric with ask-directions
          // and the player's own directions answer (bug #2). A learned `provides`
          // fact answers the same way WITHOUT the host hook (NPC↔NPC). Else it
          // truly can't say.
          if (act.subjectId) return { events: [], askedDirections: act.subjectId, memo };
          const provider = knownProvider(creature, [
            ownTargetNeed.target?.kind,
            ownTargetNeed.target?.category,
          ]);
          if (provider) return { events: [], askedDirections: provider, memo };
          return { events: [], responseGlyph: at(DONT_KNOW, level), memo };
        }
        itemId = match;
      }
      const fact = creature.knowledge[itemId];
      // The BUILDING clue ("in the blue house") — the world layer resolves the
      // item's house; with real buildings the holder alone isn't findable.
      const place = opts.placeOf?.(itemId);
      if (fact?.kind === "held" && fact.by === creatureId) {
        // First person — never its own name ("I have it", not "rabbit has it").
        return { events: [], responseGlyph: at(clueSelf(syms.now(itemId)), level), memo };
      }
      if (fact?.kind === "held") {
        // whoSym: the player reads as "you", third parties keep their symbol.
        // A third party's clue gets the building follow-up ("bear has the
        // ball" … "the ball is in the blue house") — never for "you have it".
        const followUp =
          fact.by !== playerId && place
            ? { followUpGlyph: at(cluePlace(syms.now(itemId), place), level) }
            : {};
        return {
          events: [],
          responseGlyph: at(clueHolder(whoSym(fact.by), syms.now(itemId)), level),
          ...followUp,
          memo,
        };
      }
      if (fact?.kind === "loose") {
        // A loose item's clue IS the building when known — "over there" says
        // nothing once rooms are walled houses.
        return {
          events: [],
          responseGlyph: place ? at(cluePlace(syms.now(itemId), place), level) : "there",
          memo,
        };
      }
      return { events: [], responseGlyph: at(DONT_KNOW, level), memo };
    }
    case "why": {
      // Reveal the cause. Effect clause = the creature's sad state ("i_me sad").
      // A CAUSAL FACT answers with its clause; else a MOTIVE creature answers
      // with its condition ("because i_me cold"). No world effect, no close.
      const effect: PhraseSpec = { subject: "i_me", verb: "sad", key: "sad" };
      const factNeed = creature?.needs.find((n) => !n.fulfilled && n.causalFact);
      if (factNeed?.causalFact) {
        const kind = factNeed.causalFact.cause.kind;
        // Preference/desire facts answer with the WANT as the effect ("I want a
        // toy because I want to play", "…because I like red"); lack/state facts
        // keep the sad effect ("I'm sad because the generator is off").
        const eff: PhraseSpec =
          kind === "likes" || kind === "wantsTo"
            ? { subject: "i_me", verb: "want", object: syms.wantOf(factNeed) }
            : effect;
        const cause = clauseSpec(factNeed.causalFact.cause, whoSym, syms);
        return {
          events: [],
          responseGlyph: at(causalPhrase(eff, factNeed.causalFact.connective, cause), level),
          memo,
        };
      }
      if (creature?.condition) {
        // "I want hot because I am cold" — the want + its motive. The causal link
        // belongs HERE (the answer), not in the opening greeting. A stay-with
        // need's want is the company ("stay with me because I'm lonely").
        const motiveNeed = creature.needs.find(
          (n) => !n.fulfilled && !n.placedAt && !n.forCreature && !n.deviceState && !n.atPlace,
        );
        const stayNeed = creature.needs.find((n) => !n.fulfilled && n.stay);
        const clause: PhraseSpec = motiveNeed
          ? { subject: "i_me", verb: "want", object: syms.wantOf(motiveNeed) }
          : stayNeed
            ? { subject: "you", verb: "stay", tail: { join: "with", symbol: "i_me" } }
            : effect;
        const condClause: PhraseSpec = { subject: "i_me", verb: creature.condition, key: creature.condition };
        return { events: [], responseGlyph: at(causalPhrase(clause, "because", condClause), level), memo };
      }
      // PREFERENCE fallback (fruit likes): no authored fact, no condition — a
      // want voiced through a like answers itself through the likes Clause:
      // "i_me want apple because i_me like apple".
      const likedNeed = creature?.needs.find((n) => !n.fulfilled && likedWantKind(world, creature, n));
      if (creature && likedNeed) {
        const kind = likedWantKind(world, creature, likedNeed)!;
        const eff: PhraseSpec = { subject: "i_me", verb: "want", object: syms.wantOf(likedNeed) };
        const cause = clauseSpec({ kind: "likes", creature: creatureId, facet: kind }, whoSym, syms);
        return { events: [], responseGlyph: at(causalPhrase(eff, "because", cause), level), memo };
      }
      // NOTHING TO EXPLAIN — no causal fact, no condition, no liked want. Say
      // so ("I don't know"), like every other act branch: asking a creature
      // "why?" and getting SILENCE reads as the game being broken, and the
      // presenter falls back to re-speaking the idle line, which reads worse.
      // An honest floor is the rule here (see `dont-understand`), and this was
      // the one branch that broke it.
      return { events: [], responseGlyph: at(DONT_KNOW, level), memo };
    }
    case "tell": {
      // ASSERT (semantic-behavior.md §4) — the SPEAKER shares a fact with the
      // listener. The one first-class shareable fact today is an item's LOCATION
      // (creature-knowledge.md): if the speaker knows where `act.itemId` is and the
      // listener doesn't, the telling WRITES it into the listener's knowledge — the
      // same fact a sighting would (`tellAbout`), the knowledge-side mirror of a
      // sighting. A bare disclosure with no shareable item ("i_me sad") is still a
      // turn — acknowledged. No close; the conversation continues.
      // Information received is THANKED, not "ok"-ed ("ok" is reserved for
      // confirming an accepted order — phase ①a §1).
      const speaker = world.creatures[playerId];
      if (act.itemId && speaker && creature) {
        const fact = speaker.knowledge[act.itemId];
        if (fact && !creature.knowledge[act.itemId]) {
          return { events: tellAbout(world, creatureId, act.itemId, fact), responseGlyph: "thank_you", memo };
        }
      }
      return { events: [], responseGlyph: "thank_you", memo };
    }
    case "where-going": {
      // Answer from the creature's errand destination (world layer resolves it):
      // "I am going to get {good}" / "I am going home" / "I am going to {place}".
      // Not en route ⇒ "I'm here". No world effect, no close.
      const dest = creature ? opts.goingOf?.(creatureId) : undefined;
      return { events: [], responseGlyph: at(dest ? goingLine(dest) : HERE_STAY, level), memo };
    }
    case "what-doing": {
      // "What is {X} doing / eating?" (semantic-tests §Questions) — answered
      // from the LIVE world, premise-checked, never fabricated: no such
      // creature → say so; the wrong presumed activity → correct it ("the dog
      // is not eating"); can't tell → the honest don't-know.
      if (!act.about) return { events: [], responseGlyph: at(NOT_UNDERSTOOD, level), memo };
      if (act.about.id === undefined) {
        // Not a creature. A real THING isn't doing anything ("the ball
        // doesn't eat"); a symbol naming nothing → "there is no {X}".
        const symbol = act.about.symbol;
        const isItem = Object.values(world.items).some(
          (it) => headOf(it.kind ?? sym(it.id)) === symbol,
        );
        return {
          events: [],
          responseGlyph: at(isItem ? notDoing(symbol, act.verb ?? "do") : noSuch(symbol), level),
          memo,
        };
      }
      const who = whoSym(act.about.id);
      const activity: { verb: string; object?: string } | null | undefined = opts.activityOf
        ? opts.activityOf(act.about.id)
        : (() => {
            const verbs = opts.doingOf?.(act.about!.id!);
            if (verbs === undefined) return undefined; // can't tell
            return verbs.length ? { verb: verbs[0]! } : null; // [] = verifiably idle
          })();
      if (activity === undefined) return { events: [], responseGlyph: at(DONT_KNOW, level), memo };
      // Synonym-family match (parse-intent VERB_FAMILY): "what dog take?" is
      // confirmed by a creature whose live verb reads "get" — same primitive,
      // different word. The correction still speaks the ASKED word back.
      if (act.verb && (activity === null || canonicalVerb(activity.verb) !== canonicalVerb(act.verb))) {
        return { events: [], responseGlyph: at(notDoing(who, act.verb), level), memo };
      }
      if (activity === null) {
        // Broad "what are you doing?" while idle — "I'm not doing (anything)".
        return { events: [], responseGlyph: at(notDoing(who, "do"), level), memo };
      }
      return {
        events: [],
        responseGlyph: at(
          phrase({ subject: who, verb: activity.verb, ...(activity.object ? { object: activity.object } : {}) }),
          level,
        ),
        memo,
      };
    }
    case "ask-fact": {
      // A generic KNOWLEDGE query (facts.ts): answer what the creature knows,
      // or the honest don't-know. Never fabricated (creature-knowledge.md).
      if (!act.query) return { events: [], memo };
      const q = act.query;
      if (q.kind === "presence") {
        // Asked where IT is ("where is Mara?" to Mara) — "I'm here."
        if (q.creature === creatureId) {
          return { events: [], responseGlyph: at(HERE_STAY, level), memo };
        }
        // The household ROSTER is common knowledge (household-duties §1): a
        // housemate knows the schedule ("Mara is at work") ahead of any stale
        // sighting; perception/telling still answers for everyone else.
        const oracle = opts.presenceOf?.(q.creature);
        if (oracle) {
          const known: Fact = { kind: "presence", creature: q.creature, place: oracle };
          const learned = playerId !== creatureId ? tellFact(world, playerId, known) : [];
          return { events: learned, responseGlyph: at(factLine(known, whoSym, syms), level), memo };
        }
      }
      const known = knowsFact(world, creatureId, q);
      if (!known) return { events: [], responseGlyph: at(DONT_KNOW, level), memo };
      // POLAR ask ("apple hot?" / "Mara hungry?"): yes/no against the claim.
      if (act.expect !== undefined) {
        const actual =
          known.kind === "itemState"
            ? known.state
            : known.kind === "condition"
              ? (known.condition ?? "ok")
              : undefined;
        if (actual !== undefined) {
          return { events: [], responseGlyph: actual === act.expect ? "yes" : "no", memo };
        }
      }
      // Hearing the answer IS knowledge — the fact spreads to the asker
      // (the askWhere law: asking teaches).
      const learned = playerId !== creatureId ? tellFact(world, playerId, known) : [];
      return { events: learned, responseGlyph: at(factLine(known, whoSym, syms), level), memo };
    }
    case "tell-fact": {
      // ASSERT a generic fact — telling writes what a sighting would. A claim
      // about the LISTENER ITSELF is checked against its own truth: confirmed
      // ("yes") or gently corrected ("i_me + hungry.not"), never absorbed wrong.
      if (!act.fact) return { events: [], memo };
      if (act.fact.kind === "condition" && act.fact.creature === creatureId && act.fact.condition) {
        const claimed = act.fact.condition;
        return creature?.condition === claimed
          ? { events: [], responseGlyph: "yes", memo }
          : {
              events: [],
              responseGlyph: at(
                phrase({ subject: "i_me", verb: `${claimed}.not`, key: `${claimed}.not` }),
                level,
              ),
              memo,
            };
      }
      const events = tellFact(world, creatureId, act.fact);
      // Information received is THANKED (the tell convention, phase ①a §1).
      return { events, responseGlyph: "thank_you", memo };
    }
    case "dont-understand":
      // The utterance had no honest interpretation — say so (never silence,
      // never a misleading small-talk answer). No world effect, no close.
      return { events: [], responseGlyph: at(NOT_UNDERSTOOD, level), memo };
    case "deny-doing":
      // "Why are you building?" while verifiably NOT building — correct the
      // premise ("i_me + build.not"), the same gentle-correction convention
      // the tell-fact self-claim uses.
      return act.verb
        ? {
            events: [],
            responseGlyph: at(phrase({ subject: "i_me", verb: `${act.verb}.not`, key: `${act.verb}.not` }), level),
            memo,
          }
        : { events: [], responseGlyph: at(NOT_UNDERSTOOD, level), memo };
    case "confused":
      return { events: [], memo }; // caller re-projects one level down
    case "bye":
      // The parting is returned in kind ("bye-bye") — never a generic "ok".
      return { events: [], responseGlyph: "goodbye", close: true, memo };
  }
}
