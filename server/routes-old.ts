import type { Express, Request, Response, RequestHandler } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import path from "path";
import Stripe from "stripe";
import { storage } from "./storage";
import {
  interpretRequestSchema,
  updateUserSchema,
  insertApiProviderSchemaWithValidation,
  insertSavedLocationSchema,
  insertAacUserScheduleSchema,
  updateAacUserScheduleSchema,
} from "@shared/schema";
import { interpretAACText, interpretAACImage } from "./services/interpretationService";
// Removed Replit auth import - now using internal admin authentication
import {
  setupUserAuth,
  requireAuth,
  optionalAuth,
  requireSLPPlan,
  validateCredits,
  deductCredit,
} from "./userAuth";
import { registerSchema, loginSchema } from "@shared/schema";
import emailService from "./services/emailService";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import passport from "passport";
import { stringify } from "csv-stringify";
import { any, z } from "zod";
import { analyticsService } from "./services/analyticsService";
import { boardGenerator } from "./services/boardGenerationService";

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-12-18.acacia",
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (
    req: Request,
    file: Express.Multer.File,
    cb: multer.FileFilterCallback,
  ) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

export async function registerRoutes(app: Express): Promise<Server> {
  // Set trust proxy for rate limiting behind proxies
  app.set("trust proxy", 1);

  // Setup user authentication
  await setupUserAuth(app);

  // ============= USER AUTHENTICATION ROUTES =============

  // Register new user
  app.post("/auth/register", async (req, res) => {
    try {
      const userData = registerSchema.parse(req.body);
      const { referralCode } = req.body; // Optional referral code

      // Check if user already exists
      const existingUser = await storage.getUserByEmail(userData.email);
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: "An account with this email already exists",
        });
      }

      // Validate referral code if provided
      let referrerId: string | null = null;
      if (referralCode && typeof referralCode === 'string') {
        const referrer = await storage.getUserByReferralCode(referralCode);
        if (referrer) {
          referrerId = referrer.id;
        } else {
          console.log(`Invalid referral code provided: ${referralCode}`);
          // Note: We don't reject registration for invalid code, just log it
        }
      }

      // Create user with referred_by_id if valid referral code
      const userDataWithReferral = {
        ...userData,
        ...(referrerId && { referredById: referrerId }),
      };

      const user = await storage.createUser(userDataWithReferral);

      // Execute atomic credit rewards if user was referred
      if (referrerId) {
        try {
          // Get configurable bonus amount from settings
          const bonusCreditsStr = await storage.getSetting('REFERRAL_BONUS_CREDITS', '50');
          const bonusCredits = parseInt(bonusCreditsStr || '50', 10);

          // Reward both new user and referrer in a single atomic transaction
          await storage.rewardReferralBonus(user.id, referrerId, bonusCredits);

          console.log(`Referral rewards processed: ${bonusCredits} credits to user ${user.id} and referrer ${referrerId}`);
        } catch (creditError) {
          console.error('Error processing referral credits:', creditError);
          return res.status(500).json({
            success: false,
            message: "Account created but referral bonus failed. Please contact support.",
          });
        }
      }

      // Fetch updated user data with correct credit balance
      const updatedUser = await storage.getUser(user.id);

      // Log the user in
      req.login(updatedUser || user, (err) => {
        if (err) {
          return res.status(500).json({
            success: false,
            message: "Account created but login failed",
          });
        }

        res.json({
          success: true,
          message: "Account created successfully",
          user: {
            id: (updatedUser || user).id,
            email: (updatedUser || user).email,
            firstName: (updatedUser || user).firstName,
            lastName: (updatedUser || user).lastName,
            fullName: (updatedUser || user).fullName,
            userType: (updatedUser || user).userType,
            credits: (updatedUser || user).credits,
            subscriptionType: (updatedUser || user).subscriptionType,
            profileImageUrl: (updatedUser || user).profileImageUrl,
            referralCode: (updatedUser || user).referralCode,
          },
        });
      });
    } catch (error: any) {
      console.error("Registration error:", error);
      res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : "Registration failed",
      });
    }
  });

  // Login user
  app.post("/auth/login", (req, res, next) => {
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

        // Adjust session duration based on remember me
        const { rememberMe } = req.body;
        if (rememberMe) {
          // Extend session to 30 days for remember me
          req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
        } else {
          // Default session (1 day)
          req.session.cookie.maxAge = 24 * 60 * 60 * 1000; // 1 day
        }

        res.json({
          success: true,
          message: "Login successful",
          user: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            fullName: user.fullName,
            userType: user.userType,
            credits: user.credits,
            subscriptionType: user.subscriptionType,
            profileImageUrl: user.profileImageUrl,
          },
        });
      });
    })(req, res, next);
  });

  // Google OAuth routes (only if credentials are configured)
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    console.log("Setting up Google OAuth with credentials...");
    app.get("/auth/google", (req, res, next) => {
      console.log("Google OAuth route hit");
      passport.authenticate("google", { scope: ["profile", "email"] })(
        req,
        res,
        next,
      );
    });

    app.get("/auth/google/callback", (req, res, next) => {
      console.log("Google OAuth callback route hit with query:", req.query);
      console.log("Google OAuth callback request URL:", req.url);

      passport.authenticate("google", (err: any, user: any, info: any) => {
        console.log(
          "Google OAuth authenticate callback - err:",
          err,
          "user:",
          user ? "found" : "not found",
          "info:",
          info,
        );

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
    });
  } else {
    console.log("Google OAuth not configured - missing credentials");
    // Fallback route when Google OAuth is not configured
    app.get("/auth/google", (req, res) => {
      res.status(501).json({
        success: false,
        message: "Google OAuth is not configured on this server",
      });
    });
  }

  // Logout user
  app.post("/auth/logout", (req, res) => {
    req.logout((err) => {
      if (err) {
        return res.status(500).json({
          success: false,
          message: "Logout failed",
        });
      }
      res.json({
        success: true,
        message: "Logout successful",
      });
    });
  });

  // Forgot password
  app.post("/auth/forgot-password", async (req, res) => {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          message: "Email is required",
        });
      }

      // Check if user exists
      const user = await storage.getUserByEmail(email);

      // Always return success for security reasons (don't reveal if email exists)
      res.json({
        success: true,
        message:
          "If an account with this email exists, a reset link has been sent",
      });

      // Only send email if user actually exists
      if (user) {
        console.log(
          `Password reset requested for user: ${email} (ID: ${user.id})`,
        );

        // Cleanup expired tokens for this user
        await storage.cleanupExpiredTokens();

        // Generate secure reset token
        const resetToken = emailService.generateResetToken();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        // Store token in database
        await storage.createPasswordResetToken({
          userId: user.id,
          token: resetToken,
          expiresAt,
          isUsed: false,
        });

        // Send reset email
        const emailSent = await emailService.sendPasswordResetEmail(
          user.email,
          resetToken,
          user.firstName || user.fullName || undefined,
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
  });

  // Reset password with token
  app.post("/auth/reset-password", async (req, res) => {
    try {
      const { token, newPassword } = req.body;

      if (!token || !newPassword) {
        return res.status(400).json({
          success: false,
          message: "Token and new password are required",
        });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({
          success: false,
          message: "Password must be at least 6 characters long",
        });
      }

      // Find and validate token
      const resetToken = await storage.getPasswordResetToken(token);

      if (!resetToken) {
        return res.status(400).json({
          success: false,
          message: "Invalid or expired reset token",
        });
      }

      // Check if token is expired
      if (resetToken.expiresAt < new Date()) {
        return res.status(400).json({
          success: false,
          message: "Reset token has expired",
        });
      }

      // Check if token is already used
      if (resetToken.isUsed) {
        return res.status(400).json({
          success: false,
          message: "Reset token has already been used",
        });
      }

      // Get user
      const user = await storage.getUser(resetToken.userId);
      if (!user) {
        return res.status(400).json({
          success: false,
          message: "User not found",
        });
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 12);

      // Update user password and mark token as used
      await storage.updateUser(user.id, {
        password: hashedPassword,
        updatedAt: new Date(),
      });

      await storage.markTokenAsUsed(resetToken.id);

      console.log(
        `Password successfully reset for user: ${user.email} (ID: ${user.id})`,
      );

      res.json({
        success: true,
        message: "Password reset successful",
      });
    } catch (error: any) {
      console.error("Reset password error:", error);
      res.status(500).json({
        success: false,
        message: "Password reset failed",
      });
    }
  });

  // Get current user
  app.get("/auth/user", optionalAuth, (req, res) => {
    if (req.isAuthenticated() && req.user) {
      const user = req.user as any;
      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          fullName: user.fullName,
          userType: user.userType,
          isAdmin: user.isAdmin,
          credits: user.credits,
          subscriptionType: user.subscriptionType,
          profileImageUrl: user.profileImageUrl,
          isActive: user.isActive,
          referralCode: user.referralCode,
        },
      });
    } else {
      res.json({
        success: false,
        user: null,
      });
    }
  });

  // ============= PROFILE MANAGEMENT ROUTES =============

  // Upload profile image
  app.post(
    "/api/profile/upload-image",
    requireAuth,
    upload.single("profileImage"),
    async (req: Request & { file?: Express.Multer.File }, res) => {
      try {
        const currentUser = req.user as any;

        if (!req.file) {
          return res.status(400).json({
            success: false,
            message: "No image file provided",
          });
        }

        // Convert buffer to base64 for storage
        const base64Image = req.file.buffer.toString("base64");
        const mimeType = req.file.mimetype;
        const imageUrl = `data:${mimeType};base64,${base64Image}`;

        // Update user profile with image URL
        const updatedUser = await storage.updateUser(currentUser.id, {
          profileImageUrl: imageUrl,
        });

        if (!updatedUser) {
          return res.status(500).json({
            success: false,
            message: "Failed to update profile image",
          });
        }

        // Update session user data
        (req.user as any).profileImageUrl = imageUrl;

        res.json({
          success: true,
          message: "Profile image uploaded successfully",
          imageUrl: imageUrl,
        });
      } catch (error: any) {
        console.error("Profile image upload error:", error);
        res.status(500).json({
          success: false,
          message: "Profile image upload failed",
        });
      }
    },
  );

  // Update profile information
  app.patch("/api/profile/update", requireAuth, async (req, res) => {
    try {
      const currentUser = req.user as any;
      const { firstName, lastName } = req.body;

      if (!firstName || firstName.trim() === "") {
        return res.status(400).json({
          success: false,
          message: "First name is required",
        });
      }

      const fullName = `${firstName.trim()} ${(lastName || "").trim()}`.trim();

      const updatedUser = await storage.updateUser(currentUser.id, {
        firstName: firstName.trim(),
        lastName: lastName ? lastName.trim() : null,
        fullName: fullName,
      });

      if (!updatedUser) {
        return res.status(500).json({
          success: false,
          message: "Failed to update profile",
        });
      }

      // Update session user data
      Object.assign(req.user as any, {
        firstName: updatedUser.firstName,
        lastName: updatedUser.lastName,
        fullName: updatedUser.fullName,
      });

      res.json({
        success: true,
        message: "Profile updated successfully",
        user: {
          firstName: updatedUser.firstName,
          lastName: updatedUser.lastName,
          fullName: updatedUser.fullName,
        },
      });
    } catch (error: any) {
      console.error("Profile update error:", error);
      res.status(500).json({
        success: false,
        message: "Profile update failed",
      });
    }
  });

  // AAC User Profile Management
  app.get("/api/aac-users", requireAuth, async (req: any, res) => {
    try {
      const currentUser = req.user as any;
      console.log('Getting AAC users for user ID:', currentUser.id);
      const aacUsers = await storage.getAacUsersByUserId(currentUser.id);
      res.json({ success: true, aacUsers });
    } catch (error: any) {
      console.error("Error fetching AAC users:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch AAC users" });
    }
  });

  app.post("/api/aac-users", requireAuth, async (req: any, res) => {
    try {
      const currentUser = req.user as any;
      const { alias, gender, age, disabilityOrSyndrome } = req.body;

      if (!alias) {
        return res
          .status(400)
          .json({ success: false, message: "Alias is required" });
      }

      // Generate unique AAC user ID automatically
      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      const aacUserId = `aac_${currentUser.id}_${timestamp}_${randomSuffix}`;

      const aacUser = await storage.createAacUser({
        userId: currentUser.id,
        alias,
        gender,
        age,
        disabilityOrSyndrome,
        isActive: true,
      });

      res.json({
        success: true,
        message: "AAC user created successfully",
        aacUser,
      });
    } catch (error: any) {
      console.error("Error creating AAC user:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to create AAC user" });
    }
  });

  app.patch("/api/aac-users/:id", requireAuth, async (req: any, res) => {
    try {
      const aacUserId = req.params.id;
      const { alias, gender, age, disabilityOrSyndrome } = req.body;

      const updates: any = {};
      if (alias !== undefined) updates.alias = alias;
      if (gender !== undefined) updates.gender = gender;
      if (age !== undefined) updates.age = age;
      if (disabilityOrSyndrome !== undefined)
        updates.disabilityOrSyndrome = disabilityOrSyndrome;

      const updatedAacUser = await storage.updateAacUser(aacUserId, updates);
      if (updatedAacUser) {
        res.json({
          success: true,
          message: "AAC user updated successfully",
          aacUser: updatedAacUser,
        });
      } else {
        res.status(404).json({ success: false, message: "AAC user not found" });
      }
    } catch (error: any) {
      console.error("Error updating AAC user:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to update AAC user" });
    }
  });

  app.delete("/api/aac-users/:id", requireAuth, async (req: any, res) => {
    try {
      const aacUserId = req.params.id;
      const deleted = await storage.deleteAacUser(aacUserId);
      if (deleted) {
        res.json({ success: true, message: "AAC user deleted successfully" });
      } else {
        res.status(404).json({ success: false, message: "AAC user not found" });
      }
    } catch (error: any) {
      console.error("Error deleting AAC user:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to delete AAC user" });
    }
  });

  // ============= AAC USER SCHEDULE ROUTES =============

  // Get schedules for an AAC user
  app.get("/api/schedules/:aacUserId", requireAuth, async (req: any, res) => {
    try {
      const { aacUserId } = req.params;
      const schedules = await storage.getSchedulesByAacUserId(aacUserId);
      res.json({ success: true, schedules });
    } catch (error: any) {
      console.error("Error fetching schedules:", error);
      res.status(500).json({ success: false, message: "Failed to fetch schedules" });
    }
  });

  // Create a new schedule entry
  app.post("/api/schedules", requireAuth, async (req: any, res) => {
    try {
      const validatedData = insertAacUserScheduleSchema.parse(req.body);
      const schedule = await storage.createScheduleEntry(validatedData);
      res.json({
        success: true,
        message: "Schedule entry created successfully",
        schedule,
      });
    } catch (error: any) {
      console.error("Error creating schedule:", error);
      if (error.name === "ZodError") {
        return res.status(400).json({
          success: false,
          message: "Invalid schedule data",
          errors: error.errors,
        });
      }
      res.status(500).json({ success: false, message: "Failed to create schedule entry" });
    }
  });

  // Update a schedule entry
  app.patch("/api/schedules/:id", requireAuth, async (req: any, res) => {
    try {
      const scheduleId = req.params.id;
      const validatedData = updateAacUserScheduleSchema.parse(req.body);
      const updated = await storage.updateScheduleEntry(scheduleId, validatedData);
      if (updated) {
        res.json({
          success: true,
          message: "Schedule entry updated successfully",
          schedule: updated,
        });
      } else {
        res.status(404).json({ success: false, message: "Schedule entry not found" });
      }
    } catch (error: any) {
      console.error("Error updating schedule:", error);
      if (error.name === "ZodError") {
        return res.status(400).json({
          success: false,
          message: "Invalid schedule data",
          errors: error.errors,
        });
      }
      res.status(500).json({ success: false, message: "Failed to update schedule entry" });
    }
  });

  // Delete a schedule entry
  app.delete("/api/schedules/:id", requireAuth, async (req: any, res) => {
    try {
      const scheduleId = req.params.id;
      const deleted = await storage.deleteScheduleEntry(scheduleId);
      if (deleted) {
        res.json({ success: true, message: "Schedule entry deleted successfully" });
      } else {
        res.status(404).json({ success: false, message: "Schedule entry not found" });
      }
    } catch (error: any) {
      console.error("Error deleting schedule:", error);
      res.status(500).json({ success: false, message: "Failed to delete schedule entry" });
    }
  });

  // Get current schedule context for an AAC user (internal endpoint)
  app.get("/api/schedules/:aacUserId/context", requireAuth, async (req: any, res) => {
    try {
      const { aacUserId } = req.params;
      const timestamp = req.query.timestamp ? new Date(req.query.timestamp) : new Date();
      const context = await storage.getCurrentScheduleContext(aacUserId, timestamp);
      res.json({ success: true, context });
    } catch (error: any) {
      console.error("Error fetching schedule context:", error);
      res.status(500).json({ success: false, message: "Failed to fetch schedule context" });
    }
  });

  // ============= SAVED LOCATIONS ROUTES =============

  // Get user's saved locations
  app.get("/api/saved-locations", requireAuth, async (req: any, res) => {
    try {
      const currentUser = req.user as any;
      const savedLocations = await storage.getUserSavedLocations(
        currentUser.id,
      );
      res.json({ success: true, savedLocations });
    } catch (error: any) {
      console.error("Error fetching saved locations:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch saved locations" });
    }
  });

  // Create a new saved location (for GPS aliases)
  app.post("/api/saved-locations", requireAuth, async (req: any, res) => {
    try {
      const currentUser = req.user as any;

      // Validate request body using Zod schema
      const validatedData = insertSavedLocationSchema.parse({
        ...req.body,
        userId: currentUser.id,
      });

      // Additional validation for GPS locations - ensure coordinates are valid numbers
      if (validatedData.locationType === "gps") {
        if (!validatedData.latitude || !validatedData.longitude) {
          return res.status(400).json({
            success: false,
            message: "Latitude and longitude are required for GPS locations",
          });
        }

        // Validate coordinate ranges
        const lat = parseFloat(validatedData.latitude.toString());
        const lng = parseFloat(validatedData.longitude.toString());

        if (lat < -90 || lat > 90) {
          return res.status(400).json({
            success: false,
            message: "Latitude must be between -90 and 90 degrees",
          });
        }

        if (lng < -180 || lng > 180) {
          return res.status(400).json({
            success: false,
            message: "Longitude must be between -180 and 180 degrees",
          });
        }
      }

      const savedLocation = await storage.createSavedLocation(validatedData);

      res.json({
        success: true,
        message: "Location saved successfully",
        savedLocation,
      });
    } catch (error: any) {
      console.error("Error creating saved location:", error);

      // Handle Zod validation errors
      if (error instanceof Error && error.name === "ZodError") {
        return res.status(400).json({
          success: false,
          message: "Invalid location data provided",
          details: error.message,
        });
      }

      res
        .status(500)
        .json({ success: false, message: "Failed to save location" });
    }
  });

  // Delete a saved location
  app.delete("/api/saved-locations/:id", requireAuth, async (req: any, res) => {
    try {
      const currentUser = req.user as any;
      const locationId = req.params.id;

      if (isNaN(locationId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid location ID",
        });
      }

      const deleted = await storage.deleteSavedLocation(
        locationId,
        currentUser.id,
      );
      if (deleted) {
        res.json({ success: true, message: "Location deleted successfully" });
      } else {
        res.status(404).json({ success: false, message: "Location not found" });
      }
    } catch (error: any) {
      console.error("Error deleting saved location:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to delete location" });
    }
  });

  // ============= INVITE CODE ROUTES =============

  // Create invite code for AAC user
  app.post("/api/invite-codes", requireAuth, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const { aacUserId, redemptionLimit, expiresAt } = req.body;

      if (!aacUserId) {
        return res
          .status(400)
          .json({ success: false, message: "AAC user ID is required" });
      }

      // Verify the AAC user belongs to the current user
      const aacUser = await storage.getAacUserByAacUserId(aacUserId);
      if (!aacUser || aacUser.userId !== currentUser.id) {
        return res.status(403).json({
          success: false,
          message: "AAC user not found or not owned by you",
        });
      }

      const inviteCodeData = {
        createdByUserId: currentUser.id,
        aacUserId,
        redemptionLimit: redemptionLimit || 1,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      };

      const inviteCode = await storage.createInviteCode(inviteCodeData);
      res.json({
        success: true,
        message: "Invite code created successfully",
        inviteCode,
      });
    } catch (error: any) {
      console.error("Error creating invite code:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to create invite code" });
    }
  });

  // Get invite codes created by current user
  app.get("/api/invite-codes", requireAuth, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const inviteCodes = await storage.getInviteCodesByUserId(currentUser.id);
      res.json({ success: true, inviteCodes });
    } catch (error: any) {
      console.error("Error fetching invite codes:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch invite codes" });
    }
  });

  // Redeem invite code
  app.post("/api/invite-codes/redeem", requireAuth, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const { code } = req.body;

      if (!code) {
        return res
          .status(400)
          .json({ success: false, message: "Invite code is required" });
      }

      const result = await storage.redeemInviteCode(code, currentUser.id);

      if (result.success) {
        res.json({
          success: true,
          message: "Invite code redeemed successfully",
          aacUser: result.aacUser,
        });
      } else {
        res.status(400).json({
          success: false,
          message: result.error,
        });
      }
    } catch (error: any) {
      console.error("Error redeeming invite code:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to redeem invite code" });
    }
  });

  // Get invite code redemptions by current user
  app.get(
    "/api/invite-codes/redemptions",
    requireAuth,
    async (req: any, res) => {
      try {
        const currentUser = req.user;
        const redemptions = await storage.getInviteCodeRedemptions(
          currentUser.id,
        );
        res.json({ success: true, redemptions });
      } catch (error: any) {
        console.error("Error fetching redemptions:", error);
        res
          .status(500)
          .json({ success: false, message: "Failed to fetch redemptions" });
      }
    },
  );

  // Deactivate invite code
  app.patch(
    "/api/invite-codes/:id/deactivate",
    requireAuth,
    async (req: any, res) => {
      try {
        const currentUser = req.user;
        const inviteCodeId = req.params.id;

        // Verify the invite code belongs to the current user
        const inviteCodes = await storage.getInviteCodesByUserId(
          currentUser.id,
        );
        const inviteCode = inviteCodes.find((ic) => ic.id === inviteCodeId);

        if (!inviteCode) {
          return res
            .status(404)
            .json({ success: false, message: "Invite code not found" });
        }

        const deactivated = await storage.deactivateInviteCode(inviteCodeId);
        if (deactivated) {
          res.json({
            success: true,
            message: "Invite code deactivated successfully",
          });
        } else {
          res.status(500).json({
            success: false,
            message: "Failed to deactivate invite code",
          });
        }
      } catch (error: any) {
        console.error("Error deactivating invite code:", error);
        res.status(500).json({
          success: false,
          message: "Failed to deactivate invite code",
        });
      }
    },
  );

  // ============= ONBOARDING ROUTES =============

  // Onboarding middleware - checks if user has completed onboarding
  const requireOnboardingComplete = async (req: any, res: any, next: any) => {
    try {
      if (!req.user) {
        return next(); // Let optionalAuth handle unauthenticated users
      }

      const user = await storage.getUser(req.user.id);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      // Check if user has completed onboarding
      if (user.onboardingStep < 3) {
        // Allow users who have AAC users to proceed even if onboarding not marked complete
        const aacUsers = await storage.getAacUsersByUserId(req.user.id);
        if (!aacUsers || aacUsers.length === 0) {
          return res.status(412).json({
            success: false,
            message: "Please complete onboarding first",
            errorType: "onboarding_incomplete",
            onboardingStep: user.onboardingStep,
          });
        }
      }

      next();
    } catch (error: any) {
      console.error("Onboarding check error:", error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  };

  // Get onboarding status
  app.get("/api/onboarding/status", requireAuth, async (req, res) => {
    try {
      const currentUser = req.user as { id: string };
      const user = await storage.getUser(currentUser.id);
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      res.json({
        success: true,
        onboardingStep: user.onboardingStep,
      });
    } catch (error: any) {
      console.error("Error fetching onboarding status:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch onboarding status",
      });
    }
  });

  // Complete Step 1: Create AAC User Profile
  app.post("/api/onboarding/complete-step-1", requireAuth, async (req, res) => {
    try {
      const currentUser = req.user as { id: string };
      const { name, age, condition } = req.body;

      console.log('Onboarding Step 1 - Request received:', {
        userId: currentUser.id,
        name,
        age,
        condition,
      });

      if (!name || !age) {
        console.error('Onboarding Step 1 - Validation failed: missing name or age');
        return res.status(400).json({
          success: false,
          message: "Name and age are required",
        });
      }

      // Create AAC user profile
      console.log('Onboarding Step 1 - Creating AAC user...');
      const aacUser = await storage.createAacUser({
        userId: currentUser.id,
        alias: name,
        age: parseInt(age),
        backgroundContext: condition || null,
      });
      console.log('Onboarding Step 1 - AAC user created successfully:', aacUser.aacUserId);

      // Update user's onboarding step to 1
      await storage.updateUserOnboardingStep(currentUser.id, 1);
      console.log('Onboarding Step 1 - Onboarding step updated to 1');

      res.json({
        success: true,
        message: "AAC user profile created successfully",
        aacUser,
        onboardingStep: 1,
      });
    } catch (error: any) {
      console.error("Error completing step 1:", {
        message: error.message,
        code: error.code,
        detail: error.detail,
        constraint: error.constraint,
        stack: error.stack,
      });
      res.status(500).json({
        success: false,
        message: "Failed to create AAC user profile",
      });
    }
  });

  // Complete Step 2: Create Schedule Entry
  app.post("/api/onboarding/complete-step-2", requireAuth, async (req, res) => {
    try {
      const currentUser = req.user as { id: string };
      const scheduleData = req.body;

      // Validate schedule data
      const validatedData = insertAacUserScheduleSchema.parse(scheduleData);

      // Create schedule entry
      const schedule = await storage.createScheduleEntry(validatedData);

      // Update user's onboarding step to 3 (complete)
      await storage.updateUserOnboardingStep(currentUser.id, 3);

      res.json({
        success: true,
        message: "Schedule entry created successfully",
        schedule,
        onboardingStep: 3,
      });
    } catch (error: any) {
      console.error("Error completing step 2:", error);
      res.status(500).json({
        success: false,
        message: "Failed to create schedule entry",
      });
    }
  });

  // Redeem invite code during onboarding
  app.post("/api/onboarding/redeem-code", requireAuth, async (req, res) => {
    try {
      const currentUser = req.user as { id: string };
      const { code } = req.body;

      console.log('Onboarding - Redeem code request:', {
        userId: currentUser.id,
        codeLength: code?.length,
      });

      if (!code || typeof code !== 'string') {
        return res.status(400).json({
          success: false,
          message: "Invite code is required",
          errorType: "validation_error",
        });
      }

      // Use existing redemption logic
      const result = await storage.redeemInviteCode(code.trim().toUpperCase(), currentUser.id);

      if (!result.success) {
        console.log('Onboarding - Code redemption failed:', result.error);
        return res.status(400).json({
          success: false,
          message: result.error || "Failed to redeem invite code",
          errorType: "redemption_failed",
        });
      }

      // Update user's onboarding step to 3 (complete) - bypass remaining steps
      await storage.updateUserOnboardingStep(currentUser.id, 3);
      console.log('Onboarding - Code redeemed successfully, onboarding completed');

      res.json({
        success: true,
        message: "Invite code redeemed successfully. Onboarding complete!",
        aacUser: result.aacUser,
        onboardingStep: 3,
      });
    } catch (error: any) {
      console.error("Error redeeming code during onboarding:", {
        message: error.message,
        stack: error.stack,
      });
      res.status(500).json({
        success: false,
        message: "Failed to redeem invite code",
        errorType: "server_error",
      });
    }
  });

  // ============= MAIN APPLICATION ROUTES =============

  // Interpret AAC communication
  app.post(
    "/api/interpret",
    optionalAuth,
    requireOnboardingComplete,
    upload.single("image"),
    async (req: Request & { file?: Express.Multer.File }, res) => {
      try {
        const currentUser = req.user as any;

        // Check credits if user is logged in
        if (currentUser) {
          const { hasCredits, credits } = await validateCredits(currentUser.id);
          if (!hasCredits) {
            return res.status(402).json({
              success: false,
              message: `You have ${credits} credits remaining. Please upgrade your plan to continue using the service.`,
              errorType: "insufficient_credits",
            });
          }
        }
        let requestData;
        let imageBase64 = null;

        if (req.file) {
          // Handle image upload
          imageBase64 = req.file.buffer.toString("base64");
          requestData = {
            input: req.body.input || "Image uploaded",
            inputType: "image",
            imageData: imageBase64,
          };
        } else {
          // Handle text input
          requestData = {
            input: req.body.input,
            inputType: "text",
          };
        }

        const validatedData = interpretRequestSchema.parse(requestData);
        const language = (req.body.language as "en" | "he") || "he";
        const context = req.body.context || null;
        const aacUserId = req.body.aacUserId || null;
        const aacUserAlias = req.body.aacUserAlias || null;

        let interpretationResult;
        let finalInput = validatedData.input;

        // Add context to input if provided
        if (context && validatedData.inputType === "text") {
          const contextHeader =
            language === "he"
              ? "\n\nהקשר נוסף:\n\n"
              : "\n\nAdditional context:\n";
          finalInput = validatedData.input + contextHeader + context;
        }

        // Get AAC user info if aacUserId is provided
        let aacUserInfo = null;
        let scheduleContext = "";
        if (aacUserId) {
          aacUserInfo = await storage.getAacUserByAacUserId(aacUserId);
          
          // Fetch current schedule context for time-based context enrichment
          const scheduleData = await storage.getCurrentScheduleContext(aacUserId, new Date());
          if (scheduleData.activityName) {
            const topicTags = scheduleData.topicTags && scheduleData.topicTags.length > 0
              ? ` (Topics: ${scheduleData.topicTags.join(", ")})`
              : "";
            scheduleContext = language === "he"
              ? `\n\nפעילות נוכחית: ${scheduleData.activityName}${topicTags}`
              : `\n\nCurrent activity: ${scheduleData.activityName}${topicTags}`;
          }
        }

        // Combine manual context with schedule context
        const enrichedContext = context 
          ? `${context}${scheduleContext}`
          : scheduleContext || undefined;

        if (validatedData.inputType === "image" && validatedData.imageData) {
          interpretationResult = await interpretAACImage(
            validatedData.imageData,
            language,
            enrichedContext,
            aacUserInfo,
            currentUser?.id,
            req.sessionID,
          );
        } else {
          interpretationResult = await interpretAACText(
            finalInput,
            language,
            enrichedContext,
            aacUserInfo,
            currentUser?.id,
            req.sessionID,
          );
        }

        // For images, use extracted text as the original input for display
        const displayInput =
          interpretationResult.extractedText || validatedData.input;

        // Save interpretation to storage
        const savedInterpretation = await storage.createInterpretation({
          userId: currentUser?.id || null,
          originalInput: displayInput,
          interpretedMeaning: interpretationResult.interpretedMeaning,
          analysis: interpretationResult.analysis,
          confidence: interpretationResult.confidence,
          suggestedResponse: interpretationResult.suggestedResponse,
          inputType: validatedData.inputType,
          language,
          context,
          imageData: imageBase64, // Store base64 image data for thumbnails and popups
          aacUserId,
          aacUserAlias,
        });

        // Deduct credit if user is logged in
        if (currentUser) {
          const creditDeducted = await deductCredit(
            currentUser.id,
            "AAC Interpretation",
          );
          if (!creditDeducted) {
            console.warn(`Failed to deduct credit for user ${currentUser.id}`);
          }
        }

        // Get updated user credits
        const updatedCredits = currentUser
          ? (await storage.getUser(currentUser.id))?.credits
          : null;

        res.json({
          success: true,
          interpretation: savedInterpretation,
          userCredits: updatedCredits,
          ...interpretationResult,
        });
      } catch (error: any) {
        console.error("Interpretation error:", error);

        // Handle model overloaded error with user-friendly message
        if (error instanceof Error && error.message === "MODEL_OVERLOADED") {
          res.status(503).json({
            success: false,
            message: "MODEL_OVERLOADED",
          });
          return;
        }

        res.status(500).json({
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Failed to interpret communication",
        });
      }
    },
  );

  // Get interpretation history - SECURED: Only returns current user's interpretations
  app.get("/api/interpretations", requireAuth, async (req, res) => {
    console.log("Fetching interpretation history for user:", req.user);
    try {
      const currentUser = req.user as { id: string };
      const limit = req.query.limit
        ? parseInt(req.query.limit as string)
        : undefined;
      const interpretations = await storage.getInterpretationsByUser(
        currentUser.id,
        limit,
      );
      res.json({ success: true, interpretations });
    } catch (error: any) {
      console.error("History fetch error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch interpretation history",
      });
    }
  });

  // Get specific interpretation
  app.get("/api/interpretations/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const interpretation = await storage.getInterpretation(id);

      if (!interpretation) {
        return res.status(404).json({
          success: false,
          message: "Interpretation not found",
        });
      }

      res.json({ success: true, interpretation });
    } catch (error: any) {
      console.error("Interpretation fetch error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch interpretation",
      });
    }
  });

  // Delete interpretation - SECURED: Only deletes current user's interpretations
  app.delete("/api/interpretations/:id", requireAuth, async (req, res) => {
    try {
      const currentUser = req.user as { id: string; isAdmin?: boolean };
      const id = req.params.id;

      // First verify the interpretation exists and get ownership info
      const interpretation = await storage.getInterpretation(id);
      if (!interpretation) {
        return res.status(404).json({
          success: false,
          message: "Interpretation not found",
        });
      }

      // Check ownership - only owner or admin can delete
      if (interpretation.userId !== currentUser.id && !currentUser.isAdmin) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied - not authorized to delete this interpretation",
        });
      }

      const success = await storage.deleteInterpretation(id);

      if (!success) {
        return res.status(500).json({
          success: false,
          message: "Failed to delete interpretation",
        });
      }

      res.json({
        success: true,
        message: "Interpretation deleted successfully",
      });
    } catch (error: any) {
      console.error("Interpretation deletion error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to delete interpretation",
      });
    }
  });

  // Get historical suggestions for AAC user
  app.post(
    "/api/historical-suggestions",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const { aacUserId, currentInput } = req.body;

        if (!aacUserId || !currentInput) {
          return res.status(400).json({
            success: false,
            message: "AAC user ID and current input are required",
          });
        }

        // Verify the AAC user belongs to the current user or is shared with them
        const aacUser = await storage.getAacUserByAacUserId(aacUserId);
        if (!aacUser) {
          return res.status(404).json({
            success: false,
            message: "AAC user not found",
          });
        }

        const currentUser = req.user as any;

        // Check if user owns this AAC user
        const userAacUsers = await storage.getAacUsersByUserId(currentUser.id);
        const hasAccess = userAacUsers.some((u) => u.aacUserId === aacUserId);

        if (!hasAccess) {
          return res.status(403).json({
            success: false,
            message: "Access denied - you don't have access to this AAC user",
          });
        }

        // Get historical suggestions
        const historicalAnalysis = await storage.analyzeHistoricalPatterns(
          aacUserId,
          currentInput,
        );

        res.json({
          success: true,
          suggestions: historicalAnalysis.suggestions,
          totalPatterns: historicalAnalysis.totalPatterns,
          aacUserAlias: aacUser.alias,
        });
      } catch (error: any) {
        console.error("Historical suggestions error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to analyze historical patterns",
        });
      }
    },
  );

  // ============= BOARD GENERATION ROUTES =============
  
  // Validation schemas
  const generateBoardSchema = z.object({
    prompt: z.string().min(1),
    gridSize: z.object({
      rows: z.number().min(1).max(10),
      cols: z.number().min(1).max(10)
    }).optional(),
    boardContext: any().optional(),
    currentPageId: z.string().optional()
  });

  const saveBoardSchema = z.object({
    name: z.string().min(1),
    irData: z.any()
  });

  const systemPromptSchema = z.object({
    prompt: z.string()
  });

    // Board generation endpoint
    app.post("/api/board/generate", requireAuth, async (req, res) => {
      const startTime = Date.now();
      try {
        const { prompt, gridSize, boardContext, currentPageId } =
        generateBoardSchema.parse(req.body);
        
        // Auto-detect analytics metadata
        const topic = analyticsService.detectTopic(prompt);
        const language = analyticsService.detectLanguage(prompt);
        const promptExcerpt = analyticsService.createExcerpt(prompt);
        
        // Create initial prompt record for API tracking
        const initialPromptRecord = await storage.logPrompt({
          userId: req.user!.id,
          prompt,
          promptExcerpt,
          topic,
          language,
          promptLength: prompt.length,
          generatedBoardName: "Generating...", // Temporary name
          pagesGenerated: 0,
          success: false, // Will update after generation
          processingTimeMs: 0
        });
        
        // Use AI for intelligent board generation with API tracking
        const parsedBoard = await boardGenerator.runBoardGeneration(
          prompt,
          gridSize,
          req.user!.id,
          initialPromptRecord.id,
          boardContext && currentPageId
            ? { boardContext, currentPageId }
            : undefined
        );
        
        const processingTime = Date.now() - startTime;
        
        // Update the prompt record with final results
        const promptRecord = await storage.logPrompt({
          userId: req.user!.id,
          prompt,
          promptExcerpt,
          topic,
          language,
          promptLength: prompt.length,
          generatedBoardName: parsedBoard.name,
          pagesGenerated: parsedBoard.pages ? parsedBoard.pages.length : 1,
          success: true,
          processingTimeMs: processingTime
        });
  
        // Track analytics events
        await analyticsService.trackEvent('prompt_created', req.user!.id, promptRecord.id);
        await analyticsService.trackEvent('board_generated', req.user!.id, promptRecord.id, {
          boardName: parsedBoard.name,
          pagesGenerated: parsedBoard.pages ? parsedBoard.pages.length : 1
        });
  
        if (parsedBoard.pages) {
          for (let i = 0; i < parsedBoard.pages.length; i++) {
            await analyticsService.trackEvent('board_page_created', req.user!.id, promptRecord.id, { pageIndex: i });
          }
        }
        
        // Check for auto-backup to Dropbox
        try {
          const { DropboxService } = await import("./services/dropboxService");
          // For auto-backup, we'll save the board as JSON initially
          // This can be improved later to generate proper .gridset files
          const dropboxService = new DropboxService();
          
          // Get user's Dropbox connection
          const userTokenResult = await dropboxService.getUserTokens(req.user!.id);
          
          if (userTokenResult) {
            const { accessToken, connection } = userTokenResult;
            
            // Check if auto-backup is enabled
            if (connection.autoBackupEnabled) {
              console.log(`Auto-backup enabled for user ${req.user!.id}, uploading board "${parsedBoard.name}"`);
              
              try {
                // For now, save board as JSON (can be improved to .gridset later)
                const boardJson = JSON.stringify(parsedBoard, null, 2);
                const fileBuffer = Buffer.from(boardJson, 'utf-8');
                const fileName = `${parsedBoard.name.replace(/[<>:"/\|?*]/g, '_')}.json`;
                
                // Generate file path
                const filePath = dropboxService.generateFilePath(connection.backupFolderPath, fileName);
                
                // Ensure folder exists
                await dropboxService.ensureFolderExists(accessToken, connection.backupFolderPath);
                
                // Upload file
                const uploadResult = await dropboxService.uploadFile(accessToken, filePath, fileBuffer);
                
                // Create shareable link
                const shareableUrl = await dropboxService.createShareableLink(accessToken, uploadResult.path);
                
                // Record backup in database
                const { db } = await import("./db");
                const { dropboxBackups } = await import("@shared/schema");
                await db.insert(dropboxBackups).values({
                  userId: req.user!.id,
                  boardName: parsedBoard.name,
                  fileType: 'master_aac',
                  fileName,
                  dropboxPath: filePath,
                  fileSizeBytes: fileBuffer.length,
                  status: 'completed',
                  shareableUrl
                });
                
                console.log(`Auto-backup completed: ${fileName} uploaded to ${filePath}`);
              } catch (backupError) {
                console.error('Auto-backup failed:', backupError);
                // Don't fail the entire request if backup fails
              }
            }
          }
        } catch (autoBackupError) {
          console.error('Auto-backup error:', autoBackupError);
          // Don't fail the entire request if backup fails
        }
        
        res.json(parsedBoard);
      } catch (error: any) {
        const processingTime = Date.now() - startTime;
        console.error("Board generation error:", error);
        
        // Log the failed prompt with analytics
        try {
          const topic = req.body.prompt ? analyticsService.detectTopic(req.body.prompt) : 'general';
          const language = req.body.prompt ? analyticsService.detectLanguage(req.body.prompt) : 'en';
          const promptExcerpt = req.body.prompt ? analyticsService.createExcerpt(req.body.prompt) : '';
          const errorType = analyticsService.categorizeError(error.message);
  
          const promptRecord = await storage.logPrompt({
            userId: req.user!.id,
            prompt: req.body.prompt || "Unknown prompt",
            promptExcerpt,
            topic,
            language,
            promptLength: req.body.prompt ? req.body.prompt.length : 0,
            success: false,
            errorMessage: error.message,
            errorType,
            processingTimeMs: processingTime
          });
  
          await analyticsService.trackEvent('prompt_created', req.user!.id, promptRecord.id);
          await analyticsService.trackEvent('error_occurred', req.user!.id, promptRecord.id, { errorType, errorMessage: error.message });
          
        } catch (logError) {
          console.error("Failed to log prompt error:", logError);
        }
        
        res.status(500).json({ error: "Failed to generate board. Please try again." });
      }
    });
  
    // Save board endpoint
    app.post("/api/board/save", requireAuth, async (req, res) => {
      try {
        const { name, irData } = saveBoardSchema.parse(req.body);
        
        const board = await storage.createBoard({
          userId: req.user!.id,
          name,
          irData
        });
        
        res.status(201).json(board);
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });
  
    // Get user's boards
    app.get("/api/boards", requireAuth, async (req, res) => {
      try {
        const boards = await storage.getUserBoards(req.user!.id);
        res.json(boards);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });
  
    // Get specific board
    app.get("/api/board/:id", requireAuth, async (req, res) => {
      try {
        const board = await storage.getBoard(req.params.id);
        if (!board || board.userId !== req.user!.id) {
          return res.status(404).json({ error: "Board not found" });
        }
        res.json(board);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });
  
    // Export endpoints
    app.post("/api/export/gridset", requireAuth, async (req, res) => {
      try {
        const { boardData, promptId } = req.body;
        
        // Track download analytics if promptId is provided
        if (promptId) {
          try {
            // Update prompt history to mark as downloaded
            await storage.markPromptAsDownloaded(promptId);
            
            // Track download event
            await analyticsService.trackEvent('board_downloaded', req.user!.id, promptId, {
              format: 'gridset',
              boardName: boardData.name
            });
          } catch (analyticsError) {
            console.error('Failed to track download analytics:', analyticsError);
          }
        }
        
        // Return the board data for client-side packaging
        res.json({ success: true, data: boardData });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });
  
    app.post("/api/export/snappkg", requireAuth, async (req, res) => {
      try {
        const { boardData, promptId } = req.body;
        
        // Track download analytics if promptId is provided
        if (promptId) {
          try {
            // Update prompt history to mark as downloaded
            await storage.markPromptAsDownloaded(promptId);
            
            // Track download event
            await analyticsService.trackEvent('board_downloaded', req.user!.id, promptId, {
              format: 'snappkg',
              boardName: boardData.name
            });
          } catch (analyticsError) {
            console.error('Failed to track download analytics:', analyticsError);
          }
        }
        
        // Return the board data for client-side packaging
        res.json({ success: true, data: boardData });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

  // ============= SLP CLINICAL DATA ROUTES =============
  
  // Get clinical data log with filtering
  app.get("/api/slp/clinical-log", requireSLPPlan, async (req, res) => {
    try {
      const currentUser = req.user as any;
      const { aacUserId, startDate, endDate } = req.query;
      
      const filters: {
        userId?: string;
        aacUserId?: string;
        startDate?: Date;
        endDate?: Date;
      } = {
        userId: currentUser.id
      };
      
      if (aacUserId && typeof aacUserId === 'string') {
        filters.aacUserId = aacUserId;
      }
      
      if (startDate && typeof startDate === 'string') {
        filters.startDate = new Date(startDate);
      }
      
      if (endDate && typeof endDate === 'string') {
        filters.endDate = new Date(endDate);
      }
      
      const data = await storage.getClinicalData(filters);
      
      res.json({
        success: true,
        data
      });
    } catch (error: any) {
      console.error("Clinical data fetch error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch clinical data"
      });
    }
  });
  
  // Get clinical metrics with aggregation
  app.get("/api/slp/clinical-metrics", requireSLPPlan, async (req, res) => {
    try {
      const currentUser = req.user as any;
      const { aacUserId, startDate, endDate } = req.query;
      
      const filters: {
        userId?: string;
        aacUserId?: string;
        startDate?: Date;
        endDate?: Date;
      } = {
        userId: currentUser.id
      };
      
      if (aacUserId && typeof aacUserId === 'string') {
        filters.aacUserId = aacUserId;
      }
      
      if (startDate && typeof startDate === 'string') {
        filters.startDate = new Date(startDate);
      }
      
      if (endDate && typeof endDate === 'string') {
        filters.endDate = new Date(endDate);
      }
      
      const metrics = await storage.getClinicalMetrics(filters);
      
      res.json({
        success: true,
        metrics
      });
    } catch (error: any) {
      console.error("Clinical metrics fetch error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch clinical metrics"
      });
    }
  });
  
  // Export clinical data as CSV
  app.get("/api/slp/export-csv", requireSLPPlan, async (req, res) => {
    try {
      const currentUser = req.user as any;
      const { aacUserId, startDate, endDate } = req.query;
      
      const filters: {
        userId?: string;
        aacUserId?: string;
        startDate?: Date;
        endDate?: Date;
      } = {
        userId: currentUser.id
      };
      
      if (aacUserId && typeof aacUserId === 'string') {
        filters.aacUserId = aacUserId;
      }
      
      if (startDate && typeof startDate === 'string') {
        filters.startDate = new Date(startDate);
      }
      
      if (endDate && typeof endDate === 'string') {
        filters.endDate = new Date(endDate);
      }
      
      const data = await storage.getClinicalData(filters);
      
      // Format data for CSV export
      const csvData = data.map(row => ({
        'Interpretation ID': row.id,
        'Date': row.createdAt.toISOString(),
        'AAC User ID': row.aacUserId || 'N/A',
        'AAC User Alias': row.aacUserAlias || 'N/A',
        'Original Input': row.originalInput,
        'Interpreted Meaning': row.interpretedMeaning,
        'Input Type': row.inputType,
        'Confidence Score': row.confidence,
        'WPM': row.aacUserWPM || 'N/A',
        'Caregiver Feedback': row.caregiverFeedback || 'No feedback',
        'Schedule Activity': row.scheduleActivity || 'N/A',
        'Language': row.language,
        'Context': row.context || 'N/A',
        'Suggested Response': row.suggestedResponse
      }));
      
      // Set up CSV headers
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="clinical-data-${Date.now()}.csv"`);
      
      // Create CSV stringifier and stream to response
      const stringifier = stringify(csvData, {
        header: true,
        columns: [
          'Interpretation ID',
          'Date',
          'AAC User ID',
          'AAC User Alias',
          'Original Input',
          'Interpreted Meaning',
          'Input Type',
          'Confidence Score',
          'WPM',
          'Caregiver Feedback',
          'Schedule Activity',
          'Language',
          'Context',
          'Suggested Response'
        ]
      });
      
      stringifier.pipe(res);
      stringifier.write(csvData);
      stringifier.end();
      
    } catch (error: any) {
      console.error("CSV export error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to export clinical data"
      });
    }
  });

  // ============= ADMIN ROUTES =============

  // CSRF protection middleware for admin routes
  const validateCSRF = (req: any, res: any, next: any) => {
    // Skip CSRF for GET requests (they should be safe)
    if (req.method === "GET") {
      return next();
    }

    // Strict same-origin enforcement
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const host = req.headers.host;
    const protocol = req.secure ? "https:" : "http:";
    const expectedOrigin = `${protocol}//${host}`;

    // Check Origin header (preferred)
    if (origin) {
      if (origin !== expectedOrigin) {
        return res.status(403).json({
          success: false,
          message: "CSRF protection: Invalid origin",
        });
      }
      return next();
    }

    // Fallback to Referer header
    if (referer) {
      try {
        const refererUrl = new URL(referer);
        const refererOrigin = `${refererUrl.protocol}//${refererUrl.host}`;
        if (refererOrigin !== expectedOrigin) {
          return res.status(403).json({
            success: false,
            message: "CSRF protection: Invalid referer",
          });
        }
        return next();
      } catch (error: any) {
        return res.status(403).json({
          success: false,
          message: "CSRF protection: Invalid referer format",
        });
      }
    }

    // Reject if neither Origin nor Referer present
    return res.status(403).json({
      success: false,
      message: "CSRF protection: Missing origin/referer headers",
    });
  };

  // Apply CSRF protection to all admin routes (except GET)
  app.use("/api/admin", (req: any, res: any, next: any) => {
    if (req.method === "GET") {
      return next();
    }
    return validateCSRF(req, res, next);
  });

  // Admin authentication middleware using regular user system
  const isAdminAuthenticated = (req: any, res: any, next: any) => {
    // Check if user is authenticated with regular user system
    if (!req.isAuthenticated() || !req.user) {
      return res
        .status(401)
        .json({ success: false, message: "Authentication required" });
    }

    // Check if user has admin privileges
    const user = req.user as any;
    if (!user.isAdmin && user.userType !== "admin") {
      return res
        .status(403)
        .json({ success: false, message: "Admin privileges required" });
    }

    return next();
  };

  // Admin authentication now uses regular user system
  // Admins log in through /login and /auth/google/callback

  // Get current admin user
  app.get(
    "/api/admin/auth/user",
    isAdminAuthenticated,
    async (req: any, res) => {
      try {
        const user = req.user as any;
        res.json({
          success: true,
          admin: true,
          user: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            fullName: user.fullName,
            userType: user.userType,
            isAdmin: user.isAdmin,
          },
        });
      } catch (error: any) {
        console.error("Error fetching admin user:", error);
        res.status(500).json({ message: "Failed to fetch user" });
      }
    },
  );

  // Dashboard stats
  app.get("/api/admin/stats", isAdminAuthenticated, async (req, res) => {
    try {
      const [usersStats, interpretationsStats] = await Promise.all([
        storage.getUsersStats(),
        storage.getInterpretationsStats(),
      ]);

      res.json({
        users: usersStats,
        interpretations: interpretationsStats,
      });
    } catch (error: any) {
      console.error("Error fetching stats:", error);
      res.status(500).json({ message: "Failed to fetch statistics" });
    }
  });

  // User management
  app.get("/api/admin/users", isAdminAuthenticated, async (req, res) => {
    try {
      const users = await storage.getAllUsers();

      // Fetch AAC users for each user
      const usersWithAacUsers = await Promise.all(
        users.map(async (user) => {
          const aacUsers = await storage.getAacUsersByUserId(user.id);
          return {
            ...user,
            aacUsers: aacUsers || [],
          };
        }),
      );

      res.json({ users: usersWithAacUsers });
    } catch (error: any) {
      console.error("Error fetching users:", error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  // Get specific user details
  app.get("/api/admin/users/:id", isAdminAuthenticated, async (req, res) => {
    try {
      const userId = req.params.id;
      const user = await storage.getUser(userId);

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      res.json({ user });
    } catch (error: any) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  app.patch("/api/admin/users/:id", isAdminAuthenticated, async (req, res) => {
    try {
      const id = req.params.id;
      const updates = req.body;

      // Validate the updates
      const allowedFields = [
        "firstName",
        "lastName",
        "email",
        "userType",
        "subscriptionType",
        "isActive",
      ];
      const validUserTypes = ["Parent", "Caregiver", "Teacher", "SLP", "admin"];
      const filteredUpdates: any = {};

      for (const field of allowedFields) {
        if (updates[field] !== undefined) {
          if (
            field === "userType" &&
            !validUserTypes.includes(updates[field])
          ) {
            return res.status(400).json({ message: "Invalid user type" });
          }
          filteredUpdates[field] = updates[field];
        }
      }

      // Update fullName if firstName or lastName changed
      if (
        filteredUpdates.firstName !== undefined ||
        filteredUpdates.lastName !== undefined
      ) {
        const user = await storage.getUser(id);
        if (user) {
          const firstName =
            filteredUpdates.firstName !== undefined
              ? filteredUpdates.firstName
              : user.firstName;
          const lastName =
            filteredUpdates.lastName !== undefined
              ? filteredUpdates.lastName
              : user.lastName;
          filteredUpdates.fullName =
            `${firstName || ""} ${lastName || ""}`.trim();
        }
      }

      const updatedUser = await storage.updateUser(id, filteredUpdates);

      if (!updatedUser) {
        return res.status(404).json({ message: "User not found" });
      }

      res.json({ success: true, user: updatedUser });
    } catch (error: any) {
      console.error("Error updating user:", error);
      res.status(500).json({ message: "Failed to update user" });
    }
  });

  // Delete user
  app.delete("/api/admin/users/:id", isAdminAuthenticated, async (req, res) => {
    try {
      const userId = req.params.id;

      // Check if user exists
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      // Delete the user and all related data
      const deleted = await storage.deleteUser(userId);

      if (deleted) {
        console.log(`User deleted: ${user.email} (ID: ${userId})`);
        res.json({
          success: true,
          message: "User deleted successfully",
        });
      } else {
        res.status(500).json({
          success: false,
          message: "Failed to delete user",
        });
      }
    } catch (error: any) {
      console.error("Error deleting user:", error);
      res.status(500).json({
        success: false,
        message: "Failed to delete user",
      });
    }
  });

  // Credits management
  app.post(
    "/api/admin/users/:id/credits",
    isAdminAuthenticated,
    async (req, res) => {
      try {
        const userId = req.params.id;
        const { amount, type, description, operation = "add" } = req.body;

        if (!amount || !description) {
          return res
            .status(400)
            .json({ message: "Amount and description are required" });
        }

        if (operation === "set") {
          await storage.setUserCredits(userId, amount, description);
        } else {
          if (!type) {
            return res
              .status(400)
              .json({ message: "Type is required for add operation" });
          }
          await storage.updateUserCredits(userId, amount, type, description);
        }

        res.json({ message: "Credits updated successfully" });
      } catch (error: any) {
        console.error("Error updating credits:", error);
        res.status(500).json({ message: "Failed to update credits" });
      }
    },
  );

  app.get(
    "/api/admin/users/:id/transactions",
    isAdminAuthenticated,
    async (req, res) => {
      try {
        const userId = req.params.id;
        const transactions = await storage.getUserCreditTransactions(userId);
        res.json({ transactions });
      } catch (error: any) {
        console.error("Error fetching transactions:", error);
        res.status(500).json({ message: "Failed to fetch transactions" });
      }
    },
  );

  // Check SMTP settings endpoint for admin
  app.get("/api/admin/smtp-check", isAdminAuthenticated, async (req, res) => {
    try {
      res.json({
        host: process.env.SMTP_HOST || "Not set",
        port: process.env.SMTP_PORT || "Not set",
        user: process.env.SMTP_USER || "Not set",
        from: process.env.SMTP_FROM || "Not set",
        configured: !!(
          process.env.SMTP_HOST &&
          process.env.SMTP_PORT &&
          process.env.SMTP_USER &&
          process.env.SMTP_PASS
        ),
      });
    } catch (error: any) {
      console.error("Error checking SMTP settings:", error);
      res.status(500).json({ message: "Failed to check SMTP settings" });
    }
  });

  // Test email endpoint for admin
  app.post("/api/admin/test-email", isAdminAuthenticated, async (req, res) => {
    try {
      const emailService = await import("./services/emailService");
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ message: "Email address required" });
      }

      // Generate a test token and send a test email
      const testToken = emailService.generateResetToken();
      const success = await emailService.sendPasswordResetEmail(
        email,
        testToken,
      );

      if (success) {
        res.json({
          success: true,
          message: "Reset email sent successfully to " + email,
        });
      } else {
        res.status(500).json({
          success: false,
          message: "Failed to send test email",
        });
      }
    } catch (error: any) {
      console.error("Error sending test email:", error);
      res.status(500).json({
        success: false,
        message: "Error sending test email: " + (error as Error).message,
      });
    }
  });

  // Get all interpretations for admin with user info
  app.get(
    "/api/admin/interpretations",
    isAdminAuthenticated,
    async (req, res) => {
      try {
        const limit = req.query.limit
          ? parseInt(req.query.limit as string)
          : undefined;
        const interpretations =
          await storage.getAllInterpretationsWithUsers(limit);
        res.json({ success: true, interpretations });
      } catch (error: any) {
        console.error("Admin interpretations fetch error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch interpretations",
        });
      }
    },
  );

  // Export interpretations to CSV for admin
  app.get(
    "/api/admin/interpretations/export",
    isAdminAuthenticated,
    async (req, res) => {
      try {
        const interpretations = await storage.getAllInterpretationsWithUsers();

        // CSV headers
        const headers = [
          "ID",
          "User Email",
          "User Name",
          "Original Input",
          "Interpreted Meaning",
          "Input Type",
          "Language",
          "AAC User ID",
          "AAC User Alias",
          "Context",
          "Confidence",
          "Analysis",
          "Suggested Response",
          "Created At",
        ];

        // Function to sanitize CSV cells to prevent CSV injection
        const sanitizeCSVCell = (value: string): string => {
          if (!value) return "";
          // Prevent CSV injection by escaping dangerous starting characters
          let sanitized = value.toString();
          if (/^[=+\-@]/.test(sanitized)) {
            sanitized = "'" + sanitized;
          }
          // Escape double quotes
          return `"${sanitized.replace(/"/g, '""')}"`;
        };

        // Convert interpretations to CSV rows
        const csvRows = interpretations.map((interpretation) => {
          const userEmail = interpretation.user?.email || "Unknown";
          const userName = interpretation.user?.fullName || "N/A";
          const analysisText = Array.isArray(interpretation.analysis)
            ? interpretation.analysis.join("; ")
            : "";

          return [
            interpretation.id,
            sanitizeCSVCell(userEmail),
            sanitizeCSVCell(userName),
            sanitizeCSVCell(interpretation.originalInput || ""),
            sanitizeCSVCell(interpretation.interpretedMeaning || ""),
            interpretation.inputType,
            interpretation.language || "",
            interpretation.aacUserId || "",
            sanitizeCSVCell(interpretation.aacUserAlias || ""),
            sanitizeCSVCell(interpretation.context || ""),
            interpretation.confidence,
            sanitizeCSVCell(analysisText),
            sanitizeCSVCell(interpretation.suggestedResponse || ""),
            new Date(interpretation.createdAt).toISOString(),
          ].join(",");
        });

        // Combine headers and rows with UTF-8 BOM for Excel compatibility
        const csvContent =
          "\uFEFF" + [headers.join(","), ...csvRows].join("\n");

        // Set response headers for CSV download
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="interpretations_${new Date().toISOString().split("T")[0]}.csv"`,
        );

        res.send(csvContent);
      } catch (error: any) {
        console.error("Admin interpretations export error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to export interpretations",
        });
      }
    },
  );

  // Get specific interpretation for admin
  app.get(
    "/api/admin/interpretations/:id",
    isAdminAuthenticated,
    async (req, res) => {
      try {
        const id = req.params.id;
        const interpretation = await storage.getInterpretation(id);

        if (!interpretation) {
          return res.status(404).json({
            success: false,
            message: "Interpretation not found",
          });
        }

        res.json({ success: true, interpretation });
      } catch (error: any) {
        console.error("Admin interpretation fetch error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch interpretation",
        });
      }
    },
  );

  // Subscription plans
  app.get(
    "/api/admin/subscription-plans",
    isAdminAuthenticated,
    async (req, res) => {
      try {
        const plans = await storage.getAllSubscriptionPlans();
        res.json({ plans });
      } catch (error: any) {
        console.error("Error fetching subscription plans:", error);
        res.status(500).json({ message: "Failed to fetch subscription plans" });
      }
    },
  );

  // System prompt management
  app.get("/api/admin/prompt", isAdminAuthenticated, async (req, res) => {
    try {
      console.log(
        "Admin prompt endpoint called - attempting to fetch system prompt",
      );
      const prompt = await storage.getSystemPrompt();
      console.log(
        "System prompt retrieved successfully, length:",
        prompt.length,
      );
      res.json({ success: true, prompt });
    } catch (error: any) {
      console.error("Error fetching system prompt:", error);
      console.error("Full error details:", JSON.stringify(error, null, 2));
      res.status(500).json({
        success: false,
        message: "Failed to fetch system prompt",
        error: error.message,
      });
    }
  });

  app.put("/api/admin/prompt", isAdminAuthenticated, async (req, res) => {
    try {
      console.log("Admin prompt update endpoint called");
      const { prompt } = req.body;
      if (!prompt || typeof prompt !== "string") {
        console.log("Invalid prompt data received:", { prompt: typeof prompt });
        return res
          .status(400)
          .json({ success: false, message: "Invalid prompt data" });
      }

      console.log("Attempting to update system prompt, length:", prompt.length);
      await storage.updateSystemPrompt(prompt);
      console.log("System prompt update completed successfully");
      res.json({
        success: true,
        message: "System prompt updated successfully",
      });
    } catch (error: any) {
      console.error("Error updating system prompt:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update system prompt",
        error: error.message,
      });
    }
  });

  // Admin settings endpoints
  app.get("/api/admin/settings/:key", isAdminAuthenticated, async (req, res) => {
    try {
      const { key } = req.params;
      console.log(`Admin settings GET endpoint called for key: ${key}`);
      
      const value = await storage.getSetting(key, '50'); // Default to 50 if not found
      console.log(`Setting ${key} retrieved:`, value);
      
      res.json({ success: true, value });
    } catch (error: any) {
      console.error(`Error fetching setting ${req.params.key}:`, error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch setting",
        error: error.message,
      });
    }
  });

  app.put("/api/admin/settings/:key", isAdminAuthenticated, async (req, res) => {
    try {
      const { key } = req.params;
      const { value } = req.body;
      
      console.log(`Admin settings PUT endpoint called for key: ${key}, value: ${value}`);
      
      if (value === undefined || value === null) {
        return res.status(400).json({ 
          success: false, 
          message: "Value is required" 
        });
      }

      await storage.updateSetting(key, value.toString());
      console.log(`Setting ${key} updated successfully`);
      
      res.json({
        success: true,
        message: "Setting updated successfully",
      });
    } catch (error: any) {
      console.error(`Error updating setting ${req.params.key}:`, error);
      res.status(500).json({
        success: false,
        message: "Failed to update setting",
        error: error.message,
      });
    }
  });

  // Serve credit purchase page
  app.get("/purchase-credits.html", (req, res) => {
    res.sendFile(path.join(process.cwd(), "client/purchase-credits.html"));
  });

  // Serve admin portal static files
  app.get("/admin*", (req, res) => {
    if (req.path.startsWith("/api/admin/")) {
      return; // Let API routes handle themselves
    }
    res.sendFile(path.join(process.cwd(), "admin/index.html"));
  });

  // ============= CREDIT PURCHASE ROUTES =============

  // Get Stripe configuration
  app.get("/api/stripe-config", (req, res) => {
    res.json({
      publicKey: process.env.VITE_STRIPE_PUBLIC_KEY,
    });
  });

  // Get available credit packages
  app.get("/api/credit-packages", async (req, res) => {
    try {
      const packages = await storage.getAllCreditPackages();
      res.json({ packages });
    } catch (error: any) {
      console.error("Error fetching credit packages:", error);
      res.status(500).json({ message: "Failed to fetch credit packages" });
    }
  });

  // Create payment intent for credit purchase
  app.post("/api/create-payment-intent", requireAuth, async (req, res) => {
    try {
      const { packageId } = req.body;
      const user = req.user as any;

      if (!packageId) {
        return res.status(400).json({ message: "Package ID is required" });
      }

      const creditPackage = await storage.getCreditPackage(packageId);
      if (!creditPackage) {
        return res.status(404).json({ message: "Credit package not found" });
      }

      // Create Stripe payment intent
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(creditPackage.price * 100), // Convert to cents
        currency: "usd",
        metadata: {
          userId: user.id.toString(),
          packageId: packageId.toString(),
          credits: creditPackage.credits.toString(),
          bonusCredits: creditPackage.bonusCredits.toString(),
        },
      });

      res.json({ clientSecret: paymentIntent.client_secret });
    } catch (error: any) {
      console.error("Error creating payment intent:", error);
      res
        .status(500)
        .json({ message: "Error creating payment intent: " + error.message });
    }
  });

  // Confirm payment and add credits
  app.post("/api/confirm-payment", requireAuth, async (req, res) => {
    try {
      const { paymentIntentId } = req.body;
      const user = req.user as any;

      if (!paymentIntentId) {
        return res
          .status(400)
          .json({ message: "Payment intent ID is required" });
      }

      // Retrieve payment intent from Stripe
      const paymentIntent =
        await stripe.paymentIntents.retrieve(paymentIntentId);

      if (paymentIntent.status !== "succeeded") {
        return res.status(400).json({ message: "Payment not completed" });
      }

      if (paymentIntent.metadata.userId !== user.id.toString()) {
        return res
          .status(403)
          .json({ message: "Payment intent does not belong to current user" });
      }

      const credits = parseInt(paymentIntent.metadata.credits);
      const bonusCredits = parseInt(paymentIntent.metadata.bonusCredits);
      const totalCredits = credits + bonusCredits;
      const packageId = parseInt(paymentIntent.metadata.packageId);

      // Add credits to user account
      await storage.updateUserCredits(
        user.id,
        totalCredits,
        "purchase",
        `Credit purchase: ${credits} credits${bonusCredits > 0 ? ` + ${bonusCredits} bonus credits` : ""} (Package ID: ${packageId})`,
        paymentIntentId,
      );

      // Get updated user data
      const updatedUser = await storage.getUser(user.id);

      res.json({
        success: true,
        message: "Credits added successfully",
        credits: updatedUser?.credits,
        creditsAdded: totalCredits,
      });
    } catch (error: any) {
      console.error("Error confirming payment:", error);
      res
        .status(500)
        .json({ message: "Error confirming payment: " + error.message });
    }
  });

  // ============= ADMIN CREDIT PACKAGE MANAGEMENT =============

  // Create credit package (admin only)
  app.post(
    "/api/admin/credit-packages",
    isAdminAuthenticated,
    async (req, res) => {
      try {
        const packageData = req.body;
        const creditPackage = await storage.createCreditPackage(packageData);
        res.json({ success: true, creditPackage });
      } catch (error: any) {
        console.error("Error creating credit package:", error);
        res.status(500).json({ message: "Failed to create credit package" });
      }
    },
  );

  // Get all credit packages for admin
  app.get(
    "/api/admin/credit-packages",
    isAdminAuthenticated,
    async (req, res) => {
      try {
        const packages = await storage.getAllCreditPackages();
        res.json({ packages });
      } catch (error: any) {
        console.error("Error fetching credit packages:", error);
        res.status(500).json({ message: "Failed to fetch credit packages" });
      }
    },
  );

  // Update credit package (admin only)
  app.patch(
    "/api/admin/credit-packages/:id",
    isAdminAuthenticated,
    async (req, res) => {
      try {
        const packageId = req.params.id;
        const updates = req.body;

        const updatedPackage = await storage.updateCreditPackage(
          packageId,
          updates,
        );

        if (!updatedPackage) {
          return res.status(404).json({ message: "Credit package not found" });
        }

        res.json({ success: true, creditPackage: updatedPackage });
      } catch (error: any) {
        console.error("Error updating credit package:", error);
        res.status(500).json({ message: "Failed to update credit package" });
      }
    },
  );

  // Delete credit package (admin only)
  app.delete(
    "/api/admin/credit-packages/:id",
    isAdminAuthenticated,
    async (req, res) => {
      try {
        const packageId = req.params.id;
        const success = await storage.deleteCreditPackage(packageId);

        if (!success) {
          return res.status(404).json({ message: "Credit package not found" });
        }

        res.json({
          success: true,
          message: "Credit package deleted successfully",
        });
      } catch (error: any) {
        console.error("Error deleting credit package:", error);
        res.status(500).json({ message: "Failed to delete credit package" });
      }
    },
  );

  // ============= API USAGE & COST TRACKING (ADMIN) =============

  // Get API usage statistics for admin dashboard
  app.get("/api/admin/usage-stats", isAdminAuthenticated, async (req, res) => {
    try {
      console.log("Admin API usage-stats: Starting request");
      const stats = await storage.getApiUsageStats();
      console.log("Admin API usage-stats: Got stats, sending response");
      return res.json({ success: true, stats });
    } catch (error: any) {
      console.error("Error fetching API usage stats:", error);
      return res
        .status(500)
        .json({ message: "Failed to fetch API usage statistics" });
    }
  });

  // Get API calls with pagination and filters
  app.get("/api/admin/api-calls", isAdminAuthenticated, async (req, res) => {
    try {
      const limitParam = parseInt(req.query.limit as string);
      const offsetParam = parseInt(req.query.offset as string);
      const providerIdParam = req.query.providerId
        ? req.query.providerId as string
        : undefined;

      // Validate query parameters
      if (
        (req.query.limit && isNaN(limitParam)) ||
        (req.query.offset && isNaN(offsetParam)) ||
        (req.query.providerId)
      ) {
        return res.status(400).json({
          message:
            "Invalid query parameters: limit and offset must be valid numbers, and providerId must be a valid string",
        });
      }

      const limit = Math.min(Math.max(limitParam || 50, 1), 1000);
      const offset = Math.max(offsetParam || 0, 0);
      const providerId = providerIdParam;

      // Get total count for pagination
      const totalCalls = await storage.getApiCallsCount(providerId);

      let apiCalls;
      if (providerId) {
        apiCalls = await storage.getApiCallsByProvider(
          providerId,
          limit,
          offset,
        );
      } else {
        apiCalls = await storage.getApiCalls(limit, offset);
      }

      res.json({
        success: true,
        apiCalls,
        pagination: {
          total: totalCalls,
          limit,
          offset,
          hasMore: offset + limit < totalCalls,
        },
      });
    } catch (error: any) {
      console.error("Error fetching API calls:", error);
      res.status(500).json({ message: "Failed to fetch API calls" });
    }
  });

  // Export API calls as CSV
  app.get(
    "/api/admin/api-calls/export",
    isAdminAuthenticated,
    async (req, res) => {
      try {
        const limitParam = parseInt(req.query.limit as string);
        const providerIdParam = req.query.providerId
          ? req.query.providerId as string
          : undefined;

        // Validate query parameters
        if (
          (req.query.limit && isNaN(limitParam)) ||
          (req.query.providerId)
        ) {
          return res.status(400).json({
            message:
              "Invalid query parameters: limit must be a valid number and providerId must be a valid string",
          });
        }

        const limit = Math.min(Math.max(limitParam || 10000, 1), 50000);
        const providerId = providerIdParam;

        let apiCalls;
        if (providerId) {
          apiCalls = await storage.getApiCallsByProvider(providerId, limit);
        } else {
          apiCalls = await storage.getApiCalls(limit);
        }

        // Helper function to escape CSV values
        const escapeCsv = (value: any): string => {
          if (value === null || value === undefined) return "";
          const str = String(value);
          if (str.includes(",") || str.includes('"') || str.includes("\n")) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        };

        // Generate CSV content with BOM for Excel compatibility
        const BOM = "\uFEFF";
        const csvHeaders =
          "ID,Provider ID,Model,Endpoint,Input Tokens,Output Tokens,Total Tokens,Units Used,Cost USD,Response Time (ms),User ID,Session ID,Created At\n";
        const csvRows = apiCalls
          .map((call) =>
            [
              call.id,
              call.providerId,
              call.model,
              call.endpoint,
              call.inputTokens,
              call.outputTokens,
              call.totalTokens,
              call.unitsUsed,
              call.totalCostUsd,
              call.responseTimeMs,
              call.userId,
              call.sessionId,
              call.createdAt,
            ]
              .map(escapeCsv)
              .join(","),
          )
          .join("\n");

        const csvContent = BOM + csvHeaders + csvRows;

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="api_calls_export.csv"',
        );
        res.send(csvContent);
      } catch (error: any) {
        console.error("Error exporting API calls:", error);
        res.status(500).json({ message: "Failed to export API calls" });
      }
    },
  );

  // Get API providers
  app.get(
    "/api/admin/api-providers",
    isAdminAuthenticated,
    async (req, res) => {
      try {
        console.log("Admin API api-providers: Starting request");
        const providers = await storage.getApiProviders();
        console.log("Admin API api-providers: Got providers, sending response");
        return res.json({ success: true, providers });
      } catch (error: any) {
        console.error("Error fetching API providers:", error);
        return res
          .status(500)
          .json({ message: "Failed to fetch API providers" });
      }
    },
  );

  // Create new API provider (admin only)
  app.post(
    "/api/admin/api-providers",
    isAdminAuthenticated,
    async (req, res) => {
      try {
        // Validate request body with Zod schema
        const validatedData = insertApiProviderSchemaWithValidation.parse(
          req.body,
        );
        const provider = await storage.createApiProvider(validatedData);
        res.json({ success: true, provider });
      } catch (error: any) {
        console.error("Error creating API provider:", error);
        if (
          error instanceof Error &&
          (error.name === "ZodError" || error.message.includes("validation"))
        ) {
          res
            .status(400)
            .json({ message: "Invalid provider data: " + error.message });
        } else {
          res.status(500).json({ message: "Failed to create API provider" });
        }
      }
    },
  );

  // Update API provider (admin only)
  app.patch(
    "/api/admin/api-providers/:id",
    isAdminAuthenticated,
    async (req, res) => {
      try {
        const providerId = req.params.id;

        // Validate partial updates
        const partialSchema = insertApiProviderSchemaWithValidation.partial();
        const validatedData = partialSchema.parse(req.body);

        const provider = await storage.updateApiProvider(
          providerId,
          validatedData,
        );

        if (!provider) {
          return res.status(404).json({ message: "API provider not found" });
        }

        res.json({ success: true, provider });
      } catch (error: any) {
        console.error("Error updating API provider:", error);
        if (
          error instanceof Error &&
          (error.name === "ZodError" || error.message.includes("validation"))
        ) {
          res
            .status(400)
            .json({ message: "Invalid provider data: " + error.message });
        } else {
          res.status(500).json({ message: "Failed to update API provider" });
        }
      }
    },
  );

  app.use("/api", (req, res, next) => {
    // Skip admin routes - let them be handled by their specific handlers
    if (req.path.startsWith("/admin")) {
      return next();
    }
    return res.status(404).json({ message: "API endpoint not found" });
  });

  app.use("/auth", (_req, res) => {
    res.status(404).json({ message: "Auth endpoint not found" });
  });

  const httpServer = createServer(app);
  return httpServer;
}
