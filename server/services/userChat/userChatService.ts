// server/services/userChat/userChatService.ts
// Orchestrates user-chat operations. Enforces same-institute authorization
// and publishes realtime events. Persistence lives in userChatRepository.

import { userChatRepository } from "../../repositories/userChatRepository";
import { publish, subscribeUserToTopic } from "../realtime/room-registry";
import { pushNotifier } from "./pushNotifier";
import { storage } from "../../storage";
import type { UserChat, UserChatRoom } from "@shared/schema";
import type { UserChatEvent } from "@shared/realtime-events";
import { db } from "../../db";
import { userChatPushTokens, userChatRoomParticipants, users } from "@shared/schema";
import { and, eq, isNull } from "drizzle-orm";

export const ROOM_TOPIC = (roomId: string) => `userChat:room:${roomId}`;
export const USER_TOPIC = (userId: string) => `userChat:user:${userId}`;

export class UserChatAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserChatAuthorizationError";
  }
}

export class UserChatService {
  /**
   * Create a room. For `isDirect` with 2 participants, returns an existing
   * direct room if one already exists between the two users in this institute.
   */
  async createRoom(input: {
    requesterId: string;
    instituteId: string;
    participantIds: string[]; // must include requesterId
    name?: string | null;
  }): Promise<UserChatRoom> {
    const participantSet = new Set(input.participantIds);
    participantSet.add(input.requesterId);
    const participants = Array.from(participantSet);

    if (participants.length < 2) {
      throw new UserChatAuthorizationError("A chat requires at least 2 participants");
    }

    // Every participant must share the given institute with the requester.
    for (const other of participants) {
      if (other === input.requesterId) continue;
      const shared = await userChatRepository.usersShareInstitute(
        input.requesterId,
        other,
        input.instituteId,
      );
      if (!shared) {
        throw new UserChatAuthorizationError(
          `User ${other} does not share institute ${input.instituteId} with requester`,
        );
      }
    }

    const isDirect = participants.length === 2;
    if (isDirect) {
      const [a, b] = participants;
      const existing = await userChatRepository.findDirectRoom(input.instituteId, a, b);
      if (existing) return existing;
    }

    const room = await userChatRepository.createRoom({
      instituteId: input.instituteId,
      createdBy: input.requesterId,
      participantIds: participants,
      name: input.name ?? null,
      isDirect,
    });

    // Subscribe each participant's currently-open sockets to the new room topic
    // and notify them so clients can refresh their room list without a reload.
    for (const userId of participants) {
      subscribeUserToTopic(userId, ROOM_TOPIC(room.id));
      publish(USER_TOPIC(userId), {
        type: "userChat:roomCreated",
        topic: USER_TOPIC(userId),
        payload: { roomId: room.id },
      });
    }

    return room;
  }

  async sendMessage(input: {
    requesterId: string;
    roomId: string;
    body: string;
    clientId?: string;
  }): Promise<UserChat> {
    const body = input.body.trim();
    if (!body) throw new UserChatAuthorizationError("Message body is empty");

    const isMember = await userChatRepository.isParticipant(input.roomId, input.requesterId);
    if (!isMember) throw new UserChatAuthorizationError("Not a participant in this room");

    const message = await userChatRepository.insertMessage({
      roomId: input.roomId,
      senderId: input.requesterId,
      body,
    });

    // Broadcast to room topic
    const event: UserChatEvent = {
      type: "userChat:message",
      topic: ROOM_TOPIC(input.roomId),
      payload: {
        id: message.id,
        roomId: message.roomId,
        senderId: message.senderId,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
        clientId: input.clientId,
      },
    };
    publish(ROOM_TOPIC(input.roomId), event);

    // Update per-recipient unread counts via each recipient's personal topic.
    const participants = await userChatRepository.getRoomParticipants(input.roomId);
    for (const p of participants) {
      if (p.userId === input.requesterId) continue;
      const unread = await userChatRepository.countUnread(input.roomId, p.userId, p.lastReadAt);
      publish(USER_TOPIC(p.userId), {
        type: "userChat:unread",
        topic: USER_TOPIC(p.userId),
        payload: { roomId: input.roomId, unreadCount: unread },
      });
    }

    // Fire-and-forget push (stub).
    const sender = await storage.getUser(input.requesterId);
    const senderName = sender
      ? [sender.firstName, sender.lastName].filter(Boolean).join(" ") || sender.email
      : "A user";
    pushNotifier.notifyNewMessage(
      participants.filter((p) => p.userId !== input.requesterId).map((p) => p.userId),
      message,
      senderName,
    ).catch((err) => console.error("[userChat] push error:", err));

    return message;
  }

  async markRead(input: { requesterId: string; roomId: string }): Promise<void> {
    const isMember = await userChatRepository.isParticipant(input.roomId, input.requesterId);
    if (!isMember) throw new UserChatAuthorizationError("Not a participant in this room");
    await userChatRepository.markRead(input.roomId, input.requesterId);

    publish(USER_TOPIC(input.requesterId), {
      type: "userChat:unread",
      topic: USER_TOPIC(input.requesterId),
      payload: { roomId: input.roomId, unreadCount: 0 },
    });
  }

  async getMessages(input: {
    requesterId: string;
    roomId: string;
    before?: string;
    limit?: number;
  }): Promise<UserChat[]> {
    const isMember = await userChatRepository.isParticipant(input.roomId, input.requesterId);
    if (!isMember) throw new UserChatAuthorizationError("Not a participant in this room");
    const before = input.before ? new Date(input.before) : null;
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    return userChatRepository.getMessages(input.roomId, before, limit);
  }

  /**
   * Returns the set of topics a user should auto-subscribe to on WS connect:
   * their personal topic plus each room they participate in.
   */
  async initialTopicsForUser(userId: string): Promise<string[]> {
    const rows = await db
      .select({ roomId: userChatRoomParticipants.roomId })
      .from(userChatRoomParticipants)
      .where(and(eq(userChatRoomParticipants.userId, userId), isNull(userChatRoomParticipants.leftAt)));
    return [USER_TOPIC(userId), ...rows.map((r) => ROOM_TOPIC(r.roomId))];
  }

  // ---------- Push tokens ----------

  async registerPushToken(userId: string, token: string, platform: string): Promise<void> {
    await db
      .insert(userChatPushTokens)
      .values({ userId, token, platform })
      .onConflictDoNothing();
    await pushNotifier.registerToken(userId, token, platform);
  }
}

export const userChatService = new UserChatService();
