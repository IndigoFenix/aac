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
  });

  it("maps other upstream failures to 502", async () => {
    stubFetch(async () => ({ ok: false, status: 500 }));

    const req = makeReq({ body: { apiKey: "some-key" } });
    const { res, capture } = makeRes();
    await voiceRecordController.listElevenlabsVoices(req, res);

    expect(capture.statusCode).toBe(502);
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
