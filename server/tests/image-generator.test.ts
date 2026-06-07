/**
 * image-generator empty-result handling.
 *
 * Gemini's image model sometimes replies with TEXT only (a preamble like
 * "Sure, here's the form:") and no inline image. The old code returned that text
 * as if it were a success, which made the agent retry endlessly — the hila
 * runaway loop (24 generateImage calls in one turn). The fix surfaces an explicit
 * `error` when no image is produced so the model treats it as a failure.
 */

import { describe, it, expect, jest, beforeAll, beforeEach } from "@jest/globals";

const generateContentMock = jest.fn<any>();

// ESM module mock — must be registered before the dynamic import below.
jest.unstable_mockModule("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));

let generateImage: typeof import("../services/chat/tools/image-generator.js").generateImage;

beforeAll(async () => {
  ({ generateImage } = await import("../services/chat/tools/image-generator.js"));
});

const USAGE = { promptTokenCount: 10, candidatesTokenCount: 5 };

describe("generateImage empty-result handling", () => {
  beforeEach(() => generateContentMock.mockReset());

  it("returns generatedImageFileIds and no error on success", async () => {
    generateContentMock.mockResolvedValue({
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("img").toString("base64") } }] } },
      ],
      usageMetadata: USAGE,
    });

    const r = await generateImage({ instruction: "draw a cat" });

    expect(r.error).toBeUndefined();
    expect(r.generatedImageFileIds).toBeDefined();
    expect(r.generatedImageFileIds!.length).toBe(1);
  });

  it("returns an explicit error (not silent success) when only text comes back", async () => {
    generateContentMock.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: "Sure, here's the form:" }] } }],
      usageMetadata: USAGE,
    });

    const r = await generateImage({ instruction: "make an assessment form" });

    expect(r.generatedImageFileIds).toBeUndefined();
    expect(r.error).toBeDefined();
    expect(r.error).toMatch(/no image/i);
    // The model-facing text should not read like a success.
    expect(r.error).toMatch(/do not retry/i);
  });

  it("returns an error when the response has no candidates at all", async () => {
    generateContentMock.mockResolvedValue({ candidates: [], usageMetadata: USAGE });

    const r = await generateImage({ instruction: "anything" });

    expect(r.generatedImageFileIds).toBeUndefined();
    expect(r.error).toBeDefined();
  });
});
