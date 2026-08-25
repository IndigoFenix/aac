/**
 * Which billing path the STRUCTURED Gemini provider talks to.
 *
 * This closes the second half of the 2026-08-20 split. That incident was the
 * chat provider: the Live agents ran on the paid Vertex project while the Board
 * Manager quietly ran on the free AI Studio key, and the day the key hit its
 * daily cap every board rebuild returned RESOURCE_EXHAUSTED while the Speaker
 * kept talking. The structured provider was never fixed at the time and stayed
 * on the key — carrying the Monitor, the session summariser, the caption
 * services, both startup resolvers and all three menu-extraction passes with it.
 *
 * 🚨 Vertex is the DEFAULT here, not an opt-in argument as it is on the chat
 * provider. The chat provider's callers all have session context to thread a
 * flag through; these callers are mostly free functions with none, so an opt-in
 * flag would be forgotten the same way it was forgotten before — and silently,
 * because the free key works right up until it does not.
 */

import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from "@jest/globals";

const constructed: Array<Record<string, any>> = [];
const generateContent = jest.fn(async (_req: any) => ({
  candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
}));

jest.unstable_mockModule("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
    constructor(opts: Record<string, any>) {
      constructed.push(opts);
    }
  },
}));

let GeminiStructuredProvider: typeof import("../services/providers/gemini-structured").GeminiStructuredProvider;

const ENV_KEYS = ["GOOGLE_CLOUD_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GEMINI_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  ({ GeminiStructuredProvider } = await import("../services/providers/gemini-structured"));
});

beforeEach(() => {
  constructed.length = 0;
  generateContent.mockClear();
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

function request(model = "gemini-2.5-flash") {
  return { model, input: [{ type: "message", role: "user", content: "hi" }], maxTokens: 16 } as any;
}

describe("with a GCP project configured", () => {
  beforeEach(() => {
    process.env.GOOGLE_CLOUD_PROJECT_ID = "aivota-prod";
    process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
  });

  test("constructs a Vertex client, not an API-key one", () => {
    const provider = new GeminiStructuredProvider();
    expect(provider.usingVertex).toBe(true);
    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toMatchObject({
      vertexai: true,
      project: "aivota-prod",
      location: "us-central1",
    });
    expect(constructed[0].apiKey).toBeUndefined();
  });

  test("works with NO api key at all", async () => {
    // The whole point: a Vertex-only deployment has no GEMINI_API_KEY, and
    // nothing here may treat that as "Gemini is unavailable".
    const provider = new GeminiStructuredProvider();
    await provider.structuredComplete(request());
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(constructed.every((c) => !c.apiKey)).toBe(true);
  });

  test("a model NOT published on Vertex falls back to the key", async () => {
    // Unreachable today (the only such Gemini model is live-only and cannot do
    // structured output) but the registry flag exists because the list moves,
    // and the alternative is an opaque Vertex 404.
    process.env.GEMINI_API_KEY = "studio-key";
    const provider = new GeminiStructuredProvider();
    await provider.structuredComplete(request("gemini-3.1-flash-live-preview"));
    expect(constructed.some((c) => c.apiKey === "studio-key")).toBe(true);
  });

  test("an unknown model is assumed to be on Vertex", async () => {
    // Absent a registry entry, prefer the paid project: guessing "not on
    // Vertex" would route new models onto the free key, which is the drift
    // this file exists to prevent.
    process.env.GEMINI_API_KEY = "studio-key";
    const provider = new GeminiStructuredProvider();
    await provider.structuredComplete(request("gemini-9.9-experimental"));
    expect(constructed).toHaveLength(1);
    expect(constructed[0].vertexai).toBe(true);
  });
});

describe("background traffic", () => {
  beforeEach(() => {
    process.env.GOOGLE_CLOUD_PROJECT_ID = "aivota-prod";
  });

  test("marks background work as `shared` so it cannot eat reserved capacity", async () => {
    // Provisioned Throughput exists for the live path — a child pressing a
    // button and waiting for a board. A session summary or a menu extraction
    // must never consume it.
    const provider = new GeminiStructuredProvider();
    await provider.structuredComplete({ ...request(), background: true } as any);
    const config = generateContent.mock.calls[0][0].config;
    expect(config.httpOptions.headers["X-Vertex-AI-LLM-Request-Type"]).toBe("shared");
  });

  test("foreground work sends NO routing header", async () => {
    const provider = new GeminiStructuredProvider();
    await provider.structuredComplete(request());
    const config = generateContent.mock.calls[0][0].config;
    expect(config.httpOptions?.headers?.["X-Vertex-AI-LLM-Request-Type"]).toBeUndefined();
  });

  test("the header is Vertex-only — the API-key path sends nothing", async () => {
    // Harmless either way, but sending a Vertex routing header to AI Studio
    // would be a lie about which system is being addressed.
    delete process.env.GOOGLE_CLOUD_PROJECT_ID;
    process.env.GEMINI_API_KEY = "studio-key";
    const provider = new GeminiStructuredProvider();
    await provider.structuredComplete({ ...request(), background: true } as any);
    const config = generateContent.mock.calls[0][0].config;
    expect(config.httpOptions?.headers?.["X-Vertex-AI-LLM-Request-Type"]).toBeUndefined();
  });
});

describe("with no GCP project", () => {
  test("falls back to the API key", async () => {
    process.env.GEMINI_API_KEY = "studio-key";
    const provider = new GeminiStructuredProvider();
    expect(provider.usingVertex).toBe(false);
    await provider.structuredComplete(request());
    expect(constructed.some((c) => c.apiKey === "studio-key")).toBe(true);
    expect(constructed.every((c) => !c.vertexai)).toBe(true);
  });
});
