// PHYSICAL-CARRYING VERBS (world-engine-board-organization.md §5): pick_up /
// carry / drop are handling verbs, DISTINCT from get/take (acquire possession).
// They parse as directive verbs and compile onto the existing carry primitives —
// pick_up → fetch (walk + pick), carry → fetch or a carry-to putIn, drop → the
// release-here `drop` goal (bare) or containment (with a destination). No DOM/GL.

import { describe, it, expect } from "@jest/globals";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { compileIntent, defaultBinder } from "@shared/world-engine/interaction/intent/intent-compile.js";

const compile = (sentence: string) =>
  compileIntent(parseSentence(sentence), defaultBinder({ player: "__player__", listener: "bear" }), { id: "t1" });

describe("pick_up — the physical lift (fetch)", () => {
  it("'pick_up + ball' parses as a directive verb and compiles to fetch", () => {
    const frame = parseSentence("pick_up + ball");
    expect(frame.kind).toBe("command");
    expect(frame.verb).toBe("pick_up");
    const c = compile("pick_up + ball");
    expect(c.kind).toBe("goal");
    if (c.kind === "goal") expect(c.goal).toEqual({ kind: "fetch", item: { match: { kind: "ball" } } });
  });
});

describe("carry — hold, and optionally move to a destination", () => {
  it("'carry + ball' (no destination) → fetch (pick up and hold)", () => {
    const c = compile("carry + ball");
    expect(c.kind).toBe("goal");
    if (c.kind === "goal") expect(c.goal).toEqual({ kind: "fetch", item: { match: { kind: "ball" } } });
  });

  it("'carry + ball + to + box' → carry it there (putIn the named place)", () => {
    const c = compile("carry + ball + to + box");
    expect(c.kind).toBe("goal");
    if (c.kind === "goal") {
      expect(c.goal.kind).toBe("putIn");
      if (c.goal.kind === "putIn") {
        expect(c.goal.item).toEqual({ match: { kind: "ball" } });
        expect(c.goal.container).toEqual({ kind: "named", id: "box" });
      }
    }
  });

  it("a bare second noun is the destination: 'carry + ball + box'", () => {
    const c = compile("carry + ball + box");
    expect(c.kind).toBe("goal");
    if (c.kind === "goal") expect(c.goal.kind).toBe("putIn");
  });
});

describe("drop — release the held item", () => {
  it("bare 'drop + ball' → the release-here drop goal (no destination)", () => {
    const c = compile("drop + ball");
    expect(c.kind).toBe("goal");
    if (c.kind === "goal") expect(c.goal).toEqual({ kind: "drop", item: { match: { kind: "ball" } } });
  });

  it("'drop + ball + in + box' → containment (putIn), same as put", () => {
    const c = compile("drop + ball + in + box");
    expect(c.kind).toBe("goal");
    if (c.kind === "goal") expect(c.goal.kind).toBe("putIn");
  });
});

describe("get/take stay possession verbs (unchanged)", () => {
  it("'get + ball' still compiles to fetch (distinct WORD, same primitive)", () => {
    const c = compile("get + ball");
    expect(c.kind).toBe("goal");
    if (c.kind === "goal") expect(c.goal).toEqual({ kind: "fetch", item: { match: { kind: "ball" } } });
  });
});
