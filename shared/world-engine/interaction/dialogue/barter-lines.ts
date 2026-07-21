/**
 * barter-lines.ts — WHAT THE CLERK SAYS about an intercity barter deal
 * (city-expansion ⑤). The confirmation SPEAKS THE TERMS: the reserved-"ok"
 * flow states the ratio itself ("ok — 3 wood for 2 food"), because hearing
 * DIFFERENT terms as scarcities shift IS the economics lesson. Refusals are
 * honest and named in the established vocabulary:
 *
 *   has-enough — "they have many wood"   (the partner doesn't want it)
 *   wont-part  — "they don't give food"  (the partner's own famine)
 *
 * Built entirely on EXISTING glyphs (ok/they/have/give.not/for + the
 * quantity words one/two/three) so every lang ruleset renders each locale —
 * shared game lang layer, never client i18n. NO CURRENCY WORDS EXIST here
 * by design: a quote is goods for goods.
 */

import { phrase, type LeveledGlyphs } from "./dialogue-gen.js";

/** A speakable count (1..3) as its quantity glyph — the barter quote's
 *  whole number range (barter.ts caps quotes inside it). */
export function quantityGlyph(n: number): string {
  return n <= 1 ? "one" : n === 2 ? "two" : "three";
}

/** The TERMS, spoken on acceptance — the reserved "ok" carries the quote:
 *  "ok — [give N] wood for [take N] food". Level a stays the bare ok (an
 *  accepted order); b speaks the exchange; c the full confirmation. */
export function barterTermsLine(
  quote: { give: number; take: number },
  giveGlyph: string,
  takeGlyph: string,
): LeveledGlyphs {
  const deal = `${quantityGlyph(quote.give)} + ${giveGlyph} + for + ${quantityGlyph(quote.take)} + ${takeGlyph}`;
  return { a: "ok", b: deal, c: `ok + ${deal}` };
}

/** Refusal: the partner has no need of our give-good ("they have enough
 *  wood") — "they + have + more + wood".
 *
 *  The quantifier is `more`, not `many`: `more` is the one the engine
 *  actually MODELS (core.ts peels it off as `NP.more`, and it is half of
 *  the more/less comparative pair the market remarks already speak).
 *  `many` has no POS entry, so a sentence containing it never built a
 *  frame — this shipped line fell all the way to the raw gloss fallback in
 *  every locale (nations P6: if it cannot be said, it is not legible). */
export function barterHasEnoughLine(giveGlyph: string): LeveledGlyphs {
  return phrase({
    subject: "they",
    verb: "have",
    object: `more + ${giveGlyph}`,
    key: "no",
    b: `they + have + ${giveGlyph}`,
  });
}

/** Refusal: the partner won't part with the take-good (its own famine) —
 *  "they + give.not + food". */
export function barterWontPartLine(takeGlyph: string): LeveledGlyphs {
  return phrase({
    subject: "they",
    verb: "give.not",
    object: takeGlyph,
    key: "no",
    b: `give.not + ${takeGlyph}`,
  });
}

/** One dispatcher for the willingness verdict → the refusal line. */
export function barterRefusalLine(
  reason: "has-enough" | "wont-part",
  giveGlyph: string,
  takeGlyph: string,
): LeveledGlyphs {
  return reason === "wont-part" ? barterWontPartLine(takeGlyph) : barterHasEnoughLine(giveGlyph);
}
