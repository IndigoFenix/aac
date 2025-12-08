import { pgTable, text, serial, integer, boolean, timestamp, real, varchar, jsonb, index, numeric, AnyPgColumn, pgEnum, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { sql, relations } from "drizzle-orm";
import { z } from "zod";

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

// AAC User profiles table - now without userId (many-to-many relationship)
// Removed: userId, aacUserId
// Changed: alias -> name, age -> birthDate
export const aacUsers = pgTable("aac_users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(), // Human-readable name (was "alias")
  gender: text("gender"), // 'male', 'female', 'other'
  birthDate: date("birth_date"), // Date of birth (was "age" as integer)
  disabilityOrSyndrome: text("disability_or_syndrome"), // e.g., 'Rett Syndrome', 'Autism', etc.
  backgroundContext: text("background_context"), // Free text background information
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  
  // Chat system fields
  chatMemory: jsonb("chat_memory").default({}), // AAC user-specific memory values for chat
  chatCreditsUsed: real("chat_credits_used").notNull().default(0),
  chatCreditsUpdated: timestamp("chat_credits_updated").defaultNow(),
});

// Junction table for many-to-many relationship between Users and AAC Users
export const userAacUsers = pgTable("user_aac_users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  aacUserId: varchar("aac_user_id").references(() => aacUsers.id).notNull(),
  role: text("role").default("caregiver"), // 'owner', 'caregiver', 'therapist', etc.
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  
  // Chat system fields
  chatMemory: jsonb("chat_memory").default({}), // Relationship-specific memory values for chat
  chatCreditsUsed: real("chat_credits_used").notNull().default(0),
  chatCreditsUpdated: timestamp("chat_credits_updated").defaultNow(),
}, (table) => [
  index("idx_user_aac_users_user_id").on(table.userId),
  index("idx_user_aac_users_aac_user_id").on(table.aacUserId),
]);

// AAC User Schedules table for contextual schedule management
// Changed: aacUserId now references aacUsers.id (the primary key)
export const aacUserSchedules = pgTable("aac_user_schedules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  aacUserId: varchar("aac_user_id").references(() => aacUsers.id).notNull(), // FK to AAC user's primary key
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

// Changed: aacUserId now references aacUsers.id
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
  // AAC User identification fields - now references primary key
  aacUserId: varchar("aac_user_id").references(() => aacUsers.id), // Reference to AAC user's primary key
  aacUserName: text("aac_user_name"), // Human-readable name for the AAC user (was "aacUserAlias")
  // Clinical data fields for SLP reimbursement tracking
  caregiverFeedback: text("caregiver_feedback"), // 'confirmed', 'corrected', 'rejected' or null
  aacUserWPM: real("aac_user_wpm"), // Words/Messages per minute for this session
  scheduleActivity: text("schedule_activity"), // Activity name from schedule at interpretation time
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// System settings table for storing configuration like AI prompts
export const systemSettings = pgTable("system_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Invite codes table for sharing AAC users between users
// Changed: aacUserId now references aacUsers.id
export const inviteCodes = pgTable("invite_codes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull().unique(), // 8-character alphanumeric code
  createdByUserId: varchar("created_by_user_id").references(() => users.id).notNull(),
  aacUserId: varchar("aac_user_id").references(() => aacUsers.id).notNull(), // Now references primary key
  redemptionLimit: integer("redemption_limit").default(1), // How many times this code can be used
  timesRedeemed: integer("times_redeemed").default(0).notNull(),
  expiresAt: timestamp("expires_at"), // Optional expiration
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Invite code redemptions table to track who used which codes
// Changed: aacUserId now references aacUsers.id
export const inviteCodeRedemptions = pgTable("invite_code_redemptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  inviteCodeId: varchar("invite_code_id").references(() => inviteCodes.id).notNull(),
  redeemedByUserId: varchar("redeemed_by_user_id").references(() => users.id).notNull(),
  aacUserId: varchar("aac_user_id").references(() => aacUsers.id).notNull(), // Now references primary key
  redeemedAt: timestamp("redeemed_at").defaultNow().notNull(),
});

// API providers table for tracking different AI service providers and their pricing
export const apiProviders = pgTable("api_providers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(),
  key: text("key").notNull(),
  currencyCode: text("currency_code").default("USD").notNull(),
  pricingJson: jsonb("pricing_json").notNull(), // Stores pricing rules per unit or token
  isActive: boolean("is_active").default(true).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const apiTypeEnum = pgEnum("api_type", [
  "llm", "tts", "stt", "embedding", "image", "vector", "moderation", "tool", "other"
]);

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
  promptId: varchar("prompt_id").references(() => promptHistory.id, { onDelete: "cascade" }),
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

// Insert schemas
export const insertUserSchema = createInsertSchema(users).pick({
  email: true,
  firstName: true,
  lastName: true,
  password: true,
  userType: true,
  createdAt: true,
  updatedAt: true
});

export const insertSavedLocationSchema = createInsertSchema(savedLocations).omit({
  id: true,
  createdAt: true,
});

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

export const insertAdminUserSchema = createInsertSchema(adminUsers);

export const insertInterpretationSchema = createInsertSchema(interpretations).omit({
  id: true,
  createdAt: true,
});

export const insertCreditTransactionSchema = createInsertSchema(creditTransactions).omit({
  id: true,
  createdAt: true,
});

export const insertSubscriptionPlanSchema = createInsertSchema(subscriptionPlans).omit({
  id: true,
  createdAt: true,
});

// RevenueCat insert schemas
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

// AAC User schemas - updated for new structure
export const insertAacUserSchema = createInsertSchema(aacUsers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateAacUserSchema = createInsertSchema(aacUsers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// User-AAC User link schemas
export const insertUserAacUserSchema = createInsertSchema(userAacUsers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateUserAacUserSchema = createInsertSchema(userAacUsers).omit({
  id: true,
  userId: true,
  aacUserId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// AAC User Schedule schemas
export const insertAacUserScheduleSchema = createInsertSchema(aacUserSchedules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateAacUserScheduleSchema = createInsertSchema(aacUserSchedules).omit({
  id: true,
  aacUserId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

// Request schemas
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

export const insertInviteCodeSchema = createInsertSchema(inviteCodes).omit({
  id: true,
  code: true, // Auto-generated
  timesRedeemed: true,
  createdAt: true,
});

export const redeemInviteCodeSchema = z.object({
  code: z.string().min(8, "Invalid invite code").max(8, "Invalid invite code"),
});

export const insertCreditPackageSchema = createInsertSchema(creditPackages).omit({
  id: true,
  createdAt: true,
});

export const insertApiProviderSchema = createInsertSchema(apiProviders).omit({
  id: true,
  updatedAt: true,
});

export const insertApiCallSchema = createInsertSchema(apiCalls).omit({
  id: true,
  createdAt: true,
});

// Pricing JSON validation schemas
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

// User type constants
export const USER_TYPES = {
  ADMIN: "admin",
  TEACHER: "Teacher", 
  CAREGIVER: "Caregiver",
  SPEECH_THERAPIST: "SLP",
  PARENT: "Parent"
} as const;

export type UserType = typeof USER_TYPES[keyof typeof USER_TYPES];

// Type exports
export type UpsertAdminUser = typeof adminUsers.$inferInsert;
export type AdminUser = typeof adminUsers.$inferSelect;
export type InsertInterpretation = z.infer<typeof insertInterpretationSchema>;
export type Interpretation = typeof interpretations.$inferSelect;
export type InterpretRequest = z.infer<typeof interpretRequestSchema>;
export type CreditTransaction = typeof creditTransactions.$inferSelect;
export type InsertCreditTransaction = z.infer<typeof insertCreditTransactionSchema>;
export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;
export type InsertSubscriptionPlan = z.infer<typeof insertSubscriptionPlanSchema>;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type InsertPasswordResetToken = typeof passwordResetTokens.$inferInsert;

// AAC User types - updated
export type AacUser = typeof aacUsers.$inferSelect;
export type InsertAacUser = z.infer<typeof insertAacUserSchema>;
export type UpdateAacUser = z.infer<typeof updateAacUserSchema>;

// User-AAC User link types
export type UserAacUser = typeof userAacUsers.$inferSelect;
export type InsertUserAacUser = z.infer<typeof insertUserAacUserSchema>;
export type UpdateUserAacUser = z.infer<typeof updateUserAacUserSchema>;

export type InviteCode = typeof inviteCodes.$inferSelect;
export type InsertInviteCode = z.infer<typeof insertInviteCodeSchema>;
export type InviteCodeRedemption = typeof inviteCodeRedemptions.$inferSelect;
export type RedeemInviteCode = z.infer<typeof redeemInviteCodeSchema>;
export type CreditPackage = typeof creditPackages.$inferSelect;
export type InsertCreditPackage = z.infer<typeof insertCreditPackageSchema>;
export type ApiProvider = typeof apiProviders.$inferSelect;
export type InsertApiProvider = z.infer<typeof insertApiProviderSchema>;
export type SavedLocation = typeof savedLocations.$inferSelect;
export type InsertSavedLocation = z.infer<typeof insertSavedLocationSchema>;
export type AacUserSchedule = typeof aacUserSchedules.$inferSelect;
export type InsertAacUserSchedule = z.infer<typeof insertAacUserScheduleSchema>;
export type UpdateAacUserSchedule = z.infer<typeof updateAacUserScheduleSchema>;

// RevenueCat type exports
export type RevenuecatSubscription = typeof revenuecatSubscriptions.$inferSelect;
export type InsertRevenuecatSubscription = z.infer<typeof insertRevenuecatSubscriptionSchema>;
export type RevenuecatWebhookEvent = typeof revenuecatWebhookEvents.$inferSelect;
export type InsertRevenuecatWebhookEvent = z.infer<typeof insertRevenuecatWebhookEventSchema>;
export type RevenuecatProduct = typeof revenuecatProducts.$inferSelect;
export type InsertRevenuecatProduct = z.infer<typeof insertRevenuecatProductSchema>;


export const plans = pgTable("plans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  code: varchar("code").notNull().unique(),
  name: text("name").notNull(),
  monthlyGenerations: integer("monthly_generations").notNull(),
  monthlyDownloads: integer("monthly_downloads").notNull(),
  storedBoards: integer("stored_boards").notNull(),
  features: jsonb("features").default("{}"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow()
});

export const usageWindows = pgTable("usage_windows", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  windowStart: timestamp("window_start").notNull(),
  generations: integer("generations").default(0),
  downloads: integer("downloads").default(0),
  storedBoards: integer("stored_boards").default(0),
  createdAt: timestamp("created_at").defaultNow()
});

export const boards = pgTable("boards", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  name: text("name").notNull(),
  irData: jsonb("ir_data").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow()
});

export const promptHistory = pgTable("prompt_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  prompt: text("prompt").notNull(),
  promptExcerpt: text("prompt_excerpt"), // First 100 chars for privacy
  topic: text("topic"), // Auto-detected topic
  language: text("language").default("en"), // Detected language
  model: text("model").default("gemini-2.5-flash"), // AI model used
  outputFormat: text("output_format").default("gridset"), // gridset or snappkg
  generatedBoardName: text("generated_board_name"),
  generatedBoardId: varchar("generated_board_id"),
  pagesGenerated: integer("pages_generated").default(1),
  promptLength: integer("prompt_length"),
  success: boolean("success").notNull().default(true),
  errorMessage: text("error_message"),
  errorType: text("error_type"), // categorized error types
  processingTimeMs: integer("processing_time_ms"),
  downloaded: boolean("downloaded").default(false),
  downloadedAt: timestamp("downloaded_at"),
  userFeedback: text("user_feedback"), // positive, negative, neutral
  createdAt: timestamp("created_at").defaultNow()
});

export const promptEvents = pgTable("prompt_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  promptId: varchar("prompt_id").notNull(),
  userId: varchar("user_id").notNull(),
  eventType: text("event_type").notNull(), // prompt_created, board_generated, board_page_created, board_downloaded, error_occurred, user_feedback_submitted
  eventData: jsonb("event_data"), // Additional event-specific data
  createdAt: timestamp("created_at").defaultNow()
});

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

// System Prompt for AI Behavior Configuration
export const systemPrompt = pgTable("system_prompt", {
  id: varchar("id").primaryKey().default("system_prompt"), // Single row with fixed ID
  prompt: text("prompt").notNull().default(""),
  updatedAt: timestamp("updated_at").defaultNow(),
  updatedBy: varchar("updated_by").references(() => users.id)
});

// Dropbox Integration Tables
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

// ============================================================================
// CHAT SYSTEM TABLES (migrated from Sequelize)
// ============================================================================

// Enums for chat sessions
export const chatSessionStatusEnum = pgEnum("chat_session_status", ["open", "paused", "closed"]);

// Chat mode enum for different chat behaviors
// export const chatModeEnum = pgEnum("chat_mode", ["chat", "boards", "interpret", "docuslp"]);

// Chat Sessions table (named chatSessions to avoid conflict with admin sessions)
export const chatSessions = pgTable("chat_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // User context - at least one must be provided
  userId: varchar("user_id").references(() => users.id),
  aacUserId: varchar("aac_user_id").references(() => aacUsers.id),
  userAacUserId: varchar("user_aac_user_id").references(() => userAacUsers.id), // The relationship record if both are provided
  
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
  index("idx_chat_sessions_aac_user_id").on(table.aacUserId),
  index("idx_chat_sessions_status").on(table.status),
]);

// Chat Insert Schemas
export const insertChatSessionSchema = createInsertSchema(chatSessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
});

// Chat Types
export type ChatSession = typeof chatSessions.$inferSelect;
export type InsertChatSession = z.infer<typeof insertChatSessionSchema>;

// Chat Mode type
export type ChatMode = "chat" | "boards" | "interpret" | 'docuslp';

// ============================================================================
// CHAT SYSTEM INTERFACES (for use in chat-handler.ts)
// ============================================================================

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
  
export interface MessageResponse {
    memoryValues?: any;
    chatState?: ChatState;
    creditsUsed?: number;
    message: ChatMessage;
    sessionId?: string;
}

/** ===== Types kept compatible with your memory system ===== */

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

// Relations
export const usersRelations = relations(users, ({ many, one }) => ({
  boards: many(boards),
  usageWindows: many(usageWindows),
  promptHistory: many(promptHistory),
  sessions: many(userSessions),
  events: many(userEvents),
  planChanges: many(planChanges),
  dropboxConnection: one(dropboxConnections),
  dropboxBackups: many(dropboxBackups),
  apiCalls: many(apiCalls),
  aacUserLinks: many(userAacUsers), // Many-to-many link to AAC users
}));

export const aacUsersRelations = relations(aacUsers, ({ many }) => ({
  userLinks: many(userAacUsers), // Many-to-many link to users
  schedules: many(aacUserSchedules),
  interpretations: many(interpretations),
  inviteCodes: many(inviteCodes),
}));

export const userAacUsersRelations = relations(userAacUsers, ({ one }) => ({
  user: one(users, {
    fields: [userAacUsers.userId],
    references: [users.id]
  }),
  aacUser: one(aacUsers, {
    fields: [userAacUsers.aacUserId],
    references: [aacUsers.id]
  }),
}));

export const aacUserSchedulesRelations = relations(aacUserSchedules, ({ one }) => ({
  aacUser: one(aacUsers, {
    fields: [aacUserSchedules.aacUserId],
    references: [aacUsers.id]
  }),
}));

export const interpretationsRelations = relations(interpretations, ({ one }) => ({
  user: one(users, {
    fields: [interpretations.userId],
    references: [users.id]
  }),
  aacUser: one(aacUsers, {
    fields: [interpretations.aacUserId],
    references: [aacUsers.id]
  }),
}));

export const inviteCodesRelations = relations(inviteCodes, ({ one, many }) => ({
  createdBy: one(users, {
    fields: [inviteCodes.createdByUserId],
    references: [users.id]
  }),
  aacUser: one(aacUsers, {
    fields: [inviteCodes.aacUserId],
    references: [aacUsers.id]
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
  aacUser: one(aacUsers, {
    fields: [inviteCodeRedemptions.aacUserId],
    references: [aacUsers.id]
  }),
}));

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

export const systemPromptRelations = relations(systemPrompt, ({ one }) => ({
  updatedByUser: one(users, {
    fields: [systemPrompt.updatedBy],
    references: [users.id]
  })
}));

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

export const boardsRelations = relations(boards, ({ one }) => ({
  user: one(users, {
    fields: [boards.userId],
    references: [users.id]
  })
}));

export const usageWindowsRelations = relations(usageWindows, ({ one }) => ({
  user: one(users, {
    fields: [usageWindows.userId],
    references: [users.id]
  })
}));

export const promptHistoryRelations = relations(promptHistory, ({ one, many }) => ({
  user: one(users, {
    fields: [promptHistory.userId],
    references: [users.id]
  }),
  board: one(boards, {
    fields: [promptHistory.generatedBoardId],
    references: [boards.id]
  }),
  events: many(promptEvents),
  apiCalls: many(apiCalls)
}));

export const apiCallsRelations = relations(apiCalls, ({ one }) => ({
  user: one(users, {
    fields: [apiCalls.userId],
    references: [users.id]
  }),
  prompt: one(promptHistory, {
    fields: [apiCalls.promptId],
    references: [promptHistory.id]
  })
}));

export const promptEventsRelations = relations(promptEvents, ({ one }) => ({
  prompt: one(promptHistory, {
    fields: [promptEvents.promptId],
    references: [promptHistory.id]
  }),
  user: one(users, {
    fields: [promptEvents.userId],
    references: [users.id]
  })
}));

// Chat System Relations
export const chatSessionsRelations = relations(chatSessions, ({ one }) => ({
  user: one(users, {
    fields: [chatSessions.userId],
    references: [users.id]
  }),
  aacUser: one(aacUsers, {
    fields: [chatSessions.aacUserId],
    references: [aacUsers.id]
  }),
  userAacUser: one(userAacUsers, {
    fields: [chatSessions.userAacUserId],
    references: [userAacUsers.id]
  }),
}));


// Insert schemas
export const insertPlanSchema = createInsertSchema(plans).omit({
  id: true,
  createdAt: true,
  updatedAt: true
});

export const insertBoardSchema = createInsertSchema(boards).omit({
  id: true,
  createdAt: true,
  updatedAt: true
});

export const insertUsageWindowSchema = createInsertSchema(usageWindows).omit({
  id: true,
  createdAt: true
});

export const insertPromptHistorySchema = createInsertSchema(promptHistory).omit({
  id: true,
  createdAt: true
});

export const insertPromptEventSchema = createInsertSchema(promptEvents).omit({
  id: true,
  createdAt: true
});

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

export const insertSystemPromptSchema = createInsertSchema(systemPrompt).omit({
  id: true,
  updatedAt: true
});

export const insertDropboxConnectionSchema = createInsertSchema(dropboxConnections).omit({
  id: true,
  createdAt: true,
  updatedAt: true
});

export const insertDropboxBackupSchema = createInsertSchema(dropboxBackups).omit({
  id: true,
  createdAt: true,
  completedAt: true
});

export const insertApiProviderPricingSchema = createInsertSchema(apiProviderPricing).omit({
  id: true,
  createdAt: true,
  updatedAt: true
});

// Types
export type Plan = typeof plans.$inferSelect;
export type InsertPlan = z.infer<typeof insertPlanSchema>;

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export type Board = typeof boards.$inferSelect;
export type InsertBoard = z.infer<typeof insertBoardSchema>;

export type UsageWindow = typeof usageWindows.$inferSelect;
export type InsertUsageWindow = z.infer<typeof insertUsageWindowSchema>;

export type PromptHistory = typeof promptHistory.$inferSelect;
export type InsertPromptHistory = z.infer<typeof insertPromptHistorySchema>;

export type PromptEvent = typeof promptEvents.$inferSelect;
export type InsertPromptEvent = z.infer<typeof insertPromptEventSchema>;

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

export type SystemPrompt = typeof systemPrompt.$inferSelect;
export type InsertSystemPrompt = z.infer<typeof insertSystemPromptSchema>;

export type DropboxConnection = typeof dropboxConnections.$inferSelect;
export type InsertDropboxConnection = z.infer<typeof insertDropboxConnectionSchema>;

export type DropboxBackup = typeof dropboxBackups.$inferSelect;
export type InsertDropboxBackup = z.infer<typeof insertDropboxBackupSchema>;

export type ApiCall = typeof apiCalls.$inferSelect;
export type InsertApiCall = z.infer<typeof insertApiCallSchema>;

export type ApiProviderPricing = typeof apiProviderPricing.$inferSelect;
export type InsertApiProviderPricing = z.infer<typeof insertApiProviderPricingSchema>;