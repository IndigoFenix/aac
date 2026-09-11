// server/controllers/incidentController.ts
// REST endpoints for student incidents.
//
// Incidents are behavioural / medical events — PHI. Every verb verifies the
// caller's access to the STUDENT the incident belongs to (the broad policy in
// `server/services/access/`), not merely that a session exists. For update and
// delete the student is resolved from the incident row first, so an id alone is
// never sufficient — and an incident the caller may not touch answers with the
// same 404 as one that does not exist (clinical audit §2.9).

import type { Request, Response } from "express";
import { z } from "zod";
import { incidentRepository } from "../repositories";
import {
  hasStudentAccess,
  requireStudentAccess as requireStudentAccessPolicy,
  type StudentAccessDenialShape,
} from "../services/access";
import { visibilityCtx } from "../services/sharing/clinicianCtx";

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
 * The bodies THIS surface answers with. The rule itself — the broad student
 * policy — lives once, in `server/services/access/`. This file used to carry a
 * separately-written copy that was byte-equivalent to
 * `caretakerPinController`'s and differed only in these two objects.
 */
const INCIDENT_DENIAL: StudentAccessDenialShape = {
  unauthenticated: { success: false, message: "Authentication required" },
  forbidden: { success: false, message: "Not authorized to access this student's data" },
};

/** Body for "this incident id tells you nothing" — see `denyIncidentUnlessPermitted`. */
const INCIDENT_NOT_FOUND = { success: false, message: "Incident not found" };

/**
 * 401 / 403 as appropriate; returns the userId when the caller may act on the
 * student, or undefined after having written the error response. Used by the
 * STUDENT-scoped verbs, where `:studentId` is the path param and permission is
 * therefore resolved before any row is read (403-before-404).
 */
async function requireStudentAccess(req: Request, res: Response, studentId: string): Promise<string | undefined> {
  return requireStudentAccessPolicy(req, res, studentId, { shape: INCIDENT_DENIAL });
}

/**
 * ENUMERATION FIX (2026-09-10, clinical audit §2.9).
 *
 * `update` and `delete` are keyed on an INCIDENT id, and the student — the
 * thing permission is about — is only known once the row is read. So
 * 403-before-404 is not available here; the leak has to be closed from the
 * other side. It previously answered 404 for a missing incident and 403 for a
 * real one belonging to someone else, under a comment that claimed the
 * opposite ("Same 404 for missing and not-yours"), which made the endpoint an
 * oracle for incident ids. Both now answer the same 404.
 *
 * Returns true when the handler must stop, having written the response.
 */
async function denyIncidentUnlessPermitted(
  req: Request,
  res: Response,
  studentId: string,
): Promise<boolean> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json(INCIDENT_DENIAL.unauthenticated);
    return true;
  }
  if (!(await hasStudentAccess(studentId, userId))) {
    res.status(404).json(INCIDENT_NOT_FOUND);
    return true;
  }
  return false;
}

class IncidentController {
  async list(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      if (!(await requireStudentAccess(req, res, studentId))) return;

      const { startDate, endDate, offset, limit } = req.query;
      // Incidents are high-security medical information (user ruling,
      // 2026-09-10), so this uses `visibilityCtx` rather than the deprecated
      // `buildClinicianCtx` shim. The shim collapses "not a member of the
      // institute you named" and "no institute selected" into the same
      // `undefined`, which downstream code has read BOTH as "deny" and as "no
      // filter" — the fail-open the audit named as the recurring bug. Here a
      // caller asserting an institute they do not belong to is refused (403);
      // "none selected" still passes through as an unrefined view, governed by
      // the `requireStudentAccess` check above. Boards and apps stay on the
      // permissive shim deliberately — they are far less sensitive.
      const ctxResult = await visibilityCtx(req, res, studentId);
      if (!ctxResult.ok) return;
      const ctx = ctxResult.ctx;
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
        res.status(404).json(INCIDENT_NOT_FOUND);
        return;
      }
      if (await denyIncidentUnlessPermitted(req, res, existing.studentId)) return;

      const parsed = updateIncidentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", errors: parsed.error.flatten() });
        return;
      }
      const updated = await incidentRepository.update(req.params.id, parsed.data as any);
      if (!updated) {
        res.status(404).json(INCIDENT_NOT_FOUND);
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
      // Same 404 for missing and not-yours — see `denyIncidentUnlessPermitted`.
      if (!existing) {
        res.status(404).json(INCIDENT_NOT_FOUND);
        return;
      }
      if (await denyIncidentUnlessPermitted(req, res, existing.studentId)) return;

      const ok = await incidentRepository.delete(req.params.id);
      if (!ok) {
        res.status(404).json(INCIDENT_NOT_FOUND);
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
