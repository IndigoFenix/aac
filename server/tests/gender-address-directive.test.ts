/**
 * Grammatical-gender addressing. AAC students use heavily gendered languages
 * (Hebrew, Arabic, …) where the unmarked default is masculine; the localized
 * worked examples are themselves masculine, so the model would address a female
 * student — and voice HER own utterances — in masculine forms. These tests pin
 * the explicit directive injected into the companion/board-manager prompts
 * (genderedAddressDirective) and the separate addressee block threaded into the
 * social-practice peer prompts.
 */

import { describe, it, expect } from "@jest/globals";
import { genderedAddressDirective } from "../services/dual-agent/prompts/shared";
import { geminiVoiceGender } from "../services/social-bot/voice-pick";
import { ex } from "../services/memory-schema/prompt-examples";
import { buildSessionPrefix, buildLivePeerPrompt } from "../services/social-bot/prompt-assembly";

// Minimal persona pieces built inline. We deliberately do NOT import
// persona-generator: it transitively pulls ProceduralFace.tsx (JSX), which the
// jest transform can't parse. renderIdentity only reads a handful of genome /
// identity fields, so a hand-rolled shape is enough to exercise the prompts.
const genome: any = {
  warmth: 0.7, expressiveness: 0.5, stability: 0.5,
  openness: 0.5, assertiveness: 0.5, patience: 0.5,
};
const identity: any = { interests: {}, stances: {} };
const humorStyle: any = "dry";

describe("genderedAddressDirective (Speaker / Board Manager)", () => {
  it("emits a feminine directive naming the student + language", () => {
    const out = genderedAddressDirective("שחף", "female", "he");
    expect(out).toContain("שחף");
    expect(out).toContain("feminine");
    expect(out).toContain("Hebrew"); // names the actual language
    expect(out).toContain("<grammatical_gender>");
  });

  it("emits a masculine directive for a boy", () => {
    const out = genderedAddressDirective("Daniel", "male", "he");
    expect(out).toContain("masculine");
    expect(out).toContain("Daniel");
  });

  it("returns empty when the language does NOT mark gender (English, etc.)", () => {
    expect(genderedAddressDirective("Emma", "female", "en")).toBe("");
    expect(genderedAddressDirective("Emma", "female", "ko")).toBe("");
    expect(genderedAddressDirective("Emma", "female", undefined)).toBe("");
  });

  it("returns empty when gender is unknown (no claim we can't back)", () => {
    expect(genderedAddressDirective("Sam", undefined, "he")).toBe("");
    expect(genderedAddressDirective("Sam", "", "he")).toBe("");
    expect(genderedAddressDirective("Sam", "nonbinary", "he")).toBe("");
  });

  it("accepts a display name as the language too (peer path passes 'Hebrew')", () => {
    expect(genderedAddressDirective("שחף", "female", "Hebrew")).toContain("feminine");
  });
});

describe("genderedAddressDirective — the AI's OWN gender (from its voice)", () => {
  it("adds a self-reference line matching the AI voice, independent of the student", () => {
    // Male student, female-voiced AI — the two genders must not bleed together.
    const out = genderedAddressDirective("Daniel", "male", "he", "female");
    expect(out).toContain("Daniel");
    expect(out).toContain("masculine"); // student line
    expect(out).toContain("a woman's"); // AI line names the voice
    expect(out).toContain("yourself in the first person");
    expect(out).toContain("feminine verb and adjective forms");
  });

  it("emits an AI-only block when the student's gender is unknown", () => {
    const out = genderedAddressDirective("Sam", undefined, "he", "male");
    expect(out).toContain("<grammatical_gender>");
    expect(out).toContain("a man's");
    expect(out).toContain("Hebrew marks grammatical gender"); // language claim survives without the student line
    expect(out).not.toContain("[Sam] is"); // no claim about the student
  });

  it("still returns empty for non-gendered languages even with an AI gender", () => {
    expect(genderedAddressDirective("Emma", "female", "en", "female")).toBe("");
  });

  it("omitting aiGender leaves the student-only block byte-identical (Board Manager path)", () => {
    const without = genderedAddressDirective("שחף", "female", "he");
    const withUnknown = genderedAddressDirective("שחף", "female", "he", undefined);
    expect(withUnknown).toBe(without);
    expect(without).not.toContain("Your own voice");
  });
});

describe("geminiVoiceGender — classifying the AI voice", () => {
  it("classifies the pools, with Zephyr (the default AI voice) as female", () => {
    expect(geminiVoiceGender("Zephyr")).toBe("female");
    expect(geminiVoiceGender("Leda")).toBe("female");
    expect(geminiVoiceGender("Puck")).toBe("male");
    expect(geminiVoiceGender("Charon")).toBe("male");
  });

  it("returns null for unknown or missing names — never guesses", () => {
    expect(geminiVoiceGender("NotAVoice")).toBeNull();
    expect(geminiVoiceGender(undefined)).toBeNull();
    expect(geminiVoiceGender(null)).toBeNull();
  });
});

describe("ex() — per-gender example variants", () => {
  it("voices the student's own utterance in feminine Hebrew for a girl", () => {
    const m = ex("tool.sbf_speech_one_glyph_tired", "he", undefined, "male");
    const f = ex("tool.sbf_speech_one_glyph_tired", "he", undefined, "female");
    expect(m).toContain("עייף");
    expect(f).toContain("עייפה"); // feminine form
    expect(f).not.toBe(m);
  });

  it("defaults to masculine when gender is unknown (historical default — no-op)", () => {
    const def = ex("tool.sbf_speech_one_glyph_tired", "he");
    const m = ex("tool.sbf_speech_one_glyph_tired", "he", undefined, "male");
    expect(def).toBe(m);
  });

  it("feminizes the AI's address in the speaker dialogue example", () => {
    const f = ex("speaker.interact_dialogue", "he", false, "female");
    expect(f).toContain("תרצי"); // feminine 'would you like'
    expect(f).toContain("בואי"); // feminine 'come/let's'
  });

  it("leaves non-gendered locales (English) unaffected by gender", () => {
    const m = ex("tool.sbf_speech_one_glyph_tired", "en", undefined, "male");
    const f = ex("tool.sbf_speech_one_glyph_tired", "en", undefined, "female");
    expect(m).toBe(f); // English example is a plain string
  });
});

describe("social-practice peer — addressee gender block", () => {
  it("buildSessionPrefix tells the peer to address a FEMALE student in feminine forms", () => {
    // Peer is male; the STUDENT is female — the two genders are independent.
    const prefix = buildSessionPrefix(
      "Luna", "male", genome, identity, humorStyle, "Hebrew", undefined, "female",
    );
    expect(prefix).toContain("WHO YOU'RE TALKING TO");
    expect(prefix).toContain("feminine");
    // The peer's own gender (male) must still drive self-reference.
    expect(prefix).toContain("young man");
  });

  it("omits the addressee block when the student's gender is unknown", () => {
    const prefix = buildSessionPrefix(
      "Luna", "male", genome, identity, humorStyle, "Hebrew", undefined, undefined,
    );
    expect(prefix).not.toContain("WHO YOU'RE TALKING TO");
  });

  it("live peer prompt also carries the addressee block", () => {
    const prompt = buildLivePeerPrompt(
      "Luna", "female", genome, identity, humorStyle, "Hebrew", undefined, "female",
    );
    expect(prompt).toContain("WHO YOU'RE TALKING TO");
    expect(prompt).toContain("feminine");
  });

  it("omits the addressee block for a non-gendered language (English)", () => {
    const prefix = buildSessionPrefix(
      "Luna", "male", genome, identity, humorStyle, "English", undefined, "female",
    );
    expect(prefix).not.toContain("WHO YOU'RE TALKING TO");
  });
});
