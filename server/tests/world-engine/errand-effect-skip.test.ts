// ⚖️ A PATH SHORTCUT MAY NOT DO WORK IN THE WORLD (2026-09-06 teleport round).
//
// `errandAim`'s SKIP-AHEAD RECOVERY exists for the AIM: a body that cut a corner
// can end up beside a later stretch of its own plan, and pursuing the vertex
// behind it thrashes. So it resumes at the later segment — and fires `onArrive`
// for every vertex it passed on the way.
//
// Those callbacks are not bookkeeping. In `issueTransferHaul` they take a basket
// into hands and LOAD goods off a source: `giveUnitsToBody` mints the prop at
// the SOURCE and the engine snaps a carried object to its carrier, so a skip
// across the load ran it from 23 m away and the goods teleported on the next
// tick. Measured on the frontier arc, seed 11, at BOTH dt 0.05 and dt 0.5 —
// nothing to do with the lag compensator.
//
// The rule this pins: a vertex is a WORLD EFFECT unless a planner says it isn't
// (`NpcErrandPoint.effect === false`, stamped by `doorRouteErrand` on inserted
// street/door/dogleg corners only). The recovery may drop the planner's corners;
// it may never drop the caller's own waypoint. Pure — one controller, no world.

import { describe, it, expect } from "@jest/globals";
import {
  createNpcController,
  type NpcControlCtx,
  type NpcErrandPoint,
} from "@shared/world-engine/npc-controller.js";
import type { AvatarState } from "@shared/world-engine/engine.js";

/** A body standing still at the origin — the only sim state this needs. */
function bodyAt(x: number, y: number): AvatarState {
  return {
    id: "npc",
    x, y, vx: 0, vy: 0, fx: 1, fy: 0, floor: 0,
    carrying: null, possessedBy: null,
  } as unknown as AvatarState;
}

function ctxFor(self: AvatarState, now: number): NpcControlCtx {
  return { self, humans: [], now, width: 400, height: 400, rng: () => 0.5 };
}

/**
 * THE SHAPE THAT BROKE IT — a road route with an out-and-back excursion. The
 * body stands at the origin; the plan walks 20 m north, 20 m east, back down,
 * and then straight WEST along a line 0.4 m from where the body is standing.
 * That return leg is inside `SKIP_NEAR` (0.8 m), so the recovery wants to
 * resume there and drop indices 0..2 — the real frontier polyline did exactly
 * this and dropped the basket vertex with them.
 */
const OUT_AND_BACK: Array<{ x: number; y: number }> = [
  { x: 0, y: 20 },     // 0 — the caller's own waypoint (the basket / the load)
  { x: 20, y: 20 },    // 1 — a corner
  { x: 20, y: 0.4 },   // 2 — a corner
  { x: -20, y: 0.4 },  // 3 — the return leg passes 0.4 m from the body
  { x: -20, y: -20 },  // 4 — the final stop
];

/** Run ONE controller frame and report which vertices fired, and from how far. */
function fireOnce(points: NpcErrandPoint[]): Array<{ i: number; d: number }> {
  const self = bodyAt(0, 0);
  const ctrl = createNpcController({ id: "npc", x: 0, y: 0, behavior: { movement: "stationary" } });
  const fired: Array<{ i: number; d: number }> = [];
  ctrl.setErrand({
    points,
    onArrive: (i) => {
      const p = points[i]!;
      fired.push({ i, d: Math.hypot(self.x - p.x, self.y - p.y) });
    },
  });
  ctrl.computeAim(ctxFor(self, 0));
  return fired;
}

describe("errand skip-ahead — a shortcut may not fire a world effect", () => {
  it("🚨 never fires the caller's own waypoint from across the block", () => {
    // Unmarked points are EFFECTS by default (an unrouted errand marks nothing),
    // so the recovery must stop dead at index 0 and let the body walk the leg.
    const fired = fireOnce(OUT_AND_BACK.map((p) => ({ ...p })));
    expect(fired).toEqual([]);
  });

  it("still drops the PLANNER's corners — the recovery keeps its job", () => {
    // doorRouteErrand's own tagging: inserted corners carry `effect: false`, the
    // caller's endpoint carries nothing. Here 1 and 2 are route geometry and 3
    // is the next real waypoint, so the skip may pass 1 and 2 and no further.
    const points: NpcErrandPoint[] = [
      { ...OUT_AND_BACK[0]! },                   // an effect: unskippable
      { ...OUT_AND_BACK[1]!, effect: false },
      { ...OUT_AND_BACK[2]!, effect: false },
      { ...OUT_AND_BACK[3]! },                   // the next effect: the limit
      { ...OUT_AND_BACK[4]! },
    ];
    // Index 0 is still an effect, so nothing may pass at all…
    expect(fireOnce(points)).toEqual([]);

    // …but with index 0 marked as route geometry too, the whole excursion is
    // droppable and the recovery resumes at the first real waypoint (3).
    const allCorners: NpcErrandPoint[] = points.map((p, i) =>
      i < 3 ? { ...p, effect: false } : { ...p },
    );
    expect(fireOnce(allCorners).map((f) => f.i)).toEqual([0, 1, 2]);
  });

  it("an errand with NO callbacks is untouched — this is an effects rule, not a motion one", () => {
    const self = bodyAt(0, 0);
    const ctrl = createNpcController({ id: "npc", x: 0, y: 0, behavior: { movement: "stationary" } });
    ctrl.setErrand({ points: OUT_AND_BACK.map((p) => ({ ...p })) });
    ctrl.computeAim(ctxFor(self, 0));
    // Nothing can be fired, so nothing is at risk: the aim recovery runs as it
    // always did and resumes on the leg the body is standing beside.
    expect(ctrl.errandPath()?.index).toBe(3);
  });
});
