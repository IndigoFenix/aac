/**
 * The EXTERNAL-CONTENT gates: `parseEconomyDoc` (structure — wrong
 * types and typo'd fields fail with the exact path) and compileEconomy's
 * author-error validation (semantics — dangling references fail with
 * the def's name). Mods break at load, never at runtime as a silent 0.
 */

import { describe, expect, it } from "vitest";
import rawClothing from "../content/clothing.economy.json";
import { parseEconomyDoc } from "../economy-json";
import { compileEconomy, type BuildingDef, type EconomyDoc } from "../economy";
import { CORE_BASE, CORE_GOODS2 } from "../economy-core";
import { CLOTHING } from "../economy-clothing";

/** A minimal well-formed building for mutation tests. */
const shed = (over: Partial<BuildingDef> = {}): BuildingDef => ({
  key: "shed", countScalar: "sheds", cap: { by: "population", rate: 0.001 },
  processes: [], construction: { tier: "base", costs: [{ stockpile: "granary", amount: 10 }] },
  leansToward: null, mapCap: 1, district: null,
  style: { color: "#888", w: 5, h: 5 }, vignette: { w: 4, h: 4 },
  glyph: "▪", title: "Shed", info: [],
  ...over,
});

describe("parseEconomyDoc: the structural boot gate", () => {
  it("the shipped clothing file parses to the doc the world runs", () => {
    const doc = parseEconomyDoc(rawClothing, "clothing.economy.json");
    expect(doc).toEqual(CLOTHING); // the shim IS this parse
    // The farm entry is a cross-document OVERRIDE (adds hay for the
    // sheep) — the sanctioned mechanism goods2 uses for metal.
    expect(doc.buildings?.map(b => b.key)).toEqual(["farm", "sheepfold", "weaver"]);
    expect(doc.species?.map(s => s.key)).toEqual(["sheep"]);
    expect(doc.commodities?.find(c => c.key === "cloth")?.street?.boxLabel).toBe("Linen chest");
  });

  it("typo'd fields fail with the exact path (no silent defaults)", () => {
    const bad = JSON.parse(JSON.stringify(rawClothing)) as Record<string, unknown>;
    (bad.commodities as Array<Record<string, unknown>>)[1].stret = { capDays: 1 };
    expect(() => parseEconomyDoc(bad, "mod.json")).toThrow(/mod\.json\.commodities\[1\].*unknown field "stret"/);
  });

  it("wrong types, bad tiers and malformed processes are named precisely", () => {
    expect(() => parseEconomyDoc({ commodities: [{ key: "x", scalarMax: "big" }] }, "m"))
      .toThrow(/m\.commodities\[0\].*"scalarMax" must be a finite number/);
    expect(() => parseEconomyDoc({
      buildings: [{ ...shed(), construction: { tier: "luxury", costs: [] } }],
    }, "m")).toThrow(/"tier" must be "base" or "industry"/);
    expect(() => parseEconomyDoc({
      buildings: [{ ...shed(), processes: [{ id: "p", output: "y" }] }],
    }, "m")).toThrow(/exactly one of "input" \/ "inputs"/);
    expect(() => parseEconomyDoc([], "m")).toThrow(/expected an object/);
  });
});

describe("compileEconomy: the semantic author-error gate", () => {
  const compile = (doc: EconomyDoc): unknown =>
    compileEconomy([CORE_BASE, CORE_GOODS2, doc], { construction: true });

  it("dangling references fail with the def's name", () => {
    // A cost on a stockpile nobody declared.
    expect(() => compile({ buildings: [shed({ construction: { tier: "base", costs: [{ stockpile: "warehouse", amount: 5 }] } })] }))
      .toThrow(/"shed" costs unknown stockpile "warehouse"/);
    // Selling a commodity that doesn't exist.
    expect(() => compile({ buildings: [shed({ sells: ["gems"] })] }))
      .toThrow(/"shed" sells unknown commodity "gems"/);
    // A shelf with nothing on it.
    expect(() => compile({ buildings: [shed({ shelved: true })] }))
      .toThrow(/"shed" is shelved but sells nothing/);
    // A street producer that isn't a building (nor hall/market).
    expect(() => compile({
      commodities: [{
        key: "gems", scalarMax: 10, perPersonDaily: 0.0001, transport: {},
        street: {
          capDays: 5, shopSec: 10, cartRations: 10, unit: "gems",
          producers: ["jeweler"], stockColor: "#fff", boxLabel: "Gem box", errandName: "gems",
        },
      }],
    })).toThrow(/"gems" names unknown producer "jeweler"/);
    // A typo'd scalar in a process — caught at compile, named.
    expect(() => compile({
      buildings: [shed({ processes: [{ id: "p", input: "timberlnd", output: "sheds", efficiency: 1 }] })],
    })).toThrow(/process "p" references undeclared scalar "timberlnd"/);
    // Duplicates within ONE document (cross-doc repeats are overrides).
    expect(() => compile({ buildings: [shed(), shed()] }))
      .toThrow(/duplicate building "shed" within one document/);
  });

  it("a valid extra document compiles on top of the full standard stack", () => {
    const eco = compileEconomy([CORE_BASE, CORE_GOODS2, CLOTHING, {
      commodities: [{
        key: "ale", scalarMax: 100, perPersonDaily: 0.0004, transport: {},
        street: {
          capDays: 6, shopSec: 20, cartRations: 20, unit: "pints",
          producers: ["brewery"], stockColor: "#c98a2a", boxLabel: "Ale cask", errandName: "ale",
        },
      }],
      buildings: [{
        key: "brewery", countScalar: "breweries", cap: { by: "population", rate: 0.0001 },
        processes: [
          { id: "brew", input: "grain_out", output: "ale_out", efficiency: 0.1, capacityRate: 4 },
        ],
        construction: { tier: "industry", costs: [{ stockpile: "granary", amount: 30 }] },
        sells: ["ale"], shelved: true, leansToward: null, mapCap: 2, district: "craft",
        style: { color: "#7a4b26", w: 12, h: 8 }, vignette: { w: 5, h: 4 },
        glyph: "🍺", title: "🍺 Brewery", info: ["{breweries} breweries."],
      }],
    }], { construction: true });
    // Fourth street good, fourth slot (the last box corner), stagger
    // extends past clothing's: 25/55/75/100/130.
    expect(eco.goods.map(g => [g.key, g.slot])).toEqual([
      ["food", 0], ["tools", 1], ["cloth", 2], ["ale", 3],
    ]);
    const brewery = eco.rules.find(r => r.id === "build-brewery")!;
    const all = (brewery.when as { all: Array<{ left?: { scalar?: string }; right?: { const?: number } }> }).all;
    expect(all.find(c => c.left?.scalar === "granary")?.right?.const).toBe(130);
  });
});
