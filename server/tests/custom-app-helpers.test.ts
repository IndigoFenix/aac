/**
 * Pure-logic tests for the custom-app editor helpers.
 *
 * These tests exercise the rename-cascade and reference-scanner functions
 * the editor relies on. The helpers live under client/src/features but are
 * pure TypeScript (no React) so we can import them directly into Jest.
 */

import { describe, it, expect } from "@jest/globals";
import type { GameDefinition } from "../../shared/custom-app-types.js";
import {
  applyClassRename,
  defaultClass,
  defaultRoom,
  findClassReferences,
  uniqueId,
  clipEntitiesToSize,
} from "../../client/src/features/custom-app/helpers.js";

function makeDef(): GameDefinition {
  return {
    type: "game",
    label: "Test Game",
    classes: [
      {
        id: "cat",
        label: "Cat",
        interactions: [
          {
            triggers: {
              events: [{ type: "onClick" }],
              other: { classId: "mouse" },
            },
            effects: [{ type: "destroyOther" }, { type: "transformSelf", id: "fat_cat" }],
          },
        ],
        dropRules: [{ type: "adjacentTo", classIds: ["mouse", "box"] }],
      },
      { id: "fat_cat", label: "Fat Cat" },
      { id: "mouse", label: "Mouse" },
      { id: "box", label: "Box" },
    ],
    buttons: [
      {
        id: "spawn_mouse",
        label: "Spawn Mouse",
        effects: [
          { type: "createEntity", classId: "mouse", position: [0, 0] },
        ],
      },
    ],
    rooms: [
      {
        id: "home",
        label: "Home",
        size: [4, 4],
        entities: [
          { classId: "cat", position: [0, 0] },
          { classId: "mouse", position: [3, 3] },
          { classId: "mouse", position: [1, 2] },
        ],
      },
    ],
    startRoom: "home",
  };
}

describe("uniqueId", () => {
  it("returns the slugified seed when nothing collides", () => {
    expect(uniqueId("New Object", [])).toBe("new_object");
  });
  it("appends _2, _3 etc. on collision", () => {
    expect(uniqueId("cat", ["cat"])).toBe("cat_2");
    expect(uniqueId("cat", ["cat", "cat_2"])).toBe("cat_3");
  });
  it("falls back to a leading underscore when slug starts with a digit", () => {
    expect(uniqueId("123start", [])).toBe("_123start");
  });
});

describe("findClassReferences", () => {
  it("finds references in interactions, dropRules, button effects, and room entities", () => {
    const def = makeDef();
    const refs = findClassReferences(def, "mouse");
    const locations = refs.map((r) => r.location).sort();
    expect(locations).toContain('class "cat"');           // interaction (other) and dropRule
    expect(locations).toContain('button "spawn_mouse"');  // createEntity effect
    expect(locations).toContain('room "home"');           // 2 placed instances

    const roomRef = refs.find((r) => r.location === 'room "home"');
    expect(roomRef?.detail).toMatch(/2 placed/);
  });

  it("does not include a class's references to itself", () => {
    const def = makeDef();
    const refs = findClassReferences(def, "cat");
    // cat is referenced by the room placement only — its own dropRules/interactions are skipped.
    expect(refs.every((r) => r.location !== 'class "cat"')).toBe(true);
  });

  it("returns an empty array when nothing references the class", () => {
    const def = makeDef();
    // 'box' is only mentioned in cat's dropRule; if we strip that, it's truly orphan.
    const stripped: GameDefinition = {
      ...def,
      classes: def.classes.map((c) =>
        c.id === "cat" ? { ...c, dropRules: undefined } : c,
      ),
    };
    expect(findClassReferences(stripped, "box").length).toBe(0);
  });
});

describe("applyClassRename", () => {
  it("rewrites references in interactions, dropRules, button createEntity, and room entities", () => {
    const def = makeDef();
    const renamed = applyClassRename(def, "mouse", "rat");

    // The class itself is renamed.
    expect(renamed.classes.find((c) => c.id === "rat")).toBeDefined();
    expect(renamed.classes.find((c) => c.id === "mouse")).toBeUndefined();

    // Interaction other.classId is rewritten.
    const cat = renamed.classes.find((c) => c.id === "cat")!;
    expect(cat.interactions?.[0].triggers.other?.classId).toBe("rat");

    // dropRule classIds list is rewritten.
    expect(cat.dropRules?.[0].classIds).toEqual(["rat", "box"]);

    // Button createEntity effect is rewritten.
    const btn = renamed.buttons.find((b) => b.id === "spawn_mouse")!;
    const ce = btn.effects[0] as { type: string; classId: string };
    expect(ce.classId).toBe("rat");

    // Room entities are rewritten.
    const home = renamed.rooms.find((r) => r.id === "home")!;
    expect(home.entities!.filter((e) => e.classId === "rat").length).toBe(2);
    expect(home.entities!.filter((e) => e.classId === "mouse").length).toBe(0);
  });

  it("rewrites transformSelf/transformOther effects pointing at the renamed class", () => {
    const def = makeDef();
    const renamed = applyClassRename(def, "fat_cat", "huge_cat");
    const cat = renamed.classes.find((c) => c.id === "cat")!;
    const transform = cat.interactions?.[0].effects.find((e) => e.type === "transformSelf");
    expect(transform).toEqual({ type: "transformSelf", id: "huge_cat" });
  });

  it("returns the original def unchanged when oldId === newId", () => {
    const def = makeDef();
    expect(applyClassRename(def, "cat", "cat")).toBe(def);
  });

  it("does not touch classes that don't reference the renamed id", () => {
    const def = makeDef();
    const before = JSON.stringify(def.classes.find((c) => c.id === "box"));
    const renamed = applyClassRename(def, "mouse", "rat");
    const after = JSON.stringify(renamed.classes.find((c) => c.id === "box"));
    expect(after).toBe(before);
  });
});

describe("clipEntitiesToSize", () => {
  it("removes entities outside the new bounds", () => {
    const entities = [
      { classId: "a", position: [0, 0] as [number, number] },
      { classId: "a", position: [3, 0] as [number, number] },
      { classId: "a", position: [0, 5] as [number, number] },
    ];
    expect(clipEntitiesToSize(entities, 3, 3)).toEqual([
      { classId: "a", position: [0, 0] },
    ]);
  });
  it("returns undefined for undefined input", () => {
    expect(clipEntitiesToSize(undefined, 3, 3)).toBeUndefined();
  });
});

describe("defaults", () => {
  it("defaultClass yields a class with a unique id", () => {
    const c = defaultClass(["object", "object_2"]);
    expect(c.id).toBe("object_3");
  });
  it("defaultRoom yields a room with a unique id and a positive size", () => {
    const r = defaultRoom([]);
    expect(r.id).toBe("room");
    expect(r.size[0]).toBeGreaterThan(0);
    expect(r.size[1]).toBeGreaterThan(0);
  });
});
