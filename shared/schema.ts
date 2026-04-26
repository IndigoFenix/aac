import { pgTable, text, serial, integer, boolean, timestamp, real, varchar, jsonb, index, uniqueIndex, numeric, AnyPgColumn, pgEnum, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { sql, relations } from "drizzle-orm";
import { z } from "zod";

// =============================================================================
// RE-EXPORT EVERYTHING FROM PRIVATE SCHEMA
// All existing `@shared/schema` imports continue to work unchanged.
// =============================================================================

export * from "./schema-private";
export * from "./license-permissions";

// Import private tables/enums needed by public tables and relations
import { type LicensePermissions, licensePermissionsSchema } from "./license-permissions";
import {
  // Enums needed by public tables
  instituteTypeEnum,
  instituteInviteStatusEnum,
  verificationStatusEnum,
  identityProviderProtocolEnum,
  gradeEnum,
  apiTypeEnum,
  chatSessionStatusEnum,
  // Private tables needed by relations and public table references
  users,
  students,
  userStudents,
  instituteStudents,
  studentClassrooms,
  programs,
  profileDomains,
  baselineMeasurements,
  assessmentSources,
  goals,
  objectives,
  userGoals,
  userObjectives,
  services,
  serviceGoals,
  serviceUsers,
  accommodations,
  progressReports,
  goalProgressEntries,
  dataPoints,
  incidents,
  incidentTypeEnum,
  incidentSeverityEnum,
  transitionPlans,
  transitionGoals,
  programContacts,
  biometricData,
  meetings,
  consentForms,
  chatSessions,
  boards,
  inviteCodes,
  inviteCodeRedemptions,
  studentContacts,
  studentSymbolAssociations,
  medicalRecords,
  functionalReports,
  educationalReports,
  mfaRecoveryTokens,
  passwordResetTokens,
  aacSettings,
  classroomRoleEnum,
} from "./schema-private";

// =============================================================================
// PUBLIC TABLES — Admin/Auth
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

// =============================================================================
// PUBLIC TABLES — Identity Providers
// =============================================================================

// External identity providers (OIDC/OAuth2) for federated authentication
export const identityProviders = pgTable("identity_providers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(), // e.g. "Ministry of Education", "Google"
  protocol: identityProviderProtocolEnum("protocol").notNull(),
  discoveryUrl: text("discovery_url"), // OIDC discovery URL
  authorizationUrl: text("authorization_url"), // For OAuth2 without discovery
  tokenUrl: text("token_url"), // For OAuth2 without discovery
  userinfoUrl: text("userinfo_url"), // For OAuth2 without discovery
  clientId: text("client_id").notNull(),
  clientSecret: text("client_secret").notNull(), // Encrypted
  scopes: text("scopes").default("openid email profile"),
  claimMappings: jsonb("claim_mappings").default({}), // Maps provider claims to user/institute fields
  instituteIdType: text("institute_id_type"), // null = global (e.g. Google), 'MOE' = institute-specific
  reverificationDays: integer("reverification_days"), // null = never re-verify
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Links users to their external identities (Google, MoE, etc.)
export const userExternalIdentities = pgTable("user_external_identities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  providerId: varchar("provider_id").references(() => identityProviders.id).notNull(),
  externalId: text("external_id").notNull(), // The ID from the external provider
  email: text("email"), // Email from external provider (may differ from user's email)
  claims: jsonb("claims").default({}), // Full claims from the provider
  verifiedAt: timestamp("verified_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_uei_provider_external_id").on(table.providerId, table.externalId),
  index("idx_uei_user_id").on(table.userId),
  index("idx_uei_provider_id").on(table.providerId),
]);

// =============================================================================
// PUBLIC TABLES — Organization
// =============================================================================

// Institutes table - Schools or Clinics that can own licenses
export const institutes = pgTable("institutes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  type: instituteTypeEnum("type").notNull(), // 'school', 'clinic', or 'family'
  description: text("description"),
  address: text("address"),
  phone: text("phone"),
  email: text("email"),
  website: text("website"),
  logoUrl: text("logo_url"),
  instituteIdNumber: text("institute_id_number"), // Official ID number (e.g. school code, clinic license)
  instituteIdType: text("institute_id_type"), // Type of ID (e.g. 'MOE' for Ministry of Education, 'MOH' for Ministry of Health)
  // External storage — when set, sensitive fields for this institute's students are stored in the named backend
  externalStorage: varchar("external_storage"),
  // Preferred operational language (e.g. 'en', 'he') — used for report defaults and AI prompts
  language: text("language"),

  // Verification status — whether this institute has been verified by its claimed authority (e.g. MoE)
  verificationStatus: verificationStatusEnum("verification_status").default("unverified").notNull(),

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
  userType: text("user_type"), // Professional type: 'Caregiver', 'Parent', 'Teacher', 'SLP'
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

// =============================================================================
// PUBLIC TABLES — Billing
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
  subscriptionType: text("subscription_type").default("monthly"), // 'monthly', 'yearly'
  subscriptionExpiresAt: timestamp("subscription_expires_at"),
  isTrial: boolean("is_trial").default(false).notNull(),
  trialExpiresAt: timestamp("trial_expires_at"),
  credits: integer("credits").default(0).notNull(),

  // Stripe/payment integration
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),

  // Permissions
  permissions: jsonb("permissions").$type<LicensePermissions>(),

  // Email of invited user (for linking license when user registers)
  inviteEmail: text("invite_email"),

  // Invite token for direct registration (non-institute licenses)
  inviteToken: text("invite_token"),

  // Pre-filled defaults for the invite signup form (set at creation, not editable)
  inviteDefaults: jsonb("invite_defaults").$type<{ firstName?: string; lastName?: string; userType?: string }>(),

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
  index("idx_licenses_invite_email").on(table.inviteEmail),
  uniqueIndex("idx_licenses_invite_token").on(table.inviteToken),
]);

// Credits transactions table for tracking credit usage
export const creditTransactions = pgTable("credit_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  amount: integer("amount").notNull(), // positive for additions, negative for usage
  type: text("type").notNull(), // 'purchase', 'usage', 'refund', 'bonus'
  description: text("description").notNull(),
  relatedInterpretationId: varchar("related_interpretation_id"), // Legacy FK — interpretations table deleted
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
// PUBLIC TABLES — API
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
// PUBLIC TABLES — Config
// =============================================================================

// AI Personas - configurable AI personalities with custom prompts
// title and description support multilingual content: plain string or JSON {"en":"...", "he":"..."}
export const personas = pgTable("personas", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(), // Plain string or JSON {"en":"...", "he":"..."}
  description: text("description"), // Plain string or JSON {"en":"...", "he":"..."}
  icon: text("icon").notNull(), // Emoji or icon identifier
  prompt: text("prompt").notNull(), // System prompt text for this persona (not multilingual)
  manualSelection: boolean("manual_selection").default(true).notNull(), // Whether users can manually select this persona
  active: boolean("active").default(true).notNull(),
  testMode: boolean("test_mode").default(false).notNull(), // If true, only system admins can see this persona
  instituteId: varchar("institute_id").references(() => institutes.id), // If set, only users in this institute can see it
  llmProvider: text("llm_provider"), // Optional per-persona LLM provider override (e.g. "openai", "gemini", "claude")
  llmModel: text("llm_model"), // Optional per-persona LLM model override (e.g. "gpt-4o", "claude-sonnet")
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_personas_active").on(table.active),
  index("idx_personas_manual_selection").on(table.manualSelection),
  index("idx_personas_institute_id").on(table.instituteId),
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

// System settings (key-value store for LLM config etc.)
export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// =============================================================================
// PUBLIC TABLES — Symbols
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
// INSERT/UPDATE SCHEMAS (Public tables)
// =============================================================================

// Identity provider schemas
export const insertIdentityProviderSchema = createInsertSchema(identityProviders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateIdentityProviderSchema = createInsertSchema(identityProviders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial();

export const insertUserExternalIdentitySchema = createInsertSchema(userExternalIdentities).omit({
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

export const updateClassroomSchema = insertClassroomSchema.partial();
export const updateClassroomUserSchema = insertClassroomUserSchema.partial();

// License schemas — override `permissions` and `inviteDefaults` with typed Zod schemas
const inviteDefaultsSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  userType: z.string().optional(),
}).nullable().optional();

export const insertLicenseSchema = createInsertSchema(licenses, {
  permissions: licensePermissionsSchema.nullable().optional(),
  inviteDefaults: inviteDefaultsSchema,
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateLicenseSchema = createInsertSchema(licenses, {
  permissions: licensePermissionsSchema.nullable().optional(),
  inviteDefaults: inviteDefaultsSchema,
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial();

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

export const insertApiProviderPricingSchema = createInsertSchema(apiProviderPricing).omit({
  id: true,
  createdAt: true,
  updatedAt: true
});

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
// TYPES (Public tables)
// =============================================================================

export type AdminUser = typeof adminUsers.$inferSelect;
export type UpsertAdminUser = typeof adminUsers.$inferInsert;

// Identity provider types
export type IdentityProvider = typeof identityProviders.$inferSelect;
export type InsertIdentityProvider = z.infer<typeof insertIdentityProviderSchema>;
export type UpdateIdentityProvider = z.infer<typeof updateIdentityProviderSchema>;
export type UserExternalIdentity = typeof userExternalIdentities.$inferSelect;
export type InsertUserExternalIdentity = z.infer<typeof insertUserExternalIdentitySchema>;

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

// Classroom types
export type Classroom = typeof classrooms.$inferSelect;
export type InsertClassroom = z.infer<typeof insertClassroomSchema>;
export type UpdateClassroom = z.infer<typeof updateClassroomSchema>;
export type ClassroomUser = typeof classroomUsers.$inferSelect;
export type InsertClassroomUser = z.infer<typeof insertClassroomUserSchema>;
export type UpdateClassroomUser = z.infer<typeof updateClassroomUserSchema>;

// License types
export type License = typeof licenses.$inferSelect;
export type InsertLicense = z.infer<typeof insertLicenseSchema>;
export type UpdateLicense = z.infer<typeof updateLicenseSchema>;

// Custom symbol types
export type CustomSymbol = typeof customSymbols.$inferSelect;
export type InsertCustomSymbol = z.infer<typeof insertCustomSymbolSchema>;
export type UpdateCustomSymbol = z.infer<typeof updateCustomSymbolSchema>;
export type UserSymbolAssociation = typeof userSymbolAssociations.$inferSelect;
export type InsertUserSymbolAssociation = z.infer<typeof insertUserSymbolAssociationSchema>;
export type UpdateUserSymbolAssociation = z.infer<typeof updateUserSymbolAssociationSchema>;
export type InstituteSymbolAssociation = typeof instituteSymbolAssociations.$inferSelect;
export type InsertInstituteSymbolAssociation = z.infer<typeof insertInstituteSymbolAssociationSchema>;
export type UpdateInstituteSymbolAssociation = z.infer<typeof updateInstituteSymbolAssociationSchema>;

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

// API types
export type ApiProvider = typeof apiProviders.$inferSelect;
export type InsertApiProvider = z.infer<typeof insertApiProviderSchema>;
export type ApiProviderPricing = typeof apiProviderPricing.$inferSelect;
export type InsertApiProviderPricing = z.infer<typeof insertApiProviderPricingSchema>;

export type FeatureType = "chat" | "boards" | "customApps" | "interpret" | 'docuslp' | 'overview' | 'students' | 'studentInfo' | 'contacts' | 'institute' | 'progress' | 'reports' | 'settings' | 'aacsettings' | 'aac' | 'symbols' | 'calendar' | 'userchat' | 'deepAnalysis' | 'shares';

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

// Re-import types from schema-private for use in interfaces
import type {
  Program,
  Student,
  ProfileDomain,
  BaselineMeasurement,
  AssessmentSource,
  Goal,
  Objective,
  DataPoint,
  Service,
  Accommodation,
  ProgressReport,
  GoalProgressEntry,
  TransitionPlan,
  TransitionGoal,
  StudentContact,
  ProgramContact,
  Meeting,
  ConsentForm,
  ProgramStatus,
} from "./schema-private";

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
  // Program team — junction rows with their underlying contact joined in
  teamContacts: (ProgramContact & { contact: StudentContact })[];
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
  type: "speak" | "link" | "back" | "home" | "exit" | "open_website";
  text?: string;
  toPageId?: string;
  /** For "open_website" actions: the URL to load in the browser app. Must match a permitted website prefix. */
  url?: string;
}

/**
 * A website the AAC AI is permitted to open via the browser app.
 * `subpages` are optional AI-facing hints — any URL whose origin+pathname starts with
 * a parent's url is permitted (subpages do not further restrict access).
 */
export interface PermittedWebsite {
  url: string;
  label: string;
  description?: string;
  subpages?: PermittedWebsite[];
}

/**
 * A YouTube channel the AAC AI may pick videos from. `channelId` is the stable
 * UC... identifier. `description` is AI-facing (used to help the AI choose a
 * channel that matches the student's request).
 */
export interface PermittedYoutubeChannel {
  channelId: string;
  label: string;
  description?: string;
}

/**
 * Single button on an AAC communication board
 */
export interface BoardButton {
  id: string;
  row: number;
  col: number;
  rowSpan?: number;  // Number of rows this button spans (default 1)
  colSpan?: number;  // Number of columns this button spans (default 1)
  label: string;
  spokenText?: string;
  /** Pre-generated interpreted sentence for this button (e.g. "I want some water" for a "Water" button) */
  sentence?: string;
  color?: string;
  iconRef?: string;
  symbolPath?: string;
  rebusKey?: string;
  imageKey?: string;
  selfClosing?: boolean;
  /** When true, pressing this button automatically unloads the prebuilt board, giving the AI the full 12-button board */
  exitBoard?: boolean;
  /** Visual style hint: "guess" for guessing mode final guesses, "category" for narrowing categories */
  buttonType?: "normal" | "guess" | "category";
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
  /** Board cover/thumbnail image */
  coverImage?: {
    iconRef?: string;      // Emoji or icon reference (e.g. "🏠")
    imageKey?: string;     // Auto-generated symbol key (e.g. "communication_board")
    symbolPath?: string;   // Resolved symbol path (e.g. "/api/symbols/abc123.svg" or "[sstix#]50026.emf")
    backgroundColor?: string; // Background color for the cover (e.g. "#D6FFF6FF")
  };
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

  /** File extraction results — cached by client to avoid re-extraction */
  extractions?: Array<{ filename: string; extractedText: string }>;
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
  /** When true, the memory prompt is rendered once and frozen until compression */
  staticPromptMode?: boolean;
  /** Cached rendered prompt — set on first render in static mode, cleared on compression */
  _cachedPrompt?: string;
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
  fdaLookup?: { enabled?: boolean; };
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
// RELATIONS (all in schema.ts — need access to both private and public tables)
// =============================================================================

// User relations
export const usersRelations = relations(users, ({ many, one }) => ({
  boards: many(boards),
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
  teamContacts: many(programContacts),
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
  userLinks: many(userObjectives),
}));

export const servicesRelations = relations(services, ({ one, many }) => ({
  program: one(programs, {
    fields: [services.programId],
    references: [programs.id]
  }),
  providerContact: one(studentContacts, {
    fields: [services.providerContactId],
    references: [studentContacts.id]
  }),
  accommodations: many(accommodations),
  goalLinks: many(serviceGoals),
  userLinks: many(serviceUsers),
  calendarEvents: many(calendarEvents),
}));

export const serviceUsersRelations = relations(serviceUsers, ({ one }) => ({
  service: one(services, {
    fields: [serviceUsers.serviceId],
    references: [services.id],
  }),
  user: one(users, {
    fields: [serviceUsers.userId],
    references: [users.id],
  }),
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

export const studentContactsRelations = relations(studentContacts, ({ one, many }) => ({
  student: one(students, {
    fields: [studentContacts.studentId],
    references: [students.id]
  }),
  linkedUser: one(users, {
    fields: [studentContacts.linkedUserId],
    references: [users.id]
  }),
  linkedStudent: one(students, {
    fields: [studentContacts.linkedStudentId],
    references: [students.id],
    relationName: 'linkedStudent',
  }),
  biometricData: one(biometricData, {
    fields: [studentContacts.biometricDataId],
    references: [biometricData.id]
  }),
  programContacts: many(programContacts),
  providedServices: many(services),
}));

export const programContactsRelations = relations(programContacts, ({ one }) => ({
  program: one(programs, {
    fields: [programContacts.programId],
    references: [programs.id]
  }),
  contact: one(studentContacts, {
    fields: [programContacts.contactId],
    references: [studentContacts.id]
  }),
}));

export const biometricDataRelations = relations(biometricData, ({ many }) => ({
  users: many(users),
  students: many(students),
  contacts: many(studentContacts),
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

// =============================================================================
// CONTACT INQUIRIES (landing page form submissions)
// =============================================================================
export const contactMessageTypeEnum = pgEnum("contact_message_type", [
  "contact",
  "bug_report",
  "support_request",
]);

export const contactRoleEnum = pgEnum("contact_role", [
  "district_administrator",
  "special_education_director",
  "speech_language_pathologist",
  "educator",
  "other",
]);

export const contactInquiries = pgTable("contact_inquiries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  messageType: contactMessageTypeEnum("message_type").default("contact").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  organization: text("organization").notNull(),
  role: contactRoleEnum("role").notNull(),
  message: text("message"),
  userId: varchar("user_id").references(() => users.id), // set when submitted by a logged-in user
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_contact_inquiries_email").on(table.email),
  index("idx_contact_inquiries_created_at").on(table.createdAt),
  index("idx_contact_inquiries_message_type").on(table.messageType),
]);

export const insertContactInquirySchema = createInsertSchema(contactInquiries).pick({
  messageType: true,
  firstName: true,
  lastName: true,
  email: true,
  organization: true,
  role: true,
  message: true,
});

export type ContactInquiry = typeof contactInquiries.$inferSelect;
export type InsertContactInquiry = z.infer<typeof insertContactInquirySchema>;

// =============================================================================
// PUBLIC TABLES — Calendar
// =============================================================================

export const eventRepeatEnum = pgEnum("event_repeat", ["none", "daily", "weekly", "monthly_date", "monthly_weekday"]);
export const eventAttendeeTypeEnum = pgEnum("event_attendee_type", ["user", "student", "classroom", "institute"]);
export const eventInviteStatusEnum = pgEnum("event_invite_status", ["pending", "accepted", "declined"]);

export const calendarEvents = pgTable("calendar_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  description: text("description"),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  allDay: boolean("all_day").default(false).notNull(),

  // Recurrence
  repeatType: eventRepeatEnum("repeat_type").default("none").notNull(),
  repeatInterval: integer("repeat_interval").default(1), // every N weeks (for weekly type)
  repeatDays: jsonb("repeat_days").$type<number[]>(), // 0=Sun..6=Sat for weekly repeats
  repeatMonthWeek: integer("repeat_month_week"), // for monthly_weekday: 1=first, 2=second, 3=third, -1=last
  repeatEndDate: timestamp("repeat_end_date", { withTimezone: true }), // when recurrence stops

  // Event-type association FKs. Exactly one of serviceId / instituteId / classroomId
  // should be set (or none, for a standard event). Type is derived from which is set.
  // Service events follow the cascade-delete pattern already established.
  serviceId: varchar("service_id").references(() => services.id, { onDelete: "cascade" }),
  instituteId: varchar("institute_id").references(() => institutes.id, { onDelete: "cascade" }),
  classroomId: varchar("classroom_id").references(() => classrooms.id, { onDelete: "cascade" }),

  createdByUserId: varchar("created_by_user_id").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_calendar_events_start_time").on(table.startTime),
  index("idx_calendar_events_end_time").on(table.endTime),
  index("idx_calendar_events_created_by").on(table.createdByUserId),
  index("idx_calendar_events_service_id").on(table.serviceId),
  index("idx_calendar_events_institute_id").on(table.instituteId),
  index("idx_calendar_events_classroom_id").on(table.classroomId),
]);

export const calendarEventAttendees = pgTable("calendar_event_attendees", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  eventId: varchar("event_id").references(() => calendarEvents.id, { onDelete: "cascade" }).notNull(),
  attendeeType: eventAttendeeTypeEnum("attendee_type").notNull(),
  attendeeId: varchar("attendee_id").notNull(), // FK to users/students/classrooms/institutes
  inviteStatus: eventInviteStatusEnum("invite_status").default("pending").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_event_attendees_event_id").on(table.eventId),
  index("idx_event_attendees_type_id").on(table.attendeeType, table.attendeeId),
]);

// Calendar insert/update schemas
export const insertCalendarEventSchema = createInsertSchema(calendarEvents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  createdByUserId: true, // set by server
});

export const updateCalendarEventSchema = createInsertSchema(calendarEvents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  createdByUserId: true,
}).partial();

export const insertEventAttendeeSchema = createInsertSchema(calendarEventAttendees).omit({
  id: true,
  createdAt: true,
});

// Calendar types
export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type InsertCalendarEvent = z.infer<typeof insertCalendarEventSchema>;
export type UpdateCalendarEvent = z.infer<typeof updateCalendarEventSchema>;
export type CalendarEventAttendee = typeof calendarEventAttendees.$inferSelect;
export type InsertEventAttendee = z.infer<typeof insertEventAttendeeSchema>;

/** Event with its attendees loaded */
export interface CalendarEventWithAttendees {
  event: CalendarEvent;
  attendees: CalendarEventAttendee[];
}

// Calendar relations
export const calendarEventsRelations = relations(calendarEvents, ({ one, many }) => ({
  createdBy: one(users, {
    fields: [calendarEvents.createdByUserId],
    references: [users.id],
  }),
  service: one(services, {
    fields: [calendarEvents.serviceId],
    references: [services.id],
  }),
  attendees: many(calendarEventAttendees),
}));

export const calendarEventAttendeesRelations = relations(calendarEventAttendees, ({ one }) => ({
  event: one(calendarEvents, {
    fields: [calendarEventAttendees.eventId],
    references: [calendarEvents.id],
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
