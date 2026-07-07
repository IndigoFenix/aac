// Validation + rate-limit guards for the app-ai/select endpoint. Imports the
// pure sibling only (no @google/genai / credit-ledger), so it runs without the
// LLM. The LLM call itself (selectFromOptions) is not unit-tested — like
// interpretationService, it hits @google/genai directly.

import {
  normalizeSelectRequest,
  allowAppAiSelect,
  MAX_OPTIONS,
  MAX_LABEL,
  MAX_PER_WINDOW,
} from "../services/appAiSelect-validate";

describe("normalizeSelectRequest", () => {
  const twoOptions = [
    { id: "a", label: "Apple" },
    { id: "b", label: "Banana" },
  ];

  test("rejects a non-object body", () => {
    expect(normalizeSelectRequest(null).ok).toBe(false);
    expect(normalizeSelectRequest("nope").ok).toBe(false);
    expect(normalizeSelectRequest(42).ok).toBe(false);
  });

  test("rejects missing / non-array options", () => {
    expect(normalizeSelectRequest({}).ok).toBe(false);
    expect(normalizeSelectRequest({ options: "x" }).ok).toBe(false);
  });

  test("requires at least 2 options", () => {
    const r = normalizeSelectRequest({ options: [{ id: "a", label: "A" }] });
    expect(r.ok).toBe(false);
  });

  test("rejects more than the max options", () => {
    const many = Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => ({ id: `o${i}`, label: `L${i}` }));
    const r = normalizeSelectRequest({ options: many });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too many/);
  });

  test("rejects an option missing id or label", () => {
    expect(normalizeSelectRequest({ options: [{ id: "a", label: "A" }, { id: "b" }] }).ok).toBe(false);
    expect(normalizeSelectRequest({ options: [{ id: "a", label: "A" }, { label: "B" }] }).ok).toBe(false);
    expect(normalizeSelectRequest({ options: [{ id: "a", label: "A" }, { id: " ", label: "B" }] }).ok).toBe(false);
  });

  test("rejects duplicate ids", () => {
    const r = normalizeSelectRequest({ options: [{ id: "a", label: "A" }, { id: "a", label: "A2" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicate/);
  });

  test("accepts a valid request and trims/normalizes fields", () => {
    const r = normalizeSelectRequest({
      options: [{ id: " a ", label: "  Apple  ", description: "a fruit" }, { id: "b", label: "Banana" }],
      instruction: "the student likes red things",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.options[0]).toEqual({ id: "a", label: "Apple", description: "a fruit" });
      expect(r.value.options[1]).toEqual({ id: "b", label: "Banana", description: undefined });
      expect(r.value.instruction).toBe("the student likes red things");
    }
  });

  test("caps overlong label + text fields", () => {
    const longLabel = "x".repeat(MAX_LABEL + 50);
    const r = normalizeSelectRequest({ options: [{ id: "a", label: longLabel }, { id: "b", label: "B" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.options[0].label.length).toBe(MAX_LABEL);
  });

  test("ignores non-string instruction/context", () => {
    const r = normalizeSelectRequest({ options: twoOptions, instruction: 123, context: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.instruction).toBeUndefined();
      expect(r.value.context).toBeUndefined();
    }
  });
});

describe("allowAppAiSelect", () => {
  test("allows up to the window max, then blocks", () => {
    const key = `test-key-${Math.floor(performance.now())}-${MAX_PER_WINDOW}`;
    for (let i = 0; i < MAX_PER_WINDOW; i++) {
      expect(allowAppAiSelect(key)).toBe(true);
    }
    expect(allowAppAiSelect(key)).toBe(false);
  });

  test("separate keys have independent budgets", () => {
    const k1 = `k1-${performance.now()}`;
    const k2 = `k2-${performance.now()}`;
    expect(allowAppAiSelect(k1)).toBe(true);
    expect(allowAppAiSelect(k2)).toBe(true);
  });
});
