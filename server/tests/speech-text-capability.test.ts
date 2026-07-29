/**
 * Phase 1 cost-saving — pure logic for the client-STT path:
 *   1. capability-gate: the master-gate contract (a substitution is active when
 *      full-attention is OFF AND the client advertised it — cost saving is the
 *      default for an economizing session). See planning-docs/aac-cost-saving-spec.md §0.
 *   2. speech-text: the [HEARD SPEECH] turn format + confidence mapping fed to
 *      the Observer in place of streamed audio. §1.
 */

import { describe, it, expect } from "@jest/globals";
import { isCapabilityActive } from "../services/dual-agent/capability-gate.js";
import { confidenceLabel, buildHeardSpeechTurn, describeSttConfidence } from "../services/dual-agent/speech-text.js";

describe("isCapabilityActive — master gate", () => {
  it("is active when full-attention is OFF and the client advertised it", () => {
    expect(isCapabilityActive({ fullAttentionMode: false, advertised: true })).toBe(true);
  });

  it("is OFF when full-attention is on (the per-student override wins)", () => {
    expect(isCapabilityActive({ fullAttentionMode: true, advertised: true })).toBe(false);
  });

  it("is OFF when the client didn't advertise it (old client)", () => {
    expect(isCapabilityActive({ fullAttentionMode: false, advertised: false })).toBe(false);
  });
});

describe("confidenceLabel", () => {
  it("maps numeric confidence to coarse bands", () => {
    expect(confidenceLabel(0.9)).toBe("high");
    expect(confidenceLabel(0.75)).toBe("high");
    expect(confidenceLabel(0.6)).toBe("medium");
    expect(confidenceLabel(0.45)).toBe("medium");
    expect(confidenceLabel(0.2)).toBe("low");
  });

  it("is 'unknown' when no confidence is provided", () => {
    expect(confidenceLabel(undefined)).toBe("unknown");
    expect(confidenceLabel(NaN)).toBe("unknown");
  });
});

describe("describeSttConfidence", () => {
  it("keeps the raw score in the flow log alongside the band", () => {
    expect(describeSttConfidence(0.41)).toBe("asr 0.41 (low)");
    expect(describeSttConfidence(0.92)).toBe("asr 0.92 (high)");
  });

  it("says so plainly when the model reported no score", () => {
    expect(describeSttConfidence(undefined)).toBe("asr n/a");
  });
});

describe("buildHeardSpeechTurn", () => {
  it("embeds the verbatim text and asks for transcript() routing", () => {
    const turn = buildHeardSpeechTurn("can I have water", 0.9)!;
    expect(turn).toContain('"can I have water"');
    expect(turn).toContain("confidence: high");
    expect(turn).toContain("relay them as heard");
    expect(turn).toContain("transcript()");
  });

  // A weak recogniser score is the Observer's cue that the words themselves may
  // be invented — the recogniser never returns silence, so noise comes back as
  // a fluent sentence. The turn must SAY so, not just print a band.
  it("tells the Observer to weigh weak-score words against the scene and drop misfits", () => {
    const turn = buildHeardSpeechTurn("I am the mother of media", 0.4)!;
    expect(turn).toContain("confidence: low");
    expect(turn).toContain("never returns silence");
    expect(turn).toContain("drop it");
  });

  it("treats an unscored transcript as doubtful too, not as confident", () => {
    const turn = buildHeardSpeechTurn("mumble mumble")!;
    expect(turn).toContain("confidence: unknown");
    expect(turn).toContain("unable to score");
    expect(turn).not.toContain("relay them as heard");
  });

  it("trims and returns null for empty / whitespace text (nothing to route)", () => {
    expect(buildHeardSpeechTurn("   ")).toBeNull();
    expect(buildHeardSpeechTurn("")).toBeNull();
    expect(buildHeardSpeechTurn("  hi  ", 0.8)).toContain('"hi"');
  });
});
