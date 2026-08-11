import {
  aacSettings,
  type AacSettings,
  type InsertAacSettings,
  type UpdateAacSettings,
} from "@shared/schema";
import { db } from "../db";
import { eq } from "drizzle-orm";
import {
  hydrateRecords,
  extractSensitiveFields,
  persistExtracted,
  deleteExternalData,
  type EntityRef,
} from "../external-storage";
import { elevenLabsKeyProblem } from "@shared/elevenlabs-key";

/**
 * Thrown when a write carries a value that cannot be what the column means —
 * e.g. an ElevenLabs key ID or an autofilled password where the "sk_" secret
 * belongs. `message` is the client-translatable "error:CODE" convention.
 */
export class InvalidAacSettingError extends Error {
  constructor(
    public readonly field: string,
    public readonly code: string,
  ) {
    super(`error:${code}`);
    this.name = "InvalidAacSettingError";
  }
}

export class AacSettingsRepository {
  private ref(studentId: string): EntityRef {
    return { type: "student", id: studentId };
  }

  /**
   * Get AAC settings for a student
   */
  async getByStudentId(studentId: string): Promise<AacSettings | undefined> {
    const [settings] = await db
      .select()
      .from(aacSettings)
      .where(eq(aacSettings.studentId, studentId));
    if (!settings) return undefined;
    const [hydrated] = await hydrateRecords("aac_settings", [settings], this.ref(studentId));
    return hydrated;
  }

  /**
   * Create AAC settings for a student
   */
  async create(data: InsertAacSettings): Promise<AacSettings> {
    const [created] = await db
      .insert(aacSettings)
      .values(data)
      .returning();
    const ref = this.ref(created.studentId);
    const ext = await extractSensitiveFields("aac_settings", created.id, created as Record<string, unknown>, ref);
    if (ext.isExternal) {
      const nullSet: Record<string, null> = {};
      for (const key of ext.externalWrites.keys()) {
        const field = key.split("/").pop()!;
        nullSet[field] = null;
      }
      await db.update(aacSettings).set(nullSet).where(eq(aacSettings.id, created.id));
      await persistExtracted(ref, ext.externalWrites);
    }
    return ext.completeData as AacSettings;
  }

  /**
   * Create default AAC settings for a student (with only studentId)
   */
  async createDefaults(studentId: string): Promise<AacSettings> {
    return this.create({ studentId });
  }

  /**
   * Every write path funnels through here (clinician PATCH, AAC device,
   * assistant memory-schema edits), so this is the one place a nonsense value
   * can be stopped before it reaches the database. Returns a copy — callers'
   * objects are not mutated.
   */
  private sanitizeUpdates(updates: UpdateAacSettings): UpdateAacSettings {
    const key = (updates as Record<string, unknown>).elevenlabsApiKey;
    if (typeof key !== "string") return updates;
    const problem = elevenLabsKeyProblem(key);
    if (problem) throw new InvalidAacSettingError("elevenlabsApiKey", problem);
    return { ...updates, elevenlabsApiKey: key.trim() };
  }

  /**
   * Update AAC settings for a student (upsert: creates if missing)
   */
  async upsert(studentId: string, updates: UpdateAacSettings): Promise<AacSettings> {
    updates = this.sanitizeUpdates(updates);
    const existing = await this.getByStudentId(studentId);
    if (existing) {
      const ref = this.ref(studentId);
      const ext = await extractSensitiveFields("aac_settings", existing.id, updates as Record<string, unknown>, ref);
      const [updated] = await db
        .update(aacSettings)
        .set({ ...ext.dbData, updatedAt: new Date() })
        .where(eq(aacSettings.studentId, studentId))
        .returning();
      if (ext.isExternal) await persistExtracted(ref, ext.externalWrites);
      const [hydrated] = await hydrateRecords("aac_settings", [updated], ref);
      return hydrated;
    }
    return this.create({ studentId, ...updates });
  }

  /**
   * Delete AAC settings for a student
   */
  async deleteByStudentId(studentId: string): Promise<boolean> {
    const existing = await this.getByStudentId(studentId);
    const result = await db
      .delete(aacSettings)
      .where(eq(aacSettings.studentId, studentId))
      .returning();
    if (result.length > 0 && existing) {
      await deleteExternalData("aac_settings", existing.id, this.ref(studentId));
    }
    return result.length > 0;
  }
}

export const aacSettingsRepository = new AacSettingsRepository();
