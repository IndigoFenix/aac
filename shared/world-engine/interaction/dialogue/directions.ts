// shared/world-engine/interaction/dialogue/directions.ts
//
// "Asking for directions" — the whole feature, pure/headless and unit-testable.
// Two halves: the GEOMETRY (proximity phrase + cardinal + point-at, immediately
// below) and, further down, the town's PLACE-KNOWLEDGE (which places residents can
// point you to, world↔town-local conversion, colour vocabulary).
//
// When a townsperson is asked where something is, this decides HOW they answer:
// which proximity phrase ("it's here" / "there" / "on this street" / "close" /
// "far") and, for the close/far phrases, which cardinal direction — plus the
// world point the camera should swivel to face (and the arm should point at).
//
// All positions are TOWN-LOCAL meters, the frame the street network lives in
// (the caller subtracts the town center off world coordinates before calling).
// Distance is measured two ways: straight-line for the "can I see it?" buckets
// (here / there) and street-walk metres (roadDistance) for close / far — the
// distance a person actually experiences. "Same street" is a topology test.

import { project, roadDistance, type TownStreets, type Vec2 } from "@shared/world-engine/kernel/town/streets.js";

/** How near the target is, in the fixed vocabulary the dialogue layer speaks. */
export type Proximity = "here" | "there" | "street" | "close" | "far";

/** Cardinal words. Y-DOWN convention (matches plan.ts doors): north = −y,
 *  south = +y, east = +x, west = −x. */
export type Cardinal = "north" | "south" | "east" | "west";

export interface DirectionsTuning {
  /** Straight-line "very, very close" ("it's here"). */
  hereR: number;
  /** Straight-line "within visual distance" ("it's there"). */
  visibleR: number;
  /** Street-walk metres under which the target is "close" (else "far"). */
  closeR: number;
}

/** Defaults tuned to town scale (plaza ~30 m radius, convenient shopping
 *  ~120 m of street per districts.ts). */
export const DEFAULT_DIRECTIONS_TUNING: DirectionsTuning = {
  hereR: 4,
  visibleR: 45,
  closeR: 140,
};

export interface DirectionAnswer {
  proximity: Proximity;
  /** The compass word for the close/far phrases. Always computed (from the
   *  straight-line bearing) so the caller can point even for here/there. */
  cardinal: Cardinal;
  /** Town-local point the camera swivels to face / the NPC points at. For
   *  "street" this lies down the street toward the target; otherwise it's the
   *  target itself. */
  pointAt: Vec2;
}

/** The cardinal word for the bearing from `from` to `to` (Y-down). */
export function cardinalOf(from: Vec2, to: Vec2): Cardinal {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "east" : "west";
  return dy >= 0 ? "south" : "north";
}

/**
 * Decide the directions answer from `from` to `to`.
 *
 * Priority is bottom-to-top of the spec list — the MOST specific phrasing wins:
 * here → there → same-street → close → far. So a target you can see reads as
 * "there" even if it also happens to sit on your street, and anything within
 * arm's reach reads as "here".
 */
export function directionsTo(
  net: TownStreets,
  from: Vec2,
  to: Vec2,
  tuning: DirectionsTuning = DEFAULT_DIRECTIONS_TUNING,
): DirectionAnswer {
  const straight = Math.hypot(to.x - from.x, to.y - from.y);
  const cardinal = cardinalOf(from, to);

  // 1. very, very close — "it's here"
  if (straight <= tuning.hereR) return { proximity: "here", cardinal, pointAt: to };
  // 2. within visual distance — "it's there"
  if (straight <= tuning.visibleR) return { proximity: "there", cardinal, pointAt: to };

  // 3. same street — "it's on this street" (point down the street toward it)
  const pa = project(net, from);
  const pb = project(net, to);
  if (pa.street === pb.street) {
    return { proximity: "street", cardinal, pointAt: pb.pt };
  }

  // 4/5. close / far by street-walk distance, with a compass bearing.
  const road = roadDistance(net, from, to);
  return { proximity: road <= tuning.closeR ? "close" : "far", cardinal, pointAt: to };
}

// ─────────────────────────────────────────────────────────────────────────────
// TOWN PLACE-KNOWLEDGE — the town's common knowledge of places and how a resident
// answers "where is X?" (world↔town-local conversion + colour vocabulary). Merged
// from the former town-directions.ts; shares the geometry above.
// ─────────────────────────────────────────────────────────────────────────────

/** A place the town knows about — resolved to a fixed WORLD position and the
 *  glyph that names it ("home.color_blue", "treat"). */
export interface PlaceFact {
  /** Stable subject id (host-assigned, e.g. "home:npc_wanter_0", "buy:cookie"). */
  id: string;
  /** How the thing is named when spoken ("The blue house is far, to the …"). */
  thingGlyph: string;
  /** Where the thing is, in WORLD metres. */
  worldPos: Vec2;
}

/** A resolved directions answer, in WORLD coordinates for the camera/arm. */
export interface PlaceDirections extends Omit<DirectionAnswer, "pointAt"> {
  thingGlyph: string;
  /** WORLD point the camera swivels to face and the NPC points at. */
  pointAtWorld: Vec2;
}

/**
 * A DISTINCT, nameable house palette for the symbol-game town (passed to
 * townPlan) — so residents can point you to "the blue house" and the wall the
 * player sees is the colour they were told. These hexes are the glyph-registry
 * colorValues, so `nearestColorSymbol` maps each back exactly. (grand-dream
 * keeps townPlan's default muted browns for its realistic look.)
 */
export const TOWN_HOUSE_PALETTE: readonly string[] = [
  "#DC2626", // red
  "#2563EB", // blue
  "#16A34A", // green
  "#FACC15", // yellow
  "#9333EA", // purple
  "#EA580C", // orange
  "#EC4899", // pink
  "#F3F4F6", // white
];

/** Nameable colour references (glyph-registry colorValues) → their color_* glyph
 *  symbol. Any house hex maps to the nearest of these. */
const COLOR_REFS: { sym: string; rgb: [number, number, number] }[] = [
  { sym: "color_red", rgb: [0xdc, 0x26, 0x26] },
  { sym: "color_orange", rgb: [0xea, 0x58, 0x0c] },
  { sym: "color_yellow", rgb: [0xfa, 0xcc, 0x15] },
  { sym: "color_green", rgb: [0x16, 0xa3, 0x4a] },
  { sym: "color_blue", rgb: [0x25, 0x63, 0xeb] },
  { sym: "color_purple", rgb: [0x93, 0x33, 0xea] },
  { sym: "color_pink", rgb: [0xec, 0x48, 0x99] },
  { sym: "color_brown", rgb: [0x92, 0x40, 0x0e] },
  { sym: "color_black", rgb: [0x11, 0x18, 0x27] },
  { sym: "color_white", rgb: [0xf3, 0xf4, 0xf6] },
];

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "").trim();
  const n = h.length === 3
    ? h.split("").map((c) => c + c).join("")
    : h.padEnd(6, "0").slice(0, 6);
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}

/** The color_* glyph symbol nearest a house's wall hex (RGB Euclidean). */
export function nearestColorSymbol(hex: string): string {
  const [r, g, b] = parseHex(hex);
  let best = COLOR_REFS[0]!;
  let bestD = Infinity;
  for (const c of COLOR_REFS) {
    const d = (c.rgb[0] - r) ** 2 + (c.rgb[1] - g) ** 2 + (c.rgb[2] - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best.sym;
}

/** The composed house glyph for a wall colour ("home.color_blue"). */
export function houseGlyphForColor(hex: string): string {
  return `home.${nearestColorSymbol(hex)}`;
}

/**
 * Resolve how a resident standing at `askerWorld` answers "where is {fact}?":
 * the proximity phrasing, the cardinal, and the WORLD point to point at. Streets
 * + centre are the town's; `askerWorld`/fact positions are WORLD metres.
 */
export function answerPlaceDirections(
  streets: TownStreets,
  center: Vec2,
  askerWorld: Vec2,
  fact: PlaceFact,
  tuning?: DirectionsTuning,
): PlaceDirections {
  const fromLocal = { x: askerWorld.x - center.x, y: askerWorld.y - center.y };
  const toLocal = { x: fact.worldPos.x - center.x, y: fact.worldPos.y - center.y };
  const ans = directionsTo(streets, fromLocal, toLocal, tuning);
  return {
    proximity: ans.proximity,
    cardinal: ans.cardinal,
    thingGlyph: fact.thingGlyph,
    pointAtWorld: { x: ans.pointAt.x + center.x, y: ans.pointAt.y + center.y },
  };
}
