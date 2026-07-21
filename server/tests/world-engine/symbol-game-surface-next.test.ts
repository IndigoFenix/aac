// The deterministic button surfacer (surface-next.ts): given the tokens so
// far, only MEANINGFUL continuations surface — a next-token model driven by
// the parser's own frame semantics + noun affordances. Zero RNG. Pure.

import { describe, it, expect } from "@jest/globals";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import {
  emptyRecency,
  noteUtterance,
  surfaceNext,
  TYPE_CHIPS,
  type SurfaceContext,
  type SurfaceNoun,
} from "@shared/world-engine/interaction/intent/surface-next.js";

const NOUNS: SurfaceNoun[] = [
  { symbol: "apple", kind: "item", affords: ["eat", "want", "get", "give"] },
  { symbol: "ball", kind: "item", affords: ["get", "give", "play", "throw", "want"] },
  { symbol: "clothing", kind: "item", affords: ["wear", "wash", "want", "give"] },
  { symbol: "mara", kind: "creature", affords: ["talk", "help", "hug", "give", "follow"] },
  { symbol: "bed", kind: "place", affords: ["go", "sleep"] },
  { symbol: "home", kind: "place", affords: ["go"] },
];

const ctx = (extra: Partial<SurfaceContext> = {}): SurfaceContext => ({ nouns: NOUNS, ...extra });
const symbols = (tokens: string[], c = ctx()) => surfaceNext(tokens, c).buttons.map((b) => b.symbol);

describe("surfaceNext — continuations", () => {
  it("empty sentence: hybrid openers + the sentence-type chips", () => {
    const s = surfaceNext([], ctx());
    expect(s.typeChips).toEqual([...TYPE_CHIPS]);
    const syms = s.buttons.map((b) => b.symbol);
    expect(syms).toContain("i_me");
    expect(syms).toContain("you");
    expect(syms).toContain("want");
    expect(syms).toContain("where");
    expect(syms).toContain("hi");
    expect(s.complete).toBe(false);
  });

  it("a seeded sentence type constrains the openers", () => {
    const ask = surfaceNext([], ctx({ seedKind: "ask" }));
    const askSyms = ask.buttons.map((b) => b.symbol);
    expect(askSyms).toContain("where");
    expect(askSyms).toContain("what");
    const social = surfaceNext([], ctx({ seedKind: "greet" }));
    expect(social.buttons.every((b) => ["hi", "hello", "bye", "goodbye", "yes", "no", "ok", "okay", "thanks", "sorry", "mine", "again", "dont_understand", "confused"].includes(b.symbol))).toBe(true);
  });

  it("after a verb, objects are ranked by AFFORDANCE (eat → apple first)", () => {
    const syms = symbols(["you", "eat"]);
    expect(syms[0]).toBe("apple"); // the only noun that affords eat
    expect(syms).toContain("ball"); // everything else still reachable, lower
  });

  it("after a movement verb, PLACES are the destinations", () => {
    const s = surfaceNext(["you", "go"], ctx());
    expect(s.open[0]).toBe("destination");
    const syms = s.buttons.map((b) => b.symbol);
    expect(syms).toContain("bed");
    expect(syms).toContain("home");
    expect(s.buttons.find((b) => b.symbol === "bed")!.weight)
      .toBeGreaterThan(s.buttons.find((b) => b.symbol === "mara")?.weight ?? 0);
  });

  it("a transfer verb with an object opens the RECIPIENT", () => {
    const s = surfaceNext(["give", "apple"], ctx());
    expect(s.open).toContain("recipient");
    const syms = s.buttons.map((b) => b.symbol);
    expect(syms).toContain("mara");
    expect(syms).toContain("i_me");
    expect(syms).toContain("to");
  });

  it("a dangling relation HARD-FILTERS to nouns", () => {
    const s = surfaceNext(["give", "apple", "to"], ctx());
    expect(s.open).toEqual(["relation-noun"]);
    for (const b of s.buttons) {
      expect(["mara", "apple", "ball", "clothing", "bed", "home", "i_me", "you"]).toContain(b.symbol);
    }
    expect(s.buttons[0]!.symbol).toBe("mara"); // creatures fit "to" best
  });

  it("where → nouns and persons only; how → creatures", () => {
    const where = symbols(["where"]);
    expect(where).toContain("mara");
    expect(where).toContain("ball");
    expect(where).toContain("you");
    const how = surfaceNext(["how"], ctx());
    expect(how.buttons[0]!.symbol === "mara" || how.buttons[0]!.symbol === "you").toBe(true);
  });

  it("a bare noun surfaces the verbs IT affords (composeNeed reversed)", () => {
    const s = surfaceNext(["clothing"], ctx());
    const syms = s.buttons.map((b) => b.symbol);
    expect(syms.indexOf("wash")).toBeGreaterThanOrEqual(0);
    expect(syms.indexOf("wash")).toBeLessThan(syms.indexOf("dig") < 0 ? Infinity : syms.indexOf("dig"));
    expect(syms).toContain("wear");
  });

  it("when/if opens the CONDITION vocabulary", () => {
    const s = surfaceNext(["when"], ctx());
    expect(s.open[0]).toBe("condition");
    const syms = s.buttons.map((b) => b.symbol);
    expect(syms).toContain("hungry");
    expect(syms).toContain("night");
  });

  it("recency: a just-mentioned noun earns an opener slot", () => {
    const mem = noteUtterance(emptyRecency(), parseSentence("i_me + want + ball"));
    const s = surfaceNext([], ctx({ recency: mem }));
    expect(s.buttons.some((b) => b.symbol === "ball" && b.role === "opener")).toBe(true);
  });
});

describe("surfaceNext — determinism, budget, completeness", () => {
  it("same input twice → identical output; noun order does not matter", () => {
    const a = surfaceNext(["you", "eat"], ctx());
    const b = surfaceNext(["you", "eat"], ctx());
    expect(a).toEqual(b);
    const shuffled = [...NOUNS].reverse();
    const c = surfaceNext(["you", "eat"], ctx({ nouns: shuffled }));
    expect(c.buttons.map((x) => x.symbol)).toEqual(a.buttons.map((x) => x.symbol));
  });

  it("never exceeds capacity; every open role keeps a representative", () => {
    const s = surfaceNext(["give", "apple"], ctx({ capacity: 6 }));
    expect(s.buttons.length).toBeLessThanOrEqual(6);
    for (const role of s.open) {
      expect(s.buttons.some((b) => b.role === role)).toBe(true);
    }
  });

  it("completeness follows the frame: verbs with optional objects, transfers need one", () => {
    expect(surfaceNext(["you", "sleep"], ctx()).complete).toBe(true);
    expect(surfaceNext(["you", "give"], ctx()).complete).toBe(false);
    expect(surfaceNext(["you", "give", "apple"], ctx()).complete).toBe(true);
    expect(surfaceNext(["hi"], ctx()).complete).toBe(true);
    expect(surfaceNext(["where", "mara"], ctx()).complete).toBe(true);
    expect(surfaceNext(["mara", "hungry"], ctx()).complete).toBe(true);
    expect(surfaceNext(["when", "night", "you", "sleep"], ctx()).complete).toBe(true);
    expect(surfaceNext(["when", "night"], ctx()).complete).toBe(false);
  });

  it("INVARIANT: every surfaced completion still parses to a non-unclear frame", () => {
    const starts: string[][] = [[], ["i_me"], ["you"], ["where"], ["i_me", "want"], ["give", "apple"], ["apple"]];
    for (const start of starts) {
      const s = surfaceNext(start, ctx());
      for (const b of s.buttons) {
        const frame = parseSentence([...start, b.symbol].join(" + "));
        expect(`${start.join("+")}▸${b.symbol}:${frame.kind}`).not.toContain(":unclear");
      }
    }
  });
});
