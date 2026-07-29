/**
 * manifest.ts — the ENGINE KERNEL's document gate.
 *
 * One world = one JSON document. The document declares which CAPABILITY
 * MODULES it needs (`uses`) and carries an ordered list of CONTENT PACKS,
 * each contributing sections that registered modules own. The kernel's
 * job here is refusal and routing, nothing else:
 *
 *   • A document that `uses` a module this build didn't register fails
 *     at load with the list of what IS registered — a world can never
 *     half-load into a game that lacks its systems.
 *   • A pack section no registered module claims (or that `uses` didn't
 *     declare) is a path-exact error, never a silent skip — the same
 *     reject-unknown-fields law parseEconomyDoc established.
 *   • Pack order is SEMANTIC and preserved: modules compose their docs
 *     later-over-earlier (cross-pack key override — how clothing
 *     reshapes the farm), and process order chains same-step. Nothing
 *     here iterates an unordered map over content.
 *
 * The kernel stays thin on purpose: modules parse their own sections
 * (structural gates), and COMPILING stays a typed, per-module call at
 * the game's composition root — the kernel doesn't force a uniform
 * compile signature until a second module needs one. Runtime hooks
 * (boot/onDay/projectors) join the contract when the town module lands;
 * they are deliberately absent rather than speculatively present.
 *
 * The optional `game` envelope field carries the GAME-MAKER's session
 * shape (GameSettings): the world's scope on the object ladder
 * (structure → town → region → planet → solar_system → galaxy), the
 * scope-typed world definition, the initial focus (generation covers the
 * whole scope; focus frames what the player sees first), whether an
 * avatar spawns in the focus, and creative mode. The kernel gates the
 * shape; the scope's world builder owns the deep validation of `world` —
 * the same routing/ownership split as module sections.
 */

import { parseWorldScaleSpec, type WorldScaleSpec } from "../scale.js";
import { parseWorldCultureSpec, type WorldCultureSpec } from "../culture.js";

/** A capability module: owns one manifest section by key. */
export interface EngineModule<Doc = unknown> {
  /** The pack section this module owns ("economy"). */
  key: string;
  /** Structural boot gate: unknown JSON → a typed Doc, throwing errors
   *  that name the exact path (`path` prefixes every message). Unknown
   *  fields inside the section are the module's to reject. */
  parse(section: unknown, path: string): Doc;
}

export const WORLD_ENGINE_ID = "aivota-world";
export const WORLD_ENGINE_VERSION = 1;

/** The scope ladder — what kind of object a game's world IS. Each rung
 *  nests inside the next (structures in towns, towns in regions, regions
 *  on planets, planets in solar systems, systems in star clusters, clusters
 *  in a galaxy). */
export const GAME_SCOPES = ["structure", "town", "region", "planet", "solar_system", "star_cluster", "galaxy"] as const;
export type GameScope = (typeof GAME_SCOPES)[number];

/** Position on the scope ladder (GAME_SCOPES is ordered small → large). */
export function scopeIndex(s: GameScope): number {
  return (GAME_SCOPES as readonly string[]).indexOf(s);
}

/**
 * The CANONICAL focus vocabulary → the ladder rung it names. Only the rung
 * names every scope resolver shares live here (the module law bends for the
 * ladder arithmetic alone — owners still deep-validate their own focus);
 * vocabulary this table doesn't know resolves to null and passes the gate.
 *
 *   "house:3"          → structure   (town scope)
 *   "site:0" / "town"  → town        (planet / region scopes)
 *   "planet:2"         → planet      (solar-system scope)
 *   "star:1" / "home"  → solar_system (galaxy scope — a star IS its system)
 */
export const FOCUS_LEVELS: Record<string, GameScope> = {
  house: "structure",
  structure: "structure",
  site: "town",
  town: "town",
  region: "region",
  planet: "planet",
  star: "solar_system",
  home: "solar_system",
  system: "solar_system",
  cluster: "star_cluster",
};

/** The ladder rung an `initial_focus` names, or null when the vocabulary
 *  is owner-specific (the scope builder validates it instead). Reads the
 *  ID prefix ("house:3" → house) or a parameter set's `type`. */
export function focusLevel(focus: string | FocusParams | null): GameScope | null {
  if (focus === null) return null;
  if (typeof focus === "string") {
    const head = focus.includes(":") ? focus.slice(0, focus.indexOf(":")) : focus;
    return FOCUS_LEVELS[head] ?? null;
  }
  const t = (focus as { type?: unknown }).type;
  return typeof t === "string" ? (FOCUS_LEVELS[t] ?? null) : null;
}

/** A parameter set for `initial_focus`: the first generated object of the
 *  scope's kind that matches wins the focus. Interpretation of the
 *  parameters belongs to the scope's builder (the module law: the kernel
 *  routes, owners validate). */
export type FocusParams = Record<string, unknown>;

/**
 * Game-maker session settings — the `game` envelope field. The kernel
 * gates the SHAPE; the scope's world builder owns the deep validation of
 * `world` and the interpretation of focus parameters, exactly as modules
 * own their pack sections.
 */
export interface GameSettings {
  /** The world is ONE object of this type; play is limited to it. */
  scope: GameScope;
  /** The scope-typed world definition. */
  world: Record<string, unknown>;
  /** Which object the player sees first: an object ID, a parameter set
   *  (first match wins), or null — the world object itself. Generation
   *  always runs over the WHOLE scope; focus only frames the view. */
  initialFocus: string | FocusParams | null;
  /** How the player inhabits the focus:
   *  - `true`        = a WALKER avatar (ground-embodied — the town/planet scopes);
   *  - `"spirit"`    = a STATIONARY, formless first-person avatar: no movement,
   *                    the player interacts with objects/people by DWELLING on
   *                    them (pick up / put down / open / talk) at any distance —
   *                    the simplified puzzle mode (talk + move items);
   *  - `false`       = no avatar, the whole focused area is shown.
   *  (There is NO separate "spaceship" avatar — a space scope's pilot is the
   *  same walker with `can_fly`.) */
  avatar: AvatarSetting;
  /** The walker can FLY (`can_fly`): aiming at the top of the screen takes
   *  off into the full flight model (the former spaceship controls — the
   *  pointer steers the nose, the wheel is the speed; the flight sim's
   *  running/jump takeoff zones ARE the top of the screen). Ground play is
   *  unchanged; flight is how the avatar leaves a town, a planet, a
   *  system. Default false. */
  canFly: boolean;
  /** Species id (see the creature-builder registry) for the embodied avatar —
   *  and, for the town scope, its residents. Defaults to "human_cute" (the main
   *  people species) when the document omits it. */
  avatarSpecies: string;
  /** true = the focused object is player-modifiable. */
  creativeMode: boolean;
  /** SPACE-TIME COMPRESSION (`scale` — space-time-compression.md): the
   *  world's declared physics profile. Null = realism (the engine default):
   *  a 24-hour day, sleep a third of it, houses in half a year, real-size
   *  planets. Compression is always a declaration, never a default —
   *  resolve with scale.ts `resolveWorldScale`. */
  scale: WorldScaleSpec | null;
  /** DEFINED ENTITIES (`entities`): hand-authored individuals the world must
   *  contain, at any scope. Per entity TYPE, `mode` picks the composition:
   *    "some" — the defined entities are ADDED to (or overlay the first of)
   *             the generated ones;
   *    "all"  — NO entities of that type are generated; only the defined ones
   *             exist.
   *  The kernel gates only this SHAPE; each scope's builder owns the deep
   *  validation and the meaning of an entry's fields (the module law) —
   *  e.g. the town scope reads creature entries as the focused household's
   *  members. Null = fully generated world (every existing document). */
  entities: DefinedEntities | null;
  /** CULTURAL LAW (`culture` — nations-and-empires.md §6): the world's
   *  outermost, unrepealable ring of UNIVERSAL ABSOLUTE TABOOS (verbs no
   *  member of any culture here can ever perform — the parental-controls
   *  surface). Null = no universal taboos (realism default). Shape gated
   *  by culture.ts; resolve with `resolveWorldCulture`. */
  culture: WorldCultureSpec | null;
}

export type DefinedEntitiesMode = "some" | "all";
export interface DefinedEntityGroup {
  mode: DefinedEntitiesMode;
  /** Owner-interpreted entries (the scope builder validates fields). */
  list: Record<string, unknown>[];
}
export interface DefinedEntities {
  creatures?: DefinedEntityGroup;
  objects?: DefinedEntityGroup;
}

/** Entries one group may define (a hand-authored cast, not a crowd). */
export const MAX_DEFINED_ENTITIES = 16;

/** The avatar setting as written in a document. */
export type AvatarSetting = boolean | "spirit";

/** The inhabitation modes a scope builder / host dispatches on. */
export type AvatarKind = "none" | "walker" | "spirit";

/** Normalize a game's avatar setting to its kind (`true` = walker). */
export function avatarKind(game: GameSettings | null): AvatarKind {
  if (!game || game.avatar === false) return "none";
  if (game.avatar === "spirit") return "spirit";
  return "walker";
}

export interface WorldManifestInfo {
  engine: typeof WORLD_ENGINE_ID;
  engineVersion: typeof WORLD_ENGINE_VERSION;
  /** Capability keys this world requires, as declared. */
  uses: string[];
  /** Pack names in composition order. */
  packs: string[];
}

export interface LoadedWorld {
  info: WorldManifestInfo;
  /** Session settings from the `game` envelope field (null when absent —
   *  a bare content world; the hosting game supplies its own session). */
  game: GameSettings | null;
  /** module key → that module's parsed docs, in PACK ORDER. */
  sections: Map<string, unknown[]>;
}

/** Typed accessor: the docs a module received, in pack order. */
export function docsFor<D>(loaded: LoadedWorld, module: EngineModule<D>): D[] {
  return (loaded.sections.get(module.key) ?? []) as D[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

/** Structural gate for the `game` envelope field (exported so loaders can
 *  gate bare settings objects too). Path-exact refusals, never skips. */
export function parseGameSettings(raw: unknown, path: string): GameSettings {
  if (!isObj(raw)) fail(path, "expected an object");
  for (const k of Object.keys(raw)) {
    if (!["scope", "world", "initial_focus", "avatar", "avatar_species", "can_fly", "creative_mode", "entities", "scale", "culture"].includes(k)) {
      fail(`${path}.${k}`, "unknown field (allowed: scope, world, initial_focus, avatar, avatar_species, can_fly, creative_mode, entities, scale, culture)");
    }
  }

  const scope = raw.scope;
  if (typeof scope !== "string" || !(GAME_SCOPES as readonly string[]).includes(scope)) {
    fail(`${path}.scope`, `must be one of: ${GAME_SCOPES.join(", ")}`);
  }

  if (!("world" in raw)) fail(`${path}.world`, `required — the ${scope} this game plays in`);
  if (!isObj(raw.world)) fail(`${path}.world`, `must be an object (the ${scope} definition)`);

  let initialFocus: GameSettings["initialFocus"] = null;
  if ("initial_focus" in raw && raw.initial_focus !== null) {
    const f = raw.initial_focus;
    if (typeof f === "string") {
      if (!f.length) fail(`${path}.initial_focus`, "an object ID must be a non-empty string");
      initialFocus = f;
    } else if (isObj(f)) {
      initialFocus = f;
    } else {
      fail(`${path}.initial_focus`, "must be an object ID (string), a parameter set (object), or null");
    }
    // THE LADDER LAW: a focus can be any rung AT or BELOW the scope — the
    // scope is all that exists, so nothing larger can be framed. Only the
    // canonical rung vocabulary is judged here (unknown vocabulary belongs
    // to the scope's own resolver).
    const level = focusLevel(initialFocus);
    if (level !== null && scopeIndex(level) > scopeIndex(scope as GameScope)) {
      fail(`${path}.initial_focus`, `a ${scope} game cannot focus a ${level} — focus must be at or below the scope`);
    }
  }

  let avatar: AvatarSetting = false;
  if ("avatar" in raw && raw.avatar !== null) {
    if (raw.avatar === "spirit") avatar = "spirit";
    else if (typeof raw.avatar === "boolean") avatar = raw.avatar;
    else if (raw.avatar === "spaceship") {
      fail(`${path}.avatar`, '"spaceship" was retired — the pilot is the walker: use avatar: true with can_fly: true');
    } else fail(`${path}.avatar`, 'must be true, "spirit", or null');
  }

  let canFly = false;
  if ("can_fly" in raw && raw.can_fly !== null) {
    if (typeof raw.can_fly !== "boolean") fail(`${path}.can_fly`, "must be true or false");
    canFly = raw.can_fly;
  }

  // Defaults to "human_cute" — the main people species.
  let avatarSpecies = "human_cute";
  if ("avatar_species" in raw && raw.avatar_species !== null) {
    if (typeof raw.avatar_species !== "string" || !raw.avatar_species.length) {
      fail(`${path}.avatar_species`, "must be a non-empty species id string");
    }
    avatarSpecies = raw.avatar_species;
  }

  let creativeMode = false;
  if ("creative_mode" in raw) {
    if (typeof raw.creative_mode !== "boolean") fail(`${path}.creative_mode`, "must be true or false");
    creativeMode = raw.creative_mode;
  }

  // DEFINED ENTITIES — shape only; entry fields belong to the scope's builder.
  let entities: DefinedEntities | null = null;
  if ("entities" in raw && raw.entities !== null) {
    const e = raw.entities;
    if (!isObj(e)) fail(`${path}.entities`, "expected an object ({ creatures?, objects? })");
    for (const k of Object.keys(e)) {
      if (!["creatures", "objects"].includes(k)) {
        fail(`${path}.entities.${k}`, "unknown group (allowed: creatures, objects)");
      }
    }
    const group = (v: unknown, at: string): DefinedEntityGroup => {
      if (!isObj(v)) fail(at, "expected an object ({ mode, list })");
      for (const k of Object.keys(v)) {
        if (!["mode", "list"].includes(k)) fail(`${at}.${k}`, "unknown field (allowed: mode, list)");
      }
      if (v.mode !== "some" && v.mode !== "all") fail(`${at}.mode`, 'must be "some" or "all"');
      if (!Array.isArray(v.list)) fail(`${at}.list`, "expected an array of entity entries");
      if (v.list.length > MAX_DEFINED_ENTITIES) {
        fail(`${at}.list`, `${v.list.length} entries exceeds max ${MAX_DEFINED_ENTITIES}`);
      }
      v.list.forEach((entry, i) => {
        if (!isObj(entry)) fail(`${at}.list[${i}]`, "expected an object");
      });
      return { mode: v.mode, list: v.list as Record<string, unknown>[] };
    };
    entities = {
      ...("creatures" in e ? { creatures: group(e.creatures, `${path}.entities.creatures`) } : {}),
      ...("objects" in e ? { objects: group(e.objects, `${path}.entities.objects`) } : {}),
    };
  }

  // SPACE-TIME COMPRESSION — shape gated by scale.ts (the owner of the
  // vocabulary); absent or null = realism.
  let scale: WorldScaleSpec | null = null;
  if ("scale" in raw && raw.scale !== null) {
    scale = parseWorldScaleSpec(raw.scale, `${path}.scale`);
  }

  // CULTURAL LAW — shape gated by culture.ts (the owner of the vocabulary);
  // absent or null = no universal taboos.
  let culture: WorldCultureSpec | null = null;
  if ("culture" in raw && raw.culture !== null) {
    culture = parseWorldCultureSpec(raw.culture, `${path}.culture`);
  }

  return { scope: scope as GameScope, world: raw.world, initialFocus, avatar, avatarSpecies, canFly, creativeMode, entities, scale, culture };
}

/**
 * Load a world document against the modules THIS build registers.
 * Envelope, capability and section routing errors all throw with exact
 * paths; module parse errors pass through with `world.packs[i].<key>`
 * prefixes. Returns every module's docs in pack order — compiling them
 * is the composition root's typed call.
 */
export function loadWorldManifest(
  raw: unknown,
  modules: readonly EngineModule[],
  label = "world",
): LoadedWorld {
  // Registration is code, not content — a duplicate key is the
  // composition root's bug and fails regardless of the document.
  const byKey = new Map<string, EngineModule>();
  for (const m of modules) {
    if (byKey.has(m.key)) throw new Error(`engine: module key "${m.key}" registered twice`);
    byKey.set(m.key, m);
  }
  const registered = () =>
    byKey.size ? [...byKey.keys()].join(", ") : "(none)";

  if (!isObj(raw)) fail(label, "expected an object");
  for (const k of Object.keys(raw)) {
    if (!["engine", "engineVersion", "uses", "packs", "game"].includes(k)) {
      fail(label, `unknown field "${k}" (allowed: engine, engineVersion, uses, packs, game)`);
    }
  }
  if (raw.engine !== WORLD_ENGINE_ID) {
    fail(`${label}.engine`, `expected "${WORLD_ENGINE_ID}"`);
  }
  if (raw.engineVersion !== WORLD_ENGINE_VERSION) {
    fail(`${label}.engineVersion`, `expected ${WORLD_ENGINE_VERSION}`);
  }
  if (!Array.isArray(raw.uses)) fail(`${label}.uses`, "must be an array of module keys");
  const uses = new Set<string>();
  raw.uses.forEach((u, i) => {
    if (typeof u !== "string" || !u.length) fail(`${label}.uses[${i}]`, "must be a module key string");
    if (uses.has(u)) fail(`${label}.uses[${i}]`, `duplicate "${u}"`);
    if (!byKey.has(u)) {
      fail(`${label}.uses[${i}]`, `this game does not include "${u}" (registered modules: ${registered()})`);
    }
    uses.add(u);
  });
  if (!Array.isArray(raw.packs)) fail(`${label}.packs`, "must be an array of content packs");

  const game = "game" in raw && raw.game !== null
    ? parseGameSettings(raw.game, `${label}.game`)
    : null;

  const sections = new Map<string, unknown[]>([...uses].map(u => [u, []]));
  const packNames: string[] = [];
  raw.packs.forEach((p, i) => {
    const at = `${label}.packs[${i}]`;
    if (!isObj(p)) fail(at, "expected an object");
    if (typeof p.name !== "string" || !p.name.length) fail(`${at}.name`, "must be a non-empty string");
    if (packNames.includes(p.name)) fail(`${at}.name`, `duplicate pack name "${p.name}"`);
    packNames.push(p.name);
    for (const k of Object.keys(p)) {
      if (k === "name") continue;
      if (!byKey.has(k)) {
        fail(`${at}.${k}`, `no registered module owns this section (registered modules: ${registered()})`);
      }
      if (!uses.has(k)) {
        fail(`${at}.${k}`, `section present but "${k}" is not declared in ${label}.uses`);
      }
      sections.get(k)!.push(byKey.get(k)!.parse(p[k], `${at}.${k}`));
    }
  });

  return {
    info: {
      engine: WORLD_ENGINE_ID,
      engineVersion: WORLD_ENGINE_VERSION,
      uses: [...uses],
      packs: packNames,
    },
    game,
    sections,
  };
}

/** A document is a MANIFEST (vs a bare module section) iff it carries
 *  the engine field — how a loader accepts both during the migration. */
export function isWorldManifest(raw: unknown): boolean {
  return isObj(raw) && "engine" in raw;
}
