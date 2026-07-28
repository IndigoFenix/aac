// THE PROP ON THE TABLE — why "eat that" off a surface used to hang.
//
// A prop shown on a stocked container is a MIRROR of one stack unit, not a
// thing in its own right, so it is spawned with NO carry affordance (a liftable
// mirror would let the player's gaze-carry take a meal out from under the count
// and drift the ledger). Nothing said so at the reach: `carryObject` simply
// returned false, silently, and any plan regressing through "hold it first"
// re-derived the same impossible pickup forever — while the SAME food loose on
// the floor was picked up and eaten without trouble.
//
// These pin the contract the host's `unshelveProp` stands on: the refusal is
// real, the approach was never the problem, and re-registering the object under
// its own id is what converts a mirror into something hands can take.
//
// Pure world math — headless, no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  addWorldObject,
  carryObject,
  createWorldState,
  placeInContainer,
  removeWorldObject,
} from "@shared/world-engine/engine.js";
import { nearestClearSpot, standClear } from "@shared/world-engine/interaction/quest/stand-points.js";
import type { WorldSpec } from "@shared/world-engine/types.js";

const TABLE = { x: 20, y: 20, radius: 0.8 };

/** One room-less world: a solid table that holds things ON it. */
function spec(): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "x" },
    manifold: { kind: "flat", width: 60, height: 60 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 2, y: 2, facing: 0 }],
    objects: [
      {
        id: "table",
        x: TABLE.x,
        y: TABLE.y,
        shape: "box",
        radius: TABLE.radius,
        fixture: "table",
        openable: false,
        facing: 0,
        interactions: [],
        contains: [{ relation: "on", capacity: 2 }],
      },
    ],
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

/** The world + a meal ON the table, exactly as the host materializes one:
 *  a small sphere at the table's own spot with NO interactions. */
function served() {
  const state = createWorldState(spec(), "me");
  addWorldObject(state, {
    id: "small:meal1",
    x: TABLE.x,
    y: TABLE.y,
    shape: "sphere",
    radius: 0.3,
    interactions: [],
    glyph: "apple",
  });
  expect(placeInContainer(state, "small:meal1", "table", "on")).toBe(true);
  return state;
}

describe("a meal shown ON a table cannot be lifted", () => {
  it("carryObject REFUSES it — the silent no-op the pursuit kept re-deriving", () => {
    const state = served();
    expect(carryObject(state, "small:meal1", "npc_bear")).toBe(false);
    expect(state.objects["small:meal1"]!.carriedBy).toBeNull();
  });

  it("…and it stays on the table: a refused pick changes NOTHING to re-plan against", () => {
    const state = served();
    carryObject(state, "small:meal1", "npc_bear");
    expect(state.objects["small:meal1"]!.containedIn).toEqual({ objectId: "table", relation: "on" });
  });

  it("the very same food LOOSE on the floor is taken first try — the asymmetry seen live", () => {
    const state = createWorldState(spec(), "me");
    addWorldObject(state, {
      id: "small:meal2",
      x: TABLE.x,
      y: TABLE.y,
      shape: "sphere",
      radius: 0.35,
      interactions: ["carry"],
      glyph: "apple",
    });
    expect(carryObject(state, "small:meal2", "npc_bear")).toBe(true);
  });
});

describe("the WALK was never the problem — the approach already lands beside the table", () => {
  it("the meal's own spot is unstandable (it reports the table's centre)", () => {
    const state = served();
    expect(standClear(state, { x: TABLE.x, y: TABLE.y })).toBe(false);
  });

  it("the approach nudges to clear ground just off the table's edge", () => {
    const state = served();
    const spot = nearestClearSpot(state, { x: TABLE.x, y: TABLE.y }, { x: 10, y: 20 });
    expect(standClear(state, spot)).toBe(true);
    // Beside it, not across the room: within a body-width of the edge.
    const off = Math.max(Math.abs(spot.x - TABLE.x), Math.abs(spot.y - TABLE.y));
    expect(off).toBeGreaterThan(TABLE.radius);
    expect(off).toBeLessThan(TABLE.radius + 1.5);
  });
});

describe("UNSHELVING — the conversion that makes the reach succeed", () => {
  /** What the host does on a pick: draw the unit down, then re-register the
   *  SAME object as a real loose prop. */
  function unshelve(state: ReturnType<typeof served>) {
    const o = state.objects["small:meal1"]!;
    const at = { x: o.x, y: o.y };
    removeWorldObject(state, "small:meal1");
    addWorldObject(state, {
      id: "small:meal1",
      x: at.x,
      y: at.y,
      shape: "sphere",
      radius: 0.3,
      interactions: ["carry"],
      glyph: "apple",
    });
  }

  it("re-registering under the SAME id keeps the object's identity — a plan that named it still holds", () => {
    const state = served();
    unshelve(state);
    expect(state.objects["small:meal1"]).toBeDefined();
    expect(state.spec.objects.filter((o) => o.id === "small:meal1")).toHaveLength(1);
  });

  it("the reach then SUCCEEDS, and the meal leaves the surface", () => {
    const state = served();
    unshelve(state);
    expect(carryObject(state, "small:meal1", "npc_bear")).toBe(true);
    expect(state.objects["small:meal1"]!.carriedBy).toBe("npc_bear");
    expect(state.objects["small:meal1"]!.containedIn).toBeNull();
  });

  it("the table is left free to be served again (the conversion consumed the slot, not the table)", () => {
    const state = served();
    unshelve(state);
    carryObject(state, "small:meal1", "npc_bear");
    addWorldObject(state, {
      id: "small:meal3",
      x: TABLE.x,
      y: TABLE.y,
      shape: "sphere",
      radius: 0.3,
      interactions: [],
      glyph: "apple",
    });
    expect(placeInContainer(state, "small:meal3", "table", "on")).toBe(true);
  });
});
