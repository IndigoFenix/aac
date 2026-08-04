// Unit tests for the "words uncertain" marker — the speech recogniser's own
// score, carried into the tag that BOTH the Speaker and the Board Manager read.
//
// Motivated by the "I am the mother of media" incident: Cloud STT decoded far-
// field Hebrew into a fluent sentence nobody said, the Observer relayed it
// verbatim, and the Board Manager built "Where is Media?" buttons around the
// phantom name — one press away from the user CONFIRMING it. The recogniser's
// score was the one signal that could have flagged it, and it was being
// replaced with a hard-coded 0.9 before any agent saw it.
import { clarityTag, confidenceLabel, matchHeardSpeechTurn, type HeardSpeechTurn } from "../services/dual-agent/speech-text";
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

// Which turn's score gets stamped. The Observer answers a beat late — and when
// it calls request_audio, several seconds late — so "the newest score" is
// routinely a DIFFERENT utterance's score than the one being routed.
describe("matchHeardSpeechTurn — the score follows the words, not the clock", () => {
  const TTL = 30_000;
  const turn = (text: string, confidence: number | undefined, at: number): HeardSpeechTurn =>
    ({ text, confidence, at });

  it("matches a transcript to the turn it relays", () => {
    const history = [turn("אנחנו רוצים לקנות גלידה", 0.95, 1_000)];
    expect(matchHeardSpeechTurn("אנחנו רוצים לקנות גלידה", history, 2_000, TTL)?.confidence).toBe(0.95);
  });

  // Session 043b0b6f, 2026-08-04: the caregiver asked to open the ice-cream
  // board at asr 0.65 (medium). The Observer pulled the clip and routed it 5s
  // later — after a 0.41 fragment had landed — so the request inherited "low"
  // and rendered as "words very uncertain". That marker tells the Board Manager
  // not to act on the specifics, and the specific WAS the board. It never opened.
  it("does not let a later, weaker fragment downgrade an earlier clean sentence", () => {
    const history = [
      turn("רוצים לראות את הלוח", 0.65, 1_000),
      turn("גלידה", 0.41, 4_000),
    ];
    const matched = matchHeardSpeechTurn("רוצים לראות את הלוח?", history, 6_000, TTL);
    expect(matched?.confidence).toBe(0.65);
    expect(clarityTag(confidenceLabel(matched?.confidence))).toBe(" — words uncertain");
  });

  // The Observer re-punctuates when it routes ("…הלוח" → "…הלוח?"). Punctuation
  // must never decide whether a transcript is recognised as its own relay.
  it("ignores punctuation and case differences", () => {
    const history = [turn("do you want lunch", 0.9, 1_000)];
    expect(matchHeardSpeechTurn("Do you want lunch?", history, 2_000, TTL)?.confidence).toBe(0.9);
  });

  // The motivating "mother of media" case: STT invents a fluent sentence, the
  // Observer relays it verbatim. The warning must survive.
  it("keeps a weak score attached to the phantom sentence it produced", () => {
    const history = [turn("אני אמא של מדיה", 0.3, 1_000)];
    const matched = matchHeardSpeechTurn("אני אמא של מדיה", history, 2_000, TTL);
    expect(clarityTag(confidenceLabel(matched?.confidence))).toBe(" — words very uncertain");
  });

  // Borrowing a score from unrelated speech is what produced the bug. No match
  // means no claim — the same rule clarityTag applies to an unscored turn.
  it("returns nothing when no recent turn relays those words", () => {
    const history = [turn("גלידה", 0.41, 1_000)];
    expect(matchHeardSpeechTurn("רוצים לראות את הלוח?", history, 2_000, TTL)).toBeUndefined();
    expect(matchHeardSpeechTurn("anything", [], 2_000, TTL)).toBeUndefined();
  });

  it("ignores turns past the TTL", () => {
    const history = [turn("רוצים לראות את הלוח", 0.65, 1_000)];
    expect(matchHeardSpeechTurn("רוצים לראות את הלוח", history, 1_000 + TTL + 1, TTL)).toBeUndefined();
  });

  // A repeated phrase resolves to the most recent time it was said.
  it("prefers the later turn when two match equally well", () => {
    const history = [
      turn("אני רוצה גלידה", 0.9, 1_000),
      turn("אני רוצה גלידה", 0.5, 5_000),
    ];
    expect(matchHeardSpeechTurn("אני רוצה גלידה", history, 6_000, TTL)?.confidence).toBe(0.5);
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
