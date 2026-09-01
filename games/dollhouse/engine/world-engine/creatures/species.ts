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
// body plans the seagull-dream lab exercised — and joined to these rows by the
// SPECIES ID they carry, then tagged with a `kind` so callers know whether
// they're standing up a creature, a plant, or a fruit body. A game (or a future
// evolution simulator) can also add its own species at runtime via
// `registerSpecies`.
//
// ONE LIST (2026-08-30). The join used to be by the example's DISPLAY TITLE
// ("Crocodile (long jaw)"), which made this registry and examples.ts two
// catalogues kept in step by hand — and they weren't: six fully authored bodies
// (snake, fish, crocodile, spider, crab, octopus) sat unreachable in examples.ts
// while the same six words were stubs here. The id IS the join now, and the
// orphan check under the registry build makes the merge permanent: a worked
// example no row claims throws at module load, so a body can never again be
// authored into a file the world cannot reach.
//
// PURE DATA + a clamp — no three.js. Safe to import anywhere.

import type { Blueprint } from "./blueprint";
import { clampBlueprint } from "./blueprint";
import { CREATURE_EXAMPLES } from "./examples";
import { ANIMAL_PEOPLE_BLUEPRINTS } from "./animals-people";
import { LAB_BLUEPRINTS } from "./lab-blueprints";
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
   * NATURE, a stub has none YET. A stub graduates the moment an examples.ts
   * entry is authored UNDER ITS ID — this flag is derived from that, never
   * hand-set — and nothing else about the row changes, so the word, the icon
   * and the four translations a child already has never move.
   *
   * Anything that materialises bodies must check this (or `bodiless`) before
   * clamping the empty blueprint into an accidental default body — a lion
   * would otherwise stand up in the world as a nameless quadruped.
   */
  readonly stub?: boolean;
  /**
   * SAPIENT — this species uses the VERBAL system (animal-expansion.md: *"the
   * core difference between a sapient species and an animal species is the
   * canSpeak tag"*). A creature without it communicates in icons and gesture;
   * it is somebody you can go to, follow and play with, never somebody you
   * greet by name or ask for help.
   *
   * ⚠️ ABSENT MEANS FALSE, and that is the safe default: a species row nobody
   * has classified is an animal, so a newly-authored body cannot accidentally
   * arrive able to talk. The people species set it explicitly.
   *
   * Read it through `speciesCanSpeak`, which is tolerant of unknown ids.
   */
  readonly canSpeak?: boolean;
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
   *  `human`'s capsule is exactly this wide). */
  readonly bodyRadiusM?: number;
  /** The species word's own lexemes, per locale (content/words.ts joiner),
   *  keyed under `id`. NOT `name` — `name` is a worked-example title
   *  ("Cow (straight horns)"), never a word a sentence can carry.
   *
   *  ABSENT MEANS "a body the world builds, not a word a child says": the
   *  sentence builder skips a species with no `words` (builder-surface.ts), so
   *  `quadruped`, `ungulate` and the palaeo body plans stay off the animals tab
   *  while still being buildable by id. */
  readonly words?: ItemWords;
}

/** The people default (the `human` collision capsule). The FALLBACK when a
 *  species doesn't author `bodyRadiusM` — not a number to reach for directly:
 *  resolve a real species through `speciesBodyRadius` wherever one is known. */
export const DEFAULT_BODY_RADIUS_M = 0.4;

/** THE body-size resolver: the species' authored `bodyRadiusM`, else the
 *  people default. Tolerant of undefined/unknown ids (a mover with no species
 *  record moves at the default) — generation and routing must never throw on
 *  a species string, only size to it. */
export function speciesBodyRadius(id: string | undefined | null): number {
  if (!id) return DEFAULT_BODY_RADIUS_M;
  return getSpecies(id)?.bodyRadiusM ?? DEFAULT_BODY_RADIUS_M;
}

/** THE SAPIENCE RESOLVER: does this species use the verbal system? Tolerant
 *  of undefined/unknown ids (an unclassified body is an animal) — nothing
 *  that asks "can this one talk?" may throw on a species string. */
export function speciesCanSpeak(id: string | undefined | null): boolean {
  if (!id) return false;
  return getSpecies(id)?.canSpeak === true;
}

// The curated catalogue: every stable id the engine knows, plus its kind. Hard
// species parameters (per the design note) live HERE, not in game specs.
//
// A row names NO blueprint: the body plan is whatever examples.ts authors under
// the SAME id. A row with no such example is a VOCABULARY STUB (Species.stub) —
// a plant or an animal the sentence builder can name before anyone has drawn it
// — and that is derived below, never declared here, so the two files cannot
// disagree about which words have bodies.
//
// Registry ORDER is the vocabulary's rank (vocab-order.ts walks it), so the
// blocks are authored most-frequently-said first, and new rows append rather
// than interleave.
const CATALOGUE: ReadonlyArray<{
  id: string;
  kind: SpeciesKind;
  scale?: number;
  words?: ItemWords;
}> = [
  // ── People + animals ──────────────────────────────────────────────────────
  // `human`'s example is a worked biped; the LAB-AUTHORED human in
  // animals-people.ts supersedes it below (see the override loop) — the example
  // stays reachable so the creature lab can still show the plain body plan.
  { id: "human", kind: "creature" },
  { id: "quadruped", kind: "creature" },
  {
    id: "cow",
    kind: "creature",
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
    words: {
      en: { w: "sheep", plw: "sheep" },
      he: { w: "כבשה", g: "f" },
      es: { w: "oveja", g: "f" },
      pt: { w: "ovelha", g: "f" },
    },
  },
  { id: "ungulate", kind: "creature" },
  // The lab-tuned bodies. `dog` matters beyond the menu: it is a `friend` pool
  // WORD, so until now the one animal a child could most readily ask for had no
  // body plan behind it. Appended rather than interleaved — registry order is
  // stable data other derivations index against.
  {
    id: "elephant",
    kind: "creature",
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
    words: {
      en: { w: "dog" },
      he: { w: "כלב", g: "m" },
      es: { w: "perro", g: "m" },
      pt: { w: "cachorro", g: "m" },
    },
  },
  // ── Plants ────────────────────────────────────────────────────────────────
  { id: "oak", kind: "plant" },
  {
    id: "grass",
    kind: "plant",
    words: {
      en: { w: "grass", mass: true },
      he: { w: "דשא", g: "m", mass: true },
      es: { w: "hierba", g: "f", mass: true },
      pt: { w: "grama", g: "f", mass: true },
    },
  },
  { id: "bush", kind: "plant" },
  {
    id: "mushroom",
    kind: "plant",
    words: {
      en: { w: "mushroom" },
      he: { w: "פטרייה", g: "f", plw: "פטריות" },
      es: { w: "seta", g: "f" },
      pt: { w: "cogumelo", g: "m" },
    },
  },
  { id: "saguaro", kind: "plant" },
  // Orchard plants — shoot growths that BEAR the fruit kinds below.
  { id: "apple_tree", kind: "plant" },
  { id: "banana_plant", kind: "plant" },
  { id: "grape_vine", kind: "plant" },
  { id: "carrot_plant", kind: "plant" },
  // ── Fruit bodies (market/ground items) ────────────────────────────────────
  { id: "apple", kind: "fruit" },
  { id: "banana", kind: "fruit" },
  { id: "grape", kind: "fruit" },
  { id: "pear", kind: "fruit" },
  { id: "strawberry", kind: "fruit" },
  { id: "pumpkin", kind: "fruit" },
  { id: "pineapple", kind: "fruit" },
  { id: "carrot", kind: "fruit" },
  { id: "beet", kind: "fruit" },
  // ── AAC ANIMAL VOCABULARY (2026-08-27) ────────────────────────────────────
  //
  // Animals a child names long before the world can build one. Each is a real
  // species row — `isAnimal` files it, the sentence builder's [animals] chip
  // opens it, the four lexemes are authored. Most have no examples.ts entry
  // under the same id, so `Species.stub` is derived and nothing materialises a
  // body; authoring an example with the SAME ID is all a graduation takes, and
  // the child's word never changes.
  //
  // Six graduated that way on 2026-08-30 without touching this block at all —
  // `fish`, `snake`, `crocodile`, `spider`, `crab`, `octopus` had bodies waiting
  // in examples.ts the whole time, unreachable only because the join was by
  // title. That is the merge working: the word, the icon and the translations
  // stayed exactly where they were.
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

  // ── THE MERGE: examples that had no row (2026-08-30) ──────────────────────
  //
  // Nine worked body plans lived in examples.ts with nothing in this registry
  // naming them, so nothing in the world could ever build one. Appended, not
  // interleaved — registry order is vocabulary rank, and these are the newest
  // words, not the most-said ones.
  //
  // ALL SIX ARE BOARD WORDS: each carries `words`, so the [animals] chip opens
  // it and `shared/glyph-registry.ts` gives it a picture and eleven
  // translations. (Three wordless body plans — raptor, dimetrodon, plesiosaur
  // — were briefly here too; the user removed them 2026-09-01. ONE list means
  // an entry nobody can say does not earn a row.)
  {
    id: "beetle",
    kind: "creature",
    words: {
      en: { w: "beetle" },
      he: { w: "חיפושית", g: "f", plw: "חיפושיות" },
      es: { w: "escarabajo", g: "m" },
      pt: { w: "besouro", g: "m" },
    },
  },
  {
    id: "jellyfish",
    kind: "creature",
    words: {
      en: { w: "jellyfish", plw: "jellyfish" },
      he: { w: "מדוזה", g: "f" },
      es: { w: "medusa", g: "f" },
      pt: { w: "água-viva", g: "f", plw: "águas-vivas" },
    },
  },
  {
    id: "stingray",
    kind: "creature",
    words: {
      en: { w: "stingray" },
      he: { w: "טריגון", g: "m" },
      es: { w: "raya", g: "f" },
      pt: { w: "arraia", g: "f" },
    },
  },
  {
    id: "centipede",
    kind: "creature",
    words: {
      en: { w: "centipede" },
      he: { w: "נדל", g: "m" },
      es: { w: "ciempiés", g: "m", plw: "ciempiés" },
      pt: { w: "centopeia", g: "f" },
    },
  },
  {
    id: "wasp",
    kind: "creature",
    words: {
      en: { w: "wasp" },
      he: { w: "צרעה", g: "f", plw: "צרעות" },
      es: { w: "avispa", g: "f" },
      pt: { w: "vespa", g: "f" },
    },
  },
  {
    id: "mantis",
    kind: "creature",
    words: {
      en: { w: "mantis", plw: "mantises" },
      he: { w: "גמל שלמה", g: "m" },
      es: { w: "mantis", g: "f", plw: "mantis" },
      pt: { w: "louva-a-deus", g: "m", plw: "louva-a-deus" },
    },
  },
  // 🐻🐸🐰 BASES FOR THE ANIMAL PEOPLE. `bear`, `frog` and `rabbit` were board
  // words with NO species row — the only reason nobody noticed is that each had
  // a hand-authored `*_person` body standing in for it. Retiring those bodies
  // (2026-09-01) left the `animal_people` mod with nothing to derive from, so
  // those three characters would have vanished silently. Stubs, like every
  // other word whose body is not drawn yet.
  //
  // 🚨 NO `words` HERE ON PURPOSE. `content/pools.ts` already defines all three,
  // and a head may have exactly ONE spec word source — adding them again is the
  // duplicate the `lexicon-spec-words` no-overlap pin exists to catch. These
  // rows exist to be DERIVED FROM, not to say anything new.
  { id: "bear", kind: "creature" },
  { id: "frog", kind: "creature" },
  { id: "rabbit", kind: "creature" },
];

/** THE JOIN: worked example by SPECIES ID. Built once, and duplicate-checked —
 *  two examples claiming one id means one of the bodies is silently dead, which
 *  is precisely the failure mode the title-keyed lookup used to hide. */
const EXAMPLE_BY_ID: ReadonlyMap<string, { title: string; blueprint: Record<string, unknown> }> =
  (() => {
    const m = new Map<string, { title: string; blueprint: Record<string, unknown> }>();
    for (const ex of CREATURE_EXAMPLES) {
      if (m.has(ex.id)) {
        throw new Error(
          `species: two worked examples claim id "${ex.id}" ("${m.get(ex.id)!.title}", "${ex.title}")`,
        );
      }
      m.set(ex.id, { title: ex.title, blueprint: ex.blueprint });
    }
    return m;
  })();

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
  // NO WORKED EXAMPLE UNDER THIS ID ⇒ a vocabulary stub: the word is real, the
  // body is not drawn yet. `blueprint` stays empty (never clamped into a default
  // body) and `name` falls back to the id, since a stub has no example title.
  const ex = EXAMPLE_BY_ID.get(entry.id);
  REGISTRY.set(entry.id, {
    id: entry.id,
    name: ex?.title ?? entry.id,
    kind: entry.kind,
    ...(ex ? {} : { stub: true }),
    blueprint: ex?.blueprint ?? {},
    scale: entry.scale,
    words: entry.words,
  });
}

// THE MERGE INVARIANT, checked at module load in the OTHER direction: every
// worked example must be claimed by a registry row. Without this the two lists
// drift apart exactly the way they did before — a fully authored body sitting in
// examples.ts that nothing in the world can ever build, and no error anywhere.
// (The first direction — a row with no example — is legitimate: that is a stub.)
{
  const orphans = [...EXAMPLE_BY_ID.entries()]
    .filter(([id]) => !REGISTRY.has(id))
    .map(([id, ex]) => `${id} ("${ex.title}")`);
  if (orphans.length > 0) {
    throw new Error(
      `species: worked example(s) with no registry row: ${orphans.join(", ")} — ` +
        "add a CATALOGUE row with that id (append; registry order is vocabulary rank)",
    );
  }
}

// PEOPLE species authored in the lab (animals-people.ts): the tuned "human"
// (THE people species since `human_cute` was retired into the `cute` creature
// mod) and the hand-drawn animal-people (bear/frog/dog/rabbit) that stand in
// for animal puzzle characters. These are full blueprints keyed by their own
// `name`, which IS a species id; they OVERRIDE the CATALOGUE row written just
// above so the lab-authored body plan wins. That ordering is load-bearing for
// two ids in particular: `human` and `dog` each have a worked example AND an
// authored people body, and the people body is the one the world stands up. The
// example stays reachable in the lab — it is the same id, one layer down.
//
// EVERY ROW HERE SPEAKS. This list IS the people, so `canSpeak` is set from
// membership rather than repeated per row — the four animal-people are the
// authored ancestors of what the `animal_people` mod now generates, and a
// generated row never displaces an authored one.
for (const bp of ANIMAL_PEOPLE_BLUEPRINTS) {
  const id = typeof bp.name === "string" ? bp.name : null;
  if (!id) continue;
  // The people are the design species — their size is AUTHORED here (the
  // 0.4 m capsule the whole town-metric arithmetic historically assumed),
  // not inherited from the fallback.
  REGISTRY.set(id, {
    id, name: id, kind: "creature", canSpeak: true,
    blueprint: bp, bodyRadiusM: DEFAULT_BODY_RADIUS_M,
  });
}

// Bodies currently being TUNED IN THE LAB (lab-blueprints.ts, machine-written)
// win over everything above, so what the lab shows is what the game builds
// without a round trip through the hand-authored sources. Normally empty.
for (const bp of LAB_BLUEPRINTS) {
  const id = typeof bp.name === "string" ? bp.name : null;
  if (!id) continue;
  const prior = REGISTRY.get(id);
  REGISTRY.set(id, prior
    ? { ...prior, blueprint: bp, stub: undefined }
    : { id, name: id, kind: "creature", blueprint: bp, bodyRadiusM: DEFAULT_BODY_RADIUS_M });
}

// ⚖️ NO `FRUIT_TREES` / `OrchardFruit` HERE. There was a hand-written
// `OrchardFruit = "apple" | "banana" | "grape"` union and a `FRUIT_TREES`
// constant that re-derived products.ts's own answer through an unchecked
// `as OrchardFruit` cast. It had no runtime consumer at all — only tests —
// and the cast meant the union could go stale without anything failing to
// compile, which is exactly what happened when `carrot_plant` joined the
// catalogue and the engine grew a fruit tree that was neither.
//
// Ask the registry that owns the fact instead: `foodPlants()` in products.ts
// is the property query, and its `species` ids resolve here.

/**
 * RETIRED IDS that must still resolve. A species id is written into stored
 * world documents (`avatar_species`), saved games and spec JSON, so retiring
 * one cannot be a delete — `requireSpecies` throws by design, and a world that
 * loaded fine yesterday would refuse to open.
 *
 * `human_cute` (retired 2026-08-29) was `human` with one field changed; that
 * re-skin is now the `cute` creature mod. An alias is NOT a registry row: it
 * never appears in `listSpecies()`, so menus, vocabulary and validators see
 * the retirement immediately, while old documents keep loading.
 */
const ALIASES: ReadonlyMap<string, string> = new Map([["human_cute", "human"]]);

/** Look up a species by id, or undefined if unknown. Resolves retired ids. */
export function getSpecies(id: string): Species | undefined {
  return REGISTRY.get(id) ?? REGISTRY.get(ALIASES.get(id) ?? "");
}

/** Look up a species by id; throws if unknown (a game spec that names a species
 *  the engine doesn't know is a certification error, not a runtime fallback). */
export function requireSpecies(id: string): Species {
  const s = getSpecies(id);
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

/** Drop a runtime-registered species. Returns whether anything was removed.
 *
 *  ⚠️ ONLY for rows a caller registered ITSELF — world-mods.ts uses it to
 *  retract the species a mod derived when that mod is switched off (the
 *  creature lab flips them constantly). Nothing may use it to delete an
 *  authored row: the catalogue is the engine's, not a session's. */
export function unregisterSpecies(id: string): boolean {
  return REGISTRY.delete(id);
}

/** The clamped, ready-to-build blueprint for a species id — the AUTHORED
 *  body, before any world appearance mod. The build path applies those at its
 *  own door (creature-model.ts `dressedBlueprint`); a caller that wants to SEE
 *  the modded body asks `applyAppearanceMods` for it. */
export function speciesBlueprint(id: string): Blueprint {
  return clampBlueprint(requireSpecies(id).blueprint);
}
