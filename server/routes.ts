import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import path from "path";
import { stringify } from "csv-stringify";
import { setupLiveWebSocket } from "./services/dual-agent/live-relay";
import { setupSocialBotWebSocket } from "./services/social-bot/social-bot-relay";
import { setupRealtimeServer, registerRealtimeHandler } from "./services/realtime/realtime-server";
import { subscribe, registerPersonSocket } from "./services/realtime/room-registry";
import { initBus } from "./services/realtime/bus-factory";
import { initPresence } from "./services/realtime/presence";
import { initPersonChatFanout } from "./services/personChat/personChatFanout";
import { personChatController } from "./controllers/personChatController";
import { personChatService } from "./services/personChat/personChatService";
import { personRepository } from "./repositories/personRepository";
import { initCallFanout } from "./services/call/callFanout";
import {
  initConversationRoomFanout,
  joinRoom as joinConversationRoom,
  leaveRoom as leaveConversationRoom,
} from "./services/dual-agent/conversation-room";
import { callService, CallError, CALL_PERSON_TOPIC } from "./services/call/callService";
import { buildIceConfig } from "./services/call/turnCredentials";
import { ClinicianStt } from "./services/call/clinician-stt";
import { logLiveSession } from "./services/dual-agent/dual-agent-logger";
import { createStreamingSession } from "./services/voice/google-stt-service";
import { listCallableContacts, listCallableStudentsForUser, userMayActAsStudent } from "./services/call/callContacts";
import { listSocialGameOptions } from "./services/social-game/socialGameOptions";
import { instituteService } from "./services/instituteService";
import type { CallClientCommand } from "@shared/realtime-events";

import {
  authController,
  profileController,
  studentController,
  inviteCodeController,
  savedLocationController,
  adminController,
  creditPackageController,
  paddleController,
  interpretationController,
  videoCaptionController,
  boardController,
  customAppController,
  deepAnalysisController,
  onboardingController,
  slpClinicalController,
  programController,
  instituteController,
  classroomController,
  sessionHistoryController,
  costUsageController,
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
import { chatSessionsController } from "./controllers/chatSessionsController";
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
import { studentDeviceController } from "./controllers/studentDeviceController";
import { calendarController } from "./controllers/calendarController";
import { locationController } from "./controllers/locationController";
import { incidentController } from "./controllers/incidentController";
import { registerDropboxRoutes } from "./services/dropboxRoutes";
import { activityLogService } from "./services/activityLogService";
import { activityLogController } from "./controllers/activityLogController";
import { insuranceBridgeController } from "./controllers/insuranceBridgeController";
import { identityController } from "./controllers/identityController";
import { studentErasureController } from "./controllers/studentErasureController";
import { cronController } from "./controllers/cronController";

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

/**
 * Join/leave a non-student (clinician) caller to the conversation room for a
 * call, with callbacks that deliver the room roster + "who's addressing me" over
 * this socket. The clinician becomes a full room member (so AAC students see
 * them in their headers and can address them). AAC students are excluded — they
 * join the room via their dual-agent session, keyed on the same personId.
 */
async function handleCallConversation(socket: any, personId: string, join: boolean, callId: string): Promise<void> {
  logLiveSession("CHAT_ROOM", `/ws/call call:conversation join=${join} callId=${callId} person=${personId}`);
  if (join) {
    const actingPerson = await personRepository.getById(personId);
    if (actingPerson?.studentId) {
      logLiveSession("CHAT_ROOM", `/ws/call skipping room-join: person=${personId} is a STUDENT (studentId=${actingPerson.studentId}) — joins via dual-agent instead`);
      return; // AAC student → joins via dual-agent
    }
    if (socket.__convRoomId === callId) return; // already in
    logLiveSession("CHAT_ROOM", `/ws/call CLINICIAN person=${personId} joining conversation room=${callId}`);
    const name = await personRepository.getDisplayName(personId);
    const roster = new Map<string, string>(); // personId → name
    socket.__convRoomId = callId;
    socket.__convRoster = roster;
    const sendRoster = () => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({
        type: "call:roster",
        participants: Array.from(roster.entries()).map(([pid, n]) => ({ personId: pid, name: n })),
      }));
    };
    joinConversationRoom(callId, {
      personId,
      name,
      onUtterance: () => { /* clinician hears peers via the call audio */ },
      onPresence: (p) => {
        if (p.joined) roster.set(p.personId, p.name);
        else roster.delete(p.personId);
        sendRoster();
      },
      onRoster: (members) => {
        for (const m of members) roster.set(m.personId, m.name);
        sendRoster();
      },
      onFloor: () => { /* the floor cue is for the AI; clinician doesn't need it */ },
      onPeerFocus: (f) => {
        if (f.targetPersonId !== personId || socket.readyState !== socket.OPEN) return;
        socket.send(JSON.stringify({ type: "call:addressed", fromPersonId: f.fromPersonId, fromName: f.fromName }));
      },
    });
  } else {
    const roomId: string | undefined = socket.__convRoomId;
    if (roomId) {
      leaveConversationRoom(roomId, personId);
      socket.__convRoomId = null;
      socket.__convRoster = null;
    }
    socket.__stt?.stop();
    socket.__stt = null;
  }
}

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
    // Machine-to-machine cron trigger — authenticated by a shared secret header,
    // not a session cookie, so CSRF doesn't apply.
    if (req.path === "/internal/run-crons") return next();
    return validateCSRF(req, res, next);
  });

  // ============ HEALTH CHECK =============
  app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ============ SCHEDULED MAINTENANCE (EventBridge → secret header) =============
  // Runs the erasure + retention sweeps on the Lambda deployment, where
  // setInterval doesn't fire. Guarded by the X-Cron-Secret shared secret.
  app.post("/internal/run-crons", (req, res) => cronController.runScheduledCrons(req, res));

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
  app.get("/api/consent/students/:studentId/authority", requireAuth, (req, res) =>
    consentController.getAuthority(req, res)
  );
  app.put("/api/consent/students/:studentId/authority", requireAuth, (req, res) =>
    consentController.setAuthority(req, res)
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

  // AAC device registration (limit set per license, summed across institutes)
  app.get("/api/students/:id/devices", requireAuth, (req, res) =>
    studentDeviceController.listDevices(req, res)
  );
  app.post("/api/students/:id/devices/register", requireAuth, (req, res) =>
    studentDeviceController.registerDevice(req, res)
  );
  app.post("/api/students/:id/devices/deregister", requireAuth, (req, res) =>
    studentDeviceController.deregisterSelf(req, res)
  );
  app.delete("/api/students/:id/devices/:recordId", requireAuth, (req, res) =>
    studentDeviceController.deregisterDevice(req, res)
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

  // ============= VIDEO CAPTION STUDIO ROUTES =============
  app.post("/api/video-caption/glyphs", requireAuth, (req, res) =>
    videoCaptionController.convertGlyphs(req, res)
  );
  app.post("/api/video-caption/ideas", requireAuth, (req, res) =>
    videoCaptionController.extractIdeas(req, res)
  );
  // Audio (LINEAR16 WAV, extracted client-side) → timestamped caption segments.
  app.post("/api/video-caption/transcribe", requireAuth, aacUpload.single("audio"), (req, res) =>
    videoCaptionController.transcribe(req as any, res)
  );
  // Short audio sample → detected spoken language (STT auto-detect pre-flight).
  app.post("/api/video-caption/detect-language", requireAuth, aacUpload.single("audio"), (req, res) =>
    videoCaptionController.detectLanguage(req as any, res)
  );
  // Caption projects — keyed by the video content hash, scoped to the user.
  app.get("/api/caption-projects/:hash", requireAuth, (req, res) =>
    videoCaptionController.getProject(req, res)
  );
  // Admin: list caption projects + their costs.
  app.get("/api/admin/caption-projects", requireAuth, requireAdminSection("sessions"), (req, res) =>
    videoCaptionController.listProjectsAdmin(req, res)
  );
  app.put("/api/caption-projects/:hash", requireAuth, (req, res) =>
    videoCaptionController.saveProject(req, res)
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
  // Goal-tree quest games are authored conversationally by the chat AI
  // (createQuestGame + manageMemory + validateQuestGame tools), not by a
  // server-side generation endpoint.
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

  // ============= PADDLE ROUTES =============
  app.get("/api/paddle/config", requireAuth, (req, res) =>
    paddleController.getConfig(req, res)
  );
  app.get("/api/paddle/prices", requireAuth, (req, res) =>
    paddleController.listPrices(req, res)
  );
  app.post("/api/paddle/test-price", requireAuth, (req, res) =>
    paddleController.createTestPrice(req, res)
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

  // ===== PAST CONVERSATIONS (clinician, own-data) =====
  // List / load / rename / delete the requesting user's own chat sessions for
  // the in-chat history sidebar. Scoped to req.user.id (NOT institute-wide —
  // that's the admin surface under /api/admin/sessions).
  app.get("/api/chat/sessions", requireAuth, (req, res) =>
    chatSessionsController.list(req, res)
  );
  app.get("/api/chat/sessions/:id", requireAuth, (req, res) =>
    chatSessionsController.get(req, res)
  );
  app.patch("/api/chat/sessions/:id", requireAuth, (req, res) =>
    chatSessionsController.rename(req, res)
  );
  app.delete("/api/chat/sessions/:id", requireAuth, (req, res) =>
    chatSessionsController.remove(req, res)
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
  app.post("/api/aac/youtube/resolve-channel", requireAuth, async (req, res) => {
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
  app.post("/api/aac/youtube/resolve", requireAuth, async (req, res) => {
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

  // ============= LOCATION ROUTES =============
  app.get("/api/locations", requireAuth, (req, res) =>
    locationController.list(req, res)
  );
  app.post("/api/locations/geocode", requireAuth, (req, res) =>
    locationController.geocode(req, res)
  );
  app.get("/api/locations/:id", requireAuth, (req, res) =>
    locationController.get(req, res)
  );
  app.post("/api/locations", requireAuth, (req, res) =>
    locationController.create(req, res)
  );
  app.patch("/api/locations/:id", requireAuth, (req, res) =>
    locationController.update(req, res)
  );
  app.delete("/api/locations/:id", requireAuth, (req, res) =>
    locationController.remove(req, res)
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

  // ============= PERSON CHAT ROUTES =============
  app.get("/api/person-chat/contacts", requireAuth, (req, res) =>
    personChatController.getContacts(req, res),
  );
  app.get("/api/person-chat/rooms", requireAuth, (req, res) =>
    personChatController.getRooms(req, res),
  );
  app.post("/api/person-chat/rooms", requireAuth, (req, res) =>
    personChatController.createRoom(req, res),
  );
  app.get("/api/person-chat/rooms/:id/messages", requireAuth, (req, res) =>
    personChatController.getMessages(req, res),
  );
  app.post("/api/person-chat/rooms/:id/messages", requireAuth, (req, res) =>
    personChatController.sendMessage(req, res),
  );
  app.post("/api/person-chat/rooms/:id/read", requireAuth, (req, res) =>
    personChatController.markRead(req, res),
  );
  app.post("/api/person-chat/push-register", requireAuth, (req, res) =>
    personChatController.registerPush(req, res),
  );

  // ============= LIVE CALL ROUTES =============
  // ICE servers for WebRTC. Always returns STUN; adds a self-hosted coturn TURN
  // relay with a freshly-minted, time-limited HMAC credential when TURN_URLS +
  // TURN_SECRET are configured (otherwise STUN-only). See turnCredentials.ts and
  // terraform/modules/coturn.
  app.get("/api/call/ice-servers", requireAuth, (req, res) => {
    const user = req.user as any;
    const { iceServers } = buildIceConfig(user?.id ?? "anon");
    res.json({ success: true, iceServers });
  });

  // Callable contacts for a student (with live online flags) — backs the AAC
  // "Phone call" app and incoming-caller resolution.
  app.get("/api/call/callable-contacts/:studentId", requireAuth, async (req, res) => {
    try {
      const user = req.user as any;
      const studentId = req.params.studentId;
      if (!(await userMayActAsStudent(user.id, studentId))) {
        res.status(403).json({ success: false, message: "No access to this student" });
        return;
      }
      const contacts = await listCallableContacts(studentId);
      res.json({ success: true, contacts });
    } catch (err) {
      console.error("[call] callable-contacts:", err);
      res.status(500).json({ success: false, message: "Failed to load callable contacts" });
    }
  });

  // Students who have listed the current user as a callable contact — lets a
  // clinician/caregiver call a student (the callable link is bidirectional).
  app.get("/api/call/callable-students", requireAuth, async (req, res) => {
    try {
      const user = req.user as any;
      const students = await listCallableStudentsForUser(user.id);
      res.json({ success: true, students });
    } catch (err) {
      console.error("[call] callable-students:", err);
      res.status(500).json({ success: false, message: "Failed to load callable students" });
    }
  });

  // Active participants of a call (personId + name), for the clinician's in-call
  // addressee picker. Only a participant in the call may read it.
  app.get("/api/call/:callId/participants", requireAuth, async (req, res) => {
    try {
      const user = req.user as any;
      const callId = req.params.callId;
      const person = await personRepository.getOrCreateForUser(user.id);
      const isMember = await callService.isParticipant(callId, person.id);
      if (!isMember && !user.isAdmin && !user.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not a participant in this call" });
        return;
      }
      const participants = (await callService.listParticipantsWithNames(callId))
        .filter((p) => p.personId !== person.id); // exclude self
      res.json({ success: true, participants });
    } catch (err) {
      console.error("[call] participants:", err);
      res.status(500).json({ success: false, message: "Failed to load participants" });
    }
  });

  // Social games a clinician can attach to a call: the built-in default world +
  // the selected institute's multiplayer custom apps (each with its WorldSpec).
  app.get("/api/social-game/options/:instituteId", requireAuth, async (req, res) => {
    try {
      const user = req.user as any;
      const instituteId = req.params.instituteId;
      // Only members of the institute may enumerate its games.
      const institutes = await instituteService.getUserInstitutes(user.id);
      const isMember = institutes.some((i) => i.id === instituteId);
      if (!isMember && !user.isAdmin && !user.isSystemAdmin) {
        res.status(403).json({ success: false, message: "No access to this organization" });
        return;
      }
      const options = await listSocialGameOptions(instituteId);
      res.json({ success: true, options });
    } catch (err) {
      console.error("[social-game] options:", err);
      res.status(500).json({ success: false, message: "Failed to load social games" });
    }
  });

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
  // Bulk-prune debug logs older than a given date. Body: { before: ISO date }.
  app.delete("/api/admin/sessions/debug-logs", requireAuth, requireAdminSection("sessions"), (req, res) =>
    sessionHistoryController.deleteSessionDebugLogsBefore(req, res)
  );

  // Cost & usage analytics dashboard (admins with the "cost-usage" section
  // permission). Aggregated from existing chat_sessions data — no new tables.
  app.get("/api/admin/cost-usage", requireAuth, requireAdminSection("cost-usage"), (req, res) =>
    costUsageController.getAnalytics(req, res)
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
  // STOPGAP: manual sweep trigger because the scheduled sweep doesn't fire on
  // Lambda (registered before :id routes so "erasure" isn't captured as :id).
  app.post("/api/admin/students/erasure/run-sweep", requireAuth, requireSystemAdmin, (req, res) =>
    studentErasureController.runSweep(req, res)
  );
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

  // Initialize the cross-instance fanout bus and wire the person-chat dispatcher
  // into it. Selection (memory / postgres / redis) is via REALTIME_BUS env var.
  await initBus();
  initPresence();
  initPersonChatFanout();
  initCallFanout();
  initConversationRoomFanout();

  registerRealtimeHandler({
    path: "/ws/person-chat",
    onConnect: async (socket, user) => {
      // The connected user acts as its own person here (acting-as-a-student is
      // deferred to the call/AAC client). Register the socket under that person
      // so room subscriptions can target it, then subscribe + announce.
      const person = await personRepository.getOrCreateForUser(user.id);
      registerPersonSocket(person.id, socket);
      const topics = await personChatService.initialTopicsForPerson(person.id);
      for (const topic of topics) subscribe(socket, topic);
      socket.send(JSON.stringify({ type: "personChat:ready", topics, selfPersonId: person.id }));
    },
  });

  registerRealtimeHandler({
    path: "/ws/call",
    onConnect: async (socket, user) => {
      // By default the connected user acts as its own person. The AAC client
      // declares `call:act-as` to act as the student it fronts (validated below).
      const person = await personRepository.getOrCreateForUser(user.id);
      (socket as any).__actingPersonId = person.id;
      registerPersonSocket(person.id, socket);
      subscribe(socket, CALL_PERSON_TOPIC(person.id));
      socket.send(JSON.stringify({ type: "call:ready", selfPersonId: person.id }));
    },
    onCommand: async (socket, user, message) => {
      const cmd = message as CallClientCommand;
      if (typeof cmd?.type !== "string" || !cmd.type.startsWith("call:")) return;

      // Switch the socket's acting person to a student the user serves.
      if (cmd.type === "call:act-as") {
        const serves = await userMayActAsStudent(user.id, cmd.studentId);
        if (!serves) {
          socket.send(JSON.stringify({ type: "call:error", payload: { code: "forbidden", message: "Not allowed to act as this student" } }));
          return;
        }
        const studentPerson = await personRepository.getOrCreateForStudent(cmd.studentId);
        (socket as any).__actingPersonId = studentPerson.id;
        registerPersonSocket(studentPerson.id, socket);
        subscribe(socket, CALL_PERSON_TOPIC(studentPerson.id));
        socket.send(JSON.stringify({ type: "call:ready", selfPersonId: studentPerson.id }));
        return;
      }

      const personId: string = (socket as any).__actingPersonId
        ?? (await personRepository.getOrCreateForUser(user.id)).id;
      try {
        switch (cmd.type) {
          case "call:invite":
            await callService.invite(personId, { callId: cmd.callId, roomId: cmd.roomId, media: cmd.media });
            break;
          case "call:invite-contact":
            await callService.inviteContact(personId, { callId: cmd.callId, contactId: cmd.contactId, media: cmd.media });
            break;
          case "call:accept":
            await callService.accept(personId, { callId: cmd.callId });
            break;
          case "call:decline":
            await callService.decline(personId, { callId: cmd.callId, reason: cmd.reason });
            break;
          case "call:cancel":
            await callService.cancel(personId, { callId: cmd.callId });
            break;
          case "call:signal":
            await callService.signal(personId, { callId: cmd.callId, to: cmd.to, signal: cmd.signal });
            break;
          case "call:media-state":
            await callService.mediaState(personId, { callId: cmd.callId, audio: cmd.audio, video: cmd.video, pose: cmd.pose });
            break;
          case "call:set-game":
            // Attach/detach a social game on the call — turns the call panel into
            // the game surface for everyone in it (no new ring).
            await callService.setGame(personId, { callId: cmd.callId, game: cmd.game });
            break;
          case "call:start-solo-game":
            // Open a joinable one-person room with a game (no ring).
            await callService.startSoloGame(personId, { callId: cmd.callId, game: cmd.game });
            break;
          case "call:invite-into-call":
            // Ring a contact INTO the existing call (grow a solo game).
            await callService.inviteIntoCall(personId, { callId: cmd.callId, contactId: cmd.contactId, media: cmd.media });
            break;
          case "call:world":
            // Relay this participant's avatar position to the call — the
            // world-wide position channel feeding the circle solver.
            await callService.publishWorld(personId, { callId: cmd.callId, presence: cmd.presence });
            break;
          case "call:npc":
            // Relay an AI-NPC conversation message to every participant (reliable,
            // independent of the proximity-pruned media mesh).
            await callService.publishNpc(personId, { callId: cmd.callId, msg: cmd.msg });
            break;
          case "call:leave":
            await callService.leave(personId, { callId: cmd.callId });
            break;
          case "call:focus":
            // Caller picked who they're addressing → relay into the conversation
            // room so the addressed AAC student's AI can prepare a response.
            // Remember it so the caller's spoken utterances inherit the addressee.
            (socket as any).__addressee = cmd.to ?? "ROOM";
            await callService.focus(personId, { callId: cmd.callId, to: cmd.to ?? null });
            break;
          case "call:utterance": {
            // PRIMARY: a non-student caller's Web-Speech transcript → publish
            // into the conversation room. Gated on room membership.
            const roomId: string | undefined = (socket as any).__convRoomId;
            const text = typeof cmd.text === "string" ? cmd.text.trim() : "";
            if (roomId && text) {
              logLiveSession("CLINICIAN_STT", `call:utterance (Web Speech) text="${text}" → publish to room=${roomId} addressee=${(socket as any).__addressee ?? "ROOM"}`);
              await callService.utterance(personId, { callId: roomId, text, addressee: (socket as any).__addressee ?? "ROOM" });
            }
            break;
          }
          case "call:audio": {
            // FALLBACK: a non-student caller's mic PCM → server STT → publish each
            // phrase into the conversation room. Gated on room membership
            // (clinician members only; AAC students are transcribed on-device).
            const roomId: string | undefined = (socket as any).__convRoomId;
            if (!roomId || typeof cmd.chunk !== "string") {
              if (!(socket as any).__audioDropLogged) {
                (socket as any).__audioDropLogged = true;
                logLiveSession("CLINICIAN_STT", `DROPPING call:audio — convRoomId=${roomId ?? "(not joined)"} chunkType=${typeof cmd.chunk}. Clinician not in conversation room → no STT. (logged once)`);
              }
              break;
            }
            let stt: ClinicianStt | undefined = (socket as any).__stt;
            if (!stt) {
              logLiveSession("CLINICIAN_STT", `first call:audio chunk for room=${roomId} person=${personId} lang=${cmd.lang ?? "?"} sampleRate=${cmd.sampleRate} — creating STT session`);
              stt = new ClinicianStt(
                cmd.lang,
                (text) => {
                  const rid: string | undefined = (socket as any).__convRoomId;
                  logLiveSession("CLINICIAN_STT", `STT onFinal text="${text}" → publish to room=${rid ?? "(none)"} addressee=${(socket as any).__addressee ?? "ROOM"}`);
                  if (!rid) return;
                  void callService
                    .utterance(personId, { callId: rid, text, addressee: (socket as any).__addressee ?? "ROOM" })
                    .catch((err) => console.warn("[call] utterance publish failed:", err?.message));
                },
                typeof cmd.sampleRate === "number" && cmd.sampleRate > 0 ? cmd.sampleRate : 48000,
                // Echo the live transcript back so the caller can see what the
                // recognizer is hearing (debug + a self-caption).
                (text, isFinal) => {
                  if (socket.readyState === socket.OPEN) {
                    socket.send(JSON.stringify({ type: "call:transcript", text, isFinal }));
                  }
                },
              );
              (socket as any).__stt = stt;
            }
            stt.feed(cmd.chunk);
            break;
          }
          case "call:conversation":
            // A non-student (clinician) caller joins/leaves the conversation room
            // for this call, so they appear in AAC students' rosters and receive
            // roster + "who's addressing me" updates over this socket. AAC
            // students join the room via their dual-agent session instead.
            await handleCallConversation(socket, personId, cmd.join, cmd.callId);
            break;
        }
      } catch (err: any) {
        const code = err instanceof CallError ? err.code : "error";
        console.warn(`[call] command ${cmd.type} (acting=${personId}) failed: ${code} — ${err?.message}`);
        socket.send(JSON.stringify({
          type: "call:error",
          payload: { callId: (cmd as any).callId, code, message: err?.message ?? "Call error" },
        }));
      }
    },
    onClose: (socket) => {
      // Leave any conversation room this socket joined + tear down its STT
      // session (clinician disconnects).
      const roomId = (socket as any).__convRoomId as string | undefined;
      const personId = (socket as any).__actingPersonId as string | undefined;
      if (roomId && personId) {
        try { leaveConversationRoom(roomId, personId); } catch { /* ignore */ }
      }
      try { (socket as any).__stt?.stop(); } catch { /* ignore */ }
      (socket as any).__stt = null;
    },
  });

  // ============= STT TEST HARNESS =============
  // A standalone sandbox for evaluating server-side (Google Cloud) STT quality
  // in isolation from the call machinery. The client streams mic PCM; we feed it
  // to a streaming recognizer and stream interim/final transcripts back. Lets us
  // compare server-side STT against the browser's Web Speech API and tune
  // capture constraints / model without touching live calls.
  registerRealtimeHandler({
    path: "/ws/stt-test",
    onConnect: (socket) => {
      socket.send(JSON.stringify({ type: "stt:ready" }));
    },
    onCommand: (socket, _user, message) => {
      const msg = message as any;
      if (typeof msg?.type !== "string") return;
      const s = socket as any;
      const send = (obj: unknown) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj)); };
      if (msg.type === "stt:start") {
        try { s.__sttTest?.abort(); } catch { /* ignore */ }
        s.__sttTest = createStreamingSession({
          sampleRateHertz: typeof msg.sampleRate === "number" && msg.sampleRate > 0 ? msg.sampleRate : 48000,
          languageHint: typeof msg.lang === "string" ? msg.lang : undefined,
          model: typeof msg.model === "string" && msg.model ? msg.model : "latest_short",
          onInterim: (text) => send({ type: "stt:interim", text }),
          onFinal: (text) => send({ type: "stt:final", text }),
          onError: (error) => send({ type: "stt:error", error }),
        });
        send({ type: "stt:started", sampleRate: msg.sampleRate, model: msg.model ?? "latest_short" });
      } else if (msg.type === "stt:audio") {
        if (s.__sttTest && typeof msg.chunk === "string") s.__sttTest.write(msg.chunk);
      } else if (msg.type === "stt:stop") {
        try { void s.__sttTest?.end(); } catch { /* ignore */ }
        s.__sttTest = null;
      }
    },
    onClose: (socket) => {
      try { (socket as any).__sttTest?.abort(); } catch { /* ignore */ }
      (socket as any).__sttTest = null;
    },
  });

  return httpServer;
}