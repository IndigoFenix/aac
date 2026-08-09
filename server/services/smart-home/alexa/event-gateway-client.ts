// server/services/smart-home/alexa/event-gateway-client.ts
//
// ALEXA EVENT GATEWAY — the OUTBOUND half of the smart home skill.
//
// `directive-handler.ts` answers Alexa's questions; this file is how WE push to
// Alexa. There is exactly one thing to push: a `DoorbellPress` for a student's
// virtual trigger endpoint, which is what actually runs the family's routine.
//
// Verified against developer.amazon.com (2026-08):
//   POST {gateway}/v3/events
//        Authorization: Bearer {access-token-from-Amazon}
//        Content-Type: application/json
//   202 Accepted = "the event was accepted for further logical validation and
//   processing" — the ONLY success. ("smarthome/send-events.html")
//   The doc is explicit that the token goes in BOTH places: "Include the access
//   token in the request header and in the body of the message" — hence
//   `event.endpoint.scope`. ("smarthome/send-events.html")
//   DoorbellPress body: namespace `Alexa.DoorbellEventSource`, name
//   `DoorbellPress`, payloadVersion "3", `payload = {cause:{type:
//   "PHYSICAL_INTERACTION"}, timestamp}`, `context = {}`.
//   ("device-apis/alexa-doorbelleventsource.html")
//   LWA: POST https://api.amazon.com/auth/o2/token, form-encoded,
//   `grant_type=authorization_code&code=…&client_id=…&client_secret=…`
//   ("Don't include a `redirect_uri` in the access token request"), and
//   `grant_type=refresh_token&refresh_token=…&client_id=…&client_secret=…`.
//   Response: {access_token, token_type:"bearer", expires_in, refresh_token}.
//   ("login-with-amazon/authorization-code-grant.html",
//    "smarthome/authenticate-a-customer-permissions.html")
//
// ── ENV CONTRACT ────────────────────────────────────────────────────────────
//   ALEXA_CLIENT_ID       (required)  The LWA client id from the skill's
//                                     Permissions page ("Alexa Skill Messaging"
//                                     credentials — these are the EVENT-GATEWAY
//                                     credentials Amazon issues us, NOT the
//                                     client id/secret we issue to Amazon for
//                                     account linking, which are
//                                     account-link-service's business).
//   ALEXA_CLIENT_SECRET   (required)  Its secret.
//   ALEXA_EVENT_GATEWAY_URL (optional) Full events URL for the customer's
//                                     region. Defaults to North America:
//                                       NA            https://api.amazonalexa.com/v3/events
//                                       EU + India    https://api.eu.amazonalexa.com/v3/events
//                                       FE + Australia https://api.fe.amazonalexa.com/v3/events
//                                     Posting to the WRONG region is the known
//                                     cause of a 403 that looks like "the user
//                                     never enabled your skill".
//
// Either credential UNSET ⇒ `isConfigured()` is false and every call soft-fails
// with `{ok:false, reason:'not_configured'}` — the state this whole slice ships
// in until an Amazon developer account exists.
//
// NO NEW DEPENDENCIES: plain `fetch`, no SDK. NEVER THROWS — a home-action press
// must not be able to blow up on an Amazon outage.
//
// See planning-docs/smart-home-actions.md ("Phase 1 framework").

import { randomUUID } from "crypto";
import {
  deleteConnection,
  getDecryptedTokens,
  upsertConnection,
} from "../../externalConnectionsService";

/** The env vars this module reads. Documented in the header. */
export const ALEXA_CLIENT_ID_ENV = "ALEXA_CLIENT_ID";
export const ALEXA_CLIENT_SECRET_ENV = "ALEXA_CLIENT_SECRET";
export const ALEXA_EVENT_GATEWAY_URL_ENV = "ALEXA_EVENT_GATEWAY_URL";

/** Regional events endpoints, for whoever fills in the env var. */
export const ALEXA_EVENT_GATEWAY_URLS = {
  na: "https://api.amazonalexa.com/v3/events",
  eu: "https://api.eu.amazonalexa.com/v3/events",
  fe: "https://api.fe.amazonalexa.com/v3/events",
} as const;

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

/** Refresh this long before the stored token actually expires. */
const TOKEN_SKEW_MS = 60_000;

/** The vault provider key these tokens live under. */
const PROVIDER = "alexa" as const;

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** What LWA hands back, in our units (absolute expiry beats a relative TTL). */
export interface LwaTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms at which `accessToken` stops working. */
  expiresAtMs: number;
}

/**
 * Why a gateway call did not happen.
 *  - `not_configured` — no client credentials in env (the DORMANT state).
 *  - `not_linked`     — configured, but this student has no stored grant.
 *  - `unlinked`       — we HAD a grant and Amazon says it is dead (skill
 *                       disabled, refresh token revoked). The stored connection
 *                       is deleted when this is returned.
 *  - `auth_failed`    — LWA refused for some other reason; the grant is kept.
 */
export type AlexaGatewayFailureReason =
  | "not_configured"
  | "not_linked"
  | "unlinked"
  | "auth_failed"
  | "insufficient_permission"
  | "invalid_request"
  | "throttled"
  | "http_error"
  | "network_error";

export type AlexaGatewayResult = { ok: true } | { ok: false; reason: AlexaGatewayFailureReason; detail?: string };

export type LwaExchangeResult =
  | { ok: true; tokens: LwaTokenSet }
  | { ok: false; reason: AlexaGatewayFailureReason; detail?: string };

export interface AlexaEventGateway {
  /** True when both client credentials are present in env. Read LAZILY. */
  isConfigured(): boolean;
  /** AcceptGrant's one-time code → the event-gateway token pair. */
  exchangeGrantCode(code: string): Promise<LwaExchangeResult>;
  /** Fire the virtual doorbell bound to `endpointId` for this student. */
  sendDoorbellPress(studentId: string, endpointId: string): Promise<AlexaGatewayResult>;
}

// ---------------------------------------------------------------------------
// Injected collaborators (so the HTTP paths are testable without a database)
// ---------------------------------------------------------------------------

export interface StoredAlexaTokens {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: Date | null;
}

export interface AlexaEventGatewayDeps {
  /** Read the student's decrypted `alexa` tokens, or null when unlinked. */
  getTokens(studentId: string): Promise<StoredAlexaTokens | null>;
  /** Persist a freshly minted/rotated pair. */
  saveTokens(studentId: string, tokens: LwaTokenSet): Promise<void>;
  /** Drop the whole connection — the grant is dead, keeping it is a liability. */
  dropTokens(studentId: string): Promise<void>;
  /** Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface ClientCredentials {
  clientId: string;
  clientSecret: string;
  eventsUrl: string;
}

function loadCredentials(): ClientCredentials | null {
  const clientId = (process.env[ALEXA_CLIENT_ID_ENV] ?? "").trim();
  const clientSecret = (process.env[ALEXA_CLIENT_SECRET_ENV] ?? "").trim();
  if (!clientId || !clientSecret) return null;
  const eventsUrl = (process.env[ALEXA_EVENT_GATEWAY_URL_ENV] ?? "").trim() || ALEXA_EVENT_GATEWAY_URLS.na;
  return { clientId, clientSecret, eventsUrl };
}

// ---------------------------------------------------------------------------
// LWA
// ---------------------------------------------------------------------------

interface LwaTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/**
 * One LWA token call. `invalid_grant` is singled out because it is the ONLY
 * answer that means the grant is permanently gone (the family disabled the
 * skill or revoked us) — everything else may be transient and must not cost the
 * student their link.
 */
async function callLwa(
  creds: ClientCredentials,
  form: Record<string, string>,
  doFetch: typeof fetch,
): Promise<LwaExchangeResult> {
  let response: Response;
  try {
    response = await doFetch(LWA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({
        ...form,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }).toString(),
    });
  } catch (error: any) {
    return { ok: false, reason: "network_error", detail: error?.message || String(error) };
  }

  let json: LwaTokenResponse = {};
  try {
    json = (await response.json()) as LwaTokenResponse;
  } catch {
    json = {};
  }

  if (!response.ok || !json.access_token || !json.refresh_token) {
    const detail = `${response.status} ${json.error ?? ""} ${json.error_description ?? ""}`.trim();
    // A revoked/expired grant is terminal; the caller deletes the connection.
    if (json.error === "invalid_grant") return { ok: false, reason: "unlinked", detail };
    return { ok: false, reason: "auth_failed", detail };
  }

  const lifetimeSeconds = typeof json.expires_in === "number" ? json.expires_in : 3600;
  return {
    ok: true,
    tokens: {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAtMs: Date.now() + lifetimeSeconds * 1000,
    },
  };
}

// ---------------------------------------------------------------------------
// Event gateway
// ---------------------------------------------------------------------------

/** The DoorbellPress body, exported so tests and the docs agree on one shape. */
export function doorbellPressEvent(endpointId: string, accessToken: string): Record<string, unknown> {
  return {
    context: {},
    event: {
      header: {
        messageId: randomUUID(),
        namespace: "Alexa.DoorbellEventSource",
        name: "DoorbellPress",
        payloadVersion: "3",
      },
      endpoint: {
        // The doc requires the token in the header AND here.
        scope: { type: "BearerToken", token: accessToken },
        endpointId,
      },
      payload: {
        cause: { type: "PHYSICAL_INTERACTION" },
        timestamp: new Date().toISOString(),
      },
    },
  };
}

function classifyGatewayError(status: number, body: string): AlexaGatewayFailureReason {
  if (status === 401) return "auth_failed";
  if (status === 403) {
    // The one 403 that is OUR fault: the skill was never granted the
    // send-events permission. Deleting the family's grant over a console
    // misconfiguration would make them re-link for nothing.
    if (body.includes("INSUFFICIENT_PERMISSION_EXCEPTION")) return "insufficient_permission";
    // Everything else — SKILL_DISABLED_EXCEPTION, SKILL_NEVER_ENABLED_EXCEPTION,
    // or an unrecognised 403 — means Amazon will not carry events for this
    // customer any more, i.e. the grant we hold is stale.
    return "unlinked";
  }
  if (status === 400) return "invalid_request";
  if (status === 429) return "throttled";
  return "http_error";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAlexaEventGateway(deps: AlexaEventGatewayDeps): AlexaEventGateway {
  const doFetch: typeof fetch = deps.fetchImpl ?? ((...args) => fetch(...args));

  /** Refresh + PERSIST the rotation. LWA rotates the refresh token on every
   *  call, so failing to write the new one back would strand the student on a
   *  refresh token Amazon has already retired. */
  async function refresh(
    studentId: string,
    creds: ClientCredentials,
    refreshToken: string,
  ): Promise<LwaExchangeResult> {
    const result = await callLwa(
      creds,
      { grant_type: "refresh_token", refresh_token: refreshToken },
      doFetch,
    );
    if (result.ok) {
      await deps.saveTokens(studentId, result.tokens);
      return result;
    }
    if (result.reason === "unlinked") {
      await deps.dropTokens(studentId);
    }
    return result;
  }

  return {
    isConfigured(): boolean {
      return loadCredentials() !== null;
    },

    async exchangeGrantCode(code: string): Promise<LwaExchangeResult> {
      const creds = loadCredentials();
      if (!creds) return { ok: false, reason: "not_configured" };
      if (!code) return { ok: false, reason: "invalid_request", detail: "no grant code" };
      // No redirect_uri: the doc is explicit that the AcceptGrant exchange must
      // not send one.
      return callLwa(creds, { grant_type: "authorization_code", code }, doFetch);
    },

    async sendDoorbellPress(studentId: string, endpointId: string): Promise<AlexaGatewayResult> {
      if (!studentId) return { ok: false, reason: "invalid_request", detail: "no studentId" };
      if (!endpointId) return { ok: false, reason: "invalid_request", detail: "no endpointId" };

      // Checked FIRST: with no client credentials there is no skill, so there
      // can be no grant either, and `not_configured` names the real problem (a
      // deployment gap) instead of blaming the family for not linking. It also
      // saves a pointless vault read.
      const creds = loadCredentials();
      if (!creds) return { ok: false, reason: "not_configured" };

      const stored = await deps.getTokens(studentId);
      if (!stored || (!stored.accessToken && !stored.refreshToken)) {
        return { ok: false, reason: "not_linked" };
      }

      let accessToken = stored.accessToken ?? "";
      const expiresAtMs = stored.tokenExpiresAt ? stored.tokenExpiresAt.getTime() : 0;
      const expired = !accessToken || !expiresAtMs || expiresAtMs - TOKEN_SKEW_MS <= Date.now();

      if (expired) {
        if (!stored.refreshToken) return { ok: false, reason: "not_linked", detail: "expired, no refresh token" };
        const refreshed = await refresh(studentId, creds, stored.refreshToken);
        if (!refreshed.ok) return { ok: false, reason: refreshed.reason, detail: refreshed.detail };
        accessToken = refreshed.tokens.accessToken;
      }

      // One retry, and only for a 401: Amazon rejecting a token we believed was
      // live means our clock or their revocation beat us, and a single refresh
      // fixes it. Anything else retried here would just double the load on an
      // already-failing call.
      for (let attempt = 0; attempt < 2; attempt++) {
        let response: Response;
        try {
          response = await doFetch(creds.eventsUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(doorbellPressEvent(endpointId, accessToken)),
          });
        } catch (error: any) {
          return { ok: false, reason: "network_error", detail: error?.message || String(error) };
        }

        if (response.status === 202 || response.ok) return { ok: true };

        const body = await response.text().catch(() => "");
        const reason = classifyGatewayError(response.status, body);

        if (reason === "auth_failed" && attempt === 0 && stored.refreshToken && !expired) {
          const refreshed = await refresh(studentId, creds, stored.refreshToken);
          if (!refreshed.ok) return { ok: false, reason: refreshed.reason, detail: refreshed.detail };
          accessToken = refreshed.tokens.accessToken;
          continue;
        }

        // The customer's link is gone — stop holding a secret we may never use.
        if (reason === "unlinked") await deps.dropTokens(studentId);

        return { ok: false, reason, detail: `${response.status} ${body.substring(0, 200)}`.trim() };
      }

      return { ok: false, reason: "auth_failed", detail: "token refused after refresh" };
    },
  };
}

// ---------------------------------------------------------------------------
// The real instance — bound to the encrypted vault
// ---------------------------------------------------------------------------

export const alexaEventGateway: AlexaEventGateway = createAlexaEventGateway({
  async getTokens(studentId) {
    return getDecryptedTokens(studentId, PROVIDER);
  },
  async saveTokens(studentId, tokens) {
    await upsertConnection(studentId, PROVIDER, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: new Date(tokens.expiresAtMs),
    });
  },
  async dropTokens(studentId) {
    await deleteConnection(studentId, PROVIDER);
  },
});
