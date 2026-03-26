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

export const instituteTypeEnum = pgEnum("institute_type", ["school", "clinic"]);

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
export const goalStatusEnum = pgEnum("goal_status", ["draft", "active", "achieved", "modified", "discontinued"]);
export const objectiveStatusEnum = pgEnum("objective_status", ["not_started", "in_progress", "achieved", "modified", "discontinued"]);
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
export const serviceFrequencyPeriodEnum = pgEnum("service_frequency_period", ["daily", "weekly", "monthly"]);
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

  // Biometric recognition fields
  faceEmbedding: jsonb("face_embedding"), // 128-dimensional face embedding vector
  voiceEmbedding: jsonb("voice_embedding"), // Voice embedding vector for speaker recognition

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

  // Biometric recognition fields
  faceEmbedding: jsonb("face_embedding"), // 128-dimensional face embedding vector
  voiceEmbedding: jsonb("voice_embedding"), // Voice embedding vector for speaker recognition

  // External storage — when set, sensitive fields are stored in the named backend
  externalStorage: varchar("external_storage"),

  // Status and metadata
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_students_framework").on(table.framework),
  index("idx_students_is_active").on(table.isActive),
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
  chatAgentPrompt: text("chat_agent_prompt"), // Custom prompt override for AAC agent
  modelOverride: text("model_override"), // AI model override (e.g., 'chatgpt5')
  interpretationLevel: integer("interpretation_level").default(2), // 0=none, 1=minimal, 2=conservative, 3=creative, 4=autonomous
  startupMode: integer("startup_mode").default(0), // 0=fast (no LLM call), 1=thorough (preloads all context + LLM summary)

  // Voice settings
  voiceType: text("voice_type"), // AI voice: 'auto', 'man', 'woman', 'boy', 'girl'
  studentVoiceType: text("student_voice_type"), // Student's voice: 'man', 'woman', 'boy', 'girl'
  customVoiceId: varchar("custom_voice_id"), // FK to voices table for custom AI voice (ElevenLabs)
  customStudentVoiceId: varchar("custom_student_voice_id"), // FK to voices table for custom student voice (ElevenLabs)

  // ElevenLabs voice settings (may be removed later)
  elevenlabsEnabled: boolean("elevenlabs_enabled").default(true), // Toggle ElevenLabs on/off without removing config
  elevenlabsApiKey: text("elevenlabs_api_key"), // Student's own ElevenLabs API key
  elevenlabsAiVoiceId: text("elevenlabs_ai_voice_id"), // ElevenLabs voice ID for AI voice
  elevenlabsStudentVoiceId: text("elevenlabs_student_voice_id"), // ElevenLabs voice ID for student voice

  // Gemini TTS voice settings
  geminiAiVoice: text("gemini_ai_voice"), // Gemini prebuilt voice for AI (e.g. "Kore", "Orus")
  geminiStudentVoice: text("gemini_student_voice"), // Gemini prebuilt voice for student (e.g. "Puck", "Leda")

  // Local browser TTS fallback
  useLocalTts: boolean("use_local_tts").default(false), // Use browser speechSynthesis instead of server TTS

  // Display settings
  iconTextRatio: integer("icon_text_ratio").default(3), // Icon-to-text size ratio 1–5 (1=mostly icon, 5=mostly text)
  usePcsSymbols: boolean("use_pcs_symbols").default(false), // PCS vs emoji preference

  // Auto-generated symbol settings
  generateSymbols: boolean("generate_symbols").default(false).notNull(), // Generate symbol images on-the-fly via Gemini
  useApprovedSymbols: boolean("use_approved_symbols").default(false).notNull(), // Show approved generated symbols on buttons
  useUnapprovedSymbols: boolean("use_unapproved_symbols").default(false).notNull(), // Also show unapproved (newly generated) symbols

  // Input settings
  signLanguageReading: boolean("sign_language_reading").default(false), // Sign language detection enabled
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

  // App configuration — per-app settings stored as JSON (e.g. { youtube: { enabled: true }, spotify: { enabled: true } })
  appConfig: jsonb("app_config").default({}),

  // Recognition
  knownPeople: jsonb("known_people").default([]), // Array of known people for recognition

  // Metadata
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_aac_settings_student_id").on(table.studentId),
]);

// Student contacts — people the student knows (classmates, siblings, etc.) with optional biometrics
export const studentContacts = pgTable("student_contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").references(() => students.id).notNull(),
  name: text("name").notNull(),
  relationship: text("relationship"), // 'classmate', 'sibling', 'teacher', etc.
  hairColor: text("hair_color"),
  estimatedAge: text("estimated_age"), // '8', '30s', 'child', 'adult'
  estimatedSex: text("estimated_sex"), // 'male', 'female', 'unknown'
  description: text("description"), // free-form physical/contextual description
  contextNotes: text("context_notes"), // what AI knows about interactions/relationship
  faceEmbedding: jsonb("face_embedding"), // 128D float array
  voiceEmbedding: jsonb("voice_embedding"), // future use
  faceImageData: text("face_image_data"), // base64-encoded JPEG of cropped face (legacy, unused - face images cached client-side)
  faceImageQuality: real("face_image_quality"), // quality score (0–1), higher = more frontal + larger
  lastSeenAt: timestamp("last_seen_at"),
  timesIdentified: integer("times_identified").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_student_contacts_student_id").on(table.studentId),
  index("idx_student_contacts_is_active").on(table.isActive),
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

  // Status tracking
  status: objectiveStatusEnum("status").default("not_started").notNull(),
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

  // Provider
  providerId: varchar("provider_id").references(() => teamMembers.id),
  providerName: text("provider_name"), // Fallback if no linked team member

  // Frequency & Duration
  frequencyCount: integer("frequency_count").notNull().default(1),
  frequencyPeriod: serviceFrequencyPeriodEnum("frequency_period").notNull().default("weekly"),
  sessionDuration: integer("session_duration").notNull(), // minutes

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

  recordedAt: timestamp("recorded_at").notNull(),
  value: text("value").notNull(),
  numericValue: real("numeric_value"), // For graphing
  context: text("context"),
  collectedBy: text("collected_by"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_data_points_progress_entry_id").on(table.goalProgressEntryId),
  index("idx_data_points_goal_id").on(table.goalId),
  index("idx_data_points_objective_id").on(table.objectiveId),
  index("idx_data_points_recorded_at").on(table.recordedAt),
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
 * Team Members - People involved in the program
 */
export const teamMembers = pgTable("team_members", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  programId: varchar("program_id").references(() => programs.id).notNull(),

  // Can optionally link to a user account
  userId: varchar("user_id").references(() => users.id),

  name: text("name").notNull(),
  role: teamMemberRoleEnum("role").notNull(),
  customRole: text("custom_role"), // For 'other' role

  organization: text("organization"), // For external providers
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),

  responsibilities: text("responsibilities").array(),
  isCoordinator: boolean("is_coordinator").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_team_members_program_id").on(table.programId),
  index("idx_team_members_user_id").on(table.userId),
  index("idx_team_members_role").on(table.role),
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

// =============================================================================
// SESSIONS / CONTENT TABLES (Private)
// =============================================================================

// Chat sessions
export const chatSessions = pgTable("chat_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // User context - at least one must be provided
  userId: varchar("user_id").references(() => users.id),
  studentId: varchar("student_id").references(() => students.id),
  userStudentId: varchar("user_student_id").references(() => userStudents.id), // The relationship record if both are provided

  // Chat mode determines which agent template to use
  chatMode: varchar("chat_mode").notNull().default("chat"),

  started: timestamp("started").notNull().defaultNow(),
  lastUpdate: timestamp("last_update").notNull().defaultNow(),
  state: jsonb("state").notNull(),
  log: jsonb("log").notNull().default([]),
  last: jsonb("last").notNull().default([]),
  deletedAt: timestamp("deleted_at"),
  creditsUsed: real("credits_used").notNull().default(0),
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
}, (table) => [
  index("idx_chat_sessions_user_id").on(table.userId),
  index("idx_chat_sessions_student_id").on(table.studentId),
  index("idx_chat_sessions_status").on(table.status),
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  loadedAt: timestamp("loaded_at").defaultNow().notNull(),
});

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
export const insertAacSettingsSchema = createInsertSchema(aacSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateAacSettingsSchema = createInsertSchema(aacSettings).omit({
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

// Team member schemas
export const insertTeamMemberSchema = createInsertSchema(teamMembers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateTeamMemberSchema = createInsertSchema(teamMembers).omit({
  id: true,
  programId: true,
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

export type TransitionPlan = typeof transitionPlans.$inferSelect;
export type InsertTransitionPlan = z.infer<typeof insertTransitionPlanSchema>;
export type UpdateTransitionPlan = z.infer<typeof updateTransitionPlanSchema>;

export type TransitionGoal = typeof transitionGoals.$inferSelect;
export type InsertTransitionGoal = z.infer<typeof insertTransitionGoalSchema>;
export type UpdateTransitionGoal = z.infer<typeof updateTransitionGoalSchema>;

export type TeamMember = typeof teamMembers.$inferSelect;
export type InsertTeamMember = z.infer<typeof insertTeamMemberSchema>;
export type UpdateTeamMember = z.infer<typeof updateTeamMemberSchema>;

export type Meeting = typeof meetings.$inferSelect;
export type InsertMeeting = z.infer<typeof insertMeetingSchema>;
export type UpdateMeeting = z.infer<typeof updateMeetingSchema>;

export type ConsentForm = typeof consentForms.$inferSelect;
export type InsertConsentForm = z.infer<typeof insertConsentFormSchema>;
export type UpdateConsentForm = z.infer<typeof updateConsentFormSchema>;

// Chat types
export type ChatSession = typeof chatSessions.$inferSelect;
export type InsertChatSession = z.infer<typeof insertChatSessionSchema>;

// Board types
export type Board = typeof boards.$inferSelect;
export type InsertBoard = z.infer<typeof insertBoardSchema>;

// Content types
export type InviteCode = typeof inviteCodes.$inferSelect;
export type InsertInviteCode = z.infer<typeof insertInviteCodeSchema>;
export type InviteCodeRedemption = typeof inviteCodeRedemptions.$inferSelect;
export type RedeemInviteCode = z.infer<typeof redeemInviteCodeSchema>;

export type StudentSymbolAssociation = typeof studentSymbolAssociations.$inferSelect;
export type InsertStudentSymbolAssociation = z.infer<typeof insertStudentSymbolAssociationSchema>;
export type UpdateStudentSymbolAssociation = z.infer<typeof updateStudentSymbolAssociationSchema>;

// Domain types
export type ProgramFramework = 'tala' | 'us_iep';
export type ProgramStatus = 'draft' | 'active' | 'archived';
export type ProfileDomainType = 'cognitive_academic' | 'communication_language' | 'social_emotional_behavioral' | 'motor_sensory' | 'life_skills_preparation' | 'other';
export type AssessmentSourceType = 'standardized_test' | 'structured_observation' | 'parent_questionnaire' | 'teacher_input' | 'curriculum_based' | 'behavioral_records';
export type InterventionLevel = 'activity' | 'function' | 'participation';
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
export type InstituteType = 'school' | 'clinic';
