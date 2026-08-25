/**
 * The AI-open decision (`decideAiOpen`).
 *
 * A second, single-purpose model asked one question — "is opening this app what
 * the child actually wants?" — before an open the ASSISTANT chose goes ahead.
 *
 * It exists because prompt text did not hold. Twice, live, the Speaker read a
 * tool description telling it exactly not to do the thing and did it anyway:
 * `picture_search("pizza")` for a child asking for lunch, then
 * `open_app("restaurant", "pizza")` for the same child in his own bedroom. A
 * model reaching for the tool that matches the noun is not fixed by another
 * paragraph in the prompt it already ignored.
 *
 * 🚨 THE MOST IMPORTANT PROPERTY HERE IS THAT IT FAILS OPEN. A blocked open is
 * a child asking for something and getting nothing, and they cannot rephrase.
 * Every failure path — no key, timeout, throw, malformed answer, a model that
 * answered a different question — must allow the open. Only an explicit
 * `open: false` refuses.
 */

import { describe, test, expect, jest, beforeAll, beforeEach, afterAll } from "@jest/globals";

const getStructuredResponse = jest.fn(async (..._a: any[]) => ({
  content: JSON.stringify({ open: true }),
  promptTokens: 100,
  completionTokens: 5,
  cachedTokens: 0,
}) as any);

jest.unstable_mockModule("../services/chat/gpt", () => ({
  GPT: class {
    getStructuredResponse = getStructuredResponse;
  },
}));

let decideAiOpen: typeof import("../services/dual-agent/startup-resolver").decideAiOpen;
/** "Gemini is unreachable" now means NO key AND NO GCP project — the structured
 *  provider prefers Vertex, so a Vertex-only deployment has no key and is
 *  perfectly healthy. Clearing only the key would test nothing on a dev machine
 *  whose .env carries a project. */
const VERTEX_KEYS = ["GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT_ID", "GOOGLE_CLOUD_PROJECT"] as const;
const savedEnv: Record<string, string | undefined> = {};
function makeUnreachable() {
  for (const k of VERTEX_KEYS) delete process.env[k];
}

beforeAll(async () => {
  for (const k of VERTEX_KEYS) savedEnv[k] = process.env[k];
  process.env.GEMINI_API_KEY = "test-key";
  ({ decideAiOpen } = await import("../services/dual-agent/startup-resolver"));
});

afterAll(() => {
  for (const k of VERTEX_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
});

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    appId: "restaurant",
    appName: "Restaurant",
    policy: { guidance: "Wanting food is not wanting a restaurant." },
    trigger: { source: "ai" as const, data: "pizza" },
    studentDisplayName: "Daniel",
    recentTurns: [{ role: "user" as const, content: "פיצה" }],
    ...overrides,
  } as any;
}

beforeEach(() => {
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.GOOGLE_CLOUD_PROJECT_ID;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  getStructuredResponse.mockReset().mockResolvedValue({
    content: JSON.stringify({ open: true }),
    promptTokens: 100,
    completionTokens: 5,
    cachedTokens: 0,
  });
});

describe("refusing", () => {
  test("an explicit false blocks the open and carries the reason", async () => {
    getStructuredResponse.mockResolvedValue({
      content: JSON.stringify({ open: false, reason: "He is at home asking for pizza to eat." }),
      promptTokens: 100,
      completionTokens: 8,
      cachedTokens: 0,
    });
    const decision = await decideAiOpen(ctx());
    expect(decision.open).toBe(false);
    expect(decision.reason).toBe("He is at home asking for pizza to eat.");
  });

  test("a refusal with no reason still refuses", async () => {
    getStructuredResponse.mockResolvedValue({
      content: JSON.stringify({ open: false }),
      promptTokens: 100,
      completionTokens: 3,
      cachedTokens: 0,
    });
    expect((await decideAiOpen(ctx())).open).toBe(false);
  });
});

describe("failing open", () => {
  test("no way to reach Gemini allows the open without calling anything", async () => {
    makeUnreachable();
    const decision = await decideAiOpen(ctx());
    expect(decision.open).toBe(true);
    expect(decision.failedOpen).toBe(true);
    expect(getStructuredResponse).not.toHaveBeenCalled();
  });

  test("a thrown provider error allows the open", async () => {
    getStructuredResponse.mockRejectedValue(new Error("resolver-timeout"));
    const decision = await decideAiOpen(ctx());
    expect(decision.open).toBe(true);
    expect(decision.failedOpen).toBe(true);
  });

  test("unparseable output allows the open", async () => {
    getStructuredResponse.mockResolvedValue({
      content: "I think you should not open this",
      promptTokens: 100,
      completionTokens: 9,
      cachedTokens: 0,
    });
    expect((await decideAiOpen(ctx())).open).toBe(true);
  });

  test("a missing `open` field is NOT a refusal", async () => {
    // A model that answered the wrong question must not silently start
    // blocking every app open.
    getStructuredResponse.mockResolvedValue({
      content: JSON.stringify({ reason: "unsure" }),
      promptTokens: 100,
      completionTokens: 4,
      cachedTokens: 0,
    });
    expect((await decideAiOpen(ctx())).open).toBe(true);
  });

  test("a STRING \"false\" is not a refusal either", async () => {
    // Only the boolean blocks. Coercing here would make a stray string into a
    // silent block, which is the failure this whole file is built to avoid.
    getStructuredResponse.mockResolvedValue({
      content: JSON.stringify({ open: "false" }),
      promptTokens: 100,
      completionTokens: 4,
      cachedTokens: 0,
    });
    expect((await decideAiOpen(ctx())).open).toBe(true);
  });
});

describe("the off switch", () => {
  test("a timeout of 0 does not CALL the model, it only declines to wait", async () => {
    // The sibling of the `resolveAppStartupParams` pin in
    // startup-resolver.test.ts, and it belongs here too because the bug lived
    // at BOTH call sites. `withTimeout` used to receive the already-issued
    // promise, so `AAC_STARTUP_RESOLVER_TIMEOUT_MS=0` billed a full Gemini call
    // for every AI-initiated app open and then threw the answer away — the
    // documented way to switch the decision off cost exactly what leaving it on
    // cost. Every other assertion in this file passes on the broken version;
    // only `not.toHaveBeenCalled` catches it.
    const prev = process.env.AAC_STARTUP_RESOLVER_TIMEOUT_MS;
    process.env.AAC_STARTUP_RESOLVER_TIMEOUT_MS = "0";
    try {
      const decision = await decideAiOpen(ctx());
      expect(getStructuredResponse).not.toHaveBeenCalled();
      // And a disabled decision must still ALLOW — see the header.
      expect(decision.open).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AAC_STARTUP_RESOLVER_TIMEOUT_MS;
      else process.env.AAC_STARTUP_RESOLVER_TIMEOUT_MS = prev;
    }
  });
});

describe("reachability", () => {
  test("a GCP project with NO api key is reachable", async () => {
    // The Vertex-only deployment. Treating this as unavailable would silently
    // disable the decision in production while it kept working locally.
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_CLOUD_PROJECT_ID = "aivota-prod";
    getStructuredResponse.mockResolvedValue({
      content: JSON.stringify({ open: false, reason: "at home" }),
      promptTokens: 10,
      completionTokens: 2,
      cachedTokens: 0,
    });
    expect((await decideAiOpen(ctx())).open).toBe(false);
    expect(getStructuredResponse).toHaveBeenCalled();
  });
});

describe("what the decision model is given", () => {
  test("the app's own policy guidance, and the app name", async () => {
    await decideAiOpen(ctx());
    const instructions = getStructuredResponse.mock.calls[0][9] as string;
    expect(instructions).toContain("Wanting food is not wanting a restaurant.");
    expect(instructions).toContain("Restaurant");
  });

  test("told to allow when it is a close call", async () => {
    // The asymmetry is deliberate and belongs in the prompt as well as the
    // code: a wrong app costs one press to leave; a child who asked for
    // something and got nothing cannot ask again a different way.
    await decideAiOpen(ctx());
    const instructions = getStructuredResponse.mock.calls[0][9] as string;
    expect(instructions).toContain("close call, allow it");
  });

  test("the conversation and the AI's hint, so it can see what was said", async () => {
    await decideAiOpen(ctx());
    const message = (getStructuredResponse.mock.calls[0][0] as any[])[0].content as string;
    expect(message).toContain("פיצה");
    expect(message).toContain("pizza");
  });

  test("the real model call is billed", async () => {
    const trackUsage = jest.fn();
    await decideAiOpen(ctx({ trackUsage }));
    expect(trackUsage).toHaveBeenCalledWith(100, 5, 0, expect.any(String));
  });

  test("the unreachable fast-path is NOT billed", async () => {
    makeUnreachable();
    const trackUsage = jest.fn();
    await decideAiOpen(ctx({ trackUsage }));
    expect(trackUsage).not.toHaveBeenCalled();
  });
});
