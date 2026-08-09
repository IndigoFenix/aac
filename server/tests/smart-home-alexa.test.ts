// Tests for the Alexa smart-home slice:
//   - handleAlexaDirective — Discovery / AcceptGrant / ReportState / unknown,
//     against SYNTHETIC directive envelopes with every dep injected
//   - alexaEventGateway — dormant (no client credentials in env), the
//     token-refresh + rotation-persistence path, 202, and the 403 that means
//     the family unlinked
//   - alexaTriggerProvider — triggered / not_configured / not_linked / thrown
//
// DB-free by design (runs under test:unit): the vault and the network are both
// injected as fakes, and nothing here imports `router.ts` — the only file in the
// slice that reaches the repositories layer.

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import type { HomeAction } from "@shared/schema";
import {
  handleAlexaDirective,
  alexaTriggerEndpoints,
  alexaFriendlyName,
  ALEXA_DEFAULT_ENDPOINT_DESCRIPTION,
  ALEXA_DEFAULT_FRIENDLY_NAME,
  ALEXA_MANUFACTURER_NAME,
  type AlexaDirectiveDeps,
  type AlexaEventEnvelope,
} from "../services/smart-home/alexa/directive-handler";
import {
  createAlexaEventGateway,
  alexaEventGateway,
  ALEXA_CLIENT_ID_ENV,
  ALEXA_CLIENT_SECRET_ENV,
  ALEXA_EVENT_GATEWAY_URL_ENV,
  ALEXA_EVENT_GATEWAY_URLS,
  type AlexaEventGateway,
  type AlexaGatewayResult,
  type LwaTokenSet,
  type StoredAlexaTokens,
} from "../services/smart-home/alexa/event-gateway-client";
import { createAlexaTriggerProvider } from "../services/smart-home/alexa-trigger-provider";
import type { AccountLinkIdentity } from "../services/smart-home/account-link-service";

const STUDENT_ID = "student-abc";
const BEARER = "aivota-issued-bearer";

/** A mixed slot list: only the ENABLED `alexa` rows may become endpoints. */
const MIXED_ACTIONS: HomeAction[] = [
  { id: "say_lights", label: "Lights on", type: "spoken", command: "Alexa, turn on the lights", enabled: true },
  { id: "google_lamp", label: "Bedroom lamp", type: "google", enabled: true },
  { id: "alexa_fan", label: "Fan off", type: "alexa", enabled: true },
  { id: "alexa_tv", label: "Living room TV", type: "alexa", description: "Turns the TV on", enabled: true },
  { id: "alexa_off", label: "Disabled slot", type: "alexa", enabled: false },
];

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface StoreCall {
  studentId: string;
  tokens: LwaTokenSet;
}

function fakeDeps(overrides: Partial<AlexaDirectiveDeps> = {}): AlexaDirectiveDeps & { stored: StoreCall[] } {
  const stored: StoreCall[] = [];
  return {
    stored,
    async resolveBearer(token: string): Promise<AccountLinkIdentity | null> {
      return token === BEARER ? { studentId: STUDENT_ID, provider: "alexa" } : null;
    },
    async loadHomeActions() {
      return MIXED_ACTIONS;
    },
    async exchangeGrantCode() {
      return {
        ok: true as const,
        tokens: { accessToken: "Atza|new", refreshToken: "Atzr|new", expiresAtMs: Date.now() + 3_600_000 },
      };
    },
    async storeEventGatewayTokens(studentId, tokens) {
      stored.push({ studentId, tokens });
    },
    ...overrides,
  };
}

function discoverDirective(token: string) {
  return {
    directive: {
      header: {
        namespace: "Alexa.Discovery",
        name: "Discover",
        messageId: "msg-1",
        payloadVersion: "3",
      },
      payload: { scope: { type: "BearerToken", token } },
    },
  };
}

function acceptGrantDirective(granteeToken: string, code: string) {
  return {
    directive: {
      header: {
        namespace: "Alexa.Authorization",
        name: "AcceptGrant",
        messageId: "msg-2",
        payloadVersion: "3",
      },
      payload: {
        grant: { type: "OAuth2.AuthorizationCode", code },
        grantee: { type: "BearerToken", token: granteeToken },
      },
    },
  };
}

function reportStateDirective(token: string, endpointId: string) {
  return {
    directive: {
      header: {
        namespace: "Alexa",
        name: "ReportState",
        messageId: "msg-3",
        correlationToken: "corr-xyz",
        payloadVersion: "3",
      },
      endpoint: { scope: { type: "BearerToken", token }, endpointId, cookie: {} },
      payload: {},
    },
  };
}

/** A duck-typed fetch Response — avoids depending on a global `Response`. */
function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  } as unknown as Response;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response): {
  impl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const impl = (async (input: any, init: any) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

interface VaultSpy {
  saved: LwaTokenSet[];
  dropped: string[];
}

function fakeVault(initial: StoredAlexaTokens | null): {
  deps: {
    getTokens: (studentId: string) => Promise<StoredAlexaTokens | null>;
    saveTokens: (studentId: string, tokens: LwaTokenSet) => Promise<void>;
    dropTokens: (studentId: string) => Promise<void>;
  };
  spy: VaultSpy;
} {
  let current = initial;
  const spy: VaultSpy = { saved: [], dropped: [] };
  return {
    spy,
    deps: {
      async getTokens() {
        return current;
      },
      async saveTokens(_studentId, tokens) {
        spy.saved.push(tokens);
        current = {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenExpiresAt: new Date(tokens.expiresAtMs),
        };
      },
      async dropTokens(studentId) {
        spy.dropped.push(studentId);
        current = null;
      },
    },
  };
}

/** A gateway that answers with whatever the test asks for. */
function fakeGateway(configured: boolean, result: AlexaGatewayResult = { ok: true }): AlexaEventGateway & {
  presses: Array<{ studentId: string; endpointId: string }>;
} {
  const presses: Array<{ studentId: string; endpointId: string }> = [];
  return {
    presses,
    isConfigured: () => configured,
    async exchangeGrantCode() {
      return { ok: false, reason: "not_configured" };
    },
    async sendDoorbellPress(studentId, endpointId) {
      presses.push({ studentId, endpointId });
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("Alexa Discovery", () => {
  test("only ENABLED alexa slots become endpoints", async () => {
    const response = await handleAlexaDirective(discoverDirective(BEARER), fakeDeps());
    const endpoints = (response.event.payload as any).endpoints as any[];

    expect(response.event.header).toMatchObject({
      namespace: "Alexa.Discovery",
      name: "Discover.Response",
      payloadVersion: "3",
    });
    expect(typeof response.event.header.messageId).toBe("string");
    expect(endpoints.map((e) => e.endpointId)).toEqual(["alexa_fan", "alexa_tv"]);
    // spoken slots actuate on the device, google slots belong to the other
    // ecosystem, and a disabled slot stays authored but inert.
    expect(endpoints.map((e) => e.endpointId)).not.toContain("say_lights");
    expect(endpoints.map((e) => e.endpointId)).not.toContain("google_lamp");
    expect(endpoints.map((e) => e.endpointId)).not.toContain("alexa_off");
  });

  test("endpoint shape matches the Discover.Response spec", async () => {
    const response = await handleAlexaDirective(discoverDirective(BEARER), fakeDeps());
    const [fan, tv] = (response.event.payload as any).endpoints as any[];

    expect(fan).toEqual({
      endpointId: "alexa_fan",
      manufacturerName: ALEXA_MANUFACTURER_NAME,
      description: ALEXA_DEFAULT_ENDPOINT_DESCRIPTION,
      friendlyName: "Fan off",
      displayCategories: ["DOORBELL"],
      capabilities: [
        { type: "AlexaInterface", interface: "Alexa", version: "3" },
        {
          type: "AlexaInterface",
          interface: "Alexa.DoorbellEventSource",
          version: "3",
          // proactivelyReported sits at CAPABILITY level for an event source —
          // there is no `properties` block.
          proactivelyReported: true,
        },
        {
          type: "AlexaInterface",
          interface: "Alexa.EndpointHealth",
          version: "3.1",
          properties: {
            supported: [{ name: "connectivity" }],
            proactivelyReported: false,
            retrievable: true,
          },
        },
      ],
    });
    // A clinician-authored description wins over the default.
    expect(tv.description).toBe("Turns the TV on");
  });

  test("an unresolvable bearer is an auth ERROR, never an empty device list", async () => {
    const response = await handleAlexaDirective(discoverDirective("nope"), fakeDeps());
    expect(response.event.header.namespace).toBe("Alexa");
    expect(response.event.header.name).toBe("ErrorResponse");
    expect(response.event.payload.type).toBe("INVALID_AUTHORIZATION_CREDENTIAL");
    expect(response.event.payload).not.toHaveProperty("endpoints");
  });

  test("a bearer minted for the OTHER ecosystem is rejected too", async () => {
    const deps = fakeDeps({
      async resolveBearer() {
        return { studentId: STUDENT_ID, provider: "google" };
      },
    });
    const response = await handleAlexaDirective(discoverDirective(BEARER), deps);
    expect(response.event.payload.type).toBe("INVALID_AUTHORIZATION_CREDENTIAL");
  });

  test("a linked student with no cloud slots discovers an EMPTY list (not an error)", async () => {
    const deps = fakeDeps({
      async loadHomeActions() {
        return MIXED_ACTIONS.filter((a) => a.type !== "alexa");
      },
    });
    const response = await handleAlexaDirective(discoverDirective(BEARER), deps);
    expect(response.event.header.name).toBe("Discover.Response");
    expect((response.event.payload as any).endpoints).toEqual([]);
  });
});

describe("alexaFriendlyName", () => {
  test("drops emoji and punctuation Alexa will not accept", () => {
    expect(alexaFriendlyName("🔦 Lights — on!")).toBe("Lights on");
  });

  test("keeps non-Latin letters intact", () => {
    expect(alexaFriendlyName("אורות בסלון")).toBe("אורות בסלון");
    expect(alexaFriendlyName("Ligar a luz")).toBe("Ligar a luz");
  });

  test("falls back when a label sanitizes down to nothing", () => {
    expect(alexaFriendlyName("💡✨")).toBe(ALEXA_DEFAULT_FRIENDLY_NAME);
  });

  test("endpoints use the sanitized name", () => {
    const [endpoint] = alexaTriggerEndpoints([
      { id: "a", label: "🔔 Doorbell!", type: "alexa", enabled: true },
    ]);
    expect(endpoint.friendlyName).toBe("Doorbell");
  });
});

// ---------------------------------------------------------------------------
// AcceptGrant
// ---------------------------------------------------------------------------

describe("Alexa.Authorization AcceptGrant", () => {
  test("exchanges the code and stores the event-gateway tokens", async () => {
    const deps = fakeDeps();
    const response = await handleAlexaDirective(acceptGrantDirective(BEARER, "someAuthCode"), deps);

    expect(response.event.header).toMatchObject({
      namespace: "Alexa.Authorization",
      name: "AcceptGrant.Response",
      payloadVersion: "3",
    });
    expect(response.event.payload).toEqual({});
    expect(deps.stored).toHaveLength(1);
    expect(deps.stored[0].studentId).toBe(STUDENT_ID);
    expect(deps.stored[0].tokens).toMatchObject({
      accessToken: "Atza|new",
      refreshToken: "Atzr|new",
    });
    expect(deps.stored[0].tokens.expiresAtMs).toBeGreaterThan(Date.now());
  });

  test("passes the grant code through to the exchange", async () => {
    const codes: string[] = [];
    const deps = fakeDeps({
      async exchangeGrantCode(code) {
        codes.push(code);
        return { ok: true, tokens: { accessToken: "a", refreshToken: "r", expiresAtMs: Date.now() + 1000 } };
      },
    });
    await handleAlexaDirective(acceptGrantDirective(BEARER, "code-42"), deps);
    expect(codes).toEqual(["code-42"]);
  });

  test("an exchange failure is an Alexa.Authorization ErrorResponse and stores nothing", async () => {
    const deps = fakeDeps({
      async exchangeGrantCode() {
        return { ok: false, reason: "auth_failed", detail: "400 invalid_client" };
      },
    });
    const response = await handleAlexaDirective(acceptGrantDirective(BEARER, "someAuthCode"), deps);

    expect(response.event.header.namespace).toBe("Alexa.Authorization");
    expect(response.event.header.name).toBe("ErrorResponse");
    expect(response.event.payload.type).toBe("ACCEPT_GRANT_FAILED");
    expect(typeof response.event.payload.message).toBe("string");
    expect(deps.stored).toHaveLength(0);
  });

  test("an unresolvable grantee token never reaches the exchange", async () => {
    let exchanged = false;
    const deps = fakeDeps({
      async exchangeGrantCode() {
        exchanged = true;
        return { ok: true, tokens: { accessToken: "a", refreshToken: "r", expiresAtMs: 0 } };
      },
    });
    const response = await handleAlexaDirective(acceptGrantDirective("nope", "someAuthCode"), deps);

    expect(response.event.header.namespace).toBe("Alexa.Authorization");
    expect(response.event.payload.type).toBe("INVALID_AUTHORIZATION_CREDENTIAL");
    expect(exchanged).toBe(false);
    expect(deps.stored).toHaveLength(0);
  });

  test("a missing grant code fails rather than storing an empty grant", async () => {
    const deps = fakeDeps();
    const response = await handleAlexaDirective(acceptGrantDirective(BEARER, ""), deps);
    expect(response.event.payload.type).toBe("ACCEPT_GRANT_FAILED");
    expect(deps.stored).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ReportState
// ---------------------------------------------------------------------------

describe("Alexa ReportState", () => {
  test("answers a spec-shaped StateReport with EndpointHealth OK", async () => {
    const response = await handleAlexaDirective(reportStateDirective(BEARER, "alexa_fan"), fakeDeps());

    expect(response.event.header).toMatchObject({
      namespace: "Alexa",
      name: "StateReport",
      payloadVersion: "3",
      correlationToken: "corr-xyz",
    });
    expect(response.event.endpoint).toEqual({ endpointId: "alexa_fan" });
    expect(response.event.payload).toEqual({});

    const properties = response.context?.properties ?? [];
    expect(properties).toHaveLength(1);
    expect(properties[0]).toMatchObject({
      namespace: "Alexa.EndpointHealth",
      name: "connectivity",
      // NESTED value — EndpointHealth's connectivity is an object, not "OK".
      value: { value: "OK" },
      uncertaintyInMilliseconds: 0,
    });
    expect(properties[0].timeOfSample).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("a deleted or disabled slot reports NO_SUCH_ENDPOINT", async () => {
    const response = await handleAlexaDirective(reportStateDirective(BEARER, "alexa_off"), fakeDeps());
    expect(response.event.header.name).toBe("ErrorResponse");
    expect(response.event.payload.type).toBe("NO_SUCH_ENDPOINT");
    expect(response.event.header.correlationToken).toBe("corr-xyz");
    expect(response.event.endpoint?.endpointId).toBe("alexa_off");
  });

  test("an unresolvable bearer reports INVALID_AUTHORIZATION_CREDENTIAL", async () => {
    const response = await handleAlexaDirective(reportStateDirective("nope", "alexa_fan"), fakeDeps());
    expect(response.event.payload.type).toBe("INVALID_AUTHORIZATION_CREDENTIAL");
  });
});

// ---------------------------------------------------------------------------
// Unknown / malformed directives
// ---------------------------------------------------------------------------

describe("unsupported directives", () => {
  test("a controller directive we do not implement is INVALID_DIRECTIVE", async () => {
    const response = await handleAlexaDirective(
      {
        directive: {
          header: {
            namespace: "Alexa.PowerController",
            name: "TurnOn",
            messageId: "m",
            correlationToken: "corr-1",
            payloadVersion: "3",
          },
          endpoint: { scope: { type: "BearerToken", token: BEARER }, endpointId: "alexa_fan" },
          payload: {},
        },
      },
      fakeDeps(),
    );

    expect(response.event.header.namespace).toBe("Alexa");
    expect(response.event.header.name).toBe("ErrorResponse");
    expect(response.event.payload.type).toBe("INVALID_DIRECTIVE");
    expect(response.event.header.correlationToken).toBe("corr-1");
    expect(response.event.endpoint?.endpointId).toBe("alexa_fan");
  });

  test("garbage off the wire never throws", async () => {
    for (const body of [undefined, null, {}, { directive: {} }, "nonsense", 7]) {
      const response: AlexaEventEnvelope = await handleAlexaDirective(body, fakeDeps());
      expect(response.event.payload.type).toBe("INVALID_DIRECTIVE");
    }
  });

  test("a dep that throws degrades to INTERNAL_ERROR, not a rejection", async () => {
    const deps = fakeDeps({
      async loadHomeActions() {
        throw new Error("db exploded");
      },
    });
    const response = await handleAlexaDirective(discoverDirective(BEARER), deps);
    expect(response.event.payload.type).toBe("INTERNAL_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Event gateway client
// ---------------------------------------------------------------------------

describe("alexaEventGateway", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [ALEXA_CLIENT_ID_ENV, ALEXA_CLIENT_SECRET_ENV, ALEXA_EVENT_GATEWAY_URL_ENV]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function configure(): void {
    process.env[ALEXA_CLIENT_ID_ENV] = "amzn1.application-oa2-client.test";
    process.env[ALEXA_CLIENT_SECRET_ENV] = "test-secret";
  }

  test("is dormant with no client credentials in env", async () => {
    expect(alexaEventGateway.isConfigured()).toBe(false);
    await expect(alexaEventGateway.sendDoorbellPress(STUDENT_ID, "alexa_fan")).resolves.toEqual({
      ok: false,
      reason: "not_configured",
    });
    await expect(alexaEventGateway.exchangeGrantCode("code")).resolves.toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  test("configured but unlinked soft-fails with not_linked", async () => {
    configure();
    const vault = fakeVault(null);
    const net = fakeFetch(() => fakeResponse(202, ""));
    const gateway = createAlexaEventGateway({ ...vault.deps, fetchImpl: net.impl });

    expect(gateway.isConfigured()).toBe(true);
    await expect(gateway.sendDoorbellPress(STUDENT_ID, "alexa_fan")).resolves.toEqual({
      ok: false,
      reason: "not_linked",
    });
    expect(net.calls).toHaveLength(0);
  });

  test("posts a spec-shaped DoorbellPress to the NA gateway and accepts 202", async () => {
    configure();
    const vault = fakeVault({
      accessToken: "Atza|live",
      refreshToken: "Atzr|live",
      tokenExpiresAt: new Date(Date.now() + 30 * 60_000),
    });
    const net = fakeFetch(() => fakeResponse(202, ""));
    const gateway = createAlexaEventGateway({ ...vault.deps, fetchImpl: net.impl });

    await expect(gateway.sendDoorbellPress(STUDENT_ID, "alexa_fan")).resolves.toEqual({ ok: true });

    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].url).toBe(ALEXA_EVENT_GATEWAY_URLS.na);
    const headers = net.calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer Atza|live");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(String(net.calls[0].init.body));
    expect(body.context).toEqual({});
    expect(body.event.header).toMatchObject({
      namespace: "Alexa.DoorbellEventSource",
      name: "DoorbellPress",
      payloadVersion: "3",
    });
    // The token goes in the header AND the body — the doc requires both.
    expect(body.event.endpoint).toMatchObject({
      scope: { type: "BearerToken", token: "Atza|live" },
      endpointId: "alexa_fan",
    });
    expect(body.event.payload.cause).toEqual({ type: "PHYSICAL_INTERACTION" });
    expect(body.event.payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // No rotation happened, so nothing was written back.
    expect(vault.spy.saved).toHaveLength(0);
  });

  test("honours a regional gateway override", async () => {
    configure();
    process.env[ALEXA_EVENT_GATEWAY_URL_ENV] = ALEXA_EVENT_GATEWAY_URLS.eu;
    const vault = fakeVault({
      accessToken: "Atza|live",
      refreshToken: "Atzr|live",
      tokenExpiresAt: new Date(Date.now() + 30 * 60_000),
    });
    const net = fakeFetch(() => fakeResponse(202, ""));
    const gateway = createAlexaEventGateway({ ...vault.deps, fetchImpl: net.impl });

    await gateway.sendDoorbellPress(STUDENT_ID, "alexa_fan");
    expect(net.calls[0].url).toBe(ALEXA_EVENT_GATEWAY_URLS.eu);
  });

  test("refreshes an expired token, PERSISTS the rotated pair and uses the new one", async () => {
    configure();
    const vault = fakeVault({
      accessToken: "Atza|stale",
      refreshToken: "Atzr|old",
      tokenExpiresAt: new Date(Date.now() - 1000),
    });
    const net = fakeFetch((url) => {
      if (url.includes("api.amazon.com")) {
        return fakeResponse(200, {
          access_token: "Atza|fresh",
          refresh_token: "Atzr|rotated",
          token_type: "bearer",
          expires_in: 3600,
        });
      }
      return fakeResponse(202, "");
    });
    const gateway = createAlexaEventGateway({ ...vault.deps, fetchImpl: net.impl });

    await expect(gateway.sendDoorbellPress(STUDENT_ID, "alexa_fan")).resolves.toEqual({ ok: true });

    // LWA first, then the gateway.
    expect(net.calls).toHaveLength(2);
    expect(net.calls[0].url).toBe("https://api.amazon.com/auth/o2/token");
    const form = new URLSearchParams(String(net.calls[0].init.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("Atzr|old");
    expect(form.get("client_id")).toBe("amzn1.application-oa2-client.test");
    expect(form.get("client_secret")).toBe("test-secret");

    // LWA rotates the refresh token; losing the new one would strand the link.
    expect(vault.spy.saved).toHaveLength(1);
    expect(vault.spy.saved[0]).toMatchObject({
      accessToken: "Atza|fresh",
      refreshToken: "Atzr|rotated",
    });
    expect(vault.spy.saved[0].expiresAtMs).toBeGreaterThan(Date.now());

    const headers = net.calls[1].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer Atza|fresh");
  });

  test("a revoked refresh token deletes the connection and soft-fails", async () => {
    configure();
    const vault = fakeVault({
      accessToken: "Atza|stale",
      refreshToken: "Atzr|revoked",
      tokenExpiresAt: new Date(Date.now() - 1000),
    });
    const net = fakeFetch(() => fakeResponse(400, { error: "invalid_grant" }));
    const gateway = createAlexaEventGateway({ ...vault.deps, fetchImpl: net.impl });

    const result = await gateway.sendDoorbellPress(STUDENT_ID, "alexa_fan");
    expect(result).toMatchObject({ ok: false, reason: "unlinked" });
    expect(vault.spy.dropped).toEqual([STUDENT_ID]);
  });

  test("a 403 skill-disabled deletes the stale grant and soft-fails", async () => {
    configure();
    const vault = fakeVault({
      accessToken: "Atza|live",
      refreshToken: "Atzr|live",
      tokenExpiresAt: new Date(Date.now() + 30 * 60_000),
    });
    const net = fakeFetch(() =>
      fakeResponse(403, { payload: { code: "SKILL_DISABLED_EXCEPTION", description: "disabled" } }),
    );
    const gateway = createAlexaEventGateway({ ...vault.deps, fetchImpl: net.impl });

    const result = await gateway.sendDoorbellPress(STUDENT_ID, "alexa_fan");
    expect(result).toMatchObject({ ok: false, reason: "unlinked" });
    expect(vault.spy.dropped).toEqual([STUDENT_ID]);
  });

  test("a 403 permissions gap is a DEPLOYMENT problem — the grant survives", async () => {
    configure();
    const vault = fakeVault({
      accessToken: "Atza|live",
      refreshToken: "Atzr|live",
      tokenExpiresAt: new Date(Date.now() + 30 * 60_000),
    });
    const net = fakeFetch(() =>
      fakeResponse(403, { payload: { code: "INSUFFICIENT_PERMISSION_EXCEPTION" } }),
    );
    const gateway = createAlexaEventGateway({ ...vault.deps, fetchImpl: net.impl });

    const result = await gateway.sendDoorbellPress(STUDENT_ID, "alexa_fan");
    expect(result).toMatchObject({ ok: false, reason: "insufficient_permission" });
    expect(vault.spy.dropped).toEqual([]);
  });

  test("a 401 on a token we believed live refreshes once and retries", async () => {
    configure();
    const vault = fakeVault({
      accessToken: "Atza|rejected",
      refreshToken: "Atzr|live",
      tokenExpiresAt: new Date(Date.now() + 30 * 60_000),
    });
    let gatewayCalls = 0;
    const net = fakeFetch((url) => {
      if (url.includes("api.amazon.com")) {
        return fakeResponse(200, {
          access_token: "Atza|second",
          refresh_token: "Atzr|second",
          expires_in: 3600,
        });
      }
      gatewayCalls++;
      return gatewayCalls === 1
        ? fakeResponse(401, { payload: { code: "INVALID_ACCESS_TOKEN_EXCEPTION" } })
        : fakeResponse(202, "");
    });
    const gateway = createAlexaEventGateway({ ...vault.deps, fetchImpl: net.impl });

    await expect(gateway.sendDoorbellPress(STUDENT_ID, "alexa_fan")).resolves.toEqual({ ok: true });
    expect(gatewayCalls).toBe(2);
    expect(vault.spy.saved).toHaveLength(1);
    expect(vault.spy.dropped).toEqual([]);
  });

  test("a network failure is a typed soft-fail, never a throw", async () => {
    configure();
    const vault = fakeVault({
      accessToken: "Atza|live",
      refreshToken: "Atzr|live",
      tokenExpiresAt: new Date(Date.now() + 30 * 60_000),
    });
    const impl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const gateway = createAlexaEventGateway({ ...vault.deps, fetchImpl: impl });

    await expect(gateway.sendDoorbellPress(STUDENT_ID, "alexa_fan")).resolves.toMatchObject({
      ok: false,
      reason: "network_error",
    });
  });

  test("exchangeGrantCode sends the authorization_code grant WITHOUT a redirect_uri", async () => {
    configure();
    const vault = fakeVault(null);
    const net = fakeFetch(() =>
      fakeResponse(200, { access_token: "Atza|a", refresh_token: "Atzr|r", expires_in: 3600 }),
    );
    const gateway = createAlexaEventGateway({ ...vault.deps, fetchImpl: net.impl });

    const result = await gateway.exchangeGrantCode("someAuthCode");
    expect(result.ok).toBe(true);

    const form = new URLSearchParams(String(net.calls[0].init.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("someAuthCode");
    // The doc is explicit: "Don't include a redirect_uri in the access token request."
    expect(form.has("redirect_uri")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Provider mapping
// ---------------------------------------------------------------------------

describe("alexaTriggerProvider", () => {
  const ACTION: HomeAction = { id: "alexa_fan", label: "Fan off", type: "alexa", enabled: true };

  test("a delivered DoorbellPress is a triggered outcome", async () => {
    const gateway = fakeGateway(true, { ok: true });
    const provider = createAlexaTriggerProvider({ gateway });

    await expect(provider.execute(ACTION, { studentId: STUDENT_ID })).resolves.toEqual({
      kind: "triggered",
    });
    // The endpointId IS the action id — the virtual-device law.
    expect(gateway.presses).toEqual([{ studentId: STUDENT_ID, endpointId: "alexa_fan" }]);
  });

  test("an unconfigured deployment soft-fails before touching the vault", async () => {
    const gateway = fakeGateway(false);
    const provider = createAlexaTriggerProvider({ gateway });

    await expect(provider.execute(ACTION, { studentId: STUDENT_ID })).resolves.toEqual({
      kind: "failed",
      reason: "not_configured",
    });
    expect(gateway.presses).toHaveLength(0);
  });

  test("gateway failure reasons pass through unchanged", async () => {
    for (const reason of ["not_linked", "unlinked", "throttled", "http_error"] as const) {
      const provider = createAlexaTriggerProvider({ gateway: fakeGateway(true, { ok: false, reason }) });
      await expect(provider.execute(ACTION, { studentId: STUDENT_ID })).resolves.toEqual({
        kind: "failed",
        reason,
      });
    }
  });

  test("a thrown gateway becomes a soft-fail, never an exception in the press path", async () => {
    const gateway: AlexaEventGateway = {
      isConfigured: () => true,
      async exchangeGrantCode() {
        return { ok: false, reason: "not_configured" };
      },
      async sendDoorbellPress() {
        throw new Error("boom");
      },
    };
    await expect(
      createAlexaTriggerProvider({ gateway }).execute(ACTION, { studentId: STUDENT_ID }),
    ).resolves.toEqual({ kind: "failed", reason: "alexa_error" });
  });

  test("a missing student or action id never reaches the gateway", async () => {
    const gateway = fakeGateway(true);
    const provider = createAlexaTriggerProvider({ gateway });

    await expect(provider.execute(ACTION, { studentId: "" })).resolves.toEqual({
      kind: "failed",
      reason: "no_student",
    });
    await expect(
      provider.execute({ ...ACTION, id: "" }, { studentId: STUDENT_ID }),
    ).resolves.toEqual({ kind: "failed", reason: "no_action_id" });
    expect(gateway.presses).toHaveLength(0);
  });
});
