// server/repositories/callRepository.ts
// Persistence for live-call lifecycle (sessions + participants). Signaling
// (SDP/ICE) is transient and never stored — only call state/history lives here.

import {
  callSessions,
  callParticipants,
  type CallSession,
  type CallParticipant,
} from "@shared/schema";
import { db } from "../db";
import { and, eq, isNull, isNotNull } from "drizzle-orm";

export class CallRepository {
  // ---------- Sessions ----------

  async createSession(input: {
    callId?: string; // client-generated id; omit to let the DB generate one
    roomId: string;
    instituteId: string;
    initiatedByPersonId: string;
    mode: string;
    media: { audio: boolean; video: boolean; pose: boolean };
  }): Promise<CallSession> {
    const [row] = await db
      .insert(callSessions)
      .values({
        ...(input.callId ? { id: input.callId } : {}),
        roomId: input.roomId,
        instituteId: input.instituteId,
        initiatedByPersonId: input.initiatedByPersonId,
        mode: input.mode,
        status: "ringing",
        media: input.media,
      })
      .returning();
    return row;
  }

  async getSession(callId: string): Promise<CallSession | null> {
    const [row] = await db.select().from(callSessions).where(eq(callSessions.id, callId));
    return row ?? null;
  }

  /** Attach (or, with null, detach) a social game on the call session. */
  async setGame(callId: string, game: unknown | null): Promise<void> {
    await db.update(callSessions).set({ game }).where(eq(callSessions.id, callId));
  }

  async setStatus(callId: string, status: string, endedReason?: string): Promise<void> {
    const patch: Partial<CallSession> = { status };
    if (status === "ended" || status === "missed" || status === "declined" || status === "cancelled") {
      patch.endedAt = new Date();
      if (endedReason) patch.endedReason = endedReason;
    }
    await db.update(callSessions).set(patch).where(eq(callSessions.id, callId));
  }

  // ---------- Participants ----------

  /** Insert a participant row (idempotent on (callId, personId)). */
  async addParticipant(input: {
    callId: string;
    personId: string;
    role?: string | null;
    joined?: boolean;
  }): Promise<void> {
    await db
      .insert(callParticipants)
      .values({
        callId: input.callId,
        personId: input.personId,
        role: input.role ?? null,
        joinedAt: input.joined ? new Date() : null,
      })
      .onConflictDoNothing();
  }

  async getParticipant(callId: string, personId: string): Promise<CallParticipant | null> {
    const [row] = await db
      .select()
      .from(callParticipants)
      .where(and(eq(callParticipants.callId, callId), eq(callParticipants.personId, personId)));
    return row ?? null;
  }

  async markJoined(callId: string, personId: string, role?: string | null): Promise<void> {
    const patch: Partial<CallParticipant> = { joinedAt: new Date(), leftAt: null };
    if (role !== undefined) patch.role = role;
    await db
      .update(callParticipants)
      .set(patch)
      .where(and(eq(callParticipants.callId, callId), eq(callParticipants.personId, personId)));
  }

  async markLeft(callId: string, personId: string): Promise<void> {
    await db
      .update(callParticipants)
      .set({ leftAt: new Date() })
      .where(and(eq(callParticipants.callId, callId), eq(callParticipants.personId, personId)));
  }

  async updateMediaState(
    callId: string,
    personId: string,
    mediaState: { audio: boolean; video: boolean; pose: boolean },
  ): Promise<void> {
    await db
      .update(callParticipants)
      .set({ mediaState })
      .where(and(eq(callParticipants.callId, callId), eq(callParticipants.personId, personId)));
  }

  async listParticipants(callId: string): Promise<CallParticipant[]> {
    return db.select().from(callParticipants).where(eq(callParticipants.callId, callId));
  }

  /** Participants who have joined and not left — i.e. currently in the call. */
  async listActiveParticipants(callId: string): Promise<CallParticipant[]> {
    return db
      .select()
      .from(callParticipants)
      .where(
        and(
          eq(callParticipants.callId, callId),
          isNotNull(callParticipants.joinedAt),
          isNull(callParticipants.leftAt),
        ),
      );
  }
}

export const callRepository = new CallRepository();
