// server/services/smart-home/types.ts
//
// The PROVIDER SEAM's vocabulary — one small type module every smart-home
// participant can import without dragging in the dispatcher, the credentials
// vault or any cloud SDK.
//
// `home-action-service.ts` owns the registry and re-exports these; the cloud
// providers and the fulfillment handlers import them from here, so a wave-2
// agent replacing a provider BODY never has to touch the shapes.
//
// See planning-docs/smart-home-actions.md ("Phase 1 framework").

import type { HomeAction } from "@shared/schema";

/**
 * The cloud ecosystems we can actuate through. A `spoken` slot has no
 * provider account behind it (the device just talks), so it is deliberately
 * NOT a member: this is the set that account-linking and virtual devices
 * are keyed by.
 */
export type SmartHomeProvider = Extract<HomeAction["type"], "alexa" | "google">;

/**
 * Who the press is for. Home actions are per-STUDENT (the slot list lives in
 * that student's `aac_settings`, and account-link grants bind
 * `(provider → studentId)`), so the student id is the only thing a provider
 * needs to find its credentials. Matches `students.id` (varchar) — the same
 * value the coordinator's session state carries.
 */
export interface HomeActionContext {
  studentId: string;
}

/**
 * What happened. Soft-fail by design: a home action that cannot actuate must
 * never throw into the press path, and the caller records nothing for a
 * `failed` outcome (never tell the agents something happened that didn't).
 */
export type HomeActionOutcome =
  | { kind: 'client_spoken' }          // actuation happens on the client (speak the command aloud)
  | { kind: 'triggered' }              // a cloud virtual-trigger event fired server-side
  | { kind: 'failed'; reason: string };

/**
 * A provider actuates ONE action type. Never throws — failures come back as
 * `{kind:'failed'}` with a machine-readable reason (`not_configured`,
 * `not_linked`, …) that the coordinator logs.
 */
export interface HomeActionProvider {
  execute(action: HomeAction, ctx: HomeActionContext): Promise<HomeActionOutcome>;
}
