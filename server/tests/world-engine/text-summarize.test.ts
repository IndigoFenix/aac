// TEXT MODE law ⑤ — a crowd is summarized, an individual is NAMED.
//
// `summarizeScene` is pure over the subjects the §3 filter admitted, so this
// suite builds them by hand: the point under test is the PRECEDENCE, not the
// geometry (text-visibility.test.ts covers that).
//
// Precedence, in the law's own order: conversation member / addressee → watched
// → known or met → visibly distinct → uniquely occupied → adjacent. Cap 6, ties
// by distance. Everyone left buckets by (species word, activity verb, band).

import { describe, it, expect } from "@jest/globals";
import {
  activityKey,
  dressSignature,
  isNotablePlace,
  NAME_CAP,
  PLACE_LINE_CAP,
  RANK_ADJACENT,
  RANK_CONVERSATION,
  RANK_CROWD,
  RANK_DISTINCT,
  RANK_KNOWN,
  RANK_OCCUPIED,
  RANK_WATCHED,
  summarizePlaces,
  summarizeScene,
  type VisibleSubject,
} from "@shared/world-engine/interaction/text/index.js";
import { languageFor } from "@shared/world-engine/interaction/lang/index.js";
import { outfitIndexOf } from "@shared/world-engine/creatures/clothing.js";

/** The dress every ordinary townsperson in these fixtures shares. */
const PLAIN = ["species:human", "garment:default", "color:default"];

function sub(id: string, over: Partial<VisibleSubject> = {}): VisibleSubject {
  return {
    id,
    kind: "creature",
    textId: id,
    head: "person",
    word: "person",
    band: "there",
    cardinal: "east",
    distance: 20,
    space: null,
    floor: 0,
    appearance: PLAIN,
    holding: [],
    ...over,
  };
}

/** A landmark: shut, unremarkable, part of the skyline unless told otherwise. */
function place(id: string, over: Partial<VisibleSubject> = {}): VisibleSubject {
  return {
    id,
    kind: "place",
    textId: id,
    head: "house",
    word: "house",
    band: "there",
    cardinal: "east",
    distance: 30,
    space: id,
    floor: 0,
    appearance: [],
    holding: [],
    revealed: false,
    doorOpen: false,
    ...over,
  };
}

describe("summarize — promotion precedence (law ⑤)", () => {
  // One body per tier, deliberately ordered so DISTANCE cannot produce the
  // expected order: the promoted-first body is the FARTHEST away.
  const conv = sub("conv", { distance: 40 });
  const known = sub("known", { name: "Mara", distance: 35 });
  const distinct = sub("distinct", { appearance: ["species:human", "outfit:red"], distance: 30 });
  const occupied = sub("occupied", { activity: { verb: "cook" }, distance: 25 });
  const adjacent = sub("adjacent", { band: "here", distance: 3 });
  const crowd = [
    sub("crowd1", { activity: { verb: "walk" }, distance: 10 }),
    sub("crowd2", { activity: { verb: "walk" }, distance: 11, cardinal: "north" }),
    sub("crowd3", { activity: { verb: "walk" }, distance: 12 }),
  ];
  const all = [conv, known, distinct, occupied, adjacent, ...crowd];

  it("names in the law's order, not in distance order", () => {
    const out = summarizeScene(all, { conversation: { id: "c1", members: ["conv"] } });
    expect(out.named.map((s) => s.id)).toEqual(["conv", "known", "distinct", "occupied", "adjacent"]);
  });

  it("the addressee is promoted on the same tier as a conversation member", () => {
    const out = summarizeScene(all, { addressee: "crowd3" });
    expect(out.named[0]!.id).toBe("crowd3");
  });

  it('"previously met" promotes a body with no name of its own', () => {
    const bare = sub("stranger", { distance: 44 });
    const out = summarizeScene([...crowd, bare], { known: (id) => id === "stranger" });
    expect(out.named.map((s) => s.id)).toEqual(["stranger"]);
  });

  it("groups everyone left by (word, verb, band), nearest member's cardinal", () => {
    const out = summarizeScene(all, { conversation: { id: "c1", members: ["conv"] } });
    expect(out.groups).toEqual([
      {
        word: "person",
        head: "person",
        count: 3,
        verb: "walk",
        band: "there",
        cardinal: "east", // crowd1 is nearest, and faces east
        members: ["crowd1", "crowd2", "crowd3"],
      },
    ]);
  });

  it("splits buckets that differ in band or in activity", () => {
    const out = summarizeScene([
      sub("a", { activity: { verb: "walk" }, distance: 10 }),
      sub("b", { activity: { verb: "walk" }, distance: 11 }),
      sub("c", { activity: { verb: "walk" }, band: "close", distance: 60 }),
      sub("d", { activity: { verb: "walk" }, band: "close", distance: 61 }),
      sub("e", { activity: { verb: "sit" }, distance: 12 }),
      sub("f", { activity: { verb: "sit" }, distance: 13 }),
    ]);
    expect(out.named).toEqual([]);
    expect(out.groups.map((g) => [g.verb, g.band, g.count])).toEqual([
      ["walk", "there", 2],
      ["sit", "there", 2],
      ["walk", "close", 2],
    ]);
  });
});

describe("summarize — visibly distinct means DRAWN differently (§6)", () => {
  it("promotes the one body dressed unlike its peers and groups the identical rest", () => {
    const plain = [1, 2, 3, 4].map((n) =>
      sub(`plain${n}`, { activity: { verb: "walk" }, distance: 10 + n }),
    );
    const red = sub("red", {
      appearance: ["species:human", "outfit:red"],
      activity: { verb: "walk" },
      distance: 30,
    });
    const out = summarizeScene([...plain, red]);
    expect(out.named.map((s) => s.id)).toEqual(["red"]);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]!.count).toBe(4);
  });

  it("a signature shared by two labels the GROUP instead — neither is distinct", () => {
    const pair = ["r1", "r2"].map((id) =>
      sub(id, { appearance: ["species:human", "outfit:red"], activity: { verb: "draw" } }),
    );
    const plain = [1, 2, 3].map((n) => sub(`p${n}`, { activity: { verb: "walk" }, distance: 10 + n }));
    const out = summarizeScene([...pair, ...plain]);
    expect(out.named).toEqual([]);
    expect(out.groups.map((g) => g.count).sort()).toEqual([2, 3]);
  });

  it("the signature is scoped to the WORD — a lone chair among people is not 'distinct people'", () => {
    const people = [1, 2, 3].map((n) => sub(`p${n}`, { activity: { verb: "walk" }, distance: 10 + n }));
    const chair = sub("chair1", {
      kind: "object",
      word: "chair",
      appearance: ["glyph:chair"],
      distance: 40,
    });
    const out = summarizeScene([...people, chair]);
    // The chair is the only "chair chair" signature in view, so it is named…
    expect(out.named.map((s) => s.id)).toEqual(["chair1"]);
    // …and the three identical walkers are still one bucket.
    expect(out.groups.map((g) => [g.word, g.count])).toEqual([["person", 3]]);
  });
});

describe("summarize — the cap", () => {
  it("names at most 6 and buckets the overflow", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      sub(`m${i}`, { name: `Name${i}`, activity: { verb: "walk" }, distance: 10 + i }),
    );
    const out = summarizeScene(many);
    expect(out.named).toHaveLength(6);
    expect(out.named.map((s) => s.id)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
    expect(out.groups).toEqual([
      {
        word: "person",
        head: "person",
        count: 3,
        verb: "walk",
        band: "there",
        cardinal: "east",
        members: ["m6", "m7", "m8"],
      },
    ]);
  });

  it("honours an explicit cap", () => {
    const many = Array.from({ length: 5 }, (_, i) => sub(`m${i}`, { name: `N${i}`, distance: 10 + i }));
    expect(summarizeScene(many, { cap: 2 }).named).toHaveLength(2);
  });

  it("a creature outranks an object at the same tier — a person is news, a chair is furniture", () => {
    const chair = sub("chair1", {
      kind: "object",
      word: "chair",
      appearance: ["glyph:chair"],
      band: "here",
      distance: 1,
    });
    const person = sub("p1", { band: "here", distance: 3 });
    const out = summarizeScene([chair, person], { cap: 1 });
    expect(out.named.map((s) => s.id)).toEqual(["p1"]);
  });
});

describe("summarize — places (law ⑤ applies to the skyline too)", () => {
  // THE BUG THIS SUITE EXISTS FOR: the first real dollhouse transcript printed
  // all 82 town houses as their own lines, burying the 13 things in front of
  // the player.
  const town = Array.from({ length: 82 }, (_, i) =>
    place(`h${i}`, {
      // A real skyline spreads across the bands the filter admits.
      band: i < 45 ? "there" : i < 75 ? "close" : "far",
      distance: 10 + i,
      cardinal: i % 2 ? "north" : "west",
      color: i % 3 ? "orange" : "blue",
    }),
  );

  it("prints a handful of lines for a town of 82 houses, not 82", () => {
    const out = summarizePlaces(town);
    expect(out.notable).toEqual([]);
    expect(out.notable.length + out.groups.length).toBeLessThanOrEqual(PLACE_LINE_CAP);
    // Every house is accounted for — summarized, never dropped.
    const counted = out.groups.reduce((n, g) => n + g.count, 0);
    expect(counted + out.notable.length).toBe(82);
  });

  it("keeps the direction while the band buckets fit — a skyline is still oriented", () => {
    const out = summarizePlaces(town);
    expect(out.groups.map((g) => [g.band, g.count])).toEqual([
      ["there", 45],
      ["close", 30],
      ["far", 7],
    ]);
    for (const g of out.groups) {
      expect(g.allShut).toBe(true);
      // A colour every third house shares distinguishes nothing at that size.
      expect(g.color).toBeUndefined();
      expect(g.collapsed).toBeUndefined();
    }
  });

  it("collapses to ONE line per kind once notable places + buckets overflow the cap", () => {
    // Eight open doors (seven of which take lines) plus a town across three
    // bands would be eleven lines; the skyline folds into one instead.
    const doors = Array.from({ length: 8 }, (_, i) =>
      place(`d${i}`, { doorOpen: true, band: "here", distance: 1 + i }),
    );
    const out = summarizePlaces([...doors, ...town]);
    expect(out.notable).toHaveLength(PLACE_LINE_CAP - 1);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]).toMatchObject({ word: "house", count: 83, collapsed: true });
    expect(out.notable.length + out.groups.length).toBeLessThanOrEqual(PLACE_LINE_CAP);
    // Every place is still accounted for: 8 doors + 82 houses.
    expect(out.notable.length + out.groups[0]!.count).toBe(90);
  });

  it("groups by (kind, band) while the buckets stay few", () => {
    const few = [
      place("a", { band: "there", distance: 10 }),
      place("b", { band: "there", distance: 11 }),
      place("c", { band: "close", distance: 60 }),
    ];
    const out = summarizePlaces(few);
    expect(out.groups.map((g) => [g.band, g.count])).toEqual([
      ["there", 2],
      ["close", 1],
    ]);
  });

  it("keeps a colour only while the group is small enough for it to pick a house out", () => {
    const small = [
      place("a", { color: "blue", distance: 10 }),
      place("b", { color: "blue", distance: 11 }),
    ];
    expect(summarizePlaces(small).groups[0]!.color).toBe("blue");
    // Mixed colours never label a group…
    const mixed = [place("a", { color: "blue" }), place("b", { color: "red" })];
    expect(summarizePlaces(mixed).groups[0]!.color).toBeUndefined();
    // …nor does one shared colour once the group is too big to look through.
    const big = Array.from({ length: 6 }, (_, i) => place(`b${i}`, { color: "blue", distance: 10 + i }));
    expect(summarizePlaces(big).groups[0]!.color).toBeUndefined();
  });
});

describe("summarize — a place earns its own line only when NOTABLE", () => {
  it("promotes a revealed interior, an open door, an adjacent place, and one named before", () => {
    expect(isNotablePlace(place("r", { revealed: true }))).toBe(true);
    expect(isNotablePlace(place("d", { doorOpen: true }))).toBe(true);
    expect(isNotablePlace(place("h", { band: "here", distance: 2 }))).toBe(true);
    expect(isNotablePlace(place("x"), { referenced: (id) => id === "x" })).toBe(true);
    expect(isNotablePlace(place("plain"))).toBe(false);
  });

  it("gives the notable ones lines and buckets the rest of the town", () => {
    const town = Array.from({ length: 40 }, (_, i) => place(`h${i}`, { distance: 20 + i }));
    const out = summarizePlaces([
      place("home", { revealed: true, distance: 3, band: "here" }),
      place("shop", { doorOpen: true, distance: 12 }),
      ...town,
    ]);
    expect(out.notable.map((p) => p.id)).toEqual(["home", "shop"]);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]!.count).toBe(40);
    expect(out.notable.length + out.groups.length).toBeLessThanOrEqual(PLACE_LINE_CAP);
  });

  it("a place the driver NAMED keeps its line afterwards, even in a crowd of houses", () => {
    const town = Array.from({ length: 40 }, (_, i) => place(`h${i}`, { distance: 20 + i }));
    const anonymous = summarizePlaces(town);
    expect(anonymous.notable).toEqual([]);
    const afterLook = summarizePlaces(town, { referenced: (id) => id === "h30" });
    expect(afterLook.notable.map((p) => p.id)).toEqual(["h30"]);
    expect(afterLook.groups[0]!.count).toBe(39);
  });

  it("caps NOTABLE places too — a hall of open doors is still a flood", () => {
    const open = Array.from({ length: 30 }, (_, i) =>
      place(`o${i}`, { doorOpen: true, distance: 5 + i }),
    );
    const out = summarizePlaces(open);
    expect(out.notable.length + out.groups.length).toBeLessThanOrEqual(PLACE_LINE_CAP);
    expect(out.notable.map((p) => p.id)).toEqual(["o0", "o1", "o2", "o3", "o4", "o5", "o6"]);
    expect(out.groups.reduce((n, g) => n + g.count, 0)).toBe(23);
  });
});

describe("summarize — crowd buckets are capped as well", () => {
  it("folds a long tail of buckets into one line per word", () => {
    // Ten distinct activities, each with two bodies: ten buckets before the cap.
    const many = Array.from({ length: 20 }, (_, i) =>
      sub(`m${i}`, { activity: { verb: `act${Math.floor(i / 2)}` }, distance: 10 + i }),
    );
    const out = summarizeScene(many);
    expect(out.groups.length).toBeLessThanOrEqual(8);
    expect(out.groups.reduce((n, g) => n + g.count, 0)).toBe(20);
    // The folded remainder drops the verb — it no longer describes one activity.
    expect(out.groups[out.groups.length - 1]!.verb).toBeUndefined();
  });
});

describe("summarize — the rank constants are the law's order", () => {
  it("orders conversation < watched < known < distinct < occupied < adjacent < crowd", () => {
    expect(RANK_CONVERSATION).toBeLessThan(RANK_WATCHED);
    expect(RANK_WATCHED).toBeLessThan(RANK_KNOWN);
    expect(RANK_KNOWN).toBeLessThan(RANK_DISTINCT);
    expect(RANK_DISTINCT).toBeLessThan(RANK_OCCUPIED);
    expect(RANK_OCCUPIED).toBeLessThan(RANK_ADJACENT);
    expect(RANK_ADJACENT).toBeLessThan(RANK_CROWD);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// STEP ⑦ — the FULL crowd pass: every rung of the ladder, a→f, at once.
// ───────────────────────────────────────────────────────────────────────────

describe("summarize — the full precedence, a→f (step ⑦)", () => {
  it("names one body per rung, in the law's order, against distance", () => {
    // Deliberately ordered so DISTANCE would produce the reverse: the
    // highest-ranked body is the farthest away on every rung.
    const conv = sub("conv", { distance: 60 });
    const watched = sub("watched", { distance: 50 });
    const met = sub("met", { distance: 40 });
    const distinct = sub("distinct", {
      appearance: ["species:human", "garment:shirt", "color:color_red"],
      dress: "red",
      distance: 30,
    });
    const occupied = sub("occupied", { activity: { verb: "eat", object: "cake" }, distance: 20 });
    const adjacent = sub("adjacent", { band: "here", distance: 3 });
    // …and a crowd doing one thing, so nobody in it is "uniquely occupied".
    const crowd = [1, 2, 3].map((n) =>
      sub(`c${n}`, { activity: { verb: "eat", object: "bread" }, distance: 5 + n }),
    );

    const out = summarizeScene([...crowd, adjacent, occupied, distinct, met, watched, conv], {
      conversation: { id: "c1", members: ["conv"] },
      watched: new Set(["watched"]),
      known: (id) => id === "met",
    });
    expect(out.named.map((s) => s.id)).toEqual([
      "conv",
      "watched",
      "met",
      "distinct",
      "occupied",
      "adjacent",
    ]);
    expect(out.named).toHaveLength(NAME_CAP);
    expect(out.groups.map((g) => g.count)).toEqual([3]);
  });

  it("rung (e) keys on (verb, OBJECT) — the one eating cake, not the one eating", () => {
    const bread = [1, 2].map((n) => sub(`b${n}`, { activity: { verb: "eat", object: "bread" }, distance: 10 + n }));
    const cake = sub("cake", { activity: { verb: "eat", object: "cake" }, distance: 30 });
    const out = summarizeScene([...bread, cake]);
    expect(out.named.map((s) => s.id)).toEqual(["cake"]);
    expect(activityKey({ verb: "eat", object: "cake" })).toBe("eat|cake");
    expect(activityKey({ verb: "eat" })).toBe("eat|");
  });

  it("rung (c): a body previously MET is named though the world never gave it a name", () => {
    const crowd = [1, 2, 3].map((n) => sub(`c${n}`, { activity: { verb: "walk" }, distance: 5 + n }));
    const stranger = sub("stranger", { activity: { verb: "walk" }, distance: 44 });
    expect(summarizeScene([...crowd, stranger]).named).toEqual([]);
    const out = summarizeScene([...crowd, stranger], { known: (id) => id === "stranger" });
    expect(out.named.map((s) => s.id)).toEqual(["stranger"]);
  });
});

describe("summarize — the appearance signature is what the RENDERER dresses from", () => {
  const lang = languageFor("en");

  it("reads the outfit index through the one bijection behind it", () => {
    const red = dressSignature(lang, "human", outfitIndexOf("shirt", "color_red"));
    expect(red).toEqual({
      appearance: ["species:human", "garment:shirt", "color:color_red"],
      dress: "red",
    });
    // A dress in the same colour is DRAWN differently, so it signs differently.
    const gown = dressSignature(lang, "human", outfitIndexOf("dress", "color_red"));
    expect(gown.appearance).toEqual(["species:human", "garment:dress", "color:color_red"]);
    // No override = the factory default, which distinguishes nothing and so
    // never words itself.
    expect(dressSignature(lang, "human", undefined)).toEqual({
      appearance: ["species:human", "garment:default", "color:default"],
    });
  });

  it("a signature shared by ≥2 LABELS the group (§6: 'two women in red')", () => {
    const red = [1, 2].map((n) =>
      sub(`r${n}`, {
        appearance: ["species:human", "garment:dress", "color:color_red"],
        dress: "red",
        activity: { verb: "draw" },
        distance: 10 + n,
      }),
    );
    const plain = [1, 2, 3].map((n) => sub(`p${n}`, { activity: { verb: "walk" }, distance: 20 + n }));
    const out = summarizeScene([...red, ...plain]);
    expect(out.named).toEqual([]);
    const redGroup = out.groups.find((g) => g.count === 2)!;
    expect(redGroup).toMatchObject({ count: 2, verb: "draw", dress: "red" });
    // The undressed bucket carries no colour to be labelled by.
    expect(out.groups.find((g) => g.count === 3)!.dress).toBeUndefined();
  });

  it("the label survives only while EVERY member of the bucket wears it", () => {
    // Two reds and two blues, all drawing water in the same band: no signature
    // is unique, so nobody is promoted and all four land in ONE bucket — which
    // must then carry no colour, because the colour picks nothing out of it.
    const dressed = (id: string, color: string, word: string, distance: number): VisibleSubject =>
      sub(id, {
        appearance: ["species:human", "garment:dress", `color:color_${color}`],
        dress: word,
        activity: { verb: "draw" },
        distance,
      });
    const out = summarizeScene([
      dressed("a", "red", "red", 11),
      dressed("b", "red", "red", 12),
      dressed("c", "blue", "blue", 13),
      dressed("d", "blue", "blue", 14),
    ]);
    expect(out.named).toEqual([]);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]).toMatchObject({ count: 4, verb: "draw" });
    expect(out.groups[0]!.dress).toBeUndefined();
  });
});
