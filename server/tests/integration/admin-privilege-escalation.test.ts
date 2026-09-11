/**
 * REGRESSION PINS — the 2026-09-10 privilege-escalation chain, end to end
 * against the database (audit finding C1).
 *
 * The chain, before this suite existed:
 *   1. `POST /auth/register {"userType":"admin"}` — `registerSchema` accepted
 *      the value from an unauthenticated body, `userService.registerUser`
 *      spread it into the insert and `userRepository.createUser` wrote
 *      `user_type = 'admin'` verbatim.
 *   2. `requireAdmin` read `user.userType === "admin"` as a privilege claim, so
 *      that row passed the gate on 99 routes.
 *   3. `GET /api/admin/users` answered `res.json({ users })` over
 *      `db.select().from(users)` + `hydrateRecords`, so the payload carried
 *      every account's bcrypt hash and encrypted TOTP seed.
 *
 * Everything below asserts the ROW, not just the status code — the point of the
 * fix is that the privileged value is never persisted.
 *
 * 2026-09-10, phase 0a of the authorization structural pass: link 2 was removed
 * rather than patched. `requireAdmin` and all 20 registrations behind it —
 * `GET/PATCH/DELETE /api/admin/users*` included — were DELETED, and with them
 * `adminController.getUsers/getUser/updateUser/deleteUser`. The payload pins
 * that used to live here (a serialized response carrying no `password` /
 * `mfaSecret`) are therefore replaced by the stronger property: those handlers
 * do not exist. The allowlist helper they used, `services/userView.ts`, is
 * still pinned directly in `server/tests/admin-privilege-claims.test.ts`.
 * The surviving admin gate on this surface is `requireSystemAdmin`.
 *
 * Non-vacuity: run against the pre-fix tree, "does not persist user_type
 * 'admin'" and "REFUSES a user_type='admin' row" fail; run against the
 * pre-DELETION tree, every assertion in the last describe fails. See the round
 * report.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { truncateAll, db } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/http.js';
import { makeUser } from '../helpers/factories.js';
import { userRepository } from '../../repositories/userRepository.js';
import { authController } from '../../controllers/authController.js';
import { adminController } from '../../controllers/adminController.js';
import * as authMiddleware from '../../middleware/auth.js';
import { requireSystemAdmin } from '../../middleware/auth.js';
import { users } from '@shared/schema';

/** Drive a middleware with a real DB-loaded user row, as deserializeUser does. */
function runAdminGate(user: unknown): { statusCode: number; passed: boolean } {
  const req = makeReq({ user: user as Record<string, unknown> });
  (req as any).isAuthenticated = () => true;
  const { res, capture } = makeRes();
  let passed = false;
  requireSystemAdmin(req, res, () => {
    passed = true;
  });
  return { statusCode: capture.statusCode, passed };
}

/** `authController.register` calls `req.login`; give it a no-op. */
function registerReq(body: Record<string, unknown>) {
  const req = makeReq({ body });
  (req as any).login = (_identity: unknown, cb: (err: unknown) => void) => cb(null);
  return req;
}

describe('anonymous registration cannot claim a privileged role', () => {
  afterEach(truncateAll);

  it('REJECTS userType "admin" and persists NO row', async () => {
    const email = `escalate-${Date.now()}@test.local`;
    const req = registerReq({
      email,
      firstName: 'Mal',
      lastName: 'Lory',
      password: 'Passw0rdPassw0rd',
      userType: 'admin',
    });
    const { res, capture } = makeRes();

    await authController.register(req, res);

    expect(capture.statusCode).toBe(400);

    // The row is the assertion — a 400 with a written row would still be the bug.
    const rows = await db.select().from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(0);
  });

  it('accepts a legitimate type and grants NO privilege flags', async () => {
    const email = `honest-${Date.now()}@test.local`;
    const req = registerReq({
      email,
      firstName: 'Reg',
      lastName: 'Ular',
      password: 'Passw0rdPassw0rd',
      userType: 'Caregiver',
    });
    const { res, capture } = makeRes();

    await authController.register(req, res);

    expect((capture.jsonBody as any)?.success).toBe(true);
    const [row] = await db.select().from(users).where(eq(users.email, email));
    expect(row).toBeDefined();
    expect(row.userType).toBe('Caregiver');
    expect(row.isAdmin).toBe(false);
    expect(row.isSystemAdmin).toBe(false);
  });

  it('a server-side insert of a legitimate admin is still possible', async () => {
    // The fix must not close the door the platform actually uses: the two
    // production admins are `is_admin AND is_system_admin` rows written
    // server-side, and they still pass the gate.
    const admin = await makeUser({ isAdmin: true, isSystemAdmin: true, userType: 'admin' });
    const reloaded = await userRepository.getUser(admin.id);
    expect(reloaded?.isAdmin).toBe(true);
    expect(reloaded?.isSystemAdmin).toBe(true);
    expect(runAdminGate(reloaded).passed).toBe(true);
  });
});

describe('the surviving admin gate against real rows', () => {
  afterEach(truncateAll);

  it('REFUSES a row with user_type = "admin" but both privilege flags false', async () => {
    // The exact shape a pre-fix self-registration produced. Written directly so
    // the pin survives even if registration is ever loosened again.
    const user = await makeUser({ userType: 'Caregiver' });
    await db.update(users).set({ userType: 'admin' }).where(eq(users.id, user.id));
    const row = await userRepository.getUser(user.id);

    expect(row?.userType).toBe('admin');
    expect(row?.isAdmin).toBe(false);
    expect(row?.isSystemAdmin).toBe(false);

    const result = runAdminGate(row);
    expect(result.passed).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it('REFUSES a users.is_admin row too — is_system_admin is the column that counts', async () => {
    const admin = await makeUser({ isAdmin: true });
    const row = await userRepository.getUser(admin.id);
    const result = runAdminGate(row);
    expect(result.passed).toBe(false);
    expect(result.statusCode).toBe(403);
  });
});

describe('C1 link 2 — the surface itself is gone, not merely gated', () => {
  it('middleware/auth no longer exports requireAdmin', () => {
    expect(authMiddleware).not.toHaveProperty('requireAdmin');
  });

  it('adminController has no platform-user read/write handlers', () => {
    // `GET /api/admin/users` was the C1 payload: every account's bcrypt hash and
    // encrypted TOTP seed, joined to each user's students. No route, no handler.
    for (const method of ['getUsers', 'getUser', 'updateUser', 'deleteUser']) {
      expect(typeof (adminController as any)[method]).toBe('undefined');
    }
  });

  it('adminController has no unbounded system_settings writer', () => {
    // Audit finding F4: `PUT /api/admin/settings/:key` wrote any key, reaching
    // the live LLM routing rows around the section-gated `llm_configs` pair.
    for (const method of ['getSetting', 'updateSetting', 'updateSystemPrompt']) {
      expect(typeof (adminController as any)[method]).toBe('undefined');
    }
  });
});

