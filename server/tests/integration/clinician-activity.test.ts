/**
 * Integration tests for the clinician activity tracker:
 * - heartbeat state machine (extend / roll on gap / roll on context change)
 * - tab-close beacon
 * - getClinicianTimeRollup totals (idle cap, period clipping, hadInteractive gate)
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
import { clinicianActivityIntervals, chatSessions } from '@shared/schema';
import { eq, desc, and, isNull } from 'drizzle-orm';
import {
  recordHeartbeat,
  closeOpenInterval,
  ACTIVITY_IDLE_CAP_SECONDS,
} from '../../services/insurance/clinicianActivityService.js';
import {
  getClinicianTimeRollup,
  __test as rollupTest,
} from '../../services/insurance/clinicianTimeRollupService.js';

const { intervalEffectiveEnd, clippedIntervalSeconds } = rollupTest;

async function getOpenInterval(userId: string) {
  const [row] = await db
    .select()
    .from(clinicianActivityIntervals)
    .where(
      and(
        eq(clinicianActivityIntervals.userId, userId),
        isNull(clinicianActivityIntervals.endedAt),
      ),
    )
    .orderBy(desc(clinicianActivityIntervals.lastHeartbeatAt))
    .limit(1);
  return row ?? null;
}

async function getAllIntervals(userId: string) {
  return db
    .select()
    .from(clinicianActivityIntervals)
    .where(eq(clinicianActivityIntervals.userId, userId))
    .orderBy(clinicianActivityIntervals.startedAt);
}

describe('clinicianActivityService.recordHeartbeat', () => {
  afterEach(truncateAll);

  it('opens a new interval when none exists', async () => {
    const user = await makeUser();
    const id = await recordHeartbeat({
      userId: user.id,
      studentId: null,
      instituteId: null,
    });
    expect(id).toBeDefined();
    const open = await getOpenInterval(user.id);
    expect(open?.id).toBe(id);
    expect(open?.endedAt).toBeNull();
  });

  it('extends the open interval when same context and small gap', async () => {
    const user = await makeUser();
    const id1 = await recordHeartbeat({ userId: user.id, studentId: null, instituteId: null });
    const id2 = await recordHeartbeat({ userId: user.id, studentId: null, instituteId: null });
    expect(id2).toBe(id1);
    const all = await getAllIntervals(user.id);
    expect(all).toHaveLength(1);
  });

  it('rolls a new interval when student context changes', async () => {
    const user = await makeUser();
    const { student: a } = await makeStudent(user.id);
    const { student: b } = await makeStudent(user.id);

    const id1 = await recordHeartbeat({
      userId: user.id,
      studentId: a.id,
      instituteId: null,
    });
    const id2 = await recordHeartbeat({
      userId: user.id,
      studentId: b.id,
      instituteId: null,
    });
    expect(id2).not.toBe(id1);
    const all = await getAllIntervals(user.id);
    expect(all).toHaveLength(2);
    // First interval should be closed, second open
    expect(all[0].endedAt).not.toBeNull();
    expect(all[0].studentId).toBe(a.id);
    expect(all[1].endedAt).toBeNull();
    expect(all[1].studentId).toBe(b.id);
  });

  it('rolls a new interval when gap exceeds idle cap', async () => {
    const user = await makeUser();
    const id1 = await recordHeartbeat({ userId: user.id, studentId: null, instituteId: null });

    // Backdate the row's last_heartbeat_at past the idle cap.
    const stale = new Date(Date.now() - (ACTIVITY_IDLE_CAP_SECONDS + 5) * 1000);
    await db
      .update(clinicianActivityIntervals)
      .set({ lastHeartbeatAt: stale, startedAt: stale })
      .where(eq(clinicianActivityIntervals.id, id1));

    const id2 = await recordHeartbeat({ userId: user.id, studentId: null, instituteId: null });
    expect(id2).not.toBe(id1);

    const [closed] = await db
      .select()
      .from(clinicianActivityIntervals)
      .where(eq(clinicianActivityIntervals.id, id1));
    expect(closed.endedAt).not.toBeNull();
    // Closed at the idle cap, not at "now".
    const cappedEnd = new Date(stale.getTime() + ACTIVITY_IDLE_CAP_SECONDS * 1000);
    expect(closed.endedAt!.getTime()).toBe(cappedEnd.getTime());
  });
});

describe('closeOpenInterval', () => {
  afterEach(truncateAll);

  it('closes the open interval and marks tab_closed=true', async () => {
    const user = await makeUser();
    const id = await recordHeartbeat({ userId: user.id, studentId: null, instituteId: null });
    await closeOpenInterval(user.id, true);
    const [row] = await db
      .select()
      .from(clinicianActivityIntervals)
      .where(eq(clinicianActivityIntervals.id, id));
    expect(row.endedAt).not.toBeNull();
    expect(row.tabClosed).toBe(true);
  });

  it('is a no-op when there is no open interval', async () => {
    const user = await makeUser();
    await expect(closeOpenInterval(user.id, false)).resolves.toBeUndefined();
  });
});

describe('intervalEffectiveEnd / clippedIntervalSeconds', () => {
  it('uses ended_at directly when set', () => {
    const end = intervalEffectiveEnd({
      endedAt: new Date('2026-05-15T12:00:00Z'),
      lastHeartbeatAt: new Date('2026-05-15T11:00:00Z'),
    });
    expect(end.toISOString()).toBe('2026-05-15T12:00:00.000Z');
  });

  it('caps open intervals at last_heartbeat + 60s', () => {
    const end = intervalEffectiveEnd({
      endedAt: null,
      lastHeartbeatAt: new Date('2026-05-15T11:00:00Z'),
    });
    expect(end.toISOString()).toBe('2026-05-15T11:01:00.000Z');
  });

  it('clips an interval to the period bounds', () => {
    const seconds = clippedIntervalSeconds(
      {
        startedAt: new Date('2026-04-30T23:30:00Z'),
        endedAt: new Date('2026-05-01T00:30:00Z'),
        lastHeartbeatAt: new Date('2026-05-01T00:30:00Z'),
      },
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z'),
    );
    expect(seconds).toBe(1800); // only the half-hour after midnight counts
  });
});

describe('getClinicianTimeRollup', () => {
  afterEach(truncateAll);

  it('aggregates intervals per student, applies idle cap, and surfaces hadInteractive', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: 'clinic' });
    const { student } = await makeStudent(owner.id);
    await enrollStudent(institute.id, student.id, owner.id);

    // Two closed intervals: 600s + 300s = 900s = 15 min
    await db.insert(clinicianActivityIntervals).values([
      {
        userId: owner.id,
        studentId: student.id,
        instituteId: institute.id,
        startedAt: new Date('2026-05-15T10:00:00Z'),
        lastHeartbeatAt: new Date('2026-05-15T10:10:00Z'),
        endedAt: new Date('2026-05-15T10:10:00Z'),
      },
      {
        userId: owner.id,
        studentId: student.id,
        instituteId: institute.id,
        startedAt: new Date('2026-05-16T10:00:00Z'),
        lastHeartbeatAt: new Date('2026-05-16T10:05:00Z'),
        endedAt: new Date('2026-05-16T10:05:00Z'),
      },
    ] as any);

    // One billable AAC session in the period — should set hadInteractive=true.
    await db.insert(chatSessions).values({
      userId: owner.id,
      studentId: student.id,
      chatMode: 'aac',
      state: {},
      log: [{ role: 'user' }, { role: 'assistant' }],
      creditsUsed: 0.1,
      started: new Date('2026-05-15T11:00:00Z'),
      lastUpdate: new Date('2026-05-15T11:30:00Z'),
    } as any);

    const rollup = await getClinicianTimeRollup({
      instituteId: institute.id,
      period: '2026-05',
    });
    expect(rollup.students).toHaveLength(1);
    const row = rollup.students[0];
    expect(row.totalSeconds).toBe(900);
    expect(row.intervalCount).toBe(2);
    expect(row.hadInteractive).toBe(true);
  });

  it('caps an open interval at last_heartbeat + 60s rather than "now"', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: 'clinic' });
    const { student } = await makeStudent(owner.id);
    await enrollStudent(institute.id, student.id, owner.id);

    // Open interval — last_heartbeat 5 minutes after start
    await db.insert(clinicianActivityIntervals).values({
      userId: owner.id,
      studentId: student.id,
      instituteId: institute.id,
      startedAt: new Date('2026-05-15T10:00:00Z'),
      lastHeartbeatAt: new Date('2026-05-15T10:05:00Z'),
      endedAt: null,
    } as any);

    const rollup = await getClinicianTimeRollup({
      instituteId: institute.id,
      period: '2026-05',
    });
    // 5 minutes wall + 60s idle cap = 360 seconds
    expect(rollup.students[0].totalSeconds).toBe(360);
  });

  it('reports hadInteractive=false when no billable AAC session exists', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: 'clinic' });
    const { student } = await makeStudent(owner.id);
    await enrollStudent(institute.id, student.id, owner.id);

    await db.insert(clinicianActivityIntervals).values({
      userId: owner.id,
      studentId: student.id,
      instituteId: institute.id,
      startedAt: new Date('2026-05-15T10:00:00Z'),
      lastHeartbeatAt: new Date('2026-05-15T10:10:00Z'),
      endedAt: new Date('2026-05-15T10:10:00Z'),
    } as any);

    const rollup = await getClinicianTimeRollup({
      instituteId: institute.id,
      period: '2026-05',
    });
    expect(rollup.students[0].hadInteractive).toBe(false);
    expect(rollup.students[0].totalSeconds).toBe(600);
  });

  it('rejects malformed periods', async () => {
    await expect(
      getClinicianTimeRollup({ instituteId: 'x', period: '2026' }),
    ).rejects.toThrow(/YYYY-MM/);
  });
});
