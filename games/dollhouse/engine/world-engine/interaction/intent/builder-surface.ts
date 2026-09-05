// shared/world-engine/interaction/intent/builder-surface.ts
//
// THE BUILDER-SURFACE ADAPTER: the engine's deterministic surfacer
// (surface-next.ts) rendered as the plain-JSON shape the games-bridge
// `builder_surface` message carries, so the PLATFORM's sentence builder can be
// driven by the GAME's own engine ("what can come next?") without the platform
// ever importing engine code. The bridge's `BuilderSurface` type is the wire
// contract; `BuilderSurfaceJson` here is defined LOCALLY and kept structurally
// compatible ON PURPOSE — the engine must not import shared/games-bridge
// (games vendor a snapshot of the engine; the bridge belongs to the platform).
//
// Pure and DOM-free: same input ⇒ same output, forever (the surfacer's own
// law). Labels are localized through the lang layer's word lexicon
// (`baseWord`), the same store the spoken rendering draws from — a Hebrew
// builder shows Hebrew word labels under the same glyphs.
//
// MAPPING (SurfaceSuggestion → BuilderSurfaceJson):
//   buttons     ← suggestion.buttons (already ranked; noun-backed words carry
//                 kind/present from the caller's noun list)
//   modifiers   ← the active head's descriptor axes (descriptorAxesFor +
//                 AXIS_WORDS — the modifier-rail logic of the game boards,
//                 engine-side and registry-free)
//   categories  ← the fixed category-tab ladder ("things" + the LEXICON's
//                 lexical categories) — `opts.category` filters to one tab,
//                 exactly like the SpeakMenu's tabs
//   groups      ← the SpeakMenu's sub-category chips: on the ranked view the
//                 surfacer's own group chips (suggestion.groups — property/kind
//                 clusters), on the "things" tab the same clusters over the
//                 FULL noun list, on the "person" tab the three LIVING clusters
//                 (contacts · people · animals), and on the two BIG lexical tabs
//                 — "attribute" and "verb" — the authored slices of
//                 `LEXICAL_TAB_CHIPS`. `opts.group` filters within the active
//                 view, exactly like tapping a group cell in the SpeakMenu. The
//                 remaining lexical tabs (quantity, relation, question,
//                 connective, social) each fit one page and stay flat.
//   complete    ← suggestion.complete
//   typeChips   ← suggestion.typeChips (the SENTENCE-TYPE controls, offered on
//                 the empty board only — exactly the surfacer's own verdict).
//                 A client renders them distinct from words and echoes the
//                 tapped kind back as `opts.seedKind`, the way `category` /
//                 `group` echo the chips they came from.
// DROPPED (no bridge field — the flat wire contract has no controls layer):
//   open/subTab (debug/ranking detail already baked into button order),
//   weights/roles (ordering carries them).

import { LEXICON, tokenizeSentence, type IntentKind } from "./parse-intent.js";
import {
  exemplarOrder,
  GROUP_EXEMPLARS,
  surfaceNext,
  type RecencyMemory,
  type SurfaceNoun,
} from "./surface-next.js";
import { AXIS_WORDS, descriptorAxesFor, type DescriptorAxis } from "../../object-properties.js";
import { isAnimal, isPlant, propertiesOf } from "../content/properties.js";
import {
  DEFAULT_ROOM_PROGRAMS,
  DEFAULT_STRUCTURE_PROGRAMS,
  roomDisplayGlyph,
  structureProgramDisplayGlyph,
  type RoomProgramDef,
  type StructureProgramDef,
} from "../../kernel/town/programs.js";
import { AFFORDANCE_VERBS, buildConcepts } from "../content/concepts.js";
import { listSpecies } from "../../creatures/species.js";
import { PLACE_STUBS, specWordHeads } from "../content/words.js";
import { placeGroupOf } from "../content/vocab-order.js";
import { CORE_PEOPLE } from "../../object-properties.js";
import { clusterIdsOf } from "../content/noun-clusters.js";
import { FURNITURE_ITEMS, STATION_ACTS } from "../../kernel/town/stations.js";
import { fixtureWord } from "../../types.js";
import { headOf } from "../../variations.js";
import { languageFor } from "../lang/index.js";
import { baseWord, type GlyphLanguage } from "../lang/core.js";

// ---------------------------------------------------------------------------
// Shapes — structurally identical to shared/games-bridge BuilderWord/Surface
// ---------------------------------------------------------------------------

/** One word offered to the platform's sentence builder (wire shape). */
export interface BuilderWordJson {
  /** Canonical engine-lexicon key — composing keys keeps sentences parseable. */
  key: string;
  label: string;
  /** Renderable composed glyph string (same grammar the board buttons use). */
  glyph?: string;
  /** Engine category bucket — one of `categories` (a tab this word lives in). */
  category?: string;
  /** Noun kind when the word is a noun ("person" | "creature" | "item" | "place"). */
  kind?: string;
  /** For persons/creatures: present in the current scene (prioritize + badge). */
  present?: boolean;
  /**
   * MODIFIER RAIL ONLY: the descriptor axis this word belongs to (temperature,
   * quantity, …). Present so a client can keep the axis mutually exclusive —
   * replacing the applied member rather than stacking a second one, since a
   * thing cannot be both hot and cold. Carried on the wire because the in-game
   * rail is computed by the GAME's vendored engine, so the platform has no
   * other route to it.
   */
  axis?: string;
}

/** A sub-category chip within the active view (wire shape — structurally the
 *  bridge's BuilderGroup). `id` is echoed back as `opts.group` to filter. */
export interface BuilderGroupJson {
  id: string;
  /** Localized display label (lang-layer word where one exists). */
  label: string;
  /** Renderable face for the chip — the BEST example of the cluster. Kept as a
   *  single glyph for clients that draw one face; `glyphs[0]` is the same word. */
  glyph?: string;
  /** The chip's full face: up to GROUP_EXEMPLARS composed glyphs, best example
   *  first, so a category can be drawn as a cluster of its members rather than
   *  as one word standing in for all of them. */
  glyphs?: string[];
}

/** A SENTENCE-TYPE control chip (wire shape — structurally the bridge's
 *  BuilderTypeChip). Not a word: pressing it does not compose anything, it
 *  re-asks for the openers of ONE communicative move (`opts.seedKind`).
 *  `label` is the engine's own English name for the move — a client with its
 *  own i18n should key off `kind` and translate. */
export interface BuilderTypeChipJson {
  /** The IntentKind this chip seeds ("request" | "ask" | "state" | …). */
  kind: string;
  /** The engine's plain-English name for the move (fallback label). */
  label: string;
}

/** What the sentence builder should offer for the current partial sentence. */
export interface BuilderSurfaceJson {
  /** Ranked main-grid words. */
  buttons: BuilderWordJson[];
  /** Modifier rail for the active head (compose onto it with "."). */
  modifiers?: BuilderWordJson[];
  /** Category chips the engine can serve (send `category` back to filter).
   *  These ARE the builder's tab set while an engine drives it. */
  categories?: string[];
  /** Sub-category chips for the ACTIVE view (send `group` back to filter
   *  within it) — the SpeakMenu's own group-cell hierarchy. */
  groups?: BuilderGroupJson[];
  /** True when the current sentence already parses as complete/sayable. */
  complete?: boolean;
  /** Sentence-type CONTROL chips — present only while the board is empty (the
   *  surfacer's own rule). Omitted entirely once composition is underway, so a
   *  client that ignores them is unaffected. */
  typeChips?: BuilderTypeChipJson[];
}

/** A noun the CALLER (the game host) knows about — the same knowledge the
 *  in-game Speak menu feeds the surfacer, plus the scene-presence flag the
 *  bridge surfaces ("mara is home right now"). */
export interface BuilderNounEntry {
  symbol: string;
  label?: string;
  kind?: "place" | "item" | "creature" | "unknown";
  affords?: string[];
  /** Spec-derived object properties (object-properties.ts). */
  properties?: string[];
  /** Present in the current scene (persons/creatures) — passed through. */
  present?: boolean;
  /**
   * A SPECIFIC PERSON, not a class of one — the child's own contacts out of
   * game, a scene's named characters in it. Puts the noun on the [individuals]
   * chip instead of [person], and leads the row on a board that asks for
   * somebody. One list, two sources: the in-game builder imitates how the board
   * is used outside the game, so a character occupies the same slot a real
   * person would. See `ClusterableNoun.individual` for why it travels as data.
   */
  individual?: boolean;
  /**
   * DISPLAY glyph, when the word's PICTURE is not its own symbol. The pressed
   * word stays `symbol` — one word, parseable, exactly what the sentence
   * carries — while the button renders this instead.
   *
   * This is what lets a ROOM or a BUILDING be a single word with a composed
   * icon: `bedroom` is the word the student presses and the sentence keeps,
   * `room(bed)` is only how the button draws. Composing the icon into the KEY
   * would put parentheses in the sentence, which the builder deliberately
   * never emits (ENABLE_GLYPH_ARGUMENTS is off) and `tokenizeSentence` cannot
   * parse anyway.
   *
   * NOT the only floor under a place word any more. This field is the SESSION's
   * answer (it knows the live culture and catalogue), but a bare place word now
   * draws its shell wherever it travels alone — a bubble line, a caption, a
   * staged slot — through `shared/glyph-place-art.ts`. Surfaces that have this
   * field should still pass it; surfaces that only have the word are no longer
   * showing a fixture with no room around it.
   */
  glyph?: string;
}

export interface BuilderSurfaceOpts {
  nouns?: BuilderNounEntry[];
  /**
   * ONE VOCABULARY, IN GAME AND OUT (user decision 2026-08-24). The caller's
   * nouns are MERGED with the default library rather than replacing it, host
   * first, first entry per head winning — so a scene's own people and stock
   * outrank the generic word for the same thing, and a child keeps every word
   * they had on the board before the game opened.
   *
   * `false` restores the old behaviour (the caller's list and nothing else) —
   * for a surface that must pin an exact board, and for a host that genuinely
   * wants to speak only its own scene.
   */
  defaults?: boolean;
  /** BCP-47 locale for word labels (lang-layer lexicon; en fallback). */
  locale?: string;
  /** Filter to one category tab (one of `BUILDER_CATEGORIES`). */
  category?: string;
  /** Filter within the active view to one sub-category chip (a `groups[].id`
   *  from the previous surface). Unknown/stale ids fall back to the full view. */
  group?: string;
  /** Main-grid budget (the surfacer default is 16). */
  capacity?: number;
  /** How many of those the child sees before More — the chip rule's measure
   *  (surface-next `SurfaceContext.page`). Absent ⇒ `capacity`. */
  page?: number;
  /**
   * THE LEARNED LAYER (surface-next `RecencyMemory`): what this speaker has
   * actually said — recently-mentioned nouns, per-word use counts, adjacent
   * word pairs. Owned and persisted by the CLIENT (it is the student's own
   * habit, not world state), fed back in on every request and updated through
   * `noteUtterance` after each successful speak. Absent ⇒ every use/pair/
   * recency bonus is 0 and the board is byte-identical to an unpersonalized
   * one, which is what an older client keeps getting.
   */
  recency?: RecencyMemory;
  /**
   * A SENTENCE-TYPE chip was tapped: constrain the openers to that
   * communicative move. Echoes a `typeChips[].kind` from the previous surface
   * back, exactly as `category`/`group` echo their own chips. Only the empty
   * board reads it (the surfacer's own rule) — mid-sentence it is inert.
   */
  seedKind?: IntentKind;
  /** ⑫ — the fellow members of the speaker's own conversation, as spoken
   *  symbols. In a 3+ roster it opens the ADDRESSEE slot so a request can name
   *  whom it is for; absent or a dyad ⇒ today's board exactly
   *  (conversation-in-motion.md law ②/④). */
  addressees?: readonly string[];
}

// ---------------------------------------------------------------------------
// The category-tab ladder (the SpeakMenu's CATEGORY_ORDER, engine-side)
// ---------------------------------------------------------------------------

/** "things" (the caller's nouns) + the LEXICON's lexical categories, in the
 *  boards' friendly display order. The graceful-degradation ladder: every word
 *  the parser understands stays reachable through exactly one tab. */
export const BUILDER_CATEGORIES: readonly string[] = [
  "things", "person", "verb", "attribute", "quantity", "relation", "question", "connective", "social",
];

const LEX_KEYS = Object.keys(LEXICON);

// ---------------------------------------------------------------------------
// The default vocabulary — DERIVED FROM THE SPEC (user law, 2026-08-24)
// ---------------------------------------------------------------------------
//
// The out-of-game builder has no host pushing a noun list, so it needs one of
// its own. It does NOT get an authored one: almost every noun — its context,
// its icon, its translations, what it does — comes from the game spec, because
// that is also where a clinician will add one, and a noun's physical parameters
// are what decide both its game role and where it appears on a board. A curated
// array here was a SECOND SOURCE OF TRUTH: it disagreed with the world about
// what exists (nineteen items, of which two were a lamp and a bowl) and it went
// stale the moment anyone authored a pool member.
//
// So the library is a WALK of the registries that define nouns:
//
//   1. CONCEPTS  — `buildConcepts()`, the joined taught vocabulary (pool
//      members + category-tagged symbols, with affordances already derived from
//      pool affordance, category and species).
//   2. PEOPLE    — the kinship and role frame words (`CORE_PEOPLE`), which have
//      no spec row by law and would otherwise reach no board.
//   3. FIXTURES  — the built world's stations (`FURNITURE_ITEMS`), spoken as
//      `fixtureWord`, with the verbs their kind affords (`STATION_ACTS`).
//   4. PLACES    — every room and building the programs declare, plus the place
//      words the town has no program for yet (`PLACE_STUBS`).
//
// Everything else follows from the row: properties through `propertiesOf`,
// words through the lang layer's spec overlay, rank through `nounRank`. Adding a
// spec row adds a button, in one edit, in four languages.

/** The verbs a thing's PROPERTIES imply (the quest host's own affordance
 *  derivation, mirrored) — mechanics and board agree by construction. */
function propertyAffords(props: readonly string[]): string[] {
  const v: string[] = [];
  if (props.includes("food")) v.push("eat");
  if (props.includes("drink")) v.push("drink");
  if (props.includes("clothing")) v.push("wear", "wash");
  if (props.includes("toy")) v.push("play");
  if (props.includes("openable")) v.push("open", "shut");
  if (props.includes("container")) v.push("put");
  if (props.includes("furniture")) v.push("go");
  return v;
}

/** What any HANDLEABLE thing affords before anything specific is known. A
 *  FIXTURE gets only the wish: an oven is a thing you can want and go to, never
 *  a thing you hand to somebody, and a board that thought otherwise led "you
 *  give ___" with the kitchen. */
const ITEM_BASELINE = ["want", "get", "give"] as const;
/** The verbs that only a BODY affords (the receptive-npc row). */
const SOCIAL_VERBS = new Set(AFFORDANCE_VERBS["receptive-npc"]);
const FIXTURE_BASELINE = ["want"] as const;

/**
 * A BODY is a species the world builds or a member of the animal pool — both
 * are creatures, and a dog is genuinely somebody you follow and play with.
 *
 * WHETHER A BODY IS A PERSON is a different question, and the one that was
 * wrong: `receptive-npc` made `bear`, `rabbit` and `frog` people (a fossil of
 * the edition whose townsfolk WERE animal people), so a frog stood in every
 * band meaning "somebody" — greet, the company link, `help`, the desire board.
 * `isAnimal` (content/properties.ts) answers that question now, and the bands
 * rank people ahead of animals rather than pretending an animal is furniture.
 */

const entry = (
  symbol: string,
  kind: "item" | "creature" | "place",
  affords: readonly string[],
  properties: readonly string[] = propertiesOf(symbol),
): BuilderNounEntry => ({
  symbol,
  kind,
  affords: [...new Set(affords)],
  properties: [...properties],
});

/**
 * The out-of-game builder's noun library: every noun the SPEC defines, in the
 * vocabulary's own order. Deterministic (fixed registries, fixed walk); no
 * `present` flags — there is no scene to be present in.
 */
let DEFAULTS: BuilderNounEntry[] | null = null;

/** The derived library, computed once (the registries are fixed data). Callers
 *  get a fresh array so nobody can mutate the shared one. */
export function defaultBuilderNouns(): BuilderNounEntry[] {
  return (DEFAULTS ??= walkDefaultNouns()).map((n) => ({ ...n }));
}

function walkDefaultNouns(): BuilderNounEntry[] {
  const out: BuilderNounEntry[] = [];
  const seen = new Set<string>();
  const push = (e: BuilderNounEntry) => {
    const h = headOf(e.symbol);
    if (!h || seen.has(h)) return;
    seen.add(h);
    out.push(e);
  };

  // 1. The taught vocabulary, affordances and all.
  for (const c of buildConcepts().values()) {
    const creature =
      c.species?.kind === "creature" || (c.pools ?? []).some((p) => p.affordance === "receptive-npc");
    const props = c.properties ?? [];
    // A thing that is NOT a body does not talk, hug or follow, whatever pool it
    // sits in: the `friend` pool hands its members the social verbs, and with
    // the animal-people gone those verbs would have left a teddy bear offering
    // to have a conversation.
    const affords = creature ? c.affords : c.affords.filter((v) => !SOCIAL_VERBS.has(v));
    push(
      entry(
        c.symbol,
        creature ? "creature" : "item",
        creature
          ? affords
          : [
              ...(props.includes("furniture") ? FIXTURE_BASELINE : ITEM_BASELINE),
              ...affords,
              ...propertyAffords(props),
            ],
        props,
      ),
    );
  }

  // 2. The animals. A species row with `words` is a creature a sentence can
  //    name (`cat`, `horse`, and every `stub` row that ships a word ahead of
  //    its body plan); one without them is a body the builder makes, not a word
  //    a child says.
  for (const sp of listSpecies()) {
    if (sp.kind !== "creature" || !sp.words) continue;
    push(entry(sp.id, "creature", ["see", "want", "play", "follow", "help"], []));
  }

  // 2b. The PLANTS — the same registry, the other kind (2026-08-27). A plant is
  //    something you SEE, WANT and CUT (the species-kind affordance the concept
  //    bridge already derives), never something you are handed: an oak is not a
  //    thing anybody gives you, and the give band read one as an item the
  //    moment it was filed as one.
  //
  //    SAYABLE, not just worded: `tree`'s four lexemes live in `ITEM_WORDS`
  //    (one definition per head), so a `words`-only test would have left the
  //    plant word a child was likeliest to reach for off the plant chip.
  const specHeads = specWordHeads();
  for (const sp of listSpecies()) {
    if (sp.kind !== "plant") continue;
    if (!sp.words && !specHeads.has(sp.id)) continue;
    push(entry(sp.id, "item", ["see", "want", "cut"]));
  }

  // 3. The people a child names. Frame words with no spec row by law, so they
  //    are the one group this walk cannot read off a registry.
  for (const person of CORE_PEOPLE) {
    push(entry(person, "creature", ["talk", "help", "hug", "give", "see", "want"], []));
  }

  // 4. The built world. A station is spoken as its `fixtureWord` (the chest row
  //    speaks "box"), and what it is FOR rides its own registry row.
  for (const f of FURNITURE_ITEMS) {
    const word = fixtureWord(f.kind);
    const props = propertiesOf(word);
    const baseline = props.includes("furniture") ? FIXTURE_BASELINE : ITEM_BASELINE;
    push(entry(word, "item", [...baseline, ...(STATION_ACTS[f.kind] ?? []), ...propertyAffords(props)], props));
  }

  // 5. Places.
  for (const place of placeBuilderNouns()) push(place);

  return out;
}

/**
 * EVERY ROOM AND BUILDING THE SPEC KNOWS, as single-word place nouns.
 *
 * The two program repositories ARE the world's place vocabulary (programs.ts:
 * room kinds forward and backward, building characters one level up), so the
 * builder reads them rather than carrying a list of its own — a culture that
 * authors a new room kind gets a new button for free, and one that renames a
 * kind can't leave a stale button behind.
 *
 * Each entry is a SINGLE WORD (`bedroom`, `smithy`) carrying a COMPOSED GLYPH
 * (`room(bed)`, `building(anvil)`) for the button to draw. The word is what the
 * sentence keeps; the composition never reaches it.
 *
 * `affords: ["go"]` — a place is somewhere you GO. It is not a thing you want,
 * get or give, so the noun default is deliberately not inherited here.
 *
 * Pass the session's RESOLVED programs (defaults ⊕ culture) to get that
 * world's places; the no-argument form is the kernel default, which is what
 * the out-of-game builder offers.
 */
export function placeBuilderNouns(
  rooms: ReadonlyArray<RoomProgramDef> = DEFAULT_ROOM_PROGRAMS,
  buildings: ReadonlyArray<StructureProgramDef> = DEFAULT_STRUCTURE_PROGRAMS,
): BuilderNounEntry[] {
  const out: BuilderNounEntry[] = [];
  const seen = new Set<string>();
  // Buildings before rooms: "where am I going" is answered by a building far
  // more often than by which room of it. Deterministic — repository order.
  // `word ?? kind` is the fold: the SYMBOL is what gets pressed and spoken, so
  // it has to be a word the lang layer carries (`house` → `home`), while the
  // program keeps its own name for every rule that derives it.
  for (const b of buildings) {
    const symbol = b.word ?? b.type;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({
      symbol,
      kind: "place",
      affords: ["go"],
      // Properties from the SPEC SIDE, never authored here — the same law the
      // item list follows. Mostly empty (a room kind is not a station), but
      // `bath` names both a room and a tub and the spec is what says so.
      properties: propertiesOf(symbol),
      glyph: structureProgramDisplayGlyph(b),
    });
  }
  // The place words with no program yet (words.ts PLACE_STUBS) — real words,
  // real icons, four languages; the town simply cannot raise them yet. They sit
  // ahead of the room kinds because a child goes to school far more often than
  // to a storeroom.
  for (const symbol of PLACE_STUBS) {
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol, kind: "place", affords: ["go"], properties: propertiesOf(symbol) });
  }
  for (const r of rooms) {
    const symbol = r.word ?? r.kind;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({
      symbol,
      kind: "place",
      affords: ["go"],
      // Properties from the SPEC SIDE, never authored here — the same law the
      // item list follows. Mostly empty (a room kind is not a station), but
      // `bath` names both a room and a tub and the spec is what says so.
      properties: propertiesOf(symbol),
      glyph: roomDisplayGlyph(r),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * First entry per head wins — the federation's own rule, applied to a list.
 *
 * ⚖️ WINNING IS NOT ERASING. A host's entry OUTRANKS the default library's for
 * the same head, but it does not replace what it never spoke about: a later
 * entry for the same head backfills any field the winner left undefined.
 *
 * The case that forced it: a host pushing `{ symbol: "chair", label: "chair",
 * affords: [...] }` said nothing about properties, and the merge dropped the
 * library's `["furniture"]` with it. A chair that is not furniture clusters
 * under no chip, and on a board that withholds objects in favour of chips that
 * is the same as deleting the word — the host asked for its own affordances and
 * silently lost the chair.
 */
function dedupeByHead(nouns: readonly BuilderNounEntry[]): BuilderNounEntry[] {
  const byHead = new Map<string, BuilderNounEntry>();
  const order: string[] = [];
  for (const n of nouns) {
    const h = headOf(n.symbol);
    if (!h) continue;
    const won = byHead.get(h);
    if (!won) {
      byHead.set(h, { ...n });
      order.push(h);
      continue;
    }
    // Backfill only — every field the winner DID declare stands.
    const target = won as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(n)) {
      if (target[k] === undefined && v !== undefined) target[k] = v;
    }
  }
  return order.map((h) => byHead.get(h)!);
}

/** Person-deixis heads that take the CREATURE descriptor axes ("i_me + hungry"). */
const ANIMATE_DEIXIS = new Set(["i_me", "you", "we", "us", "they"]);

/**
 * THE PERSON TAB'S SUB-CHIPS, in the order a child is offered them (user,
 * 2026-09-04): the people this child actually knows FIRST, then people in
 * general (mom, teacher, friend…), then animals — not people, but a possible
 * answer to "who", and there is room for more chips beside them later.
 *
 * The tab used to be flat: `LEXICON`'s eight person-deixis words (I, you, we,
 * they, this, that, here, there) and nothing else, so every host that wanted a
 * child's own contacts on it had to pin a chip of its own and ask for the
 * "things" tab behind the child's back. Both did, identically, and both got
 * three pages of animals in front of the faces because the borrowed surface was
 * the whole noun library. The chips are the engine's now, and the deixis list
 * stays as the tab's "All" content.
 */
const PERSON_GROUP_ORDER: readonly string[] = ["individuals", "creatures", "animals"];

/**
 * THE CONTACTS CHIP — the one cluster that is advertised even when the engine
 * has nothing to put in it.
 *
 * Every other chip must open a real subset (the SpeakMenu's ≥2 rule), because a
 * chip that opens one word is a wasted press. `individuals` is the exception on
 * purpose: OUT OF GAME the engine's noun library holds no specific people at
 * all (`defaultBuilderNouns()` is derived from the spec, and a child's contacts
 * are not in a spec), yet the child's contacts are exactly what the HOST merges
 * into this chip from its own people directory. Hiding it because the ENGINE's
 * half is empty would hide the whole list. So it always ships, empty on the
 * wire, and the host fills it.
 */
const PERSON_CONTACTS_GROUP = "individuals";

/**
 * THE TWO BIG LEXICAL TABS' SUB-CHIPS (user decision 2026-09-04) — Descriptions
 * (`attribute`) and Actions (`verb`), the way People just got contacts · people ·
 * animals.
 *
 * WHY ONLY THESE TWO. A lexical tab lists its WHOLE category, and every other
 * one (quantity, relation, question, connective, social) fits a single grid
 * page — chips there would cost a press and buy nothing. Descriptions is
 * thirty-eight words and Actions is sixty-five: without chips the child pages
 * through them, which on a board that withholds words behind More is the same
 * as not having most of them.
 *
 * ⚖️ ONE TABLE, KEYED BY CHIP ID, and the chip ROW derives from it (declaration
 * order per tab). Two lists — an order here and a membership there — is how a
 * verb ends up on no chip at all: it stays parseable, it stays on "All", and it
 * silently leaves the only surface a child can find it on. The partition is
 * pinned by `builder-attribute-verb-chips.test.ts`: every LEXICON key of either
 * category lands in exactly ONE chip, so a future word cannot go unlisted.
 *
 * Membership is SEMANTIC, not alphabetical: colours, then how somebody feels,
 * then how big, then what state a thing is in; and for actions — going, hands,
 * making, doing-with-people, one's own body, wanting.
 */
export const LEXICAL_TAB_CHIPS: Readonly<
  Record<string, { readonly tab: "attribute" | "verb"; readonly keys: readonly string[] }>
> = {
  // ── DESCRIPTIONS (`attribute`) ────────────────────────────────────────────
  colors: {
    tab: "attribute",
    keys: [
      "color_red", "color_orange", "color_yellow", "color_green", "color_blue",
      "color_purple", "color_pink", "color_brown", "color_black", "color_white", "color_gray",
    ],
  },
  // The mood + bodily axes together: a child does not sort "sad" from "hungry"
  // before looking for either, and both answer "how are you?".
  feelings: {
    tab: "attribute",
    keys: [
      "happy", "sad", "bored", "lonely", "hungry", "thirsty", "tired", "sick",
      "angry", "scared", "excited", "hurt", "surprised", "proud", "calm",
    ],
  },
  // Only the two the parser has words for. `long`/`short`/`tall` live in
  // AXIS_WORDS (the registry's modifier store) and are not LEXICON words, so
  // listing them here would advertise buttons that do not exist.
  size: { tab: "attribute", keys: ["big", "small"] },
  // What STATE a thing is in — temperature, cleanliness, integrity, age, fill,
  // and the bare quality pair.
  condition: {
    tab: "attribute",
    keys: ["hot", "cold", "warm", "dirty", "broken", "new", "old", "full", "good", "bad"],
  },

  // ── ACTIONS (`verb`) ──────────────────────────────────────────────────────
  // Going and staying — every verb whose whole content is where a body is.
  go: { tab: "verb", keys: ["go", "come", "stop", "follow", "wait", "stay", "run", "turn", "return", "chase"] },
  // What HANDS do: things changing hands, and things moved by them.
  hands: {
    tab: "verb",
    keys: ["get", "take", "give", "bring", "put", "drop", "throw", "push", "pull", "pick_up", "carry", "share", "trade", "show"],
  },
  // Working on the world: making, unmaking, tending, transforming, operating.
  make: {
    tab: "verb",
    keys: [
      "make", "build", "break", "fix", "dig", "plant", "cut", "tidy", "area",
      "heat", "cook", "make_cold", "wash", "fill", "empty", "color", "use", "open", "shut",
    ],
  },
  // Doing things WITH somebody — the verbs that need a second person.
  together: { tab: "verb", keys: ["help", "play", "talk", "ask", "teach", "fight", "hug"] },
  // One's OWN body: eating, sleeping, dressing, and the two senses.
  body: {
    tab: "verb",
    keys: ["eat", "drink", "sleep", "rest", "sit", "wake_up", "brush_teeth", "wear", "feel", "see"],
  },
  // Wanting and having — the desire channel plus the broad activity verb.
  want: { tab: "verb", keys: ["want", "need", "have", "like", "do"] },
};

/** Which chips a lexical tab advertises, in the table's own declaration order.
 *  DERIVED — never a second list to keep in step with the first. */
const LEXICAL_TAB_GROUP_ORDER: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const [id, def] of Object.entries(LEXICAL_TAB_CHIPS)) {
    const row = m.get(def.tab) ?? [];
    row.push(id);
    m.set(def.tab, row);
  }
  return m;
})();

/** The chip ids one lexical tab offers, in order (empty for a flat tab). */
export const lexicalTabChipIds = (tab: string): readonly string[] =>
  LEXICAL_TAB_GROUP_ORDER.get(tab) ?? [];

/**
 * CHIPS WHOSE LABEL NAMES A SET, not one of its members (user, 2026-09-04).
 *
 * "person" and "animal" under a chip that opens forty animals reads as a single
 * word the child is about to press, which is what a button means everywhere
 * else on the board. The plural says "there are more of these inside".
 *
 * `individuals` is deliberately absent — "contacts" is already plural in every
 * ruleset — and the two lexical tabs' set-shaped chips (`colors`, `feelings`)
 * are authored plural outright.
 */
const PLURAL_LABEL_CHIPS: ReadonlySet<string> = new Set(["creatures", "animals", "plants"]);

/**
 * CHIPS WHOSE LABEL IS A VERB, and therefore must be the INFINITIVE (user,
 * 2026-09-04).
 *
 * ⚠️ THE SAME TRAP `colors`-not-`color` RECORDS, one row down. Three Action
 * chips deliberately wear an existing verb head (`go`, `make`, `want` — those
 * verbs ARE the names of their families), but `w` is the 1st-person singular in
 * the romance rulesets and the present participle in Hebrew, so the row read
 * "voy · hago · quiero" — *I go, I make, I want* — as the names of three
 * categories. The infinitive is the citation form, which is what a category
 * name wants: "ir · hacer · querer".
 *
 * `together` is not here (it is an adverbial, not a verb) and neither are the
 * noun-headed chips. English is unaffected either way: its infinitive IS its
 * base form.
 */
const INFINITIVE_LABEL_CHIPS: ReadonlySet<string> = new Set(["go", "make", "want"]);

/** The lexeme's infinitive where it carries one, the base word otherwise —
 *  which is the right answer for English, whose infinitive IS its base form.
 *
 *  All three heads carry one in he/es/pt: `go` and `make` always did, and
 *  `want` gained לרצות / querer / querer on 2026-09-04 for this chip (the one
 *  re-baselined entry in `fixtures/lexicon-premove-snapshot.json` — see law 1's
 *  comment in `lexicon-spec-words.test.ts`). Label-only: no frame reads a
 *  MODAL's infinitive, so no sentence moved. `builder-attribute-verb-chips`
 *  pins all three positively, so a lexeme that lost its `inf` fails loudly
 *  rather than silently putting "I want" back on the chip. */
function infinitiveWord(lang: GlyphLanguage, head: string): string {
  return lang.lexicon[head]?.inf?.trim() || baseWord(lang, head);
}

/**
 * A head's plural, through the SAME ladder every other count reads: the
 * lexeme's own `plw` (the irregular list — "people", "אנשים", "animais"), then
 * the ruleset's regular rule where it has one (`pluralize`; English alone
 * does), then the singular.
 *
 * ⚖️ NEVER an -s of our own. A ruleset without a regular plural — Hebrew's
 * gendered pairs, and the romance rulesets, which keep the rule inside their own
 * renderer — keeps the singular here, because a plural synthesised by the
 * SURFACER would be English grammar leaking onto another language's board. That
 * is precisely the split `GlyphLanguage.pluralize` exists to draw.
 */
function pluralWord(lang: GlyphLanguage, head: string): string {
  const lex = lang.lexicon[head];
  if (lex?.plw?.trim()) return lex.plw.trim();
  const w = baseWord(lang, head);
  return lang.pluralize?.(w) ?? w;
}

const MODIFIER_RAIL_CAP = 8;

/** Strip `#op` operators then take the `.`-head — the surfacer's own head rule. */
const headSym = (token: string): string => headOf(token.replace(/#\w+/g, ""));

/**
 * The engine's answer to the bridge's `builder_state`: what the platform's
 * sentence builder should offer for `partialGlyph` (a composed sentence —
 * words joined " + " with "." modifiers, possibly empty). Pure, deterministic,
 * plain JSON out (survives structuredClone).
 */
export function builderSurfaceFor(partialGlyph: string, opts: BuilderSurfaceOpts = {}): BuilderSurfaceJson {
  const lang = languageFor(opts.locale);
  // DEDUPED BY HEAD, host first: the merge would otherwise list a word twice
  // whenever a caller already carries one the defaults know (and every caller
  // that passes `defaultBuilderNouns()` itself would double the whole library).
  // The button map dedupes too, but the "things" tab and the chip clusters read
  // this list directly.
  const nouns = dedupeByHead(
    opts.defaults === false ? (opts.nouns ?? []) : [...(opts.nouns ?? []), ...defaultBuilderNouns()],
  );

  // First entry per head wins (determinism) — the same head can arrive twice
  // when a composed variant ("shirt.color_red") and the bare kind both exist.
  const nounByHead = new Map<string, BuilderNounEntry>();
  for (const n of nouns) {
    const h = headOf(n.symbol);
    if (h && !nounByHead.has(h)) nounByHead.set(h, n);
  }

  /** One wire word. Noun-backed symbols keep the noun's FULL composed symbol
   *  as key+glyph (identity survives the round trip); everything else is its
   *  own key. `kind`/`present` ride only on nouns (the bridge's contract).
   *
   *  The glyph is the noun's own `glyph` when it declares one — the KEY never
   *  changes, so a place stays a single word in the sentence while its button
   *  draws the composed shell+symbol icon. */
  const wordJson = (symbol: string): BuilderWordJson => {
    const head = headOf(symbol);
    const noun = nounByHead.get(head);
    const lex = LEXICON[head];
    const key = !lex && noun ? noun.symbol : symbol;
    return {
      key,
      // THE LEXICON OUTRANKS THE HOST'S LABEL for anything that is a WORD. The
      // host's `label` is a display name for what no lexicon can hold — a
      // person's name, a pet's — and it is written in English; letting it win
      // put "chair" on a Hebrew board next to buttons that read כיסא. A name
      // has no lexeme, so it still falls through and stays itself.
      label: lang.lexicon[head]?.w ?? noun?.label ?? baseWord(lang, head),
      glyph: noun?.glyph ?? key,
      category: lex ? lex.cat : "things",
      ...(!lex && noun?.kind ? { kind: noun.kind } : {}),
      ...(!lex && noun?.present !== undefined ? { present: noun.present } : {}),
    };
  };

  // The surfacer's noun library — heads only (its own convention), first wins.
  const surfaceNouns: SurfaceNoun[] = [...nounByHead.entries()].map(([symbol, n]) => ({
    symbol,
    ...(n.label ? { label: n.label } : {}),
    kind: n.kind ?? "unknown",
    affords: n.affords ?? ["want", "get", "give"],
    properties: n.properties ?? [],
    ...(n.individual ? { individual: true } : {}),
  }));

  const tokens = tokenizeSentence(partialGlyph);
  const suggestion = surfaceNext(tokens, {
    nouns: surfaceNouns,
    ...(opts.capacity !== undefined ? { capacity: opts.capacity } : {}),
    ...(opts.page !== undefined ? { page: opts.page } : {}),
    // The learned layer and the type-chip seed ride straight through: the
    // surfacer owns what they mean, the adapter only carries them. Both
    // omitted when absent, so a caller that passes neither gets exactly the
    // board it got before they existed.
    ...(opts.recency ? { recency: opts.recency } : {}),
    ...(opts.seedKind ? { seedKind: opts.seedKind } : {}),
    ...(opts.addressees?.length ? { parse: { addressees: opts.addressees } } : {}),
  });

  // ── Buttons + group chips (the SpeakMenu's hierarchy, wire-shaped) ─────────
  //   no category      → the ranked grid, with the surfacer's own group chips
  //                      (property/kind clusters); `group` opens one in place.
  //   category=things  → the FULL noun listing, sub-grouped by the SAME
  //                      property/kind clustering over the whole library.
  //   category=person  → the deixis words, sub-chipped by the three LIVING
  //                      clusters (contacts · people · animals) over the same
  //                      library — the WHO tab, which a host used to have to
  //                      fake by borrowing the things surface.
  //   verb/attribute   → the whole category as "All", sub-chipped by the
  //                      authored slices (`LEXICAL_TAB_CHIPS`) — the two tabs
  //                      too big for one grid page.
  //   lexical category → that tab's full flat listing (the fallback ladder,
  //                      exactly like the SpeakMenu tabs — no sub-groups).
  const surfaceWord = (b: { symbol: string; label?: string }): BuilderWordJson => {
    const w = wordJson(b.symbol);
    // The surfacer's own label (a noun label it resolved) wins over ours — but
    // it is the HOST's English label travelling under another name, so the
    // lexicon outranks it here for the same reason it does in `wordJson`.
    const named = b.label !== undefined && !lang.lexicon[headOf(b.symbol)];
    return named ? { ...w, label: b.label! } : w;
  };
  // The chip's face is the members' DISPLAY glyphs (`wordJson().glyph`), not
  // their keys: a place's picture is its composed shell+symbol icon, and a chip
  // that drew the bare word would render nothing for it.
  const groupChip = (id: string, faceSymbols: readonly string[]): BuilderGroupJson => {
    const glyphs = faceSymbols.slice(0, GROUP_EXEMPLARS).map((s) => wordJson(s).glyph ?? s);
    const head = GROUP_LABEL_HEAD[id] ?? id;
    return {
      id,
      // A chip that opens a KIND wears the plural (`PLURAL_LABEL_CHIPS`) — it
      // names the set, not the one word a button usually is; a chip named by a
      // VERB wears the infinitive (`INFINITIVE_LABEL_CHIPS`), the citation form,
      // never a conjugated "I go". The two sets are disjoint by construction:
      // one labels nouns, the other verbs.
      label: PLURAL_LABEL_CHIPS.has(id)
        ? pluralWord(lang, head)
        : INFINITIVE_LABEL_CHIPS.has(id)
          ? infinitiveWord(lang, head)
          : baseWord(lang, head),
      ...(glyphs.length ? { glyph: glyphs[0], glyphs } : {}),
    };
  };

  let buttons: BuilderWordJson[];
  let groups: BuilderGroupJson[] | undefined;
  const cat = opts.category;
  const grp = opts.group;
  if (cat === "things") {
    const clusters = thingClusters(nouns);
    const active = grp !== undefined ? clusters.get(grp) : undefined;
    buttons = (active ?? nouns).map((n) => wordJson(n.symbol));
    // A chip must open a real subset (the SpeakMenu's own ≥2 rule).
    groups = [...clusters.entries()]
      .filter(([, members]) => members.length >= 2)
      .map(([id, members]) =>
        groupChip(
          id,
          exemplarOrder(members, (n) => n.symbol, (n) => n.properties).map((n) => n.symbol),
        ),
      );
  } else if (cat === "person") {
    // THE WHO TAB. "All" is still the flat lexical listing (the deixis words);
    // the CHIPS open the three living clusters over the FULL noun library, the
    // same clustering the things tab sub-groups by — contacts, then people in
    // general, then animals.
    const clusters = thingClusters(nouns);
    // Only this tab's OWN chips filter it: a stale id, or a cluster that belongs
    // to another tab ("food"), shows the full listing rather than a plate of
    // apples under [who].
    //
    // `?? []` matters: [contacts] is EMPTY out of game and an empty answer is
    // the correct one — the host has a directory to put there. Falling back to
    // the deixis list (what an unknown id gets) would put "I / you / we" under
    // a chip that promises the child's family.
    const active =
      grp !== undefined && PERSON_GROUP_ORDER.includes(grp) ? clusters.get(grp) ?? [] : undefined;
    buttons = active
      ? active.map((n) => wordJson(n.symbol))
      : LEX_KEYS.filter((k) => LEXICON[k]!.cat === cat).map(wordJson);
    groups = PERSON_GROUP_ORDER.filter(
      (id) => id === PERSON_CONTACTS_GROUP || (clusters.get(id)?.length ?? 0) >= 2,
    ).map((id) =>
      groupChip(
        id,
        exemplarOrder(clusters.get(id) ?? [], (n) => n.symbol, (n) => n.properties).map((n) => n.symbol),
      ),
    );
  } else if (cat && LEXICAL_TAB_GROUP_ORDER.has(cat)) {
    // THE TWO BIG LEXICAL TABS — Descriptions and Actions. Same shape as the
    // person tab: "All" stays the WHOLE lexical category (a chip is a filter,
    // never a replacement), the chips open one slice each, and a foreign or
    // stale id falls back to the full listing rather than to an empty board.
    //
    // Unlike [contacts], every chip here has fixed membership from
    // `LEXICAL_TAB_CHIPS`, so all of them clear the ≥2 rule by construction and
    // none can arrive empty — there is no host half to wait for.
    const order = LEXICAL_TAB_GROUP_ORDER.get(cat)!;
    const active = grp !== undefined && order.includes(grp) ? LEXICAL_TAB_CHIPS[grp]!.keys : undefined;
    buttons = (active ?? LEX_KEYS.filter((k) => LEXICON[k]!.cat === cat)).map((k) => wordJson(k));
    // The face is simply the chip's own leading members: a word has no
    // properties to rank by (the noun clusters' `exemplarOrder` reads exactly
    // that), and the members are authored in the order a child meets them.
    groups = order.map((id) => groupChip(id, LEXICAL_TAB_CHIPS[id]!.keys));
  } else if (cat && BUILDER_CATEGORIES.includes(cat)) {
    buttons = LEX_KEYS.filter((k) => LEXICON[k]!.cat === cat).map(wordJson);
  } else {
    const active = grp !== undefined ? suggestion.groups.find((g) => g.id === grp) : undefined;
    buttons = (active ? active.members : suggestion.buttons).map(surfaceWord);
    groups = suggestion.groups.map((g) => groupChip(g.id, g.exemplars.map((e) => e.symbol)));
  }

  const modifiers = modifierRail(tokens, nounByHead, lang);

  return {
    buttons,
    ...(modifiers.length ? { modifiers } : {}),
    categories: [...BUILDER_CATEGORIES],
    ...(groups && groups.length ? { groups } : {}),
    complete: suggestion.complete,
    // The surfacer decides WHEN a type chip exists (empty board only); the
    // adapter never second-guesses it, and omits the key entirely otherwise.
    ...(suggestion.typeChips.length
      ? { typeChips: suggestion.typeChips.map((c) => ({ kind: c.kind as string, label: c.label })) }
      : {}),
  };
}

/** Lang-layer head that LABELS a kind-cluster chip (the property clusters are
 *  their own heads — "food", "toy" — already words in every ruleset).
 *
 *  Exported because `builder-coverage.ts` has to know which heads a chip can
 *  wear in order to check they are sayable; a mirrored copy over there would be
 *  free to drift from this one, which is the whole failure mode that module
 *  exists to catch. */
export const GROUP_LABEL_HEAD: Record<string, string> = {
  creatures: "person",
  places: "place",
  things: "thing",
  // The LIVING split (2026-08-27). `creatures` keeps the people — the chip that
  // means "somebody" — and the two kinds of living thing that are NOT somebody
  // get their own. `plants` is deliberately not the head `plant`: that head is
  // the VERB (he שותל, es planto), so labelling the chip with it would put "he
  // is planting" on a category of nouns in three of the four rulesets.
  animals: "animal",
  plants: "plants",
  // THE SPECIFIC PEOPLE (2026-09-01). Distinct from `creatures`/"person", which
  // is somebody in GENERAL — this chip is the people a child actually knows,
  // one list whose members are real contacts outside a game and the characters
  // standing in for them inside one.
  individuals: "individuals",
  // The place split (2026-08-25) — each id is already a lang-layer word.
  room: "room",
  building: "building",
  outside: "outside",

  // ── THE TWO BIG LEXICAL TABS' CHIPS (2026-09-04) ─────────────────────────
  // Listed even where the head IS the id, because `builder-coverage.ts` reads
  // the VALUES of this table to decide which heads a chip can wear: an id left
  // out of here is a chip nobody checks the translations of, and it renders as
  // the raw English id on a Hebrew board — silently, the whole failure mode
  // that module exists to catch.
  //
  // ⚠️ `colors`, NOT `color`, and for exactly the reason `plants` is not
  // `plant`: the head `color` is the VERB ("color the shirt", he צובע, es
  // coloreo), so labelling a category of adjectives with it would put a
  // conjugated verb on the chip in three of the four rulesets. `feelings`,
  // `hands` and `body` are new nouns for the same reason — there is no existing
  // head that names those sets without being something else.
  colors: "colors",
  feelings: "feelings",
  size: "size",
  condition: "condition",
  // The ACTION chips deliberately DO wear verb heads where one already names
  // the family exactly (`go`, `make`, `want`) or is already an adverbial
  // (`together`): "go" is the name of the going family, not a stray conjugation
  // standing in for it. The two that had no such head get nouns.
  go: "go",
  hands: "hands",
  make: "make",
  together: "together",
  body: "body",
  want: "want",
};

/** The surfacer's own noun clustering (surface-next buildGroups), applied to
 *  the FULL noun list for the "things" tab's sub-group chips: one cluster per
 *  object property, plus the kind clusters (people / animals / plants / the
 *  three place kinds / plain things). Deterministic: noun-list order, first
 *  appearance first. */
function thingClusters(nouns: BuilderNounEntry[]): Map<string, BuilderNounEntry[]> {
  const clusters = new Map<string, BuilderNounEntry[]>();
  const push = (id: string, n: BuilderNounEntry) => {
    const arr = clusters.get(id) ?? [];
    arr.push(n);
    clusters.set(id, arr);
  };
  for (const n of nouns) {
    // The SAME rule the surfacer reads (content/noun-clusters.ts) — the things
    // tab's sub-chips and the board's chips are one question asked twice, and
    // when they were two answers they drifted.
    for (const c of clusterIdsOf(n)) push(c.id, n);
  }
  return clusters;
}

/** The modifier rail for the ACTIVE head (the last composed word): its
 *  descriptor axes (object-properties.ts) flattened to words, most relevant
 *  axis first — food talks temperature, people talk feelings. Engine-side and
 *  registry-free: nouns rank by their kind+properties, the person deixis words
 *  by the creature axes; other function words offer no rail. */
function modifierRail(
  tokens: string[],
  nounByHead: Map<string, BuilderNounEntry>,
  lang: GlyphLanguage,
): BuilderWordJson[] {
  const last = tokens[tokens.length - 1];
  if (!last) return [];
  const head = headSym(last);
  const applied = new Set(last.replace(/#\w+/g, "").split(".").slice(1).map((m) => m.trim().toLowerCase()));

  let axes: readonly DescriptorAxis[];
  const noun = nounByHead.get(head);
  if (noun) axes = descriptorAxesFor(noun.kind ?? "unknown", noun.properties ?? []);
  else if (ANIMATE_DEIXIS.has(head)) axes = descriptorAxesFor("creature", []);
  else return []; // verbs / questions / joiners take no descriptor rail

  const out: BuilderWordJson[] = [];
  const seen = new Set<string>();
  for (const axis of axes) {
    for (const w of AXIS_WORDS[axis]) {
      if (seen.has(w) || applied.has(w) || w === head) continue;
      seen.add(w);
      out.push({
        key: w,
        label: baseWord(lang, w),
        glyph: w,
        category: LEXICON[w]?.cat ?? "modifier",
        // The axis this word came from — the rail already knows it, and a
        // client needs it to keep the axis exclusive.
        axis,
      });
      if (out.length >= MODIFIER_RAIL_CAP) return out;
    }
  }
  return out;
}
