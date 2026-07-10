// Two-clause CAUSAL glyph layout (causation-and-elements.md §4; the renderer
// split). Pure string logic — no DOM/GL — safe in the default `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  buildCausalSvg,
  contentSlotCount,
  splitCausalGlyph,
  svgDims,
} from "@shared/world-engine/causal-glyph.js";

describe("splitCausalGlyph — split + size-driven orientation", () => {
  it("splits the v1 WHY line and STACKS it (5 symbols > 3)", () => {
    const split = splitCausalGlyph("i_me + sad + because + i_me + have.not + ball");
    expect(split).not.toBeNull();
    expect(split!.effect).toBe("i_me + sad");
    expect(split!.connective).toBe("because");
    expect(split!.cause).toBe("i_me + have.not + ball");
    expect(split!.layout).toBe("stack");
  });

  it("lays a SHORT causal line side by side (2 symbols ≤ 3)", () => {
    const split = splitCausalGlyph("sad + because + cold");
    expect(split!.layout).toBe("row");
    expect(split!.effect).toBe("sad");
    expect(split!.cause).toBe("cold");
  });

  it("stacks at exactly 4 symbols, rows at exactly 3", () => {
    expect(splitCausalGlyph("i_me + cold + because + window + open")!.layout).toBe("stack"); // 2+2=4
    expect(splitCausalGlyph("i_me + sad + because + cold")!.layout).toBe("row"); // 2+1=3
  });

  it("handles every connective, and 'in_order_to' as one token", () => {
    for (const conn of ["because", "therefore", "in_order_to", "when", "until"]) {
      const split = splitCausalGlyph(`a + b + ${conn} + c + d`);
      expect(split).not.toBeNull();
      expect(split!.connective).toBe(conn);
    }
  });

  it("returns null when it isn't a two-clause causal line", () => {
    expect(splitCausalGlyph("i_me + want + ball")).toBeNull(); // no connective
    expect(splitCausalGlyph("because + have.not + ball")).toBeNull(); // level-b: no effect clause
    expect(splitCausalGlyph("i_me + sad + because")).toBeNull(); // no cause clause
    expect(splitCausalGlyph("")).toBeNull();
  });

  it("joins ('in'/'to') don't count toward the size threshold", () => {
    // "put + ball + in + box" is 3 content symbols (in is a join), not 4.
    expect(contentSlotCount("put + ball + in + box")).toBe(3);
    // effect 3 + cause 1 = 4 → stack (the join didn't inflate the effect to 4+).
    expect(splitCausalGlyph("put + ball + in + box + in_order_to + happy")!.layout).toBe("stack");
  });
});

describe("buildCausalSvg — composes one parent SVG per orientation", () => {
  const clause = (id: string, w: number, h: number) => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect id="${id}"/></svg>`,
    w,
    h,
  });

  it("stack: portrait parent taller than either clause, both embedded + label", () => {
    const out = buildCausalSvg(clause("eff", 300, 200), clause("cau", 400, 200), "because", "stack", false);
    const dims = svgDims(out);
    expect(dims.h).toBeGreaterThan(400); // 200 + connector + 200
    expect(dims.w).toBeGreaterThanOrEqual(400); // widest clause
    expect(out).toContain('id="eff"');
    expect(out).toContain('id="cau"');
    expect(out).toContain(">because<");
  });

  it("row: landscape parent wider than the sum, label expands 'in order to'", () => {
    const out = buildCausalSvg(clause("eff", 200, 200), clause("cau", 200, 200), "in_order_to", "row", false);
    const dims = svgDims(out);
    expect(dims.w).toBeGreaterThan(400); // 200 + connector + 200
    expect(dims.h).toBe(200);
    expect(out).toContain(">in order to<");
  });

  it("row RTL swaps clause order (cause first)", () => {
    const out = buildCausalSvg(clause("eff", 200, 200), clause("cau", 200, 200), "because", "row", true);
    // The cause clause is placed at x=0 (first) in RTL.
    expect(out).toMatch(/x="0"[^>]*><rect id="cau"/);
  });
});
