// THE LINK BANDS (build order arc L, wave 1). A verb that moves a thing must
// offer LOCATION-TYPE LINKS next — `in`, `on`, `next_to`, `from`, `with` — and
// then the nouns those links can actually bind. Before this arc the links were
// only reachable through the generic relation dump, where the connective quota
// of three spent itself on and/then/because, so the one word the composer
// needed was the one word the board never showed.
//
// Two halves, pinned together here because they only work as a pair:
//   1. the band a VERB opens once its object is named (put/take/carry/stay/trade)
//   2. the class of noun a dangling LINK then asks for (in → containers,
//      on → surfaces, from → sources, to → bodies, and places for a transport
//      verb's "to")
//
// Wave 2 sharpens the second half: for three links the class is not the
// preposition's alone but the FRAME's — a transport verb's `to` may end at a
// place, and a trade borrows `with`/`for` for a partner and a counter-good,
// which are not the company and the beneficiary those words name everywhere
// else. Both readings are pinned against each other below, because a rule that
// fixed the swap by breaking "eat with mara" would be no fix at all.
//
// Every pin below is also checked to PARSE: a surfaced word that the parser
// cannot bind would be a button that promises a sentence and delivers
// "I don't understand".

import { describe, it, expect } from "@jest/globals";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import {
  surfaceNext,
  type SurfaceContext,
  type SurfaceNoun,
} from "@shared/world-engine/interaction/intent/surface-next.js";

/** A library with one member of each class the links care about: something that
 *  HOLDS (box), something with a SURFACE (table), something that stands in a
 *  room (chair, bed), rooms (kitchen, yard), a body (mara), plain movable
 *  goods (ball, cup, wood), and — for the swap links — something a town would
 *  actually ask for BACK (bread: the stock half of a trade, as wood is the
 *  timber half). */
const NOUNS: SurfaceNoun[] = [
  { symbol: "ball", kind: "item", affords: ["get", "give", "play", "throw", "put", "want"], properties: ["toy"] },
  { symbol: "cup", kind: "item", affords: ["get", "put", "fill"], properties: ["tableware"] },
  { symbol: "wood", kind: "item", affords: ["get", "carry", "trade"], properties: ["material"] },
  { symbol: "bread", kind: "item", affords: ["eat", "get", "give", "trade"], properties: ["food"] },
  { symbol: "box", kind: "item", affords: ["open", "shut", "put"], properties: ["container", "openable"] },
  { symbol: "chair", kind: "item", affords: ["get", "put", "sit"], properties: ["furniture"] },
  { symbol: "table", kind: "place", affords: ["go", "put"], properties: ["furniture"] },
  { symbol: "bed", kind: "place", affords: ["go", "sleep"], properties: ["furniture"] },
  { symbol: "kitchen", kind: "place", affords: ["go"] },
  { symbol: "yard", kind: "place", affords: ["go"] },
  { symbol: "mara", kind: "creature", affords: ["talk", "help", "hug", "give", "trade"] },
];

const ctx = (extra: Partial<SurfaceContext> = {}): SurfaceContext => ({ nouns: NOUNS, ...extra });
const board = (tokens: string[]) => surfaceNext(tokens, ctx());
const syms = (tokens: string[]) => board(tokens).buttons.map((b) => b.symbol);
/** Rank ON THE BOARD (not the weight): what the child's eye reaches first. */
const at = (tokens: string[], symbol: string): number => syms(tokens).indexOf(symbol);
/** The whole point of a surfaced link: the sentence it starts must bind. */
const binds = (sentence: string, rel: string, target: string) => {
  const frame = parseSentence(sentence, {
    classifyEntity: (s) => NOUNS.find((n) => n.symbol === s)?.kind ?? "unknown",
  });
  expect({ sentence, kind: frame.kind, rel: frame.relation, target: frame.target }).toEqual({
    sentence,
    kind: "command",
    rel,
    target: { kind: "entity", symbol: target, modifiers: [] },
  });
};

// ── L2: the put family opens the spatial links for ANY object ────────────────

describe("put + a movable thing — the spatial links are the sentence", () => {
  it("offers in / on / next_to / near on the board, not buried in the joiners", () => {
    const s = board(["you", "put", "ball"]);
    const roleOf = new Map(s.buttons.map((b) => [b.symbol, b.role] as const));
    for (const w of ["in", "on", "next_to", "near"]) {
      expect({ w, role: roleOf.get(w) }).toEqual({ w, role: "destination" });
    }
  });

  it("the rarer anchors (under / behind / in_front_of) clear the connective quota", () => {
    // They used to arrive as connectives, where three slots are spent on
    // and/then/because before a placement word is ever considered.
    const s = board(["you", "put", "ball"]);
    const w = (sym: string) => s.buttons.find((b) => b.symbol === sym)?.weight ?? -1;
    const joiner = Math.max(...s.buttons.filter((b) => b.role === "connective").map((b) => b.weight), 0);
    for (const link of ["under", "behind", "in_front_of"]) {
      expect({ link, above: w(link) > joiner }).toEqual({ link, above: true });
    }
  });

  it("a movable thing leads with CONTAINMENT: the box and `in` before the anchors", () => {
    // A ball is put INTO or ONTO something; only a piece of furniture is
    // positioned relative to what already stands there.
    const k = syms(["you", "put", "ball"]);
    expect(k.indexOf("box")).toBeLessThan(k.indexOf("in"));
    expect(k.indexOf("in")).toBeLessThan(k.indexOf("on"));
    expect(k.indexOf("on")).toBeLessThan(k.indexOf("next_to"));
  });

  it("furniture keeps its own order — the adjacent spot leads (the pinned case)", () => {
    const k = syms(["you", "put", "chair"]);
    expect(k.indexOf("next_to")).toBeLessThan(k.indexOf("near"));
    expect(k.indexOf("near")).toBeLessThanOrEqual(k.indexOf("on"));
  });

  it("every offered link binds a real placement frame", () => {
    binds("you + put + ball + in + box", "in", "box");
    binds("you + put + ball + on + table", "on", "table");
    binds("you + put + ball + under + bed", "under", "bed");
    binds("you + put + ball + in_front_of + chair", "front", "chair");
  });
});

// ── L1: a dangling link asks for its OWN class of noun ───────────────────────

describe("a dangling link ranks by what THAT link points at", () => {
  it("`in` wants a container before a room", () => {
    const k = syms(["you", "put", "ball", "in"]);
    expect(k.indexOf("box")).toBeLessThan(k.indexOf("kitchen"));
    expect(k.indexOf("box")).toBeLessThan(k.indexOf("bed"));
  });

  it("`on` wants a SURFACE before a room (put the cup on the table)", () => {
    const k = syms(["you", "put", "cup", "on"]);
    expect(k.indexOf("table")).toBeLessThan(k.indexOf("kitchen"));
    expect(k.indexOf("chair")).toBeLessThan(k.indexOf("yard"));
  });

  it("`near` / `next_to` want an anchor that STANDS somewhere, room behind it", () => {
    for (const rel of ["near", "next_to", "under", "behind"]) {
      const k = syms(["you", "put", "ball", rel]);
      expect({ rel, ok: k.indexOf("table") < k.indexOf("kitchen") }).toEqual({ rel, ok: true });
    }
  });

  it("`from` wants a SOURCE — what it came out of, or whom it came from", () => {
    const k = syms(["you", "take", "ball", "from"]);
    expect(k.indexOf("box")).toBeLessThan(k.indexOf("kitchen"));
    expect(k.indexOf("mara")).toBeLessThan(k.indexOf("kitchen"));
  });

  it("`to` still wants a BODY — the recipient reading is the default", () => {
    expect(syms(["give", "ball", "to"])[0]).toBe("mara");
  });

  it("…but a TRANSPORT verb's `to` may end at a place (bring wood to yard)", () => {
    // "carry/bring/put + X + to + <place>" compiles to the same putIn a
    // container reading would — so the yard has to rank, without displacing
    // the person the same sentence could be aimed at.
    const k = syms(["you", "carry", "wood", "to"]);
    expect(k[0]).toBe("mara");
    expect(k.indexOf("yard")).toBeLessThan(k.indexOf("ball"));
    expect(k.indexOf("box")).toBeLessThan(k.indexOf("ball"));
    // A verb that does NOT transport keeps `to` = whom: no place lift at all.
    const give = syms(["give", "ball", "to"]);
    expect(give.indexOf("yard")).toBeGreaterThan(give.indexOf("mara"));
    binds("you + carry + wood + to + yard", "to", "yard");
  });
});

// ── L4: acquisition opens a source ───────────────────────────────────────────

describe("take / get / pick_up — where does it come FROM", () => {
  it("`from` and the sources join the board the acquisition opens", () => {
    for (const verb of ["take", "get", "pick_up"]) {
      const k = syms(["you", verb, "ball"]);
      expect({ verb, from: k.includes("from") }).toEqual({ verb, from: true });
      expect({ verb, box: k.includes("box") }).toEqual({ verb, box: true });
    }
  });

  it("the recipient band survives — an explicit `to` still turns it into a delivery", () => {
    // The to/from opposition (semantic-gaps.md): acquisition and delivery are
    // two directions of one frame, so both links stay reachable.
    const s = board(["you", "take", "ball"]);
    expect(s.buttons.some((b) => b.symbol === "to")).toBe(true);
    expect(s.buttons.some((b) => b.symbol === "mara" && b.role === "recipient")).toBe(true);
    binds("you + take + ball + from + box", "from", "box");
  });
});

// ── L5: carrying is a haul, not a handover ───────────────────────────────────

describe("carry — the destination outranks the recipient", () => {
  it("a place and a container rank above the person", () => {
    const k = syms(["you", "carry", "wood"]);
    expect(k.indexOf("yard")).toBeLessThan(k.indexOf("mara"));
    expect(k.indexOf("box")).toBeLessThan(k.indexOf("mara"));
    expect(k.indexOf("to")).toBeLessThanOrEqual(k.indexOf("mara"));
  });

  it("the people are still there — a load can be carried to somebody", () => {
    expect(syms(["you", "carry", "wood"])).toContain("mara");
  });

  it("GIVE is untouched: a handover still leads with the person", () => {
    const k = syms(["you", "give", "ball"]);
    expect(k.indexOf("mara")).toBeLessThan(k.indexOf("to"));
  });
});

// ── L6: stay / wait name a position to hold ──────────────────────────────────

describe("stay / wait — the place band", () => {
  it("places lead, with `in` and `near` to bind them", () => {
    for (const verb of ["stay", "wait"]) {
      const s = surfaceNext([verb], ctx());
      const k = s.buttons.map((b) => b.symbol);
      expect({ verb, open: s.open.includes("destination") }).toEqual({ verb, open: true });
      expect({ verb, kitchen: k.indexOf("kitchen") }).not.toEqual({ verb, kitchen: -1 });
      expect({ verb, links: k.includes("in") && k.includes("near") }).toEqual({ verb, links: true });
      expect({ verb, ahead: k.indexOf("kitchen") < k.indexOf("ball") }).toEqual({ verb, ahead: true });
    }
  });

  it("NO invented `at` — the lexicon has none, and a word the parser can't read is a dead button", () => {
    expect(syms(["you", "stay"])).not.toContain("at");
    binds("you + stay + in + kitchen", "in", "kitchen");
    binds("you + stay + near + table", "near", "table");
  });
});

// ── L7: trade is a swap ──────────────────────────────────────────────────────

describe("trade — the partner link and the counter-good link", () => {
  it("`with` leads, `for` follows, then the partners", () => {
    const k = syms(["you", "trade", "wood"]);
    expect(k[0]).toBe("with");
    expect(k[1]).toBe("for");
    expect(k.indexOf("for")).toBeLessThan(k.indexOf("mara"));
  });

  it("partners are bodies AND settlements — a town trades", () => {
    const k = syms(["you", "trade", "wood"]);
    expect(k).toContain("mara");
    expect(k.indexOf("mara")).toBeLessThan(k.indexOf("yard"));
    binds("you + trade + wood + with + mara", "with", "mara");
    binds("you + trade + wood + for + ball", "for", "ball");
  });

  // ── wave 2: the swap's OWN links, once one of them is pressed ──────────────

  it("a dangling `with` after a trade wants a PARTNER — the settlement comes too", () => {
    // Wave 1 left `with` creature-only in the dangling-link stage, so the town
    // half of the pair the band above offers (creatures then places) vanished at
    // the very press that needed it: the board said "trade wood with…" and then
    // showed nobody to trade with but the people standing in the room. Bodies
    // still lead — the order the trade band itself uses, so the board does not
    // change its mind between two presses.
    const k = syms(["you", "trade", "wood", "with"]);
    expect(k[0]).toBe("mara");
    expect(k.indexOf("yard")).toBeLessThan(k.indexOf("ball"));
    expect(k.indexOf("mara")).toBeLessThan(k.indexOf("yard"));
    binds("you + trade + wood + with + yard", "with", "yard");
  });

  it("a dangling `for` after a trade wants the TAKE-GOOD, never a body", () => {
    // "trade + wood + for + …" names what we want BACK — compileAction reads it
    // as trade{give, take, partner}, and a person is not a take-good. Stock
    // leads (bread), any other carryable follows, and the people fall to the
    // universal band underneath.
    const k = syms(["you", "trade", "wood", "for"]);
    expect(k[0]).toBe("bread");
    expect(k.indexOf("ball")).toBeLessThan(k.indexOf("mara"));
    expect(k.indexOf("cup")).toBeLessThan(k.indexOf("mara"));
    binds("you + trade + wood + for + bread", "for", "bread");
  });

  it("the two links do NOT swap classes: the partner is not a good, nor the good a partner", () => {
    // The whole point of splitting them: one press apart, the same board must
    // answer two different questions.
    const withK = syms(["you", "trade", "wood", "with"]);
    const forK = syms(["you", "trade", "wood", "for"]);
    expect(withK.indexOf("mara")).toBeLessThan(withK.indexOf("bread"));
    expect(forK.indexOf("bread")).toBeLessThan(forK.indexOf("mara"));
  });
});

// ── wave 2: `with` and `for` keep their SOCIAL readings everywhere else ──────

describe("company and beneficiary — the readings the trade rule must not break", () => {
  it("`eat + with` is COMPANY: creatures lead and the goods are not lifted", () => {
    // The joint-act reading (parse-intent's animacy test) — "eat with mara" is
    // one shared meal. A food word here would be an instrument at best, so the
    // swap's goods tier must not reach this board.
    const k = syms(["you", "eat", "with"]);
    expect(k[0]).toBe("mara");
    expect(k.indexOf("mara")).toBeLessThan(k.indexOf("bread"));
    // No food boost — asserted on the WEIGHTS, since the vocabulary's own order
    // (2026-08-24) legitimately ranks bread over ball and a position test can no
    // longer tell "not boosted" from "ordinary rank".
    const b = board(["you", "eat", "with"]).buttons;
    const w = (sym: string) => b.find((x) => x.symbol === sym)!.weight;
    expect(w("bread")).toBe(w("ball"));
  });

  it("`get + apple + for` is a BENEFICIARY: the person still leads", () => {
    const k = syms(["you", "get", "ball", "for"]);
    expect(k[0]).toBe("mara");
    expect(k.indexOf("mara")).toBeLessThan(k.indexOf("bread"));
  });
});

// ── wave 2 (L3a follow-up): drop is a placement, same as put ─────────────────

describe("drop — the put family pre-loads one group, not two-and-a-half", () => {
  it("`drop + <thing>` opens on containers, exactly as `put` does", () => {
    // All three of put/drop/throw carry `implied: "in"` in the LEXICON, so all
    // three ask the same question. `drop` simply had no PROPERTY_FOR_VERB row.
    for (const verb of ["put", "drop", "throw"]) {
      const s = board(["you", verb, "ball"]);
      expect({ verb, subTab: s.subTab }).toEqual({ verb, subTab: "container" });
      const dest = s.buttons.filter((b) => b.role === "destination").map((b) => b.symbol);
      expect({ verb, first: dest[0] }).toEqual({ verb, first: "box" });
    }
  });

  it("the spatial band survives the pre-load — a drop still lands somewhere named", () => {
    const k = syms(["you", "drop", "ball"]);
    expect(k.indexOf("box")).toBeLessThan(k.indexOf("in"));
    expect(k.indexOf("in")).toBeLessThan(k.indexOf("on"));
    binds("you + drop + ball + in + box", "in", "box");
  });
});

// ── L3a: the resting poses pre-load the furniture group ──────────────────────

describe("sit / sleep / rest — the station is the argument", () => {
  it("the board opens on furniture", () => {
    for (const verb of ["sit", "sleep", "rest"]) {
      const s = surfaceNext(["you", verb], ctx());
      expect({ verb, subTab: s.subTab }).toEqual({ verb, subTab: "furniture" });
      // WHICH station is the verb's own business (CONTEXT_PRIORITY, 2026-08-24):
      // you sit on a chair and sleep in a bed. The vocabulary's global order
      // ranks the chair first and would otherwise answer "sleep" with it.
      const want = verb === "sit" ? "chair" : "bed";
      expect({ verb, first: s.buttons[0]?.symbol }).toEqual({ verb, first: want });
    }
  });

  it("the pre-load ranks the group chip too (the sub-tab the board opens)", () => {
    // Capacity 2 so the cluster still has a member the grid could not hold — a
    // chip that opens nothing new is dropped by construction.
    const s = surfaceNext(["you", "sit"], ctx({ capacity: 2 }));
    expect(s.groups[0]?.id).toBe("furniture");
  });
});

// ── The laws that hold across every band ─────────────────────────────────────

describe("the link bands stay pure", () => {
  const CASES: string[][] = [
    ["you", "put", "ball"],
    ["you", "put", "ball", "in"],
    ["you", "put", "cup", "on"],
    ["you", "take", "ball"],
    ["you", "carry", "wood"],
    ["you", "carry", "wood", "to"],
    ["you", "stay"],
    ["you", "trade", "wood"],
    ["you", "trade", "wood", "with"],
    ["you", "trade", "wood", "for"],
    ["you", "eat", "with"],
    ["you", "get", "ball", "for"],
    ["you", "drop", "ball"],
    ["you", "sit"],
  ];

  it("same input ⇒ same board, and noun order never matters", () => {
    for (const tokens of CASES) {
      expect(surfaceNext(tokens, ctx())).toEqual(surfaceNext(tokens, ctx()));
      const reversed = surfaceNext(tokens, ctx({ nouns: [...NOUNS].reverse() }));
      expect({ tokens, syms: reversed.buttons.map((b) => b.symbol) }).toEqual({
        tokens,
        syms: surfaceNext(tokens, ctx()).buttons.map((b) => b.symbol),
      });
    }
  });

  it("never a duplicate button, never over capacity", () => {
    for (const tokens of CASES) {
      const s = surfaceNext(tokens, ctx({ capacity: 8 }));
      expect(s.buttons.length).toBeLessThanOrEqual(8);
      const k = s.buttons.map((b) => b.symbol);
      expect({ tokens, unique: new Set(k).size === k.length }).toEqual({ tokens, unique: true });
    }
  });

  it("every surfaced word still continues into a meaningful frame", () => {
    for (const tokens of CASES) {
      for (const b of surfaceNext(tokens, ctx()).buttons) {
        const frame = parseSentence([...tokens, b.symbol].join(" + "));
        expect(`${tokens.join("+")}▸${b.symbol}:${frame.kind}`).not.toContain(":unclear");
      }
    }
  });
});
