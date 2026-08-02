// THE BLUEPRINT AND THE HOUSE (kernel/town/blueprint.ts), at the pure layer.
//
// The law under test, in one line: furniture IS supposed to be rearranged, it
// is just not supposed to rearrange ITSELF. So the drawing (where things
// belong) and the house (where things are) are two values, they are allowed to
// disagree, and the disagreement is a WORK LIST somebody walks — never a
// teleport, and never a permanent pin either.
//
// No DOM / GL / session.

import { describe, it, expect } from "@jest/globals";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import {
  AT_SLOT_M,
  blueprintDelta,
  blueprintSlots,
  hasDrift,
  materializedRows,
  pieceAtItsSlot,
  reconcileFurnishing,
  type BlueprintSlot,
} from "@shared/world-engine/kernel/town/blueprint.js";
import {
  annexOptions,
  emptyDelta,
  placeFurniture,
  removePlacedPiece,
  requestAnnex,
  type BuildingDelta,
  type PlacedPiece,
} from "@shared/world-engine/kernel/town/construction.js";
import { houseFurniture } from "@shared/world-engine/kernel/town/furniture.js";
import { houseRoomPlan } from "@shared/world-engine/kernel/town/rooms.js";
import { ANNEX_ORDER } from "@shared/world-engine/interaction/town/structure-board.js";
import type { FurniturePiece } from "@shared/world-engine/kernel/town/placement.js";
import type { StationKind } from "@shared/world-engine/kernel/town/stations.js";

const piece = (
  id: string,
  kind: StationKind,
  x: number,
  y: number,
  extra: Partial<FurniturePiece> = {},
): FurniturePiece => ({ id, kind, x, y, radius: 0.4, facing: 0, openable: false, ...extra });

const slot = (
  id: string,
  kind: StationKind,
  x: number,
  y: number,
  roomId = "r1",
): BlueprintSlot => ({ ...piece(id, kind, x, y), roomId });

const NOTHING_STORED = () => 0;

describe("blueprintDelta — the drawing does not see where things drifted to", () => {
  const base = (): BuildingDelta => ({
    ...emptyDelta(),
    placed: [
      {
        id: "own", kind: "chair", x: 1, y: 1, radius: 0.2, facing: 0,
        openable: false, roomId: "r1", pinned: true,
      },
      {
        id: "furn_3_bed_0", kind: "bed", x: 9, y: 9, radius: 0.5, facing: 0,
        openable: false, roomId: "r1",
      },
    ],
    removedPieces: ["broken_chair"],
    materialized: true,
  });

  it("CLEARS `materialized` — the house stops generating, the drawing never does", () => {
    // The whole split in one field. The station generator is the only thing that
    // knows where a bed belongs in a house shaped like this, so it has to keep
    // answering for as long as the house keeps changing shape; what has to stop
    // is reading its answer as the furniture.
    const bp = blueprintDelta(base())!;
    expect(bp.materialized).toBe(false);
    expect(bp.placed.map((p) => p.id)).toEqual(["own"]);
    // A genuine removal stays withheld — never re-order what the player tore out.
    expect(bp.removedPieces).toEqual(["broken_chair"]);
  });

  it("keeps what the PLAYER PINNED — a spoken order is a change to the drawing", () => {
    expect(blueprintDelta(base())!.placed.map((p) => p.id)).toEqual(["own"]);
  });

  it("re-slots an AUTONOMOUS placement — the oven follows the kitchen it never had", () => {
    // The user's own example. A delivery lands wherever the search of the day
    // ranked first; that says where the piece IS, not where it belongs. Reading
    // it as a decision would make "a house with kitchen things in the main room,
    // given a kitchen, moves them in" impossible by construction — the main room
    // would be their rightful place forever.
    const d = base();
    delete d.placed[0]!.pinned;
    expect(blueprintDelta(d)!.placed).toEqual([]);
  });

  it("leaves a HUNG DOOR alone — a leaf is part of the wall, not the furniture", () => {
    const d: BuildingDelta = {
      ...emptyDelta(),
      placed: [{
        id: "leaf", kind: "door", x: 2, y: 0, radius: 0.2, facing: 0,
        openable: false, roomId: "r1", doorway: "r1:north:2",
      }],
    };
    expect(blueprintDelta(d)).toBe(d);
  });

  it("returns the delta UNCHANGED when nothing has drifted (the common case)", () => {
    // Identity, not just equality: every memo downstream keys on the reference,
    // and this path runs for every untouched building in a town.
    const d = { ...emptyDelta(), placed: [], removedPieces: ["broken_chair"] };
    expect(blueprintDelta(d)).toBe(d);
    expect(blueprintDelta(undefined)).toBeUndefined();
  });

  it("hasDrift is the cheap gate the reconciling sweeps ask first", () => {
    expect(hasDrift(base())).toBe(true);
    expect(hasDrift(emptyDelta())).toBe(false);
    expect(hasDrift(undefined)).toBe(false);
    const pinnedOnly: BuildingDelta = {
      ...emptyDelta(),
      placed: [{
        id: "own", kind: "chair", x: 1, y: 1, radius: 0.2, facing: 0,
        openable: false, roomId: "r1", pinned: true,
      }],
    };
    expect(hasDrift(pinnedOnly)).toBe(false);
  });
});

describe("materializedRows — making the furniture real", () => {
  const rooms = [
    { id: "r1", kind: "living", rect: { x: 0, y: 0, w: 6, h: 4 }, doorways: [] },
    { id: "r2", kind: "bedroom", rect: { x: 0, y: 4, w: 6, h: 3 }, doorways: [] },
  ] as unknown as Parameters<typeof materializedRows>[1];

  it("keeps the SAME id, so nothing keyed on a piece is orphaned", () => {
    // Container stock maps, use-anchors, the goods bindings and the break path
    // all key on the piece id; re-numbering would silently empty a chest.
    const rows = materializedRows(
      [piece("furn_3_chest_0", "chest", 4, 2, { setUp: false, good: "food" })],
      rooms, [],
    );
    expect(rows).toEqual([expect.objectContaining({
      id: "furn_3_chest_0", roomId: "r1", setUp: false, good: "food",
    })]);
  });

  it("files each piece under the room it stands in", () => {
    const rows = materializedRows([piece("a", "bed", 3, 5)], rooms, []);
    expect(rows[0]!.roomId).toBe("r2");
  });

  it("never re-records a piece that is already a row", () => {
    // Materializing twice must not duplicate the furniture — the flag is set
    // once, but the guard is what makes that safe rather than merely true.
    const existing = [{
      id: "a", kind: "bed" as StationKind, x: 3, y: 5, radius: 0.5,
      facing: 0, openable: false, roomId: "r2",
    }];
    expect(materializedRows([piece("a", "bed", 3, 5)], rooms, existing)).toEqual([]);
  });

  it("records a piece standing outside every room rather than losing it", () => {
    // It happens on the frame a room comes down. Dropping it would destroy
    // furniture; the work list carries it somewhere sensible instead.
    const rows = materializedRows([piece("stray", "chair", 99, 99)], rooms, []);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.roomId).toBe("r1");
  });
});

describe("reconcileFurnishing — the difference, as a work list", () => {
  it("a house standing on its own drawing owes NOTHING", () => {
    // The safety property the whole split rests on: for a building nobody has
    // changed, the drawing and the furniture are the same derivation, so no
    // sweep anywhere can find work to do. An untouched town stays untouched.
    const slots = [slot("a", "table", 3, 3), slot("b", "chair", 4, 3)];
    const standing = [piece("a", "table", 3, 3), piece("b", "chair", 4, 3)];
    expect(reconcileFurnishing({ slots, standing, stored: NOTHING_STORED })).toEqual([]);
  });

  it("forgives a few centimetres — nobody carries a bed 4 cm across a room", () => {
    const slots = [slot("a", "bed", 3, 3)];
    const standing = [piece("a", "bed", 3 + AT_SLOT_M / 2, 3)];
    expect(reconcileFurnishing({ slots, standing, stored: NOTHING_STORED })).toEqual([]);
  });

  it("MOVES a piece that is already in the house instead of making a second one", () => {
    // THE LAW the user stated: "Items in the house that don't match their
    // blueprint positions should be considered available, so they get moved
    // instead of new items being crafted." A house does not commission a second
    // bed while the first stands in the hall.
    const slots = [slot("bed@bedroom", "bed", 10, 2, "bedroom")];
    const standing = [piece("furn_3_bed_0", "bed", 1, 1)];
    const tasks = reconcileFurnishing({ slots, standing, stored: () => 5 });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ act: "move", kind: "bed" });
    expect(tasks[0]!.from!.id).toBe("furn_3_bed_0");
    expect(tasks[0]!.slot!.roomId).toBe("bedroom");
  });

  it("carries the NEAREST one — a household does not cross the house for nothing", () => {
    const slots = [slot("s", "chair", 10, 10)];
    const standing = [piece("far", "chair", 0, 0), piece("near", "chair", 9, 10)];
    const tasks = reconcileFurnishing({ slots, standing, stored: NOTHING_STORED });
    expect(tasks.filter((t) => t.act === "move")[0]!.from!.id).toBe("near");
    // And the one left over has no place in the drawing at all.
    expect(tasks.filter((t) => t.act === "deconstruct").map((t) => t.from!.id)).toEqual(["far"]);
  });

  it("installs from a box before making, and makes only when there is none", () => {
    const slots = [slot("s", "bed", 1, 1)];
    expect(
      reconcileFurnishing({ slots, standing: [], stored: (k) => (k === "bed" ? 1 : 0) })[0],
    ).toMatchObject({ act: "install", kind: "bed" });
    expect(
      reconcileFurnishing({ slots, standing: [], stored: NOTHING_STORED })[0],
    ).toMatchObject({ act: "make", kind: "bed" });
  });

  it("spends the stored units as it promises them — one bed cannot fill two rooms", () => {
    const slots = [slot("s1", "bed", 1, 1, "r1"), slot("s2", "bed", 9, 9, "r2")];
    const tasks = reconcileFurnishing({
      slots, standing: [], stored: (k) => (k === "bed" ? 1 : 0),
    });
    expect(tasks.map((t) => t.act)).toEqual(["install", "make"]);
  });

  it("ROOM-SCOPED by construction: a filled bedroom never answers for an empty one", () => {
    // THE DEAD GATE this replaces. The want-derivation used to ask "does any
    // room of this kind meet the program", so the original bedroom's bed
    // satisfied a freshly-ordered second bedroom — and the annex was then never
    // outlined, never crafted and never furnished. Slots are per-place, so the
    // question cannot even be phrased that way any more.
    const slots = [slot("s1", "bed", 1, 1, "bedroom_a"), slot("s2", "bed", 9, 9, "bedroom_b")];
    const standing = [piece("s1", "bed", 1, 1)];
    const tasks = reconcileFurnishing({ slots, standing, stored: NOTHING_STORED });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ act: "make", kind: "bed" });
    expect(tasks[0]!.slot!.roomId).toBe("bedroom_b");
  });

  it("MAKES for a room that has not risen yet — the bed and the walls go up together", () => {
    // "Furniture can actually start getting crafted before the room even
    // exists, if it exists in the blueprint and is not available already."
    // There is no slot to name (no floor), so the task carries none.
    const tasks = reconcileFurnishing({
      slots: [], standing: [], stored: NOTHING_STORED, pending: ["bed"],
    });
    expect(tasks).toEqual([{ act: "make", kind: "bed" }]);
  });

  it("HOLDS a spare for the room being built instead of stowing then re-making it", () => {
    // Without the hold, the leftover bed would be carried to a box on one sweep
    // and a second bed commissioned on the next — the house paying twice for
    // furniture it already owns.
    const tasks = reconcileFurnishing({
      slots: [], standing: [piece("spare", "bed", 2, 2)], stored: NOTHING_STORED, pending: ["bed"],
    });
    expect(tasks).toEqual([]);
  });

  it("waits on a stored unit rather than making a second — nothing to do yet", () => {
    const tasks = reconcileFurnishing({
      slots: [], standing: [], stored: (k) => (k === "bed" ? 1 : 0), pending: ["bed"],
    });
    expect(tasks).toEqual([]);
  });

  it("LINKS to the piece already there, and RE-OPENS the request when it vanishes", () => {
    // The link is re-derived every pass and never stored on the slot, which is
    // what makes the drawing self-correcting: remove the piece by any means at
    // all and the very next pass says the place needs one again. No unlinking
    // step, no bookkeeping, nowhere for the two to drift apart.
    const slots = [slot("s", "bed", 3, 3, "bedroom")];
    const bed = piece("furn_3_bed_0", "bed", 3, 3);
    expect(reconcileFurnishing({ slots, standing: [bed], stored: NOTHING_STORED })).toEqual([]);
    expect(reconcileFurnishing({ slots, standing: [], stored: NOTHING_STORED })).toEqual([
      { act: "make", kind: "bed", slot: slots[0] },
    ]);
  });

  it("A PLACE IS NOT A POSSESSION — breaking the stove leaves the place wanting one", () => {
    // THE DEAD END the user watched: pieces were deconstructed to clear a path,
    // and the blueprint slot went with them, so the room was never re-furnished
    // ("things got deconstructed and stowed away, nothing else got placed").
    // The drawing says a stove goes HERE. It does not care whether a stove
    // exists, was taken apart, or never existed in the first place — the place
    // stays, and an empty place is a want.
    const slots = [slot("stove@kitchen", "oven", 9, 2, "kitchen")];
    expect(reconcileFurnishing({ slots, standing: [], stored: NOTHING_STORED })).toEqual([
      { act: "make", kind: "oven", slot: slots[0] },
    ]);
    // …and the moment one turns up anywhere in the house, it is carried there.
    expect(
      reconcileFurnishing({ slots, standing: [piece("loose", "oven", 1, 1)], stored: NOTHING_STORED }),
    ).toEqual([expect.objectContaining({ act: "move", from: expect.objectContaining({ id: "loose" }) })]);
  });

  it("DECONSTRUCTS what the drawing has no place for under the new plans", () => {
    // A re-draw produces this as readily as it produces a want: a chest whose
    // room came down, a fourth chair around a table that seats three. It comes
    // apart where it stands and goes back into circulation as an item.
    const tasks = reconcileFurnishing({
      slots: [], standing: [piece("spare", "chair", 2, 2)], stored: NOTHING_STORED,
    });
    expect(tasks).toEqual([
      { act: "deconstruct", kind: "chair", from: expect.objectContaining({ id: "spare" }) },
    ]);
  });

  it("CARRIES the street-good box too — the refrigerator does not teleport", () => {
    // THE REPORTED DEFECT. A goods box used to be exempt from every
    // furniture-editing path, because the generator re-emitted it
    // unconditionally and touching one duplicated a unit. Once the building is
    // materialized that trap is gone — and it has to be, because the corner
    // rule moves a fridge into the kitchen the day a kitchen appears, and that
    // is a carry like any other rather than something that happens in a frame.
    const tasks = reconcileFurnishing({
      slots: [{ ...slot("pantry", "chest", 0, 0), good: "food" }],
      standing: [piece("pantry_now", "chest", 8, 8, { good: "food" })],
      stored: NOTHING_STORED,
    });
    expect(tasks).toEqual([
      expect.objectContaining({ act: "move", from: expect.objectContaining({ id: "pantry_now" }) }),
    ]);
  });

  it("never mistakes a plain chest for the pantry, in either direction", () => {
    // Two chests are not interchangeable when one of them is a good's own box:
    // a bare chest must not be carried into the pantry's corner, and the pantry
    // must not be carried off to fill a store room's slot.
    const tasks = reconcileFurnishing({
      slots: [{ ...slot("pantry", "chest", 0, 0), good: "food" }, slot("store", "chest", 5, 5)],
      standing: [piece("plain", "chest", 1, 1), piece("box_food", "chest", 6, 6, { good: "food" })],
      stored: NOTHING_STORED,
    });
    expect(tasks.map((t) => [t.act, t.slot?.id, t.from?.id])).toEqual([
      ["move", "pantry", "box_food"],
      ["move", "store", "plain"],
    ]);
  });

  it("NEVER deconstructs a goods box — a household without its pantry cannot shop", () => {
    const tasks = reconcileFurnishing({
      slots: [],
      standing: [piece("box_food", "chest", 6, 6, { good: "food" })],
      stored: NOTHING_STORED,
    });
    expect(tasks).toEqual([]);
  });

  it("SURPLUS FIRST: the removal set is worked out before any want is answered", () => {
    // The user's own statement of the algorithm: "first mark all furniture that
    // needs to be removed, and then for each blueprint position that needs
    // filling, first check among those furniture pieces … If none is found, a
    // standing order is retained."
    //
    // Here a bedroom moved and a chair became spare. The bed is surplus, so the
    // new bedroom draws on it rather than ordering one; the chair is surplus and
    // nothing wants it, so it comes apart. Both facts are settled by the same
    // pass, which is why the house cannot both order a bed and throw one away.
    const slots = [slot("bed@new", "bed", 20, 20, "bedroom_b"), slot("t", "table", 3, 3)];
    const standing = [
      piece("bed_old", "bed", 1, 1),
      piece("chair_spare", "chair", 2, 2),
      piece("t", "table", 3, 3),
    ];
    expect(reconcileFurnishing({ slots, standing, stored: () => 9 })).toEqual([
      expect.objectContaining({ act: "move", from: expect.objectContaining({ id: "bed_old" }) }),
      expect.objectContaining({ act: "deconstruct", from: expect.objectContaining({ id: "chair_spare" }) }),
    ]);
  });

  it("keeps a STANDING ORDER only when the surplus and the store are both empty", () => {
    const slots = [slot("s", "bed", 5, 5)];
    // Surplus has one → carry it.
    expect(
      reconcileFurnishing({ slots, standing: [piece("b", "bed", 0, 0)], stored: () => 3 })[0]!.act,
    ).toBe("move");
    // None standing, one in a box → install it.
    expect(reconcileFurnishing({ slots, standing: [], stored: () => 3 })[0]!.act).toBe("install");
    // Neither → the place keeps asking.
    expect(reconcileFurnishing({ slots, standing: [], stored: NOTHING_STORED })[0]!.act).toBe("make");
  });

  it("is deterministic — the same house answers the same way every time", () => {
    const input = {
      slots: [slot("s1", "chair", 5, 5), slot("s2", "chair", 6, 5)],
      standing: [piece("a", "chair", 5.5, 5), piece("b", "chair", 5.5, 5), piece("c", "table", 0, 0)],
      stored: NOTHING_STORED,
    };
    expect(reconcileFurnishing(input)).toEqual(reconcileFurnishing(input));
  });
});

describe("pieceAtItsSlot — what the bump rule asks before it breaks anything", () => {
  const slots = [slot("s", "chest", 4, 4)];

  it("says yes for a piece standing on its mark (walking into your own table breaks nothing)", () => {
    expect(pieceAtItsSlot({ id: "s", kind: "chest", x: 4, y: 4 }, slots)).toBe(true);
  });

  it("says no for one the drawing does not account for", () => {
    expect(pieceAtItsSlot({ id: "s", kind: "chest", x: 4, y: 7 }, slots)).toBe(false);
    expect(pieceAtItsSlot({ id: "s", kind: "bed", x: 4, y: 4 }, slots)).toBe(false);
  });
});

/**
 * A CARRY IS A LIFT AND A LANDING (2026-08-02). `movePlacedPiece` — which
 * rewrote a row's coordinates in place — is deliberately gone: it was the
 * teleport, because the piece stood on its old mark for the whole walk and the
 * row was edited at the far end. The director now takes the row OUT of the
 * building (`removePlacedPiece`), holds it whole while a token rides in the
 * carrier's hands, and puts it back (`placeFurniture`) on arrival.
 *
 * These pin the algebra that makes that safe. The director's own halves are
 * closure-private, but what they must never lose is testable right here.
 */
describe("lift and land — a piece is in exactly one place, and comes back whole", () => {
  const fridge = (): PlacedPiece => ({
    id: "furn_0_goods_food",
    kind: "refrigerator" as StationKind,
    x: 4,
    y: 7,
    radius: 0.5,
    facing: 1,
    openable: true,
    roomId: "r_kitchen",
    // The two fields a carry could silently drop: the street-good binding that
    // makes this box the food economy's delivery point, and a player's own
    // choice of spot.
    good: "food",
    pinned: true,
  });

  const lift = (deltas: ReturnType<typeof buildTownPlay>["deltas"], key: string, id: string) => {
    const row = deltas.get(key)!.placed.find((p) => p.id === id)!;
    const held: PlacedPiece = { ...row };
    removePlacedPiece(deltas, key, id);
    return held;
  };

  function stagedTown() {
    const play = buildTownPlay({ seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 });
    const key = `h_${play.plan.houses[0]!.index}`;
    play.deltas.mutate(key, (d) => {
      d.materialized = true;
      d.placed.push(fridge());
    });
    return { play, key };
  }

  it("THE PIECE IS OFF THE FLOOR WHILE IT IS IN HANDS — never in two places", () => {
    const { play, key } = stagedTown();
    lift(play.deltas, key, "furn_0_goods_food");
    // Mid-carry the building holds no such row. That is the whole difference
    // from the teleport, where the piece never left its old mark.
    expect(play.deltas.get(key)!.placed.some((p) => p.id === "furn_0_goods_food")).toBe(false);
  });

  it("and lands WHOLE — a carried refrigerator is still the food box", () => {
    const { play, key } = stagedTown();
    const held = lift(play.deltas, key, "furn_0_goods_food");
    placeFurniture(play.deltas, key, { ...held, x: 11, y: 2, facing: 3, roomId: "r_new" });
    const landed = play.deltas.get(key)!.placed.find((p) => p.id === "furn_0_goods_food")!;
    expect(landed.good).toBe("food"); // the economy still delivers here
    expect(landed.pinned).toBe(true); // the player's choice survived the trip
    expect(landed.openable).toBe(true);
    expect(landed.kind).toBe("refrigerator");
    expect({ x: landed.x, y: landed.y, facing: landed.facing, roomId: landed.roomId }).toEqual({
      x: 11, y: 2, facing: 3, roomId: "r_new",
    });
  });

  it("AN INTERRUPTED CARRY LEAVES THE PIECE EXACTLY WHERE IT WAS", () => {
    // The recovery sweep's contract: the body was re-tasked mid-trip, so the
    // held row goes back unchanged rather than landing somewhere it was never
    // asked to go. The law the old sweep got for free by never lifting.
    const { play, key } = stagedTown();
    const held = lift(play.deltas, key, "furn_0_goods_food");
    placeFurniture(play.deltas, key, held);
    expect(play.deltas.get(key)!.placed.find((p) => p.id === "furn_0_goods_food")).toEqual(fridge());
  });

  it("exactly ONE row for the piece after a full lift-and-land cycle", () => {
    const { play, key } = stagedTown();
    const held = lift(play.deltas, key, "furn_0_goods_food");
    placeFurniture(play.deltas, key, { ...held, x: 11, y: 2 });
    expect(play.deltas.get(key)!.placed.filter((p) => p.id === "furn_0_goods_food")).toHaveLength(1);
  });
});

describe("a real house, extended — the drawing moves and the furniture does not", () => {
  // The whole split, end to end at the kernel layer. Take a town house, MAKE
  // ITS FURNITURE REAL, then put a room on it and check that:
  //   (a) not one piece has moved — the house is a list now, and adding a room
  //       does not edit a list;
  //   (b) the DRAWING has moved — the generator still answers the question it
  //       has always answered, over the new plan;
  //   (c) subtracting the two yields carries for somebody to walk.
  const CONFIG = { seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 };

  function extendedHouse() {
    const play = buildTownPlay(CONFIG);
    const center = play.stage.center;
    const goods = play.stage.goods.map((g) => ({ key: g.good.key, slot: g.good.slot }));
    for (const house of play.plan.houses) {
      const key = `h_${house.index}`;
      const plan0 = houseRoomPlan(center, house, play.deltas.get(key));
      const neighbors = [
        ...play.plan.houses
          .filter((h) => h.index !== house.index)
          .map((h) => ({ x: center.x + h.dx, y: center.y + h.dy, w: h.w, h: h.h })),
        ...play.plan.works.map((w) => ({ x: center.x + w.dx, y: center.y + w.dy, w: w.w, h: w.h })),
      ];
      const before = houseFurniture(center, house, goods, "", play.deltas.get(key));
      // The re-draw, previewed on a throwaway delta so the real one is still
      // pristine when we materialize.
      for (const cluster of ANNEX_ORDER) {
        const cand = annexOptions(center, house, plan0, neighbors, undefined, cluster)[0];
        if (!cand) continue;

        // ── MAKE IT REAL (what the director does before any plan change).
        const rows = materializedRows(before, plan0.rooms, []);
        play.deltas.mutate(key, (d) => {
          d.materialized = true;
          d.placed.push(...rows);
        });
        expect(requestAnnex(play.deltas, key, cand).ok).toBe(true);

        const delta = play.deltas.get(key);
        const standing = houseFurniture(center, house, goods, "", delta);
        const drawing = houseFurniture(center, house, goods, "", blueprintDelta(delta));
        const moved = drawing.filter((q) => {
          const p = before.find((r) => r.id === q.id);
          return p && Math.hypot(q.x - p.x, q.y - p.y) > AT_SLOT_M;
        });
        if (!moved.length) continue; // this house's layout survived the annex
        return { play, house, key, center, goods, before, standing, drawing, moved, plan0 };
      }
    }
    return null;
  }

  it("NOT ONE PIECE MOVES when the room goes up — the house is a list now", () => {
    // The reported defect, as an assertion: "immediately after it was created,
    // the refrigerator teleported into position". Goods boxes included — they
    // were the loudest case, because their corner rule re-derived them
    // unconditionally, past every guard the household furniture had.
    const s = extendedHouse();
    expect(s).not.toBeNull();
    for (const p of s!.before) {
      const now = s!.standing.find((q) => q.id === p.id);
      expect(now).toBeTruthy();
      expect(Math.hypot(now!.x - p.x, now!.y - p.y)).toBeLessThanOrEqual(AT_SLOT_M);
    }
  });

  it("but the DRAWING does move — the generator keeps answering its question", () => {
    const s = extendedHouse()!;
    expect(s).not.toBeNull();
    expect(s.moved.length).toBeGreaterThan(0);
  });

  it("and the difference is a list of carries for somebody to walk", () => {
    const s = extendedHouse()!;
    expect(s).not.toBeNull();
    const plan = houseRoomPlan(s.center, s.house, s.play.deltas.get(s.key));
    const slots = blueprintSlots(s.drawing, plan.rooms);
    const tasks = reconcileFurnishing({ slots, standing: s.standing, stored: NOTHING_STORED });
    const moves = tasks.filter((t) => t.act === "move");
    expect(moves.length).toBeGreaterThan(0);
    // Nothing is invented and nothing is thrown away: every carry names a piece
    // that is actually standing in the house right now.
    for (const m of moves) {
      expect(s.standing.some((p) => p.id === m.from!.id)).toBe(true);
    }
  });

  it("a materialized building stops generating entirely — placed IS its contents", () => {
    const s = extendedHouse()!;
    expect(s).not.toBeNull();
    const rows = s.play.deltas.get(s.key)!.placed;
    expect(s.standing.map((p) => p.id).sort()).toEqual(rows.map((p) => p.id).sort());
  });
});
