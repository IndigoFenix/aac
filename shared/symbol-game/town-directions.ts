// shared/symbol-game/town-directions.ts
//
// The town's COMMON KNOWLEDGE of places, and how a resident answers "where is
// X?". A place FACT is a thing the townsfolk can point you to — a character's
// home, where to buy a kind of good, a house of a given color. Every resident
// inherits every fact (common knowledge); the player only learns of a fact by
// hearing it, and may only ASK about facts they've learned (quest-host owns
// that per-player list). This module is the pure half: the colour vocabulary,
// the world↔town-local conversion, and the geometry-to-phrase resolution.
//
// Positions here are two frames: WORLD metres (the avatar-scale stage, what
// castSpawns / avatars use) and TOWN-LOCAL metres (relative to the town centre,
// the frame the street net lives in). The town centre bridges them.

import { directionsTo, type DirectionAnswer, type DirectionsTuning } from "./directions.js";
import type { TownStreets, Vec2 } from "@shared/engine/town/streets.js";

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
