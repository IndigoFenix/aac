/**
 * barter-lines.ts — WHAT THE CLERK SAYS about an intercity barter deal
 * (city-expansion ⑤). The confirmation SPEAKS THE TERMS: the reserved-"ok"
 * flow states the ratio itself ("ok — 3 wood for 2 food"), because hearing
 * DIFFERENT terms as scarcities shift IS the economics lesson. Refusals are
 * honest and named in the established vocabulary:
 *
 *   has-enough   — "they have many wood"  (the partner doesn't want it)
 *   wont-part    — "they don't give food" (the partner's own famine)
 *   we-wont-part — "we don't give wood"   (OUR own famine — G1's mirror)
 *
 * Built entirely on EXISTING glyphs (ok/they/have/give.not/for + the
 * quantity words one/two/three) so every lang ruleset renders each locale —
 * shared game lang layer, never client i18n. NO CURRENCY WORDS EXIST here
 * by design: a quote is goods for goods.
 */

import { phrase, type LeveledGlyphs } from "./dialogue-gen.js";

/** A quantity as its numeral-glyph token — the exact whole number. The glyph
 *  compositor draws a bare digit key as the constructed numeral (stroke/hand/
 *  wheel), and the language layer speaks it locale-neutrally via its gloss
 *  path. (barter.ts caps quotes to a small whole-number range.) */
export function quantityGlyph(n: number): string {
  return String(Math.max(1, Math.floor(n)));
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

/** ⚖️ G1 — Refusal: WE won't part with the give-good (OUR own famine) —
 *  "we + give.not + wood". The same sentence as the partner's refusal with
 *  the subject swapped, because it is the same law read from our side; the
 *  subject is what tells the child who is hungry, so unlike the partner's
 *  line it survives into level b. Built on shipped glyphs only (`we` is a
 *  registered person glyph, `give.not` the verb the mirror already speaks). */
export function barterWeWontPartLine(giveGlyph: string): LeveledGlyphs {
  return phrase({
    subject: "we",
    verb: "give.not",
    object: giveGlyph,
    key: "no",
    b: `we + give.not + ${giveGlyph}`,
  });
}

/** One dispatcher for the willingness verdict → the refusal line. */
export function barterRefusalLine(
  reason: "has-enough" | "wont-part" | "we-wont-part",
  giveGlyph: string,
  takeGlyph: string,
): LeveledGlyphs {
  if (reason === "wont-part") return barterWontPartLine(takeGlyph);
  if (reason === "we-wont-part") return barterWeWontPartLine(giveGlyph);
  return barterHasEnoughLine(giveGlyph);
}
