// BUILD SPOTS (⑦ — one build word, then the ground answers), at the pure
// layer. The board no longer carries a construction option per structure; it
// carries `build`, and the ground lights up. This pins the collapsing rule
// (one highlight per street SLOT, its rect the union of what could stand
// there), the spoken-for rule (staked ground is not offered twice) and the
// aim rule (the tightest containing spot wins). No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  buildSpots,
  buildingSpotId,
  growAreas,
  lotSpotId,
  roomSpotId,
  spotAt,
  type BuildSpotGrowIn,
  type BuildSpotLot,
} from "@shared/world-engine/kernel/town/build-spots.js";

const lot = (type: string, slot: number, x: number, y: number, w: number, h: number): BuildSpotLot =>
  ({ type, slot, x, y, w, h });

const HOUSE = { kind: "house" as const, index: 3 };

const growIn = (
  kind: string,
  x: number, y: number, w: number, h: number,
  key = "h_3",
): BuildSpotGrowIn => ({
  key,
  focus: HOUSE,
  offer: { kind, cluster: kind, candidate: { tag: kind, x, y } },
  x, y, w, h,
});

describe("build spots — the offered ground", () => {
  it("collapses one highlight per SLOT, naming every structure that fits it", () => {
    // A farm and a house enumerate different rects on the same frontage. The
    // player aims at a PLACE; the menu that opens names both.
    const spots = buildSpots({
      lots: [lot("house", 3, 0, 0, 8, 6), lot("farm", 3, -1, 0, 10, 6), lot("house", 9, 40, 0, 8, 6)],
      buildings: [],
    });
    expect(spots.map((s) => s.id)).toEqual([lotSpotId(3), lotSpotId(9)]);
    expect(spots[0]!.types).toEqual(["farm", "house"]);
    // Union rect: it must cover every orientation the slot could take.
    expect(spots[0]).toMatchObject({ x: -1, y: 0, w: 10, h: 6 });
    expect(spots[1]!.types).toEqual(["house"]);
  });

  it("never offers ground a live designation already staked", () => {
    const spots = buildSpots({
      lots: [lot("house", 3, 0, 0, 8, 6), lot("house", 9, 40, 0, 8, 6)],
      buildings: [],
      busy: [{ x: 4, y: 2, w: 3, h: 3 }], // overlaps slot 3's rect
    });
    expect(spots.map((s) => s.id)).toEqual([lotSpotId(9)]);
  });

  it("carries a building's delta key and focus straight through", () => {
    const spots = buildSpots({
      lots: [],
      buildings: [
        { key: "f_2", focus: { kind: "work", index: 7 }, x: 10, y: 10, w: 9, h: 9 },
        { key: "h_3", focus: { kind: "house", index: 3 }, x: 0, y: 0, w: 8, h: 6 },
      ],
    });
    // Stable order: by key, so the lit set never crawls between frames.
    expect(spots.map((s) => s.id)).toEqual([buildingSpotId("f_2"), buildingSpotId("h_3")]);
    expect(spots[0]).toMatchObject({ kind: "building", key: "f_2", focus: { kind: "work", index: 7 } });
  });

  it("puts WORK IN PROGRESS first so it answers for its own ground", () => {
    // A half-built thing affords one act (calling it off) and it is not the
    // act the finished building or the open lot would offer.
    const spots = buildSpots({
      lots: [lot("house", 3, 0, 0, 8, 6)],
      buildings: [{ key: "h_9", focus: { kind: "house", index: 9 }, x: 0, y: 0, w: 8, h: 6 }],
      sites: [{ site: "site_w_2", x: 0, y: 0, w: 8, h: 6 }],
    });
    expect(spots[0]).toMatchObject({ kind: "site", site: "site_w_2" });
    // Equal rects: the site wins the aim over both.
    expect(spotAt(spots, 4, 3)?.kind).toBe("site");
  });

  it("is deterministic — same inputs, same spots in the same order", () => {
    const input = {
      lots: [lot("farm", 9, 40, 0, 8, 6), lot("house", 3, 0, 0, 8, 6)],
      buildings: [{ key: "h_3", focus: { kind: "house" as const, index: 3 }, x: 0, y: 0, w: 8, h: 6 }],
    };
    expect(buildSpots(input)).toEqual(buildSpots(input));
  });
});

describe("a building decomposed — its rooms and its room-shaped gaps", () => {
  const rooms = [
    { key: "h_3", focus: HOUSE, room: "h_3", roomKind: "living", x: 0, y: 0, w: 6, h: 4 },
    { key: "h_3", focus: HOUSE, room: "h_3_r1", roomKind: "bedroom", x: 0, y: 4, w: 6, h: 3 },
  ];

  it("gives every room its own aim, carrying the room it names", () => {
    const spots = buildSpots({ lots: [], buildings: [], rooms });
    expect(spots.map((s) => s.id)).toEqual([roomSpotId("h_3", "h_3"), roomSpotId("h_3", "h_3_r1")]);
    expect(spots[1]).toMatchObject({
      kind: "room", key: "h_3", room: "h_3_r1", roomKind: "bedroom", focus: HOUSE,
    });
  });

  it("aims at the ROOM, never at the whole house it belongs to", () => {
    // The user law, in one assertion: the break word can only ever be reached
    // through the room it would take down.
    const spots = buildSpots({ lots: [], buildings: [], rooms });
    expect(spotAt(spots, 3, 5)?.room).toBe("h_3_r1");
    expect(spotAt(spots, 3, 2)?.room).toBe("h_3");
  });

  it("collapses candidate rects that share a PLACE into one lit area", () => {
    // A bedroom band and a kitchen band cut off the same wall at slightly
    // different depths are one place — the player aims at ground, and the
    // menu names both kinds. Each keeps its OWN geometry to build from.
    const areas = growAreas([
      growIn("bedroom", 0, 7, 6, 3),
      growIn("kitchen", 0, 7, 6, 2.8),
    ]);
    expect(areas).toHaveLength(1);
    expect(areas[0]!.offers!.map((o) => o.kind)).toEqual(["bedroom", "kitchen"]);
    // The union is what is LIT; the candidates are untouched.
    expect(areas[0]).toMatchObject({ kind: "grow", x: 0, y: 7, w: 6, h: 3 });
    expect(areas[0]!.offers![1]!.candidate).toEqual({ tag: "kitchen", x: 0, y: 7 });
  });

  it("keeps DIFFERENT places apart, even when they touch at a corner", () => {
    // A rear band and a side band of one room overlap only in the corner
    // square: merging them would light most of the floor as one area and
    // promise ground neither candidate can take.
    const areas = growAreas([
      growIn("bedroom", 0, 0, 8, 3),
      growIn("store", 0, 0, 3, 8),
    ]);
    expect(areas).toHaveLength(2);
  });

  it("never offers growth ground a live designation already staked", () => {
    const spots = buildSpots({
      lots: [],
      buildings: [],
      grow: [growIn("bedroom", 0, 7, 6, 3)],
      busy: [{ x: 1, y: 8, w: 2, h: 1 }],
    });
    expect(spots).toEqual([]);
  });

  it("puts a growth area AHEAD of the room it is cut from", () => {
    // The band lies inside its host, so the tightest-rect rule already picks
    // it; the order is what settles an exact tie.
    const spots = buildSpots({
      lots: [],
      buildings: [],
      rooms,
      grow: [growIn("bedroom", 0, 0, 6, 2)],
    });
    expect(spots[0]!.kind).toBe("grow");
    expect(spotAt(spots, 3, 1)?.kind).toBe("grow");
    expect(spotAt(spots, 3, 3)?.kind).toBe("room");
  });

  it("is deterministic — same candidates, same areas in the same order", () => {
    const input = {
      lots: [],
      buildings: [],
      rooms,
      grow: [growIn("bedroom", 0, 7, 6, 3), growIn("store", 0, 0, 3, 8)],
    };
    expect(buildSpots(input)).toEqual(buildSpots(input));
  });
});

describe("spotAt — what the aim lands on", () => {
  const spots = buildSpots({
    lots: [lot("house", 3, 0, 0, 20, 20)],
    buildings: [{ key: "h_3", focus: { kind: "house", index: 3 }, x: 5, y: 5, w: 6, h: 6 }],
  });

  it("gives the TIGHTEST containing spot — a building beats the lot under it", () => {
    expect(spotAt(spots, 7, 7)?.id).toBe(buildingSpotId("h_3"));
    expect(spotAt(spots, 1, 1)?.id).toBe(lotSpotId(3));
  });

  it("is null on plain ground", () => {
    expect(spotAt(spots, 100, 100)).toBeNull();
  });
});
