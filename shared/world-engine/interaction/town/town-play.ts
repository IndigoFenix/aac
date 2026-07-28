// shared/world-engine/interaction/town/town-play.ts
//
// ONE SERIALIZABLE CONFIG → a whole live town session. The config crosses
// the games bridge (an iframe boundary — no live objects), and the player
// rebuilds the identical session from it: same seed ⇒ same town, same
// plan, same quests, same stage. Determinism IS the transport.
//
// The payload rides the existing `load_game` channel, discriminated by
// `engine: "town-play"` — hosts that predate it reject it harmlessly.

import { compileEconomy, type CompiledEconomy, type EconomyDoc } from "@shared/world-engine/kernel/modules/economy/index.js";
import { HOUSEHOLD } from "@shared/world-engine/kernel/town/goods.js";
import { createTownWorld, type TownWorld } from "@shared/world-engine/kernel/town/town-world.js";
import {
  FOUNDING_AGE_DAYS, PLAZA_WELL, townPlanSteps, wellVergePoint, type TownHouse, type TownPlan,
} from "@shared/world-engine/kernel/town/plan.js";
import { WELL_FOUND_MASS, foundServicePoints } from "@shared/world-engine/kernel/town/districts.js";
import { buildTownQuestGame, type TownQuestBundle } from "@shared/world-engine/interaction/town/town-quests.js";
import { createTownStageSteps, type TownStage } from "@shared/world-engine/interaction/town/town-stage.js";
import { resolveWorkstationRegistry } from "@shared/world-engine/kernel/town/workstations.js";
import type { WorldArchitectureSpec } from "@shared/world-engine/culture.js";
import { TOWN_HOUSE_PALETTE } from "@shared/world-engine/interaction/dialogue/directions.js";
import {
  createTownDeltas, seedFoundingWorkshops, type FoundedBuilding, type SerializedTownDeltas, type TownDeltas,
} from "@shared/world-engine/kernel/town/construction.js";
import { resolveStructure, type StructureSpec } from "@shared/world-engine/kernel/town/structures.js";
import { serviceRadiusM, type WorldScale } from "@shared/world-engine/scale.js";

export interface TownPlayConfig {
  seed: number;
  /** Days the town has lived before the visit (default 220). */
  days?: number;
  /** Quest-giving residents (0..3; default 0 — no quests unless asked). */
  questCount?: number;
  /** THE BUILD-UP KNOB (storeys above ground under housing pressure) —
   *  capability × cost, the host's judgment. Default 0: a village
   *  spreads, it doesn't rise. */
  buildUp?: number;
  syntax?: "a" | "b" | "c";
  locale?: string;
  // ── The FOUNDING (optional — defaults are brookmill, the standalone
  //    village). A host descending from a map sets all three so the town
  //    is the SITE's town: charter from its substrate box, population from
  //    its crowd, key naming it. Plain numbers/strings — the payload stays
  //    the transport.
  /** The settlement key (street-plan identity + status lines). */
  key?: string;
  /** THE CONSTRUCTING SPECIES (creature registry id) — the town's residents'
   *  species, and the body its houses are BUILT FOR (doors, halls, furniture
   *  lanes all size to its speciesBodyRadius). Absent = the people default. */
  species?: string;
  /** The site's GROUND CHARACTER. The town build is terrain-blind (plan/
   *  stage/sim are plan-view 2D); the HOST maps this to a GroundSampler so
   *  the whole session is PLACED on real relief (engine ground seam).
   *  "hills" = synthetic rolling relief; "planet" = REAL planet terrain
   *  charted at a founding site (planet/walk-chart.ts). Default "flat". */
  terrain?: "flat" | "hills" | "planet";
  /** NEIGHBOR HAMLETS streamed into the same walking session (town-cluster:
   *  the window on the chart goes BEYOND one town). 0-4; default 0. Each
   *  neighbor is a full living town at a walkable offset. */
  cluster?: number;
  /** The site's endowment — what the substrate chartered. */
  charter?: { farmland: number; ore_access: number; timberland?: number };
  /** Founding population (primary species). */
  startPop?: number;
  /** DECLARED RESOURCES (city-founding): the supply box a spec hands the
   *  settlement — glyph → count, folded into the builder's-yard stock
   *  (deltas.stock) on a FRESH overlay. An age-0 town starts with exactly
   *  this (townStockSeed is houses-gated); an established town gets it on
   *  top of its usual yard seed. */
  stock?: Record<string, number>;
  /** WILDERNESS SURROUNDINGS (city-founding): scatter gatherable trees/rocks
   *  (and a few wild locals) over the town chart. A HOST flag — the build is
   *  untouched; quest-host seeds the scatter. Default: on for a founding-age
   *  town (days ≤ FOUNDING_AGE_DAYS), off for an established one. */
  wilderness?: boolean;
  /** A DEFINED FAMILY (the document's `entities.creatures`, town-interpreted):
   *  the focused household's hand-authored members. Mode "all" changes who is
   *  GENERATED (the other members never exist), so it lives in the config —
   *  replay rebuilds the same family. `house` absent = the roomiest house. */
  family?: TownFamily;
  /** Hand-authored items placed in the family house (`entities.objects`). */
  items?: TownDefinedItem[];
  /** CONSTRUCTION deltas to restore (construction v1): the serialized
   *  overlay of annexes / demolitions / placed furniture a previous
   *  session accrued. Same seed + same deltas ⇒ the identical mutated
   *  town — determinism stays the transport. */
  deltas?: SerializedTownDeltas;
  /** The BUILDABLE-STRUCTURE catalog override (①b) — a world doc that
   *  wants different structures swaps this list, nothing else (the same
   *  modding loop as the economy doc). Absent = TOWN_PLAY_STRUCTURES. */
  structures?: StructureSpec[];
  /** THE TRACKED-RESIDENT CAP (④ cohorts): souls simulated individually
   *  (named, full needs, dollhouse-visible). Households beyond it pool
   *  into per-district COHORTS (population.ts). Absent =
   *  TRACKED_RESIDENTS_DEFAULT; the tier is strictly dormant while the
   *  town fits under the cap. */
  trackedResidents?: number;
  /** THE NUMERAIRE override (E4 — nations P3): the commodity this town's
   *  quotes route through once its trade network is dense (money.ts).
   *  Must name a street good of the compiled economy (validated at
   *  build). Absent = the economy doc's own `numeraire` (TOWN_PLAY's is
   *  none — villages barter). */
  numeraire?: string;
  /** HOW THIS CULTURE BUILDS (game.culture.architecture): per-station
   *  placement overrides, resolved into the workstation registry the town
   *  furnishes from. Serializable (kind → { placement, room }); folded in at
   *  buildTownScope from the world's culture. Absent = the default placement. */
  architecture?: WorldArchitectureSpec;
  /** SPACE-TIME COMPRESSION (scale.ts, resolved): sizes the plan's SERVICE
   *  DISTRICTS — needs-aware construction founds market stalls on the
   *  hunger-cycle walk radius and wells on the thirst-cycle one, so a
   *  faster clock lays a denser town. Folded in at buildTownScope from the
   *  document's `game.scale`. Absent = the clock-blind legacy layout. */
  scale?: WorldScale;
}

export interface TownFamilyMember {
  /** Display name (debug panel, toasts). */
  name?: string;
  /** Species id (creature registry) — a frog_person aunt is legal. */
  species?: string;
  /** Outfit preset index (creatures/clothing.ts). */
  outfit?: number;
  /** Liked fruit kinds (dialogue preference + shelf choice). */
  likes?: string[];
}

/** A household PET — a family member of a non-person species. Its body is a
 *  `pet_<house>_<n>` avatar; behaviorally it runs the SAME need templates as
 *  everyone (one behavior model), with `grasp: false` capability — so it can't
 *  open the pantry, its hunger surfaces, and the family feeds its bowl through
 *  the general adoption rule. */
export interface TownFamilyPet {
  name?: string;
  /** Species id (creature registry) — default "quadruped". */
  species?: string;
  /** Liked fruit kinds. */
  likes?: string[];
}

export interface TownFamily {
  mode: "some" | "all";
  members: TownFamilyMember[];
  pets?: TownFamilyPet[];
  house?: number;
}

export interface TownDefinedItem {
  glyph: string;
  at: "table" | "box" | "floor";
}

/** The ONE roomiest-house policy — the focus resolver and the family builder
 *  must agree on where an index-less household lands. */
export function roomiestHouseIndex(houses: ReadonlyArray<{ index: number; w: number; h: number }>): number | null {
  let best: { index: number; area: number } | null = null;
  for (const h of houses) {
    const area = h.w * h.h;
    if (!best || area > best.area) best = { index: h.index, area };
  }
  return best ? best.index : null;
}

/** The bridge payload: the config plus its discriminant. */
export interface TownPlayPayload extends TownPlayConfig {
  engine: "town-play";
  engineVersion: 1;
}

export function isTownPlayPayload(v: unknown): v is TownPlayPayload {
  return (
    typeof v === "object" && v !== null &&
    (v as { engine?: unknown }).engine === "town-play" &&
    (v as { engineVersion?: unknown }).engineVersion === 1 &&
    typeof (v as { seed?: unknown }).seed === "number"
  );
}

/**
 * The symbol game's own village CONTENT: two goods whose vocabularies the
 * quest pools already speak (food → treats, cloth → clothing). Farms grow
 * the food (banked in the granary — the stockpile session deliveries
 * credit); the weaver clothes the town. Content, not machinery: a game
 * that wants a richer village swaps this doc, nothing else.
 */
export const TOWN_PLAY_ECONOMY: EconomyDoc = {
  stockpiles: [{ key: "granary", max: 400, construction: true }],
  commodities: [
    {
      key: "food", scalarMax: 200, perPersonDaily: 0.001,
      transport: { drift: "granary", driftRequiresConstruction: true },
      street: {
        capDays: 3, shopSec: 18, cartRations: 25, unit: "rations", producers: ["farm"], market: true,
        stockColor: "#e0b25c", boxLabel: "Pantry", errandName: "shopping",
      },
    },
    {
      // PURE INTERMEDIATE: cloth is the TAILOR's raw material (the weaver's
      // cloth_out → tailor's clothing_out chain below), NOT something a
      // household consumes — only CLOTHING is worn. So it carries no
      // `perPersonDaily` demand and no `street` box, the documented
      // convention for intermediates (ore, planks, wool). `transport` stays
      // ONLY to declare its cloth_out/_need/_got convention scalars, which
      // the sew process reads. Previously the household `street` box made
      // every resident run a spurious provision:cloth errand ("I'm going to
      // get cloth") for a material nothing in the home ever uses.
      key: "cloth", scalarMax: 50,
      transport: {},
    },
    {
      // The wool chain's last link: the TAILOR sews the weaver's cloth into
      // CLOTHING (the sheep → wool → cloth → clothing → store flow). Households
      // stock a wardrobe of it; residents visibly wear it (outfit presets).
      key: "clothing", scalarMax: 30, perPersonDaily: 0.0001,
      transport: {},
      street: {
        capDays: 20, shopSec: 20, cartRations: 8, unit: "outfits", producers: ["tailor"],
        stockColor: "#c47ba0", boxLabel: "Wardrobe", errandName: "clothes",
      },
    },
  ],
  buildings: [
    {
      key: "farm", countScalar: "farms", cap: { by: "farmland", rate: 1 / 60 },
      processes: [
        { id: "farm", input: "farmland", output: "grain_out", efficiency: 0.08, capacityRate: 5 },
        { id: "mill", input: "grain_out", output: "food_out", efficiency: 1 },
      ],
      vars: [{ name: "grain_out", max: 200 }],
      construction: { tier: "base", costs: [{ stockpile: "granary", amount: 20 }] },
      sells: ["food"], leansToward: "fertility", mapCap: 8, district: "farm",
      style: { color: "#7d9c53", w: 18, h: 12 }, vignette: { w: 5, h: 4 },
      glyph: "🌾", title: "🌾 Farmstead", info: ["{farms} farms."],
    },
    {
      key: "weaver", countScalar: "weavers", cap: { by: "population", rate: 0.002 },
      processes: [{ id: "weave", input: "farmland", output: "cloth_out", efficiency: 0.001, capacityRate: 2 }],
      construction: { tier: "industry", costs: [{ stockpile: "granary", amount: 25 }] },
      sells: ["cloth"], shelved: true, leansToward: null, mapCap: 2, district: "craft",
      style: { color: "#8a7fae", w: 14, h: 10 }, vignette: { w: 4, h: 4 },
      glyph: "🧵", title: "🧵 Weaver", info: ["{weavers} weavers."],
    },
    {
      // Sews the weaver's cloth into clothing — a process whose INPUT is the
      // cloth commodity's own site var, so the chain is real in the aggregate:
      // more cloth ⇒ more clothing; a starving weaver starves the tailor.
      key: "tailor", countScalar: "tailors", cap: { by: "population", rate: 0.0015 },
      processes: [{ id: "sew", input: "cloth_out", output: "clothing_out", efficiency: 0.5, capacityRate: 1 }],
      construction: { tier: "industry", costs: [{ stockpile: "granary", amount: 20 }] },
      sells: ["clothing"], shelved: true, leansToward: null, mapCap: 2, district: "craft",
      style: { color: "#a06a8a", w: 12, h: 10 }, vignette: { w: 4, h: 3 },
      glyph: "👕", title: "👕 Tailor", info: ["{tailors} tailors."],
    },
  ],
};

/**
 * The DEFAULT BUILDABLE-STRUCTURE CATALOG (①b) — world content beside
 * TOWN_PLAY_ECONOMY, one row per structure a spoken "build <x>" can raise.
 * Each row UNIFIES the two half-catalogs: `economy` references its
 * BuildingDef (produces/consumes/cap/district) by key; `program` is its
 * interior half (rooms.ts buildingRoomPlan). Costs are wood/stone — the
 * wilderness gathering stacks (founding.ts SITE_MATERIAL_GLYPHS), so the
 * frontier loop (gather → found → build) closes. A game that wants a
 * richer catalog swaps `TownPlayConfig.structures`, nothing else.
 */
export const TOWN_PLAY_STRUCTURES: StructureSpec[] = [
  {
    type: "house", glyph: "house", label: "house", role: "house",
    frame: "building",
    footprint: { w: 9, d: 8 },
    program: { sleepCells: 2, wet: true, kitchen: true },
    jobs: 0, costs: { wood: 6 }, buildDays: 1, color: "#a8875f", default: true,
  },
  {
    type: "farm", glyph: "farm", label: "farm", role: "work",
    frame: "building",
    footprint: { w: 18, d: 12 },
    program: { store: true }, economy: "farm",
    jobs: 2, costs: { wood: 8 }, buildDays: 2, color: "#7d9c53", default: true,
  },
  {
    type: "market", glyph: "market", label: "market", role: "work",
    frame: "building",
    footprint: { w: 14, d: 10 },
    program: {}, // an open hall — the stalls ARE the floor
    jobs: 2, costs: { wood: 10, stone: 4 }, buildDays: 2, color: "#c9803a", default: true,
  },
  {
    type: "workshop", glyph: "workshop", label: "workshop", role: "work",
    frame: "building",
    footprint: { w: 10, d: 8 },
    program: { store: true },
    jobs: 2, costs: { wood: 6, stone: 2 }, buildDays: 1.5, color: "#8a7fae", default: true,
  },
  {
    // THE EMPTY SHELL (pipeline ⑤b): a building with NO role — completes
    // as a bare doored box (open interior, nothing furnished, no staff,
    // no books). Rooms are added by interior subdivision; what it IS is
    // derived from what ends up inside (programs.ts buildingKindOf).
    type: "building", glyph: "building", label: "building", role: "work",
    footprint: { w: 10, d: 9 },
    program: {}, shell: true,
    jobs: 0, costs: { wood: 5 }, buildDays: 1, color: "#9b8a6d", default: true,
  },
];

/** The founding STOCK an established town keeps on hand (the builder's
 *  yard) — seeded once on a fresh overlay so a town-scope "build" has a
 *  town stock to draw on. A founded site brings its own gathered stock. */
export function townStockSeed(houses: number): Record<string, number> {
  if (houses <= 0) return {};
  return { wood: 20 + Math.min(40, houses), stone: 8 + Math.min(16, Math.floor(houses / 2)) };
}

/**
 * Materialize the FOUNDED BUILDINGS (①b construction deltas) into the built
 * plan: each becomes a TownWork row (geometry EXACTLY from its delta; the
 * interior program + roster jobs decorated from its StructureSpec), appended
 * after the base works so base indices never shift. Radius grows to cover
 * the lots (the manifold must hold them). An unknown type (a catalog swap
 * after founding) keeps the building standing with the generic program —
 * loudly, never silently (the ORDER path refuses unknown names up front).
 *
 * MOVE-IN (④): a house-role founding whose HOUSEHOLD fact is written
 * (population.ts moveInStep → admitHousehold) materializes as a REAL
 * plan.houses row instead — appended after the base houses in founding
 * order, so base indices never shift and rebuilds deal the same indices
 * forever. An empty founded house (no household yet) stays a work row,
 * exactly the ①b behavior.
 */
/** The plan.houses row a HOUSEHOLDED founded house materializes as — ONE
 *  shape shared by the rebuild path (applyFoundedBuildings) and the host's
 *  live conversion, so both deal identical rows. Geometry EXACTLY from the
 *  delta; index appends at the tail (base indices never shift). */
export function foundedHouseRow(
  plan: Pick<TownPlan, "houses">,
  b: FoundedBuilding,
  spec: StructureSpec,
): TownHouse {
  return {
    // Max+1, not length: stall conversions leave gaps in the base index
    // sequence, and a resident id (`resident_<index>_<m>`) must never
    // collide with a standing household's.
    index: plan.houses.reduce((m, h) => Math.max(m, h.index + 1), 0),
    dx: b.dx,
    dy: b.dy,
    w: b.w,
    h: b.h,
    door: b.door,
    color: spec.color,
    floors: 1,
    slot: b.slot,
  };
}

export function applyFoundedBuildings(
  plan: TownPlan,
  founded: readonly FoundedBuilding[],
  catalog: ReadonlyArray<StructureSpec>,
): void {
  for (const b of founded) {
    const spec = resolveStructure(catalog, b.type);
    if (!spec) {
      // eslint-disable-next-line no-console
      console.warn(`applyFoundedBuildings: no StructureSpec for founded "${b.type}" — generic interior`);
    }
    if (b.household && spec?.role === "house") {
      plan.houses.push(foundedHouseRow(plan, b, spec));
      const hr = Math.hypot(b.dx + b.w / 2, b.dy + b.h / 2) + Math.max(b.w, b.h) / 2 + 18;
      if (hr > plan.radius) plan.radius = hr;
      continue;
    }
    plan.works.push({
      type: b.type,
      dx: b.dx, dy: b.dy, w: b.w, h: b.h, door: b.door,
      color: spec?.color ?? "#9b8a6d",
      program: spec?.program ?? { store: true },
      ...(spec?.stations ? { stations: spec.stations } : {}),
      ...(spec?.shell ? { bare: true } : {}),
      // Staff only a COMPLETED building (the host writes `completed` and
      // re-decorates jobs when construction finishes live).
      jobs: b.completed ? (spec?.jobs ?? 0) : 0,
      foundedOrd: b.ord,
    });
    const rr = Math.hypot(b.dx + b.w / 2, b.dy + b.h / 2) + Math.max(b.w, b.h) / 2 + 18;
    if (rr > plan.radius) plan.radius = rr;
  }
}

const TOWN_KEY = "brookmill";
const CHARTER = { farmland: 420, ore_access: 0 };
const START_POP = 120;

export interface TownPlay {
  /** The config this session rebuilds from (replay = build again). */
  config: TownPlayConfig;
  town: TownWorld;
  eco: CompiledEconomy;
  plan: TownPlan;
  bundle: TownQuestBundle;
  stage: TownStage;
  /** THE CONSTRUCTION OVERLAY (construction v1) — the one mutable
   *  geometry store this session owns. The generators consume it as
   *  input, the stage watches its version, and the session serializes
   *  `deltas.toJSON()` alongside its stacks. */
  deltas: TownDeltas;
  /** The session's BUILDABLE-STRUCTURE catalog (config override or the
   *  default set) — what a spoken "build <x>" resolves against. */
  structures: StructureSpec[];
  /** Where the DEFINED FAMILY lives (config.family resolved against the built
   *  plan — the roomiest house when the config names none). Null = no family. */
  familyHouse: number | null;
}

/** Resolve the family house + the residents a mode-"all" family EXCLUDES from
 *  generation (members beyond the hand-authored ones never exist). */
function familyPlan(config: TownPlayConfig, plan: TownPlan): { house: number | null; excluded: string[] } {
  if (!config.family) return { house: null, excluded: [] };
  const house = config.family.house ?? roomiestHouseIndex(plan.houses);
  if (house === null) return { house: null, excluded: [] };
  const excluded: string[] = [];
  if (config.family.mode === "all") {
    for (let m = config.family.members.length; m < HOUSEHOLD; m++) {
      excluded.push(`resident_${house}_${m}`);
    }
  }
  return { house, excluded };
}

/**
 * `buildTownPlay`, staged: the identical pipeline with an `onStage` await
 * between the expensive steps (and the day-stepping in slices), so a live
 * host can found a town WHILE its frames keep drawing — the approach-load
 * story: a city's town builds as the ship flies in, not as a freeze when
 * the player presses Enter. Same config ⇒ byte-identical result to
 * `buildTownPlay` (the sync builder below is the spec; keep them in step).
 */
export async function buildTownPlayStaged(
  config: TownPlayConfig,
  onStage: (note: string) => void | Promise<void>,
): Promise<TownPlay> {
  const gen = buildTownPlaySteps(config);
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
    await onStage(r.value);
  }
}

/** Build the live session a config describes. Deterministic end to end. */
export function buildTownPlay(config: TownPlayConfig): TownPlay {
  const gen = buildTownPlaySteps(config);
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

/**
 * THE ONE FOUNDING PATH — a generator yielding a progress note before each
 * chunk of work. `buildTownPlay` drains it synchronously; `buildTownPlayStaged`
 * awaits between chunks. One implementation, so the two CANNOT drift (the old
 * pair of hand-kept twins is gone), and the chunks are FINE-GRAINED: day
 * slices, house batches (townPlanSteps), goods/residents/furniture batches
 * (createTownStageSteps) — each small enough that a live host never blocks a
 * frame on founding.
 */
export function* buildTownPlaySteps(config: TownPlayConfig): Generator<string, TownPlay> {
  const compiled = compileEconomy([TOWN_PLAY_ECONOMY], { construction: true });
  // E4 numeraire override: config wins over the doc; a medium naming no
  // street good fails at build, named (never a silent barter-forever).
  if (config.numeraire && !compiled.goods.some((g) => g.key === config.numeraire)) {
    throw new Error(
      `town-play: numeraire "${config.numeraire}" is not a street good (have: ${compiled.goods.map((g) => g.key).join(", ")})`,
    );
  }
  const eco: CompiledEconomy = config.numeraire ? { ...compiled, numeraire: config.numeraire } : compiled;
  const key = config.key ?? TOWN_KEY;
  const startPop = config.startPop ?? START_POP;
  const structures = config.structures ?? TOWN_PLAY_STRUCTURES;
  // Age 0 is legal (city-founding): a `days: 0` town is founded TODAY — the
  // fast-forward loop simply never runs and the clock starts at day 0.
  const days = Math.max(0, Math.min(5000, Math.floor(config.days ?? 220)));
  yield "chartering";
  const town = createTownWorld({
    economy: eco,
    charter: config.charter ?? CHARTER,
    startPop,
    // The founding farm (villageSeed's shape) — but a ZERO-POP founded site
    // starts with NO buildings at all (①b zero-building growth), and a
    // FOUNDING-AGE town (city-founding) hasn't built one yet either: its
    // farms are the ones its settlers raise through founded deltas.
    seedScalars: { farms: startPop > 0 && days > FOUNDING_AGE_DAYS ? 1 : 0 },
    key,
  });
  // Slicing the fast-forward is exactly equivalent to one big step (the
  // byte-identical test pins it) — 15-day slices keep each under a frame.
  const SLICE = 15;
  for (let d = 0; d < days; d += SLICE) {
    town.step(Math.min(SLICE, days - d));
    yield `day ${town.day}`;
  }
  yield "laying streets";
  // The construction overlay is created BEFORE the plan (①b): founded
  // buildings are generator INPUT — the street tree covers their slots and
  // base houses skip them. Restored from the config's serialized deltas
  // when a previous session accrued any.
  const deltas = createTownDeltas(config.deltas);
  // A restored session's street clock starts at 0 — an UNFINISHED build
  // restarts its remaining time from now (only the serialized `completed`
  // fact survives reboots; a build never waits on a clock that's gone).
  for (const b of deltas.founded()) {
    if (!b.completed && b.startedDay > 0) b.startedDay = 0;
  }
  // The transfer LEDGER resumes on the new clock the same way: a mid-haul
  // row's executor body is gone (back to pending — the load it carried is
  // serialized and a new hauler picks it up), and a standing leg's due time
  // belonged to the dead clock (due now — the route visibly resumes on the
  // first sweep instead of waiting out a phantom interval).
  for (const a of deltas.transfers.active()) {
    if (a.status === "moving") {
      a.status = "pending";
      delete a.executor;
    }
    if (a.mode === "scheduled") a.nextDueAt = 0;
  }
  // Distinct, nameable house colours so residents can point you to "the blue
  // house" (and the wall the player sees matches what they're told).
  const plan = yield* townPlanSteps(
    town, eco, key, config.seed, config.buildUp ?? 0, TOWN_HOUSE_PALETTE,
    deltas.founded().map((b) => b.slot),
    config.species,
    days,
    config.scale,
  );
  // Founded buildings materialize as work rows (geometry exactly from the
  // deltas; program/jobs from the structure catalog).
  applyFoundedBuildings(plan, deltas.founded(), structures);
  // FOUNDED HOUSEHOLDS get their service wells too (needs-aware districts):
  // move-ins joined plan.houses above, so the thirst pass runs once more
  // over the full set, anchored on the wells already laid — base wells stay
  // prefix-stable, founded quarters append theirs. The live session digs
  // the same wells at move-in (quest-host); this is the rebuild's half.
  if (config.scale && plan.wells) {
    const more = foundServicePoints(plan.houses, [PLAZA_WELL, ...plan.wells], plan.streets, {
      convenientM: serviceRadiusM(config.scale, "thirst"),
      foundMass: WELL_FOUND_MASS,
    });
    for (const h of more) plan.wells.push(wellVergePoint(h));
  }
  // FOUNDED PRODUCERS JOIN THE BOOKS (city-founding): a COMPLETED founded
  // building with an economy row raises its count scalar, exactly as live
  // completion injects it (quest-host stepFoundedConstruction) — a reloaded
  // farm keeps making food. AFTER the plan: the base layout must stay blind
  // to founded counts (the founded row IS the building; a pre-plan inject
  // doubled it with a phantom base farm).
  for (const b of deltas.founded()) {
    if (!b.completed) continue;
    const spec = resolveStructure(structures, b.type);
    const work = spec?.economy ? eco.works.find((w) => w.key === spec.economy) : null;
    if (work) town.inject(work.countScalar, 1);
  }
  yield "meeting residents";
  const bundle = buildTownQuestGame(town, eco, plan, key, {
    seed: config.seed,
    questCount: config.questCount,
    ...(config.syntax ? { syntax: config.syntax } : {}),
    ...(config.locale ? { locale: config.locale } : {}),
  });
  yield "raising the town";
  // The goal-tree player embodies the cast itself (npc_{nodeId} bodies at
  // the cast anchors), so the stage ships without spec-time cast NPCs.
  const fam = familyPlan(config, plan);
  // A FRESH overlay founds the town's OPTIONAL ROOMS (a deterministic
  // minority of houses raise a carpenter's workshop annex — construction
  // v1) and its BUILDER'S-YARD stock (①b: the town stock a "build" order
  // spends); a restored one already carries them.
  if (!config.deltas) {
    seedFoundingWorkshops({ x: plan.radius + 40, y: plan.radius + 40 }, plan, deltas, config.seed);
    Object.assign(deltas.stock, townStockSeed(plan.houses.length));
    // DECLARED RESOURCES (city-founding): the spec's supply box, folded into
    // the yard. An age-0 town has no houses, so this IS its whole stock.
    for (const [glyph, n] of Object.entries(config.stock ?? {})) {
      if (n > 0) deltas.stock[glyph] = (deltas.stock[glyph] ?? 0) + Math.floor(n);
    }
  }
  // A DEFINED family member's own species overrides the town's for its BODY
  // (the frog_person aunt walks and plans at her own girth).
  const famSpecies = (npcId: string): string | undefined => {
    const f = config.family;
    if (!f || fam.house === null) return undefined;
    const m = npcId.match(/^resident_(\d+)_(\d+)$/);
    if (m && Number(m[1]) === fam.house) return f.members[Number(m[2])]?.species;
    return undefined;
  };
  // How this culture BUILDS (game.culture.architecture) — the workstation
  // registry the town furnishes from (default placement when unset).
  const workstations = resolveWorkstationRegistry(config.architecture?.workstations);
  const stage = yield* createTownStageSteps(town, eco, plan, bundle, {
    seed: config.seed,
    castNpcs: false,
    deltas,
    registry: workstations,
    // Real-planet terrain ⇒ the planet is the reference frame: the town rect
    // is content, not walls (bodies/followers may leave town). Synthetic
    // ground ("flat"/"hills") has no world beyond the rect, so it stays bounded.
    onPlanet: config.terrain === "planet",
    residentSpecies: famSpecies,
    ...(fam.excluded.length ? { excludedResidents: fam.excluded } : {}),
  });
  return { config, town, eco, plan, bundle, stage, deltas, structures, familyHouse: fam.house };
}
