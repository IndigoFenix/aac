/**
 * The TOWN scope builder — a living town loaded from a JSON document.
 *
 * There is ONE kind of town, and it is always living: a real `createTownWorld`
 * economy simulation whose RESIDENTS walk the streets, whose goods are what the
 * town produces, and which the player enters embodied to walk and talk. It IS
 * the sandbox's 🏘️ town mode, `buildTownPlay` (shared/symbol-game/town-play.ts),
 * reached from a world document. See docs/TOWN_AND_NPCS.md.
 *
 * (There is NO `living-town` world kind — that was a mis-fork. The static
 * aggregate viewer in shared/engine/town/town-game.ts is a far-LOD analysis
 * build, not an alternative town.)
 *
 * Validation follows the module law: the kernel gated `game`'s shape; this
 * builder owns the deep validation of the town-scoped `world` object,
 * path-exact, reject-never-skip.
 */
import type { GameSettings } from "../../kernel/manifest.js";
import {
  buildTownPlay,
  roomiestHouseIndex,
  type TownDefinedItem,
  type TownFamily,
  type TownFamilyMember,
  type TownFamilyPet,
  type TownPlay,
  type TownPlayConfig,
} from "@shared/world-engine/interaction/town/town-play.js";
import { certifyCreatureQuestWorld } from "@shared/world-engine/interaction/quest/creature-quests.js";
import { FOUNDING_AGE_DAYS } from "@shared/world-engine/kernel/town/plan.js";
import { validateFields, type GroupSpec } from "../../kernel/spec-schema.js";

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

export interface TownScopeWorldSpec {
  config: TownPlayConfig;
}

/** The town scope's `world` descriptor. Field order IS the allowed-list order
 *  the unknown-field message reports. */
export const TOWN_WORLD_FIELDS: GroupSpec = {
  objectMessage: "expected an object (the town definition)",
  fields: [
    // The seed is REQUIRED: one seed reproduces the whole town (plan, residents,
    // quests). Omitting it would let the document lie about what it loads.
    { key: "seed", kind: "int", min: 0, max: 0xffffffff, required: true,
      requiredMessage: "required — one seed reproduces the whole town",
      facet: "boundary", ui: "seed", label: "Seed" },
    { key: "days", kind: "int", min: 0, max: 5000, facet: "interior", label: "Days grown",
      description: "How many days the town has lived before you arrive. 0 = founded today — a town SITE with no buildings yet (city-founding)." },
    { key: "population", kind: "int", min: 0, max: 10000, facet: "interior", label: "Population",
      description: "People of the settlement. At age 0 they are settlers with nothing built yet; an older town houses them (≥1 villages keep the 6-house floor)." },
    { key: "questCount", kind: "int", min: 0, max: 3, facet: "interior", label: "Quests",
      description: "Quest-giving residents (0..3)." },
    { key: "buildUp", kind: "number", min: 0, max: 12, facet: "interior", label: "Build-up" },
    { key: "syntax", kind: "enum",
      options: [{ value: "a", label: "a" }, { value: "b", label: "b" }, { value: "c", label: "c" }],
      facet: "interior", label: "Quest syntax" },
    { key: "locale", kind: "string", invalidMessage: "must be a BCP-47 locale string",
      facet: "interior", label: "Locale" },
    { key: "terrain", kind: "enum",
      options: [{ value: "flat", label: "Flat" }, { value: "hills", label: "Hills" }, { value: "planet", label: "Planet ground" }],
      facet: "boundary", label: "Terrain",
      description: "The ground the town sits on (a boundary a parent region can supply)." },
    { key: "cluster", kind: "int", min: 0, max: 4, facet: "interior", label: "Neighbor hamlets",
      description: "Extra living towns streamed into the same walking session (0..4)." },
    // E4 (nations P3): the numeraire routes commodity quotes once trade is
    // dense — validated against the compiled economy at build. Absent = barter.
    { key: "numeraire", kind: "string", invalidMessage: "must be a commodity key string",
      facet: "interior", label: "Numeraire" },
    // ── City-founding (age-0 towns): declared supplies + open country.
    { key: "stock", kind: "custom", validate: parseStock, facet: "interior", label: "Starting stock",
      description: "The settlement's supply box — material glyph → count (e.g. { \"wood\": 12 }), seeded into the builder's yard." },
    { key: "wilderness", kind: "boolean", facet: "boundary", label: "Wilderness",
      description: "Gatherable trees/rocks scattered over the chart. Default: on at age 0, off for an established town." },
  ],
};

/** The declared supply box: glyph → positive count. */
function parseStock(raw: unknown, path: string): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(path, "expected an object of material stacks (glyph → count)");
  }
  const out: Record<string, number> = {};
  for (const [glyph, v] of Object.entries(raw)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) {
      fail(`${path}.${glyph}`, "must be a positive integer count");
    }
    out[glyph] = v;
  }
  return out;
}

/** Deep gate for a town-scoped `world` object. */
export function parseTownWorld(raw: unknown, path: string): TownScopeWorldSpec {
  const v = validateFields(raw, TOWN_WORLD_FIELDS, path) as Record<string, unknown>;
  // The author says "population"; the config's founding seam says startPop
  // (siteTownConfig's word) — one concept, remapped at the gate.
  if ("population" in v) {
    v.startPop = v.population;
    delete v.population;
  }
  return { config: v as unknown as TownPlayConfig };
}

export interface BuiltTownScope {
  spec: TownScopeWorldSpec;
  /** The live session the quest host plays (config + town + plan + quests + stage). */
  play: TownPlay;
  /** The document's `initial_focus`, resolved: the focused HOUSE (dollhouse
   *  framing) or null — the town opens at the village square. */
  focus: TownFocus | null;
}

/** A town's resolved initial focus — one of its houses. */
export interface TownFocus {
  house: number;
}

/**
 * Interpret a town document's `initial_focus` — the DOLLHOUSE frame
 * (household-duties-and-sims-mode.md §3): focus one HOUSE and play opens INSIDE
 * it (Sims-mode motives, direct obedience) while the whole town keeps living
 * around it — generation always runs over the whole scope; focus only frames
 * the view (the manifest law). Forms, mirroring the galaxy's focus vocabulary:
 *   • "house:<index>"                — an exact house by its plan index;
 *   • { type: "house", index?: n }   — a parameter set; index omitted picks the
 *                                      ROOMIEST house (it fits the beds);
 *   • null                           — no focus: the village square, as ever.
 */
export function resolveTownFocus(
  play: TownPlay,
  focus: GameSettings["initialFocus"],
  label = "game",
): TownFocus | null {
  if (focus === null) return null;
  const at = `${label}.initial_focus`;
  const houseAt = (index: number): TownFocus => {
    if (!play.plan.houses.some((h) => h.index === index)) {
      fail(at, `house ${index} does not exist (this town has ${play.plan.houses.length} houses)`);
    }
    return { house: index };
  };
  if (typeof focus === "string") {
    const m = /^house:(\d+)$/.exec(focus);
    if (!m) fail(at, `unknown object ID "${focus}" (town IDs: "house:<index>")`);
    return houseAt(Number(m[1]));
  }
  for (const k of Object.keys(focus)) {
    if (!["type", "index"].includes(k)) fail(`${at}.${k}`, "unknown parameter (allowed: type, index)");
  }
  if ("type" in focus && focus.type !== "house") {
    fail(`${at}.type`, `a town focuses houses (expected "house")`);
  }
  if ("index" in focus) {
    if (typeof focus.index !== "number" || !Number.isInteger(focus.index)) {
      fail(`${at}.index`, "must be an integer house index");
    }
    return houseAt(focus.index);
  }
  // No index — the roomiest house wins (it fits the household's furniture).
  // ONE policy, shared with the family builder (town-play.ts).
  const best = roomiestHouseIndex(play.plan.houses);
  if (best === null) fail(at, "this town has no houses to focus");
  return { house: best };
}

/** An EXPLICIT house index in the focus, when the document names one (the
 *  family must be built into that exact house). Undefined = policy-resolved. */
function explicitFocusHouse(focus: GameSettings["initialFocus"]): number | undefined {
  if (typeof focus === "string") {
    const m = /^house:(\d+)$/.exec(focus);
    return m ? Number(m[1]) : undefined;
  }
  if (focus && typeof focus === "object" && typeof (focus as { index?: unknown }).index === "number") {
    return (focus as { index: number }).index;
  }
  return undefined;
}

/**
 * Interpret the document's DEFINED ENTITIES for the town scope (the kernel
 * gated the shape; this owner validates the fields — the module law):
 *
 *   • `creatures` are the FOCUSED HOUSEHOLD's members — hand-authoring a
 *     family requires an `initial_focus` naming a house. Fields per member:
 *     `name` (string), `species` (species id), `outfit` (preset index),
 *     `likes` (fruit-kind strings). Mode "all" = the household has EXACTLY
 *     these members (the rest are never generated); "some" = the usual
 *     household, its first entries customized.
 *   • `objects` are ITEMS placed in the focused house: `{ glyph, at }` with
 *     `at` ∈ table | box | floor. Only mode "some" — chest stock belongs
 *     to the economy; hand-authored items ADD, they don't replace it.
 */
function parseTownEntities(
  entities: GameSettings["entities"],
  hasHouseFocus: boolean,
  /** FOUNDING AGE (city-founding ②): an age-0 town has no houses to focus —
   *  its defined creatures are the SETTLERS, the player's founding group. */
  foundingAge: boolean,
  label: string,
): { family?: TownFamily; items?: TownDefinedItem[] } {
  if (!entities) return {};
  const at = `${label}.entities`;
  const out: { family?: TownFamily; items?: TownDefinedItem[] } = {};
  if (entities.creatures) {
    if (!hasHouseFocus && !foundingAge) {
      fail(`${at}.creatures`, "town creature definitions are the focused household's members — set initial_focus to a house");
    }
    const members: TownFamilyMember[] = [];
    const pets: TownFamilyPet[] = [];
    entities.creatures.list.forEach((e, i) => {
      const p = `${at}.creatures.list[${i}]`;
      for (const k of Object.keys(e)) {
        if (!["name", "species", "outfit", "likes", "pet"].includes(k)) {
          fail(`${p}.${k}`, "unknown field (allowed: name, species, outfit, likes, pet)");
        }
      }
      const isPet = "pet" in e && e.pet === true;
      if ("pet" in e && typeof e.pet !== "boolean") fail(`${p}.pet`, "must be true or false");
      const m: TownFamilyMember & TownFamilyPet = {};
      if ("name" in e) {
        if (typeof e.name !== "string" || !e.name.length) fail(`${p}.name`, "must be a non-empty string");
        m.name = e.name;
      }
      if ("species" in e) {
        if (typeof e.species !== "string" || !e.species.length) fail(`${p}.species`, "must be a species id string");
        m.species = e.species;
      }
      if ("outfit" in e) {
        if (isPet) fail(`${p}.outfit`, "a pet wears no outfit preset");
        if (typeof e.outfit !== "number" || !Number.isInteger(e.outfit) || e.outfit < 0) {
          fail(`${p}.outfit`, "must be a non-negative outfit-preset index");
        }
        m.outfit = e.outfit;
      }
      if ("likes" in e) {
        if (!Array.isArray(e.likes) || !e.likes.every((l) => typeof l === "string" && l.length)) {
          fail(`${p}.likes`, "must be an array of kind words");
        }
        m.likes = e.likes as string[];
      }
      if (isPet) pets.push(m);
      else members.push(m);
    });
    if (entities.creatures.mode === "all" && members.length === 0) {
      fail(`${at}.creatures.list`, 'mode "all" with no members would empty the house');
    }
    out.family = { mode: entities.creatures.mode, members, ...(pets.length ? { pets } : {}) };
  }
  if (entities.objects) {
    if (!hasHouseFocus) {
      fail(`${at}.objects`, "town object definitions land in the focused house — set initial_focus to a house");
    }
    if (entities.objects.mode === "all") {
      fail(`${at}.objects.mode`, 'chest stock belongs to the economy — only "some" (additive) is supported for objects');
    }
    out.items = entities.objects.list.map((e, i): TownDefinedItem => {
      const p = `${at}.objects.list[${i}]`;
      for (const k of Object.keys(e)) {
        if (!["glyph", "at"].includes(k)) fail(`${p}.${k}`, "unknown field (allowed: glyph, at)");
      }
      if (typeof e.glyph !== "string" || !e.glyph.length) fail(`${p}.glyph`, "must be a glyph string");
      const spot = e.at ?? "floor";
      if (spot !== "table" && spot !== "box" && spot !== "floor") {
        fail(`${p}.at`, 'must be "table", "box" or "floor"');
      }
      return { glyph: e.glyph, at: spot };
    });
  }
  return out;
}

/** Build the living town a `scope: "town"` document describes. Deterministic
 *  end to end (same seed ⇒ same town). */
export function buildTownScope(settings: GameSettings, label = "game"): BuiltTownScope {
  if (settings.scope !== "town") {
    fail(`${label}.scope`, `buildTownScope builds "town" games (got "${settings.scope}")`);
  }
  const spec = parseTownWorld(settings.world, `${label}.world`);
  // A town is played embodied — you walk it and talk to its residents; a
  // spectator view of it is meaningless. The SPIRIT presence counts: it is
  // stationary but fully interactive (dwell to talk/gift/command — the
  // dollhouse's eyegaze mode), not a spectator.
  if (settings.avatar !== true && settings.avatar !== "spirit") {
    fail(`${label}.avatar`, 'a town is played embodied — set avatar to true (or "spirit")');
  }
  // DEFINED ENTITIES fold into the CONFIG (replay rebuilds from it): mode-"all"
  // families change who is generated, so the build itself must know. At
  // FOUNDING AGE the family needs no house — they are the settlers.
  const foundingAge = (spec.config.days ?? 220) <= FOUNDING_AGE_DAYS;
  const defined = parseTownEntities(settings.entities, settings.initialFocus !== null, foundingAge, label);
  if (defined.family) {
    const explicit = explicitFocusHouse(settings.initialFocus);
    spec.config.family = explicit !== undefined ? { ...defined.family, house: explicit } : defined.family;
  }
  if (defined.items) spec.config.items = defined.items;
  // HOW THIS CULTURE BUILDS (game.culture.architecture) folds into the CONFIG
  // (replay rebuilds from it, like dress drives outfits): the town furnishes
  // its workstations from the resolved placement. The kernel already gated the
  // culture block's shape (parseWorldCultureSpec); this is a pass-through.
  if (settings.culture?.architecture) spec.config.architecture = settings.culture.architecture;

  const play = buildTownPlay(spec.config);
  // The quest bundle drawn from the town's residents/goods must PROVE itself
  // (the goal-tree gauntlet + the greedy-sim playthrough) — a town whose
  // quests aren't winnable is refused, not shipped.
  const cert = certifyCreatureQuestWorld(play.bundle.game);
  if (!cert.ok) {
    fail(`${label}.world`, `town failed ${cert.stage} certification: ${cert.errors.join("; ")}`);
  }
  // Focus resolves against the BUILT town (it names one of its houses) — and a
  // defined family must live exactly where the focus (and the build) put it.
  const focus = resolveTownFocus(play, settings.initialFocus, label);
  if (defined.family && focus && play.familyHouse !== null && focus.house !== play.familyHouse) {
    fail(`${label}.initial_focus`, `the defined family lives in house ${play.familyHouse} — focus it (or omit the index)`);
  }
  return { spec, play, focus };
}
