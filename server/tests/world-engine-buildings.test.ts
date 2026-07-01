// Buildings (Phase B2): a multi-storey enclosure that lowers into perimeter
// wall/door/stairs structures, plus the inside/footprint queries the renderer's
// overhead floor-fade keys on. Pure engine logic, no GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  buildingAt,
  buildingStructures,
  createWorldState,
  expandWorldBuildings,
  insideBuilding,
  tickWorld,
  updateAvatarFloor,
  type WorldState,
} from "@shared/world-engine/engine.js";
import { certifyWorldSpec } from "@shared/world-engine/index.js";
import { validateWorldSpec } from "@shared/world-engine/schema.js";
import type { BuildingSpec, WorldSpec } from "@shared/world-engine/types.js";

const building: BuildingSpec = {
  id: "house",
  footprint: { x: 10, y: 10, w: 12, h: 12 },
  wallThickness: 0.6,
  floors: 2,
  doorways: [{ edge: "south", offset: 6, width: 2 }], // gap [5,7] along the south edge
};

function spec(extra: Partial<WorldSpec> = {}): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 40, height: 40 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 16, y: 16, facing: Math.PI / 2 }],
    objects: [],
    buildings: [building],
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
    ...extra,
  };
}

function steerFor(state: WorldState, aimX: number, aimY: number, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) tickWorld(state, { aim: { x: aimX, y: aimY } }, 1 / 60);
}

describe("building expansion", () => {
  it("lowers into perimeter walls, a door at each doorway, and a stairway per storey gap", () => {
    const st = buildingStructures(building);
    expect(st.filter((s) => s.kind === "wall")).toHaveLength(5); // south split by its doorway
    expect(st.filter((s) => s.kind === "door")).toHaveLength(1);
    expect(st.filter((s) => s.kind === "stairs")).toHaveLength(1);
    const door = st.find((s) => s.kind === "door")!;
    expect(door).toMatchObject({ a: { x: 15, y: 22 }, b: { x: 17, y: 22 } });
  });

  it("certifyWorldSpec returns a spec with the building materialized into structures", () => {
    const cert = certifyWorldSpec(spec());
    expect(cert.ok).toBe(true);
    if (!cert.ok) return;
    expect(cert.spec.structures).toHaveLength(7); // 5 walls + 1 door + 1 stairway
  });
});

describe("footprint queries", () => {
  it("insideBuilding / buildingAt locate the occupant", () => {
    const s = createWorldState(expandWorldBuildings(spec()), "me");
    expect(insideBuilding(building, 16, 16)).toBe(true);
    expect(insideBuilding(building, 5, 5)).toBe(false);
    expect(buildingAt(s, 16, 16)?.id).toBe("house");
    expect(buildingAt(s, 5, 5)).toBeNull();
  });
});

describe("collision through the expanded shell", () => {
  it("an avatar leaves through the doorway but is blocked by the wall", () => {
    const exitDoor = createWorldState(expandWorldBuildings(spec()), "me");
    steerFor(exitDoor, 16, 40, 5); // south through the doorway (x=16 ∈ [15,17])
    expect(exitDoor.avatars.me.y).toBeGreaterThan(22);

    const hitWall = createWorldState(expandWorldBuildings(spec({ spawns: [{ id: "s", x: 12, y: 16 }] })), "me");
    steerFor(hitWall, 12, 40, 5); // south through a solid wall span (x=12)
    expect(hitWall.avatars.me.y).toBeLessThan(22);
  });

  it("the generated stairway ramps the avatar's floor", () => {
    const s = createWorldState(expandWorldBuildings(spec()), "me");
    s.avatars.me.x = 12.1; // inside the stair footprint (x≈11.1..13.1, y≈11.1..15.1)
    s.avatars.me.y = 13.1;
    updateAvatarFloor(s, s.avatars.me);
    expect(s.avatars.me.floor).toBeGreaterThan(0);
    expect(s.avatars.me.floor).toBeLessThan(1);
  });
});

describe("buildings — schema", () => {
  it("accepts a valid building", () => {
    expect(validateWorldSpec(spec()).ok).toBe(true);
  });

  it("rejects a doorway that runs off its edge", () => {
    const bad = spec({ buildings: [{ ...building, doorways: [{ edge: "south", offset: 11.5, width: 2 }] }] });
    expect(validateWorldSpec(bad).ok).toBe(false);
  });

  it("rejects fewer than one storey", () => {
    const bad = spec({ buildings: [{ ...building, floors: 0 }] });
    expect(validateWorldSpec(bad).ok).toBe(false);
  });
});
