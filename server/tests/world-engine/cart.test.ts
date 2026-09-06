/**
 * THE CART — the third portable container, and the first bag anybody can MAKE.
 *
 * User ruling, 2026-09-05: *"there is no path to creating baskets. I'm thinking
 * that carts would be a good addition as a basic object — more associated with
 * carrying large numbers of heavy objects, were one of the earliest
 * technologies, can be made from wood and are still in use today. They can be
 * made from blocks."*
 *
 * Four things had to be true at once for that to be more than a word, and each
 * one of them is a way this could ship broken and LOOK fine:
 *
 *  ① THE ROW. A cart is one row of `PORTABLE_CONTAINERS` and nothing else —
 *     every capacity hook in the game already reads that table.
 *  ② THE CEILING MUST NOT MOVE (⚖️ C3). `haulTripUnits()` is a GLOBAL max read
 *     by the poster of every pile-haul row, in every world, long before anybody
 *     claims it. A cart is `seeded: false` — it exists only where somebody made
 *     one — so a naive max would cut every posted row at 24 and hand a basket
 *     porter a 24-unit agreement it delivers 8 of: the "bring 24 wood —
 *     delivered" lie #50 fixed, restored by a one-row edit. The ceiling reads
 *     SEEDED rows only and stays 8.
 *  ③ THE MAKE PATH. `make cart` must reach the bag, not a toy of one. Family
 *     order in `makeableGlyph` puts toys and dolls FIRST, so a cart filed in
 *     the `vehicle` pool (affordance `startable-movable`, which feeds
 *     `depictableHeads()`) would silently produce `cart.toy` and nobody would
 *     see it until a child got a doll.
 *  ④ THE WORD AND THE BODY. A portable row with no 3-D recipe renders as a
 *     floating emoji, and a spec word with no lexeme puts the English head on a
 *     Hebrew board (`baseWord` falls back to the raw head, silently).
 *
 * PURE: no session boot, no DOM, no GL.
 */
import { describe, it, expect } from "@jest/globals";
import {
  containerDefOfGlyph,
  haulTripUnits,
  isPortableContainer,
  isWornContainer,
  portableCraftOf,
  CART_HALF_EXTENT_M,
  PORTABLE_CONTAINERS,
} from "@shared/world-engine/kernel/town/containers.js";
import {
  craftRecipeOf,
  depictableHeads,
  isMakeable,
  makeableGlyph,
} from "@shared/world-engine/interaction/content/makeable.js";
import { itemObjectSpec } from "@shared/world-engine/interaction/content/item-prop.js";
import { hasObjectModel, objectModelKey } from "@shared/world-engine/object-models.js";
import { blockCosts, furnitureBlocks } from "@shared/world-engine/kernel/town/block-bill.js";
import { POOLS } from "@shared/world-engine/interaction/content/pools.js";
import { en, he, es, pt, glyphLabel } from "@shared/world-engine/interaction/lang/index.js";

/** The four SHIPPED rulesets. The other seven app locales have no ruleset and
 *  fall back to English wholesale, by design (lang/index.ts). */
const LANGS = [en, he, es, pt] as const;

describe("① the cart is a row of the portable-container table", () => {
  it("holds 24 units, in your hands, and is not something the world stocks", () => {
    const cart = PORTABLE_CONTAINERS.cart!;
    expect({
      capacity: cart.capacity,
      relation: cart.relation,
      hold: cart.hold,
      seeded: cart.seeded,
    }).toEqual({ capacity: 24, relation: "in", hold: "carry", seeded: false });
  });

  it("three times a basket — the user's 'large numbers of heavy objects'", () => {
    expect(PORTABLE_CONTAINERS.cart!.capacity).toBe(PORTABLE_CONTAINERS.basket!.capacity * 3);
  });

  it("and it divides the frontier cottage's 120-block bill exactly (5 loads)", () => {
    expect(120 % PORTABLE_CONTAINERS.cart!.capacity).toBe(0);
  });

  it("a cart COSTS YOU A HAND, exactly as a basket does — it is not worn", () => {
    expect(isPortableContainer("cart")).toBe(true);
    expect(isWornContainer("cart")).toBe(false);
    expect(containerDefOfGlyph("cart")!.hold).toBe("carry");
  });

  it("reads a faceted glyph by its head — a red cart is still a cart", () => {
    expect(containerDefOfGlyph("cart.color_red")?.capacity).toBe(24);
  });

  it("the basket and the satchel ARE seeded, which is what makes them assumable", () => {
    // `container-seeds.ts` lays one in every house, the market and the yard.
    expect(PORTABLE_CONTAINERS.basket!.seeded).toBe(true);
    expect(PORTABLE_CONTAINERS.satchel!.seeded).toBe(true);
  });

  it("every portable row still declares a hold mode, a capacity AND its seeding", () => {
    for (const [glyph, def] of Object.entries(PORTABLE_CONTAINERS)) {
      expect([glyph, !!def.hold, def.capacity > 0, typeof def.seeded]).toEqual([
        glyph,
        true,
        true,
        "boolean",
      ]);
    }
  });
});

describe("🚨 ② the haul ceiling is NEVER sized to a bag the world may not have", () => {
  it("haulTripUnits() is STILL 8 with a 24-unit cart in the table", () => {
    // The whole point of `seeded`. If this ever reads 24, every pile-haul row
    // in every world is over-promised and #50's delivery lie is back.
    expect(haulTripUnits()).toBe(8);
  });

  it("it is the max over SEEDED rows, derived — not a literal 8", () => {
    const seededMax = Math.max(
      1,
      ...Object.values(PORTABLE_CONTAINERS)
        .filter((d) => d.seeded)
        .map((d) => d.capacity),
    );
    expect(haulTripUnits()).toBe(seededMax);
  });

  it("the biggest bag in the table is BIGGER than the ceiling — deliberately", () => {
    const anyMax = Math.max(...Object.values(PORTABLE_CONTAINERS).map((d) => d.capacity));
    expect(anyMax).toBeGreaterThan(haulTripUnits());
  });
});

describe("③ 'make cart' produces a cart", () => {
  it("makeableGlyph('cart') is the bag itself", () => {
    expect(makeableGlyph("cart")).toBe("cart");
    expect(isMakeable("cart")).toBe(true);
  });

  it("🚨 and NOT `cart.toy` — the silent failure a vehicle-pool filing would cause", () => {
    expect(makeableGlyph("cart")).not.toBe("cart.toy");
    expect(makeableGlyph("cart")!.includes(".toy")).toBe(false);
    // The cause, pinned at its root: a cart is not depictable, because it lives
    // in the `container` pool (`openable`) and not the `vehicle` pool
    // (`startable-movable`, which `depictableHeads()` reads).
    expect(depictableHeads()).not.toContain("cart");
    const vehicle = POOLS.vehicle;
    expect((vehicle?.members ?? []).map((m) => m.symbol)).not.toContain("cart");
    expect((POOLS.container?.members ?? []).map((m) => m.symbol)).toContain("cart");
  });

  it("the recipe is 4 blocks at a workbench, produced as the cart", () => {
    expect(craftRecipeOf("cart")).toEqual({
      produces: "cart",
      consumes: { block: 4 },
      at: "workbench",
      label: "cart",
    });
  });

  it("the bill is DERIVED from the cart's own size, never painted on", () => {
    // The same rule furniture is billed by, one scale down: a bigger cart would
    // cost more without anybody guessing a number for it.
    expect(portableCraftOf("cart")!.consumes).toEqual(
      blockCosts(furnitureBlocks(CART_HALF_EXTENT_M)),
    );
  });

  it("an ORDER's facets survive the recipe — a red cart is what gets made", () => {
    expect(craftRecipeOf("cart.color_red")?.produces).toBe("cart.color_red");
  });

  it("🧺 the BASKET still has no recipe — it is woven, not carpentered", () => {
    // The user's complaint is answered by the cart, not by inventing a weaver.
    // `frontier-conservation.test.ts` reads the same fact from the other side.
    expect(makeableGlyph("basket")).toBeNull();
    expect(craftRecipeOf("basket")).toBeNull();
    expect(portableCraftOf("basket")).toBeNull();
    expect(makeableGlyph("satchel")).toBeNull();
  });

  it("`at` is the station that SPEEDS the work, and the only one named", () => {
    expect(craftRecipeOf("cart")?.at).toBe("workbench");
  });
});

describe("④ a cart is a real object and a real word", () => {
  it("every portable container has a model, so none of them is a question mark", () => {
    for (const glyph of Object.keys(PORTABLE_CONTAINERS)) {
      expect([glyph, hasObjectModel(undefined, glyph)]).toEqual([glyph, true]);
    }
  });

  it("the cart renders as ITSELF from either the glyph or the stand-in emoji", () => {
    expect(objectModelKey({ glyph: "cart" })).toBe("cart");
    expect(objectModelKey({ iconRef: "🛒" })).toBe("cart");
  });

  it("a cart on the floor is a place things can go, and can be picked up", () => {
    const spec = itemObjectSpec("cart", "small:cart1", { x: 0, y: 0 });
    expect(spec.contains).toEqual([{ relation: "in", capacity: 2 }]);
    expect(spec.interactions).toEqual(["carry"]);
    expect(spec.glyph).toBe("cart");
  });

  it("🚨 all four shipped rulesets can SAY it (baseWord's fallback is English)", () => {
    for (const lang of LANGS) {
      expect([lang.id, !!lang.lexicon.cart]).toEqual([lang.id, true]);
    }
  });

  it("and no non-English ruleset renders the raw English head", () => {
    const labels = Object.fromEntries(
      LANGS.map((lang) => [lang.id, glyphLabel("cart", lang.id)]),
    );
    expect(labels.en).toBe("cart");
    for (const id of ["he", "es", "pt"]) {
      expect([id, labels[id]]).not.toEqual([id, "cart"]);
      expect([id, (labels[id] ?? "").length > 0]).toEqual([id, true]);
    }
  });

  it("ONE word, no synonym: nothing else in the pools speaks 'cart'", () => {
    const carts = Object.values(POOLS).flatMap((p) =>
      p.members.filter((m) => m.symbol === "cart").map((m) => `${p.id}:${m.id}`),
    );
    expect(carts).toEqual(["container:cart"]);
  });
});
