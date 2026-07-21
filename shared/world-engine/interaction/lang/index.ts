// shared/world-engine/interaction/lang/index.ts
//
//   translateGlyph("i_me + want + apple", "he")          → "אני רוצה תפוח."
//   translateGlyph("i_me + give + ball", "he",
//                  { speaker: speakerGender("frog","he") }) → "אני נותנת את הכדור."
//
// Shipped rulesets: en · he · es · pt (es/pt stem from one shared romance
// ruleset). Other app locales (fr, de, ru, ko, zh, yue, ar) are DEFERRED —
// each needs rules that are not a minimal modification of the shipped ones
// (elision/case systems/SOV particles/classifiers) — and fall back to English.

import { en } from "./en.js";
import { he } from "./he.js";
import { es } from "./es.js";
import { pt } from "./pt.js";
import {
  directionsFrame,
  genderOf,
  NO_NAMES,
  translateWith,
  type DirCardinal,
  type DirProximity,
  type GlyphLanguage,
  type SpeakOpts,
} from "./core.js";

export type { GlyphLanguage, SpeakOpts, Lexeme, Frame, Token, Gender, DirProximity, DirCardinal } from "./core.js";
export { parseSentence, classify, normalize } from "./core.js";
export { en } from "./en.js";
export { he } from "./he.js";
export { es } from "./es.js";
export { pt } from "./pt.js";

const LANGUAGES: Record<string, GlyphLanguage> = { en, he, es, pt };

/** Resolve a BCP-47 locale ("he-IL", "pt-BR") to a shipped ruleset; en fallback. */
export function languageFor(locale: string | undefined): GlyphLanguage {
  const primary = (locale ?? "en").toLowerCase().split(/[-_]/)[0]!;
  return LANGUAGES[primary] ?? en;
}

/** Translate one glyph SENTENCE into the locale's proper spoken text. */
export function translateGlyph(glyph: string, locale: string | undefined, opts?: SpeakOpts): string {
  return translateWith(languageFor(locale), glyph, opts);
}

/**
 * Speak the "asking for directions" answer in the locale: a thing GLYPH
 * ("home.color_blue", "toy") + the proximity + cardinal resolved by the host
 * from town geometry (symbol-game/directions.ts) → "The blue house is far, to
 * the north." The cardinal is only voiced by the close/far phrases.
 */
export function speakDirections(
  thingGlyph: string,
  proximity: DirProximity,
  cardinal: DirCardinal,
  locale: string | undefined,
  opts?: SpeakOpts,
): string {
  const lang = languageFor(locale);
  return lang.render(directionsFrame(thingGlyph, proximity, cardinal), {
    speaker: opts?.speaker ?? "m",
    addressee: opts?.addressee ?? "m",
    firstPerson: opts?.firstPerson ?? false,
    names: opts?.names ?? NO_NAMES,
  });
}

/** Grammatical gender the locale assigns to a speaker's creature symbol —
 *  feeds `opts.speaker` so a צפרדע says "אני נותנת", not "נותן". */
export function speakerGender(symbol: string | undefined, locale: string | undefined) {
  return genderOf(languageFor(locale), symbol);
}
