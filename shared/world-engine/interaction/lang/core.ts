// shared/world-engine/interaction/lang/core.ts
//
// PROPER TRANSLATIONS for glyph SENTENCES — the language-agnostic core.
//
// The glyph string ("i_me + want + apple.hot") is the game's canonical,
// language-INVARIANT representation (types.ts Quote docs). This module parses
// it and classifies it into one of a CLOSED set of semantic FRAMES — the
// sentence shapes the dialogue layer actually emits (dialogue-gen.ts +
// creature-dialogue.ts). Each language module then renders a frame with its
// own surface grammar (word order, agreement, articles, constructions).
//
// Why frames instead of word-for-word gloss: real languages don't map glyphs
// 1:1 — Hebrew possession is the "יש ל־" construction, requests are gendered
// imperatives, adjectives agree in gender/number/definiteness. The frame layer
// recovers WHO-does-WHAT-to-WHAT from the (SVO-ordered) glyph string, so each
// language is free to say it properly. Anything outside the closed shape set
// falls back to a lexicon gloss in glyph order — new symbols degrade to the
// old telegraphic reading, never crash.
//
// These files are deliberately SEPARATE from the app's i18n tables: a locale
// here is a RULESET (lexicon + morphology + constructions), not a flat string
// map. Word choices are kept consistent with client-aac/src/i18n glyph labels.

import { LEXICON as INTENT_LEXICON } from "../intent/parse-intent.js";
import { isAppearanceOnlyFacet } from "../../variations.js";
import { fixtureWord } from "../../types.js";

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** One glyph slot: HEAD symbol + dot MODIFIERS (+ a #question operator). */
export interface Token {
  head: string;
  mods: string[];
  q: boolean;
}

/** "apple.hot#question" → { head: "apple", mods: ["hot"], q: true }. */
export function parseToken(raw: string): Token {
  let q = false;
  const bare = raw.trim().replace(/#(\w+)/g, (_, op: string) => {
    if (op === "question") q = true;
    return "";
  });
  const [head = "", ...mods] = bare.split(".").filter(Boolean);
  return { head, mods, q };
}

export function parseSentence(glyph: string): Token[] {
  return glyph
    .split("+")
    .map(parseToken)
    .map(canonicalToken) // storage heads (`furn.chair`) are never words
    .filter((t) => t.head.length > 0);
}

/** Canonical re-serialization — the fixed-phrase lookup key. */
export function normalize(tokens: Token[]): string {
  return tokens
    .map((t) => [t.head, ...t.mods].join(".") + (t.q ? "#question" : ""))
    .join(" + ");
}

// ---------------------------------------------------------------------------
// Symbol part-of-speech (a property of the SYMBOL, shared by all languages)
// ---------------------------------------------------------------------------

export type SymPos = "pron" | "verb" | "adj" | "prep" | "quant" | "interj" | "noun";

const POS: Record<string, SymPos> = {
  i_me: "pron",
  you: "pron",
  // The collective voice (nations P6): a people speaking as itself, and of
  // its neighbours. Without these the fallback read them as pool nouns.
  we: "pron",
  they: "pron",
  want: "verb",
  give: "verb",
  take: "verb",
  get: "verb",
  have: "verb",
  help: "verb",
  think: "verb",
  know: "verb",
  to: "prep",
  in: "prep",
  on: "prep",
  for: "prep",
  // THE PROXIMITY PAIR — construction v1's placement relations, now sayable
  // ("put + chair + next_to + table" is the adjacent spot, "near" the room-
  // scaled vicinity). Without the POS entry the whole sentence degraded to a
  // telegraphic gloss.
  near: "prep",
  next_to: "prep",
  // THE REST OF THE PLACEMENT RELATIONS — `under`/`over` the vertical pair,
  // `behind`/`in_front_of` the facing pair. Same rule as near/next_to: without
  // a POS entry the placement line drops its endpoint (intent-lines refuses to
  // speak a join that isn't a prep). `on` stays the device-state adjective.
  under: "prep",
  over: "prep",
  behind: "prep",
  in_front_of: "prep",
  more: "quant",
  yes: "interj",
  no: "interj",
  ok: "adj", // "are you ok?" — predicative; alone it renders as a word
  hi: "interj",
  goodbye: "interj",
  thank_you: "interj",
  confused: "interj",
  sad: "adj",
  happy: "adj",
  big: "adj",
  small: "adj",
  hot: "adj",
  cold: "adj",
  clean: "adj",
  dirty: "adj",
  wet: "adj",
  dry: "adj",
  here: "interj",
  there: "interj",
  // JOINTNESS as a spoken word ("we do not sleep together"). Adverbial, and
  // `SymPos` has no adverb — it sits in the same slot here/there do, which are
  // adverbials too. Only the no-gathering line speaks it; on the INPUT side the
  // parser reads `together` as a manner marker, not through this table.
  together: "interj",
  // THIRD-PERSON pronouns (reference resolution — talk to him / help her): a
  // creature referred to by pronoun when it's the same species as the speaker
  // (gender.ts picks he/she). Object position takes each ruleset's him/her.
  he: "pron",
  she: "pron",
  trade: "verb",
  why: "interj", // the WHY question word (intercepted before frame dispatch)
  // Motive-batch verbs + preps: stay-with, preferences, want-to-do desires,
  // disposal (throw away).
  stay: "verb",
  like: "verb",
  play: "verb",
  read: "verb",
  wear: "verb",
  throw: "verb",
  with: "prep",
  // Motive-batch conditions + spoilage — predicate adjectives.
  lonely: "adj",
  hungry: "adj",
  smelly: "adj",
  // Dollhouse motives: the energy/fun meters' conditions ("I'm (not) tired",
  // "I'm bored").
  tired: "adj",
  bored: "adj",
  // Round-2 motives: thirst/hygiene conditions + the waste need's verb
  // ("i_me + need + bathroom" — a plain SVO frame).
  thirsty: "adj",
  // The DRESS motive's condition ("I'm scruffy") — the worn garment wants
  // changing. Predicate adjective like every other motive condition.
  scruffy: "adj",
  need: "verb",
  // Construction v1: the placement directive + the refusal-cause quality
  // ("the place is not good" — place + good.not).
  put: "verb",
  good: "adj",
  // THE COMPLETION STATE ("the house is finished") — a predicate adjective, the
  // same slot every other state word sits in, so it agrees in gender and number
  // for free. It is core AAC vocabulary (the glyph registry has drawn it all
  // along) and had no outbound reading at all: without this entry the finished
  // shell reported "house finished" as two loose words.
  finished: "adj",
  // Phase ①a: the explicit "I don't understand" terminal fallback
  // ("i_me + understand.not") — never silence, never a misleading "okay".
  understand: "verb",
  // Movement (where-going): "go" gets its own `going` frame; listing it here
  // keeps stray uses ("i_me + want + go") off the noun path.
  go: "verb",
  // Nations P6 — the political verbs. `fight` is the verb the absolute
  // taboo ring forbids (P2): it shipped as a law target while the language
  // layer still read it as a noun, so the flagship refusal came out as
  // "we not fight" instead of "we don't fight".
  fight: "verb",
};

/** Device toggle states (§5): predicate adjectives ("the window is open", "the
 *  lamp is off") that AGREE with the device's gender. "on" shadows the (never-
 *  emitted) `on` preposition — device state wins. */
export const DEVICE_STATE = new Set(["on", "off", "open", "closed"]);

// ONE VOCABULARY: the concept parser's LEXICON (intent/parse-intent.ts) is the
// single source of truth for what a symbol IS. The POS table above keeps only
// outbound-specific readings (and always WINS — "ok" stays predicative,
// "clean" stays the state adjective, toggle states stay device predicates);
// every other lexicon symbol derives its part of speech here, so a word the
// parser understands ("eat", "sleep", "broken") also RENDERS with proper
// grammar instead of degrading to the telegraphic gloss. Deixis, question
// words, connectives and relations are deliberately NOT derived — their
// outbound readings are construction-specific.
{
  const CAT_POS: Record<string, SymPos> = { verb: "verb", attribute: "adj", quantity: "quant", social: "interj" };
  for (const [head, entry] of Object.entries(INTENT_LEXICON)) {
    const pos = CAT_POS[entry.cat];
    if (pos && !POS[head] && !DEVICE_STATE.has(head)) POS[head] = pos;
  }
}

export function posOf(head: string): SymPos {
  if (DEVICE_STATE.has(head)) return "adj"; // toggle states are predicate adjectives
  if (head.startsWith("color_")) return "adj";
  return POS[head] ?? "noun"; // unknown symbols read as nouns (pool items)
}

/** Clause connectives (motive-driven-needs.md): a glyph string may join two
 *  clauses with one of these — the causal frame splits on it. */
export const CONNECTIVES = new Set(["because", "therefore", "in_order_to", "when", "until"]);

/** THE INTENT MARKER — a `.will` modifier on the verb turns a clause into a
 *  STATEMENT OF INTENT ("i_me + eat.will + apple" → "I will eat the apple").
 *  Statements of intent are always FIRST PERSON (a creature announcing what it
 *  is about to do — before acting, echoing an order, or spark-directed), so a
 *  will-marked verb with no subject reads "I …", never as an imperative. Each
 *  ruleset renders its own future/going-to periphrasis. */
export const INTENT_MOD = "will";
export const isIntentVerb = (t: Token): boolean => t.mods.includes(INTENT_MOD);

/** THE DEICTIC MARKER — a `.this` modifier on a noun names a PARTICULAR
 *  instance ("apple.this" → "this apple"): the creature is talking about the
 *  exact thing that was pointed at, not any member of the kind. Reserved as
 *  the one way of conveying specific items in both directions. */
export const DEIXIS_MOD = "this";
export const isDeicticNoun = (t: Token): boolean => t.mods.includes(DEIXIS_MOD);

/** Noun modifiers that are GRAMMAR, not descriptors — every ruleset's
 *  adjective walk must skip these (alongside "my"/"not" which are handled
 *  individually). */
export const isGrammarMod = (m: string): boolean => m === DEIXIS_MOD || m === INTENT_MOD;

/**
 * APPEARANCE-ONLY facets — variation values that change how a thing LOOKS and
 * carry no spoken word. `material_wood` is what makes a wooden ball look wooden
 * (variations.ts MATERIAL_DIMENSION: tint, roughness, metalness); it is not an
 * adjective anybody says, and it has no lexeme, so the generic fallback spelled
 * the raw glyph out — "toy material wood car".
 *
 * Colour is deliberately NOT here: "the red ball" is a thing a child says, and
 * `color_*` has both words and board art. If materials ever need saying they
 * need the same — a lexeme per language and an icon — at which point they come
 * out of this set rather than being special-cased at the call sites.
 */
export const isAppearanceMod = (m: string): boolean => isAppearanceOnlyFacet(m);

/** Every mod a ruleset's adjective walk must SKIP: grammar markers and
 *  appearance-only facets alike. */
export const isUnspokenMod = (m: string): boolean => isGrammarMod(m) || isAppearanceMod(m);

/**
 * THE CANONICAL SPOKEN HEAD. A few glyph heads are STORAGE bookkeeping rather
 * than words: an unplaced piece of furniture stacks as `furn.<kind>`, whose head
 * is the prefix `furn` and whose kind rides as a modifier — so the noun phrase
 * came out "chair furn", an adjective and a non-word in the wrong order. The
 * piece IS a chair; `furn.` is an implementation detail of how it is stored, and
 * language should never see it.
 *
 * The kind it uncovers is then spoken as the VOCABULARY's word (`fixtureWord`):
 * the sim's `chest`/`cupboard` kinds are storage bookkeeping too — the words are
 * `box` and `cabinet`, and those are the only ones the lexicons carry.
 */
export function canonicalToken(t: Token): Token {
  if (t.head === "furn" && t.mods.length) {
    const [kind, ...rest] = t.mods;
    return { ...t, head: fixtureWord(kind!), mods: rest };
  }
  return t;
}

/** Personal pronouns are never articled NPs: object position takes each
 *  language's object form ("me", clitic "te", "אותך"), subject position its
 *  subject form — a ruleset must branch BEFORE its generic noun-phrase path.
 *
 *  The COLLECTIVE pair (`we`, `they`) is the political voice (nations arc
 *  P6): a culture states who its people are ("we do not fight"), and a
 *  neighbour is spoken of as a group ("they don't give food"). They were
 *  used by shipped lines (barter-lines, law-lines) while absent from this
 *  set, so every ruleset articled them as common nouns — "The they doesn't
 *  give the food", and the raw English glyph inside Hebrew. They are
 *  PLURAL, which is what makes existing agreement machinery (en `conj`,
 *  romance `verbForm`, he plural forms) render them without new branches. */
/** The THIRD-PERSON singular pronouns (reference resolution): a creature named
 *  by pronoun rather than by species word or proper name — `he` (male), `she`
 *  (female). Gender is INHERENT to the head (semantic, language-invariant), so
 *  each ruleset renders its own gendered object/subject forms. */
export const PRONOUNS = new Set(["i_me", "you", "we", "they", "he", "she"]);
export const isPronoun = (head: string): boolean => PRONOUNS.has(head);

/** The pronouns that take PLURAL agreement ("we are", "they don't"). */
export const PLURAL_PRONOUNS = new Set(["we", "they"]);
export const isPluralPronoun = (head: string): boolean => PLURAL_PRONOUNS.has(head);

/** Every pronoun head a ruleset must map to its subject/object forms. */
export type PronounHead = "i_me" | "you" | "we" | "they" | "he" | "she";

/** Bodily-sensation adjectives: "I'm cold" is an EXPERIENTIAL construction in
 *  many languages (Hebrew dative "קר לי", Spanish "tengo frío"), not the plain
 *  predicate copula. Rendered specially in the copula frame. */
export const SENSATION = new Set(["hot", "cold"]);

/** Strip a trailing sentence terminator (for embedding a clause in a larger
 *  sentence — "I'm cold." → "I'm cold"). */
export const stripEnd = (s: string): string => s.replace(/[.?!¡¿]+\s*$/u, "").trim();

/** Is this symbol a bare QUALITY used as a want target ("something hot")? */
export function isQuality(head: string): boolean {
  return posOf(head) === "adj";
}

// ---------------------------------------------------------------------------
// Frames — the closed set of sentence shapes the dialogue layer emits
// ---------------------------------------------------------------------------

/** A noun phrase: the noun token (its mods carry descriptors/states/my) plus
 *  an optional MORE quantifier peeled off a preceding token. */
export interface NP {
  noun: Token;
  more?: boolean;
}

/** Proximity buckets for the "asking for directions" answer (computed in
 *  symbol-game/directions.ts). A bare string union so the language layer needs
 *  no geometry import — the host bridges the two. */
export type DirProximity = "here" | "there" | "street" | "close" | "far";
/** Cardinal words for the close/far direction phrases. */
export type DirCardinal = "north" | "south" | "east" | "west";

export type Frame =
  /** Single glyph — interjections, bare adjectives (speaker-agreeing). */
  | { kind: "word"; token: Token }
  /** Bare noun phrase ("apple", "ball.big", "more + apple", "cookie.my").
   *
   *  `label` = this phrase is a NAME ON A BUTTON, not an utterance: no article,
   *  in every ruleset. English and Hebrew already render level-a naming bare
   *  ("big ball", "ארון"), but the romance rulesets article it ("una caja") —
   *  correct for something being SAID, wrong for a word being READ, and it is
   *  the reading that a pocket strip and a container board do. Default false ⇒
   *  today's rendering, byte for byte. */
  | { kind: "np"; np: NP; label?: boolean }
  /** "{X} + here/there" and the there-subject clue — X is at a place. */
  | { kind: "here"; np: NP; where: "here" | "there" }
  /** "no + {X}.my" — refusing to part with a bound possession. */
  | { kind: "mine"; np: NP; no: boolean }
  /** "{X} + {ADJ}.not" / "{ADJ}.not" — the wrong-variant corrective. */
  | { kind: "corrective"; np: NP | null; adj: Token }
  /** place#question frames: "Where?" / "Where is X?" / "Where do I get X?" */
  | { kind: "where"; np?: NP; get?: boolean }
  /** "want + thing#question" / "you + want + thing#question". */
  | { kind: "what-want" }
  /** Pronoun/noun + predicative adjective ("i_me + sad", "you + ok#question").
   *  `neg` = the adjective carries `.not` ("i_me + hungry.not" → "I'm not
   *  hungry" — an honest refusal, NOT the corrective's wrong-variant sense). */
  | { kind: "copula"; subject: Token; adj: Token; neg: boolean; question: boolean }
  /** The general verb frame (want/give/have/…): S? V O? (join C)?. */
  | {
      kind: "svo";
      verb: Token;
      neg: boolean;
      subject?: Token;
      object?: NP;
      tail?: { join: string; comp: Token };
      question: boolean;
    }
  /** Trade shapes: "trade" alone is a word; "trade + X", "trade + what?",
   *  "{X} + for + {Y}" land here. */
  | { kind: "trade"; give?: NP; get?: NP; what?: boolean }
  /** Verbless prepositional fragment — the b-level of placement/on-behalf
   *  lines ("apple + in + box", "apple + to + bear"). */
  | { kind: "pp"; np: NP; join: string; comp: Token }
  /** Two clauses joined by a connective ("… because …", "… so that …"): the
   *  effect is null for a connective-led fragment ("because I'm cold"). */
  | { kind: "causal"; connective: string; effect: Frame | null; cause: Frame }
  /** The player's WHY question ("Why?" / "Why do you want something hot?"). */
  | { kind: "why"; thing?: NP }
  /** Device-state resultative want ("I want the lamp on / the window open"). */
  | { kind: "device"; subject?: Token; device: Token; state: Token; question: boolean }
  /** Want + INFINITIVE ("i_me + want + play" — "I want to play"). `neg` =
   *  want carries `.not` ("I don't want to play" — the play-command refusal). */
  | { kind: "wantTo"; verb: Token; subject?: Token; neg: boolean }
  /** Movement ("[subj +] go [+ to] + {dest}" / "[subj +] go + get + {thing}"):
   *  the where-going ANSWER and travel commands. No subject / i_me = the
   *  speaker en route ("I'm going home"); a "you" subject = the imperative
   *  ("Go home."); a noun/name = third person ("Mara is going to the market").
   *  `intent` = the go verb carried `.will` ("I will go to the market"). */
  | { kind: "going"; subject?: Token; dest?: Token; fetch?: NP; intent?: boolean }
  /** The where-going QUESTION ("place#question + [you +] go" — "Where are you
   *  going?"). */
  | { kind: "whereGoing" }
  /** The escort ask ("take + i_me + to + {dest}" — "Take me to the bear"). */
  | { kind: "takeMeTo"; dest: Token }
  /** The company ask ("[you +] stay + with + i_me" — "Stay with me"). */
  | { kind: "stayWith" }
  /** The directions answer to "where is X?" ("{thing} is far, to the north"):
   *  proximity phrasing + a cardinal word (the cardinal is spoken only by the
   *  close/far cases). Built by the host from geometry via `directionsFrame`,
   *  never by the glyph parser. */
  | { kind: "directions"; np: NP; proximity: DirProximity; cardinal: DirCardinal }
  /** Fallback: gloss token-by-token in glyph order. */
  | { kind: "gloss"; tokens: Token[] };

function npAt(tokens: Token[], i: number): NP | undefined {
  const t = tokens[i];
  if (!t) return undefined;
  if (t.head === "more") {
    const n = tokens[i + 1];
    return n ? { noun: n, more: true } : undefined;
  }
  return { noun: t };
}

/** How many tokens an NP starting at `i` consumes. */
function npLen(tokens: Token[], i: number): number {
  return tokens[i]?.head === "more" ? 2 : 1;
}

export function classify(tokens: Token[]): Frame {
  const question = tokens.some((t) => t.q);
  if (tokens.length === 0) return { kind: "gloss", tokens };

  const t0 = tokens[0]!;

  // The builder's LEXICON spells the where-question "where" ("where + mara",
  // "where + you + go"); the registry spells it "place#question". Alias the
  // leading form so both classify identically.
  if (t0.head === "where") {
    return classify([{ head: "place", mods: t0.mods, q: true }, ...tokens.slice(1)]);
  }

  // -- WHY question ("why", "why + hot", "why + you + want + hot") -------------
  if (t0.head === "why") {
    if (tokens.length === 1) return { kind: "why" };
    const wi = tokens.findIndex((t) => t.head === "want");
    const thing = wi >= 0 ? npAt(tokens, wi + 1) : npAt(tokens, 1);
    return thing ? { kind: "why", thing } : { kind: "why" };
  }

  // -- causal two-clause (…because…, …in_order_to…, …therefore…) --------------
  // Split on the FIRST connective; each side is classified independently, so
  // the causal renderer never touches the puzzle generator — it only re-reads
  // the two clauses' own glyphs.
  const ci = tokens.findIndex((t) => CONNECTIVES.has(t.head));
  if (ci >= 0) {
    const before = tokens.slice(0, ci);
    const after = tokens.slice(ci + 1);
    return {
      kind: "causal",
      connective: tokens[ci]!.head,
      effect: before.length ? classify(before) : null,
      cause: classify(after),
    };
  }

  // -- device-state want ("… want {device} {on|off|open|closed}") -------------
  // A trailing toggle state is a resultative complement, not the object; the
  // bare "{device} + {state}" case falls through to the copula frame below.
  if (DEVICE_STATE.has(tokens[tokens.length - 1]!.head)) {
    const wi = tokens.findIndex((t) => t.head === "want");
    if (wi >= 0 && wi === tokens.length - 3) {
      const subject = wi > 0 ? tokens[0] : undefined;
      return {
        kind: "device",
        ...(subject ? { subject } : {}),
        device: tokens[tokens.length - 2]!,
        state: tokens[tokens.length - 1]!,
        question,
      };
    }
  }

  // -- question-word frames ---------------------------------------------------
  if (t0.head === "place" && t0.q) {
    if (tokens.length === 1) return { kind: "where" };
    // "place#question + [you +] go" — the where-GOING ask ("Where are you going?").
    if (tokens.length <= 3 && tokens[tokens.length - 1]!.head === "go") return { kind: "whereGoing" };
    if (tokens[1]!.head === "get" && tokens[2]) return { kind: "where", np: npAt(tokens, 2), get: true };
    return { kind: "where", np: npAt(tokens, 1) };
  }
  // A bare QUESTIONED noun ("cookie#question" — the single-glyph where-ask):
  // the thing is the focus, the question mark asks where it is.
  if (tokens.length === 1 && t0.q && posOf(t0.head) === "noun" && t0.head !== "thing" && t0.head !== "place") {
    return { kind: "where", np: { noun: t0 } };
  }
  if (tokens.some((t) => t.head === "thing" && t.q) && tokens.some((t) => t.head === "want")) {
    return { kind: "what-want" };
  }

  // -- trade shapes -------------------------------------------------------------
  if (t0.head === "trade" && tokens.length === 2) {
    const t1 = tokens[1]!;
    if (t1.head === "thing" && t1.q) return { kind: "trade", what: true };
    return { kind: "trade", get: { noun: t1 } };
  }
  if (tokens.length === 3 && tokens[1]!.head === "for" && posOf(t0.head) === "noun") {
    return { kind: "trade", give: { noun: t0 }, get: { noun: tokens[2]! } };
  }
  if (tokens.length === 3 && posOf(tokens[1]!.head) === "prep" && posOf(t0.head) === "noun") {
    return { kind: "pp", np: { noun: t0 }, join: tokens[1]!.head, comp: tokens[2]! };
  }

  // -- want + INFINITIVE ("[i_me +] want + play") -----------------------------
  // Must run before the general verb frame — npAt would read the verb as a
  // noun object ("I want a play").
  {
    const wi = tokens.findIndex((t) => t.head === "want");
    if (
      wi >= 0 &&
      wi <= 1 &&
      wi + 2 === tokens.length &&
      posOf(tokens[wi + 1]!.head) === "verb"
    ) {
      return {
        kind: "wantTo",
        verb: tokens[wi + 1]!,
        neg: tokens[wi]!.mods.includes("not"),
        ...(wi === 1 ? { subject: tokens[0] } : {}),
      };
    }
  }

  // -- stay-with ("[you +] stay + with + i_me") --------------------------------
  {
    const si = tokens.findIndex((t) => t.head === "stay");
    if (
      si >= 0 &&
      si <= 1 &&
      tokens.length === si + 3 &&
      tokens[si + 1]!.head === "with" &&
      tokens[si + 2]!.head === "i_me"
    ) {
      return { kind: "stayWith" };
    }
  }

  // -- movement ("[subj +] go [+ to] + {dest}" / "go + get + {thing}") --------
  // Its own construction — progressive/imperative per language, never the
  // generic SVO ("I'm going home", "Go home.", "Voy a casa", "אני הולך הביתה").
  {
    const gi = tokens.findIndex((t) => t.head === "go");
    if (gi >= 0 && gi <= 1 && !tokens[gi]!.mods.includes("not")) {
      const subject = gi === 1 ? tokens[0] : undefined;
      const intent = isIntentVerb(tokens[gi]!);
      if (!subject || posOf(subject.head) !== "verb") {
        const rest = tokens.slice(gi + 1).filter((t) => t.head !== "to");
        if (rest.length === 1 && rest[0]!.head !== "get") {
          return { kind: "going", ...(subject ? { subject } : {}), dest: rest[0]!, ...(intent ? { intent } : {}) };
        }
        if (rest.length === 2 && rest[0]!.head === "get") {
          return {
            kind: "going",
            ...(subject ? { subject } : {}),
            fetch: { noun: rest[1]! },
            ...(intent ? { intent } : {}),
          };
        }
      }
    }
  }

  // -- verb frames ----------------------------------------------------------
  const vi = tokens.findIndex((t) => posOf(t.head) === "verb" && t.head !== "trade");
  if (vi >= 0) {
    if (vi > 1) return { kind: "gloss", tokens };
    const verb = tokens[vi]!;
    const subject = vi === 1 ? tokens[0] : undefined;
    // A "there" subject is the unknown-holder clue — render as a locative.
    if (subject?.head === "there") {
      const obj = npAt(tokens, vi + 1);
      if (obj) return { kind: "here", np: obj, where: "there" };
    }
    let i = vi + 1;
    const object = npAt(tokens, i);
    if (object) i += npLen(tokens, i);
    let tail: { join: string; comp: Token } | undefined;
    if (tokens[i] && posOf(tokens[i]!.head) === "prep" && tokens[i + 1]) {
      tail = { join: tokens[i]!.head, comp: tokens[i + 1]! };
      i += 2;
    }
    if (i !== tokens.length) return { kind: "gloss", tokens };
    // The escort ask ("take + i_me + to + {dest}") is its own construction —
    // pronoun object + directional tail ("Take me to the bear").
    if (verb.head === "take" && object?.noun.head === "i_me" && tail?.join === "to") {
      return { kind: "takeMeTo", dest: tail.comp };
    }
    return {
      kind: "svo",
      verb,
      neg: verb.mods.includes("not"),
      ...(subject ? { subject } : {}),
      ...(object ? { object } : {}),
      ...(tail ? { tail } : {}),
      question,
    };
  }

  // -- verbless shapes --------------------------------------------------------
  if (tokens.length === 1) {
    const pos = posOf(t0.head);
    if (pos === "adj" && t0.mods.includes("not")) return { kind: "corrective", np: null, adj: t0 };
    if (pos === "noun") return { kind: "np", np: { noun: t0 } };
    return { kind: "word", token: t0 };
  }
  if (tokens.length === 2) {
    const t1 = tokens[1]!;
    if (t0.head === "no" && t1.mods.includes("my")) return { kind: "mine", np: { noun: t1 }, no: true };
    if (t1.head === "here" || t1.head === "there") {
      return { kind: "here", np: { noun: t0 }, where: t1.head };
    }
    if (posOf(t1.head) === "adj" && t1.mods.includes("not") && posOf(t0.head) === "noun") {
      return { kind: "corrective", np: { noun: t0 }, adj: t1 };
    }
    // A pronoun OR a noun subject + a predicate adjective: "I'm sad", "the bear
    // is happy" (a creature-state cause), "the window is open".
    if ((posOf(t0.head) === "pron" || posOf(t0.head) === "noun") && posOf(t1.head) === "adj") {
      return { kind: "copula", subject: t0, adj: t1, neg: t1.mods.includes("not"), question };
    }
    if (t0.head === "more") {
      const np = npAt(tokens, 0);
      if (np) return { kind: "np", np };
    }
    if (t0.head === "no") {
      // "no + {X}" (a general decline naming the thing) — gloss reads fine.
      return { kind: "gloss", tokens };
    }
  }
  return { kind: "gloss", tokens };
}

// ---------------------------------------------------------------------------
// Language interface
// ---------------------------------------------------------------------------

export type Gender = "m" | "f";

export interface SpeakOpts {
  /** Grammatical gender of the SPEAKER (the creature saying "i_me …"). */
  speaker?: Gender;
  /** Grammatical gender of the ADDRESSEE (the player — "you …", imperatives). */
  addressee?: Gender;
  /**
   * Subject-less sentences read FIRST PERSON, not as requests: the same glyph
   * "give + ball" is the NPC's ask ("Give me the ball.") but the PLAYER's
   * offer ("I'll give you the ball."). Set for board options / player speech.
   */
  firstPerson?: boolean;
  /**
   * PROPER NOUNS in the sentence (family member / pet names) → their natural
   * gender. A name never takes an article or a definite ה, reads capitalized
   * in Latin scripts, and agrees by ITS OWN gender ("מרה רעבה"), not the
   * lexicon's. The host supplies the map (names + genderFor).
   */
  names?: ReadonlyMap<string, Gender>;
  /**
   * ⑫ — THE LEADING NAME IN THIS SENTENCE IS AN ADDRESS, not a subject.
   *
   * 🚨 THE LANGUAGE LAYER MAY NOT GUESS THIS, and the reason is one sentence:
   * "mara + go + to + market" is *Mara is going to the market*, while
   * "mara + i_me + want + apple" is *Mara, I want an apple* — identical shapes,
   * opposite readings, and nothing in the glyph tells them apart. Only the
   * SPEAKER knows which they meant; upstream, the parser knows because it has
   * the conversation roster (law ②'s name channel), and it passes the answer
   * down here. Inferring it from "the first token is a name" silently rewrote
   * every third-person sentence about a named creature — caught by the existing
   * going-frame test, which is exactly what that test is for.
   *
   * Default false ⇒ today's rendering, byte for byte.
   */
  vocative?: boolean;
}

/** The empty name book (default — no proper nouns in play). */
export const NO_NAMES: ReadonlyMap<string, Gender> = new Map();

/**
 * One word's grammar card. `w` is the base surface form (noun singular / verb
 * base-or-1sg / adjective masculine-singular); the rest are agreement and
 * conjugation overrides each language reads as it needs.
 */
export interface Lexeme {
  w: string;
  /** Noun gender (agreement languages). */
  g?: Gender;
  /** Lexically plural noun (blocks, bubbles, sparks). */
  pl?: boolean;
  /** Mass noun — no indefinite article, no MORE-pluralization (broccoli). */
  mass?: boolean;
  /** Verb person forms: 2nd sg, 3rd sg, 3rd pl (conjugating languages).
   *  `w` carries the 1st-SINGULAR form in the romance rulesets. */
  v2?: string;
  v3?: string;
  v3p?: string;
  /** 1st-person PLURAL ("we trade" — es "cambiamos", pt "trocamos"). The
   *  collective voice (nations P6) is the only frame that reaches it. */
  v1p?: string;
  /** Hebrew present tense agrees in gender AND number: the plural pair
   *  beside the singular `w` (m) / `f`. */
  vmpl?: string;
  vfpl?: string;
  /** Feminine form (Hebrew present-tense verbs / gendered adjectives). */
  f?: string;
  /** Plural adjective overrides where the regular suffix rule fails. */
  mpl?: string;
  fpl?: string;
  /** Noun plural override where the regular rule fails. */
  plw?: string;
  /** Infinitive (want-to frame: "I want to play" — he "לשחק", es "jugar"). */
  inf?: string;
  /** DEFINITE-form override (Hebrew construct nouns: "כלי נגינה" → "כלי הנגינה"
   *  — the ה lands inside the compound, not on the first word). */
  defw?: string;
  /** A VERB governing a preposition on its object ("of": pt "precisar DE" —
   *  the ruleset contracts it with the article, "preciso do banheiro";
   *  "to": he "לעזור ל־" — help takes a dative object, "אני עוזר לך"). */
  objPrep?: "of" | "to";
}

export interface GlyphLanguage {
  /** BCP-47 primary subtag ("en", "he"). */
  id: string;
  lexicon: Record<string, Lexeme>;
  /** Whole-sentence overrides, keyed by normalize(tokens). Wins over frames. */
  fixed: Record<string, string | ((opts: Required<SpeakOpts>) => string)>;
  render(frame: Frame, opts: Required<SpeakOpts>): string;
}

/** Base word for a symbol, for glosses and simple slots. */
export function baseWord(lang: GlyphLanguage, head: string): string {
  return lang.lexicon[head]?.w ?? head.replace(/^color_/, "").replace(/_/g, " ");
}

/**
 * 🏷️ THE NAME ONE THING WEARS — a single glyph as a button's worth of text in
 * the ruleset's own grammar: agreement and adjective order intact, no article,
 * no full stop ("red chair", "silla roja", "כיסא אדום").
 *
 * Separate from `translateWith` because a LABEL IS NOT AN UTTERANCE. The same
 * glyph spoken is a sentence and gets sentence dress; read off a strip it is a
 * word, and "Una caja." on a button is not a word. Every path that shows a
 * thing's name — the pocket strip, an open container's contents, the word a
 * fixture answers to — comes here, so those names are the player's language
 * rather than the (English) glyph keys they are stored under.
 *
 * More than one token means it isn't a name: the whole string is translated as
 * the sentence it is, so a caller can pass either without checking.
 */
export function labelWith(lang: GlyphLanguage, glyph: string, opts?: SpeakOpts): string {
  const tokens = parseSentence(glyph);
  const noun = tokens[0];
  if (!noun || tokens.length !== 1 || posOf(noun.head) !== "noun") {
    return translateWith(lang, glyph, opts);
  }
  return lang.render({ kind: "np", np: { noun }, label: true }, {
    speaker: opts?.speaker ?? "m",
    addressee: opts?.addressee ?? "m",
    firstPerson: opts?.firstPerson ?? false,
    names: opts?.names ?? NO_NAMES,
    vocative: false, // a name on a button addresses nobody
  });
}

/** The shared fallback: lexicon words in glyph order (negations lead; the
 *  grammar markers `.will`/`.this` are dropped — a gloss is telegraphic, and
 *  "ball this"/"eat will" would be worse than saying nothing extra). */
export function gloss(lang: GlyphLanguage, tokens: Token[], notWord: string): string {
  return tokens
    .map((t) => {
      const leads = t.mods.filter((m) => m === "not").map(() => notWord);
      const rest = t.mods.filter((m) => m !== "not" && !isUnspokenMod(m)).map((m) => baseWord(lang, m));
      return [...leads, baseWord(lang, t.head), ...rest].join(" ");
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Does a string LOOK like a glyph sentence (symbol tokens joined by `+`)?
 *  Plain prose (a quest prompt, a canned line) must pass through untouched —
 *  tokenizing it on `.`/`+` would mangle it. */
const GLYPH_SENTENCE = /^[A-Za-z0-9_.#]+(\s*\+\s*[A-Za-z0-9_.#]+)*$/;

/**
 * Translate one glyph SENTENCE into `locale`'s proper text.
 * The main entry point — the player calls this at speak time.
 * Non-glyph input (plain prose) is returned unchanged.
 */
/**
 * MANNER WORDS — adverbials that modify HOW a clause happens without filling
 * any of its roles. They are peeled off before classification and appended
 * after rendering, which is why no ruleset needs a case for them: every frame
 * shape, in every language, gets manner for free.
 *
 * ⚠️ A manner word must NEVER ride as a `.modifier` on the verb. `sleep.not
 * .together` renders as "We don't sleep" — the marker is silently dropped and
 * the sentence becomes FALSE (they do sleep; they don't sleep together). A
 * dropped manner is worse than an ugly one, so it stays a separate token.
 *
 * Deliberately one member. Manner is where a lexicon starts collecting
 * everything that isn't a noun or a verb; each new entry should be argued for.
 */
const MANNER_WORDS: ReadonlySet<string> = new Set(["together"]);

/** Put the manner word in before any terminal punctuation ("We don't sleep" +
 *  "together" → "We don't sleep together."). Trailing-punctuation-safe so it
 *  works over every ruleset's own sentence endings, question marks included. */
function appendManner(lang: GlyphLanguage, text: string, manner: Token): string {
  const word = lang.lexicon[manner.head]?.w ?? manner.head;
  const m = /^([\s\S]*?)([.!?]*)$/.exec(text);
  if (!m) return `${text} ${word}`;
  return `${m[1]} ${word}${m[2]}`;
}

/**
 * ⑫ — DIRECT ADDRESS ("Mara, I want an apple").
 *
 * A vocative is not a sentence SHAPE, it is a name set in front of one — which
 * is why it is peeled here, in the one place every ruleset passes through,
 * instead of becoming a `Frame` variant that all four would have to learn. Every
 * language in the set punctuates it the same way (a comma after the name), so
 * one rule serves them all; a ruleset that ever needs its own can override by
 * reading the token itself.
 *
 * WHY THIS EXISTS AT ALL: it is the NAME channel of law ② — the only way to say
 * whom you mean when your hands are full and your body faces the wrong way. If
 * this did not render properly the channel would emit glyph soup ("Mara I want
 * apple"), which `host-lines.ts` rightly calls worse than the thing it replaces.
 *
 * A leading name is only a vocative when something FOLLOWS it — a bare "mara"
 * is a greeting (naming somebody is already addressing them, ⑥) and renders as
 * the name, unchanged.
 */
function peelVocative(
  lang: GlyphLanguage,
  tokens: Token[],
  names: ReadonlyMap<string, Gender>,
  marked: boolean,
): string | undefined {
  if (!marked) return undefined; // 🚨 never inferred — see SpeakOpts.vocative
  if (tokens.length < 2) return undefined; // a bare name is a greeting, not an address
  const head = tokens[0]!.head;
  if (!names.has(head)) return undefined; // only a PROPER NAME addresses
  tokens.shift();
  const w = lang.lexicon[head]?.w ?? head;
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export function translateWith(lang: GlyphLanguage, glyph: string, opts?: SpeakOpts): string {
  if (!GLYPH_SENTENCE.test(glyph.trim())) return glyph;
  const tokens = parseSentence(glyph);
  // Peel a TRAILING manner word — never the only token, so a bare "together"
  // still renders as itself.
  const manner = tokens.length > 1 && MANNER_WORDS.has(tokens[tokens.length - 1]!.head) ? tokens.pop() : undefined;
  const full: Required<SpeakOpts> = {
    speaker: opts?.speaker ?? "m",
    addressee: opts?.addressee ?? "m",
    firstPerson: opts?.firstPerson ?? false,
    names: opts?.names ?? NO_NAMES,
    vocative: opts?.vocative ?? false,
  };
  // ⑫ — peel a LEADING vocative before the frame is classified, so the clause
  // behind it is the ordinary sentence it would have been on its own.
  const vocative = peelVocative(lang, tokens, full.names, full.vocative);
  const hit = lang.fixed[normalize(tokens)];
  const clause = hit !== undefined
    ? (typeof hit === "function" ? hit(full) : hit)
    : lang.render(classify(tokens), full);
  const spoken = manner ? appendManner(lang, clause, manner) : clause;
  return vocative ? `${vocative}, ${lowerFirstWord(spoken, full.names)}` : spoken;
}

/** After "Mara, " the clause continues mid-sentence, so its opening capital is
 *  wrong. Needs no per-language flag: lowercasing is a no-op in a script without
 *  case, so Hebrew passes through untouched by the same line that fixes English.
 *  Left alone for "I" and for a proper noun, which keep their capitals wherever
 *  they stand ("Mara, Papa is hungry"). */
function lowerFirstWord(text: string, names: ReadonlyMap<string, Gender>): string {
  const first = /^([^\s,.!?]+)/.exec(text)?.[1] ?? "";
  if (!first) return text;
  if (first === "I" || first.startsWith("I'")) return text;
  if (names.has(first.toLowerCase())) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Grammatical gender a language assigns to a creature symbol (for `speaker`). */
export function genderOf(lang: GlyphLanguage, symbol: string | undefined): Gender {
  if (!symbol) return "m";
  return lang.lexicon[parseToken(symbol).head]?.g ?? "m";
}

/** Build a `directions` frame from a thing GLYPH ("home.color_blue", "toy") plus
 *  the resolved proximity + cardinal. The host's bridge from directions.ts
 *  geometry into the language layer — the answer is not a glyph sentence, so it
 *  never round-trips through `classify`. */
export function directionsFrame(
  thingGlyph: string,
  proximity: DirProximity,
  cardinal: DirCardinal,
): Frame {
  const tokens = parseSentence(thingGlyph);
  const noun: Token = tokens[0] ?? { head: thingGlyph, mods: [], q: false };
  return { kind: "directions", np: { noun }, proximity, cardinal };
}
