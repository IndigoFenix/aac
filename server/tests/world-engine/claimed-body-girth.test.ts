// A CLAIMED BODY MOVES AT ITS OWN GIRTH.
//
// When a spark claims a creature, `WorldState.drivenId` becomes that creature's
// body id and `tickWorld` steers it. The body must collide, wall-slide and
// manifold-clamp at the CLAIMED creature's radius (speciesBodyRadius) — not the
// spark's 0.4 default. runWorldHost feeds tickWorld the driven body's own config
// (npcConfigs.get(driven())); this pins that a broad-bodied claimed creature
// stops a broad body's distance from a fixture, where a 0.4 body would tuck in
// 0.15 m closer.
//
// Companion: the SPAWN girth-check (quest-host girthSafeSpawn) leans on
// nearestClearSpot — a body placed on a fixture is nudged to a standable spot at
// its OWN radius. The second describe pins that contract directly.

import { describe, it, expect } from "@jest/globals";
import { runWorldHost } from "@shared/world-engine/world-host.js";
import type { WorldView } from "@shared/world-engine/world-view.js";
import { createWorldState, expandWorldBuildings } from "@shared/world-engine/engine.js";
import { nearestClearSpot, standClear } from "@shared/world-engine/interaction/quest/stand-points.js";
import { registerSpecies, speciesBodyRadius, DEFAULT_BODY_RADIUS_M } from "@shared/world-engine/creatures/species.js";
import type { NpcSpec, ObjectSpec, WorldSpec } from "@shared/world-engine/types.js";

const BIG = "test_ogre";
const BIG_R = 0.6;
registerSpecies({ id: BIG, name: "Test ogre", kind: "creature", blueprint: {}, bodyRadiusM: BIG_R });

function mockView(): WorldView {
  return { screenToWorld: (px, py) => ({ x: px, y: py }), render: () => {}, resize: () => {}, dispose: () => {} };
}

// A solid table at (15,15); the driven body approaches it from +x along y=15.
const table: ObjectSpec = { id: "table", x: 15, y: 15, shape: "box", radius: 1.2, fixture: "table", interactions: [] };
const big: NpcSpec = { id: "npc_big", x: 20, y: 15, species: BIG, behavior: { movement: "wander", wanderRadius: 1, home: { x: 20, y: 15 }, conversationRadius: 3 } };
const spec: WorldSpec = {
  engine: "world", engineVersion: 1, meta: { title: "t", locale: "en", theme: "t" },
  manifold: { kind: "flat", width: 40, height: 40 }, terrain: { kind: "flat" },
  spawns: [{ id: "s", x: 5, y: 15, facing: 0 }],
  objects: [table], npcs: [big],
  multiplayer: { maxPlayers: 4, authority: "distributed" }, content: { kind: "sandbox" },
};

describe("a claimed body collides at its own girth", () => {
  it("a claimed ogre stops an ogre-body's distance from the table, not a 0.4 body's", () => {
    let frameCb: ((now: number) => void) | null = null;
    let now = 0;
    const host = runWorldHost({
      view: mockView(), spec, localId: "me", spawnIndex: 0, hostNpcs: true,
      scheduleFrame: (cb) => { frameCb = cb; return () => {}; },
      now: () => now,
    });
    host.start();
    expect(host.claimBody("npc_big")).toBe(true);
    expect(host.drivenBody()).toBe("npc_big");

    // Drive the claimed body straight into the table's west face (aim at centre).
    let minX = Infinity;
    for (let i = 0; i < 240; i++) {
      host.setPointer(15, 15);
      now += 40;
      frameCb?.(now);
      const b = host.state.avatars.npc_big;
      if (b) minX = Math.min(minX, b.x);
    }
    host.stop();

    // The box blocks a body of radius R from entering |dx| ≤ 1.2 + R, so the
    // ogre's centre stops at x ≈ 15 + 1.2 + 0.6 = 16.8. A 0.4 body would tuck to
    // 16.6 — the discriminator is minX > 16.7, which only the ogre girth clears.
    expect(minX).toBeGreaterThan(16.7);
    // …and it genuinely approached (started at x=20), so this isn't a body that
    // simply never moved.
    expect(minX).toBeLessThan(17.4);
    // The exact stop tracks the ogre's radius within a step's tolerance.
    expect(minX).toBeCloseTo(15 + 1.2 + BIG_R, 1);
  });
});

describe("the spawn girth-check contract (girthSafeSpawn → nearestClearSpot)", () => {
  it("a body placed ON a fixture is nudged to a spot standable at its OWN radius", () => {
    const spawnSpec: WorldSpec = {
      engine: "world", engineVersion: 1, meta: { title: "t", locale: "en", theme: "t" },
      manifold: { kind: "flat", width: 40, height: 40 }, terrain: { kind: "flat" },
      spawns: [{ id: "s", x: 5, y: 15 }], objects: [table],
      multiplayer: { maxPlayers: 4, authority: "distributed" }, content: { kind: "sandbox" },
    };
    const s = createWorldState(expandWorldBuildings(spawnSpec), "me");
    const onTable = { x: table.x, y: table.y }; // the eat-at-table / fixed-offset case

    for (const bodyR of [DEFAULT_BODY_RADIUS_M, BIG_R]) {
      // Placed inside the fixture, it is NOT standable at that radius…
      expect(standClear(s, onTable, bodyR)).toBe(false);
      // …so the girth check nudges it to a spot that IS.
      const spot = nearestClearSpot(s, onTable, { x: 5, y: 15 }, bodyR);
      expect(standClear(s, spot, bodyR)).toBe(true);
    }
    // The resolver honours the species table: ogre reads its authored 0.6.
    expect(speciesBodyRadius(BIG)).toBe(BIG_R);
  });
});
