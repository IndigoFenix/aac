import { pgTable, text, serial, integer, boolean, timestamp, real, varchar, jsonb, index, uniqueIndex, numeric, AnyPgColumn, pgEnum, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { z } from "zod";

// =============================================================================
// ENUMS
// All pgEnums live here (needed by private tables; re-exported via schema.ts)
// =============================================================================

export const apiTypeEnum = pgEnum("api_type", [
  "llm", "tts", "stt", "embedding", "image", "vector", "moderation", "tool", "other"
]);

export const chatSessionStatusEnum = pgEnum("chat_session_status", ["open", "paused", "closed"]);

export const instituteTypeEnum = pgEnum("institute_type", ["school", "clinic", "family"]);

// IEP/TALA specific enums
export const programFrameworkEnum = pgEnum("program_framework", ["tala", "us_iep"]);
export const programStatusEnum = pgEnum("program_status", ["draft", "active", "archived"]);
export const profileDomainTypeEnum = pgEnum("profile_domain_type", [
  "cognitive_academic",
  "communication_language",
  "social_emotional_behavioral",
  "motor_sensory",
  "life_skills_preparation",
  "other"
]);
export const assessmentSourceTypeEnum = pgEnum("assessment_source_type", [
  "standardized_test",
  "structured_observation",
  "parent_questionnaire",
  "teacher_input",
  "curriculum_based",
  "behavioral_records"
]);
export const interventionLevelEnum = pgEnum("intervention_level", ["activity", "function", "participation"]);
// GAS (Goal Attainment Scaling) enums — TALA-aligned goal scoring
export const gasLevelEnum = pgEnum("gas_level", [
  "much_less_than_expected",  // -2
  "less_than_expected",        // -1
  "expected",                  //  0
  "better_than_expected",      // +1
  "much_better_than_expected", // +2
]);
export const gasVaryingVariableEnum = pgEnum("gas_varying_variable", [
  "achievement", // level of skill acquired
  "mediation",   // amount of prompting/support
  "time",        // duration / response time
  "frequency",   // occurrences per window
]);
// Unified status enum for any planning item (goals, objectives, transition goals).
// "draft" and "not_started" are accepted synonyms for pre-work state; "active"
// and "in_progress" are accepted synonyms for work-in-progress state. Keeping
// both in the enum preserves pre-existing data while letting callers use
// whichever term reads more naturally in context.
export const planItemStatusEnum = pgEnum("plan_item_status", [
  "draft",
  "not_started",
  "active",
  "in_progress",
  "achieved",
  "modified",
  "discontinued",
]);
// Aliases for readability at usage sites. All three point at the same enum.
export const goalStatusEnum = planItemStatusEnum;
export const objectiveStatusEnum = planItemStatusEnum;
export const serviceTypeEnum = pgEnum("service_type", [
  "speech_language_therapy",
  "occupational_therapy",
  "physical_therapy",
  "counseling",
  "specialized_instruction",
  "consultation",
  "aac_support",
  "other"
]);
export const serviceDeliveryModelEnum = pgEnum("service_delivery_model", ["direct", "consultation", "collaborative", "indirect"]);
export const serviceSettingEnum = pgEnum("service_setting", [
  "general_education",
  "resource_room",
  "self_contained",
  "home",
  "community",
  "therapy_room"
]);
export const accommodationTypeEnum = pgEnum("accommodation_type", [
  "visual_support",
  "aac_device",
  "modified_materials",
  "extended_time",
  "simplified_language",
  "environmental_modification",
  "other"
]);
export const progressStatusEnum = pgEnum("progress_status", [
  "significant_progress",
  "making_progress",
  "limited_progress",
  "no_progress",
  "regression",
  "goal_met"
]);
export const meetingTypeEnum = pgEnum("meeting_type", [
  "initial_evaluation",
  "annual_review",
  "reevaluation",
  "amendment",
  "transition_planning",
  "progress_review"
]);
export const consentTypeEnum = pgEnum("consent_type", [
  "initial_evaluation",
  "reevaluation",
  "placement",
  "release_of_information",
  "service_provision"
]);
export const transitionAreaEnum = pgEnum("transition_area", ["education", "employment", "independent_living", "community"]);
export const teamMemberRoleEnum = pgEnum("team_member_role", [
  "parent_guardian",
  "student",
  "homeroom_teacher",
  "special_education_teacher",
  "general_education_teacher",
  "speech_language_pathologist",
  "occupational_therapist",
  "physical_therapist",
  "psychologist",
  "administrator",
  "case_manager",
  "external_provider",
  "other"
]);
export const sensitivityCategoryEnum = pgEnum("sensitivity_category", [
  "medical",
  "psychological",
  "behavioral",
  "educational",
  "legal",
  "financial"
]);
export const reportStatusEnum = pgEnum("report_status", [
  "draft",
  "pending_review",
  "final",
  "superseded"
]);
export const instituteInviteStatusEnum = pgEnum("institute_invite_status", [
  "pending",
  "accepted",
  "declined",
  "expired",
  "cancelled"
]);
export const instituteRoleEnum = pgEnum("institute_role", [
  "admin",       // Full administrative access
  "director",    // Director/Principal - high-level oversight
  "teacher",     // Classroom teacher
  "therapist",   // Speech therapist, OT, PT, etc.
  "aide",        // Teaching aide/assistant
  "parent",      // Parent/guardian of a student
  "staff",       // General staff member
  "observer",    // Read-only access for observers/interns
]);
export const classroomRoleEnum = pgEnum("classroom_role", [
  "lead_teacher",    // Primary teacher responsible for the classroom
  "co_teacher",      // Co-teaching partner
  "therapist",       // Therapist assigned to this classroom
  "aide",            // Classroom aide
  "observer",        // Observer with read-only access
]);
export const gradeEnum = pgEnum("grade", [
  "pre_k", "k", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12",
  "special_ed", "adult_ed"
]);
export type GradeEnum = (typeof gradeEnum.enumValues)[number];
export const GRADE_OPTIONS = [
  { value: 'pre_k', label: 'Pre-K' },
  { value: 'k', label: 'Kindergarten' },
  { value: '1', label: '1st Grade' },
  { value: '2', label: '2nd Grade' },
  { value: '3', label: '3rd Grade' },
  { value: '4', label: '4th Grade' },
  { value: '5', label: '5th Grade' },
  { value: '6', label: '6th Grade' },
  { value: '7', label: '7th Grade' },
  { value: '8', label: '8th Grade' },
  { value: '9', label: '9th Grade' },
  { value: '10', label: '10th Grade' },
  { value: '11', label: '11th Grade' },
  { value: '12', label: '12th Grade' },
  { value: 'special_ed', label: 'Special Education' },
  { value: 'adult_ed', label: 'Adult Education' },
];

// Export role arrays for use in frontend dropdowns
export const INSTITUTE_ROLES = [
  { value: "admin", labelKey: "institute.roles.admin" },
  { value: "director", labelKey: "institute.roles.director" },
  { value: "teacher", labelKey: "institute.roles.teacher" },
  { value: "therapist", labelKey: "institute.roles.therapist" },
  { value: "aide", labelKey: "institute.roles.aide" },
  { value: "parent", labelKey: "institute.roles.parent" },
  { value: "staff", labelKey: "institute.roles.staff" },
  { value: "observer", labelKey: "institute.roles.observer" },
] as const;

export const CLASSROOM_ROLES = [
  { value: "lead_teacher", labelKey: "classroom.roles.leadTeacher" },
  { value: "co_teacher", labelKey: "classroom.roles.coTeacher" },
  { value: "therapist", labelKey: "classroom.roles.therapist" },
  { value: "aide", labelKey: "classroom.roles.aide" },
  { value: "observer", labelKey: "classroom.roles.observer" },
] as const;

export type InstituteRole = typeof INSTITUTE_ROLES[number]["value"];
export type ClassroomRole = typeof CLASSROOM_ROLES[number]["value"];

export const verificationStatusEnum = pgEnum("verification_status", ["unverified", "pending", "verified"]);
export const identityProviderProtocolEnum = pgEnum("identity_provider_protocol", ["oidc", "oauth2", "saml"]);

// Guardian verification + informed consent (see planning-docs/student-consent-onboarding-plan.md)
export const governmentIdTypeEnum = pgEnum("government_id_type", [
  "national_id", "passport", "driver_license", "other",
]);
export const idVerificationSourceEnum = pgEnum("id_verification_source", [
  "manual_entry", "gov_sso", "third_party_idv",
]);
export const shareLegalBasisEnum = pgEnum("share_legal_basis", [
  "guardian_consent", "institutional_delegate", "formal_release_of_information",
]);

// Cross-institute student sharing (see planning-docs/cross-institute-sharing-plan.md)
export const shareInviteStatusEnum = pgEnum("share_invite_status", [
  "pending_guardian",       // awaiting guardian co-sign
  "pending_target",         // guardian approved, code redeemable
  "pending_target_confirm", // code redeemed, target reviewing
  "accepted",               // share live
  "declined",
  "revoked",
  "expired",
]);

export const sharePermissionEnum = pgEnum("share_permission", ["read", "write"]);

export const shareableObjectTypeEnum = pgEnum("shareable_object_type", [
  "program",
  "medical_record",
  "functional_report",
  "educational_report",
  "incident",
  "deep_analysis",
  "custom_app_assignment",
  "monitor_note",
]);

export const activityEventTypeEnum = pgEnum("activity_event_type", [
  "create", "update", "delete", "link", "unlink", "view", "finalize", "revision",
  "share_invite_created",
  "share_guardian_approved",
  "share_redeemed",
  "share_accepted",
  "share_declined",
  "share_revoked",
  "share_expired",
  "standing_share_granted",
  "standing_share_revoked",
  "consent_signed",
  "consent_revoked",
  "consent_re_signed",
  "guardian_id_verified",
  "minor_threshold_crossed",
  // A student's consent-authority determination (guardian vs. self) was set or
  // changed. Subject is the student. Details carry the mode + basis.
  "consent_authority_set",
  // A student on the age-default ("auto") reached the age of majority while an
  // active guardian-signed consent is on file — a clinician must confirm
  // self-consent or record a guardianship basis. Subject is the student.
  "consent_authority_review_required",
  // Authentication audit events. Subject is always a `user`. Used for
  // login surveillance and MFA challenge tracking — required for HIPAA /
  // IL MoE auditability.
  "auth_login_success",
  "auth_login_failure",
  "auth_logout",
  "auth_mfa_challenge",
  "auth_mfa_success",
  "auth_mfa_failure",
  "auth_password_reset_requested",
  "auth_password_reset_completed",
  // Right-to-erasure (GDPR Art. 17 / IL Privacy Protection Law) lifecycle.
  // Subject is always a `student`. These event types are exempt from the
  // activity-log retention cron — they are compliance evidence that
  // outlives every other audit row, including the rows of the student
  // they refer to.
  "student_erasure_requested",
  "student_erasure_cancelled",
  "student_erasure_completed",
  // AAC sleep transitions. Subject is the student. Details carry
  // `{ sessionId, fromState, toState, source }`. Used by the Insurance
  // Bridge module to subtract sleep windows from RTM service-time totals.
  "aac_sleep_state_change",
  // Insurance Bridge: LMN auto-generator lifecycle. Subject is the student.
  // Details carry `{ lmnId }`. Used for billing audit.
  "lmn_generated",
  "lmn_finalized",
  // Insurance Bridge: a clinician opened a fresh review interval for a
  // student. Subject is the student. Details carry `{ intervalId }`. Logged
  // once per interval — heartbeat extensions are NOT audited (too noisy).
  "rtm_review_recorded",
  // AAC device registration lifecycle. Subject is the student; subject2 is the
  // user who triggered it. Details carry `{ deviceId, deviceName }`.
  "device_registered",
  "device_deregistered",
]);

export const activitySubjectTypeEnum = pgEnum("activity_subject_type", [
  "student", "classroom", "institute", "user", "board", "custom_symbol",
  "program", "goal", "objective", "service", "accommodation",
  "progress_report", "data_point", "team_member", "program_contact",
  "student_contact", "biometric_data", "meeting",
  "medical_record", "functional_report", "educational_report",
  "profile_domain", "invite", "consent_form", "transition_plan", "transition_goal",
  "custom_app", "deep_analysis",
  "share_invite", "object_share", "standing_share",
  "incident", "monitor_note", "custom_app_assignment",
  "consent_record",
]);

// =============================================================================
// USER / AUTH TABLES (Private)
// =============================================================================

// App users table for main application users
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  fullName: text("full_name"),
  googleId: text("google_id").unique(),
  profileImageUrl: text("profile_image_url"),
  password: text("password"), // Optional for Google OAuth users
  authProvider: text("auth_provider").default("email"), // 'email' or 'google'
  userType: text("user_type").notNull().default("Caregiver"), // 'admin', 'Teacher', 'Caregiver', 'SLP', 'Parent'
  isAdmin: boolean("is_admin").default(false).notNull(),
  credits: integer("credits").default(10).notNull(),
  subscriptionType: text("subscription_type").default("free"), // free, premium, enterprise
  subscriptionExpiresAt: timestamp("subscription_expires_at"),
  isActive: boolean("is_active").default(true).notNull(),
  lastActiveAt: timestamp("last_active_at").defaultNow(),
  onboardingStep: integer("onboarding_step").default(0).notNull(), // 0=new, 1=profile done, 3=complete
  referralCode: text("referral_code").unique(), // Unique code for user to share with others
  isSystemAdmin: boolean("is_system_admin").default(false).notNull(), // Full system admin rights

  // self-referencing FK
  referredById: varchar("referred_by_id").references(
    (): AnyPgColumn => users.id,
  ),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  genCapOverride: integer("gen_cap_override"),
  dlCapOverride: integer("dl_cap_override"),
  storedBoardsCap: integer("stored_boards_cap"),

  // Chat system fields
  chatMemory: jsonb("chat_memory").default({}), // User-specific memory values for chat
  chatCreditsUsed: real("chat_credits_used").notNull().default(0),
  chatCreditsUpdated: timestamp("chat_credits_updated").defaultNow(),

  // MFA fields
  mfaEnabled: boolean("mfa_enabled").default(false).notNull(),
  mfaSecret: text("mfa_secret"), // Encrypted TOTP secret
  mfaEnforcedByAdmin: boolean("mfa_enforced_by_admin").default(false).notNull(),

  phone: text("phone"), // E.164
  phoneVerifiedAt: timestamp("phone_verified_at"),

  // Biometric data — references shared biometric_data table (one row per real person).
  biometricDataId: varchar("biometric_data_id"),

  // External storage — when set, sensitive fields are stored in the named backend
  externalStorage: varchar("external_storage"),
});

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_password_reset_tokens_user_id").on(table.userId),
  index("idx_password_reset_tokens_expires_at").on(table.expiresAt),
]);

export const mfaRecoveryTokens = pgTable("mfa_recovery_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_mfa_recovery_tokens_user_id").on(table.userId),
  index("idx_mfa_recovery_tokens_expires_at").on(table.expiresAt),
]);

// =============================================================================
// STUDENT TABLES (Private)
// =============================================================================

// Student profiles table (AAC Users)
export const students = pgTable("students", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  firstName: text("first_name"),
  lastName: text("last_name"),
  name: text("name").notNull(), // Human-readable name
  gender: text("gender"), // 'male', 'female', 'other'
  birthDate: date("birth_date"), // Date of birth

  // Educational framework
  framework: programFrameworkEnum("framework").default("tala"), // 'tala' | 'us_iep'
  country: text("country").default("IL"), // 'IL', 'US', etc.
  primaryLanguage: text("primary_language").default("he"), // Primary language code
  additionalLanguages: text("additional_languages").array(), // Additional language codes

  // Chat system fields
  chatMemory: jsonb("chat_memory").default({}), // Student-specific memory values for chat
  chatCreditsUsed: real("chat_credits_used").notNull().default(0),
  chatCreditsUpdated: timestamp("chat_credits_updated").defaultNow(),
  // Persistent multi-window budget-meter state (the layer above the per-session
  // energy meter). One leaky-bucket {drain, asOf} per window keyed by window key
  // (e.g. "3h"/"3d"/"14d"). Survives across sessions so the monthly cap holds.
  // Shape = shared/aac/budget-meter.ts BudgetState. See planning-docs/aac-budget-tiers-spec.md §7.
  budgetMeters: jsonb("budget_meters").default({}),

  // Stable, clinician-curated description of how this student communicates —
  // verbal abilities, AAC use, vocalization patterns, etc. Backs the
  // Student_CommunicationProfile memory field. Stored as a column (not in
  // chatMemory jsonb) so the AAC monitor agent's session-time mutations to
  // chatMemory cannot overwrite it.
  communicationProfile: text("communication_profile"),

  // Biometric data — references shared biometric_data table.
  biometricDataId: varchar("biometric_data_id"),

  // External storage — when set, sensitive fields are stored in the named backend
  externalStorage: varchar("external_storage"),

  // Legacy-consent grace window: students that pre-date the informed-consent
  // feature are exempt from the consent gate until this timestamp. New students
  // get null (must collect consent before PHI ops). The migration backfills
  // existing rows with now + 90 days. Admins can extend per-student.
  // See planning-docs/student-consent-onboarding-plan.md.
  legacyConsentDeadline: timestamp("legacy_consent_deadline", { withTimezone: true }),

  // Consent authority — who may consent for this student. "auto" (default)
  // derives from the age of majority (guardian below it, self at/above). The
  // overrides handle exceptions: "guardian_required" for an adult under legal
  // guardianship, "self" for a self-consenting minor. See consent-authority.ts.
  // Stored as text (closed set lives in shared/legal types).
  consentAuthority: text("consent_authority").default("auto").notNull(),
  // For an adult under guardianship: the legal instrument the guardian acts
  // under (court_appointed_guardian / limited_guardian / supported_decision_making
  // / power_of_attorney). Required when consentAuthority === "guardian_required"
  // and the student is at/above the age of majority.
  guardianshipBasis: text("guardianship_basis"),
  // Supporting evidence for the guardianship determination (court-order ref,
  // issuing authority, document references, notes).
  guardianshipEvidence: jsonb("guardianship_evidence"),
  // When the guardianship order should be re-reviewed / expires.
  guardianshipReviewDate: date("guardianship_review_date"),
  // Audit: who set the current consent-authority determination and when.
  consentAuthoritySetByUserId: varchar("consent_authority_set_by_user_id").references(() => users.id),
  consentAuthoritySetAt: timestamp("consent_authority_set_at", { withTimezone: true }),

  // Status and metadata
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),

  // Right-to-erasure (GDPR Art. 17 / IL Privacy Protection Law).
  // `deletedAt` is the tombstone — when set, the student is invisible to
  // every non-admin query and access checks return false. All linked PHI
  // is preserved until `scheduledHardDeleteAt` arrives, giving the user
  // a window to cancel an accidental deletion. The hard-delete cron
  // (`studentErasureCron`) walks rows where `scheduledHardDeleteAt <= now`
  // and cascades through the PHI tables. See planning-docs / F.2.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  scheduledHardDeleteAt: timestamp("scheduled_hard_delete_at", { withTimezone: true }),
}, (table) => [
  index("idx_students_framework").on(table.framework),
  index("idx_students_is_active").on(table.isActive),
  index("idx_students_scheduled_hard_delete_at").on(table.scheduledHardDeleteAt),
]);

// AAC settings — one-to-one with students, contains all AAC-specific configuration
export const aacSettings = pgTable("aac_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").references(() => students.id).notNull().unique(),

  // Core AAC flags
  enabled: boolean("enabled").default(false), // Whether AAC mode is enabled
  demoMode: boolean("demo_mode").default(false), // Demo scenario enabled
  demoScenario: text("demo_scenario"), // Which demo scenario to use

  // AI chat behavior
  // Two distinct per-student AAC prompt fields, both edited ONLY during
  // clinician interactions (the live AAC moderator can never write either).
  // Each is a LIST of rules/notes (jsonb array of strings) — one entry per
  // request — so the AI grows the list and removes an entry only when a newer
  // one contradicts it or it becomes irrelevant, instead of replacing the lot.
  // Legacy single-string values are wrapped into a 1-element array (migration
  // 0121); runtime readers normalize string | string[] defensively.
  //   chatAgentPrompt — the CUSTOM list: specific behaviors caretakers have
  //     explicitly requested. Rigid; changed only when a caretaker asks. Takes
  //     priority over the auto list (except where it clashes with safety).
  //   autoAacPrompt — the AUTO list: notes the clinician AI generates and keeps
  //     current as it learns new things about the student. It is "what the AAC
  //     needs to know about this student" — the live startup AI can't dig
  //     through reports, so this stands in for that detail.
  chatAgentPrompt: jsonb("chat_agent_prompt").$type<string[]>(), // CUSTOM list (caretaker-requested behaviors)
  autoAacPrompt: jsonb("auto_aac_prompt").$type<string[]>(), // AUTO list (AI-generated student notes)
  modelOverride: text("model_override"), // AI model override (e.g., 'chatgpt5')
  startupMode: integer("startup_mode").default(0), // DEPRECATED: no behavioral effect — startup is always thorough. Kept (selectable/saveable) for settings compatibility.

  // Voice settings
  voiceType: text("voice_type"), // AI voice: 'auto', 'man', 'woman', 'boy', 'girl'
  studentVoiceType: text("student_voice_type"), // Student's voice: 'man', 'woman', 'boy', 'girl'
  customVoiceId: varchar("custom_voice_id"), // FK to voices table for custom AI voice (ElevenLabs)
  customStudentVoiceId: varchar("custom_student_voice_id"), // FK to voices table for custom student voice (ElevenLabs)

  // Speaker backend: when true (default), the AAC Speaker runs as Gemini Live
  // native-audio (model speaks directly). When false, it runs as HTTP completion
  // + streaming TTS (cheaper, more reliable tool calling). The AI voice in live
  // mode comes from Gemini Live's prebuilt voices, so the ElevenLabs AI voice
  // picker is hidden client-side when this is on. Default flipped to true for
  // newly created students; existing rows are left untouched (no backfill).
  liveAudioSpeaker: boolean("live_audio_speaker").default(true).notNull(),

  // ElevenLabs voice settings (may be removed later)
  elevenlabsEnabled: boolean("elevenlabs_enabled").default(true), // Toggle ElevenLabs on/off without removing config
  elevenlabsApiKey: text("elevenlabs_api_key"), // Student's own ElevenLabs API key
  elevenlabsAiVoiceId: text("elevenlabs_ai_voice_id"), // ElevenLabs voice ID for AI voice
  elevenlabsStudentVoiceId: text("elevenlabs_student_voice_id"), // ElevenLabs voice ID for student voice

  // Gemini TTS voice settings
  geminiAiVoice: text("gemini_ai_voice"), // Gemini prebuilt voice for AI (e.g. "Kore", "Orus")
  geminiStudentVoice: text("gemini_student_voice"), // Gemini prebuilt voice for student (e.g. "Puck", "Leda")

  // Voice pitch adjustment (semitones, 0 = no change)
  aiVoicePitch: integer("ai_voice_pitch").default(0), // AI voice pitch shift in semitones
  studentVoicePitch: integer("student_voice_pitch").default(0), // Student voice pitch shift in semitones

  // Local browser TTS fallback
  useLocalTts: boolean("use_local_tts").default(false), // Use browser speechSynthesis instead of server TTS

  // Display settings
  iconTextRatio: integer("icon_text_ratio").default(3), // Icon-to-text size ratio 1–5 (1=mostly icon, 5=mostly text)
  usePcsSymbols: boolean("use_pcs_symbols").default(false), // PCS vs emoji preference

  // Experiment: mirror text directed at the student (AI replies + heard speech)
  // back as a glyph strip in the header. When on, the header grows (the board
  // area shrinks to fit) on every page except the Sentence Builder, and the
  // Board Manager populates `rebuild_board`'s `input_glyphs` with a glyph
  // translation of the text it is replying to. Clinician-only (AI cannot set).
  glyphInputTranslation: boolean("glyph_input_translation").default(false).notNull(),

  // Constrain AI-generated buttons to a single GLYPH each (the glyph may still
  // carry modifiers — what's restricted is the per-button GLYPH count). When
  // on, the live system prompt, tool descriptions, and prompt enhancer strip
  // every `+`-joined SENTENCE example and rewrite the grammar so the model
  // never sees multi-glyph button shapes. The sentence builder and interpret()
  // path are unaffected — the user can still compose multi-glyph SENTENCEs
  // and the model still decodes them.
  singleGlyphButtons: boolean("single_glyph_buttons").default(false).notNull(),

  // Full-attention mode. When ON, the AAC streams camera + mic to the live
  // model continuously while awake (a heartbeat frame every ~15s plus
  // continuous audio) — maximum perceptiveness. When OFF (the default), the
  // client applies the resting input filter even while awake: no heartbeat
  // frames and VAD-gated mic, so only motion frames and actual speech/sound
  // are streamed. That cuts live-API I/O cost substantially during quiet
  // stretches while keeping the session responsive. Surfaced to the client
  // as the inverse `clientConfig.awakeDataSaver` flag.
  fullAttentionMode: boolean("full_attention_mode").default(false).notNull(),

  // Cost budget tier (price plan). Names a budget = a scale factor on the
  // multi-window meter caps (shared/aac/budget-tiers.ts): "demo" ($30/mo) …
  // "premium" ($250/mo). Null = the env default tier. The tier governs how much
  // paid-LLM use a student gets per rolling window before the throttle kicks in.
  // See planning-docs/aac-budget-tiers-spec.md §4.
  budgetTier: text("budget_tier"),

  // Experimental: run the Board Manager agent on a Gemini Live session
  // (warm, TEXT modality + function calling) instead of stateless HTTP
  // completions, to test board-generation latency. Behavior is identical;
  // live text rates are higher, so this trades cost for latency. Off by
  // default. See live-board-manager-agent.ts.
  boardManagerLiveModel: boolean("board_manager_live_model").default(false).notNull(),

  // Auto-generated symbol settings
  generateSymbols: boolean("generate_symbols").default(true).notNull(), // Generate symbol images on-the-fly via Gemini
  useApprovedSymbols: boolean("use_approved_symbols").default(true).notNull(), // Show approved generated symbols on buttons
  useUnapprovedSymbols: boolean("use_unapproved_symbols").default(true).notNull(), // Also show unapproved (newly generated) symbols
  dynamicBoardsEnabled: boolean("dynamic_boards_enabled").default(false).notNull(), // AI can generate/edit boards during AAC sessions

  // Language level — how long/complex the AI's sentences are, matched to the
  // student's receptive language. Integer 1..5 mapping to the LANGUAGE_LEVELS
  // tiers in shared/aac-language-level.ts (1=single_words .. 5=complex).
  // Default 4 = full_sentences (current behavior). General AAC trait: drives
  // both the companion Speaker's register AND the social-trainer peer's
  // default. Sentence-length focused; no separate vocabulary dial.
  languageLevel: integer("language_level").default(4).notNull(),

  // Input settings
  // Sign language code to recognize during AAC sessions ('asl', 'isr', etc.).
  // Null disables sign language detection.
  signLanguage: text("sign_language"),
  multiCameraMode: boolean("multi_camera_mode").default(false), // Multi-camera support

  // Eyegaze / dwell settings
  eyegazeEnabled: boolean("eyegaze_enabled").default(false), // Enable dwell-based symbol selection
  eyegazeTimeout: integer("eyegaze_timeout").default(2000), // Dwell time in ms (1000-10000)
  eyegazeProvider: text("eyegaze_provider"), // 'auto', 'camera', 'tobii', 'eyetech', 'lctech', 'webhid', 'mouse'

  // AI identity
  aiName: text("ai_name"), // Custom AI name (e.g. "Buddy", "Sam")

  // Storage settings — local (device) and remote (database) independently toggleable
  localStorageEnabled: boolean("local_storage_enabled").default(true).notNull(),
  remoteStorageEnabled: boolean("remote_storage_enabled").default(true).notNull(),
  localStorageEncryptionKey: text("local_storage_encryption_key"), // 256-bit AES key (base64), null = generate on first use

  // Privacy — gate monitor agent access to sensitive student data
  allowReadProgress: boolean("allow_read_progress").default(true).notNull(),
  allowReadReports: boolean("allow_read_reports").default(true).notNull(),
  allowNotes: boolean("allow_notes").default(true).notNull(),
  // Whether the student's owning institute auto-passes the monitor_note gate
  // and sees AAC-recorded chatMemory (Student_Notes / People / Interests /
  // CommunicationStyle / Preferences) without an explicit standing share.
  // Cross-institute access still requires a monitor_note standing share
  // regardless of this flag.
  shareMonitorNotesWithInstitute: boolean("share_monitor_notes_with_institute").default(true).notNull(),

  // App configuration — per-app settings stored as JSON (e.g. { youtube: { enabled: true }, spotify: { enabled: true } })
  appConfig: jsonb("app_config").default({}),

  // Permitted websites — array of { url, label, description?, subpages? } the AI is allowed to open via the browser app
  permittedWebsites: jsonb("permitted_websites").default([]),

  // Unified permitted YouTube content — array of { type: 'channel'|'playlist'|'video', id, label, description? }.
  // Supersedes permittedYoutubeChannels/permittedYoutubeVideos below. The two
  // legacy columns are retained (and backfilled into this one by migration
  // 0109) for rollback safety, but are no longer written to.
  permittedYoutubeItems: jsonb("permitted_youtube_items").default([]),

  // DEPRECATED — superseded by permittedYoutubeItems. Array of { channelId, label, description? }.
  permittedYoutubeChannels: jsonb("permitted_youtube_channels").default([]),

  // DEPRECATED — superseded by permittedYoutubeItems. Array of { videoId, label, description? }.
  permittedYoutubeVideos: jsonb("permitted_youtube_videos").default([]),

  // Accessibility — single JSON blob so new options don't require migrations
  accessibility: jsonb("accessibility").default({}), // { fontSize?: number, highContrast?: boolean, reduceAnimations?: boolean, enhancedFocusIndicator?: boolean }

  // Recognition
  knownPeople: jsonb("known_people").default([]), // Array of known people for recognition

  // Defined student gestures — array of { name, description?, meaning }. The
  // Observer agent treats a recognized gesture toward the device as a button
  // press voicing `meaning` (see DefinedGesture in schema.ts).
  definedGestures: jsonb("defined_gestures").default([]),

  // Seizure detection (per-student). TECHNICAL config for the client-side motion
  // detectors — { config: { enabled, rhythmic, atonic, audioCorroboration },
  // baseline?: { regionEnergy, samples, updatedAt } }. `config` is clinician-
  // edited (master switch + per-detector sensitivity); `baseline` is the
  // machine-learned habitual-motion model persisted across sessions. The two
  // write paths merge by key (studentService) so a config save never clobbers
  // the baseline and vice-versa. CLINICAL policy (what to do, what their seizures
  // look like) lives in the prompt/alarmConditions, NOT here. See
  // shared/aac/seizure-config.ts (SeizureDetectionSettings). Untyped at the
  // column level (reads coerce via coerceSeizureConfig) — a strict $type union
  // fights drizzle-zod's insert-schema widening.
  seizureDetection: jsonb("seizure_detection"),

  // When true, a clinician on a video call may facilitate button presses on the
  // student's mirrored board (guided communication). Off by default — facilitator
  // presses from the call are ignored unless this is enabled per student.
  allowFacilitatorControl: boolean("allow_facilitator_control").default(false).notNull(),

  // Metadata
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_aac_settings_student_id").on(table.studentId),
]);

// =============================================================================
// BIOMETRIC DATA (shared)
// =============================================================================
// One row per real person. Referenced by users, students, and studentContacts
// via biometricDataId FK. When a contact is linked to a user or student, its
// biometricDataId is write-through synced to the linked record's.
export const biometricData = pgTable("biometric_data", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),

  faceEmbedding: jsonb("face_embedding"),
  // Multi-angle gallery: array of { embedding:number[], quality:number,
  // capturedAt:string, weight:number }. Complements the single `faceEmbedding`
  // anchor so a person is recognised across pose/lighting/expression. Grows
  // passively from confident novel-pose sightings; entries lose weight (and are
  // evicted) when a match they produced is corrected. See recognition-service.
  faceEmbeddings: jsonb("face_embeddings"),
  voiceEmbedding: jsonb("voice_embedding"),
  // Multi-sample voice gallery: array of { embedding:number[], quality:number,
  // capturedAt:string, weight:number }. Complements the single `voice_embedding`
  // anchor so a person is recognised across the natural variation in their voice
  // (loudness, mood, mic distance). Grows passively from confident novel-sample
  // sightings; entries lose weight (and are evicted) when a match they produced
  // is corrected. Usually seeds entirely from sightings — voice enrollment is
  // rarely present. See recognition-service.
  voiceEmbeddings: jsonb("voice_embeddings"),
  faceImageUrl: text("face_image_url"),
  faceImageQuality: real("face_image_quality"),

  hairColor: text("hair_color"),
  eyeColor: text("eye_color"),
  estimatedAge: text("estimated_age"),
  estimatedSex: text("estimated_sex"),
  physicalDescription: text("physical_description"),
  identifyingFeatures: text("identifying_features"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Student contacts — represents the relationship between a student and a person.
// Biometric/physical data lives on the linked biometric_data row. If the contact
// is also a user or another student, linkedUserId/linkedStudentId points to them
// and biometricDataId is shared with their record.
export const studentContacts = pgTable("student_contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").references(() => students.id).notNull(),

  // Identity — label this student uses (may differ from linked user's legal name)
  name: text("name").notNull(),
  relationship: text("relationship"),

  // Links to canonical records (mutually exclusive — enforced in repo)
  linkedUserId: varchar("linked_user_id").references(() => users.id),
  linkedStudentId: varchar("linked_student_id").references((): AnyPgColumn => students.id),

  // Shared biometric record — auto-synced to linked user/student when linked
  biometricDataId: varchar("biometric_data_id").references(() => biometricData.id),

  // Team-member fields (nullable — set only for formal IEP/TALA team members)
  role: teamMemberRoleEnum("role"),
  customRole: text("custom_role"),
  organization: text("organization"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),

  // Relationship-scoped context
  contextNotes: text("context_notes"),
  lastSeenAt: timestamp("last_seen_at"),
  timesIdentified: integer("times_identified").default(0).notNull(),

  // Live calling — when true (and the contact is linked to a user/student), the
  // student may video-call this person and the AI may offer/place the call.
  callable: boolean("callable").default(false).notNull(),

  // Guardian verification — populated when this contact signs informed consent.
  // governmentIdNumber is sensitive; encrypt at rest via the existing
  // PHI-column pattern when production-grade encryption lands.
  governmentIdNumber: text("government_id_number"),
  governmentIdType: governmentIdTypeEnum("government_id_type"),
  governmentIdCountry: text("government_id_country"), // ISO 3166-1 alpha-2
  governmentIdVerifiedVia: idVerificationSourceEnum("government_id_verified_via"),
  governmentIdVerificationProvider: text("government_id_verification_provider"),
  governmentIdVerifiedAt: timestamp("government_id_verified_at"),

  isLegalGuardian: boolean("is_legal_guardian").default(false).notNull(),
  coGuardianAcknowledged: boolean("co_guardian_acknowledged").default(false).notNull(),
  legalGuardianDeclaredAt: timestamp("legal_guardian_declared_at"),

  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_student_contacts_student_id").on(table.studentId),
  index("idx_student_contacts_is_active").on(table.isActive),
  index("idx_student_contacts_linked_user_id").on(table.linkedUserId),
  index("idx_student_contacts_linked_student_id").on(table.linkedStudentId),
  index("idx_student_contacts_biometric_data_id").on(table.biometricDataId),
]);

// =============================================================================
// STUDENT LINKING TABLES (Private)
// =============================================================================

// Junction table for many-to-many relationship between Users and Students
export const userStudents = pgTable("user_students", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  studentId: varchar("student_id").references(() => students.id).notNull(),
  role: text("role").default("caregiver"), // 'owner', 'caregiver', 'therapist', etc.
  data: jsonb("data").default({}), // Private data for this relationship
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),

  hasEducationalRights: boolean("has_educational_rights").default(true).notNull(),
  hasMedicalRights: boolean("has_medical_rights").default(true).notNull(),

  // Chat system fields
  chatMemory: jsonb("chat_memory").default({}), // Relationship-specific memory values for chat
  chatCreditsUsed: real("chat_credits_used").notNull().default(0),
  chatCreditsUpdated: timestamp("chat_credits_updated").defaultNow(),
}, (table) => [
  index("idx_user_students_user_id").on(table.userId),
  index("idx_user_students_student_id").on(table.studentId),
]);

// Junction table for many-to-many relationship between Institutes and Students
export const instituteStudents = pgTable("institute_students", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Cross-schema FK: institutes.id lives in schema.ts — constraint exists in DB migrations
  instituteId: varchar("institute_id").notNull(),
  studentId: varchar("student_id").references(() => students.id).notNull(),
  enrollmentDate: date("enrollment_date"),
  exitDate: date("exit_date"),
  exitReason: text("exit_reason"), // graduated, transferred, withdrawn, etc.
  grade: gradeEnum("grade"), // e.g., "K", "1", "2", "3-5", "Middle School", etc.
  idNumber: text("id_number"), // Student ID number
  data: jsonb("data").default({}), // Private data for this relationship
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_institute_students_institute_id").on(table.instituteId),
  index("idx_institute_students_student_id").on(table.studentId),
  index("idx_institute_students_is_active").on(table.isActive),
]);

export const studentClassrooms = pgTable("student_classrooms", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").references(() => students.id).notNull(),
  // Cross-schema FK: classrooms.id lives in schema.ts — constraint exists in DB migrations
  classroomId: varchar("classroom_id").notNull(),
  isPrimary: boolean("is_primary").default(false).notNull(), // Is this the primary/homeroom classroom?
  enrollmentDate: date("enrollment_date"),
  exitDate: date("exit_date"),
  notes: text("notes"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_student_classrooms_student_id").on(table.studentId),
  index("idx_student_classrooms_classroom_id").on(table.classroomId),
  index("idx_student_classrooms_is_active").on(table.isActive),
]);

// AAC devices registered to a student. Each row consumes one slot against the
// student's effective device limit (sum of maxDevicesPerStudent across the
// licenses of all institutes the student actively belongs to). The deviceId is
// a client-generated installation id persisted in the device's localStorage.
export const studentDevices = pgTable("student_devices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }).notNull(),
  deviceId: varchar("device_id").notNull(),
  deviceName: text("device_name"),
  // Cross-schema FK: users.id lives in schema.ts — constraint exists in DB migrations (ON DELETE SET NULL)
  registeredByUserId: varchar("registered_by_user_id"),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_student_devices_student_id").on(table.studentId),
  uniqueIndex("idx_student_devices_student_device").on(table.studentId, table.deviceId),
]);

// =============================================================================
// MEDICAL / REPORTS TABLES (Private)
// =============================================================================

export const medicalRecords = pgTable("medical_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").notNull(),
  userId: varchar("user_id"), // Who created/owns this record
  instituteId: varchar("institute_id"), // Should be a clinic that the student is linked to

  birthDate: date("birth_date"),

  // Sensitivity markers
  isSensitive: boolean("is_sensitive").default(true).notNull(),
  sensitivityCategory: sensitivityCategoryEnum("sensitivity_category").default("medical").notNull(),

  // Diagnoses
  primaryDiagnosis: text("primary_diagnosis"),
  primaryDiagnosisCode: text("primary_diagnosis_code"),
  coMorbidities: jsonb("co_morbidities").default([]),
  secondaryDiagnoses: jsonb("secondary_diagnoses").default([]),

  // Medical needs
  alertsAllergies: jsonb("alerts_allergies").default([]),
  alertsSeizures: jsonb("alerts_seizures").default([]),
  alertsCardiac: jsonb("alerts_cardiac").default([]),
  medications: jsonb("medications").default([]),
  medicalEquipment: jsonb("medical_equipment").default([]),

  status: reportStatusEnum("status").default("draft").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  finalizedAt: timestamp("finalized_at"),
}, (table) => [
  index("idx_medical_records_student_id").on(table.studentId),
  index("idx_medical_records_user_id").on(table.userId),
  index("idx_medical_records_institute_id").on(table.instituteId),
  index("idx_medical_records_status").on(table.status),
]);

export const functionalReports = pgTable("functional_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").notNull(),
  userId: varchar("user_id"), // Who created/owns this record
  instituteId: varchar("institute_id"), // Optional - institute that the report is associated with
  programId: varchar("program_id"),

  // Sensitivity markers
  isSensitive: boolean("is_sensitive").default(true).notNull(),
  sensitivityCategory: sensitivityCategoryEnum("sensitivity_category").default("behavioral").notNull(),

  mobilityStatus: jsonb("mobility_status").default([]),
  adlStatus: jsonb("adl_status").default([]),
  sensoryProfile: jsonb("sensory_profile").default([]),
  safetyRisks: jsonb("safety_risks").default([]),

  status: reportStatusEnum("status").default("draft").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  finalizedAt: timestamp("finalized_at"),
}, (table) => [
  index("idx_functional_reports_student_id").on(table.studentId),
  index("idx_functional_reports_user_id").on(table.userId),
  index("idx_functional_reports_institute_id").on(table.instituteId),
  index("idx_functional_reports_program_id").on(table.programId),
  index("idx_functional_reports_status").on(table.status),
]);

export const educationalReports = pgTable("educational_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").notNull(),
  userId: varchar("user_id"), // Who created/owns this record
  instituteId: varchar("institute_id"), // Optional - institute that the report is associated with
  programId: varchar("program_id"),

  // Sensitivity markers
  isSensitive: boolean("is_sensitive").default(true).notNull(),
  sensitivityCategory: sensitivityCategoryEnum("sensitivity_category").default("educational").notNull(),

  communicationMode: jsonb("communication_mode").default([]),
  receptiveLanguage: jsonb("receptive_language").default([]),
  assistiveTechnologyUsed: jsonb("assistive_technology_used").default([]),
  reinforcers: jsonb("reinforcers").default([]),
  preferredActivities: jsonb("preferred_activities").default([]),
  behavioralStrategies: jsonb("behavioral_strategies").default([]),

  status: reportStatusEnum("status").default("draft").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  finalizedAt: timestamp("finalized_at"),
}, (table) => [
  index("idx_educational_reports_student_id").on(table.studentId),
  index("idx_educational_reports_user_id").on(table.userId),
  index("idx_educational_reports_institute_id").on(table.instituteId),
  index("idx_educational_reports_program_id").on(table.programId),
  index("idx_educational_reports_status").on(table.status),
]);

// =============================================================================
// IEP/TALA PROGRAM TABLES (Private)
// =============================================================================

/**
 * Programs - The IEP/TALA document itself
 * A student can have multiple programs over their school career (one per year)
 */
export const programs = pgTable("programs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").references(() => students.id).notNull(),
  // Cross-schema FK: institutes.id lives in schema.ts — constraint exists in DB migrations
  instituteId: varchar("institute_id"),

  // Framework and identification
  framework: programFrameworkEnum("framework").notNull(), // 'tala' | 'us_iep'
  title: text("title"), // Optional custom title

  // Status and timeline
  status: programStatusEnum("status").default("draft").notNull(),
  startDate: date("start_date"),
  endDate: date("end_date"),
  dueDate: date("due_date"), // Nov 15 for TALA, calculated for IEP
  approvalDate: date("approval_date"),

  // IEP-specific
  leastRestrictiveEnvironment: text("least_restrictive_environment"),

  // ICF contextual factors (WHO 2002)
  // personalFactors: free-form JSON — age-appropriate interests, temperament, motivators, coping, cultural background, etc.
  // environmentalFactors: JSON keyed by ICF category (products_technology, natural_environment, support_relationships, attitudes, services_systems_policies),
  //   each containing { facilitators: string[], barriers: string[], notes?: string }
  personalFactors: jsonb("personal_factors").default({}),
  environmentalFactors: jsonb("environmental_factors").default({}),

  // Metadata
  notes: text("notes"),
  metadata: jsonb("metadata").default({}),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_programs_student_id").on(table.studentId),
  index("idx_programs_status").on(table.status),
  index("idx_programs_framework").on(table.framework),
]);

/**
 * Profile Domains - Areas within the functional profile/PLAAFP
 */
export const profileDomains = pgTable("profile_domains", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  programId: varchar("program_id").references(() => programs.id).notNull(),

  domainType: profileDomainTypeEnum("domain_type").notNull(),
  customName: text("custom_name"), // For 'other' type

  // Content
  strengths: text("strengths"),
  needs: text("needs"), // Areas for reinforcement/challenges
  impactStatement: text("impact_statement"), // How disability impacts education in this domain

  // IEP-specific: adverse effect statement
  adverseEffectStatement: text("adverse_effect_statement"),

  // Ordering
  sortOrder: integer("sort_order").default(0).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_profile_domains_program_id").on(table.programId),
  index("idx_profile_domains_domain_type").on(table.domainType),
]);

/**
 * Baseline Measurements - Quantitative data within a domain
 */
export const baselineMeasurements = pgTable("baseline_measurements", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  profileDomainId: varchar("profile_domain_id").references(() => profileDomains.id).notNull(),

  skillDescription: text("skill_description").notNull(),
  measurementMethod: text("measurement_method").notNull(), // "standardized test", "observation", etc.
  value: text("value").notNull(), // "10%", "3/10 trials", "below grade level"
  numericValue: real("numeric_value"), // For graphing/comparison
  unit: text("unit"), // "%", "trials", "words per minute", etc.

  assessedAt: date("assessed_at"),
  assessedBy: text("assessed_by"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_baseline_measurements_domain_id").on(table.profileDomainId),
]);

/**
 * Assessment Sources - Documentation of assessment tools used
 */
export const assessmentSources = pgTable("assessment_sources", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  profileDomainId: varchar("profile_domain_id").references(() => profileDomains.id).notNull(),

  sourceType: assessmentSourceTypeEnum("source_type").notNull(),
  instrumentName: text("instrument_name"), // e.g., "Goldman-Fristoe Test of Articulation"
  assessedAt: date("assessed_at"),
  summary: text("summary"),

  // Results data
  resultsData: jsonb("results_data").default({}), // Flexible storage for test scores, subscores, etc.

  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_assessment_sources_domain_id").on(table.profileDomainId),
]);

/**
 * Goals - Long-term/annual goals with SMART structure
 */
export const goals = pgTable("goals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  programId: varchar("program_id").references(() => programs.id).notNull(),

  // Goal statement
  goalStatement: text("goal_statement").notNull(),

  // Legacy/simple fields (for quick entry)
  targetBehavior: text("target_behavior"),
  criteria: text("criteria"),
  methods: text("methods"),
  measurementMethod: text("measurement_method"),
  relevance: text("relevance"), // Educational impact
  targetDate: date("target_date"),

  // TALA-specific: ICF intervention level
  interventionLevel: interventionLevelEnum("intervention_level"),

  // GAS (Goal Attainment Scaling) — TALA-aligned scoring
  // When useGas is true, the five gasLevels define the ordinal scale used to
  // score dataPoints (dataPoints.achievedLevel). progress remains a derived
  // 0-100 summary for display compatibility.
  useGas: boolean("use_gas").default(false).notNull(),
  gasVaryingVariable: gasVaryingVariableEnum("gas_varying_variable"),
  gasBaselineLevel: gasLevelEnum("gas_baseline_level"),
  // Shape: Partial<Record<gas_level, { behavior: string, numericValue?: number, unit?: string }>>
  gasLevels: jsonb("gas_levels").default({}),

  // Family-Centered Service (FCS) / COPM-style joint goal-setting
  clientImportanceRating: integer("client_importance_rating"), // 1-5 from client/family
  setJointlyWithFamily: boolean("set_jointly_with_family").default(false).notNull(),
  familyInput: text("family_input"), // free-form notes from parent/caregiver about this goal

  // Status tracking
  status: goalStatusEnum("status").default("draft").notNull(),
  progress: integer("progress").default(0), // 0-100
  achievedDate: date("achieved_date"),

  // Ordering
  sortOrder: integer("sort_order").default(0).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_goals_program_id").on(table.programId),
  index("idx_goals_status").on(table.status),
]);

/**
 * Objectives - Short-term objectives/benchmarks toward goals
 */
export const objectives = pgTable("objectives", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  goalId: varchar("goal_id").references(() => goals.id).notNull(),
  profileDomainId: varchar("profile_domain_id").references(() => profileDomains.id), // Links goal to baseline

  objectiveStatement: text("objective_statement").notNull(),
  sequenceOrder: integer("sequence_order").notNull().default(1),

  // Measurable criteria
  targetBehavior: text("target_behavior"),
  methods: text("methods"),
  criteria: text("criteria"),
  measurementMethod: text("measurement_method"),
  relevance: text("relevance"), // Educational impact

  // Timeline
  targetDate: date("target_date"),

  // GAS integration — when the parent goal has useGas=true, this field points
  // at one level on the parent's scale that this objective aims to reach.
  // Null when the parent goal isn't GAS-scored or the objective is unscored.
  gasTargetLevel: gasLevelEnum("gas_target_level"),

  // Status tracking
  status: objectiveStatusEnum("status").default("draft").notNull(),
  progress: integer("progress").default(0), // 0-100
  achievedDate: date("achieved_date"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_objectives_goal_id").on(table.goalId),
  index("idx_objectives_domain_id").on(table.profileDomainId),
  index("idx_objectives_status").on(table.status),
]);

/**
 * User Goals Junction - Links users to goals they're responsible for
 */
export const userGoals = pgTable("user_goals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  goalId: varchar("goal_id").references(() => goals.id).notNull(),

  // Role in relation to this goal
  role: text("role").default("assigned"), // 'assigned', 'supervisor', 'observer'

  // Permissions
  canEdit: boolean("can_edit").default(true).notNull(),
  canRecordData: boolean("can_record_data").default(true).notNull(),

  // Notification preferences
  notifyOnProgress: boolean("notify_on_progress").default(true).notNull(),
  notifyOnDataPoint: boolean("notify_on_data_point").default(false).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_user_goals_user_id").on(table.userId),
  index("idx_user_goals_goal_id").on(table.goalId),
]);

/**
 * User Objectives Junction - Links users to objectives they're responsible for
 */
export const userObjectives = pgTable("user_objectives", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  objectiveId: varchar("objective_id").references(() => objectives.id).notNull(),

  // Role in relation to this objective
  role: text("role").default("assigned"), // 'assigned', 'supervisor', 'observer'

  // Permissions
  canEdit: boolean("can_edit").default(true).notNull(),
  canRecordData: boolean("can_record_data").default(true).notNull(),

  // Notification preferences
  notifyOnProgress: boolean("notify_on_progress").default(true).notNull(),
  notifyOnDataPoint: boolean("notify_on_data_point").default(false).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_user_objectives_user_id").on(table.userId),
  index("idx_user_objectives_objective_id").on(table.objectiveId),
]);

/**
 * Services - Related services and interventions
 */
export const services = pgTable("services", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  programId: varchar("program_id").references(() => programs.id).notNull(),

  serviceType: serviceTypeEnum("service_type").notNull(),
  customServiceName: text("custom_service_name"), // For 'other' type
  description: text("description"),

  // Provider — references a studentContacts row (the person delivering this service).
  providerContactId: varchar("provider_contact_id").references(() => studentContacts.id),
  providerName: text("provider_name"), // Fallback if no linked contact

  // Setting (LRE consideration)
  setting: serviceSettingEnum("setting"),
  settingDescription: text("setting_description"),

  // Delivery model
  deliveryModel: serviceDeliveryModelEnum("delivery_model").default("direct"),

  // Timeline
  startDate: date("start_date"),
  endDate: date("end_date"),

  // Status
  isActive: boolean("is_active").default(true).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_services_program_id").on(table.programId),
  index("idx_services_service_type").on(table.serviceType),
  index("idx_services_is_active").on(table.isActive),
]);

/**
 * Service Goals Junction - Links services to the goals they address
 */
export const serviceGoals = pgTable("service_goals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  serviceId: varchar("service_id").references(() => services.id).notNull(),
  goalId: varchar("goal_id").references(() => goals.id).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_service_goals_service_id").on(table.serviceId),
  index("idx_service_goals_goal_id").on(table.goalId),
]);

/**
 * Service Users Junction - Users (therapists/caregivers) assigned to deliver a service.
 * The pool of valid users is anyone sharing an institute with the program's student.
 */
export const serviceUsers = pgTable("service_users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  serviceId: varchar("service_id").references(() => services.id, { onDelete: "cascade" }).notNull(),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_service_users_service_id").on(table.serviceId),
  index("idx_service_users_user_id").on(table.userId),
]);

/**
 * Accommodations - Supports and modifications
 */
export const accommodations = pgTable("accommodations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  serviceId: varchar("service_id").references(() => services.id),
  programId: varchar("program_id").references(() => programs.id), // Can be program-wide

  accommodationType: accommodationTypeEnum("accommodation_type").notNull(),
  customTypeName: text("custom_type_name"), // For 'other' type
  description: text("description").notNull(),

  // Where this accommodation applies
  settings: text("settings").array(), // e.g., ["classroom", "testing", "therapy"]

  isActive: boolean("is_active").default(true).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_accommodations_service_id").on(table.serviceId),
  index("idx_accommodations_program_id").on(table.programId),
]);

/**
 * Progress Reports - Periodic measurement against goals
 */
export const progressReports = pgTable("progress_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  programId: varchar("program_id").references(() => programs.id).notNull(),

  reportDate: date("report_date").notNull(),
  reportingPeriod: text("reporting_period"), // "Q1", "Semester 1", etc.

  overallSummary: text("overall_summary"),
  recommendedChanges: text("recommended_changes"),

  // Parent communication
  sharedWithParents: boolean("shared_with_parents").default(false),
  sharedDate: date("shared_date"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_progress_reports_program_id").on(table.programId),
  index("idx_progress_reports_report_date").on(table.reportDate),
]);

/**
 * Goal Progress Entries - Progress on specific goals within a report
 */
export const goalProgressEntries = pgTable("goal_progress_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  progressReportId: varchar("progress_report_id").references(() => progressReports.id).notNull(),
  goalId: varchar("goal_id").references(() => goals.id).notNull(),

  currentPerformance: text("current_performance"), // "45% accuracy"
  progressStatus: progressStatusEnum("progress_status").notNull(),
  narrative: text("narrative"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_goal_progress_entries_report_id").on(table.progressReportId),
  index("idx_goal_progress_entries_goal_id").on(table.goalId),
]);

/**
 * Data Points - Individual measurements for progress tracking
 */
export const dataPoints = pgTable("data_points", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  goalProgressEntryId: varchar("goal_progress_entry_id").references(() => goalProgressEntries.id),
  goalId: varchar("goal_id").references(() => goals.id), // Can be direct to goal without progress entry
  objectiveId: varchar("objective_id").references(() => objectives.id),

  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  value: text("value").notNull(),
  numericValue: real("numeric_value"), // For graphing
  // For GAS-scored goals: the ordinal level observed at this data point.
  // Independent of `value`/`numericValue` — populated when the parent goal has useGas=true.
  achievedLevel: gasLevelEnum("achieved_level"),
  context: text("context"),
  collectedBy: text("collected_by"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_data_points_progress_entry_id").on(table.goalProgressEntryId),
  index("idx_data_points_goal_id").on(table.goalId),
  index("idx_data_points_objective_id").on(table.objectiveId),
  index("idx_data_points_recorded_at").on(table.recordedAt),
]);

/**
 * Incident types — categorizes a recorded incident.
 * Extensible: add values via migration when new categories are needed.
 */
export const incidentTypeEnum = pgEnum("incident_type", ["medical", "functional"]);

/**
 * Incident severity — four-level ordinal scale.
 */
export const incidentSeverityEnum = pgEnum("incident_severity", ["low", "moderate", "high", "critical"]);

/**
 * Incidents — lightweight per-student events not tied to a program or goal.
 * Captures medical or functional occurrences (seizure, behavior episode, fall,
 * regression, etc.) for clinician review and AI context.
 */
export const incidents = pgTable("incidents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }).notNull(),
  // Owning institute. Null when AI-recorded during a student-context AAC session
  // (treated as student-only data; standing-share eligible). Cross-schema FK:
  // institutes.id lives in schema.ts — constraint enforced via migration.
  instituteId: varchar("institute_id"),

  type: incidentTypeEnum("type").notNull(),
  severity: incidentSeverityEnum("severity").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  context: text("context"),
  collectedBy: text("collected_by"),

  // Sensitivity markers — drive the share-flow's confirmation gate when
  // sharing this incident across institutes (FERPA/HIPAA "Sensitive Data").
  // Default true: most incidents are medical/behavioral by nature.
  isSensitive: boolean("is_sensitive").default(true).notNull(),
  sensitivityCategory: sensitivityCategoryEnum("sensitivity_category").default("medical").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_incidents_student_id").on(table.studentId),
  index("idx_incidents_institute_id").on(table.instituteId),
  index("idx_incidents_recorded_at").on(table.recordedAt),
  index("idx_incidents_type").on(table.type),
]);

/**
 * Transition Plans - For students ages 16-21
 */
export const transitionPlans = pgTable("transition_plans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  programId: varchar("program_id").references(() => programs.id).notNull(),

  // Vision/Goals by area
  postSecondaryEducation: text("post_secondary_education"),
  employment: text("employment"),
  independentLiving: text("independent_living"),
  communityParticipation: text("community_participation"),

  // Assessment summary
  transitionAssessmentSummary: text("transition_assessment_summary"),

  // Agency linkages as JSON array
  agencyLinkages: jsonb("agency_linkages").default([]), // [{ agencyName, contact, services }]

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_transition_plans_program_id").on(table.programId),
]);

/**
 * Transition Goals - Specific goals within transition plan
 */
export const transitionGoals = pgTable("transition_goals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  transitionPlanId: varchar("transition_plan_id").references(() => transitionPlans.id).notNull(),

  area: transitionAreaEnum("area").notNull(),
  goalStatement: text("goal_statement").notNull(),
  activitiesServices: text("activities_services"),
  responsibleParty: text("responsible_party"),
  timeline: text("timeline"),

  status: goalStatusEnum("status").default("draft").notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_transition_goals_plan_id").on(table.transitionPlanId),
  index("idx_transition_goals_area").on(table.area),
]);

/**
 * Program Contacts — junction linking studentContacts to programs.
 * A person (studentContacts row) can be on multiple programs across years;
 * their coordinator/responsibilities/active status is per-program.
 */
export const programContacts = pgTable("program_contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  programId: varchar("program_id").references(() => programs.id).notNull(),
  contactId: varchar("contact_id").references(() => studentContacts.id).notNull(),

  // Per-program role override — falls back to studentContacts.role when null
  programRole: teamMemberRoleEnum("program_role"),
  responsibilities: text("responsibilities").array(),
  isCoordinator: boolean("is_coordinator").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_program_contacts_program_id").on(table.programId),
  index("idx_program_contacts_contact_id").on(table.contactId),
  uniqueIndex("uq_program_contacts_program_contact").on(table.programId, table.contactId),
]);

/**
 * Meetings - IEP/TALA meetings
 */
export const meetings = pgTable("meetings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  programId: varchar("program_id").references(() => programs.id).notNull(),

  meetingType: meetingTypeEnum("meeting_type").notNull(),

  scheduledDate: timestamp("scheduled_date"),
  actualDate: timestamp("actual_date"),
  location: text("location"),

  // Attendance tracking
  attendeeIds: text("attendee_ids").array(), // Team member IDs
  parentAttended: boolean("parent_attended"),
  studentAttended: boolean("student_attended"),

  // Content
  agenda: text("agenda"),
  notes: text("notes"),
  decisions: text("decisions").array(),

  // Parent input
  parentConcerns: text("parent_concerns"),
  parentPriorities: text("parent_priorities"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_meetings_program_id").on(table.programId),
  index("idx_meetings_meeting_type").on(table.meetingType),
  index("idx_meetings_scheduled_date").on(table.scheduledDate),
]);

/**
 * Consent Forms - Compliance tracking for required consents
 */
export const consentForms = pgTable("consent_forms", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  programId: varchar("program_id").references(() => programs.id).notNull(),

  consentType: consentTypeEnum("consent_type").notNull(),

  requestedDate: date("requested_date"),
  responseDate: date("response_date"),
  consentGiven: boolean("consent_given"),

  signedBy: text("signed_by"),
  notes: text("notes"),

  // Document reference
  documentUrl: text("document_url"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_consent_forms_program_id").on(table.programId),
  index("idx_consent_forms_consent_type").on(table.consentType),
]);

/**
 * Student informed-consent records — the data-collection consent at the student
 * level. Distinct from consent_forms (per-program ROI artefact). One active row
 * per student authorises baseline processing; revoked rows are kept for audit
 * and gate the student into consent_pending state.
 *
 * See planning-docs/student-consent-onboarding-plan.md.
 */
export const studentConsentRecords = pgTable("student_consent_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").references(() => students.id).notNull(),
  // Null for self-consent (signerType "self") — there is no guardian contact.
  signedByContactId: varchar("signed_by_contact_id")
    .references(() => studentContacts.id),

  // Who signed: a guardian or the student themselves. Resolved at sign time by
  // resolveConsentAuthority (shared/legal/consent-authority.ts).
  signerType: text("signer_type").default("guardian").notNull(),
  // The student's own user account when self-signing in an authenticated
  // session. Null for magic-link self-sign (the parent/student has no account).
  signedByUserId: varchar("signed_by_user_id").references(() => users.id),
  // Frozen snapshot of why this signer was legitimate (the guardianship basis,
  // "self_age", or "self_capable_override"). Mirrors the country/age freeze.
  consentAuthorityBasis: text("consent_authority_basis"),

  // Frozen at signing time so later edits to students.country / birthDate
  // don't retroactively alter the consent's legal context.
  country: text("country").notNull(),                // ISO 3166-1 alpha-2
  ageAtSigningYears: integer("age_at_signing_years").notNull(),
  isMinorEnhancedProtection: boolean("is_minor_enhanced_protection").default(false).notNull(),
  enhancedProtectionRegime: text("enhanced_protection_regime"),
  // 'us_coppa' | 'eu_gdpr_minor' | 'uk_ico_under13' | 'il_general' |
  // 'gdpr_superset_default' | null. Resolved by per-country adapter at sign.

  consentTextVersion: text("consent_text_version").notNull(),    // e.g. 'IL.2026.04'
  consentTextHash: text("consent_text_hash").notNull(),          // SHA-256

  // Required disclosures — schema-enforced shape, country-specific wording.
  purposeAcknowledged: boolean("purpose_acknowledged").notNull(),
  voluntarinessAcknowledged: boolean("voluntariness_acknowledged").notNull(),
  thirdPartyTransfersAcknowledged: boolean("third_party_transfers_acknowledged").notNull(),
  thirdPartyRecipients: jsonb("third_party_recipients").notNull(),

  // Opt-ins — DEFAULT FALSE on every one. Forced false server-side when
  // enhancedProtectionRegime forbids them (e.g., us_coppa).
  optInModelTraining: boolean("opt_in_model_training").default(false).notNull(),
  optInAdvertising: boolean("opt_in_advertising").default(false).notNull(),
  optInThirdPartyResearch: boolean("opt_in_third_party_research").default(false).notNull(),
  optInMarketingComms: boolean("opt_in_marketing_comms").default(false).notNull(),
  optInsForcedOff: boolean("opt_ins_forced_off").default(false).notNull(),
  // True when the regime forced the opt-ins off regardless of UI submission.
  // Re-consent at age-out should re-prompt rather than inherit forced state.

  // Identity verification + non-repudiation evidence (PPA Feb-2026 requirement).
  // Stored as text so adding a method = data, not migration. Validated at
  // write time against the per-regime eligibility list in shared/legal/.
  identityVerificationMethod: text("identity_verification_method").notNull(),
  identityVerificationEvidence: jsonb("identity_verification_evidence").notNull(),
  nonRepudiationMethod: text("non_repudiation_method").notNull(),
  nonRepudiationEvidence: jsonb("non_repudiation_evidence").notNull(),

  signedAt: timestamp("signed_at", { withTimezone: true }).defaultNow().notNull(),
  signedFromIp: text("signed_from_ip"),
  signedFromUserAgent: text("signed_from_user_agent"),

  // Withdrawal of consent. Cascade revokes object/standing shares — handled
  // in service layer, not via FK cascades.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: varchar("revoked_by_user_id").references(() => users.id),
  revocationReason: text("revocation_reason"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_consent_records_student").on(table.studentId),
  index("idx_consent_records_signed_by_contact").on(table.signedByContactId),
  index("idx_consent_records_active")
    .on(table.studentId)
    .where(sql`revoked_at IS NULL`),
]);

/**
 * Consent invitations — token-based magic link a clinician sends to a parent
 * who doesn't have a user account. The parent clicks the link, fills the
 * wizard against the resolved (student, contact) tuple, and signs. The token
 * IS the auth — the parent doesn't need to log in.
 *
 * Channel: email or SMS. Either is set at creation time. The plaintext code
 * is shown to the clinician once (used to compose the link); only the hash
 * is persisted. After redemption + signing, redeemedAt is set and signedConsentId
 * points to the resulting student_consent_records row.
 *
 * See planning-docs/student-consent-onboarding-plan.md.
 */
export const consentInvitations = pgTable("consent_invitations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),

  studentId: varchar("student_id").references(() => students.id).notNull(),
  // Null for self-consent invitations (recipientType "self") — the student
  // signs for themselves, so there is no guardian contact.
  contactId: varchar("contact_id").references(() => studentContacts.id),
  // Who the invitation is addressed to: a guardian or the student themselves.
  recipientType: text("recipient_type").default("guardian").notNull(),
  sourceInstituteId: varchar("source_institute_id"),

  codeHash: text("code_hash").notNull(),

  createdByUserId: varchar("created_by_user_id").references(() => users.id).notNull(),
  channel: text("channel").notNull(), // 'email' | 'sms' | 'manual'
  sentTo: text("sent_to").notNull(),  // email address or E.164 phone (for audit)

  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  signedConsentId: varchar("signed_consent_id").references(() => studentConsentRecords.id),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: varchar("revoked_by_user_id").references(() => users.id),

  // Email-channel secondary-factor gate (PPA Feb-2026): before signing, the
  // parent proves knowledge of the last 4 of the child's institute ID. This is
  // the email-path analogue of the SMS phone-OTP gate. idVerifyAttempts caps
  // brute force (last-4 = 10k combos); once exhausted the gate locks until the
  // clinician re-issues the invitation. Null idVerifiedAt = not yet verified.
  idVerifiedAt: timestamp("id_verified_at", { withTimezone: true }),
  idVerifyAttempts: integer("id_verify_attempts").default(0).notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_consent_invitations_student").on(table.studentId),
  index("idx_consent_invitations_contact").on(table.contactId),
  uniqueIndex("idx_consent_invitations_code_hash").on(table.codeHash),
  index("idx_consent_invitations_pending")
    .on(table.studentId)
    .where(sql`redeemed_at IS NULL AND revoked_at IS NULL`),
]);

/**
 * Phone OTP codes — short-lived one-time passcodes sent over SMS for
 * verifying possession of a phone number. Used by the consent magic-link
 * flow to add a `verified_phone_otp` non-repudiation leg, and reusable for
 * any other phone-verification need (e.g. user phone verification at
 * profile time).
 *
 * Lifecycle:
 *  1. service.request(phone, purpose, scopeId) inserts a row with hashed
 *     code + expiry; SMS is dispatched.
 *  2. service.verify(phone, code, purpose, scopeId) looks up the active
 *     unconsumed row for that scope, checks attempts, sets consumedAt.
 *  3. Downstream (e.g. signWithToken) reads the row to confirm the OTP
 *     for this scope was consumed within the verification freshness
 *     window. The row stays as audit evidence.
 *
 * Plaintext code is NEVER stored — only sha256(code).
 */
export const phoneOtpCodes = pgTable("phone_otp_codes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),

  phone: text("phone").notNull(), // E.164
  codeHash: text("code_hash").notNull(),

  // Scope binds an OTP to what it's verifying. Purpose distinguishes use
  // cases (consent invitation vs. user phone change vs. ...). scopeId is
  // free-form (e.g. consent_invitations.id, users.id). Both indexed.
  purpose: text("purpose").notNull(),
  scopeId: text("scope_id"),

  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),

  consumedAt: timestamp("consumed_at", { withTimezone: true }),

  // Audit fingerprint of the actual SMS dispatch.
  sendCount: integer("send_count").notNull().default(0),
  lastProviderMessageId: text("last_provider_message_id"),
  lastProvider: text("last_provider"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_phone_otp_codes_active")
    .on(table.purpose, table.scopeId, table.phone)
    .where(sql`consumed_at IS NULL`),
  index("idx_phone_otp_codes_expires_at").on(table.expiresAt),
]);

// =============================================================================
// SESSIONS / CONTENT TABLES (Private)
// =============================================================================

// Chat sessions
export const chatSessions = pgTable("chat_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // User context - at least one of userId, studentId, classroomId, or
  // crmPotentialCustomerId must be provided. classroomId is set when the
  // AAC session is running in multi-student classroom mode; studentId may
  // still be set in that case to track the currently active student.
  userId: varchar("user_id").references(() => users.id),
  studentId: varchar("student_id").references(() => students.id),
  userStudentId: varchar("user_student_id").references(() => userStudents.id), // The relationship record if both are provided
  // Cross-schema FKs: institutes.id, institute_users.id, and classrooms.id
  // live in schema.ts — constraints enforced via migration
  instituteId: varchar("institute_id"),
  instituteUserId: varchar("institute_user_id"),
  classroomId: varchar("classroom_id"),
  // Cross-schema FK: crm_potential_customers.id lives in schema.ts. When set,
  // this is a CRM landing-page chat session — userId/studentId/instituteId are null.
  crmPotentialCustomerId: varchar("crm_potential_customer_id"),

  // Chat mode determines which agent template to use
  chatMode: varchar("chat_mode").notNull().default("chat"),

  started: timestamp("started").notNull().defaultNow(),
  lastUpdate: timestamp("last_update").notNull().defaultNow(),
  state: jsonb("state").notNull(),
  log: jsonb("log").notNull().default([]),
  last: jsonb("last").notNull().default([]),
  deletedAt: timestamp("deleted_at"),
  creditsUsed: real("credits_used").notNull().default(0),
  // Per-function-type cost breakdown: { "chat": 0.012, "observer": 0.4, "tts": 0.002, ... }.
  // Keys are charge categories (see server/services/credit-ledger.ts); values sum to
  // creditsUsed for charges recorded after the column was introduced (0120).
  costBreakdown: jsonb("cost_breakdown").notNull().default({}),
  // Per-MODALITY cost breakdown for Live-API turns (Phase 0 cost measurement,
  // migration 0131): { "textIn", "nonTextIn", "textOut", "audioOut", "cachedIn" }
  // in credits. Parallel to costBreakdown (which splits by agent); this splits
  // the Live cost by input/output modality so the non-text-input re-billing that
  // the cost-saving phases target is directly measurable. Only Live charges with
  // modality detail populate it; HTTP/TTS charges leave it empty.
  costModalityBreakdown: jsonb("cost_modality_breakdown").notNull().default({}),
  priority: real("priority").notNull().default(0),
  status: chatSessionStatusEnum("status").notNull().default("open"),
  useResponsesAPI: boolean("use_responses_api").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),

  // Dual-agent AAC system fields
  pendingMessages: jsonb("pending_messages").default([]), // Messages cached while Monitor is busy
  interactivePrompt: text("interactive_prompt"), // Full prompt for Interactive agent (student base + Monitor additions)
  monitorBusy: boolean("monitor_busy").default(false), // Is Monitor currently processing?
  monitorBusySince: timestamp("monitor_busy_since"), // Timestamp when Monitor started (for staleness detection)
  thinkingMode: boolean("thinking_mode").default(false), // Is thinking mode active? (Monitor responds directly)

  // Short human-readable summary, generated on session close. Used by deep-analysis
  // session search (memory field Context_StudentSessions / Context_UserSessions).
  title: text("title"),
  summary: text("summary"),
  // Perceived importance of this session. Set by the summarizer.
  //  0 = nothing happened; can be deleted without information loss
  //  1 = routine activity
  //  2 = potentially interesting findings
  //  3 = major milestone
  importance: integer("importance").notNull().default(0),
  // True once a clinician has manually renamed the session. The summarizer then
  // refreshes summary/importance on close but never overwrites the chosen title.
  titleManual: boolean("title_manual").notNull().default(false),
}, (table) => [
  index("idx_chat_sessions_user_id").on(table.userId),
  index("idx_chat_sessions_student_id").on(table.studentId),
  index("idx_chat_sessions_institute_id").on(table.instituteId),
  index("idx_chat_sessions_classroom_id").on(table.classroomId),
  index("idx_chat_sessions_status").on(table.status),
  index("idx_chat_sessions_chat_mode_created").on(table.chatMode, table.createdAt),
  index("idx_chat_sessions_student_importance").on(table.studentId, table.importance, table.createdAt),
  index("idx_chat_sessions_crm_customer").on(table.crmPotentialCustomerId),
  // GIN trigram index for title/summary is added via raw SQL in the generated migration
  // (Drizzle doesn't emit expression-based GIN indexes reliably).
]);

// =============================================================================
// SESSION DEBUG LOGS
// =============================================================================

/**
 * Per-session capture of dual-agent / live-relay debug events.
 *
 * Mirrors what `dual-agent-logger.ts` writes to `server/live-session-debug.log`,
 * but keyed by session so admins can review a specific session's full trace
 * (system prompt, tool declarations, glyph presses, monitor injections, state
 * transitions, etc.) without grepping a shared rolling file.
 *
 * Only populated when the AAC session was started with `debugMode: true`.
 * High-volume events (audio chunks, frame grids) are dropped at the logger
 * boundary — see `NOISY_SECTIONS` in dual-agent-logger.ts.
 */
export const sessionDebugLogs = pgTable("session_debug_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade", onUpdate: "cascade" }),
  seq: serial("seq").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  section: text("section").notNull(),
  content: text("content").notNull(),
}, (table) => [
  index("idx_session_debug_logs_session_seq").on(table.sessionId, table.seq),
]);

// =============================================================================
// LETTERS OF MEDICAL NECESSITY (Insurance Bridge — LMN auto-generator)
// =============================================================================

/**
 * Letter of Medical Necessity. Mirrors the lifecycle of medicalRecords /
 * functionalReports / educationalReports — `draft` until the clinician signs,
 * then `finalized` with `finalizedAt` set. Owning institute only writes here
 * in v1 (cross-institute share-derived generation deferred).
 *
 * `sections` holds the rendered narrative blocks the clinician edits before
 * finalizing. `metricsSnapshot` is a frozen copy of the utterance metrics at
 * draft time so reprints reflect what was filed, not whatever the live
 * metrics happen to say later.
 */
export const lmnStatusEnum = pgEnum("lmn_status", ["draft", "finalized"]);

export const lettersOfMedicalNecessity = pgTable("letters_of_medical_necessity", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").notNull(),
  userId: varchar("user_id"), // creator
  instituteId: varchar("institute_id"),

  // Sensitivity markers — same conventions as medicalRecords.
  isSensitive: boolean("is_sensitive").default(true).notNull(),
  sensitivityCategory: sensitivityCategoryEnum("sensitivity_category").default("medical").notNull(),

  // Editable narrative blocks. See lmnService for the shape.
  sections: jsonb("sections").default({}).notNull(),
  // Frozen utterance/active-time metrics at draft creation. Reprints quote these.
  metricsSnapshot: jsonb("metrics_snapshot").default({}),

  // Signature placeholder fields — populated when the clinician finalizes.
  signatureName: text("signature_name"),
  signatureLicense: text("signature_license"),
  signatureCredentials: text("signature_credentials"),
  signedAt: timestamp("signed_at"),

  status: lmnStatusEnum("status").default("draft").notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  finalizedAt: timestamp("finalized_at"),
}, (table) => [
  index("idx_lmn_student_id").on(table.studentId),
  index("idx_lmn_institute_id").on(table.instituteId),
  index("idx_lmn_status").on(table.status),
]);

// =============================================================================
// AAC UTTERANCE EVENTS (Insurance Bridge — communication metrics source)
// =============================================================================

/**
 * Append-only log of student utterances during AAC sessions. Used by the
 * Insurance Bridge module to compute MLU (Mean Length of Utterance), NDW
 * (Number of Different Words), and communication rate for LMN reports.
 *
 * `source` distinguishes the origin: AAC board button presses, live speech
 * heard by the relay, or text synthesized by the monitor. MLU/NDW are
 * computed by SQL aggregate at query time — no precomputed metrics table.
 */
export const aacUtteranceSourceEnum = pgEnum("aac_utterance_source", [
  "board_press",
  "live_speech",
  "monitor_synth",
]);

export const aacUtteranceEvents = pgTable("aac_utterance_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").notNull(),
  chatSessionId: varchar("chat_session_id"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
  text: text("text").notNull(),
  wordCount: integer("word_count").notNull(),
  uniqueWordCount: integer("unique_word_count").notNull(),
  source: aacUtteranceSourceEnum("source").notNull(),
}, (table) => [
  index("idx_aac_utterance_events_student").on(table.studentId),
  index("idx_aac_utterance_events_session").on(table.chatSessionId),
  index("idx_aac_utterance_events_recorded_at").on(table.recordedAt),
]);

// =============================================================================
// CLINICIAN ACTIVITY INTERVALS (Insurance Bridge — review-time tracking)
// =============================================================================

/**
 * Contiguous periods of clinician activity in the web client. Used by the
 * Insurance Bridge module to compute "review time" for CPT 98979 / 98980,
 * which bill on professional time spent reviewing student data — independent
 * of whether the AI chat was used.
 *
 * One row = one contiguous interval. A new row opens when heartbeats resume
 * after a >60s gap or the student-in-scope changes. `last_heartbeat_at + 60s`
 * is the cap for time totals — the clinician is treated as idle 60s past
 * the last interaction.
 *
 * Privacy: only timestamps and student-in-scope are recorded. No event
 * payloads, no input contents, no coordinates.
 */
export const clinicianActivityIntervals = pgTable("clinician_activity_intervals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  studentId: varchar("student_id"),
  instituteId: varchar("institute_id"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  tabClosed: boolean("tab_closed").default(false).notNull(),
}, (table) => [
  index("idx_clinician_activity_user").on(table.userId),
  index("idx_clinician_activity_student").on(table.studentId),
  index("idx_clinician_activity_institute").on(table.instituteId),
  index("idx_clinician_activity_started_at").on(table.startedAt),
  index("idx_clinician_activity_open").on(table.userId, table.endedAt),
]);

// Deep analyses — long-running chain-of-thought reports produced by the deep-analysis service.
// Stored per-student; searchable via memory field Context_DeepAnalyses.
// Intermediate state (messages, scratch notes, tool-call counters) is persisted so
// an interrupted run can be resumed from the last checkpoint without losing progress.
export const deepAnalyses = pgTable("deep_analyses", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").references(() => students.id).notNull(),
  // Owning institute. Null when AI-generated in student context (typical case);
  // standing-share eligible. Cross-schema FK to institutes.id.
  instituteId: varchar("institute_id"),
  createdByUserId: varchar("created_by_user_id").references(() => users.id).notNull(),
  model: varchar("model").notNull(),
  specialInstructions: text("special_instructions"),
  status: varchar("status").notNull().default("pending"), // pending | running | paused | complete | failed
  title: text("title"),
  summary: text("summary"),
  reportMarkdown: text("report_markdown"),
  error: text("error"),
  thinkingTokens: integer("thinking_tokens").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  // Running USD cost computed from MODEL_OPTIONS rates at each turn persistence.
  // Thinking tokens are billed as output tokens by Anthropic — included in the output-rate total.
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  // Resumable run state. Updated after each agent turn so an interrupted run can pick up.
  messages: jsonb("messages").notNull().default([]),   // running conversation (system msgs + user + assistant + tool results)
  scratch: jsonb("scratch").notNull().default({}),     // free-form scratchpad: running notes, partial findings, tool-call counters, step name
  stepCount: integer("step_count").notNull().default(0),
  resumeCount: integer("resume_count").notNull().default(0),
  lastActivityAt: timestamp("last_activity_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  index("idx_deep_analyses_student_id").on(table.studentId),
  index("idx_deep_analyses_institute_id").on(table.instituteId),
  index("idx_deep_analyses_created_at").on(table.createdAt),
  index("idx_deep_analyses_status").on(table.status),
]);

// =============================================================================
// PERSONS — Canonical "human" abstraction layer above users and students.
// A person may carry a user facet, a student facet, or (future) both. Scoped to
// the chat/call membership system for now; other systems converge onto it later.
// Institute-agnostic — scope derives from the facet rows. Both FKs are nullable
// and UNIQUE (Postgres treats NULLs as distinct, so many facet-less rows are
// fine, but a given user/student maps to at most one person).
// =============================================================================

export const persons = pgTable("persons", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),       // login / caregiver facet
  studentId: varchar("student_id").references(() => students.id), // AAC-learner facet
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_persons_user_id").on(table.userId),
  uniqueIndex("idx_persons_student_id").on(table.studentId),
]);

// =============================================================================
// PERSON CHAT — Messaging between persons (user and/or student facets), scoped
// to a shared institute. instituteId stored as varchar (no FK) to avoid circular
// import with schema.ts; app-level authorization enforces the predicate.
// =============================================================================

export const personChatRooms = pgTable("person_chat_rooms", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  instituteId: varchar("institute_id").notNull(),
  name: text("name"),
  isDirect: boolean("is_direct").default(false).notNull(),
  createdByPersonId: varchar("created_by_person_id").references(() => persons.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastMessageAt: timestamp("last_message_at").defaultNow().notNull(),
}, (table) => [
  index("idx_person_chat_rooms_institute_id").on(table.instituteId),
  index("idx_person_chat_rooms_last_message_at").on(table.lastMessageAt),
]);

export const personChatRoomParticipants = pgTable("person_chat_room_participants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  roomId: varchar("room_id").references(() => personChatRooms.id, { onDelete: "cascade" }).notNull(),
  personId: varchar("person_id").references(() => persons.id).notNull(),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
  lastReadAt: timestamp("last_read_at"),
  leftAt: timestamp("left_at"),
}, (table) => [
  uniqueIndex("idx_person_chat_room_participants_room_person").on(table.roomId, table.personId),
  index("idx_person_chat_room_participants_person_id").on(table.personId),
]);

export const personChats = pgTable("person_chats", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  roomId: varchar("room_id").references(() => personChatRooms.id, { onDelete: "cascade" }).notNull(),
  senderPersonId: varchar("sender_person_id").references(() => persons.id).notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  editedAt: timestamp("edited_at"),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  index("idx_person_chats_room_created").on(table.roomId, table.createdAt),
  index("idx_person_chats_sender_person_id").on(table.senderPersonId),
]);

// Push tokens stay keyed on the USER (the device owner): a token is a device
// delivery target, and a student-person has no device — delivery to a student
// routes through whichever user is fronting it.
export const personChatPushTokens = pgTable("person_chat_push_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  token: text("token").notNull(),
  platform: text("platform").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_person_chat_push_tokens_user_token").on(table.userId, table.token),
]);

// =============================================================================
// LIVE CALLS — WebRTC video/audio calls between persons. Membership reuses
// person_chat_rooms (who-may-call-whom); media flows peer-to-peer over WebRTC
// and never touches the server. These tables hold call lifecycle + history;
// the SDP/ICE signaling itself is transient (WebSocket only, never persisted).
// =============================================================================

export const callSessions = pgTable("call_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  roomId: varchar("room_id").references(() => personChatRooms.id, { onDelete: "cascade" }).notNull(),
  instituteId: varchar("institute_id").notNull(),
  initiatedByPersonId: varchar("initiated_by_person_id").references(() => persons.id).notNull(),
  mode: text("mode").default("aac_caretaker").notNull(), // 'aac_caretaker' | 'aac_aac' | ...
  status: text("status").default("ringing").notNull(),   // ringing|active|ended|missed|declined|cancelled
  media: jsonb("media").default({}).notNull(),           // requested tracks {audio,video,pose}
  game: jsonb("game"),                                   // attached social game (CallGame) or null = plain video chat
  startedAt: timestamp("started_at").defaultNow().notNull(),
  endedAt: timestamp("ended_at"),
  endedReason: text("ended_reason"),
}, (table) => [
  index("idx_call_sessions_room_started").on(table.roomId, table.startedAt),
  index("idx_call_sessions_status").on(table.status),
]);

export const callParticipants = pgTable("call_participants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  callId: varchar("call_id").references(() => callSessions.id, { onDelete: "cascade" }).notNull(),
  personId: varchar("person_id").references(() => persons.id).notNull(),
  role: text("role"),                                    // 'aac' | 'caretaker'
  mediaState: jsonb("media_state").default({}).notNull(), // live {audio,video,pose}
  joinedAt: timestamp("joined_at"),
  leftAt: timestamp("left_at"),
}, (table) => [
  uniqueIndex("idx_call_participants_call_person").on(table.callId, table.personId),
  index("idx_call_participants_person_id").on(table.personId),
]);

export const boards = pgTable("boards", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  studentId: varchar("student_id").references(() => students.id),
  name: text("name").notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  irData: jsonb("ir_data"), // Intermediate representation data for regenerations
  language: text("language").default("en"),
  automaticSelection: boolean("automatic_selection").default(false).notNull(),
  automaticSelectionHint: text("automatic_selection_hint"),
  isGenerated: boolean("is_generated").default(false).notNull(), // AI-generated during AAC session
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  loadedAt: timestamp("loaded_at").defaultNow().notNull(),
});

// Custom apps (games and other AI-generated apps).
// `definition` holds the full JSON spec (see shared/custom-app-types.ts).
export const customApps = pgTable("custom_apps", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  // Cross-schema FK: institutes.id lives in schema.ts — constraint enforced via migration
  instituteId: varchar("institute_id"),
  type: text("type").notNull().default("game"), // "game" for now; reserved for future app types
  name: text("name").notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  definition: jsonb("definition").notNull(),
  language: text("language").default("en"),
  isGenerated: boolean("is_generated").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  loadedAt: timestamp("loaded_at").defaultNow().notNull(),
}, (table) => [
  index("idx_custom_apps_user_id").on(table.userId),
  index("idx_custom_apps_institute_id").on(table.instituteId),
]);

// Assignment join table: each row assigns one custom app to one student.
// instituteId is the owner of this assignment for cross-institute visibility —
// the assignment row is the PHI bit (reveals what apps the student uses).
// Cross-schema FK to institutes.id.
export const customAppAssignments = pgTable("custom_app_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  appId: varchar("app_id").references(() => customApps.id, { onDelete: "cascade" }).notNull(),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }).notNull(),
  instituteId: varchar("institute_id"),
  assignedByUserId: varchar("assigned_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_custom_app_assignments_app_student").on(table.appId, table.studentId),
  index("idx_custom_app_assignments_student_id").on(table.studentId),
  index("idx_custom_app_assignments_institute_id").on(table.instituteId),
]);

// Dropbox Connections table
export const dropboxConnections = pgTable("dropbox_connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull().unique(),
  dropboxAccountId: text("dropbox_account_id"),
  dropboxEmail: text("dropbox_email"),
  encryptedAccessToken: text("encrypted_access_token"),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  tokenExpiresAt: timestamp("token_expires_at"),
  backupFolderPath: text("backup_folder_path").default("/Apps/CliniAACian/Boards"),
  autoBackupEnabled: boolean("auto_backup_enabled").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_dropbox_connections_user_id").on(table.userId),
]);

// Dropbox Backups table — tracks each board export to Dropbox
export const dropboxBackups = pgTable("dropbox_backups", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  boardId: varchar("board_id").references(() => boards.id),
  boardName: text("board_name").notNull(),
  fileType: text("file_type").notNull(), // gridset, obz, etc.
  fileName: text("file_name").notNull(),
  dropboxPath: text("dropbox_path"),
  dropboxFileId: text("dropbox_file_id"),
  fileSizeBytes: integer("file_size_bytes"),
  status: text("status").default("pending").notNull(), // pending, uploading, completed, failed
  shareableUrl: text("shareable_url"),
  errorMessage: text("error_message"),
  uploadDurationMs: integer("upload_duration_ms"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_dropbox_backups_user_id").on(table.userId),
  index("idx_dropbox_backups_board_id").on(table.boardId),
]);

// Invite Codes table
export const inviteCodes = pgTable("invite_codes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  code: varchar("code").unique().notNull(),
  createdByUserId: varchar("created_by_user_id").references(() => users.id).notNull(),
  studentId: varchar("student_id").references(() => students.id).notNull(),
  expiresAt: timestamp("expires_at"),
  timesRedeemed: integer("times_redeemed").default(0).notNull(),
  maxRedemptions: integer("max_redemptions"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Invite code redemptions
export const inviteCodeRedemptions = pgTable("invite_code_redemptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  inviteCodeId: varchar("invite_code_id").references(() => inviteCodes.id).notNull(),
  redeemedByUserId: varchar("redeemed_by_user_id").references(() => users.id).notNull(),
  studentId: varchar("student_id").references(() => students.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// =============================================================================
// CROSS-INSTITUTE SHARING (see planning-docs/cross-institute-sharing-plan.md)
// =============================================================================

/**
 * Share invite — one row per consent transaction. Captures the three-party
 * (or two-party, when source institute is absent) handshake authorizing one
 * bundle of objectShares + standingShares to be created on acceptance.
 *
 * Cross-schema FKs: source/target institute references live in schema.ts —
 * constraints enforced via migration.
 */
export const studentShareInvites = pgTable("student_share_invites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").references(() => students.id).notNull(),

  // Source institute. Null when the share originates from student-owned data
  // (no institute owns the objects being shared); the flow collapses to two-party.
  sourceInstituteId: varchar("source_institute_id"),
  // Target institute is unknown until redemption — code is the only link.
  targetInstituteId: varchar("target_institute_id"),

  // Hash of the share code; plaintext is shown to source admin once.
  codeHash: text("code_hash").notNull(),

  createdByUserId: varchar("created_by_user_id").references(() => users.id).notNull(),
  guardianUserId: varchar("guardian_user_id").references(() => users.id).notNull(),
  guardianApprovedAt: timestamp("guardian_approved_at", { withTimezone: true }),

  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  redeemedByUserId: varchar("redeemed_by_user_id").references(() => users.id),

  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedByUserId: varchar("accepted_by_user_id").references(() => users.id),

  status: shareInviteStatusEnum("status").default("pending_guardian").notNull(),

  // Legal basis under which this share is being made. Default 'guardian_consent'
  // matches the existing flow. 'institutional_delegate' (FERPA "school official"
  // / GDPR processor / HIPAA business associate) skips the guardian step;
  // requires source-admin attestation. 'formal_release_of_information' is a
  // documented ROI tracked outside the system; same approval path as guardian
  // consent but tagged for audit.
  legalBasis: shareLegalBasisEnum("legal_basis").default("guardian_consent").notNull(),

  // Optional message from source/guardian to target.
  message: text("message"),

  // When the resulting shares stop granting access (the share itself).
  // Nullable for indefinite per-object grants; standingShares enforce a value.
  shareExpiresAt: timestamp("share_expires_at", { withTimezone: true }),
  // When the redemption code itself rots — measured in hours, not days.
  codeExpiresAt: timestamp("code_expires_at", { withTimezone: true }).notNull(),

  // Bundle of what's being granted. Materializes into objectShares/standingShares
  // rows on accept. Kept after accept as audit trail of the consent transaction.
  pendingBundle: jsonb("pending_bundle").$type<ShareInviteBundle>().notNull().default({
    objects: [],
    standingTypes: [],
    permission: "read",
    shareExpiresAt: null,
    standingExpiresAt: null,
    sensitiveAcknowledged: false,
  }),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_student_share_invites_student_id").on(table.studentId),
  index("idx_student_share_invites_source_institute_id").on(table.sourceInstituteId),
  index("idx_student_share_invites_target_institute_id").on(table.targetInstituteId),
  index("idx_student_share_invites_status").on(table.status),
  uniqueIndex("idx_student_share_invites_code_hash").on(table.codeHash),
]);

/**
 * Object share — one row = one specific PHI object visible to one target institute.
 * Created on acceptance of a studentShareInvite. Each row IS the legal ROI for
 * that object.
 */
export const objectShares = pgTable("object_shares", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  objectType: shareableObjectTypeEnum("object_type").notNull(),
  objectId: varchar("object_id").notNull(), // polymorphic; FK enforced at app layer
  studentId: varchar("student_id").references(() => students.id).notNull(),

  // Cross-schema FKs to institutes.id. Source may be null (student-owned origin).
  sourceInstituteId: varchar("source_institute_id"),
  targetInstituteId: varchar("target_institute_id").notNull(),

  permission: sharePermissionEnum("permission").default("read").notNull(),
  shareInviteId: varchar("share_invite_id").references(() => studentShareInvites.id).notNull(),

  shareExpiresAt: timestamp("share_expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: varchar("revoked_by_user_id").references(() => users.id),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  // Hot lookup: "what's shared with this institute, of this type, for this student"
  index("idx_object_shares_target_lookup").on(table.targetInstituteId, table.objectType, table.studentId),
  index("idx_object_shares_object").on(table.objectType, table.objectId),
  index("idx_object_shares_invite_id").on(table.shareInviteId),
]);

/**
 * Standing share — pattern-match grant. Covers all current and future objects
 * of the listed types for a specific student, granting visibility to the target
 * institute. Used for AI-generated data where per-object consent is impractical.
 * MUST have a finite shareExpiresAt (default 1 year, renewable).
 */
export const standingShares = pgTable("standing_shares", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").references(() => students.id).notNull(),
  // Cross-schema FK to institutes.id.
  targetInstituteId: varchar("target_institute_id").notNull(),

  // Which AI-generated object types this standing grant covers.
  objectTypes: shareableObjectTypeEnum("object_types").array().notNull(),

  permission: sharePermissionEnum("permission").default("read").notNull(),
  shareInviteId: varchar("share_invite_id").references(() => studentShareInvites.id).notNull(),

  // Standing shares MUST expire — forgotten grants are exactly the access
  // pattern HIPAA audits flag.
  shareExpiresAt: timestamp("share_expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: varchar("revoked_by_user_id").references(() => users.id),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_standing_shares_target_student").on(table.targetInstituteId, table.studentId),
  index("idx_standing_shares_invite_id").on(table.shareInviteId),
]);

// Student-symbol associations — links symbols to students with optional key/description overrides
export const studentSymbolAssociations = pgTable("student_symbol_associations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Cross-schema FK: customSymbols.id lives in schema.ts — constraint exists in DB migrations
  symbolId: varchar("symbol_id").notNull(),
  studentId: varchar("student_id").references(() => students.id).notNull(),
  key: text("key"),
  description: text("description"),
  isApproved: boolean("is_approved").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_student_symbol_assoc_symbol_id").on(table.symbolId),
  index("idx_student_symbol_assoc_student_id").on(table.studentId),
  uniqueIndex("idx_student_symbol_assoc_unique").on(table.symbolId, table.studentId),
]);

// =============================================================================
// INSERT/UPDATE SCHEMAS (Private tables)
// =============================================================================

// User schemas
export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Student schemas
export const insertStudentSchema = createInsertSchema(students).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateStudentSchema = createInsertSchema(students).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// AAC settings schemas
// drizzle-zod types every jsonb column as the generic `Json` union, ignoring
// `.$type<string[]>()`. For the two AAC prompt list columns that mismatches
// drizzle's insert type (`string[]`), so refine them to `string[]` explicitly.
// A plain schema (vs a callback) is used verbatim, so keep it nullish to stay
// optional+nullable like the column — otherwise `create({ studentId })` breaks.
const aacPromptListRefine = {
  chatAgentPrompt: z.array(z.string()).nullish(),
  autoAacPrompt: z.array(z.string()).nullish(),
};

export const insertAacSettingsSchema = createInsertSchema(aacSettings, aacPromptListRefine).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateAacSettingsSchema = createInsertSchema(aacSettings, aacPromptListRefine).omit({
  id: true,
  studentId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// Student contact schemas
export const insertStudentContactSchema = createInsertSchema(studentContacts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateStudentContactSchema = createInsertSchema(studentContacts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial();

export const insertUserStudentSchema = createInsertSchema(userStudents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateUserStudentSchema = createInsertSchema(userStudents).omit({
  id: true,
  userId: true,
  studentId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

export const insertInstituteStudentSchema = createInsertSchema(instituteStudents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateInstituteStudentSchema = createInsertSchema(instituteStudents).omit({
  id: true,
  instituteId: true,
  studentId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

export const insertStudentClassroomSchema = createInsertSchema(studentClassrooms).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const updateStudentClassroomSchema = insertStudentClassroomSchema.partial();

// Records schemas
export const insertMedicalRecordSchema = createInsertSchema(medicalRecords).omit({
  id: true, createdAt: true, updatedAt: true,
});
export const updateMedicalRecordSchema = insertMedicalRecordSchema.partial();

export const insertFunctionalReportSchema = createInsertSchema(functionalReports).omit({
  id: true, createdAt: true, updatedAt: true,
});
export const updateFunctionalReportSchema = insertFunctionalReportSchema.partial();

export const insertEducationalReportSchema = createInsertSchema(educationalReports).omit({
  id: true, createdAt: true, updatedAt: true,
});
export const updateEducationalReportSchema = insertEducationalReportSchema.partial();

// Program schemas
export const insertProgramSchema = createInsertSchema(programs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateProgramSchema = createInsertSchema(programs).omit({
  id: true,
  studentId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// Profile domain schemas
export const insertProfileDomainSchema = createInsertSchema(profileDomains).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateProfileDomainSchema = createInsertSchema(profileDomains).omit({
  id: true,
  programId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// Baseline measurement schemas
export const insertBaselineMeasurementSchema = createInsertSchema(baselineMeasurements).omit({
  id: true,
  createdAt: true,
});

// Assessment source schemas
export const insertAssessmentSourceSchema = createInsertSchema(assessmentSources).omit({
  id: true,
  createdAt: true,
});

// Goal schemas
export const insertGoalSchema = createInsertSchema(goals).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateGoalSchema = createInsertSchema(goals).omit({
  id: true,
  programId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

export const insertUserGoalSchema = createInsertSchema(userGoals).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateUserGoalSchema = insertUserGoalSchema.partial().omit({
  userId: true,
  goalId: true,
});

// Objective schemas
export const insertObjectiveSchema = createInsertSchema(objectives).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateObjectiveSchema = createInsertSchema(objectives).omit({
  id: true,
  goalId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

export const insertUserObjectiveSchema = createInsertSchema(userObjectives).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateUserObjectiveSchema = insertUserObjectiveSchema.partial().omit({
  userId: true,
  objectiveId: true,
});

// Service schemas
export const insertServiceSchema = createInsertSchema(services).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateServiceSchema = createInsertSchema(services).omit({
  id: true,
  programId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// Service-user link schema
export const insertServiceUserSchema = createInsertSchema(serviceUsers).omit({
  id: true,
  createdAt: true,
});

// Accommodation schemas
export const insertAccommodationSchema = createInsertSchema(accommodations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateAccommodationSchema = createInsertSchema(accommodations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// Progress report schemas
export const insertProgressReportSchema = createInsertSchema(progressReports).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateProgressReportSchema = createInsertSchema(progressReports).omit({
  id: true,
  programId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// Goal progress entry schemas
export const insertGoalProgressEntrySchema = createInsertSchema(goalProgressEntries).omit({
  id: true,
  createdAt: true,
});

// Data point schemas
export const insertDataPointSchema = createInsertSchema(dataPoints).omit({
  id: true,
  createdAt: true,
});

// Incident schemas
export const insertIncidentSchema = createInsertSchema(incidents).omit({
  id: true,
  createdAt: true,
});
export const updateIncidentSchema = createInsertSchema(incidents).omit({
  id: true,
  studentId: true,
  createdAt: true,
}).partial();

// Transition plan schemas
export const insertTransitionPlanSchema = createInsertSchema(transitionPlans).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateTransitionPlanSchema = createInsertSchema(transitionPlans).omit({
  id: true,
  programId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// Transition goal schemas
export const insertTransitionGoalSchema = createInsertSchema(transitionGoals).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateTransitionGoalSchema = createInsertSchema(transitionGoals).omit({
  id: true,
  transitionPlanId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// Biometric data schemas
export const insertBiometricDataSchema = createInsertSchema(biometricData).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const updateBiometricDataSchema = insertBiometricDataSchema.partial();

// Program contacts (junction) schemas
export const insertProgramContactSchema = createInsertSchema(programContacts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const updateProgramContactSchema = createInsertSchema(programContacts).omit({
  id: true,
  programId: true,
  contactId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// Meeting schemas
export const insertMeetingSchema = createInsertSchema(meetings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateMeetingSchema = createInsertSchema(meetings).omit({
  id: true,
  programId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// Consent form schemas
export const insertConsentFormSchema = createInsertSchema(consentForms).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertStudentConsentRecordSchema = createInsertSchema(studentConsentRecords).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertConsentInvitationSchema = createInsertSchema(consentInvitations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertPhoneOtpCodeSchema = createInsertSchema(phoneOtpCodes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateConsentFormSchema = createInsertSchema(consentForms).omit({
  id: true,
  programId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// Chat schemas
export const insertChatSessionSchema = createInsertSchema(chatSessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
});

// Board schemas
export const insertBoardSchema = createInsertSchema(boards).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Custom app schemas
export const insertCustomAppSchema = createInsertSchema(customApps).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  loadedAt: true,
});

export const insertCustomAppAssignmentSchema = createInsertSchema(customAppAssignments).omit({
  id: true,
  createdAt: true,
});

// Invite code schemas
export const insertInviteCodeSchema = createInsertSchema(inviteCodes).omit({
  id: true,
  code: true, // Auto-generated
  timesRedeemed: true,
  createdAt: true,
});

export const redeemInviteCodeSchema = z.object({
  code: z.string().min(8, "Invalid invite code").max(8, "Invalid invite code"),
});

// Student symbol association schemas
export const insertStudentSymbolAssociationSchema = createInsertSchema(studentSymbolAssociations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateStudentSymbolAssociationSchema = createInsertSchema(studentSymbolAssociations).omit({
  id: true,
  symbolId: true,
  studentId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// Cross-institute sharing schemas
export const insertStudentShareInviteSchema = createInsertSchema(studentShareInvites).omit({
  id: true,
  status: true,
  guardianApprovedAt: true,
  redeemedAt: true,
  redeemedByUserId: true,
  acceptedAt: true,
  acceptedByUserId: true,
  createdAt: true,
  updatedAt: true,
});

export const insertObjectShareSchema = createInsertSchema(objectShares).omit({
  id: true,
  revokedAt: true,
  revokedByUserId: true,
  createdAt: true,
});

export const insertStandingShareSchema = createInsertSchema(standingShares).omit({
  id: true,
  revokedAt: true,
  revokedByUserId: true,
  createdAt: true,
});

// =============================================================================
// ACTIVITY LOGS (Private)
// =============================================================================

export const activityLogs = pgTable("activity_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  instituteId: varchar("institute_id"),
  userId: varchar("user_id"),
  eventType: activityEventTypeEnum("event_type").notNull(),
  subjectType1: activitySubjectTypeEnum("subject_type_1").notNull(),
  subjectId1: varchar("subject_id_1"),
  subjectType2: activitySubjectTypeEnum("subject_type_2"),
  subjectId2: varchar("subject_id_2"),
  details: jsonb("details"),
  isAiInitiated: boolean("is_ai_initiated").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_activity_logs_institute").on(table.instituteId),
  index("idx_activity_logs_user").on(table.userId),
  index("idx_activity_logs_event_type").on(table.eventType),
  index("idx_activity_logs_subject_type").on(table.subjectType1),
  index("idx_activity_logs_created_at").on(table.createdAt),
]);

// =============================================================================
// TYPES (Private tables)
// =============================================================================

// User types
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type InsertPasswordResetToken = typeof passwordResetTokens.$inferInsert;
export type MfaRecoveryToken = typeof mfaRecoveryTokens.$inferSelect;
export type InsertMfaRecoveryToken = typeof mfaRecoveryTokens.$inferInsert;

// Student types
export type Student = typeof students.$inferSelect;
export type InsertStudent = z.infer<typeof insertStudentSchema>;
export type UpdateStudent = z.infer<typeof updateStudentSchema>;

// Accessibility options stored inside aacSettings.accessibility jsonb column
export interface AccessibilitySettings {
  fontSize?: number;              // percentage 75–200, default 100
  highContrast?: boolean;         // high-contrast color scheme
  reduceAnimations?: boolean;     // disable/reduce UI animations
  enhancedFocusIndicator?: boolean; // stronger outline for keyboard/eyegaze navigation
}

// AAC settings types
export type AacSettings = typeof aacSettings.$inferSelect;
export type InsertAacSettings = z.infer<typeof insertAacSettingsSchema>;
export type UpdateAacSettings = z.infer<typeof updateAacSettingsSchema>;

/** Student with its one-to-one AAC settings loaded */
export type StudentWithAacSettings = Student & { aacSettings: AacSettings | null };

export type StudentContact = typeof studentContacts.$inferSelect;
export type InsertStudentContact = z.infer<typeof insertStudentContactSchema>;
export type UpdateStudentContact = z.infer<typeof updateStudentContactSchema>;
export type UserStudent = typeof userStudents.$inferSelect;
export type InsertUserStudent = z.infer<typeof insertUserStudentSchema>;
export type UpdateUserStudent = z.infer<typeof updateUserStudentSchema>;

export type InstituteStudent = typeof instituteStudents.$inferSelect;
export type InsertInstituteStudent = z.infer<typeof insertInstituteStudentSchema>;
export type UpdateInstituteStudent = z.infer<typeof updateInstituteStudentSchema>;

export type StudentDevice = typeof studentDevices.$inferSelect;
export type InsertStudentDevice = typeof studentDevices.$inferInsert;

export type StudentClassroom = typeof studentClassrooms.$inferSelect;
export type InsertStudentClassroom = z.infer<typeof insertStudentClassroomSchema>;
export type UpdateStudentClassroom = z.infer<typeof updateStudentClassroomSchema>;

// Medical and report types
export type MedicalRecord = typeof medicalRecords.$inferSelect;
export type InsertMedicalRecord = typeof medicalRecords.$inferInsert;
export type UpdateMedicalRecord = Partial<Omit<InsertMedicalRecord, 'studentId'>>;

export type FunctionalReport = typeof functionalReports.$inferSelect;
export type InsertFunctionalReport = typeof functionalReports.$inferInsert;
export type UpdateFunctionalReport = Partial<Omit<InsertFunctionalReport, 'studentId'>>;

export type EducationalReport = typeof educationalReports.$inferSelect;
export type InsertEducationalReport = typeof educationalReports.$inferInsert;
export type UpdateEducationalReport = Partial<Omit<InsertEducationalReport, 'studentId'>>;

export type SensitivityCategory = typeof sensitivityCategoryEnum.enumValues[number];
export type ReportStatus = typeof reportStatusEnum.enumValues[number];

// IEP/TALA Program types
export type Program = typeof programs.$inferSelect;
export type InsertProgram = z.infer<typeof insertProgramSchema>;
export type UpdateProgram = z.infer<typeof updateProgramSchema>;

export type ProfileDomain = typeof profileDomains.$inferSelect;
export type InsertProfileDomain = z.infer<typeof insertProfileDomainSchema>;
export type UpdateProfileDomain = z.infer<typeof updateProfileDomainSchema>;

export type BaselineMeasurement = typeof baselineMeasurements.$inferSelect;
export type InsertBaselineMeasurement = z.infer<typeof insertBaselineMeasurementSchema>;

export type AssessmentSource = typeof assessmentSources.$inferSelect;
export type InsertAssessmentSource = z.infer<typeof insertAssessmentSourceSchema>;

export type Goal = typeof goals.$inferSelect;
export type InsertGoal = z.infer<typeof insertGoalSchema>;
export type UpdateGoal = z.infer<typeof updateGoalSchema>;

export type Objective = typeof objectives.$inferSelect;
export type InsertObjective = z.infer<typeof insertObjectiveSchema>;
export type UpdateObjective = z.infer<typeof updateObjectiveSchema>;

export type UserGoal = typeof userGoals.$inferSelect;
export type InsertUserGoal = typeof userGoals.$inferInsert;
export type UpdateUserGoal = Partial<Omit<InsertUserGoal, 'id' | 'userId' | 'goalId' | 'createdAt'>>;

export type UserObjective = typeof userObjectives.$inferSelect;
export type InsertUserObjective = typeof userObjectives.$inferInsert;
export type UpdateUserObjective = Partial<Omit<InsertUserObjective, 'id' | 'userId' | 'objectiveId' | 'createdAt'>>;

export type Service = typeof services.$inferSelect;
export type InsertService = z.infer<typeof insertServiceSchema>;
export type UpdateService = z.infer<typeof updateServiceSchema>;

export type ServiceGoal = typeof serviceGoals.$inferSelect;

export type ServiceUser = typeof serviceUsers.$inferSelect;
export type InsertServiceUser = z.infer<typeof insertServiceUserSchema>;

export type Accommodation = typeof accommodations.$inferSelect;
export type InsertAccommodation = z.infer<typeof insertAccommodationSchema>;
export type UpdateAccommodation = z.infer<typeof updateAccommodationSchema>;

export type ProgressReport = typeof progressReports.$inferSelect;
export type InsertProgressReport = z.infer<typeof insertProgressReportSchema>;
export type UpdateProgressReport = z.infer<typeof updateProgressReportSchema>;

export type GoalProgressEntry = typeof goalProgressEntries.$inferSelect;
export type InsertGoalProgressEntry = z.infer<typeof insertGoalProgressEntrySchema>;

export type DataPoint = typeof dataPoints.$inferSelect;
export type InsertDataPoint = z.infer<typeof insertDataPointSchema>;
export type Incident = typeof incidents.$inferSelect;
export type InsertIncident = z.infer<typeof insertIncidentSchema>;
export type UpdateIncident = z.infer<typeof updateIncidentSchema>;
export type IncidentType = typeof incidentTypeEnum.enumValues[number];
export type IncidentSeverity = typeof incidentSeverityEnum.enumValues[number];

export type TransitionPlan = typeof transitionPlans.$inferSelect;
export type InsertTransitionPlan = z.infer<typeof insertTransitionPlanSchema>;
export type UpdateTransitionPlan = z.infer<typeof updateTransitionPlanSchema>;

export type TransitionGoal = typeof transitionGoals.$inferSelect;
export type InsertTransitionGoal = z.infer<typeof insertTransitionGoalSchema>;
export type UpdateTransitionGoal = z.infer<typeof updateTransitionGoalSchema>;

export type BiometricData = typeof biometricData.$inferSelect;
export type InsertBiometricData = z.infer<typeof insertBiometricDataSchema>;
export type UpdateBiometricData = z.infer<typeof updateBiometricDataSchema>;

export type ProgramContact = typeof programContacts.$inferSelect;
export type InsertProgramContact = z.infer<typeof insertProgramContactSchema>;
export type UpdateProgramContact = z.infer<typeof updateProgramContactSchema>;

export type Meeting = typeof meetings.$inferSelect;
export type InsertMeeting = z.infer<typeof insertMeetingSchema>;
export type UpdateMeeting = z.infer<typeof updateMeetingSchema>;

export type ConsentForm = typeof consentForms.$inferSelect;
export type InsertConsentForm = z.infer<typeof insertConsentFormSchema>;
export type UpdateConsentForm = z.infer<typeof updateConsentFormSchema>;

export type StudentConsentRecord = typeof studentConsentRecords.$inferSelect;
export type InsertStudentConsentRecord = z.infer<typeof insertStudentConsentRecordSchema>;

export type ConsentInvitation = typeof consentInvitations.$inferSelect;
export type InsertConsentInvitation = z.infer<typeof insertConsentInvitationSchema>;

export type PhoneOtpCode = typeof phoneOtpCodes.$inferSelect;
export type InsertPhoneOtpCode = z.infer<typeof insertPhoneOtpCodeSchema>;

// Chat types
export type ChatSession = typeof chatSessions.$inferSelect;
export type InsertChatSession = z.infer<typeof insertChatSessionSchema>;

// AAC utterance events (Insurance Bridge metrics source)
export type AacUtteranceEvent = typeof aacUtteranceEvents.$inferSelect;
export type InsertAacUtteranceEvent = typeof aacUtteranceEvents.$inferInsert;
export type AacUtteranceSource = (typeof aacUtteranceSourceEnum.enumValues)[number];

// Clinician activity intervals (Insurance Bridge review-time)
export type ClinicianActivityInterval = typeof clinicianActivityIntervals.$inferSelect;
export type InsertClinicianActivityInterval = typeof clinicianActivityIntervals.$inferInsert;

// Letters of Medical Necessity (Insurance Bridge LMN generator)
export type LetterOfMedicalNecessity = typeof lettersOfMedicalNecessity.$inferSelect;
export type InsertLetterOfMedicalNecessity = typeof lettersOfMedicalNecessity.$inferInsert;
export type LmnStatus = (typeof lmnStatusEnum.enumValues)[number];

// Board types
export type Board = typeof boards.$inferSelect;
export type InsertBoard = z.infer<typeof insertBoardSchema>;

// Custom app types
export type CustomApp = typeof customApps.$inferSelect;
export type InsertCustomApp = z.infer<typeof insertCustomAppSchema>;
export type CustomAppAssignment = typeof customAppAssignments.$inferSelect;
export type InsertCustomAppAssignment = z.infer<typeof insertCustomAppAssignmentSchema>;

// Content types
export type InviteCode = typeof inviteCodes.$inferSelect;
export type InsertInviteCode = z.infer<typeof insertInviteCodeSchema>;
export type InviteCodeRedemption = typeof inviteCodeRedemptions.$inferSelect;
export type RedeemInviteCode = z.infer<typeof redeemInviteCodeSchema>;

export type StudentSymbolAssociation = typeof studentSymbolAssociations.$inferSelect;
export type InsertStudentSymbolAssociation = z.infer<typeof insertStudentSymbolAssociationSchema>;
export type UpdateStudentSymbolAssociation = z.infer<typeof updateStudentSymbolAssociationSchema>;

// Cross-institute sharing types
export type StudentShareInvite = typeof studentShareInvites.$inferSelect;
export type InsertStudentShareInvite = z.infer<typeof insertStudentShareInviteSchema>;
export type ObjectShare = typeof objectShares.$inferSelect;
export type InsertObjectShare = z.infer<typeof insertObjectShareSchema>;
export type StandingShare = typeof standingShares.$inferSelect;
export type InsertStandingShare = z.infer<typeof insertStandingShareSchema>;
export type ShareInviteStatus = (typeof shareInviteStatusEnum.enumValues)[number];
export type SharePermission = (typeof sharePermissionEnum.enumValues)[number];
export type ShareableObjectType = (typeof shareableObjectTypeEnum.enumValues)[number];

/**
 * The "what's being granted" payload attached to a share invite. Lives on the
 * invite while it's in-flight; materialized into objectShares + standingShares
 * rows on accept. Retained on the invite afterwards as an audit-grade record
 * of the consent transaction (the underlying objects' is_sensitive flag may
 * change later, but this captures it as-of-grant).
 */
export type ShareInviteBundle = {
  /** Specific objects being granted via per-object share. */
  objects: Array<{
    type: ShareableObjectType;
    id: string;
    /** Object's is_sensitive flag at invite-creation time. */
    isSensitive: boolean;
  }>;
  /** Object types covered by the standing share grant (AI-generated streams). */
  standingTypes: ShareableObjectType[];
  permission: SharePermission;
  /** Per-object shareExpiresAt (ISO). Null = indefinite. */
  shareExpiresAt: string | null;
  /** Standing shareExpiresAt (ISO). Required when standingTypes is non-empty. */
  standingExpiresAt: string | null;
  /** Source admin confirmed sharing despite a sensitive flag, at create time. */
  sensitiveAcknowledged: boolean;
};

// Domain types
export type ProgramFramework = 'tala' | 'us_iep';
export type ProgramStatus = 'draft' | 'active' | 'archived';
export type ProfileDomainType = 'cognitive_academic' | 'communication_language' | 'social_emotional_behavioral' | 'motor_sensory' | 'life_skills_preparation' | 'other';
export type AssessmentSourceType = 'standardized_test' | 'structured_observation' | 'parent_questionnaire' | 'teacher_input' | 'curriculum_based' | 'behavioral_records';
export type InterventionLevel = 'activity' | 'function' | 'participation';
export type GasLevel = 'much_less_than_expected' | 'less_than_expected' | 'expected' | 'better_than_expected' | 'much_better_than_expected';
export type GasVaryingVariable = 'achievement' | 'mediation' | 'time' | 'frequency';
export type GasLevels = Partial<Record<GasLevel, { behavior: string; numericValue?: number; unit?: string }>>;
// Note: support_relationships and attitudes are no longer ICF categories — those
// are modeled via studentContacts (per-person) instead of program-level factors.
export type EnvironmentalFactorCategory = 'products_technology' | 'natural_environment' | 'services_systems_policies';
export type EnvironmentalFactors = Partial<Record<EnvironmentalFactorCategory, { facilitators?: string[]; barriers?: string[]; notes?: string }>>;
export type PersonalFactors = {
  interests?: string[];
  temperament?: string;
  motivators?: string[];
  coping?: string;
  culturalBackground?: string;
  [key: string]: unknown;
};
export type GoalStatus = 'draft' | 'active' | 'achieved' | 'modified' | 'discontinued';
export type ObjectiveStatus = 'not_started' | 'in_progress' | 'achieved' | 'modified' | 'discontinued';
export type ServiceType = 'speech_language_therapy' | 'occupational_therapy' | 'physical_therapy' | 'counseling' | 'specialized_instruction' | 'consultation' | 'aac_support' | 'other';
export type ServiceDeliveryModel = 'direct' | 'consultation' | 'collaborative' | 'indirect';
export type ServiceSetting = 'general_education' | 'resource_room' | 'self_contained' | 'home' | 'community' | 'therapy_room';
export type ServiceFrequencyPeriod = 'daily' | 'weekly' | 'monthly';
export type AccommodationType = 'visual_support' | 'aac_device' | 'modified_materials' | 'extended_time' | 'simplified_language' | 'environmental_modification' | 'other';
export type ProgressStatus = 'significant_progress' | 'making_progress' | 'limited_progress' | 'no_progress' | 'regression' | 'goal_met';
export type MeetingType = 'initial_evaluation' | 'annual_review' | 'reevaluation' | 'amendment' | 'transition_planning' | 'progress_review';
export type ConsentType = 'initial_evaluation' | 'reevaluation' | 'placement' | 'release_of_information' | 'service_provision';
export type TransitionArea = 'education' | 'employment' | 'independent_living' | 'community';
export type TeamMemberRole = 'parent_guardian' | 'student' | 'homeroom_teacher' | 'special_education_teacher' | 'general_education_teacher' | 'speech_language_pathologist' | 'occupational_therapist' | 'physical_therapist' | 'psychologist' | 'administrator' | 'case_manager' | 'external_provider' | 'other';
export type InstituteType = 'school' | 'clinic' | 'family';

// Activity log types
export type ActivityEventType = (typeof activityEventTypeEnum.enumValues)[number];
export type ActivitySubjectType = (typeof activitySubjectTypeEnum.enumValues)[number];
export type ActivityLog = typeof activityLogs.$inferSelect;
export type InsertActivityLog = typeof activityLogs.$inferInsert;

// Person abstraction
export type Person = typeof persons.$inferSelect;
export type InsertPerson = typeof persons.$inferInsert;

// Person chat types
export type PersonChatRoom = typeof personChatRooms.$inferSelect;
export type InsertPersonChatRoom = typeof personChatRooms.$inferInsert;
export type PersonChatRoomParticipant = typeof personChatRoomParticipants.$inferSelect;
export type InsertPersonChatRoomParticipant = typeof personChatRoomParticipants.$inferInsert;
export type PersonChat = typeof personChats.$inferSelect;
export type InsertPersonChat = typeof personChats.$inferInsert;
export type PersonChatPushToken = typeof personChatPushTokens.$inferSelect;
export type InsertPersonChatPushToken = typeof personChatPushTokens.$inferInsert;

// Live call types
export type CallSession = typeof callSessions.$inferSelect;
export type InsertCallSession = typeof callSessions.$inferInsert;
export type CallParticipant = typeof callParticipants.$inferSelect;
export type InsertCallParticipant = typeof callParticipants.$inferInsert;

// =============================================================================
// VIDEO CAPTION STUDIO — caption projects
// User-owned, keyed by a content hash of the source video. The video itself is
// NEVER stored; we persist only the hash + the derived caption segments (text
// + glyph) + language, so re-uploading the same file reloads the saved work.
// =============================================================================

/** One persisted caption segment: a timed span, its text, and its glyph SENTENCE. */
export interface CaptionProjectSegment {
  startMs: number;
  endMs: number;
  text: string;
  glyph?: string;
  /** Immediate stand-in glyph for a `generate:` sentence (shown until ready). */
  fallback?: string;
}

export const captionProjects = pgTable("caption_projects", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Owner — projects are private to the clinician who created them.
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  // SHA-256 (hex) of the source video bytes — the lookup key on re-upload.
  videoHash: varchar("video_hash").notNull(),
  videoName: text("video_name"),
  // Caption / spoken language (BCP-47-ish, e.g. "en", "he") — drives STT, glyph
  // generation, and RTL.
  language: varchar("language"),
  // Cost-attribution context: the institute/student the captioning was done
  // for (set when known). Not FK-enforced (mirrors chatSessions.instituteId).
  instituteId: varchar("institute_id"),
  studentId: varchar("student_id"),
  segments: jsonb("segments").$type<CaptionProjectSegment[]>().default([]).notNull(),
  // Accumulated cost of this project's AI work (transcription + ideas + glyphs
  // + symbol generation), mirroring chatSessions.creditsUsed/costBreakdown.
  creditsUsed: real("credits_used").notNull().default(0),
  costBreakdown: jsonb("cost_breakdown").$type<Record<string, number>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  // One project per (owner, video) — the upsert target on save.
  uniqueIndex("idx_caption_projects_user_hash").on(table.userId, table.videoHash),
  index("idx_caption_projects_user_id").on(table.userId),
  index("idx_caption_projects_institute_id").on(table.instituteId),
]);

export type CaptionProject = typeof captionProjects.$inferSelect;
export type InsertCaptionProject = typeof captionProjects.$inferInsert;
