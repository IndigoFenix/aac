// server/services/smart-home/alexa-trigger-provider.ts
//
// Alexa cloud provider — fires the virtual-trigger event bound to a slot.
//
// One enabled `alexa` slot is one virtual DOORBELL endpoint in the family's
// Alexa account (the endpointId IS `action.id`). A press posts a single
// `DoorbellPress` to the Alexa event gateway; the family has bound that doorbell
// as the "When this happens" trigger of a routine they authored themselves, and
// Alexa runs it. Unlike the Google contact sensor there is no state to rearm —
// a doorbell press is an EVENT, so one call is the whole actuation.
//
// Everything is AWAITED inside the invocation. This server runs on AWS Lambda,
// which freezes the container the moment the response is written: a `setTimeout`
// or a detached promise would silently never run, and the press would look
// successful while nothing fired.
//
// Soft-fail contract: never throws into the press path. No client credentials in
// env → `not_configured` (the state this slice ships in until an Amazon
// developer account exists, and the check that runs FIRST); configured but no
// stored grant → `not_linked`; a gateway refusal → its typed reason.
//
// Discovery / AcceptGrant / ReportState — everything INBOUND — lives in
// `./alexa/directive-handler.ts`. This file only reports events.

import type { HomeAction } from "@shared/schema";
import type { HomeActionContext, HomeActionOutcome, HomeActionProvider } from "./types";
import { alexaEventGateway, type AlexaEventGateway } from "./alexa/event-gateway-client";

/** Collaborators, injected so the trigger can be driven with fakes in tests. */
export interface AlexaTriggerDeps {
  gateway: AlexaEventGateway;
}

export function createAlexaTriggerProvider(deps: AlexaTriggerDeps): HomeActionProvider {
  return {
    async execute(action: HomeAction, ctx: HomeActionContext): Promise<HomeActionOutcome> {
      const studentId = ctx?.studentId ?? "";
      if (!studentId) return { kind: 'failed', reason: 'no_student' };
      if (!action?.id) return { kind: 'failed', reason: 'no_action_id' };

      try {
        // See the header: credentials before grant, so the reason names the
        // real gap. The gateway re-checks this, but asking here keeps the
        // ordering explicit and skips a vault read.
        if (!deps.gateway.isConfigured()) return { kind: 'failed', reason: 'not_configured' };

        const result = await deps.gateway.sendDoorbellPress(studentId, action.id);
        if (result.ok) return { kind: 'triggered' };

        console.error(
          `[AlexaTrigger] Could not ring "${action.id}" for student ${studentId}: ${result.reason}`,
          result.detail ?? "",
        );
        return { kind: 'failed', reason: result.reason };
      } catch (error: any) {
        console.error(
          `[AlexaTrigger] Home action "${action.id}" threw for student ${studentId}:`,
          error?.message || error,
        );
        return { kind: 'failed', reason: 'alexa_error' };
      }
    },
  };
}

export const alexaTriggerProvider: HomeActionProvider = createAlexaTriggerProvider({
  gateway: alexaEventGateway,
});
