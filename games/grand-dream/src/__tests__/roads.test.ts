/**
 * Town streets (town-roads.ts) — the fix for NPCs wedging into houses:
 * errand paths ride a road network derived from the ring plan, houses
 * face their nearest road, and the wander behavior can no longer pin an
 * NPC against a wall forever.
 */

import { describe, expect, it } from "vitest";
import { createNpcController } from "@shared/world-engine/npc-controller";
import { buildAcceptanceTri } from "../tri-worlds";
import { createTownFood, houseDoorstep } from "../food";
import { buildTownRoads, roadRoute, routeLength } from "../town-roads";
import { townPlan, worldPos } from "../zoom";

describe("town streets", () => {
  it("routes ride the network and never cut through a building", async () => {
    const a = await buildAcceptanceTri(42);
    const plan = townPlan(a.tri, "riverton", 7);
    const roads = buildTownRoads(plan);
    const rc = a.tri.cities.find(c => c.key === "riverton")!;
    const center = worldPos(rc.x, rc.y);
    const food = createTownFood(a.tri, { key: "riverton", center, plan }, 7, roads);

    // Rings: plaza edge first, then one road in each inter-ring gap.
    expect(roads.rings[0]).toBe(22);
    expect(roads.rings.length).toBeGreaterThan(3);
    for (let i = 1; i < roads.rings.length; i++) {
      expect(roads.rings[i]).toBeCloseTo(28 + 15 * (i - 1) + 7.5, 6);
    }

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
      for (const p of route) {
        const hit = rects.find(r => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h);
        if (hit) {
          // Detailed failure: this once caught outer-ring houses
          // OVERLAPPING (fixed-angle lot jitter grew with radius).
          throw new Error(`waypoint (${p.x.toFixed(2)},${p.y.toFixed(2)}) of house ${h.index}'s route ` +
            `is inside building (${hit.x.toFixed(2)},${hit.y.toFixed(2)} ${hit.w.toFixed(2)}x${hit.h.toFixed(2)})`);
        }
      }
      sampled++;
    }
    expect(sampled).toBeGreaterThan(10);
  });

  it("houses face their nearest road: cross-street flankers front the street, the rest front their ring", async () => {
    const a = await buildAcceptanceTri(42);
    const plan = townPlan(a.tri, "riverton", 7);
    let flankers = 0;
    for (const h of plan.houses) {
      const cx = h.dx + h.w / 2;
      const cy = h.dy + h.h / 2;
      if (Math.abs(cx) < 13 && Math.abs(cx) <= Math.abs(cy)) {
        // Beside a vertical cross street: door turned toward it.
        expect(h.door).toBe(cx > 0 ? "west" : "east");
        flankers++;
      } else if (Math.abs(cy) < 13 && Math.abs(cy) < Math.abs(cx)) {
        expect(h.door).toBe(cy > 0 ? "north" : "south");
        flankers++;
      } else {
        // Everyone else fronts the ring road on their plaza side.
        expect(h.door).toBe(
          Math.abs(cx) > Math.abs(cy) ? (cx > 0 ? "west" : "east") : (cy > 0 ? "north" : "south"),
        );
      }
      // Doorstep sits outside the footprint on the door edge.
      const d = houseDoorstep({ x: 0, y: 0 }, h);
      expect(d.x > h.dx && d.x < h.dx + h.w && d.y > h.dy && d.y < h.dy + h.h).toBe(false);
    }
    expect(flankers).toBeGreaterThan(4); // the street mouths are lined
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
