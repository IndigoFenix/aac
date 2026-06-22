/**
 * Tests for Observer tool-call parsing — specifically that update_context
 * survives BOTH wire shapes Gemini emits:
 *   1. update_context({ type: "new_person", ... })   — the declared shape
 *   2. new_person({ ... })                            — subtype-as-toolname
 *
 * Regression: shape (2) used to hit the `default` case and be dropped, so the
 * Coordinator never registered the Observer's scene description (and the
 * startup greeting never fired). See agent-flow-debug.log 2026-06-11.
 */

import { describe, it, expect } from "@jest/globals";
import { parseToolCall } from "../services/dual-agent/observer-agent.js";

const NOW = 1_000_000;
const call = (name: string, args: Record<string, any> = {}) => ({ id: "x", name, args });

describe("parseToolCall — update_context normalization", () => {
  it("accepts the subtype called as a standalone function name", () => {
    const ev = parseToolCall(call("new_person", { key: "Mom", description: "A woman walked in." }), NOW);
    expect(ev).toMatchObject({ type: "context_update", updateType: "new_person", key: "Mom" });
  });

  it("accepts set_person_as_user as a function name (the user-identified signal)", () => {
    const ev = parseToolCall(call("set_person_as_user", { key: "Daniel", description: "confirmed user" }), NOW);
    expect(ev).toMatchObject({ type: "context_update", updateType: "set_person_as_user", key: "Daniel" });
  });

  it("still accepts the declared { type } shape", () => {
    const ev = parseToolCall(call("update_context", { type: "new_location", key: "room", description: "a room" }), NOW);
    expect(ev).toMatchObject({ type: "context_update", updateType: "new_location", key: "room" });
  });

  it("keeps a typeless update_context (folds to 'other' instead of dropping)", () => {
    const ev = parseToolCall(call("update_context", { key: "free time", description: "sitting quietly" }), NOW);
    expect(ev).toMatchObject({ type: "context_update", updateType: "other", key: "free time" });
  });

  it("folds tool-only subtypes (object_identified) into 'other' rather than dropping", () => {
    const ev = parseToolCall(call("object_identified", { key: "cup", description: "the red cup" }), NOW);
    expect(ev).toMatchObject({ type: "context_update", updateType: "other", key: "cup" });
  });

  it("parses request_audio into an audio_request event (Phase 1b backlog pull)", () => {
    const ev = parseToolCall(call("request_audio", { reason: "low confidence, need the tone" }), NOW);
    expect(ev).toMatchObject({ type: "audio_request", source: "observer", reason: "low confidence, need the tone" });
  });

  it("defaults request_audio reason so a bare call still routes", () => {
    const ev = parseToolCall(call("request_audio", {}), NOW);
    expect(ev).toMatchObject({ type: "audio_request" });
    expect((ev as any).reason).toBeTruthy();
  });

  it("drops a context update with neither key nor description", () => {
    expect(parseToolCall(call("new_person", {}), NOW)).toBeNull();
  });

  it("returns null for a genuinely unknown tool", () => {
    expect(parseToolCall(call("frobnicate", { foo: 1 }), NOW)).toBeNull();
  });

  it("does not mistake transcript for a context update", () => {
    const ev = parseToolCall(call("transcript", { text: "hi", speaker: "USER", target: "DEVICE" }), NOW);
    expect(ev?.type).toBe("transcribed");
  });
});

describe("parseToolCall — transcript targetIsUser flag", () => {
  it("carries an explicit targetIsUser=true through with the real name preserved", () => {
    const ev = parseToolCall(
      call("transcript", { text: "קוביה או גליל?", speaker: "שלי פרי", target: "שחף סוחמי", targetIsUser: true }),
      NOW,
    );
    expect(ev).toMatchObject({
      type: "transcribed",
      speaker: "שלי פרי",   // identity preserved, NOT flattened to USER
      target: "שחף סוחמי",
      targetIsUser: true,
      direction: "user",
    });
  });

  it("carries targetIsUser=false (speech to the AI) and marks direction device", () => {
    const ev = parseToolCall(
      call("transcript", { text: "what's the time?", speaker: "Mom", target: "DEVICE", targetIsUser: false }),
      NOW,
    );
    expect(ev).toMatchObject({ type: "transcribed", targetIsUser: false, direction: "device" });
  });

  it("coerces the string variants 'true'/'false'", () => {
    expect(parseToolCall(call("transcript", { text: "x", speaker: "Mom", target: "Sam", targetIsUser: "true" }), NOW))
      .toMatchObject({ targetIsUser: true, direction: "user" });
    expect(parseToolCall(call("transcript", { text: "x", speaker: "Mom", target: "Sam", targetIsUser: "false" }), NOW))
      .toMatchObject({ targetIsUser: false, direction: "ambient" });
  });

  it("leaves targetIsUser undefined when the model omits it (so the Coordinator's name-match fallback applies)", () => {
    const ev = parseToolCall(call("transcript", { text: "hi", speaker: "Mom", target: "Sam" }), NOW) as any;
    expect(ev.type).toBe("transcribed");
    expect(ev.targetIsUser).toBeUndefined();
  });

  it("still drops a transcript missing text/speaker/target", () => {
    expect(parseToolCall(call("transcript", { text: "hi", speaker: "Mom" }), NOW)).toBeNull();
  });
});
