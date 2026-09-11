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
import { DOLLHOUSE_SCALE, resolveWorldScale } from "@shared/world-engine/scale.js";
import { validateFields, type FieldSpec, type GroupSpec } from "../../kernel/spec-schema.js";
import type { SerializedTownDeltas } from "@shared/world-engine/kernel/town/construction.js";

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

export interface TownScopeWorldSpec {
  config: TownPlayConfig;
}

/** The five numbers of a `ClimateSample` (products.ts), in its own units. */
const CLIMATE_FIELDS: readonly FieldSpec[] = [
  { key: "rain", kind: "number", min: 0, max: 10, required: true, facet: "interior", label: "Rain" },
  { key: "tempC", kind: "number", min: -80, max: 80, required: true, facet: "interior", label: "Temperature (°C)" },
  { key: "elevation", kind: "number", min: 0, max: 63, required: true, facet: "interior", label: "Elevation" },
  { key: "fertility", kind: "number", min: 0, max: 15, required: true, facet: "interior", label: "Fertility" },
  // ⚠️ REQUIRED HERE though `ClimateSample.ore` is optional (absent = 0): a
  // DECLARED cell is a transcript of a measurement, and a measurement that
  // found no ore says 0. Absence would mean "this document forgot", which is
  // exactly the half-declared shape the all-five gate exists to refuse.
  { key: "ore", kind: "number", min: 0, max: 15, required: true, facet: "interior", label: "Exposed ore" },
];

/**
 * 📜 THE DECLARED-CELL FIELDS — the `SiteEnvironment` record, as document
 * fields (planet-boot round §6a).
 *
 * ⚖️ WHY A DOCUMENT MAY SAY THIS AT ALL. There is ONE record of what the ground
 * under a settlement says (`interaction/town/planet-scope.ts SiteEnvironment`)
 * and it has three producers: MEASURED off a baked planet, MEASURED off a baked
 * region, or DECLARED here. The third exists because a headless boot that only
 * wants a founding CAMP should not pay 25 seconds of planetary geology to learn
 * five numbers — and because before it existed the alternative was four
 * hand-written constants in the harness (`text-quest.ts PLANET_CELL_*`) that
 * described a temperate wood the browser bakes nowhere.
 *
 * 🚨 A DECLARED CELL IS GENERATED, NEVER TYPED (feedback_game_spec_json_is_
 * generated): `npm run world:lower -- --declare-cell` bakes the planet once and
 * writes what `measuredEnvironment` measured. `declared-cell.test.ts` asserts
 * the checked-in file equals a fresh generation byte-for-byte, so a hand edit
 * is a red, not a drift.
 *
 * All optional and `facet: "interior"` ⇒ every shipped document parses
 * byte-identically (an absent field with no `default` stays absent).
 */
const CELL_FIELDS: readonly FieldSpec[] = [
  { key: "climate", kind: "object", fields: CLIMATE_FIELDS, facet: "interior",
    objectMessage: "expected an object (the cell's climate sample)",
    label: "Cell climate",
    description: "What the founding cell can grow (`climateSampleAt`): rain, tempC, elevation, fertility, ore. The SAME sample reaches the books (the farm's yield per acre) and the live farm." },
  { key: "biome", kind: "int", min: 0, max: 8, facet: "interior", label: "Cell biome",
    description: "The substrate's biome index (DEFAULT_BIOSPHERE order; 0 barren, 1 forest, 2 meadow, 3 grazer range) — what the countryside scatter is made of." },
  { key: "eco", kind: "custom", validate: parseEco, facet: "interior", label: "Cell ecology",
    description: "Per-species abundance at the cell, species key → 0..1 (`ecoAbundanceAt`) — the per-HECTARE densities the scatter reads." },
  { key: "charter", kind: "custom", validate: parseCharter, facet: "interior", label: "Charter",
    description: "The settlement's endowment box: { farmland, ore_access, timberland? }. Measured off the substrate, not chosen." },
  { key: "partners", kind: "custom", validate: parsePartners, facet: "interior", label: "Trade partners",
    description: "The nearest settlements as boot-supplied trade rows: { key, at {x,y}, geo?, distanceM } in this town's own sim coordinates, nearest first." },
];

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
    { key: "hamlets", kind: "custom", validate: parseHamlets, facet: "interior", label: "Hamlet overrides",
      description: "Per-hamlet settings for the `cluster` ring, index-aligned (0..4 entries): { population, days, seed, charter }. Omitted entries keep the ring's defaults." },
    // E4 (nations P3): the numeraire routes commodity quotes once trade is
    // dense — validated against the compiled economy at build. Absent = barter.
    { key: "numeraire", kind: "string", invalidMessage: "must be a commodity key string",
      facet: "interior", label: "Numeraire" },
    // ── City-founding (age-0 towns): declared supplies + open country.
    { key: "stock", kind: "custom", validate: parseStock, facet: "interior", label: "Starting stock",
      description: "The settlement's supply box — material glyph → count (e.g. { \"wood\": 12 }), seeded into the builder's yard." },
    { key: "wilderness", kind: "boolean", facet: "boundary", label: "Wilderness",
      description: "Gatherable trees/rocks scattered over the chart. Default: on at age 0, off for an established town." },
    // ── 📜 THE DECLARED CELL (planet-boot round S2): what the ground under
    //    this settlement SAYS about itself, when nothing is standing on a
    //    baked substrate to measure it. See `TownPlayConfig.biome` and
    //    `planet-scope.ts declaredEnvironment` — all five or none.
    ...CELL_FIELDS,
  ],
};

/** Per-species abundance, 0..1 — `ecoAbundanceAt`'s own shape. Dynamic keys
 *  (the species catalogue is content), so a `custom` validator rather than a
 *  field list. */
function parseEco(raw: unknown, path: string): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(path, "expected an object of per-species abundance (species → 0..1)");
  }
  const out: Record<string, number> = {};
  for (const [species, v] of Object.entries(raw)) {
    if (typeof v !== "number" || !Number.isFinite(v)) fail(`${path}.${species}`, "must be a finite number");
    if (v < 0 || v > 1) fail(`${path}.${species}`, "out of range (0..1)");
    out[species] = v;
  }
  return out;
}

/** THE ONE CHARTER VALIDATOR. Lifted out of `parseHamlets` (planet-boot round
 *  S2) the moment a second field wanted the same object: a hamlet override's
 *  charter and a declared cell's charter are the same endowment box, so they
 *  must reject the same way and say the same thing. */
function parseCharter(raw: unknown, path: string): NonNullable<TownPlayConfig["charter"]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(path, "expected an object of endowment scalars (farmland, ore_access, timberland)");
  }
  const cr = raw as Record<string, unknown>;
  for (const [k, v] of Object.entries(cr)) {
    if (!["farmland", "ore_access", "timberland"].includes(k)) {
      fail(`${path}.${k}`, "unknown field (allowed: farmland, ore_access, timberland)");
    }
    if (typeof v !== "number" || !Number.isFinite(v)) fail(`${path}.${k}`, "must be a finite number");
  }
  for (const k of ["farmland", "ore_access"]) {
    if (!(k in cr)) fail(`${path}.${k}`, "required — a charter declares farmland and ore_access");
  }
  return cr as unknown as NonNullable<TownPlayConfig["charter"]>;
}

/** How many partner rows a boot may declare — `nearbyCityPartners` streams 3
 *  and a cluster ring is 4; 8 is slack, not a policy. */
const MAX_DECLARED_PARTNERS = 8;

/** The boot-supplied trade rows (`QuestHostDeps.tradePartners`), path-exact. */
function parsePartners(raw: unknown, path: string): NonNullable<TownPlayConfig["partners"]> {
  if (!Array.isArray(raw)) fail(path, "expected an array of partner rows (nearest first)");
  if (raw.length > MAX_DECLARED_PARTNERS) {
    fail(path, `too many entries (max ${MAX_DECLARED_PARTNERS}; got ${raw.length})`);
  }
  return raw.map((entry, i) => {
    const at = `${path}[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(at, "expected an object (allowed: key, at, geo, distanceM)");
    }
    const e = entry as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!["key", "at", "geo", "distanceM"].includes(k)) {
        fail(`${at}.${k}`, "unknown field (allowed: key, at, geo, distanceM)");
      }
    }
    if (typeof e.key !== "string" || !e.key.length) fail(`${at}.key`, "must be a non-empty settlement key string");
    const p = e.at;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      fail(`${at}.at`, "expected an object of sim coordinates ({ x, y })");
    }
    const pt = p as Record<string, unknown>;
    for (const k of Object.keys(pt)) {
      if (!["x", "y"].includes(k)) fail(`${at}.at.${k}`, "unknown field (allowed: x, y)");
    }
    for (const k of ["x", "y"] as const) {
      if (typeof pt[k] !== "number" || !Number.isFinite(pt[k])) fail(`${at}.at.${k}`, "must be a finite number");
    }
    // `geo` is what a distant town's GROUND says it can sell — absent is a
    // legitimate answer (a boot tier that knows where a partner is and nothing
    // else), and the barter clerk then reads its pure-hash proxy.
    const geo: NonNullable<TownPlayConfig["partners"]>[number]["geo"] = {};
    if ("geo" in e) {
      const g = e.geo;
      if (!g || typeof g !== "object" || Array.isArray(g)) {
        fail(`${at}.geo`, "expected an object (allowed: node, farmland, ore)");
      }
      const gr = g as Record<string, unknown>;
      for (const k of Object.keys(gr)) {
        if (!["node", "farmland", "ore"].includes(k)) {
          fail(`${at}.geo.${k}`, "unknown field (allowed: node, farmland, ore)");
        }
      }
      if ("node" in gr) {
        if (gr.node !== null && (typeof gr.node !== "string" || !gr.node.length)) {
          fail(`${at}.geo.node`, "must be a node-type string or null");
        }
        geo.node = gr.node as NonNullable<TownPlayConfig["partners"]>[number]["geo"]["node"];
      }
      for (const k of ["farmland", "ore"] as const) {
        if (!(k in gr)) continue;
        if (typeof gr[k] !== "number" || !Number.isFinite(gr[k])) fail(`${at}.geo.${k}`, "must be a finite number");
        geo[k] = gr[k] as number;
      }
    }
    // 🚨 A ROW WITHOUT A DISTANCE IS PRICED AT THE ABSTRACT `AWAY_DISTANCE_M`
    // and loses to every row that brought a real one — so a DECLARED row must
    // bring one. (The host's own seat keeps `distanceM` optional for boots that
    // genuinely do not know; a document that measured a cell does.)
    if (typeof e.distanceM !== "number" || !Number.isFinite(e.distanceM) || e.distanceM <= 0) {
      fail(`${at}.distanceM`, "must be a positive number of metres (the road's length, else the chord)");
    }
    return { key: e.key, at: { x: pt.x as number, y: pt.y as number }, geo, distanceM: e.distanceM };
  });
}

/** The declared supply box: glyph → positive count.
 *
 *  EXPORTED for the SOLAR document's `premise_stock` (space-game.ts
 *  `PREMISE_FIELDS`): the founders' kit and a town's declared stock are the
 *  same object — one validator, one error string, one shape. A second copy
 *  over there would be a second answer to "what is a supply box". */
export function parseStock(raw: unknown, path: string): Record<string, number> {
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

/** PER-HAMLET OVERRIDES for the `cluster` ring (trade-topology-round U-1):
 *  index-aligned entries of the SAME town config the primary takes. The
 *  author's word is `population`; the config's founding seam says `startPop`,
 *  remapped here exactly as `parseTownWorld` remaps the primary's. */
function parseHamlets(raw: unknown, path: string): NonNullable<TownPlayConfig["hamlets"]> {
  if (!Array.isArray(raw)) fail(path, "expected an array of per-hamlet settings (index-aligned with `cluster`)");
  if (raw.length > 4) fail(path, `too many entries (max 4, one per hamlet; got ${raw.length})`);
  return raw.map((entry, i) => {
    const at = `${path}[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(at, "expected an object (allowed: population, days, seed, charter)");
    }
    const e = entry as Record<string, unknown>;
    const out: NonNullable<TownPlayConfig["hamlets"]>[number] = {};
    for (const k of Object.keys(e)) {
      if (!["population", "days", "seed", "charter"].includes(k)) {
        fail(`${at}.${k}`, "unknown field (allowed: population, days, seed, charter)");
      }
    }
    const int = (key: string, min: number, max: number): number => {
      const v = e[key];
      if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v < min || v > max) {
        fail(`${at}.${key}`, `must be an integer in ${min}..${max}`);
      }
      return v;
    };
    if ("population" in e) out.startPop = int("population", 1, 10000);
    if ("days" in e) out.days = int("days", 0, 5000);
    if ("seed" in e) out.seed = int("seed", 0, 0xffffffff);
    // ONE CHARTER VALIDATOR (planet-boot S2) — the same endowment box the
    // DECLARED cell's `charter` field takes, so the two cannot drift apart in
    // what they accept or in what they say when they refuse.
    if ("charter" in e) out.charter = parseCharter(e.charter, `${at}.charter`);
    return out;
  });
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
  // 📜 The DECLARED CELL rides through unrenamed — `climate`, `biome`, `eco`,
  // `charter` and `partners` are `TownPlayConfig`'s own words, so the gate's
  // output IS the config and `declaredEnvironment` reads it straight off.
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

/**
 * THE TOWN BUILD ITSELF, from a CONFIG — the tail `buildTownScope` used to
 * inline (scale → deltas → `buildTownPlay` → certification).
 *
 * ⚖️ ONE TOWN BUILD, TWO ENTRANCES (planet-boot round S1). A town reached from
 * a DOCUMENT comes through `buildTownScope`, which gates `game.world` against
 * `TOWN_WORLD_FIELDS` first. A town reached from a FOUNDED SITE on a planet
 * (`interaction/town/planet-scope.ts` → `siteTownConfig`) has no such document:
 * its config is MEASURED off the substrate, so there is nothing to validate and
 * the solar document's own gate already ran. Both must nonetheless build and
 * CERTIFY identically — so the four lines that do that live here once, and the
 * planet arm calls them instead of growing a second copy that drifts.
 *
 * Mutates `config` exactly as the inlined tail did (scale + deltas ride the
 * config into `buildTownPlay`), so a document build is byte-identical.
 */
export function buildTownScopeFromConfig(
  config: TownPlayConfig,
  scale: GameSettings["scale"],
  label = "game",
  restoreDeltas?: SerializedTownDeltas,
): { spec: TownScopeWorldSpec; play: TownPlay } {
  // SPACE-TIME COMPRESSION sizes the plan's SERVICE DISTRICTS (needs-aware
  // construction): faster-draining needs ⇒ smaller walk radius ⇒ denser
  // markets and wells. A silent doc gets the street clock — the town
  // scope's documented fallback while goods.ts is hard-paced to the 240 s
  // day (scale.ts DOLLHOUSE_SCALE).
  config.scale = scale ? resolveWorldScale(scale) : DOLLHOUSE_SCALE;
  // #49 — the save, if one was handed in. It rides the config exactly as
  // `siteTownConfig`'s does, so `buildTownPlay` → `createTownDeltas` is the
  // one restore path and this seat adds no second one.
  if (restoreDeltas) config.deltas = restoreDeltas;

  const play = buildTownPlay(config);
  // The quest bundle drawn from the town's residents/goods must PROVE itself
  // (the goal-tree gauntlet + the greedy-sim playthrough) — a town whose
  // quests aren't winnable is refused, not shipped.
  const cert = certifyCreatureQuestWorld(play.bundle.game);
  if (!cert.ok) {
    fail(`${label}.world`, `town failed ${cert.stage} certification: ${cert.errors.join("; ")}`);
  }
  return { spec: { config }, play };
}

/** Build the living town a `scope: "town"` document describes. Deterministic
 *  end to end (same seed ⇒ same town). */
export function buildTownScope(
  settings: GameSettings,
  label = "game",
  /**
   * ⚖️ #49 STAGE 2 — THE SAVE-RESTORE DOOR, for a build that has one.
   *
   * A world DOCUMENT cannot carry deltas (`TOWN_WORLD_FIELDS` has no such
   * field, deliberately: a document describes a world, a save describes a
   * playthrough of it). The browser's own restore path therefore never comes
   * through here — it arrives as `TownPlayConfig.deltas` from
   * `siteTownConfig`. This parameter is that same seat, opened to a caller
   * that builds the scope from a document AND holds a save — which today is
   * the headless harness, where the whole persistence law would otherwise be
   * unprovable at play level.
   *
   * Absent ⇒ byte-identical to every build that shipped.
   */
  restoreDeltas?: SerializedTownDeltas,
): BuiltTownScope {
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
  // …then the build itself — scale, the #49 save seat, `buildTownPlay` and the
  // quest certification (`buildTownScopeFromConfig`, shared with the planet arm).
  const { play } = buildTownScopeFromConfig(spec.config, settings.scale, label, restoreDeltas);
  // Focus resolves against the BUILT town (it names one of its houses) — and a
  // defined family must live exactly where the focus (and the build) put it.
  const focus = resolveTownFocus(play, settings.initialFocus, label);
  if (defined.family && focus && play.familyHouse !== null && focus.house !== play.familyHouse) {
    fail(`${label}.initial_focus`, `the defined family lives in house ${play.familyHouse} — focus it (or omit the index)`);
  }
  return { spec, play, focus };
}
