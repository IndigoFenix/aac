// server/controllers/shareInviteController.ts
//
// HTTP surface for the cross-institute sharing flow. The state-machine and
// permission checks live in `studentShareInviteService` — this layer parses,
// dispatches, and maps `ShareInviteError` → HTTP status codes.
//
// See planning-docs/cross-institute-sharing-plan.md.

import type { Request, Response } from "express";
import { z } from "zod";
import {
  studentShareInviteService,
  ShareInviteError,
  type ShareInviteErrorCode,
} from "../services/sharing/studentShareInviteService";
import {
  shareableObjectTypeEnum,
  sharePermissionEnum,
} from "@shared/schema";

// ============================================================================
// Zod
// ============================================================================

const shareableObjectType = z.enum(shareableObjectTypeEnum.enumValues);
const sharePermission = z.enum(sharePermissionEnum.enumValues);

const bundleSchema = z.object({
  objects: z
    .array(
      z.object({
        type: shareableObjectType,
        id: z.string().min(1),
        // Caller can hint isSensitive=true for types lacking a DB column
        // (e.g., custom_app_assignment); the service overrides with the live
        // DB value when one exists.
        isSensitive: z.boolean().default(false),
      }),
    )
    .default([]),
  standingTypes: z.array(shareableObjectType).default([]),
  permission: sharePermission.default("read"),
  shareExpiresAt: z.string().datetime().nullable().default(null),
  standingExpiresAt: z.string().datetime().nullable().default(null),
  sensitiveAcknowledged: z.boolean().default(false),
});

const createInviteSchema = z.object({
  studentId: z.string().min(1),
  sourceInstituteId: z.string().min(1).nullable(),
  guardianUserId: z.string().min(1),
  bundle: bundleSchema,
  message: z.string().max(2000).nullable().optional(),
  codeTtlHours: z.number().int().positive().max(24 * 14).optional(),
  shareExpiresAt: z.string().datetime().nullable().optional(),
});

const redeemSchema = z.object({
  code: z.string().min(8).max(64),
  targetInstituteId: z.string().min(1),
});

const bulkRevokeSchema = z.object({
  studentId: z.string().min(1),
  targetInstituteId: z.string().min(1),
});

// ============================================================================
// Error → HTTP mapping
// ============================================================================

const errorStatus: Record<ShareInviteErrorCode, number> = {
  not_found: 404,
  invalid_state: 409,
  permission_denied: 403,
  code_expired: 410,
  share_expired: 410,
  validation: 400,
  sensitive_unacknowledged: 422,
  consent_required: 412,
};

function handleError(res: Response, err: unknown): void {
  if (err instanceof ShareInviteError) {
    res.status(errorStatus[err.code]).json({
      success: false,
      code: err.code,
      message: err.message,
      details: err.details,
    });
    return;
  }
  console.error("[ShareInviteController]", err);
  res.status(500).json({ success: false, message: "Internal server error" });
}

// ============================================================================
// Controller
// ============================================================================

export class ShareInviteController {
  // ──────────────── Source side ────────────────

  /** POST /api/shares/invites — source admin (or guardian, for student-owned) creates */
  async createInvite(req: Request, res: Response): Promise<void> {
    try {
      const parsed = createInviteSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: "Invalid input",
          errors: parsed.error.flatten(),
        });
        return;
      }
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Not authenticated" });
        return;
      }

      const { invite, code } = await studentShareInviteService.createInvite({
        studentId: parsed.data.studentId,
        sourceInstituteId: parsed.data.sourceInstituteId,
        createdByUserId: userId,
        guardianUserId: parsed.data.guardianUserId,
        bundle: parsed.data.bundle,
        message: parsed.data.message ?? null,
        codeTtlHours: parsed.data.codeTtlHours,
        shareExpiresAt: parsed.data.shareExpiresAt
          ? new Date(parsed.data.shareExpiresAt)
          : null,
      });

      // The plaintext code is shown ONCE to the source admin — it's not
      // recoverable from the DB (only the hash is stored).
      res.status(201).json({ success: true, invite, code });
    } catch (err) {
      handleError(res, err);
    }
  }

  /** GET /api/shares/invites?role=source|target&instituteId=... */
  async listInvites(req: Request, res: Response): Promise<void> {
    try {
      const role = String(req.query.role ?? "");
      const instituteId = String(req.query.instituteId ?? "");
      if (!instituteId) {
        res.status(400).json({ success: false, message: "instituteId required" });
        return;
      }
      const invites =
        role === "target"
          ? await studentShareInviteService.listForTargetInstitute(instituteId)
          : await studentShareInviteService.listForSourceInstitute(instituteId);
      res.json({ success: true, invites });
    } catch (err) {
      handleError(res, err);
    }
  }

  /** GET /api/shares/invites/:id */
  async getInvite(req: Request, res: Response): Promise<void> {
    try {
      const invite = await studentShareInviteService.getInvite(req.params.id);
      if (!invite) {
        res.status(404).json({ success: false, message: "Invite not found" });
        return;
      }
      res.json({ success: true, invite });
    } catch (err) {
      handleError(res, err);
    }
  }

  // ──────────────── Guardian side ────────────────

  /** GET /api/shares/invites/inbox — invites awaiting the current user as guardian */
  async listGuardianInbox(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Not authenticated" });
        return;
      }
      const invites = await studentShareInviteService.listPendingForGuardian(userId);
      res.json({ success: true, invites });
    } catch (err) {
      handleError(res, err);
    }
  }

  /** POST /api/shares/invites/:id/approve */
  async approveInvite(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Not authenticated" });
        return;
      }
      const invite = await studentShareInviteService.approveByGuardian(
        req.params.id,
        userId,
      );
      res.json({ success: true, invite });
    } catch (err) {
      handleError(res, err);
    }
  }

  /** POST /api/shares/invites/:id/decline?by=guardian|target */
  async declineInvite(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Not authenticated" });
        return;
      }
      const by = req.query.by === "target" ? "target" : "guardian";
      const invite = await studentShareInviteService.decline(
        req.params.id,
        userId,
        by,
      );
      res.json({ success: true, invite });
    } catch (err) {
      handleError(res, err);
    }
  }

  // ──────────────── Target side ────────────────

  /** POST /api/shares/redeem  body: { code, targetInstituteId } */
  async redeem(req: Request, res: Response): Promise<void> {
    try {
      const parsed = redeemSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: "Invalid input",
          errors: parsed.error.flatten(),
        });
        return;
      }
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Not authenticated" });
        return;
      }
      const invite = await studentShareInviteService.redeem(
        parsed.data.code,
        userId,
        parsed.data.targetInstituteId,
      );
      res.json({ success: true, invite });
    } catch (err) {
      handleError(res, err);
    }
  }

  /** POST /api/shares/invites/:id/accept */
  async acceptInvite(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Not authenticated" });
        return;
      }
      const result = await studentShareInviteService.accept(req.params.id, userId);
      res.json({
        success: true,
        invite: result.invite,
        objectShares: result.objectShares,
        standingShares: result.standingShares,
      });
    } catch (err) {
      handleError(res, err);
    }
  }

  // ──────────────── Revocation ────────────────

  /** POST /api/shares/invites/:id/revoke */
  async revokeInvite(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Not authenticated" });
        return;
      }
      const invite = await studentShareInviteService.revokeInvite(
        req.params.id,
        userId,
      );
      res.json({ success: true, invite });
    } catch (err) {
      handleError(res, err);
    }
  }

  /** POST /api/shares/object-shares/:id/revoke */
  async revokeObjectShare(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Not authenticated" });
        return;
      }
      const share = await studentShareInviteService.revokeObjectShare(
        req.params.id,
        userId,
      );
      res.json({ success: true, share });
    } catch (err) {
      handleError(res, err);
    }
  }

  /** POST /api/shares/standing-shares/:id/revoke */
  async revokeStandingShare(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Not authenticated" });
        return;
      }
      const share = await studentShareInviteService.revokeStandingShare(
        req.params.id,
        userId,
      );
      res.json({ success: true, share });
    } catch (err) {
      handleError(res, err);
    }
  }

  /** GET /api/shares/active?role=source|target&instituteId=... — materialized shares for an institute */
  async listActiveShares(req: Request, res: Response): Promise<void> {
    try {
      const role = String(req.query.role ?? "");
      const instituteId = String(req.query.instituteId ?? "");
      if (!instituteId) {
        res.status(400).json({ success: false, message: "instituteId required" });
        return;
      }
      const result = await studentShareInviteService.listActiveSharesForInstitute(
        instituteId,
        role === "target" ? "target" : "source",
      );
      res.json({ success: true, ...result });
    } catch (err) {
      handleError(res, err);
    }
  }

  /** GET /api/shares/standing-shares/inbox — guardian's standing shares (active + history) */
  async listGuardianStandingShares(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Not authenticated" });
        return;
      }
      const shares = await studentShareInviteService.listStandingSharesForGuardian(userId);
      res.json({ success: true, shares });
    } catch (err) {
      handleError(res, err);
    }
  }

  /** POST /api/shares/bulk-revoke — guardian revokes all active shares to a recipient institute for a student */
  async bulkRevoke(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Not authenticated" });
        return;
      }
      const parsed = bulkRevokeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: parsed.error.message });
        return;
      }
      const result = await studentShareInviteService.bulkRevokeForGuardianAtInstitute(
        userId,
        parsed.data.studentId,
        parsed.data.targetInstituteId,
      );
      res.json({ success: true, ...result });
    } catch (err) {
      handleError(res, err);
    }
  }

  /** POST /api/shares/standing-shares/:id/renew — guardian extends shareExpiresAt by 1 year */
  async renewStandingShare(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Not authenticated" });
        return;
      }
      const share = await studentShareInviteService.renewStandingShare(
        req.params.id,
        userId,
      );
      res.json({ success: true, share });
    } catch (err) {
      handleError(res, err);
    }
  }
}

export const shareInviteController = new ShareInviteController();
