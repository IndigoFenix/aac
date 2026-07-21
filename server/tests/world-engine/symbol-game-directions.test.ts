// "Asking for directions" — geometry, colour vocabulary, the spoken phrases,
// and the dialogue acts (single ask / paginated "where is…" list).
//
// Pure logic — no DB / LLM / GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  answerPlaceDirections,
  cardinalOf,
  directionsTo,
  houseGlyphForColor,
  nearestColorSymbol,
  type DirectionsTuning,
  type PlaceFact,
} from "@shared/world-engine/interaction/dialogue/directions.js";
import { speakDirections } from "@shared/world-engine/interaction/lang/index.js";
import {
  createCreatureWorld,
  projectDialogue,
  selectAct,
  type ConversationMemo,
  type DialogueAct,
} from "@shared/world-engine/interaction/index.js";
import type { TownStreets } from "@shared/world-engine/kernel/town/streets.js";

// A minimal street net: a vertical arterial (street 0) with a horizontal branch
// (street 1) meeting it at the origin. Enough for project / roadDistance.
function net(): TownStreets {
  return {
    plazaR: 10,
    streets: [
      { id: 0, gen: 0, parent: -1, parentArc: 0, arm: 0, pts: [{ x: 0, y: 0 }, { x: 0, y: 300 }], cum: [0, 300], capped: true },
      { id: 1, gen: 1, parent: 0, parentArc: 0, arm: 0, pts: [{ x: 0, y: 0 }, { x: 300, y: 0 }], cum: [0, 300], capped: true },
    ],
    slots: [],
  };
}

const TUNING: DirectionsTuning = { hereR: 4, visibleR: 45, closeR: 140 };

describe("directions geometry — proximity buckets (bottom-to-top priority)", () => {
  const n = net();

  it("very, very close reads 'here'", () => {
    expect(directionsTo(n, { x: 10, y: 2 }, { x: 12, y: 3 }, TUNING).proximity).toBe("here");
  });

  it("within visual distance reads 'there' (even if on the same street)", () => {
    // 40 m apart on street 1 — visible beats same-street.
    const ans = directionsTo(n, { x: 20, y: 2 }, { x: 58, y: 2 }, TUNING);
    expect(ans.proximity).toBe("there");
  });

  it("same street beyond visual distance reads 'street'", () => {
    const ans = directionsTo(n, { x: 20, y: 2 }, { x: 120, y: 2 }, TUNING);
    expect(ans.proximity).toBe("street");
    // Points down the street toward the target (its projection onto street 1).
    expect(ans.pointAt.y).toBeCloseTo(0, 5);
    expect(ans.pointAt.x).toBeGreaterThan(20);
  });

  it("a walkable target off your street reads 'close'", () => {
    // On street 0 vs street 1: straight-line ~82 m (> visible), road ~124 m (≤ close).
    const ans = directionsTo(n, { x: 60, y: 2 }, { x: 2, y: 60 }, TUNING);
    expect(ans.proximity).toBe("close");
  });

  it("a far walk reads 'far'", () => {
    const ans = directionsTo(n, { x: 100, y: 2 }, { x: 2, y: 150 }, TUNING);
    expect(ans.proximity).toBe("far");
  });
});

describe("directions geometry — cardinals (Y-down: north = −y)", () => {
  it("names the dominant axis", () => {
    expect(cardinalOf({ x: 0, y: 0 }, { x: 10, y: 1 })).toBe("east");
    expect(cardinalOf({ x: 0, y: 0 }, { x: -10, y: 1 })).toBe("west");
    expect(cardinalOf({ x: 0, y: 0 }, { x: 1, y: 10 })).toBe("south");
    expect(cardinalOf({ x: 0, y: 0 }, { x: 1, y: -10 })).toBe("north");
  });
});

describe("town place knowledge — colour vocabulary", () => {
  it("maps a wall hex to the nearest nameable colour symbol", () => {
    expect(nearestColorSymbol("#2563EB")).toBe("color_blue");
    expect(nearestColorSymbol("#DC2626")).toBe("color_red");
    expect(nearestColorSymbol("#16A34A")).toBe("color_green");
    expect(nearestColorSymbol("#92400E")).toBe("color_brown"); // a muted brown wall
  });

  it("composes the house glyph for a colour", () => {
    expect(houseGlyphForColor("#2563EB")).toBe("home.color_blue");
  });
});

describe("town place knowledge — answer resolution (world ↔ town-local)", () => {
  it("converts world coords through the town centre and points back in world space", () => {
    const center = { x: 1000, y: 1000 };
    const fact: PlaceFact = {
      id: "home:x",
      thingGlyph: "home.color_blue",
      // A far target to the south-east in town-local terms → world = centre + local.
      worldPos: { x: 1002, y: 1150 },
    };
    const ans = answerPlaceDirections(net(), center, { x: 1100, y: 1002 }, fact, TUNING);
    expect(ans.proximity).toBe("far");
    expect(ans.cardinal).toBe("south");
    expect(ans.thingGlyph).toBe("home.color_blue");
    // Point-at is returned in WORLD space (near the centre + local target).
    expect(ans.pointAtWorld.x).toBeCloseTo(1002, 5);
    expect(ans.pointAtWorld.y).toBeCloseTo(1150, 5);
  });
});

describe("directions phrases — the five shapes across locales", () => {
  it("English renders each proximity", () => {
    expect(speakDirections("home.color_blue", "here", "north", "en")).toBe("The blue house is here.");
    expect(speakDirections("home.color_blue", "there", "north", "en")).toBe("The blue house is there.");
    expect(speakDirections("home.color_blue", "street", "north", "en")).toBe("The blue house is on this street.");
    expect(speakDirections("home.color_blue", "close", "east", "en")).toBe("The blue house is close, to the east.");
    expect(speakDirections("home.color_blue", "far", "south", "en")).toBe("The blue house is far, to the south.");
  });

  it("agrees number + gender in the other locales", () => {
    // Plural subject → "are".
    expect(speakDirections("blocks", "far", "west", "en")).toBe("The blocks are far, to the west.");
    // Spanish gendered article + contraction al.
    expect(speakDirections("toy", "close", "west", "es")).toBe("El juguete está cerca, al oeste.");
    // Portuguese "ao".
    expect(speakDirections("home.color_red", "far", "north", "pt")).toBe("A casa vermelha está longe, ao norte.");
    // Hebrew feminine agreement (עוגייה → רחוקה).
    expect(speakDirections("cookie", "far", "south", "he")).toBe("העוגייה רחוקה, לכיוון דרום.");
  });
});

describe("directions dialogue acts — single ask vs paginated list", () => {
  const PLAYER = "player";
  const sym = (id: string) => id.replace(/_\d+$/, "");
  const npcWorld = () => createCreatureWorld([{ id: PLAYER }, { id: "npc" }], []);

  it("one known place → a direct 'ask-directions' act carrying the subject", () => {
    const proj = projectDialogue(npcWorld(), "npc", PLAYER, "b", {
      symbolOf: sym,
      askDirections: [{ id: "buy:cookie", glyph: "cookie" }],
    });
    const ask = proj.acts.find((a) => a.kind === "ask-directions");
    expect(ask?.subjectId).toBe("buy:cookie");
    expect(proj.acts.some((a) => a.kind === "directions-menu")).toBe(false);
  });

  it("several known places → a 'directions-menu' act, not a wall of asks", () => {
    const subjects = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, glyph: "home" }));
    const proj = projectDialogue(npcWorld(), "npc", PLAYER, "b", { symbolOf: sym, askDirections: subjects });
    expect(proj.acts.some((a) => a.kind === "directions-menu")).toBe(true);
    expect(proj.acts.some((a) => a.kind === "ask-directions")).toBe(false);
  });

  it("opening the menu paginates with more + back and wraps", () => {
    const subjects = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, glyph: "home" }));
    const opts = { symbolOf: sym, askDirections: subjects };
    const world = npcWorld();

    // Open the list.
    const openAct: DialogueAct = { kind: "directions-menu", glyph: "place#question" };
    const opened = selectAct(world, "npc", PLAYER, openAct, "b", opts, {});
    expect(opened.memo.list).toEqual({ menu: "where-is", page: 0 });

    // Page 0: pageSize (maxActs 8 − 3) = 5 picks + more + back + confused.
    let proj = projectDialogue(world, "npc", PLAYER, "b", opts, opened.memo);
    const picks0 = proj.acts.filter((a) => a.kind === "directions-pick");
    expect(picks0).toHaveLength(5);
    expect(proj.acts.some((a) => a.kind === "more")).toBe(true);
    expect(proj.acts.some((a) => a.kind === "back")).toBe(true);
    expect(picks0[0]!.subjectId).toBe("s0");

    // MORE → page 1 shows the remaining 2.
    const moreAct: DialogueAct = { kind: "more", glyph: "more" };
    const more = selectAct(world, "npc", PLAYER, moreAct, "b", opts, opened.memo);
    expect(more.memo.list?.page).toBe(1);
    proj = projectDialogue(world, "npc", PLAYER, "b", opts, more.memo);
    expect(proj.acts.filter((a) => a.kind === "directions-pick")).toHaveLength(2);

    // BACK closes the list.
    const backAct: DialogueAct = { kind: "back", glyph: "no" };
    const back = selectAct(world, "npc", PLAYER, backAct, "b", opts, more.memo);
    expect(back.memo.list).toBeUndefined();
  });

  it("picking a place hands the subject up to the host (askedDirections) and closes the list", () => {
    const opts = { symbolOf: sym, askDirections: [{ id: "buy:cookie", glyph: "cookie" }] };
    const world = npcWorld();
    const pick: DialogueAct = { kind: "directions-pick", subjectId: "buy:cookie", glyph: "cookie" };
    const memo: ConversationMemo = { list: { menu: "where-is", page: 0 } };
    const res = selectAct(world, "npc", PLAYER, pick, "b", opts, memo);
    expect(res.askedDirections).toBe("buy:cookie");
    expect(res.memo.list).toBeUndefined();
    expect(res.close).toBeFalsy(); // the conversation continues after the answer
  });
});
