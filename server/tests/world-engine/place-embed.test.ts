// embedPuzzle (shared/place/embed): map a creature-quest STAR world onto a
// procedurally-generated house — helpers in role-appropriate rooms reached
// freely, the prize behind a locked door, one contiguous building — and prove
// the result is a VALID goal-tree layout (validateLayout2D) that raises into a
// valid world spec.
//
// Pure logic — no DB / LLM / GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import { buildCreatureQuestWorld } from "@shared/world-engine/interaction/quest/creature-quests.js";
import { certifyGoalTreeGame } from "@shared/world-engine/solver/index.js";
import { validateLayout2D } from "@shared/world-engine/solver/projector2d.js";
import { embedLayoutInWorld } from "@shared/world-engine/solver/space3d.js";
import { expandWorldBuildings } from "@shared/world-engine/engine.js";
import { validateWorldSpec } from "@shared/world-engine/schema.js";
import { generateHouse } from "@shared/world-engine/place/house.js";
import { embedPuzzle } from "@shared/world-engine/place/embed.js";

function embedded(seed: number, questCount = 3) {
  const game = buildCreatureQuestWorld({ seed, questCount, complexity: "simple" });
  const cert = certifyGoalTreeGame(game);
  if (!cert.ok) throw new Error(`certification failed: ${cert.errors.join("; ")}`);
  const roomsNeeded = cert.world.zones.length - 1;
  const house = generateHouse(roomsNeeded, seed);
  const emb = embedPuzzle(game, cert.world, house, seed);
  if (!emb) throw new Error("embedPuzzle returned null");
  return { game, world: cert.world, house, emb };
}

describe("embedPuzzle — a puzzle housed in a procedural place", () => {
  it("produces a layout that PASSES goal-tree validation on the transformed world", () => {
    const { game, emb } = embedded(7);
    expect(validateLayout2D(game, emb.world, emb.layout)).toEqual([]);
  });

  it("houses every puzzle zone in a distinct room, entrance = the living room", () => {
    const { world, emb } = embedded(7);
    const puzzleZones = world.zones.filter((z) => z.id !== world.startZoneId);
    // Every original zone got a room; all rooms distinct.
    expect(Object.keys(emb.roomByZone).length).toBe(puzzleZones.length);
    expect(new Set(Object.values(emb.roomByZone)).size).toBe(puzzleZones.length);
    // The start zone spawns in the living room.
    const startRect = emb.layout.zones.find((z) => z.zoneId === "start")!.rect;
    expect(emb.layout.spawn.x).toBeGreaterThanOrEqual(startRect.x);
    expect(emb.layout.spawn.x).toBeLessThanOrEqual(startRect.x + startRect.w);
  });

  it("gates only the prize, on a plausibly-lockable door, with a diegetic reason", () => {
    const { world, emb } = embedded(7);
    // The one guarded passage in the star (the prize) becomes exactly one gate.
    const guardedZones = new Set(
      world.passages.filter((p) => p.guards.length > 0).map((p) => p.to),
    );
    expect(guardedZones.size).toBeGreaterThanOrEqual(1);
    expect(emb.gates.length).toBe(guardedZones.size);
    for (const g of emb.gates) expect(typeof g.reason).toBe("string");
    // A locked doorway appears in the raised building.
    const locked = emb.buildings.flatMap((b) => b.doorways ?? []).filter((d) => d.locked);
    expect(locked.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps every helper freely reachable and the transformed world connected", () => {
    const { emb } = embedded(7);
    // A spanning tree of rooms: rooms-1 passages, all reachable from start.
    expect(emb.world.passages.length).toBe(emb.world.zones.length - 1);
    const adj = new Map<string, string[]>();
    for (const z of emb.world.zones) adj.set(z.id, []);
    for (const p of emb.world.passages) {
      adj.get(p.from)!.push(p.to);
      adj.get(p.to)!.push(p.from);
    }
    const seen = new Set(["start"]);
    const stack = ["start"];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const n of adj.get(cur) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    expect(seen.size).toBe(emb.world.zones.length);
  });

  it("raises ONE contiguous house that expands into a valid world spec", () => {
    const { emb, house } = embedded(7);
    const embedding = embedLayoutInWorld(emb.layout);
    embedding.spec.buildings = emb.buildings;
    const expanded = expandWorldBuildings(embedding.spec);
    expect(validateWorldSpec(expanded).ok).toBe(true);
    // One building per room (living + hall + role rooms), all inside the house.
    expect(emb.buildings.length).toBe(house.rooms.length);
  });

  it("is deterministic — same seed embeds identically", () => {
    const a = embedded(11);
    const b = embedded(11);
    expect(a.emb.roomByZone).toEqual(b.emb.roomByZone);
    expect(JSON.stringify(a.emb.layout)).toBe(JSON.stringify(b.emb.layout));
  });

  it("returns null when the place is too small for the puzzle", () => {
    const game = buildCreatureQuestWorld({ seed: 3, questCount: 3, complexity: "simple" });
    const cert = certifyGoalTreeGame(game);
    if (!cert.ok) throw new Error("cert failed");
    const tiny = generateHouse(1, 3); // 4 role rooms — fewer than the puzzle's zones
    // (a 3-quest simple world has 4 puzzle zones; a roomsNeeded=1 house has 4 —
    //  borderline; force the shortfall with a bigger puzzle)
    const big = buildCreatureQuestWorld({ seed: 3, questCount: 4, complexity: "exchange" });
    const bcert = certifyGoalTreeGame(big);
    if (!bcert.ok) throw new Error("cert failed");
    expect(embedPuzzle(big, bcert.world, tiny, 3)).toBeNull();
  });
});
