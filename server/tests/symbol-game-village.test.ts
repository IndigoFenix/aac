// Village generation: one SEED reproduces the whole world (generator draws →
// plaza-and-houses layout → buildings → house colors), creatures live inside
// their buildings, locked passages are locked ENGINE doors, and houses double
// as LOCATION CLUES ("the ball is in the blue house").
//
// Pure logic — no DB / LLM / GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  buildCreatureQuestWorld,
  certifyCreatureQuestWorld,
  createCreatureWorld,
  planVillageBuildings,
  seeItem,
  selectAct,
  type DialogueAct,
} from "@shared/symbol-game/index.js";
import { certifyGoalTreeGame } from "@shared/goal-tree/index.js";
import { rectCenter } from "@shared/goal-tree/layout2d.js";
import { embedLayoutInWorld } from "@shared/goal-tree/space3d.js";
import { expandWorldBuildings } from "@shared/world-engine/engine.js";
import { validateWorldSpec } from "@shared/world-engine/schema.js";

const PARAMS = { questCount: 3, complexity: "simple" as const };

function certifiedVillage(seed: number) {
  const game = buildCreatureQuestWorld({ ...PARAMS, seed });
  const cert = certifyGoalTreeGame(game);
  if (!cert.ok) throw new Error(`certification failed: ${cert.errors.join("; ")}`);
  return { game, world: cert.world, layout: cert.layout };
}

describe("seed → reproducible world", () => {
  it("records the seed on meta (also when it was drawn randomly)", () => {
    expect(buildCreatureQuestWorld({ ...PARAMS, seed: 7 }).meta.seed).toBe(7);
    expect(typeof buildCreatureQuestWorld(PARAMS).meta.seed).toBe("number");
  });

  it("the same seed rebuilds the identical game, layout, and buildings", () => {
    const a = certifiedVillage(42);
    const b = certifiedVillage(42);
    expect(JSON.stringify(a.game)).toBe(JSON.stringify(b.game));
    expect(JSON.stringify(a.layout)).toBe(JSON.stringify(b.layout));
    const pa = planVillageBuildings(a.game, a.world, embedLayoutInWorld(a.layout).layout);
    const pb = planVillageBuildings(b.game, b.world, embedLayoutInWorld(b.layout).layout);
    expect(JSON.stringify(pa)).toBe(JSON.stringify(pb));
  });

  it("different seeds produce different villages", () => {
    const a = certifiedVillage(1);
    const b = certifiedVillage(2);
    expect(JSON.stringify(a.game) === JSON.stringify(b.game) &&
      JSON.stringify(a.layout) === JSON.stringify(b.layout)).toBe(false);
  });

  it("the simulation certifier still proves seeded worlds playable", () => {
    for (const seed of [3, 11, 12345]) {
      const game = buildCreatureQuestWorld({ questCount: 2, complexity: "exchange", seed });
      expect(certifyCreatureQuestWorld(game)).toEqual({ ok: true });
    }
  });
});

describe("village layout (plaza + houses)", () => {
  it("lays every quest zone out as a house touching the central plaza", () => {
    const { world, layout } = certifiedVillage(42);
    const plaza = layout.zones.find((z) => z.zoneId === world.startZoneId)!.rect;
    for (const zone of layout.zones) {
      if (zone.zoneId === world.startZoneId) continue;
      const r = zone.rect;
      const touches =
        r.y === plaza.y + plaza.h || // south row
        r.y + r.h === plaza.y || // north row
        r.x === plaza.x + plaza.w || // east row
        r.x + r.w === plaza.x; // west row
      expect(touches).toBe(true);
    }
    // The spawn is on the plaza, not in anyone's house.
    expect(layout.spawn).toEqual(rectCenter(plaza));
  });

  it("keeps deep trees (pockets) on the icicle fallback", () => {
    // A collect with a guarded pocket zone is NOT a star — the village
    // projector must decline rather than emit an unwallable layout.
    const { game, world } = certifiedVillage(42);
    void game;
    expect(world.passages.every((p) => p.from === world.startZoneId)).toBe(true);
  });
});

describe("village buildings", () => {
  it("raises one colored house per zone, creatures inside their own house", () => {
    const { game, world, layout } = certifiedVillage(42);
    const embedding = embedLayoutInWorld(layout);
    const plan = planVillageBuildings(game, world, embedding.layout)!;
    expect(plan).not.toBeNull();
    expect(plan.buildings).toHaveLength(embedding.layout.zones.length - 1);

    // Colors are distinct (palette has 8; a village has ≤ 8 houses) and every
    // house has a speakable composed symbol.
    const colors = plan.buildings.map((b) => b.color);
    expect(new Set(colors).size).toBe(colors.length);
    for (const sym of Object.values(plan.houseSymbolByZone)) {
      expect(sym).toMatch(/^home\.color_[a-z]+$/);
    }

    // Every figure (creature/marker) stands INSIDE its zone's building.
    for (const fig of embedding.layout.figures) {
      const zoneId = world.figures.find((f) => f.forNodeId === fig.nodeId)?.zoneId;
      const building = plan.buildings.find(
        (b) => b.footprint === embedding.layout.zones.find((z) => z.zoneId === zoneId)?.rect,
      );
      if (!building) continue; // plaza figures (none today)
      const { x, y, w, h } = building.footprint;
      expect(fig.pos.x).toBeGreaterThan(x);
      expect(fig.pos.x).toBeLessThan(x + w);
      expect(fig.pos.y).toBeGreaterThan(y);
      expect(fig.pos.y).toBeLessThan(y + h);
    }
  });

  it("locks each guarded passage's engine door; the expanded spec validates", () => {
    const { game, world, layout } = certifiedVillage(42);
    const embedding = embedLayoutInWorld(layout);
    const plan = planVillageBuildings(game, world, embedding.layout)!;
    embedding.spec.buildings = plan.buildings;
    const expanded = expandWorldBuildings(embedding.spec);
    expect(validateWorldSpec(expanded).ok).toBe(true);

    const structureById = new Map((expanded.structures ?? []).map((s) => [s.id, s]));
    for (const passage of world.passages) {
      const doorIds = plan.doorIdsByPassage[passage.id] ?? [];
      expect(doorIds.length).toBeGreaterThan(0);
      for (const id of doorIds) {
        const s = structureById.get(id);
        expect(s?.kind).toBe("door");
        expect(s?.kind === "door" && !!s.locked).toBe(passage.guards.length > 0);
      }
    }
  });
});

describe("houses as location clues", () => {
  const sym = (id: string) => id;
  const opts = (placeOf?: (id: string) => string | undefined) => ({
    symbolOf: sym,
    symbolOfCreature: (cid: string) => (cid === "holder" ? "bear" : "there"),
    placeOf,
  });
  const whereIs = (itemId: string): DialogueAct => ({ kind: "where-is", itemId, glyph: "" });

  it("answers where-is for a LOOSE item with the building it lies in", () => {
    const world = createCreatureWorld([{ id: "asker" }, { id: "player" }], [{ id: "ball" }]);
    seeItem(world, "asker", "ball", { kind: "loose" });
    const res = selectAct(world, "asker", "player", whereIs("ball"), "b", opts(() => "home.color_blue"));
    expect(res.responseGlyph).toBe("ball + in + home.color_blue");
    // Without a building, the old deictic answer stands.
    const bare = selectAct(world, "asker", "player", whereIs("ball"), "b", opts());
    expect(bare.responseGlyph).toBe("there");
  });

  it("follows a held-item clue with the holder's house", () => {
    const world = createCreatureWorld(
      [{ id: "asker" }, { id: "holder" }, { id: "player" }],
      [{ id: "ball", ownerId: "holder", displayed: true }],
    );
    seeItem(world, "asker", "ball", { kind: "held", by: "holder" });
    const res = selectAct(world, "asker", "player", whereIs("ball"), "b", opts(() => "home.color_red"));
    expect(res.responseGlyph).toBe("bear + have + ball");
    expect(res.followUpGlyph).toBe("ball + in + home.color_red");
    // "You have it" never gets a house follow-up.
    const world2 = createCreatureWorld(
      [{ id: "asker" }, { id: "player" }],
      [{ id: "ball", ownerId: "player" }],
    );
    seeItem(world2, "asker", "ball", { kind: "held", by: "player" });
    const you = selectAct(world2, "asker", "player", whereIs("ball"), "b", opts(() => "home.color_red"));
    expect(you.followUpGlyph).toBeUndefined();
  });

  it("shows just the house at level a (single-glyph readers)", () => {
    const world = createCreatureWorld([{ id: "asker" }, { id: "player" }], [{ id: "ball" }]);
    seeItem(world, "asker", "ball", { kind: "loose" });
    const res = selectAct(world, "asker", "player", whereIs("ball"), "a", opts(() => "home.color_blue"));
    expect(res.responseGlyph).toBe("home.color_blue");
  });
});
