// INTENT ANNOUNCEMENTS (city-expansion phase ①a §3): a creature states what it
// is ABOUT to do before doing it ("I'll get the wood"). Pins the goal → glyph
// line mapping (dialogue/intent-lines.ts), its rendering through the shared
// game lang layer (never client i18n), and the criteria hook's conservative
// default (announce on a pooled-task claim; quiet otherwise).
// Pure logic — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  asIntent,
  defaultAnnounceCriteria,
  goalIntentLine,
  type IntentLineSyms,
} from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";
import { translateGlyph } from "@shared/world-engine/interaction/lang/index.js";

const syms: IntentLineSyms = {
  item: (ref) => ("id" in ref ? ref.id : (ref.match.kind ?? ref.match.category ?? "thing")),
  place: (p) => (p.kind === "named" ? p.id : p.kind === "home" ? "home" : "there"),
  creature: (id) => (id === "__player__" ? "you" : id),
};

describe("goalIntentLine — GoalSpec → the announcement glyphs", () => {
  it("fetch: 'I'll get the wood'", () => {
    const line = goalIntentLine({ kind: "fetch", item: { match: { kind: "wood" } } }, syms)!;
    expect(line.c).toBe("i_me + get + wood");
    expect(line.b).toBe("get + wood");
    expect(line.a).toBe("wood");
    expect(translateGlyph(line.c, "en")).toBe("I get the wood.");
  });

  it("give routes to the recipient (the issuer reads as 'you')", () => {
    const goal: GoalSpec = { kind: "give", item: { match: { kind: "apple" } }, to: "__player__" };
    const line = goalIntentLine(goal, syms)!;
    expect(line.c).toContain("give");
    expect(line.c).toContain("apple");
    expect(line.c).toContain("you");
  });

  it("putIn names the destination; goTo/goHome name the place", () => {
    const put = goalIntentLine(
      { kind: "putIn", item: { match: { kind: "apple" } }, container: { kind: "named", id: "box" } },
      syms,
    )!;
    expect(put.c).toContain("put");
    expect(put.c).toContain("in + box");
    expect(goalIntentLine({ kind: "goHome" }, syms)!.c).toBe("i_me + go + home");
    expect(goalIntentLine({ kind: "goTo", place: { kind: "named", id: "market" } }, syms)!.b).toBe(
      "go + market",
    );
  });

  // ── A PLACEMENT NAMES ITS ANCHOR. `place` was the one transfer shape that
  // dropped its endpoint while fetch/give/putIn all spoke theirs, so an obeyed
  // order and a misheard one sounded identical ("I'll put the chair"). The
  // spoken join is the BOARD WORD for the relation — `beside` says `next_to`.

  it("place names WHERE: 'I'll put the chair next to the table'", () => {
    const line = goalIntentLine(
      { kind: "place", item: { match: { kind: "chair" } }, at: { relation: "beside", anchor: { kind: "named", id: "table" } } },
      syms,
    )!;
    expect(line.a).toBe("chair");
    expect(line.b).toBe("chair + next_to + table");
    expect(line.c).toBe("put + chair + next_to + table");
    // The same 4-slot shape putIn uses — the subject drops and `.will` carries
    // the first person.
    expect(asIntent(line).c).toBe("put.will + chair + next_to + table");
    expect(translateGlyph(asIntent(line).c, "en")).toBe("I will put the chair next to the table.");
  });

  it("near stays near — the two proximity relations are never collapsed", () => {
    const near = goalIntentLine(
      { kind: "place", item: { match: { kind: "chair" } }, at: { relation: "near", anchor: { kind: "named", id: "table" } } },
      syms,
    )!;
    expect(near.c).toBe("put + chair + near + table");
    expect(translateGlyph(asIntent(near).c, "en")).toBe("I will put the chair near the table.");
  });

  it("a containment placement speaks its room ('in the kitchen')", () => {
    const line = goalIntentLine(
      { kind: "place", item: { match: { kind: "chair" } }, at: { relation: "in", anchor: { kind: "named", id: "kitchen" } } },
      syms,
    )!;
    expect(line.c).toBe("put + chair + in + kitchen");
  });

  it("a POINT anchor names nothing, so the line stays bare (the gaze 'here')", () => {
    const line = goalIntentLine(
      { kind: "place", item: { match: { kind: "chair" } }, at: { relation: "at", anchor: { kind: "point", x: 3, y: 4 } } },
      syms,
    )!;
    expect(line.c).toBe("i_me + put + chair");
    // Even a NAMED relation drops when the anchor is a bare point — there is
    // no thing for "near" to hold onto.
    const nearPoint = goalIntentLine(
      { kind: "place", item: { match: { kind: "chair" } }, at: { relation: "near", anchor: { kind: "point", x: 3, y: 4 } } },
      syms,
    )!;
    expect(nearPoint.c).toBe("i_me + put + chair");
  });

  it("a relation the lang layer cannot SAY stays silent rather than degrading", () => {
    // `on` is a device-state adjective (core.ts DEVICE_STATE wins over the
    // preposition) and `at` has no lexeme — speaking either would drop the
    // sentence to the telegraphic gloss. Better a bare line.
    for (const relation of ["on", "at"] as const) {
      const line = goalIntentLine(
        { kind: "place", item: { match: { kind: "chair" } }, at: { relation, anchor: { kind: "named", id: "table" } } },
        syms,
      )!;
      expect(`${relation}:${line.c}`).toBe(`${relation}:i_me + put + chair`);
    }
  });

  it("the vertical + facing relations earned lexemes and now speak (front as in_front_of)", () => {
    for (const [relation, join] of [
      ["under", "under"],
      ["over", "over"],
      ["behind", "behind"],
      ["front", "in_front_of"],
    ] as const) {
      const line = goalIntentLine(
        { kind: "place", item: { match: { kind: "chair" } }, at: { relation, anchor: { kind: "named", id: "table" } } },
        syms,
      )!;
      expect(line.c).toBe(`put + chair + ${join} + table`);
    }
    const behind = goalIntentLine(
      { kind: "place", item: { match: { kind: "chair" } }, at: { relation: "behind", anchor: { kind: "named", id: "table" } } },
      syms,
    )!;
    expect(translateGlyph(asIntent(behind).c, "en")).toBe("I will put the chair behind the table.");
    const front = goalIntentLine(
      { kind: "place", item: { match: { kind: "chair" } }, at: { relation: "front", anchor: { kind: "named", id: "table" } } },
      syms,
    )!;
    expect(translateGlyph(asIntent(front).c, "en")).toBe("I will put the chair in front of the table.");
  });

  it("every goal kind yields a speakable line (no silent arm)", () => {
    const goals: GoalSpec[] = [
      { kind: "fetch", item: { match: { kind: "wood" } } },
      { kind: "give", item: { match: { kind: "wood" } }, to: "bear" },
      { kind: "putIn", item: { match: { kind: "wood" } }, container: { kind: "named", id: "box" } },
      { kind: "place", item: { match: { kind: "chair" } }, at: { relation: "near", anchor: { kind: "named", id: "table" } } },
      { kind: "goTo", place: { kind: "named", id: "market" } },
      { kind: "goHome" },
      { kind: "follow", target: "bear" },
      { kind: "stay" },
      { kind: "toggle", device: { match: { kind: "window" } }, state: "open" },
      { kind: "transform", item: { match: { kind: "apple" } }, state: "hot" },
      { kind: "satisfy", need: "eat" },
      { kind: "socialAct", target: "bear", act: "hug" },
      { kind: "help", target: "bear" },
      { kind: "build", structure: "town", cap: 1 },
    ];
    for (const g of goals) {
      const line = goalIntentLine(g, syms);
      expect(line).not.toBeNull();
      expect(line!.c.length).toBeGreaterThan(0);
      // The lang layer must never crash on it (gloss fallback at worst).
      expect(translateGlyph(line!.c, "en").length).toBeGreaterThan(0);
    }
  });
});

describe("asIntent — the STATEMENT-OF-INTENT syntax (.will)", () => {
  it("marks the verb so the line reads 'I will …', never an imperative", () => {
    const line = goalIntentLine({ kind: "fetch", item: { match: { kind: "wood" } } }, syms)!;
    const intent = asIntent(line);
    expect(intent.c).toBe("i_me + get.will + wood");
    // Level b has no subject — the will marker itself forces first person.
    expect(intent.b).toBe("get.will + wood");
    expect(translateGlyph(intent.b, "en")).toBe("I will get the wood.");
    expect(translateGlyph(intent.c, "en")).toBe("I will get the wood.");
  });

  it("renders the going-to future in every ruleset", () => {
    const line = asIntent(goalIntentLine({ kind: "consume", item: { match: { kind: "apple" } } }, syms)!);
    expect(translateGlyph(line.c, "en")).toBe("I will eat the apple.");
    expect(translateGlyph(line.c, "he")).toBe("אני הולך לאכול את התפוח.");
    expect(translateGlyph(line.c, "he", { speaker: "f" })).toBe("אני הולכת לאכול את התפוח.");
    expect(translateGlyph(line.c, "es")).toBe("Voy a comer la manzana.");
    expect(translateGlyph(line.c, "pt")).toBe("Eu vou comer a maçã.");
  });

  it("marks movement intent through the going frame", () => {
    const line = asIntent(goalIntentLine({ kind: "goTo", place: { kind: "named", id: "market" } }, syms)!);
    expect(line.c).toBe("i_me + go.will + to + market");
    expect(translateGlyph(line.c, "en")).toBe("I will go to the market.");
  });

  it("never marks a line that would degrade to the telegraphic gloss", () => {
    // A give-with-recipient has 4 content slots — its c-level drops the
    // subject and glosses; the marker must stay off rather than emit
    // "give will apple you".
    const line = goalIntentLine({ kind: "give", item: { match: { kind: "apple" } }, to: "__player__" }, syms)!;
    const intent = asIntent(line);
    expect(translateGlyph(intent.c, "en")).not.toContain("will will");
    expect(translateGlyph(intent.c, "en").toLowerCase()).not.toMatch(/\bwill\b.*\bwill\b/);
  });

  it("level a (the bare teaching slot) is never marked", () => {
    const line = asIntent(goalIntentLine({ kind: "fetch", item: { match: { kind: "wood" } } }, syms)!);
    expect(line.a).toBe("wood");
  });
});

describe("the deixis marker — '.this' names the PARTICULAR instance", () => {
  it("renders the demonstrative in every ruleset", () => {
    expect(translateGlyph("i_me + eat.will + apple.this", "en")).toBe("I will eat this apple.");
    expect(translateGlyph("i_me + eat.will + apple.this", "he")).toBe("אני הולך לאכול את התפוח הזה.");
    expect(translateGlyph("i_me + eat.will + apple.this", "es")).toBe("Voy a comer esta manzana.");
    expect(translateGlyph("i_me + eat.will + apple.this", "pt")).toBe("Eu vou comer esta maçã.");
  });

  it("wear + this garment ('I will wear this shirt')", () => {
    expect(translateGlyph("i_me + wear.will + shirt.this", "en")).toBe("I will wear this shirt.");
  });
});

describe("attention-act shapes — the table's spoken intents", () => {
  it("a bed speaks SLEEP, a bath WASH, a toilet the bathroom trip", () => {
    const sleep = goalIntentLine({ kind: "rest", place: { kind: "named", id: "bed" }, pose: "sleep" }, syms)!;
    expect(translateGlyph(asIntent(sleep).c, "en")).toBe("I will sleep.");
    const wash = goalIntentLine({ kind: "rest", place: { kind: "named", id: "bath" } }, syms)!;
    expect(translateGlyph(asIntent(wash).c, "en")).toBe("I will wash.");
    const toilet = goalIntentLine({ kind: "rest", place: { kind: "named", id: "toilet" } }, syms)!;
    expect(translateGlyph(asIntent(toilet).c, "en")).toBe("I will go to the bathroom.");
  });

  it("play with a particular toy ('I will play with this ball')", () => {
    expect(translateGlyph("i_me + play.will + ball.this", "en")).toBe("I will play with this ball.");
    expect(translateGlyph("i_me + play.will + ball.this", "he")).toBe("אני הולך לשחק בכדור הזה.");
  });

  it("talk to a partner ('I will talk to the bear')", () => {
    const line = asIntent(goalIntentLine({ kind: "converse", target: "bear" }, syms)!);
    expect(translateGlyph(line.c, "en")).toBe("I will talk to the bear.");
  });

  it("the refusal lines speak proper negation", () => {
    expect(translateGlyph("i_me + hungry.not", "en")).toBe("I'm not hungry.");
    expect(translateGlyph("i_me + need.not + bathroom", "en")).toBe("I don't need the bathroom.");
  });
});

describe("the criteria hook — ONE conservative gate, tuned later", () => {
  const goal: GoalSpec = { kind: "fetch", item: { match: { kind: "wood" } } };

  it("announces when CLAIMING a pooled task", () => {
    expect(
      defaultAnnounceCriteria({ creatureId: "wolf_1", goal, source: "task-claim", taskId: "task_0", issuer: "__player__" }),
    ).toBe(true);
  });

  it("stays quiet for routine self-directed behavior and direct commands", () => {
    expect(defaultAnnounceCriteria({ creatureId: "wolf_1", goal, source: "need" })).toBe(false);
    expect(defaultAnnounceCriteria({ creatureId: "wolf_1", goal, source: "rule" })).toBe(false);
    expect(defaultAnnounceCriteria({ creatureId: "wolf_1", goal, source: "command" })).toBe(false);
  });
});
