// Tests for the goal-tree platform glue: the AAC live-session app opener
// (re-certification + app_open payload + AI guidance note) and the type-aware
// definition validator (the Save-time student-safety gate). Pure-logic, no DB
// / no LLM.

import { describe, it, expect } from "@jest/globals";
import type { CustomApp } from "@shared/schema";
import {
  GOAL_TREE_APP_TYPE,
  isGoalTreeApp,
  prepareGoalTreeAppOpen,
} from "../../services/dual-agent/goal-tree-app";
import { validateCustomAppDefinitionForType } from "@shared/custom-app-validator";
import type { GoalTreeGame } from "@shared/world-engine/solver/types";
import { picnicGame } from "../helpers/goal-tree-fixtures";

function appRow(definition: unknown, type = GOAL_TREE_APP_TYPE): CustomApp {
  return {
    id: "app-1",
    userId: "user-1",
    instituteId: null,
    type,
    name: "Picnic Quest",
    description: "Get to the picnic.",
    imageUrl: null,
    definition,
    language: "en",
    isGenerated: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    loadedAt: new Date(),
  } as CustomApp;
}

describe("goal-tree app opener", () => {
  it("recognizes goal-tree apps by type", () => {
    expect(isGoalTreeApp(appRow({}, GOAL_TREE_APP_TYPE))).toBe(true);
    expect(isGoalTreeApp(appRow({}, "game"))).toBe(false);
  });

  it("re-certifies the stored content pack and builds the open payload", () => {
    const game = picnicGame();
    game.meta.aiCompanion = { name: "Dot", persona: "Warm. Short sentences." };
    const result = prepareGoalTreeAppOpen(
      appRow({ engine: "goal-tree", engineVersion: 1, contentPack: game }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.appId).toBe("goal_tree_game");
    expect(result.payload.appData.id).toBe("app-1");
    expect(result.payload.appData.game.meta.title).toBe("Test Game");
    // The AI note teaches title, companion persona, and the [GAME] protocol.
    expect(result.aiNote).toContain('"Test Game"');
    expect(result.aiNote).toContain('"Dot"');
    expect(result.aiNote).toContain("[GAME]");
    expect(result.aiNote).toContain("close_app()");
  });

  it("rejects rows whose content pack no longer certifies", () => {
    const game = picnicGame();
    // Tamper: dangling entity reference.
    game.entities = game.entities.filter((e) => e.id !== "squirrel");
    const result = prepareGoalTreeAppOpen(
      appRow({ engine: "goal-tree", engineVersion: 1, contentPack: game }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("failed certification");
    expect(result.error).toContain("schema");
  });

  it("rejects rows with no content pack at all", () => {
    const result = prepareGoalTreeAppOpen(appRow({ engine: "goal-tree" }));
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Type-aware definition validation (controller save/update path)
// ---------------------------------------------------------------------------

describe("validateCustomAppDefinitionForType", () => {
  it("certifies goal-tree definitions and normalizes the wrapper", () => {
    const result = validateCustomAppDefinitionForType(GOAL_TREE_APP_TYPE, {
      engine: "goal-tree",
      engineVersion: 1,
      contentPack: picnicGame(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { engine: string; contentPack: GoalTreeGame };
    expect(data.engine).toBe("goal-tree");
    expect(data.contentPack.meta.title).toBe("Test Game");
  });

  it("rejects broken goal-tree definitions with staged errors", () => {
    const game = picnicGame();
    game.entities = game.entities.filter((e) => e.id !== "log");
    const result = validateCustomAppDefinitionForType(GOAL_TREE_APP_TYPE, {
      contentPack: game,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("[schema]");
  });

  it("still validates v1 apps with the v1 schema", () => {
    const result = validateCustomAppDefinitionForType("game", { type: "game" });
    expect(result.ok).toBe(false); // missing required v1 fields → v1 errors
  });
});
