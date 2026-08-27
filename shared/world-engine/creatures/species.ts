// shared/world-engine/creatures/species.ts
//
// The SPECIES REGISTRY — a hard-coded catalogue of body plans the creature
// builder can materialise. A game spec never ships a full blueprint; it names a
// species by stable `id` (e.g. "human", "oak", "apple") and the engine looks it
// up here. This keeps the interchange format tiny and the geometry logic on the
// server/engine side (the AAC construction strategy: logic lives centrally, the
// client just displays).
//
// Blueprints are drawn from the worked examples (examples.ts) — the same curated
// body plans the seagull-dream lab exercised — but keyed by stable ids and
// tagged with a `kind` so callers know whether they're standing up a creature, a
// plant, or a fruit body. A game (or a future evolution simulator) can also add
// its own species at runtime via `registerSpecies`.
//
// PURE DATA + a clamp — no three.js. Safe to import anywhere.

import type { Blueprint } from "./blueprint";
import { clampBlueprint } from "./blueprint";
import { CREATURE_EXAMPLES } from "./examples";
import { ANIMAL_PEOPLE_BLUEPRINTS } from "./animals-people";
import { orchardPlants } from "../products";
import type { ItemWords } from "../interaction/lang/core.js";

/** "spark" is the PLAYER, and is deliberately not a body plan — see SPARK_SPECIES_ID. */
export type SpeciesKind = "creature" | "plant" | "fruit" | "spark";

export interface Species {
  /** Stable id a game spec references. */
  readonly id: string;
  /** Human-readable name (for menus/debug). */
  readonly name: string;
  readonly kind: SpeciesKind;
  /** BODILESS — this species has NO body to build: it renders as a light (the
   *  gaze spark), never a mesh. The creature builder must refuse to materialise
   *  it; its `blueprint` is empty and must not be clamped into a default body.
   *  The one species with this flag is the player's (SPARK_SPECIES_ID). */
  readonly bodiless?: boolean;
  /**
   * A WORD WITH NO BODY YET (the AAC vocabulary stub). The species is real —
   * it is an animal or a plant a sentence can name, and it carries its own
   * `words` — but no worked example backs it, so `blueprint` is EMPTY and
   * nothing may materialise it.
   *
   * Same contract as `bodiless`, a different reason: a spark has no body BY
   * NATURE, a stub has none YET. A stub graduates by gaining an `example` (and
   * losing this flag) the moment a body plan is authored; nothing else about
   * the row changes, so the word, the icon and the four translations a child
   * already has never move.
   *
   * Anything that materialises bodies must check this (or `bodiless`) before
   * clamping the empty blueprint into an accidental default body — a lion
   * would otherwise stand up in the world as a nameless quadruped.
   */
  readonly stub?: boolean;
  /** Partial blueprint record in the interchange format — passed through
   *  `clampBlueprint` (which fills every unset field) at build time. EMPTY and
   *  unusable when `bodiless` or `stub`. */
  readonly blueprint: Record<string, unknown>;
  /** Suggested uniform world scale. undefined = use the blueprint's natural
   *  size in meters (the builder authors real metric dimensions). */
  readonly scale?: number;
  /** ADULT COLLISION/PLANNING RADIUS in meters — THE body size of this
   *  species. Everything that reasons about girth reads it through
   *  `speciesBodyRadius`: locomotion collision, the indoor router's plan
   *  probe, stand-point insets, AND the town generator (a species builds its
   *  houses — walls, doors, halls, furniture lanes — for ITS OWN adult size;
   *  see kernel/town/rooms.ts houseMetricsFor). Never hard-code a body size
   *  elsewhere. undefined = DEFAULT_BODY_RADIUS_M (the people default —
   *  human_cute's capsule is exactly this wide). */
  readonly bodyRadiusM?: number;
  /** The species word's own lexemes, per locale (content/words.ts joiner),
   *  keyed under `id`. NOT `name` — `name` is a worked-example title
   *  ("Cow (straight horns)"), never a word a sentence can carry. */
  readonly words?: ItemWords;
}

/** The people default (human_cute's collision capsule). The FALLBACK when a
 *  species doesn't author `bodyRadiusM` — not a number to reach for directly:
 *  resolve a real species through `speciesBodyRadius` wherever one is known. */
export const DEFAULT_BODY_RADIUS_M = 0.4;

/** THE body-size resolver: the species' authored `bodyRadiusM`, else the
 *  people default. Tolerant of undefined/unknown ids (a mover with no species
 *  record moves at the default) — generation and routing must never throw on
 *  a species string, only size to it. */
export function speciesBodyRadius(id: string | undefined | null): number {
  if (!id) return DEFAULT_BODY_RADIUS_M;
  return REGISTRY.get(id)?.bodyRadiusM ?? DEFAULT_BODY_RADIUS_M;
}

// The curated catalogue: which worked example backs each stable id, plus its
// kind. Extend freely — a species only needs a stable id + a body plan. Hard
// species parameters (per the design note) live HERE, not in game specs.
// `example` is OPTIONAL: a row without one is a VOCABULARY STUB (Species.stub)
// — a plant or an animal the sentence builder can name before anyone has drawn
// it. Registry ORDER is the vocabulary's rank (vocab-order.ts walks it), so the
// stub blocks are authored most-frequently-said first, and new rows append
// rather than interleave.
const CATALOGUE: ReadonlyArray<{
  id: string;
  kind: SpeciesKind;
  example?: string;
  scale?: number;
  words?: ItemWords;
}> = [
  // ── People + animals ──────────────────────────────────────────────────────
  { id: "human", kind: "creature", example: "Human (biped + hands)" },
  { id: "quadruped", kind: "creature", example: "Quadruped (default)" },
  {
    id: "cow",
    kind: "creature",
    example: "Cow (straight horns)",
    words: {
      en: { w: "cow" },
      he: { w: "פרה", g: "f" },
      es: { w: "vaca", g: "f" },
      pt: { w: "vaca", g: "f" },
    },
  },
  {
    id: "deer",
    kind: "creature",
    example: "Deer (branching antlers)",
    words: {
      en: { w: "deer", plw: "deer" },
      he: { w: "צבי", g: "m" },
      es: { w: "ciervo", g: "m" },
      pt: { w: "cervo", g: "m" },
    },
  },
  {
    id: "ram",
    kind: "creature",
    example: "Ram (curled horns)",
    words: {
      en: { w: "ram" },
      he: { w: "איל", g: "m" },
      es: { w: "carnero", g: "m" },
      pt: { w: "carneiro", g: "m" },
    },
  },
  {
    id: "sheep",
    kind: "creature",
    example: "Sheep (woolly)",
    words: {
      en: { w: "sheep", plw: "sheep" },
      he: { w: "כבשה", g: "f" },
      es: { w: "oveja", g: "f" },
      pt: { w: "ovelha", g: "f" },
    },
  },
  { id: "ungulate", kind: "creature", example: "Ungulate (hooves)" },
  // The lab-tuned bodies. `dog` matters beyond the menu: it is a `friend` pool
  // WORD, so until now the one animal a child could most readily ask for had no
  // body plan behind it. Appended rather than interleaved — registry order is
  // stable data other derivations index against.
  {
    id: "elephant",
    kind: "creature",
    example: "Elephant (trunk)",
    words: {
      en: { w: "elephant" },
      he: { w: "פיל", g: "m" },
      es: { w: "elefante", g: "m" },
      pt: { w: "elefante", g: "m" },
    },
  },
  {
    id: "horse",
    kind: "creature",
    example: "Horse",
    words: {
      en: { w: "horse" },
      he: { w: "סוס", g: "m" },
      es: { w: "caballo", g: "m" },
      pt: { w: "cavalo", g: "m" },
    },
  },
  {
    id: "cat",
    kind: "creature",
    example: "Cat",
    words: {
      en: { w: "cat" },
      he: { w: "חתול", g: "m" },
      es: { w: "gato", g: "m" },
      pt: { w: "gato", g: "m" },
    },
  },
  {
    id: "dog",
    kind: "creature",
    example: "Dog",
    words: {
      en: { w: "dog" },
      he: { w: "כלב", g: "m" },
      es: { w: "perro", g: "m" },
      pt: { w: "cachorro", g: "m" },
    },
  },
  // ── Plants ────────────────────────────────────────────────────────────────
  { id: "oak", kind: "plant", example: "Oak (tree)" },
  {
    id: "grass",
    kind: "plant",
    example: "Grass tuft",
    words: {
      en: { w: "grass", mass: true },
      he: { w: "דשא", g: "m", mass: true },
      es: { w: "hierba", g: "f", mass: true },
      pt: { w: "grama", g: "f", mass: true },
    },
  },
  { id: "bush", kind: "plant", example: "Bush (berries)" },
  {
    id: "mushroom",
    kind: "plant",
    example: "Mushroom",
    words: {
      en: { w: "mushroom" },
      he: { w: "פטרייה", g: "f", plw: "פטריות" },
      es: { w: "seta", g: "f" },
      pt: { w: "cogumelo", g: "m" },
    },
  },
  { id: "saguaro", kind: "plant", example: "Saguaro (cactus)" },
  // Orchard plants — shoot growths that BEAR the fruit kinds below.
  { id: "apple_tree", kind: "plant", example: "Apple tree" },
  { id: "banana_plant", kind: "plant", example: "Banana plant" },
  { id: "grape_vine", kind: "plant", example: "Grape vine" },
  { id: "carrot_plant", kind: "plant", example: "Carrot plant" },
  // ── Fruit bodies (market/ground items) ────────────────────────────────────
  { id: "apple", kind: "fruit", example: "Apple" },
  { id: "banana", kind: "fruit", example: "Banana" },
  { id: "grape", kind: "fruit", example: "Grape" },
  { id: "pear", kind: "fruit", example: "Pear" },
  { id: "strawberry", kind: "fruit", example: "Strawberry" },
  { id: "pumpkin", kind: "fruit", example: "Pumpkin" },
  { id: "pineapple", kind: "fruit", example: "Pineapple" },
  { id: "carrot", kind: "fruit", example: "Carrot (root)" },
  { id: "beet", kind: "fruit", example: "Beet (root)" },
  // ── AAC VOCABULARY STUBS: ANIMALS (2026-08-27) ────────────────────────────
  //
  // Animals a child names long before the world can build one. Each is a real
  // species row — `isAnimal` files it, the sentence builder's [animals] chip
  // opens it, the four lexemes are authored — with NO worked example, so
  // `Species.stub` is set and nothing materialises a body. The one thing
  // missing is the body plan; adding an `example` here is all a graduation
  // takes, and the child's word never changes.
  //
  // ORDER IS RANK (vocab-order.ts walks this array): most-said first.
  {
    id: "fish",
    kind: "creature",
    words: {
      en: { w: "fish", plw: "fish" },
      he: { w: "דג", g: "m", plw: "דגים" },
      es: { w: "pez", g: "m", plw: "peces" },
      pt: { w: "peixe", g: "m" },
    },
  },
  {
    id: "duck",
    kind: "creature",
    words: {
      en: { w: "duck" },
      he: { w: "ברווז", g: "m" },
      es: { w: "pato", g: "m" },
      pt: { w: "pato", g: "m" },
    },
  },
  {
    id: "pig",
    kind: "creature",
    words: {
      en: { w: "pig" },
      he: { w: "חזיר", g: "m" },
      es: { w: "cerdo", g: "m" },
      pt: { w: "porco", g: "m" },
    },
  },
  {
    id: "lion",
    kind: "creature",
    words: {
      en: { w: "lion" },
      he: { w: "אריה", g: "m", plw: "אריות" },
      es: { w: "león", g: "m", plw: "leones" },
      pt: { w: "leão", g: "m", plw: "leões" },
    },
  },
  {
    id: "monkey",
    kind: "creature",
    words: {
      en: { w: "monkey" },
      he: { w: "קוף", g: "m" },
      es: { w: "mono", g: "m" },
      pt: { w: "macaco", g: "m" },
    },
  },
  {
    id: "butterfly",
    kind: "creature",
    words: {
      en: { w: "butterfly", plw: "butterflies" },
      he: { w: "פרפר", g: "m" },
      es: { w: "mariposa", g: "f" },
      pt: { w: "borboleta", g: "f" },
    },
  },
  {
    id: "turtle",
    kind: "creature",
    words: {
      en: { w: "turtle" },
      he: { w: "צב", g: "m" },
      es: { w: "tortuga", g: "f" },
      pt: { w: "tartaruga", g: "f" },
    },
  },
  {
    id: "snake",
    kind: "creature",
    words: {
      en: { w: "snake" },
      he: { w: "נחש", g: "m" },
      es: { w: "serpiente", g: "f" },
      pt: { w: "cobra", g: "f" },
    },
  },
  {
    id: "hen",
    kind: "creature",
    words: {
      en: { w: "hen" },
      he: { w: "תרנגולת", g: "f", plw: "תרנגולות" },
      es: { w: "gallina", g: "f" },
      pt: { w: "galinha", g: "f" },
    },
  },
  {
    id: "mouse",
    kind: "creature",
    words: {
      en: { w: "mouse", plw: "mice" },
      he: { w: "עכבר", g: "m" },
      es: { w: "ratón", g: "m", plw: "ratones" },
      pt: { w: "rato", g: "m" },
    },
  },
  {
    id: "tiger",
    kind: "creature",
    words: {
      en: { w: "tiger" },
      he: { w: "נמר", g: "m" },
      es: { w: "tigre", g: "m" },
      pt: { w: "tigre", g: "m" },
    },
  },
  {
    id: "bee",
    kind: "creature",
    words: {
      en: { w: "bee" },
      he: { w: "דבורה", g: "f", plw: "דבורים" },
      es: { w: "abeja", g: "f" },
      pt: { w: "abelha", g: "f" },
    },
  },
  {
    id: "goat",
    kind: "creature",
    words: {
      en: { w: "goat" },
      he: { w: "עז", g: "f", plw: "עיזים" },
      es: { w: "cabra", g: "f" },
      pt: { w: "cabra", g: "f" },
    },
  },
  {
    id: "owl",
    kind: "creature",
    words: {
      en: { w: "owl" },
      he: { w: "ינשוף", g: "m" },
      es: { w: "búho", g: "m" },
      pt: { w: "coruja", g: "f" },
    },
  },
  {
    id: "penguin",
    kind: "creature",
    words: {
      en: { w: "penguin" },
      he: { w: "פינגווין", g: "m" },
      es: { w: "pingüino", g: "m" },
      pt: { w: "pinguim", g: "m" },
    },
  },
  {
    id: "giraffe",
    kind: "creature",
    words: {
      en: { w: "giraffe" },
      he: { w: "ג'ירפה", g: "f" },
      es: { w: "jirafa", g: "f" },
      pt: { w: "girafa", g: "f" },
    },
  },
  {
    id: "zebra",
    kind: "creature",
    words: {
      en: { w: "zebra" },
      he: { w: "זברה", g: "f" },
      es: { w: "cebra", g: "f" },
      pt: { w: "zebra", g: "f" },
    },
  },
  {
    id: "panda",
    kind: "creature",
    words: {
      en: { w: "panda" },
      he: { w: "פנדה", g: "f" },
      es: { w: "panda", g: "m" },
      pt: { w: "panda", g: "m" },
    },
  },
  {
    id: "fox",
    kind: "creature",
    words: {
      en: { w: "fox", plw: "foxes" },
      he: { w: "שועל", g: "m" },
      es: { w: "zorro", g: "m" },
      pt: { w: "raposa", g: "f" },
    },
  },
  {
    id: "wolf",
    kind: "creature",
    words: {
      en: { w: "wolf", plw: "wolves" },
      he: { w: "זאב", g: "m", plw: "זאבים" },
      es: { w: "lobo", g: "m" },
      pt: { w: "lobo", g: "m" },
    },
  },
  {
    id: "squirrel",
    kind: "creature",
    words: {
      en: { w: "squirrel" },
      he: { w: "סנאי", g: "m" },
      es: { w: "ardilla", g: "f" },
      pt: { w: "esquilo", g: "m" },
    },
  },
  {
    id: "whale",
    kind: "creature",
    words: {
      en: { w: "whale" },
      he: { w: "לווייתן", g: "m" },
      es: { w: "ballena", g: "f" },
      pt: { w: "baleia", g: "f" },
    },
  },
  {
    id: "dolphin",
    kind: "creature",
    words: {
      en: { w: "dolphin" },
      he: { w: "דולפין", g: "m" },
      es: { w: "delfín", g: "m", plw: "delfines" },
      pt: { w: "golfinho", g: "m" },
    },
  },
  {
    id: "shark",
    kind: "creature",
    words: {
      en: { w: "shark" },
      he: { w: "כריש", g: "m" },
      es: { w: "tiburón", g: "m", plw: "tiburones" },
      pt: { w: "tubarão", g: "m", plw: "tubarões" },
    },
  },
  {
    id: "crab",
    kind: "creature",
    words: {
      en: { w: "crab" },
      he: { w: "סרטן", g: "m" },
      es: { w: "cangrejo", g: "m" },
      pt: { w: "caranguejo", g: "m" },
    },
  },
  {
    id: "octopus",
    kind: "creature",
    words: {
      en: { w: "octopus", plw: "octopuses" },
      he: { w: "תמנון", g: "m" },
      es: { w: "pulpo", g: "m" },
      pt: { w: "polvo", g: "m" },
    },
  },
  {
    id: "snail",
    kind: "creature",
    words: {
      en: { w: "snail" },
      he: { w: "חילזון", g: "m", plw: "חלזונות" },
      es: { w: "caracol", g: "m", plw: "caracoles" },
      pt: { w: "caracol", g: "m", plw: "caracóis" },
    },
  },
  {
    id: "spider",
    kind: "creature",
    words: {
      en: { w: "spider" },
      he: { w: "עכביש", g: "m" },
      es: { w: "araña", g: "f" },
      pt: { w: "aranha", g: "f" },
    },
  },
  {
    id: "ant",
    kind: "creature",
    words: {
      en: { w: "ant" },
      he: { w: "נמלה", g: "f", plw: "נמלים" },
      es: { w: "hormiga", g: "f" },
      pt: { w: "formiga", g: "f" },
    },
  },
  {
    id: "ladybug",
    kind: "creature",
    words: {
      en: { w: "ladybug" },
      he: { w: "פרת משה רבנו", g: "f" },
      es: { w: "mariquita", g: "f" },
      pt: { w: "joaninha", g: "f" },
    },
  },
  {
    id: "koala",
    kind: "creature",
    words: {
      en: { w: "koala" },
      he: { w: "קואלה", g: "f" },
      es: { w: "koala", g: "m" },
      pt: { w: "coala", g: "m" },
    },
  },
  {
    id: "kangaroo",
    kind: "creature",
    words: {
      en: { w: "kangaroo" },
      he: { w: "קנגורו", g: "m" },
      es: { w: "canguro", g: "m" },
      pt: { w: "canguru", g: "m" },
    },
  },
  {
    id: "camel",
    kind: "creature",
    words: {
      en: { w: "camel" },
      he: { w: "גמל", g: "m" },
      es: { w: "camello", g: "m" },
      pt: { w: "camelo", g: "m" },
    },
  },
  {
    id: "crocodile",
    kind: "creature",
    words: {
      en: { w: "crocodile" },
      he: { w: "תנין", g: "m" },
      es: { w: "cocodrilo", g: "m" },
      pt: { w: "crocodilo", g: "m" },
    },
  },
  {
    id: "lizard",
    kind: "creature",
    words: {
      en: { w: "lizard" },
      he: { w: "לטאה", g: "f" },
      es: { w: "lagarto", g: "m" },
      pt: { w: "lagarto", g: "m" },
    },
  },
  {
    id: "parrot",
    kind: "creature",
    words: {
      en: { w: "parrot" },
      he: { w: "תוכי", g: "m" },
      es: { w: "loro", g: "m" },
      pt: { w: "papagaio", g: "m" },
    },
  },
  {
    id: "gorilla",
    kind: "creature",
    words: {
      en: { w: "gorilla" },
      he: { w: "גורילה", g: "f" },
      es: { w: "gorila", g: "m" },
      pt: { w: "gorila", g: "m" },
    },
  },
  {
    id: "hippo",
    kind: "creature",
    words: {
      en: { w: "hippo" },
      he: { w: "היפופוטם", g: "m" },
      es: { w: "hipopótamo", g: "m" },
      pt: { w: "hipopótamo", g: "m" },
    },
  },
  {
    id: "rhino",
    kind: "creature",
    words: {
      en: { w: "rhino" },
      he: { w: "קרנף", g: "m" },
      es: { w: "rinoceronte", g: "m" },
      pt: { w: "rinoceronte", g: "m" },
    },
  },
  {
    id: "worm",
    kind: "creature",
    words: {
      en: { w: "worm" },
      he: { w: "תולעת", g: "f", plw: "תולעים" },
      es: { w: "gusano", g: "m" },
      pt: { w: "minhoca", g: "f" },
    },
  },
  {
    id: "dinosaur",
    kind: "creature",
    words: {
      en: { w: "dinosaur" },
      he: { w: "דינוזאור", g: "m" },
      es: { w: "dinosaurio", g: "m" },
      pt: { w: "dinossauro", g: "m" },
    },
  },

  // ── AAC VOCABULARY STUBS: PLANTS (2026-08-27) ─────────────────────────────
  //
  // The growing things, filed by the SAME registry that already knew about
  // oaks and mushrooms — `kind: "plant"` is what the builder's [plants] chip
  // reads. `tree` is the odd row: it is a plant with no body plan AND no words
  // here, because its four lexemes already live in `ITEM_WORDS` (one
  // definition per head — the joiner's law). The row exists purely so the
  // word a child already had gets filed as the plant it is.
  { id: "tree", kind: "plant" },
  {
    id: "flower",
    kind: "plant",
    words: {
      en: { w: "flower" },
      he: { w: "פרח", g: "m", plw: "פרחים" },
      es: { w: "flor", g: "f", plw: "flores" },
      pt: { w: "flor", g: "f", plw: "flores" },
    },
  },
  {
    id: "leaf",
    kind: "plant",
    words: {
      en: { w: "leaf", plw: "leaves" },
      he: { w: "עלה", g: "m", plw: "עלים" },
      es: { w: "hoja", g: "f" },
      pt: { w: "folha", g: "f" },
    },
  },
  {
    id: "rose",
    kind: "plant",
    words: {
      en: { w: "rose" },
      he: { w: "ורד", g: "m", plw: "ורדים" },
      es: { w: "rosa", g: "f" },
      pt: { w: "rosa", g: "f" },
    },
  },
  {
    id: "sunflower",
    kind: "plant",
    words: {
      en: { w: "sunflower" },
      he: { w: "חמנייה", g: "f", plw: "חמניות" },
      es: { w: "girasol", g: "m", plw: "girasoles" },
      pt: { w: "girassol", g: "m", plw: "girassóis" },
    },
  },
  {
    id: "tulip",
    kind: "plant",
    words: {
      en: { w: "tulip" },
      he: { w: "צבעוני", g: "m" },
      es: { w: "tulipán", g: "m", plw: "tulipanes" },
      pt: { w: "tulipa", g: "f" },
    },
  },
  {
    id: "daisy",
    kind: "plant",
    words: {
      en: { w: "daisy", plw: "daisies" },
      he: { w: "חיננית", g: "f" },
      es: { w: "margarita", g: "f" },
      pt: { w: "margarida", g: "f" },
    },
  },
  {
    id: "cactus",
    kind: "plant",
    words: {
      en: { w: "cactus", plw: "cacti" },
      he: { w: "קקטוס", g: "m" },
      es: { w: "cactus", g: "m", plw: "cactus" },
      pt: { w: "cacto", g: "m" },
    },
  },
  {
    id: "pine_tree",
    kind: "plant",
    words: {
      en: { w: "pine tree" },
      he: { w: "אורן", g: "m" },
      es: { w: "pino", g: "m" },
      pt: { w: "pinheiro", g: "m" },
    },
  },
  {
    id: "palm_tree",
    kind: "plant",
    words: {
      en: { w: "palm tree" },
      he: { w: "דקל", g: "m" },
      es: { w: "palmera", g: "f" },
      pt: { w: "palmeira", g: "f" },
    },
  },
  {
    id: "seedling",
    kind: "plant",
    words: {
      en: { w: "seedling" },
      he: { w: "שתיל", g: "m" },
      es: { w: "brote", g: "m" },
      pt: { w: "broto", g: "m" },
    },
  },
];

function exampleBlueprint(name: string): Record<string, unknown> {
  const ex = CREATURE_EXAMPLES.find((e) => e.name === name);
  if (!ex) {
    // Fail fast at module load: a renamed example would otherwise silently drop
    // a species from the registry.
    throw new Error(`species: no worked example named "${name}"`);
  }
  return ex.blueprint;
}

/** THE PLAYER'S SPECIES. The player is a SPARK, not one of the people who live
 *  in the world: it is its own kind of entity — it can talk to creatures with no
 *  body at all (spirit mode), and when it CLAIMS a creature it does not become
 *  that creature, it drives it. Giving it a real species makes that distinction
 *  a type rather than a convention (it was previously implicit: the player
 *  creature was seeded bare and told apart by ~90 `id === "player"` string
 *  compares, which reads as "species not set yet" rather than "not a human").
 *
 *  BODILESS: there is no blueprint here on purpose. A spark is drawn as a
 *  floating light beside the body it claims — never built as a mesh. Anything
 *  that materialises bodies must check `bodiless` (or `kind !== "creature"`)
 *  before clamping the empty blueprint into an accidental default body. */
export const SPARK_SPECIES_ID = "spark";

const REGISTRY = new Map<string, Species>();
REGISTRY.set(SPARK_SPECIES_ID, {
  id: SPARK_SPECIES_ID,
  name: "Spark (the player)",
  kind: "spark",
  bodiless: true,
  blueprint: {},
});
for (const entry of CATALOGUE) {
  // NO WORKED EXAMPLE ⇒ a vocabulary stub: the word is real, the body is not
  // drawn yet. `blueprint` stays empty (never clamped into a default body) and
  // `name` falls back to the id, since a stub has no worked-example title.
  const stub = entry.example === undefined;
  REGISTRY.set(entry.id, {
    id: entry.id,
    name: entry.example ?? entry.id,
    kind: entry.kind,
    ...(stub ? { stub: true } : {}),
    blueprint: stub ? {} : exampleBlueprint(entry.example!),
    scale: entry.scale,
    words: entry.words,
  });
}

// PEOPLE species authored in the lab (animals-people.ts): human_cute (the main
// species now), the tuned "human" (kept for later), and the animal-people
// (bear/frog/dog/rabbit) that stand in for animal puzzle characters. These are
// full blueprints keyed by their own `name`; they OVERRIDE any same-named
// example so the lab-authored body plan wins.
for (const bp of ANIMAL_PEOPLE_BLUEPRINTS) {
  const id = typeof bp.name === "string" ? bp.name : null;
  if (!id) continue;
  // The people are the design species — their size is AUTHORED here (the
  // 0.4 m capsule the whole town-metric arithmetic historically assumed),
  // not inherited from the fallback.
  REGISTRY.set(id, { id, name: id, kind: "creature", blueprint: bp, bodyRadiusM: DEFAULT_BODY_RADIUS_M });
}

// ── Orchards ────────────────────────────────────────────────────────────────

/** Fruit kinds towns grow in orchards. These names match glyph vocabulary
 *  (they have translations) AND double as the fruit-BODY species ids the
 *  market/ground items use, so `requireSpecies(entry.fruit)` always works. */
export type OrchardFruit = "apple" | "banana" | "grape";

/** Which plant species yields each orchard fruit kind. DERIVED from the
 *  natural-sources registry (products.ts) — the plant's harvest food product
 *  IS this mapping, so the town layer and the registry can never disagree.
 *  `species` is the plant to plant (kind "plant", bears visible fruit via
 *  its growth), `fruit` is the kind it yields. */
export const FRUIT_TREES: ReadonlyArray<{ fruit: OrchardFruit; species: string }> =
  orchardPlants().map((r) => ({ fruit: r.fruit as OrchardFruit, species: r.species }));

/** Look up a species by id, or undefined if unknown. */
export function getSpecies(id: string): Species | undefined {
  return REGISTRY.get(id);
}

/** Look up a species by id; throws if unknown (a game spec that names a species
 *  the engine doesn't know is a certification error, not a runtime fallback). */
export function requireSpecies(id: string): Species {
  const s = REGISTRY.get(id);
  if (!s) throw new Error(`species: unknown id "${id}"`);
  return s;
}

/** Every registered species (menus, tests, tooling). */
export function listSpecies(): Species[] {
  return [...REGISTRY.values()];
}

/** All ids of a given kind — e.g. every fruit body, for a market generator. */
export function speciesOfKind(kind: SpeciesKind): Species[] {
  return listSpecies().filter((s) => s.kind === kind);
}

/** Add (or override) a species at runtime — a game or the evolution simulator
 *  contributing its own body plans. */
export function registerSpecies(species: Species): void {
  REGISTRY.set(species.id, species);
}

/** The clamped, ready-to-build blueprint for a species id. */
export function speciesBlueprint(id: string): Blueprint {
  return clampBlueprint(requireSpecies(id).blueprint);
}
