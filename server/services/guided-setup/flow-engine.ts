// server/services/guided-setup/flow-engine.ts
//
// Pure, DB-free step engine for the student_setup flow. Everything it knows
// comes from the definition and the ctx the caller resolved; it never reads
// a database, a clock or an env var, so it is trivially testable and
// byte-deterministic.
//
// The server owns the flow; the AI only talks. A transition the engine
// refuses stays refused no matter what the prompt says
// (memory: feedback_ai_open_decision).

import type { GuidedSetupRecord, GuidedSetupStepId, GuidedSetupStepStatus } from "@shared/guided-setup";
import type { StudentSetupCtx } from "./student-setup-flow.js";
import type {
  GuidedFlowActionInput,
  GuidedFlowActionResult,
  GuidedFlowDefinition,
  GuidedFlowView,
  GuidedStep,
} from "./flow-types.js";

/** Steps a record has marked skipped, as a set (records store an array). */
function skippedSet(record: GuidedSetupRecord | null): Set<string> {
  return new Set(record?.skipped ?? []);
}

/**
 * Compute the view: per-step status, the current step, and the panel to show.
 *
 * Status rules, in order:
 *  - `hidden`  — the step's own `isHidden` says so (never counted).
 *  - `skipped` — the record lists it.
 *  - `done`    — `isComplete(ctx)`.
 *  - `current` — the FIRST step that is none of the above and is enterable.
 *  - `locked`  — that same first step when `canEnter` refuses, and every
 *                step after the current one.
 */
export function resolveFlowView(
  def: GuidedFlowDefinition,
  ctx: StudentSetupCtx,
  record: GuidedSetupRecord | null,
): GuidedFlowView {
  const skipped = skippedSet(record);

  // Pass 1 — settle the statuses that do not depend on position.
  type Settled = "hidden" | "skipped" | "done" | null;
  const prelim: Settled[] = def.steps.map((step) => {
    if (step.isHidden?.(ctx)) return "hidden";
    if (skipped.has(step.id)) return "skipped";
    if (step.isComplete(ctx)) return "done";
    return null; // undecided: current or locked
  });

  const currentIndex = prelim.findIndex((s) => s === null);

  const steps: GuidedFlowView["steps"] = def.steps.map((step, i) => {
    const settled = prelim[i];
    const status: GuidedSetupStepStatus =
      settled !== null
        ? settled
        : i === currentIndex && step.canEnter(ctx).ok
          ? "current"
          : "locked";
    return {
      id: step.id,
      status,
      panel: step.panel,
      checklist: step.checklist(ctx),
    };
  });

  const current = currentIndex === -1 ? null : def.steps[currentIndex];

  return {
    flow: def.id,
    step: current ? current.id : "done",
    steps,
    panel: current ? current.panel : def.donePanel,
  };
}

function findStep(
  def: GuidedFlowDefinition,
  id: GuidedSetupStepId | "done",
): GuidedStep | undefined {
  return def.steps.find((s) => s.id === id);
}

/**
 * Validate and apply one flow action.
 *
 * - `status` / `back` never change the record. `back` exists so the AI can say
 *   "let's go back to the birth date" without the server pretending the flow
 *   moved: the view comes back untouched and the AI simply talks about the
 *   earlier step.
 * - `advance` refuses when the current step cannot be entered (its `canEnter`
 *   reason — e.g. `consentRequired`) or is not complete (`stepIncomplete`, or
 *   the step's own narrower reason).
 * - `skip` refuses on a non-skippable step (`notSkippable`), an unknown step
 *   (`unknownStep`) or when no record exists yet (`notStarted`).
 */
export function applyAction(
  def: GuidedFlowDefinition,
  ctx: StudentSetupCtx,
  record: GuidedSetupRecord | null,
  input: GuidedFlowActionInput,
): GuidedFlowActionResult {
  const view = resolveFlowView(def, ctx, record);

  const refuse = (reason: string): GuidedFlowActionResult => ({
    record,
    view: { ...view, refused: { action: input.action, reason } },
    refused: { action: input.action, reason },
  });

  switch (input.action) {
    case "status":
    case "back":
      return { record, view };

    case "advance": {
      if (view.step === "done") return { record, view };
      const step = findStep(def, view.step);
      if (!step) return refuse("unknownStep");
      const gate = step.canEnter(ctx);
      if (!gate.ok) return refuse(gate.reason);
      if (!step.isComplete(ctx)) {
        return refuse(step.incompleteReason?.(ctx) ?? "stepIncomplete");
      }
      // Unreachable in practice (a complete step is never `current`), but a
      // definition with an exotic isComplete/status split must not fall through.
      return { record, view };
    }

    case "skip": {
      if (!record) return refuse("notStarted");
      const targetId = input.step ?? (view.step === "done" ? null : view.step);
      if (!targetId) return refuse("notSkippable");
      const step = findStep(def, targetId);
      if (!step) return refuse("unknownStep");
      if (!step.skippable) return refuse("notSkippable");
      if (step.isHidden?.(ctx)) return refuse("notSkippable");
      if ((record.skipped as readonly GuidedSetupStepId[]).includes(targetId)) {
        // Idempotent: already skipped, nothing to write.
        return { record, view };
      }
      const nextRecord = {
        ...record,
        skipped: [...record.skipped, targetId],
      } as unknown as GuidedSetupRecord;
      return { record: nextRecord, view: resolveFlowView(def, ctx, nextRecord) };
    }
  }
}

/**
 * "n/N" for the prompt header: the current step's 1-based position among the
 * VISIBLE steps, over the number of visible steps. "done" when finished.
 */
export function stepPosition(view: GuidedFlowView): string {
  const visible = view.steps.filter((s) => s.status !== "hidden");
  if (view.step === "done") return "done";
  const index = visible.findIndex((s) => s.id === view.step);
  if (index === -1) return "done";
  return `${index + 1}/${visible.length}`;
}
