// SHOW — the attention act, end to end (build order L11).
//
// The board has offered the word `show` since `attention-worthy` existed
// (content/concepts.ts: the affordance maps to exactly this verb), and the
// world answered "I don't understand" — a surfaced word the engine refused.
//
// THE LAW THIS FILE EXISTS TO HOLD: **a shown thing is PRESENTED, never
// TRANSFERRED.** `show` rides `socialAct`'s shape — walk to the person, one
// beat on arrival — with the thing as an act ARGUMENT: held up, looked at, and
// still in the shower's own hands afterwards. The two failure modes it must
// never collapse into are one board press away each: `give` (which hands the
// ball over — a different act with a different outcome, and the child loses the
// ball) and a bare `converse` (a second model of an act the engine already runs
// one model of).
//
// Five layers, cheapest first:
//   A. COMPILE — the frame → GoalSpec table, both roles positional.
//   B. THE PLAN — compileGoal: fetch-first regression, and the refusals.
//   C. THE KNOWLEDGE BEAT — what the one fact writes, read back through the
//      same channel a sighting writes (facts.ts), and what it does NOT touch.
//   D. THE ECHO — what the commanded creature says back (wave 3): the line
//      names the THING, because an echo that drops it is the child's only
//      evidence the engine misheard.
//   E. LIVE, on the real dollhouse — the whole ladder through the real host:
//      the walk, the held-up glyph, the attention snap, the fact, and the
//      basket still in the same hands.
//
// DB-free / GL-free — `npm run test:engine`.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import {
  compileIntent,
  defaultBinder,
  type IntentBinder,
} from "@shared/world-engine/interaction/intent/intent-compile.js";
import {
  compileGoal,
  type WorldResolver,
} from "@shared/world-engine/interaction/behavior/goal-selection.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";
import {
  asIntent,
  commandEcho,
  goalActivity,
  goalDestination,
  goalIntentLine,
  type IntentLineSyms,
} from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import { translateGlyph } from "@shared/world-engine/interaction/lang/index.js";
import { createCreatureWorld } from "@shared/world-engine/interaction/behavior/creatures.js";
import { knowsFact, perceiveFact } from "@shared/world-engine/interaction/behavior/facts.js";
import { attentivenessOf } from "@shared/world-engine/interaction/behavior/spark-attention.js";
import { bootTextQuest } from "@shared/world-engine/headless/text-quest.js";

// ═══════════════════════════════════════════════════════════════════════════
// A. COMPILE — "show + <thing> [+ to + <person>]"
// ═══════════════════════════════════════════════════════════════════════════

// The host's binder, mirrored (§3.3 of the as-built record): a spoken PLACE or
// ITEM never binds on the creature channel, which is the one signal that tells
// the thing from the person. `defaultBinder` alone reads EVERY bare noun as a
// creature — and `show` is the one verb that cannot see past that, because it
// is the only one whose two roles are both fillable by a bare noun.
const CREATURES = new Set(["mara", "bear", "pip"]);
const PLACES = new Set(["box", "market"]);
const classify = (sym: string): "place" | "item" | "creature" | "unknown" =>
  CREATURES.has(sym) ? "creature" : PLACES.has(sym) ? "place" : "item";
const makeBinder = (): IntentBinder => {
  const b = defaultBinder({ player: "child", listener: "bear" });
  const inner = b.creature.bind(b);
  b.creature = (ref) => (ref?.kind === "entity" && !CREATURES.has(ref.symbol) ? null : inner(ref));
  return b;
};

const compile = (sentence: string, binder: IntentBinder = makeBinder()) =>
  compileIntent(parseSentence(sentence, { classifyEntity: classify }), binder, { id: "s1" });

const goalOf = (sentence: string, binder?: IntentBinder): GoalSpec => {
  const c = compile(sentence, binder);
  expect(c.kind).toBe("goal");
  if (c.kind !== "goal") throw new Error(`not a goal: ${sentence}`);
  return c.goal;
};

describe("compile — the roles are positional, exactly as `give`'s are", () => {
  it("'show + ball + mara' → the attention act, item + audience", () => {
    expect(goalOf("show + ball + mara")).toEqual({
      kind: "socialAct",
      target: "mara",
      act: "show",
      item: { match: { kind: "ball" } },
    });
  });

  it("an explicit 'to' reads the same — the frame's own intrinsic endpoint", () => {
    expect(goalOf("show + ball + to + mara")).toEqual(goalOf("show + ball + mara"));
  });

  it("descriptors ride into the item match, like every other item slot", () => {
    expect(goalOf("show + ball.big + to + mara")).toMatchObject({
      item: { match: { kind: "ball", descriptors: ["big"] } },
    });
  });

  // ── THE HEADLINE LAW, pinned as an inequality rather than an equality: the
  // failure mode is not "wrong shape", it is "the RIGHT shape for a DIFFERENT
  // verb". Compare the two sentences a child composes one press apart.
  it("NEVER a give: the same nouns under `give` transfer, under `show` do not", () => {
    const shown = goalOf("show + ball + to + mara");
    const given = goalOf("give + ball + to + mara");
    expect(given).toEqual({ kind: "give", item: { match: { kind: "ball" } }, to: "mara" });
    expect(shown.kind).toBe("socialAct");
    expect(shown).not.toEqual(given);
  });

  it("NEVER a converse either — the one-model law keeps `talk` where it is", () => {
    expect(goalOf("talk + to + mara")).toEqual({ kind: "converse", target: "mara" });
    expect(goalOf("show + ball + to + mara").kind).toBe("socialAct");
  });

  // ── THE ONE-NOUN FORM. `give`'s law is "give X ⇒ to me"; show's is the same
  // sentence from the other side, and for the same reason: a subject-less
  // imperative already makes the LISTENER the actor, so the listener cannot
  // also be the audience — the speaker is.
  it("'show + ball' with nobody named → shown to the SPEAKER ('show me the ball')", () => {
    expect(goalOf("show + ball")).toEqual({
      kind: "socialAct",
      target: "child", // binder.player — the asking child
      act: "show",
      item: { match: { kind: "ball" } },
    });
    // …the same default `give` takes, from the same reasoning.
    expect(goalOf("give + ball")).toMatchObject({ to: "child" });
  });

  it("…and the board's own `i_me` recipient chip says the same thing explicitly", () => {
    // `show` is a transfer-framed verb in the LEXICON, so after "show + ball"
    // the surfacer already offers the recipient band (creatures, `i_me`, `to`).
    // The chip the child presses must mean what the silence meant.
    expect(goalOf("show + ball + i_me")).toEqual(goalOf("show + ball"));
    expect(goalOf("show + ball + to + i_me")).toEqual(goalOf("show + ball"));
  });

  it("'show + mara' alone stays NOT-UNDERSTOOD — a person is no thing to hold up", () => {
    // One noun, two possible roles. A lone noun the world knows to be a PERSON
    // names the audience and leaves nothing in the hand, so the sentence is
    // refused out loud rather than being read as "show Mara to me".
    expect(compile("show + mara").kind).toBe("unbound");
  });

  it("'show + ball + to + box' stays NOT-UNDERSTOOD — a box is no audience", () => {
    expect(compile("show + ball + to + box").kind).toBe("unbound");
  });

  it("a NAMED subject shows: 'mara + show + ball' makes Mara the actor", () => {
    const c = compile("mara + show + ball");
    expect(c).toMatchObject({
      kind: "goal",
      actor: "mara",
      goal: { kind: "socialAct", act: "show", target: "child", item: { match: { kind: "ball" } } },
    });
  });

  it("hug is untouched — no item, same shape it always had", () => {
    expect(goalOf("hug + mara")).toEqual({ kind: "socialAct", target: "mara", act: "hug" });
  });

  // The kind-blind binder is a real caller (every compile test that predates
  // the classifier), so its behaviour is pinned rather than left to chance:
  // the two-noun form still binds, and only the ambiguous one-noun form goes.
  it("under a classifier-less binder the two-noun form still binds", () => {
    const naive = defaultBinder({ player: "child", listener: "bear" });
    expect(compileIntent(parseSentence("show + ball + mara"), naive, { id: "s2" })).toMatchObject({
      goal: { kind: "socialAct", target: "mara", act: "show", item: { match: { kind: "ball" } } },
    });
    // …and the one-noun form does not, because "ball" reads as a person there.
    expect(compileIntent(parseSentence("show + ball"), naive, { id: "s3" }).kind).toBe("unbound");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. THE PLAN — compileGoal (goal-selection.ts)
// ═══════════════════════════════════════════════════════════════════════════

describe("the plan — you cannot hold up what you are not holding", () => {
  // Mirrors symbol-game-goal-selection's resolver: bear at the origin, the
  // player at (10,0), the ball at (2,2).
  const resolver: WorldResolver = {
    positionOf: (id) => (id === "player" ? { x: 10, y: 0 } : { x: 0, y: 0 }),
    homeOf: () => ({ x: 5, y: 5 }),
    place: () => ({ x: 3, y: 3 }),
    resolveItem: (ref) => ("id" in ref ? ref.id : "ball1"),
    itemPosition: (id) => (id === "ball1" ? { x: 2, y: 2 } : null),
    stationFor: () => ({ x: 7, y: 7 }),
  };
  const show = (over: Partial<Extract<GoalSpec, { kind: "socialAct" }>> = {}): GoalSpec => ({
    kind: "socialAct",
    target: "player",
    act: "show",
    item: { id: "ball1" },
    ...over,
  });

  it("FETCH-FIRST: not holding it → the same pickup regression `give` uses", () => {
    // Deliberately the give plan's own shape (proven byte-for-byte below), so
    // the honest answer to "the item isn't in hand" is machinery that already
    // exists rather than a new one. The ONLY transfer in the plan is that
    // pickup — nothing hands the thing on at the far end.
    expect(compileGoal(show(), "bear", resolver)?.steps).toEqual([
      { kind: "moveTo", pos: { x: 2, y: 2 } }, // walk to the ball
      { kind: "pick", itemId: "ball1" },
      { kind: "moveTo", pos: { x: 10, y: 0 } }, // walk to the person
      { kind: "socialAct", target: "player", act: "show", itemId: "ball1" },
    ]);
  });

  it("…and the last step is a socialAct, never a `give` step", () => {
    const steps = compileGoal(show(), "bear", resolver)!.steps;
    expect(steps.some((s) => s.kind === "give")).toBe(false);
    expect(steps[steps.length - 1]!.kind).toBe("socialAct");
  });

  it("already in hand → no pickup leg, just the walk and the beat", () => {
    const carrying: WorldResolver = { ...resolver, carrierOf: () => "bear" };
    expect(compileGoal(show(), "bear", carrying)?.steps).toEqual([
      { kind: "moveTo", pos: { x: 10, y: 0 } },
      { kind: "socialAct", target: "player", act: "show", itemId: "ball1" },
    ]);
  });

  it("someone ELSE holds it → no plan (not snatchable), so the host answers aloud", () => {
    const held: WorldResolver = { ...resolver, carrierOf: () => "fox" };
    expect(compileGoal(show(), "bear", held)).toBeNull();
  });

  it("no such thing here → no plan; never a mimed show of nothing", () => {
    const blind: WorldResolver = { ...resolver, itemPosition: () => null };
    expect(compileGoal(show(), "bear", blind)).toBeNull();
  });

  it("nobody shows a thing to themselves", () => {
    expect(compileGoal(show({ target: "bear" }), "bear", resolver)).toBeNull();
  });

  it("the itemless socialAct (a hug) plans exactly as it always did", () => {
    expect(compileGoal({ kind: "socialAct", target: "player", act: "hug" }, "bear", resolver)?.steps).toEqual([
      { kind: "moveTo", pos: { x: 10, y: 0 } },
      { kind: "socialAct", target: "player", act: "hug" },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. THE KNOWLEDGE BEAT — one fact, through the channel a sighting writes
// ═══════════════════════════════════════════════════════════════════════════

describe("the knowledge beat — being shown a thing IS seeing it", () => {
  const world = () =>
    createCreatureWorld(
      [{ id: "mara" }, { id: "pip" }],
      [{ id: "ball1", ownerId: "mara", kind: "ball" }],
    );

  it("the target learns WHO HAS IT — the location fact, held-by the shower", () => {
    const w = world();
    expect(knowsFact(w, "pip", { kind: "whoHas", item: "ball1" })).toBeNull(); // knows nothing yet
    perceiveFact(w, "pip", { kind: "location", item: "ball1", where: { kind: "held", by: "mara" } });
    expect(knowsFact(w, "pip", { kind: "whoHas", item: "ball1" })).toEqual({
      kind: "location",
      item: "ball1",
      where: { kind: "held", by: "mara" },
    });
  });

  it("ONE beat, and only the target's: nobody else learns it by standing near", () => {
    const w = world();
    perceiveFact(w, "pip", { kind: "location", item: "ball1", where: { kind: "held", by: "mara" } });
    expect(Object.keys(w.creatures.pip!.knowledge)).toEqual(["ball1"]);
  });

  it("THE THING DOES NOT MOVE: no ownership, no carry, no transfer mark", () => {
    const w = world();
    perceiveFact(w, "pip", { kind: "location", item: "ball1", where: { kind: "held", by: "mara" } });
    expect(w.items.ball1!.ownerId).toBe("mara");
    expect(w.items.ball1!.pendingTransferTo ?? null).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. THE ECHO — the order spoken back, with the thing in it
// ═══════════════════════════════════════════════════════════════════════════
//
// L11 shipped with a recorded wish: the `socialAct` echo arm spoke `i_me +
// <act> + <target>`, so a commanded show announced "I will show Orrin" — the
// audience without the thing. The echo is a re-render of what COMPILED, which
// makes it the child's ONLY evidence that the basket was heard at all; an echo
// that silently drops the item is indistinguishable from a parse that did.
//
// The shape is GIVE'S — object + `to`-tail — because this act has the same two
// arguments give does and the lang layer already speaks that sentence in every
// ruleset. The pins below are therefore as much about the ITEMLESS act staying
// untouched as about the new slot: a hug has nothing to name and must keep the
// byte-identical line it always had.

describe("the echo — a shown thing is SAID, not just carried", () => {
  const syms: IntentLineSyms = {
    item: (ref) => ("id" in ref ? ref.id : (ref.match.kind ?? "thing")),
    place: (p) => (p.kind === "named" ? p.id : p.kind === "home" ? "home" : "there"),
    creature: (id) => id,
  };
  const showBall: GoalSpec = {
    kind: "socialAct",
    target: "bear",
    act: "show",
    item: { match: { kind: "ball" } },
  };
  const hug: GoalSpec = { kind: "socialAct", target: "bear", act: "hug" };

  it("names the THING and the person — give's shape, one verb apart", () => {
    const line = goalIntentLine(showBall, syms)!;
    expect(line.c).toBe("show + ball + to + bear");
    expect(line.b).toBe("show + ball + to + bear");
    // The teaching slot moves to the ITEM: what is new in "show the ball to the
    // bear" is the ball, and the audience is already where the walk ends.
    expect(line.a).toBe("ball");
    // …byte-identical to what `give` builds off the same two arguments.
    const given = goalIntentLine({ kind: "give", item: { match: { kind: "ball" } }, to: "bear" }, syms)!;
    expect(line.c).toBe(given.c.replace("give", "show"));
  });

  it("…and it SPEAKS, in every shipped ruleset, without falling to the gloss", () => {
    const intent = asIntent(goalIntentLine(showBall, syms)!);
    expect(intent.c).toBe("show.will + ball + to + bear");
    expect(translateGlyph(intent.c, "en")).toBe("I will show the ball to the bear.");
    expect(translateGlyph(intent.c, "he")).toBe("אני הולך להראות את הכדור לדוב.");
    expect(translateGlyph(intent.c, "he", { speaker: "f" })).toBe("אני הולכת להראות את הכדור לדוב.");
    expect(translateGlyph(intent.c, "es")).toBe("Voy a mostrar la pelota al oso.");
    expect(translateGlyph(intent.c, "pt")).toBe("Eu vou mostrar a bola para o urso.");
  });

  it("the OLD line is gone: the audience no longer stands where the thing goes", () => {
    // The recorded bug, stated as the inequality it was — "I will show Orrin".
    expect(goalIntentLine(showBall, syms)!.c).not.toBe("i_me + show + bear");
  });

  it("HUG IS UNTOUCHED — an itemless act keeps the line it always had", () => {
    const line = goalIntentLine(hug, syms)!;
    expect([line.a, line.b, line.c]).toEqual(["bear", "hug + bear", "i_me + hug + bear"]);
    expect(translateGlyph(asIntent(line).c, "en")).toBe("I will hug the bear.");
  });

  // ⚖️ ONE FACT READ TWICE (the L13 law): the announcement and the "what is she
  // doing?" answer are two readings of ONE goal and may not name different
  // things, so the twin forks on the same field in the same order.
  it("the twin agrees — the activity answer names the item too", () => {
    expect(goalActivity(showBall, syms)).toEqual({ verb: "show", object: "ball" });
    // …which is `give`'s own split: the announcement names theme AND endpoint,
    // the activity has room for one object and spends it on the THEME.
    expect(goalActivity({ kind: "give", item: { match: { kind: "ball" } }, to: "bear" }, syms)).toEqual({
      verb: "give",
      object: "ball",
    });
    // The itemless act still answers with the person — nothing else to name.
    expect(goalActivity(hug, syms)).toEqual({ verb: "hug", object: "bear" });
  });

  it("…and the WALK still ends at the person — the third channel is unmoved", () => {
    // `goalDestination` answers "where are you going?". The item took the
    // object slot, not the destination: you still walk to the body.
    expect(goalDestination(showBall, syms)).toEqual({ kind: "place", place: "bear" });
    expect(goalDestination(hug, syms)).toEqual({ kind: "place", place: "bear" });
  });

  it("a commanded show echoes the whole order back (commandEcho, end to end)", () => {
    const goal = goalOf("show + ball + to + mara");
    const { line, perfect } = commandEcho({ raw: ["show", "ball", "to", "mara"] }, goal, syms);
    expect(line).not.toBeNull();
    // The canonical line is the child's own glyphs with the deixis flipped —
    // heads in order — so the reserved bare "ok" IS earned here.
    expect(perfect).toBe(true);
    expect(asIntent(line!).b).toBe("show.will + ball + to + mara");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. LIVE — the whole ladder, on the real dollhouse
// ═══════════════════════════════════════════════════════════════════════════
//
// ONE BOOT, three sentences — deliberately. A dollhouse boot plus its first
// frames is the expensive part (headless-quest-boot.test.ts measures it), and
// every phase below wants the same world state the previous one leaves, so
// splitting them into separate `it`s would pay that price twice to arrive back
// at the same place. Long play ARCS still belong in text mode (CLAUDE.md); this
// is a wiring pin, three sentences deep.
//
// The basket is the item because `giveBag` is the one exposed lever that puts a
// REAL registered prop into a REAL hand; what is shown is beside the point,
// that it stays there is the point.

const specPath = join(process.cwd(), "games", "dollhouse", "src", "game.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8"));

describe("live on the dollhouse — the shown basket never changes hands", () => {
  it("walks over, holds it up, snaps the attention, lands one fact — and the spirit refuses honestly", () => {
    const run = bootTextQuest({ world: doc, dt: 1 / 20 });
    try {
      run.advance(6);
      const s = run.session;
      const hi = s.dollhouse!;
      const shower = `resident_${hi}_0`;
      const audience = `resident_${hi}_1`;
      const name = (run.host.nameOf(audience) ?? "").toLowerCase();
      expect(name).not.toBe("");

      // A real registered prop, in a real hand, owned by the household.
      const objId = run.host.giveBag(shower, "basket");
      expect(objId).not.toBeNull();
      const entityId = s.smallProps.get(objId!)!.entityId;
      const ownerBefore = s.creatures!.world.items[entityId]?.ownerId ?? null;

      // Addressed at the shower (the relayed-target rung of the addressee
      // stack), so the ORDER is "you, show it to <name>".
      run.speak(`show + basket + to + ${name}`, { targetId: shower });
      // Bounded on purpose: 10 SIM SECONDS is many times the walk across one
      // dollhouse interior, and jest's `testTimeout` cannot interrupt a
      // synchronous test — an unbounded poll here would hang a CI run rather
      // than fail it.
      for (let i = 0; i < 40 && !run.state.bubbles[`show:${shower}`]; i++) run.advanceS(0.25);

      // ① HELD UP — a glyph-only bubble over the SHOWER (not the audience):
      //    the world's way of saying "look at this".
      const bubble = run.state.bubbles[`show:${shower}`];
      expect(bubble).toBeDefined();
      expect(bubble!.glyph).toBe("basket");
      expect(bubble!.text).toBe("");
      expect(bubble!.anchor).toEqual({ kind: "avatar", id: shower });

      // ② ATTENTION — on the SHOWER's own author row (the per-author pairing
      //    law), which is what "the target is now looking at them" means here.
      expect(attentivenessOf(s.sparkAttention, shower, audience)).toBe(1);

      // ③ ONE FACT — the audience now knows who has the basket.
      expect(knowsFact(s.creatures!.world, audience, { kind: "whoHas", item: entityId })).toEqual({
        kind: "location",
        item: entityId,
        where: { kind: "held", by: shower },
      });

      // ④ …AND IT IS STILL THE SHOWER'S. The whole law, live: the same hand,
      //    the same owner, and nothing at all on the audience.
      expect(run.state.objects[objId!]?.carriedBy).toBe(shower);
      expect(run.host.handsOf(shower)?.objId).toBe(objId);
      expect(s.creatures!.world.items[entityId]?.ownerId ?? null).toBe(ownerBefore);
      expect(run.host.carryOf(audience).basket ?? 0).toBe(0);

      // ═══ AND NOW THE SPIRIT (B12) — a formless speaker with nobody
      // addressed: no walk, no hands but its own. Two honest refusals, and
      // neither of them is silence.
      //
      // ⑤ The basket is findable and IN A RESIDENT'S HANDS, not the spark's,
      //   so the spirit gets the ordinary can't-here verdict rather than
      //   miming a presentation of nothing — and the basket does not move.
      const beforeToasts = run.presenterLog().toasts;
      const bubblesBefore = { ...run.state.bubbles };
      run.speak(`show + basket + to + ${name}`);
      run.advanceS(0.5);
      expect(run.state.objects[objId!]?.carriedBy).toBe(shower); // still untouched
      const answered =
        run.state.bubbles[`char:resident_face:${audience}`] !== bubblesBefore[`char:resident_face:${audience}`] ||
        run.presenterLog().toasts > beforeToasts;
      expect(answered).toBe(true);

      // ⑥ …and with NO audience named and nobody addressed, the compiled
      //   audience comes out as the speaker: "show it to whom?".
      const t1 = run.presenterLog().toasts;
      run.speak(`show + basket`);
      run.advanceS(0.5);
      expect(run.presenterLog().toasts).toBeGreaterThan(t1);
      expect(run.presenterLog().lastToast).toContain("show");
    } finally {
      run.dispose();
    }
  });
});
