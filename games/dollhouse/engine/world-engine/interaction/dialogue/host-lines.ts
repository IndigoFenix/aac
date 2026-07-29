/**
 * host-lines.ts — WHAT A CREATURE SAYS about a HOST-LEVEL verdict.
 *
 * The law (outstanding-bugs-family-mode.md): *"No direct question should
 * produce UI messages alone. They should produce responses from the creature;
 * if they can't do something, they should say why."* The audience may not be
 * able to READ — a DOM banner is not an answer to a child who asked a question.
 *
 * The host used to answer a spoken order with an English toast ("can't do that
 * here", "no one to trade with here", "look at a family member first"). Those
 * reasons were real; they were addressed to nobody. This module gives them
 * GLYPH lines so the addressed creature SPEAKS them and the lang rulesets
 * render each locale — the move `placement-lines.ts` made for the placement
 * gate, applied to the host's own verdicts.
 *
 * ⚠️ VOCABULARY DISCIPLINE: every glyph here is one the rulesets already
 * render (`place`, `good.not`, `have.not`, `understand.not`, `ok`, `no`).
 * A line built from a word no ruleset knows is WORSE than the toast it
 * replaced — it comes out as raw glyph soup in the child's ear. New words go
 * into en/es/he/pt (and core.ts's part-of-speech table) FIRST.
 */

import { noStock, phrase, type LeveledGlyphs } from "./dialogue-gen.js";

/** "The place is not good." — the general host refusal: the order was
 *  understood and is not refused out of unwillingness, there is simply nothing
 *  HERE to act on (no focus area, no site, no partner). Deliberately the same
 *  cause-glyph the placement gate already speaks for an impossible spot, so
 *  the child hears one consistent "not here" across every system.
 *
 *  Not "never" — "not in this place", which is the truth and the actionable
 *  half. */
export const CANT_HERE: LeveledGlyphs = phrase({
  subject: "place",
  verb: "good.not",
  key: "good.not",
});

/** The order needs a TARGET the player hasn't picked — "you help …" with
 *  nobody addressed, "put …" with no one looked at. The creature's honest
 *  state is that it does not know WHO is meant, which is exactly the shipped
 *  not-understood line (`creature-dialogue.ts` NOT_UNDERSTOOD_LINE's form). */
export const WHO_DO_YOU_MEAN: LeveledGlyphs = phrase({
  subject: "i_me",
  verb: "understand.not",
  key: "understand.not",
});

/** A specific ITEM is missing ("nothing to give"): the vendor's shipped
 *  have-not frame, reused.
 *
 *  ⚠️ Only ever pass a concrete THING glyph. Abstractions render as nonsense —
 *  `nothingHere("trade")` came out as Spanish "No tengo el cambio" ("I don't
 *  have the CHANGE/coins"), which is why the no-trade-partner case speaks
 *  CANT_HERE instead. Render-check any new argument in all four rulesets. */
export function nothingHere(thing: string): LeveledGlyphs {
  return noStock(thing);
}

/** The accepted order — the reserved "ok" (response-semantics ①a §1: "okay" is
 *  ONLY ever the confirmation of an accepted order, never a generic ack). */
export const ORDER_OK: LeveledGlyphs = { a: "ok", b: "ok", c: "ok" };
