/**
 * Voice record controller tests.
 *
 * Focus: the ElevenLabs voice-listing endpoint must NOT relay an upstream 401
 * (bad ElevenLabs API key) to the browser as a 401. The client's global auth
 * handler treats any 401 as "session expired" and bounces the user to the login
 * page — so an invalid third-party key would kick a fully-authenticated user
 * out of the AAC settings screen. The endpoint maps it to 400 instead.
 */

import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { makeReq, makeRes } from "../helpers/http.js";
import { voiceRecordController } from "../../controllers/voiceRecordController.js";

const realFetch = globalThis.fetch;

function stubFetch(impl: () => Promise<Partial<Response>>) {
  globalThis.fetch = (async () => impl()) as unknown as typeof fetch;
}

describe("Voice record controller — listElevenlabsVoices", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it("maps an upstream 401 (bad ElevenLabs key) to 400, NOT 401", async () => {
    stubFetch(async () => ({ ok: false, status: 401 }));

    const req = makeReq({ body: { apiKey: "bad-key" } });
    const { res, capture } = makeRes();
    await voiceRecordController.listElevenlabsVoices(req, res);

    // The critical assertion: a third-party key rejection must never surface as
    // a 401, or the client logs the user out.
    expect(capture.statusCode).toBe(400);
    expect((capture.jsonBody as any).success).toBe(false);
    expect((capture.jsonBody as any).message).toMatch(/Invalid ElevenLabs API key/i);
    expect((capture.jsonBody as any).code).toBe("invalid_api_key");
  });

  it("passes through ElevenLabs' machine code for a pasted key ID", async () => {
    // The dashboard reveals the "sk_" secret only once, at creation; re-copying
    // an existing key yields its 64-hex ID, which ElevenLabs rejects with this
    // code. The client uses it to explain the mistake instead of "invalid key".
    stubFetch(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ detail: { status: "api_key_id_used_as_api_key" } }),
    }));

    const req = makeReq({ body: { apiKey: "f".repeat(64) } });
    const { res, capture } = makeRes();
    await voiceRecordController.listElevenlabsVoices(req, res);

    expect(capture.statusCode).toBe(400);
    expect((capture.jsonBody as any).code).toBe("api_key_id_used_as_api_key");
  });

  it("passes through the wrong-prefix code for a non-sk_ value", async () => {
    stubFetch(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ detail: { status: "invalid_api_key_prefix" } }),
    }));

    const req = makeReq({ body: { apiKey: "not-a-real-key-shape" } });
    const { res, capture } = makeRes();
    await voiceRecordController.listElevenlabsVoices(req, res);

    expect(capture.statusCode).toBe(400);
    expect((capture.jsonBody as any).code).toBe("invalid_api_key_prefix");
  });

  it("maps other upstream failures to 502", async () => {
    stubFetch(async () => ({ ok: false, status: 500 }));

    const req = makeReq({ body: { apiKey: "some-key" } });
    const { res, capture } = makeRes();
    await voiceRecordController.listElevenlabsVoices(req, res);

    expect(capture.statusCode).toBe(502);
    expect((capture.jsonBody as any).code).toBe("upstream_error");
  });

  it("returns 400 when apiKey is missing", async () => {
    const req = makeReq({ body: {} });
    const { res, capture } = makeRes();
    await voiceRecordController.listElevenlabsVoices(req, res);

    expect(capture.statusCode).toBe(400);
  });

  it("returns mapped voices on success", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        voices: [
          { voice_id: "v1", name: "Alice", category: "premade", labels: { gender: "female" } },
          { voice_id: "v2", name: "Bob", category: "cloned" },
        ],
      }),
    }));

    const req = makeReq({ body: { apiKey: "good-key" } });
    const { res, capture } = makeRes();
    await voiceRecordController.listElevenlabsVoices(req, res);

    expect(capture.statusCode).toBe(200);
    const body = capture.jsonBody as any;
    expect(body.success).toBe(true);
    expect(body.voices).toHaveLength(2);
    expect(body.voices[0]).toEqual({
      voice_id: "v1",
      name: "Alice",
      category: "premade",
      labels: { gender: "female" },
    });
    // Missing labels default to an empty object.
    expect(body.voices[1].labels).toEqual({});
  });
});
