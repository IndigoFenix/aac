/**
 * canDropAt: empty-dropRules behavior.
 *
 * The engine should treat a class with no dropRules as droppable anywhere
 * subject only to bounds + solid-collision + tile-on-same-layer rules.
 * (Previously it returned false unless explicit dropRules matched.)
 */

import { describe, it, expect } from "@jest/globals";
import type { GameDefinition } from "../../shared/custom-app-types.js";
import { dispatch, initState } from "../../client-shared/src/game-runtime/engine.js";
import {
  canDropAt,
  findTopmostMatching,
  isClickable,
  isMovable,
  sortStackBottomToTop,
} from "../../client-shared/src/game-runtime/selectors.js";

function defWith(classes: GameDefinition["classes"]): GameDefinition {
  return {
    type: "game",
    label: "T",
    classes,
    buttons: [],
    rooms: [
      {
        id: "home",
        size: [4, 4],
        entities: [
          { classId: classes[0].id, position: [0, 0] },
          ...(classes[1] ? [{ classId: classes[1].id, position: [2, 2] }] : []),
        ],
      },
    ],
    startRoom: "home",
  };
}

describe("canDropAt with no dropRules", () => {
  it("permits a drop on an empty cell", () => {
    const def = defWith([{ id: "ball", movable: true }]);
    const state = initState(def);
    const ball = Object.values(state.entities)[0];
    expect(canDropAt(def, state, ball, [3, 3])).toBe(true);
  });

  it("permits stacking onto a non-solid neighbor", () => {
    const def = defWith([
      { id: "ball", movable: true },
      { id: "rug" }, // not solid
    ]);
    const state = initState(def);
    const ball = Object.values(state.entities).find((e) => e.classId === "ball")!;
    expect(canDropAt(def, state, ball, [2, 2])).toBe(true);
  });

  it("rejects solid-on-solid even with no dropRules", () => {
    const def = defWith([
      { id: "ball", movable: true, isSolid: true },
      { id: "wall", isSolid: true },
    ]);
    const state = initState(def);
    const ball = Object.values(state.entities).find((e) => e.classId === "ball")!;
    expect(canDropAt(def, state, ball, [2, 2])).toBe(false);
  });

  it("rejects out-of-bounds drops", () => {
    const def = defWith([{ id: "ball", movable: true }]);
    const state = initState(def);
    const ball = Object.values(state.entities)[0];
    expect(canDropAt(def, state, ball, [4, 4])).toBe(false);
    expect(canDropAt(def, state, ball, [-1, 0])).toBe(false);
  });
});

describe("canDropAt with explicit dropRules still honored", () => {
  it("requires the rule to match when dropRules are present", () => {
    const def = defWith([
      {
        id: "ball",
        movable: true,
        dropRules: [{ type: "adjacentTo", classIds: ["box"] }],
      },
      { id: "box" },
    ]);
    const state = initState(def);
    const ball = Object.values(state.entities).find((e) => e.classId === "ball")!;
    expect(canDropAt(def, state, ball, [1, 2])).toBe(true);
    expect(canDropAt(def, state, ball, [3, 3])).toBe(false);
  });
});

describe("findTopmostMatching", () => {
  it("returns the most-recently-placed entity that matches", () => {
    const def: GameDefinition = {
      type: "game",
      label: "T",
      classes: [
        { id: "rug" },
        { id: "ball", movable: true },
      ],
      buttons: [],
      rooms: [
        {
          id: "home",
          size: [4, 4],
          entities: [
            { classId: "ball", position: [1, 1] }, // movable, placed first
            { classId: "rug", position: [1, 1] },  // non-movable, placed on top
          ],
        },
      ],
      startRoom: "home",
    };
    const state = initState(def);
    const movable = findTopmostMatching(def, state, [1, 1], (e) => isMovable(def, e));
    expect(movable?.classId).toBe("ball");
  });

  it("returns undefined when nothing matches", () => {
    const def: GameDefinition = {
      type: "game",
      label: "T",
      classes: [{ id: "rock" }],
      buttons: [],
      rooms: [{ id: "home", size: [2, 2], entities: [{ classId: "rock", position: [0, 0] }] }],
      startRoom: "home",
    };
    const state = initState(def);
    expect(findTopmostMatching(def, state, [0, 0], (e) => isMovable(def, e))).toBeUndefined();
  });
});

describe("isClickable", () => {
  it("treats containers as clickable even without onClick interactions", () => {
    const def: GameDefinition = {
      type: "game",
      label: "T",
      classes: [{ id: "box", maxCapacity: 2 }],
      buttons: [],
      rooms: [{ id: "home", size: [1, 1], entities: [{ classId: "box", position: [0, 0] }] }],
      startRoom: "home",
    };
    const state = initState(def);
    const box = Object.values(state.entities)[0];
    expect(isClickable(def, box)).toBe(true);
  });

  it("treats entities with onClick interactions as clickable", () => {
    const def: GameDefinition = {
      type: "game",
      label: "T",
      classes: [
        {
          id: "switch",
          interactions: [{
            triggers: { events: [{ type: "onClick" }] },
            effects: [{ type: "endTurn" }],
          }],
        },
      ],
      buttons: [],
      rooms: [{ id: "home", size: [1, 1], entities: [{ classId: "switch", position: [0, 0] }] }],
      startRoom: "home",
    };
    const state = initState(def);
    const sw = Object.values(state.entities)[0];
    expect(isClickable(def, sw)).toBe(true);
  });

  it("rejects an entity with no onClick interactions and no container capacity", () => {
    const def: GameDefinition = {
      type: "game",
      label: "T",
      classes: [{ id: "rock" }],
      buttons: [],
      rooms: [{ id: "home", size: [1, 1], entities: [{ classId: "rock", position: [0, 0] }] }],
      startRoom: "home",
    };
    const state = initState(def);
    const rock = Object.values(state.entities)[0];
    expect(isClickable(def, rock)).toBe(false);
  });
});

describe("placedSeq render-order recency", () => {
  it("an entity moved to a cell sits on top of entities placed earlier", () => {
    const def: GameDefinition = {
      type: "game",
      label: "T",
      classes: [
        { id: "rug" },
        { id: "ball", movable: true },
      ],
      buttons: [],
      rooms: [
        {
          id: "home",
          size: [4, 4],
          entities: [
            { classId: "rug", position: [2, 2] },   // placed first
            { classId: "ball", position: [0, 0] },  // placed second
          ],
        },
      ],
      startRoom: "home",
    };
    const state = initState(def);
    const ball = Object.values(state.entities).find((e) => e.classId === "ball")!;
    // Move ball onto the rug.
    const after = dispatch(state, { type: "move", movingUid: ball.uid, to: [2, 2] }, def).state;
    const stack = sortStackBottomToTop(
      def,
      Object.values(after.entities).filter((e) => e.position[0] === 2 && e.position[1] === 2),
    );
    // After the move ball was placed last, so it should be on top.
    expect(stack[stack.length - 1].classId).toBe("ball");
  });
});
