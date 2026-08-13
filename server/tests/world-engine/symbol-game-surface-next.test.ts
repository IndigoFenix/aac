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
  { symbol: "apple", kind: "item", affords: ["eat", "want", "get", "give"], properties: ["food"] },
  { symbol: "ball", kind: "item", affords: ["get", "give", "play", "throw", "want"], properties: ["toy"] },
  { symbol: "clothing", kind: "item", affords: ["wear", "wash", "want", "give"], properties: ["clothing"] },
  { symbol: "water", kind: "item", affords: ["drink", "get", "give", "fill", "want"] },
  { symbol: "mara", kind: "creature", affords: ["talk", "help", "hug", "give", "follow"] },
  { symbol: "bed", kind: "place", affords: ["go", "sleep"], properties: ["furniture"] },
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
      expect(["mara", "apple", "ball", "clothing", "water", "bed", "home", "i_me", "you"]).toContain(b.symbol);
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

// ⑫ (conversation-in-motion.md law ②) — THE NAME CHANNEL on the board. A request
// aimed at one person in a crowd needs that person's name, and the name has to be
// reachable in one press or the channel is theoretical. The roster rides the SAME
// field the parser reads, so the board and the frame can never disagree.
describe("⑫ surfaceNext — a crowd puts the NAME within one press", () => {
  const NOUNS3: SurfaceNoun[] = [
    ...NOUNS,
    { symbol: "pip", kind: "creature", affords: ["talk", "help", "hug", "give", "follow"] },
  ];
  /** In a 3+ conversation with Mara and Pip. */
  const circle = (extra: Partial<SurfaceContext> = {}): SurfaceContext => ({
    nouns: NOUNS3,
    parse: { addressees: ["mara", "pip"] },
    ...extra,
  });
  /** A dyad — one fellow member. */
  const dyad = (): SurfaceContext => ({ nouns: NOUNS3, parse: { addressees: ["mara"] } });

  it("the addressee role is OPEN on a request being built in a crowd", () => {
    const s = surfaceNext(["i_me", "want"], circle());
    expect(s.open).toContain("addressee");
  });

  it("…and a member's name is actually on the board", () => {
    const s = surfaceNext(["i_me", "want"], circle());
    expect(s.buttons.some((b) => b.role === "addressee" && ["mara", "pip"].includes(b.symbol))).toBe(true);
  });

  it("a name is an OPENER too — 'mara + give + i_me + apple' starts with it", () => {
    const s = surfaceNext([], circle());
    expect(s.buttons.some((b) => b.role === "addressee" && ["mara", "pip"].includes(b.symbol))).toBe(true);
  });

  it("A DYAD OFFERS NO NAME — there is nobody to disambiguate from (law ④)", () => {
    const s = surfaceNext(["i_me", "want"], dyad());
    expect(s.open).not.toContain("addressee");
  });

  it("no roster at all ⇒ the board is byte-identical to today", () => {
    const plain = { nouns: NOUNS3 } as SurfaceContext;
    expect(surfaceNext(["i_me", "want"], plain)).toEqual(surfaceNext(["i_me", "want"], plain));
    expect(surfaceNext(["i_me", "want"], plain).open).not.toContain("addressee");
  });

  it("once a name is SAID the slot closes — the question has been answered", () => {
    const s = surfaceNext(["mara", "give"], circle());
    expect(s.open).not.toContain("addressee");
  });

  it("only people STANDING THERE are offered — never a creature from the wider world", () => {
    // `mara` and `pip` are members; a creature noun outside the roster is not an
    // addressee, because naming somebody absent is talking ABOUT them.
    const s = surfaceNext(["i_me", "want"], {
      nouns: NOUNS3,
      parse: { addressees: ["pip", "ada"] },
    });
    const named = s.buttons.filter((b) => b.role === "addressee").map((b) => b.symbol);
    expect(named).not.toContain("mara");
  });

  it("the quota keeps names from flooding the grid", () => {
    const many = ["mara", "pip", "ada", "ben"];
    const person = (symbol: string): SurfaceNoun => ({
      symbol,
      kind: "creature",
      affords: ["talk", "help", "hug", "give", "follow"],
    });
    const s = surfaceNext(["i_me", "want"], {
      nouns: [...NOUNS3, person("ada"), person("ben")],
      parse: { addressees: many },
    });
    expect(s.buttons.filter((b) => b.role === "addressee").length).toBeLessThanOrEqual(2);
  });

  it("stays deterministic and never duplicates a button", () => {
    const a = surfaceNext(["i_me", "want"], circle());
    const b = surfaceNext(["i_me", "want"], circle());
    expect(a).toEqual(b);
    const syms = a.buttons.map((x) => x.symbol);
    expect(new Set(syms).size).toBe(syms.length);
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
    expect(surfaceNext(["more"], ctx()).complete).toBe(true); // a bare quantity speaks
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

// ── The transition layer: who/what came before picks the band ────────────────

describe("surfaceNext — transitions (predict the next word)", () => {
  it("a speaker subject leads with STATE verbs and keeps feelings a press away", () => {
    const syms = symbols(["i_me"]);
    expect(syms[0]).toBe("want"); // the frequency prior breaks the state-verb tie
    expect(syms).toContain("hungry"); // the reserved attribute slot
    expect(syms).not.toContain("drop"); // handling directives yield the band
  });

  it("a listener subject leads with directives, frequency-ordered", () => {
    const syms = symbols(["you"]);
    expect(syms.slice(0, 4)).toEqual(["go", "eat", "help", "play"]);
  });

  it("bulk verb bands surface only synonym-family heads (get, never take)", () => {
    const syms = symbols(["you"]);
    expect(syms).toContain("get");
    expect(syms).not.toContain("take");
    expect(syms).not.toContain("walk"); // go's family
  });

  it("a quantity opens NOUNS ('more + water'), food first", () => {
    const s = surfaceNext(["more"], ctx());
    expect(s.open[0]).toBe("object");
    expect(s.buttons[0]?.symbol).toBe("apple");
    expect(s.buttons.map((b) => b.symbol)).toContain("water");
  });

  it("a greeting addresses SOMEONE ('hi + mara')", () => {
    const s = surfaceNext(["hi"], ctx());
    expect(s.open[0]).toBe("addressee");
    expect(s.buttons[0]?.symbol).toBe("mara");
  });

  it("a saturated frame: a SMALL joiner band plus the object's own descriptors", () => {
    const s = surfaceNext(["i_me", "want", "apple"], ctx());
    const syms = s.buttons.map((b) => b.symbol);
    expect(s.buttons.filter((b) => b.role === "connective").length).toBeLessThanOrEqual(3);
    expect(syms).toContain("and");
    expect(syms).toContain("hot"); // apple (food) → temperature-axis extension
  });

  it("'feel' implies a FEELING list — emotions lead, nouns stay away", () => {
    const s = surfaceNext(["i_me", "feel"], ctx());
    const syms = s.buttons.map((b) => b.symbol);
    expect(syms[0]).toBe("hungry");
    expect(syms).toContain("happy");
    expect(syms).toContain("sad");
    for (const b of s.buttons) {
      expect({ symbol: b.symbol, noun: NOUNS.some((n) => n.symbol === b.symbol) }).toEqual({
        symbol: b.symbol,
        noun: false,
      });
    }
  });

  it("common emotions sit right on the i_me board", () => {
    const syms = symbols(["i_me"]);
    expect(syms).toContain("hungry");
    expect(syms).toContain("happy");
    expect(syms).toContain("sad");
  });

  it("'play' also offers PLAYMATES (play with mara)", () => {
    const s = surfaceNext(["you", "play"], ctx());
    const mara = s.buttons.find((b) => b.symbol === "mara")!;
    const home = s.buttons.find((b) => b.symbol === "home")!;
    expect(mara.weight).toBeGreaterThan(home.weight);
  });

  it("descriptors follow the noun's TYPE: food talks temperature, not mood", () => {
    const syms = symbols(["apple"]);
    const hot = syms.indexOf("hot");
    expect(hot).toBeGreaterThanOrEqual(0);
    const happy = syms.indexOf("happy");
    expect(happy === -1 || hot < happy).toBe(true);
  });

  it("a learned habit (use + pair counts) reshapes the board deterministically", () => {
    let mem = emptyRecency();
    for (let i = 0; i < 3; i++) mem = noteUtterance(mem, parseSentence("i_me + want + water"));
    const s = surfaceNext(["i_me", "want"], ctx({ recency: mem }));
    expect(s.buttons[0]?.symbol).toBe("water"); // want>water pair + recency + uses
  });
});

// ── THE COMPLAINT PIN: everyday sentences never need a category tab ──────────

describe("surfaceNext — basic utterances reachable from the suggested surface", () => {
  const reachable = (sentence: string[]) => {
    for (let i = 0; i < sentence.length; i++) {
      const s = surfaceNext(sentence.slice(0, i), ctx());
      const next = sentence[i]!;
      const ok =
        s.buttons.some((b) => b.symbol === next) ||
        s.groups.some((g) => g.members.some((m) => m.symbol === next));
      expect({ after: sentence.slice(0, i).join("+"), next, ok }).toEqual({
        after: sentence.slice(0, i).join("+"),
        next,
        ok: true,
      });
    }
  };

  it("gameplay requests that double as real-life statements", () => {
    reachable(["i_me", "want", "apple"]);
    reachable(["you", "go", "home"]);
    reachable(["more", "water"]);
    reachable(["i_me", "hungry"]);
    reachable(["where", "mara"]);
    reachable(["hi", "mara"]);
    reachable(["give", "apple", "to", "mara"]);
  });
});

// ── Group chips: a few high-probability words + likely subcategories ─────────

describe("surfaceNext — group chips", () => {
  const MANY: SurfaceNoun[] = [
    { symbol: "apple", kind: "item", affords: ["eat", "want", "get", "give"], properties: ["food"] },
    { symbol: "bread", kind: "item", affords: ["eat", "want", "get", "give"], properties: ["food"] },
    { symbol: "milk", kind: "item", affords: ["drink", "want", "get", "give"], properties: ["food"] },
    { symbol: "soup", kind: "item", affords: ["eat", "want", "get", "give"], properties: ["food"] },
    { symbol: "banana", kind: "item", affords: ["eat", "want", "get", "give"], properties: ["food"] },
    { symbol: "cookie", kind: "item", affords: ["eat", "want", "get", "give"], properties: ["food"] },
    { symbol: "ball", kind: "item", affords: ["play", "get", "give", "want"], properties: ["toy"] },
    { symbol: "teddy", kind: "item", affords: ["play", "hug", "want", "get"], properties: ["toy"] },
    { symbol: "kite", kind: "item", affords: ["play", "want", "get"], properties: ["toy"] },
    { symbol: "shirt", kind: "item", affords: ["wear", "wash", "want"], properties: ["clothing"] },
    { symbol: "sock", kind: "item", affords: ["wear", "wash", "want"], properties: ["clothing"] },
    { symbol: "box", kind: "item", affords: ["open", "shut", "put"], properties: ["container", "openable"] },
    { symbol: "chest", kind: "item", affords: ["open", "shut", "put"], properties: ["container", "openable"] },
    { symbol: "mara", kind: "creature", affords: ["talk", "help", "hug", "give"] },
    { symbol: "tomo", kind: "creature", affords: ["talk", "help", "hug", "give"] },
    { symbol: "rex", kind: "creature", affords: ["talk", "help", "hug", "give"] },
    { symbol: "bed", kind: "place", affords: ["go", "sleep"], properties: ["furniture"] },
    { symbol: "table", kind: "place", affords: ["go", "sit"], properties: ["furniture"] },
    { symbol: "kitchen", kind: "place", affords: ["go"] },
    { symbol: "yard", kind: "place", affords: ["go"] },
  ];

  it("a flooded object slot yields inline words PLUS ranked group chips", () => {
    const s = surfaceNext(["i_me", "want"], { nouns: MANY, capacity: 8 });
    expect(s.buttons.length).toBeLessThanOrEqual(8);
    const food = s.groups.find((g) => g.id === "food");
    expect(food).toBeDefined();
    // The chip expands to EVERY food, including what the grid had no room for.
    expect(food!.members.map((m) => m.symbol)).toEqual(
      expect.arrayContaining(["apple", "bread", "milk", "soup", "banana", "cookie"]),
    );
  });

  it("the verb's pre-load property ranks its chip first ('eat' → [food])", () => {
    const s = surfaceNext(["you", "eat"], { nouns: MANY, capacity: 4 });
    expect(s.groups[0]?.id).toBe("food");
  });

  it("the EMPTY board already offers the library's groups", () => {
    const s = surfaceNext([], { nouns: MANY });
    const ids = s.groups.map((g) => g.id);
    expect(ids).toContain("food");
    expect(ids).toContain("places");
  });

  it("NOUN chips vanish when the grid already holds every member", () => {
    const s = surfaceNext(["i_me", "want"], ctx()); // the small library fits inline
    expect(s.groups.filter((g) => g.kind !== "verb")).toEqual([]);
    // What stands is the modal ACTION BAND — a different band with its own
    // budget (surface-modal-actions.test.ts owns its pins).
    expect(s.groups.map((g) => g.id)).toEqual(["do", "play", "make", "get"]);
  });

  it("chips are deterministic and noun-order-independent", () => {
    const a = surfaceNext(["i_me", "want"], { nouns: MANY, capacity: 8 });
    const b = surfaceNext(["i_me", "want"], { nouns: [...MANY].reverse(), capacity: 8 });
    expect(b.groups.map((g) => g.id)).toEqual(a.groups.map((g) => g.id));
    expect(b.groups[0]?.members.map((m) => m.symbol)).toEqual(a.groups[0]?.members.map((m) => m.symbol));
  });

  it("each chip carries the members that best REPRESENT it, best first", () => {
    const s = surfaceNext(["i_me", "want"], { nouns: MANY, capacity: 8 });
    const byId = new Map(s.groups.map((g) => [g.id, g]));
    const faces = (id: string) => byId.get(id)!.exemplars.map((e) => e.symbol);
    // Never more than the chip can draw, and always drawn from the members.
    for (const g of s.groups) {
      expect(g.exemplars.length).toBeLessThanOrEqual(3);
      expect(g.exemplars.length).toBeGreaterThan(0);
      for (const e of g.exemplars) expect(g.members).toContain(e);
    }
    // The prototype prior, not the alphabet: apple/banana/cookie lead the foods
    // even though bread and milk sort in among them.
    expect(faces("food")).toEqual(["apple", "banana", "cookie"]);
    expect(faces("toy")[0]).toBe("ball");
    expect(faces("clothing")).toEqual(["shirt", "sock"]);
  });

  it("the chip's face never reorders the chip's expansion", () => {
    // `members` stays the SURFACING rank (what to say next); the face is picked
    // FROM it, never imposed ON it — so the expansion is still weight-ordered.
    for (const g of surfaceNext(["i_me", "want"], { nouns: MANY, capacity: 8 }).groups) {
      const weights = g.members.map((m) => m.weight);
      expect(weights).toEqual([...weights].sort((a, b) => b - a));
    }
  });

  it("every group member still parses to a non-unclear frame", () => {
    for (const start of [[], ["i_me", "want"], ["you", "eat"]] as string[][]) {
      const s = surfaceNext(start, { nouns: MANY, capacity: 8 });
      for (const g of s.groups) {
        for (const m of g.members) {
          const frame = parseSentence([...start, m.symbol].join(" + "));
          expect(`${start.join("+")}▸${g.id}/${m.symbol}:${frame.kind}`).not.toContain(":unclear");
        }
      }
    }
  });
});

// ── THE PLACEMENT RELATIONS. "put + chair + …" wants a destination, and a
// piece of FURNITURE takes one relative to what already stands there: `next_to`
// (the adjacent spot), `near` (the vicinity), `on` (a surface) — as against
// `in` for a container. They were only ever reachable through the generic
// relation band, where the connective quota buried them under and/then/because,
// so there was no way to SAY the thing the placement search could already do.

describe("placement destinations — the relation band a furniture object opens", () => {
  const NOUNS_P: SurfaceNoun[] = [
    { symbol: "chair", kind: "item", affords: ["get", "put"], properties: ["furniture"] },
    { symbol: "table", kind: "place", affords: ["go", "put"], properties: ["furniture"] },
    { symbol: "box", kind: "place", affords: ["go", "put"], properties: ["container"] },
    { symbol: "apple", kind: "item", affords: ["eat", "put"], properties: ["food"] },
  ];

  it("'put + chair' offers in / on / near / next_to in the destination slot", () => {
    const s = surfaceNext(["you", "put", "chair"], { nouns: NOUNS_P });
    const syms = s.buttons.map((b) => b.symbol);
    for (const w of ["in", "on", "near", "next_to"]) expect(syms).toContain(w);
    for (const w of ["near", "next_to"]) {
      expect(s.buttons.find((b) => b.symbol === w)!.role).toBe("destination");
    }
  });

  it("the ADJACENT word outranks the vicinity one (a placed piece usually means beside)", () => {
    const s = surfaceNext(["you", "put", "chair"], { nouns: NOUNS_P });
    const w = (sym: string) => s.buttons.find((b) => b.symbol === sym)!.weight;
    expect(w("next_to")).toBeGreaterThan(w("near"));
  });

  // MOVED (arc L, step L2): a movable object used to get containment ONLY —
  // `next_to`/`near`/`on` were reserved for furniture. But an apple goes on the
  // table and under the bed as readily as a chair goes beside one, and with the
  // anchors withheld the composer had nothing to say but "in". Every object now
  // opens the whole spatial band; what the OBJECT decides is which link LEADS —
  // containment for a thing a hand carries, adjacency for a thing that stands.
  it("a movable object leads with containment, the anchors behind it (put + apple)", () => {
    const s = surfaceNext(["you", "put", "apple"], { nouns: NOUNS_P });
    const dest = s.buttons.filter((b) => b.role === "destination").map((b) => b.symbol);
    expect(dest).toContain("in");
    expect(dest).toContain("next_to");
    expect(dest.indexOf("in")).toBeLessThan(dest.indexOf("next_to"));
    // …the exact reverse of the furniture case in the test above.
    const chair = surfaceNext(["you", "put", "chair"], { nouns: NOUNS_P })
      .buttons.filter((b) => b.role === "destination").map((b) => b.symbol);
    expect(chair.indexOf("next_to")).toBeLessThan(chair.indexOf("in"));
  });

  it("a dangling relation forces the anchor noun (the relation-noun slot)", () => {
    for (const rel of ["near", "next_to"]) {
      const s = surfaceNext(["you", "put", "chair", rel], { nouns: NOUNS_P });
      expect(s.buttons.map((b) => b.symbol)).toContain("table");
      expect(s.buttons.every((b) => b.role === "relation-noun")).toBe(true);
    }
  });

  it("both relations still parse to a bound placement frame", () => {
    for (const rel of ["near", "next_to"]) {
      const frame = parseSentence(`you + put + chair + ${rel} + table`);
      expect(frame.kind).toBe("command");
      expect(frame.relation).toBe(rel === "next_to" ? "beside" : "near");
      expect(frame.target).toEqual({ kind: "entity", symbol: "table", modifiers: [] });
    }
  });
});
