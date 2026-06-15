// shared/aac-language-level.ts
//
// Single source of truth for the AAC "language level" — how long and complex
// the AI's sentences are, matched to THIS student's receptive language. It is a
// GENERAL AAC trait (not social-trainer-specific): the companion Speaker uses
// it to shape its own speech, and the social-trainer peer inherits it as the
// default register for its in-character lines.
//
// Stored on aacSettings.languageLevel as an integer 1..5 (see migration
// 0123_aac_language_level). Sentence-LENGTH focused — there is deliberately no
// separate vocabulary dial; the five tiers carry an implied register but we
// don't steer vocabulary independently (hard to do efficiently via a prompt).
//
// See planning-docs/social-trainer-cognitive-and-skill-params.md.

export const LANGUAGE_LEVELS = [
  "single_words",
  "short_phrases",
  "simple_sentences",
  "full_sentences",
  "complex",
] as const;

export type LanguageLevel = (typeof LANGUAGE_LEVELS)[number];

/** DB default = full_sentences — the current de-facto behavior. The column is
 *  1-indexed (1..5), so this is integer 4. */
export const DEFAULT_LANGUAGE_LEVEL: LanguageLevel = "full_sentences";
export const DEFAULT_LANGUAGE_LEVEL_INT = LANGUAGE_LEVELS.indexOf(DEFAULT_LANGUAGE_LEVEL) + 1; // 4

/** Map the stored integer (1..5) to a level key. Out-of-range / null /
 *  undefined → the default tier. */
export function languageLevelFromInt(n: number | null | undefined): LanguageLevel {
  if (typeof n === "number" && Number.isFinite(n)) {
    const i = Math.round(n) - 1;
    if (i >= 0 && i < LANGUAGE_LEVELS.length) return LANGUAGE_LEVELS[i];
  }
  return DEFAULT_LANGUAGE_LEVEL;
}

/** Map a level key back to its stored integer (1..5). */
export function languageLevelToInt(level: LanguageLevel): number {
  const i = LANGUAGE_LEVELS.indexOf(level);
  return (i < 0 ? LANGUAGE_LEVELS.indexOf(DEFAULT_LANGUAGE_LEVEL) : i) + 1;
}

// Per-tier directive injected into the model's prompt. Phrased to work for BOTH
// the companion (speaking to the user) and the peer (its in-character line).
//
// The default tier (full_sentences) returns null on purpose: the default is the
// model's natural conversational register, so emitting nothing keeps every
// existing student's prompt byte-identical after the migration backfills 4.
const DIRECTIVES: Record<LanguageLevel, string | null> = {
  single_words:
    'Speak at the very simplest level: ONE word, or at most a fixed two-word phrase. Never form a full sentence (e.g. "Yes." / "All done." / "More?").',
  short_phrases:
    'Keep every reply to a short 2–4 word phrase. Telegraphic, one idea at a time, no full sentences (e.g. "Time for lunch." / "Good throw!").',
  simple_sentences:
    'Use ONE short, simple sentence per reply — subject-verb-object, a single idea, common concrete words (e.g. "You found the red one.").',
  full_sentences: null,
  complex:
    "You may use a full, natural adult register — multi-clause sentences and idioms are fine when they fit the moment.",
};

/** The prompt directive for a level, or null when none is needed (default tier
 *  — caller should emit no language-level block). */
export function languageLevelDirective(level: LanguageLevel): string | null {
  return DIRECTIVES[level];
}

// A few concrete sample replies at each tier. The startup enhancer uses these to
// ANCHOR the examples it generates with a real illustration of the target
// register — the model imitates a concrete example far more than it obeys a
// directive. Null at full_sentences/complex (the natural register needs no
// illustration), keeping default-tier behavior unchanged.
const EXAMPLE_REPLIES: Record<LanguageLevel, string | null> = {
  single_words: `"Hi!" / "All done?" / "More?" / "Yum!" / "Wow!"`,
  short_phrases: `"Hi there!" / "All finished?" / "Good throw!" / "Time to eat." / "I like that."`,
  simple_sentences: `"I like that one." / "You found the red apple." / "Let's play a game now." / "That sounds fun."`,
  full_sentences: null,
  complex: null,
};

/** Concrete sample AI replies illustrating a tier's register, or null when none
 *  is needed (default/complex). */
export function languageLevelExampleReplies(level: LanguageLevel): string | null {
  return EXAMPLE_REPLIES[level];
}
