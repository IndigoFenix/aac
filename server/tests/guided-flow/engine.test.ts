/**
 * The guided-flow engine is the part of GUIDED SETUP that cannot be talked out
 * of a decision: the AI narrates, the engine rules. Every failure this suite
 * guards is silent — a step that reports "done" while its data is missing, a
 * consent gate that lets the flow walk past it, a skip recorded on a step that
 * must never be skippable. None of those throw; they just let the wrong thing
 * happen, which is why they are pinned here rather than left to review.
 *
 * Pure and DB-free on purpose (jest.config.unit.js drops globalSetup).
 *
 * The engine is concrete to `StudentSetupCtx` / `GuidedSetupStepId` (Cut 2,
 * planning-docs/guided-setup-simplification-plan.md — it was generic over
 * <Ctx, StepId, R> with exactly one instantiation). This fixture is still an
 * independent four-step flow, unrelated to the real step 1-5 prompts and
 * checklists in student-setup-flow.ts: it drives the ctx's own facts fields
 * with plain test values to exercise the step machinery in isolation, the way
 * the old fictional `a`/`b`/`c`/`d` flow did.
 */

import { describe, it, expect } from "@jest/globals";

import { applyAction, resolveFlowView, stepPosition } from "../../services/guided-setup/flow-engine.js";
import { GATE_OK, type GuidedFlowDefinition, type GuidedStep } from "../../services/guided-setup/flow-types.js";
import {
  EMPTY_AAC,
  EMPTY_BASICS,
  EMPTY_CONTACTS,
  EMPTY_PROGRAM,
  EMPTY_REPORTS,
  type StudentSetupCtx,
} from "../../services/guided-setup/student-setup-flow.js";
import type {
  GuidedSetupGate,
  GuidedSetupRecord,
  GuidedSetupSkippableStep,
  GuidedSetupStepId,
} from "@shared/guided-setup";

// ---------------------------------------------------------------------------
// A tiny four-step fixture flow, shaped like student_setup but with no DB.
//
// Reuses four of the five real step ids (basics/medical/program/aac) — the
// only ids `GuidedSetupStepId` has, now that the engine is no longer generic
// over StepId — but with entirely made-up predicates, independent of
// student-setup-flow.ts's real rules.
// ---------------------------------------------------------------------------

const baseCtx: StudentSetupCtx = {
  account: "family",
  term: "CHILD",
  lang: "en",
  instituteId: "inst-1",
  instituteName: "Test Institute",
  studentId: "student-1",
  userName: "Test User",
  firstTurn: false,
  aacLicensed: true, // flips to false to hide the "aac" fixture step (stands in for hideD)
  instituteHasStudents: false,
  gate: "active", // "active" == gateOpen; anything else blocks b/c/d entry
  record: null,
  basics: EMPTY_BASICS, // .inInstitute doubles as "aDone"
  reports: EMPTY_REPORTS, // .hasAnyReport doubles as "bDone"
  program: EMPTY_PROGRAM, // .hasActiveProgram doubles as "cDone"; .exists as "cExists"
  aac: EMPTY_AAC, // .enabled doubles as "dDone"
  contacts: EMPTY_CONTACTS,
};

type StepId = GuidedSetupStepId;

function step(
  id: StepId,
  done: (ctx: StudentSetupCtx) => boolean,
  opts: Partial<GuidedStep> = {},
): GuidedStep {
  return {
    id,
    panel: "students",
    skippable: id !== "basics",
    checklist: (ctx) => [{ key: `${id}-item`, done: done(ctx) }],
    isComplete: done,
    canEnter: (ctx) =>
      id === "basics" || ctx.gate === "active" ? GATE_OK : { ok: false, reason: "consentRequired" },
    promptBlock: () => `BLOCK ${id}`,
    ...opts,
  };
}

const def: GuidedFlowDefinition = {
  id: "test_flow",
  donePanel: "overview",
  steps: [
    step("basics", (c) => c.basics.inInstitute),
    step("medical", (c) => c.reports.hasAnyReport),
    step("program", (c) => c.program.hasActiveProgram, {
      incompleteReason: (c) => (c.program.exists ? "programDraft" : "programMissing"),
    }),
    step("aac", (c) => c.aac.enabled, { isHidden: (c) => !c.aacLicensed }),
  ],
};

function record(skipped: GuidedSetupSkippableStep[] = []): GuidedSetupRecord {
  return {
    v: 1,
    source: "chat",
    startedAt: "2026-01-01T00:00:00.000Z",
    startedByUserId: "user-1",
    skipped,
  };
}

function withGate(ctx: StudentSetupCtx, gate: GuidedSetupGate): StudentSetupCtx {
  return { ...ctx, gate };
}

function statuses(ctx: StudentSetupCtx, skipped: GuidedSetupSkippableStep[] = []) {
  return Object.fromEntries(
    resolveFlowView(def, ctx, record(skipped)).steps.map((s) => [s.id, s.status]),
  );
}

// ---------------------------------------------------------------------------

describe("resolveFlowView — statuses", () => {
  it("puts the pointer on the first incomplete step and locks the rest", () => {
    const view = resolveFlowView(def, baseCtx, record());
    expect(view.step).toBe("basics");
    expect(statuses(baseCtx)).toEqual({
      basics: "current",
      medical: "locked",
      program: "locked",
      aac: "locked",
    });
    expect(view.panel).toBe("students");
  });

  it("marks a step done from DATA, not from a counter", () => {
    const ctx = { ...baseCtx, basics: { ...EMPTY_BASICS, inInstitute: true } };
    expect(statuses(ctx)).toEqual({
      basics: "done",
      medical: "current",
      program: "locked",
      aac: "locked",
    });
    expect(resolveFlowView(def, ctx, record()).step).toBe("medical");
  });

  it("shows a later completed step as done even while an earlier one is not", () => {
    // Completion is derived: a report that already exists is done, whatever
    // order the user filled things in.
    const ctx = { ...baseCtx, program: { ...EMPTY_PROGRAM, hasActiveProgram: true } };
    expect(statuses(ctx)).toEqual({
      basics: "current",
      medical: "locked",
      program: "done",
      aac: "locked",
    });
    expect(resolveFlowView(def, ctx, record()).step).toBe("basics");
  });

  it("locks — not currents — a step whose gate refuses entry", () => {
    const ctx = withGate(
      { ...baseCtx, basics: { ...EMPTY_BASICS, inInstitute: true } },
      "none",
    );
    const view = resolveFlowView(def, ctx, record());
    expect(view.step).toBe("medical");
    expect(statuses(ctx).medical).toBe("locked");
  });

  it("reports a skipped step and moves the pointer past it", () => {
    const ctx = { ...baseCtx, basics: { ...EMPTY_BASICS, inInstitute: true } };
    expect(statuses(ctx, ["medical"])).toEqual({
      basics: "done",
      medical: "skipped",
      program: "current",
      aac: "locked",
    });
  });

  it("hides a step entirely and does not count it", () => {
    const ctx: StudentSetupCtx = {
      ...baseCtx,
      aacLicensed: false,
      basics: { ...EMPTY_BASICS, inInstitute: true },
      reports: { ...EMPTY_REPORTS, hasAnyReport: true },
      program: { ...EMPTY_PROGRAM, hasActiveProgram: true },
    };
    const view = resolveFlowView(def, ctx, record());
    expect(view.step).toBe("done");
    expect(view.steps.find((s) => s.id === "aac")?.status).toBe("hidden");
    expect(view.panel).toBe("overview");
  });

  it("is done when every visible step is done or skipped", () => {
    const ctx = {
      ...baseCtx,
      basics: { ...EMPTY_BASICS, inInstitute: true },
      reports: { ...EMPTY_REPORTS, hasAnyReport: true },
      program: { ...EMPTY_PROGRAM, hasActiveProgram: true },
    };
    expect(resolveFlowView(def, ctx, record(["aac"])).step).toBe("done");
  });

  it("carries each step's checklist", () => {
    const view = resolveFlowView(
      def,
      { ...baseCtx, basics: { ...EMPTY_BASICS, inInstitute: true } },
      record(),
    );
    expect(view.steps[0].checklist).toEqual([{ key: "basics-item", done: true }]);
    expect(view.steps[1].checklist).toEqual([{ key: "medical-item", done: false }]);
  });
});

describe("stepPosition", () => {
  it("counts only visible steps", () => {
    expect(stepPosition(resolveFlowView(def, baseCtx, record()))).toBe("1/4");
    expect(
      stepPosition(
        resolveFlowView(
          def,
          { ...baseCtx, basics: { ...EMPTY_BASICS, inInstitute: true } },
          record(),
        ),
      ),
    ).toBe("2/4");
    const hidden: StudentSetupCtx = {
      ...baseCtx,
      aacLicensed: false,
      basics: { ...EMPTY_BASICS, inInstitute: true },
    };
    expect(stepPosition(resolveFlowView(def, hidden, record()))).toBe("2/3");
  });

  it("reports done when the flow is finished", () => {
    const ctx: StudentSetupCtx = {
      ...baseCtx,
      basics: { ...EMPTY_BASICS, inInstitute: true },
      reports: { ...EMPTY_REPORTS, hasAnyReport: true },
      program: { ...EMPTY_PROGRAM, hasActiveProgram: true },
      aac: { ...EMPTY_AAC, enabled: true },
    };
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
    const missing: StudentSetupCtx = {
      ...baseCtx,
      basics: { ...EMPTY_BASICS, inInstitute: true },
      reports: { ...EMPTY_REPORTS, hasAnyReport: true },
    };
    expect(applyAction(def, missing, record(), { action: "advance" }).refused?.reason).toBe(
      "programMissing",
    );
    const draft: StudentSetupCtx = {
      ...missing,
      program: { ...EMPTY_PROGRAM, exists: true },
    };
    expect(applyAction(def, draft, record(), { action: "advance" }).refused?.reason).toBe(
      "programDraft",
    );
  });

  it("refuses with the gate's reason before it looks at completeness", () => {
    const ctx = withGate(
      { ...baseCtx, basics: { ...EMPTY_BASICS, inInstitute: true } },
      "none",
    );
    expect(applyAction(def, ctx, record(), { action: "advance" }).refused).toEqual({
      action: "advance",
      reason: "consentRequired",
    });
  });

  it("passes once the gate opens", () => {
    const ctx = withGate(
      { ...baseCtx, basics: { ...EMPTY_BASICS, inInstitute: true } },
      "active",
    );
    expect(applyAction(def, ctx, record(), { action: "advance" }).refused?.reason).toBe(
      "stepIncomplete",
    );
  });

  it("is a no-op success when the flow is already done", () => {
    const ctx: StudentSetupCtx = {
      ...baseCtx,
      basics: { ...EMPTY_BASICS, inInstitute: true },
      reports: { ...EMPTY_REPORTS, hasAnyReport: true },
      program: { ...EMPTY_PROGRAM, hasActiveProgram: true },
      aac: { ...EMPTY_AAC, enabled: true },
    };
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
    const ctx = { ...baseCtx, basics: { ...EMPTY_BASICS, inInstitute: true } };
    const r = applyAction(def, ctx, record(), { action: "skip" });
    expect(r.refused).toBeUndefined();
    expect(r.record?.skipped).toEqual(["medical"]);
    expect(r.view.step).toBe("program");
  });

  it("accepts an explicit step", () => {
    const r = applyAction(def, baseCtx, record(), { action: "skip", step: "program" });
    expect(r.record?.skipped).toEqual(["program"]);
  });

  it("refuses a step that is not skippable", () => {
    const r = applyAction(def, baseCtx, record(), { action: "skip" }); // current is "basics"
    expect(r.refused).toEqual({ action: "skip", reason: "notSkippable" });
    expect(r.record?.skipped).toEqual([]);
  });

  it("refuses a hidden step", () => {
    const ctx = { ...baseCtx, aacLicensed: false };
    expect(applyAction(def, ctx, record(), { action: "skip", step: "aac" }).refused?.reason).toBe(
      "notSkippable",
    );
  });

  it("refuses an unknown step", () => {
    const r = applyAction(def, baseCtx, record(), {
      action: "skip",
      step: "zzz" as GuidedSetupStepId,
    });
    expect(r.refused?.reason).toBe("unknownStep");
  });

  it("refuses when there is no record to write to", () => {
    expect(
      applyAction(def, baseCtx, null, { action: "skip", step: "medical" }).refused?.reason,
    ).toBe("notStarted");
  });

  it("is idempotent — a second skip does not duplicate the entry", () => {
    const rec = record(["medical"]);
    const r = applyAction(
      def,
      { ...baseCtx, basics: { ...EMPTY_BASICS, inInstitute: true } },
      rec,
      { action: "skip", step: "medical" },
    );
    expect(r.record).toBe(rec);
    expect(r.record?.skipped).toEqual(["medical"]);
  });
});

describe("applyAction — status and back", () => {
  it("status returns the view untouched", () => {
    const rec = record();
    const r = applyAction(def, baseCtx, rec, { action: "status" });
    expect(r.record).toBe(rec);
    expect(r.refused).toBeUndefined();
    expect(r.view.step).toBe("basics");
  });

  it("back is a no-op on the record and does not move the pointer", () => {
    // "Back" is a conversational move, not a state change: the AI talks about
    // an earlier step while the flow stays where the data puts it.
    const ctx = { ...baseCtx, basics: { ...EMPTY_BASICS, inInstitute: true } };
    const rec = record();
    const r = applyAction(def, ctx, rec, { action: "back" });
    expect(r.record).toBe(rec);
    expect(r.view.step).toBe("medical");
    expect(r.refused).toBeUndefined();
  });
});
