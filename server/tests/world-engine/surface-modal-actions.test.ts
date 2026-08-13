// THE ACTION PATH AFTER A DESIRE VERB (user decision 2026-08-12). "i_me +
// want + ___" used to offer only THINGS: the parser has read "want + play" as
// a modal wish all along (parse-intent VERB COMPOSITION), but the board never
// suggested an action and `complete` never lit for one — the sentence existed
// only for a child who already knew it did. Now a bare want/need/like opens
// DOING beside having:
//   • the nouns still LEAD (a request for a thing is the first reading),
//   • a handful of most-likely actions ride inline — the child's own habit
//     (pair/use counts) first, then the frequency prior,
//   • the breadth ships as ACTION-CATEGORY chips ([do]/[play]/[make]/[get]),
//     a band of its own BEHIND the noun chips, never competing for their
//     MAX_GROUPS budget,
//   • the modal sentence is sayable exactly when its inner verb would be
//     complete as a command ("want + play" yes, "want + get" not yet).
//
// The categories cluster WORDS, never scene state: whether an action makes
// sense for the current body (a bodiless spirit cannot brush teeth) is the
// host's business when the sentence lands — out of the game the builder must
// still offer the whole set, because "I want to sleep" is a sentence a
// student needs at school far more often than in any game.

import { describe, it, expect } from "@jest/globals";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import {
  emptyRecency,
  noteUtterance,
  surfaceNext,
  type SurfaceContext,
  type SurfaceNoun,
} from "@shared/world-engine/interaction/intent/surface-next.js";
import { builderSurfaceFor } from "@shared/world-engine/interaction/intent/builder-surface.js";

const NOUNS: SurfaceNoun[] = [
  { symbol: "apple", kind: "item", affords: ["eat", "want", "get", "give"], properties: ["food"] },
  { symbol: "ball", kind: "item", affords: ["get", "give", "play", "throw", "want"], properties: ["toy"] },
  { symbol: "mara", kind: "creature", affords: ["talk", "help", "hug", "give"] },
  { symbol: "bed", kind: "place", affords: ["go", "sleep"], properties: ["furniture"] },
  { symbol: "home", kind: "place", affords: ["go"] },
];

const ctx = (extra: Partial<SurfaceContext> = {}): SurfaceContext => ({ nouns: NOUNS, ...extra });
const board = (tokens: string[], c = ctx()) => surfaceNext(tokens, c);
const syms = (tokens: string[], c = ctx()) => board(tokens, c).buttons.map((b) => b.symbol);
const actionIds = (tokens: string[], c = ctx()) =>
  board(tokens, c).groups.filter((g) => g.kind === "verb").map((g) => g.id);

describe("the action band a bare desire verb opens", () => {
  it("want offers actions INLINE — common first — with the nouns still leading", () => {
    const s = board(["i_me", "want"]);
    const k = s.buttons.map((b) => b.symbol);
    // Things a child wants lead (afford-want items outrank every action)…
    expect(k.slice(0, 2).sort()).toEqual(["apple", "ball"]);
    // …and the most common actions stand right behind them, as verbs.
    for (const v of ["go", "eat", "play"]) {
      expect({ v, role: s.buttons.find((b) => b.symbol === v)?.role }).toEqual({ v, role: "verb" });
    }
    expect(k.indexOf("go")).toBeGreaterThan(k.indexOf("ball"));
    expect(s.open).toContain("verb");
  });

  it("need and like open the same path", () => {
    for (const modal of ["need", "like"]) {
      expect({ modal, ids: actionIds([modal]) }).toEqual({ modal, ids: ["do", "play", "make", "get"] });
      expect({ modal, has: syms([modal]).includes("eat") }).toEqual({ modal, has: true });
    }
  });

  it("the four action categories ride as chips BEHIND the noun chips", () => {
    // A library too wide for the grid, so a noun cluster genuinely stands
    // (more foods than the 8 slots can hold — [food] must chip).
    const wide = ctx({
      nouns: [
        ...NOUNS,
        ...["cookie", "bread", "grape", "milk", "cheese", "broccoli"].map((symbol) => ({
          symbol,
          kind: "item" as const,
          affords: ["eat", "want", "get"],
          properties: ["food"],
        })),
      ],
      capacity: 8,
    });
    const s = board(["i_me", "want"], wide);
    const verbs = s.groups.filter((g) => g.kind === "verb");
    expect(verbs.map((g) => g.id)).toEqual(["do", "play", "make", "get"]);
    // A band of its own: the noun clusters keep their budget and precede it.
    const firstVerb = s.groups.findIndex((g) => g.kind === "verb");
    expect(firstVerb).toBeGreaterThan(0);
    expect(s.groups.slice(0, firstVerb).some((g) => g.id === "food")).toBe(true);
    expect(s.groups.slice(0, firstVerb).every((g) => g.kind !== "verb")).toBe(true);
    // Each chip opens a real breadth and wears its top actions as the face.
    for (const g of verbs) {
      expect(g.members.length).toBeGreaterThanOrEqual(2);
      expect(g.exemplars.length).toBeGreaterThan(0);
      for (const e of g.exemplars) expect(g.members).toContain(e);
      const weights = g.members.map((m) => m.weight);
      expect(weights).toEqual([...weights].sort((a, b) => b - a));
    }
  });

  it("every offered action composes to a sentence that PARSES as the wish", () => {
    const s = board(["i_me", "want"]);
    for (const g of s.groups.filter((gr) => gr.kind === "verb")) {
      for (const m of g.members) {
        const frame = parseSentence(`i_me + want + ${m.symbol}`);
        expect(`${m.symbol}:${frame.kind}/${frame.modal}/${frame.verb}`).toBe(
          `${m.symbol}:request/want/${m.symbol}`,
        );
      }
    }
  });

  it("the band stands down everywhere else", () => {
    expect(actionIds(["you", "eat"])).toEqual([]); // an ordinary verb
    expect(actionIds(["i_me", "want", "apple"])).toEqual([]); // the thing is named
    expect(actionIds(["want", "eat"])).toEqual([]); // the action landed — eat's own bands now
    expect(actionIds([])).toEqual([]); // the empty board keeps its openers
  });

  it("after the action lands, the inner verb's own bands take over", () => {
    const s = board(["i_me", "want", "eat"]);
    expect(s.buttons[0]!.symbol).toBe("apple"); // eat → food leads, as ever
    expect(s.subTab).toBe("food");
  });

  it("the child's own habit picks the inline actions (recency personalizes)", () => {
    let mem = emptyRecency();
    for (let i = 0; i < 2; i++) mem = noteUtterance(mem, parseSentence("i_me + want + play"));
    const cold = syms(["i_me", "want"]);
    const warm = syms(["i_me", "want"], ctx({ recency: mem }));
    // Cold, frequency alone ranks go before play; this child says want+play.
    expect(cold.indexOf("go")).toBeLessThan(cold.indexOf("play"));
    expect(warm.indexOf("play")).toBeLessThan(warm.indexOf("go"));
  });
});

describe("a modal wish is sayable when its inner verb is whole", () => {
  const complete = (sentence: string): boolean =>
    board(sentence.split(" + ")).complete;

  it("bare-complete actions light Play at once", () => {
    for (const s of ["i_me + want + play", "want + eat", "i_me + need + sleep", "need + go", "i_me + want + help"]) {
      expect({ s, complete: complete(s) }).toEqual({ s, complete: true });
    }
  });

  it("a transitive action stays open until its object lands", () => {
    expect(complete("i_me + want + get")).toBe(false);
    expect(complete("i_me + want + get + ball")).toBe(true);
    expect(complete("i_me + want + make")).toBe(false);
  });

  it("the old thing-request law is untouched", () => {
    expect(complete("i_me + want")).toBe(false);
    expect(complete("i_me + want + apple")).toBe(true);
  });
});

describe("the wire adapter carries the action band (the out-of-game builder)", () => {
  it("the chips arrive localized, and echoing an id filters to its actions", () => {
    const en = builderSurfaceFor("i_me + want", { nouns: [] });
    const chipIds = (en.groups ?? []).map((g) => g.id);
    for (const id of ["do", "play", "make", "get"]) expect(chipIds).toContain(id);
    // The label is the lang layer's own word — a Hebrew board reads Hebrew.
    const he = builderSurfaceFor("i_me + want", { nouns: [], locale: "he-IL" });
    const label = (s: typeof en, id: string) => (s.groups ?? []).find((g) => g.id === id)!.label;
    expect(label(he, "do")).not.toBe(label(en, "do"));
    // Opening a chip lists that category's actions, ranked.
    const opened = builderSurfaceFor("i_me + want", { nouns: [], group: "do" });
    const keys = opened.buttons.map((b) => b.key);
    expect(keys).toContain("eat");
    expect(keys).toContain("sleep");
    expect(keys).not.toContain("play"); // play lives in its own category
  });
});
