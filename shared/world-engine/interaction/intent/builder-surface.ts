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
//                 FULL noun list. `opts.group` filters within the active view,
//                 exactly like tapping a group cell in the SpeakMenu.
//   complete    ← suggestion.complete
// DROPPED (no bridge field — the flat wire contract has no controls layer):
//   typeChips (seedKind isn't in builder_state),
//   open/subTab (debug/ranking detail already baked into button order),
//   weights/roles (ordering carries them).

import { LEXICON, tokenizeSentence } from "./parse-intent.js";
import { exemplarOrder, GROUP_EXEMPLARS, surfaceNext, type SurfaceNoun } from "./surface-next.js";
import { AXIS_WORDS, descriptorAxesFor, type DescriptorAxis } from "../../object-properties.js";
import { propertiesOf } from "../content/properties.js";
import {
  DEFAULT_ROOM_PROGRAMS,
  DEFAULT_STRUCTURE_PROGRAMS,
  roomDisplayGlyph,
  structureProgramDisplayGlyph,
  type RoomProgramDef,
  type StructureProgramDef,
} from "../../kernel/town/programs.js";
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
   */
  glyph?: string;
}

export interface BuilderSurfaceOpts {
  nouns?: BuilderNounEntry[];
  /** BCP-47 locale for word labels (lang-layer lexicon; en fallback). */
  locale?: string;
  /** Filter to one category tab (one of `BUILDER_CATEGORIES`). */
  category?: string;
  /** Filter within the active view to one sub-category chip (a `groups[].id`
   *  from the previous surface). Unknown/stale ids fall back to the full view. */
  group?: string;
  /** Main-grid budget (the surfacer default is 16). */
  capacity?: number;
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
// The default game objects (world-engine-aac-integration.md)
// ---------------------------------------------------------------------------
//
// The OUT-OF-GAME builder has no host pushing a noun list, so the "things" tab
// would be empty. This is the curated stand-in: the standard objects a student
// composes sentences about, every head/glyph one the engine GENUINELY knows —
// the goods kinds (apple/banana/grape/cookie, shirt/dress), the authored toys
// (ball/blocks/puzzle) plus the teddy as the DOLL FACET it actually is
// (`bear.toy` — "teddy" is retired as a word), the common stations
// (bed/table/chair/box/refrigerator/oven), book/bowl/lamp, and water (a core
// engine concept, the one entry with legitimately no spec properties). So an
// out-of-game composition round-trips into any game unchanged.
//
// PROPERTIES COME FROM THE SPEC SIDE (user law): each entry's properties are
// read through `propertiesOf` at call time, never authored here — this list
// only names WHICH objects surface. `acts` adds the station's own use verbs
// (you SLEEP in a bed) on top of the property-implied affordances.

const DEFAULT_NOUNS: readonly { symbol: string; acts?: readonly string[] }[] = [
  // Food + drink
  { symbol: "apple" },
  { symbol: "banana" },
  { symbol: "grape" },
  { symbol: "cookie" },
  { symbol: "water", acts: ["drink", "fill"] },
  // Toys (the authored set + the teddy, as the doll facet)
  { symbol: "ball" },
  { symbol: "blocks" },
  { symbol: "puzzle" },
  { symbol: "bear.toy" },
  // Clothing
  { symbol: "shirt" },
  { symbol: "dress" },
  // Around the house
  { symbol: "book" },
  { symbol: "bowl", acts: ["fill"] },
  { symbol: "box" },
  { symbol: "bed", acts: ["sleep", "rest"] },
  { symbol: "table", acts: ["eat"] },
  { symbol: "chair", acts: ["sit"] },
  { symbol: "refrigerator" },
  { symbol: "oven", acts: ["cook", "heat"] },
  { symbol: "lamp" },
];

/** The verbs a thing's PROPERTIES imply (the quest host's own affordance
 *  derivation, mirrored) — mechanics and board agree by construction. */
function propertyAffords(props: readonly string[]): string[] {
  const v: string[] = [];
  if (props.includes("food")) v.push("eat");
  if (props.includes("clothing")) v.push("wear", "wash");
  if (props.includes("toy")) v.push("play");
  if (props.includes("openable")) v.push("open", "shut");
  if (props.includes("container")) v.push("put");
  if (props.includes("furniture")) v.push("go");
  return v;
}

/**
 * The default game objects for a builder with NO live host (the AAC's
 * out-of-game sentence builder): curated standard objects with spec-derived
 * properties and affordances. Deterministic order (the list above); all
 * `kind: "item"`, no `present` flags — there is no scene to be present in.
 */
export function defaultBuilderNouns(): BuilderNounEntry[] {
  return [
    ...DEFAULT_NOUNS.map(({ symbol, acts }) => {
      const properties = propertiesOf(symbol);
      const affords = [...new Set(["want", "get", "give", ...(acts ?? []), ...propertyAffords(properties)])];
      return { symbol, kind: "item" as const, affords, properties };
    }),
    ...placeBuilderNouns(),
  ];
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

/** Person-deixis heads that take the CREATURE descriptor axes ("i_me + hungry"). */
const ANIMATE_DEIXIS = new Set(["i_me", "you", "we", "us", "they"]);

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
  const nouns = opts.nouns ?? [];

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
  }));

  const tokens = tokenizeSentence(partialGlyph);
  const suggestion = surfaceNext(tokens, {
    nouns: surfaceNouns,
    ...(opts.capacity !== undefined ? { capacity: opts.capacity } : {}),
    ...(opts.addressees?.length ? { parse: { addressees: opts.addressees } } : {}),
  });

  // ── Buttons + group chips (the SpeakMenu's hierarchy, wire-shaped) ─────────
  //   no category      → the ranked grid, with the surfacer's own group chips
  //                      (property/kind clusters); `group` opens one in place.
  //   category=things  → the FULL noun listing, sub-grouped by the SAME
  //                      property/kind clustering over the whole library.
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
    return {
      id,
      label: baseWord(lang, GROUP_LABEL_HEAD[id] ?? id),
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
  };
}

/** Lang-layer head that LABELS a kind-cluster chip (the property clusters are
 *  their own heads — "food", "toy" — already words in every ruleset). */
const GROUP_LABEL_HEAD: Record<string, string> = {
  creatures: "person",
  places: "place",
  things: "thing",
};

/** The surfacer's own noun clustering (surface-next buildGroups), applied to
 *  the FULL noun list for the "things" tab's sub-group chips: one cluster per
 *  object property, plus the kind clusters (creatures / places / plain
 *  things). Deterministic: noun-list order, first appearance first. */
function thingClusters(nouns: BuilderNounEntry[]): Map<string, BuilderNounEntry[]> {
  const clusters = new Map<string, BuilderNounEntry[]>();
  const push = (id: string, n: BuilderNounEntry) => {
    const arr = clusters.get(id) ?? [];
    arr.push(n);
    clusters.set(id, arr);
  };
  for (const n of nouns) {
    for (const p of n.properties ?? []) push(p, n);
    if (n.kind === "creature") push("creatures", n);
    else if (n.kind === "place") push("places", n);
    else if (n.kind === "item" && !(n.properties ?? []).length) push("things", n);
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
      });
      if (out.length >= MODIFIER_RAIL_CAP) return out;
    }
  }
  return out;
}
