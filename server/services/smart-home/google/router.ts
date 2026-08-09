// server/services/smart-home/google/router.ts
//
// The Express seam for Google cloud-to-cloud fulfillment. Google posts EVERY
// intent (SYNC / QUERY / EXECUTE / DISCONNECT) to a single HTTPS endpoint, so
// this router owns exactly one route.
//
// NOT MOUNTED HERE. Route mounting for the smart-home endpoints is centralized
// (planning-docs/smart-home-actions.md — "provider agents export routers; the
// main session mounts them"). The intended mount is:
//
//     app.use("/api/smart-home/google", googleSmartHomeRouter);
//     ⇒ POST /api/smart-home/google/fulfillment   (the URL registered in the
//                                                  Google console)
//
// No auth middleware belongs in front of it: Google authenticates with the
// bearer token WE issued during account linking, not with a session cookie, so
// the route resolves that bearer itself.
//
// Importing this module must stay side-effect-free beyond building the router —
// no env reads, no timers, no connections at import time.

import express from "express";
import { normalizeHomeActions } from "@shared/home-actions";
import { aacSettingsRepository } from "../../../repositories";
import { resolveAccountLinkBearer, revokeAccountLink } from "../account-link-service";
import { handleGoogleFulfillment, type GoogleFulfillmentDeps } from "./fulfillment";
import { homeGraphClient, HOMEGRAPH_SERVICE_ACCOUNT_ENV } from "./homegraph-client";

/** `Authorization: Bearer <token>` → the token, or "". */
function bearerToken(header: unknown): string {
  if (typeof header !== "string") return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

/**
 * The REAL dependencies. Reading a student's slots outside a live session is
 * the settings-only accessor + the shared sanitizer — the same normalization
 * `dual-agent-service.ts` applies in-session, never the raw jsonb.
 */
export function googleFulfillmentDeps(): GoogleFulfillmentDeps {
  return {
    async loadHomeActions(studentId) {
      const settings = await aacSettingsRepository.getByStudentId(studentId);
      return normalizeHomeActions(settings?.homeActions);
    },
    homegraph: homeGraphClient,
    revokeAccountLink,
  };
}

const router = express.Router();

router.post("/fulfillment", async (req, res) => {
  // DORMANT until the Google developer account exists. Answering intents while
  // we cannot push state back would hand Google a half-working integration.
  if (!homeGraphClient.isConfigured()) {
    return res.status(503).json({ error: "google_smart_home_not_configured" });
  }

  const token = bearerToken(req.headers.authorization);
  if (!token) {
    return res.status(401).json({ error: "missing_bearer_token" });
  }

  try {
    const identity = await resolveAccountLinkBearer(token);
    // Unknown/expired/revoked token, or a bearer minted for the OTHER
    // ecosystem — never answer with an empty device list, which Google would
    // read as "this user owns nothing" and prune their devices.
    if (!identity || identity.provider !== "google") {
      return res.status(401).json({ error: "invalid_bearer_token" });
    }

    const response = await handleGoogleFulfillment(
      req.body,
      { studentId: identity.studentId },
      googleFulfillmentDeps(),
    );
    return res.json(response);
  } catch (error: any) {
    console.error("[GoogleSmartHome] Fulfillment error:", error?.message || error);
    return res.status(500).json({ error: "fulfillment_failed" });
  }
});

export { router as googleSmartHomeRouter, HOMEGRAPH_SERVICE_ACCOUNT_ENV };
