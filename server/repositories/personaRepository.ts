// server/repositories/personaRepository.ts
// Repository for persona management operations

import {
  personas,
  type Persona,
  type InsertPersona,
  type UpdatePersona,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, or, isNull, inArray, desc, SQL } from "drizzle-orm";

export class PersonaRepository {
  /**
   * Create a new persona
   */
  async createPersona(insert: InsertPersona): Promise<Persona> {
    const [persona] = await db
      .insert(personas)
      .values(insert)
      .returning();
    return persona;
  }

  /**
   * Get a persona by ID
   */
  async getPersonaById(id: string): Promise<Persona | undefined> {
    const [persona] = await db
      .select()
      .from(personas)
      .where(eq(personas.id, id));
    return persona || undefined;
  }

  /**
   * Get all personas
   */
  async getAllPersonas(): Promise<Persona[]> {
    return await db
      .select()
      .from(personas)
      .orderBy(desc(personas.createdAt));
  }

  /**
   * Get all active personas
   */
  async getActivePersonas(): Promise<Persona[]> {
    return await db
      .select()
      .from(personas)
      .where(eq(personas.active, true))
      .orderBy(desc(personas.createdAt));
  }

  /**
   * Get personas available for manual selection, filtered by user access.
   * System admins see all active+selectable personas.
   * Regular users don't see testMode personas, and only see personas
   * with no instituteId or matching their institute memberships.
   */
  async getSelectablePersonas(options?: {
    userInstituteIds?: string[];
    isSystemAdmin?: boolean;
  }): Promise<Persona[]> {
    const conditions: SQL[] = [
      eq(personas.active, true),
      eq(personas.manualSelection, true),
    ];

    if (!options?.isSystemAdmin) {
      // Exclude test-mode personas for non-admins
      conditions.push(eq(personas.testMode, false));

      // Institute filter: show global (null) + user's institute personas
      const instituteIds = options?.userInstituteIds ?? [];
      if (instituteIds.length > 0) {
        conditions.push(
          or(
            isNull(personas.instituteId),
            inArray(personas.instituteId, instituteIds),
          )!
        );
      } else {
        // User has no institutes — only show global personas
        conditions.push(isNull(personas.instituteId));
      }
    }

    return await db
      .select()
      .from(personas)
      .where(and(...conditions))
      .orderBy(personas.title);
  }

  /**
   * Update a persona
   */
  async updatePersona(
    id: string,
    updates: UpdatePersona
  ): Promise<Persona | undefined> {
    const [updated] = await db
      .update(personas)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(personas.id, id))
      .returning();
    return updated || undefined;
  }

  /**
   * Delete a persona (hard delete)
   */
  async deletePersona(id: string): Promise<boolean> {
    const result = await db
      .delete(personas)
      .where(eq(personas.id, id))
      .returning();
    return result.length > 0;
  }
}

export const personaRepository = new PersonaRepository();
