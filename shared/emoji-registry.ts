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
  picture: "🖼️",
  plate: "🍽️",
  present: "🎁",
  puzzle: "🧩",
  scissors: "✂️",
  soap: "🧼",
  spoon: "🥄",
  star: "⭐",
  sticker: "⭐",
  table: "🪑",
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
 *   2. Glyph-registry vocabulary item with an emoji field.
 *   3. The supplementary EXTRA_EMOJIS map.
 * Returns `undefined` when no emoji is known — callers should then fall
 * back to image generation or a "❓" placeholder.
 */
export function resolveEmoji(key: string): string | undefined {
  if (!key) return undefined;
  if (isEmoji(key)) return key;
  return REGISTRY_EMOJIS[key] ?? EXTRA_EMOJIS[key];
}

/** Convenience: true when `resolveEmoji(key)` would return a value. */
export function hasEmoji(key: string): boolean {
  return resolveEmoji(key) !== undefined;
}

// Re-export the pattern check for callers that need to distinguish a
// raw emoji slot from a snake_case imageKey (e.g. parsers deciding
// whether to queue symbol generation).
export { EMOJI_PATTERN };
