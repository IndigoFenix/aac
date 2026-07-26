/**
 * furniture.ts — WHAT STANDS IN A HOUSE: the GEOMETRY DRIVER that
 * executes the STATION REGISTRY (stations.ts, §9 slice 1) against a
 * house's floor plan. Which pieces exist, their footprints, affordances
 * and placement RULES are data (HOUSE_STATIONS); this module owns only
 * the driver loop that realizes them — deterministically (no dice —
 * same house, same furniture, forever). Renderer-agnostic: the 3D view
 * raises solid, openable fixtures from these pieces; the overhead canvas
 * draws their rects when the roof is revealed. Views may ABSTRACT
 * furniture away with the unloaded house (it exists only while its
 * interior can matter — collision is meaningless in a house nobody can
 * be inside of).
 *
 * THE FIT MACHINERY lives in placement.ts (construction v1): the frame
 * transforms, zones, fits(), the service lane and the wall scans are the
 * SHARED predicates every placement path runs — this driver for the
 * generated set, the interactive paths (a resident placing bought
 * furniture, a directed "put chair near table") for one piece at a time.
 * One rulebook; a generated house and a player-directed placement are
 * judged identically.
 *
 * ROOMS (round 4): placement follows the house's floor plan
 * (kernel/town/rooms.ts) — each station seeks its CELL (its cluster's
 * room, with graceful fallbacks when a cluster merged down), and the
 * search respects every doorway's swing corridor (interior doors
 * included). A studio house (one room) lays out exactly as it always
 * did.
 *
 * Furniture (bar the table) hugs the WALLS, in CORNERS — a chest or a
 * cupboard stranded mid-room reads wrong. The table earns the middle.
 *
 * THE FIT RULE: every station is placed by one deterministic search —
 * its placement mode's candidates tried in a fixed order, taking the
 * FIRST spot that FITS: inside the cell's walls, clear of every earlier
 * piece, clear of every door swing corridor, clear of each goods chest's
 * standing spot. A room too small to fit a piece simply GOES WITHOUT
 * it — the function is pure, so an omitted piece is omitted forever, and
 * nothing ever overlaps or blocks a door.
 */

import type { TownHouse } from "./plan";
import {
  HOUSEHOLD,
  type BuildingProgram,
  type StationDef,
  type StationKind,
} from "./stations";
import {
  DEFAULT_WORKSTATION_REGISTRY,
  workExtraStationDefs,
  type WorkstationRegistry,
} from "./workstations";
import {
  buildingRoomPlan,
  houseRoomPlan,
  type HouseRoomPlan,
  type WorkShape,
} from "./rooms";
import type { BuildingDelta } from "./construction";
import {
  DOOR_DEPTH,
  PASS_THROUGH,
  axisFaceInto,
  cellDedicated,
  cornerThenWall,
  faceInto,
  fitsSvc,
  frameDirAngle,
  goodBoxPlacement,
  makePlacementContext,
  memberZone,
  scanWalls,
  serviceOk,
  toWorld,
  zoneForCell,
  type FurniturePiece,
  type PlacementContext,
  type Zone,
} from "./placement";

export type { StationKind };
export type { FurniturePiece };
export { PASS_THROUGH };

/** The furniture of one house. `goods` in slot order (a town's street
 *  goods) — each gets its chest at its own box corner.
 *
 *  CONSTRUCTION (v1): an optional BuildingDelta seeds the driver with
 *  the resident-PLACED pieces (facts on the ground — generated stations
 *  fit around them) and withholds the STOWED generated ids (their space
 *  genuinely frees; an anchored piece follows its anchor out). */
export function houseFurniture(
  center: { x: number; y: number },
  house: TownHouse,
  goods: ReadonlyArray<{ key: string; slot?: number }>,
  /** Id scope for multi-town worlds ("_riverton") — ids must be unique
   *  across every loaded town's furniture. */
  scope = "",
  delta?: BuildingDelta,
  /** The workstation registry to furnish from — the default global registry
   *  unless a per-culture `architecture` resolved its own (P2). */
  registry: WorkstationRegistry = DEFAULT_WORKSTATION_REGISTRY,
): FurniturePiece[] {
  return furnishPlan(
    center, house, houseRoomPlan(center, house, delta),
    registry.house, `furn${scope}_${house.index}`, goods, delta,
  );
}

/** The furniture of one WORK building (§9 slice 5) — the same driver and
 *  fit rule over the registry's work stations (no goods corners, no
 *  member boxes; a store room fills with stock chests). A building's own
 *  EXTRA stations (`work.stations`, from its StructureSpec — a weaver's
 *  loom, a dyer's vat) are appended to the base set, so buildings of the
 *  same program can still furnish differently. */
export function workFurniture(
  center: { x: number; y: number },
  index: number,
  work: WorkShape,
  program: BuildingProgram,
  scope = "",
  delta?: BuildingDelta,
  /** The workstation registry to furnish from (P2 per-culture, else default). */
  registry: WorkstationRegistry = DEFAULT_WORKSTATION_REGISTRY,
): FurniturePiece[] {
  // A BARE shell (⑤b) furnishes NOTHING from the registry — only its
  // delta's placed pieces stand (furnishPlan seeds them before any def).
  const defs = work.bare ? [] : [...registry.work, ...workExtraStationDefs(work.stations, registry)];
  return furnishPlan(
    center, work, buildingRoomPlan(center, index, work, program, delta),
    defs, `furn${scope}_w${index}`, [], delta,
  );
}

/** THE GEOMETRY DRIVER, shared by every building kind: realize a station
 *  registry against a floor plan (module doc above — THE FIT RULE). */
function furnishPlan(
  center: { x: number; y: number },
  shape: { dx: number; dy: number; w: number; h: number; door: TownHouse["door"]; species?: string },
  plan: HouseRoomPlan,
  defs: ReadonlyArray<StationDef>,
  idPrefix: string,
  goods: ReadonlyArray<{ key: string; slot?: number }>,
  delta?: BuildingDelta,
): FurniturePiece[] {
  // The shared fit machinery — ctx.pieces is the LIVE output list (the
  // predicates read it as this driver pushes into it).
  const ctx: PlacementContext = makePlacementContext(center, shape, plan, goods);
  const pieces = ctx.pieces;

  // CONSTRUCTION (v1): resident-placed pieces are FACTS ON THE GROUND —
  // seeded before any station so the driver fits around them; stowed
  // generated ids never emit (their space frees for later stations).
  const removed = new Set(delta?.removedPieces ?? []);
  for (const p of delta?.placed ?? []) {
    pieces.push({
      id: p.id, kind: p.kind, x: p.x, y: p.y,
      radius: p.radius, facing: p.facing, openable: p.openable,
      // Carry the delivered-but-not-set-up flag through so the view can stand
      // the real model on its side until a resident assembles it.
      ...(p.setUp !== undefined ? { setUp: p.setUp } : {}),
    });
  }

  const push = (
    z: Zone,
    id: string,
    kind: FurniturePiece["kind"],
    at: { u: number; v: number; facing?: number },
    radius: number,
    openable: boolean,
    good?: string,
  ): void => {
    if (removed.has(id)) return;
    const w = toWorld(ctx, at.u, at.v);
    pieces.push({
      id,
      kind,
      x: w.x,
      y: w.y,
      radius,
      // A wall scan supplies the wall's inward normal (already axis-aligned);
      // a corner spot supplies none — face it square down an axis toward the
      // most open space rather than diagonally at the room's centroid.
      facing: at.facing ?? axisFaceInto(ctx, z, w.x, w.y, radius),
      openable,
      ...(good !== undefined ? { good } : {}),
    });
  };

  // ---- THE DRIVER: realize the station registry, in its order — order
  // is semantics (earlier pieces claim space, later ones fit around
  // them). Anchored stations (the chairs, the bowl) look their anchor up
  // among the pieces already placed.
  const placedAt = new Map<string, { piece: FurniturePiece; u: number; v: number }>();
  const idOf = (suffix: string): string => `${idPrefix}_${suffix}`;
  /** A station's cell, then its cellFallback cells, resolved to zones and
   *  deduped (a fallback that resolves to the same zone — e.g. communal
   *  when no kitchen exists — is tried only once). */
  const cellZones = (c: PlacementContext, def: StationDef): Zone[] => {
    const seen = new Set<Zone>();
    const out: Zone[] = [];
    for (const ref of [def.cell, ...(def.cellFallback ?? [])]) {
      const z = zoneForCell(c, ref);
      if (!seen.has(z)) { seen.add(z); out.push(z); }
    }
    return out;
  };

  for (const def of defs) {
    if (def.partitionedOnly && !plan.partitioned) continue;
    if (def.minSleepCells !== undefined && plan.bedrooms.length < def.minSleepCells) continue;
    if (def.cellOnly && !cellDedicated(ctx, def.cell)) continue;
    const rule = def.place;
    const svc = !PASS_THROUGH.has(def.kind); // pass-through pieces skip the service lane

    if (rule.mode === "goodsCorner") {
      // Tucked FLUSH into a corner (edge against both walls) of the good's
      // OWN room — goodBoxPlacement picks it: the pantry fridge claims the
      // KITCHEN when one exists (the corner farthest from its door, so the
      // oven keeps a wall), every other good a living-room corner (0 SW ·
      // 1 SE · 2 NE · 3 NW). The errand's standing spot sits in FRONT of
      // the chest, so the shopper walks up to a spot clear of the solid
      // crate. Unconditional (the corner IS the box) — later kitchen
      // stations FIT AROUND the fridge, and the cupboard YIELDS to it.
      const inWall = def.radius + 0.1; // edge a hair off the wall (no z-fight)
      goods.forEach((g, i) => {
        const { room, corner } = goodBoxPlacement(center, shape, plan, g.slot ?? i);
        const r = room.rect;
        const chX = corner === 1 || corner === 2 ? r.x + r.w - inWall : r.x + inWall;
        const chY = corner === 0 || corner === 1 ? r.y + r.h - inWall : r.y + inWall;
        const zone = ctx.zones.find((z) => z.room.id === room.id) ?? ctx.zones[0]!;
        pieces.push({
          id: idOf(`${def.key}_${g.key}`),
          // The registry may override the MODEL per good (food → a
          // refrigerator). The ID keeps the `<key>_<good>` scheme, so the
          // goods plumbing is untouched — only the raised model differs.
          kind: def.kindByGood?.[g.key] ?? def.kind,
          x: chX,
          y: chY,
          radius: def.radius,
          // Square down a frame axis toward open floor (the refrigerator's
          // door then swings into ITS room, not across the diagonal into a
          // wall) — the general alignment rule, not a per-good angle.
          facing: axisFaceInto(ctx, zone, chX, chY, def.radius),
          openable: def.openable,
          good: g.key,
        });
      });
      continue;
    }

    if (rule.mode === "farMidThenSides") {
      // A studio keeps the classic midpoint of the wall opposite the
      // door. A PARTITIONED cell's far wall is the partition — its
      // midpoint is the table's column and its flanks carry door
      // corridors — so the piece moves to a side wall first. Its own cell
      // FIRST, then any cellFallback cells (the cupboard yields to the
      // living room when the fridge took its kitchen wall).
      for (const z of cellZones(ctx, def)) {
        const mid = { u: (z.u0 + z.u1) / 2, v: z.v1 - (def.radius + 0.1) };
        const midAt = fitsSvc(ctx, z, mid.u, mid.v, def.radius, svc)
          ? { ...mid, facing: frameDirAngle(ctx, 0, -1) }
          : null;
        const at = plan.partitioned
          ? scanWalls(ctx, z, ["side0", "side1"], def.radius, svc) ?? midAt
          : midAt ?? scanWalls(ctx, z, ["side0", "side1"], def.radius, svc);
        if (at) {
          push(z, idOf(def.key), def.kind, at, def.radius, def.openable);
          break;
        }
      }
      continue;
    }

    if (rule.mode === "centerFit") {
      // Off the cell's center toward the door half, leaving the middle
      // (the indoor wander tether's anchor) walkable. A STUDIO keeps the
      // classic spot as long as the room's service field stays connected
      // around it (the spot's edge may shade the door porch's tail —
      // bodies pass beside it; round 6e: the unconditional table was the
      // one piece exempt from every check, and in a hovel it sat square
      // in the doorway). Fails, or a PARTITIONED cell: FIT-SEARCHED
      // center-out — nothing fits ⇒ the house GOES WITHOUT (THE FIT
      // RULE).
      if (removed.has(idOf(def.key))) continue; // stowed: its anchor role goes with it
      const z = zoneForCell(ctx, def.cell);
      const shift = Math.min(z.u1 - z.u0, z.v1 - z.v0) * rule.prefShiftFrac;
      let at = { u: (z.u0 + z.u1) / 2, v: (z.v0 + z.v1) / 2 - shift };
      let found = !plan.partitioned && (!svc || serviceOk(ctx, z, at.u, at.v, def.radius));
      if (!found) {
        const prefV = Math.max(at.v, z.v0 + DOOR_DEPTH + def.radius + 0.1);
        const u0 = at.u;
        const dvMax = z.v1 - z.v0;
        const duMax = (z.u1 - z.u0) / 2;
        outer: for (let adv = 0; adv <= dvMax; adv += 0.4) {
          for (const dv of adv === 0 ? [0] : [adv, -adv]) {
            const v = prefV + dv;
            if (v < z.v0 || v > z.v1) continue;
            for (let adu = 0; adu <= duMax; adu += 0.6) {
              for (const du of adu === 0 ? [0] : [adu, -adu]) {
                const c = { u: u0 + du, v };
                if (fitsSvc(ctx, z, c.u, c.v, def.radius, svc)) {
                  at = c;
                  found = true;
                  break outer;
                }
              }
            }
          }
        }
      }
      if (found) {
        const piece: FurniturePiece = {
          id: idOf(def.key),
          kind: def.kind,
          ...toWorld(ctx, at.u, at.v),
          radius: def.radius,
          facing: 0,
          openable: def.openable,
        };
        pieces.push(piece);
        placedAt.set(def.key, { piece, u: at.u, v: at.v });
      }
      continue;
    }

    if (rule.mode === "besideAnchor") {
      const anchor = placedAt.get(rule.anchor);
      const z = zoneForCell(ctx, def.cell);
      if (rule.spread === "eachSide") {
        // Both sides independently, PERPENDICULAR to the door axis (the
        // door→anchor lane stays open). In a partitioned cell a blocked
        // side may retry the OTHER axis (a door corridor can claim one
        // flank) — omitted only when both are taken, never squeezed.
        if (!anchor) continue;
        const gap = anchor.piece.radius + def.radius + rule.gapPad;
        ([-1, 1] as const).forEach((side, i) => {
          const main =
            rule.axis === "u"
              ? { u: anchor.u + side * gap, v: anchor.v }
              : { u: anchor.u, v: anchor.v + side * gap };
          const other =
            rule.axis === "u"
              ? { u: anchor.u, v: anchor.v + side * gap }
              : { u: anchor.u + side * gap, v: anchor.v };
          const at = fitsSvc(ctx, z, main.u, main.v, def.radius, svc)
            ? main
            : rule.retryOtherAxisWhenPartitioned && plan.partitioned && fitsSvc(ctx, z, other.u, other.v, def.radius, svc)
              ? other
              : null;
          if (!at) return;
          if (removed.has(idOf(`${def.key}_${i}`))) return;
          const w = toWorld(ctx, at.u, at.v);
          pieces.push({
            id: idOf(`${def.key}_${i}`),
            kind: def.kind,
            x: w.x,
            y: w.y,
            radius: def.radius,
            facing: rule.faceAnchor
              ? Math.atan2(anchor.piece.y - w.y, anchor.piece.x - w.x)
              : faceInto(ctx, z, w.x, w.y),
            openable: def.openable,
          });
        });
        continue;
      }
      // "firstSide": the first side of the anchor that fits, with the
      // registry's wall fallback (also taken when the anchor itself went
      // without).
      const near = anchor
        ? ([-1, 1] as const)
            .map((side) =>
              rule.axis === "u"
                ? { u: anchor.u + side * (anchor.piece.radius + def.radius + rule.gapPad), v: anchor.v }
                : { u: anchor.u, v: anchor.v + side * (anchor.piece.radius + def.radius + rule.gapPad) },
            )
            .find((c) => fitsSvc(ctx, z, c.u, c.v, def.radius, svc))
        : undefined;
      const at = near ?? (rule.fallbackWalls ? scanWalls(ctx, z, rule.fallbackWalls, def.radius, svc) : null);
      if (at) push(z, idOf(def.key), def.kind, at, def.radius, def.openable);
      continue;
    }

    // Wall/corner stations — per-member ones seek each member's OWN
    // sleep cell (memberRoomOf), where the ownership layer roots their
    // PRIVATE tier (gifts and treasures live here; housemates' walkers
    // never touch it).
    const targets: Array<{ z: Zone; suffix: string }> =
      def.per === "member"
        ? Array.from({ length: HOUSEHOLD }, (_, m) => m)
            .map((m) => ({
              z: memberZone(ctx, m),
              suffix: `${def.key}_${m}`,
            }))
            .filter((t): t is { z: Zone; suffix: string } => !!t.z && t.z.room.kind === "bedroom")
        : [{ z: zoneForCell(ctx, def.cell), suffix: def.key }];
    for (const t of targets) {
      const at =
        rule.mode === "cornerThenWall"
          ? cornerThenWall(ctx, t.z, def.radius, rule.walls, svc)
          : scanWalls(ctx, t.z, rule.walls, def.radius, svc);
      if (!at) continue; // the room goes without (THE FIT RULE)
      push(t.z, idOf(t.suffix), def.kind, at, def.radius, def.openable);
    }
  }

  return pieces;
}
