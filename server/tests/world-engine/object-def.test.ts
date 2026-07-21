/**
 * The recursive ObjectDef grammar (object-def.ts): validation, the
 * contained-node boundary relaxation (vacuum-vs-context), and lowering a tree
 * to the runnable aivota-world envelope. Sub-entity-first, unified `body` kind.
 */
import { describe, it, expect } from "@jest/globals";
import {
  parseObjectDef,
  lowerObjectDef,
  OBJECT_KINDS,
} from "@shared/world-engine/object-def.js";
import { loadWorldManifest } from "@shared/world-engine/kernel/manifest.js";

describe("parseObjectDef — the recursive grammar", () => {
  it("rejects unknown kinds, unknown fields, and illegal children", () => {
    expect(() => parseObjectDef({ kind: "dragon" })).toThrow(/unknown kind "dragon"/);
    expect(() => parseObjectDef({ kind: "town", params: { seed: 1 }, wat: 1 })).toThrow(/object\.wat: unknown field/);
    // a galaxy contains solar systems, not creatures.
    expect(() => parseObjectDef({ kind: "galaxy", contains: [{ kind: "creature" }] }))
      .toThrow(/"creature" is not allowed here/);
    // the sub-entity ladder: solar_system → body → region → town → structure.
    expect(() => parseObjectDef({ kind: "solar_system", contains: [{ kind: "town" }] }))
      .toThrow(/"town" is not allowed here/);
  });

  it("validates params against the kind's descriptor", () => {
    expect(() => parseObjectDef({ kind: "town", params: {} })).toThrow(/object\.params\.seed: required/);
    expect(() => parseObjectDef({ kind: "town", params: { seed: 7, syntax: "z" } }))
      .toThrow(/object\.params\.syntax: must be one of/);
    const ok = parseObjectDef({ kind: "town", params: { seed: 7 } });
    expect(ok.params).toEqual({ seed: 7 });
  });

  it("allows at most one focus across the tree", () => {
    expect(() => parseObjectDef({
      kind: "town", params: { seed: 1 }, focus: true,
      contains: [{ kind: "structure", focus: true }],
    })).toThrow(/only one node may be the focus/);
  });

  it("relaxes required BOUNDARY fields for a contained node (the vacuum law)", () => {
    // A root town REQUIRES its seed (built in a vacuum)…
    expect(() => parseObjectDef({ kind: "town", params: {} })).toThrow(/params\.seed: required/);
    // …but a town CONTAINED in a region inherits its seed from the site, so the
    // same node needs no seed.
    const nested = parseObjectDef({ kind: "region", contains: [{ kind: "town", focus: true }] });
    expect(nested.contains?.[0].kind).toBe("town");
    expect(nested.contains?.[0].params).toEqual({});
  });

  it("a body is one kind — it takes orbital, stellar AND surface params", () => {
    const b = parseObjectDef({ kind: "body", params: { orbitAU: 1, mass: 1, radius: 3000 } });
    expect(b.params).toMatchObject({ orbitAU: 1, mass: 1, radius: 3000 });
    // bodies orbit bodies (moons) and hold regions.
    const sys = parseObjectDef({ kind: "solar_system", params: { seed: 1 }, contains: [
      { kind: "body", params: { mass: 3e5 }, contains: [{ kind: "body", params: { orbitAU: 1 } }] },
    ] });
    expect(sys.contains?.[0].contains?.[0].kind).toBe("body");
  });
});

describe("lowerObjectDef — tree → aivota-world document", () => {
  it("lowers a body root to the planet scope, stripping orbital/stellar params", () => {
    const doc = lowerObjectDef(parseObjectDef({ kind: "body", params: { orbitAU: 1.5, mass: 1, radius: 3000 } }));
    const game = doc.game as Record<string, unknown>;
    expect(game.scope).toBe("planet");
    expect(game.world).toMatchObject({ radius: 3000 });
    expect(game.world).not.toHaveProperty("orbitAU"); // stripped — planet scope can't model it
    expect(game.world).not.toHaveProperty("mass");
  });

  it("lowers the town → structure → creature/item dollhouse to focus + entities", () => {
    const tree = parseObjectDef({
      kind: "town",
      params: { seed: 7, days: 220, questCount: 2, syntax: "b", locale: "en" },
      contains: [{
        kind: "structure", focus: true, exhaustive: ["creature"],
        contains: [
          { kind: "creature", params: { name: "Mara", outfit: 4, likes: ["apple"] } },
          { kind: "creature", params: { name: "Orrin", outfit: 1, likes: ["banana"] } },
          { kind: "item", params: { glyph: "teddy", at: "box" } },
        ],
      }],
    });
    const doc = lowerObjectDef(tree);
    const game = doc.game as Record<string, any>;
    expect(game.scope).toBe("town");
    expect(game.world).toMatchObject({ seed: 7, syntax: "b" });
    expect(game.initial_focus).toEqual({ type: "house" });
    expect(game.entities.creatures.mode).toBe("all"); // replace: true
    expect(game.entities.creatures.list).toHaveLength(2);
    expect(game.entities.creatures.list[0]).toEqual({ name: "Mara", outfit: 4, likes: ["apple"] });
    expect(game.entities.objects.mode).toBe("some");
    expect(game.entities.objects.list[0]).toEqual({ glyph: "teddy", at: "box" });

    // The lowered document is accepted by the real engine gate.
    const loaded = loadWorldManifest(doc, []);
    expect(loaded.game?.scope).toBe("town");
    expect(loaded.game?.initialFocus).toEqual({ type: "house" });
  });

  it("defaults a household to mode 'some' when the creature group is not exhaustive", () => {
    const doc = lowerObjectDef(parseObjectDef({
      kind: "town", params: { seed: 1 },
      contains: [{ kind: "structure", focus: true, contains: [{ kind: "creature", params: { name: "Ana" } }] }],
    }));
    expect((doc.game as any).entities.creatures.mode).toBe("some");
  });
});

describe("OBJECT_KINDS registry — sub-entity-first, unified body", () => {
  it("carries the ladder kinds plus creature/item", () => {
    for (const k of ["galaxy", "solar_system", "body", "region", "town", "structure", "creature", "item"]) {
      expect(OBJECT_KINDS[k]?.kind).toBe(k);
    }
    expect(OBJECT_KINDS.body.scope).toBe("planet");   // a body lowers to the planet scope
    expect(OBJECT_KINDS.town.scope).toBe("town");
    expect(OBJECT_KINDS.creature.scope).toBeUndefined();
    expect(OBJECT_KINDS.planet).toBeUndefined();      // "planet" folded into "body"
  });

  it("solar_system params drop the star (it is a body child now)", () => {
    expect(OBJECT_KINDS.solar_system.paramFields.fields.some((f) => f.key === "star")).toBe(false);
    expect(OBJECT_KINDS.solar_system.childKinds).toContain("body");
  });
});
