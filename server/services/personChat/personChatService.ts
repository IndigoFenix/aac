// server/services/personChat/personChatService.ts
// Orchestrates person-chat operations. Enforces same-institute authorization
// and publishes realtime events. Persistence lives in personChatRepository.
//
// Members are `persons`. The HTTP layer authenticates a `user` and resolves it
// to the user's own person (getOrCreateForUser) before calling in — acting as a
// student is deferred to the call/AAC client.

import { personChatRepository } from "../../repositories/personChatRepository";
import { personRepository } from "../../repositories/personRepository";
import { pushNotifier } from "./pushNotifier";
import { storage } from "../../storage";
import type { PersonChat, PersonChatRoom } from "@shared/schema";
import { db } from "../../db";
import { personChatPushTokens, personChatRoomParticipants } from "@shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
  broadcastMessage,
  broadcastRoomCreated,
  broadcastSubscribePerson,
  broadcastUnread,
} from "./personChatFanout";

export const ROOM_TOPIC = (roomId: string) => `personChat:room:${roomId}`;
export const PERSON_TOPIC = (personId: string) => `personChat:person:${personId}`;

export class PersonChatAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonChatAuthorizationError";
  }
}

export class PersonChatService {
  /**
   * Create a room. For `isDirect` with 2 participants, returns an existing
   * direct room if one already exists between the two persons in this institute.
   */
  async createRoom(input: {
    requesterPersonId: string;
    instituteId: string;
    participantPersonIds: string[]; // must include requesterPersonId
    name?: string | null;
  }): Promise<PersonChatRoom> {
    const participantSet = new Set(input.participantPersonIds);
    participantSet.add(input.requesterPersonId);
    const participants = Array.from(participantSet);

    if (participants.length < 2) {
      throw new PersonChatAuthorizationError("A chat requires at least 2 participants");
    }

    // Every participant must share the given institute with the requester.
    for (const other of participants) {
      if (other === input.requesterPersonId) continue;
      const shared = await personChatRepository.personsShareInstitute(
        input.requesterPersonId,
        other,
        input.instituteId,
      );
      if (!shared) {
        throw new PersonChatAuthorizationError(
          `Person ${other} does not share institute ${input.instituteId} with requester`,
        );
      }
    }

    const isDirect = participants.length === 2;
    if (isDirect) {
      const [a, b] = participants;
      const existing = await personChatRepository.findDirectRoom(input.instituteId, a, b);
      if (existing) return existing;
    }

    const room = await personChatRepository.createRoom({
      instituteId: input.instituteId,
      createdByPersonId: input.requesterPersonId,
      participantPersonIds: participants,
      name: input.name ?? null,
      isDirect,
    });

    // Subscribe each participant's currently-open sockets (on any instance) to
    // the new room topic, and notify them so clients can refresh their room
    // list without a reload.
    for (const personId of participants) {
      await broadcastSubscribePerson(personId, ROOM_TOPIC(room.id));
      await broadcastRoomCreated(personId, room.id);
    }

    return room;
  }

  async sendMessage(input: {
    requesterPersonId: string;
    roomId: string;
    body: string;
    clientId?: string;
  }): Promise<PersonChat> {
    const body = input.body.trim();
    if (!body) throw new PersonChatAuthorizationError("Message body is empty");

    const isMember = await personChatRepository.isParticipant(input.roomId, input.requesterPersonId);
    if (!isMember) throw new PersonChatAuthorizationError("Not a participant in this room");

    const message = await personChatRepository.insertMessage({
      roomId: input.roomId,
      senderPersonId: input.requesterPersonId,
      body,
    });

    // Broadcast the message to room subscribers on every instance. Only the
    // message id crosses the bus; bodies are fetched from Postgres locally.
    await broadcastMessage(input.roomId, message.id, input.clientId);

    // Update per-recipient unread counts via each recipient's personal topic.
    const participants = await personChatRepository.getRoomParticipants(input.roomId);
    for (const p of participants) {
      if (p.personId === input.requesterPersonId) continue;
      const unread = await personChatRepository.countUnread(input.roomId, p.personId, p.lastReadAt);
      await broadcastUnread(p.personId, input.roomId, unread);
    }

    // Fire-and-forget push (stub). Recipient persons are resolved to delivery
    // targets (user facets) inside the notifier.
    const senderName = await this.resolvePersonName(input.requesterPersonId);
    pushNotifier.notifyNewMessage(
      participants.filter((p) => p.personId !== input.requesterPersonId).map((p) => p.personId),
      message,
      senderName,
    ).catch((err) => console.error("[personChat] push error:", err));

    return message;
  }

  async markRead(input: { requesterPersonId: string; roomId: string }): Promise<void> {
    const isMember = await personChatRepository.isParticipant(input.roomId, input.requesterPersonId);
    if (!isMember) throw new PersonChatAuthorizationError("Not a participant in this room");
    await personChatRepository.markRead(input.roomId, input.requesterPersonId);
    await broadcastUnread(input.requesterPersonId, input.roomId, 0);
  }

  async getMessages(input: {
    requesterPersonId: string;
    roomId: string;
    before?: string;
    limit?: number;
  }): Promise<PersonChat[]> {
    const isMember = await personChatRepository.isParticipant(input.roomId, input.requesterPersonId);
    if (!isMember) throw new PersonChatAuthorizationError("Not a participant in this room");
    const before = input.before ? new Date(input.before) : null;
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    return personChatRepository.getMessages(input.roomId, before, limit);
  }

  /**
   * Returns the set of topics a person should auto-subscribe to on WS connect:
   * their personal topic plus each room they participate in.
   */
  async initialTopicsForPerson(personId: string): Promise<string[]> {
    const rows = await db
      .select({ roomId: personChatRoomParticipants.roomId })
      .from(personChatRoomParticipants)
      .where(and(eq(personChatRoomParticipants.personId, personId), isNull(personChatRoomParticipants.leftAt)));
    return [PERSON_TOPIC(personId), ...rows.map((r) => ROOM_TOPIC(r.roomId))];
  }

  /** Human-readable name for a person (user facet name, else student name). */
  private async resolvePersonName(personId: string): Promise<string> {
    const person = await personRepository.getById(personId);
    if (person?.userId) {
      const user = await storage.getUser(person.userId);
      if (user) return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email;
    }
    return "Someone";
  }

  // ---------- Push tokens (keyed on the device-owning user) ----------

  async registerPushToken(userId: string, token: string, platform: string): Promise<void> {
    await db
      .insert(personChatPushTokens)
      .values({ userId, token, platform })
      .onConflictDoNothing();
    await pushNotifier.registerToken(userId, token, platform);
  }
}

export const personChatService = new PersonChatService();
