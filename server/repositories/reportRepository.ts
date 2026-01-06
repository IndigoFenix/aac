/**
 * reportRepository.ts
 * 
 * Repository layer for medical records, functional reports, and educational reports.
 * Handles all database operations for the reports system.
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
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc, asc, or, ne } from "drizzle-orm";

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
   * Get a medical record by ID
   */
  async getMedicalRecordById(id: string): Promise<MedicalRecord | undefined> {
    const [record] = await db
      .select()
      .from(medicalRecords)
      .where(eq(medicalRecords.id, id));
    return record || undefined;
  }

  /**
   * Get all medical records for a student
   */
  async getMedicalRecordsByStudentId(studentId: string): Promise<MedicalRecord[]> {
    return await db
      .select()
      .from(medicalRecords)
      .where(eq(medicalRecords.studentId, studentId))
      .orderBy(desc(medicalRecords.createdAt));
  }

  /**
   * Get the current (active/draft) medical record for a student and institute.
   * There should only be one active medical record per hospital per student.
   */
  async getCurrentMedicalRecord(
    studentId: string,
    instituteId?: string
  ): Promise<MedicalRecord | undefined> {
    const whereClause = instituteId
      ? and(
          eq(medicalRecords.studentId, studentId),
          eq(medicalRecords.instituteId, instituteId),
          or(
            eq(medicalRecords.status, "draft"),
            eq(medicalRecords.status, "pending_review")
          )
        )
      : and(
          eq(medicalRecords.studentId, studentId),
          or(
            eq(medicalRecords.status, "draft"),
            eq(medicalRecords.status, "pending_review")
          )
        );

    const [record] = await db
      .select()
      .from(medicalRecords)
      .where(whereClause)
      .orderBy(desc(medicalRecords.createdAt))
      .limit(1);

    return record || undefined;
  }

  /**
   * Get archived medical records for a student
   */
  async getArchivedMedicalRecords(
    studentId: string,
    instituteId?: string
  ): Promise<MedicalRecord[]> {
    const whereClause = instituteId
      ? and(
          eq(medicalRecords.studentId, studentId),
          eq(medicalRecords.instituteId, instituteId),
          or(
            eq(medicalRecords.status, "final"),
            eq(medicalRecords.status, "superseded")
          )
        )
      : and(
          eq(medicalRecords.studentId, studentId),
          or(
            eq(medicalRecords.status, "final"),
            eq(medicalRecords.status, "superseded")
          )
        );

    return await db
      .select()
      .from(medicalRecords)
      .where(whereClause)
      .orderBy(desc(medicalRecords.finalizedAt));
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
  async getFunctionalReportById(id: string): Promise<FunctionalReport | undefined> {
    const [report] = await db
      .select()
      .from(functionalReports)
      .where(eq(functionalReports.id, id));
    return report || undefined;
  }

  /**
   * Get all functional reports for a student
   */
  async getFunctionalReportsByStudentId(
    studentId: string
  ): Promise<FunctionalReport[]> {
    return await db
      .select()
      .from(functionalReports)
      .where(eq(functionalReports.studentId, studentId))
      .orderBy(desc(functionalReports.createdAt));
  }

  /**
   * Get the current (active/draft) functional report for a student.
   * Only one active functional report per student.
   */
  async getCurrentFunctionalReport(
    studentId: string
  ): Promise<FunctionalReport | undefined> {
    const [report] = await db
      .select()
      .from(functionalReports)
      .where(
        and(
          eq(functionalReports.studentId, studentId),
          or(
            eq(functionalReports.status, "draft"),
            eq(functionalReports.status, "pending_review")
          )
        )
      )
      .orderBy(desc(functionalReports.createdAt))
      .limit(1);

    return report || undefined;
  }

  /**
   * Get archived functional reports for a student
   */
  async getArchivedFunctionalReports(
    studentId: string
  ): Promise<FunctionalReport[]> {
    return await db
      .select()
      .from(functionalReports)
      .where(
        and(
          eq(functionalReports.studentId, studentId),
          or(
            eq(functionalReports.status, "final"),
            eq(functionalReports.status, "superseded")
          )
        )
      )
      .orderBy(desc(functionalReports.finalizedAt));
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
    id: string
  ): Promise<EducationalReport | undefined> {
    const [report] = await db
      .select()
      .from(educationalReports)
      .where(eq(educationalReports.id, id));
    return report || undefined;
  }

  /**
   * Get all educational reports for a student
   */
  async getEducationalReportsByStudentId(
    studentId: string
  ): Promise<EducationalReport[]> {
    return await db
      .select()
      .from(educationalReports)
      .where(eq(educationalReports.studentId, studentId))
      .orderBy(desc(educationalReports.createdAt));
  }

  /**
   * Get the current (active/draft) educational report for a student.
   * Only one active educational report per student.
   */
  async getCurrentEducationalReport(
    studentId: string
  ): Promise<EducationalReport | undefined> {
    const [report] = await db
      .select()
      .from(educationalReports)
      .where(
        and(
          eq(educationalReports.studentId, studentId),
          or(
            eq(educationalReports.status, "draft"),
            eq(educationalReports.status, "pending_review")
          )
        )
      )
      .orderBy(desc(educationalReports.createdAt))
      .limit(1);

    return report || undefined;
  }

  /**
   * Get archived educational reports for a student
   */
  async getArchivedEducationalReports(
    studentId: string
  ): Promise<EducationalReport[]> {
    return await db
      .select()
      .from(educationalReports)
      .where(
        and(
          eq(educationalReports.studentId, studentId),
          or(
            eq(educationalReports.status, "final"),
            eq(educationalReports.status, "superseded")
          )
        )
      )
      .orderBy(desc(educationalReports.finalizedAt));
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
  async getAllReportsForStudent(studentId: string): Promise<{
    medicalRecords: MedicalRecord[];
    functionalReports: FunctionalReport[];
    educationalReports: EducationalReport[];
  }> {
    const [medRecords, funcReports, eduReports] = await Promise.all([
      this.getMedicalRecordsByStudentId(studentId),
      this.getFunctionalReportsByStudentId(studentId),
      this.getEducationalReportsByStudentId(studentId),
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
  async getCurrentReportsForStudent(studentId: string): Promise<{
    medicalRecord: MedicalRecord | undefined;
    functionalReport: FunctionalReport | undefined;
    educationalReport: EducationalReport | undefined;
  }> {
    const [medRecord, funcReport, eduReport] = await Promise.all([
      this.getCurrentMedicalRecord(studentId),
      this.getCurrentFunctionalReport(studentId),
      this.getCurrentEducationalReport(studentId),
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
