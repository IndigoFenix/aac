// shared/emoji-registry.ts
//
// Server- and client-safe lookup from snake_case image keys → emoji. Built
// in two layers:
//   1. Every vocabulary item in the glyph registry that declares an emoji.
//      Free — the data already exists in glyph-registry.ts.
//   2. EXTRA_EMOJIS: a curated supplementary map of common AAC concepts
//      that aren't in the glyph registry but have stable, unambiguous
//      emoji equivalents.
//
// Purpose: when the AI emits an imageKey (either a single concept or a
// part of a + -joined glyph), the server checks this registry before
// triggering a Gemini/OpenAI image generation. If we already have a
// reasonable emoji, we use it — saving cost AND latency, since the
// generation pipeline can take 5-15 seconds per image.
//
// Guidelines for adding entries to EXTRA_EMOJIS:
//   - Key MUST be snake_case English, matching how the AI is told to
//     emit imageKeys (see IMAGE_KEY_PROMPT_RULES in auto-symbol-service.ts).
//   - Value SHOULD be a single emoji (or a short ZWJ sequence) that is
//     unambiguous in the AAC context. Ambiguous emoji (e.g. 🌶️ for "spicy"
//     vs "pepper") should be avoided unless the key spells out the meaning.
//   - When in doubt, leave it out and let the generator run.

import { listAllVocabulary } from "./glyph-registry.js";

// Auto-imported from the glyph registry. Whenever a registry item gains
// or loses an emoji, this map updates with no manual sync needed.
const REGISTRY_EMOJIS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const v of listAllVocabulary()) {
    if (v.emoji) out[v.key] = v.emoji;
  }
  return out;
})();

// Supplementary entries for common AAC concepts the glyph registry doesn't
// cover. Grouped by category for maintainability; order within categories
// is alphabetical (snake-case key order).
const EXTRA_EMOJIS: Record<string, string> = {
  // ─── Feelings / states ──────────────────────────────────────────────
  angry: "😠",
  bored: "😑",
  calm: "😌",
  confused: "😕",
  embarrassed: "😳",
  excited: "🤩",
  happy: "😊",
  hungry: "🤤",
  hurt: "🤕",
  proud: "😎",
  sad: "😢",
  scared: "😨",
  shy: "😳",
  sick: "🤒",
  silly: "🤪",
  surprised: "😲",
  thirsty: "💧",
  tired: "😴",
  worried: "😟",

  // ─── Food ───────────────────────────────────────────────────────────
  apple: "🍎",
  banana: "🍌",
  bread: "🍞",
  broccoli: "🥦",
  cake: "🎂",
  candy: "🍬",
  carrot: "🥕",
  cereal: "🥣",
  cheese: "🧀",
  chicken: "🍗",
  chocolate: "🍫",
  cookie: "🍪",
  corn: "🌽",
  egg: "🥚",
  fish_food: "🐟",
  fruit: "🍎",
  grape: "🍇",
  grapes: "🍇",
  ice_cream: "🍦",
  ice_cream_cone: "🍦",
  lemon: "🍋",
  meat: "🥩",
  noodles: "🍜",
  orange: "🍊",
  pasta: "🍝",
  pie: "🥧",
  pizza: "🍕",
  popcorn: "🍿",
  rice: "🍚",
  salad: "🥗",
  sandwich: "🥪",
  soup: "🍲",
  strawberry: "🍓",
  taco: "🌮",
  vegetable: "🥦",
  watermelon: "🍉",
  yogurt: "🥛",

  // ─── Drink ──────────────────────────────────────────────────────────
  coffee: "☕",
  juice: "🧃",
  milk: "🥛",
  soda: "🥤",
  tea: "🍵",

  // ─── People (extras beyond the registry) ────────────────────────────
  boy: "👦",
  girl: "👧",
  grandma: "👵",
  grandpa: "👴",
  man: "👨",
  nurse: "🧑‍⚕️",
  woman: "👩",

  // ─── Animals ────────────────────────────────────────────────────────
  bear: "🐻",
  bird: "🐦",
  bunny: "🐰",
  butterfly: "🦋",
  cat: "🐈",
  chicken_animal: "🐔",
  cow: "🐄",
  dog: "🐕",
  duck: "🦆",
  elephant: "🐘",
  fish: "🐟",
  fox: "🦊",
  frog: "🐸",
  giraffe: "🦒",
  horse: "🐴",
  lion: "🦁",
  monkey: "🐵",
  mouse: "🐭",
  panda: "🐼",
  penguin: "🐧",
  pig: "🐷",
  rabbit: "🐰",
  sheep: "🐑",
  snake: "🐍",
  tiger: "🐅",
  turtle: "🐢",
  unicorn: "🦄",
  whale: "🐳",

  // ─── Vehicles ───────────────────────────────────────────────────────
  airplane: "✈️",
  bike: "🚲",
  boat: "⛵",
  bus: "🚌",
  car: "🚗",
  helicopter: "🚁",
  motorcycle: "🏍️",
  plane: "✈️",
  rocket: "🚀",
  ship: "🚢",
  train: "🚆",
  truck: "🚚",

  // ─── Places (extras beyond the registry) ────────────────────────────
  beach: "🏖️",
  city: "🏙️",
  classroom: "🏫",
  forest: "🌲",
  hospital: "🏥",
  library: "📚",
  mountain: "⛰️",
  ocean: "🌊",
  playground: "🛝",
  restaurant: "🍽️",
  store: "🏬",
  zoo: "🦁",

  // ─── Things / objects ───────────────────────────────────────────────
  axe: "🪓",
  backpack: "🎒",
  balloon: "🎈",
  bicycle: "🚲",
  blanket: "🛏️",
  brush: "🪥",
  bubble: "🫧",
  candle: "🕯️",
  cards: "🃏",
  clock: "🕒",
  computer: "💻",
  crayon: "🖍️",
  cup: "🥤",
  doll: "🪆",
  flower: "🌸",
  flowers: "💐",
  fork: "🍴",
  game: "🎮",
  glasses: "👓",
  key: "🔑",
  knife: "🍴",
  lamp: "💡",
  letter: "✉️",
  light: "💡",
  marker: "🖊️",
  medicine: "💊",
  money: "💰",
  music: "🎵",
  paper: "📄",
  pen: "🖊️",
  pencil: "✏️",
  pick: "⛏️",
  picture: "🖼️",
  plate: "🍽️",
  present: "🎁",
  puzzle: "🧩",
  scissors: "✂️",
  soap: "🧼",
  spoon: "🥄",
  star: "⭐",
  sticker: "⭐",
  // No `table` here. It is a glyph-registry item with bundled art, so this map
  // never needed to cover it — and the 🪑 it used to carry is the CHAIR, which is
  // what a table button actually rendered as everywhere resolveEmoji() decides
  // the picture (the relay's iconRef swap, the caption validator's fallback).
  teddy_bear: "🧸",
  tissue: "🧻",
  toilet: "🚽",
  toothbrush: "🪥",
  towel: "🧻",
  toy: "🧸",
  toys: "🧸",
  tv: "📺",
  umbrella: "☂️",
  window: "🪟",

  // ─── Clothing ───────────────────────────────────────────────────────
  coat: "🧥",
  dress: "👗",
  gloves: "🧤",
  hat: "🎩",
  jacket: "🧥",
  pants: "👖",
  scarf: "🧣",
  shorts: "🩳",
  socks: "🧦",

  // ─── Body parts ─────────────────────────────────────────────────────
  arm: "💪",
  ear: "👂",
  eye: "👁️",
  eyes: "👀",
  face: "😀",
  foot: "🦶",
  hair: "💇",
  hand: "✋",
  head: "👤",
  knee: "🦵",
  leg: "🦵",
  mouth: "👄",
  nose: "👃",
  teeth: "🦷",
  tongue: "👅",
  tooth: "🦷",

  // ─── Verbs / actions (extras) ───────────────────────────────────────
  brush_teeth: "🪥",
  clap: "👏",
  clean: "🧹",
  cook: "🍳",
  cry: "😢",
  dance: "💃",
  draw: "🎨",
  hug: "🤗",
  jump: "🤸",
  kiss: "💋",
  laugh: "😂",
  paint: "🎨",
  read: "📖",
  run: "🏃",
  sing: "🎤",
  sit: "🪑",
  sleep: "😴",
  smile: "😊",
  swim: "🏊",
  throw: "🤾",
  wait: "⏳",
  wake_up: "⏰",
  walk: "🚶",
  wash: "🧼",
  watch: "👀",
  wave: "👋",
  work: "💼",
  write: "✍️",

  // ─── Nature / weather ───────────────────────────────────────────────
  block: "🧱",
  cloud: "☁️",
  fire: "🔥",
  grass: "🌱",
  ice: "🧊",
  leaf: "🍃",
  moon: "🌙",
  rain: "🌧️",
  rainbow: "🌈",
  snow: "❄️",
  snowflake: "❄️",
  sun: "☀️",
  tree: "🌳",
  wind: "🌬️",
  wood: "🪵",

  // ─── Colors ─────────────────────────────────────────────────────────
  black: "⚫",
  blue: "🔵",
  brown: "🟤",
  green: "🟢",
  orange_color: "🟠",
  pink: "🩷",
  purple: "🟣",
  red: "🔴",
  white: "⚪",
  yellow: "🟡",

  // ─── Social ─────────────────────────────────────────────────────────
  bye: "👋",
  goodbye: "👋",
  hello: "👋",
  hi: "👋",
  ok: "👌",
  okay: "👌",
  sorry: "🙏",
  thank_you: "🙏",
  thanks: "🙏",
};

/**
 * Heuristic: does this string look like one or more emoji codepoints
 * (no letters / digits / underscores)?  Used so that an AI emitting a
 * glyph like `i_me+want+🍎` ends up rendering the literal 🍎 instead
 * of falling through to "❓" because "🍎" isn't a registered key.
 *
 * Covers most pictographic ranges: Misc Symbols & Pictographs, Emoticons,
 * Transport & Map, Supplemental Symbols, Dingbats, plus the regional
 * indicators / VS-16 / ZWJ combiners that build compound emoji sequences.
 */
const EMOJI_PATTERN = /^(?:[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{1F100}-\u{1F1FF}\u{FE0F}\u{200D}])+$/u;

export function isEmoji(key: string): boolean {
  return !!key && EMOJI_PATTERN.test(key);
}

/**
 * Resolve a snake_case key (or a raw emoji) to a fallback emoji. Lookup
 * order:
 *   1. If the key IS already an emoji sequence, return it unchanged.
 *   2. A `face:<id>` reference always resolves to the 👤 silhouette —
 *      callers with access to the face cache render the actual image,
 *      and the emoji is the universal "we don't have a cached face for
 *      this contact yet" placeholder (mirrors AppMiniBoard's behavior).
 *   3. Glyph-registry vocabulary item with an emoji field.
 *   4. The supplementary EXTRA_EMOJIS map.
 * Returns `undefined` when no emoji is known — callers should then fall
 * back to image generation or a "❓" placeholder.
 */
export function resolveEmoji(key: string): string | undefined {
  if (!key) return undefined;
  if (isEmoji(key)) return key;
  if (key.startsWith("face:")) return "👤";
  return REGISTRY_EMOJIS[key] ?? EXTRA_EMOJIS[key];
}

/** Convenience: true when `resolveEmoji(key)` would return a value. */
export function hasEmoji(key: string): boolean {
  return resolveEmoji(key) !== undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// RTL non-reversible emoji
// ─────────────────────────────────────────────────────────────────────────────
//
// In RTL the glyph compositor mirrors symbol artwork horizontally (so a
// person/arrow points the natural reading direction). That looks right for
// pictographs but reads as garbage for emoji that *contain text* — letters,
// digits, whole words ("SOS", "NEW", "100"), or asymmetric punctuation ("?").
// A mirrored "🔤" or "💯" is just wrong. This registry flags those so the flip
// is skipped for them while ordinary pictographs still mirror.
//
// Two layers, mirroring the emoji map above:
//   1. NON_REVERSIBLE_RANGES — Unicode blocks whose glyphs ARE letterforms /
//      digits / enclosed text. Cheap span checks cover whole alphabets at once.
//   2. NON_REVERSIBLE_CODEPOINTS — individual pictographs that spell text or
//      numbers but live outside those blocks (💯, 🔟, © ®, the ? / ! marks).
//
// To extend: add a code point to NON_REVERSIBLE_CODEPOINTS (use String.codePointAt,
// e.g. `"🆕".codePointAt(0) === 0x1f195`), or widen a range when a whole block
// of text-glyphs needs excluding.

const NON_REVERSIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0030, 0x0039], // ASCII digits 0-9
  [0x0041, 0x005a], // ASCII A-Z
  [0x0061, 0x007a], // ASCII a-z
  [0x2100, 0x214f], // Letterlike Symbols (™ ℹ № ℡ …)
  [0x2460, 0x24ff], // Enclosed Alphanumerics (①, ⓐ, Ⓜ …)
  [0x1f100, 0x1f1ff], // Enclosed Alphanumeric Supplement (🆕 🆘 🆔 🅰 🆎 + flag letters)
  [0x1f200, 0x1f2ff], // Enclosed Ideographic Supplement (squared CJK 🈁 🈂 🈚 🉐 …)
  [0x1f520, 0x1f524], // 🔠 🔡 🔢 🔣 🔤 input-symbol keys
];

// Pictographs that render text/numbers/asymmetric punctuation but sit outside
// the ranges above. Stored as code points so variation selectors don't break
// the lookup.
const NON_REVERSIBLE_CODEPOINTS: ReadonlySet<number> = new Set([
  0x0021, // !
  0x003f, // ?
  0x00a9, // ©
  0x00ae, // ®
  0x203c, // ‼
  0x2049, // ⁉
  0x2753, // ❓
  0x2754, // ❔
  0x2755, // ❕
  0x2757, // ❗
  0x1f4af, // 💯
  0x1f51f, // 🔟 keycap ten
]);

const KEYCAP_COMBINER = 0x20e3; // builds 0️⃣–9️⃣ #️⃣ *️⃣
const VARIATION_SELECTOR_16 = 0xfe0f;
const ZWJ = 0x200d;

/**
 * True when an emoji (or raw character/sequence) must NOT be horizontally
 * mirrored in RTL, because it carries letters, digits, a word, or asymmetric
 * punctuation whose mirror image reads wrong. Ordinary pictographs return
 * false and still flip.
 *
 * Detection scans each code point: a keycap combiner (0️⃣–9️⃣) short-circuits
 * to true, otherwise the base code point is matched against the explicit set
 * and the letterform ranges. Variation selectors and ZWJ joiners are skipped
 * so "0️⃣", "ℹ️" and ZWJ sequences match on their meaningful code points.
 */
export function isNonReversibleEmoji(str: string): boolean {
  if (!str) return false;
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (cp === VARIATION_SELECTOR_16 || cp === ZWJ) continue;
    if (cp === KEYCAP_COMBINER) return true;
    if (NON_REVERSIBLE_CODEPOINTS.has(cp)) return true;
    for (const [lo, hi] of NON_REVERSIBLE_RANGES) {
      if (cp >= lo && cp <= hi) return true;
    }
  }
  return false;
}

/**
 * True when a VOCABULARY ITEM must not be horizontally mirrored in RTL.
 *
 * Two sources, in order:
 *   1. `nonReversible: true` on the item — the explicit opt-out, for bundled
 *      ARTWORK that reads wrong mirrored (art containing a numeral, a letter,
 *      or asymmetric punctuation). Nothing bundled needs it yet; the field is
 *      the hook for when such art lands.
 *   2. The item's canonical emoji, via `isNonReversibleEmoji` — digits,
 *      keycaps, enclosed letterforms, `?` / `!`. An item like `what` (❓) or
 *      the numeral modifiers carry their text INSIDE the glyph, so mirroring
 *      yields a reversed question mark rather than a right-to-left one.
 *
 * Lives here rather than in the compositor because it is a fact about the
 * item, not about a render: the compositor must not be the only place that
 * knows it, and it cannot be imported by server code or tests. Note the
 * dependency direction — this module already reads the glyph registry, so the
 * predicate cannot live there without a cycle.
 */
export function isNonReversibleItem(item: {
  nonReversible?: boolean;
  emoji?: string;
}): boolean {
  if (item.nonReversible) return true;
  return isNonReversibleEmoji(item.emoji ?? "");
}

/** What a surface knows about the symbol it is about to draw. */
export interface MirrorSubject {
  /**
   * The slot / button key, when there is one (`walk`, `🏃`, `face:<id>`).
   * Board buttons name a contact through `symbolPath` as `__FACE__:<id>`;
   * both spellings count as a face.
   */
  key?: string;
  /** The emoji this concept renders as, or would fall back to. */
  emoji?: string;
  /** The registry item, when the key resolved to one. */
  item?: { nonReversible?: boolean; emoji?: string };
}

/**
 * THE mirror rule. One predicate, called by every surface that draws a symbol —
 * the SVG glyph compositor, the board buttons, the sentence-builder chips, the
 * clinician's picker — because a symbol that mirrors in the composed glyph but
 * not on the button it was pressed from reads as two different symbols.
 *
 * Mirror in RTL by DEFAULT. An ordinary pictograph is a picture of a concept,
 * and in a right-to-left sentence it should face the way the sentence runs;
 * that holds whether it renders as bundled art, as generated art, or as the
 * emoji standing in for either. Three things opt out:
 *
 *   1. A person's photo (`face:` key). A portrait is not a pictograph — it has
 *      no direction relative to the sentence axis, and the face gallery exists
 *      so a student RECOGNIZES someone. Mirroring works against that.
 *   2. An item flagged `nonReversible` — bundled art carrying a numeral, a
 *      letter, or asymmetric punctuation.
 *   3. A text-like emoji (digits, keycaps, enclosed letterforms, `?`), via
 *      `isNonReversibleEmoji`.
 *
 * Deliberately NOT gated on the key resolving to a registry item. Whether we
 * happen to have catalogued a concept says nothing about whether its picture
 * can be flipped — and gating on it is what let an AI-emitted 🦒 mirror on the
 * builder chip while staying upright in the glyph beside it.
 */
export function shouldMirror(rtl: boolean, subject: MirrorSubject): boolean {
  if (!rtl) return false;
  if (isFaceKey(subject.key)) return false;
  if (subject.item && isNonReversibleItem(subject.item)) return false;
  return !isNonReversibleEmoji(subject.emoji ?? subject.item?.emoji ?? "");
}

/** A key naming a contact's photo, in either the glyph or the board spelling. */
export function isFaceKey(key: string | undefined): boolean {
  return !!key && (key.startsWith("face:") || key.startsWith("__FACE__:"));
}

/** Frozen so every mirrored node shares one object — cheap prop identity. */
const RTL_MIRROR_STYLE = Object.freeze({ transform: "scaleX(-1)" });

/**
 * `shouldMirror` as an inline style for DOM surfaces (`undefined` when the
 * symbol must stay upright). The SVG side builds its own `transform` around a
 * centre point instead; both ask the same question first.
 *
 * Pass the CONCEPT's representative emoji, not the node being rendered: an
 * `<img>` and the emoji standing in for it while it loads must agree, or the
 * icon visibly turns around the moment the image arrives.
 *
 * Returns a plain object rather than React.CSSProperties so this module stays
 * importable by server code — it is assignable to a `style` prop as-is.
 */
export function rtlMirrorStyle(
  rtl: boolean,
  subject: MirrorSubject | string | undefined,
): { transform: string } | undefined {
  const s: MirrorSubject = typeof subject === "string" ? { emoji: subject } : subject ?? {};
  return shouldMirror(rtl, s) ? RTL_MIRROR_STYLE : undefined;
}

// Re-export the pattern check for callers that need to distinguish a
// raw emoji slot from a snake_case imageKey (e.g. parsers deciding
// whether to queue symbol generation).
export { EMOJI_PATTERN };
