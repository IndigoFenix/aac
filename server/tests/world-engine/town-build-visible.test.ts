// CONSTRUCTION YOU CAN WATCH (⑦), at the stage seam.
//
// A site is no longer an anonymous rectangle waiting out a clock: it climbs a
// stage ladder the player can read (marked ground → floor → pillars → walls),
// wears the GLYPH of what will stand there, and a room coming DOWN runs the
// same ladder backwards — losing its walls to the building set the moment its
// builders are really at work. These pin the stage's half of that: what
// `activeSites` reports, and what `frame()` withholds. Pure — no DOM / GL.

import { describe, it, expect } from "@jest/globals";
import { compileEconomy, type EconomyDoc } from "@shared/world-engine/kernel/modules/economy/index.js";
import { createTownWorld } from "@shared/world-engine/kernel/town/town-world.js";
import { townPlan } from "@shared/world-engine/kernel/town/plan.js";
import { buildTownQuestGame } from "@shared/world-engine/interaction/town/town-quests.js";
import { createTownStage } from "@shared/world-engine/interaction/town/town-stage.js";
import { houseRoomPlan } from "@shared/world-engine/kernel/town/rooms.js";
import {
  annexOptions,
  bankLabor,
  createTownDeltas,
  demolishCheck,
} from "@shared/world-engine/kernel/town/construction.js";

const DOC: EconomyDoc = {
  stockpiles: [{ key: "granary", max: 400, construction: true }],
  commodities: [
    {
      key: "food", scalarMax: 200, perPersonDaily: 0.001,
      transport: { drift: "granary", driftRequiresConstruction: true },
      street: {
        capDays: 3, shopSec: 18, cartRations: 25, unit: "rations", producers: ["farm"], market: true,
        stockColor: "#e0b25c", boxLabel: "Pantry", errandName: "shopping",
      },
    },
  ],
  buildings: [
    {
      key: "farm", countScalar: "farms", cap: { by: "farmland", rate: 1 / 60 },
      processes: [{ id: "farm", input: "farmland", output: "food_out", efficiency: 0.08, capacityRate: 5 }],
      construction: { tier: "base", costs: [{ stockpile: "granary", amount: 20 }] },
      sells: ["food"], leansToward: "fertility", mapCap: 8, district: "farm",
      style: { color: "#7d9c53", w: 18, h: 12 }, vignette: { w: 5, h: 4 },
      glyph: "🌾", title: "🌾 Farmstead", info: ["{farms} farms."],
    },
  ],
};
const ECO = compileEconomy([DOC], { construction: true });

function setup() {
  const town = createTownWorld({
    economy: ECO,
    charter: { farmland: 420, ore_access: 0 },
    startPop: 120,
    seedScalars: { farms: 1 },
    key: "haywick",
  });
  town.step(250);
  const plan = townPlan(town, ECO, "haywick", 11);
  const bundle = buildTownQuestGame(town, ECO, plan, "haywick", { seed: 11, questCount: 1 });
  const deltas = createTownDeltas();
  const stage = createTownStage(town, ECO, plan, bundle, { seed: 11, deltas });
  return { plan, stage, deltas };
}

describe("a staked annex climbs the stage ladder", () => {
  it("is marked ground while materials gather, then floor, then pillars — and says what it will be", () => {
    const { plan, stage, deltas } = setup();
    const house = plan.houses[0]!;
    const base = houseRoomPlan(stage.center, house);
    const cand = annexOptions(stage.center, house, base, [], deltas.get(`h_${house.index}`), "sleep")[0]!;
    expect(cand).toBeTruthy();
    const p = deltas.postAnnexSite({
      buildingKey: `h_${house.index}`,
      cluster: "sleep",
      candidate: cand,
      costs: { wood: 2 },
      startedDay: 1,
      buildDays: 0.5,
    });

    const siteOf = () => stage.activeSites!().find((s) => s.id === `site_pa_${p.ord}`);
    expect(siteOf()).toMatchObject({ stage: 0, type: "annex" });
    // The icon is a composed GLYPH of the room kind, not a bare emoji.
    expect(siteOf()!.glyph).toBeTruthy();

    p.laborStartDay = 1;
    expect(siteOf()!.stage).toBe(1); // the floor goes down first
    bankLabor(p, 0.4);
    expect(siteOf()!.stage).toBe(2); // pillars
  });
});

describe("a room coming down loses its walls", () => {
  it("withholds the doomed room from the building set and marks its ground instead", () => {
    const { plan, stage, deltas } = setup();
    const house = plan.houses[0]!;
    const key = `h_${house.index}`;
    const roomPlan = houseRoomPlan(stage.center, house);
    const doomed = roomPlan.rooms.find((r) => demolishCheck(deltas, key, roomPlan, r.id).ok)!;
    expect(doomed).toBeTruthy();

    // Stand inside the house so its rooms are FULL (not the far shell form).
    const inside = { x: doomed.rect.x + doomed.rect.w / 2, y: doomed.rect.y + doomed.rect.h / 2 };
    const visible = (i: number) => i === house.index;
    const ids = (f: ReturnType<typeof stage.frame>) => (f.buildings ?? []).map((b) => b.id);

    const f0 = stage.frame(inside, 0, () => null, undefined, visible);
    expect(ids(f0)).toContain(doomed.id);

    const p = deltas.postDemolitionSite({
      buildingKey: key,
      roomId: doomed.id,
      startedDay: 0,
      buildDays: 3,
    });
    // ORDERED but not yet worked: the room still stands (a designation is not
    // a demolition — ⑥, someone has to be there).
    const f1 = stage.frame(inside, 1, () => null, undefined, visible);
    expect(f1.buildings === null || ids(f1).includes(doomed.id)).toBe(true);
    // …but the order IS visible from the moment it lands: a bare marking
    // wearing the break glyph, no floor and no posts (the room is its own
    // geometry until the work starts).
    const marked = stage.activeSites!().find((s) => s.id === `site_pd_${p.ord}`)!;
    expect(marked).toMatchObject({ type: "demolish", stage: 0 });
    expect(marked.glyph).toMatch(/^break \+ /);

    // Builders get to work: the walls come off and the ground is marked.
    bankLabor(p, 1.5);
    const f2 = stage.frame(inside, 2, () => null, undefined, visible);
    expect(f2.buildings).not.toBeNull();
    expect(ids(f2)).not.toContain(doomed.id);
    const falling = stage.activeSites!().find((s) => s.id === `site_pd_${p.ord}`)!;
    expect(falling).toMatchObject({ type: "demolish", stage: 2 });
    expect(falling.glyph).toBeTruthy();

    // Further work strips it to the bare floor, then to nothing.
    bankLabor(p, 1);
    expect(stage.activeSites!().find((s) => s.id === `site_pd_${p.ord}`)!.stage).toBe(1);
    bankLabor(p, 1);
    expect(stage.activeSites!().some((s) => s.id === `site_pd_${p.ord}`)).toBe(false);
  });
});
