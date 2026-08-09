// server/services/smart-home/google/homegraph-client.ts
//
// HOME GRAPH API client — the OUTBOUND half of the Google cloud-to-cloud
// integration. Fulfillment (SYNC/QUERY/EXECUTE) answers Google's requests;
// this file is how WE push to Google:
//
//   - `devices:reportStateAndNotification` — tells Home Graph a virtual trigger
//     device changed state. This is what actually fires a family's automation.
//   - `devices:requestSync` — asks Google to re-run SYNC for a student after
//     their home-action slots change (add/remove/rename). Google REQUIRES an
//     integration to implement Request Sync before submission.
//
// Verified against developers.home.google.com (2026-08):
//   POST https://homegraph.googleapis.com/v1/devices:reportStateAndNotification
//        { requestId, agentUserId, payload: { devices: { states: { "<id>": {...} } } } }
//   POST https://homegraph.googleapis.com/v1/devices:requestSync
//        { agentUserId, async }
//   OAuth scope: https://www.googleapis.com/auth/homegraph (service-account JWT flow).
//   Report State overwrites per-TRAIT, so every call sends the COMPLETE state
//   for the trait it touches — never a partial patch.
//
// ── ENV CONTRACT ────────────────────────────────────────────────────────────
//   GOOGLE_HOMEGRAPH_SERVICE_ACCOUNT   (the ONLY variable this module reads)
//     The Home Graph service-account key, either as raw JSON or as its base64
//     encoding (base64 is friendlier to Lambda env vars / GitHub secrets, which
//     mangle embedded newlines in `private_key`). Both forms are accepted.
//     Required members: `client_email`, `private_key`. Optional: `token_uri`
//     (defaults to https://oauth2.googleapis.com/token).
//     UNSET ⇒ `isConfigured()` is false and every call soft-fails with
//     `{ok:false, reason:'not_configured'}` — which is the state the whole
//     Google slice ships in until a developer account exists.
//
// NO NEW DEPENDENCIES: neither `googleapis` nor `google-auth-library` is a
// declared dependency of this repo, so the service-account JWT is signed here
// with node `crypto` (RS256) and exchanged with plain `fetch`.
//
// NEVER THROWS. Every entry point returns a typed result; a home-action press
// must not be able to blow up on a Google outage.
//
// See planning-docs/smart-home-actions.md ("Phase 1 framework").

import { createSign, randomUUID } from "crypto";

/** The env var carrying the service-account key. Documented in the header. */
export const HOMEGRAPH_SERVICE_ACCOUNT_ENV = "GOOGLE_HOMEGRAPH_SERVICE_ACCOUNT";

const HOMEGRAPH_SCOPE = "https://www.googleapis.com/auth/homegraph";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const REPORT_STATE_URL =
  "https://homegraph.googleapis.com/v1/devices:reportStateAndNotification";
const REQUEST_SYNC_URL = "https://homegraph.googleapis.com/v1/devices:requestSync";

/** Refresh the access token this many ms before it actually expires. */
const TOKEN_SKEW_MS = 60_000;

/** One device's trait state, as Home Graph stores it (`{openPercent: 0, online: true}`). */
export type HomeGraphDeviceState = Record<string, unknown>;

/**
 * Why a Home Graph call did not happen. `not_configured` is the DORMANT state
 * (no service account in env) and is the only one expected before the Google
 * developer account exists.
 */
export type HomeGraphFailureReason =
  | "not_configured"
  | "bad_credentials"
  | "auth_failed"
  | "http_error"
  | "network_error";

export type HomeGraphResult =
  | { ok: true }
  | { ok: false; reason: HomeGraphFailureReason; detail?: string };

export interface HomeGraphClient {
  /** True when a usable service-account key is present in env. Read LAZILY. */
  isConfigured(): boolean;
  /**
   * Push complete trait state for one or more devices.
   * `agentUserId` is the studentId (see the SYNC handler — same value).
   */
  reportState(
    agentUserId: string,
    states: Record<string, HomeGraphDeviceState>,
  ): Promise<HomeGraphResult>;
  /** Ask Google to re-run SYNC for this student (slot list changed). */
  requestSyncForStudent(agentUserId: string): Promise<HomeGraphResult>;
}

interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** Cache the parse keyed by the RAW env string, so a changed env re-parses. */
let credentialCache: { raw: string; account: ServiceAccount | null } | null = null;

/**
 * Accept either raw JSON or base64-encoded JSON. Lambda env vars and CI secret
 * stores routinely mangle the literal newlines inside `private_key`, so the
 * base64 form is the one we expect in production.
 */
function decodeServiceAccountJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
  if (!decoded.startsWith("{")) throw new Error("not JSON or base64 JSON");
  return JSON.parse(decoded);
}

function loadServiceAccount(): ServiceAccount | null {
  const raw = process.env[HOMEGRAPH_SERVICE_ACCOUNT_ENV];
  if (!raw || !raw.trim()) {
    credentialCache = null;
    return null;
  }
  if (credentialCache && credentialCache.raw === raw) return credentialCache.account;

  let account: ServiceAccount | null = null;
  try {
    const parsed = decodeServiceAccountJson(raw) as Record<string, unknown>;
    const clientEmail = typeof parsed.client_email === "string" ? parsed.client_email : "";
    // Secret stores often store the PEM with escaped newlines — unescape them.
    const privateKey =
      typeof parsed.private_key === "string" ? parsed.private_key.replace(/\\n/g, "\n") : "";
    if (!clientEmail || !privateKey) {
      throw new Error("missing client_email or private_key");
    }
    account = {
      clientEmail,
      privateKey,
      tokenUri: typeof parsed.token_uri === "string" && parsed.token_uri
        ? parsed.token_uri
        : DEFAULT_TOKEN_URI,
    };
  } catch (error: any) {
    // A malformed key is a DEPLOYMENT error, not a press-time error: log once
    // per distinct value and stay dormant rather than throwing into a press.
    console.error(
      `[HomeGraph] ${HOMEGRAPH_SERVICE_ACCOUNT_ENV} is set but unusable ` +
        `(staying dormant):`,
      error?.message || error,
    );
    account = null;
  }
  credentialCache = { raw, account };
  return account;
}

// ---------------------------------------------------------------------------
// Service-account JWT → OAuth access token
// ---------------------------------------------------------------------------

let tokenCache: { clientEmail: string; token: string; expiresAtMs: number } | null = null;

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Sign the RS256 assertion Google's token endpoint expects. */
function buildAssertion(account: ServiceAccount): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: HOMEGRAPH_SCOPE,
      aud: account.tokenUri,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(account.privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

type TokenResult = { ok: true; token: string } | { ok: false; reason: HomeGraphFailureReason; detail?: string };

async function getAccessToken(account: ServiceAccount): Promise<TokenResult> {
  const cached = tokenCache;
  if (cached && cached.clientEmail === account.clientEmail && cached.expiresAtMs > Date.now()) {
    return { ok: true, token: cached.token };
  }

  let assertion: string;
  try {
    assertion = buildAssertion(account);
  } catch (error: any) {
    return { ok: false, reason: "bad_credentials", detail: error?.message || String(error) };
  }

  try {
    const response = await fetch(account.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        reason: "auth_failed",
        detail: `${response.status} ${text.substring(0, 200)}`,
      };
    }
    const json = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!json?.access_token) {
      return { ok: false, reason: "auth_failed", detail: "no access_token in response" };
    }
    const lifetimeMs = (typeof json.expires_in === "number" ? json.expires_in : 3600) * 1000;
    tokenCache = {
      clientEmail: account.clientEmail,
      token: json.access_token,
      expiresAtMs: Date.now() + Math.max(0, lifetimeMs - TOKEN_SKEW_MS),
    };
    return { ok: true, token: json.access_token };
  } catch (error: any) {
    return { ok: false, reason: "network_error", detail: error?.message || String(error) };
  }
}

// ---------------------------------------------------------------------------
// Home Graph calls
// ---------------------------------------------------------------------------

async function postToHomeGraph(url: string, body: unknown): Promise<HomeGraphResult> {
  const account = loadServiceAccount();
  if (!account) return { ok: false, reason: "not_configured" };

  const token = await getAccessToken(account);
  if (!token.ok) return { ok: false, reason: token.reason, detail: token.detail };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // A 401 means our cached token is no longer good — drop it so the next
      // call re-mints rather than repeating the same rejected bearer.
      if (response.status === 401) tokenCache = null;
      return {
        ok: false,
        reason: "http_error",
        detail: `${response.status} ${text.substring(0, 200)}`,
      };
    }
    return { ok: true };
  } catch (error: any) {
    return { ok: false, reason: "network_error", detail: error?.message || String(error) };
  }
}

export const homeGraphClient: HomeGraphClient = {
  isConfigured(): boolean {
    return loadServiceAccount() !== null;
  },

  async reportState(
    agentUserId: string,
    states: Record<string, HomeGraphDeviceState>,
  ): Promise<HomeGraphResult> {
    if (!agentUserId) return { ok: false, reason: "bad_credentials", detail: "no agentUserId" };
    if (!states || Object.keys(states).length === 0) return { ok: true };
    return postToHomeGraph(REPORT_STATE_URL, {
      requestId: randomUUID(),
      agentUserId,
      payload: { devices: { states } },
    });
  },

  async requestSyncForStudent(agentUserId: string): Promise<HomeGraphResult> {
    if (!agentUserId) return { ok: false, reason: "bad_credentials", detail: "no agentUserId" };
    // `async: true` lets Google coalesce concurrent sync requests for the same
    // user instead of rejecting the second one.
    return postToHomeGraph(REQUEST_SYNC_URL, { agentUserId, async: true });
  },
};

/**
 * Drop the credential + access-token caches. Tests flip
 * `GOOGLE_HOMEGRAPH_SERVICE_ACCOUNT` between cases; production never calls this.
 */
export function resetHomeGraphCachesForTesting(): void {
  credentialCache = null;
  tokenCache = null;
}
