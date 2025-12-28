import {
    medicalRecords,
    auditLogs,
    type MedicalRecord,
    type InsertMedicalRecord,
    type UpdateMedicalRecord,
    type InsertAuditLog,
  } from "@shared/schema";
  import { db } from "../db";
  import { eq, and, desc } from "drizzle-orm";
  
  export interface SecurityContext {
    userId: string;
    role?: string;
    instituteId?: string;
    hasMedicalAccess?: boolean;
  }
  
  export class MedicalRecordRepository {
    /**
     * Get medical record for a student (with access control)
     */
    async getByStudentId(
      studentId: string,
      ctx: SecurityContext
    ): Promise<MedicalRecord | undefined> {
      // Build where clause with tenant isolation if instituteId provided
      const conditions = [eq(medicalRecords.studentId, studentId)];
      
      if (ctx.instituteId) {
        conditions.push(eq(medicalRecords.instituteId, ctx.instituteId));
      }
  
      const [record] = await db
        .select()
        .from(medicalRecords)
        .where(and(...conditions))
        .orderBy(desc(medicalRecords.updatedAt))
        .limit(1);
  
      if (record) {
        // Update access tracking
        await db
          .update(medicalRecords)
          .set({
            lastAccessedBy: ctx.userId,
            lastAccessedAt: new Date(),
          })
          .where(eq(medicalRecords.id, record.id));
  
        // Log access
        await this.logAccess(ctx, "read", record.id);
      }
  
      return record || undefined;
    }
  
    /**
     * Get medical record by ID
     */
    async getById(
      id: string,
      ctx: SecurityContext
    ): Promise<MedicalRecord | undefined> {
      const conditions = [eq(medicalRecords.id, id)];
      
      if (ctx.instituteId) {
        conditions.push(eq(medicalRecords.instituteId, ctx.instituteId));
      }
  
      const [record] = await db
        .select()
        .from(medicalRecords)
        .where(and(...conditions));
  
      if (record) {
        await db
          .update(medicalRecords)
          .set({
            lastAccessedBy: ctx.userId,
            lastAccessedAt: new Date(),
          })
          .where(eq(medicalRecords.id, record.id));
  
        await this.logAccess(ctx, "read", record.id);
      }
  
      return record || undefined;
    }
  
    /**
     * Create a new medical record
     */
    async create(
      data: InsertMedicalRecord,
      ctx: SecurityContext
    ): Promise<MedicalRecord> {
      const [record] = await db
        .insert(medicalRecords)
        .values({
          ...data,
          instituteId: ctx.instituteId || data.instituteId,
          createdBy: ctx.userId,
          isSensitive: true,
          sensitivityCategory: "medical",
        })
        .returning();
  
      await this.logAccess(ctx, "create", record.id);
  
      return record;
    }
  
    /**
     * Update a medical record
     */
    async update(
      id: string,
      updates: UpdateMedicalRecord,
      ctx: SecurityContext
    ): Promise<MedicalRecord | undefined> {
      const conditions = [eq(medicalRecords.id, id)];
      
      if (ctx.instituteId) {
        conditions.push(eq(medicalRecords.instituteId, ctx.instituteId));
      }
  
      const [updated] = await db
        .update(medicalRecords)
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
     * Delete a medical record (soft delete not implemented - full delete)
     */
    async delete(id: string, ctx: SecurityContext): Promise<boolean> {
      const conditions = [eq(medicalRecords.id, id)];
      
      if (ctx.instituteId) {
        conditions.push(eq(medicalRecords.instituteId, ctx.instituteId));
      }
  
      const result = await db
        .delete(medicalRecords)
        .where(and(...conditions))
        .returning();
  
      if (result.length > 0) {
        await this.logAccess(ctx, "delete", id);
      }
  
      return result.length > 0;
    }
  
    /**
     * Filter fields based on user role
     */
    filterByRole(record: MedicalRecord, role?: string): Partial<MedicalRecord> {
      // Full access roles
      if (role === "admin" || role === "psychologist" || role === "case_manager") {
        return record;
      }
  
      // SLP/Therapist - no insurance info
      if (role === "slp" || role === "therapist") {
        const { ...filtered } = record;
        return filtered;
      }
  
      // Teacher - only emergency info
      if (role === "teacher") {
        return {
          id: record.id,
          studentId: record.studentId,
          primaryDiagnosis: record.primaryDiagnosis,
          ideaClassification: record.ideaClassification,
          allergies: record.allergies,
          medications: record.medications,
          medicalEquipment: record.medicalEquipment,
          dietaryRestrictions: record.dietaryRestrictions,
          emergencyPlan: record.emergencyPlan,
          seizureProtocol: record.seizureProtocol,
        };
      }
  
      // Default - minimal info
      return {
        id: record.id,
        studentId: record.studentId,
        allergies: record.allergies,
        emergencyPlan: record.emergencyPlan,
      };
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
          resourceType: "medical_record",
          resourceId,
          instituteId: ctx.instituteId,
          changedFields: changedFields,
          success: true,
        };
  
        await db.insert(auditLogs).values(auditEntry);
      } catch (error) {
        console.error("Failed to log audit entry:", error);
        // Don't throw - audit logging shouldn't break main operation
      }
    }
  }
  
  export const medicalRecordRepository = new MedicalRecordRepository();