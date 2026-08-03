/**
 * Pure-logic tests for the thorough-startup prompt-enhancer integration:
 *
 *   1. The XML-tag defang that protects clinician-written chatAgentPrompt
 *      from being able to close the wrapping <persona> / <session_goals> /
 *      etc. tags in the live system prompt.
 *
 *   2. The buildInteractiveAgentPrompt section-injection behavior: each
 *      EnhancedPromptSections field lands at the documented location, and
 *      omitted fields fall back to the static template content.
 *
 * The enhancer LLM call itself (thoroughStartup) is integration-tested
 * through the dual-agent service — not here. These tests cover the
 * deterministic plumbing.
 */

import { describe, it, expect } from "@jest/globals";
import { buildInteractiveAgentPrompt } from "../services/memory-schema/aac-memory-schema";
import { defangSectionContent } from "../services/dual-agent/session-plan";

describe("buildInteractiveAgentPrompt — enhanced section injection", () => {
  const base = {
    studentName: "Daniel",
    persona: "RAW_PERSONA_TEXT",
    language: "en",
    muteState: "unmuted" as const,
  };

  it("includes <persona> with the persona arg even when no other sections are provided", () => {
    const prompt = buildInteractiveAgentPrompt(base);
    expect(prompt).toContain("<persona>");
    expect(prompt).toContain("RAW_PERSONA_TEXT");
    expect(prompt).toContain("</persona>");
    // No session_goals / student_safety / student_specific_examples blocks
    expect(prompt).not.toContain("<session_goals>");
    expect(prompt).not.toContain("<student_safety>");
    expect(prompt).not.toContain("<student_specific_examples>");
  });

  it("injects sessionGoals as a <session_goals> block right after <persona>", () => {
    const prompt = buildInteractiveAgentPrompt({
      ...base,
      sessionGoals: "GOAL_BULLETS_HERE",
    });
    expect(prompt).toContain("<session_goals>\nGOAL_BULLETS_HERE\n</session_goals>");
    // Must appear AFTER </persona>
    const personaEnd = prompt.indexOf("</persona>");
    const goalsStart = prompt.indexOf("<session_goals>");
    expect(personaEnd).toBeGreaterThan(-1);
    expect(goalsStart).toBeGreaterThan(personaEnd);
  });

  it("renders the dynamic gesture override body when personaGestureOverrides is provided", () => {
    const prompt = buildInteractiveAgentPrompt({
      ...base,
      personaGestureOverrides: "Raises hand — wants a pause.",
    });
    expect(prompt).toContain("Raises hand — wants a pause.");
    // The static fallback copy ("If the <persona> section below mentions...")
    // must NOT appear when the override is present.
    expect(prompt).not.toContain('If the <persona> section below mentions specific gestures');
  });

  it("falls back to the static gesture-override description when personaGestureOverrides is absent", () => {
    const prompt = buildInteractiveAgentPrompt(base);
    expect(prompt).toContain('If the <persona> section below mentions specific gestures');
  });

  it("REPLACES the static interact_mode example when interactModeExamples is provided", () => {
    const withSection = buildInteractiveAgentPrompt({
      ...base,
      interactModeExamples: "USER_THEMED_INTERACT_DIALOGUE_ABC123",
    });
    const withoutSection = buildInteractiveAgentPrompt(base);
    expect(withSection).toContain("USER_THEMED_INTERACT_DIALOGUE_ABC123");
    // "Breakfast is important!" appears only inside the static
    // interact_mode.dialogue worked example — it's the cleanest sentinel
    // that the replacement landed (replacement, not augmentation).
    expect(withoutSection).toContain("Breakfast is important!");
    expect(withSection).not.toContain("Breakfast is important!");
  });

  it("REPLACES the static assist_mode example when assistModeExamples is provided", () => {
    const withSection = buildInteractiveAgentPrompt({
      ...base,
      assistModeExamples: "USER_THEMED_ASSIST_DIALOGUE_XYZ987",
    });
    const withoutSection = buildInteractiveAgentPrompt(base);
    expect(withSection).toContain("USER_THEMED_ASSIST_DIALOGUE_XYZ987");
    expect(withoutSection).toContain("You are facilitating communication between the user (a girl) and a therapist");
    expect(withSection).not.toContain("You are facilitating communication between the user (a girl) and a therapist");
  });

  it("REPLACES the static sentence_interpretation examples when sentenceInterpretationExamples is provided", () => {
    const withSection = buildInteractiveAgentPrompt({
      ...base,
      sentenceInterpretationExamples: "- `i_me+see+🌌` → interpret(\"I see space\") — astronomy theme.",
    });
    const withoutSection = buildInteractiveAgentPrompt(base);
    expect(withSection).toContain("I see space");
    // "operator-driven past tense" appears only inside the static
    // sentence_interpretation.worked_examples bullet list; "shoe+ball" is
    // also mentioned in the upstream PROCEDURE text and isn't suitable as
    // a replacement sentinel.
    expect(withoutSection).toContain("operator-driven past tense");
    expect(withSection).not.toContain("operator-driven past tense");
  });

  it("substitutes $SPEAK_VERB$ in sentenceInterpretationExamples just like the static template", () => {
    const directAudio = buildInteractiveAgentPrompt({
      ...base,
      useDirectAudio: true,
      sentenceInterpretationExamples: "- `x+y` → interpret(\"foo\") then $SPEAK_VERB$ + rebuild.",
    });
    const tooled = buildInteractiveAgentPrompt({
      ...base,
      useDirectAudio: false,
      sentenceInterpretationExamples: "- `x+y` → interpret(\"foo\") then $SPEAK_VERB$ + rebuild.",
    });
    expect(directAudio).toContain("speak aloud + rebuild");
    expect(tooled).toContain("call speak() + rebuild");
    expect(directAudio).not.toContain("$SPEAK_VERB$");
    expect(tooled).not.toContain("$SPEAK_VERB$");
  });

  it("injects safetyNotes as a <student_safety> block after <security>", () => {
    const prompt = buildInteractiveAgentPrompt({
      ...base,
      safetyNotes: "Watch for peanut allergy.",
    });
    expect(prompt).toContain("<student_safety>\nWatch for peanut allergy.\n</student_safety>");
    const securityEnd = prompt.indexOf("</security>");
    const safetyStart = prompt.indexOf("<student_safety>");
    expect(securityEnd).toBeGreaterThan(-1);
    expect(safetyStart).toBeGreaterThan(securityEnd);
  });

  it("renders all seven section payloads when fully populated", () => {
    const prompt = buildInteractiveAgentPrompt({
      ...base,
      persona: "PERSONA_TEXT",
      sessionGoals: "SESSION_GOALS_TEXT",
      personaGestureOverrides: "GESTURES_TEXT",
      interactModeExamples: "INTERACT_TEXT",
      assistModeExamples: "ASSIST_TEXT",
      sentenceInterpretationExamples: "SENTENCE_INTERP_TEXT",
      safetyNotes: "SAFETY_TEXT",
    });
    expect(prompt).toContain("PERSONA_TEXT");
    expect(prompt).toContain("SESSION_GOALS_TEXT");
    expect(prompt).toContain("GESTURES_TEXT");
    expect(prompt).toContain("INTERACT_TEXT");
    expect(prompt).toContain("ASSIST_TEXT");
    expect(prompt).toContain("SENTENCE_INTERP_TEXT");
    expect(prompt).toContain("SAFETY_TEXT");
  });
});

describe("buildInteractiveAgentPrompt — authority-deference default reaches the live prompt", () => {
  const base = {
    studentName: "Daniel",
    language: "en",
    muteState: "unmuted" as const,
  };

  // The AUTHORITY DEFERENCE block the identity_core call is instructed to append
  // to the persona section, condensed to its load-bearing lines. It travels as
  // ordinary persona prose, so it must survive the section defang and land
  // inside <persona> in the live prompt.
  const personaWithDeference = [
    "Daniel is 9. You are his patient, curious companion.",
    "The adults with him — his parents, his teacher, his therapist — decide what he may do,",
    "where he may go, what he may eat, and when an activity starts or stops.",
    "You support Daniel's communication; you do not overrule the adult in the room.",
    "This never suppresses what Daniel wants to say: distress, refusal, discomfort, pain and",
    "disagreement are always supported — help him SAY the objection, never talk him out of it.",
    "It never applies when an adult directs something the safety notes flag as unsafe,",
    "and never when Daniel reports harm.",
  ].join("\n");

  it("survives the section defang unchanged", () => {
    expect(defangSectionContent(personaWithDeference)).toBe(personaWithDeference);
  });

  it("renders the deference lines inside the <persona> block", () => {
    const prompt = buildInteractiveAgentPrompt({
      ...base,
      persona: defangSectionContent(personaWithDeference),
    });
    const personaStart = prompt.indexOf("<persona>");
    const personaEnd = prompt.indexOf("</persona>");
    const deferLine = prompt.indexOf("you do not overrule the adult in the room");
    expect(personaStart).toBeGreaterThan(-1);
    expect(deferLine).toBeGreaterThan(personaStart);
    expect(deferLine).toBeLessThan(personaEnd);
    // Both boundaries survive verbatim.
    expect(prompt).toContain("help him SAY the objection");
    expect(prompt).toContain("never when Daniel reports harm");
  });
});
