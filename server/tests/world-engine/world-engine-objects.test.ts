// The object primitive: shape + interactions (push/carry) + containment
// (on/in/under). Pure engine logic, no GL — safe in the default `npm test`.
// Confirms the soccer-ball "push" behavior is preserved and the new carry +
// containment verbs work.

import { describe, it, expect } from "@jest/globals";
import {
  carryObject,
  createWorldState,
  dropObject,
  placeInContainer,
  tickWorld,
} from "@shared/world-engine/engine.js";
import { validateWorldSpec } from "@shared/world-engine/schema.js";
import type { ObjectSpec, WorldSpec } from "@shared/world-engine/types.js";

function spec(objects: ObjectSpec[]): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 40, height: 40 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 5, y: 5, facing: 0 }], // local avatar faces +x
    objects,
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

const ball: ObjectSpec = {
  id: "ball", x: 9, y: 5, shape: "sphere", radius: 0.5, interactions: ["push"],
  push: { dribbleDistance: 1, friction: 0.25, releaseSpeed: 0.6, touchRadius: 1.2 },
};
const crate: ObjectSpec = { id: "crate", x: 8, y: 5, shape: "box", radius: 0.5, interactions: ["carry"] };
const table: ObjectSpec = {
  id: "table", x: 20, y: 20, shape: "box", radius: 1, interactions: [],
  contains: [{ relation: "on" }, { relation: "under", capacity: 1 }],
};

describe("object primitive — state", () => {
  it("builds objects free (not carried / not contained)", () => {
    const s = createWorldState(spec([ball, crate, table]), "me");
    expect(s.objects.crate).toMatchObject({ shape: "box", carriedBy: null, containedIn: null });
    expect(s.objects.ball.possessedBy).toBeNull();
  });
});

describe("carry", () => {
  it("picks up a carry object; refuses a non-carry one or a double pickup", () => {
    const s = createWorldState(spec([ball, crate]), "me");
    expect(carryObject(s, "ball", "me")).toBe(false); // push-only, not carryable
    expect(carryObject(s, "crate", "me")).toBe(true);
    expect(s.objects.crate.carriedBy).toBe("me");
    expect(carryObject(s, "crate", "me")).toBe(false); // already held
  });

  it("a carried object follows the carrier; drop frees it at a point", () => {
    const s = createWorldState(spec([crate]), "me");
    carryObject(s, "crate", "me");
    tickWorld(s, { aim: null }, 0.1); // avatar holds at spawn (5,5) facing +x
    expect(s.objects.crate.x).toBeCloseTo(6, 2); // held ~1 unit ahead (+x)
    expect(s.objects.crate.y).toBeCloseTo(5, 2);
    dropObject(s, "crate", 12, 13);
    expect(s.objects.crate).toMatchObject({ carriedBy: null, x: 12, y: 13 });
  });
});

describe("containment (on / in / under)", () => {
  it("places into an offered slot; respects capacity, relation, and self", () => {
    const s = createWorldState(spec([crate, { ...table }, { id: "cup", x: 0, y: 0, shape: "box", radius: 0.3, interactions: ["carry"] }]), "me");
    expect(placeInContainer(s, "crate", "table", "on")).toBe(true);
    expect(s.objects.crate.containedIn).toEqual({ objectId: "table", relation: "on" });
    expect(placeInContainer(s, "cup", "table", "under")).toBe(true);
    // "under" has capacity 1 — a second object can't go there.
    expect(placeInContainer(s, "crate", "table", "under")).toBe(false);
    // "in" isn't an offered slot on this table.
    expect(placeInContainer(s, "cup", "table", "in")).toBe(false);
    // Can't contain yourself.
    expect(placeInContainer(s, "table", "table", "on")).toBe(false);
  });

  it("a contained object snaps to its container on tick", () => {
    const s = createWorldState(spec([crate, table]), "me");
    placeInContainer(s, "crate", "table", "on");
    tickWorld(s, { aim: null }, 0.1);
    expect(s.objects.crate.x).toBeCloseTo(20, 5);
    expect(s.objects.crate.y).toBeCloseTo(20, 5);
  });
});

describe("push behavior is preserved", () => {
  it("a moving avatar takes possession of a free ball, as before", () => {
    const s = createWorldState(spec([ball]), "me");
    // Drive THROUGH the ball (aim past it) so the avatar is moving when it
    // arrives — the ball is grabbed and dribbled, not arrive-braked into a kick.
    let grabbed = false;
    for (let i = 0; i < 200 && !grabbed; i++) {
      tickWorld(s, { aim: { x: 30, y: 5 } }, 0.05);
      grabbed = s.objects.ball.possessedBy === "me";
    }
    expect(grabbed).toBe(true);
  });
});

describe("schema", () => {
  it("accepts a push ball, a carry crate, and a container table", () => {
    expect(validateWorldSpec(spec([ball, crate, table])).ok).toBe(true);
  });
  it("rejects a push object with no push tuning", () => {
    const bad = { ...ball, push: undefined };
    expect(validateWorldSpec(spec([bad])).ok).toBe(false);
  });
  it("rejects an object that is neither interactive nor a container", () => {
    const inert: ObjectSpec = { id: "rock", x: 1, y: 1, shape: "box", radius: 0.5, interactions: [] };
    expect(validateWorldSpec(spec([inert])).ok).toBe(false);
  });
});
