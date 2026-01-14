// server/repositories/personaRepository.ts
// Repository for persona management operations

import {
  personas,
  type Persona,
  type InsertPersona,
  type UpdatePersona,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc } from "drizzle-orm";

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
   * Get personas available for manual selection (active + manualSelection)
   */
  async getSelectablePersonas(): Promise<Persona[]> {
    return await db
      .select()
      .from(personas)
      .where(
        and(
          eq(personas.active, true),
          eq(personas.manualSelection, true)
        )
      )
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
