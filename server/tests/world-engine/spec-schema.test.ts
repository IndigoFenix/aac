/**
 * Unit tests for the declarative field descriptor (spec-schema.ts) and the
 * scope registry (scope-registry.ts) — the single source of truth the
 * per-scope `world` gates now delegate to.
 */
import { describe, it, expect } from "@jest/globals";
import {
  validateFields,
  type GroupSpec,
} from "@shared/world-engine/kernel/spec-schema.js";
import {
  SCOPE_SPECS,
  SCOPE_SPEC_LIST,
  parseWorldForScope,
} from "@shared/world-engine/scope-registry.js";
import { GAME_SCOPES } from "@shared/world-engine/kernel/manifest.js";

describe("validateFields — the generic descriptor gate", () => {
  it("rejects a non-object with the group's objectMessage", () => {
    const g: GroupSpec = { objectMessage: "expected an object (the widget)", fields: [] };
    expect(() => validateFields(5, g, "w")).toThrow("w: expected an object (the widget)");
  });

  it("rejects unknown fields path-exact, listing the allowed keys", () => {
    const g: GroupSpec = { fields: [{ key: "a", kind: "number" }, { key: "b", kind: "number" }] };
    expect(() => validateFields({ c: 1 }, g, "w")).toThrow("w.c: unknown field (allowed: a, b)");
  });

  it("number: enforces range with the legacy (min..max) format", () => {
    const g: GroupSpec = { fields: [{ key: "n", kind: "number", min: 0, max: 3 }] };
    expect(() => validateFields({ n: "x" }, g, "w")).toThrow("w.n: must be a number (0..3)");
    expect(() => validateFields({ n: 9 }, g, "w")).toThrow("w.n: out of range (0..3)");
    expect(validateFields({ n: 2 }, g, "w")).toEqual({ n: 2 });
  });

  it("int rejects fractions; floor coerces them", () => {
    const gi: GroupSpec = { fields: [{ key: "n", kind: "int", min: 0, max: 10 }] };
    expect(() => validateFields({ n: 1.5 }, gi, "w")).toThrow("w.n: must be an integer");
    const gf: GroupSpec = { fields: [{ key: "n", kind: "floor", min: 0, max: 10 }] };
    expect(validateFields({ n: 1.9 }, gf, "w")).toEqual({ n: 1 });
  });

  it("enum / boolean / string / literal each emit their message", () => {
    expect(() => validateFields({ e: "z" },
      { fields: [{ key: "e", kind: "enum", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }] }, "w"))
      .toThrow("w.e: must be one of: a, b");
    expect(() => validateFields({ b: 1 }, { fields: [{ key: "b", kind: "boolean" }] }, "w"))
      .toThrow("w.b: must be true or false");
    expect(() => validateFields({ s: "" }, { fields: [{ key: "s", kind: "string" }] }, "w"))
      .toThrow("w.s: must be a non-empty string");
    expect(() => validateFields({ k: "no" },
      { fields: [{ key: "k", kind: "literal", constant: "yes", invalidMessage: "must be yes" }] }, "w"))
      .toThrow("w.k: must be yes");
  });

  it("required missing throws its message; optional-with-default fills in", () => {
    const g: GroupSpec = {
      fields: [
        { key: "req", kind: "number", required: true, requiredMessage: "required — needed" },
        { key: "opt", kind: "number", default: 7 },
      ],
    };
    expect(() => validateFields({}, g, "w")).toThrow("w.req: required — needed");
    expect(validateFields({ req: 1 }, g, "w")).toEqual({ req: 1, opt: 7 });
  });

  it("absent optional with no default stays absent (omitted, not defaulted)", () => {
    const g: GroupSpec = { fields: [{ key: "a", kind: "number" }, { key: "b", kind: "number", default: 2 }] };
    expect(validateFields({}, g, "w")).toEqual({ b: 2 });
  });

  it("nested object recurses and applies inner defaults; object default is cloned per parse", () => {
    const g: GroupSpec = {
      fields: [{
        key: "size", kind: "object", default: { cols: 96, rows: 64 },
        fields: [{ key: "cols", kind: "int", default: 96 }, { key: "rows", kind: "int", default: 64 }],
      }],
    };
    expect(validateFields({ size: { cols: 10 } }, g, "w")).toEqual({ size: { cols: 10, rows: 64 } });
    const a = validateFields({}, g, "w");
    const b = validateFields({}, g, "w");
    expect(a).toEqual({ size: { cols: 96, rows: 64 } });
    expect((a as { size: object }).size).not.toBe((b as { size: object }).size); // fresh clone
  });

  it("list validates each element against its item spec and caps length", () => {
    const g: GroupSpec = {
      fields: [{ key: "likes", kind: "list", maxItems: 2, item: { key: "x", kind: "string" } }],
    };
    expect(validateFields({ likes: ["a", "b"] }, g, "w")).toEqual({ likes: ["a", "b"] });
    expect(() => validateFields({ likes: ["a", ""] }, g, "w")).toThrow("w.likes[1]: must be a non-empty string");
    expect(() => validateFields({ likes: ["a", "b", "c"] }, g, "w")).toThrow("w.likes: too many entries (max 2)");
    expect(() => validateFields({ likes: "a" }, g, "w")).toThrow("w.likes: expected an array");
  });

  it("custom field delegates deep validation to its validator", () => {
    const g: GroupSpec = {
      fields: [{ key: "map", kind: "custom", validate: (raw, p) => {
        if (typeof raw !== "object" || raw === null) throw new Error(`${p}: expected a map`);
        return { ...(raw as object), seen: true };
      } }],
    };
    expect(validateFields({ map: { a: 1 } }, g, "w")).toEqual({ map: { a: 1, seen: true } });
    expect(() => validateFields({ map: 3 }, g, "w")).toThrow("w.map: expected a map");
  });
});

describe("scope-registry — one entry per rung of the ladder", () => {
  it("covers every GAME_SCOPE, and the list is in ladder order", () => {
    for (const s of GAME_SCOPES) expect(SCOPE_SPECS[s]?.scope).toBe(s);
    expect(SCOPE_SPEC_LIST.map((e) => e.scope)).toEqual([...GAME_SCOPES]);
  });

  it("parseWorldForScope validates against the owning scope", () => {
    // town requires a seed (its descriptor marks it required).
    expect(() => parseWorldForScope("town", {}, "w")).toThrow("w.seed: required — one seed reproduces the whole town");
    expect(parseWorldForScope("town", { seed: 7 }, "w")).toEqual({ seed: 7 });
    // structure is the newly-promoted gate: unknown fields now reject.
    expect(() => parseWorldForScope("structure", { bogus: 1 }, "w")).toThrow("w.bogus: unknown field");
    expect(parseWorldForScope("structure", {}, "w")).toEqual({ seed: 1, questCount: 0, wilderness: false, side: 240 });
  });
});
