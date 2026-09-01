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

  // ── the repeated-message rules ────────────────────────────────────────
  //
  // Prod 2026-08-30. A child in post-hospitalization anxiety pressed "I'm
  // still scared" twenty-six times across ninety minutes. The Monitor read the
  // distress correctly and injected, verbatim: "DO NOT push AAC engagement…",
  // "Offer ONLY comfort-focused sentence buttons", "respond with validation
  // and warmth, not engagement questions". All prohibition, no next step — so
  // the board kept offering her the same four words and nobody, human or
  // machine, ever asked what she was afraid of.
  //
  // The section it should have reached for was gated on intent being UNCLEAR.
  // Hers was perfectly clear; it was simply unanswered, and that had no rule.

  it("covers a CLEAR message that keeps coming back, not just an unclear one", () => {
    const p = buildMonitorSystemPrompt(student);
    expect(p).toContain("Repeated or Unclear User Communication");
    expect(p).toMatch(/CLEAR message repeated across the session/);
    // The corrective has to be an ACTION. "Acknowledge it again" is what the
    // Monitor already produces on its own.
    expect(p).toMatch(/Name the next question in that thread/);
  });

  it("tells it that a restriction still owes the agent something to ask", () => {
    const p = buildMonitorSystemPrompt(student);
    expect(p).toMatch(/Following the user's own subject is never "changing the subject"/);
    expect(p).toMatch(/still say what it should ASK/);
  });

  it("keeps both rules short — the Monitor prompt is cached whole, every turn", () => {
    const p = buildMonitorSystemPrompt(student);
    const added = p.split("\n").filter((l) =>
      l.includes("CLEAR message repeated") || l.includes("Following the user's own subject"));
    expect(added).toHaveLength(2);
    for (const line of added) expect(line.length).toBeLessThan(320);
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
