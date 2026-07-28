// "WHERE ARE YOU GOING?" — the destination rules (interaction/dialogue/going.ts)
// and the lines they speak (creature-dialogue's goingLine).
//
// The rules under test, the first two of which used to answer "I'm going home"
// to a resident pottering about inside its own house:
//   ① a body that has ARRIVED is not going anywhere — no destination, and the
//      ask leaves the board;
//   ② a body inside its own home names the ROOM it is crossing to, or the
//      ACTIVITY the errand serves; "home" is only for the walk back to it;
//   ③ the schedule proposes, the body decides — a creature we can SEE standing
//      still is not on the trip the clock says it is mid-way through.
//
// Pure — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  roomAt,
  stepActivity,
  stepDestination,
  tripDestination,
  type GoingRoom,
  type GoingStep,
} from "@shared/world-engine/interaction/dialogue/going.js";
import { needActivity } from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import { createCreatureWorld } from "@shared/world-engine/interaction/behavior/creatures.js";
import {
  projectDialogue,
  selectAct,
  type GoingDest,
  type ProjectionOpts,
} from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";
import { translateGlyph } from "@shared/world-engine/interaction/lang/index.js";

const ARRIVE = 0.8;

// A two-room house at the origin: the living room (no word of its own — its
// glyph IS "home") and a bedroom beside it. Everything past x=10 is outdoors.
const HOME: GoingRoom[] = [
  { rect: { x: 0, y: 0, w: 5, h: 6 } },
  { rect: { x: 5, y: 0, w: 5, h: 6 }, word: "bedroom" },
];

const step = (over: Partial<GoingStep> = {}): GoingStep => ({
  kind: "rest",
  tplKey: "energy_sleep",
  goodKey: "",
  at: { x: 7, y: 3 }, // the bed, in the bedroom
  ...over,
});

describe("stepDestination — arrived is not going", () => {
  it("a body standing at its spot has NO destination (the ask leaves the board)", () => {
    expect(stepDestination(step(), { x: 7.2, y: 3.1 }, HOME, ARRIVE)).toBeUndefined();
  });
  it("a body pinned onto the fixture it is USING has no destination", () => {
    expect(stepDestination(step(), { x: 30, y: 30, using: true }, HOME, ARRIVE)).toBeUndefined();
  });
  it("a body still walking DOES have one", () => {
    expect(stepDestination(step(), { x: 2, y: 3 }, HOME, ARRIVE)).toEqual({ kind: "room", room: "bedroom" });
  });
});

describe("stepDestination — at home, the room or the activity answers", () => {
  it("crossing the house to a named room answers with the room", () => {
    expect(stepDestination(step(), { x: 1, y: 1 }, HOME, ARRIVE)).toEqual({ kind: "room", room: "bedroom" });
  });
  it("a destination in the LIVING room falls through to the activity, never 'home'", () => {
    // The living room's word is "home" — the one answer a body inside it must
    // not give. It says what the errand is FOR instead.
    const s = step({ kind: "process", tplKey: "laundry_wash", at: { x: 2, y: 2 } });
    expect(stepDestination(s, { x: 8, y: 5 }, HOME, ARRIVE)).toEqual({
      kind: "activity",
      verb: "wash",
      object: "clothing",
    });
  });
  it("no room and no motive word → no destination at all (never a guess)", () => {
    const s = step({ kind: "process", tplKey: "mystery", at: { x: 40, y: 40 } });
    expect(stepDestination(s, { x: 2, y: 2 }, HOME, ARRIVE)).toBeUndefined();
  });
  it("a house with no room plan (empty rooms) still answers with the activity", () => {
    expect(stepDestination(step(), { x: 2, y: 3 }, [], ARRIVE)).toEqual({ kind: "activity", verb: "sleep" });
  });
});

describe("stepDestination — 'home' is the walk BACK to it", () => {
  it("out in town, walking to a fixture inside the house → home", () => {
    const s = step({ kind: "deposit", tplKey: "hunger_restock", goodKey: "food", at: { x: 2, y: 2 } });
    expect(stepDestination(s, { x: 40, y: 40 }, HOME, ARRIVE)).toEqual({ kind: "home" });
  });
  it("the SAME walk, ending at the bedroom, is still home from outside", () => {
    expect(stepDestination(step(), { x: 40, y: 40 }, HOME, ARRIVE)).toEqual({ kind: "home" });
  });
  it("a take is a shopping trip wherever it happens — the good is the answer", () => {
    const s = step({ kind: "take", tplKey: "hunger_eat", goodKey: "food", at: { x: 60, y: 60 } });
    expect(stepDestination(s, { x: 2, y: 2 }, HOME, ARRIVE)).toEqual({ kind: "fetch", good: "food" });
  });
});

describe("tripDestination — the schedule proposes, the body decides", () => {
  const shopping = (phase: "to_source" | "at_source" | "to_home") =>
    ({ kind: "shopping", phase, good: "food" }) as const;

  it("off-show (no body to ask) the schedule is trusted as-is", () => {
    expect(tripDestination(shopping("to_source"), undefined)).toEqual({ kind: "fetch", good: "food" });
    expect(tripDestination(shopping("at_source"), undefined)).toEqual({ kind: "fetch", good: "food" });
    expect(tripDestination(shopping("to_home"), undefined)).toEqual({ kind: "home" });
    expect(tripDestination({ kind: "shift" }, undefined)).toEqual({ kind: "place", place: "work" });
  });

  it("a body we can see WALKING answers the schedule's trip", () => {
    expect(tripDestination(shopping("to_source"), true)).toEqual({ kind: "fetch", good: "food" });
    expect(tripDestination({ kind: "shift" }, true)).toEqual({ kind: "place", place: "work" });
  });

  it("a body standing STILL overrules the clock — no journey it isn't making", () => {
    // Standing at the stall it is shopping, not going shopping; standing at its
    // bench it is at work, not going to work.
    for (const phase of ["to_source", "at_source", "to_home"] as const) {
      expect(tripDestination(shopping(phase), false)).toBeUndefined();
    }
    expect(tripDestination({ kind: "shift" }, false)).toBeUndefined();
  });
});

describe("stepActivity — the physical moves speak their own verb", () => {
  it("a take is getting, a deposit/drop is putting (not the motive behind it)", () => {
    expect(stepActivity({ kind: "take", tplKey: "hunger_restock", goodKey: "food" })).toEqual({
      verb: "get",
      object: "food",
    });
    expect(stepActivity({ kind: "deposit", tplKey: "hunger_restock", goodKey: "food.fresh" })).toEqual({
      verb: "put",
      object: "food",
    });
    expect(stepActivity({ kind: "drop", tplKey: "tidy_away", goodKey: "toy" })).toEqual({ verb: "put", object: "toy" });
  });
  it("everything else speaks its motive's frame, prefix-matched off the template key", () => {
    expect(stepActivity({ kind: "rest", tplKey: "energy_sleep", goodKey: "" })).toEqual({ verb: "sleep" });
    expect(stepActivity({ kind: "rest", tplKey: "fun_play", goodKey: "" })).toEqual({ verb: "play" });
    expect(stepActivity({ kind: "consume", tplKey: "thirst_drink", goodKey: "" })).toEqual({ verb: "drink" });
    expect(stepActivity({ kind: "socialize", tplKey: "social", goodKey: "" })).toEqual({ verb: "talk" });
  });
  it("every motive verb RENDERS as a verb — the chores must not speak adjectives", () => {
    // "clean" is pinned to the state adjective outbound, so a `clean` verb comes
    // out as "I am clean". The scrub speaks "wash".
    expect(needActivity("clean")?.verb).toBe("wash");
    const motives = ["hunger", "thirst", "energy", "waste", "hygiene", "fun", "social", "laundry", "cook", "clean", "tidy", "dress"];
    for (const key of motives) {
      const act = needActivity(key)!;
      expect(act).toBeDefined();
      const line = translateGlyph(`i_me + ${act.verb}.will${act.object ? ` + ${act.object}` : ""}`, "en");
      expect(line).toMatch(/^I will /);
    }
  });
});

describe("roomAt — point in the home's rooms", () => {
  it("finds the room a point sits in, and nothing outdoors", () => {
    expect(roomAt(HOME, { x: 7, y: 3 })?.word).toBe("bedroom");
    expect(roomAt(HOME, { x: 1, y: 3 })?.word).toBeUndefined();
    expect(roomAt(HOME, { x: 1, y: 3 })).toBeDefined();
    expect(roomAt(HOME, { x: 40, y: 3 })).toBeUndefined();
  });
});

describe("the spoken lines — a room is a place, an activity is an intention", () => {
  const world = () => createCreatureWorld([{ id: "res" }, { id: "me" }], []);
  const answer = (dest: GoingDest | undefined, level: "a" | "b" | "c" = "c") => {
    const o: ProjectionOpts = { symbolOf: (id) => id, ...(dest ? { goingOf: () => dest } : {}) };
    return selectAct(world(), "res", "me", { kind: "where-going", glyph: "" }, level, o).responseGlyph;
  };

  it("a room reads as a destination in every ruleset", () => {
    expect(answer({ kind: "room", room: "bedroom" })).toBe("i_me + go + to + bedroom");
    expect(translateGlyph("i_me + go + to + bedroom", "en")).toBe("I'm going to the bedroom.");
    expect(translateGlyph("i_me + go + to + kitchen", "es")).toBe("Voy a la cocina.");
    expect(translateGlyph("i_me + go + to + bathroom", "pt-BR")).toBe("Vou para o banheiro.");
    expect(translateGlyph("i_me + go + to + bedroom", "he-IL")).toBe("אני הולך לחדר השינה.");
  });

  it("an activity reads as an intention ('I will …'), object included", () => {
    expect(answer({ kind: "activity", verb: "sleep" })).toBe("i_me + sleep.will");
    expect(answer({ kind: "activity", verb: "wash", object: "clothing" })).toBe("i_me + wash.will + clothing");
    expect(translateGlyph("i_me + sleep.will", "en")).toBe("I will sleep.");
    expect(translateGlyph("i_me + wash.will + clothing", "es")).toBe("Voy a lavar la ropa.");
    expect(translateGlyph("i_me + cook.will + food", "he-IL")).toBe("אני הולך לבשל את האוכל.");
    expect(translateGlyph("i_me + cook.will + food", "pt-BR")).toBe("Eu vou cozinhar a comida.");
  });

  it("the teaching levels reduce to the new concept alone", () => {
    expect(answer({ kind: "room", room: "kitchen" }, "a")).toBe("kitchen");
    expect(answer({ kind: "activity", verb: "eat" }, "a")).toBe("eat");
  });

  it("no destination still answers 'I'm here' and drops the ask from the board", () => {
    expect(answer(undefined)).toContain("here");
    const still: ProjectionOpts = { symbolOf: (id) => id };
    const going: ProjectionOpts = { symbolOf: (id) => id, goingOf: () => ({ kind: "room", room: "bedroom" }) };
    expect(projectDialogue(world(), "res", "me", "b", still).acts.some((a) => a.kind === "where-going")).toBe(false);
    expect(projectDialogue(world(), "res", "me", "b", going).acts.some((a) => a.kind === "where-going")).toBe(true);
  });
});
