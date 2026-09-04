// shared/aac/builder-speech.ts
//
// CAN THE DEVICE SAY THIS SENTENCE ITSELF?
//
// The sentence builder composes a glyph string, and until now EVERY Play went
// to the model: `glyph_press` → BoardManager `interpret()` → the interpreted
// sentence comes back → student TTS voices it. Seconds, a model call, and a
// spinner on the Play button — for "i_me + want + apple", a sentence the glyph
// language already renders exactly, in the child's own locale, for free.
//
// This module is the GATE in front of that shortcut, and every rule in it is a
// way the shortcut could put a wrong sentence in a child's mouth:
//
//   1. THE LOCALE MUST HAVE ITS OWN RULESET. Only en/he/es/pt ship one;
//      `languageFor` falls back to English for the other seven app locales, so
//      rendering here would say an English sentence to a Russian-speaking
//      child. The model speaks their language — let it.
//   2. EVERY WORD MUST BE IN THAT RULESET'S LEXICON. `baseWord` falls back to
//      the raw glyph head, and a head IS an English word, so a missing lexeme
//      does not fail — it quietly says "apple" in the middle of a Hebrew
//      sentence. (This is the failure `npm run validate-builder-lexicon`
//      exists to catch; here it is a per-sentence check, because a board can
//      carry a word the validator's reachable set doesn't.) A `face:<id>`
//      person key and a payload-carrying head (`number(3)`) fail this test
//      too, which is exactly right — neither is a word the lexicon knows.
//   3. THE PARSE MUST BE A SENTENCE. `classify` returns `gloss` when it
//      recognizes no frame, and a gloss is word salad in glyph order ("apple
//      want I") — worse than what the model would have written. A whole-
//      sentence `fixed` override counts as recognized: that IS the ruleset
//      saying it knows this one.
//
// Anything that fails falls through to the interpret path unchanged, so the
// worst case is today's behaviour.

import {
  classify,
  hasGlyphRuleset,
  isUnspokenMod,
  languageFor,
  normalize,
  parseSentence,
  translateGlyph,
  type Gender,
  type GlyphLanguage,
  type Token,
} from "../world-engine/interaction/lang/index.js";

/** Negation is spoken by the ruleset's own word, never by a lexeme lookup on
 *  the modifier — every ruleset has one, so it never blocks the fast path. */
const NEGATION_MOD = "not";

function lexiconHas(lang: GlyphLanguage, symbol: string): boolean {
  return Object.prototype.hasOwnProperty.call(lang.lexicon, symbol);
}

/** Every word this token would put in the sentence is one the ruleset knows. */
function tokenIsSpeakable(lang: GlyphLanguage, token: Token): boolean {
  if (!lexiconHas(lang, token.head)) return false;
  return token.mods.every(
    (mod) => mod === NEGATION_MOD || isUnspokenMod(mod) || lexiconHas(lang, mod),
  );
}

export interface ComposedSentenceOptions {
  /** The student's locale — the sentence is rendered in it or not at all. */
  locale: string | undefined;
  /**
   * The student's grammatical gender, for agreeing languages ("אני הולך" vs
   * "אני הולכת"). Defaults to masculine, matching every other unset-gender
   * path in the app.
   */
  gender?: Gender;
}

/**
 * The sentence the device can say for this composed glyph, or `null` when it
 * must go to the model instead.
 *
 * `firstPerson` is the AAC's whole situation: a subject-less "give + ball" is
 * the STUDENT offering ("I'll give you the ball"), never the imperative a
 * creature would mean by it.
 */
export function renderComposedSentence(
  glyph: string,
  opts: ComposedSentenceOptions,
): string | null {
  const text = glyph.trim();
  if (!text) return null;
  if (!hasGlyphRuleset(opts.locale)) return null;

  const lang = languageFor(opts.locale);
  const tokens = parseSentence(text);
  if (tokens.length === 0) return null;
  if (!tokens.every((t) => tokenIsSpeakable(lang, t))) return null;

  const known = Object.prototype.hasOwnProperty.call(lang.fixed, normalize(tokens));
  if (!known && classify(tokens).kind === "gloss") return null;

  const spoken = translateGlyph(text, opts.locale, {
    firstPerson: true,
    speaker: opts.gender ?? "m",
  }).trim();
  return spoken || null;
}

/** The student's grammatical gender from the profile field, for the renderer.
 *  One place, because "female" is the only spelling the students table uses and
 *  every caller getting that wrong would silently mis-conjugate every sentence. */
export function studentGender(gender: string | null | undefined): Gender {
  return gender === "female" ? "f" : "m";
}
