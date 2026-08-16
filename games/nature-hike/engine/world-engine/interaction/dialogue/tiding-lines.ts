/**
 * tiding-lines.ts — WHAT THE STREET SAYS ABOUT THE WIDER WORLD
 * (nations arc P6, nations-and-empires.md §8).
 *
 * The arc's law #6: "visible causation is the pedagogy — every macro event
 * must be legible from the street, and speakable on the board." A polity
 * merging, a border closing, a tribute cart leaving are all events at a
 * scale a child standing in a market cannot see. This module is where they
 * become a SENTENCE — the same named-refusal discipline the law gate and
 * the barter clerk already follow.
 *
 * Two rules shape every line here:
 *
 *   1. EXISTING GLYPHS ONLY. A tiding is said with the words already on the
 *      board (we/they/give/have/trade/less/more/food/fight/town/area) so
 *      every shipped lang ruleset renders it and the student can SAY IT
 *      BACK. No macro event gets private vocabulary — if it cannot be said
 *      in the words a child already has, it is not yet legible.
 *   2. CAUSE, NOT ANNOUNCEMENT. The interesting half is never "the embargo
 *      began", it is "there is less food BECAUSE they don't give food" —
 *      so the fuller levels are `causalPhrase` two-clause lines (the
 *      Causation tier). Level a stays the bare new fact, errorless.
 *
 * The COLLECTIVE VOICE ("we", "they") is the register: a polity speaks of
 * itself as its people and of its neighbour as a group — the same
 * we-statement the cultural taboo uses ("we do not fight").
 */

import { causalPhrase, phrase, type LeveledGlyphs } from "./dialogue-gen.js";

/** The macro events the street can currently see and say. Mirrors the
 *  dispute machine's channels (kernel/civ/dual.ts `DisputeChannelId`) plus
 *  the economy's own two (tribute, price). */
export type TidingKind = "blockade" | "union" | "war" | "tribute";

/**
 * BLOCKADE / EMBARGO — the market remark with its reason attached.
 *
 * The bare "less + food" remark already existed (the market comparatives);
 * what P6 adds is the WHY: the shelf is thin because the route stopped.
 * Pairs with `inboundRouteHealth` (kernel/town/barter.ts), which thins the
 * shelf that produces the observation in the first place — the sentence and
 * the world agree because they read the same fact.
 */
export function embargoRemarkLine(goodGlyph: string): LeveledGlyphs {
  return causalPhrase(
    { subject: "less", object: goodGlyph, key: "less" },
    "because",
    // The subject is PINNED at level b: `phrase` would otherwise drop it,
    // and a subject-less negated verb renders first-person ("because I
    // won't give you the food") — the opposite of what happened.
    { subject: "they", verb: "give.not", object: goodGlyph, b: `they + give.not + ${goodGlyph}` },
  );
}

/** UNION — two crowns became one, and the first cart came down a road that
 *  had none.
 *
 *  Deliberately the EMBARGO LINE WITH ONE WORD FLIPPED: more/less is the
 *  comparative pair the market already speaks, so fusion and fission arrive
 *  in the same sentence frame and the contrast itself is the lesson. (It
 *  also avoids a bare intransitive "we + trade", which has its own trade
 *  frame and would fall to the gloss fallback.) */
export function unionLine(goodGlyph: string): LeveledGlyphs {
  return causalPhrase(
    { subject: "more", object: goodGlyph, key: "more" },
    "because",
    { subject: "they", verb: "give", object: goodGlyph, b: `they + give + ${goodGlyph}` },
  );
}

/** WAR on the road — the honest reason a caravan stopped coming, in the
 *  one verb the absolute ring exists to forbid. A world whose culture
 *  taboos violence never reaches this line (the channel is never armed),
 *  which is exactly the point: the vocabulary of war is present but
 *  unreachable, so its absence is a fact about the culture, not a gap. */
export function warLine(goodGlyph: string): LeveledGlyphs {
  return causalPhrase(
    { subject: "less", object: goodGlyph, key: "less" },
    "because",
    // `key` pins level a to the GOOD, not the verb. A bare "fight" glyph
    // renders as an imperative in every language ("Fight." / "Lucho.") —
    // a system whose whole purpose is to make that verb uncommandable must
    // never put it in a child's mouth as an order. Level a is the fact
    // (less food); the verb only appears inside the causal clause.
    { subject: "they", verb: "fight", key: goodGlyph, b: "they + fight" },
  );
}

/**
 * TRIBUTE — the cart that goes one way and does not trade back, stated
 * plainly in the plural: a thing a PEOPLE does, every day.
 *
 * Direction carries the whole meaning, so it is a parameter rather than an
 * assumption: `"out"` is tribute PAID ("we give food" — the household twin
 * is a contribution to the shared pantry); `"in"` is tribute RECEIVED
 * ("they give food" — the allowance flowing the other way, and the shape
 * the shipped standing pull actually has).
 */
export function tributeLine(goodGlyph: string, dir: "in" | "out" = "out"): LeveledGlyphs {
  // The subject is pinned at level b: a subject-less "give + food" is the
  // REQUEST frame ("Give me the food.") — the exact inverse of tribute,
  // which is a thing handed over unasked.
  const subject = dir === "in" ? "they" : "we";
  return phrase({
    subject, verb: "give", object: goodGlyph,
    b: `${subject} + give + ${goodGlyph}`,
  });
}

/** One dispatcher — the host names the event, the module names the words. */
export function tidingLine(kind: TidingKind, goodGlyph: string): LeveledGlyphs {
  switch (kind) {
    case "blockade": return embargoRemarkLine(goodGlyph);
    case "union": return unionLine(goodGlyph);
    case "war": return warLine(goodGlyph);
    case "tribute": return tributeLine(goodGlyph);
  }
}
