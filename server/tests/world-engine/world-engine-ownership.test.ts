// The OWNERSHIP SCOPE CHAIN (shared/world-engine/interaction/behavior/
// ownership.ts): creature ⊂ house ⊂ town — private property is invisible
// to housemates' walkers and refused socially; communal tiers admit their
// members; unowned is free. Pure — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  TOWN_SCOPE,
  creatureScope,
  houseScope,
  isPrivateOwner,
  mayUse,
  ownerCidsOf,
  ownerScopesOf,
} from "@shared/world-engine/interaction/behavior/ownership.js";

describe("the scope chain", () => {
  it("a resident belongs to itself, its household, and the town", () => {
    expect(ownerScopesOf("resident_3_1", 3)).toEqual([
      "creature:resident_3_1",
      "house:3",
      "town",
    ]);
  });

  it("a houseless creature (the player, a quest NPC) skips the house tier", () => {
    expect(ownerScopesOf("player", null)).toEqual(["creature:player", "town"]);
    expect(ownerScopesOf("player", Number.NaN)).toEqual(["creature:player", "town"]);
  });

  it("mayUse climbs the chain: own < household < town < unowned", () => {
    const cid = "resident_3_1";
    expect(mayUse(cid, 3, creatureScope(cid))).toBe(true); // my box
    expect(mayUse(cid, 3, creatureScope("resident_3_0"))).toBe(false); // Mara's box
    expect(mayUse(cid, 3, houseScope(3))).toBe(true); // our pantry
    expect(mayUse(cid, 3, houseScope(4))).toBe(false); // the neighbors' pantry
    expect(mayUse(cid, 3, TOWN_SCOPE)).toBe(true); // the well
    expect(mayUse(cid, 3, null)).toBe(true); // a stick on the road
    expect(mayUse(cid, 3, undefined)).toBe(true);
  });

  it("a |-joined owner admits ANY of its scopes (the double bed)", () => {
    const bed = `${creatureScope("resident_3_0")}|${creatureScope("resident_3_1")}`;
    expect(mayUse("resident_3_0", 3, bed)).toBe(true);
    expect(mayUse("resident_3_1", 3, bed)).toBe(true);
    expect(mayUse("resident_3_2", 3, bed)).toBe(false); // the kids' beds are elsewhere
  });

  it("pets share the household tier (their bowl is house-scoped)", () => {
    expect(mayUse("pet_3_0", 3, houseScope(3))).toBe(true);
  });
});

describe("the private tier", () => {
  it("isPrivateOwner marks creature scopes only — every tier above is communal", () => {
    expect(isPrivateOwner(creatureScope("resident_3_0"))).toBe(true);
    expect(isPrivateOwner(`${creatureScope("a")}|${creatureScope("b")}`)).toBe(true);
    expect(isPrivateOwner(houseScope(3))).toBe(false);
    expect(isPrivateOwner(TOWN_SCOPE)).toBe(false);
    expect(isPrivateOwner(null)).toBe(false);
    expect(isPrivateOwner("vendor_node_7")).toBe(false); // legacy vendor ids
  });

  it("ownerCidsOf names who may OBJECT", () => {
    expect(ownerCidsOf(`${creatureScope("resident_3_0")}|${creatureScope("resident_3_1")}`))
      .toEqual(["resident_3_0", "resident_3_1"]);
    expect(ownerCidsOf(houseScope(3))).toEqual([]);
    expect(ownerCidsOf(null)).toEqual([]);
  });
});
