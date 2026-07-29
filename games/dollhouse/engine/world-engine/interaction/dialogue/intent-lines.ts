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
import { classify, INTENT_MOD, parseSentence, posOf, type Gender } from "../lang/core.js";
import type { CreatureId } from "../behavior/creatures.js";
import type { GoalSpec, ItemRef, PlaceRef } from "../behavior/rules.js";
import { headOf } from "../../variations.js";
import { spokenMakeable } from "../content/makeable.js";

// ---------------------------------------------------------------------------
// CREATURE REFERENCE resolution — how a speaker NAMES a target creature
// ---------------------------------------------------------------------------

/** The facts a spoken reference is chosen from — supplied by the world (the
 *  quest host resolves species / group / name / gender; the deixis of the
 *  LISTENER is mapped to "you" upstream, before this runs). */
export interface CreatureRef {
  /** Registered species id (creatures/species.ts) — "spark" for the player. */
  species: string;
  /** A spoken proper NAME (lowercased) when the creature has one. */
  name?: string;
  /** Natural gender (behavior/gender.ts) — picks the he/she pronoun. */
  gender: Gender;
  /** The SPECIES word rendered as a common noun ("the frog") — the fallback
   *  when neither a name nor a pronoun applies. Never a deictic. */
  speciesWord: string;
  /** Does the TARGET share the SPEAKER's group (household / party)? Only a
   *  meaningful flag on the target ref. */
  inGroup?: boolean;
}

/**
 * How a `speaker` refers to a `target` creature in a spoken line — the glyph
 * token the lang layer then renders. ONE rule for every verb (talk to / help /
 * follow / give to …), so a creature is never voiced as "the there":
 *   1. its NAME — when it's a named member of the speaker's own group,
 *   2. a gendered PRONOUN (he / she) — when it's the SAME SPECIES as the speaker,
 *   3. its SPECIES word otherwise ("the frog").
 */
export function creatureReferenceGlyph(speaker: CreatureRef, target: CreatureRef): string {
  if (target.name && target.inGroup) return target.name;
  if (target.species === speaker.species) return target.gender === "f" ? "she" : "he";
  return target.speciesWord;
}

/** Symbol resolvers the pure layer can't own (the world names things). The
 *  creature resolver arrives deixis-ready: the caller maps the LISTENER of the
 *  announcement to "you" and third parties to their creature symbol. */
export interface IntentLineSyms {
  item(ref: ItemRef): string;
  place(place: PlaceRef): string;
  creature(id: CreatureId): string;
}

// ---------------------------------------------------------------------------
// The INTENT SYNTAX — "I will …"
// ---------------------------------------------------------------------------

/** Mark one glyph level's first verb with the `.will` intent modifier — the
 *  special syntax for STATEMENTS OF INTENT ("eat + food" is a command shape;
 *  "eat.will + food" reads "I will eat the food", never an imperative). Null
 *  when the level has no verb, or the marked shape would fall back to the
 *  telegraphic gloss (the marker must never degrade a line — better an
 *  unmarked line than "eat will food"). */
function markIntent(level: string): string | null {
  const toks = level.split("+").map((s) => s.trim()).filter(Boolean);
  let marked = false;
  const out = toks.map((t) => {
    if (marked) return t;
    const head = (t.split("#")[0] ?? t).split(".")[0] ?? t;
    if (posOf(head) !== "verb") return t;
    marked = true;
    const hash = t.indexOf("#");
    return hash >= 0 ? `${t.slice(0, hash)}.${INTENT_MOD}${t.slice(hash)}` : `${t}.${INTENT_MOD}`;
  });
  if (!marked) return null;
  const glyph = out.join(" + ");
  if (classify(parseSentence(glyph)).kind === "gloss") return null;
  return glyph;
}

/** A goal line as a STATEMENT OF INTENT: levels b/c carry the `.will` marker
 *  where it renders as grammar (level a stays the bare teaching slot). Used by
 *  every path where a creature states what it is ABOUT to do — announcing a
 *  claimed task, echoing a spoken order back, or a spark-directed act. */
export function asIntent(line: LeveledGlyphs): LeveledGlyphs {
  return { a: line.a, b: markIntent(line.b) ?? line.b, c: markIntent(line.c) ?? line.c };
}

/** The "{I'll} {do the thing}" line for a goal, or null when the goal has no
 *  speakable shape. Levels follow phrase(): a = the key slot, c = the full
 *  first-person sentence. */
export function goalIntentLine(goal: GoalSpec, syms: IntentLineSyms): LeveledGlyphs | null {
  switch (goal.kind) {
    case "fetch":
      // The SOURCE rides the line when the order named one ("I'll take the
      // ball from the dog") — the from-endpoint spoken back, same as "to".
      return phrase({
        subject: "i_me",
        verb: "get",
        object: syms.item(goal.item),
        ...(goal.from ? { tail: { join: "from", symbol: syms.place(goal.from) } } : {}),
      });
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
    case "place": {
      // WHERE it goes is half a placement order ("I'll put the chair NEXT TO
      // the table"): a line that only names the piece leaves nobody able to
      // tell an obeyed order from a misheard one, and it was the one transfer
      // shape that dropped its endpoint while fetch/give/putIn all kept theirs.
      //
      // The join is the BOARD WORD for the relation — `beside` is composed as
      // `next_to`, the rest speak as themselves — and it rides the line only
      // when the lang layer can actually say it. `posOf` is the authority
      // rather than a list kept in step by hand: a relation with no
      // preposition (`at`, `under`, `over`, `behind`, `front`) would drag the
      // whole sentence down to the telegraphic gloss, and this module's law is
      // that a line never degrades — better a bare "I'll put the chair" than
      // "put chair behind table" spoken as three loose words. The day one of
      // them earns a lexeme it starts being spoken here with no edit.
      //
      // A POINT anchor is the committed gaze ("put it HERE"): it names no
      // thing, so there is nothing for a relation to hold onto.
      // `beside` and `front` are engine names; the board words are `next_to`
      // and `in_front_of` (the parser maps them back — parse-intent WORDS).
      const join =
        goal.at.relation === "beside" ? "next_to"
        : goal.at.relation === "front" ? "in_front_of"
        : goal.at.relation;
      const speakable = posOf(join) === "prep" && goal.at.anchor.kind !== "point";
      return phrase({
        subject: "i_me",
        verb: "put",
        object: syms.item(goal.item),
        ...(speakable ? { tail: { join, symbol: syms.place(goal.at.anchor) } } : {}),
      });
    }
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
    case "satisfy": {
      // Chore keys speak their ACTIVITY words ("laundry" → "I'll wash the
      // clothing"), never the raw template key; verb-keys stay themselves.
      const act = needActivity(goal.need) ?? { verb: goal.need };
      if (act.object) return phrase({ subject: "i_me", verb: act.verb, object: act.object });
      return { a: act.verb, b: `i_me + ${act.verb}`, c: `i_me + ${act.verb}` };
    }
    case "rest": {
      // The station is the teaching point (level a); the sentence speaks the
      // ACT the station serves (the attention-action vocabulary): a sleep pose
      // or a bed = "I'll sleep", a bath = "I'll wash", a toilet = the bathroom
      // trip ("I'll go to the bathroom"); anything else stays the plain rest.
      const where = syms.place(goal.place);
      if (goal.pose === "sleep" || where === "bed") {
        return { a: where, b: "i_me + sleep", c: "i_me + sleep" };
      }
      if (where === "bath") return { a: where, b: "i_me + wash", c: "i_me + wash" };
      if (where === "toilet" || where === "bathroom") {
        return { a: where, b: "go + to + bathroom", c: "i_me + go + to + bathroom" };
      }
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
    case "color": {
      // "I'll color the shirt red" — the colour is the teaching point (level a).
      const g = syms.item(goal.item);
      return { a: goal.color, b: `${g} + ${goal.color}`, c: `i_me + color + ${g} + ${goal.color}` };
    }
    case "converse": {
      // "I'll talk to Mara" — the partner is the teaching point (level a).
      // Verb + partner; each ruleset supplies the joint ("to"/"עם"/"con").
      const who = syms.creature(goal.target);
      return { a: who, b: `talk + ${who}`, c: `i_me + talk + ${who}` };
    }
    case "takeUnits": {
      // "I'll get food" — the good is the teaching point; the count stays
      // unspoken (a shopping bag, not arithmetic).
      const what = goal.category || goal.affords || "thing";
      return phrase({ subject: "i_me", verb: "get", object: what });
    }
    case "putUnits": {
      // "I'll put food in the chest" — the putIn shape over the stack.
      const what = goal.category || "thing";
      return phrase({ subject: "i_me", verb: "put", object: what, tail: { join: "in", symbol: syms.place(goal.into) } });
    }
    case "processUnits": {
      // "I'll wash the clothes" / "I'll make food hot" — the transform's shape
      // over the stack (drop = the wash; add = the cook's state).
      const what = goal.category || "thing";
      if (goal.add) return { a: goal.add, b: `${what} + ${goal.add}`, c: `i_me + make + ${what} + ${goal.add}` };
      return phrase({ subject: "i_me", verb: "wash", object: what });
    }
    case "equipUnits": {
      // "I'll wear the clothes" — the change of clothes.
      const what = goal.category || "thing";
      return phrase({ subject: "i_me", verb: "wear", object: what });
    }
    case "dropUnits": {
      // "I'll drop the thing" — the put-it-down answer.
      const what = goal.category || "thing";
      return phrase({ subject: "i_me", verb: "drop", object: what });
    }
    case "consumeUnits": {
      // "I'll eat the food" — the bag meal.
      const what = goal.category || "thing";
      return phrase({ subject: "i_me", verb: "eat", object: what });
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
    case "craft":
      // A CRAFT is announced with MAKE, never BUILD (user law, 2026-07-28): the
      // two verbs are interchangeable as ORDERS, but an NPC saying what it is
      // doing should use the one that fits — you make a toy, you build a house.
      // The glyph is spoken as its bare word (`furn.chair` → "chair",
      // `rabbit.toy.material_cloth` → "rabbit"), the same head convention every
      // other line here follows; a doll's `toy` descriptor can't ride a plain
      // symbol string, so "make the rabbit" is as close as this shape gets.
      return phrase({ subject: "i_me", verb: "make", object: spokenMakeable(goal.glyph) });
    case "buildwork":
      // ⑥ standing site work — "I'll build" (the site names no glyph word).
      return { a: "build", b: "i_me + build", c: "i_me + build" };
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
      const heads = Object.keys(goal.goods).map((g) => headOf(g));
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

// ---------------------------------------------------------------------------
// The COMMAND ECHO (semantic-gaps.md §Commands)
// ---------------------------------------------------------------------------

/**
 * A directly commanded creature SPEAKS the order back as it understood it —
 * proper grammar, connectors included ("wash clothes" → "I will wash the
 * clothes") — through the same goalIntentLine every announcement uses. The
 * reserved bare "ok" is EARNED: it answers only when the child's own glyphs
 * already matched the canonical form (heads in order, "you" ↔ "i_me" deixis
 * flipped). One rule, every verb: the echo is a re-render of what COMPILED, so
 * a wrong echo means a parser bug and a right echo that isn't obeyed means an
 * action bug — the teaching tool and the debugging tool are the same line.
 */
export function commandEcho(
  frame: { raw: string[] },
  goal: GoalSpec,
  syms: IntentLineSyms,
): { line: LeveledGlyphs | null; perfect: boolean } {
  const line = goalIntentLine(goal, syms);
  if (!line) return { line: null, perfect: false };
  const heads = (tokens: string[]): string[] =>
    tokens
      .map((t) => headOf(t.split("#")[0]!).trim().toLowerCase())
      .filter(Boolean);
  // The echo speaks first person; the child addresses second person — the
  // deixis flip is not an error ("you wash clothes" matches "i_me wash
  // clothes"). Modifiers/operators are content, not syntax: heads only.
  const canon = heads(line.c.split("+"));
  const spoken = heads(frame.raw).map((h) => (h === "you" ? "i_me" : h));
  const perfect = canon.length === spoken.length && canon.every((h, i) => h === spoken[i]);
  return { line, perfect };
}

// ---------------------------------------------------------------------------
// Goal → live ACTIVITY (the "what is X doing?" answer's world hook)
// ---------------------------------------------------------------------------

/** MOTIVE → ACTIVITY: the frame each need/chore shows as while it is pursued
 *  ("laundry" is washing the clothes, "energy" is sleeping) — the ONE table,
 *  read by the commanded goal's echo and by the host's need-template walker
 *  (its `tplKey`s carry these as prefixes), so a creature describes a want and
 *  the errand serving it with the same words.
 *
 *  Every verb here must RENDER as a verb: "clean" is pinned to the state
 *  adjective outbound (lang/core POS), so the scrub speaks "wash" — a
 *  `{verb: "clean"}` frame comes out as "I am clean". */
export const NEED_ACTIVITY: Record<string, { verb: string; object?: string }> = {
  hunger: { verb: "eat" },
  thirst: { verb: "drink" },
  energy: { verb: "sleep" },
  waste: { verb: "go", object: "bathroom" },
  hygiene: { verb: "wash" },
  fun: { verb: "play" },
  social: { verb: "talk" },
  laundry: { verb: "wash", object: "clothing" },
  cook: { verb: "cook", object: "food" },
  clean: { verb: "wash" },
  tidy: { verb: "put" },
  dress: { verb: "wear" },
};

/**
 * THE REFUSAL PHRASEBOOK — the honest "no" to a self-care activity, spoken as
 * the state the creature is NOT in ("I'm not hungry", "I'm not bored"). Keyed
 * by the ACTIVITY VERB, the same words that order it.
 *
 * ONE table, read by every path that can decline the activity: a refused
 * ORDER ("you eat" at a full stomach) and a refused INVITATION ("eat with me"
 * at a creature that would rather not) are the same "no" and must sound like
 * it. Two tables would have drifted the first time one of them gained a verb.
 *
 * Negation the world MEANS: each line is a real claim about the speaker's
 * state, which is why it teaches — the child hears a `.not` that is true.
 */
export const ACTIVITY_REFUSAL: Record<string, string> = {
  eat: "i_me + hungry.not",
  drink: "i_me + thirsty.not",
  sleep: "i_me + tired.not",
  rest: "i_me + tired.not",
  play: "i_me + bored.not",
  talk: "i_me + lonely.not",
  wash: "i_me + dirty.not",
  brush_teeth: "i_me + dirty.not",
  wear: "clothing + clean", // "The clothes are clean." — no change needed
};

/** The activity a motive KEY reads as. Host template keys are compound
 *  ("hunger_eat", "laundry_wash") — the motive leads, so a prefix match resolves
 *  them; no key here is a prefix of another. Undefined = no activity word. */
export function needActivity(key: string): { verb: string; object?: string } | undefined {
  return NEED_ACTIVITY[key] ?? Object.entries(NEED_ACTIVITY).find(([k]) => key.startsWith(k))?.[1];
}

/**
 * The ACTIVITY a goal reads as while being pursued — the same verbs commands
 * use (one vocabulary in both directions: a creature STATES what it does with
 * the words that order it). Feeds ProjectionOpts.activityOf, so "what is the
 * dog eating?" answers "dog + eat + apple" from the live pursuit. Null = the
 * goal has no activity reading (host-policy orders).
 */
export function goalActivity(goal: GoalSpec, syms: IntentLineSyms): { verb: string; object?: string } | null {
  switch (goal.kind) {
    case "fetch":
      return { verb: "get", object: syms.item(goal.item) };
    case "takeUnits":
      return { verb: "get", object: goal.category || goal.affords || "thing" };
    case "give":
      return { verb: "give", object: syms.item(goal.item) };
    case "transfer":
      return { verb: "give", object: headOf(Object.keys(goal.goods)[0] ?? "") || "thing" };
    case "putIn":
    case "place":
      return { verb: "put", object: syms.item(goal.item) };
    case "putUnits":
      return { verb: "put", object: goal.category || "thing" };
    case "drop":
      return { verb: "drop", object: syms.item(goal.item) };
    case "dropUnits":
      return { verb: "drop", object: goal.category || "thing" };
    case "goTo":
      return { verb: "go", object: syms.place(goal.place) };
    case "goHome":
      return { verb: "go", object: "home" };
    case "follow":
      return { verb: "follow", object: syms.creature(goal.target) };
    case "stay":
      return { verb: "stay" };
    case "toggle":
      return { verb: goal.state === "open" ? "open" : "shut", object: syms.item(goal.device) };
    case "transform":
      return { verb: "make", object: syms.item(goal.item) };
    case "satisfy":
      return NEED_ACTIVITY[goal.need] ?? { verb: goal.need };
    case "rest":
      return { verb: goal.pose === "sleep" ? "sleep" : "rest" };
    case "setOpen":
      return { verb: goal.open ? "open" : "shut", object: syms.place(goal.place) };
    case "wear":
      return { verb: "wear", object: syms.item(goal.item) };
    case "color":
      return { verb: "color", object: syms.item(goal.item) };
    case "equipUnits":
      return { verb: "wear", object: goal.category || "thing" };
    case "converse":
      return { verb: "talk", object: syms.creature(goal.target) };
    case "socialAct":
      return { verb: goal.act, object: syms.creature(goal.target) };
    case "help":
      return { verb: "help", object: syms.creature(goal.target) };
    case "consume":
      return { verb: "eat", object: syms.item(goal.item) };
    case "consumeUnits":
      return { verb: "eat", object: goal.category || "thing" };
    case "processUnits":
      // The wash drops "dirty"; the cook adds "hot" — the verb follows the edit.
      return goal.add
        ? { verb: "cook", object: goal.category || "thing" }
        : { verb: "wash", object: goal.category || "thing" };
    case "build":
      return { verb: "build", ...(goal.structure !== "town" ? { object: goal.structure } : {}) };
    case "craft":
      return { verb: "make", object: spokenMakeable(goal.glyph) };
    case "buildwork":
      return { verb: "build" }; // ⑥ standing site work
    case "trade":
      return { verb: "trade", object: goal.give };
    case "area":
      return null; // host-instant policy — never a body's ongoing activity
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
