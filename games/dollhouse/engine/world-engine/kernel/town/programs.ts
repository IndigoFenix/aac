/**
 * programs.ts — ROOM & STRUCTURE PROGRAMS (construction pipeline ④,
 * planning-docs/games/world-engine/construction-pipeline.md "Function from contents").
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
import type { ItemWords } from "../../interaction/lang/core.js";

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
  /**
   * The LEXICON WORD this kind is SPOKEN as, when the kind name is not itself a
   * word the lang layer carries — `fixtureWord`'s rule (types.ts) applied to
   * places, authored where the data lives.
   *
   * Every value MUST be a lang-layer lexicon key, because `baseWord` falls back
   * to the RAW ENGLISH KEY for anything it doesn't carry — which is exactly how
   * a Hebrew button ends up reading "house". Absent = the kind IS the word,
   * which is the normal case.
   */
  word?: string;
  /** The room word's own lexemes, per locale (content/words.ts joiner), keyed
   *  under `word ?? kind`. Absent when the word is a CORE ENGINE CONCEPT the
   *  central lexicons own (the bath program speaks "bathroom"). */
  words?: ItemWords;
}

/** One structure program — what rooms make the building what it is. */
export interface StructureProgramDef {
  /** The building character it names ("house"). */
  type: string;
  /** Derived room kinds that must all be present. */
  rooms: string[];
  /**
   * Inner symbol for the type's icon — `RoomProgramDef.symbol`'s twin, and for
   * the same reason: "smithy" is a word with no picture, `anvil` is a picture.
   * Absent = the type word doubles as its own symbol.
   *
   * Deliberately NOT derived from `rooms[0]`: a house's first room is its
   * living room, and `building(table)` is not a house.
   */
  symbol?: string;
  /** Container frame the icon draws on. Defaults to `building` — a structure
   *  program names a whole building. `"none"` drops the shell for a type whose
   *  symbol is already a place. */
  frame?: "building" | "room" | "none";
  /** The lexicon word this type is SPOKEN as — `RoomProgramDef.word`'s twin.
   *  `house` needs it: the lang layer's key is `home` (whose English word IS
   *  "house"), so an unfolded `house` would read raw English everywhere else. */
  word?: string;
  /** The type word's own lexemes, per locale — `RoomProgramDef.words`'s twin,
   *  keyed under `word ?? type`. Absent when a room program or the central
   *  lexicons already own the head (the house speaks core "home"; the
   *  workshop structure shares the workshop ROOM's word). */
  words?: ItemWords;
}

/** Precedence order is semantics: the FIRST def whose signature matches
 *  claims the room, so the specific (workshop, kitchen) outranks the
 *  generic (store, living). */
// Each row's `symbol` is the FIRST piece of its own signature that the glyph
// lexicon can draw — so the icon shows the very fixture that derives the kind,
// and a room's picture can never drift from its rule.
export const DEFAULT_ROOM_PROGRAMS: ReadonlyArray<RoomProgramDef> = [
  {
    kind: "workshop",
    requires: ["workbench"],
    signature: ["workbench"],
    symbol: "workbench",
    words: {
      en: { w: "workshop" },
      he: { w: "סדנה", g: "f", plw: "סדנאות" },
      es: { w: "taller", g: "m" },
      pt: { w: "oficina", g: "f" },
    },
  },
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
  {
    kind: "forge",
    requires: ["anvil"],
    signature: ["anvil"],
    symbol: "anvil",
    words: {
      en: { w: "forge" },
      he: { w: "מפוחה", g: "f" },
      es: { w: "forja", g: "f", plw: "forjas" },
      pt: { w: "forja", g: "f" },
    },
  },
  // The MASONRY (construction phase 5) — the forge's rule applied to stone,
  // and filed beside it for the same reason: a room with a stonecutter in it
  // is a masonry no matter what counter or barrel WORK_STATIONS also put
  // there. BELOW `workshop` deliberately, following the forge's precedent: a
  // floor holding both a workbench and a stonecutter is a carpenter's room
  // that happens to keep a slab, and the bench is the more general trade.
  {
    kind: "masonry",
    requires: ["stonecutter"],
    signature: ["stonecutter"],
    symbol: "stonecutter",
    words: {
      en: { w: "masonry", plw: "masonries" },
      he: { w: "חדר סיתות", g: "m" },
      es: { w: "cantería", g: "f", plw: "canterías" },
      pt: { w: "cantaria", g: "f" },
    },
  },
  {
    kind: "shrine",
    requires: ["altar"],
    signature: ["altar"],
    symbol: "altar",
    words: {
      en: { w: "shrine" },
      he: { w: "מקדש קטן", g: "m" },
      es: { w: "santuario", g: "m", plw: "santuarios" },
      pt: { w: "santuário", g: "m" },
    },
  },
  {
    kind: "weaving",
    requires: ["loom"],
    signature: ["loom"],
    symbol: "loom",
    words: {
      en: { w: "weaving room", plw: "weaving rooms" },
      he: { w: "חדר אריגה", g: "m" },
      es: { w: "sala de tejido", g: "f", plw: "salas de tejido" },
      pt: { w: "sala de tecelagem", g: "f" },
    },
  },
  {
    kind: "study",
    requires: ["shelf"],
    signature: ["shelf"],
    symbol: "shelf",
    words: {
      en: { w: "study", plw: "studies" },
      he: { w: "חדר עבודה", g: "m" },
      es: { w: "estudio", g: "m", plw: "estudios" },
      pt: { w: "escritório", g: "m" },
    },
  },
  {
    kind: "kitchen",
    requires: ["oven"],
    signature: ["oven"],
    symbol: "oven",
    words: {
      en: { w: "kitchen" },
      he: { w: "מטבח", g: "m" },
      es: { w: "cocina", g: "f" },
      pt: { w: "cozinha", g: "f" },
    },
  },
  // THE BATHROOM (user law): the room reads by its TOILET, not its tub — `bath`
  // is the FIXTURE ("I want a bath" is the tub), and the AAC's word for the
  // floor is `bathroom`, which is also what `ROOM_GLYPH` already speaks and what
  // the lang layer carries in all four rulesets. `requires` said as much long
  // before the icon did.
  { kind: "bath", requires: ["toilet"], signature: ["bath", "toilet"], symbol: "toilet", word: "bathroom" },
  {
    kind: "bedroom",
    requires: ["bed"],
    signature: ["bed"],
    symbol: "bed",
    words: {
      en: { w: "bedroom" },
      he: { w: "חדר שינה", g: "m", defw: "חדר השינה" },
      es: { w: "dormitorio", g: "m" },
      pt: { w: "quarto", g: "m" },
    },
  },
  // Living BEFORE store: a hearth room holds goods chests beside its table,
  // and the table claims it; a chest standing alone is storage.
  {
    kind: "living",
    requires: ["table", "chair"],
    signature: ["table", "chair"],
    // THE DEFAULT ROOM OF A HOUSE, drawn by WHO IS IN IT (user decision
    // 2026-08-25) — the same symbol the dwelling itself wears, since a living
    // room is the household's room. `room(table)` said "dining room", which is
    // a DIFFERENT concept that happens to share the fixture in this culture
    // (see the `dining` program below).
    symbol: "family",
    words: {
      en: { w: "living room", plw: "living rooms" },
      he: { w: "סלון", g: "m" },
      es: { w: "sala", g: "f", plw: "salas" },
      pt: { w: "sala", g: "f" },
    },
  },
  // ── THE FOOD ROOM (user decision 2026-08-25) ──────────────────────────────
  // A dining room and a living room are separate CONCEPTS that share a fixture:
  // in the default culture one room does both jobs, and the household eats at
  // the same table it sits around. So this row sits BELOW `living` and never
  // claims a floor here — precedence is semantics, and the shared room wins by
  // being first. A culture with room to spare splits them (the overlap-until-
  // there-is-space mechanism), and that split is the low-priority follow-up this
  // row exists to make possible.
  //
  // `symbol: "food"` — a food room, drawn as `room(food)`. No new artwork: the
  // container frame composes the category's own icon, exactly as the restaurant
  // (a food BUILDING) does one level up.
  {
    kind: "dining",
    requires: ["table"],
    signature: ["table"],
    symbol: "food",
    words: {
      en: { w: "dining room", plw: "dining rooms" },
      he: { w: "חדר אוכל", g: "m", defw: "חדר האוכל" },
      es: { w: "comedor", g: "m", plw: "comedores" },
      pt: { w: "sala de jantar", g: "f" },
    },
  },
  // `box` for the store room, not `chest`: the station kind is a chest, but the
  // lexicon's word for a lidded container is `box` (things/furniture/box).
  //
  // `word: "storeroom"` — STORAGE, said out loud. The kind is `store` and every
  // rule keys on that, but the bare English word is the AAC's word for a SHOP
  // (`store` → "Store" / "חנות"), and one word cannot draw both a shop and a
  // cupboard. The lang layer always meant storage here (en "storeroom", he
  // "מחסן", es "almacén", pt "despensa"); this gives that sense its own key so
  // the picture can follow it — storage draws `room(box)`, a shop draws trade.
  {
    kind: "store",
    requires: ["chest"],
    signature: ["chest", "barrel", "bin"],
    symbol: "box",
    word: "storeroom",
    words: {
      en: { w: "storeroom" },
      he: { w: "מחסן", g: "m" },
      es: { w: "almacén", g: "m", plw: "almacenes" },
      pt: { w: "despensa", g: "f" },
    },
  },
];

export const DEFAULT_STRUCTURE_PROGRAMS: ReadonlyArray<StructureProgramDef> = [
  // `word: "home"` — the lang layer's key for a dwelling is `home` (its English
  // word is literally "house"); the program type stays `house` because that is
  // what `buildingKindOf` reports and every rule keys on.
  // `symbol: "family"` — a dwelling is drawn by WHO LIVES IN IT. `building(home)`
  // framed a plate around a house icon, which says the word twice and the thing
  // once; the people inside are what makes a building a home. (Interim: a
  // dedicated living/dwelling symbol is coming, and this row is where it lands.)
  { type: "house", rooms: ["living", "bedroom", "kitchen", "bath"], symbol: "family", word: "home" },
  { type: "workshop", rooms: ["workshop"], symbol: "workbench" },
  {
    type: "shop",
    rooms: ["store"],
    symbol: "trade",
    words: {
      en: { w: "shop" },
      he: { w: "חנות", g: "f" },
      es: { w: "tienda", g: "f", plw: "tiendas" },
      pt: { w: "loja", g: "f" },
    },
  },
  // The place-making buildings — each derives from its ONE defining room, the
  // same rule that makes a shell holding four household rooms a house. A
  // building that ends up with an anvil in it IS a smithy, however it was
  // built; nothing has to declare it.
  {
    type: "smithy",
    rooms: ["forge"],
    symbol: "anvil",
    words: {
      en: { w: "smithy", plw: "smithies" },
      he: { w: "נפחייה", g: "f" },
      es: { w: "herrería", g: "f", plw: "herrerías" },
      pt: { w: "ferraria", g: "f" },
    },
  },
  // The MASONRY is the one place-making pair whose ROOM and BUILDING share a
  // word — a masonry is the room you cut in and the building that room fills,
  // the way a workshop already is (and unlike the forge/smithy, which have
  // two). Nothing needs to disambiguate them: `roomKindOf` and
  // `buildingKindOf` read different tables, and the builder's place list keeps
  // the first entry per word (buildings first), so the one button draws
  // `building(stonecutter)` — which is what a player means by "masonry".
  { type: "masonry", rooms: ["masonry"], symbol: "stonecutter" },
  {
    type: "temple",
    rooms: ["shrine"],
    symbol: "altar",
    words: {
      en: { w: "temple" },
      he: { w: "מקדש", g: "m" },
      es: { w: "templo", g: "m", plw: "templos" },
      pt: { w: "templo", g: "m" },
    },
  },
  {
    type: "weaver",
    rooms: ["weaving"],
    symbol: "loom",
    words: {
      en: { w: "weaver" },
      he: { w: "אריגה", g: "f" },
      es: { w: "tejeduría", g: "f", plw: "tejedurías" },
      pt: { w: "tecelagem", g: "f" },
    },
  },
  // THE RESTAURANT (user decision 2026-08-25): a FOOD BUILDING — the place you
  // go to eat that is not your own kitchen, and the first place-word a child
  // needs that the town has never modelled. Its room is the `dining` program,
  // which the default culture folds into the living room, so no building derives
  // as a restaurant here yet; the word, the icon and the relation to `eat` are
  // real from today. `symbol: "food"` draws it as `building(food)` — no new art.
  {
    type: "restaurant",
    rooms: ["dining"],
    symbol: "food",
    words: {
      en: { w: "restaurant" },
      he: { w: "מסעדה", g: "f" },
      es: { w: "restaurante", g: "m", plw: "restaurantes" },
      pt: { w: "restaurante", g: "m" },
    },
  },
  // `book`, where the STUDY room keeps `shelf`: the shelf is what derives the
  // room (a floor with a shelf on it is a study), but a library is a building
  // OF BOOKS — the shelf is furniture, the book is the point.
  {
    type: "library",
    rooms: ["study"],
    symbol: "book",
    words: {
      en: { w: "library", plw: "libraries" },
      he: { w: "ספריה", g: "f" },
      es: { w: "biblioteca", g: "f", plw: "bibliotecas" },
      pt: { w: "biblioteca", g: "f" },
    },
  },
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
  buildings?: ReadonlyArray<{
    type: string;
    rooms: string[];
    symbol?: string;
    frame?: "building" | "room" | "none";
  }>;
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
    out.buildings = arch.buildings.map((b) => {
      const def: StructureProgramDef = { type: b.type, rooms: [...b.rooms] };
      if (b.symbol) def.symbol = b.symbol;
      if (b.frame) def.frame = b.frame;
      return def;
    });
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

/** `roomDisplayGlyph` for a BUILDING character — the structure-program half.
 *  Defaults to the `building` shell, the mirror of a room's `room`. */
export function structureProgramDisplayGlyph(def: StructureProgramDef): string {
  const symbol = def.symbol ?? def.type;
  const frame = def.frame ?? "building";
  return frame === "none" ? symbol : `${frame}(${symbol})`;
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
