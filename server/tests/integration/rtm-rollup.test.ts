/**
 * Integration test for getRtmRollup: end-to-end exercise of the SQL queries,
 * the billable-session predicate, and per-student bucketing.
 *
 * Uses the real Postgres test DB (server/tests/global-setup.ts).
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { truncateAll } from '../helpers/db.js';
import {
  makeUser,
  makeInstitute,
  makeStudent,
  enrollStudent,
} from '../helpers/factories.js';
import { db } from '../../db.js';
import { chatSessions, activityLogs, institutes } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { getRtmRollup } from '../../services/insurance/rtmRollupService.js';

async function seedSession(opts: {
  userId: string;
  studentId: string;
  startedIso: string;
  lastUpdateIso: string;
  creditsUsed?: number;
  log?: any[];
}): Promise<void> {
  await db.insert(chatSessions).values({
    userId: opts.userId,
    studentId: opts.studentId,
    chatMode: 'aac',
    state: {},
    log: opts.log ?? [],
    creditsUsed: opts.creditsUsed ?? 0,
    started: new Date(opts.startedIso),
    lastUpdate: new Date(opts.lastUpdateIso),
  } as any);
}

async function seedSleepEvent(studentId: string, atIso: string, toState: string): Promise<void> {
  await db.insert(activityLogs).values({
    eventType: 'aac_sleep_state_change',
    subjectType1: 'student',
    subjectId1: studentId,
    details: { toState },
    createdAt: new Date(atIso),
  } as any);
}

describe('getRtmRollup integration', () => {
  afterEach(truncateAll);

  it('aggregates billable AAC sessions by local-tz day, subtracting sleep', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: 'clinic' });
    await db.update(institutes)
      .set({ timezone: 'America/New_York' })
      .where(eq(institutes.id, institute.id));

    const { student } = await makeStudent(owner.id);
    await enrollStudent(institute.id, student.id, owner.id);

    // Day 1 — billable, 1 hour wall, 5 minutes sleep → 3300s billable
    await seedSession({
      userId: owner.id,
      studentId: student.id,
      startedIso: '2026-05-15T18:00:00Z', // 14:00 NY
      lastUpdateIso: '2026-05-15T19:00:00Z', // 15:00 NY
      creditsUsed: 0.5,
    });
    await seedSleepEvent(student.id, '2026-05-15T18:30:00Z', 'asleep');
    await seedSleepEvent(student.id, '2026-05-15T18:35:00Z', 'awake');

    // Day 2 — billable via log length (creditsUsed=0)
    await seedSession({
      userId: owner.id,
      studentId: student.id,
      startedIso: '2026-05-16T13:00:00Z',
      lastUpdateIso: '2026-05-16T13:30:00Z',
      log: [{ role: 'user' }, { role: 'assistant' }],
    });

    // Day 3 — NOT billable (creditsUsed=0, log too short) — should be filtered
    await seedSession({
      userId: owner.id,
      studentId: student.id,
      startedIso: '2026-05-17T13:00:00Z',
      lastUpdateIso: '2026-05-17T13:30:00Z',
    });

    const rollup = await getRtmRollup({ instituteId: institute.id, period: '2026-05' });

    expect(rollup.timezone).toBe('America/New_York');
    expect(rollup.students).toHaveLength(1);
    const row = rollup.students[0];
    expect(row.studentId).toBe(student.id);
    expect(row.daysActive).toBe(2);          // day 1 + day 2; day 3 not billable
    expect(row.sessionCount).toBe(2);
    // Day 1: 3600s wall - 300s sleep = 3300s. Day 2: 1800s. Total: 5100s.
    expect(row.serviceSeconds).toBe(5100);
  });

  it('returns zero rows for students with no billable sessions', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: 'clinic' });
    const { student } = await makeStudent(owner.id);
    await enrollStudent(institute.id, student.id, owner.id);

    const rollup = await getRtmRollup({ instituteId: institute.id, period: '2026-05' });
    expect(rollup.students).toHaveLength(1);
    expect(rollup.students[0].daysActive).toBe(0);
    expect(rollup.students[0].serviceSeconds).toBe(0);
    expect(rollup.students[0].sessionCount).toBe(0);
  });

  it('falls back to UTC when institute has no timezone set', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: 'clinic' });
    const rollup = await getRtmRollup({ instituteId: institute.id, period: '2026-05' });
    expect(rollup.timezone).toBe('UTC');
  });

  it('rejects malformed period strings', async () => {
    await expect(
      getRtmRollup({ instituteId: 'whatever', period: '2026-5' }),
    ).rejects.toThrow(/YYYY-MM/);
    await expect(
      getRtmRollup({ instituteId: 'whatever', period: '2026-13' }),
    ).rejects.toThrow(/YYYY-MM/);
  });
});
