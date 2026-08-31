/**
 * Session-recording ENTITLEMENT tests.
 *
 * Session recording writes video of a child to a device's disk so promotional
 * material can be cut from real sessions. It is therefore not a feature
 * customers have: it is an operator-granted entitlement carried on the licence
 * (`licenses.allow_session_recording`), and these tests pin the four places
 * that has to hold —
 *
 *   WRITE  an unlicensed student's settings cannot be saved with it on;
 *   READ   an unlicensed student's settings come back with it off, so an
 *          entitlement that lapses stops the camera with nobody writing
 *          anything anywhere;
 *   ADMIN  only a full system admin can grant it, and granting it is audited;
 *   PASS   a licensed student is unaffected by any of the above.
 *
 * The gate itself (the pure function) is covered DB-free in
 * server/tests/aac-session-recording.test.ts. What is tested here is the
 * wiring: that the gate is actually reached from both directions.
 *
 * Uses the real Postgres test database — see server/tests/global-setup.ts.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { truncateAll } from '../helpers/db.js';
import {
  makeUser,
  makeInstitute,
  makeStudent,
  makeLicense,
  enrollStudent,
  studentService,
  licenseService,
  licenseRepository,
} from '../helpers/factories.js';
import { aacSettingsRepository } from '../../repositories/index.js';
import { licenseController } from '../../controllers/licenseController.js';
import { makeReq, makeRes } from '../helpers/http.js';
import { db } from '../../db.js';
import { activityLogs, licenses } from '@shared/schema';
import { eq } from 'drizzle-orm';

/** A student enrolled in an institute that holds a license. */
async function makeLicensedSetup(opts: { allowSessionRecording?: boolean } = {}) {
  const owner = await makeUser();
  const { institute } = await makeInstitute(owner.id);
  const { student } = await makeStudent(owner.id);
  await enrollStudent(institute.id, student.id, owner.id);
  const license = await makeLicense({ instituteId: institute.id });
  if (opts.allowSessionRecording) {
    await licenseRepository.updateLicense(license.id, { allowSessionRecording: true });
  }
  return { owner, institute, student, license };
}

/** The stored column, read straight back — not the gated read path. */
async function storedSessionRecording(studentId: string): Promise<any> {
  const row = await aacSettingsRepository.getByStudentId(studentId);
  return (row as any)?.sessionRecording;
}

/** activityLogService.log is fire-and-forget — poll rather than read straight back. */
async function waitForLog(subjectId: string): Promise<any> {
  for (let i = 0; i < 20; i++) {
    const rows = await db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.subjectId1, subjectId));
    if (rows.length) return rows[rows.length - 1];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`No activity log for ${subjectId} within 2s`);
}

/** A full system admin, as `requireAdminSection` would have left it on the req. */
function systemAdminUser(id: string) {
  return { id, _identityKind: 'admin', isSystemAdmin: true, adminPermissions: ['*'] };
}

/** A section admin: reaches the Licenses page, but holds nothing wider. */
function sectionAdminUser(id: string) {
  return { id, _identityKind: 'admin', isSystemAdmin: true, adminPermissions: ['licenses'] };
}

describe('session recording — licence entitlement', () => {
  afterEach(truncateAll);

  describe('the default', () => {
    it('is off on a brand-new licence', async () => {
      // Nobody gets this by buying something. It has to be granted.
      const license = await makeLicense();
      expect(license.allowSessionRecording).toBe(false);
    });

    it('leaves an unenrolled student unlicensed', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);
      expect(await licenseService.isSessionRecordingLicensed(student.id)).toBe(false);
    });
  });

  describe('resolution', () => {
    it('follows the student through their institute to the licence', async () => {
      const { student } = await makeLicensedSetup({ allowSessionRecording: true });
      expect(await licenseService.isSessionRecordingLicensed(student.id)).toBe(true);
    });

    it('does not leak across students of a different institute', async () => {
      const { student: granted } = await makeLicensedSetup({ allowSessionRecording: true });
      const { student: other } = await makeLicensedSetup();

      const allowed = await licenseService.sessionRecordingLicensedFor([granted.id, other.id]);
      expect(allowed.has(granted.id)).toBe(true);
      expect(allowed.has(other.id)).toBe(false);
    });

    it('revokes with the licence, not with a write', async () => {
      const { student, license } = await makeLicensedSetup({ allowSessionRecording: true });
      await licenseRepository.updateLicense(license.id, { allowSessionRecording: false });
      expect(await licenseService.isSessionRecordingLicensed(student.id)).toBe(false);
    });
  });

  describe('write path', () => {
    it('forces enabled=false when the licence does not allow it', async () => {
      const { student } = await makeLicensedSetup();

      await studentService.updateStudent(student.id, {
        sessionRecording: { enabled: true, quality: '1080p', maxAgeDays: 7 },
      });

      const stored = await storedSessionRecording(student.id);
      expect(stored.enabled).toBe(false);
      // The rest of the object survives — only the switch is refused.
      expect(stored.quality).toBe('1080p');
      expect(stored.maxAgeDays).toBe(7);
    });

    it('lets a licensed student through unchanged', async () => {
      const { student } = await makeLicensedSetup({ allowSessionRecording: true });

      await studentService.updateStudent(student.id, {
        sessionRecording: { enabled: true, quality: '1080p' },
      });

      expect((await storedSessionRecording(student.id)).enabled).toBe(true);
    });

    it('gates updateAacSettings too, not just updateStudent', async () => {
      // Two doors write this column. A gate on one of them is not a gate.
      const { student } = await makeLicensedSetup();

      await studentService.updateAacSettings(student.id, {
        sessionRecording: { enabled: true },
      } as any);

      expect((await storedSessionRecording(student.id)).enabled).toBe(false);
    });
  });

  describe('read path', () => {
    it('reports enabled=false and licensed=false for a row that says otherwise', async () => {
      // THE case this whole feature exists for: the setting was switched on
      // while the entitlement was live, and the entitlement is gone. Nothing
      // has been written since. The next read has to stop the camera.
      const { student } = await makeLicensedSetup();
      await aacSettingsRepository.upsert(student.id, {
        sessionRecording: { enabled: true, quality: 'max' },
      } as any);

      const fetched = await studentService.getStudentById(student.id);

      expect(fetched!.sessionRecordingLicensed).toBe(false);
      expect((fetched!.aacSettings as any).sessionRecording.enabled).toBe(false);
      // Read-gating does not rewrite the row — it is a view, not a migration.
      expect((await storedSessionRecording(student.id)).enabled).toBe(true);
    });

    it('passes a licensed student through with the flag set', async () => {
      const { student } = await makeLicensedSetup({ allowSessionRecording: true });
      await aacSettingsRepository.upsert(student.id, {
        sessionRecording: { enabled: true },
      } as any);

      const fetched = await studentService.getStudentById(student.id);

      expect(fetched!.sessionRecordingLicensed).toBe(true);
      expect((fetched!.aacSettings as any).sessionRecording.enabled).toBe(true);
    });

    it('carries the flag on the institute list, not only the detail fetch', async () => {
      // The clinician panel can be handed a student straight out of the list,
      // so a flag present on only one of the two endpoints would render the
      // section for a licence that never had it.
      const { owner, institute, student } = await makeLicensedSetup({
        allowSessionRecording: true,
      });

      const listed = await studentService.getStudentsForUserInInstitute(owner.id, institute.id);
      const row = listed.find((r) => r.student.id === student.id);

      expect(row?.student.sessionRecordingLicensed).toBe(true);
    });
  });

  describe('the admin toggle', () => {
    it('flips the licence and audits it', async () => {
      const admin = await makeUser({ isSystemAdmin: true });
      const { institute, student, license } = await makeLicensedSetup();

      const { res, capture } = makeRes();
      await licenseController.updateLicense(
        makeReq({
          user: systemAdminUser(admin.id),
          params: { id: license.id },
          body: { allowSessionRecording: true },
        }),
        res,
      );

      expect(capture.statusCode).toBe(200);
      const [row] = await db.select().from(licenses).where(eq(licenses.id, license.id));
      expect(row.allowSessionRecording).toBe(true);
      // And it takes effect for the students under it.
      expect(await licenseService.isSessionRecordingLicensed(student.id)).toBe(true);

      // Licenses have no subject type of their own, so the institute is the
      // subject and the licence id rides in the details.
      const logged = await waitForLog(institute.id);
      expect(logged.eventType).toBe('update');
      expect(logged.subjectType1).toBe('institute');
      expect(logged.details.licenseId).toBe(license.id);
      expect(logged.details.field).toBe('allowSessionRecording');
      expect(logged.details.allowSessionRecording).toBe(true);
      expect(logged.details.route).toBe('PATCH /api/admin/licenses/:id');
    });

    it('refuses a section admin and leaves the licence alone', async () => {
      const admin = await makeUser();
      const { license } = await makeLicensedSetup();

      const { res, capture } = makeRes();
      await licenseController.updateLicense(
        makeReq({
          user: sectionAdminUser(admin.id),
          params: { id: license.id },
          body: { allowSessionRecording: true },
        }),
        res,
      );

      expect(capture.statusCode).toBe(403);
      expect((capture.jsonBody as any).code).toBe('SESSION_RECORDING_ADMIN_ONLY');
      const [row] = await db.select().from(licenses).where(eq(licenses.id, license.id));
      expect(row.allowSessionRecording).toBe(false);
    });

    it('still lets a section admin edit everything else', async () => {
      // The guard keys off the FIELD, not the route — a section admin renaming
      // a licence must not be collateral damage.
      const admin = await makeUser();
      const { license } = await makeLicensedSetup();

      const { res, capture } = makeRes();
      await licenseController.updateLicense(
        makeReq({
          user: sectionAdminUser(admin.id),
          params: { id: license.id },
          body: { name: 'Renamed by section admin' },
        }),
        res,
      );

      expect(capture.statusCode).toBe(200);
      const [row] = await db.select().from(licenses).where(eq(licenses.id, license.id));
      expect(row.name).toBe('Renamed by section admin');
    });
  });
});
