// WHERE ARE YOU GOING — the answer must NAME the place.
//
// A creature walks because a goal sent it, so a nameless destination is a
// naming failure, not an unnameable place. `goalDestination` is the first of
// the three ways the host names a walk (reason → ground → purpose), and it is
// the one that stops a hauler announcing "I'll carry the block to the kitchen"
// and then answering "there" one second later — the two channels read the same
// goal through the same resolver now.
//
// Pure: `goalDestination` takes a GoalSpec and the symbol resolvers, so this
// suite needs no host and no world.

import { describe, it, expect } from "@jest/globals";
import { goalDestination } from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import type { IntentLineSyms } from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";

/** The resolvers a host supplies, stubbed: places answer by their own words,
 *  and `point` is the ONE that may fall back to the deictic — exactly as
 *  `intentLineSyms` does when nothing stands at the point. */
const syms = (pointWord = "there"): IntentLineSyms => ({
  item: (ref) => ("id" in ref ? ref.id : (ref.match.kind ?? "thing")),
  place: (p) =>
    p.kind === "named"
      ? p.id
      : p.kind === "home"
        ? "home"
        : p.kind === "creature"
          ? `creature:${p.id}`
          : pointWord,
  creature: (id) => `creature:${id}`,
});

describe("goalDestination — the REASON names the walk", () => {
  it("reads a haul's destination off the goal, exactly as its announcement does", () => {
    const goal: GoalSpec = {
      kind: "transfer",
      agreementId: "a1",
      goods: { block: 4 },
      to: { kind: "named", id: "kitchen" },
    };
    expect(goalDestination(goal, syms())).toEqual({ kind: "place", place: "kitchen" });
  });

  it("names the RECIPIENT when a transfer ends in somebody's hands", () => {
    const goal: GoalSpec = {
      kind: "transfer",
      agreementId: "a1",
      goods: { wood: 1 },
      to: { kind: "creature", id: "mara" },
    };
    expect(goalDestination(goal, syms())).toEqual({ kind: "place", place: "creature:mara" });
  });

  it("reads acquisition as the THING SOUGHT, wherever its source stands", () => {
    expect(goalDestination({ kind: "takeUnits", from: { kind: "named", id: "yard" }, category: "food", units: 2 }, syms()))
      .toEqual({ kind: "fetch", good: "food" });
  });

  it("walks to the ANCHOR of a placement, not the relation", () => {
    const goal: GoalSpec = {
      kind: "place",
      item: { match: { kind: "chair" } },
      at: { relation: "in", anchor: { kind: "named", id: "workshop" } },
    };
    expect(goalDestination(goal, syms())).toEqual({ kind: "place", place: "workshop" });
  });

  it("goes HOME for the home goal, and nowhere for staying put", () => {
    expect(goalDestination({ kind: "goHome" }, syms())).toEqual({ kind: "home" });
    expect(goalDestination({ kind: "stay" }, syms())).toBeUndefined();
  });

  it("NEVER launders a deictic into an answer — the caller keeps looking", () => {
    // The place resolver's own last resort is "there"; a goal that resolves to
    // it has named nothing, and returning it here would stop the host's ground
    // and purpose fallbacks from ever running.
    const goal: GoalSpec = { kind: "goTo", place: { kind: "point", x: 5, y: 5 } };
    expect(goalDestination(goal, syms("there"))).toBeUndefined();
    expect(goalDestination(goal, syms("bed"))).toEqual({ kind: "place", place: "bed" });
  });

  it("has no destination for an act performed where the body already is", () => {
    expect(goalDestination({ kind: "equipUnits", category: "shirt" }, syms())).toBeUndefined();
    expect(goalDestination({ kind: "build", structure: "house", cap: 1 }, syms())).toBeUndefined();
  });
});
