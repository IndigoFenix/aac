// The hover table (dwell-interaction.ts): what the spark resting on a thing
// MEANS. Pure, so every cell is provable — which is the point of moving the rule
// out of the frame loop, where five competing dwells each read the gaze their
// own way and none of it could be tested.

import { describe, it, expect } from "@jest/globals";
import {
  dwellInteraction,
  type DwellContext,
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

describe("player membership (§3f) — the roster reinterprets the gaze law", () => {
  // A conversation is not a pair any more. The same long rest means three
  // different things depending on which side of the roster the person stands on:
  // JOIN theirs, ADDRESS a fellow member, or SWITCH to an outsider.

  describe("JOIN — long-dwelling someone who is already talking", () => {
    it("marks the talk act so the host opens THEIR conversation, not a rival one", () => {
      expect(
        dwellInteraction(creature("mara"), "long", { conversingWith: null, targetInConversation: true }),
      ).toEqual([{ act: "talk", id: "mara", join: true }]);
    });

    it("omits the discriminant entirely when they are talking to nobody", () => {
      // Not `join: false` — the KEY is absent, so an old caller's object is
      // reproduced byte for byte (toStrictEqual would catch `join: undefined`).
      const [act] = dwellInteraction(creature("mara"), "long", { conversingWith: null });
      expect(act).toStrictEqual({ act: "talk", id: "mara" });
      expect("join" in act!).toBe(false);
    });

    it("still needs a LONG rest — joining is as much a commitment as opening one", () => {
      expect(
        dwellInteraction(creature("mara"), "short", { conversingWith: null, targetInConversation: true }),
      ).toEqual([]);
    });

    it("rides a SWITCH too — leaving my circle for someone standing in another", () => {
      expect(
        dwellInteraction(creature("bram"), "long", {
          conversingWith: "mara",
          members: ["player", "mara"],
          targetInConversation: true,
        }),
      ).toEqual([{ act: "switch", id: "bram", join: true }]);
    });
  });

  describe("ADDRESS — a look at a FELLOW member picks whom I am speaking to", () => {
    const circle: DwellContext = {
      conversingWith: "mara",
      members: ["player", "mara", "bram", "ida"],
    };

    it("a SHORT settle on a fellow member addresses them", () => {
      expect(dwellInteraction(creature("bram"), "short", circle)).toEqual([
        { act: "address", id: "bram" },
      ]);
    });

    it("NEVER hands the conversation over to someone already in it", () => {
      // `switch` means "take them from their partner" — inside one circle there
      // is nobody to take them from, and tearing a member out to re-seat them
      // would dissolve the conversation the look was performed inside.
      expect(dwellInteraction(creature("bram"), "long", circle)).toEqual([
        { act: "address", id: "bram" },
      ]);
    });

    it("NEVER commands anybody ABOUT a fellow member", () => {
      // Out of a roster this same glance says "partner, go attend them". Inside
      // one it would send my addressee across the circle to reach someone
      // standing in it — the look already says everything it needs to.
      const acts = [
        ...dwellInteraction(creature("bram"), "short", circle),
        ...dwellInteraction(creature("bram"), "long", circle),
      ];
      expect(acts.map((a) => a.act)).toEqual(["address", "address"]);
    });

    it("says NOTHING about the member I am already addressing", () => {
      const ctx = { ...circle, currentAddressee: "bram" };
      expect(dwellInteraction(creature("bram"), "short", ctx)).toEqual([]);
      expect(dwellInteraction(creature("bram"), "long", ctx)).toEqual([]);
      // …and the rest of the circle is still selectable.
      expect(dwellInteraction(creature("ida"), "short", ctx)).toEqual([{ act: "address", id: "ida" }]);
    });

    it("says NOTHING about the creature whose board I face", () => {
      expect(dwellInteraction(creature("mara"), "short", circle)).toEqual([]);
      expect(dwellInteraction(creature("mara"), "long", circle)).toEqual([]);
    });

    it("addresses a member even with no board up — the ROSTER makes them a fellow", () => {
      expect(
        dwellInteraction(creature("bram"), "long", { conversingWith: null, members: ["player", "bram"] }),
      ).toEqual([{ act: "address", id: "bram" }]);
    });
  });

  describe("OUTSIDERS keep the dyadic cells", () => {
    const circle: DwellContext = {
      conversingWith: "mara",
      members: ["player", "mara", "bram"],
    };

    it("a glance points my partner at them; a long rest hands the conversation over", () => {
      expect(dwellInteraction(creature("stranger"), "short", circle)).toEqual([
        { act: "attendCreature", cid: "mara", id: "stranger" },
      ]);
      expect(dwellInteraction(creature("stranger"), "long", circle)).toEqual([
        { act: "switch", id: "stranger" },
      ]);
    });

    it("a roster NEVER silences an outsider the addressee stack happens to name", () => {
      // `currentAddressee` can come back from the host's addressee stack holding
      // a nearest body or a family chip who is in no conversation at all. That
      // must not delete the outsider cells.
      const ctx = { ...circle, currentAddressee: "stranger" };
      expect(dwellInteraction(creature("stranger"), "short", ctx)).toEqual([
        { act: "attendCreature", cid: "mara", id: "stranger" },
      ]);
      expect(dwellInteraction(creature("stranger"), "long", ctx)).toEqual([
        { act: "switch", id: "stranger" },
      ]);
    });

    it("objects and ground read the same inside a roster as out of one", () => {
      // Membership is about PEOPLE. Nothing about a roster changes what a chest
      // or a patch of floor means.
      expect(dwellInteraction(object("chest_1"), "short", circle)).toEqual(
        dwellInteraction(object("chest_1"), "short", talkingTo("mara")),
      );
      expect(dwellInteraction(ground(), "long", circle)).toEqual(
        dwellInteraction(ground(), "long", talkingTo("mara")),
      );
    });
  });

  describe("ABSENT FIELDS ARE THE OLD TABLE, byte for byte", () => {
    // The whole backward-compatibility contract in one place: a caller that
    // knows nothing about rosters gets exactly what it got before — same acts,
    // same key sets (toStrictEqual, so a stray `join: undefined` fails).
    const cells: [HoverTarget, DwellPhase, DwellContext, unknown[]][] = [
      [object("chest_1"), "short", alone, [{ act: "menu", id: "chest_1" }]],
      [object("chest_1"), "long", alone, []],
      [creature("mara"), "long", alone, [{ act: "talk", id: "mara" }]],
      [creature("mara"), "short", alone, []],
      [ground(), "long", alone, [{ act: "room", x: 5, y: 6 }]],
      [ground(), "short", alone, []],
      [
        object("well_1"),
        "short",
        talkingTo("mara"),
        [
          { act: "menu", id: "well_1" },
          { act: "attendObject", cid: "mara", id: "well_1" },
        ],
      ],
      [creature("bram"), "short", talkingTo("mara"), [{ act: "attendCreature", cid: "mara", id: "bram" }]],
      [creature("bram"), "long", talkingTo("mara"), [{ act: "switch", id: "bram" }]],
      [creature("mara"), "short", talkingTo("mara"), []],
      [creature("mara"), "long", talkingTo("mara"), []],
      [
        ground(),
        "long",
        talkingTo("mara"),
        [
          { act: "room", x: 5, y: 6 },
          { act: "sendTo", cid: "mara", x: 5, y: 6 },
        ],
      ],
    ];

    it.each(cells)("%s / %s answers exactly as it did before rosters", (t, phase, ctx, expected) => {
      expect(dwellInteraction(t, phase, ctx)).toStrictEqual(expected);
    });

    it("never emits an ADDRESS act without a roster", () => {
      const acts: string[] = [];
      for (const p of ["short", "long"] as const) {
        for (const ctx of [alone, talkingTo("mara"), { conversingWith: "mara", currentAddressee: "bram" }]) {
          for (const t of [creature("bram"), creature("mara"), object("chest_1"), ground()]) {
            for (const a of dwellInteraction(t, p, ctx)) acts.push(a.act);
          }
        }
      }
      expect(acts).not.toContain("address");
      expect(acts.length).toBeGreaterThan(0);
    });

    it("an EMPTY roster is no roster — nobody is a fellow member of nothing", () => {
      const ctx = { conversingWith: "mara", members: [] as string[] };
      expect(dwellInteraction(creature("bram"), "short", ctx)).toStrictEqual([
        { act: "attendCreature", cid: "mara", id: "bram" },
      ]);
      expect(dwellInteraction(creature("bram"), "long", ctx)).toStrictEqual([{ act: "switch", id: "bram" }]);
    });
  });

  it("still acts ONLY on the hovered body, whatever the roster says", () => {
    const circle: DwellContext = {
      conversingWith: "mara",
      members: ["player", "mara", "bram"],
      targetInConversation: true,
      currentAddressee: "ida",
    };
    for (const p of ["short", "long"] as const) {
      for (const t of [creature("bram"), creature("stranger"), object("chest_1")]) {
        for (const a of dwellInteraction(t, p, circle)) {
          if ("id" in a) expect(a.id).toBe(t.id);
        }
      }
    }
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
