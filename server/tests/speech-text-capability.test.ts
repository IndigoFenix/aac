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
import { confidenceLabel, buildHeardSpeechTurn } from "../services/dual-agent/speech-text.js";

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
  });
});

describe("buildHeardSpeechTurn", () => {
  it("embeds the verbatim text, marks it authoritative, and asks for transcript() routing", () => {
    const turn = buildHeardSpeechTurn("can I have water", 0.9)!;
    expect(turn).toContain('"can I have water"');
    expect(turn).toContain("confidence: high");
    expect(turn).toContain("authoritative");
    expect(turn).toContain("transcript()");
  });

  it("surfaces low confidence so the Observer treats attribution as uncertain", () => {
    const turn = buildHeardSpeechTurn("mumble mumble", 0.2)!;
    expect(turn).toContain("confidence: low");
    expect(turn).toContain("uncertain");
  });

  it("trims and returns null for empty / whitespace text (nothing to route)", () => {
    expect(buildHeardSpeechTurn("   ")).toBeNull();
    expect(buildHeardSpeechTurn("")).toBeNull();
    expect(buildHeardSpeechTurn("  hi  ", 0.8)).toContain('"hi"');
  });
});
