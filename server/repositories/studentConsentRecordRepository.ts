// server/repositories/studentConsentRecordRepository.ts
// Repository for student data-collection consent records.
// See planning-docs/student-consent-onboarding-plan.md.

import {
  studentConsentRecords,
  type StudentConsentRecord,
  type InsertStudentConsentRecord,
} from "@shared/schema";
import { db } from "../db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

export interface RevokeArgs {
  revokedByUserId: string;
  reason?: string;
  at?: Date;
}

export class StudentConsentRecordRepository {
  async create(data: InsertStudentConsentRecord): Promise<StudentConsentRecord> {
    const [row] = await db.insert(studentConsentRecords).values(data).returning();
    return row;
  }

  async getById(id: string): Promise<StudentConsentRecord | undefined> {
    const [row] = await db
      .select()
      .from(studentConsentRecords)
      .where(eq(studentConsentRecords.id, id));
    return row || undefined;
  }

  /**
   * Returns the active (non-revoked) consent for a student. Multiple active
   * rows shouldn't exist by design — re-consent revokes prior — but if the
   * data is somehow inconsistent the most-recently-signed row wins.
   */
  async getActiveForStudent(studentId: string): Promise<StudentConsentRecord | undefined> {
    const [row] = await db
      .select()
      .from(studentConsentRecords)
      .where(
        and(
          eq(studentConsentRecords.studentId, studentId),
          isNull(studentConsentRecords.revokedAt),
        ),
      )
      .orderBy(desc(studentConsentRecords.signedAt))
      .limit(1);
    return row || undefined;
  }

  /**
   * Batch lookup of active consents for many students. Used by list endpoints
   * to compute consent_pending status without N round trips.
   */
  async getActiveForStudents(
    studentIds: string[],
  ): Promise<Map<string, StudentConsentRecord>> {
    if (studentIds.length === 0) return new Map();
    const rows = await db
      .select()
      .from(studentConsentRecords)
      .where(
        and(
          inArray(studentConsentRecords.studentId, studentIds),
          isNull(studentConsentRecords.revokedAt),
        ),
      )
      .orderBy(desc(studentConsentRecords.signedAt));

    const out = new Map<string, StudentConsentRecord>();
    for (const r of rows) {
      // First (most recent) per student wins; later rows for same student skipped.
      if (!out.has(r.studentId)) out.set(r.studentId, r);
    }
    return out;
  }

  async listHistoryForStudent(studentId: string): Promise<StudentConsentRecord[]> {
    return db
      .select()
      .from(studentConsentRecords)
      .where(eq(studentConsentRecords.studentId, studentId))
      .orderBy(desc(studentConsentRecords.signedAt));
  }

  async revoke(id: string, args: RevokeArgs): Promise<StudentConsentRecord | undefined> {
    const [row] = await db
      .update(studentConsentRecords)
      .set({
        revokedAt: args.at ?? new Date(),
        revokedByUserId: args.revokedByUserId,
        revocationReason: args.reason ?? null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(studentConsentRecords.id, id),
          isNull(studentConsentRecords.revokedAt),
        ),
      )
      .returning();
    return row || undefined;
  }
}

export const studentConsentRecordRepository = new StudentConsentRecordRepository();
