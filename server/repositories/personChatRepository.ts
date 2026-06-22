// server/repositories/personChatRepository.ts
// Repository for person-to-person chat (rooms + messages). Members are `persons`
// (user and/or student facets). Institute/contact authorization resolves a
// person to its user facet (student facets are deferred — they return no shared
// institute for now, so students can't yet initiate person-chat rooms).

import {
  personChatRooms,
  personChatRoomParticipants,
  personChats,
  persons,
  users,
  students,
  instituteUsers,
  type PersonChatRoom,
  type PersonChat,
  type PersonChatRoomParticipant,
} from "@shared/schema";
import { db } from "../db";
import { personRepository } from "./personRepository";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

export interface RoomParticipantInfo {
  personId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
}

export interface RoomListEntry {
  room: PersonChatRoom;
  participants: RoomParticipantInfo[];
  lastMessage: PersonChat | null;
  unreadCount: number;
  lastReadAt: Date | null;
}

export class PersonChatRepository {
  // ---------- Rooms ----------

  async createRoom(input: {
    instituteId: string;
    createdByPersonId: string;
    participantPersonIds: string[];
    name?: string | null;
    isDirect: boolean;
  }): Promise<PersonChatRoom> {
    return await db.transaction(async (tx) => {
      const [room] = await tx
        .insert(personChatRooms)
        .values({
          instituteId: input.instituteId,
          createdByPersonId: input.createdByPersonId,
          name: input.name ?? null,
          isDirect: input.isDirect,
        })
        .returning();

      const rows = input.participantPersonIds.map((personId) => ({ roomId: room.id, personId }));
      await tx.insert(personChatRoomParticipants).values(rows);
      return room;
    });
  }

  /**
   * Find an existing direct (1:1) room between exactly these two persons in the
   * given institute. Used for dedup on `POST /rooms` with 2 participants.
   */
  async findDirectRoom(
    instituteId: string,
    personIdA: string,
    personIdB: string,
  ): Promise<PersonChatRoom | null> {
    const rows = await db
      .select({ room: personChatRooms })
      .from(personChatRooms)
      .innerJoin(
        personChatRoomParticipants,
        eq(personChatRoomParticipants.roomId, personChatRooms.id),
      )
      .where(
        and(
          eq(personChatRooms.instituteId, instituteId),
          eq(personChatRooms.isDirect, true),
          inArray(personChatRoomParticipants.personId, [personIdA, personIdB]),
        ),
      );

    // Group by room id; keep rooms where both persons are participants and the
    // room has exactly 2 participants total.
    const byRoom = new Map<string, { room: PersonChatRoom }>();
    for (const r of rows) {
      if (!byRoom.has(r.room.id)) byRoom.set(r.room.id, { room: r.room });
    }
    for (const roomId of byRoom.keys()) {
      const all = await db
        .select({ personId: personChatRoomParticipants.personId })
        .from(personChatRoomParticipants)
        .where(eq(personChatRoomParticipants.roomId, roomId));
      const ids = new Set(all.map((a) => a.personId));
      if (ids.size === 2 && ids.has(personIdA) && ids.has(personIdB)) {
        return byRoom.get(roomId)!.room;
      }
    }
    return null;
  }

  async getRoomById(roomId: string): Promise<PersonChatRoom | null> {
    const [row] = await db.select().from(personChatRooms).where(eq(personChatRooms.id, roomId));
    return row ?? null;
  }

  async getRoomParticipants(roomId: string): Promise<PersonChatRoomParticipant[]> {
    return db
      .select()
      .from(personChatRoomParticipants)
      .where(and(eq(personChatRoomParticipants.roomId, roomId), isNull(personChatRoomParticipants.leftAt)));
  }

  async isParticipant(roomId: string, personId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: personChatRoomParticipants.id })
      .from(personChatRoomParticipants)
      .where(
        and(
          eq(personChatRoomParticipants.roomId, roomId),
          eq(personChatRoomParticipants.personId, personId),
          isNull(personChatRoomParticipants.leftAt),
        ),
      );
    return !!row;
  }

  async addParticipant(roomId: string, personId: string): Promise<void> {
    await db
      .insert(personChatRoomParticipants)
      .values({ roomId, personId })
      .onConflictDoNothing();
  }

  async removeParticipant(roomId: string, personId: string): Promise<void> {
    await db
      .update(personChatRoomParticipants)
      .set({ leftAt: new Date() })
      .where(and(eq(personChatRoomParticipants.roomId, roomId), eq(personChatRoomParticipants.personId, personId)));
  }

  async listRoomsForPerson(personId: string): Promise<RoomListEntry[]> {
    // Rooms where the person is an active participant
    const roomRows = await db
      .select({ room: personChatRooms, lastReadAt: personChatRoomParticipants.lastReadAt })
      .from(personChatRoomParticipants)
      .innerJoin(personChatRooms, eq(personChatRooms.id, personChatRoomParticipants.roomId))
      .where(
        and(
          eq(personChatRoomParticipants.personId, personId),
          isNull(personChatRoomParticipants.leftAt),
        ),
      )
      .orderBy(desc(personChatRooms.lastMessageAt));

    const entries: RoomListEntry[] = [];
    for (const { room, lastReadAt } of roomRows) {
      const participants = await this.getRoomParticipantInfo(room.id);

      const [lastMessage] = await db
        .select()
        .from(personChats)
        .where(and(eq(personChats.roomId, room.id), isNull(personChats.deletedAt)))
        .orderBy(desc(personChats.createdAt))
        .limit(1);

      const unreadCount = await this.countUnread(room.id, personId, lastReadAt);

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

  /**
   * Display info for a room's active participants. Resolves each person to its
   * user facet (name/email) and falls back to the student facet's name.
   */
  private async getRoomParticipantInfo(roomId: string): Promise<RoomParticipantInfo[]> {
    const rows = await db
      .select({
        personId: persons.id,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        userEmail: users.email,
        studentName: students.name,
      })
      .from(personChatRoomParticipants)
      .innerJoin(persons, eq(persons.id, personChatRoomParticipants.personId))
      .leftJoin(users, eq(users.id, persons.userId))
      .leftJoin(students, eq(students.id, persons.studentId))
      .where(
        and(
          eq(personChatRoomParticipants.roomId, roomId),
          isNull(personChatRoomParticipants.leftAt),
        ),
      );

    return rows.map((r) => ({
      personId: r.personId,
      firstName: r.userFirstName ?? r.studentName ?? null,
      lastName: r.userLastName ?? null,
      email: r.userEmail ?? "",
    }));
  }

  async countUnread(roomId: string, personId: string, lastReadAt: Date | null): Promise<number> {
    const conditions = [eq(personChats.roomId, roomId), isNull(personChats.deletedAt), sql`${personChats.senderPersonId} <> ${personId}`];
    if (lastReadAt) conditions.push(sql`${personChats.createdAt} > ${lastReadAt}`);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(personChats)
      .where(and(...conditions));
    return Number(count) || 0;
  }

  // ---------- Messages ----------

  async insertMessage(input: { roomId: string; senderPersonId: string; body: string }): Promise<PersonChat> {
    return await db.transaction(async (tx) => {
      const [msg] = await tx
        .insert(personChats)
        .values({ roomId: input.roomId, senderPersonId: input.senderPersonId, body: input.body })
        .returning();
      await tx
        .update(personChatRooms)
        .set({ lastMessageAt: msg.createdAt })
        .where(eq(personChatRooms.id, input.roomId));
      return msg;
    });
  }

  async getMessageById(messageId: string): Promise<PersonChat | null> {
    const [row] = await db.select().from(personChats).where(eq(personChats.id, messageId));
    return row ?? null;
  }

  async getMessages(roomId: string, before: Date | null, limit: number): Promise<PersonChat[]> {
    const conditions = [eq(personChats.roomId, roomId), isNull(personChats.deletedAt)];
    if (before) conditions.push(lt(personChats.createdAt, before));
    return db
      .select()
      .from(personChats)
      .where(and(...conditions))
      .orderBy(desc(personChats.createdAt))
      .limit(limit);
  }

  async markRead(roomId: string, personId: string, at: Date = new Date()): Promise<void> {
    await db
      .update(personChatRoomParticipants)
      .set({ lastReadAt: at })
      .where(and(eq(personChatRoomParticipants.roomId, roomId), eq(personChatRoomParticipants.personId, personId)));
  }

  // ---------- Contacts (shared institute) ----------

  /**
   * Persons who share at least one institute with me. Resolves my person to its
   * user facet, finds other users in shared institutes, and maps each back to a
   * person (provisioning one if needed). If `instituteId` is provided, restricts
   * to that institute. A person without a user facet returns no contacts (yet).
   */
  async listContacts(personId: string, instituteId?: string): Promise<Array<{
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
    instituteIds: string[];
  }>> {
    const myUserId = await personRepository.getUserId(personId);
    if (!myUserId) return [];

    // Institutes the caller belongs to (active memberships).
    const myInstitutesRows = await db
      .select({ instituteId: instituteUsers.instituteId })
      .from(instituteUsers)
      .where(and(eq(instituteUsers.userId, myUserId), eq(instituteUsers.isActive, true)));
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
          sql`${instituteUsers.userId} <> ${myUserId}`,
        ),
      );

    const byUser = new Map<string, { id: string; firstName: string | null; lastName: string | null; email: string; instituteIds: Set<string> }>();
    for (const r of rows) {
      const entry = byUser.get(r.id) ?? { id: r.id, firstName: r.firstName, lastName: r.lastName, email: r.email, instituteIds: new Set<string>() };
      entry.instituteIds.add(r.instituteId);
      byUser.set(r.id, entry);
    }

    // Map each contact user → its person (the chat identity the client uses).
    const out: Array<{ id: string; firstName: string | null; lastName: string | null; email: string; instituteIds: string[] }> = [];
    for (const e of byUser.values()) {
      const person = await personRepository.getOrCreateForUser(e.id);
      out.push({
        id: person.id,
        firstName: e.firstName,
        lastName: e.lastName,
        email: e.email,
        instituteIds: Array.from(e.instituteIds),
      });
    }
    return out;
  }

  /**
   * Whether two persons share an active membership in the given institute, via
   * their user facets. Used as the authorization predicate for creating chats.
   */
  async personsShareInstitute(personIdA: string, personIdB: string, instituteId: string): Promise<boolean> {
    const userIdA = await personRepository.getUserId(personIdA);
    const userIdB = await personRepository.getUserId(personIdB);
    if (!userIdA || !userIdB) return false;
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

export const personChatRepository = new PersonChatRepository();
