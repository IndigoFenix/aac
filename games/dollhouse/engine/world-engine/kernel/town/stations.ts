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
import type { ItemWords } from "../../interaction/lang/core.js";
// The one VALUE import (phase 6): furniture is priced by the same bill module
// the walls are, so a bed and the room it stands in cannot disagree about what
// a block is. Pure arithmetic — the layering note above still holds.
import { blockCosts, furnitureBlocks } from "./block-bill.js";

/** Every furniture/fixture kind a station can raise (FurniturePiece.kind
 *  re-exports this — the 3D fixture meshes and the schema enum follow it). */
export type StationKind =
  | "chest" | "cupboard" | "table" | "bed" | "chair" | "box"
  | "barrel" | "bath" | "toilet" | "bin" | "bowl" | "oven" | "workbench"
  // The FOOD box: the goods corner raises a refrigerator for the `food` good
  // instead of a generic chest, so the pantry is legible at a glance. The
  // anachronism is deliberate and temporary — tech levels come later.
  | "refrigerator"
  // ── THE PLACE-MAKING STATIONS ─────────────────────────────────────────
  // Four fixtures whose whole job is to MAKE A ROOM WHAT IT IS. Each one is
  // the signature piece of a room kind the town could name but never build
  // (programs.ts): an anvil makes a forge, an altar a shrine, a loom a weaving
  // room, a shelf a study. They arrive as a set because the room vocabulary
  // they unlock is the point — furniture defines function, so a new kind of
  // place starts as a new thing standing in a room.
  //
  // They reach a building through `StructureSpec.stations` (the seam
  // workExtraStationDefs was written for), NOT through WORK_STATIONS: a row
  // there stands in EVERY work building, and only the smithy wants the anvil.
  | "anvil" | "altar" | "loom" | "shelf"
  // The MASONRY bench (construction phase 5). One of the set above in every
  // respect — a stonecutter makes a masonry the way an anvil makes a forge, and
  // it reaches a building down the same `StructureSpec.stations` seam. Listed
  // apart only because those four shipped together and this one is the trade
  // the block chain was always waiting on (products.ts: stone refines to block,
  // and until now it did so at a carpenter's bench).
  | "stonecutter"
  // ── THE DOOR LEAF ─────────────────────────────────────────────────────
  // construction-structures.md's law read precisely: "Doorways are part of the
  // wall, but the doors themselves should be constructed as furniture pieces."
  // The DOORWAY is generated geometry (a gap in a wall run, engine.ts
  // edgeStructures); the LEAF that swings in it is a piece of furniture — cut
  // from a block, carried, and hung.
  //
  // It is the ONE kind here pinned to an OPENING rather than a floor spot, so
  // it appears in no CLUSTERS row, no HOUSE/WORK_STATIONS row, and no room
  // signature (programs.ts). A door tells you nothing about what a room is FOR:
  // let it into a signature and every room derives as a doorway.
  | "door";

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
  toilet: ["furniture"],
  // The pet's floor dish — a serving vessel, not room furniture.
  bowl: ["tableware"],
  // The smith's transform — metal in, tools out. `appliance` is what earns it
  // the front-approached reach contract (furniture-use.ts derives the contract
  // from these properties), which is exactly how a body works an anvil.
  anvil: ["furniture", "appliance"],
  // The weaver's transform — thread in, cloth out.
  loom: ["furniture", "appliance"],
  // Open shelving: it holds things where you can SEE them, which is why a
  // library's shelf and a market's display are the same fixture. A container
  // that never closes — `openable` stays false on its rows.
  shelf: ["furniture", "container"],
  // The altar is the one station here that TRANSFORMS nothing and HOLDS
  // nothing. It is plain furniture on purpose: what happens at it is what the
  // people gathered there are doing, not a mechanic the fixture owns.
  altar: ["furniture"],
  // The mason's transform — rough stone in, dressed block out. `appliance` for
  // exactly the anvil's reason: it is what earns the front-approached reach
  // contract (furniture-use.ts derives the contract from these properties), and
  // a slab is worked from the side you stand at, never reached around.
  stonecutter: ["furniture", "appliance"],
  // The door LEAF — plain furniture, and deliberately NOT `container`/
  // `openable`. A door swinging is the DOORWAY mechanic (state.doors,
  // tickDoors, setDoorOpen), not the lid rule that eases a chest open when a
  // body stands beside it; the two only look alike from outside. Its registry
  // rows keep `openable: false` so the board never files a door under the
  // openable sub-tab and offers an act the container machinery cannot honour.
  door: ["furniture"],
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
  /** Cells to fall back to, in order, when the station's own cell can't
   *  FIT it (distinct from `cell`'s merge fallback, which fires only when
   *  the cell doesn't EXIST). The cupboard uses it to YIELD to the living
   *  room when the fridge claimed its kitchen space (fridge > cupboard). */
  cellFallback?: readonly CellRef[];
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
  /** Tub + toilet gather in one wet cell. minW is the proven tub + toilet +
   *  door-lane floor (round 5b: 2.6 strands the toilet). No affinity: the
   *  bath is a HOUSEHOLD room — it doors from the public side (the living
   *  partition or the hall) whenever the geometry allows, and enters
   *  through a bedroom only where the partition's chest clearance leaves
   *  no other way (round 7 — the playtest's "why does the toilet open into
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
  // ── THE PLACE-MAKING CLUSTERS ────────────────────────────────────────
  // The room kinds the four new stations name. All privacy 1: each is a
  // room you ENTER for its purpose — never a through-room (privacy 0) and
  // never a sleeping soul's own retreat (2).
  /** The FORGE — hot work needs the workshop's floor and then some: a smith
   *  swings, and the fire wants clearance the bench never did. */
  forge: { key: "forge", privacy: 1, minW: 3.2, minD: 3.2 },
  /** The WEAVING room — a loom is LONG, so the floor is asymmetric: it wants
   *  a run of wall more than it wants depth. */
  weaving: { key: "weaving", privacy: 1, minW: 3.2, minD: 2.8 },
  /** The STUDY — shelves along the walls and a lane to read in. A storeroom's
   *  floors, because that is geometrically what it is (the difference is that
   *  you can see what's on the shelves). */
  study: { key: "study", privacy: 1, minW: 2.4, minD: 2.4 },
  /** The SHRINE — the smallest of the four. A household shrine is a niche;
   *  a temple's is the whole hall, and the hall is the BUILDING's floor, not
   *  this cluster's. */
  shrine: { key: "shrine", privacy: 1, minW: 2.2, minD: 2.2 },
  /** The MASONRY (construction phase 5) — the stonecutter's room, and the
   *  widest floor in the table. Stone arrives rough and leaves as block, so
   *  unlike the forge (where the work is all at the anvil) the bench needs a
   *  STOCK LANE down one side: a stack waiting to be cut and a stack already
   *  cut, neither of them in the mason's swing. Hence the forge's clearance in
   *  width plus that lane, and no more depth than the forge — a mason works
   *  across the slab, not around it. */
  masonry: { key: "masonry", privacy: 1, minW: 3.6, minD: 3.2 },
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
  { key: "toilet", kind: "toilet", radius: 0.5, openable: false, cluster: "wet",
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
  // kitchen cell exists. When a kitchen DOES exist but the pantry fridge
  // (and the oven, which never yields) leave it no fitting wall, the
  // cupboard YIELDS to the living room (cellFallback) — the fridge
  // outranks it in the kitchen (the user's priority), and it lands where
  // the fridge used to stand.
  { key: "cupboard", kind: "cupboard", radius: 0.6, openable: true, cluster: "kitchen",
    cell: { cell: "kitchen" }, cellFallback: [{ cell: "communal" }],
    place: { mode: "farMidThenSides" } },
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
  /** How it's MADE: input glyphs + the station that SPEEDS the work
   *  (construction pipeline ③). `at` never GATES — every craftable piece
   *  can be made by HAND, just slower (the workbench bootstrap: the first
   *  bench is hand-made); working at the named station cuts the labor to
   *  CRAFT_STATION_FACTOR. Absent craft = buy/import only. */
  craft?: { at?: StationKind; consumes: Record<string, number> };
  /** The piece's own words, per locale (content/words.ts joiner), keyed under
   *  the SPOKEN word (`fixtureWord`): the chest row folds to "box", so the
   *  words for "box" ride the box row and the chest row carries none. */
  words?: ItemWords;
}

/** Street-days of labor one furniture piece takes BY HAND. */
export const CRAFT_HAND_DAYS = 0.35;
/** Labor factor at the recipe's accelerating station — a bench-made piece
 *  takes a third of the hand labor. */
export const CRAFT_STATION_FACTOR = 1 / 3;

/** The labor a craft takes, in street-days, from the recipe's ACCELERATING
 *  STATION alone: hand rate, cut to the station factor when the crafter works
 *  there. Recipe-shape-agnostic on purpose — furniture is no longer the only
 *  thing the pipeline makes (toys ride the same clock), and the labor rule was
 *  never about what kind of thing was being made. */
export function craftLaborDaysFor(at: StationKind | undefined, atStation: boolean): number {
  return CRAFT_HAND_DAYS * (atStation && at ? CRAFT_STATION_FACTOR : 1);
}

/** The labor a FURNITURE craft takes — `craftLaborDaysFor` over its recipe. */
export function craftLaborDays(def: FurnitureItemDef, atStation: boolean): number {
  return craftLaborDaysFor(def.craft?.at, atStation);
}

/**
 * The AUTOMATED crafter's next piece (pipeline ③): with no standing bench
 * and none stored, the WORKBENCH comes first — the tool that speeds
 * everything after it, hand-made by necessity. Otherwise the day's rotation
 * pick, skipped (null) once 2 of that kind sit stored. Deterministic in
 * (day, salt).
 */
export function nextCraftKind(opts: {
  day: number;
  salt: number;
  hasBench: boolean;
  stored: (glyph: string) => number;
}): FurnitureItemDef | null {
  const craftable = FURNITURE_ITEMS.filter((f) => f.craft);
  if (!craftable.length) return null;
  const bench = craftable.find((f) => f.kind === "workbench");
  if (bench && !opts.hasBench && opts.stored(furnitureGlyph("workbench")) <= 0) return bench;
  const def = craftable[(opts.day + opts.salt) % craftable.length]!;
  if (opts.stored(furnitureGlyph(def.kind)) >= 2) return null;
  return def;
}

/** The glyph a stacked (unplaced) piece of furniture carries. */
export const furnitureGlyph = (kind: StationKind): string => `furn.${kind}`;

/** The station kind inside a furniture glyph — null for any other glyph.
 *
 *  FACET-TOLERANT: the kind is the FIRST modifier, and anything after it is an
 *  ordinary facet (`furn.chair.color_red` is a red chair). Matching the whole
 *  tail meant one painted piece read as "not furniture at all" — it kept the
 *  bookkeeping head `furn` through every word, icon and property lookup, which
 *  is the exact failure this prefix was supposed to be invisible to. */
export function furnitureKindOfGlyph(glyph: string): StationKind | null {
  if (!glyph.startsWith("furn.")) return null;
  const kind = glyph.slice("furn.".length).split(".")[0] ?? "";
  return FURNITURE_ITEMS.some((f) => f.kind === kind) ? (kind as StationKind) : null;
}

// Furniture consumes BLOCKS since construction phase 3 (decision 3: one
// natural→artificial path — a bed and a wall are made of the same stuff, at
// the same refinement ratio). Head-paid, so any material's block covers the
// bill; toys stay on raw wood (a whittled ball is smaller than a block).
//
// SIZED BY THE PIECE since phase 6: every row used to cost ONE block, which
// said a dining table and a waste bin are the same amount of timber. The bill
// now comes off the piece's own footprint radius (block-bill.ts
// `furnitureBlocks`) — the catalog's rule, applied one scale down, and for the
// same reason: a new station kind gets an honest bill the moment it declares a
// radius, with nobody guessing a number for it.
const FURNITURE_ROWS: ReadonlyArray<Omit<FurnitureItemDef, "craft">> = [
  {
    kind: "chair",
    radius: 0.22,
    openable: false,
    words: {
      en: { w: "chair" },
      he: { w: "כיסא", g: "m" },
      es: { w: "silla", g: "f" },
      pt: { w: "cadeira", g: "f" },
    },
  },
  {
    kind: "table",
    radius: 0.8,
    openable: false,
    words: {
      en: { w: "table" },
      he: { w: "שולחן", g: "m" },
      es: { w: "mesa", g: "f" },
      pt: { w: "mesa", g: "f" },
    },
  },
  {
    kind: "bed",
    radius: 0.65,
    openable: false,
    words: {
      en: { w: "bed" },
      he: { w: "מיטה", g: "f" },
      es: { w: "cama", g: "f" },
      pt: { w: "cama", g: "f" },
    },
  },
  { kind: "chest", radius: 0.55, openable: true },
  {
    kind: "cupboard",
    radius: 0.6,
    openable: true,
    words: {
      en: { w: "cabinet" },
      he: { w: "ארון", g: "m" },
      es: { w: "armario", g: "m" },
      pt: { w: "armário", g: "m" },
    },
  },
  {
    kind: "box",
    radius: 0.45,
    openable: false,
    words: {
      en: { w: "box" },
      he: { w: "קופסה", g: "f" },
      es: { w: "caja", g: "f" },
      pt: { w: "caixa", g: "f" },
    },
  },
  {
    kind: "bin",
    radius: 0.35,
    openable: true,
    words: {
      en: { w: "bin" },
      he: { w: "פח", g: "m" },
      es: { w: "papelera", g: "f" },
      pt: { w: "lixeira", g: "f" },
    },
  },
  {
    kind: "barrel",
    radius: 0.4,
    openable: true,
    words: {
      en: { w: "barrel" },
      he: { w: "חבית", g: "f" },
      es: { w: "barril", g: "m", plw: "barriles" },
      pt: { w: "barril", g: "m", plw: "barris" },
    },
  },
  /** The bootstrap tool: the FIRST bench is hand-made (slow); an existing
   *  bench speeds making the next, like everything else. */
  {
    kind: "workbench",
    radius: 0.7,
    openable: false,
    words: {
      en: { w: "workbench" },
      he: { w: "שולחן עבודה", g: "m" },
      es: { w: "banco de trabajo", g: "m", plw: "bancos de trabajo" },
      pt: { w: "bancada", g: "f" },
    },
  },
  /** The DOOR LEAF (construction phase 5) — the law's furniture piece. Cut at
   *  a bench, stacked as `furn.door`, carried to a doorway and HUNG there
   *  rather than set on a floor spot. The radius is the leaf's own half-width,
   *  not a footprint it claims — a hung door collides as part of the wall run,
   *  and a loose one is a slab you haul — but it is still what the leaf is made
   *  OF, so it prices the leaf like every other row. `openable: false` because
   *  what a door does is the doorway's mechanic, never the chest lid's
   *  (STATION_PROPERTIES says why). */
  {
    kind: "door",
    radius: 0.5,
    openable: false,
    words: {
      en: { w: "door" },
      he: { w: "דלת", g: "f" },
      es: { w: "puerta", g: "f" },
      pt: { w: "porta", g: "f" },
    },
  },
] as const;

/**
 * THE PIECES YOU CANNOT MAKE, WHICH ARE STILL PIECES.
 *
 * An oven is furniture. It stands in a room, it can be in your way, it can be
 * taken apart and carried to a better corner, and when it is off its feet it is
 * an oven lying on its side. The only thing it is NOT is something a household
 * cuts at a workbench: these arrive with their building, either from the goods
 * corner (the refrigerator) or down `StructureSpec.stations`
 * (workExtraStationDefs — the place-making set), and giving any of them a craft
 * row would put the automated crafter to work turning out stone benches two at
 * a time, forever. So they declare geometry and no recipe.
 *
 * 🚨 Splitting the list is the fix for a real class of bug: `FURNITURE_ITEMS`
 * means "a piece of furniture", and the CRAFTABLE subset is `f.craft`. Reading
 * the craftable catalogue as the definition of furniture is what made a
 * deconstructed oven render as a question mark (no def ⇒ no archetype ⇒ a bare
 * `furn.oven` glyph the artwork registry has never heard of) and what made an
 * ordered oven un-placeable (handlePlaceOrder refuses a kind it can't find, so
 * the outline stood on the floor and nobody ever came). The barrel and the
 * cupboard worked because you can make those.
 *
 * Radii are each kind's own, from the row that raises it: the goods corner for
 * the refrigerator, the CLUSTERS rows for the wet and kitchen stations, and
 * workExtraStationDefs' default for the place-making five.
 */
const FIXTURE_ROWS: ReadonlyArray<Omit<FurnitureItemDef, "craft">> = [
  {
    kind: "refrigerator",
    radius: 0.55,
    openable: true,
    words: {
      en: { w: "refrigerator" },
      he: { w: "מקרר", g: "m" },
      es: { w: "nevera", g: "f" },
      pt: { w: "geladeira", g: "f" },
    },
  },
  {
    kind: "oven",
    radius: 0.6,
    openable: false,
    words: {
      en: { w: "oven" },
      he: { w: "תנור", g: "m" },
      es: { w: "horno", g: "m", plw: "hornos" },
      pt: { w: "forno", g: "m" },
    },
  },
  {
    kind: "bath",
    radius: 0.75,
    openable: false,
    words: {
      en: { w: "bath" },
      he: { w: "אמבטיה", g: "f" },
      es: { w: "bañera", g: "f" },
      pt: { w: "banheira", g: "f" },
    },
  },
  {
    kind: "toilet",
    radius: 0.5,
    openable: false,
    words: {
      en: { w: "toilet" },
      he: { w: "אסלה", g: "f" },
      es: { w: "inodoro", g: "m" },
      pt: { w: "vaso sanitário", g: "m", plw: "vasos sanitários" },
    },
  },
  {
    kind: "bowl",
    radius: 0.25,
    openable: false,
    words: {
      en: { w: "bowl" },
      he: { w: "קערה", g: "f" },
      es: { w: "cuenco", g: "m" },
      pt: { w: "tigela", g: "f" },
    },
  },
  // The place-making five (workExtraStationDefs' proto default).
  {
    kind: "anvil",
    radius: 0.6,
    openable: false,
    words: {
      en: { w: "anvil" },
      he: { w: "סדן", g: "m" },
      es: { w: "yunque", g: "m", plw: "yunques" },
      pt: { w: "bigorna", g: "f" },
    },
  },
  {
    kind: "altar",
    radius: 0.6,
    openable: false,
    words: {
      en: { w: "altar" },
      he: { w: "מזבח", g: "m" },
      es: { w: "altar", g: "m", plw: "altares" },
      pt: { w: "altar", g: "m" },
    },
  },
  {
    kind: "loom",
    radius: 0.6,
    openable: false,
    words: {
      en: { w: "loom" },
      he: { w: "נול", g: "m" },
      es: { w: "telar", g: "m", plw: "telares" },
      pt: { w: "tear", g: "m" },
    },
  },
  {
    kind: "shelf",
    radius: 0.6,
    openable: false,
    words: {
      en: { w: "shelf" },
      he: { w: "מדף", g: "m" },
      es: { w: "estante", g: "m", plw: "estantes" },
      pt: { w: "estante", g: "f" },
    },
  },
  {
    kind: "stonecutter",
    radius: 0.6,
    openable: false,
    words: {
      en: { w: "stonecutter" },
      he: { w: "שולחן סיתות", g: "m" },
      es: { w: "banco de cantero", g: "m", plw: "bancos de cantero" },
      pt: { w: "bancada de cantaria", g: "f", plw: "bancadas de cantaria" },
    },
  },
] as const;

/**
 * EVERY PIECE OF FURNITURE THERE IS. The craftable rows carry a bench recipe
 * DERIVED from their own radius — the rows declare geometry, this declares that
 * furniture is cut from blocks at a workbench, and the two never drift apart.
 * The fixture rows carry no recipe, which is the ONLY thing that distinguishes
 * them: every consumer that means "craftable" already asks `f.craft`.
 */
export const FURNITURE_ITEMS: ReadonlyArray<FurnitureItemDef> = [
  ...FURNITURE_ROWS.map((r) => ({
    ...r,
    craft: { at: "workbench" as StationKind, consumes: blockCosts(furnitureBlocks(r.radius)) },
  })),
  ...FIXTURE_ROWS,
];

export const furnitureItemOf = (kind: StationKind): FurnitureItemDef | undefined =>
  FURNITURE_ITEMS.find((f) => f.kind === kind);

/**
 * IS THIS A WORKING STATION — a piece other things are made AT?
 *
 * The ENABLER test, asked from the spec side (never a kind list): a workbench
 * is a tool a household needs standing before it can work, a chair is a chair.
 * `craft.at` already declares the relation on every recipe, so this is the same
 * fact read in the other direction, and adding a forge or a loom recipe makes
 * that station an enabler with no edit here.
 *
 * The one caller that matters is the blueprint's "a place for the tools we own"
 * layer: a drawing that has nowhere to stand a bench is why a bench the family
 * MADE could never be stood up, and why the bump rule ate the one that was
 * (2026-08-05). Décor is deliberately excluded — a household standing up every
 * spare chair it owns is the blanket auto-place the user removed.
 */
export const isCraftStation = (kind: StationKind): boolean =>
  FURNITURE_ITEMS.some((f) => f.craft?.at === kind);

/** The room a station's own cluster belongs to (`workbench` → `workshop`), from
 *  the placement rows that already say so. Undefined for a kind no house or work
 *  row places — a piece with no natural room, which the caller answers for.
 *  Typed off `ANNEX_ROOM_KIND` rather than importing `HouseRoom` (rooms.ts reads
 *  this module; the arrow must not point back). */
export type StationRoomKind = (typeof ANNEX_ROOM_KIND)[AnnexCluster] | "living";
export const stationRoomKind = (kind: StationKind): StationRoomKind | undefined => {
  const row =
    HOUSE_STATIONS.find((s) => s.kind === kind) ?? WORK_STATIONS.find((s) => s.kind === kind);
  const cluster = row?.cluster;
  return cluster && cluster in ANNEX_ROOM_KIND
    ? ANNEX_ROOM_KIND[cluster as AnnexCluster]
    : cluster === "communal"
      ? "living"
      : undefined;
};

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
  // The PLACE-MAKING programs. The smithy and the weaver keep a stock band
  // (metal and thread arrive as goods and wait); the temple and the library
  // stay OPEN halls for the same reason the market does — the floor IS the
  // point. Their defining fixture arrives through `StructureSpec.stations`,
  // so the room it stands in DERIVES the kind (programs.ts) with no program
  // field per room type.
  smithy: { store: true },
  library: {},
  temple: {},
  // The MASONRY (construction phase 5). `{ store: true }` is also what
  // `workProgram` hands an UNREGISTERED type, so this row changes nothing
  // today — it is here because for a masonry the stock band is the whole
  // trade, not a convenience: rough stone arrives and waits, cut block piles
  // up and waits, and a masonry that silently became an open hall (the way an
  // unlisted type would the day someone changed that default) would be a
  // quarry yard with a bench in it. Written down so it cannot drift.
  masonry: { store: true },
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
