import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import path from "path";
import { stringify } from "csv-stringify";

import {
  authController,
  profileController,
  studentController,
  inviteCodeController,
  savedLocationController,
  adminController,
  creditPackageController,
  interpretationController,
  boardController,
  onboardingController,
  slpClinicalController,
  programController,
  recordsController,
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

  // ============= IEP/TALA PROGRAM ROUTES =============
  
  // Overview & Dashboard
  app.get("/api/programs/overview", requireAuth, (req, res) =>
    programController.getOverview(req, res)
  );
  app.get("/api/programs/students", requireAuth, (req, res) =>
    programController.getStudentsWithPrograms(req, res)
  );

  // Program CRUD
  app.get("/api/programs/:id", requireAuth, (req, res) =>
    programController.getProgram(req, res)
  );
  app.get("/api/programs/:id/full", requireAuth, (req, res) =>
    programController.getProgramWithDetails(req, res)
  );
  app.patch("/api/programs/:id", requireAuth, (req, res) =>
    programController.updateProgram(req, res)
  );
  app.post("/api/programs/:id/activate", requireAuth, (req, res) =>
    programController.activateProgram(req, res)
  );
  app.post("/api/programs/:id/archive", requireAuth, (req, res) =>
    programController.archiveProgram(req, res)
  );
  app.delete("/api/programs/:id", requireAuth, (req, res) =>
    programController.deleteProgram(req, res)
  );

  // Student Programs
  app.get("/api/students/:studentId/programs", requireAuth, (req, res) =>
    programController.getStudentPrograms(req, res)
  );
  app.get("/api/students/:studentId/programs/current", requireAuth, (req, res) =>
    programController.getCurrentProgram(req, res)
  );
  app.post("/api/students/:studentId/programs", requireAuth, (req, res) =>
    programController.createProgram(req, res)
  );

  // Profile Domains
  app.get("/api/programs/:programId/domains", requireAuth, (req, res) =>
    programController.getProfileDomains(req, res)
  );
  app.post("/api/programs/:programId/domains", requireAuth, (req, res) =>
    programController.createProfileDomain(req, res)
  );
  app.patch("/api/domains/:id", requireAuth, (req, res) =>
    programController.updateProfileDomain(req, res)
  );
  app.delete("/api/domains/:id", requireAuth, (req, res) =>
    programController.deleteProfileDomain(req, res)
  );

  // Goals
  app.get("/api/programs/:programId/goals", requireAuth, (req, res) =>
    programController.getGoals(req, res)
  );
  app.post("/api/programs/:programId/goals", requireAuth, (req, res) =>
    programController.createGoal(req, res)
  );
  app.get("/api/goals/:id", requireAuth, (req, res) =>
    programController.getGoal(req, res)
  );
  app.patch("/api/goals/:id", requireAuth, (req, res) =>
    programController.updateGoal(req, res)
  );
  app.delete("/api/goals/:id", requireAuth, (req, res) =>
    programController.deleteGoal(req, res)
  );
  app.post("/api/goals/:id/achieve", requireAuth, (req, res) =>
    programController.achieveGoal(req, res)
  );

  // Objectives
  app.get("/api/goals/:goalId/objectives", requireAuth, (req, res) =>
    programController.getObjectives(req, res)
  );
  app.post("/api/goals/:goalId/objectives", requireAuth, (req, res) =>
    programController.createObjective(req, res)
  );
  app.patch("/api/objectives/:id", requireAuth, (req, res) =>
    programController.updateObjective(req, res)
  );
  app.delete("/api/objectives/:id", requireAuth, (req, res) =>
    programController.deleteObjective(req, res)
  );

  // Services
  app.get("/api/programs/:programId/services", requireAuth, (req, res) =>
    programController.getServices(req, res)
  );
  app.post("/api/programs/:programId/services", requireAuth, (req, res) =>
    programController.createService(req, res)
  );
  app.patch("/api/services/:id", requireAuth, (req, res) =>
    programController.updateService(req, res)
  );
  app.delete("/api/services/:id", requireAuth, (req, res) =>
    programController.deleteService(req, res)
  );

  // Data Points
  app.get("/api/goals/:goalId/data-points", requireAuth, (req, res) =>
    programController.getDataPoints(req, res)
  );
  app.post("/api/goals/:goalId/data-points", requireAuth, (req, res) =>
    programController.createDataPoint(req, res)
  );
  app.delete("/api/data-points/:id", requireAuth, (req, res) =>
    programController.deleteDataPoint(req, res)
  );

  // Progress Reports
  app.get("/api/programs/:programId/progress-reports", requireAuth, (req, res) =>
    programController.getProgressReports(req, res)
  );
  app.post("/api/programs/:programId/progress-reports", requireAuth, (req, res) =>
    programController.createProgressReport(req, res)
  );
  app.patch("/api/progress-reports/:id", requireAuth, (req, res) =>
    programController.updateProgressReport(req, res)
  );

  // Team Members
  app.get("/api/programs/:programId/team", requireAuth, (req, res) =>
    programController.getTeamMembers(req, res)
  );
  app.post("/api/programs/:programId/team", requireAuth, (req, res) =>
    programController.createTeamMember(req, res)
  );
  app.patch("/api/team-members/:id", requireAuth, (req, res) =>
    programController.updateTeamMember(req, res)
  );
  app.delete("/api/team-members/:id", requireAuth, (req, res) =>
    programController.deleteTeamMember(req, res)
  );

  // Meetings
  app.get("/api/programs/:programId/meetings", requireAuth, (req, res) =>
    programController.getMeetings(req, res)
  );
  app.post("/api/programs/:programId/meetings", requireAuth, (req, res) =>
    programController.createMeeting(req, res)
  );
  app.patch("/api/meetings/:id", requireAuth, (req, res) =>
    programController.updateMeeting(req, res)
  );
  app.delete("/api/meetings/:id", requireAuth, (req, res) =>
    programController.deleteMeeting(req, res)
  );

  // Compliance & Consents
  app.get("/api/programs/:programId/compliance", requireAuth, (req, res) =>
    programController.checkCompliance(req, res)
  );
  app.get("/api/programs/:programId/consents", requireAuth, (req, res) =>
    programController.getConsentForms(req, res)
  );
  app.post("/api/programs/:programId/consents", requireAuth, (req, res) =>
    programController.createConsentForm(req, res)
  );
  app.patch("/api/consents/:id", requireAuth, (req, res) =>
    programController.updateConsentForm(req, res)
  );

  // ============= STUDENTS ROUTES =============
  app.get("/api/students", requireAuth, (req, res) =>
    studentController.getStudents(req, res)
  );
  app.get("/api/students/:id", requireAuth, (req, res) =>
    studentController.getStudentById(req, res)
  );
  app.post("/api/students", requireAuth, (req, res) =>
    studentController.createStudent(req, res)
  );
  app.patch("/api/students/:id", requireAuth, (req, res) =>
    studentController.updateStudent(req, res)
  );
  app.delete("/api/students/:id", requireAuth, (req, res) =>
    studentController.deleteStudent(req, res)
  );

  // ============= MEDICAL RECORDS ROUTES =============
  
  // Get medical record for a student
  app.get("/api/students/:studentId/medical-record", requireAuth, (req, res) =>
    recordsController.getMedicalRecord(req, res)
  );
  
  // Create medical record for a student
  app.post("/api/students/:studentId/medical-record", requireAuth, (req, res) =>
    recordsController.createMedicalRecord(req, res)
  );
  
  // Update medical record
  app.patch("/api/medical-records/:id", requireAuth, (req, res) =>
    recordsController.updateMedicalRecord(req, res)
  );
  
  // Delete medical record (admin only)
  app.delete("/api/medical-records/:id", requireAuth, (req, res) =>
    recordsController.deleteMedicalRecord(req, res)
  );

  // ============= FUNCTIONAL REPORTS ROUTES =============
  
  // Get functional reports for a student
  app.get("/api/students/:studentId/functional-reports", requireAuth, (req, res) =>
    recordsController.getFunctionalReports(req, res)
  );
  
  // Get single functional report
  app.get("/api/functional-reports/:id", requireAuth, (req, res) =>
    recordsController.getFunctionalReport(req, res)
  );
  
  // Create functional report
  app.post("/api/students/:studentId/functional-reports", requireAuth, (req, res) =>
    recordsController.createFunctionalReport(req, res)
  );
  
  // Update functional report
  app.patch("/api/functional-reports/:id", requireAuth, (req, res) =>
    recordsController.updateFunctionalReport(req, res)
  );
  
  // Submit functional report for review
  app.post("/api/functional-reports/:id/submit", requireAuth, (req, res) =>
    recordsController.submitFunctionalReport(req, res)
  );
  
  // Finalize functional report
  app.post("/api/functional-reports/:id/finalize", requireAuth, (req, res) =>
    recordsController.finalizeFunctionalReport(req, res)
  );
  
  // Delete functional report
  app.delete("/api/functional-reports/:id", requireAuth, (req, res) =>
    recordsController.deleteFunctionalReport(req, res)
  );

  // ============= EDUCATIONAL REPORTS ROUTES =============
  
  // Get educational reports for a student
  app.get("/api/students/:studentId/educational-reports", requireAuth, (req, res) =>
    recordsController.getEducationalReports(req, res)
  );
  
  // Get single educational report
  app.get("/api/educational-reports/:id", requireAuth, (req, res) =>
    recordsController.getEducationalReport(req, res)
  );
  
  // Create educational report
  app.post("/api/students/:studentId/educational-reports", requireAuth, (req, res) =>
    recordsController.createEducationalReport(req, res)
  );
  
  // Update educational report
  app.patch("/api/educational-reports/:id", requireAuth, (req, res) =>
    recordsController.updateEducationalReport(req, res)
  );
  
  // Share educational report with guardians
  app.post("/api/educational-reports/:id/share", requireAuth, (req, res) =>
    recordsController.shareEducationalReport(req, res)
  );
  
  // Acknowledge educational report (guardian)
  app.post("/api/educational-reports/:id/acknowledge", requireAuth, (req, res) =>
    recordsController.acknowledgeEducationalReport(req, res)
  );
  
  // Finalize educational report
  app.post("/api/educational-reports/:id/finalize", requireAuth, (req, res) =>
    recordsController.finalizeEducationalReport(req, res)
  );
  
  // Delete educational report
  app.delete("/api/educational-reports/:id", requireAuth, (req, res) =>
    recordsController.deleteEducationalReport(req, res)
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

  // ============= INTERPRETATION ROUTES =============
  app.post(
    "/api/interpret",
    requireAuth,
    upload.single("photo"),
    (req, res) => interpretationController.interpret(req as any, res)
  );
  app.get("/api/interpretations", requireAuth, (req, res) =>
    interpretationController.getInterpretations(req, res)
  );
  app.get("/api/interpretations/:id", requireAuth, (req, res) =>
    interpretationController.getInterpretation(req, res)
  );
  app.delete("/api/interpretations/:id", requireAuth, (req, res) =>
    interpretationController.deleteInterpretation(req, res)
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

  // ============= BOARD GENERATION ROUTES =============
  app.post("/api/boards", requireAuth, (req, res) =>
    boardController.saveBoard(req, res)
  );

  app.get("/api/boards", requireAuth, (req, res) =>
    boardController.getUserBoards(req, res)
  );

  app.get("/api/boards/:id", requireAuth, (req, res) =>
    boardController.getBoard(req, res)
  );

  // Export endpoints
  app.post("/api/export/gridset", requireAuth, (req, res) =>
    boardController.exportGridset(req, res)
  );

  app.post("/api/export/snappkg", requireAuth, (req, res) =>
    boardController.exportSnappkg(req, res)
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

  // ============= CREDIT PACKAGE ROUTES =============
  app.get("/api/credit-packages", requireAuth, (req, res) =>
    creditPackageController.getCreditPackages(req, res)
  );

  // ============= CHAT ROUTES =============
  app.post("/api/chat", optionalAuth, requireOnboardingComplete, (req, res) =>
    chatController.onMessage(req, res)
  );

  // ============= ADMIN ROUTES =============
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
  app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { userRepository } = await import("./repositories/userRepository");
      const deleted = await userRepository.deleteUser(id);
      if (deleted) {
        res.json({ success: true, message: "User deleted successfully" });
      } else {
        res.status(404).json({ success: false, message: "User not found" });
      }
    } catch (error: any) {
      console.error("Admin delete user error:", error);
      res.status(500).json({ success: false, message: "Failed to delete user" });
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
          interpretation.studentId || "",
          sanitizeCSVCell(interpretation.studentName || ""),
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