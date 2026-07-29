// NEED → SELF-ASSIGNED COMMAND (need-goals.ts, action-consolidation S2): the
// pure mapping from a decided need (template + intent) to the GoalSpec
// candidates a unified pursuit drives. The S2 contract under test:
//   • only the CLEAN motives route (hunger/thirst/energy/waste/hygiene/social);
//   • economy rows and bag-carrying eats return [] (legacy walker keeps them);
//   • candidates are ordered (hot meal before raw food) and carry the
//     template's dining preference / the motive's dwell.
// Pure — safe in the default `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  NEED_PURSUIT_MOTIVES,
  needPursuitGoals,
  type NeedGoalOpts,
} from "@shared/world-engine/interaction/behavior/need-goals.js";
import {
  cookTemplate,
  dressTemplate,
  energyTemplate,
  funTemplate,
  hungerTemplate,
  hygieneTemplate,
  laundryTemplate,
  provisionTemplate,
  ritualAttendTemplate,
  ritualPrepTemplate,
  socialTemplate,
  thirstTemplate,
  unloadTemplate,
  wasteTemplate,
  type NeedIntent,
  type StationCandidate,
  type StockCandidate,
} from "@shared/world-engine/interaction/behavior/needs.js";

const opts = (over: Partial<NeedGoalOpts> = {}): NeedGoalOpts => ({
  carriedMatching: 0,
  restDwellS: 30,
  body: { x: 5, y: 7 },
  ...over,
});

const station = (id: string, kind = "table"): StationCandidate => ({ id, place: { kind: "named", id }, kind, waiting: 0 });
const stock = (id: string): StockCandidate => ({ id, place: { kind: "named", id }, units: 3 });

describe("needPursuitGoals — the clean motives become self-assigned commands (S2)", () => {
  it("hunger take → consume candidates first: HOT meal, then raw food, dining preference carried", () => {
    const tpl = hungerTemplate("food", 0.001);
    const intent: NeedIntent = { kind: "take", from: stock("chest"), units: 1 };
    expect(needPursuitGoals(tpl, intent, opts()).slice(0, 2)).toEqual([
      { kind: "consume", item: { match: { category: "food", state: "hot" } }, at: ["table"] },
      { kind: "consume", item: { match: { category: "food" } }, at: ["table"] },
    ]);
  });

  it("thirst consumeAt (a unit waiting) → one water candidate with the template's stations", () => {
    const tpl = thirstTemplate(0.001);
    const intent: NeedIntent = { kind: "consumeAt", station: station("table1") };
    expect(needPursuitGoals(tpl, intent, opts())).toEqual([
      { kind: "consume", item: { match: { category: "water" } }, at: ["table"] },
    ]);
  });

  it("a BAG-carrying eat routes as consumeUnits (S4) — the single-item consume can't see the stack", () => {
    const tpl = hungerTemplate("food", 0.001);
    const intent: NeedIntent = { kind: "consumeAt", station: station("table1") };
    expect(needPursuitGoals(tpl, intent, opts({ carriedMatching: 2 }))).toEqual([
      { kind: "consumeUnits", category: "food", at: ["table"], tplKey: "hunger:food" },
    ]);
  });

  it("energy restAt bed → a rest goal at the station, carrying the motive's dwell", () => {
    const tpl = energyTemplate(0.001);
    const intent: NeedIntent = { kind: "restAt", station: station("furn_0_bed_0", "bed") };
    expect(needPursuitGoals(tpl, intent, opts({ restDwellS: 60 }))).toEqual([
      { kind: "rest", place: { kind: "named", id: "furn_0_bed_0" }, dwellS: 60 },
    ]);
  });

  it("energy restHere (no bed) → a rest at the body's point, posed as a SLEEP (no fixture to say so)", () => {
    const tpl = energyTemplate(0.001);
    const intent: NeedIntent = { kind: "restHere" };
    expect(needPursuitGoals(tpl, intent, opts())).toEqual([
      { kind: "rest", place: { kind: "point", x: 5, y: 7 }, dwellS: 30, pose: "sleep" },
    ]);
  });

  it("waste/hygiene restAt route the same rest shape (toilet, bath)", () => {
    for (const tpl of [wasteTemplate(0.001), hygieneTemplate(0.001)]) {
      const st = station("furn_0_toilet_0", "toilet");
      expect(needPursuitGoals(tpl, { kind: "restAt", station: st }, opts())).toEqual([
        { kind: "rest", place: { kind: "named", id: "furn_0_toilet_0" }, dwellS: 30 },
      ]);
    }
  });

  it("social socialize → converse with the partner (the station candidate IS the housemate)", () => {
    const tpl = socialTemplate(0.001);
    const intent: NeedIntent = { kind: "socialize", station: station("resident_0_1", "partner") };
    expect(needPursuitGoals(tpl, intent, opts())).toEqual([{ kind: "converse", target: "resident_0_1" }]);
  });

  it("adoption rows route their supply run (S4) — take from the pantry, deposit at the wanter's station", () => {
    const tpl = { ...provisionTemplate("food", 2, 6), key: "adopt:resident_0_2|hunger:food" };
    expect(needPursuitGoals(tpl, { kind: "take", from: stock("chest"), units: 1 }, opts())).toEqual([
      { kind: "takeUnits", from: { kind: "named", id: "chest" }, category: "food", units: 1, tplKey: "adopt:resident_0_2|hunger:food" },
    ]);
    expect(needPursuitGoals(tpl, { kind: "deposit", into: stock("bowl"), units: 1 }, opts())).toEqual([
      { kind: "putUnits", into: { kind: "named", id: "bowl" }, category: "food", units: 1, tplKey: "adopt:resident_0_2|hunger:food" },
    ]);
  });

  it("fun's toy-in-hand dwell routes as a rest posed PLAY (S4)", () => {
    expect(NEED_PURSUIT_MOTIVES.has("fun")).toBe(false); // not clean — a stack motive
    expect(needPursuitGoals(funTemplate(0.001), { kind: "restHere" }, opts())).toEqual([
      { kind: "rest", place: { kind: "point", x: 5, y: 7 }, dwellS: 30, pose: "play" },
    ]);
  });

  it("deposit/drop-shaped intents return [] even for a routed motive's key-space", () => {
    const tpl = hungerTemplate("food", 0.001);
    expect(needPursuitGoals(tpl, { kind: "deposit", into: stock("chest"), units: 1 }, opts())).toEqual([]);
    expect(needPursuitGoals(tpl, { kind: "blocked" }, opts())).toEqual([]);
  });
});

describe("needPursuitGoals — the stack motives route their take/deposit legs (S3)", () => {
  const at = (id: string): StockCandidate => ({ id, place: { kind: "named", id }, units: 5 });

  it("provision take (the market buy, restock-sized) → one takeUnits leg with the row's key", () => {
    const tpl = provisionTemplate("food", 2, 6);
    const intent: NeedIntent = { kind: "take", from: at("store_0"), units: 4 };
    expect(needPursuitGoals(tpl, intent, opts())).toEqual([
      { kind: "takeUnits", from: { kind: "named", id: "store_0" }, category: "food", units: 4, tplKey: "provision:food" },
    ]);
  });

  it("provision deposit (the bank at home) → one putUnits leg", () => {
    const tpl = provisionTemplate("food", 2, 6);
    const intent: NeedIntent = { kind: "deposit", into: at("furn_0_chest_food"), units: 4 };
    expect(needPursuitGoals(tpl, intent, opts())).toEqual([
      { kind: "putUnits", into: { kind: "named", id: "furn_0_chest_food" }, category: "food", units: 4, tplKey: "provision:food" },
    ]);
  });

  it("hunger's decided TAKE adds the stack leg LAST — the market/well fallback when no supply is visible", () => {
    const tpl = hungerTemplate("food", 0.001);
    const intent: NeedIntent = { kind: "take", from: at("store_0"), units: 3 };
    const goals = needPursuitGoals(tpl, intent, opts());
    expect(goals).toHaveLength(3);
    expect(goals[0]).toEqual({ kind: "consume", item: { match: { category: "food", state: "hot" } }, at: ["table"] });
    expect(goals[2]).toEqual({
      kind: "takeUnits", from: { kind: "named", id: "store_0" }, category: "food", units: 3, tplKey: "hunger:food",
    });
  });

  it("fun's toy fetch routes by AFFORDANCE", () => {
    const tpl = funTemplate(0.001);
    expect(needPursuitGoals(tpl, { kind: "take", from: at("small:toy_1"), units: 1 }, opts())).toEqual([
      { kind: "takeUnits", from: { kind: "named", id: "small:toy_1" }, category: "", units: 1, affords: "play", tplKey: "fun" },
    ]);
  });

  it("dress routes its wardrobe fetch AND the change itself (equipUnits, slice 2)", () => {
    const tpl = dressTemplate(0.001);
    expect(needPursuitGoals(tpl, { kind: "take", from: at("furn_0_chest_clothing"), units: 1 }, opts())).toEqual([
      { kind: "takeUnits", from: { kind: "named", id: "furn_0_chest_clothing" }, category: "clothing", units: 1, tplKey: "dress" },
    ]);
    expect(needPursuitGoals(tpl, { kind: "equipHere" }, opts())).toEqual([
      { kind: "equipUnits", category: "clothing", tplKey: "dress" },
    ]);
  });

  it("laundry: the hamper pickup routes, and the wash is a processUnits dwell with the template's facet drop", () => {
    const tpl = laundryTemplate();
    expect(needPursuitGoals(tpl, { kind: "take", from: at("small:shirt_dirty"), units: 1 }, opts())).toEqual([
      { kind: "takeUnits", from: { kind: "named", id: "small:shirt_dirty" }, category: "laundry", units: 1, tplKey: "laundry" },
    ]);
    expect(needPursuitGoals(tpl, { kind: "processAt", station: station("furn_0_bath_0", "bath") }, opts({ restDwellS: 6 }))).toEqual([
      { kind: "processUnits", at: { kind: "named", id: "furn_0_bath_0" }, category: "laundry", drop: "dirty", dwellS: 6, tplKey: "laundry" },
    ]);
  });

  it("cook: the pot at the oven adds the hot facet (processUnits with `add`)", () => {
    const tpl = cookTemplate("food", "meal", 2);
    expect(needPursuitGoals(tpl, { kind: "processAt", station: station("furn_0_oven_0", "oven") }, opts({ restDwellS: 5 }))).toEqual([
      { kind: "processUnits", at: { kind: "named", id: "furn_0_oven_0" }, category: "food", add: "hot", dwellS: 5, tplKey: "cook:food" },
    ]);
  });

  it("prep: laying the ritual's place is an ordinary putUnits haul", () => {
    const tpl = ritualPrepTemplate("meal", 2);
    expect(needPursuitGoals(tpl, { kind: "deposit", into: at("furn_0_table"), units: 1 }, opts())).toEqual([
      { kind: "putUnits", into: { kind: "named", id: "furn_0_table" }, category: "meal", units: 1, tplKey: "prep:meal" },
    ]);
  });

  it("attend rides the pursuit — a rest at the CLAIMED seat, by name", () => {
    // The station the caller offers is already narrowed to this body's own
    // claim, so the goal names that chair — and going through the pursuit is
    // what gets the on-fixture arrival contract that lands a body somewhere the
    // furniture anchor can seat it (the legacy stand point picked the far side
    // of the table).
    const tpl = ritualAttendTemplate("meal", "chair");
    expect(
      needPursuitGoals(tpl, { kind: "restAt", station: station("furn_0_chair_1", "chair") }, opts({ restDwellS: 2.5 })),
    ).toEqual([{ kind: "rest", place: { kind: "named", id: "furn_0_chair_1" }, dwellS: 2.5 }]);
  });

  it("unload routes both answers: putUnits (put it away) and dropUnits (put it down)", () => {
    const tpl = unloadTemplate();
    expect(needPursuitGoals(tpl, { kind: "deposit", into: at("furn_0_chest_food"), units: 2 }, opts())).toEqual([
      { kind: "putUnits", into: { kind: "named", id: "furn_0_chest_food" }, category: "", units: 2, tplKey: "unload" },
    ]);
    expect(needPursuitGoals(tpl, { kind: "dropHere", units: 2 }, opts())).toEqual([
      { kind: "dropUnits", category: "", units: 2, tplKey: "unload" },
    ]);
  });
});
