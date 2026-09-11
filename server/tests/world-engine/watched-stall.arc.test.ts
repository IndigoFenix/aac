/**
 * ⏱️ THE WATCHED BODY STILL HAS TO RESOLVE (2026-09-07 watched-body-stall round).
 *
 * 🚨 THE DEFECT, as the user saw it: *"people carrying logs forever"*. The
 * mechanism was found by the carry-residuals lane while building its rock-ring
 * harness, and it is the exact inverse of the obvious bug — the controller's own
 * recovery, the FLOW force-pass, is VIEW-GATED on purpose (skipping a routing
 * corner jumps the aim to the next waypoint, whose straight may cross furniture:
 * an impossible move to anyone looking — CLOCK OWNS MOTION, DISRUPTION
 * DISRUPTS). So the ONE case the player actually watches is the one that never
 * recovered. Measured: a loaded porter wedged IN SIGHT sat motionless for 110 s
 * with its agreement still `moving` and never abandoned its haul; out of sight
 * the same body was force-passed and abandoned within ~20 s.
 *
 * ⚖️ THE RULING this pins: a watched wedge resolves visibly and honestly WITHOUT
 * the force-pass — an honest re-route from the live position first (rung one,
 * quest-host `stepErrandStall` → `doorRouteErrand`, so `standableVia`, doorways
 * and doglegs all apply), and if that fails, the errand ABANDONS through the
 * caller's own door (rung two, npc-controller `WATCHED_STALL_S` → `onAbandon` →
 * `abandonHaul`: the load set down where the body stands, spoken). Never a
 * teleport, never a snap, never a minted load. Out of sight the force-pass is
 * untouched.
 *
 * 📏 THE BOUNDS ARE MEASURED (scripts/probe-stall.ts, frontier arc seed 11 dt
 * 0.5 over 1 400 s): of 6 127 stall episodes a body got out of BY ITSELF, 99.46%
 * peaked at ≤ 2 s and p99.9 was 4.90 s; the honest tail ran out at 5 s and the
 * next episode of ANY kind was at 121 s. Honest pauses and wedges are two orders
 * of magnitude apart, so 6 s (re-route) / 12 s (abandon) sit in empty space.
 *
 * DB-free / GL-free — `npm run test:engine -- watched`.
 */
import { describe, it, expect, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createNpcController,
  type NpcControlCtx,
  type NpcErrandPoint,
} from "@shared/world-engine/npc-controller.js";
import { WORLD_ENGINE_DEFAULTS, type AvatarState } from "@shared/world-engine/engine.js";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import { livesOnTheFloor } from "@shared/world-engine/kernel/town/container-home.js";
import type { WildernessFeature } from "@shared/world-engine/interaction/quest/wilderness.js";

/** The two bounds this suite stands on, mirrored locally so the pin SAYS which
 *  numbers it is asserting rather than importing private ones. */
const STALL_S = 5; // npc-controller: the force-pass bound (unchanged)
const WATCHED_STALL_S = 12; // npc-controller: rung two — the watched abandon
const ERRAND_REROUTE_S = 6; // quest-host: rung one — the watched re-route
const EFFECT_PASS_R = 2.19; // npc-controller: how far past an EFFECT vertex still counts
const EFFECT_REROUTE_S = 4; // quest-host: repair before give-up, BELOW the force-pass bound

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — THE LAW, PURE. One controller, no world, no session.
// ─────────────────────────────────────────────────────────────────────────────

function bodyAt(x: number, y: number): AvatarState {
  return {
    id: "npc",
    x, y, vx: 0, vy: 0, fx: 1, fy: 0, floor: 0,
    carrying: null, possessedBy: null,
  } as unknown as AvatarState;
}

/** A WATCHED body: one human standing right beside it, so `watched` (VIEW_R 42)
 *  is true and the FLOW force-pass is suppressed exactly as it is in play. */
function watchedCtx(self: AvatarState, now: number): NpcControlCtx {
  return { self, humans: [bodyAt(self.x + 1, self.y)], now, width: 400, height: 400, rng: () => 0.5 };
}
/** An EMPTY gallery — the arm the force-pass owns. */
function aloneCtx(self: AvatarState, now: number): NpcControlCtx {
  return { self, humans: [], now, width: 400, height: 400, rng: () => 0.5 };
}

interface Run {
  arrived: number[];
  abandoned: number[];
  done: number;
  /** Errand still running when the clock ran out? */
  active: boolean;
  /** `stalledS` sampled at each step — the published progress clock. */
  stalls: number[];
}

/**
 * Hold a body PERFECTLY STILL on a plan it cannot walk (the wedge, distilled)
 * and run the controller's clock to `untilS`. Nothing moves, so no vertex can
 * ever be reached and every pass is a forced one.
 */
function pinned(
  points: NpcErrandPoint[],
  ctxOf: (self: AvatarState, now: number) => NpcControlCtx,
  untilS: number,
  opts?: { abandon?: boolean },
): Run {
  const self = bodyAt(0, 0);
  const ctrl = createNpcController({ id: "npc", x: 0, y: 0, behavior: { movement: "stationary" } });
  const r: Run = { arrived: [], abandoned: [], done: 0, active: true, stalls: [] };
  ctrl.setErrand({
    points,
    onArrive: (i) => r.arrived.push(i),
    onDone: () => { r.done++; },
    ...(opts?.abandon === false ? {} : { onAbandon: (i: number) => r.abandoned.push(i) }),
  });
  for (let t = 0; t <= untilS; t += 0.5) {
    ctrl.computeAim(ctxOf(self, t));
    const p = ctrl.errandPath();
    r.stalls.push(p?.stalledS ?? -1);
    if (!p) { r.active = false; break; }
  }
  return r;
}

/** A FLOW vertex 20 m off, then a stop 20 m past it. The first is route
 *  geometry (`effect: false`) — the shape a routed street/door corner has, and
 *  the one the force-pass may drop. */
const FLOW_PLAN: NpcErrandPoint[] = [
  { x: 0, y: 20, arrive: 0.9, effect: false },
  { x: 0, y: 40 },
];

describe("⏱️ rung two — a watched wedge ENDS, through the caller's own door", () => {
  it("🚨 the watched flow wedge abandons at WATCHED_STALL_S — and never passes the vertex", () => {
    const r = pinned(FLOW_PLAN.map((p) => ({ ...p })), watchedCtx, 30);
    // THE FINDING. Before this round the body sat here for ever: `passed` is
    // `stalled && !watched` on a flow vertex, so a watcher froze it solid.
    expect(r.abandoned).toEqual([0]);
    // …and it is an ABANDON, not a pass: no effect ran, from any distance.
    expect(r.arrived).toEqual([]);
    expect(r.done).toBe(0);
    expect(r.active).toBe(false);
    // ⚖️ IT IS NOT A CORNER-CUT EITHER. `isEffect` is deliberately NOT asked
    // here — a routing corner the body cannot get to is as final as a source it
    // cannot get to — but the vertex is abandoned, never crossed.
  });

  it("📏 it waits the measured bound and no less — an honest pause is never punished", () => {
    // p99.9 of a self-recovered stall is 4.9 s and the tail ends at 5 s; the
    // ladder must not fire anywhere near there.
    for (const t of [4, 5, 8, 11.5]) {
      const r = pinned(FLOW_PLAN.map((p) => ({ ...p })), watchedCtx, t);
      expect(r.abandoned).toEqual([]);
      expect(r.active).toBe(true);
    }
    const r = pinned(FLOW_PLAN.map((p) => ({ ...p })), watchedCtx, WATCHED_STALL_S + 1);
    expect(r.abandoned).toEqual([0]);
  });

  it("🚫 OPT-IN BY CALLBACK — an errand with no abandon door waits exactly as it always did", () => {
    const r = pinned(FLOW_PLAN.map((p) => ({ ...p })), watchedCtx, 60, { abandon: false });
    expect(r.arrived).toEqual([]); // still suppressed while watched
    expect(r.active).toBe(true);
  });

  it("🚫 …and an UNWATCHED body is untouched: the force-pass still wins, at STALL_S", () => {
    // The whole point of the round is that out of sight nothing changes. The
    // flow force-pass fires at 5 s on a NON-effect vertex, so `onArrive` runs
    // for it (a corner does no work in the world) and the errand walks on.
    const r = pinned(FLOW_PLAN.map((p) => ({ ...p })), aloneCtx, STALL_S + 1);
    expect(r.arrived).toEqual([0]);
    expect(r.abandoned).toEqual([]);
    expect(r.active).toBe(true);
  });

  it("📡 the stall is PUBLISHED, and it is the seam rung one reads", () => {
    const r = pinned(FLOW_PLAN.map((p) => ({ ...p })), watchedCtx, 10);
    // Monotone while pinned, and it crosses the host's re-route bound before
    // the controller's own abandon bound — the ladder's order, in one array.
    expect(r.stalls[0]).toBe(0);
    expect(Math.max(...r.stalls)).toBeGreaterThan(ERRAND_REROUTE_S);
    expect(Math.max(...r.stalls)).toBeLessThan(WATCHED_STALL_S);
    for (let i = 1; i < r.stalls.length; i++) expect(r.stalls[i]!).toBeGreaterThanOrEqual(r.stalls[i - 1]!);
  });

  it("🚨 …and a vertex that DOES something is not PASSED from across the street either", () => {
    // ⚖️ THE PROJECTION HALF of "a pass that is not an arrival may not do work
    // in the world". A flow vertex is reached by `t ≥ 1` — the body crossed the
    // perpendicular through it — and that clause carries NO distance. For a
    // routing corner that is right; for the caller's own waypoint it is a
    // distance-free pickup. Measured on the frontier arc BEFORE this round: 78
    // projection arrivals, six of them past 6 m, worst 7.52 m — and the basket
    // that snapped 8.63 m onto a porter is what `carry-fold`'s prop-jump pin
    // caught. `EFFECT_PASS_R` is the MEASURED honest ceiling (user ruling
    // 2026-09-07): on the bench world the arm this gates fired 7 times with a
    // worst of 2.08 m, and the whole measured set topped out at 2.19 m — so
    // 2.19 keeps every honest pass and refuses the 6 frontier arrivals past it
    // (worst 10.11 m). It is affordable only with the ordering beside it:
    // `EFFECT_REROUTE_S` (4 s) re-plans BEFORE the force-pass's give-up arm.
    // The plan runs due north from where the body starts. One frame anchors the
    // polyline's entry at the body; then the body is placed PAST vertex 0 (so
    // its projection has crossed the perpendicular, `t > 1`) and `off` metres
    // to the side, and the second frame is the one under test.
    const run = (pts: NpcErrandPoint[], off: number) => {
      const self = bodyAt(0, 0);
      const ctrl = createNpcController({ id: "npc", x: 0, y: 0, behavior: { movement: "stationary" } });
      const fired: number[] = [];
      ctrl.setErrand({ points: pts, onArrive: (i) => fired.push(i) });
      ctrl.computeAim(aloneCtx(self, 0)); // anchors errandEntry at (0,0)
      self.x = off;
      self.y = 20.5; // t = 20.5/20 = 1.025 — the projection is just past vertex 0
      ctrl.computeAim(aloneCtx(self, 0.5));
      return fired;
    };
    const plan = (): NpcErrandPoint[] => [{ x: 0, y: 20 }, { x: 0, y: 40 }];
    // SIX metres to the side of a vertex that takes a basket into hands — past
    // the bound, and past the prop-jump pin's own teleport line.
    expect(EFFECT_PASS_R).toBeLessThan(6);
    expect(EFFECT_REROUTE_S).toBeLessThan(STALL_S); // repair BEFORE give-up
    expect(run(plan(), 6)).toEqual([]);
    // …and so is THREE metres: the bound is the measured honest ceiling, not a
    // teleport line, so anything a walking body never actually reached is out.
    expect(run(plan(), 3)).toEqual([]);
    // …the same geometry on a ROUTING CORNER still flows, because a corner does
    // no work and flowing through one is the whole point of pure pursuit.
    expect(run(plan().map((p, i) => (i === 0 ? { ...p, effect: false } : p)), 6)).toEqual([0]);
    // …and an honest pass — a body-width to the side — still counts, so nothing
    // that was walking properly is ever asked to walk back.
    expect(run(plan(), 1.5)).toEqual([0]);
    // …as does a pass right at the bench's own measured ceiling: 2 m to the
    // side is d = 2.06 m, inside 2.19, so the shipped bench cannot move.
    expect(run(plan(), 2)).toEqual([0]);
  });

  it("🚶 a body that keeps ARRIVING never abandons — the clock is progress, not wall time", () => {
    // Walk the body onto each vertex in turn over 40 s: far past both bounds in
    // elapsed time, and the ladder must never fire, because the plan is moving.
    const self = bodyAt(0, 0);
    const ctrl = createNpcController({ id: "npc", x: 0, y: 0, behavior: { movement: "stationary" } });
    const arrived: number[] = [];
    const abandoned: number[] = [];
    const pts: NpcErrandPoint[] = [
      { x: 0, y: 20, arrive: 0.9, effect: false },
      { x: 0, y: 40, arrive: 0.9, effect: false },
      { x: 0, y: 60 },
    ];
    ctrl.setErrand({ points: pts, onArrive: (i) => arrived.push(i), onAbandon: (i) => abandoned.push(i) });
    for (let t = 0; t <= 40; t += 0.5) {
      // 0.5 m/s of honest progress — slower than a walk, faster than nothing.
      self.y = Math.min(60, t * 1.6);
      ctrl.computeAim(watchedCtx(self, t));
    }
    expect(abandoned).toEqual([]);
    expect(arrived).toEqual([0, 1, 2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — THE WHOLE LADDER, LIVE. The carry lane's rock-ring harness, with the
// wall planted IN SIGHT instead of 65 m away from every human.
// ─────────────────────────────────────────────────────────────────────────────

const DOC = () =>
  JSON.parse(readFileSync(join(process.cwd(), "scripts", "worlds", "frontier.spec.json"), "utf8"));

let live: TextQuestRun | null = null;
afterAll(() => live?.dispose());

function totalUnits(stock: Readonly<Record<string, number>> | undefined): number {
  let n = 0;
  for (const v of Object.values(stock ?? {})) n += Math.max(0, v);
  return n;
}

describe("⏱️ the ladder, live — wedged IN SIGHT, resolved within the bound", () => {
  it("🪨 a walled-in porter watched by a person re-routes, then sets its load down", () => {
    const run = (live = bootTextQuest({ world: DOC(), seed: 11, dt: 0.5 }));
    const { session, state } = run;
    const DT = 0.5;

    /** A porter really carrying a LOADED basket for a live haul. */
    const loadedPorter = (): { cid: string; objId: string; units: number; agr: string } | null => {
      for (const a of session.transfers.all()) {
        if (a.status !== "moving" || !a.executor) continue;
        if (Object.values(a.carried ?? {}).reduce((s, n) => s + n, 0) <= 0) continue;
        for (const [objId, o] of Object.entries(state.objects)) {
          if (o.carriedBy !== a.executor) continue;
          const rec = session.containerRecords.get(objId);
          if (!rec?.glyph || !livesOnTheFloor(rec.glyph)) continue;
          const units = totalUnits(rec.stock);
          if (units > 0) return { cid: a.executor, objId, units, agr: a.id };
        }
      }
      return null;
    };

    /**
     * 🚨 HOW "WATCHED" IS EXERCISED WITH NO CAMERA. The text arc has no GL
     * camera, but it has both of the things the two view gates actually read:
     * the PLAYER_ID avatar is parked at the town centre (`bootTextQuest` camera
     * effect ①) — that is the controller's `ctx.humans` — and `setSpiritPosition`
     * puts the spirit there too, which is what `viewNear` reads. Both gates are
     * 42 m circles about the same point, so a porter INSIDE that circle is
     * watched by the controller AND by the host, exactly as one on screen is.
     * The carry lane's harness deliberately went 65 m OUT to escape them; this
     * one deliberately stays in.
     */
    const gazeBody = () => state.avatars["player"];
    const cameraAt = () => session.spiritPos ?? gazeBody();

    let spoke = false;
    let target: { cid: string; objId: string; units: number; agr: string } | null = null;
    let wallT = 0;
    for (let i = 0; i < 1600 && !target; i++) {
      run.stepFrame();
      if (!spoke && session.townClock >= 12) {
        spoke = true;
        run.speak("build + house"); // the arc: a house wants 120 blocks staged
      }
      const p = loadedPorter();
      if (!p) continue;
      const av = state.avatars[p.cid];
      if (!av) continue;
      // INSIDE both 42 m gates, with margin. 40 m is MEASURED, not chosen: on
      // this arc a loaded porter never comes closer than 38.7 m to the parked
      // gaze body (p10 = 40.0 m over 3 522 samples) — the yard and the site are
      // simply that far from the plaza — and the walled body can still slide at
      // most ~1.6 m inside its 2.2 m ring before the rocks hold it, so 40 + 1.6
      // stays under 42 for the whole test.
      const eye = gazeBody();
      const cam = cameraAt();
      if (!eye || !cam) continue;
      if (Math.hypot(eye.x - av.x, eye.y - av.y) > 40) continue; // the controller's `ctx.humans`
      if (Math.hypot(cam.x - av.x, cam.y - av.y) > 40) continue; // the host's `viewNear`
      target = p;
      wallT = state.time;
      // THE WALL: 72 standing outcrops on a 2.2 m circle — 0.19 m apart, each
      // 0.55 m of solid sphere, so there is no gap a body fits through.
      // `species: "rock"` (kind `mineral`, never embodied) is the one that
      // walls: a DOWNED feature and a flora BODY are deliberately not obstacles
      // — see the `solid` decision in the round ledger.
      for (let k = 0; k < 72; k++) {
        const ang = (k / 72) * Math.PI * 2;
        const f: WildernessFeature = {
          id: `probe:wall_${k}`,
          species: "rock",
          x: av.x + Math.cos(ang) * 2.2,
          y: av.y + Math.sin(ang) * 2.2,
          stock: { stone: 10 },
        };
        run.host.addWildFeature(f);
      }
    }
    // PREMISE, not the finding: the arc really did put a loaded basket in a
    // pair of hands INSIDE the watched circle. Without it everything below is
    // vacuous, and it is the exact case the carry lane's harness excluded.
    if (!target) throw new Error("no loaded porter inside the watched circle — fixture broken, not a finding");

    const loadWas = target.units;
    const bagObj = () => state.objects[target!.objId];
    const av = state.avatars[target.cid]!;

    // ⚖️ AND NOTHING MAY TELEPORT WHILE WE WAIT. `steerAvatar` is the ONE
    // locomotion, so the per-frame ceiling is the mover's own top speed; a
    // recovery that snapped a body would show up here and nowhere else.
    const CAP = WORLD_ENGINE_DEFAULTS.steerMaxSpeed * DT * 1.35; // + the substep/brake margin
    let worstJump = 0;
    let prev = { x: av.x, y: av.y };

    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); realLog(...a); };
    try {
      // 60 sim s — 2.5× the ladder's worst case (6 + 6 + 12 = 24 s), and a
      // small fraction of the 110 s the same wedge held for before it.
      for (let i = 0; i < 120 && bagObj()?.carriedBy; i++) {
        run.stepFrame();
        const now = state.avatars[target.cid];
        if (now) {
          worstJump = Math.max(worstJump, Math.hypot(now.x - prev.x, now.y - prev.y));
          prev = { x: now.x, y: now.y };
        }
      }
    } finally {
      console.log = realLog;
    }
    const resolvedT = state.time;

    // ① IT RESOLVED — visibly, and inside the bound. Before the ladder this
    //    body held its load for the whole run with the agreement still `moving`.
    expect(bagObj()).toBeDefined();
    expect(bagObj()!.carriedBy).toBeFalsy();
    expect(resolvedT - wallT).toBeLessThan(60);

    // ② RUNG ONE RAN FIRST. The re-route is the honest attempt, and it is what
    //    makes this different from simply lowering a timeout: the plan is
    //    rebuilt from the live position through `doorRouteErrand` before
    //    anything gives up.
    const reroutes = logs.filter((l) => l.includes("[stall]") && l.includes(target!.cid));
    expect(reroutes.length).toBeGreaterThan(0);
    expect(reroutes.length).toBeLessThanOrEqual(2); // the budget, spent and not exceeded

    // ③ RUNG TWO ENDED IT THROUGH `abandonHaul` — the diegetic door.
    expect(logs.some((l) => l.includes(`[haul] ${target!.cid} ABANDONED`))).toBe(true);
    const agr = session.transfers.get(target.agr);
    expect(agr?.status).not.toBe("moving");

    // ④ NOTHING SNAPPED. The body never moved further in one frame than its own
    //    legs could carry it — no teleport, no re-anchor, no minted position.
    expect(worstJump).toBeLessThanOrEqual(CAP);

    // ⑤ CONSERVATION. The units MOVED with the basket; none were minted or
    //    lost, and the basket is a real container standing on the ground (the
    //    carry lane's R-D ruling, which this ladder must not undo).
    const rec = session.containerRecords.get(target.objId);
    expect(rec?.mount).toBe("loose");
    expect(totalUnits(rec?.stock)).toBe(loadWas);
  }, 600000);
});
