import type { Request, Response, NextFunction } from "express";
import passport from "passport";
import { userService, passwordResetService } from "../services";
import { registerSchema, loginSchema } from "@shared/schema";
import emailService from "../services/emailService";

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

      // Always return success for security reasons
      res.json({
        success: true,
        message:
          "If an account with this email exists, a reset link has been sent",
      });

      // Only send email if user actually exists
      const user = await userService.getUserByEmail(email);
      if (user) {
        console.log(`Password reset requested for user: ${email} (ID: ${user.id})`);

        const resetToken = await passwordResetService.createPasswordResetToken(
          user.id
        );

        const emailSent = await emailService.sendPasswordResetEmail(
          user.email,
          resetToken,
          user.firstName || user.fullName || undefined
        );

        if (emailSent) {
          console.log(`Password reset email sent successfully to: ${email}`);
        } else {
          console.error(`Failed to send password reset email to: ${email}`);
        }
      }
    } catch (error: any) {
      console.error("Forgot password error:", error);
      res.status(500).json({
        success: false,
        message: "Password reset request failed",
      });
    }
  }

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
          message: "Password reset successful",
        });
      } else {
        res.status(400).json({
          success: false,
          message: result.error,
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
