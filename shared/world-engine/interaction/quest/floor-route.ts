// shared/world-engine/interaction/quest/floor-route.ts
//
// INDOOR MICRO-ROUTING — a straight errand leg inside one room can be blocked
// by furniture in a way no local detour can solve: a table parked mid-room
// leaves a U-trap where the bypass needs a DOGLEG (west along the wall, then
// north past the table), and `detourAim` bends a straight line exactly once.
// The doc's law is "slides on walls, never re-paths" — this is the re-path,
// done ONCE at errand-issue time (never per frame): a coarse grid BFS over
// the room's walkable cells, string-pulled back to a few straight runs.
//
// Pure over WorldState; costs ~a few hundred cell probes per blocked leg.

import {
  buildingAt,
  fixturesWalkable,
  routeThroughDoors,
  structuresWalkable,
  type WorldState,
} from "../../engine.js";
import { standClear } from "./stand-points.js";
import { DEFAULT_BODY_RADIUS_M } from "../../creatures/species.js";

interface Vec2 {
  x: number;
  y: number;
}

/** A routed waypoint: a tight `arrive` marks a FLOW vertex the pure-pursuit
 *  follower passes by projection (npc-controller); the leg's own target
 *  carries none and is reached by distance. */
export interface RoutedPoint extends Vec2 {
  arrive?: number;
}

/** The design-default body radius — the fallback when a caller doesn't pass
 *  the mover's own girth. A house is FURNISHED to keep its CONSTRUCTING
 *  species navigable (kernel/town/placement.ts service flood at the species'
 *  radius), so the router plans at the mover's radius to see the lanes the
 *  generator kept — pass the real mover's girth wherever it's known
 *  (worldHost.npcRadiusOf). */
const DEFAULT_BODY_R = DEFAULT_BODY_RADIUS_M;

/** The router's grid + clearance, SCALED TO THE MOVER — the one contract that
 *  keeps routing honest against house generation.
 *
 *  The house generator certifies room navigability by flooding walkable cells
 *  at the design body radius on a 0.3 m grid (placement.ts SVC_BODY / SVC_STEP)
 *  and rejecting furniture that pinches a lane shut. The router must therefore
 *  plan at the SAME clearance and a grid at LEAST as fine — plan FATTER than the
 *  house was built for and a legal lane reads as a wall. That was the "walks
 *  into the table and sticks" bug: a 0.37 m table↔fridge gap the generator kept
 *  open fell between the old 0.45 m cells AND under the old 0.42 m probe, so the
 *  BFS found no path, kept the straight leg through the table, and — the leg
 *  being a tight door transit — the reactive detour was suppressed too.
 *
 *  • `cell` ≤ the generator's 0.3 m flood step (with margin for grid-origin
 *    skew) so any lane the generator certified has a cell centre the BFS can
 *    stand on. Scales DOWN with the mover: a smaller species threads finer.
 *  • `plan` = the mover's collision radius EXACTLY (= the generator's SVC_BODY
 *    for the design species) — every lane the house was certified to keep, no
 *    fatter. The follower's arrival radius absorbs the lost margin.
 *  • `smooth` = the string-pull carrot margin. Where a body-wide lane won't
 *    carry the fat corridor the pull falls back to the raw grid cells (short
 *    hops), so the dogleg still stands. */
function planGeom(bodyR: number): { cell: number; plan: number; smooth: number } {
  return { cell: Math.min(0.25, bodyR * 0.62), plan: bodyR, smooth: bodyR + 0.2 };
}

/** The idle-pad grid step — pacing wants a comfy rectangle, not the leg
 *  planner's fine navigability grid, so it keeps its own coarse cell. */
const IDLE_CELL = 0.45;

/** March a straight corridor at a step fine enough that no thin wall OR shallow
 *  fixture-CORNER clip can slip between samples. 0.3 m (a wall's thickness) was
 *  too coarse for corners: a leg that just grazes a table's corner penetrates
 *  for a chord far shorter than 0.3 m, so the samples straddled it, the straight
 *  read "clear", no dogleg was planned, and the body clipped the corner (and, on
 *  a tight door-transit leg, had no reactive detour to save it). 0.1 m catches
 *  the corner while staying cheap over a small room's cells. */
const CORRIDOR_STEP = 0.1;
function corridorClear(state: WorldState, a: Vec2, b: Vec2, ok: (p: Vec2) => boolean): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(len / CORRIDOR_STEP));
  for (let k = 1; k <= steps; k++) {
    if (!ok({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps })) return false;
  }
  return true;
}

/** Fit a door-transit PAIR (near/far, straddling one doorway) onto STANDABLE
 *  ground. routeThroughDoors is furniture-blind: its raw ±1.1 transit can
 *  land inside a table's no-stand box beside the door, where no arrival
 *  radius can be met. Try the raw span first, then pull the pair in toward
 *  the door, then slide it a hair along the gap — the pair moves TOGETHER,
 *  so the crossing stays perpendicular through the doorway. Null = nothing
 *  standable (caller keeps the raw pair with a loose arrival; the follower's
 *  leg deadline copes). */
export function adjustTransitPair(
  state: WorldState,
  a: Vec2,
  b: Vec2,
  bodyR: number = DEFAULT_BODY_R,
): [Vec2, Vec2] | null {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2; // the door's center
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len; // crossing direction (near → far)
  const uy = (b.y - a.y) / len;
  for (const d of [len / 2, 0.85, 0.65]) {
    for (const off of [0, 0.25, -0.25]) {
      const ox = -uy * off;
      const oy = ux * off;
      const a2 = { x: mx - ux * d + ox, y: my - uy * d + oy };
      const b2 = { x: mx + ux * d + ox, y: my + uy * d + oy };
      if (standClear(state, a2, bodyR) && standClear(state, b2, bodyR)) return [a2, b2];
    }
  }
  return null;
}

/**
 * THE INDOOR LEG PLANNER — one leg `from → to`, door-threaded
 * (routeThroughDoors), its transit pairs fitted onto standable ground and
 * marked pass-through (tight arrive), and every same-room straight that
 * furniture blocks refined into dogleg corners. Returns every waypoint
 * INCLUDING `to` itself (which never carries an arrive override — the
 * caller owns endpoint semantics like dwell). This is the ONE assembly both
 * quest-host's doorRouteErrand and the headless tests run.
 */
export function routeIndoorAware(
  state: WorldState,
  from: Vec2,
  to: Vec2,
  bodyR: number = DEFAULT_BODY_R,
): RoutedPoint[] {
  const legs: RoutedPoint[] = routeThroughDoors(state, from, to).map((p) => ({ x: p.x, y: p.y }));
  for (let i = 0; i + 1 < legs.length; i += 2) {
    const fixed = adjustTransitPair(state, legs[i]!, legs[i + 1]!, bodyR);
    if (fixed) {
      legs[i] = { ...fixed[0], arrive: 0.4 };
      legs[i + 1] = { ...fixed[1], arrive: 0.4 };
    } else {
      legs[i]!.arrive = 0.9;
      legs[i + 1]!.arrive = 0.9;
    }
  }
  const out: RoutedPoint[] = [];
  let cursor: Vec2 = from;
  for (const p of legs) {
    for (const c of refineIndoorLeg(state, cursor, p, bodyR) ?? []) out.push({ x: c.x, y: c.y, arrive: 0.5 });
    out.push(p);
    cursor = p;
  }
  return out;
}

/**
 * THE IDLE PAD — the largest clear axis-aligned rectangle of a room's
 * walkable floor (largest-rectangle-in-a-binary-matrix over the same grid
 * the leg planner walks). Idle bodies pace ONLY inside their pad (every
 * straight line within it is walkable by construction) and are PATHED to it
 * — free roaming through a furnished interior has no router and reads as
 * lost. Probed a hair FAT (0.5) so pacing keeps margin from edge fixtures.
 * Null when the room has no clear patch worth pacing — a long strip is fine
 * (living rooms often keep a clear LANE, not a square): the bar is a
 * body-wide minimum side and a couple of strides of area.
 */
export function idlePadOf(
  state: WorldState,
  room: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } | null {
  const PAD_R = 0.5;
  const ok = (p: Vec2) => structuresWalkable(state, p, PAD_R) && fixturesWalkable(state, p, PAD_R);
  const nx = Math.max(1, Math.round(room.w / IDLE_CELL));
  const ny = Math.max(1, Math.round(room.h / IDLE_CELL));
  const px = (i: number) => room.x + ((i + 0.5) * room.w) / nx;
  const py = (j: number) => room.y + ((j + 0.5) * room.h) / ny;
  const walk = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      walk[j * nx + i] = ok({ x: px(i), y: py(j) }) ? 1 : 0;
    }
  }
  // Largest rectangle of 1s (histogram-stack per row).
  const heights = new Int32Array(nx);
  let best = 0;
  let bestRect: { i0: number; j0: number; i1: number; j1: number } | null = null;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) heights[i] = walk[j * nx + i] ? heights[i]! + 1 : 0;
    const stack: number[] = [];
    for (let i = 0; i <= nx; i++) {
      const h = i < nx ? heights[i]! : 0;
      let left = i;
      while (stack.length && heights[stack[stack.length - 1]!]! >= h) {
        const top = stack.pop()!;
        const hh = heights[top]!;
        left = stack.length ? stack[stack.length - 1]! + 1 : 0;
        const area = hh * (i - left);
        if (area > best) {
          best = area;
          bestRect = { i0: left, j0: j - hh + 1, i1: i - 1, j1: j };
        }
      }
      stack.push(i);
    }
  }
  if (!bestRect) return null;
  const rect = {
    x: room.x + (bestRect.i0 * room.w) / nx,
    y: room.y + (bestRect.j0 * room.h) / ny,
    w: ((bestRect.i1 - bestRect.i0 + 1) * room.w) / nx,
    h: ((bestRect.j1 - bestRect.j0 + 1) * room.h) / ny,
  };
  return Math.min(rect.w, rect.h) >= 0.9 && rect.w * rect.h >= 2.5 ? rect : null;
}

/**
 * Waypoints that walk `a → b` around the furniture of the ROOM both points
 * share. Returns null when no refinement applies (different rooms, outdoors,
 * the straight already clear, no grid path) — the caller keeps the straight
 * leg and the controller's deadline copes as before. On success returns the
 * intermediate corners (possibly empty = straight after all), NOT including
 * `b` itself.
 */
export function refineIndoorLeg(
  state: WorldState,
  a: Vec2,
  b: Vec2,
  bodyR: number = DEFAULT_BODY_R,
): Vec2[] | null {
  const { cell: CELL, plan: PLAN_R, smooth: SMOOTH_R } = planGeom(bodyR);
  const ok = (p: Vec2) => structuresWalkable(state, p, PLAN_R) && fixturesWalkable(state, p, PLAN_R);
  if (corridorClear(state, a, b, ok)) return null; // the straight is fine
  // GRID BOUNDS. A shared room gives tight, clean bounds (its footprint). But a
  // large obstacle DIRECTLY in the way outdoors (a market stall, a big rock, a
  // bed in a roofless yard) blocks a straight leg no local detour can round —
  // and `detourAim` bends a line ONCE, so it grinds. Grid the padded bounding
  // box of the leg instead, so the SAME BFS routes around any solid, indoors or
  // out. Capped so an open-field long leg never grids the whole world (it falls
  // back to the straight + reactive detour, as before).
  const room = buildingAt(state, a.x, a.y);
  let bounds: { x: number; y: number; w: number; h: number };
  if (room && buildingAt(state, b.x, b.y)?.id === room.id) {
    bounds = room.footprint;
  } else {
    const PAD = 6; // swing WIDE — room to round an obstacle that overhangs the direct box
    const minx = Math.min(a.x, b.x) - PAD;
    const miny = Math.min(a.y, b.y) - PAD;
    const bw = Math.abs(b.x - a.x) + 2 * PAD;
    const bh = Math.abs(b.y - a.y) + 2 * PAD;
    if (bw * bh > 42 * 42) return null; // too large to grid — keep the straight + detour
    bounds = { x: minx, y: miny, w: bw, h: bh };
  }
  const { x, y, w, h } = bounds;
  const nx = Math.max(1, Math.round(w / CELL));
  const ny = Math.max(1, Math.round(h / CELL));
  const px = (i: number) => x + ((i + 0.5) * w) / nx;
  const py = (j: number) => y + ((j + 0.5) * h) / ny;
  const idx = (i: number, j: number) => j * nx + i;
  const walk = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      walk[idx(i, j)] = ok({ x: px(i), y: py(j) }) ? 1 : 0;
    }
  }
  // Nearest WALKABLE cell to a point (the endpoints themselves often sit at
  // tangency or inside a fixture's stand box — the arrival radius covers the
  // final approach).
  const cellNear = (p: Vec2): number => {
    const ci = Math.min(nx - 1, Math.max(0, Math.floor(((p.x - x) / w) * nx)));
    const cj = Math.min(ny - 1, Math.max(0, Math.floor(((p.y - y) / h) * ny)));
    if (walk[idx(ci, cj)]) return idx(ci, cj);
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!walk[idx(i, j)]) continue;
        const d = Math.hypot(px(i) - p.x, py(j) - p.y);
        if (d < bestD) {
          bestD = d;
          best = idx(i, j);
        }
      }
    }
    return best;
  };
  const start = cellNear(a);
  const goal = cellNear(b);
  if (start < 0 || goal < 0) return null;
  // BFS, 8-connected; diagonals require both orthogonal neighbors clear so a
  // path never cuts a fixture corner tighter than the body can.
  const prev = new Int32Array(nx * ny).fill(-1);
  prev[start] = start;
  const queue = [start];
  let found = start === goal;
  while (queue.length && !found) {
    const cur = queue.shift()!;
    const ci = cur % nx;
    const cj = (cur - ci) / nx;
    for (let dj = -1; dj <= 1 && !found; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const i2 = ci + di;
        const j2 = cj + dj;
        if (i2 < 0 || i2 >= nx || j2 < 0 || j2 >= ny) continue;
        const n = idx(i2, j2);
        if (prev[n] !== -1 || !walk[n]) continue;
        if (di && dj && (!walk[idx(ci + di, cj)] || !walk[idx(ci, cj + dj)])) continue;
        prev[n] = cur;
        if (n === goal) {
          found = true;
          break;
        }
        queue.push(n);
      }
    }
  }
  if (!found) return null;
  const cells: Vec2[] = [];
  for (let n = goal; n !== start; n = prev[n]!) cells.push({ x: px(n % nx), y: py(Math.floor(n / nx)) });
  cells.reverse();
  // STRING-PULL: from `a`, greedily jump to the farthest cell a clear straight
  // reaches; emit it as a corner; repeat toward `b`. Ends when `b` itself is
  // reachable straight. Smoothing marches at SMOOTH_R (corner-cut margin for
  // the carrot follower); where the fat corridor doesn't fit, the raw cells
  // stand — arrival/exit still checked at the walkable PLAN_R.
  const smoothOk = (p: Vec2) => structuresWalkable(state, p, SMOOTH_R) && fixturesWalkable(state, p, SMOOTH_R);
  const corners: Vec2[] = [];
  let from = a;
  let at = 0;
  for (let guard = 0; guard < 96 && !corridorClear(state, from, b, ok); guard++) {
    let jump = -1;
    for (let k = cells.length - 1; k > at; k--) {
      if (corridorClear(state, from, cells[k]!, smoothOk)) {
        jump = k;
        break;
      }
    }
    if (jump < 0) {
      // No fat straight — keep the next raw cell (tight-lane hop), as long
      // as it is at least PLAN_R-reachable; a pinched start also lands here.
      jump = at;
      if (jump >= cells.length) break;
    }
    corners.push(cells[jump]!);
    from = cells[jump]!;
    at = jump + 1;
    if (at > cells.length) break;
  }
  return corners;
}
