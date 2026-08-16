/**
 * object-def.ts — the ONE recursive authoring node (project_scope_object_vacuum
 * _law). Everything the LLM or the form produces is a tree of these:
 *
 *   ObjectDef { kind, params, where, contains, focus }
 *
 * `kind` picks the object type (a scope on the ladder, or a creature / item /
 * house); `params` are that kind's typed fields (validated against its
 * descriptor — the SAME `SCOPE_SPECS` the world gate uses); `where` are intent
 * constraints (vocab lands in a later increment); `contains` nests sub-objects;
 * `focus` marks the initial view. One uniform node, one resolution rule:
 *
 *   • ROOT is GENERATED from its params (a scope built in a vacuum);
 *   • a CONTAINED node is resolved against its parent — and inherits its
 *     BOUNDARY fields from that parent (a nested town's seed comes from its
 *     site), so contained nodes RELAX the `required` on boundary-facet fields
 *     that a root would demand. That relaxation is this file's concrete
 *     expression of "same constructor, vacuum vs context".
 *
 * `lowerObjectDef` compiles a tree down to the existing `aivota-world` document
 * envelope, so the recursive grammar runs today on the engine built in steps
 * 1–3 — no runtime rewrite. (This increment lowers the scope-root and the
 * town → structure → creature/item "dollhouse" shapes; deeper nested-scope
 * focus lowering follows.)
 */
import { validateFields, type FieldSpec, type GroupSpec } from "./kernel/spec-schema";
import { type GameScope } from "./kernel/manifest";
import { SCOPE_SPECS } from "./scope-registry";
import { PLANET_WORLD_FIELDS } from "./planet/planet-game";

export interface ObjectDef {
  kind: string;
  /** The kind's typed fields (validated against its descriptor). */
  params?: Record<string, unknown>;
  /** Intent constraints — dual-use (bias generation / score selection). The
   *  per-kind vocabulary lands in a later increment; parsed as an opaque array
   *  for now so trees round-trip. */
  where?: unknown[];
  /** Nested sub-objects. */
  contains?: ObjectDef[];
  /** The initial view (at most one node in the tree). */
  focus?: boolean;
  /** Which of THIS node's child-kinds are defined EXHAUSTIVELY: the parent
   *  generates NONE of that kind, only the listed children (mode "all"). A
   *  child-kind not listed is additive — defined ones overlay, the parent still
   *  generates its own (mode "some"). This is the per-group "exhaustive" flag. */
  exhaustive?: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

// ── Non-scope kind descriptors (the entities that live inside worlds) ────────

/** A creature/person: the focused household's members at town scope (fields
 *  mirror the town builder's `parseTownEntities`). */
export const CREATURE_FIELDS: readonly FieldSpec[] = [
  { key: "name", kind: "string", facet: "interior", label: "Name" },
  { key: "species", kind: "string", facet: "interior", label: "Species" },
  { key: "outfit", kind: "int", min: 0, max: 99, facet: "interior", label: "Outfit" },
  { key: "likes", kind: "list", item: { key: "like", kind: "string" }, facet: "interior", label: "Likes" },
  { key: "pet", kind: "boolean", facet: "interior", label: "Pet" },
];

/** An item placed in a house: `{ glyph, at }`. */
export const ITEM_FIELDS: readonly FieldSpec[] = [
  { key: "glyph", kind: "string", required: true, facet: "interior", label: "Glyph" },
  { key: "at", kind: "enum",
    options: [{ value: "table", label: "Table" }, { value: "box", label: "Box" }, { value: "floor", label: "Floor" }],
    default: "floor", facet: "boundary", label: "At" },
];

/** Where a structure sits in its town: `index` picks which building (omitted =
 *  the roomiest). A boundary — the town supplies the lot. */
const STRUCTURE_PLACEMENT: FieldSpec = { key: "index", kind: "int", min: 0, max: 4096, facet: "boundary", label: "Building index" };

/** A STRUCTURE's params — its placement in a town, plus the standalone
 *  creature-quest knobs it carries when it is the root scope. */
export const STRUCTURE_AUTHOR_FIELDS: GroupSpec = {
  fields: [STRUCTURE_PLACEMENT, ...SCOPE_SPECS.structure.worldFields.fields],
};

/** A SOLAR SYSTEM's own params — its star(s) are BODY children now (the
 *  sub-entity reframe), so the engine's `star` param is dropped here. */
export const SOLAR_AUTHOR_FIELDS: GroupSpec = {
  fields: SCOPE_SPECS.solar_system.worldFields.fields.filter((f) => f.key !== "star"),
};

/** Orbital + stellar params a BODY carries beyond its (planet-shaped) surface.
 *  A body is ONE kind distinguished only by what it ORBITS (recursive: bodies
 *  orbit bodies — moons a planet, planets a star, a star the barycenter; a
 *  binary is two bodies orbiting each other). Its regime (star / gas giant /
 *  planet / moon) emerges from MASS, not a separate kind. */
const BODY_ORBIT_FIELDS: readonly FieldSpec[] = [
  { key: "orbitAU", kind: "number", min: 0, max: 1e6, facet: "boundary", label: "Orbit distance (AU)",
    description: "Distance from what it orbits (its parent body, or the system barycenter)." },
  { key: "eccentricity", kind: "number", min: 0, max: 0.99, default: 0, facet: "boundary", label: "Eccentricity" },
  { key: "mass", kind: "number", min: 0.0001, max: 1e8, facet: "interior", label: "Mass (M⊕)",
    description: "Regime emerges from mass — heavy enough and a gas giant ignites into a star." },
  { key: "age", kind: "number", min: 0, max: 14, facet: "interior", label: "Age (Gyr)" },
  { key: "feh", kind: "number", min: -3, max: 1, default: 0, facet: "interior", label: "Metallicity [Fe/H]" },
];
/** The orbital/stellar keys a body carries beyond its planet surface — stripped
 *  when lowering a body root to the engine's `planet` scope (which doesn't yet
 *  model them). */
const BODY_ORBITAL_KEYS = new Set(BODY_ORBIT_FIELDS.map((f) => f.key));

/** A BODY = orbital/stellar params + a planet-shaped surface (reused wholesale
 *  from the planet descriptor). */
export const BODY_FIELDS: GroupSpec = {
  objectMessage: "expected an object (the body definition)",
  fields: [...BODY_ORBIT_FIELDS, ...PLANET_WORLD_FIELDS.fields],
};

// ── The kind registry ────────────────────────────────────────────────────────

export interface ObjectKindSpec {
  kind: string;
  label: string;
  /** Descriptor validating this kind's `params`. */
  paramFields: GroupSpec;
  /** Kinds legal inside `contains` (typed child-lists — the sub-entity interface). */
  childKinds: readonly string[];
  /** The engine scope this kind lowers to as a ROOT (absent = a leaf entity,
   *  never a root). A `body` lowers to the `planet` scope. */
  scope?: GameScope;
}

/** kind → its spec. The SUB-ENTITY-FIRST ladder (project_scope_object_vacuum
 *  _law): every level's children are typed child-lists, and any level can be
 *  the root (its `scope`). ONE `body` kind spans stars/planets/moons. */
export const OBJECT_KINDS: Record<string, ObjectKindSpec> = {
  galaxy:       { kind: "galaxy",       label: "Galaxy",       paramFields: SCOPE_SPECS.galaxy.worldFields, childKinds: ["solar_system"],     scope: "galaxy" },
  solar_system: { kind: "solar_system", label: "Solar system", paramFields: SOLAR_AUTHOR_FIELDS,            childKinds: ["body"],             scope: "solar_system" },
  body:         { kind: "body",         label: "Body",         paramFields: BODY_FIELDS,                    childKinds: ["body", "region"],   scope: "planet" },
  region:       { kind: "region",       label: "Region",       paramFields: SCOPE_SPECS.region.worldFields, childKinds: ["town"],             scope: "region" },
  town:         { kind: "town",         label: "Town",         paramFields: SCOPE_SPECS.town.worldFields,   childKinds: ["structure"],        scope: "town" },
  structure:    { kind: "structure",    label: "Structure",    paramFields: STRUCTURE_AUTHOR_FIELDS,         childKinds: ["creature", "item"], scope: "structure" },
  creature:     { kind: "creature",     label: "Creature",     paramFields: { fields: CREATURE_FIELDS },    childKinds: [] },
  item:         { kind: "item",         label: "Item",         paramFields: { fields: ITEM_FIELDS },         childKinds: [] },
};

const OBJECT_DEF_FIELDS = ["kind", "params", "where", "contains", "focus", "exhaustive"];

/** Relax a kind's descriptor for a CONTAINED node: a required BOUNDARY field
 *  becomes optional (the parent supplies it — the vacuum-vs-context law). */
function containedParamFields(group: GroupSpec): GroupSpec {
  if (!group.fields.some((f) => f.required && f.facet === "boundary")) return group;
  return {
    ...group,
    fields: group.fields.map((f) => (f.required && f.facet === "boundary" ? { ...f, required: false } : f)),
  };
}

/**
 * Validate + normalize an ObjectDef tree. `legalKinds` limits the allowed kind
 * (undefined at the root = any); `contained` triggers boundary-relaxation.
 * Enforces at most one `focus` across the whole tree.
 */
export function parseObjectDef(
  raw: unknown,
  path = "object",
  opts: { legalKinds?: readonly string[]; contained?: boolean } = {},
): ObjectDef {
  const node = parseNode(raw, path, opts);
  const focusCount = countFocus(node);
  if (focusCount > 1) fail(path, `only one node may be the focus (found ${focusCount})`);
  return node;
}

function parseNode(
  raw: unknown,
  path: string,
  opts: { legalKinds?: readonly string[]; contained?: boolean },
): ObjectDef {
  if (!isObj(raw)) fail(path, "expected an object ({ kind, params?, where?, contains?, focus? })");
  for (const k of Object.keys(raw)) {
    if (!OBJECT_DEF_FIELDS.includes(k)) fail(`${path}.${k}`, `unknown field (allowed: ${OBJECT_DEF_FIELDS.join(", ")})`);
  }
  if (typeof raw.kind !== "string" || !raw.kind) fail(`${path}.kind`, "must be a kind string");
  const spec = OBJECT_KINDS[raw.kind];
  if (!spec) fail(`${path}.kind`, `unknown kind "${raw.kind}" (known: ${Object.keys(OBJECT_KINDS).join(", ")})`);
  if (opts.legalKinds && !opts.legalKinds.includes(raw.kind)) {
    fail(`${path}.kind`, `"${raw.kind}" is not allowed here (allowed: ${opts.legalKinds.join(", ") || "(none)"})`);
  }

  const group = opts.contained ? containedParamFields(spec.paramFields) : spec.paramFields;
  const params = validateFields(isObj(raw.params) ? raw.params : {}, group, `${path}.params`);

  const out: ObjectDef = { kind: raw.kind, params };

  if ("where" in raw && raw.where !== undefined) {
    if (!Array.isArray(raw.where)) fail(`${path}.where`, "must be an array of constraints");
    out.where = raw.where;
  }
  if ("focus" in raw && raw.focus !== undefined) {
    if (typeof raw.focus !== "boolean") fail(`${path}.focus`, "must be true or false");
    if (raw.focus) out.focus = true;
  }
  if ("exhaustive" in raw && raw.exhaustive !== undefined) {
    if (!Array.isArray(raw.exhaustive) || !raw.exhaustive.every((k) => typeof k === "string")) {
      fail(`${path}.exhaustive`, "must be an array of child-kind strings");
    }
    const bad = raw.exhaustive.find((k) => !spec.childKinds.includes(k as string));
    if (bad !== undefined) fail(`${path}.exhaustive`, `"${bad}" is not a child kind of ${raw.kind} (children: ${spec.childKinds.join(", ") || "(none)"})`);
    out.exhaustive = raw.exhaustive as string[];
  }
  if ("contains" in raw && raw.contains !== undefined) {
    if (!Array.isArray(raw.contains)) fail(`${path}.contains`, "must be an array of sub-objects");
    out.contains = raw.contains.map((c, i) =>
      parseNode(c, `${path}.contains[${i}]`, { legalKinds: spec.childKinds, contained: true }));
  }
  return out;
}

function countFocus(node: ObjectDef): number {
  return (node.focus ? 1 : 0) + (node.contains ?? []).reduce((n, c) => n + countFocus(c), 0);
}

// ── Lowering: ObjectDef tree → the runnable aivota-world document ─────────────

type Dict = Record<string, unknown>;

/** Drop keys a target scope doesn't model (a body's orbital/stellar params when
 *  it lowers to the flat `planet` scope). */
function omit(obj: Dict | undefined, keys: ReadonlySet<string>): Dict {
  const out: Dict = {};
  for (const [k, v] of Object.entries(obj ?? {})) if (!keys.has(k)) out[k] = v;
  return out;
}

/**
 * Compile an ObjectDef tree to the `aivota-world` document envelope the engine
 * runs. Supported this increment: a scope root (→ scope + world; a `body` root
 * lowers to `planet`, its orbital/stellar params stripped) and the town →
 * structure → creature/item dollhouse (→ initial_focus + entities). Deeper
 * nested-scope focus lowering (load-then-focus) follows.
 */
export function lowerObjectDef(root: ObjectDef): Dict {
  const rk = OBJECT_KINDS[root.kind];
  if (!rk?.scope) fail("object.kind", `the root object must be a scope kind (got "${root.kind}")`);
  // A body carries orbital/stellar params the engine's planet scope can't parse
  // yet — strip them (the render-honoring-them work is the paused Approach B).
  const world = root.kind === "body" ? omit(root.params, BODY_ORBITAL_KEYS) : (root.params ?? {});
  const game: Dict = { scope: rk.scope, world };

  const structure = (root.contains ?? []).find((c) => c.kind === "structure");
  if (structure) {
    const idx = structure.params?.index;
    game.initial_focus = typeof idx === "number" ? { type: "house", index: idx } : { type: "house" };
    const creatures = (structure.contains ?? []).filter((c) => c.kind === "creature");
    const items = (structure.contains ?? []).filter((c) => c.kind === "item");
    const exhaustive = structure.exhaustive ?? [];
    const entities: Dict = {};
    if (creatures.length) {
      entities.creatures = { mode: exhaustive.includes("creature") ? "all" : "some", list: creatures.map((c) => c.params ?? {}) };
    }
    if (items.length) {
      entities.objects = { mode: "some", list: items.map((c) => c.params ?? {}) };
    }
    if (Object.keys(entities).length) game.entities = entities;
  }
  // Deeper nested-scope focus (focus a named body/town/region — "load the
  // parent, then dive") is the LOD load-then-focus work; not lowered yet.

  return { engine: "aivota-world", engineVersion: 1, uses: [], packs: [], game };
}
