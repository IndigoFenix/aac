// STRUCTURE CATALOG (city-expansion ①b): StructureSpec resolution against
// the default catalog (unknown names refuse by returning null — the caller
// phrases a NAMED "can't", never a silent generic fallback), the cost
// arithmetic that powers "we need more wood" (missing glyphs NAMED), and
// the spend that draws facted stack variants toward their material head.
// Pure logic — no DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  costsMet,
  missingCosts,
  resolveStructure,
  spendCosts,
  structureCosts,
  type StructureSpec,
} from "@shared/world-engine/kernel/town/structures.js";
import { TOWN_PLAY_STRUCTURES } from "@shared/world-engine/interaction/town/town-play.js";
import { isSiteMaterial } from "@shared/world-engine/interaction/town/founding.js";

describe("the default catalog (TOWN_PLAY_STRUCTURES)", () => {
  it("ships house / farm / market / workshop with unique type keys", () => {
    const types = TOWN_PLAY_STRUCTURES.map((s) => s.type);
    expect(types).toEqual(expect.arrayContaining(["house", "farm", "market", "workshop"]));
    expect(new Set(types).size).toBe(types.length);
  });

  it("every row is complete: program, footprint, costs in SITE materials, buildDays", () => {
    for (const s of TOWN_PLAY_STRUCTURES) {
      expect(s.glyph.length).toBeGreaterThan(0);
      expect(s.footprint.w).toBeGreaterThan(0);
      expect(s.footprint.d).toBeGreaterThan(0);
      expect(s.buildDays).toBeGreaterThan(0);
      // RESOLVED costs (phase 6): the block bill is derived from the footprint,
      // so a row authors only its extras — `structureCosts` is what any
      // affordability question actually sees, and what has to be gatherable.
      const costs = structureCosts(s);
      expect(Object.keys(costs).length).toBeGreaterThan(0);
      // Costs must be gatherable: the wilderness stacks (wood/stone) and the
      // blocks they refine into — the frontier loop (gather → found → build)
      // has to close.
      for (const glyph of Object.keys(costs)) {
        expect(isSiteMaterial(glyph)).toBe(true);
      }
      expect(s.program).toBeDefined();
    }
  });

  it("the farm row references its economic half by key (never duplicated)", () => {
    const farm = TOWN_PLAY_STRUCTURES.find((s) => s.type === "farm")!;
    expect(farm.economy).toBe("farm");
    // Work buildings staff through per-spec jobs; the house doesn't hire.
    expect(farm.jobs).toBeGreaterThan(0);
    expect(TOWN_PLAY_STRUCTURES.find((s) => s.type === "house")!.jobs).toBe(0);
  });
});

describe("resolveStructure — named resolution, no silent fallback", () => {
  it("resolves by type, case-insensitively", () => {
    expect(resolveStructure(TOWN_PLAY_STRUCTURES, "house")?.type).toBe("house");
    expect(resolveStructure(TOWN_PLAY_STRUCTURES, "Farm")?.type).toBe("farm");
  });

  it("resolves by glyph and label too", () => {
    const custom: StructureSpec[] = [
      {
        type: "smithy", glyph: "forge", label: "the smithy", role: "work",
        footprint: { w: 8, d: 8 }, program: { store: true },
        jobs: 1, costs: { stone: 4 }, buildDays: 1, color: "#888", default: false,
      },
    ];
    expect(resolveStructure(custom, "forge")?.type).toBe("smithy");
    expect(resolveStructure(custom, "the smithy")?.type).toBe("smithy");
  });

  it("an UNKNOWN name returns null (the caller phrases the named refusal)", () => {
    expect(resolveStructure(TOWN_PLAY_STRUCTURES, "cathedral")).toBeNull();
    expect(resolveStructure(TOWN_PLAY_STRUCTURES, "")).toBeNull();
    // "town" is the bare founding order's default — NOT a town-scope structure.
    expect(resolveStructure(TOWN_PLAY_STRUCTURES, "town")).toBeNull();
  });
});

describe("cost arithmetic — the refusal NAMES what is missing", () => {
  const spec = { costs: { wood: 6, stone: 2 } };

  it("missingCosts names each short glyph with its shortfall", () => {
    expect(missingCosts(spec, { wood: 4 })).toEqual({ wood: 2, stone: 2 });
    expect(missingCosts(spec, { wood: 6, stone: 2 })).toEqual({});
    expect(costsMet(spec, { wood: 6, stone: 1 })).toBe(false);
    expect(costsMet(spec, { wood: 6, stone: 2 })).toBe(true);
  });

  it("facted stack variants pay toward their material head (wood.wet is wood)", () => {
    expect(costsMet(spec, { wood: 3, "wood.wet": 3, stone: 2 })).toBe(true);
    expect(missingCosts(spec, { "wood.wet": 5, stone: 2 })).toEqual({ wood: 1 });
  });

  it("spendCosts draws the stock down (plain stacks first), refuses without spending", () => {
    const stock: Record<string, number> = { wood: 4, "wood.wet": 3, stone: 2, apple: 1 };
    expect(spendCosts(spec, stock)).toBe(true);
    // 6 wood = 4 plain + 2 wet; 2 stone exactly; the apple untouched.
    expect(stock).toEqual({ "wood.wet": 1, apple: 1 });

    const short: Record<string, number> = { wood: 1 };
    expect(spendCosts(spec, short)).toBe(false);
    expect(short).toEqual({ wood: 1 }); // nothing spent on refusal
  });
});
