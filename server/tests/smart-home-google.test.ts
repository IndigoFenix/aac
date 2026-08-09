// Tests for the Google cloud-to-cloud smart-home slice:
//   - handleGoogleFulfillment — SYNC / QUERY / EXECUTE / DISCONNECT against
//     synthetic Google intent envelopes, with injected deps
//   - googleTriggerProvider — not_linked / not_configured / the awaited
//     open→closed state TRANSITION / thrown-error soft-fail
//   - homeGraphClient — dormant (no service account in env) never throws
//
// DB-free by design (runs under test:unit): nothing here imports `router.ts`,
// which is the only file in the slice that reaches the repositories layer.

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import type { HomeAction } from "@shared/schema";
import {
  handleGoogleFulfillment,
  googleTriggerDevices,
  GOOGLE_TRIGGER_DEVICE_TYPE,
  GOOGLE_TRIGGER_TRAIT,
  type GoogleFulfillmentDeps,
  type GoogleSyncResponse,
  type GoogleQueryResponse,
  type GoogleExecuteResponse,
  type GoogleErrorResponse,
} from "../services/smart-home/google/fulfillment";
import {
  homeGraphClient,
  resetHomeGraphCachesForTesting,
  HOMEGRAPH_SERVICE_ACCOUNT_ENV,
  type HomeGraphClient,
  type HomeGraphDeviceState,
  type HomeGraphResult,
} from "../services/smart-home/google/homegraph-client";
import { createGoogleTriggerProvider } from "../services/smart-home/google-trigger-provider";
import type { AccountLinkGrant } from "../services/smart-home/account-link-service";

const STUDENT_ID = "student-abc";

/** A mixed slot list: only the ENABLED `google` rows may become devices. */
const MIXED_ACTIONS: HomeAction[] = [
  { id: "say_lights", label: "Lights on", type: "spoken", command: "Alexa, turn on the lights", enabled: true },
  { id: "alexa_fan", label: "Fan off", type: "alexa", enabled: true },
  { id: "google_lamp", label: "Bedroom lamp", type: "google", enabled: true },
  { id: "google_tv", label: "Living room TV", type: "google", enabled: true },
  { id: "google_off", label: "Disabled slot", type: "google", enabled: false },
];

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface ReportCall {
  agentUserId: string;
  states: Record<string, HomeGraphDeviceState>;
}

function fakeHomeGraph(
  configured: boolean,
  result: HomeGraphResult = { ok: true },
): HomeGraphClient & { calls: ReportCall[]; syncs: string[] } {
  const calls: ReportCall[] = [];
  const syncs: string[] = [];
  return {
    calls,
    syncs,
    isConfigured: () => configured,
    async reportState(agentUserId, states) {
      calls.push({ agentUserId, states });
      return result;
    },
    async requestSyncForStudent(agentUserId) {
      syncs.push(agentUserId);
      return result;
    },
  };
}

function deps(overrides: Partial<GoogleFulfillmentDeps> = {}): GoogleFulfillmentDeps {
  return {
    loadHomeActions: async () => MIXED_ACTIONS,
    ...overrides,
  };
}

const grant: AccountLinkGrant = {
  studentId: STUDENT_ID,
  provider: "google",
  grantedByUserId: "user-1",
  grantedAt: Date.now(),
};

function envelope(intent: string, payload?: unknown) {
  return {
    requestId: "req-1",
    inputs: [payload === undefined ? { intent } : { intent, payload }],
  };
}

// ---------------------------------------------------------------------------
// SYNC
// ---------------------------------------------------------------------------

describe("handleGoogleFulfillment — SYNC", () => {
  test("exposes one contact-sensor device per ENABLED google slot", async () => {
    const response = (await handleGoogleFulfillment(
      envelope("action.devices.SYNC"),
      { studentId: STUDENT_ID },
      deps(),
    )) as GoogleSyncResponse;

    expect(response.requestId).toBe("req-1");
    // agentUserId IS the studentId.
    expect(response.payload.agentUserId).toBe(STUDENT_ID);
    expect(response.payload.devices.map((d) => d.id)).toEqual(["google_lamp", "google_tv"]);
  });

  test("spoken and alexa slots NEVER appear as Google devices", async () => {
    const response = (await handleGoogleFulfillment(
      envelope("action.devices.SYNC"),
      { studentId: STUDENT_ID },
      deps(),
    )) as GoogleSyncResponse;

    const ids = response.payload.devices.map((d) => d.id);
    expect(ids).not.toContain("say_lights");
    expect(ids).not.toContain("alexa_fan");
    expect(ids).not.toContain("google_off"); // disabled
  });

  test("device shape is a starter-eligible query-only OpenClose sensor", async () => {
    const response = (await handleGoogleFulfillment(
      envelope("action.devices.SYNC"),
      { studentId: STUDENT_ID },
      deps(),
    )) as GoogleSyncResponse;

    const device = response.payload.devices[0];
    expect(device.type).toBe(GOOGLE_TRIGGER_DEVICE_TYPE);
    expect(device.traits).toEqual([GOOGLE_TRIGGER_TRAIT]);
    expect(device.name.name).toBe("Bedroom lamp");
    // Report State only works for devices that declare it.
    expect(device.willReportState).toBe(true);
    expect(device.attributes).toMatchObject({
      queryOnlyOpenClose: true,
      discreteOnlyOpenClose: true,
    });
  });

  test("an empty slot list yields an empty device list, not an error", async () => {
    const response = (await handleGoogleFulfillment(
      envelope("action.devices.SYNC"),
      { studentId: STUDENT_ID },
      deps({ loadHomeActions: async () => [] }),
    )) as GoogleSyncResponse;

    expect(response.payload.devices).toEqual([]);
  });

  test("primes Home Graph with the RESTING state of every synced device", async () => {
    const homegraph = fakeHomeGraph(true);
    await handleGoogleFulfillment(
      envelope("action.devices.SYNC"),
      { studentId: STUDENT_ID },
      deps({ homegraph }),
    );

    expect(homegraph.calls).toHaveLength(1);
    expect(homegraph.calls[0].agentUserId).toBe(STUDENT_ID);
    expect(homegraph.calls[0].states).toEqual({
      google_lamp: { online: true, openPercent: 0 },
      google_tv: { online: true, openPercent: 0 },
    });
  });

  test("skips priming when Home Graph is unconfigured, and still answers SYNC", async () => {
    const homegraph = fakeHomeGraph(false);
    const response = (await handleGoogleFulfillment(
      envelope("action.devices.SYNC"),
      { studentId: STUDENT_ID },
      deps({ homegraph }),
    )) as GoogleSyncResponse;

    expect(homegraph.calls).toHaveLength(0);
    expect(response.payload.devices).toHaveLength(2);
  });

  test("a priming failure never spoils the SYNC answer", async () => {
    const homegraph: HomeGraphClient = {
      isConfigured: () => true,
      reportState: async () => {
        throw new Error("home graph down");
      },
      requestSyncForStudent: async () => ({ ok: true }),
    };

    const response = (await handleGoogleFulfillment(
      envelope("action.devices.SYNC"),
      { studentId: STUDENT_ID },
      deps({ homegraph }),
    )) as GoogleSyncResponse;

    expect(response.payload.devices).toHaveLength(2);
  });

  test("googleTriggerDevices is the single definition of the device list", () => {
    expect(googleTriggerDevices(MIXED_ACTIONS).map((d) => d.id)).toEqual([
      "google_lamp",
      "google_tv",
    ]);
  });
});

// ---------------------------------------------------------------------------
// QUERY
// ---------------------------------------------------------------------------

describe("handleGoogleFulfillment — QUERY", () => {
  test("every requested device reports the resting state, online", async () => {
    const response = (await handleGoogleFulfillment(
      envelope("action.devices.QUERY", { devices: [{ id: "google_lamp" }, { id: "google_tv" }] }),
      { studentId: STUDENT_ID },
      deps(),
    )) as GoogleQueryResponse;

    expect(response.requestId).toBe("req-1");
    expect(response.payload.devices).toEqual({
      google_lamp: { online: true, openPercent: 0, status: "SUCCESS" },
      google_tv: { online: true, openPercent: 0, status: "SUCCESS" },
    });
  });

  test("ignores malformed device entries instead of throwing", async () => {
    const response = (await handleGoogleFulfillment(
      envelope("action.devices.QUERY", { devices: [{ id: "" }, { id: 7 }, null, { id: "ok" }] }),
      { studentId: STUDENT_ID },
      deps(),
    )) as GoogleQueryResponse;

    expect(Object.keys(response.payload.devices)).toEqual(["ok"]);
  });

  test("a missing payload yields an empty device map", async () => {
    const response = (await handleGoogleFulfillment(
      envelope("action.devices.QUERY"),
      { studentId: STUDENT_ID },
      deps(),
    )) as GoogleQueryResponse;

    expect(response.payload.devices).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// EXECUTE
// ---------------------------------------------------------------------------

describe("handleGoogleFulfillment — EXECUTE", () => {
  test("rejects every command with functionNotSupported (the devices are sensors)", async () => {
    const response = (await handleGoogleFulfillment(
      envelope("action.devices.EXECUTE", {
        commands: [
          {
            devices: [{ id: "google_lamp" }, { id: "google_tv" }],
            execution: [
              { command: "action.devices.commands.OpenClose", params: { openPercent: 100 } },
            ],
          },
        ],
      }),
      { studentId: STUDENT_ID },
      deps(),
    )) as GoogleExecuteResponse;

    expect(response.payload.commands).toEqual([
      { ids: ["google_lamp", "google_tv"], status: "ERROR", errorCode: "functionNotSupported" },
    ]);
  });

  test("dedupes ids across command groups", async () => {
    const response = (await handleGoogleFulfillment(
      envelope("action.devices.EXECUTE", {
        commands: [
          { devices: [{ id: "a" }], execution: [] },
          { devices: [{ id: "a" }, { id: "b" }], execution: [] },
        ],
      }),
      { studentId: STUDENT_ID },
      deps(),
    )) as GoogleExecuteResponse;

    expect(response.payload.commands[0].ids).toEqual(["a", "b"]);
  });

  test("an empty command list yields no command results", async () => {
    const response = (await handleGoogleFulfillment(
      envelope("action.devices.EXECUTE", { commands: [] }),
      { studentId: STUDENT_ID },
      deps(),
    )) as GoogleExecuteResponse;

    expect(response.payload.commands).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DISCONNECT + malformed envelopes
// ---------------------------------------------------------------------------

describe("handleGoogleFulfillment — DISCONNECT and bad input", () => {
  test("acknowledges with an empty body and drops the grant", async () => {
    const revoked: Array<[string, string]> = [];
    const response = await handleGoogleFulfillment(
      envelope("action.devices.DISCONNECT"),
      { studentId: STUDENT_ID },
      deps({
        async revokeAccountLink(studentId, provider) {
          revoked.push([studentId, provider]);
        },
      }),
    );

    expect(response).toEqual({});
    expect(revoked).toEqual([[STUDENT_ID, "google"]]);
  });

  test("still acknowledges when the revoke throws (the stub does)", async () => {
    const response = await handleGoogleFulfillment(
      envelope("action.devices.DISCONNECT"),
      { studentId: STUDENT_ID },
      deps({
        async revokeAccountLink() {
          throw new Error("not implemented yet");
        },
      }),
    );

    expect(response).toEqual({});
  });

  test("an unknown intent answers notSupported", async () => {
    const response = (await handleGoogleFulfillment(
      envelope("action.devices.NONSENSE"),
      { studentId: STUDENT_ID },
      deps(),
    )) as GoogleErrorResponse;

    expect(response.payload.errorCode).toBe("notSupported");
  });

  test("a garbage body does not throw", async () => {
    for (const body of [undefined, null, {}, { inputs: [] }, { inputs: "nope" }, 42]) {
      const response = (await handleGoogleFulfillment(
        body,
        { studentId: STUDENT_ID },
        deps(),
      )) as GoogleErrorResponse;
      expect(response.payload.errorCode).toBe("notSupported");
    }
  });
});

// ---------------------------------------------------------------------------
// The trigger provider
// ---------------------------------------------------------------------------

describe("googleTriggerProvider", () => {
  const action: HomeAction = {
    id: "google_lamp",
    label: "Bedroom lamp",
    type: "google",
    enabled: true,
  };
  const ctx = { studentId: STUDENT_ID };

  test("soft-fails with not_linked when the student has no grant", async () => {
    const provider = createGoogleTriggerProvider({
      homegraph: fakeHomeGraph(true),
      findLink: async () => null,
    });

    await expect(provider.execute(action, ctx)).resolves.toEqual({
      kind: "failed",
      reason: "not_linked",
    });
  });

  test("soft-fails with not_configured when Home Graph has no service account", async () => {
    const homegraph = fakeHomeGraph(false);
    const provider = createGoogleTriggerProvider({ homegraph, findLink: async () => grant });

    await expect(provider.execute(action, ctx)).resolves.toEqual({
      kind: "failed",
      reason: "not_configured",
    });
    expect(homegraph.calls).toHaveLength(0);
  });

  test("dormant beats unlinked, and never reads the credentials vault", async () => {
    // Pre-account state: no service account AND no grant. The reason must name
    // the deployment gap, and the vault must not even be consulted — this is
    // what `home-actions.test.ts` asserts through the registered seam.
    let lookups = 0;
    const provider = createGoogleTriggerProvider({
      homegraph: fakeHomeGraph(false),
      findLink: async () => {
        lookups += 1;
        return null;
      },
    });

    await expect(provider.execute(action, ctx)).resolves.toEqual({
      kind: "failed",
      reason: "not_configured",
    });
    expect(lookups).toBe(0);
  });

  test("fires the trigger as an awaited open→closed transition", async () => {
    const homegraph = fakeHomeGraph(true);
    const provider = createGoogleTriggerProvider({ homegraph, findLink: async () => grant });

    await expect(provider.execute(action, ctx)).resolves.toEqual({ kind: "triggered" });

    // BOTH reports happened, in order, within the single awaited invocation —
    // no setTimeout, which Lambda's post-response freeze would kill.
    expect(homegraph.calls).toHaveLength(2);
    expect(homegraph.calls[0]).toEqual({
      agentUserId: STUDENT_ID,
      states: { google_lamp: { online: true, openPercent: 100 } },
    });
    expect(homegraph.calls[1]).toEqual({
      agentUserId: STUDENT_ID,
      states: { google_lamp: { online: true, openPercent: 0 } },
    });
  });

  test("keys the report by the ACTION id (the virtual device id)", async () => {
    const homegraph = fakeHomeGraph(true);
    const provider = createGoogleTriggerProvider({ homegraph, findLink: async () => grant });

    await provider.execute({ ...action, id: "front_door_bell" }, ctx);
    expect(Object.keys(homegraph.calls[0].states)).toEqual(["front_door_bell"]);
  });

  test("reports the failing half when Home Graph rejects the open", async () => {
    const homegraph = fakeHomeGraph(true, { ok: false, reason: "auth_failed" });
    const provider = createGoogleTriggerProvider({ homegraph, findLink: async () => grant });

    await expect(provider.execute(action, ctx)).resolves.toEqual({
      kind: "failed",
      reason: "open_auth_failed",
    });
    // Never claims a trigger fired, and never leaves the close chasing it.
    expect(homegraph.calls).toHaveLength(1);
  });

  test("a failed rearm fails the press (the next press would have no edge)", async () => {
    let call = 0;
    const homegraph: HomeGraphClient = {
      isConfigured: () => true,
      reportState: async () => (++call === 1 ? { ok: true } : { ok: false, reason: "http_error" }),
      requestSyncForStudent: async () => ({ ok: true }),
    };
    const provider = createGoogleTriggerProvider({ homegraph, findLink: async () => grant });

    await expect(provider.execute(action, ctx)).resolves.toEqual({
      kind: "failed",
      reason: "close_http_error",
    });
  });

  test("a thrown error becomes a soft-fail, never an exception in the press path", async () => {
    const provider = createGoogleTriggerProvider({
      homegraph: fakeHomeGraph(true),
      findLink: async () => {
        throw new Error("vault exploded");
      },
    });

    await expect(provider.execute(action, ctx)).resolves.toEqual({
      kind: "failed",
      reason: "google_error",
    });
  });

  test("refuses a press with no student", async () => {
    const provider = createGoogleTriggerProvider({
      homegraph: fakeHomeGraph(true),
      findLink: async () => grant,
    });

    await expect(provider.execute(action, { studentId: "" })).resolves.toEqual({
      kind: "failed",
      reason: "no_student",
    });
  });
});

// ---------------------------------------------------------------------------
// The real Home Graph client, dormant
// ---------------------------------------------------------------------------

describe("homeGraphClient (no developer account yet)", () => {
  const ORIGINAL = process.env[HOMEGRAPH_SERVICE_ACCOUNT_ENV];

  beforeEach(() => {
    delete process.env[HOMEGRAPH_SERVICE_ACCOUNT_ENV];
    resetHomeGraphCachesForTesting();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[HOMEGRAPH_SERVICE_ACCOUNT_ENV];
    else process.env[HOMEGRAPH_SERVICE_ACCOUNT_ENV] = ORIGINAL;
    resetHomeGraphCachesForTesting();
  });

  test("is unconfigured when the service-account env var is unset", () => {
    expect(homeGraphClient.isConfigured()).toBe(false);
  });

  test("reportState soft-fails with not_configured — never throws, never fetches", async () => {
    await expect(
      homeGraphClient.reportState(STUDENT_ID, { google_lamp: { openPercent: 100 } }),
    ).resolves.toEqual({ ok: false, reason: "not_configured" });
  });

  test("requestSyncForStudent soft-fails with not_configured", async () => {
    await expect(homeGraphClient.requestSyncForStudent(STUDENT_ID)).resolves.toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  test("a malformed service account stays dormant instead of throwing", async () => {
    process.env[HOMEGRAPH_SERVICE_ACCOUNT_ENV] = "this is not json";
    resetHomeGraphCachesForTesting();

    expect(homeGraphClient.isConfigured()).toBe(false);
    await expect(homeGraphClient.reportState(STUDENT_ID, { a: {} })).resolves.toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  test("a service account missing private_key stays dormant", () => {
    process.env[HOMEGRAPH_SERVICE_ACCOUNT_ENV] = JSON.stringify({ client_email: "x@y.iam" });
    resetHomeGraphCachesForTesting();

    expect(homeGraphClient.isConfigured()).toBe(false);
  });

  test("an empty state map is a no-op success (nothing to push)", async () => {
    await expect(homeGraphClient.reportState(STUDENT_ID, {})).resolves.toEqual({ ok: true });
  });
});
