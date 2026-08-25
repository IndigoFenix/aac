// shared/world-engine/interaction/content/properties.ts
//
// THE PROPERTY JOINER (world-engine-board-organization.md §3-§4): given a noun
// SYMBOL, what is it? Answers with the object properties defined in
// object-properties.ts, READ FROM THE SPEC SIDE (user law) — the station
// registry, the goods kinds, the curriculum pools. Nothing is authored here
// that a spec already knows; this module only joins.
//
// Same shape as concepts.ts (a bridge, not a unification): the specs stay
// authoritative for their own facets. Where two sources speak, properties
// UNION — a refrigerator is furniture+container from the station registry and
// openable from the station row's flag, all at once. Pure, deterministic,
// context-blind: the sentence builder's whole predictability rests on this
// being a fixed function of the registry, never of the scene.
//
// CORE ENGINE CONCEPTS (room, building, animal, water…) legitimately have no
// spec and no properties — see CORE_CONCEPTS. `unpropertiedNouns` is the
// conformance helper that keeps every OTHER noun honest.

import {
  CORE_CONCEPTS,
  isObjectProperty,
  OBJECT_PROPERTIES,
  type ObjectProperty,
} from "../../object-properties.js";
import { headOf } from "../../variations.js";
import { fixtureKindForWord } from "../../types.js";
import {
  FURNITURE_ITEMS,
  STATION_PROPERTIES,
  furnitureKindOfGlyph,
  type StationKind,
} from "../../kernel/town/stations.js";
import { DEFAULT_WORKSTATION_REGISTRY } from "../../kernel/town/workstations.js";
import {
  CLOTHING_HEADS,
  FOOD_KINDS,
  isLaundryGlyph,
  MEAL_KINDS,
  TREAT_KINDS,
} from "../../kernel/town/goods-kinds.js";
import { KIND_CATEGORY, POOLS } from "./pools.js";
import { isDollGlyph } from "../../toys.js";
import { getSpecies } from "../../creatures/species.js";
import type { AffordanceTag } from "../types.js";

/** Station kinds whose rows carry `openable: true` anywhere in the registries —
 *  DERIVED, so the board's "openable" sub-tab and the mechanic that opens the
 *  lid can never drift apart. */
const OPENABLE_KINDS: ReadonlySet<StationKind> = new Set<StationKind>([
  // The registry already unions house + work rows and their `kindByGood`
  // models (the pantry's refrigerator IS the goods chest row, so its lid
  // opens for the same reason the chest's does).
  ...DEFAULT_WORKSTATION_REGISTRY.openableKinds,
  ...FURNITURE_ITEMS.filter((f) => f.openable).map((f) => f.kind),
]);

/** The GOODS a category word names (the stack vocabulary's own keys). */
const GOOD_KEY_PROPERTIES: Readonly<Record<string, ObjectProperty>> = {
  food: "food",
  meal: "food",
  clothing: "clothing",
  laundry: "clothing",
};

/** Which property a curriculum POOL's affordance implies (pools.ts is the
 *  spec side for the taught vocabulary, exactly as stations.ts is for the
 *  built world). Affordances with no object property are simply absent. */
const AFFORDANCE_PROPERTIES: Partial<Record<AffordanceTag, readonly ObjectProperty[]>> = {
  container: ["container", "openable"],
  openable: ["container", "openable"],
  toggleable: ["device"],
  // §4's toy row is "affords `play`" — and repeatable-effect IS the play
  // affordance (bubbles, sparks, a drum: things you make happen for the fun
  // of it). Same rule the fun need binds to, read as a property.
  "repeatable-effect": ["toy"],
};

/** Which property a KIND_CATEGORY tag implies. */
const CATEGORY_PROPERTIES: Readonly<Record<string, ObjectProperty>> = {
  food: "food",
  // A drink is not a food (2026-08-24): `eat` and `drink` are different asks and
  // open different boards, so the category the pools file tags a milk with has
  // to arrive as its own property.
  drink: "drink",
  toy: "toy",
  clothing: "clothing",
  tableware: "tableware",
  material: "material",
  instrument: "instrument",
  book: "book",
};

const head = headOf;

/**
 * Every object property of a noun symbol, in OBJECT_PROPERTIES order (stable
 * board ordering). Empty for core engine concepts and for anything with no
 * spec — callers decide whether that is legitimate (`CORE_CONCEPTS`) or a gap.
 * Facets are ignored: `shirt.dirty` is as much clothing as `shirt`.
 */
export function propertiesOf(symbol: string): ObjectProperty[] {
  const h = head(symbol);
  const out = new Set<ObjectProperty>();

  // 1. STATIONS — the built world's registry (bare kind, or a `furn.` stack).
  // The board speaks the VOCABULARY's word, which for a couple of kinds isn't
  // the kind's own name ("cabinet" is a `cupboard`), so fold the word back to
  // its kind first — otherwise the very noun the builder offers reads as
  // propertyless and loses its container/openable affordances.
  const kind = (furnitureKindOfGlyph(h) ?? fixtureKindForWord(h)) as StationKind;
  const station = STATION_PROPERTIES[kind];
  if (station) {
    for (const p of station) out.add(p);
    if (OPENABLE_KINDS.has(kind)) out.add("openable");
  }

  // 2. GOODS — the stack vocabulary (kinds and the category words naming them).
  const good = GOOD_KEY_PROPERTIES[h];
  if (good) out.add(good);
  if (FOOD_KINDS.includes(h) || TREAT_KINDS.includes(h)) out.add("food");
  if (MEAL_KINDS.includes(symbol) || MEAL_KINDS.includes(h)) out.add("food");
  if (CLOTHING_HEADS.includes(h) || isLaundryGlyph(symbol)) out.add("clothing");

  // 3. POOLS + the shared category map — the taught vocabulary's spec.
  for (const pool of Object.values(POOLS)) {
    if (!pool.members.some((m) => m.symbol === h)) continue;
    for (const p of AFFORDANCE_PROPERTIES[pool.affordance] ?? []) out.add(p);
  }
  const cat = CATEGORY_PROPERTIES[KIND_CATEGORY[h] ?? ""];
  if (cat) out.add(cat);

  // 4. THE DOLL FACET — a glyph wearing `toy` IS a toy, whatever its head
  // (world-engine/toys.ts). This has to be read off the FACET rather than the
  // head, because a doll's head names the thing it depicts: `rabbit.toy` heads
  // to `rabbit`, which every rule above correctly reports is a live animal. The
  // facet is what makes it a plaything, and the fun need selects on exactly this
  // (`affords: "play"` ← the `toy` property), so without this arm a child's doll
  // would be invisible to the motive it exists to serve.
  if (isDollGlyph(symbol)) out.add("toy");

  return OBJECT_PROPERTIES.filter((p) => out.has(p));
}

/** Does this noun carry the property? (The board's sub-tab filter, and the
 *  verb pre-load's test — one predicate for both.) */
export const hasProperty = (symbol: string, property: ObjectProperty): boolean =>
  propertiesOf(symbol).includes(property);

/** A LIVING thing — filed by its SPECIES spec (or the receptive-npc pool),
 *  never by object properties: creatures are who you talk to, not what you
 *  put in a cupboard. The board gives them the person tab. */
export function isLivingThing(symbol: string): boolean {
  // A DOLL IS NOT ALIVE, however alive its head word is. `rabbit.toy` heads to a
  // creature species, so without this the board would file a toy rabbit under
  // people and the sim would offer to talk to it.
  if (isDollGlyph(symbol)) return false;
  const h = head(symbol);
  if (getSpecies(h)?.kind === "creature") return true;
  return Object.values(POOLS).some(
    (p) => p.affordance === "receptive-npc" && p.members.some((m) => m.symbol === h),
  );
}

/**
 * AN ANIMAL, not a person (user, 2026-08-25). Both are BODIES — the engine's
 * `creature` kind is right about that, and a dog is somebody you can go to,
 * follow and play with. But an animal is not somebody you GREET by name, ask
 * for help, or address in a crowd, and the board had no way to tell: the
 * `friend` pool's `receptive-npc` affordance made `bear`, `rabbit` and `frog`
 * people outright — a fossil of the edition whose townsfolk WERE animal people
 * (the `bear_person` / `frog_person` species are the other half of it) — so a
 * frog stood in every band that means "somebody".
 *
 * Read off the two registries that know: a SPECIES the world builds, or a
 * member of the animal pool. A name the host pushes (`mara`) is neither, and is
 * therefore a person — which is the right default for a creature nobody has
 * classified.
 */
export function isAnimal(symbol: string): boolean {
  const h = head(symbol);
  if (getSpecies(h)?.kind === "creature") return true;
  return Object.values(POOLS).some(
    (p) => p.affordance === "receptive-npc" && p.members.some((m) => m.symbol === h),
  );
}

/**
 * THE CONFORMANCE HELPER (user law: concrete nouns get their properties from
 * the spec side): of the given noun symbols, which are neither core engine
 * concepts, nor living things, nor spec-derived? Each one is a thing the board
 * can surface but cannot FILE — i.e. a missing spec entry, not a missing tab.
 */
export function unpropertiedNouns(symbols: Iterable<string>): string[] {
  const out: string[] = [];
  for (const s of symbols) {
    const h = head(s);
    if (CORE_CONCEPTS.has(h) || isLivingThing(h) || propertiesOf(h).length) continue;
    if (!out.includes(h)) out.push(h);
  }
  return out.sort();
}

/** Re-exported so consumers need one import for the whole property surface. */
export { CORE_CONCEPTS, OBJECT_PROPERTIES, isObjectProperty, type ObjectProperty };
