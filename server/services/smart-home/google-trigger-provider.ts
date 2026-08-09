// server/services/smart-home/google-trigger-provider.ts
//
// Google Home cloud provider — fires the virtual-trigger state change bound to
// a slot.
//
// One enabled `google` slot is one virtual CONTACT SENSOR in Home Graph
// (`action.devices.types.SENSOR` + query-only `OpenClose`; the device id IS
// `action.id`). The family binds it in the Home app / script editor as a
// `device.state.OpenClose` starter — `state: openPercent, is: 100` — so a press
// must produce a state TRANSITION, not a level:
//
//     openPercent 0  ──report──▶  100   (the edge the automation starts on)
//     openPercent 100 ──report──▶ 0     (rearm, so the next press edges again)
//
// BOTH reports are AWAITED inside the same invocation. This server runs on AWS
// Lambda, which freezes the container the moment the response is written: a
// `setTimeout` or a detached promise scheduling the close would silently never
// run, leaving the sensor stuck open and the automation unable to fire a second
// time. There is no back-off between the two calls for the same reason —
// Home Graph applies them in order.
//
// Soft-fail contract: never throws into the press path. No Home Graph service
// account in env → `not_configured` (the state the whole slice ships in until a
// Google developer account exists, and the check that runs FIRST — see below);
// configured but no grant for the student → `not_linked`; a Home Graph refusal
// → `open_<reason>` / `close_<reason>` so the log says which half broke.
//
// The SYNC/QUERY/EXECUTE fulfillment lives in `./google/fulfillment.ts` — this
// file only reports state.

import type { HomeAction } from "@shared/schema";
import type { HomeActionContext, HomeActionOutcome, HomeActionProvider, SmartHomeProvider } from "./types";
import { findAccountLink, type AccountLinkGrant } from "./account-link-service";
import { homeGraphClient, type HomeGraphClient } from "./google/homegraph-client";
import {
  GOOGLE_TRIGGER_OPEN_STATE,
  GOOGLE_TRIGGER_RESTING_STATE,
} from "./google/fulfillment";

/** Collaborators, injected so the trigger can be driven with fakes in tests. */
export interface GoogleTriggerDeps {
  homegraph: HomeGraphClient;
  findLink(studentId: string, provider: SmartHomeProvider): Promise<AccountLinkGrant | null>;
}

export function createGoogleTriggerProvider(deps: GoogleTriggerDeps): HomeActionProvider {
  return {
    async execute(action: HomeAction, ctx: HomeActionContext): Promise<HomeActionOutcome> {
      const studentId = ctx?.studentId ?? "";
      if (!studentId) return { kind: 'failed', reason: 'no_student' };
      if (!action?.id) return { kind: 'failed', reason: 'no_action_id' };

      try {
        // Do we have Home Graph credentials to push state with? This is checked
        // FIRST on purpose: with no service account there is no Google project,
        // so there can be no grant either, and `not_configured` names the real
        // problem (a deployment gap) instead of blaming the family for not
        // linking. It is also the reason the whole slice reports until the
        // developer account exists — and it saves a pointless vault read.
        if (!deps.homegraph.isConfigured()) return { kind: 'failed', reason: 'not_configured' };

        // Configured, so an absent grant really does mean "not linked yet".
        const link = await deps.findLink(studentId, 'google');
        if (!link) return { kind: 'failed', reason: 'not_linked' };

        // `agentUserId` is the studentId — the same value SYNC reports.
        const agentUserId = link.studentId || studentId;

        const opened = await deps.homegraph.reportState(agentUserId, {
          [action.id]: { ...GOOGLE_TRIGGER_OPEN_STATE },
        });
        if (!opened.ok) {
          console.error(
            `[GoogleTrigger] Could not open "${action.id}" for student ${studentId}: ${opened.reason}`,
            opened.detail ?? "",
          );
          return { kind: 'failed', reason: `open_${opened.reason}` };
        }

        // Rearm. If this half fails the automation still ran, but the sensor is
        // stuck open and the NEXT press would produce no edge — so report the
        // press as failed rather than let it silently stop working.
        const closed = await deps.homegraph.reportState(agentUserId, {
          [action.id]: { ...GOOGLE_TRIGGER_RESTING_STATE },
        });
        if (!closed.ok) {
          console.error(
            `[GoogleTrigger] Could not rearm "${action.id}" for student ${studentId}: ${closed.reason}`,
            closed.detail ?? "",
          );
          return { kind: 'failed', reason: `close_${closed.reason}` };
        }

        return { kind: 'triggered' };
      } catch (error: any) {
        console.error(
          `[GoogleTrigger] Home action "${action.id}" threw for student ${studentId}:`,
          error?.message || error,
        );
        return { kind: 'failed', reason: 'google_error' };
      }
    },
  };
}

export const googleTriggerProvider: HomeActionProvider = createGoogleTriggerProvider({
  homegraph: homeGraphClient,
  findLink: findAccountLink,
});
