import {
    medicalRecords,
    type MedicalRecord,
    type InsertMedicalRecord,
    type UpdateMedicalRecord,
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
    hasMedicalAccess?: boolean;
  }

  export class MedicalRecordRepository {
    private ref(studentId: string): EntityRef {
      return { type: "student", id: studentId };
    }

    /**
     * Get medical record for a student (with access control)
     */
    async getByStudentId(
      studentId: string,
      ctx: SecurityContext
    ): Promise<MedicalRecord | undefined> {
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

      if (!record) return undefined;
      const [hydrated] = await hydrateRecords("medical_records", [record], this.ref(studentId));
      return hydrated;
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

      if (!record) return undefined;
      const [hydrated] = await hydrateRecords("medical_records", [record]);
      return hydrated;
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
          userId: ctx.userId,
          isSensitive: true,
          sensitivityCategory: "medical",
        })
        .returning();

      const ref = this.ref(record.studentId);
      const ext = await extractSensitiveFields("medical_records", record.id, record as Record<string, unknown>, ref);
      if (ext.isExternal) {
        const nullSet: Record<string, null> = {};
        for (const key of ext.externalWrites.keys()) {
          const field = key.split("/").pop()!;
          nullSet[field] = null;
        }
        await db.update(medicalRecords).set(nullSet).where(eq(medicalRecords.id, record.id));
        await persistExtracted(ref, ext.externalWrites);
      }
      return ext.completeData as MedicalRecord;
    }

    /**
     * Update a medical record
     */
    async update(
      id: string,
      updates: UpdateMedicalRecord,
      ctx: SecurityContext
    ): Promise<MedicalRecord | undefined> {
      // Need to look up the record first to resolve entity ref
      const existing = await this.getById(id, ctx);
      if (!existing) return undefined;

      const ref = this.ref(existing.studentId);
      const ext = await extractSensitiveFields("medical_records", id, updates as Record<string, unknown>, ref);

      const conditions = [eq(medicalRecords.id, id)];
      if (ctx.instituteId) {
        conditions.push(eq(medicalRecords.instituteId, ctx.instituteId));
      }

      const [updated] = await db
        .update(medicalRecords)
        .set({ ...ext.dbData, updatedAt: new Date() })
        .where(and(...conditions))
        .returning();

      if (!updated) return undefined;
      if (ext.isExternal) await persistExtracted(ref, ext.externalWrites);
      const [hydrated] = await hydrateRecords("medical_records", [updated], ref);
      return hydrated;
    }

    /**
     * Delete a medical record (soft delete not implemented - full delete)
     */
    async delete(id: string, ctx: SecurityContext): Promise<boolean> {
      // Look up the record to get studentId for external cleanup
      const existing = await this.getById(id, ctx);

      const conditions = [eq(medicalRecords.id, id)];
      if (ctx.instituteId) {
        conditions.push(eq(medicalRecords.instituteId, ctx.instituteId));
      }

      const result = await db
        .delete(medicalRecords)
        .where(and(...conditions))
        .returning();

      if (result.length > 0 && existing) {
        await deleteExternalData("medical_records", id, this.ref(existing.studentId));
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
          alertsAllergies: record.alertsAllergies,
          alertsSeizures: record.alertsSeizures,
          medications: record.medications,
          medicalEquipment: record.medicalEquipment,
        };
      }

      // Default - minimal info
      return {
        id: record.id,
        studentId: record.studentId,
        alertsAllergies: record.alertsAllergies,
        alertsSeizures: record.alertsSeizures,
      };
    }
  
  }
  
  export const medicalRecordRepository = new MedicalRecordRepository();