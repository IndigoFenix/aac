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
import { applyRuntimeInput, createRuntimeContext, createRuntimeState } from "@shared/goal-tree/runtime.js";
import { certifyGoalTreeGame } from "@shared/goal-tree/index.js";
import {
  applyTransform,
  buildCreatureQuestWorld,
  certifyCreatureQuestWorld,
  claimItem,
  concludeTransfer,
  createCreatureWorld,
  creatureWorldFromGame,
  giveItem,
  notePlacement,
  openNeeds,
  projectDialogue,
  requestItem,
  seeItem,
  selectAct,
  settleObligations,
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
