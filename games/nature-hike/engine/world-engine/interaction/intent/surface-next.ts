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
// RANKING (three deterministic layers, most specific first):
//   1. ROLE TIERS — the unfilled slot the word would fill (TIER).
//   2. TRANSITIONS — bonuses derived from the frame + lexicon metadata: a
//      speaker subject boosts state verbs and feelings, a listener subject
//      boosts directives, a quantity opens nouns, a greeting opens addressees,
//      nouns boost the descriptor AXES their properties bind
//      (object-properties.ts). Semantics-derived, never phrase pairs.
//   3. FREQUENCY — a static core-vocabulary prior (CORE_RANK) breaks every
//      tie, so "want" beats "drop" wherever both are legal. The player's own
//      habits (RecencyMemory use/pair counts) add small learned bonuses.
//
// SURFACE CONTRACT (user decision): WORDS (speakable) and CONTROLS are
// separate outputs the UI renders visually distinct. Controls come in three
// forms: sentence-type chips (seed `seedKind`), GROUP chips (`groups` — ranked
// property/kind clusters that expand in place without consuming a word), and
// category tabs (the graceful-degradation ladder when all else fails).
// Synonym families (VERB_FAMILY, one social per act) surface only their
// canonical head — the full family stays reachable through the tabs.

import {
  canonicalVerb,
  LEXICON,
  MODAL_VERBS,
  parseSentence,
  STATE_VERBS,
  type IntentFrame,
  type IntentKind,
  type ParseContext,
} from "./parse-intent.js";
import {
  AXIS_WORDS,
  DESCRIPTOR_AXES_FOR_VERB,
  descriptorAxesFor,
  isObjectProperty,
  PROPERTY_FOR_VERB,
  type DescriptorAxis,
  type ObjectProperty,
} from "../../object-properties.js";
import { headOf } from "../../variations.js";
import { isMakeable } from "../content/makeable.js";
import { SELF_NEEDS } from "./intent-compile.js";

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
  | "addressee"
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

/** A GROUP CONTROL (user decision): a ranked cluster of likely words rendered
 *  as a chip that expands in place — it opens options, it never adds a word.
 *  `kind` says what clustered it: an object property ("food"), a noun kind
 *  ("creatures"/"places"/"things"), or an ACTION category ("do"/"play"/
 *  "make"/"get" — the verb families a modal desire opens). Members are the
 *  FULL ranked expansion — a filter view, so inline words may repeat inside
 *  their group. */
export interface SurfaceGroup {
  id: string;
  kind: "property" | "kind" | "verb";
  role: SlotNeed;
  weight: number;
  members: SurfaceButton[];
  /**
   * THE CHIP'S FACE: the members that best REPRESENT the cluster, best first
   * (≤ GROUP_EXEMPLARS). A separate list from `members` on purpose — the
   * expansion stays in surfacing-rank order (what to say next), while the face
   * answers a different question (what does this category LOOK like), so
   * [container] wears a box rather than whichever word sorted first.
   */
  exemplars: SurfaceButton[];
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
  /** Ranked group chips — likely subcategories that expand without speaking. */
  groups: SurfaceGroup[];
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
  /** Capped per-head use counts across the player's own utterances — the
   *  learned word-frequency habit. */
  uses?: { key: string; n: number }[];
  /** Capped adjacent-pair counts ("a>b") — the learned bigram habit ("this
   *  player says want+juice"), boosting b when a was just composed. */
  pairs?: { key: string; n: number }[];
}

export const emptyRecency = (): RecencyMemory => ({ mentioned: [], utterances: 0 });

const RECENCY_CAP = 8;
const USES_CAP = 24;
const PAIRS_CAP = 32;

/** Bump `keys` into a capped count list, deterministically (count desc, then
 *  key asc — no wall-clock eviction). */
function bumpCounts(list: { key: string; n: number }[], keys: string[], cap: number): { key: string; n: number }[] {
  const counts = new Map(list.map((e) => [e.key, e.n] as const));
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, n]) => ({ key, n }))
    .sort((a, b) => b.n - a.n || (a.key < b.key ? -1 : 1))
    .slice(0, cap);
}

/** Record a completed utterance (call after a successful speak): mentioned
 *  nouns, per-word use counts, and adjacent word pairs. */
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
  const heads = frame.raw.map(head).filter(Boolean);
  const pairKeys: string[] = [];
  for (let i = 0; i + 1 < heads.length; i++) pairKeys.push(`${heads[i]}>${heads[i + 1]}`);
  return {
    mentioned,
    utterances: at,
    uses: bumpCounts(mem.uses ?? [], heads, USES_CAP),
    pairs: bumpCounts(mem.pairs ?? [], pairKeys, PAIRS_CAP),
  };
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
const RELATIONS = byCat("relation");
const CONNECTIVES = byCat("connective");
const QUANTITIES = byCat("quantity");
const ATTRIBUTES = byCat("attribute");

/** SYNONYM COLLAPSE (user decision): bulk verb bands surface only each
 *  family's canonical head (get, not take; go, not come/walk/run) — the family
 *  compiles to one primitive, so its members waste grid slots. The full family
 *  stays reachable through the category tabs, and affordance matching is
 *  family-aware (a noun affording "take" still boosts "get"). */
const CANONICAL_VERBS = VERBS.filter((v) => canonicalVerb(v) === v);
/** One social per act (hi, not hello; ok, not okay) — first per lexicon order. */
const CANONICAL_SOCIALS = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of byCat("social")) {
    const act = (LEXICON[s] as { act: string }).act;
    if (!seen.has(act)) {
      seen.add(act);
      out.push(s);
    }
  }
  return out;
})();

const MOVEMENT = new Set(["go", "come", "walk", "follow", "run", "chase"]);
/** Verbs whose object is optional (self-care / intransitives) — a bare verb
 *  command is already meaningful ("you sleep", "you stop"). Doubles as the
 *  SELF-ACTIVITY band a speaker subject boosts ("i_me + eat/sleep/play"). */
const OBJECT_OPTIONAL = new Set([
  "eat", "drink", "sleep", "rest", "play", "talk", "wash", "tidy", "brush_teeth",
  "sit", "wake_up", "wear", "stop", "stay", "wait", "run", "walk", "turn", "come", "go", "build", "help", "hug",
]);
/** High-frequency opener verbs (concept-parser.md "core 40"). */
const OPENER_VERBS = ["want", "go", "give", "get", "help", "make", "eat", "play", "see"];

/**
 * THE ACTION CATEGORIES a modal desire opens ("i_me + want + ___" — user
 * decision 2026-08-12): a desire is not only for THINGS. "I want to eat",
 * "I need to go" are first-page sentences, and the verb vocabulary that can
 * follow a desire is far too broad for any grid — so the breadth ships as
 * GROUP chips, one per broad family of doing, while the few actions this
 * child actually reaches for ride inline (the frequency prior, personalized
 * by the learned layer).
 *
 * Ids are lang-lexicon HEADS on purpose: the adapter labels a chip through
 * `baseWord`, so [do]/[play]/[make]/[get] localize with no new vocabulary.
 * Members are canonical family heads only (the synonym-collapse law) — the
 * full families stay reachable through the verb tab. `stop` is deliberately
 * absent: beside a modal it parses as a PHASE operator, not a wish.
 *
 * These cluster WORDS, never scene state: whether an action makes sense for
 * the current body (a bodiless spirit cannot brush teeth) is the host's
 * business when the sentence lands — out of the game the builder must still
 * offer the whole set, because "I want to sleep" is a sentence a student
 * needs at school far more often than in any game.
 */
const ACTION_CATEGORIES: readonly { id: string; verbs: readonly string[] }[] = [
  // Everyday activities of one's own body — the self-care set plus movement.
  { id: "do", verbs: ["eat", "drink", "sleep", "rest", "sit", "wake_up", "brush_teeth", "wear", "wash", "tidy", "go", "stay", "turn", "return", "see"] },
  // Doing things WITH people.
  { id: "play", verbs: ["play", "talk", "help", "hug", "show", "share", "teach", "follow", "fight"] },
  // Making and working.
  { id: "make", verbs: ["make", "build", "fix", "break", "dig", "plant", "cut", "color", "fill", "empty", "heat", "cook"] },
  // Things changing hands and states.
  { id: "get", verbs: ["get", "give", "put", "drop", "throw", "open", "shut", "carry", "push", "pull", "trade"] },
];
/** How many actions ride INLINE beside the noun bands after a modal verb. */
const MODAL_INLINE_ACTIONS = 5;

/** TRANSPORT VERBS — the ones that MOVE A THING to an endpoint. Their `to` does
 *  not have to point at a body: "bring + wood + to + yard" ends at a place and
 *  compiles to the same `putIn` that "put + wood + in + yard" does. So after one
 *  of these, `to` opens places and containers alongside the recipients; every
 *  other verb keeps `to` = whom. */
const TRANSPORT_VERBS = new Set(["carry", "bring", "put", "drop", "throw"]);

/** A class of noun, named from either side of the one vocabulary: an object
 *  PROPERTY (what a thing is for) or a noun KIND (what sort of thing it is). */
type NounClass = ObjectProperty | "creature" | "place" | "item";

const isClass = (n: SurfaceNoun, c: NounClass): boolean =>
  isObjectProperty(c) ? (n.properties ?? []).includes(c) : n.kind === c;

/**
 * WHAT EACH LINK POINTS AT. A preposition is not a generic noun slot: every one
 * names a relation with its OWN kind of second argument, and the board should
 * say so. `in` wants something that holds things; `on` something with a surface
 * to hold them up; the proximity and facing links want an anchor that
 * physically stands somewhere (furniture first, then the room itself); `from`
 * wants a source — what a thing comes out of, or whom it comes from; and the
 * social links (to/with/for) want a body.
 *
 * Tiers, strongest first. This RANKS, it never filters — the universal band
 * still offers every noun underneath, so no composition is ever blocked by a
 * classification the library happened not to carry.
 *
 * Keyed by the LEXICON's `rel`, never by the board word, so `next_to`/`beside`
 * and `in_front_of`/`front` share one entry by construction.
 */
const LINK_TARGETS: Readonly<Record<string, readonly (readonly NounClass[])[]>> = {
  in: [["container"], ["place"]],
  on: [["furniture", "tableware", "appliance"], ["place"]],
  under: [["furniture"], ["place"]],
  over: [["furniture"], ["place"]],
  behind: [["furniture"], ["place"]],
  front: [["furniture"], ["place"]],
  beside: [["furniture"], ["place"]],
  near: [["furniture"], ["place"]],
  from: [["container", "creature"], ["place"]],
  to: [["creature"]],
  with: [["creature"]],
  for: [["creature"]],
};

/**
 * WHAT A SWAP'S LINKS POINT AT. `with` and `for` are the two words whose second
 * argument is not decided by the preposition alone: a trade borrows them for
 * terms that are not social at all. After `trade`, `with` names the PARTNER —
 * a body OR a settlement, since a town trades as readily as a person does — and
 * `for` names the counter-GOOD, which is stock and never anybody. Everywhere
 * else they keep their social readings ("eat + with + mara" is company, "get +
 * apple + for + mara" is a beneficiary), so this REPLACES those two entries
 * after a trade instead of adding a rung to them.
 *
 * Read off `frame.verb` exactly as the transport `to` rung is — frame
 * semantics, never the scene, and never a phrase list. It still only RANKS: the
 * universal band underneath offers every noun regardless.
 */
const TRADE_LINK_TARGETS: Readonly<Record<string, readonly (readonly NounClass[])[]>> = {
  // Bodies lead, settlements behind them — the same order the trade band itself
  // uses once the give-good is named (creatures +4, places +3), so the board
  // does not change its mind about who a partner is between two presses.
  with: [["creature"], ["place"]],
  // The take-good: the stock a town actually asks for (grain, timber) first,
  // then anything else a hand can carry. Creatures fall to the universal band —
  // you trade wood FOR bread, never for the baker.
  for: [["food", "material"], ["item"]],
};

/** THE SPATIAL LINK BAND for the put family (`implied: "in"`), best first.
 *  WHICH link leads is the OBJECT's business: a piece of furniture is placed
 *  RELATIVE to what already stands there and never dropped inside it, so the
 *  adjacency words lead for one; anything a hand can carry goes INTO or ONTO
 *  something, so containment leads for the other. Both keep the whole set —
 *  every link a physical anchor can support stays one press away. */
const PLACEMENT_LINKS: Readonly<Record<"furniture" | "movable", readonly (readonly [string, number])[]>> = {
  furniture: [["next_to", 4], ["near", 3], ["in", 3], ["on", 2], ["under", 1], ["behind", 1], ["in_front_of", 1]],
  movable: [["in", 3], ["on", 2], ["next_to", 1], ["near", 1], ["under", 1], ["behind", 1], ["in_front_of", 1]],
};

/** THE FREQUENCY PRIOR: AAC core-vocabulary order (most frequent first). It
 *  breaks every rank tie — so within any legal band the child's most likely
 *  words lead, instead of the lexicon's authoring order. Static data; the
 *  learned layer (RecencyMemory) personalizes on top. */
const CORE_RANK: readonly string[] = [
  "want", "go", "more", "eat", "no", "yes", "help", "play", "stop", "drink",
  "get", "give", "open", "put", "make", "i_me", "you", "this", "that", "here", "there",
  "need", "like", "have", "feel", "do", "sleep", "wash", "sit", "hug", "talk",
  "hi", "bye", "thanks", "again", "mine", "ok", "sorry",
  "where", "what", "who", "why", "how",
  "and", "then", "because", "but", "when", "if", "or", "so", "until",
  "to", "in", "on", "with", "for", "from", "under", "near", "next_to",
  "big", "small", "hot", "cold", "good", "bad",
  "hungry", "thirsty", "tired", "happy", "sad", "sick",
  "one", "two", "three", "many", "all", "less", "none",
];
const FREQ = new Map(CORE_RANK.map((w, i) => [w, i] as const));
const freqRank = (symbol: string): number => FREQ.get(symbol) ?? Number.MAX_SAFE_INTEGER;

/**
 * THE PROTOTYPE PRIOR — the CONCRETE-NOUN counterpart of CORE_RANK, most
 * familiar first. CORE_RANK covers the function words a child says most; this
 * covers the things they can point at, which is a different question and needs
 * its own answer (no ranking of "want" against "apple" is meaningful).
 *
 * It never touches the board's word ORDER. Its only job is choosing which
 * members a group chip WEARS AS ITS FACE, where the question is "what does
 * this category look like?" — a category answers that best with its most
 * ordinary member, so [food] shows an apple and [container] a box, instead of
 * whatever the alphabet happened to put first (a barrel).
 *
 * Symbols the running world doesn't know are simply inert, so this stays a
 * prior over the vocabulary rather than a claim about any one game's contents.
 */
const PROTOTYPE_NOUNS: readonly string[] = [
  // Food and drink — the everyday plate first, the harvest behind it.
  "apple", "banana", "cookie", "water", "milk", "bread", "grape", "meat", "cheese", "broccoli",
  // Play
  "ball", "blocks", "doll", "bear", "puzzle", "car", "train", "boat", "bubbles", "sparks",
  // Wearing
  "shirt", "hat", "sock", "shoe", "dress", "coat", "scarf",
  // The furniture a room is recognized by. Ahead of the places band on
  // purpose: a couple of words (`bath`) name BOTH a room and the fixture in
  // it, and as a picture of furniture the tub is the better example.
  "bed", "chair", "table", "door", "window", "lamp", "shelf",
  // Places — home outward
  "home", "house", "bedroom", "kitchen", "bathroom", "living", "yard", "garden",
  "school", "shop", "park", "street", "town",
  // Holding things — ahead of the appliances, which hold things only among
  // everything else they are.
  "box", "basket", "bag", "satchel", "bowl", "cup", "plate", "chest", "bin", "barrel",
  // The working end of a house
  "oven", "refrigerator", "cupboard", "bath", "toilet", "workbench", "anvil", "loom",
  "stonecutter", "altar",
  // Reading, making, building
  "book", "paper", "wood", "stone", "block", "cloth", "wool",
  // People and animals
  "mama", "papa", "baby", "girl", "boy", "friend", "person", "dog", "cat", "rabbit", "bird",
  "frog", "sheep", "cow", "horse",
];
const PROTOTYPE = new Map(PROTOTYPE_NOUNS.map((w, i) => [w, i] as const));

/** How many faces a group chip can wear (the builder draws them as a cluster). */
export const GROUP_EXEMPLARS = 3;

/**
 * Order candidates by how well each REPRESENTS a category, best first: the
 * prototype prior, then property PURITY (a thing that is little else besides
 * this reads as the cleaner example of it — a box says "container" more plainly
 * than a refrigerator does), then whatever order the caller already had (the
 * sort is stable, so a ranked list keeps its ranking as the final tiebreak).
 *
 * Exported because both group surfaces need the same answer: the surfacer's own
 * clusters here, and the builder-surface adapter's "things"-tab clusters.
 */
export function exemplarOrder<T>(
  items: readonly T[],
  symbolOf: (item: T) => string,
  propertiesOf: (item: T) => readonly string[] | undefined,
): T[] {
  const rank = (t: T) => PROTOTYPE.get(headOf(symbolOf(t))) ?? Number.MAX_SAFE_INTEGER;
  return [...items].sort((a, b) => {
    const ar = rank(a);
    const br = rank(b);
    if (ar !== br) return ar - br;
    return (propertiesOf(a)?.length ?? 0) - (propertiesOf(b)?.length ?? 0);
  });
}

const head = (token: string): string => headOf(token.replace(/#\w+/g, ""));
const lexOf = (token: string) => LEXICON[head(token)];
const isDirective = (v: string): boolean => {
  const lx = LEXICON[v];
  return lx?.cat === "verb" && (lx as { directive: boolean }).directive;
};

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
  addressee: 75,
  object: 70,
  verb: 60,
  attribute: 55,
  opener: 50,
  connective: 20,
  quantity: 10,
};

/** Per-role inline quotas (finalize): floods truncate to these, leaving grid
 *  room for the words that matter. No backfill past a quota — a small board of
 *  RIGHT buttons beats a full board of joiners (language-expansion.md). */
const QUOTA: Partial<Record<SlotNeed, number>> = {
  connective: 3,
  quantity: 2,
  attribute: 5,
  /** ⑫ — a circle caps at five, so four names could crowd out the sentence the
   *  child is actually building. The reservation loop still guarantees ONE name
   *  is always reachable; this only stops the rest from flooding the grid. */
  addressee: 2,
};

const MAX_GROUPS = 5;

export function surfaceNext(tokens: string[], ctx: SurfaceContext): SurfaceSuggestion {
  const capacity = ctx.capacity ?? 16;
  const nounBy = new Map(ctx.nouns.map((n) => [n.symbol, n] as const));
  const recencyRank = new Map((ctx.recency?.mentioned ?? []).map((m, i) => [m.symbol, i] as const));
  const usesN = new Map((ctx.recency?.uses ?? []).map((e) => [e.key, e.n] as const));
  const pairsN = new Map((ctx.recency?.pairs ?? []).map((e) => [e.key, e.n] as const));

  const sentence = tokens.join(" + ");
  // The parse gets an entity classifier from the noun library (unless the host
  // supplied one) — the same knowledge the buttons rank by, so a bare "bed"
  // classifies as a place command rather than an opaque mention.
  const parseCtx: ParseContext = {
    classifyEntity: (s) => nounBy.get(s)?.kind ?? "unknown",
    ...(ctx.parse ?? {}),
  };
  const frame: IntentFrame | null = tokens.length ? parseSentence(sentence, parseCtx) : null;
  // ⑫ — the speaker's own conversation, read off the SAME field the parser uses
  // so the board and the frame can never disagree about who is standing there.
  // Two or more fellow members = a 3+ conversation, which is the only shape with
  // anything to disambiguate (law ④: a dyad needs no addressing at all).
  const roster = parseCtx.addressees ?? [];
  const inCircle = roster.length >= 2;
  const rosterHas = (sym: string): boolean => roster.some((a) => a.toLowerCase() === sym.toLowerCase());

  const last = tokens[tokens.length - 1];
  const lastLex = last !== undefined ? lexOf(last) : undefined;
  const lastHead = last !== undefined ? head(last) : undefined;

  const buttons = new Map<string, SurfaceButton>();
  const open: SlotNeed[] = [];
  /** §3.1: the property group the composed verb pre-loads (set once a verb is
   *  in play; the board opens that sub-tab). */
  let subTab: ObjectProperty | undefined;
  /** The modal ACTION PATH is open ("i_me + want + ___") — finalize adds the
   *  action-category chips beside the noun groups. */
  let actionBand = false;
  const wants = (property: ObjectProperty) => (n: SurfaceNoun) =>
    (n.properties ?? []).includes(property);
  /** Words already composed never re-surface — except joiners/quantities,
   *  which legitimately repeat ("… and … and …"). */
  const saidHeads = new Set(tokens.map(head));
  const REPEATABLE = new Set(["connective", "relation", "quantity"]);
  /** Add a candidate word for a role; first (highest-tier) role wins a symbol.
   *  Learned layers ride on top: recency band, use counts, last-word pairs. */
  const add = (symbol: string, role: SlotNeed, bonus = 0) => {
    if (buttons.has(symbol)) return;
    if (saidHeads.has(symbol) && !REPEATABLE.has((LEXICON[symbol] as { cat?: string } | undefined)?.cat ?? "")) return;
    const rec = recencyRank.get(symbol);
    const recBonus = rec !== undefined ? Math.max(0, 3 - rec) : 0;
    const useBonus = Math.min(2, Math.max(0, (usesN.get(symbol) ?? 0) - 1));
    const pairBonus = lastHead !== undefined ? Math.min(3, pairsN.get(`${lastHead}>${symbol}`) ?? 0) : 0;
    buttons.set(symbol, {
      symbol,
      ...(nounBy.get(symbol)?.label ? { label: nounBy.get(symbol)!.label! } : {}),
      role,
      weight: TIER[role] + bonus + recBonus + useBonus + pairBonus,
    });
  };
  const openRole = (role: SlotNeed) => {
    if (!open.includes(role)) open.push(role);
  };

  const nounsOf = (pred: (n: SurfaceNoun) => boolean): SurfaceNoun[] => ctx.nouns.filter(pred);
  /** COMPANY JOINS for an activity verb — "eat + together", "play + with + …".
   *  Lifted out of the generic relation band for exactly the reason the
   *  placement relations were: buried under and/then/because, the one word a
   *  composer is most likely to want next is the one they never find. Frame
   *  semantics only (is this verb an activity?) — the builder stays blind to
   *  whether anyone is actually around to do it with, which is the context
   *  board's business, not this one's. */
  const addCompanyJoins = (v: string | undefined) => {
    if (!v || !SELF_NEEDS.has(canonicalVerb(v))) return;
    add("together", "connective", 5);
    add("with", "connective", 4);
  };
  const addNouns = (role: SlotNeed, pred: (n: SurfaceNoun) => boolean, bonus = 0) => {
    openRole(role);
    for (const n of nounsOf(pred)) add(n.symbol, role, bonus);
  };
  /** Descriptor-axis bonuses (object-properties.ts) for the attribute band:
   *  the axes bound by the nouns in play (and the subject's animacy) rank the
   *  descriptor words — food talks temperature, creatures talk feelings.
   *  `animate: "strong"` (an explicit i_me) lifts the emotion words INTO the
   *  main band — "i_me + hungry/happy" is a first-page utterance. */
  const attributeAxisBonus = (namedHeads: string[], animate: false | "weak" | "strong"): Map<string, number> => {
    const bonus = new Map<string, number>();
    const applyAxes = (axes: readonly DescriptorAxis[]) => {
      axes.forEach((axis, i) => {
        const b = Math.max(1, 6 - i);
        for (const w of AXIS_WORDS[axis]) if ((bonus.get(w) ?? 0) < b) bonus.set(w, b);
      });
    };
    for (const h of namedHeads) {
      const n = nounBy.get(h);
      if (n) applyAxes(descriptorAxesFor(n.kind, n.properties ?? []));
    }
    if (animate) applyAxes(descriptorAxesFor("creature", []));
    if (animate === "strong") {
      for (const w of [...AXIS_WORDS.bodily, ...AXIS_WORDS.mood]) bonus.set(w, 9);
    }
    return bonus;
  };
  /** Family-aware affordance test: a noun affording "take" boosts "get". */
  const affordsVerb = (n: SurfaceNoun, verb: string): boolean => {
    const want = canonicalVerb(verb);
    return n.affords.some((a) => canonicalVerb(a) === want);
  };

  // ── Stage: hard-forced continuations ──────────────────────────────────────
  if (lastLex?.cat === "relation") {
    // A dangling relation binds the NEXT noun — nothing else is legal. WHICH
    // noun is the link's own business (LINK_TARGETS): "in" asks for a box
    // before a bedroom, "on" for a table before a kitchen, "from" for the
    // container or the person a thing came out of. Two rungs are the FRAME's,
    // both read off the partial parse and never off the scene: a transport
    // verb's "to" ends at a place as readily as at a body ("bring + wood + to +
    // yard"), so its endpoint classes JOIN the band; and a trade's `with`/`for`
    // name a partner and a counter-good rather than company and a beneficiary,
    // so TRADE_LINK_TARGETS REPLACES those two entries. Beyond that the
    // surfacer stays context-blind.
    const rel = (lastLex as { rel: string }).rel;
    const trading = !!frame?.verb && canonicalVerb(frame.verb) === "trade";
    const tiers = [...((trading ? TRADE_LINK_TARGETS[rel] : undefined) ?? LINK_TARGETS[rel] ?? [])];
    if (rel === "to" && frame?.verb && TRANSPORT_VERBS.has(frame.verb)) tiers.push(["container", "place"]);
    tiers.forEach((classes, i) => {
      addNouns("relation-noun", (n) => classes.some((c) => isClass(n, c)), Math.max(1, 5 - 2 * i));
    });
    // A noun the classifier could not place is never JUDGED by a kind it does
    // not carry — it sits just above the universal band rather than below every
    // classified word.
    addNouns("relation-noun", (n) => n.kind === "unknown", 1);
    addNouns("relation-noun", () => true);
    add("i_me", "relation-noun", 4);
    add("you", "relation-noun", 4);
    return finalize();
  }

  if (lastLex?.cat === "quantity" && !frame?.object) {
    // A quantity wants the THING it measures ("more + water") — food first
    // (the everyday "more" is a food request), everything else close behind.
    addNouns("object", wants("food"), 3);
    addNouns("object", () => true);
    return finalize();
  }

  // ── Stage: empty sentence — openers (hybrid words + type chips) ───────────
  if (!frame) {
    const seed = ctx.seedKind;
    openRole("opener");
    if (!seed || seed === "greet") {
      if (seed) for (const s of CANONICAL_SOCIALS) add(s, "opener", 6);
      else {
        add("hi", "opener", 2);
        add("yes", "opener", 2);
        add("no", "opener", 2);
      }
    }
    if (!seed || seed === "ask") {
      if (seed) {
        for (const q of QUESTIONS) add(q, "opener", 6);
        addNouns("question-focus", () => true);
      } else {
        // Two question words carry the unseeded board; the ask chip has the rest.
        add("where", "opener", 3);
        add("what", "opener", 3);
      }
    }
    if (!seed || seed === "request") {
      add("i_me", "opener", seed ? 6 : 4);
      add("want", "opener", seed ? 6 : 4);
      add("more", "opener", seed ? 6 : 2);
      if (seed) addNouns("object", () => true);
    }
    // ⑫ — IN A CROWD, THE NAME IS AN OPENER. "mara + give + i_me + apple" starts
    // with the name, so a child asking one particular person for something needs
    // it on the very first board. Only in a 3+ conversation: in a dyad there is
    // nobody to disambiguate from (law ④) and the name would be clutter.
    if (inCircle && (!seed || seed === "request" || seed === "command")) {
      addNouns("addressee", (nn) => nn.kind === "creature" && rosterHas(nn.symbol), 4);
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
      for (const v of seed ? CANONICAL_VERBS : OPENER_VERBS) add(v, "opener", seed ? 3 : 1);
      addNouns("opener", (nn) => nn.kind === "creature", seed ? 4 : 2);
    }
    if (!seed || seed === "rule") {
      add("when", "opener", seed ? 6 : 1);
      add("if", "opener", seed ? 6 : 1);
    }
    // Recent nouns keep a band on the first page — "things we just talked about".
    for (const m of ctx.recency?.mentioned ?? []) if (nounBy.has(m.symbol)) add(m.symbol, "opener", 3);
    // Group chips over the WHOLE library ([food] [toys] [people]…) stand in
    // for the nouns the grid can't hold — the first press already offers them.
    return finalize(tokens.length === 0, true);
  }

  // ── Stage: a social opener addresses SOMEONE ("hi + mara") ────────────────
  if ((frame.kind === "greet" || frame.kind === "farewell") && !frame.verb && !frame.object) {
    addNouns("addressee", (nn) => nn.kind === "creature", 5);
    add("you", "addressee", 3);
    return finalize();
  }

  // ── ⑫ Stage: THE NAME CHANNEL, mid-sentence ───────────────────────────────
  // A request or an order aimed at ONE person in a crowd needs that person's
  // name — it is the channel that works with full hands and a body facing the
  // wrong way (law ②). NON-RETURNING, unlike the greet stage above: the rest of
  // the sentence still has to be sayable, so this only OPENS the role and lets
  // `finalize`'s reservation loop guarantee one name is always a press away.
  // Suppressed once a vocative is bound — the question has been answered.
  if (inCircle && !frame.vocative && (frame.kind === "request" || frame.kind === "command")) {
    addNouns("addressee", (nn) => nn.kind === "creature" && rosterHas(nn.symbol), 4);
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
      for (const v of CANONICAL_VERBS) add(v, "verb", 1);
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
    // A DESCRIPTOR-LIST verb ("feel") wants a feeling, never a thing — the
    // emotion axes lead, the rest of the descriptor vocabulary fills the grid.
    const verbAxes = DESCRIPTOR_AXES_FOR_VERB[verb];
    if (verbAxes) {
      openRole("attribute");
      const bonus = new Map<string, number>();
      verbAxes.forEach((axis, i) => {
        for (const w of AXIS_WORDS[axis]) if ((bonus.get(w) ?? 0) < 9 - i) bonus.set(w, 9 - i);
      });
      for (const a of ATTRIBUTES) add(a, "attribute", bonus.get(a) ?? 0);
      return finalize();
    }
    if (MOVEMENT.has(verb)) {
      // A movement verb wants a DESTINATION.
      addNouns("destination", (nn) => nn.kind === "place", 5);
      addNouns("destination", (nn) => nn.kind === "creature", 3);
      add("home", "destination", 4);
      add("here", "destination", 2);
      add("there", "destination", 2);
    } else if (canonicalVerb(verb) === "stay") {
      // STAY/WAIT name a POSITION TO HOLD, so the only question after them is
      // where — `{stay, place?}` is exactly the goal they compile to, and
      // without this band they fell through the generic object dump with no
      // boost at all. There is no `at` in the LEXICON and inventing one would
      // be a word the parser cannot read: `in` (inside a room) and `near` (by a
      // thing) carry the whole sense between them, with the gaze words for the
      // spot underfoot.
      addNouns("destination", (nn) => nn.kind === "place", 5);
      add("in", "destination", 3);
      add("near", "destination", 2);
      add("here", "destination", 2);
      add("there", "destination", 2);
      addNouns("object", () => true);
    } else {
      // The verb's object. §3.1 first: the PROPERTY the verb wants leads (an
      // `eat` surfaces every food, whether or not that food's own affordance
      // list happens to name the verb) — then nouns that afford it, then the
      // rest. Property before affordance is what makes the group predictable.
      subTab = PROPERTY_FOR_VERB[verb];
      if (subTab) addNouns("object", wants(subTab), 7);
      // MAKE vs BUILD (user law, 2026-07-28): the two verbs are interchangeable,
      // so each surfaces BOTH lists — they differ only in which leads. `make`
      // puts MOBILE items (toys, dolls of the animals and vehicles on the board,
      // furniture) at the front; `build` leads with structures via its
      // PROPERTY_FOR_VERB row above and offers the mobile ones underneath. This
      // is the surfacing half of the same rule intent-compile applies to the
      // parse, so what the builder offers and what the order does agree.
      if (verb === "make" || verb === "build") {
        addNouns("object", (nn) => isMakeable(headOf(nn.symbol)), verb === "make" ? 7 : 4);
      }
      // The desire verbs share ONE affordance channel: the library authors
      // `want` and only `want`, so a noun wantable under "want" leads under
      // "need"/"like" too — otherwise the need board demoted every noun and
      // read backwards from the want board beside it.
      addNouns("object", (nn) => affordsVerb(nn, MODAL_VERBS.has(verb) ? "want" : verb), 6);
      if (verb === "play") addNouns("object", (nn) => nn.kind === "creature", 3); // play WITH someone
      addNouns("object", () => true);
      if (verb === "help" || verb === "hug" || verb === "talk") {
        add("i_me", "object", 4);
        add("you", "object", 2);
      }
      // THE ACTION PATH (user decision 2026-08-12): after a BARE desire verb
      // ("i_me + want + ___") DOING is offered as readily as having — the
      // parser has read "want + play" as a modal wish all along, but the
      // board never suggested it, so the sentence existed only for a child
      // who already knew it did. The things a child wants still LEAD (the
      // noun bands above); a handful of most-likely actions ride inline —
      // picked by the child's own habit (pair/use counts), then the
      // frequency prior — and the full breadth ships as the action-category
      // chips finalize appends. Once an inner verb lands ("want + eat") the
      // frame carries `modal` and this stage stands down in favor of that
      // verb's own bands.
      if (MODAL_VERBS.has(verb) && !frame.modal) {
        openRole("verb");
        const wantable = ACTION_CATEGORIES.flatMap((c) => c.verbs);
        const habit = (v2: string): number =>
          (lastHead !== undefined ? (pairsN.get(`${lastHead}>${v2}`) ?? 0) * 8 : 0) + (usesN.get(v2) ?? 0);
        const likely = [...wantable].sort(
          (x, y) =>
            habit(y) - habit(x) ||
            freqRank(x) - freqRank(y) ||
            (lexOrder.get(x) ?? 0) - (lexOrder.get(y) ?? 0),
        );
        likely.slice(0, MODAL_INLINE_ACTIONS).forEach((v2, i) => add(v2, "verb", 12 - i));
        for (const v2 of wantable) add(v2, "verb");
        actionBand = true;
      }
    }
  } else if (verb && hasObject && !hasTarget) {
    const meta = LEXICON[verb];
    const transfer = meta?.cat === "verb" && (meta as { transfer?: boolean }).transfer;
    const implied = meta?.cat === "verb" ? (meta as { implied?: string }).implied : undefined;
    // THE VERB'S SECOND ARGUMENT. With the theme named, what comes next is the
    // OTHER end of the verb's own frame — and which end that is differs by
    // family: a partner (trade), a destination (carry, put), a recipient
    // (give), a source (get). Each family opens the LINK WORDS that name its
    // end together with the class of noun that can fill them, so the link is a
    // press away instead of buried in the generic joiner dump below, where the
    // connective quota of three is spent on and/then/because every time.
    if (verb === "trade") {
      // A TRADE IS A SWAP, not a handover, and it needs two links no other verb
      // needs: the PARTNER (`with`) and the counter-good (`for`) — precisely the
      // pair compileAction reads out of the frame (trade{give, take, partner}).
      // Partners are bodies and settlements alike: a town trades.
      add("with", "destination", 6);
      add("for", "destination", 5);
      addNouns("destination", (nn) => nn.kind === "creature", 4);
      addNouns("destination", (nn) => nn.kind === "place", 3);
    }
    if (verb === "carry") {
      // CARRYING IS A HAUL, not a handover. `carry` shares give's implied "to",
      // but a load is carried to a yard or into a box far more often than into
      // somebody's hands — so its endpoint band leads and the recipients below
      // rank under it, instead of a board of people for "carry the wood ___".
      addNouns("destination", (nn) => nn.kind === "place", 6);
      addNouns("destination", wants("container"), 6);
      add("to", "destination", 5);
      add("in", "destination", 4);
    }
    if (transfer || implied === "to") {
      addNouns("recipient", (nn) => nn.kind === "creature", 5);
      add("i_me", "recipient", 4);
      add("to", "recipient", 3);
    }
    if (canonicalVerb(verb) === "get" || implied === "from") {
      // ACQUISITION OPENS A SOURCE. get/take/pick_up name a thing coming INTO
      // the hands, so the open question is where from — `take`'s own argument
      // frame says as much (implied "from"), and the compiler already carries it
      // (fetch{item, from}). A source is what a thing comes out of (a container)
      // or whom it comes from (a body). The recipient band above still stands:
      // an explicit "to" turns the acquisition into a delivery — the to/from
      // opposition, not two competing readings of one verb.
      add("from", "destination", 3);
      addNouns("destination", wants("container"), 4);
      addNouns("destination", (nn) => nn.kind === "creature", 2);
    }
    if (implied === "in") {
      // "put + ball + …" wants somewhere to put it — the same §3.1 table, read
      // for the destination slot rather than the object slot.
      subTab = PROPERTY_FOR_VERB[verb];
      if (subTab) addNouns("destination", wants(subTab), 6);
      addNouns("destination", (nn) => nn.kind === "place", 5);
      // THE SPATIAL LINKS ARE THE SENTENCE, so they ride the destination band
      // beside the places rather than the generic relation band below, where the
      // connective quota buried them under and/then/because — which is why
      // composers reached for whatever place word the board did show. EVERY
      // named object opens them: a ball goes on the table or under the bed just
      // as a chair goes next to one. PLACEMENT_LINKS decides only which lead.
      const placedKind = frame.object?.kind === "entity" ? frame.object.symbol : null;
      const furnish = !!placedKind && (nounBy.get(placedKind)?.properties ?? []).includes("furniture");
      for (const [w, b] of PLACEMENT_LINKS[furnish ? "furniture" : "movable"]) add(w, "destination", b);
    }
    // Joins that extend any complete verb phrase — plus quantities ("give
    // apple two") and the object's own descriptors ("give apple hot").
    openRole("connective");
    for (const c of CONNECTIVES) add(c, "connective");
    for (const r of RELATIONS) add(r, "connective");
    addCompanyJoins(verb);
    openRole("quantity");
    for (const q of QUANTITIES) add(q, "quantity");
    const namedObjects = tokens.map(head).filter((h) => nounBy.has(h));
    if (namedObjects.length) {
      openRole("attribute");
      const axisBonus = attributeAxisBonus(namedObjects, false);
      for (const a of ATTRIBUTES) add(a, "attribute", axisBonus.get(a) ?? 0);
    }
  } else if (!verb) {
    // Nouns/persons without a verb. The nouns' own affordances pick the verbs
    // (composeNeed reversed) — an apple surfaces eat/get/give, a place go —
    // and the SUBJECT picks the band (the transition layer): a speaker
    // subject leans on state verbs ("i_me + want") and self activities; a
    // listener subject leans on directives ("you + go"). Frequency breaks
    // the remaining ties, so "want" leads wherever it is legal.
    const named = tokens.map(head).filter((h) => nounBy.has(h));
    openRole("verb");
    const afforded = new Set<string>();
    for (const h of named) for (const v of nounBy.get(h)!.affords) afforded.add(canonicalVerb(v));
    // EXPLICIT subjects only (a defaulted "[i want] ball" subject must not
    // drag the feelings band onto every bare noun).
    const speaker = tokens.some((t) => head(t) === "i_me");
    const listener = !speaker && tokens.some((t) => head(t) === "you");
    for (const v of CANONICAL_VERBS) {
      let bonus = afforded.has(v) ? 6 : 0;
      if (speaker && STATE_VERBS.has(v)) bonus = Math.max(bonus, 4);
      else if (speaker && OBJECT_OPTIONAL.has(v)) bonus = Math.max(bonus, 3);
      else if (listener && isDirective(v)) bonus = Math.max(bonus, 2);
      add(v, "verb", bonus);
    }
    // Attribute continuations make a STATEMENT ("apple + hot", "i_me hungry",
    // "mara + hungry") — ranked by the DESCRIPTOR AXES of what's in play, so
    // food talks temperature and people (and hungry cities) talk feelings.
    openRole("attribute"); // reserve slots: "i_me + hungry" must stay a press away
    const axisBonus = attributeAxisBonus(named, speaker ? "strong" : listener ? "weak" : false);
    for (const a of ATTRIBUTES) add(a, "attribute", axisBonus.get(a) ?? 0);
    if (named.length && !frame.subject) {
      add("i_me", "opener", 1);
      add("you", "opener", 1);
    }
  } else {
    // A saturated frame — extensions: joiners, quantities, and the composed
    // nouns' own DESCRIPTORS ("i_me want apple" + hot/big — the modifier
    // reading fills what would otherwise be a near-blank board).
    openRole("connective");
    for (const c of CONNECTIVES) add(c, "connective");
    addCompanyJoins(verb);
    openRole("quantity");
    for (const q of QUANTITIES) add(q, "quantity");
    const named = tokens.map(head).filter((h) => nounBy.has(h));
    if (named.length) {
      openRole("attribute");
      const axisBonus = attributeAxisBonus(named, false);
      for (const a of ATTRIBUTES) add(a, "attribute", axisBonus.get(a) ?? 0);
    }
  }

  return finalize();

  // ── Budget + verdicts ──────────────────────────────────────────────────────
  function finalize(showTypeChips = false, poolAllNouns = false): SurfaceSuggestion {
    // Rank: weight, then the frequency prior, then lexicon order, then symbol.
    const byRank = (a: SurfaceButton, b: SurfaceButton): number => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      const af = freqRank(a.symbol);
      const bf = freqRank(b.symbol);
      if (af !== bf) return af - bf;
      const ao = lexOrder.get(a.symbol);
      const bo = lexOrder.get(b.symbol);
      if (ao !== undefined && bo !== undefined && ao !== bo) return ao - bo;
      if (ao !== undefined && bo === undefined) return -1;
      if (ao === undefined && bo !== undefined) return 1;
      return a.symbol < b.symbol ? -1 : 1;
    };
    const ranked = [...buttons.values()].sort(byRank);
    // Reserve one representative per open role, then fill by rank under the
    // per-role quotas. No backfill past a quota: fewer, better buttons.
    const chosen: SurfaceButton[] = [];
    const seen = new Set<string>();
    const roleCount = new Map<SlotNeed, number>();
    const take = (b: SurfaceButton) => {
      chosen.push(b);
      seen.add(b.symbol);
      roleCount.set(b.role, (roleCount.get(b.role) ?? 0) + 1);
    };
    for (const role of open) {
      const rep = ranked.find((b) => b.role === role && !seen.has(b.symbol));
      if (rep && chosen.length < capacity) take(rep);
    }
    // Quotas balance MIXED boards; a single-role board just fills the grid.
    const applyQuota = open.length > 1;
    for (const b of ranked) {
      if (chosen.length >= capacity) break;
      if (seen.has(b.symbol)) continue;
      const quota = applyQuota ? QUOTA[b.role] : undefined;
      if (quota !== undefined && (roleCount.get(b.role) ?? 0) >= quota) continue;
      take(b);
    }
    chosen.sort(byRank);
    const categories = openCategories();
    return {
      buttons: chosen,
      // The noun clusters lead (things a child wants ARE the first reading);
      // the action band rides behind them as its OWN band — it never competes
      // for the noun chips' MAX_GROUPS budget, so [food] and [do] can stand
      // on one board.
      groups: [...buildGroups(seen, poolAllNouns, byRank), ...buildActionGroups(seen, byRank)],
      typeChips: showTypeChips ? [...TYPE_CHIPS] : [],
      categories,
      complete: isComplete(),
      open: [...open].sort((a, b) => TIER[b] - TIER[a]),
      ...(subTab ? { subTab } : {}),
    };
  }

  /** GROUP CHIPS: cluster this call's candidate nouns by property and kind.
   *  Pool = every noun offered to `buttons` (pre-truncation); on the empty
   *  board the whole library pools at just-below-opener weight, so [food] and
   *  [people] are one press away from the very first screen. A cluster whose
   *  members all fit inline is skipped — a chip must open something new. */
  function buildGroups(
    chosen: Set<string>,
    poolAllNouns: boolean,
    byRank: (a: SurfaceButton, b: SurfaceButton) => number,
  ): SurfaceGroup[] {
    const cands = new Map<string, SurfaceButton>();
    for (const b of buttons.values()) {
      if (nounBy.has(b.symbol)) cands.set(b.symbol, b);
    }
    if (poolAllNouns) {
      for (const n of ctx.nouns) {
        if (cands.has(n.symbol)) continue;
        const rec = recencyRank.get(n.symbol);
        const recBonus = rec !== undefined ? Math.max(0, 3 - rec) : 0;
        cands.set(n.symbol, {
          symbol: n.symbol,
          ...(n.label ? { label: n.label } : {}),
          role: "opener",
          weight: TIER.opener - 1 + recBonus,
        });
      }
    }
    if (cands.size === 0) return [];
    const clusters = new Map<string, { kind: "property" | "kind"; members: SurfaceButton[] }>();
    const push = (id: string, kind: "property" | "kind", b: SurfaceButton) => {
      const c = clusters.get(id) ?? { kind, members: [] };
      c.members.push(b);
      clusters.set(id, c);
    };
    for (const b of cands.values()) {
      const n = nounBy.get(b.symbol)!;
      for (const p of n.properties ?? []) push(p, "property", b);
      if (n.kind === "creature") push("creatures", "kind", b);
      else if (n.kind === "place") push("places", "kind", b);
      else if (n.kind === "item" && !(n.properties ?? []).length) push("things", "kind", b);
    }
    const groups: SurfaceGroup[] = [];
    for (const [id, c] of clusters) {
      if (c.members.length < 2) continue;
      if (c.members.every((m) => chosen.has(m.symbol))) continue;
      const members = [...c.members].sort(byRank);
      const weight =
        members[0]!.weight + Math.min(2, members.length * 0.1) + (subTab === id ? 8 : 0);
      // The FACE is picked from the ranked members but ordered by a different
      // question (what represents the cluster) — the expansion order is
      // untouched, so opening the chip still offers what to say next.
      const exemplars = exemplarOrder(
        members,
        (b) => b.symbol,
        (b) => nounBy.get(b.symbol)?.properties,
      ).slice(0, GROUP_EXEMPLARS);
      groups.push({ id, kind: c.kind, role: members[0]!.role, weight, members, exemplars });
    }
    groups.sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1));
    return groups.slice(0, MAX_GROUPS);
  }

  /** THE ACTION-CATEGORY CHIPS (the modal desire's breadth): one chip per
   *  broad family of doing, membership from this call's own candidate
   *  buttons — so the learned layer's bonuses rank each expansion, exactly
   *  as they rank the grid. The face is simply the top-ranked members: no
   *  noun prototype applies to verbs, and the actions a child reaches for
   *  most ARE the picture of the category. */
  function buildActionGroups(
    chosen: Set<string>,
    byRank: (a: SurfaceButton, b: SurfaceButton) => number,
  ): SurfaceGroup[] {
    if (!actionBand) return [];
    const out: SurfaceGroup[] = [];
    for (const c of ACTION_CATEGORIES) {
      const members = c.verbs
        .map((v2) => buttons.get(v2))
        .filter((b): b is SurfaceButton => b !== undefined)
        .sort(byRank);
      if (members.length < 2) continue;
      if (members.every((m) => chosen.has(m.symbol))) continue; // a chip must open something new
      out.push({
        id: c.id,
        kind: "verb",
        role: "verb",
        weight: members[0]!.weight,
        members,
        exemplars: members.slice(0, GROUP_EXEMPLARS),
      });
    }
    return out;
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
        // A bare quantity ("more") is a meaningful utterance in its own right.
        return !!(frame.object || frame.subject || frame.modifiers.length || frame.quantity);
      case "request":
      case "offer":
        // A MODAL DESIRE TO ACT ("i_me + want + play") is sayable exactly
        // when its inner verb would be complete as a command: bare for the
        // self/movement set, else once its object or target lands
        // ("want + get + ball"). The thing-request reading keeps its old
        // law — no object, no sentence.
        if (frame.modal && frame.verb) {
          return !!frame.object || !!frame.target || OBJECT_OPTIONAL.has(frame.verb);
        }
        return !!frame.object;
      case "command": {
        const v = frame.verb;
        // A classified bare noun ("bed" ⇒ go there) is a verbless command with
        // an object — the world layer supplies the default verb.
        if (!v) return !!frame.object;
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
