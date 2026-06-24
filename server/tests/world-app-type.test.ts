/**
 * The world-engine is the third custom-app engine. These tests pin the fork in
 * validateCustomAppDefinitionForType: a row of type WORLD_APP_TYPE certifies its
 * definition as a WorldSpec (multiplayer), distinct from the grid + goal-tree
 * engines.
 */

import { describe, it, expect } from "@jest/globals";
import {
  validateCustomAppDefinitionForType,
  isMultiplayerAppType,
} from "../../shared/custom-app-validator.js";
import { WORLD_APP_TYPE } from "../../shared/world-engine/types.js";
import { socialFieldSpec } from "../../shared/world-engine/specs/index.js";

describe("world-engine as a custom-app type", () => {
  it("certifies a valid WorldSpec under WORLD_APP_TYPE", () => {
    const res = validateCustomAppDefinitionForType(WORLD_APP_TYPE, socialFieldSpec);
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The certified spec carries the engine discriminator.
      expect((res.data as { engine: string }).engine).toBe("world");
    }
  });

  it("rejects a malformed WorldSpec under WORLD_APP_TYPE", () => {
    const res = validateCustomAppDefinitionForType(WORLD_APP_TYPE, { engine: "world", nope: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.length).toBeGreaterThan(0);
  });

  it("does NOT route a grid game through the world validator", () => {
    // A grid GameDefinition is not a WorldSpec; under the default ("game") type
    // it must still validate via the grid schema, not be rejected as a world.
    const grid = {
      type: "game",
      label: "T",
      classes: [],
      buttons: [],
      rooms: [{ id: "r1", size: [4, 4] }],
      startRoom: "r1",
    };
    const res = validateCustomAppDefinitionForType("game", grid);
    expect(res.ok).toBe(true);
  });

  it("flags world apps as multiplayer (selectable as a social game)", () => {
    expect(isMultiplayerAppType(WORLD_APP_TYPE)).toBe(true);
    expect(isMultiplayerAppType("game")).toBe(false);
    expect(isMultiplayerAppType("goal_tree_game")).toBe(false);
    expect(isMultiplayerAppType(null)).toBe(false);
  });
});
