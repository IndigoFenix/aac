/**
 * ClinicianStt.setLanguage — mid-call spoken-language switch.
 *
 * The clinician's own speech is recognized server-side by a per-socket
 * ClinicianStt (see server/services/call/clinician-stt.ts), opened with a
 * language hint on the FIRST `call:audio` chunk. `languageHint` used to be a
 * readonly constructor param, so every later chunk's `lang` was silently
 * ignored — a clinician who switched languages mid-call kept being
 * recognized in the first one. `setLanguage` fixes that: it updates the
 * hint and, if a streaming session is already open, rolls it over so the
 * NEXT chunk opens Google STT with the new language.
 *
 * `createStreamingSession` is mocked so no real Google STT session opens —
 * `jest.unstable_mockModule` + `await import`, since plain `jest.mock` is
 * inert under this repo's ESM setup (see server/tests/ai-open-decision.test.ts
 * for the same pattern).
 */

import { describe, test, expect, jest, beforeAll, beforeEach } from "@jest/globals";

const openSessions: Array<{ languageHint: string | undefined; ended: boolean }> = [];

const createStreamingSession = jest.fn((opts: any) => {
  const session = { languageHint: opts?.languageHint, ended: false };
  openSessions.push(session);
  return {
    write: jest.fn(() => true),
    end: jest.fn(async () => {
      session.ended = true;
      return "";
    }),
    abort: jest.fn(),
  };
});

jest.unstable_mockModule("../services/voice/google-stt-service", () => ({
  createStreamingSession,
}));

let ClinicianStt: typeof import("../services/call/clinician-stt").ClinicianStt;

beforeAll(async () => {
  ({ ClinicianStt } = await import("../services/call/clinician-stt"));
});

beforeEach(() => {
  openSessions.length = 0;
  createStreamingSession.mockClear();
});

describe("ClinicianStt.setLanguage", () => {
  test("setLanguage before any session is opened → no session opened", () => {
    const stt = new ClinicianStt("en", () => {}, 16000);
    stt.setLanguage("he");
    expect(createStreamingSession).not.toHaveBeenCalled();
  });

  test("same language → no rollover (no new session, old one not ended)", () => {
    const stt = new ClinicianStt("en", () => {}, 16000);
    stt.feed("chunk1"); // opens the first session with lang=en
    expect(createStreamingSession).toHaveBeenCalledTimes(1);
    const first = openSessions[0];

    stt.setLanguage("en");
    expect(createStreamingSession).toHaveBeenCalledTimes(1);
    expect(first.ended).toBe(false);
  });

  test("different language with a session open → old session ends, next feed opens with the new hint", async () => {
    const stt = new ClinicianStt("en", () => {}, 16000);
    stt.feed("chunk1"); // opens with lang=en
    expect(createStreamingSession).toHaveBeenCalledTimes(1);
    const first = openSessions[0];
    expect(first.languageHint).toBe("en");

    stt.setLanguage("he");
    // rollover happens synchronously inside setLanguage (end() is fire-and-forget).
    expect(first.ended).toBe(true);
    expect(createStreamingSession).toHaveBeenCalledTimes(2);
    const second = openSessions[1];
    expect(second.languageHint).toBe("he");

    // Next feed should just use the already-reopened (new-language) session,
    // not open yet another one.
    stt.feed("chunk2");
    expect(createStreamingSession).toHaveBeenCalledTimes(2);
  });

  test("different language with NO session currently open → hint stored, no rollover, next feed opens with new hint", () => {
    const stt = new ClinicianStt("en", () => {}, 16000);
    // No feed() yet, so no session exists.
    stt.setLanguage("he");
    expect(createStreamingSession).not.toHaveBeenCalled();

    stt.feed("chunk1");
    expect(createStreamingSession).toHaveBeenCalledTimes(1);
    expect(openSessions[0].languageHint).toBe("he");
  });
});
