/**
 * Face-photo analyzer: verdict handling and failure modes.
 *
 * The regression these lock down: gemini-2.5-flash deliberates by default and
 * spends THOUGHT tokens out of maxOutputTokens, so under the old 512-token cap
 * a long think left too little budget for the answer and the JSON arrived
 * chopped mid-key ('{"isFace":true,"estimatedAge'). That surfaced to the
 * clinician as an opaque 500 on a perfectly good photo.
 *
 * Two things must hold: the call must not leave thinking enabled, and a
 * truncated reply must never be mistaken for a verdict about the image.
 */

import { describe, it, expect, jest, beforeAll, beforeEach } from "@jest/globals";

const generateContentMock = jest.fn<any>();

jest.unstable_mockModule("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
  // The module builds its response schema from this at import time.
  Type: { OBJECT: "OBJECT", STRING: "STRING", BOOLEAN: "BOOLEAN" },
}));

// Both of these write to the DB; this suite is DB-free by design.
jest.unstable_mockModule("../services/apiTracker.js", () => ({
  apiTracker: { trackGeminiCall: (fn: () => Promise<unknown>) => fn() },
}));
jest.unstable_mockModule("../services/credit-ledger.js", () => ({
  chargeModelUsage: jest.fn<any>().mockResolvedValue(undefined),
}));

let analyzeFacePhoto: typeof import("../services/biometric/photo-analyzer.js").analyzeFacePhoto;
let NoFaceDetectedError: typeof import("../services/biometric/photo-analyzer.js").NoFaceDetectedError;
let PhotoAnalysisUnavailableError: typeof import("../services/biometric/photo-analyzer.js").PhotoAnalysisUnavailableError;

beforeAll(async () => {
  ({ analyzeFacePhoto, NoFaceDetectedError, PhotoAnalysisUnavailableError } = await import(
    "../services/biometric/photo-analyzer.js"
  ));
});

const IMAGE = Buffer.from("not-really-a-jpeg");

/** Shape a generateContent reply the way the SDK returns it. */
function reply(text: string, finishReason = "STOP") {
  return {
    text,
    candidates: [{ finishReason, content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 60 },
  };
}

describe("analyzeFacePhoto", () => {
  beforeEach(() => generateContentMock.mockReset());

  it("does not spend the output budget on deliberation", async () => {
    generateContentMock.mockResolvedValue(reply(JSON.stringify({ isFace: true })));
    await analyzeFacePhoto(IMAGE);

    const { config } = generateContentMock.mock.calls[0][0] as any;
    expect(config.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(config.maxOutputTokens).toBeGreaterThanOrEqual(1024);
  });

  it("returns the descriptors when the model confirms a face", async () => {
    generateContentMock.mockResolvedValue(
      reply(
        JSON.stringify({
          isFace: true,
          hairColor: "dark brown",
          eyeColor: "brown",
          estimatedAge: "30s",
          estimatedSex: "male",
          identifyingFeatures: "glasses, beard",
          physicalDescription: "Adult male in his 30s.",
        }),
      ),
    );

    const result = await analyzeFacePhoto(IMAGE);
    expect(result.isFace).toBe(true);
    expect(result.hairColor).toBe("dark brown");
    expect(result.identifyingFeatures).toBe("glasses, beard");
  });

  it("normalizes empty descriptor strings away so they can't blank existing data", async () => {
    generateContentMock.mockResolvedValue(
      reply(JSON.stringify({ isFace: true, hairColor: "", eyeColor: null, estimatedAge: "child" })),
    );

    const result = await analyzeFacePhoto(IMAGE);
    expect(result.hairColor).toBeUndefined();
    expect(result.eyeColor).toBeUndefined();
    expect(result.estimatedAge).toBe("child");
  });

  it("rejects a non-face image with the reason the model gave", async () => {
    generateContentMock.mockResolvedValue(
      reply(JSON.stringify({ isFace: false, noFaceReason: "two people in frame" })),
    );

    await expect(analyzeFacePhoto(IMAGE)).rejects.toThrow(NoFaceDetectedError);
    await expect(analyzeFacePhoto(IMAGE)).rejects.toThrow(/two people in frame/);
  });

  it("reports a truncated reply as unavailable, NOT as a bad photo", async () => {
    // The exact payload from the production failure.
    generateContentMock.mockResolvedValue(reply('{"isFace":true,"estimatedAge', "MAX_TOKENS"));

    const err = await analyzeFacePhoto(IMAGE).catch((e) => e);
    expect(err).toBeInstanceOf(PhotoAnalysisUnavailableError);
    expect(err).not.toBeInstanceOf(NoFaceDetectedError);
    expect(err.code).toBe("ANALYSIS_UNAVAILABLE");
    expect(err.message).toMatch(/cut off at the output limit/);
  });

  it("does not read a verdict out of a parseable reply that has none", async () => {
    // Valid JSON, but the isFace field never arrived — treating a missing
    // verdict as `false` would blame the clinician's photo for our failure.
    generateContentMock.mockResolvedValue(reply(JSON.stringify({ estimatedAge: "30s" }), "MAX_TOKENS"));

    const err = await analyzeFacePhoto(IMAGE).catch((e) => e);
    expect(err).toBeInstanceOf(PhotoAnalysisUnavailableError);
    expect(err.message).toMatch(/no isFace verdict/);
  });

  it("reports an empty reply as unavailable", async () => {
    generateContentMock.mockResolvedValue({ candidates: [{ finishReason: "SAFETY" }] });

    const err = await analyzeFacePhoto(IMAGE).catch((e) => e);
    expect(err).toBeInstanceOf(PhotoAnalysisUnavailableError);
    expect(err.message).toMatch(/SAFETY/);
  });
});
