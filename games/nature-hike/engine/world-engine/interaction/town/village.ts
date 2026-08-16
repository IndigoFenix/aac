// shared/world-engine/interaction/town/village.ts
//
// Raise world-engine BUILDINGS on a projected quest layout: every non-start
// zone's rect becomes a house footprint (walls + a doorway aligned to each of
// the zone's layout doors), colored from the registry's color_* palette by the
// game's seed. The plaza (start zone) stays open ground.
//
// The colors aren't decoration: each house's composed SYMBOL ("home.color_blue")
// is the game's location vocabulary — where-is clues answer "{item} + in +
// home.color_blue" ("the ball is in the blue house"), so the palette must stay
// within registry-backed, speakable color modifiers (lang/* carry the words).
//
// Locked passages become locked ENGINE doors (solid until the quest runtime
// unlocks the passage — the player then calls unlockDoor with the id mapped
// here), so the physical world itself seals a room exactly as long as the
// certificate requires. Deterministic: same game (seed) → same buildings,
// colors, and clue symbols.

import type { Layout2D, Rect } from "../../solver/layout2d.js";
import type { LogicalWorld } from "../../solver/logical-world.js";
import type { GoalTreeGame } from "../../solver/types.js";
import type { BuildingDoorway, BuildingSpec } from "../../types.js";
import { getVocabularyItem } from "@shared/glyph-registry.js";
import { hashSeed, mulberry32 } from "@shared/prng.js";

/** The house wall thickness (world units). Thin enough that content staged
 *  with ~1 unit of wall clearance never intersects it. */
const HOUSE_WALL = 0.5;

/** Registry color modifiers houses draw from — every entry must have a lexeme
 *  in each shipped lang ruleset (they double as spoken clue words). */
const HOUSE_COLORS = [
  "color_red",
  "color_blue",
  "color_green",
  "color_yellow",
  "color_purple",
  "color_orange",
  "color_pink",
  "color_white",
] as const;

export interface VillagePlan {
  buildings: BuildingSpec[];
  /** passage id → the generated engine DOOR structure id(s) in its doorway.
   *  Usually one; a passage between two walled zones raises a coincident door
   *  in EACH building's wall — unlock all of them when the passage unlocks. */
  doorIdsByPassage: Record<string, string[]>;
  /** zone id → composed house symbol ("home.color_blue") — the clue vocabulary. */
  houseSymbolByZone: Record<string, string>;
  /** zone id → the house tint hex (the registry color's colorValue). */
  colorByZone: Record<string, string>;
}

type Edge = BuildingDoorway["edge"];

/** Which footprint edge a door rect sits on, and where along it. Null when the
 *  door doesn't straddle any edge (not a building-compatible layout). */
function doorwayOn(rect: Rect, door: Rect): { edge: Edge; offset: number; width: number } | null {
  const cx = door.x + door.w / 2;
  const cy = door.y + door.h / 2;
  const tol = Math.max(door.w, door.h); // door thickness straddles the edge
  const alongX = cx >= rect.x - 0.01 && cx <= rect.x + rect.w + 0.01;
  const alongY = cy >= rect.y - 0.01 && cy <= rect.y + rect.h + 0.01;
  if (alongX && Math.abs(cy - rect.y) <= tol) return { edge: "north", offset: cx - rect.x, width: door.w };
  if (alongX && Math.abs(cy - (rect.y + rect.h)) <= tol) return { edge: "south", offset: cx - rect.x, width: door.w };
  if (alongY && Math.abs(cx - rect.x) <= tol) return { edge: "west", offset: cy - rect.y, width: door.h };
  if (alongY && Math.abs(cx - (rect.x + rect.w)) <= tol) return { edge: "east", offset: cy - rect.y, width: door.h };
  return null;
}

/** Zone id → a valid world-engine structure id ("zone:q0_giver" → "house_zone_q0_giver"). */
function buildingId(zoneId: string): string {
  return `house_${zoneId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

/**
 * Plan the village's buildings from a projected layout (pass the EMBEDDED
 * layout — the one translated into world coordinates). Returns null when any
 * zone's door doesn't align to its rect edge (a layout buildings can't wall);
 * callers then keep the plain invisible-wall constraint.
 */
export function planVillageBuildings(
  game: GoalTreeGame,
  world: LogicalWorld,
  layout: Layout2D,
): VillagePlan | null {
  const houseZones = layout.zones.filter((z) => z.zoneId !== world.startZoneId);
  if (houseZones.length === 0) return null;

  // Seeded color assignment — its own sub-stream, so it never shifts when the
  // generator or projector draw more/less randomness.
  const seed = game.meta.seed ?? hashSeed(game.meta.title, ...world.zones.map((z) => z.id));
  const rng = mulberry32(hashSeed(seed, "houses"));
  const palette = [...HOUSE_COLORS];
  for (let i = palette.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [palette[i], palette[j]] = [palette[j]!, palette[i]!];
  }

  const guardedPassages = new Set(world.passages.filter((p) => p.guards.length > 0).map((p) => p.id));

  const buildings: BuildingSpec[] = [];
  const doorIdsByPassage: Record<string, string[]> = {};
  const houseSymbolByZone: Record<string, string> = {};
  const colorByZone: Record<string, string> = {};

  for (let i = 0; i < houseZones.length; i++) {
    const zone = houseZones[i]!;
    const bid = buildingId(zone.zoneId);
    const colorKey = palette[i % palette.length]!;
    const hex = getVocabularyItem(colorKey)?.modifier?.colorValue ?? "#9ca3af";

    // Every layout door touching this zone becomes a doorway in its wall.
    const byEdge = new Map<Edge, { passageId: string; offset: number; width: number }[]>();
    for (const door of layout.doors) {
      const passage = world.passages.find((p) => p.id === door.passageId);
      if (!passage || (passage.from !== zone.zoneId && passage.to !== zone.zoneId)) continue;
      const at = doorwayOn(zone.rect, door.rect);
      if (!at) return null; // a door off the wall — this layout can't be walled
      const list = byEdge.get(at.edge) ?? [];
      list.push({ passageId: door.passageId, offset: at.offset, width: at.width });
      byEdge.set(at.edge, list);
    }

    const doorways: BuildingDoorway[] = [];
    for (const [edge, list] of byEdge) {
      // buildingStructures indexes each edge's doors by offset order — mirror
      // that here so doorIdByPassage names the exact generated structure.
      list.sort((a, b) => a.offset - b.offset);
      list.forEach((d, di) => {
        doorways.push({
          edge,
          offset: d.offset,
          width: d.width,
          ...(guardedPassages.has(d.passageId) ? { locked: true } : {}),
        });
        (doorIdsByPassage[d.passageId] ??= []).push(`${bid}_${edge}_d${di}`);
      });
    }

    buildings.push({
      id: bid,
      footprint: zone.rect,
      floors: 1,
      wallThickness: HOUSE_WALL,
      doorways,
      color: hex,
    });
    houseSymbolByZone[zone.zoneId] = `home.${colorKey}`;
    colorByZone[zone.zoneId] = hex;
  }

  return { buildings, doorIdsByPassage, houseSymbolByZone, colorByZone };
}
