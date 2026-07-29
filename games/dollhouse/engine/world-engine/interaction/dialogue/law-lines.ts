/**
 * law-lines.ts — the spoken face of LAWS (nations P2, behavior/laws.ts).
 *
 * A taboo refusal is CULTURAL, so the subject is "we" — the creature isn't
 * declining a chore, it is stating who its people are: "we do not fight."
 * Named, never confused (the named-refusal discipline): a forbidden
 * command must land differently from a not-understood one.
 */

import { phrase, type LeveledGlyphs } from "./dialogue-gen.js";

/** "we + <verb>.not" — the taboo/law refusal ("we do not fight"). */
export function tabooRefusalLine(verb: string): LeveledGlyphs {
  return phrase({ subject: "we", verb: `${verb}.not`, key: "no" });
}

/**
 * "we + <verb>.not + together" — the world holds NO GATHERING for this
 * activity ("we do not sleep together"). The same CULTURAL "we" the taboo
 * refusal speaks, and for the same reason: this is not one creature declining,
 * it is a statement about what these people do. The activity itself is NOT
 * refused — the ordinary solo order lands and the sleeping happens; only the
 * togetherness has nowhere to go.
 *
 * Level a is `together`, deliberately: the child tapped that word, so that is
 * the word the answer teaches back. Gated by `VoicePolicy.inertCompany`
 * (voice-policy.ts) — whether an unhonored marker speaks at all is an audience
 * decision, not a phrasing one.
 */
export function noGatheringLine(verb: string): LeveledGlyphs {
  return {
    a: "together",
    b: `${verb}.not + together`,
    c: `we + ${verb}.not + together`,
  };
}

/** "ok + no + <verb>" is too clever; the law-installed confirmation keeps
 *  the reserved "ok" (accepted orders) and lets the toast carry detail. */
export const LAW_ACCEPTED = "ok";
