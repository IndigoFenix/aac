/**
 * Chat session helpers — used by student-switching and permission tests.
 */

import { db } from '../../db.js';
import { chatSessions } from '@shared/schema';
import { eq } from 'drizzle-orm';

export async function createChatSession(
  userId: string,
  studentId: string | null,
  opts: { chatMode?: string } = {},
): Promise<{ id: string; userId: string | null; studentId: string | null }> {
  const [session] = await db
    .insert(chatSessions)
    .values({
      userId,
      studentId,
      chatMode: opts.chatMode ?? 'chat',
      state: {},
    } as any)
    .returning();
  return { id: session.id, userId: session.userId, studentId: session.studentId };
}

export async function switchActiveStudent(
  sessionId: string,
  newStudentId: string,
): Promise<void> {
  await db
    .update(chatSessions)
    .set({ studentId: newStudentId, updatedAt: new Date() } as any)
    .where(eq(chatSessions.id, sessionId));
}

export async function getSessionStudentId(
  sessionId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ studentId: chatSessions.studentId })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  return row?.studentId ?? null;
}
