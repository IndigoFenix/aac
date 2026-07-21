// Property test for the symbol-game → goal-tree compiler.
//
// The single most important guarantee in the symbol game (planning-docs/
// symbol-learning-game-plan.md §12): ANY quote, under ANY binding, compiles to a
// goal-tree game that passes the FULL certification gauntlet (schema → solver →
// layout). This is the symbol game's analog of "certified solvable" — it's what
// lets the AI/binder produce content without playtesting.
//
// Pure logic — no DB / LLM / GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import { certifyGoalTreeGame } from "@shared/world-engine/solver/index.js";
import {
  POOLS,
  REQUESTING_EXCHANGES,
  bindExchange,
  compileExchange,
  firstMemberPicker,
  randomMemberPicker,
} from "@shared/world-engine/interaction/index.js";

// The TELL exchanges (≥2 board responses) — the ones the compiler handles today.
const TELL = REQUESTING_EXCHANGES.filter((e) => e.responses.length >= 2);

describe("symbol-game compiler → goal-tree certification", () => {
  it("covers the expected TELL exchanges", () => {
    expect(TELL.map((e) => e.id).sort()).toEqual(
      ["a2-want-or-not", "a3-more-or-done", "a4-give-me", "a6-give-or-take", "a7-want-more"].sort(),
    );
  });

  it("every TELL exchange certifies under the deterministic first binding", () => {
    for (const ex of TELL) {
      const game = compileExchange(bindExchange(ex, POOLS, firstMemberPicker));
      const cert = certifyGoalTreeGame(game);
      if (!cert.ok) {
        throw new Error(`exchange "${ex.id}" failed at ${cert.stage}: ${cert.errors.join("; ")}`);
      }
      expect(cert.ok).toBe(true);
    }
  });

  it("PROPERTY: every TELL exchange certifies under many random bindings", () => {
    for (const ex of TELL) {
      for (let trial = 0; trial < 30; trial++) {
        const game = compileExchange(bindExchange(ex, POOLS, randomMemberPicker));
        const cert = certifyGoalTreeGame(game);
        if (!cert.ok) {
          throw new Error(
            `exchange "${ex.id}" trial ${trial} failed at ${cert.stage}: ${cert.errors.join("; ")}`,
          );
        }
      }
    }
  });

  it("carries each response's composed glyph onto its choose-option entity", () => {
    const a6 = REQUESTING_EXCHANGES.find((e) => e.id === "a6-give-or-take")!;
    const game = compileExchange(bindExchange(a6, POOLS, firstMemberPicker)); // toy→ball
    const root = game.root;
    if (root.type !== "reach") throw new Error("expected reach root");
    const choose = root.via!.map((o) => o.key).find((k) => k.type === "choose");
    if (choose?.type !== "choose") throw new Error("expected choose");
    const byId = new Map(game.entities.map((e) => [e.id, e]));
    const optionEntities = choose.options.map((o) => byId.get(o.entityId)!);
    expect(optionEntities.map((e) => e.glyph)).toEqual(["give + ball", "take + ball"]);
    // The composed glyph is also the (placeholder) label until i18n lands.
    for (const e of optionEntities) expect(e.label).toBe(e.glyph);
  });

  it("compiles exactly one correct option, matching the catalog's correct response", () => {
    for (const ex of TELL) {
      const game = compileExchange(bindExchange(ex, POOLS, firstMemberPicker));
      // Find the choose node among the finish passage's guards (WATCH + TELL).
      const root = game.root;
      expect(root.type).toBe("reach");
      const choose = root.type === "reach"
        ? root.via?.map((o) => o.key).find((k) => k.type === "choose")
        : undefined;
      expect(choose?.type).toBe("choose");
      if (choose?.type !== "choose") throw new Error("expected a choose node");
      expect(choose.options.filter((o) => o.correct === true)).toHaveLength(1);
    }
  });

  it("compiles a DO fetch exchange (A1) to a carry-select transport with distractors, and certifies", () => {
    const a1 = REQUESTING_EXCHANGES.find((e) => e.id === "a1-want-fetch")!;
    const game = compileExchange(bindExchange(a1, POOLS, firstMemberPicker), { pools: POOLS }); // treat→cookie
    const root = game.root;
    if (root.type !== "reach") throw new Error("expected reach root");
    const transport = root.via?.map((o) => o.key).find((k) => k.type === "transport");
    if (transport?.type !== "transport") throw new Error("expected a transport node");
    // The target (cookie) plus the other treat-pool members as wrong carryables.
    expect(transport.distractorEntityIds?.length).toBeGreaterThanOrEqual(1);
    expect(certifyGoalTreeGame(game).ok).toBe(true);
  });

  it("a DO fetch without pools fails with a clear error", () => {
    const a1 = REQUESTING_EXCHANGES.find((e) => e.id === "a1-want-fetch")!;
    expect(() => compileExchange(bindExchange(a1, POOLS, firstMemberPicker))).toThrow(/pools/);
  });

  it("compiles a DO collect (group gather) to a collect node", () => {
    const gather = {
      id: "x-gather", concept: "want",
      action: { kind: "collect", slot: "treat" } as const,
      prompt: { id: "x-g", glyph: "{treat}", textKey: "k", slots: ["treat"], speaker: "npc" as const, concept: "want" },
      responses: [],
    };
    const game = compileExchange(bindExchange(gather, POOLS, firstMemberPicker), { pools: POOLS });
    const collect = game.root.type === "reach" ? game.root.via?.map((o) => o.key).find((k) => k.type === "collect") : undefined;
    expect(collect?.type).toBe("collect");
    expect(certifyGoalTreeGame(game).ok).toBe(true);
  });

  it("rejects an exchange with no responses and no action", () => {
    const a1 = REQUESTING_EXCHANGES.find((e) => e.id === "a1-want-fetch")!;
    const inert = { ...a1, action: undefined };
    expect(() => compileExchange(bindExchange(inert, POOLS, firstMemberPicker))).toThrow(
      /nothing to compile|no DO action/,
    );
  });

  it("prepends a WATCH (observe) beat that teaches the correct glyph", () => {
    const a6 = REQUESTING_EXCHANGES.find((e) => e.id === "a6-give-or-take")!;
    const game = compileExchange(bindExchange(a6, POOLS, firstMemberPicker)); // toy→ball
    const root = game.root;
    if (root.type !== "reach") throw new Error("expected reach root");
    // Two guards: observe (WATCH) then choose (TELL).
    const keys = (root.via ?? []).map((o) => o.key.type);
    expect(keys).toEqual(["observe", "choose"]);
    const observe = root.via![0]!.key;
    if (observe.type !== "observe") throw new Error("expected observe");
    expect(observe.targetGlyph).toBe("give + ball");
    expect(observe.contrastGlyph).toBe("take + ball");
    expect(observe.demonstrate.length).toBeGreaterThanOrEqual(1);
  });

  it("withWatch:false produces a pure TELL beat (choose only)", () => {
    const a4 = REQUESTING_EXCHANGES.find((e) => e.id === "a4-give-me")!;
    const game = compileExchange(bindExchange(a4, POOLS, firstMemberPicker), { withWatch: false });
    const root = game.root;
    if (root.type !== "reach") throw new Error("expected reach root");
    expect((root.via ?? []).map((o) => o.key.type)).toEqual(["choose"]);
    expect(certifyGoalTreeGame(game).ok).toBe(true);
  });

  it("attaches an onCorrect payoff to contingency concepts (A3 = more) and still certifies", () => {
    const a3 = REQUESTING_EXCHANGES.find((e) => e.id === "a3-more-or-done")!;
    const game = compileExchange(bindExchange(a3, POOLS, firstMemberPicker));
    const choose = game.root.type === "reach" ? game.root.via?.find((o) => o.key.type === "choose")?.key : undefined;
    if (choose?.type !== "choose") throw new Error("expected choose");
    expect(choose.onCorrect?.length).toBeGreaterThanOrEqual(1);
    expect(choose.onCorrect![0]!.kind).toBe("spawn");
    expect(certifyGoalTreeGame(game).ok).toBe(true);

    // A non-contingency concept (A4 = give) gets no payoff.
    const a4 = REQUESTING_EXCHANGES.find((e) => e.id === "a4-give-me")!;
    const giveGame = compileExchange(bindExchange(a4, POOLS, firstMemberPicker));
    const giveChoose = giveGame.root.type === "reach" ? giveGame.root.via?.find((o) => o.key.type === "choose")?.key : undefined;
    if (giveChoose?.type !== "choose") throw new Error("expected choose");
    expect(giveChoose.onCorrect).toBeUndefined();
  });
});
