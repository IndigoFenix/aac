// CONSTRUCTION PHASE 5, STEP 2 — DOORS AS FURNITURE
// (construction-structures.md line 22: "Doorways are part of the wall, but the
// doors themselves should be constructed as furniture pieces.")
//
// The reading the whole step turns on: the `DoorSpec` IS the doorway — the gap
// the wall run leaves. The swinging LEAF is the furniture. So the structure is
// emitted either way, and the ONLY thing `leaf: false` changes is that nothing
// hangs there: no collision, no swing, no lock, no leaf mesh. Routing portals,
// `doorConnectivity` and `visibleBuildings` must be identical.
//
// The other half is the delta: `BuildingDelta.doorless` is the exact mirror of
// `removedPieces`, keyed by the opening's QUANTIZED WORLD MIDPOINT so the two
// rooms that both record a shared doorway produce ONE key — and `absent means
// leaf`, so every worldgen town is untouched.
//
// Pure logic — no DOM / GL, no DB.

import { describe, it, expect } from "@jest/globals";
import {
  accessibleBuildings,
  buildingStructures,
  createWorldState,
  expandWorldBuildings,
  lockDoor,
  makeStructureConstraint,
  routeThroughDoors,
  setDoorOpen,
  setWorldStructures,
  structuresWalkable,
  tickWorld,
  type WorldState,
} from "@shared/world-engine/engine.js";
import { validateWorldSpec } from "@shared/world-engine/schema.js";
import type { BuildingSpec, StructureSpec, WorldSpec } from "@shared/world-engine/types.js";
import {
  createTownDeltas,
  deltaIsEmpty,
  doorlessOf,
  emptyRoom,
  hangDoor,
  markDoorless,
  type SerializedTownDeltas,
} from "@shared/world-engine/kernel/town/construction.js";
import {
  doorwayKeyOf,
  doorwaysWithLeaves,
  houseRoomPlan,
} from "@shared/world-engine/kernel/town/rooms.js";
import { houseFurniture } from "@shared/world-engine/kernel/town/furniture.js";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import { createConstructionDirector, type ConstructionDirectorCtx } from "@shared/world-engine/interaction/quest/construction-director.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import { REAL_SCALE } from "@shared/world-engine/scale.js";

// ─────────────────────────────────────────────────────────────────────────
// ENGINE — what `leaf: false` does, and (just as load-bearing) what it doesn't
// ─────────────────────────────────────────────────────────────────────────

function spec(structures: StructureSpec[], buildings?: BuildingSpec[]): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 40, height: 40 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 10, y: 2, facing: 0 }],
    objects: [],
    structures,
    ...(buildings ? { buildings } : {}),
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

/** The same opening twice — once with a leaf hanging, once bare. */
const doorway = (leaf?: boolean): StructureSpec => ({
  kind: "door",
  id: "d",
  a: { x: 6, y: 8 },
  b: { x: 14, y: 8 },
  thickness: 1,
  ...(leaf === undefined ? {} : { leaf }),
});

const steerFor = (state: WorldState, aimX: number, aimY: number, seconds: number): void => {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) tickWorld(state, { aim: { x: aimX, y: aimY } }, 1 / 60);
};

describe("leaf: false — the opening is a hole in the wall", () => {
  it("never blocks: a shut leafed door does, a bare opening does not", () => {
    const leafed = createWorldState(spec([doorway()]), "me");
    const bare = createWorldState(spec([doorway(false)]), "me");
    // The leafed door starts shut — the pre-phase-5 behaviour, unchanged.
    expect(makeStructureConstraint(leafed)!.walkable({ x: 10, y: 8 }, 0.4)).toBe(false);
    // The bare one is walkable at the very centre of the opening.
    expect(makeStructureConstraint(bare)!.walkable({ x: 10, y: 8 }, 0.4)).toBe(true);
    expect(structuresWalkable(bare, { x: 10, y: 8.2 }, 0.4)).toBe(true);
  });

  it("an avatar walks straight through it with nothing to open", () => {
    const bare = createWorldState(spec([doorway(false)]), "me");
    steerFor(bare, 10, 20, 3);
    expect(bare.avatars.me!.y).toBeGreaterThan(8);
  });

  it("is born OPEN and unlocked; a leafed one is born shut", () => {
    expect(createWorldState(spec([doorway(false)]), "me").doors.d).toEqual({
      id: "d", open: 1, locked: false,
    });
    expect(createWorldState(spec([doorway()]), "me").doors.d!.open).toBe(0);
  });

  it("tickDoors leaves it open — including one whose leaf was BROKEN OFF mid-session", () => {
    // The break path re-streams the SAME door id with `leaf: false`, so the
    // shut state from the leafed era is still sitting there. It must not
    // survive: an opening with no leaf reads open to every consumer.
    const s = createWorldState(spec([doorway()]), "me");
    expect(s.doors.d!.open).toBe(0);
    setWorldStructures(s, [doorway(false)]);
    expect(s.doors.d!.open).toBe(1);
    // And it stays open with nobody near and nobody acting.
    steerFor(s, 10, 2, 1);
    expect(s.doors.d!.open).toBe(1);
  });

  it("setDoorOpen and lockDoor refuse it — there is nothing to swing or to latch", () => {
    const bare = createWorldState(spec([doorway(false)]), "me");
    lockDoor(bare, "d");
    expect(bare.doors.d!.locked).toBe(false);
    setDoorOpen(bare, "d", false);
    steerFor(bare, 10, 2, 0.5);
    expect(bare.doors.d!.open).toBe(1); // still a hole
    expect(bare.doors.d!.pinned).toBeFalsy();
  });

  it("routes and connects exactly like an open door (an open hole is always connected)", () => {
    // Two rooms sharing the y=8 wall, joined by ONE opening.
    const rooms: BuildingSpec[] = [
      { id: "north", footprint: { x: 4, y: 2, w: 12, h: 6 }, floors: 1, stairs: false, wallThickness: 1,
        doorways: [{ edge: "south", offset: 6, width: 4, leaf: false }] },
      { id: "south", footprint: { x: 4, y: 8, w: 12, h: 6 }, floors: 1, stairs: false, wallThickness: 1,
        doorways: [{ edge: "north", offset: 6, width: 4, leaf: false }] },
    ];
    const s = createWorldState(expandWorldBuildings(spec([], rooms)), "me");
    // Routing threads the opening: the leg carries a doorId, not a straight line.
    const pts = routeThroughDoors(s, { x: 10, y: 4 }, { x: 10, y: 12 });
    expect(pts.length).toBeGreaterThan(1);
    expect(pts.some((p) => !!p.doorId)).toBe(true);
    // And the spirit's reachability floods across it with nobody to swing it.
    expect([...accessibleBuildings(s, { x: 10, y: 4 })].sort()).toEqual(["north", "south"]);
  });
});

describe("leaf absent — every existing spec, town and test is unchanged", () => {
  it("buildingStructures emits byte-identical structures when no doorway is bare", () => {
    const b: BuildingSpec = {
      id: "h", footprint: { x: 0, y: 0, w: 10, h: 8 }, floors: 1, stairs: false, wallThickness: 0.4,
      doorways: [{ edge: "north", offset: 5, width: 2 }],
    };
    const withFlag: BuildingSpec = { ...b, doorways: [{ edge: "north", offset: 5, width: 2, leaf: true }] };
    // `leaf: true` is the default meaning, so it must not even reach the spec.
    expect(buildingStructures(withFlag)).toEqual(buildingStructures(b));
    const d = buildingStructures(b).find((s) => s.kind === "door")!;
    expect(d).not.toHaveProperty("leaf");
  });

  it("only `leaf: false` threads through to the generated DoorSpec", () => {
    const b: BuildingSpec = {
      id: "h", footprint: { x: 0, y: 0, w: 10, h: 8 }, floors: 1, stairs: false, wallThickness: 0.4,
      doorways: [{ edge: "north", offset: 5, width: 2, leaf: false }],
    };
    const out = buildingStructures(b);
    const d = out.find((s) => s.kind === "door")!;
    expect(d).toMatchObject({ kind: "door", leaf: false });
    // THE INVARIANT: the doorway is still cut. Walls + door count and geometry
    // are what they always were — only the flag rides along.
    const leafed = buildingStructures({ ...b, doorways: [{ edge: "north", offset: 5, width: 2 }] });
    expect(out.map((s) => s.id)).toEqual(leafed.map((s) => s.id));
    expect({ ...d, leaf: undefined }).toEqual({ ...leafed.find((s) => s.kind === "door")!, leaf: undefined });
  });

  it("a bare opening validates (the strict schema declares the flag)", () => {
    const s = spec([doorway(false)]);
    expect(validateWorldSpec(s).ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE DOORWAY KEY — why it is the world midpoint and nothing else
// ─────────────────────────────────────────────────────────────────────────

const CONFIG = { seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 };

describe("doorwayKeyOf — one opening, one key", () => {
  it("the two rooms that SHARE an interior doorway agree on its key", () => {
    const play = buildTownPlay(CONFIG);
    // A partitioned house: its interior doorway is recorded on both rooms, in
    // opposite winding, with offsets measured from each room's own min corner.
    const house = play.plan.houses.find(
      (h) => houseRoomPlan(play.stage.center, h).rooms.length > 1,
    )!;
    expect(house).toBeDefined();
    const rooms = houseRoomPlan(play.stage.center, house).rooms;
    const keysByRoom = rooms.map((r) => r.doorways.map((d) => doorwayKeyOf(r, d)));
    // Some key appears on two different rooms — that is the shared opening,
    // and the two records collapsed onto ONE string.
    const counts = new Map<string, number>();
    for (const ks of keysByRoom) for (const k of new Set(ks)) counts.set(k, (counts.get(k) ?? 0) + 1);
    const shared = [...counts.entries()].filter(([, n]) => n > 1);
    expect(shared.length).toBeGreaterThan(0);
    // Sanity: the rooms genuinely differ (it is not one room counted twice).
    for (const [k] of shared) {
      const owners = rooms.filter((r) => r.doorways.some((d) => doorwayKeyOf(r, d) === k));
      expect(new Set(owners.map((r) => r.id)).size).toBeGreaterThan(1);
    }
  });

  it("doorwaysWithLeaves marks exactly the listed openings and nothing else", () => {
    const play = buildTownPlay(CONFIG);
    const house = play.plan.houses.find(
      (h) => houseRoomPlan(play.stage.center, h).rooms.length > 1,
    )!;
    const room = houseRoomPlan(play.stage.center, house).rooms[0]!;
    const target = doorwayKeyOf(room, room.doorways[0]!);
    // Empty set = the plan's records verbatim (the worldgen path).
    expect(doorwaysWithLeaves(room, room.doorways, new Set())).toEqual(
      room.doorways.map((d) => ({ ...d })),
    );
    const marked = doorwaysWithLeaves(room, room.doorways, new Set([target]));
    expect(marked.filter((d) => d.leaf === false)).toHaveLength(1);
    expect(doorwayKeyOf(room, marked.find((d) => d.leaf === false)!)).toBe(target);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE DELTA — `doorless`, the mirror of `removedPieces`
// ─────────────────────────────────────────────────────────────────────────

describe("BuildingDelta.doorless", () => {
  it("round-trips toJSON and counts toward deltaIsEmpty", () => {
    const deltas = createTownDeltas();
    expect(deltaIsEmpty(deltas.get("f_0"))).toBe(true);
    expect(markDoorless(deltas, "f_0", ["120,340", "500,660"])).toBe(true);
    expect(deltaIsEmpty(deltas.get("f_0"))).toBe(false);
    const back = createTownDeltas(
      JSON.parse(JSON.stringify(deltas.toJSON())) as SerializedTownDeltas,
    );
    expect(back.get("f_0")!.doorless).toEqual(["120,340", "500,660"]);
    expect([...doorlessOf(back.get("f_0"))].sort()).toEqual(["120,340", "500,660"]);
  });

  it("markDoorless is idempotent — re-seeding a finished shell never re-bumps the rev", () => {
    const deltas = createTownDeltas();
    markDoorless(deltas, "f_0", ["1,2"]);
    const rev = deltas.get("f_0")!.rev;
    expect(markDoorless(deltas, "f_0", ["1,2"])).toBe(false);
    expect(deltas.get("f_0")!.rev).toBe(rev);
  });

  it("hangDoor drops the key AND records the leaf in one move", () => {
    const deltas = createTownDeltas();
    markDoorless(deltas, "f_0", ["1,2", "3,4"]);
    const leaf = {
      id: "furn_w0_p0", kind: "door" as const, x: 0.01, y: 0.02,
      radius: 0.5, facing: 0, openable: false, roomId: "w_0", doorway: "1,2",
    };
    expect(hangDoor(deltas, "f_0", leaf)).toBe(true);
    expect(deltas.get("f_0")!.doorless).toEqual(["3,4"]);
    expect(deltas.get("f_0")!.placed.map((p) => p.id)).toEqual(["furn_w0_p0"]);
    // A second hang on the same opening refuses — the key is gone, so there is
    // nothing left to fill and a duplicate leaf can never be recorded.
    expect(hangDoor(deltas, "f_0", { ...leaf, id: "furn_w0_p1" })).toBe(false);
    expect(deltas.get("f_0")!.placed).toHaveLength(1);
  });

  it("a hung leaf is not floor furniture — furnishPlan never emits it", () => {
    const play = buildTownPlay(CONFIG);
    const house = play.plan.houses[0]!;
    const key = `h_${house.index}`;
    const goodDefs = play.stage.goods.map((g) => ({ key: g.good.key, slot: g.good.slot }));
    const room = houseRoomPlan(play.stage.center, house).rooms[0]!;
    const before = houseFurniture(play.stage.center, house, goodDefs, "", play.deltas.get(key));
    play.deltas.mutate(key, (d) => {
      d.placed.push({
        id: `furn_${house.index}_p0`, kind: "door",
        x: room.rect.x + 1, y: room.rect.y,
        radius: 0.5, facing: 0, openable: false, roomId: room.id, doorway: "9,9",
      });
    });
    const after = houseFurniture(play.stage.center, house, goodDefs, "", play.deltas.get(key));
    // Not an obstacle, not an object, not a kind the room derives from.
    expect(after.map((p) => p.id)).toEqual(before.map((p) => p.id));
    expect(after.some((p) => p.kind === "door")).toBe(false);
  });

  // …but a SPOKEN "break the door" searches a different set, and must find it.
  // The two consumers want opposite answers about the same row, and both are
  // right: placement/kind-derivation must not see a leaf, the sentence must.
  // The bug this guards is a real one that shipped for an afternoon — the
  // resolver went through furnishPlan, so the child said "break the door" and
  // was told there was no door, about a door plainly hanging in front of them,
  // while the board's own break path worked. If someone ever "tidies up" by
  // stripping doorway rows out of `delta.placed` itself, this fails.
  it("a hung leaf IS findable by kind for the spoken break path", () => {
    const play = buildTownPlay(CONFIG);
    const house = play.plan.houses[0]!;
    const key = `h_${house.index}`;
    const goodDefs = play.stage.goods.map((g) => ({ key: g.good.key, slot: g.good.slot }));
    const room = houseRoomPlan(play.stage.center, house).rooms[0]!;
    play.deltas.mutate(key, (d) => {
      d.placed.push({
        id: `furn_${house.index}_p0`, kind: "door",
        x: room.rect.x + 1, y: room.rect.y,
        radius: 0.5, facing: 0, openable: false, roomId: room.id, doorway: "9,9",
      });
    });
    const delta = play.deltas.get(key);
    // The union quest-host's `spokenBuildingOf` now hands to the resolver.
    const searched = [
      ...houseFurniture(play.stage.center, house, goodDefs, "", delta),
      ...(delta?.placed ?? []).filter((p) => p.doorway !== undefined),
    ];
    const found = searched.filter((p) => p.kind === "door");
    expect(found).toHaveLength(1);
    // It carries the coordinates the nearest-piece tie-break needs.
    expect(found[0]!.x).toBeCloseTo(room.rect.x + 1, 6);
    expect(found[0]!.id).toBe(`furn_${house.index}_p0`);
  });

  it("emptying a room leaves the door on the wall (doorways are part of the wall)", () => {
    const play = buildTownPlay(CONFIG);
    const house = play.plan.houses[0]!;
    const key = `h_${house.index}`;
    const plan = houseRoomPlan(play.stage.center, house, play.deltas.get(key));
    const room = plan.rooms[0]!;
    play.deltas.mutate(key, (d) => {
      d.placed.push({
        id: `furn_${house.index}_p0`, kind: "door",
        x: room.rect.x + 1, y: room.rect.y,
        radius: 0.5, facing: 0, openable: false, roomId: room.id, doorway: "9,9",
      });
      d.placed.push({
        id: `furn_${house.index}_p1`, kind: "chair",
        x: room.rect.x + 2, y: room.rect.y + 2,
        radius: 0.22, facing: 0, openable: false, roomId: room.id,
      });
    });
    const res = emptyRoom(play.deltas, key, plan, room.id);
    expect(res.ok).toBe(true);
    // The chair stows and mints its stack; the leaf does neither — stowing it
    // would mint a `furn.door` while the leaf kept hanging (a duplicated unit).
    expect(res.ok && res.stowed).toMatchObject({ chair: 1 });
    expect(res.ok && res.stowed.door).toBeUndefined();
    expect(play.deltas.get(key)!.placed.map((p) => p.id)).toEqual([`furn_${house.index}_p0`]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// HANG → the leaf really appears; BREAK → the opening really goes bare
// ─────────────────────────────────────────────────────────────────────────

/** The phase-4 director harness (town-construction-phase4.test.ts), verbatim:
 *  a lived-in town, a headless world (so a broken piece BANKS its stack rather
 *  than dropping loose), and every host closure the director captures. */
function harness() {
  const play = buildTownPlay(CONFIG);
  const toasts: string[] = [];
  const session = {
    town: play,
    townClock: 0,
    scale: REAL_SCALE,
    containerStock: new Map<string, Record<string, number>>(),
    // A container is a REGISTRATION plus a stock, and breaking a piece clears
    // both — a box that is no longer standing is no longer a place to put
    // things. A stub with the stock and not the registration is half a session.
    containers: new Map<string, "in" | "on">(),
    containerOwner: new Map<string, string | null>(),
    marketStore: new Map<string, unknown>(),
    produceBox: new Map<string, unknown>(),
    houseShown: new Set<number>(),
    transfers: play.deltas.transfers,
    reservations: play.deltas.reservations,
    taskClock: 0,
  } as unknown as QuestSession;
  const ctx = {
    presenter: { toast: (m: string) => { toasts.push(m); } },
    familyOf: () => null,
    npcChatBubble: () => {},
    spawnLooseProp: () => null,
    removeLooseProp: () => {},
    postPooledTask: () => {},
    stockEndpointOf: () => null,
    containerAnchor: () => null,
    houseContainerKeys: () => [],
    playerWorldPos: () => null,
    playerFocusArea: () => null,
    townShortage: () => 0,
    invalidateTownJobs: () => {},
    questViewOf: () => null,
    spiritFocusOf: () => null,
    convoNodeId: () => null,
  } as unknown as ConstructionDirectorCtx;
  return { play, session, toasts, director: createConstructionDirector(ctx) };
}

describe("the leaf hangs, and comes off again", () => {
  /** The staged BuildingSpec doorways of one room, resolved against the
   *  building's live `doorless` — exactly what town-stage composes. */
  const stagedDoorways = (
    play: ReturnType<typeof buildTownPlay>,
    key: string,
    room: { rect: { x: number; y: number; w: number; h: number }; doorways: Array<{ edge: "north" | "south" | "east" | "west"; offset: number; width: number }> },
  ) => doorwaysWithLeaves(room, room.doorways, doorlessOf(play.deltas.get(key)));

  it("INSTALL: hanging a leaf drops the key and the staged doorway stops being bare", () => {
    const play = buildTownPlay(CONFIG);
    const house = play.plan.houses[0]!;
    const key = `h_${house.index}`;
    const room = houseRoomPlan(play.stage.center, house).rooms[0]!;
    const d = room.doorways[0]!;
    const dk = doorwayKeyOf(room, d);
    markDoorless(play.deltas, key, [dk]);

    // BARE: the staged doorway carries leaf:false, and the engine's generated
    // door structure does too — so it is walkable and never swings.
    const bare = stagedDoorways(play, key, room);
    expect(bare.find((x) => x.leaf === false)).toBeDefined();
    const bareDoor = buildingStructures({
      id: room.id, footprint: room.rect, floors: 1, stairs: false, wallThickness: 0.4,
      doorways: bare,
    }).find((s) => s.kind === "door" && s.leaf === false);
    expect(bareDoor).toBeDefined();

    // HANG IT.
    expect(hangDoor(play.deltas, key, {
      id: `furn_${house.index}_p0`, kind: "door",
      x: room.rect.x + d.offset, y: room.rect.y,
      radius: 0.5, facing: 0, openable: false, roomId: room.id, doorway: dk,
    })).toBe(true);

    // HUNG: the key is gone, the leaf row is recorded, and the staged doorways
    // are back to the plan's own records — leaf flag absent, meaning it hangs.
    expect(play.deltas.get(key)!.doorless).toEqual([]);
    expect(play.deltas.get(key)!.placed.find((p) => p.doorway === dk)).toBeDefined();
    const hung = stagedDoorways(play, key, room);
    expect(hung.every((x) => x.leaf === undefined)).toBe(true);
    expect(
      buildingStructures({
        id: room.id, footprint: room.rect, floors: 1, stairs: false, wallThickness: 0.4,
        doorways: hung,
      }).every((s) => s.kind !== "door" || s.leaf === undefined),
    ).toBe(true);
  });

  it("BREAK: taking a hung door off pushes its key back and mints one furn.door", () => {
    const { play, session, toasts, director } = harness();
    const house = play.plan.houses[0]!;
    const key = `h_${house.index}`;
    const room = houseRoomPlan(play.stage.center, house).rooms[0]!;
    const dk = doorwayKeyOf(room, room.doorways[0]!);
    play.deltas.mutate(key, (d) => {
      d.placed.push({
        id: `furn_${house.index}_p0`, kind: "door",
        x: room.rect.x + room.doorways[0]!.offset, y: room.rect.y,
        radius: 0.5, facing: 0, openable: false, roomId: room.id, doorway: dk,
      });
    });
    expect(director.orderBreakPiece(session, key, `furn_${house.index}_p0`)).toBe(true);
    // The opening goes bare again...
    expect(play.deltas.get(key)!.doorless).toEqual([dk]);
    expect(play.deltas.get(key)!.placed.map((p) => p.id)).not.toContain(`furn_${house.index}_p0`);
    // ...and the leaf becomes a real unit (headless ⇒ banked, never vanished).
    expect(play.deltas.stock["furn.door"]).toBe(1);
    expect(toasts.some((t) => t.includes("off its hinges"))).toBe(true);
    // Breaking a door DESIGNATES NOTHING — no program row may come off for it.
    expect(play.deltas.get(key)!.programs ?? []).toHaveLength(0);
  });
});
