// EVERY WORD THE BOARD OFFERS IS REACHABLE FROM IT.
//
// The surfacer withholds objects from the grid on purpose — a desire board that
// lists the whole pantry is a board a child cannot scan — and promises they are
// one press away in a chip. `surface-next.ts` says so in its own words:
//
//   "Withholding an object is a promise that it is one press away; this is the
//    half of the promise the chips cannot keep."
//
// Nothing enforced it, and the promise broke. `isChipped` predicted the chips
// by mirroring `buildGroups`' clustering and its two-member rule — but NOT
// `MAX_GROUPS`. Kind clusters (`animals`, `creatures`, `plants`, `things`,
// the place groups) were absent from OBJECT_PROPERTIES, so `propOrder` sorted
// every one of them behind every property chip, tied, and the slice cut them.
// The `animals` cluster — FIFTY-NINE members — was built and discarded on every
// desire board, while `isChipped` told the backstop those creatures were safe.
//
// Measured on "i_me + want" before the fix: 62 of 67 creatures reachable by no
// route at all. A child could not say "I want the dog".
//
// This file is the enforcement. It asks the only question that matters and asks
// it of the RENDERED board, not of a prediction: for each frame, is every noun
// the board pools either a button or a member of a chip that survived?

import { describe, it, expect } from "@jest/globals";
import { surfaceNext } from "@shared/world-engine/interaction/intent/surface-next.js";
import { defaultBuilderNouns } from "@shared/world-engine/interaction/intent/builder-surface.js";
import { tokenizeSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import type { SurfaceNoun } from "@shared/world-engine/interaction/intent/surface-next.js";

const NOUNS: SurfaceNoun[] = defaultBuilderNouns().map((n) => ({
  symbol: n.symbol,
  ...((n as { label?: string }).label ? { label: (n as { label?: string }).label! } : {}),
  kind: (n.kind ?? "unknown") as SurfaceNoun["kind"],
  affords: n.affords ?? ["want", "get", "give"],
  properties: n.properties ?? [],
}));

/** What the board actually offers: buttons + every member of every chip that
 *  survived the cut. Deliberately NOT `isChipped` — asking the predictor
 *  whether its own prediction held is how this went unnoticed. */
function reachable(partial: string, nouns: SurfaceNoun[] = NOUNS, capacity?: number): Set<string> {
  const s = surfaceNext(tokenizeSentence(partial), { nouns, ...(capacity ? { capacity } : {}) });
  const out = new Set(s.buttons.map((b) => b.symbol));
  for (const g of s.groups) for (const m of g.members) out.add(m.symbol);
  return out;
}

/** A ROUTE question, asked with the grid budget out of the way. Two different
 *  things can hide a word: no route to it (the bug — a chip that was cut, or a
 *  cluster that never rendered) and a full grid (`capacity`, working as
 *  designed — the word is on a later page). Only the first is a defect, so the
 *  invariant is measured with room to spare. At the default 16 one word
 *  (`paper`, the lone `material`) sits past the budget; that is the grid doing
 *  its job, not a word lost. */
const ROOMY = 400;

/** Places are withheld from a desire board BY DESIGN — "a place is not a thing
 *  you want" (user decision 2026-08-24); they belong to the GO board. So the
 *  invariant is about what a frame pools, not about the whole library. */
const isPlace = (symbol: string): boolean =>
  NOUNS.find((n) => n.symbol === symbol)?.kind === "place";

describe("every noun a board pools is reachable from it", () => {
  it("a desire offers every non-place noun — the case that was broken", () => {
    const got = reachable("i_me + want", NOUNS, ROOMY);
    const missing = NOUNS.map((n) => n.symbol).filter((s) => !isPlace(s) && !got.has(s));
    expect(missing).toEqual([]);
  });

  it("the empty board reaches its library except two lone words — KNOWN GAP", () => {
    // Pinned rather than quietly fixed. The weight-0 backstop that catches an
    // unchipped noun lives in the DESIRE branch only, so on the empty board a
    // word whose only property has a single member belongs to no cluster, earns
    // no chip, and no band adds it: `book` (the lone `book`) and `paper` (the
    // lone `material`). Same defect class as the animals, different board — and
    // closing it changes what the very first screen offers, which is a decision
    // rather than a patch. This will fail loudly if it moves in either
    // direction.
    const got = reachable("", NOUNS, ROOMY);
    const missing = NOUNS.map((n) => n.symbol).filter((s) => !isPlace(s) && !got.has(s));
    expect(missing.sort()).toEqual(["book", "paper"]);
  });

  it("…including the animals, all of them", () => {
    // The headline number: 59 animals, none reachable, on every desire board.
    const got = reachable("i_me + want");
    const animals = NOUNS.filter((n) => n.kind === "creature").map((n) => n.symbol);
    expect(animals.length).toBeGreaterThan(20);
    expect(animals.filter((a) => !got.has(a))).toEqual([]);
  });

  it("a child can say 'I want the dog'", () => {
    // The sentence, not the statistic.
    const got = reachable("i_me + want");
    for (const word of ["dog", "cat", "horse"]) expect(got.has(word)).toBe(true);
  });

  // No blanket sweep over every frame: they pool DIFFERENT sets by design — a
  // GO board offers places, a bare "i_me" offers verbs — and a board that never
  // pooled a noun has withheld nothing and promised nothing. The invariant
  // belongs to the boards that pool.

  it("a host's own character is reachable, exactly like a library word", () => {
    // "ONE VOCABULARY, IN GAME AND OUT": a scene's people are the words a child
    // would use that slot for anyway. `mara` has no lexeme and no properties —
    // the shape most likely to fall through every cluster.
    const mara: SurfaceNoun = {
      symbol: "mara", label: "Mara", kind: "creature", affords: ["talk"], properties: [],
    };
    expect(reachable("i_me + want", [mara, ...NOUNS]).has("mara")).toBe(true);
  });
});

describe("the individuals chip — the specific people", () => {
  // ⚖️ ONE LIST, TWO SOURCES (user, 2026-09-01). "Photos" was never a good chip:
  // the list is SPECIFIC PEOPLE, and it belongs wherever a specific person would
  // make sense. The in-game builder imitates how the board is used outside a
  // game — which is why it is context-agnostic in the first place — so a scene's
  // characters occupy the same slot a real contact would, and there is one chip
  // rather than a game one and a real one.
  const roster: SurfaceNoun[] = [
    { symbol: "liat", label: "Liat", kind: "creature", affords: ["talk", "want", "help"], properties: [], individual: true },
    { symbol: "ofek", label: "Ofek", kind: "creature", affords: ["talk", "want", "help"], properties: [], individual: true },
  ];
  const chips = (partial: string, nouns: SurfaceNoun[]) =>
    surfaceNext(tokenizeSentence(partial), { nouns }).groups.map((g) => g.id);

  it("leads the row on a desire — a want is usually about somebody", () => {
    expect(chips("i_me + want", [...roster, ...NOUNS])[0]).toBe("individuals");
  });

  it("does not exist at all without a roster", () => {
    // An empty chip is worse than no chip: it promises people and opens onto
    // nothing. A student with no contacts and a game with no cast both get the
    // board they had before.
    expect(chips("i_me + want", NOUNS)).not.toContain("individuals");
  });

  it("is SEPARATE from people-in-general and from animals", () => {
    // Three chips, three questions. `creatures` means somebody in general
    // (`teacher`, `friend`); `animals` is not somebody; `individuals` is Liat.
    const ids = chips("i_me + want", [...roster, ...NOUNS]);
    for (const id of ["individuals", "creatures", "animals"]) expect(ids).toContain(id);
    const s = surfaceNext(tokenizeSentence("i_me + want"), { nouns: [...roster, ...NOUNS] });
    const membersOf = (id: string) =>
      s.groups.find((g) => g.id === id)?.members.map((m) => m.symbol) ?? [];
    expect(membersOf("individuals").sort()).toEqual(["liat", "ofek"]);
    expect(membersOf("creatures")).not.toContain("liat");
    expect(membersOf("animals")).not.toContain("liat");
  });

  it("keeps a person's own name — a name has no lexeme to outrank it", () => {
    const s = surfaceNext(tokenizeSentence("i_me + want"), { nouns: [...roster, ...NOUNS] });
    const labels = (s.groups.find((g) => g.id === "individuals")?.members ?? []).map((m) => m.label);
    expect(labels).toContain("Liat");
  });

  it("an individual is reachable, like every other word", () => {
    const got = reachable("i_me + want", [...roster, ...NOUNS], ROOMY);
    expect(got.has("liat")).toBe(true);
    expect(got.has("ofek")).toBe(true);
  });
});

describe("the chip row reads in one order", () => {
  // ⚖️ WHO, THEN WHAT IS ASKED FOR, THEN WHAT IS MERELY AROUND (user,
  // 2026-09-01): "people should be first, then things that are commonly
  // requested like food and places, then more general things like furniture,
  // animals and plants."
  //
  // Two things used to prevent that. Property chips and kind chips were sorted
  // by SEPARATE lists — every property, then every kind — so `individuals`
  // could not sit beside `food` because one was a kind and the other a
  // property, a distinction no child can see. And the empty board ranked its
  // pooled clusters by MEMBER COUNT, which is how the very first screen a
  // student ever sees came to read
  //
  //   [animals 59] [furniture 18] [plants 13] [room] [building] [food] …
  //
  // with [individuals] last of sixteen: the exact reverse of the rule.
  const roster: SurfaceNoun[] = [
    { symbol: "liat", label: "Liat", kind: "creature", affords: ["talk"], properties: [], individual: true },
    { symbol: "ofek", label: "Ofek", kind: "creature", affords: ["talk"], properties: [], individual: true },
  ];
  const chips = (partial: string) =>
    surfaceNext(tokenizeSentence(partial), { nouns: [...roster, ...NOUNS] }).groups.map((g) => g.id);

  /** Position in the row, or Infinity for a chip this board didn't build. */
  const at = (ids: string[], id: string) => {
    const i = ids.indexOf(id);
    return i < 0 ? Infinity : i;
  };

  /** The row, rewritten as the band each chip belongs to, beside the same row
   *  sorted by band. Equal ⇒ the bands run in order. Compared as ROWS so a
   *  failure prints the chips that swapped rather than two indices. */
  const bandsInOrder = (ids: string[], bands: string[][]) => {
    const bandOf = (id: string) => bands.findIndex((b) => b.includes(id));
    const known = ids.filter((id) => bandOf(id) >= 0);
    const sorted = [...known].sort((a, b) => bandOf(a) - bandOf(b));
    expect(known).toEqual(sorted);
  };

  const BANDS = [
    ["individuals", "creatures"],                       // who
    ["food", "drink", "toy", "clothing", "book"],       // what is asked for
    ["room", "building", "outside"],                    // where
    ["container", "openable", "appliance", "device", "tableware"],
    ["furniture", "animals", "plants", "things"],       // the wide ones
  ];

  it("the FIRST screen leads with people, not with the biggest bucket", () => {
    const ids = chips("");
    expect(ids[0]).toBe("individuals");
    // The three the user named as belonging at the END are at the end.
    for (const wide of ["furniture", "animals", "plants"]) {
      expect(at(ids, wide)).toBeGreaterThan(at(ids, "food"));
      expect(at(ids, wide)).toBeGreaterThan(at(ids, "room"));
    }
  });

  it("the empty board's bands run who → asked-for → where → around → wide", () => {
    bandsInOrder(chips(""), BANDS);
  });

  it("a desire reads the same way — one order, not a per-board special case", () => {
    // The lead used to be a flag a band set (`leadKindChips`) plus an
    // open-roles test at the call site. A rule that fires on every board is not
    // a condition, and two ways of expressing it is one more chance to drift.
    const ids = chips("i_me + want");
    expect(ids.slice(0, 2)).toEqual(["individuals", "creatures"]);
    bandsInOrder(ids, BANDS);
  });

  it("but WEIGHT still outranks the row — a `go` board leads with places", () => {
    // The order breaks TIES. What the sentence actually asks for must still
    // win, or "I want to go…" would offer people ahead of anywhere to go.
    expect(chips("i_me + go")[0]).toBe("room");
  });
});

describe("the chip row keeps its promise", () => {
  it("never cuts a chip that is the last route to a word", () => {
    // MAX_GROUPS is a judgement about how many chips a child can scan, not
    // permission to delete words: past the budget a chip survives only if it is
    // the only thing carrying something.
    const s = surfaceNext(tokenizeSentence("i_me + want"), { nouns: NOUNS });
    const carried = new Map<string, number>();
    for (const g of s.groups) for (const m of g.members) {
      carried.set(m.symbol, (carried.get(m.symbol) ?? 0) + 1);
    }
    const inline = new Set(s.buttons.map((b) => b.symbol));
    // Every chip that carries something uniquely is load-bearing and present.
    const soleRoute = [...carried.entries()].filter(([sym, n]) => n === 1 && !inline.has(sym));
    expect(soleRoute.length).toBeGreaterThan(0);
  });

  it("the living split is visible, not just computed", () => {
    // `creatures` means SOMEBODY and `animals` does not — a distinction that
    // existed in the clustering since 2026-08-27 while neither chip ever
    // reached a board.
    const ids = surfaceNext(tokenizeSentence("i_me + want"), { nouns: NOUNS }).groups.map((g) => g.id);
    expect(ids).toContain("creatures");
    expect(ids).toContain("animals");
  });
});
