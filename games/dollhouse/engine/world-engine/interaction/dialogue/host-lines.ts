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

import { causalPhrase, noStock, phrase, type LeveledGlyphs } from "./dialogue-gen.js";
import type { NaturalSourceKind } from "@shared/world-engine/products.js";

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

/**
 * WHAT TO CALL A NATURAL SOURCE OUT LOUD — its KIND, never its species. Null =
 * there is no word, and the caller must fall back to a line that names nothing
 * rather than invent one.
 *
 * 🚨 A SPECIES ID IS NOT A SPOKEN WORD (CLAUDE.md's silent-lexicon trap). `oak`
 * and `grape_vine` have a lexeme in no ruleset on earth, so naming the species
 * would put an English word on a Hebrew board while looking perfect in English.
 * `plants` and `animal` are lexicalized in all four shipped rulesets, and a
 * kind is the right altitude anyway: the fact being reported is "something is
 * growing there", not which species. Minerals have no lexeme of any kind,
 * which is why null is a real answer.
 *
 * ONE OWNER — the builder's blocked-lot line and the take refusal both read it,
 * so the two can never name the same standing thing two different ways.
 */
export function sourceKindWord(kind: NaturalSourceKind | undefined): string | null {
  if (kind === "plant") return "plants";
  if (kind === "animal") return "animal";
  return null;
}

/**
 * ⚖️ THE FELL-FIRST REFUSAL, SPOKEN (user ruling 2026-09-02: *"harvesting kill
 * products without killing the plant should not be possible"*). A hand reaching
 * into a LIVING tree for its timber is turned away, and this is what it is
 * turned away WITH — the line a child hits constantly, which was shipped as the
 * bare English toast `"cut it down first"` and so bypassed the lexicon entirely.
 *
 * The take-side twin of `placement-lines.ts clearFirstLine`, and deliberately
 * the same two-clause shape: the EFFECT is the take that cannot happen, the
 * CAUSE names the standing thing —
 * "i_me + take.not + {thing} + because + {blocker} + here"
 * ("I can't take the wood because there's a plant here"). The remedy is the
 * `cut` button on the very board this refuses from, so the line reports the
 * state and the board offers the act; neither has to carry both.
 *
 * ⚠️ Both symbols are the CALLER'S to resolve — the stack's own glyph, and
 * `sourceKindWord`'s answer for the blocker. Every head here is one all four
 * shipped rulesets already render.
 */
export function cutFirstLine(thing: string, blocker: string): LeveledGlyphs {
  return causalPhrase(
    { subject: "i_me", verb: "take.not", object: thing },
    "because",
    { subject: blocker, verb: "here", key: "here" },
  );
}
