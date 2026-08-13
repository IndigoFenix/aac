// The OWNERSHIP SCOPE CHAIN (shared/world-engine/interaction/behavior/
// ownership.ts): creature ⊂ house ⊂ town — private property is invisible
// to housemates' walkers and refused socially; communal tiers admit their
// members; unowned is free. Pure — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  CIVIC_SCOPES,
  TOWN_SCOPE,
  creatureScope,
  houseScope,
  isPrivateOwner,
  mayUse,
  mayUseByScopes,
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

  it("⚖️ S4 — a CIVIC errand reaches the commons and the unowned, never a household", () => {
    // The town's own standing loop (par stocking) acts as the TOWN, not as
    // whichever body happens to issue it — the answer to "what may an
    // automated loop pull from private shelves": nothing.
    expect(mayUseByScopes(CIVIC_SCOPES, TOWN_SCOPE)).toBe(true); // the yard
    expect(mayUseByScopes(CIVIC_SCOPES, null)).toBe(true); // a standing tree
    expect(mayUseByScopes(CIVIC_SCOPES, houseScope(3))).toBe(false); // their pantry
    expect(mayUseByScopes(CIVIC_SCOPES, creatureScope("resident_3_1"))).toBe(false);
    // …and a member of that household still may, through the ordinary door.
    expect(mayUse("resident_3_1", 3, houseScope(3))).toBe(true);
  });

  it("mayUse IS mayUseByScopes over the body's own chain (one rule, two askers)", () => {
    for (const owner of [null, "", TOWN_SCOPE, houseScope(3), houseScope(4), creatureScope("x")]) {
      expect(mayUse("x", 3, owner)).toBe(mayUseByScopes(ownerScopesOf("x", 3), owner));
    }
  });

  it("ownerCidsOf names who may OBJECT", () => {
    expect(ownerCidsOf(`${creatureScope("resident_3_0")}|${creatureScope("resident_3_1")}`))
      .toEqual(["resident_3_0", "resident_3_1"]);
    expect(ownerCidsOf(houseScope(3))).toEqual([]);
    expect(ownerCidsOf(null)).toEqual([]);
  });
});
