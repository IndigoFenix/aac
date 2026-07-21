// The living world's day/night clock (world-clock.ts). Pure time math — no DOM/GL,
// safe in the default `npm test`. The determinism the rule system leans on.

import { describe, it, expect } from "@jest/globals";
import {
  advanceClock,
  createWorldClock,
  dayCount,
  dayPhase,
  isDark,
  isNight,
  timeOfDay,
  worldConditions,
} from "@shared/world-engine/world-clock.js";

describe("world clock — time-of-day + phases", () => {
  it("starts at midnight (time 0 = deep night)", () => {
    const c = createWorldClock();
    expect(timeOfDay(c)).toBe(0);
    expect(dayPhase(c)).toBe("night");
    expect(isNight(c)).toBe(true);
    expect(isDark(c)).toBe(true);
  });

  it("midday is full day", () => {
    const c = createWorldClock({ dayLength: 1000 }, 500); // 0.5 through the cycle
    expect(timeOfDay(c)).toBeCloseTo(0.5);
    expect(dayPhase(c)).toBe("day");
    expect(isDark(c)).toBe(false);
  });

  it("wider daylightFraction widens the day symmetrically around noon", () => {
    const narrow = createWorldClock({ dayLength: 1000, daylightFraction: 0.2 }, 350);
    const wide = createWorldClock({ dayLength: 1000, daylightFraction: 0.8 }, 350);
    // 0.35 is inside the wide day band (0.1..0.9) but outside the narrow one (0.4..0.6).
    expect(dayPhase(wide)).not.toBe("night");
    expect(dayPhase(narrow)).toBe("night");
  });

  it("hits dawn then day then dusk then night across a cycle", () => {
    const cfg = { dayLength: 1000, daylightFraction: 0.6, transition: 0.08 };
    // day band = 0.2..0.8; dawn = 0.2..0.28, dusk = 0.72..0.8.
    const at = (f: number) => dayPhase(createWorldClock(cfg, f * 1000));
    expect(at(0.05)).toBe("night");
    expect(at(0.24)).toBe("dawn");
    expect(at(0.5)).toBe("day");
    expect(at(0.76)).toBe("dusk");
    expect(at(0.95)).toBe("night");
  });
});

describe("world clock — advance is pure + monotonic", () => {
  it("advanceClock returns a NEW clock and never rewinds", () => {
    const c0 = createWorldClock({ dayLength: 100 });
    const c1 = advanceClock(c0, 40);
    expect(c0.time).toBe(0); // original untouched
    expect(c1.time).toBe(40);
    const c2 = advanceClock(c1, -999); // negative dt clamped to 0
    expect(c2.time).toBe(40);
  });

  it("dayCount ticks over at each dayLength", () => {
    const c = createWorldClock({ dayLength: 100 });
    expect(dayCount(c)).toBe(0);
    expect(dayCount(advanceClock(c, 250))).toBe(2);
  });

  it("wraps cleanly across multiple days (phase depends only on time-of-day)", () => {
    const cfg = { dayLength: 100 };
    const noonDay0 = dayPhase(createWorldClock(cfg, 50));
    const noonDay3 = dayPhase(createWorldClock(cfg, 350)); // 3 days + 50
    expect(noonDay3).toBe(noonDay0);
  });
});

describe("world clock — worldConditions tokens (what rules match)", () => {
  it("night emits the 'night' token; day emits 'day'", () => {
    const night = worldConditions(createWorldClock({ dayLength: 1000 }, 0));
    expect(night.has("night")).toBe(true);
    expect(night.has("day")).toBe(false);

    const day = worldConditions(createWorldClock({ dayLength: 1000 }, 500));
    expect(day.has("day")).toBe(true);
    expect(day.has("night")).toBe(false);
  });

  it("dawn/dusk emit only their own token, not the coarse day/night", () => {
    const cfg = { dayLength: 1000, daylightFraction: 0.6, transition: 0.08 };
    const dawn = worldConditions(createWorldClock(cfg, 240));
    expect(dawn.has("dawn")).toBe(true);
    expect(dawn.has("day")).toBe(false);
    expect(dawn.has("night")).toBe(false);
  });
});
