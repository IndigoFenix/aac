import type { Request, Response } from "express";
import { z } from "zod";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { deepAnalyses, students, users } from "@shared/schema";
import {
  createDeepAnalysis,
  getDeepAnalysis,
  listDeepAnalysesForStudent,
  deleteDeepAnalysis,
} from "../services/deepAnalysisService";
import { activityLogService } from "../services/activityLogService";
import { buildClinicianCtx } from "../services/sharing/clinicianCtx";
import { studentService } from "../services/studentService";

const createSchema = z.object({
  studentId: z.string().min(1),
  specialInstructions: z.string().max(5000).optional(),
});

export class DeepAnalysisController {
  /** POST /api/deep-analysis  — create and start a new analysis */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const body = createSchema.parse(req.body);
      const userId = req.user!.id;

      // Verify the user actually has access to the student before kicking
      // off a deep-analysis run; the run reads PHI across every institute
      // that has data on the student.
      const access = await studentService.verifyStudentAccess(body.studentId, userId);
      if (!access.hasAccess) {
        res.status(403).json({ error: "error:FORBIDDEN_STUDENT" });
        return;
      }

      // Capture the selected institute from the query so runDeepAnalysis can
      // rebuild a properly scoped visibility context (vs. reading every
      // institute's data on this student).
      const instituteId =
        typeof req.query.instituteId === "string" ? req.query.instituteId : undefined;

      const { id } = await createDeepAnalysis({
        studentId: body.studentId,
        createdByUserId: userId,
        specialInstructions: body.specialInstructions,
        instituteId,
      });

      res.status(201).json({ id });

      activityLogService.log({
        userId,
        eventType: "create",
        subjectType1: "deep_analysis",
        subjectId1: id,
        details: { studentId: body.studentId },
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  /** GET /api/deep-analysis/:id — current status + full record */
  async get(req: Request, res: Response): Promise<void> {
    try {
      // Two-step: resolve studentId from a no-ctx fetch so family-institute
      // escalation can fire on the second pass.
      const baseline = await getDeepAnalysis(req.params.id);
      if (!baseline) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      const userId = req.user!.id;
      const ctx = await buildClinicianCtx(req, baseline.studentId);
      // If the caller has no usable institute context, fall back to a direct
      // student-access check rather than serving the unfiltered baseline.
      // The previous behavior (`ctx ? get(id, ctx) : baseline`) returned the
      // analysis row to anyone who knew its id once they failed the ctx
      // build (e.g., by omitting ?instituteId).
      if (!ctx) {
        const access = await studentService.verifyStudentAccess(baseline.studentId, userId);
        if (!access.hasAccess) {
          res.status(403).json({ error: "Access denied" });
          return;
        }
        res.json(baseline);
        return;
      }
      const row = await getDeepAnalysis(req.params.id, ctx);
      if (!row) {
        res.status(403).json({ error: "Access denied" });
        return;
      }
      res.json(row);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** GET /api/deep-analysis?studentId=... — history for a student */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const studentId = String(req.query.studentId || "");
      if (!studentId) {
        res.status(400).json({ error: "studentId required" });
        return;
      }
      const ctx = await buildClinicianCtx(req, studentId);
      const rows = await listDeepAnalysesForStudent(studentId, ctx);
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** DELETE /api/deep-analysis/:id */
  async delete(req: Request, res: Response): Promise<void> {
    try {
      const ok = await deleteDeepAnalysis(req.params.id);
      if (!ok) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ success: true });

      activityLogService.log({
        userId: req.user!.id,
        eventType: "delete",
        subjectType1: "deep_analysis",
        subjectId1: req.params.id,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // ===== Admin endpoints =====

  /** GET /api/admin/deep-analyses — paginated list across all students with filters. */
  async adminList(req: Request, res: Response): Promise<void> {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 25, 1), 100);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

      const conds: any[] = [];
      if (req.query.studentId)  conds.push(eq(deepAnalyses.studentId, String(req.query.studentId)));
      if (req.query.status)     conds.push(eq(deepAnalyses.status, String(req.query.status)));
      if (req.query.createdBy)  conds.push(eq(deepAnalyses.createdByUserId, String(req.query.createdBy)));
      if (req.query.startDate) {
        const d = new Date(String(req.query.startDate));
        if (!Number.isNaN(d.getTime())) conds.push(gte(deepAnalyses.createdAt, d));
      }
      if (req.query.endDate) {
        const d = new Date(String(req.query.endDate));
        if (!Number.isNaN(d.getTime())) conds.push(lte(deepAnalyses.createdAt, d));
      }
      const where = conds.length > 0 ? and(...conds) : undefined;

      const rows = await db
        .select({
          id: deepAnalyses.id,
          studentId: deepAnalyses.studentId,
          studentFirstName: students.firstName,
          studentLastName: students.lastName,
          createdByUserId: deepAnalyses.createdByUserId,
          createdByEmail: users.email,
          model: deepAnalyses.model,
          status: deepAnalyses.status,
          title: deepAnalyses.title,
          summary: deepAnalyses.summary,
          stepCount: deepAnalyses.stepCount,
          resumeCount: deepAnalyses.resumeCount,
          inputTokens: deepAnalyses.inputTokens,
          outputTokens: deepAnalyses.outputTokens,
          thinkingTokens: deepAnalyses.thinkingTokens,
          costUsd: deepAnalyses.costUsd,
          createdAt: deepAnalyses.createdAt,
          completedAt: deepAnalyses.completedAt,
          lastActivityAt: deepAnalyses.lastActivityAt,
        })
        .from(deepAnalyses)
        .leftJoin(students, eq(deepAnalyses.studentId, students.id))
        .leftJoin(users, eq(deepAnalyses.createdByUserId, users.id))
        .where(where as any)
        .orderBy(desc(deepAnalyses.createdAt))
        .offset(offset)
        .limit(limit);

      const [{ total }] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(deepAnalyses)
        .where(where as any);

      res.json({
        success: true,
        data: rows,
        pagination: { total, limit, offset, hasMore: offset + limit < total },
      });
    } catch (error: any) {
      console.error("adminList deep analyses error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /** GET /api/admin/deep-analyses/:id — full detail including messages + scratch. */
  async adminGet(req: Request, res: Response): Promise<void> {
    try {
      const [row] = await db
        .select()
        .from(deepAnalyses)
        .where(eq(deepAnalyses.id, req.params.id))
        .limit(1);
      if (!row) { res.status(404).json({ error: "Not found" }); return; }
      res.json({ success: true, data: row });
      // A backoffice admin reading a student's full clinical analysis — the
      // reader owns nothing here, so every such read is audited.
      activityLogService.log({
        userId: req.user?.id ?? null,
        instituteId: (row as any).instituteId ?? null,
        eventType: "view",
        subjectType1: "deep_analysis",
        subjectId1: row.id,
        subjectType2: "student",
        subjectId2: row.studentId,
        details: { viaAdmin: true },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const deepAnalysisController = new DeepAnalysisController();
