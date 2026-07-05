/**
 * Dual-layer tests — grand-dream step 2 (unified-world-model.md §4, §9.2).
 *
 * The contract under test: EntityWorld (Settlement) and PopuSim
 * (Composition) run over the same node graph, coupled once per day.
 * Covers: exact population consistency between the layers every single
 * day; conservation; settlement-driven migration carrying traits; the
 * road→route-strength channel gating ranged spread; the trait-fraction→
 * entity-scalar input channel; crisp rest of the migration bridge; and
 * dual-layer determinism.
 */

import { describe, it, expect } from "vitest";
import { bootDual, type DualSpec, type DualWorld } from "../dual";
import type { WorldSpec } from "@cells/spec";

/** Settlement layer: population diffuses along edges; towns produce goods
 *  that trade along roads, and busy roads grow (tradeNetwork pattern). */
function settlementSpec(opts: { migrationRate?: number; trade?: boolean } = {}): WorldSpec {
  const { migrationRate = 0.05, trade = true } = opts;
  const exchanges = [];
  if (migrationRate > 0) exchanges.push({ scalar: "population", rate: migrationRate });
  // Pack mules first, then a road: a small base trickle bootstraps the
  // flow that grows the road, which then amplifies the trade.
  if (trade) {
    exchanges.push({ scalar: "goods", rate: 0.05 });
    exchanges.push({ scalar: "goods", rate: 0.3, by: "road" });
  }
  return {
    id: "settlement",
    entity: {
      id: "town",
      vars: [
        { name: "population", min: 0, max: 1_000_000, initial: 0 },
        { name: "goods", min: 0, max: 100, initial: 0 },
        { name: "production", min: 0, max: 100, initial: 0 },
        { name: "unrest", min: 0, max: 1, initial: 0 },
      ],
      rules: trade
        ? [{ id: "make", trigger: { every: true }, effects: [{ toward: { scalar: "goods", target: { scalar: "production" }, rate: 0.1 } }] }]
        : [],
    },
    edge: { vars: [{ name: "road", min: 0, max: 1, initial: 0 }] },
    exchanges,
    roads: trade ? [{ attr: "road", use: "goods", rate: 0.05, decay: 0.005 }] : [],
  };
}

/** Composition layer: one idea trait spread by contact, optionally ranged. */
function compositionJson(ranged: number): Record<string, unknown> {
  return {
    name: "Dual",
    start_age: 0,
    use_date: false,
    phase: [{ key: "spread", name: "Spread" }],
    trait: [{
      key: "convinced", name: "Convinced", color: "230,60,60,1",
      transmit: [{ vector: ["v1"], apply: ["convinced"], value: 0.6, sd: 0, phase: "spread", ranged }],
    }],
    vector: [{ key: "v1", name: "Contact" }],
  };
}

function twoCitySpec(opts: {
  ranged?: number;
  migrationRate?: number;
  trade?: boolean;
  seedIdea?: boolean;
  popA?: number;
  popB?: number;
} = {}): DualSpec {
  const { ranged = 0, migrationRate = 0.05, trade = true, seedIdea = true, popA = 150_000, popB = 50_000 } = opts;
  return {
    nodes: [
      {
        key: "city_a", name: "A", pop: popA,
        scalars: { production: 80 },
        site: seedIdea
          ? { transmit: [{ vector: ["v1"], apply: ["convinced"], value: 30, sd: 0, phase: "spread" }] }
          : {},
      },
      { key: "city_b", name: "B", pop: popB },
    ],
    edges: [{ a: "city_a", b: "city_b", key: "ab" }],
    settlement: settlementSpec({ migrationRate, trade }),
    composition: compositionJson(ranged),
    coupling: {
      populationScalar: "population",
      roadAttr: "road",
      strengthScale: 2,
      traitInputs: [{ trait: "convinced", scalar: "unrest" }],
    },
  };
}

async function runDays(dw: DualWorld, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await dw.step();
}

describe("dual layer: population consistency", () => {
  it("keeps both layers in exact agreement every day, and conserves", async () => {
    const dw = await bootDual(twoCitySpec(), 12345);
    const start = dw.totalPop();
    expect(start).toBe(200_000);

    for (let day = 1; day <= 30; day++) {
      await dw.step();
      // Cross-layer agreement is exact, per site, every single day.
      for (const s of dw.sites()) {
        const composition = s.pops.reduce((a, p) => a + p.pop, 0);
        expect(dw.settlementScalar(s.key, "population")).toBe(composition);
      }
      expect(dw.totalPop()).toBe(start);
      expect(dw.settlementTotalPop()).toBe(start);
    }
  });

  it("diffuses the overcrowded city outward and reaches crisp rest", async () => {
    const dw = await bootDual(twoCitySpec({ trade: false, seedIdea: false }), 12345);
    await runDays(dw, 120);

    const a = dw.settlementScalar("city_a", "population");
    const b = dw.settlementScalar("city_b", "population");
    // d(A−B)/dt = −2r(A−B): 100k × 0.9^120 → essentially closed.
    expect(Math.abs(a - b)).toBeLessThan(10);

    // Crisp rest: once equalised (gap < 2), populations stop moving.
    const before = [a, b];
    await runDays(dw, 20);
    expect([
      dw.settlementScalar("city_a", "population"),
      dw.settlementScalar("city_b", "population"),
    ]).toEqual(before);
  });

  it("driven migration carries traits with the migrants", async () => {
    // No ranged spread and no route.migration — the ONLY way 'convinced'
    // can reach city B is inside people moved by the settlement layer.
    const dw = await bootDual(twoCitySpec({ ranged: 0 }), 12345);
    await runDays(dw, 25);

    expect(dw.popOnSiteWithTrait("city_b", "convinced")).toBeGreaterThan(0);
  });
});

describe("dual layer: roads gate ranged spread", () => {
  it("trade grows the road, which raises route strength, which lets ideas cross", async () => {
    const dw = await bootDual(twoCitySpec({ ranged: 0.5, migrationRate: 0 }), 777);
    await runDays(dw, 40);

    // The settlement economy wore in a road...
    expect(dw.settlementEdgeAttr(0, "road")).toBeGreaterThan(0.05);
    // ...whose strength is mirrored onto the PopuSim route...
    const route = dw.routes()[0];
    expect(route.strength).toBeCloseTo(dw.settlementEdgeAttr(0, "road") * 2, 10);
    // ...and the idea crossed it.
    expect(dw.popOnSiteWithTrait("city_b", "convinced")).toBeGreaterThan(0);
  });

  it("with no trade there is no road, and the idea stays home", async () => {
    const dw = await bootDual(twoCitySpec({ ranged: 0.5, migrationRate: 0, trade: false }), 777);
    await runDays(dw, 40);

    expect(dw.settlementEdgeAttr(0, "road")).toBe(0);
    expect(dw.popOnSiteWithTrait("city_a", "convinced")).toBeGreaterThan(0);
    expect(dw.popOnSiteWithTrait("city_b", "convinced")).toBe(0);
  });
});

describe("dual layer: composition → settlement input", () => {
  it("writes the trait prevalence into the entity scalar with a one-day lag", async () => {
    const dw = await bootDual(twoCitySpec({ ranged: 0, migrationRate: 0, trade: false }), 12345);
    await runDays(dw, 10);

    const pops = dw.sites().find(s => s.key === "city_a")!.pops;
    const total = pops.reduce((a, p) => a + p.pop, 0);
    const fracYesterday = dw.popOnSiteWithTrait("city_a", "convinced") / total;
    await dw.step();

    expect(dw.settlementScalar("city_a", "unrest")).toBeCloseTo(fracYesterday, 12);
    expect(dw.settlementScalar("city_a", "unrest")).toBeGreaterThan(0);
  });
});

describe("dual layer: rest + fast-forward (step 3)", () => {
  it("a converged dual world rests, jumps O(1), and matches its stepped twin", async () => {
    // Same spec, same seed: one world advances with the resting jump, the
    // twin steps every single day.
    const jumper = await bootDual(twoCitySpec({ ranged: 0.5 }), 31337);
    const twin = await bootDual(twoCitySpec({ ranged: 0.5 }), 31337);

    const HORIZON = 400;
    const { stepped, skipped } = await jumper.advanceDays(HORIZON);
    for (let i = 0; i < HORIZON; i++) await twin.step();

    // The world genuinely converged well before the horizon...
    expect(skipped).toBeGreaterThan(0);
    expect(stepped + skipped).toBe(HORIZON);
    expect(jumper.isResting()).toBe(true);
    expect(jumper.day()).toBe(twin.day());

    // ...and the jump is bit-equivalent to stepping, across BOTH layers.
    for (const s of twin.sites()) {
      const twinComposition = s.pops.reduce((a, p) => a + p.pop, 0);
      const jumperSite = jumper.sites().find(x => x.key === s.key)!;
      expect(jumperSite.pops.reduce((a, p) => a + p.pop, 0)).toBe(twinComposition);
      expect(jumper.popOnSiteWithTrait(s.key, "convinced")).toBe(twin.popOnSiteWithTrait(s.key, "convinced"));
      expect(jumper.settlementPop(s.key)).toBe(twin.settlementPop(s.key));
      expect(jumper.settlementScalar(s.key, "goods")).toBe(twin.settlementScalar(s.key, "goods"));
      expect(jumper.settlementScalar(s.key, "unrest")).toBe(twin.settlementScalar(s.key, "unrest"));
    }
    expect(jumper.settlementEdgeAttr(0, "road")).toBe(twin.settlementEdgeAttr(0, "road"));
  });

  it("a resting world absorbs a huge idle span instantly", async () => {
    const dw = await bootDual(twoCitySpec({ ranged: 0.5 }), 31337);
    await dw.advanceDays(400); // converge

    const dayBefore = dw.day();
    const popsBefore = dw.sites().map(s => [s.key, s.pops.reduce((a, p) => a + p.pop, 0)]);
    const t0 = performance.now();
    const { stepped, skipped } = await dw.advanceDays(1_000_000);
    const elapsed = performance.now() - t0;

    expect(stepped).toBe(0);
    expect(skipped).toBe(1_000_000);
    expect(elapsed).toBeLessThan(100);
    expect(dw.day()).toBe(dayBefore + 1_000_000);
    expect(dw.sites().map(s => [s.key, s.pops.reduce((a, p) => a + p.pop, 0)])).toEqual(popsBefore);
    expect(dw.isResting()).toBe(true);
  });
});

/** Line cap—mid—far. Production 20 at cap, demand 10+10 downstream —
 *  balanced, so the solved flow field is static and drift-free. The
 *  composition starts fully saturated so it rests immediately. (Shared by
 *  the step-4 economy suite and the gate-5 founding suite.) */
function flowEconomySpec(): DualSpec {
    return {
      nodes: [
        {
          key: "cap", name: "Capital", pop: 10_000,
          scalars: { production: 20 },
          site: { startpop: [{ size: 1, apply: ["convinced"] }] },
        },
        { key: "mid", name: "Midtown", pop: 10_000, scalars: { consumption: 10 }, site: { startpop: [{ size: 1, apply: ["convinced"] }] } },
        { key: "far", name: "Farhold", pop: 10_000, scalars: { consumption: 10 }, site: { startpop: [{ size: 1, apply: ["convinced"] }] } },
      ],
      edges: [
        { a: "cap", b: "mid", key: "cm" },
        { a: "mid", b: "far", key: "mf" },
      ],
      settlement: {
        id: "flow-economy",
        entity: {
          id: "town",
          vars: [
            { name: "population", min: 0, max: 1_000_000, initial: 0 },
            { name: "goods", min: 0, max: 100, initial: 0 },
            { name: "production", min: 0, max: 100, initial: 0 },
            { name: "consumption", min: 0, max: 100, initial: 0 },
            { name: "unrest", min: 0, max: 1, initial: 0 },
          ],
          rules: [],
        },
        edge: { vars: [{ name: "road", min: 0.1, max: 2, initial: 0.1 }] },
        flownets: [{ id: "trade", source: "production", demand: "consumption", by: "road", drift: "goods" }],
        roads: [{ attr: "road", use: "trade", rate: 0.002, decay: 0.004 }],
      } as DualSpec["settlement"],
      composition: compositionJson(0.4),
      coupling: {
        populationScalar: "population",
        roadAttr: "road",
        strengthScale: 1,
        traitInputs: [{ trait: "convinced", scalar: "unrest" }],
      },
    };
}

describe("dual layer: steady-state economy (step 4)", () => {
  it("the world rests while goods still flow — stabilise in motion", async () => {
    const dw = await bootDual(flowEconomySpec(), 4242);
    const day0 = dw.day();
    const { stepped, skipped } = await dw.advanceDays(300);

    // Roads wore in and clamped, composition saturated from day 0 — the
    // world converged and the remainder was jumped...
    expect(skipped).toBeGreaterThan(0);
    expect(dw.isResting()).toBe(true);
    expect(dw.day()).toBe(day0 + stepped + skipped);

    // ...yet the flow field still ships the full supply downstream: the
    // resting world visibly moves. Line topology ⇒ exact flows.
    expect(dw.settlementFlow(0, "trade")).toBeCloseTo(20, 6);
    expect(dw.settlementFlow(1, "trade")).toBeCloseTo(10, 6);

    // Balanced supply/demand ⇒ no drift: stockpiles never moved.
    for (const key of ["cap", "mid", "far"]) {
      expect(dw.settlementScalar(key, "goods")).toBe(0);
    }
    // Caravan traffic wore the roads to their clamp.
    expect(dw.settlementEdgeAttr(0, "road")).toBe(2);
    expect(dw.settlementEdgeAttr(1, "road")).toBe(2);
    // And both layers still agree exactly.
    for (const s of dw.sites()) {
      expect(dw.settlementPop(s.key)).toBe(s.pops.reduce((a, p) => a + p.pop, 0));
    }
  });

  it("severing the road reroutes the economy at the day boundary", async () => {
    const dw = await bootDual(flowEconomySpec(), 4242);
    await dw.advanceDays(300);

    // War severs mid—far: conductance to 0 (below the road var's min via
    // direct write — the settlement layer's own conflict rules would do
    // this in-model).
    dw.entityWorld.edgeAttr.road[1] = 0;
    await dw.step();

    // The flow field re-solved: nothing reaches Farhold any more.
    expect(dw.settlementFlow(1, "trade")).toBe(0);
    // cap+mid now share +10 overproduction (+5 each); far starves (−10).
    await dw.step();
    expect(dw.settlementScalar("far", "goods")).toBe(0); // clamped at min
    expect(dw.settlementScalar("cap", "goods")).toBeGreaterThan(0);
    expect(dw.settlementScalar("mid", "goods")).toBeGreaterThan(0);
    expect(dw.isResting()).toBe(false); // stockpiles drifting again
  });
});

describe("dual layer: membership + breakaway (step 5)", () => {
  /** Line cap—mid—far, all civ X; separatism brews only in far (local
   *  transmit), so the faction is territorially coherent by construction. */
  function civSpec(): DualSpec {
    const memberX = { startpop: [{ size: 1, apply: ["member_x"] }] };
    return {
      nodes: [
        { key: "cap", name: "Capital", pop: 20_000, site: memberX },
        { key: "mid", name: "Midtown", pop: 20_000, site: memberX },
        {
          key: "far", name: "Farhold", pop: 20_000,
          site: {
            ...memberX,
            transmit: [{ vector: ["v1"], apply: ["sep_idea"], value: 20, sd: 0, phase: "spread" }],
          },
        },
      ],
      edges: [
        { a: "cap", b: "mid", key: "cm" },
        { a: "mid", b: "far", key: "mf" },
      ],
      settlement: {
        id: "civ-settlement",
        entity: {
          id: "town",
          vars: [
            { name: "population", min: 0, max: 1_000_000, initial: 0 },
            { name: "unrest", min: 0, max: 1, initial: 0 },
          ],
          rules: [],
        },
        edge: { vars: [{ name: "hostility", min: 0, max: 1, initial: 0 }] },
      },
      composition: {
        name: "Civ",
        start_age: 0, use_date: false,
        phase: [{ key: "spread", name: "Spread" }],
        trait: [
          { key: "member_x", name: "Civ X", color: "90,120,220,1" },
          { key: "member_y", name: "Civ Y", color: "190,90,220,1" },
          {
            key: "sep_idea", name: "Separatism", color: "240,150,40,1",
            transmit: [{ vector: ["v1"], apply: ["sep_idea"], value: 1.5, sd: 0, phase: "spread", ranged: 0 }],
          },
        ],
        vector: [{ key: "v1", name: "Contact" }],
        breakaway: [{
          key: "secession", dissent: "sep_idea", from: "member_x", to: "member_y",
          threshold: 0.2, coherence: 0.5,
        }],
      },
      coupling: {
        populationScalar: "population",
        traitInputs: [{ trait: "sep_idea", scalar: "unrest" }],
        civs: [
          { trait: "member_x", name: "Civ X", color: "#5a78dc" },
          { trait: "member_y", name: "Civ Y", color: "#be5adc" },
        ],
        breakawayHostility: { attr: "hostility", amount: 1 },
      },
    };
  }

  it("a coherent faction secedes; the ledger and the hostile border follow", async () => {
    const dw = await bootDual(civSpec(), 9001);
    await dw.advanceDays(80);

    // The breakaway fired exactly once...
    expect(dw.breakaways().length).toBe(1);

    // ...the ledger now shows a living Civ Y seated in Farhold...
    const civY = dw.civs().find(c => c.trait === "member_y")!;
    expect(civY.pop).toBeGreaterThan(0);
    expect(civY.capital).toBe("far");
    expect(dw.civOf("far")?.trait).toBe("member_y");
    expect(dw.civOf("cap")?.trait).toBe("member_x");

    // ...and ONLY the edge crossing the new border turned hostile.
    expect(dw.settlementEdgeAttr(1, "hostility")).toBe(1); // mid—far
    expect(dw.settlementEdgeAttr(0, "hostility")).toBe(0); // cap—mid

    // Population untouched by the flip, layers still agree.
    expect(dw.totalPop()).toBe(60_000);
    for (const s of dw.sites()) {
      expect(dw.settlementPop(s.key)).toBe(s.pops.reduce((a, p) => a + p.pop, 0));
    }
  });

  it("secession is deterministic and the seceded world still rests and jumps", async () => {
    const capture = async (): Promise<string> => {
      const dw = await bootDual(civSpec(), 31415);
      const { stepped, skipped } = await dw.advanceDays(400);
      return JSON.stringify([
        dw.breakaways(),
        dw.civs(),
        stepped, skipped, dw.isResting(),
        dw.sites().map(s => [s.key, s.pops.reduce((a, p) => a + p.pop, 0)]),
      ]);
    };
    const a = await capture();
    expect(await capture()).toBe(a);

    const parsed = JSON.parse(a) as [unknown[], unknown[], number, number, boolean, unknown[]];
    expect(parsed[0]).toHaveLength(1);   // seceded
    expect(parsed[3]).toBeGreaterThan(0); // and still jumped the idle tail
    expect(parsed[4]).toBe(true);         // resting at the horizon
  });
});

describe("dual layer: histfigs (step 6)", () => {
  it("pinning leaves the accounting consistent across both layers", async () => {
    // Quiet world: no spread, no migration, no trade — pure accounting.
    const dw = await bootDual(twoCitySpec({ ranged: 0, migrationRate: 0, trade: false, seedIdea: false }), 777);
    const start = dw.totalPop();

    // The same villager exists every time, without storage.
    const preview = dw.sampleVillager("city_b", 3)!;
    expect(dw.sampleVillager("city_b", 3)).toEqual(preview);

    const hf = dw.pinHistfig("city_b", 3, "mayor")!;
    expect(hf.name).toBe(preview.name);
    expect(dw.histfigCount()).toBe(1);
    expect(dw.totalPop()).toBe(start - 1);

    // After a day, the settlement layer reflects the smaller crowd exactly.
    await dw.step();
    expect(dw.totalPop() + dw.histfigCount()).toBe(start);
    for (const s of dw.sites()) {
      expect(dw.settlementPop(s.key)).toBe(s.pops.reduce((a, p) => a + p.pop, 0));
    }

    // Release: the mayor melts back into the crowd, books balanced.
    expect(dw.releaseHistfig(hf.id)).toBe(true);
    await dw.step();
    expect(dw.totalPop()).toBe(start);
    expect(dw.histfigCount()).toBe(0);
  });

  it("a pinned firebrand spreads the idea through the shed pipeline", async () => {
    // city_b starts clean and unreachable (no route spread, no migration):
    // ONLY histfig influence can bring 'convinced' there.
    const dw = await bootDual(twoCitySpec({ ranged: 0, migrationRate: 0, trade: false, seedIdea: false }), 777);
    expect(dw.popOnSiteWithTrait("city_b", "convinced")).toBe(0);

    const hf = dw.pinHistfig("city_b", 0, "firebrand")!;
    dw.histfigShed(hf.id, "convinced", 2_000);
    await dw.step();

    expect(dw.popOnSiteWithTrait("city_b", "convinced")).toBeGreaterThan(0);
    // The prevalence feedback carries it into the settlement layer a day later.
    await dw.step();
    expect(dw.settlementScalar("city_b", "unrest")).toBeGreaterThan(0);
  });
});

describe("dual layer: traits shape demand (world-content §3c)", () => {
  /** The flow economy plus a faith: Farhold is 20% devout (a local idea
   *  that saturates the town over time), the Capital distills incense, and
   *  the devout trait DECLARES its incense demand right beside its
   *  transmit (Trait.demand → World.siteResourceDemand → the settlement's
   *  flow net) — so as the faith spreads, the trade map redraws itself. */
  function faithSpec(): DualSpec {
    const spec = flowEconomySpec();
    spec.nodes[0].scalars!.incense_still = 10; // the Capital's supply
    spec.nodes[2].site = {
      startpop: [{ size: 1, apply: ["convinced", "devout"] }, { size: 4, apply: ["convinced"] }],
    };
    (spec.composition.trait as Record<string, unknown>[]).push({
      key: "devout", name: "Devout", color: "200,170,60,1",
      transmit: [{ vector: ["v1"], apply: ["devout"], value: 0.3, sd: 0, phase: "spread", ranged: 0 }],
      demand: [{ resource: "incense", value: 0.001 }],
    });
    spec.settlement.entity.vars!.push(
      { name: "devout_pop", min: 0, max: 1_000_000, initial: 0 },
      { name: "incense_still", min: 0, max: 100, initial: 0 },
      { name: "incense_need", min: 0, max: 100, initial: 0 },
      { name: "incense_got", min: 0, max: 100, initial: 0 },
    );
    spec.settlement.flownets!.push(
      { id: "incense", source: "incense_still", demand: "incense_need", by: "road", satisfied: "incense_got" },
    );
    spec.coupling.demandInputs = [{ resource: "incense", scalar: "incense_need" }];
    // Secondary channel coverage: the raw carrier count is also available
    // for custom process chains.
    spec.coupling.traitInputs!.push({ trait: "devout", scalar: "devout_pop", mode: "count" });
    return spec;
  }

  it("what a town wants follows who its people are", async () => {
    const dw = await bootDual(faithSpec(), 606);

    // Early, mid-spread: incense demand equals YESTERDAY's carrier count ×
    // rate — the §4 one-day-lag contract, asserted as such — and the
    // still's output flows down the whole line to meet it (edge 1 =
    // mid→far).
    await dw.advanceDays(4);
    const carriersThen = dw.popOnSiteWithTrait("far", "devout");
    await dw.advanceDays(1);
    const early = dw.settlementScalar("far", "incense_need");
    expect(early).toBeCloseTo(carriersThen * 0.001, 9);
    expect(early).toBeLessThan(8); // the faith is still spreading
    // The raw carrier count flows through the secondary channel too.
    expect(dw.settlementScalar("far", "devout_pop")).toBe(carriersThen);
    // Demand is fully met (supply 10 covers it) and incense moves toward
    // Farhold. (Edge flow > need here: an unbalanced net also spreads the
    // unclaimed surplus — `satisfied` is the demand-met quantity.)
    expect(dw.settlementScalar("far", "incense_got")).toBeCloseTo(early, 6);
    expect(dw.settlementFlow(1, "incense")).toBeGreaterThan(early);

    // The faith saturates Farhold ⇒ demand follows the carriers up, and the
    // incense caravans thicken to match. The economy answered an idea.
    await dw.advanceDays(120);
    const late = dw.settlementScalar("far", "incense_need");
    expect(dw.popOnSiteWithTrait("far", "devout")).toBe(10_000);
    expect(late).toBeCloseTo(10, 9);
    expect(late).toBeGreaterThan(early * 2);
    expect(dw.settlementFlow(1, "incense")).toBeCloseTo(10, 6);

    // No faith, no market: the faithless twin wants and receives nothing.
    // (The unclaimed supply still spreads through the flow field — the
    // demand-side truth is need/got, both zero.)
    const secular = faithSpec();
    secular.nodes[2].site = { startpop: [{ size: 1, apply: ["convinced"] }] };
    const dw2 = await bootDual(secular, 606);
    await dw2.advanceDays(40);
    expect(dw2.settlementScalar("far", "incense_need")).toBe(0);
    expect(dw2.settlementScalar("far", "incense_got")).toBe(0);
  });
});

describe("dual layer: vital dynamics — the economy sets carrying capacity", () => {
  /** One town of humans (hereditary trait declaring food demand), one farm
   *  output. Births ride food fill, starvation rides its lack: population
   *  must grow to the Malthusian equilibrium the FOOD SUPPLY implies —
   *  fill* = (death+starv)/(birth+starv) = 6/7, K = supply/(rate·fill*)
   *  = 12/(0.001·6/7) = 14,000. */
  function malthusSpec(): DualSpec {
    return {
      nodes: [{ key: "town", name: "Town", pop: 5_000, scalars: { farm_out: 12 }, site: { startpop: [{ size: 1, apply: ["human"] }] } }],
      edges: [],
      settlement: {
        id: "malthus",
        entity: {
          id: "town",
          vars: [
            { name: "population", min: 0, max: 1_000_000, initial: 0 },
            { name: "farm_out", min: 0, max: 100, initial: 0 },
            { name: "food_need", min: 0, max: 100, initial: 0 },
            { name: "food_got", min: 0, max: 100, initial: 0 },
          ],
          rules: [],
        },
        flownets: [{ id: "food", source: "farm_out", demand: "food_need", satisfied: "food_got" }],
      } as DualSpec["settlement"],
      composition: {
        name: "Malthus",
        start_age: 0, use_date: false,
        phase: [{ key: "spread", name: "Spread" }],
        trait: [{
          key: "human", name: "Human", color: "150,150,150,1",
          hereditary: true,
          demand: [{ resource: "food", value: 0.001 }],
        }],
        vector: [{ key: "v1", name: "V1" }],
      },
      coupling: {
        populationScalar: "population",
        demandInputs: [{ resource: "food", scalar: "food_need" }],
        vitals: { birthRate: 0.02, deathRate: 0.01, starvation: 0.05, foodNeed: "food_need", foodGot: "food_got" },
      },
    };
  }

  it("population grows to the food-set equilibrium, then tracks a bigger harvest", async () => {
    const dw = await bootDual(malthusSpec(), 1848);
    const start = dw.totalPop();
    expect(start).toBe(5_000);

    await dw.advanceDays(400);
    const atK = dw.totalPop();
    // Grew well past the start, into the Malthusian band around K = 14,000…
    expect(atK).toBeGreaterThan(12_500);
    expect(atK).toBeLessThan(15_000);
    // …and has plateaued (the last stretch barely moves).
    const before = dw.totalPop();
    await dw.advanceDays(50);
    expect(Math.abs(dw.totalPop() - before)).toBeLessThan(before * 0.02);

    // The ledger balances across every birth and death.
    const { births, deaths } = dw.vitalLedger();
    expect(dw.totalPop()).toBe(start + births - deaths);
    // Newborns kept the hereditary trait (and with it, the food demand).
    expect(dw.popOnSiteWithTrait("town", "human")).toBe(dw.totalPop());
    // Layers agree through every vital day.
    expect(dw.settlementPop("town")).toBe(dw.totalPop());

    // Double the harvest: the carrying capacity is the ECONOMY's number,
    // and the population follows it up.
    dw.entityWorld.scalars.farm_out[0] = 24;
    await dw.advanceDays(300);
    expect(dw.totalPop()).toBeGreaterThan(atK + 3_000);
    const ledger2 = dw.vitalLedger();
    expect(dw.totalPop()).toBe(start + ledger2.births - ledger2.deaths);
  });

  it("vital worlds decline when the food fails, and never fake a resting jump", async () => {
    const dw = await bootDual(malthusSpec(), 1848);
    await dw.advanceDays(200);
    const fed = dw.totalPop();

    dw.entityWorld.scalars.farm_out[0] = 0; // blight
    await dw.advanceDays(150);
    expect(dw.totalPop()).toBeLessThan(fed * 0.7); // starvation bites
    expect(dw.isResting()).toBe(false); // survivors ⇒ vitals still pending

    // Step on: a world with anyone left alive never fakes a jump — but
    // once the last villager starves, an EXTINCT town genuinely rests,
    // and only then may the remainder skip.
    const { stepped, skipped } = await dw.advanceDays(20);
    expect(stepped + skipped).toBe(20);
    if (skipped > 0) expect(dw.totalPop()).toBe(0);
  });
});

describe("dual layer: founding (gate 5)", () => {
  it("a colony founded mid-run joins both layers, the economy, and the idea-flow", async () => {
    const dw = await bootDual(flowEconomySpec(), 2026);
    await dw.advanceDays(60); // roads worn in, composition saturated
    const start = dw.totalPop();

    const idx = await dw.foundSettlement({
      key: "colony", name: "Colony",
      scalars: { consumption: 5 },
      edges: [{ to: "far" }],
      colonists: [{ from: "cap", count: 2_000 }, { from: "mid", count: 1_000 }],
    });
    expect(idx).toBe(3);

    // Conserving founding: colonists moved, nobody minted — and the layers
    // agree from the moment of birth.
    expect(dw.totalPop()).toBe(start);
    expect(dw.settlementPop("colony")).toBe(3_000);
    for (const s of dw.sites()) {
      expect(dw.settlementPop(s.key)).toBe(s.pops.reduce((a, p) => a + p.pop, 0));
    }
    // Colonists carried the idea with them (uniform-by-syndrome moves from
    // saturated cities).
    expect(dw.popOnSiteWithTrait("colony", "convinced")).toBe(3_000);

    await dw.advanceDays(40);
    // The trade net re-solved over the new topology: goods flow along the
    // founded road to meet the colony's demand (edge 2, colony = endpoint a
    // ⇒ inflow is negative).
    expect(dw.settlementFlow(2, "trade")).toBeLessThan(-0.1);
    expect(dw.totalPop()).toBe(start);
    for (const s of dw.sites()) {
      expect(dw.settlementPop(s.key)).toBe(s.pops.reduce((a, p) => a + p.pop, 0));
    }
  });

  it("founding is deterministic and the grown dual world rests again", async () => {
    const capture = async (): Promise<string> => {
      const dw = await bootDual(flowEconomySpec(), 777);
      await dw.advanceDays(60);
      await dw.foundSettlement({
        key: "colony", name: "Colony",
        scalars: { consumption: 5 },
        edges: [{ to: "far" }],
        colonists: [{ from: "cap", count: 2_000 }],
      });
      // The colony road grows at ~0.0035/day (|flow| 3.75 × 0.002 − 0.004
      // decay), so it clamps around day ~540 — the horizon must clear that.
      const { stepped, skipped } = await dw.advanceDays(700);
      return JSON.stringify([
        stepped, skipped, dw.isResting(), dw.totalPop(),
        dw.sites().map(s => [s.key, dw.settlementPop(s.key)]),
        dw.settlementFlow(2, "trade").toFixed(9),
      ]);
    };
    const a = await capture();
    expect(await capture()).toBe(a);

    const [, skipped, resting] = JSON.parse(a) as [number, number, boolean];
    expect(skipped).toBeGreaterThan(0); // the grown world found rest and jumped
    expect(resting).toBe(true);
  });
});

describe("dual layer: determinism", () => {
  it("same seed ⇒ identical run across BOTH layers", async () => {
    const capture = async (): Promise<string> => {
      const dw = await bootDual(twoCitySpec({ ranged: 0.4 }), 424242);
      await runDays(dw, 20);
      const parts: unknown[] = [];
      for (const s of dw.sites()) {
        parts.push(s.key, s.pops.reduce((a, p) => a + p.pop, 0), dw.popOnSiteWithTrait(s.key, "convinced"));
        parts.push(dw.settlementScalar(s.key, "population"), dw.settlementScalar(s.key, "goods"), dw.settlementScalar(s.key, "unrest"));
      }
      parts.push(dw.settlementEdgeAttr(0, "road"), dw.routes()[0].strength);
      return JSON.stringify(parts);
    };
    expect(await capture()).toBe(await capture());
  });
});
