/**
 * workstations.ts — THE WORKSTATION REGISTRY: the single runtime access
 * point for "what furniture can stand in a building, and in which of the
 * three PLACEMENT MODES." stations.ts still authors the DEFAULT rows
 * (HOUSE_STATIONS / WORK_STATIONS), but nothing outside this module reads
 * those arrays at runtime — every consumer (the geometry driver, the
 * interactive placement scorer, the board's property derivation) reads a
 * `WorkstationRegistry` instead. A default row and a row a culture/spec
 * contributes therefore behave identically once the game is running: they
 * are the same `WorkstationDef` flowing through the same registry.
 *
 * PLACEMENT MODE — where a workstation wants to live:
 *   in_room       a fixture dropped into the shared communal cell (the
 *                 hearth room) — the table, the chairs, the goods boxes.
 *   own_room      wants its cluster's own dedicated cell, merging into the
 *                 communal cell only when the footprint can't afford the
 *                 split (the kitchen's oven, the wet cell's bath, a
 *                 bedroom's bed, a workshop's bench).
 *   own_building  belongs to a whole work building's program (the shop
 *                 counter, the stock chests).
 *
 * In P0 the mode is DESCRIPTIVE — the geometry driver still resolves a
 * station through its `cluster`/`cell`/`cellOnly` fields exactly as before,
 * so the default registry furnishes byte-identically (the parity test is
 * the gate). The mode becomes load-bearing at P2, when a per-culture
 * `architecture` override may move a station between modes.
 *
 * Kernel layering: this module sits just above stations.ts (pure data) and
 * below placement.ts / furniture.ts — it imports only the station data, no
 * geometry.
 */

import {
  HOUSE_STATIONS,
  WORK_STATIONS,
  type CellRef,
  type StationDef,
  type StationKind,
} from "./stations.js";

/** The three ways a workstation can be placed (module doc). */
export type PlacementMode = "in_room" | "own_room" | "own_building";

/** Which building family a workstation is authored for. `house` rows
 *  furnish dwellings; `work` rows furnish work buildings. */
export type StationRole = "house" | "work";

/**
 * A station enriched with its placement MODE and building ROLE — the unit
 * the registry stores and every consumer reads. It is a superset of
 * `StationDef` (the geometry driver only ever touches the StationDef
 * fields), so a `WorkstationDef[]` drives `furnishPlan` unchanged.
 */
export interface WorkstationDef extends StationDef {
  role: StationRole;
  placement: PlacementMode;
  /** What the station DOES (cook | wash | craft | dye …) — reserved for the
   *  capability-decoupling step (P4); unset on the default registry. */
  capability?: string;
}

/**
 * Derive a default row's placement mode from its existing fields, so P0 is
 * a pure re-label (behaviour flows through cluster/cellOnly as before):
 *   - a `work` row belongs to a building program            → own_building
 *   - a house row in the shared communal cluster            → in_room
 *   - any other house row seeks its cluster's own cell       → own_room
 * (own_room still merges into communal where the geometry can't split — the
 * mode names the INTENT, the granularity budget decides the OUTCOME.)
 */
function defaultPlacementOf(def: StationDef, role: StationRole): PlacementMode {
  if (role === "work") return "own_building";
  return def.cluster === "communal" ? "in_room" : "own_room";
}

const enrich = (def: StationDef, role: StationRole): WorkstationDef => ({
  ...def,
  role,
  placement: defaultPlacementOf(def, role),
});

/** The runtime interface every consumer reads through. */
export interface WorkstationRegistry {
  /** Every workstation, both roles, in authored order. */
  readonly all: readonly WorkstationDef[];
  /** House furniture rows, in placement order (drives `houseFurniture`). */
  readonly house: readonly WorkstationDef[];
  /** Work-building rows, in placement order (drives `workFurniture`). */
  readonly work: readonly WorkstationDef[];
  /** The first HOUSE row of a kind — the aesthetic rulebook the interactive
   *  placement scorer rates a spot by (was `HOUSE_STATIONS.find`). */
  byKind(kind: StationKind): WorkstationDef | undefined;
  /** The HOUSE row with this key — anchor lookups (`besideAnchor`). */
  byKey(key: string): WorkstationDef | undefined;
  /** Every station kind whose row (or `kindByGood` model) opens — the
   *  board's "openable" sub-tab derives from this so it can never disagree
   *  with the mechanic that opens the lid. */
  readonly openableKinds: ReadonlySet<StationKind>;
}

/** Build a registry from house + work default rows. P2 will call this with
 *  culture-overridden rows; the shape it returns is identical. */
export function buildWorkstationRegistry(
  houseDefs: readonly StationDef[],
  workDefs: readonly StationDef[],
): WorkstationRegistry {
  const house = houseDefs.map((d) => enrich(d, "house"));
  const work = workDefs.map((d) => enrich(d, "work"));
  const all = [...house, ...work];

  const byKindMap = new Map<StationKind, WorkstationDef>();
  for (const d of house) if (!byKindMap.has(d.kind)) byKindMap.set(d.kind, d);
  const byKeyMap = new Map<string, WorkstationDef>();
  for (const d of house) if (!byKeyMap.has(d.key)) byKeyMap.set(d.key, d);

  const openableKinds = new Set<StationKind>();
  for (const d of all) {
    if (!d.openable) continue;
    openableKinds.add(d.kind);
    for (const model of Object.values(d.kindByGood ?? {})) openableKinds.add(model);
  }

  return {
    all,
    house,
    work,
    byKind: (kind) => byKindMap.get(kind),
    byKey: (key) => byKeyMap.get(key),
    openableKinds,
  };
}

/**
 * THE default registry — the town furnishes from this until a per-culture
 * `architecture` block (P2) resolves its own. This is the ONLY place the
 * default station arrays are read; every other module reads the registry.
 */
export const DEFAULT_WORKSTATION_REGISTRY: WorkstationRegistry =
  buildWorkstationRegistry(HOUSE_STATIONS, WORK_STATIONS);

/**
 * Synthesize placement rows for a work building's EXTRA declared stations
 * (`StructureSpec.stations` — the phase-② seam): bare station KINDS a
 * building wants beyond what its program implies (a weaver's loom, a dyer's
 * vat). Each stands on the shared work FLOOR (communal cell, wall-scan,
 * `own_building`); a kind the base work set already provides is skipped so a
 * declaration never doubles a fixture. Radius/openable reuse the kind's
 * house row where one exists, else a sane fixture default.
 *
 * This is how a work building stops emitting one fixed set for every
 * building — `workFurniture` appends these to `registry.work`.
 */
// ── PER-CULTURE OVERRIDE (P2) ───────────────────────────────────────────
// A culture's `architecture.workstations` block reshapes where a DWELLING's
// stations live: kind → a placement-mode override. Resolved at boot into the
// registry the town furnishes from, exactly as `dress` resolves into the
// active palette. Placement becomes LOAD-BEARING here — the override remaps
// the station's concrete cluster/cell/cellOnly so the geometry driver
// realizes the new mode. Overrides touch HOUSE rows only; a work building's
// fixtures are its own (P1 `StructureSpec.stations`), so a culture statement
// about the oven never leaks onto an inn's guest-kitchen floor.

/** A single station's placement override (culture.architecture.workstations). */
export interface WorkstationOverride {
  /** The mode to force. `in_room` flattens the station into the shared hearth
   *  room; `own_room` gives it its cluster's dedicated cell (its native
   *  cluster, or `room` when named). `own_building` is not a dwelling move —
   *  ignored for house rows. */
  placement?: PlacementMode;
  /** For `own_room` on a natively-communal station: the cluster/annex whose
   *  cell it should seek (else it keeps its native cluster). */
  room?: string;
}

/** kind → placement override — the `architecture.workstations` map. */
export type ArchitectureOverrides = Record<string, WorkstationOverride>;

/** The cell a cluster's stations seek — the inverse of a station's authored
 *  `cell`, for retargeting an override's `own_room` to a named cluster. */
function cellRefForCluster(cluster: string): CellRef {
  switch (cluster) {
    case "kitchen": return { cell: "kitchen" };
    case "wet": return { cell: "wet" };
    case "store": return { cell: "store" };
    case "workshop": return { cell: "workshop" };
    case "sleep": return { cell: "sleep", index: 0 };
    default: return { cell: "communal" };
  }
}

/** Remap one HOUSE station def to realize a placement override (module doc).
 *  Returns the def unchanged when the override is absent or a no-op. */
function applyOverride(def: StationDef, ov: WorkstationOverride | undefined): StationDef {
  if (!ov?.placement) return def;
  if (ov.placement === "in_room") {
    // Always in the shared communal cell — never earns its own room.
    return { ...def, cluster: "communal", cell: { cell: "communal" }, cellOnly: false };
  }
  if (ov.placement === "own_room") {
    // A dedicated cell: the named cluster, else the station's native one. A
    // natively-communal station with no `room` target has no room to give —
    // leave it (the gate can warn; resolve stays lenient).
    const cluster = ov.room ?? (def.cluster !== "communal" ? def.cluster : undefined);
    if (!cluster) return def;
    return { ...def, cluster, cell: cellRefForCluster(cluster), cellOnly: false };
  }
  // own_building: not a dwelling placement — a house station can't move to a
  // work building. Leave the row (P1 owns work-building fixtures).
  return def;
}

/**
 * Resolve a culture's architecture overrides to the registry a town furnishes
 * from. No overrides → the shared default registry (identity). Overrides remap
 * the matching HOUSE rows; WORK rows are untouched. buildWorkstationRegistry
 * re-derives each row's placement label FROM its remapped fields, so the
 * registry's `placement` always agrees with where the station actually stands.
 */
export function resolveWorkstationRegistry(
  overrides?: ArchitectureOverrides,
): WorkstationRegistry {
  if (!overrides || Object.keys(overrides).length === 0) return DEFAULT_WORKSTATION_REGISTRY;
  const house = HOUSE_STATIONS.map((d) => applyOverride(d, overrides[d.kind]));
  return buildWorkstationRegistry(house, WORK_STATIONS);
}

export function workExtraStationDefs(
  kinds: readonly StationKind[] | undefined,
  registry: WorkstationRegistry,
): WorkstationDef[] {
  if (!kinds?.length) return [];
  const have = new Set(registry.work.map((d) => d.kind));
  const seen = new Set<StationKind>();
  const out: WorkstationDef[] = [];
  for (const kind of kinds) {
    if (have.has(kind) || seen.has(kind)) continue;
    seen.add(kind);
    const proto = registry.byKind(kind);
    out.push({
      key: kind,
      kind,
      radius: proto?.radius ?? 0.6,
      openable: proto?.openable ?? false,
      cluster: "communal",
      cell: { cell: "communal" },
      place: { mode: "wallScan", walls: ["side0", "side1", "far"] },
      role: "work",
      placement: "own_building",
    });
  }
  return out;
}
