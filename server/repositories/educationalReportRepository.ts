import {
    educationalReports,
    auditLogs,
    type EducationalReport,
    type InsertEducationalReport,
    type UpdateEducationalReport,
    type InsertAuditLog,
  } from "@shared/schema";
  import { db } from "../db";
  import { eq, and, desc } from "drizzle-orm";
  
  export interface SecurityContext {
    userId: string;
    role?: string;
    instituteId?: string;
  }
  
  export class EducationalReportRepository {
    /**
     * Get all educational reports for a student
     */
    async getByStudentId(
      studentId: string,
      ctx: SecurityContext,
      options?: { limit?: number; offset?: number; reportType?: string; academicYear?: string }
    ): Promise<EducationalReport[]> {
      const conditions = [eq(educationalReports.studentId, studentId)];
      
      if (ctx.instituteId) {
        conditions.push(eq(educationalReports.instituteId, ctx.instituteId));
      }
      
      if (options?.reportType) {
        conditions.push(eq(educationalReports.reportType, options.reportType));
      }
      
      if (options?.academicYear) {
        conditions.push(eq(educationalReports.academicYear, options.academicYear));
      }
  
      let query = db
        .select()
        .from(educationalReports)
        .where(and(...conditions))
        .orderBy(desc(educationalReports.reportDate));
  
      if (options?.limit) {
        query = query.limit(options.limit) as typeof query;
      }
      if (options?.offset) {
        query = query.offset(options.offset) as typeof query;
      }
  
      const reports = await query;
  
      if (reports.length > 0) {
        await this.logAccess(ctx, "read", `student:${studentId}`);
      }
  
      return reports;
    }
  
    /**
     * Get educational reports by program
     */
    async getByProgramId(
      programId: string,
      ctx: SecurityContext
    ): Promise<EducationalReport[]> {
      const conditions = [eq(educationalReports.programId, programId)];
      
      if (ctx.instituteId) {
        conditions.push(eq(educationalReports.instituteId, ctx.instituteId));
      }
  
      return db
        .select()
        .from(educationalReports)
        .where(and(...conditions))
        .orderBy(desc(educationalReports.reportDate));
    }
  
    /**
     * Get a single educational report by ID
     */
    async getById(
      id: string,
      ctx: SecurityContext
    ): Promise<EducationalReport | undefined> {
      const conditions = [eq(educationalReports.id, id)];
      
      if (ctx.instituteId) {
        conditions.push(eq(educationalReports.instituteId, ctx.instituteId));
      }
  
      const [report] = await db
        .select()
        .from(educationalReports)
        .where(and(...conditions));
  
      if (report) {
        await this.logAccess(ctx, "read", report.id);
      }
  
      return report || undefined;
    }
  
    /**
     * Create a new educational report
     */
    async create(
      data: InsertEducationalReport,
      ctx: SecurityContext
    ): Promise<EducationalReport> {
      const [report] = await db
        .insert(educationalReports)
        .values({
          ...data,
          instituteId: ctx.instituteId || data.instituteId,
          isSensitive: true,
          sensitivityCategory: "educational",
          status: data.status || "draft",
        })
        .returning();
  
      await this.logAccess(ctx, "create", report.id);
  
      return report;
    }
  
    /**
     * Update an educational report
     */
    async update(
      id: string,
      updates: UpdateEducationalReport,
      ctx: SecurityContext
    ): Promise<EducationalReport | undefined> {
      const conditions = [eq(educationalReports.id, id)];
      
      if (ctx.instituteId) {
        conditions.push(eq(educationalReports.instituteId, ctx.instituteId));
      }
  
      const [updated] = await db
        .update(educationalReports)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();
  
      if (updated) {
        await this.logAccess(ctx, "update", id, Object.keys(updates));
      }
  
      return updated || undefined;
    }
  
    /**
     * Share report with guardians
     */
    async shareWithGuardians(
      id: string,
      ctx: SecurityContext
    ): Promise<EducationalReport | undefined> {
      return this.update(
        id,
        {
          sharedWithGuardians: true,
          sharedAt: new Date(),
        },
        ctx
      );
    }
  
    /**
     * Record guardian acknowledgment
     */
    async recordGuardianAcknowledgment(
      id: string,
      ctx: SecurityContext
    ): Promise<EducationalReport | undefined> {
      return this.update(
        id,
        {
          guardianAcknowledgedAt: new Date(),
        },
        ctx
      );
    }
  
    /**
     * Finalize a report
     */
    async finalize(
      id: string,
      ctx: SecurityContext
    ): Promise<EducationalReport | undefined> {
      return this.update(
        id,
        {
          status: "final",
          finalizedAt: new Date(),
        },
        ctx
      );
    }
  
    /**
     * Delete an educational report
     */
    async delete(id: string, ctx: SecurityContext): Promise<boolean> {
      const existing = await this.getById(id, ctx);
      if (!existing) return false;
      
      if (existing.status !== "draft") {
        throw new Error("Only draft reports can be deleted");
      }
  
      const conditions = [eq(educationalReports.id, id)];
      
      if (ctx.instituteId) {
        conditions.push(eq(educationalReports.instituteId, ctx.instituteId));
      }
  
      const result = await db
        .delete(educationalReports)
        .where(and(...conditions))
        .returning();
  
      if (result.length > 0) {
        await this.logAccess(ctx, "delete", id);
      }
  
      return result.length > 0;
    }
  
    /**
     * Log access to audit trail
     */
    private async logAccess(
      ctx: SecurityContext,
      action: "read" | "create" | "update" | "delete",
      resourceId: string,
      changedFields?: string[]
    ): Promise<void> {
      try {
        const auditEntry: InsertAuditLog = {
          actorUserId: ctx.userId,
          action,
          resourceType: "educational_report",
          resourceId,
          instituteId: ctx.instituteId,
          changedFields,
          success: true,
        };
  
        await db.insert(auditLogs).values(auditEntry);
      } catch (error) {
        console.error("Failed to log audit entry:", error);
      }
    }
  }
  
  export const educationalReportRepository = new EducationalReportRepository();