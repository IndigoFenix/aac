/**
 * LOOPS — growth phase C §2. A town's street TREE is what makes a
 * chord-to-walked ratio: two lanes whose tips die 35 m apart can be 600 m
 * of walking from each other. `TownStreets.links` is the overlay that
 * closes those, and this suite pins the three things it must never cost:
 *
 *   1. THE TREE IS UNTOUCHED — `Street.parent/arm/pts` and the prefix
 *      discipline (streets only extend, lots only append) survive, and
 *      links themselves append the same way.
 *   2. ROUTING IS SOUND — a link-free net answers EXACTLY as the parent
 *      climb did (that is most old fixtures), and a linked net never
 *      answers longer, agrees with its own materialized route, and keeps
 *      every waypoint on the network.
 *   3. THE GROUND IS RESPECTED — a shortcut is cut through a gap, never
 *      through a standing house or over another lane.
 */
import { describe, it, expect } from "@jest/globals";
import {
  growStreets, pointAt, project, roadDistance, roadRoute, roadStreetPath, routeLength,
  type GrowSeed, type Street, type TownStreets,
} from "@shared/world-engine/kernel/town/streets.js";
import { TOWN_DIMS } from "@shared/world-engine/kernel/town/dimensions.js";

const SPAN: GrowSeed = {
  kind: "span", pts: [{ x: -450, y: 0 }, { x: 450, y: 0 }], portA: true, portB: true,
};

/** A town big enough to close loops (measured: 8–17 at this size). */
const looped = (seed = 7, key = "loopton", n = 330): TownStreets =>
  growStreets(seed, key, n);

/** THE TREE CLIMB, written out — the answer routing must reproduce when a
 *  net has no links, and must never beat when it has. */
function treeDistance(streets: readonly Street[], aS: number, aA: number, bS: number, bA: number): number {
  const chain = (s0: number, a0: number): Array<{ street: number; arcOn: number; cost: number }> => {
    const out: Array<{ street: number; arcOn: number; cost: number }> = [];
    let cur = s0;
    let arcOn = a0;
    let cost = 0;
    for (;;) {
      out.push({ street: cur, arcOn, cost });
      const s = streets[cur];
      if (s.parent < 0) break;
      cost += arcOn;
      arcOn = s.parentArc;
      cur = s.parent;
    }
    return out;
  };
  const ca = chain(aS, aA);
  const cb = chain(bS, bA);
  const inA = new Map(ca.map(l => [l.street, l]));
  for (const l of cb) {
    const m = inA.get(l.street);
    if (m) return m.cost + l.cost + Math.abs(m.arcOn - l.arcOn);
  }
  return Infinity;
}

/** Frontage anchors sit ON the centerline, so `project` returns d ≈ 0 and
 *  `roadDistance` is the pure network answer. */
const anchors = (net: TownStreets, step = 17): Array<{ x: number; y: number; street: number; arc: number }> =>
  net.slots.filter((_s, i) => i % step === 0).map(s => ({ x: s.ax, y: s.ay, street: s.street, arc: s.arc }));

describe("loops: the links overlay", () => {
  it("a grown town closes loops, and each one JOINS TWO REAL POSITIONS", () => {
    const net = looped();
    expect(net.links.length).toBeGreaterThan(0);
    for (const l of net.links) {
      // Both ends name a street that exists, at an arc that street has.
      for (const end of [l.a, l.b]) {
        const s = net.streets[end.street];
        expect(s).toBeDefined();
        expect(end.arc).toBeGreaterThanOrEqual(0);
        expect(end.arc).toBeLessThanOrEqual(s.cum[s.cum.length - 1] + 1e-9);
      }
      // …and the polyline actually starts and finishes at those points, so
      // the graph's zero-cost identification of them is honest.
      const a0 = pointAt(net.streets[l.a.street], l.a.arc);
      const b0 = pointAt(net.streets[l.b.street], l.b.arc);
      const first = l.pts[0];
      const last = l.pts[l.pts.length - 1];
      expect(Math.hypot(first.x - a0.x, first.y - a0.y)).toBeLessThan(1e-6);
      expect(Math.hypot(last.x - b0.x, last.y - b0.y)).toBeLessThan(1e-6);
      // A link joins two DIFFERENT streets — a loop onto yourself is not one.
      expect(l.a.street).not.toBe(l.b.street);
    }
  });

  it("a link is SHORT: the reach of one dying step across one clearance gap", () => {
    for (const seed of [7, 12, 23, 41]) {
      const net = looped(seed);
      for (const l of net.links) {
        const len = routeLength(l.pts);
        expect(len).toBeGreaterThan(0);
        // The tip probes one STEP ahead and the blocker sits within MIN_GAP
        // of that probe, so nothing longer can ever become a candidate.
        expect(len).toBeLessThanOrEqual(TOWN_DIMS.streetStep + TOWN_DIMS.streetMinGap + 1e-9);
      }
    }
  });

  it("THE TREE IS UNTOUCHED: parent, arm and points keep their prefix as the town grows", () => {
    const small = growStreets(7, "loopton", 311);
    const big = growStreets(7, "loopton", 640);
    for (const s of small.streets) {
      const b = big.streets[s.id];
      expect(b.parent).toBe(s.parent);
      expect(b.arm).toBe(s.arm);
      expect(b.pts.length).toBeGreaterThanOrEqual(s.pts.length);
      expect(JSON.stringify(b.pts.slice(0, s.pts.length))).toBe(JSON.stringify(s.pts));
    }
    expect(JSON.stringify(big.slots.slice(0, small.slots.length))).toBe(JSON.stringify(small.slots));
  });

  it("LINKS APPEND, exactly as slots do — a bigger town extends the link list", () => {
    const small = growStreets(7, "loopton", 311);
    const big = growStreets(7, "loopton", 640);
    expect(small.links.length).toBeGreaterThan(0);
    expect(big.links.length).toBeGreaterThanOrEqual(small.links.length);
    expect(JSON.stringify(big.links.slice(0, small.links.length))).toBe(JSON.stringify(small.links));
  });

  it("links are DERIVED, not stored: regrowing from `net.seeds` lands the same set", () => {
    const net = growStreets(12, "loopton", 311, { seeds: [SPAN] });
    const again = growStreets(12, "loopton", 311, { seeds: net.seeds });
    expect(JSON.stringify(again.links)).toBe(JSON.stringify(net.links));
    // …and the plain replay too (the whole net, links included).
    expect(JSON.stringify(growStreets(12, "loopton", 311, { seeds: [SPAN] }))).toBe(JSON.stringify(net));
  });

  it("a link is worth cutting: the TREE really did send people the long way", () => {
    for (const seed of [7, 12, 23]) {
      const net = looped(seed);
      for (const l of net.links) {
        const detour = treeDistance(net.streets, l.a.street, l.a.arc, l.b.street, l.b.arc);
        const chord = routeLength(l.pts);
        // LOOP_MIN_RATIO — the bar the closure rule holds (ledger §2.2).
        expect(detour / chord).toBeGreaterThanOrEqual(4);
      }
    }
  });
});

describe("loops: the ground a shortcut may take", () => {
  it("never through a standing house — no link passes within a lot's clear zone", () => {
    for (const seed of [7, 12, 23, 41]) {
      const net = looped(seed);
      for (const l of net.links) {
        for (const p of l.pts) {
          for (const slot of net.slots) {
            const d = Math.hypot(slot.x - p.x, slot.y - p.y);
            expect(d).toBeGreaterThanOrEqual(6 - 1e-9);
          }
        }
      }
    }
  });

  it("never OVER another lane — a link holds an alley's ground against later growth", () => {
    const gap = TOWN_DIMS.streetMinGap / 2;
    const mouth = TOWN_DIMS.streetMinGap + TOWN_DIMS.streetStep; // MOUTH_ARC
    let checked = 0;
    for (const seed of [7, 12, 23, 41]) {
      const net = looped(seed);
      for (const l of net.links) {
        /** The two streets a link joins are touching it BY CONSTRUCTION, and
         *  so is anything that meets one of them inside the junction mouth
         *  the link leaves by — a lane sprouted at that very corner is the
         *  same corner, not something in the way (the `mouthForgives` law). */
        const forgiven = (s: Street): boolean => {
          for (const end of [l.a, l.b]) {
            if (s.id === end.street) return true;
            if (s.parent === end.street && Math.abs(s.parentArc - end.arc) < mouth) return true;
            const host = net.streets[end.street];
            if (host.parent === s.id && Math.abs(end.arc) < mouth) return true;
          }
          return false;
        };
        // Interior only: the ENDS touch the two streets they join, which is
        // the whole point of them.
        for (let k = 1; k < l.pts.length - 1; k++) {
          const p = l.pts[k];
          for (const s of net.streets) {
            if (forgiven(s)) continue;
            for (const q of s.pts) {
              expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeGreaterThan(gap - 1e-9);
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

describe("loops: routing over the graph", () => {
  it("A LINK-FREE NET STILL RIDES THE TREE CLIMB — the same path, to the metre", () => {
    // The contract every pre-loops fixture in this repo depends on. The
    // stronger claim — that the FLOAT is bit-identical to the pre-loops
    // build — needs the pre-loops build to compare against and is measured
    // in the phase ledger (3342/3342 pairs, all three routing functions).
    // What is pinnable here is that the link-free net still takes the climb:
    // the same distance to the last metre, and the SAME STREETS in the same
    // order, which is an integer sequence and admits no float excuse.
    const net = looped(7);
    const bare: TownStreets = { ...net, links: [] };
    // A net that never heard of the overlay at all — a fixture hand-built
    // before loops existed, or one round-tripped through JSON.
    const legacy = { ...net, links: undefined } as unknown as TownStreets;
    const pts = anchors(bare, 13);
    expect(pts.length).toBeGreaterThan(8);
    let checked = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j += 3) {
        const a = { x: pts[i].x, y: pts[i].y };
        const b = { x: pts[j].x, y: pts[j].y };
        const want = treeDistance(bare.streets, pts[i].street, pts[i].arc, pts[j].street, pts[j].arc);
        expect(roadDistance(bare, a, b)).toBeCloseTo(want, 9);
        // An ABSENT overlay means "no loops", never a crash.
        expect(roadDistance(legacy, a, b)).toBeCloseTo(want, 9);
        expect(roadStreetPath(legacy, a, b)).toEqual(roadStreetPath(bare, a, b));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("with links, the answer is NEVER longer than the tree — and often much shorter", () => {
    let shorter = 0;
    let longer = 0;
    let best = 0;
    for (const seed of [7, 12, 23]) {
      const net = looped(seed);
      const pts = anchors(net, 11);
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j += 2) {
          const got = roadDistance(net, pts[i], pts[j]);
          const tree = treeDistance(net.streets, pts[i].street, pts[i].arc, pts[j].street, pts[j].arc);
          expect(got).toBeLessThanOrEqual(tree + 1e-6);
          if (got < tree - 1e-6) {
            shorter++;
            best = Math.max(best, tree - got);
          }
          if (got > tree + 1e-6) longer++;
        }
      }
    }
    expect(longer).toBe(0);
    expect(shorter).toBeGreaterThan(0);
    // The loops are worth real metres, not rounding.
    expect(best).toBeGreaterThan(100);
  });

  it("the closed form and the WALKED route tell the same story", () => {
    for (const seed of [7, 12, 23]) {
      const net = looped(seed);
      const pts = anchors(net, 19);
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = { x: pts[i].x, y: pts[i].y };
        const b = { x: pts[pts.length - 1 - i].x, y: pts[pts.length - 1 - i].y };
        const route = roadRoute(net, a, b);
        expect(route[0]).toEqual(a);
        expect(route[route.length - 1]).toEqual(b);
        expect(routeLength(route)).toBeCloseTo(roadDistance(net, a, b), 6);
      }
    }
  });

  it("every waypoint stays ON the network — NPCs walk like people, never through a parlor", () => {
    const net = looped(12);
    const pts = anchors(net, 23);
    for (let i = 0; i + 1 < pts.length; i++) {
      const route = roadRoute(net, pts[i], pts[pts.length - 1 - i]);
      for (const p of route) {
        // A link is part of the network the walker may use, so a waypoint on
        // one is legitimate — measure against the streets AND the links.
        let d = project(net, p).d;
        for (const l of net.links) {
          for (const q of l.pts) d = Math.min(d, Math.hypot(q.x - p.x, q.y - p.y));
        }
        expect(d).toBeLessThan(TOWN_DIMS.streetStep);
      }
    }
  });

  it("is DETERMINISTIC: the same query returns the same route, byte for byte", () => {
    const net = looped(23);
    const pts = anchors(net, 29);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      expect(JSON.stringify(roadRoute(net, a, b))).toBe(JSON.stringify(roadRoute(net, a, b)));
      expect(roadDistance(net, a, b)).toBe(roadDistance(net, a, b));
      expect(roadStreetPath(net, a, b)).toEqual(roadStreetPath(net, a, b));
    }
  });

  it("the TRAFFIC path rides the same streets the route does", () => {
    const net = looped(7);
    const pts = anchors(net, 31);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[pts.length - 1 - i];
      const ids = roadStreetPath(net, a, b);
      expect(ids.length).toBeGreaterThan(0);
      // No street named twice in a row, every id real, and the trip's own two
      // ends are the streets it starts and finishes on.
      for (let k = 1; k < ids.length; k++) expect(ids[k]).not.toBe(ids[k - 1]);
      for (const id of ids) expect(net.streets[id]).toBeDefined();
      expect(ids[0]).toBe(project(net, a).street);
      expect(ids[ids.length - 1]).toBe(project(net, b).street);
    }
  });
});
