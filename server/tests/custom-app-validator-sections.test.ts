/**
 * Validator tests for the section/visibility/gridless features added to
 * GameDefinition. Focuses on the rules that don't fall out of plain Zod
 * field validation (cross-field gating around `size` + `showGrid`).
 */

import { describe, it, expect } from "@jest/globals";
import type { GameDefinition } from "../../shared/custom-app-types.js";
import { validateCustomAppDefinition } from "../../shared/custom-app-validator.js";

function baseDef(overrides: Partial<GameDefinition> = {}): GameDefinition {
  return {
    type: "game",
    label: "T",
    classes: [],
    buttons: [],
    rooms: [{ id: "r1", size: [4, 4] }],
    startRoom: "r1",
    ...overrides,
  };
}

describe("custom-app validator — sections + visibility", () => {
  it("accepts buttons with section/row/col/spans", () => {
    const def = baseDef({
      buttons: [
        {
          id: "b1",
          effects: [{ type: "endTurn" }],
          section: "after",
          row: 1,
          col: 0,
          rowSpan: 2,
          colSpan: 1,
        },
      ],
    });
    const res = validateCustomAppDefinition(def);
    expect(res.ok).toBe(true);
  });

  it("rejects unknown section value", () => {
    const def = baseDef({
      buttons: [
        // @ts-expect-error — intentionally invalid
        { id: "b1", effects: [{ type: "endTurn" }], section: "middle" },
      ],
    });
    const res = validateCustomAppDefinition(def);
    expect(res.ok).toBe(false);
  });

  it("requires size when showGrid is not false", () => {
    const def = baseDef({
      rooms: [{ id: "r1" }], // no size, no showGrid -> grid is shown by default
    });
    const res = validateCustomAppDefinition(def);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes("must define `size`"))).toBe(true);
    }
  });

  it("allows omitting size when showGrid is false", () => {
    const def = baseDef({
      rooms: [{ id: "r1", showGrid: false }],
    });
    const res = validateCustomAppDefinition(def);
    expect(res.ok).toBe(true);
  });

  it("rejects entities/tiles when room has no size", () => {
    const def = baseDef({
      rooms: [
        {
          id: "r1",
          showGrid: false,
          entities: [{ classId: "c1", position: [0, 0] }],
        },
      ],
      classes: [{ id: "c1" }],
    });
    const res = validateCustomAppDefinition(def);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes("tiles/entities"))).toBe(true);
    }
  });

  it("accepts visibility flags", () => {
    const def = baseDef({
      rooms: [
        {
          id: "r1",
          showGrid: false,
          showBefore: true,
          showAfter: false,
        },
      ],
    });
    const res = validateCustomAppDefinition(def);
    expect(res.ok).toBe(true);
  });
});
