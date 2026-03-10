// server/services/personaService.ts
// Business logic for persona management

import { personaRepository } from "../repositories/personaRepository";
import { instituteRepository } from "../repositories/instituteRepository";
import {
  type Persona,
  type InsertPersona,
  type UpdatePersona,
} from "@shared/schema";

export class PersonaService {
  /**
   * Create a new persona
   */
  async createPersona(
    data: InsertPersona
  ): Promise<{ success: boolean; persona?: Persona; error?: string }> {
    try {
      const persona = await personaRepository.createPersona(data);
      return { success: true, persona };
    } catch (error: any) {
      console.error("Error creating persona:", error);
      return { success: false, error: "Failed to create persona" };
    }
  }

  /**
   * Get a persona by ID
   */
  async getPersonaById(
    id: string
  ): Promise<{ success: boolean; persona?: Persona; error?: string }> {
    const persona = await personaRepository.getPersonaById(id);
    if (!persona) {
      return { success: false, error: "Persona not found" };
    }
    return { success: true, persona };
  }

  /**
   * Get all personas (for admin view)
   */
  async getAllPersonas(): Promise<{ success: boolean; personas?: Persona[]; error?: string }> {
    try {
      const personas = await personaRepository.getAllPersonas();
      return { success: true, personas };
    } catch (error: any) {
      console.error("Error getting personas:", error);
      return { success: false, error: "Failed to get personas" };
    }
  }

  /**
   * Get active personas
   */
  async getActivePersonas(): Promise<{ success: boolean; personas?: Persona[]; error?: string }> {
    try {
      const personas = await personaRepository.getActivePersonas();
      return { success: true, personas };
    } catch (error: any) {
      console.error("Error getting active personas:", error);
      return { success: false, error: "Failed to get active personas" };
    }
  }

  /**
   * Get selectable personas for chat, filtered by user access.
   */
  async getSelectablePersonas(
    userId?: string,
    isSystemAdmin?: boolean,
  ): Promise<{ success: boolean; personas?: Persona[]; error?: string }> {
    try {
      let userInstituteIds: string[] | undefined;
      if (userId && !isSystemAdmin) {
        userInstituteIds = await instituteRepository.getInstituteIdsByUserId(userId);
      }

      const personas = await personaRepository.getSelectablePersonas({
        userInstituteIds,
        isSystemAdmin,
      });
      return { success: true, personas };
    } catch (error: any) {
      console.error("Error getting selectable personas:", error);
      return { success: false, error: "Failed to get selectable personas" };
    }
  }

  /**
   * Update a persona
   */
  async updatePersona(
    id: string,
    updates: UpdatePersona
  ): Promise<{ success: boolean; persona?: Persona; error?: string }> {
    // Verify persona exists
    const existing = await personaRepository.getPersonaById(id);
    if (!existing) {
      return { success: false, error: "Persona not found" };
    }

    try {
      const persona = await personaRepository.updatePersona(id, updates);
      return { success: true, persona };
    } catch (error: any) {
      console.error("Error updating persona:", error);
      return { success: false, error: "Failed to update persona" };
    }
  }

  /**
   * Delete a persona (hard delete)
   */
  async deletePersona(
    id: string
  ): Promise<{ success: boolean; error?: string }> {
    // Verify persona exists
    const existing = await personaRepository.getPersonaById(id);
    if (!existing) {
      return { success: false, error: "Persona not found" };
    }

    try {
      const deleted = await personaRepository.deletePersona(id);
      return { success: deleted, error: deleted ? undefined : "Failed to delete persona" };
    } catch (error: any) {
      console.error("Error deleting persona:", error);
      return { success: false, error: "Failed to delete persona" };
    }
  }
}

export const personaService = new PersonaService();
