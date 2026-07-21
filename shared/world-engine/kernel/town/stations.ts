/**
 * stations.ts — THE REGISTRIES of emergent building generation (§9 of
 * household-duties-and-sims-mode.md, slices 1-2): pure DATA that the
 * generator pipeline reads, so new furniture, new room clusters and new
 * building programs are AUTHORED here, not coded into the generator.
 *
 *   STATIONS   what can stand in a building — furniture kind, footprint,
 *              affordances, and its PLACEMENT RULE (which cell it seeks,
 *              which walls it scans). furniture.ts is the geometry driver
 *              that executes these rules; it contains no per-piece code.
 *
 *   CLUSTERS   the room vocabulary — a "room type" is just the name of a
 *              cluster of stations that ended up owning a cell. Each
 *              cluster carries its PRIVACY RANK (how deep in the door
 *              graph it wants to sit) and the GEOMETRY FLOORS a dedicated
 *              cell must satisfy (else the cluster merges down into the
 *              communal cell — the granularity budget; the studio is the
 *              full merge). rooms.ts reads these floors; it does not
 *              define them.
 *
 *   OCCUPANTS  who lives/works here and what their needs demand — the
 *              building PROGRAM is derived from the occupants' need-set
 *              (the behavior layer's need templates name these same
 *              station kinds in `satisfy.at`; a test asserts the two
 *              stay consistent). Residents give a dwelling; an inn is
 *              the sleep cluster multiplied; a smithy is a work program.
 *
 * Kernel layering: this module is pure data + arithmetic — it imports
 * NOTHING at runtime (rooms.ts, furniture.ts and goods.ts all sit above it);
 * the one `import type` below erases at compile time.
 */

import type { ObjectProperty } from "../../object-properties.js";

/** Every furniture/fixture kind a station can raise (FurniturePiece.kind
 *  re-exports this — the 3D fixture meshes and the schema enum follow it). */
export type StationKind =
  | "chest" | "cupboard" | "table" | "bed" | "chair" | "box"
  | "barrel" | "bath" | "privy" | "bin" | "bowl" | "oven" | "workbench"
  // The FOOD box: the goods corner raises a refrigerator for the `food` good
  // instead of a generic chest, so the pantry is legible at a glance. The
  // anachronism is deliberate and temporary — tech levels come later.
  | "refrigerator";

/**
 * WHAT EACH STATION KIND *IS* — the spec-side authority for object properties
 * (world-engine-board-organization.md §4). The board imports these; it never
 * re-authors them. `openable` is deliberately ABSENT here: it is DERIVED from
 * the `openable` flag on the station rows themselves (see
 * interaction/content/properties.ts), so the board can never disagree with the
 * mechanic about what opens.
 *
 * A new furniture kind declares what it is HERE, once, and both the simulation
 * and the sentence board follow.
 */
export const STATION_PROPERTIES: Readonly<Record<StationKind, readonly ObjectProperty[]>> = {
  chest: ["furniture", "container"],
  cupboard: ["furniture", "container"],
  box: ["furniture", "container"],
  barrel: ["furniture", "container"],
  bin: ["furniture", "container"],
  // The pantry: a container that is also a powered appliance.
  refrigerator: ["furniture", "container", "appliance", "device"],
  // The cook's transform station.
  oven: ["furniture", "appliance", "device"],
  // The carpenter's craft transform.
  workbench: ["furniture", "appliance"],
  table: ["furniture"],
  chair: ["furniture"],
  bed: ["furniture"],
  bath: ["furniture"],
  privy: ["furniture"],
  // The pet's floor dish — a serving vessel, not room furniture.
  bowl: ["tableware"],
} as const;

/** Walls of a cell, in the house's door-local frame: `far` faces the
 *  street door across the room; the sides run door-ward. */
export type WallKey = "far" | "side0" | "side1";

/** Which CELL (room) a station seeks, resolved against the realized plan
 *  with graceful fallbacks (a cluster that merged down resolves to the
 *  communal cell — stations follow their cluster wherever it landed). */
export type CellRef =
  /** The communal cell — rooms[0], the street door's room. */
  | { cell: "communal" }
  /** The i-th sleep cell, collapsing onto the last that exists (the
   *  communal cell in a studio). */
  | { cell: "sleep"; index: number }
  /** The children's sleep cell (the second bedroom, falling back to the
   *  first, then communal) — where the toys live. */
  | { cell: "kids" }
  /** The wet cell (bath room), communal when merged. */
  | { cell: "wet" }
  /** The kitchen cell, communal when merged (the hearth in the hall). */
  | { cell: "kitchen" }
  /** The store cell (a workshop's back room), communal when merged. */
  | { cell: "store" }
  /** The WORKSHOP cell (construction v1's optional room — a carpenter's
   *  bench). Not in any base program: it exists only where an annex
   *  raised one, so its stations are always `cellOnly`. */
  | { cell: "workshop" }
  /** Each member's OWN sleep cell (memberRoomOf) — per-member stations. */
  | { cell: "member" };

/**
 * HOW a station takes its spot — executed by furniture.ts's fit machinery
 * (every mode still passes THE FIT RULE: inside the walls, clear of every
 * earlier piece, every door swing corridor, every goods standing spot).
 */
export type StationPlacement =
  /** Flush in the communal cell's corner that goodBoxAt maps this good's
   *  slot to — the household box of a street good (unconditional; the
   *  corner IS the box). */
  | { mode: "goodsCorner" }
  /** The classic dresser spot: midpoint of the far wall, else the side
   *  walls. In a PARTITIONED house the far wall is the partition (its
   *  midpoint is the table's column, its flanks carry door corridors), so
   *  the side walls come FIRST there. */
  | { mode: "farMidThenSides" }
  /** The table's rule: the cell's center, shifted door-ward by
   *  `prefShiftFrac` of the cell's short side. A studio places it
   *  unconditionally (the classic spot); a partitioned cell FIT-SEARCHES
   *  center-out and GOES WITHOUT when nothing fits. */
  | { mode: "centerFit"; prefShiftFrac: number }
  /** First fitting flush spot scanning the given walls in order. */
  | { mode: "wallScan"; walls: readonly WallKey[] }
  /** Door-less corners first, then the given walls. */
  | { mode: "cornerThenWall"; walls: readonly WallKey[] }
  /** Beside an earlier station (the chairs and the pet bowl at the
   *  table): offset along `axis` by the two radii + `gapPad`, on
   *  `spread` = "eachSide" both sides independently (chairs — a blocked
   *  side may retry the other axis in a partitioned cell) or
   *  "firstSide" the first side that fits (the bowl), with optional wall
   *  fallback. Anchor missing (its cell went without) ⇒ skipped. */
  | {
      mode: "besideAnchor";
      anchor: string;
      axis: "u" | "v";
      gapPad: number;
      spread: "eachSide" | "firstSide";
      retryOtherAxisWhenPartitioned?: boolean;
      faceAnchor?: boolean;
      fallbackWalls?: readonly WallKey[];
    };

export interface StationDef {
  /** Id suffix (`furn<scope>_<house>_<key>`) and anchor name. */
  key: string;
  kind: StationKind;
  /** Half-extent (square footprint = collision box, except pass-through
   *  kinds — chairs and bowls never block). */
  radius: number;
  openable: boolean;
  /** The cluster whose cell this station seeks. */
  cluster: string;
  cell: CellRef;
  place: StationPlacement;
  /** Multiply per street GOOD (the chests) or per household MEMBER (the
   *  personal boxes); default one instance. */
  per?: "good" | "member";
  /**
   * For a `per: "good"` station, the MODEL a particular good's box raises
   * instead of `kind` — the pantry stands in a refrigerator while every other
   * good keeps a plain chest. The instance ID still follows `key`, so the
   * goods plumbing (stock, positions, restock errands) is untouched; only the
   * raised model differs. Keeping the override HERE means the registry stays
   * the single source of truth for what a generated piece looks like.
   */
  kindByGood?: Readonly<Record<string, StationKind>>;
  /** Only in partitioned houses (a studio has no private corner to give). */
  partitionedOnly?: boolean;
  /** Only when the plan realized at least this many sleep cells. */
  minSleepCells?: number;
  /** Only when the station's cluster owns a DEDICATED cell — never via the
   *  communal fallback (a work building's oven exists where a kitchen
   *  does, not on every sales floor). */
  cellOnly?: boolean;
}

/**
 * One cluster of stations = the unit that owns (or shares) a cell. Room
 * "types" are cluster names — `bedroom` is just what we call a cell the
 * sleep cluster ended up owning.
 */
export interface ClusterDef {
  key: string;
  /** Privacy rank the cluster seeks — door-graph depth, not distance
   *  (access is TOPOLOGICAL in buildings): 0 = the street-facing communal
   *  cell; higher wants to sit deeper. The realized depth is annotated on
   *  HouseRoom.depth. */
  privacy: number;
  /** Geometry floors a DEDICATED cell must satisfy — below them the
   *  cluster merges into the communal cell (the granularity budget). */
  minW?: number;
  minD?: number;
  /** Band m² that justify one dedicated cell of this cluster. */
  cellArea?: number;
  /** Occupants one cell serves (sleep: two — the double bed + pairing). */
  perCell?: number;
  /** Clusters this one wants DOOR-ADJACENT (the wet cell doors from the
   *  sleep cells — en-suite / Jack-and-Jill). Consumed fully by
   *  circulation-as-search (§9 slice 4); the topology ladder honors the
   *  authored cases. */
  affinity?: readonly string[];
  /** Clusters this one refuses to share a cell with when merging. */
  aversion?: readonly string[];
}

/** Room clusters an ANNEX can be raised for (construction v1) — the
 *  cluster names the CLUSTERS row whose geometry floors size the annex;
 *  `workshop` is the optional-rooms seam (a carpenter's bench — not
 *  every house has one). Lives here (import-free data) so rooms.ts and
 *  construction.ts share it without a cycle. */
export type AnnexCluster = "sleep" | "kitchen" | "store" | "wet" | "workshop";

/** The room kind an annex cluster's cell realizes as. */
export const ANNEX_ROOM_KIND: Readonly<
  Record<AnnexCluster, "bedroom" | "kitchen" | "store" | "bath" | "workshop">
> = {
  sleep: "bedroom",
  kitchen: "kitchen",
  store: "store",
  wet: "bath",
  workshop: "workshop",
} as const;

export const CLUSTERS: Readonly<Record<string, ClusterDef>> = {
  /** The hearth room — street door, goods boxes, table. Never merges
   *  away; every building has its rank-0 cell. */
  communal: { key: "communal", privacy: 0 },
  /** Halls/corridors — pure access, no stations. */
  circulation: { key: "circulation", privacy: 0 },
  /** Tub + privy gather in one wet cell. minW is the proven tub + privy +
   *  door-lane floor (round 5b: 2.6 strands the privy). No affinity: the
   *  bath is a HOUSEHOLD room — it doors from the public side (the living
   *  partition or the hall) whenever the geometry allows, and enters
   *  through a bedroom only where the partition's chest clearance leaves
   *  no other way (round 7 — the playtest's "why does the privy open into
   *  a bedroom?" parameter fix; authoring `affinity: ["sleep"]` here
   *  brings the en-suite culture back, per town, no code). */
  wet: { key: "wet", privacy: 1, minW: 2.8 },
  /** Sleeping cells. minD = door swing lane + the 1.8 m double bed;
   *  cellArea = band m² that justify one more cell. */
  sleep: { key: "sleep", privacy: 2, minW: 2.9, minD: 3.1, cellArea: 13, perCell: 2 },
  /** The KITCHEN — food preparation's cell (round 7). Universal DEMAND
   *  (every household cooks) but the LAST cluster to earn a dedicated
   *  cell: the oven stands in the hearth room until the footprint
   *  affords a split (historically honest — the separate kitchen is the
   *  late differentiation). Realized down a spine hall, or as the FRONT
   *  KITCHEN — the culture-coin galley walled off the living room's end
   *  (rooms.ts). minW fits the oven + cupboard + barrel walls with a
   *  lane. */
  kitchen: { key: "kitchen", privacy: 1, minW: 2.8 },
  /** A workshop's stock room — goods behind a door, off the sales floor.
   *  Floors are a storeroom's (chests + a walking lane), not a bedroom's. */
  store: { key: "store", privacy: 1, minW: 2.4, minD: 2.4 },
  /** The WORKSHOP — construction v1's first OPTIONAL room (not every
   *  house has a carpenter). No base program demands it; it exists only
   *  where an annex raised one (a founding-seeded minority of houses, or
   *  a household that built theirs later). The bench + wood store need a
   *  real working floor. */
  workshop: { key: "workshop", privacy: 1, minW: 3.0, minD: 3.0 },
} as const;

/**
 * THE HOUSE STATIONS, in placement order — order is semantics: earlier
 * pieces claim space, later ones fit around them. The order is NEED
 * CRITICALITY: the goods chests anchor the economy's corners; the WET
 * stations come next (hygiene and waste are `requireStation` needs —
 * they BLOCK without their station, so the tub outranks the dresser
 * where the wet cluster merged into a tight communal cell); then the
 * table and the beds; comfort and storage furniture fit around them.
 */
export const HOUSE_STATIONS: ReadonlyArray<StationDef> = [
  // The household box of each street good, flush in its goodBoxAt corner.
  // FOOD stands in a refrigerator so the pantry is findable at a glance.
  { key: "chest", kind: "chest", radius: 0.55, openable: true, cluster: "communal",
    cell: { cell: "communal" }, place: { mode: "goodsCorner" }, per: "good",
    kindByGood: { food: "refrigerator" } },
  // The wet stations — the tub claims its stretch before anything
  // nibbles the walls (in its own cell nothing competes; merged into the
  // living room this rank is what keeps the house washable).
  { key: "bath", kind: "bath", radius: 0.75, openable: false, cluster: "wet",
    cell: { cell: "wet" }, place: { mode: "wallScan", walls: ["side0", "side1", "far"] } },
  { key: "privy", kind: "privy", radius: 0.5, openable: false, cluster: "wet",
    cell: { cell: "wet" }, place: { mode: "cornerThenWall", walls: ["side1", "side0", "far"] } },
  // The OVEN — food preparation's station (round 7: the cook's transform
  // works here). Kitchen cluster: in its own cell when the plan afforded
  // one, else standing in the hearth room like the tin bath — and like
  // the wet stations it claims its wall stretch before the comfort
  // furniture nibbles (cooked meals are how hunger gets served).
  { key: "oven", kind: "oven", radius: 0.6, openable: false, cluster: "kitchen",
    cell: { cell: "kitchen" }, place: { mode: "wallScan", walls: ["side0", "side1", "far"] } },
  { key: "table", kind: "table", radius: 0.8, openable: false, cluster: "communal",
    cell: { cell: "communal" }, place: { mode: "centerFit", prefShiftFrac: 0.18 } },
  // The beds — the double in the first sleep cell, singles onward; the
  // far wall first (deepest from the street door), then the sides.
  { key: "bed_0", kind: "bed", radius: 0.9, openable: false, cluster: "sleep",
    cell: { cell: "sleep", index: 0 }, place: { mode: "wallScan", walls: ["far", "side0", "side1"] } },
  { key: "bed_1", kind: "bed", radius: 0.65, openable: false, cluster: "sleep",
    cell: { cell: "sleep", index: 1 }, place: { mode: "wallScan", walls: ["far", "side0", "side1"] } },
  { key: "bed_2", kind: "bed", radius: 0.65, openable: false, cluster: "sleep",
    cell: { cell: "sleep", index: 2 }, place: { mode: "wallScan", walls: ["far", "side0", "side1"] },
    minSleepCells: 2 },
  // Two chairs tucked at the table, perpendicular to the door axis (the
  // door→table lane stays open), facing it.
  { key: "chair", kind: "chair", radius: 0.22, openable: false, cluster: "communal",
    cell: { cell: "communal" },
    place: { mode: "besideAnchor", anchor: "table", axis: "u", gapPad: 0.1,
      spread: "eachSide", retryOtherAxisWhenPartitioned: true, faceAnchor: true } },
  // The cupboard follows the kitchen cluster (crockery lives with the
  // oven) — communal fallback keeps it the classic dresser where no
  // kitchen cell exists.
  { key: "cupboard", kind: "cupboard", radius: 0.6, openable: true, cluster: "kitchen",
    cell: { cell: "kitchen" }, place: { mode: "farMidThenSides" } },
  // The water barrel too — drawing water is the kitchen's chore.
  { key: "barrel", kind: "barrel", radius: 0.4, openable: true, cluster: "kitchen",
    cell: { cell: "kitchen" }, place: { mode: "wallScan", walls: ["side0", "side1", "far"] } },
  { key: "bin", kind: "bin", radius: 0.35, openable: true, cluster: "communal",
    cell: { cell: "communal" }, place: { mode: "cornerThenWall", walls: ["side1", "side0", "far"] } },
  // The pet's floor dish (pass-through), set out beside the table.
  { key: "bowl", kind: "bowl", radius: 0.25, openable: false, cluster: "communal",
    cell: { cell: "communal" },
    place: { mode: "besideAnchor", anchor: "table", axis: "v", gapPad: 0.3,
      spread: "firstSide", fallbackWalls: ["side0", "side1", "far"] } },
  // Each member's personal BOX — THEIR OWN property (the ownership layer's
  // private tier), in their own sleep cell. Every member gets one; there is no
  // separate communal toy chest, because a box is a box and what makes one a
  // "toy box" is only what happens to be inside it.
  { key: "box", kind: "box", radius: 0.4, openable: true, cluster: "sleep",
    cell: { cell: "member" }, place: { mode: "cornerThenWall", walls: ["side0", "side1", "far"] },
    per: "member" },
  // ── OPTIONAL-ROOM stations (construction v1) — all cellOnly: they
  // exist only where an annex raised their dedicated cell.
  // The carpenter's BENCH — the furniture-craft transform station.
  { key: "workbench", kind: "workbench", radius: 0.7, openable: false, cluster: "workshop",
    cell: { cell: "workshop" }, place: { mode: "wallScan", walls: ["far", "side0", "side1"] },
    cellOnly: true },
  // The workshop's WOOD store — the craft input's stack lives here.
  { key: "woodstore", kind: "chest", radius: 0.5, openable: true, cluster: "workshop",
    cell: { cell: "workshop" }, place: { mode: "cornerThenWall", walls: ["side0", "side1", "far"] },
    cellOnly: true },
  // The STOW chest — a store-room annex's furniture storage (unplaced
  // pieces stack here; the room's clutter slows bodies, never blocks).
  { key: "stow", kind: "chest", radius: 0.55, openable: true, cluster: "store",
    cell: { cell: "store" }, place: { mode: "cornerThenWall", walls: ["far", "side0", "side1"] },
    cellOnly: true },
] as const;

// ── FURNITURE AS ITEMS (construction v1) ────────────────────────────────
// Furniture the ITEM ECONOMY can hold: a piece not standing in a room is
// a fungible STACK by glyph (`furn.<kind>` — the ONE container
// abstraction, like any good), bought from a carpenter or crafted at a
// workbench, stowed in storage until a resident (or a directed creature)
// PLACES it — at which point it becomes a PlacedPiece in the building's
// construction delta and a real fixture in the world.

export interface FurnitureItemDef {
  kind: StationKind;
  /** Placed half-extent (matches the registry rows' proportions). */
  radius: number;
  openable: boolean;
  /** How it's MADE: a transform at a station consuming input glyphs
   *  (the cook's pattern). Absent = buy/import only. */
  craft?: { at: StationKind; consumes: Record<string, number> };
}

/** The glyph a stacked (unplaced) piece of furniture carries. */
export const furnitureGlyph = (kind: StationKind): string => `furn.${kind}`;

/** The station kind inside a furniture glyph — null for any other glyph. */
export function furnitureKindOfGlyph(glyph: string): StationKind | null {
  if (!glyph.startsWith("furn.")) return null;
  const kind = glyph.slice("furn.".length);
  return FURNITURE_ITEMS.some((f) => f.kind === kind) ? (kind as StationKind) : null;
}

export const FURNITURE_ITEMS: ReadonlyArray<FurnitureItemDef> = [
  { kind: "chair", radius: 0.22, openable: false, craft: { at: "workbench", consumes: { wood: 1 } } },
  { kind: "table", radius: 0.8, openable: false, craft: { at: "workbench", consumes: { wood: 2 } } },
  { kind: "bed", radius: 0.65, openable: false, craft: { at: "workbench", consumes: { wood: 2 } } },
  { kind: "chest", radius: 0.55, openable: true, craft: { at: "workbench", consumes: { wood: 1 } } },
  { kind: "cupboard", radius: 0.6, openable: true, craft: { at: "workbench", consumes: { wood: 2 } } },
  { kind: "box", radius: 0.45, openable: false, craft: { at: "workbench", consumes: { wood: 1 } } },
  { kind: "bin", radius: 0.35, openable: true, craft: { at: "workbench", consumes: { wood: 1 } } },
  { kind: "barrel", radius: 0.4, openable: true, craft: { at: "workbench", consumes: { wood: 1 } } },
  /** A bench can be bought (the bootstrap: you can't craft your first). */
  { kind: "workbench", radius: 0.7, openable: false },
] as const;

export const furnitureItemOf = (kind: StationKind): FurnitureItemDef | undefined =>
  FURNITURE_ITEMS.find((f) => f.kind === kind);

// ── THE OCCUPANT PROGRAM ────────────────────────────────────────────────
// A building's program is derived from WHO occupies it and what their
// needs demand — not sampled from area. Area still matters, but as the
// GRANULARITY BUDGET (how many dedicated cells the footprint affords),
// and the topology as CAPACITY (how many cells it can door) — demand,
// budget and capacity meet in rooms.ts's program step.

/** Souls per house (a household) — houses = round(pop / this). Lives here
 *  (occupancy is the program's input); goods.ts re-exports it for the
 *  economy's consumers. */
export const HOUSEHOLD = 5;

export interface OccupantCounts {
  /** Sleeping occupants (the household's members). */
  residents: number;
}

export interface HouseProgram {
  residents: number;
  /** Sleep cells the occupants DEMAND (perCell sleepers pair up per
   *  cell — memberRoomOf's pairing). The footprint's granularity budget
   *  and the topology's door capacity may clamp what they GET. */
  sleepCells: number;
  /** Every household cooks — the kitchen demand is universal. The
   *  granularity budget yields it LAST (the oven shares the hearth room
   *  until the footprint affords the split); see rooms.ts's culture coin. */
  kitchen: boolean;
}

export function houseProgram(o: OccupantCounts): HouseProgram {
  const per = CLUSTERS.sleep!.perCell ?? 2;
  return {
    residents: o.residents,
    sleepCells: Math.max(1, Math.ceil(o.residents / per)),
    kitchen: true,
  };
}

// ── NON-HOUSE BUILDING PROGRAMS (§9 slice 5) ───────────────────────────
// A building's interior is its PROGRAM run through the same generator —
// a house is just the dwelling instance. The registry keys the town's
// open work-type vocabulary; anything unregistered gets the generic
// workshop (a sales floor with a stock room when the footprint affords
// one). This object IS the mod seam: buildingRoomPlan takes any program
// value, so new building kinds are authored rows, not generator code.

export interface BuildingProgram {
  /** Sleep cells demanded — the INN is the sleep cluster multiplied
   *  (past 3 the solver's spine hall is how a row of cells gets doored). */
  sleepCells?: number;
  /** Wants a wet cell (dwelling-like programs). */
  wet?: boolean;
  /** Wants a KITCHEN cell (an inn feeds its guests) — realized only when
   *  the footprint affords it beyond the sleep demand (beds outrank). */
  kitchen?: boolean;
  /** Wants a back STORE cell when the footprint affords it. */
  store?: boolean;
}

export const WORK_PROGRAMS: Readonly<Record<string, BuildingProgram>> = {
  /** The town hall and the market stay OPEN halls — their floor is the
   *  point (assembly, stalls); partitioning one would wall off the very
   *  space it exists for (and the market's shelf anchors live mid-floor). */
  hall: {},
  market: {},
  farm: { store: true },
  weaver: { store: true },
  tailor: { store: true },
  /** Prospective content: an inn is a dwelling program multiplied —
   *  proven through the solver today, staged when the economy grows one. */
  inn: { sleepCells: 6, wet: true, kitchen: true, store: true },
} as const;

/** The program of a work type — unregistered types get the generic
 *  workshop. */
export function workProgram(type: string): BuildingProgram {
  return WORK_PROGRAMS[type] ?? { store: true };
}

/**
 * WHAT STANDS IN A WORK BUILDING — same driver, same fit rule as the
 * house stations. Reuses existing station kinds (the counter is a table,
 * stock lives in chests) so no renderer/schema surface changes; richer
 * work stations (a forge, a loom) are new rows here once their fixtures
 * exist.
 */
export const WORK_STATIONS: ReadonlyArray<StationDef> = [
  // The COUNTER — the work cell's table: goods shown "on" it, the
  // keeper's station, the customer's landmark.
  { key: "counter", kind: "table", radius: 0.8, openable: false, cluster: "communal",
    cell: { cell: "communal" }, place: { mode: "centerFit", prefShiftFrac: 0.18 } },
  // Stock chests — in the store room when one exists (the cell fallback
  // sends them to the floor otherwise).
  { key: "stock_0", kind: "chest", radius: 0.55, openable: true, cluster: "store",
    cell: { cell: "store" }, place: { mode: "cornerThenWall", walls: ["far", "side0", "side1"] } },
  { key: "stock_1", kind: "chest", radius: 0.55, openable: true, cluster: "store",
    cell: { cell: "store" }, place: { mode: "cornerThenWall", walls: ["far", "side1", "side0"] } },
  { key: "barrel", kind: "barrel", radius: 0.4, openable: true, cluster: "communal",
    cell: { cell: "communal" }, place: { mode: "wallScan", walls: ["side0", "side1", "far"] } },
  // A oven ONLY where the program earned a kitchen cell (the inn's
  // guest meals) — cellOnly keeps it off every sales floor.
  { key: "oven", kind: "oven", radius: 0.6, openable: false, cluster: "kitchen",
    cell: { cell: "kitchen" }, place: { mode: "wallScan", walls: ["side0", "side1", "far"] },
    cellOnly: true },
] as const;
