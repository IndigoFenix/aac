// POSSESSION (spirit ↔ avatar switching, city-expansion step 0): the pure
// guarded state machine (possession.ts) the quest host executes swaps
// through. Pins: spirit-only, one body at a time, existence gate, the
// apply-seam call order, and clean toggling (possess → dismiss → possess).

import { describe, it, expect } from "@jest/globals";
import { createPossession } from "@shared/world-engine/interaction/quest/possession.js";

function harness(opts?: { spirit?: boolean; creatures?: string[] }) {
  const applied: Array<{ cid: string | null; prev: string | null }> = [];
  const creatures = new Set(opts?.creatures ?? ["wild_0", "wild_1"]);
  let spirit = opts?.spirit ?? true;
  const p = createPossession({
    isSpirit: () => spirit,
    creatureExists: (cid) => creatures.has(cid),
    apply: (cid, prev) => applied.push({ cid, prev }),
  });
  return { p, applied, setSpirit: (v: boolean) => (spirit = v) };
}

describe("possession state machine", () => {
  it("possesses a live creature in spirit mode (apply fires after the transition)", () => {
    const { p, applied } = harness();
    const res = p.possess("wild_0");
    expect(res).toEqual({ ok: true });
    expect(p.creatureId).toBe("wild_0");
    expect(applied).toEqual([{ cid: "wild_0", prev: null }]);
  });

  it("refuses outside spirit mode", () => {
    const { p, applied } = harness({ spirit: false });
    expect(p.possess("wild_0")).toEqual({ ok: false, reason: "not-spirit" });
    expect(p.creatureId).toBeNull();
    expect(applied).toEqual([]);
  });

  it("refuses an unknown creature", () => {
    const { p } = harness();
    expect(p.possess("ghost")).toEqual({ ok: false, reason: "no-creature" });
    expect(p.creatureId).toBeNull();
  });

  it("one body at a time — a second possess is refused, the first stands", () => {
    const { p, applied } = harness();
    p.possess("wild_0");
    expect(p.possess("wild_1")).toEqual({ ok: false, reason: "already-possessed" });
    expect(p.creatureId).toBe("wild_0");
    expect(applied).toHaveLength(1);
  });

  it("dismiss returns to spirit and reports the body being left", () => {
    const { p, applied } = harness();
    p.possess("wild_0");
    const res = p.dismiss();
    expect(res).toEqual({ ok: true });
    expect(p.creatureId).toBeNull();
    expect(applied[1]).toEqual({ cid: null, prev: "wild_0" });
  });

  it("dismiss with nothing possessed is refused", () => {
    const { p } = harness();
    expect(p.dismiss()).toEqual({ ok: false, reason: "not-possessed" });
  });

  it("toggles cleanly: possess → dismiss → possess another", () => {
    const { p, applied } = harness();
    expect(p.possess("wild_0").ok).toBe(true);
    expect(p.dismiss().ok).toBe(true);
    expect(p.possess("wild_1").ok).toBe(true);
    expect(p.creatureId).toBe("wild_1");
    expect(applied.map((a) => a.cid)).toEqual(["wild_0", null, "wild_1"]);
  });

  it("a session that stopped being spirit (e.g. a dollhouse) cannot possess, but can still dismiss", () => {
    const { p, setSpirit } = harness();
    p.possess("wild_0");
    setSpirit(false);
    expect(p.possess("wild_1")).toEqual({ ok: false, reason: "already-possessed" });
    expect(p.dismiss()).toEqual({ ok: true });
    expect(p.possess("wild_1")).toEqual({ ok: false, reason: "not-spirit" });
  });
});
