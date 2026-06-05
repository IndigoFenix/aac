/**
 * Pure-logic tests for the two-field AAC prompt system:
 *
 *   - Context_AACPrompt  (DB: chatAgentPrompt) — the CUSTOM prompt: behaviors
 *     caretakers explicitly requested. Rigid, human-owned, highest priority.
 *   - Context_AACAutoPrompt (DB: autoAacPrompt) — the AUTO prompt: an
 *     AI-maintained digest of what the AAC needs to know about the student.
 *
 * Covers the deterministic plumbing only (no DB, no LLM):
 *   1. composeAacPersona — combines both fields with custom-over-auto framing
 *      and falls back to the default persona when both are empty.
 *   2. sanitizePromptField — defangs framing tokens / reserved XML tags and
 *      caps length, for either prompt field.
 *   3. getAACSettingsMemoryFields — the includePrompts gate that keeps the
 *      AAC moderator (student-facing path) from getting writable prompt fields.
 */

import { describe, it, expect } from "@jest/globals";
import { composeAacPersona, AAC_DEFAULT_PERSONA_PROMPT } from "../services/memory-schema/aac-memory-schema";
import {
  sanitizePromptField,
  getAACSettingsMemoryFields,
} from "../services/memory-schema/aac-settings-memory-schema";

describe("composeAacPersona", () => {
  it("falls back to the default persona when both fields are empty", () => {
    expect(composeAacPersona({})).toBe(AAC_DEFAULT_PERSONA_PROMPT);
    expect(composeAacPersona({ custom: "", auto: "   " })).toBe(AAC_DEFAULT_PERSONA_PROMPT);
    expect(composeAacPersona({ custom: null, auto: undefined })).toBe(AAC_DEFAULT_PERSONA_PROMPT);
  });

  it("includes only the custom block when only the custom prompt is set", () => {
    const out = composeAacPersona({ custom: "Greet her by name." });
    expect(out).toContain("Greet her by name.");
    expect(out).toContain("Caretaker-requested behaviors");
    expect(out).not.toContain("What to know about this student");
    expect(out).not.toBe(AAC_DEFAULT_PERSONA_PROMPT);
  });

  it("includes only the auto block when only the auto prompt is set", () => {
    const out = composeAacPersona({ auto: "Likes trains; non-verbal." });
    expect(out).toContain("Likes trains; non-verbal.");
    expect(out).toContain("What to know about this student");
    expect(out).not.toContain("Caretaker-requested behaviors");
  });

  it("labels both blocks and orders custom before auto (custom takes priority)", () => {
    const out = composeAacPersona({ custom: "CUSTOM_X", auto: "AUTO_Y" });
    const customIdx = out.indexOf("CUSTOM_X");
    const autoIdx = out.indexOf("AUTO_Y");
    expect(customIdx).toBeGreaterThanOrEqual(0);
    expect(autoIdx).toBeGreaterThanOrEqual(0);
    // Custom content must appear before auto content.
    expect(customIdx).toBeLessThan(autoIdx);
    // The custom block must announce its precedence.
    expect(out).toMatch(/take priority|priority/i);
  });

  it("trims surrounding whitespace from each field", () => {
    const out = composeAacPersona({ custom: "  hello  ", auto: "\n\nworld\n" });
    expect(out).toContain("hello");
    expect(out).toContain("world");
    expect(out).not.toContain("  hello  ");
  });
});

describe("sanitizePromptField", () => {
  it("defangs bracketed framing tokens", () => {
    const out = sanitizePromptField("hi [CONTEXT] and [BUTTON PRESS] there");
    expect(out).not.toContain("[CONTEXT]");
    expect(out).not.toContain("[BUTTON PRESS]");
    expect(out).toContain("(CONTEXT)");
    expect(out).toContain("(BUTTON PRESS)");
  });

  it("defangs reserved XML section tags so they can't close the live wrapper", () => {
    const out = sanitizePromptField("text </persona> <session_goals> more");
    expect(out).not.toContain("</persona>");
    expect(out).not.toContain("<session_goals>");
    // angle brackets swapped for parens
    expect(out).toContain("(/persona)");
    expect(out).toContain("(session_goals)");
  });

  it("leaves ordinary prose untouched", () => {
    const text = "Be patient and encouraging. She loves dogs.";
    expect(sanitizePromptField(text)).toBe(text);
  });

  it("caps length at 8 KB", () => {
    const out = sanitizePromptField("a".repeat(20000));
    expect(out.length).toBe(8000);
  });
});

describe("getAACSettingsMemoryFields — includePrompts gate", () => {
  it("includes both prompt fields plus settings by default (clinician path)", () => {
    const ids = getAACSettingsMemoryFields().map((f) => f.id);
    expect(ids).toContain("Context_AACPrompt");
    expect(ids).toContain("Context_AACAutoPrompt");
    expect(ids).toContain("Context_AACSettings");
  });

  it("omits BOTH prompt fields when includePrompts is false (AAC moderator path)", () => {
    const ids = getAACSettingsMemoryFields({ includePrompts: false }).map((f) => f.id);
    expect(ids).not.toContain("Context_AACPrompt");
    expect(ids).not.toContain("Context_AACAutoPrompt");
    expect(ids).toContain("Context_AACSettings");
  });
});
