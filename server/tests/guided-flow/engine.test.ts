/**
 * The guided-flow engine is the part of GUIDED SETUP that cannot be talked out
 * of a decision: the AI narrates, the engine rules. Every failure this suite
 * guards is silent — a step that reports "done" while its data is missing, a
 * consent gate that lets the flow walk past it, a skip recorded on a step that
 * must never be skippable. None of those throw; they just let the wrong thing
 * happen, which is why they are pinned here rather than left to review.
 *
 * Pure and DB-free on purpose (jest.config.unit.js drops globalSetup).
 */

import { describe, it, expect } from "@jest/globals";

import {
  applyAction,
  resolveFlowView,
  stepPosition,
} from "../../services/chat/guided-flow/engine.js";
import {
  GATE_OK,
  type GuidedFlowDefinition,
  type GuidedStep,
} from "../../services/chat/guided-flow/types.js";

// ---------------------------------------------------------------------------
// A tiny four-step fixture flow, shaped like student_setup but with no DB.
// ---------------------------------------------------------------------------

interface Ctx {
  aDone: boolean;
  bDone: boolean;
  cDone: boolean;
  dDone: boolean;
  /** Blocks entry to b/c/d, the way the consent gate does. */
  gateOpen: boolean;
  /** Hides d, the way a license without aacEnabled hides step 4. */
  hideD: boolean;
  cExists: boolean;
}

const baseCtx: Ctx = {
  aDone: false,
  bDone: false,
  cDone: false,
  dDone: false,
  gateOpen: true,
  hideD: false,
  cExists: false,
};

type StepId = "a" | "b" | "c" | "d";

function step(
  id: StepId,
  done: (ctx: Ctx) => boolean,
  opts: Partial<GuidedStep<Ctx, StepId>> = {},
): GuidedStep<Ctx, StepId> {
  return {
    id,
    panel: "students",
    skippable: id !== "a",
    checklist: (ctx) => [{ key: `${id}-item`, done: done(ctx) }],
    isComplete: done,
    canEnter: (ctx) =>
      id === "a" || ctx.gateOpen ? GATE_OK : { ok: false, reason: "consentRequired" },
    promptBlock: () => `BLOCK ${id}`,
    ...opts,
  };
}

const def: GuidedFlowDefinition<Ctx, StepId> = {
  id: "test_flow",
  donePanel: "overview",
  steps: [
    step("a", (c) => c.aDone),
    step("b", (c) => c.bDone),
    step("c", (c) => c.cDone, {
      incompleteReason: (c) => (c.cExists ? "programDraft" : "programMissing"),
    }),
    step("d", (c) => c.dDone, { isHidden: (c) => c.hideD }),
  ],
};

const record = (skipped: string[] = []) => ({ skipped });

function statuses(ctx: Ctx, skipped: string[] = []) {
  return Object.fromEntries(
    resolveFlowView(def, ctx, record(skipped)).steps.map((s) => [s.id, s.status]),
  );
}

// ---------------------------------------------------------------------------

describe("resolveFlowView — statuses", () => {
  it("puts the pointer on the first incomplete step and locks the rest", () => {
    const view = resolveFlowView(def, baseCtx, record());
    expect(view.step).toBe("a");
    expect(statuses(baseCtx)).toEqual({ a: "current", b: "locked", c: "locked", d: "locked" });
    expect(view.panel).toBe("students");
  });

  it("marks a step done from DATA, not from a counter", () => {
    const ctx = { ...baseCtx, aDone: true };
    expect(statuses(ctx)).toEqual({ a: "done", b: "current", c: "locked", d: "locked" });
    expect(resolveFlowView(def, ctx, record()).step).toBe("b");
  });

  it("shows a later completed step as done even while an earlier one is not", () => {
    // Completion is derived: a report that already exists is done, whatever
    // order the user filled things in.
    const ctx = { ...baseCtx, cDone: true };
    expect(statuses(ctx)).toEqual({ a: "current", b: "locked", c: "done", d: "locked" });
    expect(resolveFlowView(def, ctx, record()).step).toBe("a");
  });

  it("locks — not currents — a step whose gate refuses entry", () => {
    const ctx = { ...baseCtx, aDone: true, gateOpen: false };
    const view = resolveFlowView(def, ctx, record());
    expect(view.step).toBe("b");
    expect(statuses(ctx).b).toBe("locked");
  });

  it("reports a skipped step and moves the pointer past it", () => {
    const ctx = { ...baseCtx, aDone: true };
    expect(statuses(ctx, ["b"])).toEqual({ a: "done", b: "skipped", c: "current", d: "locked" });
  });

  it("hides a step entirely and does not count it", () => {
    const ctx = { ...baseCtx, hideD: true, aDone: true, bDone: true, cDone: true };
    const view = resolveFlowView(def, ctx, record());
    expect(view.step).toBe("done");
    expect(view.steps.find((s) => s.id === "d")?.status).toBe("hidden");
    expect(view.panel).toBe("overview");
  });

  it("is done when every visible step is done or skipped", () => {
    const ctx = { ...baseCtx, aDone: true, bDone: true, cDone: true };
    expect(resolveFlowView(def, ctx, record(["d"])).step).toBe("done");
  });

  it("carries each step's checklist", () => {
    const view = resolveFlowView(def, { ...baseCtx, aDone: true }, record());
    expect(view.steps[0].checklist).toEqual([{ key: "a-item", done: true }]);
    expect(view.steps[1].checklist).toEqual([{ key: "b-item", done: false }]);
  });
});

describe("stepPosition", () => {
  it("counts only visible steps", () => {
    expect(stepPosition(resolveFlowView(def, baseCtx, record()))).toBe("1/4");
    expect(stepPosition(resolveFlowView(def, { ...baseCtx, aDone: true }, record()))).toBe("2/4");
    const hidden = { ...baseCtx, hideD: true, aDone: true };
    expect(stepPosition(resolveFlowView(def, hidden, record()))).toBe("2/3");
  });

  it("reports done when the flow is finished", () => {
    const ctx = { ...baseCtx, aDone: true, bDone: true, cDone: true, dDone: true };
    expect(stepPosition(resolveFlowView(def, ctx, record()))).toBe("done");
  });
});

describe("applyAction — advance", () => {
  it("refuses while the current step is incomplete", () => {
    const r = applyAction(def, baseCtx, record(), { action: "advance" });
    expect(r.refused).toEqual({ action: "advance", reason: "stepIncomplete" });
    expect(r.view.refused).toEqual({ action: "advance", reason: "stepIncomplete" });
  });

  it("refuses with the step's OWN reason when it has one", () => {
    const missing = { ...baseCtx, aDone: true, bDone: true };
    expect(applyAction(def, missing, record(), { action: "advance" }).refused?.reason).toBe(
      "programMissing",
    );
    const draft = { ...missing, cExists: true };
    expect(applyAction(def, draft, record(), { action: "advance" }).refused?.reason).toBe(
      "programDraft",
    );
  });

  it("refuses with the gate's reason before it looks at completeness", () => {
    const ctx = { ...baseCtx, aDone: true, gateOpen: false };
    expect(applyAction(def, ctx, record(), { action: "advance" }).refused).toEqual({
      action: "advance",
      reason: "consentRequired",
    });
  });

  it("passes once the gate opens", () => {
    const ctx = { ...baseCtx, aDone: true, gateOpen: true };
    expect(applyAction(def, ctx, record(), { action: "advance" }).refused?.reason).toBe(
      "stepIncomplete",
    );
  });

  it("is a no-op success when the flow is already done", () => {
    const ctx = { ...baseCtx, aDone: true, bDone: true, cDone: true, dDone: true };
    const r = applyAction(def, ctx, record(), { action: "advance" });
    expect(r.refused).toBeUndefined();
    expect(r.view.step).toBe("done");
  });

  it("never mutates the record", () => {
    const rec = record();
    const r = applyAction(def, baseCtx, rec, { action: "advance" });
    expect(r.record).toBe(rec);
    expect(rec.skipped).toEqual([]);
  });
});

describe("applyAction — skip", () => {
  it("records the current step and moves the pointer past it", () => {
    const ctx = { ...baseCtx, aDone: true };
    const r = applyAction(def, ctx, record(), { action: "skip" });
    expect(r.refused).toBeUndefined();
    expect(r.record?.skipped).toEqual(["b"]);
    expect(r.view.step).toBe("c");
  });

  it("accepts an explicit step", () => {
    const r = applyAction(def, baseCtx, record(), { action: "skip", step: "c" });
    expect(r.record?.skipped).toEqual(["c"]);
  });

  it("refuses a step that is not skippable", () => {
    const r = applyAction(def, baseCtx, record(), { action: "skip" }); // current is "a"
    expect(r.refused).toEqual({ action: "skip", reason: "notSkippable" });
    expect(r.record?.skipped).toEqual([]);
  });

  it("refuses a hidden step", () => {
    const ctx = { ...baseCtx, hideD: true };
    expect(applyAction(def, ctx, record(), { action: "skip", step: "d" }).refused?.reason).toBe(
      "notSkippable",
    );
  });

  it("refuses an unknown step", () => {
    const r = applyAction(def, baseCtx, record(), {
      action: "skip",
      step: "zzz" as StepId,
    });
    expect(r.refused?.reason).toBe("unknownStep");
  });

  it("refuses when there is no record to write to", () => {
    expect(applyAction(def, baseCtx, null, { action: "skip", step: "b" }).refused?.reason).toBe(
      "notStarted",
    );
  });

  it("is idempotent — a second skip does not duplicate the entry", () => {
    const rec = record(["b"]);
    const r = applyAction(def, { ...baseCtx, aDone: true }, rec, { action: "skip", step: "b" });
    expect(r.record).toBe(rec);
    expect(r.record?.skipped).toEqual(["b"]);
  });
});

describe("applyAction — status and back", () => {
  it("status returns the view untouched", () => {
    const rec = record();
    const r = applyAction(def, baseCtx, rec, { action: "status" });
    expect(r.record).toBe(rec);
    expect(r.refused).toBeUndefined();
    expect(r.view.step).toBe("a");
  });

  it("back is a no-op on the record and does not move the pointer", () => {
    // "Back" is a conversational move, not a state change: the AI talks about
    // an earlier step while the flow stays where the data puts it.
    const ctx = { ...baseCtx, aDone: true };
    const rec = record();
    const r = applyAction(def, ctx, rec, { action: "back" });
    expect(r.record).toBe(rec);
    expect(r.view.step).toBe("b");
    expect(r.refused).toBeUndefined();
  });
});
