// town-play (shared/symbol-game/town-play.ts): one serializable config →
// a whole live town session, deterministically — determinism IS the iframe
// transport (the sandbox and the player each build; they must agree).

import { describe, it, expect } from "@jest/globals";
import { certifyGoalTreeGame } from "@shared/world-engine/solver/index.js";
import { certifyCreatureQuestWorld } from "@shared/world-engine/interaction/quest/creature-quests.js";
import { buildTownPlay, isTownPlayPayload } from "@shared/world-engine/interaction/town/town-play.js";
import { resolveTownFocus } from "@shared/world-engine/interaction/town/town-play-game.js";
import { buildTownScope } from "@shared/world-engine/interaction/town/town-play-game.js";
import { parseGameSettings } from "@shared/world-engine/kernel/manifest.js";

describe("town-play: config → session, deterministically", () => {
  it("same config builds the SAME game and stage on both sides of the bridge", () => {
    const cfg = { seed: 42, questCount: 2 as const };
    const a = buildTownPlay(cfg);
    const b = buildTownPlay(cfg);
    expect(JSON.stringify(a.bundle.game)).toBe(JSON.stringify(b.bundle.game));
    expect(JSON.stringify(a.bundle.cast)).toBe(JSON.stringify(b.bundle.cast));
    expect(JSON.stringify(a.stage.spec)).toBe(JSON.stringify(b.stage.spec));
    expect(a.town.scalar("population")).toBe(b.town.scalar("population"));

    // Both gauntlets hold on the built session (the sandbox's loud check).
    const cert = certifyGoalTreeGame(a.bundle.game);
    if (!cert.ok) throw new Error(cert.errors.join("; "));
    const sim = certifyCreatureQuestWorld(a.bundle.game);
    expect(sim.ok ? [] : sim.errors).toEqual([]);

    // The player embodies the cast itself: the stage ships without NPCs,
    // but the anchors are all there.
    expect(a.stage.spec.npcs ?? []).toHaveLength(0);
    expect(a.stage.castSpawns.size).toBe(a.bundle.cast.length);
  });

  it("the payload guard admits exactly the discriminated config", () => {
    expect(isTownPlayPayload({ engine: "town-play", engineVersion: 1, seed: 7 })).toBe(true);
    expect(isTownPlayPayload({ engine: "goal-tree", engineVersion: 1, seed: 7 })).toBe(false);
    expect(isTownPlayPayload({ engine: "town-play", engineVersion: 2, seed: 7 })).toBe(false);
    expect(isTownPlayPayload({ engine: "town-play", engineVersion: 1 })).toBe(false);
    expect(isTownPlayPayload(null)).toBe(false);
  });
});

describe("resolveTownFocus — the dollhouse frame (initial_focus names a house)", () => {
  // One built town serves every case (building is the expensive part).
  const play = buildTownPlay({ seed: 11 });
  const someHouse = play.plan.houses[0]!.index;

  it("null → no focus (the village square, as ever)", () => {
    expect(resolveTownFocus(play, null)).toBeNull();
  });

  it('"house:<index>" and { type: "house", index } name an exact house', () => {
    expect(resolveTownFocus(play, `house:${someHouse}`)).toEqual({ house: someHouse });
    expect(resolveTownFocus(play, { type: "house", index: someHouse })).toEqual({ house: someHouse });
  });

  it("a bare { type: 'house' } picks the ROOMIEST house (it fits the beds)", () => {
    const focus = resolveTownFocus(play, { type: "house" })!;
    const chosen = play.plan.houses.find((h) => h.index === focus.house)!;
    for (const h of play.plan.houses) {
      expect(chosen.w * chosen.h).toBeGreaterThanOrEqual(h.w * h.h);
    }
  });

  it("rejects unknown ids, unknown params, wrong types, and missing houses — path-exact", () => {
    expect(() => resolveTownFocus(play, "plaza")).toThrow(/unknown object ID/);
    expect(() => resolveTownFocus(play, "house:99999")).toThrow(/does not exist/);
    expect(() => resolveTownFocus(play, { type: "star" })).toThrow(/expected "house"/);
    expect(() => resolveTownFocus(play, { type: "house", size: 3 })).toThrow(/unknown parameter/);
    expect(() => resolveTownFocus(play, { type: "house", index: 1.5 })).toThrow(/integer/);
  });
});

describe("defined entities — a hand-authored household (entities.creatures/objects)", () => {
  const game = (entities: unknown) => ({
    scope: "town" as const,
    world: { seed: 11 },
    initial_focus: { type: "house" },
    avatar: true,
    ...(entities !== undefined ? { entities } : {}),
  });

  it("kernel gates the SHAPE: modes, groups, entry objects", () => {
    expect(() => parseGameSettings(game({ pets: {} }), "t")).toThrow(/unknown group/);
    expect(() => parseGameSettings(game({ creatures: { mode: "most", list: [] } }), "t")).toThrow(/"some" or "all"/);
    expect(() => parseGameSettings(game({ creatures: { mode: "all", list: ["Mara"] } }), "t")).toThrow(/expected an object/);
    const ok = parseGameSettings(game({ creatures: { mode: "all", list: [{ name: "Mara" }] } }), "t");
    expect(ok.entities?.creatures?.mode).toBe("all");
    expect(parseGameSettings(game(undefined), "t").entities).toBeNull();
  });

  it("town scope: a mode-'all' family fills the FOCUSED house exactly; replay-stable via config", () => {
    const settings = parseGameSettings(
      game({
        creatures: {
          mode: "all",
          list: [
            { name: "Mara", outfit: 4, likes: ["apple"] },
            { name: "Orrin", likes: ["banana"] },
          ],
        },
        objects: { mode: "some", list: [{ glyph: "teddy", at: "box" }] },
      }),
      "t",
    );
    const built = buildTownScope(settings, "t");
    expect(built.play.familyHouse).not.toBeNull();
    expect(built.focus?.house).toBe(built.play.familyHouse); // family lives where the focus points
    expect(built.spec.config.family?.members).toHaveLength(2);
    expect(built.spec.config.items).toEqual([{ glyph: "teddy", at: "box" }]);
    // Replay path: the SAME config rebuilds the same family placement.
    expect(buildTownPlay(built.spec.config).familyHouse).toBe(built.play.familyHouse);
  });

  it("town scope refuses what it can't honor, path-exact", () => {
    const focusless = { ...parseGameSettings(game({ creatures: { mode: "all", list: [{ name: "A" }] } }), "t"), initialFocus: null };
    expect(() => buildTownScope(focusless, "t")).toThrow(/focused household/);
    const allObjects = parseGameSettings(game({ objects: { mode: "all", list: [{ glyph: "teddy" }] } }), "t");
    expect(() => buildTownScope(allObjects, "t")).toThrow(/economy/);
    const badField = parseGameSettings(game({ creatures: { mode: "some", list: [{ hat: 3 }] } }), "t");
    expect(() => buildTownScope(badField, "t")).toThrow(/unknown field/);
  });
});
