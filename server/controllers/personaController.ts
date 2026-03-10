// server/controllers/personaController.ts
// HTTP handlers for persona management

import type { Request, Response } from "express";
import { personaService } from "../services/personaService";
import { insertPersonaSchema, updatePersonaSchema } from "@shared/schema";

export class PersonaController {
  /**
   * GET /api/admin/personas
   * Get all personas (admin only)
   */
  async getPersonas(req: Request, res: Response): Promise<void> {
    try {
      const result = await personaService.getAllPersonas();

      if (!result.success) {
        res.status(500).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        personas: result.personas,
      });
    } catch (error: any) {
      console.error("Error fetching personas:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch personas",
      });
    }
  }

  /**
   * GET /api/personas/selectable
   * Get personas available for manual selection (any authenticated user)
   * Filters by institute access and test mode based on user role.
   */
  async getSelectablePersonas(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const result = await personaService.getSelectablePersonas(
        user?.id,
        user?.isSystemAdmin,
      );

      if (!result.success) {
        res.status(500).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        personas: result.personas,
      });
    } catch (error: any) {
      console.error("Error fetching selectable personas:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch selectable personas",
      });
    }
  }

  /**
   * GET /api/admin/personas/:id
   * Get a specific persona (admin only)
   */
  async getPersona(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await personaService.getPersonaById(id);

      if (!result.success) {
        res.status(404).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        persona: result.persona,
      });
    } catch (error: any) {
      console.error("Error fetching persona:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch persona",
      });
    }
  }

  /**
   * POST /api/admin/personas
   * Create a new persona (admin only)
   */
  async createPersona(req: Request, res: Response): Promise<void> {
    try {
      // Validate input
      const parseResult = insertPersonaSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          message: "Invalid persona data",
          errors: parseResult.error.errors,
        });
        return;
      }

      const result = await personaService.createPersona(parseResult.data);

      if (!result.success) {
        res.status(400).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "Persona created successfully",
        persona: result.persona,
      });
    } catch (error: any) {
      console.error("Error creating persona:", error);
      res.status(500).json({
        success: false,
        message: "Failed to create persona",
      });
    }
  }

  /**
   * PATCH /api/admin/personas/:id
   * Update a persona (admin only)
   */
  async updatePersona(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Validate input
      const parseResult = updatePersonaSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          message: "Invalid persona data",
          errors: parseResult.error.errors,
        });
        return;
      }

      const result = await personaService.updatePersona(id, parseResult.data);

      if (!result.success) {
        res.status(result.error === "Persona not found" ? 404 : 400).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "Persona updated successfully",
        persona: result.persona,
      });
    } catch (error: any) {
      console.error("Error updating persona:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update persona",
      });
    }
  }

  /**
   * DELETE /api/admin/personas/:id
   * Delete a persona (admin only)
   */
  async deletePersona(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await personaService.deletePersona(id);

      if (!result.success) {
        res.status(result.error === "Persona not found" ? 404 : 400).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "Persona deleted successfully",
      });
    } catch (error: any) {
      console.error("Error deleting persona:", error);
      res.status(500).json({
        success: false,
        message: "Failed to delete persona",
      });
    }
  }
}

export const personaController = new PersonaController();
