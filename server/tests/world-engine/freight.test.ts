// FREIGHT — the product transport attributes of resources-and-trade.md
// step ① (freight.ts): valueDensity/transit per GOOD, the mode asymmetry as
// world spec, and the reach/loss/refinement SHAPES. Pins the two laws:
// ratios in the engine + absolutes in the spec (every reach moves with the
// scale dials, no literal anywhere), and the refinement law (lossy in mass,
// multiplicative in value — distance is the reason refining exists).

import { describe, it, expect } from "@jest/globals";
import {
  asymmetryWarnings,
  carryReachM,
  chainInPerOut,
  DEFAULT_FREIGHT,
  deliveredFraction,
  FRAGILE_LOSS_PER_DAY,
  fragileHalfLifeDays,
  FREIGHT_CATALOGUE,
  freightDeclared,
  freightOf,
  haulBreakEvenDays,
  parseTransportSpec,
  REAL_ASYMMETRY,
  REAL_PORTER_BULK,
  refineOutUnits,
  registerFreight,
  resolveTransportAsymmetry,
  VALUE_TIER,
} from "@shared/world-engine/freight.js";
import {
  carryDays,
  dailyTravelM,
  DOLLHOUSE_SCALE,
  REAL_SCALE,
  type WorldScale,
} from "@shared/world-engine/scale.js";
import { naturalSources } from "@shared/world-engine/products.js";
import { compileEconomy } from "@shared/world-engine/kernel/modules/economy/economy.js";
import { parseEconomyDoc } from "@shared/world-engine/kernel/modules/economy/json.js";
import { parseGameSettings } from "@shared/world-engine/kernel/manifest.js";

describe("the freight registry", () => {
  it("an undeclared good defaults to the durable staple — it still trades, at the anchor", () => {
    expect(freightDeclared("mystery_goo")).toBe(false);
    expect(freightOf("mystery_goo")).toEqual(DEFAULT_FREIGHT);
    expect(DEFAULT_FREIGHT).toEqual({ valueDensity: VALUE_TIER.staple, transit: "durable" });
  });

  it("registerFreight overrides at runtime (the registerNaturalSource pattern)", () => {
    registerFreight("mystery_goo", { valueDensity: 9, transit: "fragile" });
    expect(freightOf("mystery_goo")).toEqual({ valueDensity: 9, transit: "fragile" });
  });

  it("the catalogue prices the shipped vocabulary: raw bulk < staple < refined < concentrated", () => {
    const vd = (g: string) => freightOf(g).valueDensity;
    // Raw bulk barely repays its haul; the staple is the anchor at 1.
    expect(vd("stone")).toBeLessThan(vd("wood"));
    expect(vd("wood")).toBeLessThan(vd("food"));
    expect(vd("food")).toBe(1);
    // Refinement climbs the axis; the far-trade treat sits above it all.
    expect(vd("wool")).toBeGreaterThan(vd("food"));
    expect(vd("cloth")).toBeGreaterThan(vd("wool"));
    expect(vd("cookie")).toBeGreaterThan(vd("cloth"));
  });

  it("transit behaviors match the physics: food is eaten, milk sours, cloth endures", () => {
    expect(freightOf("food").transit).toBe("selfConsuming");
    expect(freightOf("apple").transit).toBe("selfConsuming");
    expect(freightOf("milk").transit).toBe("fragile");
    expect(freightOf("meat").transit).toBe("fragile");
    expect(freightOf("wood").transit).toBe("durable");
    expect(freightOf("cloth").transit).toBe("durable");
  });

  it("every catalogue row is coherent (positive density, known behavior)", () => {
    for (const row of FREIGHT_CATALOGUE) {
      expect(row.valueDensity).toBeGreaterThan(0);
      expect(["selfConsuming", "fragile", "durable"]).toContain(row.transit);
    }
  });
});

describe("LAW: refinement is lossy in mass and multiplicative in value", () => {
  it("holds for every refinesTo row in the natural-sources catalogue", () => {
    let refinements = 0;
    for (const s of naturalSources()) {
      for (const p of s.products) {
        if (!p.refinesTo) continue;
        refinements++;
        // Lossy in mass: it takes more than one raw unit to make the good.
        expect(p.refinesTo.inPerOut).toBeGreaterThan(1);
        // Multiplicative in value: the refined good travels farther per bulk.
        expect(freightOf(p.refinesTo.into).valueDensity).toBeGreaterThan(
          freightOf(p.glyph).valueDensity,
        );
      }
    }
    expect(refinements).toBeGreaterThan(0); // wool→cloth at minimum
  });

  it("refineOutUnits floors partial units; chains compound", () => {
    expect(refineOutUnits(4, 2)).toBe(2);
    expect(refineOutUnits(3, 2)).toBe(1);
    expect(refineOutUnits(1, 2)).toBe(0);
    // wood→charcoal at 5:1, charcoal→iron at 4:1 ⇒ 20 wood per iron: the
    // compounding that makes fuel the bottleneck of every metal age.
    expect(chainInPerOut([5, 4])).toBe(20);
    expect(refineOutUnits(100, chainInPerOut([5, 4]))).toBe(5);
  });
});

describe("the mode asymmetry (world spec side)", () => {
  it("the anchor keeps the physics ordering: downstream ≫ upstream ≫ land", () => {
    expect(REAL_ASYMMETRY.downstream).toBeGreaterThan(REAL_ASYMMETRY.upstream);
    expect(REAL_ASYMMETRY.upstream).toBeGreaterThan(REAL_ASYMMETRY.land);
    expect(REAL_ASYMMETRY.land).toBe(1);
    expect(asymmetryWarnings(REAL_ASYMMETRY)).toEqual([]);
  });

  it("parse gates shape path-exactly; resolve anchors absent fields", () => {
    expect(parseTransportSpec({ downstream: 30 }, "game.transport")).toEqual({ downstream: 30 });
    expect(resolveTransportAsymmetry({ downstream: 30 })).toEqual({
      land: 1, downstream: 30, upstream: REAL_ASYMMETRY.upstream,
    });
    expect(resolveTransportAsymmetry(null)).toEqual(REAL_ASYMMETRY);
    // Land is the unit — declaring it is refused with the reason.
    expect(() => parseTransportSpec({ land: 2 }, "game.transport")).toThrow(/land is the unit/);
    expect(() => parseTransportSpec({ downstram: 3 }, "game.transport")).toThrow(/unknown field/);
    expect(() => parseTransportSpec({ upstream: 0.5 }, "game.transport")).toThrow(/1\.\.10000/);
  });

  it("rides the game envelope (parseGameSettings)", () => {
    const game = parseGameSettings(
      { scope: "town", world: {}, transport: { downstream: 12, upstream: 3 } },
      "game",
    );
    expect(game.transport).toEqual({ downstream: 12, upstream: 3 });
    expect(parseGameSettings({ scope: "town", world: {} }, "game").transport).toBeNull();
    expect(() =>
      parseGameSettings({ scope: "town", world: {}, transport: { x: 1 } }, "game"),
    ).toThrow(/game\.transport\.x/);
  });

  it("an inverted world is legal and told so in sentences (the scaleWarnings doctrine)", () => {
    const w = asymmetryWarnings({ land: 1, downstream: 2, upstream: 5 });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/rivers run backwards/);
    expect(asymmetryWarnings({ land: 1, downstream: 0.7, upstream: 0.8 })).toHaveLength(2);
  });
});

describe("carry reach — every reach is a ratio of declared quantities", () => {
  const durable = (valueDensity: number) => ({ valueDensity, transit: "durable" as const });

  it("more valuable carries farther; water carries farther than land", () => {
    const near = carryReachM(REAL_SCALE, durable(1));
    const far = carryReachM(REAL_SCALE, durable(16));
    expect(far / near).toBeCloseTo(16);
    const land = carryReachM(REAL_SCALE, durable(1), "land");
    const up = carryReachM(REAL_SCALE, durable(1), "upstream");
    const down = carryReachM(REAL_SCALE, durable(1), "downstream");
    expect(down).toBeGreaterThan(up);
    expect(up).toBeGreaterThan(land);
    expect(down / land).toBeCloseTo(REAL_ASYMMETRY.downstream);
  });

  it("compression shrinks the hinterland with the town: dollhouse reach = real reach ÷ 360", () => {
    // Same break-even DAYS (dimensionless), shorter days ⇒ nearer metres.
    const f = durable(4);
    expect(haulBreakEvenDays(DOLLHOUSE_SCALE, 4)).toBeCloseTo(haulBreakEvenDays(REAL_SCALE, 4));
    const ratio = carryReachM(DOLLHOUSE_SCALE, f) / carryReachM(REAL_SCALE, f);
    // sleepFraction differs (0.05 vs ⅓), so the ratio is 1/360 × waking share.
    expect(ratio).toBeCloseTo((1 / 360) * ((1 - 0.05) / (1 - 1 / 3)));
  });

  it("the Ox Paradox: a staple's break-even IS carryDays halved, and delivery hits 0 exactly there", () => {
    const food = freightOf("food");
    const breakEven = haulBreakEvenDays(REAL_SCALE, food.valueDensity);
    expect(breakEven).toBeCloseTo(carryDays(REAL_SCALE, REAL_PORTER_BULK) / 2);
    expect(deliveredFraction(REAL_SCALE, food, breakEven)).toBeCloseTo(0);
    expect(deliveredFraction(REAL_SCALE, food, breakEven / 2)).toBeCloseTo(0.5);
    // The agreement holds at ANY density (a denser food thins slower in bulk).
    const dense = { valueDensity: 3, transit: "selfConsuming" as const };
    expect(deliveredFraction(REAL_SCALE, dense, haulBreakEvenDays(REAL_SCALE, 3))).toBeCloseTo(0);
  });

  it("fragile goods effectively don't travel — reach caps at the loss half-life", () => {
    const charcoalish = { valueDensity: VALUE_TIER.refined, transit: "fragile" as const };
    const durableTwin = durable(VALUE_TIER.refined);
    const fragileReach = carryReachM(REAL_SCALE, charcoalish);
    expect(fragileReach).toBeLessThan(carryReachM(REAL_SCALE, durableTwin));
    // At the default loss, half the load is gone per travel day.
    expect(fragileHalfLifeDays()).toBeCloseTo(1);
    expect(fragileReach).toBeCloseTo(dailyTravelM(REAL_SCALE) * 1);
    // Half-life reach means half arrives at the edge of the viable range.
    expect(deliveredFraction(REAL_SCALE, charcoalish, fragileHalfLifeDays())).toBeCloseTo(0.5);
  });

  it("durable cargo never thins — distance costs wages, not substance", () => {
    expect(deliveredFraction(REAL_SCALE, durable(1), 1000)).toBe(1);
  });

  it("faster legs stretch every reach (the locomotion dial reaches transport)", () => {
    const mounted: WorldScale = { ...REAL_SCALE, locomotion: 3 };
    expect(carryReachM(mounted, durable(2)) / carryReachM(REAL_SCALE, durable(2))).toBeCloseTo(3);
  });

  it("a faster metabolism shortens every reach (the hauler eats the margin)", () => {
    const hungry: WorldScale = { ...REAL_SCALE, metabolism: 3 };
    expect(carryReachM(hungry, durable(2)) / carryReachM(REAL_SCALE, durable(2))).toBeCloseTo(1 / 3);
  });
});

describe("the EconomyDoc seam (freight blocks on commodities)", () => {
  // `transport: {}` gives food its ledger vars (the implicit human eats it).
  const minimalDoc = (freight?: unknown) => ({
    commodities: [
      { key: "food", scalarMax: 10, transport: {}, ...(freight !== undefined ? { freight } : {}) },
      { key: "obsidian", scalarMax: 10 },
    ],
  });

  it("compile resolves every commodity: declared block over registry row over durable default", () => {
    const eco = compileEconomy([
      parseEconomyDoc(minimalDoc({ valueDensity: 2.5 }), "t"),
    ]);
    expect(eco.freights).toEqual([
      // Declared density over the registry's food row; transit still the row's.
      { good: "food", valueDensity: 2.5, transit: "selfConsuming" },
      // Undeclared, unregistered: the durable staple default.
      { good: "obsidian", valueDensity: 1, transit: "durable" },
    ]);
  });

  it("the JSON gate refuses typos and unknown behaviors path-exactly", () => {
    expect(() => parseEconomyDoc(minimalDoc({ valueDensty: 2 }), "t")).toThrow(
      /commodities\[0\]\.freight.*unknown field "valueDensty"/,
    );
    expect(() => parseEconomyDoc(minimalDoc({ transit: "soggy" }), "t")).toThrow(
      /"transit" must be one of: selfConsuming, fragile, durable/,
    );
  });

  it("a non-positive declared density fails compile naming the commodity", () => {
    expect(() =>
      compileEconomy([parseEconomyDoc(minimalDoc({ valueDensity: 0 }), "t")]),
    ).toThrow(/commodity "food" freight valueDensity/);
  });
});
