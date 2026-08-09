// THE BUBBLE GATE — `bubbleAnchorDraws` (bubble-visibility.ts) is the ONE rule
// deciding whether a live bubble may be drawn, and `render3d.ts` syncBubbles is
// its only caller. Before it existed GL drew every bubble in `state.bubbles`
// over a `depthTest:false` sprite, so a line spoken inside a sealed house across
// town rendered over the roofs as a disembodied voice — the standing finding
// text-mode.md §3 recorded against GL, and the "I will carry the door" ghost the
// dollhouse degeneration pass chased.
//
// Pure predicate, pure tests: plain anchors and a plain reveal set, no GL, no
// WorldState, no boot. The VISUAL itself cannot be asserted here (jsdom has no
// pixels) — the ledger records this batch as NOT GL-verified.

import { describe, it, expect } from "@jest/globals";
import {
  EXEMPT_ANCHOR_R,
  bubbleAnchorDraws,
  exemptSpeakers,
  isExemptAnchor,
  type BubbleViewpoint,
} from "@shared/world-engine/bubble-visibility.js";

/** The town: the focus house (revealed by the dollhouse cutaway), the sealed
 *  house across town, and the street (no building at all). */
const FOCUS = "house-focus";
const SEALED = "house-far";

function viewpoint(over: Partial<BubbleViewpoint> = {}): BubbleViewpoint {
  return {
    subjectSpace: FOCUS,
    revealed: new Set([FOCUS]),
    ...over,
  };
}

/** A point-anchored line (what `sayNpcLine` writes for most creature speech). */
function at(x: number, y: number, space: string | null) {
  return { x, y, space };
}

/** An avatar-anchored line (the networked "say" path, `setAvatarSpeech`). */
function byBody(id: string, x: number, y: number, space: string | null) {
  return { x, y, bodyId: id, space };
}

describe("bubbleAnchorDraws — the visibility clauses", () => {
  it("SEALS a bubble inside an unrevealed building (the through-walls voice)", () => {
    expect(bubbleAnchorDraws(at(90, 90, SEALED), viewpoint())).toBe(false);
    expect(bubbleAnchorDraws(byBody("mara", 90, 90, SEALED), viewpoint())).toBe(false);
  });

  it("DRAWS a bubble inside a REVEALED interior (the dollhouse focus family)", () => {
    expect(bubbleAnchorDraws(at(3, 3, FOCUS), viewpoint())).toBe(true);
  });

  it("DRAWS an OUTDOOR bubble whatever space the camera's subject is in", () => {
    // GL's own body cull never hides an outdoor body, and the bubble must agree
    // with the body: a family member who steps into the street keeps speaking.
    expect(bubbleAnchorDraws(at(40, 40, null), viewpoint({ subjectSpace: FOCUS }))).toBe(true);
    expect(bubbleAnchorDraws(at(40, 40, null), viewpoint({ subjectSpace: null }))).toBe(true);
  });

  it("DRAWS whoever shares the camera subject's own room, even with NOTHING revealed", () => {
    // Interior reveal OFF (the spirit GROUND rung) reveals no interiors at all;
    // you can still hear the person standing beside you.
    const dark = viewpoint({ subjectSpace: SEALED, revealed: new Set<string>() });
    expect(bubbleAnchorDraws(at(90, 90, SEALED), dark)).toBe(true);
    expect(bubbleAnchorDraws(at(3, 3, FOCUS), dark)).toBe(false);
  });

  it("keeps the reveal set authoritative — a revealed room speaks from anywhere", () => {
    // Doorway flood-through: `revealedInteriors` already put the next room in
    // the set, so its people are audible without any extra rule here.
    const v = viewpoint({ subjectSpace: FOCUS, revealed: new Set([FOCUS, "house-next-door"]) });
    expect(bubbleAnchorDraws(at(20, 4, "house-next-door"), v)).toBe(true);
  });
});

describe("bubbleAnchorDraws — the conversation exemption", () => {
  const inSealedHouse = { id: "ada", x: 90, y: 90 };

  it("DRAWS a member of the player's own conversation inside a sealed house", () => {
    const v = viewpoint({ exempt: [{ id: "me", x: 3, y: 3 }, inSealedHouse] });
    expect(bubbleAnchorDraws(byBody("ada", 90, 90, SEALED), v)).toBe(true);
    // …and the same line as the host actually writes it: a POINT at her feet.
    expect(bubbleAnchorDraws(at(90, 90, SEALED), v)).toBe(true);
  });

  it("attributes a POINT anchor only within EXEMPT_ANCHOR_R of the member", () => {
    const v = viewpoint({ exempt: [inSealedHouse] });
    const justInside = EXEMPT_ANCHOR_R - 0.01;
    const justOutside = EXEMPT_ANCHOR_R + 0.01;
    expect(bubbleAnchorDraws(at(90 + justInside, 90, SEALED), v)).toBe(true);
    expect(bubbleAnchorDraws(at(90 + justOutside, 90, SEALED), v)).toBe(false);
  });

  it("never exempts a NEIGHBOUR just for standing next to a member", () => {
    // An avatar anchor names its speaker outright — proximity may not promote a
    // bystander in the same sealed room into the player's conversation.
    const v = viewpoint({ exempt: [inSealedHouse] });
    expect(bubbleAnchorDraws(byBody("bram", 90.5, 90, SEALED), v)).toBe(false);
  });

  it("exempts nothing when the roster is empty", () => {
    expect(isExemptAnchor(at(90, 90, SEALED), [])).toBe(false);
    expect(isExemptAnchor(at(90, 90, SEALED), undefined)).toBe(false);
  });
});

describe("exemptSpeakers — whose lines are never gated", () => {
  const bodies: Record<string, { x: number; y: number }> = {
    me: { x: 3, y: 3 },
    claimed: { x: 50, y: 50 },
    ada: { x: 90, y: 90 },
    bram: { x: 92, y: 90 },
  };
  const bodyAt = (id: string) => bodies[id];

  it("is the viewer's own body when nothing is claimed and nobody is talking", () => {
    expect(exemptSpeakers({ localId: "me", drivenId: "me", bodyAt })).toEqual([
      { id: "me", x: 3, y: 3 },
    ]);
  });

  it("keeps the DRIVEN body's own bubble (a follow/town camera on a claimed body)", () => {
    const got = exemptSpeakers({ localId: "me", drivenId: "claimed", bodyAt });
    expect(got.map((b) => b.id)).toEqual(["me", "claimed"]);
  });

  it("exempts the whole roster of the PLAYER'S OWN conversation", () => {
    const got = exemptSpeakers({
      localId: "me",
      drivenId: "me",
      conversation: { members: ["me", "ada"] },
      bodyAt,
    });
    expect(got.map((b) => b.id)).toEqual(["me", "ada"]);
  });

  it("recognises the conversation through the DRIVEN body's id", () => {
    // quest-host publishes the player as `world.drivenBody()`, not as localId.
    const got = exemptSpeakers({
      localId: "me",
      drivenId: "claimed",
      conversation: { members: ["claimed", "ada"] },
      bodyAt,
    });
    expect(got.map((b) => b.id)).toEqual(["me", "claimed", "ada"]);
  });

  it("exempts NOTHING extra for an ambient town circle", () => {
    // The camera dollies to townsfolk chatter too (RenderIntent.conversation is
    // published for any circle) — being FRAMED is not being IN it, or the
    // through-walls voice would walk straight back in through the exemption.
    const got = exemptSpeakers({
      localId: "me",
      drivenId: "me",
      conversation: { members: ["ada", "bram"] },
      bodyAt,
    });
    expect(got.map((b) => b.id)).toEqual(["me"]);
    expect(bubbleAnchorDraws(byBody("ada", 90, 90, SEALED), viewpoint({ exempt: got }))).toBe(false);
  });

  it("drops members with no body, and never repeats one", () => {
    const got = exemptSpeakers({
      localId: "me",
      drivenId: "me",
      conversation: { members: ["me", "ada", "streamed-out"] },
      bodyAt,
    });
    expect(got.map((b) => b.id)).toEqual(["me", "ada"]);
  });
});
