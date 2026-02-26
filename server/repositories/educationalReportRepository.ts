import {
    educationalReports,
    type EducationalReport,
    type InsertEducationalReport,
    type UpdateEducationalReport,
  } from "@shared/schema";
  import { db } from "../db";
  import { eq, and, desc } from "drizzle-orm";
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

  export class EducationalReportRepository {
    private ref(studentId: string): EntityRef {
      return { type: "student", id: studentId };
    }

    /**
     * Get all educational reports for a student
     */
    async getByStudentId(
      studentId: string,
      ctx: SecurityContext,
      options?: { limit?: number; offset?: number }
    ): Promise<EducationalReport[]> {
      const conditions = [eq(educationalReports.studentId, studentId)];

      if (ctx.instituteId) {
        conditions.push(eq(educationalReports.instituteId, ctx.instituteId));
      }

      let query = db
        .select()
        .from(educationalReports)
        .where(and(...conditions))
        .orderBy(desc(educationalReports.createdAt));

      if (options?.limit) {
        query = query.limit(options.limit) as typeof query;
      }
      if (options?.offset) {
        query = query.offset(options.offset) as typeof query;
      }

      const reports = await query;
      return hydrateRecords("educational_reports", reports, this.ref(studentId));
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

      const reports = await db
        .select()
        .from(educationalReports)
        .where(and(...conditions))
        .orderBy(desc(educationalReports.createdAt));

      return hydrateRecords("educational_reports", reports);
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

      if (!report) return undefined;
      const [hydrated] = await hydrateRecords("educational_reports", [report]);
      return hydrated;
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

      const ref = this.ref(report.studentId);
      const ext = await extractSensitiveFields("educational_reports", report.id, report as Record<string, unknown>, ref);
      if (ext.isExternal) {
        const nullSet: Record<string, null> = {};
        for (const key of ext.externalWrites.keys()) {
          const field = key.split("/").pop()!;
          nullSet[field] = null;
        }
        await db.update(educationalReports).set(nullSet).where(eq(educationalReports.id, report.id));
        await persistExtracted(ref, ext.externalWrites);
      }
      return ext.completeData as EducationalReport;
    }

    /**
     * Update an educational report
     */
    async update(
      id: string,
      updates: UpdateEducationalReport,
      ctx: SecurityContext
    ): Promise<EducationalReport | undefined> {
      const existing = await this.getById(id, ctx);
      if (!existing) return undefined;

      const ref = this.ref(existing.studentId);
      const ext = await extractSensitiveFields("educational_reports", id, updates as Record<string, unknown>, ref);

      const conditions = [eq(educationalReports.id, id)];
      if (ctx.instituteId) {
        conditions.push(eq(educationalReports.instituteId, ctx.instituteId));
      }

      const [updated] = await db
        .update(educationalReports)
        .set({ ...ext.dbData, updatedAt: new Date() })
        .where(and(...conditions))
        .returning();

      if (!updated) return undefined;
      if (ext.isExternal) await persistExtracted(ref, ext.externalWrites);
      const [hydrated] = await hydrateRecords("educational_reports", [updated], ref);
      return hydrated;
    }
  
    /**
     * Share report with guardians
     */
    // shareWithGuardians and recordGuardianAcknowledgment removed
    // — columns not yet in schema
  
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
        await deleteExternalData("educational_reports", id, this.ref(existing.studentId));
      }
      return result.length > 0;
    }
  
  }
  
  export const educationalReportRepository = new EducationalReportRepository();