// shared/world-engine/interaction/quest/stand-points.ts
//
// STAND-POINT PLANNING — where a body stands to USE a thing. Pure functions
// over WorldState, extracted from quest-host (which needs WebGL and can't be
// imported by tests) so the rules that put waypoints on the map are pinnable:
// the observed "deposit spot behind the house" bug lived exactly here, and a
// wrong answer from these functions sends a body out the front door and
// grinding against the back wall forever (DEBUG-CREATURE-BEHAVIOR §5).

import {
  buildingAt,
  fixturesWalkable,
  structuresWalkable,
  type WorldState,
} from "../../engine.js";
import { PASSTHROUGH_FIXTURES } from "../../types.js";
import { DEFAULT_BODY_RADIUS_M } from "../../creatures/species.js";

/** THE TANGENCY RULE: the furnishing fit rule (kernel placement.ts) packs
 *  stations so their standing spots sit at EXACT wall/fixture clearance — a
 *  privy 1.0 m from the partition puts its stand cardinal at float-0.599…
 *  from the wall. A planner probing at the full body radius reads every such
 *  generator-legal spot as blocked, exhausts its candidates, and falls back
 *  to an unreachable point — the body then grinds at a wall while the detour
 *  force-flips shoulders every frame (the observed "detour flipping" in the
 *  dollhouse). So PLANNING probes at slightly UNDER the body radius:
 *  locomotion still enforces the true 0.4, and the errand arrival tolerances
 *  (0.9–1.3) absorb the boundary. */
const PLAN_SLACK = 0.06;

/** Can a body STAND at `p` — clear of walls AND solid fixtures? Delegates the
 *  fixture half to the engine's OWN `fixturesWalkable` (the composed movement
 *  constraint) rather than restating its box test — the two can never drift.
 *  `radius` is the planning girth (default = the engine's avatarRadius 0.4,
 *  probed with PLAN_SLACK — see THE TANGENCY RULE above); a caller planning
 *  for a bigger body passes its own. */
export function standClear(state: WorldState, p: { x: number; y: number }, radius = DEFAULT_BODY_RADIUS_M): boolean {
  const r = Math.max(0.1, radius - PLAN_SLACK);
  return structuresWalkable(state, p, r) && fixturesWalkable(state, p, r);
}

/** The SOLID fixture whose no-stand box covers `p` (an item resting on a table
 *  reports the tabletop's centre; a place ref can resolve to a fixture centre) —
 *  or null if `p` is in the open. Solid fixtures block a Chebyshev box of
 *  half-extent `radius + avatarRadius`, the same girth the engine's
 *  `fixturesWalkable` enforces; pass-through kinds (chairs, bowls) never block. */
export function fixtureCovering(
  state: WorldState,
  p: { x: number; y: number },
  bodyR = DEFAULT_BODY_RADIUS_M,
): { id: string; x: number; y: number; radius: number } | null {
  for (const spec of state.spec.objects) {
    if (!spec.fixture || PASSTHROUGH_FIXTURES.has(spec.fixture)) continue;
    const o = state.objects[spec.id];
    if (!o) continue;
    if (Math.abs(p.x - o.x) <= spec.radius + bodyR && Math.abs(p.y - o.y) <= spec.radius + bodyR) {
      return { id: spec.id, x: o.x, y: o.y, radius: spec.radius };
    }
  }
  return null;
}

/** The candidate directions for a stand spot: toward `from` first (usually
 *  the open room), then the cardinals. */
export function standDirs(
  raw: { x: number; y: number },
  from: { x: number; y: number },
): { x: number; y: number }[] {
  const toBody = Math.hypot(from.x - raw.x, from.y - raw.y);
  const dirs: { x: number; y: number }[] = [];
  if (toBody > 1e-3) dirs.push({ x: (from.x - raw.x) / toBody, y: (from.y - raw.y) / toBody });
  dirs.push({ x: 0, y: 1 }, { x: 0, y: -1 }, { x: 1, y: 0 }, { x: -1, y: 0 });
  return dirs;
}

/** Is `p` on the SAME side of the walls as `anchor` — the same room, or both
 *  outdoors? `standClear` is a purely LOCAL test: a probe pushed past a
 *  fixture that hugs a wall can land on open ground on the WRONG side (behind
 *  the house — observed: deposit stand points behind the rear wall, walked
 *  out the front door and ground against the back wall forever). Every stand
 *  candidate must ALSO share the fixture's room. */
export function sameRoomAs(
  state: WorldState,
  anchor: { x: number; y: number },
  p: { x: number; y: number },
): boolean {
  return (buildingAt(state, anchor.x, anchor.y)?.id ?? null) === (buildingAt(state, p.x, p.y)?.id ?? null);
}

/** Where a body STANDS to use `objId`. Solid fixtures (beds, tables, chests
 *  — engine makeFixtureConstraint) block within radius + avatarRadius of
 *  their center, so the CENTER is unreachable: a bed (r 0.9) can never be
 *  approached closer than 1.3 — the "walks to the bed and stands forever"
 *  deadlock (the needs arrival check is ≤ 1.3). Target the first WALKABLE
 *  spot just off the fixture's edge instead: toward the approaching body
 *  first (usually the open room), then the other cardinals (a bed's
 *  headboard wall rules one side out). Non-fixtures pass through unchanged. */
export function standPointFor(
  state: WorldState,
  objId: string,
  raw: { x: number; y: number },
  from: { x: number; y: number },
  /** The MOVER's body radius — a bigger creature stands further off the
   *  fixture's edge and needs a wider clear spot. */
  bodyR = DEFAULT_BODY_RADIUS_M,
): { x: number; y: number } {
  let spec = state.spec.objects.find((s) => s.id === objId);
  let center = raw;
  // AN ITEM SITTING ON/IN A SOLID FIXTURE (a banana ON a table, a bowl of soup
  // on a counter) reports the FIXTURE'S CENTRE as its position — the table
  // blocks a body there exactly as if it were the table itself, so walking to
  // the item's own coordinate grinds into the tabletop ("stuck reaching the
  // consume point, into the table's centre"). The item is a pass-through prop,
  // so its own spec never nudges; resolve the stand-off from the CONTAINING
  // fixture instead. A loose item / a pass-through station keeps `raw`.
  if (!spec?.fixture || PASSTHROUGH_FIXTURES.has(spec.fixture)) {
    const containerId = state.objects[objId]?.containedIn?.objectId;
    const cspec = containerId ? state.spec.objects.find((s) => s.id === containerId) : undefined;
    if (cspec?.fixture && !PASSTHROUGH_FIXTURES.has(cspec.fixture)) {
      const cObj = state.objects[containerId!];
      spec = cspec;
      if (cObj) center = { x: cObj.x, y: cObj.y }; // nudge off the FIXTURE's edge, not the item
    } else {
      return raw;
    }
  }
  const stand = spec.radius + bodyR + 0.22; // the body + a comfortable gap
  const dirs = standDirs(center, from);
  const ok = (p: { x: number; y: number }) => standClear(state, p, bodyR) && sameRoomAs(state, center, p);
  for (const d of dirs) {
    const p = { x: center.x + d.x * stand, y: center.y + d.y * stand };
    if (ok(p)) return p;
  }
  // The cardinals failed (a corner-wedged fixture): sweep the DIAGONALS, then
  // a wider ring, before conceding — the old unchecked `dirs[0]` fallback
  // could hand back a point INSIDE another fixture's Chebyshev box (the §5
  // landmine: a "safe" radial stand-off is inside the box on the diagonals).
  // Every candidate is same-room-gated: a wider probe past a wall-hugging
  // fixture lands OUTSIDE the room — clear ground, wrong side of the wall.
  const D = Math.SQRT1_2;
  const diags = [
    { x: D, y: D },
    { x: D, y: -D },
    { x: -D, y: D },
    { x: -D, y: -D },
  ];
  for (const ring of [stand, stand + 0.6]) {
    for (const d of [...diags, ...dirs]) {
      const p = { x: center.x + d.x * ring, y: center.y + d.y * ring };
      if (ok(p)) return p;
    }
  }
  return { x: center.x + dirs[0]!.x * stand, y: center.y + dirs[0]!.y * stand }; // best effort — the leg's stall watch copes
}

/** A clear spot at-or-near `raw`: itself when standable, else nudged outward
 *  along the from-direction + cardinals (for planned points that may land
 *  inside furniture — a homecoming spot, a room anchor). Nudged candidates
 *  are same-room-gated like stand points: a nudge past a wall lands on clear
 *  ground on the WRONG side. */
export function nearestClearSpot(
  state: WorldState,
  raw: { x: number; y: number },
  from: { x: number; y: number },
  bodyR = DEFAULT_BODY_RADIUS_M,
): { x: number; y: number } {
  if (standClear(state, raw, bodyR)) return raw;
  // INSIDE A SOLID FIXTURE (an item on a table, a place ref at a fixture's
  // centre): nudge off THAT fixture's edge via standPointFor — radius-aware,
  // diagonals + a wider ring. The fixed-step sweep below is girth-blind (max
  // 1.6, no diagonals): for a big or crowded fixture it can't reach clear
  // ground and falls back to the blocked centre (the "grinds into the table's
  // centre reaching the consume point" bug). standPointFor handles the fixture.
  const fx = fixtureCovering(state, raw, bodyR);
  if (fx) {
    const sp = standPointFor(state, fx.id, { x: fx.x, y: fx.y }, from, bodyR);
    if (standClear(state, sp, bodyR)) return sp;
  }
  // An oversized body sweeps proportionally further (identical at the default).
  const grow = 2 * Math.max(0, bodyR - DEFAULT_BODY_RADIUS_M);
  for (const step of [0.9 + grow, 1.6 + grow]) {
    for (const d of standDirs(raw, from)) {
      const p = { x: raw.x + d.x * step, y: raw.y + d.y * step };
      if (standClear(state, p, bodyR) && sameRoomAs(state, raw, p)) return p;
    }
  }
  return raw; // best effort — the errand leg deadline copes
}
