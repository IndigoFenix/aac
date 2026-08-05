/**
 * CONVERSATION IN MOTION ⑫③ — THE DYAD EXEMPTION, THE DURABLE ADDRESS, AND THE
 * CHANNEL ORDER.
 *
 * Three laws, in the order the engine asks them:
 *
 *   ④ A CONVERSATION OF TWO NEEDS NO ADDRESSING AT ALL. `soleOther` states it in
 *     one predicate, and every addressing rule asks it FIRST: with exactly one
 *     other person there is nothing to disambiguate, so no channel is needed and
 *     none is charged. Every other rule in the chapter is a rule about the THIRD
 *     person.
 *
 *   5 (conversation.ts) AN ADDRESS IS DURABLE AND NEVER DANGLES. `addressing` is
 *     a fact on the roster row, not something re-derived from which way a body
 *     is pointed — and `leaveConversation` clears every pointer at a departing
 *     member, while `addressingOf` re-checks membership on every read.
 *
 *   ② ADDRESSING IS A CHANNEL. `memberAddressee` is the channel ORDER, and it is
 *     NULLABLE: dyad → the heading is spoken for ⇒ null → `addressing` → the
 *     local gaze echo → null. 🚨 The faced creature is no longer the bottom
 *     rung: THE BOARD'S AIM IS NOT THE SENTENCE'S ADDRESSEE. `facedBy` keeps the
 *     board and the wire key and always answers somebody; a SENTENCE may be said
 *     to nobody, which the record reads as the floor.
 *
 * The host half is a MIRROR test — `quest-host.ts` cannot be value-imported here
 * (its import chain reaches JSX, which this jest project does not compile), so
 * each rung is pinned by re-stating the host's OWN expression, copied and
 * labelled with the function it copies. Same discipline as
 * `conversation-groups.test.ts` and `conversation-host-membership.test.ts`.
 *
 * DB-free / GL-free — runs in `npm run test:engine`.
 */
import { describe, it, expect } from "@jest/globals";
import {
  addressingOf,
  createConversation,
  joinConversation,
  leaveConversation,
  memberOf,
  soleOther,
  type ConversationState,
} from "@shared/world-engine/interaction/dialogue/conversation.js";
import { LOCAL_PLAYER_CID, isPlayerCid, playerCidOf } from "@shared/world-engine/interaction/quest/player-identity.js";
// ⑫④ — the address rides the OWNER→FOLLOWER sync, so the wire half is driven
// through the real net module rather than mirrored.
import { applyInbound, convoMessage } from "@shared/world-engine/net.js";
import { createWorldState } from "@shared/world-engine/engine.js";
import type { WorldSpec } from "@shared/world-engine/types.js";

const ADA = "resident_0_0";
const BEN = "resident_0_1";
const CAL = "resident_1_0";
const DOT = "resident_1_1";
const PEER = playerCidOf("person-ben", "person-ann");

/** The smallest world a `convoSync` row can be parked on — this file needs a
 *  `WorldState` only as the place `applyInbound` writes to. */
const WIRE_SPEC: WorldSpec = {
  engine: "world",
  engineVersion: 1,
  meta: { title: "t", locale: "en", theme: "t" },
  manifold: { kind: "flat", width: 40, height: 40 },
  terrain: { kind: "flat" },
  spawns: [{ id: "s", x: 5, y: 5 }],
  objects: [],
  multiplayer: { maxPlayers: 4, authority: "distributed" },
  content: { kind: "sandbox" },
};

/** A roster, joined in the order given, one tick apart so `(joinedTick, id)` is
 *  unambiguous and the deterministic order is the JOIN order. */
function roster(...ids: string[]): ConversationState {
  const c = createConversation("convo_1", 0);
  ids.forEach((id, i) => joinConversation(c, id, i, "b"));
  return c;
}

// ---------------------------------------------------------------------------
// LAW ④ — THE DYAD EXEMPTION
// ---------------------------------------------------------------------------

describe("soleOther — law ④ in one predicate", () => {
  it("a pair answers with the OTHER one, from either side", () => {
    const c = roster(ADA, BEN);
    expect(soleOther(c, ADA)).toBe(BEN);
    expect(soleOther(c, BEN)).toBe(ADA);
  });

  it("the player's dyad answers with the creature — every ⑦ conversation", () => {
    // The shape every player-opened record has: the creature it is about, and
    // the child. This is why ⑦ is byte-identical under the new order.
    const c = roster(CAL, LOCAL_PLAYER_CID);
    expect(soleOther(c, LOCAL_PLAYER_CID)).toBe(CAL);
  });

  it("🚨 THREE is not a dyad — there is something to disambiguate", () => {
    const c = roster(ADA, BEN, CAL);
    expect(soleOther(c, ADA)).toBeUndefined();
    expect(soleOther(c, BEN)).toBeUndefined();
    expect(soleOther(c, "nobody")).toBeUndefined();
  });

  it("a roster of ONE (or none) exempts nobody — there is no other person", () => {
    expect(soleOther(roster(ADA), ADA)).toBeUndefined();
    expect(soleOther(roster(ADA), "nobody")).toBeUndefined();
    expect(soleOther(roster(), ADA)).toBeUndefined();
  });

  it("a NON-MEMBER speaking into a pair gets the deterministic senior member", () => {
    // A bodiless author or the world shouting into a circle of two. The size
    // test is the only thing that rules the exemption out, so `find` answers
    // naturally — and law 3's `(joinedTick, id)` order makes the pick identical
    // on every device and every replay. A pair spoken at from outside is still a
    // pair, and this is a better answer than pretending it is ambiguous.
    const c = roster(ADA, BEN);
    expect(soleOther(c, "narrator")).toBe(ADA);
    // …and the same pair assembled in the other order still answers by the
    // roster's order, not by the argument's.
    const later = createConversation("convo_2", 0);
    joinConversation(later, BEN, 5, "b");
    joinConversation(later, ADA, 9, "b");
    expect(soleOther(later, "narrator")).toBe(BEN);
  });

  it("never answers with the speaker itself", () => {
    for (const c of [roster(ADA, BEN), roster(ADA), roster(ADA, BEN, CAL)]) {
      expect(soleOther(c, ADA)).not.toBe(ADA);
    }
  });

  it("reads only the roster — it charges nothing and writes nothing", () => {
    const c = roster(ADA, BEN);
    const before = JSON.stringify(c);
    soleOther(c, ADA);
    soleOther(c, "narrator");
    expect(JSON.stringify(c)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// conversation.ts LAW 5 — THE DURABLE ADDRESS
// ---------------------------------------------------------------------------

describe("ConvoMember.addressing — durable, and never dangling", () => {
  it("SURVIVES A REJOIN — joining is idempotent, and a rejoin is not an amnesia", () => {
    // ⑥'s law: a join arrives from three uncoordinated places and any of them
    // may fire on a member who is already in. It must not reset what the member
    // has, and "whom I am talking to" is now one of those things.
    const c = roster(ADA, BEN, CAL);
    memberOf(c, ADA)!.addressing = CAL;
    const again = joinConversation(c, ADA, 99, "a");
    expect(again.addressing).toBe(CAL);
    expect(again.level).toBe("b"); // …the rung it did not reset either
    expect(addressingOf(c, ADA)).toBe(CAL);
  });

  it("🚨 DIES WHEN ITS TARGET LEAVES — every other member's pointer, cleared", () => {
    const c = roster(ADA, BEN, CAL);
    memberOf(c, ADA)!.addressing = BEN;
    memberOf(c, CAL)!.addressing = BEN;
    leaveConversation(c, BEN);
    expect(memberOf(c, ADA)!.addressing).toBeUndefined();
    expect(memberOf(c, CAL)!.addressing).toBeUndefined();
    expect("addressing" in memberOf(c, ADA)!).toBe(false); // deleted, not undefined-ed
  });

  it("…and only the pointers AT the leaver — an address at somebody else stands", () => {
    const c = roster(ADA, BEN, CAL, DOT);
    memberOf(c, ADA)!.addressing = CAL;
    memberOf(c, BEN)!.addressing = DOT;
    leaveConversation(c, DOT);
    expect(memberOf(c, ADA)!.addressing).toBe(CAL);
    expect(memberOf(c, BEN)!.addressing).toBeUndefined();
  });

  it("the LEAVER's own address goes with its row, and a rejoin starts clean", () => {
    const c = roster(ADA, BEN, CAL);
    memberOf(c, ADA)!.addressing = CAL;
    leaveConversation(c, ADA);
    expect(memberOf(c, ADA)).toBeUndefined();
    const back = joinConversation(c, ADA, 40, "b");
    expect(back.addressing).toBeUndefined(); // whom you were talking to before
    expect(addressingOf(c, ADA)).toBeUndefined(); // you walked off is not a fact now
  });

  it("leaving still touches nothing else (law 1) — history, context, revealed", () => {
    const c = roster(ADA, BEN, CAL);
    c.revealed[BEN] = true;
    c.context.lastMentionedItem = "cookie_1";
    memberOf(c, ADA)!.addressing = BEN;
    leaveConversation(c, BEN);
    expect(c.revealed[BEN]).toBe(true);
    expect(c.context.lastMentionedItem).toBe("cookie_1");
  });
});

describe("addressingOf — a LIVE read, so no caller can resurrect a departed member", () => {
  it("answers the member's own pointer while the target is still here", () => {
    const c = roster(ADA, BEN, CAL);
    memberOf(c, ADA)!.addressing = CAL;
    expect(addressingOf(c, ADA)).toBe(CAL);
  });

  it("🚨 NEVER answers a departed member, even with the raw pointer still set", () => {
    // The window this exists for: a roster edited somewhere that did not route
    // through `leaveConversation` (a wire snapshot, a sweep), leaving a pointer
    // at somebody who is gone. The READ is what must not be fooled.
    const c = roster(ADA, BEN, CAL);
    memberOf(c, ADA)!.addressing = CAL;
    c.members = c.members.filter((m) => m.id !== CAL); // …a departure by other means
    expect(memberOf(c, ADA)!.addressing).toBe(CAL); // the stale row survives…
    expect(addressingOf(c, ADA)).toBeUndefined(); // …and answers nothing
  });

  it("answers nothing for a member with no address, or for a non-member", () => {
    const c = roster(ADA, BEN, CAL);
    expect(addressingOf(c, ADA)).toBeUndefined();
    expect(addressingOf(c, "narrator")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LAW ② — THE CHANNEL ORDER (host mirror)
// ---------------------------------------------------------------------------

/** MIRROR of `HostConversation` — the board's aim (`faced`) lives here, and it
 *  is NOT the sentence's addressee. */
interface HostConversation {
  id: string;
  nodeId: string;
  convo: ConversationState;
  group?: object;
  faced?: Map<string, string>;
}

/** MIRROR of `ConvoView`. */
interface ConvoView {
  cid: string;
  convoId: string;
}

/**
 * The host's addressing half, and nothing else: the records, the board this
 * device has open, the optimistic echo, and which bodies have their heading
 * already spoken for.
 */
class AddresseeMirror {
  readonly conversations = new Map<string, HostConversation>();
  convoView: ConvoView | null = null;
  /** MIRROR of `convoAddressee` — ⑫③ demoted it to a LOCAL OPTIMISTIC ECHO. */
  convoAddressee: string | null = null;
  /** MIRROR of `sess.actionHold` — the HANDS' claim on a heading (law ①). */
  readonly heldHeading = new Set<string>();
  /** MIRROR of `headingHeldByLegs(avatar)` — the LEGS' claim. ⑫③ did not need
   *  the two apart (`headingSpokenFor` is their union and that is all a READ
   *  ever asks), but ⑫④ does: walking is what EXPIRES an address, and an action
   *  hold must not, because the address beat itself is one. */
  readonly walking = new Set<string>();

  /** MIRROR of `viewRecord()`. */
  viewRecord(): HostConversation | null {
    return this.convoView ? (this.conversations.get(this.convoView.convoId) ?? null) : null;
  }

  /** MIRROR of `facedBy(c, memberCid)` — the BOARD's aim and the wire key.
   *  Unchanged by ⑫③, and it still always answers somebody. */
  facedBy(c: HostConversation, memberCid: string): string {
    const faced = c.faced?.get(memberCid);
    if (faced && memberOf(c.convo, faced)) return faced;
    if (!c.group) return c.nodeId;
    return c.convo.members.find((m) => !isPlayerCid(m.id))?.id ?? c.nodeId;
  }

  /** MIRROR of `liveConvoAddressee()`. */
  liveConvoAddressee(): string | null {
    const a = this.convoAddressee;
    if (!a) return null;
    const c = this.viewRecord();
    if (c && memberOf(c.convo, a)) return a;
    this.convoAddressee = null;
    return null;
  }

  /** MIRROR of `headingSpokenFor(cid)` — `actionHold ∪ headingHeldByLegs`. */
  headingSpokenFor(cid: string): boolean {
    return this.heldHeading.has(cid) || this.walking.has(cid);
  }

  /**
   * ★ MIRROR of `setMemberAddress(memberCid, targetCid)` — ⑫④'s ONE WRITER of
   * `ConvoMember.addressing`. ★ Both channels that cost something land here: the
   * child's dwell (through the gate) and a creature's turn-and-face beat.
   * Refuses a speaker in no conversation, a target who is not a fellow member,
   * and addressing yourself; idempotent, and answers whether the roster moved.
   */
  setMemberAddress(memberCid: string, targetCid: string): boolean {
    if (memberCid === targetCid) return false;
    const c = this.conversationOf(memberCid);
    if (!c) return false;
    const me = memberOf(c.convo, memberCid);
    if (!me || !memberOf(c.convo, targetCid)) return false;
    if (me.addressing === targetCid) return false;
    me.addressing = targetCid;
    this.synced.push({ convoId: c.id, memberCid, addressing: targetCid });
    return true;
  }

  /** MIRROR of `expireAddressesOnMove(c)` — "…and until you move". 🚨 THE LEGS,
   *  not `headingSpokenFor`: the address beat IS an action hold, so clearing on
   *  the union would erase the very address the creature just stopped to buy.
   *  Players are exempt (chapter §6 — their channel is the gaze). */
  expireAddressesOnMove(c: HostConversation): void {
    for (const m of c.convo.members) {
      if (m.addressing === undefined || isPlayerCid(m.id)) continue;
      if (this.heldHeading.has(m.id)) continue; // pinned — not walking, whatever v says
      if (this.walking.has(m.id)) delete m.addressing;
    }
  }

  /** MIRROR of `conversationOf(cid)` — THE conversation this member is in. */
  conversationOf(cid: string): HostConversation | null {
    for (const c of this.conversations.values()) if (memberOf(c.convo, cid)) return c;
    return null;
  }

  /** Every `syncConvoMembers` the writer triggered — the owner→follower half. */
  readonly synced: Array<{ convoId: string; memberCid: string; addressing: string }> = [];

  /**
   * MIRROR of the dwell dispatch's `case "address"` (⑫④) — BOTH lines, in this
   * order. The echo is set first so the child's own board never waits a round
   * trip; the gate carries the durable fact. Returns the `PlayerAction` that
   * crossed, which under ⑩ did not exist at all.
   */
  dwellAddress(targetCid: string): { kind: "convo"; cid: string; op: "address" } {
    this.convoAddressee = targetCid; // the LOCAL OPTIMISTIC ECHO
    return { kind: "convo", cid: targetCid, op: "address" };
  }

  /** MIRROR of `applyPlayerAction`'s `convo` arm, address half — what the OWNER
   *  does with a relayed (or local) look. */
  applyConvoAction(action: { kind: "convo"; cid: string; op: "address" }, speakerCid: string): void {
    if (action.op === "address") this.setMemberAddress(speakerCid, action.cid);
  }

  /** ★ MIRROR of `memberAddressee(c, memberCid)` — ⑫③'s NULLABLE channel order. ★ */
  memberAddressee(c: HostConversation, memberCid: string): string | null {
    const sole = soleOther(c.convo, memberCid);
    if (sole) return sole;
    if (!isPlayerCid(memberCid) && this.headingSpokenFor(memberCid)) return null;
    const held = addressingOf(c.convo, memberCid);
    if (held) return held;
    if (memberCid === LOCAL_PLAYER_CID && this.convoView?.convoId === c.id) {
      const picked = this.liveConvoAddressee();
      if (picked) return picked;
    }
    return null;
  }

  /** MIRROR of `runCreatureAct`'s SPLIT: whom the line is said to (nullable),
   *  and which creature the turn is ABOUT (the board, the projection, the body a
   *  transfer animates from — always somebody). */
  resolveTurn(c: HostConversation, speakerCid: string, addresseeOverride?: string) {
    const addresseeId = addresseeOverride ?? this.memberAddressee(c, speakerCid);
    return { addresseeId, nodeId: addresseeId ?? this.facedBy(c, speakerCid) };
  }
}

/** A joined CIRCLE with the child in it: Ada, Ben, Cal and the local player,
 *  whose board is aimed at Ada. The one shape where addressing is a question. */
function circle(): { h: AddresseeMirror; g: HostConversation } {
  const h = new AddresseeMirror();
  const convo = roster(ADA, BEN, CAL, LOCAL_PLAYER_CID);
  const g: HostConversation = {
    id: "circle_1",
    nodeId: ADA,
    convo,
    group: {},
    faced: new Map([[LOCAL_PLAYER_CID, ADA]]),
  };
  h.conversations.set(g.id, g);
  h.convoView = { cid: ADA, convoId: g.id };
  return { h, g };
}

/** A player-opened DYAD — every ⑦ conversation. */
function dyad(): { h: AddresseeMirror; c: HostConversation } {
  const h = new AddresseeMirror();
  const c: HostConversation = { id: CAL, nodeId: CAL, convo: roster(CAL, LOCAL_PLAYER_CID) };
  h.conversations.set(c.id, c);
  h.convoView = { cid: CAL, convoId: c.id };
  return { h, c };
}

describe("⑫③ memberAddressee — the channel order", () => {
  it("① THE DYAD WINS OVER EVERYTHING — free, and asked first", () => {
    const { h, c } = dyad();
    // Every rung below it says otherwise, and none of them is consulted: the
    // heading is held, the durable pointer is nonsense, the echo is unset.
    h.heldHeading.add(CAL);
    memberOf(c.convo, CAL)!.addressing = CAL;
    expect(h.memberAddressee(c, LOCAL_PLAYER_CID)).toBe(CAL);
    expect(h.memberAddressee(c, CAL)).toBe(LOCAL_PLAYER_CID);
    // …and it is the same answer ⑦ gave, which is why the dyad path is
    // byte-identical: the record's own creature.
    expect(h.memberAddressee(c, LOCAL_PLAYER_CID)).toBe(h.facedBy(c, LOCAL_PLAYER_CID));
  });

  it("② A HELD HEADING YIELDS NULL — even with `addressing` set", () => {
    // The LOOK costs a beat, and a body whose legs or hands already own its
    // heading has not paid it. An address expires when you move; this rung is
    // where that expiry lives.
    const { h, g } = circle();
    memberOf(g.convo, ADA)!.addressing = BEN;
    expect(h.memberAddressee(g, ADA)).toBe(BEN);
    h.heldHeading.add(ADA);
    expect(h.memberAddressee(g, ADA)).toBeNull();
    // …and the board is untouched: Ada is still standing in this conversation.
    expect(h.facedBy(g, LOCAL_PLAYER_CID)).toBe(ADA);
  });

  it("② …but a PLAYER is exempt: a child's channel is the gaze, which never stops", () => {
    // Chapter §6. The sim never turns a child's body (⑩), so charging their gaze
    // against their legs would silence them for walking. They pay in dwell.
    const { h, g } = circle();
    h.heldHeading.add(LOCAL_PLAYER_CID);
    h.convoAddressee = BEN;
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBe(BEN);
    memberOf(g.convo, LOCAL_PLAYER_CID)!.addressing = CAL;
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBe(CAL);
  });

  it("③ `addressing` BEATS THE ECHO — the roster is the truth, the cache is a guess", () => {
    const { h, g } = circle();
    h.convoAddressee = BEN;
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBe(BEN); // no durable fact yet
    memberOf(g.convo, LOCAL_PLAYER_CID)!.addressing = CAL;
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBe(CAL);
  });

  it("③ a durable address whose target LEFT falls through to the next channel", () => {
    const { h, g } = circle();
    memberOf(g.convo, LOCAL_PLAYER_CID)!.addressing = CAL;
    h.convoAddressee = BEN;
    leaveConversation(g.convo, CAL);
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBe(BEN);
  });

  it("④ THE ECHO IS LOCAL — never consulted for a peer, nor for another board", () => {
    const { h, g } = circle();
    joinConversation(g.convo, PEER, 9, "b");
    h.convoAddressee = BEN;
    expect(h.memberAddressee(g, PEER)).toBeNull(); // a peer's addressee is their own
    expect(h.memberAddressee(g, ADA)).toBeNull(); // …and a creature's is never a gaze
    h.convoView = { cid: DOT, convoId: "elsewhere" }; // the board moved on
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBeNull();
  });

  it("④ an echo pointing at somebody who LEFT addresses nobody, and is dropped", () => {
    const { h, g } = circle();
    h.convoAddressee = BEN;
    leaveConversation(g.convo, BEN);
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBeNull();
    expect(h.convoAddressee).toBeNull();
  });

  it("⑤ 🚨 NULL WHEN NOTHING ANSWERS — and the board still aims at somebody", () => {
    // THE case ⑫ exists to create: three people, no channel spent, so the line
    // goes to the FLOOR. Under ⑩ `facedBy` answered here, which made addressing
    // free — and something free is never chosen.
    const { h, g } = circle();
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBeNull();
    expect(h.facedBy(g, LOCAL_PLAYER_CID)).toBe(ADA);
    expect(h.memberAddressee(g, ADA)).toBeNull();
  });

  it("reads the ROSTER, not the board — re-aiming the board addresses nobody new", () => {
    const { h, g } = circle();
    g.faced!.set(LOCAL_PLAYER_CID, CAL);
    expect(h.facedBy(g, LOCAL_PLAYER_CID)).toBe(CAL);
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBeNull(); // 🚨 not CAL
  });

  it("a roster that shrinks to TWO becomes a dyad again, mid-conversation", () => {
    const { h, g } = circle();
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBeNull();
    leaveConversation(g.convo, BEN);
    leaveConversation(g.convo, CAL);
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBe(ADA); // nothing left to ask
  });
});

describe("⑫③ the split in runCreatureAct — said TO vs about WHOM", () => {
  it("a floor line still has a board, a projection and a body to animate from", () => {
    const { h, g } = circle();
    const t = h.resolveTurn(g, LOCAL_PLAYER_CID);
    expect(t.addresseeId).toBeNull(); // said to the room…
    expect(t.nodeId).toBe(ADA); // …in front of the person the board is aimed at
  });

  it("a VOCATIVE preempts everything and redirects the WHOLE turn", () => {
    const { h, g } = circle();
    h.convoAddressee = BEN;
    const t = h.resolveTurn(g, LOCAL_PLAYER_CID, CAL);
    expect(t.addresseeId).toBe(CAL);
    expect(t.nodeId).toBe(CAL); // the board, the projection and the effects follow
  });

  it("a dyad resolves both to the same creature — ⑦ byte-identical", () => {
    const { h, c } = dyad();
    expect(h.resolveTurn(c, LOCAL_PLAYER_CID)).toEqual({ addresseeId: CAL, nodeId: CAL });
  });

  it("the addressee answers `nodeId` whenever there IS one — no second resolution", () => {
    const { h, g } = circle();
    memberOf(g.convo, LOCAL_PLAYER_CID)!.addressing = CAL;
    const t = h.resolveTurn(g, LOCAL_PLAYER_CID);
    expect(t).toEqual({ addresseeId: CAL, nodeId: CAL });
  });
});

// ---------------------------------------------------------------------------
// ★ ⑫④ — THE LOOK CROSSES THE GATE ★
// ---------------------------------------------------------------------------
//
// ⑫③ built `ConvoMember.addressing` and left it with no writer. This is the
// writer — and the round trip that carries it, so a look is a fact about the
// simulation rather than one device's private opinion.

describe("⑫④ the dwell `address` cell now goes through the gate", () => {
  it("🚨 IT PRODUCES A PlayerAction — the one cell of the four that never did", () => {
    // Its three neighbours (`sendTo` / `attendObject` / `attendCreature`) all
    // crossed; this one wrote a local variable and stopped there, so in a shared
    // world nobody but that device ever knew whom the child had turned to.
    const { h } = circle();
    expect(h.dwellAddress(BEN)).toEqual({ kind: "convo", cid: BEN, op: "address" });
  });

  it("the LOCAL ECHO lands first, so the child's board never waits a round trip", () => {
    const { h, g } = circle();
    const action = h.dwellAddress(BEN);
    // Before the owner has done anything at all, this device already answers.
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBe(BEN);
    expect(memberOf(g.convo, LOCAL_PLAYER_CID)!.addressing).toBeUndefined();
    // …and then the owner's write makes it durable, at the rung ABOVE the echo.
    h.applyConvoAction(action, LOCAL_PLAYER_CID);
    expect(memberOf(g.convo, LOCAL_PLAYER_CID)!.addressing).toBe(BEN);
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBe(BEN);
  });

  it("the OWNER's answer wins over a stale echo — the roster is the truth", () => {
    const { h, g } = circle();
    h.convoAddressee = BEN; // this device's guess…
    h.applyConvoAction({ kind: "convo", cid: CAL, op: "address" }, LOCAL_PLAYER_CID);
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBe(CAL); // …the owner's fact
  });

  it("a RELAYED look writes the SENDER's row, never this device's", () => {
    const { h, g } = circle();
    joinConversation(g.convo, PEER, 9, "b");
    h.applyConvoAction({ kind: "convo", cid: ADA, op: "address" }, PEER);
    expect(memberOf(g.convo, PEER)!.addressing).toBe(ADA);
    expect(memberOf(g.convo, LOCAL_PLAYER_CID)!.addressing).toBeUndefined();
    expect(h.memberAddressee(g, PEER)).toBe(ADA);
  });
});

describe("⑫④ setMemberAddress — the ONE writer, and what it refuses", () => {
  it("writes the durable fact and syncs it out", () => {
    const { h, g } = circle();
    expect(h.setMemberAddress(LOCAL_PLAYER_CID, BEN)).toBe(true);
    expect(memberOf(g.convo, LOCAL_PLAYER_CID)!.addressing).toBe(BEN);
    expect(h.synced).toEqual([{ convoId: g.id, memberCid: LOCAL_PLAYER_CID, addressing: BEN }]);
  });

  it("IDEMPOTENT — re-asserting the same address writes nothing and sends nothing", () => {
    // A dwell re-fires for as long as the child keeps looking; it must not cost
    // a mesh message per frame.
    const { h } = circle();
    expect(h.setMemberAddress(LOCAL_PLAYER_CID, BEN)).toBe(true);
    expect(h.setMemberAddress(LOCAL_PLAYER_CID, BEN)).toBe(false);
    expect(h.synced).toHaveLength(1);
  });

  it("refuses a NON-MEMBER target — an address is two people in one conversation", () => {
    const { h, g } = circle();
    expect(h.setMemberAddress(LOCAL_PLAYER_CID, DOT)).toBe(false);
    expect(memberOf(g.convo, LOCAL_PLAYER_CID)!.addressing).toBeUndefined();
  });

  it("refuses a speaker in no conversation, and refuses addressing yourself", () => {
    const { h } = circle();
    expect(h.setMemberAddress(DOT, BEN)).toBe(false);
    expect(h.setMemberAddress(BEN, BEN)).toBe(false);
  });

  it("a creature may address another creature — this is not a player-only fact", () => {
    const { h, g } = circle();
    expect(h.setMemberAddress(ADA, CAL)).toBe(true);
    expect(addressingOf(g.convo, ADA)).toBe(CAL);
  });
});

describe("⑫④ lifetime — until you look elsewhere, or until you move", () => {
  it("LOOKING ELSEWHERE replaces it; there is no timeout anywhere", () => {
    const { h, g } = circle();
    h.setMemberAddress(LOCAL_PLAYER_CID, BEN);
    h.setMemberAddress(LOCAL_PLAYER_CID, CAL);
    expect(memberOf(g.convo, LOCAL_PLAYER_CID)!.addressing).toBe(CAL);
  });

  it("MOVING clears it — the legs, and only the legs", () => {
    const { h, g } = circle();
    h.setMemberAddress(ADA, CAL);
    h.walking.add(ADA);
    h.expireAddressesOnMove(g);
    expect(memberOf(g.convo, ADA)!.addressing).toBeUndefined();
    expect("addressing" in memberOf(g.convo, ADA)!).toBe(false); // deleted, not undefined-ed
  });

  it("🚨 AN ACTION HOLD DOES NOT CLEAR IT — the address BEAT is an action hold", () => {
    // The trap: `headingSpokenFor` is the union of both claims and is the right
    // predicate for READING an addressee, but clearing on it would have a
    // creature erase the address it just stopped and turned to buy.
    const { h, g } = circle();
    h.setMemberAddress(ADA, CAL);
    h.heldHeading.add(ADA);
    h.expireAddressesOnMove(g);
    expect(memberOf(g.convo, ADA)!.addressing).toBe(CAL);
    // …and while the hands hold it, the READ still answers nobody (⑫③ rung ②),
    // without the fact being deleted. Two different questions, two answers.
    expect(h.memberAddressee(g, ADA)).toBeNull();
    h.heldHeading.delete(ADA);
    expect(h.memberAddressee(g, ADA)).toBe(CAL); // …and it comes back
  });

  it("🚨 A PINNED BODY DOES NOT COUNT AS WALKING — the beat's own residual velocity", () => {
    // `beginAction` parks a body with a dwell errand and its velocity takes a
    // frame or two to bleed off. Without this guard a creature that was
    // mid-stride when it stopped to turn would erase the address on the very
    // frame the beat wrote it, then buy it again next turn — forever.
    const { h, g } = circle();
    h.setMemberAddress(ADA, CAL);
    h.heldHeading.add(ADA); // the address hold
    h.walking.add(ADA); // …and the stride it has not shed yet
    h.expireAddressesOnMove(g);
    expect(memberOf(g.convo, ADA)!.addressing).toBe(CAL);
    // Once the hold ends, the same walking body loses it exactly as it should.
    h.heldHeading.delete(ADA);
    h.expireAddressesOnMove(g);
    expect(memberOf(g.convo, ADA)!.addressing).toBeUndefined();
  });

  it("A PLAYER'S ADDRESS SURVIVES WALKING (chapter §6) — the gaze never stops", () => {
    const { h, g } = circle();
    h.setMemberAddress(LOCAL_PLAYER_CID, BEN);
    h.walking.add(LOCAL_PLAYER_CID);
    h.expireAddressesOnMove(g);
    expect(memberOf(g.convo, LOCAL_PLAYER_CID)!.addressing).toBe(BEN);
    expect(h.memberAddressee(g, LOCAL_PLAYER_CID)).toBe(BEN);
  });

  it("expiry touches only the members who moved", () => {
    const { h, g } = circle();
    h.setMemberAddress(ADA, CAL);
    h.setMemberAddress(BEN, ADA);
    h.walking.add(ADA);
    h.expireAddressesOnMove(g);
    expect(memberOf(g.convo, ADA)!.addressing).toBeUndefined();
    expect(memberOf(g.convo, BEN)!.addressing).toBe(ADA);
  });

  it("…and it is idempotent: a member already talking to nobody is left alone", () => {
    const { h, g } = circle();
    const before = JSON.stringify(g.convo);
    h.walking.add(ADA);
    h.expireAddressesOnMove(g);
    expect(JSON.stringify(g.convo)).toBe(before);
  });
});

describe("⑫④ the address rides the wire", () => {
  /** MIRROR of `syncConvoMembers`'s per-member send — the LIVE read, so a
   *  departed target is already "nobody" by the time the message is built. */
  const sendFor = (c: ConversationState, memberCid: string, peer: string, seq: number) => {
    const addressing = addressingOf(c, memberCid);
    return convoMessage(memberCid, peer, memberOf(c, memberCid)!.level, { revealed: {}, pairs: {} }, {
      ...(addressing ? { addressing } : {}),
      seq,
    });
  };

  /** MIRROR of `stepFollowerConvoSync`'s member-row application. REPLACED, not
   *  merged: an absent field means NOBODY, not "unchanged". */
  const applyToMirror = (c: ConversationState, sync: { addressing?: string }) => {
    const me = memberOf(c, LOCAL_PLAYER_CID)!;
    if (sync.addressing) me.addressing = sync.addressing;
    else delete me.addressing;
  };

  it("the owner's write reaches the follower's own roster row", () => {
    const owner = roster(ADA, BEN, CAL, LOCAL_PLAYER_CID);
    const follower = roster(ADA, BEN, CAL, LOCAL_PLAYER_CID);
    memberOf(owner, LOCAL_PLAYER_CID)!.addressing = BEN;

    const state = createWorldState(WIRE_SPEC, "me");
    applyInbound(state, sendFor(owner, LOCAL_PLAYER_CID, "peer-a", 1));
    const sync = state.convoSync!["peer-a"]!;
    expect(sync.addressing).toBe(BEN);
    applyToMirror(follower, sync);
    expect(addressingOf(follower, LOCAL_PLAYER_CID)).toBe(BEN);
  });

  it("🚨 AN ABSENT FIELD CLEARS IT — the next sync IS the clearing", () => {
    // No second "your address is over" message shape exists, and none should:
    // the owner passes a live read, so an address that died simply stops being
    // in the message. A mirror that read absence as "unchanged" would go on
    // aiming sentences at somebody the simulation has stopped aiming them at.
    const owner = roster(ADA, BEN, CAL, LOCAL_PLAYER_CID);
    const follower = roster(ADA, BEN, CAL, LOCAL_PLAYER_CID);
    memberOf(owner, LOCAL_PLAYER_CID)!.addressing = BEN;
    memberOf(follower, LOCAL_PLAYER_CID)!.addressing = BEN;

    leaveConversation(owner, BEN); // …the person walked off
    const state = createWorldState(WIRE_SPEC, "me");
    applyInbound(state, sendFor(owner, LOCAL_PLAYER_CID, "peer-a", 2));
    expect(state.convoSync!["peer-a"]).not.toHaveProperty("addressing");
    applyToMirror(follower, state.convoSync!["peer-a"]!);
    expect(memberOf(follower, LOCAL_PLAYER_CID)!.addressing).toBeUndefined();
  });

  it("an address at a member who has LEFT is never sent in the first place", () => {
    // Belt and braces with `leaveConversation`'s own clearing: the two go wrong
    // in different ways, so both the write path and the read path check.
    const owner = roster(ADA, BEN, CAL, LOCAL_PLAYER_CID);
    memberOf(owner, LOCAL_PLAYER_CID)!.addressing = CAL;
    owner.members = owner.members.filter((m) => m.id !== CAL); // a departure by other means
    expect(sendFor(owner, LOCAL_PLAYER_CID, "peer-a", 3)).not.toHaveProperty("addressing");
  });
});
