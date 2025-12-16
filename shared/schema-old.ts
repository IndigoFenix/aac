import { pgTable, text, serial, integer, boolean, timestamp, real, varchar, jsonb, index, numeric, AnyPgColumn, pgEnum, date } from "drizzle-orm/pg-core";
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

export const instituteTypeEnum = pgEnum("institute_type", ["school", "hospital"]);

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
});

// Password reset tokens table
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  isUsed: boolean("is_used").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

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

// Student profiles table
export const students = pgTable("students", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(), // Human-readable name (was "alias")
  gender: text("gender"), // 'male', 'female', 'other'
  birthDate: date("birth_date"), // Date of birth (was "age" as integer)
  diagnosis: text("diagnosis"), // Primary diagnosis
  backgroundContext: text("background_context"), // Free text background information
  systemType: text("system_type").default("tala"), // 'tala' | 'us_iep'
  country: text("country").default("IL"), // 'IL', 'US', etc.
  school: text("school"), // School name
  grade: text("grade"), // Grade level
  idNumber: text("id_number"), // Student ID number
  
  // Chat system fields
  chatMemory: jsonb("chat_memory").default({}), // Student-specific memory values for chat
  chatCreditsUsed: real("chat_credits_used").notNull().default(0),
  chatCreditsUpdated: timestamp("chat_credits_updated").defaultNow(),

  // Progress tracking fields
  nextDeadline: date("next_deadline"), // Next deadline date
  overallProgress: integer("overall_progress").default(0), // 0-100
  currentPhase: text("current_phase"), // Current phase ID (e.g., 'p1', 'p2')
  progressData: jsonb("progress_data").default({}), // Additional progress metadata
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

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
  data: jsonb("data").default({}), // Private data for this relationship
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_institute_students_institute_id").on(table.instituteId),
  index("idx_institute_students_student_id").on(table.studentId),
]);

// Student Schedules table for contextual schedule management
export const studentSchedules = pgTable("student_schedules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").references(() => students.id).notNull(), // FK to Student's primary key
  dayOfWeek: integer("day_of_week").notNull(), // 0=Sunday to 6=Saturday
  startTime: text("start_time").notNull(), // Time format 'HH:MM'
  endTime: text("end_time").notNull(), // Time format 'HH:MM'
  activityName: text("activity_name").notNull(), // e.g., 'School', 'Hydrotherapy', 'Dinner'
  topicTags: text("topic_tags").array(), // e.g., ['food', 'family', 'social'] - CRITICAL for AI prompt
  isRepeatingWeekly: boolean("is_repeating_weekly").default(true).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  dateOverride: text("date_override"), // For holidays/one-off events, format 'YYYY-MM-DD'
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Student Phases table - Tracks individual phase progress
export const studentPhases = pgTable("student_phases", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").notNull(), // References students.id
  phaseId: text("phase_id").notNull(), // 'p1', 'p2', 'p3', 'p4' or custom
  phaseName: text("phase_name").notNull(), // Display name
  phaseOrder: integer("phase_order").notNull().default(1), // Order in sequence
  status: text("status").notNull().default("pending"), // 'pending', 'in-progress', 'completed', 'locked'
  dueDate: date("due_date"),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
  metadata: jsonb("metadata").default({}), // Additional phase data
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_student_phases_student_id").on(table.studentId),
  index("idx_student_phases_status").on(table.status),
]);

// Student Goals table - Tracks IEP goals and objectives
export const studentGoals = pgTable("student_goals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").notNull(), // References students.id
  phaseId: varchar("phase_id"), // References studentPhases.id (optional)
  title: text("title").notNull(),
  description: text("description"),
  goalType: text("goal_type").notNull().default("general"), // 'communication', 'behavioral', 'academic', 'general'
  
  // SMART Goal fields (for US IEP)
  targetBehavior: text("target_behavior"), // Specific
  criteria: text("criteria"), // Measurable
  criteriaPercentage: integer("criteria_percentage"), // e.g., 80%
  measurementMethod: text("measurement_method"), // e.g., 'SLP data collection'
  conditions: text("conditions"), // Achievable/Opportunity context
  relevance: text("relevance"), // Relevant curriculum impact
  targetDate: date("target_date"), // Time-bound
  
  status: text("status").notNull().default("draft"), // 'draft', 'active', 'achieved', 'modified', 'discontinued'
  progress: integer("progress").default(0), // 0-100
  
  // Baseline data for IEP
  baselineData: jsonb("baseline_data").default({}), // MLU, communication rate, etc.
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_student_goals_student_id").on(table.studentId),
  index("idx_student_goals_status").on(table.status),
]);

// Student Progress Entries - Tracks progress over time
export const studentProgressEntries = pgTable("student_progress_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").notNull(),
  goalId: varchar("goal_id"), // References studentGoals.id (optional)
  phaseId: varchar("phase_id"), // References studentPhases.id (optional)
  
  entryType: text("entry_type").notNull(), // 'observation', 'assessment', 'milestone', 'note'
  title: text("title").notNull(),
  content: text("content"),
  
  // Quantitative metrics
  metrics: jsonb("metrics").default({}), // e.g., { mlu: 3.2, communicationRate: 12, intelligibility: 0.75 }
  
  recordedBy: varchar("recorded_by"), // References users.id
  recordedAt: timestamp("recorded_at").defaultNow().notNull(),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_progress_entries_student_id").on(table.studentId),
  index("idx_progress_entries_recorded_at").on(table.recordedAt),
]);

// Student Compliance Checklist - For IEP compliance tracking
export const studentComplianceItems = pgTable("student_compliance_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").notNull(),
  phaseId: varchar("phase_id"), // References studentPhases.id (optional)
  
  itemKey: text("item_key").notNull(), // 'baseline_data', 'parent_input', 'gen_ed_consulted', etc.
  itemLabel: text("item_label").notNull(),
  isCompleted: boolean("is_completed").default(false).notNull(),
  completedAt: timestamp("completed_at"),
  completedBy: varchar("completed_by"), // References users.id
  notes: text("notes"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_compliance_items_student_id").on(table.studentId),
]);

// Service Recommendations - For IEP service planning
export const studentServiceRecommendations = pgTable("student_service_recommendations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").notNull(),
  
  serviceName: text("service_name").notNull(), // 'Speech-Language', 'Occupational Therapy', etc.
  serviceType: text("service_type").notNull().default("direct"), // 'direct', 'consultation', 'monitoring'
  durationMinutes: integer("duration_minutes").notNull(),
  frequency: text("frequency").notNull(), // 'weekly', 'bi-weekly', 'monthly'
  frequencyCount: integer("frequency_count").notNull().default(1), // Times per frequency period
  
  startDate: date("start_date"),
  endDate: date("end_date"),
  
  provider: text("provider"), // Provider name
  location: text("location"), // Service delivery location
  
  isActive: boolean("is_active").default(true).notNull(),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_service_recs_student_id").on(table.studentId),
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
// CONTENT & INTERPRETATION TABLES
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

// Invite Code Redemptions table
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
// BOARDS & GENERATION TABLES
// =============================================================================

export const boards = pgTable("boards", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  irData: jsonb("ir_data"), // Intermediate representation data for regenerations
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  loadedAt: timestamp("loaded_at").defaultNow().notNull(),
});

export const promptEvents = pgTable("prompt_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  promptId: varchar("prompt_id").notNull(),
  userId: varchar("user_id").notNull(),
  eventType: text("event_type").notNull(), // prompt_created, board_generated, board_page_created, board_downloaded, error_occurred, user_feedback_submitted
  eventData: jsonb("event_data"), // Additional event-specific data
  createdAt: timestamp("created_at").defaultNow()
});

// =============================================================================
// API & PRICING TABLES
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
// ANALYTICS & TRACKING TABLES
// =============================================================================

// Usage Windows table
export const usageWindows = pgTable("usage_windows", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  windowStart: timestamp("window_start").notNull(),
  windowEnd: timestamp("window_end").notNull(),
  requestCount: integer("request_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Analytics Aggregates table
export const analyticsAggregates = pgTable("analytics_aggregates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  aggregateDate: varchar("aggregate_date").notNull(), // YYYY-MM-DD format
  aggregateType: text("aggregate_type").notNull(), // daily, weekly, monthly
  totalPrompts: integer("total_prompts").default(0),
  totalBoards: integer("total_boards").default(0),
  totalPages: integer("total_pages").default(0),
  totalDownloads: integer("total_downloads").default(0),
  uniqueUsers: integer("unique_users").default(0),
  successRate: integer("success_rate").default(0), // percentage * 100
  avgProcessingTime: integer("avg_processing_time").default(0),
  avgPagesPerBoard: integer("avg_pages_per_board").default(0), // * 100 for precision
  topicBreakdown: jsonb("topic_breakdown"), // {topic: count} pairs
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow()
});

// User Sessions for tracking DAU/WAU/MAU and session analytics
export const userSessions = pgTable("user_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  sessionStart: timestamp("session_start").notNull(),
  sessionEnd: timestamp("session_end"),
  durationMs: integer("duration_ms"), // Session duration in milliseconds
  platform: text("platform").default("web"), // web, ios, android, other
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
  country: text("country"),
  region: text("region"),
  acquisitionSource: text("acquisition_source"), // organic, campaign, referral
  campaignId: text("campaign_id"),
  createdAt: timestamp("created_at").defaultNow()
});

// User Events for detailed activity tracking
export const userEvents = pgTable("user_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  sessionId: varchar("session_id"),
  eventType: text("event_type").notNull(), // login, logout, board_generated, board_downloaded, plan_upgrade, plan_downgrade, feature_used
  eventCategory: text("event_category").notNull(), // auth, generation, download, subscription, feature
  eventData: jsonb("event_data"), // Additional event-specific data
  featureTags: jsonb("feature_tags").default("[]"), // Array of feature usage tags
  createdAt: timestamp("created_at").defaultNow()
});

// Plan Changes for tracking conversions and churns
export const planChanges = pgTable("plan_changes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  fromPlan: text("from_plan"),
  toPlan: text("to_plan").notNull(),
  changeType: text("change_type").notNull(), // signup, upgrade, downgrade, churn
  changeReason: text("change_reason"), // user_initiated, admin_action, automatic
  createdAt: timestamp("created_at").defaultNow()
});

// User Retention Cohorts
export const userCohorts = pgTable("user_cohorts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  cohortPeriod: varchar("cohort_period").notNull(), // YYYY-MM-DD or YYYY-WW format
  cohortType: text("cohort_type").notNull(), // weekly, monthly
  totalUsers: integer("total_users").notNull(),
  retentionData: jsonb("retention_data").notNull(), // {period: count} pairs
  createdAt: timestamp("created_at").defaultNow()
});

// =============================================================================
// SYSTEM CONFIGURATION TABLES
// =============================================================================

// System Prompt for AI Behavior Configuration
export const systemPrompt = pgTable("system_prompt", {
  id: varchar("id").primaryKey().default("system_prompt"), // Single row with fixed ID
  prompt: text("prompt").notNull().default(""),
  updatedAt: timestamp("updated_at").defaultNow(),
  updatedBy: varchar("updated_by").references(() => users.id)
});

// Plans table
export const plans = pgTable("plans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  credits: integer("credits").notNull(),
  price: real("price").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
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
// CHAT SYSTEM TABLES
// =============================================================================

// Chat Sessions table (named chatSessions to avoid conflict with admin sessions)
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
}, (table) => [
  index("idx_chat_sessions_user_id").on(table.userId),
  index("idx_chat_sessions_student_id").on(table.studentId),
  index("idx_chat_sessions_status").on(table.status),
]);

// =============================================================================
// INSERT SCHEMAS
// =============================================================================

// User schemas
export const insertUserSchema = createInsertSchema(users).pick({
  email: true,
  firstName: true,
  lastName: true,
  password: true,
  userType: true,
  createdAt: true,
  updatedAt: true
});

export const insertAdminUserSchema = createInsertSchema(adminUsers);

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

// Plan schemas
export const insertPlanSchema = createInsertSchema(plans).omit({
  id: true,
  createdAt: true,
});

// Board schemas
export const insertBoardSchema = createInsertSchema(boards).omit({
  id: true,
  createdAt: true,
  updatedAt: true
});

// Usage schemas
export const insertUsageWindowSchema = createInsertSchema(usageWindows).omit({
  id: true,
  createdAt: true
});

export const insertPromptEventSchema = createInsertSchema(promptEvents).omit({
  id: true,
  createdAt: true
});

// Analytics schemas
export const insertAnalyticsAggregateSchema = createInsertSchema(analyticsAggregates).omit({
  id: true,
  createdAt: true,
  updatedAt: true
});

export const insertUserSessionSchema = createInsertSchema(userSessions).omit({
  id: true,
  createdAt: true
});

export const insertUserEventSchema = createInsertSchema(userEvents).omit({
  id: true,
  createdAt: true
});

export const insertPlanChangeSchema = createInsertSchema(planChanges).omit({
  id: true,
  createdAt: true
});

export const insertUserCohortSchema = createInsertSchema(userCohorts).omit({
  id: true,
  createdAt: true
});

// System schemas
export const insertSystemPromptSchema = createInsertSchema(systemPrompt).omit({
  id: true,
  updatedAt: true
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

export const insertStudentScheduleSchema = createInsertSchema(studentSchedules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateStudentScheduleSchema = createInsertSchema(studentSchedules).omit({
  id: true,
  studentId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

export const insertStudentPhaseSchema = createInsertSchema(studentPhases).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateStudentPhaseSchema = createInsertSchema(studentPhases).omit({
  id: true,
  studentId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

export const insertStudentGoalSchema = createInsertSchema(studentGoals).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateStudentGoalSchema = createInsertSchema(studentGoals).omit({
  id: true,
  studentId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

export const insertProgressEntrySchema = createInsertSchema(studentProgressEntries).omit({
  id: true,
  createdAt: true,
});

export const insertComplianceItemSchema = createInsertSchema(studentComplianceItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertServiceRecommendationSchema = createInsertSchema(studentServiceRecommendations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

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

// Authentication schemas
export const loginSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export const registerSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  password: z.string().min(6, "Password must be at least 6 characters"),
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

// Institute types
export type Institute = typeof institutes.$inferSelect;
export type InsertInstitute = z.infer<typeof insertInstituteSchema>;
export type UpdateInstitute = z.infer<typeof updateInstituteSchema>;
export type InstituteUser = typeof instituteUsers.$inferSelect;
export type InsertInstituteUser = z.infer<typeof insertInstituteUserSchema>;
export type UpdateInstituteUser = z.infer<typeof updateInstituteUserSchema>;
export type InstituteStudent = typeof instituteStudents.$inferSelect;
export type InsertInstituteStudent = z.infer<typeof insertInstituteStudentSchema>;
export type UpdateInstituteStudent = z.infer<typeof updateInstituteStudentSchema>;

// License types
export type License = typeof licenses.$inferSelect;
export type InsertLicense = z.infer<typeof insertLicenseSchema>;
export type UpdateLicense = z.infer<typeof updateLicenseSchema>;

// Student types
export type Student = typeof students.$inferSelect;
export type InsertStudent = z.infer<typeof insertStudentSchema>;
export type UpdateStudent = z.infer<typeof updateStudentSchema>;
export type UserStudent = typeof userStudents.$inferSelect;
export type InsertUserStudent = z.infer<typeof insertUserStudentSchema>;
export type UpdateUserStudent = z.infer<typeof updateUserStudentSchema>;
export type StudentSchedule = typeof studentSchedules.$inferSelect;
export type InsertStudentSchedule = z.infer<typeof insertStudentScheduleSchema>;
export type UpdateStudentSchedule = z.infer<typeof updateStudentScheduleSchema>;

// Student progress types
export type StudentPhase = typeof studentPhases.$inferSelect;
export type InsertStudentPhase = z.infer<typeof insertStudentPhaseSchema>;
export type UpdateStudentPhase = z.infer<typeof updateStudentPhaseSchema>;
export type StudentGoal = typeof studentGoals.$inferSelect;
export type InsertStudentGoal = z.infer<typeof insertStudentGoalSchema>;
export type UpdateStudentGoal = z.infer<typeof updateStudentGoalSchema>;
export type StudentProgressEntry = typeof studentProgressEntries.$inferSelect;
export type InsertProgressEntry = z.infer<typeof insertProgressEntrySchema>;
export type StudentComplianceItem = typeof studentComplianceItems.$inferSelect;
export type InsertComplianceItem = z.infer<typeof insertComplianceItemSchema>;
export type StudentServiceRecommendation = typeof studentServiceRecommendations.$inferSelect;
export type InsertServiceRecommendation = z.infer<typeof insertServiceRecommendationSchema>;

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
export type Plan = typeof plans.$inferSelect;
export type InsertPlan = z.infer<typeof insertPlanSchema>;
export type PromptEvent = typeof promptEvents.$inferSelect;
export type InsertPromptEvent = z.infer<typeof insertPromptEventSchema>;

// API types
export type ApiProvider = typeof apiProviders.$inferSelect;
export type InsertApiProvider = z.infer<typeof insertApiProviderSchema>;
export type ApiCall = typeof apiCalls.$inferSelect;
export type InsertApiCall = z.infer<typeof insertApiCallSchema>;
export type ApiProviderPricing = typeof apiProviderPricing.$inferSelect;
export type InsertApiProviderPricing = z.infer<typeof insertApiProviderPricingSchema>;

// Analytics types
export type UsageWindow = typeof usageWindows.$inferSelect;
export type InsertUsageWindow = z.infer<typeof insertUsageWindowSchema>;
export type AnalyticsAggregate = typeof analyticsAggregates.$inferSelect;
export type InsertAnalyticsAggregate = z.infer<typeof insertAnalyticsAggregateSchema>;
export type UserSession = typeof userSessions.$inferSelect;
export type InsertUserSession = z.infer<typeof insertUserSessionSchema>;
export type UserEvent = typeof userEvents.$inferSelect;
export type InsertUserEvent = z.infer<typeof insertUserEventSchema>;
export type PlanChange = typeof planChanges.$inferSelect;
export type InsertPlanChange = z.infer<typeof insertPlanChangeSchema>;
export type UserCohort = typeof userCohorts.$inferSelect;
export type InsertUserCohort = z.infer<typeof insertUserCohortSchema>;

// System types
export type SystemPrompt = typeof systemPrompt.$inferSelect;
export type InsertSystemPrompt = z.infer<typeof insertSystemPromptSchema>;

// Integration types
export type DropboxConnection = typeof dropboxConnections.$inferSelect;
export type InsertDropboxConnection = z.infer<typeof insertDropboxConnectionSchema>;
export type DropboxBackup = typeof dropboxBackups.$inferSelect;
export type InsertDropboxBackup = z.infer<typeof insertDropboxBackupSchema>;

// Chat types
export type ChatSession = typeof chatSessions.$inferSelect;
export type InsertChatSession = z.infer<typeof insertChatSessionSchema>;
export type ChatMode = "chat" | "boards" | "interpret" | 'docuslp' | 'overview' | 'students' | 'progress' | 'settings';

// Domain types
export type SystemType = 'tala' | 'us_iep';
export type PhaseStatus = 'pending' | 'in-progress' | 'completed' | 'locked';
export type GoalStatus = 'draft' | 'active' | 'achieved' | 'modified' | 'discontinued';
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

// Interface types for complex structures
export interface StudentWithProgress {
  id: string;
  name: string;
  idNumber?: string;
  school?: string;
  grade?: string;
  diagnosis?: string;
  systemType: SystemType;
  country?: string;
  overallProgress: number;
  nextDeadline?: string;
  currentPhase?: string;
  phases: StudentPhase[];
  goals: StudentGoal[];
}

export interface OverviewStats {
  totalStudents: number;
  activeCases: number;
  completedCases: number;
  pendingReview: number;
  upcomingDeadlines: number;
}

export interface PhaseDistribution {
  phaseId: string;
  phaseName: string;
  count: number;
  color: string;
}

// Chat system interfaces
export interface ChatMessageContent {
  text?: string;
  html?: string;
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
 * Board button action type
 */
export interface BoardButtonAction {
  type: "speak" | "link";
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
 * Grid dimensions for a board
 */
export interface BoardGrid {
  rows: number;
  cols: number;
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
export interface ModeContext {
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
  usageWindows: many(usageWindows),
  sessions: many(userSessions),
  events: many(userEvents),
  planChanges: many(planChanges),
  dropboxConnection: one(dropboxConnections),
  dropboxBackups: many(dropboxBackups),
  apiCalls: many(apiCalls),
  studentLinks: many(userStudents),
  instituteLinks: many(instituteUsers),
  licenses: many(licenses),
}));

// Institute relations
export const institutesRelations = relations(institutes, ({ many }) => ({
  userLinks: many(instituteUsers),
  studentLinks: many(instituteStudents),
  licenses: many(licenses),
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
  schedules: many(studentSchedules),
  interpretations: many(interpretations),
  inviteCodes: many(inviteCodes),
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

export const studentSchedulesRelations = relations(studentSchedules, ({ one }) => ({
  student: one(students, {
    fields: [studentSchedules.studentId],
    references: [students.id]
  }),
}));

export const studentPhasesRelations = relations(studentPhases, ({ one }) => ({
  student: one(students, {
    fields: [studentPhases.studentId],
    references: [students.id]
  }),
}));

export const studentGoalsRelations = relations(studentGoals, ({ one }) => ({
  student: one(students, {
    fields: [studentGoals.studentId],
    references: [students.id]
  }),
  phase: one(studentPhases, {
    fields: [studentGoals.phaseId],
    references: [studentPhases.id]
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
  })
}));

// Analytics relations
export const usageWindowsRelations = relations(usageWindows, ({ one }) => ({
  user: one(users, {
    fields: [usageWindows.userId],
    references: [users.id]
  })
}));

// Session relations
export const userSessionsRelations = relations(userSessions, ({ one, many }) => ({
  user: one(users, {
    fields: [userSessions.userId],
    references: [users.id]
  }),
  events: many(userEvents)
}));

export const userEventsRelations = relations(userEvents, ({ one }) => ({
  user: one(users, {
    fields: [userEvents.userId],
    references: [users.id]
  }),
  session: one(userSessions, {
    fields: [userEvents.sessionId],
    references: [userSessions.id]
  })
}));

export const planChangesRelations = relations(planChanges, ({ one }) => ({
  user: one(users, {
    fields: [planChanges.userId],
    references: [users.id]
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

// System relations
export const systemPromptRelations = relations(systemPrompt, ({ one }) => ({
  updatedByUser: one(users, {
    fields: [systemPrompt.updatedBy],
    references: [users.id]
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