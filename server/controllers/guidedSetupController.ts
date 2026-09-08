// server/controllers/guidedSetupController.ts
//
// REST surface for GUIDED SETUP (shared/guided-setup.ts GUIDED_SETUP_ROUTES).
// The rail uses these on load and for its buttons; the chat drives the same
// service through the `guidedSetup` host tool.
//
// Authentication is `requireAuth`, exactly like POST /api/students. Every
// method delegates access checks to the service, which verifies institute
// membership and student access before touching a row.

import type { Request, Response } from "express";
import { z } from "zod";

import {
  GUIDED_SETUP_ROSTER_MAX_ROWS,
  GUIDED_SETUP_SKIPPABLE_STEPS,
  type GuidedSetupSkippableStep,
} from "@shared/guided-setup";
import {
  GuidedSetupError,
  ackAac,
  adopt,
  confirmRosterBatch,
  dismiss,
  parked,
  requestConsentBatch,
  resolveView,
  skipStep,
  start,
} from "../services/guided-setup/student-setup-service.js";

const startSchema = z.object({
  instituteId: z.string().optional().nullable(),
  studentId: z.string().optional().nullable(),
  language: z.string().optional(),
});

const instituteBodySchema = z.object({
  instituteId: z.string().min(1),
  language: z.string().optional(),
});

const adoptSchema = instituteBodySchema.extend({
  source: z.enum(["chat", "roster", "form"]).optional(),
});

const skipSchema = instituteBodySchema.extend({
  // From the shared step order, so a new step is skippable through REST the
  // moment the flow grows one (zod needs a non-empty tuple, hence the cast).
  step: z
    .enum(GUIDED_SETUP_SKIPPABLE_STEPS as unknown as [string, ...string[]])
    .optional(),
});

/**
 * The confirm body. `rows` is passed through as `unknown` on purpose: the
 * SERVICE re-validates and re-normalises every cell with the same code that
 * built the proposal, so a second, softer schema here would only be a way for
 * the two to disagree. Everything the controller checks is the envelope.
 */
const rosterConfirmSchema = z.object({
  instituteId: z.string().min(1),
  proposalId: z.string().min(1).max(64),
  rows: z.array(z.unknown()).max(GUIDED_SETUP_ROSTER_MAX_ROWS),
  language: z.string().optional(),
});

const consentBatchSchema = z.object({
  instituteId: z.string().min(1),
  items: z
    .array(
      z.object({
        studentId: z.string().min(1),
        contactId: z.string().min(1),
        channel: z.enum(["email", "sms"]),
      }),
    )
    // Every item SENDS something. A cap keeps a scripted client from turning
    // one click into a thousand outbound messages.
    .max(GUIDED_SETUP_ROSTER_MAX_ROWS),
  language: z.string().optional(),
});

function fail(res: Response, error: unknown): void {
  if (error instanceof GuidedSetupError) {
    res.status(error.status).json({ success: false, code: error.code, message: error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ success: false, code: "BAD_REQUEST", message: "Invalid request body" });
    return;
  }
  console.error("[GuidedSetupController] Error:", error);
  res.status(500).json({ success: false, code: "GUIDED_SETUP_FAILED" });
}

export class GuidedSetupController {
  /** POST /api/guided-setup/start */
  async start(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const body = startSchema.parse(req.body ?? {});
      const result = await start({
        userId,
        instituteId: body.instituteId ?? null,
        studentId: body.studentId ?? null,
        lang: body.language,
      });
      res.json({ success: true, view: result.view, instituteCreated: result.instituteCreated });
    } catch (error) {
      fail(res, error);
    }
  }

  /** GET /api/guided-setup/students/:studentId?instituteId= */
  async getStudentView(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const instituteId = String(req.query.instituteId ?? "");
      if (!instituteId) {
        res.status(400).json({ success: false, code: "INSTITUTE_REQUIRED" });
        return;
      }
      const { view } = await resolveView({
        userId,
        instituteId,
        studentId: req.params.studentId,
        lang: typeof req.query.language === "string" ? req.query.language : undefined,
      });
      res.json({ success: true, view });
    } catch (error) {
      fail(res, error);
    }
  }

  /** GET /api/guided-setup?instituteId= */
  async getParked(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const instituteId = String(req.query.instituteId ?? "");
      if (!instituteId) {
        res.status(400).json({ success: false, code: "INSTITUTE_REQUIRED" });
        return;
      }
      const list = await parked({
        userId,
        instituteId,
        lang: typeof req.query.language === "string" ? req.query.language : undefined,
      });
      res.json({ success: true, parked: list });
    } catch (error) {
      fail(res, error);
    }
  }

  /** POST /api/guided-setup/students/:studentId/adopt */
  async adopt(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const body = adoptSchema.parse(req.body ?? {});
      const view = await adopt({
        userId,
        instituteId: body.instituteId,
        studentId: req.params.studentId,
        source: body.source,
        lang: body.language,
      });
      res.json({ success: true, view });
    } catch (error) {
      fail(res, error);
    }
  }

  /** POST /api/guided-setup/students/:studentId/skip */
  async skip(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const body = skipSchema.parse(req.body ?? {});
      const view = await skipStep({
        userId,
        instituteId: body.instituteId,
        studentId: req.params.studentId,
        step: body.step as GuidedSetupSkippableStep | undefined,
        lang: body.language,
      });
      res.json({ success: true, view });
    } catch (error) {
      fail(res, error);
    }
  }

  /** POST /api/guided-setup/students/:studentId/dismiss */
  async dismiss(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const body = instituteBodySchema.parse(req.body ?? {});
      const view = await dismiss({
        userId,
        instituteId: body.instituteId,
        studentId: req.params.studentId,
        lang: body.language,
      });
      res.json({ success: true, view });
    } catch (error) {
      fail(res, error);
    }
  }

  /** POST /api/guided-setup/students/:studentId/ack-aac */
  async ackAac(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const body = instituteBodySchema.parse(req.body ?? {});
      const view = await ackAac({
        userId,
        instituteId: body.instituteId,
        studentId: req.params.studentId,
        lang: body.language,
      });
      res.json({ success: true, view });
    } catch (error) {
      fail(res, error);
    }
  }

  /**
   * POST /api/guided-setup/roster/confirm
   *
   * The USER's click, never the AI's (plan §3.7 step 3). The rows carry the
   * user's edits from the review table and are re-validated from scratch.
   */
  async confirmRoster(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const body = rosterConfirmSchema.parse(req.body ?? {});
      const result = await confirmRosterBatch({
        userId,
        instituteId: body.instituteId,
        proposalId: body.proposalId,
        rows: body.rows,
        lang: body.language,
      });
      res.json({ success: true, ...result });
    } catch (error) {
      fail(res, error);
    }
  }

  /**
   * POST /api/guided-setup/consent/request-batch
   *
   * One click, one magic link per item. Nothing is sent on roster confirm
   * (plan decision 5) — an outward-facing send is always deliberate.
   */
  async requestConsentBatch(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const body = consentBatchSchema.parse(req.body ?? {});
      const result = await requestConsentBatch({
        userId,
        instituteId: body.instituteId,
        items: body.items,
        lang: body.language,
      });
      res.json({ success: true, ...result });
    } catch (error) {
      fail(res, error);
    }
  }
}

export const guidedSetupController = new GuidedSetupController();
