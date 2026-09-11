/**
 * 🪨 PILES, NOT BOXES — the pure half (planning-docs/games/world-engine/piles-not-boxes-round.md).
 *
 * ⚖️ THE USER'S LAW (2026-09-10, verbatim): *"in general, items should be stored
 * in piles that are generated spontaneously when needed - boxes help with
 * organization and fulfill a need for tidiness but they shouldn't be required
 * for the behavior of collection. Very similar to the spontaneous generation of
 * a non-physical building on a new site to hold furniture that doesn't have a
 * place yet. These loose piles should get moved to boxes when one exists, just
 * as outdoor furniture should get moved to a building when the appropriate
 * building exists. (Not instantly - they should create tasks to move them to the
 * proper locations.)"*
 *
 * Four things are pinned here and every one of them is pure — no session, no
 * world, no clock:
 *   ① THE ID + THE SLOT     — one pile per head, a deterministic ground slot.
 *   ② THE TASK DERIVATION   — accepts-head, room, the 4 m veto, the urgency.
 *   ③ THE CAMP'S DRAW       — a day's eating, at the metabolic rate (TWO CLOCKS).
 *   ④ THE PERSISTENCE       — `groundPiles` round-trips, and an old save is
 *                             byte-identical through it.
 *
 * Pure / DB-free / GL-free — `npm run test:engine -- collect-rows`.
 */
import { describe, it, expect } from "@jest/globals";
import {
  GROUND_PILE_PREFIX,
  PILE_RING_M,
  collectRowsFrom,
  groundPileHead,
  groundPileId,
  groundPileSlot,
  isGroundPileId,
  nearestRectKey,
  pointRectDistance,
  type AcceptingBox,
  type PileStanding,
} from "@shared/world-engine/kernel/town/ground-piles.js";
import { campLarderDraw, bodyNeedTemplates } from "@shared/world-engine/interaction/behavior/body-needs.js";
import { createTownDeltas } from "@shared/world-engine/kernel/town/construction.js";
import { REAL_SCALE, needRate } from "@shared/world-engine/scale.js";

const MIN_TRIP = 4;

const pile = (head: string, units: number, x: number, y: number): PileStanding => ({
  id: groundPileId(head),
  head,
  units,
  at: { x, y },
});
const box = (
  id: string,
  x: number,
  y: number,
  room: number,
  heads: readonly string[],
  word = "house",
): AcceptingBox => ({
  id,
  at: { x, y },
  room,
  accepts: (h) => heads.includes(h),
  word,
});

describe("① the pile's id and its ground slot", () => {
  it("is one pile per good head, and the head round-trips", () => {
    expect(groundPileId("food")).toBe(`${GROUND_PILE_PREFIX}food`);
    expect(isGroundPileId(groundPileId("wood"))).toBe(true);
    expect(isGroundPileId("furn_0_chest_food")).toBe(false);
    expect(groundPileHead(groundPileId("food"))).toBe("food");
    // A non-pile id is NOT a head of the empty string by accident — it is not a
    // pile at all, and the reader must be able to tell.
    expect(groundPileHead("small:3")).toBe("");
  });

  it("puts every head on its own spot on the ring, deterministically", () => {
    const a = groundPileSlot("food");
    const b = groundPileSlot("food");
    expect(b).toEqual(a); // same head, same slot — a reload puts it back
    expect(Math.hypot(a.dx, a.dy)).toBeCloseTo(PILE_RING_M, 6);
    const w = groundPileSlot("wood");
    // 🚨 TWO HEADS MUST NOT STACK ON ONE SPOT: the whole point of the ring is
    // that a camp's larder and its timber heap are two visible things.
    expect(Math.hypot(w.dx - a.dx, w.dy - a.dy)).toBeGreaterThan(0.1);
  });

  it("stands inside the co-located veto of its own anchor", () => {
    // A pile beside the crate is put away by the books, never by walking
    // somebody 1.8 m — so the ring must sit INSIDE `COLLECT_MIN_TRIP_M`.
    expect(PILE_RING_M).toBeLessThan(MIN_TRIP);
  });
});

describe("② pile → box is a task", () => {
  it("posts nothing when nothing accepts the head — the frontier before the house", () => {
    // THE USER'S LAW WORKING RATHER THAN A CASE HANDLED: the camp's larder pile
    // simply stands, because the only container in the world is a builder's
    // yard and a yard is not a pantry.
    const rows = collectRowsFrom(
      [pile("food", 12, 0, 0)],
      [box("site:stock", 30, 0, Infinity, ["wood", "stone"], "yard")],
      MIN_TRIP,
    );
    expect(rows).toEqual([]);
  });

  it("posts one row per pile once a box accepts the head", () => {
    const rows = collectRowsFrom(
      [pile("food", 12, 0, 0)],
      [box("furn_0_chest_food", 30, 0, 20, ["food"])],
      MIN_TRIP,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fromId: "pile:food",
      toId: "furn_0_chest_food",
      head: "food",
      units: 12,
      destWord: "house",
      urgency: 1, // the chest takes the WHOLE heap
    });
  });

  it("is bounded by the box's room, and the urgency says how much of the mess goes", () => {
    const rows = collectRowsFrom(
      [pile("food", 12, 0, 0)],
      [box("furn_0_chest_food", 30, 0, 3, ["food"])],
      MIN_TRIP,
    );
    expect(rows[0]!.units).toBe(3);
    expect(rows[0]!.urgency).toBeCloseTo(3 / 12, 6);
  });

  it("refuses a box with no room at all", () => {
    expect(
      collectRowsFrom([pile("food", 12, 0, 0)], [box("furn_0_chest_food", 30, 0, 0, ["food"])], MIN_TRIP),
    ).toEqual([]);
  });

  it("NEVER WALKS A CO-LOCATED LEG — the 4 m veto, from the pile's side", () => {
    // A heap lying beside the chest is bookkeeping, not an errand: the same law
    // `decideCollect` states from the puller's side.
    expect(
      collectRowsFrom([pile("food", 9, 0, 0)], [box("furn_0_chest_food", 3.9, 0, 20, ["food"])], MIN_TRIP),
    ).toEqual([]);
    expect(
      collectRowsFrom([pile("food", 9, 0, 0)], [box("furn_0_chest_food", 4.1, 0, 20, ["food"])], MIN_TRIP),
    ).toHaveLength(1);
  });

  it("takes the NEAREST accepting box, ties broken by id", () => {
    const rows = collectRowsFrom(
      [pile("food", 9, 0, 0)],
      [
        box("furn_1_chest_food", 40, 0, 20, ["food"]),
        box("furn_0_chest_food", 10, 0, 20, ["food"]),
      ],
      MIN_TRIP,
    );
    expect(rows[0]!.toId).toBe("furn_0_chest_food");
    const tied = collectRowsFrom(
      [pile("food", 9, 0, 0)],
      [box("furn_1_chest_food", 10, 0, 20, ["food"]), box("furn_0_chest_food", 10, 0, 20, ["food"])],
      MIN_TRIP,
    );
    expect(tied[0]!.toId).toBe("furn_0_chest_food"); // deterministic across peers
  });

  it("never sends a pile into itself, and ignores an empty pile", () => {
    const self = { ...box("pile:food", 30, 0, 20, ["food"]) };
    expect(collectRowsFrom([pile("food", 9, 0, 0)], [self], MIN_TRIP)).toEqual([]);
    expect(
      collectRowsFrom([pile("food", 0, 0, 0)], [box("furn_0_chest_food", 30, 0, 20, ["food"])], MIN_TRIP),
    ).toEqual([]);
  });

  it("an UNCAPPED destination is a whole chore, not a zero one", () => {
    // 🚨 THE ARITHMETIC THE ROUND'S LITERAL WORDING GOT WRONG: `units ÷ room` is
    // 0 for `room = Infinity`, which would make the settlement's own shelf the
    // one place a pile can never be taken.
    const rows = collectRowsFrom(
      [pile("wood", 12, 0, 0)],
      [box("site:stock", 30, 0, Infinity, ["wood"], "yard")],
      MIN_TRIP,
    );
    expect(rows[0]!.units).toBe(12);
    expect(rows[0]!.urgency).toBe(1);
    expect(rows[0]!.destWord).toBe("yard");
  });
});

describe("③ the camp's draw is metabolic, never a new pacing constant", () => {
  const scale = REAL_SCALE;

  it("scales with the mouths, and one day's draw is half the two-day cap", () => {
    const one = campLarderDraw(scale, 1);
    const five = campLarderDraw(scale, 5);
    expect(one.upTo).toBe(one.below * 2);
    expect(five.below).toBeGreaterThanOrEqual(one.below);
    // 🚨 TWO CLOCKS: the draw is rate × dayLengthS × bodies and NOTHING ELSE —
    // no second multiply by the day, and no pacing constant of its own. Stated
    // as the closed form so a constant sneaking in here fails the pin.
    expect(five.below).toBe(
      Math.max(1, Math.ceil(needRate(scale, "hunger") * scale.dayLengthS * 5)),
    );
  });

  it("floors at one whole ration — a larder that wants a bite is the defect restated", () => {
    expect(campLarderDraw(scale, 0).below).toBe(1);
  });
});

describe("③b the settler's row set", () => {
  const scale = REAL_SCALE;

  it("is EXACTLY unchanged when no larder is asked for", () => {
    const before = bodyNeedTemplates(scale, { pullOn: true });
    expect(before.some((t) => t.key.startsWith("provision:"))).toBe(false);
  });

  it("gains the residents' OWN provision row against the camp pile", () => {
    const rows = bodyNeedTemplates(scale, { pullOn: true, larder: { bodies: 5 } });
    const row = rows.find((t) => t.key === "provision:food");
    expect(row).toBeDefined();
    expect(row!.drive).toMatchObject({ kind: "stock", container: "home" });
    expect(row!.satisfy).toMatchObject({ kind: "deposit", container: "home" });
    expect(row!.exclusive).toBe(true); // one provisioner per good at a time
    // 🚨 THE LIVELOCK INVARIANT: hunger ACQUIRES food and must outrank every
    // deposit-shaped row for it, or the pair spins.
    const hunger = rows.find((t) => t.key === "hunger:food")!;
    expect(row!.priority).toBeLessThan(hunger.priority);
    const draw = campLarderDraw(scale, 5);
    expect(row!.drive).toMatchObject({ below: draw.below });
    expect(row!.satisfy).toMatchObject({ upTo: draw.upTo });
  });
});

describe("④ the pile ledger persists, and an old save is untouched by it", () => {
  it("round-trips a stocked pile", () => {
    const d = createTownDeltas();
    d.groundPiles.set("food", { berry: 7 });
    const json = d.toJSON();
    expect(json.groundPiles).toEqual({ food: { berry: 7 } });
    const back = createTownDeltas(json);
    expect(back.groundPiles.get("food")).toEqual({ berry: 7 });
    // THE ALIAS LAW: hydration takes a COPY, so the save's object and the live
    // stack are not the same map.
    expect(back.groundPiles.get("food")).not.toBe(json.groundPiles!.food);
  });

  it("EMITS NOTHING when no pile has ever been made — byte-identical old saves", () => {
    const d = createTownDeltas();
    expect("groundPiles" in d.toJSON()).toBe(false);
    // …and a save written before this round hydrates to an empty map and emits
    // exactly the object it always did.
    const legacy = createTownDeltas();
    expect(JSON.stringify(createTownDeltas(legacy.toJSON()).toJSON())).toBe(
      JSON.stringify(legacy.toJSON()),
    );
  });
});

describe("⑤ outdoor furniture belongs to a doorstep", () => {
  const rects = [
    { key: "h_0", rect: { x: 0, y: 0, w: 6, h: 6 } },
    { key: "h_1", rect: { x: 20, y: 0, w: 6, h: 6 } },
  ];

  it("a piece INSIDE a building is that building's, at distance zero", () => {
    // 🚨 THIS IS WHAT KEEPS THE TWO ARMS FROM DOUBLE-BOOKING ONE CHAIR: the
    // indoor arm's piece is at distance 0 from its own footprint, so the
    // outdoor arm can never claim it.
    expect(pointRectDistance({ x: 3, y: 3 }, rects[0]!.rect)).toBe(0);
    expect(nearestRectKey({ x: 3, y: 3 }, rects)).toBe("h_0");
  });

  it("a piece on open ground goes to the nearest FOOTPRINT, not the nearest centre", () => {
    // Centre-to-centre would answer h_0 (centre 3,3 vs 23,3) for a point at
    // x=14 — the footprint edges say h_1, which is the doorstep somebody would
    // actually carry it to.
    expect(nearestRectKey({ x: 14, y: 3 }, rects)).toBe("h_1");
  });

  it("breaks a tie on the key, so two peers over one world agree", () => {
    expect(nearestRectKey({ x: 13, y: 3 }, rects)).toBe("h_0");
    expect(nearestRectKey({ x: 13, y: 3 }, [...rects].reverse())).toBe("h_0");
  });

  it("answers nothing when the settlement has no buildings at all", () => {
    expect(nearestRectKey({ x: 0, y: 0 }, [])).toBeNull();
  });
});
