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
 * render (`place`, `good.not`, `have.not`, `understand.not`, `ok`, `no`,
 * `person`, `here.not`).
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

/**
 * ⚖️ P-3 — "THERE IS NOBODY HERE." The sentence was well formed, it mapped to a
 * real conversational move, and the ONE precondition every addressed act has
 * was missing: somebody to address. That is not the same verdict as "I don't
 * understand", and answering it with that one teaches the child their sentence
 * was WRONG — the most expensive possible lie, because the sentence was right
 * and the room was empty. An act aimed at nobody is a DIFFERENT act, so it gets
 * a different answer (group-activity-syntax §7: explicit not-understood over a
 * silent drop, a NAMED refusal over a misleading "ok").
 *
 * Nobody can speak it, by definition — the host puts it on the feedback surface
 * the way `speakNotUnderstood` already does when there is no mouth for a line.
 *
 * ⚠️ VOCABULARY DISCIPLINE, twice over. NO NEW WORD: `person` and `here` are
 * both shipped glyphs with lexemes in all four rulesets, so this needed nothing
 * from the registry or the eleven locales. And the `.not` is real — the `here`
 * frame used to DROP it in silence and render the positive ("The ball is
 * here."), which is fixed in `lang/core.ts` alongside this line. Renders:
 *   en "The person is not here."   he "האדם לא כאן."
 *   es "La persona no está aquí."  pt "A pessoa não está aqui."
 */
export const NOBODY_HERE: LeveledGlyphs = phrase({
  subject: "person",
  verb: "here.not",
  key: "no",
});

/**
 * ⚖️ L-2 — THE UNWILLING REFUSAL ("I won't help you"). The order was UNDERSTOOD
 * and there is nothing wrong with the place: this body simply does not take
 * orders from that author yet. That is a different verdict from `CANT_HERE`
 * (whose own docblock says it is "not refused out of unwillingness") and from
 * `WHO_DO_YOU_MEAN` (a missing target), and the named-refusal discipline says
 * the three must land differently.
 *
 * ⚠️ NOT A NEW FRAME. It is `creature-dialogue.ts`'s shipped `refuseGlyph(null)`
 * — "i_me + help.not + you", key "no" — which is already render-checked in all
 * four rulesets as the answer to a request this creature will not grant. The
 * spec is repeated here rather than exported across the layer boundary because
 * this module is where the HOST's own verdicts speak from; if a third caller
 * ever appears, that is the moment to make one of them import the other.
 */
export const WONT_HELP_YOU: LeveledGlyphs = phrase({
  subject: "i_me",
  verb: "help.not",
  object: "you",
  key: "no",
});

/**
 * ⚖️ W2-4/W2-5 — THE NO-BOND REFUSAL: "You are not the leader."
 *
 * A SPOKEN order to a body that does not take orders from this author. The
 * verdict is the same one `attendTo`'s press gate reaches (`bondStrength <
 * VOLUNTEER_COMPLIANCE`), but the SENTENCE names the missing precondition
 * instead of the consequence — and it names it in the child's own vocabulary,
 * as the EXACT INVERSE of the yield sentence the child already builds
 * ("you + leader" makes somebody your leader; "you + leader.not" is the answer
 * when they are not yours). One word, negated, teaches the whole rule.
 *
 * ⚠️ NO NEW WORD. `you` and `leader` both ship in all four rulesets, and the
 * `.not` on a ROLE is B2's `neg` regard frame — which exists precisely because
 * `leader` is a NOUN and the corrective frame could not dress it. Renders:
 *   en "You are not the leader."      he "אתה לא המנהיג." / "את לא המנהיגה."
 *   es "No eres el líder."            pt "Você não é o líder."
 * (The Hebrew agrees with the ADDRESSEE's gender, like every other line here.)
 *
 * DISTINCT FROM `WONT_HELP_YOU`, which stays exactly where it is: that one is
 * spoken by the PRESS gate and says what the body will not do; this one says
 * WHY, which is the half a spoken sentence can carry and a press cannot.
 */
export const NO_BOND: LeveledGlyphs = phrase({
  subject: "you",
  verb: "leader.not",
  key: "no",
});

/**
 * ⚖️ A PRECONDITION IS THE REPLY (semantic-behavior §6) — "I don't eat."
 *
 * `stop + eat` COMPILES to a plain halt and ASSUMES one thing: that the body is
 * eating. When it is not, the halt lands on nothing and the child hears either
 * silence or a misleading confirmation. The assumption the compiler recorded
 * (`Precondition {kind:"doing", verb}`) is exactly the sentence worth saying, so
 * the failed precondition IS the answer rather than an error behind it.
 *
 * ⚠️ NO NEW WORD, TWICE OVER: `i_me` ships everywhere, and the VERB is the one
 * the child just said — a word already on their board by construction. The shape
 * is `ACTIVITY_REFUSAL`'s (`i_me + {state}.not`) with the ACTIVITY in the slot,
 * because the claim being denied here is the activity, not the appetite.
 *
 * Renders (verb `eat`): en "I don't eat." · he "אני לא אוכל." / "אני לא אוכלת."
 * · es "No como." · pt "Eu não como." — English alone reads habitual rather
 * than progressive; the other three carry both readings in one form.
 */
export function notDoingLine(verb: string): LeveledGlyphs {
  return phrase({ subject: "i_me", verb: `${verb}.not`, key: "no" });
}

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
