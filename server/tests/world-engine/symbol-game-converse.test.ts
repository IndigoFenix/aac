// Symmetric conversation over the dialogue engine (creature-converse.ts): map a
// player sentence to an act, an NPC speaker policy, one exchange, and knowledge that
// SPREADS by asking. Pure — safe in the default `npm test`.

import { describe, it, expect } from "@jest/globals";
import { createCreatureWorld, seeItem } from "@shared/world-engine/interaction/behavior/creatures.js";
import { projectDialogue, selectAct, type ProjectionOpts } from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";
import {
  askWhere,
  chooseSpeakerAct,
  converse,
  intentToAct,
  pickSpeakerAct,
} from "@shared/world-engine/interaction/dialogue/creature-converse.js";
import { personalityFromPreset } from "@shared/world-engine/interaction/behavior/personality.js";
import { tellFact } from "@shared/world-engine/interaction/behavior/facts.js";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";

// symbolOf: an item id → its kind glyph ("cookie1" → "cookie").
const opts = (world: ReturnType<typeof createCreatureWorld>): ProjectionOpts => ({
  symbolOf: (id) => world.items[id]?.kind ?? id,
});

describe("intentToAct — a sentence → a dialogue act (speaker me, listener bear)", () => {
  // The player ("me") carries a sock; bear holds a cookie.
  const world = createCreatureWorld(
    [{ id: "me" }, { id: "bear" }],
    [
      { id: "cookie1", ownerId: "bear", kind: "cookie" },
      { id: "sock1", ownerId: "me", kind: "sock" },
    ],
  );
  const o = opts(world);

  it("i_me want cookie → request the LISTENER's cookie", () => {
    expect(intentToAct(parseSentence("i_me + want + cookie"), world, "me", "bear", o)).toMatchObject({
      kind: "request",
      itemId: "cookie1",
    });
  });

  it("i_me give sock → offer the SPEAKER's own sock", () => {
    expect(intentToAct(parseSentence("i_me + give + sock"), world, "me", "bear", o)).toMatchObject({
      kind: "offer",
      itemId: "sock1",
    });
  });

  // NEGATION IS HALF THE SENTENCE. "I won't give you the sock" parses as an
  // OFFER frame carrying negated:true — reading only the frame kind handed the
  // sock over, which is the one answer the speaker did not give.
  it("i_me give.not sock → REFUSE, never the offer the frame looks like", () => {
    expect(intentToAct(parseSentence("i_me + give.not + sock"), world, "me", "bear", o)).toMatchObject({
      kind: "refuse",
    });
  });

  it("i_me have.not cookie → CANT (denying possession, not willingness)", () => {
    expect(intentToAct(parseSentence("i_me + have.not + cookie"), world, "me", "bear", o)).toMatchObject({
      kind: "cant",
    });
  });

  it("i_me help.not you → refuse", () => {
    expect(intentToAct(parseSentence("i_me + help.not + you"), world, "me", "bear", o)).toMatchObject({
      kind: "refuse",
    });
  });

  // A SWAP names both sides: mine before `for`, theirs after. Reading only the
  // first half made an exchange land as a remark about a sock.
  it("sock for cookie → propose the TRADE, both items real", () => {
    expect(intentToAct(parseSentence("sock + for + cookie"), world, "me", "bear", o)).toMatchObject({
      kind: "trade",
      itemId: "cookie1",
    });
  });

  it("a swap naming something nobody holds is not a trade", () => {
    expect(intentToAct(parseSentence("sock + for + boat"), world, "me", "bear", o)).not.toMatchObject({
      kind: "trade",
    });
  });

  it("where cookie → a where-is query about it", () => {
    expect(intentToAct(parseSentence("where + cookie"), world, "me", "bear", o)).toMatchObject({
      kind: "where-is",
      itemId: "cookie1",
    });
  });

  it("a bare statement is an ASSERT → tell (never a dead end)", () => {
    // "cookie here" is a mention/state — it maps to a `tell`, so it still gets a reply.
    expect(intentToAct(parseSentence("cookie + here"), world, "me", "bear", o)?.kind).toBe("tell");
  });

  it("social acts map to their dialogue moves", () => {
    expect(intentToAct(parseSentence("hi"), world, "me", "bear", o)?.kind).toBe("how-are-you");
    expect(intentToAct(parseSentence("yes"), world, "me", "bear", o)?.kind).toBe("agree");
    expect(intentToAct(parseSentence("no"), world, "me", "bear", o)?.kind).toBe("refuse");
    expect(intentToAct(parseSentence("bye"), world, "me", "bear", o)?.kind).toBe("bye");
  });

  it("a command is NOT a dialogue move (handled by the party layer)", () => {
    expect(intentToAct(parseSentence("you + go + home"), world, "me", "bear", o)).toBeNull();
  });
});

describe("tell — an ASSERT shares a fact into the listener's knowledge", () => {
  it("me tells bear where the cookie is; bear LEARNS it", () => {
    const w = createCreatureWorld(
      [{ id: "me" }, { id: "bear" }],
      [{ id: "cookie1", ownerId: "fox", kind: "cookie" }],
    );
    seeItem(w, "me", "cookie1", { kind: "held", by: "fox" }); // I know fox has it
    expect(w.creatures.bear!.knowledge.cookie1).toBeUndefined(); // bear doesn't
    const act = intentToAct(parseSentence("cookie"), w, "me", "bear", opts(w))!;
    expect(act.kind).toBe("tell");
    const res = selectAct(w, "bear", "me", act, "c", opts(w));
    // Information received is THANKED — "ok" is reserved for accepted orders (①a §1).
    expect(res.responseGlyph).toBe("thank_you");
    expect(w.creatures.bear!.knowledge.cookie1).toEqual({ kind: "held", by: "fox" }); // spread
  });
});

describe("pickSpeakerAct + converse — NPCs use the SAME engine as the player", () => {
  function world() {
    const w = createCreatureWorld(
      [{ id: "fox", needs: [{ itemId: "cookie1", value: 3 }] }, { id: "bear", debts: { fox: 3 } }],
      [{ id: "cookie1", ownerId: "bear", kind: "cookie" }],
    );
    seeItem(w, "fox", "cookie1", { kind: "held", by: "bear" }); // fox knows bear has it
    return w;
  }

  it("a needy speaker requests the item the listener holds", () => {
    const w = world();
    const act = pickSpeakerAct(w, "fox", "bear", "c", opts(w));
    expect(act).toMatchObject({ kind: "request", itemId: "cookie1" });
  });

  it("one exchange: fox asks, bear (owing fox) hands it over", () => {
    const w = world();
    const turn = converse(w, "fox", "bear", "c", opts(w));
    expect(turn?.speakerAct.kind).toBe("request");
    expect(turn?.result.responseGlyph).toBe("yes"); // bear accepts (covering debt)
  });
});

describe("how-are-you surfaces the creature's PROBLEM (are-you-ok → report it)", () => {
  it("a conditioned creature reports its condition ('I am hungry'), not a bare 'ok'", () => {
    const w = createCreatureWorld(
      [{ id: "bear", condition: "hungry", needs: [{ itemId: "food1", value: 3, target: { category: "food" } }] }, { id: "me" }],
      [],
    );
    expect(selectAct(w, "bear", "me", { kind: "how-are-you", glyph: "" }, "b", opts(w)).responseGlyph).toContain("hungry");
  });

  it("a wanting creature states its want instead of 'ok'", () => {
    const w = createCreatureWorld(
      [{ id: "bear", needs: [{ itemId: "food1", value: 3, target: { category: "food" } }] }, { id: "me" }],
      [],
    );
    const res = selectAct(w, "bear", "me", { kind: "how-are-you", glyph: "" }, "b", opts(w));
    expect(res.responseGlyph).not.toBe("ok");
    expect(res.responseGlyph).toContain("food");
  });

  it("a content creature reports the simple positive state (never a generic 'ok')", () => {
    const w = createCreatureWorld([{ id: "bear" }, { id: "me" }], []);
    expect(selectAct(w, "bear", "me", { kind: "how-are-you", glyph: "" }, "b", opts(w)).responseGlyph).toBe("i_me + happy");
  });
});

describe("chooseSpeakerAct — an NPC picks from the SAME board, by personality + random", () => {
  // Fox needs bear's cookie AND could offer its own sock; the board carries both a
  // request and small talk. Which the fox leads with is a matter of its dials.
  function world() {
    const w = createCreatureWorld(
      [{ id: "fox", needs: [{ itemId: "cookie1", value: 3 }] }, { id: "bear" }],
      [{ id: "cookie1", ownerId: "bear", kind: "cookie" }],
    );
    seeItem(w, "fox", "cookie1", { kind: "held", by: "bear" });
    return w;
  }
  const constRng = (v: number) => () => v;

  it("a needy, assertive speaker leads with the request", () => {
    const w = world();
    const act = chooseSpeakerAct(w, "fox", "bear", "c", opts(w), {
      personality: personalityFromPreset("soldier", { assertiveness: 1 }),
      rng: constRng(0.5), // mid-mass lands in the request bucket — it dwarfs the rest
    });
    expect(act?.kind).toBe("request");
  });

  it("never utters a menu-OPENER, but CAN ask a concrete sub-item (where is {place})", () => {
    // A listener with several askable places surfaces a `directions-menu` OPENER on the
    // board. The NPC must never "say" the opener — but it may ask about a specific place
    // (a directions-pick). Sweep the RNG: no opener/navigation is ever chosen, and a
    // concrete pick IS reachable.
    const w = createCreatureWorld([{ id: "fox" }, { id: "bear" }], []);
    const o: ProjectionOpts = {
      symbolOf: (id) => w.items[id]?.kind ?? id,
      askDirections: [
        { id: "a", glyph: "house" },
        { id: "b", glyph: "market" },
      ], // ≥2 → a directions-menu opener appears on the board
    };
    const banned = new Set(["directions-menu", "trade-menu", "back", "more", "confused"]);
    const kinds = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const act = chooseSpeakerAct(w, "fox", "bear", "c", o, { rng: constRng(i / 20) });
      if (act) kinds.add(act.kind);
      expect(act && banned.has(act.kind)).toBeFalsy();
    }
    expect(kinds.has("directions-pick")).toBe(true); // the concrete "where is X" IS sayable
  });

  it("with no motive and the RNG at the tail, it still picks SOME act (never null/dead)", () => {
    // Bear has no needs, holds nothing the other wants — weights collapse to the floor,
    // so selection is essentially uniform-random. It must still return a real act.
    const w = createCreatureWorld([{ id: "cat" }, { id: "bear" }], []);
    const act = chooseSpeakerAct(w, "cat", "bear", "c", opts(w), { rng: constRng(0.999) });
    expect(act).not.toBeNull();
    expect(typeof act!.kind).toBe("string");
  });

  it("mood-driven converse still completes an exchange", () => {
    const w = world();
    const turn = converse(w, "fox", "bear", "c", opts(w), {}, {
      personality: personalityFromPreset("person"),
      rng: constRng(0.5),
    });
    expect(turn?.speakerAct.kind).toBe("request");
    expect(turn?.result).toBeTruthy();
  });
});

describe("where-is on a resource WANT points to the source (bug #2)", () => {
  // A shopper wants "food" (a resource TYPE) but knows no specific instance — asking it
  // "where is food?" must POINT to where it shops (directions), not answer "I don't know".
  const shopper = () =>
    createCreatureWorld(
      [{ id: "res", needs: [{ itemId: "good:food", value: 2, target: { category: "food" } }] }, { id: "me" }],
      [],
    );

  it("with a known source, where-is redirects to the market directions subject", () => {
    const w = shopper();
    const o: ProjectionOpts = {
      symbolOf: (id) => id,
      directionsForNeed: (n) => (n.target?.category === "food" ? "buy:good:food" : undefined),
    };
    const res = selectAct(w, "res", "me", { kind: "where-is", itemId: "good:food", subjectId: "buy:good:food", glyph: "" }, "b", o);
    expect(res.askedDirections).toBe("buy:good:food");
  });

  it("projectDialogue attaches that source subject to the shopper's own where-is button", () => {
    const w = shopper();
    const o: ProjectionOpts = {
      symbolOf: (id) => id,
      directionsForNeed: (n) => (n.target?.category === "food" ? "buy:good:food" : undefined),
    };
    const whereIs = projectDialogue(w, "res", "me", "b", o).acts.find((a) => a.kind === "where-is");
    expect(whereIs?.subjectId).toBe("buy:good:food");
  });

  it("without a known source it still honestly says 'I don't know'", () => {
    const w = shopper();
    const res = selectAct(w, "res", "me", { kind: "where-is", itemId: "good:food", glyph: "" }, "b", { symbolOf: (id) => id });
    expect(res.askedDirections).toBeUndefined();
    expect(res.responseGlyph).toContain("think.not");
  });
});

describe("where-going — ask a moving creature its destination (bug #4)", () => {
  const goWorld = () => createCreatureWorld([{ id: "res" }, { id: "me" }], []);

  it("'you go where' maps to a where-going act (not an item where-is)", () => {
    const w = goWorld();
    expect(intentToAct(parseSentence("you + go + where"), w, "me", "res", opts(w))?.kind).toBe("where-going");
  });

  it("answers 'going to get food' from a fetch errand", () => {
    const o: ProjectionOpts = { symbolOf: (id) => id, goingOf: () => ({ kind: "fetch", good: "food" }) };
    const res = selectAct(goWorld(), "res", "me", { kind: "where-going", glyph: "" }, "c", o);
    expect(res.responseGlyph).toContain("get");
    expect(res.responseGlyph).toContain("food");
  });

  it("answers 'going home' from a to_home errand", () => {
    const o: ProjectionOpts = { symbolOf: (id) => id, goingOf: () => ({ kind: "home" }) };
    expect(selectAct(goWorld(), "res", "me", { kind: "where-going", glyph: "" }, "b", o).responseGlyph).toContain("home");
  });

  it("a stationary creature (no destination) answers 'I'm here'", () => {
    const res = selectAct(goWorld(), "res", "me", { kind: "where-going", glyph: "" }, "b", { symbolOf: (id) => id });
    expect(res.responseGlyph).toContain("here");
  });

  it("the where-going button appears ONLY while the creature is en route", () => {
    const w = goWorld();
    const enRoute: ProjectionOpts = { symbolOf: (id) => id, goingOf: () => ({ kind: "home" }) };
    const still: ProjectionOpts = { symbolOf: (id) => id };
    expect(projectDialogue(w, "res", "me", "b", enRoute).acts.some((a) => a.kind === "where-going")).toBe(true);
    expect(projectDialogue(w, "res", "me", "b", still).acts.some((a) => a.kind === "where-going")).toBe(false);
  });
});

describe("askWhere — asking SPREADS knowledge (new info enters knowledge)", () => {
  it("fox learns where the cookie is by asking bear, who knows", () => {
    const w = createCreatureWorld([{ id: "fox" }, { id: "bear" }], [{ id: "cookie1", ownerId: "bear", kind: "cookie" }]);
    expect(w.creatures.fox!.knowledge.cookie1).toBeUndefined(); // fox is ignorant
    const ans = askWhere(w, "fox", "bear", "cookie1", "c", opts(w));
    expect(ans.responseGlyph).toBeTruthy(); // bear answers with a clue
    expect(ans.learned).toBe(true);
    expect(w.creatures.fox!.knowledge.cookie1).toEqual({ kind: "held", by: "bear" }); // fox now knows
  });

  it("asking someone who doesn't know teaches nothing", () => {
    const w = createCreatureWorld([{ id: "fox" }, { id: "cat" }], [{ id: "cookie1", ownerId: "bear", kind: "cookie" }]);
    const ans = askWhere(w, "fox", "cat", "cookie1", "c", opts(w));
    expect(ans.learned).toBe(false);
    expect(w.creatures.fox!.knowledge.cookie1).toBeUndefined();
  });
});

// ── Fact questions & statements (language-expansion.md): ask-fact / tell-fact
// wire the generic Fact channel (facts.ts) into conversation — third-party
// questions, polar yes/no asks, and attribute/presence assertions.

describe("fact questions — where/how/what-want about a THIRD party", () => {
  function household() {
    return createCreatureWorld(
      [{ id: "me" }, { id: "bob" }, { id: "mara", condition: "hungry" }],
      [
        { id: "apple1", ownerId: "mara", kind: "apple", states: ["hot"] },
        { id: "ball1", ownerId: "bob", kind: "ball" },
      ],
    );
  }
  const factOpts = (w: ReturnType<typeof createCreatureWorld>): ProjectionOpts => ({
    symbolOf: (id) => w.items[id]?.kind ?? id,
    symbolOfCreature: (cid) => cid,
    creatureOf: (sym) => (sym === "mara" || sym === "bob" ? sym : undefined),
  });

  it("where + mara → ask-fact presence; unknown answers the honest don't-know", () => {
    const w = household();
    const o = factOpts(w);
    const act = intentToAct(parseSentence("where + mara"), w, "me", "bob", o)!;
    expect(act).toMatchObject({ kind: "ask-fact", query: { kind: "presence", creature: "mara" } });
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("i_me + think.not");
  });

  it("a TOLD presence answers, and the answer teaches the ASKER", () => {
    const w = household();
    const o = factOpts(w);
    tellFact(w, "bob", { kind: "presence", creature: "mara", place: "kitchen" });
    const act = intentToAct(parseSentence("where + mara"), w, "me", "bob", o)!;
    const res = selectAct(w, "bob", "me", act, "c", o);
    expect(res.responseGlyph).toBe("mara + in + kitchen");
    expect(w.creatures.me!.facts?.["pres:mara"]).toEqual({ kind: "presence", creature: "mara", place: "kitchen" });
  });

  it("the ROSTER oracle (presenceOf) answers ahead of any stored belief", () => {
    const w = household();
    const o = { ...factOpts(w), presenceOf: (cid: string) => (cid === "mara" ? "work" : undefined) };
    const act = intentToAct(parseSentence("where + mara"), w, "me", "bob", o)!;
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("mara + in + work");
  });

  it("where + you → the listener is right here", () => {
    const w = household();
    const o = factOpts(w);
    const act = intentToAct(parseSentence("where + you"), w, "me", "bob", o)!;
    expect(act).toMatchObject({ kind: "ask-fact", query: { kind: "presence", creature: "bob" } });
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("i_me + here");
  });

  it("how + mara (asked of bob) → condition fact; how + you stays small talk", () => {
    const w = household();
    const o = factOpts(w);
    const third = intentToAct(parseSentence("how + mara"), w, "me", "bob", o)!;
    expect(third).toMatchObject({ kind: "ask-fact", query: { kind: "condition", creature: "mara" } });
    expect(selectAct(w, "bob", "me", third, "c", o).responseGlyph).toBe("i_me + think.not");
    tellFact(w, "bob", { kind: "condition", creature: "mara", condition: "hungry" });
    expect(selectAct(w, "bob", "me", third, "c", o).responseGlyph).toBe("mara + hungry");
    expect(intentToAct(parseSentence("how + you"), w, "me", "bob", o)?.kind).toBe("how-are-you");
  });

  it("what + want + mara (asked of bob) → a want fact", () => {
    const w = household();
    const o = factOpts(w);
    const act = intentToAct(parseSentence("what + want + mara"), w, "me", "bob", o)!;
    expect(act).toMatchObject({ kind: "ask-fact", query: { kind: "want", creature: "mara" } });
    w.creatures.bob!.knownWants["ball1"] = "mara";
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("mara + want + ball");
  });

  it("polar attribute ask → yes / no / don't-know", () => {
    const w = household();
    const o = factOpts(w);
    // Mara HOLDS the hot apple — holding is seeing, she answers yes.
    const askMara = intentToAct(parseSentence("apple + hot#question"), w, "me", "mara", o)!;
    expect(askMara).toMatchObject({ kind: "ask-fact", expect: "hot" });
    expect(selectAct(w, "mara", "me", askMara, "c", o).responseGlyph).toBe("yes");
    // Bob neither holds nor heard of it — the honest don't-know.
    const askBob = intentToAct(parseSentence("apple + hot#question"), w, "me", "bob", o)!;
    expect(selectAct(w, "bob", "me", askBob, "c", o).responseGlyph).toBe("i_me + think.not");
    // Told it's cold, bob answers no.
    tellFact(w, "bob", { kind: "itemState", item: "apple1", axis: "temperature", state: "cold" });
    expect(selectAct(w, "bob", "me", askBob, "c", o).responseGlyph).toBe("no");
  });

  it("you + ok#question stays the how-are-you greeting", () => {
    const w = household();
    expect(intentToAct(parseSentence("you + ok#question"), w, "me", "bob", factOpts(w))?.kind).toBe("how-are-you");
  });
});

describe("fact statements — attribute / presence assertions spread knowledge", () => {
  function household() {
    return createCreatureWorld(
      [{ id: "me" }, { id: "bob" }, { id: "mara", condition: "hungry" }],
      [{ id: "apple1", ownerId: "me", kind: "apple", states: ["hot"] }],
    );
  }
  const factOpts = (w: ReturnType<typeof createCreatureWorld>): ProjectionOpts => ({
    symbolOf: (id) => w.items[id]?.kind ?? id,
    symbolOfCreature: (cid) => cid,
    creatureOf: (sym) => (sym === "mara" || sym === "bob" ? sym : undefined),
  });

  it("mara + hungry (told to bob) writes the condition fact; bob thanks", () => {
    const w = household();
    const o = factOpts(w);
    const act = intentToAct(parseSentence("mara + hungry"), w, "me", "bob", o)!;
    expect(act).toMatchObject({
      kind: "tell-fact",
      fact: { kind: "condition", creature: "mara", condition: "hungry" },
    });
    const res = selectAct(w, "bob", "me", act, "c", o);
    expect(res.responseGlyph).toBe("thank_you");
    expect(w.creatures.bob!.facts?.["cond:mara"]).toEqual({ kind: "condition", creature: "mara", condition: "hungry" });
  });

  it("apple + hot (told to bob) writes the item-state fact", () => {
    const w = household();
    const o = factOpts(w);
    const act = intentToAct(parseSentence("apple + hot"), w, "me", "bob", o)!;
    expect(act).toMatchObject({
      kind: "tell-fact",
      fact: { kind: "itemState", item: "apple1", axis: "temperature", state: "hot" },
    });
    selectAct(w, "bob", "me", act, "c", o);
    expect(w.creatures.bob!.facts?.["state:apple1:temperature"]).toBeDefined();
  });

  it("mara + in + kitchen then where + mara — the told fact answers", () => {
    const w = household();
    const o = factOpts(w);
    const tell = intentToAct(parseSentence("mara + in + kitchen"), w, "me", "bob", o)!;
    expect(tell).toMatchObject({ kind: "tell-fact", fact: { kind: "presence", creature: "mara", place: "kitchen" } });
    selectAct(w, "bob", "me", tell, "c", o);
    const ask = intentToAct(parseSentence("where + mara"), w, "me", "bob", o)!;
    expect(selectAct(w, "bob", "me", ask, "c", o).responseGlyph).toBe("mara + in + kitchen");
  });

  it("a claim about the LISTENER ITSELF is confirmed or corrected, never absorbed", () => {
    const w = household();
    const o = factOpts(w);
    // Mara IS hungry — she confirms.
    const right = intentToAct(parseSentence("you + hungry"), w, "me", "mara", o)!;
    expect(right).toMatchObject({ kind: "tell-fact", fact: { kind: "condition", creature: "mara" } });
    expect(selectAct(w, "mara", "me", right, "c", o).responseGlyph).toBe("yes");
    // Bob is fine — he corrects.
    const wrong = intentToAct(parseSentence("you + hungry"), w, "me", "bob", o)!;
    expect(selectAct(w, "bob", "me", wrong, "c", o).responseGlyph).toBe("i_me + hungry.not");
  });
});

// ── Question expansion round 2 (language-expansion.md follow-up): every question
// gets SOME honest response — nonsense earns "I don't understand" (never a
// non-sequitur "I'm fine"), a false premise earns a correction, an unresolvable
// where-is earns "I don't know", and value-SEARCH questions ("what is hot?",
// "who is hungry?") answer from knowledge.

describe("question fallbacks — no question is a dead end", () => {
  function household() {
    return createCreatureWorld(
      [{ id: "me" }, { id: "bob" }, { id: "mara", condition: "hungry" }],
      [
        { id: "apple1", ownerId: "mara", kind: "apple", states: ["hot"] },
        { id: "ball1", ownerId: "bob", kind: "ball" },
      ],
    );
  }
  const factOpts = (w: ReturnType<typeof createCreatureWorld>): ProjectionOpts => ({
    symbolOf: (id) => w.items[id]?.kind ?? id,
    symbolOfCreature: (cid) => cid,
    creatureOf: (sym) => (sym === "mara" || sym === "bob" ? sym : undefined),
  });

  it("an unrecognized question answers 'I don't understand', never small talk", () => {
    const w = household();
    const o = factOpts(w);
    for (const s of ["what + ball", "who + go"]) {
      const act = intentToAct(parseSentence(s), w, "me", "bob", o)!;
      expect(act.kind).toBe("dont-understand");
      expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("i_me + understand.not");
    }
  });

  it("'what is the ball eating?' corrects the premise — a thing isn't doing anything", () => {
    const w = household();
    const o = factOpts(w);
    // "ball" names a real ITEM but no creature — the honest premise fix, not
    // a dead-end don't-understand (semantic-tests §Questions).
    const act = intentToAct(parseSentence("what + eat + ball"), w, "me", "bob", o)!;
    expect(act.kind).toBe("what-doing");
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("ball + eat.not");
  });

  it("why + verb checks the PREMISE: not doing it → 'I don't build'", () => {
    const w = household();
    // The host says bob is verifiably walking (doingOf) — a "why build" denies.
    const o = { ...factOpts(w), doingOf: () => ["go", "come", "walk", "run"] };
    const deny = intentToAct(parseSentence("why + you + build"), w, "me", "bob", o)!;
    expect(deny).toMatchObject({ kind: "deny-doing", verb: "build" });
    expect(selectAct(w, "bob", "me", deny, "c", o).responseGlyph).toBe("i_me + build.not");
  });

  it("why + verb it IS doing → the motive answer; unverifiable → don't-understand", () => {
    const w = household();
    const walking = { ...factOpts(w), doingOf: () => ["go", "come", "walk", "run"] };
    // Movement verbs skip the premise check — walking is need-driven.
    expect(intentToAct(parseSentence("why + you + go"), w, "me", "bob", walking)?.kind).toBe("why");
    // No doingOf hook (or undefined) — the honest can't-interpret floor.
    const blind = factOpts(w);
    expect(intentToAct(parseSentence("why + you + build"), w, "me", "bob", blind)?.kind).toBe("dont-understand");
    // Bare "why" stays the classic motive/cause reveal.
    expect(intentToAct(parseSentence("why"), w, "me", "bob", blind)?.kind).toBe("why");
  });

  it("where + <nothing anyone has> answers 'I don't know', never silence", () => {
    const w = household();
    const o = factOpts(w);
    const act = intentToAct(parseSentence("where + sock"), w, "me", "bob", o)!;
    expect(act.kind).toBe("where-is");
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("i_me + think.not");
  });

  it("who + have + ball → the holder clue", () => {
    const w = household();
    const o = factOpts(w);
    // bob HOLDS the ball — holding is knowing; me asks bob, bob names himself.
    seeItem(w, "bob", "ball1", { kind: "held", by: "bob" });
    const act = intentToAct(parseSentence("who + have + ball"), w, "me", "bob", o)!;
    expect(act).toMatchObject({ kind: "where-is", itemId: "ball1" });
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toContain("have + ball");
  });

  it("what + hot → a state SEARCH over knowledge ('apple + hot')", () => {
    const w = household();
    const o = factOpts(w);
    const act = intentToAct(parseSentence("what + hot"), w, "me", "bob", o)!;
    expect(act).toMatchObject({ kind: "ask-fact", query: { kind: "stateSearch", state: "hot" } });
    // Bob knows nothing hot — the honest don't-know.
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("i_me + think.not");
    // Mara HOLDS the hot apple — holding is seeing.
    expect(selectAct(w, "mara", "me", act, "c", o).responseGlyph).toBe("apple + hot");
    // Told about it, bob can answer too — and the answer teaches the asker.
    tellFact(w, "bob", { kind: "itemState", item: "apple1", axis: "temperature", state: "hot" });
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("apple + hot");
    expect(w.creatures.me!.facts?.["state:apple1:temperature"]).toBeDefined();
  });

  it("who + hungry → a condition SEARCH ('mara + hungry'; own truth answers too)", () => {
    const w = household();
    const o = factOpts(w);
    const act = intentToAct(parseSentence("who + hungry"), w, "me", "bob", o)!;
    expect(act).toMatchObject({ kind: "ask-fact", query: { kind: "conditionSearch", condition: "hungry" } });
    // Bob doesn't know of anyone hungry.
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("i_me + think.not");
    // Mara IS hungry — her own condition is always known truth.
    expect(selectAct(w, "mara", "me", act, "c", o).responseGlyph).toBe("i_me + hungry");
    // Bob heard about mara — he names her.
    tellFact(w, "bob", { kind: "condition", creature: "mara", condition: "hungry" });
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("mara + hungry");
  });
});

describe("activity questions — 'what is X doing / eating?' (semantic-tests §Questions)", () => {
  function household() {
    return createCreatureWorld(
      [{ id: "me" }, { id: "bob" }, { id: "dog" }],
      [{ id: "apple1", ownerId: "dog", kind: "apple" }, { id: "ball1", ownerId: "bob", kind: "ball" }],
    );
  }
  const factOpts = (w: ReturnType<typeof createCreatureWorld>): ProjectionOpts => ({
    symbolOf: (id) => w.items[id]?.kind ?? id,
    symbolOfCreature: (cid) => cid,
    creatureOf: (sym) => (sym === "dog" || sym === "bob" ? sym : undefined),
  });

  it("answers with the live activity and its object: 'the dog is eating the apple'", () => {
    const w = household();
    const o: ProjectionOpts = { ...factOpts(w), activityOf: () => ({ verb: "eat", object: "apple" }) };
    const act = intentToAct(parseSentence("what + dog + eat"), w, "me", "bob", o)!;
    expect(act).toMatchObject({ kind: "what-doing", verb: "eat", about: { symbol: "dog", id: "dog" } });
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("dog + eat + apple");
  });

  it("corrects a wrong presumed activity: 'the dog is not eating'", () => {
    const w = household();
    const o: ProjectionOpts = { ...factOpts(w), activityOf: () => ({ verb: "play" }) };
    const act = intentToAct(parseSentence("what + dog + eat"), w, "me", "bob", o)!;
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("dog + eat.not");
  });

  it("a symbol naming NOTHING answers 'there is no {X}'", () => {
    const w = household();
    const o = factOpts(w);
    const act = intentToAct(parseSentence("what + cat + eat"), w, "me", "bob", o)!;
    expect(act).toMatchObject({ kind: "what-doing", about: { symbol: "cat" } });
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("no + cat");
  });

  it("broad 'what + you + do' answers the listener's own activity in first person", () => {
    const w = household();
    const o: ProjectionOpts = { ...factOpts(w), activityOf: () => ({ verb: "wash", object: "clothing" }) };
    const act = intentToAct(parseSentence("what + you + do"), w, "me", "bob", o)!;
    expect(act.kind).toBe("what-doing");
    expect(act.verb).toBeUndefined(); // broad — no presumed activity
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("i_me + wash + clothing");
  });

  it("verifiably idle: broad ask → 'I'm not doing'; specific ask → the denial", () => {
    const w = household();
    const o: ProjectionOpts = { ...factOpts(w), activityOf: () => null };
    const broad = intentToAct(parseSentence("what + you + do"), w, "me", "bob", o)!;
    expect(selectAct(w, "bob", "me", broad, "c", o).responseGlyph).toBe("i_me + do.not");
    const specific = intentToAct(parseSentence("what + bob + eat"), w, "me", "bob", o)!;
    expect(selectAct(w, "bob", "me", specific, "c", o).responseGlyph).toBe("i_me + eat.not");
  });

  it("no activity hook at all → the honest don't-know, never a fabricated answer", () => {
    const w = household();
    const o = factOpts(w);
    const act = intentToAct(parseSentence("what + dog + eat"), w, "me", "bob", o)!;
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("i_me + think.not");
  });

  it("falls back to doingOf (verb only) when activityOf is absent", () => {
    const w = household();
    const o: ProjectionOpts = { ...factOpts(w), doingOf: () => ["eat"] };
    const act = intentToAct(parseSentence("what + dog + eat"), w, "me", "bob", o)!;
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("dog + eat");
  });
});

describe("the source ask — 'where do we get an apple?'", () => {
  it("where + get + {X} routes to the provider/source chain, not an instance clue", () => {
    const w = createCreatureWorld([{ id: "me" }, { id: "bob" }], [{ id: "apple1", kind: "apple" }]);
    const o: ProjectionOpts = { symbolOf: (id) => w.items[id]?.kind ?? id };
    const act = intentToAct(parseSentence("where + get + apple"), w, "me", "bob", o)!;
    expect(act).toMatchObject({ kind: "where-is", source: true, target: { kind: "apple" } });
    // Bob knows no provider and no instance — the honest don't-know.
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("i_me + think.not");
  });
});

describe("modal desires spoken at a creature", () => {
  it("'i_me want play' is a disclosure that gets acknowledged, never silence", () => {
    const w = createCreatureWorld([{ id: "me" }, { id: "bob" }], []);
    const o: ProjectionOpts = { symbolOf: (id) => id };
    const act = intentToAct(parseSentence("i_me + want + play"), w, "me", "bob", o)!;
    expect(act.kind).toBe("tell");
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("thank_you");
  });
});
