/**
 * Validates the app startup definitions wired into the registry and the
 * goal-tree helper. Every spec's `defaults` must be a complete, schema-valid
 * instance (it's the guaranteed fallback when resolution fails), and the
 * schemas must clamp/reject bad model output. Pure — no LLM, no coordinator.
 */

import { describe, test, expect } from "@jest/globals";
import { validateAndMergeParams } from "../../shared/app-startup.js";
import { APP_REGISTRY } from "../services/dual-agent/app-registry.js";
import { goalTreeStartupSpec, goalTreeStartupNote } from "../services/dual-agent/goal-tree-app.js";

describe("registered app startup specs", () => {
  const specced = APP_REGISTRY.filter((a) => a.startup).map((a) => a.startup!);

  test("space_trader and social_trainer declare startup specs", () => {
    const ids = APP_REGISTRY.filter((a) => a.startup).map((a) => a.id);
    expect(ids).toContain("space_trader");
    expect(ids).toContain("social_trainer");
  });

  test.each(specced)("$appId defaults are complete and schema-valid", (spec) => {
    // Defaults must round-trip unchanged through their own schema.
    expect(validateAndMergeParams(spec.paramsSchema, {}, spec.defaults)).toEqual(spec.defaults);
    // Every required key must be present in defaults.
    for (const key of spec.paramsSchema.required ?? []) {
      expect(spec.defaults[key]).toBeDefined();
    }
  });

  test("space_trader clamps startLevel into [0,6]", () => {
    const spec = APP_REGISTRY.find((a) => a.id === "space_trader")!.startup!;
    expect(validateAndMergeParams(spec.paramsSchema, { startLevel: 99 }, spec.defaults).startLevel).toBe(6);
    expect(validateAndMergeParams(spec.paramsSchema, { startLevel: -5 }, spec.defaults).startLevel).toBe(0);
    expect(validateAndMergeParams(spec.paramsSchema, { startLevel: 3 }, spec.defaults).startLevel).toBe(3);
  });

  test("social_trainer rejects unknown enum values, falling back to defaults", () => {
    const spec = APP_REGISTRY.find((a) => a.id === "social_trainer")!.startup!;
    const out = validateAndMergeParams(
      spec.paramsSchema,
      { difficulty: "extreme", genderHint: "robot", scenario: "duel" },
      spec.defaults,
    );
    expect(out.difficulty).toBe("gentle");
    expect(out.genderHint).toBe("any");
    expect(out.scenario).toBe("greeting");
  });

  test("social_trainer keeps valid values", () => {
    const spec = APP_REGISTRY.find((a) => a.id === "social_trainer")!.startup!;
    const out = validateAndMergeParams(
      spec.paramsSchema,
      { difficulty: "challenging", genderHint: "female", scenario: "making_friends", interestHints: ["trains", 7] },
      spec.defaults,
    );
    expect(out.difficulty).toBe("challenging");
    expect(out.genderHint).toBe("female");
    expect(out.scenario).toBe("making_friends");
    // non-string array items are dropped
    expect(out.interestHints).toEqual(["trains"]);
  });

  test("social_trainer targetSkills keeps valid competencies and drops the rest", () => {
    const spec = APP_REGISTRY.find((a) => a.id === "social_trainer")!.startup!;
    const out = validateAndMergeParams(
      spec.paramsSchema,
      { targetSkills: ["initiation", "not_a_skill", "repair"] },
      spec.defaults,
    );
    expect(out.targetSkills).toEqual(["initiation", "repair"]);
    // omitted → defaults to empty (means "all", resolved server-side)
    expect(validateAndMergeParams(spec.paramsSchema, {}, spec.defaults).targetSkills).toEqual([]);
  });
});

describe("goal-tree startup spec", () => {
  const spec = goalTreeStartupSpec();

  test("defaults validate to normal encouragement", () => {
    expect(validateAndMergeParams(spec.paramsSchema, {}, spec.defaults)).toEqual({ encouragement: "normal" });
  });

  test("note maps encouragement to companion framing", () => {
    expect(goalTreeStartupNote({ encouragement: "high" })).toMatch(/encouraging/i);
    expect(goalTreeStartupNote({ encouragement: "gentle" })).toMatch(/calm/i);
    expect(goalTreeStartupNote({ encouragement: "normal" })).toBe("");
  });
});
