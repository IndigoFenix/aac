// shared/world-engine/interaction/dialogue/intent-lines.ts
//
// INTENT ANNOUNCEMENTS (city-expansion phase ①a §3) — a creature STATES what
// it is about to do BEFORE doing it ("I'll get the wood"), rendered through
// the ordinary creature speech surface (bubble + TTS via the shared game lang
// layer — never client i18n). Two pieces:
//
//   • goalIntentLine — GoalSpec → the leveled glyph line, built on the same
//     phrase() machinery every other creature utterance uses. Verbs outside
//     the lang layer's frame vocabulary degrade to the telegraphic gloss by
//     design (lang/core.ts) — never silence, never a crash.
//   • the CRITERIA HOOK — ONE predicate deciding whether a given act
//     announces. Deliberately conservative by default: announce when CLAIMING
//     a pooled task; stay quiet for routine self-directed behavior. The
//     criteria get tuned later — the PATH is what ships now.
//
// Issuer/source-agnostic: the context carries WHY the creature is about to
// act (a pooled-task claim, a direct command, its own need, a standing rule),
// so richer criteria later need no new plumbing.

import { phrase, type LeveledGlyphs } from "./dialogue-gen.js";
import type { CreatureId } from "../behavior/creatures.js";
import type { GoalSpec, ItemRef, PlaceRef } from "../behavior/rules.js";

/** Symbol resolvers the pure layer can't own (the world names things). The
 *  creature resolver arrives deixis-ready: the caller maps the LISTENER of the
 *  announcement to "you" and third parties to their creature symbol. */
export interface IntentLineSyms {
  item(ref: ItemRef): string;
  place(place: PlaceRef): string;
  creature(id: CreatureId): string;
}

/** The "{I'll} {do the thing}" line for a goal, or null when the goal has no
 *  speakable shape. Levels follow phrase(): a = the key slot, c = the full
 *  first-person sentence. */
export function goalIntentLine(goal: GoalSpec, syms: IntentLineSyms): LeveledGlyphs | null {
  switch (goal.kind) {
    case "fetch":
      return phrase({ subject: "i_me", verb: "get", object: syms.item(goal.item) });
    case "give":
      return phrase({
        subject: "i_me",
        verb: "give",
        object: syms.item(goal.item),
        tail: { join: "to", symbol: syms.creature(goal.to) },
      });
    case "putIn":
      return phrase({
        subject: "i_me",
        verb: "put",
        object: syms.item(goal.item),
        tail: { join: "in", symbol: syms.place(goal.container) },
      });
    case "place":
      return phrase({ subject: "i_me", verb: "put", object: syms.item(goal.item) });
    case "drop":
      return phrase({ subject: "i_me", verb: "drop", object: syms.item(goal.item) });
    case "goTo": {
      const dest = syms.place(goal.place);
      return { a: dest, b: `go + ${dest}`, c: `i_me + go + to + ${dest}` };
    }
    case "goHome":
      // The same shape as the "where are you going?" answer (goingLine).
      return { a: "home", b: "go + home", c: "i_me + go + home" };
    case "follow": {
      const who = syms.creature(goal.target);
      return { a: who, b: `follow + ${who}`, c: `i_me + follow + ${who}` };
    }
    case "stay":
      return { a: "stay", b: "i_me + stay", c: "i_me + stay" };
    case "toggle": {
      const dev = syms.item(goal.device);
      return { a: goal.state, b: `${dev} + ${goal.state}`, c: `i_me + ${goal.state} + ${dev}` };
    }
    case "transform": {
      const thing = syms.item(goal.item);
      return { a: goal.state, b: `${thing} + ${goal.state}`, c: `i_me + make + ${thing} + ${goal.state}` };
    }
    case "satisfy":
      return { a: goal.need, b: `i_me + ${goal.need}`, c: `i_me + ${goal.need}` };
    case "rest": {
      // "I'll rest at the bed" — the station is the teaching point (level a).
      const where = syms.place(goal.place);
      return { a: where, b: `rest + ${where}`, c: `i_me + rest + ${where}` };
    }
    case "setOpen": {
      // "I'll open the chest" — the container is the teaching point (level a).
      const where = syms.place(goal.place);
      const verb = goal.open ? "open" : "shut";
      return { a: where, b: `${verb} + ${where}`, c: `i_me + ${verb} + ${where}` };
    }
    case "wear": {
      // "I'll wear the shirt" — the garment is the teaching point (level a).
      const g = syms.item(goal.item);
      return { a: g, b: `wear + ${g}`, c: `i_me + wear + ${g}` };
    }
    case "converse": {
      // "I'll talk to Mara" — the partner is the teaching point (level a).
      const who = syms.creature(goal.target);
      return { a: who, b: `talk + ${who}`, c: `i_me + talk + to + ${who}` };
    }
    case "consume": {
      // "I'll eat the banana" — the named item is the teaching point (level a).
      const thing = syms.item(goal.item);
      return { a: thing, b: `eat + ${thing}`, c: `i_me + eat + ${thing}` };
    }
    case "socialAct":
      return phrase({ subject: "i_me", verb: goal.act, object: syms.creature(goal.target) });
    case "help":
      return phrase({ subject: "i_me", verb: "help", object: syms.creature(goal.target) });
    case "build": {
      // The structure rides the line ("I'll build the house") — "town" is
      // the bare founding order's default and stays the plain "build".
      if (goal.structure && goal.structure !== "town") {
        return phrase({ subject: "i_me", verb: "build", object: goal.structure });
      }
      return { a: "build", b: "i_me + build", c: "i_me + build" };
    }
    case "area":
      // A charter (③) is the ISSUER's instant act — host-written the moment
      // it's spoken, never pooled or claimed, so no creature ever announces
      // it (the "ok" confirmation is the accepting clerk's, host-side).
      return null;
    case "trade":
      // Intercity barter (⑤) is town policy, host-committed like a charter —
      // the TERMS line ("3 wood for 2 food") is the accepting clerk's,
      // host-side (barter-lines.ts); no creature claims or announces it.
      return null;
    case "transfer": {
      // A stock haul (city-expansion ②): the goods + destination ride the
      // goal, so the line phrases without the ledger — "I'll give the wood
      // to Mara" / "I'll put the wood in the yard".
      const heads = Object.keys(goal.goods).map((g) => g.split(".")[0] ?? g);
      const obj = heads[0] ?? "thing";
      const toCreature = goal.to.kind === "creature";
      // A creature recipient resolves deixis-ready ("you"/its symbol); a
      // place destination through the place resolver ("yard", "house").
      const dest = toCreature && goal.to.kind === "creature" ? syms.creature(goal.to.id) : syms.place(goal.to);
      return phrase({
        subject: "i_me",
        verb: toCreature ? "give" : "put",
        object: obj,
        tail: { join: toCreature ? "to" : "in", symbol: dest },
      });
    }
  }
}

/** WHY a creature is about to act — the announcement gate's whole input. */
export interface AnnounceContext {
  creatureId: CreatureId;
  goal: GoalSpec;
  /** What put the goal in its hands: a pooled-task claim, a direct command,
   *  its own need machinery, or a standing rule. */
  source: "task-claim" | "command" | "need" | "rule";
  /** Pooled-task metadata, when source === "task-claim". */
  taskId?: string;
  /** Who the act is ultimately FOR (task issuer / command speaker) — a
   *  creature id; the player is one creature among many. */
  issuer?: CreatureId;
}

/** THE criteria hook — one predicate, swapped/tuned later. */
export type AnnounceCriteria = (ctx: AnnounceContext) => boolean;

/** Conservative default: announce when claiming a pooled task (the issuer
 *  can't otherwise see WHO took the order); stay quiet for routine
 *  self-directed behavior and direct commands (those already confirm "ok"). */
export const defaultAnnounceCriteria: AnnounceCriteria = (ctx) => ctx.source === "task-claim";
