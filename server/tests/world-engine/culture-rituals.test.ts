// CULTURE RITUALS: `game.culture.rituals` declares how a town GATHERS — its
// meals, its play, later its songs and dances. Parsed/gated like the dress and
// architecture blocks (unknown fields rejected, bounded arrays, ranged
// numbers), then merged over the kernel defaults BY KEY. The behaviour itself
// lives in rituals.test.ts; this pins the spec gate + resolution.

import { describe, expect, it } from "@jest/globals";
import {
  OPEN_CULTURE,
  parseWorldCultureSpec,
  parseWorldRitualSpec,
  resolveWorldCulture,
} from "@shared/world-engine/culture.js";

const supper = {
  key: "meal",
  calls: [
    { need: "hunger:food", kind: "strong", level: 1 },
    { need: "social", kind: "weak", level: 0.4 },
  ],
  at: ["table"],
  prepare: { category: "meal", per_head: 1 },
  station: { kind: "seat", fixture: "chair" },
  min_heads: 2,
  max_heads: 6,
  gather_s: 45,
  perform_s: 12,
  relieves: ["social"],
  window: { from: 0.7, to: 0.9 },
};

describe("game.culture.rituals — parse + gate", () => {
  it("maps an authored row onto the ritual vocabulary", () => {
    const tpl = parseWorldRitualSpec(supper, "game.culture.rituals[0]");
    expect(tpl).toEqual({
      key: "meal",
      calls: [
        { tplKey: "hunger:food", kind: "strong", level: 1 },
        { tplKey: "social", kind: "weak", level: 0.4 },
      ],
      at: ["table"],
      prepare: { category: "meal", perHead: 1 },
      station: { kind: "seat", fixture: "chair" },
      minHeads: 2,
      maxHeads: 6,
      gatherS: 45,
      performS: 12,
      relieves: ["social"],
      window: { from: 0.7, to: 0.9 },
    });
  });
  it("fills the omitted bounds and timings with defaults", () => {
    const tpl = parseWorldRitualSpec(
      { key: "chat", calls: [{ need: "social", kind: "strong", level: 1 }], at: [], station: { kind: "ring" } },
      "p",
    );
    expect(tpl.minHeads).toBe(1);
    expect(tpl.maxHeads).toBe(4);
    expect(tpl.gatherS).toBe(30);
    expect(tpl.performS).toBe(8);
    expect(tpl.prepare).toBeUndefined();
    expect(tpl.window).toBeUndefined();
  });
  it("accepts a rituals block alongside the other culture blocks", () => {
    const spec = parseWorldCultureSpec({ absolutes: ["fight"], rituals: [supper] }, "game.culture");
    expect(spec.rituals).toHaveLength(1);
    expect(spec.rituals?.[0]?.gatherS).toBe(45);
  });

  it("rejects an unknown field, per-path", () => {
    expect(() => parseWorldRitualSpec({ ...supper, feast: true }, "p")).toThrow(/p\.feast/);
    expect(() => parseWorldRitualSpec({ ...supper, window: { from: 0, until: 1 } }, "p")).toThrow(/p\.window\.until/);
    expect(() => parseWorldRitualSpec({ ...supper, prepare: { category: "meal", each: 1 } }, "p")).toThrow(
      /p\.prepare\.each/,
    );
  });
  it("rejects a call that isn't strong or weak", () => {
    const bad = { ...supper, calls: [{ need: "social", kind: "mild", level: 1 }] };
    expect(() => parseWorldRitualSpec(bad, "p")).toThrow(/p\.calls\[0\]\.kind/);
  });
  it("rejects an empty call list — a ritual nothing can call is a dead row", () => {
    expect(() => parseWorldRitualSpec({ ...supper, calls: [] }, "p")).toThrow(/p\.calls/);
  });
  it("rejects an unknown station kind, and a seat with no fixture", () => {
    expect(() => parseWorldRitualSpec({ ...supper, station: { kind: "perch" } }, "p")).toThrow(/p\.station\.kind/);
    expect(() => parseWorldRitualSpec({ ...supper, station: { kind: "seat" } }, "p")).toThrow(/p\.station\.fixture/);
  });
  it("rejects out-of-range numbers", () => {
    expect(() => parseWorldRitualSpec({ ...supper, window: { from: 0.7, to: 4 } }, "p")).toThrow(/p\.window\.to/);
    expect(() => parseWorldRitualSpec({ ...supper, min_heads: 0 }, "p")).toThrow(/p\.min_heads/);
    expect(() => parseWorldRitualSpec({ ...supper, gather_s: "soon" }, "p")).toThrow(/p\.gather_s/);
  });
  it("rejects a roster that can never fill — max below min", () => {
    expect(() => parseWorldRitualSpec({ ...supper, min_heads: 4, max_heads: 2 }, "p")).toThrow(/p\.max_heads/);
  });
  it("bounds the ritual list", () => {
    const many = Array.from({ length: 17 }, (_, i) => ({ ...supper, key: `r${i}` }));
    expect(() => parseWorldCultureSpec({ rituals: many }, "game.culture")).toThrow(/game\.culture\.rituals/);
  });
});

describe("game.culture.rituals — resolution", () => {
  it("every culture eats: no declaration still resolves the kernel rituals", () => {
    expect(OPEN_CULTURE.rituals.map((r) => r.key)).toEqual(["meal", "play"]);
    expect(resolveWorldCulture(null)).toBe(OPEN_CULTURE);
    expect(resolveWorldCulture({}).rituals.map((r) => r.key)).toEqual(["meal", "play"]);
  });
  it("an authored row merges over the default of the same key", () => {
    const culture = resolveWorldCulture(parseWorldCultureSpec({ rituals: [supper] }, "game.culture"));
    expect(culture.rituals.map((r) => r.key)).toEqual(["meal", "play"]);
    expect(culture.rituals[0]?.window).toEqual({ from: 0.7, to: 0.9 });
    expect(culture.rituals[0]?.minHeads).toBe(2);
    // The untouched default is intact.
    expect(culture.rituals[1]?.station).toEqual({ kind: "ring" });
  });
  it("declaring rituals alone takes the world off the open culture", () => {
    expect(resolveWorldCulture({ rituals: [parseWorldRitualSpec(supper, "p")] })).not.toBe(OPEN_CULTURE);
  });
});
