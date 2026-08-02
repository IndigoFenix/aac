// The hover table (dwell-interaction.ts): what the spark resting on a thing
// MEANS. Pure, so every cell is provable — which is the point of moving the rule
// out of the frame loop, where five competing dwells each read the gaze their
// own way and none of it could be tested.

import { describe, it, expect } from "@jest/globals";
import {
  dwellInteraction,
  type DwellPhase,
  type HoverTarget,
} from "@shared/world-engine/interaction/quest/dwell-interaction.js";

const creature = (id: string): HoverTarget => ({ kind: "creature", id, x: 1, y: 2 });
const object = (id: string): HoverTarget => ({ kind: "object", id, x: 3, y: 4 });
const ground = (): HoverTarget => ({ kind: "ground", x: 5, y: 6 });

const alone = { conversingWith: null };
const talkingTo = (cid: string) => ({ conversingWith: cid });

describe("no conversation running", () => {
  it("SHORT on an object puts it on the board", () => {
    expect(dwellInteraction(object("chest_1"), "short", alone)).toEqual([{ act: "menu", id: "chest_1" }]);
  });

  it("LONG on a creature opens a conversation", () => {
    expect(dwellInteraction(creature("mara"), "long", alone)).toEqual([{ act: "talk", id: "mara" }]);
  });

  it("does NOT open a conversation on a passing glance", () => {
    // A conversation is a commitment; a short look at someone walking by must
    // not start one.
    expect(dwellInteraction(creature("mara"), "short", alone)).toEqual([]);
  });

  it("LONG on bare ground names the room", () => {
    expect(dwellInteraction(ground(), "long", alone)).toEqual([{ act: "room", x: 5, y: 6 }]);
  });

  it("says nothing on a SHORT glance at bare ground", () => {
    // The ground is what the gaze crosses on the way everywhere else.
    expect(dwellInteraction(ground(), "short", alone)).toEqual([]);
  });
});

describe("mid-conversation, the same hovers become instructions", () => {
  const ctx = talkingTo("mara");

  it("SHORT on an object opens its board AND points the partner at it", () => {
    // ADDITIVE, not either/or. The board must still open mid-conversation —
    // otherwise the rule that selecting a menu item instructs your partner is
    // unreachable, because the menu it needs could never be open.
    expect(dwellInteraction(object("well_1"), "short", ctx)).toEqual([
      { act: "menu", id: "well_1" },
      { act: "attendObject", cid: "mara", id: "well_1" },
    ]);
  });

  it("SHORT on another creature points the partner at them", () => {
    expect(dwellInteraction(creature("bram"), "short", ctx)).toEqual([
      { act: "attendCreature", cid: "mara", id: "bram" },
    ]);
  });

  it("LONG on another creature turns to THEM instead", () => {
    expect(dwellInteraction(creature("bram"), "long", ctx)).toEqual([{ act: "switch", id: "bram" }]);
  });

  it("LONG on the ground names the room AND sends the partner there", () => {
    expect(dwellInteraction(ground(), "long", ctx)).toEqual([
      { act: "room", x: 5, y: 6 },
      { act: "sendTo", cid: "mara", x: 5, y: 6 },
    ]);
  });

  it("keeps the out-of-conversation effect FIRST, so a conversation only ADDS", () => {
    // The invariant behind both cells above: whatever a hover does on its own, it
    // still does while talking to someone.
    for (const [t, phase] of [[object("well_1"), "short"], [ground(), "long"]] as const) {
      const solo = dwellInteraction(t, phase, alone);
      const during = dwellInteraction(t, phase, ctx);
      expect(during.slice(0, solo.length)).toEqual(solo);
      expect(during.length).toBeGreaterThan(solo.length);
    }
  });

  it("looking at the PARTNER is attention, not an instruction", () => {
    // Otherwise the act of listening to someone would keep re-commanding them.
    expect(dwellInteraction(creature("mara"), "short", ctx)).toEqual([]);
    expect(dwellInteraction(creature("mara"), "long", ctx)).toEqual([]);
  });
});

describe("the invariants that make the rules consistent", () => {
  const PHASES: DwellPhase[] = ["short", "long"];

  it("never acts on nothing", () => {
    for (const p of PHASES) {
      expect(dwellInteraction(null, p, alone)).toEqual([]);
      expect(dwellInteraction(null, p, talkingTo("mara"))).toEqual([]);
    }
  });

  it("never acts on a creature or object with no identity", () => {
    for (const p of PHASES) {
      expect(dwellInteraction({ kind: "creature", x: 0, y: 0 }, p, alone)).toEqual([]);
      expect(dwellInteraction({ kind: "object", x: 0, y: 0 }, p, alone)).toEqual([]);
    }
  });

  it("ALWAYS acts on the hovered thing and never on another", () => {
    // The whole law in one assertion: whatever comes back names the thing the
    // spark was over. Nothing may substitute a neighbour, a nearest candidate,
    // or anyone else.
    for (const p of PHASES) {
      for (const ctx of [alone, talkingTo("mara")]) {
        for (const t of [creature("bram"), object("chest_1")]) {
          for (const a of dwellInteraction(t, p, ctx)) {
            if ("id" in a) expect(a.id).toBe(t.id);
          }
        }
      }
    }
  });

  it("addresses instructions to the PARTNER, never to the thing hovered", () => {
    for (const t of [object("well_1"), creature("bram")]) {
      const directed = dwellInteraction(t, "short", talkingTo("mara")).filter((a) => "cid" in a);
      expect(directed.length).toBeGreaterThan(0);
      for (const a of directed) expect("cid" in a ? a.cid : null).toBe("mara");
    }
  });

  it("has no leave-by-looking-away action anywhere in the table", () => {
    // Looking away is now an INSTRUCTION (ground ⇒ go there, object ⇒ go use
    // that), so it cannot also mean "end this". A conversation ends on its own
    // inactivity timeout, or when a different one begins (`switch`).
    const acts: string[] = [];
    for (const p of PHASES) {
      for (const ctx of [alone, talkingTo("mara")]) {
        for (const t of [creature("bram"), creature("mara"), object("chest_1"), ground()]) {
          for (const a of dwellInteraction(t, p, ctx)) acts.push(a.act);
        }
      }
    }
    expect(acts).not.toContain("leave");
    expect(acts.length).toBeGreaterThan(0);
  });

  it("is pure — the same hover answers the same way every time", () => {
    const t = object("chest_1");
    expect(dwellInteraction(t, "short", alone)).toEqual(dwellInteraction(t, "short", alone));
  });
});

describe("build mode (⑦ — the ground answers the build word)", () => {
  const onSpot = { conversingWith: null, building: true, buildSpot: "lot:12" };
  const offSpot = { conversingWith: null, building: true, buildSpot: null };

  it("LONG on a lit spot chooses it — the spark is over the GROUND", () => {
    // Walls and floors are ground: the point the pick lands on is inside the
    // footprint, and the spot resolved from it is what a settled look means.
    expect(dwellInteraction(ground(), "long", onSpot)).toEqual([{ act: "buildSpot", id: "lot:12" }]);
  });

  it("LONG off every spot LETS THE CHOSEN ONE GO — open ground is an answer", () => {
    expect(dwellInteraction(ground(), "long", offSpot)).toEqual([{ act: "buildSpot", id: null }]);
  });

  it("leaves the SHORT glance alone — a fixture still names itself", () => {
    expect(dwellInteraction(object("chest_1"), "short", onSpot)).toEqual([
      { act: "menu", id: "chest_1" },
    ]);
  });

  it("NEVER turns a thing into a place — the hovered object stays the target", () => {
    // THE FLICKER BUG. Build mode used to claim every non-creature hover, so a
    // chest standing on a lit plot answered BOTH cells: the short rest opened
    // its board, the long rest selected the plot under it — and since each of
    // those releases the other, the board flipped between the two for as long
    // as the player looked. One hover, one rule.
    expect(dwellInteraction(object("chest_1"), "long", onSpot)).toEqual([]);
    const acts = [
      ...dwellInteraction(object("chest_1"), "short", onSpot),
      ...dwellInteraction(object("chest_1"), "long", onSpot),
    ];
    expect(acts.map((a) => a.act)).toEqual(["menu"]);
  });

  it("never turns a PERSON into a spot", () => {
    // Someone standing on a plot is still someone.
    expect(dwellInteraction(creature("mara"), "long", onSpot)).toEqual([{ act: "talk", id: "mara" }]);
  });

  it("means nothing extra with the build word DOWN", () => {
    expect(
      dwellInteraction(ground(), "long", { conversingWith: null, buildSpot: "lot:12" }),
    ).toEqual([{ act: "room", x: 5, y: 6 }]);
    expect(dwellInteraction(ground(), "long", alone)).toEqual([{ act: "room", x: 5, y: 6 }]);
  });

  it("outranks the send-partner instruction while a conversation runs", () => {
    // The build word is a mode the player entered on purpose; inside it a
    // settled look at a plot is about the plot, not about where a partner goes.
    expect(
      dwellInteraction(ground(), "long", {
        conversingWith: "mara", building: true, buildSpot: "bld:h_3",
      }),
    ).toEqual([{ act: "buildSpot", id: "bld:h_3" }]);
  });

  it("ONE CHANNEL: no hover ever answers as both a thing and a place", () => {
    // The invariant behind the fix — whatever else changes about build mode,
    // a single hover must never produce a spot act AND a thing act, in any
    // phase, with or without a conversation running. That is what made two
    // selections chase each other around the board.
    for (const t of [creature("mara"), object("chest_1"), ground()]) {
      for (const p of ["short", "long"] as const) {
        for (const partner of [null, "bram"]) {
          const acts = dwellInteraction(t, p, {
            conversingWith: partner,
            building: true,
            buildSpot: "bld:h_3",
          });
          const place = acts.filter((a) => a.act === "buildSpot").length;
          const thing = acts.filter((a) => a.act !== "buildSpot").length;
          expect(Math.min(place, thing)).toBe(0);
        }
      }
    }
  });
});
