import {
  voices,
  type Voice,
  type InsertVoice,
  type UpdateVoice,
} from "@shared/schema";
import { db } from "../db";
import { eq, desc } from "drizzle-orm";

export class VoiceRecordRepository {
  async createVoice(insert: InsertVoice): Promise<Voice> {
    const [voice] = await db
      .insert(voices)
      .values(insert)
      .returning();
    return voice;
  }

  async getVoiceById(id: string): Promise<Voice | undefined> {
    const [voice] = await db
      .select()
      .from(voices)
      .where(eq(voices.id, id));
    return voice || undefined;
  }

  async getAllVoices(): Promise<Voice[]> {
    return await db
      .select()
      .from(voices)
      .orderBy(desc(voices.createdAt));
  }

  async getActiveVoices(): Promise<Voice[]> {
    return await db
      .select()
      .from(voices)
      .where(eq(voices.active, true))
      .orderBy(voices.name);
  }

  async updateVoice(
    id: string,
    updates: UpdateVoice
  ): Promise<Voice | undefined> {
    const [updated] = await db
      .update(voices)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(voices.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteVoice(id: string): Promise<boolean> {
    const result = await db
      .delete(voices)
      .where(eq(voices.id, id))
      .returning();
    return result.length > 0;
  }
}

export const voiceRecordRepository = new VoiceRecordRepository();
