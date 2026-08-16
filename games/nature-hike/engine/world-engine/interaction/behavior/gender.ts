// shared/world-engine/interaction/behavior/gender.ts
//
// A creature's NATURAL gender — a THIN derived layer (language-expansion.md):
// no field on CreatureState, no schema change. Stable per-cid hash, the same
// convention as personality dials and outfit presets (quest-host fnv1a), so a
// creature keeps its gender across frames, sessions and machines. An authored
// persona hint (npcPersonaSchema.genderHint) overrides the hash.
//
// Today it feeds SPEAKER AGREEMENT (lang SpeakOpts.speaker — a female resident
// says "נותנת", "confundida") in place of the old symbol-derived guess (which
// made every "human" masculine). Later it ties into culture definitions.

import type { Gender } from "../lang/core.js";

export type GenderHint = "male" | "female" | "any";

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The creature's natural gender: authored hint wins, else a stable hash of
 *  its creature id ("any" hints hash too — authored indifference). */
export function genderFor(cid: string, hint?: GenderHint): Gender {
  if (hint === "male") return "m";
  if (hint === "female") return "f";
  return fnv1a(`gender|${cid}`) % 2 === 0 ? "m" : "f";
}
