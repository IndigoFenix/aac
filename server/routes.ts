import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import path from "path";
import { stringify } from "csv-stringify";

import {
  authController,
  profileController,
  aacUserController,
  inviteCodeController,
  savedLocationController,
  adminController,
  creditPackageController,
  interpretationController,
  boardController,
  onboardingController,
  slpClinicalController,
} from "./controllers";

import {
  requireAuth,
  optionalAuth,
  requireAdmin,
  requireSLPPlan,
  requireOnboardingComplete,
  validateCSRF,
} from "./middleware";

import { setupUserAuth } from "./userAuth"; // Keep existing passport setup
import { interpretationRepository, apiProviderRepository } from "./repositories";
import { chatController } from "./controllers/chatController";
import { studentProgressController } from "./controllers/studentProgressController";

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (
    req: Request,
    file: Express.Multer.File,
    cb: multer.FileFilterCallback
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

  // Setup user authentication (passport)
  await setupUserAuth(app);

  // ============= AUTH ROUTES =============
  app.post("/auth/register", (req, res) => authController.register(req, res));
  app.post("/auth/login", (req, res, next) => authController.login(req, res, next));
  app.post("/auth/logout", (req, res) => authController.logout(req, res));
  app.post("/auth/forgot-password", (req, res) => authController.forgotPassword(req, res));
  app.post("/auth/reset-password", (req, res) => authController.resetPassword(req, res));
  app.get("/auth/user", optionalAuth, (req, res) => authController.getCurrentUser(req, res));

  // Google OAuth routes (only if credentials are configured)
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    console.log("Setting up Google OAuth with credentials...");
    app.get("/auth/google", (req, res, next) => authController.googleAuth(req, res, next));
    app.get("/auth/google/callback", (req, res, next) => authController.googleCallback(req, res, next));
  } else {
    console.log("Google OAuth not configured - missing credentials");
    app.get("/auth/google", (req, res) => {
      res.status(501).json({
        success: false,
        message: "Google OAuth is not configured on this server",
      });
    });
  }

  // ============= PROFILE ROUTES =============
  app.post(
    "/api/profile/upload-image",
    requireAuth,
    upload.single("profileImage"),
    (req, res) => profileController.uploadImage(req as any, res)
  );
  app.patch("/api/profile/update", requireAuth, (req, res) =>
    profileController.updateProfile(req, res)
  );

  // ============= AAC USER ROUTES =============
  app.get("/api/aac-users", requireAuth, (req, res) =>
    aacUserController.getAacUsers(req, res)
  );
  app.get("/api/aac-users/:id", requireAuth, (req, res) =>
    aacUserController.getAacUserById(req, res)
  );
  app.post("/api/aac-users", requireAuth, (req, res) =>
    aacUserController.createAacUser(req, res)
  );
  app.patch("/api/aac-users/:id", requireAuth, (req, res) =>
    aacUserController.updateAacUser(req, res)
  );
  app.delete("/api/aac-users/:id", requireAuth, (req, res) =>
    aacUserController.deleteAacUser(req, res)
  );

  // ============= STUDENT PROGRESS ROUTES =============
  
  // Overview / Dashboard
  app.get("/api/students/overview", requireAuth, (req, res) =>
    studentProgressController.getOverview(req, res)
  );
  
  // Student list with progress summaries
  app.get("/api/students/list", requireAuth, (req, res) =>
    studentProgressController.getStudentsList(req, res)
  );
  
  // Full student progress data
  app.get("/api/students/:id/progress", requireAuth, (req, res) =>
    studentProgressController.getStudentProgress(req, res)
  );
  
  // Initialize progress tracking
  app.post("/api/students/:id/initialize-progress", requireAuth, (req, res) =>
    studentProgressController.initializeProgress(req, res)
  );
  
  // Phases
  app.get("/api/students/:id/phases", requireAuth, (req, res) =>
    studentProgressController.getPhases(req, res)
  );
  app.patch("/api/phases/:id", requireAuth, (req, res) =>
    studentProgressController.updatePhase(req, res)
  );
  app.post("/api/students/:id/advance-phase", requireAuth, (req, res) =>
    studentProgressController.advancePhase(req, res)
  );
  
  // Goals
  app.get("/api/students/:id/goals", requireAuth, (req, res) =>
    studentProgressController.getGoals(req, res)
  );
  app.post("/api/students/:id/goals", requireAuth, (req, res) =>
    studentProgressController.createGoal(req, res)
  );
  app.patch("/api/goals/:id", requireAuth, (req, res) =>
    studentProgressController.updateGoal(req, res)
  );
  app.delete("/api/goals/:id", requireAuth, (req, res) =>
    studentProgressController.deleteGoal(req, res)
  );
  app.post("/api/goals/:id/generate-statement", requireAuth, (req, res) =>
    studentProgressController.generateGoalStatement(req, res)
  );
  
  // Progress Entries
  app.get("/api/students/:id/progress-entries", requireAuth, (req, res) =>
    studentProgressController.getProgressEntries(req, res)
  );
  app.post("/api/students/:id/progress-entries", requireAuth, (req, res) =>
    studentProgressController.createProgressEntry(req, res)
  );
  
  // Compliance
  app.get("/api/students/:id/compliance", requireAuth, (req, res) =>
    studentProgressController.getComplianceItems(req, res)
  );
  app.patch("/api/compliance/:id", requireAuth, (req, res) =>
    studentProgressController.updateComplianceItem(req, res)
  );
  
  // Service Recommendations
  app.get("/api/students/:id/services", requireAuth, (req, res) =>
    studentProgressController.getServiceRecommendations(req, res)
  );
  app.post("/api/students/:id/services", requireAuth, (req, res) =>
    studentProgressController.createServiceRecommendation(req, res)
  );
  app.patch("/api/services/:id", requireAuth, (req, res) =>
    studentProgressController.updateServiceRecommendation(req, res)
  );
  app.delete("/api/services/:id", requireAuth, (req, res) =>
    studentProgressController.deleteServiceRecommendation(req, res)
  );
  
  // Baseline Metrics
  app.get("/api/students/:id/baseline", requireAuth, (req, res) =>
    studentProgressController.getBaselineMetrics(req, res)
  );
  app.post("/api/students/:id/baseline", requireAuth, (req, res) =>
    studentProgressController.recordBaselineMetrics(req, res)
  );

  // ============= SCHEDULE ROUTES =============
  app.get("/api/schedules/:aacUserId", requireAuth, (req, res) =>
    aacUserController.getSchedules(req, res)
  );
  app.post("/api/schedules", requireAuth, (req, res) =>
    aacUserController.createSchedule(req, res)
  );
  app.patch("/api/schedules/:id", requireAuth, (req, res) =>
    aacUserController.updateSchedule(req, res)
  );
  app.delete("/api/schedules/:id", requireAuth, (req, res) =>
    aacUserController.deleteSchedule(req, res)
  );
  app.get("/api/schedules/:aacUserId/context", requireAuth, (req, res) =>
    aacUserController.getScheduleContext(req, res)
  );

  // ============= SAVED LOCATIONS ROUTES =============
  app.get("/api/saved-locations", requireAuth, (req, res) =>
    savedLocationController.getSavedLocations(req, res)
  );
  app.post("/api/saved-locations", requireAuth, (req, res) =>
    savedLocationController.createSavedLocation(req, res)
  );
  app.delete("/api/saved-locations/:id", requireAuth, (req, res) =>
    savedLocationController.deleteSavedLocation(req, res)
  );

  // ============= INVITE CODE ROUTES =============
  app.post("/api/invite-codes", requireAuth, (req, res) =>
    inviteCodeController.createInviteCode(req, res)
  );
  app.get("/api/invite-codes", requireAuth, (req, res) =>
    inviteCodeController.getInviteCodes(req, res)
  );
  app.post("/api/invite-codes/redeem", requireAuth, (req, res) =>
    inviteCodeController.redeemInviteCode(req, res)
  );
  app.get("/api/invite-codes/redemptions", requireAuth, (req, res) =>
    inviteCodeController.getRedemptions(req, res)
  );
  app.patch("/api/invite-codes/:id/deactivate", requireAuth, (req, res) =>
    inviteCodeController.deactivateInviteCode(req, res)
  );

  // ============= ONBOARDING ROUTES =============
  app.get("/api/onboarding/status", requireAuth, (req, res) =>
    onboardingController.getStatus(req, res)
  );
  app.post("/api/onboarding/complete-step-1", requireAuth, (req, res) =>
    onboardingController.completeStep1(req, res)
  );
  app.post("/api/onboarding/complete-step-2", requireAuth, (req, res) =>
    onboardingController.completeStep2(req, res)
  );
  app.post("/api/onboarding/redeem-code", requireAuth, (req, res) =>
    onboardingController.redeemCode(req, res)
  );

  // ============= MAIN APPLICATION ROUTES (CHAT) =============
  app.post("/api/chat", optionalAuth, requireOnboardingComplete, (req, res) =>
    chatController.onMessage(req, res)
  );

  // ============= MAIN APPLICATION ROUTES (INTERPRETATION) =============
  app.post(
    "/api/interpret",
    optionalAuth,
    requireOnboardingComplete,
    upload.single("image"),
    (req, res) => interpretationController.interpret(req as any, res)
  );

  app.get("/api/interpretations", requireAuth, (req, res) =>
    interpretationController.getInterpretations(req, res)
  );

  app.get("/api/interpretations/:id", (req, res) =>
    interpretationController.getInterpretation(req, res)
  );

  app.delete("/api/interpretations/:id", requireAuth, (req, res) =>
    interpretationController.deleteInterpretation(req, res)
  );

  app.post("/api/historical-suggestions", requireAuth, (req, res) =>
    interpretationController.getHistoricalSuggestions(req, res)
  );

  // ============= BOARD GENERATION ROUTES =============
  app.post("/api/board/generate", requireAuth, (req, res) =>
    boardController.generateBoard(req, res)
  );

  app.post("/api/board/save", requireAuth, (req, res) =>
    boardController.saveBoard(req, res)
  );

  app.get("/api/boards", requireAuth, (req, res) =>
    boardController.getUserBoards(req, res)
  );

  app.get("/api/board/:id", requireAuth, (req, res) =>
    boardController.getBoard(req, res)
  );

  // Export endpoints
  app.post("/api/export/gridset", requireAuth, (req, res) =>
    boardController.exportGridset(req, res)
  );

  app.post("/api/export/snappkg", requireAuth, (req, res) =>
    boardController.exportSnappkg(req, res)
  );

  // ============= SLP CLINICAL DATA ROUTES =============
  app.get("/api/slp/clinical-log", requireSLPPlan, (req, res) =>
    slpClinicalController.getClinicalLog(req, res)
  );

  app.get("/api/slp/clinical-metrics", requireSLPPlan, (req, res) =>
    slpClinicalController.getClinicalMetrics(req, res)
  );

  app.get("/api/slp/export-csv", requireSLPPlan, (req, res) =>
    slpClinicalController.exportCsv(req, res)
  );

  // ============= CREDIT PURCHASE ROUTES =============
  app.get("/api/stripe-config", (req, res) =>
    creditPackageController.getStripeConfig(req, res)
  );
  app.get("/api/credit-packages", (req, res) =>
    creditPackageController.getCreditPackages(req, res)
  );
  app.post("/api/create-payment-intent", requireAuth, (req, res) =>
    creditPackageController.createPaymentIntent(req, res)
  );
  app.post("/api/confirm-payment", requireAuth, (req, res) =>
    creditPackageController.confirmPayment(req, res)
  );

  // ============= ADMIN ROUTES =============
  // Apply CSRF protection to all admin routes (except GET)
  app.use("/api/admin", (req, res, next) => {
    if (req.method === "GET") {
      return next();
    }
    return validateCSRF(req, res, next);
  });

  // Admin auth
  app.get("/api/admin/auth/user", requireAdmin, (req, res) =>
    adminController.getCurrentAdmin(req, res)
  );

  // Dashboard
  app.get("/api/admin/stats", requireAdmin, (req, res) =>
    adminController.getStats(req, res)
  );

  // Users
  app.get("/api/admin/users", requireAdmin, (req, res) =>
    adminController.getUsers(req, res)
  );
  app.get("/api/admin/users/:id", requireAdmin, (req, res) =>
    adminController.getUser(req, res)
  );
  app.patch("/api/admin/users/:id", requireAdmin, (req, res) =>
    adminController.updateUser(req, res)
  );
  app.delete("/api/admin/users/:id", requireAdmin, (req, res) =>
    adminController.deleteUser(req, res)
  );

  // Credits
  app.post("/api/admin/users/:id/credits", requireAdmin, (req, res) =>
    adminController.updateCredits(req, res)
  );
  app.get("/api/admin/users/:id/transactions", requireAdmin, (req, res) =>
    adminController.getUserTransactions(req, res)
  );

  // SMTP check
  app.get("/api/admin/smtp-check", requireAdmin, async (req, res) => {
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

  // Test email
  app.post("/api/admin/test-email", requireAdmin, async (req, res) => {
    try {
      const emailService = await import("./services/emailService");
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ message: "Email address required" });
      }

      const testToken = emailService.generateResetToken();
      const success = await emailService.sendPasswordResetEmail(email, testToken);

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

  // System prompt
  app.get("/api/admin/prompt", requireAdmin, (req, res) =>
    adminController.getSystemPrompt(req, res)
  );
  app.put("/api/admin/prompt", requireAdmin, (req, res) =>
    adminController.updateSystemPrompt(req, res)
  );

  // Settings
  app.get("/api/admin/settings/:key", requireAdmin, (req, res) =>
    adminController.getSetting(req, res)
  );
  app.put("/api/admin/settings/:key", requireAdmin, (req, res) =>
    adminController.updateSetting(req, res)
  );

  // Subscription plans
  app.get("/api/admin/subscription-plans", requireAdmin, (req, res) =>
    adminController.getSubscriptionPlans(req, res)
  );

  // Interpretations
  app.get("/api/admin/interpretations", requireAdmin, (req, res) =>
    adminController.getInterpretations(req, res)
  );
  app.get("/api/admin/interpretations/:id", requireAdmin, (req, res) =>
    adminController.getInterpretation(req, res)
  );

  // Export interpretations to CSV for admin
  app.get("/api/admin/interpretations/export", requireAdmin, async (req, res) => {
    try {
      const interpretations = await interpretationRepository.getAllInterpretationsWithUsers();

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

      const sanitizeCSVCell = (value: string): string => {
        if (!value) return "";
        let sanitized = value.toString();
        if (/^[=+\-@]/.test(sanitized)) {
          sanitized = "'" + sanitized;
        }
        return `"${sanitized.replace(/"/g, '""')}"`;
      };

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
          sanitizeCSVCell(interpretation.aacUserName || ""),
          sanitizeCSVCell(interpretation.context || ""),
          interpretation.confidence,
          sanitizeCSVCell(analysisText),
          sanitizeCSVCell(interpretation.suggestedResponse || ""),
          new Date(interpretation.createdAt).toISOString(),
        ].join(",");
      });

      const csvContent = "\uFEFF" + [headers.join(","), ...csvRows].join("\n");

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="interpretations_${new Date().toISOString().split("T")[0]}.csv"`
      );

      res.send(csvContent);
    } catch (error: any) {
      console.error("Admin interpretations export error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to export interpretations",
      });
    }
  });

  // API usage
  app.get("/api/admin/usage-stats", requireAdmin, (req, res) =>
    adminController.getUsageStats(req, res)
  );
  app.get("/api/admin/api-calls", requireAdmin, (req, res) =>
    adminController.getApiCalls(req, res)
  );

  // Export API calls as CSV
  app.get("/api/admin/api-calls/export", requireAdmin, async (req, res) => {
    try {
      const limitParam = parseInt(req.query.limit as string);
      const providerIdParam = req.query.providerId as string | undefined;

      if (req.query.limit && isNaN(limitParam)) {
        return res.status(400).json({
          message: "Invalid query parameters: limit must be a valid number",
        });
      }

      const limit = Math.min(Math.max(limitParam || 10000, 1), 50000);

      let apiCalls;
      if (providerIdParam) {
        apiCalls = await apiProviderRepository.getApiCallsByProvider(providerIdParam, limit);
      } else {
        apiCalls = await apiProviderRepository.getApiCalls(limit);
      }

      const escapeCsv = (value: any): string => {
        if (value === null || value === undefined) return "";
        const str = String(value);
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

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
            .join(",")
        )
        .join("\n");

      const csvContent = BOM + csvHeaders + csvRows;

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="api_calls_export.csv"'
      );
      res.send(csvContent);
    } catch (error: any) {
      console.error("Error exporting API calls:", error);
      res.status(500).json({ message: "Failed to export API calls" });
    }
  });

  // API providers
  app.get("/api/admin/api-providers", requireAdmin, (req, res) =>
    adminController.getApiProviders(req, res)
  );
  app.post("/api/admin/api-providers", requireAdmin, (req, res) =>
    adminController.createApiProvider(req, res)
  );
  app.patch("/api/admin/api-providers/:id", requireAdmin, (req, res) =>
    adminController.updateApiProvider(req, res)
  );

  // Credit packages (admin)
  app.get("/api/admin/credit-packages", requireAdmin, (req, res) =>
    creditPackageController.getCreditPackages(req, res)
  );
  app.post("/api/admin/credit-packages", requireAdmin, (req, res) =>
    creditPackageController.createCreditPackage(req, res)
  );
  app.patch("/api/admin/credit-packages/:id", requireAdmin, (req, res) =>
    creditPackageController.updateCreditPackage(req, res)
  );
  app.delete("/api/admin/credit-packages/:id", requireAdmin, (req, res) =>
    creditPackageController.deleteCreditPackage(req, res)
  );

  // ============= STATIC FILES =============
  app.get("/purchase-credits.html", (req, res) => {
    res.sendFile(path.join(process.cwd(), "client/purchase-credits.html"));
  });

  app.get("/admin*", (req, res) => {
    if (req.path.startsWith("/api/admin/")) {
      return; // Let API routes handle themselves
    }
    res.sendFile(path.join(process.cwd(), "admin/index.html"));
  });

  // ============= FALLBACK ROUTES =============
  app.use("/api", (req, res, next) => {
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
