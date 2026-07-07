/**
 * The generic transient core (transients.ts) — the §5b foundation shared
 * by fields (substrate presenter), continuous quantities (eased values),
 * and discrete births/deaths (reveal tracker). What must hold everywhere:
 * priming (what existed at first sight never animates), retarget safety
 * (a change mid-transient bends, never resets), and exact convergence.
 */
import { describe, it, expect } from "vitest";
import { easeToward, createEasedValues, createRevealTracker, smooth } from "../transients";

describe("easeToward", () => {
  it("converges, snaps exactly, and retargets from wherever it is", () => {
    let v = 0;
    for (let i = 0; i < 200; i++) v = easeToward(v, 10, 0.1, 0.5);
    expect(v).toBe(10); // snapped, not merely close

    // Retarget mid-ease: no reset — the value bends from its current spot.
    v = 0;
    for (let i = 0; i < 5; i++) v = easeToward(v, 10, 0.1, 0.5);
    const mid = v;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(10);
    v = easeToward(v, 2, 0.1, 0.5); // target drops below the current value
    expect(v).toBeLessThan(mid);
    expect(v).toBeGreaterThan(2);
  });

  it("uses the rising tau up and the falling tau down", () => {
    const up = easeToward(0, 10, 0.1, 0.1, 10);
    const down = 10 - easeToward(10, 0, 0.1, 0.1, 10);
    expect(up).toBeGreaterThan(down); // fast in, slow out
  });
});

describe("createEasedValues", () => {
  it("primes new keys at their target and eases changes", () => {
    const ev = createEasedValues(0.5);
    ev.frame(0);
    expect(ev.value("a", 7)).toBe(7); // first sight: no animation
    ev.frame(0.1);
    const v = ev.value("a", 14); // the target jumped
    expect(v).toBeGreaterThan(7);
    expect(v).toBeLessThan(14);
    let last = v;
    for (let t = 0.2; t < 10; t += 0.1) {
      ev.frame(t);
      last = ev.value("a", 14);
    }
    expect(last).toBe(14);
  });

  it("forgets keys nobody asks about, and re-primes them on return", () => {
    const ev = createEasedValues(0.5);
    ev.frame(0);
    ev.value("a", 5);
    ev.frame(0.1); // a not asked
    ev.frame(0.2); // a dropped
    expect(ev.value("a", 50)).toBe(50); // fresh key again: primes at target
  });
});

describe("createRevealTracker", () => {
  it("primes the first frame; later births grow 0 → 1 over inSec", () => {
    const rt = createRevealTracker(2, 1);
    rt.frame(0, ["old"]);
    expect(rt.phase("old")).toBe(1); // existed at first sight: no animation

    rt.frame(1, ["old", "young"]); // born at t=1
    expect(rt.phase("young")).toBe(0);
    rt.frame(2, ["old", "young"]);
    expect(rt.phase("young")).toBeCloseTo(0.5);
    rt.frame(3.5, ["old", "young"]);
    expect(rt.phase("young")).toBe(1);
    expect(rt.phase("never")).toBe(0); // unknown keys are unrevealed
  });

  it("removed keys fade out via exiting(), then drop off", () => {
    const rt = createRevealTracker(1, 2);
    rt.frame(0, ["a"]);
    rt.frame(1, []); // a removed at t=1, fading from phase 1
    let ex = rt.exiting();
    expect(ex).toHaveLength(1);
    expect(ex[0].key).toBe("a");
    expect(ex[0].phase).toBe(1);
    rt.frame(2, []);
    ex = rt.exiting();
    expect(ex[0].phase).toBeCloseTo(0.5);
    rt.frame(4, []);
    expect(rt.exiting()).toHaveLength(0); // fully faded → forgotten
  });

  it("a key re-born mid-fade resumes from its visible phase (retarget safety)", () => {
    const rt = createRevealTracker(1, 2);
    rt.frame(0, ["a"]);
    rt.frame(1, []); // fading: phase 1 → 0 over 2 s
    rt.frame(2, ["a"]); // re-born halfway through the fade (visible ≈ 0.5)
    expect(rt.phase("a")).toBeCloseTo(0.5); // resumes, no pop to 0
    expect(rt.exiting()).toHaveLength(0);
    rt.frame(2.6, ["a"]);
    expect(rt.phase("a")).toBe(1); // finishes growing from there
  });
});

describe("smooth", () => {
  it("is a clamped ease curve through (0,0) and (1,1)", () => {
    expect(smooth(-1)).toBe(0);
    expect(smooth(0)).toBe(0);
    expect(smooth(0.5)).toBeCloseTo(0.5);
    expect(smooth(1)).toBe(1);
    expect(smooth(2)).toBe(1);
    expect(smooth(0.25)).toBeLessThan(0.25); // soft start
    expect(smooth(0.75)).toBeGreaterThan(0.75); // soft end
  });
});
