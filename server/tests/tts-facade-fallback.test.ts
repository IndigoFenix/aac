/**
 * TTS facade fallback chain — pins the "a press must never be silent" rules
 * added after the 2026-08 student-voice silence investigation:
 *
 *  - Stored ElevenLabs keys in the retired pre-"sk_" format are dropped by
 *    `sanitizeElevenLabsApiKey`, so the facade never wastes a round trip on a
 *    key the API is guaranteed to reject, and `isClientSideTtsVoice` refuses
 *    to hand such a key to the client (the client has no fallback provider —
 *    a dead key there means dead silence, which is exactly the bug).
 *  - A provider that fails BEFORE yielding audio falls through to the next
 *    provider (ElevenLabs → admin voice → Gemini Live → Google).
 *  - A provider that fails AFTER yielding audio must NOT fall through:
 *    the listener already heard the start of the sentence, and the next
 *    provider would replay it from the top.
 *
 * DB-free (test:unit): both provider services are mocked at the module seam.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

const elSynthesize = jest.fn<(text: string, opts: any) => Promise<Buffer>>();
// Generator-shaped mock: swapped per-test via elStreamImpl.
let elStreamImpl: (text: string, opts: any) => AsyncGenerator<Buffer>;
jest.unstable_mockModule("../services/voice/elevenlabs-tts-service", () => ({
  elevenlabsTtsService: {
    synthesize: elSynthesize,
    synthesizeStream: (text: string, opts: any) => elStreamImpl(text, opts),
  },
}));

const googleSynthesize = jest.fn<(text: string, lang: string, opts: any) => Promise<Buffer>>();
let googleStreamImpl: (text: string, lang: string, opts: any) => AsyncGenerator<Buffer>;
jest.unstable_mockModule("../services/voice/google-tts-service", () => ({
  googleTtsService: {
    synthesize: googleSynthesize,
    synthesizeStream: (text: string, lang: string, opts: any) => googleStreamImpl(text, lang, opts),
  },
}));

const facade = await import("../services/voice/tts-facade");
const { sanitizeElevenLabsApiKey, isClientSideTtsVoice, synthesizeStream, synthesize } = facade;
type ResolvedVoice = import("../services/voice/tts-facade").ResolvedVoice;

const GOOGLE_CHUNK = Buffer.from("google-audio");
const EL_CHUNK = Buffer.from("elevenlabs-audio");

function baseVoice(overrides: Partial<ResolvedVoice> = {}): ResolvedVoice {
  return {
    fallbackType: "boy",
    customVoice: null,
    language: "he",
    ...overrides,
  };
}

async function collect(gen: AsyncGenerator<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

const { setDisclosureSink } = await import("../services/processorDisclosure.js");

// These suites drive the REAL egress code, which now writes an AKIM §18.5
// disclosure row per send. With no sink installed the default one lazily
// imports activityLogService → server/db.ts, dragging a Postgres pool into a
// DB-free suite; and with no student context attached every call prints the
// PROCESSOR_DISCLOSURE_CONTEXT_MISSING marker. That marker is a CloudWatch
// alarm in production — routine test noise would teach people to ignore it.
// Neither is this suite's subject, so the rows go nowhere.
beforeEach(() => setDisclosureSink(() => {}));
afterEach(() => setDisclosureSink(null));

beforeEach(() => {
  jest.clearAllMocks();
  // Default: both providers succeed with one chunk.
  elStreamImpl = async function* () {
    yield EL_CHUNK;
  };
  googleStreamImpl = async function* () {
    yield GOOGLE_CHUNK;
  };
  elSynthesize.mockResolvedValue(EL_CHUNK);
  googleSynthesize.mockResolvedValue(GOOGLE_CHUNK);
});

describe("sanitizeElevenLabsApiKey", () => {
  it("passes through current-format keys", () => {
    expect(sanitizeElevenLabsApiKey("sk_abc123")).toBe("sk_abc123");
  });

  it("drops retired pre-sk_ keys", () => {
    expect(sanitizeElevenLabsApiKey("0123456789abcdef0123456789abcdef")).toBeUndefined();
  });

  it("drops empty / missing keys", () => {
    expect(sanitizeElevenLabsApiKey("")).toBeUndefined();
    expect(sanitizeElevenLabsApiKey(null)).toBeUndefined();
    expect(sanitizeElevenLabsApiKey(undefined)).toBeUndefined();
  });
});

describe("isClientSideTtsVoice", () => {
  it("true only for a usable student key + voice id", () => {
    expect(isClientSideTtsVoice(baseVoice({ elevenlabsApiKey: "sk_ok", elevenlabsVoiceId: "v1" }))).toBe(true);
  });

  it("false when the stored key is the retired format (client has no fallback)", () => {
    expect(isClientSideTtsVoice(baseVoice({ elevenlabsApiKey: "legacyhexkey", elevenlabsVoiceId: "v1" }))).toBe(false);
  });

  it("false when either half is missing", () => {
    expect(isClientSideTtsVoice(baseVoice({ elevenlabsApiKey: "sk_ok" }))).toBe(false);
    expect(isClientSideTtsVoice(baseVoice({ elevenlabsVoiceId: "v1" }))).toBe(false);
  });
});

describe("synthesizeStream fallback chain", () => {
  it("skips ElevenLabs entirely for a retired-format key and speaks via Google", async () => {
    const elCalls: string[] = [];
    elStreamImpl = async function* (text) {
      elCalls.push(text);
      yield EL_CHUNK;
    };
    const usage: any[] = [];
    const chunks = await collect(
      synthesizeStream("שלום", baseVoice({ elevenlabsApiKey: "legacyhexkey", elevenlabsVoiceId: "v1" }), undefined, (u) => usage.push(u)),
    );
    expect(elCalls).toHaveLength(0);
    expect(chunks).toEqual([GOOGLE_CHUNK]);
    expect(usage).toEqual([{ provider: "google", characters: 4 }]);
  });

  it("falls through to Google when ElevenLabs fails before yielding", async () => {
    elStreamImpl = async function* () {
      throw new Error("401 invalid key");
      yield EL_CHUNK; // eslint-disable-line no-unreachable
    };
    const usage: any[] = [];
    const chunks = await collect(
      synthesizeStream("hi", baseVoice({ elevenlabsApiKey: "sk_dead", elevenlabsVoiceId: "v1" }), undefined, (u) => usage.push(u)),
    );
    expect(chunks).toEqual([GOOGLE_CHUNK]);
    expect(usage).toEqual([{ provider: "google", characters: 2 }]);
  });

  it("bills ElevenLabs when the student voice succeeds", async () => {
    const usage: any[] = [];
    const chunks = await collect(
      synthesizeStream("hi", baseVoice({ elevenlabsApiKey: "sk_ok", elevenlabsVoiceId: "v1" }), undefined, (u) => usage.push(u)),
    );
    expect(chunks).toEqual([EL_CHUNK]);
    expect(usage).toEqual([{ provider: "elevenlabs", characters: 2 }]);
  });

  it("does NOT replay via the next provider after a mid-stream failure", async () => {
    // Gemini Live is the realistic mid-stream case (true chunked streaming).
    const geminiLiveSession = {
      synthesizeStream: async function* () {
        yield Buffer.from("first-half");
        throw new Error("socket dropped");
      },
    } as any;
    const googleCalls: string[] = [];
    googleStreamImpl = async function* (text) {
      googleCalls.push(text);
      yield GOOGLE_CHUNK;
    };
    const usage: any[] = [];
    const chunks = await collect(
      synthesizeStream("a sentence", baseVoice({ geminiLiveSession }), undefined, (u) => usage.push(u)),
    );
    expect(chunks).toEqual([Buffer.from("first-half")]);
    expect(googleCalls).toHaveLength(0); // no replay from the top
    expect(usage).toEqual([]); // partial audio is not billed
  });

  it("propagates the error when every provider fails before audio (caller falls back to local TTS)", async () => {
    elStreamImpl = async function* () {
      throw new Error("el down");
      yield EL_CHUNK; // eslint-disable-line no-unreachable
    };
    googleStreamImpl = async function* () {
      throw new Error("google down");
      yield GOOGLE_CHUNK; // eslint-disable-line no-unreachable
    };
    await expect(
      collect(synthesizeStream("hi", baseVoice({ elevenlabsApiKey: "sk_ok", elevenlabsVoiceId: "v1" }))),
    ).rejects.toThrow("google down");
  });
});

describe("synthesize (buffered) key sanitation", () => {
  it("routes a retired-format key straight to Google", async () => {
    const usage: any[] = [];
    const buf = await synthesize("hello", baseVoice({ elevenlabsApiKey: "legacyhexkey", elevenlabsVoiceId: "v1" }), (u) => usage.push(u));
    expect(elSynthesize).not.toHaveBeenCalled();
    expect(buf).toEqual(GOOGLE_CHUNK);
    expect(usage).toEqual([{ provider: "google", characters: 5 }]);
  });
});
