// CULTURE DRESS (Phase 2): `game.culture.dress` declares how a town dresses —
// the garment kinds + colour palette its residents wear and its stores stock.
// Parsed/gated like `absolutes` (unknown fields rejected, bounded arrays),
// resolved onto the running culture. The end-to-end effect (residents wear it,
// wardrobes stock it) is exercised by the town-play boot suites; this pins the
// spec gate + resolution.

import { describe, expect, it } from "@jest/globals";
import {
  parseWorldCultureSpec,
  parseWorldDressSpec,
  resolveWorldCulture,
  OPEN_CULTURE,
} from "@shared/world-engine/culture.js";

describe("game.culture.dress — parse + gate", () => {
  it("accepts a dress block alongside absolutes", () => {
    const spec = parseWorldCultureSpec(
      { absolutes: ["fight"], dress: { kinds: ["dress"], palette: ["color_pink", "color_purple"] } },
      "game.culture",
    );
    expect(spec.absolutes).toEqual(["fight"]);
    expect(spec.dress).toEqual({ kinds: ["dress"], palette: ["color_pink", "color_purple"] });
  });

  it("a bare palette (no kinds) is legal", () => {
    const spec = parseWorldCultureSpec({ dress: { palette: ["color_red"] } }, "game.culture");
    expect(spec.dress).toEqual({ palette: ["color_red"] });
    expect(spec.absolutes).toBeUndefined();
  });

  it("rejects unknown fields, non-arrays, junk entries, and over-long arrays — path-exact", () => {
    expect(() => parseWorldCultureSpec({ dress: { colours: ["x"] } }, "game.culture")).toThrow(
      /game\.culture\.dress\.colours: unknown field/,
    );
    expect(() => parseWorldDressSpec({ palette: "color_red" }, "d")).toThrow(/d\.palette: expected an array/);
    expect(() => parseWorldDressSpec({ palette: ["color_red", ""] }, "d")).toThrow(/d\.palette\[1\]/);
    expect(() => parseWorldDressSpec({ palette: Array(17).fill("color_red") }, "d")).toThrow(/at most 16/);
    expect(() => parseWorldDressSpec({ kinds: Array(9).fill("shirt") }, "d")).toThrow(/at most 8/);
  });
});

describe("game.culture.dress — resolve", () => {
  it("carries the dress onto the resolved culture", () => {
    const culture = resolveWorldCulture({ dress: { palette: ["color_green"] } });
    expect(culture.dress).toEqual({ palette: ["color_green"] });
    expect(culture.absolutes.size).toBe(0);
  });

  it("no culture / no dress resolves to the open culture (curated default applies downstream)", () => {
    expect(resolveWorldCulture(null)).toBe(OPEN_CULTURE);
    expect(resolveWorldCulture({}).dress).toBeUndefined();
    // a dress-only declaration still resolves (not the shared OPEN_CULTURE singleton).
    expect(resolveWorldCulture({ dress: { palette: ["color_red"] } })).not.toBe(OPEN_CULTURE);
  });
});
