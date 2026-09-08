// server/services/chat/guided-flow/types.ts
//
// Generic, flow-agnostic step machinery for chat-driven wizards. Nothing here
// knows about students, consent or the AAC — the flow definition supplies all
// of that through its own `Ctx`. See ai-docs/main.md: chat/ is the portable
// half, the CliniAACian-specific definition lives in
// server/services/guided-setup/.

import type { FeatureType } from "@shared/schema";
import type {
  GuidedSetupChecklistItem,
  GuidedSetupRefusal,
  GuidedSetupStepStatus,
} from "@shared/guided-setup";

/** Result of a step's entry gate. */
export type GuidedGateResult = { ok: true } | { ok: false; reason: string };

export const GATE_OK: GuidedGateResult = { ok: true };

/**
 * One step of a guided flow.
 *
 * Completion is DERIVED (`isComplete` reads the ctx, never a counter), so a
 * flow is resumable from any device and cannot drift out of sync with data.
 */
export interface GuidedStep<Ctx, StepId extends string = string> {
  id: StepId;
  /** Feature panel that shows this step's data. */
  panel: FeatureType;
  /** Whether `skip` is allowed on this step. */
  skippable: boolean;
  /** Hidden steps are neither shown nor counted (e.g. AAC without a license). */
  isHidden?(ctx: Ctx): boolean;
  /** Per-item progress for the rail; keys map to `guidedSetup.checklist.<key>`. */
  checklist(ctx: Ctx): GuidedSetupChecklistItem[];
  /** True when the step's data requirements are met. */
  isComplete(ctx: Ctx): boolean;
  /** Whether the flow may sit on this step at all (consent gate, …). */
  canEnter(ctx: Ctx): GuidedGateResult;
  /**
   * Why `advance` was refused while this step is incomplete. Defaults to
   * `stepIncomplete`; step 3 narrows it to programMissing / programDraft.
   */
  incompleteReason?(ctx: Ctx): string;
  /** The system-prompt text for this step. Terse; see docs/PROMPT_WRITING.md. */
  promptBlock(ctx: Ctx, view: GuidedFlowView<StepId>): string;
}

export interface GuidedFlowDefinition<Ctx, StepId extends string = string> {
  id: string;
  steps: ReadonlyArray<GuidedStep<Ctx, StepId>>;
  /** Panel to show once every step is done/skipped. */
  donePanel: FeatureType;
}

export interface GuidedFlowStepView<StepId extends string = string> {
  id: StepId;
  status: GuidedSetupStepStatus;
  panel: FeatureType;
  checklist: GuidedSetupChecklistItem[];
}

/**
 * The generic half of the view. The flow's own service widens it into the
 * client-facing `GuidedSetupView` (account, term, gate, lang, …).
 */
export interface GuidedFlowView<StepId extends string = string> {
  flow: string;
  /** The current step, or "done" when every visible step is done/skipped. */
  step: StepId | "done";
  steps: GuidedFlowStepView<StepId>[];
  panel: FeatureType;
  refused?: GuidedSetupRefusal | null;
}

/** The minimum the engine needs from a persisted record. */
export interface GuidedFlowRecordLike {
  skipped: readonly string[];
}

export type GuidedFlowActionInput<StepId extends string = string> =
  | { action: "status" }
  | { action: "advance" }
  | { action: "back" }
  | { action: "skip"; step?: StepId };

export interface GuidedFlowActionResult<
  StepId extends string,
  R extends GuidedFlowRecordLike,
> {
  /** The record after the action (identical reference when nothing changed). */
  record: R | null;
  view: GuidedFlowView<StepId>;
  refused?: GuidedSetupRefusal;
}
