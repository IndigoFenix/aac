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

/** "ok + no + <verb>" is too clever; the law-installed confirmation keeps
 *  the reserved "ok" (accepted orders) and lets the toast carry detail. */
export const LAW_ACCEPTED = "ok";
