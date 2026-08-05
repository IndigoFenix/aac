// The TOWN ⇄ CREATURE join (shared/symbol-game/town-quests.ts): a living
// town's books sample into an ordinary certified fulfill-node game — town
// residents ARE quest creatures (body = the errand clock, mind = the
// creature sim) — and a session's deliveries credit the books back.
//
// The economy here is authored INLINE: the bridge must work for any
// compiled content, not just grand-dream's packs (content-independence is
// the point of the engine carve). Pure logic — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import { compileEconomy, type EconomyDoc } from "@shared/world-engine/kernel/modules/economy/index.js";
import { createTownWorld } from "@shared/world-engine/kernel/town/town-world.js";
import { townPlan } from "@shared/world-engine/kernel/town/plan.js";
import { certifyGoalTreeGame } from "@shared/world-engine/solver/index.js";
import {
  certifyCreatureQuestWorld,
  creatureWorldFromGame,
} from "@shared/world-engine/interaction/quest/creature-quests.js";
import { LOCAL_PLAYER_CID } from "@shared/world-engine/interaction/quest/player-identity.js";
import { concludeTransfer, giveItem, openNeeds, requestItem } from "@shared/world-engine/interaction/behavior/creatures.js";
import {
  applyTownOutcome,
  buildTownQuestGame,
  sampleTownNeeds,
} from "@shared/world-engine/interaction/town/town-quests.js";

/** A minimal two-good village: farms grow food (banked in the granary),
 *  a weaver makes cloth (banked nowhere — the null-scalar outcome path). */
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
    {
      key: "cloth", scalarMax: 50, perPersonDaily: 0.0003,
      transport: {},
      street: {
        capDays: 12, shopSec: 20, cartRations: 12, unit: "bolts", producers: ["weaver"],
        stockColor: "#b8c4de", boxLabel: "Linen chest", errandName: "linens",
      },
    },
  ],
  buildings: [
    {
      key: "farm", countScalar: "farms", cap: { by: "farmland", rate: 1 / 60 },
      processes: [
        { id: "farm", input: "farmland", output: "grain_out", efficiency: 0.08, capacityRate: 5 },
        { id: "mill", input: "grain_out", output: "food_out", efficiency: 1 },
      ],
      vars: [{ name: "grain_out", max: 200 }],
      construction: { tier: "base", costs: [{ stockpile: "granary", amount: 20 }] },
      sells: ["food"], leansToward: "fertility", mapCap: 8, district: "farm",
      style: { color: "#7d9c53", w: 18, h: 12 }, vignette: { w: 5, h: 4 },
      glyph: "🌾", title: "🌾 Farmstead", info: ["{farms} farms."],
    },
    {
      key: "weaver", countScalar: "weavers", cap: { by: "population", rate: 0.002 },
      processes: [{ id: "weave", input: "farmland", output: "cloth_out", efficiency: 0.001, capacityRate: 2 }],
      construction: { tier: "industry", costs: [{ stockpile: "granary", amount: 25 }] },
      sells: ["cloth"], shelved: true, leansToward: null, mapCap: 2, district: "craft",
      style: { color: "#8a7fae", w: 14, h: 10 }, vignette: { w: 4, h: 4 },
      glyph: "🧵", title: "🧵 Weaver", info: ["{weavers} weavers."],
    },
  ],
};

const ECO = compileEconomy([DOC], { construction: true });

const fedTown = () => {
  const town = createTownWorld({
    economy: ECO,
    charter: { farmland: 420, ore_access: 0 },
    startPop: 80,
    seedScalars: { farms: 1 },
    key: "haywick",
  });
  town.step(200);
  return town;
};

describe("town-quests: sampling the books", () => {
  it("a fed town still asks (slot order on full ledgers), a lean one asks hungriest-first", () => {
    const town = fedTown();
    const needs = sampleTownNeeds(town, ECO, "haywick", 2);
    expect(needs.map(n => n.good)).toEqual(["food", "cloth"]);
    for (const n of needs) expect(n.fill).toBeGreaterThanOrEqual(0.99);

    // A town founded with NOTHING that grows food: fill 0 ⇒ food first,
    // and the want reads as the condition ("I'm hungry").
    const lean = createTownWorld({
      economy: ECO, charter: { farmland: 420, ore_access: 0 }, startPop: 80, key: "leanmoor",
    });
    lean.step(60);
    const leanNeeds = sampleTownNeeds(lean, ECO, "leanmoor", 1);
    expect(leanNeeds[0]!.good).toBe("food");
    expect(leanNeeds[0]!.fill).toBe(0);
    const plan = townPlan(lean, ECO, "leanmoor", 3);
    const bundle = buildTownQuestGame(lean, ECO, plan, "leanmoor", { seed: 3, questCount: 1 });
    const root = bundle.game.root as { via?: Array<{ key: { id: string; condition?: string } }> };
    const wanterNode = root.via!.map(g => g.key).find(k => k.id === "t0_wanter")!;
    expect(wanterNode.condition).toBe("hungry");
  });
});

describe("town-quests: the sampled game is an ordinary certified quest world", () => {
  it("passes BOTH gauntlets, anchors its cast to real town spots, deterministically", () => {
    const town = fedTown();
    const plan = townPlan(town, ECO, "haywick", 11);
    const bundle = buildTownQuestGame(town, ECO, plan, "haywick", { seed: 11, questCount: 2 });

    // Static goal-tree certification AND the greedy-player simulation.
    const cert = certifyGoalTreeGame(bundle.game);
    if (!cert.ok) throw new Error(cert.errors.join("; "));
    const sim = certifyCreatureQuestWorld(bundle.game);
    expect(sim.ok ? [] : sim.errors).toEqual([]);

    // Cast anchors: wanters live in real lots; vendors stand at their
    // good's own counter (both goods' sellers exist in this plan).
    const wanters = bundle.cast.filter(c => c.role === "wanter");
    const vendors = bundle.cast.filter(c => c.role === "vendor");
    expect(wanters).toHaveLength(2);
    const lots = new Set(plan.houses.map(h => h.index));
    for (const w of wanters) expect(lots.has(w.house!)).toBe(true);
    const workTypes = new Set(plan.works.map(w => w.type));
    for (const v of vendors) {
      expect(v.workType).toBeDefined();
      expect(v.workType === "hall" || workTypes.has(v.workType!)).toBe(true);
    }
    // Food sells at the market/farm gate; cloth at the weaver's shelf.
    expect(vendors.find(v => v.good === "food")!.workType).not.toBe("hall");
    expect(vendors.find(v => v.good === "cloth")!.workType).toBe("weaver");

    // Same town, same seed ⇒ byte-identical session.
    const again = buildTownQuestGame(town, ECO, plan, "haywick", { seed: 11, questCount: 2 });
    expect(JSON.stringify(again)).toBe(JSON.stringify(bundle));
  });

  it("a good without a vocabulary pool is skipped and RECORDED, never silently staged", () => {
    const town = fedTown();
    const plan = townPlan(town, ECO, "haywick", 11);
    const bundle = buildTownQuestGame(town, ECO, plan, "haywick", {
      seed: 11, questCount: 2, goodPools: { food: "treat" },
    });
    expect(bundle.skippedGoods).toEqual(["cloth"]);
    expect(bundle.needs.map(n => n.good)).toEqual(["food"]);
  });
});

describe("town-quests: a session's deliveries credit the books", () => {
  it("ask the free vendor, take, give — and the granary banks the delivery", () => {
    const town = fedTown();
    const plan = townPlan(town, ECO, "haywick", 11);
    const bundle = buildTownQuestGame(town, ECO, plan, "haywick", { seed: 11, questCount: 2 });
    const { world } = creatureWorldFromGame(bundle.game);

    // The GENEROSITY contract in motion: the town vendor grants on ask
    // (playerDebt covers the baseline value) — no barter chain needed.
    for (const q of ["t0", "t1"]) {
      const ask = requestItem(world, LOCAL_PLAYER_CID, `${q}_vendor`, `${q}_item`);
      expect(ask.kind).toBe("accept");
      concludeTransfer(world, LOCAL_PLAYER_CID, `${q}_item`);
      const give = giveItem(world, LOCAL_PLAYER_CID, `${q}_wanter`, `${q}_item`);
      expect(give.events.some(e => e.type === "need-fulfilled")).toBe(true);
      expect(openNeeds(world.creatures[`${q}_wanter`]!)).toHaveLength(0);
    }

    // The DELIVERY contract: retention holds inside the session (the
    // creature keeps its item), and the town's share lands in the books —
    // food banks in the granary; cloth has no stockpile, so its delivery
    // is recorded with a null scalar (the fulfillment is the whole truth).
    town.inject("granary", -10); // make room below the cap
    const before = town.scalar("granary");
    const outcome = applyTownOutcome(town, ECO, bundle, world);
    const byGood = new Map(outcome.deliveries.map(d => [d.good, d] as const));
    expect(byGood.get("food")).toEqual({ good: "food", count: 1, scalar: "granary" });
    expect(byGood.get("cloth")).toEqual({ good: "cloth", count: 1, scalar: null });
    expect(town.scalar("granary")).toBe(before + 1);
  });
});
