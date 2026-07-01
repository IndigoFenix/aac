// Runtime test: a contingency choose's onCorrect payoff fires through the
// goal-tree reducer (planning-docs/symbol-learning-game-plan.md §4.1).
//
// Drives the A3 (MORE/ALL-DONE) compiled game: present the choice, pick the
// correct option (MORE), and assert the runtime emits a `demonstrate` command
// carrying the spawn payoff cue — i.e. "press MORE → a bubble pops out".
//
// Pure logic — no DB / LLM / GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import { certifyGoalTreeGame } from "@shared/goal-tree/index.js";
import {
  applyRuntimeInput,
  createRuntimeContext,
  createRuntimeState,
} from "@shared/goal-tree/runtime.js";
import type { ChooseNode } from "@shared/goal-tree/types.js";
import {
  POOLS,
  REQUESTING_EXCHANGES,
  bindExchange,
  compileExchange,
  firstMemberPicker,
} from "@shared/symbol-game/index.js";

describe("symbol-game runtime — onCorrect payoff", () => {
  it("emits a demonstrate command with the spawn cue when MORE is chosen", () => {
    const a3 = REQUESTING_EXCHANGES.find((e) => e.id === "a3-more-or-done")!;
    const game = compileExchange(bindExchange(a3, POOLS, firstMemberPicker));

    const cert = certifyGoalTreeGame(game);
    if (!cert.ok) throw new Error(`a3 failed to certify: ${cert.errors.join("; ")}`);

    // Locate the choose node + its correct option entity.
    const root = game.root;
    if (root.type !== "reach") throw new Error("expected reach root");
    const choose = root.via!.map((o) => o.key).find((k): k is ChooseNode => k.type === "choose")!;
    const correctEntityId = choose.options.find((o) => o.correct)!.entityId;
    expect(choose.onCorrect?.[0]?.kind).toBe("spawn");

    const ctx = createRuntimeContext(game, cert.world);
    let state = createRuntimeState();
    state = applyRuntimeInput(ctx, state, { type: "start" }).state;
    // Touch the poser to present the choice.
    state = applyRuntimeInput(ctx, state, { type: "touch-figure", nodeId: choose.id }).state;
    // Pick the correct option (MORE).
    const res = applyRuntimeInput(ctx, state, {
      type: "select-option",
      nodeId: choose.id,
      entityId: correctEntityId,
    });

    const demo = res.commands.find((c) => c.type === "demonstrate");
    expect(demo).toBeDefined();
    if (demo?.type !== "demonstrate") throw new Error("expected demonstrate command");
    expect(demo.cues.some((c) => c.kind === "spawn")).toBe(true);
    // The choose completed (failure-free correct pick).
    expect(res.state.completed[choose.id]).toBe(true);
    // The payoff is labelled with the chosen option's composed glyph ("more").
    expect(demo.targetGlyph).toBe("more");
  });

  it("a wrong pick fires NO payoff and keeps the panel open (failure-free)", () => {
    const a3 = REQUESTING_EXCHANGES.find((e) => e.id === "a3-more-or-done")!;
    const game = compileExchange(bindExchange(a3, POOLS, firstMemberPicker));
    const cert = certifyGoalTreeGame(game);
    if (!cert.ok) throw new Error("a3 failed to certify");

    const root = game.root;
    if (root.type !== "reach") throw new Error("expected reach root");
    const choose = root.via!.map((o) => o.key).find((k): k is ChooseNode => k.type === "choose")!;
    const wrongEntityId = choose.options.find((o) => !o.correct)!.entityId;

    const ctx = createRuntimeContext(game, cert.world);
    let state = createRuntimeState();
    state = applyRuntimeInput(ctx, state, { type: "start" }).state;
    state = applyRuntimeInput(ctx, state, { type: "touch-figure", nodeId: choose.id }).state;
    const res = applyRuntimeInput(ctx, state, {
      type: "select-option",
      nodeId: choose.id,
      entityId: wrongEntityId,
    });

    expect(res.commands.some((c) => c.type === "demonstrate")).toBe(false);
    expect(res.state.completed[choose.id]).toBeUndefined();
    expect(res.events.some((e) => e.type === "wrong-choice")).toBe(true);
  });
});
