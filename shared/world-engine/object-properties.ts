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
  put: "container",
  throw: "container",
  build: "structure",
};

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
