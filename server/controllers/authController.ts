// server/controllers/authController.ts
// Complete auth controller with password reset and MFA functionality

import type { Request, Response, NextFunction } from "express";
import passport from "passport";
import { userService, passwordResetService } from "../services";
import { mfaService } from "../services/mfaService";
import { activityLogService } from "../services/activityLogService";
import { registerSchema, loginSchema, validatePassword } from "@shared/schema";
import { isCustomerSupport, type SupportSession } from "../services/customerSupportService";
import { instituteRepository } from "../repositories/instituteRepository";
import { licenseRepository } from "../repositories/licenseRepository";

/**
 * Build the `details` payload for an auth audit event. Captures IP and
 * user-agent for forensics. Email goes in for failure cases (where the
 * userId is null) so we can track credential-stuffing patterns.
 */
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

// Store pending MFA setup secrets temporarily (in production, use Redis)
const pendingMfaSetups = new Map<string, { secret: string; expiresAt: number }>();

// Cleanup expired pending setups periodically
setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of pendingMfaSetups.entries()) {
    if (now > data.expiresAt) {
      pendingMfaSetups.delete(userId);
    }
  }
}, 60000); // Every minute

export class AuthController {
  async register(req: Request, res: Response): Promise<void> {
    try {
      const userData = registerSchema.parse(req.body);
      const { referralCode } = req.body;

      const { user, referralApplied } = await userService.registerUser(
        userData,
        referralCode
      );

      req.login(user, (err) => {
        if (err) {
          res.status(500).json({
            success: false,
            message: "Account created but login failed",
          });
          return;
        }

        res.json({
          success: true,
          message: "Account created successfully",
          user: userService.formatUserForResponse(user),
        });
      });
    } catch (error: any) {
      console.error("Registration error:", error);
      res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : "Registration failed",
      });
    }
  }

  login(req: Request, res: Response, next: NextFunction): void {
    passport.authenticate("local", (err: any, user: any, info: any) => {
      if (err) {
        console.error("Login error:", err);
        return res.status(500).json({
          success: false,
          message: "Login failed",
        });
      }

      if (!user) {
        activityLogService.log({
          userId: null,
          eventType: "auth_login_failure",
          subjectType1: "user",
          subjectId1: null,
          details: authDetails(req, {
            attemptedEmail: typeof req.body?.email === "string" ? req.body.email : null,
            reason: info?.message ?? "invalid_credentials",
          }),
        });
        return res.status(401).json({
          success: false,
          message: info?.message || "Invalid login credentials",
        });
      }

      // Check if MFA is enabled
      if (user.mfaEnabled) {
        // Generate MFA challenge token (don't create session yet)
        const mfaToken = mfaService.generateMfaToken(user.id, "mfa_challenge");
        activityLogService.log({
          userId: user.id,
          eventType: "auth_mfa_challenge",
          subjectType1: "user",
          subjectId1: user.id,
          details: authDetails(req),
        });
        return res.json({
          success: true,
          mfaRequired: true,
          mfaToken,
          message: "MFA verification required",
        });
      }

      // Check if MFA is enforced but not set up. System admins always require MFA.
      if ((user.mfaEnforcedByAdmin || user.isSystemAdmin) && !user.mfaEnabled) {
        const mfaToken = mfaService.generateMfaToken(user.id, "mfa_setup");
        return res.json({
          success: true,
          mfaSetupRequired: true,
          mfaToken,
          message: user.isSystemAdmin
            ? "MFA setup required for system administrators"
            : "MFA setup required by administrator",
        });
      }

      // No MFA required, complete login
      req.login(user, (err) => {
        if (err) {
          return res.status(500).json({
            success: false,
            message: "Login failed",
          });
        }

        const { rememberMe, aacClient } = req.body;
        if (!aacClient) {
          req.session.cookie.maxAge = rememberMe
            ? 30 * 24 * 60 * 60 * 1000 // 30 days
            : 24 * 60 * 60 * 1000;      // 1 day
        }
        // aacClient: no maxAge → session cookie, no timeout

        activityLogService.log({
          userId: user.id,
          eventType: "auth_login_success",
          subjectType1: "user",
          subjectId1: user.id,
          details: authDetails(req, { rememberMe: !!rememberMe, aacClient: !!aacClient }),
        });

        res.json({
          success: true,
          message: "Login successful",
          user: userService.formatUserForResponse(user),
        });
      });
    })(req, res, next);
  }

  logout(req: Request, res: Response): void {
    const userId = (req.user as any)?.id ?? null;
    req.logout((err) => {
      if (err) {
        res.status(500).json({
          success: false,
          message: "Logout failed",
        });
        return;
      }
      if (userId) {
        activityLogService.log({
          userId,
          eventType: "auth_logout",
          subjectType1: "user",
          subjectId1: userId,
          details: authDetails(req),
        });
      }
      res.json({
        success: true,
        message: "Logout successful",
      });
    });
  }

  /**
   * POST /auth/forgot-password
   * Request a password reset email
   */
  async forgotPassword(req: Request, res: Response): Promise<void> {
    try {
      const { email } = req.body;

      if (!email) {
        res.status(400).json({
          success: false,
          message: "Email is required",
        });
        return;
      }

      const baseUrl = getBaseUrl(req);

      // Must await before responding: under the Lambda Web Adapter the
      // invocation is frozen as soon as the HTTP response is committed, so any
      // post-response work (the SMTP send) gets suspended mid-handshake and
      // the email never goes out. Awaiting first costs the SMTP latency on the
      // response but actually delivers the email.
      const result = await passwordResetService.requestPasswordReset(email, baseUrl);

      // Audit: record the request regardless of whether the email exists.
      // The privacy-preserving response shape doesn't reveal whether the
      // account exists, but we still capture the attempted email for
      // forensics — same convention as auth_login_failure.
      activityLogService.log({
        userId: null,
        eventType: "auth_password_reset_requested",
        subjectType1: "user",
        subjectId1: null,
        details: authDetails(req, { attemptedEmail: typeof email === "string" ? email : null }),
      });

      // The user-existence side stays silent (success either way) — but if
      // the SMTP send itself failed we surface a 502 so the frontend can
      // tell the operator something is wrong with delivery instead of
      // silently lying that the email was sent. Note this leaks "the email
      // exists" when SMTP is broken; that's the deliberate tradeoff.
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
        message: "If an account with this email exists, a reset link has been sent",
      });
    } catch (error: any) {
      console.error("Forgot password error:", error);
      // Still return success for security
      res.json({
        success: true,
        message: "If an account with this email exists, a reset link has been sent",
      });
    }
  }

  /**
   * GET /auth/reset-password/:token
   * Validate a password reset token
   */
  async validateResetToken(req: Request, res: Response): Promise<void> {
    try {
      const { token } = req.params;

      if (!token) {
        res.status(400).json({
          success: false,
          message: "Token is required",
        });
        return;
      }

      const result = await passwordResetService.validateToken(token);

      if (!result.valid) {
        res.status(400).json({
          success: false,
          message: result.error || "Invalid or expired reset link",
        });
        return;
      }

      res.json({
        success: true,
        email: result.email, // Show masked email for user confirmation
      });
    } catch (error: any) {
      console.error("Validate reset token error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to validate reset link",
      });
    }
  }

  /**
   * POST /auth/reset-password
   * Reset password using a token
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

      const result = await passwordResetService.resetPassword(token, newPassword);

      if (result.success) {
        if (result.userId) {
          activityLogService.log({
            userId: result.userId,
            eventType: "auth_password_reset_completed",
            subjectType1: "user",
            subjectId1: result.userId,
            details: authDetails(req),
          });
        }
        res.json({
          success: true,
          message: "Password reset successful. You can now log in with your new password.",
        });
      } else {
        res.status(400).json({
          success: false,
          message: result.error || "Password reset failed",
        });
      }
    } catch (error: any) {
      console.error("Reset password error:", error);
      res.status(500).json({
        success: false,
        message: "Password reset failed",
      });
    }
  }

  async getCurrentUser(req: Request, res: Response): Promise<void> {
    if (req.isAuthenticated() && req.user) {
      const user = req.user as any;
      const support = req.session?.support ?? null;
      // Use the support institute for license resolution when in support mode
      const userData = await userService.formatUserWithPermissions(user, support?.instituteId);
      res.json({
        success: true,
        user: { ...userData, supportSession: support },
      });
    } else {
      res.json({
        success: false,
        user: null,
      });
    }
  }

  googleAuth(req: Request, res: Response, next: NextFunction): void {
    passport.authenticate("google", { scope: ["profile", "email"] })(
      req,
      res,
      next
    );
  }

  googleCallback(req: Request, res: Response, next: NextFunction): void {
    passport.authenticate("google", (err: any, user: any, info: any) => {
      if (err) {
        console.error("Google OAuth error:", err);
        return res.redirect("/?error=auth_failed");
      }

      if (!user) {
        console.log("No user found in Google OAuth callback");
        return res.redirect("/?error=auth_failed");
      }

      // Check if MFA is enabled for OAuth user
      if (user.mfaEnabled) {
        const mfaToken = mfaService.generateMfaToken(user.id, "mfa_challenge");
        return res.redirect(`/login?mfa_required=true&mfa_token=${encodeURIComponent(mfaToken)}`);
      }

      // Check if MFA is enforced but not set up. System admins always require MFA.
      if ((user.mfaEnforcedByAdmin || user.isSystemAdmin) && !user.mfaEnabled) {
        const mfaToken = mfaService.generateMfaToken(user.id, "mfa_setup");
        return res.redirect(`/login?mfa_setup_required=true&mfa_token=${encodeURIComponent(mfaToken)}`);
      }

      req.login(user, (loginErr) => {
        if (loginErr) {
          console.error("Login error after Google OAuth:", loginErr);
          return res.redirect("/?error=auth_failed");
        }

        console.log("Google OAuth login successful, redirecting...");
        return res.redirect("/?auth=success");
      });
    })(req, res, next);
  }

  // ==================== MFA Endpoints ====================

  /**
   * POST /auth/mfa/setup
   * Generate MFA secret and QR code for setup (requires auth)
   */
  async mfaSetup(req: Request, res: Response): Promise<void> {
    try {
      if (!req.isAuthenticated() || !req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required",
        });
        return;
      }

      const user = req.user as any;

      if (user.mfaEnabled) {
        res.status(400).json({
          success: false,
          message: "MFA is already enabled",
        });
        return;
      }

      const setupData = await mfaService.generateSetupData(user.email);

      // Store secret temporarily for verification
      pendingMfaSetups.set(user.id, {
        secret: setupData.secret,
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
      });

      res.json({
        success: true,
        qrCode: setupData.qrCodeDataUrl,
        manualEntryKey: setupData.manualEntryKey,
      });
    } catch (error: any) {
      console.error("MFA setup error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to generate MFA setup",
      });
    }
  }

  /**
   * POST /auth/mfa/setup-with-token
   * Generate MFA secret for setup using mfaToken (for enforced setup during login)
   */
  async mfaSetupWithToken(req: Request, res: Response): Promise<void> {
    try {
      const { mfaToken } = req.body;

      if (!mfaToken) {
        res.status(400).json({
          success: false,
          message: "MFA token is required",
        });
        return;
      }

      const tokenResult = mfaService.verifyMfaToken(mfaToken, "mfa_setup");
      if (!tokenResult.valid || !tokenResult.userId) {
        res.status(401).json({
          success: false,
          message: tokenResult.error || "Invalid or expired MFA token",
        });
        return;
      }

      const user = await mfaService.getUserById(tokenResult.userId);
      if (!user) {
        res.status(404).json({
          success: false,
          message: "User not found",
        });
        return;
      }

      const setupData = await mfaService.generateSetupData(user.email);

      // Store secret temporarily for verification
      pendingMfaSetups.set(user.id, {
        secret: setupData.secret,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      res.json({
        success: true,
        qrCode: setupData.qrCodeDataUrl,
        manualEntryKey: setupData.manualEntryKey,
      });
    } catch (error: any) {
      console.error("MFA setup with token error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to generate MFA setup",
      });
    }
  }

  /**
   * POST /auth/mfa/verify-setup
   * Verify TOTP code and enable MFA (requires auth)
   */
  async mfaVerifySetup(req: Request, res: Response): Promise<void> {
    try {
      if (!req.isAuthenticated() || !req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required",
        });
        return;
      }

      const user = req.user as any;
      const { code } = req.body;

      if (!code || code.length !== 6) {
        res.status(400).json({
          success: false,
          message: "Valid 6-digit code is required",
        });
        return;
      }

      const pendingSetup = pendingMfaSetups.get(user.id);
      if (!pendingSetup || Date.now() > pendingSetup.expiresAt) {
        pendingMfaSetups.delete(user.id);
        res.status(400).json({
          success: false,
          message: "MFA setup expired. Please start again.",
        });
        return;
      }

      // Verify the code
      const isValid = mfaService.verifyToken(pendingSetup.secret, code);
      if (!isValid) {
        res.status(400).json({
          success: false,
          message: "Invalid verification code",
        });
        return;
      }

      // Enable MFA
      await mfaService.enableMfa(user.id, pendingSetup.secret);
      pendingMfaSetups.delete(user.id);

      res.json({
        success: true,
        message: "MFA enabled successfully",
      });
    } catch (error: any) {
      console.error("MFA verify setup error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to enable MFA",
      });
    }
  }

  /**
   * POST /auth/mfa/verify-setup-with-token
   * Verify TOTP and enable MFA using mfaToken (for enforced setup)
   */
  async mfaVerifySetupWithToken(req: Request, res: Response): Promise<void> {
    try {
      const { mfaToken, code, rememberMe, aacClient } = req.body;

      if (!mfaToken) {
        res.status(400).json({
          success: false,
          message: "MFA token is required",
        });
        return;
      }

      if (!code || code.length !== 6) {
        res.status(400).json({
          success: false,
          message: "Valid 6-digit code is required",
        });
        return;
      }

      const tokenResult = mfaService.verifyMfaToken(mfaToken, "mfa_setup");
      if (!tokenResult.valid || !tokenResult.userId) {
        res.status(401).json({
          success: false,
          message: tokenResult.error || "Invalid or expired MFA token",
        });
        return;
      }

      const user = await mfaService.getUserById(tokenResult.userId);
      if (!user) {
        res.status(404).json({
          success: false,
          message: "User not found",
        });
        return;
      }

      const pendingSetup = pendingMfaSetups.get(user.id);
      if (!pendingSetup || Date.now() > pendingSetup.expiresAt) {
        pendingMfaSetups.delete(user.id);
        res.status(400).json({
          success: false,
          message: "MFA setup expired. Please start again.",
        });
        return;
      }

      const isValid = mfaService.verifyToken(pendingSetup.secret, code);
      if (!isValid) {
        res.status(400).json({
          success: false,
          message: "Invalid verification code",
        });
        return;
      }

      // Enable MFA
      await mfaService.enableMfa(user.id, pendingSetup.secret);
      pendingMfaSetups.delete(user.id);

      // Complete login
      req.login(user, (err) => {
        if (err) {
          return res.status(500).json({
            success: false,
            message: "MFA enabled but login failed",
          });
        }

        if (!aacClient) {
          req.session.cookie.maxAge = rememberMe
            ? 30 * 24 * 60 * 60 * 1000
            : 24 * 60 * 60 * 1000;
        }

        res.json({
          success: true,
          message: "MFA enabled and login successful",
          user: userService.formatUserForResponse(user),
        });
      });
    } catch (error: any) {
      console.error("MFA verify setup with token error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to complete MFA setup",
      });
    }
  }

  /**
   * POST /auth/mfa/disable
   * Disable MFA (requires auth and current TOTP code)
   */
  async mfaDisable(req: Request, res: Response): Promise<void> {
    try {
      if (!req.isAuthenticated() || !req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required",
        });
        return;
      }

      const user = req.user as any;
      const { code } = req.body;

      if (!user.mfaEnabled) {
        res.status(400).json({
          success: false,
          message: "MFA is not enabled",
        });
        return;
      }

      if (user.mfaEnforcedByAdmin || user.isSystemAdmin) {
        res.status(403).json({
          success: false,
          message: user.isSystemAdmin
            ? "MFA is required for system administrators and cannot be disabled"
            : "MFA is enforced by administrator and cannot be disabled",
        });
        return;
      }

      if (!code || code.length !== 6) {
        res.status(400).json({
          success: false,
          message: "Valid 6-digit code is required to disable MFA",
        });
        return;
      }

      // Verify the code
      const isValid = await mfaService.verifyUserMfa(user, code);
      if (!isValid) {
        res.status(400).json({
          success: false,
          message: "Invalid verification code",
        });
        return;
      }

      await mfaService.disableMfa(user.id);

      res.json({
        success: true,
        message: "MFA disabled successfully",
      });
    } catch (error: any) {
      console.error("MFA disable error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to disable MFA",
      });
    }
  }

  /**
   * POST /auth/mfa/verify
   * Verify TOTP code during login (uses mfaToken)
   */
  async mfaVerify(req: Request, res: Response): Promise<void> {
    try {
      const { mfaToken, code, rememberMe, aacClient } = req.body;

      if (!mfaToken) {
        res.status(400).json({
          success: false,
          message: "MFA token is required",
        });
        return;
      }

      if (!code || code.length !== 6) {
        res.status(400).json({
          success: false,
          message: "Valid 6-digit code is required",
        });
        return;
      }

      // Verify the MFA token
      const tokenResult = mfaService.verifyMfaToken(mfaToken, "mfa_challenge");
      if (!tokenResult.valid || !tokenResult.userId) {
        res.status(401).json({
          success: false,
          message: tokenResult.error || "Invalid or expired MFA session",
        });
        return;
      }

      // Get user
      const user = await mfaService.getUserById(tokenResult.userId);
      if (!user) {
        res.status(404).json({
          success: false,
          message: "User not found",
        });
        return;
      }

      // Verify TOTP code
      const isValid = await mfaService.verifyUserMfa(user, code);
      if (!isValid) {
        activityLogService.log({
          userId: user.id,
          eventType: "auth_mfa_failure",
          subjectType1: "user",
          subjectId1: user.id,
          details: authDetails(req),
        });
        res.status(400).json({
          success: false,
          message: "Invalid verification code",
        });
        return;
      }

      // Complete login
      req.login(user, (err) => {
        if (err) {
          return res.status(500).json({
            success: false,
            message: "Login failed",
          });
        }

        if (!aacClient) {
          req.session.cookie.maxAge = rememberMe
            ? 30 * 24 * 60 * 60 * 1000
            : 24 * 60 * 60 * 1000;
        }

        activityLogService.log({
          userId: user.id,
          eventType: "auth_mfa_success",
          subjectType1: "user",
          subjectId1: user.id,
          details: authDetails(req, { rememberMe: !!rememberMe, aacClient: !!aacClient }),
        });
        // The successful MFA completes a login — also fire the login_success
        // event so a single query for "login_success" gives the full picture.
        activityLogService.log({
          userId: user.id,
          eventType: "auth_login_success",
          subjectType1: "user",
          subjectId1: user.id,
          details: authDetails(req, { mfa: true }),
        });

        res.json({
          success: true,
          message: "Login successful",
          user: userService.formatUserForResponse(user),
        });
      });
    } catch (error: any) {
      console.error("MFA verify error:", error);
      res.status(500).json({
        success: false,
        message: "MFA verification failed",
      });
    }
  }

  /**
   * POST /auth/mfa/recovery/request
   * Request MFA recovery email
   */
  async mfaRecoveryRequest(req: Request, res: Response): Promise<void> {
    try {
      const { email } = req.body;

      if (!email) {
        res.status(400).json({
          success: false,
          message: "Email is required",
        });
        return;
      }

      const baseUrl = getBaseUrl(req);

      // Must await before responding (Lambda Web Adapter freezes the
      // invocation at HTTP-response time — same bug as forgotPassword).
      const result = await mfaService.requestRecovery(email, baseUrl);

      // Surface SMTP delivery failure to the operator (same tradeoff as
      // forgotPassword); user-existence still stays silent.
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
        message: "If an account with MFA exists, a recovery link has been sent",
      });
    } catch (error: any) {
      console.error("MFA recovery request error:", error);
      res.json({
        success: true,
        message: "If an account with MFA exists, a recovery link has been sent",
      });
    }
  }

  /**
   * GET /auth/mfa/recovery/:token
   * Validate MFA recovery token
   */
  async mfaRecoveryValidate(req: Request, res: Response): Promise<void> {
    try {
      const { token } = req.params;

      if (!token) {
        res.status(400).json({
          success: false,
          message: "Token is required",
        });
        return;
      }

      const result = await mfaService.validateRecoveryToken(token);

      if (!result.valid) {
        res.status(400).json({
          success: false,
          message: result.error || "Invalid or expired recovery link",
        });
        return;
      }

      res.json({
        success: true,
        email: result.email,
      });
    } catch (error: any) {
      console.error("MFA recovery validate error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to validate recovery link",
      });
    }
  }

  /**
   * POST /auth/mfa/recovery/complete
   * Complete MFA recovery - disable MFA
   */
  async mfaRecoveryComplete(req: Request, res: Response): Promise<void> {
    try {
      const { token } = req.body;

      if (!token) {
        res.status(400).json({
          success: false,
          message: "Token is required",
        });
        return;
      }

      const result = await mfaService.completeRecovery(token);

      if (result.success) {
        res.json({
          success: true,
          message: "MFA has been disabled. You can now log in with your password.",
        });
      } else {
        res.status(400).json({
          success: false,
          message: result.error || "Failed to complete recovery",
        });
      }
    } catch (error: any) {
      console.error("MFA recovery complete error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to complete recovery",
      });
    }
  }

  /**
   * POST /auth/impersonate
   * Log in as another user without password (dev/test only)
   */
  async impersonate(req: Request, res: Response): Promise<void> {
    try {
      const { email } = req.body;

      if (!email) {
        res.status(400).json({
          success: false,
          message: "Email is required",
        });
        return;
      }

      const user = await userService.getUserByEmail(email);
      if (!user) {
        res.status(404).json({
          success: false,
          message: "User not found",
        });
        return;
      }

      req.login(user, (err) => {
        if (err) {
          return res.status(500).json({
            success: false,
            message: "Impersonation login failed",
          });
        }

        if (!req.body.aacClient) {
          req.session.cookie.maxAge = 24 * 60 * 60 * 1000;
        }

        res.json({
          success: true,
          message: `Now logged in as ${user.email}`,
          user: userService.formatUserForResponse(user),
        });
      });
    } catch (error: any) {
      console.error("Impersonate error:", error);
      res.status(500).json({
        success: false,
        message: "Impersonation failed",
      });
    }
  }

  /**
   * GET /auth/mfa/status
   * Get current user's MFA status
   */
  async mfaStatus(req: Request, res: Response): Promise<void> {
    try {
      if (!req.isAuthenticated() || !req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required",
        });
        return;
      }

      const user = req.user as any;

      res.json({
        success: true,
        mfaEnabled: user.mfaEnabled,
        mfaEnforcedByAdmin: user.mfaEnforcedByAdmin,
      });
    } catch (error: any) {
      console.error("MFA status error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to get MFA status",
      });
    }
  }

  // ==================== Customer Support ====================

  /**
   * POST /api/admin/support-login
   * Enter customer support mode for a specific license's institute.
   * Only available to users with customer support privileges (system admins).
   */
  async supportLogin(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      if (!isCustomerSupport(user)) {
        res.status(403).json({ success: false, message: "Not authorized for customer support" });
        return;
      }

      const { licenseId } = req.body;
      if (!licenseId) {
        res.status(400).json({ success: false, message: "licenseId is required" });
        return;
      }

      const license = await licenseRepository.getLicenseById(licenseId);
      if (!license) {
        res.status(404).json({ success: false, message: "License not found" });
        return;
      }
      if (!license.instituteId) {
        res.status(400).json({ success: false, message: "This license has no associated institute" });
        return;
      }

      const institute = await instituteRepository.getInstituteById(license.instituteId);
      if (!institute) {
        res.status(404).json({ success: false, message: "Institute not found" });
        return;
      }

      // Set support session
      req.session.support = {
        instituteId: license.instituteId,
        startedAt: new Date().toISOString(),
      };

      console.log(`[CustomerSupport] User ${user.email} entered support mode for institute "${institute.name}" (${license.instituteId})`);

      res.json({
        success: true,
        message: `Entered support mode for ${institute.name}`,
        support: req.session.support,
        institute: { id: institute.id, name: institute.name, type: institute.type },
      });
    } catch (error: any) {
      console.error("Support login error:", error);
      res.status(500).json({ success: false, message: "Failed to enter support mode" });
    }
  }

  /**
   * POST /api/admin/support-logout
   * Exit customer support mode and return to normal admin access.
   */
  async supportLogout(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const wasInSupport = !!req.session?.support;

      delete req.session.support;

      if (wasInSupport) {
        console.log(`[CustomerSupport] User ${user?.email} exited support mode`);
      }

      res.json({ success: true, message: "Exited support mode" });
    } catch (error: any) {
      console.error("Support logout error:", error);
      res.status(500).json({ success: false, message: "Failed to exit support mode" });
    }
  }
}

export const authController = new AuthController();
