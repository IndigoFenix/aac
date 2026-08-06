// Symmetric conversation over the dialogue engine (creature-converse.ts): map a
// player sentence to an act, an NPC speaker policy, one exchange, and knowledge that
// SPREADS by asking. Pure — safe in the default `npm test`.

import { describe, it, expect } from "@jest/globals";
import { createCreatureWorld, seeItem } from "@shared/world-engine/interaction/behavior/creatures.js";
import {
  projectDialogue,
  selectAct,
  type DialogueAct,
  type ProjectionOpts,
  type SourceAnswer,
} from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";
import {
  chooseSpeakerAct,
  chooseSpeakerMove,
  intentToAct,
  speakInConversation,
} from "@shared/world-engine/interaction/dialogue/creature-converse.js";
import {
  createConversation,
  joinConversation,
  type ConversationState,
} from "@shared/world-engine/interaction/dialogue/conversation.js";
import { personalityFromPreset } from "@shared/world-engine/interaction/behavior/personality.js";
import { tellFact } from "@shared/world-engine/interaction/behavior/facts.js";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";

// symbolOf: an item id → its kind glyph ("cookie1" → "cookie").
const opts = (world: ReturnType<typeof createCreatureWorld>): ProjectionOpts => ({
  symbolOf: (id) => world.items[id]?.kind ?? id,
});

/** A frozen draw — every roulette in these tests takes its slot from a constant,
 *  never from `Math.random`, so a frequency below is a fact about the code. */
const constRng = (v: number) => () => v;

/**
 * THE DYAD AS A ROSTER. `converse`/`pickSpeakerAct`/`askWhere` took a listener
 * POSITIONALLY; the modern surface takes a `ConversationState` and finds the
 * listener in it. A two-member conversation is therefore the exact shape those
 * wrappers used to be — which is why every migrated test below builds one
 * instead of passing a second creature id.
 */
function pair(a: string, b: string, level: "a" | "b" | "c" = "c"): ConversationState {
  const c = createConversation("convo", 0);
  joinConversation(c, a, 0, level);
  joinConversation(c, b, 0, level);
  return c;
}

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
    expect(intentToAct(parseSentence("i_me + want + cookie"), world, { speakerId: "me", addresseeId: "bear" }, o)).toMatchObject({
      kind: "request",
      itemId: "cookie1",
    });
  });

  it("i_me give sock → offer the SPEAKER's own sock", () => {
    expect(intentToAct(parseSentence("i_me + give + sock"), world, { speakerId: "me", addresseeId: "bear" }, o)).toMatchObject({
      kind: "offer",
      itemId: "sock1",
    });
  });

  // NEGATION IS HALF THE SENTENCE. "I won't give you the sock" parses as an
  // OFFER frame carrying negated:true — reading only the frame kind handed the
  // sock over, which is the one answer the speaker did not give.
  it("i_me give.not sock → REFUSE, never the offer the frame looks like", () => {
    expect(intentToAct(parseSentence("i_me + give.not + sock"), world, { speakerId: "me", addresseeId: "bear" }, o)).toMatchObject({
      kind: "refuse",
    });
  });

  it("i_me have.not cookie → CANT (denying possession, not willingness)", () => {
    expect(intentToAct(parseSentence("i_me + have.not + cookie"), world, { speakerId: "me", addresseeId: "bear" }, o)).toMatchObject({
      kind: "cant",
    });
  });

  it("i_me help.not you → refuse", () => {
    expect(intentToAct(parseSentence("i_me + help.not + you"), world, { speakerId: "me", addresseeId: "bear" }, o)).toMatchObject({
      kind: "refuse",
    });
  });

  // A SWAP names both sides: mine before `for`, theirs after. Reading only the
  // first half made an exchange land as a remark about a sock.
  it("sock for cookie → propose the TRADE, both items real", () => {
    expect(intentToAct(parseSentence("sock + for + cookie"), world, { speakerId: "me", addresseeId: "bear" }, o)).toMatchObject({
      kind: "trade",
      itemId: "cookie1",
    });
  });

  it("a swap naming something nobody holds is not a trade", () => {
    expect(intentToAct(parseSentence("sock + for + boat"), world, { speakerId: "me", addresseeId: "bear" }, o)).not.toMatchObject({
      kind: "trade",
    });
  });

  it("where cookie → a where-is query about it", () => {
    expect(intentToAct(parseSentence("where + cookie"), world, { speakerId: "me", addresseeId: "bear" }, o)).toMatchObject({
      kind: "where-is",
      itemId: "cookie1",
    });
  });

  it("a bare statement is an ASSERT → tell (never a dead end)", () => {
    // "cookie here" is a mention/state — it maps to a `tell`, so it still gets a reply.
    expect(intentToAct(parseSentence("cookie + here"), world, { speakerId: "me", addresseeId: "bear" }, o)?.kind).toBe("tell");
  });

  it("social acts map to their dialogue moves", () => {
    expect(intentToAct(parseSentence("hi"), world, { speakerId: "me", addresseeId: "bear" }, o)?.kind).toBe("how-are-you");
    expect(intentToAct(parseSentence("yes"), world, { speakerId: "me", addresseeId: "bear" }, o)?.kind).toBe("agree");
    expect(intentToAct(parseSentence("no"), world, { speakerId: "me", addresseeId: "bear" }, o)?.kind).toBe("refuse");
    expect(intentToAct(parseSentence("bye"), world, { speakerId: "me", addresseeId: "bear" }, o)?.kind).toBe("bye");
  });

  it("a command is NOT a dialogue move (handled by the party layer)", () => {
    expect(intentToAct(parseSentence("you + go + home"), world, { speakerId: "me", addresseeId: "bear" }, o)).toBeNull();
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
    const act = intentToAct(parseSentence("cookie"), w, { speakerId: "me", addresseeId: "bear" }, opts(w))!;
    expect(act.kind).toBe("tell");
    const res = selectAct(w, "bear", "me", act, "c", opts(w));
    // Information received is THANKED — "ok" is reserved for accepted orders (①a §1).
    expect(res.responseGlyph).toBe("thank_you");
    expect(w.creatures.bear!.knowledge.cookie1).toEqual({ kind: "held", by: "fox" }); // spread
  });
});

// ⑪ — these two used to run through `pickSpeakerAct` (a FIXED need-first
// priority list) and `converse` (one positional exchange). Both wrappers are
// deleted (multi-entity-conversations.md §4.11) and neither mechanic survives
// as such: the speaker side is now a WEIGHTED draw (`chooseSpeakerMove` → whom,
// then what) and the reply side is arbitrated (`speakInConversation`). So the
// pins move from "the policy picks the request first" to "a needy speaker's
// weight lands on the request", and from "the listener replies" to "the roster
// answers" — the same two claims about the world, made against the surface that
// now decides them.
describe("chooseSpeakerMove + speakInConversation — NPCs use the SAME engine as the player", () => {
  function world() {
    const w = createCreatureWorld(
      [{ id: "fox", needs: [{ itemId: "cookie1", value: 3 }] }, { id: "bear", debts: { fox: 3 } }],
      [{ id: "cookie1", ownerId: "bear", kind: "cookie" }],
    );
    seeItem(w, "fox", "cookie1", { kind: "held", by: "bear" }); // fox knows bear has it
    return w;
  }

  it("a needy speaker asks the ONLY other member for the item they hold", () => {
    const w = world();
    // The need (value 3) dwarfs every other weight on the board, so the request
    // owns the middle of the wheel — the weighted twin of the old fixed policy.
    const move = chooseSpeakerMove(w, pair("fox", "bear"), "fox", opts(w), { rng: constRng(0.5) });
    expect(move?.addresseeId).toBe("bear"); // WHOM comes first, and there is only one
    expect(move?.act).toMatchObject({ kind: "request", itemId: "cookie1" });
  });

  it("one exchange: fox asks, bear (owing fox) hands it over", () => {
    const w = world();
    const c = pair("fox", "bear");
    const move = chooseSpeakerMove(w, c, "fox", opts(w), { rng: constRng(0.5) })!;
    expect(move.act.kind).toBe("request");
    // rng 0 = the first slot of the response wheel, i.e. bear answers (silence
    // is the last slot and, with somebody directly addressed, near-zero anyway).
    const turn = speakInConversation(w, c, "fox", move.act, move.addresseeId, opts(w), {
      tick: 0,
      rng: constRng(0),
    });
    expect(turn.response?.responderId).toBe("bear");
    expect(turn.response?.result.responseGlyph).toBe("yes"); // bear accepts (covering debt)
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

  it("a needy, assertive speaker leads with the request", () => {
    const w = world();
    const act = chooseSpeakerAct(w, "fox", "bear", "c", opts(w), {
      personality: personalityFromPreset("soldier", { assertiveness: 1 }),
      rng: constRng(0.5), // mid-mass lands in the request bucket — it dwarfs the rest
    });
    expect(act?.kind).toBe("request");
  });

  // ⚖️ §9 E1 — NPCs NEVER ASK DIRECTIONS TO PLACES THEY ALREADY KNOW. This test
  // used to assert the opposite (the menu was expanded into one ask per known
  // subject, and a `directions-pick` had to be reachable). That expansion was
  // the reported flood: the picks are generated from the ASKER'S OWN known
  // subjects, so once the dollhouse got place facts every NPC turn offered
  // several "where is the food/clothes/cookie?" asks about places it already
  // knew. The board the PLAYER sees is untouched — this is the NPC seat only.
  it("never utters a menu-OPENER — and never asks directions in ANY shape", () => {
    const w = createCreatureWorld([{ id: "fox" }, { id: "bear" }], []);
    const o: ProjectionOpts = {
      symbolOf: (id) => w.items[id]?.kind ?? id,
      askDirections: [
        { id: "a", glyph: "house" },
        { id: "b", glyph: "market" },
      ], // ≥2 → a directions-menu opener appears on the board
    };
    const banned = new Set([
      "directions-menu",
      "directions-pick",
      "ask-directions",
      "trade-menu",
      "back",
      "more",
      "confused",
    ]);
    for (let i = 0; i < 20; i++) {
      const act = chooseSpeakerAct(w, "fox", "bear", "c", o, { rng: constRng(i / 20) });
      expect(act).not.toBeNull();
      expect(banned.has(act!.kind)).toBe(false);
    }
    // …and a SINGLE known subject — the bare `ask-directions` shape, which never
    // went through the menu at all — is barred by the same rule.
    const one: ProjectionOpts = { ...o, askDirections: [{ id: "a", glyph: "house" }] };
    for (let i = 0; i < 20; i++) {
      const act = chooseSpeakerAct(w, "fox", "bear", "c", one, { rng: constRng(i / 20) });
      expect(act && banned.has(act.kind)).toBeFalsy();
    }
  });

  // THE PLAYER'S BOARD IS NOT THE NPC POOL — the pin §9 E1 asks for explicitly.
  it("…while the PLAYER's board still projects the directions menu", () => {
    const w = createCreatureWorld([{ id: "fox" }, { id: "bear" }], []);
    const o: ProjectionOpts = {
      symbolOf: (id) => w.items[id]?.kind ?? id,
      askDirections: [
        { id: "a", glyph: "house" },
        { id: "b", glyph: "market" },
      ],
    };
    const acts = projectDialogue(w, "bear", "fox", "c", o).acts;
    expect(acts.some((a) => a.kind === "directions-menu")).toBe(true);
  });

  it("with no motive and the RNG at the tail, it still picks SOME act (never null/dead)", () => {
    // Bear has no needs, holds nothing the other wants — weights collapse to the floor,
    // so selection is essentially uniform-random. It must still return a real act.
    const w = createCreatureWorld([{ id: "cat" }, { id: "bear" }], []);
    const act = chooseSpeakerAct(w, "cat", "bear", "c", opts(w), { rng: constRng(0.999) });
    expect(act).not.toBeNull();
    expect(typeof act!.kind).toBe("string");
  });

  // ⑪ — was "mood-driven converse still completes an exchange". Same claim, now
  // made end-to-end over the façade: a mood-chosen move goes INTO a conversation
  // and something comes back out of it.
  it("a mood-chosen move still completes an exchange through the façade", () => {
    const w = world();
    const c = pair("fox", "bear");
    const move = chooseSpeakerMove(w, c, "fox", opts(w), {
      personality: personalityFromPreset("person"),
      rng: constRng(0.5),
    })!;
    expect(move.act.kind).toBe("request");
    const turn = speakInConversation(w, c, "fox", move.act, move.addresseeId, opts(w), {
      tick: 0,
      rng: constRng(0),
    });
    expect(turn.response?.result).toBeTruthy();
  });
});

// ⚖️ §9 E2 — A QUESTION IS A FAILED RESOLUTION.
//
// The state-1 where-is act is the LISTENER'S need seen from the outside: this
// projection is role-swapped (`projectDialogue(world, listenerId, speakerId,…)`),
// so the need — and the `target` riding the ask — belong to the LISTENER. "A"
// asks "where is X?" because "B" visibly wants X, which is worth a turn only
// when B cannot place X itself. *"Before, they were asking 'where is the food'
// when they were hungry and unable to find the food, which feels more correct."*
describe("§9 E2 — the NPC's need-ask fires only on a genuine knowledge gap", () => {
  /** Bear (the LISTENER) is hungry for a resource TYPE — the ask-around loop. */
  const hungryListener = () =>
    createCreatureWorld(
      [{ id: "fox" }, { id: "bear", needs: [{ itemId: "good:food", value: 3, target: { category: "food" } }] }],
      [],
    );
  const withProbe = (answer: SourceAnswer | undefined, seen?: string[]): ProjectionOpts => ({
    symbolOf: (id) => id,
    resolveSourceFor: (cid) => {
      seen?.push(cid);
      return answer;
    },
  });
  /** Every act the speaker can reach, over a full sweep of the roulette. */
  const reachable = (o: ProjectionOpts): Set<string> => {
    const w = hungryListener();
    const kinds = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const act = chooseSpeakerAct(w, "fox", "bear", "c", o, { rng: constRng(i / 40) });
      if (act?.kind === "where-is") kinds.add(act.target ? "where-is:target" : "where-is:item");
      else if (act) kinds.add(act.kind);
    }
    return kinds;
  };

  it("DROPS the targeted ask when the listener would simply open its own fridge", () => {
    const o = withProbe({ kind: "container", objId: "furn_9_chest_food", glyph: "refrigerator" });
    expect(reachable(o).has("where-is:target")).toBe(false);
  });

  it("DROPS it when the listener knows the place to go", () => {
    expect(reachable(withProbe({ kind: "place", subjectId: "buy:good:food" })).has("where-is:target")).toBe(false);
  });

  it("KEEPS it when the listener's own resolution is BLOCKED — the pet at the fridge", () => {
    // grasp=false, so biscuit's row resolves to nothing: asking around is
    // exactly right, and §9 E3 names this as behavior NOT to suppress.
    expect(reachable(withProbe({ kind: "none" })).has("where-is:target")).toBe(true);
  });

  it("KEEPS it when nobody can place it at all (no hook, no answer)", () => {
    expect(reachable(withProbe(undefined)).has("where-is:target")).toBe(true);
    expect(reachable({ symbolOf: (id) => id }).has("where-is:target")).toBe(true);
  });

  it("asks the probe about the LISTENER — the need's owner under the role swap", () => {
    const seen: string[] = [];
    chooseSpeakerAct(hungryListener(), "fox", "bear", "c", withProbe({ kind: "none" }, seen), {
      rng: constRng(0.5),
    });
    expect(seen).toContain("bear");
    expect(seen).not.toContain("fox");
  });

  it("THE PLAYER'S BOARD IS UNGATED — projectDialogue still offers the button", () => {
    const w = hungryListener();
    const o = withProbe({ kind: "container", objId: "furn_9_chest_food", glyph: "refrigerator" });
    const acts = projectDialogue(w, "bear", "fox", "c", o).acts;
    expect(acts.some((a) => a.kind === "where-is" && !!a.target)).toBe(true);
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
    expect(intentToAct(parseSentence("you + go + where"), w, { speakerId: "me", addresseeId: "res" }, opts(w))?.kind).toBe("where-going");
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

// ⑪ — was "askWhere — asking SPREADS knowledge". `askWhere` was the ONLY place
// that spread an item's location to whoever asked for it: it ran the where-is
// and then wrote the answering fact into the asker itself. The wrapper is
// deleted (§4.11) and production never called it, so nothing in the live game
// changed — but the law it embodied now has no implementation, and that is
// exactly what the second half of each test below pins. Closing it means
// lifting the spread into `selectAct`'s where-is arm (creature-dialogue.ts) or
// returning the answering fact on `ActResult`; see `overhear`'s docblock.
describe("asking WHERE through the façade — the answer comes back, the knowledge does not", () => {
  const askCookie: DialogueAct = { kind: "where-is", itemId: "cookie1", glyph: "where + cookie" };

  it("bear, who holds the cookie, answers fox's where-is — but fox does NOT learn it", () => {
    const w = createCreatureWorld([{ id: "fox" }, { id: "bear" }], [{ id: "cookie1", ownerId: "bear", kind: "cookie" }]);
    expect(w.creatures.fox!.knowledge.cookie1).toBeUndefined(); // fox is ignorant
    const turn = speakInConversation(w, pair("fox", "bear"), "fox", askCookie, "bear", opts(w), {
      tick: 0,
      rng: constRng(0),
    });
    expect(turn.response?.responderId).toBe("bear");
    expect(turn.response?.result.responseGlyph).toBeTruthy(); // bear answers with a clue
    // 🚨 DOCUMENTED GAP — see the block comment above.
    expect(w.creatures.fox!.knowledge.cookie1).toBeUndefined();
  });

  it("asking someone who doesn't know earns the honest don't-know, and teaches nothing", () => {
    const w = createCreatureWorld([{ id: "fox" }, { id: "cat" }], [{ id: "cookie1", ownerId: "bear", kind: "cookie" }]);
    const turn = speakInConversation(w, pair("fox", "cat"), "fox", askCookie, "cat", opts(w), {
      tick: 0,
      rng: constRng(0),
    });
    expect(turn.response?.result.responseGlyph).toContain("think.not");
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
    const act = intentToAct(parseSentence("where + mara"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(act).toMatchObject({ kind: "ask-fact", query: { kind: "presence", creature: "mara" } });
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("i_me + think.not");
  });

  it("a TOLD presence answers, and the answer teaches the ASKER", () => {
    const w = household();
    const o = factOpts(w);
    tellFact(w, "bob", { kind: "presence", creature: "mara", place: "kitchen" });
    const act = intentToAct(parseSentence("where + mara"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    const res = selectAct(w, "bob", "me", act, "c", o);
    expect(res.responseGlyph).toBe("mara + in + kitchen");
    expect(w.creatures.me!.facts?.["pres:mara"]).toEqual({ kind: "presence", creature: "mara", place: "kitchen" });
  });

  it("the ROSTER oracle (presenceOf) answers ahead of any stored belief", () => {
    const w = household();
    const o = { ...factOpts(w), presenceOf: (cid: string) => (cid === "mara" ? "work" : undefined) };
    const act = intentToAct(parseSentence("where + mara"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("mara + in + work");
  });

  it("where + you → the listener is right here", () => {
    const w = household();
    const o = factOpts(w);
    const act = intentToAct(parseSentence("where + you"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(act).toMatchObject({ kind: "ask-fact", query: { kind: "presence", creature: "bob" } });
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("i_me + here");
  });

  it("how + mara (asked of bob) → condition fact; how + you stays small talk", () => {
    const w = household();
    const o = factOpts(w);
    const third = intentToAct(parseSentence("how + mara"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(third).toMatchObject({ kind: "ask-fact", query: { kind: "condition", creature: "mara" } });
    expect(selectAct(w, "bob", "me", third, "c", o).responseGlyph).toBe("i_me + think.not");
    tellFact(w, "bob", { kind: "condition", creature: "mara", condition: "hungry" });
    expect(selectAct(w, "bob", "me", third, "c", o).responseGlyph).toBe("mara + hungry");
    expect(intentToAct(parseSentence("how + you"), w, { speakerId: "me", addresseeId: "bob" }, o)?.kind).toBe("how-are-you");
  });

  it("what + want + mara (asked of bob) → a want fact", () => {
    const w = household();
    const o = factOpts(w);
    const act = intentToAct(parseSentence("what + want + mara"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(act).toMatchObject({ kind: "ask-fact", query: { kind: "want", creature: "mara" } });
    w.creatures.bob!.knownWants["ball1"] = "mara";
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("mara + want + ball");
  });

  it("polar attribute ask → yes / no / don't-know", () => {
    const w = household();
    const o = factOpts(w);
    // Mara HOLDS the hot apple — holding is seeing, she answers yes.
    const askMara = intentToAct(parseSentence("apple + hot#question"), w, { speakerId: "me", addresseeId: "mara" }, o)!;
    expect(askMara).toMatchObject({ kind: "ask-fact", expect: "hot" });
    expect(selectAct(w, "mara", "me", askMara, "c", o).responseGlyph).toBe("yes");
    // Bob neither holds nor heard of it — the honest don't-know.
    const askBob = intentToAct(parseSentence("apple + hot#question"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(selectAct(w, "bob", "me", askBob, "c", o).responseGlyph).toBe("i_me + think.not");
    // Told it's cold, bob answers no.
    tellFact(w, "bob", { kind: "itemState", item: "apple1", axis: "temperature", state: "cold" });
    expect(selectAct(w, "bob", "me", askBob, "c", o).responseGlyph).toBe("no");
  });

  it("you + ok#question stays the how-are-you greeting", () => {
    const w = household();
    expect(intentToAct(parseSentence("you + ok#question"), w, { speakerId: "me", addresseeId: "bob" }, factOpts(w))?.kind).toBe("how-are-you");
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
    const act = intentToAct(parseSentence("mara + hungry"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
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
    const act = intentToAct(parseSentence("apple + hot"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
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
    const tell = intentToAct(parseSentence("mara + in + kitchen"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(tell).toMatchObject({ kind: "tell-fact", fact: { kind: "presence", creature: "mara", place: "kitchen" } });
    selectAct(w, "bob", "me", tell, "c", o);
    const ask = intentToAct(parseSentence("where + mara"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(selectAct(w, "bob", "me", ask, "c", o).responseGlyph).toBe("mara + in + kitchen");
  });

  it("a claim about the LISTENER ITSELF is confirmed or corrected, never absorbed", () => {
    const w = household();
    const o = factOpts(w);
    // Mara IS hungry — she confirms.
    const right = intentToAct(parseSentence("you + hungry"), w, { speakerId: "me", addresseeId: "mara" }, o)!;
    expect(right).toMatchObject({ kind: "tell-fact", fact: { kind: "condition", creature: "mara" } });
    expect(selectAct(w, "mara", "me", right, "c", o).responseGlyph).toBe("yes");
    // Bob is fine — he corrects.
    const wrong = intentToAct(parseSentence("you + hungry"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
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
      const act = intentToAct(parseSentence(s), w, { speakerId: "me", addresseeId: "bob" }, o)!;
      expect(act.kind).toBe("dont-understand");
      expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("i_me + understand.not");
    }
  });

  it("'what is the ball eating?' corrects the premise — a thing isn't doing anything", () => {
    const w = household();
    const o = factOpts(w);
    // "ball" names a real ITEM but no creature — the honest premise fix, not
    // a dead-end don't-understand (semantic-tests §Questions).
    const act = intentToAct(parseSentence("what + eat + ball"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(act.kind).toBe("what-doing");
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("ball + eat.not");
  });

  it("why + verb checks the PREMISE: not doing it → 'I don't build'", () => {
    const w = household();
    // The host says bob is verifiably walking (doingOf) — a "why build" denies.
    const o = { ...factOpts(w), doingOf: () => ["go", "come", "walk", "run"] };
    const deny = intentToAct(parseSentence("why + you + build"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(deny).toMatchObject({ kind: "deny-doing", verb: "build" });
    expect(selectAct(w, "bob", "me", deny, "c", o).responseGlyph).toBe("i_me + build.not");
  });

  it("why + verb it IS doing → the motive answer; unverifiable → don't-understand", () => {
    const w = household();
    const walking = { ...factOpts(w), doingOf: () => ["go", "come", "walk", "run"] };
    // Movement verbs skip the premise check — walking is need-driven.
    expect(intentToAct(parseSentence("why + you + go"), w, { speakerId: "me", addresseeId: "bob" }, walking)?.kind).toBe("why");
    // No doingOf hook (or undefined) — the honest can't-interpret floor.
    const blind = factOpts(w);
    expect(intentToAct(parseSentence("why + you + build"), w, { speakerId: "me", addresseeId: "bob" }, blind)?.kind).toBe("dont-understand");
    // Bare "why" stays the classic motive/cause reveal.
    expect(intentToAct(parseSentence("why"), w, { speakerId: "me", addresseeId: "bob" }, blind)?.kind).toBe("why");
  });

  it("where + <nothing anyone has> answers 'I don't know', never silence", () => {
    const w = household();
    const o = factOpts(w);
    const act = intentToAct(parseSentence("where + sock"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(act.kind).toBe("where-is");
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("i_me + think.not");
  });

  it("who + have + ball → the holder clue", () => {
    const w = household();
    const o = factOpts(w);
    // bob HOLDS the ball — holding is knowing; me asks bob, bob names himself.
    seeItem(w, "bob", "ball1", { kind: "held", by: "bob" });
    const act = intentToAct(parseSentence("who + have + ball"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(act).toMatchObject({ kind: "where-is", itemId: "ball1" });
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toContain("have + ball");
  });

  it("what + hot → a state SEARCH over knowledge ('apple + hot')", () => {
    const w = household();
    const o = factOpts(w);
    const act = intentToAct(parseSentence("what + hot"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
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
    const act = intentToAct(parseSentence("who + hungry"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
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
    const act = intentToAct(parseSentence("what + dog + eat"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(act).toMatchObject({ kind: "what-doing", verb: "eat", about: { symbol: "dog", id: "dog" } });
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("dog + eat + apple");
  });

  it("corrects a wrong presumed activity: 'the dog is not eating'", () => {
    const w = household();
    const o: ProjectionOpts = { ...factOpts(w), activityOf: () => ({ verb: "play" }) };
    const act = intentToAct(parseSentence("what + dog + eat"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("dog + eat.not");
  });

  it("a symbol naming NOTHING answers 'there is no {X}'", () => {
    const w = household();
    const o = factOpts(w);
    const act = intentToAct(parseSentence("what + cat + eat"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(act).toMatchObject({ kind: "what-doing", about: { symbol: "cat" } });
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("no + cat");
  });

  it("broad 'what + you + do' answers the listener's own activity in first person", () => {
    const w = household();
    const o: ProjectionOpts = { ...factOpts(w), activityOf: () => ({ verb: "wash", object: "clothing" }) };
    const act = intentToAct(parseSentence("what + you + do"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(act.kind).toBe("what-doing");
    expect(act.verb).toBeUndefined(); // broad — no presumed activity
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("i_me + wash + clothing");
  });

  it("verifiably idle: broad ask → 'I'm not doing'; specific ask → the denial", () => {
    const w = household();
    const o: ProjectionOpts = { ...factOpts(w), activityOf: () => null };
    const broad = intentToAct(parseSentence("what + you + do"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(selectAct(w, "bob", "me", broad, "c", o).responseGlyph).toBe("i_me + do.not");
    const specific = intentToAct(parseSentence("what + bob + eat"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(selectAct(w, "bob", "me", specific, "c", o).responseGlyph).toBe("i_me + eat.not");
  });

  it("no activity hook at all → the honest don't-know, never a fabricated answer", () => {
    const w = household();
    const o = factOpts(w);
    const act = intentToAct(parseSentence("what + dog + eat"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("i_me + think.not");
  });

  it("falls back to doingOf (verb only) when activityOf is absent", () => {
    const w = household();
    const o: ProjectionOpts = { ...factOpts(w), doingOf: () => ["eat"] };
    const act = intentToAct(parseSentence("what + dog + eat"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("dog + eat");
  });
});

describe("the source ask — 'where do we get an apple?'", () => {
  it("where + get + {X} routes to the provider/source chain, not an instance clue", () => {
    const w = createCreatureWorld([{ id: "me" }, { id: "bob" }], [{ id: "apple1", kind: "apple" }]);
    const o: ProjectionOpts = { symbolOf: (id) => w.items[id]?.kind ?? id };
    const act = intentToAct(parseSentence("where + get + apple"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(act).toMatchObject({ kind: "where-is", source: true, target: { kind: "apple" } });
    // Bob knows no provider and no instance — the honest don't-know.
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("i_me + think.not");
  });
});

describe("modal desires spoken at a creature", () => {
  it("'i_me want play' is a disclosure that gets acknowledged, never silence", () => {
    const w = createCreatureWorld([{ id: "me" }, { id: "bob" }], []);
    const o: ProjectionOpts = { symbolOf: (id) => id };
    const act = intentToAct(parseSentence("i_me + want + play"), w, { speakerId: "me", addresseeId: "bob" }, o)!;
    expect(act.kind).toBe("tell");
    expect(selectAct(w, "bob", "me", act, "c", o).responseGlyph).toBe("thank_you");
  });
});
