// The ONE sharable Fact model (creature-knowledge.md / facts.ts): perceive =
// tell, one channel; monotone coverage with value replacement on an axis;
// location/want arms are ADAPTERS over the certified knowledge/knownWants
// stores (no duplicated storage). Pure logic — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  createCreatureWorld,
  seeItem,
  type CreatureWorld,
} from "@shared/world-engine/interaction/behavior/creatures.js";
import {
  factKey,
  knowsFact,
  perceiveFact,
  tellFact,
  STATE_AXES,
  type Fact,
} from "@shared/world-engine/interaction/behavior/facts.js";

function makeWorld(): CreatureWorld {
  return createCreatureWorld(
    [
      { id: "mara", condition: "hungry" },
      { id: "bob" },
      { id: "player" },
    ],
    [
      { id: "window_1", device: true, states: ["open"], kind: "window" },
      { id: "apple_1", ownerId: "mara", states: ["hot"], kind: "apple", category: "food" },
      { id: "ball_1", kind: "ball", category: "toy" },
    ],
  );
}

describe("perceiveFact / tellFact — one channel", () => {
  it("writes an itemState belief and fires fact-learned once", () => {
    const w = makeWorld();
    const fact: Fact = { kind: "itemState", item: "window_1", axis: "aperture", state: "open" };
    const ev1 = perceiveFact(w, "bob", fact);
    expect(ev1).toEqual([{ type: "fact-learned", creatureId: "bob", fact }]);
    expect(perceiveFact(w, "bob", fact)).toEqual([]); // nothing new
  });

  it("replaces the VALUE on the same axis, keeping one key (monotone coverage)", () => {
    const w = makeWorld();
    const open: Fact = { kind: "itemState", item: "window_1", axis: "aperture", state: "open" };
    const closed: Fact = { kind: "itemState", item: "window_1", axis: "aperture", state: "closed" };
    perceiveFact(w, "bob", open);
    const ev = perceiveFact(w, "bob", closed);
    expect(ev).toHaveLength(1);
    expect(factKey(open)).toBe(factKey(closed));
    expect(knowsFact(w, "bob", { kind: "itemState", item: "window_1", axis: "aperture" })).toEqual(closed);
  });

  it("telling writes the same fact a sighting would", () => {
    const w = makeWorld();
    const fact: Fact = { kind: "condition", creature: "mara", condition: "hungry" };
    tellFact(w, "bob", fact);
    expect(knowsFact(w, "bob", { kind: "condition", creature: "mara" })).toEqual(fact);
  });

  it("location facts delegate to the certified seeItem path — no duplicate store", () => {
    const w = makeWorld();
    const fact: Fact = { kind: "location", item: "ball_1", where: { kind: "held", by: "bob" } };
    const ev = perceiveFact(w, "player", fact);
    expect(ev).toEqual([
      { type: "knowledge-gained", creatureId: "player", itemId: "ball_1", where: { kind: "held", by: "bob" } },
    ]);
    expect(w.creatures["player"]!.knowledge["ball_1"]).toEqual({ kind: "held", by: "bob" });
    expect(w.creatures["player"]!.facts ?? {}).toEqual({}); // adapter, not a copy
  });

  it("want facts ride knownWants", () => {
    const w = makeWorld();
    const fact: Fact = { kind: "want", creature: "mara", item: "ball_1" };
    expect(perceiveFact(w, "bob", fact)).toHaveLength(1);
    expect(perceiveFact(w, "bob", fact)).toEqual([]);
    expect(w.creatures["bob"]!.knownWants["ball_1"]).toBe("mara");
    expect(knowsFact(w, "bob", { kind: "want", creature: "mara" })).toEqual(fact);
  });
});

describe("knowsFact — recall and the honest don't-know", () => {
  it("answers whoHas from a held location belief only", () => {
    const w = makeWorld();
    expect(knowsFact(w, "player", { kind: "whoHas", item: "ball_1" })).toBeNull();
    seeItem(w, "player", "ball_1", { kind: "loose" });
    expect(knowsFact(w, "player", { kind: "whoHas", item: "ball_1" })).toBeNull(); // loose ≠ a holder
    seeItem(w, "player", "ball_1", { kind: "held", by: "mara" });
    expect(knowsFact(w, "player", { kind: "whoHas", item: "ball_1" })).toEqual({
      kind: "location",
      item: "ball_1",
      where: { kind: "held", by: "mara" },
    });
  });

  it("a creature always knows its OWN condition (and 'fine' is null)", () => {
    const w = makeWorld();
    expect(knowsFact(w, "mara", { kind: "condition", creature: "mara" })).toEqual({
      kind: "condition",
      creature: "mara",
      condition: "hungry",
    });
    expect(knowsFact(w, "bob", { kind: "condition", creature: "bob" })).toEqual({
      kind: "condition",
      creature: "bob",
      condition: null,
    });
    // But it does NOT know a third party's condition until it perceives/is told.
    expect(knowsFact(w, "bob", { kind: "condition", creature: "mara" })).toBeNull();
  });

  it("holding an item = seeing it: live states beat the belief store", () => {
    const w = makeWorld();
    // Mara holds the hot apple — she answers from its live states, unseeded.
    expect(knowsFact(w, "mara", { kind: "itemState", item: "apple_1" })).toEqual({
      kind: "itemState",
      item: "apple_1",
      axis: "temperature",
      state: "hot",
    });
    // Bob neither holds nor heard about it — honest don't-know.
    expect(knowsFact(w, "bob", { kind: "itemState", item: "apple_1" })).toBeNull();
  });

  it("answers presence only from perception/telling", () => {
    const w = makeWorld();
    expect(knowsFact(w, "bob", { kind: "presence", creature: "mara" })).toBeNull();
    tellFact(w, "bob", { kind: "presence", creature: "mara", place: "work" });
    expect(knowsFact(w, "bob", { kind: "presence", creature: "mara" })).toEqual({
      kind: "presence",
      creature: "mara",
      place: "work",
    });
  });

  it("is deterministic across axis enumeration", () => {
    const w = makeWorld();
    tellFact(w, "bob", { kind: "itemState", item: "pan_1", axis: "temperature", state: "hot" });
    tellFact(w, "bob", { kind: "itemState", item: "pan_1", axis: "cleanliness", state: "dirty" });
    const a = knowsFact(w, "bob", { kind: "itemState", item: "pan_1" });
    const b = knowsFact(w, "bob", { kind: "itemState", item: "pan_1" });
    expect(a).toEqual(b); // lowest key wins, stable
  });
});

describe("STATE_AXES — every engine state tag has an axis", () => {
  it("covers the STATE_TAGS poles pairwise", () => {
    expect(STATE_AXES["open"]).toBe(STATE_AXES["closed"]);
    expect(STATE_AXES["hot"]).toBe(STATE_AXES["cold"]);
    expect(STATE_AXES["clean"]).toBe(STATE_AXES["dirty"]);
    expect(STATE_AXES["wet"]).toBe(STATE_AXES["dry"]);
    expect(STATE_AXES["on"]).toBe(STATE_AXES["off"]);
    expect(STATE_AXES["hot"]).not.toBe(STATE_AXES["dirty"]);
  });
});
