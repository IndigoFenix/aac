// THE LAW SUBSTRATE (nations P2 — behavior/laws.ts + game.culture):
// prohibitions with tiers (custom < law < ABSOLUTE), area scoping with
// innermost-wins, the "no + verb" forbid sentence, the compile arm, the
// selectGoal absolute veto (prunes even survival-tier candidates and
// outranks every author), and the manifest culture gate. Pure — no DOM.

import { describe, it, expect } from "@jest/globals";
import {
  absoluteLaws, addLaw, absolutelyForbidden, goalVerb, governingLaw,
  type Law,
} from "@shared/world-engine/interaction/behavior/laws.js";
import { parseWorldCultureSpec, resolveWorldCulture } from "@shared/world-engine/culture.js";
import { parseGameSettings } from "@shared/world-engine/kernel/manifest.js";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { compileIntent, defaultBinder } from "@shared/world-engine/interaction/intent/intent-compile.js";
import { selectGoal } from "@shared/world-engine/interaction/behavior/goal-selection.js";
import type { Rule, RuleContext } from "@shared/world-engine/interaction/behavior/rules.js";
import { tabooRefusalLine } from "@shared/world-engine/interaction/dialogue/law-lines.js";

const anywhere = () => true;

describe("laws — tiers, areas, precedence", () => {
  it("founds the absolute ring from culture absolutes (issuer world, everywhere)", () => {
    const laws = absoluteLaws(resolveWorldCulture({ absolutes: ["fight"] }).absolutes);
    expect(laws).toEqual([
      { ord: 0, tier: "absolute", forbid: "fight", area: { kind: "everywhere" }, issuer: "world" },
    ]);
    expect(absolutelyForbidden(laws, "fight", anywhere)).toBe(true);
    expect(absolutelyForbidden(laws, "build", anywhere)).toBe(false);
  });

  it("governingLaw: higher tier wins, then more specific area, then later ord", () => {
    const laws: Law[] = [];
    addLaw(laws, { tier: "custom", forbid: "build", area: { kind: "everywhere" }, issuer: "a" });
    addLaw(laws, { tier: "law", forbid: "build", area: { kind: "town" }, issuer: "b" });
    addLaw(laws, { tier: "custom", forbid: "build", area: { kind: "town" }, issuer: "c" });
    expect(governingLaw(laws, "build", anywhere)?.issuer).toBe("b"); // law > custom
    // Outside the town only the everywhere custom binds.
    const outside = (a: { kind: string }) => a.kind === "everywhere";
    expect(governingLaw(laws, "build", (a) => outside(a))?.issuer).toBe("a");
    expect(governingLaw(laws, "trade", anywhere)).toBeNull();
    // Same tier + same area rank: later ord wins.
    const dup: Law[] = [];
    addLaw(dup, { tier: "custom", forbid: "go", area: { kind: "town" }, issuer: "x" });
    addLaw(dup, { tier: "custom", forbid: "go", area: { kind: "town" }, issuer: "y" });
    expect(governingLaw(dup, "go", anywhere)?.issuer).toBe("y");
  });

  it("goalVerb maps the veto-able goals and leaves the rest alone", () => {
    expect(goalVerb({ kind: "build", type: "house" } as never)).toBe("build");
    expect(goalVerb({ kind: "fetch", item: { match: "food" } } as never)).toBe("get");
    expect(goalVerb({ kind: "stay", place: { kind: "point" } } as never)).toBeNull();
  });
});

describe("the forbid sentence — 'no + fight' is a LAW, not a command", () => {
  it("parses to kind forbid with the verb", () => {
    const frame = parseSentence("no + fight", {});
    expect(frame.kind).toBe("forbid");
    expect(frame.verb).toBe("fight");
  });

  it("compiles to a law row the host installs", () => {
    const frame = parseSentence("no + fight", {});
    const compiled = compileIntent(frame, defaultBinder({}), { id: "t" });
    expect(compiled).toMatchObject({ kind: "law", forbid: "fight" });
  });

  it("leaves bare 'no' (decline) and plain commands untouched", () => {
    expect(parseSentence("no", {}).kind).toBe("decline");
    expect(parseSentence("you + go + there", {}).kind).toBe("command");
  });

  it("speaks the taboo as a cultural we-statement", () => {
    const line = tabooRefusalLine("fight");
    expect(line.c).toBe("we + fight.not");
    expect(line.a).toBe("no");
  });
});

describe("the absolute veto in selectGoal — pruned, not outweighed", () => {
  const self = { id: "c1", needs: [], condition: "content" } as never;
  const ctx: RuleContext = { self, world: { creatures: {}, items: {} } as never, worldConditions: new Set(["night"]) };
  const buildRule: Rule = {
    id: "r1", author: "player", binding: { kind: "all" },
    trigger: { kind: "worldState", token: "night" }, lifetime: "while",
    action: { kind: "build", type: "house" } as never,
    priority: 5, enabled: true, order: 0,
  };
  const relation = () => ({ affinity: 1, trust: 1, authority: 1 }); // maximal compliance

  it("a vetoed rule candidate never wins, whatever the author's authority", () => {
    const withVeto = selectGoal({
      ctx, rules: [buildRule], relationTo: relation as never,
      runtimes: new Map(), now: 0,
      veto: (g) => goalVerb(g) === "build",
    });
    expect(withVeto.chosen).toBeNull();
    const without = selectGoal({
      ctx, rules: [buildRule], relationTo: relation as never,
      runtimes: new Map(), now: 0,
    });
    expect(without.chosen?.goal).toMatchObject({ kind: "build" });
  });
});

describe("law persistence — authored rows ride SerializedTownDeltas", () => {
  it("round-trips laws through toJSON → createTownDeltas, deep-copied", async () => {
    const { createTownDeltas } = await import("@shared/world-engine/kernel/town/construction.js");
    const d = createTownDeltas();
    addLaw(d.laws, { tier: "law", forbid: "fight", area: { kind: "town" }, issuer: "player" });
    addLaw(d.laws, { tier: "law", forbid: "build", area: { kind: "district", ord: 2 }, issuer: "player" });
    const json = JSON.parse(JSON.stringify(d.toJSON()));
    const revived = createTownDeltas(json);
    expect(revived.toJSON()).toEqual(d.toJSON());
    expect(revived.laws).toHaveLength(2);
    expect(governingLaw(revived.laws, "fight", () => true)?.area).toEqual({ kind: "town" });
    // Mutating the revived store never touches the source JSON.
    addLaw(revived.laws, { tier: "custom", forbid: "go", area: { kind: "everywhere" }, issuer: "x" });
    expect(json.laws).toHaveLength(2);
  });
});

describe("area scoping — the containment oracle decides who a law binds", () => {
  it("a district law binds inside the district, the town law everywhere in town", () => {
    const laws: Law[] = [];
    addLaw(laws, { tier: "absolute", forbid: "build", area: { kind: "district", ord: 3 }, issuer: "world" });
    const inDistrict3 = (a: { kind: string; ord?: number }) =>
      a.kind === "town" || (a.kind === "district" && a.ord === 3);
    const outside = (a: { kind: string }) => a.kind === "town";
    expect(absolutelyForbidden(laws, "build", (a) => inDistrict3(a))).toBe(true);
    expect(absolutelyForbidden(laws, "build", (a) => outside(a))).toBe(false);
  });

  it("'no + fight + in + town' carries the bound area word to the frame", () => {
    const frame = parseSentence("no + fight + in + town", {});
    expect(frame.kind).toBe("forbid");
    expect(frame.verb).toBe("fight");
    expect(frame.bound).toEqual([
      { relation: "in", ref: { kind: "entity", symbol: "town", modifiers: [] } },
    ]);
  });
});

describe("game.culture — the manifest gate", () => {
  const base = {
    scope: "town", world: { seed: 1 },
  };

  it("parses a culture block and defaults to null", () => {
    const withCulture = parseGameSettings({ ...base, culture: { absolutes: ["fight"] } }, "game");
    expect(withCulture.culture).toEqual({ absolutes: ["fight"] });
    expect(parseGameSettings(base, "game").culture).toBeNull();
  });

  it("rejects unknown fields and bad shapes, path-exact", () => {
    expect(() => parseGameSettings({ ...base, culture: { taboos: [] } }, "game"))
      .toThrow(/game\.culture\.taboos/);
    expect(() => parseWorldCultureSpec({ absolutes: "fight" }, "p")).toThrow(/p\.absolutes/);
    expect(() => parseWorldCultureSpec({ absolutes: [""] }, "p")).toThrow(/p\.absolutes\[0\]/);
    expect(() => parseWorldCultureSpec({ absolutes: new Array(17).fill("x") }, "p"))
      .toThrow(/at most 16/);
  });

  it("resolves: absent = open culture; declared = the closed set", () => {
    expect(resolveWorldCulture(null).absolutes.size).toBe(0);
    expect(resolveWorldCulture({ absolutes: ["fight", "fight"] }).absolutes.has("fight")).toBe(true);
  });
});
