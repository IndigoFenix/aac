// Admin endpoints for data-subject ACCESS ("produce") and AMENDMENT
// ("correct") requests. AKIM appendix §18.3 / §18.4.
//
//   GET  /api/admin/data-subject-requests               — list, filterable
//   POST /api/admin/data-subject-requests               — open one (freezes the clock)
//   GET  /api/admin/data-subject-requests/:id           — read one
//   POST /api/admin/data-subject-requests/:id/forward   — record the forward
//   POST /api/admin/data-subject-requests/:id/decide    — answer an amendment
//   POST /api/admin/data-subject-requests/:id/fulfil    — produce: bundle + close
//   POST /api/admin/data-subject-requests/:id/withdraw  — requester dropped it
//   GET  /api/admin/students/:id/data-subject-export    — the bundle, directly
//
// All gated by requireSystemAdmin, matching the erasure controller: the same
// privilege that can delete a child's whole record is the one that can copy it
// out. An institute-scoped self-service surface is a later decision, not a
// smaller one.

import type { Request, Response } from "express";
import { z } from "zod";
import {
  dataSubjectRequestService,
  DataSubjectRequestNotFound,
  DataSubjectRequestConflict,
} from "../services/dataSubjectRequestService";
import { buildDataSubjectExport } from "../services/dataSubjectExportService";
import { classifyForward, requestReference } from "../services/data-subject-deadlines";
import type { DataSubjectRequest } from "@shared/schema";

const openBodySchema = z.object({
  studentId: z.string().uuid(),
  instituteId: z.string().uuid().nullish(),
  kind: z.enum(["produce", "correct"]),
  receivedAt: z.string().datetime().optional(),
  requesterDescription: z.string().max(2000).nullish(),
  targetTable: z.string().max(200).nullish(),
  targetRecordId: z.string().max(200).nullish(),
  targetField: z.string().max(200).nullish(),
  proposedValue: z.string().max(10_000).nullish(),
  currentValueSnapshot: z.string().max(10_000).nullish(),
  notes: z.string().max(10_000).nullish(),
});

const forwardBodySchema = z.object({
  forwardedAt: z.string().datetime().optional(),
  notes: z.string().max(10_000).nullish(),
});

const decideBodySchema = z.object({
  accepted: z.boolean(),
  decision: z.string().min(1).max(10_000),
  decisionReason: z.string().max(10_000).nullish(),
  statementOfDisagreement: z.string().max(10_000).nullish(),
});

const withdrawBodySchema = z.object({
  reason: z.string().max(2000).nullish(),
});

const listQuerySchema = z.object({
  status: z.enum(["open", "forwarded", "fulfilled", "denied", "withdrawn"]).optional(),
  studentId: z.string().uuid().optional(),
  instituteId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Decorate a row with the derived reference + live deadline state. */
function present(row: DataSubjectRequest, now = new Date()) {
  return {
    ...row,
    reference: requestReference(row.id),
    forwardState: classifyForward(row, now),
  };
}

function handleError(res: Response, err: any, fallback: string): void {
  if (err instanceof DataSubjectRequestNotFound) {
    res.status(404).json({ success: false, message: "Data-subject request not found" });
    return;
  }
  if (err instanceof DataSubjectRequestConflict) {
    res.status(409).json({ success: false, message: err.message });
    return;
  }
  console.error(`${fallback}:`, err);
  res.status(500).json({ success: false, message: fallback });
}

export class DataSubjectRequestController {
  async list(req: Request, res: Response): Promise<void> {
    try {
      const parsed = listQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid query", errors: parsed.error.errors });
        return;
      }
      const rows = await dataSubjectRequestService.list(parsed.data);
      const now = new Date();
      res.json({ success: true, requests: rows.map((r) => present(r, now)) });
    } catch (err: any) {
      handleError(res, err, "Failed to list data-subject requests");
    }
  }

  async get(req: Request, res: Response): Promise<void> {
    try {
      const row = await dataSubjectRequestService.getOrThrow(req.params.id);
      res.json({ success: true, request: present(row) });
    } catch (err: any) {
      handleError(res, err, "Failed to fetch data-subject request");
    }
  }

  async open(req: Request, res: Response): Promise<void> {
    try {
      const parsed = openBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid body", errors: parsed.error.errors });
        return;
      }
      const user = req.user as any;
      const { receivedAt, ...rest } = parsed.data;
      const row = await dataSubjectRequestService.open(
        { ...rest, receivedAt: receivedAt ? new Date(receivedAt) : undefined },
        user?.id ?? null,
      );
      res.status(201).json({ success: true, request: present(row) });
    } catch (err: any) {
      handleError(res, err, "Failed to open data-subject request");
    }
  }

  async forward(req: Request, res: Response): Promise<void> {
    try {
      const parsed = forwardBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid body", errors: parsed.error.errors });
        return;
      }
      const user = req.user as any;
      const row = await dataSubjectRequestService.markForwarded(req.params.id, user?.id ?? null, {
        forwardedAt: parsed.data.forwardedAt ? new Date(parsed.data.forwardedAt) : undefined,
        notes: parsed.data.notes ?? undefined,
      });
      res.json({ success: true, request: present(row) });
    } catch (err: any) {
      handleError(res, err, "Failed to record forwarding");
    }
  }

  async decide(req: Request, res: Response): Promise<void> {
    try {
      const parsed = decideBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid body", errors: parsed.error.errors });
        return;
      }
      const user = req.user as any;
      const row = await dataSubjectRequestService.decide(
        req.params.id,
        {
          accepted: parsed.data.accepted,
          decision: parsed.data.decision,
          decisionReason: parsed.data.decisionReason ?? null,
          statementOfDisagreement: parsed.data.statementOfDisagreement ?? null,
        },
        user?.id ?? null,
      );
      res.json({ success: true, request: present(row) });
    } catch (err: any) {
      handleError(res, err, "Failed to decide data-subject request");
    }
  }

  /**
   * Produce: build the bundle, log the disclosure, close the request.
   *
   * The `export` audit row is written BEFORE the response is sent and before
   * the request is marked fulfilled — if the bundle exists, the disclosure is
   * recorded, in that order. The reverse order would let a crash leave PHI
   * handed over with nothing in the log.
   */
  async fulfil(req: Request, res: Response): Promise<void> {
    try {
      const existing = await dataSubjectRequestService.getOrThrow(req.params.id);
      if (existing.kind !== "produce") {
        res.status(409).json({
          success: false,
          message: `${requestReference(existing.id)} is a "correct" request — answer it with /decide.`,
        });
        return;
      }
      const user = req.user as any;
      const bundle = await buildDataSubjectExport(existing.studentId);

      dataSubjectRequestService.logExport(existing.studentId, user?.id ?? null, {
        requestId: existing.id,
        reference: requestReference(existing.id),
        tables: Object.keys(bundle.tables).length,
        files: bundle.files.length,
      });

      const row = await dataSubjectRequestService.markFulfilled(existing.id, user?.id ?? null, {
        files: bundle.files.length,
      });

      res.json({ success: true, request: present(row), export: bundle });
    } catch (err: any) {
      handleError(res, err, "Failed to fulfil data-subject request");
    }
  }

  async withdraw(req: Request, res: Response): Promise<void> {
    try {
      const parsed = withdrawBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid body", errors: parsed.error.errors });
        return;
      }
      const user = req.user as any;
      const row = await dataSubjectRequestService.withdraw(
        req.params.id,
        user?.id ?? null,
        parsed.data.reason ?? null,
      );
      res.json({ success: true, request: present(row) });
    } catch (err: any) {
      handleError(res, err, "Failed to withdraw data-subject request");
    }
  }

  /**
   * The bundle on its own, with no request row behind it.
   *
   * Kept because the register must not be a precondition for answering: a
   * request that arrives by phone on a Friday gets its copy first and its row
   * afterwards. The disclosure is logged either way — that is the part that is
   * not optional.
   */
  async exportStudent(req: Request, res: Response): Promise<void> {
    try {
      const studentId = req.params.id;
      const user = req.user as any;
      const bundle = await buildDataSubjectExport(studentId);

      if (bundle.tables.students.length === 0) {
        res.status(404).json({ success: false, message: "Student not found" });
        return;
      }

      dataSubjectRequestService.logExport(studentId, user?.id ?? null, {
        tables: Object.keys(bundle.tables).length,
        files: bundle.files.length,
        direct: true,
      });

      res.json({ success: true, export: bundle });
    } catch (err: any) {
      handleError(res, err, "Failed to build data-subject export");
    }
  }
}

export const dataSubjectRequestController = new DataSubjectRequestController();
