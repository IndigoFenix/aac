import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import path from "path";
import { stringify } from "csv-stringify";
import { setupLiveWebSocket } from "./services/dual-agent/live-relay";
import { setupSocialBotWebSocket } from "./services/social-bot/social-bot-relay";
import { setupRealtimeServer, registerRealtimeHandler } from "./services/realtime/realtime-server";
import { subscribe } from "./services/realtime/room-registry";
import { initBus } from "./services/realtime/bus-factory";
import { initUserChatFanout } from "./services/userChat/userChatFanout";
import { userChatController } from "./controllers/userChatController";
import { userChatService } from "./services/userChat/userChatService";

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
  customAppController,
  deepAnalysisController,
  onboardingController,
  slpClinicalController,
  programController,
  instituteController,
  classroomController,
  sessionHistoryController,
  shareInviteController,
  consentController,
  crmChatController,
  adminUsersController,
  adminAuthController,
} from "./controllers";

import {
  requireAuth,
  optionalAuth,
  requireAdmin,
  requireSystemAdmin,
  requireSLPPlan,
  requireLicensePermission,
  validateCSRF,
  requireAdminSection,
} from "./middleware";
import { authRateLimiter, passwordResetRateLimiter } from "./middleware/security";

import { setupUserAuth } from "./userAuth"; // Keep existing passport setup
import { apiProviderRepository } from "./repositories";
import { chatController } from "./controllers/chatController";
import { chatStreamController } from "./controllers/chatStreamController";
import { reportController } from "./controllers/reportController";
import { fileUploadController } from "./controllers/fileUploadController";
import { personaController } from "./controllers/personaController";
import { topicController } from "./controllers/topicController";
import { voiceController } from "./controllers/voiceController";
import { voiceRecordController } from "./controllers/voiceRecordController";
import { dualAgentController } from "./controllers/dualAgentController";
import { spotifyController } from "./controllers/spotifyController";
import { biometricController } from "./controllers/biometricController";
import { customSymbolController } from "./controllers/customSymbolController";
import { contactController } from "./controllers/contactController";
import { licenseController } from "./controllers/licenseController";
import { calendarController } from "./controllers/calendarController";
import { incidentController } from "./controllers/incidentController";
import { registerDropboxRoutes } from "./services/dropboxRoutes";
import { activityLogService } from "./services/activityLogService";
import { activityLogController } from "./controllers/activityLogController";
import { insuranceBridgeController } from "./controllers/insuranceBridgeController";
import { identityController } from "./controllers/identityController";
import { studentErasureController } from "./controllers/studentErasureController";

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
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
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

  // ============= CSRF PROTECTION =============
  // Applied to all state-changing routes (POST/PUT/PATCH/DELETE) with a small
  // skip-list for endpoints that receive cross-origin POSTs by design and have
  // their own anti-replay protection (SAML ACS uses RelayState; the public
  // anonymous endpoints don't carry session credentials).
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (req.path.startsWith("/api/identity/saml/acs/")) return next();
    if (req.path.startsWith("/api/identity/saml/sls/")) return next();
    if (req.path === "/api/contact") return next();
    if (req.path.startsWith("/api/crm-chat/")) return next();
    if (req.path === "/health") return next();
    return validateCSRF(req, res, next);
  });

  // ============ HEALTH CHECK =============
  app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ============= CONTACT FORM (public) =============
  app.post("/api/contact", (req, res) => contactController.submit(req, res));

  // ============= CRM LANDING-PAGE CHAT (public, anonymous) =============
  app.get("/api/crm-chat/config", (req, res) => crmChatController.getConfig(req, res));
  app.post("/api/crm-chat/identify", (req, res) => crmChatController.identify(req, res));
  app.post("/api/crm-chat/message", (req, res) => crmChatController.sendMessage(req, res));
  app.post("/api/crm-chat/message-stream", (req, res) => crmChatController.sendMessageStream(req, res));

  // ============= AUTH ROUTES =============
  // Rate-limited per IP. authRateLimiter = 10/min; passwordResetRateLimiter = 5/15min.
  app.post("/auth/register", authRateLimiter, (req, res) => authController.register(req, res));
  app.post("/auth/login", authRateLimiter, (req, res, next) => authController.login(req, res, next));
  app.post("/auth/logout", (req, res) => authController.logout(req, res));
  app.post("/auth/reset-password", passwordResetRateLimiter, (req, res) => authController.resetPassword(req, res));
  app.post("/auth/forgot-password", passwordResetRateLimiter, (req, res) =>
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

  // ============= DEV-ONLY ROUTES =============
  if (process.env.NODE_ENV !== "production") {
    app.post("/auth/impersonate", (req, res) =>
      authController.impersonate(req, res)
    );
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
  // MFA setup with token (for enforced setup during login) — rate-limited (token is unauthenticated).
  app.post("/auth/mfa/setup-with-token", authRateLimiter, (req, res) =>
    authController.mfaSetupWithToken(req, res)
  );
  // MFA verify setup (requires auth)
  app.post("/auth/mfa/verify-setup", requireAuth, (req, res) =>
    authController.mfaVerifySetup(req, res)
  );
  // MFA verify setup with token — rate-limited.
  app.post("/auth/mfa/verify-setup-with-token", authRateLimiter, (req, res) =>
    authController.mfaVerifySetupWithToken(req, res)
  );
  // MFA disable (requires auth)
  app.post("/auth/mfa/disable", requireAuth, (req, res) =>
    authController.mfaDisable(req, res)
  );
  // MFA verify during login (public, uses mfaToken) — rate-limited.
  app.post("/auth/mfa/verify", authRateLimiter, (req, res) =>
    authController.mfaVerify(req, res)
  );
  // MFA recovery request (public) — looser limit, can email-flood otherwise.
  app.post("/auth/mfa/recovery/request", passwordResetRateLimiter, (req, res) =>
    authController.mfaRecoveryRequest(req, res)
  );
  // MFA recovery validate (public)
  app.get("/auth/mfa/recovery/:token", (req, res) =>
    authController.mfaRecoveryValidate(req, res)
  );
  // MFA recovery complete (public) — rate-limited.
  app.post("/auth/mfa/recovery/complete", authRateLimiter, (req, res) =>
    authController.mfaRecoveryComplete(req, res)
  );

  // ============= ADMIN AUTH FLOWS =============
  // Mirrors the regular forgot/reset/recovery endpoints but operates against
  // admin_users + the admin-specific token tables. Same rate-limit policy.
  app.post("/auth/admin/forgot-password", passwordResetRateLimiter, (req, res) =>
    adminAuthController.forgotPassword(req, res)
  );
  app.get("/auth/admin/reset-password/:token", (req, res) =>
    adminAuthController.validateResetToken(req, res)
  );
  app.post("/auth/admin/reset-password", passwordResetRateLimiter, (req, res) =>
    adminAuthController.resetPassword(req, res)
  );
  app.post("/auth/admin/mfa/recovery/request", passwordResetRateLimiter, (req, res) =>
    adminAuthController.mfaRecoveryRequest(req, res)
  );
  app.get("/auth/admin/mfa/recovery/:token", (req, res) =>
    adminAuthController.mfaRecoveryValidate(req, res)
  );
  app.post("/auth/admin/mfa/recovery/complete", authRateLimiter, (req, res) =>
    adminAuthController.mfaRecoveryComplete(req, res)
  );

  // ============= IDENTITY / EXTERNAL AUTH ROUTES =============
  app.get("/api/identity/status", requireAuth, (req, res) =>
    identityController.getStatus(req, res)
  );
  app.get("/api/identity/user", requireAuth, (req, res) =>
    identityController.getUserIdentities(req, res)
  );
  // Public list of active identity providers — used by the login page to
  // render "Sign in with X" buttons. Rate-limited to deter discovery spam.
  app.get("/api/auth/identity-providers", authRateLimiter, (req, res) =>
    identityController.getPublicProviders(req, res)
  );
  // Initiate is public so it serves both flows: link (when authenticated)
  // and login (when not). The session-state CSRF token handles auth-flow
  // integrity. Rate-limited to deter abuse.
  app.get("/api/identity/link/:providerId", authRateLimiter, (req, res) =>
    identityController.initiateLink(req, res)
  );
  // Callback is public — the controller branches on req.user to decide
  // between linking (existing session) or logging in via the external
  // identity (no session). State token validation gates both paths.
  app.get("/api/identity/callback/:providerId", (req, res) =>
    identityController.handleCallback(req, res)
  );
  // SAML Assertion Consumer Service — IdP POSTs here. Public for the same
  // reason as /callback above; SAML's RelayState + signed assertion gate
  // both link and login paths.
  app.post("/api/identity/saml/acs/:providerId", (req, res) =>
    identityController.handleSamlAcs(req, res)
  );
  // SAML SP metadata — public so IdPs can fetch it during onboarding.
  app.get("/api/identity/saml/metadata/:providerId", (req, res) =>
    identityController.getSamlMetadata(req, res)
  );
  // SAML Single Logout (SP-initiated). Initiator requires auth (we read the
  // user's stored claims to build the LogoutRequest). The SLS endpoint
  // receives the IdP's LogoutResponse — public, validated by signature +
  // RelayState session check.
  app.get("/api/identity/saml/slo/:providerId", requireAuth, (req, res) =>
    identityController.initiateSamlLogout(req, res)
  );
  app.post("/api/identity/saml/sls/:providerId", (req, res) =>
    identityController.handleSamlSlo(req, res)
  );
  app.delete("/api/identity/link/:providerId", requireAuth, (req, res) =>
    identityController.unlinkIdentity(req, res)
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
  app.patch("/api/institutes/:id", requireAuth, (req, res, next) => {
    // Only use multer when the request is multipart (logo upload)
    if (req.is('multipart/form-data')) {
      upload.single("logo")(req, res, next);
    } else {
      next();
    }
  }, (req, res) =>
    instituteController.updateInstitute(req as any, res)
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
  // Admin routes (admins with the "personas" section permission)
  app.get('/api/admin/personas', requireAuth, requireAdminSection('personas'), personaController.getPersonas.bind(personaController));
  app.post('/api/admin/personas', requireAuth, requireAdminSection('personas'), personaController.createPersona.bind(personaController));
  app.get('/api/admin/personas/:id', requireAuth, requireAdminSection('personas'), personaController.getPersona.bind(personaController));
  app.patch('/api/admin/personas/:id', requireAuth, requireAdminSection('personas'), personaController.updatePersona.bind(personaController));
  app.delete('/api/admin/personas/:id', requireAuth, requireAdminSection('personas'), personaController.deletePersona.bind(personaController));

  // User routes (any authenticated user)
  app.get('/api/personas/selectable', requireAuth, personaController.getSelectablePersonas.bind(personaController));

  // ============= VOICE RECORD ROUTES =============
  // Admin routes (admins with the "voices" section permission)
  app.get('/api/admin/voices', requireAuth, requireAdminSection('voices'), voiceRecordController.getVoices.bind(voiceRecordController));
  app.post('/api/admin/voices', requireAuth, requireAdminSection('voices'), voiceRecordController.createVoice.bind(voiceRecordController));
  app.get('/api/admin/voices/:id', requireAuth, requireAdminSection('voices'), voiceRecordController.getVoice.bind(voiceRecordController));
  app.patch('/api/admin/voices/:id', requireAuth, requireAdminSection('voices'), voiceRecordController.updateVoice.bind(voiceRecordController));
  app.delete('/api/admin/voices/:id', requireAuth, requireAdminSection('voices'), voiceRecordController.deleteVoice.bind(voiceRecordController));

  // User routes (any authenticated user - active voices for settings panel)
  app.get('/api/voices/active', requireAuth, voiceRecordController.getActiveVoices.bind(voiceRecordController));
  app.post('/api/voices/elevenlabs-list', requireAuth, voiceRecordController.listElevenlabsVoices.bind(voiceRecordController));
  app.post('/api/voices/preview', requireAuth, voiceRecordController.previewVoice.bind(voiceRecordController));

  // ============= TOPIC/LIBRARY ROUTES =============
  // Admin routes (admins with the "library" section permission)
  app.get('/api/admin/topics', requireAuth, requireAdminSection('library'), topicController.getTopics.bind(topicController));
  app.post('/api/admin/topics', requireAuth, requireAdminSection('library'), topicController.createTopic.bind(topicController));
  app.get('/api/admin/topics/:id', requireAuth, requireAdminSection('library'), topicController.getTopic.bind(topicController));
  app.patch('/api/admin/topics/:id', requireAuth, requireAdminSection('library'), topicController.updateTopic.bind(topicController));
  app.delete('/api/admin/topics/:id', requireAuth, requireAdminSection('library'), topicController.deleteTopic.bind(topicController));

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

  // ============= CROSS-INSTITUTE SHARE ROUTES =============
  // See planning-docs/cross-institute-sharing-plan.md

  // Source side
  app.post("/api/shares/invites", requireAuth, (req, res) =>
    shareInviteController.createInvite(req, res)
  );
  app.get("/api/shares/invites", requireAuth, (req, res) =>
    shareInviteController.listInvites(req, res)
  );
  app.get("/api/shares/invites/inbox", requireAuth, (req, res) =>
    shareInviteController.listGuardianInbox(req, res)
  );
  app.get("/api/shares/invites/:id", requireAuth, (req, res) =>
    shareInviteController.getInvite(req, res)
  );

  // Guardian side
  app.post("/api/shares/invites/:id/approve", requireAuth, (req, res) =>
    shareInviteController.approveInvite(req, res)
  );
  app.post("/api/shares/invites/:id/decline", requireAuth, (req, res) =>
    shareInviteController.declineInvite(req, res)
  );

  // Target side
  app.post("/api/shares/redeem", requireAuth, (req, res) =>
    shareInviteController.redeem(req, res)
  );
  app.post("/api/shares/invites/:id/accept", requireAuth, (req, res) =>
    shareInviteController.acceptInvite(req, res)
  );

  // Revocation (any party with standing)
  app.post("/api/shares/invites/:id/revoke", requireAuth, (req, res) =>
    shareInviteController.revokeInvite(req, res)
  );
  app.post("/api/shares/object-shares/:id/revoke", requireAuth, (req, res) =>
    shareInviteController.revokeObjectShare(req, res)
  );
  app.post("/api/shares/standing-shares/:id/revoke", requireAuth, (req, res) =>
    shareInviteController.revokeStandingShare(req, res)
  );

  // Materialized shares for an institute — Outgoing/Incoming tab visibility
  app.get("/api/shares/active", requireAuth, (req, res) =>
    shareInviteController.listActiveShares(req, res)
  );

  // Renewal — guardian extends a standing share's shareExpiresAt
  app.get("/api/shares/standing-shares/inbox", requireAuth, (req, res) =>
    shareInviteController.listGuardianStandingShares(req, res)
  );
  app.post("/api/shares/standing-shares/:id/renew", requireAuth, (req, res) =>
    shareInviteController.renewStandingShare(req, res)
  );

  // Bulk-ungrant — guardian revokes all active shares (object + standing) to a
  // specific recipient institute for a specific student. Used when a student
  // transfers institutes and the guardian wants to wind down access in one click.
  app.post("/api/shares/bulk-revoke", requireAuth, (req, res) =>
    shareInviteController.bulkRevoke(req, res)
  );

  // ============= STUDENT INFORMED-CONSENT ROUTES =============
  // See planning-docs/student-consent-onboarding-plan.md

  // Keep consent surfaces out of search indexes. This covers both the public
  // sign page (/consent/sign — served by the SPA fallback registered later,
  // which still carries this header) and the API. Required by the ticket so
  // sensitive intake forms never surface in search results. Scoped to consent
  // paths only — the marketing landing must stay indexable.
  app.use(["/consent", "/api/consent"], (_req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });

  app.get("/api/consent/notice", requireAuth, (req, res) =>
    consentController.getNotice(req, res)
  );
  app.get("/api/consent/students/:studentId/active", requireAuth, (req, res) =>
    consentController.getActiveForStudent(req, res)
  );
  app.get("/api/consent/students/:studentId/history", requireAuth, (req, res) =>
    consentController.listHistory(req, res)
  );
  app.get("/api/consent/students/:studentId/wizard-context", requireAuth, (req, res) =>
    consentController.getWizardContext(req, res)
  );
  app.post("/api/consent/students/:studentId/sign", requireAuth, (req, res) =>
    consentController.signConsent(req, res)
  );
  app.post("/api/consent/:consentId/revoke", requireAuth, (req, res) =>
    consentController.revokeConsent(req, res)
  );

  // Magic-link consent invitations. Note: redeem + sign do NOT require auth —
  // the token IS the auth (parents may not have user accounts).
  app.post("/api/consent/invitations", requireAuth, (req, res) =>
    consentController.createInvitation(req, res)
  );
  app.get("/api/consent/students/:studentId/invitations", requireAuth, (req, res) =>
    consentController.listPendingInvitations(req, res)
  );
  app.get("/api/consent/invitations/redeem", (req, res) =>
    consentController.redeemInvitation(req, res)
  );
  app.post("/api/consent/invitations/sign", (req, res) =>
    consentController.signInvitation(req, res)
  );
  app.post("/api/consent/invitations/request-otp", (req, res) =>
    consentController.requestPhoneOtp(req, res)
  );
  app.post("/api/consent/invitations/verify-otp", (req, res) =>
    consentController.verifyPhoneOtp(req, res)
  );
  app.post("/api/consent/invitations/verify-id", (req, res) =>
    consentController.verifyChildId(req, res)
  );
  app.post("/api/consent/invitations/:id/revoke", requireAuth, (req, res) =>
    consentController.revokeInvitation(req, res)
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

  // Service ↔ Users
  app.get("/api/services/:id/users", requireAuth, (req, res) =>
    programController.getServiceUsers(req, res)
  );
  app.post("/api/services/:id/users", requireAuth, (req, res) =>
    programController.linkUserToService(req, res)
  );
  app.delete("/api/services/:id/users/:userId", requireAuth, (req, res) =>
    programController.unlinkUserFromService(req, res)
  );

  // Service ↔ Calendar events
  app.get("/api/services/:id/events", requireAuth, (req, res) =>
    programController.getServiceEvents(req, res)
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

  // Program team (new path — contact ↔ program junction). Replaces the old
  // team-members endpoints. Frontend picks existing studentContacts rather
  // than creating team members from scratch.
  app.get("/api/programs/:programId/team", requireAuth, (req, res) =>
    programController.getTeamContacts(req, res)
  );
  app.post("/api/programs/:programId/team", requireAuth, (req, res) =>
    programController.addTeamContact(req, res)
  );
  app.patch("/api/program-contacts/:id", requireAuth, (req, res) =>
    programController.updateTeamContact(req, res)
  );
  app.delete("/api/program-contacts/:id", requireAuth, (req, res) =>
    programController.removeTeamContact(req, res)
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

  // Student-user link management
  app.get("/api/students/:id/links", requireAuth, (req, res) =>
    studentController.getLinkedUsers(req, res)
  );
  app.post("/api/students/:id/link", requireAuth, (req, res) =>
    studentController.linkUser(req, res)
  );
  app.delete("/api/students/:id/link/:userId", requireAuth, (req, res) =>
    studentController.unlinkUser(req, res)
  );

  // Users sharing an institute with this student — pool for service assignees
  app.get("/api/students/:id/institute-members", requireAuth, (req, res) =>
    studentController.getInstituteMembers(req, res)
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

  app.patch("/api/boards/:id", requireAuth, (req, res) =>
    boardController.updateBoard(req, res)
  );

  // Export endpoints
  app.post("/api/export/gridset", requireAuth, (req, res) =>
    boardController.exportGridset(req, res)
  );

  app.post("/api/export/snappkg", requireAuth, (req, res) =>
    boardController.exportSnappkg(req, res)
  );

  // ============= CUSTOM APPS (GAMES) ROUTES =============
  const requireCustomApps = requireLicensePermission("customAppsEnabled");
  app.post("/api/custom-apps", requireAuth, requireCustomApps, (req, res) =>
    customAppController.saveApp(req, res)
  );
  app.get("/api/custom-apps", requireAuth, requireCustomApps, (req, res) =>
    customAppController.getUserApps(req, res)
  );
  app.get("/api/custom-apps/student/:studentId", requireAuth, requireCustomApps, (req, res) =>
    customAppController.getStudentApps(req, res)
  );
  app.get("/api/custom-apps/student/:studentId/available", requireAuth, requireCustomApps, (req, res) =>
    customAppController.getAvailableAppsForStudent(req, res)
  );
  app.get("/api/custom-apps/:id", requireAuth, requireCustomApps, (req, res) =>
    customAppController.getApp(req, res)
  );
  app.patch("/api/custom-apps/:id", requireAuth, requireCustomApps, (req, res) =>
    customAppController.updateApp(req, res)
  );
  app.delete("/api/custom-apps/:id", requireAuth, requireCustomApps, (req, res) =>
    customAppController.deleteApp(req, res)
  );
  app.post("/api/custom-apps/:id/assignments", requireAuth, requireCustomApps, (req, res) =>
    customAppController.assignToStudent(req, res)
  );
  app.delete("/api/custom-apps/:id/assignments/:studentId", requireAuth, requireCustomApps, (req, res) =>
    customAppController.unassignFromStudent(req, res)
  );
  app.get("/api/custom-apps/:id/assignments", requireAuth, requireCustomApps, (req, res) =>
    customAppController.getAssignments(req, res)
  );

  // ============= DEEP ANALYSIS ROUTES =============
  const requireDeepAnalysis = requireLicensePermission("deepAnalysisEnabled");
  app.post("/api/deep-analysis", requireAuth, requireDeepAnalysis, (req, res) =>
    deepAnalysisController.create(req, res)
  );
  app.get("/api/deep-analysis", requireAuth, requireDeepAnalysis, (req, res) =>
    deepAnalysisController.list(req, res)
  );
  app.get("/api/deep-analysis/:id", requireAuth, requireDeepAnalysis, (req, res) =>
    deepAnalysisController.get(req, res)
  );
  app.delete("/api/deep-analysis/:id", requireAuth, requireDeepAnalysis, (req, res) =>
    deepAnalysisController.delete(req, res)
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
  app.post("/api/chat", optionalAuth, aacUpload.single("image"), (req, res) =>
    chatController.onMessage(req, res)
  );
  // Streaming chat endpoint with real-time thinking updates (SSE)
  app.post("/api/chat/stream", optionalAuth, (req, res) =>
    chatStreamController.onMessage(req, res)
  );

  // ============= CHAT FILE UPLOAD ROUTES =============
  // Upload a file for use in chat context (stored in temporary server cache)
  app.post(
    "/api/chat/files/upload",
    optionalAuth,
    chatFileUpload.single("file"),
    (req, res) => fileUploadController.uploadFile(req, res)
  );
  // Get a cached file (generated images, extracted frames, etc.)
  app.get("/api/chat/files/:fileId", optionalAuth, (req, res) =>
    fileUploadController.getFileHandler(req, res)
  );
  // Delete a cached file
  app.delete("/api/chat/files/:fileId", optionalAuth, (req, res) =>
    fileUploadController.deleteFileHandler(req, res)
  );

  // ============= VOICE ROUTES (AAC) =============
  // Transcribe audio to text using Whisper
  app.post("/api/aac/voice/transcribe", optionalAuth, aacUpload.single("audio"), (req, res) =>
    voiceController.transcribe(req, res)
  );
  // Text-to-speech using Google TTS (returns audio blob directly)
  app.post("/api/aac/voice/synthesize", optionalAuth, (req, res) =>
    voiceController.synthesize(req, res)
  );
  // Text-to-speech using Google TTS (streaming via SSE)
  app.post("/api/aac/voice/speak", optionalAuth, (req, res) =>
    voiceController.speak(req, res)
  );
  // Full voice chat: audio in → transcription + AI response + audio out (streaming)
  app.post("/api/aac/voice/chat", optionalAuth, aacUpload.single("audio"), (req, res) =>
    voiceController.voiceChat(req, res)
  );

  // ============= YOUTUBE CHANNEL RESOLVER =============
  // Resolve a YouTube channel URL / @handle / raw channel ID to a UC... channel ID
  // AND fetch its display title + description. No API key required (public HTML).
  app.post("/api/aac/youtube/resolve-channel", optionalAuth, async (req, res) => {
    try {
      const { input } = req.body || {};
      if (typeof input !== "string" || !input.trim()) {
        return res.status(400).json({ error: "input required" });
      }
      const { resolveChannelIdFromUrl, fetchChannelMetadata } = await import(
        "./services/youtube/channel-search"
      );
      const channelId = await resolveChannelIdFromUrl(input);
      if (!channelId) return res.status(404).json({ error: "Could not resolve channel ID from URL." });
      const metadata = await fetchChannelMetadata(channelId);
      return res.json({
        channelId,
        title: metadata.title,
        description: metadata.description,
      });
    } catch (err: any) {
      console.error("[routes] resolve-channel failed:", err?.message || err);
      return res.status(500).json({ error: "Resolver failed" });
    }
  });

  // Resolve a YouTube video URL / videoId to a canonical 11-char videoId AND
  // fetch its display title + description + thumbnail. No API key required
  // (public watch-page scrape). Used by the pinned-videos clinician UI.
  app.post("/api/aac/youtube/resolve-video", optionalAuth, async (req, res) => {
    try {
      const { input } = req.body || {};
      if (typeof input !== "string" || !input.trim()) {
        return res.status(400).json({ error: "input required" });
      }
      const { resolveVideoIdFromUrl, fetchVideoMetadata } = await import(
        "./services/youtube/channel-search"
      );
      const videoId = resolveVideoIdFromUrl(input);
      if (!videoId) return res.status(404).json({ error: "Could not resolve video ID from URL." });
      const metadata = await fetchVideoMetadata(videoId);
      return res.json({
        videoId,
        title: metadata.title,
        description: metadata.description,
        thumbnailUrl: metadata.thumbnailUrl,
      });
    } catch (err: any) {
      console.error("[routes] resolve-video failed:", err?.message || err);
      return res.status(500).json({ error: "Resolver failed" });
    }
  });

  // List recent videos from a YouTube channel (RSS-backed). Public data;
  // the client already knows the channelId because the server sent the
  // permitted-channels list to it.
  app.get("/api/aac/youtube/channel-videos", optionalAuth, async (req, res) => {
    try {
      const channelId = req.query.channelId;
      if (typeof channelId !== "string" || !/^UC[A-Za-z0-9_-]{20,}$/.test(channelId)) {
        return res.status(400).json({ error: "valid channelId required" });
      }
      const { fetchChannelRssVideos } = await import("./services/youtube/channel-search");
      const videos = await fetchChannelRssVideos(channelId);
      return res.json({ channelId, videos });
    } catch (err: any) {
      console.error("[routes] channel-videos failed:", err?.message || err);
      return res.status(500).json({ error: "Fetch failed" });
    }
  });

  // Unified resolver — detect whether a pasted string is a channel, playlist,
  // or video, resolve its canonical id, and fetch display title/description
  // (+ thumbnail for videos/playlists). Backs the single "add YouTube content"
  // input in the clinician settings UI. No API key required (public scrape).
  app.post("/api/aac/youtube/resolve", optionalAuth, async (req, res) => {
    try {
      const { input } = req.body || {};
      if (typeof input !== "string" || !input.trim()) {
        return res.status(400).json({ error: "input required" });
      }
      const {
        resolveYoutubeItemFromUrl,
        fetchChannelMetadata,
        fetchVideoMetadata,
        fetchPlaylistMetadata,
      } = await import("./services/youtube/channel-search");
      const resolved = await resolveYoutubeItemFromUrl(input);
      if (!resolved) {
        return res.status(404).json({ error: "Could not recognize that YouTube URL or ID." });
      }
      let title: string | null = null;
      let description: string | null = null;
      let thumbnailUrl: string | null = null;
      if (resolved.type === "channel") {
        const m = await fetchChannelMetadata(resolved.id);
        title = m.title;
        description = m.description;
      } else if (resolved.type === "video") {
        const m = await fetchVideoMetadata(resolved.id);
        title = m.title;
        description = m.description;
        thumbnailUrl = m.thumbnailUrl;
      } else {
        const m = await fetchPlaylistMetadata(resolved.id);
        title = m.title;
        description = m.description;
        thumbnailUrl = m.thumbnailUrl;
      }
      return res.json({ type: resolved.type, id: resolved.id, title, description, thumbnailUrl });
    } catch (err: any) {
      console.error("[routes] youtube resolve failed:", err?.message || err);
      return res.status(500).json({ error: "Resolver failed" });
    }
  });

  // List videos in a YouTube playlist (RSS-backed). Public data; the client
  // already knows the playlistId because the server sent the permitted-items
  // list to it.
  app.get("/api/aac/youtube/playlist-videos", optionalAuth, async (req, res) => {
    try {
      const playlistId = req.query.playlistId;
      if (typeof playlistId !== "string" || !/^(PL|UU|OL|LL|FL)[A-Za-z0-9_-]{10,}$/.test(playlistId)) {
        return res.status(400).json({ error: "valid playlistId required" });
      }
      const { fetchPlaylistRssVideos } = await import("./services/youtube/channel-search");
      const videos = await fetchPlaylistRssVideos(playlistId);
      return res.json({ playlistId, videos });
    } catch (err: any) {
      console.error("[routes] playlist-videos failed:", err?.message || err);
      return res.status(500).json({ error: "Fetch failed" });
    }
  });

  // ============= SPOTIFY OAUTH ROUTES =============
  app.get("/api/aac/spotify/auth-url", optionalAuth, (req, res) =>
    spotifyController.getAuthUrl(req, res)
  );
  app.get("/api/aac/spotify/callback", (req, res) =>
    spotifyController.callback(req, res)
  );
  app.get("/api/aac/spotify/token", optionalAuth, (req, res) =>
    spotifyController.getToken(req, res)
  );
  app.delete("/api/aac/spotify/disconnect", optionalAuth, (req, res) =>
    spotifyController.disconnect(req, res)
  );

  // ============= DUAL-AGENT AAC SESSION ROUTE =============
  // Get session state
  app.get("/api/aac/dual/session/:sessionId", optionalAuth, (req, res) =>
    dualAgentController.getSession(req, res)
  );

  // ============= CUSTOM SYMBOL ROUTES =============
  // Named routes first (before parameterized /:id routes)
  app.post("/api/custom-symbols/generate", requireAuth, (req, res) =>
    customSymbolController.generateSymbol(req, res)
  );
  app.get("/api/custom-symbols/search", requireAuth, (req, res) =>
    customSymbolController.searchSymbols(req, res)
  );
  app.get("/api/custom-symbols/my", requireAuth, (req, res) =>
    customSymbolController.getMySymbols(req, res)
  );
  app.get("/api/custom-symbols/student/:studentId", requireAuth, (req, res) =>
    customSymbolController.getStudentSymbols(req, res)
  );
  app.get("/api/custom-symbols/institute/:instituteId", requireAuth, (req, res) =>
    customSymbolController.getInstituteSymbols(req, res)
  );
  app.get("/api/custom-symbols/public", requireAdminSection("public-symbols"), (req, res) =>
    customSymbolController.getPublicSymbols(req, res)
  );
  app.get("/api/custom-symbols/unapproved", requireAdminSection("public-symbols"), (req, res) =>
    customSymbolController.getUnapprovedSymbols(req, res)
  );
  app.get("/api/custom-symbols/by-key/:key", requireAuth, (req, res) =>
    customSymbolController.getSymbolByKey(req, res)
  );
  app.post("/api/custom-symbols/resolve-keys", requireAuth, (req, res) =>
    customSymbolController.resolveKeys(req, res)
  );
  app.get("/api/custom-symbols/watch", requireAuth, (req, res) =>
    customSymbolController.watchSymbols(req, res)
  );
  app.get("/api/custom-symbols/available/:studentId", requireAuth, (req, res) =>
    customSymbolController.getAvailableSymbols(req, res)
  );
  app.post("/api/custom-symbols/bulk-delete-unapproved", requireAdminSection("public-symbols"), (req, res) =>
    customSymbolController.bulkDeleteUnapproved(req, res)
  );
  app.post("/api/custom-symbols/generate-and-create", requireAdminSection("public-symbols"), (req, res) =>
    customSymbolController.generateAndCreateSymbol(req, res)
  );

  // Symbol CRUD (parameterized routes last)
  app.post("/api/custom-symbols", requireAuth, upload.single("image"), (req, res) =>
    customSymbolController.createSymbol(req, res)
  );
  app.get("/api/custom-symbols/:id", requireAuth, (req, res) =>
    customSymbolController.getSymbol(req, res)
  );
  app.get("/api/custom-symbols/:id/image", requireAuth, (req, res) =>
    customSymbolController.getSymbolImage(req, res)
  );
  app.patch("/api/custom-symbols/:id", requireAdminSection("public-symbols"), (req, res) =>
    customSymbolController.updateSymbol(req, res)
  );
  app.put("/api/custom-symbols/:id/image", requireAdminSection("public-symbols"), upload.single("image"), (req, res) =>
    customSymbolController.replaceSymbolImage(req, res)
  );
  app.post("/api/custom-symbols/:id/regenerate", requireAdminSection("public-symbols"), (req, res) =>
    customSymbolController.regenerateSymbol(req, res)
  );
  app.delete("/api/custom-symbols/:id", requireAdminSection("public-symbols"), (req, res) =>
    customSymbolController.deleteSymbol(req, res)
  );

  // Association create
  app.post("/api/custom-symbols/:id/user-associate", requireAuth, (req, res) =>
    customSymbolController.createUserAssociation(req, res)
  );
  app.post("/api/custom-symbols/:id/student-associate", requireAuth, (req, res) =>
    customSymbolController.createStudentAssociation(req, res)
  );
  app.post("/api/custom-symbols/:id/institute-associate", requireAuth, (req, res) =>
    customSymbolController.createInstituteAssociation(req, res)
  );

  // Association update/delete
  app.patch("/api/custom-symbols/user-associations/:assocId", requireAuth, (req, res) =>
    customSymbolController.updateUserAssociation(req, res)
  );
  app.patch("/api/custom-symbols/student-associations/:assocId", requireAuth, (req, res) =>
    customSymbolController.updateStudentAssociation(req, res)
  );
  app.patch("/api/custom-symbols/institute-associations/:assocId", requireAuth, (req, res) =>
    customSymbolController.updateInstituteAssociation(req, res)
  );
  app.delete("/api/custom-symbols/user-associations/:assocId", requireAuth, (req, res) =>
    customSymbolController.deleteUserAssociation(req, res)
  );
  app.delete("/api/custom-symbols/student-associations/:assocId", requireAuth, (req, res) =>
    customSymbolController.deleteStudentAssociation(req, res)
  );
  app.delete("/api/custom-symbols/institute-associations/:assocId", requireAuth, (req, res) =>
    customSymbolController.deleteInstituteAssociation(req, res)
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
  app.get("/api/aac/students/:studentId/known-people", optionalAuth, (req, res) =>
    biometricController.getKnownPeople(req, res)
  );

  // Full selectable-people directory + stored photos for the AAC sentence
  // builder (optionalAuth for the student kiosk; access enforced per-student).
  app.get("/api/aac/students/:studentId/people-directory", optionalAuth, (req, res) =>
    biometricController.getPeopleDirectory(req, res)
  );
  app.get("/api/aac/students/:studentId/people/:personId/photo", optionalAuth, (req, res) =>
    biometricController.getPersonPhoto(req, res)
  );

  // Student contacts CRUD
  app.post("/api/biometric/students/:studentId/contacts", requireAuth, (req, res) =>
    biometricController.createStudentContact(req, res)
  );
  app.get("/api/biometric/students/:studentId/contacts", requireAuth, (req, res) =>
    biometricController.listStudentContacts(req, res)
  );
  app.get("/api/biometric/students/:studentId/contacts/:id", requireAuth, (req, res) =>
    biometricController.getStudentContact(req, res)
  );
  app.patch("/api/biometric/students/:studentId/contacts/:id", requireAuth, (req, res) =>
    biometricController.updateStudentContact(req, res)
  );
  app.delete("/api/biometric/students/:studentId/contacts/:id", requireAuth, (req, res) =>
    biometricController.deleteStudentContact(req, res)
  );
  app.post("/api/biometric/students/:studentId/contacts/:id/face", requireAuth, (req, res) =>
    biometricController.enrollContactFace(req, res)
  );
  app.get("/api/biometric/students/:studentId/linkable-entities", requireAuth, (req, res) =>
    biometricController.getLinkableEntities(req, res)
  );

  // Photo upload (multipart) — resizes + uploads to S3, saves URL in biometric_data
  app.post("/api/biometric/users/:userId/photo", requireAuth, upload.single("image"), (req, res) =>
    biometricController.uploadUserPhoto(req, res)
  );
  app.post("/api/biometric/students/:studentId/photo", requireAuth, upload.single("image"), (req, res) =>
    biometricController.uploadStudentPhoto(req, res)
  );
  app.post("/api/biometric/students/:studentId/contacts/:id/photo", requireAuth, upload.single("image"), (req, res) =>
    biometricController.uploadContactPhoto(req, res)
  );

  // biometric_data direct access
  app.get("/api/biometric-data/:id/photo", requireAuth, (req, res) =>
    biometricController.getBiometricPhoto(req, res)
  );
  app.patch("/api/biometric-data/:id", requireAuth, (req, res) =>
    biometricController.updateBiometricDataPhysical(req, res)
  );

  // ============= CALENDAR ROUTES =============
  app.get("/api/calendar/events", requireAuth, (req, res) =>
    calendarController.getEvents(req, res)
  );
  app.get("/api/calendar/events/:id", requireAuth, (req, res) =>
    calendarController.getEvent(req, res)
  );
  app.post("/api/calendar/events", requireAuth, (req, res) =>
    calendarController.createEvent(req, res)
  );
  app.patch("/api/calendar/events/:id", requireAuth, (req, res) =>
    calendarController.updateEvent(req, res)
  );
  app.delete("/api/calendar/events/:id", requireAuth, (req, res) =>
    calendarController.deleteEvent(req, res)
  );
  app.post("/api/calendar/events/:id/attendees", requireAuth, (req, res) =>
    calendarController.addAttendee(req, res)
  );
  app.delete("/api/calendar/events/:id/attendees/:attendeeType/:attendeeId", requireAuth, (req, res) =>
    calendarController.removeAttendee(req, res)
  );
  app.post("/api/calendar/events/:id/rsvp", requireAuth, (req, res) =>
    calendarController.setRsvp(req, res)
  );

  // ============= INCIDENT ROUTES =============
  app.get("/api/students/:studentId/incidents", requireAuth, (req, res) =>
    incidentController.list(req, res),
  );
  app.post("/api/students/:studentId/incidents", requireAuth, (req, res) =>
    incidentController.create(req, res),
  );
  app.patch("/api/incidents/:id", requireAuth, (req, res) =>
    incidentController.update(req, res),
  );
  app.delete("/api/incidents/:id", requireAuth, (req, res) =>
    incidentController.delete(req, res),
  );

  // ============= USER CHAT ROUTES =============
  app.get("/api/user-chat/contacts", requireAuth, (req, res) =>
    userChatController.getContacts(req, res),
  );
  app.get("/api/user-chat/rooms", requireAuth, (req, res) =>
    userChatController.getRooms(req, res),
  );
  app.post("/api/user-chat/rooms", requireAuth, (req, res) =>
    userChatController.createRoom(req, res),
  );
  app.get("/api/user-chat/rooms/:id/messages", requireAuth, (req, res) =>
    userChatController.getMessages(req, res),
  );
  app.post("/api/user-chat/rooms/:id/messages", requireAuth, (req, res) =>
    userChatController.sendMessage(req, res),
  );
  app.post("/api/user-chat/rooms/:id/read", requireAuth, (req, res) =>
    userChatController.markRead(req, res),
  );
  app.post("/api/user-chat/push-register", requireAuth, (req, res) =>
    userChatController.registerPush(req, res),
  );

  // ============= ADMIN ROUTES =============
  // Institutes (admin lookup)
  app.get("/api/admin/institutes", requireAuth, requireSystemAdmin, (req, res) =>
    adminController.getAllInstitutes(req, res)
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
  app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { userRepository } = await import("./repositories/userRepository");
      const deleted = await userRepository.deleteUser(id);
      if (deleted) {
        res.json({ success: true, message: "User deleted successfully" });
        activityLogService.log({
          userId: (req as any).user?.id,
          eventType: "delete",
          subjectType1: "user",
          subjectId1: id,
        });
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

  // Admins (backoffice admin management). Gated by the 'admins' section
  // permission — only admins with `"*"` or `"admins"` in their permission
  // list can manage other admins.
  app.get("/api/admin/admins", requireAuth, requireAdminSection("admins"), (req, res) =>
    adminUsersController.list(req, res)
  );
  app.post("/api/admin/admins", requireAuth, requireAdminSection("admins"), (req, res) =>
    adminUsersController.create(req, res)
  );
  app.patch("/api/admin/admins/:id", requireAuth, requireAdminSection("admins"), (req, res) =>
    adminUsersController.update(req, res)
  );
  app.delete("/api/admin/admins/:id", requireAuth, requireAdminSection("admins"), (req, res) =>
    adminUsersController.remove(req, res)
  );

  // System prompt
  app.get("/api/admin/prompt", requireAdmin, (req, res) =>
    adminController.getSystemPrompt(req, res)
  );
  app.put("/api/admin/prompt", requireAdmin, (req, res) =>
    adminController.updateSystemPrompt(req, res)
  );

  // LLM Config (must come before /api/admin/settings/:key to avoid param match)
  app.get("/api/admin/settings/llm_configs", requireAuth, requireAdminSection("models"), (req, res) =>
    adminController.getLLMConfigs(req, res)
  );
  app.put("/api/admin/settings/llm_configs", requireAuth, requireAdminSection("models"), (req, res) =>
    adminController.updateLLMConfigs(req, res)
  );

  // CRM landing-page chat settings (also before /api/admin/settings/:key)
  app.get("/api/admin/crm/settings", requireAuth, requireAdminSection("crm"), (req, res) =>
    adminController.getCrmChatSettings(req, res)
  );
  app.put("/api/admin/crm/settings", requireAuth, requireAdminSection("crm"), (req, res) =>
    adminController.updateCrmChatSettings(req, res)
  );

  // CRM customer admin
  app.get("/api/admin/crm/customers", requireAuth, requireAdminSection("crm"), (req, res) =>
    adminController.listCrmCustomers(req, res)
  );
  app.get("/api/admin/crm/customers/:id", requireAuth, requireAdminSection("crm"), (req, res) =>
    adminController.getCrmCustomer(req, res)
  );
  app.patch("/api/admin/crm/customers/:id", requireAuth, requireAdminSection("crm"), (req, res) =>
    adminController.updateCrmCustomer(req, res)
  );
  app.delete("/api/admin/crm/customers/:id", requireAuth, requireAdminSection("crm"), (req, res) =>
    adminController.deleteCrmCustomer(req, res)
  );
  app.get("/api/admin/crm/sessions/:id/log", requireAuth, requireAdminSection("crm"), (req, res) =>
    adminController.getCrmSessionLog(req, res)
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

  // Session history (admins with the "sessions" section permission). Tightened
  // from requireAdmin to admin-section gating — only the AdminDashboard
  // session-history page consumes these endpoints.
  app.get("/api/admin/sessions/aac", requireAuth, requireAdminSection("sessions"), (req, res) =>
    sessionHistoryController.getAACSessions(req, res)
  );
  app.get("/api/admin/sessions/aac/:id/log", requireAuth, requireAdminSection("sessions"), (req, res) =>
    sessionHistoryController.getAACSessionLog(req, res)
  );
  app.get("/api/admin/sessions/chat", requireAuth, requireAdminSection("sessions"), (req, res) =>
    sessionHistoryController.getChatSessions(req, res)
  );
  app.get("/api/admin/sessions/chat/:id/log", requireAuth, requireAdminSection("sessions"), (req, res) =>
    sessionHistoryController.getChatSessionLog(req, res)
  );
  // Full per-session debug trace (dual-agent-logger entries). Only populated
  // for sessions started with debugMode=true; empty array otherwise.
  app.get("/api/admin/sessions/:id/debug-log", requireAuth, requireAdminSection("sessions"), (req, res) =>
    sessionHistoryController.getSessionDebugLog(req, res)
  );

  // Activity logs (admins with the "activity-log" section permission)
  app.get("/api/admin/activity-logs", requireAuth, requireAdminSection("activity-log"), (req, res) =>
    activityLogController.getLogs(req, res)
  );

  // Insurance Bridge — RTM rollup. Member-of-institute + insuranceBridgeEnabled
  // permission checked inside the controller.
  app.get("/api/insurance/rtm", requireAuth, (req, res) =>
    insuranceBridgeController.getRtm(req, res)
  );

  // Insurance Bridge — clinician review-time rollup (98979 / 98980).
  app.get("/api/insurance/clinician-time", requireAuth, (req, res) =>
    insuranceBridgeController.getClinicianTime(req, res)
  );

  // Insurance Bridge — curated ICD-10 search.
  app.get("/api/insurance/icd10", requireAuth, (req, res) =>
    insuranceBridgeController.searchIcd(req, res)
  );

  // Insurance Bridge — Letters of Medical Necessity. Owning-institute scoping
  // + insuranceBridgeEnabled checked in the controller.
  app.get("/api/insurance/lmn", requireAuth, (req, res) =>
    insuranceBridgeController.listLmns(req, res)
  );
  app.post("/api/insurance/lmn", requireAuth, (req, res) =>
    insuranceBridgeController.createLmn(req, res)
  );
  app.get("/api/insurance/lmn/:id", requireAuth, (req, res) =>
    insuranceBridgeController.getLmn(req, res)
  );
  app.patch("/api/insurance/lmn/:id", requireAuth, (req, res) =>
    insuranceBridgeController.updateLmn(req, res)
  );
  app.post("/api/insurance/lmn/:id/finalize", requireAuth, (req, res) =>
    insuranceBridgeController.finalizeLmn(req, res)
  );

  // Insurance Bridge — clinician activity heartbeats. No permission gate
  // (every clinician's activity is welcome data); the rollup endpoint is
  // what's gated on insuranceBridgeEnabled.
  app.post("/api/insurance/activity/heartbeat", requireAuth, (req, res) =>
    insuranceBridgeController.heartbeat(req, res)
  );
  app.post("/api/insurance/activity/close", requireAuth, (req, res) =>
    insuranceBridgeController.closeActivity(req, res)
  );

  // Deep analyses — viewer across all students
  app.get("/api/admin/deep-analyses", requireAuth, requireAdminSection("deep-analyses"), (req, res) =>
    deepAnalysisController.adminList(req, res)
  );
  app.get("/api/admin/deep-analyses/:id", requireAuth, requireAdminSection("deep-analyses"), (req, res) =>
    deepAnalysisController.adminGet(req, res)
  );

  // Licenses
  app.get("/api/admin/licenses", requireAuth, requireAdminSection("licenses"), (req, res) =>
    licenseController.listLicenses(req, res)
  );
  app.get("/api/admin/licenses/:id", requireAuth, requireAdminSection("licenses"), (req, res) =>
    licenseController.getLicense(req, res)
  );
  app.post("/api/admin/licenses", requireAuth, requireAdminSection("licenses"), (req, res, next) => {
    if (req.is('multipart/form-data')) {
      upload.single("instituteLogo")(req, res, next);
    } else {
      next();
    }
  }, (req, res) =>
    licenseController.createLicense(req as any, res)
  );
  app.patch("/api/admin/licenses/:id", requireAuth, requireAdminSection("licenses"), (req, res) =>
    licenseController.updateLicense(req, res)
  );
  app.delete("/api/admin/licenses/:id", requireAuth, requireAdminSection("licenses"), (req, res) =>
    licenseController.deleteLicense(req, res)
  );
  app.post("/api/admin/licenses/:id/resend-invite", requireAuth, requireAdminSection("licenses"), (req, res) =>
    licenseController.resendInvite(req, res)
  );

  // Identity providers
  app.get("/api/admin/identity-providers", requireAuth, requireAdminSection("identity-providers"), (req, res) =>
    identityController.getProviders(req, res)
  );
  app.get("/api/admin/identity-providers/:id", requireAuth, requireAdminSection("identity-providers"), (req, res) =>
    identityController.getProvider(req, res)
  );
  app.post("/api/admin/identity-providers", requireAuth, requireAdminSection("identity-providers"), (req, res) =>
    identityController.createProvider(req, res)
  );
  app.patch("/api/admin/identity-providers/:id", requireAuth, requireAdminSection("identity-providers"), (req, res) =>
    identityController.updateProvider(req, res)
  );
  app.delete("/api/admin/identity-providers/:id", requireAuth, requireAdminSection("identity-providers"), (req, res) =>
    identityController.deleteProvider(req, res)
  );

  // Right-to-erasure (GDPR Art. 17 / IL Privacy Protection Law). Soft-delete
  // first; hard-delete cron sweeps after the cancellation window elapses.
  app.post("/api/admin/students/:id/erase", requireAuth, requireSystemAdmin, (req, res) =>
    studentErasureController.requestErasure(req, res)
  );
  app.post("/api/admin/students/:id/erase/cancel", requireAuth, requireSystemAdmin, (req, res) =>
    studentErasureController.cancelErasure(req, res)
  );
  app.get("/api/admin/students/:id/erasure-status", requireAuth, requireSystemAdmin, (req, res) =>
    studentErasureController.getStatus(req, res)
  );

  // Customer support (system admin)
  app.post("/api/admin/support-login", requireAuth, requireSystemAdmin, (req, res) =>
    authController.supportLogin(req, res)
  );
  app.post("/api/admin/support-logout", requireAuth, requireSystemAdmin, (req, res) =>
    authController.supportLogout(req, res)
  );

  // Contact inquiries
  app.get("/api/admin/contacts", requireAuth, requireAdminSection("contacts"), (req, res) =>
    contactController.list(req, res)
  );
  app.delete("/api/admin/contacts/:id", requireAuth, requireAdminSection("contacts"), (req, res) =>
    contactController.remove(req, res)
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

  // ============= DROPBOX INTEGRATION =============
  registerDropboxRoutes(app);

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

  // Set up WebSocket for Gemini Live API relay
  setupLiveWebSocket(httpServer);

  // Set up WebSocket for the Social Training Game bot relay
  setupSocialBotWebSocket(httpServer);

  // Set up generic realtime server (path-based routing) and register handlers.
  setupRealtimeServer(httpServer);

  // Initialize the cross-instance fanout bus and wire the user-chat dispatcher
  // into it. Selection (memory / postgres / redis) is via REALTIME_BUS env var.
  await initBus();
  initUserChatFanout();

  registerRealtimeHandler({
    path: "/ws/user-chat",
    onConnect: async (socket, user) => {
      const topics = await userChatService.initialTopicsForUser(user.id);
      for (const topic of topics) subscribe(socket, topic);
      socket.send(JSON.stringify({ type: "userChat:ready", topics }));
    },
  });

  return httpServer;
}