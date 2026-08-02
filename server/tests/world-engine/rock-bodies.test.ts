// ROCK BODIES (construction phase 5 step ④). A wild mineral outcrop used to
// render as a WOODEN TREASURE CHEST: spawnWildFeature forced
// `fixture: "chest"` on every non-embodied feature, and a fixture
// short-circuits identity resolution in object-models, so the 🪨 icon never
// reached the model registry at all.
//
// The host itself (createQuestHost3D) needs a canvas, so what is pinned here
// is every PURE seam the fix stands on — the resolution law the spawner
// consults, the boulder the registry builds from it, and the quarry arithmetic
// the take path runs — plus a headless replay of the whole quarry loop.
//
// Geometry is safe headless: THREE's core builds Groups/geometries/materials
// with no DOM (only WebGLRenderer needs GL).

import { describe, it, expect } from "@jest/globals";
import * as THREE from "three";
import { buildObjectModel, hasObjectModel } from "@shared/world-engine/object-models.js";
import { createWorldState, fixturesWalkable } from "@shared/world-engine/engine.js";
import type { ObjectSpec, WorldSpec, WorldState } from "@shared/world-engine/types.js";
import {
  killStockOf,
  naturalSourceOf,
  sourceKillExhausted,
  takeUnitsOf,
} from "@shared/world-engine/products.js";
import {
  buildWilderness,
  wildFeatureEmbodied,
  wildFeatureRadius,
} from "@shared/world-engine/interaction/quest/wilderness.js";

const ROCK = naturalSourceOf("rock")!;

/** What `spawnWildFeature` passes the renderer for a feature: the source's
 *  icon and the first glyph of its stock. Kept here as ONE helper so the test
 *  asks exactly what the spawner asks — a test that guessed a different pair
 *  could pass while the world still drew a chest. */
const identityOf = (species: string): { iconRef: string; glyph: string | undefined } => {
  const src = naturalSourceOf(species);
  return {
    iconRef: src?.feature?.icon ?? "🌳",
    glyph: Object.keys(killStockOf(species, () => 0))[0],
  };
};

/** A stable fingerprint of a model's SHAPE: every mesh's local transform,
 *  rounded. Two boulders with the same fingerprint are the same boulder. */
function shapeSignature(root: THREE.Object3D): string {
  const parts: string[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const v = [
      o.position.x, o.position.y, o.position.z,
      o.rotation.x, o.rotation.y, o.rotation.z,
      o.scale.x, o.scale.y, o.scale.z,
    ];
    parts.push(v.map((n) => n.toFixed(4)).join(","));
  });
  return parts.join("|");
}

function countMeshes(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) n++;
  });
  return n;
}

describe("wild feature model resolution (the chest bug)", () => {
  it("a rock's own identity resolves to a model, so the spawner must not force a chest", () => {
    const { iconRef, glyph } = identityOf("rock");
    expect(iconRef).toBe("🪨");
    expect(glyph).toBe("stone");
    expect(hasObjectModel(iconRef, glyph)).toBe(true);
  });

  it("the rock source declares NO fixture — the model comes from the icon", () => {
    // The data half of the fix. A `fixture` here would short-circuit resolution
    // again and put the chest straight back.
    expect(ROCK.feature?.fixture).toBeUndefined();
  });

  it("an identity with no model still falls back to the chest", () => {
    // The oak's BOX presentation (what it wears if it ever loses its grown
    // body): a 🌳 with a `wood` stack matches no recipe, so the placeholder
    // container is the only thing that reads as "something openable here".
    const { iconRef, glyph } = identityOf("oak");
    expect(hasObjectModel(iconRef, glyph)).toBe(false);
    expect(buildObjectModel({ iconRef, glyph, fixture: "chest", radius: 0.7 })).not.toBeNull();
  });

  it("every non-embodied source in the registry resolves to a model or to the chest", () => {
    // The spawner's rule is total by construction; this is the registry-wide
    // proof that adding a source can never leave a feature undrawable.
    for (const src of [naturalSourceOf("rock")!, naturalSourceOf("oak")!]) {
      const { iconRef, glyph } = identityOf(src.species);
      const fixture = src.feature?.fixture ?? (hasObjectModel(iconRef, glyph) ? undefined : "chest");
      expect(buildObjectModel({ iconRef, glyph, fixture, radius: 0.5 })).not.toBeNull();
    }
  });
});

describe("the boulder", () => {
  const build = (id: string, radius = ROCK.feature!.radiusM) =>
    buildObjectModel({ ...identityOf("rock"), radius, id })!;

  it("builds a real multi-lump model, never the chest", () => {
    const rock = build("wild:rock_0");
    expect(rock).not.toBeNull();
    expect(countMeshes(rock.object)).toBeGreaterThan(3); // core + broken ground + shoulder
    // THE DISCRIMINATOR: a chest has a lid the container path drives open; a
    // rock has nothing that opens. If this ever gains a setOpen, the fixture
    // short-circuit is back.
    expect(rock.setOpen).toBeUndefined();
    expect(buildObjectModel({ ...identityOf("rock"), fixture: "chest", radius: 0.55 })!.setOpen)
      .toBeDefined();
  });

  it("is MATTE — no bright moving specular anywhere (seizure risk)", () => {
    const rock = build("wild:rock_0");
    expect(rock.materials.length).toBeGreaterThan(0);
    for (const m of rock.materials) {
      expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
      expect((m as THREE.MeshStandardMaterial).roughness).toBeGreaterThanOrEqual(0.9);
      expect((m as THREE.MeshStandardMaterial).metalness).toBe(0);
    }
  });

  it("is seeded by the object id — two rocks differ, one rock never changes", () => {
    expect(shapeSignature(build("wild:rock_0").object)).not.toBe(
      shapeSignature(build("wild:rock_1").object),
    );
    // Rebuilt (streamed back into view) it is the same rock, to the last facet.
    expect(shapeSignature(build("wild:rock_0").object)).toBe(
      shapeSignature(build("wild:rock_0").object),
    );
    // And it still builds for a caller that names no instance.
    expect(buildObjectModel({ ...identityOf("rock"), radius: 0.55 })).not.toBeNull();
  });

  it("follows feature.radiusM, and sits ON the ground it comes out of", () => {
    const small = new THREE.Box3().setFromObject(build("wild:rock_0", 0.3).object);
    const big = new THREE.Box3().setFromObject(build("wild:rock_0", 0.9).object);
    const width = (b: THREE.Box3) => b.max.x - b.min.x;
    expect(width(big) / width(small)).toBeCloseTo(3, 1);
  });

  it("every seeded boulder keeps the base-at--radius contract", () => {
    // Checked across many seeds, not one: the jitter is what could float a
    // rock over the ground or sink it through the floor, and only one lump in
    // one draw has to go wrong for that. A boulder is allowed to bite slightly
    // INTO the ground — an outcrop comes out of the earth, it is not set down
    // on it — but never to hover.
    const r = 0.55;
    for (let i = 0; i < 40; i++) {
      const box = new THREE.Box3().setFromObject(build(`wild:rock_${i}`, r).object);
      expect(box.min.y).toBeLessThanOrEqual(-r * 0.85);
      expect(box.min.y).toBeGreaterThanOrEqual(-r * 1.12);
      expect(box.max.y).toBeLessThan(r * 1.1); // wider than it is tall
      expect(box.max.x - box.min.x).toBeGreaterThan(r); // and it fills its footprint
    }
  });
});

describe("the quarry, end to end", () => {
  // A headless replay of the host's take loop: takeFromContainer draws units
  // (tool-multiplied) out of containerStock, fellIfConsumed resizes what is
  // left and removes the outcrop once the kill stock is gone.
  const quarry = (stock: Record<string, number>, tools: string[]) => {
    const has = (t: string) => tools.includes(t);
    const radii: number[] = [wildFeatureRadius("rock", stock)];
    let acts = 0;
    const pocket: Record<string, number> = {};
    while (!sourceKillExhausted(ROCK, stock)) {
      const units = takeUnitsOf(ROCK, "stone", has);
      for (let i = 0; i < units && (stock.stone ?? 0) > 0; i++) {
        stock.stone!--;
        pocket.stone = (pocket.stone ?? 0) + 1;
      }
      radii.push(wildFeatureRadius("rock", stock));
      if (++acts > 200) throw new Error("quarry never terminated");
    }
    return { acts, pocket, radii };
  };

  /** A FULL outcrop, as the catalogue declares it — never a literal. The
   *  shrink curve measures against the species' maximum roll, so a test that
   *  starts from a hand-written stock is testing a half-spent rock the moment
   *  the yields are rebalanced (phase 6 did exactly that). */
  const FULL = ROCK.products.find((p) => p.glyph === "stone")!.yield.max;

  it("yields stone, shrinks the outcrop, and terminates", () => {
    const q = quarry({ stone: FULL }, []);
    expect(q.pocket.stone).toBe(FULL); // what came out is what was in it
    expect(q.acts).toBe(FULL); // bare hands: one stone per act
    // Monotonically smaller, and visibly so by the end.
    for (let i = 1; i < q.radii.length; i++) expect(q.radii[i]!).toBeLessThan(q.radii[i - 1]!);
    expect(q.radii.at(-1)!).toBeLessThan(q.radii[0]! * 0.6);
  });

  it("a pick halves the acts (the registry-declared multiplier, applied)", () => {
    expect(quarry({ stone: FULL }, ["pick"]).acts).toBe(Math.ceil(FULL / 2));
    expect(quarry({ stone: FULL }, ["axe"]).acts).toBe(FULL); // wrong tool, no bonus
  });

  it("an outcrop worth ONE stone stands as a pebble from the start", () => {
    const one = wildFeatureRadius("rock", { stone: 1 });
    const two = wildFeatureRadius("rock", { stone: 2 });
    expect(one).toBeLessThan(two);
    // …and it is the same pebble a two-stone rock becomes after one act.
    const q = quarry({ stone: 2 }, []);
    expect(q.radii[1]).toBeCloseTo(one, 6);
  });

  it("a scattered rock is a BOX feature (never an embodied body) so it can be resized", () => {
    const w = buildWilderness({ seed: 21, trees: 0, rocks: 3, creatures: 0 });
    expect(w.features).toHaveLength(3);
    for (const f of w.features) {
      expect(wildFeatureEmbodied(f)).toBe(false);
      expect(wildFeatureRadius(f.species, f.stock)).toBeLessThanOrEqual(ROCK.feature!.radiusM);
      expect(wildFeatureRadius(f.species, f.stock)).toBeGreaterThan(0);
    }
  });
});

// ── SOLIDITY (the regression the model fix opened) ─────────────────────────
// Collision in this engine came ONLY from `fixture`, so the forced chest was
// silently doing two jobs: it drew the outcrop and it made it solid. Dropping
// it to draw a real boulder therefore let bodies walk straight THROUGH the
// rock — a worse lie than the chest ever told. `ObjectSpec.solid` states the
// fact outright, and these pin that stating it is additive: every spec that
// never mentions it keeps exactly the collision it had.
describe("object solidity is stated, not inferred from the model", () => {
  const world = (o: Partial<ObjectSpec> & { id: string }): WorldState =>
    createWorldState(
      {
        engine: "world", engineVersion: 1, meta: { title: "t", locale: "en", theme: "t" },
        manifold: { kind: "flat", width: 40, height: 40 }, terrain: { kind: "flat" },
        spawns: [{ id: "s", x: 1, y: 1 }],
        objects: [{ x: 5, y: 5, shape: "sphere", radius: 1, interactions: [], ...o }],
        multiplayer: { maxPlayers: 2, authority: "distributed" }, content: { kind: "sandbox" },
      } as WorldSpec,
      "me",
    );

  it("a modelled boulder blocks a body WITHOUT borrowing a furniture archetype", () => {
    const s = world({ id: "wild:rock_0", solid: true });
    expect(s.spec.objects[0]!.fixture).toBeUndefined();
    expect(fixturesWalkable(s, { x: 5, y: 5 }, 0.35)).toBe(false);
    expect(fixturesWalkable(s, { x: 15, y: 15 }, 0.35)).toBe(true);
  });

  it("absent `solid` keeps the historical fixture rule — both ways", () => {
    // A non-passthrough fixture still collides…
    expect(fixturesWalkable(world({ id: "c", fixture: "chest" }), { x: 5, y: 5 }, 0.35)).toBe(false);
    // …and a pass-through one still does not (bodies must stand on a chair).
    expect(fixturesWalkable(world({ id: "h", fixture: "chair" }), { x: 5, y: 5 }, 0.35)).toBe(true);
    // A plain prop with no fixture and no flag stays walk-through.
    expect(fixturesWalkable(world({ id: "p" }), { x: 5, y: 5 }, 0.35)).toBe(true);
  });

  it("an explicit `solid: false` overrides the archetype", () => {
    const s = world({ id: "ghost", fixture: "chest", solid: false });
    expect(fixturesWalkable(s, { x: 5, y: 5 }, 0.35)).toBe(true);
  });
});
