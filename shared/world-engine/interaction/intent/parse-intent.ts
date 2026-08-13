// shared/world-engine/interaction/intent/parse-intent.ts
//
// The CONCEPT PARSER (concept-parser.md) — turns a built AAC glyph SENTENCE into an
// Intent Frame the game reacts to, with NO LLM. It is a slot-filling frame extractor,
// not a grammar: roles are assigned by DEIXIS and RELATION markers, not word order, so
// vague / out-of-order utterances still parse ("ball want i_me" == "i_me want ball").
//
// NOT just orders. Commands and standing rules are ONE branch; the parser covers the
// whole conversational surface — greetings, yes/no, thanks, questions, statements of
// need / feeling / knowledge, offers, requests. `IntentKind` enumerates the moves; the
// creature dialogue layer (projectDialogue) consumes them the same way it emits lines.
//
// PURE + standalone (no world imports). Referents are emitted as LAZY `Ref`s
// (`player`/`listener`/`gaze`/`entity`/…) — resolving a gaze/entity to a concrete
// world id is the world layer's job (salience: gaze > selection > nearest > name).
// The one place world knowledge helps is picking a default verb for a VERBLESS noun
// (a place ⇒ go, an item ⇒ want) — supplied by an optional `classifyEntity` hook.

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** The communicative MOVE. Social acts + the four sentence shapes (ask/state/
 *  request/offer/command) + the two structural forms (rule/sequence). */
export type IntentKind =
  | "greet" | "farewell" | "affirm" | "decline" | "acknowledge"
  | "thank" | "apologize" | "claim" | "again" | "unclear" // social acts
  | "ask" // a question (query the world / the listener)
  | "state" // a declarative: a need, a feeling, a fact ("i_me want", "i_me sad", "ball here")
  | "request" // want / give-me X
  | "offer" // I give / here is X
  | "command" // an imperative to the listener
  | "rule" // a conditional standing command (when/if/until)
  | "forbid" // a standing prohibition ("no + fight" — a LAW, laws.ts)
  | "sequence"; // multiple clauses (and/then/but/or)

export type QuestionWord = "where" | "what" | "who" | "when" | "why" | "how";

/** A lazily-resolved referent — the world binds gaze/entity to a concrete id. */
export type Ref =
  | { kind: "player" } // i_me — the speaker
  | { kind: "listener" } // you — the addressed creature
  | { kind: "companions" } // we / us
  | { kind: "group"; role?: string } // they / a named role
  | { kind: "gaze"; of: "entity" | "point" } // this/that → entity, here/there → ground point
  | { kind: "entity"; symbol: string; modifiers: string[] } // a named noun ("ball", "ball" + "big")
  | { kind: "unresolved"; symbol: string };

/** Rule lifetime, from the condition connective (when→while, if→edge, until→until). */
export type IntentLifetime = "while" | "edge" | "until";

export interface IntentFrame {
  kind: IntentKind;
  /** Canonical verb id, when the utterance has one. */
  verb?: string;
  /** A `.not` on the verb ("have.not", "give.not"). */
  negated?: boolean;
  /** PHASE operator over `verb` ("stop + eat" — cease the activity, never a
   *  command to do it). Bare "stop" stays a plain stop command. */
  phase?: "stop";
  /** MODAL desire wrapping `verb` ("want + play" — a wish to DO it, not an
   *  order to do it; "i_me want go home" — a wish to go). */
  modal?: "want" | "need" | "like";
  /** JOINTNESS — the participants do this as ONE act, not side by side ("eat
   *  TOGETHER", "eat WITH me", "WE eat"). Never a verb and never an action of
   *  its own: it marks an ordinary activity frame as shared, and the layer
   *  below routes it through the company machinery instead of the solo one.
   *
   *  Set by the explicit `together` marker, and INFERRED (so a child who only
   *  has `with` still means it) from a `companions` subject or a `with`-marked
   *  ANIMATE companion. A `with` naming a place or a thing — "trade wood with
   *  the city" — is not company and never sets this. */
  joint?: boolean;
  subject?: Ref;
  object?: Ref;
  /** VOCATIVE — WHOM the utterance is addressed to ("hi + mara": the greeting
   *  goes TO Mara). Neither a subject nor an object: Mara is not doing the
   *  greeting and nothing is being done to her, she is the one being spoken
   *  to. Only an ADDRESSING social act (greet/farewell) that names an animate
   *  binds one — a creature-classified noun, or the deictic "you" — and it is
   *  order-free like every other role ("hi + mara" == "mara + hi"). Lazy like
   *  every other `Ref`: resolving it to a concrete creature id is the world's
   *  job, and saying a name is the most deliberate act of addressing there is,
   *  so it outranks the rest of the addressee stack. */
  vocative?: Ref;
  /** Recipient / destination / located-at, when a relation binds one. */
  target?: Ref;
  /** The relation that bound `target` ("to", "in", "with"…). */
  relation?: string;
  /** EVERY explicitly relation-marked noun, in spoken order — `target` keeps
   *  the LAST one (compat), but a two-argument frame ("trade wood FOR food
   *  WITH city") loses nothing: each marked pair is here. Present only when
   *  a relation bound at least one noun. */
  bound?: Array<{ relation: string; ref: Ref }>;
  /** Predicate adjectives / leftover attribute symbols ("sad", "big"). */
  modifiers: string[];
  quantity?: string;
  question?: QuestionWord;
  /** A yes/no question (the `#question` operator with no wh-word). */
  polar?: boolean;
  tense?: "past" | "present" | "future";
  // structural:
  /** For `rule`: the connective + its lifetime + the trigger clause. */
  connective?: string;
  lifetime?: IntentLifetime;
  condition?: IntentFrame;
  /** For `sequence`: the clauses in order. */
  clauses?: IntentFrame[];
  /** Word-order conformance vs. the target language — a teaching signal, not a gate
   *  (drives mild NPC confusion). Present when ≥2 core roles were explicitly placed. */
  order?: OrderConformance;
  /** Original glyph tokens, for the echo bubble / debugging. */
  raw: string[];
}

/** A language's canonical constituent order. The shipped glyph set is SVO; a future
 *  SOV locale (Korean/Japanese) sets it here. */
export type WordOrder = "svo" | "sov" | "vso" | "vos" | "osv" | "ovs";

type OrderRole = "subject" | "verb" | "object";

/**
 * How well an utterance's word order matches the target language — a TEACHING signal,
 * not a gate. The parser understands the intent regardless (roles come from deixis +
 * semantics); this measures how close the child got to the canonical order so an NPC
 * can show mild, errorless CONFUSION proportional to `confusion` and model the right
 * order back — the inbound mirror of the CONFUSED syntax-drop.
 */
export interface OrderConformance {
  /** 1 = matches the target order, 0 = fully reversed. Only EXPLICITLY-placed roles
   *  count (an unspoken/implied subject can't be "misordered"). ≥2 roles needed. */
  score: number;
  /** 1 − score — the NPC's mild-confusion cue. */
  confusion: number;
  target: WordOrder;
  /** The placed roles in the order they were spoken. */
  actual: OrderRole[];
}

export interface ParseContext {
  mode?: "adventure" | "building";
  /** Classify a fringe noun so a VERBLESS utterance can pick a default verb.
   *  Absent ⇒ a bare noun stays a `state` (a mention), leaving the verb to the world. */
  classifyEntity?: (symbol: string) => "place" | "item" | "creature" | "unknown";
  /**
   * ⑫ — THE ROSTER: the fellow members of the speaker's own conversation, as
   * spoken symbols. Absent or empty ⇒ every rule below falls back to today's
   * reading, byte-identical.
   *
   * It answers the ONE question syntax cannot: naming somebody is *talking to*
   * them if they are standing in the conversation, and *talking about* them if
   * they are not. "Mara, give me the apple" and "Mara gives the apple" are the
   * same words; only the roster tells them apart — which is why a position rule
   * or a special operator could never have done this job.
   * (conversation-in-motion.md law ②, the NAME channel.)
   */
  addressees?: readonly string[];
  /** The designated language's canonical word order, for the conformance score
   *  (concept-parser.md). Defaults to "svo" (the shipped glyph order). */
  wordOrder?: WordOrder;
}

const ORDER_ROLES: Record<WordOrder, OrderRole[]> = {
  svo: ["subject", "verb", "object"],
  sov: ["subject", "object", "verb"],
  vso: ["verb", "subject", "object"],
  vos: ["verb", "object", "subject"],
  osv: ["object", "subject", "verb"],
  ovs: ["object", "verb", "subject"],
};

/** Score placed roles against the target order via pairwise concordance (a
 *  normalized Kendall-τ): the fraction of role pairs whose spoken order matches the
 *  language's expected relative order. <2 placed roles ⇒ nothing to get wrong (1). */
function scoreOrder(placed: { role: OrderRole; index: number }[], target: WordOrder): OrderConformance {
  const rank = new Map(ORDER_ROLES[target].map((r, i) => [r, i] as const));
  let concordant = 0;
  let total = 0;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!;
      const b = placed[j]!;
      total++;
      if (rank.get(a.role)! < rank.get(b.role)! === a.index < b.index) concordant++;
    }
  }
  const score = total === 0 ? 1 : concordant / total;
  return {
    score,
    confusion: 1 - score,
    target,
    actual: placed.slice().sort((x, y) => x.index - y.index).map((p) => p.role),
  };
}

// ---------------------------------------------------------------------------
// Lexicon (the vocabulary, as data)
// ---------------------------------------------------------------------------

type Deixis = "player" | "listener" | "companions" | "group" | "gazeEntity" | "gazePoint";
type ConnRole = "sequence" | "condition" | "causal";

type Lex =
  | { cat: "person"; deixis: Deixis }
  | { cat: "verb"; verb: string; directive: boolean; transfer: boolean; implied?: ImpliedRel }
  | { cat: "question"; q: QuestionWord }
  | { cat: "connective"; conn: string; role: ConnRole }
  | { cat: "relation"; rel: string }
  | { cat: "social"; act: IntentKind }
  | { cat: "quantity"; q: string }
  | { cat: "attribute" }
  /** MANNER — how the act is performed, binding no noun. Deliberately a
   *  one-member category (`together`): manner words are where a lexicon starts
   *  collecting everything that isn't a verb or a noun, so it stays narrow
   *  until a second word genuinely earns it. */
  | { cat: "manner"; manner: "joint" };

/** A verb's ARGUMENT FRAME: the relation its bare second argument fills when
 *  no preposition was composed. "give apple mara" reads mara as the RECIPIENT
 *  (implied "to"); "throw apple bin" reads bin as the DESTINATION (implied
 *  "in"); "take ball dog" reads dog as the SOURCE (implied "from") — general
 *  semantics, not per-utterance special cases. AAC composers routinely drop
 *  function words; the frame recovers the role. */
type ImpliedRel = "to" | "in" | "from";

const V = (verb: string, directive = false, transfer = false, implied?: ImpliedRel): Lex => ({
  cat: "verb",
  verb,
  directive,
  transfer,
  ...(implied ? { implied } : {}),
});

/** Speaker-oriented STATE verbs: their subject is the speaker by default and any
 *  entity is the OBJECT, so "apple want" reads "[I] want apple", never "apple wants".
 *  (Semantic override of pure position — matches "apple me eat" = I eat the apple.) */
export const STATE_VERBS = new Set(["want", "need", "have", "like", "feel"]);

/** GOAL-directed movement verbs: a person/place after them is the DESTINATION, not
 *  the subject — "come i_me" = "[you] come to me", "follow i_me" = "follow me". */
const MOVEMENT_GOAL_VERBS = new Set(["go", "come", "walk", "follow", "run", "chase"]);

/** Verb COMPOSITION classes (semantic-tests.md §Commands): several verb tokens
 *  in one clause COMPOSE — they never silently last-win. A MODAL wraps the
 *  other verb as a desire ("want + play" = a wish to play); a MOTION AUXILIARY
 *  is redundant beside another action ("go + wash + clothes" = wash them, the
 *  going is implied); "stop" is a PHASE operator on the other action
 *  ("stop + eat" = cease eating — never a command to eat). */
// Exported for the surfacer: after a BARE desire verb the board must offer
// DOING as readily as having (the modal action path) — one set, two readers.
export const MODAL_VERBS = new Set(["want", "need", "like"]);
const MOTION_AUX = new Set(["go", "come"]);

/** ADDRESSING social acts: the moves that open and close a conversation, and
 *  the only ones where a named creature beside them is a VOCATIVE rather than a
 *  participant. Deliberately just these two — "yes + mara" or "sorry + mara"
 *  mean other things (an answer about Mara, an apology for her), so they keep
 *  today's shape until they earn a rule of their own. */
const ADDRESSING_ACTS = new Set<IntentKind>(["greet", "farewell"]);

/** SYNONYM FAMILIES: words that name the SAME primitive (they compile to the
 *  same GoalSpec) reduce to one canonical head, so a premise check never denies
 *  "are you taking?" at a creature that reported "get", and cross-language
 *  vocabularies may collapse a family to one word without changing semantics.
 *  This is the merge seam for overly-specific near-synonyms (get/take,
 *  give/bring, go/walk/run) — the engine already treats them as one. */
export const VERB_FAMILY: Record<string, string> = {
  take: "get", pick_up: "get",
  bring: "give",
  come: "go", walk: "go", run: "go",
  chase: "follow",
  wait: "stay",
};

/** A verb's canonical family head ("take" → "get"); unknown verbs pass through. */
export const canonicalVerb = (v: string): string => VERB_FAMILY[v] ?? v;

export const LEXICON: Record<string, Lex> = {
  // People / deixis
  i_me: { cat: "person", deixis: "player" },
  you: { cat: "person", deixis: "listener" },
  we: { cat: "person", deixis: "companions" },
  us: { cat: "person", deixis: "companions" },
  they: { cat: "person", deixis: "group" },
  this: { cat: "person", deixis: "gazeEntity" },
  that: { cat: "person", deixis: "gazeEntity" },
  here: { cat: "person", deixis: "gazePoint" },
  there: { cat: "person", deixis: "gazePoint" },

  // Verbs — movement (directive)
  go: V("go", true), come: V("come", true), stop: V("stop", true), follow: V("follow", true),
  wait: V("wait", true), stay: V("stay", true), run: V("run", true), walk: V("walk", true),
  turn: V("turn", true),
  // RETURN — going BACK: bare it compiles to goHome; with a named place it is
  // an ordinary go ("return + home", "return + school").
  return: V("return", true),
  // Verbs — handling (directive; some transfer). `implied` = the argument
  // frame: the role a bare second noun fills (give X mara → to mara; throw X
  // bin → in the bin; take X dog → from the dog). Acquisition verbs imply a
  // SOURCE, delivery verbs a RECIPIENT — the to/from opposition
  // (semantic-gaps.md): an explicit marker of the OTHER direction turns an
  // acquisition into a transport ("take ball TO dog" delivers).
  get: V("get", true, true), take: V("take", true, true, "from"), give: V("give", true, true, "to"),
  bring: V("bring", true, true, "to"), // give's fetch-first twin — same frame, same roles
  put: V("put", true, false, "in"), drop: V("drop", true, false, "in"),
  throw: V("throw", true, false, "in"), push: V("push", true),
  // `shut`, never `close` (user law): the vocabulary the LLM reads carries no
  // synonyms, and "close" would collide with close = NEAR.
  pull: V("pull", true), open: V("open", true), shut: V("shut", true),
  // PHYSICAL CARRYING (distinct from get/take = acquire possession): pick_up
  // lifts into the hands, carry holds-and-moves (a bare 2nd noun is the
  // destination), drop sets down (in a container, or bare = release here).
  pick_up: V("pick_up", true), carry: V("carry", true, false, "to"),
  // Verbs — making (directive)
  make: V("make", true), build: V("build", true), break: V("break", true), fix: V("fix", true),
  dig: V("dig", true), plant: V("plant", true), cut: V("cut", true),
  // `clean` is a DESCRIPTOR, never an action. The two things you actually do are
  // `wash` (scrub a thing clean) and `tidy` (put things back where they belong),
  // and they are different acts with different outcomes — collapsing both into
  // "clean" is what made a command render as "I am clean" (the state adjective;
  // see NEED_ACTIVITY in intent-lines.ts, which already had to route the scrub
  // through `wash` to avoid it). `clean` stays as the cleanliness state pole.
  tidy: V("tidy", true),
  area: V("area", true), // ③ area charters — "area + farm + here"
  // Verbs — transforming (directive)
  // `make_cold` — no key here may contain "cool" at all. The bare word is the
  // slang, and the AI picks by nearest-word, so even `cool_down` pulled slang
  // sentences onto the cold snowflake (see glyph-registry).
  heat: V("heat", true), cook: V("cook", true), make_cold: V("make_cold", true), wash: V("wash", true),
  fill: V("fill", true), empty: V("empty", true),
  // Verbs — interacting
  help: V("help", true), play: V("play", true), talk: V("talk", true), ask: V("ask", true),
  trade: V("trade", true, true, "to"), show: V("show", true, true, "to"), teach: V("teach", true),
  share: V("share", true, true, "to"), fight: V("fight", true), chase: V("chase", true), hug: V("hug", true),
  // Verbs — state (NOT directive)
  want: V("want"), need: V("need"), have: V("have"), like: V("like"), feel: V("feel"),
  // The BROAD activity verb ("what + you + do" — what are you doing?): a
  // question focus, not an orderable action, so not directive.
  do: V("do"),
  eat: V("eat", true), drink: V("drink", true), sleep: V("sleep", true), rest: V("rest", true),
  // Verbs — self-care poses + routines (board core vocabulary)
  sit: V("sit", true), wake_up: V("wake_up", true), brush_teeth: V("brush_teeth", true),
  wear: V("wear", true),
  // Recolour a named item at a coloring tub ("color the shirt red") — directive,
  // transitive; the colour rides as a `color_*` descriptor/modifier.
  color: V("color", true),

  // Question words
  where: { cat: "question", q: "where" }, what: { cat: "question", q: "what" },
  who: { cat: "question", q: "who" }, why: { cat: "question", q: "why" }, how: { cat: "question", q: "how" },

  // Connectives
  and: { cat: "connective", conn: "and", role: "sequence" },
  then: { cat: "connective", conn: "then", role: "sequence" },
  but: { cat: "connective", conn: "but", role: "sequence" },
  or: { cat: "connective", conn: "or", role: "sequence" },
  because: { cat: "connective", conn: "because", role: "causal" },
  so: { cat: "connective", conn: "therefore", role: "causal" },
  therefore: { cat: "connective", conn: "therefore", role: "causal" },
  in_order_to: { cat: "connective", conn: "in_order_to", role: "causal" },
  if: { cat: "connective", conn: "if", role: "condition" },
  // "when" is also interrogative — resolved by context (a standalone question vs a rule trigger).
  when: { cat: "connective", conn: "when", role: "condition" },
  until: { cat: "connective", conn: "until", role: "condition" },

  // Relations
  to: { cat: "relation", rel: "to" }, from: { cat: "relation", rel: "from" },
  with: { cat: "relation", rel: "with" }, for: { cat: "relation", rel: "for" },
  in: { cat: "relation", rel: "in" }, on: { cat: "relation", rel: "on" },
  under: { cat: "relation", rel: "under" }, over: { cat: "relation", rel: "over" },
  near: { cat: "relation", rel: "near" }, behind: { cat: "relation", rel: "behind" },
  front: { cat: "relation", rel: "front" },
  // THE PROXIMITY PAIR, and they are NOT synonyms — the distinction the culture
  // spec already draws for furniture (`besideAnchor`) now exists in language
  // too. `next_to` names the ADJACENT spot: right against the anchor, touching
  // its footprint ring. `near` SCALES with the room — anywhere in the anchor's
  // vicinity, best spot wins on distance.
  next_to: { cat: "relation", rel: "beside" },
  // MANNER — "eat + together": the act is ONE shared act. It binds no noun (a
  // relation would demand one), so it is its own category; the companions are
  // whoever the frame already names, or the speaker's own group when it names
  // nobody ("we eat together").
  together: { cat: "manner", manner: "joint" },

  // THE FACING PAIR (board keys): `in_front_of` is the board word for the
  // `front` relation — same seam as next_to → beside. `behind` already reads
  // as itself above. `above` is accepted as a spoken synonym of `over`.
  in_front_of: { cat: "relation", rel: "front" },
  above: { cat: "relation", rel: "over" },

  // Social acts
  hi: { cat: "social", act: "greet" }, hello: { cat: "social", act: "greet" },
  bye: { cat: "social", act: "farewell" }, goodbye: { cat: "social", act: "farewell" },
  yes: { cat: "social", act: "affirm" }, no: { cat: "social", act: "decline" },
  ok: { cat: "social", act: "acknowledge" }, okay: { cat: "social", act: "acknowledge" },
  thanks: { cat: "social", act: "thank" }, sorry: { cat: "social", act: "apologize" },
  mine: { cat: "social", act: "claim" }, again: { cat: "social", act: "again" },
  dont_understand: { cat: "social", act: "unclear" }, confused: { cat: "social", act: "unclear" },

  // Quantity
  one: { cat: "quantity", q: "one" }, two: { cat: "quantity", q: "two" },
  three: { cat: "quantity", q: "three" }, many: { cat: "quantity", q: "many" },
  all: { cat: "quantity", q: "all" }, none: { cat: "quantity", q: "none" },
  more: { cat: "quantity", q: "more" }, less: { cat: "quantity", q: "less" },

  // Attributes (usually arrive as `.` modifiers; a standalone one is a predicate)
  // ("clean" is a verb above; as an adjective it arrives as a `.clean` modifier.)
  big: { cat: "attribute" }, small: { cat: "attribute" }, good: { cat: "attribute" },
  bad: { cat: "attribute" }, hot: { cat: "attribute" }, cold: { cat: "attribute" },
  dirty: { cat: "attribute" }, happy: { cat: "attribute" },
  sad: { cat: "attribute" }, broken: { cat: "attribute" }, new: { cat: "attribute" }, old: { cat: "attribute" },
  // Creature-condition states (CONDITION_REMEDY axes) — modifiers, so "hungry" reads as
  // a creatureState condition, not a fringe noun.
  hungry: { cat: "attribute" }, thirsty: { cat: "attribute" }, tired: { cat: "attribute" },
  bored: { cat: "attribute" },
  lonely: { cat: "attribute" }, sick: { cat: "attribute" }, warm: { cat: "attribute" }, full: { cat: "attribute" },
};

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

interface Tok {
  head: string;
  mods: string[];
  ops: string[];
  raw: string;
}

/** Split one glyph token into head + `.`-modifiers + `#`-operators. */
function parseToken(raw: string): Tok {
  const [body, ...opParts] = raw.split("#");
  const ops = opParts.map((s) => s.trim().toLowerCase()).filter(Boolean);
  const seg = body.split(".").map((s) => s.trim()).filter(Boolean);
  return { head: (seg[0] ?? "").toLowerCase(), mods: seg.slice(1).map((m) => m.toLowerCase()), ops, raw };
}

/** Split a full sentence string ("i_me + want + ball") into glyph tokens. */
export function tokenizeSentence(sentence: string): string[] {
  return sentence.split("+").map((s) => s.trim()).filter(Boolean);
}

interface Lexed {
  tok: Tok;
  lex: Lex | null; // null ⇒ an open-class ENTITY (a fringe noun)
}

function personRef(d: Deixis, symbol: string, mods: string[]): Ref {
  switch (d) {
    case "player": return { kind: "player" };
    case "listener": return { kind: "listener" };
    case "companions": return { kind: "companions" };
    case "group": return { kind: "group" };
    case "gazeEntity": return { kind: "gaze", of: "entity" };
    case "gazePoint": return { kind: "gaze", of: "point" };
  }
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export function parseIntent(tokens: string[], ctx: ParseContext = {}): IntentFrame {
  const raw = tokens.slice();
  const lexed: Lexed[] = tokens
    .map(parseToken)
    .filter((t) => t.head)
    .map((tok) => ({ tok, lex: LEXICON[tok.head] ?? null }));

  const ops = new Set(lexed.flatMap((l) => l.tok.ops));

  // Stage 2 — structural split (at most one, at the top level). A causal
  // `because` stays inside a single clause (narration).
  //
  // ⚖️ THE CONDITION SPLIT WINS OVER THE SEQUENCE SPLIT. `then` is a SEQUENCE
  // connective, so asking the sequence question first swallowed the whole
  // conditional shape: "if + night + then + go + home" came out as
  // sequence[state(night), command(go home)] and the `if` was dropped by
  // `parseClause`, which has no use for a connective. Worse, "if + you + give +
  // wood + then + i_me + give + food" split into a DIRECT ORDER plus an
  // immediate unconditional OFFER — both halves executed, neither contingent
  // (contracts-and-promises.md §2a, measured against the live parser).
  //
  // So: a condition connective plus a verb ANYWHERE is a RULE, and a sequence
  // connective inside the rule's own clauses is the clause BOUNDARY (buildRule
  // below), never a second reading. With no verb to do there is nothing to
  // trigger, and today's non-rule reading stands — which is also what keeps
  // `isComplete`'s dangling "when + night" guard true.
  const condIdx = lexed.findIndex((l) => l.lex?.cat === "connective" && l.lex.role === "condition");
  if (condIdx >= 0 && lexed.some((l) => l.lex?.cat === "verb")) {
    return buildRule(lexed, condIdx, ops, ctx, raw);
  }

  const seqIdx = lexed.findIndex((l) => l.lex?.cat === "connective" && l.lex.role === "sequence");
  if (seqIdx > 0 && seqIdx < lexed.length - 1) {
    const conn = (lexed[seqIdx]!.lex as { conn: string }).conn;
    const head = lexed.slice(0, seqIdx);
    const tail = lexed.slice(seqIdx + 1);
    return {
      kind: "sequence",
      connective: conn,
      clauses: [
        // EACH CLAUSE CARRIES ITS OWN TOKENS. `raw` is what every consumer
        // reads back as "the sentence this frame is" — the dialogue layer
        // quotes it (`intentToAct`), and the host re-speaks a queued second
        // clause from it (S1). Handing both clauses the WHOLE sentence made
        // each of them claim to be the other one too.
        parseClause(head, ops, ctx, head.map((l) => l.tok.raw)),
        parseClause(tail, ops, ctx, tail.map((l) => l.tok.raw)),
      ],
      modifiers: [],
      raw,
    };
  }

  return parseClause(lexed, ops, ctx, raw);
}

/** Convenience: parse a raw sentence string. */
export function parseSentence(sentence: string, ctx: ParseContext = {}): IntentFrame {
  return parseIntent(tokenizeSentence(sentence), ctx);
}

const LIFETIME: Record<string, IntentLifetime> = { when: "while", if: "edge", until: "until" };

function buildRule(lexed: Lexed[], condIdx: number, ops: Set<string>, ctx: ParseContext, raw: string[]): IntentFrame {
  const conn = (lexed[condIdx]!.lex as { conn: string }).conn;
  const left = lexed.slice(0, condIdx);
  const right = lexed.slice(condIdx + 1);
  const hasVerb = (ls: Lexed[]) => ls.some((l) => l.lex?.cat === "verb");

  let actionToks: Lexed[];
  let condToks: Lexed[];
  // ⛓️ "IF <trigger> THEN <action>" — a SEQUENCE connective standing after the
  // condition connective IS the clause boundary (contracts-and-promises §4c).
  // It is the only splitter that can separate TWO VERBS: the `left.length === 0`
  // arm below cuts the trailing clause at its FIRST verb, which read "if you
  // give wood then i_me give food" as one action frame ("you give wood to me")
  // and lost the food entirely (§2b). Gated on the ACTION side actually
  // carrying a verb, so a stray joiner never re-cuts a shape the arms below
  // already read correctly.
  const seqAt = right.findIndex((l) => l.lex?.cat === "connective" && l.lex.role === "sequence");
  if (seqAt >= 0 && !hasVerb(left) && hasVerb(right.slice(seqAt + 1))) {
    condToks = [...left, ...right.slice(0, seqAt)];
    actionToks = right.slice(seqAt + 1);
  } else if (hasVerb(left) && !hasVerb(right)) {
    actionToks = left; // "go home WHEN night" / "build house UNTIL town"
    condToks = right;
  } else if (!hasVerb(left) && hasVerb(right)) {
    if (left.length === 0) {
      // "WHEN night go home" — split the trailing clause at its first verb.
      const vi = right.findIndex((l) => l.lex?.cat === "verb");
      condToks = right.slice(0, vi);
      actionToks = right.slice(vi);
    } else {
      actionToks = right;
      condToks = left;
    }
  } else {
    // both/neither have a verb — best-effort: action before the connective.
    actionToks = left.length ? left : right;
    condToks = left.length ? right : left;
  }

  const action = parseClause(actionToks, ops, ctx, raw);
  const condition = parseClause(condToks, ops, ctx, raw);
  return {
    ...action,
    kind: "rule",
    connective: conn,
    lifetime: LIFETIME[conn],
    condition,
    raw,
  };
}

/** Stages 3–5 for a single clause: extract slots, resolve refs, classify + default. */
function parseClause(lexed: Lexed[], ops: Set<string>, ctx: ParseContext, raw: string[]): IntentFrame {
  const tense = ops.has("past") ? "past" : ops.has("future") ? "future" : "present";
  const isQuestionOp = ops.has("question");

  let verb: string | undefined;
  let negated = false;
  let directive = false;
  let transfer = false;
  let implied: ImpliedRel | undefined;
  let verbIndex = -1;
  const verbEntries: { verb: string; directive: boolean; transfer: boolean; implied?: ImpliedRel; index: number; not: boolean }[] = [];
  let question: QuestionWord | undefined;
  let relation: string | undefined;
  let target: Ref | undefined;
  const bound: Array<{ relation: string; ref: Ref }> = [];
  let quantity: string | undefined;
  let manner = false; // an explicit `together`
  const attrs: string[] = [];
  const socials: IntentKind[] = [];
  const persons: { ref: Ref; deixis: Deixis; index: number }[] = []; // animate agents (i_me/you/we/they)
  const entities: { ref: Ref; index: number }[] = []; // things (fringe nouns + this/that)
  const locations: { ref: Ref; index: number }[] = []; // here/there — loose destinations
  let pendingRel: string | null = null;

  lexed.forEach(({ tok, lex }, i) => {
    // A relation binds the NEXT noun as the target.
    const bindNoun = (ref: Ref) => {
      if (pendingRel) {
        target = ref;
        relation = pendingRel;
        bound.push({ relation: pendingRel, ref }); // every marked pair kept
        pendingRel = null;
        return true;
      }
      return false;
    };

    if (!lex) {
      const ref: Ref = { kind: "entity", symbol: tok.head, modifiers: tok.mods };
      if (!bindNoun(ref)) entities.push({ ref, index: i });
      return;
    }
    switch (lex.cat) {
      case "person": {
        const ref = personRef(lex.deixis, tok.head, tok.mods);
        if (bindNoun(ref)) break;
        // this/that are THINGS (object candidates); here/there are LOCATIONS; only
        // i_me/you/we/they are animate agents that can be a subject.
        if (lex.deixis === "gazeEntity") entities.push({ ref, index: i });
        else if (lex.deixis === "gazePoint") locations.push({ ref, index: i });
        else persons.push({ ref, deixis: lex.deixis, index: i });
        break;
      }
      case "verb":
        verbEntries.push({
          verb: lex.verb,
          directive: lex.directive,
          transfer: lex.transfer,
          ...(lex.implied ? { implied: lex.implied } : {}),
          index: i,
          not: tok.mods.includes("not"),
        });
        break;
      case "question":
        question = lex.q;
        break;
      case "relation":
        pendingRel = lex.rel;
        break;
      case "attribute":
        attrs.push(tok.head);
        break;
      case "quantity":
        quantity = lex.q;
        break;
      case "social":
        socials.push(lex.act);
        break;
      case "manner":
        manner = true;
        break;
      case "connective":
        break; // handled by the splitters
    }
  });

  // VERB COMPOSITION: with several verb tokens, compose (modal/phase/auxiliary)
  // rather than letting the last one silently win. Order-free like every other
  // role assignment — "stop + eat" and "eat + stop" both cease the eating.
  let phase: IntentFrame["phase"];
  let modal: IntentFrame["modal"];
  let main = verbEntries[0];
  if (verbEntries.length > 1) {
    const stop = verbEntries.find((e) => e.verb === "stop");
    const rest = verbEntries.filter((e) => e !== stop);
    const modalEntry = rest.find((e) => MODAL_VERBS.has(e.verb));
    const action = rest.find((e) => e !== modalEntry);
    if (stop && rest.length) {
      phase = "stop"; // "stop + {V}" — cease the activity
      main = action ?? rest[0];
    } else if (modalEntry && action) {
      modal = modalEntry.verb as IntentFrame["modal"]; // "want + {V}" — a desire to do it
      main = action;
    } else {
      // "go/come + {V}" — the motion is implied by the action ("go wash the
      // clothes" = wash them); any other pair keeps the FIRST verb.
      const aux = rest.find((e) => MOTION_AUX.has(e.verb));
      const other = rest.find((e) => e !== aux);
      main = aux && other ? other : verbEntries[0];
    }
  }
  if (main) {
    verb = main.verb;
    directive = main.directive;
    transfer = main.transfer;
    implied = main.implied;
    verbIndex = main.index;
    negated = verbEntries.some((e) => e.not); // "want.not + play" negates the frame
  }

  // Subject resolution, in priority order:
  //   1. DEIXIS (animacy) — an animate agent (i_me/you/we/they) is the subject even
  //      out of position ("apple me eat" = I eat the apple). For a transfer, a person
  //      before the verb is preferred so we don't mistake the recipient for the giver.
  //   2. SUBJECT-BEFORE-OBJECT — with ≥2 plain nouns, the EARLIER is the subject and
  //      the later the object, wherever the verb sits (subject precedes object is
  //      near-universal; verb position is free).
  //   3. AGENT BEFORE VERB — a lone noun before an ACTION verb is its agent
  //      ("farmers eat"); after the verb it's the object ("eat apple").
  // State verbs (want/have/feel) never promote a noun to subject — the subject is the
  // speaker and the noun is the object ("apple want" = I want apple).
  const beforeVerb = (p: { index: number }) => verbIndex < 0 || p.index < verbIndex;
  const subjectPerson = persons.find(beforeVerb) ?? (transfer ? undefined : persons[0]);
  let subject: Ref | undefined = subjectPerson?.ref;
  let subjectEntityIndex = -1;
  // A modal clause behaves like a state verb: the desire is the SPEAKER's, so
  // a noun never promotes to subject ("want + play + ball" = I want to play ball).
  const stateVerb = (verb !== undefined && STATE_VERBS.has(verb)) || modal !== undefined;
  const classify = (r: Ref | undefined): "place" | "item" | "creature" | "unknown" | undefined =>
    r?.kind === "entity" && ctx.classifyEntity ? ctx.classifyEntity(r.symbol) : undefined;
  /** ⑫ — is this noun somebody the speaker is CURRENTLY IN A CONVERSATION WITH?
   *  The one question that separates talking TO from talking ABOUT. */
  const inRoster = (r: Ref | undefined): boolean =>
    r?.kind === "entity" && !!ctx.addressees?.some((a) => a.toLowerCase() === r.symbol.toLowerCase());
  // NB: inferring an ABSENT subject (is a bare "come i_me" me-coming or you-come-to-me?)
  // is context-dependent and deliberately DEFERRED — compose an explicit "you" for now.
  const movementGoal = verb !== undefined && MOVEMENT_GOAL_VERBS.has(verb);
  // A fringe noun BEFORE the verb that the world says is a CREATURE. Computed
  // once for both the agent rule below and the ⑫ vocative rule (Stage 3.6):
  // whichever of the two claims it, it is a PERSON in the sentence and never a
  // thing — see the state-verb consumption immediately after.
  const creaturePre = entities.find(
    (e) => (verbIndex < 0 || e.index < verbIndex) && classify(e.ref) === "creature",
  );
  if (!subject && !stateVerb) {
    // ANIMACY over position: a fringe noun BEFORE the verb that the world says
    // is a CREATURE is the agent, whatever the verb class ("mara + give +
    // apple" = Mara gives). Needs the classifier; a name is opaque otherwise.
    if (creaturePre) {
      subjectEntityIndex = creaturePre.index;
      subject = creaturePre.ref;
    } else if (!transfer && !implied) {
      // POSITION rules — but never for a transfer or an argument-frame verb:
      // their extra noun is an ARGUMENT (recipient/destination), not an agent
      // ("throw apple bin" must not read as "the apple throws the bin").
      if (entities.length >= 2) {
        subjectEntityIndex = entities[0]!.index; // earliest noun = subject
        subject = entities[0]!.ref;
      } else if (entities.length === 1 && verbIndex >= 0 && entities[0]!.index < verbIndex) {
        subjectEntityIndex = entities[0]!.index; // lone noun before an action verb = agent
        subject = entities[0]!.ref;
      }
    }
  }

  // ⑫ — A NAMED PERSON IS NEVER THE THING WANTED. With a STATE verb the desire is
  // the speaker's, so the animacy rule above deliberately declines to promote a
  // noun to subject ("want + play + ball" = I want to play ball) — but that left
  // a named creature sitting in the entity list with no role, and the object rule
  // below takes the FIRST unclaimed noun, so "mara + want + apple" came out as
  // wanting MARA and silently dropped the apple. A creature named before a state
  // verb is a PERSON in the sentence: the one being addressed (Stage 3.6 binds it
  // as the vocative when the roster says it is present) or the one being spoken
  // about. Either way it is consumed here, so the thing wanted is the thing.
  let vocativeEntityIndex = -1;
  if (stateVerb && creaturePre && entities.length >= 2) {
    vocativeEntityIndex = creaturePre.index;
  }

  // A transfer's RECIPIENT/SOURCE or a movement verb's DESTINATION: the person after
  // the verb that isn't the subject (else any other) → an implicit target bound by
  // the verb's OWN argument frame ("you give i_me ball" → to me; "take ball i_me" →
  // from me; "you follow i_me" → follow me). Subject stays whatever was found.
  if ((transfer || movementGoal) && !target) {
    const recip =
      persons.find((p) => p !== subjectPerson && !beforeVerb(p)) ??
      persons.find((p) => p !== subjectPerson);
    if (recip) {
      target = recip.ref;
      relation = implied ?? "to";
    }
  }

  // THE ARGUMENT FRAME (verb `implied` relation): with two free nouns and no
  // explicit target, the second fills the verb's implied role — "give apple
  // mara" → to mara; "throw apple bin" → in the bin; "take ball dog" → from
  // the dog. The classifier picks the role-fitting noun regardless of order
  // (a CREATURE takes "to", a PLACE takes "in", a SOURCE is a creature or a
  // container/place); without one, position decides (object first, argument
  // last).
  const unclaimed = (e: { index: number }) =>
    e.index !== subjectEntityIndex && e.index !== vocativeEntityIndex;
  let objectEntry = entities.find(unclaimed);
  if (implied && !target) {
    const free = entities.filter(unclaimed);
    if (free.length >= 2) {
      const wantClasses: readonly string[] =
        implied === "to" ? ["creature"] : implied === "in" ? ["place"] : ["creature", "place"];
      const targetEntry =
        [...free].reverse().find((e) => {
          const c = classify(e.ref);
          return c !== undefined && wantClasses.includes(c);
        }) ?? free[free.length - 1]!;
      target = targetEntry.ref;
      relation = implied;
      objectEntry = free.find((e) => e !== targetEntry);
    }
  }
  const object: Ref | undefined = objectEntry?.ref;

  // A loose here/there (no binding relation) is a destination for a movement/place goal.
  if (!target && locations[0]) target = locations[0].ref;

  // Word-order conformance — score only roles the child EXPLICITLY placed (an
  // implied/defaulted subject has no position and can't be "misordered").
  const subjectIndex = subjectPerson?.index ?? (subjectEntityIndex >= 0 ? subjectEntityIndex : -1);
  const placed: { role: OrderRole; index: number }[] = [];
  if (subjectIndex >= 0) placed.push({ role: "subject", index: subjectIndex });
  if (verbIndex >= 0) placed.push({ role: "verb", index: verbIndex });
  if (objectEntry) placed.push({ role: "object", index: objectEntry.index });
  const order = placed.length >= 2 ? scoreOrder(placed, ctx.wordOrder ?? "svo") : undefined;

  // JOINTNESS (`joint`) — the act is ONE shared act. Three ways to mean it, so
  // a child gets the concept from whichever word they have: the explicit
  // `together`, a COMPANIONS subject ("we eat"), or a `with`-marked ANIMATE
  // companion ("eat with mara"). Animacy is what keeps "trade wood WITH the
  // city" and "wash the cup WITH water" out — a `with` naming a place or a
  // thing is an instrument or a partner-in-trade, never company.
  const animate = (r: Ref): boolean => {
    switch (r.kind) {
      case "player":
      case "listener":
      case "companions":
      case "group":
        return true;
      case "entity":
        return classify(r) === "creature";
      default:
        return false;
    }
  };
  const joint =
    manner ||
    persons.some((p) => p.deixis === "companions") ||
    bound.some((b) => b.relation === "with" && animate(b.ref));

  // The ADDRESSING act actually spoken ("hi" / "bye"), kept so that naming a
  // creature can't silently turn "bye + mara" into a greeting.
  const addressingAct = socials.find((s) => ADDRESSING_ACTS.has(s));

  // Stage 3.5 — classify the move.
  let kind: IntentKind;
  if (question || isQuestionOp) {
    kind = "ask";
  } else if (!verb && entities.length === 0 && attrs.length === 0 && socials.length > 0) {
    kind = socials[0]!; // a pure social act (hi / yes / thanks / …)
  } else if (verb !== undefined && directive && socials.includes("decline")) {
    // "no + <verb>" — a PROHIBITION, not a command: the decline that used
    // to be dropped is the law's whole meaning ("no fight"). The verb is
    // what's forbidden; area/issuer are the compiler's/world's concern.
    kind = "forbid";
  } else {
    ({ kind, subject } = classifyPredicate({ verb, directive, transfer, modal, subject, object, target, attrs, entities, ctx, social: addressingAct }));
  }

  // Stage 3.6 — the VOCATIVE. An addressing act that NAMES an animate is spoken
  // TO it: "hi + mara", "mara + hi" and a bare "mara" (naming a creature is
  // already a greeting, above) all address Mara; "hi + you" addresses the
  // listener — a no-op referent, but a well-formed one. PURELY ADDITIVE: the
  // noun keeps whatever other role the frame already gave it, this only records
  // WHOM. Needs the classifier — without one a name is opaque and the parser
  // never guesses animacy, so "hi + ball" binds nobody.
  let vocative: Ref | undefined;
  if (!verb && (kind === "greet" || kind === "farewell")) {
    vocative =
      entities.find((e) => classify(e.ref) === "creature")?.ref ??
      persons.find((p) => p.deixis === "listener")?.ref;
  } else if (kind === "command" || kind === "request" || kind === "state") {
    // ⑫ — THE NAME CHANNEL (conversation-in-motion.md law ②). Naming somebody
    // who is standing in your conversation is ADDRESSING them: it is the channel
    // that survives full hands and a body facing the wrong way, which is exactly
    // why a name is worth learning.
    //
    // PURELY ADDITIVE, and it has to be: for a DIRECTIVE the imperative's subject
    // and the utterance's addressee are ALREADY the same creature (an imperative
    // with no named subject defaults to the listener, and a recipient-less "give"
    // already lands on the speaker). So "mara + give + apple" needed no
    // reinterpretation — the animacy rule has been computing the addressee under
    // another name all along, and this only writes down what it found. Nothing is
    // reassigned and no pinned reading moves.
    //
    // THE ROSTER IS THE GATE, and no amount of syntax could replace it: a name in
    // the conversation is a person spoken TO, a name outside it is a person
    // spoken ABOUT. A recipient behind the verb is never the addressee, which
    // falls out for free — "pip + give + apple + to + mara" binds pip.
    const named = subject?.kind === "entity" && inRoster(subject) ? subject : undefined;
    const addressed =
      vocativeEntityIndex >= 0 && inRoster(entities.find((e) => e.index === vocativeEntityIndex)?.ref)
        ? entities.find((e) => e.index === vocativeEntityIndex)?.ref
        : undefined;
    vocative = named ?? addressed;
  }

  return {
    kind,
    verb,
    negated: negated || undefined,
    phase,
    modal,
    joint: joint || undefined,
    subject,
    object,
    vocative,
    target,
    relation,
    ...(bound.length ? { bound } : {}),
    modifiers: attrs,
    quantity,
    question,
    polar: isQuestionOp && !question ? true : undefined,
    tense,
    order,
    raw,
  };
}

/** Refine a declarative/imperative into request/offer/command/state, filling the
 *  default subject (imperative → listener, else the speaker). Verbless nouns lean on
 *  the entity classifier + mode (a place ⇒ go, an item ⇒ want/build). */
function classifyPredicate(a: {
  verb?: string;
  directive: boolean;
  transfer: boolean;
  modal?: IntentFrame["modal"];
  subject?: Ref;
  object?: Ref;
  target?: Ref;
  attrs: string[];
  entities: { ref: Ref }[];
  ctx: ParseContext;
  /** The ADDRESSING act spoken alongside the nouns (greet/farewell), when one
   *  was — it decides which social move a named creature belongs to. */
  social?: IntentKind;
}): { kind: IntentKind; subject?: Ref } {
  const isPlayer = (r?: Ref) => r?.kind === "player";
  const isListener = (r?: Ref) => r?.kind === "listener";

  if (!a.verb) {
    // Verbless. A predicate adjective ("i_me sad") is a statement.
    if (a.attrs.length) return { kind: "state", subject: a.subject ?? { kind: "player" } };
    const first = a.entities[0]?.ref;
    if (first && first.kind === "entity" && a.ctx.classifyEntity) {
      switch (a.ctx.classifyEntity(first.symbol)) {
        case "place":
          return { kind: "command", subject: a.subject ?? { kind: "listener" } };
        case "creature":
          // Naming a creature ADDRESSES it (the caller binds the vocative). The
          // move is a greeting unless the utterance said otherwise — "bye +
          // mara" is a FAREWELL, and used to come out as a hello.
          return { kind: a.social ?? "greet", subject: a.subject };
        case "item":
          return a.ctx.mode === "building"
            ? { kind: "command", subject: a.subject ?? { kind: "listener" } }
            : { kind: "request", subject: a.subject ?? { kind: "player" } };
        default:
          return { kind: "state", subject: a.subject };
      }
    }
    return { kind: "state", subject: a.subject }; // a bare mention; the world decides
  }

  // A MODAL desire ("want + play", "i_me + want + go + home"): a wish to DO the
  // verb — a request (grantable), or a mere liking (a statement) — never an
  // order to the listener, whatever the inner verb's directivity says.
  if (a.modal) {
    return { kind: a.modal === "like" ? "state" : "request", subject: a.subject ?? { kind: "player" } };
  }

  // Default subject: an imperative addresses the listener; a self-statement is the speaker.
  const subject = a.subject ?? (a.directive ? { kind: "listener" as const } : { kind: "player" as const });

  switch (a.verb) {
    case "want":
    case "need":
      return { kind: "request", subject };
    case "give":
      if (isPlayer(a.target)) return { kind: "request", subject }; // "give ME x"
      if (isPlayer(subject)) return { kind: "offer", subject }; // "I give x"
      return { kind: "command", subject }; // "you give x"
    case "have":
    case "like":
    case "feel":
      return { kind: "state", subject };
    default:
      // Any other verb: directive OR addressed to the listener ⇒ a command; a
      // self-subject statement ("i_me go home") ⇒ state.
      if (isListener(subject) || (a.directive && !isPlayer(subject))) return { kind: "command", subject };
      return { kind: "state", subject };
  }
}
