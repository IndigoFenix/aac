import {
    functionalReports,
    auditLogs,
    type FunctionalReport,
    type InsertFunctionalReport,
    type UpdateFunctionalReport,
    type InsertAuditLog,
  } from "@shared/schema";
  import { db } from "../db";
  import { eq, and, desc, asc } from "drizzle-orm";
  
  export interface SecurityContext {
    userId: string;
    role?: string;
    instituteId?: string;
  }
  
  export class FunctionalReportRepository {
    /**
     * Get all functional reports for a student
     */
    async getByStudentId(
      studentId: string,
      ctx: SecurityContext,
      options?: { limit?: number; offset?: number; reportType?: string }
    ): Promise<FunctionalReport[]> {
      const conditions = [eq(functionalReports.studentId, studentId)];
      
      if (ctx.instituteId) {
        conditions.push(eq(functionalReports.instituteId, ctx.instituteId));
      }
      
      if (options?.reportType) {
        conditions.push(eq(functionalReports.reportType, options.reportType));
      }
  
      let query = db
        .select()
        .from(functionalReports)
        .where(and(...conditions))
        .orderBy(desc(functionalReports.reportDate));
  
      if (options?.limit) {
        query = query.limit(options.limit) as typeof query;
      }
      if (options?.offset) {
        query = query.offset(options.offset) as typeof query;
      }
  
      const reports = await query;
  
      // Log access
      if (reports.length > 0) {
        await this.logAccess(ctx, "read", `student:${studentId}`);
      }
  
      return reports;
    }
  
    /**
     * Get functional reports by program
     */
    async getByProgramId(
      programId: string,
      ctx: SecurityContext
    ): Promise<FunctionalReport[]> {
      const conditions = [eq(functionalReports.programId, programId)];
      
      if (ctx.instituteId) {
        conditions.push(eq(functionalReports.instituteId, ctx.instituteId));
      }
  
      const reports = await db
        .select()
        .from(functionalReports)
        .where(and(...conditions))
        .orderBy(desc(functionalReports.reportDate));
  
      return reports;
    }
  
    /**
     * Get a single functional report by ID
     */
    async getById(
      id: string,
      ctx: SecurityContext
    ): Promise<FunctionalReport | undefined> {
      const conditions = [eq(functionalReports.id, id)];
      
      if (ctx.instituteId) {
        conditions.push(eq(functionalReports.instituteId, ctx.instituteId));
      }
  
      const [report] = await db
        .select()
        .from(functionalReports)
        .where(and(...conditions));
  
      if (report) {
        await this.logAccess(ctx, "read", report.id);
      }
  
      return report || undefined;
    }
  
    /**
     * Create a new functional report
     */
    async create(
      data: InsertFunctionalReport,
      ctx: SecurityContext
    ): Promise<FunctionalReport> {
      const [report] = await db
        .insert(functionalReports)
        .values({
          ...data,
          instituteId: ctx.instituteId || data.instituteId,
          isSensitive: true,
          sensitivityCategory: "behavioral",
          status: data.status || "draft",
        })
        .returning();
  
      await this.logAccess(ctx, "create", report.id);
  
      return report;
    }
  
    /**
     * Update a functional report
     */
    async update(
      id: string,
      updates: UpdateFunctionalReport,
      ctx: SecurityContext
    ): Promise<FunctionalReport | undefined> {
      const conditions = [eq(functionalReports.id, id)];
      
      if (ctx.instituteId) {
        conditions.push(eq(functionalReports.instituteId, ctx.instituteId));
      }
  
      const [updated] = await db
        .update(functionalReports)
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
     * Submit report for review
     */
    async submitForReview(
      id: string,
      ctx: SecurityContext
    ): Promise<FunctionalReport | undefined> {
      return this.update(
        id,
        {
          status: "pending_review",
          submittedAt: new Date(),
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
    ): Promise<FunctionalReport | undefined> {
      return this.update(
        id,
        {
          status: "final",
          finalizedAt: new Date(),
          finalizedBy: ctx.userId,
        },
        ctx
      );
    }
  
    /**
     * Delete a functional report
     */
    async delete(id: string, ctx: SecurityContext): Promise<boolean> {
      // Only allow deleting drafts
      const existing = await this.getById(id, ctx);
      if (!existing) return false;
      
      if (existing.status !== "draft") {
        throw new Error("Only draft reports can be deleted");
      }
  
      const conditions = [eq(functionalReports.id, id)];
      
      if (ctx.instituteId) {
        conditions.push(eq(functionalReports.instituteId, ctx.instituteId));
      }
  
      const result = await db
        .delete(functionalReports)
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
          resourceType: "functional_report",
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
  
  export const functionalReportRepository = new FunctionalReportRepository();