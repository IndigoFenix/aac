/**
 * culture.ts — the world's CULTURAL LAW declaration (nations arc P2,
 * planning-docs/games/world-engine/nations-and-empires.md §6).
 *
 * `game.culture` is the world spec's outermost, unrepealable ring:
 * UNIVERSAL ABSOLUTE TABOOS. An absolute law is a law a member of the
 * culture is PHYSICALLY UNABLE to break — the violating candidate never
 * enters any argmax (the cannotLeavePost pattern), and a commanded
 * violation is refused ALOUD with the law named ("we do not fight"),
 * never met with confusion. Parental controls are exactly this ring:
 * declared at world creation, immutable, not player-repealable.
 *
 * Per-culture (repealable, content-tier) laws use the SAME Law rows one
 * layer in (interaction/behavior/laws.ts); this module only declares the
 * universal ring and gates its SHAPE (the kernel gates shape; scope
 * builders own interpretation — the module law).
 */

import type { ArchitectureOverrides, WorkstationOverride } from "./kernel/town/workstations.js";
import { resolveRituals } from "./interaction/behavior/rituals.js";
import type { RitualCall, RitualStation, RitualTemplate } from "./interaction/behavior/rituals.js";

/** The three placement modes a culture may force a workstation into
 *  (kernel workstations.ts `PlacementMode`). Kept as a local constant so the
 *  gate names the allowed values without a runtime kernel dependency. */
const PLACEMENT_MODES = ["in_room", "own_room", "own_building"] as const;

/** The container frames a room program's icon may draw on (programs.ts
 *  RoomProgramDef.frame) — the private/communal choice, gated by shape here. */
const ROOM_FRAMES: readonly string[] = ["room", "building", "none"];

/** How a culture DRESSES (`game.culture.dress`) — the garment kinds its people
 *  wear and the colour palette they wear them in. A SELECTION from the garment
 *  vocabulary (creatures/clothing.ts): residents wear these, stores stock these,
 *  and only these get baked at boot, so a town reads as its own culture. Absent
 *  fields fall back to the curated default. */
export interface WorldDressSpec {
  /** Garment heads the culture wears ("shirt", "dress") — omit for the default
   *  (both). */
  kinds?: string[];
  /** Colour glyphs the culture wears ("color_red", …) — omit for the curated
   *  default. */
  palette?: string[];
}

/** An authored ROOM PROGRAM (`architecture.rooms[i]`, pipeline ④): what a
 *  room kind MEANS in this culture — the furniture that satisfies it
 *  (`requires`, all standing in one room) and the furniture that derives
 *  it (`signature`, any piece; defaults to `requires`). Kernel-validated
 *  at resolve time (programs.ts): unknown station kinds resolve to no-ops,
 *  the workstation-override precedent. */
export interface WorldRoomProgramSpec {
  kind: string;
  requires: string[];
  signature?: string[];
  /** Inner symbol for the kind's icon (programs.ts RoomProgramDef.symbol). */
  symbol?: string;
  /** Container frame the icon draws on — how a culture declares that a
   *  function it shares is a BUILDING where another keeps it a room. */
  frame?: "room" | "building" | "none";
}

/** An authored STRUCTURE PROGRAM (`architecture.buildings[i]`, pipeline ④):
 *  what rooms make a building this culture's "<type>". */
export interface WorldStructureProgramSpec {
  type: string;
  rooms: string[];
  /** Inner symbol for the type's icon (programs.ts StructureProgramDef.symbol). */
  symbol?: string;
  /** Container frame the icon draws on — the building half of the same mark. */
  frame?: "building" | "room" | "none";
}

/**
 * How a culture BUILDS (`game.culture.architecture`) — where its dwellings put
 * their workstations. `workstations` maps a fixture kind to a PLACEMENT-MODE
 * override: an open-hearth culture cooks `in_room` (the oven stands in the
 * shared hall), a formal one gives the oven its `own_room` (a separate
 * kitchen). Resolved into the workstation registry the town furnishes from —
 * the authored-then-resolved shape `dress` established. Absent kinds keep the
 * default placement.
 *
 * `rooms` / `buildings` (construction pipeline ④): the culture's PROGRAM
 * definitions — room kind → furniture, building type → rooms. One table read
 * both directions (kernel/town/programs.ts): programs are goals, derived
 * kinds are facts. Authored defs replace same-name defaults in place; new
 * names append. Absent = the kernel default culture.
 */
export interface WorldArchitectureSpec {
  /** Fixture kind → placement override (see kernel workstations.ts). */
  workstations?: ArchitectureOverrides;
  /** Room program defs (kernel defaults ⊕ these — programs.ts). */
  rooms?: WorldRoomProgramSpec[];
  /** Structure program defs (kernel defaults ⊕ these — programs.ts). */
  buildings?: WorldStructureProgramSpec[];
}

/**
 * How a culture GATHERS (`game.culture.rituals`) — its social activities, as
 * authored rows over the ritual vocabulary (interaction/behavior/rituals.ts).
 * A ritual is a declared, located, multi-party event: something calls it, a
 * place is chosen, the things it needs are prepared for the heads actually
 * coming, and they perform it together. A culture's meal, its play, later its
 * songs and dances.
 *
 * Authored rows are merged over the kernel defaults BY KEY (`resolveRituals`),
 * the same rule room and structure programs use: a same-key row replaces the
 * default in place, a new key appends. So a culture that only wants supper at
 * dusk declares one `meal` row with a window and inherits everything else.
 */
export interface WorldRitualSpec {
  key: string;
  calls: { need: string; kind: "strong" | "weak"; level: number }[];
  at: string[];
  prepare?: { category: string; per_head: number };
  station: { kind: "seat"; fixture: string } | { kind: "ring" };
  min_heads?: number;
  max_heads?: number;
  gather_s?: number;
  perform_s?: number;
  relieves?: string[];
  window?: { from: number; to: number };
}

/** The `game.culture` block as authored (snake_case, kernel-gated). */
export interface WorldCultureSpec {
  /** Verbs no member of any culture on this world can ever perform —
   *  lexicon verb words ("fight"). The universal absolute ring. */
  absolutes?: string[];
  /** How the culture dresses — drives resident outfits + wardrobe stock. */
  dress?: WorldDressSpec;
  /** How the culture builds — drives where dwellings place their workstations. */
  architecture?: WorldArchitectureSpec;
  /** How the culture gathers — its rituals (meals, play, later song/dance).
   *  Holds PARSED templates: unlike dress and architecture, a ritual row needs
   *  no live registry to resolve against, so `parseWorldRitualSpec` maps the
   *  authored `WorldRitualSpec` JSON straight into the vocabulary. */
  rituals?: RitualTemplate[];
}

/** The resolved culture a session runs under. */
export interface WorldCulture {
  /** The universal absolute taboos, as a closed set of forbidden verbs. */
  absolutes: ReadonlySet<string>;
  /** The culture's dress declaration, or undefined for the curated default. */
  dress?: WorldDressSpec;
  /** The culture's architecture declaration, or undefined for the default
   *  placement — resolve with `resolveWorkstationRegistry`. */
  architecture?: WorldArchitectureSpec;
  /** The culture's rituals, ALREADY MERGED over the kernel defaults
   *  (`resolveRituals`) — always populated, so a caller never has to know
   *  whether the world declared any. */
  rituals: readonly RitualTemplate[];
}

/** No declaration = no universal taboos, the curated default dress (the
 *  realism default — restricted worlds OPT IN to the ring), and the kernel's
 *  own rituals (every culture eats; a world that declares nothing still has
 *  meals and play). */
export const OPEN_CULTURE: WorldCulture = { absolutes: new Set(), rituals: resolveRituals() };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
// Explicitly annotated so callers narrow past a fail() (never-call
// control-flow analysis needs the variable's own type to say never).
const fail: (path: string, msg: string) => never = (path, msg) => {
  throw new Error(`${path}: ${msg}`);
};

/** Parse a bounded array of non-empty word strings (the absolutes/palette/kinds
 *  shape). Trims and rejects junk, per-index path. */
function parseWords(raw: unknown, path: string, max: number): string[] {
  if (!Array.isArray(raw)) fail(path, "expected an array of words");
  if (raw.length > max) fail(path, `at most ${max} entries`);
  return raw.map((v, i) => {
    if (typeof v !== "string" || !v.trim()) fail(`${path}[${i}]`, "expected a non-empty word");
    return v.trim();
  });
}

/** Parse + gate the `game.culture.dress` block: unknown fields REJECTED,
 *  kinds/palette = bounded word arrays (validated against the garment
 *  vocabulary at resolve time by the caller — this gates SHAPE only). */
export function parseWorldDressSpec(raw: unknown, path: string): WorldDressSpec {
  if (!isObj(raw)) fail(path, "expected an object (the dress declaration)");
  const allowed = ["kinds", "palette"];
  for (const k of Object.keys(raw as object)) {
    if (!allowed.includes(k)) fail(`${path}.${k}`, `unknown field (allowed: ${allowed.join(", ")})`);
  }
  const out: WorldDressSpec = {};
  const r = raw as Record<string, unknown>;
  if ("kinds" in r) out.kinds = parseWords(r.kinds, `${path}.kinds`, 8);
  if ("palette" in r) out.palette = parseWords(r.palette, `${path}.palette`, 16);
  return out;
}

/** Parse + gate the `game.culture.architecture` block: unknown fields
 *  REJECTED. `workstations` = kind → { placement, room }, placement one of the
 *  three modes. Gates SHAPE only (the kernel resolves an unknown kind to a
 *  no-op, exactly as dress gates shape and clothing.ts validates values). */
export function parseWorldArchitectureSpec(raw: unknown, path: string): WorldArchitectureSpec {
  if (!isObj(raw)) fail(path, "expected an object (the architecture declaration)");
  const allowed = ["workstations", "rooms", "buildings"];
  for (const k of Object.keys(raw as object)) {
    if (!allowed.includes(k)) fail(`${path}.${k}`, `unknown field (allowed: ${allowed.join(", ")})`);
  }
  const out: WorldArchitectureSpec = {};
  const r = raw as Record<string, unknown>;
  if ("workstations" in r) {
    const ws = r.workstations;
    if (!isObj(ws)) fail(`${path}.workstations`, "expected an object (fixture kind → placement)");
    const entries = Object.entries(ws as Record<string, unknown>);
    if (entries.length > 24) fail(`${path}.workstations`, "at most 24 station overrides");
    const map: ArchitectureOverrides = {};
    for (const [kind, v] of entries) {
      const p = `${path}.workstations.${kind}`;
      if (!isObj(v)) fail(p, "expected an object ({ placement, room })");
      const vr = v as Record<string, unknown>;
      const allowedW = ["placement", "room"];
      for (const kk of Object.keys(vr)) {
        if (!allowedW.includes(kk)) fail(`${p}.${kk}`, `unknown field (allowed: ${allowedW.join(", ")})`);
      }
      const ov: WorkstationOverride = {};
      if ("placement" in vr) {
        const pm = vr.placement;
        if (typeof pm !== "string" || !(PLACEMENT_MODES as readonly string[]).includes(pm)) {
          fail(`${p}.placement`, `expected one of ${PLACEMENT_MODES.join(" | ")}`);
        }
        ov.placement = pm as WorkstationOverride["placement"];
      }
      if ("room" in vr) {
        if (typeof vr.room !== "string" || !vr.room.trim()) fail(`${p}.room`, "expected a non-empty cluster name");
        ov.room = vr.room.trim();
      }
      map[kind] = ov;
    }
    out.workstations = map;
  }
  if ("rooms" in r) {
    if (!Array.isArray(r.rooms)) fail(`${path}.rooms`, "expected an array of room programs");
    if (r.rooms.length > 16) fail(`${path}.rooms`, "at most 16 room programs");
    out.rooms = r.rooms.map((v, i) => {
      const p = `${path}.rooms[${i}]`;
      if (!isObj(v)) fail(p, "expected an object ({ kind, requires, signature?, symbol?, frame? })");
      const vr = v as Record<string, unknown>;
      const allowedR = ["kind", "requires", "signature", "symbol", "frame"];
      for (const kk of Object.keys(vr)) {
        if (!allowedR.includes(kk)) fail(`${p}.${kk}`, `unknown field (allowed: ${allowedR.join(", ")})`);
      }
      if (typeof vr.kind !== "string" || !vr.kind.trim()) fail(`${p}.kind`, "expected a non-empty room kind");
      const spec: WorldRoomProgramSpec = {
        kind: vr.kind.trim(),
        requires: parseWords(vr.requires, `${p}.requires`, 8),
      };
      if ("signature" in vr) spec.signature = parseWords(vr.signature, `${p}.signature`, 8);
      if ("symbol" in vr) {
        if (typeof vr.symbol !== "string" || !vr.symbol.trim()) fail(`${p}.symbol`, "expected a non-empty symbol word");
        spec.symbol = vr.symbol.trim();
      }
      if ("frame" in vr) {
        if (typeof vr.frame !== "string" || !ROOM_FRAMES.includes(vr.frame)) {
          fail(`${p}.frame`, `expected one of ${ROOM_FRAMES.join(" | ")}`);
        }
        spec.frame = vr.frame as WorldRoomProgramSpec["frame"];
      }
      return spec;
    });
  }
  if ("buildings" in r) {
    if (!Array.isArray(r.buildings)) fail(`${path}.buildings`, "expected an array of structure programs");
    if (r.buildings.length > 16) fail(`${path}.buildings`, "at most 16 structure programs");
    out.buildings = r.buildings.map((v, i) => {
      const p = `${path}.buildings[${i}]`;
      if (!isObj(v)) fail(p, "expected an object ({ type, rooms, symbol?, frame? })");
      const vr = v as Record<string, unknown>;
      const allowedB = ["type", "rooms", "symbol", "frame"];
      for (const kk of Object.keys(vr)) {
        if (!allowedB.includes(kk)) fail(`${p}.${kk}`, `unknown field (allowed: ${allowedB.join(", ")})`);
      }
      if (typeof vr.type !== "string" || !vr.type.trim()) fail(`${p}.type`, "expected a non-empty structure type");
      const spec: WorldStructureProgramSpec = {
        type: vr.type.trim(),
        rooms: parseWords(vr.rooms, `${p}.rooms`, 8),
      };
      if ("symbol" in vr) {
        if (typeof vr.symbol !== "string" || !vr.symbol.trim()) fail(`${p}.symbol`, "expected a non-empty symbol word");
        spec.symbol = vr.symbol.trim();
      }
      if ("frame" in vr) {
        if (typeof vr.frame !== "string" || !ROOM_FRAMES.includes(vr.frame)) {
          fail(`${p}.frame`, `expected one of ${ROOM_FRAMES.join(" | ")}`);
        }
        spec.frame = vr.frame as WorldStructureProgramSpec["frame"];
      }
      return spec;
    });
  }
  return out;
}

/** A finite number in [min, max]. */
function parseNum(raw: unknown, path: string, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) fail(path, "expected a number");
  const n = raw as number;
  if (n < min || n > max) fail(path, `expected ${min}…${max}`);
  return n;
}

/** Parse + gate ONE `game.culture.rituals[i]` row into the ritual vocabulary.
 *  Gates SHAPE only — a `need` naming a template no creature runs, or an `at`
 *  naming a fixture the world has no kind for, resolves to a ritual that simply
 *  never fires (the workstation-override precedent: unknown names are no-ops,
 *  not errors). */
export function parseWorldRitualSpec(raw: unknown, path: string): RitualTemplate {
  if (!isObj(raw)) fail(path, "expected an object (a ritual declaration)");
  const r = raw as Record<string, unknown>;
  const allowed = [
    "key", "calls", "at", "prepare", "station",
    "min_heads", "max_heads", "gather_s", "perform_s", "relieves", "window",
  ];
  for (const k of Object.keys(r)) {
    if (!allowed.includes(k)) fail(`${path}.${k}`, `unknown field (allowed: ${allowed.join(", ")})`);
  }
  if (typeof r.key !== "string" || !r.key.trim()) fail(`${path}.key`, "expected a non-empty ritual key");

  if (!Array.isArray(r.calls) || r.calls.length === 0) fail(`${path}.calls`, "expected a non-empty array of calls");
  if (r.calls.length > 8) fail(`${path}.calls`, "at most 8 calls");
  const calls: RitualCall[] = r.calls.map((v, i) => {
    const p = `${path}.calls[${i}]`;
    if (!isObj(v)) fail(p, "expected an object ({ need, kind, level })");
    const vr = v as Record<string, unknown>;
    for (const kk of Object.keys(vr)) {
      if (!["need", "kind", "level"].includes(kk)) fail(`${p}.${kk}`, "unknown field (allowed: need, kind, level)");
    }
    if (typeof vr.need !== "string" || !vr.need.trim()) fail(`${p}.need`, "expected a need template key");
    if (vr.kind !== "strong" && vr.kind !== "weak") fail(`${p}.kind`, "expected strong | weak");
    return { tplKey: vr.need.trim(), kind: vr.kind, level: parseNum(vr.level, `${p}.level`, 0, 4) };
  });

  if (!isObj(r.station)) fail(`${path}.station`, "expected an object ({ kind: seat|ring })");
  const sr = r.station as Record<string, unknown>;
  let station: RitualStation;
  if (sr.kind === "ring") {
    for (const kk of Object.keys(sr)) if (kk !== "kind") fail(`${path}.station.${kk}`, "unknown field for a ring station");
    station = { kind: "ring" };
  } else if (sr.kind === "seat") {
    for (const kk of Object.keys(sr)) {
      if (!["kind", "fixture"].includes(kk)) fail(`${path}.station.${kk}`, "unknown field (allowed: kind, fixture)");
    }
    if (typeof sr.fixture !== "string" || !sr.fixture.trim()) fail(`${path}.station.fixture`, "expected a fixture kind");
    station = { kind: "seat", fixture: sr.fixture.trim() };
  } else {
    fail(`${path}.station.kind`, "expected seat | ring");
  }

  const out: RitualTemplate = {
    key: r.key.trim(),
    calls,
    at: parseWords(r.at, `${path}.at`, 8),
    station,
    minHeads: "min_heads" in r ? parseNum(r.min_heads, `${path}.min_heads`, 1, 32) : 1,
    maxHeads: "max_heads" in r ? parseNum(r.max_heads, `${path}.max_heads`, 1, 32) : 4,
    gatherS: "gather_s" in r ? parseNum(r.gather_s, `${path}.gather_s`, 0, 86400) : 30,
    performS: "perform_s" in r ? parseNum(r.perform_s, `${path}.perform_s`, 0, 86400) : 8,
  };
  if (out.maxHeads < out.minHeads) fail(`${path}.max_heads`, "must be at least min_heads");
  if ("prepare" in r) {
    const p = `${path}.prepare`;
    if (!isObj(r.prepare)) fail(p, "expected an object ({ category, per_head })");
    const pr = r.prepare as Record<string, unknown>;
    for (const kk of Object.keys(pr)) {
      if (!["category", "per_head"].includes(kk)) fail(`${p}.${kk}`, "unknown field (allowed: category, per_head)");
    }
    if (typeof pr.category !== "string" || !pr.category.trim()) fail(`${p}.category`, "expected an item category");
    out.prepare = { category: pr.category.trim(), perHead: parseNum(pr.per_head, `${p}.per_head`, 0, 32) };
  }
  if ("relieves" in r) out.relieves = parseWords(r.relieves, `${path}.relieves`, 8);
  if ("window" in r) {
    const p = `${path}.window`;
    if (!isObj(r.window)) fail(p, "expected an object ({ from, to })");
    const wr = r.window as Record<string, unknown>;
    for (const kk of Object.keys(wr)) {
      if (!["from", "to"].includes(kk)) fail(`${p}.${kk}`, "unknown field (allowed: from, to)");
    }
    // Day FRACTIONS, not hours — a world's day is whatever its scale says.
    out.window = { from: parseNum(wr.from, `${p}.from`, 0, 1), to: parseNum(wr.to, `${p}.to`, 0, 1) };
  }
  return out;
}

/** Parse + gate the `game.culture` block (the parseWorldScaleSpec
 *  pattern): unknown fields REJECTED, absolutes = ≤16 non-empty strings. */
export function parseWorldCultureSpec(raw: unknown, path: string): WorldCultureSpec {
  if (!isObj(raw)) fail(path, "expected an object (the cultural-law declaration)");
  const allowed = ["absolutes", "dress", "architecture", "rituals"];
  for (const k of Object.keys(raw as object)) {
    if (!allowed.includes(k)) fail(`${path}.${k}`, `unknown field (allowed: ${allowed.join(", ")})`);
  }
  const out: WorldCultureSpec = {};
  const r = raw as Record<string, unknown>;
  if ("absolutes" in r) out.absolutes = parseWords(r.absolutes, `${path}.absolutes`, 16);
  if ("dress" in r) out.dress = parseWorldDressSpec(r.dress, `${path}.dress`);
  if ("architecture" in r) out.architecture = parseWorldArchitectureSpec(r.architecture, `${path}.architecture`);
  if ("rituals" in r) {
    if (!Array.isArray(r.rituals)) fail(`${path}.rituals`, "expected an array of ritual declarations");
    if (r.rituals.length > 16) fail(`${path}.rituals`, "at most 16 rituals");
    out.rituals = r.rituals.map((v, i) => parseWorldRitualSpec(v, `${path}.rituals[${i}]`));
  }
  return out;
}

/** Resolve a (possibly absent) spec to the culture a session runs under.
 *  `rituals` is ALWAYS populated — the kernel defaults, with any authored rows
 *  merged over them by key — so no caller has to know whether a world declared
 *  any (every culture eats). */
export function resolveWorldCulture(spec?: WorldCultureSpec | null): WorldCulture {
  if (!spec?.absolutes?.length && !spec?.dress && !spec?.architecture && !spec?.rituals?.length) return OPEN_CULTURE;
  return {
    absolutes: new Set(spec?.absolutes ?? []),
    ...(spec?.dress ? { dress: spec.dress } : {}),
    ...(spec?.architecture ? { architecture: spec.architecture } : {}),
    rituals: resolveRituals(spec?.rituals),
  };
}
