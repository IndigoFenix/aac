/**
 * Per-turn generateImage budget.
 *
 * The registry is built once per turn, so generateImage calls are capped per
 * turn. This stops runaway image loops (the hila session fired 24 in one turn,
 * many of which DID produce images — so an empty-result guard alone isn't
 * enough; the hard per-turn cap is what bounds cost and tool rounds).
 */

import { describe, it, expect, jest, beforeAll, beforeEach } from "@jest/globals";

const generateContentMock = jest.fn<any>();

jest.unstable_mockModule("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));

let defaultToolRegistry: typeof import("../services/chat/tool-router.js").defaultToolRegistry;

beforeAll(async () => {
  ({ defaultToolRegistry } = await import("../services/chat/tool-router.js"));
});

function buildRegistry() {
  return defaultToolRegistry({
    agent: { memoryFields: [] } as any,
    openedTopics: [],
    memoryValuesRef: { current: {} },
    chatStateRef: { current: { history: [], memoryState: { visible: [], page: {} } } as any },
  });
}

describe("generateImage per-turn budget", () => {
  beforeEach(() => {
    generateContentMock.mockReset();
    // Every underlying call "succeeds" with an image.
    generateContentMock.mockResolvedValue({
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("img").toString("base64") } }] } },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    });
  });

  it("allows up to the cap, then refuses without calling the image API again", async () => {
    const registry = buildRegistry();
    const CAP = 6;

    // First CAP calls go through and produce images.
    for (let i = 0; i < CAP; i++) {
      const r = await registry.generateImage({ instruction: `image ${i}` });
      expect(r.error).toBeUndefined();
      expect(r.generatedImageFileIds?.length).toBe(1);
    }

    // The next call is refused with a budget error — and does NOT hit the API.
    const over = await registry.generateImage({ instruction: "one too many" });
    expect(over.error).toMatch(/limit reached/i);
    expect(over.generatedImageFileIds).toBeUndefined();

    // Underlying image API was invoked exactly CAP times.
    expect(generateContentMock).toHaveBeenCalledTimes(CAP);
  });

  it("uses an independent budget per registry (i.e. per turn)", async () => {
    const r1 = buildRegistry();
    for (let i = 0; i < 6; i++) await r1.generateImage({ instruction: `a${i}` });
    expect((await r1.generateImage({ instruction: "over" })).error).toMatch(/limit reached/i);

    // A fresh registry (next turn) starts with a clean budget.
    const r2 = buildRegistry();
    const r = await r2.generateImage({ instruction: "fresh turn" });
    expect(r.error).toBeUndefined();
    expect(r.generatedImageFileIds?.length).toBe(1);
  });
});
