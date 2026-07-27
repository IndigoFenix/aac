// WHICH FURNITURE THE GAZE IS AIMED AT (furniture-aim.ts). Pins the rule the
// board's object popup targets through, after the observed bug: hovering a box
// showed a DIFFERENT nearby box's contents (an empty chest handed the board to
// its neighbour), and hovering a non-container beside a box opened the box.
// The rule is "the hover IS the aim" — proximity to the fixation only survives
// for a view with no screen pick at all (the 2D top-down). Every piece of
// furniture is a target (it names itself on the board); only a real CONTAINER
// is a place to put a stack. Pure — headless.

import { describe, it, expect } from "@jest/globals";
import {
  resolveFurnitureAim,
  type FurnitureAimGaze,
  type FurnitureAimOpts,
  type FurnitureLookup,
} from "@shared/world-engine/interaction/quest/furniture-aim.js";

const REACH = 7; // CONVO_RADIUS
const FIX = 2.2; // CONVO_FIG_RADIUS

/** A furnished room: `chest` (stocked) and `cupboard` (stocked) stand 1.2 m
 *  apart — closer than the fixation radius, the arrangement that cross-talked —
 *  with an EMPTY `crate` between them and a `chair` beside the chest. Across
 *  the room a `table` carries an `apple`; a `sheep` (a walking container) and a
 *  loose `ball` on the floor round it out. */
function room(): FurnitureLookup {
  const containers = new Set(["chest", "cupboard", "crate", "table", "sheep"]);
  const furniture = new Set(["chest", "cupboard", "crate", "table", "chair", "bed"]);
  const at: Record<string, { x: number; y: number }> = {
    chest: { x: 0, y: 0 },
    crate: { x: 0.6, y: 0 },
    cupboard: { x: 1.2, y: 0 },
    chair: { x: 0.3, y: 0.4 },
    bed: { x: 2, y: 2 },
    table: { x: 4, y: 0 },
    apple: { x: 4, y: 0.1 },
    ball: { x: 0.4, y: 0.8 },
    sheep: { x: 30, y: 0 },
  };
  return {
    isContainer: (id) => containers.has(id),
    isFurniture: (id) => furniture.has(id),
    containedIn: (id) => (id === "apple" ? "table" : undefined),
    standpoint: (id) => at[id],
    ids: () => containers,
  };
}

const gaze = (
  hover: FurnitureAimGaze["hover"],
  committedWorld: FurnitureAimGaze["committedWorld"] = null,
  picks = true,
): FurnitureAimGaze => ({ hover, committedWorld, picks });

const opts = (over: Partial<FurnitureAimOpts> = {}): FurnitureAimOpts => ({
  want: "furniture",
  me: { x: 0, y: 2 },
  spirit: false,
  reach: REACH,
  fixRadius: FIX,
  ...over,
});

const obj = (id: string) => ({ kind: "object" as const, id });

describe("the hover is the aim", () => {
  it("a hovered container is the target, at its live standpoint", () => {
    expect(resolveFurnitureAim(room(), gaze(obj("chest"), { x: 0, y: 0 }), opts())).toEqual({
      id: "chest",
      x: 0,
      y: 0,
    });
  });

  it("an EMPTY container is ITSELF the target — never its neighbour", () => {
    // The reported bug: `crate` holds nothing and sits 0.6 m from a stocked
    // chest and 0.6 m from a stocked cupboard, both inside the old radius.
    expect(resolveFurnitureAim(room(), gaze(obj("crate"), { x: 0.6, y: 0 }), opts())).toEqual({
      id: "crate",
      x: 0.6,
      y: 0,
    });
  });

  it("furniture that holds nothing EVER is still a target (it names itself)", () => {
    expect(resolveFurnitureAim(room(), gaze(obj("chair"), { x: 0.3, y: 0.4 }), opts())).toEqual({
      id: "chair",
      x: 0.3,
      y: 0.4,
    });
  });

  it("a LOOSE PROP is not — those are carried, and a board would fight the carry dwell", () => {
    expect(resolveFurnitureAim(room(), gaze(obj("ball"), { x: 0.4, y: 0.8 }), opts())).toBeNull();
  });

  it("hovering nothing at all (bare ground beside a chest) targets nothing", () => {
    expect(resolveFurnitureAim(room(), gaze(null, { x: 0.2, y: 0.2 }), opts())).toBeNull();
  });

  it("a prop resting IN a container resolves to that container", () => {
    // A laden surface hides its own mesh behind its contents: the apple IS the table.
    expect(resolveFurnitureAim(room(), gaze(obj("apple"), { x: 4, y: 0.1 }), opts({ me: { x: 4, y: 2 } }))).toEqual({
      id: "table",
      x: 4,
      y: 0,
    });
  });

  it("furniture that has streamed out targets nothing", () => {
    const gone: FurnitureLookup = { ...room(), standpoint: () => undefined };
    expect(resolveFurnitureAim(gone, gaze(obj("chest"), { x: 0, y: 0 }), opts())).toBeNull();
  });
});

describe("want: only a container takes a stack", () => {
  const put = opts({ want: "container" });

  it("a stack goes into an EMPTY container", () => {
    expect(resolveFurnitureAim(room(), gaze(obj("crate"), { x: 0.6, y: 0 }), put)).toEqual({
      id: "crate",
      x: 0.6,
      y: 0,
    });
  });

  it("but never into a chair — it drops on the ground instead", () => {
    expect(resolveFurnitureAim(room(), gaze(obj("chair"), { x: 0.3, y: 0.4 }), put)).toBeNull();
  });
});

describe("reach", () => {
  it("a BODY must be within reach; the same look succeeds for a formless spirit", () => {
    const far = opts({ me: { x: 40, y: 0 } });
    expect(resolveFurnitureAim(room(), gaze(obj("chest"), { x: 0, y: 0 }), far)).toBeNull();
    expect(resolveFurnitureAim(room(), gaze(obj("chest"), { x: 0, y: 0 }), { ...far, spirit: true })).toEqual({
      id: "chest",
      x: 0,
      y: 0,
    });
  });

  it("a walking container (a product animal) is hovered as an AVATAR", () => {
    const hoverSheep = gaze({ kind: "avatar", id: "sheep" }, { x: 30, y: 0 });
    expect(resolveFurnitureAim(room(), hoverSheep, opts({ spirit: true }))).toEqual({ id: "sheep", x: 30, y: 0 });
  });
});

describe("the no-pick fallback (2D top-down only)", () => {
  it("resolves the nearest container to the fixation when the view can't pick", () => {
    const g = gaze(null, { x: 1.0, y: 0 }, false); // nearer the cupboard than the crate
    expect(resolveFurnitureAim(room(), g, opts())?.id).toBe("cupboard");
  });

  it("stays off when the view CAN pick — a null hover means the gaze is on nothing", () => {
    expect(resolveFurnitureAim(room(), gaze(null, { x: 1.0, y: 0 }, true), opts())).toBeNull();
  });

  it("respects the fixation radius", () => {
    expect(resolveFurnitureAim(room(), gaze(null, { x: 0, y: 9 }, false), opts())).toBeNull();
  });
});
