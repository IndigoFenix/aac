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
  instituteController,
  classroomController
} from "./controllers";

import {
  requireAuth,
  optionalAuth,
  requireAdmin,
  requireSystemAdmin,
  requireSLPPlan,
  requireOnboardingComplete,
  validateCSRF,
} from "./middleware";

import { setupUserAuth } from "./userAuth"; // Keep existing passport setup
import { interpretationRepository, apiProviderRepository } from "./repositories";
import { chatController } from "./controllers/chatController";
import { chatStreamController } from "./controllers/chatStreamController";
import { reportController } from "./controllers/reportController";
import { fileUploadController } from "./controllers/fileUploadController";
import { personaController } from "./controllers/personaController";
import { topicController } from "./controllers/topicController";
import { voiceController } from "./controllers/voiceController";
import { dualAgentController } from "./controllers/dualAgentController";
import { biometricController } from "./controllers/biometricController";

// Configure multer for image uploads
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

// Configure multer for chat file uploads (various file types)
const chatFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB limit
});

// Configure multer for AAC uploads (images and audio)
const aacUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB limit
  fileFilter: (
    req: Request,
    file: Express.Multer.File,
    cb: multer.FileFilterCallback
  ) => {
    // Accept images and audio files
    if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("audio/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image and audio files are allowed"));
    }
  },
});

export async function registerRoutes(app: Express): Promise<Server> {
  // Set trust proxy for rate limiting behind proxies
  app.set("trust proxy", 1);

  // Setup user authentication (passport)
  await setupUserAuth(app);

  // ============ HEALTH CHECK =============
  app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ============= AUTH ROUTES =============
  app.post("/auth/register", (req, res) => authController.register(req, res));
  app.post("/auth/login", (req, res, next) => authController.login(req, res, next));
  app.post("/auth/logout", (req, res) => authController.logout(req, res));
  app.post("/auth/reset-password", (req, res) => authController.resetPassword(req, res));// Request password reset (sends email)
  app.post("/auth/forgot-password", (req, res) =>
    authController.forgotPassword(req, res)
  );
  // Validate reset token (check if valid before showing form)
  app.get("/auth/reset-password/:token", (req, res) => authController.validateResetToken(req, res));
  
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

  // ============= MFA ROUTES =============
  // MFA status (requires auth)
  app.get("/auth/mfa/status", requireAuth, (req, res) =>
    authController.mfaStatus(req, res)
  );
  // MFA setup (requires auth)
  app.post("/auth/mfa/setup", requireAuth, (req, res) =>
    authController.mfaSetup(req, res)
  );
  // MFA setup with token (for enforced setup during login)
  app.post("/auth/mfa/setup-with-token", (req, res) =>
    authController.mfaSetupWithToken(req, res)
  );
  // MFA verify setup (requires auth)
  app.post("/auth/mfa/verify-setup", requireAuth, (req, res) =>
    authController.mfaVerifySetup(req, res)
  );
  // MFA verify setup with token (for enforced setup during login)
  app.post("/auth/mfa/verify-setup-with-token", (req, res) =>
    authController.mfaVerifySetupWithToken(req, res)
  );
  // MFA disable (requires auth)
  app.post("/auth/mfa/disable", requireAuth, (req, res) =>
    authController.mfaDisable(req, res)
  );
  // MFA verify during login (public, uses mfaToken)
  app.post("/auth/mfa/verify", (req, res) =>
    authController.mfaVerify(req, res)
  );
  // MFA recovery request (public)
  app.post("/auth/mfa/recovery/request", (req, res) =>
    authController.mfaRecoveryRequest(req, res)
  );
  // MFA recovery validate (public)
  app.get("/auth/mfa/recovery/:token", (req, res) =>
    authController.mfaRecoveryValidate(req, res)
  );
  // MFA recovery complete (public)
  app.post("/auth/mfa/recovery/complete", (req, res) =>
    authController.mfaRecoveryComplete(req, res)
  );

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

  // ============= INSTITUTE ROUTES =============
  
  // Institute CRUD
  app.get("/api/institutes", requireAuth, (req, res) =>
    instituteController.getInstitutes(req, res)
  );
  app.get("/api/institutes/:id", requireAuth, (req, res) =>
    instituteController.getInstitute(req, res)
  );
  app.post("/api/institutes", requireAuth, (req, res) =>
    instituteController.createInstitute(req, res)
  );
  app.patch("/api/institutes/:id", requireAuth, (req, res) =>
    instituteController.updateInstitute(req, res)
  );
  app.delete("/api/institutes/:id", requireAuth, (req, res) =>
    instituteController.deleteInstitute(req, res)
  );
  
  // Institute Members
  app.get("/api/institutes/:id/members", requireAuth, (req, res) =>
    instituteController.getMembers(req, res)
  );
  app.patch("/api/institutes/:id/members/:userId", requireAuth, (req, res) =>
    instituteController.updateMember(req, res)
  );
  app.delete("/api/institutes/:id/members/:userId", requireAuth, (req, res) =>
    instituteController.removeMember(req, res)
  );
  app.post("/api/institutes/:id/leave", requireAuth, (req, res) =>
    instituteController.leaveInstitute(req, res)
  );
  
  // Institute Invites (admin actions)
  app.post("/api/institutes/:id/invites", requireAuth, (req, res) =>
    instituteController.sendInvite(req, res)
  );
  app.get("/api/institutes/:id/invites", requireAuth, (req, res) =>
    instituteController.getInvites(req, res)
  );
  app.delete("/api/institutes/:id/invites/:inviteId", requireAuth, (req, res) =>
    instituteController.cancelInvite(req, res)
  );
  app.post("/api/institutes/:id/invites/:inviteId/resend", requireAuth, (req, res) =>
    instituteController.resendInvite(req, res)
  );

  // Institute student routes
  app.get('/api/institutes/:id/students', requireAuth, instituteController.getStudents.bind(instituteController));
  app.post('/api/institutes/:id/students', requireAuth, instituteController.addStudent.bind(instituteController));
  app.patch('/api/institutes/:id/students/:studentId', requireAuth, instituteController.updateStudent.bind(instituteController));
  app.delete('/api/institutes/:id/students/:studentId', requireAuth, instituteController.removeStudent.bind(instituteController));

  // Student institutes route
  app.get('/api/students/:studentId/institutes', requireAuth, instituteController.getStudentInstitutes.bind(instituteController));

  // Classroom routes
  app.get('/api/institutes/:instituteId/classrooms', requireAuth, classroomController.getClassrooms.bind(classroomController));
  app.post('/api/institutes/:instituteId/classrooms', requireAuth, classroomController.createClassroom.bind(classroomController));
  app.get('/api/classrooms/:classroomId', requireAuth, classroomController.getClassroom.bind(classroomController));
  app.patch('/api/classrooms/:classroomId', requireAuth, classroomController.updateClassroom.bind(classroomController));
  app.delete('/api/classrooms/:classroomId', requireAuth, classroomController.deleteClassroom.bind(classroomController));

  // Classroom member routes
  app.get('/api/classrooms/:classroomId/members', requireAuth, classroomController.getMembers.bind(classroomController));
  app.post('/api/classrooms/:classroomId/members', requireAuth, classroomController.addMember.bind(classroomController));
  app.patch('/api/classrooms/:classroomId/members/:userId', requireAuth, classroomController.updateMember.bind(classroomController));
  app.delete('/api/classrooms/:classroomId/members/:userId', requireAuth, classroomController.removeMember.bind(classroomController));

  // Classroom student routes
  app.get('/api/classrooms/:classroomId/students', requireAuth, classroomController.getStudents.bind(classroomController));
  app.post('/api/classrooms/:classroomId/students', requireAuth, classroomController.addStudent.bind(classroomController));
  app.patch('/api/classrooms/:classroomId/students/:studentId', requireAuth, classroomController.updateStudent.bind(classroomController));
  app.delete('/api/classrooms/:classroomId/students/:studentId', requireAuth, classroomController.removeStudent.bind(classroomController));

  // User's classrooms
  app.get('/api/users/me/classrooms', requireAuth, classroomController.getMyClassrooms.bind(classroomController));

  // ============= PERSONA ROUTES =============
  // Admin routes (system admin only)
  app.get('/api/admin/personas', requireAuth, requireSystemAdmin, personaController.getPersonas.bind(personaController));
  app.post('/api/admin/personas', requireAuth, requireSystemAdmin, personaController.createPersona.bind(personaController));
  app.get('/api/admin/personas/:id', requireAuth, requireSystemAdmin, personaController.getPersona.bind(personaController));
  app.patch('/api/admin/personas/:id', requireAuth, requireSystemAdmin, personaController.updatePersona.bind(personaController));
  app.delete('/api/admin/personas/:id', requireAuth, requireSystemAdmin, personaController.deletePersona.bind(personaController));

  // User routes (any authenticated user)
  app.get('/api/personas/selectable', requireAuth, personaController.getSelectablePersonas.bind(personaController));

  // ============= TOPIC/LIBRARY ROUTES =============
  // Admin routes (system admin only)
  app.get('/api/admin/topics', requireAuth, requireSystemAdmin, topicController.getTopics.bind(topicController));
  app.post('/api/admin/topics', requireAuth, requireSystemAdmin, topicController.createTopic.bind(topicController));
  app.get('/api/admin/topics/:id', requireAuth, requireSystemAdmin, topicController.getTopic.bind(topicController));
  app.patch('/api/admin/topics/:id', requireAuth, requireSystemAdmin, topicController.updateTopic.bind(topicController));
  app.delete('/api/admin/topics/:id', requireAuth, requireSystemAdmin, topicController.deleteTopic.bind(topicController));

  // User routes (any authenticated user - active topics only)
  app.get('/api/topics', requireAuth, topicController.getActiveTopics.bind(topicController));
  app.get('/api/topics/:id', requireAuth, topicController.getActiveTopic.bind(topicController));

  // User's Pending Invites
  app.get("/api/invites/pending", requireAuth, (req, res) =>
    instituteController.getPendingInvites(req, res)
  );
  app.post("/api/invites/:inviteId/accept", requireAuth, (req, res) =>
    instituteController.acceptInvite(req, res)
  );
  app.post("/api/invites/:inviteId/decline", requireAuth, (req, res) =>
    instituteController.declineInvite(req, res)
  );
  
  // Public Invite Routes (for signup via invite link)
  app.get("/api/invites/token/:token", (req, res) =>
    instituteController.getInviteByToken(req, res)
  );
  app.post("/api/invites/token/:token/accept", requireAuth, (req, res) =>
    instituteController.acceptInviteByToken(req, res)
  );
  app.post("/api/invites/token/:token/register", (req, res) =>
    instituteController.registerWithInvite(req, res)
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

  // ==========================================================================
  // COMPOSITE ENDPOINTS (must come before specific type endpoints)
  // ==========================================================================

  // Get all reports for a student
  app.get(
    "/api/students/:studentId/reports",
    requireAuth,
    (req, res) => reportController.getAllReports(req, res)
  );

  // Get current (non-archived) reports for a student
  app.get(
    "/api/students/:studentId/reports/current",
    requireAuth,
    (req, res) => reportController.getCurrentReports(req, res)
  );

  // ==========================================================================
  // MEDICAL RECORD ENDPOINTS
  // ==========================================================================

  // Get all medical records for a student
  app.get(
    "/api/students/:studentId/reports/medical",
    requireAuth,
    (req, res) => reportController.getMedicalRecords(req, res)
  );

  // Get current medical record for a student
  app.get(
    "/api/students/:studentId/reports/medical/current",
    requireAuth,
    (req, res) => reportController.getCurrentMedicalRecord(req, res)
  );

  // Get archived medical records for a student
  app.get(
    "/api/students/:studentId/reports/medical/archived",
    requireAuth,
    (req, res) => reportController.getArchivedMedicalRecords(req, res)
  );

  // Create a new medical record for a student
  app.post(
    "/api/students/:studentId/reports/medical",
    requireAuth,
    (req, res) => reportController.createMedicalRecord(req, res)
  );

  // Get a specific medical record by ID
  app.get(
    "/api/medical-records/:id",
    requireAuth,
    (req, res) => reportController.getMedicalRecordById(req, res)
  );

  // Update a medical record
  app.patch(
    "/api/medical-records/:id",
    requireAuth,
    (req, res) => reportController.updateMedicalRecord(req, res)
  );

  // Finalize a medical record
  app.post(
    "/api/medical-records/:id/finalize",
    requireAuth,
    (req, res) => reportController.finalizeMedicalRecord(req, res)
  );

  // Create a revision of a medical record
  app.post(
    "/api/medical-records/:id/revision",
    requireAuth,
    (req, res) => reportController.createMedicalRecordRevision(req, res)
  );

  // Delete a medical record (draft only)
  app.delete(
    "/api/medical-records/:id",
    requireAuth,
    (req, res) => reportController.deleteMedicalRecord(req, res)
  );

  // ==========================================================================
  // FUNCTIONAL REPORT ENDPOINTS
  // ==========================================================================

  // Get all functional reports for a student
  app.get(
    "/api/students/:studentId/reports/functional",
    requireAuth,
    (req, res) => reportController.getFunctionalReports(req, res)
  );

  // Get current functional report for a student
  app.get(
    "/api/students/:studentId/reports/functional/current",
    requireAuth,
    (req, res) => reportController.getCurrentFunctionalReport(req, res)
  );

  // Get archived functional reports for a student
  app.get(
    "/api/students/:studentId/reports/functional/archived",
    requireAuth,
    (req, res) => reportController.getArchivedFunctionalReports(req, res)
  );

  // Create a new functional report for a student
  app.post(
    "/api/students/:studentId/reports/functional",
    requireAuth,
    (req, res) => reportController.createFunctionalReport(req, res)
  );

  // Get a specific functional report by ID
  app.get(
    "/api/functional-reports/:id",
    requireAuth,
    (req, res) => reportController.getFunctionalReportById(req, res)
  );

  // Update a functional report
  app.patch(
    "/api/functional-reports/:id",
    requireAuth,
    (req, res) => reportController.updateFunctionalReport(req, res)
  );

  // Finalize a functional report
  app.post(
    "/api/functional-reports/:id/finalize",
    requireAuth,
    (req, res) => reportController.finalizeFunctionalReport(req, res)
  );

  // Create a revision of a functional report
  app.post(
    "/api/functional-reports/:id/revision",
    requireAuth,
    (req, res) => reportController.createFunctionalReportRevision(req, res)
  );

  // Delete a functional report (draft only)
  app.delete(
    "/api/functional-reports/:id",
    requireAuth,
    (req, res) => reportController.deleteFunctionalReport(req, res)
  );

  // ==========================================================================
  // EDUCATIONAL REPORT ENDPOINTS
  // ==========================================================================

  // Get all educational reports for a student
  app.get(
    "/api/students/:studentId/reports/educational",
    requireAuth,
    (req, res) => reportController.getEducationalReports(req, res)
  );

  // Get current educational report for a student
  app.get(
    "/api/students/:studentId/reports/educational/current",
    requireAuth,
    (req, res) => reportController.getCurrentEducationalReport(req, res)
  );

  // Get archived educational reports for a student
  app.get(
    "/api/students/:studentId/reports/educational/archived",
    requireAuth,
    (req, res) => reportController.getArchivedEducationalReports(req, res)
  );

  // Create a new educational report for a student
  app.post(
    "/api/students/:studentId/reports/educational",
    requireAuth,
    (req, res) => reportController.createEducationalReport(req, res)
  );

  // Get a specific educational report by ID
  app.get(
    "/api/educational-reports/:id",
    requireAuth,
    (req, res) => reportController.getEducationalReportById(req, res)
  );

  // Update an educational report
  app.patch(
    "/api/educational-reports/:id",
    requireAuth,
    (req, res) => reportController.updateEducationalReport(req, res)
  );

  // Finalize an educational report
  app.post(
    "/api/educational-reports/:id/finalize",
    requireAuth,
    (req, res) => reportController.finalizeEducationalReport(req, res)
  );

  // Create a revision of an educational report
  app.post(
    "/api/educational-reports/:id/revision",
    requireAuth,
    (req, res) => reportController.createEducationalReportRevision(req, res)
  );

  // Delete an educational report (draft only)
  app.delete(
    "/api/educational-reports/:id",
    requireAuth,
    (req, res) => reportController.deleteEducationalReport(req, res)
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

  app.get("/api/boards/student/:studentId", requireAuth, (req, res) =>
    boardController.getStudentBoards(req, res)
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
  // Chat endpoint with optional image upload for multimodal context
  app.post("/api/chat", optionalAuth, requireOnboardingComplete, aacUpload.single("image"), (req, res) =>
    chatController.onMessage(req, res)
  );
  // Streaming chat endpoint with real-time thinking updates (SSE)
  app.post("/api/chat/stream", optionalAuth, requireOnboardingComplete, (req, res) =>
    chatStreamController.onMessage(req, res)
  );

  // ============= CHAT FILE UPLOAD ROUTES =============
  // Upload a file for use in chat context
  app.post(
    "/api/chat/files/upload",
    optionalAuth,
    chatFileUpload.single("file"),
    (req, res) => fileUploadController.uploadFile(req, res)
  );
  // Delete a specific file
  app.delete("/api/chat/files/:fileId", optionalAuth, (req, res) =>
    fileUploadController.deleteFile(req, res)
  );
  // List files for a session
  app.get("/api/chat/sessions/:sessionId/files", optionalAuth, (req, res) =>
    fileUploadController.listSessionFiles(req, res)
  );
  // Clean up all files for a session
  app.delete("/api/chat/sessions/:sessionId/files", optionalAuth, (req, res) =>
    fileUploadController.cleanupSessionFiles(req, res)
  );

  // ============= VOICE ROUTES (AAC) =============
  // Transcribe audio to text using Whisper
  app.post("/api/aac/voice/transcribe", optionalAuth, requireOnboardingComplete, aacUpload.single("audio"), (req, res) =>
    voiceController.transcribe(req, res)
  );
  // Text-to-speech using Google TTS (returns audio blob directly)
  app.post("/api/aac/voice/synthesize", optionalAuth, requireOnboardingComplete, (req, res) =>
    voiceController.synthesize(req, res)
  );
  // Text-to-speech using Google TTS (streaming via SSE)
  app.post("/api/aac/voice/speak", optionalAuth, requireOnboardingComplete, (req, res) =>
    voiceController.speak(req, res)
  );
  // Full voice chat: audio in → transcription + AI response + audio out (streaming)
  app.post("/api/aac/voice/chat", optionalAuth, requireOnboardingComplete, aacUpload.single("audio"), (req, res) =>
    voiceController.voiceChat(req, res)
  );

  // ============= DUAL-AGENT AAC ROUTES =============
  // Initialize or resume a dual-agent session
  app.post("/api/aac/dual/initialize", optionalAuth, requireOnboardingComplete, (req, res) =>
    dualAgentController.initialize(req, res)
  );
  // Send text message (SSE streaming response)
  app.post("/api/aac/dual/message", optionalAuth, requireOnboardingComplete, aacUpload.single("image"), (req, res) =>
    dualAgentController.message(req, res)
  );
  // Send voice input (SSE streaming response)
  app.post("/api/aac/dual/voice", optionalAuth, requireOnboardingComplete, aacUpload.single("audio"), (req, res) =>
    dualAgentController.voice(req, res)
  );
  // Interpret button presses into a spoken sentence (SSE streaming response)
  app.post("/api/aac/dual/interpret", optionalAuth, requireOnboardingComplete, (req, res) =>
    dualAgentController.interpret(req, res)
  );
  // Continuous detection — camera frame in, board update out (JSON, not SSE)
  app.post("/api/aac/dual/detect", optionalAuth, requireOnboardingComplete, aacUpload.single("image"), (req, res) =>
    dualAgentController.detect(req, res)
  );
  // Get session state
  app.get("/api/aac/dual/session/:sessionId", optionalAuth, requireOnboardingComplete, (req, res) =>
    dualAgentController.getSession(req, res)
  );

  // ============= BIOMETRIC ENROLLMENT ROUTES =============
  // User face enrollment
  app.post("/api/biometric/users/:userId/face", requireAuth, (req, res) =>
    biometricController.enrollUserFace(req, res)
  );
  app.get("/api/biometric/users/:userId/face", requireAuth, (req, res) =>
    biometricController.getUserFaceStatus(req, res)
  );
  app.delete("/api/biometric/users/:userId/face", requireAuth, (req, res) =>
    biometricController.removeUserFace(req, res)
  );

  // Student face enrollment
  app.post("/api/biometric/students/:studentId/face", requireAuth, (req, res) =>
    biometricController.enrollStudentFace(req, res)
  );
  app.get("/api/biometric/students/:studentId/face", requireAuth, (req, res) =>
    biometricController.getStudentFaceStatus(req, res)
  );
  app.delete("/api/biometric/students/:studentId/face", requireAuth, (req, res) =>
    biometricController.removeStudentFace(req, res)
  );

  // User voice enrollment
  app.post("/api/biometric/users/:userId/voice", requireAuth, (req, res) =>
    biometricController.enrollUserVoice(req, res)
  );
  app.get("/api/biometric/users/:userId/voice", requireAuth, (req, res) =>
    biometricController.getUserVoiceStatus(req, res)
  );
  app.delete("/api/biometric/users/:userId/voice", requireAuth, (req, res) =>
    biometricController.removeUserVoice(req, res)
  );

  // Student voice enrollment
  app.post("/api/biometric/students/:studentId/voice", requireAuth, (req, res) =>
    biometricController.enrollStudentVoice(req, res)
  );
  app.get("/api/biometric/students/:studentId/voice", requireAuth, (req, res) =>
    biometricController.getStudentVoiceStatus(req, res)
  );
  app.delete("/api/biometric/students/:studentId/voice", requireAuth, (req, res) =>
    biometricController.removeStudentVoice(req, res)
  );

  // Biometric matching (for recognition)
  app.post("/api/biometric/match/face", requireAuth, (req, res) =>
    biometricController.matchFace(req, res)
  );
  app.post("/api/biometric/match/voice", requireAuth, (req, res) =>
    biometricController.matchVoice(req, res)
  );

  // Known people for AAC frontend identification (uses optionalAuth for AAC client)
  app.get("/api/aac/students/:studentId/known-people", optionalAuth, requireOnboardingComplete, (req, res) =>
    biometricController.getKnownPeople(req, res)
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
  // MFA enforcement
  app.patch("/api/admin/users/:id/mfa-enforcement", requireAdmin, (req, res) =>
    adminController.setMfaEnforcement(req, res)
  );

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

  // Admin routes are handled by the SPA fallback in index.prod.ts
  // The admin page is a client-side route within the main React app

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