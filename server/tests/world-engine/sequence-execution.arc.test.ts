// SEQUENCES AND CONDITIONALS — the two structural splits, parsed and EXECUTED
// (build order S2 + S1, and the S9 refusal that never spoke).
//
// Three laws this file exists to hold:
//
//  ① THE CONDITION SPLIT BEATS THE SEQUENCE SPLIT. `then` is a sequence
//    connective, so "if + night + then + go + home" used to parse as
//    sequence[state(night), command(go home)] — the `if` silently swallowed by
//    `parseClause`, which has no use for a connective. Worse: "if you give wood
//    then i_me give food" split into a direct ORDER plus an immediate,
//    unconditional OFFER, so both halves executed and neither was contingent
//    (contracts-and-promises.md §2a, measured against the live parser). A
//    condition connective plus a verb is a RULE; the joiner inside it is the
//    clause BOUNDARY, never a second reading.
//
//  ② A SEQUENCE EXECUTES, OR IT IS REFUSED WHOLE. The board has always marked
//    "A and B" sayable and the world has always answered "I don't understand"
//    (as-built §5 seam 1). Two orders now run head-then-tail; two requests run
//    as two turns; anything else keeps the honest refusal. Never a silent
//    partial success — and never step 2 of a plan whose step 1 failed.
//
//  ③ EVERY RUNG SPEAKS. A socialAct whose plan won't compile fell through to
//    the adult-facing toast — the one arm of the ladder whose answer was not
//    voiced (as-built §6 row S9).
//
// DB-free / GL-free — `npm run test:engine`.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSentence, type IntentFrame } from "@shared/world-engine/interaction/intent/parse-intent.js";
import {
  compileIntent,
  defaultBinder,
  type IntentBinder,
} from "@shared/world-engine/interaction/intent/intent-compile.js";
import { CANT_HERE } from "@shared/world-engine/interaction/dialogue/host-lines.js";
import { bootTextQuest } from "@shared/world-engine/headless/text-quest.js";

// ═══════════════════════════════════════════════════════════════════════════
// A. THE SPLIT TABLE (S2) — one row per shape, verdict pinned
// ═══════════════════════════════════════════════════════════════════════════

const PLACES = new Set(["home", "school"]);
const ITEMS = new Set(["apple", "banana", "wood", "food", "window", "ball"]);
const classify = (sym: string): "place" | "item" | "creature" | "unknown" =>
  PLACES.has(sym) ? "place" : ITEMS.has(sym) ? "item" : "unknown";
const p = (sentence: string): IntentFrame => parseSentence(sentence, { classifyEntity: classify });

const makeBinder = (): IntentBinder => {
  const b = defaultBinder({ player: "child", listener: "bear" });
  const inner = b.creature.bind(b);
  // The host's own binder law (as-built §3.3): a spoken place or item is never
  // a creature, which is what keeps "home" a destination and not a housemate.
  b.creature = (ref) => (ref?.kind === "entity" && classify(ref.symbol) !== "unknown" ? null : inner(ref));
  return b;
};
const compile = (sentence: string) => compileIntent(p(sentence), makeBinder(), { id: "s1" });

describe("the structural split — condition first, sequence second", () => {
  it("'if + night + then + go + home' is a RULE, not a sequence (the §2a bug)", () => {
    const f = p("if + night + then + go + home");
    expect(f.kind).toBe("rule");
    expect(f.lifetime).toBe("edge"); // if → edge
    expect(f.verb).toBe("go");
    expect(f.condition).toMatchObject({ object: { kind: "entity", symbol: "night" } });
    expect(compile("if + night + then + go + home")).toMatchObject({
      kind: "rule",
      rule: { trigger: { kind: "worldState", token: "night" }, lifetime: "edge", action: { kind: "goHome" } },
    });
  });

  it("'when + hungry + then + eat' is a WHILE rule over the creature's own state", () => {
    const f = p("when + hungry + then + eat");
    expect(f.kind).toBe("rule");
    expect(f.lifetime).toBe("while"); // when → while
    expect(compile("when + hungry + then + eat")).toMatchObject({
      kind: "rule",
      rule: { trigger: { kind: "creatureState", state: "hungry" }, action: { kind: "satisfy", need: "eat" } },
    });
  });

  it("the joiner is the CLAUSE BOUNDARY — it never leaks into the trigger", () => {
    // The old splitter cut the trailing clause at its FIRST verb, so `then` rode
    // along inside the condition tokens. It parses out either way, which is
    // exactly why this is pinned: the boundary is deliberate now, and it is the
    // only splitter that can ever separate two verbs.
    const f = p("if + night + then + go + home");
    expect(f.condition!.verb).toBeUndefined();
    expect(f.object).toMatchObject({ symbol: "home" }); // the ACTION kept its own argument
  });

  it("no condition connective ⇒ still a SEQUENCE ('go + home + then + sleep')", () => {
    const f = p("go + home + then + sleep");
    expect(f.kind).toBe("sequence");
    expect(f.connective).toBe("then");
    expect(f.clauses?.map((c) => c.verb)).toEqual(["go", "sleep"]);
  });

  it("…and 'eat + and + sleep' too — `and` was never the conditional's business", () => {
    const f = p("eat + and + sleep");
    expect(f.kind).toBe("sequence");
    expect(f.clauses).toHaveLength(2);
  });

  it("EACH CLAUSE CARRIES ITS OWN TOKENS — the host re-speaks the tail from them", () => {
    expect(p("go + home + then + sleep").clauses?.map((c) => c.raw)).toEqual([["go", "home"], ["sleep"]]);
    expect(p("apple + and + banana").clauses?.map((c) => c.raw)).toEqual([["apple"], ["banana"]]);
  });

  it("a condition connective with NO VERB keeps today's non-rule reading", () => {
    // Nothing to DO ⇒ nothing to trigger. "when + night" stays the dangling
    // state the surfacer's `isComplete` refuses to light Play for, and
    // "if + night + then + apple" stays the sequence it has always been.
    expect(p("when + night").kind).toBe("state");
    expect(p("if + night + then + apple").kind).toBe("sequence");
  });

  it("a partial 'if + night + then' is still not a rule (nothing to do yet)", () => {
    expect(p("if + night + then").kind).not.toBe("rule");
  });
});

describe("the shipped conditionals are byte-identical", () => {
  // §4c's non-negotiable: every conditional the engine handles today has a verb
  // on ONE side only, and none of them may move.
  it("'go + home + when + night' — the trailing-condition shape", () => {
    expect(compile("go + home + when + night")).toMatchObject({
      kind: "rule",
      rule: { trigger: { kind: "worldState", token: "night" }, lifetime: "while", action: { kind: "goHome" } },
    });
  });

  it("'when + night + sleep' — the leading-condition shape (no joiner)", () => {
    expect(compile("when + night + sleep")).toMatchObject({
      kind: "rule",
      rule: { trigger: { kind: "worldState", token: "night" }, action: { kind: "satisfy", need: "sleep" } },
    });
  });

  it("'if + window.open + shut' — and the same sentence WITH `then` reads identically", () => {
    const bare = compile("if + window.open + shut");
    const joined = compile("if + window.open + then + shut");
    expect(bare.kind).toBe("rule");
    expect(joined.kind).toBe("rule");
    if (bare.kind !== "rule" || joined.kind !== "rule") return;
    expect(bare.rule.trigger).toEqual({ kind: "itemState", item: { kind: "window" }, state: "open" });
    // Same rule in every field but the sentence it was composed from.
    expect({ ...joined.rule, sourceGlyph: "" }).toEqual({ ...bare.rule, sourceGlyph: "" });
  });
});

describe("the two-verb conditional — the trap stays shut", () => {
  it("no `then` ⇒ unbound, never a confidently wrong rule (§2b regression guard)", () => {
    // Pinned BEFORE anyone teaches `compileCondition` to answer a bare-subject
    // state clause: doing that first would make this sentence bind a
    // confidently wrong rule instead of refusing.
    expect(compile("if + you + give + wood + i_me + give + food").kind).toBe("unbound");
  });

  it("WITH `then` the clauses separate, and NEITHER half is an immediate act", () => {
    const f = p("if + you + give + wood + then + i_me + give + food");
    expect(f.kind).toBe("rule"); // §2a: this used to be a sequence
    expect(f.clauses).toBeUndefined();
    // The measured failure this replaces: the first clause became a direct
    // ORDER and the second an `offer` — a first-person `give`, i.e. a gift
    // handed over on the spot. Both sides are now inside one standing promise.
    expect(f.condition).toMatchObject({ verb: "give", object: { symbol: "wood" } });
    expect(f.object).toMatchObject({ symbol: "food" }); // the action kept the FOOD
    const c = compile("if + you + give + wood + then + i_me + give + food");
    expect(c.kind).toBe("rule");
    if (c.kind !== "rule") return;
    expect(c.rule.action).toMatchObject({ kind: "give" });
    // ⚠️ The TRIGGER is still only as good as `compileCondition`'s arms — an
    // event over another party's act needs the `received` kind (§4a), which is
    // not this step's work. What matters here is that it installs as a promise
    // that waits, never as two gifts that already happened.
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. THE COMPILED SHAPES the host branches on
// ═══════════════════════════════════════════════════════════════════════════

describe("what the host is handed", () => {
  it("two orders compile to two GOALS", () => {
    const c = compile("go + home + then + sleep");
    expect(c.kind).toBe("sequence");
    if (c.kind !== "sequence") return;
    expect(c.items.map((i) => i.kind)).toEqual(["goal", "goal"]);
  });

  it("two bare nouns compile to two DIALOGUE moves", () => {
    const c = compile("apple + and + banana");
    expect(c.kind).toBe("sequence");
    if (c.kind !== "sequence") return;
    expect(c.items.map((i) => i.kind)).toEqual(["dialogue", "dialogue"]);
  });

  it("a MIXED pair stays mixed — the host refuses it whole", () => {
    const c = compile("go + home + then + apple");
    expect(c.kind).toBe("sequence");
    if (c.kind !== "sequence") return;
    expect(c.items.map((i) => i.kind)).toEqual(["goal", "dialogue"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. LIVE — the whole ladder, on the real dollhouse
// ═══════════════════════════════════════════════════════════════════════════
//
// ONE BOOT, six phases (the show-item.test.ts pattern): a dollhouse boot plus
// its first frames is the expensive part, and each phase wants the world the
// previous one leaves.
//
// The HEAD is deliberately `drop` — an action-only plan whose errand fires in
// place, so the head finishes in ONE frame and the whole file stays cheap. The
// basket leaving the hand is the head; joining the party is the tail; and they
// are two facts nobody can confuse for one another.

const specPath = join(process.cwd(), "games", "dollhouse", "src", "game.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8"));

describe("live on the dollhouse — a sequence that actually happens", () => {
  it("runs head then tail, is superseded, dies with a refused head, and answers the rest aloud", () => {
    const run = bootTextQuest({ world: doc, dt: 1 / 10 });
    try {
      run.advance(6);
      const s = run.session;
      const hi = s.dollhouse!;
      const who = `resident_${hi}_0`;
      const other = `resident_${hi}_1`;
      const otherName = (run.host.nameOf(other) ?? "").toLowerCase();
      expect(otherName).not.toBe("");
      // The creature's own speech bubble — the channel every verdict below is
      // read off (`sayNpcLine`'s world bubble, keyed by the face entity).
      const bubbleKey = `char:resident_face:${who}`;
      const line = () => run.state.bubbles[bubbleKey];
      const syntax = s.game.meta.syntax ?? "b";

      // ── ① TWO ORDERS: "drop the basket, THEN follow me" ──────────────────
      const objId = run.host.giveBag(who, "basket");
      expect(objId).not.toBeNull();
      expect(run.state.objects[objId!]?.carriedBy).toBe(who);

      run.speak(`drop + basket + then + you + follow + i_me`, { targetId: who });
      // THE HEAD IS ISSUED AND THE TAIL HAS NOT RUN. Joining the party the
      // instant the sentence lands is precisely the failure this feature
      // exists to prevent — "both halves execute, neither is contingent".
      expect(s.npcTasks.get(who)?.length ?? 0).toBe(1); // the head's errand
      expect(s.party.has(who)).toBe(false);

      run.advance(1);
      expect(run.state.objects[objId!]?.carriedBy ?? null).toBeNull(); // head DONE
      expect(s.party.has(who)).toBe(true); // …and only then, the tail

      // ── ② SUPERSESSION — the newest word wins ────────────────────────────
      run.speak(`stop`, { targetId: who }); // out of the party, clean slate
      run.advance(2);
      expect(s.party.has(who)).toBe(false);

      const objId2 = run.host.giveBag(who, "basket");
      expect(objId2).not.toBeNull();
      run.speak(`drop + basket + then + you + follow + i_me`, { targetId: who });
      run.speak(`go + home`, { targetId: who }); // countermanded before the head ran
      run.advance(8);
      expect(s.party.has(who)).toBe(false); // the old sentence's tail is gone

      // ── ③ A REFUSED HEAD DROPS ITS TAIL ──────────────────────────────────
      // "get + unicorn" binds nothing, so the body says so — and the second
      // clause dies with the first. Never step 2 of a plan whose step 1 failed.
      run.speak(`get + unicorn + then + you + follow + i_me`, { targetId: who });
      expect(line()?.glyph).toContain("have.not + unicorn"); // refused ALOUD
      run.advance(4);
      expect(s.party.has(who)).toBe(false);

      // ── ④ A MIXED PAIR IS REFUSED WHOLE ──────────────────────────────────
      // An order joined to a request: half of it could run, and that is exactly
      // why none of it does.
      run.speak(`go + home + then + apple`, { targetId: who });
      expect(line()?.glyph).toBe("i_me + understand.not");

      // ── ⑤ TWO REQUESTS, TWO TURNS ────────────────────────────────────────
      // "apple + and + banana" was marked sayable by the board and answered
      // "I don't understand" by the world (§5 seam 1). Now BOTH acts run
      // against the same addressee: one conversational turn pushes one board
      // page, so two pages is two turns — and the answer on screen is the
      // SECOND clause's, which only the second turn could have produced.
      run.advance(4);
      const boardsBefore = run.presenterLog().boards;
      run.speak(`apple + and + banana`, { targetId: who });
      expect(run.presenterLog().boards - boardsBefore).toBe(2);
      expect(line()?.glyph).not.toBe("i_me + understand.not");
      expect(line()?.glyph).toContain("banana");

      // ── ⑥ S9 — THE RUNG THAT DIDN'T SPEAK ────────────────────────────────
      // A `show` whose item is nowhere yields a null plan for a NON-pursued
      // goal. That fell through to the adult-facing `moved === 0` toast with
      // no creature line at all; now it answers like every other rung.
      run.advance(4);
      run.speak(`show + unicorn + to + ${otherName}`, { targetId: who });
      expect(line()?.glyph).toBe(CANT_HERE[syntax]);
      expect(line()?.anchor).toBeDefined();
    } finally {
      run.dispose();
    }
  }, 120_000);
});
