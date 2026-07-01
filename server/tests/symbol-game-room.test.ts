// Hybrid-room tests (planning-docs/symbol-learning-game-plan.md §6.4).
//
// The room-level analog of the compile property test: a predefined SHELL plus
// procedural fill-slots, under ANY binding, lowers to a WorldSpec that passes
// certifyWorldSpec. Plus the content-layer "room" pre-checks (resolve / in-bounds
// / id-collision / caps) and affordance → object/NPC materialization.
//
// Pure logic — no DB / LLM / GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import { certifyWorldSpec } from "@shared/world-engine/index.js";
import {
  DEFAULT_PLAYROOM,
  POOLS,
  PLAYROOM_SHELL,
  certifyHybridRoom,
  firstMemberPicker,
  lowerHybridRoom,
  objectConfigForAffordance,
  randomMemberPicker,
  type HybridRoomSpec,
} from "@shared/symbol-game/index.js";

describe("hybrid room — lowering + certification", () => {
  it("the bare predefined shell already certifies", () => {
    expect(certifyWorldSpec(PLAYROOM_SHELL).ok).toBe(true);
  });

  it("the default playroom certifies under the deterministic first binding", () => {
    const cert = certifyHybridRoom(DEFAULT_PLAYROOM, POOLS, firstMemberPicker);
    if (!cert.ok) throw new Error(`${cert.stage}: ${cert.errors.join("; ")}`);
    expect(cert.ok).toBe(true);
  });

  it("PROPERTY: the default playroom certifies under many random bindings", () => {
    for (let trial = 0; trial < 40; trial++) {
      const cert = certifyHybridRoom(DEFAULT_PLAYROOM, POOLS, randomMemberPicker);
      if (!cert.ok) throw new Error(`trial ${trial} ${cert.stage}: ${cert.errors.join("; ")}`);
    }
  });

  it("materializes a receptive-npc pool as an NPC and others as objects", () => {
    const spec = lowerHybridRoom(DEFAULT_PLAYROOM, POOLS, firstMemberPicker);
    // toy + treat → objects (ids fill_toy/fill_treat); friend → npc (fill_friend).
    expect(spec.objects.map((o) => o.id).sort()).toEqual(["fill_toy", "fill_treat"]);
    expect((spec.npcs ?? []).map((n) => n.id)).toEqual(["fill_friend"]);
    // The NPC carries the bound member's display name (friend→rabbit, first member).
    expect(spec.npcs![0]!.name).toBe("Rabbit");
  });

  it("derives world interactions from the pool affordance", () => {
    const spec = lowerHybridRoom(DEFAULT_PLAYROOM, POOLS, firstMemberPicker);
    const toy = spec.objects.find((o) => o.id === "fill_toy")!;
    expect(toy.interactions).toEqual(["carry"]); // graspable
    // A container affordance carries containment slots and no push/carry.
    const containerCfg = objectConfigForAffordance("container");
    expect(containerCfg.interactions).toEqual([]);
    expect(containerCfg.contains?.length).toBeGreaterThanOrEqual(1);
  });

  it("a push object always gets push tuning (so it certifies)", () => {
    const vehicleCfg = objectConfigForAffordance("startable-movable");
    expect(vehicleCfg.interactions).toContain("push");
    expect(vehicleCfg.push).toBeDefined();
  });
});

describe("hybrid room — pre-check stage catches authoring errors", () => {
  it("flags an out-of-bounds slot", () => {
    const bad: HybridRoomSpec = {
      id: "bad",
      shell: PLAYROOM_SHELL,
      slots: [{ id: "fill_x", pool: "toy", at: { x: 999, y: 999 } }],
    };
    const cert = certifyHybridRoom(bad, POOLS, firstMemberPicker);
    expect(cert.ok).toBe(false);
    if (cert.ok) throw new Error("expected failure");
    expect(cert.stage).toBe("room");
    expect(cert.errors.join(" ")).toMatch(/outside the manifold/);
  });

  it("flags a slot id that collides with a shell id", () => {
    const bad: HybridRoomSpec = {
      id: "bad",
      shell: PLAYROOM_SHELL,
      slots: [{ id: "spawn_main", pool: "toy", at: { x: 8, y: 8 } }], // collides with the spawn
    };
    const cert = certifyHybridRoom(bad, POOLS, firstMemberPicker);
    expect(cert.ok).toBe(false);
    if (cert.ok) throw new Error("expected failure");
    expect(cert.errors.join(" ")).toMatch(/collides/);
  });

  it("flags an unknown pool", () => {
    const bad: HybridRoomSpec = {
      id: "bad",
      shell: PLAYROOM_SHELL,
      slots: [{ id: "fill_x", pool: "nope", at: { x: 8, y: 8 } }],
    };
    const cert = certifyHybridRoom(bad, POOLS, firstMemberPicker);
    expect(cert.ok).toBe(false);
    if (cert.ok) throw new Error("expected failure");
    expect(cert.errors.join(" ")).toMatch(/unknown pool/);
  });
});
