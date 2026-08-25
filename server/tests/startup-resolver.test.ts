/**
 * Tests for the app startup-parameter resolver.
 *
 * The resolver compiles a separate prompt and asks a fast model to fill an
 * app's AppStartupSpec.paramsSchema, then validates/clamps the output over the
 * spec's defaults. Contract: it NEVER throws and ALWAYS returns a complete
 * parameter set; the defaults fast-path is unbilled.
 *
 * We drive it through the provider test seam (setStructuredProvider). Note that
 * setting GEMINI_API_KEY here is about REACHABILITY, not safety: it decides
 * whether the resolver bothers to try, and nothing more. The header used to
 * claim that stubbing the key was what kept the suite off the network — that
 * was never true after the structured provider began defaulting to Vertex,
 * which needs a GCP project and not a key, and this file duly spent real money
 * on every run. What keeps the suite offline is that every test that reaches
 * the provider installs a fake first, plus the credential scrub in setup.ts.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import type { AppStartupSpec } from "../../shared/app-startup.js";
import { validateAndMergeParams } from "../../shared/app-startup.js";
import {
  resolveAppStartupParams,
  type StartupResolveContext,
} from "../services/dual-agent/startup-resolver.js";
import {
  setStructuredProvider,
  clearProviderOverrides,
} from "../services/providers/provider-factory.js";
import type { GPTResponse } from "../services/chat/gpt.js";

const SPEC: AppStartupSpec = {
  appId: "space_trader",
  guidance: "Pick a starting level appropriate to the student.",
  paramsSchema: {
    type: "object",
    properties: {
      startLevel: { type: "integer", minimum: 0, maximum: 6 },
    },
    required: ["startLevel"],
  },
  defaults: { startLevel: 0 },
};

function makeCtx(over: Partial<StartupResolveContext> = {}): StartupResolveContext {
  return {
    spec: SPEC,
    trigger: { source: "student" },
    studentDisplayName: "Noa",
    languageName: "English",
    ...over,
  };
}

/** Minimal fake structured provider returning a canned response. */
function fakeProvider(impl: () => Promise<GPTResponse>) {
  setStructuredProvider("gemini", { structuredComplete: impl } as any);
}

function gptResponse(content: string, tokens = { prompt: 100, completion: 10 }): GPTResponse {
  return {
    promptTokens: tokens.prompt,
    completionTokens: tokens.completion,
    cachedTokens: 0,
    content,
    output: [],
    toolCalls: [],
    refused: false,
  };
}

describe("validateAndMergeParams", () => {
  it("keeps valid values and clamps numbers to bounds", () => {
    const out = validateAndMergeParams(SPEC.paramsSchema, { startLevel: 99 }, SPEC.defaults);
    expect(out.startLevel).toBe(6);
  });

  it("falls back to defaults for wrong-typed values", () => {
    const out = validateAndMergeParams(SPEC.paramsSchema, { startLevel: "banana" }, SPEC.defaults);
    expect(out.startLevel).toBe(0);
  });

  it("strips unknown keys and fills missing ones from defaults", () => {
    const out = validateAndMergeParams(SPEC.paramsSchema, { bogus: 1 }, SPEC.defaults);
    expect(out).toEqual({ startLevel: 0 });
  });

  it("rejects enum values outside the allowed set", () => {
    const schema: AppStartupSpec["paramsSchema"] = {
      type: "object",
      properties: { difficulty: { type: "string", enum: ["gentle", "normal"] } },
    };
    const out = validateAndMergeParams(schema, { difficulty: "brutal" }, { difficulty: "gentle" });
    expect(out.difficulty).toBe("gentle");
  });
});

describe("resolveAppStartupParams", () => {
  const prevKey = process.env.GEMINI_API_KEY;
  const prevTimeout = process.env.AAC_STARTUP_RESOLVER_TIMEOUT_MS;
  // Reachability is key-OR-project now, so the unreachable case has to clear
  // the project too — and put it back, or every later test in this file runs
  // against a different environment than it thinks.
  const prevProject = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const prevProjectAlt = process.env.GOOGLE_CLOUD_PROJECT;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.AAC_STARTUP_RESOLVER_TIMEOUT_MS = "3500";
  });

  afterEach(() => {
    clearProviderOverrides();
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    if (prevTimeout === undefined) delete process.env.AAC_STARTUP_RESOLVER_TIMEOUT_MS;
    else process.env.AAC_STARTUP_RESOLVER_TIMEOUT_MS = prevTimeout;
    if (prevProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT_ID;
    else process.env.GOOGLE_CLOUD_PROJECT_ID = prevProject;
    if (prevProjectAlt === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = prevProjectAlt;
  });

  it("returns resolved params and bills on a successful call", async () => {
    fakeProvider(async () => gptResponse(JSON.stringify({ startLevel: 3 })));
    const trackUsage = jest.fn();
    const res = await resolveAppStartupParams(makeCtx({ trackUsage }));
    expect(res.params.startLevel).toBe(3);
    expect(res.usedDefaults).toBe(false);
    expect(res.resolverNote).toContain("startLevel=3");
    expect(trackUsage).toHaveBeenCalledTimes(1);
    expect(trackUsage).toHaveBeenCalledWith(100, 10, 0, expect.any(String));
  });

  it("clamps an out-of-range model value", async () => {
    fakeProvider(async () => gptResponse(JSON.stringify({ startLevel: 50 })));
    const res = await resolveAppStartupParams(makeCtx());
    expect(res.params.startLevel).toBe(6);
  });

  it("falls back to defaults (and does not bill) when Gemini is unreachable", async () => {
    // Unreachable now means no key AND no GCP project: the structured provider
    // prefers Vertex, so a Vertex-only deployment has no GEMINI_API_KEY and is
    // perfectly healthy. Clearing only the key would leave this passing
    // vacuously on any machine whose .env carries a project.
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_CLOUD_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    const trackUsage = jest.fn();
    let called = false;
    fakeProvider(async () => {
      called = true;
      return gptResponse("{}");
    });
    const res = await resolveAppStartupParams(makeCtx({ trackUsage }));
    expect(res.params).toEqual({ startLevel: 0 });
    expect(res.usedDefaults).toBe(true);
    expect(called).toBe(false);
    expect(trackUsage).not.toHaveBeenCalled();
  });

  it("falls back to defaults when the model output is malformed JSON", async () => {
    fakeProvider(async () => gptResponse("not json at all"));
    const res = await resolveAppStartupParams(makeCtx());
    expect(res.params).toEqual({ startLevel: 0 });
    expect(res.usedDefaults).toBe(true);
  });

  it("falls back to defaults on timeout without throwing", async () => {
    process.env.AAC_STARTUP_RESOLVER_TIMEOUT_MS = "20";
    fakeProvider(
      () => new Promise((resolve) => setTimeout(() => resolve(gptResponse(JSON.stringify({ startLevel: 5 }))), 200)),
    );
    const res = await resolveAppStartupParams(makeCtx());
    expect(res.params).toEqual({ startLevel: 0 });
    expect(res.usedDefaults).toBe(true);
  });

  it("returns defaults immediately when the resolver is disabled (timeout 0)", async () => {
    // "Disabled" has to mean the call is never SENT, not merely never awaited.
    // It used to mean the latter: the request was built as an argument to
    // withTimeout, so it went out before the ms<=0 guard could decline it, and
    // a timeout of 0 billed a full Gemini call per app open while returning
    // defaults. The `called` assertion below is the whole point of this test —
    // without it every other expectation here passes just as happily on the
    // broken version.
    process.env.AAC_STARTUP_RESOLVER_TIMEOUT_MS = "0";
    const trackUsage = jest.fn();
    let called = false;
    fakeProvider(async () => {
      called = true;
      return gptResponse(JSON.stringify({ startLevel: 5 }));
    });
    const res = await resolveAppStartupParams(makeCtx({ trackUsage }));
    expect(res.params).toEqual({ startLevel: 0 });
    expect(res.usedDefaults).toBe(true);
    expect(called).toBe(false);
    expect(trackUsage).not.toHaveBeenCalled();
  });
});
