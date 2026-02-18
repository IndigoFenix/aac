import {
    medicalRecordRepository,
    type SecurityContext,
  } from "../repositories/medicalRecordRepository";
  import { functionalReportRepository } from "../repositories/functionalReportRepository";
  import { educationalReportRepository } from "../repositories/educationalReportRepository";
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
  } from "@shared/schema";
  import { studentRepository } from "../repositories";
  
  /**
   * RecordsService
   * 
   * Unified service for managing sensitive student records.
   * Handles access control and filtering based on user role.
   */
  export class RecordsService {
    // ===========================================
    // Access Control Helpers
    // ===========================================
  
    /**
     * Verify user has access to a student's records
     */
    async verifyStudentAccess(
      studentId: string,
      userId: string
    ): Promise<boolean> {
      const { hasAccess } = await studentRepository.userHasAccessToStudent(
        userId,
        studentId
      );
      return hasAccess;
    }
  
    /**
     * Build security context from request data
     */
    buildSecurityContext(
      userId: string,
      role?: string,
      instituteId?: string
    ): SecurityContext {
      return {
        userId,
        role,
        instituteId,
        hasMedicalAccess: this.hasMedicalAccess(role),
      };
    }
  
    /**
     * Check if role has medical record access
     */
    hasMedicalAccess(role?: string): boolean {
      const medicalAccessRoles = [
        "admin",
        "psychologist",
        "slp",
        "therapist",
        "case_manager",
        "teacher",
      ];
      return role ? medicalAccessRoles.includes(role) : false;
    }
  
    // ===========================================
    // Medical Records
    // ===========================================
  
    async getMedicalRecord(
      studentId: string,
      ctx: SecurityContext
    ): Promise<Partial<MedicalRecord> | null> {
      const record = await medicalRecordRepository.getByStudentId(studentId, ctx);
      if (!record) return null;
  
      // Filter fields based on role
      return medicalRecordRepository.filterByRole(record, ctx.role);
    }
  
    async getMedicalRecordById(
      id: string,
      ctx: SecurityContext
    ): Promise<Partial<MedicalRecord> | null> {
      const record = await medicalRecordRepository.getById(id, ctx);
      if (!record) return null;
  
      return medicalRecordRepository.filterByRole(record, ctx.role);
    }
  
    async createMedicalRecord(
      data: InsertMedicalRecord,
      ctx: SecurityContext
    ): Promise<MedicalRecord> {
      // Only certain roles can create medical records
      if (!this.canCreateMedicalRecords(ctx.role)) {
        throw new Error("Insufficient permissions to create medical records");
      }
  
      return medicalRecordRepository.create(data, ctx);
    }
  
    async updateMedicalRecord(
      id: string,
      updates: UpdateMedicalRecord,
      ctx: SecurityContext
    ): Promise<MedicalRecord | undefined> {
      if (!this.canEditMedicalRecords(ctx.role)) {
        throw new Error("Insufficient permissions to edit medical records");
      }
  
      return medicalRecordRepository.update(id, updates, ctx);
    }
  
    async deleteMedicalRecord(
      id: string,
      ctx: SecurityContext
    ): Promise<boolean> {
      if (ctx.role !== "admin") {
        throw new Error("Only administrators can delete medical records");
      }
  
      return medicalRecordRepository.delete(id, ctx);
    }
  
    private canCreateMedicalRecords(role?: string): boolean {
      return ["admin", "case_manager", "psychologist"].includes(role || "");
    }
  
    private canEditMedicalRecords(role?: string): boolean {
      return ["admin", "case_manager", "psychologist", "slp"].includes(role || "");
    }
  
    // ===========================================
    // Functional Reports
    // ===========================================
  
    async getFunctionalReports(
      studentId: string,
      ctx: SecurityContext,
      options?: { limit?: number; offset?: number; reportType?: string }
    ): Promise<FunctionalReport[]> {
      return functionalReportRepository.getByStudentId(studentId, ctx, options);
    }
  
    async getFunctionalReportsByProgram(
      programId: string,
      ctx: SecurityContext
    ): Promise<FunctionalReport[]> {
      return functionalReportRepository.getByProgramId(programId, ctx);
    }
  
    async getFunctionalReportById(
      id: string,
      ctx: SecurityContext
    ): Promise<FunctionalReport | undefined> {
      return functionalReportRepository.getById(id, ctx);
    }
  
    async createFunctionalReport(
      data: InsertFunctionalReport,
      ctx: SecurityContext
    ): Promise<FunctionalReport> {
      if (!this.canCreateFunctionalReports(ctx.role)) {
        throw new Error("Insufficient permissions to create functional reports");
      }
  
      return functionalReportRepository.create(data, ctx);
    }
  
    async updateFunctionalReport(
      id: string,
      updates: UpdateFunctionalReport,
      ctx: SecurityContext
    ): Promise<FunctionalReport | undefined> {
      // Check if user can edit
      const existing = await functionalReportRepository.getById(id, ctx);
      if (!existing) return undefined;
  
      // Only author or admin can edit
      if (existing.userId !== ctx.userId && ctx.role !== "admin") {
        throw new Error("Only the author or an admin can edit this report");
      }
  
      // Cannot edit finalized reports
      if (existing.status === "final") {
        throw new Error("Cannot edit a finalized report");
      }
  
      return functionalReportRepository.update(id, updates, ctx);
    }
  
    async submitFunctionalReportForReview(
      id: string,
      ctx: SecurityContext
    ): Promise<FunctionalReport | undefined> {
      return functionalReportRepository.submitForReview(id, ctx);
    }
  
    async finalizeFunctionalReport(
      id: string,
      ctx: SecurityContext
    ): Promise<FunctionalReport | undefined> {
      if (!this.canFinalizeFunctionalReports(ctx.role)) {
        throw new Error("Insufficient permissions to finalize reports");
      }
  
      return functionalReportRepository.finalize(id, ctx);
    }
  
    async deleteFunctionalReport(
      id: string,
      ctx: SecurityContext
    ): Promise<boolean> {
      return functionalReportRepository.delete(id, ctx);
    }
  
    private canCreateFunctionalReports(role?: string): boolean {
      return [
        "admin",
        "slp",
        "therapist",
        "psychologist",
        "case_manager",
        "teacher",
      ].includes(role || "");
    }
  
    private canFinalizeFunctionalReports(role?: string): boolean {
      return ["admin", "case_manager", "psychologist"].includes(role || "");
    }
  
    // ===========================================
    // Educational Reports
    // ===========================================
  
    async getEducationalReports(
      studentId: string,
      ctx: SecurityContext,
      options?: { limit?: number; offset?: number; reportType?: string; academicYear?: string }
    ): Promise<EducationalReport[]> {
      return educationalReportRepository.getByStudentId(studentId, ctx, options);
    }
  
    async getEducationalReportsByProgram(
      programId: string,
      ctx: SecurityContext
    ): Promise<EducationalReport[]> {
      return educationalReportRepository.getByProgramId(programId, ctx);
    }
  
    async getEducationalReportById(
      id: string,
      ctx: SecurityContext
    ): Promise<EducationalReport | undefined> {
      return educationalReportRepository.getById(id, ctx);
    }
  
    async createEducationalReport(
      data: InsertEducationalReport,
      ctx: SecurityContext
    ): Promise<EducationalReport> {
      if (!this.canCreateEducationalReports(ctx.role)) {
        throw new Error("Insufficient permissions to create educational reports");
      }
  
      return educationalReportRepository.create(data, ctx);
    }
  
    async updateEducationalReport(
      id: string,
      updates: UpdateEducationalReport,
      ctx: SecurityContext
    ): Promise<EducationalReport | undefined> {
      const existing = await educationalReportRepository.getById(id, ctx);
      if (!existing) return undefined;
  
      if (existing.userId !== ctx.userId && ctx.role !== "admin") {
        throw new Error("Only the author or an admin can edit this report");
      }
  
      if (existing.status === "final") {
        throw new Error("Cannot edit a finalized report");
      }
  
      return educationalReportRepository.update(id, updates, ctx);
    }
  
    // shareWithGuardians and recordGuardianAcknowledgment not yet in schema
  
    async finalizeEducationalReport(
      id: string,
      ctx: SecurityContext
    ): Promise<EducationalReport | undefined> {
      if (!this.canFinalizeEducationalReports(ctx.role)) {
        throw new Error("Insufficient permissions to finalize reports");
      }
  
      return educationalReportRepository.finalize(id, ctx);
    }
  
    async deleteEducationalReport(
      id: string,
      ctx: SecurityContext
    ): Promise<boolean> {
      return educationalReportRepository.delete(id, ctx);
    }
  
    private canCreateEducationalReports(role?: string): boolean {
      return ["admin", "teacher", "case_manager"].includes(role || "");
    }
  
    private canFinalizeEducationalReports(role?: string): boolean {
      return ["admin", "case_manager", "principal"].includes(role || "");
    }
  }
  
  export const recordsService = new RecordsService();