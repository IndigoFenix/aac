/**
 * Tests for the unified glyph "button syntax" source (server/services/
 * memory-schema/glyph-syntax.ts) shared by the live AAC agents and the
 * clinician board editor.
 */

import { describe, it, expect } from "@jest/globals";
import {
  buildGlyphSyntax,
  buildCustomSymbolsBlock,
  buildKnownPeopleBlock,
} from "../services/memory-schema/glyph-syntax.js";

describe("buildGlyphSyntax", () => {
  it("includes the grammar + generation_rules sections", () => {
    const s = buildGlyphSyntax({ singleGlyphButtons: false });
    expect(s).toContain("<grammar>");
    expect(s).toContain("</grammar>");
    expect(s).toContain("<generation_rules>");
    expect(s).toContain("</generation_rules>");
    expect(s).toContain("SYMBOL: one word");
  });

  it("multi-glyph mode allows up to 3 GLYPHs joined with +", () => {
    const s = buildGlyphSyntax({ singleGlyphButtons: false });
    expect(s).toContain("up to 3 GLYPHs joined with");
    expect(s).not.toContain("one GLYPH per");
  });

  it("single-glyph mode constrains to one GLYPH per button", () => {
    const s = buildGlyphSyntax({ singleGlyphButtons: true });
    expect(s).toContain("one GLYPH per");
    expect(s).not.toContain("up to 3 GLYPHs joined with");
  });

  it("teaches operators (descriptors) and the generate self-check", () => {
    const s = buildGlyphSyntax({ singleGlyphButtons: false });
    expect(s).toContain("#past");
    expect(s).toContain("#future");
    expect(s).toContain("#question");
    expect(s).toContain("MODIFIER SYMBOLs");
    expect(s).toContain("Self-check before EVERY");
  });

  it("teaches the question-word pattern (base#question)", () => {
    for (const single of [false, true]) {
      const s = buildGlyphSyntax({ singleGlyphButtons: single });
      expect(s).toContain("QUESTION WORDS");
      expect(s).toContain("person#question");
      expect(s).toContain("cause#question");
      expect(s).toContain("use#question");
    }
  });
});

describe("buildCustomSymbolsBlock", () => {
  it("returns empty when there are no symbols", () => {
    expect(buildCustomSymbolsBlock(undefined)).toBe("");
    expect(buildCustomSymbolsBlock([])).toBe("");
  });
  it("lists custom symbols as symbol:ID with key/description", () => {
    const s = buildCustomSymbolsBlock([{ id: "abc", key: "doggo", description: "the family dog" }]);
    expect(s).toContain("<custom_symbols>");
    expect(s).toContain("symbol:ID");
    expect(s).toContain("doggo");
    expect(s).toContain("the family dog");
    expect(s).toContain("(id: abc)");
  });
});

describe("buildKnownPeopleBlock", () => {
  it("returns empty when there are no contacts", () => {
    expect(buildKnownPeopleBlock(undefined)).toBe("");
    expect(buildKnownPeopleBlock([])).toBe("");
  });
  it("lists people as face:ID with relationship", () => {
    const s = buildKnownPeopleBlock([{ id: "m1", name: "Mom", relationship: "parent" }]);
    expect(s).toContain("<known_people>");
    expect(s).toContain("[face:m1]");
    expect(s).toContain("Mom");
    expect(s).toContain("(parent)");
  });
});
