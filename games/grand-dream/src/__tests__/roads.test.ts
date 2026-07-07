/**
 * Town streets (streets.ts) — the organic street tree. What must hold:
 * the growth-event stream is deterministic and PREFIX-STABLE (a bigger
 * town replays the same events further — streets only extend, lots only
 * append); routes ride the network and never cut through a building
 * (the fix for NPCs wedging into houses); and houses front their street.
 */

import { describe, expect, it } from "vitest";
import { createNpcController } from "@shared/world-engine/npc-controller";
import { buildAcceptanceTri } from "../tri-worlds";
import { createTownFood, houseDoorstep } from "../food";
import { growStreets, project, roadDistance, roadRoute, routeLength } from "../streets";
import { townPlan, worldPos } from "../zoom";

describe("town streets", () => {
  it("growth is deterministic and prefix-stable: a bigger town extends, never reshuffles", () => {
    const small = growStreets(7, "riverton", 120);
    const twin = growStreets(7, "riverton", 120);
    expect(JSON.stringify(twin.slots)).toBe(JSON.stringify(small.slots));

    const big = growStreets(7, "riverton", 500);
    expect(big.slots.length).toBeGreaterThan(small.slots.length);
    // Every lot the small town knows sits byte-identical in the big one.
    expect(JSON.stringify(big.slots.slice(0, small.slots.length))).toBe(JSON.stringify(small.slots));
    // Streets only extend: same ids, same prefix of points.
    for (const s of small.streets) {
      const b = big.streets[s.id];
      expect(b.parent).toBe(s.parent);
      expect(b.pts.length).toBeGreaterThanOrEqual(s.pts.length);
      expect(JSON.stringify(b.pts.slice(0, s.pts.length))).toBe(JSON.stringify(s.pts));
    }
  });

  it("routes ride the network and never cut through a building", async () => {
    const a = await buildAcceptanceTri(42);
    const plan = townPlan(a.tri, "riverton", 7);
    const roads = plan.streets;
    const rc = a.tri.cities.find(c => c.key === "riverton")!;
    const center = worldPos(rc.x, rc.y);
    const food = createTownFood(a.tri, { key: "riverton", center, plan }, 7, roads);

    expect(roads.streets.length).toBeGreaterThan(3);

    // Every building footprint, town-local (houses + hall/market/works).
    const rects = [
      ...plan.houses.map(h => ({ x: h.dx, y: h.dy, w: h.w, h: h.h })),
      ...plan.works.map(w => ({ x: w.dx, y: w.dy, w: w.w, h: w.h })),
    ];
    // Sampled shopping routes: deterministic, endpoint-exact, at least
    // as long as the chord, and NO waypoint inside ANY building.
    let sampled = 0;
    for (let i = 0; i < plan.houses.length; i += 23) {
      const h = plan.houses[i];
      const home = houseDoorstep(center, h);
      const src = food.sourceOf(h);
      const from = { x: home.x - center.x, y: home.y - center.y };
      const to = { x: src.x - center.x, y: src.y - center.y };
      const route = roadRoute(roads, from, to);
      expect(route[0]).toEqual(from);
      expect(route[route.length - 1]).toEqual(to);
      expect(JSON.stringify(roadRoute(roads, from, to))).toBe(JSON.stringify(route));
      expect(routeLength(route)).toBeGreaterThanOrEqual(Math.hypot(to.x - from.x, to.y - from.y) - 1e-9);
      // The closed-form distance agrees with the materialized route.
      expect(roadDistance(roads, from, to)).toBeGreaterThanOrEqual(routeLength(route) - 2);
      for (const p of route) {
        const hit = rects.find(r => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h);
        if (hit) {
          throw new Error(`waypoint (${p.x.toFixed(2)},${p.y.toFixed(2)}) of house ${h.index}'s route ` +
            `is inside building (${hit.x.toFixed(2)},${hit.y.toFixed(2)} ${hit.w.toFixed(2)}x${hit.h.toFixed(2)})`);
        }
      }
      sampled++;
    }
    expect(sampled).toBeGreaterThan(10);
  });

  it("street wear follows use: the trunk carries the traffic, twigs carry trickles", async () => {
    const a = await buildAcceptanceTri(42);
    const plan = townPlan(a.tri, "riverton", 7);
    const rc = a.tri.cities.find(c => c.key === "riverton")!;
    const center = worldPos(rc.x, rc.y);
    const food = createTownFood(a.tri, { key: "riverton", center, plan }, 7, plan.streets);
    const traffic = food.streetTraffic();
    expect(traffic.size).toBeGreaterThan(3);
    let total = 0;
    let busiest = -1;
    let busy = 0;
    for (const [id, n] of traffic) {
      total += n;
      if (n > busy) { busy = n; busiest = id; }
    }
    // Flows CONCENTRATE: the busiest street carries far more than the
    // average one (that's what makes it an arterial on screen) — and a
    // real crowd, not a trickle. (It need not be a gen-0 road: a
    // neighborhood stall deep in a quarter funnels its whole catchment
    // through the lane that reaches it — becoming an arterial by use is
    // the point.)
    expect(busy).toBeGreaterThan((total / traffic.size) * 3);
    expect(busy).toBeGreaterThanOrEqual(10);
    expect(busiest).toBeGreaterThanOrEqual(0);
  });

  it("houses front their street: doorsteps sit outside the walls, a step from the lane", async () => {
    const a = await buildAcceptanceTri(42);
    const plan = townPlan(a.tri, "riverton", 7);
    for (const h of plan.houses) {
      // Doorstep sits outside the footprint on the door edge…
      const d = houseDoorstep({ x: 0, y: 0 }, h);
      expect(d.x > h.dx && d.x < h.dx + h.w && d.y > h.dy && d.y < h.dy + h.h).toBe(false);
      // …and ON the street side: the network passes within a few steps.
      expect(project(plan.streets, d).d).toBeLessThan(9);
    }
  });

  it("an errand dwell holds the NPC at the stall, then it walks on", () => {
    const ctrl = createNpcController({
      id: "v", x: 0, y: 0,
      behavior: { movement: "wander", conversationRadius: 5 },
    });
    ctrl.setErrand({ points: [{ x: 1, y: 0, dwell: 5 }, { x: 10, y: 0 }] });
    const ctx = (now: number) => ({
      self: { id: "v", x: 0.5, y: 0, fx: 1, fy: 0, vx: 0, vy: 0, floor: 0 },
      humans: [], now, width: 100, height: 100, rng: () => 0.5,
    });
    expect(ctrl.computeAim(ctx(0))).toBeNull(); // arrived at the stall → standing
    expect(ctrl.computeAim(ctx(3))).toBeNull(); // still shopping
    expect(ctrl.computeAim(ctx(6))).toEqual({ x: 10, y: 0 }); // dwell over → head home
  });

  it("wander refuses to aim at blocked ground when the host provides walkability", () => {
    const ctrl = createNpcController({
      id: "v", x: 50, y: 50,
      behavior: { movement: "wander", conversationRadius: 5, wanderRadius: 20 },
    });
    let s = 7;
    const rng = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    // Everything east of x=50 is "inside a building".
    const walkable = (p: { x: number; y: number }): boolean => p.x <= 50;
    let now = 0;
    for (let i = 0; i < 120; i++) {
      now += 5;
      const aim = ctrl.computeAim({
        self: { id: "v", x: 50, y: 50, fx: 1, fy: 0, vx: 0, vy: 0, floor: 0 },
        humans: [], now, width: 800, height: 600, rng, walkable,
      });
      if (aim) expect(aim.x).toBeLessThanOrEqual(50);
    }
  });

  it("a wanderer aiming at an unreachable point gives up and repicks instead of grinding forever", () => {
    const ctrl = createNpcController({
      id: "v", x: 100, y: 100,
      behavior: { movement: "wander", conversationRadius: 5, wanderRadius: 12 },
    });
    let s = 42;
    const rng = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    // The body NEVER moves (as if pinned against a wall). Collect aims.
    const aims: Array<{ x: number; y: number } | null> = [];
    for (let t = 0; t <= 15; t += 0.5) {
      aims.push(ctrl.computeAim({
        self: { id: "v", x: 100, y: 100, fx: 1, fy: 0, vx: 0, vy: 0, floor: 0 },
        humans: [], now: t, width: 800, height: 600, rng,
      }));
    }
    const points = aims.filter((a): a is { x: number; y: number } => a !== null);
    const distinct = new Set(points.map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`));
    // Without stuck detection this is ONE waypoint served forever; with
    // it, the controller drops the aim (a null) and picks fresh ones.
    expect(distinct.size).toBeGreaterThanOrEqual(2);
    expect(aims.some((a, i) => a === null && aims[i - 1] !== null)).toBe(true);
  });
});
