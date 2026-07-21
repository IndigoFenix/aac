// shared/world-engine/interaction/intent/surface-next.ts
//
// DETERMINISTIC BUTTON SURFACING for the in-game sentence builder
// (language-expansion.md): given the tokens composed SO FAR, enumerate what
// can meaningfully come NEXT — a next-token model driven by the same frame
// semantics the parser understands, never a hard-coded phrase list.
//
// The builder knows NOTHING of the world beyond what the player entered
// (unlike the context board): its only inputs are the partial parse, the
// noun library with each noun's AFFORDS (derived by the host from behavior
// data — concepts.ts), and a recent-utterance memory of the player's OWN
// words. Pure and RNG-free: same input ⇒ same board, forever.
//
// SURFACE CONTRACT (user decision): WORDS (speakable) and CONTROLS (sentence-
// type chips, category tabs) are separate outputs — the UI renders them
// visually distinct. Type chips seed `seedKind`; category tabs are the
// graceful-degradation ladder when the ranked grid can't hold everything.

import { LEXICON, parseSentence, type IntentFrame, type IntentKind, type ParseContext } from "./parse-intent.js";
import { PROPERTY_FOR_VERB, type ObjectProperty } from "../../object-properties.js";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** WHY a button surfaces — the unfilled role it would fill (debug + styling). */
export type SlotNeed =
  | "opener"
  | "verb"
  | "object"
  | "recipient"
  | "destination"
  | "relation-noun"
  | "question-focus"
  | "condition"
  | "attribute"
  | "connective"
  | "quantity";

/** A noun the player can name, with the verbs it AFFORDS (host-derived from
 *  behavior data — buildConcepts / family names / speakable places). */
export interface SurfaceNoun {
  symbol: string;
  label?: string;
  kind: "place" | "item" | "creature" | "unknown";
  affords: string[];
  /** What the noun IS — spec-derived object properties (properties.ts). The
   *  board files nouns into sub-tabs by these, and the verb pre-load (§3.1)
   *  ranks by them. Absent on core engine concepts, which have no spec. */
  properties?: string[];
}

export interface SurfaceButton {
  symbol: string;
  label?: string;
  role: SlotNeed;
  /** Deterministic rank (higher first). */
  weight: number;
}

/** A sentence-type CONTROL chip (rendered distinct from words) — seeds
 *  `SurfaceContext.seedKind` on the next call. */
export interface TypeChip {
  kind: IntentKind;
  label: string;
}

export const TYPE_CHIPS: readonly TypeChip[] = [
  { kind: "request", label: "want" },
  { kind: "ask", label: "question" },
  { kind: "state", label: "tell" },
  { kind: "command", label: "do" },
  { kind: "rule", label: "rule" },
  { kind: "greet", label: "social" },
];

export interface SurfaceSuggestion {
  /** Ranked speakable words, ≤ capacity. */
  buttons: SurfaceButton[];
  /** Sentence-type controls (empty once composition is underway). */
  typeChips: TypeChip[];
  /** Legal lexical-category tabs — the overflow/fallback ladder. */
  categories: string[];
  /** The Play affordance: does the current composition parse to something
   *  meaningful (never `unclear`)? */
  complete: boolean;
  /** The unfilled roles, most semantically forced first. */
  open: SlotNeed[];
  /** THE PRE-LOADED SUB-TAB (§3.1): the object property the composed verb
   *  wants, so the things tab opens on the right group before the student
   *  drills for it ("eat" → food). A fixed verb→property table, never a scene
   *  query — the builder stays context-blind. */
  subTab?: ObjectProperty;
}

/** Counter-based recent-utterance memory (never wall-clock — determinism).
 *  Player-entered data only: no world knowledge leaks into the builder. */
export interface RecencyMemory {
  mentioned: { symbol: string; at: number }[];
  utterances: number;
}

export const emptyRecency = (): RecencyMemory => ({ mentioned: [], utterances: 0 });

const RECENCY_CAP = 8;

/** Record a completed utterance's nouns (call after a successful speak). */
export function noteUtterance(mem: RecencyMemory, frame: IntentFrame): RecencyMemory {
  const at = mem.utterances + 1;
  const syms: string[] = [];
  for (const r of [frame.object, frame.target, frame.subject]) {
    if (r && (r.kind === "entity" || r.kind === "unresolved")) syms.push(r.symbol);
  }
  const mentioned = [
    ...syms.map((symbol) => ({ symbol, at })),
    ...mem.mentioned.filter((m) => !syms.includes(m.symbol)),
  ].slice(0, RECENCY_CAP);
  return { mentioned, utterances: at };
}

export interface SurfaceContext {
  nouns: SurfaceNoun[];
  recency?: RecencyMemory;
  /** A sentence-type chip was tapped — constrain the openers to that move. */
  seedKind?: IntentKind;
  /** Main-grid budget (default 16). */
  capacity?: number;
  parse?: ParseContext;
}

// ---------------------------------------------------------------------------
// LEXICON views (derived once — data, not authoring)
// ---------------------------------------------------------------------------

const LEX_KEYS = Object.keys(LEXICON);
const lexOrder = new Map(LEX_KEYS.map((k, i) => [k, i] as const));
const byCat = (cat: string): string[] => LEX_KEYS.filter((k) => (LEXICON[k] as { cat: string }).cat === cat);

const VERBS = byCat("verb");
const QUESTIONS = byCat("question");
const SOCIALS = byCat("social");
const RELATIONS = byCat("relation");
const CONNECTIVES = byCat("connective");
const QUANTITIES = byCat("quantity");
const ATTRIBUTES = byCat("attribute");

const MOVEMENT = new Set(["go", "come", "follow", "run", "chase"]);
/** Verbs whose object is optional (self-care / intransitives) — a bare verb
 *  command is already meaningful ("you sleep", "you stop"). */
const OBJECT_OPTIONAL = new Set([
  "eat", "drink", "sleep", "rest", "play", "talk", "wash", "clean", "brush_teeth",
  "sit", "wake_up", "wear", "stop", "stay", "wait", "run", "turn", "come", "go", "build", "help", "hug",
]);
/** High-frequency opener verbs (concept-parser.md "core 40"). */
const OPENER_VERBS = ["want", "go", "give", "get", "help", "make", "eat", "play"];

const head = (token: string): string => token.replace(/#\w+/g, "").split(".")[0] ?? token;
const lexOf = (token: string) => LEXICON[head(token)];

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** Slot priority: the most semantically FORCED first. */
const TIER: Record<SlotNeed, number> = {
  "relation-noun": 100,
  "question-focus": 90,
  condition: 85,
  recipient: 80,
  destination: 80,
  object: 70,
  verb: 60,
  attribute: 55,
  opener: 50,
  connective: 20,
  quantity: 10,
};

export function surfaceNext(tokens: string[], ctx: SurfaceContext): SurfaceSuggestion {
  const capacity = ctx.capacity ?? 16;
  const nounBy = new Map(ctx.nouns.map((n) => [n.symbol, n] as const));
  const recencyRank = new Map((ctx.recency?.mentioned ?? []).map((m, i) => [m.symbol, i] as const));

  const sentence = tokens.join(" + ");
  const frame: IntentFrame | null = tokens.length ? parseSentence(sentence, ctx.parse ?? {}) : null;

  const buttons = new Map<string, SurfaceButton>();
  const open: SlotNeed[] = [];
  /** §3.1: the property group the composed verb pre-loads (set once a verb is
   *  in play; the board opens that sub-tab). */
  let subTab: ObjectProperty | undefined;
  const wants = (property: ObjectProperty) => (n: SurfaceNoun) =>
    (n.properties ?? []).includes(property);
  /** Add a candidate word for a role; first (highest-tier) role wins a symbol. */
  const add = (symbol: string, role: SlotNeed, bonus = 0) => {
    if (buttons.has(symbol)) return;
    const rec = recencyRank.get(symbol);
    const recBonus = rec !== undefined ? Math.max(0, 3 - rec) : 0;
    buttons.set(symbol, {
      symbol,
      ...(nounBy.get(symbol)?.label ? { label: nounBy.get(symbol)!.label! } : {}),
      role,
      weight: TIER[role] + bonus + recBonus,
    });
  };
  const openRole = (role: SlotNeed) => {
    if (!open.includes(role)) open.push(role);
  };

  const nounsOf = (pred: (n: SurfaceNoun) => boolean): SurfaceNoun[] => ctx.nouns.filter(pred);
  const addNouns = (role: SlotNeed, pred: (n: SurfaceNoun) => boolean, bonus = 0) => {
    openRole(role);
    for (const n of nounsOf(pred)) add(n.symbol, role, bonus);
  };

  const last = tokens[tokens.length - 1];
  const lastLex = last !== undefined ? lexOf(last) : undefined;

  // ── Stage: hard-forced continuations ──────────────────────────────────────
  if (lastLex?.cat === "relation") {
    // A dangling relation binds the NEXT noun — nothing else is legal.
    const rel = (lastLex as { rel: string }).rel;
    const want = rel === "to" || rel === "with" || rel === "for" ? "creature" : "place";
    addNouns("relation-noun", (n) => n.kind === want || n.kind === "unknown", 5);
    addNouns("relation-noun", () => true);
    add("i_me", "relation-noun", 4);
    add("you", "relation-noun", 4);
    return finalize();
  }

  // ── Stage: empty sentence — openers (hybrid words + type chips) ───────────
  if (!frame) {
    const seed = ctx.seedKind;
    openRole("opener");
    if (!seed || seed === "greet") for (const s of SOCIALS) add(s, "opener", seed ? 6 : 2);
    if (!seed || seed === "ask") {
      for (const q of QUESTIONS) add(q, "opener", seed ? 6 : 3);
      if (seed) addNouns("question-focus", () => true);
    }
    if (!seed || seed === "request") {
      add("i_me", "opener", seed ? 6 : 4);
      add("want", "opener", seed ? 6 : 4);
      if (seed) addNouns("object", () => true);
    }
    if (!seed || seed === "state") {
      add("i_me", "opener", 3);
      if (seed) {
        addNouns("object", () => true, 4);
        for (const a of ATTRIBUTES) add(a, "opener", 2);
      }
    }
    if (!seed || seed === "command") {
      add("you", "opener", seed ? 6 : 4);
      for (const v of seed ? VERBS : OPENER_VERBS) add(v, "opener", seed ? 3 : 1);
      addNouns("opener", (nn) => nn.kind === "creature", seed ? 4 : 2);
    }
    if (!seed || seed === "rule") {
      add("when", "opener", seed ? 6 : 1);
      add("if", "opener", seed ? 6 : 1);
    }
    // Recent nouns keep a band on the first page — "things we just talked about".
    for (const m of ctx.recency?.mentioned ?? []) if (nounBy.has(m.symbol)) add(m.symbol, "opener", 3);
    return finalize(tokens.length === 0);
  }

  // ── Stage: mid-sentence — derive open slots from the partial frame ────────
  const verb = frame.verb;
  const hasObject = !!frame.object;
  const hasTarget = !!frame.target;
  const lastIsQuestion = lastLex?.cat === "question";
  const lastIsConnective = lastLex?.cat === "connective";

  if (lastIsConnective) {
    const role = (lexOf(last!) as { role?: string }).role;
    if (role === "condition") {
      // when/if/until — the trigger vocabulary: states of the world/creatures.
      openRole("condition");
      for (const a of ATTRIBUTES) add(a, "condition", 3);
      add("night", "condition", 4); // rules.ts worldState vocabulary
      addNouns("condition", (nn) => nn.kind !== "place");
    } else {
      // and/then/but — a fresh clause: verbs + nouns restart.
      openRole("verb");
      for (const v of VERBS) add(v, "verb", 1);
      addNouns("object", () => true);
    }
    return finalize();
  }

  if (lastIsQuestion) {
    const q = (lexOf(last!) as { q: string }).q;
    openRole("question-focus");
    if (q === "where") {
      addNouns("question-focus", () => true, 3);
      add("you", "question-focus", 4);
    } else if (q === "how" || q === "who") {
      addNouns("question-focus", (nn) => nn.kind === "creature", 4);
      add("you", "question-focus", 4);
    } else {
      add("want", "question-focus", 4); // "what + want + …"
      addNouns("question-focus", () => true);
    }
    return finalize();
  }

  if (verb && !hasObject && !hasTarget) {
    if (MOVEMENT.has(verb)) {
      // A movement verb wants a DESTINATION.
      addNouns("destination", (nn) => nn.kind === "place", 5);
      addNouns("destination", (nn) => nn.kind === "creature", 3);
      add("home", "destination", 4);
      add("here", "destination", 2);
      add("there", "destination", 2);
    } else {
      // The verb's object. §3.1 first: the PROPERTY the verb wants leads (an
      // `eat` surfaces every food, whether or not that food's own affordance
      // list happens to name the verb) — then nouns that afford it, then the
      // rest. Property before affordance is what makes the group predictable.
      subTab = PROPERTY_FOR_VERB[verb];
      if (subTab) addNouns("object", wants(subTab), 7);
      addNouns("object", (nn) => nn.affords.includes(verb), 6);
      addNouns("object", () => true);
      if (verb === "help" || verb === "hug" || verb === "talk") {
        add("i_me", "object", 4);
        add("you", "object", 2);
      }
    }
  } else if (verb && hasObject && !hasTarget) {
    const meta = LEXICON[verb];
    const transfer = meta?.cat === "verb" && (meta as { transfer?: boolean }).transfer;
    const implied = meta?.cat === "verb" ? (meta as { implied?: string }).implied : undefined;
    if (transfer || implied === "to") {
      addNouns("recipient", (nn) => nn.kind === "creature", 5);
      add("i_me", "recipient", 4);
      add("to", "recipient", 3);
    }
    if (implied === "in") {
      // "put + ball + …" wants a CONTAINER — the same §3.1 table, read for the
      // destination slot rather than the object slot.
      subTab = PROPERTY_FOR_VERB[verb];
      if (subTab) addNouns("destination", wants(subTab), 6);
      addNouns("destination", (nn) => nn.kind === "place", 5);
      add("in", "destination", 3);
    }
    // Joins that extend any complete verb phrase.
    openRole("connective");
    for (const c of CONNECTIVES) add(c, "connective");
    for (const r of RELATIONS) add(r, "connective");
  } else if (!verb) {
    // Nouns/persons without a verb: the nouns' own affordances pick the verbs
    // (composeNeed reversed) — an apple surfaces eat/get/give, a place go.
    const named = tokens.map(head).filter((h) => nounBy.has(h));
    openRole("verb");
    const afforded = new Set<string>();
    for (const h of named) for (const v of nounBy.get(h)!.affords) afforded.add(v);
    for (const v of VERBS) add(v, "verb", afforded.has(v) ? 6 : 0);
    // Attribute continuations make a STATEMENT ("apple + hot", "mara + hungry")
    // — below the verbs (the noun's own affordances lead).
    for (const a of ATTRIBUTES) add(a, "attribute");
    if (named.length && !frame.subject) {
      add("i_me", "opener", 1);
      add("you", "opener", 1);
    }
  } else {
    // A saturated frame — extensions only: connectives, quantities.
    openRole("connective");
    for (const c of CONNECTIVES) add(c, "connective");
    openRole("quantity");
    for (const q of QUANTITIES) add(q, "quantity");
  }

  return finalize();

  // ── Budget + verdicts ──────────────────────────────────────────────────────
  function finalize(showTypeChips = false): SurfaceSuggestion {
    const ranked = [...buttons.values()].sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      const ao = lexOrder.get(a.symbol);
      const bo = lexOrder.get(b.symbol);
      if (ao !== undefined && bo !== undefined && ao !== bo) return ao - bo;
      if (ao !== undefined && bo === undefined) return -1;
      if (ao === undefined && bo !== undefined) return 1;
      return a.symbol < b.symbol ? -1 : 1;
    });
    // Reserve one representative per open role, then fill by rank.
    const chosen: SurfaceButton[] = [];
    const seen = new Set<string>();
    for (const role of open) {
      const rep = ranked.find((b) => b.role === role && !seen.has(b.symbol));
      if (rep && chosen.length < capacity) {
        chosen.push(rep);
        seen.add(rep.symbol);
      }
    }
    for (const b of ranked) {
      if (chosen.length >= capacity) break;
      if (!seen.has(b.symbol)) {
        chosen.push(b);
        seen.add(b.symbol);
      }
    }
    chosen.sort((a, b) => b.weight - a.weight || (a.symbol < b.symbol ? -1 : 1));
    const categories = openCategories();
    return {
      buttons: chosen,
      typeChips: showTypeChips ? [...TYPE_CHIPS] : [],
      categories,
      complete: isComplete(),
      open: [...open].sort((a, b) => TIER[b] - TIER[a]),
      ...(subTab ? { subTab } : {}),
    };
  }

  function openCategories(): string[] {
    const cats = new Set<string>();
    for (const b of buttons.values()) {
      const lx = LEXICON[b.symbol];
      cats.add(lx ? (lx as { cat: string }).cat : "things");
    }
    return [...cats].sort();
  }

  function isComplete(): boolean {
    if (!frame) return false;
    // A leading condition connective without a compiled rule ("when + night")
    // is a dangling trigger, whatever the fallback classification says.
    const first = tokens[0] !== undefined ? lexOf(tokens[0]) : undefined;
    if (first?.cat === "connective" && frame.kind !== "rule" && frame.kind !== "sequence") return false;
    switch (frame.kind) {
      case "greet":
      case "farewell":
      case "affirm":
      case "decline":
      case "acknowledge":
      case "thank":
      case "apologize":
      case "claim":
      case "again":
        return true;
      case "ask":
        return !!(frame.question || frame.polar) && !!(frame.object || frame.subject || frame.verb);
      case "state":
        return !!(frame.object || frame.subject || frame.modifiers.length);
      case "request":
      case "offer":
        return !!frame.object;
      case "command": {
        const v = frame.verb;
        if (!v) return false;
        if (frame.object || frame.target) return true;
        return OBJECT_OPTIONAL.has(v);
      }
      case "rule":
        return !!frame.condition && !!frame.verb;
      case "sequence":
        return (frame.clauses ?? []).length > 0;
      default:
        return false;
    }
  }
}
