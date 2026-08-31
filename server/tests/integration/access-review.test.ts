/**
 * AKIM §2.8 — access review and revocation, end to end against the database.
 *
 * Three things are load-bearing here and none of them are visible from a pure
 * test:
 *   * the review endpoints report the REAL classification of REAL rows,
 *   * deactivating a user actually deletes their persisted sessions (a flag
 *     flip with a live cookie still in the sessions table is not revocation),
 *   * the weekly cron changes NOTHING while DORMANT_AUTO_DEACTIVATE_DAYS is
 *     unset, which is the default posture in production.
 *
 * The cron's alert channel is injected in EVERY call: the test environment
 * carries live SES credentials, so the default sender would mail a real
 * "dormant accounts" list to the ops mailbox.
 */

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { eq, and } from 'drizzle-orm';

import { truncateAll, db } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/http.js';
import { makeUser, makeInstitute, makeStudent, addUserToInstitute } from '../helpers/factories.js';
import { userRepository } from '../../repositories/userRepository.js';
import { adminUserRepository } from '../../repositories/adminUserRepository.js';
import { accessReviewController } from '../../controllers/accessReviewController.js';
import { runAccessReview, type AlertSender } from '../../services/accessReviewCron.js';
import { AUTO_DEACTIVATE_ENV_VAR } from '../../services/access-review-policy.js';
import { sessions, activityLogs } from '@shared/schema';

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

/** Push a user's last-active stamp into the past so it reads as dormant. */
async function ageUser(userId: string, days: number): Promise<void> {
  await userRepository.updateUser(userId, { lastActiveAt: daysAgo(days) } as any);
}

/** A persisted login session for `userId`, in the shape connect-pg-simple writes. */
async function seedSession(userId: string, sid = `sid-${userId}-${Math.random()}`): Promise<string> {
  await db.insert(sessions).values({
    sid,
    sess: { cookie: {}, passport: { user: { kind: 'user', id: userId } } },
    expire: new Date(Date.now() + DAY_MS),
  } as any);
  return sid;
}

async function sessionCount(userId: string): Promise<number> {
  const rows = await db.select().from(sessions);
  return rows.filter(
    (r) => ((r.sess as any)?.passport?.user?.id ?? null) === userId,
  ).length;
}

/**
 * Captures the alert instead of sending it. NEVER omit this from a review
 * call — see the file header.
 */
function fakeAlerter() {
  const alerts: Array<{ subject: string; lines: string[] }> = [];
  const alert: AlertSender = async (subject, lines) => {
    alerts.push({ subject, lines });
    return { sent: true };
  };
  return { alert, alerts };
}

const originalEnv = process.env[AUTO_DEACTIVATE_ENV_VAR];

beforeEach(() => {
  delete process.env[AUTO_DEACTIVATE_ENV_VAR];
});

afterEach(async () => {
  if (originalEnv === undefined) delete process.env[AUTO_DEACTIVATE_ENV_VAR];
  else process.env[AUTO_DEACTIVATE_ENV_VAR] = originalEnv;
  await truncateAll();
});

// ===========================================================================
// The `last_active_at` stamp everything above is measured against
// ===========================================================================

describe('last_active_at freshness', () => {
  // Source-level, like auth-is-active.test.ts: the stamp lives inside the
  // passport.deserializeUser closure and is not otherwise reachable. Pinned
  // because the whole review is measured against this column — it was written
  // ONLY at fresh login, and with 7-day cookies that made a daily user look a
  // week idle. Every threshold above would have been reading noise.
  const src = readFileSync(
    path.join(process.cwd(), 'server', 'userAuth.ts'),
    'utf8',
  );

  it('refreshes the stamp on session deserialization, for both principal kinds', () => {
    expect(src).toMatch(/adminUserRepository\.getById[\s\S]{0,600}?stampLastActive\("admin"/);
    expect(src).toMatch(/storage\.getUser\(identity\.id\)[\s\S]{0,600}?stampLastActive\("user"/);
  });

  it('throttles the write to once per 15 minutes', () => {
    expect(src).toMatch(/LAST_ACTIVE_STAMP_INTERVAL_MS\s*=\s*15 \* 60 \* 1000/);
  });

  it('never awaits the stamp on the request path, and swallows its failures', () => {
    // Bookkeeping on every authenticated request must not be able to log
    // anybody out, and must not add a round-trip to the hot path.
    expect(src).toMatch(/void Promise\.resolve\(write\)\.catch\(/);
    expect(src).not.toMatch(/await stampLastActive/);
  });
});

// ===========================================================================
// GET /api/institutes/:id/access-review
// ===========================================================================

describe('institute access review', () => {
  it('lists members with classification and reachable-student counts', async () => {
    const admin = await makeUser();
    const { institute } = await makeInstitute(admin.id);
    const stale = await makeUser();
    await addUserToInstitute(institute.id, stale.id, { role: 'therapist' });
    await makeStudent(stale.id);
    await makeStudent(stale.id);
    await ageUser(stale.id, 200);

    const req = makeReq({ user: { id: admin.id }, params: { id: institute.id } });
    const { res, capture } = makeRes();
    await accessReviewController.getInstituteReview(req, res);

    expect(capture.statusCode).toBe(200);
    const body = capture.jsonBody as any;
    expect(body.dormantAfterDays).toBe(90);
    // Off by default in production; the report is the deliverable.
    expect(body.autoDeactivateAfterDays).toBeNull();

    const row = body.members.find((m: any) => m.userId === stale.id);
    expect(row).toBeDefined();
    expect(row.classification).toBe('dormant');
    expect(row.role).toBe('therapist');
    expect(row.isAdmin).toBe(false);
    expect(row.idleDays).toBeGreaterThanOrEqual(199);
    // The list is only actionable if it says what the account still reaches.
    expect(row.reachableStudents).toBe(2);

    const adminRow = body.members.find((m: any) => m.userId === admin.id);
    expect(adminRow.classification).toBe('active');
    expect(adminRow.isAdmin).toBe(true);
    expect(adminRow.reachableStudents).toBe(0);
  });

  it('refuses a member who is not an institute admin', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id);
    const member = await makeUser();
    await addUserToInstitute(institute.id, member.id);

    const req = makeReq({ user: { id: member.id }, params: { id: institute.id } });
    const { res, capture } = makeRes();
    await accessReviewController.getInstituteReview(req, res);

    expect(capture.statusCode).toBe(403);
  });

  it('records the review itself as a view — the evidence §2.8 asks for', async () => {
    const admin = await makeUser();
    const { institute } = await makeInstitute(admin.id);

    const req = makeReq({ user: { id: admin.id }, params: { id: institute.id } });
    const { res } = makeRes();
    await accessReviewController.getInstituteReview(req, res);

    // The log write is fire-and-forget; give it a tick to land.
    await new Promise((r) => setTimeout(r, 150));
    const rows = await db
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.eventType, 'view'), eq(activityLogs.subjectType1, 'institute')));
    const entry = rows.find((r) => r.subjectId1 === institute.id);
    expect(entry).toBeDefined();
    expect((entry!.details as any).route).toBe('institute.access-review');
    expect(entry!.userId).toBe(admin.id);
  });
});

// ===========================================================================
// GET /api/admin/access-review
// ===========================================================================

describe('global access review', () => {
  it('lists dormant users and dormant admins, and omits active ones', async () => {
    const actor = await makeUser({ isSystemAdmin: true });
    const dormant = await makeUser();
    const fresh = await makeUser();
    await ageUser(dormant.id, 120);

    await adminUserRepository.create({
      id: 'admin-dormant',
      email: 'dormant@aivota.ai',
      permissions: ['*'],
      lastActiveAt: daysAgo(400),
    } as any);
    await adminUserRepository.create({
      id: 'admin-fresh',
      email: 'fresh@aivota.ai',
      permissions: ['*'],
      lastActiveAt: new Date(),
    } as any);

    const req = makeReq({ user: { id: actor.id, isSystemAdmin: true } });
    const { res, capture } = makeRes();
    await accessReviewController.getGlobalReview(req, res);

    expect(capture.statusCode).toBe(200);
    const body = capture.jsonBody as any;
    const userIds = body.users.map((u: any) => u.userId);
    expect(userIds).toContain(dormant.id);
    expect(userIds).not.toContain(fresh.id);

    const adminIds = body.admins.map((a: any) => a.adminId);
    expect(adminIds).toContain('admin-dormant');
    expect(adminIds).not.toContain('admin-fresh');
    expect(body.admins.find((a: any) => a.adminId === 'admin-dormant').classification).toBe(
      'dormant',
    );
  });

  it('omits an already-deactivated account — it is not a pending decision', async () => {
    const actor = await makeUser({ isSystemAdmin: true });
    const off = await makeUser();
    await ageUser(off.id, 400);
    await userRepository.updateUser(off.id, { isActive: false } as any);

    const req = makeReq({ user: { id: actor.id } });
    const { res, capture } = makeRes();
    await accessReviewController.getGlobalReview(req, res);

    const userIds = (capture.jsonBody as any).users.map((u: any) => u.userId);
    expect(userIds).not.toContain(off.id);
  });
});

// ===========================================================================
// PATCH /api/admin/users/:id  { isActive }
// ===========================================================================

describe('user deactivation', () => {
  function nextSpy() {
    const calls: unknown[] = [];
    const next = ((err?: unknown) => {
      calls.push(err ?? null);
    }) as any;
    return { next, calls };
  }

  it('deactivates a user and evicts every persisted session', async () => {
    const actor = await makeUser({ isSystemAdmin: true });
    const target = await makeUser();
    await seedSession(target.id);
    await seedSession(target.id);
    const bystander = await makeUser();
    await seedSession(bystander.id);

    expect(await sessionCount(target.id)).toBe(2);

    const req = makeReq({
      user: { id: actor.id },
      params: { id: target.id },
      body: { isActive: false },
    });
    const { res, capture } = makeRes();
    const { next, calls } = nextSpy();
    await accessReviewController.setUserActive(req, res, next);

    expect(calls).toHaveLength(0);
    expect(capture.statusCode).toBe(200);
    expect((capture.jsonBody as any).changed).toBe(true);
    expect((capture.jsonBody as any).sessionsEvicted).toBe(2);

    const after = await userRepository.getUser(target.id);
    expect(after!.isActive).toBe(false);
    // A flag flip with a live session row is not revocation.
    expect(await sessionCount(target.id)).toBe(0);
    // ...and it must not touch anyone else's.
    expect(await sessionCount(bystander.id)).toBe(1);
  });

  it('audits the change with the before/after value', async () => {
    const actor = await makeUser({ isSystemAdmin: true });
    const target = await makeUser();

    const req = makeReq({
      user: { id: actor.id },
      params: { id: target.id },
      body: { isActive: false },
    });
    const { res } = makeRes();
    await accessReviewController.setUserActive(req, res, nextSpy().next);

    await new Promise((r) => setTimeout(r, 150));
    const rows = await db
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.eventType, 'update'), eq(activityLogs.subjectType1, 'user')));
    const entry = rows.find((r) => r.subjectId1 === target.id);
    expect(entry).toBeDefined();
    expect((entry!.details as any).isActive).toEqual({ from: true, to: false });
    expect(entry!.userId).toBe(actor.id);
  });

  it('reactivates without touching sessions', async () => {
    const actor = await makeUser({ isSystemAdmin: true });
    const target = await makeUser();
    await userRepository.updateUser(target.id, { isActive: false } as any);

    const req = makeReq({
      user: { id: actor.id },
      params: { id: target.id },
      body: { isActive: true },
    });
    const { res, capture } = makeRes();
    await accessReviewController.setUserActive(req, res, nextSpy().next);

    expect(capture.statusCode).toBe(200);
    expect((capture.jsonBody as any).sessionsEvicted).toBe(0);
    expect((await userRepository.getUser(target.id))!.isActive).toBe(true);
  });

  it('refuses to let an admin disable their own account', async () => {
    const actor = await makeUser({ isSystemAdmin: true });

    const req = makeReq({
      user: { id: actor.id },
      params: { id: actor.id },
      body: { isActive: false },
    });
    const { res, capture } = makeRes();
    await accessReviewController.setUserActive(req, res, nextSpy().next);

    expect(capture.statusCode).toBe(400);
    expect((await userRepository.getUser(actor.id))!.isActive).toBe(true);
  });

  it('404s for a user that does not exist', async () => {
    const actor = await makeUser({ isSystemAdmin: true });
    const req = makeReq({
      user: { id: actor.id },
      params: { id: 'no-such-user' },
      body: { isActive: false },
    });
    const { res, capture } = makeRes();
    await accessReviewController.setUserActive(req, res, nextSpy().next);
    expect(capture.statusCode).toBe(404);
  });

  it('is a no-op when the flag already has the requested value', async () => {
    const actor = await makeUser({ isSystemAdmin: true });
    const target = await makeUser();

    const req = makeReq({
      user: { id: actor.id },
      params: { id: target.id },
      body: { isActive: true },
    });
    const { res, capture } = makeRes();
    await accessReviewController.setUserActive(req, res, nextSpy().next);

    expect((capture.jsonBody as any).changed).toBe(false);
  });

  it('rejects an isActive change bundled with other fields', async () => {
    // Those other fields belong to the general update path, which this handler
    // has already claimed the request from — silently dropping them would be
    // the worse failure.
    const actor = await makeUser({ isSystemAdmin: true });
    const target = await makeUser();

    const req = makeReq({
      user: { id: actor.id },
      params: { id: target.id },
      body: { isActive: false, firstName: 'Renamed' },
    });
    const { res, capture } = makeRes();
    await accessReviewController.setUserActive(req, res, nextSpy().next);

    expect(capture.statusCode).toBe(400);
    expect((await userRepository.getUser(target.id))!.isActive).toBe(true);
  });

  it('passes a body with no isActive straight through to the next handler', async () => {
    const actor = await makeUser({ isSystemAdmin: true });
    const target = await makeUser();

    const req = makeReq({
      user: { id: actor.id },
      params: { id: target.id },
      body: { firstName: 'Renamed' },
    });
    const { res, capture } = makeRes();
    const { next, calls } = nextSpy();
    await accessReviewController.setUserActive(req, res, next);

    expect(calls).toHaveLength(1);
    expect(capture.ended).toBe(false);
  });
});

// ===========================================================================
// The weekly cron
// ===========================================================================

describe('runAccessReview', () => {
  it('reports dormant accounts and deactivates NOTHING with the env switch unset', async () => {
    const dormant = await makeUser();
    await ageUser(dormant.id, 200);
    await seedSession(dormant.id);
    const fresh = await makeUser();

    const { alert, alerts } = fakeAlerter();
    const result = await runAccessReview(new Date(), { alert });

    expect(result.autoDeactivateAfterDays).toBeNull();
    expect(result.deactivated).toHaveLength(0);
    expect(result.flagged.some((f) => f.id === dormant.id)).toBe(true);
    expect(result.flagged.some((f) => f.id === fresh.id)).toBe(false);

    // Nothing was touched.
    expect((await userRepository.getUser(dormant.id))!.isActive).toBe(true);
    expect(await sessionCount(dormant.id)).toBe(1);

    // One alert, and it says plainly that it changed nothing.
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toContain('Access review');
    const body = alerts[0].lines.join('\n');
    expect(body).toContain(dormant.id);
    expect(body).toContain(dormant.email!);
    expect(body).toContain('Automatic deactivation is OFF');
    // Personal data is held to id + email + dates.
    expect(body).not.toContain('password');
  });

  it('sends no alert when there is nothing to review', async () => {
    await makeUser();
    const { alert, alerts } = fakeAlerter();
    const result = await runAccessReview(new Date(), { alert });

    expect(result.flagged).toHaveLength(0);
    expect(result.alerted).toBe(false);
    expect(alerts).toHaveLength(0);
  });

  it('deactivates and evicts sessions once the threshold is configured', async () => {
    process.env[AUTO_DEACTIVATE_ENV_VAR] = '180';
    const dormant = await makeUser();
    await ageUser(dormant.id, 400);
    await seedSession(dormant.id);
    const merelyDormant = await makeUser();
    await ageUser(merelyDormant.id, 120); // on the review list, under the switch

    const { alert, alerts } = fakeAlerter();
    const result = await runAccessReview(new Date(), { alert });

    expect(result.autoDeactivateAfterDays).toBe(180);
    expect(result.deactivated.map((d) => d.id)).toEqual([dormant.id]);
    expect((await userRepository.getUser(dormant.id))!.isActive).toBe(false);
    expect(await sessionCount(dormant.id)).toBe(0);

    // Under the threshold: reported, untouched.
    expect(result.flagged.some((f) => f.id === merelyDormant.id)).toBe(true);
    expect((await userRepository.getUser(merelyDormant.id))!.isActive).toBe(true);

    expect(alerts[0].lines.join('\n')).toContain('Automatic deactivation is ON at 180 days');

    await new Promise((r) => setTimeout(r, 150));
    const rows = await db
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.eventType, 'update'), eq(activityLogs.subjectType1, 'user')));
    const entry = rows.find((r) => r.subjectId1 === dormant.id);
    expect(entry).toBeDefined();
    expect((entry!.details as any).isActive).toEqual({ from: true, to: false });
    expect((entry!.details as any).reason).toBe('dormant');
  });

  it('never auto-deactivates a backoffice admin, however dormant', async () => {
    // All admins going quiet at once would lock the last door from the inside,
    // with no API left to re-open it.
    process.env[AUTO_DEACTIVATE_ENV_VAR] = '30';
    await adminUserRepository.create({
      id: 'admin-old',
      email: 'old@aivota.ai',
      permissions: ['*'],
      lastActiveAt: daysAgo(500),
    } as any);

    const { alert, alerts } = fakeAlerter();
    const result = await runAccessReview(new Date(), { alert });

    const flagged = result.flagged.find((f) => f.id === 'admin-old');
    expect(flagged).toBeDefined();
    expect(flagged!.kind).toBe('admin');
    expect(flagged!.protectedReason).toBe('admin_account');
    expect(result.deactivated.some((d) => d.id === 'admin-old')).toBe(false);
    expect((await adminUserRepository.getById('admin-old'))!.isActive).toBe(true);
    expect(alerts[0].lines.join('\n')).toContain('not auto-disabled: admin_account');
  });

  it('never auto-deactivates an admin shell user row', async () => {
    // ensureAdminShellUser creates a `users` row per admin that is never
    // signed into as a user, so it looks permanently dormant.
    process.env[AUTO_DEACTIVATE_ENV_VAR] = '30';
    const shell = await makeUser({ isSystemAdmin: true });
    await ageUser(shell.id, 500);

    const { alert } = fakeAlerter();
    const result = await runAccessReview(new Date(), { alert });

    const flagged = result.flagged.find((f) => f.id === shell.id);
    expect(flagged!.protectedReason).toBe('system_admin');
    expect(result.deactivated.some((d) => d.id === shell.id)).toBe(false);
    expect((await userRepository.getUser(shell.id))!.isActive).toBe(true);
  });

  it('is registered as a weekly maintenance cron', async () => {
    // A review nobody runs is a document, not a control.
    const { MAINTENANCE_CRON_NAMES } = await import('../../services/maintenanceCrons.js');
    expect(MAINTENANCE_CRON_NAMES).toContain('access-review');
  });

  it('flags a never-used account separately from a dormant one', async () => {
    const never = await makeUser();
    await userRepository.updateUser(never.id, { lastActiveAt: null } as any);

    const { alert } = fakeAlerter();
    const result = await runAccessReview(new Date(), { alert });

    const flagged = result.flagged.find((f) => f.id === never.id);
    expect(flagged).toBeDefined();
    expect(flagged!.classification).toBe('never_used');
  });
});
