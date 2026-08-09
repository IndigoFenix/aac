// server/services/smart-home/account-link-service.ts
//
// ACCOUNT LINKING — we are the OAuth AUTHORIZATION SERVER.
//
// Alexa/Google link a user's ecosystem account to ours by sending the family to
// our server-rendered authorize page (Spotify-popup pattern). A parent or
// clinician is already logged in there with the normal session auth; they pick
// the STUDENT, and the resulting grant binds `(provider → studentId)`. From then
// on a fulfillment request arrives as a bearer token, and the ONLY question the
// handlers ask this module is "whose student is this?" —
// `resolveAccountLinkBearer`.
//
// STORAGE — `account_link_grants` + `account_link_credentials`
// (shared/schema-private.ts). This is the direction OPPOSITE to
// `external_connections`: that vault holds credentials THEY issued to US
// (encrypted, because we replay them). These tables hold what WE issue to THEM,
// so only a SHA-256 HASH is stored — we never need to read a token back, only
// to recognise one presented to us. A dump of these tables leaks no bearer.
//
// LIFETIMES: authorization code 10 min single-use; access token 1 h; refresh
// token long-lived but ROTATED — presenting one consumes it and mints a fresh
// pair, so a stolen refresh token is usable at most once. Raw tokens are 32
// bytes from `crypto.randomBytes`, base64url.
//
// ENV CONTRACT (nothing is live until these are set — no Amazon/Google
// developer account exists yet, so an unset provider simply has no client and
// every authorize request for it fails closed):
//
//   ALEXA_LINK_CLIENT_ID       client_id Amazon sends on /authorize and /token
//   ALEXA_LINK_CLIENT_SECRET   shared secret Amazon presents at /token
//   ALEXA_LINK_REDIRECT_URIS   comma-separated EXACT-match redirect_uri allowlist
//                              (Amazon's are https://pitangui.amazon.com/api/skill/link/<vendor>,
//                               https://layla.amazon.com/api/skill/link/<vendor>,
//                               https://alexa.amazon.co.jp/api/skill/link/<vendor>)
//   GOOGLE_LINK_CLIENT_ID      same three for Google cloud-to-cloud
//   GOOGLE_LINK_CLIENT_SECRET
//   GOOGLE_LINK_REDIRECT_URIS  (https://oauth-redirect.googleusercontent.com/r/<project-id>)
//
// Env is read per call, never at import time — this module must stay
// side-effect-free to import (the fulfillment routers import it eagerly).
//
// See planning-docs/smart-home-actions.md ("Account linking").

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { accountLinkCredentials, accountLinkGrants } from "@shared/schema";
import { db } from "../../db";
import type { SmartHomeProvider } from "./types";

export type { SmartHomeProvider };

/** Who a fulfillment request is acting for. The whole point of the module. */
export interface AccountLinkIdentity {
  /** `students.id` — the AAC student whose home actions may be actuated. */
  studentId: string;
  provider: SmartHomeProvider;
}

/** A stored link, as the clinician UI and the revoke path see it. */
export interface AccountLinkGrant extends AccountLinkIdentity {
  /** The parent/clinician user who approved the link on the authorize page. */
  grantedByUserId: string;
  /** Epoch ms the grant was created. */
  grantedAt: number;
}

/** The token pair we ISSUE to the provider (we are the auth server). */
export interface AccountLinkTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: "bearer";
  /** Lifetime of `accessToken` in seconds. */
  expiresInSeconds: number;
}

/** A validated `/authorize` request — what the server-rendered consent page renders from. */
export interface AccountLinkAuthorizeRequest {
  provider: SmartHomeProvider;
  clientId: string;
  redirectUri: string;
  /** Opaque value echoed back to the provider on redirect (CSRF binding). */
  state: string;
}

/** What the consent page POSTs once a parent/clinician picks a student and approves. */
export interface AccountLinkApproval extends AccountLinkAuthorizeRequest {
  studentId: string;
  /** The logged-in user granting the link (session auth, not the student). */
  grantedByUserId: string;
}

// ---------------------------------------------------------------------------
// Lifetimes
// ---------------------------------------------------------------------------

/** Authorization codes are hand-carried through a browser redirect — keep them short. */
export const AUTH_CODE_TTL_SECONDS = 10 * 60;
/** What we advertise as `expires_in`; the provider refreshes on expiry. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/**
 * Refresh tokens are long-lived by design (a family links once and expects it to
 * keep working), but every use ROTATES them, so the window a leaked one is
 * usable in is one request, not ten years.
 */
export const REFRESH_TOKEN_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

/** Credential discriminator — mirrors `account_link_credentials.kind`. */
type CredentialKind = "code" | "access" | "refresh";

// ---------------------------------------------------------------------------
// Env-gated client registry
// ---------------------------------------------------------------------------

/** A configured provider client. Absent env ⇒ no client ⇒ the provider fails closed. */
export interface AccountLinkClient {
  provider: SmartHomeProvider;
  clientId: string;
  clientSecret: string;
  /** EXACT-match allowlist. A redirect_uri outside it is an open redirect. */
  redirectUris: string[];
}

const CLIENT_ENV: Record<SmartHomeProvider, { id: string; secret: string; redirects: string }> = {
  alexa: {
    id: "ALEXA_LINK_CLIENT_ID",
    secret: "ALEXA_LINK_CLIENT_SECRET",
    redirects: "ALEXA_LINK_REDIRECT_URIS",
  },
  google: {
    id: "GOOGLE_LINK_CLIENT_ID",
    secret: "GOOGLE_LINK_CLIENT_SECRET",
    redirects: "GOOGLE_LINK_REDIRECT_URIS",
  },
};

const PROVIDERS: SmartHomeProvider[] = ["alexa", "google"];

/**
 * The client configured for a provider, or null when its env is incomplete.
 * All three vars are required together — a client id with no secret would let
 * anyone exchange a code.
 */
export function accountLinkClient(provider: SmartHomeProvider): AccountLinkClient | null {
  const names = CLIENT_ENV[provider];
  if (!names) return null;
  const clientId = (process.env[names.id] || "").trim();
  const clientSecret = (process.env[names.secret] || "").trim();
  const redirectUris = (process.env[names.redirects] || "")
    .split(",")
    .map((uri) => uri.trim())
    .filter(Boolean);
  if (!clientId || !clientSecret || redirectUris.length === 0) return null;
  return { provider, clientId, clientSecret, redirectUris };
}

/** Which provider owns this client_id? The provider is INFERRED, never taken from the query. */
export function accountLinkClientById(clientId: string): AccountLinkClient | null {
  if (!clientId) return null;
  for (const provider of PROVIDERS) {
    const client = accountLinkClient(provider);
    if (client && client.clientId === clientId) return client;
  }
  return null;
}

/** Constant-time secret comparison — never leak the secret one byte at a time. */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Authenticate a token-endpoint call. Returns the client only when the id is
 * known, the secret matches, and the client belongs to the provider the caller
 * claims — an Alexa client must never redeem a Google grant.
 */
function authenticateClient(
  provider: SmartHomeProvider,
  clientId: string,
  clientSecret: string,
): AccountLinkClient | null {
  const client = accountLinkClientById(clientId);
  if (!client) return null;
  if (client.provider !== provider) return null;
  if (!secretMatches(clientSecret, client.clientSecret)) return null;
  return client;
}

// ---------------------------------------------------------------------------
// Token minting / hashing
// ---------------------------------------------------------------------------

/** 32 random bytes, base64url. The ONLY place a raw credential is born. */
export function mintRawToken(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256(raw) hex — what actually goes in the database. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function expiryFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

/** Read `?x=` safely: express gives `string | string[] | ParsedQs`. Only a lone string counts. */
function scalar(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * Validate an inbound `/authorize` query against the configured provider client
 * (client id + exact-match redirect uri). Returns null for anything unrecognised
 * — an unvalidated redirect_uri is an open redirect, so the consent page must
 * refuse to render rather than trust the query.
 */
export async function validateAuthorizeRequest(
  query: Record<string, string | undefined>,
): Promise<AccountLinkAuthorizeRequest | null> {
  const responseType = scalar(query.response_type);
  // We implement the authorization-code grant only. `token` (implicit) would
  // put a bearer in a URL fragment; nothing else is even proposed.
  if (responseType !== "code") return null;

  const client = accountLinkClientById(scalar(query.client_id));
  if (!client) return null;

  const redirectUri = scalar(query.redirect_uri);
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) return null;

  return {
    provider: client.provider,
    clientId: client.clientId,
    redirectUri,
    // `state` is RECOMMENDED, not required, by RFC 6749 — Amazon and Google
    // always send one. Absent ⇒ empty, and the redirect simply omits it.
    state: scalar(query.state),
  };
}

/**
 * A parent/clinician approved the link for a specific student: create the grant
 * and return the one-time authorization CODE to redirect back with.
 *
 * RE-LINKING SUPERSEDES: any live grant for the same (student, provider) is
 * revoked — together with every credential minted from it — in the same
 * transaction that inserts the new one, so the partial unique index can never
 * see two live rows and "is this student linked?" stays unambiguous.
 */
export async function issueAuthorizationCode(approval: AccountLinkApproval): Promise<string> {
  // Never trust the caller's provider/client/redirect triple — re-derive it.
  const client = accountLinkClient(approval.provider);
  if (!client || client.clientId !== approval.clientId) {
    throw new Error("account-link: unknown client for approval");
  }
  if (!client.redirectUris.includes(approval.redirectUri)) {
    throw new Error("account-link: redirect_uri not allowlisted for approval");
  }
  if (!approval.studentId || !approval.grantedByUserId) {
    throw new Error("account-link: approval is missing student or granting user");
  }

  const code = mintRawToken();

  await db.transaction(async (tx) => {
    const now = new Date();
    const superseded = await tx
      .update(accountLinkGrants)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(accountLinkGrants.studentId, approval.studentId),
          eq(accountLinkGrants.provider, approval.provider),
          isNull(accountLinkGrants.revokedAt),
        ),
      )
      .returning({ id: accountLinkGrants.id });

    for (const old of superseded) {
      await tx
        .update(accountLinkCredentials)
        .set({ revokedAt: now })
        .where(
          and(eq(accountLinkCredentials.grantId, old.id), isNull(accountLinkCredentials.revokedAt)),
        );
    }

    const [grant] = await tx
      .insert(accountLinkGrants)
      .values({
        studentId: approval.studentId,
        provider: approval.provider,
        grantedByUserId: approval.grantedByUserId,
        clientId: client.clientId,
        redirectUri: approval.redirectUri,
      })
      .returning({ id: accountLinkGrants.id });

    await tx.insert(accountLinkCredentials).values({
      grantId: grant.id,
      kind: "code" satisfies CredentialKind,
      tokenHash: hashToken(code),
      redirectUri: approval.redirectUri,
      expiresAt: expiryFromNow(AUTH_CODE_TTL_SECONDS),
    });
  });

  return code;
}

/**
 * Spend a single-use credential, in ONE statement.
 *
 * The `consumed_at IS NULL` predicate lives in the UPDATE, so Postgres row
 * locking decides the winner of a race: the second writer re-evaluates the
 * WHERE after the first commits, matches nothing, and gets zero rows back.
 * Never a read-then-write.
 *
 * The `scope` subquery narrows the candidates to credentials of a LIVE grant
 * belonging to THIS provider+client, so a token presented by the wrong client
 * is simply NOT FOUND rather than found-and-burned — one ecosystem's client can
 * never spend the other's code. Grant revocation is therefore checked in the
 * same statement as the spend, with no window between.
 */
async function consumeCredential(
  raw: string,
  kind: CredentialKind,
  scope: { provider: SmartHomeProvider; clientId: string },
): Promise<{ grantId: string; redirectUri: string | null } | null> {
  const now = new Date();
  const ownGrants = db
    .select({ id: accountLinkGrants.id })
    .from(accountLinkGrants)
    .where(
      and(
        eq(accountLinkGrants.provider, scope.provider),
        eq(accountLinkGrants.clientId, scope.clientId),
        isNull(accountLinkGrants.revokedAt),
      ),
    );

  const [row] = await db
    .update(accountLinkCredentials)
    .set({ consumedAt: now })
    .where(
      and(
        eq(accountLinkCredentials.tokenHash, hashToken(raw)),
        eq(accountLinkCredentials.kind, kind),
        isNull(accountLinkCredentials.consumedAt),
        isNull(accountLinkCredentials.revokedAt),
        gt(accountLinkCredentials.expiresAt, now),
        inArray(accountLinkCredentials.grantId, ownGrants),
      ),
    )
    .returning({
      grantId: accountLinkCredentials.grantId,
      redirectUri: accountLinkCredentials.redirectUri,
    });
  return row ?? null;
}

/** Mint a fresh access+refresh pair off a live grant. */
async function mintTokens(grantId: string): Promise<AccountLinkTokens> {
  const accessToken = mintRawToken();
  const refreshToken = mintRawToken();
  await db.insert(accountLinkCredentials).values([
    {
      grantId,
      kind: "access" satisfies CredentialKind,
      tokenHash: hashToken(accessToken),
      expiresAt: expiryFromNow(ACCESS_TOKEN_TTL_SECONDS),
    },
    {
      grantId,
      kind: "refresh" satisfies CredentialKind,
      tokenHash: hashToken(refreshToken),
      expiresAt: expiryFromNow(REFRESH_TOKEN_TTL_SECONDS),
    },
  ]);
  return {
    accessToken,
    refreshToken,
    tokenType: "bearer",
    expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
  };
}

/**
 * Provider's token endpoint call: one-time code → token pair. Returns null when
 * the code is unknown, expired, already spent, or the client credentials /
 * redirect uri don't match the grant.
 *
 * A code belonging to another client is never even visible (see
 * `consumeCredential`), so a stray call cannot burn someone else's code. Once
 * the code IS ours, it is spent BEFORE the redirect_uri is compared: a mismatch
 * there means replay or interception, and burning it is the safe outcome.
 */
export async function exchangeAuthorizationCode(params: {
  provider: SmartHomeProvider;
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<AccountLinkTokens | null> {
  if (!authenticateClient(params.provider, params.clientId, params.clientSecret)) return null;
  if (!params.code) return null;

  const spent = await consumeCredential(params.code, "code", params);
  if (!spent) return null;
  if (spent.redirectUri !== params.redirectUri) return null;

  return mintTokens(spent.grantId);
}

/**
 * Provider's refresh call: refresh token → a fresh pair. Null if the grant is
 * gone/revoked.
 *
 * ROTATION: the presented token is consumed, so a replay of it — by us on retry
 * or by a thief — gets null. (We deliberately do NOT nuke the whole grant on a
 * replay: a provider retrying a timed-out request would otherwise unlink a
 * family's speaker.)
 */
export async function refreshAccountLinkTokens(params: {
  provider: SmartHomeProvider;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<AccountLinkTokens | null> {
  if (!authenticateClient(params.provider, params.clientId, params.clientSecret)) return null;
  if (!params.refreshToken) return null;

  const spent = await consumeCredential(params.refreshToken, "refresh", params);
  if (!spent) return null;

  return mintTokens(spent.grantId);
}

/**
 * THE fulfillment-handler contract: resolve a bearer access token from an
 * inbound Alexa/Google directive to the student it was granted for. Null for an
 * unknown, expired or revoked token — handlers must treat null as "no such
 * user" and answer with the provider's own auth-failure shape, never as an
 * empty device list.
 */
export async function resolveAccountLinkBearer(token: string): Promise<AccountLinkIdentity | null> {
  if (!token) return null;
  const now = new Date();
  const [row] = await db
    .select({
      studentId: accountLinkGrants.studentId,
      provider: accountLinkGrants.provider,
    })
    .from(accountLinkCredentials)
    .innerJoin(accountLinkGrants, eq(accountLinkCredentials.grantId, accountLinkGrants.id))
    .where(
      and(
        eq(accountLinkCredentials.tokenHash, hashToken(token)),
        eq(accountLinkCredentials.kind, "access"),
        isNull(accountLinkCredentials.consumedAt),
        isNull(accountLinkCredentials.revokedAt),
        gt(accountLinkCredentials.expiresAt, now),
        isNull(accountLinkGrants.revokedAt),
      ),
    );
  if (!row) return null;
  return { studentId: row.studentId, provider: row.provider as SmartHomeProvider };
}

/** Is this student linked to this provider? (clinician UI status, provider preflight) */
export async function findAccountLink(
  studentId: string,
  provider: SmartHomeProvider,
): Promise<AccountLinkGrant | null> {
  if (!studentId) return null;
  const [grant] = await db
    .select({
      studentId: accountLinkGrants.studentId,
      grantedByUserId: accountLinkGrants.grantedByUserId,
      createdAt: accountLinkGrants.createdAt,
    })
    .from(accountLinkGrants)
    .where(
      and(
        eq(accountLinkGrants.studentId, studentId),
        eq(accountLinkGrants.provider, provider),
        isNull(accountLinkGrants.revokedAt),
      ),
    );
  if (!grant) return null;
  return {
    studentId: grant.studentId,
    provider,
    grantedByUserId: grant.grantedByUserId,
    grantedAt: grant.createdAt.getTime(),
  };
}

/**
 * Drop the grant and every token minted from it (parent unlinks, student
 * erasure). Soft revoke on both: the grant stays as the audit record of what
 * was authorized, the credentials stay unusable. Idempotent — revoking an
 * unlinked student is a no-op, never an error.
 */
export async function revokeAccountLink(
  studentId: string,
  provider: SmartHomeProvider,
): Promise<void> {
  if (!studentId) return;
  await db.transaction(async (tx) => {
    const now = new Date();
    const revoked = await tx
      .update(accountLinkGrants)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(accountLinkGrants.studentId, studentId),
          eq(accountLinkGrants.provider, provider),
          isNull(accountLinkGrants.revokedAt),
        ),
      )
      .returning({ id: accountLinkGrants.id });

    for (const grant of revoked) {
      await tx
        .update(accountLinkCredentials)
        .set({ revokedAt: now })
        .where(
          and(
            eq(accountLinkCredentials.grantId, grant.id),
            isNull(accountLinkCredentials.revokedAt),
          ),
        );
    }
  });
}
