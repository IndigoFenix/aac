// server/services/dual-agent/home-action-service.ts
//
// Smart-home action dispatch — the PROVIDER SEAM's registry. Every home-action
// press goes through executeHomeAction, which routes on `action.type` to a
// provider and returns an outcome. Nothing here throws into the press path.
//
// `spoken` actuates on the CLIENT, which utters the command through the
// student-voice press pipeline (zero latency, offline-capable, mic-gated); the
// server's only job for that type is the audit/event side, handled by the
// caller. The `alexa`/`google` cloud providers live in
// `server/services/smart-home/` and fire the slot's virtual-trigger event
// server-side — they are registered but STUBBED until the developer accounts
// and env secrets exist (see planning-docs/smart-home-actions.md). No cloud
// code or credential handling belongs in THIS file: it only routes.

import type { HomeAction } from "@shared/schema";
import type { HomeActionContext, HomeActionOutcome, HomeActionProvider } from "../smart-home/types";
import { alexaTriggerProvider } from "../smart-home/alexa-trigger-provider";
import { googleTriggerProvider } from "../smart-home/google-trigger-provider";

// The seam's vocabulary lives in one place (smart-home/types) so providers and
// fulfillment handlers can import it without pulling in this registry; it is
// re-exported here because this module is the seam's public face.
export type { HomeActionContext, HomeActionOutcome, HomeActionProvider };

/** The device speaks; nothing to do server-side. */
const spokenProvider: HomeActionProvider = {
  async execute(): Promise<HomeActionOutcome> {
    return { kind: 'client_spoken' };
  },
};

const PROVIDERS: Record<string, HomeActionProvider> = {
  spoken: spokenProvider,
  alexa: alexaTriggerProvider,
  google: googleTriggerProvider,
};

/** Dispatch a home action to its provider. Unknown types fail softly. */
export async function executeHomeAction(
  action: HomeAction,
  ctx: HomeActionContext,
): Promise<HomeActionOutcome> {
  try {
    const provider = action ? PROVIDERS[action.type] : undefined;
    if (!provider) return { kind: 'failed', reason: 'unknown_type' };
    return await provider.execute(action, ctx);
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : 'provider_error' };
  }
}
