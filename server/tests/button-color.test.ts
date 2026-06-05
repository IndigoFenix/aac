/**
 * Tests for shared/button-color.ts — the single source of truth for AAC
 * board-button color now that resolution lives server-side. Covers the token
 * resolver (explicit wins, special find/more, auto yes/no), the name→hex map
 * with raw-hex passthrough, and the border-class helper.
 */

import { describe, it, expect } from "@jest/globals";
import {
  COLOR_MAP,
  SPECIAL_BUTTON_COLORS,
  detectYesNoDefaultColor,
  resolveButtonColorToken,
  mapColorToHex,
  resolveButtonBackground,
  resolveBorderClass,
} from "../../shared/button-color.js";

describe("detectYesNoDefaultColor", () => {
  it("returns green for a glyph containing a bare yes SYMBOL", () => {
    expect(detectYesNoDefaultColor("yes")).toBe("green");
    expect(detectYesNoDefaultColor("i_me+want+yes")).toBe("green");
  });
  it("returns red for a glyph containing a bare no SYMBOL", () => {
    expect(detectYesNoDefaultColor("no")).toBe("red");
    expect(detectYesNoDefaultColor("i_me+no.big")).toBe("red");
  });
  it("returns undefined when both yes and no are present (ambiguous)", () => {
    expect(detectYesNoDefaultColor("yes+no")).toBeUndefined();
  });
  it("returns undefined for neither / empty", () => {
    expect(detectYesNoDefaultColor("water")).toBeUndefined();
    expect(detectYesNoDefaultColor("")).toBeUndefined();
    expect(detectYesNoDefaultColor(undefined)).toBeUndefined();
  });
  it("does not match yes/no inside larger tokens", () => {
    expect(detectYesNoDefaultColor("yesterday")).toBeUndefined();
    expect(detectYesNoDefaultColor("nose")).toBeUndefined();
  });
});

describe("resolveButtonColorToken", () => {
  it("explicit color always wins (named or raw hex)", () => {
    expect(resolveButtonColorToken({ color: "blue", glyph: "yes" })).toBe("blue");
    expect(resolveButtonColorToken({ color: "#3B82F6", glyph: "no" })).toBe("#3B82F6");
    expect(resolveButtonColorToken({ color: "pink", buttonType: "wordfinder" })).toBe("pink");
  });
  it("ignores a blank/whitespace color and falls through", () => {
    expect(resolveButtonColorToken({ color: "   ", glyph: "yes" })).toBe("green");
  });
  it("special meta buttons get their fixed colors", () => {
    expect(resolveButtonColorToken({ buttonType: "wordfinder" })).toBe(SPECIAL_BUTTON_COLORS.wordfinder);
    expect(resolveButtonColorToken({ buttonType: "more" })).toBe(SPECIAL_BUTTON_COLORS.more);
  });
  it("auto-colors yes/no from the glyph when no explicit color", () => {
    expect(resolveButtonColorToken({ glyph: "yes" })).toBe("green");
    expect(resolveButtonColorToken({ glyph: "no" })).toBe("red");
  });
  it("falls back to white", () => {
    expect(resolveButtonColorToken({ glyph: "water" })).toBe("white");
    expect(resolveButtonColorToken({})).toBe("white");
  });
});

describe("mapColorToHex", () => {
  it("maps named tokens to pastel hex", () => {
    expect(mapColorToHex("green")).toBe(COLOR_MAP.green);
    expect(mapColorToHex("GREEN")).toBe(COLOR_MAP.green);
  });
  it("passes raw CSS colors through unchanged", () => {
    expect(mapColorToHex("#3B82F6")).toBe("#3B82F6");
    expect(mapColorToHex("#D6FFF6FF")).toBe("#D6FFF6FF");
  });
  it("defaults missing input to white", () => {
    expect(mapColorToHex(undefined)).toBe("#FFFFFF");
    expect(mapColorToHex("")).toBe("#FFFFFF");
  });
});

describe("resolveButtonBackground (legacy/fallback)", () => {
  it("matches the old client behavior end-to-end", () => {
    expect(resolveButtonBackground("blue")).toBe(COLOR_MAP.blue);
    expect(resolveButtonBackground(undefined, "yes")).toBe(COLOR_MAP.green);
    expect(resolveButtonBackground(undefined, "no")).toBe(COLOR_MAP.red);
    expect(resolveButtonBackground(undefined, "water")).toBe("#FFFFFF");
    expect(resolveButtonBackground("#123456")).toBe("#123456");
  });
});

describe("resolveBorderClass", () => {
  it("buttonType wins over action flags", () => {
    expect(resolveBorderClass({ buttonType: "guess", isLink: true })).toContain("amber-400");
    expect(resolveBorderClass({ buttonType: "suggestion" })).toContain("violet-400");
    expect(resolveBorderClass({ buttonType: "wordfinder" })).toContain("violet-400");
    expect(resolveBorderClass({ buttonType: "more" })).toContain("gray-300");
  });
  it("falls back to action-based borders, then default", () => {
    expect(resolveBorderClass({ isLink: true })).toContain("blue-400");
    expect(resolveBorderClass({ isBack: true })).toContain("amber-400");
    expect(resolveBorderClass({})).toBe("border-gray-200");
  });
});
