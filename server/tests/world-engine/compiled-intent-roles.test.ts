// WHAT A COMPILED COMMAND CARRIES BESIDE ITS GOAL — the two columns wave 2
// added to `CompiledIntent` (semantic-engine-round.md, B5a).
//
// A GoalSpec says WHAT to do. Two things the child said were being dropped on
// the way there, because neither is a different act:
//
//   ① COMPANY — semantic-gaps 9, "the GENERAL companion rule". `with`-marked
//      company was attached only where a `satisfy` could absorb it (`goal.with`,
//      the shared-need ritual), so "go home WITH Mara" and "get the ball WITH
//      Pip" compiled to a solo goal and the partner vanished. `companions` now
//      rides EVERY compiled command — same helper (`companionsOf`), same animacy
//      gate — and `goal.with` on `satisfy` is untouched, because a shared need
//      really is one performance two bodies attend, where a shared errand is the
//      same errand issued to both. The host fans it out at the member-resolution
//      seat; this layer only names them.
//
//   ② PRECONDITIONS — semantic-behavior.md §6, "preconditions ARE the response".
//      "stop + eat" compiled to a halt that landed whether or not the body was
//      eating. The row now STATES what it assumed (`doing($verb)`), so the host
//      has a true sentence to say instead — `i_me + eat.not`, "I am not eating".
//
// Both are ADDITIVE and both are OPTIONAL: the GoalSpec bytes are exactly what
// they were (the golden fixture in verb-effects.test.ts is the proof), the
// fields are absent when the sentence names neither, and the rule path is
// untouched. Those three are pinned here too, because they are the whole reason
// this could ship without moving anything.
//
// Pure (parser + compiler) — DB-free, `npm run test:engine -- compiled-intent-roles`.

import { describe, expect, it } from "@jest/globals";

import {
  PHASE_ROWS,
  compileAction,
  compileIntent,
  compileRule,
  defaultBinder,
  matchPhaseEffects,
  type CompiledIntent,
  type IntentBinder,
} from "@shared/world-engine/interaction/intent/intent-compile.js";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";

// The child "child" speaks to the resident "bear"; mara/pip/dog are other
// creatures, the lamp is a device, everything else is a thing.
const CREATURES = new Set(["bear", "mara", "pip", "dog"]);
const DEVICES = new Set(["lamp"]);

const binder: IntentBinder = defaultBinder({ player: "child", listener: "bear" });
binder.isCompanion = (ref) => ref?.kind === "entity" && CREATURES.has(ref.symbol);
binder.isDevice = (ref) => ref?.kind === "entity" && DEVICES.has(ref.symbol);

const parse = (s: string) =>
  parseSentence(s, { classifyEntity: (sym) => (CREATURES.has(sym) ? "creature" : "item") });

const compile = (s: string): CompiledIntent => compileIntent(parse(s), binder, { id: "t" });

/** The compiled command, narrowed — every sentence below is one. */
const goalIntent = (s: string) => {
  const c = compile(s);
  expect(c.kind).toBe("goal");
  if (c.kind !== "goal") throw new Error(`not a goal: ${s}`);
  return c;
};

// ---------------------------------------------------------------------------
// ① COMPANY ON ANY COMMAND
// ---------------------------------------------------------------------------

describe("① `with` names company on EVERY goal kind, not only a shared need", () => {
  it("'get + ball + with + pip' — the errand keeps the partner it named", () => {
    const c = goalIntent("get + ball + with + pip");
    expect(c.goal).toEqual({ kind: "fetch", item: { match: { kind: "ball" } } });
    expect(c.companions).toEqual({ kind: "creatures", ids: ["pip"] });
  });

  it("'you + go + home + with + mara' — HOME is the destination, Mara is the company", () => {
    // ⚖️ WAS `goTo mara` (pinned as-is by B5a, fixed by B5b under the ruling
    // recorded at semantic-engine-round.md B5a's 🚨 residual): the parser hands
    // the `target` slot to the LAST relation-marked noun, so the companion sat
    // where the destination belonged and movement's `target ?? object` read her
    // as the place. `with` is a COMPANION marker and never an endpoint, so the
    // endpoint readings now see the sentence as if the `with` phrase were
    // absent — here that leaves bare "go home". This is the change that
    // re-baselined the golden fixture (279 cases, all `with`-marked movement).
    const c = goalIntent("you + go + home + with + mara");
    expect(c.goal).toEqual({ kind: "goHome" });
    expect(c.companions).toEqual({ kind: "creatures", ids: ["mara"] });
  });

  it("'you + go + to + kitchen + with + mara' — the STATED place wins over the companion", () => {
    // The same rule where the sentence names both: `bound` carries to-kitchen
    // AND with-mara, `target` holds Mara (she was said last), and the endpoint
    // reading falls back to the last endpoint-marked noun before her.
    const c = goalIntent("you + go + to + kitchen + with + mara");
    expect(c.goal).toEqual({ kind: "goTo", place: { kind: "named", id: "kitchen" } });
    expect(c.companions).toEqual({ kind: "creatures", ids: ["mara"] });
  });

  it("'go + with + mara' — nowhere to go, so the act IS going along with her", () => {
    // ⚖️ B5c (semantic-behavior.md §7: a well-formed sentence must never read as
    // not-understood). Once the companion stopped stealing the destination, a
    // movement order that named company and NO place matched no row at all —
    // graceless in exactly the way the rule was meant to prevent. Moving WITH
    // somebody is moving alongside her, which is what `follow` already is.
    // Both columns speak: the goal names the body, `companions` names the party.
    const c = goalIntent("go + with + mara");
    expect(c.goal).toEqual({ kind: "follow", target: "mara" });
    expect(c.companions).toEqual({ kind: "creatures", ids: ["mara"] });
    // Every movement word reads it the same way — one shared row, six verbs.
    expect(goalIntent("come + with + mara").goal).toEqual({ kind: "follow", target: "mara" });
    expect(goalIntent("run + with + mara").goal).toEqual({ kind: "follow", target: "mara" });
    expect(goalIntent("follow + with + mara").goal).toEqual({ kind: "follow", target: "mara" });
    // …including `return`, whose bare row would otherwise have sent her home
    // alone: the company is what the sentence STATES, home is only where a bare
    // `return` would have gone.
    const ret = goalIntent("return + with + mara");
    expect(ret.goal).toEqual({ kind: "follow", target: "mara" });
    expect(ret.companions).toEqual({ kind: "creatures", ids: ["mara"] });
  });

  it("🚨 'go + with + box' stays the honest not-understood — a box is not somebody", () => {
    // The animacy gate is `companionsOf`'s own, so the body walked beside and
    // the party carried on `companions` can never be different readings.
    expect(compileAction(parse("go + with + box"), binder)).toBeNull();
    expect(compile("go + with + box")).toMatchObject({ kind: "unbound" });
  });

  it("waiting WITH somebody waits where you are, together — she is not a spot", () => {
    const c = goalIntent("stay + with + mara");
    expect(c.goal).toEqual({ kind: "stay", place: undefined });
    expect(c.companions).toEqual({ kind: "creatures", ids: ["mara"] });
  });

  it("🚨 a PARTNER-shaped verb still reads its `with` phrase as the argument", () => {
    // The boundary of the rule, pinned in both directions: the endpoint readings
    // skip a `with`-marked noun, the partner readings depend on it. Same frame
    // shape, opposite answers, and the difference is which role source the row
    // cites — data, not a per-verb branch.
    expect(goalIntent("talk + with + mara").goal).toEqual({ kind: "converse", target: "mara" });
    expect(goalIntent("play + with + mara").goal).toEqual({
      kind: "satisfy",
      need: "play",
      with: { kind: "creatures", ids: ["mara"] },
    });
    expect(goalIntent("trade + wood + with + city").goal).toMatchObject({ kind: "trade", partner: "city" });
  });

  it("'we + go + home' — the speaker's own group, unresolved on purpose", () => {
    const c = goalIntent("we + go + home");
    expect(c.goal).toEqual({ kind: "goHome" });
    expect(c.companions).toEqual({ kind: "group" });
  });

  it("'get + ball + together' — the bare marker is the group as well", () => {
    expect(goalIntent("get + ball + together").companions).toEqual({ kind: "group" });
  });

  it("🚨 a shared NEED is unchanged: `goal.with` stays, and `companions` agrees", () => {
    // The ritual path reads `goal.with` and must keep finding exactly what it
    // always found; `companions` repeats the same fact for the general path.
    // One fact, two readers — they can never disagree.
    const c = goalIntent("you + eat + with + i_me");
    expect(c.goal).toEqual({
      kind: "satisfy",
      need: "eat",
      with: { kind: "creatures", ids: ["child"] },
    });
    expect(c.companions).toEqual({ kind: "creatures", ids: ["child"] });
    expect(c.companions).toEqual(c.goal.kind === "satisfy" ? c.goal.with : null);
  });

  it("a THING with-marked is not company — the animacy gate still decides", () => {
    // "go home with the ball" is an instrument at best; nobody is coming along.
    const c = goalIntent("go + home + with + ball");
    expect(c.companions).toBeUndefined();
    expect("companions" in c).toBe(false);
    // …and the destination is STILL home: what disqualifies the ball as a place
    // is the `with` that marked it, not its animacy. The endpoint rule keys off
    // the MARKER, the company rule off the noun — two questions, two answers.
    expect(c.goal).toEqual({ kind: "goHome" });
  });

  it("a trade PARTNER is not a dinner guest", () => {
    const c = goalIntent("trade + wood + with + city");
    expect(c.goal).toMatchObject({ kind: "trade", partner: "city" });
    expect("companions" in c).toBe(false);
  });

  it("a solo order carries NEITHER field — absent, not empty", () => {
    const c = goalIntent("you + eat");
    expect(c).toEqual({ kind: "goal", goal: { kind: "satisfy", need: "eat" }, actor: "bear" });
  });

  it("a SEQUENCE carries it per clause (each item is its own compile)", () => {
    const c = compile("get + ball + with + mara + then + eat");
    expect(c.kind).toBe("sequence");
    if (c.kind !== "sequence") return;
    expect(c.items[0]).toMatchObject({ kind: "goal", companions: { kind: "creatures", ids: ["mara"] } });
    // The second clause names no company of its own and gets none: the marker
    // rides the clause that said it, exactly as the parser splits them.
    expect(c.items[1]).toEqual({ kind: "goal", goal: { kind: "satisfy", need: "eat" }, actor: "bear" });
  });

  it("company NEVER reaches the GoalSpec of a non-satisfy goal", () => {
    // The one thing that would have broken every consumer: `with` is a field of
    // `satisfy` alone in the goal vocabulary, and it stays that way.
    expect(compileAction(parse("get + ball + with + pip"), binder)).toEqual({
      kind: "fetch",
      item: { match: { kind: "ball" } },
    });
    expect(compileAction(parse("we + go + home"), binder)).toEqual({ kind: "goHome" });
  });
});

// ---------------------------------------------------------------------------
// ② THE PRECONDITION COLUMN
// ---------------------------------------------------------------------------

describe("② `stop + {V}` states what it assumed — the failed precondition IS the reply", () => {
  it("'stop + eat' halts AND asserts the body is eating", () => {
    const c = goalIntent("stop + eat");
    expect(c.goal).toEqual({ kind: "stay" });
    expect(c.preconditions).toEqual([{ kind: "doing", verb: "eat" }]);
  });

  it("'you + stop + play' — `$verb` resolves to whatever the frame's verb is", () => {
    expect(goalIntent("you + stop + play").preconditions).toEqual([{ kind: "doing", verb: "play" }]);
  });

  it("bare 'stop' is the `stop` VERB, not a phase — it asserts nothing", () => {
    const c = goalIntent("stop");
    expect(c.goal).toEqual({ kind: "stay", place: undefined });
    expect("preconditions" in c).toBe(false);
  });

  it("a phase governing no verb of its own falls to the plain halt ('stop + stop')", () => {
    // PHASE_ROWS' second row: nothing is named, so nothing is assumed.
    const c = goalIntent("stop + stop");
    expect(c.goal).toEqual({ kind: "stay" });
    expect("preconditions" in c).toBe(false);
  });

  it("'stop + {device}' still turns the thing OFF, and asserts nothing", () => {
    const c = goalIntent("stop + lamp");
    expect(c.goal).toEqual({ kind: "toggle", device: { match: { kind: "lamp" } }, state: "off" });
    expect("preconditions" in c).toBe(false);
  });

  it("a precondition NEVER enters the GoalSpec — `compileAction` is untouched", () => {
    expect(compileAction(parse("stop + eat"), binder)).toEqual({ kind: "stay" });
  });

  it("a sequence clause carries its own preconditions", () => {
    const c = compile("stop + eat + then + rest");
    expect(c.kind).toBe("sequence");
    if (c.kind !== "sequence") return;
    expect(c.items[0]).toMatchObject({ goal: { kind: "stay" }, preconditions: [{ kind: "doing", verb: "eat" }] });
    expect(c.items[1]).toEqual({ kind: "goal", goal: { kind: "satisfy", need: "rest" }, actor: "bear" });
  });

  it("🚨 THE RULE PATH IS BYTE-IDENTICAL — a standing 'when night, stop eating'", () => {
    // A Rule carries a GoalSpec and nothing else (rules.ts is not ours to
    // widen), so the phase row must leave this exactly as it was.
    expect(compileRule(parse("when + night + stop + eat"), binder, { id: "r" })).toEqual({
      id: "r",
      author: "child",
      binding: { kind: "agent", id: "bear" },
      trigger: { kind: "worldState", token: "night" },
      lifetime: "while",
      action: { kind: "stay" },
      priority: 3,
      enabled: true,
      order: 0,
      sourceGlyph: "when + night + stop + eat",
    });
  });
});

// ---------------------------------------------------------------------------
// ③ THE PHASE ROWS ARE DATA (and are walked BEFORE the verb's own)
// ---------------------------------------------------------------------------

describe("③ PHASE_ROWS — the pre-table intercept is a row list now", () => {
  it("is exactly two rows, in this order, with the precondition on the first", () => {
    expect(PHASE_ROWS.map((r) => ({ guards: r.guards, effect: r.effect, precond: r.precond }))).toEqual([
      { guards: ["phase:stop", "has:mainVerb"], effect: "stay", precond: [{ kind: "doing", verb: "$verb" }] },
      { guards: ["phase:stop"], effect: "stay", precond: undefined },
    ]);
  });

  it("the TABLE holds the `$verb` placeholder; the COMPILE holds the real verb", () => {
    expect(PHASE_ROWS[0]!.precond).toEqual([{ kind: "doing", verb: "$verb" }]);
    expect(matchPhaseEffects(parse("stop + eat"), binder)).toEqual({
      goal: { kind: "stay" },
      preconditions: [{ kind: "doing", verb: "eat" }],
    });
  });

  it("a frame with no phase matches no phase row (so the caller may always ask)", () => {
    expect(matchPhaseEffects(parse("you + eat"), binder)).toBeNull();
    expect(matchPhaseEffects(parse("stop"), binder)).toBeNull();
  });

  it("the phase OUTRANKS the verb's rows AND the `use` rewrite", () => {
    // "stop using the oven" is a halt, not a cook: the phase stage runs first,
    // so `use` never gets to re-enter the table with the station's own verb.
    const c = goalIntent("stop + use + oven");
    expect(c.goal).toEqual({ kind: "stay" });
    expect(c.preconditions).toEqual([{ kind: "doing", verb: "use" }]);
  });
});
