import {
  savedLocations,
  type SavedLocation,
  type InsertSavedLocation,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc } from "drizzle-orm";

export class SavedLocationRepository {
  async createSavedLocation(location: InsertSavedLocation): Promise<SavedLocation> {
    const [createdLocation] = await db
      .insert(savedLocations)
      .values(location)
      .returning();
    return createdLocation;
  }

  async getUserSavedLocations(userId: string): Promise<SavedLocation[]> {
    return await db
      .select()
      .from(savedLocations)
      .where(
        and(
          eq(savedLocations.userId, userId),
          eq(savedLocations.isActive, true)
        )
      )
      .orderBy(desc(savedLocations.createdAt));
  }

  async deleteSavedLocation(id: string, userId: string): Promise<boolean> {
    const result = await db
      .update(savedLocations)
      .set({ isActive: false })
      .where(and(eq(savedLocations.id, id), eq(savedLocations.userId, userId)));

    return result.rowCount !== null && result.rowCount > 0;
  }
}

export const savedLocationRepository = new SavedLocationRepository();
