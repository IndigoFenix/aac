// shared/world-engine/object-properties.ts
//
// THE OBJECT PROPERTY VOCABULARY (world-engine-board-organization.md §4) — the
// ONE tag set that serves BOTH the simulation and the sentence board.
//
// These are PROPERTIES, not categories (user framing): a thing HAS several of
// them rather than belonging to one. A refrigerator is `container` AND
// `openable` AND `appliance` AND `device` AND `furniture`; a cabinet is
// `container` + `openable` + `furniture`; a lamp is just a `device`. The
// board's "things" sub-tabs are property FILTERS ("show everything openable"),
// and the verb pre-load (§3.1) reads the same vocabulary from the verb side
// ("`open` wants something openable"). One vocabulary, two uses.
//
// AUTHORITY (user law): concrete-noun properties are IMPORTED FROM THE SPEC
// SIDE — the station registry, the goods kinds, the pools. The board never
// authors its own parallel list; `interaction/content/properties.ts` is the
// joiner that reads the specs. Nouns hard-coded as CORE ENGINE CONCEPTS
// (room, building, animal, city, water…) are exempt: they have no spec and
// need none — they aren't objects with functions, they're the frame objects
// sit inside. `CORE_CONCEPTS` names them so a conformance test can hold the
// line: every OTHER surfaced noun must carry spec-derived properties.
//
// Zero imports by design — the kernel's station registry may `import type`
// from here without inverting its layering.

export type ObjectProperty =
  /** Holds other things — a storage station, `designatedContainerFor` target. */
  | "container"
  /** Has an open/shut state (the station `openable` flag). */
  | "openable"
  /** Has an on/off power state. */
  | "device"
  /** A station that TRANSFORMS what is brought to it (oven cooks, bench crafts). */
  | "appliance"
  /** Serving props — bowl, cup, plate, fork, knife, spoon. */
  | "tableware"
  /** A placed station: the room's built-in stuff. */
  | "furniture"
  /** Edible (goods FOOD/TREAT/MEAL kinds, the `food` category). */
  | "food"
  /** Drinkable (the `drink` category — water, milk, juice). A CATEGORY OF ITS
   *  OWN rather than a kind of food: `eat` and `drink` are different requests
   *  and must open different boards. */
  | "drink"
  /** Wearable/washable (goods CLOTHING kinds, the `clothing` category). */
  | "clothing"
  /** Affords `play` — the fun need's target ([[feedback_needs_bind_to_affordances]]). */
  | "toy"
  /** Played to make sound (the `instrument` category). */
  | "instrument"
  /** Read (the `book` category). */
  | "book"
  /** A building material — the site/yard stock a structure is raised from. */
  | "material"
  /** A raisable structure (the build catalog's specs). */
  | "structure";

/** Display order for the board's sub-tab row (§3) — most-used first, the
 *  container family adjacent so their shared art motif reads as a group. */
export const OBJECT_PROPERTIES: readonly ObjectProperty[] = [
  "food",
  "drink",
  "toy",
  "clothing",
  "container",
  "openable",
  "furniture",
  "appliance",
  "device",
  "tableware",
  "instrument",
  "book",
  "material",
  "structure",
];

/**
 * THE CATEGORIES A CHILD ASKS FOR BY NAME (user decision 2026-08-24). "I want
 * food", "I want a toy" are first-page sentences — often the RIGHT sentence,
 * because a child who cannot yet find the apple can still say what kind of
 * thing they mean and let the adult narrow it.
 *
 * So a desire board offers these as WORDS, and leaves the specific items to the
 * group chips and to the child's own habit. The rest of the property vocabulary
 * is not wantable in this way: nobody asks for "an openable", and `furniture`
 * or `appliance` name what a room contains rather than what a person wants.
 *
 * Every one is already a lang-layer word (the group chips wear them), so this
 * costs no new vocabulary.
 */
export const WANTABLE_PROPERTIES: readonly ObjectProperty[] = [
  "food",
  "drink",
  "toy",
  "clothing",
  "book",
];

const PROPERTY_SET: ReadonlySet<string> = new Set(OBJECT_PROPERTIES);

export const isObjectProperty = (s: string): s is ObjectProperty => PROPERTY_SET.has(s);

/**
 * THE VERB PRE-LOAD TABLE (§3.1) — the object property a verb wants, so the
 * board can open the right sub-tab BEFORE the student drills for it ("eat" →
 * the food group is already open). Read from the verb side of the same
 * vocabulary; context-BLIND (a fixed table, never a scene query), which is
 * what keeps the sentence builder predictable.
 *
 * Lives here rather than in the surfacer because both boards and the goal-tree
 * player read it, and because it is data ABOUT properties.
 */
export const PROPERTY_FOR_VERB: Readonly<Record<string, ObjectProperty>> = {
  eat: "food",
  // DRINK OPENS DRINKS, not the fruit bowl (2026-08-24). The two verbs used to
  // share one property, so "I want to drink" answered with apples and bananas.
  drink: "drink",
  cook: "food",
  heat: "food",
  wear: "clothing",
  wash: "clothing",
  play: "toy",
  open: "openable",
  shut: "openable",
  // THE PUT FAMILY all imply "in" (the LEXICON says so for all three), so all
  // three ask the same question — what does it go INTO — and the board opens on
  // the same group. `drop` is no weaker a placement than `put`: "drop the ball
  // in the box" is the sentence a child reaches for when the toy is in hand.
  put: "container",
  drop: "container",
  throw: "container",
  build: "structure",
  // THE RESTING POSES take a STATION, not a thing: you sit on a chair, sleep in
  // a bed, rest on a bench. The furniture IS the argument (compileAction binds
  // it as the `rest` goal's place), so the board opens on it — the same rule as
  // "eat → food", read for a verb whose object happens to be a piece of the room.
  sit: "furniture",
  sleep: "furniture",
  rest: "furniture",
};

/**
 * A CLASS OF NOUN, named from either side of the one vocabulary: an object
 * PROPERTY (what a thing is for), a noun KIND (what sort of thing it is), or the
 * one DERIVED class the property vocabulary cannot express —
 *
 *   `ownable` — anything a hand can hold and a person can own: an item that is
 *   neither the furniture of a room nor a raised structure. Derived rather than
 *   authored, because ownership is not a property a spec declares; it is what is
 *   left when the fixtures are taken out.
 */
export type NounClass = ObjectProperty | "creature" | "place" | "item" | "ownable";

/**
 * WHAT A VERB'S OBJECT CAN BE, best class first (user table, 2026-08-24).
 *
 * `PROPERTY_FOR_VERB` above answers a narrower question — which single group
 * CHIP a verb pre-opens — and answers it well; this answers the one the board
 * actually asks: given this verb, which nouns should the grid offer and in what
 * order. A verb with no row here falls back to its `PROPERTY_FOR_VERB` property,
 * so the two tables never state the same fact twice.
 *
 * Tiers RANK, they never filter: the universal band still offers every noun
 * underneath, so no composition is ever blocked by a classification the library
 * happened not to carry. Keyed by the CANONICAL verb, so a family shares a row.
 *
 * A tier that would mean "everything else" is NEVER written: that is the
 * universal band's job, and writing it out crowds the tiers BELOW it off the
 * board — with a wide library, an `item` tier is fifty-odd nouns and nothing
 * under it is ever reached.
 *
 * `toilet` is not here because it is not a verb: "I need the toilet" is a whole
 * sentence with a noun object (user decision 2026-08-25). `help` is here, but
 * only with its creature half — see the note on that row.
 */
export const VERB_OBJECT_CLASSES: Readonly<Record<string, readonly (readonly NounClass[])[]>> = {
  // Things changing hands: what moves is what a hand can hold, never the room.
  get: [["ownable"]],
  give: [["ownable"]],
  trade: [["ownable"]],
  carry: [["ownable"]],
  bring: [["ownable"]],
  // THE PUT FAMILY's object is the thing being placed — a ball, not a box. The
  // box is its DESTINATION, and `PROPERTY_FOR_VERB` still says so for that slot.
  put: [["ownable"]],
  drop: [["ownable"]],
  throw: [["ownable"]],
  // Making and unmaking: both verbs offer both lists, differing in which leads
  // (the make-vs-build law) — and what you break is as often a thing as a wall.
  make: [["ownable"], ["structure"]],
  build: [["structure"], ["ownable"]],
  break: [["structure"], ["ownable"]],
  fix: [["structure"], ["ownable"]],
  // USING takes a station: the thing you operate is the thing that has a job.
  // (`STATION_ACTS` is what says which job, and intent-compile borrows it.)
  use: [["appliance", "device"], ["furniture"]],
  // Looking takes anything there is: a person, a thing, or a place.
  see: [["creature"], ["place"]],
  // Doing things WITH people.
  help: [["creature"]],
  hug: [["creature"]],
  talk: [["creature"]],
  show: [["creature"]],
  teach: [["creature"]],
  share: [["creature"]],
  follow: [["creature"]],
  fight: [["creature"]],
  // Playing is with a toy, or with somebody.
  play: [["toy"], ["creature"]],
  // Filling and emptying want something that holds.
  fill: [["container", "tableware"]],
  empty: [["container", "tableware"]],
};

// ---------------------------------------------------------------------------
// Descriptor axes — WHICH descriptors fit WHICH things
// ---------------------------------------------------------------------------
//
// The words used to describe food are not the words used to describe
// buildings. An AXIS is a semantic dimension (temperature, fill, mood…)
// grouping the descriptor vocabulary; properties and kinds BIND axes, and a
// noun's axes rank its modifier rail, its attribute continuations, and the
// condition vocabulary. Same shape as PROPERTY_FOR_VERB: fixed data about the
// property vocabulary, context-blind by construction.
//
// SCOPE-BREADTH RULE (user law): applicability follows what the GAME models,
// never real-life plausibility. Places take `possession` at every scale ("my
// room" and "my city" alike — territory is a core mechanic), and settlements
// are need-bearing entities (the city HUD tracks hunger/wellbeing), so place
// nouns carry the mood/bodily axes exactly as creatures do — "city + hungry"
// is a famine report, not a category error. The family↔civilization analogy
// lives in this data, not in scripted exceptions.

export type DescriptorAxis =
  | "possession" // my / your
  | "bodily" // hungry, thirsty, tired, sick — the need axes
  | "mood" // happy, sad, bored, lonely
  | "temperature" // hot / cold / warm
  | "cleanliness" // clean / dirty
  | "size" // big / small / long / short…
  | "age" // new / old
  | "integrity" // broken
  | "fill" // full / empty
  | "quantity" // more / many / counts
  | "quality" // good / bad
  /**
   * COLOUR — the eleven `color_*` words (2026-09-04).
   *
   * ⚖️ DELIBERATELY BOUND TO NOTHING. It is absent from `AXES_FOR_KIND` and
   * `AXES_FOR_PROPERTY` on purpose, so `descriptorAxesFor` never returns it and
   * no colour ever reaches the item MODIFIER RAIL: the rail is capped at eight
   * words, eleven colours would be the whole of it, and the board already has a
   * palette picker for colouring a slot. The axis exists so that the colour
   * vocabulary has ONE owner — the [colors] chip on the Descriptions tab reads
   * it, `axisOf` answers "red and blue are the same question", and the builder
   * lexicon validator can see all eleven words.
   */
  | "color";

/** The descriptor vocabulary of each axis. A superset across the two
 *  descriptor stores — the parser LEXICON's attribute/quantity words AND the
 *  glyph registry's modifier keys (my/your, empty…) — consumers filter to
 *  whichever vocabulary they draw from. */
export const AXIS_WORDS: Readonly<Record<DescriptorAxis, readonly string[]>> = {
  possession: ["my", "your"],
  // `hurt` is a report about the BODY, not a mood — it belongs beside hungry and
  // sick, and a creature that says "I am hurt" is saying where it needs help.
  bodily: ["hungry", "thirsty", "tired", "sick", "full", "hurt"],
  // The whole feelings vocabulary the AAC board draws (2026-09-04). The first
  // four led the axis before the other six were parseable at all, and they keep
  // the lead: the rail is capped, and "happy / sad" is what a rail is for.
  mood: ["happy", "sad", "bored", "lonely", "angry", "scared", "excited", "surprised", "proud", "calm"],
  temperature: ["hot", "cold", "warm"],
  cleanliness: ["dirty", "clean"],
  size: ["big", "small", "long", "short", "tall", "wide", "thin"],
  age: ["new", "old"],
  integrity: ["broken"],
  fill: ["full", "empty", "some", "none"],
  quantity: ["more", "many", "one", "two", "three", "all", "less", "none"],
  quality: ["good", "bad"],
  // The registry's own palette order (`colorModifiersFor`), so the [colors] chip
  // and the slot picker present the same eleven in the same sequence.
  color: [
    "color_red", "color_orange", "color_yellow", "color_green", "color_blue",
    "color_purple", "color_pink", "color_brown", "color_black", "color_white", "color_gray",
  ],
};

/**
 * WHICH AXIS A DESCRIPTOR BELONGS TO — the reverse of `AXIS_WORDS`, and the one
 * owner of that question.
 *
 * It exists because an axis is MUTUALLY EXCLUSIVE by nature: a thing cannot be
 * hot and cold, or one and three. A builder that lets two words from the same
 * axis land on the same head composes a sentence nobody means ("a hot cold
 * apple"), so every surface that applies a descriptor needs to be able to ask
 * this — and none of them should carry its own copy of the table.
 *
 * A word may appear under two axes (`none` is both fill and quantity, `full`
 * both bodily and fill). First match wins, in declaration order, so the answer
 * is deterministic; exclusivity within the winning axis is still the useful
 * reading.
 */
const AXIS_OF_WORD: ReadonlyMap<string, DescriptorAxis> = (() => {
  const m = new Map<string, DescriptorAxis>();
  for (const axis of Object.keys(AXIS_WORDS) as DescriptorAxis[]) {
    for (const w of AXIS_WORDS[axis]) if (!m.has(w)) m.set(w, axis);
  }
  return m;
})();

/** The axis `word` belongs to, or null when it is not a descriptor at all. */
export function axisOf(word: string): DescriptorAxis | null {
  return AXIS_OF_WORD.get(word.trim().toLowerCase()) ?? null;
}

/** Verbs whose natural continuation is a DESCRIPTOR list rather than a noun —
 *  the §3.1 pre-load read for the attribute side: "feel" implies an emotion
 *  ("i_me + feel + happy"), never a thing. Same fixed-table contract as
 *  PROPERTY_FOR_VERB; extend here when a new verb implies a word list. */
export const DESCRIPTOR_AXES_FOR_VERB: Readonly<Record<string, readonly DescriptorAxis[]>> = {
  feel: ["bodily", "mood"],
};

/** The axes a PROPERTY switches on, most relevant first — food talks about
 *  temperature and amount, clothing about cleanliness, containers about fill. */
export const AXES_FOR_PROPERTY: Readonly<Record<ObjectProperty, readonly DescriptorAxis[]>> = {
  food: ["temperature", "quantity", "quality", "size"],
  // A drink is hot or cold before it is anything else, and the cup it comes in
  // is full or empty — the fill axis belongs to the drink, not just the vessel.
  drink: ["temperature", "quantity", "fill", "quality"],
  toy: ["possession", "quality", "integrity", "age"],
  clothing: ["cleanliness", "possession", "age", "quality"],
  container: ["fill", "possession", "size"],
  openable: ["fill"],
  furniture: ["possession", "size", "integrity", "age"],
  appliance: ["integrity", "temperature"],
  device: ["integrity", "quality"],
  tableware: ["cleanliness", "fill"],
  instrument: ["possession", "quality"],
  book: ["possession", "quality", "age"],
  material: ["quantity", "size"],
  structure: ["possession", "size", "age", "integrity"],
};

/** Kind-level fallback/extension — how you describe a THING of that kind when
 *  no property says otherwise. Core-concept places (town, city, area) have no
 *  spec properties by law, so this tier is what gives them descriptors at all:
 *  possession first ("my city"), then the need axes (settlements feel hunger). */
export const AXES_FOR_KIND: Readonly<
  Record<"creature" | "place" | "item" | "unknown", readonly DescriptorAxis[]>
> = {
  creature: ["bodily", "mood", "possession", "size", "quality"],
  place: ["possession", "size", "bodily", "mood", "fill", "age"],
  item: ["possession", "size", "quality", "quantity"],
  unknown: ["possession", "quality"],
};

/** A noun's descriptor axes, most relevant first: its properties' axes (in
 *  property order), then its kind's. Pure; unknown kinds fall back safely. */
export function descriptorAxesFor(
  kind: "creature" | "place" | "item" | "unknown",
  properties: readonly string[],
): DescriptorAxis[] {
  const out: DescriptorAxis[] = [];
  const push = (a: DescriptorAxis) => {
    if (!out.includes(a)) out.push(a);
  };
  for (const p of properties) {
    if (isObjectProperty(p)) for (const a of AXES_FOR_PROPERTY[p]) push(a);
  }
  for (const a of AXES_FOR_KIND[kind] ?? AXES_FOR_KIND.unknown) push(a);
  return out;
}

/** The ranked descriptor words for a noun — its axes flattened, deduped. */
export function descriptorsFor(
  kind: "creature" | "place" | "item" | "unknown",
  properties: readonly string[],
): string[] {
  const out: string[] = [];
  for (const a of descriptorAxesFor(kind, properties)) {
    for (const w of AXIS_WORDS[a]) if (!out.includes(w)) out.push(w);
  }
  return out;
}

/**
 * CORE ENGINE CONCEPTS (user law) — nouns hard-coded into the engine itself
 * rather than authored in a spec: the frame things exist inside (places,
 * kinship, substances). They are speakable and they need NO spec entry and no
 * object properties. Everything else that reaches the board is a concrete
 * noun and must derive its properties from the spec side.
 */
/**
 * THE PEOPLE A CHILD NAMES (2026-08-24) — the kinship and role frame words.
 *
 * Core concepts like the rest of that set: a mother is not an object with a
 * spec row, and no registry will ever define one. Named as their own group
 * because the sentence board needs to know WHICH core concepts are people —
 * they are the only nouns its spec walk cannot find, and a board with no word
 * for a mother is not a board a child can talk to.
 *
 * The student's OWN people arrive separately, as named creatures from the
 * people directory; these are the generic words that stand when it is empty and
 * beside it when it is not.
 */
export const CORE_PEOPLE: readonly string[] = [
  // In priority order, which is the order they surface in (L1): the people a
  // child asks for first, then the ones they describe.
  "mom", "dad", "teacher", "friend", "baby", "girl", "boy",
];

export const CORE_CONCEPTS: ReadonlySet<string> = new Set([
  // Places / territory (the named STRUCTURES — market, farm — are spec'd, and
  // carry `structure`; these are the frame words the engine itself owns).
  "place", "area", "room", "building", "house", "home", "yard", "town", "city",
  "street", "bathroom", "outside", "world",
  // Living-thing frame words (specific creatures come from the species specs)
  "animal", "person", "people", "family", "child",
  ...CORE_PEOPLE,
  // Substances the simulation models directly rather than as stack goods
  "water", "fire",
]);
