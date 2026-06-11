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
