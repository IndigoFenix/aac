// ⚖️ A FORCE-PASS MAY NOT DO WORK IN THE WORLD (2026-09-06 carry-integrity round).
//
// `errandAim`'s stall watchdog is the never-wedge-forever backstop: after
// `STALL_S` (5 sim s) with no arc gain it PASSES the vertex the body could not
// reach. Its comment claimed a STOP force-pass was safe because *"the host's own
// in-place action is separately view-gated"* — it is not. `issueTransferHaul`'s
// UNLOAD has no distance test anywhere (`takeUnitsFromBody` never looks at
// distance; `reachAt` only aims the gesture), so a force-passed final vertex
// delivered a haul from wherever the body happened to be standing. That is the
// mechanism behind the user's *"blocks placed in houses from a distance"*, and
// under the lag compensator the 5 SIM seconds trip ~10× sooner in real time.
//
// The rule this pins: a pass that is not an ARRIVAL fires `onAbandon`, not
// `onArrive`, and the errand ENDS (no `onDone` — an abandoned errand did not
// finish). It is opt-in by callback: an errand that declares no `onAbandon`
// behaves exactly as it always did, so this is a contract with a caller that
// knows how to abandon and not a blanket rule imposed on every effect.
//
// Pure — one controller, no world, no session. `npm run test:engine -- carry-abandon`

import { describe, it, expect } from "@jest/globals";
import {
  createNpcController,
  type NpcControlCtx,
  type NpcErrandPoint,
} from "@shared/world-engine/npc-controller.js";
import type { AvatarState } from "@shared/world-engine/engine.js";

/** The controller's own STALL_S — a local mirror, so the pin says out loud
 *  which number it is standing on rather than importing a private one. */
const STALL_S = 5;

function bodyAt(x: number, y: number): AvatarState {
  return {
    id: "npc",
    x, y, vx: 0, vy: 0, fx: 1, fy: 0, floor: 0,
    carrying: null, possessedBy: null,
  } as unknown as AvatarState;
}

/** No humans in sight: the FLOW force-pass is view-gated (`stalled && !watched`)
 *  and the STOP one is not, so an empty gallery exercises both arms. */
function ctxFor(self: AvatarState, now: number): NpcControlCtx {
  return { self, humans: [], now, width: 400, height: 400, rng: () => 0.5 };
}

interface Run {
  arrived: number[];
  abandoned: number[];
  done: number;
  /** Is an errand still running after the stall? */
  active: boolean;
}

/**
 * Stand a body 30 m short of its destination and let the watchdog time out.
 * The body never moves, so no arc is gained and nothing is ever REACHED —
 * exactly the shape a wedged carrier is in when the watchdog fires.
 */
function stallOut(points: NpcErrandPoint[], opts: { abandonable: boolean }): Run {
  const self = bodyAt(0, 0);
  const ctrl = createNpcController({ id: "npc", x: 0, y: 0, behavior: { movement: "stationary" } });
  const run: Run = { arrived: [], abandoned: [], done: 0, active: true };
  ctrl.setErrand({
    points,
    onArrive: (i) => run.arrived.push(i),
    onDone: () => { run.done++; },
    ...(opts.abandonable ? { onAbandon: (i: number) => { run.abandoned.push(i); } } : {}),
  });
  // t = 0 seeds the stall clock; t = STALL_S + 1 is past it.
  ctrl.computeAim(ctxFor(self, 0));
  ctrl.computeAim(ctxFor(self, STALL_S + 1));
  run.active = ctrl.hasErrand();
  return run;
}

/** The two-vertex shape of a haul with no bag: LOAD then UNLOAD, both the
 *  caller's own waypoints (unmarked ⇒ effects), the last one a STOP. */
const HAUL: NpcErrandPoint[] = [
  { x: 0, y: 30 },   // 0 — the load
  { x: 0, y: 60 },   // 1 — the unload (the final vertex is always a stop)
];

describe("errand force-pass — an abandoned haul never lands", () => {
  it("🚨 a stalled EFFECT vertex fires onAbandon, never onArrive", () => {
    const r = stallOut(HAUL.map((p) => ({ ...p })), { abandonable: true });
    expect(r.abandoned).toEqual([0]);
    expect(r.arrived).toEqual([]);
    // …and the errand is over: no `onDone` (that would report a finished trip)
    // and nothing left running, so the caller's failure is the whole story.
    expect(r.done).toBe(0);
    expect(r.active).toBe(false);
  });

  it("the FINAL vertex — the unload itself — is force-passed as an abandon too", () => {
    // Start the body ON the load so vertex 0 is genuinely reached, then let it
    // stall short of the destination. This is the arm the diagnosis measured
    // three times at dt 0.5 (`isStop(i) ? d <= arrive || stalled`).
    const self = bodyAt(0, 30);
    const ctrl = createNpcController({ id: "npc", x: 0, y: 30, behavior: { movement: "stationary" } });
    const arrived: number[] = [];
    const abandoned: number[] = [];
    let done = 0;
    ctrl.setErrand({
      points: HAUL.map((p) => ({ ...p })),
      onArrive: (i) => arrived.push(i),
      onDone: () => { done++; },
      onAbandon: (i) => abandoned.push(i),
    });
    ctrl.computeAim(ctxFor(self, 0));
    expect(arrived).toEqual([0]); // the load: really reached, really fires
    ctrl.computeAim(ctxFor(self, STALL_S + 1));
    expect(abandoned).toEqual([1]); // the unload: never reached, never fires
    expect(arrived).toEqual([0]);
    expect(done).toBe(0);
    expect(ctrl.hasErrand()).toBe(false);
  });

  it("an errand with NO onAbandon still force-passes — the wedge backstop is untouched", () => {
    const r = stallOut(HAUL.map((p) => ({ ...p })), { abandonable: false });
    expect(r.abandoned).toEqual([]);
    // The old behaviour, exactly: the watchdog passes the vertex and its
    // callback fires. Every errand in the host that has not opted in keeps it.
    expect(r.arrived).toEqual([0]);
  });

  it("a ROUTING CORNER is not a world effect — it force-passes as it always did", () => {
    // `doorRouteErrand` stamps `effect: false` on the street/door/dogleg points
    // it inserted. Dropping one of those is the whole point of the watchdog, so
    // the abandon must not steal it: the body passes the corner and walks on.
    const points: NpcErrandPoint[] = [
      { ...HAUL[0]!, effect: false, arrive: 0.9 },
      { ...HAUL[1]! },
    ];
    const r = stallOut(points, { abandonable: true });
    expect(r.abandoned).toEqual([]);
    expect(r.arrived).toEqual([0]);
    expect(r.active).toBe(true); // still walking toward the real waypoint
  });

  it("a REACHED stop is an arrival, not an abandon — nothing changes for a haul that lands", () => {
    const self = bodyAt(0, 60);
    const ctrl = createNpcController({ id: "npc", x: 0, y: 60, behavior: { movement: "stationary" } });
    const arrived: number[] = [];
    const abandoned: number[] = [];
    let done = 0;
    ctrl.setErrand({
      points: [{ x: 0, y: 60 }],
      onArrive: (i) => arrived.push(i),
      onDone: () => { done++; },
      onAbandon: (i) => abandoned.push(i),
    });
    ctrl.computeAim(ctxFor(self, 0));
    expect(arrived).toEqual([0]);
    expect(abandoned).toEqual([]);
    expect(done).toBe(1);
  });

  it("the stall clock is SIM seconds, so a wide frame does not abandon early", () => {
    // One frame of dt 0.5 is not five seconds. The watchdog reads `ctx.now`,
    // which is sim time — the lag compensator changes how fast that runs in
    // real time and nothing else. (The diagnosis: the compensator made this arm
    // REACHABLE at its intended rate; it did not create it.)
    const self = bodyAt(0, 0);
    const ctrl = createNpcController({ id: "npc", x: 0, y: 0, behavior: { movement: "stationary" } });
    const abandoned: number[] = [];
    ctrl.setErrand({
      points: HAUL.map((p) => ({ ...p })),
      onArrive: () => {},
      onAbandon: (i) => abandoned.push(i),
    });
    for (let f = 0; f <= 9; f++) ctrl.computeAim(ctxFor(self, f * 0.5)); // 4.5 sim s
    expect(abandoned).toEqual([]);
    ctrl.computeAim(ctxFor(self, 5.5));
    expect(abandoned).toEqual([0]);
  });
});
