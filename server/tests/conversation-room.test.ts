// Tests the shape-C conversation-room fan-out: utterances reach peers (not the
// speaker), presence notices fire on join/leave, addressee is carried through.
// Uses the in-memory bus (publish is a no-op) so we exercise local delivery.
import { jest } from "@jest/globals";
import { initBus, stopBus } from "../services/realtime/bus-factory";
import {
  joinRoom,
  leaveRoom,
  publishUtterance,
  publishFocus,
  type RoomParticipant,
  type RoomUtterance,
  type RoomPresence,
  type RoomMember,
  type RoomFocus,
  type FloorState,
} from "../services/dual-agent/conversation-room";

interface Capture {
  utterances: RoomUtterance[];
  presence: RoomPresence[];
  roster: RoomMember[][];
  floor: FloorState[];
  focus: RoomFocus[];
}

function participant(personId: string, name: string): { p: RoomParticipant; cap: Capture } {
  const cap: Capture = { utterances: [], presence: [], roster: [], floor: [], focus: [] };
  const p: RoomParticipant = {
    personId,
    name,
    onUtterance: (u) => cap.utterances.push(u),
    onPresence: (pr) => cap.presence.push(pr),
    onRoster: (members) => cap.roster.push(members),
    onFloor: (s) => cap.floor.push(s),
    onPeerFocus: (f) => cap.focus.push(f),
  };
  return { p, cap };
}

const lastFloor = (cap: Capture): FloorState | undefined => cap.floor[cap.floor.length - 1];

const utter = (over: Partial<RoomUtterance>): RoomUtterance => ({
  roomId: "room-1",
  fromPersonId: "A",
  fromName: "Alice",
  text: "hello",
  addressee: "ROOM",
  at: 1,
  ...over,
});

describe("conversation-room fan-out", () => {
  beforeAll(async () => {
    await initBus();
  });
  afterAll(async () => {
    await stopBus();
  });

  it("delivers an utterance to peers but never echoes to the speaker", () => {
    const a = participant("A", "Alice");
    const b = participant("B", "Bob");
    joinRoom("room-1", a.p);
    joinRoom("room-1", b.p);

    publishUtterance(utter({ fromPersonId: "A", text: "hi Bob" }));

    expect(b.cap.utterances.map((u) => u.text)).toEqual(["hi Bob"]);
    expect(a.cap.utterances).toHaveLength(0); // speaker doesn't hear themselves

    leaveRoom("room-1", "A");
    leaveRoom("room-1", "B");
  });

  it("carries the addressee through unchanged (routing is the recipient's job)", () => {
    const a = participant("A", "Alice");
    const b = participant("B", "Bob");
    joinRoom("room-2", a.p);
    joinRoom("room-2", b.p);

    publishUtterance(utter({ roomId: "room-2", fromPersonId: "A", addressee: "B", text: "just you" }));

    expect(b.cap.utterances[0].addressee).toBe("B");

    leaveRoom("room-2", "A");
    leaveRoom("room-2", "B");
  });

  it("notifies existing peers when someone joins or leaves", () => {
    const a = participant("A", "Alice");
    joinRoom("room-3", a.p);
    expect(a.cap.presence).toHaveLength(0); // no peers yet → no notice to self

    const b = participant("B", "Bob");
    joinRoom("room-3", b.p);
    // Alice hears that Bob joined; Bob is not told about himself.
    expect(a.cap.presence).toEqual([{ roomId: "room-3", personId: "B", name: "Bob", joined: true }]);
    expect(b.cap.presence).toHaveLength(0);

    leaveRoom("room-3", "B");
    expect(a.cap.presence.at(-1)).toEqual({ roomId: "room-3", personId: "B", name: "Bob", joined: false });

    leaveRoom("room-3", "A");
  });

  it("isolates rooms — an utterance in one room never reaches another", () => {
    const a = participant("A", "Alice");
    const c = participant("C", "Carol");
    joinRoom("room-x", a.p);
    joinRoom("room-y", c.p);

    publishUtterance(utter({ roomId: "room-x", fromPersonId: "A", text: "x only" }));

    expect(c.cap.utterances).toHaveLength(0);

    leaveRoom("room-x", "A");
    leaveRoom("room-y", "C");
  });

  it("hands a late joiner the roster of peers already in the room", () => {
    const a = participant("A", "Alice");
    joinRoom("room-5", a.p);
    expect(a.cap.roster).toHaveLength(0); // first in → empty room, no roster

    const b = participant("B", "Bob");
    joinRoom("room-5", b.p);
    expect(b.cap.roster[0].map((m) => m.name)).toEqual(["Alice"]); // Bob sees Alice

    const c = participant("C", "Carol"); // joins last
    joinRoom("room-5", c.p);

    // Carol is handed the existing members (Alice, Bob), excluding herself.
    expect(c.cap.roster).toHaveLength(1);
    const names = c.cap.roster[0].map((m) => m.name).sort();
    expect(names).toEqual(["Alice", "Bob"]);
    expect(c.cap.roster[0].some((m) => m.personId === "C")).toBe(false);

    leaveRoom("room-5", "A");
    leaveRoom("room-5", "B");
    leaveRoom("room-5", "C");
  });

  it("gives the first participant no roster (empty room)", () => {
    const a = participant("A", "Alice");
    joinRoom("room-6", a.p);
    expect(a.cap.roster).toHaveLength(0);
    leaveRoom("room-6", "A");
  });

  it("stops delivering after a participant leaves", () => {
    const a = participant("A", "Alice");
    const b = participant("B", "Bob");
    joinRoom("room-4", a.p);
    joinRoom("room-4", b.p);
    leaveRoom("room-4", "B");

    publishUtterance(utter({ roomId: "room-4", fromPersonId: "A", text: "anyone?" }));
    expect(b.cap.utterances).toHaveLength(0);

    leaveRoom("room-4", "A");
  });
});

describe("focus (who is addressing whom)", () => {
  beforeAll(async () => {
    await initBus();
  });
  afterAll(async () => {
    await stopBus();
  });

  it("delivers a focus to room members but not the focuser", () => {
    const a = participant("A", "Alice");
    const b = participant("B", "Bob");
    joinRoom("foc-1", a.p);
    joinRoom("foc-1", b.p);

    publishFocus({ roomId: "foc-1", fromPersonId: "A", fromName: "Alice", targetPersonId: "B" });

    expect(b.cap.focus).toEqual([{ roomId: "foc-1", fromPersonId: "A", fromName: "Alice", targetPersonId: "B" }]);
    expect(a.cap.focus).toHaveLength(0); // focuser doesn't get their own echo

    leaveRoom("foc-1", "A");
    leaveRoom("foc-1", "B");
  });

  it("delivers focus from an EXTERNAL party (e.g. a clinician not in the room)", () => {
    // The clinician isn't a participant; publishFocus still reaches members.
    const b = participant("B", "Bob");
    joinRoom("foc-2", b.p);

    publishFocus({ roomId: "foc-2", fromPersonId: "clinician-person", fromName: "Dr. Smith", targetPersonId: "B" });

    expect(b.cap.focus[0]).toMatchObject({ fromPersonId: "clinician-person", targetPersonId: "B" });

    leaveRoom("foc-2", "B");
  });
});

describe("floor / turn director", () => {
  beforeAll(async () => {
    await initBus();
  });
  afterAll(async () => {
    await stopBus();
  });

  it("a bid leaves the bidder awaiting a response; floor delivered to everyone", () => {
    const a = participant("A", "Alice");
    const b = participant("B", "Bob");
    joinRoom("f-1", a.p);
    joinRoom("f-1", b.p);

    publishUtterance(utter({ roomId: "f-1", fromPersonId: "A", bid: true, text: "what about you?" }));

    // Both the speaker AND the peer are told the floor state.
    expect(lastFloor(a.cap)).toMatchObject({ holder: null, awaiting: "A", reason: "bid" });
    expect(lastFloor(b.cap)).toMatchObject({ holder: null, awaiting: "A", reason: "bid" });

    leaveRoom("f-1", "A");
    leaveRoom("f-1", "B");
  });

  it("a plain reply opens the floor (no holder, no awaiting)", () => {
    const a = participant("A", "Alice");
    const b = participant("B", "Bob");
    joinRoom("f-2", a.p);
    joinRoom("f-2", b.p);

    publishUtterance(utter({ roomId: "f-2", fromPersonId: "A", bid: false, text: "me too" }));

    expect(lastFloor(b.cap)).toMatchObject({ holder: null, awaiting: null, reason: "opened" });

    leaveRoom("f-2", "A");
    leaveRoom("f-2", "B");
  });

  it("a bid addressed to one peer passes the floor to them", () => {
    const a = participant("A", "Alice");
    const b = participant("B", "Bob");
    joinRoom("f-3", a.p);
    joinRoom("f-3", b.p);

    publishUtterance(utter({ roomId: "f-3", fromPersonId: "A", addressee: "B", bid: true, text: "Bob, what about you?" }));

    expect(lastFloor(b.cap)).toMatchObject({ holder: "B", awaiting: null, reason: "passed" });

    leaveRoom("f-3", "A");
    leaveRoom("f-3", "B");
  });

  it("a reply addressed to one peer just opens the floor (no turn handed)", () => {
    const a = participant("A", "Alice");
    const b = participant("B", "Bob");
    joinRoom("f-3b", a.p);
    joinRoom("f-3b", b.p);

    publishUtterance(utter({ roomId: "f-3b", fromPersonId: "A", addressee: "B", bid: false, text: "Bob, me too" }));

    expect(lastFloor(b.cap)).toMatchObject({ holder: null, awaiting: null, reason: "opened" });

    leaveRoom("f-3b", "A");
    leaveRoom("f-3b", "B");
  });

  it("reopens the floor when the floor-holder leaves", () => {
    const a = participant("A", "Alice");
    const b = participant("B", "Bob");
    joinRoom("f-4", a.p);
    joinRoom("f-4", b.p);

    // Alice bids to Bob → Bob holds the floor.
    publishUtterance(utter({ roomId: "f-4", fromPersonId: "A", addressee: "B", bid: true, text: "Bob?" }));
    expect(lastFloor(a.cap)).toMatchObject({ holder: "B" });

    // Bob leaves before answering → floor reopens for Alice.
    leaveRoom("f-4", "B");
    expect(lastFloor(a.cap)).toMatchObject({ holder: null, awaiting: null, reason: "left" });

    leaveRoom("f-4", "A");
  });

  it("auto-reopens the floor after the response timeout", () => {
    jest.useFakeTimers();
    try {
      const a = participant("A", "Alice");
      const b = participant("B", "Bob");
      joinRoom("f-5", a.p);
      joinRoom("f-5", b.p);

      publishUtterance(utter({ roomId: "f-5", fromPersonId: "A", addressee: "B", bid: true, text: "Bob?" }));
      expect(lastFloor(b.cap)).toMatchObject({ holder: "B" });

      jest.advanceTimersByTime(45_000);
      expect(lastFloor(b.cap)).toMatchObject({ holder: null, awaiting: null, reason: "timeout" });

      leaveRoom("f-5", "A");
      leaveRoom("f-5", "B");
    } finally {
      jest.useRealTimers();
    }
  });
});
