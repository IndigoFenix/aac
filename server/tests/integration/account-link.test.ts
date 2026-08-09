/**
 * Account linking against a real database — the whole OAuth arc we serve as the
 * AUTHORIZATION SERVER for the Alexa skill / Google cloud-to-cloud integration
 * (planning-docs/smart-home-actions.md, "Account linking").
 *
 * What these pin, in rough order of how much damage the bug would do:
 *
 *  • HASHES ONLY. Not one raw code, access token or refresh token is findable
 *    in `account_link_grants` / `account_link_credentials`. A dump of those
 *    tables must not hand anyone a working bearer.
 *  • ONE-TIME CODES ARE ONE-TIME EVEN UNDER A RACE. The spend is an atomic
 *    `UPDATE … WHERE consumed_at IS NULL RETURNING`; two simultaneous exchanges
 *    of the same code produce exactly one winner and one null.
 *  • RE-LINKING SUPERSEDES. A family that links again must not end up with two
 *    live grants — the old grant and every credential minted from it die inside
 *    the same transaction that creates the new grant.
 *  • REVOKE MEANS REVOKED. Bearers stop resolving the moment the link is cut.
 *  • The user-facing half never takes the form's word for anything: the session,
 *    the OAuth parameters and the student's accessibility are all re-checked on
 *    POST, and a student outside this user's reach is refused.
 *
 * Pure logic (client registry, `validateAuthorizeRequest`, token shape, the
 * token endpoint's pre-storage rejections) is in server/tests/account-link.test.ts,
 * which needs no DB. Run this one with `npm test -- account-link`.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "@jest/globals";
import express from "express";
import http from "http";
import { and, eq, isNull } from "drizzle-orm";
import { accountLinkCredentials, accountLinkGrants } from "@shared/schema";
import { truncateAll, db } from "../helpers/db.js";
import { makeUser, makeStudent, makeInstitute, enrollStudent } from "../helpers/factories.js";
import { accountLinkRouter } from "../../controllers/accountLinkController.js";
import {
  exchangeAuthorizationCode,
  findAccountLink,
  hashToken,
  issueAuthorizationCode,
  refreshAccountLinkTokens,
  resolveAccountLinkBearer,
  revokeAccountLink,
  type AccountLinkApproval,
} from "../../services/smart-home/account-link-service.js";

const ALEXA_REDIRECT = "https://pitangui.amazon.com/api/skill/link/TESTVENDOR";
const GOOGLE_REDIRECT = "https://oauth-redirect.googleusercontent.com/r/test-project";
const ALEXA_ID = "alexa-test-client";
const ALEXA_SECRET = "alexa-test-secret";
const GOOGLE_ID = "google-test-client";
const GOOGLE_SECRET = "google-test-secret";

const ENV_KEYS = [
  "ALEXA_LINK_CLIENT_ID",
  "ALEXA_LINK_CLIENT_SECRET",
  "ALEXA_LINK_REDIRECT_URIS",
  "GOOGLE_LINK_CLIENT_ID",
  "GOOGLE_LINK_CLIENT_SECRET",
  "GOOGLE_LINK_REDIRECT_URIS",
] as const;
const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

beforeEach(() => {
  process.env.ALEXA_LINK_CLIENT_ID = ALEXA_ID;
  process.env.ALEXA_LINK_CLIENT_SECRET = ALEXA_SECRET;
  process.env.ALEXA_LINK_REDIRECT_URIS = ALEXA_REDIRECT;
  process.env.GOOGLE_LINK_CLIENT_ID = GOOGLE_ID;
  process.env.GOOGLE_LINK_CLIENT_SECRET = GOOGLE_SECRET;
  process.env.GOOGLE_LINK_REDIRECT_URIS = GOOGLE_REDIRECT;
});

afterEach(truncateAll);

afterAll(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A parent with one student, visible to them through their family institute. */
async function linkableFamily(): Promise<{ userId: string; studentId: string; name: string }> {
  const user = await makeUser();
  const { student } = await makeStudent(user.id);
  const { institute } = await makeInstitute(user.id, { type: "family" });
  await enrollStudent(institute.id, student.id, user.id);
  return { userId: user.id, studentId: student.id, name: student.name };
}

function alexaApproval(over: Partial<AccountLinkApproval> & { studentId: string; grantedByUserId: string }): AccountLinkApproval {
  return {
    provider: "alexa",
    clientId: ALEXA_ID,
    redirectUri: ALEXA_REDIRECT,
    state: "amzn-state-123",
    ...over,
  };
}

const exchangeAlexa = (code: string) =>
  exchangeAuthorizationCode({
    provider: "alexa",
    code,
    clientId: ALEXA_ID,
    clientSecret: ALEXA_SECRET,
    redirectUri: ALEXA_REDIRECT,
  });

const refreshAlexa = (refreshToken: string) =>
  refreshAccountLinkTokens({
    provider: "alexa",
    refreshToken,
    clientId: ALEXA_ID,
    clientSecret: ALEXA_SECRET,
  });

async function liveGrantCount(studentId: string): Promise<number> {
  const rows = await db
    .select({ id: accountLinkGrants.id })
    .from(accountLinkGrants)
    .where(and(eq(accountLinkGrants.studentId, studentId), isNull(accountLinkGrants.revokedAt)));
  return rows.length;
}

// ---------------------------------------------------------------------------
// The arc
// ---------------------------------------------------------------------------

describe("account link — code → tokens → bearer → refresh → revoke", () => {
  it("walks the whole arc and lands on the right student", async () => {
    const { userId, studentId } = await linkableFamily();

    const code = await issueAuthorizationCode(alexaApproval({ studentId, grantedByUserId: userId }));
    expect(typeof code).toBe("string");

    // The grant exists the moment the parent approves — before the provider
    // has even called the token endpoint.
    const grant = await findAccountLink(studentId, "alexa");
    expect(grant).toMatchObject({ studentId, provider: "alexa", grantedByUserId: userId });
    expect(grant!.grantedAt).toBeLessThanOrEqual(Date.now());

    const tokens = await exchangeAlexa(code);
    expect(tokens).toBeTruthy();
    expect(tokens!.tokenType).toBe("bearer");
    expect(tokens!.expiresInSeconds).toBe(3600);
    expect(tokens!.accessToken).not.toBe(tokens!.refreshToken);

    expect(await resolveAccountLinkBearer(tokens!.accessToken)).toEqual({
      studentId,
      provider: "alexa",
    });

    // Rotation: the fresh pair works, the presented refresh token is spent.
    const rotated = await refreshAlexa(tokens!.refreshToken);
    expect(rotated).toBeTruthy();
    expect(rotated!.refreshToken).not.toBe(tokens!.refreshToken);
    expect(await resolveAccountLinkBearer(rotated!.accessToken)).toEqual({
      studentId,
      provider: "alexa",
    });
    expect(await refreshAlexa(tokens!.refreshToken)).toBeNull();

    // …and the rotated one rotates again, so this is not a one-shot.
    expect(await refreshAlexa(rotated!.refreshToken)).toBeTruthy();

    await revokeAccountLink(studentId, "alexa");
    expect(await findAccountLink(studentId, "alexa")).toBeNull();
    expect(await resolveAccountLinkBearer(tokens!.accessToken)).toBeNull();
    expect(await resolveAccountLinkBearer(rotated!.accessToken)).toBeNull();
    expect(await refreshAlexa(rotated!.refreshToken)).toBeNull();
    // Idempotent — unlinking twice is a no-op, not an error.
    await revokeAccountLink(studentId, "alexa");
  });

  it("stores hashes only — no raw credential is recoverable from the tables", async () => {
    const { userId, studentId } = await linkableFamily();
    const code = await issueAuthorizationCode(alexaApproval({ studentId, grantedByUserId: userId }));
    const tokens = (await exchangeAlexa(code))!;

    const credentials = await db.select().from(accountLinkCredentials);
    const dump = JSON.stringify(credentials) + JSON.stringify(await db.select().from(accountLinkGrants));
    for (const secret of [code, tokens.accessToken, tokens.refreshToken]) {
      expect(dump).not.toContain(secret);
    }
    // The hash IS there, under the right kind.
    const codeRow = credentials.find((row) => row.tokenHash === hashToken(code));
    expect(codeRow).toMatchObject({ kind: "code", redirectUri: ALEXA_REDIRECT });
    expect(codeRow!.consumedAt).not.toBeNull();
    expect(credentials.find((r) => r.tokenHash === hashToken(tokens.accessToken))!.kind).toBe("access");
    expect(credentials.find((r) => r.tokenHash === hashToken(tokens.refreshToken))!.kind).toBe("refresh");
  });

  it("keeps a code single-use even when two exchanges race", async () => {
    const { userId, studentId } = await linkableFamily();
    const code = await issueAuthorizationCode(alexaApproval({ studentId, grantedByUserId: userId }));

    const [a, b] = await Promise.all([exchangeAlexa(code), exchangeAlexa(code)]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(await resolveAccountLinkBearer(winners[0]!.accessToken)).toEqual({
      studentId,
      provider: "alexa",
    });
    // And a third, unhurried attempt gets nothing either.
    expect(await exchangeAlexa(code)).toBeNull();
  });

  it("refuses an expired code", async () => {
    const { userId, studentId } = await linkableFamily();
    const code = await issueAuthorizationCode(alexaApproval({ studentId, grantedByUserId: userId }));
    await db
      .update(accountLinkCredentials)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(accountLinkCredentials.tokenHash, hashToken(code)));

    expect(await exchangeAlexa(code)).toBeNull();
  });

  it("refuses an expired access token without touching the grant", async () => {
    const { userId, studentId } = await linkableFamily();
    const code = await issueAuthorizationCode(alexaApproval({ studentId, grantedByUserId: userId }));
    const tokens = (await exchangeAlexa(code))!;
    await db
      .update(accountLinkCredentials)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(accountLinkCredentials.tokenHash, hashToken(tokens.accessToken)));

    expect(await resolveAccountLinkBearer(tokens.accessToken)).toBeNull();
    // The link itself is fine — the provider just needs to refresh.
    expect(await findAccountLink(studentId, "alexa")).toBeTruthy();
    expect(await refreshAlexa(tokens.refreshToken)).toBeTruthy();
  });

  it("burns a code presented with the wrong redirect_uri", async () => {
    const { userId, studentId } = await linkableFamily();
    const code = await issueAuthorizationCode(alexaApproval({ studentId, grantedByUserId: userId }));

    expect(
      await exchangeAuthorizationCode({
        provider: "alexa",
        code,
        clientId: ALEXA_ID,
        clientSecret: ALEXA_SECRET,
        redirectUri: GOOGLE_REDIRECT,
      }),
    ).toBeNull();
    // Interception is the likely explanation, so the code does not survive.
    expect(await exchangeAlexa(code)).toBeNull();
  });

  it("does not let one ecosystem's client redeem the other's grant", async () => {
    const { userId, studentId } = await linkableFamily();
    const code = await issueAuthorizationCode(alexaApproval({ studentId, grantedByUserId: userId }));

    expect(
      await exchangeAuthorizationCode({
        provider: "google",
        code,
        clientId: GOOGLE_ID,
        clientSecret: GOOGLE_SECRET,
        redirectUri: GOOGLE_REDIRECT,
      }),
    ).toBeNull();
    // Wrong secret for the right client is equally dead, and leaves the code alive.
    expect(
      await exchangeAuthorizationCode({
        provider: "alexa",
        code,
        clientId: ALEXA_ID,
        clientSecret: "not-the-secret",
        redirectUri: ALEXA_REDIRECT,
      }),
    ).toBeNull();
    expect(await exchangeAlexa(code)).toBeTruthy();
  });

  it("scopes grants per (student, provider)", async () => {
    const first = await linkableFamily();
    const second = await linkableFamily();

    const codeA = await issueAuthorizationCode(
      alexaApproval({ studentId: first.studentId, grantedByUserId: first.userId }),
    );
    const codeB = await issueAuthorizationCode(
      alexaApproval({ studentId: second.studentId, grantedByUserId: second.userId }),
    );
    const tokensA = (await exchangeAlexa(codeA))!;
    const tokensB = (await exchangeAlexa(codeB))!;

    expect((await resolveAccountLinkBearer(tokensA.accessToken))!.studentId).toBe(first.studentId);
    expect((await resolveAccountLinkBearer(tokensB.accessToken))!.studentId).toBe(second.studentId);

    // A google link on the same student is a separate grant.
    const googleCode = await issueAuthorizationCode({
      provider: "google",
      clientId: GOOGLE_ID,
      redirectUri: GOOGLE_REDIRECT,
      state: "g",
      studentId: first.studentId,
      grantedByUserId: first.userId,
    });
    expect(await findAccountLink(first.studentId, "google")).toBeTruthy();
    expect(await findAccountLink(first.studentId, "alexa")).toBeTruthy();

    await revokeAccountLink(first.studentId, "google");
    expect(await findAccountLink(first.studentId, "google")).toBeNull();
    // Revoking google left alexa alone.
    expect(await resolveAccountLinkBearer(tokensA.accessToken)).toBeTruthy();
    expect(
      await exchangeAuthorizationCode({
        provider: "google",
        code: googleCode,
        clientId: GOOGLE_ID,
        clientSecret: GOOGLE_SECRET,
        redirectUri: GOOGLE_REDIRECT,
      }),
    ).toBeNull();
  });

  it("supersedes the old grant when a family re-links", async () => {
    const { userId, studentId } = await linkableFamily();
    const secondParent = await makeUser();

    const firstCode = await issueAuthorizationCode(
      alexaApproval({ studentId, grantedByUserId: userId }),
    );
    const firstTokens = (await exchangeAlexa(firstCode))!;
    expect(await resolveAccountLinkBearer(firstTokens.accessToken)).toBeTruthy();

    // Somebody links the same student again (new speaker, or a second parent).
    const secondCode = await issueAuthorizationCode(
      alexaApproval({ studentId, grantedByUserId: secondParent.id }),
    );
    const secondTokens = (await exchangeAlexa(secondCode))!;

    expect(await liveGrantCount(studentId)).toBe(1);
    expect((await findAccountLink(studentId, "alexa"))!.grantedByUserId).toBe(secondParent.id);
    // Everything minted from the superseded grant is dead.
    expect(await resolveAccountLinkBearer(firstTokens.accessToken)).toBeNull();
    expect(await refreshAlexa(firstTokens.refreshToken)).toBeNull();
    // The new one works.
    expect(await resolveAccountLinkBearer(secondTokens.accessToken)).toEqual({
      studentId,
      provider: "alexa",
    });
  });

  it("refuses to mint a code for a client or redirect it doesn't recognise", async () => {
    const { userId, studentId } = await linkableFamily();
    await expect(
      issueAuthorizationCode(
        alexaApproval({ studentId, grantedByUserId: userId, clientId: "not-ours" }),
      ),
    ).rejects.toThrow(/unknown client/i);
    await expect(
      issueAuthorizationCode(
        alexaApproval({ studentId, grantedByUserId: userId, redirectUri: "https://evil.test/x" }),
      ),
    ).rejects.toThrow(/redirect_uri/i);
    expect(await liveGrantCount(studentId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The user-facing half, over real HTTP
// ---------------------------------------------------------------------------

interface Probe {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * The router behind a stand-in for passport: `req.user` + `req.isAuthenticated`
 * are exactly what server/userAuth.ts leaves on the request.
 */
async function withApp(
  session: { userId: string | null },
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    (req as any).isAuthenticated = () => session.userId !== null;
    (req as any).user = session.userId ? { id: session.userId } : undefined;
    next();
  });
  app.use("/api/smart-home/link", accountLinkRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("server not listening");
  try {
    await fn(addr.port);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

function request(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Probe> {
  return new Promise<Probe>((resolve, reject) => {
    const headers = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = String(Buffer.byteLength(opts.body));
    }
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: res.headers,
        }),
      );
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const AUTHORIZE = "/api/smart-home/link/authorize";
const TOKEN = "/api/smart-home/link/token";
const AUTHORIZE_QUERY = new URLSearchParams({
  response_type: "code",
  client_id: ALEXA_ID,
  redirect_uri: ALEXA_REDIRECT,
  state: "amzn-state-123",
}).toString();

function approvalBody(studentId: string, over: Record<string, string> = {}): string {
  return new URLSearchParams({
    response_type: "code",
    client_id: ALEXA_ID,
    redirect_uri: ALEXA_REDIRECT,
    state: "amzn-state-123",
    student_id: studentId,
    ...over,
  }).toString();
}

describe("account link — the consent page and token endpoint end to end", () => {
  it("shows the picker, redirects with a code, and the provider exchanges it", async () => {
    const { userId, studentId, name } = await linkableFamily();

    await withApp({ userId }, async (port) => {
      const page = await request(port, "GET", `${AUTHORIZE}?${AUTHORIZE_QUERY}`);
      expect(page.status).toBe(200);
      expect(page.body).toContain("Amazon Alexa");
      expect(page.body).toContain(name);
      expect(page.body).toContain(`value="${studentId}"`);

      const approved = await request(port, "POST", `${AUTHORIZE}?${AUTHORIZE_QUERY}`, {
        body: approvalBody(studentId),
      });
      expect(approved.status).toBe(302);
      const location = new URL(String(approved.headers.location));
      expect(`${location.origin}${location.pathname}`).toBe(ALEXA_REDIRECT);
      expect(location.searchParams.get("state")).toBe("amzn-state-123");
      const code = location.searchParams.get("code")!;
      expect(code).toBeTruthy();
      // The code travels in the URL, so it must not BE the stored value.
      const [row] = await db
        .select()
        .from(accountLinkCredentials)
        .where(eq(accountLinkCredentials.tokenHash, hashToken(code)));
      expect(row.kind).toBe("code");

      const tokenRes = await request(port, "POST", TOKEN, {
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: ALEXA_REDIRECT,
          client_id: ALEXA_ID,
          client_secret: ALEXA_SECRET,
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      expect(tokenRes.headers["cache-control"]).toContain("no-store");
      const payload = JSON.parse(tokenRes.body);
      expect(payload).toMatchObject({ token_type: "bearer", expires_in: 3600 });
      expect(await resolveAccountLinkBearer(payload.access_token)).toEqual({
        studentId,
        provider: "alexa",
      });

      // Replaying the same code now fails the OAuth way.
      const replay = await request(port, "POST", TOKEN, {
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: ALEXA_REDIRECT,
          client_id: ALEXA_ID,
          client_secret: ALEXA_SECRET,
        }).toString(),
      });
      expect(replay.status).toBe(400);
      expect(JSON.parse(replay.body).error).toBe("invalid_grant");

      // Refresh over HTTP, with Basic auth this time, and rotation holds.
      const refreshed = await request(port, "POST", TOKEN, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${ALEXA_ID}:${ALEXA_SECRET}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: payload.refresh_token,
        }).toString(),
      });
      expect(refreshed.status).toBe(200);
      const rotated = JSON.parse(refreshed.body);
      expect(rotated.refresh_token).not.toBe(payload.refresh_token);
      expect(await resolveAccountLinkBearer(rotated.access_token)).toBeTruthy();
    });
  });

  it("refuses a student this user cannot reach, and creates nothing", async () => {
    const mine = await linkableFamily();
    const theirs = await linkableFamily();

    await withApp({ userId: mine.userId }, async (port) => {
      const page = await request(port, "GET", `${AUTHORIZE}?${AUTHORIZE_QUERY}`);
      expect(page.body).not.toContain(`value="${theirs.studentId}"`);

      const res = await request(port, "POST", `${AUTHORIZE}?${AUTHORIZE_QUERY}`, {
        body: approvalBody(theirs.studentId),
      });
      expect(res.status).toBe(403);
      expect(res.headers.location).toBeUndefined();
    });
    expect(await liveGrantCount(theirs.studentId)).toBe(0);
    expect(await findAccountLink(theirs.studentId, "alexa")).toBeNull();
  });

  it("re-validates the hidden fields — a tampered redirect_uri never redirects", async () => {
    const { userId, studentId } = await linkableFamily();

    await withApp({ userId }, async (port) => {
      const tampered = await request(port, "POST", `${AUTHORIZE}?${AUTHORIZE_QUERY}`, {
        body: approvalBody(studentId, { redirect_uri: "https://evil.test/steal" }),
      });
      expect(tampered.status).toBe(400);
      expect(tampered.headers.location).toBeUndefined();

      const noStudent = await request(port, "POST", `${AUTHORIZE}?${AUTHORIZE_QUERY}`, {
        body: approvalBody(studentId, { student_id: "" }),
      });
      expect(noStudent.status).toBe(400);
    });
    expect(await liveGrantCount(studentId)).toBe(0);
  });

  it("refuses an approval with no session, however well-formed", async () => {
    const { studentId } = await linkableFamily();

    await withApp({ userId: null }, async (port) => {
      const res = await request(port, "POST", `${AUTHORIZE}?${AUTHORIZE_QUERY}`, {
        body: approvalBody(studentId),
      });
      expect(res.status).toBe(401);
      expect(res.headers.location).toBeUndefined();
    });
    expect(await liveGrantCount(studentId)).toBe(0);
  });
});
