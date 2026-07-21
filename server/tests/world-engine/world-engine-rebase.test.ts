// CHART REBASE (floating origin for planet-mounted ground) — WorldHost.rebase
// re-expresses the ENTIRE live sim in a moved tangent chart: avatar/NPC poses,
// velocities, facings, objects, and every point an NPC controller remembers
// (home tether, wander waypoint, errand polyline). The caller moves the render
// anchor so WORLD poses are unchanged; these tests pin that the sim-side
// re-expression is exact and that behaviour carries on as if nothing happened —
// the mechanism that lets the wilderness follow a walker across a planet with
// no remount, no despawn, and no invisible walls (planet-frame migration).
//
// Run from the REPO ROOT (jest): npx jest server/tests/world-engine-rebase.test.ts

import { describe, it, expect } from "@jest/globals";
import { socialFieldNpcsSpec } from "@shared/world-engine/specs/index.js";
import { runWorldHost, type WorldHost } from "@shared/world-engine/world-host.js";
import { createNpcController } from "@shared/world-engine/npc-controller.js";
import type { WorldView } from "@shared/world-engine/world-view.js";
import type { WorldNetMessage } from "@shared/world-engine/index.js";

const DT = 1 / 60;

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function fakeView(): WorldView {
  return {
    screenToWorld: () => null,
    render: () => undefined,
    resize: () => undefined,
    dispose: () => undefined,
  };
}

function build(): { host: WorldHost; step: (n: number) => void } {
  let pending: ((nowMs: number) => void) | null = null;
  let clock = 0;
  const sent: WorldNetMessage[][] = [];
  const host = runWorldHost({
    view: fakeView(),
    spec: socialFieldNpcsSpec,
    localId: "you",
    spawnIndex: 0,
    hostNpcs: true,
    npcRng: makeRng(7),
    scheduleFrame: (cb) => {
      pending = cb;
      return () => {
        pending = null;
      };
    },
    now: () => clock,
    net: { send: (msgs) => sent.push(msgs) },
  });
  const step = (n: number): void => {
    for (let i = 0; i < n; i++) {
      clock += DT * 1000;
      const cb = pending;
      pending = null;
      cb?.(clock);
    }
  };
  host.start();
  return { host, step };
}

/** A rigid chart change: rotate by 90° about the field's centre — the shape of
 *  a real tangent-chart re-anchor (rotation is tiny in production; a fat one
 *  here makes any missed field scream). The pivot keeps the mapped world
 *  inside this BOUNDED test manifold (80×60) so the engine's edge clamp never
 *  contaminates what the rebase wrote — production rebases run unbounded. */
const C = { x: 40, y: 30 };
const mapPoint = (p: { x: number; y: number }): { x: number; y: number } => ({
  x: C.x - (p.y - C.y),
  y: C.y + (p.x - C.x),
});
const mapVec = (v: { x: number; y: number }): { x: number; y: number } => ({
  x: -v.y,
  y: v.x,
});

describe("WorldHost.rebase", () => {
  it("re-expresses every avatar pose exactly (position, facing, velocity)", () => {
    const { host, step } = build();
    step(30); // let NPCs pick up some motion
    const before = Object.fromEntries(
      Object.values(host.state.avatars).map((a) => [
        a.id,
        { x: a.x, y: a.y, fx: a.fx, fy: a.fy, vx: a.vx, vy: a.vy },
      ]),
    );
    host.rebase(mapPoint, mapVec);
    for (const [id, b] of Object.entries(before)) {
      const a = host.state.avatars[id]!;
      const p = mapPoint(b);
      expect(a.x).toBeCloseTo(p.x, 9);
      expect(a.y).toBeCloseTo(p.y, 9);
      const f = mapVec({ x: b.fx, y: b.fy });
      expect(a.fx).toBeCloseTo(f.x, 9);
      expect(a.fy).toBeCloseTo(f.y, 9);
      // Facing stays unit; velocity magnitude is preserved (rigid map).
      expect(Math.hypot(a.fx, a.fy)).toBeCloseTo(1, 9);
      expect(Math.hypot(a.vx, a.vy)).toBeCloseTo(Math.hypot(b.vx, b.vy), 9);
    }
    host.stop();
  });

  it("re-expresses object positions", () => {
    const { host, step } = build();
    step(5);
    const before = Object.fromEntries(
      Object.values(host.state.objects).map((o) => [o.id, { x: o.x, y: o.y }]),
    );
    expect(Object.keys(before).length).toBeGreaterThan(0); // the field carries a toy
    host.rebase(mapPoint, mapVec);
    for (const [id, b] of Object.entries(before)) {
      const o = host.state.objects[id]!;
      const p = mapPoint(b);
      expect(o.x).toBeCloseTo(p.x, 9);
      expect(o.y).toBeCloseTo(p.y, 9);
    }
    host.stop();
  });

  it("an errand survives the rebase — the NPC walks on to the SAME (re-expressed) goal", () => {
    const { host, step } = build();
    const npcId = Object.keys(host.state.avatars).find((id) => id.startsWith("npc_"))!;
    const goal = { x: 55, y: 45 };
    const goalNew = mapPoint(goal); // BEFORE rebase: the polyline is remapped IN PLACE
    let done = false;
    host.setNpcErrand(npcId, { points: [{ ...goal }], onDone: () => (done = true) });
    step(30); // en route, mid-walk
    expect(host.npcErrandActive(npcId)).toBe(true);
    host.rebase(mapPoint, mapVec);
    // Walk on: the errand's polyline was re-expressed with the world, so the
    // body converges on the same WORLD spot (new chart coords) — a missed
    // remap would send it marching toward stale coordinates instead.
    for (let i = 0; i < 60 * 30 && !done; i++) step(1);
    expect(done).toBe(true);
    const a = host.state.avatars[npcId]!;
    expect(Math.hypot(a.x - goalNew.x, a.y - goalNew.y)).toBeLessThan(3);
    host.stop();
  });

  it("a wanderer's home tether follows the chart — it roams around the MAPPED home", () => {
    const { host, step } = build();
    step(60);
    const wanderer = Object.keys(host.state.avatars).find((id) => id.startsWith("npc_"))!;
    const before = host.state.avatars[wanderer]!;
    const homeNew = mapPoint({ x: before.x, y: before.y }); // ≈ home (tethered wander stays near it)
    host.rebase(mapPoint, mapVec);
    step(60 * 20);
    const a = host.state.avatars[wanderer]!;
    // The spec's wanderers are tethered (wanderRadius or the unbounded default
    // 30): 20 s after the rebase the body must still orbit the re-expressed
    // home, not have marched off toward its pre-rebase coordinates.
    expect(Math.hypot(a.x - homeNew.x, a.y - homeNew.y)).toBeLessThan(45);
    host.stop();
  });
});

describe("NpcController.rebase", () => {
  it("re-expresses the errand polyline in place (dwell/arrive metadata intact)", () => {
    const ctrl = createNpcController({
      id: "npc_r",
      x: 0,
      y: 0,
      behavior: { movement: "stationary" },
    });
    ctrl.setErrand({
      points: [
        { x: 10, y: 20, dwell: 2 },
        { x: 30, y: 40, arrive: 0.4 },
      ],
    });
    ctrl.rebase(mapPoint);
    const path = ctrl.errandPath()!;
    expect(path.points[0]).toMatchObject({ ...mapPoint({ x: 10, y: 20 }), dwell: 2 });
    expect(path.points[1]).toMatchObject({ ...mapPoint({ x: 30, y: 40 }), arrive: 0.4 });
  });
});
