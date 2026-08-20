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
//   • intentToAct     — a parsed player SENTENCE (parse-intent.ts) → a DialogueAct.
//   • chooseSpeakerAct — WHAT an NPC says, weighted by its own dials.
//
// ═══ AND THEN THERE WERE MORE THAN TWO ═══════════════════════════════════════
// This file used to carry four more: `pickSpeakerAct` (a fixed need-first
// policy), `converse` (one exchange), and `askWhere`/`askWhereType` (ask, then
// teach the asker). All four were DYADIC — they took a listener positionally
// and handed back one reply, which is the arity §4.7 exists to end — and ⑪
// deleted them (multi-entity-conversations.md §4.11). Nothing in production
// called any of them. The two functions at the BOTTOM of this file are the
// n-ary replacements, and they are the only entry points a caller should reach
// for:
//
//   • speakInConversation — somebody says something into a CONVERSATION: it is
//     recorded, whoever answers is arbitrated (respond.ts), the reply is the
//     unchanged 24-arm `selectAct` under THAT member's own rung, everyone
//     present overhears what was told, and the non-answerers' reactions come
//     back for the presentation layer. One façade for players and NPCs alike —
//     the symmetry law made structural rather than merely observed.
//   • chooseSpeakerMove   — an NPC's move in a conversation: WHOM first, then
//     WHAT (the existing `chooseSpeakerAct` machinery, aimed at them).
//
// Pure + deterministic (no AMBIENT RNG — the speaker's roulette draws from a
// stream the caller supplies; no world coordinates), so it's headless-testable.

import type { CreatureId, CreatureState, CreatureWorld, ItemId, NeedTarget } from "@shared/world-engine/interaction/behavior/creatures.js";
import { itemMatchesNeed, openNeeds, providesKey, tellAbout } from "@shared/world-engine/interaction/behavior/creatures.js";
import {
  projectDialogue,
  selectAct,
  type ActResult,
  type DeviceBoardState,
  type DialogueAct,
  type DialogueCtx,
  type Perspective,
  type ProjectionOpts,
} from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";
import { NEUTRAL_PERSONALITY, type Personality } from "@shared/world-engine/interaction/behavior/personality.js";
import { DEFAULT_RELATION, type Relation } from "@shared/world-engine/interaction/behavior/relations.js";
import type { SyntaxLevel } from "@shared/world-engine/interaction/dialogue/dialogue-gen.js";
import { canonicalVerb, type IntentFrame, type Ref } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { STATE_AXES, tellFact } from "@shared/world-engine/interaction/behavior/facts.js";
import {
  memberOf,
  recordUtterance,
  type ConversationState,
  type Tick,
  type Utterance,
} from "@shared/world-engine/interaction/dialogue/conversation.js";
import {
  arbitrateResponse,
  defaultRelevance,
  responseUrge,
  type RelevanceOpts,
  type ResponseCandidate,
  type SilentReaction,
} from "@shared/world-engine/interaction/dialogue/respond.js";
import { isPlayerCid } from "@shared/world-engine/interaction/quest/player-identity.js";
import { headOf } from "../../variations.js";

/** Movement verbs that turn a "where" question into a DESTINATION query ("where are
 *  you going?") rather than an item where-is (parse-intent's MOVEMENT_GOAL_VERBS). */
const GOING_VERBS = new Set(["go", "come", "run", "chase"]);
/** Verbs of POSSESSION. Negated, they answer "I don't have one" (`cant`)
 *  rather than "I won't" (`refuse`) — a different thing to be told. */
const HAVE_VERBS = new Set(["have", "hold", "carry"]);
/** Inner verbs of a MODAL desire whose object IS the thing wanted: "i_me +
 *  want + eat + apple" asks for the apple exactly as "want + apple" does.
 *  Any other action desire keeps its object as part of the ACT ("want + go
 *  + home", "want + build + house") — the home is not being requested. */
const WANT_THING_VERBS = new Set(["eat", "drink", "play", "get", "have", "wear"]);

/** Verbs a "what + {creature} + {verb}" question must NOT read as an activity
 *  ask: they query possession/desire ("what do you want/have?"), not doing. */
const ACTIVITY_EXCLUDED_VERBS = new Set(["want", "need", "have", "like", "feel"]);

/**
 * Map a parsed SENTENCE (from `p.speakerId`, aimed at `p.addresseeId`) to a DialogueAct, or
 * null if it's an IMPERATIVE (command/rule/sequence — handled by the goal/party layer).
 * The MODALITY of the frame chooses the act (semantic-behavior.md §4): a WANT → request,
 * an OFFER → offer, an ASSERT (`state`) → tell (share a fact), a QUERY (`ask`) → where-is
 * / why / small-talk, the social acts → their moves. Every CONVERSATIONAL frame yields
 * SOME act (an unmapped mention becomes a bare `tell`; an unclear one `confused`) — so a
 * hand-authored sentence always gets a reply. Speaker-agnostic: pass an NPC as the
 * perspective's speaker and it maps an NPC's utterance the same way, so NPC↔NPC and
 * player↔NPC share this path.
 *
 * Item references resolve by KIND: a WANT/QUERY resolves against what the LISTENER holds
 * ("i_me want cookie" asks the creature for ITS cookie); an OFFER/ASSERT resolves against
 * the SPEAKER's own holdings/knowledge; either falls back to any world instance of the
 * kind so a location can still be named.
 *
 * WHO IS BEING SPOKEN TO is now a `Perspective` (§3b), not a second positional id, and
 * `addresseeId` may be ABSENT — a line spoken to the FLOOR. Every reading that needs a
 * definite listener ("give me your cookie", "what are you doing?", an invitation) returns
 * null in that case rather than inventing a target: an act aimed at nobody is not a
 * quieter act, it is a different one.
 */
export function intentToAct(
  frame: IntentFrame,
  world: CreatureWorld,
  p: Perspective,
  opts: Pick<
    ProjectionOpts,
    "symbolOf" | "creatureOf" | "doingOf" | "jointActivities" | "resolveSourceFor"
  >,
  /** ⚖️ WHY-CHAINS §5 — the SPEAKER'S OWN BOARD STATE, so a spoken "why?" can
   *  ride the same `why-doing` act the button does (spoken and board are ONE
   *  path, not two readings of one word). Only `ui.whyChain` is read; absent ⇒
   *  every "why" keeps its needs-gated meaning, exactly as before. */
  ui?: DeviceBoardState,
): DialogueAct | null {
  const speakerId = p.speakerId;
  /** Undefined = spoken to the floor; see the null-returns below. */
  const listenerId = p.addresseeId;
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
      // "you" with nobody addressed names NOBODY — bail rather than hand back a
      // symbol with no creature (which the evaluator reads as "there is no you").
      if (r.kind === "listener") return listenerId ? { symbol: "you", id: listenerId } : undefined;
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
  /** Held by whoever is being ADDRESSED — nothing, when nobody is. */
  const listenerHeld = (symbol: string): ItemId | undefined =>
    listenerId ? heldBy(listenerId, symbol) : undefined;
  const listenerItem = objectSymbol ? listenerHeld(objectSymbol) : undefined;
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
    if (listenerId && world.creatures[listenerId]?.knowledge[providesKey(objectSymbol)]) {
      return { category: objectSymbol };
    }
    // ⚖️ …OR A SORT THE LISTENER CAN LOCATE (law ③ — household-economy-and-
    // where-is.md §5.3, widened by §8 D1). Inside a household "food" names no
    // creature-world instance (pantry stock is a glyph→count map, never an item)
    // and nobody has been told a `provides` fact about it, so the two tests
    // above both miss and "where is the food?" fell through to no act at all.
    // But the person being asked EATS: it carries a hunger row for that very
    // category and can answer from its own acquire resolution. Being able to
    // place the word IS recognizing it.
    //
    // KIND FIRST — the more specific reading. "apple" is a KIND under the
    // category "food", and the row probe compares a kind against the row's item
    // spec the way every stack is matched, so the category-only probe could
    // never recognize it (§8's first root gap). A word no kind reading places
    // (like "food" itself, which is nobody's kind) falls to the category below.
    if (listenerId && opts.resolveSourceFor) {
      const kind = { kind: objectSymbol };
      if (opts.resolveSourceFor(listenerId, kind)) return kind;
      const category = { category: objectSymbol };
      if (opts.resolveSourceFor(listenerId, category)) return category;
    }
    return undefined;
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
    // An invitation needs somebody to invite — "let's eat" to the floor is a
    // formation move (§3f), not an act this dyadic mapper can produce.
    if (!listenerId || !frame.joint || !frame.verb) return undefined;
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

  // ⚖️ WHY-CHAINS §1/§5 — THE BARE ACTIVITY VERB IS THE ACTIVITY QUESTION.
  // *"[{subject} do what?] or [{subject} do?] lead to the same path. Just [do]
  // by itself parses as 'What are you doing?'"* The `what + …` shapes already
  // route through the question arm below; these two do not, because `do` is a
  // non-directive verb with no object, so "mara + do" classified as a plain
  // STATEMENT and came out as a bare `tell` ("thank you") — the one phrasing a
  // child on a two-glyph board can actually reach. No new word, no new act: the
  // same `what-doing` the question arm builds.
  if (frame.verb === "do" && !frame.question && !frame.modal && !frame.object && !frame.relation) {
    // `classifyPredicate` FILLS a missing subject with the speaker, so a bare
    // "do" arrives looking like a statement about me. Only an EXPLICIT "i_me"
    // is a real self-reference (the same test `explicitCreature` makes in the
    // statement arm); anything else means the listener, which is who a child
    // pressing one glyph is talking to. No addressee ⇒ leave the frame alone
    // and let the ordinary arms have it — an ask aimed at nobody is a
    // different act, not a quieter one.
    const named =
      frame.subject?.kind === "player" && !frame.raw.includes("i_me") ? undefined : aboutRef();
    const about = named ?? (listenerId ? { symbol: "you", id: listenerId } : undefined);
    if (about) return { kind: "what-doing", about, glyph };
  }

  switch (frame.kind) {
    case "request": {
      // A MODAL desire is a wish to DO something ("i_me + want + play"): a
      // disclosure, acknowledged — the bare request evaluator would answer it
      // with silence. An OBJECT rides along only when the inner verb is
      // itself about having the thing (WANT_THING_VERBS — "want eat apple"
      // still asks for the apple); for any other action the object is part
      // of the act ("want go home"), and running the item evaluator on it
      // answered the wish to go home with somebody's spare "home", or a flat
      // no. What GRANTING an action desire should look like in-game (a
      // bodiless spirit can want nothing for its own body) is deliberately
      // deferred — the honest floor is to hear it.
      if (frame.modal && frame.verb && !(objectSymbol !== undefined && WANT_THING_VERBS.has(canonicalVerb(frame.verb)))) {
        return { kind: "tell", glyph };
      }
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
        // A swap needs the OTHER side of it: with nobody addressed there is no
        // "what I want back", so there is no trade to propose.
        const get = wantSym ? listenerHeld(wantSym) : undefined;
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
        //
        // ⚖️ LAST RESORT: THE WORD ITSELF IS THE SORT (§8 D1). A well-formed
        // "where + {noun}" must never come back as `dont-understand`, and must
        // never produce an act carrying NEITHER an id nor a target — an act the
        // evaluator can only shrug at, and whose worse shapes fell out of the
        // conversation entirely (the reported host toast). Nobody here knows
        // what a "ball" is? Then the question is about a ball, and the RESPONDER
        // is the one who gets to say whether it can place one.
        const itemId = listenerItem ?? anyItem;
        const named = objectSymbol ?? refSymbol(frame.subject);
        const target = itemId
          ? undefined
          : (typeTarget() ?? (named ? { kind: named } : undefined));
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
          // A subjectless "what + eat" implies the LISTENER; with nobody
          // addressed the question is about nobody, so there is no act.
          const about = aboutRef() ?? (listenerId ? { symbol: "you", id: listenerId } : undefined);
          if (!about) return null;
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
          // (listenerItem already falls back to nothing with no addressee.)
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
        // ⚖️ WHY-CHAINS §5 — A BARE "WHY" INSIDE AN OPEN CHAIN WALK IS THE
        // CHAIN'S WHY. The board button and the spoken word are one path: the
        // child who pressed "what are you doing" and then says "why?" means the
        // same thing the follow-up button means, and answering it with the
        // needs-gated motive would change the subject mid-conversation. A "why"
        // that names a VERB keeps its premise-checked reading below — that is a
        // question about a specific activity, not a step up this ladder.
        if (!frame.verb && ui?.whyChain) return { kind: "why-doing", glyph };
        // "why + you + build" PRESUMES the listener is building — check the
        // premise before dumping a motive ("I want an apple" answers nothing).
        // Verifiably doing it → the motive; verifiably NOT → the correction
        // ("i_me + build.not"); can't tell → the honest can't-interpret line.
        // Movement verbs skip the check: walking is need-driven, the motive IS
        // the answer ("why + you + go" → "because I want food").
        const v = frame.verb;
        if (v && !GOING_VERBS.has(v)) {
          // The premise is about the ADDRESSEE; with nobody addressed there is
          // no premise to check, which is the same honest floor as "can't tell".
          const doing = listenerId ? opts.doingOf?.(listenerId) : undefined;
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
        const itemId = sym ? (listenerHeld(sym) ?? anyOf(sym)) : undefined;
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

/** How an NPC SPEAKER picks its move: its personality + how it regards the listener,
 *  plus a deterministic RNG so ties (and the no-motive case) break reproducibly. */
export interface SpeakerMood {
  /** The speaker's intrinsic dials (warmth/assertiveness/openness/expressiveness…). */
  personality?: Personality;
  /** The speaker's directed attitude toward the LISTENER (affinity gates generosity). */
  relation?: Relation;
  /**
   * The speaker's attitude toward ANY member — needed by `chooseSpeakerMove`,
   * which picks the addressee itself and therefore cannot be handed one
   * relation up front. Absent ⇒ every member is read at `relation` (or
   * `DEFAULT_RELATION`), which leaves the addressee weights uniform and the
   * reply-to-the-last-speaker bias doing all the work — a correct, duller
   * speaker rather than a wrong one.
   */
  relationTo?: (id: CreatureId) => Relation;
  /**
   * ⑫⑧ — IS THIS SPEAKER'S BODY SPOKEN FOR (legs walking, hands reaching —
   * the host's `headingSpokenFor`, law ①)? Read by ONE weight, `bye`, so the
   * coin and the clock read the same fact: the sweep's outbid deadline sends a
   * member who keeps losing the argmax home, and this makes the same member
   * likelier to say so on its own turn before the deadline ever arrives.
   *
   * ABSENT = not busy, so every existing caller keeps the shipped weights byte
   * for byte and no path draws differently.
   */
  busy?: boolean;
  /**
   * REQUIRED — the caller's seeded stream (`mulberry32(hashSeed(seed, …))`), the
   * roulette this speaker's move is drawn from.
   *
   * It used to default to `Math.random`, and that default was the hole: the two
   * dials are optional because a neutral creature is a real creature, but there
   * is no such thing as a "neutral" source of randomness — an ambient global
   * silently breaks replay, the certifier's simulation and the second device in a
   * shared world, and does it invisibly. Making it required turns the audit into
   * a compile error (§3d), which is the only kind of audit that stays done.
   */
  rng: () => number;
}

const EPS_WEIGHT = 0.05; // every act keeps a floor weight → "when all else fails, random"

/** ⑫⑧ — what `bye` is worth to a speaker whose body is already spoken for.
 *  DOUBLE the standing 0.3 and no more: the point is a visible lean toward
 *  closing, not a busy creature that can say nothing else. Against the acts a
 *  circle actually offers (small talk ~0.4–1.25, an offer up to ~2.05) it moves
 *  goodbye from the quiet floor to a real contender and leaves it there. */
const BUSY_BYE_WEIGHT = 0.6;

/** OPENER + navigation acts — never a spoken NPC turn. An NPC must not utter the bare
 *  menu-opener ("trade") or a list control; the TRADE opener is EXPANDED into its
 *  concrete picks (see chooseSpeakerAct), so the NPC can still ask a specific
 *  "trade for {item}" — just not the button that opens the list.
 *
 * ⚖️ AND NPCs DO NOT ASK DIRECTIONS AT ALL (§9 E1 — "a question is a failed
 * resolution"). The directions menu is generated from the ASKER'S OWN KNOWN
 * SUBJECTS, so expanding it made every NPC turn offer several "where is the
 * food/clothes/cookie?" asks about places that NPC already knew — the flood the
 * user reported as "a testing artifact". Every shape of it is barred here: the
 * opener, the single-subject `ask-directions`, and the picks themselves (which
 * can only arrive with a list already open). THE PLAYER'S BOARD IS UNTOUCHED —
 * the menu is pedagogy there, and post-Fix-B the answers are good. */
const NON_SPEAKER_ACTS = new Set<DialogueAct["kind"]>([
  "trade-menu",
  "directions-menu",
  "ask-directions",
  "directions-pick",
  "back",
  "more",
  "confused",
  // ⚖️ AND NPCs DO NOT ASK "WHAT ARE YOU DOING" EITHER (why-chains.md §7 — no
  // ask-generation changes at all in v1; §9 E1's gates stand). §5 pushes
  // `what-doing` onto the board UNCONDITIONALLY, and this projection is
  // role-swapped, so without this line every ambient turn gained a free
  // "what are you doing?" about the listener — the exact flood E1 removed.
  // `why-doing` rides with it: an NPC has no board walk to follow up on.
  "what-doing",
  "why-doing",
]);

/**
 * How strongly a SPEAKER with this mood is inclined to OPEN with `act`. The dialogue
 * board is shared (the same acts the player would see); an NPC differs only in that it
 * SELECTS by its own nature (semantic-behavior.md §8). Weights are motive × personality:
 *   • request/trade — wanting an item the listener holds, sharpened by ASSERTIVENESS;
 *   • offer          — GENEROSITY: warmth × how much it likes the listener (affinity);
 *   • how-are-you    — sociability: warmth × expressiveness;
 *   • where-is/ask   — curiosity: openness;
 *   • bye            — the natural closer (a modest floor so idle speakers drift off),
 *                      RAISED for a speaker whose body is spoken for (⑫⑧).
 * Everything else is a RESPONSE or navigation, not an opener — the epsilon floor only,
 * so it can still be picked at random but rarely leads.
 */
function speakerActWeight(
  act: DialogueAct,
  world: CreatureWorld,
  speaker: CreatureState,
  personality: Personality,
  relation: Relation,
  busy = false,
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
      // ⑫⑧ — A BUSY SPEAKER IS LIKELIER TO CLOSE, and that is the coin half of
      // the same fact the sweep counts on a clock: a member whose body keeps
      // being wanted elsewhere is a member on its way out of this circle. The
      // two must agree, or a creature would say goodbye on the roulette while
      // the deadline still thought it was staying (or the reverse — dragged
      // off by a deadline it had shown no sign of wanting).
      //
      // It is still only a WEIGHT among all the others, never a decision: a
      // busy creature with something to say says it.
      return busy ? BUSY_BYE_WEIGHT : 0.3;
    default:
      return EPS_WEIGHT;
  }
}

/**
 * Pick the SPEAKER's move from the SAME board the player would be shown, weighted by the
 * speaker's personality + relation, with a random tail so no combination is a dead end
 * (the user's design: "an NPC makes the selection using their own personality or, when
 * all else fails, random selection"). Where the retired `pickSpeakerAct` walked a fixed
 * priority list (need, then offer, then small talk), this lets a warm creature drift to
 * small talk, a needy assertive one to a request, an incurious one to almost anything —
 * emergent from the dials, no per-character code.
 *
 * NOT deprecated: this is the WHAT half of `chooseSpeakerMove`, which picks the
 * addressee and then calls straight through to here. What it cannot answer on
 * its own is WHOM — it takes a listener positionally — so a caller with a
 * conversation in hand should go through `chooseSpeakerMove` instead. It is the
 * one function in the dyadic half of this file that survived ⑪, and that is why.
 */
export function chooseSpeakerAct(
  world: CreatureWorld,
  speakerId: CreatureId,
  listenerId: CreatureId,
  level: SyntaxLevel,
  opts: ProjectionOpts,
  // No default: a mood without a stream is not a thing this function can honor
  // (see `SpeakerMood.rng`), so the empty-object default had to go with it.
  mood: SpeakerMood,
  ctx: DialogueCtx = {},
): DialogueAct | null {
  const speaker = world.creatures[speakerId];
  if (!speaker) return null;
  // The menu expansion is pure NAVIGATION — it opens a sub-menu to read what is
  // under it, so it varies `ui` and never touches the shared record.
  const project = (ui?: DeviceBoardState) =>
    projectDialogue(world, listenerId, speakerId, level, opts, { ...ctx, ui }).acts;
  // An NPC may ask a CONCRETE sub-item ("trade for {item}") but never the bare
  // menu-OPENER: expand the trade opener into its picks (re-project with the
  // submenu open), then drop the openers + list controls themselves.
  //
  // ⚖️ A QUESTION IS A FAILED RESOLUTION (§9 E2). The state-1 where-is act is
  // the LISTENER'S need seen from the outside — this projection is role-swapped
  // (`projectDialogue(world, listenerId, speakerId, …)`), so the need it is
  // built from, and the `target` riding it, belong to the LISTENER. Asking
  // around about it is only worth a turn when the person who WANTS the thing
  // cannot place it themselves: a genuinely empty larder, or the pet that cannot
  // open the fridge, is exactly when "where is the food?" is the right thing to
  // say — and a housemate who would simply walk to the refrigerator has no
  // question to ask. `none`/absent ⇒ KEEP; a real place ⇒ drop.
  const listenerCanPlace = (target: NeedTarget): boolean => {
    const a = opts.resolveSourceFor?.(listenerId, target);
    return a?.kind === "container" || a?.kind === "place";
  };
  const acts: DialogueAct[] = [];
  for (const a of project(ctx.ui)) {
    if (a.kind === "trade-menu") {
      acts.push(...project({ ...ctx.ui, tradeMenu: true }).filter((x) => x.kind === "trade-pick"));
    } else if (NON_SPEAKER_ACTS.has(a.kind)) {
      continue;
    } else if (a.kind === "where-is" && a.target && listenerCanPlace(a.target)) {
      continue;
    } else {
      acts.push(a);
    }
  }
  if (acts.length === 0) return null;
  const personality = mood.personality ?? NEUTRAL_PERSONALITY;
  const relation = mood.relation ?? DEFAULT_RELATION;
  const rng = mood.rng;
  const weights = acts.map((a) =>
    Math.max(0, speakerActWeight(a, world, speaker, personality, relation, mood.busy ?? false)),
  );
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return acts[Math.floor(rng() * acts.length)] ?? acts[0]!;
  let r = rng() * total;
  for (let i = 0; i < acts.length; i++) {
    r -= weights[i]!;
    if (r < 0) return acts[i]!;
  }
  return acts[acts.length - 1]!;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE FAÇADE — one utterance into a conversation of any size
// (planning-docs/games/world-engine/multi-entity-conversations.md §3c, §4.7)
// ═══════════════════════════════════════════════════════════════════════════
//
// Everything above this line takes a LISTENER positionally and hands back ONE
// reply. That shape is the dyad, and it is what makes three people around a
// table unrepresentable: it cannot say "she asked, but he was the one holding
// the cookie, so he answered", and it cannot say "nobody picked it up".
//
// `speakInConversation` is the same engine with the arity taken out. It does
// five things and no more, in this order — and the order is load-bearing:
//
//   1. RECORD it. The conversation now HAS a history, which is what makes the
//      seeded stream keyable (`nextSeq`), the courtesy decay measurable
//      (`lastSpokeTick`) and the idle clock honest (`lastActivityTick`). The
//      host used to bump that clock by hand precisely because this step did not
//      exist; that stand-in dies here.
//   2. WEIGH everyone who could answer (respond.ts `responseUrge`).
//   3. DRAW once. One responder, or nobody.
//   4. PHRASE the reply through the unchanged 24-arm `selectAct`, at the
//      RESPONDER'S OWN RUNG.
//   5. SPREAD what was told to everyone present (overhearing).
//
// ⑫⑤ adds ONE early exit, between 1 and 2 and nowhere else: an act that needs a
// named person to execute, said to a room of three or more with nobody named,
// stops after being RECORDED. Steps 2–5 do not run and the stream is not
// touched. That is the ambiguity arriving as an outcome instead of as a dropped
// press — see `ADDRESSEE_REQUIRED_ACTS`.
//
// It owns no state, reads no clock, holds no rng and touches no screen: the
// tick and the draw arrive as parameters and the reactions go back out as data
// for a presentation layer to render. Which is why a host, a test and a
// headless certifier run can all drive it identically.

/**
 * What the pure layer needs from its host to run ONE turn. Everything here is
 * either a fact about the moment (the tick, the draw) or a lookup the host owns
 * (personalities and relations live in the host's books, not on the creature).
 *
 * The two lookups are OPTIONAL and fall back to `NEUTRAL_PERSONALITY` /
 * `DEFAULT_RELATION`, so a test — or a game with no relation book at all — gets
 * a neutral room rather than a crash. That is the same "a neutral creature is a
 * real creature" reasoning `SpeakerMood` follows, and the same reason `rng` is
 * NOT optional beside them: there is no neutral source of randomness.
 */
export interface ConvoDeps {
  /** NOW, in the host's own SIM-tick unit (`session.taskClock`) — the unit the
   *  courtesy decay and the idle clock are both measured in. Never wall time. */
  tick: Tick;
  /**
   * The seeded stream for this turn — `mulberry32(hashSeed(seed, "convo",
   * convoId, seq))`, ONE generator per turn (§3d).
   *
   * The arbitration takes exactly one draw from it, and unless the caller
   * supplies its own `ctx.rng` the willingness gates inside the reply draw from
   * the SAME stream, straight after. One turn, one stream, one replay.
   */
  rng: () => number;
  /** A member's intrinsic dials. Absent hook (or absent member) ⇒ neutral. */
  personalityOf?: (id: CreatureId) => Personality;
  /** How `observer` regards `subject` — asked as (member, speaker), because
   *  what moves an urge is who is talking TO ME, never who they are talking
   *  about. Absent ⇒ `DEFAULT_RELATION`. */
  relationOf?: (observer: CreatureId, subject: CreatureId) => Relation;
  /** Passed straight to `defaultRelevance`: does a member know the PLACE a
   *  directions question names? Place-facts are the host's. */
  knowsPlace?: RelevanceOpts["knowsPlace"];
}

export interface SpokenTurn {
  /** What was said, AS RECORDED — `seq` assigned, addressees normalized. The
   *  caller wants this one and not the act it passed in: the recorded form is
   *  what every later turn will see. */
  utterance: Utterance;
  /**
   * ★ ⑫⑤ — IT WAS SAID, AND IT NAMED NOBODY IT NEEDED TO NAME. ★
   *
   * Set when `ADDRESSEE_REQUIRED_ACTS` met a 3+ roster with no addressee: the
   * utterance is on the record, and NOTHING ELSE HAPPENED — no arbitration, no
   * draw, no reply, no `silent` reactions. The caller's job is to say so
   * ("who do you mean?") and put the choice back in front of the speaker; the
   * host does exactly that with `WHO_DO_YOU_MEAN` + a board re-present.
   *
   * Never set in a dyad (law ④), never set for a floor-safe act, and never set
   * alongside `response`.
   */
  underSpecified?: true;
  /**
   * Who answered and what came back. ABSENT = nobody answered, which is an
   * OUTCOME and not a failure — render `silent`.
   *
   * `result` is the untouched `ActResult`, so every branch a dyadic caller used
   * to switch on (askedDirections, close, events, ui, followUpGlyph) is still
   * exactly where it was.
   */
  response?: {
    responderId: CreatureId;
    result: ActResult;
    /**
     * The reply as recorded — see `replyAct` for why this is a `tell`, and why
     * it is ABSENT when the reply had no glyph. A caller that just wants "did
     * they speak" should read `result.responseGlyph`; this field is for anyone
     * who needs the history row (its `seq`, its tick).
     */
    utterance?: Utterance;
  };
  /** Everyone who reacted without speaking, in roster order (respond.ts). Never
   *  empty on a full silence while there were candidates — that is the law. */
  silent: SilentReaction[];
}

/**
 * Below this affinity a member's refusal to answer reads as a REFUSAL: on a
 * full silence it turns away instead of glancing up (respond.ts
 * `ResponseCandidate.hostile`). The module deliberately leaves the threshold to
 * its caller — affinity is a continuum and "hostile" is a game's call — so this
 * is that call, made once, here, rather than at every call site. −0.3 is a third
 * of the way to outright enmity: dislike, not hatred.
 */
export const HOSTILE_AFFINITY = -0.3;

/** The rung a member is phrased at when the roster somehow hasn't got them — the
 *  same two-word floor every other level fallback in the engine uses. */
const FALLBACK_LEVEL: SyntaxLevel = "b";

/**
 * ★ ⑫⑤ — THE ACTS THAT NEED A NAMED PERSON TO EXECUTE. ★
 * (conversation-in-motion.md law ②, build-order ⑤)
 *
 * The test is not "does this act mention a person" — `FLOOR_SAFE_ACTS` below
 * already answers that, and it is a question about PHRASING. This one is about
 * EXECUTION: is there a pair of hands, or a body, that the act cannot be carried
 * out without? A `request` has to take a thing out of somebody's grip; an
 * `offer` and a `trade`/`trade-pick` have to put one into somebody's; an
 * `invite` has to commit a specific body to a specific activity. Said into a
 * circle of three with nobody named, each of those is an instruction with a hole
 * in it, and no amount of arbitration can fill the hole honestly — whoever the
 * wheel picked would be doing something the speaker never asked THEM to do.
 *
 * ── WHY THE QUESTION FAMILY IS DELIBERATELY OUT ──────────────────────────────
 * `where-is`, `ask-fact`, `ask-directions`, `what-doing`, `where-going`: "does
 * anyone know where the ball is?" is a perfectly good thing to say to a room,
 * and it is the shape a floor line is BEST at — `defaultRelevance` already
 * weights the member who actually knows, so the room answers it with the right
 * voice. Making a question ambiguous would punish the one act that works.
 *
 * ── AND WHY `how-are-you` IS OUT ─────────────────────────────────────────────
 * Anyone can say how they are. It names the second person in its phrasing (which
 * is why it is not floor-SAFE either — `chooseSpeakerMove` re-aims it at whoever
 * the speaker was facing), but nothing about executing it requires a particular
 * person, so a floor `how-are-you` gets an answer from whoever feels like
 * answering. That is the correct, and pinned, behaviour.
 *
 * ── WHY THIS DECISION IS PURE, AND LIVES HERE ────────────────────────────────
 * It reads exactly three things — the roster SIZE, whether an addressee was
 * supplied, and the act KIND — and all three are already in this module, which
 * is the module that owns "an absent addressee is the floor". Nothing about a
 * screen, a body, a camera or a clock enters into it. That matters because a
 * SECOND DEVICE has to re-derive the same verdict from the same utterance: if
 * this were a host-side check, two peers watching one circle could disagree
 * about whether a line was ever answered. One rule, one place, one answer.
 *
 * 🚨 DISJOINT FROM `FLOOR_SAFE_ACTS` BY CONSTRUCTION — an act cannot be both
 * "fine to say to nobody" and "impossible to execute without somebody". Pinned
 * in `conversation-ambiguity.test.ts`.
 */
export const ADDRESSEE_REQUIRED_ACTS: ReadonlySet<DialogueAct["kind"]> = new Set<DialogueAct["kind"]>([
  "request",
  "trade",
  "trade-pick",
  "offer",
  "invite",
]);

/**
 * ⑫⑤ — IS THIS UTTERANCE UNDER-SPECIFIED? The whole rule, in one predicate, so
 * the host and a certifier read the same sentence rather than two copies of it.
 *
 * The dyad exemption (law ④) is the roster-size test: with one other person
 * there is nothing to disambiguate, so a floor `request` in a pair is simply a
 * request to the only other person there — and `soleOther` says so.
 *
 * "No addressee" is asked as `!addresseeId`, matching `recordUtterance`'s own
 * normalization (an empty addressee list IS the floor) rather than a strict
 * `=== undefined`. The two must agree: a caller who handed in something falsy
 * would otherwise get an utterance the record calls floor-addressed and this
 * rule calls addressed, which is exactly the kind of two-readings-of-one-fact
 * that ⑫ exists to remove.
 */
function underSpecifiedTurn(
  c: ConversationState,
  act: DialogueAct,
  addresseeId: CreatureId | undefined,
): boolean {
  return !addresseeId && c.members.length > 2 && ADDRESSEE_REQUIRED_ACTS.has(act.kind);
}

/**
 * SOMEBODY SAYS SOMETHING, and the conversation answers — or doesn't.
 *
 * `addresseeId` absent = spoken TO THE FLOOR: nobody owes an answer, anybody may
 * take it, and everybody overhears. `ctx` carries this device's board state and,
 * optionally, its own rng; `convo` is supplied here and cannot be overridden,
 * because the whole point is that this turn lands in THIS conversation.
 *
 * ── ⑫⑤ — …UNLESS THE FLOOR CANNOT HOLD IT ─────────────────────────────────────
 * One class of line does not survive being said to nobody: the acts that need a
 * named person TO EXECUTE (`ADDRESSEE_REQUIRED_ACTS`). In a roster of three or
 * more those come straight back `underSpecified` — recorded, unarbitrated,
 * unanswered, and with no draw taken — for the caller to answer with "who do you
 * mean?". Everything else keeps going to the floor exactly as before.
 *
 * ── WHY PLAYERS ARE NOT CANDIDATES ────────────────────────────────────────────
 * A player answers by pressing their own board. Arbitrating one into replying
 * would mean the engine putting words in a child's mouth, which is the opposite
 * of what an AAC system is for — so `isPlayerCid` members are weighed for
 * nothing and drawn for nothing. They are still members in every other sense:
 * they hear, they overhear, and they can be the addressee.
 *
 * ── WHY THE RESPONDER PHRASES AT ITS OWN RUNG ─────────────────────────────────
 * `selectAct` is given `memberOf(c, responderId).level`, not the speaker's. Two
 * students in one conversation keep their own syntax tiers (conversation.ts law
 * 2), and a reply is the RESPONDER'S sentence — phrasing it at the asker's rung
 * would make an able speaker sound like whoever happened to address them. The
 * corollary the caller has to know: the same answer to the same question reads
 * differently to different members, and only the member being rendered for sees
 * their own. (v1 renders one line for everyone — the per-member re-projection is
 * the host's `presentCreatureTurn(…, memberCid)`, already built in §4.6.)
 */
export function speakInConversation(
  world: CreatureWorld,
  c: ConversationState,
  speakerId: CreatureId,
  act: DialogueAct,
  addresseeId: CreatureId | undefined,
  opts: ProjectionOpts,
  deps: ConvoDeps,
  ctx: Omit<DialogueCtx, "convo"> = {},
): SpokenTurn {
  // ── 1. IT WAS SAID ────────────────────────────────────────────────────────
  const utterance = recordUtterance(c, {
    tick: deps.tick,
    speakerId,
    ...(addresseeId ? { addresseeIds: [addresseeId] } : {}),
    act,
  });

  // ── 1b. …AND IT NAMED NOBODY IT NEEDED TO NAME (⑫⑤) ──────────────────────
  // THE ONE PLACE THE AMBIGUITY BECOMES AN OUTCOME. An act that cannot be
  // executed without a named person, said into a room of three or more with no
  // channel spent, stops here: it is on the record (it WAS said, and the
  // conversation's clocks move for it), and nothing else happens.
  //
  // 🚨 NOT ONE `rng()` DRAW ON THIS PATH, and that is a hard requirement rather
  // than a nicety: `ConvoDeps.rng` is ONE seeded stream per turn, keyed on the
  // seq, and the seeded suites downstream replay off it. A single stolen draw
  // here would shift every subsequent turn in the transcript — the byte-identity
  // bar the chapter set (§5). Returning BEFORE the arbitration is what keeps it.
  //
  // `overhear` is skipped with it, which costs nothing: it only spreads `tell` /
  // `tell-fact`, and neither is in `ADDRESSEE_REQUIRED_ACTS`.
  if (underSpecifiedTurn(c, act, addresseeId)) {
    return { utterance, underSpecified: true, silent: [] };
  }

  // ── 2. WHO COULD ANSWER, AND HOW BADLY THEY WANT TO ───────────────────────
  //
  // ⚖️ THE RELEVANCE LADDER READS THE SAME HOOKS THE REPLY WILL (law ③). A
  // member whose own acquire resolution can answer a sort question is a member
  // who CAN answer it — without this the arbitration keeps electing the
  // ignorant, they say "I don't know", and the one person in the room who was
  // about to open that very fridge never gets the floor. Built once per turn,
  // not per member; the probe itself runs per ask, never per frame.
  const relevanceOpts: RelevanceOpts = {
    ...(deps.knowsPlace ? { knowsPlace: deps.knowsPlace } : {}),
    ...(opts.resolveSourceFor
      ? {
          answersSource: (memberId: CreatureId, target: NeedTarget) => {
            const a = opts.resolveSourceFor?.(memberId, target);
            // Every answer that NAMES A PLACE OR A HOLDER counts; `none` and
            // absence do not — they are the two ways of having nothing to say.
            return a?.kind === "container" || a?.kind === "place" || a?.kind === "holder";
          },
        }
      : {}),
  };
  const candidates: ResponseCandidate[] = [];
  for (const m of c.members) {
    if (m.id === speakerId || isPlayerCid(m.id)) continue;
    const relation = deps.relationOf?.(m.id, speakerId) ?? DEFAULT_RELATION;
    const urge = responseUrge({
      member: m,
      utterance,
      tick: deps.tick,
      personality: deps.personalityOf?.(m.id) ?? NEUTRAL_PERSONALITY,
      relation,
      relevance: defaultRelevance(world, m.id, act, relevanceOpts),
    });
    candidates.push({
      id: m.id,
      urge,
      ...(relation.affinity < HOSTILE_AFFINITY ? { hostile: true } : {}),
    });
  }

  // ── 3. ONE DRAW ───────────────────────────────────────────────────────────
  const choice = arbitrateResponse(candidates, {
    ...(utterance.addresseeIds ? { addressedIds: utterance.addresseeIds } : {}),
    rng: deps.rng,
  });

  // ── 4. THE REPLY ──────────────────────────────────────────────────────────
  let response: SpokenTurn["response"];
  if (choice.responderId !== undefined) {
    const responderId = choice.responderId;
    const result = selectAct(
      world,
      responderId,
      speakerId,
      act,
      memberOf(c, responderId)?.level ?? FALLBACK_LEVEL,
      opts,
      // The stream continues where the arbitration left it unless the caller
      // deliberately handed a separate one — see `ConvoDeps.rng`.
      { ...ctx, convo: c, rng: ctx.rng ?? deps.rng },
    );
    const reply = replyAct(result);
    response = {
      responderId,
      result,
      ...(reply
        ? {
            utterance: recordUtterance(c, {
              tick: deps.tick,
              speakerId: responderId,
              addresseeIds: [speakerId],
              act: reply,
            }),
          }
        : {}),
    };
  }

  // ── 5. EVERYONE PRESENT HEARD IT ──────────────────────────────────────────
  // AFTER the reply, deliberately: the responder learns inside `selectAct` (and
  // emits the `knowledge-gained` event that proves it), and running the spread
  // first would silently swallow that event by making the fact old news.
  overhear(world, c, speakerId, act);

  return { utterance, ...(response ? { response } : {}), silent: choice.silent };
}

/**
 * THE REPLY-RECORDING DECISION, and it is a decision rather than an oversight.
 *
 * A reply is not a `DialogueAct`. `conversation.ts` says so out loud (see
 * `markRevealed`): acts are what a speaker may CHOOSE to say, and an answer
 * comes back through `ActResult`. There is no act kind for "I don't know", no
 * kind for "thank you", and inventing one would put a word in the 24-arm
 * evaluator's vocabulary that no board can ever offer and no parser can ever
 * produce — a kind that exists only to be written into history.
 *
 * But NOT recording the reply is worse, and the reason is `courtesy`. The whole
 * mechanism that makes a conversation circulate rather than becoming two people
 * talking at each other is `member.lastSpokeTick`, and that field is written by
 * exactly one function: `recordUtterance`. A responder whose reply is never
 * recorded never yields — it answers every single utterance forever, which is
 * the failure arbitration exists to prevent.
 *
 * So: the reply is recorded as a `tell` carrying ONLY the spoken glyph. `tell`
 * is the one kind whose stock meaning already IS "a bare disclosure with no
 * shareable payload — still a turn, acknowledged" (see `selectAct`'s tell arm),
 * which is precisely what a reply is when read as an act. And it carries NO
 * payload field — no `itemId`, no `fact`, no `query`, no `target` — so
 * `noteContext` learns nothing from it and nothing downstream can mistake a
 * reply for a claim about a thing.
 *
 * ⚠️ WHEN A REPLY-ACT KIND ARRIVES (the answer half of the language, if it is
 * ever built), it belongs here and this synthesis goes away. Until then, treat a
 * `tell` in history whose act has no payload as "somebody answered", not as
 * "somebody volunteered a fact".
 *
 * NO GLYPH ⇒ NO RECORD. A navigation act (opening the trade menu, turning a
 * page) and a malformed query come back with `ui` or nothing at all and no
 * `responseGlyph`: the responder did not SPEAK. Recording that would put a
 * silent turn in the history and — worse — charge the responder a courtesy
 * penalty for words it never said.
 *
 * ⚠️ ONE HONEST MISS in that rule: a DIRECTIONS answer (`askedDirections`) comes
 * back glyphless because the pure layer cannot measure a town — the host
 * composes and speaks the phrase itself. So the answerer says something real and
 * takes no courtesy hit for it. Fixing that here would mean this module guessing
 * at a line it cannot see; it belongs with whatever finally lets the pure layer
 * hand back the sentence it meant.
 */
function replyAct(result: ActResult): DialogueAct | null {
  const glyph = result.responseGlyph;
  return glyph ? { kind: "tell", glyph } : null;
}

/**
 * OVERHEARING — the multi-party payoff, and the reason a group is worth having.
 *
 * A thing said out loud in a circle is heard by the circle. `selectAct` writes
 * the told fact into the ONE member it is evaluating (its `tell` arm calls
 * `tellAbout`, its `tell-fact` arm calls `tellFact`); this walks the rest of the
 * roster and writes the same fact through the same channel. Not a new knowledge
 * path — the SAME one — because "telling writes what a sighting would" is a law
 * (facts.ts) and a second path would be a second set of rules to keep in step.
 *
 * PLAYERS INCLUDED. A player's creature is a spark with knowledge of its own; a
 * child standing in a circle where somebody says where the ball is has heard
 * where the ball is, and their board should offer it next turn.
 *
 * TWO CAREFULLY-KEPT ASYMMETRIES:
 *
 *   • A LOCATION told (`tell`) is written only into a member who does NOT
 *     already know — mirroring the arm exactly. Overwriting unconditionally
 *     would let a speaker's stale belief clobber a bystander's fresher sighting.
 *   • A CONDITION about a member is never written into THAT member. The
 *     `tell-fact` arm makes a claim about the listener something to confirm or
 *     correct, never to absorb ("no, I'm not hungry"), and an overhearer being
 *     told about itself is in exactly that position.
 *
 * 🚨 KNOWN GAP — AN ANSWER STILL REACHES ONLY THE ASKER. The knowledge spread on
 * the `where-is` / `ask-fact` arms lives INSIDE `selectAct`, aimed at the
 * positional `playerId`, i.e. whoever asked. So a creature answering "the ball
 * is in the blue house" to Ann teaches Ann and nobody else, even with Ben
 * standing right there. Closing it means either lifting the spread out of those
 * arms or returning the answering fact on `ActResult` — both changes to
 * creature-dialogue.ts, which §4.7 does not own. Pinned by a documented-gap test
 * in `conversation-turns.test.ts` so the day it changes is a day somebody
 * chooses.
 */
function overhear(
  world: CreatureWorld,
  c: ConversationState,
  speakerId: CreatureId,
  act: DialogueAct,
): void {
  if (act.kind !== "tell" && act.kind !== "tell-fact") return;

  // A `tell`'s payload is not on the act — it is what the SPEAKER knows about
  // the item it named (the tell arm reads exactly this).
  const told = act.kind === "tell" && act.itemId ? world.creatures[speakerId]?.knowledge[act.itemId] : undefined;
  const fact = act.kind === "tell-fact" ? act.fact : undefined;
  if (!told && !fact) return;

  for (const m of c.members) {
    if (m.id === speakerId) continue;
    const listener = world.creatures[m.id];
    if (!listener) continue;
    if (told && act.itemId) {
      if (!listener.knowledge[act.itemId]) tellAbout(world, m.id, act.itemId, told);
      continue;
    }
    if (!fact) continue;
    // Told about MYSELF — a claim to answer, not knowledge to absorb.
    if (fact.kind === "condition" && fact.creature === m.id) continue;
    tellFact(world, m.id, fact);
  }
}

// ---------------------------------------------------------------------------
// An NPC's move: WHOM, then WHAT
// ---------------------------------------------------------------------------

export interface SpeakerMove {
  act: DialogueAct;
  /** ABSENT = said to the room. See `chooseSpeakerMove` for when that happens
   *  and, more importantly, for when it deliberately does NOT. */
  addresseeId?: CreatureId;
}

/**
 * The floor under an addressee's weight. Nobody standing in a circle is
 * unaddressable, so the weight runs `MIN_ADDRESSEE … MIN_ADDRESSEE + 1` over the
 * affinity range rather than `0 … 1`: being disliked makes you a less likely
 * person to be spoken to, never an invisible one.
 */
const MIN_ADDRESSEE = 0.5;
/** Doubling for whoever spoke last. A conversation is mostly a chain of replies,
 *  and this single number is what makes it read as one instead of as a room of
 *  people taking uncoordinated turns. */
const REPLY_BIAS = 2;
/**
 * The weight of ADDRESSING THE ROOM. Deliberately the same 0.35 as
 * `ARBITRATION.addressedFloor`, read from the other side: a remark to nobody in
 * particular is worth about a third of a remark to a person, whether you are
 * deciding to make one or deciding to answer one.
 */
const ROOM_WEIGHT = 0.35;

/**
 * Acts that stand on their own with NOBODY addressed.
 *
 * The test is grammatical, not stylistic: does the act's phrasing point at a
 * particular person? "Where is the ball?" and "bye" do not; "how are you", "give
 * me your cookie", "come and eat with me" and "what are you doing?" do — the
 * second person is baked into them, and saying one to the room is saying it to
 * whoever is in front of you whatever the roulette intended. Hence
 * `chooseSpeakerMove`'s rule: an act that names a person IS aimed at them.
 *
 * ⑫⑤ — THIS IS NOT THE COMPLEMENT OF `ADDRESSEE_REQUIRED_ACTS`, and the gap
 * between them is deliberate. Grammar and execution are two different tests, and
 * an act can fail the first while passing the second: `how-are-you` names the
 * second person (so it is not floor-safe, and an NPC's remark to the room gets
 * re-aimed) while needing nobody in particular to execute (so a floor
 * `how-are-you` from a board press is answered by whoever answers). The two sets
 * are DISJOINT — nothing can be both — but their union is not everything.
 */
export const FLOOR_SAFE_ACTS: ReadonlySet<DialogueAct["kind"]> = new Set<DialogueAct["kind"]>([
  "tell",
  "tell-fact",
  "where-is",
  "ask-fact",
  "ask-directions",
  "directions-pick",
  "bye",
]);

/**
 * WHAT AN NPC SAYS NEXT, and to WHOM — the speaker-side twin of
 * `speakInConversation`.
 *
 * WHOM COMES FIRST, and that ordering is the design. The old `chooseSpeakerAct`
 * takes a listener as a parameter, which quietly assumes somebody upstream
 * already knew who was being talked to; in a circle, choosing the person IS most
 * of choosing the move. So: a seeded roulette over the other members, weighted
 * by
 *
 *     (MIN_ADDRESSEE + affinity01) × (they spoke last ? REPLY_BIAS : 1)
 *
 * plus — only in a room of THREE or more — a slot for addressing the room. In a
 * dyad that slot is meaningless: the only other person present IS the room, and
 * offering it would produce unaddressed lines in a two-person conversation for
 * no reason.
 *
 * Then WHAT, through the unchanged `chooseSpeakerAct`, projected at the chosen
 * addressee and phrased at the SPEAKER'S OWN rung (`memberOf(c, speakerId)`) —
 * each member speaks at their level, the same law the reply side obeys.
 *
 * ⚠️ THE ROOM SLOT CAN LOSE ITS OWN DRAW. Projection is listener-centric, so
 * even a remark to the room has to be chosen against somebody's board — the
 * highest-weighted member, the one the circle is most naturally facing. If what
 * comes back is an act that names a person (`FLOOR_SAFE_ACTS` says which do
 * not), the addressee is restored: the roulette chose an INTENTION, and an
 * intention that produced "give me your cookie" was aimed at a cookie-holder all
 * along. Recording it as floor-addressed would be a lie about who was asked, and
 * arbitration would then hand it to the wrong person.
 *
 * Pure and deterministic under `mood.rng`: exactly one draw here, then whatever
 * `chooseSpeakerAct` takes. Null when there is nobody else in the conversation,
 * or nothing this speaker can say.
 */
export function chooseSpeakerMove(
  world: CreatureWorld,
  c: ConversationState,
  speakerId: CreatureId,
  opts: ProjectionOpts,
  mood: SpeakerMood,
  ctx: DialogueCtx = {},
): SpeakerMove | null {
  const others = c.members.filter((m) => m.id !== speakerId);
  if (others.length === 0) return null;

  const lastOther = lastOtherSpeaker(c, speakerId);
  const affinity01 = (id: CreatureId): number => {
    const rel = mood.relationTo?.(id) ?? mood.relation ?? DEFAULT_RELATION;
    return (Math.max(-1, Math.min(1, rel.affinity)) + 1) / 2;
  };
  const weights = others.map(
    (m) => (MIN_ADDRESSEE + affinity01(m.id)) * (m.id === lastOther ? REPLY_BIAS : 1),
  );
  // The room slot only exists in a room. Appending a ZERO slot in a dyad would
  // still be reachable through the roulette's float-drift fallback, so it isn't
  // appended at all.
  const slots = others.length > 1 ? [...weights, ROOM_WEIGHT] : weights;
  const pick = rouletteIndex(slots, mood.rng);
  const toRoom = pick >= others.length;
  // Whose board the move is chosen against: the pick, or — addressing the room —
  // the member the circle is most naturally facing (highest weight, ties to the
  // earlier row, so the choice is a function of the deterministic roster order).
  const focus = toRoom ? others[topIndex(weights)]! : others[pick]!;

  const relation = mood.relationTo?.(focus.id) ?? mood.relation;
  const act = chooseSpeakerAct(
    world,
    speakerId,
    focus.id,
    memberOf(c, speakerId)?.level ?? FALLBACK_LEVEL,
    opts,
    { ...mood, ...(relation ? { relation } : {}) },
    ctx,
  );
  if (!act) return null;
  return { act, ...(toRoom && FLOOR_SAFE_ACTS.has(act.kind) ? {} : { addresseeId: focus.id }) };
}

/** The last member OTHER THAN this speaker to have said anything — who a reply
 *  would be a reply TO. Walks the ring backwards; undefined in a conversation
 *  that has only ever heard this one speaker (or nothing at all), in which case
 *  nobody carries the bias and affinity alone decides. */
function lastOtherSpeaker(c: ConversationState, speakerId: CreatureId): CreatureId | undefined {
  for (let i = c.history.length - 1; i >= 0; i--) {
    const u = c.history[i]!;
    if (u.speakerId !== speakerId) return u.speakerId;
  }
  return undefined;
}

/** Weighted index over non-negative weights, ONE draw. Mirrors respond.ts's
 *  private `roulette` (strict `<`, so a zero-weight slot can never win) — kept
 *  separate rather than exported across the module boundary because the two
 *  wheels answer different questions and should be free to diverge. */
function rouletteIndex(weights: readonly number[], rng: () => number): number {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (!(total > 0)) return 0;
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]! > 0 ? weights[i]! : 0;
    roll -= w;
    if (roll < 0) return i;
  }
  return weights.length - 1;
}

/** Highest weight, ties to the earlier entry (strict `>`). */
function topIndex(weights: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < weights.length; i++) if (weights[i]! > weights[best]!) best = i;
  return best;
}
