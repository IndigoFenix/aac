// Shape-C group AAC chat: the shared conversation/turn layer.
//
// Each participant keeps its OWN local agent stack (an AAC student's
// AgentCoordinator owns its private Observer / Speaker / Board Manager / energy /
// identity) — nothing private is shared. What crosses between participants is
// only the already-attributed *conversation*: when a participant voices an
// utterance, it is published here and fanned out to the OTHERS in the room.
//
// Identity: participants are `persons` (the canonical human — a student OR a
// non-student such as a caretaker), so the conversation layer keys on
// **personId** throughout. studentId is an AAC-system detail that stays inside a
// coordinator; it never appears here.
//
// Attribution is free: an utterance originates from a known participant session,
// so we never have to infer who spoke. Addressee defaults to the whole ROOM
// (each recipient may reply); a targeted addressee is carried as a soft hint and
// the receiving coordinator decides whether to rebuild its board.
//
// Cross-instance: participants in one room may be connected to different server
// instances. Local delivery happens in-process; the fanout bus carries the
// utterance (no PHI beyond the spoken text, which is ephemeral conversation —
// same trust level as call signaling) so every instance delivers to its own
// locally-connected participants. Mirrors callFanout.

import { getBus } from "../realtime/bus-factory";
import { logLiveSession } from "./dual-agent-logger";

/** A participant utterance broadcast to a room. */
export interface RoomUtterance {
  roomId: string;
  fromPersonId: string;
  fromName: string;
  text: string;
  /** personId the utterance is aimed at, or "ROOM" for everyone (default). */
  addressee: string;
  /** The utterance hands the turn over (a question/request expecting a reply),
   *  vs a plain reply. Drives the floor: a bid opens the floor expecting a
   *  response; a reply just opens it. */
  bid?: boolean;
  at: number;
}

/**
 * Turn/floor state for a room. Advisory only — it NEVER blocks a participant
 * from speaking (this population communicates slowly and rigid turn-locking
 * would be exclusionary); it just tells each participant's AI whose turn it is so
 * it can facilitate ("your turn" / "wait for X" / "X asked — you can answer").
 *
 * Derived purely from the last utterance + an auto-reopen timer, so every
 * instance computes the same state from the fan-out it already receives.
 */
export interface FloorState {
  roomId: string;
  /** personId expected to speak next (someone was directly addressed), or null
   *  when the floor is open to everyone. */
  holder: string | null;
  /** personId who just asked the group and is awaiting a response (after a
   *  bid); others are softly invited to answer. null otherwise. */
  awaiting: string | null;
  reason: "passed" | "bid" | "opened" | "timeout" | "left";
  at: number;
}

/** Room membership change, surfaced to peers as a lightweight awareness note. */
export interface RoomPresence {
  roomId: string;
  personId: string;
  name: string;
  joined: boolean; // true = joined, false = left
}

/** Someone (a participant, or an external party like a clinician on the call)
 *  declared who they are now addressing. Lets the addressed participant's AI
 *  prepare to respond before any utterance arrives. */
export interface RoomFocus {
  roomId: string;
  fromPersonId: string;
  fromName: string;
  /** personId being addressed, or null when focus is cleared (whole room). */
  targetPersonId: string | null;
}

/** A peer already in the room (delivered to a late joiner). */
export interface RoomMember {
  personId: string;
  name: string;
}

/** A locally-connected participant (one person's session). */
export interface RoomParticipant {
  personId: string;
  name: string;
  /** Deliver a peer's utterance to this participant's coordinator. */
  onUtterance: (u: RoomUtterance) => void;
  /** Notify this participant that a peer joined/left the room. */
  onPresence: (p: RoomPresence) => void;
  /** Deliver the peers ALREADY in the room at join time (excludes self). May
   *  fire more than once: once for local peers, then again per remote instance
   *  as roster replies arrive over the bus. */
  onRoster: (members: RoomMember[]) => void;
  /** Floor/turn changed — advisory cue about whose turn it is. */
  onFloor: (s: FloorState) => void;
  /** Another party declared who they're addressing (may target this
   *  participant, or someone else). */
  onPeerFocus: (f: RoomFocus) => void;
}

// roomId → (personId → participant) for participants on THIS instance only.
const rooms = new Map<string, Map<string, RoomParticipant>>();

// roomId → last computed floor (holder/awaiting), so a leave can tell whether
// the departing participant held the floor. Derived state, kept per-instance.
const floors = new Map<string, { holder: string | null; awaiting: string | null }>();
// roomId → the timer that auto-reopens the floor if the expected response never
// comes. Per-instance (each instance reopens for its own local participants).
const floorTimers = new Map<string, NodeJS.Timeout>();
// Generous because this population speaks slowly: a turn isn't forfeited until
// well past a realistic compose time, and even then nothing is blocked.
const FLOOR_RESPONSE_TIMEOUT_MS = 45_000;

const BUS_CHANNEL = "aacRoom";

type BusMessage =
  | { from: string; op: "utterance"; utterance: RoomUtterance }
  | { from: string; op: "presence"; presence: RoomPresence }
  | { from: string; op: "focus"; focus: RoomFocus }
  // Late joiner asks other instances who's in the room; each instance with
  // local members of that room replies. requesterPersonId routes the reply.
  | { from: string; op: "roster_request"; roomId: string; requesterPersonId: string }
  | { from: string; op: "roster_reply"; roomId: string; requesterPersonId: string; members: RoomMember[] };

// ---------- Local registry ----------

function localParticipants(roomId: string): RoomParticipant[] {
  return Array.from(rooms.get(roomId)?.values() ?? []);
}

/** Register a participant, notify existing peers, and hand the newcomer the
 *  current roster (local synchronously; remote instances reply over the bus). */
export function joinRoom(roomId: string, participant: RoomParticipant): void {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }
  // Snapshot existing LOCAL members BEFORE adding self, so the joiner learns
  // who's already here (the whole point of roster-on-join).
  const existingLocal: RoomMember[] = Array.from(room.values()).map((p) => ({ personId: p.personId, name: p.name }));
  room.set(participant.personId, participant);
  logLiveSession("CHAT_ROOM", `JOIN room=${roomId} person=${participant.personId} name="${participant.name}" → members now: [${Array.from(room.keys()).join(", ")}]`);
  announcePresence({ roomId, personId: participant.personId, name: participant.name, joined: true });
  if (existingLocal.length > 0) {
    try {
      participant.onRoster(existingLocal);
    } catch (err) {
      console.error("[conversationRoom] onRoster (local) error:", err);
    }
  }
  // Ask any OTHER instances for their members of this room (no-op on a single
  // instance — the bus publish goes nowhere and local roster is already done).
  void publishBus({ from: getBus().instanceId, op: "roster_request", roomId, requesterPersonId: participant.personId });
}

/** Deregister a participant and notify remaining peers. */
export function leaveRoom(roomId: string, personId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  const participant = room.get(personId);
  room.delete(personId);
  if (room.size === 0) {
    rooms.delete(roomId);
    floors.delete(roomId);
    clearFloorTimer(roomId);
  }
  if (participant) {
    announcePresence({ roomId, personId, name: participant.name, joined: false });
  }
}

// ---------- Publish / deliver ----------

/** A participant voiced something → fan it out to the room's other participants
 *  and update the floor. */
export function publishUtterance(u: RoomUtterance): void {
  deliverUtteranceLocal(u);
  applyFloorFromUtterance(u);
  void publishBus({ from: getBus().instanceId, op: "utterance", utterance: u });
}

function deliverUtteranceLocal(u: RoomUtterance): void {
  const recipients = localParticipants(u.roomId).filter((p) => p.personId !== u.fromPersonId);
  logLiveSession(
    "CHAT_ROOM",
    `UTTERANCE room=${u.roomId} from=${u.fromPersonId} ("${u.fromName}") addressee=${u.addressee} text="${u.text}" → ${recipients.length} local recipient(s): [${recipients.map((p) => p.personId).join(", ")}]`,
  );
  for (const p of recipients) {
    try {
      p.onUtterance(u);
    } catch (err) {
      console.error("[conversationRoom] onUtterance error:", err);
    }
  }
}

function announcePresence(p: RoomPresence): void {
  deliverPresenceLocal(p);
  void publishBus({ from: getBus().instanceId, op: "presence", presence: p });
}

function deliverPresenceLocal(p: RoomPresence): void {
  for (const participant of localParticipants(p.roomId)) {
    if (participant.personId === p.personId) continue; // don't notify about self
    try {
      participant.onPresence(p);
    } catch (err) {
      console.error("[conversationRoom] onPresence error:", err);
    }
  }
  // If the participant who left was holding/awaiting the floor, reopen it. Runs
  // on every instance (presence fans out), so each opens for its own locals.
  if (!p.joined) openFloorOnLeave(p.roomId, p.personId);
}

// ---------- Focus (who is addressing whom) ----------

/** Broadcast that `fromPersonId` is now addressing `targetPersonId` (or the
 *  whole room when null). The source may be a room participant (an AAC student
 *  selecting a peer) OR an external party on the call (a clinician) — in the
 *  latter case `fromPersonId` isn't a room member, which is fine: focus only
 *  needs to reach the participants. */
export function publishFocus(focus: RoomFocus): void {
  deliverFocusLocal(focus);
  void publishBus({ from: getBus().instanceId, op: "focus", focus });
}

function deliverFocusLocal(f: RoomFocus): void {
  for (const p of localParticipants(f.roomId)) {
    if (p.personId === f.fromPersonId) continue; // don't echo to the focuser
    try {
      p.onPeerFocus(f);
    } catch (err) {
      console.error("[conversationRoom] onPeerFocus error:", err);
    }
  }
}

// ---------- Roster (late-joiner participant list) ----------

/** Another instance's joiner asked who's here → reply with our local members. */
function handleRosterRequest(roomId: string, requesterPersonId: string): void {
  const members = localParticipants(roomId)
    .filter((p) => p.personId !== requesterPersonId)
    .map((p) => ({ personId: p.personId, name: p.name }));
  if (members.length === 0) return;
  void publishBus({ from: getBus().instanceId, op: "roster_reply", roomId, requesterPersonId, members });
}

/** A roster reply arrived → hand it to the requester if they're local to us. */
function deliverRoster(roomId: string, requesterPersonId: string, members: RoomMember[]): void {
  const requester = rooms.get(roomId)?.get(requesterPersonId);
  if (!requester) return; // requester lives on another instance
  const others = members.filter((m) => m.personId !== requesterPersonId);
  if (others.length === 0) return;
  try {
    requester.onRoster(others);
  } catch (err) {
    console.error("[conversationRoom] onRoster (remote) error:", err);
  }
}

// ---------- Floor / turn director ----------

function deliverFloorLocal(s: FloorState): void {
  // Delivered to ALL local participants (including the speaker — they need to
  // know they handed/ended their turn).
  for (const p of localParticipants(s.roomId)) {
    try {
      p.onFloor(s);
    } catch (err) {
      console.error("[conversationRoom] onFloor error:", err);
    }
  }
}

function clearFloorTimer(roomId: string): void {
  const t = floorTimers.get(roomId);
  if (t) {
    clearTimeout(t);
    floorTimers.delete(roomId);
  }
}

/** Recompute and deliver the floor after an utterance. Runs on EVERY instance
 *  (origin + bus delivery), so the derived floor is identical everywhere; the
 *  reopen timer is local but deterministic. */
function applyFloorFromUtterance(u: RoomUtterance): void {
  clearFloorTimer(u.roomId);
  let holder: string | null = null;
  let awaiting: string | null = null;
  let reason: FloorState["reason"] = "opened";
  const targetedPeer = u.addressee !== "ROOM" && u.addressee !== u.fromPersonId;
  if (u.bid && targetedPeer) {
    holder = u.addressee; // asked ONE peer directly → it's their turn to answer
    reason = "passed";
  } else if (u.bid) {
    awaiting = u.fromPersonId; // asked the whole group → anyone may answer
    reason = "bid";
  }
  // A plain reply (targeted or not) just opens the floor — answering someone
  // doesn't hand them the turn.
  floors.set(u.roomId, { holder, awaiting });
  deliverFloorLocal({ roomId: u.roomId, holder, awaiting, reason, at: u.at });

  // Auto-reopen so no one is ever stuck waiting on a turn that never comes.
  if (holder || awaiting) {
    const timer = setTimeout(() => {
      floorTimers.delete(u.roomId);
      floors.set(u.roomId, { holder: null, awaiting: null });
      deliverFloorLocal({ roomId: u.roomId, holder: null, awaiting: null, reason: "timeout", at: Date.now() });
    }, FLOOR_RESPONSE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    floorTimers.set(u.roomId, timer);
  }
}

/** If the departing participant held/awaited the floor, open it for everyone. */
function openFloorOnLeave(roomId: string, personId: string): void {
  const floor = floors.get(roomId);
  if (!floor || (floor.holder !== personId && floor.awaiting !== personId)) return;
  clearFloorTimer(roomId);
  floors.set(roomId, { holder: null, awaiting: null });
  deliverFloorLocal({ roomId, holder: null, awaiting: null, reason: "left", at: Date.now() });
}

// ---------- Cross-instance fanout ----------

export function initConversationRoomFanout(): void {
  const bus = getBus();
  bus.onMessage((channel, raw) => {
    if (channel !== BUS_CHANNEL) return;
    let msg: BusMessage;
    try {
      msg = JSON.parse(raw) as BusMessage;
    } catch (err) {
      console.error("[conversationRoom] parse error:", err);
      return;
    }
    if (msg.from === bus.instanceId) return; // ignore our own echo
    try {
      if (msg.op === "utterance") {
        deliverUtteranceLocal(msg.utterance);
        applyFloorFromUtterance(msg.utterance); // keep this instance's floor in sync
      } else if (msg.op === "presence") {
        deliverPresenceLocal(msg.presence);
      } else if (msg.op === "focus") {
        deliverFocusLocal(msg.focus);
      } else if (msg.op === "roster_request") handleRosterRequest(msg.roomId, msg.requesterPersonId);
      else if (msg.op === "roster_reply") deliverRoster(msg.roomId, msg.requesterPersonId, msg.members);
    } catch (err) {
      console.error("[conversationRoom] dispatch error:", err);
    }
  });
}

async function publishBus(msg: BusMessage): Promise<void> {
  try {
    await getBus().publish(BUS_CHANNEL, JSON.stringify(msg));
  } catch (err) {
    console.error("[conversationRoom] bus publish error:", err);
  }
}
