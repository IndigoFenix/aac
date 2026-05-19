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
  /**
   * Where the payload renders relative to the host glyph. Defaults to
   * "center". Non-center positions are used by container-style hosts
   * whose artwork visually carves out a specific region for the
   * contained item:
   *   - `upper`        — upper third, horizontally centered (think
   *                      speech bubbles for `say` / `think`).
   *   - `lower-right`  — bottom-right quadrant (e.g. `play` shows a
   *                      child with a basket-like region).
   *   - `middle-right` — middle third vertically, right third
   *                      horizontally (e.g. `eat` — the food sits at
   *                      mouth height on the right side of the body).
   * In RTL the position mirrors horizontally so lower-right becomes
   * lower-left and middle-right becomes middle-left.
   */
  position?: "center" | "upper" | "lower-right" | "middle-right";
  /**
   * Optional alternate `imagePath` used when the host has no payload
   * filled. Composable hosts that want a distinct empty-state pose
   * (e.g. `play` → `actions/body/play-empty`) set this; the compositor
   * swaps `imagePath` for `emptyImagePath` when the slot's payload is
   * absent, and skips the dashed-circle "missing payload" placeholder
   * since the empty image already conveys the empty state.
   */
  emptyImagePath?: string;
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
  /**
   * True when the item's visual carries a semantic left/right direction
   * (motion verbs like run / walk, pointing gestures, time-flow arrows
   * for tomorrow / yesterday, palm-orientation for my / your). The
   * compositor flips horizontally in RTL only for items with this flag —
   * non-directional artwork (a cat, a cup) stays put because flipping it
   * would look uncanny without semantic gain. See <DIRECTIONAL_EMOJIS>
   * for the raw-emoji side of the same rule.
   */
  directional?: boolean;
  /**
   * True when this key should appear in the prompt's <bundled_icons>
   * list so the AI knows to use the registry key rather than picking
   * an emoji directly. Restricted to items the AI is unlikely to guess:
   * pronouns/deictics (`i_me`, `you`, `that`), abstract or relational
   * verbs (`want`, `give`, `like`, `go`), time concepts (`now`,
   * `tomorrow`), spatial deictics (`here`, `there`), and modifiers
   * (which adjust adjacent slots in ways an emoji can't express).
   * Everything else — animals, food, body parts, vehicles, body
   * actions, family relations — has a straightforward emoji and is
   * deliberately left off the prompt list to keep token counts down;
   * the registry still accepts the keys (resolveEmoji maps them) but
   * the AI is steered toward emojis for those concepts.
   */
  exposeToAi?: boolean;
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
    imagePath: "people/me", emoji: "👤", exposeToAi: true },
  { key: "you", tKey: "aac.glyph.you", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "comment",
    imagePath: "people/you", emoji: "🫵", exposeToAi: true },
  { key: "we", tKey: "aac.glyph.we", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "comment",
    imagePath: "people/us", emoji: "👥", exposeToAi: true },
  { key: "they", tKey: "aac.glyph.they", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "comment", emoji: "👥", exposeToAi: true },
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
  { key: "nurse", tKey: "aac.glyph.nurse", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "social", emoji: "🧑‍⚕️" },
  { key: "grandma", tKey: "aac.glyph.grandma", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "social", emoji: "👵" },
  { key: "grandpa", tKey: "aac.glyph.grandpa", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "social", emoji: "👴" },
  { key: "boy", tKey: "aac.glyph.boy", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "comment", emoji: "👦" },
  { key: "girl", tKey: "aac.glyph.girl", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "comment", emoji: "👧" },
  { key: "man", tKey: "aac.glyph.man", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "comment", emoji: "👨" },
  { key: "woman", tKey: "aac.glyph.woman", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "comment", emoji: "👩" },

  // ── Animals (WHO + animals chip) ─────────────────────────────────────────
  { key: "cat", tKey: "aac.glyph.cat", pos: "animal", categories: ["who"],
    modeChips: { who: ["all", "animals"] }, tone: "comment", emoji: "🐈" },
  { key: "dog", tKey: "aac.glyph.dog", pos: "animal", categories: ["who"],
    modeChips: { who: ["all", "animals"] }, tone: "comment", emoji: "🐕" },
  { key: "bird", tKey: "aac.glyph.bird", pos: "animal", categories: ["who"],
    modeChips: { who: ["all", "animals"] }, tone: "comment", emoji: "🐦" },
  { key: "fish", tKey: "aac.glyph.fish", pos: "animal", categories: ["who"],
    modeChips: { who: ["all", "animals"] }, tone: "comment", emoji: "🐟" },
  { key: "rabbit", tKey: "aac.glyph.rabbit", pos: "animal", categories: ["who"],
    modeChips: { who: ["all", "animals"] }, tone: "comment", emoji: "🐰" },
  { key: "bear", tKey: "aac.glyph.bear", pos: "animal", categories: ["who"],
    modeChips: { who: ["all", "animals"] }, tone: "comment", emoji: "🐻" },
  { key: "lion", tKey: "aac.glyph.lion", pos: "animal", categories: ["who"],
    modeChips: { who: ["all", "animals"] }, tone: "comment", emoji: "🦁" },
  { key: "elephant", tKey: "aac.glyph.elephant", pos: "animal", categories: ["who"],
    modeChips: { who: ["all", "animals"] }, tone: "comment", emoji: "🐘" },
  { key: "monkey", tKey: "aac.glyph.monkey", pos: "animal", categories: ["who"],
    modeChips: { who: ["all", "animals"] }, tone: "comment", emoji: "🐵" },
  { key: "horse", tKey: "aac.glyph.horse", pos: "animal", categories: ["who"],
    modeChips: { who: ["all", "animals"] }, tone: "comment", emoji: "🐴" },
  { key: "cow", tKey: "aac.glyph.cow", pos: "animal", categories: ["who"],
    modeChips: { who: ["all", "animals"] }, tone: "comment", emoji: "🐄" },
  { key: "pig", tKey: "aac.glyph.pig", pos: "animal", categories: ["who"],
    modeChips: { who: ["all", "animals"] }, tone: "comment", emoji: "🐷" },
  { key: "duck", tKey: "aac.glyph.duck", pos: "animal", categories: ["who"],
    modeChips: { who: ["all", "animals"] }, tone: "comment", emoji: "🦆" },
  { key: "frog", tKey: "aac.glyph.frog", pos: "animal", categories: ["who"],
    modeChips: { who: ["all", "animals"] }, tone: "comment", emoji: "🐸" },
  { key: "butterfly", tKey: "aac.glyph.butterfly", pos: "animal", categories: ["who"],
    modeChips: { who: ["all", "animals"] }, tone: "comment", emoji: "🦋" },
  { key: "snake", tKey: "aac.glyph.snake", pos: "animal", categories: ["who"],
    modeChips: { who: ["all", "animals"] }, tone: "comment", emoji: "🐍" },
  { key: "turtle", tKey: "aac.glyph.turtle", pos: "animal", categories: ["who"],
    modeChips: { who: ["all", "animals"] }, tone: "comment", emoji: "🐢" },

  // ── DO ───────────────────────────────────────────────────────────────────
  { key: "want", tKey: "aac.glyph.want", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "request",
    imagePath: "actions/hands/want", emoji: "🤲", exposeToAi: true,
    composable: { accepts: ["noun", "animal", "person", "place"], suggestCategories: ["what", "who"] } },
  { key: "give", tKey: "aac.glyph.give", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "request",
    imagePath: "actions/hands/give", emoji: "🫴", directional: true, exposeToAi: true,
    composable: { accepts: ["noun", "animal"], suggestCategories: ["what"] } },
  { key: "take", tKey: "aac.glyph.take", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "request",
    imagePath: "actions/hands/take", emoji: "🫳", directional: true, exposeToAi: true,
    composable: { accepts: ["noun", "animal"], suggestCategories: ["what"] } },
  { key: "receive", tKey: "aac.glyph.receive", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "comment",
    imagePath: "actions/hands/receive", emoji: "🙌", exposeToAi: true,
    composable: { accepts: ["noun", "animal"], suggestCategories: ["what"] } },
  { key: "have", tKey: "aac.glyph.have", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "comment",
    imagePath: "actions/hands/hold", emoji: "✊", exposeToAi: true,
    composable: { accepts: ["noun", "animal"], suggestCategories: ["what"] } },
  { key: "make", tKey: "aac.glyph.make", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "request",
    imagePath: "actions/hands/make", emoji: "🔨", exposeToAi: true,
    composable: { accepts: ["noun", "animal"], suggestCategories: ["what"] } },
  { key: "use", tKey: "aac.glyph.use", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "comment",
    imagePath: "actions/hands/use", emoji: "🛠️", exposeToAi: true,
    composable: { accepts: ["noun"], suggestCategories: ["what"] } },
  { key: "like", tKey: "aac.glyph.like", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "mental"] }, tone: "feeling", emoji: "❤️", exposeToAi: true },
  { key: "see", tKey: "aac.glyph.see", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "sensory"] }, tone: "comment", emoji: "👁️", exposeToAi: true },
  { key: "hear", tKey: "aac.glyph.hear", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "sensory"] }, tone: "comment", emoji: "👂", exposeToAi: true },
  // `go` shares its visual with `walk`: both render the walking-figure
  // bundled icon. The two are semantically distinct (go-to-a-place vs
  // the locomotion itself), and `go` stays exposeToAi so the AI uses
  // the key directly — but visually the same artwork carries both.
  { key: "go", tKey: "aac.glyph.go", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "body"] }, tone: "request", emoji: "🚶", directional: true, exposeToAi: true,
    imagePath: "actions/body/walk" },
  { key: "play", tKey: "aac.glyph.play", pos: "verb", categories: ["do"],
    modeChips: { do: ["common"] }, tone: "request", emoji: "🎮", exposeToAi: true,
    imagePath: "actions/body/play",
    composable: {
      accepts: ["noun", "animal"],
      suggestCategories: ["what"],
      position: "lower-right",
      emptyImagePath: "actions/body/play-empty",
    } },
  { key: "eat", tKey: "aac.glyph.eat", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "body"] }, tone: "request", emoji: "🍽️", exposeToAi: true,
    imagePath: "actions/body/eat",
    composable: {
      accepts: ["noun"],
      suggestCategories: ["what"],
      position: "middle-right",
    } },
  { key: "drink", tKey: "aac.glyph.drink", pos: "verb", categories: ["do"],
    modeChips: { do: ["common"] }, tone: "request", emoji: "🥤", exposeToAi: true },
  { key: "help", tKey: "aac.glyph.help", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "social"] }, tone: "request", emoji: "🆘", exposeToAi: true },
  { key: "say", tKey: "aac.glyph.say", pos: "verb", categories: ["do"],
    modeChips: { do: ["social", "mental"] }, tone: "social", emoji: "💬", exposeToAi: true,
    composable: { accepts: ["noun", "animal", "person", "place", "feeling"],
                  suggestCategories: ["what", "who"], position: "upper" } },
  { key: "talk", tKey: "aac.glyph.talk", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "social"] }, tone: "social", emoji: "🗣️", exposeToAi: true,
    composable: { accepts: ["noun", "animal", "person", "place"],
                  suggestCategories: ["what", "who"], position: "upper" } },
  { key: "tell", tKey: "aac.glyph.tell", pos: "verb", categories: ["do"],
    modeChips: { do: ["social"] }, tone: "social", emoji: "💬", exposeToAi: true },
  { key: "need", tKey: "aac.glyph.need", pos: "verb", categories: ["do"],
    modeChips: { do: ["common"] }, tone: "request", emoji: "🙏", exposeToAi: true,
    composable: { accepts: ["noun", "animal", "person", "place"], suggestCategories: ["what"] } },
  { key: "wait", tKey: "aac.glyph.wait", pos: "verb", categories: ["do"],
    modeChips: { do: ["common"] }, tone: "comment", emoji: "⏳", exposeToAi: true },
  { key: "find", tKey: "aac.glyph.find", pos: "verb", categories: ["do"],
    modeChips: { do: ["mental"] }, tone: "comment", emoji: "🔍", exposeToAi: true },
  { key: "share", tKey: "aac.glyph.share", pos: "verb", categories: ["do"],
    modeChips: { do: ["social"] }, tone: "social", emoji: "🤝", exposeToAi: true },
  { key: "think", tKey: "aac.glyph.think", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "mental"] }, tone: "comment", emoji: "💭", exposeToAi: true,
    composable: { accepts: ["noun", "animal", "person", "place", "feeling"],
                  suggestCategories: ["what", "who"], position: "upper" } },
  { key: "stop", tKey: "aac.glyph.stop", pos: "verb", categories: ["do"],
    modeChips: { do: ["body"] }, tone: "request", emoji: "🛑", exposeToAi: true },
  // walk + run keep exposeToAi off: the AI emits them by emoji (🚶 / 🏃)
  // and the renderer reverse-maps the emoji to this registry entry's
  // imagePath so the bundled artwork shows instead of the raw emoji.
  // The bundled icons are directional, which is the main reason these
  // upgrade from emoji to bundled art — emojis can't flip in RTL.
  { key: "walk", tKey: "aac.glyph.walk", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "body"] }, tone: "comment", emoji: "🚶", directional: true,
    imagePath: "actions/body/walk" },
  { key: "run", tKey: "aac.glyph.run", pos: "verb", categories: ["do"],
    modeChips: { do: ["body"] }, tone: "comment", emoji: "🏃", directional: true,
    imagePath: "actions/body/run" },
  { key: "jump", tKey: "aac.glyph.jump", pos: "verb", categories: ["do"],
    modeChips: { do: ["body"] }, tone: "comment", emoji: "🤸", directional: true },
  { key: "sit", tKey: "aac.glyph.sit", pos: "verb", categories: ["do"],
    modeChips: { do: ["body"] }, tone: "comment", emoji: "🪑", exposeToAi: true,
    imagePath: "actions/body/sit" },
  { key: "build", tKey: "aac.glyph.build", pos: "verb", categories: ["do"],
    modeChips: { do: ["body", "hands"] }, tone: "comment", emoji: "🔨", exposeToAi: true,
    imagePath: "actions/body/build",
    composable: { accepts: ["noun"], suggestCategories: ["what"] } },
  { key: "chase", tKey: "aac.glyph.chase", pos: "verb", categories: ["do"],
    modeChips: { do: ["body"] }, tone: "comment", emoji: "🏃", directional: true, exposeToAi: true,
    imagePath: "actions/body/chase" },
  { key: "stand", tKey: "aac.glyph.stand", pos: "verb", categories: ["do"],
    modeChips: { do: ["body"] }, tone: "comment", emoji: "🧍" },
  { key: "sleep", tKey: "aac.glyph.sleep", pos: "verb", categories: ["do"],
    modeChips: { do: ["body"] }, tone: "comment", emoji: "😴" },
  // emoji weak — alarm-clock conflates "morning" / "alarm" with "wake up".
  { key: "wake_up", tKey: "aac.glyph.wake_up", pos: "verb", categories: ["do"],
    modeChips: { do: ["body"] }, tone: "comment", emoji: "⏰" },
  { key: "read", tKey: "aac.glyph.read", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "mental"] }, tone: "comment", emoji: "📖" },
  { key: "write", tKey: "aac.glyph.write", pos: "verb", categories: ["do"],
    modeChips: { do: ["mental"] }, tone: "comment", emoji: "✍️" },
  { key: "draw", tKey: "aac.glyph.draw", pos: "verb", categories: ["do"],
    modeChips: { do: ["mental"] }, tone: "comment", emoji: "🎨" },
  { key: "sing", tKey: "aac.glyph.sing", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "social"] }, tone: "comment", emoji: "🎤" },
  { key: "dance", tKey: "aac.glyph.dance", pos: "verb", categories: ["do"],
    modeChips: { do: ["body"] }, tone: "comment", emoji: "💃" },
  { key: "swim", tKey: "aac.glyph.swim", pos: "verb", categories: ["do"],
    modeChips: { do: ["body"] }, tone: "comment", emoji: "🏊", directional: true },
  { key: "wash", tKey: "aac.glyph.wash", pos: "verb", categories: ["do"],
    modeChips: { do: ["body"] }, tone: "comment", emoji: "🧼" },
  // emoji weak — no good "wearing" emoji; the shirt emoji is the closest
  // stand-in. Composable so "I wore a shirt" reads as wear(shirt).
  { key: "wear", tKey: "aac.glyph.wear", pos: "verb", categories: ["do"],
    modeChips: { do: ["body"] }, tone: "comment", emoji: "👕", exposeToAi: true,
    composable: { accepts: ["noun"], suggestCategories: ["what"] } },
  { key: "brush_teeth", tKey: "aac.glyph.brush_teeth", pos: "verb", categories: ["do"],
    modeChips: { do: ["body"] }, tone: "comment", emoji: "🪥" },
  // emoji weak — open / close currently use folder emoji (file-manager
  // semantics, not physical doors / containers).
  { key: "open", tKey: "aac.glyph.open", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "comment", emoji: "📂",
    composable: { accepts: ["noun"], suggestCategories: ["what"] } },
  { key: "close", tKey: "aac.glyph.close", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "comment", emoji: "📁",
    composable: { accepts: ["noun"], suggestCategories: ["what"] } },
  // emoji weak — push / pull currently overload pointing-finger emoji.
  { key: "push", tKey: "aac.glyph.push", pos: "verb", categories: ["do"],
    modeChips: { do: ["hands"] }, tone: "comment", emoji: "👉", directional: true },
  { key: "pull", tKey: "aac.glyph.pull", pos: "verb", categories: ["do"],
    modeChips: { do: ["hands"] }, tone: "comment", emoji: "👈", directional: true },
  { key: "throw", tKey: "aac.glyph.throw", pos: "verb", categories: ["do"],
    modeChips: { do: ["hands"] }, tone: "comment", emoji: "🤾", directional: true },
  { key: "hug", tKey: "aac.glyph.hug", pos: "verb", categories: ["do"],
    modeChips: { do: ["social"] }, tone: "social", emoji: "🤗" },
  { key: "laugh", tKey: "aac.glyph.laugh", pos: "verb", categories: ["do"],
    modeChips: { do: ["social"] }, tone: "feeling", emoji: "😂" },
  { key: "cry", tKey: "aac.glyph.cry", pos: "verb", categories: ["do"],
    modeChips: { do: ["social"] }, tone: "feeling", emoji: "😢" },
  // emoji weak — graduation-cap reads "graduate" more than "learn".
  { key: "learn", tKey: "aac.glyph.learn", pos: "verb", categories: ["do"],
    modeChips: { do: ["mental"] }, tone: "comment", emoji: "🎓", exposeToAi: true },
  // emoji weak — raised-hand reads "volunteer" more than "ask".
  { key: "ask", tKey: "aac.glyph.ask", pos: "verb", categories: ["do"],
    modeChips: { do: ["social", "mental"] }, tone: "question", emoji: "🙋", exposeToAi: true },

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

  // ── Clothing ─────────────────────────────────────────────────────────────
  { key: "hat", tKey: "aac.glyph.hat", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "clothes"] }, tone: "comment", emoji: "🎩" },
  { key: "pants", tKey: "aac.glyph.pants", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "clothes"] }, tone: "comment", emoji: "👖" },
  { key: "socks", tKey: "aac.glyph.socks", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "clothes"] }, tone: "comment", emoji: "🧦" },
  { key: "jacket", tKey: "aac.glyph.jacket", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "clothes"] }, tone: "comment", emoji: "🧥" },
  { key: "dress", tKey: "aac.glyph.dress", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "clothes"] }, tone: "comment", emoji: "👗" },

  // ── Food ─────────────────────────────────────────────────────────────────
  { key: "apple", tKey: "aac.glyph.apple", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🍎" },
  { key: "banana", tKey: "aac.glyph.banana", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🍌" },
  { key: "bread", tKey: "aac.glyph.bread", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🍞" },
  { key: "cookie", tKey: "aac.glyph.cookie", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🍪" },
  { key: "cake", tKey: "aac.glyph.cake", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🎂" },
  { key: "pizza", tKey: "aac.glyph.pizza", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🍕" },
  { key: "rice", tKey: "aac.glyph.rice", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🍚" },
  { key: "egg", tKey: "aac.glyph.egg", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🥚" },
  { key: "cheese", tKey: "aac.glyph.cheese", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🧀" },
  // emoji weak — grapes emoji stands in for the generic "fruit" concept.
  { key: "fruit", tKey: "aac.glyph.fruit", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🍇" },
  { key: "vegetable", tKey: "aac.glyph.vegetable", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🥦" },
  { key: "ice_cream", tKey: "aac.glyph.ice_cream", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🍦" },
  { key: "sandwich", tKey: "aac.glyph.sandwich", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🥪" },
  { key: "candy", tKey: "aac.glyph.candy", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🍬" },
  { key: "chocolate", tKey: "aac.glyph.chocolate", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🍫" },
  { key: "soup", tKey: "aac.glyph.soup", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🍲" },
  { key: "carrot", tKey: "aac.glyph.carrot", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🥕" },
  { key: "corn", tKey: "aac.glyph.corn", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🌽" },
  { key: "strawberry", tKey: "aac.glyph.strawberry", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🍓" },
  { key: "meat", tKey: "aac.glyph.meat", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "food"] }, tone: "comment", emoji: "🥩" },

  // ── Drink ────────────────────────────────────────────────────────────────
  { key: "milk", tKey: "aac.glyph.milk", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "drink"] }, tone: "comment", emoji: "🥛" },
  { key: "juice", tKey: "aac.glyph.juice", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "drink"] }, tone: "comment", emoji: "🧃" },
  { key: "tea", tKey: "aac.glyph.tea", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "drink"] }, tone: "comment", emoji: "🍵" },
  { key: "soda", tKey: "aac.glyph.soda", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "drink"] }, tone: "comment", emoji: "🥤" },

  // ── Toys ─────────────────────────────────────────────────────────────────
  { key: "toy", tKey: "aac.glyph.toy", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "toys"] }, tone: "comment", emoji: "🧸" },
  { key: "doll", tKey: "aac.glyph.doll", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "toys"] }, tone: "comment", emoji: "🪆" },
  { key: "puzzle", tKey: "aac.glyph.puzzle", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "toys"] }, tone: "comment", emoji: "🧩" },
  { key: "crayon", tKey: "aac.glyph.crayon", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "toys"] }, tone: "comment", emoji: "🖍️" },
  { key: "balloon", tKey: "aac.glyph.balloon", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "toys"] }, tone: "comment", emoji: "🎈" },
  { key: "present", tKey: "aac.glyph.present", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "toys"] }, tone: "comment", emoji: "🎁" },
  { key: "game", tKey: "aac.glyph.game", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "toys"] }, tone: "comment", emoji: "🎮" },
  { key: "music", tKey: "aac.glyph.music", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "toys", "ideas"] }, tone: "comment", emoji: "🎵" },

  // ── Things ───────────────────────────────────────────────────────────────
  { key: "cup", tKey: "aac.glyph.cup", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🥤" },
  { key: "plate", tKey: "aac.glyph.plate", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🍽️" },
  { key: "fork", tKey: "aac.glyph.fork", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🍴" },
  { key: "spoon", tKey: "aac.glyph.spoon", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🥄" },
  { key: "soap", tKey: "aac.glyph.soap", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🧼" },
  // emoji weak — toilet-paper roll emoji approximates "towel".
  { key: "towel", tKey: "aac.glyph.towel", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🧻" },
  // emoji weak — bed emoji approximates "blanket".
  { key: "blanket", tKey: "aac.glyph.blanket", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🛏️" },
  { key: "key", tKey: "aac.glyph.key", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🔑" },
  { key: "paper", tKey: "aac.glyph.paper", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "📄" },
  { key: "pencil", tKey: "aac.glyph.pencil", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "✏️" },
  { key: "glasses", tKey: "aac.glyph.glasses", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "👓" },
  { key: "backpack", tKey: "aac.glyph.backpack", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🎒" },
  { key: "clock", tKey: "aac.glyph.clock", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🕒" },
  { key: "money", tKey: "aac.glyph.money", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "💰" },
  { key: "medicine", tKey: "aac.glyph.medicine", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "💊" },
  { key: "flower", tKey: "aac.glyph.flower", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🌸" },
  { key: "camera", tKey: "aac.glyph.camera", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "📷" },
  { key: "computer", tKey: "aac.glyph.computer", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "💻" },
  { key: "tv", tKey: "aac.glyph.tv", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "📺" },

  // ── Body parts ───────────────────────────────────────────────────────────
  // emoji weak — bust silhouette is the closest emoji for "head".
  { key: "head", tKey: "aac.glyph.head", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "body_parts"] }, tone: "comment", emoji: "👤" },
  { key: "hand", tKey: "aac.glyph.hand", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "body_parts"] }, tone: "comment", emoji: "✋" },
  { key: "foot", tKey: "aac.glyph.foot", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "body_parts"] }, tone: "comment", emoji: "🦶" },
  { key: "eye", tKey: "aac.glyph.eye", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "body_parts"] }, tone: "comment", emoji: "👁️" },
  { key: "ear", tKey: "aac.glyph.ear", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "body_parts"] }, tone: "comment", emoji: "👂" },
  { key: "nose", tKey: "aac.glyph.nose", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "body_parts"] }, tone: "comment", emoji: "👃" },
  { key: "mouth", tKey: "aac.glyph.mouth", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "body_parts"] }, tone: "comment", emoji: "👄" },
  { key: "teeth", tKey: "aac.glyph.teeth", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "body_parts"] }, tone: "comment", emoji: "🦷" },
  // emoji weak — hairdresser silhouette stands in for "hair".
  { key: "hair", tKey: "aac.glyph.hair", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "body_parts"] }, tone: "comment", emoji: "💇" },
  { key: "arm", tKey: "aac.glyph.arm", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "body_parts"] }, tone: "comment", emoji: "💪" },
  { key: "leg", tKey: "aac.glyph.leg", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "body_parts"] }, tone: "comment", emoji: "🦵" },

  // ── Vehicles (WHAT + vehicles chip) ──────────────────────────────────────
  { key: "car", tKey: "aac.glyph.car", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "vehicles"] }, tone: "comment", emoji: "🚗" },
  { key: "bus", tKey: "aac.glyph.bus", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "vehicles"] }, tone: "comment", emoji: "🚌" },
  { key: "train", tKey: "aac.glyph.train", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "vehicles"] }, tone: "comment", emoji: "🚆" },
  { key: "plane", tKey: "aac.glyph.plane", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "vehicles"] }, tone: "comment", emoji: "✈️" },
  { key: "bike", tKey: "aac.glyph.bike", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "vehicles"] }, tone: "comment", emoji: "🚲" },
  { key: "boat", tKey: "aac.glyph.boat", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "vehicles"] }, tone: "comment", emoji: "⛵" },

  // ── Nature (WHAT + nature chip) ──────────────────────────────────────────
  { key: "sun", tKey: "aac.glyph.sun", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "nature"] }, tone: "comment", emoji: "☀️" },
  { key: "moon", tKey: "aac.glyph.moon", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "nature"] }, tone: "comment", emoji: "🌙" },
  { key: "star", tKey: "aac.glyph.star", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "nature"] }, tone: "comment", emoji: "⭐" },
  { key: "tree", tKey: "aac.glyph.tree", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "nature"] }, tone: "comment", emoji: "🌳" },
  { key: "cloud", tKey: "aac.glyph.cloud", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "nature"] }, tone: "comment", emoji: "☁️" },
  { key: "rain", tKey: "aac.glyph.rain", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "nature"] }, tone: "comment", emoji: "🌧️" },
  { key: "snow", tKey: "aac.glyph.snow", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "nature"] }, tone: "comment", emoji: "❄️" },
  { key: "rainbow", tKey: "aac.glyph.rainbow", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "nature"] }, tone: "comment", emoji: "🌈" },
  { key: "fire", tKey: "aac.glyph.fire", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "nature"] }, tone: "comment", emoji: "🔥" },

  // ── Feelings (WHAT + feelings chip) ──────────────────────────────────────
  // Feelings carry an emotional tone family so the button background tints
  // pink even when the slot key isn't a verb. The shared `tired` modifier
  // path still works — these are the standalone-noun versions.
  { key: "happy", tKey: "aac.glyph.happy", pos: "feeling", categories: ["what"],
    modeChips: { what: ["all", "feelings"] }, tone: "feeling", emoji: "😊" },
  { key: "sad", tKey: "aac.glyph.sad", pos: "feeling", categories: ["what"],
    modeChips: { what: ["all", "feelings"] }, tone: "feeling", emoji: "😢" },
  { key: "angry", tKey: "aac.glyph.angry", pos: "feeling", categories: ["what"],
    modeChips: { what: ["all", "feelings"] }, tone: "feeling", emoji: "😠" },
  { key: "scared", tKey: "aac.glyph.scared", pos: "feeling", categories: ["what"],
    modeChips: { what: ["all", "feelings"] }, tone: "feeling", emoji: "😨" },
  { key: "excited", tKey: "aac.glyph.excited", pos: "feeling", categories: ["what"],
    modeChips: { what: ["all", "feelings"] }, tone: "feeling", emoji: "🤩" },
  { key: "bored", tKey: "aac.glyph.bored", pos: "feeling", categories: ["what"],
    modeChips: { what: ["all", "feelings"] }, tone: "feeling", emoji: "😑" },
  { key: "hungry", tKey: "aac.glyph.hungry", pos: "feeling", categories: ["what"],
    modeChips: { what: ["all", "feelings"] }, tone: "feeling", emoji: "🤤" },
  // emoji weak — droplet emoji overlaps with `water`.
  { key: "thirsty", tKey: "aac.glyph.thirsty", pos: "feeling", categories: ["what"],
    modeChips: { what: ["all", "feelings"] }, tone: "feeling", emoji: "💧" },
  { key: "sick", tKey: "aac.glyph.sick", pos: "feeling", categories: ["what"],
    modeChips: { what: ["all", "feelings"] }, tone: "feeling", emoji: "🤒" },
  { key: "hurt", tKey: "aac.glyph.hurt", pos: "feeling", categories: ["what"],
    modeChips: { what: ["all", "feelings"] }, tone: "feeling", emoji: "🤕" },
  { key: "tired", tKey: "aac.glyph.tired", pos: "feeling", categories: ["what"],
    modeChips: { what: ["all", "feelings"] }, tone: "feeling", emoji: "😴" },
  { key: "surprised", tKey: "aac.glyph.surprised", pos: "feeling", categories: ["what"],
    modeChips: { what: ["all", "feelings"] }, tone: "feeling", emoji: "😲" },
  { key: "proud", tKey: "aac.glyph.proud", pos: "feeling", categories: ["what"],
    modeChips: { what: ["all", "feelings"] }, tone: "feeling", emoji: "😎" },
  { key: "calm", tKey: "aac.glyph.calm", pos: "feeling", categories: ["what"],
    modeChips: { what: ["all", "feelings"] }, tone: "feeling", emoji: "😌" },

  // ── Social primitives (WHAT + social chip) ───────────────────────────────
  // These are universal communication acts students reach for constantly.
  // Without them in the registry, the AI hallucinates snake_case (`yes`,
  // `hello`, `thank_you`) that ends up queued for image generation and
  // renders as ❓ until the symbol arrives.
  { key: "yes", tKey: "aac.glyph.yes", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "social"] }, tone: "social", emoji: "✅" },
  { key: "no", tKey: "aac.glyph.no", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "social"] }, tone: "social", emoji: "❌" },
  { key: "maybe", tKey: "aac.glyph.maybe", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "social"] }, tone: "social", emoji: "🤷" },
  { key: "hello", tKey: "aac.glyph.hello", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "social"] }, tone: "social", emoji: "👋" },
  { key: "goodbye", tKey: "aac.glyph.goodbye", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "social"] }, tone: "social", emoji: "👋" },
  { key: "thank_you", tKey: "aac.glyph.thank_you", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "social"] }, tone: "social", emoji: "🙏" },
  { key: "sorry", tKey: "aac.glyph.sorry", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "social"] }, tone: "social", emoji: "😔" },

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
    modeChips: { where: ["spatial"] }, tone: "comment", emoji: "📍", exposeToAi: true },
  { key: "there", tKey: "aac.glyph.there", pos: "place", categories: ["where"],
    modeChips: { where: ["spatial"] }, tone: "comment", emoji: "🎯", exposeToAi: true },
  { key: "store", tKey: "aac.glyph.store", pos: "place", categories: ["where"],
    modeChips: { where: ["places"] }, tone: "comment", emoji: "🏬" },
  { key: "library", tKey: "aac.glyph.library", pos: "place", categories: ["where"],
    modeChips: { where: ["places"] }, tone: "comment", emoji: "📚" },
  { key: "hospital", tKey: "aac.glyph.hospital", pos: "place", categories: ["where"],
    modeChips: { where: ["places"] }, tone: "comment", emoji: "🏥" },
  { key: "beach", tKey: "aac.glyph.beach", pos: "place", categories: ["where"],
    modeChips: { where: ["places"] }, tone: "comment", emoji: "🏖️" },
  { key: "playground", tKey: "aac.glyph.playground", pos: "place", categories: ["where"],
    modeChips: { where: ["places"] }, tone: "comment", emoji: "🛝" },
  { key: "forest", tKey: "aac.glyph.forest", pos: "place", categories: ["where"],
    modeChips: { where: ["places"] }, tone: "comment", emoji: "🌲" },
  { key: "city", tKey: "aac.glyph.city", pos: "place", categories: ["where"],
    modeChips: { where: ["places"] }, tone: "comment", emoji: "🏙️" },

  // ── Indicators (deictic pointers — cross-listed under WHO and WHAT) ──────
  { key: "that", tKey: "aac.glyph.that", pos: "noun", categories: ["who", "what"],
    modeChips: { who: ["all"], what: ["all", "things"] }, tone: "comment",
    imagePath: "indicators/that", emoji: "👉", directional: true, exposeToAi: true },

  // ── WHEN ─────────────────────────────────────────────────────────────────
  { key: "now", tKey: "aac.glyph.now", pos: "time", categories: ["when"],
    modeChips: { when: ["quick"] }, tone: "comment", emoji: "⏱️", exposeToAi: true },
  { key: "today", tKey: "aac.glyph.today", pos: "time", categories: ["when"],
    modeChips: { when: ["quick", "days"] }, tone: "comment", emoji: "📅", exposeToAi: true },
  { key: "tomorrow", tKey: "aac.glyph.tomorrow", pos: "time", categories: ["when"],
    modeChips: { when: ["quick", "days"] }, tone: "comment", emoji: "➡️", directional: true, exposeToAi: true },
  { key: "yesterday", tKey: "aac.glyph.yesterday", pos: "time", categories: ["when"],
    modeChips: { when: ["quick", "days"] }, tone: "comment", emoji: "⬅️", directional: true, exposeToAi: true },
  { key: "soon", tKey: "aac.glyph.soon", pos: "time", categories: ["when"],
    modeChips: { when: ["quick"] }, tone: "comment", emoji: "⏳", exposeToAi: true },
  { key: "later", tKey: "aac.glyph.later", pos: "time", categories: ["when"],
    modeChips: { when: ["quick"] }, tone: "comment", emoji: "🕓", exposeToAi: true },
  { key: "morning", tKey: "aac.glyph.morning", pos: "time", categories: ["when"],
    modeChips: { when: ["time-of-day"] }, tone: "comment", emoji: "🌅", exposeToAi: true },
  { key: "night", tKey: "aac.glyph.night", pos: "time", categories: ["when"],
    modeChips: { when: ["time-of-day"] }, tone: "comment", emoji: "🌙", exposeToAi: true },
  { key: "day", tKey: "aac.glyph.day", pos: "time", categories: ["when"],
    modeChips: { when: ["quick"] }, tone: "comment", emoji: "📆", exposeToAi: true },
  // emoji weak — sun-with-face stands in for "afternoon"; same emoji as `sun`.
  { key: "afternoon", tKey: "aac.glyph.afternoon", pos: "time", categories: ["when"],
    modeChips: { when: ["time-of-day"] }, tone: "comment", emoji: "🌞", exposeToAi: true },
  // emoji weak — cityscape-at-dusk stands in for the general "evening" concept.
  { key: "evening", tKey: "aac.glyph.evening", pos: "time", categories: ["when"],
    modeChips: { when: ["time-of-day"] }, tone: "comment", emoji: "🌆", exposeToAi: true },
  { key: "week", tKey: "aac.glyph.week", pos: "time", categories: ["when"],
    modeChips: { when: ["days"] }, tone: "comment", emoji: "🗓️", exposeToAi: true },
  { key: "weekend", tKey: "aac.glyph.weekend", pos: "time", categories: ["when"],
    modeChips: { when: ["days"] }, tone: "comment", emoji: "🎉", exposeToAi: true },
  { key: "always", tKey: "aac.glyph.always", pos: "time", categories: ["when"],
    modeChips: { when: ["frequency"] }, tone: "comment", emoji: "♾️", exposeToAi: true },
  { key: "never", tKey: "aac.glyph.never", pos: "time", categories: ["when"],
    modeChips: { when: ["frequency"] }, tone: "comment", emoji: "🚫", exposeToAi: true },
  { key: "sometimes", tKey: "aac.glyph.sometimes", pos: "time", categories: ["when"],
    modeChips: { when: ["frequency"] }, tone: "comment", emoji: "🔀", exposeToAi: true },

  // ── Modifiers (also appear as vocabulary items in their relevant tabs) ───
  // Quantity dots
  { key: "one", tKey: "aac.glyph.one", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "1️⃣", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "dots", order: 30 } },
  { key: "two", tKey: "aac.glyph.two", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "2️⃣", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "dots", order: 31 } },
  { key: "many", tKey: "aac.glyph.many", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🔢", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "dots", order: 32 } },

  // Possession — reuse the inward-/outward-hand artwork from the take/give
  // verbs so the directional meaning carries through. `my` (toward speaker)
  // anchors top-left; `your` (toward addressee) anchors bottom-left. RTL
  // mirrors the corner side and the image itself.
  { key: "my", tKey: "aac.glyph.my", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment",
    imagePath: "actions/hands/take", emoji: "🫳", directional: true, exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person", "place"], transform: "hands", order: 1, corner: "top-left" } },
  { key: "your", tKey: "aac.glyph.your", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment",
    imagePath: "actions/hands/give", emoji: "🫴", directional: true, exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person", "place"], transform: "hands", order: 2, corner: "bottom-left" } },

  // Negation
  { key: "not", tKey: "aac.glyph.not", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "❌", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person", "place", "verb", "feeling"],
                transform: "red_x", order: 0 } },

  // Intensity (also dimension values for "intensity")
  { key: "very", tKey: "aac.glyph.very", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "✨", exposeToAi: true,
    modifier: { appliesTo: ["verb", "feeling", "modifier"], transform: "glow", order: 3 },
    dimensionValue: { dimension: "intensity", value: "very" } },
  { key: "little", tKey: "aac.glyph.little", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🤏", exposeToAi: true,
    modifier: { appliesTo: ["verb", "feeling", "modifier"], transform: "shrink", order: 4 },
    dimensionValue: { dimension: "intensity", value: "little" } },

  // Dimension adjectives — vocabulary in WHAT, modifier on nouns. When
  // applied as a modifier the compositor draws arrow decorations around
  // the slot AND warps the host image to match the adjective. Bundled
  // icons under attached_assets/aac-icons/adjectives/dimension/ render
  // when the key is staged as a standalone slot. See DimensionPattern.
  { key: "big", tKey: "aac.glyph.big", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment",
    imagePath: "adjectives/dimension/big", emoji: "📏", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal"], transform: "dimension", order: 5, dimension: "big" },
    dimensionValue: { dimension: "size", value: "big" } },
  { key: "small", tKey: "aac.glyph.small", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment",
    imagePath: "adjectives/dimension/small", emoji: "🐭", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal"], transform: "dimension", order: 6, dimension: "small" },
    dimensionValue: { dimension: "size", value: "small" } },
  { key: "length_long", tKey: "aac.glyph.length_long", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment",
    imagePath: "adjectives/dimension/long", emoji: "↔️", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal"], transform: "dimension", order: 7, dimension: "length_long" } },
  { key: "length_short", tKey: "aac.glyph.length_short", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment",
    imagePath: "adjectives/dimension/short", emoji: "🩳", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal"], transform: "dimension", order: 8, dimension: "length_short" } },
  { key: "tall_high", tKey: "aac.glyph.tall_high", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment",
    imagePath: "adjectives/dimension/tall_high", emoji: "⬆️", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "dimension", order: 9, dimension: "tall_high" } },
  { key: "short_low", tKey: "aac.glyph.short_low", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment",
    imagePath: "adjectives/dimension/short_low", emoji: "⬇️", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "dimension", order: 10, dimension: "short_low" } },
  { key: "wide", tKey: "aac.glyph.wide", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment",
    imagePath: "adjectives/dimension/wide", emoji: "↔️", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal"], transform: "dimension", order: 11, dimension: "wide" } },
  { key: "thin", tKey: "aac.glyph.thin", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment",
    imagePath: "adjectives/dimension/thin", emoji: "📏", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal"], transform: "dimension", order: 12, dimension: "thin" } },

  // Temperature
  { key: "hot", tKey: "aac.glyph.hot", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment", emoji: "🔥", exposeToAi: true,
    modifier: { appliesTo: ["noun"], transform: "halo_warm", order: 20 } },
  { key: "cold", tKey: "aac.glyph.cold", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment", emoji: "❄️", exposeToAi: true,
    modifier: { appliesTo: ["noun"], transform: "halo_cool", order: 21 } },

  // ── Color modifiers ────────────────────────────────────────────────────
  // The compositor renders a colored frame around the slot rim when one of
  // these is applied. They're hidden from the modifier carousel — the
  // construction board exposes them via a dedicated color-picker popup —
  // but the AI may emit any of these keys directly. Standalone (used as
  // a slot rather than a modifier) they appear as a colored square emoji.
  { key: "color_red", tKey: "aac.glyph.color_red", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟥",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 50, colorValue: "#DC2626", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_orange", tKey: "aac.glyph.color_orange", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟧",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 51, colorValue: "#EA580C", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_yellow", tKey: "aac.glyph.color_yellow", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟨",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 52, colorValue: "#FACC15", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_green", tKey: "aac.glyph.color_green", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟩",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 53, colorValue: "#16A34A", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_blue", tKey: "aac.glyph.color_blue", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟦",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 54, colorValue: "#2563EB", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_purple", tKey: "aac.glyph.color_purple", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟪",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 55, colorValue: "#9333EA", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_pink", tKey: "aac.glyph.color_pink", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🩷",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 56, colorValue: "#EC4899", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_brown", tKey: "aac.glyph.color_brown", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟫",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 57, colorValue: "#92400E", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_black", tKey: "aac.glyph.color_black", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "⬛",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 58, colorValue: "#111827", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_white", tKey: "aac.glyph.color_white", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "⬜",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 59, colorValue: "#F3F4F6", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_gray", tKey: "aac.glyph.color_gray", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "◻️",
    modifier: { appliesTo: ["noun", "animal"], transform: "color", order: 60, colorValue: "#6B7280", hiddenFromCarousel: true }, exposeToAi: true },

  // Social
  { key: "please", tKey: "aac.glyph.please", pos: "modifier", categories: ["do"],
    modeChips: { do: ["social"] }, tone: "social", emoji: "🙏", exposeToAi: true,
    modifier: { appliesTo: ["verb"], transform: "badge", order: 1 } },
  { key: "again", tKey: "aac.glyph.again", pos: "modifier", categories: ["do"],
    modeChips: { do: ["relation"] }, tone: "comment", emoji: "🔁", exposeToAi: true,
    modifier: { appliesTo: ["verb"], transform: "badge", order: 2 } },
  { key: "more", tKey: "aac.glyph.more", pos: "modifier", categories: ["do"],
    modeChips: { do: ["relation"] }, tone: "request", emoji: "➕", exposeToAi: true,
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

/**
 * Reverse lookup: emoji → registry item. Limited to items the AI
 * doesn't know by KEY (`exposeToAi !== true`) — those are the ones it
 * emits using their raw emoji (🚶 / 🏃) rather than the snake_case
 * registry name. The renderer queries this map when a slot's key is a
 * bare emoji, so a `🚶` slot resolves to `walk`'s bundled artwork
 * (which can flip in RTL) instead of falling through to the plain
 * emoji glyph (which can't). Items the AI uses by key (`i_me`, `that`,
 * `want`…) stay out of this map so their canonical emoji doesn't
 * shadow the intended `key`-driven path.
 */
const BY_EMOJI_NONEXPOSED: ReadonlyMap<string, VocabularyItem> = (() => {
  const out = new Map<string, VocabularyItem>();
  for (const v of VOCAB) {
    if (!v.emoji) continue;
    if (!v.imagePath) continue;
    if (v.exposeToAi) continue;
    // First occurrence wins. There shouldn't be intentional collisions
    // among non-exposed items, but if one ever appears the registry
    // ordering decides.
    if (!out.has(v.emoji)) out.set(v.emoji, v);
  }
  return out;
})();

export function getVocabularyItem(key: string): VocabularyItem | undefined {
  return BY_KEY.get(key);
}

/**
 * Reverse-lookup a registry item by its canonical emoji, restricted to
 * the non-exposed subset (see BY_EMOJI_NONEXPOSED). Returns undefined
 * for any emoji that doesn't have a bundled-art entry the renderer
 * should swap to. Pure read — no allocation per call.
 */
export function getVocabularyItemByEmoji(emoji: string): VocabularyItem | undefined {
  return BY_EMOJI_NONEXPOSED.get(emoji);
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
  what: ["all", "food", "drink", "toys", "clothes", "things", "body_parts", "vehicles", "nature", "feelings", "social", "places", "people", "ideas"],
  where: ["places", "rooms", "spatial"],
  when: ["quick", "days", "time-of-day", "clock", "routine", "frequency"],
};

/** Default mode chip per category — first in the list. */
export function defaultModeChip(category: GlyphCategory): string {
  return MODE_CHIPS[category][0];
}
