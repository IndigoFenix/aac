// server/repositories/licenseRepository.ts
// Repository for license management operations

import {
  licenses,
  institutes,
  users,
  instituteStudents,
  userStudents,
  type License,
  type InsertLicense,
  type UpdateLicense,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc, inArray } from "drizzle-orm";

export class LicenseRepository {
  async createLicense(data: InsertLicense): Promise<License> {
    const [license] = await db
      .insert(licenses)
      .values(data)
      .returning();
    return license;
  }

  async getLicenseById(id: string): Promise<License | undefined> {
    const [license] = await db
      .select()
      .from(licenses)
      .where(eq(licenses.id, id));
    return license || undefined;
  }

  async getAllLicenses(): Promise<(License & {
    userName?: string | null;
    userEmail?: string | null;
    instituteName?: string | null;
  })[]> {
    const results = await db
      .select({
        license: licenses,
        userName: users.firstName,
        userEmail: users.email,
        instituteName: institutes.name,
      })
      .from(licenses)
      .leftJoin(users, eq(licenses.userId, users.id))
      .leftJoin(institutes, eq(licenses.instituteId, institutes.id))
      .orderBy(desc(licenses.createdAt));

    return results.map((r) => ({
      ...r.license,
      userName: r.userName,
      userEmail: r.userEmail,
      instituteName: r.instituteName,
    }));
  }

  async getLicensesByInstituteId(instituteId: string): Promise<License[]> {
    return db
      .select()
      .from(licenses)
      .where(eq(licenses.instituteId, instituteId))
      .orderBy(desc(licenses.createdAt));
  }

  async getLicenseByUserId(userId: string): Promise<License | undefined> {
    const [license] = await db
      .select()
      .from(licenses)
      .where(eq(licenses.userId, userId));
    return license || undefined;
  }

  /**
   * Which of these students sit under a license that allows session recording.
   *
   * BATCHED on purpose: this is consulted on every student list the clinician
   * client loads, and the per-student form of the question would be 2N queries
   * behind a list of N children. Two round trips total, whatever N is.
   *
   * Two arms, because a license can be owned two ways (see the `licenses`
   * table's ownership comment):
   *   - INSTITUTE — the student is enrolled in an institute that holds the
   *     license. This is the ordinary path.
   *   - USER — a private license with no institute, reached through the
   *     student's user link. The people this entitlement is granted to are as
   *     likely to hold a private license as to sit in an institute, so leaving
   *     this arm out would deny exactly the intended audience.
   *
   * Only `isActive` rows count on every hop, so a lapsed license, a closed
   * institute or an ended enrollment all revoke it on the next read.
   *
   * Note this does NOT go through licenseService.getInstituteLicenseInfo: that
   * one skips any license whose `permissions` jsonb is null, and this
   * entitlement lives on the row rather than in that blob (see the column
   * comment in shared/schema.ts).
   */
  async getSessionRecordingLicensedStudentIds(
    studentIds: readonly string[],
  ): Promise<Set<string>> {
    const ids = Array.from(new Set(studentIds.filter(Boolean)));
    if (ids.length === 0) return new Set();

    const [viaInstitute, viaUser] = await Promise.all([
      db
        .selectDistinct({ studentId: instituteStudents.studentId })
        .from(instituteStudents)
        .innerJoin(institutes, eq(instituteStudents.instituteId, institutes.id))
        .innerJoin(licenses, eq(licenses.instituteId, institutes.id))
        .where(
          and(
            inArray(instituteStudents.studentId, ids),
            eq(instituteStudents.isActive, true),
            eq(institutes.isActive, true),
            eq(licenses.isActive, true),
            eq(licenses.allowSessionRecording, true),
          ),
        ),
      db
        .selectDistinct({ studentId: userStudents.studentId })
        .from(userStudents)
        .innerJoin(licenses, eq(licenses.userId, userStudents.userId))
        .where(
          and(
            inArray(userStudents.studentId, ids),
            eq(userStudents.isActive, true),
            eq(licenses.isActive, true),
            eq(licenses.allowSessionRecording, true),
          ),
        ),
    ]);

    const allowed = new Set<string>();
    for (const row of viaInstitute) allowed.add(row.studentId);
    for (const row of viaUser) allowed.add(row.studentId);
    return allowed;
  }

  async getLicenseByInviteEmail(email: string): Promise<License | undefined> {
    const [license] = await db
      .select()
      .from(licenses)
      .where(eq(licenses.inviteEmail, email));
    return license || undefined;
  }

  async getLicenseByInviteEmailAndInstitute(email: string, instituteId: string): Promise<License | undefined> {
    const [license] = await db
      .select()
      .from(licenses)
      .where(and(eq(licenses.inviteEmail, email), eq(licenses.instituteId, instituteId)));
    return license || undefined;
  }

  async updateLicense(id: string, updates: UpdateLicense): Promise<License | undefined> {
    const [license] = await db
      .update(licenses)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(licenses.id, id))
      .returning();
    return license || undefined;
  }

  async getLicenseByInviteToken(token: string): Promise<License | undefined> {
    const [license] = await db
      .select()
      .from(licenses)
      .where(eq(licenses.inviteToken, token));
    return license || undefined;
  }

  async deleteLicense(id: string): Promise<boolean> {
    const [result] = await db
      .delete(licenses)
      .where(eq(licenses.id, id))
      .returning({ id: licenses.id });
    return !!result;
  }
}

export const licenseRepository = new LicenseRepository();
