import { pgTable, text, serial, integer, boolean, timestamp, real, doublePrecision, varchar, jsonb, index, uniqueIndex, numeric, AnyPgColumn, pgEnum, date, check } from "drizzle-orm/pg-core";
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

// Redeemed WebSocket-upgrade ticket nonces (server/services/realtime/ws-ticket.ts).
// A ticket must be single-use ACROSS ECS tasks — an in-process set only holds
// per task, so a leaked ticket could be replayed once on every task behind the
// ALB. Rows are tiny, live ~60s, and carry no PHI (an opaque nonce + expiry).
export const wsTicketNonces = pgTable(
  "ws_ticket_nonces",
  {
    nonce: varchar("nonce", { length: 64 }).primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [index("IDX_ws_ticket_nonces_expires").on(table.expiresAt)],
);

// Admin users table for backoffice access
// `permissions` is a list of admin-section keys this admin can access; the
// wildcard `"*"` grants every section. Migrated legacy system admins land
// with `["*"]`; future admins added via the management UI get an explicit list.
//
// Auth fields (password, MFA, authProvider, googleId) live on this row — the
// legacy `users` row is gone for admins as of migration 0107. System-admin
// login no longer touches the `users` table.
export const adminUsers = pgTable("admin_users", {
  id: varchar("id").primaryKey().notNull(),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  role: text("role").default("admin"),
  permissions: jsonb("permissions")
    .$type<string[]>()
    .notNull()
    .default(sql`'["*"]'::jsonb`),
  password: text("password"),
  authProvider: text("auth_provider").default("email").notNull(),
  googleId: text("google_id").unique(),
  mfaEnabled: boolean("mfa_enabled").default(false).notNull(),
  mfaSecret: text("mfa_secret"),
  mfaEnforcedByAdmin: boolean("mfa_enforced_by_admin").default(false).notNull(),
  // Mirrors `users.is_active`. Admins live in their own table, so before this
  // existed a backoffice account could not be deactivated at all — the widest
  // access in the system with no off switch. Enforced in every auth path via
  // `canAuthenticate()` in server/userAuth.ts.
  isActive: boolean("is_active").default(true).notNull(),
  lastActiveAt: timestamp("last_active_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Password reset tokens for admins. Separate from the regular `password_reset_tokens`
// table (which FKs to users.id) because admins live in their own table after 0107.
export const adminPasswordResetTokens = pgTable("admin_password_reset_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  adminUserId: varchar("admin_user_id")
    .references(() => adminUsers.id, { onDelete: "cascade" })
    .notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_admin_password_reset_tokens_admin_user_id").on(table.adminUserId),
  index("idx_admin_password_reset_tokens_expires_at").on(table.expiresAt),
]);

// MFA recovery tokens for admins. Parallel to `mfa_recovery_tokens` but FK'd
// to admin_users — used by the admin-specific MFA-recovery email path.
export const adminMfaRecoveryTokens = pgTable("admin_mfa_recovery_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  adminUserId: varchar("admin_user_id")
    .references(() => adminUsers.id, { onDelete: "cascade" })
    .notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_admin_mfa_recovery_tokens_admin_user_id").on(table.adminUserId),
  index("idx_admin_mfa_recovery_tokens_expires_at").on(table.expiresAt),
]);

// =============================================================================
// PUBLIC TABLES — Identity Providers
// =============================================================================

// External identity providers (OIDC/OAuth2/SAML) for federated authentication
export const identityProviders = pgTable("identity_providers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(), // e.g. "Ministry of Education", "Google"
  protocol: identityProviderProtocolEnum("protocol").notNull(),
  // OIDC / OAuth2 fields
  discoveryUrl: text("discovery_url"), // OIDC discovery URL
  authorizationUrl: text("authorization_url"), // For OAuth2 without discovery
  tokenUrl: text("token_url"), // For OAuth2 without discovery
  userinfoUrl: text("userinfo_url"), // For OAuth2 without discovery
  clientId: text("client_id"), // null for SAML
  clientSecret: text("client_secret"), // Encrypted; null for SAML (no shared secret)
  scopes: text("scopes").default("openid email profile"),
  // SAML 2.0 fields. All nullable; only populated when protocol = 'saml'.
  // The SP (us) is identified by samlSpEntityId (defaults to APP_URL/saml/sp).
  samlEntityId: text("saml_entity_id"),               // IdP's entityID
  samlSsoUrl: text("saml_sso_url"),                   // IdP's SingleSignOnService URL
  samlSloUrl: text("saml_slo_url"),                   // IdP's SingleLogoutService URL
  samlX509Cert: text("saml_x509_cert"),               // IdP's signing certificate (PEM)
  samlNameIdFormat: text("saml_name_id_format")       // e.g. urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress
    .default("urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"),
  samlSignAuthnRequests: boolean("saml_sign_authn_requests").default(false),
  samlWantAssertionsSigned: boolean("saml_want_assertions_signed").default(true),
  samlSpEntityId: text("saml_sp_entity_id"),          // Override SP entity ID (else derived from APP_URL)
  samlSpPrivateKey: text("saml_sp_private_key"),      // Encrypted; only when SP signs requests
  samlSpCertificate: text("saml_sp_certificate"),     // SP cert (PEM); published in SP metadata
  // Common
  claimMappings: jsonb("claim_mappings").default({}), // Maps provider claims/attrs to canonical user/institute fields
  instituteIdType: text("institute_id_type"),         // null = global (e.g. Google), 'il_moe' = regime-specific
  reverificationDays: integer("reverification_days"), // null = never re-verify
  // When true, an SSO callback for an unrecognized externalId auto-creates
  // a user from the canonical claims (email + given/family name) and links
  // it. Required for IL MoE (Sapakim) go-live since teachers click an
  // MoE-portal link expecting to land already-logged-in. When false
  // (default), the callback returns ?ssoError=no_account so the user has
  // to register first and then link the SSO provider from settings.
  autoProvision: boolean("auto_provision").default(false).notNull(),
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
  // IANA timezone (e.g. 'America/New_York', 'Asia/Jerusalem'). Optional; rollups
  // that bucket events into local days fall back to UTC when this is unset.
  // Used by the Insurance Bridge module for day-boundary alignment.
  timezone: text("timezone"),

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

  // Paddle payment integration. Separate columns rather than reusing the
  // stripe_* ones: a license can carry history from either processor, and
  // overloading the column would make a Stripe id and a Paddle id
  // indistinguishable at the point where we have to call an API with it.
  paddleCustomerId: text("paddle_customer_id"),
  paddleSubscriptionId: text("paddle_subscription_id"),
  // Per-license pricing (organisations are quoted individually; catalog tiers
  // via subscriptionPlans.paddlePriceId come later for self-serve). The amount
  // is in the currency's minor unit (cents/agorot) as Paddle expects; the
  // interval is `subscriptionType` above. Null amount = not purchasable online
  // (invoice-paid or admin-granted).
  priceAmount: integer("price_amount"),
  priceCurrency: text("price_currency").default("USD"),
  // The most recent checkout transaction created for this license (pending or
  // completed); fulfillment matches transaction.completed against it.
  paddleTransactionId: text("paddle_transaction_id"),

  // Permissions
  permissions: jsonb("permissions").$type<LicensePermissions>(),

  // Session recording (shared/aac/session-recording.ts) — whether devices under
  // this license may record a student on camera to the device's own disk.
  //
  // A REAL COLUMN, deliberately NOT a key inside `permissions`, and the reason
  // is mechanical rather than stylistic: `permissions` is resolved through
  // resolvePermissions(), where `all: true` — which the admin form's "Grant All
  // Permissions" switch sets — expands to MAX_LICENSE_PERMISSIONS wholesale,
  // and getInstituteLicenseInfo() hands that same MAX object to every system
  // admin. A key placed there would therefore switch itself on for whole
  // classes of license nobody meant to grant it to.
  //
  // This is not a customer-facing permission at all. It is an operator-granted
  // marketing entitlement, handed to the few people who cut promotional
  // material out of real sessions; it is never sold, never appears on a pricing
  // page, and is set only by a system admin (never a section admin). Off for
  // everyone else, permanently.
  allowSessionRecording: boolean("allow_session_recording").default(false).notNull(),

  // Email of invited user (for linking license when user registers)
  inviteEmail: text("invite_email"),

  // Invite token for direct registration (non-institute licenses)
  inviteToken: text("invite_token"),

  // Pre-filled defaults for the invite signup form (set at creation, not editable).
  // For family-institute provisioning the admin can additionally capture
  // guardian-identity bits (country / phone / government ID) so the in-product
  // consent wizard prefills instead of asking the parent again.
  // See planning-docs/student-consent-onboarding-plan.md.
  inviteDefaults: jsonb("invite_defaults").$type<{
    firstName?: string;
    lastName?: string;
    userType?: string;
    country?: string;                                            // ISO 3166-1 alpha-2
    phone?: string;                                              // E.164
    governmentIdNumber?: string;
    governmentIdType?: 'national_id' | 'passport' | 'driver_license' | 'other';
    governmentIdCountry?: string;                                // ISO 3166-1 alpha-2
    identityProvenanceNote?: string;                             // admin attestation
  }>(),

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
  // Paddle catalog price this package is sold as. The webhook resolves a
  // purchased line item back to a package through this column, so it must be
  // unique — two packages sharing a price id would make fulfillment ambiguous.
  // Nullable: packages sold only through other processors have none.
  paddlePriceId: text("paddle_price_id").unique(),
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
  // Paddle catalog price this plan is sold as (unique, same reason as
  // creditPackages.paddlePriceId — it is the lookup key from a webhook).
  paddlePriceId: text("paddle_price_id").unique(),
  // What a paid subscription on this plan GRANTS the license. Both nullable:
  // a plan that leaves them null sells credits + a validity window only, and
  // fulfillment then leaves the license's existing tier untouched.
  licenseType: text("license_type"),
  permissions: jsonb("permissions").$type<LicensePermissions>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Paddle webhook events — the idempotency ledger for /api/paddle/webhook.
 *
 * The primary key is PADDLE's `event_id`, not a generated uuid: that is the
 * whole point of the table. Paddle retries a webhook until it gets a 2xx, so
 * the same event id arrives more than once as a matter of course, and the
 * insert conflicting on the PK is how a replay is recognised BEFORE any credit
 * is granted. `status` then says what happened, so a retry of an event we
 * already processed can be answered 200 without re-granting, while one we
 * previously FAILED is allowed to run again.
 *
 * `occurredAt` is Paddle's own event timestamp (not our receipt time) — the
 * out-of-order guard in paddleFulfillmentService compares against it.
 */
export const paddleEvents = pgTable("paddle_events", {
  id: text("id").primaryKey(), // Paddle event_id, e.g. "evt_01h..."
  eventType: text("event_type").notNull(), // e.g. "transaction.completed"
  occurredAt: timestamp("occurred_at").notNull(), // Paddle's occurred_at
  status: text("status").notNull(), // 'received' | 'processed' | 'failed' | 'ignored'
  // Free-text note about the outcome: the failure message when `failed`, the
  // reason when `ignored`, and a summary of what was applied when `processed`.
  // Named `error` because that is what it is for in the two cases that matter.
  error: text("error"),
  payload: jsonb("payload"), // raw event body, for forensics
  createdAt: timestamp("created_at").defaultNow().notNull(),
  processedAt: timestamp("processed_at"),
}, (table) => [
  index("idx_paddle_events_event_type").on(table.eventType),
  index("idx_paddle_events_occurred_at").on(table.occurredAt),
]);

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
  // When true, the topic is exposed to the public CRM landing-page chat agent
  // in addition to the regular clinician/AAC agents. Defaults to false: most
  // library content is internal and shouldn't leak to anonymous visitors.
  crmAccessible: boolean("crm_accessible").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_topics_parent_id").on(table.parentId),
  index("idx_topics_active").on(table.active),
  index("idx_topics_crm_accessible").on(table.crmAccessible),
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
  // True when this image depicts an IDENTIFIABLE PERSON — a staff portrait, a
  // photo of a real adult. Such symbols may appear on boards inside an
  // institute-visible package, but never in a public one, and the image itself
  // is access-gated rather than served to any authenticated caller.
  // Default false is safe because public packages are a NEW surface: no
  // existing symbol has ever been publishable.
  // See planning-docs/aac-packages-plan.md §3.
  personImage: boolean("person_image").default(false).notNull(),
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
// PACKAGES
// Shareable content bundles owned by an institute. Operational, not PHI — the
// package row describes content, and member boards carry no student-identifying
// material (enforced at the package boundary). Distribution to students goes
// through `packageAssignments` in the private schema.
// See planning-docs/aac-packages-plan.md.
// =============================================================================

export const packages = pgTable("packages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Owning institute. NULLABLE: nulled when the package is orphaned (deleted by
  // its owner while students/grants still link to it) — see the check below.
  instituteId: varchar("institute_id").references(() => institutes.id),
  // Primary content kind, for display and search filtering. NOT a constraint on
  // contents: once other item types exist a package may hold more than one kind.
  type: text("type").default("board").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  language: text("language").default("en"),
  // 'institute' — usable by the owning institute (and explicit grants).
  // 'public'    — usable by anyone, but only once approvalStatus='approved'.
  // Publicly usable is never publicly editable.
  visibility: text("visibility").default("institute").notNull(),
  // What a plain member of the owning institute gets without an explicit grant.
  // Default 'use' so an institute can use its own packages out of the box.
  defaultMemberPermission: text("default_member_permission").default("use").notNull(),
  // Admin review gate for PUBLIC listing only. Institute-scoped packages never
  // leave the boundary that already governs their boards, so they skip review.
  // 'none' | 'pending' | 'approved' | 'rejected'
  approvalStatus: text("approval_status").default("none").notNull(),
  // Set when visibility flips to public. `publishAttestation` is the compliance
  // record that a HUMAN confirmed the package carries no images of identifiable
  // people: { noPersonImages: true, at, byUserId }. The AI may propose a publish
  // but never complete one — see aac-packages-plan.md §9.3.
  publishedAt: timestamp("published_at"),
  publishedByUserId: varchar("published_by_user_id").references(() => users.id),
  publishAttestation: jsonb("publish_attestation"),
  // Atomic refcount over packageAssignments + packageGrants. An orphaned package
  // (deletedAt set) survives until this reaches zero, so deleting a package never
  // yanks content out from under a student mid-session. Maintained ONLY by
  // server/services/packages/packageLinks.ts. See plan §1.5.
  linkCount: integer("link_count").default(0).notNull(),
  // Non-null = orphaned: frozen (no edits, no new links, no publish) and awaiting
  // garbage collection once linkCount hits zero.
  deletedAt: timestamp("deleted_at"),
  createdByUserId: varchar("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  // A LIVE package must have an owner; an orphaned one need not.
  check(
    "packages_live_has_owner",
    sql`${table.deletedAt} IS NOT NULL OR ${table.instituteId} IS NOT NULL`,
  ),
  index("idx_packages_institute_id").on(table.instituteId),
  index("idx_packages_visibility_approval").on(table.visibility, table.approvalStatus),
  index("idx_packages_deleted_at").on(table.deletedAt),
]);

// Package membership for boards. One link table PER ITEM TYPE (packageApps etc.
// follow the same shape) rather than a polymorphic itemId — the real FK means a
// deleted board takes its membership rows with it, with no reconciliation job.
export const packageBoards = pgTable("package_boards", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  packageId: varchar("package_id").references(() => packages.id, { onDelete: "cascade" }).notNull(),
  // Cross-schema FK: boards.id lives in schema-private.ts.
  boardId: varchar("board_id").references(() => boards.id, { onDelete: "cascade" }).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  // Per-MEMBERSHIP auto-load, so one board can auto-load in one package and not
  // another. Effective auto-load = autoLoad && board.automaticSelection.
  // A board with autoLoad=false stays visible in the student's picker but is
  // never shown to the AI.
  autoLoad: boolean("auto_load").default(true).notNull(),
  addedByUserId: varchar("added_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_package_boards_package_board").on(table.packageId, table.boardId),
  index("idx_package_boards_board_id").on(table.boardId),
]);

// Per-member ACL within the owning institute. An 'edit' grant is effectively
// CO-OWNERSHIP: grants count toward packages.linkCount, so a granted package
// survives its original owner deleting it. V1 has no cross-institute grants —
// a package is reachable by its owning institute or by being public.
export const packageGrants = pgTable("package_grants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  packageId: varchar("package_id").references(() => packages.id, { onDelete: "cascade" }).notNull(),
  granteeUserId: varchar("grantee_user_id").references(() => users.id).notNull(),
  permission: text("permission").default("use").notNull(), // 'use' | 'edit'
  grantedByUserId: varchar("granted_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_package_grants_package_user").on(table.packageId, table.granteeUserId),
  index("idx_package_grants_grantee").on(table.granteeUserId),
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
  country: z.string().optional(),
  phone: z.string().optional(),
  governmentIdNumber: z.string().optional(),
  governmentIdType: z.enum(['national_id', 'passport', 'driver_license', 'other']).optional(),
  governmentIdCountry: z.string().optional(),
  identityProvenanceNote: z.string().optional(),
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

export const insertSubscriptionPlanSchema = createInsertSchema(subscriptionPlans, {
  permissions: licensePermissionsSchema.nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
});

export const insertPaddleEventSchema = createInsertSchema(paddleEvents).omit({
  createdAt: true,
  processedAt: true,
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

// Package schemas. linkCount/deletedAt/publish* are lifecycle state owned by the
// server (packageLinks.ts and the publish path) — never client-writable.
const PACKAGE_SERVER_OWNED = {
  id: true,
  linkCount: true,
  deletedAt: true,
  publishedAt: true,
  publishedByUserId: true,
  publishAttestation: true,
  approvalStatus: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const insertPackageSchema = createInsertSchema(packages).omit(PACKAGE_SERVER_OWNED);

export const updatePackageSchema = createInsertSchema(packages).omit({
  ...PACKAGE_SERVER_OWNED,
  instituteId: true, // ownership is not client-transferable
  visibility: true,  // goes through the publish/unpublish path, never a field write
}).partial();

export const insertPackageBoardSchema = createInsertSchema(packageBoards).omit({
  id: true,
  createdAt: true,
});

export const insertPackageGrantSchema = createInsertSchema(packageGrants).omit({
  id: true,
  createdAt: true,
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
export type AdminPasswordResetToken = typeof adminPasswordResetTokens.$inferSelect;
export type InsertAdminPasswordResetToken = typeof adminPasswordResetTokens.$inferInsert;
export type AdminMfaRecoveryToken = typeof adminMfaRecoveryTokens.$inferSelect;
export type InsertAdminMfaRecoveryToken = typeof adminMfaRecoveryTokens.$inferInsert;

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
// Package types
export type Package = typeof packages.$inferSelect;
export type InsertPackage = z.infer<typeof insertPackageSchema>;
export type UpdatePackage = z.infer<typeof updatePackageSchema>;
export type PackageBoard = typeof packageBoards.$inferSelect;
export type InsertPackageBoard = z.infer<typeof insertPackageBoardSchema>;
export type PackageGrant = typeof packageGrants.$inferSelect;
export type InsertPackageGrant = z.infer<typeof insertPackageGrantSchema>;

/** Who may do what with a package. Resolved by packageAccess.resolvePackagePermission. */
export type PackagePermission = "none" | "use" | "edit";
/** Package visibility. 'public' additionally requires approvalStatus='approved'. */
export type PackageVisibility = "institute" | "public";
/** Admin review state for PUBLIC listing. Ignored while visibility='institute'. */
export type PackageApprovalStatus = "none" | "pending" | "approved" | "rejected";

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
export type PaddleEvent = typeof paddleEvents.$inferSelect;
export type InsertPaddleEvent = z.infer<typeof insertPaddleEventSchema>;
/** Lifecycle of a row in `paddle_events`. See the table comment. */
export type PaddleEventStatus = "received" | "processed" | "failed" | "ignored";

// API types
export type ApiProvider = typeof apiProviders.$inferSelect;
export type InsertApiProvider = z.infer<typeof insertApiProviderSchema>;
export type ApiProviderPricing = typeof apiProviderPricing.$inferSelect;
export type InsertApiProviderPricing = z.infer<typeof insertApiProviderPricingSchema>;

export type FeatureType = "chat" | "boards" | "customApps" | "interpret" | 'docuslp' | 'overview' | 'students' | 'studentInfo' | 'contacts' | 'institute' | 'progress' | 'reports' | 'settings' | 'aacsettings' | 'aac' | 'symbols' | 'photos' | 'calendar' | 'locations' | 'userchat' | 'call' | 'deepAnalysis' | 'shares' | 'insuranceBridge' | 'videoCaption' | 'downloads' | 'packages';

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
  type: "speak" | "link" | "back" | "home" | "exit" | "open_website" | "open_app" | "open_board" | "run_home_action";
  text?: string;
  toPageId?: string;
  /**
   * For "link" actions on constructed (prebuilt) boards: jump to a DIFFERENT
   * saved board entirely (board-to-board navigation), as opposed to `toPageId`
   * which moves between pages within the same board. Ignored on the AAC dynamic
   * path, which never wires a board-to-board navigation handler.
   */
  toBoardId?: string;
  /** For "open_website" actions: the URL to load in the browser app. Must match a permitted website prefix. */
  url?: string;
  /** For "open_app" actions: the app id (built-in or custom game) to launch. Must be an enabled app. */
  appId?: string;
  /**
   * For "open_app" actions: the free-text argument to open the app WITH — the
   * same string the AI's own `open_app(appId, data)` carries (a picture-search
   * subject, a media query). The client forwards it on the request_app_open
   * round-trip so the server resolves the app's payload before it renders.
   * Without it a Board-Manager launch button can only ever open an app empty,
   * which for a search app means the student's request is silently dropped.
   */
  appData?: string;
  /**
   * For "open_board" actions: the KEY of a pre-built board to load on press
   * (the same key the Board Manager passes to set_board). Distinct
   * from `toBoardId`, which is a stored board ID used for board-to-board links
   * inside the prebuilt browser: the AAC dynamic path asks the SERVER to load
   * the board by key, so the session state (loaded board, prompt context)
   * follows the switch. Gated against the session's available boards.
   */
  boardKey?: string;
  /**
   * For "run_home_action" actions: the id of the student's home action to fire
   * (see HomeAction). `command` is the exact phrase the client speaks aloud
   * through the standard student-voice press pipeline — emitted for `spoken`
   * slots ONLY; `label` is the human/AI-facing name recorded in the session.
   * A home action actuates in place — it never navigates. Gated server-side
   * against the student's ENABLED home actions; unknown ids degrade to a plain
   * speak button.
   *
   * `announce` is the cloud-type counterpart of `command`: the server actuates,
   * so the device instead says this (already defaulted to the label) in the
   * student's voice so the press isn't silent. Exactly one of
   * `command`/`announce` is present.
   *
   * `requiresConfirmation` tells the client to show its dwell-friendly confirm
   * step before firing, and to send `confirmed: true` on the WS press; the
   * server refuses unconfirmed execution of flagged actions.
   */
  actionId?: string;
  command?: string;
  label?: string;
  announce?: string;
  requiresConfirmation?: boolean;
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
 * A clinician-authored smart-home action slot the student can fire from a board.
 *
 * Two families of type, one press flow:
 *  - `spoken` (live today): the AAC utters `command` aloud through the
 *    student-voice pipeline and the family's own smart speaker hears it like
 *    any other voice. Nothing actuates server-side.
 *  - `alexa` / `google` (phase-1 framework, env-gated until the developer
 *    accounts exist): the SERVER fires the slot's virtual-trigger event through
 *    the provider seam in `server/services/smart-home/`. These slots carry no
 *    `command` at all — what the device SAYS on press is `announce`.
 *
 * See planning-docs/smart-home-actions.md. Helpers live in shared/home-actions.ts;
 * deliberately NOT AI-editable.
 */
export interface HomeAction {
  id: string;            // stable slug, unique within the student's list
  label: string;         // human/AI-facing name ("Lights on")
  icon?: string;         // emoji for button visuals
  type: 'spoken' | 'alexa' | 'google';  // which provider actuates this slot
  /**
   * REQUIRED for `spoken`: the exact phrase the AAC device speaks aloud
   * ("Alexa, turn on the lights"). Never paraphrased — a wake-word phrase only
   * works said verbatim. UNUSED by the cloud types, which actuate server-side.
   */
  command?: string;
  /**
   * CLOUD types only: what the device says in the STUDENT'S VOICE when the
   * action fires, so a server-side actuation isn't a silent press. Defaults to
   * `label` when unset. `spoken` actions ignore it — they utter `command`
   * verbatim instead.
   */
  announce?: string;
  description?: string;  // AI-facing hint for when to surface it
  requiresConfirmation?: boolean; // client shows a confirm step; server refuses unconfirmed presses
  enabled?: boolean;     // default true
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
 * A specific YouTube video pinned by the clinician — a curated playlist entry.
 * `videoId` is the 11-character YouTube watch ID. `description` is AI-facing.
 * Shown to the student as a direct-play button in the YouTube browse view,
 * and surfaced to the AI in the prompt so it can request a specific pinned
 * video by id or title via open_app("youtube", data=...).
 */
export interface PermittedYoutubeVideo {
  videoId: string;
  label: string;
  description?: string;
}

/** The kind of YouTube resource a {@link PermittedYoutubeItem} points at. */
export type PermittedYoutubeItemType = "channel" | "playlist" | "video";

/**
 * Unified clinician-curated YouTube entry. A single list holds channels,
 * playlists, and pinned videos; `type` (derived from the pasted URL) tells the
 * three apart. `id` is the resource's canonical identifier — a UC... channelId,
 * a PL.../UU.../etc. playlistId, or an 11-char videoId — interpreted per `type`.
 * `description` is AI-facing.
 *
 * This supersedes the separate `permittedYoutubeChannels` / `permittedYoutubeVideos`
 * arrays (now retained only for backward-compatible reads — see
 * {@link ../shared/youtube-items}).
 */
export interface PermittedYoutubeItem {
  type: PermittedYoutubeItemType;
  id: string;
  label: string;
  description?: string;
}

/**
 * A clinician-defined student gesture the AAC's Observer agent watches for.
 * When the Observer sees the student perform `name` toward the device, the
 * system treats it as a button press voicing `meaning` — the Speaker replies
 * and the Board Manager rebuilds exactly as for a tapped button.
 *
 * `name` is a short identifier ("thumbs up", "hand to mouth"); `description`
 * optionally details the physical motion so the Observer can recognize it;
 * `meaning` is the first-person sentence the gesture communicates
 * ("Yes, I want that", "I'm hungry").
 */
export interface DefinedGesture {
  name: string;
  description?: string;
  meaning: string;
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
  /**
   * Glyph string (see shared/glyph-compositor.ts) representing the entire
   * meaning of this button — e.g. "i_me+want+water". May contain imageKeys
   * in individual slots; those go through the auto-symbol pipeline. When
   * present, the board renderer prefers it over symbolPath/iconRef.
   */
  glyph?: string;
  /**
   * Safe fallback glyph string, used if `glyph` fails to render (e.g.
   * all of its slots require image generation that hasn't completed).
   * MUST be self-contained — only emojis, custom-symbol refs (`symbol:ID`),
   * or face refs (`face:ID`) are valid here; imageKeys are NOT allowed
   * since the fallback exists precisely for when generation isn't ready.
   */
  glyphFallback?: string;
  /**
   * When true, the client replaces this button's label AND its spoken text
   * with the translation of its single-key `glyph` (`aac.glyph.<key>`).
   *
   * Set by SERVER-BUILT boards whose buttons literally ARE registry words —
   * the restaurant floor board is the first. The server has no `t()`, so it
   * bakes English and the client localizes, the same trade guessing-mode
   * suggestion buttons already make.
   *
   * Deliberately opt-IN. Board Manager output must never set it: the BM
   * authors a sentence per utterance ("I want some water" on a `water` glyph),
   * and localizing from the glyph would flatten that to the bare word.
   *
   * Only meaningful when `glyph` is a SINGLE key. A composed fragment
   * (`like.not`) or a multi-slot string (`i_me+want+water`) has no single
   * tKey, and stitching translated parts together produces broken grammar.
   */
  localizeFromGlyph?: boolean;
  /**
   * Survives reading mode. When a board opens with `openInReadingMode`, every
   * button EXCEPT these is inert, so a student can look over a menu without a
   * dwell landing on the first dish they read.
   *
   * Set on the essentials a student must never be locked out of — more,
   * finished, bathroom, and page navigation. Needing the toilet does not wait
   * for a mode to be switched off.
   */
  readingModeSafe?: boolean;
  selfClosing?: boolean;
  /** When true, pressing this button automatically unloads the prebuilt board, giving the AI the full 12-button board */
  exitBoard?: boolean;
  /**
   * Visual style hint: "guess" for guessing-mode final guesses, "category"
   * for narrowing categories, "suggestion" for guessing-mode registry-driven
   * narrowing-assistant buttons, "narrow" for AI-driven open-ended narrowing
   * steps (Phase 2 of open-ended narrowing — the AI proposes its OWN
   * narrowing dimension when the registry doesn't fit the conversation).
   * "wordfinder" / "more" are fixed meta-buttons (the board-embedded twins of
   * the quick-actions Word Finder / More buttons).
   */
  buttonType?: "normal" | "guess" | "category" | "suggestion" | "narrow" | "wordfinder" | "more";
  /**
   * Conversational role of this button: "reply" (an answer/reaction that needs
   * no response) vs "bid" (a question/request that hands the turn over).
   *
   * Drives the per-mode press handling AND the button's fill — a `bid` is
   * painted orange, the third and last colour a board carries after yes-green
   * and no-red. Defaults to "reply".
   */
  role?: "reply" | "bid";
  /**
   * SPEECH ACT — what this button's utterance DOES (affirm / reject / request /
   * ask / express / social / direct / repair / comment). Orthogonal to `role`,
   * which is turn-taking force: "Can I have water?" is a `request` AND a `bid`.
   *
   * Server-stamped from the GLYPH alone via `deriveSpeechAct`. It PAINTS
   * NOTHING — its only rendered effect is the prosody mark already baked into
   * the glyph string (request → the arc, ask → the `?`), so the client needs no
   * special handling. Carried on the button as metadata the Monitor and the
   * session summary can read.
   *
   * Colour comes from the yes/no SYMBOL and from `role` — see
   * `resolveButtonColorToken` for why the palette is only three fills wide.
   *
   * See shared/aac/speech-act.ts. Typed as a string union rather than importing
   * SpeechAct so this schema stays dependency-free for the drizzle side.
   */
  speechAct?:
    | "affirm" | "reject" | "request" | "ask" | "express"
    | "social" | "direct" | "repair" | "comment";
  /**
   * Group-chat addressee: the peer this button is specifically aimed at (a peer
   * name the Board Manager set when building a reply/bid directed at one peer),
   * or "ROOM"/omitted for the whole room. On press the Coordinator resolves the
   * name to that peer's session and routes the utterance accordingly.
   */
  addressee?: string;
  /**
   * For `buttonType: "suggestion"` only — the full `suggestion:<dim>:<value>`
   * key this button represents. The AAC client parses it on press to update
   * the guessing-mode narrowing state (see shared/guessing-mode).
   */
  suggestionKey?: string;
  /**
   * For `buttonType: "wordfinder"` only — where the search should START, as a
   * `suggestion:<dim>:<value>` key (the same grammar the narrowing buttons
   * use). Pressed, it is applied to a fresh engine before the first narrowing
   * board is built, so "I'm afraid of…" opens ON the fear question instead of
   * the generic "what kind of thing are you looking for?" menu.
   *
   * Optional. Without it the button behaves exactly as it always has: the
   * coordinator falls back to the LLM seeder, which infers a category from the
   * AI's last question. With it, that call is skipped — the AI that wrote the
   * button already knew the answer.
   */
  guessingSeed?: string;
  /**
   * For `buttonType: "narrow"` only — the AI-proposed narrowing dimension
   * label (e.g. "genre"). Press handler routes this through
   * `applyCustomFact(state, narrowDimension, narrowValue, speech)`.
   */
  narrowDimension?: string;
  /**
   * For `buttonType: "narrow"` only — the value the user is selecting
   * for the AI-proposed dimension (e.g. "comedy"). Mirrors `label` after
   * the `[NARROW:<dim>]` prefix is stripped.
   */
  narrowValue?: string;
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
  /**
   * Open with activation suppressed on everything except `readingModeSafe`
   * buttons, until the student or caretaker leaves the mode.
   *
   * A dense menu is the case this exists for: opening one with dwell live means
   * the first dish the student's eyes land on gets ordered. Set by the venue
   * menu builder from `VenueMenuSettings.readingModeDefault` (default true).
   */
  openInReadingMode?: boolean;
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
  email?: {
    enabled?: boolean;
    address?: string;
    service?: string;
    username?: string;
    password?: string;
    /**
     * Hard allowlist of recipient addresses the AI is permitted to email.
     * The tool refuses any `to` not in this list. Without this constraint a
     * prompt-injection vulnerability becomes a direct PHI exfiltration sink.
     * Per-address (case-insensitive); use `allowedDomains` for whole-domain.
     */
    allowedRecipients?: string[];
    /** Domain-level allowlist (case-insensitive, no leading "@"). */
    allowedDomains?: string[];
  };
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
// CRM POTENTIAL CUSTOMERS (landing-page chat visitors)
// =============================================================================
// Anonymous landing-page chat visitors. No FK to users — these are unauthenticated
// leads. Identified across visits by ip_hash (sha256(salt + ip)) and a
// localStorage-issued client id (returned at first visit, sent on subsequent
// requests). Customer-supplied details (name, email, organization, role, notes)
// live inside chat_memory under Customer_* keys, written by the AI through the
// memory tool — same pattern as users.chat_memory with User_* keys.
export const crmPotentialCustomers = pgTable("crm_potential_customers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ipHash: text("ip_hash").notNull(),
  countryCode: varchar("country_code", { length: 2 }),
  region: text("region"),
  chatMemory: jsonb("chat_memory").notNull().default({}),
  isBlocked: boolean("is_blocked").notNull().default(false),
  firstSeenAt: timestamp("first_seen_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_crm_potential_customers_ip_hash").on(table.ipHash),
  index("idx_crm_potential_customers_last_seen_at").on(table.lastSeenAt),
  index("idx_crm_potential_customers_is_blocked").on(table.isBlocked),
]);

export const insertCrmPotentialCustomerSchema = createInsertSchema(crmPotentialCustomers).pick({
  ipHash: true,
  countryCode: true,
  region: true,
});

export type CrmPotentialCustomer = typeof crmPotentialCustomers.$inferSelect;
export type InsertCrmPotentialCustomer = z.infer<typeof insertCrmPotentialCustomerSchema>;

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

// Physical locations (GPS points) registered against an institute. Calendar
// events may be assigned one or more locations via calendarEventLocations.
export const locations = pgTable("locations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  instituteId: varchar("institute_id").references(() => institutes.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  address: text("address"),
  latitude: doublePrecision("latitude").notNull(),
  longitude: doublePrecision("longitude").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdByUserId: varchar("created_by_user_id").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_locations_institute_id").on(table.instituteId),
  index("idx_locations_lat_lng").on(table.latitude, table.longitude),
]);

// =============================================================================
// LOCATION MENUS — venues and their menus
// See planning-docs/aac-restaurant-menus.md §4.4.
//
// These two tables are deliberately NON-PHI and live here rather than in
// schema-private: a restaurant and its menu are public facts about the world,
// shared by every student who walks into the place. WHICH student eats where is
// PHI and lives in `student_venues` (schema-private.ts).
//
// The cache is global on purpose — the first person to open a venue's menu pays
// the ~25s extraction, everyone after them gets it instantly.
// =============================================================================

// A real-world place, cached from a POI provider. NOT `locations`: that table is
// institute-scoped (instituteId NOT NULL) and pairs with calendar events, and a
// family's restaurant is neither an institute's nor an event's.
export const venues = pgTable("venues", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Where this record came from, and its id THERE. Together unique, so two
  // students near the same restaurant converge on one row.
  source: text("source").notNull(), // 'osm' | 'brightdata' | 'manual'
  sourceId: text("source_id").notNull(),
  name: text("name").notNull(),
  latitude: doublePrecision("latitude").notNull(),
  longitude: doublePrecision("longitude").notNull(),
  address: text("address"),
  // 'restaurant' | 'cafe' | 'fast_food' now; museum/cinema/clinic in phase 2.
  venueType: text("venue_type"),
  cuisine: text("cuisine"),
  // The place's OWN website, per-place rather than per-brand. Load-bearing for
  // the §3.1a binding check — it is what ties a scraped menu to THIS place.
  websiteUri: text("website_uri"),
  // ISO-3166-1 alpha-2. The other half of the binding check: a `.ca` menu
  // against an `IL` venue is the Aroma defect, and is refused.
  countryCode: text("country_code"),
  // Brand key for chain detection (`tommy-roll`). When several venues share
  // one, a menu bound only by brand is a `chain_fallback` and earns the §4.9
  // disclaimer rather than silent confidence.
  brandKey: text("brand_key"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_venues_source_source_id").on(table.source, table.sourceId),
  // Mirrors idx_locations_lat_lng — the nearby sweep is the hot query.
  index("idx_venues_lat_lng").on(table.latitude, table.longitude),
  index("idx_venues_brand_key").on(table.brandKey),
]);

// A venue's extracted menu. Non-PHI: no student reference of any kind, and
// deliberately NOT MenuSpark's `viewers` array — who read a menu is our
// business to keep out of a shared cache.
export const venueMenus = pgTable("venue_menus", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  venueId: varchar("venue_id").references(() => venues.id, { onDelete: "cascade" }).notNull(),
  // The language the items are actually IN, so an RTL board lays out correctly.
  language: text("language").default("en").notNull(),
  currency: text("currency"),
  // Refined items: [{ name, description?, price?, priceText?, category?, kind,
  // icon?, translatedName? }] — post-applyMenuRefinement (§4.2a), so the
  // factual fields here are always the raw extraction's. `icon` is board glyph
  // syntax (pizza.olive); rows from before 2026-09-02 carry a single-key
  // `imageKey` instead, which the board builder reads as a one-slot glyph.
  items: jsonb("items").default([]).notNull(),
  provenance: text("provenance").notNull(), // 'camera' | 'web' | 'manual'
  sourceUrl: text("source_url"),

  // ── Binding (§3.1a) ──
  // WHY we believe this menu belongs to this venue. NOT NULL by design: a menu
  // row cannot exist without recording its justification, which is what makes
  // the wrong-restaurant defect unrepresentable rather than merely unlikely.
  // 'gps_place_match' | 'place_website' | 'caretaker_confirmed' | 'camera'
  //                   | 'chain_fallback'
  bindingBasis: text("binding_basis").notNull(),
  // The country the check compared against, stored so a later audit can re-run
  // the check over historical rows rather than trusting they were checked.
  bindingCountry: text("binding_country"),
  // 'exact'   — the source names THIS branch
  // 'chain'   — right brand, different/unknown branch (the טומי רול defect)
  // 'unknown' — no branch signal in the source at all
  bindingBranchMatch: text("binding_branch_match").default("unknown").notNull(),

  // ── Review (§4.8) ──
  status: text("status").default("pending_review").notNull(), // 'pending_review' | 'approved' | 'rejected'
  extractedAt: timestamp("extracted_at", { withTimezone: true }).defaultNow().notNull(),
  // Cross-schema FK: users.id lives in schema-private.ts.
  reviewedByUserId: varchar("reviewed_by_user_id"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_venue_menus_venue_id").on(table.venueId),
  // "Newest approved menu for this venue" is the read every session makes.
  index("idx_venue_menus_venue_status").on(table.venueId, table.status),
  // A camera menu is the trust anchor; being able to find one cheaply matters.
  index("idx_venue_menus_provenance").on(table.provenance),
]);

// Join table: a calendar event ⇄ one or more locations.
export const calendarEventLocations = pgTable("calendar_event_locations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  eventId: varchar("event_id").references(() => calendarEvents.id, { onDelete: "cascade" }).notNull(),
  locationId: varchar("location_id").references(() => locations.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_event_locations_event_location").on(table.eventId, table.locationId),
  index("idx_event_locations_event_id").on(table.eventId),
  index("idx_event_locations_location_id").on(table.locationId),
]);

// Venue / venue-menu schemas and types (Location Menus — §4.4)
export const insertVenueSchema = createInsertSchema(venues).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastSeenAt: true,
});

export const insertVenueMenuSchema = createInsertSchema(venueMenus).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  extractedAt: true,
  reviewedByUserId: true, // set by the server on review, never by a caller
  reviewedAt: true,
});

export type Venue = typeof venues.$inferSelect;
export type InsertVenue = z.infer<typeof insertVenueSchema>;
export type VenueMenu = typeof venueMenus.$inferSelect;
export type InsertVenueMenu = z.infer<typeof insertVenueMenuSchema>;

// Location insert/update schemas
export const insertLocationSchema = createInsertSchema(locations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  createdByUserId: true, // set by server
});

export const updateLocationSchema = createInsertSchema(locations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  createdByUserId: true,
  instituteId: true, // a location does not move between institutes
}).partial();

// Location types
export type Location = typeof locations.$inferSelect;
export type InsertLocation = z.infer<typeof insertLocationSchema>;
export type UpdateLocation = z.infer<typeof updateLocationSchema>;
export type CalendarEventLocation = typeof calendarEventLocations.$inferSelect;

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
  locations: many(calendarEventLocations),
}));

export const calendarEventAttendeesRelations = relations(calendarEventAttendees, ({ one }) => ({
  event: one(calendarEvents, {
    fields: [calendarEventAttendees.eventId],
    references: [calendarEvents.id],
  }),
}));

export const venueMenusRelations = relations(venueMenus, ({ one }) => ({
  venue: one(venues, {
    fields: [venueMenus.venueId],
    references: [venues.id],
  }),
}));

export const venuesRelations = relations(venues, ({ many }) => ({
  menus: many(venueMenus),
}));

export const locationsRelations = relations(locations, ({ one, many }) => ({
  institute: one(institutes, {
    fields: [locations.instituteId],
    references: [institutes.id],
  }),
  events: many(calendarEventLocations),
}));

export const calendarEventLocationsRelations = relations(calendarEventLocations, ({ one }) => ({
  event: one(calendarEvents, {
    fields: [calendarEventLocations.eventId],
    references: [calendarEvents.id],
  }),
  location: one(locations, {
    fields: [calendarEventLocations.locationId],
    references: [locations.id],
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

// =============================================================================
// PUBLIC TABLES — Security incident register
// =============================================================================
// NOT to be confused with `incidents` in shared/schema-private.ts, which is the
// per-student clinical/behavioural log. This is the organisation's security and
// privacy breach register: the object that starts and holds the notification
// clock, and the evidence trail behind the report we owe a customer afterwards.
//
// Backs the AKIM information-security appendix §6 ("חריגים ודיווחים"):
// immediate verbal + written notice within 48 hours, and an investigation
// report within 3 days of the event ending. Regulatory windows come from
// shared/regime/regimes.ts (`resolveBreachNotificationHours`) rather than being
// hardcoded, because they differ per regime and the strictest one wins.
//
// Deliberately holds NO subject identifiers: affected people are described by
// count and scope only. Subject identity lives in the private schema, and a
// register row is read by more people than a PHI row should be.
// See docs/AKIM_REMEDIATION_PLAN.md.

export const securityIncidentKindEnum = pgEnum("security_incident_kind", [
  "phi_breach",      // unauthorised access to / disclosure of personal or health data
  "security_breach", // intrusion, malware, availability loss; no confirmed data exposure
  "vendor_incident", // an incident at a sub-processor that reaches data we hold
]);

// Separate from the clinical `incident_severity` enum on purpose: the scales
// mean different things and must be free to diverge.
export const securityIncidentSeverityEnum = pgEnum("security_incident_severity", [
  "low",
  "medium",
  "high",
  "critical",
]);

export const securityIncidentStatusEnum = pgEnum("security_incident_status", [
  "open",       // discovered, being assessed
  "contained",  // no longer ongoing
  "notified",   // required parties told
  "closed",     // investigation report filed, incident concluded
  "dismissed",  // investigated and found not to be an incident
]);

export const securityIncidents = pgTable("security_incidents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Human-readable handle for e-mails and phone calls ("INC-2026-0007").
  // Rendered in code from this ordinal so the reference survives a restore.
  seq: serial("seq").notNull().unique(),

  kind: securityIncidentKindEnum("kind").notNull(),
  severity: securityIncidentSeverityEnum("severity").notNull(),
  status: securityIncidentStatusEnum("status").default("open").notNull(),

  title: text("title").notNull(),
  description: text("description"),

  // --- the clock -----------------------------------------------------------
  // Awareness, not occurrence, is what every notification window runs from.
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }),
  containedAt: timestamp("contained_at", { withTimezone: true }),
  // When the event finished — the annex's 3-day investigation-report window
  // runs from here, not from discovery.
  endedAt: timestamp("ended_at", { withTimezone: true }),

  // Regime slugs in play (shared/regime/regimes.ts). Drives the regulator
  // deadline below; stored so a later regime change cannot silently rewrite
  // the deadline this incident was actually held to.
  regimes: jsonb("regimes").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),

  // Deadlines are computed once, at open time, and stored. The cron reads
  // these columns; it does not re-derive policy.
  regulatorNotifyDueAt: timestamp("regulator_notify_due_at", { withTimezone: true }),
  regulatorNotifiedAt: timestamp("regulator_notified_at", { withTimezone: true }),
  // Contractual window owed to the affected customer (48h under the AKIM
  // appendix). Null when no contract imposes one.
  customerNotifyDueAt: timestamp("customer_notify_due_at", { withTimezone: true }),
  customerNotifiedAt: timestamp("customer_notified_at", { withTimezone: true }),
  investigationReportDueAt: timestamp("investigation_report_due_at", { withTimezone: true }),
  investigationReportSentAt: timestamp("investigation_report_sent_at", { withTimezone: true }),

  // --- scope ---------------------------------------------------------------
  // Which customers are affected. Institute IDs, not people.
  affectedInstituteIds: jsonb("affected_institute_ids").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
  affectedSubjectCount: integer("affected_subject_count"),
  // Prose: what categories of data were involved, how exposure happened.
  affectedScope: text("affected_scope"),

  openedByAdminUserId: varchar("opened_by_admin_user_id").references(() => adminUsers.id),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closureSummary: text("closure_summary"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_security_incidents_status").on(table.status),
  index("idx_security_incidents_discovered_at").on(table.discoveredAt),
  // The deadline sweep's access pattern: open incidents with a due date.
  index("idx_security_incidents_regulator_due").on(table.regulatorNotifyDueAt),
  index("idx_security_incidents_customer_due").on(table.customerNotifyDueAt),
  index("idx_security_incidents_report_due").on(table.investigationReportDueAt),
]);

// Append-only timeline. Every status change, note and notification lands here,
// so the investigation report can be assembled from record rather than memory.
export const securityIncidentEventKindEnum = pgEnum("security_incident_event_kind", [
  "opened",
  "note",
  "status_change",
  "notification_sent",
  "deadline_warning",
  "deadline_missed",
  "closed",
]);

export const securityIncidentEvents = pgTable("security_incident_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  incidentId: varchar("incident_id")
    .references(() => securityIncidents.id, { onDelete: "cascade" })
    .notNull(),
  kind: securityIncidentEventKindEnum("kind").notNull(),
  body: text("body"),
  // Free-shaped detail: recipients of a notification, old/new status, the
  // template that was rendered. Never subject identifiers.
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  // Null when the system wrote the row (cron warnings, automated dispatch).
  actorAdminUserId: varchar("actor_admin_user_id").references(() => adminUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_security_incident_events_incident").on(table.incidentId, table.createdAt),
]);

export type SecurityIncident = typeof securityIncidents.$inferSelect;
export type SecurityIncidentEvent = typeof securityIncidentEvents.$inferSelect;
