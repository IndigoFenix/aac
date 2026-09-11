// THE PLAN RUNG — `why` walks the plan (emergent-plans-round.md D5/D6/D7,
// USER CALLS E-1 and E-6; elemental-actions-emergent-plans.md §2 "the plan's
// edges ARE causal facts"; why-chains.md §4's missing rung).
//
// Before this landed, a body's chain jumped from "I am walking" straight to
// "because I am hungry": the regression tree existed, was pinned, and was read
// by nothing. Four things are pinned here, and each is a different half of the
// claim:
//
//   ① THE LINE SPEAKS, IN ALL FOUR RULESETS. The purpose rung is
//      `causalPhrase(effect, "in_order_to", cause)` — "I get the apple so that
//      I eat the apple" — built entirely from words that already ship (law ④),
//      Hebrew agreement included.
//   ② THE CHAIN IS THE BODY'S OWN. Live on the shipped dollhouse: a body
//      mid-give reads `get X` then `give X`; a body walking to its meal reads
//      `get X` → so that `eat X` → because hungry.
//   ③ NOTHING ELSE MOVED. A contribute/bill pursuit's chain carries no purpose
//      rung at all (its goals are host-routed, so the planner declines them),
//      and a full what-doing + 3×why walk mutates nothing (law ③) — including
//      the `pur.stand` cache the shared resolver reads.
//   ④ E-6 — `stop + {V}` matches the STEP or the GOAL or the plain fact of
//      walking. A body walking to its meal is going AND getting AND eating;
//      answering "I don't go" to "stop going" was a false denial.
//
// ONE headless boot for the live half (the why-chains.test.ts convention); the
// render and dialogue halves are pure and boot nothing. `npm run test:engine`.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import { causalPhrase } from "@shared/world-engine/interaction/dialogue/dialogue-gen.js";
import { translateGlyph } from "@shared/world-engine/interaction/lang/index.js";
import { notDoingLine } from "@shared/world-engine/interaction/dialogue/host-lines.js";
import {
  createCreatureWorld,
} from "@shared/world-engine/interaction/behavior/creatures.js";
import {
  selectAct,
  type DeviceBoardState,
  type DialogueAct,
  type ProjectionOpts,
  type ReasonLink,
} from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";
import type { GoalSpec, ItemRef } from "@shared/world-engine/interaction/behavior/rules.js";
import { CONTRIBUTE_TPL_KEY } from "@shared/world-engine/kernel/town/pull-labor.js";

// ═══════════════════════════════════════════════════════════════════════════
// ① THE PURPOSE LINE — pure, and the whole point is that it RENDERS
// ═══════════════════════════════════════════════════════════════════════════

const GET_APPLE = { subject: "i_me", verb: "get", object: "apple" };
const EAT_APPLE = { subject: "i_me", verb: "eat", object: "apple" };
const HUNGRY = { subject: "i_me", verb: "hungry", key: "hungry" };

describe("the purpose rung is `in_order_to` over existing words (law ④)", () => {
  const purpose = causalPhrase(GET_APPLE, "in_order_to", EAT_APPLE);

  it("is the ordinary two-clause causal shape, only the connective differs", () => {
    expect(purpose.c).toBe("i_me + get + apple + in_order_to + i_me + eat + apple");
    // …level b is the CAUSE half, exactly as `because` lines reduce.
    expect(purpose.b).toBe("in_order_to + eat + apple");
  });

  it("renders in all four shipped rulesets — no new lexeme anywhere", () => {
    expect(translateGlyph(purpose.c, "en")).toBe("I get the apple so that I eat the apple.");
    expect(translateGlyph(purpose.c, "he")).toBe("אני משיג את התפוח כדי שאני אוכל את התפוח.");
    expect(translateGlyph(purpose.c, "es")).toBe("Consigo la manzana para como la manzana.");
    expect(translateGlyph(purpose.c, "pt")).toBe("Eu consigo a maçã para eu como a maçã.");
  });

  it("agrees with a FEMININE speaker in Hebrew, like every other first-person line", () => {
    expect(translateGlyph(purpose.c, "he", { speaker: "f" })).toBe(
      "אני משיגה את התפוח כדי שאני אוכלת את התפוח.",
    );
  });

  it("…and the rung ABOVE it is still `because` — the two connectives coexist", () => {
    const motive = causalPhrase(EAT_APPLE, "because", HUNGRY);
    expect(motive.c).toBe("i_me + eat + apple + because + i_me + hungry");
    expect(translateGlyph(motive.c, "en")).toBe("I eat the apple because I'm hungry.");
    expect(translateGlyph(motive.c, "he")).toBe("אני אוכל את התפוח כי אני רעב.");
    expect(translateGlyph(motive.c, "es")).toBe("Como la manzana porque tengo hambre.");
    expect(translateGlyph(motive.c, "pt")).toBe("Eu como a maçã porque estou com fome.");
    expect(translateGlyph(motive.c, "he", { speaker: "f" })).toBe("אני אוכלת את התפוח כי אני רעבה.");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE WALK — the dialogue layer picks the connective off the link's own kind
// ═══════════════════════════════════════════════════════════════════════════

const PLAN_CHAIN: ReasonLink[] = [
  { kind: "activity", clause: GET_APPLE },
  { kind: "purpose", clause: EAT_APPLE },
  { kind: "motive", clause: HUNGRY },
  { kind: "end" },
];

const whatDoingAct = (): DialogueAct => ({
  kind: "what-doing",
  about: { symbol: "you", id: "bear" },
  glyph: "you + do#question",
});
const whyDoingAct = (): DialogueAct => ({ kind: "why-doing", glyph: "why" });

describe("§5 the walk — a PURPOSE rung speaks `so that`, everything else `because`", () => {
  const world = () => createCreatureWorld([{ id: "me" }, { id: "bear" }], []);
  const opts: ProjectionOpts = {
    symbolOf: (id) => id,
    activityOf: () => ({ verb: "get", object: "apple" }),
    reasonChainOf: () => PLAN_CHAIN,
  };

  it("★ THE ACCEPTANCE ★ — doing, the purpose it buys, the motive, then the shrug", () => {
    const w = world();
    const lines: (string | undefined)[] = [];
    let ui: DeviceBoardState = {};
    let res = selectAct(w, "bear", "me", whatDoingAct(), "c", opts, { ui });
    lines.push(res.responseGlyph);
    ui = res.ui!;
    for (let i = 0; i < 3; i++) {
      res = selectAct(w, "bear", "me", whyDoingAct(), "c", opts, { ui });
      lines.push(res.responseGlyph);
      ui = res.ui!;
    }
    expect(lines).toEqual([
      "i_me + get + apple",
      // ⚖️ D6 — the PLAN rung, forward-pointing.
      "i_me + get + apple + in_order_to + i_me + eat + apple",
      // …and the origin ladder above it, unchanged.
      "i_me + eat + apple + because + i_me + hungry",
      "i_me + think.not", // law ② — the chain ended
    ]);
    expect(ui.whyChain).toBeUndefined();
  });

  it("a chain with NO purpose rung speaks exactly as it always did", () => {
    const plain: ReasonLink[] = [
      { kind: "activity", clause: GET_APPLE },
      { kind: "motive", clause: HUNGRY },
      { kind: "end" },
    ];
    const res = selectAct(world(), "bear", "me", whyDoingAct(), "c", { ...opts, reasonChainOf: () => plain }, {
      ui: { whyChain: { cid: "bear", depth: 0 } },
    });
    expect(res.responseGlyph).toBe("i_me + get + apple + because + i_me + hungry");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ② ③ ④ LIVE ON THE SHIPPED DOLLHOUSE — one boot
// ═══════════════════════════════════════════════════════════════════════════

const specPath = join(process.cwd(), "games", "dollhouse", "src", "game.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8"));

describe("live on the dollhouse — the chain a real body walks", () => {
  let run: TextQuestRun;
  /** The household the boot embodies, its first member, and a housemate. */
  let head = "";
  let mate = "";
  let headName = "";
  /** An ItemRef the household's own resolver really finds — discovered by
   *  SPEAKING for it, so this file never guesses an object id. */
  let itemRef: ItemRef | undefined;

  beforeAll(() => {
    run = bootTextQuest({ world: doc, dt: 1 / 20 });
    run.advance(60); // ~3 sim seconds — the streamer stands the household up
    const hi = run.session.dollhouse!;
    head = `resident_${hi}_0`;
    mate = `resident_${hi}_1`;
    headName = (run.host.nameOf(head) ?? "").toLowerCase();
    for (const word of ["apple", "food", "bread", "basket", "ball"]) {
      run.session.pursuits.delete(head);
      run.speak(`${headName} + get + ${word}`);
      const goal = run.session.pursuits.get(head)?.goal as GoalSpec | undefined;
      if (goal && "item" in goal && goal.item) {
        itemRef = goal.item;
        break;
      }
    }
    run.session.pursuits.delete(head);
  });

  afterAll(() => run?.dispose());

  const chain = (cid: string) => run.host.whyProbe(cid);
  const kinds = (c: ReasonLink[] | undefined) => (c ?? []).map((l) => l.kind);
  const clauseOf = (l: ReasonLink | undefined) =>
    l && "clause" in l ? (l.clause as { verb: string; object?: string }) : undefined;
  const plant = (cid: string, pur: Record<string, unknown>) => {
    run.session.needStep.delete(cid);
    run.session.pursuits.set(cid, pur as never);
  };

  it("the household really resolves an item — every pin below depends on it", () => {
    expect(headName).not.toBe("");
    expect(itemRef).toBeDefined();
  });

  it("② a body mid-GIVE reads `get X`, then `give X` as its purpose", () => {
    plant(head, {
      source: "command",
      goal: { kind: "give", item: itemRef!, to: mate },
      glyph: `${headName} + give + thing`,
    });
    try {
      const c = chain(head)!;
      // The step it is on (walk to the thing / pick it up) reads as the FETCH
      // that step serves — the walk-leg rule — and the rung above it is the
      // give the fetch is for. Then the ordinary authority rung.
      expect(kinds(c)).toEqual(["activity", "purpose", "authority", "end"]);
      expect(clauseOf(c[0])!.verb).toBe("get");
      expect(clauseOf(c[1])!.verb).toBe("give");
      // ONE thing, named the same way twice — the chain is about one object.
      expect(clauseOf(c[1])!.object).toBe(clauseOf(c[0])!.object);
      expect(c[2]).toEqual({ kind: "authority", clause: { subject: "you", verb: "ask" } });
    } finally {
      run.session.pursuits.delete(head);
    }
  });

  it("② a body walking to its MEAL reads `get X` → so that `eat X` → because hungry", () => {
    plant(head, {
      source: "need",
      tplKey: "hunger:food",
      goal: { kind: "consume", item: itemRef!, at: ["table"] },
      glyph: "",
    });
    try {
      const c = chain(head)!;
      expect(kinds(c)).toEqual(["activity", "purpose", "motive", "end"]);
      expect(clauseOf(c[0])!.verb).toBe("get");
      expect(clauseOf(c[1])!.verb).toBe("eat");
      expect(clauseOf(c[1])!.object).toBe(clauseOf(c[0])!.object);
      expect(c[2]).toEqual({
        kind: "motive",
        clause: { subject: "i_me", verb: "hungry", key: "hungry" },
      });
      // …and the ACTIVITY the same body claims is the same step (law ① — one
      // fact read twice): `what are you doing` and the chain cannot disagree.
      expect(run.host.activityOf(head)).toEqual({
        verb: clauseOf(c[0])!.verb,
        object: clauseOf(c[0])!.object,
      });
    } finally {
      run.session.pursuits.delete(head);
    }
  });

  it("a FETCH has nothing above it — the duplicate rung is COLLAPSED, not spoken twice", () => {
    // "I get the apple so that I get the apple" is not an explanation. The
    // goal's own rung IS the step's rung here, so the dedupe drops it.
    plant(head, { source: "command", goal: { kind: "fetch", item: itemRef! }, glyph: "" });
    try {
      expect(kinds(chain(head))).toEqual(["activity", "authority", "end"]);
    } finally {
      run.session.pursuits.delete(head);
    }
  });

  it("③ a CONTRIBUTE pursuit carries NO purpose rung — the bill chain is untouched", () => {
    plant(head, {
      source: "need",
      tplKey: CONTRIBUTE_TPL_KEY,
      bill: { siteId: "o:0", link: "build", head: "wood", spoken: false, issuer: "child" },
      goal: { kind: "buildwork", site: "o:0" },
      glyph: "",
    });
    try {
      const c = chain(head)!;
      expect(c.some((l) => l.kind === "purpose")).toBe(false);
      // …and it still answers with the town's own appetite, then ends (#45).
      expect(c[c.length - 1]).toEqual({ kind: "end" });
      expect(
        c.some((l) => l.kind === "because" && (l.clause as { subject?: string }).subject === "town"),
      ).toBe(true);
    } finally {
      run.session.pursuits.delete(head);
    }
  });

  it("③ LAW ③ — a what-doing + 3×why walk moves NOTHING, `pur.stand` included", () => {
    plant(head, {
      source: "need",
      tplKey: "hunger:food",
      goal: { kind: "consume", item: itemRef!, at: ["table"] },
      glyph: "",
    });
    try {
      const pur = run.session.pursuits.get(head)! as { stand?: Map<string, unknown> };
      const snap = () => ({
        clock: run.session.townClock,
        pursuits: [...run.session.pursuits.keys()].sort(),
        goal: JSON.stringify(run.session.pursuits.get(head)),
        // 🚨 THE ONE THING THE SHARED RESOLVER COULD HAVE MOVED: the committed
        // stand-spot cache. The why seat resolves with `commit: false`.
        stand: JSON.stringify([...(pur.stand ?? new Map())]),
        steps: [...run.session.needStep.keys()].sort(),
      });
      const before = snap();
      const w = createCreatureWorld([{ id: "me" }, { id: head }], []);
      const hostOpts: ProjectionOpts = {
        symbolOf: (id) => id,
        activityOf: (who) => run.host.activityOf(who) ?? undefined,
        reasonChainOf: (who, observer) => run.host.whyProbe(who, observer),
      };
      let ui: DeviceBoardState = {};
      let res = selectAct(
        w,
        head,
        "me",
        { kind: "what-doing", about: { symbol: "you", id: head }, glyph: "you + do#question" },
        "c",
        hostOpts,
        { ui },
      );
      ui = res.ui ?? {};
      for (let i = 0; i < 3; i++) {
        res = selectAct(w, head, "me", whyDoingAct(), "c", hostOpts, { ui });
        ui = res.ui ?? {};
      }
      expect(snap()).toEqual(before);
      // …and the chain is REPRODUCIBLE ask after ask (nothing cached, nothing
      // consumed) — the same property the untraced probe has always had.
      expect(chain(head)).toEqual(chain(head));
    } finally {
      run.session.pursuits.delete(head);
    }
  });

  it("④ E-6 — `stop + go` HALTS a walking eater, `stop + eat` halts, a lie still denies", () => {
    const syntax = run.session.meta.syntax;
    const bubble = (cid: string): string | undefined =>
      run.state.bubbles[`char:resident_face:${cid}`]?.glyph;
    const start = () => {
      run.session.pursuits.delete(head);
      plant(head, {
        source: "command",
        tplKey: "hunger:food",
        goal: { kind: "consume", item: itemRef!, at: ["table"] },
        glyph: "",
      });
      run.advance(20); // one second — the body takes its first leg
    };

    start();
    // THE PREMISE OF THE WHOLE CALL: the single reading this body claims is
    // NEITHER "go" NOR "eat" — it is the STEP. Under the old one-verb rule both
    // sentences below would have been denied.
    const claimed = run.host.activityOf(head)?.verb;
    expect(claimed).toBeDefined();
    expect(claimed).not.toBe("eat");

    run.speak(`${headName} + stop + go`);
    expect(bubble(head)).not.toBe(notDoingLine("go")[syntax]);

    start();
    run.speak(`${headName} + stop + eat`);
    expect(bubble(head)).not.toBe(notDoingLine("eat")[syntax]);

    // …and the guard still BITES: a verb this body is not doing by any reading
    // is corrected, exactly as it shipped.
    start();
    run.speak(`${headName} + stop + wash`);
    expect(bubble(head)).toBe(notDoingLine("wash")[syntax]);
    run.session.pursuits.delete(head);
  });
});
