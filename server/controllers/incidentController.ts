// server/controllers/incidentController.ts
// REST endpoints for student incidents.
//
// Incidents are behavioural / medical events — PHI. Every verb verifies the
// caller's access to the STUDENT the incident belongs to (`verifyStudentAccess`),
// not merely that a session exists. For update/delete the student is resolved
// from the incident row first, so an id alone is never sufficient.

import type { Request, Response } from "express";
import { z } from "zod";
import { incidentRepository } from "../repositories";
import { studentService } from "../services";
import { buildClinicianCtx } from "../services/sharing/clinicianCtx";

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

/**
 * 401 / 403 as appropriate; returns the userId when the caller may act on the
 * student, or undefined after having written the error response.
 */
async function requireStudentAccess(req: Request, res: Response, studentId: string): Promise<string | undefined> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, message: "Authentication required" });
    return undefined;
  }
  const { hasAccess } = await studentService.verifyStudentAccess(studentId, userId);
  if (!hasAccess) {
    res.status(403).json({ success: false, message: "Not authorized to access this student's data" });
    return undefined;
  }
  return userId;
}

class IncidentController {
  async list(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      if (!(await requireStudentAccess(req, res, studentId))) return;

      const { startDate, endDate, offset, limit } = req.query;
      const ctx = await buildClinicianCtx(req, studentId);
      const items = await incidentRepository.listByStudent(
        studentId,
        {
          startDate: typeof startDate === "string" ? new Date(startDate) : undefined,
          endDate: typeof endDate === "string" ? new Date(endDate) : undefined,
          offset: typeof offset === "string" ? Number(offset) : undefined,
          limit: typeof limit === "string" ? Number(limit) : undefined,
        },
        ctx,
      );
      res.json({ success: true, incidents: items });
    } catch (error: any) {
      console.error("Error listing incidents:", error);
      res.status(500).json({ success: false, message: "Failed to list incidents" });
    }
  }

  async create(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      if (!(await requireStudentAccess(req, res, studentId))) return;

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
      const existing = await incidentRepository.getById(req.params.id);
      // Same 404 for missing and not-yours: don't confirm the id exists.
      if (!existing) {
        res.status(404).json({ success: false, message: "Incident not found" });
        return;
      }
      if (!(await requireStudentAccess(req, res, existing.studentId))) return;

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
      const existing = await incidentRepository.getById(req.params.id);
      if (!existing) {
        res.status(404).json({ success: false, message: "Incident not found" });
        return;
      }
      if (!(await requireStudentAccess(req, res, existing.studentId))) return;

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
