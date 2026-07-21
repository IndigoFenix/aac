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
  /** Partial blueprint record in the interchange format — passed through
   *  `clampBlueprint` (which fills every unset field) at build time. EMPTY and
   *  unusable when `bodiless`. */
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
const CATALOGUE: ReadonlyArray<{ id: string; kind: SpeciesKind; example: string; scale?: number }> = [
  // ── People + animals ──────────────────────────────────────────────────────
  { id: "human", kind: "creature", example: "Human (biped + hands)" },
  { id: "quadruped", kind: "creature", example: "Quadruped (default)" },
  { id: "cow", kind: "creature", example: "Cow (straight horns)" },
  { id: "deer", kind: "creature", example: "Deer (branching antlers)" },
  { id: "ram", kind: "creature", example: "Ram (curled horns)" },
  { id: "sheep", kind: "creature", example: "Sheep (woolly)" },
  { id: "ungulate", kind: "creature", example: "Ungulate (hooves)" },
  // ── Plants ────────────────────────────────────────────────────────────────
  { id: "oak", kind: "plant", example: "Oak (tree)" },
  { id: "grass", kind: "plant", example: "Grass tuft" },
  { id: "bush", kind: "plant", example: "Bush (berries)" },
  { id: "mushroom", kind: "plant", example: "Mushroom" },
  { id: "saguaro", kind: "plant", example: "Saguaro (cactus)" },
  // Orchard plants — shoot growths that BEAR the fruit kinds below.
  { id: "apple_tree", kind: "plant", example: "Apple tree" },
  { id: "banana_plant", kind: "plant", example: "Banana plant" },
  { id: "grape_vine", kind: "plant", example: "Grape vine" },
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
  REGISTRY.set(entry.id, {
    id: entry.id,
    name: entry.example,
    kind: entry.kind,
    blueprint: exampleBlueprint(entry.example),
    scale: entry.scale,
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

/** Which plant species yields each orchard fruit kind. The town layer places
 *  orchards from this: `species` is the plant to plant (kind "plant", bears
 *  visible fruit via its growth), `fruit` is the kind it yields. */
export const FRUIT_TREES: ReadonlyArray<{ fruit: OrchardFruit; species: string }> = [
  { fruit: "apple", species: "apple_tree" },
  { fruit: "banana", species: "banana_plant" },
  { fruit: "grape", species: "grape_vine" },
];

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
