/**
 * The child profiles (harness design ⑤).
 *
 * The invariant worth guarding: a profile's PERCEPTION and its SETTINGS describe
 * the same child. If they drift, a run measures nothing — a board built for a
 * fluent reader, read by a child who cannot read, scored against neither.
 */

import { describe, it, expect } from "@jest/globals";
import {
  landedCell,
  profileById,
  repeatsLastPress,
  SIM_PROFILES,
  simRandom,
  type ChildProfile,
} from "@shared/aac/sim-profiles";
import { LANGUAGE_LEVELS, languageLevelToInt } from "@shared/aac-language-level";
import { VERBAL_ABILITIES } from "@shared/aac/verbal-ability";

const byId = (id: string): ChildProfile => {
  const p = profileById(id);
  if (!p) throw new Error(`no profile ${id}`);
  return p;
};

describe("the seed set is coherent", () => {
  it("has unique ids and a description apiece", () => {
    const ids = SIM_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SIM_PROFILES.every((p) => p.description.length > 0)).toBe(true);
  });

  it("uses only real enum values, so a seeded row is valid", () => {
    for (const p of SIM_PROFILES) {
      expect(VERBAL_ABILITIES).toContain(p.verbalAbility);
      expect(LANGUAGE_LEVELS).toContain(p.receptiveLevel);
      expect(p.aacSettings.languageLevel).toBeGreaterThanOrEqual(1);
      expect(p.aacSettings.languageLevel).toBeLessThanOrEqual(5);
      expect(p.aacSettings.iconTextRatio).toBeGreaterThanOrEqual(1);
      expect(p.aacSettings.iconTextRatio).toBeLessThanOrEqual(5);
    }
  });

  it("keeps probabilities in range", () => {
    for (const p of SIM_PROFILES) {
      expect(p.misselectRate).toBeGreaterThanOrEqual(0);
      expect(p.misselectRate).toBeLessThan(1);
      expect(p.perseveration).toBeGreaterThanOrEqual(0);
      expect(p.perseveration).toBeLessThan(1);
    }
  });

  it("gives every eyegaze child the accessibility settings that go with it", () => {
    // Rest space and the selection-area mark exist BECAUSE of eyegaze; an
    // eyegaze profile without them would silently test a harder board.
    for (const p of SIM_PROFILES.filter((x) => x.access === "eyegaze")) {
      expect(p.aacSettings.eyegazeEnabled).toBe(true);
      expect(p.aacSettings.restSpace).not.toBe("none");
      expect(p.aacSettings.selectionMethod).toBe("selection_area");
    }
  });

  it("never enables eyegaze settings for a child who does not use eyegaze", () => {
    for (const p of SIM_PROFILES.filter((x) => x.access !== "eyegaze")) {
      expect(p.aacSettings.eyegazeEnabled).toBe(false);
    }
  });

  it("stresses different things — the dials genuinely vary", () => {
    const readings = new Set(SIM_PROFILES.map((p) => p.perception.reading));
    const access = new Set(SIM_PROFILES.map((p) => p.access));
    expect(readings.size).toBeGreaterThanOrEqual(3);
    expect(access.size).toBe(3);
  });
});

describe("the languageLevel test case", () => {
  it("low-receptive pins a MISMATCH on purpose", () => {
    // The setting says the AI may use full sentences; the child understands
    // short phrases. A run that reads clean means the setting is not working —
    // or the harness is not modelling comprehension. That contrast is the test,
    // so it must not be 'fixed' into agreement.
    const p = byId("low-receptive");
    expect(p.aacSettings.languageLevel).toBe(languageLevelToInt("full_sentences"));
    expect(p.receptiveLevel).toBe("short_phrases");
  });

  it("every other profile is told to speak at or below what the child follows", () => {
    for (const p of SIM_PROFILES.filter((x) => x.id !== "low-receptive")) {
      const told = p.aacSettings.languageLevel;
      const understood = languageLevelToInt(p.receptiveLevel);
      expect(told).toBeLessThanOrEqual(understood);
    }
  });
});

describe("the input-noise model", () => {
  const grid = { rows: 3, cols: 4 };
  const never = { ...byId("fluent-reader"), misselectRate: 0 } as ChildProfile;
  const always = { ...byId("fluent-reader"), misselectRate: 1 } as ChildProfile;

  it("lands where aimed when it does not miss", () => {
    expect(landedCell(5, grid, never, simRandom(1))).toBe(5);
  });

  it("misses to a NEIGHBOUR, never across the board", () => {
    // A press failing to a random far cell would be a different (and much
    // rarer) failure; modelling it would make dead ends look like noise
    // rather than like a layout problem.
    for (let seed = 1; seed <= 40; seed++) {
      const landed = landedCell(5, grid, always, simRandom(seed));
      const dr = Math.abs(Math.floor(landed / grid.cols) - Math.floor(5 / grid.cols));
      const dc = Math.abs((landed % grid.cols) - (5 % grid.cols));
      expect(dr + dc).toBe(1);
    }
  });

  it("stays on the board at a corner", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const landed = landedCell(0, grid, always, simRandom(seed));
      expect(landed).toBeGreaterThanOrEqual(0);
      expect(landed).toBeLessThan(grid.rows * grid.cols);
    }
  });

  it("cannot miss on a one-cell board", () => {
    expect(landedCell(0, { rows: 1, cols: 1 }, always, simRandom(3))).toBe(0);
  });

  it("passes an out-of-range index through rather than inventing a cell", () => {
    expect(landedCell(99, grid, always, simRandom(3))).toBe(99);
  });

  it("replays exactly for the same seed", () => {
    const a = Array.from({ length: 10 }, (_, i) => landedCell(5, grid, always, simRandom(7 + i)));
    const b = Array.from({ length: 10 }, (_, i) => landedCell(5, grid, always, simRandom(7 + i)));
    expect(a).toEqual(b);
  });

  it("perseveration fires at roughly its stated rate", () => {
    const p = byId("perseverating"); // 0.3
    const rand = simRandom(11);
    let hits = 0;
    for (let i = 0; i < 2000; i++) if (repeatsLastPress(p, rand)) hits++;
    expect(hits / 2000).toBeGreaterThan(0.25);
    expect(hits / 2000).toBeLessThan(0.35);
  });

  it("never repeats for a child with no perseveration", () => {
    const rand = simRandom(5);
    const p = byId("fluent-reader");
    for (let i = 0; i < 200; i++) expect(repeatsLastPress(p, rand)).toBe(false);
  });
});
