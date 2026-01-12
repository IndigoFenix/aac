// server/controllers/authController.ts
// Complete auth controller with password reset and MFA functionality

import type { Request, Response, NextFunction } from "express";
import passport from "passport";
import { userService, passwordResetService } from "../services";
import { mfaService } from "../services/mfaService";
import { registerSchema, loginSchema, validatePassword } from "@shared/schema";

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
        return res.status(500).json({
          success: false,
          message: "Login failed",
        });
      }

      if (!user) {
        return res.status(401).json({
          success: false,
          message: info?.message || "Invalid login credentials",
        });
      }

      // Check if MFA is enabled
      if (user.mfaEnabled) {
        // Generate MFA challenge token (don't create session yet)
        const mfaToken = mfaService.generateMfaToken(user.id, "mfa_challenge");
        return res.json({
          success: true,
          mfaRequired: true,
          mfaToken,
          message: "MFA verification required",
        });
      }

      // Check if MFA is enforced but not set up
      if (user.mfaEnforcedByAdmin && !user.mfaEnabled) {
        const mfaToken = mfaService.generateMfaToken(user.id, "mfa_setup");
        return res.json({
          success: true,
          mfaSetupRequired: true,
          mfaToken,
          message: "MFA setup required by administrator",
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

        const { rememberMe } = req.body;
        if (rememberMe) {
          req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
        } else {
          req.session.cookie.maxAge = 24 * 60 * 60 * 1000; // 1 day
        }

        res.json({
          success: true,
          message: "Login successful",
          user: userService.formatUserForResponse(user),
        });
      });
    })(req, res, next);
  }

  logout(req: Request, res: Response): void {
    req.logout((err) => {
      if (err) {
        res.status(500).json({
          success: false,
          message: "Logout failed",
        });
        return;
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

      // Get base URL from request
      const protocol = req.headers["x-forwarded-proto"] || req.protocol;
      const host = req.headers["x-forwarded-host"] || req.get("host");
      const baseUrl = `${protocol}://${host}`;

      // Always return success for security reasons (don't reveal if email exists)
      res.json({
        success: true,
        message: "If an account with this email exists, a reset link has been sent",
      });

      // Process in background (already responded to user)
      await passwordResetService.requestPasswordReset(email, baseUrl);
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

  getCurrentUser(req: Request, res: Response): void {
    if (req.isAuthenticated() && req.user) {
      const user = req.user as any;
      res.json({
        success: true,
        user: userService.formatUserForResponse(user),
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

      // Check if MFA is enforced but not set up
      if (user.mfaEnforcedByAdmin && !user.mfaEnabled) {
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
      const { mfaToken, code, rememberMe } = req.body;

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

        if (rememberMe) {
          req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
        } else {
          req.session.cookie.maxAge = 24 * 60 * 60 * 1000;
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

      if (user.mfaEnforcedByAdmin) {
        res.status(403).json({
          success: false,
          message: "MFA is enforced by administrator and cannot be disabled",
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
      const { mfaToken, code, rememberMe } = req.body;

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

        if (rememberMe) {
          req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
        } else {
          req.session.cookie.maxAge = 24 * 60 * 60 * 1000;
        }

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

      const protocol = req.headers["x-forwarded-proto"] || req.protocol;
      const host = req.headers["x-forwarded-host"] || req.get("host");
      const baseUrl = `${protocol}://${host}`;

      // Always return success for security
      res.json({
        success: true,
        message: "If an account with MFA exists, a recovery link has been sent",
      });

      // Process in background
      await mfaService.requestRecovery(email, baseUrl);
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
}

export const authController = new AuthController();
