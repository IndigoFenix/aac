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
  energyTemplate,
  funTemplate,
  hungerTemplate,
  hygieneTemplate,
  provisionTemplate,
  socialTemplate,
  thirstTemplate,
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
  it("hunger take → consume candidates, HOT meal first, raw food fallback, dining preference carried", () => {
    const tpl = hungerTemplate("food", 0.001);
    const intent: NeedIntent = { kind: "take", from: stock("chest"), units: 1 };
    expect(needPursuitGoals(tpl, intent, opts())).toEqual([
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

  it("a BAG-carrying eat stays legacy — the abstract stack is invisible to the item resolver", () => {
    const tpl = hungerTemplate("food", 0.001);
    const intent: NeedIntent = { kind: "consumeAt", station: station("table1") };
    expect(needPursuitGoals(tpl, intent, opts({ carriedMatching: 2 }))).toEqual([]);
  });

  it("energy restAt bed → a rest goal at the station, carrying the motive's dwell", () => {
    const tpl = energyTemplate(0.001);
    const intent: NeedIntent = { kind: "restAt", station: station("furn_0_bed_0", "bed") };
    expect(needPursuitGoals(tpl, intent, opts({ restDwellS: 60 }))).toEqual([
      { kind: "rest", place: { kind: "named", id: "furn_0_bed_0" }, dwellS: 60 },
    ]);
  });

  it("energy restHere (no bed) → a rest goal AT THE BODY's point (the doze in place)", () => {
    const tpl = energyTemplate(0.001);
    const intent: NeedIntent = { kind: "restHere" };
    expect(needPursuitGoals(tpl, intent, opts())).toEqual([
      { kind: "rest", place: { kind: "point", x: 5, y: 7 }, dwellS: 30 },
    ]);
  });

  it("waste/hygiene restAt route the same rest shape (privy, bath)", () => {
    for (const tpl of [wasteTemplate(0.001), hygieneTemplate(0.001)]) {
      const st = station("furn_0_privy_0", "privy");
      expect(needPursuitGoals(tpl, { kind: "restAt", station: st }, opts())).toEqual([
        { kind: "rest", place: { kind: "named", id: "furn_0_privy_0" }, dwellS: 30 },
      ]);
    }
  });

  it("social socialize → converse with the partner (the station candidate IS the housemate)", () => {
    const tpl = socialTemplate(0.001);
    const intent: NeedIntent = { kind: "socialize", station: station("resident_0_1", "partner") };
    expect(needPursuitGoals(tpl, intent, opts())).toEqual([{ kind: "converse", target: "resident_0_1" }]);
  });

  it("economy motives return [] — provision's take stays on the stack walker (S3)", () => {
    const tpl = provisionTemplate("food", 2, 6);
    const intent: NeedIntent = { kind: "take", from: stock("market"), units: 4 };
    expect(needPursuitGoals(tpl, intent, opts())).toEqual([]);
  });

  it("fun is NOT in the S2 slice (affordance acquire) — returns []", () => {
    const tpl = funTemplate(0.001);
    expect(NEED_PURSUIT_MOTIVES.has("fun")).toBe(false);
    expect(needPursuitGoals(tpl, { kind: "take", from: stock("toybox"), units: 1 }, opts())).toEqual([]);
  });

  it("deposit/drop-shaped intents return [] even for a routed motive's key-space", () => {
    const tpl = hungerTemplate("food", 0.001);
    expect(needPursuitGoals(tpl, { kind: "deposit", into: stock("chest"), units: 1 }, opts())).toEqual([]);
    expect(needPursuitGoals(tpl, { kind: "blocked" }, opts())).toEqual([]);
  });
});
