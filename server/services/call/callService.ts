// server/services/call/callService.ts
// Orchestrates live-call signaling. The server is a dumb relay for SDP/ICE —
// media flows peer-to-peer over WebRTC and never reaches us. Membership /
// "who-may-call-whom" reuses person_chat_rooms (a call happens within a room).
//
// The acting person is resolved from the connected user by the /ws/call handler
// before any of these methods are called.

import { callRepository } from "../../repositories/callRepository";
import { personChatRepository } from "../../repositories/personChatRepository";
import { personRepository } from "../../repositories/personRepository";
import {
  broadcastToPerson,
  broadcastToCall,
  broadcastSubscribeToCall,
} from "./callFanout";
import {
  getContactById,
  resolveContactPersonId,
  resolveStudentInstitute,
  ensureCallRoom,
} from "./callContacts";
import { isPersonOnline } from "../realtime/room-registry";
import { publishFocus, publishUtterance } from "../dual-agent/conversation-room";
import type { CallMediaFlags, CallSignal } from "@shared/realtime-events";

export const CALL_PERSON_TOPIC = (personId: string) => `call:person:${personId}`;
export const CALL_TOPIC = (callId: string) => `call:${callId}`;

const RING_TIMEOUT_MS = 30_000;

export class CallError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "CallError";
  }
}

export class CallService {
  // Ring timers keyed by callId. NOTE: setTimeout does not survive the Lambda
  // post-response freeze, so on the Lambda path the caller's client also enforces
  // its own ring timeout (sends call:cancel). On ECS these fire normally.
  private ringTimers = new Map<string, NodeJS.Timeout>();

  private clearRingTimer(callId: string): void {
    const t = this.ringTimers.get(callId);
    if (t) {
      clearTimeout(t);
      this.ringTimers.delete(callId);
    }
  }

  /** student facet → 'aac', user facet → 'caretaker'. */
  private async resolveRole(personId: string): Promise<string> {
    const person = await personRepository.getById(personId);
    return person?.studentId ? "aac" : "caretaker";
  }

  // ---------- Invite / ring ----------

  /** Room-based invite: caller must already be a member of the room. */
  async invite(actingPersonId: string, input: { callId: string; roomId: string; media: CallMediaFlags }): Promise<void> {
    const isMember = await personChatRepository.isParticipant(input.roomId, actingPersonId);
    if (!isMember) throw new CallError("not_a_member", "Not a participant in this room");
    const room = await personChatRepository.getRoomById(input.roomId);
    if (!room) throw new CallError("no_room", "Room not found");
    await this.startSession(actingPersonId, { callId: input.callId, roomId: input.roomId, instituteId: room.instituteId, media: input.media });
  }

  /**
   * Contact-based invite: a student calls one of their *callable* contacts.
   * Authorized by the callable link (not institute-sharing); the call room is
   * provisioned on the fly. Used by the AAC "Phone call" app and the AI tool.
   */
  async inviteContact(actingPersonId: string, input: { callId: string; contactId: string; media: CallMediaFlags }): Promise<void> {
    const contact = await getContactById(input.contactId);
    if (!contact || !contact.isActive || !contact.callable) {
      throw new CallError("not_callable", "That contact is not callable");
    }
    // A callable contact is a BIDIRECTIONAL link between the student and the
    // linked person — either side may place the call; the other side is rung.
    const studentPerson = await personRepository.getByStudentId(contact.studentId);
    const contactPersonId = await resolveContactPersonId(contact);
    if (!studentPerson || !contactPersonId) {
      throw new CallError("no_person", "Contact is not linked to a person");
    }
    let calleePersonId: string;
    if (actingPersonId === studentPerson.id) calleePersonId = contactPersonId;
    else if (actingPersonId === contactPersonId) calleePersonId = studentPerson.id;
    else throw new CallError("not_allowed", "Not a party to this contact");

    if (!isPersonOnline(calleePersonId)) {
      throw new CallError("offline", "That person is not available right now");
    }
    const instituteId = await resolveStudentInstitute(contact.studentId);
    if (!instituteId) throw new CallError("no_institute", "Student has no institute");
    const roomId = await ensureCallRoom(studentPerson.id, contactPersonId, instituteId);
    await this.startSession(actingPersonId, { callId: input.callId, roomId, instituteId, media: input.media });
  }

  /** Shared session creation + ring fan-out for both invite paths. */
  private async startSession(actingPersonId: string, input: { callId: string; roomId: string; instituteId: string; media: CallMediaFlags }): Promise<void> {
    const role = await this.resolveRole(actingPersonId);
    await callRepository.createSession({
      callId: input.callId,
      roomId: input.roomId,
      instituteId: input.instituteId,
      initiatedByPersonId: actingPersonId,
      mode: "aac_caretaker",
      media: input.media,
    });

    // Initiator joins immediately and subscribes to the call topic.
    await callRepository.addParticipant({ callId: input.callId, personId: actingPersonId, role, joined: true });
    await broadcastSubscribeToCall(actingPersonId, input.callId);

    // Ring every other active room participant.
    const participants = await personChatRepository.getRoomParticipants(input.roomId);
    const fromName = await personRepository.getDisplayName(actingPersonId);
    const callees = participants.map((p) => p.personId).filter((id) => id !== actingPersonId);
    for (const callee of callees) {
      const calleeRole = await this.resolveRole(callee);
      await callRepository.addParticipant({ callId: input.callId, personId: callee, role: calleeRole, joined: false });
      await broadcastToPerson(callee, {
        type: "call:ringing",
        topic: CALL_PERSON_TOPIC(callee),
        payload: { callId: input.callId, roomId: input.roomId, fromPersonId: actingPersonId, fromName, media: input.media },
      });
    }

    // Ring timeout → missed (best-effort; see note on ringTimers).
    const timer = setTimeout(() => {
      this.expireRing(input.callId).catch((err) => console.error("[call] expireRing:", err));
    }, RING_TIMEOUT_MS);
    this.ringTimers.set(input.callId, timer);
  }

  private async expireRing(callId: string): Promise<void> {
    this.clearRingTimer(callId);
    const session = await callRepository.getSession(callId);
    if (!session || session.status !== "ringing") return;
    await callRepository.setStatus(callId, "missed", "missed");
    await this.notifyEnded(callId, "missed");
  }

  // ---------- Accept / decline / cancel ----------

  async accept(actingPersonId: string, input: { callId: string }): Promise<void> {
    const session = await callRepository.getSession(input.callId);
    if (!session) throw new CallError("no_call", "Call not found");
    if (session.status !== "ringing" && session.status !== "active") {
      throw new CallError("call_over", `Call is ${session.status}`);
    }
    const participant = await callRepository.getParticipant(input.callId, actingPersonId);
    if (!participant) throw new CallError("not_invited", "Not invited to this call");

    const role = await this.resolveRole(actingPersonId);
    await callRepository.markJoined(input.callId, actingPersonId, role);
    if (session.status === "ringing") {
      await callRepository.setStatus(input.callId, "active");
      this.clearRingTimer(input.callId);
    }
    await broadcastSubscribeToCall(actingPersonId, input.callId);

    await broadcastToCall(input.callId, {
      type: "call:accepted",
      topic: CALL_TOPIC(input.callId),
      payload: { callId: input.callId, byPersonId: actingPersonId },
    });
    await broadcastToCall(input.callId, {
      type: "call:peer-joined",
      topic: CALL_TOPIC(input.callId),
      payload: { callId: input.callId, personId: actingPersonId, role, media: session.media as CallMediaFlags },
    });
  }

  async decline(actingPersonId: string, input: { callId: string; reason?: string }): Promise<void> {
    const session = await callRepository.getSession(input.callId);
    if (!session) throw new CallError("no_call", "Call not found");
    // Mark the decliner as no longer pending.
    await callRepository.markLeft(input.callId, actingPersonId);
    await broadcastToCall(input.callId, {
      type: "call:declined",
      topic: CALL_TOPIC(input.callId),
      payload: { callId: input.callId, byPersonId: actingPersonId, reason: input.reason },
    });
    await this.endIfUnderpopulated(input.callId, "declined");
  }

  async cancel(actingPersonId: string, input: { callId: string }): Promise<void> {
    const session = await callRepository.getSession(input.callId);
    if (!session) throw new CallError("no_call", "Call not found");
    if (session.initiatedByPersonId !== actingPersonId) {
      throw new CallError("not_initiator", "Only the caller can cancel");
    }
    this.clearRingTimer(input.callId);
    await callRepository.setStatus(input.callId, "cancelled", "cancelled");

    // Notify still-ringing callees on their personal topic, and anyone already
    // on the call topic.
    const participants = await callRepository.listParticipants(input.callId);
    for (const p of participants) {
      if (p.personId === actingPersonId) continue;
      await broadcastToPerson(p.personId, {
        type: "call:cancelled",
        topic: CALL_PERSON_TOPIC(p.personId),
        payload: { callId: input.callId },
      });
    }
    await broadcastToCall(input.callId, {
      type: "call:cancelled",
      topic: CALL_TOPIC(input.callId),
      payload: { callId: input.callId },
    });
  }

  // ---------- In-call: signal / media-state / leave ----------

  async signal(actingPersonId: string, input: { callId: string; to: string; signal: CallSignal }): Promise<void> {
    await this.assertActiveParticipant(input.callId, actingPersonId);
    // Relayed verbatim; each client filters on toPersonId === self.
    await broadcastToCall(input.callId, {
      type: "call:signal",
      topic: CALL_TOPIC(input.callId),
      payload: { callId: input.callId, fromPersonId: actingPersonId, toPersonId: input.to, signal: input.signal },
    });
  }

  async mediaState(actingPersonId: string, input: { callId: string; audio: boolean; video: boolean; pose: boolean }): Promise<void> {
    await this.assertActiveParticipant(input.callId, actingPersonId);
    const media = { audio: input.audio, video: input.video, pose: input.pose };
    await callRepository.updateMediaState(input.callId, actingPersonId, media);
    await broadcastToCall(input.callId, {
      type: "call:media-state",
      topic: CALL_TOPIC(input.callId),
      payload: { callId: input.callId, personId: actingPersonId, ...media },
    });
  }

  /**
   * A caller declares who they're addressing in a multi-party call — relayed
   * into the conversation room (roomId === callId) so the addressed AAC
   * student's AI can prepare a response. The conversation room may have members
   * the caller isn't (AAC coordinators); focus only needs to REACH them.
   */
  async focus(actingPersonId: string, input: { callId: string; to: string | null }): Promise<void> {
    await this.assertActiveParticipant(input.callId, actingPersonId);
    const fromName = await personRepository.getDisplayName(actingPersonId);
    publishFocus({ roomId: input.callId, fromPersonId: actingPersonId, fromName, targetPersonId: input.to });
  }

  /** Is this person a (non-left) participant of the call? */
  async isParticipant(callId: string, personId: string): Promise<boolean> {
    const p = await callRepository.getParticipant(callId, personId);
    return !!p && !p.leftAt;
  }

  /**
   * A non-student caller's transcribed speech → published into the conversation
   * room (roomId === callId) as an utterance, so every AAC student in the call
   * perceives it through their Observer + Board Manager (same path as a peer's
   * AAC utterance). `addressee` is the caller's current focus (a personId) or
   * "ROOM".
   */
  async utterance(actingPersonId: string, input: { callId: string; text: string; addressee: string }): Promise<void> {
    await this.assertActiveParticipant(input.callId, actingPersonId);
    const fromName = await personRepository.getDisplayName(actingPersonId);
    publishUtterance({
      roomId: input.callId,
      fromPersonId: actingPersonId,
      fromName,
      text: input.text,
      addressee: input.addressee || "ROOM",
      at: Date.now(),
    });
  }

  /** Active participants of a call with display names, for the in-call addressee
   *  picker. Excludes participants who have left. */
  async listParticipantsWithNames(callId: string): Promise<Array<{ personId: string; name: string }>> {
    const all = await callRepository.listParticipants(callId);
    const active = all.filter((p) => !p.leftAt);
    return Promise.all(
      active.map(async (p) => ({ personId: p.personId, name: await personRepository.getDisplayName(p.personId) })),
    );
  }

  async leave(actingPersonId: string, input: { callId: string }): Promise<void> {
    await callRepository.markLeft(input.callId, actingPersonId);
    await broadcastToCall(input.callId, {
      type: "call:peer-left",
      topic: CALL_TOPIC(input.callId),
      payload: { callId: input.callId, personId: actingPersonId },
    });
    await this.endIfUnderpopulated(input.callId, "ended");
  }

  // ---------- Helpers ----------

  private async assertActiveParticipant(callId: string, personId: string): Promise<void> {
    const p = await callRepository.getParticipant(callId, personId);
    // Gate on having a (non-left) participant row — a row exists for the caller
    // and every rung callee, so both are legitimate signaling parties. We do NOT
    // require joinedAt: offer/ICE fire the instant a callee sets its local
    // description, which can be processed concurrently with its own call:accept
    // (WS message handlers aren't serialized), so requiring joinedAt would drop
    // the offer and wedge the call at "connecting".
    if (!p || p.leftAt) {
      throw new CallError("not_in_call", "Not a participant in this call");
    }
  }

  /** End the call once fewer than 2 are connected and none are still ringing. */
  private async endIfUnderpopulated(callId: string, reason: string): Promise<void> {
    const session = await callRepository.getSession(callId);
    if (!session || ["ended", "missed", "declined", "cancelled"].includes(session.status)) return;
    const all = await callRepository.listParticipants(callId);
    const active = all.filter((p) => p.joinedAt && !p.leftAt);
    const pending = all.filter((p) => !p.joinedAt && !p.leftAt); // still ringing
    if (active.length < 2 && pending.length === 0) {
      this.clearRingTimer(callId);
      await callRepository.setStatus(callId, reason === "declined" ? "declined" : "ended", reason);
      await this.notifyEnded(callId, reason);
    }
  }

  private async notifyEnded(callId: string, reason: string): Promise<void> {
    await broadcastToCall(callId, {
      type: "call:ended",
      topic: CALL_TOPIC(callId),
      payload: { callId, reason },
    });
  }
}

export const callService = new CallService();
