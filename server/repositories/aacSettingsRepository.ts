import {
  aacSettings,
  type AacSettings,
  type InsertAacSettings,
  type UpdateAacSettings,
} from "@shared/schema";
import { db } from "../db";
import { eq } from "drizzle-orm";

export class AacSettingsRepository {
  /**
   * Get AAC settings for a student
   */
  async getByStudentId(studentId: string): Promise<AacSettings | undefined> {
    const [settings] = await db
      .select()
      .from(aacSettings)
      .where(eq(aacSettings.studentId, studentId));
    return settings || undefined;
  }

  /**
   * Create AAC settings for a student
   */
  async create(data: InsertAacSettings): Promise<AacSettings> {
    const [created] = await db
      .insert(aacSettings)
      .values(data)
      .returning();
    return created;
  }

  /**
   * Create default AAC settings for a student (with only studentId)
   */
  async createDefaults(studentId: string): Promise<AacSettings> {
    return this.create({ studentId });
  }

  /**
   * Update AAC settings for a student (upsert: creates if missing)
   */
  async upsert(studentId: string, updates: UpdateAacSettings): Promise<AacSettings> {
    const existing = await this.getByStudentId(studentId);
    if (existing) {
      const [updated] = await db
        .update(aacSettings)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(aacSettings.studentId, studentId))
        .returning();
      return updated;
    }
    return this.create({ studentId, ...updates });
  }

  /**
   * Delete AAC settings for a student
   */
  async deleteByStudentId(studentId: string): Promise<boolean> {
    const result = await db
      .delete(aacSettings)
      .where(eq(aacSettings.studentId, studentId))
      .returning();
    return result.length > 0;
  }
}

export const aacSettingsRepository = new AacSettingsRepository();
