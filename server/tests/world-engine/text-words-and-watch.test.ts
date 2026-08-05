// TEXT MODE — the words a crowd line prints, and what may be watched.
//
// Two gaps a play session found, both of the same shape: the projection said
// something the driver could not act on.
//
//   • "2 bed" / "2 box". Plurals were authored per-noun (`plw`) and most nouns
//     have none, so a GENERATED count printed the singular. The ruleset now
//     carries its regular rule and `plw` is the irregular list.
//   • `look people` → nothing here called "people", one line under a scene that
//     had just printed "3 people, here west". The printed word must resolve.
//   • `watch house-2` was accepted and then never said anything, ever: the
//     watch book built its in-view map from subjects only, so a PLACE could
//     never be present, never leave, and never produce a delta.

import { describe, it, expect } from "@jest/globals";
import { languageFor } from "@shared/world-engine/interaction/lang/index.js";
import {
  createSceneIndex,
  createWatchBook,
  singularWord,
  wordFor,
} from "@shared/world-engine/interaction/text/index.js";
import type { VisibleScene, VisibleSubject } from "@shared/world-engine/interaction/text/index.js";

const en = languageFor("en");

const subject = (over: Partial<VisibleSubject> & { id: string }): VisibleSubject => ({
  kind: "creature",
  textId: "",
  head: "person",
  word: "person",
  band: "here",
  cardinal: "north",
  distance: 2,
  space: null,
  floor: 0,
  appearance: [],
  holding: [],
  ...over,
});

describe("wordFor — a count prints a plural even for nouns nobody marked", () => {
  it("uses the ruleset's regular rule where the lexicon authored none", () => {
    expect(wordFor(en, "bed", 2)).toBe("beds");
    expect(wordFor(en, "box", 2)).toBe("boxes");
  });

  it("keeps the AUTHORED plural — `plw` is the irregular list and wins", () => {
    expect(wordFor(en, "house", 2)).toBe("houses");
    expect(wordFor(en, "person", 2)).toBe("people");
  });

  it("leaves the singular alone at one", () => {
    expect(wordFor(en, "bed", 1)).toBe("bed");
  });
});

describe("singularWord — the printed plural is a handle", () => {
  it("inverts through the ruleset, irregulars included", () => {
    expect(singularWord(en, "people")).toBe("person");
    expect(singularWord(en, "houses")).toBe("house");
    expect(singularWord(en, "beds")).toBe("bed");
  });

  it("is undefined for a word no lexeme pluralizes to (never a guess)", () => {
    expect(singularWord(en, "wibbles")).toBeUndefined();
  });
});

describe("the scene index resolves the word a crowd line printed", () => {
  it("asks which one, instead of answering `nothing here called people`", () => {
    const index = createSceneIndex({ singularOf: (w) => singularWord(en, w) });
    index.assign([subject({ id: "a" }), subject({ id: "b", distance: 3 })]);
    const hit = index.resolve("people");
    expect(hit.kind).toBe("many");
    if (hit.kind === "many") expect(hit.ids.sort()).toEqual(["a", "b"]);
  });

  it("still lets an exact id win over a word that looks like a plural", () => {
    const index = createSceneIndex({ singularOf: (w) => singularWord(en, w) });
    index.assign([subject({ id: "a" })]);
    expect(index.resolve("person-1")).toEqual({ kind: "one", id: "a", textId: "person-1" });
  });
});

describe("the watch book tracks PLACES, not only bodies", () => {
  const scene = (places: VisibleSubject[]): VisibleScene => ({
    me: { id: "me", x: 0, y: 0, floor: 0, space: null },
    subjects: [],
    places,
    revealed: new Set<string>(),
  });
  const house = subject({ id: "h2", kind: "place", head: "house", word: "house" });

  it("emits EXIT when a watched building leaves view — never silent inertness", () => {
    const book = createWatchBook({ label: (id) => id, activityPhrase: () => undefined, cap: 8 });
    book.add("h2");
    const ctx = { tracked: new Set(["h2"]) };
    expect(book.step(scene([house]), ctx)).toEqual([]); // the baseline is silent
    const gone = book.step(scene([]), ctx);
    expect(gone.map((e) => e.tag)).toEqual(["EXIT"]);
  });

  it("re-enters when it comes back, so the watch is worth keeping", () => {
    const book = createWatchBook({ label: (id) => id, activityPhrase: () => undefined, cap: 8 });
    book.add("h2");
    const ctx = { tracked: new Set(["h2"]) };
    book.step(scene([house]), ctx);
    book.step(scene([]), ctx);
    expect(book.step(scene([house]), ctx).map((e) => e.tag)).toEqual(["ENTER"]);
  });
});
