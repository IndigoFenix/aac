// The THIN creature gender layer (language-expansion.md): derived, stable,
// never stored — genderFor(cid) feeds lang speaker agreement in place of the
// old symbol-derived guess. Pure logic.

import { describe, it, expect } from "@jest/globals";
import { genderFor } from "@shared/world-engine/interaction/behavior/gender.js";
import { translateGlyph } from "@shared/world-engine/interaction/lang/index.js";

describe("genderFor — stable derived natural gender", () => {
  it("is deterministic per creature id", () => {
    for (const cid of ["resident_h3_0", "resident_h3_1", "pet_h3_0", "bear", "npc_x"]) {
      expect(genderFor(cid)).toBe(genderFor(cid));
    }
  });

  it("honors authored persona hints over the hash", () => {
    expect(genderFor("anyone", "male")).toBe("m");
    expect(genderFor("anyone", "female")).toBe("f");
    // "any" = authored indifference — falls back to the hash, still stable.
    expect(genderFor("anyone", "any")).toBe(genderFor("anyone"));
  });

  it("assigns both genders across a household (not all-masculine)", () => {
    const members = Array.from({ length: 32 }, (_, i) => `resident_h${i % 4}_${i}`);
    const genders = new Set(members.map((cid) => genderFor(cid)));
    expect(genders.has("m")).toBe(true);
    expect(genders.has("f")).toBe(true);
  });

  it("drives speaker agreement in gendered languages", () => {
    const line = (g: "m" | "f") => translateGlyph("give + apple", "he-IL", { firstPerson: true, speaker: g });
    expect(line("m")).toBe("אני נותן לך את התפוח.");
    expect(line("f")).toBe("אני נותנת לך את התפוח.");
  });
});
