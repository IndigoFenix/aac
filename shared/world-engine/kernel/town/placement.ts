/**
 * placement.ts — THE FIT MACHINERY, extracted from furniture.ts so that
 * ONE body of code answers "may this piece stand here?" for every caller:
 * the deterministic generator (furnishPlan) and the interactive paths
 * (a resident placing bought furniture, a player directing "put chair
 * near table"). Construction v1's cornerstone: generated houses and
 * player-directed placement obey IDENTICAL rules, because they run the
 * same predicates over the same context.
 *
 * The context is built once per building and shared with the driver —
 * `pieces` is a LIVE reference (the driver pushes into it as stations
 * land), and the service-lane flood's base grid is cached per
 * (zone, piece-count) exactly as it was inside furnishPlan (round 7:
 * rebuilding the solids grid per candidate dominated the furnish cost).
 *
 * Three exported layers:
 *   FEASIBILITY  placementFeasible — THE FIT RULE with the failure
 *                REASON surfaced (wall / door / piece / goods-spot /
 *                service) — "I cannot — because".
 *   NATURALNESS  placementScore — a graded 0..1 judgment of a FEASIBLE
 *                spot, derived entirely from the station registry's own
 *                placement rules (no new authored numbers) — "I don't
 *                want to — because".
 *   SEARCH       placementCandidates — feasible spots near an anchor /
 *                in a room, best-first — the creature's own judgment of
 *                where a directed piece should actually land.
 */

import type { TownHouse } from "./plan";
import {
  CLUSTERS,
  HOUSE_STATIONS,
  type CellRef,
  type StationDef,
  type StationKind,
  type WallKey,
} from "./stations";
import { memberRoomOf, type HouseRoom, type HouseRoomPlan } from "./rooms";
import { speciesBodyRadius } from "../../creatures/species";

export interface FurniturePiece {
  id: string;
  kind: StationKind;
  /** Center, world meters. */
  x: number;
  y: number;
  /** Half-extent (square footprint — also the collision box, except the
   *  pass-through kinds: a chair never blocks). */
  radius: number;
  /** Which way the lid/front faces (radians, 0 = +x) — into the room. */
  facing: number;
  openable: boolean;
  /** The street good whose household box this chest IS (pantry…). */
  good?: string;
}

/** A room as a rectangle in the house's door-local FRAME (u along the
 *  street-door wall, v inward), with its doorways' swing corridors. */
export interface Zone {
  room: HouseRoom;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  /** Door swing corridors (frame rects) that must stay walkable. */
  corridors: Array<{ u0: number; u1: number; v0: number; v1: number }>;
}

/** Kinds the engine never collides with (a chair or a floor bowl can be
 *  stood on/next to) — they neither block the service flood nor need a
 *  lane of their own. */
export const PASS_THROUGH: ReadonlySet<StationKind> = new Set(["chair", "bowl"]);

export const DOOR_DEPTH = 2.2; // the street door's swing corridor (gaze affordance)
// Interior doors need a walking LANE, not a porch. 1.5 m: the corridor rect
// only forbids OVERLAP, so a piece may sit flush against its inner end — the
// walkable strip left in front of the door is depth − wall band (0.6) − a
// body's berth beside the piece (0.4). At the old 1.1 that strip was 0.1 m:
// a legally-furnished living room pinched its own interior door shut, and
// residents ground at the mouth forever (the observed stuck-at-hall-doors).
// 1.5 leaves a 0.5 m lane — one honest body. (Round 5's double-bed worry is
// re-pinned by the room/furniture tests: beds still fit beyond the corridor.)
export const ROOM_DOOR_DEPTH = 1.5;
export const GAP = 0.05; // minimum daylight between two pieces
export const STEP = 0.25;
export const SPOT_IN = 1.75; // goodBoxAt's corner inset (keep in sync w/ rooms.ts doc)
export const SPOT_CLEAR = 0.5; // a body's worth of clearance around the spot

// The flood's body radius is THE CONSTRUCTING SPECIES' (ctx.bodyR — a house
// is furnished so ITS OWN species can pass), with the grid and wall band
// derived from it (ctx.svcStep / ctx.svcWall). The router's clearance
// contract (floor-route.ts planGeom) plans at the MOVER's radius on a grid
// at least as fine — a mover at/below the design size navigates what this
// flood certified, by construction.
const SVC_REACH = 0.9; // a standing cell within this of a piece's inflated edge

/** Corridor overlap carries an epsilon: a piece EXACTLY tangent to a
 *  door corridor is legal — without it, float dust (a derived door
 *  width's 1e-16) rejects the tangent spot and shoves the piece off
 *  its preferred place. */
const F_EPS = 1e-9;

/** The flood's BASE GRID (walls, corridors, the solids already placed —
 *  everything but the candidate), cached per (zone, placement state). */
interface SvcBase {
  zone: Zone;
  count: number;
  nu: number;
  nv: number;
  du: number;
  dv: number;
  base: Int8Array; // 1 open · 2 blocked (walls/solids)
  seeds: number[]; // open cells inside a door corridor (flood sources)
  solids: Array<{ u: number; v: number; r: number }>;
}

export interface PlacementContext {
  shape: { dx: number; dy: number; w: number; h: number; door: TownHouse["door"]; species?: string };
  /** The CONSTRUCTING SPECIES' body radius — what the service flood
   *  certifies passability for (speciesBodyRadius of shape.species). */
  bodyR: number;
  /** Flood grid pitch — at most 0.3, finer for a smaller design body. */
  svcStep: number;
  /** Wall keep-out band: wallThickness/2 + bodyR. */
  svcWall: number;
  /** House rect in world meters. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  plan: HouseRoomPlan;
  /** One zone per plan room, in room order (zones[0] = the living room). */
  zones: Zone[];
  /** LIVE piece list — the caller owns it and pushes as pieces land; the
   *  predicates read it every call (fits, the service flood's solids). */
  pieces: FurniturePiece[];
  /** Each goods chest's STANDING SPOT (goodBoxAt's corner inset) — the
   *  returning shopper stops there, so no station may cover it. */
  spots: Array<{ u: number; v: number }>;
  /** Service-flood base cache, keyed on (zone, pieces.length). */
  svc: { cache: SvcBase | null };
}

// ── The door-local HOUSE frame ──────────────────────────────────────────
// (u along the street-door wall 0..L, v from the door wall into the house
// 0..D) — one search space serves all four door sides; rooms are
// axis-aligned zones inside it.

export function toWorld(ctx: PlacementContext, u: number, v: number): { x: number; y: number } {
  switch (ctx.shape.door) {
    case "south": return { x: ctx.x0 + u, y: ctx.y1 - v };
    case "north": return { x: ctx.x0 + u, y: ctx.y0 + v };
    case "west": return { x: ctx.x0 + v, y: ctx.y0 + u };
    default: return { x: ctx.x1 - v, y: ctx.y0 + u }; // east
  }
}

export function toFrame(ctx: PlacementContext, x: number, y: number): { u: number; v: number } {
  switch (ctx.shape.door) {
    case "south": return { u: x - ctx.x0, v: ctx.y1 - y };
    case "north": return { u: x - ctx.x0, v: y - ctx.y0 };
    case "west": return { u: y - ctx.y0, v: x - ctx.x0 };
    default: return { u: y - ctx.y0, v: ctx.x1 - x }; // east
  }
}

/** World angle of a frame-space direction (for a wall's inward normal). */
export function frameDirAngle(ctx: PlacementContext, du: number, dv: number): number {
  const a = toWorld(ctx, 0, 0);
  const b = toWorld(ctx, du, dv);
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/** A room's world rect + doorways → a frame zone with door corridors. */
function zoneOf(ctx: PlacementContext, room: HouseRoom): Zone {
  const r = room.rect;
  const a = toFrame(ctx, r.x, r.y);
  const b = toFrame(ctx, r.x + r.w, r.y + r.h);
  const zone: Zone = {
    room,
    u0: Math.min(a.u, b.u),
    u1: Math.max(a.u, b.u),
    v0: Math.min(a.v, b.v),
    v1: Math.max(a.v, b.v),
    corridors: [],
  };
  for (const d of room.doorways) {
    // The door's center on its wall, in world → frame.
    const at =
      d.edge === "north" ? { x: r.x + d.offset, y: r.y }
      : d.edge === "south" ? { x: r.x + d.offset, y: r.y + r.h }
      : d.edge === "west" ? { x: r.x, y: r.y + d.offset }
      : { x: r.x + r.w, y: r.y + d.offset };
    const f = toFrame(ctx, at.x, at.y);
    const half = d.width / 2 + 0.1;
    // A door on the HOUSE PERIMETER is the street door (deep swing —
    // the gaze-steering porch); interior doors keep a walking lane.
    const EPS = 1e-3;
    const perimeter =
      Math.abs(at.y - ctx.y0) < EPS || Math.abs(at.y - ctx.y1) < EPS ||
      Math.abs(at.x - ctx.x0) < EPS || Math.abs(at.x - ctx.x1) < EPS;
    // Depths re-derive from the design body (exactly the documented
    // arithmetic: wall band (0.2+R) + a body's berth (R) + the lane) —
    // byte-identical to the historical 2.2 / 1.5 at the people default.
    const depth = perimeter
      ? Math.max(DOOR_DEPTH, 4 * ctx.bodyR + 0.6)
      : Math.max(ROOM_DOOR_DEPTH, 4 * ctx.bodyR - 0.1);
    // Corridor extends INWARD from whichever zone wall the door sits on.
    if (Math.abs(f.v - zone.v0) < EPS) {
      zone.corridors.push({ u0: f.u - half, u1: f.u + half, v0: zone.v0, v1: zone.v0 + depth });
    } else if (Math.abs(f.v - zone.v1) < EPS) {
      zone.corridors.push({ u0: f.u - half, u1: f.u + half, v0: zone.v1 - depth, v1: zone.v1 });
    } else if (Math.abs(f.u - zone.u0) < EPS) {
      zone.corridors.push({ u0: zone.u0, u1: zone.u0 + depth, v0: f.v - half, v1: f.v + half });
    } else {
      zone.corridors.push({ u0: zone.u1 - depth, u1: zone.u1, v0: f.v - half, v1: f.v + half });
    }
  }
  return zone;
}

/** Build the shared context for one building. `pieces` is adopted as the
 *  LIVE list (defaults to empty — the generator's starting state). */
export function makePlacementContext(
  center: { x: number; y: number },
  shape: PlacementContext["shape"],
  plan: HouseRoomPlan,
  goods: ReadonlyArray<{ key: string; slot?: number }>,
  pieces: FurniturePiece[] = [],
): PlacementContext {
  const x0 = center.x + shape.dx;
  const y0 = center.y + shape.dy;
  const bodyR = speciesBodyRadius(shape.species);
  const ctx: PlacementContext = {
    shape,
    bodyR,
    svcStep: Math.min(0.3, bodyR * 0.75),
    svcWall: 0.2 + bodyR, // wallThickness/2 + bodyR (rooms.ts arithmetic)
    x0,
    y0,
    x1: x0 + shape.w,
    y1: y0 + shape.h,
    plan,
    zones: [],
    pieces,
    spots: [],
    svc: { cache: null },
  };
  ctx.zones = plan.rooms.map((room) => zoneOf(ctx, room));
  const lr = plan.rooms[0]!.rect;
  ctx.spots = goods.map((g, i) => {
    const corner = (g.slot ?? i) % 4;
    return toFrame(
      ctx,
      corner === 1 || corner === 2 ? lr.x + lr.w - SPOT_IN : lr.x + SPOT_IN,
      corner === 0 || corner === 1 ? lr.y + lr.h - SPOT_IN : lr.y + SPOT_IN,
    );
  });
  return ctx;
}

/** A station's CELL → its zone, with the registry's fallbacks: a sleep
 *  index collapses onto the last cell that exists, a merged-down
 *  cluster resolves to the communal cell. (`member` is resolved per
 *  member by the driver — here it lands communal.) */
export function zoneForCell(ctx: PlacementContext, ref: CellRef): Zone {
  const { plan, zones } = ctx;
  const living = zones[0]!;
  const bedroomZone = (i: number): Zone | undefined =>
    zones.find((z) => z.room.id === plan.bedrooms[i]);
  switch (ref.cell) {
    case "communal": return living;
    case "sleep": {
      const id = plan.bedrooms[Math.min(ref.index, plan.bedrooms.length - 1)];
      return zones.find((z) => z.room.id === id) ?? living;
    }
    case "kids": return bedroomZone(1) ?? bedroomZone(0) ?? living;
    case "wet": return zones.find((z) => z.room.id === plan.bathId) ?? living;
    case "kitchen": return zones.find((z) => z.room.kind === "kitchen") ?? living;
    case "store": return zones.find((z) => z.room.kind === "store") ?? living;
    case "workshop": return zones.find((z) => z.room.kind === "workshop") ?? living;
    case "member": return living;
  }
}

/** cellOnly stations exist only where their cluster owns a DEDICATED
 *  cell — a fallback onto the communal cell means "no such room". */
export function cellDedicated(ctx: PlacementContext, ref: CellRef): boolean {
  return ref.cell === "communal" || zoneForCell(ctx, ref) !== ctx.zones[0]!;
}

/** The zone of one member's OWN sleep cell (per-member stations). */
export function memberZone(ctx: PlacementContext, member: number): Zone | undefined {
  return ctx.zones.find((z) => z.room.id === memberRoomOf(ctx.plan, member).id);
}

/** The zone holding a room id. */
export function zoneById(ctx: PlacementContext, roomId: string): Zone | undefined {
  return ctx.zones.find((z) => z.room.id === roomId);
}

/** The zone containing a WORLD point (undefined: outside every room). */
export function zoneAt(ctx: PlacementContext, x: number, y: number): Zone | undefined {
  const f = toFrame(ctx, x, y);
  return ctx.zones.find((z) => f.u >= z.u0 && f.u <= z.u1 && f.v >= z.v0 && f.v <= z.v1);
}

// ── FEASIBILITY (THE FIT RULE) ──────────────────────────────────────────

/** Does a square piece of half-extent `r` centered at (u,v) FIT in `z`? */
export function fits(ctx: PlacementContext, z: Zone, u: number, v: number, r: number): boolean {
  if (u - r < z.u0 + GAP || u + r > z.u1 - GAP || v - r < z.v0 + GAP || v + r > z.v1 - GAP) return false;
  for (const c of z.corridors) {
    if (u + r > c.u0 + F_EPS && u - r < c.u1 - F_EPS && v + r > c.v0 + F_EPS && v - r < c.v1 - F_EPS) return false;
  }
  for (const p of ctx.pieces) {
    const q = toFrame(ctx, p.x, p.y);
    if (Math.abs(u - q.u) < r + p.radius + GAP && Math.abs(v - q.v) < r + p.radius + GAP) return false;
  }
  for (const s of ctx.spots) {
    const berth = Math.max(SPOT_CLEAR, ctx.bodyR + 0.1); // a design body's berth
    if (Math.abs(u - s.u) < r + berth && Math.abs(v - s.v) < r + berth) return false;
  }
  return true;
}

// ---- THE SERVICE LANE (round 6e): fits() keeps pieces off doors and
// off each other, but two legal pieces can still PINCH the room — a
// station clear on paper yet wedged in practice (a body needs 1.2 m of
// daylight where pieces keep 0.05). So a SOLID piece is only accepted
// where the room's SERVICE FIELD stays connected: flood the walkable
// cells (engine keep-outs honored — 0.4 body, 0.6 wall band; door
// corridors are passage) and require the candidate, every solid piece
// already in the room AND every goods standing spot to keep a
// reachable standing cell.

function svcBaseFor(ctx: PlacementContext, z: Zone): SvcBase {
  const cached = ctx.svc.cache;
  if (cached && cached.zone === z && cached.count === ctx.pieces.length) return cached;
  const nu = Math.max(2, Math.ceil((z.u1 - z.u0) / ctx.svcStep));
  const nv = Math.max(2, Math.ceil((z.v1 - z.v0) / ctx.svcStep));
  const du = (z.u1 - z.u0) / nu;
  const dv = (z.v1 - z.v0) / nv;
  const uAt = (iu: number): number => z.u0 + (iu + 0.5) * du;
  const vAt = (iv: number): number => z.v0 + (iv + 0.5) * dv;
  // Solid stations IN this room (pass-through kinds never block or
  // claim service).
  const solids: Array<{ u: number; v: number; r: number }> = [];
  for (const p of ctx.pieces) {
    if (PASS_THROUGH.has(p.kind)) continue;
    const f = toFrame(ctx, p.x, p.y);
    if (f.u < z.u0 || f.u > z.u1 || f.v < z.v0 || f.v > z.v1) continue;
    solids.push({ u: f.u, v: f.v, r: p.radius });
  }
  const inCorridor = (u: number, v: number): boolean =>
    z.corridors.some((c) => u > c.u0 && u < c.u1 && v > c.v0 && v < c.v1);
  const base = new Int8Array(nu * nv); // 1 open · 2 blocked
  const seeds: number[] = [];
  for (let iv = 0; iv < nv; iv++) {
    for (let iu = 0; iu < nu; iu++) {
      const u = uAt(iu);
      const v = vAt(iv);
      let blocked = false;
      for (const s of solids) {
        if (Math.abs(u - s.u) < s.r + ctx.bodyR && Math.abs(v - s.v) < s.r + ctx.bodyR) {
          blocked = true;
          break;
        }
      }
      const corridor = inCorridor(u, v);
      if (!blocked) {
        const wallBand =
          u < z.u0 + ctx.svcWall || u > z.u1 - ctx.svcWall || v < z.v0 + ctx.svcWall || v > z.v1 - ctx.svcWall;
        if (wallBand && !corridor) blocked = true;
      }
      const k = iv * nu + iu;
      base[k] = blocked ? 2 : 1;
      if (!blocked && corridor) seeds.push(k);
    }
  }
  const built: SvcBase = { zone: z, count: ctx.pieces.length, nu, nv, du, dv, base, seeds, solids };
  ctx.svc.cache = built;
  return built;
}

/** Flood the zone with a candidate solid at (cu,cv,cr) blocked in, and
 *  return the reached/open cell state — the shared engine under
 *  serviceOk (pass/fail) and serviceMargin (graded). */
function svcFlood(
  ctx: PlacementContext,
  z: Zone,
  cu: number,
  cv: number,
  cr: number,
): { B: SvcBase; state: Int8Array } {
  const B = svcBaseFor(ctx, z);
  const { nu, nv, du, dv } = B;
  const uAt = (iu: number): number => z.u0 + (iu + 0.5) * du;
  const vAt = (iv: number): number => z.v0 + (iv + 0.5) * dv;
  const state = B.base.slice(); // 1 open · 2 blocked · 3 reached
  // Block the CANDIDATE's cells (bounded scan over its box only).
  {
    const reach = cr + ctx.bodyR;
    const iu0 = Math.max(0, Math.floor((cu - reach - z.u0) / du));
    const iu1 = Math.min(nu - 1, Math.ceil((cu + reach - z.u0) / du));
    const iv0 = Math.max(0, Math.floor((cv - reach - z.v0) / dv));
    const iv1 = Math.min(nv - 1, Math.ceil((cv + reach - z.v0) / dv));
    for (let iv = iv0; iv <= iv1; iv++) {
      for (let iu = iu0; iu <= iu1; iu++) {
        if (Math.abs(uAt(iu) - cu) < reach && Math.abs(vAt(iv) - cv) < reach) state[iv * nu + iu] = 2;
      }
    }
  }
  // Flood from the door corridors (the passage cells).
  const queue: number[] = [];
  for (const k of B.seeds) {
    if (state[k] === 1) {
      state[k] = 3;
      queue.push(k);
    }
  }
  while (queue.length) {
    const k = queue.pop()!;
    const iu = k % nu;
    const iv = (k / nu) | 0;
    if (iu > 0 && state[k - 1] === 1) { state[k - 1] = 3; queue.push(k - 1); }
    if (iu < nu - 1 && state[k + 1] === 1) { state[k + 1] = 3; queue.push(k + 1); }
    if (iv > 0 && state[k - nu] === 1) { state[k - nu] = 3; queue.push(k - nu); }
    if (iv < nv - 1 && state[k + nu] === 1) { state[k + nu] = 3; queue.push(k + nu); }
  }
  return { B, state };
}

export function serviceOk(ctx: PlacementContext, z: Zone, cu: number, cv: number, cr: number): boolean {
  const { B, state } = svcFlood(ctx, z, cu, cv, cr);
  const { nu, nv, du, dv } = B;
  const uAt = (iu: number): number => z.u0 + (iu + 0.5) * du;
  const vAt = (iv: number): number => z.v0 + (iv + 0.5) * dv;
  /** A reached cell within box-reach of the target = a standing spot. */
  const served = (tu: number, tv: number, tr: number): boolean => {
    const reach = tr + ctx.bodyR + SVC_REACH;
    const iu0 = Math.max(0, Math.floor((tu - reach - z.u0) / du));
    const iu1 = Math.min(nu - 1, Math.ceil((tu + reach - z.u0) / du));
    const iv0 = Math.max(0, Math.floor((tv - reach - z.v0) / dv));
    const iv1 = Math.min(nv - 1, Math.ceil((tv + reach - z.v0) / dv));
    for (let iv = iv0; iv <= iv1; iv++) {
      for (let iu = iu0; iu <= iu1; iu++) {
        if (state[iv * nu + iu] !== 3) continue;
        if (Math.abs(uAt(iu) - tu) <= reach && Math.abs(vAt(iv) - tv) <= reach) return true;
      }
    }
    return false;
  };
  for (const s of [{ u: cu, v: cv, r: cr }, ...B.solids]) {
    if (!served(s.u, s.v, s.r)) return false;
  }
  for (const sp of ctx.spots) {
    if (sp.u < z.u0 || sp.u > z.u1 || sp.v < z.v0 || sp.v > z.v1) continue;
    const iu = Math.min(nu - 1, Math.max(0, Math.floor((sp.u - z.u0) / du)));
    const iv = Math.min(nv - 1, Math.max(0, Math.floor((sp.v - z.v0) / dv)));
    if (state[iv * nu + iu] !== 3) return false;
  }
  return true;
}

/** GRADED service: the fraction of the zone's open cells still REACHED
 *  with the candidate in place, vs without it. 1 = the room flows as
 *  freely as before; low = the piece pinches it ("crowded"). */
export function serviceMargin(ctx: PlacementContext, z: Zone, cu: number, cv: number, cr: number): number {
  const before = svcFlood(ctx, z, cu, cv, 0 - 1); // negative radius: candidate blocks nothing
  const after = svcFlood(ctx, z, cu, cv, cr);
  let reachedBefore = 0;
  let reachedAfter = 0;
  for (let k = 0; k < before.state.length; k++) {
    if (before.state[k] === 3) reachedBefore++;
    if (after.state[k] === 3) reachedAfter++;
  }
  if (reachedBefore === 0) return 0;
  return Math.min(1, reachedAfter / reachedBefore);
}

/** fits + the service lane (pass-through pieces skip the lane — they
 *  neither block nor need serving). */
export function fitsSvc(
  ctx: PlacementContext,
  z: Zone,
  u: number,
  v: number,
  r: number,
  svc: boolean,
): boolean {
  return fits(ctx, z, u, v, r) && (!svc || serviceOk(ctx, z, u, v, r));
}

// ── WALL / CORNER SCANS (the generator's search primitives) ─────────────

/** First fitting flush spot along one of a zone's walls — the far wall
 *  (away from the street door) scanned end to end, a side wall scanned
 *  from its far end toward the door side. `facing` is the wall's inward
 *  normal. Null: the wall is full. */
export function scanWall(
  ctx: PlacementContext,
  z: Zone,
  wall: WallKey,
  r: number,
  svc: boolean,
): { u: number; v: number; facing: number } | null {
  const off = r + 0.1; // flush: edge a hair off the wall (no z-fight)
  if (wall === "far") {
    const v = z.v1 - off;
    for (let u = z.u0 + r + 0.15; u <= z.u1 - r - 0.15; u += STEP) {
      if (fitsSvc(ctx, z, u, v, r, svc)) return { u, v, facing: frameDirAngle(ctx, 0, -1) };
    }
    return null;
  }
  const u = wall === "side0" ? z.u0 + off : z.u1 - off;
  const facing = frameDirAngle(ctx, wall === "side0" ? 1 : -1, 0);
  for (let v = z.v1 - r - 0.15; v >= z.v0 + r + 0.15; v -= STEP) {
    if (fitsSvc(ctx, z, u, v, r, svc)) return { u, v, facing };
  }
  return null;
}

/** First fitting flush spot along the given walls, in order. */
export function scanWalls(
  ctx: PlacementContext,
  z: Zone,
  walls: ReadonlyArray<WallKey>,
  r: number,
  svc: boolean,
): { u: number; v: number; facing: number } | null {
  for (const wl of walls) {
    const at = scanWall(ctx, z, wl, r, svc);
    if (at) return at;
  }
  return null;
}

/** Door-less corners of the zone first, then the given walls. */
export function cornerThenWall(
  ctx: PlacementContext,
  z: Zone,
  r: number,
  walls: ReadonlyArray<WallKey>,
  svc: boolean,
): { u: number; v: number; facing?: number } | null {
  const off = r + 0.1;
  const corner = [
    { u: z.u0 + off, v: z.v1 - off },
    { u: z.u1 - off, v: z.v1 - off },
    { u: z.u0 + off, v: z.v0 + off },
    { u: z.u1 - off, v: z.v0 + off },
  ].find((c) => fitsSvc(ctx, z, c.u, c.v, r, svc));
  if (corner) return corner;
  return scanWalls(ctx, z, walls, r, svc);
}

export function zoneCenter(ctx: PlacementContext, z: Zone): { x: number; y: number } {
  return toWorld(ctx, (z.u0 + z.u1) / 2, (z.v0 + z.v1) / 2);
}

export function faceInto(ctx: PlacementContext, z: Zone, x: number, y: number): number {
  const c = zoneCenter(ctx, z);
  return Math.atan2(c.y - y, c.x - x);
}

// ── THE INTERACTIVE SURFACE ─────────────────────────────────────────────

export interface PlacementCandidate {
  /** Center, WORLD meters (the interactive callers live in world space). */
  x: number;
  y: number;
  radius: number;
  kind: StationKind;
}

export type PlacementVerdict =
  | { ok: true }
  /** Why the spot is IMPOSSIBLE — "I cannot, because…":
   *  outside     not inside any room / not the named room
   *  wall        overlaps a wall (or the piece can't clear the wall gap)
   *  door        sits in a door's swing corridor
   *  piece       overlaps another piece
   *  goods-spot  covers a shopper's standing spot
   *  service     would pinch the room (the service lane disconnects) */
  | { ok: false; reason: "outside" | "wall" | "door" | "piece" | "goods-spot" | "service" };

export type PlacementFailure = Exclude<PlacementVerdict, { ok: true }>["reason"];

/** THE FIT RULE with the failure reason surfaced. Same checks, same
 *  order, same epsilons as the generator's fits()/serviceOk(). */
export function placementFeasible(
  ctx: PlacementContext,
  roomId: string,
  cand: PlacementCandidate,
): PlacementVerdict {
  const z = zoneById(ctx, roomId);
  if (!z) return { ok: false, reason: "outside" };
  const { u, v } = toFrame(ctx, cand.x, cand.y);
  const r = cand.radius;
  if (u < z.u0 || u > z.u1 || v < z.v0 || v > z.v1) return { ok: false, reason: "outside" };
  if (u - r < z.u0 + GAP || u + r > z.u1 - GAP || v - r < z.v0 + GAP || v + r > z.v1 - GAP) {
    return { ok: false, reason: "wall" };
  }
  for (const c of z.corridors) {
    if (u + r > c.u0 + F_EPS && u - r < c.u1 - F_EPS && v + r > c.v0 + F_EPS && v - r < c.v1 - F_EPS) {
      return { ok: false, reason: "door" };
    }
  }
  // Piece/spot overlap carries F_EPS: the generator placed tangent pieces
  // in EXACT frame coordinates; a world→frame round trip may land a hair
  // inside (1e-14), and a legal tangency must not read as an overlap.
  for (const p of ctx.pieces) {
    const q = toFrame(ctx, p.x, p.y);
    if (Math.abs(u - q.u) < r + p.radius + GAP - F_EPS && Math.abs(v - q.v) < r + p.radius + GAP - F_EPS) {
      return { ok: false, reason: "piece" };
    }
  }
  for (const s of ctx.spots) {
    if (Math.abs(u - s.u) < r + SPOT_CLEAR - F_EPS && Math.abs(v - s.v) < r + SPOT_CLEAR - F_EPS) {
      return { ok: false, reason: "goods-spot" };
    }
  }
  if (!PASS_THROUGH.has(cand.kind) && !serviceOk(ctx, z, u, v, r)) {
    return { ok: false, reason: "service" };
  }
  return { ok: true };
}

/** Why a feasible spot still strains the room's sensibilities — "I don't
 *  want to, because…". Maps 1:1 to the dialogue layer's causes. */
export type PlacementFactor =
  | "wrong-room" // the room mismatches the station's cluster/privacy
  | "crowded" // the service lane barely survives (the room pinches)
  | "mid-room" // a wall-hugging kind stranded away from its walls
  | "off-wall" // near its wall but not flush (minor untidiness)
  | "far-from-anchor"; // an anchored kind far from its anchor (chair↔table)

export interface PlacementScore {
  /** 0..1 naturalness; 0 iff the spot is infeasible. */
  score: number;
  factors: PlacementFactor[];
  /** The worst offending factor, for the refusal line. */
  gripe?: PlacementFactor;
}

/** The registry row a kind places by — the first HOUSE_STATIONS def of
 *  that kind (the registry IS the aesthetic rulebook), with a wall-scan
 *  default for kinds no house row covers. */
export function stationDefFor(kind: StationKind): StationDef {
  const def = HOUSE_STATIONS.find((d) => d.kind === kind);
  return (
    def ?? {
      key: kind,
      kind,
      radius: 0.5,
      openable: false,
      cluster: "communal",
      cell: { cell: "communal" },
      place: { mode: "wallScan", walls: ["far", "side0", "side1"] },
    }
  );
}

/** How well would this kind's own placement rule rate the spot? All
 *  components derive from the station registry — no new authored
 *  numbers. Score 0 iff infeasible. */
export function placementScore(
  ctx: PlacementContext,
  defOrKind: StationDef | StationKind,
  cand: PlacementCandidate,
  roomId: string,
): PlacementScore {
  const def = typeof defOrKind === "string" ? stationDefFor(defOrKind) : defOrKind;
  const verdict = placementFeasible(ctx, roomId, cand);
  if (!verdict.ok) return { score: 0, factors: [] };
  const z = zoneById(ctx, roomId)!;
  const { u, v } = toFrame(ctx, cand.x, cand.y);
  const factors: PlacementFactor[] = [];

  // CELL — the right room is the station's own cell resolution; a wrong
  // room degrades with door-graph privacy distance (a bed in the hall).
  // A `member` cell is AT HOME in any bedroom (the driver resolves it per
  // member; here any private cell is its natural habitat), and a `sleep`
  // index likewise accepts any bedroom — "which bedroom" is a household
  // matter, not an aesthetic one.
  const target = zoneForCell(ctx, def.cell);
  const anyBedroom =
    (def.cell.cell === "member" || def.cell.cell === "sleep" || def.cell.cell === "kids") &&
    z.room.kind === "bedroom";
  const privacy = CLUSTERS[def.cluster]?.privacy ?? 0;
  const cell = z === target || anyBedroom ? 1 : Math.min(0.6, 1 / (1 + Math.abs(z.room.depth - privacy)));
  if (cell < 1) factors.push("wrong-room");

  // PLACE — the station's own placement mode judges the geometry.
  const rule = def.place;
  const shortSide = Math.min(z.u1 - z.u0, z.v1 - z.v0);
  const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
  let place = 1;
  if (rule.mode === "wallScan" || rule.mode === "cornerThenWall" || rule.mode === "farMidThenSides") {
    // Distance from the nearest flush line of the mode's walls (every
    // wall for the corner modes — a corner is two walls at once).
    const walls: ReadonlyArray<WallKey> =
      rule.mode === "farMidThenSides" ? ["far", "side0", "side1"] : rule.walls;
    const off = cand.radius + 0.1;
    const dists = walls.map((w) =>
      w === "far" ? Math.abs(z.v1 - off - v) : w === "side0" ? Math.abs(z.u0 + off - u) : Math.abs(z.u1 - off - u),
    );
    const d = Math.min(...dists);
    place = clamp01(1 - d / Math.max(0.5, shortSide / 2));
    if (place < 0.35) factors.push("mid-room");
    else if (place < 0.8) factors.push("off-wall");
  } else if (rule.mode === "centerFit") {
    const shift = shortSide * rule.prefShiftFrac;
    const pu = (z.u0 + z.u1) / 2;
    const pv = (z.v0 + z.v1) / 2 - shift;
    const d = Math.hypot(u - pu, v - pv);
    place = clamp01(1 - d / Math.max(0.5, shortSide));
    if (place < 0.5) factors.push("mid-room");
  } else if (rule.mode === "besideAnchor") {
    // Nearest piece of the anchor def's kind (the interactive analogue of
    // the driver's placedAt lookup).
    const anchorDef = HOUSE_STATIONS.find((d) => d.key === rule.anchor);
    const anchors = ctx.pieces.filter((p) => anchorDef && p.kind === anchorDef.kind);
    if (anchors.length) {
      const nearest = anchors.reduce((a, b) =>
        Math.hypot(a.x - cand.x, a.y - cand.y) <= Math.hypot(b.x - cand.x, b.y - cand.y) ? a : b,
      );
      const ideal = nearest.radius + cand.radius + rule.gapPad;
      const d = Math.abs(Math.hypot(nearest.x - cand.x, nearest.y - cand.y) - ideal);
      place = clamp01(1 - d / 2);
      if (place < 0.6) factors.push("far-from-anchor");
    } else {
      place = 0.5; // no anchor in the house — neutral
    }
  }

  // SERVICE — graded margin (feasibility already guaranteed a pass;
  // pass-through kinds neither pinch nor care).
  const svcM = PASS_THROUGH.has(cand.kind) ? 1 : serviceMargin(ctx, z, u, v, cand.radius);
  if (svcM < 0.75) factors.push("crowded");

  const score = cell * (0.5 + 0.5 * place) * (0.5 + 0.5 * svcM);
  // The worst offender, by component value.
  const byBadness: Array<[PlacementFactor, number]> = [];
  if (factors.includes("wrong-room")) byBadness.push(["wrong-room", cell]);
  if (factors.includes("mid-room")) byBadness.push(["mid-room", place]);
  if (factors.includes("off-wall")) byBadness.push(["off-wall", place]);
  if (factors.includes("far-from-anchor")) byBadness.push(["far-from-anchor", place]);
  if (factors.includes("crowded")) byBadness.push(["crowded", svcM]);
  byBadness.sort((a, b) => a[1] - b[1]);
  const gripe = byBadness[0]?.[0];
  return { score, factors, ...(gripe !== undefined ? { gripe } : {}) };
}

export interface PlacementQuery {
  kind: StationKind;
  radius: number;
  /** Search this room only (else the anchor's room, else the kind's own
   *  cell resolution). */
  roomId?: string;
  /** WORLD point to place near — a directed "here"/"near the table". */
  anchor?: { x: number; y: number };
  /** Preferred standing distance from the anchor (defaults to snug —
   *  the two radii + a hand's breadth). */
  anchorGap?: number;
}

export interface RatedSpot {
  x: number;
  y: number;
  facing: number;
  roomId: string;
  score: number;
  factors: PlacementFactor[];
  gripe?: PlacementFactor;
}

/** FEASIBLE spots for a piece, best-first — the creature's own search.
 *  Candidates come from the kind's own placement mode (wall flush lines,
 *  corners, center) plus rings around the anchor when one is given; every
 *  survivor is scored by placementScore. Empty ⇒ the room genuinely has
 *  no spot (ask placementFeasible at the anchor for the dominant reason). */
export function placementCandidates(
  ctx: PlacementContext,
  q: PlacementQuery,
  max = 8,
): RatedSpot[] {
  const def = stationDefFor(q.kind);
  const zone: Zone | undefined = q.roomId
    ? zoneById(ctx, q.roomId)
    : q.anchor
      ? zoneAt(ctx, q.anchor.x, q.anchor.y)
      : zoneForCell(ctx, def.cell);
  if (!zone) return [];
  const r = q.radius;
  const seen: Array<{ u: number; v: number }> = [];
  const out: RatedSpot[] = [];
  const consider = (u: number, v: number, facing?: number): void => {
    // Dedupe within half a body — wall scans and rings overlap.
    for (const s of seen) {
      if (Math.abs(s.u - u) < 0.4 && Math.abs(s.v - v) < 0.4) return;
    }
    seen.push({ u, v });
    const w = toWorld(ctx, u, v);
    const cand: PlacementCandidate = { x: w.x, y: w.y, radius: r, kind: q.kind };
    if (!placementFeasible(ctx, zone.room.id, cand).ok) return;
    const rated = placementScore(ctx, def, cand, zone.room.id);
    out.push({
      x: w.x,
      y: w.y,
      facing: facing ?? faceInto(ctx, zone, w.x, w.y),
      roomId: zone.room.id,
      score: rated.score,
      factors: rated.factors,
      ...(rated.gripe !== undefined ? { gripe: rated.gripe } : {}),
    });
  };

  // Rings around the anchor first (the directed spot is the point).
  if (q.anchor) {
    const a = toFrame(ctx, q.anchor.x, q.anchor.y);
    const snug = q.anchorGap ?? r + 0.35;
    for (const ring of [snug, snug + 0.4, snug + 0.9]) {
      for (let i = 0; i < 12; i++) {
        const t = (i / 12) * Math.PI * 2;
        const u = a.u + Math.cos(t) * ring;
        const v = a.v + Math.sin(t) * ring;
        consider(u, v, Math.atan2(q.anchor.y - toWorld(ctx, u, v).y, q.anchor.x - toWorld(ctx, u, v).x));
      }
    }
  }

  // The kind's own habitat: wall flush lines, corners, the center.
  const off = r + 0.1;
  for (let u = zone.u0 + r + 0.15; u <= zone.u1 - r - 0.15; u += STEP * 2) {
    consider(u, zone.v1 - off, frameDirAngle(ctx, 0, -1)); // far wall
    consider(u, zone.v0 + off, frameDirAngle(ctx, 0, 1)); // door wall
  }
  for (let v = zone.v0 + r + 0.15; v <= zone.v1 - r - 0.15; v += STEP * 2) {
    consider(zone.u0 + off, v, frameDirAngle(ctx, 1, 0)); // side0
    consider(zone.u1 - off, v, frameDirAngle(ctx, -1, 0)); // side1
  }
  for (const c of [
    { u: zone.u0 + off, v: zone.v1 - off },
    { u: zone.u1 - off, v: zone.v1 - off },
    { u: zone.u0 + off, v: zone.v0 + off },
    { u: zone.u1 - off, v: zone.v0 + off },
  ]) {
    consider(c.u, c.v);
  }
  consider((zone.u0 + zone.u1) / 2, (zone.v0 + zone.v1) / 2);

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, max);
}
