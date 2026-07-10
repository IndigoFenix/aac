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

export type SpeciesKind = "creature" | "plant" | "fruit";

export interface Species {
  /** Stable id a game spec references. */
  readonly id: string;
  /** Human-readable name (for menus/debug). */
  readonly name: string;
  readonly kind: SpeciesKind;
  /** Partial blueprint record in the interchange format — passed through
   *  `clampBlueprint` (which fills every unset field) at build time. */
  readonly blueprint: Record<string, unknown>;
  /** Suggested uniform world scale. undefined = use the blueprint's natural
   *  size in meters (the builder authors real metric dimensions). */
  readonly scale?: number;
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
  { id: "ungulate", kind: "creature", example: "Ungulate (hooves)" },
  // ── Plants ────────────────────────────────────────────────────────────────
  { id: "oak", kind: "plant", example: "Oak (tree)" },
  { id: "grass", kind: "plant", example: "Grass tuft" },
  { id: "bush", kind: "plant", example: "Bush (berries)" },
  { id: "mushroom", kind: "plant", example: "Mushroom" },
  { id: "saguaro", kind: "plant", example: "Saguaro (cactus)" },
  // ── Fruit bodies (market/ground items) ────────────────────────────────────
  { id: "apple", kind: "fruit", example: "Apple" },
  { id: "banana", kind: "fruit", example: "Banana" },
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

const REGISTRY = new Map<string, Species>();
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
  REGISTRY.set(id, { id, name: id, kind: "creature", blueprint: bp });
}

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
