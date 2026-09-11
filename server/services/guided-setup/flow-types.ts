// server/services/guided-setup/flow-types.ts
//
// Step machinery for the ONE guided flow this codebase has: `student_setup`
// (student-setup-flow.ts). Formerly generic over <Ctx, StepId, R> with a
// single instantiation and no other consumer; collapsed to the concrete
// student-setup types 2026-09-09
// (planning-docs/guided-setup-simplification-plan.md, Cut 2).

import type { FeatureType } from "@shared/schema";
import type {
  GuidedSetupChecklistItem,
  GuidedSetupRecord,
  GuidedSetupRefusal,
  GuidedSetupStepId,
  GuidedSetupStepView,
} from "@shared/guided-setup";
import type { StudentSetupCtx } from "./student-setup-flow.js";

/** Result of a step's entry gate. */
export type GuidedGateResult = { ok: true } | { ok: false; reason: string };

export const GATE_OK: GuidedGateResult = { ok: true };

/**
 * One step of the student_setup flow.
 *
 * Completion is DERIVED (`isComplete` reads the ctx, never a counter), so a
 * flow is resumable from any device and cannot drift out of sync with data.
 */
export interface GuidedStep {
  id: GuidedSetupStepId;
  /** Feature panel that shows this step's data. */
  panel: FeatureType;
  /** Whether `skip` is allowed on this step. */
  skippable: boolean;
  /** Hidden steps are neither shown nor counted (e.g. AAC without a license). */
  isHidden?(ctx: StudentSetupCtx): boolean;
  /** Per-item progress for the rail; keys map to `guidedSetup.checklist.<key>`. */
  checklist(ctx: StudentSetupCtx): GuidedSetupChecklistItem[];
  /** True when the step's data requirements are met. */
  isComplete(ctx: StudentSetupCtx): boolean;
  /** Whether the flow may sit on this step at all (consent gate, …). */
  canEnter(ctx: StudentSetupCtx): GuidedGateResult;
  /**
   * Why `advance` was refused while this step is incomplete. Defaults to
   * `stepIncomplete`; step 3 narrows it to programMissing / programDraft.
   */
  incompleteReason?(ctx: StudentSetupCtx): string;
  /** The system-prompt text for this step. Terse; see docs/PROMPT_WRITING.md. */
  promptBlock(ctx: StudentSetupCtx, view: GuidedFlowView): string;
}

export interface GuidedFlowDefinition {
  id: string;
  steps: ReadonlyArray<GuidedStep>;
  /** Panel to show once every step is done/skipped. */
  donePanel: FeatureType;
}

/**
 * The engine's own half of the view. `student-setup-service.ts` widens it
 * into the client-facing `GuidedSetupView` (account, term, gate, lang, …).
 */
export interface GuidedFlowView {
  flow: string;
  /** The current step, or "done" when every visible step is done/skipped. */
  step: GuidedSetupStepId | "done";
  steps: GuidedSetupStepView[];
  panel: FeatureType;
  refused?: GuidedSetupRefusal | null;
}

export type GuidedFlowActionInput =
  | { action: "status" }
  | { action: "advance" }
  | { action: "back" }
  | { action: "skip"; step?: GuidedSetupStepId };

export interface GuidedFlowActionResult {
  /** The record after the action (identical reference when nothing changed). */
  record: GuidedSetupRecord | null;
  view: GuidedFlowView;
  refused?: GuidedSetupRefusal;
}
