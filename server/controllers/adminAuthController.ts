// server/controllers/adminAuthController.ts
//
// Admin-specific auth flows: forgot-password / reset-password / MFA recovery.
// These mirror the regular flows in `authController` but operate against the
// admin_users table (and the admin-specific token tables added in 0108).
// Kept separate so the admin paths can evolve independently of the regular
// user paths — the existing /auth/forgot-password and /auth/mfa/recovery/*
// endpoints stay unchanged and now ignore admin emails (silent success).

import type { Request, Response } from "express";
import { adminPasswordResetService } from "../services/adminPasswordResetService";
import { adminMfaRecoveryService } from "../services/adminMfaRecoveryService";
import { activityLogService } from "../services/activityLogService";
import { validatePassword } from "@shared/schema";

function authDetails(req: Request, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ip: req.ip,
    userAgent: req.get("user-agent") ?? null,
    ...extra,
  };
}

function getBaseUrl(req: Request): string {
  return process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
}

class AdminAuthController {
  // ==================== Password Reset ====================

  /**
   * POST /auth/admin/forgot-password
   */
  async forgotPassword(req: Request, res: Response): Promise<void> {
    try {
      const { email } = req.body;
      if (!email) {
        res.status(400).json({ success: false, message: "Email is required" });
        return;
      }

      const baseUrl = getBaseUrl(req);

      // Must await before responding (same Lambda freeze caveat as the regular
      // forgot-password handler — see authController.forgotPassword).
      const result = await adminPasswordResetService.requestPasswordReset(email, baseUrl);

      activityLogService.log({
        userId: null,
        eventType: "auth_password_reset_requested",
        subjectType1: "user",
        subjectId1: null,
        details: authDetails(req, {
          attemptedEmail: typeof email === "string" ? email : null,
          flow: "admin",
        }),
      });

      if (result.sendFailed) {
        res.status(502).json({
          success: false,
          message: "Could not send the reset email. Please try again later or contact support.",
          error: result.sendError,
        });
        return;
      }

      res.json({
        success: true,
        message: "If an admin account with this email exists, a reset link has been sent",
      });
    } catch (error: any) {
      console.error("Admin forgot password error:", error);
      res.json({
        success: true,
        message: "If an admin account with this email exists, a reset link has been sent",
      });
    }
  }

  /**
   * GET /auth/admin/reset-password/:token
   */
  async validateResetToken(req: Request, res: Response): Promise<void> {
    try {
      const { token } = req.params;
      if (!token) {
        res.status(400).json({ success: false, message: "Token is required" });
        return;
      }

      const result = await adminPasswordResetService.validateToken(token);
      if (!result.valid) {
        res.status(400).json({
          success: false,
          message: result.error || "Invalid or expired reset link",
        });
        return;
      }

      res.json({ success: true, email: result.email });
    } catch (error: any) {
      console.error("Admin validate reset token error:", error);
      res.status(500).json({ success: false, message: "Failed to validate reset link" });
    }
  }

  /**
   * POST /auth/admin/reset-password
   */
  async resetPassword(req: Request, res: Response): Promise<void> {
    try {
      const { token, newPassword } = req.body;
      if (!token || !newPassword) {
        res.status(400).json({
          success: false,
          message: "Token and new password are required",
        });
        return;
      }

      const passwordValidation = validatePassword(newPassword);
      if (!passwordValidation.valid) {
        res.status(400).json({
          success: false,
          message: passwordValidation.errors[0],
          errors: passwordValidation.errors,
        });
        return;
      }

      const result = await adminPasswordResetService.resetPassword(token, newPassword);

      if (result.success) {
        if (result.adminId) {
          activityLogService.log({
            userId: result.adminId,
            eventType: "auth_password_reset_completed",
            subjectType1: "user",
            subjectId1: result.adminId,
            details: authDetails(req, { flow: "admin" }),
          });
        }
        res.json({
          success: true,
          message: "Password reset successful. You can now log in with your new password.",
        });
        return;
      }

      res.status(400).json({
        success: false,
        message: result.error || "Password reset failed",
      });
    } catch (error: any) {
      console.error("Admin reset password error:", error);
      res.status(500).json({ success: false, message: "Password reset failed" });
    }
  }

  // ==================== MFA Recovery ====================

  /**
   * POST /auth/admin/mfa/recovery/request
   */
  async mfaRecoveryRequest(req: Request, res: Response): Promise<void> {
    try {
      const { email } = req.body;
      if (!email) {
        res.status(400).json({ success: false, message: "Email is required" });
        return;
      }

      const baseUrl = getBaseUrl(req);
      const result = await adminMfaRecoveryService.requestRecovery(email, baseUrl);

      if (result.sendFailed) {
        res.status(502).json({
          success: false,
          message: "Could not send the recovery email. Please try again later or contact support.",
          error: result.sendError,
        });
        return;
      }

      res.json({
        success: true,
        message: "If an admin account with MFA exists, a recovery link has been sent",
      });
    } catch (error: any) {
      console.error("Admin MFA recovery request error:", error);
      res.json({
        success: true,
        message: "If an admin account with MFA exists, a recovery link has been sent",
      });
    }
  }

  /**
   * GET /auth/admin/mfa/recovery/:token
   */
  async mfaRecoveryValidate(req: Request, res: Response): Promise<void> {
    try {
      const { token } = req.params;
      if (!token) {
        res.status(400).json({ success: false, message: "Token is required" });
        return;
      }

      const result = await adminMfaRecoveryService.validateToken(token);
      if (!result.valid) {
        res.status(400).json({
          success: false,
          message: result.error || "Invalid or expired recovery link",
        });
        return;
      }

      res.json({ success: true, email: result.email });
    } catch (error: any) {
      console.error("Admin MFA recovery validate error:", error);
      res.status(500).json({ success: false, message: "Failed to validate recovery link" });
    }
  }

  /**
   * POST /auth/admin/mfa/recovery/complete
   */
  async mfaRecoveryComplete(req: Request, res: Response): Promise<void> {
    try {
      const { token } = req.body;
      if (!token) {
        res.status(400).json({ success: false, message: "Token is required" });
        return;
      }

      const result = await adminMfaRecoveryService.completeRecovery(token);
      if (result.success) {
        res.json({
          success: true,
          message: "MFA has been disabled. You can now log in with your password.",
        });
        return;
      }

      res.status(400).json({
        success: false,
        message: result.error || "Failed to complete recovery",
      });
    } catch (error: any) {
      console.error("Admin MFA recovery complete error:", error);
      res.status(500).json({ success: false, message: "Failed to complete recovery" });
    }
  }
}

export const adminAuthController = new AdminAuthController();
