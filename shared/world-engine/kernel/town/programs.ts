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
  /**
   * The INNER SYMBOL for this kind's icon (StructureSpec.symbol, mirrored):
   * the drawable thing the room is FOR — `bed` for the bedroom, `oven` for the
   * kitchen. Absent = the kind word doubles as its own symbol, which only
   * works when the lexicon can draw that word. DISPLAY ONLY; `kind` stays the
   * word everything else keys on.
   */
  symbol?: string;
  /**
   * Which CONTAINER FRAME the icon draws on. A room program defaults to the
   * `room` shell, but the SAME function is a private room in one culture and a
   * communal building in another — a bath is a bathroom in a house and a
   * bathhouse in a town that bathes together, a kitchen a scullery or a
   * cookhouse. The frame is what says which, over one unchanged program: same
   * required furniture, same derivation, different shell. `"none"` drops the
   * shell for a kind whose symbol is already a place (the `well` pattern).
   */
  frame?: "room" | "building" | "none";
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
// Each row's `symbol` is the FIRST piece of its own signature that the glyph
// lexicon can draw — so the icon shows the very fixture that derives the kind,
// and a room's picture can never drift from its rule.
export const DEFAULT_ROOM_PROGRAMS: ReadonlyArray<RoomProgramDef> = [
  { kind: "workshop", requires: ["workbench"], signature: ["workbench"], symbol: "workbench" },
  // ── THE PLACE-MAKING ROOMS ────────────────────────────────────────────
  // Four kinds whose signature fixture IS the room (stations.ts). They sit up
  // here beside the workshop because precedence is semantics and these are the
  // most specific fixtures in the table: a work building's hall always holds a
  // counter (a `table`) and often a barrel, so filed below `living` an anvil
  // would never claim its own floor — the smithy would derive as a living
  // room and `buildingKindOf` would never see a forge. A room with an anvil in
  // it is a forge no matter what else stands there.
  //
  // Each row is ALSO the historical overlap in one line: `frame` unset means
  // the private arrangement (the household shrine, the cottage loom), and a
  // culture that gathers instead flips the SAME row to `"building"` — the
  // temple, the weaving hall. One program, two social arrangements.
  { kind: "forge", requires: ["anvil"], signature: ["anvil"], symbol: "anvil" },
  { kind: "shrine", requires: ["altar"], signature: ["altar"], symbol: "altar" },
  { kind: "weaving", requires: ["loom"], signature: ["loom"], symbol: "loom" },
  { kind: "study", requires: ["shelf"], signature: ["shelf"], symbol: "shelf" },
  { kind: "kitchen", requires: ["oven"], signature: ["oven"], symbol: "oven" },
  { kind: "bath", requires: ["toilet"], signature: ["bath", "toilet"], symbol: "bath" },
  { kind: "bedroom", requires: ["bed"], signature: ["bed"], symbol: "bed" },
  // Living BEFORE store: a hearth room holds goods chests beside its table,
  // and the table claims it; a chest standing alone is storage.
  { kind: "living", requires: ["table", "chair"], signature: ["table", "chair"], symbol: "table" },
  // `box` for the store room, not `chest`: the station kind is a chest, but the
  // lexicon's word for a lidded container is `box` (things/furniture/box).
  { kind: "store", requires: ["chest"], signature: ["chest", "barrel", "bin"], symbol: "box" },
];

export const DEFAULT_STRUCTURE_PROGRAMS: ReadonlyArray<StructureProgramDef> = [
  { type: "house", rooms: ["living", "bedroom", "kitchen", "bath"] },
  { type: "workshop", rooms: ["workshop"] },
  { type: "shop", rooms: ["store"] },
  // The place-making buildings — each derives from its ONE defining room, the
  // same rule that makes a shell holding four household rooms a house. A
  // building that ends up with an anvil in it IS a smithy, however it was
  // built; nothing has to declare it.
  { type: "smithy", rooms: ["forge"] },
  { type: "temple", rooms: ["shrine"] },
  { type: "weaver", rooms: ["weaving"] },
  { type: "library", rooms: ["study"] },
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
  rooms?: ReadonlyArray<{
    kind: string;
    requires: string[];
    signature?: string[];
    symbol?: string;
    frame?: "room" | "building" | "none";
  }>;
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
      const def: RoomProgramDef = { kind: r.kind, requires, signature };
      // Icon marks ride through unvalidated: an unknown symbol word is a ❓ on
      // one button, not a broken room — the same "unknown resolves to a no-op"
      // rule the station kinds above follow.
      if (r.symbol) def.symbol = r.symbol;
      if (r.frame) def.frame = r.frame;
      rooms.push(def);
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

/**
 * The DISPLAY glyph for a room kind — `structureDisplayGlyph`'s twin
 * (structures.ts): the kind's symbol nested in its container frame,
 * `room(bed)`. Boards, the builder's room list and option strips render this;
 * TTS and every rule keep `kind`, which is the word.
 *
 * An unmarked kind falls back to the word as its own symbol — correct for a
 * kind the lexicon draws (`kitchen`), a ❓ for one it doesn't, which is the
 * signal to mark the row.
 */
export function roomDisplayGlyph(def: RoomProgramDef): string {
  const symbol = def.symbol ?? def.kind;
  const frame = def.frame ?? "room";
  return frame === "none" ? symbol : `${frame}(${symbol})`;
}

/** `roomDisplayGlyph` by kind name — the lookup boards actually have. Falls
 *  back to the bare word for a kind no program declares (a derived "hall"). */
export function roomKindDisplayGlyph(
  kind: string,
  defs: ReadonlyArray<RoomProgramDef> = DEFAULT_ROOM_PROGRAMS,
): string {
  const def = roomProgramOf(kind, defs);
  return def ? roomDisplayGlyph(def) : kind;
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
