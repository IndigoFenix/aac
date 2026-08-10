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

  it("🚨 and is the ONE cell still English-only — `rest` has no lexeme elsewhere", () => {
    // Pinned as a standing debt, not as a desired behaviour: the fix is a
    // `rest` lexeme in he/es/pt, which lives in files this arm may not reach
    // around. Delete this pin the day the word lands — the point cell is
    // then free to read like every other.
    const c = goalIntentLine(restHere(), syms)!.c;
    expect(translateGlyph(c, "en")).toBe("I rest.");
    for (const lang of ["he", "es", "pt"] as const) {
      // Lowercased because a verb-first ruleset capitalises the leaked token
      // into the sentence slot it never earned ("Rest.", "Eu rest.").
      expect(`${lang}: ${translateGlyph(c, lang).toLowerCase()}`).toContain("rest");
    }
  });
});
