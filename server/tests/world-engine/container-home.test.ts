// THE DESIGNATED-CONTAINER LADDER (kernel/town/container-home.ts) — the exact
// piece quest-host wires for tidying, the bank-on-give-up and the fetch's
// first look. Pins each rung, and especially the CLOTHING rung: clothes
// belong in the CABINET (the house cupboard), never a member's box — clean
// or dirty alike, since the HEAD routes like every other clothing rule.

import { describe, expect, it } from "@jest/globals";
import {
  designatedContainerId,
  type ContainerHomeCtx,
} from "@shared/world-engine/kernel/town/container-home.js";

/** A house where every furniture id the ladder can name exists. */
const ctx = (over: Partial<ContainerHomeCtx> = {}): ContainerHomeCtx => ({
  provisionedHeads: new Set<string>(),
  exists: () => true,
  ...over,
});

describe("designatedContainerId — the one home-container ladder", () => {
  it("water goes to the barrel", () => {
    expect(designatedContainerId("water", 3, ctx())).toBe("furn_3_barrel");
  });

  it("a provisioned good goes to its good's chest", () => {
    const c = ctx({ provisionedHeads: new Set(["apple"]) });
    expect(designatedContainerId("apple", 0, c)).toBe("furn_0_chest_food");
  });

  it("PROVISIONED clothing keeps the wardrobe chest (rung 2 beats the cabinet)", () => {
    const c = ctx({ provisionedHeads: new Set(["shirt", "dress"]) });
    expect(designatedContainerId("shirt.color_red", 1, c)).toBe("furn_1_chest_clothing");
  });

  it("UNPROVISIONED clothes go to the cabinet, never a box — even an OWNED garment", () => {
    // The owner's box exists and would win rung 4; the cabinet must preempt it.
    const c = ctx({ ownerId: "resident_2_1", selfId: "resident_2_3" });
    expect(designatedContainerId("shirt.color_red", 2, c)).toBe("furn_2_cupboard");
    // Dirty variant routes by HEAD too — the laundry pile hangs with the clothes.
    expect(designatedContainerId("dress.color_blue.dirty", 2, c)).toBe("furn_2_cupboard");
  });

  it("with no cabinet registered, a garment falls through to the box rungs", () => {
    const c = ctx({
      ownerId: "resident_2_1",
      exists: (id) => id !== "furn_2_cupboard",
    });
    expect(designatedContainerId("shirt.color_red", 2, c)).toBe("furn_2_box_1");
  });

  it("an owned non-garment goes to its OWNER's box, whoever is stowing it", () => {
    const c = ctx({ ownerId: "resident_0_4", selfId: "resident_0_2" });
    expect(designatedContainerId("teddy", 0, c)).toBe("furn_0_box_4");
  });

  it("an unowned thing goes to the stower's own box", () => {
    expect(designatedContainerId("ball", 0, ctx({ selfId: "resident_0_2" }))).toBe("furn_0_box_2");
  });

  it("no owner, no stower: the first member box that exists", () => {
    const c = ctx({ exists: (id) => id === "furn_0_box_3" });
    expect(designatedContainerId("ball", 0, c)).toBe("furn_0_box_3");
  });

  it("no box at all: the cupboard backstop", () => {
    const c = ctx({ selfId: "resident_0_2", exists: () => false });
    expect(designatedContainerId("ball", 0, c)).toBe("furn_0_cupboard");
  });
});
