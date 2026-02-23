import { pgTable, text, serial, integer, boolean, timestamp, real, varchar, jsonb, index, uniqueIndex, numeric, AnyPgColumn, pgEnum, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { sql, relations } from "drizzle-orm";
import { z } from "zod";

// =============================================================================
// ENUMS
// =============================================================================

export const apiTypeEnum = pgEnum("api_type", [
  "llm", "tts", "stt", "embedding", "image", "vector", "moderation", "tool", "other"
]);

export const chatSessionStatusEnum = pgEnum("chat_session_status", ["open", "paused", "closed"]);
export const aacSessionStatusEnum = pgEnum("aac_session_status", ["active", "paused", "ended"]);

export const instituteTypeEnum = pgEnum("institute_type", ["school", "hospital"]);

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
export const auditActionEnum = pgEnum("audit_action", [
  "read",
  "create",
  "update",
  "delete",
  "export",
  "login",
  "logout",
  "login_failed",
  "access_denied"
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
// CORE USER MANAGEMENT TABLES
// =============================================================================

// Session storage table for admin authentication
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// Admin users table for backoffice access
export const adminUsers = pgTable("admin_users", {
  id: varchar("id").primaryKey().notNull(),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  role: text("role").default("admin"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

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

  // 🔑 self-referencing FK – note the AnyPgColumn annotation
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
// INSTITUTE MANAGEMENT TABLES
// =============================================================================

// Institutes table - Schools or Hospitals that can own licenses
export const institutes = pgTable("institutes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  type: instituteTypeEnum("type").notNull(), // 'school' or 'hospital'
  description: text("description"),
  address: text("address"),
  phone: text("phone"),
  email: text("email"),
  website: text("website"),
  logoUrl: text("logo_url"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_institutes_type").on(table.type),
  index("idx_institutes_is_active").on(table.isActive),
]);

// Junction table for many-to-many relationship between Users and Institutes
export const instituteUsers = pgTable("institute_users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  instituteId: varchar("institute_id").references(() => institutes.id).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  isAdmin: boolean("is_admin").default(false).notNull(), // Whether user is an admin of this institute
  role: text("role").default("staff"), // 'staff', 'therapist', 'teacher', etc.
  data: jsonb("data").default({}), // Private data for this relationship
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_institute_users_institute_id").on(table.instituteId),
  index("idx_institute_users_user_id").on(table.userId),
]);

export const instituteInvites = pgTable("institute_invites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Institute this invite is for
  instituteId: varchar("institute_id").references(() => institutes.id).notNull(),
  
  // The email of the person being invited
  inviteeEmail: text("invitee_email").notNull(),
  
  // If the invitee already has an account, link to their user
  inviteeUserId: varchar("invitee_user_id").references(() => users.id),
  
  // User who created the invite
  invitedByUserId: varchar("invited_by_user_id").references(() => users.id).notNull(),
  
  // Role to assign when invite is accepted
  role: text("role").default("staff").notNull(),
  
  // Whether to grant admin access
  grantAdmin: boolean("grant_admin").default(false).notNull(),
  
  // Unique token for invite link
  token: text("token").notNull().unique(),
  
  // Status tracking
  status: instituteInviteStatusEnum("status").default("pending").notNull(),
  
  // Optional message from inviter
  message: text("message"),
  
  // Expiration
  expiresAt: timestamp("expires_at").notNull(),
  
  // Timestamps
  respondedAt: timestamp("responded_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_institute_invites_institute_id").on(table.instituteId),
  index("idx_institute_invites_invitee_email").on(table.inviteeEmail),
  index("idx_institute_invites_invitee_user_id").on(table.inviteeUserId),
  index("idx_institute_invites_token").on(table.token),
  index("idx_institute_invites_status").on(table.status),
]);

/**
 * Classrooms - Organizational units within schools
 * Only applicable to institutes of type 'school'
 */
export const classrooms = pgTable("classrooms", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  instituteId: varchar("institute_id").references(() => institutes.id).notNull(),
  name: text("name").notNull(),
  grade: gradeEnum("grade"),
  description: text("description"),
  capacity: integer("capacity"), // Optional max students
  roomNumber: text("room_number"), // Physical room identifier
  academicYear: text("academic_year"), // e.g., "2024-2025"
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_classrooms_institute_id").on(table.instituteId),
  index("idx_classrooms_is_active").on(table.isActive),
  index("idx_classrooms_grade").on(table.grade),
]);

export const classroomUsers = pgTable("classroom_users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  classroomId: varchar("classroom_id").references(() => classrooms.id).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  role: text("role").default("teacher").notNull(), // Uses classroomRoleEnum values
  isPrimary: boolean("is_primary").default(false).notNull(), // Is this the primary assignment?
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_classroom_users_classroom_id").on(table.classroomId),
  index("idx_classroom_users_user_id").on(table.userId),
  index("idx_classroom_users_is_active").on(table.isActive),
]);

export const studentClassrooms = pgTable("student_classrooms", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").references(() => students.id).notNull(),
  classroomId: varchar("classroom_id").references(() => classrooms.id).notNull(),
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
// MEDICAL RECORDS TABLE (Separated from students)
// =============================================================================

export const medicalRecords = pgTable("medical_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").notNull(),
  userId: varchar("user_id"), // Who created/owns this record
  instituteId: varchar("institute_id"), // Should be a hospital that the student is linked to

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

// =============================================================================
// FUNCTIONAL REPORTS TABLE
// =============================================================================

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

// =============================================================================
// EDUCATIONAL REPORTS TABLE
// =============================================================================

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
// AUDIT LOGS TABLE (No PII)
// =============================================================================

export const auditLogs = pgTable("audit_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Actor (IDs only, no names)
  actorUserId: varchar("actor_user_id"),
  actorIpHash: text("actor_ip_hash"),
  
  // Action
  action: auditActionEnum("action").notNull(),
  resourceType: text("resource_type"),
  resourceId: varchar("resource_id"),
  
  // Tenant context
  instituteId: varchar("institute_id"),
  sessionId: text("session_id"),
  
  // Change tracking (field names only, no values for sensitive fields)
  changedFields: text("changed_fields").array(),
  
  // Request metadata
  requestPath: text("request_path"),
  requestMethod: text("request_method"),
  
  // Outcome
  success: boolean("success").notNull(),
  statusCode: integer("status_code"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  
  durationMs: integer("duration_ms"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_audit_logs_actor_user_id").on(table.actorUserId),
  index("idx_audit_logs_action").on(table.action),
  index("idx_audit_logs_resource").on(table.resourceType, table.resourceId),
  index("idx_audit_logs_institute_id").on(table.instituteId),
  index("idx_audit_logs_created_at").on(table.createdAt),
]);

// =============================================================================
// LICENSE MANAGEMENT TABLES
// =============================================================================

// Licenses table - Responsible for payments, can be owned by institute or private user
export const licenses = pgTable("licenses", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Ownership - if instituteId is null and userId exists, it's a private license
  instituteId: varchar("institute_id").references(() => institutes.id), // Optional - institute that owns this license
  userId: varchar("user_id").references(() => users.id), // Optional - user assigned to this license
  
  // License details
  name: text("name"), // Optional friendly name for the license
  licenseType: text("license_type").notNull().default("standard"), // 'standard', 'premium', 'enterprise'
  
  // Payment & subscription info
  subscriptionType: text("subscription_type").default("free"), // 'free', 'monthly', 'yearly'
  subscriptionExpiresAt: timestamp("subscription_expires_at"),
  credits: integer("credits").default(0).notNull(),
  
  // Stripe/payment integration
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  
  // Status
  isActive: boolean("is_active").default(true).notNull(),
  activatedAt: timestamp("activated_at"),
  suspendedAt: timestamp("suspended_at"),
  suspensionReason: text("suspension_reason"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_licenses_institute_id").on(table.instituteId),
  index("idx_licenses_user_id").on(table.userId),
  index("idx_licenses_is_active").on(table.isActive),
]);

// =============================================================================
// STUDENT MANAGEMENT TABLES
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
  elevenlabsApiKey: text("elevenlabs_api_key"), // Student's own ElevenLabs API key
  elevenlabsAiVoiceId: text("elevenlabs_ai_voice_id"), // ElevenLabs voice ID for AI voice
  elevenlabsStudentVoiceId: text("elevenlabs_student_voice_id"), // ElevenLabs voice ID for student voice

  // Display settings
  iconTextRatio: integer("icon_text_ratio").default(3), // Icon-to-text size ratio 1–5 (1=mostly icon, 5=mostly text)
  usePcsSymbols: boolean("use_pcs_symbols").default(false), // PCS vs emoji preference

  // Input settings
  signLanguageReading: boolean("sign_language_reading").default(false), // Sign language detection enabled
  multiCameraMode: boolean("multi_camera_mode").default(false), // Multi-camera support

  // Eyegaze / dwell settings
  eyegazeEnabled: boolean("eyegaze_enabled").default(false), // Enable dwell-based symbol selection
  eyegazeTimeout: integer("eyegaze_timeout").default(2000), // Dwell time in ms (1000-10000)
  eyegazeProvider: text("eyegaze_provider"), // 'auto', 'camera', 'tobii', 'eyetech', 'lctech', 'webhid', 'mouse'

  // AI identity
  aiName: text("ai_name"), // Custom AI name (e.g. "Buddy", "Sam")

  // Privacy — gate monitor agent access to sensitive student data
  allowReadProgress: boolean("allow_read_progress").default(true).notNull(),
  allowReadReports: boolean("allow_read_reports").default(true).notNull(),
  allowNotes: boolean("allow_notes").default(true).notNull(),

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
  instituteId: varchar("institute_id").references(() => institutes.id).notNull(),
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

// =============================================================================
// IEP/TALA PROGRAM TABLES
// =============================================================================

/**
 * Programs - The IEP/TALA document itself
 * A student can have multiple programs over their school career (one per year)
 */
export const programs = pgTable("programs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").references(() => students.id).notNull(),
  instituteId: varchar("institute_id").references(() => institutes.id),
  
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
// CREDITS & BILLING TABLES
// =============================================================================

// Credits transactions table for tracking credit usage
export const creditTransactions = pgTable("credit_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  amount: integer("amount").notNull(), // positive for additions, negative for usage
  type: text("type").notNull(), // 'purchase', 'usage', 'refund', 'bonus'
  description: text("description").notNull(),
  relatedInterpretationId: varchar("related_interpretation_id").references(() => interpretations.id),
  stripePaymentIntentId: text("stripe_payment_intent_id"), // For tracking Stripe payments
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Credit packages table for different credit purchase options
export const creditPackages = pgTable("credit_packages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  credits: integer("credits").notNull(),
  price: real("price").notNull(), // Price in USD
  bonusCredits: integer("bonus_credits").default(0).notNull(), // Extra credits for bulk purchases
  isActive: boolean("is_active").default(true).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Subscription plans table
export const subscriptionPlans = pgTable("subscription_plans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(),
  price: real("price").notNull(),
  credits: integer("credits").notNull(),
  duration: integer("duration").notNull(), // in days
  isActive: boolean("is_active").default(true).notNull(),
  features: text("features").array(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// RevenueCat subscriptions table for tracking active subscriptions
export const revenuecatSubscriptions = pgTable("revenuecat_subscriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  revenuecatAppUserId: text("revenuecat_app_user_id").notNull(), // RevenueCat's user ID
  originalTransactionId: text("original_transaction_id").notNull().unique(),
  productId: text("product_id").notNull(),
  entitlementIds: text("entitlement_ids").array(),
  purchaseDate: timestamp("purchase_date").notNull(),
  expirationDate: timestamp("expiration_date"),
  isActive: boolean("is_active").default(true).notNull(),
  environment: text("environment").notNull(), // 'PRODUCTION' or 'SANDBOX'
  store: text("store").notNull(), // 'APP_STORE', 'PLAY_STORE', 'STRIPE', etc.
  price: real("price"),
  currency: text("currency").default("USD"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// RevenueCat webhook events table for logging and debugging
export const revenuecatWebhookEvents = pgTable("revenuecat_webhook_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  eventType: text("event_type").notNull(), // INITIAL_PURCHASE, RENEWAL, CANCELLATION, etc.
  revenuecatAppUserId: text("revenuecat_app_user_id").notNull(),
  originalTransactionId: text("original_transaction_id"),
  productId: text("product_id"),
  entitlementIds: text("entitlement_ids").array(),
  eventTimestamp: timestamp("event_timestamp").notNull(),
  environment: text("environment").notNull(),
  price: real("price"),
  currency: text("currency"),
  rawPayload: jsonb("raw_payload").notNull(), // Store complete webhook payload
  processed: boolean("processed").default(false).notNull(),
  processedAt: timestamp("processed_at"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// RevenueCat products table for storing product/offering information
export const revenuecatProducts = pgTable("revenuecat_products", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  productId: text("product_id").notNull().unique(),
  packageType: text("package_type"), // annual, monthly, etc.
  entitlementIds: text("entitlement_ids").array(),
  creditsGranted: integer("credits_granted").notNull().default(0),
  displayName: text("display_name").notNull(),
  description: text("description"),
  price: real("price"),
  currency: text("currency").default("USD"),
  duration: integer("duration"), // in days
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// =============================================================================
// CONTENT TABLES
// =============================================================================

// Interpretations table
export const interpretations = pgTable("interpretations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  originalInput: text("original_input").notNull(),
  interpretedMeaning: text("interpreted_meaning").notNull(),
  analysis: text("analysis").array().notNull(),
  confidence: real("confidence").notNull(), // AI confidence score (0.0-1.0)
  suggestedResponse: text("suggested_response").notNull(),
  inputType: text("input_type").notNull(), // 'text' or 'image'
  language: text("language").default("he"),
  context: text("context"),
  // Image storage for thumbnails and full images
  imageData: text("image_data"), // Base64 encoded image data for 'image' type interpretations
  // Student identification fields - now references primary key
  studentId: varchar("student_id").references(() => students.id), // Reference to Student's primary key
  studentName: text("student_name"), // Human-readable name for the Student (was "studentAlias")
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

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

// Saved locations table for user's GPS aliases and custom locations
export const savedLocations = pgTable("saved_locations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  alias: text("alias").notNull(), // User-friendly name like "דיקלה's קפה" or "בית של סבתא"
  locationType: text("location_type").notNull(), // 'gps' or 'preset' or 'custom'
  locationName: text("location_name").notNull(), // The actual location (GPS coords or text)
  latitude: real("latitude"), // For GPS locations
  longitude: real("longitude"), // For GPS locations
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// =============================================================================
// BOARD TABLES
// =============================================================================

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

// =============================================================================
// API PROVIDER TABLES
// =============================================================================

// API Providers table
export const apiProviders = pgTable("api_providers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(),
  key: text("key").notNull(),
  currencyCode: text("currency_code").default("USD").notNull(),
  pricingJson: jsonb("pricing_json").notNull(), // Stores pricing rules per unit or token
  isActive: boolean("is_active").default(true).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// API calls table for tracking all API usage and costs
export const apiCalls = pgTable("api_calls", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  providerId: varchar("provider_id").references(() => apiProviders.id).notNull(),
  apiType: apiTypeEnum("api_type").default("llm").notNull(),
  endpoint: text("endpoint").notNull(),
  model: text("model"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  totalTokens: integer("total_tokens"),
  unitsUsed: integer("units_used"),
  characters: integer("characters"),
  seconds: integer("seconds"),
  requests: integer("requests").default(1),
  inputCostUsd: numeric("input_cost_usd", { precision: 20, scale: 6 }).notNull(),
  outputCostUsd: numeric("output_cost_usd", { precision: 20, scale: 6 }).notNull(),
  totalCostUsd: numeric("total_cost_usd", { precision: 20, scale: 6 }).notNull(),
  responseTimeMs: integer("response_time_ms"),
  responseMetadata: jsonb("response_metadata"),
  requestData: jsonb("request_data"),
  durationMs: integer("duration_ms"),
  success: boolean("success").notNull().default(true),
  errorMessage: text("error_message"),
  userId: varchar("user_id").references(() => users.id),
  sessionId: text("session_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// API Provider Pricing table
export const apiProviderPricing = pgTable("api_provider_pricing", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  provider: text("provider").notNull(), // 'gemini', 'openai', 'elevenlabs'
  model: text("model").notNull(), // 'gemini-2.5-flash', 'gpt-4'
  endpoint: text("endpoint"), // specific endpoint if pricing varies
  pricingType: text("pricing_type").notNull(), // 'per_token', 'per_character', 'per_second', 'per_request'
  inputPricePerUnit: varchar("input_price_per_unit", { length: 20 }), // price per input unit (USD)
  outputPricePerUnit: varchar("output_price_per_unit", { length: 20 }), // price per output unit (USD)
  currency: text("currency").notNull().default("USD"),
  effectiveFrom: timestamp("effective_from").notNull(),
  effectiveUntil: timestamp("effective_until"),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"), // additional pricing notes
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow()
});

// =============================================================================
// INTEGRATION TABLES
// =============================================================================

// Dropbox Integration - Connections
export const dropboxConnections = pgTable("dropbox_connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  dropboxAccountId: text("dropbox_account_id").notNull(),
  dropboxEmail: text("dropbox_email").notNull(),
  encryptedAccessToken: text("encrypted_access_token").notNull(),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  tokenExpiresAt: timestamp("token_expires_at").notNull(),
  backupFolderPath: text("backup_folder_path").notNull().default("/Apps/SyntAACx/Backups"),
  autoBackupEnabled: boolean("auto_backup_enabled").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow()
});

// Dropbox Integration - Backups
export const dropboxBackups = pgTable("dropbox_backups", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  boardName: text("board_name").notNull(), // Store board name instead of ID for generated boards
  fileType: text("file_type").notNull(), // gridset, snappkg, touchchat, obz, master_aac
  fileName: text("file_name").notNull(),
  dropboxPath: text("dropbox_path").notNull(),
  dropboxFileId: text("dropbox_file_id"),
  shareableUrl: text("shareable_url"),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  status: text("status").notNull().default("pending"), // pending, uploading, completed, failed
  errorMessage: text("error_message"),
  uploadDurationMs: integer("upload_duration_ms"),
  isAutoBackup: boolean("is_auto_backup").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at")
});

// =============================================================================
// CHAT TABLES
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

// =============================================================================
// AAC SESSIONS (Real-time AAC communication for non-verbal users)
// =============================================================================

// AAC Session context types (stored as JSONB)
export interface AACVisualContext {
  sceneDescription?: string;
  objects?: string[];
  location?: string;
  activities?: string[];
  timestamp?: string;
}

export interface AACPersonDetection {
  personPresent: boolean;
  isMainUser?: boolean;
  age?: number;
  gender?: string;
  facialExpression?: string;
  emotionalState?: string;
  confidence?: number;
}

export interface AACAudioContext {
  transcript?: string;
  detectedLanguage?: string;
  confidence?: number;
  speechPresent?: boolean;
  ambientSounds?: string[];
  emotionalTone?: string;
  speakerCount?: number;
}

export interface AACSymbol {
  id: string;
  label: string;
  emoji?: string;
  confidence?: number;
  category?: string;
  reasoning?: string;
}

export interface AACKnownPerson {
  id: string;
  name: string;
  relationship: string; // 'parent', 'sibling', 'therapist', 'teacher', etc.
  age?: number;
  gender?: string;
  description?: string; // Physical description for recognition
  photo?: string; // URL or base64 for face recognition
}

export interface AACSessionContext {
  visualContext?: AACVisualContext;
  personDetection?: AACPersonDetection;
  audioContext?: AACAudioContext;
  cameraVisualContexts?: Record<string, AACVisualContext>;
  emotionalContext?: string;
  lastSymbols?: AACSymbol[];
  timeOfDay?: string;
  demoScenario?: string;
}

export interface AACMessage {
  id: string;
  role: 'agent' | 'user';
  content: string;
  symbols?: AACSymbol[];
  timestamp: string;
  audioGenerated?: boolean;
  audioUrl?: string;
}

export const aacSessions = pgTable("aac_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").references(() => students.id).notNull(),
  userId: varchar("user_id").references(() => users.id), // Who started/is monitoring this session

  // Real-time context (updated frequently)
  context: jsonb("context").$type<AACSessionContext>().default({}),

  // Conversation state
  conversationHistory: jsonb("conversation_history").$type<AACMessage[]>().default([]),

  // Credit tracking
  creditsUsed: real("credits_used").notNull().default(0),

  // Session management
  status: aacSessionStatusEnum("status").notNull().default("active"),
  started: timestamp("started").notNull().defaultNow(),
  lastActivity: timestamp("last_activity").notNull().defaultNow(),
  ended: timestamp("ended"),

  // Metadata
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_aac_sessions_student_id").on(table.studentId),
  index("idx_aac_sessions_user_id").on(table.userId),
  index("idx_aac_sessions_status").on(table.status),
  index("idx_aac_sessions_last_activity").on(table.lastActivity),
]);

// =============================================================================
// PERSONA AND LIBRARY TABLES
// =============================================================================

// AI Personas - configurable AI personalities with custom prompts
export const personas = pgTable("personas", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  icon: text("icon").notNull(), // Emoji or icon identifier
  prompt: text("prompt").notNull(), // System prompt text for this persona
  manualSelection: boolean("manual_selection").default(true).notNull(), // Whether users can manually select this persona
  active: boolean("active").default(true).notNull(),
  llmProvider: text("llm_provider"), // Optional per-persona LLM provider override (e.g. "openai", "gemini", "claude")
  llmModel: text("llm_model"), // Optional per-persona LLM model override (e.g. "gpt-4o", "claude-sonnet")
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_personas_active").on(table.active),
  index("idx_personas_manual_selection").on(table.manualSelection),
]);

// Custom Voices - admin-managed TTS voices (e.g. ElevenLabs)
export const voices = pgTable("voices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  externalId: text("external_id").notNull(), // Provider voice ID (e.g. ElevenLabs voice_id)
  source: text("source").notNull().default("elevenlabs"), // TTS provider
  description: text("description"),
  sampleUrl: text("sample_url"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_voices_active").on(table.active),
  index("idx_voices_source").on(table.source),
]);

// Library Topics - hierarchical knowledge base for RAG
export const topics = pgTable("topics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  parentId: varchar("parent_id").references((): AnyPgColumn => topics.id), // Self-referencing for hierarchy
  content: text("content").notNull().default(''), // Plain text content for AI consumption
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_topics_parent_id").on(table.parentId),
  index("idx_topics_active").on(table.active),
  uniqueIndex("idx_topics_title_parent").on(table.title, table.parentId), // Title unique per parent
]);

// =============================================================================
// SYSTEM SETTINGS (key-value store for LLM config etc.)
// =============================================================================

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// =============================================================================
// CUSTOM SYMBOLS TABLES
// =============================================================================

// Custom symbols — user-uploaded or AI-generated icons for AAC boards
export const customSymbols = pgTable("custom_symbols", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  s3Key: text("s3_key").notNull(),
  key: text("key"), // human-readable key, only set for public symbols
  description: text("description"),
  isPublic: boolean("is_public").default(false).notNull(),
  isApproved: boolean("is_approved").default(true).notNull(),
  createdByUserId: varchar("created_by_user_id").references(() => users.id),
  width: integer("width"),
  height: integer("height"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_custom_symbols_is_public").on(table.isPublic),
  index("idx_custom_symbols_key").on(table.key),
  index("idx_custom_symbols_created_by").on(table.createdByUserId),
]);

// User-symbol associations — links symbols to users with optional key/description overrides
export const userSymbolAssociations = pgTable("user_symbol_associations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  symbolId: varchar("symbol_id").references(() => customSymbols.id, { onDelete: "cascade" }).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  key: text("key"),
  description: text("description"),
  isApproved: boolean("is_approved").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_user_symbol_assoc_symbol_id").on(table.symbolId),
  index("idx_user_symbol_assoc_user_id").on(table.userId),
  uniqueIndex("idx_user_symbol_assoc_unique").on(table.symbolId, table.userId),
]);

// Student-symbol associations — links symbols to students with optional key/description overrides
export const studentSymbolAssociations = pgTable("student_symbol_associations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  symbolId: varchar("symbol_id").references(() => customSymbols.id, { onDelete: "cascade" }).notNull(),
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

// Institute-symbol associations — links symbols to institutes with optional key/description overrides
export const instituteSymbolAssociations = pgTable("institute_symbol_associations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  symbolId: varchar("symbol_id").references(() => customSymbols.id, { onDelete: "cascade" }).notNull(),
  instituteId: varchar("institute_id").references(() => institutes.id).notNull(),
  key: text("key"),
  description: text("description"),
  isApproved: boolean("is_approved").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_institute_symbol_assoc_symbol_id").on(table.symbolId),
  index("idx_institute_symbol_assoc_institute_id").on(table.instituteId),
  uniqueIndex("idx_institute_symbol_assoc_unique").on(table.symbolId, table.instituteId),
]);

// =============================================================================
// INSERT/UPDATE SCHEMAS
// =============================================================================

// User schemas
export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Institute schemas
export const insertInstituteSchema = createInsertSchema(institutes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateInstituteSchema = createInsertSchema(institutes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial();

export const insertInstituteUserSchema = createInsertSchema(instituteUsers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateInstituteUserSchema = createInsertSchema(instituteUsers).omit({
  id: true,
  instituteId: true,
  userId: true,
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

export const insertInstituteInviteSchema = createInsertSchema(instituteInvites, {
  inviteeEmail: z.string().email("Invalid email address"),
  role: z.string().optional(),
  grantAdmin: z.boolean().optional(),
  message: z.string().max(500).optional(),
});

export const insertClassroomSchema = createInsertSchema(classrooms).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertClassroomUserSchema = createInsertSchema(classroomUsers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertStudentClassroomSchema = createInsertSchema(studentClassrooms).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const updateClassroomSchema = insertClassroomSchema.partial();
export const updateClassroomUserSchema = insertClassroomUserSchema.partial();
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

// License schemas
export const insertLicenseSchema = createInsertSchema(licenses).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateLicenseSchema = createInsertSchema(licenses).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial();

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

// Custom symbol schemas
export const insertCustomSymbolSchema = createInsertSchema(customSymbols).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateCustomSymbolSchema = createInsertSchema(customSymbols).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial();

export const insertUserSymbolAssociationSchema = createInsertSchema(userSymbolAssociations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateUserSymbolAssociationSchema = createInsertSchema(userSymbolAssociations).omit({
  id: true,
  symbolId: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

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

export const insertInstituteSymbolAssociationSchema = createInsertSchema(instituteSymbolAssociations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateInstituteSymbolAssociationSchema = createInsertSchema(instituteSymbolAssociations).omit({
  id: true,
  symbolId: true,
  instituteId: true,
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

// =============================================================================
// IEP/TALA PROGRAM SCHEMAS
// =============================================================================

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

// =============================================================================
// OTHER INSERT SCHEMAS
// =============================================================================

// Content schemas
export const insertInterpretationSchema = createInsertSchema(interpretations).omit({
  id: true,
  createdAt: true,
});

export const insertInviteCodeSchema = createInsertSchema(inviteCodes).omit({
  id: true,
  code: true, // Auto-generated
  timesRedeemed: true,
  createdAt: true,
});

export const redeemInviteCodeSchema = z.object({
  code: z.string().min(8, "Invalid invite code").max(8, "Invalid invite code"),
});

export const insertSavedLocationSchema = createInsertSchema(savedLocations).omit({
  id: true,
  createdAt: true,
});

// Credit schemas
export const insertCreditTransactionSchema = createInsertSchema(creditTransactions).omit({
  id: true,
  createdAt: true,
});

export const insertCreditPackageSchema = createInsertSchema(creditPackages).omit({
  id: true,
  createdAt: true,
});

export const insertSubscriptionPlanSchema = createInsertSchema(subscriptionPlans).omit({
  id: true,
  createdAt: true,
});

export const insertRevenuecatSubscriptionSchema = createInsertSchema(revenuecatSubscriptions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertRevenuecatWebhookEventSchema = createInsertSchema(revenuecatWebhookEvents).omit({
  id: true,
  processed: true,
  processedAt: true,
  createdAt: true,
});

export const insertRevenuecatProductSchema = createInsertSchema(revenuecatProducts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// API schemas
export const insertApiProviderSchema = createInsertSchema(apiProviders).omit({
  id: true,
  updatedAt: true,
});

export const insertApiCallSchema = createInsertSchema(apiCalls).omit({
  id: true,
  createdAt: true,
});

export const insertApiProviderPricingSchema = createInsertSchema(apiProviderPricing).omit({
  id: true,
  createdAt: true,
  updatedAt: true
});

// Integration schemas
export const insertDropboxConnectionSchema = createInsertSchema(dropboxConnections).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertDropboxBackupSchema = createInsertSchema(dropboxBackups).omit({
  id: true,
  createdAt: true,
  completedAt: true
});

// Chat schemas
export const insertChatSessionSchema = createInsertSchema(chatSessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
});

// AAC Session schemas
export const insertAACSessionSchema = createInsertSchema(aacSessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});


// Persona schemas
export const insertPersonaSchema = createInsertSchema(personas).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updatePersonaSchema = createInsertSchema(personas).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// Voice schemas
export const insertVoiceSchema = createInsertSchema(voices).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateVoiceSchema = createInsertSchema(voices).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// Topic schemas
export const insertTopicSchema = createInsertSchema(topics).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateTopicSchema = createInsertSchema(topics).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// Board schemas
export const insertBoardSchema = createInsertSchema(boards).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Password policy configuration
export const passwordPolicy = {
  minLength: 8,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecialChar: false,
} as const;

// Password validation schema with policy enforcement
export const passwordSchema = z
  .string()
  .min(passwordPolicy.minLength, `Password must be at least ${passwordPolicy.minLength} characters`)
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[0-9]/, "Password must contain at least one number");

// Helper function to validate password (for use outside Zod)
export function validatePassword(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (password.length < passwordPolicy.minLength) {
    errors.push(`Password must be at least ${passwordPolicy.minLength} characters`);
  }
  if (passwordPolicy.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push("Password must contain at least one uppercase letter");
  }
  if (passwordPolicy.requireLowercase && !/[a-z]/.test(password)) {
    errors.push("Password must contain at least one lowercase letter");
  }
  if (passwordPolicy.requireNumber && !/[0-9]/.test(password)) {
    errors.push("Password must contain at least one number");
  }

  return { valid: errors.length === 0, errors };
}

// Authentication schemas
export const loginSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

export const registerSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  password: passwordSchema,
  userType: z.enum(["admin", "Teacher", "Caregiver", "SLP", "Parent"], {
    errorMap: () => ({ message: "Please select a valid user type" }),
  }),
});

export const interpretRequestSchema = z.object({
  input: z.string().min(1, "Input cannot be empty"),
  inputType: z.enum(["text", "image"]),
  imageData: z.string().optional(),
});

export const updateUserSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  userType: z.enum(["admin", "Teacher", "Caregiver", "SLP", "Parent"]).optional(),
  credits: z.number().optional(),
  subscriptionType: z.string().optional(),
  subscriptionExpiresAt: z.date().optional(),
  isActive: z.boolean().optional(),
});

// Pricing validation schemas
export const tokenBasedPricingSchema = z.object({
  cost_calculation: z.literal("token_based"),
  model: z.string().optional(),
  input_cost_per_1k_tokens: z.number().min(0),
  output_cost_per_1k_tokens: z.number().min(0),
});

export const unitBasedPricingSchema = z.object({
  cost_calculation: z.literal("unit_based"),
  cost_per_unit: z.number().min(0),
});

export const fixedCostPricingSchema = z.object({
  cost_calculation: z.literal("fixed_cost"),
  fixed_cost: z.number().min(0),
});

export const pricingJsonSchema = z.union([
  tokenBasedPricingSchema,
  unitBasedPricingSchema,
  fixedCostPricingSchema,
]);

export const insertApiProviderSchemaWithValidation = insertApiProviderSchema.extend({
  currencyCode: z.literal("USD"), // Enforce USD-only for now
  pricingJson: pricingJsonSchema,
});

// =============================================================================
// TYPES
// =============================================================================

// User types
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type AdminUser = typeof adminUsers.$inferSelect;
export type UpsertAdminUser = typeof adminUsers.$inferInsert;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type InsertPasswordResetToken = typeof passwordResetTokens.$inferInsert;
export type MfaRecoveryToken = typeof mfaRecoveryTokens.$inferSelect;
export type InsertMfaRecoveryToken = typeof mfaRecoveryTokens.$inferInsert;

// Institute types
export type Institute = typeof institutes.$inferSelect;
export type InsertInstitute = typeof institutes.$inferInsert;
export type UpdateInstitute = Partial<InsertInstitute>;
export type InstituteUser = typeof instituteUsers.$inferSelect;
export type InsertInstituteUser = typeof instituteUsers.$inferInsert;
export type UpdateInstituteUser = Partial<InsertInstituteUser>;
export type InstituteInvite = typeof instituteInvites.$inferSelect;
export type InsertInstituteInvite = typeof instituteInvites.$inferInsert;
export type UpdateInstituteInvite = Partial<InsertInstituteInvite>;
export type InstituteStudent = typeof instituteStudents.$inferSelect;
export type InsertInstituteStudent = z.infer<typeof insertInstituteStudentSchema>;
export type UpdateInstituteStudent = z.infer<typeof updateInstituteStudentSchema>;

// Classroom types
export type Classroom = typeof classrooms.$inferSelect;
export type InsertClassroom = z.infer<typeof insertClassroomSchema>;
export type UpdateClassroom = z.infer<typeof updateClassroomSchema>;
export type ClassroomUser = typeof classroomUsers.$inferSelect;
export type InsertClassroomUser = z.infer<typeof insertClassroomUserSchema>;
export type UpdateClassroomUser = z.infer<typeof updateClassroomUserSchema>;
export type StudentClassroom = typeof studentClassrooms.$inferSelect;
export type InsertStudentClassroom = z.infer<typeof insertStudentClassroomSchema>;
export type UpdateStudentClassroom = z.infer<typeof updateStudentClassroomSchema>;

// License types
export type License = typeof licenses.$inferSelect;
export type InsertLicense = z.infer<typeof insertLicenseSchema>;
export type UpdateLicense = z.infer<typeof updateLicenseSchema>;

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

// Custom symbol types
export type CustomSymbol = typeof customSymbols.$inferSelect;
export type InsertCustomSymbol = z.infer<typeof insertCustomSymbolSchema>;
export type UpdateCustomSymbol = z.infer<typeof updateCustomSymbolSchema>;
export type UserSymbolAssociation = typeof userSymbolAssociations.$inferSelect;
export type InsertUserSymbolAssociation = z.infer<typeof insertUserSymbolAssociationSchema>;
export type UpdateUserSymbolAssociation = z.infer<typeof updateUserSymbolAssociationSchema>;
export type StudentSymbolAssociation = typeof studentSymbolAssociations.$inferSelect;
export type InsertStudentSymbolAssociation = z.infer<typeof insertStudentSymbolAssociationSchema>;
export type UpdateStudentSymbolAssociation = z.infer<typeof updateStudentSymbolAssociationSchema>;
export type InstituteSymbolAssociation = typeof instituteSymbolAssociations.$inferSelect;
export type InsertInstituteSymbolAssociation = z.infer<typeof insertInstituteSymbolAssociationSchema>;
export type UpdateInstituteSymbolAssociation = z.infer<typeof updateInstituteSymbolAssociationSchema>;

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

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;

export type SensitivityCategory = typeof sensitivityCategoryEnum.enumValues[number];
export type ReportStatus = typeof reportStatusEnum.enumValues[number];
export type AuditAction = typeof auditActionEnum.enumValues[number];

// Credit & billing types
export type CreditTransaction = typeof creditTransactions.$inferSelect;
export type InsertCreditTransaction = z.infer<typeof insertCreditTransactionSchema>;
export type CreditPackage = typeof creditPackages.$inferSelect;
export type InsertCreditPackage = z.infer<typeof insertCreditPackageSchema>;
export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;
export type InsertSubscriptionPlan = z.infer<typeof insertSubscriptionPlanSchema>;
export type RevenuecatSubscription = typeof revenuecatSubscriptions.$inferSelect;
export type InsertRevenuecatSubscription = z.infer<typeof insertRevenuecatSubscriptionSchema>;
export type RevenuecatWebhookEvent = typeof revenuecatWebhookEvents.$inferSelect;
export type InsertRevenuecatWebhookEvent = z.infer<typeof insertRevenuecatWebhookEventSchema>;
export type RevenuecatProduct = typeof revenuecatProducts.$inferSelect;
export type InsertRevenuecatProduct = z.infer<typeof insertRevenuecatProductSchema>;

// Content types
export type Interpretation = typeof interpretations.$inferSelect;
export type InsertInterpretation = z.infer<typeof insertInterpretationSchema>;
export type InterpretRequest = z.infer<typeof interpretRequestSchema>;
export type InviteCode = typeof inviteCodes.$inferSelect;
export type InsertInviteCode = z.infer<typeof insertInviteCodeSchema>;
export type InviteCodeRedemption = typeof inviteCodeRedemptions.$inferSelect;
export type RedeemInviteCode = z.infer<typeof redeemInviteCodeSchema>;
export type SavedLocation = typeof savedLocations.$inferSelect;
export type InsertSavedLocation = z.infer<typeof insertSavedLocationSchema>;

// Board types
export type Board = typeof boards.$inferSelect;
export type InsertBoard = z.infer<typeof insertBoardSchema>;

// API types
export type ApiProvider = typeof apiProviders.$inferSelect;
export type InsertApiProvider = z.infer<typeof insertApiProviderSchema>;
export type ApiCall = typeof apiCalls.$inferSelect;
export type InsertApiCall = z.infer<typeof insertApiCallSchema>;
export type ApiProviderPricing = typeof apiProviderPricing.$inferSelect;
export type InsertApiProviderPricing = z.infer<typeof insertApiProviderPricingSchema>;

// Integration types
export type DropboxConnection = typeof dropboxConnections.$inferSelect;
export type InsertDropboxConnection = z.infer<typeof insertDropboxConnectionSchema>;
export type DropboxBackup = typeof dropboxBackups.$inferSelect;
export type InsertDropboxBackup = z.infer<typeof insertDropboxBackupSchema>;

// Chat types
export type ChatSession = typeof chatSessions.$inferSelect;
export type InsertChatSession = z.infer<typeof insertChatSessionSchema>;
export type FeatureType = "chat" | "boards" | "interpret" | 'docuslp' | 'overview' | 'students' | 'institute' | 'progress' | 'reports' | 'settings' | 'aacsettings' | 'aac' | 'symbols';

// AAC Session types
export type AACSession = typeof aacSessions.$inferSelect;
export type InsertAACSession = typeof aacSessions.$inferInsert;
export type UpdateAACSession = Partial<typeof aacSessions.$inferInsert>;
export type ChatPersona = 'assistant' | 'coach' | 'clinical' | 'teacher' | 'pediatric_physical_therapist' | 'speech_language_pathologist' | 'occupational_therapist' | 'behavioral_specialist';

// Persona types
export type Persona = typeof personas.$inferSelect;
export type InsertPersona = z.infer<typeof insertPersonaSchema>;
export type UpdatePersona = z.infer<typeof updatePersonaSchema>;

// Voice types
export type Voice = typeof voices.$inferSelect;
export type InsertVoice = z.infer<typeof insertVoiceSchema>;
export type UpdateVoice = z.infer<typeof updateVoiceSchema>;

// Library Topic types (renamed to avoid conflict with agent memory Topic interface)
export type LibraryTopic = typeof topics.$inferSelect;
export type InsertLibraryTopic = z.infer<typeof insertTopicSchema>;
export type UpdateLibraryTopic = z.infer<typeof updateTopicSchema>;

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
export type InstituteType = 'school' | 'hospital';

// User type constants
export const USER_TYPES = {
  ADMIN: "admin",
  TEACHER: "Teacher", 
  CAREGIVER: "Caregiver",
  SPEECH_THERAPIST: "SLP",
  PARENT: "Parent"
} as const;

export type UserType = typeof USER_TYPES[keyof typeof USER_TYPES];

// =============================================================================
// COMPOSITE INTERFACE TYPES
// =============================================================================

/**
 * Program with all related entities loaded
 */
export interface ProgramWithDetails {
  program: Program;
  student: Student;
  profileDomains: (ProfileDomain & {
    baselineMeasurements: BaselineMeasurement[];
    assessmentSources: AssessmentSource[];
  })[];
  goals: (Goal & {
    objectives: Objective[];
    dataPoints: DataPoint[];
  })[];
  services: (Service & {
    accommodations: Accommodation[];
    linkedGoalIds: string[];
  })[];
  progressReports: (ProgressReport & {
    entries: GoalProgressEntry[];
  })[];
  transitionPlan?: TransitionPlan & {
    goals: TransitionGoal[];
  };
  teamMembers: TeamMember[];
  meetings: Meeting[];
  consentForms: ConsentForm[];
}

/**
 * Student with summary progress info for list views
 */
export interface StudentWithProgramSummary {
  student: Student;
  currentProgram?: {
    id: string;
    status: ProgramStatus;
    dueDate?: string;
    goalsCount: number;
    goalsCompleted: number;
    overallProgress: number;
  };
  role: string; // From userStudents junction
}

/**
 * Dashboard overview stats
 */
export interface OverviewStats {
  totalStudents: number;
  activeCases: number;
  completedCases: number;
  pendingReview: number;
  upcomingDeadlines: number;
}

/**
 * Goal with full context for display
 */
export interface GoalWithContext {
  goal: Goal;
  domainName: string;
  objectives: Objective[];
  latestProgress?: GoalProgressEntry;
  dataPoints: DataPoint[];
}

// =============================================================================
// CHAT SYSTEM INTERFACES
// =============================================================================

export interface ChatMessageContent {
  text?: string;
  html?: string;
  md?: string;
  setValues?: { [key: string]: any }[];
  formSchema?: any;
  formValues?: any;
  attachments?: any[];
}

export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  timestamp: number;
  content?: string | ChatMessageContent;
  toolCalls?: any[];
  toolCallId?: string;
  credits?: number;
  userId?: string;
  turnId?: string;
  metadata?: { [key: string]: any };
  error?: string;
}

/**
 * Board grid dimensions
 */
export interface BoardGrid {
  rows: number;
  cols: number;
}

/**
 * Board button action type
 */
export interface BoardButtonAction {
  type: "speak" | "link" | "back" | "home";
  text?: string;
  toPageId?: string;
}

/**
 * Single button on an AAC communication board
 */
export interface BoardButton {
  id: string;
  row: number;
  col: number;
  label: string;
  spokenText?: string;
  color?: string;
  iconRef?: string;
  symbolPath?: string;
  selfClosing?: boolean;
  action?: BoardButtonAction;
}

/**
 * A page within an AAC communication board
 */
export interface BoardPage {
  id: string;
  name: string;
  buttons: BoardButton[];
  layout?: BoardGrid;
}

/**
 * Complete AAC communication board data structure
 */
export interface ParsedBoardData {
  name: string;
  grid: BoardGrid;
  pages: BoardPage[];
  currentPageId?: string;
}

/**
 * Mode context that can be passed to the session service
 */
export interface FeatureContext {
  /** Board context for "boards" mode */
  board?: {
    data: ParsedBoardData;
    currentPageId?: string;
    requestedGridSize?: BoardGrid;
  };
  
  /** Document context for future document editing modes */
  document?: {
    data: any;
    documentId?: string;
  };
}
  
export interface MessageResponse {
  memoryValues?: any;
  chatState?: ChatState;
  creditsUsed?: number;
  message: ChatMessage;
  sessionId?: string;
  
  /** 
   * Context data extracted from memory values (boards, documents, etc.)
   * This contains mode-specific data that the frontend should process
   */
  contextData?: {
    /** Board data if in boards mode - contains the full ParsedBoardData */
    board?: ParsedBoardData;
    /** Document data if in document editing mode */
    document?: any;
    /** Additional context types can be added here */
    [key: string]: any;
  };
}

// Memory system types
export type MemoryPrimitiveType = 'string' | 'number' | 'integer' | 'boolean' | 'null';
export type MemoryCompositeType  = 'object' | 'array' | 'map' | 'topic';
export type MemoryType           = MemoryPrimitiveType | MemoryCompositeType;

export interface AgentMemoryFieldBase {
  id: string;
  type: MemoryType;
  title?: string;
  description?: string;
  default?: any;
  enum?: any[];
  const?: any;
  examples?: any[];
  opened?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
}

export interface AgentMemoryFieldObject extends AgentMemoryFieldBase {
  type: 'object';
  properties: Record<string, AgentMemoryField>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface AgentMemoryFieldArray extends AgentMemoryFieldBase {
  type: 'array';
  items: AgentMemoryField;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface AgentMemoryFieldMap extends AgentMemoryFieldBase {
  type: 'map';
  values: AgentMemoryField;
  keyPattern?: string;
  minProperties?: number;
  maxProperties?: number;
}

export interface AgentMemoryFieldTopic extends AgentMemoryFieldBase {
  type: 'topic';
  maxDepth?: number;
  maxBreadthPerNode?: number;
}

export type AgentMemoryField =
  | AgentMemoryFieldObject
  | AgentMemoryFieldArray
  | AgentMemoryFieldMap
  | AgentMemoryFieldTopic
  | (AgentMemoryFieldBase & { type: MemoryPrimitiveType });

export interface TopicNode {
  description?: string;
  subtopics: Record<string, TopicNode>;
}

export type TopicTree = Record<string, TopicNode>;

export interface MemoryState {
  visible: string[];
  page: Record<string, { offset: number; limit: number }>;
}

export interface ChatState {
  history: ChatMessage[];
  conversationSummary: string;
  openedTopics: string[];
  memoryState: MemoryState;

  /**
   * Cached load state for DB-backed memory fields.
   * Persists across messages to avoid redundant database queries.
   * Use serializeLoadState/deserializeLoadState from memory-db-bridge.ts.
   */
  loadStateCache?: {
    loaded: string[];
    stale: string[];
    loadedAt: Record<string, number>;
    totals: Record<string, number>;
    /** Cached values for loaded fields - avoids redundant DB queries */
    cachedValues?: Record<string, any>;
  };
}

export interface Topic {
  name: string;
  open: boolean;
  info?: string;
  subtopics?: Topic[];
}

export interface DelegatePolicy {
  agentId: string;
  enabled: boolean;
  creditsTotal: number;
  creditsRegen: number;
  defaultChildBudget?: number;
  maxConcurrentChildren?: number;
  spawnCost?: number;
  notes?: string;
}

export interface AgentAPIEndpoint {
  name: string;
  url: string;
  method?: "GET" | "POST";
  description: string;
  useRpc?: boolean;
  properties: any[];
  required: string[];
  protocol?: "http" | "jsonrpc" | "mcp-ws";
  mcpToolName?: string;
}

export interface ToolsParams {
  webSearch?: { enabled?: boolean; contextSize?: number };
  voiceChat?: { enabled?: boolean; voice?: string };
  email?: { enabled?: boolean; address?: string; service?: string; username?: string; password?: string };
  mapTools?: { enabled?: boolean };
  rooms?: { enabled?: boolean };
  spawn?: { enabled?: boolean };
}

export interface DisplayParams {
  avatar?: string;
  container?: string;
  placeholder?: string;
  primaryColor?: string;
  secondaryColor?: string;
  backgroundColor?: string;
  primaryTextColor?: string;
  secondaryTextColor?: string;
  headerText?: string;
  headerLoadingText?: string;
  headerErrorText?: string;
  sendButtonText?: string;
}

// =============================================================================
// RELATIONS
// =============================================================================

// User relations
export const usersRelations = relations(users, ({ many, one }) => ({
  boards: many(boards),
  dropboxConnection: one(dropboxConnections),
  dropboxBackups: many(dropboxBackups),
  apiCalls: many(apiCalls),
  studentLinks: many(userStudents),
  instituteLinks: many(instituteUsers),
  licenses: many(licenses),
  classroomLinks: many(classroomUsers),
  goalLinks: many(userGoals),
  objectiveLinks: many(userObjectives),
}));

// Institute relations
export const institutesRelations = relations(institutes, ({ many }) => ({
  userLinks: many(instituteUsers),
  studentLinks: many(instituteStudents),
  instituteLinks: many(instituteStudents),
  licenses: many(licenses),
  invites: many(instituteInvites),
  classrooms: many(classrooms),
}));

export const instituteUsersRelations = relations(instituteUsers, ({ one }) => ({
  institute: one(institutes, {
    fields: [instituteUsers.instituteId],
    references: [institutes.id]
  }),
  user: one(users, {
    fields: [instituteUsers.userId],
    references: [users.id]
  }),
}));

export const instituteStudentsRelations = relations(instituteStudents, ({ one }) => ({
  institute: one(institutes, {
    fields: [instituteStudents.instituteId],
    references: [institutes.id]
  }),
  student: one(students, {
    fields: [instituteStudents.studentId],
    references: [students.id]
  }),
}));

export const instituteInvitesRelations = relations(instituteInvites, ({ one }) => ({
  institute: one(institutes, {
    fields: [instituteInvites.instituteId],
    references: [institutes.id]
  }),
  invitee: one(users, {
    fields: [instituteInvites.inviteeUserId],
    references: [users.id]
  }),
  invitedBy: one(users, {
    fields: [instituteInvites.invitedByUserId],
    references: [users.id]
  }),
}));

export const classroomsRelations = relations(classrooms, ({ one, many }) => ({
  institute: one(institutes, {
    fields: [classrooms.instituteId],
    references: [institutes.id],
  }),
  userLinks: many(classroomUsers),
  studentLinks: many(studentClassrooms),
}));

export const classroomUsersRelations = relations(classroomUsers, ({ one }) => ({
  classroom: one(classrooms, {
    fields: [classroomUsers.classroomId],
    references: [classrooms.id],
  }),
  user: one(users, {
    fields: [classroomUsers.userId],
    references: [users.id],
  }),
}));

export const studentClassroomsRelations = relations(studentClassrooms, ({ one }) => ({
  student: one(students, {
    fields: [studentClassrooms.studentId],
    references: [students.id],
  }),
  classroom: one(classrooms, {
    fields: [studentClassrooms.classroomId],
    references: [classrooms.id],
  }),
}));

export const userGoalsRelations = relations(userGoals, ({ one }) => ({
  user: one(users, {
    fields: [userGoals.userId],
    references: [users.id]
  }),
  goal: one(goals, {
    fields: [userGoals.goalId],
    references: [goals.id]
  }),
}));

export const userObjectivesRelations = relations(userObjectives, ({ one }) => ({
  user: one(users, {
    fields: [userObjectives.userId],
    references: [users.id]
  }),
  objective: one(objectives, {
    fields: [userObjectives.objectiveId],
    references: [objectives.id]
  }),
}));

// License relations
export const licensesRelations = relations(licenses, ({ one }) => ({
  institute: one(institutes, {
    fields: [licenses.instituteId],
    references: [institutes.id]
  }),
  user: one(users, {
    fields: [licenses.userId],
    references: [users.id]
  }),
}));

// Student relations
export const studentsRelations = relations(students, ({ many }) => ({
  userLinks: many(userStudents),
  instituteLinks: many(instituteStudents),
  classroomLinks: many(studentClassrooms),
  programs: many(programs),
  interpretations: many(interpretations),
  inviteCodes: many(inviteCodes),
  aacSessions: many(aacSessions),
}));

export const userStudentsRelations = relations(userStudents, ({ one }) => ({
  user: one(users, {
    fields: [userStudents.userId],
    references: [users.id]
  }),
  student: one(students, {
    fields: [userStudents.studentId],
    references: [students.id]
  }),
}));

// Program relations
export const programsRelations = relations(programs, ({ one, many }) => ({
  student: one(students, {
    fields: [programs.studentId],
    references: [students.id]
  }),
  profileDomains: many(profileDomains),
  goals: many(goals),
  services: many(services),
  accommodations: many(accommodations),
  progressReports: many(progressReports),
  transitionPlan: one(transitionPlans),
  teamMembers: many(teamMembers),
  meetings: many(meetings),
  consentForms: many(consentForms),
}));

export const profileDomainsRelations = relations(profileDomains, ({ one, many }) => ({
  program: one(programs, {
    fields: [profileDomains.programId],
    references: [programs.id]
  }),
  baselineMeasurements: many(baselineMeasurements),
  assessmentSources: many(assessmentSources),
  goals: many(goals),
}));

export const baselineMeasurementsRelations = relations(baselineMeasurements, ({ one }) => ({
  profileDomain: one(profileDomains, {
    fields: [baselineMeasurements.profileDomainId],
    references: [profileDomains.id]
  }),
}));

export const assessmentSourcesRelations = relations(assessmentSources, ({ one }) => ({
  profileDomain: one(profileDomains, {
    fields: [assessmentSources.profileDomainId],
    references: [profileDomains.id]
  }),
}));

export const goalsRelations = relations(goals, ({ one, many }) => ({
  program: one(programs, {
    fields: [goals.programId],
    references: [programs.id]
  }),
  objectives: many(objectives),
  dataPoints: many(dataPoints),
  progressEntries: many(goalProgressEntries),
  serviceLinks: many(serviceGoals),
  userLinks: many(userGoals),
}));

export const objectivesRelations = relations(objectives, ({ one, many }) => ({
  goal: one(goals, {
    fields: [objectives.goalId],
    references: [goals.id]
  }),
  profileDomain: one(profileDomains, {
    fields: [objectives.profileDomainId],
    references: [profileDomains.id]
  }),
  dataPoints: many(dataPoints),
  userLinks: many(userObjectives), // ADD THIS LINE
}));

export const servicesRelations = relations(services, ({ one, many }) => ({
  program: one(programs, {
    fields: [services.programId],
    references: [programs.id]
  }),
  provider: one(teamMembers, {
    fields: [services.providerId],
    references: [teamMembers.id]
  }),
  accommodations: many(accommodations),
  goalLinks: many(serviceGoals),
}));

export const serviceGoalsRelations = relations(serviceGoals, ({ one }) => ({
  service: one(services, {
    fields: [serviceGoals.serviceId],
    references: [services.id]
  }),
  goal: one(goals, {
    fields: [serviceGoals.goalId],
    references: [goals.id]
  }),
}));

export const accommodationsRelations = relations(accommodations, ({ one }) => ({
  service: one(services, {
    fields: [accommodations.serviceId],
    references: [services.id]
  }),
  program: one(programs, {
    fields: [accommodations.programId],
    references: [programs.id]
  }),
}));

export const progressReportsRelations = relations(progressReports, ({ one, many }) => ({
  program: one(programs, {
    fields: [progressReports.programId],
    references: [programs.id]
  }),
  entries: many(goalProgressEntries),
}));

export const goalProgressEntriesRelations = relations(goalProgressEntries, ({ one, many }) => ({
  progressReport: one(progressReports, {
    fields: [goalProgressEntries.progressReportId],
    references: [progressReports.id]
  }),
  goal: one(goals, {
    fields: [goalProgressEntries.goalId],
    references: [goals.id]
  }),
  dataPoints: many(dataPoints),
}));

export const dataPointsRelations = relations(dataPoints, ({ one }) => ({
  goalProgressEntry: one(goalProgressEntries, {
    fields: [dataPoints.goalProgressEntryId],
    references: [goalProgressEntries.id]
  }),
  goal: one(goals, {
    fields: [dataPoints.goalId],
    references: [goals.id]
  }),
  objective: one(objectives, {
    fields: [dataPoints.objectiveId],
    references: [objectives.id]
  }),
}));

export const transitionPlansRelations = relations(transitionPlans, ({ one, many }) => ({
  program: one(programs, {
    fields: [transitionPlans.programId],
    references: [programs.id]
  }),
  goals: many(transitionGoals),
}));

export const transitionGoalsRelations = relations(transitionGoals, ({ one }) => ({
  transitionPlan: one(transitionPlans, {
    fields: [transitionGoals.transitionPlanId],
    references: [transitionPlans.id]
  }),
}));

export const teamMembersRelations = relations(teamMembers, ({ one, many }) => ({
  program: one(programs, {
    fields: [teamMembers.programId],
    references: [programs.id]
  }),
  user: one(users, {
    fields: [teamMembers.userId],
    references: [users.id]
  }),
  providedServices: many(services),
}));

export const meetingsRelations = relations(meetings, ({ one }) => ({
  program: one(programs, {
    fields: [meetings.programId],
    references: [programs.id]
  }),
}));

export const consentFormsRelations = relations(consentForms, ({ one }) => ({
  program: one(programs, {
    fields: [consentForms.programId],
    references: [programs.id]
  }),
}));

// Content relations
export const interpretationsRelations = relations(interpretations, ({ one }) => ({
  user: one(users, {
    fields: [interpretations.userId],
    references: [users.id]
  }),
  student: one(students, {
    fields: [interpretations.studentId],
    references: [students.id]
  }),
}));

export const inviteCodesRelations = relations(inviteCodes, ({ one, many }) => ({
  createdBy: one(users, {
    fields: [inviteCodes.createdByUserId],
    references: [users.id]
  }),
  student: one(students, {
    fields: [inviteCodes.studentId],
    references: [students.id]
  }),
  redemptions: many(inviteCodeRedemptions),
}));

export const inviteCodeRedemptionsRelations = relations(inviteCodeRedemptions, ({ one }) => ({
  inviteCode: one(inviteCodes, {
    fields: [inviteCodeRedemptions.inviteCodeId],
    references: [inviteCodes.id]
  }),
  redeemedBy: one(users, {
    fields: [inviteCodeRedemptions.redeemedByUserId],
    references: [users.id]
  }),
  student: one(students, {
    fields: [inviteCodeRedemptions.studentId],
    references: [students.id]
  }),
}));

// Board relations
export const boardsRelations = relations(boards, ({ one }) => ({
  user: one(users, {
    fields: [boards.userId],
    references: [users.id]
  }),
  students: one(students, {
    fields: [boards.studentId],
    references: [students.id]
  })
}));

// Integration relations
export const dropboxConnectionsRelations = relations(dropboxConnections, ({ one, many }) => ({
  user: one(users, {
    fields: [dropboxConnections.userId],
    references: [users.id]
  }),
  backups: many(dropboxBackups)
}));

export const dropboxBackupsRelations = relations(dropboxBackups, ({ one }) => ({
  user: one(users, {
    fields: [dropboxBackups.userId],
    references: [users.id]
  }),
  connection: one(dropboxConnections, {
    fields: [dropboxBackups.userId],
    references: [dropboxConnections.userId]
  })
}));

// Chat relations
export const chatSessionsRelations = relations(chatSessions, ({ one }) => ({
  user: one(users, {
    fields: [chatSessions.userId],
    references: [users.id]
  }),
  student: one(students, {
    fields: [chatSessions.studentId],
    references: [students.id]
  }),
  userStudent: one(userStudents, {
    fields: [chatSessions.userStudentId],
    references: [userStudents.id]
  }),
}));

export const aacSessionsRelations = relations(aacSessions, ({ one }) => ({
  student: one(students, {
    fields: [aacSessions.studentId],
    references: [students.id]
  }),
  user: one(users, {
    fields: [aacSessions.userId],
    references: [users.id]
  }),
}));