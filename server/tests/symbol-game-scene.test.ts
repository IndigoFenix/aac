// Scene-assembly tests (planning-docs/symbol-learning-game-plan.md step 3 / §0).
//
// buildScene turns ONE quote-exchange into a fully playable, co-certified scene:
// the goal-tree BEATS + the WORLD they happen in, sharing one frozen binding so
// the lesson's bound objects are physically present in the world. Asserts both
// halves certify, the binding is shared (a beat references the SAME object that
// appears as a world prop), and DO beats are rejected at the compile stage.
//
// Pure logic — no DB / LLM / GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  POOLS,
  REQUESTING_EXCHANGES,
  buildScene,
  firstMemberPicker,
  randomMemberPicker,
} from "@shared/symbol-game/index.js";

const TELL = REQUESTING_EXCHANGES.filter((e) => e.responses.length >= 2);

describe("buildScene — quote → playable scene", () => {
  it("PROPERTY: every TELL exchange builds + co-certifies under many random bindings", () => {
    for (const ex of TELL) {
      for (let trial = 0; trial < 20; trial++) {
        const res = buildScene(ex, POOLS, randomMemberPicker);
        if (!res.ok) throw new Error(`exchange "${ex.id}" trial ${trial} failed at ${res.stage}: ${res.errors.join("; ")}`);
        // Sanity: the world has at least the spawn and the layout has zones.
        expect(res.scene.world.spawns.length).toBeGreaterThanOrEqual(1);
        expect(res.scene.layout.zones.length).toBeGreaterThanOrEqual(1);
        expect(res.scene.transport).toEqual([]); // TELL beats carry no transport
      }
    }
  });

  it("shares ONE binding across beats and world props (the lesson's object is physically present)", () => {
    const a6 = TELL.find((e) => e.id === "a6-give-or-take")!;
    const res = buildScene(a6, POOLS, firstMemberPicker); // friend→rabbit, toy→ball
    if (!res.ok) throw new Error(`failed: ${res.errors.join("; ")}`);
    const { scene } = res;

    expect(scene.binding.toy!.symbol).toBe("ball");
    expect(scene.binding.friend!.symbol).toBe("rabbit");

    // The bound TOY is a physical world object; the bound FRIEND is an NPC.
    expect(scene.world.objects.some((o) => o.id === "amb_toy")).toBe(true);
    const friendNpc = (scene.world.npcs ?? []).find((n) => n.id === "amb_friend");
    expect(friendNpc?.name).toBe("Rabbit");

    // The SAME ball the world shows is what the beats ask the student to give/take.
    const choose = scene.game.root.type === "reach"
      ? scene.game.root.via?.map((o) => o.key).find((k) => k.type === "choose")
      : undefined;
    if (choose?.type !== "choose") throw new Error("expected choose");
    const byId = new Map(scene.game.entities.map((e) => [e.id, e]));
    const optionGlyphs = choose.options.map((o) => byId.get(o.entityId)!.glyph);
    expect(optionGlyphs).toEqual(["give + ball", "take + ball"]);
  });

  it("ambientProps:false yields a world with no bound props", () => {
    const a4 = TELL.find((e) => e.id === "a4-give-me")!;
    const res = buildScene(a4, POOLS, firstMemberPicker, { ambientProps: false });
    if (!res.ok) throw new Error(`failed: ${res.errors.join("; ")}`);
    expect(res.scene.world.objects.some((o) => o.id.startsWith("amb_"))).toBe(false);
    expect((res.scene.world.npcs ?? []).some((n) => n.id.startsWith("amb_"))).toBe(false);
  });

  it("builds a DO fetch scene (A1) with distinguishable carryables + an icon-matched destination", () => {
    const a1 = REQUESTING_EXCHANGES.find((e) => e.id === "a1-want-fetch")!;
    const res = buildScene(a1, POOLS, firstMemberPicker); // treat→cookie
    if (!res.ok) throw new Error(`${res.stage}: ${res.errors.join("; ")}`);
    const transport = res.scene.game.root.type === "reach"
      ? res.scene.game.root.via?.map((o) => o.key).find((k) => k.type === "transport")
      : undefined;
    expect(transport?.type).toBe("transport");
    // The world has carryable candidates (all with icons); the destination shows
    // its OWN icon (a basket), NOT the item's, and the wanted item rides as the
    // placement's `wantGlyph` (the player draws it as a bubble over the dest).
    const objs = res.scene.world.objects;
    const carryables = objs.filter((o) => o.id.startsWith("obj_") && o.interactions.includes("carry"));
    expect(carryables.length).toBeGreaterThanOrEqual(2); // target + ≥1 distractor
    expect(carryables.every((o) => !!o.iconRef)).toBe(true);
    const dest = objs.find((o) => o.id.startsWith("dest_"));
    const target = objs.find((o) => o.id.startsWith("obj_") && !/_d\d+$/.test(o.id));
    expect(dest?.iconRef).not.toBe(target?.iconRef); // recipient never wears the item's face
    expect(res.scene.transport[0]?.wantGlyph).toBeTruthy();
  });

  it("builds a DO transport scene with materialized carry + destination objects", () => {
    // A synthetic transport DO: "put the toy" → carry it to a spot.
    const putToy = {
      id: "x-put-toy",
      concept: "put",
      action: { kind: "transport", slot: "toy", relation: "on" } as const,
      prompt: {
        id: "x-put-prompt",
        glyph: "put + {toy}",
        textKey: "symbolGame.quote.x.put",
        slots: ["toy"],
        speaker: "npc" as const,
        concept: "put",
      },
      responses: [],
    };
    const res = buildScene(putToy, POOLS, firstMemberPicker);
    if (!res.ok) throw new Error(`${res.stage}: ${res.errors.join("; ")}`);
    // buildTransportObjects materialized the carry object + its container.
    expect(res.scene.transport.length).toBe(1);
    const ids = res.scene.world.objects.map((o) => o.id);
    expect(ids.some((id) => id.startsWith("obj_"))).toBe(true);
    expect(ids.some((id) => id.startsWith("dest_"))).toBe(true);
  });

  it("rejects an exchange with no responses and no action at the compile stage", () => {
    const a1 = REQUESTING_EXCHANGES.find((e) => e.id === "a1-want-fetch")!;
    const inert = { ...a1, action: undefined };
    const res = buildScene(inert, POOLS, firstMemberPicker);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.stage).toBe("compile");
  });
});
