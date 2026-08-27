// Pins the 2026-08-27 Monitor-prompt changes that make its Claude prompt
// cache hit: the ~13k-token Interactive-Agent quote is gone, the
// [UPDATE_PROMPT] directive (which nothing in the 4-agent system consumed) is
// gone, the memory rules describe STATIC prompt mode, and the prompt is
// byte-identical across builds — the precondition for a cache read.

import { describe, it, expect } from "@jest/globals";
import { buildMonitorSystemPrompt } from "../services/memory-schema/aac-memory-schema.js";

const student = {
  name: "Sam Test",
  aacSettings: { chatAgentPrompt: null, autoAacPrompt: null, dynamicBoardsEnabled: true },
  framework: null,
};

describe("buildMonitorSystemPrompt — cache-stable Monitor prompt", () => {
  it("no longer quotes the Interactive Agent's prompt or offers [UPDATE_PROMPT]", () => {
    const p = buildMonitorSystemPrompt(student, "unmuted", [{ id: "b1", name: "Meals", hint: "mealtime" }]);
    expect(p).not.toContain("Interactive Agent's Current Prompt");
    expect(p).not.toContain("UPDATE_PROMPT");
    expect(p).toContain("[CONTEXT]");
  });

  it("describes static prompt mode: data is viewed, never assumed inline", () => {
    const p = buildMonitorSystemPrompt(student);
    expect(p).toContain("Memory DATA is not rendered in this prompt");
    expect(p).not.toContain("ALREADY VISIBLE in the memory section");
    expect(p).toContain("Do NOT view the same path twice");
  });

  it("is byte-identical across builds with the same inputs (no clock, no per-call state)", () => {
    const boards = [{ id: "b1", name: "Meals", hint: "mealtime", isGenerated: true }];
    const a = buildMonitorSystemPrompt(student, "muted", boards);
    const b = buildMonitorSystemPrompt(student, "muted", boards);
    expect(a).toBe(b);
    // And well under the old size: the quote alone was ~52k chars.
    expect(a.length).toBeLessThan(30_000);
  });
});
