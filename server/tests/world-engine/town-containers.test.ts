/**
 * CONTAINERS AS SCOPES (kernel/town/containers.ts) — step ② of
 * scope-unification.md.
 *
 * The reported defect this closes, in the user's words: "although the water was
 * visible within the deconstructed barrel, it seems to have disappeared when it
 * was placed as a fixture. There was a point in between when the barrel was
 * placed in a box… The refrigerator's food items were retained, and the
 * refrigerator was not placed in a box, so maybe that's the issue."
 *
 * It was. Putting a container into a container dissolved it into ONE TALLY in
 * that container's stack, and its own stock — keyed by an object id that had
 * just stopped existing — was orphaned. A scope cannot be a number.
 *
 * No DOM / GL / session.
 */
import { describe, it, expect } from "@jest/globals";
import {
  containerDefOfGlyph,
  isContainerKind,
  isPortableContainer,
  isWornContainer,
  mayDissolveToStack,
  FURNITURE_CONTAINER_CAP,
  INSTANCE_SLOTS,
  PORTABLE_CONTAINERS,
} from "@shared/world-engine/kernel/town/containers.js";
import { itemObjectSpec } from "@shared/world-engine/interaction/content/item-prop.js";
import { hasObjectModel, objectModelKey } from "@shared/world-engine/object-models.js";
import { furnitureGlyph } from "@shared/world-engine/kernel/town/stations.js";

const AT = { x: 0, y: 0 };

describe("🚨 a scope cannot be a number", () => {
  it("A FULL BARREL NEVER DISSOLVES INTO A TALLY — the reported bug", () => {
    expect(mayDissolveToStack(furnitureGlyph("barrel"), { water: 2 })).toBe(false);
  });

  it("but an EMPTY one does — a flat-packed barrel is just a barrel", () => {
    expect(mayDissolveToStack(furnitureGlyph("barrel"), {})).toBe(true);
    expect(mayDissolveToStack(furnitureGlyph("barrel"), undefined)).toBe(true);
    // A stock map that has been drained to zero counts as empty, not as full.
    expect(mayDissolveToStack(furnitureGlyph("barrel"), { water: 0 })).toBe(true);
  });

  it("a NON-container always stacks, however many of it there are", () => {
    expect(mayDissolveToStack("apple", { anything: 5 })).toBe(true);
    expect(mayDissolveToStack(furnitureGlyph("chair"), { odd: 1 })).toBe(true);
  });

  it("the refrigerator would have been protected too, had anyone boxed it", () => {
    // It kept its food by luck of routing, not by rule. Now by rule.
    expect(mayDissolveToStack(furnitureGlyph("refrigerator"), { apple: 3 })).toBe(false);
  });
});

describe("what holds things", () => {
  it("agrees with the spec-side authority about which kinds are containers", () => {
    for (const kind of ["chest", "cupboard", "box", "barrel", "bin", "refrigerator", "shelf"] as const) {
      expect([kind, isContainerKind(kind)]).toEqual([kind, true]);
      expect([kind, !!containerDefOfGlyph(furnitureGlyph(kind))]).toEqual([kind, true]);
    }
    for (const kind of ["chair", "bed", "table", "oven", "anvil", "door"] as const) {
      expect([kind, !!containerDefOfGlyph(furnitureGlyph(kind))?.hold]).toEqual([kind, false]);
    }
  });

  it("a lidded piece HIDES its contents; a shelf SHOWS them", () => {
    expect(containerDefOfGlyph(furnitureGlyph("chest"))!.relation).toBe("in");
    expect(containerDefOfGlyph(furnitureGlyph("barrel"))!.relation).toBe("in");
    expect(containerDefOfGlyph(furnitureGlyph("shelf"))!.relation).toBe("on");
  });

  it("THE BASKET is CARRIED and THE SATCHEL is WORN — the pair, and the difference", () => {
    // The one field that differs is the whole point: a basket occupies a hand,
    // a satchel does not. When carry becomes bounded (step ③) that is the
    // difference between fetching something while already holding something,
    // and not being able to.
    const basket = containerDefOfGlyph("basket")!;
    const satchel = containerDefOfGlyph("satchel")!;
    expect(basket.hold).toBe("carry");
    expect(satchel.hold).toBe("wear");
    expect(isWornContainer("satchel")).toBe(true);
    expect(isWornContainer("basket")).toBe(false);
    // …and it costs you: what is on your body holds less than what swings from
    // your arm.
    expect(satchel.capacity).toBeLessThan(basket.capacity);
    expect(isPortableContainer("satchel")).toBe(true);
    expect(basket.capacity).toBeGreaterThan(0);
    expect(isPortableContainer("basket")).toBe(true);
    // Furniture is not portable in this sense: you carry a barrel, but it is
    // not YOUR STORAGE while you do — it is a piece being moved.
    expect(isPortableContainer(furnitureGlyph("barrel"))).toBe(false);
    expect(isPortableContainer("apple")).toBe(false);
  });

  it("reads a faceted glyph by its head (a red basket is a basket)", () => {
    expect(containerDefOfGlyph("basket.color_red")?.hold).toBe("carry");
  });

  it("every portable row declares a hold mode and a real capacity", () => {
    for (const [glyph, def] of Object.entries(PORTABLE_CONTAINERS)) {
      expect([glyph, !!def.hold]).toEqual([glyph, true]);
      expect([glyph, def.capacity > 0]).toEqual([glyph, true]);
    }
  });

  it("furniture holds its declared default when the economy has no opinion", () => {
    expect(containerDefOfGlyph(furnitureGlyph("chest"))!.capacity).toBe(FURNITURE_CONTAINER_CAP);
  });
});

describe("a container is a container WHEREVER it is", () => {
  it("a loose barrel carries its containment slot, so it can still be filled", () => {
    // Before step ②, a deconstructed container had no `contains` at all — it
    // was scenery. Water could be *recorded* against it and nothing could be
    // put *in* it.
    const spec = itemObjectSpec(furnitureGlyph("barrel"), "small:e1", AT);
    expect(spec.contains).toEqual([{ relation: "in", capacity: INSTANCE_SLOTS }]);
  });

  it("a basket on the floor is a place things can go", () => {
    const spec = itemObjectSpec("basket", "small:e2", AT);
    expect(spec.contains).toEqual([{ relation: "in", capacity: INSTANCE_SLOTS }]);
    expect(spec.interactions).toEqual(["carry"]);
  });

  it("THE SATCHEL RENDERS AS ITSELF — a real model, never a floating emoji", () => {
    // 🎒 is a stand-in for the ICON only. A portable container with no recipe
    // would come out as a bare symbol on the ground, which is the question-mark
    // failure the oven taught us; so the recipe ships with the item.
    expect(objectModelKey({ glyph: "satchel" })).toBe("satchel");
    expect(objectModelKey({ iconRef: "🎒" })).toBe("satchel");
    expect(hasObjectModel(undefined, "satchel")).toBe(true);
    const spec = itemObjectSpec("satchel", "small:e6", AT);
    expect(spec.contains).toEqual([{ relation: "in", capacity: INSTANCE_SLOTS }]);
    expect(spec.glyph).toBe("satchel");
  });

  it("every portable container has a model, so none of them can be a question mark", () => {
    for (const glyph of Object.keys(PORTABLE_CONTAINERS)) {
      expect([glyph, hasObjectModel(undefined, glyph)]).toEqual([glyph, true]);
    }
  });

  it("and a chair is not", () => {
    expect(itemObjectSpec(furnitureGlyph("chair"), "small:e3", AT).contains).toBeUndefined();
    expect(itemObjectSpec("apple", "small:e4", AT).contains).toBeUndefined();
  });

  it("UNITS and INSTANCES are different numbers, deliberately", () => {
    // The slot is whole objects shown; the capacity is how much stuff fits.
    // A basket holding eight units of grain still shows a couple of props.
    const spec = itemObjectSpec("basket", "small:e5", AT);
    expect(spec.contains![0]!.capacity).toBe(INSTANCE_SLOTS);
    expect(containerDefOfGlyph("basket")!.capacity).not.toBe(INSTANCE_SLOTS);
  });
});
