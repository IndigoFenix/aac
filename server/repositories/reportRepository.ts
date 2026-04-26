/**
 * reportRepository.ts
 *
 * Repository layer for medical records, functional reports, and educational reports.
 * Handles all database operations for the reports system.
 *
 * Read methods accept an optional `ctx?: AccessCtx` — when set, the result is
 * gated by the cross-institute visibility helper (institute ownership +
 * per-object share + standing share). When omitted, the legacy unfiltered
 * read is preserved (used by the AI memory-db bridge and other callers that
 * supply their own access scoping). See planning-docs/cross-institute-sharing-plan.md.
 */

import {
  medicalRecords,
  functionalReports,
  educationalReports,
  students,
  institutes,
  instituteStudents,
  type MedicalRecord,
  type InsertMedicalRecord,
  type UpdateMedicalRecord,
  type FunctionalReport,
  type InsertFunctionalReport,
  type UpdateFunctionalReport,
  type EducationalReport,
  type InsertEducationalReport,
  type UpdateEducationalReport,
  type ReportStatus,
  type ShareableObjectType,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc, asc, or, ne, type SQL } from "drizzle-orm";
import {
  withInstituteVisibility,
  type AccessCtx,
} from "../services/sharing/visibility";
import {
  recordShareDerivedView,
  recordShareDerivedViewSingle,
} from "../services/sharing/audit";

/**
 * Build the array of WHERE clauses for a student-scoped read against one of
 * the three report tables, applying the visibility filter when `ctx` is set.
 */
function studentScope(
  table: { id: any; instituteId: any; studentId: any },
  studentId: string,
  objectType: ShareableObjectType,
  ctx?: AccessCtx,
): SQL[] {
  const conds: SQL[] = [eq(table.studentId, studentId)];
  if (ctx) conds.push(withInstituteVisibility(table, ctx, objectType));
  return conds;
}

/** Build WHERE clauses for an id-scoped read with optional ctx-gated filter. */
function idScope(
  table: { id: any; instituteId: any; studentId: any },
  id: string,
  objectType: ShareableObjectType,
  ctx?: AccessCtx,
): SQL[] {
  const conds: SQL[] = [eq(table.id, id)];
  if (ctx) conds.push(withInstituteVisibility(table, ctx, objectType));
  return conds;
}

export class ReportRepository {
  // ==========================================================================
  // MEDICAL RECORD OPERATIONS
  // ==========================================================================

  /**
   * Create a new medical record
   */
  async createMedicalRecord(insert: InsertMedicalRecord): Promise<MedicalRecord> {
    const [record] = await db
      .insert(medicalRecords)
      .values(insert)
      .returning();
    return record;
  }

  /**
   * Get a medical record by ID. Pass `ctx` to apply the cross-institute
   * visibility filter; omit it (e.g. AI memory-db bridge) for raw read.
   */
  async getMedicalRecordById(
    id: string,
    ctx?: AccessCtx,
  ): Promise<MedicalRecord | undefined> {
    const [record] = await db
      .select()
      .from(medicalRecords)
      .where(and(...idScope(medicalRecords, id, "medical_record", ctx)));
    if (ctx) recordShareDerivedViewSingle(ctx, "medical_record", record);
    return record || undefined;
  }

  /**
   * Get all medical records for a student.
   */
  async getMedicalRecordsByStudentId(
    studentId: string,
    ctx?: AccessCtx,
  ): Promise<MedicalRecord[]> {
    const rows = await db
      .select()
      .from(medicalRecords)
      .where(and(...studentScope(medicalRecords, studentId, "medical_record", ctx)))
      .orderBy(desc(medicalRecords.createdAt));
    if (ctx) recordShareDerivedView(ctx, "medical_record", rows);
    return rows;
  }

  /**
   * Get the current (active/draft) medical record for a student and institute.
   * There should only be one active medical record per clinic per student.
   */
  async getCurrentMedicalRecord(
    studentId: string,
    instituteId?: string,
    ctx?: AccessCtx,
  ): Promise<MedicalRecord | undefined> {
    const conds: SQL[] = [
      eq(medicalRecords.studentId, studentId),
      or(
        eq(medicalRecords.status, "draft"),
        eq(medicalRecords.status, "pending_review"),
      )!,
    ];
    if (instituteId) conds.push(eq(medicalRecords.instituteId, instituteId));
    if (ctx) conds.push(withInstituteVisibility(medicalRecords, ctx, "medical_record"));

    const [record] = await db
      .select()
      .from(medicalRecords)
      .where(and(...conds))
      .orderBy(desc(medicalRecords.createdAt))
      .limit(1);

    if (ctx) recordShareDerivedViewSingle(ctx, "medical_record", record);
    return record || undefined;
  }

  /**
   * Get archived medical records for a student
   */
  async getArchivedMedicalRecords(
    studentId: string,
    instituteId?: string,
    ctx?: AccessCtx,
  ): Promise<MedicalRecord[]> {
    const conds: SQL[] = [
      eq(medicalRecords.studentId, studentId),
      or(
        eq(medicalRecords.status, "final"),
        eq(medicalRecords.status, "superseded"),
      )!,
    ];
    if (instituteId) conds.push(eq(medicalRecords.instituteId, instituteId));
    if (ctx) conds.push(withInstituteVisibility(medicalRecords, ctx, "medical_record"));

    const rows = await db
      .select()
      .from(medicalRecords)
      .where(and(...conds))
      .orderBy(desc(medicalRecords.finalizedAt));
    if (ctx) recordShareDerivedView(ctx, "medical_record", rows);
    return rows;
  }

  /**
   * Update a medical record
   */
  async updateMedicalRecord(
    id: string,
    updates: UpdateMedicalRecord
  ): Promise<MedicalRecord | undefined> {
    const [updated] = await db
      .update(medicalRecords)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(medicalRecords.id, id))
      .returning();
    return updated || undefined;
  }

  /**
   * Finalize a medical record (set status to 'final')
   */
  async finalizeMedicalRecord(id: string): Promise<MedicalRecord | undefined> {
    const [finalized] = await db
      .update(medicalRecords)
      .set({
        status: "final",
        finalizedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(medicalRecords.id, id))
      .returning();
    return finalized || undefined;
  }

  /**
   * Archive a medical record (set status to 'superseded')
   */
  async archiveMedicalRecord(id: string): Promise<MedicalRecord | undefined> {
    const [archived] = await db
      .update(medicalRecords)
      .set({
        status: "superseded",
        updatedAt: new Date(),
      })
      .where(eq(medicalRecords.id, id))
      .returning();
    return archived || undefined;
  }

  /**
   * Delete a medical record (only allowed for drafts)
   */
  async deleteMedicalRecord(id: string): Promise<boolean> {
    const result = await db
      .delete(medicalRecords)
      .where(
        and(eq(medicalRecords.id, id), eq(medicalRecords.status, "draft"))
      );
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // FUNCTIONAL REPORT OPERATIONS
  // ==========================================================================

  /**
   * Create a new functional report
   */
  async createFunctionalReport(
    insert: InsertFunctionalReport
  ): Promise<FunctionalReport> {
    const [report] = await db
      .insert(functionalReports)
      .values(insert)
      .returning();
    return report;
  }

  /**
   * Get a functional report by ID
   */
  async getFunctionalReportById(
    id: string,
    ctx?: AccessCtx,
  ): Promise<FunctionalReport | undefined> {
    const [report] = await db
      .select()
      .from(functionalReports)
      .where(and(...idScope(functionalReports, id, "functional_report", ctx)));
    if (ctx) recordShareDerivedViewSingle(ctx, "functional_report", report);
    return report || undefined;
  }

  /**
   * Get all functional reports for a student
   */
  async getFunctionalReportsByStudentId(
    studentId: string,
    ctx?: AccessCtx,
  ): Promise<FunctionalReport[]> {
    const rows = await db
      .select()
      .from(functionalReports)
      .where(and(...studentScope(functionalReports, studentId, "functional_report", ctx)))
      .orderBy(desc(functionalReports.createdAt));
    if (ctx) recordShareDerivedView(ctx, "functional_report", rows);
    return rows;
  }

  /**
   * Get the current (active/draft) functional report for a student.
   * Only one active functional report per student.
   */
  async getCurrentFunctionalReport(
    studentId: string,
    ctx?: AccessCtx,
  ): Promise<FunctionalReport | undefined> {
    const conds: SQL[] = [
      eq(functionalReports.studentId, studentId),
      or(
        eq(functionalReports.status, "draft"),
        eq(functionalReports.status, "pending_review"),
      )!,
    ];
    if (ctx) conds.push(withInstituteVisibility(functionalReports, ctx, "functional_report"));

    const [report] = await db
      .select()
      .from(functionalReports)
      .where(and(...conds))
      .orderBy(desc(functionalReports.createdAt))
      .limit(1);

    if (ctx) recordShareDerivedViewSingle(ctx, "functional_report", report);
    return report || undefined;
  }

  /**
   * Get archived functional reports for a student
   */
  async getArchivedFunctionalReports(
    studentId: string,
    ctx?: AccessCtx,
  ): Promise<FunctionalReport[]> {
    const conds: SQL[] = [
      eq(functionalReports.studentId, studentId),
      or(
        eq(functionalReports.status, "final"),
        eq(functionalReports.status, "superseded"),
      )!,
    ];
    if (ctx) conds.push(withInstituteVisibility(functionalReports, ctx, "functional_report"));

    const rows = await db
      .select()
      .from(functionalReports)
      .where(and(...conds))
      .orderBy(desc(functionalReports.finalizedAt));
    if (ctx) recordShareDerivedView(ctx, "functional_report", rows);
    return rows;
  }

  /**
   * Update a functional report
   */
  async updateFunctionalReport(
    id: string,
    updates: UpdateFunctionalReport
  ): Promise<FunctionalReport | undefined> {
    const [updated] = await db
      .update(functionalReports)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(functionalReports.id, id))
      .returning();
    return updated || undefined;
  }

  /**
   * Finalize a functional report
   */
  async finalizeFunctionalReport(id: string): Promise<FunctionalReport | undefined> {
    const [finalized] = await db
      .update(functionalReports)
      .set({
        status: "final",
        finalizedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(functionalReports.id, id))
      .returning();
    return finalized || undefined;
  }

  /**
   * Archive a functional report
   */
  async archiveFunctionalReport(id: string): Promise<FunctionalReport | undefined> {
    const [archived] = await db
      .update(functionalReports)
      .set({
        status: "superseded",
        updatedAt: new Date(),
      })
      .where(eq(functionalReports.id, id))
      .returning();
    return archived || undefined;
  }

  /**
   * Delete a functional report (only allowed for drafts)
   */
  async deleteFunctionalReport(id: string): Promise<boolean> {
    const result = await db
      .delete(functionalReports)
      .where(
        and(eq(functionalReports.id, id), eq(functionalReports.status, "draft"))
      );
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // EDUCATIONAL REPORT OPERATIONS
  // ==========================================================================

  /**
   * Create a new educational report
   */
  async createEducationalReport(
    insert: InsertEducationalReport
  ): Promise<EducationalReport> {
    const [report] = await db
      .insert(educationalReports)
      .values(insert)
      .returning();
    return report;
  }

  /**
   * Get an educational report by ID
   */
  async getEducationalReportById(
    id: string,
    ctx?: AccessCtx,
  ): Promise<EducationalReport | undefined> {
    const [report] = await db
      .select()
      .from(educationalReports)
      .where(and(...idScope(educationalReports, id, "educational_report", ctx)));
    if (ctx) recordShareDerivedViewSingle(ctx, "educational_report", report);
    return report || undefined;
  }

  /**
   * Get all educational reports for a student
   */
  async getEducationalReportsByStudentId(
    studentId: string,
    ctx?: AccessCtx,
  ): Promise<EducationalReport[]> {
    const rows = await db
      .select()
      .from(educationalReports)
      .where(and(...studentScope(educationalReports, studentId, "educational_report", ctx)))
      .orderBy(desc(educationalReports.createdAt));
    if (ctx) recordShareDerivedView(ctx, "educational_report", rows);
    return rows;
  }

  /**
   * Get the current (active/draft) educational report for a student.
   * Only one active educational report per student.
   */
  async getCurrentEducationalReport(
    studentId: string,
    ctx?: AccessCtx,
  ): Promise<EducationalReport | undefined> {
    const conds: SQL[] = [
      eq(educationalReports.studentId, studentId),
      or(
        eq(educationalReports.status, "draft"),
        eq(educationalReports.status, "pending_review"),
      )!,
    ];
    if (ctx) conds.push(withInstituteVisibility(educationalReports, ctx, "educational_report"));

    const [report] = await db
      .select()
      .from(educationalReports)
      .where(and(...conds))
      .orderBy(desc(educationalReports.createdAt))
      .limit(1);

    if (ctx) recordShareDerivedViewSingle(ctx, "educational_report", report);
    return report || undefined;
  }

  /**
   * Get archived educational reports for a student
   */
  async getArchivedEducationalReports(
    studentId: string,
    ctx?: AccessCtx,
  ): Promise<EducationalReport[]> {
    const conds: SQL[] = [
      eq(educationalReports.studentId, studentId),
      or(
        eq(educationalReports.status, "final"),
        eq(educationalReports.status, "superseded"),
      )!,
    ];
    if (ctx) conds.push(withInstituteVisibility(educationalReports, ctx, "educational_report"));

    const rows = await db
      .select()
      .from(educationalReports)
      .where(and(...conds))
      .orderBy(desc(educationalReports.finalizedAt));
    if (ctx) recordShareDerivedView(ctx, "educational_report", rows);
    return rows;
  }

  /**
   * Update an educational report
   */
  async updateEducationalReport(
    id: string,
    updates: UpdateEducationalReport
  ): Promise<EducationalReport | undefined> {
    const [updated] = await db
      .update(educationalReports)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(educationalReports.id, id))
      .returning();
    return updated || undefined;
  }

  /**
   * Finalize an educational report
   */
  async finalizeEducationalReport(
    id: string
  ): Promise<EducationalReport | undefined> {
    const [finalized] = await db
      .update(educationalReports)
      .set({
        status: "final",
        finalizedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(educationalReports.id, id))
      .returning();
    return finalized || undefined;
  }

  /**
   * Archive an educational report
   */
  async archiveEducationalReport(
    id: string
  ): Promise<EducationalReport | undefined> {
    const [archived] = await db
      .update(educationalReports)
      .set({
        status: "superseded",
        updatedAt: new Date(),
      })
      .where(eq(educationalReports.id, id))
      .returning();
    return archived || undefined;
  }

  /**
   * Delete an educational report (only allowed for drafts)
   */
  async deleteEducationalReport(id: string): Promise<boolean> {
    const result = await db
      .delete(educationalReports)
      .where(
        and(
          eq(educationalReports.id, id),
          eq(educationalReports.status, "draft")
        )
      );
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // COMPOSITE QUERIES
  // ==========================================================================

  /**
   * Get all reports summary for a student
   */
  async getAllReportsForStudent(
    studentId: string,
    ctx?: AccessCtx,
  ): Promise<{
    medicalRecords: MedicalRecord[];
    functionalReports: FunctionalReport[];
    educationalReports: EducationalReport[];
  }> {
    const [medRecords, funcReports, eduReports] = await Promise.all([
      this.getMedicalRecordsByStudentId(studentId, ctx),
      this.getFunctionalReportsByStudentId(studentId, ctx),
      this.getEducationalReportsByStudentId(studentId, ctx),
    ]);

    return {
      medicalRecords: medRecords,
      functionalReports: funcReports,
      educationalReports: eduReports,
    };
  }

  /**
   * Get current reports for a student (non-archived)
   */
  async getCurrentReportsForStudent(
    studentId: string,
    ctx?: AccessCtx,
  ): Promise<{
    medicalRecord: MedicalRecord | undefined;
    functionalReport: FunctionalReport | undefined;
    educationalReport: EducationalReport | undefined;
  }> {
    const [medRecord, funcReport, eduReport] = await Promise.all([
      this.getCurrentMedicalRecord(studentId, undefined, ctx),
      this.getCurrentFunctionalReport(studentId, ctx),
      this.getCurrentEducationalReport(studentId, ctx),
    ]);

    return {
      medicalRecord: medRecord,
      functionalReport: funcReport,
      educationalReport: eduReport,
    };
  }

  /**
   * Copy a finalized report to create a new draft (for revisions)
   */
  async copyMedicalRecordAsDraft(
    sourceId: string,
    userId?: string
  ): Promise<MedicalRecord | undefined> {
    const source = await this.getMedicalRecordById(sourceId);
    if (!source) return undefined;

    // Create new record with copied data
    const { id, createdAt, updatedAt, finalizedAt, status, ...data } = source;
    return this.createMedicalRecord({
      ...data,
      userId: userId || data.userId,
      status: "draft",
    } as InsertMedicalRecord);
  }

  async copyFunctionalReportAsDraft(
    sourceId: string,
    userId?: string
  ): Promise<FunctionalReport | undefined> {
    const source = await this.getFunctionalReportById(sourceId);
    if (!source) return undefined;

    const { id, createdAt, updatedAt, finalizedAt, status, ...data } = source;
    return this.createFunctionalReport({
      ...data,
      userId: userId || data.userId,
      status: "draft",
    } as InsertFunctionalReport);
  }

  async copyEducationalReportAsDraft(
    sourceId: string,
    userId?: string
  ): Promise<EducationalReport | undefined> {
    const source = await this.getEducationalReportById(sourceId);
    if (!source) return undefined;

    const { id, createdAt, updatedAt, finalizedAt, status, ...data } = source;
    return this.createEducationalReport({
      ...data,
      userId: userId || data.userId,
      status: "draft",
    } as InsertEducationalReport);
  }
}

export const reportRepository = new ReportRepository();
