/**
 * Coverage for server/services/credit-ledger.ts — the single sink for all
 * LLM/TTS usage-cost charges.
 *
 * Verifies:
 *  - creditsUsed accumulates on the session row, and chatCreditsUsed on the
 *    student/user rows, per charge.
 *  - cost_breakdown accumulates per function-type key (category), including
 *    repeat charges to the same key and multi-key `breakdown` splits.
 *  - zero/negative charges are no-ops.
 *  - charges without a sessionId still hit the user/student rows (e.g.
 *    interpretation, photo analysis, deep analysis).
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { asc, eq } from 'drizzle-orm';
import { truncateAll, db } from './helpers/db.js';
import { chatSessions, students, users, sessionCostEvents } from '@shared/schema';
import { makeUser, makeStudent } from './helpers/factories.js';
import { chargeCreditsToLedger, onLedgerCharge } from '../services/credit-ledger.js';
import { chatRepository } from '../repositories/chatRepository.js';

async function insertUser(): Promise<string> {
  const user = await makeUser();
  return user.id;
}

async function insertStudent(ownerUserId: string): Promise<string> {
  const { student } = await makeStudent(ownerUserId);
  return student.id;
}

async function insertSession(userId: string, studentId: string): Promise<string> {
  const [row] = await db
    .insert(chatSessions)
    .values({ chatMode: 'chat', state: {}, userId, studentId })
    .returning({ id: chatSessions.id });
  return row.id;
}

async function readSession(id: string) {
  const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, id));
  return row;
}

describe('chargeCreditsToLedger', () => {
  afterEach(async () => {
    await truncateAll();
  });

  it('accumulates creditsUsed and per-category cost_breakdown on the session', async () => {
    const userId = await insertUser();
    const studentId = await insertStudent(userId);
    const sessionId = await insertSession(userId, studentId);

    await chargeCreditsToLedger({ sessionId, studentId, userId, credits: 0.01, category: 'observer', label: 't1' });
    await chargeCreditsToLedger({ sessionId, studentId, userId, credits: 0.02, category: 'observer', label: 't2' });
    await chargeCreditsToLedger({ sessionId, studentId, userId, credits: 0.005, category: 'tts', label: 't3' });

    const session = await readSession(sessionId);
    expect(session.creditsUsed).toBeCloseTo(0.035, 9);
    const breakdown = session.costBreakdown as Record<string, number>;
    expect(breakdown.observer).toBeCloseTo(0.03, 9);
    expect(breakdown.tts).toBeCloseTo(0.005, 9);

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user.chatCreditsUsed).toBeCloseTo(0.035, 9);
    const [student] = await db.select().from(students).where(eq(students.id, studentId));
    expect(student.chatCreditsUsed).toBeCloseTo(0.035, 9);
  });

  it('splits a multi-key breakdown across categories', async () => {
    const userId = await insertUser();
    const studentId = await insertStudent(userId);
    const sessionId = await insertSession(userId, studentId);

    await chargeCreditsToLedger({
      sessionId,
      credits: 0.03,
      breakdown: { chat: 0.02, 'tool:generate_image': 0.01 },
      label: 'clinician turn',
    });

    const session = await readSession(sessionId);
    expect(session.creditsUsed).toBeCloseTo(0.03, 9);
    const breakdown = session.costBreakdown as Record<string, number>;
    expect(breakdown.chat).toBeCloseTo(0.02, 9);
    expect(breakdown['tool:generate_image']).toBeCloseTo(0.01, 9);
  });

  it('uses "other" when no category is given and ignores non-positive charges', async () => {
    const userId = await insertUser();
    const studentId = await insertStudent(userId);
    const sessionId = await insertSession(userId, studentId);

    await chargeCreditsToLedger({ sessionId, credits: 0.001, label: 'uncategorized' });
    await chargeCreditsToLedger({ sessionId, credits: 0, category: 'tts', label: 'zero' });
    await chargeCreditsToLedger({ sessionId, credits: -5, category: 'tts', label: 'negative' });

    const session = await readSession(sessionId);
    expect(session.creditsUsed).toBeCloseTo(0.001, 9);
    const breakdown = session.costBreakdown as Record<string, number>;
    expect(breakdown.other).toBeCloseTo(0.001, 9);
    expect(breakdown.tts).toBeUndefined();
  });

  it('charges user/student rows when there is no chat session (e.g. interpretation)', async () => {
    const userId = await insertUser();
    const studentId = await insertStudent(userId);

    await chargeCreditsToLedger({ studentId, userId, credits: 0.007, category: 'interpretation', label: 'no-session' });

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user.chatCreditsUsed).toBeCloseTo(0.007, 9);
    const [student] = await db.select().from(students).where(eq(students.id, studentId));
    expect(student.chatCreditsUsed).toBeCloseTo(0.007, 9);
  });
});

describe('onLedgerCharge — budget-meter feed', () => {
  afterEach(async () => {
    await truncateAll();
  });

  it('notifies the session listener of EVERY charge, regardless of category', async () => {
    const userId = await insertUser();
    const studentId = await insertStudent(userId);
    const sessionId = await insertSession(userId, studentId);

    const seen: Array<{ credits: number; category: string | undefined }> = [];
    const unsub = onLedgerCharge(sessionId, (credits, category) => seen.push({ credits, category }));

    // The exact mix that used to bypass the meter: live agent, Monitor (HTTP),
    // and TTS all land in the listener now.
    await chargeCreditsToLedger({ sessionId, studentId, userId, credits: 0.20, category: 'observer', label: 'live' });
    await chargeCreditsToLedger({ sessionId, studentId, userId, credits: 0.06, category: 'monitor', label: 'http' });
    await chargeCreditsToLedger({ sessionId, studentId, userId, credits: 0.03, category: 'tts', label: 'tts' });
    unsub();

    expect(seen.map(s => s.category)).toEqual(['observer', 'monitor', 'tts']);
    const total = seen.reduce((a, s) => a + s.credits, 0);
    expect(total).toBeCloseTo(0.29, 9); // matches the full session cost
  });

  it('does not fire for non-positive charges, after unsubscribe, or for other sessions', async () => {
    const userId = await insertUser();
    const studentId = await insertStudent(userId);
    const sessionId = await insertSession(userId, studentId);
    const otherSession = await insertSession(userId, studentId);

    let count = 0;
    const unsub = onLedgerCharge(sessionId, () => { count++; });

    await chargeCreditsToLedger({ sessionId, credits: 0, category: 'tts', label: 'zero' });        // non-positive
    await chargeCreditsToLedger({ sessionId: otherSession, credits: 0.05, label: 'other' });        // different session
    expect(count).toBe(0);

    await chargeCreditsToLedger({ sessionId, credits: 0.05, label: 'counted' });
    expect(count).toBe(1);

    unsub();
    await chargeCreditsToLedger({ sessionId, credits: 0.05, label: 'after-unsub' });
    expect(count).toBe(1); // unchanged
  });
});

describe('session_cost_events — per-charge time-series', () => {
  afterEach(async () => {
    await truncateAll();
  });

  async function readEvents(sessionId: string) {
    return db
      .select()
      .from(sessionCostEvents)
      .where(eq(sessionCostEvents.sessionId, sessionId))
      .orderBy(asc(sessionCostEvents.timestamp));
  }

  it('records one row per positive charge, in order, with category and credits', async () => {
    const userId = await insertUser();
    const studentId = await insertStudent(userId);
    const sessionId = await insertSession(userId, studentId);

    await chargeCreditsToLedger({ sessionId, studentId, userId, credits: 0.01, category: 'observer', label: 't1' });
    await chargeCreditsToLedger({ sessionId, studentId, userId, credits: 0.005, category: 'tts', label: 't2' });
    await chargeCreditsToLedger({ sessionId, credits: 0.002, label: 'uncategorized' });

    const events = await readEvents(sessionId);
    expect(events.map(e => e.category)).toEqual(['observer', 'tts', 'other']);
    expect(events.map(e => e.credits)).toEqual([
      expect.closeTo(0.01, 6), expect.closeTo(0.005, 6), expect.closeTo(0.002, 6),
    ]);
    // Sum of the time-series matches the aggregate running total.
    const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
    const seriesTotal = events.reduce((a, e) => a + e.credits, 0);
    expect(seriesTotal).toBeCloseTo(session.creditsUsed, 6);
  });

  it('persists token detail as typed columns when provided, null otherwise', async () => {
    const userId = await insertUser();
    const studentId = await insertStudent(userId);
    const sessionId = await insertSession(userId, studentId);

    await chargeCreditsToLedger({
      sessionId, credits: 0.02, category: 'monitor', label: 'http',
      tokenUsage: { model: 'gpt-x', promptTokens: 1200, completionTokens: 300, cachedTokens: 800 },
    });
    await chargeCreditsToLedger({ sessionId, credits: 0.003, category: 'tts', label: 'chars' });

    const [withTokens, withoutTokens] = await readEvents(sessionId);
    expect(withTokens.model).toBe('gpt-x');
    expect(withTokens.promptTokens).toBe(1200);
    expect(withTokens.completionTokens).toBe(300);
    expect(withTokens.cachedTokens).toBe(800);
    expect(withTokens.cacheCreationTokens).toBeNull();
    expect(withoutTokens.model).toBeNull();
    expect(withoutTokens.promptTokens).toBeNull();
  });

  it('does not record rows for non-positive charges', async () => {
    const userId = await insertUser();
    const studentId = await insertStudent(userId);
    const sessionId = await insertSession(userId, studentId);

    await chargeCreditsToLedger({ sessionId, credits: 0, category: 'tts', label: 'zero' });
    await chargeCreditsToLedger({ sessionId, credits: -1, category: 'tts', label: 'negative' });

    expect(await readEvents(sessionId)).toHaveLength(0);
  });

  it('cascades on session delete and prunes by timestamp', async () => {
    const userId = await insertUser();
    const studentId = await insertStudent(userId);
    const sessionId = await insertSession(userId, studentId);
    const otherSession = await insertSession(userId, studentId);

    await chargeCreditsToLedger({ sessionId, credits: 0.01, category: 'observer', label: 'a' });
    await chargeCreditsToLedger({ sessionId: otherSession, credits: 0.02, category: 'observer', label: 'b' });

    // Prune everything older than "now + 1 minute" — removes both rows.
    const future = new Date(Date.now() + 60_000);
    const pruned = await chatRepository.deleteSessionCostEventsBefore(future);
    expect(pruned).toBe(2);
    expect(await readEvents(sessionId)).toHaveLength(0);

    // FK cascade: a fresh event then deleting the parent session removes it.
    await chargeCreditsToLedger({ sessionId, credits: 0.01, category: 'observer', label: 'c' });
    expect(await readEvents(sessionId)).toHaveLength(1);
    await db.delete(chatSessions).where(eq(chatSessions.id, sessionId));
    expect(await readEvents(sessionId)).toHaveLength(0);
  });
});
