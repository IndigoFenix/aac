// THE HELD THING AND THE POSE THAT HOLDS IT.
//
// Reported: "when creatures eat at a table, the food hovers in the air next to
// the table as they sit down."
//
// Root cause, in two halves:
//   1. a held object rode ONE fixed offset — an arm's reach ahead of the body at
//      standing hand height — whatever pose the body was in. A dining chair is
//      placed against its table and FACES it, and the furniture anchor pins a
//      seated body on the seat centre pointing that way, so composing the two
//      threw a diner's meal a metre forward: out over the middle of the tabletop
//      at a height with nothing under it. `carryHoldFor` makes the hold follow
//      the pose.
//   2. the diner was still holding its dinner while it sat at all. The host now
//      sets it on the table first (quest-host `setMealOnSurface`), which is why
//      `containerRoom` exists — a put onto a full top must be refused BEFORE the
//      hands let go.
//
// Pure sim/geometry — headless, no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  CARRY_HOLD,
  addWorldObject,
  carryHoldFor,
  carryObject,
  containerRoom,
  createWorldState,
  placeInContainer,
  tickWorld,
} from "@shared/world-engine/engine.js";
import { TABLE_TOP_Y } from "@shared/world-engine/object-models.js";
import type { WorldSpec } from "@shared/world-engine/types.js";

/** The real house dining set (kernel/town/stations.ts): a 0.8 m table with a
 *  0.22 m chair tucked against it, `gapPad` 0.1 — so the seat centre, which is
 *  where the anchor pins a sitter, is 1.12 m out from the tabletop's middle. */
const TABLE_R = 0.8;
const CHAIR_R = 0.22;
const SEAT_FROM_TABLE = TABLE_R + CHAIR_R + 0.1;
/** A chair's top face — SEAT_TOP_FRAC.chair (2.2) × its radius. */
const SEAT_TOP_Y = 2.2 * CHAIR_R;

function spec(): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "x" },
    manifold: { kind: "flat", width: 40, height: 40 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 20, y: 20, facing: 0 }],
    objects: [
      {
        id: "table",
        x: 20,
        y: 20,
        shape: "box",
        radius: TABLE_R,
        fixture: "table",
        openable: false,
        facing: 0,
        interactions: [],
        contains: [{ relation: "on", capacity: 2 }],
      },
      { id: "meal", x: 25, y: 25, shape: "sphere", radius: 0.3, interactions: ["carry"] },
    ],
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

describe("carryHoldFor — a held thing rides the pose, not one fixed offset", () => {
  it("a standing carrier keeps the old arm's-reach hold", () => {
    expect(carryHoldFor(undefined)).toEqual({ forward: CARRY_HOLD, up: 0.75 });
    expect(carryHoldFor({})).toEqual({ forward: CARRY_HOLD, up: 0.75 });
    // `eat` is a standing hand-to-mouth — deliberately NOT a posed hold.
    expect(carryHoldFor({ activity: { kind: "eat" } })).toEqual({ forward: CARRY_HOLD, up: 0.75 });
  });

  it("every crouched/lying pose brings the hold in AND down", () => {
    for (const kind of ["sit", "play", "sleep"] as const) {
      const hold = carryHoldFor({ activity: { kind } });
      expect(hold.forward).toBeLessThan(CARRY_HOLD);
      expect(hold.up).toBeLessThan(0.75);
      expect(hold.forward).toBeGreaterThan(0); // still in FRONT of the body
      expect(hold.up).toBeGreaterThan(0); // still held, never on the floor
    }
  });

  it("a seated diner's hold point clears the table it is pulled up to", () => {
    // THE REGRESSION, as geometry: the sitter is pinned on the seat centre
    // facing the table, so the held thing lands `SEAT_FROM_TABLE − forward` from
    // the tabletop's middle. At the standing reach that is ~0.12 m — the MIDDLE
    // of the table, in mid-air, an arm's length from the hands that hold it.
    expect(SEAT_FROM_TABLE - CARRY_HOLD).toBeLessThan(TABLE_R * 0.25);
    // The seated hold keeps the point outside the table's own footprint…
    const seated = carryHoldFor({ activity: { kind: "sit" } });
    expect(SEAT_FROM_TABLE - seated.forward).toBeGreaterThan(TABLE_R);
    // …at a height that reads as a lap: above the seat the body rests on, below
    // the top it is drawn up to.
    expect(seated.up).toBeGreaterThan(SEAT_TOP_Y);
    expect(seated.up).toBeLessThan(TABLE_TOP_Y);
    // A prop's own BULK still overlaps the table from there (LOOSE_ITEM_R 0.3
    // reaches back past the rim) — no seated hold can clear both the chair and
    // the tabletop, which is why the host also sets a MEAL down before sitting
    // rather than eating it out of the hands.
  });

  it("the SIM keeps one logical hold — the pose is a display rule only", () => {
    // `activity` is display-only (tickWorld never reads it, and it does not
    // cross the wire), so the simulated plan spot of a held thing must not move
    // when a body sits: a drop aim and a source-reach test still mean "an arm's
    // reach ahead". Only the DRAWN place follows the pose.
    const state = createWorldState(spec(), "me");
    const me = state.avatars["me"]!;
    me.x = 20 + SEAT_FROM_TABLE;
    me.y = 20;
    me.fx = -1; // facing the table, as the seat's own facing pins a sitter
    me.fy = 0;
    expect(carryObject(state, "meal", "me")).toBe(true);

    tickWorld(state, { aim: null }, 1 / 60);
    const standing = { ...state.objects["meal"]! };
    me.activity = { kind: "sit", objId: "chair" };
    tickWorld(state, { aim: null }, 1 / 60);

    expect(state.objects["meal"]!.x).toBeCloseTo(standing.x, 6);
    expect(state.objects["meal"]!.y).toBeCloseTo(standing.y, 6);
    expect(state.objects["meal"]!.x).toBeCloseTo(me.x - CARRY_HOLD, 6);
  });
});

describe("containerRoom — ask before the hands let go", () => {
  it("counts the free slots of a relation the container offers", () => {
    const state = createWorldState(spec(), "me");
    expect(containerRoom(state, "table", "on")).toBe(2);
    expect(placeInContainer(state, "meal", "table", "on")).toBe(true);
    expect(containerRoom(state, "table", "on")).toBe(1);
  });

  it("is zero for a full top, and agrees with what placeInContainer refuses", () => {
    const state = createWorldState(spec(), "me");
    for (const id of ["a", "b"]) {
      addWorldObject(state, { id, x: 20, y: 20, shape: "sphere", radius: 0.3, interactions: ["carry"] });
      expect(placeInContainer(state, id, "table", "on")).toBe(true);
    }
    expect(containerRoom(state, "table", "on")).toBe(0);
    expect(placeInContainer(state, "meal", "table", "on")).toBe(false);
  });

  it("is zero for a relation the container does not offer at all", () => {
    const state = createWorldState(spec(), "me");
    expect(containerRoom(state, "table", "in")).toBe(0);
    expect(containerRoom(state, "table", "under")).toBe(0);
    expect(placeInContainer(state, "meal", "table", "in")).toBe(false);
  });
});
