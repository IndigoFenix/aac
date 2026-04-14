// server/repositories/userChatRepository.ts
// Repository for clinician-to-clinician chat (rooms + messages).

import {
  userChatRooms,
  userChatRoomParticipants,
  userChats,
  users,
  instituteUsers,
  type UserChatRoom,
  type UserChat,
  type UserChatRoomParticipant,
} from "@shared/schema";
import { db } from "../db";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

export interface RoomListEntry {
  room: UserChatRoom;
  participants: Array<{ userId: string; firstName: string | null; lastName: string | null; email: string }>;
  lastMessage: UserChat | null;
  unreadCount: number;
  lastReadAt: Date | null;
}

export class UserChatRepository {
  // ---------- Rooms ----------

  async createRoom(input: {
    instituteId: string;
    createdBy: string;
    participantIds: string[];
    name?: string | null;
    isDirect: boolean;
  }): Promise<UserChatRoom> {
    return await db.transaction(async (tx) => {
      const [room] = await tx
        .insert(userChatRooms)
        .values({
          instituteId: input.instituteId,
          createdBy: input.createdBy,
          name: input.name ?? null,
          isDirect: input.isDirect,
        })
        .returning();

      const rows = input.participantIds.map((userId) => ({ roomId: room.id, userId }));
      await tx.insert(userChatRoomParticipants).values(rows);
      return room;
    });
  }

  /**
   * Find an existing direct (1:1) room between exactly these two users in the
   * given institute. Used for dedup on `POST /rooms` with 2 participants.
   */
  async findDirectRoom(
    instituteId: string,
    userIdA: string,
    userIdB: string,
  ): Promise<UserChatRoom | null> {
    const rows = await db
      .select({ room: userChatRooms })
      .from(userChatRooms)
      .innerJoin(
        userChatRoomParticipants,
        eq(userChatRoomParticipants.roomId, userChatRooms.id),
      )
      .where(
        and(
          eq(userChatRooms.instituteId, instituteId),
          eq(userChatRooms.isDirect, true),
          inArray(userChatRoomParticipants.userId, [userIdA, userIdB]),
        ),
      );

    // Group by room id; keep rooms where both users are participants and the
    // room has exactly 2 participants total.
    const byRoom = new Map<string, { room: UserChatRoom; participants: Set<string> }>();
    for (const r of rows) {
      const entry = byRoom.get(r.room.id) ?? { room: r.room, participants: new Set<string>() };
      byRoom.set(r.room.id, entry);
    }
    for (const roomId of byRoom.keys()) {
      const all = await db
        .select({ userId: userChatRoomParticipants.userId })
        .from(userChatRoomParticipants)
        .where(eq(userChatRoomParticipants.roomId, roomId));
      const ids = new Set(all.map((a) => a.userId));
      if (ids.size === 2 && ids.has(userIdA) && ids.has(userIdB)) {
        return byRoom.get(roomId)!.room;
      }
    }
    return null;
  }

  async getRoomById(roomId: string): Promise<UserChatRoom | null> {
    const [row] = await db.select().from(userChatRooms).where(eq(userChatRooms.id, roomId));
    return row ?? null;
  }

  async getRoomParticipants(roomId: string): Promise<UserChatRoomParticipant[]> {
    return db
      .select()
      .from(userChatRoomParticipants)
      .where(and(eq(userChatRoomParticipants.roomId, roomId), isNull(userChatRoomParticipants.leftAt)));
  }

  async isParticipant(roomId: string, userId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: userChatRoomParticipants.id })
      .from(userChatRoomParticipants)
      .where(
        and(
          eq(userChatRoomParticipants.roomId, roomId),
          eq(userChatRoomParticipants.userId, userId),
          isNull(userChatRoomParticipants.leftAt),
        ),
      );
    return !!row;
  }

  async addParticipant(roomId: string, userId: string): Promise<void> {
    await db
      .insert(userChatRoomParticipants)
      .values({ roomId, userId })
      .onConflictDoNothing();
  }

  async removeParticipant(roomId: string, userId: string): Promise<void> {
    await db
      .update(userChatRoomParticipants)
      .set({ leftAt: new Date() })
      .where(and(eq(userChatRoomParticipants.roomId, roomId), eq(userChatRoomParticipants.userId, userId)));
  }

  async listRoomsForUser(userId: string): Promise<RoomListEntry[]> {
    // Rooms where user is an active participant
    const roomRows = await db
      .select({ room: userChatRooms, lastReadAt: userChatRoomParticipants.lastReadAt })
      .from(userChatRoomParticipants)
      .innerJoin(userChatRooms, eq(userChatRooms.id, userChatRoomParticipants.roomId))
      .where(
        and(
          eq(userChatRoomParticipants.userId, userId),
          isNull(userChatRoomParticipants.leftAt),
        ),
      )
      .orderBy(desc(userChatRooms.lastMessageAt));

    const entries: RoomListEntry[] = [];
    for (const { room, lastReadAt } of roomRows) {
      const participants = await db
        .select({
          userId: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
        })
        .from(userChatRoomParticipants)
        .innerJoin(users, eq(users.id, userChatRoomParticipants.userId))
        .where(
          and(
            eq(userChatRoomParticipants.roomId, room.id),
            isNull(userChatRoomParticipants.leftAt),
          ),
        );

      const [lastMessage] = await db
        .select()
        .from(userChats)
        .where(and(eq(userChats.roomId, room.id), isNull(userChats.deletedAt)))
        .orderBy(desc(userChats.createdAt))
        .limit(1);

      const unreadCount = await this.countUnread(room.id, userId, lastReadAt);

      entries.push({
        room,
        participants,
        lastMessage: lastMessage ?? null,
        unreadCount,
        lastReadAt: lastReadAt ?? null,
      });
    }
    return entries;
  }

  async countUnread(roomId: string, userId: string, lastReadAt: Date | null): Promise<number> {
    const conditions = [eq(userChats.roomId, roomId), isNull(userChats.deletedAt), sql`${userChats.senderId} <> ${userId}`];
    if (lastReadAt) conditions.push(sql`${userChats.createdAt} > ${lastReadAt}`);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(userChats)
      .where(and(...conditions));
    return Number(count) || 0;
  }

  // ---------- Messages ----------

  async insertMessage(input: { roomId: string; senderId: string; body: string }): Promise<UserChat> {
    return await db.transaction(async (tx) => {
      const [msg] = await tx
        .insert(userChats)
        .values({ roomId: input.roomId, senderId: input.senderId, body: input.body })
        .returning();
      await tx
        .update(userChatRooms)
        .set({ lastMessageAt: msg.createdAt })
        .where(eq(userChatRooms.id, input.roomId));
      return msg;
    });
  }

  async getMessages(roomId: string, before: Date | null, limit: number): Promise<UserChat[]> {
    const conditions = [eq(userChats.roomId, roomId), isNull(userChats.deletedAt)];
    if (before) conditions.push(lt(userChats.createdAt, before));
    return db
      .select()
      .from(userChats)
      .where(and(...conditions))
      .orderBy(desc(userChats.createdAt))
      .limit(limit);
  }

  async markRead(roomId: string, userId: string, at: Date = new Date()): Promise<void> {
    await db
      .update(userChatRoomParticipants)
      .set({ lastReadAt: at })
      .where(and(eq(userChatRoomParticipants.roomId, roomId), eq(userChatRoomParticipants.userId, userId)));
  }

  // ---------- Contacts (shared institute) ----------

  /**
   * Users who share at least one institute with me. Returns distinct users
   * excluding self. If `instituteId` is provided, restricts to that institute.
   */
  async listContacts(userId: string, instituteId?: string): Promise<Array<{
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
    instituteIds: string[];
  }>> {
    // Institutes the caller belongs to (active memberships).
    const myInstitutesRows = await db
      .select({ instituteId: instituteUsers.instituteId })
      .from(instituteUsers)
      .where(and(eq(instituteUsers.userId, userId), eq(instituteUsers.isActive, true)));
    let myInstitutes = myInstitutesRows.map((r) => r.instituteId);
    if (instituteId) myInstitutes = myInstitutes.filter((id) => id === instituteId);
    if (myInstitutes.length === 0) return [];

    const rows = await db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        instituteId: instituteUsers.instituteId,
      })
      .from(instituteUsers)
      .innerJoin(users, eq(users.id, instituteUsers.userId))
      .where(
        and(
          inArray(instituteUsers.instituteId, myInstitutes),
          eq(instituteUsers.isActive, true),
          sql`${instituteUsers.userId} <> ${userId}`,
        ),
      );

    const byUser = new Map<string, { id: string; firstName: string | null; lastName: string | null; email: string; instituteIds: Set<string> }>();
    for (const r of rows) {
      const entry = byUser.get(r.id) ?? { id: r.id, firstName: r.firstName, lastName: r.lastName, email: r.email, instituteIds: new Set<string>() };
      entry.instituteIds.add(r.instituteId);
      byUser.set(r.id, entry);
    }
    return Array.from(byUser.values()).map((e) => ({
      id: e.id,
      firstName: e.firstName,
      lastName: e.lastName,
      email: e.email,
      instituteIds: Array.from(e.instituteIds),
    }));
  }

  /**
   * Check whether two users share an active membership in the given institute.
   * Used as the authorization predicate for creating chats.
   */
  async usersShareInstitute(userIdA: string, userIdB: string, instituteId: string): Promise<boolean> {
    const rows = await db
      .select({ userId: instituteUsers.userId })
      .from(instituteUsers)
      .where(
        and(
          eq(instituteUsers.instituteId, instituteId),
          eq(instituteUsers.isActive, true),
          inArray(instituteUsers.userId, [userIdA, userIdB]),
        ),
      );
    const ids = new Set(rows.map((r) => r.userId));
    return ids.has(userIdA) && ids.has(userIdB);
  }
}

export const userChatRepository = new UserChatRepository();
