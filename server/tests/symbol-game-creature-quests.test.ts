// Creature-quest world generator + simulation certifier tests.
//
// Every dimension combination must pass BOTH gauntlets: the goal-tree static
// certification (schema/zones/layout; `fulfill` is play-side like transport)
// AND the deterministic greedy-player SIMULATION over the creature rules —
// the behavioral playability proof (creature-needs.md §9).
//
// Pure logic — no DB / LLM / GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import { walkGoalTree } from "@shared/goal-tree/walk.js";
import type { GoalTreeGame, FulfillNode } from "@shared/goal-tree/types.js";
import { applyRuntimeInput, createRuntimeContext, createRuntimeState } from "@shared/goal-tree/runtime.js";
import { certifyGoalTreeGame } from "@shared/goal-tree/index.js";
import {
  applyTransform,
  buildCreatureQuestWorld,
  causalFrameCompatible,
  certifyCreatureQuestWorld,
  claimItem,
  concludeTransfer,
  createCreatureWorld,
  creatureWorldFromGame,
  giveItem,
  noteArrival,
  notePlacement,
  openNeeds,
  projectDialogue,
  requestItem,
  seeItem,
  selectAct,
  settleObligations,
  toggleDevice,
  powerUp,
  useStation,
  PLAYER_CREATURE_ID,
  type DialogueAct,
  type ProjectionOpts,
  type QuestComplexity,
  type SyntaxLevel,
} from "@shared/symbol-game/index.js";

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

describe("buildCreatureQuestWorld — both gauntlets across the grid", () => {
  for (const syntax of SYNTAXES) {
    for (const complexity of COMPLEXITIES) {
      for (const questCount of [1, 2, 3]) {
        it(`certifies: syntax=${syntax} complexity=${complexity} quests=${questCount}`, () => {
          const game = buildCreatureQuestWorld({
            questCount,
            syntax,
            complexity,
            rng: mulberry32(questCount * 131 + syntax.charCodeAt(0) * 17 + complexity.length),
          });
          const cert = certifyCreatureQuestWorld(game);
          expect(cert.ok ? [] : cert.errors).toEqual([]);
        });
      }
    }
  }

  it("announce:'after' traders certify too", () => {
    const game = buildCreatureQuestWorld({
      questCount: 2,
      complexity: "exchange",
      traderAnnounce: "after",
      rng: mulberry32(9),
    });
    expect(certifyCreatureQuestWorld(game).ok).toBe(true);
  });

  for (const complexity of ["request", "exchange", "lend"] as const) {
    it(`ask-around clue routing certifies: complexity=${complexity}`, () => {
      const game = buildCreatureQuestWorld({
        questCount: 2,
        complexity,
        clueRouting: "askAround",
        rng: mulberry32(complexity.length * 31),
      });
      const cert = certifyCreatureQuestWorld(game);
      expect(cert.ok ? [] : cert.errors).toEqual([]);
    });
  }
});

describe("counting b — multi-item needs", () => {
  for (const complexity of ["simple", "request", "exchange"] as const) {
    for (const needCount of [2, 3]) {
      it(`certifies: complexity=${complexity} needCount=${needCount}`, () => {
        const game = buildCreatureQuestWorld({
          questCount: 2,
          complexity,
          needCount,
          rng: mulberry32(needCount * 41 + complexity.length),
        });
        const cert = certifyCreatureQuestWorld(game);
        expect(cert.ok ? [] : cert.errors).toEqual([]);
      });
    }
  }

  it("partial delivery leaves the need open and the ask reads MORE", () => {
    const game = buildCreatureQuestWorld({ questCount: 1, complexity: "simple", needCount: 2, rng: mulberry32(31) });
    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [giverId, node] = [...nodeByCreature].find(([, n]) => n.needItemEntityId)!;
    const ids = [node.needItemEntityId!, ...(node.needItemEntityIds ?? [])];
    expect(ids).toHaveLength(2);
    // The instances share ONE symbol (same kind) — resolve like the player does.
    const symbolOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? id;
    const opts: ProjectionOpts = { symbolOf };
    expect(symbolOf(ids[0]!)).toBe(symbolOf(ids[1]!));

    claimItem(world, PLAYER_CREATURE_ID, ids[0]!, { takerAcceptsAnything: true });
    giveItem(world, PLAYER_CREATURE_ID, giverId, ids[0]!);
    expect(openNeeds(world.creatures[giverId]!)).toHaveLength(1);
    const proj = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "b", opts);
    expect(proj.lineGlyph).toBe(`more + ${symbolOf(ids[1]!)}`);

    // Holding ANY remaining instance re-enables the offer (instance-robust).
    claimItem(world, PLAYER_CREATURE_ID, ids[1]!, { takerAcceptsAnything: true });
    const proj2 = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "b", opts);
    expect(proj2.acts.some((a) => a.kind === "offer" && a.itemId === ids[1])).toBe(true);
    giveItem(world, PLAYER_CREATURE_ID, giverId, ids[1]!);
    expect(openNeeds(world.creatures[giverId]!)).toHaveLength(0);
  });

  it("lend quests force a single need (a consumed borrow can't come back)", () => {
    const game = buildCreatureQuestWorld({ questCount: 1, complexity: "lend", needCount: 3, rng: mulberry32(17) });
    const { nodeByCreature } = creatureWorldFromGame(game);
    const giver = [...nodeByCreature.values()].find((n) => n.needItemEntityId && !n.stockEntityIds)!;
    expect(giver.needItemEntityIds).toBeUndefined();
    expect(certifyCreatureQuestWorld(game).ok).toBe(true);
  });
});

describe("task b — placement (state) needs", () => {
  for (const complexity of ["simple", "request", "exchange", "lend"] as const) {
    it(`certifies: complexity=${complexity} task=place`, () => {
      const game = buildCreatureQuestWorld({
        questCount: 2,
        complexity,
        task: "place",
        rng: mulberry32(complexity.length * 53),
      });
      const cert = certifyCreatureQuestWorld(game);
      expect(cert.ok ? [] : cert.errors).toEqual([]);
    });
  }

  it("the kitchen sink certifies: place + multi + ask-around", () => {
    const game = buildCreatureQuestWorld({
      questCount: 2,
      complexity: "request",
      task: "place",
      needCount: 2,
      clueRouting: "askAround",
      rng: mulberry32(59),
    });
    const cert = certifyCreatureQuestWorld(game);
    expect(cert.ok ? [] : cert.errors).toEqual([]);
  });

  it("hand-over is redirected to the box; the drop fulfills, binds, and earns the debt", () => {
    const game = buildCreatureQuestWorld({ questCount: 1, complexity: "simple", task: "place", rng: mulberry32(23) });
    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [giverId, node] = [...nodeByCreature].find(([, n]) => n.needItemEntityId)!;
    const itemId = node.needItemEntityId!;
    const destId = node.needPlacedInEntityId!;
    expect(destId).toBeDefined();
    expect(world.creatures[giverId]!.needs[0]!.placedAt).toBe(destId);
    const opts: ProjectionOpts = { symbolOf: (id) => id };

    // The line asks for the placement, not a hand-over.
    const proj = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "b", opts);
    expect(proj.lineGlyph).toBe(`${itemId} + in + ${destId}`);

    // Offering the item in hand does NOT transfer it — polite redirect.
    claimItem(world, PLAYER_CREATURE_ID, itemId, { takerAcceptsAnything: true });
    const offer: DialogueAct = { kind: "offer", itemId, glyph: "" };
    const res = selectAct(world, giverId, PLAYER_CREATURE_ID, offer, "b", opts);
    expect(world.items[itemId]!.ownerId).toBe(PLAYER_CREATURE_ID);
    expect(res.responseGlyph).toBe(`${itemId} + in + ${destId}`);

    // The physical drop into the container is what fulfills.
    const events = notePlacement(world, PLAYER_CREATURE_ID, itemId, destId);
    expect(events.some((e) => e.type === "need-fulfilled")).toBe(true);
    expect(world.items[itemId]!.ownerId).toBe(giverId);
    expect(world.items[itemId]!.bound).toBe(true);
    expect(world.creatures[giverId]!.debts[PLAYER_CREATURE_ID]).toBe(3);
    expect(openNeeds(world.creatures[giverId]!)).toHaveLength(0);
  });
});

describe("item b — descriptor variants (glyph system)", () => {
  for (const complexity of ["simple", "request", "exchange", "lend"] as const) {
    it(`certifies: complexity=${complexity} descriptors=on`, () => {
      const game = buildCreatureQuestWorld({
        questCount: 2,
        complexity,
        descriptors: true,
        rng: mulberry32(complexity.length * 67),
      });
      const cert = certifyCreatureQuestWorld(game);
      expect(cert.ok ? [] : cert.errors).toEqual([]);
    });
  }

  it("variant entities are minimal pairs of COMPOSED glyphs", () => {
    const game = buildCreatureQuestWorld({ questCount: 1, complexity: "simple", descriptors: true, rng: mulberry32(29) });
    const { nodeByCreature } = creatureWorldFromGame(game);
    const [, node] = [...nodeByCreature].find(([, n]) => n.needItemEntityId)!;
    const neededId = node.needItemEntityId!;
    const wrongId = node.propEntityIds!.find((id) => id !== neededId)!;
    const glyphOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? "";
    const [nHead, nMod] = glyphOf(neededId).split(".");
    const [wHead, wMod] = glyphOf(wrongId).split(".");
    expect(nMod).toBeTruthy(); // composed, not bare
    expect(wHead).toBe(nHead); // same kind…
    expect(wMod).not.toBe(nMod); // …one modifier axis varies
  });

  it("wrong-variant offer → '{item} + {descriptor}.not', item kept; right variant lands", () => {
    const game = buildCreatureQuestWorld({ questCount: 1, complexity: "simple", descriptors: true, rng: mulberry32(29) });
    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [giverId, node] = [...nodeByCreature].find(([, n]) => n.needItemEntityId)!;
    const neededId = node.needItemEntityId!;
    const wrongId = node.propEntityIds!.find((id) => id !== neededId)!;
    const symbolOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? id;
    const [head, wantedMod] = symbolOf(neededId).split(".");
    const opts: ProjectionOpts = { symbolOf };

    claimItem(world, PLAYER_CREATURE_ID, wrongId, { takerAcceptsAnything: true });
    // The wrong variant is offerable (the corrective moment must be reachable)…
    const proj = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "b", opts);
    expect(proj.acts.some((a) => a.kind === "offer" && a.itemId === wrongId)).toBe(true);
    // …and declined by naming the missing descriptor; the player keeps it.
    const res = selectAct(world, giverId, PLAYER_CREATURE_ID, { kind: "offer", itemId: wrongId, glyph: "" }, "b", opts);
    expect(res.responseGlyph).toBe(`${head} + ${wantedMod}.not`);
    expect(world.items[wrongId]!.ownerId).toBe(PLAYER_CREATURE_ID);

    claimItem(world, PLAYER_CREATURE_ID, neededId, { takerAcceptsAnything: true });
    const ok = selectAct(world, giverId, PLAYER_CREATURE_ID, { kind: "offer", itemId: neededId, glyph: "" }, "b", opts);
    expect(ok.responseGlyph).toBe("thank_you");
    expect(openNeeds(world.creatures[giverId]!)).toHaveLength(0);
  });

  it("a mistakenly-bought distractor is recoverable via the return price", () => {
    const game = buildCreatureQuestWorld({ questCount: 1, complexity: "request", descriptors: true, rng: mulberry32(37) });
    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [vendorId, vendorNode] = [...nodeByCreature].find(([, n]) => !n.needItemEntityId)!;
    const [, giverNode] = [...nodeByCreature].find(([, n]) => n.needItemEntityId)!;
    const neededId = giverNode.needItemEntityId!;
    const wrongId = vendorNode.stockEntityIds!.find((id) => id !== neededId)!;

    for (const id of vendorNode.stockEntityIds!) {
      seeItem(world, PLAYER_CREATURE_ID, id, { kind: "held", by: vendorId });
    }
    // Mistakenly buy the WRONG variant — the single debt is spent.
    expect(requestItem(world, PLAYER_CREATURE_ID, vendorId, wrongId).kind).toBe("accept");
    concludeTransfer(world, PLAYER_CREATURE_ID, wrongId);
    // The needed one is now PRICED: give the wrong one back — never stranded.
    const out = requestItem(world, PLAYER_CREATURE_ID, vendorId, neededId);
    expect(out).toEqual({ kind: "price", price: { kind: "return", itemId: wrongId } });
    giveItem(world, PLAYER_CREATURE_ID, vendorId, wrongId);
    settleObligations(world, vendorId);
    concludeTransfer(world, PLAYER_CREATURE_ID, neededId);
    expect(world.items[neededId]!.ownerId).toBe(PLAYER_CREATURE_ID);
  });
});

describe("task c — on-behalf needs (deliver)", () => {
  for (const complexity of ["simple", "request", "exchange", "lend"] as const) {
    it(`certifies: complexity=${complexity} task=deliver`, () => {
      const game = buildCreatureQuestWorld({
        questCount: 2,
        complexity,
        task: "deliver",
        rng: mulberry32(complexity.length * 71),
      });
      const cert = certifyCreatureQuestWorld(game);
      expect(cert.ok ? [] : cert.errors).toEqual([]);
    });
  }

  it("giving the item to the RECIPIENT fulfills both needs; the giver never takes it", () => {
    const game = buildCreatureQuestWorld({ questCount: 1, complexity: "simple", task: "deliver", rng: mulberry32(43) });
    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [giverId, giverNode] = [...nodeByCreature].find(([, n]) => n.needForNodeId)!;
    const recipId = giverNode.needForNodeId!;
    const itemId = giverNode.needItemEntityId!;
    const symbolOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? id;
    const opts: ProjectionOpts = { symbolOf, symbolOfCreature: (cid) => cid };

    // The giver announces the recipient frame ("ball to bear").
    const proj = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "b", opts);
    expect(proj.lineGlyph).toBe(`${symbolOf(itemId)} + to + ${recipId}`);
    // …and at level c, the full give-frame.
    const projC = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "c", opts);
    expect(projC.lineGlyph).toBe(`give + ${symbolOf(itemId)} + to + ${recipId}`);

    // Offering the item to the GIVER is redirected, not taken.
    claimItem(world, PLAYER_CREATURE_ID, itemId, { takerAcceptsAnything: true });
    const res = selectAct(world, giverId, PLAYER_CREATURE_ID, { kind: "offer", itemId, glyph: "" }, "b", opts);
    expect(world.items[itemId]!.ownerId).toBe(PLAYER_CREATURE_ID);
    expect(res.responseGlyph).toBe(`${symbolOf(itemId)} + to + ${recipId}`);

    // Giving it to the recipient fulfills BOTH — and both owe the player.
    const give = selectAct(world, recipId, PLAYER_CREATURE_ID, { kind: "offer", itemId, glyph: "" }, "b", opts);
    expect(give.responseGlyph).toBe("thank_you");
    const fulfilled = give.events
      .filter((e) => e.type === "need-fulfilled")
      .map((e) => (e.type === "need-fulfilled" ? e.creatureId : ""))
      .sort();
    expect(fulfilled).toEqual([giverId, recipId].sort());
    expect(openNeeds(world.creatures[giverId]!)).toHaveLength(0);
    expect(world.creatures[giverId]!.debts[PLAYER_CREATURE_ID]).toBe(3);
    expect(world.creatures[recipId]!.debts[PLAYER_CREATURE_ID]).toBe(3);
    expect(world.items[itemId]!.ownerId).toBe(recipId);
    expect(world.items[itemId]!.bound).toBe(true);
  });

  it("the kitchen sink certifies: deliver + descriptors + ask-around", () => {
    const game = buildCreatureQuestWorld({
      questCount: 1,
      complexity: "request",
      task: "deliver",
      descriptors: true,
      clueRouting: "askAround",
      rng: mulberry32(47),
    });
    const cert = certifyCreatureQuestWorld(game);
    expect(cert.ok ? [] : cert.errors).toEqual([]);
  });
});

describe("item transformations b — states + stations", () => {
  for (const complexity of ["simple", "request", "exchange", "lend"] as const) {
    it(`certifies: complexity=${complexity} transformations=on`, () => {
      const game = buildCreatureQuestWorld({
        questCount: 2,
        complexity,
        transformations: true,
        rng: mulberry32(complexity.length * 79),
      });
      const cert = certifyCreatureQuestWorld(game);
      expect(cert.ok ? [] : cert.errors).toEqual([]);
    });
  }

  it("wrong-state offer → '{item} + {state}.not'; the station swap makes it land", () => {
    const game = buildCreatureQuestWorld({ questCount: 1, complexity: "simple", transformations: true, rng: mulberry32(53) });
    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [giverId, node] = [...nodeByCreature].find(([, n]) => n.needItemEntityId)!;
    const itemId = node.needItemEntityId!;
    const wanted = node.needItemState!;
    expect(wanted).toBeTruthy();
    const station = [...nodeByCreature.values()].flatMap((n) => n.stationKinds ?? []);
    expect(station).toHaveLength(1);
    const symbolOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? id;
    const opts: ProjectionOpts = { symbolOf };
    // The item spawns in the OPPOSITE state (visible), the need asks for the swap.
    const initial = world.items[itemId]!.states;
    expect(initial).toHaveLength(1);
    expect(initial[0]).not.toBe(wanted);
    const head = symbolOf(itemId).split(".")[0]!;
    const proj = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "b", opts);
    expect(proj.lineGlyph).toBe(`want + ${head}.${wanted}`);

    // Offering it untransformed is declined by naming the missing state…
    claimItem(world, PLAYER_CREATURE_ID, itemId, { takerAcceptsAnything: true });
    const offer: DialogueAct = { kind: "offer", itemId, glyph: "" };
    const res = selectAct(world, giverId, PLAYER_CREATURE_ID, offer, "b", opts);
    expect(res.responseGlyph).toBe(`${head} + ${wanted}.not`);
    expect(world.items[itemId]!.ownerId).toBe(PLAYER_CREATURE_ID);
    // …and the offer stays reachable on the board (the lesson).
    const proj2 = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "b", opts);
    expect(proj2.acts.some((a) => a.kind === "offer" && a.itemId === itemId)).toBe(true);

    // The station swaps the state; the offer now lands.
    applyTransform(world, itemId, wanted, initial[0]);
    expect(world.items[itemId]!.states).toEqual([wanted]);
    const ok = selectAct(world, giverId, PLAYER_CREATURE_ID, offer, "b", opts);
    expect(ok.responseGlyph).toBe("thank_you");
    expect(openNeeds(world.creatures[giverId]!)).toHaveLength(0);
  });

  it("a required state with NO station fails certification", () => {
    const game = buildCreatureQuestWorld({ questCount: 1, complexity: "simple", transformations: true, rng: mulberry32(53) });
    for (const { node } of walkGoalTree(game.root)) {
      if (node.type === "fulfill") delete node.stationKinds;
    }
    const cert = certifyCreatureQuestWorld(game);
    expect(cert.ok).toBe(false);
    if (!cert.ok) expect(cert.errors.join(" ")).toContain("no station");
  });

  it("the kitchen sink certifies: transformations + descriptors + deliver + multi", () => {
    const game = buildCreatureQuestWorld({
      questCount: 1,
      complexity: "request",
      transformations: true,
      descriptors: true,
      task: "deliver",
      needCount: 2,
      rng: mulberry32(61),
    });
    const cert = certifyCreatureQuestWorld(game);
    expect(cert.ok ? [] : cert.errors).toEqual([]);
  });
});

describe("request c — inferred needs (announce never)", () => {
  for (const complexity of ["simple", "request", "exchange"] as const) {
    it(`certifies: complexity=${complexity} giverAnnounce=never`, () => {
      const game = buildCreatureQuestWorld({
        questCount: 2,
        complexity,
        giverAnnounce: "never",
        rng: mulberry32(complexity.length * 83),
      });
      const cert = certifyCreatureQuestWorld(game);
      expect(cert.ok ? [] : cert.errors).toEqual([]);
    });
  }

  it("sad greet, sad small talk, no reveal — the keepsake is kept, the right offer lands", () => {
    const game = buildCreatureQuestWorld({ questCount: 1, complexity: "simple", giverAnnounce: "never", rng: mulberry32(67) });
    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [giverId, node] = [...nodeByCreature].find(([, n]) => n.needItemEntityId)!;
    const itemId = node.needItemEntityId!;
    expect(node.announce).toBe("never");
    expect(node.thoughtScaffold).toBe(true);
    // Evidence: a bound same-kind keepsake, displayed and owned.
    const keepId = node.boundEntityIds![0]!;
    const glyphOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? id;
    expect(glyphOf(keepId).split(".")[0]).toBe(glyphOf(itemId).split(".")[0]);
    expect(world.items[keepId]!).toMatchObject({ ownerId: giverId, bound: true, displayed: true });

    const symbolOf = glyphOf;
    const opts: ProjectionOpts = { symbolOf, announce: "never" };
    // The creature only emotes — its line never names the want…
    const proj = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "b", opts);
    expect(proj.lineGlyph).toBe("i_me + sad");
    expect(proj.lineGlyph.includes(glyphOf(itemId))).toBe(false);
    // …and small talk stays sad instead of revealing.
    const talk = selectAct(world, giverId, PLAYER_CREATURE_ID, { kind: "how-are-you", glyph: "" }, "b", opts);
    expect(talk.responseGlyph).toBe("i_me + sad");
    // The keepsake can be seen and asked for, but never granted.
    seeItem(world, PLAYER_CREATURE_ID, keepId, { kind: "held", by: giverId });
    const ask = selectAct(world, giverId, PLAYER_CREATURE_ID, { kind: "request", itemId: keepId, glyph: "" }, "b", opts);
    expect(ask.responseGlyph).toContain(".my");
    // Inferring correctly and OFFERING resolves it.
    claimItem(world, PLAYER_CREATURE_ID, itemId, { takerAcceptsAnything: true });
    const offer = selectAct(world, giverId, PLAYER_CREATURE_ID, { kind: "offer", itemId, glyph: "" }, "b", opts);
    expect(offer.responseGlyph).toBe("thank_you");
    expect(openNeeds(world.creatures[giverId]!)).toHaveLength(0);
  });

  it("a never-announcing wanter without evidence fails certification", () => {
    const game = buildCreatureQuestWorld({ questCount: 1, complexity: "simple", giverAnnounce: "never", rng: mulberry32(67) });
    for (const { node } of walkGoalTree(game.root)) {
      if (node.type === "fulfill") delete node.boundEntityIds;
    }
    const cert = certifyCreatureQuestWorld(game);
    expect(cert.ok).toBe(false);
    if (!cert.ok) expect(cert.errors.join(" ")).toContain("evidence");
  });

  it("the kitchen sink certifies: inferred + transformations + descriptors", () => {
    const game = buildCreatureQuestWorld({
      questCount: 1,
      complexity: "request",
      giverAnnounce: "never",
      transformations: true,
      descriptors: true,
      rng: mulberry32(71),
    });
    const cert = certifyCreatureQuestWorld(game);
    expect(cert.ok ? [] : cert.errors).toEqual([]);
    // The keepsake shows the WANTED composition (variant + transformed state).
    const { nodeByCreature } = creatureWorldFromGame(game);
    const node = [...nodeByCreature.values()].find((n) => n.announce === "never")!;
    const glyphOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? "";
    const keepGlyph = glyphOf(node.boundEntityIds![0]!);
    expect(keepGlyph.split(".")).toContain(node.needItemState!);
  });
});

describe("phrase generator — glyph counts + person deixis", () => {
  // Content slots: "+"-separated parts minus the forward-binding joins.
  const JOINS = new Set(["to", "in", "on", "for", "and", "or", "from", "under", "over"]);
  const slots = (g: string) =>
    g.split("+").map((s) => s.trim()).filter((s) => s && !JOINS.has(s)).length;

  it("a/b/c render 1/2/3 content slots and the game carries meta.syntax", () => {
    const game = buildCreatureQuestWorld({ questCount: 1, complexity: "simple", syntax: "c", rng: mulberry32(3) });
    expect(game.meta.syntax).toBe("c");
    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [giverId, node] = [...nodeByCreature].find(([, n]) => n.needItemEntityId)!;
    const symbolOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? id;
    const opts: ProjectionOpts = { symbolOf };
    const at = (lvl: SyntaxLevel) => projectDialogue(world, giverId, PLAYER_CREATURE_ID, lvl, opts).lineGlyph;
    expect(slots(at("a"))).toBe(1);
    expect(slots(at("b"))).toBe(2);
    expect(slots(at("c"))).toBe(3);
    expect(at("c")).toBe(`i_me + want + ${symbolOf(node.needItemEntityId!)}`);
  });

  it("state-need sentences cap at 3 content slots (subject drops for the tail)", () => {
    const game = buildCreatureQuestWorld({ questCount: 1, complexity: "simple", task: "place", rng: mulberry32(23) });
    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [giverId, node] = [...nodeByCreature].find(([, n]) => n.needItemEntityId)!;
    const opts: ProjectionOpts = { symbolOf: (id) => id };
    const c = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "c", opts).lineGlyph;
    expect(c).toBe(`want + ${node.needItemEntityId} + in + ${node.needPlacedInEntityId}`);
    expect(slots(c)).toBe(3);
  });

  it("creature references resolve by person: the player reads as 'you'", () => {
    // Hand-built: creature "a" wants the PLAYER to have the apple.
    const world = createCreatureWorld(
      [
        { id: "a", needs: [{ itemId: "apple", value: 3, forCreature: PLAYER_CREATURE_ID }] },
        { id: PLAYER_CREATURE_ID },
      ],
      [{ id: "apple" }],
    );
    const opts: ProjectionOpts = { symbolOf: (id) => id, symbolOfCreature: (id) => id };
    const proj = projectDialogue(world, "a", PLAYER_CREATURE_ID, "c", opts);
    expect(proj.lineGlyph).toBe("give + apple + to + you");
    expect(proj.lineGlyph.includes("a +")).toBe(false); // never its own name
  });
});

describe("ask-around clue routing (Clues c)", () => {
  const identityOpts: ProjectionOpts = {
    symbolOf: (id) => id,
    symbolOfCreature: (id) => id,
  };

  it("the wanter doesn't know; the next giver holds the clue to the supplier", () => {
    const game = buildCreatureQuestWorld({
      questCount: 2,
      complexity: "request",
      clueRouting: "askAround",
      rng: mulberry32(7),
    });
    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const routed = [...nodeByCreature].filter(([, n]) => n.needLocationKnown === false);
    expect(routed.length).toBeGreaterThan(0);

    for (const [wanterId, node] of routed) {
      const itemId = node.needItemEntityId!;
      const holder = world.items[itemId]!.ownerId!;
      // The wanter has no location fact → where-is on it says "don't know".
      expect(world.creatures[wanterId]!.knowledge[itemId]).toBeUndefined();
      const ask: DialogueAct = { kind: "where-is", itemId, glyph: "" };
      const noClue = selectAct(world, wanterId, PLAYER_CREATURE_ID, ask, "b", identityOpts);
      expect(noClue.responseGlyph).toBe("i_me + think.not");

      // A knower was seeded (another quest's giver) and names the holder.
      const knowerEntry = [...nodeByCreature].find(([, n]) => n.knowsItemEntityIds?.includes(itemId));
      expect(knowerEntry).toBeDefined();
      const [knowerId] = knowerEntry!;
      expect(knowerId).not.toBe(wanterId);
      const clue = selectAct(world, knowerId, PLAYER_CREATURE_ID, ask, "b", identityOpts);
      expect(clue.responseGlyph).toBe(`${holder} + have + ${itemId}`);

      // The knower has its OWN need (state 1), yet its board still offers the
      // heard-want where-is — information requests aren't gated on MY need.
      const proj = projectDialogue(world, knowerId, PLAYER_CREATURE_ID, "b", {
        ...identityOpts,
        askableWhere: [itemId],
      });
      expect(proj.acts.some((a) => a.kind === "where-is" && a.itemId === itemId)).toBe(true);
    }
  });

  it("degenerate one-quest world: the supplier itself answers 'I have it'", () => {
    const game = buildCreatureQuestWorld({
      questCount: 1,
      complexity: "request",
      clueRouting: "askAround",
      rng: mulberry32(13),
    });
    expect(certifyCreatureQuestWorld(game).ok).toBe(true);
    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [wanterId, node] = [...nodeByCreature].find(([, n]) => n.needLocationKnown === false)!;
    const itemId = node.needItemEntityId!;
    const holder = world.items[itemId]!.ownerId!;
    const ask: DialogueAct = { kind: "where-is", itemId, glyph: "" };
    expect(selectAct(world, wanterId, PLAYER_CREATURE_ID, ask, "b", identityOpts).responseGlyph).toBe("i_me + think.not");
    // The holder's self-knowledge completes the chain, phrased in first person.
    expect(selectAct(world, holder, PLAYER_CREATURE_ID, ask, "b", identityOpts).responseGlyph).toBe(`have + ${itemId}`);
  });

  it("a creature that knows the PLAYER holds an item says so", () => {
    const game = buildCreatureQuestWorld({ questCount: 1, complexity: "simple", rng: mulberry32(21) });
    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [giverId, node] = [...nodeByCreature].find(([, n]) => n.needItemEntityId)!;
    const itemId = node.needItemEntityId!;
    // Player picks the loose item up in front of the giver (sight writes it).
    world.items[itemId]!.ownerId = PLAYER_CREATURE_ID;
    world.creatures[giverId]!.knowledge[itemId] = { kind: "held", by: PLAYER_CREATURE_ID };
    const ask: DialogueAct = { kind: "where-is", itemId, glyph: "" };
    expect(selectAct(world, giverId, PLAYER_CREATURE_ID, ask, "b", identityOpts).responseGlyph).toBe(`you + have + ${itemId}`);
  });
});

describe("fulfill node runtime behavior", () => {
  it("content creatures complete at start; needy ones on the fulfill-need input", () => {
    const game = buildCreatureQuestWorld({ questCount: 1, complexity: "request", rng: mulberry32(3) });
    const cert = certifyGoalTreeGame(game);
    if (!cert.ok) throw new Error(cert.errors.join("; "));
    const ctx = createRuntimeContext(game, cert.world);
    let state = createRuntimeState();

    const fulfills = [...walkGoalTree(game.root)]
      .map((v) => v.node)
      .filter((n) => n.type === "fulfill");
    const giver = fulfills.find((n) => n.type === "fulfill" && n.needItemEntityId)!;
    const vendor = fulfills.find((n) => n.type === "fulfill" && !n.needItemEntityId)!;

    // Start: the needless vendor is instantly content; the giver still gates.
    state = applyRuntimeInput(ctx, state, { type: "start" }).state;
    expect(state.completed[vendor.id]).toBe(true);
    expect(state.completed[giver.id]).toBeUndefined();

    // The creature sim reports the need fulfilled → the gate clears.
    const res = applyRuntimeInput(ctx, state, { type: "fulfill-need", nodeId: giver.id });
    expect(res.state.completed[giver.id]).toBe(true);
    expect(res.events.some((e) => e.type === "goal-completed" && e.nodeId === giver.id)).toBe(true);
  });

  it("derives the same creature world the certifier used (determinism)", () => {
    const game = buildCreatureQuestWorld({ questCount: 2, complexity: "mixed", rng: mulberry32(5) });
    const a = creatureWorldFromGame(game);
    const b = creatureWorldFromGame(game);
    expect(JSON.parse(JSON.stringify(a.world))).toEqual(JSON.parse(JSON.stringify(b.world)));
    // The player + one creature per fulfill node.
    const fulfillCount = [...walkGoalTree(game.root)].filter((v) => v.node.type === "fulfill").length;
    expect(Object.keys(a.world.creatures)).toHaveLength(fulfillCount + 1);
  });

  it("clue-chain guarantee: a not-knowing wanter with a LOOSE item fails certification", () => {
    // Simple quest: the item is loose in the giver's room, so nobody's
    // knowledge covers it once the always-know rule is switched off.
    const game = buildCreatureQuestWorld({ questCount: 1, complexity: "simple", rng: mulberry32(4) });
    const giver = [...walkGoalTree(game.root)]
      .map((v) => v.node)
      .find((n) => n.type === "fulfill" && n.needItemEntityId);
    if (giver?.type !== "fulfill") throw new Error("no giver");
    giver.needLocationKnown = false;
    const cert = certifyCreatureQuestWorld(game);
    expect(cert.ok).toBe(false);
    if (!cert.ok) expect(cert.errors.join(" ")).toContain("where-is");
  });

  it("rejects a game placing the same item in two creatures' rooms", () => {
    const game = buildCreatureQuestWorld({ questCount: 1, complexity: "simple", rng: mulberry32(2) });
    const fulfill = [...walkGoalTree(game.root)]
      .map((v) => v.node)
      .find((n) => n.type === "fulfill")!;
    if (fulfill.type !== "fulfill") throw new Error("unreachable");
    // Duplicate the giver with the same prop item under a second gate.
    const clone = { ...fulfill, id: "dupe", npcEntityId: fulfill.npcEntityId };
    if (game.root.type === "reach") {
      game.root.via!.push({
        type: "overcome",
        id: "dupe_ov",
        obstacleEntityId: game.root.via![0]!.obstacleEntityId,
        key: clone,
      });
    }
    const cert = certifyGoalTreeGame(game);
    expect(cert.ok).toBe(false);
    if (!cert.ok) expect(cert.errors.join(" ")).toContain("more than one fulfill node");
  });
});

describe("v1 causal WHY channel (causation-and-elements.md §4)", () => {
  // Strip every fulfill node's causalFact — the invariance control.
  const stripCausal = (game: GoalTreeGame): GoalTreeGame => {
    const clone: GoalTreeGame = JSON.parse(JSON.stringify(game));
    for (const { node } of walkGoalTree(clone.root)) {
      if (node.type === "fulfill") delete (node as FulfillNode).causalFact;
    }
    return clone;
  };
  const givers = (game: GoalTreeGame): FulfillNode[] =>
    [...walkGoalTree(game.root)]
      .map((w) => w.node)
      .filter((n): n is FulfillNode => n.type === "fulfill" && !!n.needItemEntityId);

  for (const syntax of SYNTAXES) {
    it(`certifies + is invariant to the fact, and the WHY answer reads correctly: syntax=${syntax}`, () => {
      const game = buildCreatureQuestWorld({
        questCount: 2,
        syntax,
        complexity: "simple",
        giverCausalWhy: true,
        rng: mulberry32(909 + syntax.charCodeAt(0)),
      });
      // A `because` fact was actually attached to the possession-need giver(s).
      expect(givers(game).some((g) => g.causalFact?.connective === "because")).toBe(true);

      // Certification is INVARIANT to causal facts (they gate nothing).
      expect(certifyCreatureQuestWorld(game).ok).toBe(true);
      expect(certifyCreatureQuestWorld(stripCausal(game)).ok).toBe(true);

      const giver = givers(game).find((g) => g.causalFact)!;
      const { world } = creatureWorldFromGame(game);
      const { world: worldNo } = creatureWorldFromGame(stripCausal(game));
      const symbolOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? id;
      const opts: ProjectionOpts = { symbolOf };

      // Projection: stripping removes ONLY the why act; line + other acts identical.
      const p = projectDialogue(world, giver.id, PLAYER_CREATURE_ID, syntax, opts);
      const pNo = projectDialogue(worldNo, giver.id, PLAYER_CREATURE_ID, syntax, opts);
      expect(p.lineGlyph).toBe(pNo.lineGlyph);
      expect(p.acts.some((a) => a.kind === "why")).toBe(true);
      expect(pNo.acts.some((a) => a.kind === "why")).toBe(false);
      expect(p.acts.filter((a) => a.kind !== "why").map((a) => a.kind)).toEqual(
        pNo.acts.map((a) => a.kind),
      );

      // The WHY answer is the two-clause causal line; no world effect, no close.
      const why = p.acts.find((a) => a.kind === "why")!;
      const res = selectAct(world, giver.id, PLAYER_CREATURE_ID, why, syntax, opts);
      const item = symbolOf(giver.needItemEntityId!);
      const expected = {
        a: item,
        b: `because + have.not + ${item}`,
        c: `i_me + sad + because + i_me + have.not + ${item}`,
      }[syntax];
      expect(res.responseGlyph).toBe(expected);
      expect(res.events).toEqual([]);
      expect(res.close).toBeFalsy();
    });
  }

  it("placement / on-behalf / transformed needs get NO fact in v1", () => {
    for (const params of [
      { task: "place" as const },
      { task: "deliver" as const },
      { transformations: true },
    ]) {
      const game = buildCreatureQuestWorld({
        questCount: 1,
        complexity: "simple",
        giverCausalWhy: true,
        rng: mulberry32(55),
        ...params,
      });
      expect(givers(game).every((g) => !g.causalFact)).toBe(true);
    }
  });
});

describe("composeNeed causal-frame compatibility table (§2)", () => {
  it("because-lack-item fits only a plain possession need", () => {
    expect(causalFrameCompatible("because-lack-item", {})).toBe(true);
    expect(causalFrameCompatible("because-lack-item", { needPlacedInEntityId: "box" })).toBe(false);
    expect(causalFrameCompatible("because-lack-item", { needItemState: "hot" })).toBe(false);
    expect(causalFrameCompatible("because-lack-item", { needForNodeId: "recip" })).toBe(false);
    expect(causalFrameCompatible("because-lack-item", { announce: "never" })).toBe(false);
  });

  it("in-order-to-recipient-happy fits only an on-behalf (deliver) need", () => {
    expect(causalFrameCompatible("in-order-to-recipient-happy", { needForNodeId: "recip" })).toBe(true);
    expect(causalFrameCompatible("in-order-to-recipient-happy", {})).toBe(false);
  });

  it("the generator never emits an incompatible frame (whole grid still certifies)", () => {
    // composeNeed throws on an incompatible frame; that no build in the grid
    // throws is the standing guarantee — spot-check the frame-bearing configs.
    for (const cfg of [
      { giverCausalWhy: true, complexity: "simple" as const },
      { deliverCausalPurpose: true, task: "deliver" as const, complexity: "simple" as const },
      { giverCausalWhy: true, task: "deliver" as const, complexity: "simple" as const }, // because SKIPPED on deliver
      { giverCausalWhy: true, descriptors: true, transformations: true, complexity: "request" as const },
    ]) {
      expect(() =>
        buildCreatureQuestWorld({ questCount: 2, rng: mulberry32(31), ...cfg }),
      ).not.toThrow();
    }
  });
});

describe("v2 causal in_order_to purpose (deliver needs, §4.3)", () => {
  const stripCausal = (game: GoalTreeGame): GoalTreeGame => {
    const clone: GoalTreeGame = JSON.parse(JSON.stringify(game));
    for (const { node } of walkGoalTree(clone.root)) {
      if (node.type === "fulfill") delete (node as FulfillNode).causalFact;
    }
    return clone;
  };

  it("the giver's LINE states remedy AND goal, stacks, and cert is invariant", () => {
    const game = buildCreatureQuestWorld({
      questCount: 1,
      complexity: "simple",
      task: "deliver",
      deliverCausalPurpose: true,
      rng: mulberry32(4242),
    });
    // Certification passes and is invariant to the (narration-only) fact.
    expect(certifyCreatureQuestWorld(game).ok).toBe(true);
    expect(certifyCreatureQuestWorld(stripCausal(game)).ok).toBe(true);

    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [giverId, giverNode] = [...nodeByCreature].find(([, n]) => n.needForNodeId)!;
    const recipId = giverNode.needForNodeId!;
    expect(giverNode.causalFact?.connective).toBe("in_order_to");

    const symbolOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? id;
    const opts: ProjectionOpts = { symbolOf, symbolOfCreature: (cid) => cid };
    const itemSym = symbolOf(giverNode.needItemEntityId!);

    // The full sentence carries the action clause AND the goal clause.
    const lineC = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "c", opts).lineGlyph;
    expect(lineC).toBe(`give + ${itemSym} + to + ${recipId} + in_order_to + ${recipId} + happy`);

    // Stripping the fact leaves the plain deliver line.
    const { world: worldNo } = creatureWorldFromGame(stripCausal(game));
    expect(projectDialogue(worldNo, giverId, PLAYER_CREATURE_ID, "c", opts).lineGlyph).toBe(
      `give + ${itemSym} + to + ${recipId}`,
    );
  });
});

describe("step 4a creature-state needs (§5)", () => {
  it("a cold MOTIVE generates a 'something hot' want: 'want hot because cold', certifies", () => {
    const game = buildCreatureQuestWorld({
      questCount: 1,
      complexity: "simple",
      giverCondition: "cold",
      rng: mulberry32(808),
    });
    expect(certifyCreatureQuestWorld(game).ok).toBe(true);

    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [giverId, node] = [...nodeByCreature].find(([, n]) => n.condition)!;
    expect(node.condition).toBe("cold");
    // The motive GENERATED a kind-less target + forced a fire station; the item
    // spawns cold (heatable), so any HOT thing satisfies it.
    expect(node.needTarget).toEqual({ state: "hot" });
    expect(node.stationKinds).toEqual(["fire"]);
    expect(world.items[node.needItemEntityId!]!.states).toEqual(["cold"]);

    const symbolOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? id;
    const proj = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "c", { symbolOf });
    // Default reveal = "want": the OPENING states the want ("something hot"); the
    // causal link is the WHY answer, NOT an unprompted greeting.
    expect(proj.lineGlyph).toBe("i_me + want + hot");
    expect(proj.acts.some((a) => a.kind === "why")).toBe(true);
  });

  it("revelation: the OPENING is the want or the motive; WHY carries the link", () => {
    const build = (reveal: "want" | "motive") => {
      const game = buildCreatureQuestWorld({
        questCount: 1,
        complexity: "simple",
        giverCondition: "cold",
        giverReveal: reveal,
        rng: mulberry32(811),
      });
      const { world, nodeByCreature } = creatureWorldFromGame(game);
      const [giverId] = [...nodeByCreature].find(([, n]) => n.condition)!;
      const symbolOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? id;
      return { world, giverId, opts: { symbolOf } as ProjectionOpts };
    };
    // "want" — opening states the want; WHY answers "I want hot because I'm cold".
    {
      const { world, giverId, opts } = build("want");
      const proj = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "c", opts);
      expect(proj.lineGlyph).toBe("i_me + want + hot");
      const why = proj.acts.find((a) => a.kind === "why")!;
      expect(why).toBeDefined();
      expect(selectAct(world, giverId, PLAYER_CREATURE_ID, why, "c", opts).responseGlyph).toBe(
        "i_me + want + hot + because + i_me + cold",
      );
    }
    // "motive" — just the plight; the player infers the want (no unprompted WHY).
    {
      const { world, giverId, opts } = build("motive");
      const proj = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "c", opts);
      expect(proj.lineGlyph).toBe("i_me + cold");
      expect(proj.acts.some((a) => a.kind === "why")).toBe(false);
      // Its acts are still the WANT acts — "where is / I don't have SOMETHING HOT".
      expect(proj.acts.some((a) => a.kind === "where-is" && a.glyph.includes("hot"))).toBe(true);
    }
  });

  it("heating the item makes it match 'something hot'; giving it clears the cold", () => {
    const game = buildCreatureQuestWorld({
      questCount: 1,
      complexity: "simple",
      giverCondition: "cold",
      rng: mulberry32(808),
    });
    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [giverId, node] = [...nodeByCreature].find(([, n]) => n.condition)!;
    const itemId = node.needItemEntityId!;
    // The player takes the cold item, heats it at the fire station, gives it.
    world.items[itemId]!.ownerId = PLAYER_CREATURE_ID;
    // A cold item does NOT yet satisfy "something hot".
    expect(giveItem(world, PLAYER_CREATURE_ID, giverId, itemId).accepted).toBe(false);
    applyTransform(world, itemId, "hot", "cold");
    const res = giveItem(world, PLAYER_CREATURE_ID, giverId, itemId);
    expect(res.accepted).toBe(true);
    expect(openNeeds(world.creatures[giverId]!)).toHaveLength(0);
    expect(world.creatures[giverId]!.condition).toBeUndefined(); // getting better
  });

  it("decoupled: the want is 'something hot'; a KNOWN COLD item doesn't answer where-is", () => {
    // A cold creature wants something hot. It knows where a cold apple is (its
    // own remedy item) — but a cold apple does NOT answer "where is something
    // hot". The dialogue is driven by the TARGET + knowledge, not the item id.
    const world = createCreatureWorld(
      [
        { id: "a", condition: "cold", needs: [{ itemId: "apple", value: 3, target: { state: "hot" } }] },
        { id: PLAYER_CREATURE_ID },
      ],
      [{ id: "apple", kind: "apple", states: ["cold"] }],
    );
    world.creatures.a!.knowledge.apple = { kind: "loose" };
    const opts: ProjectionOpts = { symbolOf: (id) => id, placeOf: () => "home.color_blue" };

    const proj = projectDialogue(world, "a", PLAYER_CREATURE_ID, "c", opts);
    const whereIs = proj.acts.find((act) => act.kind === "where-is")!;
    const cant = proj.acts.find((act) => act.kind === "cant")!;
    // The acts NAME the want ("something hot"), never the designated apple.
    expect(whereIs.glyph).toContain("hot");
    expect(whereIs.glyph).not.toContain("apple");
    expect(cant.glyph).toContain("hot");
    // Where-is: it does NOT know where something hot is (the apple is cold).
    expect(selectAct(world, "a", PLAYER_CREATURE_ID, whereIs, "c", opts).responseGlyph).toBe(
      "i_me + think.not",
    );
    // Heat the apple → now the SAME known item matches → it answers.
    world.items.apple!.states = ["hot"];
    const whereIs2 = projectDialogue(world, "a", PLAYER_CREATURE_ID, "c", opts).acts.find(
      (act) => act.kind === "where-is",
    )!;
    expect(selectAct(world, "a", PLAYER_CREATURE_ID, whereIs2, "c", opts).responseGlyph).toContain(
      "apple.hot",
    );
  });

  it("fulfilling the remedy CLEARS the condition (getting-better demonstration)", () => {
    const world = createCreatureWorld(
      [
        { id: "a", condition: "cold", needs: [{ itemId: "soup", value: 3 }] },
        { id: PLAYER_CREATURE_ID },
      ],
      [{ id: "soup", ownerId: PLAYER_CREATURE_ID }],
    );
    expect(world.creatures.a!.condition).toBe("cold");
    const res = giveItem(world, PLAYER_CREATURE_ID, "a", "soup");
    expect(res.accepted).toBe(true);
    expect(world.creatures.a!.condition).toBeUndefined();
    expect(res.events).toContainEqual({ type: "condition-changed", creatureId: "a", from: "cold", to: "warm" });
  });
});

describe("step 4b device-state needs (§5)", () => {
  it("a device quest: certifies, line 'want {device} closed', WHY reveals the open cause", () => {
    const game = buildCreatureQuestWorld({
      questCount: 1,
      complexity: "simple",
      giverDeviceNeed: "closed",
      rng: mulberry32(414),
    });
    expect(certifyCreatureQuestWorld(game).ok).toBe(true);

    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [giverId, node] = [...nodeByCreature].find(([, n]) => n.needDeviceState)!;
    expect(node.needDeviceState).toBe("closed");

    const symbolOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? id;
    const device = symbolOf(node.needItemEntityId!).split(".")[0]; // base symbol
    // The device spawned in the OPPOSITE (bad) state.
    expect(world.items[node.needItemEntityId!]!.states).toEqual(["open"]);
    expect(world.items[node.needItemEntityId!]!.device).toBe(true);

    const opts: ProjectionOpts = { symbolOf };
    const proj = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "c", opts);
    expect(proj.lineGlyph).toBe(`i_me + want + ${device} + closed`);

    // WHY reveals the device's bad state as the cause.
    const why = proj.acts.find((a) => a.kind === "why")!;
    expect(why).toBeDefined();
    const res = selectAct(world, giverId, PLAYER_CREATURE_ID, why, "c", opts);
    expect(res.responseGlyph).toBe(`i_me + sad + because + ${device} + open`);
  });

  it("toggling the device fulfills the need and clears a linked condition (P2)", () => {
    const world = createCreatureWorld(
      [
        { id: "a", condition: "cold", needs: [{ itemId: "window", value: 3, deviceState: "closed" }] },
        { id: PLAYER_CREATURE_ID },
      ],
      [{ id: "window", device: true, states: ["open"] }],
    );
    expect(openNeeds(world.creatures.a!)).toHaveLength(1);

    const events = toggleDevice(world, PLAYER_CREATURE_ID, "window", "closed");
    expect(world.items.window!.states).toEqual(["closed"]);
    expect(openNeeds(world.creatures.a!)).toHaveLength(0);
    expect(world.creatures.a!.condition).toBeUndefined();
    expect(events).toContainEqual({ type: "condition-changed", creatureId: "a", from: "cold", to: "warm" });
    // The actor earned the debt (a state need, like placement).
    expect(world.creatures.a!.debts[PLAYER_CREATURE_ID]).toBe(3);
  });

  it("a device is never picked up as a loose prop by the certifier", () => {
    // The P2 combo (cold creature + open window) also certifies.
    const game = buildCreatureQuestWorld({
      questCount: 1,
      complexity: "simple",
      giverDeviceNeed: "closed",
      giverCondition: "cold",
      rng: mulberry32(415),
    });
    expect(certifyCreatureQuestWorld(game).ok).toBe(true);
    const { nodeByCreature } = creatureWorldFromGame(game);
    const node = [...nodeByCreature.values()].find((n) => n.needDeviceState)!;
    expect(node.condition).toBe("cold");
  });
});

describe("step 4b power chains — generators activated by switches (§5)", () => {
  it("a device won't activate without power; powerUp switches the generator on first", () => {
    const world = createCreatureWorld(
      [
        { id: "a", needs: [{ itemId: "fridge", value: 3, deviceState: "on" }] },
        { id: PLAYER_CREATURE_ID },
      ],
      [
        { id: "fridge", device: true, states: ["off"], poweredBy: { deviceId: "gen", state: "on" } },
        { id: "gen", device: true, states: ["off"] },
      ],
    );
    // No power → the toggle is a no-op.
    toggleDevice(world, PLAYER_CREATURE_ID, "fridge", "on");
    expect(world.items.fridge!.states).toEqual(["off"]);
    expect(openNeeds(world.creatures.a!)).toHaveLength(1);

    // Power the chain (switch on the generator), then the device toggles.
    powerUp(world, PLAYER_CREATURE_ID, "fridge");
    expect(world.items.gen!.states).toEqual(["on"]);
    toggleDevice(world, PLAYER_CREATURE_ID, "fridge", "on");
    expect(world.items.fridge!.states).toEqual(["on"]);
    expect(openNeeds(world.creatures.a!)).toHaveLength(0);
  });

  it("powerUp resolves a DEEP chain (switch → generator → device), deepest first", () => {
    const world = createCreatureWorld(
      [{ id: "a", needs: [{ itemId: "fridge", value: 3, deviceState: "on" }] }, { id: PLAYER_CREATURE_ID }],
      [
        { id: "fridge", device: true, states: ["off"], poweredBy: { deviceId: "gen", state: "on" } },
        { id: "gen", device: true, states: ["off"], poweredBy: { deviceId: "sw", state: "on" } },
        { id: "sw", device: true, states: ["off"] },
      ],
    );
    powerUp(world, PLAYER_CREATURE_ID, "fridge");
    expect(world.items.sw!.states).toEqual(["on"]);
    expect(world.items.gen!.states).toEqual(["on"]);
    expect(toggleDevice(world, PLAYER_CREATURE_ID, "fridge", "on").length).toBeGreaterThan(0);
    expect(world.items.fridge!.states).toEqual(["on"]);
  });

  it("a powered device quest certifies and WHY reveals the generator to switch on", () => {
    const game = buildCreatureQuestWorld({
      questCount: 1,
      complexity: "simple",
      giverDeviceNeed: "on",
      giverDevicePowered: true,
      rng: mulberry32(416),
    });
    expect(certifyCreatureQuestWorld(game).ok).toBe(true);

    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [giverId, node] = [...nodeByCreature].find(([, n]) => n.needDeviceState)!;
    const gen = node.powerDeviceEntityId!;
    expect(gen).toBeDefined();
    // The device is poweredBy the generator; the generator starts OFF.
    expect(world.items[node.needItemEntityId!]!.poweredBy).toEqual({ deviceId: gen, state: "on" });
    expect(world.items[gen]!.device).toBe(true);
    expect(world.items[gen]!.states).toEqual(["off"]);

    const symbolOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? id;
    const genSym = symbolOf(gen).split(".")[0];
    const opts: ProjectionOpts = { symbolOf };
    const why = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "c", opts).acts.find((a) => a.kind === "why")!;
    const res = selectAct(world, giverId, PLAYER_CREATURE_ID, why, "c", opts);
    expect(res.responseGlyph).toBe(`i_me + sad + because + ${genSym} + off`);
  });
});

describe("P1 powered stations — a fridge that only cools when switched on (§5)", () => {
  it("useStation is a REAL gate: no power → no transform; powered → it cools", () => {
    const world = createCreatureWorld(
      [{ id: PLAYER_CREATURE_ID }],
      [
        { id: "apple", states: ["hot"] },
        { id: "fridge", device: true, states: ["off"] },
      ],
    );
    // Unpowered station is dead — the drop does nothing.
    expect(useStation(world, "apple", "cold", "hot", "fridge")).toEqual([]);
    expect(world.items.apple!.states).toEqual(["hot"]);

    // Switch the fridge on, and now it cools.
    toggleDevice(world, PLAYER_CREATURE_ID, "fridge", "on");
    expect(useStation(world, "apple", "cold", "hot", "fridge").length).toBeGreaterThan(0);
    expect(world.items.apple!.states).toEqual(["cold"]);
  });

  it("a powered-station quest certifies; WHY reveals the generator to switch on", () => {
    const game = buildCreatureQuestWorld({
      questCount: 1,
      complexity: "simple",
      transformations: true,
      giverStationPowered: true,
      rng: mulberry32(517),
    });
    expect(certifyCreatureQuestWorld(game).ok).toBe(true);

    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [giverId, node] = [...nodeByCreature].find(([, n]) => n.stationPowerDeviceId)!;
    const gen = node.stationPowerDeviceId!;
    expect(world.items[gen]!.device).toBe(true);
    expect(world.items[gen]!.states).toEqual(["off"]);

    const symbolOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? id;
    const genSym = symbolOf(gen).split(".")[0];
    const opts: ProjectionOpts = { symbolOf };
    const why = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "c", opts).acts.find((a) => a.kind === "why")!;
    const res = selectAct(world, giverId, PLAYER_CREATURE_ID, why, "c", opts);
    expect(res.responseGlyph).toBe(`i_me + sad + because + ${genSym} + off`);
  });

  it("the power step is NECESSARY: a hand-built world can't cool without switching on", () => {
    // If the certifier skipped powering the station, the transform would no-op
    // and the need would never fulfill — this asserts that dependency directly.
    const world = createCreatureWorld(
      [
        { id: "a", needs: [{ itemId: "milk", value: 3, requiresState: "cold" }] },
        { id: PLAYER_CREATURE_ID },
      ],
      [
        { id: "milk", ownerId: PLAYER_CREATURE_ID, states: ["hot"] },
        { id: "fridge", device: true, states: ["off"] },
      ],
    );
    useStation(world, "milk", "cold", "hot", "fridge"); // unpowered — no-op
    expect(giveItem(world, PLAYER_CREATURE_ID, "a", "milk").accepted).toBe(false); // still hot → declined
    powerUp(world, PLAYER_CREATURE_ID, "fridge");
    toggleDevice(world, PLAYER_CREATURE_ID, "fridge", "on");
    useStation(world, "milk", "cold", "hot", "fridge");
    expect(giveItem(world, PLAYER_CREATURE_ID, "a", "milk").accepted).toBe(true); // cold now → accepted
  });
});

describe("parameter-based needs — loose matching + reversible gifts (motive-driven-needs.md)", () => {
  it("a TARGET need matches ANY item that fits (loose), not one instance", () => {
    const world = createCreatureWorld(
      [
        { id: "a", needs: [{ itemId: "apple1", value: 3, target: { state: "hot" } }] },
        { id: PLAYER_CREATURE_ID },
      ],
      [
        { id: "apple1", kind: "apple", states: [] }, // the intended instance, still cold
        { id: "cookie1", ownerId: PLAYER_CREATURE_ID, kind: "cookie", states: ["hot"] }, // a DIFFERENT hot thing
      ],
    );
    // "Something hot" — the hot cookie satisfies it even though it isn't apple1.
    expect(giveItem(world, PLAYER_CREATURE_ID, "a", "cookie1").accepted).toBe(true);
    expect(openNeeds(world.creatures.a!)).toHaveLength(0);
  });

  it("reversible gift: a fulfilled creature swaps its bound item for an equivalent (the red-apple puzzle)", () => {
    const world = createCreatureWorld(
      [
        { id: "red", needs: [{ itemId: "apple", value: 3, target: { descriptors: ["color_red"] } }] },
        { id: "food", needs: [{ itemId: "banana", value: 3, target: { category: "food" } }] },
        { id: PLAYER_CREATURE_ID },
      ],
      [
        { id: "apple", ownerId: PLAYER_CREATURE_ID, kind: "apple", category: "food", descriptors: ["color_red"] },
        { id: "banana", ownerId: PLAYER_CREATURE_ID, kind: "banana", category: "food", descriptors: ["color_yellow"] },
      ],
    );
    // Mis-assign: give the red apple to the FOOD creature (valid — it IS food).
    expect(giveItem(world, PLAYER_CREATURE_ID, "food", "apple").accepted).toBe(true);
    // RED is now stranded (the only red thing is bound). Offering food the banana
    // (equal — also food) SWAPS: banana binds, the apple comes back to the player.
    expect(giveItem(world, PLAYER_CREATURE_ID, "food", "banana").accepted).toBe(true);
    expect(world.items.banana!.ownerId).toBe("food");
    expect(world.items.banana!.bound).toBe(true);
    expect(world.items.apple!.ownerId).toBe(PLAYER_CREATURE_ID);
    expect(world.items.apple!.bound).toBe(false);
    expect(openNeeds(world.creatures.food!)).toHaveLength(0); // still satisfied (by banana)
    // The freed apple solves RED.
    expect(giveItem(world, PLAYER_CREATURE_ID, "red", "apple").accepted).toBe(true);
    expect(openNeeds(world.creatures.red!)).toHaveLength(0);
  });

  it("an exact-instance need (no target) never swaps — it wants its one item", () => {
    const world = createCreatureWorld(
      [{ id: "a", needs: [{ itemId: "apple1", value: 3 }] }, { id: PLAYER_CREATURE_ID }],
      [
        { id: "apple1", ownerId: PLAYER_CREATURE_ID, kind: "apple" },
        { id: "apple2", ownerId: PLAYER_CREATURE_ID, kind: "apple" },
      ],
    );
    expect(giveItem(world, PLAYER_CREATURE_ID, "a", "apple1").accepted).toBe(true);
    // Same kind, but the exact need wanted THAT instance — apple2 is declined.
    expect(giveItem(world, PLAYER_CREATURE_ID, "a", "apple2").accepted).toBe(false);
  });

  it("offer decline is PREDICATE-driven: names the OFFERED item's missing facet", () => {
    const symbolOf = (id: string) =>
      ({ coldapple: "apple", smallball: "ball.small", car: "car" })[id] ?? id;
    const opts: ProjectionOpts = { symbolOf };
    const offer = (id: string): DialogueAct => ({ kind: "offer", itemId: id, glyph: "" });

    // Wants "something hot" (kind-less STATE target): a cold apple → "not hot",
    // named from the OFFERED item, not any designated instance.
    const hotW = createCreatureWorld(
      [
        { id: "a", needs: [{ itemId: "x", value: 3, target: { state: "hot" } }] },
        { id: PLAYER_CREATURE_ID },
      ],
      [{ id: "coldapple", ownerId: PLAYER_CREATURE_ID, kind: "apple", states: ["cold"] }],
    );
    expect(
      selectAct(hotW, "a", PLAYER_CREATURE_ID, offer("coldapple"), "c", opts).responseGlyph,
    ).toBe("apple + hot.not");

    // Wants a BIG BALL: a small ball → "not big" (same kind, missing descriptor);
    // a car (wrong kind) → a plain "don't want", NOT a facet correction.
    const ballW = createCreatureWorld(
      [
        { id: "a", needs: [{ itemId: "x", value: 3, target: { kind: "ball", descriptors: ["big"] } }] },
        { id: PLAYER_CREATURE_ID },
      ],
      [
        { id: "smallball", ownerId: PLAYER_CREATURE_ID, kind: "ball", descriptors: ["small"] },
        { id: "car", ownerId: PLAYER_CREATURE_ID, kind: "car" },
      ],
    );
    expect(
      selectAct(ballW, "a", PLAYER_CREATURE_ID, offer("smallball"), "c", opts).responseGlyph,
    ).toBe("ball + big.not");
    expect(selectAct(ballW, "a", PLAYER_CREATURE_ID, offer("car"), "c", opts).responseGlyph).toBe(
      "i_me + want.not + car",
    );
  });
});

describe("step D — dimensions compose (motive-driven-needs.md obs. 1)", () => {
  const combos: CreatureWorldParams[] = [
    { giverCondition: "cold", complexity: "request" }, // motive obtained via a vendor
    { giverCondition: "cold", complexity: "exchange" }, // motive obtained via a trade
    { giverCondition: "cold", complexity: "lend" }, // motive obtained via a lender
    { giverCondition: "cold", needCount: 2 }, // motive + counting
    { giverCondition: "cold", descriptors: true }, // motive + a variant item
    { giverCausalWhy: true, descriptors: true }, // causal WHY + a variant
    { giverCausalWhy: true, complexity: "request" }, // causal WHY + a vendor
    { deliverCausalPurpose: true, task: "deliver", transformations: true }, // deliver + transform
    { deliverCausalPurpose: true, task: "deliver", complexity: "request" }, // deliver + vendor
  ];
  combos.forEach((cfg, i) => {
    it(`composes + certifies: ${JSON.stringify(cfg)}`, () => {
      const game = buildCreatureQuestWorld({ questCount: 1, rng: mulberry32(900 + i), ...cfg });
      const cert = certifyCreatureQuestWorld(game);
      expect(cert.ok ? [] : cert.errors).toEqual([]);
    });
  });
});

describe("step 4c places — go-to (presence) needs (§5)", () => {
  it("noteArrival fulfills the presence need and credits the player", () => {
    const world = createCreatureWorld(
      [
        { id: "a", needs: [{ itemId: "bear", value: 3, atPlace: "bear" }] },
        { id: PLAYER_CREATURE_ID },
      ],
      [],
    );
    expect(openNeeds(world.creatures.a!)).toHaveLength(1);
    const events = noteArrival(world, PLAYER_CREATURE_ID, "bear");
    expect(openNeeds(world.creatures.a!)).toHaveLength(0);
    expect(events).toContainEqual({ type: "need-fulfilled", creatureId: "a", itemId: "bear", value: 3 });
    expect(world.creatures.a!.debts[PLAYER_CREATURE_ID]).toBe(3);
  });

  it("a go-to quest: certifies, line 'you + go + to + {dest}', item-acts suppressed", () => {
    const game = buildCreatureQuestWorld({
      questCount: 1,
      complexity: "simple",
      giverGoToPlace: true,
      rng: mulberry32(618),
    });
    expect(certifyCreatureQuestWorld(game).ok).toBe(true);

    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [giverId, node] = [...nodeByCreature].find(([, n]) => n.needAtPlaceNodeId)!;
    const dest = node.needAtPlaceNodeId!;
    // The destination is a needless CONTENT creature (a place to visit).
    expect(nodeByCreature.get(dest)!.needItemEntityId).toBeUndefined();

    const symbolOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? id;
    const symbolOfCreature = (cid: string) => symbolOf(nodeByCreature.get(cid)?.npcEntityId ?? cid);
    const opts: ProjectionOpts = { symbolOf, symbolOfCreature };
    const destSym = symbolOfCreature(dest);

    const proj = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "c", opts);
    expect(proj.lineGlyph).toBe(`you + go + to + ${destSym}`);
    // No item-based acts on a presence need.
    expect(proj.acts.some((a) => a.kind === "where-is")).toBe(false);
    expect(proj.acts.some((a) => a.kind === "cant")).toBe(false);
    expect(proj.acts.some((a) => a.kind === "agree")).toBe(true);
  });

  it("the go-to giver is NOT content at start; the destination IS", () => {
    const game = buildCreatureQuestWorld({
      questCount: 1,
      complexity: "simple",
      giverGoToPlace: true,
      rng: mulberry32(619),
    });
    const cert = certifyGoalTreeGame(game);
    if (!cert.ok) throw new Error(cert.errors.join("; "));
    const ctx = createRuntimeContext(game, cert.world);
    let state = createRuntimeState();

    const { nodeByCreature } = creatureWorldFromGame(game);
    const giver = [...nodeByCreature.values()].find((n) => n.needAtPlaceNodeId)!;
    const dest = giver.needAtPlaceNodeId!;

    state = applyRuntimeInput(ctx, state, { type: "start" }).state;
    // The needless destination is instantly content; the go-to giver still gates.
    expect(state.completed[dest]).toBe(true);
    expect(state.completed[giver.id]).toBeUndefined();

    // Arriving at the destination reports the giver's need fulfilled.
    const res = applyRuntimeInput(ctx, state, { type: "fulfill-need", nodeId: giver.id });
    expect(res.state.completed[giver.id]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Motive batch (motive-driven-needs.md follow-ups): ten flavored quest shapes
// through ONE param — each must certify AND project sensible dialogue.
// ---------------------------------------------------------------------------

describe("motive batch — giverMotive presets", () => {
  const build = (giverMotive: Parameters<typeof buildCreatureQuestWorld>[0]["giverMotive"], seed = 909) => {
    const game = buildCreatureQuestWorld({
      questCount: 1,
      complexity: "simple",
      giverMotive,
      rng: mulberry32(seed),
    });
    const cert = certifyCreatureQuestWorld(game);
    expect(cert).toEqual({ ok: true });
    const derived = creatureWorldFromGame(game);
    const symbolOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? id;
    const opts: ProjectionOpts = {
      symbolOf,
      symbolOfCreature: (cid) => {
        const npc = derived.nodeByCreature.get(cid)?.npcEntityId;
        return (npc && game.entities.find((e) => e.id === npc)?.glyph) || "there";
      },
    };
    return { game, ...derived, opts };
  };
  const giverOf = (d: ReturnType<typeof build>) =>
    [...d.nodeByCreature].find(([id]) => id.endsWith("_giver"))!;

  it("hungry: condition → 'I want food'; WHY answers 'because I am hungry'", () => {
    const d = build("hungry");
    const [giverId, node] = giverOf(d);
    expect(node.condition).toBe("hungry");
    expect(node.needTarget).toEqual({ category: "food" });
    // The staged item IS food (drawn from the treat pool + categorized).
    expect(d.world.items[node.needItemEntityId!]!.category).toBe("food");
    const proj = projectDialogue(d.world, giverId, PLAYER_CREATURE_ID, "c", d.opts);
    expect(proj.lineGlyph).toBe("i_me + want + food");
    const why = proj.acts.find((a) => a.kind === "why")!;
    expect(selectAct(d.world, giverId, PLAYER_CREATURE_ID, why, "c", d.opts).responseGlyph).toBe(
      "i_me + want + food + because + i_me + hungry",
    );
    // Feeding it clears the hunger (getting-better demo).
    const itemId = node.needItemEntityId!;
    d.world.items[itemId]!.ownerId = PLAYER_CREATURE_ID;
    expect(giveItem(d.world, PLAYER_CREATURE_ID, giverId, itemId).accepted).toBe(true);
    expect(d.world.creatures[giverId]!.condition).toBeUndefined();
  });

  it("likes-item: exact want; WHY answers 'because I like {item}'", () => {
    const d = build("likes-item");
    const [giverId, node] = giverOf(d);
    const sym = d.opts.symbolOf(node.needItemEntityId!);
    const proj = projectDialogue(d.world, giverId, PLAYER_CREATURE_ID, "c", d.opts);
    expect(proj.lineGlyph).toBe(`i_me + want + ${sym}`);
    const why = proj.acts.find((a) => a.kind === "why")!;
    expect(selectAct(d.world, giverId, PLAYER_CREATURE_ID, why, "c", d.opts).responseGlyph).toBe(
      `i_me + want + ${sym} + because + i_me + like + ${sym}`,
    );
  });

  it("likes-color: 'something {color}' want; WHY answers 'because I like {color}'", () => {
    const d = build("likes-color");
    const [giverId, node] = giverOf(d);
    const color = node.needTarget!.descriptors![0]!;
    expect(color.startsWith("color_")).toBe(true);
    const proj = projectDialogue(d.world, giverId, PLAYER_CREATURE_ID, "c", d.opts);
    // The want is the QUALITY, never the designated item.
    expect(proj.lineGlyph).toBe(`i_me + want + ${color}`);
    const why = proj.acts.find((a) => a.kind === "why")!;
    expect(selectAct(d.world, giverId, PLAYER_CREATURE_ID, why, "c", d.opts).responseGlyph).toBe(
      `i_me + want + ${color} + because + i_me + like + ${color}`,
    );
    // The wrong-color variant is declined with the missing color.
    expect(d.world.items.q0_wrong).toBeDefined();
    d.world.items.q0_wrong!.ownerId = PLAYER_CREATURE_ID;
    const offer: DialogueAct = { kind: "offer", itemId: "q0_wrong", glyph: "x" };
    const res = selectAct(d.world, giverId, PLAYER_CREATURE_ID, offer, "c", d.opts);
    expect(res.responseGlyph).toContain(`${color}.not`);
  });

  it("play/music/read/wear: category want; WHY answers 'because I want to {verb}'", () => {
    const cases = [
      { motive: "play" as const, want: "toy", verb: "play" },
      { motive: "music" as const, want: "instrument", verb: "play" },
      { motive: "read" as const, want: "book", verb: "read" },
      { motive: "wear" as const, want: "clothing", verb: "wear" },
    ];
    for (const c of cases) {
      const d = build(c.motive);
      const [giverId] = giverOf(d);
      const proj = projectDialogue(d.world, giverId, PLAYER_CREATURE_ID, "c", d.opts);
      expect(proj.lineGlyph).toBe(`i_me + want + ${c.want}`);
      const why = proj.acts.find((a) => a.kind === "why")!;
      expect(selectAct(d.world, giverId, PLAYER_CREATURE_ID, why, "c", d.opts).responseGlyph).toBe(
        `i_me + want + ${c.want} + because + i_me + want + ${c.verb}`,
      );
    }
  });

  it("smelly: outdoor garbage placement; WHY answers 'sad because {item} smelly'", () => {
    const d = build("smelly");
    const [giverId, node] = giverOf(d);
    expect(node.needPlacedInEntityId).toBe("q0_dest");
    expect(node.needPlacedOutdoors).toBe(true);
    const itemId = node.needItemEntityId!;
    // The item spawns SMELLY (baked into its glyph + live states).
    expect(d.world.items[itemId]!.states).toContain("smelly");
    const sym = d.opts.symbolOf(itemId).split(".")[0]!;
    const proj = projectDialogue(d.world, giverId, PLAYER_CREATURE_ID, "c", d.opts);
    // DISPOSAL is a DISTINCT statement: it leads with `throw` (not `want`) and
    // names the item in its LIVE spoiled state (`cookie.smelly`) — so it never
    // looks like "put a toy in a box".
    expect(proj.lineGlyph).toBe(`you + throw + ${sym}.smelly + in + garbage`);
    const why = proj.acts.find((a) => a.kind === "why")!;
    expect(selectAct(d.world, giverId, PLAYER_CREATURE_ID, why, "c", d.opts).responseGlyph).toBe(
      `i_me + sad + because + ${sym} + smelly`,
    );
    // Dropping it in the garbage fulfills.
    d.world.items[itemId]!.ownerId = PLAYER_CREATURE_ID;
    const events = notePlacement(d.world, PLAYER_CREATURE_ID, itemId, "q0_dest");
    expect(events.some((e) => e.type === "need-fulfilled")).toBe(true);
  });

  it("lonely: 'stay with me' want; WHY answers 'stay because lonely'; dwell fulfills", () => {
    const d = build("lonely");
    const [giverId, node] = giverOf(d);
    expect(node.needStayWith).toBe(true);
    expect(node.condition).toBe("lonely");
    const proj = projectDialogue(d.world, giverId, PLAYER_CREATURE_ID, "c", d.opts);
    expect(proj.lineGlyph).toBe("you + stay + with + i_me");
    expect(proj.acts.some((a) => a.kind === "agree")).toBe(true);
    const why = proj.acts.find((a) => a.kind === "why")!;
    expect(selectAct(d.world, giverId, PLAYER_CREATURE_ID, why, "c", d.opts).responseGlyph).toBe(
      "you + stay + with + i_me + because + i_me + lonely",
    );
    // The world layer times the dwell, then reports arrival at the creature
    // itself — the need fulfills and the loneliness clears.
    const events = noteArrival(d.world, PLAYER_CREATURE_ID, giverId);
    expect(events.some((e) => e.type === "need-fulfilled")).toBe(true);
    expect(d.world.creatures[giverId]!.condition).toBeUndefined();
  });

  it("lonely at reveal 'motive': the OPENING is just 'I am lonely'", () => {
    const game = buildCreatureQuestWorld({
      questCount: 1,
      complexity: "simple",
      giverMotive: "lonely",
      giverReveal: "motive",
      rng: mulberry32(910),
    });
    const { world, nodeByCreature } = creatureWorldFromGame(game);
    const [giverId] = [...nodeByCreature].find(([id]) => id.endsWith("_giver"))!;
    const symbolOf = (id: string) => game.entities.find((e) => e.id === id)?.glyph ?? id;
    const proj = projectDialogue(world, giverId, PLAYER_CREATURE_ID, "c", { symbolOf });
    expect(proj.lineGlyph).toBe("i_me + lonely");
    expect(proj.acts.some((a) => a.kind === "why")).toBe(false);
  });

  it("escort: 'take me to {dest}'; the GIVER arriving fulfills", () => {
    const d = build("escort");
    const [giverId, node] = giverOf(d);
    expect(node.needEscort).toBe(true);
    const destId = node.needAtPlaceNodeId!;
    const destSym = d.opts.symbolOfCreature!(destId);
    const proj = projectDialogue(d.world, giverId, PLAYER_CREATURE_ID, "c", d.opts);
    expect(proj.lineGlyph).toBe(`you + take + i_me + to + ${destSym}`);
    expect(proj.acts.some((a) => a.kind === "agree")).toBe(true);
    // The world layer walks the giver there, then reports arrival.
    const events = noteArrival(d.world, PLAYER_CREATURE_ID, destId);
    expect(events.some((e) => e.type === "need-fulfilled" && e.creatureId === giverId)).toBe(true);
  });

  it("every motive preset certifies across seeds", () => {
    const motives = [
      "hungry", "likes-item", "likes-color", "play", "music", "read", "wear", "smelly", "lonely", "escort",
    ] as const;
    for (const motive of motives) {
      for (const seed of [11, 222, 3333]) {
        const game = buildCreatureQuestWorld({
          questCount: 2,
          complexity: "simple",
          giverMotive: motive,
          rng: mulberry32(seed),
        });
        const cert = certifyCreatureQuestWorld(game);
        expect(cert).toEqual({ ok: true });
      }
    }
  });
});
