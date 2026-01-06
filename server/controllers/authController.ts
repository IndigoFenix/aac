// server/controllers/authController.ts
// Complete auth controller with password reset functionality

import type { Request, Response, NextFunction } from "express";
import passport from "passport";
import { userService, passwordResetService } from "../services";
import { registerSchema, loginSchema } from "@shared/schema";

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

      if (newPassword.length < 6) {
        res.status(400).json({
          success: false,
          message: "Password must be at least 6 characters long",
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
}

export const authController = new AuthController();
