import {
    functionalReports,
    type FunctionalReport,
    type InsertFunctionalReport,
    type UpdateFunctionalReport,
  } from "@shared/schema";
  import { db } from "../db";
  import { eq, and, desc, asc } from "drizzle-orm";
  import {
    hydrateRecords,
    extractSensitiveFields,
    persistExtracted,
    deleteExternalData,
    type EntityRef,
  } from "../external-storage";

  export interface SecurityContext {
    userId: string;
    role?: string;
    instituteId?: string;
  }

  export class FunctionalReportRepository {
    private ref(studentId: string): EntityRef {
      return { type: "student", id: studentId };
    }

    /**
     * Get all functional reports for a student
     */
    async getByStudentId(
      studentId: string,
      ctx: SecurityContext,
      options?: { limit?: number; offset?: number }
    ): Promise<FunctionalReport[]> {
      const conditions = [eq(functionalReports.studentId, studentId)];

      if (ctx.instituteId) {
        conditions.push(eq(functionalReports.instituteId, ctx.instituteId));
      }

      let query = db
        .select()
        .from(functionalReports)
        .where(and(...conditions))
        .orderBy(desc(functionalReports.createdAt));

      if (options?.limit) {
        query = query.limit(options.limit) as typeof query;
      }
      if (options?.offset) {
        query = query.offset(options.offset) as typeof query;
      }

      const reports = await query;
      return hydrateRecords("functional_reports", reports, this.ref(studentId));
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
        .orderBy(desc(functionalReports.createdAt));

      return hydrateRecords("functional_reports", reports);
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

      if (!report) return undefined;
      const [hydrated] = await hydrateRecords("functional_reports", [report]);
      return hydrated;
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

      const ref = this.ref(report.studentId);
      const ext = await extractSensitiveFields("functional_reports", report.id, report as Record<string, unknown>, ref);
      if (ext.isExternal) {
        const nullSet: Record<string, null> = {};
        for (const key of ext.externalWrites.keys()) {
          const field = key.split("/").pop()!;
          nullSet[field] = null;
        }
        await db.update(functionalReports).set(nullSet).where(eq(functionalReports.id, report.id));
        await persistExtracted(ref, ext.externalWrites);
      }
      return ext.completeData as FunctionalReport;
    }

    /**
     * Update a functional report
     */
    async update(
      id: string,
      updates: UpdateFunctionalReport,
      ctx: SecurityContext
    ): Promise<FunctionalReport | undefined> {
      const existing = await this.getById(id, ctx);
      if (!existing) return undefined;

      const ref = this.ref(existing.studentId);
      const ext = await extractSensitiveFields("functional_reports", id, updates as Record<string, unknown>, ref);

      const conditions = [eq(functionalReports.id, id)];
      if (ctx.instituteId) {
        conditions.push(eq(functionalReports.instituteId, ctx.instituteId));
      }

      const [updated] = await db
        .update(functionalReports)
        .set({ ...ext.dbData, updatedAt: new Date() })
        .where(and(...conditions))
        .returning();

      if (!updated) return undefined;
      if (ext.isExternal) await persistExtracted(ref, ext.externalWrites);
      const [hydrated] = await hydrateRecords("functional_reports", [updated], ref);
      return hydrated;
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
        await deleteExternalData("functional_reports", id, this.ref(existing.studentId));
      }
      return result.length > 0;
    }
  
  }
  
  export const functionalReportRepository = new FunctionalReportRepository();