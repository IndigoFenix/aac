/**
 * programs.ts — ROOM & STRUCTURE PROGRAMS (construction pipeline ④,
 * planning-docs/games/construction-pipeline.md "Function from contents").
 *
 * ONE table read in BOTH directions:
 *  - FORWARD (program → furniture): "bedroom" names a GOAL — a room holding
 *    the def's required furniture. Programs are goals.
 *  - BACKWARD (furniture → kind): a room's DERIVED KIND is a pure function
 *    of what stands in it (`roomKindOf` — first def in precedence order
 *    with a signature piece present). Kinds are facts.
 *  A building's character derives from its rooms the same way
 *  (`buildingKindOf` — a shell holding a bedroom, a living room, a kitchen
 *  and a bath IS a house). "Build a bedroom" and "build a room, then put a
 *  bed in it" reach the same end state by construction.
 *
 * The data below is the DEFAULT CULTURE. World docs override or extend it
 * through `game.culture.architecture.rooms` / `.buildings` (culture.ts —
 * the reserved sub-blocks made real): an authored def REPLACES the default
 * of the same name in place (precedence kept); a new name APPENDS after
 * the defaults. Unknown station kinds are rejected at the culture gate.
 *
 * Kernel layering: pure data + arithmetic; imports stay inside kernel/town.
 */

import { STATION_PROPERTIES, type StationKind } from "./stations.js";

/** One room program — a goal forward, a derivation rule backward. */
export interface RoomProgramDef {
  /** The room kind it names ("bedroom") — the HouseRoom.kind vocabulary,
   *  open to culture-authored additions. */
  kind: string;
  /** ALL of these standing in one room SATISFY the program (the goal). */
  requires: StationKind[];
  /** ANY of these standing in a room DERIVES the kind (the fact). */
  signature: StationKind[];
}

/** One structure program — what rooms make the building what it is. */
export interface StructureProgramDef {
  /** The building character it names ("house"). */
  type: string;
  /** Derived room kinds that must all be present. */
  rooms: string[];
}

/** Precedence order is semantics: the FIRST def whose signature matches
 *  claims the room, so the specific (workshop, kitchen) outranks the
 *  generic (store, living). */
export const DEFAULT_ROOM_PROGRAMS: ReadonlyArray<RoomProgramDef> = [
  { kind: "workshop", requires: ["workbench"], signature: ["workbench"] },
  { kind: "kitchen", requires: ["oven"], signature: ["oven"] },
  { kind: "bath", requires: ["privy"], signature: ["bath", "privy"] },
  { kind: "bedroom", requires: ["bed"], signature: ["bed"] },
  // Living BEFORE store: a hearth room holds goods chests beside its table,
  // and the table claims it; a chest standing alone is storage.
  { kind: "living", requires: ["table", "chair"], signature: ["table", "chair"] },
  { kind: "store", requires: ["chest"], signature: ["chest", "barrel", "bin"] },
];

export const DEFAULT_STRUCTURE_PROGRAMS: ReadonlyArray<StructureProgramDef> = [
  { type: "house", rooms: ["living", "bedroom", "kitchen", "bath"] },
  { type: "workshop", rooms: ["workshop"] },
  { type: "shop", rooms: ["store"] },
];

/** Culture-authored program blocks (culture.ts gates their shape; station
 *  kinds are validated HERE at resolve time — the clothing.ts split). */
export interface ProgramOverrides {
  rooms?: ReadonlyArray<RoomProgramDef>;
  buildings?: ReadonlyArray<StructureProgramDef>;
}

/** Authored culture rows (culture.ts gates their SHAPE) → sanitized
 *  overrides: unknown station kinds resolve to NO-OPS (dropped — the
 *  workstation-override precedent); a room def left without a valid
 *  required or signature piece is dropped whole. `signature` defaults to
 *  `requires`. */
export function programOverridesOf(arch?: {
  rooms?: ReadonlyArray<{ kind: string; requires: string[]; signature?: string[] }>;
  buildings?: ReadonlyArray<{ type: string; rooms: string[] }>;
}): ProgramOverrides {
  const known = (k: string): k is StationKind => k in STATION_PROPERTIES;
  const out: ProgramOverrides = {};
  if (arch?.rooms?.length) {
    const rooms: RoomProgramDef[] = [];
    for (const r of arch.rooms) {
      const requires = r.requires.filter(known);
      const signature = (r.signature ?? r.requires).filter(known);
      if (!requires.length || !signature.length) continue;
      rooms.push({ kind: r.kind, requires, signature });
    }
    if (rooms.length) out.rooms = rooms;
  }
  if (arch?.buildings?.length) {
    out.buildings = arch.buildings.map((b) => ({ type: b.type, rooms: [...b.rooms] }));
  }
  return out;
}

/** Merge authored defs over a default list: same name REPLACES in place
 *  (precedence kept), new names APPEND after the defaults. */
function mergeDefs<T>(
  defaults: ReadonlyArray<T>,
  authored: ReadonlyArray<T> | undefined,
  nameOf: (d: T) => string,
): ReadonlyArray<T> {
  if (!authored?.length) return defaults;
  const out = [...defaults];
  for (const a of authored) {
    const i = out.findIndex((d) => nameOf(d) === nameOf(a));
    if (i >= 0) out[i] = a;
    else out.push(a);
  }
  return out;
}

/** The room programs a session runs under (defaults ⊕ culture). */
export function resolveRoomPrograms(overrides?: ProgramOverrides): ReadonlyArray<RoomProgramDef> {
  return mergeDefs(DEFAULT_ROOM_PROGRAMS, overrides?.rooms, (d) => d.kind);
}

/** The structure programs a session runs under (defaults ⊕ culture). */
export function resolveStructurePrograms(
  overrides?: ProgramOverrides,
): ReadonlyArray<StructureProgramDef> {
  return mergeDefs(DEFAULT_STRUCTURE_PROGRAMS, overrides?.buildings, (d) => d.type);
}

export function roomProgramOf(
  kind: string,
  defs: ReadonlyArray<RoomProgramDef> = DEFAULT_ROOM_PROGRAMS,
): RoomProgramDef | null {
  return defs.find((d) => d.kind === kind) ?? null;
}

/** BACKWARD: the kind a room DERIVES from the furniture standing in it —
 *  first signature match in precedence order; a room with none (or empty)
 *  is a plain "hall". Furniture defines function. */
export function roomKindOf(
  present: Iterable<StationKind>,
  defs: ReadonlyArray<RoomProgramDef> = DEFAULT_ROOM_PROGRAMS,
): string {
  const set = new Set(present);
  for (const d of defs) {
    if (d.signature.some((k) => set.has(k))) return d.kind;
  }
  return "hall";
}

/** FORWARD: does this furniture set satisfy the program (all required
 *  pieces standing in the one room)? */
export function roomProgramMet(def: RoomProgramDef, present: Iterable<StationKind>): boolean {
  const set = new Set(present);
  return def.requires.every((k) => set.has(k));
}

/** BACKWARD, one level up: the character a building derives from its
 *  rooms' derived kinds — first structure def fully covered, else null
 *  (an empty box is just a building). */
export function buildingKindOf(
  roomKinds: Iterable<string>,
  defs: ReadonlyArray<StructureProgramDef> = DEFAULT_STRUCTURE_PROGRAMS,
): string | null {
  const set = new Set(roomKinds);
  for (const d of defs) {
    if (d.rooms.every((r) => set.has(r))) return d.type;
  }
  return null;
}
