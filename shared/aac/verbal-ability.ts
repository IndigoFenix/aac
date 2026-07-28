// shared/aac/verbal-ability.ts
//
// Structured speech-production capability of a student, and the trust rules
// the coordinator applies to speech transcripts attributed to them.
//
// Background (planning-docs/aac-transcript-attribution-trust.md): with no
// voice-ID evidence, the Observer's "assume the active user" default let
// ambient audio (a TV ad) be attributed to a nonverbal student as her own
// fluent speech, which the Speaker then answered literally. These rules make
// that structurally impossible instead of relying on prompt discipline:
// a transcript can never attribute to the student speech they cannot produce,
// and for limited-verbal students, unevidenced within-ability speech is
// demoted to ambient context rather than a reply-demanding user turn.

export const VERBAL_ABILITIES = [
  "none",          // does not produce spoken words
  "vocalizations", // vocalizes (sounds, laughter) but no words
  "single_words",  // isolated words / two-word combinations at most
  "fluent",        // spoken sentences are within capability
] as const;

export type VerbalAbility = (typeof VERBAL_ABILITIES)[number];

/** Word-count ceiling per ability. `none`/`vocalizations` allow no worded
 *  speech at all — STT rendering a moan as a word is exactly the failure this
 *  gate exists to catch. */
const MAX_WORDS: Record<VerbalAbility, number> = {
  none: 0,
  vocalizations: 0,
  single_words: 2,
  fluent: Infinity,
};

export function isVerbalAbility(v: unknown): v is VerbalAbility {
  return typeof v === "string" && (VERBAL_ABILITIES as readonly string[]).includes(v);
}

/** Count word-like tokens (anything bearing a letter). Punctuation-only and
 *  empty tokens don't count. */
export function countSpokenWords(text: string): number {
  return text
    .split(/\s+/)
    .filter((tok) => /\p{L}/u.test(tok))
    .length;
}

/** True when `text` is beyond what a student with `ability` can produce.
 *  Null/undefined/unknown ability = unspecified → never exceeds (no gating). */
export function utteranceExceedsVerbalAbility(
  text: string,
  ability: VerbalAbility | null | undefined,
): boolean {
  if (!isVerbalAbility(ability)) return false;
  return countSpokenWords(text) > MAX_WORDS[ability];
}

/**
 * How a student-attributed transcript should be demoted, if at all.
 *  - "impossible_speech" — the utterance exceeds the student's capability, so
 *    the attribution is wrong. The whole who/whom judgment is suspect: strip
 *    the speaker to UNKNOWN and route as ambient context only.
 *  - "unverified_student_speech" — within capability, but the student is
 *    limited-verbal and there is no positive evidence (fresh voice match) that
 *    they spoke. Keep the tentative attribution visible, but as ambient
 *    context — never a user turn the Speaker answers as the student's words.
 *  - null — no demotion (full user-turn standing).
 *
 * Students with unspecified or `fluent` ability keep the status quo: speech
 * may genuinely be their main channel and voice enrollment can't be assumed,
 * so absence of evidence must not silence them.
 */
export type TranscriptDemotion = "impossible_speech" | "unverified_student_speech";

export function assessStudentTranscript(opts: {
  text: string;
  ability: VerbalAbility | null | undefined;
  hasVoiceEvidence: boolean;
}): TranscriptDemotion | null {
  const { text, ability, hasVoiceEvidence } = opts;
  if (!isVerbalAbility(ability)) return null;
  if (utteranceExceedsVerbalAbility(text, ability)) return "impossible_speech";
  if (ability !== "fluent" && !hasVoiceEvidence) return "unverified_student_speech";
  return null;
}
