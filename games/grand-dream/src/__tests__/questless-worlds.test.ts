/**
 * QUESTLESS WORLDS — questCount defaults to 0 everywhere (2026-07).
 *
 * A spec that names no questCount gets NO quests: the town is still a full
 * living economy (residents, streets, stage), the structure is still a
 * building — there is just no quest overlay. The empty quest bundle
 * (entities = [star], cast = [], via-less reach root) must still CERTIFY,
 * because buildTownScope refuses towns whose bundle fails the gauntlet.
 *
 * No-win safety: a town stage never places the star marker (certification
 * scaffolding only — town-quests.ts), and a reach node completes only when
 * its marker is TOUCHED (solver/runtime.ts), so a via-less root cannot
 * auto-win a questless town session.
 */
import { describe, it, expect } from "vitest";
import { loadWorldManifest, type LoadedWorld } from "@shared/world-engine/kernel/manifest";
import { ECONOMY_MODULE } from "@shared/world-engine/kernel/modules/economy/index";
import {
  buildTownScope, parseTownWorld,
} from "@shared/world-engine/interaction/town/town-play-game";
import {
  buildCreatureQuestWorld, certifyCreatureQuestWorld,
} from "@shared/world-engine/interaction/quest/creature-quests";
import { certifyGoalTreeGame } from "@shared/world-engine/solver/index";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play";
import { cityTownConfig } from "../../../world-lab/src/city-towns";
import type { FlightCity } from "../../../world-lab/src/space-fly";

const load = (doc: unknown, label?: string): LoadedWorld =>
  loadWorldManifest(doc, [ECONOMY_MODULE], label);

const townDoc = (world: Record<string, unknown>): Record<string, unknown> => ({
  engine: "aivota-world", engineVersion: 1, uses: [], packs: [],
  game: {
    scope: "town",
    world,
    initial_focus: null, avatar: true, creative_mode: false,
  },
});

describe("questless town — no questCount in the spec means no quests", () => {
  it("builds, certifies, and carries an EMPTY quest bundle", { timeout: 240000 }, () => {
    const loaded = load(townDoc({ seed: 21 }), "questless-town");
    const built = buildTownScope(loaded.game!, "questless-town");
    // The town itself is fully alive…
    expect(built.play.town.scalar("population")).toBeGreaterThan(0);
    expect(built.play.plan.houses.length).toBeGreaterThan(0);
    // …but nothing quest-shaped was drawn from it.
    expect(built.play.bundle.cast.length).toBe(0);
    expect(built.play.bundle.needs.length).toBe(0);
    expect(built.play.bundle.game.entities.map(e => e.id)).toEqual(["star"]);
    // via is ABSENT (not []) — the schema's min-1 array demands omission.
    expect(built.play.bundle.game.root.via).toBeUndefined();
  });

  it("the empty bundle passes the goal-tree gauntlet on its own", () => {
    const play = buildTownPlay({ seed: 21 });
    const cert = certifyGoalTreeGame(play.bundle.game);
    expect(cert.ok, cert.ok ? "" : `${(cert as { stage: string }).stage}: ${(cert as { errors: string[] }).errors.join("; ")}`).toBe(true);
    const creatureCert = certifyCreatureQuestWorld(play.bundle.game);
    expect(creatureCert.ok).toBe(true);
  });

  it("questCount: 0 is legal and explicit counts still work", () => {
    expect(parseTownWorld({ seed: 1, questCount: 0 }, "w").config.questCount).toBe(0);
    expect(() => parseTownWorld({ seed: 1, questCount: 4 }, "w")).toThrow(/out of range \(0\.\.3\)/);
    const withQuests = buildTownPlay({ seed: 21, questCount: 2 });
    expect(withQuests.bundle.cast.length).toBe(4); // wanter + vendor per quest
    expect(withQuests.bundle.needs.length).toBe(2);
  });

  it("determinism holds: same seed, same questless town", () => {
    const a = buildTownPlay({ seed: 33 });
    const b = buildTownPlay({ seed: 33 });
    expect(a.plan.houses.length).toBe(b.plan.houses.length);
    expect(a.bundle.game).toEqual(b.bundle.game);
  });
});

describe("questless structure — requested zero is honored", () => {
  it("questCount 0 builds a bare, certifiable world", () => {
    const game = buildCreatureQuestWorld({ seed: 5, questCount: 0 });
    expect(game.entities.map(e => e.id)).toEqual(["star"]);
    expect(game.root.via).toBeUndefined();
    const cert = certifyCreatureQuestWorld(game);
    expect(cert.ok, cert.ok ? "" : JSON.stringify(cert)).toBe(true);
  });

  it("a truncated NONZERO request still floors at one quest", () => {
    const game = buildCreatureQuestWorld({ seed: 5, questCount: 2 });
    expect(game.entities.length).toBeGreaterThan(1);
  });
});

describe("planet-founded towns read the spec's questCount", () => {
  const fc = {
    city: {
      cell: 4242, name: "Test Haven", density: 200, startPop: 300,
      charter: undefined,
    },
  } as unknown as FlightCity;

  it("defaults to 0 (the old hard-coded 2 is gone)", () => {
    expect(cityTownConfig(fc, 0).questCount).toBe(0);
  });

  it("an explicit spec value is passed through", () => {
    expect(cityTownConfig(fc, 0, 2).questCount).toBe(2);
  });
});
