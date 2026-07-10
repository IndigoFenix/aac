// shared/symbol-game/parse-intent.ts
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
  subject?: Ref;
  object?: Ref;
  /** Recipient / destination / located-at, when a relation binds one. */
  target?: Ref;
  /** The relation that bound `target` ("to", "in", "with"…). */
  relation?: string;
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
  | { cat: "verb"; verb: string; directive: boolean; transfer: boolean }
  | { cat: "question"; q: QuestionWord }
  | { cat: "connective"; conn: string; role: ConnRole }
  | { cat: "relation"; rel: string }
  | { cat: "social"; act: IntentKind }
  | { cat: "quantity"; q: string }
  | { cat: "attribute" };

const V = (verb: string, directive = false, transfer = false): Lex => ({ cat: "verb", verb, directive, transfer });

/** Speaker-oriented STATE verbs: their subject is the speaker by default and any
 *  entity is the OBJECT, so "apple want" reads "[I] want apple", never "apple wants".
 *  (Semantic override of pure position — matches "apple me eat" = I eat the apple.) */
const STATE_VERBS = new Set(["want", "need", "have", "like", "feel"]);

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
  wait: V("wait", true), stay: V("stay", true), run: V("run", true), turn: V("turn", true),
  // Verbs — handling (directive; some transfer)
  get: V("get", true, true), take: V("take", true, true), give: V("give", true, true),
  put: V("put", true), drop: V("drop", true), throw: V("throw", true), push: V("push", true),
  pull: V("pull", true), open: V("open", true), close: V("close", true), carry: V("carry", true),
  // Verbs — making (directive)
  make: V("make", true), build: V("build", true), break: V("break", true), fix: V("fix", true),
  dig: V("dig", true), plant: V("plant", true), cut: V("cut", true), clean: V("clean", true),
  // Verbs — transforming (directive)
  heat: V("heat", true), cook: V("cook", true), cool: V("cool", true), wash: V("wash", true),
  fill: V("fill", true), empty: V("empty", true),
  // Verbs — interacting
  help: V("help", true), play: V("play", true), talk: V("talk", true), ask: V("ask", true),
  trade: V("trade", true, true), show: V("show", true, true), teach: V("teach", true),
  share: V("share", true, true), fight: V("fight", true), chase: V("chase", true), hug: V("hug", true),
  // Verbs — state (NOT directive)
  want: V("want"), need: V("need"), have: V("have"), like: V("like"), feel: V("feel"),
  eat: V("eat", true), drink: V("drink", true), sleep: V("sleep", true), rest: V("rest", true),

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

  // Stage 2 — structural split. Sequence (and/then) at the top level, then a rule
  // (when/if/until). A causal `because` stays inside a single clause (narration).
  const seqIdx = lexed.findIndex((l) => l.lex?.cat === "connective" && l.lex.role === "sequence");
  if (seqIdx > 0 && seqIdx < lexed.length - 1) {
    const conn = (lexed[seqIdx]!.lex as { conn: string }).conn;
    return {
      kind: "sequence",
      connective: conn,
      clauses: [
        parseClause(lexed.slice(0, seqIdx), ops, ctx, raw),
        parseClause(lexed.slice(seqIdx + 1), ops, ctx, raw),
      ],
      modifiers: [],
      raw,
    };
  }

  const condIdx = lexed.findIndex((l) => l.lex?.cat === "connective" && l.lex.role === "condition");
  // A condition connective makes a RULE only when there's an action verb somewhere.
  if (condIdx >= 0 && lexed.some((l) => l.lex?.cat === "verb")) {
    return buildRule(lexed, condIdx, ops, ctx, raw);
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
  if (hasVerb(left) && !hasVerb(right)) {
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
  let verbIndex = -1;
  let question: QuestionWord | undefined;
  let relation: string | undefined;
  let target: Ref | undefined;
  let quantity: string | undefined;
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
        verb = lex.verb;
        directive = lex.directive;
        transfer = lex.transfer;
        verbIndex = i;
        if (tok.mods.includes("not")) negated = true;
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
      case "connective":
        break; // handled by the splitters
    }
  });

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
  const stateVerb = verb !== undefined && STATE_VERBS.has(verb);
  if (!subject && !transfer && !stateVerb) {
    if (entities.length >= 2) {
      subjectEntityIndex = entities[0]!.index; // earliest noun = subject
      subject = entities[0]!.ref;
    } else if (entities.length === 1 && verbIndex >= 0 && entities[0]!.index < verbIndex) {
      subjectEntityIndex = entities[0]!.index; // lone noun before an action verb = agent
      subject = entities[0]!.ref;
    }
  }

  // Transfer recipient: the person after the verb that isn't the subject, or (as a
  // fallback) any other person → the implicit "to" recipient ("give i_me ball").
  if (transfer && !target) {
    const recip =
      persons.find((p) => p !== subjectPerson && !beforeVerb(p)) ??
      persons.find((p) => p !== subjectPerson);
    if (recip) {
      target = recip.ref;
      relation = "to";
    }
  }

  const objectEntry = entities.find((e) => e.index !== subjectEntityIndex);
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

  // Stage 3.5 — classify the move.
  let kind: IntentKind;
  if (question || isQuestionOp) {
    kind = "ask";
  } else if (!verb && entities.length === 0 && attrs.length === 0 && socials.length > 0) {
    kind = socials[0]!; // a pure social act (hi / yes / thanks / …)
  } else {
    ({ kind, subject } = classifyPredicate({ verb, directive, transfer, subject, object, target, attrs, entities, ctx }));
  }

  return {
    kind,
    verb,
    negated: negated || undefined,
    subject,
    object,
    target,
    relation,
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
  subject?: Ref;
  object?: Ref;
  target?: Ref;
  attrs: string[];
  entities: { ref: Ref }[];
  ctx: ParseContext;
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
          return { kind: "greet", subject: a.subject };
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
