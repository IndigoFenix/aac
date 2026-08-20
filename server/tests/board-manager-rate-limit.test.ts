// A refused request is not a fumbled one.
//
// The Board Manager treats an empty or malformed model response as worth
// retrying immediately — the model stumbled, a second attempt usually lands.
// A 429 is different in kind: the API declined, and asking again cannot change
// that. On 2026-08-20 the AI Studio key hit its daily cap, so every rebuild
// returned RESOURCE_EXHAUSTED and each failure instantly fired a second
// request, roughly doubling load against a quota that was already gone.
//
// These pin the classifier that keeps the two apart. The retry DECISION lives
// in AgentCoordinator (it skips when finishReason is RATE_LIMITED); what is
// testable without a live session is that the right label comes out.

import { describe, test, expect, jest, beforeEach } from "@jest/globals";

// The module under test pulls in the whole prompt/tooling graph, so the flow
// logger is stubbed rather than writing to the real debug log.
jest.unstable_mockModule("../services/dual-agent/agent-flow-logger.js", () => ({
  flowInput: () => {},
  flowTool: () => {},
  flowNote: () => {},
}));

const { classifyProviderFailure } = await import(
  "../services/dual-agent/board-manager-agent.js"
);

describe("classifyProviderFailure", () => {
  test("a Gemini 429 is RATE_LIMITED, not ERROR", () => {
    const msg = '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}';
    expect(classifyProviderFailure(msg)).toBe("RATE_LIMITED");
  });

  test("recognises the other spellings a rate limit arrives in", () => {
    for (const msg of [
      "429 Too Many Requests",
      "Quota exceeded for quota metric 'Generate Content API requests per minute'",
      "rate limit reached for model",
      "RESOURCE_EXHAUSTED",
    ]) {
      expect(classifyProviderFailure(msg)).toBe("RATE_LIMITED");
    }
  });

  test("an ordinary failure stays ERROR, so it still retries", () => {
    // The retry is valuable for these — losing it would make a transient blip
    // cost the student a board refresh.
    for (const msg of [
      "socket hang up",
      "500 Internal Server Error",
      "Invalid JSON payload received",
      "",
    ]) {
      expect(classifyProviderFailure(msg)).toBe("ERROR");
    }
  });

  test("does not fire on the word 'quotation' or similar near-misses", () => {
    // Substring matching on "quota" would; word boundaries matter because a
    // false RATE_LIMITED silently disables a retry that should have happened.
    expect(classifyProviderFailure("bad quotation marks in tool args")).toBe("ERROR");
  });
});
