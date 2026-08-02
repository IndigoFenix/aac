/**
 * ONE DEFINITION FOR ONE ITEM (user law, 2026-08-02):
 *   "sometimes an apple appears as a 3D model, and other times as an icon.
 *    Again, suggesting that the same item has multiple definitions when it
 *    shouldn't… There should really only be one rendering method for furniture
 *    items, the 3D model on its side, because it's always the same object."
 *
 * Six call sites used to build an ObjectSpec for the same item and disagree
 * about the radius (0.28 / 0.3 / 0.35 / 0.6), the glyph normalization and the
 * affordances. These tests pin the single answer, and pin the recipe-keyed
 * identity the renderer uses to notice an object has become a different KIND of
 * thing under a live id.
 */
import { itemObjectSpec, LOOSE_ITEM_R } from "@shared/world-engine/interaction/content/item-prop.js";
import { objectModelKey, hasObjectModel } from "@shared/world-engine/object-models.js";
import {
  FURNITURE_ITEMS,
  furnitureGlyph,
  furnitureItemOf,
  type StationKind,
} from "@shared/world-engine/kernel/town/stations.js";

const AT = { x: 3, y: -4 };

/** Every kind the simulation can raise — the StationKind union, written out, so
 *  a kind added without geometry fails here rather than in the dollhouse. */
const STATION_KINDS: readonly StationKind[] = [
  "chest", "cupboard", "table", "bed", "chair", "box", "barrel", "bath", "toilet",
  "bin", "bowl", "oven", "workbench", "refrigerator", "anvil", "altar", "loom",
  "shelf", "stonecutter", "door",
];

describe("itemObjectSpec — the one appearance of a thing that is not installed", () => {
  it("a piece of furniture is its OWN MODEL, on its side, at its real size", () => {
    const spec = itemObjectSpec(furnitureGlyph("chest"), "small:e1", AT);
    expect(spec.fixture).toBe("chest");
    expect(spec.radius).toBe(furnitureItemOf("chest")!.radius);
    // On its side — the pose the renderer already has for furniture out of place.
    expect(spec.setUp).toBe(false);
    // NOT SOLID: it is on the floor precisely because it was in the way.
    expect(spec.solid).toBe(false);
    expect(spec.x).toBe(AT.x);
    expect(spec.y).toBe(AT.y);
  });

  it("THE CARRIED CHEST AND THE STANDING CHEST ARE THE SAME CHEST — one recipe", () => {
    const loose = itemObjectSpec(furnitureGlyph("chest"), "small:e1", AT);
    // What a standing fixture resolves to (town-stage builds `fixture: kind`).
    expect(objectModelKey({ fixture: loose.fixture! })).toBe("fixture:chest");
    expect(objectModelKey({ fixture: "chest" })).toBe(objectModelKey({ fixture: loose.fixture! }));
  });

  it("EVERY station kind resolves to a model, never a question mark", () => {
    // The reported defect: "some furniture models become question mark icons
    // when on the ground (refrigerator and oven), while others don't (barrel
    // and wardrobe)". The oven and the fridge were absent from FURNITURE_ITEMS
    // — the CRAFTABLE catalogue, read as though it were the definition of
    // furniture — so a deconstructed one fell through to the glyph branch as a
    // bare `furn.oven`, which the artwork registry has never heard of. You can
    // make a barrel and a cupboard, which is the whole reason those two worked.
    // Every kind the sim can raise is checked, so a new one cannot repeat it.
    for (const kind of STATION_KINDS) {
      const spec = itemObjectSpec(furnitureGlyph(kind), `small:${kind}`, AT);
      expect([kind, spec.fixture]).toEqual([kind, kind]);
      expect([kind, spec.glyph]).toEqual([kind, undefined]); // never a floating symbol
      expect([kind, objectModelKey({ fixture: kind })]).toEqual([kind, `fixture:${kind}`]);
    }
  });

  it("a piece you cannot MAKE is still a piece you can carry and place", () => {
    // The oven's other half: handlePlaceOrder looks the kind up in
    // FURNITURE_ITEMS and refuses what it cannot find, so an ordered oven had
    // an outline standing on the floor that nobody ever came to fill.
    for (const kind of ["oven", "refrigerator", "bath", "anvil"] as const) {
      const def = furnitureItemOf(kind);
      expect([kind, !!def]).toEqual([kind, true]);
      expect([kind, def!.craft]).toEqual([kind, undefined]); // …but not at a bench
    }
  });

  it("the craftable catalogue is still exactly the craftable ones", () => {
    // The split must not hand the automated crafter a stone bench to churn out.
    const craftable = FURNITURE_ITEMS.filter((f) => f.craft).map((f) => f.kind).sort();
    expect(craftable).toEqual(
      ["barrel", "bed", "bin", "box", "chair", "chest", "cupboard", "door", "table", "workbench"].sort(),
    );
  });

  it("an apple keeps its icon, at ONE radius wherever it is", () => {
    const onATable = itemObjectSpec("apple", "small:a", AT, { carry: false });
    const inAHand = itemObjectSpec("apple", "needprop:resident_0_0", AT);
    const onTheFloor = itemObjectSpec("apple", "small:b", AT);
    for (const s of [onATable, inAHand, onTheFloor]) {
      expect(s.shape).toBe("sphere");
      expect(s.radius).toBe(LOOSE_ITEM_R);
      expect(s.glyph).toBe("apple");
      expect(s.fixture).toBeUndefined();
    }
  });

  it("the only thing a MIRROR prop differs by is that hands can't take it", () => {
    const mirror = itemObjectSpec("apple", "small:a", AT, { carry: false });
    const real = itemObjectSpec("apple", "small:a", AT);
    expect(mirror.interactions).toEqual([]);
    expect(real.interactions).toEqual(["carry"]);
    // Everything else identical — lifting a unit off a table must not change
    // what the unit looks like.
    expect({ ...mirror, interactions: null }).toEqual({ ...real, interactions: null });
  });

  it("a faceted item keeps its facets (a red shirt stays red)", () => {
    expect(itemObjectSpec("shirt.color_red", "small:s", AT).glyph).toBe("shirt.color_red");
  });
});

describe("objectModelKey — the renderer's identity", () => {
  it("DESCRIPTORS ARE NOT AN IDENTITY: a hot apple is the same recipe as a cold one", () => {
    // Or every steam/colour change would churn geometry and materials.
    expect(objectModelKey({ glyph: "apple.hot" })).toBe(objectModelKey({ glyph: "apple.cold" }));
  });

  it("BECOMING FURNITURE IS an identity change", () => {
    expect(objectModelKey({ glyph: "apple" })).not.toBe(objectModelKey({ fixture: "chest" }));
  });

  it("agrees with hasObjectModel about what has a recipe", () => {
    for (const g of ["apple", "shirt", "ball", furnitureGlyph("chair"), "zzz_no_such_thing"]) {
      expect(objectModelKey({ glyph: g }) !== undefined).toBe(hasObjectModel(undefined, g));
    }
  });

  it("a fixture always wins — a chest is a chest whatever icon rides along", () => {
    expect(objectModelKey({ fixture: "chest", iconRef: "🍎", glyph: "apple" })).toBe("fixture:chest");
  });
});
