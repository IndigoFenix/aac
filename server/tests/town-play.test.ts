// town-play (shared/symbol-game/town-play.ts): one serializable config →
// a whole live town session, deterministically — determinism IS the iframe
// transport (the sandbox and the player each build; they must agree).

import { describe, it, expect } from "@jest/globals";
import { certifyGoalTreeGame } from "@shared/goal-tree/index.js";
import { certifyCreatureQuestWorld } from "@shared/symbol-game/creature-quests.js";
import { buildTownPlay, isTownPlayPayload } from "@shared/symbol-game/town-play.js";

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
