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

export type GlyphCategory = "who" | "do" | "what" | "where" | "when" | "chat";

/** Coarse part-of-speech used to decide modifier applicability. */
export type GlyphPos =
  | "person"
  | "animal"
  | "noun"
  | "verb"
  | "place"
  | "time"
  | "feeling"
  | "modifier"
  | "connector";  // forward-binding join between two GLYPHs (and/or/but/if/because) — recognized positionally in `+` slots, see CONNECTORS in glyph-compositor.ts

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
  | "dimension"    // arrow decorations + image warp (big/small/long/short/tall/wide/thin)
  | "color"        // colored frame around slot rim — color name lives in modifier.colorValue
  | "emotion"      // emotion face badge in a corner — rendered like "badge" (uses the modifier's emoji)
  | "relational"   // directional arrow(s) beneath the symbol (next/prev/this) — details in modifier.relation
  | "gender_body"  // swap host art to a `-male`/`-female`/`-plural` body variant (he/she/they); falls back to a gendered emoji until the variant art exists
  | "gauge"        // fill-level meter beneath the symbol for the amount scale (none/some/half/most/all) — level in modifier.gauge
  | "polarity";    // opposite-pole mark on the host (✓ positive / ✗ negative) — pole in modifier.polarity; pairs link via modifier.pairKey

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
   * Required when `transform === "gauge"` — fill level 0..1 the compositor
   * draws as a meter beneath the host symbol. The amount scale:
   * none=0, some≈0.33, half=0.5, most≈0.8, all=1. Distinct from `dots`
   * (exact counts) and `not` (the red_x negation).
   */
  gauge?: number;
  /**
   * Required when `transform === "polarity"` — which pole this is. The
   * compositor draws a green ✓ (pos) or red ✗ (neg) corner mark on the host.
   * (The `mark` axis of the opposite-pair design; flip/overlay axes will
   * extend this once custom art exists.)
   */
  polarity?: "pos" | "neg";
  /**
   * Opposite-pole key for an adjective pair (good↔bad, right↔wrong). Drives
   * the SENTENCE BUILDER's pole-toggle and groups the pair under "quality"
   * in <bundled_icons>. Independent of `transform` — emoji-badge pairs
   * (good/bad) and polarity-mark pairs (right/wrong) both set it.
   */
  pairKey?: string;
  /**
   * Required when `transform === "relational"`. Drives BOTH the directional
   * arrow(s) the compositor draws beneath the symbol AND the stack/cancel
   * logic in `applyRelationalModifier`.
   *
   * Modifiers sharing an `axis` interact on a slot:
   *   - opposite `step` signs cancel one-for-one (next vs prev),
   *   - same sign stacks up to `maxStack` (default 4) — rendered as that many
   *     arrows and serialized as `.next.next`,
   *   - a `step: 0` member ("this"/current) is the neutral point: it's
   *     mutually exclusive with the directional members on its axis.
   * This is the generic core — new sequence/relation concepts (e.g. a
   * "bigger/smaller" comparative axis) can reuse it by declaring their own
   * `axis` string.
   */
  relation?: {
    /** Arrow drawn beneath the symbol when this acts as a modifier. */
    arrow: "forward" | "backward" | "up";
    /** Modifiers on the same axis interact (cancel / stack / exclude). */
    axis: string;
    /** Net step along the axis: +1 advances, -1 retreats, 0 is neutral/current. */
    step: 1 | -1 | 0;
    /** Max repeats in one direction on a slot. Defaults to 4. */
    maxStack?: number;
  };
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
  /**
   * Optional alternate `imagePath` used when the host DOES carry a payload —
   * the mirror of `emptyImagePath`, and NOT gated behind `showEmptyHostSlot`.
   *
   * This is the CONTAINER FRAME case (`building`, `room`): the bare symbol is
   * a complete little icon of its own, but once something is nested inside it
   * the art has to become a frame that carves out room for the payload. So
   * `building` renders `places/building` alone and `places/building-bg` in
   * `building(farm)`. Distinct from `emptyImagePath`, which exists purely as
   * the sentence builder's "drop something here" construction affordance and
   * is therefore hidden everywhere else.
   */
  filledImagePath?: string;
}

/**
 * Animated-sprite facet — declares that a SYMBOL has a hover-animated visual
 * sourced from a spritesheet. The compositor renders these via a
 * <foreignObject> wrapping an AnimatedSymbol component so the animation
 * driver can live in regular React state without leaving SVG land.
 *
 * The registry stores only metadata (sheet id + frame layout); the client
 * maps `sheet` to an actual asset URL so server code can import this file
 * without resolving Vite/Webpack asset bundles.
 */
export interface AnimatedSpriteFacet {
  /**
   * Client-side asset bundle id. The AnimatedSymbol component maps this to
   * an imported asset URL (e.g. `"yes-no-sprites"` → the bundled PNG).
   */
  sheet: string;
  /** Total columns × rows in the spritesheet. */
  cols: number;
  rows: number;
  /** Which row of the sheet this item's frames live on (0-indexed). */
  row: number;
  /**
   * Frame indices (column positions on `row`) to cycle through when the
   * SENTENCE BUTTON is hovered or dwelled on. Index 0 is the resting frame
   * shown when not animating.
   */
  frames: number[];
  /** ms per frame. Defaults to 130 when unset. */
  frameDuration?: number;
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
   * Alias expansion. When set, this item is shorthand for a single composed
   * slot: the sentence builder and the parser normalize it to this
   * `head[.mod[.mod]]` fragment, so the alias and its long form converge
   * (e.g. `tomorrow` → "day.next", `yesterday` → "day.prev"). The expanded
   * form is what serializes and renders. Must be a SINGLE slot fragment —
   * no `+` and no `(payload)`.
   */
  expandsTo?: string;
  /**
   * When present, the compositor renders the SYMBOL as a hover-animated
   * sprite instead of a static image. Takes precedence over `imagePath`
   * in surfaces that support animation (the GlyphCompositor); other
   * surfaces (modifier carousel, plain icon previews) fall back to
   * `imagePath` or `emoji`.
   */
  animatedSprite?: AnimatedSpriteFacet;
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
  // Generic "person" base — also the question-word base: `person#question` = "who".
  // `gender_body` appends `-male`/`-female` to this imagePath (he/she); `plural`
  // has no art and falls back to the 👥 gendered emoji.
  { key: "person", tKey: "aac.glyph.person", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "comment",
    imagePath: "people/person", emoji: "🧑", exposeToAi: true },
  // someone — the indefinite person; also the standalone default head for `who`
  // ("who" = someone.who, a `?` on the someone glyph).
  { key: "someone", tKey: "aac.glyph.someone", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "comment",
    imagePath: "people/someone", emoji: "🧑", exposeToAi: true },
  // Pronouns via the gender modifier: he = person.male, she = person.female,
  // it = thing. `they` (above) is the plural. Accepted aliases that normalize
  // to the composed form (like today → day.this).
  { key: "he", tKey: "aac.glyph.he", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "comment", emoji: "👨", exposeToAi: true,
    expandsTo: "person.male" },
  { key: "she", tKey: "aac.glyph.she", pos: "person", categories: ["who"],
    modeChips: { who: ["all", "people"] }, tone: "comment", emoji: "👩", exposeToAi: true,
    expandsTo: "person.female" },
  { key: "it", tKey: "aac.glyph.it", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "📦", exposeToAi: true,
    expandsTo: "thing" },
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
  // PUT — the placement directive (construction v1: "put + chair + near +
  // table"). The parser already knew the verb; this button makes it
  // composable on the board.
  { key: "put", tKey: "aac.glyph.put", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "request",
    emoji: "⤵️", directional: true, exposeToAi: true,
    composable: { accepts: ["noun"], suggestCategories: ["what", "where"] } },
  // emoji = two crossing arrows (give one way, take the other).
  { key: "trade", tKey: "aac.glyph.trade", pos: "verb", categories: ["do"],
    modeChips: { do: ["social", "hands"] }, tone: "request", emoji: "🔀", exposeToAi: true,
    composable: { accepts: ["noun", "animal"], suggestCategories: ["what"] } },
  { key: "receive", tKey: "aac.glyph.receive", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "comment",
    imagePath: "actions/hands/receive", emoji: "🙌", exposeToAi: true,
    composable: { accepts: ["noun", "animal"], suggestCategories: ["what"] } },
  { key: "have", tKey: "aac.glyph.have", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "comment",
    imagePath: "actions/hands/hold", emoji: "✊", exposeToAi: true,
    composable: { accepts: ["noun", "animal"], suggestCategories: ["what"] } },
  // PHYSICAL CARRYING (actions/body) — distinct from `get`/`take` (which is
  // about acquiring POSSESSION, the opposite of `give`). These are about
  // handling: lift it into your hands, hold-and-move it, set it down.
  { key: "pick_up", tKey: "aac.glyph.pick_up", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "body"] }, tone: "request",
    imagePath: "actions/body/pick_up", emoji: "🤏", exposeToAi: true,
    composable: { accepts: ["noun", "animal"], suggestCategories: ["what"] } },
  { key: "carry", tKey: "aac.glyph.carry", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "body"] }, tone: "request",
    imagePath: "actions/body/carry", emoji: "📦", exposeToAi: true,
    composable: { accepts: ["noun", "animal"], suggestCategories: ["what", "where"] } },
  { key: "drop", tKey: "aac.glyph.drop", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "body"] }, tone: "request",
    imagePath: "actions/body/drop", emoji: "🫳", exposeToAi: true,
    composable: { accepts: ["noun"], suggestCategories: ["what", "where"] } },
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
      emptyImagePath: "actions/body/eat-empty",
    } },
  { key: "drink", tKey: "aac.glyph.drink", pos: "verb", categories: ["do"],
    modeChips: { do: ["common"] }, tone: "request", emoji: "🥤", exposeToAi: true },
  { key: "help", tKey: "aac.glyph.help", pos: "verb", categories: ["do", "chat"],
    modeChips: { do: ["common", "social"], chat: ["all", "turn"] }, tone: "request", emoji: "🙋", exposeToAi: true },
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
  { key: "wait", tKey: "aac.glyph.wait", pos: "verb", categories: ["do", "chat"],
    modeChips: { do: ["common"], chat: ["all", "turn"] }, tone: "comment", emoji: "⏳", exposeToAi: true },
  { key: "find", tKey: "aac.glyph.find", pos: "verb", categories: ["do"],
    modeChips: { do: ["mental"] }, tone: "comment", emoji: "🔍", exposeToAi: true },
  { key: "share", tKey: "aac.glyph.share", pos: "verb", categories: ["do"],
    modeChips: { do: ["social"] }, tone: "social", emoji: "🤝", exposeToAi: true },
  { key: "think", tKey: "aac.glyph.think", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "mental"] }, tone: "comment", emoji: "💭", exposeToAi: true,
    composable: { accepts: ["noun", "animal", "person", "place", "feeling"],
                  suggestCategories: ["what", "who"], position: "upper" } },
  { key: "stop", tKey: "aac.glyph.stop", pos: "verb", categories: ["do", "chat"],
    modeChips: { do: ["body"], chat: ["all", "turn"] }, tone: "request", emoji: "🛑", exposeToAi: true },
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
  // Recolour an item ("color the shirt red") — composable so it takes the thing
  // then a colour modifier, the same shape as wear(shirt).
  { key: "color", tKey: "aac.glyph.color", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "comment", emoji: "🎨", exposeToAi: true,
    composable: { accepts: ["noun"], suggestCategories: ["what"] } },
  { key: "brush_teeth", tKey: "aac.glyph.brush_teeth", pos: "verb", categories: ["do"],
    modeChips: { do: ["body"] }, tone: "comment", emoji: "🪥" },
  // emoji weak — `open`'s folder emoji reads file-manager rather than a
  // physical door / lid.
  { key: "open", tKey: "aac.glyph.open", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "comment", emoji: "📂",
    imagePath: "actions/hands/open",
    composable: { accepts: ["noun"], suggestCategories: ["what"] } },
  // SHUT is open's antonym — there is deliberately NO `close` record (user
  // law: no synonyms in a vocabulary the LLM reads, and "close" would collide
  // with close = NEAR). One word for the act, and it reads as a door/lid.
  { key: "shut", tKey: "aac.glyph.shut", pos: "verb", categories: ["do"],
    modeChips: { do: ["common", "hands"] }, tone: "comment", emoji: "🚪",
    imagePath: "actions/hands/shut", exposeToAi: true,
    composable: { accepts: ["noun"], suggestCategories: ["what"] } },
  // turn_on / turn_off — the device toggle ACTIONS (distinct from the on/off
  // state adjectives below).
  { key: "turn_on", tKey: "aac.glyph.turn_on", pos: "verb", categories: ["do"],
    modeChips: { do: ["hands"] }, tone: "comment", emoji: "🔛",
    imagePath: "actions/hands/turn_on", exposeToAi: true,
    composable: { accepts: ["noun"], suggestCategories: ["what"] } },
  { key: "turn_off", tKey: "aac.glyph.turn_off", pos: "verb", categories: ["do"],
    modeChips: { do: ["hands"] }, tone: "comment", emoji: "📴",
    imagePath: "actions/hands/turn_off", exposeToAi: true,
    composable: { accepts: ["noun"], suggestCategories: ["what"] } },
  // do — the generic action verb; also the standalone default head for `how`
  // ("how" = do.how, a `?` on the do glyph).
  { key: "do", tKey: "aac.glyph.do", pos: "verb", categories: ["do"],
    modeChips: { do: ["common"] }, tone: "comment", emoji: "🙌",
    imagePath: "actions/hands/do", exposeToAi: true },
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
  // Generic / question-word bases: `thing#question` = "what" (and any noun +
  // #question = "which X"); `cause#question` = "why". The word-level WH-words
  // (what/who/where/when/why/how) are canonical MODIFIERS registered at the end
  // of this array — standalone they expand to these bases + a `?` badge.
  { key: "thing", tKey: "aac.glyph.thing", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment",
    imagePath: "things/thing", emoji: "📦", exposeToAi: true },
  { key: "cause", tKey: "aac.glyph.cause", pos: "noun", categories: ["what"],
    modeChips: {}, tone: "comment",
    imagePath: "indicators/cause", emoji: "↩️", exposeToAi: true },
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
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🪑",
    imagePath: "things/furniture/chair" },
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
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🥤",
    imagePath: "things/tools/cup" },
  { key: "plate", tKey: "aac.glyph.plate", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🍽️",
    imagePath: "things/tools/plate" },
  { key: "bowl", tKey: "aac.glyph.bowl", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🥣",
    imagePath: "things/tools/bowl" },
  { key: "fork", tKey: "aac.glyph.fork", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🍴",
    imagePath: "things/tools/fork" },
  { key: "knife", tKey: "aac.glyph.knife", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🔪",
    imagePath: "things/tools/knife" },
  { key: "spoon", tKey: "aac.glyph.spoon", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🥄",
    imagePath: "things/tools/spoon" },

  // ── Furniture ────────────────────────────────────────────────────────────
  // The world-engine's station kinds (kernel/town/stations.ts). Containers all
  // share one silhouette family and differ by construction — see the container
  // motif in planning-docs/world-engine-icon-gaps.md.
  { key: "table", tKey: "aac.glyph.table", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🪑",
    imagePath: "things/furniture/table" },
  { key: "box", tKey: "aac.glyph.box", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "📦",
    imagePath: "things/furniture/box" },
  { key: "cabinet", tKey: "aac.glyph.cabinet", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🗄️",
    imagePath: "things/furniture/cabinet" },
  { key: "barrel", tKey: "aac.glyph.barrel", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🛢️",
    imagePath: "things/furniture/barrel" },
  // The BIN — the disposal can (the `fixture:bin` model is a lidded trash can;
  // the station affords `throw`). This is the ONE disposal word: the old
  // redundant `garbage` glyph was folded into `bin` (they were the same trash
  // can). "throw + <thing> + in + bin" is the disposal statement.
  { key: "bin", tKey: "aac.glyph.bin", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🗑️",
    imagePath: "things/furniture/bin" },
  { key: "oven", tKey: "aac.glyph.oven", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🔥",
    imagePath: "things/furniture/oven" },
  { key: "refrigerator", tKey: "aac.glyph.refrigerator", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🧊",
    imagePath: "things/furniture/refrigerator" },
  { key: "sink", tKey: "aac.glyph.sink", pos: "noun", categories: ["what"],
    modeChips: { what: ["all", "things"] }, tone: "comment", emoji: "🚰",
    imagePath: "things/furniture/sink" },
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
  { key: "lonely", tKey: "aac.glyph.lonely", pos: "feeling", categories: ["what"],
    modeChips: { what: ["all", "feelings"] }, tone: "feeling", emoji: "😔",
    imagePath: "adjectives/feelings/lonely", exposeToAi: true },
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
  { key: "yes", tKey: "aac.glyph.yes", pos: "noun", categories: ["what", "chat"],
    modeChips: { what: ["all", "social"], chat: ["all", "reply"] }, tone: "social", emoji: "✅", exposeToAi: true,
    animatedSprite: { sheet: "yes-no-sprites", cols: 3, rows: 2, row: 0, frames: [0, 1, 2, 1] } },
  { key: "no", tKey: "aac.glyph.no", pos: "noun", categories: ["what", "chat"],
    modeChips: { what: ["all", "social"], chat: ["all", "reply"] }, tone: "social", emoji: "❌", exposeToAi: true,
    animatedSprite: { sheet: "yes-no-sprites", cols: 3, rows: 2, row: 1, frames: [0, 1, 0, 2] } },
  { key: "maybe", tKey: "aac.glyph.maybe", pos: "noun", categories: ["what", "chat"],
    modeChips: { what: ["all", "social"], chat: ["all", "reply"] }, tone: "social", emoji: "🤷" },
  { key: "hello", tKey: "aac.glyph.hello", pos: "noun", categories: ["what", "chat"],
    modeChips: { what: ["all", "social"], chat: ["all", "greet"] }, tone: "social", emoji: "👋" },
  { key: "goodbye", tKey: "aac.glyph.goodbye", pos: "noun", categories: ["what", "chat"],
    modeChips: { what: ["all", "social"], chat: ["all", "greet"] }, tone: "social", emoji: "👋" },
  { key: "thank_you", tKey: "aac.glyph.thank_you", pos: "noun", categories: ["what", "chat"],
    modeChips: { what: ["all", "social"], chat: ["all", "polite"] }, tone: "social", emoji: "🙏" },
  { key: "sorry", tKey: "aac.glyph.sorry", pos: "noun", categories: ["what", "chat"],
    modeChips: { what: ["all", "social"], chat: ["all", "polite"] }, tone: "social", emoji: "😔" },

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
    modeChips: { where: ["spatial"] }, tone: "comment", emoji: "📍",
    imagePath: "places/here", exposeToAi: true },
  { key: "there", tKey: "aac.glyph.there", pos: "place", categories: ["where"],
    modeChips: { where: ["spatial"] }, tone: "comment", emoji: "🎯", exposeToAi: true },
  // near / far — the proximity pair (spatial deixis).
  { key: "near", tKey: "aac.glyph.near", pos: "place", categories: ["where"],
    modeChips: { where: ["spatial"] }, tone: "comment", emoji: "📍",
    imagePath: "places/near", exposeToAi: true },
  { key: "far", tKey: "aac.glyph.far", pos: "place", categories: ["where"],
    modeChips: { where: ["spatial"] }, tone: "comment", emoji: "🔭",
    imagePath: "places/far", exposeToAi: true },
  // Generic "place" base — also the question-word base: `place#question` = "where".
  { key: "place", tKey: "aac.glyph.place", pos: "place", categories: ["where"],
    modeChips: { where: ["places"] }, tone: "comment",
    imagePath: "places/place", emoji: "🗺️", exposeToAi: true },
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
  // AREA vs PLACE (nations arc, user law): a PLACE is a point (the 🗺️ pin
  // above); an AREA is a broad TERRITORY — hence the grid. One word-concept
  // from "my room" to "Riverside's land", and the noun every law scopes to
  // ("no + fight + in + area"). `town` is its named, bounded sibling.
  { key: "area", tKey: "aac.glyph.area", pos: "place", categories: ["where"],
    modeChips: { where: ["places"] }, tone: "comment", emoji: "🔲",
    imagePath: "places/area" },
  { key: "town", tKey: "aac.glyph.town", pos: "place", categories: ["where"],
    modeChips: { where: ["places"] }, tone: "comment", emoji: "🏘️" },
  // BUILDING and ROOM are also CONTAINER FRAMES: the compositor can nest any
  // symbol inside one (`building(farm)`, `room(bed)`) using the `-bg` plates,
  // so a structure's icon is its shell plus whatever the spec declares. Used
  // bare they're the generic nouns. See buildContainerGlyph in the compositor.
  { key: "building", tKey: "aac.glyph.building", pos: "place", categories: ["where"],
    modeChips: { where: ["places"] }, tone: "comment", emoji: "🏢",
    imagePath: "places/building", exposeToAi: true,
    composable: {
      accepts: ["noun", "animal", "person", "place", "verb"],
      suggestCategories: ["what", "where"],
      position: "center",
      filledImagePath: "places/building-bg",
    } },
  { key: "room", tKey: "aac.glyph.room", pos: "place", categories: ["where"],
    modeChips: { where: ["places"] }, tone: "comment", emoji: "🚪",
    imagePath: "places/room", exposeToAi: true,
    composable: {
      accepts: ["noun", "animal", "person", "place", "verb"],
      suggestCategories: ["what", "where"],
      position: "center",
      filledImagePath: "places/room-bg",
    } },

  // ── Indicators (deictic pointers — cross-listed under WHO and WHAT) ──────
  { key: "that", tKey: "aac.glyph.that", pos: "noun", categories: ["who", "what"],
    modeChips: { who: ["all"], what: ["all", "things"] }, tone: "comment",
    imagePath: "indicators/that", emoji: "👉", directional: true, exposeToAi: true },

  // ── WHEN ─────────────────────────────────────────────────────────────────
  { key: "now", tKey: "aac.glyph.now", pos: "time", categories: ["when"],
    modeChips: { when: ["quick"] }, tone: "comment", emoji: "⏱️", exposeToAi: true },
  // Generic "time" base — also the question-word base: `time#question` = "when".
  { key: "time", tKey: "aac.glyph.time", pos: "time", categories: ["when"],
    modeChips: { when: ["quick"] }, tone: "comment", emoji: "🕐", exposeToAi: true },
  // today / tomorrow / yesterday are aliases for the `day` SYMBOL carrying a
  // relational modifier (this / next / prev). They render as the day icon with
  // a directional arrow beneath and serialize to their long form — so the AI
  // and the sentence builder converge on `day.this` / `day.next` / `day.prev`.
  { key: "today", tKey: "aac.glyph.today", pos: "time", categories: ["when"],
    modeChips: { when: ["quick", "days"] }, tone: "comment", emoji: "📅", exposeToAi: true,
    expandsTo: "day.this" },
  { key: "tomorrow", tKey: "aac.glyph.tomorrow", pos: "time", categories: ["when"],
    modeChips: { when: ["quick", "days"] }, tone: "comment", emoji: "📅", exposeToAi: true,
    expandsTo: "day.next" },
  { key: "yesterday", tKey: "aac.glyph.yesterday", pos: "time", categories: ["when"],
    modeChips: { when: ["quick", "days"] }, tone: "comment", emoji: "📅", exposeToAi: true,
    expandsTo: "day.prev" },
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
  // hour / minute give the relational modifiers a unit to count against, e.g.
  // `hour.next.next` = "in two hours", `minute.prev` = "a minute ago".
  { key: "hour", tKey: "aac.glyph.hour", pos: "time", categories: ["when"],
    modeChips: { when: ["clock"] }, tone: "comment", emoji: "🕐", exposeToAi: true },
  { key: "minute", tKey: "aac.glyph.minute", pos: "time", categories: ["when"],
    modeChips: { when: ["clock"] }, tone: "comment", emoji: "⏱️", exposeToAi: true },
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

  // Amount scale — a fill-level gauge beneath the host (none→all). Distinct
  // from `dots` (exact counts) and `not` (negation). Emoji fallbacks use moon
  // phases so the standalone form still reads as a fill scale. `more` (above)
  // is the increase delta; `less`/`enough`/`both`/`every` are a follow-up.
  // Gauge quantifiers are hiddenFromCarousel — surfaced via the builder's
  // dedicated "amount" picker (like colors/emotions), not the main carousel.
  { key: "none", tKey: "aac.glyph.none", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🌑", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "gauge", order: 33, gauge: 0, hiddenFromCarousel: true } },
  { key: "some", tKey: "aac.glyph.some", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🌒", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "gauge", order: 34, gauge: 0.33, hiddenFromCarousel: true } },
  { key: "half", tKey: "aac.glyph.half", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🌓", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal"], transform: "gauge", order: 35, gauge: 0.5, hiddenFromCarousel: true } },
  { key: "most", tKey: "aac.glyph.most", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🌖", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "gauge", order: 36, gauge: 0.8, hiddenFromCarousel: true } },
  { key: "all", tKey: "aac.glyph.all", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🌕", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "gauge", order: 37, gauge: 1, hiddenFromCarousel: true } },

  // Quality opposite-pairs. `pairKey` links the poles (for the builder
  // pole-toggle + the <bundled_icons> "quality" group). good/bad render as
  // emoji badges (👍/👎); right/wrong use the `polarity` mark (✓/✗) since
  // ✓/✗ reads as correct/incorrect. Both attach to a host or stand alone.
  // (Scalar pairs like fast/slow, full/empty reuse the `gauge` transform;
  // overlay pairs like clean/dirty are a follow-up needing a spoil layer.)
  // Quality pairs are hiddenFromCarousel — surfaced via the builder's "quality"
  // pole-toggle picker. `polarity` marks the positive pole of each pair (also
  // drives the ✓/✗ render for right/wrong; harmless on good/bad's badge render).
  { key: "good", tKey: "aac.glyph.good", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "👍", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "badge", order: 43, polarity: "pos", pairKey: "bad", hiddenFromCarousel: true } },
  { key: "bad", tKey: "aac.glyph.bad", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "👎", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "badge", order: 44, polarity: "neg", pairKey: "good", hiddenFromCarousel: true } },
  { key: "right", tKey: "aac.glyph.right", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "✔️", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person", "verb"], transform: "polarity", order: 45, polarity: "pos", pairKey: "wrong", hiddenFromCarousel: true } },
  { key: "wrong", tKey: "aac.glyph.wrong", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "✖️", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person", "verb"], transform: "polarity", order: 46, polarity: "neg", pairKey: "right", hiddenFromCarousel: true } },

  // Relational (sequence) — directional arrows drawn BENEATH the symbol that
  // step a concept along an axis: `this` (current, points up), `next`
  // (forward), `prev` (backward). next/prev cancel one-for-one and stack up to
  // 4 (`day.next.next` = "in two days"); `this` is the neutral point and is
  // mutually exclusive with next/prev on the same slot. As a HEAD SYMBOL each
  // is just the arrow itself. RTL reverses forward/backward. The `relation`
  // facet is generic — new sequence axes can reuse the same machinery.
  { key: "this", tKey: "aac.glyph.this", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "⬆️", exposeToAi: true,
    modifier: { appliesTo: ["time", "noun"], transform: "relational", order: 24,
      relation: { arrow: "up", axis: "sequence", step: 0 } } },
  { key: "next", tKey: "aac.glyph.next", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "➡️", directional: true, exposeToAi: true,
    modifier: { appliesTo: ["time", "noun"], transform: "relational", order: 25,
      relation: { arrow: "forward", axis: "sequence", step: 1, maxStack: 4 } } },
  { key: "prev", tKey: "aac.glyph.prev", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "⬅️", directional: true, exposeToAi: true,
    modifier: { appliesTo: ["time", "noun"], transform: "relational", order: 26,
      relation: { arrow: "backward", axis: "sequence", step: -1, maxStack: 4 } } },

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

  // Gender / number — body-shape variants on a person head. `male`/`female`
  // swap the host art to a `-male`/`-female` body variant (restroom-pictogram
  // shapes); `plural` to a `-plural` (two figures). Until the variant art is
  // generated they fall back to a gendered emoji (🧑 → 👨/👩/👥). he/she/they
  // are the composed pronouns (person.male / person.female / person.plural).
  { key: "male", tKey: "aac.glyph.male", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "♂️", exposeToAi: true,
    modifier: { appliesTo: ["person"], transform: "gender_body", order: 40 } },
  { key: "female", tKey: "aac.glyph.female", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "♀️", exposeToAi: true,
    modifier: { appliesTo: ["person"], transform: "gender_body", order: 41 } },
  { key: "plural", tKey: "aac.glyph.plural", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "👥", exposeToAi: true,
    modifier: { appliesTo: ["person"], transform: "gender_body", order: 42 } },

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

  // Temperature — the `temperature` STATE axis (world-engine facts.ts). Drawn
  // as badge DESCRIPTORS, not the old warm/cool halo rings: a ring around the
  // rim reads as "selected" rather than "hot", and it collided with the color
  // modifier's frame. Badge art carries the meaning on its own.
  { key: "hot", tKey: "aac.glyph.hot", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment", emoji: "🔥", exposeToAi: true,
    imagePath: "adjectives/state/hot",
    modifier: { appliesTo: ["noun"], transform: "badge", order: 20, pairKey: "cold" } },
  { key: "cold", tKey: "aac.glyph.cold", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment", emoji: "❄️", exposeToAi: true,
    imagePath: "adjectives/state/cold",
    modifier: { appliesTo: ["noun"], transform: "badge", order: 21, pairKey: "hot" } },

  // Cleanliness — the `cleanliness` STATE axis. `clean` is registered as the
  // state ADJECTIVE here; the same-spelled world-engine ACTION ("clean the
  // table") stays a LEXICON-only parse token, distinguished syntactically —
  // the state is a modifier (`table.clean`), the action a bare verb head.
  { key: "dirty", tKey: "aac.glyph.dirty", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment", emoji: "🫧", exposeToAi: true,
    imagePath: "adjectives/state/dirty",
    modifier: { appliesTo: ["noun", "animal"], transform: "badge", order: 27, pairKey: "clean" } },
  { key: "clean", tKey: "aac.glyph.clean", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment", emoji: "✨", exposeToAi: true,
    imagePath: "adjectives/state/clean",
    modifier: { appliesTo: ["noun", "animal"], transform: "badge", order: 28, pairKey: "dirty" } },

  // Sensory qualities (smell / taste opposite pairs) — badge modifiers on nouns,
  // e.g. `food.smelly`. Also standalone WHAT chips.
  { key: "smelly", tKey: "aac.glyph.smelly", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment", emoji: "🤢", exposeToAi: true,
    imagePath: "adjectives/sensory/smelly",
    modifier: { appliesTo: ["noun", "animal"], transform: "badge", order: 22, pairKey: "fragrant" } },
  { key: "fragrant", tKey: "aac.glyph.fragrant", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment", emoji: "🌸", exposeToAi: true,
    imagePath: "adjectives/sensory/fragrant",
    modifier: { appliesTo: ["noun", "animal"], transform: "badge", order: 23, pairKey: "smelly" } },
  { key: "tasty", tKey: "aac.glyph.tasty", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment", emoji: "😋", exposeToAi: true,
    imagePath: "adjectives/sensory/tasty",
    modifier: { appliesTo: ["noun"], transform: "badge", order: 24, pairKey: "yucky" } },
  { key: "yucky", tKey: "aac.glyph.yucky", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment", emoji: "🤮", exposeToAi: true,
    imagePath: "adjectives/sensory/yucky",
    modifier: { appliesTo: ["noun"], transform: "badge", order: 25, pairKey: "tasty" } },

  // Device state — `off` is the state adjective (a lamp that is off); the `on`
  // state shares the spatial-preposition `on` key (a connector, below) so it
  // can't also be a modifier — `off` stands alone. `turn_on`/`turn_off` are the
  // ACTIONS. See the on/off asymmetry note in the vocab doc.
  { key: "off", tKey: "aac.glyph.off", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "comment", emoji: "🚫", exposeToAi: true,
    imagePath: "adjectives/state/off",
    modifier: { appliesTo: ["noun"], transform: "badge", order: 26 } },

  // ── Color modifiers ────────────────────────────────────────────────────
  // The compositor renders a colored frame around the slot rim when one of
  // these is applied. They're hidden from the modifier carousel — the
  // construction board exposes them via a dedicated color-picker popup —
  // but the AI may emit any of these keys directly. Standalone (used as
  // a slot rather than a modifier) they appear as a colored square emoji.
  { key: "color_red", tKey: "aac.glyph.color_red", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟥",
    modifier: { appliesTo: ["noun", "animal", "place"], transform: "color", order: 50, colorValue: "#DC2626", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_orange", tKey: "aac.glyph.color_orange", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟧",
    modifier: { appliesTo: ["noun", "animal", "place"], transform: "color", order: 51, colorValue: "#EA580C", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_yellow", tKey: "aac.glyph.color_yellow", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟨",
    modifier: { appliesTo: ["noun", "animal", "place"], transform: "color", order: 52, colorValue: "#FACC15", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_green", tKey: "aac.glyph.color_green", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟩",
    modifier: { appliesTo: ["noun", "animal", "place"], transform: "color", order: 53, colorValue: "#16A34A", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_blue", tKey: "aac.glyph.color_blue", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟦",
    modifier: { appliesTo: ["noun", "animal", "place"], transform: "color", order: 54, colorValue: "#2563EB", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_purple", tKey: "aac.glyph.color_purple", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟪",
    modifier: { appliesTo: ["noun", "animal", "place"], transform: "color", order: 55, colorValue: "#9333EA", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_pink", tKey: "aac.glyph.color_pink", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🩷",
    modifier: { appliesTo: ["noun", "animal", "place"], transform: "color", order: 56, colorValue: "#EC4899", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_brown", tKey: "aac.glyph.color_brown", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🟫",
    modifier: { appliesTo: ["noun", "animal", "place"], transform: "color", order: 57, colorValue: "#92400E", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_black", tKey: "aac.glyph.color_black", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "⬛",
    modifier: { appliesTo: ["noun", "animal", "place"], transform: "color", order: 58, colorValue: "#111827", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_white", tKey: "aac.glyph.color_white", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "⬜",
    modifier: { appliesTo: ["noun", "animal", "place"], transform: "color", order: 59, colorValue: "#F3F4F6", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "color_gray", tKey: "aac.glyph.color_gray", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "◻️",
    modifier: { appliesTo: ["noun", "animal", "place"], transform: "color", order: 60, colorValue: "#6B7280", hiddenFromCarousel: true }, exposeToAi: true },

  // Emotion modifiers — attach a feeling to a SYMBOL as a small face badge in a
  // corner (e.g. "happy dog"). Like colors, they're hidden from the main
  // carousel and surfaced via a dedicated emotion-picker popup in the builder.
  // Labels reuse the existing feeling-symbol `aac.glyph.*` translations.
  { key: "emo_happy", tKey: "aac.glyph.happy", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "😊",
    modifier: { appliesTo: ["noun", "animal", "person", "place", "verb", "feeling"], transform: "emotion", order: 70, corner: "top-right", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "emo_sad", tKey: "aac.glyph.sad", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "😢",
    modifier: { appliesTo: ["noun", "animal", "person", "place", "verb", "feeling"], transform: "emotion", order: 71, corner: "top-right", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "emo_angry", tKey: "aac.glyph.angry", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "😠",
    modifier: { appliesTo: ["noun", "animal", "person", "place", "verb", "feeling"], transform: "emotion", order: 72, corner: "top-right", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "emo_afraid", tKey: "aac.glyph.scared", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "😨",
    modifier: { appliesTo: ["noun", "animal", "person", "place", "verb", "feeling"], transform: "emotion", order: 73, corner: "top-right", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "emo_hurt", tKey: "aac.glyph.hurt", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🤕",
    modifier: { appliesTo: ["noun", "animal", "person", "place", "verb", "feeling"], transform: "emotion", order: 74, corner: "top-right", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "emo_excited", tKey: "aac.glyph.excited", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🤩",
    modifier: { appliesTo: ["noun", "animal", "person", "place", "verb", "feeling"], transform: "emotion", order: 75, corner: "top-right", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "emo_calm", tKey: "aac.glyph.calm", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "😌",
    modifier: { appliesTo: ["noun", "animal", "person", "place", "verb", "feeling"], transform: "emotion", order: 76, corner: "top-right", hiddenFromCarousel: true }, exposeToAi: true },
  { key: "emo_tired", tKey: "aac.glyph.tired", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "😴",
    modifier: { appliesTo: ["noun", "animal", "person", "place", "verb", "feeling"], transform: "emotion", order: 77, corner: "top-right", hiddenFromCarousel: true }, exposeToAi: true },

  // Social
  { key: "please", tKey: "aac.glyph.please", pos: "modifier", categories: ["do", "chat"],
    modeChips: { do: ["social"], chat: ["all", "polite"] }, tone: "social", emoji: "🙏", exposeToAi: true,
    modifier: { appliesTo: ["verb"], transform: "badge", order: 1 } },
  { key: "again", tKey: "aac.glyph.again", pos: "modifier", categories: ["do", "chat"],
    modeChips: { do: ["relation"], chat: ["all", "turn"] }, tone: "comment", emoji: "🔁", exposeToAi: true,
    modifier: { appliesTo: ["verb"], transform: "badge", order: 2 } },
  { key: "more", tKey: "aac.glyph.more", pos: "modifier", categories: ["do", "chat"],
    modeChips: { do: ["relation"], chat: ["all", "turn"] }, tone: "request", emoji: "➕", exposeToAi: true,
    modifier: { appliesTo: ["noun", "verb"], transform: "badge", order: 3 } },

  // ── CHAT — conversational expressions (new HEAD SYMBOLs) ─────────────────
  // Short utterance-level acts the student reaches for constantly: greetings,
  // politeness, acknowledgements, reactions, turn-taking. Existing items
  // (yes/no/maybe/hello/goodbye/thank_you/sorry/please/help/stop/wait/
  // again/more) are cross-listed into this category above.
  //
  // Greetings
  { key: "hi", tKey: "aac.glyph.hi", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "greet"] }, tone: "social", emoji: "🙋", exposeToAi: true },
  { key: "good_morning", tKey: "aac.glyph.good_morning", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "greet"] }, tone: "social", emoji: "🌅", exposeToAi: true },
  { key: "good_night", tKey: "aac.glyph.good_night", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "greet"] }, tone: "social", emoji: "🌙", exposeToAi: true },
  { key: "see_you_later", tKey: "aac.glyph.see_you_later", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "greet"] }, tone: "social", emoji: "🤚", exposeToAi: true },
  { key: "welcome", tKey: "aac.glyph.welcome", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "greet"] }, tone: "social", emoji: "🎉", exposeToAi: true },

  // Politeness
  { key: "youre_welcome", tKey: "aac.glyph.youre_welcome", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "polite"] }, tone: "social", emoji: "😊", exposeToAi: true },
  { key: "excuse_me", tKey: "aac.glyph.excuse_me", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "polite"] }, tone: "social", emoji: "🤚", exposeToAi: true },
  { key: "its_ok", tKey: "aac.glyph.its_ok", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "polite"] }, tone: "social", emoji: "🤗", exposeToAi: true },

  // Reply (acknowledgements). `yes`, `no`, `maybe` cross-listed above.
  // Understanding axis: `understand` + `confused`. "I don't understand" is
  // composed via `understand.not` once the student knows modifiers; `confused`
  // is a single-glyph fallback that means roughly the same thing.
  { key: "ok", tKey: "aac.glyph.ok", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "reply"] }, tone: "social", emoji: "👌", exposeToAi: true },
  { key: "understand", tKey: "aac.glyph.understand", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "reply"] }, tone: "social", emoji: "💡", exposeToAi: true },
  { key: "confused", tKey: "aac.glyph.confused", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "reply"] }, tone: "feeling", emoji: "😕", exposeToAi: true },

  // Reactions / discourse markers
  { key: "wow", tKey: "aac.glyph.wow", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "react"] }, tone: "feeling", emoji: "😮", exposeToAi: true },
  { key: "oops", tKey: "aac.glyph.oops", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "react"] }, tone: "comment", emoji: "😬", exposeToAi: true },
  { key: "oh_no", tKey: "aac.glyph.oh_no", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "react"] }, tone: "feeling", emoji: "😱", exposeToAi: true },
  { key: "cool", tKey: "aac.glyph.cool", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "react"] }, tone: "feeling", emoji: "😎", exposeToAi: true },
  { key: "yuck", tKey: "aac.glyph.yuck", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "react"] }, tone: "feeling", emoji: "🤢", exposeToAi: true },
  { key: "look", tKey: "aac.glyph.look", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "react"] }, tone: "social", emoji: "👀", exposeToAi: true },

  // Turn-taking / conversation flow. `wait`, `help`, `stop`, `again`, `more`
  // cross-listed above.
  { key: "my_turn", tKey: "aac.glyph.my_turn", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "turn"] }, tone: "social", emoji: "🙋", exposeToAi: true },
  { key: "your_turn", tKey: "aac.glyph.your_turn", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "turn"] }, tone: "social", emoji: "🫵", exposeToAi: true, directional: true },
  { key: "slow_down", tKey: "aac.glyph.slow_down", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "turn"] }, tone: "social", emoji: "🐢", exposeToAi: true },
  { key: "finished", tKey: "aac.glyph.finished", pos: "noun", categories: ["chat"],
    modeChips: { chat: ["all", "turn"] }, tone: "comment", emoji: "🏁", exposeToAi: true },

  // ── Preposition modifiers ────────────────────────────────────────────────
  // Tier-1 relations the interpreter can't infer from verb+noun context
  // (accompaniment, sequencing, beneficiary, causation, substitution).
  // All hidden from the construction-board grid (categories: []) — they
  // attach to an adjacent slot like `my`/`your`/`not`. Tier-2 spatial pairs
  // (behind/in_front/under/over) are deliberately deferred until the
  // compositor grows a `spatial_overlay` transform.
  { key: "with", tKey: "aac.glyph.with", pos: "modifier", categories: [],
    modeChips: {}, tone: "social", emoji: "🤝", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "badge", order: 15 } },
  { key: "for", tKey: "aac.glyph.for", pos: "modifier", categories: [],
    modeChips: {}, tone: "social", emoji: "🎁", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person"], transform: "badge", order: 16 } },
  { key: "instead", tKey: "aac.glyph.instead", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "🔄", exposeToAi: true,
    modifier: { appliesTo: ["noun", "animal", "person", "verb"], transform: "badge", order: 17 } },
  { key: "before", tKey: "aac.glyph.before", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "⏮️", exposeToAi: true, directional: true,
    modifier: { appliesTo: ["noun", "verb", "time"], transform: "badge", order: 18 } },
  { key: "after", tKey: "aac.glyph.after", pos: "modifier", categories: [],
    modeChips: {}, tone: "comment", emoji: "⏭️", exposeToAi: true, directional: true,
    modifier: { appliesTo: ["noun", "verb", "time"], transform: "badge", order: 19 } },
  // ── Connectors (forward-binding joins between two GLYPHs) ─────────────────
  // Recognized positionally in `+` slots: `apple + or + banana`,
  // `sad + because + you_leave`. They bind to the FOLLOWING glyph and consume
  // no content slot (parser: CONNECTORS in glyph-compositor.ts). `with`/`for`
  // stay modifiers (single-noun role markers). `because` was migrated here off
  // its old badge-MODIFIER model.
  { key: "and", tKey: "aac.glyph.and", pos: "connector", categories: [],
    modeChips: {}, tone: "comment", emoji: "➕", exposeToAi: true },
  { key: "or", tKey: "aac.glyph.or", pos: "connector", categories: [],
    modeChips: {}, tone: "comment", emoji: "🔀", exposeToAi: true },
  { key: "but", tKey: "aac.glyph.but", pos: "connector", categories: [],
    modeChips: {}, tone: "comment", emoji: "↔️", exposeToAi: true },
  { key: "if", tKey: "aac.glyph.if", pos: "connector", categories: [],
    modeChips: {}, tone: "comment", emoji: "❓", exposeToAi: true },
  { key: "because", tKey: "aac.glyph.because", pos: "connector", categories: [],
    modeChips: {}, tone: "comment", emoji: "🔗", imagePath: "indicators/because", exposeToAi: true },

  // Spatial relations — also forward-binding joins, but rendered as a
  // trajectory arrow from glyph A → glyph B (SpatialArrow) instead of a logical
  // link. `go + to + school`, `cat + under + table`, `water + in + cup`.
  // SPATIAL_RELATIONS in glyph-compositor.ts drives both the parser and render.
  { key: "to", tKey: "aac.glyph.to", pos: "connector", categories: [],
    modeChips: {}, tone: "comment", emoji: "➡️", exposeToAi: true },
  { key: "from", tKey: "aac.glyph.from", pos: "connector", categories: [],
    modeChips: {}, tone: "comment", emoji: "⬅️", exposeToAi: true },
  { key: "in", tKey: "aac.glyph.in", pos: "connector", categories: [],
    modeChips: {}, tone: "comment", emoji: "📥", exposeToAi: true },
  { key: "out", tKey: "aac.glyph.out", pos: "connector", categories: [],
    modeChips: {}, tone: "comment", emoji: "📤", exposeToAi: true },
  { key: "on", tKey: "aac.glyph.on", pos: "connector", categories: [],
    modeChips: {}, tone: "comment", emoji: "🔛", imagePath: "adjectives/state/on", exposeToAi: true },
  { key: "under", tKey: "aac.glyph.under", pos: "connector", categories: [],
    modeChips: {}, tone: "comment", emoji: "⬇️", exposeToAi: true },
  { key: "over", tKey: "aac.glyph.over", pos: "connector", categories: [],
    modeChips: {}, tone: "comment", emoji: "⤴️", exposeToAi: true },
  { key: "through", tKey: "aac.glyph.through", pos: "connector", categories: [],
    modeChips: {}, tone: "comment", emoji: "↪️", exposeToAi: true },

  // ── Question words ────────────────────────────────────────────────────────
  // The six WH-words have NO icon of their own. They are canonical MODIFIERS:
  // used on a head (`apple.what`, `place.where`) they drop a `?` badge on it,
  // regardless of the head. Used STANDALONE they expand (expandsTo) to a default
  // head carrying themselves as the modifier — so `what` renders as the generic
  // `thing` glyph with the `?` badge, `who` as `someone`, `where` as `place`,
  // `when` as `time`, `why` as `cause`, `how` as `do`. Hidden from the modifier
  // carousel (the `#question` OPERATOR is the builder's `?` affordance); the AI
  // emits them directly. All render the same ❓ badge — the default HEAD is what
  // distinguishes them when standalone.
  { key: "what", tKey: "aac.glyph.what", pos: "modifier", categories: ["what"],
    modeChips: { what: ["all"] }, tone: "question", emoji: "❓", exposeToAi: true, expandsTo: "thing.what",
    modifier: { appliesTo: ["person", "animal", "noun", "verb", "place", "time", "feeling"], transform: "badge", order: 95, corner: "top-right", hiddenFromCarousel: true } },
  { key: "who", tKey: "aac.glyph.who", pos: "modifier", categories: ["who"],
    modeChips: { who: ["all"] }, tone: "question", emoji: "❓", exposeToAi: true, expandsTo: "someone.who",
    modifier: { appliesTo: ["person", "animal", "noun", "verb", "place", "time", "feeling"], transform: "badge", order: 96, corner: "top-right", hiddenFromCarousel: true } },
  { key: "where", tKey: "aac.glyph.where", pos: "modifier", categories: ["where"],
    modeChips: { where: ["spatial"] }, tone: "question", emoji: "❓", exposeToAi: true, expandsTo: "place.where",
    modifier: { appliesTo: ["person", "animal", "noun", "verb", "place", "time", "feeling"], transform: "badge", order: 97, corner: "top-right", hiddenFromCarousel: true } },
  { key: "when", tKey: "aac.glyph.when", pos: "modifier", categories: ["when"],
    modeChips: { when: ["quick"] }, tone: "question", emoji: "❓", exposeToAi: true, expandsTo: "time.when",
    modifier: { appliesTo: ["person", "animal", "noun", "verb", "place", "time", "feeling"], transform: "badge", order: 98, corner: "top-right", hiddenFromCarousel: true } },
  { key: "why", tKey: "aac.glyph.why", pos: "modifier", categories: [],
    modeChips: {}, tone: "question", emoji: "❓", exposeToAi: true, expandsTo: "cause.why",
    modifier: { appliesTo: ["person", "animal", "noun", "verb", "place", "time", "feeling"], transform: "badge", order: 99, corner: "top-right", hiddenFromCarousel: true } },
  { key: "how", tKey: "aac.glyph.how", pos: "modifier", categories: ["do"],
    modeChips: { do: ["common"] }, tone: "question", emoji: "❓", exposeToAi: true, expandsTo: "do.how",
    modifier: { appliesTo: ["person", "animal", "noun", "verb", "place", "time", "feeling"], transform: "badge", order: 100, corner: "top-right", hiddenFromCarousel: true } },
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

/** Emotion modifiers (face badge) applicable to a given part-of-speech. */
export function emotionModifiersFor(pos: GlyphPos): VocabularyItem[] {
  return VOCAB.filter((v) =>
    v.modifier?.transform === "emotion"
    && v.modifier.appliesTo.includes(pos)
  ).sort((a, b) => (a.modifier!.order - b.modifier!.order));
}

/** Gauge (amount-scale) modifiers applicable to a given part-of-speech.
 *  Surfaced via the builder's dedicated "amount" picker, like colors. */
export function gaugeModifiersFor(pos: GlyphPos): VocabularyItem[] {
  return VOCAB.filter((v) =>
    v.modifier?.transform === "gauge"
    && v.modifier.appliesTo.includes(pos)
  ).sort((a, b) => (a.modifier!.order - b.modifier!.order));
}

/**
 * Opposite-pair quality modifiers applicable to a given part-of-speech, grouped
 * into `{ pos, neg }` pairs (deduped by `pairKey`). Drives the builder's
 * pole-toggle. Each pole carries `modifier.polarity` ("pos"/"neg"); the pair is
 * keyed by the alphabetically-first of the two keys so it appears once.
 */
export function qualityPairsFor(pos: GlyphPos): Array<{ pos: VocabularyItem; neg: VocabularyItem }> {
  const byKey = new Map<string, VocabularyItem>();
  for (const v of VOCAB) {
    if (v.modifier?.pairKey && v.modifier.appliesTo.includes(pos)) byKey.set(v.key, v);
  }
  const out: Array<{ pos: VocabularyItem; neg: VocabularyItem }> = [];
  const seen = new Set<string>();
  for (const v of byKey.values()) {
    const partner = byKey.get(v.modifier!.pairKey!);
    if (!partner || seen.has(v.key) || seen.has(partner.key)) continue;
    seen.add(v.key); seen.add(partner.key);
    const posItem = v.modifier!.polarity === "neg" ? partner : v;
    const negItem = posItem === v ? partner : v;
    out.push({ pos: posItem, neg: negItem });
  }
  out.sort((a, b) => (a.pos.modifier!.order - b.pos.modifier!.order));
  return out;
}

/** All CONNECTOR/SPATIAL join SYMBOLs (forward-binding joins). For the builder's
 *  join picker; logical connectors first, then spatial relations. */
export function listConnectors(): VocabularyItem[] {
  return VOCAB.filter((v) => v.pos === "connector");
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
  chat: ["all", "greet", "polite", "reply", "react", "turn"],
};

/** Default mode chip per category — first in the list. */
export function defaultModeChip(category: GlyphCategory): string {
  return MODE_CHIPS[category][0];
}
