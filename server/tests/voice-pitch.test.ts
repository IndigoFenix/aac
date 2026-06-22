/**
 * Fast-tier voice attribution by pitch — the cheap pre-embedding read.
 * Pins matchPitch (gaussian similarity to per-person pitch profiles) and that
 * pitch candidates render as a provisional, weaker-than-embedding signal.
 * See planning-docs/aac-cost-saving-spec.md (two-tier voice recognition).
 */

import { describe, it, expect } from "@jest/globals";
import { matchPitch, describeVoiceCharacter, PITCH_CONFIDENCE_SCALE, type PitchProfile } from "../../shared/aac/voice-pitch.js";
import { fuseSpeakerLikelihood, renderSpeakerLikelihood } from "../../shared/aac/speaker-fusion.js";

const profiles: PitchProfile[] = [
  { entityId: "mom", name: "Mom", meanHz: 210, stdHz: 15, n: 5 },
  { entityId: "dad", name: "Dad", meanHz: 110, stdHz: 18, n: 5 },
];

describe("matchPitch", () => {
  it("ranks the nearest-pitch person first", () => {
    const out = matchPitch(205, profiles);
    expect(out[0].name).toBe("Mom");
    expect(out[0].source).toBe("pitch");
  });

  it("returns nothing when pitch is unmeasured", () => {
    expect(matchPitch(null, profiles)).toHaveLength(0);
    expect(matchPitch(0, profiles)).toHaveLength(0);
  });

  it("drops a person whose pitch is far away", () => {
    const out = matchPitch(110, profiles); // Dad's range; Mom is ~6 std away
    expect(out.some(c => c.name === "Dad")).toBe(true);
    expect(out.some(c => c.name === "Mom")).toBe(false);
  });

  it("keeps pitch similarity below 1 (weaker than an embedding match)", () => {
    const exact = matchPitch(210, profiles).find(c => c.name === "Mom")!;
    expect(exact.similarity).toBeLessThanOrEqual(PITCH_CONFIDENCE_SCALE + 1e-9);
    expect(exact.similarity).toBeGreaterThan(0.5);
  });

  it("with no learned profiles, names nobody (fast tier can't attribute yet)", () => {
    expect(matchPitch(200, [])).toHaveLength(0);
  });

  it("uses learned formant dispersion to disambiguate same-pitch people", () => {
    const twins: PitchProfile[] = [
      { entityId: "a", name: "Ann", meanHz: 200, stdHz: 12, n: 4, meanDispersion: 1250, stdDispersion: 60 },
      { entityId: "b", name: "Bea", meanHz: 200, stdHz: 12, n: 4, meanDispersion: 1000, stdDispersion: 60 },
    ];
    // Same pitch for both → dispersion breaks the tie toward Ann.
    const out = matchPitch(200, twins, 1250);
    expect(out[0].name).toBe("Ann");
    expect(out[0].similarity).toBeGreaterThan(out[1].similarity);
  });

  it("matches on dispersion alone when pitch is unvoiced", () => {
    const out = matchPitch(null, profiles.map(p => ({ ...p, meanDispersion: 1100, stdDispersion: 80 })), 1100);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("describeVoiceCharacter — coarse age/gender hint", () => {
  it("returns null when neither cue is measured", () => {
    expect(describeVoiceCharacter(null)).toBeNull();
    expect(describeVoiceCharacter(0, 0)).toBeNull();
  });

  it("calls a high-pitch / wide-dispersion voice a child (no gender)", () => {
    const s = describeVoiceCharacter(300, 1450)!;
    expect(s).toContain("child");
    expect(s).not.toMatch(/man|woman/);
  });

  it("formants override pitch: a low-pitched MAN with male-sized tract reads as a man", () => {
    expect(describeVoiceCharacter(120, 1000)).toContain("man");
  });

  it("formants resolve the overlap: a low-pitched woman (small tract) isn't called a man", () => {
    // Low pitch but female-sized vocal tract → not 'an adult man'.
    expect(describeVoiceCharacter(150, 1320)).not.toContain("an adult man");
  });

  it("flags conflicting cues rather than guessing (man-sized tract, high pitch)", () => {
    expect(describeVoiceCharacter(230, 1000)).toContain("mixed cues");
  });

  it("falls back to pitch-only bands when no formant data", () => {
    expect(describeVoiceCharacter(120)).toContain("man");
    expect(describeVoiceCharacter(200)).toMatch(/woman|child/);
    expect(describeVoiceCharacter(300)).toContain("child");
  });
});

describe("pitch candidates flow through fusion + render as provisional", () => {
  it("a moving mouth + a pitch match yields a provisional line labelled pitch~", () => {
    const candidates = matchPitch(205, profiles); // → Mom
    const ranked = fuseSpeakerLikelihood({
      voiceCandidates: candidates,
      identifiedFaces: [{ entityId: "mom", name: "Mom", bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }],
      lipFaces: [{ bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, mouthActivity: 3, visible: true }],
    });
    const line = renderSpeakerLikelihood(ranked, true);
    expect(line).toContain("[SPEAKER LIKELIHOOD: provisional]");
    expect(line).toContain("Mom");
    expect(line).toContain("pitch~");
    expect(line).toContain("mouth moving");
  });
});
