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
 *  on planets, planets in solar systems, systems in a galaxy). */
export const GAME_SCOPES = ["structure", "town", "region", "planet", "solar_system", "galaxy"] as const;
export type GameScope = (typeof GAME_SCOPES)[number];

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
   *  - `"spaceship"` = a flown SHIP avatar (the space scopes — galaxy/solar);
   *  - `"spirit"`    = a STATIONARY, formless first-person avatar: no movement,
   *                    the player interacts with objects/people by DWELLING on
   *                    them (pick up / put down / open / talk) at any distance —
   *                    the simplified puzzle mode (talk + move items);
   *  - `false`       = no avatar, the whole focused area is shown. */
  avatar: AvatarSetting;
  /** Species id (see the creature-builder registry) for the embodied avatar —
   *  and, for the town scope, its residents. Defaults to "human_cute" (the main
   *  people species) when the document omits it. */
  avatarSpecies: string;
  /** true = the focused object is player-modifiable. */
  creativeMode: boolean;
}

/** The avatar setting as written in a document. */
export type AvatarSetting = boolean | "spaceship" | "spirit";

/** The inhabitation modes a scope builder / host dispatches on. */
export type AvatarKind = "none" | "walker" | "spaceship" | "spirit";

/** Normalize a game's avatar setting to its kind (`true` = walker). */
export function avatarKind(game: GameSettings | null): AvatarKind {
  if (!game || game.avatar === false) return "none";
  if (game.avatar === "spaceship") return "spaceship";
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
    if (!["scope", "world", "initial_focus", "avatar", "avatar_species", "creative_mode"].includes(k)) {
      fail(`${path}.${k}`, "unknown field (allowed: scope, world, initial_focus, avatar, avatar_species, creative_mode)");
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
  }

  let avatar: AvatarSetting = false;
  if ("avatar" in raw && raw.avatar !== null) {
    if (raw.avatar === "spaceship") avatar = "spaceship";
    else if (raw.avatar === "spirit") avatar = "spirit";
    else if (typeof raw.avatar === "boolean") avatar = raw.avatar;
    else fail(`${path}.avatar`, 'must be true, "spaceship", "spirit", or null');
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

  return { scope: scope as GameScope, world: raw.world, initialFocus, avatar, avatarSpecies, creativeMode };
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
