// THE NUMERAIRE (nations P3/E4 — kernel/town/money.ts + economy content):
// money is the ⑤ pair-worth math with ONE fixed denominator, emerging only
// when the trade network is dense (activeTradePairs ≥ threshold) and a
// medium is declared. Content gates: EconomyDoc.numeraire (parse + compile
// validation, later-doc wins) and the town-play config override. Pure.

import { describe, it, expect } from "@jest/globals";
import {
  NUMERAIRE_PAIRS_THRESHOLD, activeTradePairs, numeraireActive,
  priceInNumeraire, priceQuote,
} from "@shared/world-engine/kernel/town/money.js";
import type { TransferAgreement } from "@shared/world-engine/kernel/town/transfer.js";
import type { BarterSignals } from "@shared/world-engine/kernel/town/barter.js";
import {
  compileEconomy, parseEconomyDoc,
} from "@shared/world-engine/kernel/modules/economy/index.js";
import { buildTownPlay, TOWN_PLAY_ECONOMY } from "@shared/world-engine/interaction/town/town-play.js";
import { parseTownWorld } from "@shared/world-engine/interaction/town/town-play-game.js";

const barterRow = (
  partnerKey: string, giveGood: string, takeGood: string,
  status: TransferAgreement["status"] = "pending",
): TransferAgreement => ({
  id: `a_${partnerKey}_${giveGood}_${takeGood}_${status}`,
  from: "town:us", to: `town:${partnerKey}`, goods: { [giveGood]: 1 },
  issuer: "p", mode: "scheduled", createdAt: 0, status,
  barter: {
    take: { [takeGood]: 1 }, giveGood, takeGood,
    quote: { give: 1, take: 1 }, partnerKey,
  },
});

const signals = (m: Record<string, number>): BarterSignals => ({
  shortage: (g) => m[g] ?? 0,
});

describe("emergence — the network-density threshold", () => {
  it("counts DISTINCT live trade relationships; history and plain hauls don't", () => {
    const rows = [
      barterRow("a", "wood", "food"),
      barterRow("a", "wood", "food"), // duplicate relationship
      barterRow("a", "cloth", "food"),
      barterRow("b", "wood", "food"),
      barterRow("c", "wood", "food", "done"),   // history
      barterRow("c", "wood", "food", "failed"), // history
      { ...barterRow("d", "x", "y"), barter: undefined }, // a plain haul
    ];
    expect(activeTradePairs(rows)).toBe(3);
  });

  it("numeraireActive needs BOTH a declared medium and a dense network", () => {
    const dense = [
      barterRow("a", "wood", "food"), barterRow("b", "cloth", "food"), barterRow("c", "wood", "cloth"),
    ];
    expect(dense.length).toBe(NUMERAIRE_PAIRS_THRESHOLD);
    expect(numeraireActive("cloth", dense)).toBe(true);
    expect(numeraireActive(null, dense)).toBe(false);
    expect(numeraireActive("cloth", dense.slice(0, 2))).toBe(false);
  });
});

describe("prices — pair-worth with one fixed denominator", () => {
  const us = signals({ food: 0.8, cloth: 0.1 });
  const them = signals({ food: 0.4, cloth: 0.1 });

  it("the medium prices itself at 1; scarcer goods cost more of it", () => {
    expect(priceInNumeraire("cloth", "cloth", us, them)).toBe(1);
    expect(priceInNumeraire("food", "cloth", us, them)).toBeGreaterThan(1);
    // Plentiful priced in scarce: below 1, still inside the spoken clamp.
    const p = priceInNumeraire("cloth", "food", us, them);
    expect(p).toBeLessThan(1);
    expect(p).toBeGreaterThanOrEqual(1 / 3);
  });

  it("quotes are speakable whole pairs best-fit to the real ratio", () => {
    const q = priceQuote("food", "cloth", us, them);
    expect(q.give).toBeGreaterThanOrEqual(1);
    expect(q.give).toBeLessThanOrEqual(3);
    expect(q.take).toBeGreaterThanOrEqual(1);
    expect(q.take).toBeLessThanOrEqual(3);
    // A scarcer give-good takes MORE medium per unit than the reverse.
    expect(q.take / q.give).toBeGreaterThanOrEqual(1);
  });
});

describe("money as CONTENT — the economy doc + town config gates", () => {
  it("parseEconomyDoc accepts numeraire and rejects a non-string", () => {
    expect(parseEconomyDoc({ numeraire: "metal" }).numeraire).toBe("metal");
    expect(() => parseEconomyDoc({ numeraire: 3 })).toThrow(/numeraire/);
    expect(() => parseEconomyDoc({ numerare: "metal" })).toThrow(/unknown field/);
  });

  it("compileEconomy validates the medium is a real commodity; later doc wins", () => {
    expect(() => compileEconomy([{ ...TOWN_PLAY_ECONOMY, numeraire: "gold" }]))
      .toThrow(/numeraire "gold"/);
    const eco = compileEconomy([
      { ...TOWN_PLAY_ECONOMY, numeraire: "food" },
      { numeraire: "cloth" }, // the override doc
    ], { construction: true });
    expect(eco.numeraire).toBe("cloth");
    expect(compileEconomy([TOWN_PLAY_ECONOMY]).numeraire).toBeNull();
  });

  it("the town-play override rides the world doc and validates against street goods", () => {
    const { config } = parseTownWorld({ seed: 7, numeraire: "clothing" }, "w");
    expect(config.numeraire).toBe("clothing");
    expect(() => parseTownWorld({ seed: 7, numeraire: 9 }, "w")).toThrow(/w\.numeraire/);
    const play = buildTownPlay({ seed: 7, days: 40, questCount: 0, numeraire: "clothing" });
    expect(play.eco.numeraire).toBe("clothing");
    expect(() => buildTownPlay({ seed: 7, days: 40, questCount: 0, numeraire: "gold" }))
      .toThrow(/not a street good/);
    // A numeraire-less village compiles to pure barter, byte-identically.
    expect(buildTownPlay({ seed: 7, days: 40, questCount: 0 }).eco.numeraire).toBeNull();
  });
});
