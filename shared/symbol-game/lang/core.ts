// shared/symbol-game/lang/core.ts
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
  trade: "verb",
};

export function posOf(head: string): SymPos {
  if (head.startsWith("color_")) return "adj";
  return POS[head] ?? "noun"; // unknown symbols read as nouns (pool items)
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

export type Frame =
  /** Single glyph — interjections, bare adjectives (speaker-agreeing). */
  | { kind: "word"; token: Token }
  /** Bare noun phrase ("apple", "ball.big", "more + apple", "cookie.my"). */
  | { kind: "np"; np: NP }
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
  /** Pronoun/noun + predicative adjective ("i_me + sad", "you + ok#question"). */
  | { kind: "copula"; subject: Token; adj: Token; question: boolean }
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

  // -- question-word frames ---------------------------------------------------
  const t0 = tokens[0]!;
  if (t0.head === "place" && t0.q) {
    if (tokens.length === 1) return { kind: "where" };
    if (tokens[1]!.head === "get" && tokens[2]) return { kind: "where", np: npAt(tokens, 2), get: true };
    return { kind: "where", np: npAt(tokens, 1) };
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
    if (posOf(t0.head) === "pron" && posOf(t1.head) === "adj") {
      return { kind: "copula", subject: t0, adj: t1, question };
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
}

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
  /** Verb person forms: 2nd sg, 3rd sg, 3rd pl (conjugating languages). */
  v2?: string;
  v3?: string;
  v3p?: string;
  /** Feminine form (Hebrew present-tense verbs / gendered adjectives). */
  f?: string;
  /** Plural adjective overrides where the regular suffix rule fails. */
  mpl?: string;
  fpl?: string;
  /** Noun plural override where the regular rule fails. */
  plw?: string;
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

/** The shared fallback: lexicon words in glyph order (negations lead). */
export function gloss(lang: GlyphLanguage, tokens: Token[], notWord: string): string {
  return tokens
    .map((t) => {
      const leads = t.mods.filter((m) => m === "not").map(() => notWord);
      const rest = t.mods.filter((m) => m !== "not").map((m) => baseWord(lang, m));
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
export function translateWith(lang: GlyphLanguage, glyph: string, opts?: SpeakOpts): string {
  if (!GLYPH_SENTENCE.test(glyph.trim())) return glyph;
  const tokens = parseSentence(glyph);
  const full: Required<SpeakOpts> = {
    speaker: opts?.speaker ?? "m",
    addressee: opts?.addressee ?? "m",
    firstPerson: opts?.firstPerson ?? false,
  };
  const hit = lang.fixed[normalize(tokens)];
  if (hit !== undefined) return typeof hit === "function" ? hit(full) : hit;
  return lang.render(classify(tokens), full);
}

/** Grammatical gender a language assigns to a creature symbol (for `speaker`). */
export function genderOf(lang: GlyphLanguage, symbol: string | undefined): Gender {
  if (!symbol) return "m";
  return lang.lexicon[parseToken(symbol).head]?.g ?? "m";
}
