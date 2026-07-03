// Unit tests for the procedural world-object model library
// (shared/world-engine/object-models.ts). Pure geometry construction — THREE's
// core builds Groups/geometries/materials with no DOM (only WebGLRenderer needs
// GL), so this is safe headless in `npm test`.
//
// Covers IDENTITY → model resolution, the FAILSAFE (unknown → null so the
// renderer falls back to box/sphere + icon), and DESCRIPTOR application
// (color/size/temperature parsed off the composed glyph).

import { describe, it, expect } from "@jest/globals";
import * as THREE from "three";
import {
  buildObjectModel,
  hasObjectModel,
  parseDescriptors,
  type ObjectModel,
} from "@shared/world-engine/object-models.js";

function countMeshes(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) n++;
  });
  return n;
}

describe("object-models identity resolution", () => {
  it("recognizes shipped pool emojis", () => {
    for (const emoji of ["⚽", "🍎", "🍌", "🍪", "🚗", "🚂", "🧸", "📦", "🧺", "⛵"]) {
      expect(hasObjectModel(emoji)).toBe(true);
    }
  });

  it("resolves by composed-glyph head when the emoji is unknown", () => {
    expect(hasObjectModel("🦄", "ball.big")).toBe(true);
    expect(hasObjectModel(undefined, "apple.cold")).toBe(true);
  });

  it("normalizes variation selectors and skin tones before matching", () => {
    expect(hasObjectModel("⛵️")).toBe(true);
    expect(hasObjectModel("⚽️")).toBe(true);
  });

  it("returns false (→ renderer failsafe) for unmodeled objects", () => {
    expect(hasObjectModel("🦄")).toBe(false);
    expect(hasObjectModel("🐰")).toBe(false);
    expect(hasObjectModel(undefined, undefined)).toBe(false);
    expect(hasObjectModel("🦄", "unicorn")).toBe(false);
  });
});

describe("parseDescriptors", () => {
  it("reads size modifiers as an exaggerated scale", () => {
    expect(parseDescriptors("ball.big").scale).toEqual([1.7, 1.7, 1.7]);
    expect(parseDescriptors("ball.small").scale).toEqual([0.5, 0.5, 0.5]);
    expect(parseDescriptors("ball").scale).toEqual([1, 1, 1]);
  });

  it("reads color + temperature modifiers", () => {
    expect(parseDescriptors("ball.color_red").colorHex).toBe("#DC2626");
    expect(parseDescriptors("apple.hot").temperature).toBe("hot");
    expect(parseDescriptors("apple.cold").temperature).toBe("cold");
  });

  it("composes multiple descriptors on one glyph", () => {
    const d = parseDescriptors("apple.big.hot.color_green");
    expect(d.scale).toEqual([1.7, 1.7, 1.7]);
    expect(d.temperature).toBe("hot");
    expect(d.colorHex).toBe("#16A34A");
  });

  it("ignores unknown modifiers", () => {
    const d = parseDescriptors("ball.wobbly.big");
    expect(d.scale).toEqual([1.7, 1.7, 1.7]);
    expect(d.colorHex).toBeUndefined();
  });
});

describe("buildObjectModel", () => {
  it("returns null for an unknown object so the caller can fall back", () => {
    expect(buildObjectModel({ iconRef: "🦄", radius: 0.5 })).toBeNull();
    expect(buildObjectModel({ radius: 0.5 })).toBeNull();
  });

  it("builds a multi-part model with standard materials", () => {
    const model = buildObjectModel({ iconRef: "🚗", radius: 0.45 })!;
    expect(model.object).toBeInstanceOf(THREE.Object3D);
    expect(countMeshes(model.object)).toBeGreaterThan(1); // body + cabin + wheels…
    expect(model.materials.length).toBeGreaterThan(0);
    for (const m of model.materials) expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
  });

  it("keeps the model within the object's vertical footprint (base at -radius)", () => {
    const r = 0.5;
    const model = buildObjectModel({ iconRef: "🍎", radius: r })!;
    const box = new THREE.Box3().setFromObject(model.object);
    expect(box.min.y).toBeGreaterThanOrEqual(-r * 1.05);
    expect(box.min.y).toBeLessThanOrEqual(-r * 0.6);
    expect(box.max.y).toBeLessThan(r * 2.2);
  });

  it("scales for a size descriptor while keeping the base on the ground", () => {
    const r = 0.5;
    const plain = new THREE.Box3().setFromObject(buildObjectModel({ iconRef: "⚽", radius: r })!.object);
    const model = buildObjectModel({ iconRef: "⚽", glyph: "ball.big", radius: r })!;
    const big = new THREE.Box3().setFromObject(model.object);
    // Grew taller…
    expect(big.max.y - big.min.y).toBeGreaterThan((plain.max.y - plain.min.y) * 1.4);
    // …but its base stays at ~ -r (rests on the ground, doesn't sink or float).
    expect(big.min.y).toBeCloseTo(-r, 1);
  });

  it("tints the body for a color descriptor and restores it when cleared", () => {
    const model = buildObjectModel({ iconRef: "⚽", radius: 0.5 })!;
    const body = model.materials[0]!; // ball body is the first material
    const original = body.color.getHex();
    model.applyDescriptors("ball.color_red");
    expect(body.color.getHex()).toBe(new THREE.Color("#DC2626").getHex());
    model.applyDescriptors("ball"); // descriptor removed
    expect(body.color.getHex()).toBe(original);
  });

  it("adds a particle effect for hot/cold and removes it on change", () => {
    const model = buildObjectModel({ iconRef: "🍎", radius: 0.5 })!;
    const hasPoints = () => {
      let found = false;
      model.object.traverse((o) => {
        if (o instanceof THREE.Points) found = true;
      });
      return found;
    };
    expect(hasPoints()).toBe(false);
    model.applyDescriptors("apple.hot");
    expect(hasPoints()).toBe(true);
    expect(() => model.update(1.5)).not.toThrow(); // animates without a DOM
    model.applyDescriptors("apple"); // temperature cleared
    expect(hasPoints()).toBe(false);
  });

  it("disposes cleanly (including active particles)", () => {
    const model: ObjectModel = buildObjectModel({ iconRef: "🧺", glyph: "basket.cold", radius: 1.0 })!;
    expect(() => model.dispose()).not.toThrow();
  });
});
