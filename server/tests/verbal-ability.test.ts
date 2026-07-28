// Unit tests for the transcript-attribution trust rules
// (shared/aac/verbal-ability.ts) and their rendering in the Board Manager's
// event lines. Motivated by the "bank" incident — ambient TV/adult speech
// attributed to a nonverbal student as her own fluent Hebrew, which the
// Speaker then answered literally. See
// planning-docs/aac-transcript-attribution-trust.md.
import {
  assessStudentTranscript,
  countSpokenWords,
  isVerbalAbility,
  utteranceExceedsVerbalAbility,
} from "@shared/aac/verbal-ability";
import { renderEventLine } from "../services/dual-agent/prompts/board-manager";
import { buildObserverPrompt } from "../services/dual-agent/prompts/observer";
import type { TranscribedEvent } from "../services/dual-agent/agent-events";

describe("countSpokenWords", () => {
  it("counts word-like tokens only", () => {
    expect(countSpokenWords("")).toBe(0);
    expect(countSpokenWords("   ")).toBe(0);
    expect(countSpokenWords("...")).toBe(0);
    expect(countSpokenWords("כן")).toBe(1);
    expect(countSpokenWords("בנק לאומי אופק קול ים שחף")).toBe(6);
    expect(countSpokenWords("i want to rub")).toBe(4);
    expect(countSpokenWords("לא, לא!")).toBe(2);
  });
});

describe("utteranceExceedsVerbalAbility", () => {
  it("gates nothing when ability is unspecified or unknown", () => {
    expect(utteranceExceedsVerbalAbility("full sentence here", null)).toBe(false);
    expect(utteranceExceedsVerbalAbility("full sentence here", undefined)).toBe(false);
    expect(utteranceExceedsVerbalAbility("full sentence here", "bogus" as any)).toBe(false);
  });

  it("none / vocalizations allow no worded speech at all", () => {
    expect(utteranceExceedsVerbalAbility("בנק", "none")).toBe(true);
    expect(utteranceExceedsVerbalAbility("בנק", "vocalizations")).toBe(true);
    expect(utteranceExceedsVerbalAbility("...", "none")).toBe(false);
  });

  it("single_words allows up to two words", () => {
    expect(utteranceExceedsVerbalAbility("אמא", "single_words")).toBe(false);
    expect(utteranceExceedsVerbalAbility("רוצה מים", "single_words")).toBe(false);
    expect(utteranceExceedsVerbalAbility("רוצה לעשות שמה בבנק", "single_words")).toBe(true);
  });

  it("fluent has no ceiling", () => {
    expect(utteranceExceedsVerbalAbility("בנק לאומי אופק קול ים שחף", "fluent")).toBe(false);
  });
});

describe("assessStudentTranscript", () => {
  it("returns null when ability is unspecified (legacy behavior)", () => {
    expect(
      assessStudentTranscript({ text: "רוצה לעשות שמה בבנק", ability: null, hasVoiceEvidence: false }),
    ).toBeNull();
  });

  it("flags impossible speech regardless of voice evidence", () => {
    // Even a (mis)matched voice can't make a nonverbal student fluent.
    expect(
      assessStudentTranscript({ text: "רוצה לעשות שמה בבנק", ability: "none", hasVoiceEvidence: true }),
    ).toBe("impossible_speech");
  });

  it("demotes within-ability speech from a limited-verbal student without evidence", () => {
    expect(
      assessStudentTranscript({ text: "כן", ability: "single_words", hasVoiceEvidence: false }),
    ).toBe("unverified_student_speech");
  });

  it("keeps full standing when a fresh voice match backs the claim", () => {
    expect(
      assessStudentTranscript({ text: "כן", ability: "single_words", hasVoiceEvidence: true }),
    ).toBeNull();
  });

  it("never demotes a fluent student for missing evidence", () => {
    expect(
      assessStudentTranscript({ text: "אני רוצה לדבר עם אבא", ability: "fluent", hasVoiceEvidence: false }),
    ).toBeNull();
  });
});

describe("isVerbalAbility", () => {
  it("accepts the enum values and rejects everything else", () => {
    for (const v of ["none", "vocalizations", "single_words", "fluent"]) {
      expect(isVerbalAbility(v)).toBe(true);
    }
    expect(isVerbalAbility(null)).toBe(false);
    expect(isVerbalAbility(undefined)).toBe(false);
    expect(isVerbalAbility("NONE")).toBe(false);
  });
});

describe("buildObserverPrompt — verbal ability line", () => {
  const baseConfig = { studentName: "Dana", language: "en" };

  it("states the capability as fact for limited-verbal students", () => {
    expect(buildObserverPrompt({ ...baseConfig, verbalAbility: "none" }))
      .toContain("[Dana] does NOT produce spoken words");
    expect(buildObserverPrompt({ ...baseConfig, verbalAbility: "vocalizations" }))
      .toContain("does NOT produce words");
    expect(buildObserverPrompt({ ...baseConfig, verbalAbility: "single_words" }))
      .toContain("single words or two-word combinations");
  });

  it("adds nothing for fluent or unspecified", () => {
    expect(buildObserverPrompt({ ...baseConfig, verbalAbility: "fluent" }))
      .not.toContain("NEVER theirs");
    expect(buildObserverPrompt({ ...baseConfig }))
      .not.toContain("NEVER theirs");
  });
});

describe("renderEventLine for demoted transcripts", () => {
  const base: TranscribedEvent = {
    type: "transcribed",
    source: "observer",
    timestamp: 0,
    text: "בנק",
    speaker: "שחף",
    target: "UNKNOWN",
    targetIsUser: false,
    confidence: "high",
    direction: "ambient",
  };

  it("renders an unverified attribution as hearsay near the student", () => {
    const line = renderEventLine({ ...base, attributionDemotion: "unverified_student_speech" });
    expect(line).toBe(`[HEARD NEAR שחף — speaker unverified] "בנק"`);
  });

  it("renders an impossible attribution with no speaker claim", () => {
    const line = renderEventLine({
      ...base,
      speaker: "UNKNOWN",
      attributionDemotion: "impossible_speech",
    });
    expect(line).toBe(`[HEARD NEARBY — speaker unknown] "בנק"`);
  });

  it("renders an undemoted transcript as a speaker-to-target turn", () => {
    const line = renderEventLine({ ...base, target: "DEVICE", attributionDemotion: undefined });
    expect(line).toBe(`[שחף to AI] "בנק"`);
  });
});
