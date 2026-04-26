/**
 * reportService.ts
 * 
 * Service layer for medical records, functional reports, and educational reports.
 * Contains business logic and access control for the reports system.
 */

import { reportRepository } from "../repositories";
import { studentService } from "../services";
import type { AccessCtx } from "./sharing/visibility";
import {
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

export class ReportService {
  // ==========================================================================
  // ACCESS CONTROL
  // ==========================================================================

  /**
   * Verify user has access to a student's reports
   */
  async verifyReportAccess(
    studentId: string,
    userId: string,
    reportType: "medical" | "functional" | "educational",
    instituteId?: string
  ): Promise<{
    hasAccess: boolean;
    hasMedicalRights?: boolean;
    hasEducationalRights?: boolean;
  }> {
    const access = await studentService.verifyStudentAccess(studentId, userId, instituteId);
    if (!access.hasAccess) {
      return { hasAccess: false };
    }

    // Check specific rights based on report type
    if (reportType === "medical") {
      return {
        hasAccess: access.hasMedicalRights ?? false,
        hasMedicalRights: access.hasMedicalRights,
      };
    }

    if (reportType === "functional" || reportType === "educational") {
      return {
        hasAccess: access.hasEducationalRights ?? false,
        hasEducationalRights: access.hasEducationalRights,
      };
    }

    return { hasAccess: access.hasAccess };
  }

  // ==========================================================================
  // MEDICAL RECORD OPERATIONS
  // ==========================================================================

  /**
   * Create a new medical record for a student
   */
  async createMedicalRecord(
    data: InsertMedicalRecord
  ): Promise<MedicalRecord> {
    // Check if there's already an active medical record for this student/institute
    const existing = await reportRepository.getCurrentMedicalRecord(
      data.studentId,
      data.instituteId ?? undefined
    );

    if (existing) {
      // Archive the existing record before creating new one
      await reportRepository.archiveMedicalRecord(existing.id);
    }

    return reportRepository.createMedicalRecord(data);
  }

  /**
   * Get a medical record by ID with access verification.
   * `ctx` (when set) gates the row read through the cross-institute visibility
   * helper before the role-based access check fires.
   */
  async getMedicalRecordById(
    id: string,
    userId: string,
    ctx?: AccessCtx,
  ): Promise<{ record: MedicalRecord | undefined; hasAccess: boolean }> {
    const record = await reportRepository.getMedicalRecordById(id, ctx);
    if (!record) {
      return { record: undefined, hasAccess: false };
    }

    const access = await this.verifyReportAccess(
      record.studentId,
      userId,
      "medical"
    );
    return { record: access.hasAccess ? record : undefined, hasAccess: access.hasAccess };
  }

  /**
   * Get all medical records for a student
   */
  async getMedicalRecordsByStudentId(
    studentId: string,
    ctx?: AccessCtx,
  ): Promise<MedicalRecord[]> {
    return reportRepository.getMedicalRecordsByStudentId(studentId, ctx);
  }

  /**
   * Get current medical record for a student
   */
  async getCurrentMedicalRecord(
    studentId: string,
    instituteId?: string,
    ctx?: AccessCtx,
  ): Promise<MedicalRecord | undefined> {
    return reportRepository.getCurrentMedicalRecord(studentId, instituteId, ctx);
  }

  /**
   * Get archived medical records
   */
  async getArchivedMedicalRecords(
    studentId: string,
    instituteId?: string,
    ctx?: AccessCtx,
  ): Promise<MedicalRecord[]> {
    return reportRepository.getArchivedMedicalRecords(studentId, instituteId, ctx);
  }

  /**
   * Update a medical record
   */
  async updateMedicalRecord(
    id: string,
    updates: UpdateMedicalRecord
  ): Promise<MedicalRecord | undefined> {
    const record = await reportRepository.getMedicalRecordById(id);
    if (!record) return undefined;

    // Only allow updates to non-finalized records
    if (record.status === "final" || record.status === "superseded") {
      throw new Error("Cannot update a finalized or superseded record");
    }

    return reportRepository.updateMedicalRecord(id, updates);
  }

  /**
   * Finalize a medical record
   */
  async finalizeMedicalRecord(id: string): Promise<MedicalRecord | undefined> {
    const record = await reportRepository.getMedicalRecordById(id);
    if (!record) return undefined;

    if (record.status === "final" || record.status === "superseded") {
      throw new Error("Record is already finalized");
    }

    return reportRepository.finalizeMedicalRecord(id);
  }

  /**
   * Create a new revision of a medical record (copy finalized as draft)
   */
  async createMedicalRecordRevision(
    sourceId: string,
    userId: string
  ): Promise<MedicalRecord | undefined> {
    const source = await reportRepository.getMedicalRecordById(sourceId);
    if (!source) return undefined;

    // Mark the source as superseded
    await reportRepository.archiveMedicalRecord(sourceId);

    // Create new draft from the source
    return reportRepository.copyMedicalRecordAsDraft(sourceId, userId);
  }

  /**
   * Delete a medical record (drafts only)
   */
  async deleteMedicalRecord(id: string): Promise<boolean> {
    return reportRepository.deleteMedicalRecord(id);
  }

  // ==========================================================================
  // FUNCTIONAL REPORT OPERATIONS
  // ==========================================================================

  /**
   * Create a new functional report for a student
   */
  async createFunctionalReport(
    data: InsertFunctionalReport
  ): Promise<FunctionalReport> {
    // Check if there's already an active functional report
    const existing = await reportRepository.getCurrentFunctionalReport(
      data.studentId
    );

    if (existing) {
      // Archive the existing report
      await reportRepository.archiveFunctionalReport(existing.id);
    }

    return reportRepository.createFunctionalReport(data);
  }

  /**
   * Get a functional report by ID
   */
  async getFunctionalReportById(
    id: string,
    userId: string,
    ctx?: AccessCtx,
  ): Promise<{ report: FunctionalReport | undefined; hasAccess: boolean }> {
    const report = await reportRepository.getFunctionalReportById(id, ctx);
    if (!report) {
      return { report: undefined, hasAccess: false };
    }

    const access = await this.verifyReportAccess(
      report.studentId,
      userId,
      "functional"
    );
    return { report: access.hasAccess ? report : undefined, hasAccess: access.hasAccess };
  }

  /**
   * Get all functional reports for a student
   */
  async getFunctionalReportsByStudentId(
    studentId: string,
    ctx?: AccessCtx,
  ): Promise<FunctionalReport[]> {
    return reportRepository.getFunctionalReportsByStudentId(studentId, ctx);
  }

  /**
   * Get current functional report for a student
   */
  async getCurrentFunctionalReport(
    studentId: string,
    ctx?: AccessCtx,
  ): Promise<FunctionalReport | undefined> {
    return reportRepository.getCurrentFunctionalReport(studentId, ctx);
  }

  /**
   * Get archived functional reports
   */
  async getArchivedFunctionalReports(
    studentId: string,
    ctx?: AccessCtx,
  ): Promise<FunctionalReport[]> {
    return reportRepository.getArchivedFunctionalReports(studentId, ctx);
  }

  /**
   * Update a functional report
   */
  async updateFunctionalReport(
    id: string,
    updates: UpdateFunctionalReport
  ): Promise<FunctionalReport | undefined> {
    const report = await reportRepository.getFunctionalReportById(id);
    if (!report) return undefined;

    if (report.status === "final" || report.status === "superseded") {
      throw new Error("Cannot update a finalized or superseded report");
    }

    return reportRepository.updateFunctionalReport(id, updates);
  }

  /**
   * Finalize a functional report
   */
  async finalizeFunctionalReport(
    id: string
  ): Promise<FunctionalReport | undefined> {
    const report = await reportRepository.getFunctionalReportById(id);
    if (!report) return undefined;

    if (report.status === "final" || report.status === "superseded") {
      throw new Error("Report is already finalized");
    }

    return reportRepository.finalizeFunctionalReport(id);
  }

  /**
   * Create a new revision of a functional report
   */
  async createFunctionalReportRevision(
    sourceId: string,
    userId: string
  ): Promise<FunctionalReport | undefined> {
    const source = await reportRepository.getFunctionalReportById(sourceId);
    if (!source) return undefined;

    await reportRepository.archiveFunctionalReport(sourceId);
    return reportRepository.copyFunctionalReportAsDraft(sourceId, userId);
  }

  /**
   * Delete a functional report (drafts only)
   */
  async deleteFunctionalReport(id: string): Promise<boolean> {
    return reportRepository.deleteFunctionalReport(id);
  }

  // ==========================================================================
  // EDUCATIONAL REPORT OPERATIONS
  // ==========================================================================

  /**
   * Create a new educational report for a student
   */
  async createEducationalReport(
    data: InsertEducationalReport
  ): Promise<EducationalReport> {
    // Check if there's already an active educational report
    const existing = await reportRepository.getCurrentEducationalReport(
      data.studentId
    );

    if (existing) {
      // Archive the existing report
      await reportRepository.archiveEducationalReport(existing.id);
    }

    return reportRepository.createEducationalReport(data);
  }

  /**
   * Get an educational report by ID
   */
  async getEducationalReportById(
    id: string,
    userId: string,
    ctx?: AccessCtx,
  ): Promise<{ report: EducationalReport | undefined; hasAccess: boolean }> {
    const report = await reportRepository.getEducationalReportById(id, ctx);
    if (!report) {
      return { report: undefined, hasAccess: false };
    }

    const access = await this.verifyReportAccess(
      report.studentId,
      userId,
      "educational"
    );
    return { report: access.hasAccess ? report : undefined, hasAccess: access.hasAccess };
  }

  /**
   * Get all educational reports for a student
   */
  async getEducationalReportsByStudentId(
    studentId: string,
    ctx?: AccessCtx,
  ): Promise<EducationalReport[]> {
    return reportRepository.getEducationalReportsByStudentId(studentId, ctx);
  }

  /**
   * Get current educational report for a student
   */
  async getCurrentEducationalReport(
    studentId: string,
    ctx?: AccessCtx,
  ): Promise<EducationalReport | undefined> {
    return reportRepository.getCurrentEducationalReport(studentId, ctx);
  }

  /**
   * Get archived educational reports
   */
  async getArchivedEducationalReports(
    studentId: string,
    ctx?: AccessCtx,
  ): Promise<EducationalReport[]> {
    return reportRepository.getArchivedEducationalReports(studentId, ctx);
  }

  /**
   * Update an educational report
   */
  async updateEducationalReport(
    id: string,
    updates: UpdateEducationalReport
  ): Promise<EducationalReport | undefined> {
    const report = await reportRepository.getEducationalReportById(id);
    if (!report) return undefined;

    if (report.status === "final" || report.status === "superseded") {
      throw new Error("Cannot update a finalized or superseded report");
    }

    return reportRepository.updateEducationalReport(id, updates);
  }

  /**
   * Finalize an educational report
   */
  async finalizeEducationalReport(
    id: string
  ): Promise<EducationalReport | undefined> {
    const report = await reportRepository.getEducationalReportById(id);
    if (!report) return undefined;

    if (report.status === "final" || report.status === "superseded") {
      throw new Error("Report is already finalized");
    }

    return reportRepository.finalizeEducationalReport(id);
  }

  /**
   * Create a new revision of an educational report
   */
  async createEducationalReportRevision(
    sourceId: string,
    userId: string
  ): Promise<EducationalReport | undefined> {
    const source = await reportRepository.getEducationalReportById(sourceId);
    if (!source) return undefined;

    await reportRepository.archiveEducationalReport(sourceId);
    return reportRepository.copyEducationalReportAsDraft(sourceId, userId);
  }

  /**
   * Delete an educational report (drafts only)
   */
  async deleteEducationalReport(id: string): Promise<boolean> {
    return reportRepository.deleteEducationalReport(id);
  }

  // ==========================================================================
  // COMPOSITE OPERATIONS
  // ==========================================================================

  /**
   * Get all reports for a student with access control
   */
  async getAllReportsForStudent(
    studentId: string,
    userId: string,
    instituteId?: string,
    ctx?: AccessCtx,
  ): Promise<{
    medicalRecords: MedicalRecord[];
    functionalReports: FunctionalReport[];
    educationalReports: EducationalReport[];
    access: {
      hasMedicalRights: boolean;
      hasEducationalRights: boolean;
    };
  }> {
    const studentAccess = await studentService.verifyStudentAccess(
      studentId,
      userId,
      instituteId
    );

    if (!studentAccess.hasAccess) {
      return {
        medicalRecords: [],
        functionalReports: [],
        educationalReports: [],
        access: {
          hasMedicalRights: false,
          hasEducationalRights: false,
        },
      };
    }

    const allReports = await reportRepository.getAllReportsForStudent(studentId, ctx);

    return {
      medicalRecords: studentAccess.hasMedicalRights
        ? allReports.medicalRecords
        : [],
      functionalReports: studentAccess.hasEducationalRights
        ? allReports.functionalReports
        : [],
      educationalReports: studentAccess.hasEducationalRights
        ? allReports.educationalReports
        : [],
      access: {
        hasMedicalRights: studentAccess.hasMedicalRights ?? false,
        hasEducationalRights: studentAccess.hasEducationalRights ?? false,
      },
    };
  }

  /**
   * Get current (non-archived) reports for a student
   */
  async getCurrentReportsForStudent(
    studentId: string,
    userId: string,
    instituteId?: string,
    ctx?: AccessCtx,
  ): Promise<{
    medicalRecord: MedicalRecord | undefined;
    functionalReport: FunctionalReport | undefined;
    educationalReport: EducationalReport | undefined;
    access: {
      hasMedicalRights: boolean;
      hasEducationalRights: boolean;
    };
  }> {
    const studentAccess = await studentService.verifyStudentAccess(
      studentId,
      userId,
      instituteId
    );

    if (!studentAccess.hasAccess) {
      return {
        medicalRecord: undefined,
        functionalReport: undefined,
        educationalReport: undefined,
        access: {
          hasMedicalRights: false,
          hasEducationalRights: false,
        },
      };
    }

    const currentReports = await reportRepository.getCurrentReportsForStudent(
      studentId,
      ctx,
    );

    return {
      medicalRecord: studentAccess.hasMedicalRights
        ? currentReports.medicalRecord
        : undefined,
      functionalReport: studentAccess.hasEducationalRights
        ? currentReports.functionalReport
        : undefined,
      educationalReport: studentAccess.hasEducationalRights
        ? currentReports.educationalReport
        : undefined,
      access: {
        hasMedicalRights: studentAccess.hasMedicalRights ?? false,
        hasEducationalRights: studentAccess.hasEducationalRights ?? false,
      },
    };
  }
}

export const reportService = new ReportService();
