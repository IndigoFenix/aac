// THE REST ECHO IS A WALK (build order L13).
//
// A `rest` goal at a station used to end in `i_me + rest + <station>`, and that
// line was wrong twice over: `rest` is TRANSITIVE in the English ruleset, so it
// said "I will rest the chair", and it has no lexeme at all in he/es/pt, so
// three of the four shipped rulesets spoke the raw token back at the child.
// Reachable from the first day the dinner ritual posted `{rest, place:"chair"}`,
// and reachable from every board the moment `sit/sleep/rest + <station>` began
// compiling to `rest` (L3b).
//
// The shape that replaced it is the one the TOILET fork already used — the trip
// the goal opens with, `go + to + <station>` — chosen because the going frame
// is grammar every ruleset owns: it supplies its own "to", inflects the
// speaker's gender, and carries the `.will` future without dropping to the
// telegraphic gloss.
//
// L15 (2026-08-10) closed the other half: `rest` and `sit` now have lexemes in
// he/es/pt, so the ONE cell this shape deliberately left alone — the bare-point
// dwell, which has no walk in it to speak — renders properly too. The standing
// debt pin at the foot of this file was deleted per its own note and replaced
// by the positive renders.
//
// ⚖️ ONE FACT READ TWICE. `goalIntentLine` (what the creature SAYS it will do)
// and `goalActivity` (what it answers while doing it) are two readings of one
// goal and may never disagree, so both arms fork identically and this file pins
// them together, never one alone.
//
// Pure logic — no DOM / GL / DB.

import { describe, it, expect } from "@jest/globals";
import {
  asIntent,
  goalActivity,
  goalIntentLine,
  NEED_ACTIVITY,
  type IntentLineSyms,
} from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import { phrase } from "@shared/world-engine/interaction/dialogue/dialogue-gen.js";
import { translateGlyph } from "@shared/world-engine/interaction/lang/index.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";

// The bare resolver: a named station speaks its own id, a body its own id, a
// bare point the deictic last resort — exactly the readings the host's
// `intentLineSyms` yields once it has looked the ids up.
const syms: IntentLineSyms = {
  item: (ref) => ("id" in ref ? ref.id : (ref.match.kind ?? "thing")),
  place: (p) =>
    p.kind === "named" ? p.id : p.kind === "home" ? "home" : p.kind === "creature" ? p.id : "there",
  creature: (id) => id,
};

const restAt = (station: string, pose?: "sleep" | "sit" | "play"): GoalSpec => ({
  kind: "rest",
  place: { kind: "named", id: station },
  ...(pose ? { pose } : {}),
});
const restHere = (pose?: "sleep" | "sit" | "play"): GoalSpec => ({
  kind: "rest",
  place: { kind: "point", x: 1, y: 2 },
  ...(pose ? { pose } : {}),
});

// The shipped rulesets (lang/index.ts): en · he · es · pt, es/pt off one shared
// romance base. Every other app locale is DEFERRED and falls back to English —
// `fr` stands for that whole class here, because a line that only renders
// through a ruleset we happen to ship is a line that breaks on the fallback.
const SHIPPED = ["en", "he", "es", "pt"] as const;

describe("a generic station speaks the WALK, not a transitive rest", () => {
  it("the chair: same glyph shape the toilet fork uses", () => {
    const line = goalIntentLine(restAt("chair"), syms)!;
    // Level a is untouched — the STATION is still the teaching point.
    expect(line.a).toBe("chair");
    expect(line.b).toBe("go + to + chair");
    expect(line.c).toBe("i_me + go + to + chair");
    // …and it is the toilet fork's shape with the station word swapped in.
    const toilet = goalIntentLine(restAt("toilet"), syms)!;
    expect(line.c).toBe(toilet.c.replace("bathroom", "chair"));
  });

  it("renders as a sentence in EVERY shipped ruleset (the whole point of L13)", () => {
    const line = goalIntentLine(restAt("chair"), syms)!;
    expect(translateGlyph(line.c, "en")).toBe("I'm going to the chair.");
    expect(translateGlyph(line.c, "he")).toBe("אני הולך לכיסא.");
    expect(translateGlyph(line.c, "es")).toBe("Voy a la silla.");
    expect(translateGlyph(line.c, "pt")).toBe("Vou para a cadeira.");
    // The he ruleset inflects the SPEAKER, which the old line could not do at
    // all — an untranslated verb has no gender to agree with.
    expect(translateGlyph(line.c, "he", { speaker: "f" })).toBe("אני הולכת לכיסא.");
    // A deferred locale falls back to English rather than to the raw glyph.
    expect(translateGlyph(line.c, "fr")).toBe("I'm going to the chair.");
  });

  it("the ANNOUNCEMENT (.will) survives the marker in every ruleset", () => {
    const intent = asIntent(goalIntentLine(restAt("chair"), syms)!);
    // The marker lands on the verb and the line does NOT degrade to the gloss
    // (markIntent drops the marker when it would) — level b carries it too.
    expect(intent.b).toBe("go.will + to + chair");
    expect(intent.c).toBe("i_me + go.will + to + chair");
    expect(translateGlyph(intent.c, "en")).toBe("I will go to the chair.");
    expect(translateGlyph(intent.c, "he")).toBe("אני הולך לכיסא.");
    expect(translateGlyph(intent.c, "es")).toBe("Voy a la silla.");
    expect(translateGlyph(intent.c, "pt")).toBe("Vou para a cadeira.");
  });

  it("NO ruleset speaks a raw glyph token back — the L13 regression guard", () => {
    // The failure this file exists to prevent, stated as the invariant rather
    // than as four expected strings: the untranslated verb LEAKS, so a rendered
    // line that still contains the engine's own token never reached a lexeme.
    for (const station of ["chair", "table", "tree", "bed", "bath", "toilet"]) {
      const line = goalIntentLine(restAt(station), syms)!;
      for (const lang of SHIPPED) {
        for (const glyph of [line.b, line.c, asIntent(line).b, asIntent(line).c]) {
          const said = translateGlyph(glyph, lang);
          expect(`${lang}/${station}: ${said}`).not.toContain("rest");
          expect(`${lang}/${station}: ${said}`).not.toContain("sit");
          expect(`${lang}/${station}: ${said}`).not.toContain("+");
        }
      }
    }
  });

  it("a NAMED BODY is a station too — 'sit next to Mara' walks to Mara", () => {
    // PlaceRef's `creature` kind is "where that body is" (the compiler's
    // reading), so the same fallback applies and the same walk is spoken.
    const line = goalIntentLine({ kind: "rest", place: { kind: "creature", id: "mara" } }, syms)!;
    expect(line.c).toBe("i_me + go + to + mara");
    expect(goalActivity({ kind: "rest", place: { kind: "creature", id: "mara" } }, syms)).toEqual({
      verb: "go",
      object: "mara",
    });
  });
});

describe("the twins agree — the announcement and the activity are one goal", () => {
  it("every station word rides BOTH channels, and neither names a second thing", () => {
    for (const station of ["chair", "bench", "workbench", "table", "tree", "box"]) {
      const said = goalIntentLine(restAt(station), syms)!;
      const doing = goalActivity(restAt(station), syms)!;
      expect(said.c).toBe(`i_me + go + to + ${station}`);
      expect(doing).toEqual({ verb: "go", object: station });
    }
  });

  it("…and the ACTIVITY answer renders through the same going frame", () => {
    // `activityOf` is spoken as `phrase({subject, verb, object})` (the
    // "what is X doing?" answer), and the going frame supplies the "to" there
    // exactly as it does in the announcement — one shape, one preposition,
    // never hand-written into either arm.
    const doing = goalActivity(restAt("chair"), syms)!;
    const answer = phrase({ subject: "dog", verb: doing.verb, object: doing.object! });
    expect(answer.c).toBe("dog + go + chair");
    expect(translateGlyph(answer.c, "en")).toBe("The dog is going to the chair.");
    expect(translateGlyph(answer.c, "he")).toBe("הכלב הולך לכיסא.");
    expect(translateGlyph(answer.c, "es")).toBe("El perro va a la silla.");
    expect(translateGlyph(answer.c, "pt")).toBe("O cachorro vai para a cadeira.");
  });
});

describe("the special forks are UNTOUCHED — L13 added a cell, it replaced none", () => {
  it("a bed sleeps, a bath washes, a toilet is the bathroom trip", () => {
    const bed = goalIntentLine(restAt("bed"), syms)!;
    expect([bed.a, bed.b, bed.c]).toEqual(["bed", "i_me + sleep", "i_me + sleep"]);
    const bath = goalIntentLine(restAt("bath"), syms)!;
    expect([bath.a, bath.b, bath.c]).toEqual(["bath", "i_me + wash", "i_me + wash"]);
    const toilet = goalIntentLine(restAt("toilet"), syms)!;
    expect([toilet.a, toilet.b, toilet.c]).toEqual([
      "toilet",
      "go + to + bathroom",
      "i_me + go + to + bathroom",
    ]);
    expect(goalIntentLine(restAt("bathroom"), syms)!.c).toBe("i_me + go + to + bathroom");
    // A sleep POSE still wins over any station word.
    expect(goalIntentLine(restAt("chair", "sleep"), syms)!.c).toBe("i_me + sleep");
  });

  it("their activity readings are the same three rows, off the one table", () => {
    expect(goalActivity(restAt("bed"), syms)).toEqual(NEED_ACTIVITY.energy);
    expect(goalActivity(restAt("bath"), syms)).toEqual(NEED_ACTIVITY.hygiene);
    expect(goalActivity(restAt("toilet"), syms)).toEqual(NEED_ACTIVITY.waste);
    expect(goalActivity(restAt("chair", "sleep"), syms)).toEqual({ verb: "sleep" });
  });
});

describe("a dwell at a bare POINT has no walk in it", () => {
  it("stays the plain rest, and drops the object so the twins name the same slots", () => {
    // `restHere` (need-goals) settles the body WHERE IT STANDS: there is no
    // trip to announce and no station to name. The old line still named one
    // ("I rest there" / "I rest the chair" once the host's `pointWord` found a
    // fixture) while `goalActivity` answered a bare `{verb:"rest"}` — the two
    // readings disagreed about how many things the sentence was about.
    const line = goalIntentLine(restHere(), syms)!;
    expect(line.a).toBe("there"); // the teaching slot still says where
    expect(line.b).toBe("i_me + rest");
    expect(line.c).toBe("i_me + rest");
    expect(goalActivity(restHere(), syms)).toEqual({ verb: "rest" });
    // The sleep pose still forks; sit/play reach this cell.
    expect(goalIntentLine(restHere("sleep"), syms)!.c).toBe("i_me + sleep");
    expect(goalIntentLine(restHere("play"), syms)!.c).toBe("i_me + rest");
    expect(goalIntentLine(restHere("sit"), syms)!.c).toBe("i_me + rest");
  });

  // ⤳ REPLACED PIN (L15, 2026-08-10). What stood here was a STANDING DEBT with
  // a delete-when-landed note: the point cell rendered "אני rest." / "Eu rest."
  // because `rest` had no lexeme outside English, and the pin asserted the leak
  // so nobody could mistake it for working. The word has now landed in
  // he/es/pt (and `sit` with it), so the debt is discharged and the four pins
  // below are its positive replacement — the same cell, pinned as it reads.
  it("…and now SPEAKS in every ruleset — the L15 lexemes landed", () => {
    const c = goalIntentLine(restHere(), syms)!.c;
    expect(c).toBe("i_me + rest");
    expect(translateGlyph(c, "en")).toBe("I rest.");
    expect(translateGlyph(c, "he")).toBe("אני נח.");
    // Hebrew inflects the SPEAKER — the thing an untranslated token could not
    // do at all, because a raw glyph has no gender to agree with.
    expect(translateGlyph(c, "he", { speaker: "f" })).toBe("אני נחה.");
    expect(translateGlyph(c, "es")).toBe("Descanso."); // pro-drop
    expect(translateGlyph(c, "pt")).toBe("Eu descanso.");
    // A deferred locale still falls back to English, never to the raw glyph.
    expect(translateGlyph(c, "fr")).toBe("I rest.");
  });

  it("…and the ANNOUNCEMENT (.will) takes each ruleset's own future", () => {
    // The `.will` marker is what proves the lexeme is a real verb card and not
    // a bare word: the periphrasis reads the INFINITIVE (Hebrew "הולך ל…",
    // romance "voy a …"), which a fallback token never carries.
    const intent = asIntent(goalIntentLine(restHere(), syms)!);
    expect(intent.c).toBe("i_me + rest.will");
    expect(translateGlyph(intent.c, "en")).toBe("I will rest.");
    expect(translateGlyph(intent.c, "he")).toBe("אני הולך לנוח.");
    expect(translateGlyph(intent.c, "he", { speaker: "f" })).toBe("אני הולכת לנוח.");
    expect(translateGlyph(intent.c, "es")).toBe("Voy a descansar.");
    expect(translateGlyph(intent.c, "pt")).toBe("Eu vou descansar.");
  });

  it("`sit` landed with it — the posture pair the point cell's verb belongs to", () => {
    // `sit` never reaches the point cell (the dwell primitive is `rest`), but
    // it is the SAME gap on the SAME family: a bare "you sit" compiles to
    // `{satisfy, need:"sit"}`, whose line is the objectless `i_me + sit`, and
    // that leaked the English token in exactly the same three rulesets.
    const line = goalIntentLine({ kind: "satisfy", need: "sit" }, syms)!;
    expect(line.c).toBe("i_me + sit");
    expect(translateGlyph(line.c, "en")).toBe("I sit.");
    expect(translateGlyph(line.c, "he")).toBe("אני יושב.");
    expect(translateGlyph(line.c, "he", { speaker: "f" })).toBe("אני יושבת.");
    // Spanish `sentarse` is REFLEXIVE; the clitic rides the authored forms the
    // way `wear`'s ("me visto") already does, so the going-to future takes the
    // enclitic infinitive with no new machinery in the romance layer.
    expect(translateGlyph(line.c, "es")).toBe("Me siento.");
    expect(translateGlyph(line.c, "pt")).toBe("Eu sento.");
    expect(translateGlyph(asIntent(line).c, "es")).toBe("Voy a sentarme.");
    expect(translateGlyph(asIntent(line).c, "he")).toBe("אני הולך לשבת.");
    expect(translateGlyph(asIntent(line).c, "pt")).toBe("Eu vou sentar.");
  });

  it("NO ruleset leaks a raw `rest`/`sit` token any more — the L15 sweep", () => {
    // The mirror of the L13 guard above, aimed at the two words that USED to
    // leak: the untranslated verb shows up as its own Latin-script glyph id
    // inside a sentence, so a rendered line containing it never reached a
    // lexeme. (English is excluded — there the word IS the lexeme.)
    for (const glyph of ["i_me + rest", "i_me + sit", "i_me + rest.will", "i_me + sit.will"]) {
      for (const lang of ["he", "es", "pt"] as const) {
        for (const speaker of ["m", "f"] as const) {
          const said = translateGlyph(glyph, lang, { speaker });
          // "+" rides the list too: a surviving joiner means the sentence fell
          // all the way to the telegraphic gloss.
          const leaks = ["rest", "sit", "+"].filter((w) => said.includes(w));
          expect({ lang, speaker, glyph, said, leaks }).toEqual({ lang, speaker, glyph, said, leaks: [] });
        }
      }
    }
  });
});
