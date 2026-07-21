// CITY HUD (city-expansion ④) at the pure layer — city-hud.ts assembles the
// per-district chips + the city-total row from tracked houses and cohort
// pools; the presenter only renders. Pins the UNLOCK condition (dormant
// under the cap — the village never sees chips), district grouping, glyph
// labeling (zone category; the town glyph for the default district), the
// member-weighted wellbeing face, and worst-shortage-first stock cells.
// No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  cityHudUnlocked,
  cityHudView,
  wellbeingEmoji,
  type CityHudInput,
} from "@shared/world-engine/interaction/quest/city-hud.js";
import {
  DEFAULT_DISTRICT,
  emptyCohortRow,
  type CohortRow,
} from "@shared/world-engine/kernel/town/population.js";

const pool = (district: number, pop: number, stack: Record<string, number> = {}, wellbeing = 0.75): CohortRow => {
  const row = emptyCohortRow(district);
  row.pop = pop;
  row.wellbeing = wellbeing;
  row.stack = { ...stack };
  return row;
};

const base = (over: Partial<CityHudInput> = {}): CityHudInput => ({
  cap: 30,
  tracked: [
    { index: 0, members: 5, district: DEFAULT_DISTRICT, wellbeing: 0.8 },
    { index: 1, members: 5, district: 2, wellbeing: 0.6 },
  ],
  cohorts: [],
  categoryOf: (d) => (d === 2 ? "farm" : null),
  townGlyph: "🏘️",
  goods: [
    { glyph: "food", shortage: 0.4 },
    { glyph: "cloth", shortage: 0.7 },
  ],
  ...over,
});

describe("the unlock condition", () => {
  it("locked under the cap with no pools — the village sees nothing", () => {
    expect(cityHudUnlocked(base())).toBe(false);
    expect(cityHudView(base())).toBeNull();
  });

  it("unlocks when pooled souls exist", () => {
    const input = base({ cohorts: [pool(2, 10)] });
    expect(cityHudUnlocked(input)).toBe(true);
    expect(cityHudView(input)).not.toBeNull();
  });

  it("unlocks when the street population crosses the cap", () => {
    const tracked = Array.from({ length: 7 }, (_, i) => ({
      index: i, members: 5, district: DEFAULT_DISTRICT, wellbeing: 0.75,
    }));
    expect(cityHudUnlocked(base({ tracked }))).toBe(true);
  });
});

describe("the chips", () => {
  it("groups by district — default first, then charter ords; category glyphs label them", () => {
    const view = cityHudView(base({ cohorts: [pool(2, 10, { food: 12 })] }))!;
    expect(view.districts.map((c) => c.district)).toEqual([DEFAULT_DISTRICT, 2]);
    expect(view.districts[0]!.glyph).toBe("🏘️"); // the default district wears the town glyph
    expect(view.districts[1]!.glyph).toBe("farm"); // a chartered district wears its category
  });

  it("population splits tracked vs pooled and sums", () => {
    const view = cityHudView(base({ cohorts: [pool(2, 10)] }))!;
    const farm = view.districts.find((c) => c.district === 2)!;
    expect(farm).toMatchObject({ tracked: 5, pooled: 10, population: 15 });
    expect(view.city).toMatchObject({ district: "city", tracked: 10, pooled: 10, population: 20 });
  });

  it("wellbeing is member-weighted across both tiers", () => {
    const view = cityHudView(base({ cohorts: [pool(2, 5, {}, 0.2)] }))!;
    const farm = view.districts.find((c) => c.district === 2)!;
    expect(farm.wellbeing).toBeCloseTo((0.6 * 5 + 0.2 * 5) / 10, 9);
    expect(farm.emoji).toBe(wellbeingEmoji(farm.wellbeing));
  });

  it("stocks ride worst-shortage-first with the pool's units (heads fold, floored)", () => {
    const view = cityHudView(
      base({ cohorts: [pool(2, 10, { food: 3.9, "food.dry": 2.6, cloth: 1 })] }),
    )!;
    const farm = view.districts.find((c) => c.district === 2)!;
    expect(farm.stocks.map((s) => s.glyph)).toEqual(["cloth", "food"]); // cloth is scarcer
    expect(farm.stocks[0]!.count).toBe(1);
    expect(farm.stocks[1]!.count).toBe(6); // 3.9 + 2.6 → floored head total
  });

  it("the city row folds every pool plus the yard", () => {
    const view = cityHudView(
      base({ cohorts: [pool(2, 10, { food: 4 })], yardStock: { food: 3, wood: 8 } }),
    )!;
    const food = view.city.stocks.find((s) => s.glyph === "food")!;
    expect(food.count).toBe(7);
  });

  it("districts with nobody in them get no chip", () => {
    const view = cityHudView(base({ cohorts: [pool(9, 0), pool(2, 10)] }))!;
    expect(view.districts.some((c) => c.district === 9)).toBe(false);
  });
});

describe("the wellbeing face ladder", () => {
  it("is coarse and monotone", () => {
    expect(wellbeingEmoji(0.9)).toBe("😊");
    expect(wellbeingEmoji(0.5)).toBe("😐");
    expect(wellbeingEmoji(0.3)).toBe("😟");
    expect(wellbeingEmoji(0.1)).toBe("😫");
  });
});
