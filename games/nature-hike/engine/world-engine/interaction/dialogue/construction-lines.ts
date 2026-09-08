/**
 * construction-lines.ts — WHAT A CREATURE SAYS ABOUT A BUILDING SITE.
 *
 * Construction produces a handful of FACTS a bystander can act on: a place is
 * short of a material, the world has none of it left, a mill is covering the
 * gap, a shell is finished. Each of those is a different claim about the world,
 * and each therefore needs a glyph shape the frame layer (lang/core.ts) reads
 * as THAT claim and no other. This module is the one place they are written.
 *
 * ⚠️ THE RULE THAT MADE THIS FILE. `{item} + {prep} + {place}` is already
 * TAKEN: verbless, it is the locative assertion — "the ball is in the blue
 * house" (lang/core `pp`). A site's bill announced itself in exactly that shape
 * and came out as "The block is in the kitchen" — a sentence that says the
 * material has ALREADY ARRIVED, which is the precise opposite of a request, and
 * which a child has no way to falsify. A need is a CLAIM ABOUT WANTING and must
 * carry a verb that says so. One shape, one meaning.
 *
 * The shapes, and why each is the one that parses:
 *
 *   needs        "{place} + need + {material}"     → svo: "The kitchen needs
 *                                                    blocks." The place is the
 *                                                    SUBJECT — the bill belongs
 *                                                    to the room, not to
 *                                                    whoever happens to say it.
 *   noSource     "we + have.not + {material}"      → svo, plural: "We don't
 *                                                    have any wood." The
 *                                                    collective voice, because
 *                                                    the claim is about the
 *                                                    whole town's stock, not
 *                                                    the speaker's pockets.
 *   willMake     "i_me + make.will + {material}"   → svo + intent: "I will make
 *                                                    the blocks."
 *   done         "{place} + finished"              → copula: "The house is
 *                                                    finished."
 *
 * Level b keeps the SUBJECT on the fact lines (`bFull`): "need + block" reads
 * as an imperative in English and as a first-person "I need blocks" in the
 * romance rulesets, and neither is what a site's bill means. A fact about a
 * place has to name the place.
 *
 * The delivery/build/craft announcements are NOT here — they are goals, and a
 * goal's line belongs to intent-lines.ts (one table for every verb the world
 * can order). This file carries only what the SITE knows and nobody is being
 * told to do.
 */

import { phrase, type LeveledGlyphs } from "./dialogue-gen.js";

/**
 * A place is short of a material: "The kitchen needs more blocks."
 *
 * `many` pluralizes through the existing `more` quantifier rather than a
 * numeral — a bill is a shopping bag, not arithmetic (the takeUnits precedent),
 * and `more` is core vocabulary in every ruleset while numerals are not.
 */
export function needsMaterialLine(place: string, material: string, many = false): LeveledGlyphs {
  return phrase({
    subject: place,
    verb: "need",
    object: many ? `more + ${material}` : material,
    key: material,
    bFull: true,
  });
}

/**
 * NOTHING ANYWHERE covers the bill: "We don't have any wood."
 *
 * Distinct from `needsMaterialLine` on purpose — "the kitchen needs blocks" and
 * "there are no blocks" are different facts, and the second is the one that
 * tells the player the chain is broken rather than merely slow. Spoken in the
 * collective voice: a creature reporting the town's empty stock is not
 * reporting its own pockets (that is `noStock`, the vendor's line).
 */
export function noSourceLine(material: string): LeveledGlyphs {
  return phrase({ subject: "we", verb: "have.not", object: material, key: material, bFull: true });
}

/**
 * The chain is covering the gap: "I will make the blocks." The mill's answer to
 * a starved bill — the refine order posted instead of a refusal, said out loud
 * so that "nothing is happening" and "something is happening off-screen" don't
 * look alike (silence must be explicit).
 */
export function willMakeLine(material: string, many = false): LeveledGlyphs {
  return phrase({
    subject: "i_me",
    verb: "make.will",
    object: many ? `more + ${material}` : material,
    key: material,
  });
}

/**
 * A structure or room stands: "The house is finished." The copula frame over
 * the `finished` state word (core vocabulary — the AAC registry has drawn it
 * all along), so it agrees in gender and number in every ruleset.
 */
export function structureDoneLine(place: string): LeveledGlyphs {
  return { a: "finished", b: `${place} + finished`, c: `${place} + finished` };
}

/**
 * THE LOAD IS ON THE GROUND HERE: "the blocks are here."
 *
 * ⚖️ 2026-09-06 carry round. A haul whose carrier stalled is ABANDONED — the
 * goods are set down where the body stands rather than landing at a
 * destination it never reached (the "blocks placed from a distance" report).
 * That has to be SAYABLE, because a load sitting in the open is the one thing
 * a watcher can act on: somebody has to come and collect it.
 *
 * THE LOCATIVE ASSERTION IS THE RIGHT SHAPE HERE, and it is the exact shape
 * the header above warns a BILL must never use — for the opposite reason. A
 * bill says "this place wants blocks", which the verbless locative would
 * render as "the block is in the kitchen": a claim the material has already
 * arrived. Here the material HAS arrived, on the ground, at the speaker's
 * feet — so "block + here" is simply true, and it is the one thing that
 * distinguishes an abandoned haul from a delivered one.
 *
 * Built from `here` (core vocabulary — `clueHere`'s own word, in every shipped
 * ruleset) and the KIND WORD of what was set down. No new lexeme.
 */
export function loadSetDownLine(material: string): LeveledGlyphs {
  return { a: "here", b: `${material} + here`, c: `${material} + here` };
}
