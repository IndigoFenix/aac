// server/controllers/incidentController.ts
// REST endpoints for student incidents.

import type { Request, Response } from "express";
import { z } from "zod";
import { incidentRepository } from "../repositories";

const createIncidentSchema = z.object({
  type: z.enum(["medical", "functional"]),
  severity: z.enum(["low", "moderate", "high", "critical"]),
  recordedAt: z.string().transform((s) => new Date(s)),
  context: z.string().optional().nullable(),
  collectedBy: z.string().optional().nullable(),
});

const updateIncidentSchema = z.object({
  type: z.enum(["medical", "functional"]).optional(),
  severity: z.enum(["low", "moderate", "high", "critical"]).optional(),
  recordedAt: z
    .string()
    .transform((s) => new Date(s))
    .optional(),
  context: z.string().optional().nullable(),
  collectedBy: z.string().optional().nullable(),
});

class IncidentController {
  async list(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const { startDate, endDate, offset, limit } = req.query;
      const items = await incidentRepository.listByStudent(studentId, {
        startDate: typeof startDate === "string" ? new Date(startDate) : undefined,
        endDate: typeof endDate === "string" ? new Date(endDate) : undefined,
        offset: typeof offset === "string" ? Number(offset) : undefined,
        limit: typeof limit === "string" ? Number(limit) : undefined,
      });
      res.json({ success: true, incidents: items });
    } catch (error: any) {
      console.error("Error listing incidents:", error);
      res.status(500).json({ success: false, message: "Failed to list incidents" });
    }
  }

  async create(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const parsed = createIncidentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", errors: parsed.error.flatten() });
        return;
      }
      const created = await incidentRepository.create({
        studentId,
        type: parsed.data.type,
        severity: parsed.data.severity,
        recordedAt: parsed.data.recordedAt,
        context: parsed.data.context ?? null,
        collectedBy: parsed.data.collectedBy ?? null,
      });
      res.status(201).json({ success: true, incident: created });
    } catch (error: any) {
      console.error("Error creating incident:", error);
      res.status(500).json({ success: false, message: "Failed to create incident" });
    }
  }

  async update(req: Request, res: Response): Promise<void> {
    try {
      const parsed = updateIncidentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", errors: parsed.error.flatten() });
        return;
      }
      const updated = await incidentRepository.update(req.params.id, parsed.data as any);
      if (!updated) {
        res.status(404).json({ success: false, message: "Incident not found" });
        return;
      }
      res.json({ success: true, incident: updated });
    } catch (error: any) {
      console.error("Error updating incident:", error);
      res.status(500).json({ success: false, message: "Failed to update incident" });
    }
  }

  async delete(req: Request, res: Response): Promise<void> {
    try {
      const ok = await incidentRepository.delete(req.params.id);
      if (!ok) {
        res.status(404).json({ success: false, message: "Incident not found" });
        return;
      }
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting incident:", error);
      res.status(500).json({ success: false, message: "Failed to delete incident" });
    }
  }
}

export const incidentController = new IncidentController();
