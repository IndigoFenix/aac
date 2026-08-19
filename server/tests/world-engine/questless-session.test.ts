// QUESTLESS SESSION PIN (Shape B, quest-spine-detachment.md rulings 2026-08-17).
// The bug class this guards had NO coverage for three playtest rounds: the old
// questless boot fabricated a goal-tree shell (`buildCreatureQuestWorld({
// questCount: 0 })`), raised a real star building from its root zone, then
// stripped pieces of it — and each leftover (the invisible wall, the rebase
// jump, the navy start-zone pad, the accidental win) surfaced separately in
// play. Shape B's contract: a questless session carries NO quest objects.
//
// Construction-level only (no frames stepped): quest-host's per-worker
// transform tax is paid once; every assertion is a boot fact.

import { describe, it, expect } from "@jest/globals";
import { makeQuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import { buildCreatureQuestWorld } from "@shared/world-engine/interaction/quest/creature-quests.js";
import { parseWorldForScope } from "@shared/world-engine/scope-registry.js";

describe("questless session (Shape B): no quest objects, no fabricate-then-strip", () => {
  it("makeQuestSession(null) carries no goal tree, no solver world, no runtime, no geometry", () => {
    const s = makeQuestSession(null);
    expect(s.game).toBeNull();
    expect(s.world).toBeNull();
    expect(s.ctx).toBeNull();
    // The layout is EMPTY — no zones means no zone pads, no marker figures,
    // no village houses, nothing for a chunk rebase to jump.
    expect(s.embedding.layout.zones).toHaveLength(0);
    expect(s.embedding.layout.doors).toHaveLength(0);
    expect(s.embedding.layout.figures).toHaveLength(0);
    expect(s.embedding.spec.buildings ?? []).toHaveLength(0);
    expect(s.embedding.spec.structures ?? []).toHaveLength(0);
    expect(s.embedding.spec.objects).toHaveLength(0);
    // Meta is pure defaults — there is no authored meta to inherit.
    expect(s.meta).toMatchObject({ title: "world", locale: "en", syntax: "b", seed: 0 });
  });

  it("the boot's meta override IS the session meta (the RNG seed travels)", () => {
    const s = makeQuestSession(null, null, { seed: 41, locale: "he", title: "Creature Quest Village" });
    // convo/chat RNG reads meta.seed — a boot that dropped it would shift transcripts.
    expect(s.meta.seed).toBe(41);
    expect(s.meta.locale).toBe("he");
    expect(s.meta.title).toBe("Creature Quest Village");
    expect(s.meta.syntax).toBe("b"); // untouched fields keep their defaults
  });

  it("an authored game still builds the full quest session (the inversion did not regress quests)", () => {
    const game = buildCreatureQuestWorld({ seed: 7, questCount: 1 });
    const s = makeQuestSession(game);
    expect(s.game).toBe(game);
    expect(s.world).not.toBeNull();
    expect(s.ctx).not.toBeNull();
    expect(s.embedding.layout.zones.length).toBeGreaterThan(0);
    expect(s.meta.title).toBe(game.meta.title); // snapshot of the authored meta
    expect(s.meta.seed).toBe(7);
  });

  it("questCount is not declarable above town/structure (Shape B ruling 3)", () => {
    // Structure keeps it…
    expect(() => parseWorldForScope("structure", { seed: 1, questCount: 1 }, "w")).not.toThrow();
    // …the outer rungs reject it via the strict gate's unknown-field sweep.
    for (const scope of ["galaxy", "star_cluster"] as const) {
      expect(() => parseWorldForScope(scope, { seed: 1, questCount: 1 }, "w")).toThrow(/unknown field/);
      expect(() => parseWorldForScope(scope, { seed: 1 }, "w")).not.toThrow();
    }
  });
});
