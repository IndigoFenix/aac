/**
 * Account linking — the parts that need no database.
 *
 * We are the OAuth AUTHORIZATION SERVER for the Alexa skill / Google
 * cloud-to-cloud integration (planning-docs/smart-home-actions.md, "Account
 * linking"). This file pins the two halves that are pure:
 *
 *  1. The ENV-GATED CLIENT REGISTRY and `validateAuthorizeRequest`. This is the
 *     open-redirect boundary: a redirect_uri that isn't byte-identical to an
 *     allowlisted one must fail CLOSED, and a request that fails must never
 *     produce a redirect of any kind (RFC 6749 §4.1.2.1) — the page 400s where
 *     it stands.
 *  2. The token-endpoint surface that rejects before touching storage: client
 *     authentication (body params AND HTTP Basic — Alexa uses either) and grant
 *     type. Everything past that point is DB-backed and lives in
 *     server/tests/integration/account-link.test.ts.
 *
 * Nothing here opens a connection, so it runs under `npm run test:unit -- account-link`.
 */

import { describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import express from "express";
import http from "http";
import { accountLinkRouter } from "../controllers/accountLinkController.js";
import {
  accountLinkClient,
  accountLinkClientById,
  hashToken,
  mintRawToken,
  validateAuthorizeRequest,
} from "../services/smart-home/account-link-service.js";

const ALEXA_REDIRECT = "https://pitangui.amazon.com/api/skill/link/TESTVENDOR";
const ALEXA_REDIRECT_2 = "https://layla.amazon.com/api/skill/link/TESTVENDOR";
const GOOGLE_REDIRECT = "https://oauth-redirect.googleusercontent.com/r/test-project";

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

function configureClients(): void {
  process.env.ALEXA_LINK_CLIENT_ID = "alexa-test-client";
  process.env.ALEXA_LINK_CLIENT_SECRET = "alexa-test-secret";
  process.env.ALEXA_LINK_REDIRECT_URIS = `${ALEXA_REDIRECT}, ${ALEXA_REDIRECT_2}`;
  process.env.GOOGLE_LINK_CLIENT_ID = "google-test-client";
  process.env.GOOGLE_LINK_CLIENT_SECRET = "google-test-secret";
  process.env.GOOGLE_LINK_REDIRECT_URIS = GOOGLE_REDIRECT;
}

function clearClients(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

beforeEach(configureClients);

afterAll(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------
// Env-gated client registry
// ---------------------------------------------------------------------------

describe("account-link client registry (env-gated)", () => {
  it("builds a client per provider and splits the redirect allowlist on commas", () => {
    const alexa = accountLinkClient("alexa");
    expect(alexa).toEqual({
      provider: "alexa",
      clientId: "alexa-test-client",
      clientSecret: "alexa-test-secret",
      redirectUris: [ALEXA_REDIRECT, ALEXA_REDIRECT_2],
    });
    expect(accountLinkClient("google")!.redirectUris).toEqual([GOOGLE_REDIRECT]);
  });

  it("infers the provider from the client id, and knows no other ids", () => {
    expect(accountLinkClientById("alexa-test-client")!.provider).toBe("alexa");
    expect(accountLinkClientById("google-test-client")!.provider).toBe("google");
    expect(accountLinkClientById("someone-elses-client")).toBeNull();
    expect(accountLinkClientById("")).toBeNull();
  });

  it("fails CLOSED when any of the three vars is missing — no half-configured client", () => {
    delete process.env.ALEXA_LINK_CLIENT_SECRET;
    expect(accountLinkClient("alexa")).toBeNull();
    expect(accountLinkClientById("alexa-test-client")).toBeNull();

    configureClients();
    delete process.env.ALEXA_LINK_REDIRECT_URIS;
    expect(accountLinkClient("alexa")).toBeNull();

    clearClients();
    expect(accountLinkClient("alexa")).toBeNull();
    expect(accountLinkClient("google")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateAuthorizeRequest — the open-redirect boundary
// ---------------------------------------------------------------------------

describe("validateAuthorizeRequest", () => {
  const valid = {
    response_type: "code",
    client_id: "alexa-test-client",
    redirect_uri: ALEXA_REDIRECT,
    state: "amzn-state-123",
  };

  it("accepts a well-formed request and infers the provider", async () => {
    expect(await validateAuthorizeRequest(valid)).toEqual({
      provider: "alexa",
      clientId: "alexa-test-client",
      redirectUri: ALEXA_REDIRECT,
      state: "amzn-state-123",
    });
  });

  it("accepts any allowlisted redirect, per provider", async () => {
    expect((await validateAuthorizeRequest({ ...valid, redirect_uri: ALEXA_REDIRECT_2 }))!.redirectUri)
      .toBe(ALEXA_REDIRECT_2);
    const google = await validateAuthorizeRequest({
      ...valid,
      client_id: "google-test-client",
      redirect_uri: GOOGLE_REDIRECT,
    });
    expect(google!.provider).toBe("google");
  });

  it("treats a missing state as empty rather than failing (RFC 6749 makes it optional)", async () => {
    const { state, ...noState } = valid;
    void state;
    expect((await validateAuthorizeRequest(noState))!.state).toBe("");
  });

  it("rejects an unknown client_id", async () => {
    expect(await validateAuthorizeRequest({ ...valid, client_id: "not-ours" })).toBeNull();
    expect(await validateAuthorizeRequest({ ...valid, client_id: undefined })).toBeNull();
  });

  it("rejects a redirect_uri that is not byte-identical to an allowlisted one", async () => {
    const near = [
      `${ALEXA_REDIRECT}/`, // trailing slash
      `${ALEXA_REDIRECT}?x=1`, // extra query
      ALEXA_REDIRECT.replace("https", "http"), // downgraded scheme
      ALEXA_REDIRECT.toUpperCase(),
      "https://pitangui.amazon.com.evil.test/api/skill/link/TESTVENDOR",
      "https://evil.test/steal",
      GOOGLE_REDIRECT, // allowlisted — but for the OTHER provider's client
      "",
    ];
    for (const redirect_uri of near) {
      expect(await validateAuthorizeRequest({ ...valid, redirect_uri })).toBeNull();
    }
    expect(await validateAuthorizeRequest({ ...valid, redirect_uri: undefined })).toBeNull();
  });

  it("rejects any response_type other than code (no implicit grant)", async () => {
    for (const response_type of ["token", "code id_token", "CODE", "", undefined]) {
      expect(await validateAuthorizeRequest({ ...valid, response_type })).toBeNull();
    }
  });

  it("rejects everything once the provider is unconfigured", async () => {
    clearClients();
    expect(await validateAuthorizeRequest(valid)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Raw token shape + hashing
// ---------------------------------------------------------------------------

describe("token minting and hashing", () => {
  it("mints unguessable base64url tokens of at least 32 bytes", () => {
    const token = mintRawToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url: no +, /, or =
    expect(Buffer.from(token, "base64url")).toHaveLength(32);

    const many = new Set(Array.from({ length: 500 }, mintRawToken));
    expect(many.size).toBe(500);
  });

  it("hashes to stable lowercase sha256 hex that does not contain the token", () => {
    const token = mintRawToken();
    const hash = hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token);
    expect(hashToken(`${token}x`)).not.toBe(hash);
    // Known vector — pins the algorithm, not just self-consistency.
    expect(hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

// ---------------------------------------------------------------------------
// Router surface that rejects before any storage access
// ---------------------------------------------------------------------------

interface Probe {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Same harness as csrf-policy.test.ts: no supertest dep, real express routing. */
async function withApp(fn: (port: number) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
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

function authorizeQuery(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    response_type: "code",
    client_id: "alexa-test-client",
    redirect_uri: ALEXA_REDIRECT,
    state: "amzn-state-123",
    ...overrides,
  }).toString();
}

describe("GET /authorize — refusal never redirects", () => {
  it("400s in place for an unknown client, a bad redirect, or a bad response_type", async () => {
    await withApp(async (port) => {
      const cases = [
        authorizeQuery({ client_id: "not-ours" }),
        authorizeQuery({ redirect_uri: "https://evil.test/steal" }),
        authorizeQuery({ response_type: "token" }),
        "",
      ];
      for (const query of cases) {
        const res = await request(port, "GET", `${AUTHORIZE}?${query}`);
        expect(res.status).toBe(400);
        // THE point: no redirect back to an unvalidated URI, ever.
        expect(res.headers.location).toBeUndefined();
        expect(res.body).not.toContain("evil.test");
        expect(res.body).toContain("<html");
      }
    });
  });

  it("asks an unauthenticated visitor to sign in, carrying a returnTo back here", async () => {
    await withApp(async (port) => {
      const res = await request(port, "GET", `${AUTHORIZE}?${authorizeQuery()}`);
      expect(res.status).toBe(200);
      expect(res.headers.location).toBeUndefined();
      expect(res.body).toContain("Amazon Alexa");
      expect(res.body).toContain(`/login?returnTo=${encodeURIComponent(`${AUTHORIZE}?`)}`);
      // The consent form must NOT be rendered to a stranger.
      expect(res.body).not.toContain("student_id");
    });
  });

  it("escapes the state it echoes into the page (no script injection)", async () => {
    await withApp(async (port) => {
      const res = await request(
        port,
        "GET",
        `${AUTHORIZE}?${authorizeQuery({ state: '"><script>alert(1)</script>' })}`,
      );
      expect(res.body).not.toContain("<script>alert(1)");
    });
  });
});

describe("POST /token — client authentication and grant type", () => {
  const basic = (id: string, secret: string) =>
    `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

  it("401s invalid_client with no credentials at all", async () => {
    await withApp(async (port) => {
      const res = await request(port, "POST", TOKEN, {
        body: new URLSearchParams({ grant_type: "authorization_code", code: "x" }).toString(),
      });
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body).error).toBe("invalid_client");
      expect(res.headers["www-authenticate"]).toContain("Basic");
      expect(res.headers["cache-control"]).toContain("no-store");
    });
  });

  it("401s invalid_client for an id we don't know, whether by body or by Basic", async () => {
    await withApp(async (port) => {
      const viaBody = await request(port, "POST", TOKEN, {
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "not-ours",
          client_secret: "whatever",
        }).toString(),
      });
      expect(viaBody.status).toBe(401);
      expect(JSON.parse(viaBody.body).error).toBe("invalid_client");

      const viaBasic = await request(port, "POST", TOKEN, {
        headers: { Authorization: basic("not-ours", "whatever") },
        body: new URLSearchParams({ grant_type: "authorization_code" }).toString(),
      });
      expect(viaBasic.status).toBe(401);
      expect(JSON.parse(viaBasic.body).error).toBe("invalid_client");
    });
  });

  it("accepts credentials from EITHER channel (reaching the grant-type check proves it)", async () => {
    await withApp(async (port) => {
      const viaBody = await request(port, "POST", TOKEN, {
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "alexa-test-client",
          client_secret: "alexa-test-secret",
        }).toString(),
      });
      expect(viaBody.status).toBe(400);
      expect(JSON.parse(viaBody.body).error).toBe("unsupported_grant_type");

      const viaBasic = await request(port, "POST", TOKEN, {
        headers: { Authorization: basic("alexa-test-client", "alexa-test-secret") },
        body: new URLSearchParams({ grant_type: "password" }).toString(),
      });
      expect(viaBasic.status).toBe(400);
      expect(JSON.parse(viaBasic.body).error).toBe("unsupported_grant_type");
    });
  });

  it("400s invalid_request when a supported grant is missing its parameters", async () => {
    await withApp(async (port) => {
      const noRedirect = await request(port, "POST", TOKEN, {
        headers: { Authorization: basic("alexa-test-client", "alexa-test-secret") },
        body: new URLSearchParams({ grant_type: "authorization_code", code: "abc" }).toString(),
      });
      expect(noRedirect.status).toBe(400);
      expect(JSON.parse(noRedirect.body).error).toBe("invalid_request");

      const noRefresh = await request(port, "POST", TOKEN, {
        headers: { Authorization: basic("alexa-test-client", "alexa-test-secret") },
        body: new URLSearchParams({ grant_type: "refresh_token" }).toString(),
      });
      expect(noRefresh.status).toBe(400);
      expect(JSON.parse(noRefresh.body).error).toBe("invalid_request");
    });
  });

  it("400s invalid_grant on a wrong secret — never says WHICH part was wrong", async () => {
    await withApp(async (port) => {
      const res = await request(port, "POST", TOKEN, {
        headers: { Authorization: basic("alexa-test-client", "wrong-secret") },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "anything",
          redirect_uri: ALEXA_REDIRECT,
        }).toString(),
      });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "invalid_grant" });
    });
  });
});
