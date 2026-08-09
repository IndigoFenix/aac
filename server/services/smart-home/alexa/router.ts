// server/services/smart-home/alexa/router.ts
//
// The Express seam for Alexa smart home fulfillment — FOR DEV / TUNNEL TESTING.
//
// ⚠️ A production Alexa smart home skill CANNOT use an HTTPS endpoint. Amazon
// requires the skill's fulfillment to be an AWS LAMBDA (an ARN configured in the
// developer console) — unlike Google cloud-to-cloud, which accepts an HTTPS URL.
// This router exists so the handler can be exercised locally over a tunnel
// (ngrok + a hand-rolled POST, or the synthetic directives in
// `server/tests/smart-home-alexa.test.ts`) before any Amazon account exists.
//
// The future Terraform adds a thin Lambda wrapper that imports the SAME
// `handleAlexaDirective` and the SAME `alexaDirectiveDeps()`; that is the entire
// point of keeping the handler transport-agnostic. Nothing skill-specific may
// accumulate in this file.
//
// NOT MOUNTED HERE. Route mounting for the smart-home endpoints is centralized
// (planning-docs/smart-home-actions.md — "provider agents export routers; the
// main session mounts them"). The intended dev mount is:
//
//     app.use("/api/smart-home/alexa", alexaSmartHomeRouter);
//     ⇒ POST /api/smart-home/alexa/directives
//
// No auth middleware belongs in front of it: Alexa authenticates with the bearer
// token WE issued during account linking, carried INSIDE the directive envelope
// (`payload.scope` for Discovery, `endpoint.scope` otherwise) rather than in an
// Authorization header, so the handler resolves it itself.
//
// Importing this module must stay side-effect-free beyond building the router —
// no env reads, no timers, no connections at import time.

import express from "express";
import { normalizeHomeActions } from "@shared/home-actions";
import { aacSettingsRepository } from "../../../repositories";
import { upsertConnection } from "../../externalConnectionsService";
import { resolveAccountLinkBearer } from "../account-link-service";
import { handleAlexaDirective, type AlexaDirectiveDeps } from "./directive-handler";
import {
  alexaEventGateway,
  ALEXA_CLIENT_ID_ENV,
  ALEXA_CLIENT_SECRET_ENV,
  ALEXA_EVENT_GATEWAY_URL_ENV,
} from "./event-gateway-client";

/**
 * The REAL dependencies — shared verbatim with the future Lambda wrapper.
 *
 * Reading a student's slots outside a live session is the settings-only
 * accessor + the shared sanitizer, the same normalization
 * `dual-agent-service.ts` applies in-session, never the raw jsonb.
 */
export function alexaDirectiveDeps(): AlexaDirectiveDeps {
  return {
    resolveBearer: resolveAccountLinkBearer,
    async loadHomeActions(studentId) {
      const settings = await aacSettingsRepository.getByStudentId(studentId);
      return normalizeHomeActions(settings?.homeActions);
    },
    exchangeGrantCode: (code) => alexaEventGateway.exchangeGrantCode(code),
    async storeEventGatewayTokens(studentId, tokens) {
      // Encrypted app-side by the vault. `tokenExpiresAt` is absolute so the
      // gateway client can decide staleness without re-deriving a TTL.
      await upsertConnection(studentId, "alexa", {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: new Date(tokens.expiresAtMs),
      });
    },
  };
}

const router = express.Router();

router.post("/directives", async (req, res) => {
  // DORMANT until the Amazon developer account exists. Answering directives
  // while we cannot push events back would hand Alexa a half-working skill:
  // endpoints would appear in the family's app and no press would ever ring.
  if (!alexaEventGateway.isConfigured()) {
    return res.status(503).json({ error: "alexa_smart_home_not_configured" });
  }

  try {
    // The handler never throws and speaks Alexa's own error shapes, so every
    // outcome — including an unknown directive — is an HTTP 200 carrying an
    // `event` envelope. That is what a Lambda would return too.
    const response = await handleAlexaDirective(req.body, alexaDirectiveDeps());
    return res.json(response);
  } catch (error: any) {
    console.error("[AlexaSmartHome] Directive route error:", error?.message || error);
    return res.status(500).json({ error: "fulfillment_failed" });
  }
});

export {
  router as alexaSmartHomeRouter,
  ALEXA_CLIENT_ID_ENV,
  ALEXA_CLIENT_SECRET_ENV,
  ALEXA_EVENT_GATEWAY_URL_ENV,
};
