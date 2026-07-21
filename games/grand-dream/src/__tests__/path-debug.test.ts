/**
 * PATH DEBUG — the lab's 🧭 Paths overlay, end to end as far as headless allows:
 *   • NpcController.errandPath() reports the live leg honestly (the data source);
 *   • PathDebugOverlay3D turns snapshots into line segments (the drawing).
 *
 * THREE.Scene/BufferGeometry are pure JS — no WebGL — so the overlay's buffer
 * writing is fully testable here. What is NOT covered: that the lines are
 * actually visible on screen (camera/material/depth), which needs eyes.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { createNpcController } from "@shared/world-engine/npc-controller";
import { PathDebugOverlay3D } from "@shared/world-engine/path-debug-3d";
import type { NpcPathSnapshot } from "@shared/world-engine/world-host";
import type { AvatarState } from "@shared/world-engine/engine";

// ── errandPath ──────────────────────────────────────────────────────────────

const ctrl = () => createNpcController({ id: "npc_a", x: 0, y: 0, behavior: { movement: "wander" } });

/** A minimal control ctx parked at (x,y). */
const ctx = (x: number, y: number, now: number) => ({
  self: { id: "npc_a", x, y, vx: 0, vy: 0, floor: 0 } as unknown as AvatarState,
  humans: [],
  now,
  width: 100,
  height: 100,
  rng: () => 0.5,
  walkable: () => true,
  radius: 0.4,
});

describe("NpcController.errandPath — the data the overlay draws", () => {
  it("is null with no errand", () => {
    expect(ctrl().errandPath()).toBeNull();
  });

  it("reports the points and starts on leg 0", () => {
    const c = ctrl();
    c.setErrand({ points: [{ x: 5, y: 0 }, { x: 5, y: 5 }] });
    const p = c.errandPath();
    expect(p).not.toBeNull();
    expect(p!.points).toHaveLength(2);
    expect(p!.index).toBe(0);
    expect(p!.dwelling).toBe(false);
  });

  it("advances the live leg as waypoints are reached", () => {
    const c = ctrl();
    c.setErrand({ points: [{ x: 5, y: 0 }, { x: 5, y: 5 }] });
    // Far away → still leg 0. The follower is PURE PURSUIT: the aim is a
    // carrot along the path toward the first point, not the point itself.
    const aim = c.computeAim(ctx(0, 0, 1))!;
    expect(aim.y).toBeCloseTo(0, 6); // on the first segment's line
    expect(aim.x).toBeGreaterThan(0); // ahead, toward the waypoint
    expect(c.errandPath()!.index).toBe(0);
    // Standing on the first point → its plane is passed → steps to leg 1.
    c.computeAim(ctx(5, 0, 2));
    expect(c.errandPath()!.index).toBe(1);
  });

  it("flags a dwell — a body standing still, not a stuck one", () => {
    const c = ctrl();
    c.setErrand({ points: [{ x: 5, y: 0, dwell: 3 }] });
    c.computeAim(ctx(0, 0, 1)); // en route
    expect(c.errandPath()!.dwelling).toBe(false);
    c.computeAim(ctx(5, 0, 2)); // arrived → dwell starts
    expect(c.errandPath()!.dwelling).toBe(true);
  });

  it("goes null once the errand finishes", () => {
    const c = ctrl();
    c.setErrand({ points: [{ x: 5, y: 0 }] });
    c.computeAim(ctx(0, 0, 1));
    c.computeAim(ctx(5, 0, 2)); // arrive → no dwell → advance past the end
    expect(c.errandPath()).toBeNull();
  });

  it("SKIP-AHEAD: a body beside a LATER segment resumes from there (no thrash back)", () => {
    // The corner-cut failure: the body ends up past its next waypoint, on the
    // following segment — pursuing the old vertex then aims BEHIND it and the
    // walk thrashes between returning and continuing. The follower must
    // recognize the later path position and continue from there.
    const c = ctrl();
    c.setErrand({ points: [{ x: 5, y: 0, arrive: 0.5 }, { x: 5, y: 5, arrive: 0.5 }, { x: 0, y: 5 }] });
    c.computeAim(ctx(0, 0, 1)); // entry stamped at (0,0), pursuing vertex 0
    expect(c.errandPath()!.index).toBe(0);
    // Cut the corner hard: the body stands beside segment 1→2 (y=5 line).
    const aim = c.computeAim(ctx(4.6, 4.8, 2))!;
    expect(c.errandPath()!.index).toBe(2); // fast-forwarded past both flow vertices
    expect(aim.x).toBeLessThan(4.6); // and the aim continues DOWN the path, never back
  });

  it("SKIP-AHEAD never crosses a dwell stop", () => {
    const c = ctrl();
    c.setErrand({ points: [{ x: 5, y: 0, dwell: 2 }, { x: 5, y: 5 }] });
    c.computeAim(ctx(0, 0, 1));
    // Beside the later segment, but vertex 0 is a STOP (dwell) — it must not
    // be skipped; the body is sent back to stand its dwell out.
    c.computeAim(ctx(5, 3, 2));
    expect(c.errandPath()!.index).toBe(0);
  });
});

describe("wander confinement — the IDLE PAD", () => {
  const pad = { x: 10, y: 10, w: 4, h: 4 };

  it("draws waypoints only inside the pad", () => {
    const c = ctrl();
    c.setWanderRect(pad);
    for (let k = 0; k < 12; k++) {
      const seq = [k / 12, ((k * 7) % 12) / 12];
      let i = 0;
      const c2 = ctrl();
      c2.setWanderRect(pad);
      const wp = c2.computeAim({ ...ctx(12, 12, 1), rng: () => seq[i++ % 2]! });
      if (!wp) continue; // pause beat
      expect(wp.x).toBeGreaterThanOrEqual(pad.x);
      expect(wp.x).toBeLessThanOrEqual(pad.x + pad.w);
      expect(wp.y).toBeGreaterThanOrEqual(pad.y);
      expect(wp.y).toBeLessThanOrEqual(pad.y + pad.h);
    }
  });

  it("a body OUTSIDE its pad stands still (the host paths it there, never a blind roam)", () => {
    const c = ctrl();
    c.setWanderRect(pad);
    expect(c.computeAim(ctx(30, 30, 1))).toBeNull();
  });

  it("clearing the pad restores the open roam", () => {
    const c = ctrl();
    c.setWanderRect(pad);
    c.setWanderRect(null);
    const seq = [0.5, 0.5];
    let i = 0;
    expect(c.computeAim({ ...ctx(30, 30, 1), rng: () => seq[i++ % 2]! })).not.toBeNull();
  });
});

// ── the overlay ─────────────────────────────────────────────────────────────

const snap = (over: Partial<NpcPathSnapshot> = {}): NpcPathSnapshot => ({
  npcId: "npc_a",
  at: { x: 0, y: 0 },
  floor: 0,
  errand: null,
  aim: null,
  bent: null,
  detoured: false,
  ...over,
});

/** Mount an overlay over a fixed snapshot list and draw one frame. */
function draw(paths: NpcPathSnapshot[], enabled = true) {
  const o = new PathDebugOverlay3D({ getPaths: () => paths });
  o.mount(new THREE.Scene());
  o.setEnabled(enabled);
  o.update(0.016);
  const geom = (o as unknown as { geom: THREE.BufferGeometry }).geom;
  return { o, geom, verts: geom.drawRange.count };
}

describe("PathDebugOverlay3D", () => {
  it("draws nothing at all while disabled", () => {
    const { verts } = draw([snap({ aim: { x: 9, y: 9 } })], false);
    expect(verts).toBe(0);
  });

  it("draws nothing for an idle body with no aim and no errand", () => {
    expect(draw([snap()]).verts).toBe(0);
  });

  it("an errand-less body with a wander aim gets ONE segment", () => {
    // grey heading line: 1 segment = 2 verts, no waypoint ticks.
    expect(draw([snap({ aim: { x: 9, y: 9 } })]).verts).toBe(2);
  });

  it("a live errand draws the leg, its tick, and the remaining plan", () => {
    const { verts } = draw([
      snap({ errand: { points: [{ x: 5, y: 0 }, { x: 5, y: 5 }], index: 0, dwelling: false } }),
    ]);
    // leg(1) + tick(2) + plan hop 0→1(1) + its tick(2) = 6 segments = 12 verts.
    expect(verts).toBe(12);
  });

  it("only the REMAINING plan is drawn — walked legs are gone", () => {
    const three = { points: [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }], index: 2, dwelling: false };
    const { verts } = draw([snap({ errand: three })]);
    // On the LAST leg: leg(1) + tick(2) = 3 segments. No hops remain.
    expect(verts).toBe(6);
  });

  it("a detour adds its own line — the red one worth looking at", () => {
    const base = snap({ errand: { points: [{ x: 5, y: 0 }], index: 0, dwelling: false } });
    const plain = draw([base]).verts;
    const bent = draw([snap({ ...base, bent: { x: 3, y: 3 }, detoured: true })]).verts;
    // detour line(1) + tick(2) = 3 more segments = 6 more verts.
    expect(bent - plain).toBe(6);
  });

  it("lifts each body's lines to ITS floor (an upstairs walker isn't drawn in the cellar)", () => {
    const { geom } = draw([
      snap({ floor: 2, errand: { points: [{ x: 5, y: 0 }], index: 0, dwelling: false } }),
    ]);
    const pos = geom.getAttribute("position") as THREE.BufferAttribute;
    // FLOOR_HEIGHT 3 × floor 2 + PATH_Y 0.08.
    expect(pos.getY(0)).toBeCloseTo(6.08, 6);
  });

  it("world (x,y) maps to the 3D (x, _, y) ground convention", () => {
    const { geom } = draw([snap({ at: { x: 1, y: 2 }, aim: { x: 7, y: 8 } })]);
    const pos = geom.getAttribute("position") as THREE.BufferAttribute;
    expect([pos.getX(0), pos.getZ(0)]).toEqual([1, 2]);
    expect([pos.getX(1), pos.getZ(1)]).toEqual([7, 8]);
  });

  it("reports overflow rather than silently truncating", () => {
    // Each errand-less body costs 1 segment; MAX_SEGMENTS is 12000.
    const many = Array.from({ length: 12001 }, (_, i) => snap({ npcId: `n${i}`, aim: { x: i, y: 1 } }));
    const { o, verts } = draw(many);
    expect(verts).toBe(12000 * 2);
    expect(o.overflowed).toBe(true);
  });

  it("does not overflow at a realistic town size", () => {
    const town = Array.from({ length: 300 }, (_, i) =>
      snap({ npcId: `n${i}`, errand: { points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], index: 0, dwelling: false } }),
    );
    expect(draw(town).o.overflowed).toBe(false);
  });

  it("clears its lines when switched back off", () => {
    const paths = [snap({ aim: { x: 9, y: 9 } })];
    const o = new PathDebugOverlay3D({ getPaths: () => paths });
    o.mount(new THREE.Scene());
    o.setEnabled(true);
    o.update(0.016);
    const geom = (o as unknown as { geom: THREE.BufferGeometry }).geom;
    expect(geom.drawRange.count).toBe(2);
    o.setEnabled(false);
    expect(geom.drawRange.count).toBe(0);
    o.update(0.016); // and stays cleared — no work while off
    expect(geom.drawRange.count).toBe(0);
  });

  it("dispose detaches the group from the scene", () => {
    const scene = new THREE.Scene();
    const o = new PathDebugOverlay3D({ getPaths: () => [] });
    o.mount(scene);
    expect(scene.children).toHaveLength(1);
    o.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
