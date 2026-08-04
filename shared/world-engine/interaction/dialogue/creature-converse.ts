// shared/world-engine/interaction/dialogue/creature-converse.ts
//
// SYMMETRIC conversation over the existing dialogue engine. The response side —
// `selectAct(world, listener, speaker, act, …)` — already ignores WHO the speaker
// is (it maps them to "you" via whoSym), so an NPC can be a speaker exactly like the
// player. What was missing is the SPEAKER side: the player picks an act from the
// board; an NPC needs a policy, and a spoken SENTENCE needs mapping to an act. This
// module supplies both, so NPC↔NPC and player↔NPC run the SAME path
// (projectDialogue → an act → selectAct → a reply).
//
//   • intentToAct   — a parsed player SENTENCE (parse-intent.ts) → a DialogueAct.
//   • pickSpeakerAct — an NPC's chosen move toward a listener (from its motives).
//   • converse       — one exchange: the speaker's act + the listener's reply.
//
// Pure + deterministic (no RNG, no world coordinates), so it's headless-testable.

import type { CreatureId, CreatureNeed, CreatureState, CreatureWorld, ItemId, NeedTarget } from "@shared/world-engine/interaction/behavior/creatures.js";
import { itemMatchesNeed, openNeeds, providesKey, tellAbout } from "@shared/world-engine/interaction/behavior/creatures.js";
import {
  projectDialogue,
  selectAct,
  type ActResult,
  type ConversationMemo,
  type DialogueAct,
  type ProjectionOpts,
} from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";
import { NEUTRAL_PERSONALITY, type Personality } from "@shared/world-engine/interaction/behavior/personality.js";
import { DEFAULT_RELATION, type Relation } from "@shared/world-engine/interaction/behavior/relations.js";
import type { SyntaxLevel } from "@shared/world-engine/interaction/dialogue/dialogue-gen.js";
import { canonicalVerb, type IntentFrame, type Ref } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { STATE_AXES } from "@shared/world-engine/interaction/behavior/facts.js";
import { headOf } from "../../variations.js";

/** Movement verbs that turn a "where" question into a DESTINATION query ("where are
 *  you going?") rather than an item where-is (parse-intent's MOVEMENT_GOAL_VERBS). */
const GOING_VERBS = new Set(["go", "come", "run", "walk", "chase"]);
/** Verbs of POSSESSION. Negated, they answer "I don't have one" (`cant`)
 *  rather than "I won't" (`refuse`) — a different thing to be told. */
const HAVE_VERBS = new Set(["have", "hold", "carry"]);

/** Verbs a "what + {creature} + {verb}" question must NOT read as an activity
 *  ask: they query possession/desire ("what do you want/have?"), not doing. */
const ACTIVITY_EXCLUDED_VERBS = new Set(["want", "need", "have", "like", "feel"]);

/**
 * Map a parsed SENTENCE (from `speakerId`, aimed at `listenerId`) to a DialogueAct, or
 * null if it's an IMPERATIVE (command/rule/sequence — handled by the goal/party layer).
 * The MODALITY of the frame chooses the act (semantic-behavior.md §4): a WANT → request,
 * an OFFER → offer, an ASSERT (`state`) → tell (share a fact), a QUERY (`ask`) → where-is
 * / why / small-talk, the social acts → their moves. Every CONVERSATIONAL frame yields
 * SOME act (an unmapped mention becomes a bare `tell`; an unclear one `confused`) — so a
 * hand-authored sentence always gets a reply. Speaker-agnostic: pass an NPC as `speakerId`
 * and it maps an NPC's utterance the same way, so NPC↔NPC and player↔NPC share this path.
 *
 * Item references resolve by KIND: a WANT/QUERY resolves against what the LISTENER holds
 * ("i_me want cookie" asks the creature for ITS cookie); an OFFER/ASSERT resolves against
 * the SPEAKER's own holdings/knowledge; either falls back to any world instance of the
 * kind so a location can still be named.
 */
export function intentToAct(
  frame: IntentFrame,
  world: CreatureWorld,
  speakerId: CreatureId,
  listenerId: CreatureId,
  opts: Pick<ProjectionOpts, "symbolOf" | "creatureOf" | "doingOf" | "jointActivities">,
): DialogueAct | null {
  const glyph = frame.raw.join(" + ");
  const objectSymbol = frame.object?.kind === "entity" ? frame.object.symbol : undefined;
  /** The bare symbol of a noun ref (entity or unresolved). */
  const refSymbol = (r: Ref | undefined): string | undefined =>
    r && (r.kind === "entity" || r.kind === "unresolved") ? r.symbol : undefined;
  /** Resolve a ref to a creature: deixis first, then the world's name book. */
  const refCreature = (r: Ref | undefined): CreatureId | undefined => {
    if (!r) return undefined;
    if (r.kind === "listener") return listenerId;
    if (r.kind === "player") return speakerId;
    const sym = refSymbol(r);
    return sym ? opts.creatureOf?.(sym) : undefined;
  };
  /** The creature a fact question/statement is ABOUT (object, else subject). */
  const aboutCreature = (): CreatureId | undefined =>
    refCreature(frame.object) ?? refCreature(frame.subject);
  /** WHO an activity question is about: the spoken symbol + the resolved
   *  creature. The symbol is kept even when nothing answers to it, so the
   *  evaluator can say "there is no {X}" instead of a blank don't-know. */
  const aboutRef = (): { symbol: string; id?: CreatureId } | undefined => {
    for (const r of [frame.subject, frame.object]) {
      if (!r) continue;
      if (r.kind === "listener") return { symbol: "you", id: listenerId };
      if (r.kind === "player") return { symbol: "i_me", id: speakerId };
      const sym = refSymbol(r);
      if (sym) {
        const cid = opts.creatureOf?.(sym);
        return { symbol: sym, ...(cid ? { id: cid } : {}) };
      }
    }
    return undefined;
  };
  const aboutSymbol = (): string | undefined => refSymbol(frame.object) ?? refSymbol(frame.subject);
  const symbolMatches = (it: { id: ItemId; kind?: string }, symbol: string): boolean =>
    headOf(it.kind ?? opts.symbolOf(it.id)) === symbol;
  const heldBy = (owner: CreatureId, symbol: string): ItemId | undefined =>
    Object.values(world.items).find((it) => it.ownerId === owner && symbolMatches(it, symbol))?.id;
  const anyOf = (symbol: string): ItemId | undefined =>
    Object.values(world.items).find((it) => symbolMatches(it, symbol))?.id;
  const listenerItem = objectSymbol ? heldBy(listenerId, objectSymbol) : undefined;
  const speakerItem = objectSymbol ? heldBy(speakerId, objectSymbol) : undefined;
  const anyItem = objectSymbol ? anyOf(objectSymbol) : undefined;
  // A TYPE word (semantic-behavior.md §2b) names a SORT, not a thing — a CATEGORY
  // some world item carries ("food"), else a KIND ("apple" — { kind } names a sort
  // too), else a sort the LISTENER knows a provider of. Carried as a NeedTarget so
  // the evaluator resolves it (owner's spare / provider / the honest no).
  const typeTarget = (): NeedTarget | undefined => {
    if (!objectSymbol) return undefined;
    const items = Object.values(world.items);
    if (items.some((it) => it.category === objectSymbol)) return { category: objectSymbol };
    if (items.some((it) => it.kind === objectSymbol)) return { kind: objectSymbol };
    return world.creatures[listenerId]?.knowledge[providesKey(objectSymbol)]
      ? { category: objectSymbol }
      : undefined;
  };

  // AN INVITATION, whatever sentence shape it arrives in. "I want to play with
  // you", "I will eat with you" and "let's eat together" are ONE move — a JOINT
  // activity aimed at the listener — and they must not be three readings just
  // because the parser classifies the first a request and the second a
  // statement. Sentence shape is how a child says it; the move is what it means.
  //
  // Gated on the verbs THIS WORLD ACTUALLY GATHERS FOR (the culture's ritual
  // rows, via `jointActivities`), never a list written here: a world with no
  // meal ritual leaves "eat with me" reading exactly as it does today rather
  // than answering an invitation it cannot honor. A `with` naming a THIRD party
  // ("I want to play with Mara", said to Bob) stays a disclosure — it tells Bob
  // something, it does not ask him.
  const invitationVerb = (): string | undefined => {
    if (!frame.joint || !frame.verb) return undefined;
    const verb = canonicalVerb(frame.verb);
    if (!(opts.jointActivities ?? []).includes(verb)) return undefined;
    const marked = (frame.bound ?? []).filter((b) => b.relation === "with");
    const aimedHere = marked.length === 0 || marked.some((b) => refCreature(b.ref) === listenerId);
    return aimedHere ? verb : undefined;
  };
  if (frame.kind === "request" || frame.kind === "state") {
    const verb = invitationVerb();
    if (verb) return { kind: "invite", verb, glyph };
  }

  // NEGATION IS HALF THE SENTENCE. The parser reads `.not` and sets
  // `frame.negated`; a mapper that ignores it turns a refusal into its own
  // opposite — "i_me + give.not + apple" parses as an offer frame, and handing
  // the apple over is the one answer the speaker did not give. Every negated
  // shape lands on the words for declining, before any evaluator sees it.
  if (frame.negated) {
    // "I don't have one" is a distinct answer from "I won't": what is being
    // denied is possession, not willingness.
    if (frame.verb && HAVE_VERBS.has(canonicalVerb(frame.verb))) {
      return { kind: "cant", itemId: speakerItem, glyph };
    }
    return { kind: "refuse", glyph };
  }

  switch (frame.kind) {
    case "request": {
      // A MODAL desire with no thing to hand over ("i_me + want + play" — a
      // wish to DO something): a disclosure, acknowledged — the bare request
      // evaluator would answer it with silence.
      if (frame.modal && frame.verb && !objectSymbol) return { kind: "tell", glyph };
      // An instance the listener holds, else the word as a resource TYPE ("i_me
      // want food") — the request evaluator picks the owner's spare (§2b).
      const target = listenerItem ? undefined : typeTarget();
      return { kind: "request", itemId: listenerItem, ...(target ? { target } : {}), glyph };
    }
    case "offer":
      // The speaker HANDS OVER its own item (selectAct.offer gives speaker→listener).
      return { kind: "offer", itemId: speakerItem, glyph };
    case "state": {
      // A SWAP: "apple + for + bread". The `for` relation is the trade word —
      // the parser binds both sides (object = what I give, target = what I want
      // back), and reading only the first half made an exchange land as a
      // disclosure about an apple. Both items must be real, or there is no
      // trade to propose.
      if (!frame.verb && frame.relation === "for" && frame.target) {
        const give = speakerItem ?? (objectSymbol ? heldBy(speakerId, objectSymbol) : undefined);
        const wantSym = refSymbol(frame.target);
        const get = wantSym ? heldBy(listenerId, wantSym) : undefined;
        if (give && get) return { kind: "trade", itemId: get, glyph };
      }
      // ATTRIBUTE assertions share a generic fact (facts.ts): "mara + hungry" →
      // a condition, "apple + hot" → an item state. The speaker asserts; the
      // listener records (or, told about ITSELF, confirms/corrects). The
      // creature must be EXPLICIT — classifyPredicate DEFAULTS a subjectless
      // statement's subject to the speaker, and "apple + hot" must not read
      // as a claim about me.
      const explicitCreature = (): CreatureId | undefined => {
        const viaObject = refCreature(frame.object);
        if (viaObject) return viaObject;
        const s = frame.subject;
        if (!s) return undefined;
        if (s.kind === "player") return frame.raw.includes("i_me") ? speakerId : undefined;
        return refCreature(s);
      };
      const attr = frame.modifiers[0];
      if (attr && !frame.verb) {
        const cid = explicitCreature();
        if (cid) {
          return { kind: "tell-fact", fact: { kind: "condition", creature: cid, condition: attr }, glyph };
        }
        const sym = aboutSymbol();
        const itemId = sym ? (heldBy(speakerId, sym) ?? anyOf(sym)) : undefined;
        const axis = STATE_AXES[attr];
        if (itemId && axis) {
          return { kind: "tell-fact", fact: { kind: "itemState", item: itemId, axis, state: attr }, glyph };
        }
      }
      // PRESENCE assertion: "mara + in + kitchen" — a creature at a place.
      if (!frame.verb && frame.relation === "in" && frame.target) {
        const cid = explicitCreature();
        const place = refSymbol(frame.target);
        if (cid && place) {
          return { kind: "tell-fact", fact: { kind: "presence", creature: cid, place }, glyph };
        }
      }
      // A declarative SHARES a fact: naming an item asserts what the speaker knows of
      // it (its location); a feeling/mention with no item is a bare disclosure — still
      // a turn, acknowledged. Resolve to the speaker's own instance, else any in world.
      return { kind: "tell", itemId: speakerItem ?? anyItem, glyph };
    }
    case "ask": {
      // "where + go" (a movement verb + the where question) asks a MOVING creature
      // its DESTINATION, not an item's location — "where are you going?" (bug #4).
      if (frame.question === "where" && frame.verb && GOING_VERBS.has(frame.verb)) {
        return { kind: "where-going", glyph };
      }
      if (frame.question === "where") {
        // "where + mara" — a CREATURE's whereabouts is a presence fact, not an
        // item location ("where + you" answers "I'm here").
        const cid = aboutCreature();
        if (cid && cid !== speakerId) {
          return { kind: "ask-fact", query: { kind: "presence", creature: cid }, glyph };
        }
        // A bare "where" with nothing named has no honest read.
        if (!objectSymbol && !refSymbol(frame.subject)) return { kind: "dont-understand", glyph };
        // "where + get + {X}" — the SOURCE ask (semantic-tests §Questions:
        // "where do we get an apple?"): prefer where one GETS the sort (the
        // provider chain) over where an instance happens to lie.
        if (frame.verb === "get" && objectSymbol) {
          const target = typeTarget() ?? { kind: objectSymbol };
          return { kind: "where-is", target, source: true, glyph };
        }
        // No instance of the kind anywhere → maybe a TYPE question ("where is
        // food?") — the §2b chain (instance → provider → don't-know) answers it.
        const itemId = listenerItem ?? anyItem;
        const target = itemId ? undefined : typeTarget();
        return { kind: "where-is", itemId, ...(target ? { target } : {}), glyph };
      }
      if (frame.question === "what") {
        // "what + want + mara" — a third party's want is a fact query; asking
        // the LISTENER what it wants stays small talk (it reveals its own need).
        if (frame.verb === "want") {
          const cid = aboutCreature();
          if (cid && cid !== listenerId && cid !== speakerId) {
            return { kind: "ask-fact", query: { kind: "want", creature: cid }, glyph };
          }
          return { kind: "how-are-you", glyph };
        }
        // "what + {creature} + {verb}" / "what + you + do" — the ACTIVITY
        // question (semantic-tests §Questions: "what is the dog eating?").
        // Premise checks (no such creature / not doing it) live in the
        // evaluator; a subjectless "what + eat" implies the LISTENER. State
        // verbs stay out — they query possession/desire, not an activity.
        if (frame.verb && !ACTIVITY_EXCLUDED_VERBS.has(frame.verb)) {
          const about = aboutRef() ?? { symbol: "you", id: listenerId };
          return {
            kind: "what-doing",
            about,
            ...(frame.verb !== "do" ? { verb: frame.verb } : {}),
            glyph,
          };
        }
        // "what + hot" — search the listener's knowledge for a thing in that
        // state ("apple + hot"); any other "what" shape has no honest read.
        const attr = frame.modifiers[0];
        if (!frame.verb && attr && STATE_AXES[attr]) {
          return { kind: "ask-fact", query: { kind: "stateSearch", state: attr }, glyph };
        }
        return { kind: "dont-understand", glyph };
      }
      if (frame.question === "who") {
        // "who + have + ball" — the holder clue (the where-is answer NAMES the
        // holder: "bear + have + ball").
        if (frame.verb === "have" && objectSymbol) {
          const itemId = listenerItem ?? anyItem;
          const target = itemId ? undefined : typeTarget();
          if (itemId || target) return { kind: "where-is", itemId, ...(target ? { target } : {}), glyph };
          return { kind: "dont-understand", glyph };
        }
        // "who + hungry" — search knowledge for a creature in that condition.
        const attr = frame.modifiers[0];
        if (!frame.verb && attr) {
          return { kind: "ask-fact", query: { kind: "conditionSearch", condition: attr }, glyph };
        }
        return { kind: "dont-understand", glyph };
      }
      // "how + mara" — a third party's condition; "how + you" stays the
      // small-talk greeting (it reveals hidden needs, richer than a fact read).
      if (frame.question === "how") {
        const cid = aboutCreature();
        if (cid && cid !== listenerId && cid !== speakerId) {
          return { kind: "ask-fact", query: { kind: "condition", creature: cid }, glyph };
        }
        return { kind: "how-are-you", glyph };
      }
      if (frame.question === "why") {
        // "why + you + build" PRESUMES the listener is building — check the
        // premise before dumping a motive ("I want an apple" answers nothing).
        // Verifiably doing it → the motive; verifiably NOT → the correction
        // ("i_me + build.not"); can't tell → the honest can't-interpret line.
        // Movement verbs skip the check: walking is need-driven, the motive IS
        // the answer ("why + you + go" → "because I want food").
        const v = frame.verb;
        if (v && !GOING_VERBS.has(v)) {
          const doing = opts.doingOf?.(listenerId);
          if (!doing) return { kind: "dont-understand", glyph };
          if (!doing.includes(v)) return { kind: "deny-doing", verb: v, glyph };
        }
        return { kind: "why", itemId: listenerItem, glyph };
      }
      // POLAR attribute claim ("apple + hot#question", "mara + hungry#question"):
      // a yes/no fact query. "you + ok#question" stays the how-are-you greeting.
      if (frame.polar && frame.modifiers.length) {
        const attr = frame.modifiers[0]!;
        const cid = aboutCreature();
        if (cid === listenerId && attr === "ok") return { kind: "how-are-you", glyph };
        if (cid) {
          return { kind: "ask-fact", query: { kind: "condition", creature: cid }, expect: attr, glyph };
        }
        const sym = aboutSymbol();
        const itemId = sym ? (heldBy(listenerId, sym) ?? anyOf(sym)) : undefined;
        const axis = STATE_AXES[attr];
        if (itemId && axis) {
          return { kind: "ask-fact", query: { kind: "itemState", item: itemId, axis }, expect: attr, glyph };
        }
        return { kind: "dont-understand", glyph };
      }
      // A greeting-shaped polar at the LISTENER ("you#question") stays small
      // talk; any other unrecognized question shape gets the honest floor —
      // never a non-sequitur "I'm fine".
      if (frame.polar && !frame.object && !frame.modifiers.length) return { kind: "how-are-you", glyph };
      return { kind: "dont-understand", glyph };
    }
    case "greet":
      return { kind: "how-are-you", glyph };
    case "affirm":
      return { kind: "agree", glyph };
    case "decline":
      return { kind: "refuse", glyph };
    case "farewell":
      return { kind: "bye", glyph };
    case "unclear":
      return { kind: "confused", glyph };
    default:
      // command / rule / sequence — an imperative, handled by the goal/party layer.
      return null;
  }
}

/**
 * What a SPEAKER creature chooses to say to a LISTENER, from the acts the dialogue
 * engine makes available toward that listener (projectDialogue is listener-centric,
 * so its acts ARE the speaker's options). Policy by the speaker's own motives:
 *   1. REQUEST an item it NEEDS that the listener holds,
 *   2. OFFER something the listener wants (projection only offers matching items),
 *   3. otherwise small talk (how-are-you), else farewell.
 * Null if the speaker doesn't exist / has nothing to say.
 */
export function pickSpeakerAct(
  world: CreatureWorld,
  speakerId: CreatureId,
  listenerId: CreatureId,
  level: SyntaxLevel,
  opts: ProjectionOpts,
  memo: ConversationMemo = {},
): DialogueAct | null {
  const speaker = world.creatures[speakerId];
  if (!speaker) return null;
  const { acts } = projectDialogue(world, listenerId, speakerId, level, opts, memo);
  const needs = openNeeds(speaker);

  const request = acts.find(
    (a) => a.kind === "request" && a.itemId && needs.some((n) => itemMatchesNeed(n, world.items[a.itemId!]!)),
  );
  if (request) return request;

  const offer = acts.find((a) => a.kind === "offer" && a.itemId);
  if (offer) return offer;

  return acts.find((a) => a.kind === "how-are-you") ?? acts.find((a) => a.kind === "bye") ?? null;
}

/** How an NPC SPEAKER picks its move: its personality + how it regards the listener,
 *  plus a deterministic RNG so ties (and the no-motive case) break reproducibly. */
export interface SpeakerMood {
  /** The speaker's intrinsic dials (warmth/assertiveness/openness/expressiveness…). */
  personality?: Personality;
  /** The speaker's directed attitude toward the LISTENER (affinity gates generosity). */
  relation?: Relation;
  /** RNG in [0,1); defaults to Math.random. Inject a seeded one for tests. */
  rng?: () => number;
}

const EPS_WEIGHT = 0.05; // every act keeps a floor weight → "when all else fails, random"

/** OPENER + navigation acts — never a spoken NPC turn. An NPC must not utter the bare
 *  menu-opener ("where", "trade") or a list control; instead each opener is EXPANDED
 *  into its concrete picks (see chooseSpeakerAct), so the NPC can still ask a specific
 *  "where is {place}" / "trade for {item}" — just not the button that opens the list. */
const NON_SPEAKER_ACTS = new Set<DialogueAct["kind"]>([
  "trade-menu",
  "directions-menu",
  "back",
  "more",
  "confused",
]);

/**
 * How strongly a SPEAKER with this mood is inclined to OPEN with `act`. The dialogue
 * board is shared (the same acts the player would see); an NPC differs only in that it
 * SELECTS by its own nature (semantic-behavior.md §8). Weights are motive × personality:
 *   • request/trade — wanting an item the listener holds, sharpened by ASSERTIVENESS;
 *   • offer          — GENEROSITY: warmth × how much it likes the listener (affinity);
 *   • how-are-you    — sociability: warmth × expressiveness;
 *   • where-is/ask   — curiosity: openness;
 *   • bye            — the natural closer (a modest floor so idle speakers drift off).
 * Everything else is a RESPONSE or navigation, not an opener — the epsilon floor only,
 * so it can still be picked at random but rarely leads.
 */
function speakerActWeight(
  act: DialogueAct,
  world: CreatureWorld,
  speaker: CreatureState,
  personality: Personality,
  relation: Relation,
): number {
  const affinityGate = (relation.affinity + 1) / 2; // 0..1
  switch (act.kind) {
    case "request":
    case "trade":
    case "trade-pick":
    case "trade-menu": {
      if (!act.itemId) return EPS_WEIGHT;
      const it = world.items[act.itemId];
      const need = it ? openNeeds(speaker).find((n) => itemMatchesNeed(n, it)) : undefined;
      if (!need) return EPS_WEIGHT; // it doesn't want the thing → it won't ask
      return need.value * (0.6 + 0.8 * personality.assertiveness);
    }
    case "offer":
      return EPS_WEIGHT + 2 * personality.warmth * affinityGate;
    // ASKING SOMEONE ALONG — the same sociability that drives small talk, but
    // it only surfaces when the world says the gathering is joinable at all
    // (projectDialogue gates the act on `canJoin`), so a warm creature with a
    // meal about to happen CALLS PEOPLE TO IT. Weighted above small talk:
    // between "how are you" and "come and eat", the second is the better thing
    // to say when there is actually food.
    case "invite":
      return EPS_WEIGHT + 1.6 * personality.warmth * affinityGate;
    case "how-are-you":
      return EPS_WEIGHT + 1.2 * personality.warmth * personality.expressiveness;
    case "where-is":
    case "ask-directions":
    case "directions-pick":
    case "directions-menu":
    // Asking a passerby where it's headed is the same curiosity as asking
    // where things are — it was falling to the epsilon floor and was
    // effectively never spoken NPC↔NPC.
    case "where-going":
      return EPS_WEIGHT + 0.8 * personality.openness;
    case "bye":
      return 0.3;
    default:
      return EPS_WEIGHT;
  }
}

/**
 * Pick the SPEAKER's move from the SAME board the player would be shown, weighted by the
 * speaker's personality + relation, with a random tail so no combination is a dead end
 * (the user's design: "an NPC makes the selection using their own personality or, when
 * all else fails, random selection"). Unlike `pickSpeakerAct`'s fixed priority list, this
 * lets a warm creature drift to small talk, a needy assertive one to a request, an
 * incurious one to almost anything — emergent from the dials, no per-character code.
 */
export function chooseSpeakerAct(
  world: CreatureWorld,
  speakerId: CreatureId,
  listenerId: CreatureId,
  level: SyntaxLevel,
  opts: ProjectionOpts,
  mood: SpeakerMood = {},
  memo: ConversationMemo = {},
): DialogueAct | null {
  const speaker = world.creatures[speakerId];
  if (!speaker) return null;
  const project = (m: ConversationMemo) => projectDialogue(world, listenerId, speakerId, level, opts, m).acts;
  // An NPC may ask a CONCRETE sub-item ("where is {place}", "trade for {item}") but
  // never the bare menu-OPENER: expand each opener into its picks (re-project with the
  // submenu open), then drop the openers + list controls themselves.
  const acts: DialogueAct[] = [];
  for (const a of project(memo)) {
    if (a.kind === "directions-menu") {
      acts.push(...project({ ...memo, list: { menu: "where-is", page: 0 } }).filter((x) => x.kind === "directions-pick"));
    } else if (a.kind === "trade-menu") {
      acts.push(...project({ ...memo, tradeMenu: true }).filter((x) => x.kind === "trade-pick"));
    } else if (!NON_SPEAKER_ACTS.has(a.kind)) {
      acts.push(a);
    }
  }
  if (acts.length === 0) return null;
  const personality = mood.personality ?? NEUTRAL_PERSONALITY;
  const relation = mood.relation ?? DEFAULT_RELATION;
  const rng = mood.rng ?? Math.random;
  const weights = acts.map((a) => Math.max(0, speakerActWeight(a, world, speaker, personality, relation)));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return acts[Math.floor(rng() * acts.length)] ?? acts[0]!;
  let r = rng() * total;
  for (let i = 0; i < acts.length; i++) {
    r -= weights[i]!;
    if (r < 0) return acts[i]!;
  }
  return acts[acts.length - 1]!;
}

export interface ConverseTurn {
  /** The speaker's utterance (glyph). */
  speakerAct: DialogueAct;
  /** The listener's reaction (selectAct result: reply glyph + state events). */
  result: ActResult;
}

/**
 * One symmetric exchange: `speakerId` says a move to `listenerId`, who reacts. For the
 * reply turn, call again with speaker/listener swapped — the same function drives both
 * sides, so a full NPC↔NPC (or player↔NPC) conversation is just alternating `converse`
 * calls. Pass a `mood` to have the speaker CHOOSE by its personality (chooseSpeakerAct);
 * omit it for the fixed need-first policy (pickSpeakerAct). Null if the speaker has
 * nothing to say.
 */
export function converse(
  world: CreatureWorld,
  speakerId: CreatureId,
  listenerId: CreatureId,
  level: SyntaxLevel,
  opts: ProjectionOpts,
  memo: ConversationMemo = {},
  mood?: SpeakerMood,
): ConverseTurn | null {
  const act = mood
    ? chooseSpeakerAct(world, speakerId, listenerId, level, opts, mood, memo)
    : pickSpeakerAct(world, speakerId, listenerId, level, opts, memo);
  if (!act) return null;
  const result = selectAct(world, listenerId, speakerId, act, level, opts, memo);
  return { speakerAct: act, result };
}

export interface KnowledgeAnswer extends ActResult {
  /** The asker LEARNED the fact — it entered their knowledge this turn. */
  learned: boolean;
}

/**
 * Ask `answererId` WHERE `itemId` is. The answerer replies from its own knowledge
 * (the shipped where-is act), AND — the "new information enters knowledge" step — if
 * it knows, the ASKER LEARNS the fact: `tellAbout` writes the same fact a sighting
 * would. This is how knowledge SPREADS by conversation, not only by sight, and it's
 * symmetric — any creature (or the player) can ask any other. The clue GLYPH is the
 * answerer's spoken reply; `learned` says whether the asker gained a new fact.
 */
export function askWhere(
  world: CreatureWorld,
  askerId: CreatureId,
  answererId: CreatureId,
  itemId: ItemId,
  level: SyntaxLevel,
  opts: ProjectionOpts,
  memo: ConversationMemo = {},
): KnowledgeAnswer {
  const act: DialogueAct = { kind: "where-is", itemId, glyph: `where + ${headOf(opts.symbolOf(itemId))}` };
  const result = selectAct(world, answererId, askerId, act, level, opts, memo);
  const fact = world.creatures[answererId]?.knowledge[itemId];
  const asker = world.creatures[askerId];
  let learned = false;
  if (fact && asker && !asker.knowledge[itemId]) {
    tellAbout(world, askerId, itemId, fact); // monotone: the asker now knows it too
    learned = true;
  }
  return { ...result, learned };
}

/**
 * Ask `answererId` WHERE a resource TYPE is ("where is food?") — the §2b query(type)
 * chain: a known matching INSTANCE → its location clue; else a known PROVIDER
 * (`provides` fact) → directions to the source; else an honest not-knowing. The
 * type-ask twin of `askWhere`, and the same knowledge-spread rule: whichever fact
 * answered (the instance's location OR the provision fact) enters the ASKER's
 * knowledge — gossip spreads sources exactly like sightings.
 */
export function askWhereType(
  world: CreatureWorld,
  askerId: CreatureId,
  answererId: CreatureId,
  target: NeedTarget,
  level: SyntaxLevel,
  opts: ProjectionOpts,
  memo: ConversationMemo = {},
): KnowledgeAnswer {
  const typeWord = target.category ?? target.kind ?? "thing";
  const act: DialogueAct = { kind: "where-is", target, glyph: `where + ${typeWord}` };
  const result = selectAct(world, answererId, askerId, act, level, opts, memo);
  const answerer = world.creatures[answererId];
  const asker = world.creatures[askerId];
  let learned = false;
  if (answerer && asker) {
    // Re-derive which fact answered (the same chain selectAct walked) and spread it.
    const typeNeed: CreatureNeed = { itemId: "", value: 0, target };
    const instId = Object.keys(answerer.knowledge)
      .sort()
      .find((id) => {
        const it = world.items[id];
        return !!it && itemMatchesNeed(typeNeed, it);
      });
    const key =
      instId ??
      [target.kind, target.category]
        .filter((t): t is string => !!t)
        .map(providesKey)
        .find((k) => answerer.knowledge[k]);
    if (key && !asker.knowledge[key]) {
      tellAbout(world, askerId, key, answerer.knowledge[key]!);
      learned = true;
    }
  }
  return { ...result, learned };
}
