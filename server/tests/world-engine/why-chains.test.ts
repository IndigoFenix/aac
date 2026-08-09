// WHY-CHAINS v1 (planning-docs/games/world-engine/why-chains.md §6) — the four
// laws, pinned.
//
//   ① THE REASON IS THE CHAIN. A "why" answer walks the creature's REAL task
//      chain (pursuit → order → row → roster → motive), so link 0 IS the
//      activity `activityOf` reports and behavior can never disagree with the
//      explanation. Derivation is pinned PER SOURCE below, against the REAL
//      shipped dollhouse, headless.
//   ② CHAINS END. Every chain terminates in `end`; the follow-up button leaves
//      the board when it does.
//   ③ ASKING MOVES NOTHING. A full what-doing + 3×why walk leaves claims,
//      steps, parks, meters and the clock byte-identical.
//   ④ NO NEW LEXICON. Unspeakable rungs are COLLAPSED, and the two that are
//      collapsed today (an untyped unload row; a work shift's roster duty) are
//      pinned as such rather than left to drift into invention.
//
// Cost note: the BOOT is the expensive part, so the host half boots ONCE and
// PLANTS each source (the where-is-probe.test.ts convention) instead of waiting
// for the sim to produce it — a hunger step at minute four is not a test. The
// dialogue half is pure and boots nothing.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import { createCreatureWorld } from "@shared/world-engine/interaction/behavior/creatures.js";
import {
  projectDialogue,
  selectAct,
  type DeviceBoardState,
  type DialogueAct,
  type ProjectionOpts,
  type ReasonLink,
} from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";
import {
  chooseSpeakerAct,
  intentToAct,
} from "@shared/world-engine/interaction/dialogue/creature-converse.js";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { personalityFromPreset } from "@shared/world-engine/interaction/behavior/personality.js";

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — THE CHAIN SEAM, over a live household (§4)
// ═══════════════════════════════════════════════════════════════════════════

const specPath = join(process.cwd(), "games", "dollhouse", "src", "game.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8"));
const DT = 1 / 20;

let run: TextQuestRun;

beforeAll(() => {
  run = bootTextQuest({ world: doc, dt: DT });
  run.advance(60); // ~3 sim seconds: the streamer stands the household up
});

afterAll(() => run?.dispose());

describe("§4 the chain seam — one ladder, mirroring creatureActivity's first match", () => {
  const hi = () => run.session.dollhouse!;
  const memberCid = (n = 0): string =>
    Object.keys(run.state.avatars)
      .filter((id) => id.startsWith(`resident_${hi()}_`))
      .sort()[n]!;
  const chain = (cid: string, observer?: string) => run.host.whyProbe(cid, observer);
  const kinds = (c: ReasonLink[] | undefined) => (c ?? []).map((l) => l.kind);
  /** Every plant is undone; a probe is a READ and the household must come out
   *  of this file exactly as it went in. */
  const plants: (() => void)[] = [];
  const clearBody = (cid: string) => {
    const step = run.session.needStep.get(cid);
    const pursuit = run.session.pursuits.get(cid);
    run.session.needStep.delete(cid);
    run.session.pursuits.delete(cid);
    plants.push(() => {
      if (step) run.session.needStep.set(cid, step);
      else run.session.needStep.delete(cid);
      if (pursuit) run.session.pursuits.set(cid, pursuit);
      else run.session.pursuits.delete(cid);
    });
  };
  const undoAll = () => {
    while (plants.length) plants.pop()!();
  };

  afterAll(undoAll);

  it("① COMMAND → the AUTHORITY link: 'I am going home because you ask'", () => {
    const cid = memberCid();
    clearBody(cid);
    run.session.pursuits.set(cid, { source: "command", goal: { kind: "goHome" }, glyph: "you + go + home" });
    try {
      const c = chain(cid)!;
      expect(kinds(c)).toEqual(["activity", "authority", "end"]);
      expect(c[0]).toEqual({ kind: "activity", clause: { subject: "i_me", verb: "go", object: "home" } });
      // "you ask" and nothing more: no locale here can govern this verb's
      // object (Hebrew wants ממני), so law ④ keeps the clause objectless.
      expect(c[1]).toEqual({ kind: "authority", clause: { subject: "you", verb: "ask" } });
    } finally {
      undoAll();
    }
  });

  it("② a DRIVE row → the MOTIVE link, from the ROW's own condition word", () => {
    const cid = memberCid();
    clearBody(cid);
    run.session.needStep.set(cid, {
      tplKey: "hunger:food",
      kind: "take",
      goodKey: "apple",
      pos: { x: 0, y: 0 },
      units: 1,
    });
    try {
      const c = chain(cid)!;
      expect(kinds(c)).toEqual(["activity", "motive", "end"]);
      expect(c[0]).toMatchObject({ clause: { subject: "i_me", verb: "get", object: "apple" } });
      expect(c[1]).toEqual({
        kind: "motive",
        clause: { subject: "i_me", verb: "hungry", key: "hungry" },
      });
    } finally {
      undoAll();
    }
  });

  it("…and the motive is the ROW's, not the condition mirror's top-firing one", () => {
    const cid = memberCid();
    clearBody(cid);
    run.session.needStep.set(cid, {
      tplKey: "energy",
      kind: "rest",
      goodKey: "",
      pos: { x: 0, y: 0 },
      units: 1,
    });
    try {
      expect(chain(cid)![1]).toEqual({
        kind: "motive",
        clause: { subject: "i_me", verb: "tired", key: "tired" },
      });
    } finally {
      undoAll();
    }
  });

  it("③ a GOODS row → the CONTAINER'S want: 'because the refrigerator wants food'", () => {
    const cid = memberCid();
    clearBody(cid);
    run.session.needStep.set(cid, {
      tplKey: "provision:food",
      kind: "deposit",
      goodKey: "food",
      pos: { x: 0, y: 0 },
      units: 1,
    });
    try {
      const c = chain(cid)!;
      expect(kinds(c)).toEqual(["activity", "because", "end"]);
      expect(c[1]).toEqual({
        kind: "because",
        // The WORD the box is named by (`objectWord` — `clueIn`'s own source),
        // never `furn_<n>_chest_food`.
        clause: { subject: "refrigerator", verb: "want", object: "food" },
      });
    } finally {
      undoAll();
    }
  });

  it("④ a CLAIMED POOLED TASK → the ORDER, then the AUTHORITY over it", () => {
    const cid = memberCid();
    clearBody(cid);
    const task = run.session.taskPool.post({
      goal: { kind: "craft", glyph: "furn.door", cap: 1 },
      issuer: "player",
      focus: { x: 0, y: 0, radius: 999 },
      now: run.session.taskClock,
      sourceGlyph: "make + door",
    });
    expect(run.session.taskPool.claim(task.id, cid)).toBe(true);
    plants.push(() => run.session.taskPool.complete(task.id));
    // A claim takes the body over exactly as a command does (the claim site
    // clears the step and installs the goal), so the activity link comes off
    // the pursuit — and the ORDER above it off the pool row.
    run.session.pursuits.set(cid, { source: "command", goal: { kind: "goHome" }, glyph: "-" });
    try {
      const c = chain(cid)!;
      expect(kinds(c)).toEqual(["activity", "because", "authority", "end"]);
      expect(c[1]).toEqual({
        kind: "because",
        clause: { subject: "house", verb: "make", object: "door" },
      });
      expect(c[2]).toEqual({ kind: "authority", clause: { subject: "you", verb: "ask" } });
    } finally {
      undoAll();
    }
  });

  it("⑤ SCHEDULED SHOPPING → 'I am getting the food because the house wants food'", () => {
    const cid = memberCid();
    clearBody(cid);
    run.session.liveNeedBodies.delete(cid);
    // The roster only proposes; THE BODY DECIDES (going.ts `tripDestination`):
    // a shopper standing still is shopping AT the stall, so it is not going
    // anywhere and claims no activity — and law ① means no activity, no chain.
    // Put it on the move, then wind the town clock to a leg of its own cycle.
    const body = run.state.avatars[cid]!;
    const vx = body.vx;
    const clock = run.session.townClock;
    plants.push(() => {
      body.vx = vx;
      run.session.townClock = clock;
    });
    body.vx = 2;
    let found: ReasonLink[] | undefined;
    for (let t = 0; t < 2000 && !found; t += 5) {
      run.session.townClock = t;
      const c = chain(cid);
      if (c && c.length > 1) found = c;
    }
    try {
      expect(found).toBeDefined();
      expect(kinds(found)).toEqual(["activity", "because", "end"]);
      expect(found![0]).toMatchObject({ clause: { subject: "i_me", verb: "get" } });
      expect(found![1]).toMatchObject({ kind: "because", clause: { subject: "house", verb: "want" } });
    } finally {
      undoAll();
    }
  });

  it("⑥ IDLE / nothing this host can read → `[end]`, and nothing else", () => {
    const cid = memberCid(1);
    clearBody(cid);
    run.session.liveNeedBodies.delete(cid);
    try {
      // The roster may still name a scheduled trip; when it does the chain is a
      // real one. What must never happen is a chain with no terminator.
      const c = chain(cid)!;
      expect(c[c.length - 1]).toEqual({ kind: "end" });
      if (c.length === 1) expect(c).toEqual([{ kind: "end" }]);
    } finally {
      undoAll();
    }
  });

  it("⚖️ LAW ② — every member's chain ENDS, and no link kind repeats a loop", () => {
    for (const cid of Object.keys(run.state.avatars).filter((id) => id.startsWith("resident_"))) {
      const c = chain(cid);
      if (!c) continue;
      expect(c.length).toBeGreaterThan(0);
      expect(c[c.length - 1]!.kind).toBe("end");
      // `end` appears exactly once, and only last — a chain that could re-enter
      // would show up here as a second terminator.
      expect(c.filter((l) => l.kind === "end")).toHaveLength(1);
      // Only link 0 is an activity: the rungs above it are reasons.
      expect(c.slice(1).some((l) => l.kind === "activity")).toBe(false);
    }
  });

  it("⚖️ LAW ④ — an UNTYPED goods row (unload) collapses rather than inventing", () => {
    const cid = memberCid();
    clearBody(cid);
    run.session.needStep.set(cid, {
      tplKey: "unload",
      kind: "deposit",
      goodKey: "",
      pos: { x: 0, y: 0 },
      units: 1,
    });
    try {
      // "the box wants (nothing)" is not a sentence — the rung is skipped and
      // the chain ends honestly one link short.
      expect(kinds(chain(cid))).toEqual(["activity", "end"]);
    } finally {
      undoAll();
    }
  });

  it("⚖️ LAW ③ — a what-doing + 3×why walk moves NOTHING", () => {
    const cid = memberCid();
    const snapshot = () => ({
      claims: JSON.stringify(run.session.needClaims.toJSON()),
      step: JSON.stringify([...run.session.needStep.entries()]),
      parks: JSON.stringify([...run.session.needParks.entries()]),
      meters: JSON.stringify([...run.session.needMeters.entries()]),
      pursuits: JSON.stringify([...run.session.pursuits.keys()].sort()),
      tasks: JSON.stringify(run.session.taskPool.toJSON()),
      clock: run.session.taskClock,
    });
    // Give the body something to explain, then snapshot AFTER the plant.
    clearBody(cid);
    run.session.needStep.set(cid, {
      tplKey: "hunger:food",
      kind: "take",
      goodKey: "apple",
      pos: { x: 0, y: 0 },
      units: 1,
    });
    try {
      const before = snapshot();
      for (let i = 0; i < 8; i++) {
        run.host.whyProbe(cid);
        run.host.whyProbe(cid, cid);
        // the full board walk: what-doing, then why, why, why
        let ui: DeviceBoardState = {};
        const opts = hostOpts(cid);
        const world = run.session.creatures!.world;
        const other = Object.keys(world.creatures).find((id) => id !== cid) ?? cid;
        let res = selectAct(world, cid, other, whatDoing(cid), "c", opts, { ui });
        ui = res.ui ?? ui;
        for (let k = 0; k < 3; k++) {
          res = selectAct(world, cid, other, { kind: "why-doing", glyph: "why" }, "c", opts, { ui });
          ui = res.ui ?? ui;
        }
      }
      expect(snapshot()).toEqual(before);
    } finally {
      undoAll();
    }
  });

  it("DETERMINISM — the same state answers the same lines, ask after ask", () => {
    const cid = memberCid();
    clearBody(cid);
    run.session.needStep.set(cid, {
      tplKey: "hunger:food",
      kind: "take",
      goodKey: "apple",
      pos: { x: 0, y: 0 },
      units: 1,
    });
    try {
      const walk = () => {
        const world = run.session.creatures!.world;
        const other = Object.keys(world.creatures).find((id) => id !== cid) ?? cid;
        const opts = hostOpts(cid);
        const lines: (string | undefined)[] = [];
        let ui: DeviceBoardState = {};
        let res = selectAct(world, cid, other, whatDoing(cid), "c", opts, { ui });
        lines.push(res.responseGlyph);
        ui = res.ui ?? ui;
        for (let k = 0; k < 3; k++) {
          res = selectAct(world, cid, other, { kind: "why-doing", glyph: "why" }, "c", opts, { ui });
          lines.push(res.responseGlyph);
          ui = res.ui ?? ui;
        }
        return lines;
      };
      const first = walk();
      expect(walk()).toEqual(first);
      expect(walk()).toEqual(first);
      // …and the walk is the real one: doing, its reason, then the shrug.
      expect(first[0]).toBe("i_me + get + apple");
      expect(first[1]).toBe("i_me + get + apple + because + i_me + hungry");
      expect(first[2]).toBe("i_me + think.not");
    } finally {
      undoAll();
    }
  });

  it("ANSWERER SCOPE — a HOUSEMATE walks the subject's chain, a stranger cannot", () => {
    const subject = memberCid();
    const housemate = memberCid(1);
    clearBody(subject);
    run.session.needStep.set(subject, {
      tplKey: "hunger:food",
      kind: "take",
      goodKey: "apple",
      pos: { x: 0, y: 0 },
      units: 1,
    });
    try {
      // Itself: first person.
      expect(chain(subject, subject)![0]).toMatchObject({ clause: { subject: "i_me" } });
      // A housemate: the SUBJECT is named, so "Mara is eating because Mara is
      // hungry" reads true rather than the housemate claiming the hunger.
      const heard = chain(subject, housemate)!;
      expect(kinds(heard)).toEqual(["activity", "motive", "end"]);
      const said = (heard[0] as { clause: { subject?: string } }).clause.subject;
      expect(said).not.toBe("i_me");
      expect((heard[1] as { clause: { subject?: string } }).clause.subject).toBe(said);
      // A body from another household has no business knowing.
      const stranger = Object.keys(run.state.avatars).find(
        (id) => id.startsWith("resident_") && !id.startsWith(`resident_${hi()}_`),
      );
      if (stranger) expect(chain(subject, stranger)).toBeUndefined();
    } finally {
      undoAll();
    }
  });

  /** The `what-doing` the board pushes, about `cid` itself. */
  function whatDoing(cid: string): DialogueAct {
    return { kind: "what-doing", about: { symbol: "you", id: cid }, glyph: "thing#question + you + do" };
  }
  /** Projection opts wired to the REAL host hooks — the join under test. */
  function hostOpts(_cid: string): ProjectionOpts {
    return {
      symbolOf: (id) => id,
      activityOf: (who) => run.host.activityOf(who) ?? undefined,
      reasonChainOf: (who, observer) => run.host.whyProbe(who, observer),
    };
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — THE BOARD AND THE PARSE (§5), pure
// ═══════════════════════════════════════════════════════════════════════════

/** A two-creature world: the player "me" and "bear", who wants nothing. */
const plainWorld = () => createCreatureWorld([{ id: "me" }, { id: "bear" }], []);
/** …and one where bear has a visible need (STATE 1). */
const needWorld = () => {
  const w = createCreatureWorld([{ id: "me" }, { id: "bear" }], [{ id: "cookie1", kind: "cookie" }]);
  w.creatures.bear!.needs.push({ itemId: "cookie1", value: 3, fulfilled: false });
  return w;
};

/** A three-rung chain: doing → because → motive → end. */
const CHAIN: ReasonLink[] = [
  { kind: "activity", clause: { subject: "i_me", verb: "get", object: "apple" } },
  { kind: "because", clause: { subject: "refrigerator", verb: "want", object: "food" } },
  { kind: "motive", clause: { subject: "i_me", verb: "hungry", key: "hungry" } },
  { kind: "end" },
];

const chainOpts = (
  over: Partial<ProjectionOpts> = {},
  links: ReasonLink[] | undefined = CHAIN,
): ProjectionOpts => ({
  symbolOf: (id) => id,
  activityOf: () => ({ verb: "get", object: "apple" }),
  reasonChainOf: () => links,
  ...over,
});

describe("§5 the board — 'what are you doing' at any time, and 'why' only after", () => {
  const kindsOn = (world: ReturnType<typeof createCreatureWorld>, opts: ProjectionOpts, ui?: DeviceBoardState) =>
    projectDialogue(world, "bear", "me", "c", opts, ui ? { ui } : undefined).acts.map((a) => a.kind);

  it("what-doing is on the board in BOTH dialogue states", () => {
    expect(kindsOn(plainWorld(), chainOpts())).toContain("what-doing"); // STATE 2
    expect(kindsOn(needWorld(), chainOpts())).toContain("what-doing"); // STATE 1
  });

  it("…INCLUDING an idle creature — 'at any time' is the whole point", () => {
    const opts = chainOpts({ activityOf: () => null }, [{ kind: "end" }]);
    expect(kindsOn(plainWorld(), opts)).toContain("what-doing");
  });

  it("…and it SURVIVES THE ACT CUT on the most crowded board there is", () => {
    const world = needWorld();
    // Fill the board past its cap with optional acts.
    for (let i = 0; i < 12; i++) {
      world.items[`k${i}`] = { id: `k${i}`, ownerId: "me", kind: "cookie", states: [] } as never;
    }
    const acts = projectDialogue(world, "bear", "me", "c", chainOpts(), undefined).acts;
    expect(acts.length).toBeLessThanOrEqual(8);
    expect(acts.map((a) => a.kind)).toContain("what-doing");
  });

  it("why-doing is ABSENT before a doing answer and PRESENT after one", () => {
    expect(kindsOn(plainWorld(), chainOpts())).not.toContain("why-doing");
    expect(kindsOn(plainWorld(), chainOpts(), { whyChain: { cid: "bear", depth: 0 } })).toContain("why-doing");
  });

  it("no chain hook ⇒ no walk is ever opened, and no button appears", () => {
    const opts: ProjectionOpts = { symbolOf: (id) => id, activityOf: () => ({ verb: "get", object: "apple" }) };
    const res = selectAct(plainWorld(), "bear", "me", whatDoingAct(), "c", opts, { ui: {} });
    expect(res.ui?.whyChain).toBeUndefined();
    expect(kindsOn(plainWorld(), opts, { whyChain: { cid: "bear", depth: 0 } })).not.toContain("why-doing");
  });

  it("★ THE WALK ★ — doing, its reason, the motive, then the existential shrug", () => {
    const world = plainWorld();
    const opts = chainOpts();
    const lines: (string | undefined)[] = [];
    let ui: DeviceBoardState = {};
    let res = selectAct(world, "bear", "me", whatDoingAct(), "c", opts, { ui });
    lines.push(res.responseGlyph);
    ui = res.ui!;
    expect(ui.whyChain).toEqual({ cid: "bear", depth: 0 });
    for (let i = 0; i < 3; i++) {
      res = selectAct(world, "bear", "me", whyDoingAct(), "c", opts, { ui });
      lines.push(res.responseGlyph);
      ui = res.ui!;
    }
    expect(lines).toEqual([
      "i_me + get + apple",
      "i_me + get + apple + because + refrigerator + want + food",
      "refrigerator + want + food + because + i_me + hungry",
      "i_me + think.not", // ⚖️ law ② — the chain ended
    ]);
    // …and the button is GONE, because the chain is over.
    expect(ui.whyChain).toBeUndefined();
    expect(projectDialogue(world, "bear", "me", "c", opts, { ui }).acts.map((a) => a.kind)).not.toContain(
      "why-doing",
    );
  });

  it("where-going opens the SAME walk — a walk is a step of the same chain", () => {
    const opts = chainOpts({ goingOf: () => ({ kind: "home" }) });
    const res = selectAct(plainWorld(), "bear", "me", { kind: "where-going", glyph: "-" }, "c", opts, { ui: {} });
    expect(res.responseGlyph).toBe("i_me + go + home");
    expect(res.ui?.whyChain).toEqual({ cid: "bear", depth: 0 });
  });

  it("an IDLE creature's walk terminates on the first press (law ②)", () => {
    const opts = chainOpts({ activityOf: () => null }, [{ kind: "end" }]);
    const world = plainWorld();
    const first = selectAct(world, "bear", "me", whatDoingAct(), "c", opts, { ui: {} });
    expect(first.responseGlyph).toBe("i_me + do.not");
    const why = selectAct(world, "bear", "me", whyDoingAct(), "c", opts, { ui: first.ui });
    expect(why.responseGlyph).toBe("i_me + think.not");
    expect(why.ui?.whyChain).toBeUndefined();
  });

  it("a STRANGER answerer (no chain for that subject) shrugs at depth 1 and closes", () => {
    const opts = chainOpts({ reasonChainOf: () => undefined }); // the hook exists, it just can't say
    const res = selectAct(plainWorld(), "bear", "me", whyDoingAct(), "c", opts, {
      ui: { whyChain: { cid: "mara", depth: 0 } },
    });
    expect(res.responseGlyph).toBe("i_me + think.not");
    expect(res.ui?.whyChain).toBeUndefined();
  });

  it("the walk rides beside the OTHER board state, never over it", () => {
    const opts = chainOpts();
    const res = selectAct(plainWorld(), "bear", "me", whatDoingAct(), "c", opts, {
      ui: { list: { menu: "where-is", page: 2 } },
    });
    expect(res.ui).toEqual({ list: { menu: "where-is", page: 2 }, whyChain: { cid: "bear", depth: 0 } });
  });
});

describe("§5 the parse — [do] is the activity question, [why] continues the walk", () => {
  const world = plainWorld();
  const p = { speakerId: "me", addresseeId: "bear" };
  const opts = { symbolOf: (id: string) => id, creatureOf: (s: string) => (s === "bear" ? "bear" : undefined) };
  const act = (sentence: string, ui?: DeviceBoardState) =>
    intentToAct(parseSentence(sentence), world, p, opts, ui);

  it("bare [do] asks the LISTENER what it is doing", () => {
    expect(act("do")).toMatchObject({ kind: "what-doing", about: { symbol: "you", id: "bear" } });
  });

  it("[{subject} + do] asks about the SUBJECT", () => {
    expect(act("bear + do")).toMatchObject({ kind: "what-doing", about: { symbol: "bear", id: "bear" } });
  });

  it("…and the `what + …` shapes are untouched (one act, several phrasings)", () => {
    expect(act("what + you + do")).toMatchObject({ kind: "what-doing", about: { id: "bear" } });
    expect(act("what + bear + do")).toMatchObject({ kind: "what-doing", about: { symbol: "bear" } });
  });

  it("★ THE BUTTON PARSES BACK TO ITS OWN ACT ★ — one utterance, two ways in", () => {
    // `whatDoingAsk`'s level-c glyph, read as a sentence: pressing the button
    // and saying the words must not be two different questions.
    expect(act("you + do#question")).toMatchObject({
      kind: "what-doing",
      about: { symbol: "you", id: "bear" },
    });
  });

  it("[do] said to NOBODY leaves the frame to the ordinary arms, unchanged", () => {
    // No addressee ⇒ no activity question; the old reading (a bare disclosure)
    // stands rather than a question aimed at nobody.
    expect(intentToAct(parseSentence("do"), world, { speakerId: "me" }, opts)?.kind).not.toBe("what-doing");
  });

  it("a bare [why] rides the CHAIN act while a walk is open…", () => {
    expect(act("why", { whyChain: { cid: "bear", depth: 1 } })).toMatchObject({ kind: "why-doing" });
  });

  it("…and keeps its NEEDS-gated meaning when no walk is open", () => {
    expect(act("why")).toMatchObject({ kind: "why" });
  });

  it("a why that NAMES A VERB stays the premise-checked ask, walk or no walk", () => {
    const withDoing = { ...opts, doingOf: () => ["build"] };
    expect(
      intentToAct(parseSentence("why + you + build"), world, p, withDoing, {
        whyChain: { cid: "bear", depth: 0 },
      }),
    ).toMatchObject({ kind: "why" });
  });
});

describe("§7 out of scope — no NPC ever asks either of the new questions", () => {
  it("chooseSpeakerAct never picks what-doing or why-doing, however the wheel falls", () => {
    const world = plainWorld();
    const opts = chainOpts();
    const picked = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const a = chooseSpeakerAct(world, "bear", "me", "c", opts, {
        personality: personalityFromPreset("warm"),
        rng: () => i / 40,
      }, { ui: { whyChain: { cid: "me", depth: 0 } } });
      if (a) picked.add(a.kind);
    }
    expect(picked.size).toBeGreaterThan(0);
    expect([...picked]).not.toContain("what-doing");
    expect([...picked]).not.toContain("why-doing");
  });
});

function whatDoingAct(): DialogueAct {
  return { kind: "what-doing", about: { symbol: "you", id: "bear" }, glyph: "thing#question + you + do" };
}
function whyDoingAct(): DialogueAct {
  return { kind: "why-doing", glyph: "why + you + do" };
}
