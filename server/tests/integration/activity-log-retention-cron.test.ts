/**
 * Tests for the daily activity-log retention cron.
 *
 * Verifies:
 *   - Per-institute retention reads from the institute's compliance regime.
 *     A row older than the regime's `auditRetentionDays` is deleted; one
 *     within the window survives.
 *   - Orphan rows (instituteId IS NULL — e.g. failed-login attempts) use
 *     the strictest known retention across the whole regime registry.
 *   - Institutes with no regime fall back to a 1-year retention.
 *   - Idempotency: a second run on the same data is a no-op.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { truncateAll, db } from '../helpers/db.js';
import { makeUser, makeInstitute, makeLicense } from '../helpers/factories.js';
import { activityLogs } from '@shared/schema';
import { runActivityLogRetentionCheck } from '../../services/activityLogRetentionCron.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function insertLog(opts: {
  instituteId: string | null;
  userId: string | null;
  ageDays: number;
}) {
  const createdAt = new Date(Date.now() - opts.ageDays * ONE_DAY_MS);
  const [row] = await db
    .insert(activityLogs)
    .values({
      instituteId: opts.instituteId,
      userId: opts.userId,
      eventType: 'auth_login_failure',
      subjectType1: 'user',
      subjectId1: opts.userId,
      details: { source: 'test' },
      createdAt,
    } as any)
    .returning();
  return row;
}

async function logExists(id: string): Promise<boolean> {
  const [r] = await db.select().from(activityLogs).where(eq(activityLogs.id, id));
  return !!r;
}

describe('activity-log retention cron', () => {
  afterEach(truncateAll);

  it('prunes orphan rows past the strictest retention (7y) and keeps newer ones', async () => {
    // 8-year-old orphan row (older than 7y il_moe/uk_dfe ceiling) — should be deleted.
    const oldOrphan = await insertLog({ instituteId: null, userId: null, ageDays: 365 * 8 });
    // 6-year-old orphan row — within the 7y ceiling — should survive.
    const newOrphan = await insertLog({ instituteId: null, userId: null, ageDays: 365 * 6 });

    const result = await runActivityLogRetentionCheck();
    expect(result.globalDeleted).toBe(1);
    expect(await logExists(oldOrphan.id)).toBe(false);
    expect(await logExists(newOrphan.id)).toBe(true);
  });

  it('uses regime-driven retention for an institute with il_moe (7y)', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: 'school' });
    await makeLicense({
      instituteId: institute.id,
      permissions: {
        all: true,
        complianceRegimes: ['il_moe'],
      } as any,
    });

    // 8 years old — past il_moe's 7y window — delete
    const old = await insertLog({ instituteId: institute.id, userId: owner.id, ageDays: 365 * 8 });
    // 6 years old — within il_moe's 7y window — survive
    const recent = await insertLog({ instituteId: institute.id, userId: owner.id, ageDays: 365 * 6 });

    const result = await runActivityLogRetentionCheck();
    expect(result.perInstituteDeleted).toBe(1);
    expect(await logExists(old.id)).toBe(false);
    expect(await logExists(recent.id)).toBe(true);
  });

  it('falls back to 1-year retention when an institute has no regime', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id);
    // No license / no regime → 1-year fallback.

    // 2 years old — past 1y — delete
    const old = await insertLog({ instituteId: institute.id, userId: owner.id, ageDays: 365 * 2 });
    // 6 months old — within 1y — survive
    const recent = await insertLog({ instituteId: institute.id, userId: owner.id, ageDays: 180 });

    await runActivityLogRetentionCheck();
    expect(await logExists(old.id)).toBe(false);
    expect(await logExists(recent.id)).toBe(true);
  });

  it('is idempotent — second run is a no-op', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id);
    await insertLog({ instituteId: institute.id, userId: owner.id, ageDays: 365 * 2 });
    await insertLog({ instituteId: null, userId: null, ageDays: 365 * 8 });

    const r1 = await runActivityLogRetentionCheck();
    const r2 = await runActivityLogRetentionCheck();

    expect(r1.globalDeleted + r1.perInstituteDeleted).toBeGreaterThan(0);
    expect(r2.globalDeleted + r2.perInstituteDeleted).toBe(0);
  });

  it('reports institutesScanned even when nothing is deleted', async () => {
    const owner = await makeUser();
    await makeInstitute(owner.id);
    await makeInstitute(owner.id);

    const result = await runActivityLogRetentionCheck();
    expect(result.institutesScanned).toBe(2);
  });
});
