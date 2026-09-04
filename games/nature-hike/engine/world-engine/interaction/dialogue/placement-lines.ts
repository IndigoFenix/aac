/**
 * placement-lines.ts — WHAT A CREATURE SAYS about a directed placement
 * (construction v1). Every verdict of the placement gate SPEAKS (silence
 * must be explicit), in the established glyph-first forms:
 *
 *   cannot  — "i_me + put.not + {thing} + because + place + small"
 *             ("I can't put the chair there because the place is small")
 *             with the mine frame for a stranger's house and the vendor's
 *             noStock for a piece nobody has.
 *   wont    — "i_me + want.not + put + because + place + good.not"
 *             ("I don't want to put it because the place is not good")
 *   ok      — "ok", then "{thing} + here" on completion (the clue form).
 *
 * Built entirely on dialogue-gen's phrase machinery and EXISTING glyphs
 * (place/small/good/no/home.my) — the lang rulesets render each locale;
 * the one new word is the `put` verb itself.
 */

import {
  causalPhrase,
  noStock,
  phrase,
  type LeveledGlyphs,
} from "./dialogue-gen.js";
import type { PlaceResponse } from "@shared/world-engine/interaction/behavior/placement-will.js";

/** "I cannot — because …". `thing` is the piece's spoken symbol. */
export function placementCannotLine(
  thing: string,
  reason: Extract<PlaceResponse, { kind: "cannot" }>["reason"],
): LeveledGlyphs {
  if (reason === "have-not") return noStock(thing);
  if (reason === "not-mine") {
    // The mine frame — "no, my house" (the same shape as a bound keepsake).
    return { a: "no", b: "no + home.my", c: "no + home.my" };
  }
  // Every geometric impossibility reads as the room being too small for
  // it — honest at the child's level ("no room for the chair").
  return causalPhrase(
    { subject: "i_me", verb: "put.not", object: thing },
    "because",
    { subject: "place", verb: "small", key: "small" },
  );
}

/** "I don't want to — because the place is not good." */
export function placementWontLine(): LeveledGlyphs {
  return causalPhrase(
    { subject: "i_me", verb: "want.not", object: "put" },
    "because",
    { subject: "place", verb: "good.not", key: "good.not" },
  );
}

/** The acceptance ("ok") — obliging or natural, the creature agrees. */
export const PLACEMENT_OK: LeveledGlyphs = { a: "ok", b: "ok", c: "ok" };

/** Completion — the piece stands: "{thing} + here" (the clue form). */
export function placementDoneLine(thing: string): LeveledGlyphs {
  return { a: "here", b: `${thing} + here`, c: `${thing} + here` };
}

/** The ZONING refusal (city-expansion ③, "that's farmland"): the only
 *  ground left is chartered for another category — a WONT-shaped block
 *  (the charter is policy, not geometry), with the zone's category NAMED:
 *  "i_me + put.not + {thing} + because + place + {category}"
 *  ("I can't put the house because the place is farm[land]"). */
export function zoneRefusalLine(thing: string, category: string): LeveledGlyphs {
  return causalPhrase(
    { subject: "i_me", verb: "put.not", object: thing },
    "because",
    { subject: "place", verb: category, key: category },
  );
}

/** ⚖️ THE FELLING PREREQUISITE, SPOKEN (user ruling 2026-09-02: *"if a tree
 *  is in the way of a construction, making felling that tree a required task
 *  that is assigned automatically as a prerequisite"*).
 *
 *  This is NOT a refusal and must not be built out of one: the order stands,
 *  the work is staked, and what the builder is saying is WHY NOTHING IS
 *  HAPPENING YET. So it borrows `zoneRefusalLine`'s shape — the cause clause
 *  NAMES THE BLOCKING NOUN — with the presence fact as its cause:
 *  "i_me + put.not + {thing} + because + {blocker} + here" ("I can't put the
 *  house yet because there's a tree here"). Both symbols are the caller's to
 *  resolve (the structure's glyph, the standing source's word), exactly as
 *  the zoning line takes its category. */
export function clearFirstLine(thing: string, blocker: string): LeveledGlyphs {
  return causalPhrase(
    { subject: "i_me", verb: "put.not", object: thing },
    "because",
    { subject: blocker, verb: "here", key: "here" },
  );
}

/** One dispatcher for the gate's verdict → the line to speak (the caller
 *  resolves the thing's spoken symbol). Null = accepted (speak
 *  PLACEMENT_OK and run the errand). */
export function placementVerdictLine(thing: string, r: PlaceResponse): LeveledGlyphs | null {
  if (r.kind === "cannot") return placementCannotLine(thing, r.reason);
  if (r.kind === "wont") return placementWontLine();
  return null;
}

// Re-exported so the quest-host branch needs one import site.
export { phrase };
