// shared/glyph-registry.ts
//
// Shared registry for the glyph system. Three lenses on the same vocabulary:
// - Vocabulary: items shown in construction-board grids and AI strips.
// - Modifier:   items that can be appended to a slot (slot.mod.mod syntax).
// - Dimension:  values that guessing-mode walks through to narrow a target.
//
// One item can have multiple facets: e.g. `big` is a WHAT-tab item AND a
// modifier on nouns AND a dimension value for `size`.
//
// See planning-docs/glyph-system.md for the full design.

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type GlyphCategory = "who" | "do" | "what" | "where" | "when";

/** Coarse part-of-speech used to decide modifier applicability. */
export type GlyphPos =
  | "person"
  | "animal"
  | "noun"
  | "verb"
  | "place"
  | "time"
  | "feeling"
  | "modifier";

/** Tone family — drives background color of the rendered button. */
export type ToneFamily =
  | "request"      // warm amber — want/need
  | "comment"      // neutral — labels, descriptions
  | "feeling"      // soft pink — emotional state
  | "social"       // warm teal — greetings, social
  | "question";    // cool purple — interrogatives

/** Modifier visual transforms applied by the compositor. */
export type ModifierTransform =
  | "badge"        // small icon above the slot symbol (default)
  | "red_x"        // red slash/X overlay (not)
  | "dots"         // dot indicators for counts (1, 2, 3, many)
  | "hands"        // hands-holding-symbol overlay (my, your)
  | "glow"         // emphasis glow lines (very)
  | "shrink"       // smaller render (little)
  | "halo_warm"    // warm halo (hot)
  | "halo_cool"    // cool halo (cold)
  | "dimension"    // arrow decorations + image warp (big/small/long/short/tall/wide/thin)
  | "color";       // colored frame around slot rim — color name lives in modifier.colorValue

/**
 * Dimension-modifier shapes. Each pattern drives both an arrow-decoration
 * layout drawn around the slot AND a [x, y] scale that warps the host
 * image to visually match the adjective (big → enlarged, thin → narrower
 * etc.). The compositor switches on `pattern` to draw the right arrows.
 */
export type DimensionPattern =
  | "big"            // 4 corner arrows pointing outward; image scaled up
  | "small"          // 4 corner arrows pointing inward; image scaled down
  | "length_long"    // double-headed arrow below; image stretched horizontally
  | "length_short"   // two inward arrows below; image compressed horizontally
  | "tall_high"      // single side arrow pointing up; image stretched vertically
  | "short_low"      // single side half-arrow pointing down; image compressed vertically
  | "wide"           // two side arrows pointing outward; image stretched horizontally
  | "thin";          // two side arrows pointing inward; image compressed horizontally

export interface ModifierFacet {
  /** Coarse types this modifier can apply to. */
  appliesTo: GlyphPos[];
  /** How the compositor renders it on the slot. */
  transform: ModifierTransform;
  /** Sort hint within the modifier carousel; lower = leftmost. */
  order: number;
  /**
   * Anchor corner for badge-style modifiers. Defaults to "top-left". RTL
   * flips the horizontal side automatically (top-left → top-right, etc.),
   * so authors should always specify the LTR position here.
   */
  corner?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  /**
   * Required when `transform === "dimension"` — picks the arrow layout
   * and image-warp scale. The compositor reads this to draw arrows
   * around the slot AND to scale the host symbol so it visually matches
   * the adjective (big stretches outward, thin compresses horizontally,
   * etc.). See DimensionPattern.
   */
  dimension?: DimensionPattern;
  /**
   * Required when `transform === "color"` — CSS color string (hex
   * preferred) that the compositor uses for the colored frame around
   * the slot. e.g. "#DC2626" for color_red.
   */
  colorValue?: string;
  /**
   * When true, this modifier is hidden from the generic modifier
   * carousel — the construction board surfaces it through a dedicated
   * UI affordance instead (currently used by the color picker). The AI
   * can still emit the key directly; only the carousel listing is
   * suppressed.
   */
  hiddenFromCarousel?: boolean;
}

export interface DimensionValueFacet {
  /** Dimension id this value belongs to (e.g. "size", "kind"). */
  dimension: string;
  /** Value within that dimension (e.g. "big" → values include "big"|"small"). */
  value: string;
}

/**
 * Composable facet — this item is a "host" with an embedded payload slot.
 * Renders as the host image with a payload image overlaid on top (e.g.
 * `want(apple)` → the want-hands image with an apple centered inside it).
 *
 * Composable items signal the AI strip to suggest fillers for the payload
 * rather than candidates for the next sentence slot. Open-ended: any item
 * can be made composable by adding this facet.
 */
export interface ComposableFacet {
  /** Coarse part-of-speech types accepted as the embedded payload. */
  accepts: GlyphPos[];
  /**
   * Categories the AI should bias suggestions toward when proposing
   * fillers (e.g. a "want" host suggests WHAT items). The construction
   * board can also use this to pivot its grid focus.
   */
  suggestCategories: GlyphCategory[];
  /** Where the payload renders relative to the host glyph. Defaults to "center". */
  position?: "center" | "upper";
}

export interface VocabularyItem {
  /** Stable kebab-or-snake key. Appears in the glyph string. */
  key: string;
  /** i18n key, format: aac.glyph.<key> */
  tKey: string;
  /** Coarse part-of-speech for modifier applicability. */
  pos: GlyphPos;
  /** Categories this item appears in. Cross-listed items belong to multiple. */
  categories: GlyphCategory[];
  /** Mode chips this item is shown under, per category. */
  modeChips: Partial<Record<GlyphCategory, string[]>>;
  /** Default tone family for the button background. */
  tone: ToneFamily;
  /** Relative path under attached_assets/aac-icons (no extension). */
  imagePath?: string;
  /** Emoji fallback when no image is available. */
  emoji?: string;
  /** Optional FontAwesome class (rare; prefer images/emoji). */
  faIcon?: string;
  /** When present, this item can also act as a modifier on staged slots. */
  modifier?: ModifierFacet;
  /** When present, this item is also a value in a guessing-mode dimension. */
  dimensionValue?: DimensionValueFacet;
  /** When present, this item is a host with an embedded payload slot. */
  composable?: ComposableFacet;
}

/** Top-level dimension definition for guessing mode. */
export interface GlyphDimension {
  id: string;
  category: GlyphCategory;
  type: "categorical" | "binary" | "ternary";
  /** Keys of vocabulary items whose dimensionValue.dimension === this id. */
  values: string[];
  /** Higher = asked sooner. */
  priority: number;
  /** Optional gating: e.g. `animal_habitat` only applies when `kind=animal` dominant. */
  appliesWhen?: { dimension: string; dominantValue: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary seed (common-only)
// ─────────────────────────────────────────────────────────────────────────────
//
// Long-tail items are handled by the AI strip + on-demand image generation.
// Items here are the stable, learnable subset the eyegaze user can rely on.

const VOCAB: VocabularyItem[] = [
  // ── WHO ──────────────────────────────────────────────────────────────────
  { key: "i_me", tKey: "aac.glyph.i_me", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "comment",
    imagePath: "people/me", emoji: "👤" },
  { key: "you", tKey: "aac.glyph.you", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "comment",
    imagePath: "people/you", emoji: "🫵" },
  { key: "we", tKey: "aac.glyph.we", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "comment",
    imagePath: "people/us", emoji: "👥" },
  { key: "they", tKey: "aac.glyph.they", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "comment", emoji: "👥" },
  { key: "mom", tKey: "aac.glyph.mom", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "social", emoji: "👩" },
  { key: "dad", tKey: "aac.glyph.dad", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "social", emoji: "👨" },
  { key: "baby", tKey: "aac.glyph.baby", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "social", emoji: "👶" },
  { key: "sister", tKey: "aac.glyph.sister", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "social", emoji: "👧" },
  { key: "brother", tKey: "aac.glyph.brother", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "social", emoji: "👦" },
  { key: "friend", tKey: "aac.glyph.friend", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "social", emoji: "🧑‍🤝‍🧑" },
  { key: "teacher", tKey: "aac.glyph.teacher", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "social", emoji: "🧑‍🏫" },
  { key: "doctor", tKey: "aac.glyph.doctor", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "social", emoji: "🧑‍⚕️" },

  // ── DO ───────────────────────────────────────────────────────────────────
  { key: "want", tKey: "aac.glyph.want", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "request",
    imagePath: "actions/hands/want", emoji: "🤲",
    composable: { accepts: ["noun", "animal", "person", "place"], suggestCategories: ["what", "who"] } },
  { key: "give", tKey: "aac.glyph.give", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "request",
    imagePath: "actions/hands/give", emoji: "🫴",
    composable: { accepts: ["noun", "animal"], suggestCategories: ["what"] } },
  { key: "take", tKey: "aac.glyph.take", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "request",
    imagePath: "actions/hands/take", emoji: "🫳",
    composable: { accepts: ["noun", "animal"], suggestCategories: ["what"] } },
  { key: "receive", tKey: "aac.glyph.receive", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "comment",
    imagePath: "actions/hands/receive", emoji: "🙌",
    composable: { accepts: ["noun", "animal"], suggestCategories: ["what"] } },
  { key: "have", tKey: "aac.glyph.have", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "comment",
    imagePath: "actions/hands/hold", emoji: "✊",
    composable: { accepts: ["noun", "animal"], suggestCategories: ["what"] } },
  { key: "make", tKey: "aac.glyph.make", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "request",
    imagePath: "actions/hands/make", emoji: "🔨",
    composable: { accepts: ["noun", "animal"], suggestCategories: ["what"] } },
  { key: "use", tKey: "aac.glyph.use", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "comment",
    imagePath: "actions/hands/use", emoji: "🛠️",
    composable: { accepts: ["noun"], suggestCategories: ["what"] } },
  { key: "like", tKey: "aac.glyph.like", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "mental"] }, tone: "feeling", emoji: "❤️" },
  { key: "see", tKey: "aac.glyph.see", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "sensory"] }, tone: "comment", emoji: "👁️" },
  { key: "hear", tKey: "aac.glyph.hear", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "sensory"] }, tone: "comment", emoji: "👂" },
  { key: "go", tKey: "aac.glyph.go", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "body"] }, tone: "request", emoji: "🚶" },
  { key: "play", tKey: "aac.glyph.play", pos: "verb", categories: ["do"],
    modeChips: { do: ["common"] }, tone: "request", emoji: "🎮" },
  { key: "eat", tKey: "aac.glyph.eat", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "body"] }, tone: "request", emoji: "🍽️" },
  { key: "drink", tKey: "aac.glyph.drink", pos: "verb", categories: ["do"],
    modeChips: { do: ["common"] }, tone: "request", emoji: "🥤" },
  { key: "help", tKey: "aac.glyph.help", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "social"] }, tone: "request", emoji: "🆘" },
  { key: "say", tKey: "aac.glyph.say", pos: "verb", categories: ["do"],
    modeChips: { do: ["social", "mental"] }, tone: "social", emoji: "💬",
    composable: { accepts: ["noun", "animal", "person", "place", "feeling"],
                  suggestCategories: ["what", "who"], position: "upper" } },
  { key: "think", tKey: "aac.glyph.think", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "mental"] }, tone: "comment", emoji: "💭",
    composable: { accepts: ["noun", "animal", "person", "place", "feeling"],
                  suggestCategories: ["what", "who"], position: "upper" } },
  { key: "stop", tKey: "aac.glyph.stop", pos: "verb", categories: ["do"],
    modeChips: { do: ["body"] }, tone: "request", emoji: "🛑" },

  // ── WHAT ─────────────────────────────────────────────────────────────────
  { key: "water", tKey: "aac.glyph.water", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "drink"] }, tone: "comment", emoji: "💧" },
  { key: "food", tKey: "aac.glyph.food", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🍽️" },
  { key: "ball", tKey: "aac.glyph.ball", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "toys"] }, tone: "comment", emoji: "⚽" },
  { key: "book", tKey: "aac.glyph.book", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "toys", "things"] }, tone: "comment", emoji: "📖" },
  { key: "phone", tKey: "aac.glyph.phone", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "📱" },
  { key: "chair", tKey: "aac.glyph.chair", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🪑" },
  { key: "bed", tKey: "aac.glyph.bed", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🛏️" },
  { key: "shirt", tKey: "aac.glyph.shirt", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "clothes"] }, tone: "comment", emoji: "👕" },
  { key: "shoes", tKey: "aac.glyph.shoes", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "clothes"] }, tone: "comment", emoji: "👟" },

  // ── WHERE ────────────────────────────────────────────────────────────────
  // `home`, `school`, `park` cross-listed in WHAT (places mode-chip).
  { key: "home", tKey: "aac.glyph.home", pos: "place", categories: ["where", "what"],
    modeChips: { where: ["places"], what: ["places"] }, tone: "comment", emoji: "🏠" },
  { key: "school", tKey: "aac.glyph.school", pos: "place", categories: ["where", "what"],
    modeChips: { where: ["places"], what: ["places"] }, tone: "comment", emoji: "🏫" },
  { key: "outside", tKey: "aac.glyph.outside", pos: "place", categories: ["where"],
    modeChips: { where: ["places"] }, tone: "comment", emoji: "🌳" },
  { key: "bedroom", tKey: "aac.glyph.bedroom", pos: "place", categories: ["where"],
    modeChips: { where: ["rooms"] }, tone: "comment", emoji: "🛌" },
  { key: "kitchen", tKey: "aac.glyph.kitchen", pos: "place", categories: ["where"],
    modeChips: { where: ["rooms"] }, tone: "comment", emoji: "🍳" },
  { key: "bathroom", tKey: "aac.glyph.bathroom", pos: "place", categories: ["where"],
    modeChips: { where: ["rooms"] }, tone: "comment", emoji: "🚽" },
  { key: "park", tKey: "aac.glyph.park", pos: "place", categories: ["where", "what"],
    modeChips: { where: ["places"], what: ["places"] }, tone: "comment", emoji: "🛝" },
  { key: "here", tKey: "aac.glyph.here", pos: "place", categories: ["where"],
    modeChips: { where: ["spatial"] }, tone: "comment", emoji: "📍" },
  { key: "there", tKey: "aac.glyph.there", pos: "place", categories: ["where"],
    modeChips: { where: ["spatial"] }, tone: "comment", emoji: "🎯" },

  // ── Indicators (deictic pointers — cross-listed under WHO and WHAT) ──────
  { key: "that", tKey: "aac.glyph.that", pos: "noun", categories: ["who", "what"],
    modeChips: { who: ["all"], what: ["all", "things"] }, tone: "comment",
    imagePath: "indicators/that", emoji: "👉" },

  // ── WHEN ─────────────────────────────────────────────────────────────────
  { key: "now", tKey: "aac.glyph.now", pos: "time", categories: ["when"],
    modeChips: { when: ["quick"] }, tone: "comment", emoji: "⏱️" },
  { key: "today", tKey: "aac.glyph.today", pos: "time", categories: ["when"],
    modeChips: { when: ["quick", "days"] }, tone: "comment", emoji: "📅" },
  { key: "tomorrow", tKey: "aac.glyph.tomorrow", pos: "time", categories: ["when"],
    modeChips: { when: ["quick", "days"] }, tone: "comment", emoji: "➡️" },
  { key: "yesterday", tKey: "aac.glyph.yesterday", pos: "time", categories: ["when"],
    modeChips: { when: ["quick", "days"] }, tone: "comment", emoji: "⬅️" },
  { key: "soon", tKey: "aac.glyph.soon", pos: "time", categories: ["when"],
    modeChips: { when: ["quick"] }, tone: "comment", emoji: "⏳" },
  { key: "later", tKey: "aac.glyph.later", pos: "time", categories: ["when"],
    modeChips: { when: ["quick"] }, tone: "comment", emoji: "🕓" },
  { key: "morning", tKey: "aac.glyph.morning", pos: "time", categories: ["when"],
    modeChips: { when: ["time-of-day"] }, tone: "comment", emoji: "🌅" },
  { key: "night", tKey: "aac.glyph.night", pos: "time", categories: ["when"],
    modeChips: { when: ["time-of-day"] }, tone: "comment", emoji: "🌙" },

  // ── Modifiers (also appear as vocabulary items in their relevant tabs) ───
  // Quantity dots
  { key: "one", tKey: "aac.glyph.one", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "1️⃣",
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "dots", order: 30 } },
  { key: "two", tKey: "aac.glyph.two", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "2️⃣",
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "dots", order: 31 } },
  { key: "many", tKey: "aac.glyph.many", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🔢",
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "dots", order: 32 } },

  // Possession — reuse the inward-/outward-hand artwork from the take/give
  // verbs so the directional meaning carries through. `my` (toward speaker)
  // anchors top-left; `your` (toward addressee) anchors bottom-left. RTL
  // mirrors the corner side and the image itself.
  { key: "my", tKey: "aac.glyph.my", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment",
    imagePath: "actions/hands/take", emoji: "🫳",
    modifier: { appliesTo: ["noun", "animal", "person", "place"], transform: "hands", order: 1, corner: "top-left" } },
  { key: "your", tKey: "aac.glyph.your", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment",
    imagePath: "actions/hands/give", emoji: "🫴",
    modifier: { appliesTo: ["noun", "animal", "person", "place"], transform: "hands", order: 2, corner: "bottom-left" } },

  // Negation
  { key: "not", tKey: "aac.glyph.not", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "❌",
    modifier: { appliesTo: ["noun", "animal", "person", "place", "verb", "feeling"],
                transform: "red_x", order: 0 } },

  // Intensity (also dimension values for "intensity")
  { key: "very", tKey: "aac.glyph.very", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "✨",
    modifier: { appliesTo: ["verb", "feeling", "modifier"], transform: "glow", order: 3 },
    dimensionValue: { dimension: "intensity", value: "very" } },
  { key: "little", tKey: "aac.glyph.little", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🤏",
    modifier: { appliesTo: ["verb", "feeling", "modifier"], transform: "shrink", order: 4 },
    dimensionValue: { dimension: "intensity", value: "little" } },

  // Dimension adjectives — vocabulary in WHAT, modifier on nouns. When
  // applied as a modifier the compositor draws arrow decorations around
  // the slot AND warps the host image to match the adjective. Bundled
  // icons under attached_assets/aac-icons/adjectives/dimension/ render
  // when the key is staged as a standalone slot. See DimensionPattern.
  { key: "big", tKey: "aac.glyph.big", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment",
    imagePath: "adjectives/dimension/big", emoji: "📏",
    modifier: { appliesTo: ["noun", "animal"], transform: "dimension", order: 5, dimension: "big" },
    dimensionValue: { dimension: "size", value: "big" } },
  { key: "small", tKey: "aac.glyph.small", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment",
    imagePath: "adjectives/dimension/small", emoji: "🐭",
    modifier: { appliesTo: ["noun", "animal"], transform: "dimension", order: 6, dimension: "small" },
    dimensionValue: { dimension: "size", value: "small" } },
  { key: "length_long", tKey: "aac.glyph.length_long", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment",
    imagePath: "adjectives/dimension/long", emoji: "↔️",
    modifier: { appliesTo: ["noun", "animal"], transform: "dimension", order: 7, dimension: "length_long" } },
  { key: "length_short", tKey: "aac.glyph.length_short", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment",
    imagePath: "adjectives/dimension/short", emoji: "🩳",
    modifier: { appliesTo: ["noun", "animal"], transform: "dimension", order: 8, dimension: "length_short" } },
  { key: "tall_high", tKey: "aac.glyph.tall_high", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment",
    imagePath: "adjectives/dimension/tall_high", emoji: "⬆️",
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "dimension", order: 9, dimension: "tall_high" } },
  { key: "short_low", tKey: "aac.glyph.short_low", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment",
    imagePath: "adjectives/dimension/short_low", emoji: "⬇️",
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "dimension", order: 10, dimension: "short_low" } },
  { key: "wide", tKey: "aac.glyph.wide", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment",
    imagePath: "adjectives/dimension/wide", emoji: "↔️",
    modifier: { appliesTo: ["noun", "animal"], transform: "dimension", order: 11, dimension: "wide" } },
  { key: "thin", tKey: "aac.glyph.thin", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment",
    imagePath: "adjectives/dimension/thin", emoji: "📏",
    modifier: { appliesTo: ["noun", "animal"], transform: "dimension", order: 12, dimension: "thin" } },

  // Temperature
  { key: "hot", tKey: "aac.glyph.hot", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment", emoji: "🔥",
    modifier: { appliesTo: ["noun"], transform: "halo_warm", order: 20 } },
  { key: "cold", tKey: "aac.glyph.cold", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment", emoji: "❄️",
    modifier: { appliesTo: ["noun"], transform: "halo_cool", order: 21 } },

  // ── Color modifiers ────────────────────────────────────────────────────
  // The compositor renders a colored frame around the slot rim when one of
  // these is applied. They're hidden from the modifier carousel — the
  // construction board exposes them via a dedicated color-picker popup —
  // but the AI may emit any of these keys directly. Standalone (used as
  // a slot rather than a modifier) they appear as a colored square emoji.
  { key: "color_red", tKey: "aac.glyph.color_red", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟥",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 50, colorValue: "#DC2626", hiddenFromCarousel: true } },
  { key: "color_orange", tKey: "aac.glyph.color_orange", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟧",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 51, colorValue: "#EA580C", hiddenFromCarousel: true } },
  { key: "color_yellow", tKey: "aac.glyph.color_yellow", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟨",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 52, colorValue: "#FACC15", hiddenFromCarousel: true } },
  { key: "color_green", tKey: "aac.glyph.color_green", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟩",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 53, colorValue: "#16A34A", hiddenFromCarousel: true } },
  { key: "color_blue", tKey: "aac.glyph.color_blue", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟦",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 54, colorValue: "#2563EB", hiddenFromCarousel: true } },
  { key: "color_purple", tKey: "aac.glyph.color_purple", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟪",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 55, colorValue: "#9333EA", hiddenFromCarousel: true } },
  { key: "color_pink", tKey: "aac.glyph.color_pink", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🩷",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 56, colorValue: "#EC4899", hiddenFromCarousel: true } },
  { key: "color_brown", tKey: "aac.glyph.color_brown", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟫",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 57, colorValue: "#92400E", hiddenFromCarousel: true } },
  { key: "color_black", tKey: "aac.glyph.color_black", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "⬛",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 58, colorValue: "#111827", hiddenFromCarousel: true } },
  { key: "color_white", tKey: "aac.glyph.color_white", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "⬜",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 59, colorValue: "#F3F4F6", hiddenFromCarousel: true } },
  { key: "color_gray", tKey: "aac.glyph.color_gray", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "◻️",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 60, colorValue: "#6B7280", hiddenFromCarousel: true } },

  // Social
  { key: "please", tKey: "aac.glyph.please", pos: "modifier", categories: ["do"],
    modeChips: { do: ["social"] }, tone: "social", emoji: "🙏",
    modifier: { appliesTo: ["verb"], transform: "badge", order: 1 } },
  { key: "again", tKey: "aac.glyph.again", pos: "modifier", categories: ["do"],
    modeChips: { do: ["relation"] }, tone: "comment", emoji: "🔁",
    modifier: { appliesTo: ["verb"], transform: "badge", order: 2 } },
  { key: "more", tKey: "aac.glyph.more", pos: "modifier", categories: ["do"],
    modeChips: { do: ["relation"] }, tone: "request", emoji: "➕",
    modifier: { appliesTo: ["noun", "verb"], transform: "badge", order: 3 } },
];

// ─────────────────────────────────────────────────────────────────────────────
// Dimensions (for guessing mode)
// ─────────────────────────────────────────────────────────────────────────────
//
// The guessing-mode plan owns the full dimension catalog. This is the
// scaffolding that overlaps with vocabulary — values like "big"/"small" live
// in VOCAB with a dimensionValue facet. Pure dimensions (e.g. `kind`) are
// declared here with their value lists.

const DIMENSIONS: GlyphDimension[] = [
  { id: "size", category: "what", type: "binary",
    values: ["big", "small"], priority: 70 },
  { id: "intensity", category: "do", type: "binary",
    values: ["very", "little"], priority: 50 },
  // `kind`, `animal_habitat`, etc. live in the guessing-mode state module;
  // they don't need vocabulary-item backing.
];

// ─────────────────────────────────────────────────────────────────────────────
// Lookup helpers
// ─────────────────────────────────────────────────────────────────────────────

const BY_KEY: ReadonlyMap<string, VocabularyItem> = new Map(
  VOCAB.map((v) => [v.key, v])
);

export function getVocabularyItem(key: string): VocabularyItem | undefined {
  return BY_KEY.get(key);
}

export function listAllVocabulary(): readonly VocabularyItem[] {
  return VOCAB;
}

export function listByCategory(category: GlyphCategory): VocabularyItem[] {
  return VOCAB.filter((v) => v.categories.includes(category));
}

export function listByModeChip(
  category: GlyphCategory,
  modeChip: string
): VocabularyItem[] {
  return VOCAB.filter((v) => {
    if (!v.categories.includes(category)) return false;
    const chips = v.modeChips[category];
    return !!chips && chips.includes(modeChip);
  });
}

/** Modifiers that can apply to an item of the given part-of-speech. */
export function modifiersFor(pos: GlyphPos): VocabularyItem[] {
  return VOCAB.filter((v) =>
    !!v.modifier
    && v.modifier.appliesTo.includes(pos)
    && !v.modifier.hiddenFromCarousel
  ).sort((a, b) => (a.modifier!.order - b.modifier!.order));
}

/**
 * Color modifiers applicable to the given pos. Exposed separately
 * because the construction board surfaces them through a dedicated
 * color-picker popup rather than the regular modifier carousel — the
 * carousel filters them out via `hiddenFromCarousel`.
 */
export function colorModifiersFor(pos: GlyphPos): VocabularyItem[] {
  return VOCAB.filter((v) =>
    v.modifier?.transform === "color"
    && v.modifier.appliesTo.includes(pos)
  ).sort((a, b) => (a.modifier!.order - b.modifier!.order));
}

/** True when the host can accept an item with the given part-of-speech as its payload. */
export function canAcceptPayload(host: VocabularyItem, payloadPos: GlyphPos): boolean {
  return !!host.composable && host.composable.accepts.includes(payloadPos);
}

export function listDimensions(category: GlyphCategory): GlyphDimension[] {
  return DIMENSIONS.filter((d) => d.category === category);
}

export function getDimension(id: string): GlyphDimension | undefined {
  return DIMENSIONS.find((d) => d.id === id);
}

/** Static mode chips per category, used by the construction board sidebar. */
export const MODE_CHIPS: Record<GlyphCategory, readonly string[]> = {
  who: ["all", "people", "animals", "photos"],
  do: ["common", "hands", "sensory", "body", "social", "mental", "relation"],
  what: ["all", "food", "drink", "toys", "clothes", "things", "places", "body_parts", "people", "ideas"],
  where: ["places", "rooms", "spatial"],
  when: ["quick", "days", "time-of-day", "clock", "routine", "frequency"],
};

/** Default mode chip per category — first in the list. */
export function defaultModeChip(category: GlyphCategory): string {
  return MODE_CHIPS[category][0];
}
