// Tests for the goal-tree quest-game memory schema + starter template.
//
//  - createEmptyQuestGame() must produce a game that CERTIFIES (so createQuestGame
//    can persist it without a pipeline).
//  - The QUEST_GAME_MEMORY_FIELD schema must DECLARE the full goal-tree shape
//    (recursively). The memory renderer only shows schema-declared keys, so a
//    fully-declared schema is the core fix: the old loose schema
//    (properties: {}) rendered nothing inside meta/root/entities and the AI
//    edited blind. We assert the declaration here (not the renderer — importing
//    memory-system pulls in import.meta.url, which Jest's CJS transform breaks).
//
// Pure-logic, no DB / no LLM.

import { describe, it, expect } from "@jest/globals";
import { certifyGoalTreeGame } from "@shared/goal-tree/index";
import {
  QUEST_GAME_MEMORY_FIELD,
  createEmptyQuestGame,
  normalizeContentPack,
} from "../services/memory-schema/quest-game-schema";

// Narrow helper for poking at the declared schema tree.
function props(node: any): Record<string, any> {
  expect(node).toBeTruthy();
  expect(node.type).toBe("object");
  expect(node.properties).toBeTruthy();
  return node.properties;
}

describe("createEmptyQuestGame", () => {
  it("produces a starter game that certifies", () => {
    const result = certifyGoalTreeGame(createEmptyQuestGame());
    expect(result.ok).toBe(true);
  });

  it("certifies with a custom title and locale", () => {
    const game = createEmptyQuestGame({ title: "Noa's Farm", locale: "he" });
    expect(game.meta.title).toBe("Noa's Farm");
    expect(game.meta.locale).toBe("he");
    expect(certifyGoalTreeGame(game).ok).toBe(true);
  });
});

describe("normalizeContentPack", () => {
  it("forces engine/engineVersion the AI tends to drop, making it certify", () => {
    const game = createEmptyQuestGame();
    // Simulate the AI replacing the whole pack and omitting the managed fields.
    const { engine: _e, engineVersion: _v, ...withoutEngine } = game as any;
    expect(certifyGoalTreeGame(withoutEngine).ok).toBe(false);
    const fixed = normalizeContentPack(withoutEngine) as any;
    expect(fixed.engine).toBe("goal-tree");
    expect(fixed.engineVersion).toBe(1);
    expect(certifyGoalTreeGame(fixed).ok).toBe(true);
  });

  it("overrides a wrong engine value", () => {
    const fixed = normalizeContentPack({ engine: "nope", engineVersion: 9, meta: {} }) as any;
    expect(fixed.engine).toBe("goal-tree");
    expect(fixed.engineVersion).toBe(1);
  });

  it("passes non-objects through untouched", () => {
    expect(normalizeContentPack(null)).toBe(null);
    expect(normalizeContentPack("x")).toBe("x");
  });
});

describe("QUEST_GAME_MEMORY_FIELD declaration", () => {
  const field = QUEST_GAME_MEMORY_FIELD as any;
  const contentPack = props(field).contentPack;

  it("declares meta, entities, and root under contentPack", () => {
    const cp = props(contentPack);
    expect(cp.meta).toBeTruthy();
    expect(cp.entities?.type).toBe("array");
    expect(cp.root?.type).toBe("object");
  });

  it("declares meta sub-fields (title, locale, theme, companion, goals)", () => {
    const meta = props(props(contentPack).meta);
    for (const k of ["title", "locale", "theme", "aiCompanion", "learningGoals"]) {
      expect(meta[k]).toBeTruthy();
    }
    const companion = props(meta.aiCompanion);
    expect(companion.name).toBeTruthy();
    expect(companion.persona).toBeTruthy();
  });

  it("declares entity items with a kind enum", () => {
    const entity = props(props(contentPack).entities.items);
    expect(entity.kind?.enum).toEqual(["item", "character", "obstacle", "marker"]);
    expect(entity.id).toBeTruthy();
    expect(entity.label).toBeTruthy();
  });

  it("declares the node union (type enum + all four node types' fields)", () => {
    const root = props(contentPack).root;
    const rp = props(root);
    expect(rp.type?.enum).toEqual(["reach", "collect", "choose", "overcome"]);
    // one representative field per node type
    expect(rp.markerEntityId).toBeTruthy(); // reach
    expect(rp.itemEntityIds).toBeTruthy(); // collect
    expect(rp.options).toBeTruthy(); // choose
    expect(rp.obstacleEntityId).toBeTruthy(); // overcome
  });

  it("constrains via items to overcome nodes", () => {
    const root = props(contentPack).root;
    const via = props(root).via;
    expect(via?.type).toBe("array");
    // via items are OVERCOME-only (type enum locked) with obstacleEntityId + key.
    const viaItem = props(via.items);
    expect(viaItem.type?.enum).toEqual(["overcome"]);
    expect(viaItem.obstacleEntityId).toBeTruthy();
    expect(viaItem.key).toBeTruthy();
  });

  it("is RECURSIVE — an overcome's key is a full node that can nest again", () => {
    const root = props(contentPack).root;
    // root.key (overcome path) is the full union and itself carries via/key.
    const key = props(props(root).key);
    expect(key.type?.enum).toEqual(["reach", "collect", "choose", "overcome"]);
    expect(key.via).toBeTruthy();
    // via item's key is also a full node (so trees can nest indefinitely).
    const viaKey = props(props(props(root).via.items).key);
    expect(viaKey.type?.enum).toEqual(["reach", "collect", "choose", "overcome"]);
  });
});
