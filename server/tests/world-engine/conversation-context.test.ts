// What a conversation REMEMBERS: sequencing, who spoke, who was addressed, and
// the "what are we talking about" slots a later pronoun will point at.
// Pure — no world, no host. multi-entity-conversations.md §3a.

import { describe, it, expect } from "@jest/globals";
import {
  createConversation,
  joinConversation,
  recordUtterance,
  markRevealed,
  memberOf,
  type ConversationState,
} from "@shared/world-engine/interaction/dialogue/conversation.js";
import type { DialogueAct } from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";

const act = (over: Partial<DialogueAct> = {}): DialogueAct => ({ kind: "how-are-you", glyph: "hi", ...over });

/** Ann, Ben and Cal in one circle. */
const circle = (): ConversationState => {
  const c = createConversation("c", 0);
  joinConversation(c, "ann", 0, "c");
  joinConversation(c, "ben", 1, "b");
  joinConversation(c, "cal", 2, "a");
  return c;
};

describe("recordUtterance — sequencing", () => {
  it("assigns seq from the conversation, not the caller", () => {
    const c = circle();
    const first = recordUtterance(c, { tick: 1, speakerId: "ann", act: act() });
    const second = recordUtterance(c, { tick: 2, speakerId: "ben", act: act() });
    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
    expect(c.nextSeq).toBe(2);
  });

  it("appends most-recent-LAST and returns the stored row", () => {
    const c = circle();
    recordUtterance(c, { tick: 1, speakerId: "ann", act: act() });
    const last = recordUtterance(c, { tick: 2, speakerId: "ben", act: act() });
    expect(c.history.map((u) => u.speakerId)).toEqual(["ann", "ben"]);
    expect(c.history[c.history.length - 1]).toEqual(last);
  });

  it("bumps lastActivityTick to the utterance tick", () => {
    const c = circle();
    recordUtterance(c, { tick: 17, speakerId: "ann", act: act() });
    expect(c.lastActivityTick).toBe(17);
  });
});

describe("recordUtterance — who spoke and who was spoken to", () => {
  it("stamps the speaker's lastSpokeTick", () => {
    const c = circle();
    recordUtterance(c, { tick: 5, speakerId: "ann", act: act() });
    expect(memberOf(c, "ann")!.lastSpokeTick).toBe(5);
    expect(memberOf(c, "ben")!.lastSpokeTick).toBeUndefined();
  });

  it("stamps every addressee's lastAddressedTick, and only theirs", () => {
    const c = circle();
    recordUtterance(c, { tick: 5, speakerId: "ann", addresseeIds: ["ben", "cal"], act: act() });
    expect(memberOf(c, "ben")!.lastAddressedTick).toBe(5);
    expect(memberOf(c, "cal")!.lastAddressedTick).toBe(5);
    expect(memberOf(c, "ann")!.lastAddressedTick).toBeUndefined();
  });

  // ABSENT addressee = spoken to the FLOOR: nobody owes an answer, so nobody's
  // addressed clock moves. (Arbitration reads that as a weaker urge for all.)
  it("a floor utterance addresses nobody", () => {
    const c = circle();
    recordUtterance(c, { tick: 5, speakerId: "ann", act: act() });
    expect(c.history[0]!.addresseeIds).toBeUndefined();
    for (const m of c.members) expect(m.lastAddressedTick).toBeUndefined();
  });

  it("an EMPTY addressee list is normalized to the floor", () => {
    const c = circle();
    const u = recordUtterance(c, { tick: 5, speakerId: "ann", addresseeIds: [], act: act() });
    expect(u.addresseeIds).toBeUndefined();
    expect(c.history[0]!.addresseeIds).toBeUndefined();
  });

  it("copies the addressee list — a caller's array is not aliased into history", () => {
    const c = circle();
    const list = ["ben"];
    recordUtterance(c, { tick: 5, speakerId: "ann", addresseeIds: list, act: act() });
    list.push("cal");
    expect(c.history[0]!.addresseeIds).toEqual(["ben"]);
  });

  // The world may shout into a circle; that is history, not enrollment.
  it("records a non-member speaker without enrolling them", () => {
    const c = circle();
    recordUtterance(c, { tick: 5, speakerId: "ghost", addresseeIds: ["nobody"], act: act() });
    expect(c.history[0]!.speakerId).toBe("ghost");
    expect(memberOf(c, "ghost")).toBeUndefined();
    expect(c.members).toHaveLength(3);
  });

  it("later utterances overwrite the earlier stamps", () => {
    const c = circle();
    recordUtterance(c, { tick: 5, speakerId: "ann", addresseeIds: ["ben"], act: act() });
    recordUtterance(c, { tick: 9, speakerId: "ann", addresseeIds: ["cal"], act: act() });
    expect(memberOf(c, "ann")!.lastSpokeTick).toBe(9);
    expect(memberOf(c, "ben")!.lastAddressedTick).toBe(5);
    expect(memberOf(c, "cal")!.lastAddressedTick).toBe(9);
  });
});

describe("context — what we are talking about", () => {
  it("starts empty", () => {
    expect(circle().context).toEqual({});
  });

  it("a request names the ITEM", () => {
    const c = circle();
    recordUtterance(c, { tick: 1, speakerId: "ann", act: act({ kind: "request", itemId: "cookie1" }) });
    expect(c.context.lastMentionedItem).toBe("cookie1");
  });

  it("an offer names the ITEM", () => {
    const c = circle();
    recordUtterance(c, { tick: 1, speakerId: "ann", act: act({ kind: "offer", itemId: "sock1" }) });
    expect(c.context.lastMentionedItem).toBe("sock1");
  });

  it("a where-is names the ITEM", () => {
    const c = circle();
    recordUtterance(c, { tick: 1, speakerId: "ann", act: act({ kind: "where-is", itemId: "hat1" }) });
    expect(c.context.lastMentionedItem).toBe("hat1");
  });

  it("the most recent mention wins", () => {
    const c = circle();
    recordUtterance(c, { tick: 1, speakerId: "ann", act: act({ kind: "request", itemId: "cookie1" }) });
    recordUtterance(c, { tick: 2, speakerId: "ben", act: act({ kind: "offer", itemId: "sock1" }) });
    expect(c.context.lastMentionedItem).toBe("sock1");
  });

  it("an act naming nothing leaves the slots alone", () => {
    const c = circle();
    recordUtterance(c, { tick: 1, speakerId: "ann", act: act({ kind: "request", itemId: "cookie1" }) });
    recordUtterance(c, { tick: 2, speakerId: "ben", act: act({ kind: "bye", glyph: "goodbye" }) });
    expect(c.context.lastMentionedItem).toBe("cookie1");
  });

  it("ask-directions names the PLACE subject", () => {
    const c = circle();
    recordUtterance(c, {
      tick: 1,
      speakerId: "ann",
      act: act({ kind: "ask-directions", subjectId: "home_blue" }),
    });
    expect(c.context.lastMentionedPlace).toBe("home_blue");
    expect(c.context.lastMentionedItem).toBeUndefined();
  });

  it("directions-pick names the PLACE subject", () => {
    const c = circle();
    recordUtterance(c, {
      tick: 1,
      speakerId: "ann",
      act: act({ kind: "directions-pick", subjectId: "market" }),
    });
    expect(c.context.lastMentionedPlace).toBe("market");
  });

  // A where-is answered from a SOURCE ("where do I get food?") carries both.
  it("a source where-is names the item AND the place", () => {
    const c = circle();
    recordUtterance(c, {
      tick: 1,
      speakerId: "ann",
      act: act({ kind: "where-is", itemId: "food1", subjectId: "market", source: true }),
    });
    expect(c.context).toMatchObject({ lastMentionedItem: "food1", lastMentionedPlace: "market" });
  });

  it("what-doing names the resolved CREATURE", () => {
    const c = circle();
    recordUtterance(c, {
      tick: 1,
      speakerId: "ann",
      act: act({ kind: "what-doing", about: { symbol: "dog", id: "dog1" } }),
    });
    expect(c.context.lastMentionedCreature).toBe("dog1");
  });

  // "There is no dog" — an unresolved `about` mentions nobody.
  it("an unresolved about mentions no creature", () => {
    const c = circle();
    recordUtterance(c, { tick: 1, speakerId: "ann", act: act({ kind: "what-doing", about: { symbol: "dog" } }) });
    expect(c.context.lastMentionedCreature).toBeUndefined();
  });

  it("ask-fact about a creature's condition names the CREATURE", () => {
    const c = circle();
    recordUtterance(c, {
      tick: 1,
      speakerId: "ann",
      act: act({ kind: "ask-fact", query: { kind: "condition", creature: "mara" } }),
    });
    expect(c.context.lastMentionedCreature).toBe("mara");
  });

  it("ask-fact about an item's whereabouts names the ITEM", () => {
    const c = circle();
    recordUtterance(c, {
      tick: 1,
      speakerId: "ann",
      act: act({ kind: "ask-fact", query: { kind: "whoHas", item: "cookie1" } }),
    });
    expect(c.context.lastMentionedItem).toBe("cookie1");
  });

  it("a value SEARCH query names no subject", () => {
    const c = circle();
    recordUtterance(c, {
      tick: 1,
      speakerId: "ann",
      act: act({ kind: "ask-fact", query: { kind: "conditionSearch", condition: "hungry" } }),
    });
    expect(c.context).toEqual({});
  });

  it("tell-fact of a presence names the CREATURE and the PLACE", () => {
    const c = circle();
    recordUtterance(c, {
      tick: 1,
      speakerId: "ann",
      act: act({ kind: "tell-fact", fact: { kind: "presence", creature: "mara", place: "market" } }),
    });
    expect(c.context).toMatchObject({ lastMentionedCreature: "mara", lastMentionedPlace: "market" });
  });

  it("tell-fact of a want names both the CREATURE and the ITEM", () => {
    const c = circle();
    recordUtterance(c, {
      tick: 1,
      speakerId: "ann",
      act: act({ kind: "tell-fact", fact: { kind: "want", creature: "mara", item: "cookie1" } }),
    });
    expect(c.context).toMatchObject({ lastMentionedCreature: "mara", lastMentionedItem: "cookie1" });
  });

  it("tell-fact of an item state names the ITEM", () => {
    const c = circle();
    recordUtterance(c, {
      tick: 1,
      speakerId: "ann",
      act: act({ kind: "tell-fact", fact: { kind: "itemState", item: "apple1", axis: "temperature", state: "hot" } }),
    });
    expect(c.context.lastMentionedItem).toBe("apple1");
  });

  it("survives history eviction — context is not a view over the ring", () => {
    const c = circle();
    recordUtterance(c, { tick: 0, speakerId: "ann", act: act({ kind: "request", itemId: "cookie1" }) });
    for (let i = 1; i <= 20; i++) {
      recordUtterance(c, { tick: i, speakerId: "ben", act: act({ kind: "bye", glyph: "goodbye" }) });
    }
    expect(c.history.some((u) => u.act.itemId === "cookie1")).toBe(false);
    expect(c.context.lastMentionedItem).toBe("cookie1");
  });
});

describe("markRevealed — spoken aloud, everyone present heard", () => {
  it("is off until said", () => {
    const c = circle();
    expect(c.revealed.ann).toBeUndefined();
  });

  // A hidden need coaxed out by ONE member's small talk is out for the whole
  // circle — the other members do not each have to ask again.
  it("marks the creature for the whole conversation, not the asker", () => {
    const c = circle();
    markRevealed(c, "ann");
    expect(c.revealed).toEqual({ ann: true });
  });

  it("is idempotent and independent per creature", () => {
    const c = circle();
    markRevealed(c, "ann");
    markRevealed(c, "ann");
    markRevealed(c, "ben");
    expect(c.revealed).toEqual({ ann: true, ben: true });
  });

  // A how-are-you is the QUESTION; the reveal is the ANSWER, which is not a
  // DialogueAct — so asking must not by itself mark anything revealed.
  it("asking how-are-you does not reveal anything on its own", () => {
    const c = circle();
    recordUtterance(c, { tick: 1, speakerId: "ann", addresseeIds: ["ben"], act: act({ kind: "how-are-you" }) });
    expect(c.revealed).toEqual({});
  });
});
