// server/tests/aac-language-level.test.ts
//
// Unit coverage for the shared language-level helper — the single source of
// truth for sentence-length/complexity tiers consumed by the companion Speaker
// prompt and the social-trainer peer. Pure module (no provider / JSX imports),
// so it runs in the standard jest environment.

import {
  LANGUAGE_LEVELS,
  DEFAULT_LANGUAGE_LEVEL,
  DEFAULT_LANGUAGE_LEVEL_INT,
  languageLevelFromInt,
  languageLevelToInt,
  languageLevelDirective,
  languageLevelExampleReplies,
} from "@shared/aac-language-level";

describe("aac-language-level", () => {
  it("has five tiers with full_sentences as the default (integer 4)", () => {
    expect(LANGUAGE_LEVELS).toHaveLength(5);
    expect(DEFAULT_LANGUAGE_LEVEL).toBe("full_sentences");
    expect(DEFAULT_LANGUAGE_LEVEL_INT).toBe(4);
    expect(LANGUAGE_LEVELS[DEFAULT_LANGUAGE_LEVEL_INT - 1]).toBe(DEFAULT_LANGUAGE_LEVEL);
  });

  it("round-trips every level through int and back", () => {
    for (const level of LANGUAGE_LEVELS) {
      expect(languageLevelFromInt(languageLevelToInt(level))).toBe(level);
    }
  });

  it("maps the stored integer (1..5) to the right tier", () => {
    expect(languageLevelFromInt(1)).toBe("single_words");
    expect(languageLevelFromInt(2)).toBe("short_phrases");
    expect(languageLevelFromInt(3)).toBe("simple_sentences");
    expect(languageLevelFromInt(4)).toBe("full_sentences");
    expect(languageLevelFromInt(5)).toBe("complex");
  });

  it("falls back to the default tier for out-of-range / nullish input", () => {
    for (const bad of [undefined, null, 0, 6, -1, NaN, 3.0 / 0]) {
      expect(languageLevelFromInt(bad as any)).toBe(DEFAULT_LANGUAGE_LEVEL);
    }
  });

  it("rounds fractional integers to the nearest tier", () => {
    // Defends the integer-as-string write path (clinician memory schema).
    expect(languageLevelFromInt(2.4)).toBe("short_phrases");
    expect(languageLevelFromInt(2.6)).toBe("simple_sentences");
  });

  it("emits NO directive at the default tier so existing prompts are unchanged", () => {
    expect(languageLevelDirective("full_sentences")).toBeNull();
  });

  it("emits a non-empty directive for every non-default tier", () => {
    for (const level of LANGUAGE_LEVELS) {
      const directive = languageLevelDirective(level);
      if (level === DEFAULT_LANGUAGE_LEVEL) {
        expect(directive).toBeNull();
      } else {
        expect(typeof directive).toBe("string");
        expect((directive as string).length).toBeGreaterThan(0);
      }
    }
  });

  it("provides concrete example replies for the lower tiers, none at the default/complex tiers", () => {
    expect(languageLevelExampleReplies("full_sentences")).toBeNull();
    expect(languageLevelExampleReplies("complex")).toBeNull();
    for (const level of ["single_words", "short_phrases", "simple_sentences"] as const) {
      expect(typeof languageLevelExampleReplies(level)).toBe("string");
      expect((languageLevelExampleReplies(level) as string).length).toBeGreaterThan(0);
    }
  });

  it("makes the simplest tier strictly constrain length", () => {
    // The single_words tier must forbid full sentences — the whole point of the
    // setting for early communicators.
    expect(languageLevelDirective("single_words")!.toLowerCase()).toContain("one word");
    expect(languageLevelDirective("short_phrases")!.toLowerCase()).toContain("phrase");
  });
});
