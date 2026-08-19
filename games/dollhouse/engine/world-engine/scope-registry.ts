/**
 * scope-registry.ts — THE ONE TABLE: scope → its `world` descriptor + gate.
 *
 * The scope ladder (`GAME_SCOPES`) is just "which kind of object sits at the
 * root". Each rung's `world` object is described by ONE `GroupSpec` descriptor
 * (spec-schema.ts) that drives all of: validation (`parseWorldForScope`), the
 * world-lab form (fields + dropdowns), and the parameter docs. The per-scope
 * `parse*World` functions in the builder files delegate to the SAME descriptor,
 * so there is a single source of truth — no drift between what a scope accepts,
 * what the form offers, and what the docs say.
 *
 * This is the parse/registry layer of the unified constructor (see
 * project_scope_object_vacuum_law). Two scopes that had no shared gate before —
 * `structure` and `star_cluster` — get their descriptors here (promoted from
 * the world-lab's ad-hoc `bootStructure` coercion and the un-validated space
 * routing). `build` and per-scope focus resolution stay in the builder files
 * for now; this table unifies the DECLARATION of every scope's parameters.
 */
import { GAME_SCOPES, type GameScope } from "./kernel/manifest";
import { validateFields, type GroupSpec } from "./kernel/spec-schema";
import { GALAXY_WORLD_FIELDS, SOLAR_WORLD_FIELDS } from "./space/space-game";
import { PLANET_WORLD_FIELDS } from "./planet/planet-game";
import { REGION_WORLD_FIELDS } from "./kernel/civ/region-game";
import { TOWN_WORLD_FIELDS } from "./interaction/town/town-play-game";

// ── The two scopes that had no shared gate until now ─────────────────────────

/** The STRUCTURE scope's `world` descriptor — the standalone creature-quest
 *  puzzle (a house/village) or, with `wilderness`, the found-a-new-site flow.
 *  Promoted from the world-lab's `bootStructure` numOf() coercion into a real,
 *  reject-unknown gate. */
export const STRUCTURE_WORLD_FIELDS: GroupSpec = {
  objectMessage: "expected an object (the structure definition)",
  fields: [
    { key: "seed", kind: "number", min: 0, max: Number.MAX_SAFE_INTEGER, default: 1,
      facet: "boundary", ui: "seed", label: "Seed" },
    { key: "questCount", kind: "int", min: 0, max: 3, default: 0, facet: "interior",
      label: "Quests", description: "Creature-quest givers (0..3)." },
    { key: "wilderness", kind: "boolean", default: false, facet: "boundary",
      label: "Wilderness", description: "Found a new site in open country instead of a fixed puzzle." },
    { key: "side", kind: "number", min: 16, max: 4096, default: 240, facet: "boundary",
      label: "Site size", description: "Wilderness plot side length (only used when wilderness)." },
    { key: "layout", kind: "enum",
      options: [{ value: "house", label: "House" }, { value: "village", label: "Village" }],
      facet: "interior", label: "Layout", description: "Fixed-puzzle layout (only used when not wilderness)." },
  ],
};

/** The STAR_CLUSTER scope's `world` descriptor — a neighbourhood of systems
 *  between solar_system and galaxy. Mirrors the galaxy/solar seed shape.
 *  `questCount` DELETED (Shape B ruling 3): quests are declarable on the
 *  town|structure scopes only; the strict gate rejects it here as unknown. */
export const STAR_CLUSTER_WORLD_FIELDS: GroupSpec = {
  objectMessage: "expected an object (the star-cluster definition)",
  fields: [
    { key: "seed", kind: "number", min: 0, max: Number.MAX_SAFE_INTEGER, default: 1,
      facet: "boundary", ui: "seed", label: "Seed" },
  ],
};

// ── The registry ─────────────────────────────────────────────────────────────

export interface ScopeSpec {
  scope: GameScope;
  /** Human label for the form's scope dropdown. */
  label: string;
  /** One source of truth: validation + form controls + docs for this scope's
   *  `world` object. */
  worldFields: GroupSpec;
  /** Gate an unknown `world` object → a validated, defaulted plain object.
   *  Identical to the builder file's own `parse*World` (both call
   *  `validateFields` on `worldFields`). */
  parseWorld(raw: unknown, path: string): Record<string, unknown>;
}

function entry(scope: GameScope, label: string, worldFields: GroupSpec): ScopeSpec {
  return {
    scope,
    label,
    worldFields,
    parseWorld: (raw, path) => validateFields(raw, worldFields, path),
  };
}

/** scope → its spec. Keyed by every rung of `GAME_SCOPES`. */
export const SCOPE_SPECS: Record<GameScope, ScopeSpec> = {
  structure: entry("structure", "Structure", STRUCTURE_WORLD_FIELDS),
  town: entry("town", "Town", TOWN_WORLD_FIELDS),
  region: entry("region", "Region", REGION_WORLD_FIELDS),
  planet: entry("planet", "Planet", PLANET_WORLD_FIELDS),
  solar_system: entry("solar_system", "Solar system", SOLAR_WORLD_FIELDS),
  star_cluster: entry("star_cluster", "Star cluster", STAR_CLUSTER_WORLD_FIELDS),
  galaxy: entry("galaxy", "Galaxy", GALAXY_WORLD_FIELDS),
};

/** The scopes in ladder order (small → large) with their specs — the form's
 *  dropdown source. */
export const SCOPE_SPEC_LIST: readonly ScopeSpec[] = GAME_SCOPES.map((s) => SCOPE_SPECS[s]);

/** Validate a `world` object against the scope that owns it. */
export function parseWorldForScope(scope: GameScope, raw: unknown, path: string): Record<string, unknown> {
  return SCOPE_SPECS[scope].parseWorld(raw, path);
}
