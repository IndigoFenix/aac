// INTENT ANNOUNCEMENTS (city-expansion phase ①a §3): a creature states what it
// is ABOUT to do before doing it ("I'll get the wood"). Pins the goal → glyph
// line mapping (dialogue/intent-lines.ts), its rendering through the shared
// game lang layer (never client i18n), and the criteria hook's conservative
// default (announce on a pooled-task claim; quiet otherwise).
// Pure logic — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
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
