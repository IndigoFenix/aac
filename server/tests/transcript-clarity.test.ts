// Unit tests for the "words uncertain" marker — the speech recogniser's own
// score, carried into the tag that BOTH the Speaker and the Board Manager read.
//
// Motivated by the "I am the mother of media" incident: Cloud STT decoded far-
// field Hebrew into a fluent sentence nobody said, the Observer relayed it
// verbatim, and the Board Manager built "Where is Media?" buttons around the
// phantom name — one press away from the user CONFIRMING it. The recogniser's
// score was the one signal that could have flagged it, and it was being
// replaced with a hard-coded 0.9 before any agent saw it.
import { clarityTag } from "../services/dual-agent/speech-text";
import { renderEventLine } from "../services/dual-agent/prompts/board-manager";
import type { TranscribedEvent } from "../services/dual-agent/agent-events";

describe("clarityTag", () => {
  it("marks the bands where the words themselves are in doubt", () => {
    expect(clarityTag("low")).toBe(" — words very uncertain");
    expect(clarityTag("medium")).toBe(" — words uncertain");
  });

  // Marking a clean transcript would train both agents to ignore the marker.
  it("stays silent on a confident transcript", () => {
    expect(clarityTag("high")).toBe("");
  });

  // Google reports 0.0 / nothing when it has no score to give. That is not
  // evidence of a BAD recognition, and must not be rendered as one.
  it("stays silent when no score was reported at all", () => {
    expect(clarityTag("unknown")).toBe("");
    expect(clarityTag(undefined)).toBe("");
  });
});

describe("renderEventLine — recogniser clarity reaches the Board Manager", () => {
  const base: TranscribedEvent = {
    type: "transcribed",
    source: "observer",
    timestamp: 0,
    text: "אני אמא של מדיה",
    speaker: "Woman",
    target: "Raz",
    targetIsUser: true,
    confidence: "high",
  };

  it("marks a weakly-heard transcript in the tag", () => {
    expect(renderEventLine({ ...base, asrConfidence: "low" }))
      .toBe(`[Woman to Raz — words very uncertain] "אני אמא של מדיה"`);
  });

  it("leaves a confidently-heard transcript untouched", () => {
    expect(renderEventLine({ ...base, asrConfidence: "high" }))
      .toBe(`[Woman to Raz] "אני אמא של מדיה"`);
    expect(renderEventLine({ ...base, asrConfidence: undefined }))
      .toBe(`[Woman to Raz] "אני אמא של מדיה"`);
  });

  // WHO said it and WHETHER the words are right are independent failures, and
  // a transcript can suffer both at once — neither marker may swallow the other.
  it("stacks with an attribution demotion rather than replacing it", () => {
    const line = renderEventLine({
      ...base,
      speaker: "שחף",
      asrConfidence: "medium",
      attributionDemotion: "unverified_student_speech",
    });
    expect(line).toBe(`[HEARD NEAR שחף — speaker unverified — words uncertain] "אני אמא של מדיה"`);
  });
});
