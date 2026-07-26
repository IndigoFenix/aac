// shared/world-engine/interaction/town/town-stage.ts
//
// The town HOSTED at avatar scale: a certified world-engine WorldSpec plus
// the streaming plan that materializes it around the player — buildings
// near you become real walls (setStructures), the quest CAST stands at its
// real anchors (the wanter's own doorstep, the vendor's own counter), and
// ambient residents embody mid-errand exactly where the goods clock says
// they are, within the engine's NPC budget.
//
// OPEN TOWN (decided 2026-07-09): the goal-tree artifact keeps its formal
// root — a tree needs a spine to certify — but the stage builds NO gate and
// NO star. The locked door was a placeholder; a town session is open-ended
// until real win conditions are designed.
//
// Body-authority, restated: this module drives resident BODIES from the
// town's errand clock (NpcErrand points = the goods layer's walkTo, the
// same closed form grand-dream's streets run). The creature sim never
// steers a body; conversation freezes one, and the cycle resumes on its
// own clock afterwards.

import {
  certifyWorldSpec,
  type BuildingSpec,
  type NpcSpec,
  type ObjectSpec,
  type RoadPath,
  type WorldSpec,
} from "@shared/world-engine/index.js";
import type { CompiledEconomy } from "@shared/world-engine/kernel/modules/economy/index.js";
import { probesOn } from "@shared/world-engine/perf-probes.js";
import { houseFurniture, workFurniture } from "@shared/world-engine/kernel/town/furniture.js";
import { buildingRoomPlan, houseRoomPlan } from "@shared/world-engine/kernel/town/rooms.js";
import { workProgram, type BuildingProgram } from "@shared/world-engine/kernel/town/stations.js";
import type { WorkstationRegistry } from "@shared/world-engine/kernel/town/workstations.js";
import type { TownHost } from "@shared/world-engine/kernel/town/host.js";
import type { TownWorld } from "@shared/world-engine/kernel/town/town-world.js";
import type { TownHouse, TownPlan, TownWork } from "@shared/world-engine/kernel/town/plan.js";
import {
  ERRAND_WALK, FOOD_DAY_SEC, HOUSEHOLD, doorTransit, houseDoorstep, streetGoods, type TownGoods,
} from "@shared/world-engine/kernel/town/goods.js";
import {
  annexWorldRect,
  foundedBuildingDone,
  isInteriorCandidate,
  workDeltaKey,
} from "@shared/world-engine/kernel/town/construction.js";
import { createTownTrade, type TownTrade } from "@shared/world-engine/kernel/town/trade.js";
import { createResidentModel, STREET_NPCS } from "@shared/world-engine/kernel/town/residents.js";
import type { TownQuestBundle } from "@shared/world-engine/interaction/town/town-quests.js";
import type { TownDeltas } from "@shared/world-engine/kernel/town/construction.js";

export { residentId } from "@shared/world-engine/kernel/town/residents.js";

// Structure streaming, the 2D manager's numbers: buildings become real
// walls inside the load radius and stay until they drift past the unload
// radius (hysteresis) — grand-dream's STRUCT_LOAD_R / STRUCT_UNLOAD_R.
const STRUCT_LOAD_R = 100;
const STRUCT_UNLOAD_R = 130;
// INTERIOR STAGING ON DEMAND (round 5c): a far house stages only its SHELL
// (the historical single `h_<i>` BuildingSpec — one room, one street door);
// the full room plan (~4-6 buildings per house, each with walls + interior
// doors) swaps in when the house is NEAR or WATCHED, and back out once it's
// concealed and far again. That keeps the per-frame structure scans
// (collision, door connectivity, roof visibility) proportional to the
// houses you could actually walk into, not 5× every roof in wall range.
// The swap runs only while the interior is UNWATCHED (concealed), so no
// body ever gets wedged in a materializing partition in front of the
// camera — and a watched house is always FULL (the dollhouse never sheds
// its rooms).
export const INTERIOR_LOAD_R = 45;
export const INTERIOR_UNLOAD_R = 60;

export interface TownStageOpts {
  seed: number;
  /** Resident-body budget (defaults to the shared STREET_NPCS — these
   *  are pure steering bodies; pass the same number to
   *  `runWorldHost({ maxNpcs })` plus the cast's own count). */
  ambient?: number;
  /** Ship the quest cast as spec-time NPCs (default true). Hosts that
   *  embody the cast themselves (the goal-tree player raises npc_{nodeId}
   *  bodies from layout figures) pass false — the cast still reserves its
   *  share of the NPC budget, and castSpawns still carries the anchors. */
  castNpcs?: boolean;
  /** Resident ids that must NEVER be generated (a mode-"all" DEFINED family:
   *  the household's other members don't exist). Feeds the resident model's
   *  exclusion set — roles hand down around them. */
  excludedResidents?: string[];
  /** THE CONSTRUCTION OVERLAY (construction v1). The stage consumes each
   *  house's delta when raising its rooms/furniture, and `frame()` watches
   *  `deltas.version` — a bumped building re-plans, re-furnishes and
   *  re-stages the SAME frame (a visible new annex passes through a brief
   *  door-less SCAFFOLD first). Absent ⇒ the pure base town, unchanged. */
  deltas?: TownDeltas;
  /** Per-resident SPECIES override (a defined family's frog_person aunt, a
   *  pet) — the BODY's collision/planning girth (NpcSpec.species). Falls
   *  back to the town's constructing species (plan.species). */
  residentSpecies?: (npcId: string) => string | undefined;
  /** True when the town stands on a REAL planet (embedded walk↔fly): the
   *  manifold is marked unbounded — its rect stays the content/procgen
   *  extent, but physics never walls a body at the town edge (the planet is
   *  the reference frame; followers can leave). Standalone town-scope worlds
   *  (own canvas, synthetic ground) stay bounded. */
  onPlanet?: boolean;
  /** THE WORKSTATION REGISTRY this town furnishes from (game.culture.
   *  architecture, resolved). Absent = the default global registry. */
  registry?: WorkstationRegistry;
}

/** A CONSTRUCTION SITE (city-founding): an ordered-but-unbuilt lot. A
 *  marked plot, NOT a structure — flat ground marking in the renderer,
 *  reserved ground in the engine (walk through, never drop on), swapped
 *  for the real doored building at completion. World coords. */
export interface ConstructionSite {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** StructureSpec type ("house", "farm") — "annex" for a house's growth rect. */
  type: string;
}

export interface TownStageFrame {
  /** Full replacement set for host.setBuildings — null when unchanged.
   *  BUILDINGS, not flattened walls: the volumes carry the roofs, the
   *  see-inside fade and the indoor-avatar cull; the host lowers them
   *  into wall/door structures itself. */
  buildings: BuildingSpec[] | null;
  /** Full replacement set of CONSTRUCTION SITES — null when unchanged.
   *  The host paints them (view setSites) and reserves their ground
   *  (setReservedGround). */
  sites: ConstructionSite[] | null;
  /** Residents entering the world (host.addNpc). */
  add: NpcSpec[];
  /** Residents leaving it (host.removeNpc). */
  remove: string[];
  /** Fresh shopping trips (host.setNpcErrand) — once per cycle. */
  errands: Array<{ npcId: string; points: Array<{ x: number; y: number; dwell?: number }> }>;
  /** FURNITURE arriving with its house (host.addObject) — solid,
   *  openable fixtures; abstracted away when the house unloads. */
  addObjects: ObjectSpec[];
  /** Furniture leaving with its house (host.removeObject). */
  removeObjects: string[];
}

/** A clustered resident's OWN town, resolved from its reserved house range
 *  (town-cluster.ts): live books + geometry, plus the offset lifting member
 *  stage coordinates into the session's (window) coordinates. */
export interface ClusterHouseCtx {
  town: TownWorld;
  eco: CompiledEconomy;
  plan: TownPlan;
  goods: TownGoods[];
  /** The house index in the member's OWN plan (raw − houseBase). */
  localHouse: number;
  /** Member stage coords + offset = window coords. */
  offset: { x: number; y: number };
  /** The member town's center in WINDOW coords (its cluster `at`). */
  center: { x: number; y: number };
}

/** A neighbor town as a TRADE PARTNER (city-expansion ⑤): its key, its
 *  center in window coords, and — when the member is a REAL sim — the live
 *  books barter reads (scarcity off eco fills/scalars) plus the yard stack
 *  `town:<key>` transfers alias. `books` null = a bodies-only member: the
 *  barter layer falls back to its closed-form stub proxy. Structural (no
 *  TownPlay import — town-play imports this module). */
export interface ClusterPartner {
  key: string;
  at: { x: number; y: number };
  books: { town: TownWorld; eco: CompiledEconomy; stock: Record<string, number> } | null;
}

export interface TownStage {
  /** Certified sparse world: ground, plaza spawn, and the quest cast. */
  spec: WorldSpec;
  center: { x: number; y: number };
  /** The town's street network as flat ground ribbons (world coords) — the 3D
   *  view paints these on the field. Render-only; the sim never reads them. The
   *  same organic street tree the 2D map draws (streets.ts), just the whole set
   *  (a single town fits one manifold; no streaming). */
  roads: RoadPath[];
  /** Where each cast member stands (fulfill node id → world point). */
  castSpawns: Map<string, { x: number; y: number }>;
  /** The town's street goods in SLOT order — the resources ambient residents shop
   *  for (member `m` of a house is the runner for `goods[m]`). Surfaced so the
   *  dialogue layer can give a resident its shopping want as a real need
   *  (npc-behavior-and-town-economy.md §8). Same list the resident model runs on. */
  goods: TownGoods[];
  /** The town's INTERCITY trade line (kernel/town/trade.ts): the caravan from
   *  the abstract partner, its gate/route, and the depot crates' clocks. Null
   *  when the town has no road out. */
  trade: TownTrade | null;
  /** CLUSTER seam (composite stages only — town-cluster.ts): resolve a
   *  resident's reserved-range house index (≥1000) to its OWN town's context.
   *  Null for the primary's houses (<1000); absent on single-town stages.
   *  `partners` (city-expansion ⑤) lists every neighbor as a TRADE PARTNER —
   *  key, window-coord center, and its live TownPlay when it is a REAL sim
   *  (null = a bodies-only member; barter falls back to the stub proxy). */
  cluster?: {
    resolveHouse(houseIndex: number): ClusterHouseCtx | null;
    partners?(): ClusterPartner[];
  };
  /**
   * Stream the town around the player. `bodyPos` reports a live body's
   * current position (the resident model's lock + candidacy read REAL
   * positions, not spawn points); `visibleR` is the camera's world
   * reach, feeding only the pop-in rule. Mechanics never depend on the
   * renderer — a top-down map and the 3D view pass different visibleR
   * and get the SAME people in the SAME places.
   */
  frame(
    p: { x: number; y: number },
    tSec: number,
    bodyPos?: (id: string) => { x: number; y: number } | null,
    visibleR?: number,
    isVisible?: (houseIndex: number) => boolean,
    /** ROOM-granular visibility (building id → roof open / occupied) —
     *  refines the resident view guard: a visible house's unrevealed back
     *  rooms stay legitimate spawn cover (residents.ts). */
    isRoomVisible?: (buildingId: string) => boolean,
    /** COHORT TIER (④, population.ts): households of a POOLED house are
     *  statistical — the model streams no bodies for them (their walls,
     *  furniture and pantry closed forms stand untouched). Omit = every
     *  house tracked, byte-identical to before. */
    isHousePooled?: (houseIndex: number) => boolean,
    /** AMBIENT CROWD BUDGET override (view-distance-lod-tiers.md Phase 2): max
     *  street bodies to embody this frame, ramped by camera→town distance so the
     *  crowd streams in gradually on descent. Omit = the stage's build-time
     *  budget (STREET_NPCS). */
    crowdBudget?: number,
    /** RECRUITED CIVIC WORKERS (pipeline ⑥): busy bodies are PINNED — never
     *  culled, never handed trips — until the host frees them. */
    isBusy?: (id: string) => boolean,
  ): TownStageFrame;
  /** The ACTIVE construction sites right now (world coords) — the sim-side
   *  query twin of the frame's `sites` push (reserved-ground checks read
   *  this without waiting for a changed frame). Absent on composite
   *  cluster stages. */
  activeSites?(): ConstructionSite[];
  /** The streamer's CURRENT per-lot materialization — house lots by their
   *  plan `index`, work lots by their plan array position. THE single
   *  source of truth for the static-plan↔live handoff: a proxy hides iff
   *  its lot is in these sets (exactly one of low-res instance / live twin
   *  renders — never both, never neither). Absent on composite cluster
   *  stages. */
  loadedLots?(): { houses: ReadonlySet<number>; works: ReadonlySet<number> };
  /** DIAGNOSTIC passthrough (residents.ts explain): why is this member
   *  embodied or not right now? Absent on composite cluster stages. */
  explainResident?(
    p: { x: number; y: number },
    tSec: number,
    houseIndex: number,
    member: number,
    bodyPos: (id: string) => { x: number; y: number } | null,
    isVisible?: (houseIndex: number) => boolean,
  ): string;
  /** Ghost self-heal passthrough (residents.ts dropBody). */
  dropResidentBody?(id: string): void;
}


const houseBuilding = (
  center: { x: number; y: number },
  id: string,
  b: { dx: number; dy: number; w: number; h: number; door: TownHouse["door"]; color: string; floors?: number },
): BuildingSpec => {
  const along = b.door === "north" || b.door === "south" ? b.w : b.h;
  return {
    id,
    footprint: { x: center.x + b.dx, y: center.y + b.dy, w: b.w, h: b.h },
    // Storeys from the plan (the build-up knob). Upper floors are visual
    // for now — no stairs staged; ground floor keeps every mechanic.
    floors: b.floors ?? 1,
    stairs: false,
    wallThickness: 0.4,
    // Door gap centered on its wall — the same midpoint houseDoorstep /
    // doorTransit aim at (grand-dream's centred-gap lesson).
    doorways: [{ edge: b.door, offset: along / 2, width: 2 }],
    color: b.color,
  };
};

export function createTownStage(
  town: TownHost,
  eco: CompiledEconomy,
  plan: TownPlan,
  bundle: TownQuestBundle,
  opts: TownStageOpts,
): TownStage {
  // The generator IS the implementation; the sync path drains it, so the
  // two can never drift (staged output is byte-identical by construction).
  const gen = createTownStageSteps(town, eco, plan, bundle, opts);
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

/**
 * The stage raised in RESUMABLE STEPS: yields a progress note at each
 * natural boundary (spec certified, goods stocked, residents modeled,
 * furniture batches) so a live host can spread the founding's second-biggest
 * synchronous lump across frames (the approach-load story).
 */
export function* createTownStageSteps(
  town: TownHost,
  eco: CompiledEconomy,
  plan: TownPlan,
  bundle: TownQuestBundle,
  opts: TownStageOpts,
): Generator<string, TownStage> {
  const side = plan.radius * 2 + 80;
  const center = { x: side / 2, y: side / 2 };
  const siteKey = plan.key;

  // Roads: the organic street tree (streets.ts), town-local points lifted into
  // world coords. Widths follow the 2D map's read — arterials broader than the
  // branch lanes — so the same hierarchy shows underfoot. The PLAZA RING is
  // topology only (the root the arterials gate on), NEVER pavement: a painted
  // circle at every town's heart read as artificial (user, 2026-07-22). The
  // plaza is open ground the arterials converge on.
  const roads: RoadPath[] = plan.streets.streets
    .filter(s => s.pts.length >= 2 && !s.ring)
    .map(s => ({
      points: s.pts.map(p => ({ x: center.x + p.x, y: center.y + p.y })),
      width: s.gen === 0 ? 3.4 : 2.4,
    }));

  // --- The quest cast: always-on NPCs at their REAL town anchors. ---
  const castSpawns = new Map<string, { x: number; y: number }>();
  const labelOf = (entityId: string): string | undefined =>
    bundle.game.entities.find(e => e.id === entityId)?.label;
  const castNpcs: NpcSpec[] = bundle.cast.map(entry => {
    let at: { x: number; y: number };
    if (entry.role === "wanter") {
      const house = plan.houses.find(h => h.index === entry.house) ?? plan.houses[0];
      at = house ? houseDoorstep(center, house) : { x: center.x, y: center.y + 6 };
    } else {
      const wk: TownWork | undefined =
        plan.works.find(w => w.type === entry.workType) ?? plan.works.find(w => w.type === "hall");
      at = wk ? doorTransit(center, wk).outside : { x: center.x, y: center.y - 6 };
    }
    castSpawns.set(entry.nodeId, at);
    return {
      id: entry.npcEntityId,
      x: at.x,
      y: at.y,
      ...(plan.species ? { species: plan.species } : {}),
      ...(labelOf(entry.npcEntityId) ? { name: labelOf(entry.npcEntityId) } : {}),
      // A quest-giver is a resident with FROZEN needs (a fixed puzzle ask) — the
      // flag that sets it apart from the ambient residents below (whose needs
      // drift on the town clock). Same kind of NPC; see docs/TOWN_AND_NPCS.md.
      needsFrozen: true,
      behavior: { movement: "stationary" as const, conversationRadius: 5 },
    };
  });

  const raw: WorldSpec = {
    engine: "world",
    engineVersion: 1,
    meta: {
      title: bundle.game.meta.title,
      description: "A living town — its people, stalls and needs stream in around you.",
      locale: bundle.game.meta.locale,
      theme: `a ${plan.biome} town going about its day`,
    },
    manifold: { kind: "flat", width: side, height: side, ...(opts.onPlanet ? { bounded: false } : {}) },
    terrain: { kind: "flat", groundColor: plan.groundColor },
    // Plaza CENTER — the open band between the hall (north side) and the
    // market hall (south side); never inside either footprint.
    spawns: [{ id: "plaza", x: center.x, y: center.y }],
    objects: [],
    npcs: opts.castNpcs === false ? [] : castNpcs,
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  };
  const cert = certifyWorldSpec(raw);
  if (!cert.ok) {
    throw new Error(`createTownStage(${siteKey}): spec failed certification: ${JSON.stringify(cert.errors)}`);
  }

  // --- Ambient residents: the founding good's shoppers, nearest first. ---
  yield "stocking stalls";
  const goods: TownGoods[] = streetGoods(town, eco, { key: siteKey, center, plan }, opts.seed);
  // The INTERCITY line: a caravan a day, exporting ~a third of the food draw
  // (the surplus the aggregate doesn't eat), importing trinkets. The partner
  // stays abstract until hierarchical-cells lands real neighbors.
  const foodGood = goods.find((g) => g.good.key === "food");
  const trade = foodGood
    ? createTownTrade(center, plan, plan.streets, opts.seed, {
        exportGood: "food",
        exportDaily: plan.houses.length * HOUSEHOLD * foodGood.good.perCapitaDaily * 0.3,
      })
    : null;
  // The cast holds its NPC-budget share whether it ships in the spec or
  // the host embodies it itself.
  // RESIDENTS: the shared model owns the mechanics (who exists where,
  // doing what) — the same rules the 2D canvas manager runs. This stage
  // only maps its output onto host calls.
  yield "waking residents";
  const residents = createResidentModel({
    center, plan, goods, seed: opts.seed,
    ...(opts.excludedResidents?.length ? { excluded: new Set(opts.excludedResidents) } : {}),
  });
  const bodyBudget = Math.max(0, (opts.ambient ?? STREET_NPCS) - bundle.cast.length);

  /** Non-house buildings (works) currently lowered into walls. */
  const solid = new Set<string>();
  const buildingById = new Map<string, BuildingSpec>();
  let allBuildings: Array<{ id: string; cx: number; cy: number }> = [];
  // A NEAR/WATCHED house raises ONE BuildingSpec PER ROOM
  // (kernel/town/rooms.ts) — the living room keeps the historical
  // `h_<index>` id; the engine's door-routing/visibility/cutaway machinery
  // is already room-native. A FAR house keeps only its SHELL (the same
  // `h_<index>` id over the whole footprint, one street door) — interiors
  // stage on demand (INTERIOR_LOAD_R above). Concealed trips still route
  // fine: their legs end at living-rect anchors, which the shell contains.
  // All rooms share the house's color and storeys (upper floors tile the
  // footprint, still visual-only).
  interface HouseStaging {
    house: TownHouse;
    /** The far form: the historical footprint box, PLUS one door-less box
     *  per annex (construction v1 — the annex ids persist across the
     *  shell↔full swap, so door states and routing anchors survive). */
    shell: BuildingSpec[];
    full: BuildingSpec[];
    cx: number;
    cy: number;
  }
  const houseStagings: HouseStaging[] = [];
  /** Staged houses (absent = unloaded) — the hysteresis record. */
  const houseMode = new Map<number, "shell" | "full">();
  /** Construction-delta revision each house was last staged at. */
  const stagedRev = new Map<number, number>();
  /** New annex rooms of a WATCHED house stand as a marked SITE (flat
   *  ground, no walls — city-founding "construction sites") until this
   *  townClock second, then the doored room swaps in. The rect + owning
   *  house ride along for the site emission and the furniture deferral. */
  const scaffoldUntil = new Map<
    string,
    { until: number; rect: { x: number; y: number; w: number; h: number }; houseKey: string }
  >();
  const SCAFFOLD_S = 30;
  /** In-progress FOUNDED works' site markings, by plan work index. */
  const workSites = new Map<number, ConstructionSite>();
  /** Frame-over-frame site signature — sites emit on ANY change (including
   *  the first frame of a restored in-progress build), never else. */
  let lastSiteSig: string | null = null;
  const annexSiteOf = (id: string, s: { rect: { x: number; y: number; w: number; h: number } }): ConstructionSite =>
    ({ id: `site_${id}`, ...s.rect, type: "annex" });
  /** Pending-designation GROUND MARKINGS (⑤): a staked annex rect reads as
   *  a construction site while its materials gather. Interior designations
   *  skip — their ground is indoors (the cutaway shows the room when it
   *  lands). */
  const pendingSites = (): ConstructionSite[] => {
    const out: ConstructionSite[] = [];
    for (const p of opts.deltas?.annexSites() ?? []) {
      if (isInteriorCandidate(p.candidate)) continue;
      const m = /^h_(\d+)$/.exec(p.buildingKey);
      const h = m ? plan.houses.find((hh) => hh.index === Number(m[1])) : undefined;
      if (!h) continue;
      const r = annexWorldRect(center, h, p.candidate);
      out.push({ id: `site_pa_${p.ord}`, ...r, type: "annex" });
    }
    return out;
  };
  const activeSites = (): ConstructionSite[] => [
    ...workSites.values(),
    ...[...scaffoldUntil.entries()].map(([id, s]) => annexSiteOf(id, s)),
    ...pendingSites(),
  ];
  const houseStagingOf = (h: TownHouse): HouseStaging => {
    const delta = opts.deltas?.get(`h_${h.index}`);
    const rooms = houseRoomPlan(center, h, delta).rooms;
    const roomSpec = (room: (typeof rooms)[number]): BuildingSpec => ({
      id: room.id,
      footprint: room.rect,
      floors: h.floors ?? 1,
      stairs: false,
      wallThickness: 0.4,
      doorways: room.doorways,
      color: h.color,
    });
    const annexRooms = rooms.filter((r) => /_a\d+$/.test(r.id));
    return {
      house: h,
      shell: [
        houseBuilding(center, `h_${h.index}`, h),
        // Annexes keep their footprint (and id) in shell form — door-less
        // boxes, like the shell itself keeps only its street door.
        ...annexRooms.map((r) => ({ ...roomSpec(r), doorways: [] })),
      ],
      full: rooms.map(roomSpec),
      cx: center.x + h.dx + h.w / 2,
      cy: center.y + h.dy + h.h / 2,
    };
  };
  const registerHouse = (h: TownHouse): void => {
    houseStagings.push(houseStagingOf(h));
    stagedRev.set(h.index, opts.deltas?.get(`h_${h.index}`)?.rev ?? 0);
  };
  yield "furnishing homes";
  for (const h of plan.houses) registerHouse(h);
  // WORKS (§9 slice 5): a work building raises its PROGRAM's rooms
  // (buildingRoomPlan — the market/hall stay open, workshops grow a
  // stock room; a FOUNDED row carries its StructureSpec's program, so it
  // never falls through the generic default). Works are few, so their
  // interiors stay FULL (no shell/full hysteresis); every room registers
  // at the WORK's center so the whole interior loads and unloads as one —
  // never a half-built wall set at the load radius. The front room keeps
  // the historical `w_<i>` id.
  //
  // CONSTRUCTION IN PROGRESS (①b): a founded work whose build clock hasn't
  // run out stands as a door-less SCAFFOLD box on its lot (walls first,
  // doors + interior + furniture when the day passes — board words visibly
  // change the world). Registration is DYNAMIC: completion re-registers
  // the same frame, and works APPENDED live (a committed build order)
  // register on the deltas version bump.
  const workProgramOf = (wk: TownWork): BuildingProgram => wk.program ?? workProgram(wk.type);
  const workDoneAt = (wk: TownWork, tSec: number): boolean => {
    if (wk.foundedOrd === undefined) return true;
    const b = opts.deltas?.founded().find((f) => f.ord === wk.foundedOrd);
    return b ? foundedBuildingDone(b, tSec / FOOD_DAY_SEC) : true;
  };
  const workPlans: Array<ReturnType<typeof buildingRoomPlan>> = [];
  /** Room/scaffold ids each work currently registers (re-registration clears). */
  const workIds = new Map<number, string[]>();
  /** Whether each work stood COMPLETE at its last registration. */
  const workBuilt = new Map<number, boolean>();
  /** The delta rev each work last staged with (⑤b — a founded shell's
   *  interior rooms re-register on its rev bump, the house pattern). */
  const workStagedRev = new Map<number, number>();
  let _errLogAt = -Infinity; // TEMP stage-errands probe pacing
  const registerWork = (i: number, tSec: number): void => {
    const wk = plan.works[i]!;
    const cx = center.x + wk.dx + wk.w / 2;
    const cy = center.y + wk.dy + wk.h / 2;
    // Clear the previous registration (completion swaps scaffold → rooms).
    for (const id of workIds.get(i) ?? []) {
      buildingById.delete(id);
      solid.delete(id);
    }
    const old = new Set(workIds.get(i) ?? []);
    if (old.size) allBuildings = allBuildings.filter((b) => !old.has(b.id));
    if (wk.vacated) {
      // VACATED (④ move-in): the row's household house stages under its
      // own `h_<index>` — the work row keeps its index (jobs/attendance
      // maps are positional) but registers nothing.
      workBuilt.set(i, true);
      workIds.set(i, []);
      workSites.delete(i);
      return;
    }
    const done = workDoneAt(wk, tSec);
    workBuilt.set(i, done);
    // The work's construction delta (⑤b): a founded shell's interior rooms
    // ride its `f_<ord>` delta — the plan re-derives from it here.
    const wkDelta = opts.deltas?.get(workDeltaKey(wk, i));
    workStagedRev.set(i, wkDelta?.rev ?? 0);
    workPlans[i] = buildingRoomPlan(center, i, wk, workProgramOf(wk), wkDelta);
    const ids: string[] = [];
    workSites.delete(i);
    if (!done) {
      // The SITE (city-founding "construction sites"): a marked plot, not
      // a structure — no walls registered, ground stays walkable; the
      // host paints the marking and reserves the lot against drops.
      workSites.set(i, {
        id: `site_w_${i}`,
        x: center.x + wk.dx,
        y: center.y + wk.dy,
        w: wk.w,
        h: wk.h,
        type: wk.type,
      });
    } else {
      for (const room of workPlans[i]!.rooms) {
        buildingById.set(room.id, {
          id: room.id,
          footprint: room.rect,
          floors: 1,
          stairs: false,
          wallThickness: 0.4,
          doorways: room.doorways,
          color: wk.color,
        });
        allBuildings.push({ id: room.id, cx, cy });
        ids.push(room.id);
      }
    }
    workIds.set(i, ids);
  };
  plan.works.forEach((_, i) => registerWork(i, 0));

  // FURNITURE per house (deterministic — same house, same room forever):
  // the goods chests at their errand corners, a cupboard, a table.
  const goodDefs = goods.map(g => ({ key: g.good.key, slot: g.good.slot }));
  const furnitureOf = new Map<string, ObjectSpec[]>();
  const toObjectSpec = (piece: ReturnType<typeof houseFurniture>[number]): ObjectSpec => ({
    id: piece.id,
    x: piece.x,
    y: piece.y,
    shape: "box" as const,
    radius: piece.radius,
    fixture: piece.kind,
    openable: piece.openable,
    facing: piece.facing,
    // Delivered-but-not-set-up pieces render tipped on their side (⑥).
    ...(piece.setUp !== undefined ? { setUp: piece.setUp } : {}),
    interactions: [],
    // A table and the pet's floor bowl SHOW their contents ("on"); the
    // lidded pieces hold theirs hidden ("in").
    contains: [{ relation: piece.kind === "table" || piece.kind === "bowl" ? ("on" as const) : ("in" as const), capacity: 2 }],
  });
  let laidOut = 0;
  for (const h of plan.houses) {
    // Hundreds of houses each lay out a roomful — breathe between batches.
    if (laidOut++ % 150 === 149) yield "furnishing homes";
    furnitureOf.set(
      `h_${h.index}`,
      houseFurniture(center, h, goodDefs, "", opts.deltas?.get(`h_${h.index}`), opts.registry).map(toObjectSpec),
    );
  }
  // Work interiors furnish from the town's registry (the culture's, or the
  // default — counter, stock chests + any StructureSpec.stations), gated on
  // show like a house's. A work UNDER CONSTRUCTION (①b) has no furniture until
  // its build clock runs out.
  const refreshWorkFurniture = (i: number): void => {
    const wk = plan.works[i]!;
    if (wk.vacated || !workBuilt.get(i)) {
      furnitureOf.delete(`w_${i}`);
      return;
    }
    const pieces = workFurniture(
      center, i, wk, workProgramOf(wk), "", opts.deltas?.get(workDeltaKey(wk, i)), opts.registry,
    );
    if (pieces.length) furnitureOf.set(`w_${i}`, pieces.map(toObjectSpec));
  };
  plan.works.forEach((_, i) => refreshWorkFurniture(i));
  /** House ids whose furniture is currently in the world. */
  const furnished = new Set<string>();
  /** Live hauler body ids (dawn-cart carriers, goods.ts `haul`). */
  const liveHaulers = new Set<string>();
  /** Haulers embody within this range of the player (meters). */
  const HAULER_EMBODY_R = 160;
  /** The overlay version the stage last reconciled (frame's dirty check). */
  let stagedVersion = opts.deltas?.version ?? 0;

  const frame = (
    p: { x: number; y: number },
    tSec: number,
    bodyPos: (id: string) => { x: number; y: number } | null = () => null,
    visibleR?: number,
    isVisible?: (houseIndex: number) => boolean,
    isRoomVisible?: (buildingId: string) => boolean,
    isHousePooled?: (houseIndex: number) => boolean,
    /** AMBIENT CROWD BUDGET override (view-distance-lod-tiers.md Phase 2): the
     *  max street bodies to embody THIS frame, ramped by camera→town distance so
     *  the crowd streams in a few per frame on descent instead of flooding all at
     *  once at the mount. Undefined = the stage's build-time budget. */
    crowdBudget?: number,
    /** RECRUITED CIVIC WORKERS (⑥): pinned bodies — see TownStage.frame. */
    isBusy?: (id: string) => boolean,
  ): TownStageFrame => {
    // The "interior on show" gate — shared by the interior staging, the
    // furniture and the residents (see the FURNITURE note below). No signal
    // ⇒ fall back to the raw footprint test (the 2D lab).
    const houseVisible = (h: TownHouse): boolean =>
      isVisible
        ? isVisible(h.index)
        : p.x > center.x + h.dx && p.x < center.x + h.dx + h.w &&
          p.y > center.y + h.dy && p.y < center.y + h.dy + h.h;

    // ── CONSTRUCTION DELTAS (v1): a bumped building re-plans, re-stages
    // and re-furnishes THIS frame. A watched house's new annex rooms pass
    // through a door-less SCAFFOLD box (SCAFFOLD_S of townClock) before
    // their real doored form swaps in — construction is visible, and no
    // door invites a body in while the walls materialize.
    let changed = false;
    const deltaRemoveObjects: string[] = [];
    // FOUNDED-WORK COMPLETION (①b): a build clock running out swaps the
    // scaffold for the real doored rooms + furniture the same frame.
    for (const [wi, done] of workBuilt) {
      if (done || !workDoneAt(plan.works[wi]!, tSec)) continue;
      const hadFurniture = furnished.has(`w_${wi}`);
      registerWork(wi, tSec);
      refreshWorkFurniture(wi);
      if (hadFurniture) furnished.delete(`w_${wi}`);
      changed = true;
    }
    if (opts.deltas && opts.deltas.version !== stagedVersion) {
      stagedVersion = opts.deltas.version;
      // Works APPENDED live (a committed build order added a plan row):
      // register them — the scaffold stands the frame the order lands.
      while (workIds.size < plan.works.length) {
        const wi = workIds.size;
        registerWork(wi, tSec);
        refreshWorkFurniture(wi);
        changed = true;
      }
      // Works VACATED live (④ move-in converted a founded house-role row
      // into a real household): the row's walls/furniture clear — the
      // house registration below stands the same building as a HOME.
      plan.works.forEach((wk, wi) => {
        if (!wk.vacated || (workIds.get(wi)?.length ?? 0) === 0) return;
        if (furnished.has(`w_${wi}`)) {
          for (const o of furnitureOf.get(`w_${wi}`) ?? []) deltaRemoveObjects.push(o.id);
          furnished.delete(`w_${wi}`);
        }
        registerWork(wi, tSec); // vacated: clears and registers nothing
        refreshWorkFurniture(wi);
        changed = true;
      });
      // Work deltas BUMPED live (⑤b): a founded shell whose interior grew
      // (or lost) a room re-registers + refurnishes — the house rev-watch
      // pattern, one level over.
      plan.works.forEach((wk, wi) => {
        if (wk.vacated) return;
        const rev = opts.deltas!.get(workDeltaKey(wk, wi))?.rev ?? 0;
        if ((workStagedRev.get(wi) ?? 0) === rev) return;
        const wkKey = `w_${wi}`;
        if (furnished.has(wkKey)) {
          for (const o of furnitureOf.get(wkKey) ?? []) deltaRemoveObjects.push(o.id);
          furnished.delete(wkKey);
        }
        registerWork(wi, tSec);
        refreshWorkFurniture(wi);
        changed = true;
      });
      // Houses APPENDED live (④ move-in): register walls + furniture —
      // the household streams in through the resident model as usual.
      while (houseStagings.length < plan.houses.length) {
        const h = plan.houses[houseStagings.length]!;
        registerHouse(h);
        furnitureOf.set(
          `h_${h.index}`,
          houseFurniture(center, h, goodDefs, "", opts.deltas.get(`h_${h.index}`), opts.registry).map(toObjectSpec),
        );
        changed = true;
      }
      for (const hs of houseStagings) {
        const key = `h_${hs.house.index}`;
        const rev = opts.deltas.get(key)?.rev ?? 0;
        if ((stagedRev.get(hs.house.index) ?? 0) === rev) continue;
        stagedRev.set(hs.house.index, rev);
        const prevIds = new Set(hs.full.map((b) => b.id));
        const rebuilt = houseStagingOf(hs.house);
        hs.shell = rebuilt.shell;
        hs.full = rebuilt.full;
        if (houseVisible(hs.house)) {
          for (const b of rebuilt.full) {
            // New annex OR interior rooms (⑤b) pass through the scaffold.
            if (!prevIds.has(b.id) && /_[ai]\d+$/.test(b.id)) {
              scaffoldUntil.set(b.id, {
                until: tSec + SCAFFOLD_S,
                rect: { ...b.footprint },
                houseKey: key,
              });
            }
          }
        }
        // Refurnish: clear the old set now (quest-host removes before it
        // adds, so a surviving id re-lands cleanly the same frame); the
        // want-loop below re-adds the new set while the house is on show.
        const old = furnitureOf.get(key) ?? [];
        furnitureOf.set(
          key,
          houseFurniture(center, hs.house, goodDefs, "", opts.deltas.get(key), opts.registry).map(toObjectSpec),
        );
        if (furnished.has(key)) {
          for (const o of old) deltaRemoveObjects.push(o.id);
          furnished.delete(key);
        }
        changed = true;
      }
    }
    // Annex sites harden into real doored rooms as their time passes — the
    // room emits this frame, and the owning house REFURNISHES so the new
    // room's deferred pieces stream in (remove-before-add, the rev-bump
    // pattern).
    for (const [id, s] of scaffoldUntil) {
      if (tSec >= s.until) {
        scaffoldUntil.delete(id);
        if (furnished.has(s.houseKey)) {
          for (const o of furnitureOf.get(s.houseKey) ?? []) deltaRemoveObjects.push(o.id);
          furnished.delete(s.houseKey);
        }
        changed = true;
      }
    }

    // BUILDINGS: load within reach, keep until past the unload radius.
    for (const b of allBuildings) {
      const d = Math.hypot(b.cx - p.x, b.cy - p.y);
      if (solid.has(b.id)) {
        if (d > STRUCT_UNLOAD_R) {
          solid.delete(b.id);
          changed = true;
        }
      } else if (d <= STRUCT_LOAD_R) {
        solid.add(b.id);
        changed = true;
      }
    }
    // HOUSES: same load/unload hysteresis, plus the SHELL↔FULL interior
    // swap (INTERIOR_LOAD_R / INTERIOR_UNLOAD_R above). Full→shell only
    // lands while the interior is CONCEALED (view-guard-safe); a watched
    // house is always full — the dollhouse's focused house never sheds
    // its rooms, whatever the distance.
    for (const hs of houseStagings) {
      const d = Math.hypot(hs.cx - p.x, hs.cy - p.y);
      const watched = houseVisible(hs.house);
      const cur = houseMode.get(hs.house.index);
      let next: "shell" | "full" | undefined = cur;
      if (cur === undefined) {
        if (watched || d <= STRUCT_LOAD_R) {
          next = watched || d <= INTERIOR_LOAD_R ? "full" : "shell";
        }
      } else if (d > STRUCT_UNLOAD_R && !watched) {
        next = undefined; // the whole house unloads
      } else if (watched || d <= INTERIOR_LOAD_R) {
        next = "full";
      } else if (cur === "full" && d > INTERIOR_UNLOAD_R) {
        next = "shell"; // concealed AND far again — the swap is unseen
      }
      if (next !== cur) {
        changed = true;
        if (next === undefined) houseMode.delete(hs.house.index);
        else houseMode.set(hs.house.index, next);
      }
    }
    // An annex under its site window emits NO walls (the site marking is
    // the construction's visible form — city-founding "construction sites").
    const buildings = changed
      ? [
          ...[...solid].map(id => buildingById.get(id)!),
          ...houseStagings.flatMap(hs => {
            const mode = houseMode.get(hs.house.index);
            return mode === "full"
              ? hs.full.filter(b => !scaffoldUntil.has(b.id))
              : mode === "shell" ? hs.shell : [];
          }),
        ]
      : null;
    // SITES: emit the full set on ANY membership change (order landed,
    // build completed, annex window opened/closed) — including the very
    // first frame of a restored in-progress build.
    const siteList = activeSites();
    const siteSig = siteList.map(s => s.id).join("|");
    const sites = siteSig !== lastSiteSig ? siteList : null;
    lastSiteSig = siteSig;

    // FURNITURE: a house's interior fixtures follow the SAME roof-transparency
    // gate the residents use — present while the interior is ON SHOW (the player
    // occupies it, so the renderer fades its roof), abstracted the moment it's
    // hidden again. Keying furniture and people on ONE signal keeps them in
    // lockstep: no furnished-but-empty room, no peopled-but-bare room, and they
    // appear/vanish together. A closed house you merely walk past shows only its
    // exterior walls, so we never build a roomful of fixtures per house as the
    // town scrolls by. Runs every frame so it flips with occupancy, not just
    // wall-set changes.
    const wantFurnished = new Set<string>();
    for (const h of plan.houses) {
      if (houseVisible(h)) wantFurnished.add(`h_${h.index}`);
    }
    // A work's interior is on show when any of its rooms is (occupied /
    // roof open) — same gate, per-room signal; footprint fallback for
    // hosts without one (the 2D lab).
    plan.works.forEach((wk, i) => {
      if (!furnitureOf.has(`w_${i}`)) return;
      const vis = isRoomVisible
        ? workPlans[i]!.rooms.some(r => isRoomVisible(r.id))
        : p.x > center.x + wk.dx && p.x < center.x + wk.dx + wk.w &&
          p.y > center.y + wk.dy && p.y < center.y + wk.dy + wk.h;
      if (vis) wantFurnished.add(`w_${i}`);
    });
    const addObjects: ObjectSpec[] = [];
    const removeObjects: string[] = [...deltaRemoveObjects];
    for (const id of [...furnished]) {
      if (wantFurnished.has(id)) continue;
      for (const o of furnitureOf.get(id) ?? []) removeObjects.push(o.id);
      furnished.delete(id);
    }
    for (const id of wantFurnished) {
      if (furnished.has(id) || !furnitureOf.has(id)) continue;
      // Pieces standing inside an ACTIVE annex site defer until the room's
      // walls land (the expiry refurnish above re-adds them) — furniture
      // never stands on the open marked ground.
      const siteRects = [...scaffoldUntil.values()]
        .filter(s => s.houseKey === id)
        .map(s => s.rect);
      const pieces = siteRects.length
        ? furnitureOf.get(id)!.filter(
            o => !siteRects.some(r => o.x >= r.x && o.x <= r.x + r.w && o.y >= r.y && o.y <= r.y + r.h),
          )
        : furnitureOf.get(id)!;
      addObjects.push(...pieces);
      furnished.add(id);
    }

    // RESIDENTS: one model step; map spawns onto engine NPCs with the
    // behavior that keeps the clock honest (indoor tether, errand pace).
    const upd = residents.update(p, tSec, crowdBudget ?? bodyBudget, bodyPos, visibleR, isVisible, isRoomVisible, isHousePooled, isBusy);
    const add: NpcSpec[] = upd.spawn.map(s => {
      // The body's species: a defined member's own (frog_person aunt), else
      // the town's constructing species — sizes collision AND planning.
      const sp = opts.residentSpecies?.(s.id) ?? plan.species;
      return {
        id: s.id,
        x: s.x,
        y: s.y,
        ...(sp ? { species: sp } : {}),
        behavior: {
          movement: "wander" as const,
          conversationRadius: 5,
          wanderRadius: s.wanderRadius,
          home: s.home,
          speed: ERRAND_WALK,
        },
      };
    });
    const errands: TownStageFrame["errands"] = [
      // A body spawned mid-trip walks the REMAINDER of its trip...
      ...upd.spawn.flatMap(s => (s.walkTo ? [{ npcId: s.id, points: s.walkTo }] : [])),
      // ...and embodied runners head out when their cycle says so.
      ...upd.trips.map(t => ({ npcId: t.id, points: t.points })),
    ];
    const _errSpawnN = errands.length - upd.trips.length; // TEMP stage-errands probe
    const remove: string[] = [...upd.despawn];

    // THE CARAVAN — the intercity line's pair of carriers, streamed exactly
    // like haulers: bodies exist only mid-visit and in range. "In range"
    // covers the CAMERA's reach too (visibleR): a spirit watching from
    // orbit must never see a carrier blink in or out mid-street.
    const embodyR = Math.max(HAULER_EMBODY_R, visibleR ?? 0);
    if (trade) {
      const trip = trade.caravan(tSec);
      for (let i = 0; i < 2; i++) {
        const id = `caravan_${i}`;
        const live = liveHaulers.has(id);
        if (trip.phase === "away") {
          if (live) {
            remove.push(id);
            liveHaulers.delete(id);
          }
          continue;
        }
        const d = Math.hypot(trip.pos.x - p.x, trip.pos.y - p.y);
        if (!live && d <= embodyR) {
          liveHaulers.add(id);
          add.push({
            id, x: trip.pos.x + i * 1.1, y: trip.pos.y + i * 0.7,
            ...(plan.species ? { species: plan.species } : {}),
            behavior: {
              movement: "wander" as const, conversationRadius: 5,
              wanderRadius: 1.2, home: trade.depot, speed: trip.speed,
            },
          });
          if (trip.walkTo) errands.push({ npcId: id, points: trip.walkTo });
        } else if (live && d > embodyR + 60) {
          remove.push(id);
          liveHaulers.delete(id);
        }
      }
    }

    // HAULERS — the supply flow made visible: per SHELVED source with a haul,
    // a carrier walks the dawn-cart round trip producer → stall → producer
    // (goods.ts `haul`, time-pure). A body exists only MID-TRIP and in range:
    // it pops in at the producer walking the remainder, and evicts once idle —
    // the same spawn-mid-task discipline as the residents.
    for (const g of goods) {
      for (let si = 0; si < g.sources.length; si++) {
        const src = g.sources[si];
        const trip = g.haul(src, tSec);
        const id = `hauler_${g.good.key}_${si}`;
        const live = liveHaulers.has(id);
        if (!trip || trip.phase === "idle") {
          if (live) {
            remove.push(id);
            liveHaulers.delete(id);
          }
          continue;
        }
        const d = Math.hypot(trip.pos.x - p.x, trip.pos.y - p.y);
        if (!live && d <= embodyR) {
          liveHaulers.add(id);
          add.push({
            id, x: trip.pos.x, y: trip.pos.y,
            ...(plan.species ? { species: plan.species } : {}),
            behavior: {
              movement: "wander" as const, conversationRadius: 5,
              wanderRadius: 1.2, home: trip.producer, speed: trip.speed,
            },
          });
          if (trip.walkTo) errands.push({ npcId: id, points: trip.walkTo });
        } else if (live && d > embodyR + 60) {
          remove.push(id);
          liveHaulers.delete(id);
        }
      }
    }

    // TEMP stage-errands probe (view-distance-lod-tiers.md): WHICH source
    // feeds the standing per-frame errand stream — mid-trip SPAWN remainders,
    // cycle TRIPS, or HAULER/caravan pop-ins? ≤1 line/sim-second per stage.
    if (probesOn() && errands.length && typeof console !== "undefined" && tSec - _errLogAt > 1) {
      _errLogAt = tSec;
      const haulerN = errands.length - _errSpawnN - upd.trips.length;
      console.log(
        `[stage-errands] ${plan.key ?? "town"} total=${errands.length} spawn=${_errSpawnN} trips=${upd.trips.length} hauler=${haulerN} ` +
          `ids=${errands.slice(0, 3).map(e => e.npcId).join(",")}`,
      );
    }
    return { buildings, sites, add, remove, errands, addObjects, removeObjects };
  };

  return {
    spec: cert.spec, center, roads, castSpawns, goods, trade, frame, activeSites,
    loadedLots: () => ({
      houses: new Set(houseMode.keys()),
      works: new Set(plan.works.map((_, i) => i).filter((i) => solid.has(`w_${i}`))),
    }),
    explainResident: (p, tSec, houseIndex, member, bodyPos, isVisible) =>
      residents.explain(p, tSec, houseIndex, member, bodyPos, isVisible),
    dropResidentBody: (id) => residents.dropBody(id),
  };
}
