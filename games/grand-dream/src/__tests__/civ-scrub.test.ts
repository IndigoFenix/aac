/**
 * Civ-scrub — the civilization-history scrubber's pure interpolation core
 * (civilization-emergence.md §3a, step 5). Continuous quantities lerp
 * between straddling keyframes; discrete facts (roster membership,
 * majority civ, dead) snap to the NEARER frame; the eased view converges
 * exactly onto the target (transients.ts discipline).
 */

import { describe, it, expect } from "vitest";
import { civTargetAt, createCivScrubber } from "../civ-scrub";
import type { CivHistory } from "../tri";

/** Three frames: a lone city A; B founds (with the road) by day 10;
 *  by day 20 B is a ruin and the border burned. */
const history: CivHistory = {
  cities: [
    { key: "a", name: "Aton", x: 1, y: 1 },
    { key: "b", name: "Bton", x: 5, y: 5 },
  ],
  edges: [{ a: 0, b: 1 }],
  frames: [
    { day: 0, pop: [1000], civ: ["m_x"], dead: [false], edgeCount: 0, road: [], hostility: [] },
    { day: 10, pop: [2000, 500], civ: ["m_x", "m_y"], dead: [false, false], edgeCount: 1, road: [0.2], hostility: [0] },
    { day: 20, pop: [3000, 0], civ: ["m_x", ""], dead: [false, true], edgeCount: 1, road: [0.4], hostility: [1] },
  ],
};

describe("civTargetAt: pure interpolation", () => {
  it("lands exactly on keyframes at their positions", () => {
    const start = civTargetAt(history, 0);
    expect(start.day).toBe(0);
    expect(start.cities[0]).toEqual({ present: true, pop: 1000, civ: "m_x", dead: false });
    expect(start.cities[1].present).toBe(false);
    expect(start.edges[0].present).toBe(false);

    const mid = civTargetAt(history, 0.5); // exactly frame 1
    expect(mid.day).toBe(10);
    expect(mid.cities[1]).toEqual({ present: true, pop: 500, civ: "m_y", dead: false });
    expect(mid.edges[0]).toEqual({ present: true, road: 0.2, hostility: 0 });

    const head = civTargetAt(history, 1);
    expect(head.day).toBe(20);
    expect(head.cities[0].pop).toBe(3000);
    expect(head.cities[1].dead).toBe(true);
    expect(head.edges[0].hostility).toBe(1);
  });

  it("lerps continuous values, snaps discrete facts to the nearer frame", () => {
    // Halfway through frames 0→1 (t = 0.5 rounds to the LATER frame).
    const q1 = civTargetAt(history, 0.25);
    expect(q1.day).toBe(5);
    expect(q1.cities[0].pop).toBe(1500); // lerp
    expect(q1.cities[1].present).toBe(true); // discrete: nearer = frame 1
    expect(q1.cities[1].pop).toBe(500); // present in one frame only — its value
    expect(q1.edges[0].present).toBe(true);
    expect(q1.edges[0].road).toBe(0.2);

    // Halfway through frames 1→2: B is already a ruin (nearer = frame 2)
    // while its population is still draining through the lerp.
    const q3 = civTargetAt(history, 0.75);
    expect(q3.day).toBe(15);
    expect(q3.cities[1].dead).toBe(true);
    expect(q3.cities[1].pop).toBe(250);
    expect(q3.edges[0].road).toBeCloseTo(0.3, 9);
    expect(q3.edges[0].hostility).toBeCloseTo(0.5, 9);

    // Just before the midpoint the discrete facts still read the earlier
    // frame: B alive, at its lerped population.
    const q3early = civTargetAt(history, 0.7);
    expect(q3early.cities[1].dead).toBe(false);
    expect(q3early.cities[1].civ).toBe("m_y");
  });

  it("the eased view converges exactly onto the target", () => {
    const scrub = createCivScrubber(history);
    expect(scrub.pos()).toBe(1); // primed at the head, like geo-scrub
    scrub.setPos(0);
    let view = scrub.view(0);
    for (let t = 0.1; t < 6; t += 0.1) view = scrub.view(t);
    expect(view.day).toBe(0);
    expect(view.cities[0].pop).toBe(1000); // eased, then snapped exact
    expect(view.cities[1].present).toBe(false);
    expect(view.cities[1].pop).toBe(0);

    // Retarget mid-morph: free, and it still lands exactly.
    scrub.setPos(1);
    for (let t = 6; t < 12; t += 0.1) view = scrub.view(t);
    expect(view.cities[0].pop).toBe(3000);
    expect(view.edges[0].hostility).toBe(1);
  });
});
