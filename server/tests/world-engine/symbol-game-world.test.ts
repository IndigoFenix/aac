// Quest-world generator + converse engine tests.
//
// The property that matters most (per the plan's testing rule): ANY dimension
// combination the generator accepts must certify through the full goal-tree
// gauntlet (schema → solver → layout) AND be winnable by an actual runtime
// playthrough — a simulated "greedy" player who picks up what it finds, talks
// to every NPC, answers with completing/receiving options, and walks away when
// a conversation offers neither yet.
//
// Pure logic — no DB / LLM / GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import { certifyGoalTreeGame } from "@shared/world-engine/solver/index.js";
import {
  applyRuntimeInput,
  createRuntimeContext,
  createRuntimeState,
  type RuntimeContext,
  type RuntimeState,
} from "@shared/world-engine/solver/runtime.js";
import type { SpaceCommand, SpaceInput } from "@shared/world-engine/solver/space.js";
import { walkGoalTree } from "@shared/world-engine/solver/walk.js";
import type {
  ConverseCondition,
  ConverseNode,
  EntityDef,
  GoalTreeGame,
} from "@shared/world-engine/solver/types.js";
import {
  buildSymbolWorld,
  type QuestComplexity,
  type SyntaxLevel,
} from "@shared/world-engine/interaction/index.js";

/** Deterministic PRNG so every grid cell is reproducible. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const SYNTAXES: SyntaxLevel[] = ["a", "b", "c"];
const COMPLEXITIES: (QuestComplexity | "mixed")[] = ["simple", "request", "exchange", "lend", "mixed"];

function condsHold(conds: ConverseCondition[] | undefined, state: RuntimeState): boolean {
  return (conds ?? []).every((c) => {
    switch (c.kind) {
      case "carrying":
        return (state.inventory[c.entityId] ?? 0) > 0;
      case "not-carrying":
        return (state.inventory[c.entityId] ?? 0) === 0;
      case "knows":
        return !!state.known[c.entityId];
      case "given":
        return !!state.given[c.entityId];
    }
  });
}

function converseNodes(game: GoalTreeGame): ConverseNode[] {
  return [...walkGoalTree(game.root)]
    .map((v) => v.node)
    .filter((n): n is ConverseNode => n.type === "converse");
}

/** Apply an input and return the result while mutating the tracked state. */
function makeDriver(ctx: RuntimeContext) {
  let state: RuntimeState = createRuntimeState();
  const apply = (input: SpaceInput) => {
    const res = applyRuntimeInput(ctx, state, input);
    state = res.state;
    return res;
  };
  return { apply, get state() { return state; } };
}

/**
 * The greedy player: picks up every reachable prop, then rounds of talking to
 * each incomplete NPC — answering with a completing option when its conditions
 * hold, else a receiving option, else leaving. Then opens the star door and
 * touches the star. Returns the final state.
 */
function playThrough(game: GoalTreeGame): RuntimeState {
  const cert = certifyGoalTreeGame(game);
  if (!cert.ok) throw new Error(`did not certify: ${cert.errors.join("; ")}`);
  const ctx = createRuntimeContext(game, cert.world);
  const driver = makeDriver(ctx);
  driver.apply({ type: "start" });

  // Walk over every prop instance (zones are proven reachable by the solver).
  for (const inst of ctx.instances) {
    driver.apply({ type: "pick-item", instanceId: inst.id, entityId: inst.entityId });
  }

  const npcs = converseNodes(game);
  for (let round = 0; round < 6; round++) {
    for (const node of npcs) {
      if (driver.state.completed[node.id]) continue;
      driver.apply({ type: "touch-figure", nodeId: node.id });
      for (let turnGuard = 0; turnGuard < 20; turnGuard++) {
        if (driver.state.activeChoiceNodeId !== node.id) break; // completed or closed
        const turn = node.turns.find((t) => t.id === driver.state.converseTurnId);
        if (!turn) break;
        const open = turn.options.filter((o) => condsHold(o.when, driver.state));
        const pick =
          open.find((o) => o.completes) ??
          open.find((o) => (o.receive ?? []).some((id) => (driver.state.inventory[id] ?? 0) === 0)) ??
          // Ask for a clue when it would reveal something new (the knowledge-
          // gated request loop) or open a branch toward the goal (the lend
          // detour: ask-item → "give it back first").
          open.find((o) => (o.reveal ?? []).some((id) => !driver.state.known[id])) ??
          open.find(
            (o) =>
              o.next !== undefined &&
              o.next !== turn.id &&
              node.turns
                .find((t) => t.id === o.next)
                ?.options.some((n) => n.completes && condsHold(n.when, driver.state)),
          );
        if (!pick) {
          driver.apply({ type: "cancel-choice", nodeId: node.id });
          break;
        }
        driver.apply({ type: "select-option", nodeId: node.id, entityId: pick.entityId });
      }
    }
    if (npcs.every((n) => driver.state.completed[n.id])) break;
  }

  // Try every guarded passage until the star door opens, then touch the star.
  for (let i = 0; i < 20; i++) {
    for (const passage of cert.world.passages) {
      if (passage.guards.length) driver.apply({ type: "touch-door", passageId: passage.id });
    }
    driver.apply({ type: "touch-figure", nodeId: game.root.id });
    if (driver.state.won) break;
  }
  return driver.state;
}

describe("buildSymbolWorld — certification across the dimension grid", () => {
  for (const syntax of SYNTAXES) {
    for (const complexity of COMPLEXITIES) {
      for (const questCount of [1, 2, 3]) {
        it(`certifies + is winnable: syntax=${syntax} complexity=${complexity} quests=${questCount}`, () => {
          const game = buildSymbolWorld({
            questCount,
            syntax,
            complexity,
            rng: mulberry32(questCount * 100 + syntax.charCodeAt(0) * 7 + complexity.length),
          });
          const cert = certifyGoalTreeGame(game);
          expect(cert.ok ? [] : cert.errors).toEqual([]);
          const end = playThrough(game);
          expect(end.won).toBe(true);
        });
      }
    }
  }
});

describe("converse dialogue behavior", () => {
  it("exchange with announce:'after' certifies and is winnable (ask first, then the price)", () => {
    const game = buildSymbolWorld({
      questCount: 1,
      syntax: "b",
      complexity: "exchange",
      traderAnnounce: "after",
      rng: mulberry32(11),
    });
    const cert = certifyGoalTreeGame(game);
    expect(cert.ok ? [] : cert.errors).toEqual([]);
    expect(playThrough(game).won).toBe(true);
  });

  it("gates the vendor's request option on knowledge from the giver's clue", () => {
    const game = buildSymbolWorld({ questCount: 1, syntax: "b", complexity: "request", rng: mulberry32(5) });
    const cert = certifyGoalTreeGame(game);
    if (!cert.ok) throw new Error(cert.errors.join("; "));
    const ctx = createRuntimeContext(game, cert.world);
    const driver = makeDriver(ctx);
    driver.apply({ type: "start" });

    const [giver, vendor] = converseNodes(game);
    const reqOption = vendor!.turns
      .find((t) => t.id === "main_b")!
      .options.find((o) => o.receive?.length)!;

    // Before any clue: the vendor doesn't offer the request; a forced press no-ops.
    const before = driver.apply({ type: "touch-figure", nodeId: vendor!.id });
    const presented = before.commands.find(
      (c): c is Extract<SpaceCommand, { type: "present-choice" }> => c.type === "present-choice",
    )!;
    expect(presented.options.map((o) => o.entityId)).not.toContain(reqOption.entityId);
    driver.apply({ type: "select-option", nodeId: vendor!.id, entityId: reqOption.entityId });
    expect(driver.state.completed[vendor!.id]).toBeUndefined();
    driver.apply({ type: "cancel-choice", nodeId: vendor!.id });

    // Ask the giver for help (the clue reveals the item) → the request unlocks.
    driver.apply({ type: "touch-figure", nodeId: giver!.id });
    driver.apply({ type: "select-option", nodeId: giver!.id, entityId: "opt_help" });
    driver.apply({ type: "cancel-choice", nodeId: giver!.id });
    const after = driver.apply({ type: "touch-figure", nodeId: vendor!.id });
    const reopened = after.commands.find(
      (c): c is Extract<SpaceCommand, { type: "present-choice" }> => c.type === "present-choice",
    )!;
    expect(reopened.options.map((o) => o.entityId)).toContain(reqOption.entityId);
  });

  it("lending vendor demands the borrowed item back before granting the next", () => {
    const game = buildSymbolWorld({ questCount: 1, syntax: "b", complexity: "lend", rng: mulberry32(5) });
    const cert = certifyGoalTreeGame(game);
    if (!cert.ok) throw new Error(cert.errors.join("; "));
    const ctx = createRuntimeContext(game, cert.world);
    const driver = makeDriver(ctx);
    driver.apply({ type: "start" });

    const [giver, lender] = converseNodes(game);
    const main = lender!.turns.find((t) => t.id === "main_b")!;
    const borrow = main.options.find((o) => o.receive?.length && !o.completes)!;
    const askHolding = main.options.find((o) => o.next === "return_first")!;

    // Learn about the item, borrow the lure, then ask for the quest item.
    driver.apply({ type: "touch-figure", nodeId: giver!.id });
    driver.apply({ type: "select-option", nodeId: giver!.id, entityId: "opt_help" });
    driver.apply({ type: "cancel-choice", nodeId: giver!.id });
    driver.apply({ type: "touch-figure", nodeId: lender!.id });
    driver.apply({ type: "select-option", nodeId: lender!.id, entityId: borrow.entityId });
    const detour = driver.apply({ type: "select-option", nodeId: lender!.id, entityId: askHolding.entityId });
    const returnAsk = detour.commands.find(
      (c): c is Extract<SpaceCommand, { type: "present-choice" }> => c.type === "present-choice",
    )!;
    // The lender asks for the borrowed item back...
    expect(returnAsk.prompt).toContain("give");
    // ...and handing it over completes the quest-item grant.
    const giveBack = lender!.turns
      .find((t) => t.id === "return_first")!
      .options.find((o) => o.completes)!;
    const res = driver.apply({ type: "select-option", nodeId: lender!.id, entityId: giveBack.entityId });
    expect(driver.state.completed[lender!.id]).toBe(true);
    expect(res.events.filter((e) => e.type === "item-given").length).toBe(1);
    expect(res.events.filter((e) => e.type === "item-acquired").length).toBe(1);
  });

  it("drops the syntax level on CONFUSED and re-presents the same ask", () => {
    const game = buildSymbolWorld({ questCount: 1, syntax: "b", complexity: "simple", rng: mulberry32(7) });
    const cert = certifyGoalTreeGame(game);
    if (!cert.ok) throw new Error(cert.errors.join("; "));
    const ctx = createRuntimeContext(game, cert.world);
    const driver = makeDriver(ctx);
    driver.apply({ type: "start" });

    const giver = converseNodes(game)[0]!;
    const openRes = driver.apply({ type: "touch-figure", nodeId: giver.id });
    const present = openRes.commands.find(
      (c): c is Extract<SpaceCommand, { type: "present-choice" }> => c.type === "present-choice",
    )!;
    expect(driver.state.converseTurnId).toBe("main_b");
    // Level b asks with a two-glyph sentence.
    expect(present.prompt).toMatch(/^want \+ /);

    const confusedRes = driver.apply({ type: "select-option", nodeId: giver.id, entityId: "opt_confused" });
    const lower = confusedRes.commands.find(
      (c): c is Extract<SpaceCommand, { type: "present-choice" }> => c.type === "present-choice",
    )!;
    expect(driver.state.converseTurnId).toBe("main_a");
    // Level a asks with the bare item symbol (no "+").
    expect(lower.prompt).not.toContain("+");
    expect(present.prompt).toContain(lower.prompt);
  });

  it("routes refusal to the sad turn and OK closes failure-free", () => {
    const game = buildSymbolWorld({ questCount: 1, syntax: "b", complexity: "simple", rng: mulberry32(7) });
    const cert = certifyGoalTreeGame(game);
    if (!cert.ok) throw new Error(cert.errors.join("; "));
    const ctx = createRuntimeContext(game, cert.world);
    const driver = makeDriver(ctx);
    driver.apply({ type: "start" });

    const giver = converseNodes(game)[0]!;
    driver.apply({ type: "touch-figure", nodeId: giver.id });
    const rejectRes = driver.apply({ type: "select-option", nodeId: giver.id, entityId: "opt_no" });
    const sad = rejectRes.commands.find(
      (c): c is Extract<SpaceCommand, { type: "present-choice" }> => c.type === "present-choice",
    )!;
    expect(sad.prompt).toContain("sad");

    const okRes = driver.apply({ type: "select-option", nodeId: giver.id, entityId: "opt_ok" });
    expect(okRes.commands.some((c) => c.type === "dismiss-choice")).toBe(true);
    expect(driver.state.completed[giver.id]).toBeUndefined();
    // Re-approachable: touching again reopens at the entry turn.
    driver.apply({ type: "touch-figure", nodeId: giver.id });
    expect(driver.state.converseTurnId).toBe("main_b");
  });

  it("gates the give option on actually carrying the item", () => {
    const game = buildSymbolWorld({ questCount: 1, syntax: "b", complexity: "simple", rng: mulberry32(7) });
    const cert = certifyGoalTreeGame(game);
    if (!cert.ok) throw new Error(cert.errors.join("; "));
    const ctx = createRuntimeContext(game, cert.world);
    const driver = makeDriver(ctx);
    driver.apply({ type: "start" });

    const giver = converseNodes(game)[0]!;
    const giveOption = giver.turns
      .find((t) => t.id === "main_b")!
      .options.find((o) => o.give?.length)!;

    // Without the item: the option is not presented, and a forced press no-ops.
    const before = driver.apply({ type: "touch-figure", nodeId: giver.id });
    const presented = before.commands.find(
      (c): c is Extract<SpaceCommand, { type: "present-choice" }> => c.type === "present-choice",
    )!;
    expect(presented.options.map((o) => o.entityId)).not.toContain(giveOption.entityId);
    driver.apply({ type: "select-option", nodeId: giver.id, entityId: giveOption.entityId });
    expect(driver.state.completed[giver.id]).toBeUndefined();
    driver.apply({ type: "cancel-choice", nodeId: giver.id });

    // Pick up the prop, return, give — the quest completes and the item leaves
    // the satchel.
    for (const inst of ctx.instances) {
      driver.apply({ type: "pick-item", instanceId: inst.id, entityId: inst.entityId });
    }
    driver.apply({ type: "touch-figure", nodeId: giver.id });
    const res = driver.apply({ type: "select-option", nodeId: giver.id, entityId: giveOption.entityId });
    expect(driver.state.completed[giver.id]).toBe(true);
    expect(res.events.some((e) => e.type === "item-given")).toBe(true);
    const itemId = giveOption.give![0]!;
    expect(driver.state.inventory[itemId]).toBe(0);
  });
});

describe("converse certification guards", () => {
  const baseEntities: EntityDef[] = [
    { id: "npc", kind: "character", label: "Friend" },
    { id: "thing", kind: "item", label: "Thing" },
    { id: "opt_a", kind: "item", label: "yes", glyph: "yes" },
    { id: "opt_b", kind: "item", label: "no", glyph: "no" },
    { id: "star", kind: "marker", label: "Star" },
    { id: "gate", kind: "obstacle", label: "Gate" },
  ];

  function gameWith(...nodes: ConverseNode[]): GoalTreeGame {
    return {
      engine: "goal-tree",
      engineVersion: 1,
      meta: { title: "t", locale: "en", theme: "t" },
      entities: baseEntities,
      root: {
        type: "reach",
        id: "root",
        markerEntityId: "star",
        via: nodes.map((node, i) => ({
          type: "overcome",
          id: `ov${i}`,
          obstacleEntityId: "gate",
          key: node,
        })),
      },
    };
  }

  it("rejects a give option without a matching carrying condition", () => {
    const cert = certifyGoalTreeGame(
      gameWith({
        type: "converse",
        id: "talk",
        npcEntityId: "npc",
        entry: "main",
        turns: [
          {
            id: "main",
            lines: [{ glyph: "want + thing" }],
            options: [{ entityId: "opt_a", give: ["thing"], completes: true }],
          },
        ],
        propEntityIds: ["thing"],
      }),
    );
    expect(cert.ok).toBe(false);
    if (!cert.ok) expect(cert.errors.join(" ")).toContain("without a matching");
  });

  it("rejects a dialogue whose completing option is unreachable", () => {
    const cert = certifyGoalTreeGame(
      gameWith({
        type: "converse",
        id: "talk",
        npcEntityId: "npc",
        entry: "main",
        turns: [
          {
            id: "main",
            lines: [{ glyph: "hi" }],
            options: [{ entityId: "opt_a" }],
          },
          {
            id: "orphan",
            lines: [{ glyph: "hi" }],
            options: [{ entityId: "opt_a", completes: true }],
          },
        ],
      }),
    );
    expect(cert.ok).toBe(false);
    if (!cert.ok) {
      expect(cert.errors.join(" ")).toContain("no completing option");
    }
  });

  it("solver rejects a quest whose required item is never acquirable", () => {
    const cert = certifyGoalTreeGame(
      gameWith({
        type: "converse",
        id: "talk",
        npcEntityId: "npc",
        entry: "main",
        turns: [
          {
            id: "main",
            lines: [{ glyph: "want + thing" }],
            options: [
              {
                entityId: "opt_a",
                when: [{ kind: "carrying", entityId: "thing" }],
                give: ["thing"],
                completes: true,
              },
              { entityId: "opt_b" },
            ],
          },
        ],
        // No propEntityIds and no NPC grants "thing" — unwinnable by design.
      }),
    );
    expect(cert.ok).toBe(false);
    if (!cert.ok) {
      expect(cert.errors.join(" ")).toContain("never satisfiable");
    }
  });

  it("rejects two converse nodes consuming the same item", () => {
    const talk = (id: string): ConverseNode => ({
      type: "converse",
      id,
      npcEntityId: "npc",
      entry: "main",
      turns: [
        {
          id: "main",
          lines: [{ glyph: "want + thing" }],
          options: [
            {
              entityId: "opt_a",
              when: [{ kind: "carrying", entityId: "thing" }],
              give: ["thing"],
              completes: true,
            },
            { entityId: "opt_b" },
          ],
        },
      ],
      propEntityIds: ["thing"],
    });
    const cert = certifyGoalTreeGame(gameWith(talk("talk1"), talk("talk2")));
    expect(cert.ok).toBe(false);
    if (!cert.ok) {
      expect(cert.errors.join(" ")).toContain("more than one converse node");
    }
  });
});
