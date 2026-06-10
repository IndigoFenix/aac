import type { Request, Response } from "express";
import { z } from "zod";
import { customAppRepository } from "../repositories";
import { activityLogService } from "../services/activityLogService";
import { validateCustomAppDefinitionForType } from "@shared/custom-app-validator";
import { buildClinicianCtx } from "../services/sharing/clinicianCtx";

const saveAppSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  imageUrl: z.string().optional(),
  language: z.string().optional(),
  instituteId: z.string().optional(),
  type: z.string().optional(), // defaults to "game"
  definition: z.unknown(),
  isGenerated: z.boolean().optional(),
});

const updateAppSchema = saveAppSchema.partial();

const assignSchema = z.object({
  studentId: z.string().min(1),
});

export class CustomAppController {
  /** POST /api/custom-apps */
  async saveApp(req: Request, res: Response): Promise<void> {
    try {
      const body = saveAppSchema.parse(req.body);

      const validation = validateCustomAppDefinitionForType(
        body.type ?? "game",
        body.definition,
      );
      if (!validation.ok) {
        res.status(400).json({ error: "INVALID_DEFINITION", details: validation.errors });
        return;
      }

      const app = await customAppRepository.createApp({
        userId: req.user!.id,
        name: body.name,
        description: body.description ?? null,
        imageUrl: body.imageUrl ?? null,
        language: body.language ?? "en",
        instituteId: body.instituteId ?? null,
        type: body.type ?? "game",
        definition: validation.data as object,
        isGenerated: body.isGenerated ?? false,
      });

      res.status(201).json(app);

      activityLogService.log({
        userId: req.user!.id,
        eventType: "create",
        subjectType1: "custom_app",
        subjectId1: app.id,
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  /** GET /api/custom-apps */
  async getUserApps(req: Request, res: Response): Promise<void> {
    try {
      const apps = await customAppRepository.getUserApps(req.user!.id);
      res.json(apps);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** GET /api/custom-apps/student/:studentId */
  async getStudentApps(req: Request, res: Response): Promise<void> {
    try {
      const apps = await customAppRepository.getStudentApps(req.user!.id, req.params.studentId);
      res.json(apps);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * GET /api/custom-apps/student/:studentId/available
   * Apps available to this student — i.e. from all institutes they are
   * enrolled in — plus the subset currently assigned. Used by the AAC
   * settings UI for the assignment toggles.
   */
  async getAvailableAppsForStudent(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const ctx = await buildClinicianCtx(req, studentId);
      const [apps, assignedIds] = await Promise.all([
        customAppRepository.getAvailableAppsForStudent(studentId),
        customAppRepository.getAssignedAppIds(studentId, ctx),
      ]);
      res.json({ apps, assignedIds });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** GET /api/custom-apps/:id */
  async getApp(req: Request, res: Response): Promise<void> {
    try {
      const app = await customAppRepository.getApp(req.params.id);
      if (!app || app.userId !== req.user!.id) {
        res.status(404).json({ error: "error:CUSTOM_APP_NOT_FOUND" });
        return;
      }
      void customAppRepository.touchLoaded(app.id);
      res.json(app);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** PATCH /api/custom-apps/:id */
  async updateApp(req: Request, res: Response): Promise<void> {
    try {
      const existing = await customAppRepository.getApp(req.params.id);
      if (!existing || existing.userId !== req.user!.id) {
        res.status(404).json({ error: "error:CUSTOM_APP_NOT_FOUND" });
        return;
      }

      const body = updateAppSchema.parse(req.body);

      let validatedDefinition: unknown = undefined;
      if (body.definition !== undefined) {
        const validation = validateCustomAppDefinitionForType(
          body.type ?? existing.type ?? "game",
          body.definition,
        );
        if (!validation.ok) {
          res.status(400).json({ error: "INVALID_DEFINITION", details: validation.errors });
          return;
        }
        validatedDefinition = validation.data;
      }

      const updated = await customAppRepository.updateApp(existing.id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.imageUrl !== undefined ? { imageUrl: body.imageUrl } : {}),
        ...(body.language !== undefined ? { language: body.language } : {}),
        ...(body.instituteId !== undefined ? { instituteId: body.instituteId } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(validatedDefinition !== undefined ? { definition: validatedDefinition } : {}),
        ...(body.isGenerated !== undefined ? { isGenerated: body.isGenerated } : {}),
      });

      res.json(updated);

      activityLogService.log({
        userId: req.user!.id,
        eventType: "update",
        subjectType1: "custom_app",
        subjectId1: existing.id,
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  /** DELETE /api/custom-apps/:id */
  async deleteApp(req: Request, res: Response): Promise<void> {
    try {
      const existing = await customAppRepository.getApp(req.params.id);
      if (!existing || existing.userId !== req.user!.id) {
        res.status(404).json({ error: "error:CUSTOM_APP_NOT_FOUND" });
        return;
      }
      await customAppRepository.deleteApp(existing.id);
      res.status(204).send();

      activityLogService.log({
        userId: req.user!.id,
        eventType: "delete",
        subjectType1: "custom_app",
        subjectId1: existing.id,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** POST /api/custom-apps/:id/assignments */
  async assignToStudent(req: Request, res: Response): Promise<void> {
    try {
      const existing = await customAppRepository.getApp(req.params.id);
      if (!existing || existing.userId !== req.user!.id) {
        res.status(404).json({ error: "error:CUSTOM_APP_NOT_FOUND" });
        return;
      }
      const { studentId } = assignSchema.parse(req.body);
      const assignment = await customAppRepository.assignToStudent({
        appId: existing.id,
        studentId,
        assignedByUserId: req.user!.id,
      });
      res.status(201).json(assignment);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  /** DELETE /api/custom-apps/:id/assignments/:studentId */
  async unassignFromStudent(req: Request, res: Response): Promise<void> {
    try {
      const existing = await customAppRepository.getApp(req.params.id);
      if (!existing || existing.userId !== req.user!.id) {
        res.status(404).json({ error: "error:CUSTOM_APP_NOT_FOUND" });
        return;
      }
      await customAppRepository.unassignFromStudent(existing.id, req.params.studentId);
      res.status(204).send();
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** GET /api/custom-apps/:id/assignments */
  async getAssignments(req: Request, res: Response): Promise<void> {
    try {
      const existing = await customAppRepository.getApp(req.params.id);
      if (!existing || existing.userId !== req.user!.id) {
        res.status(404).json({ error: "error:CUSTOM_APP_NOT_FOUND" });
        return;
      }
      const assignments = await customAppRepository.getAssignmentsForApp(existing.id);
      res.json(assignments);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}

export const customAppController = new CustomAppController();
