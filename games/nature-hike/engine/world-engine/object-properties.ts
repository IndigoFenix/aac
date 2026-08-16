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
  drink: "food",
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
  | "quality"; // good / bad

/** The descriptor vocabulary of each axis. A superset across the two
 *  descriptor stores — the parser LEXICON's attribute/quantity words AND the
 *  glyph registry's modifier keys (my/your, empty…) — consumers filter to
 *  whichever vocabulary they draw from. */
export const AXIS_WORDS: Readonly<Record<DescriptorAxis, readonly string[]>> = {
  possession: ["my", "your"],
  bodily: ["hungry", "thirsty", "tired", "sick", "full"],
  mood: ["happy", "sad", "bored", "lonely"],
  temperature: ["hot", "cold", "warm"],
  cleanliness: ["dirty", "clean"],
  size: ["big", "small", "long", "short", "tall", "wide", "thin"],
  age: ["new", "old"],
  integrity: ["broken"],
  fill: ["full", "empty", "some", "none"],
  quantity: ["more", "many", "one", "two", "three", "all", "less", "none"],
  quality: ["good", "bad"],
};

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
export const CORE_CONCEPTS: ReadonlySet<string> = new Set([
  // Places / territory (the named STRUCTURES — market, farm — are spec'd, and
  // carry `structure`; these are the frame words the engine itself owns).
  "place", "area", "room", "building", "house", "home", "yard", "town", "city",
  "street", "bathroom", "outside", "world",
  // Living-thing frame words (specific creatures come from the species specs)
  "animal", "person", "people", "family", "baby", "child", "friend",
  // Substances the simulation models directly rather than as stack goods
  "water", "fire",
]);
