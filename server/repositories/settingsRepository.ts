import {
  systemSettings,
  passwordResetTokens,
  subscriptionPlans,
  adminUsers,
  type PasswordResetToken,
  type InsertPasswordResetToken,
  type SubscriptionPlan,
  type InsertSubscriptionPlan,
  type AdminUser,
  type UpsertAdminUser,
} from "@shared/schema";
import {
  SETTING_KEYS,
  USE_CASES,
  type UseCaseKey,
  type LLMConfigValue,
} from "@shared/llm-options";
import {
  LLM_CONFIG_POLICY_FALLBACK,
  assertProviderAllowed,
  isProviderAllowed,
  providerPolicyReason,
} from "@shared/llm-policy";
import { activityLogService } from "../services/activityLogService";
import { db } from "../db";
import { eq, sql, desc } from "drizzle-orm";

/** Why `getLLMConfig` returned what it returned. */
export type LLMConfigSource = "stored" | "absent" | "invalid_json" | "policy";

export interface ResolvedLLMConfig {
  config: LLMConfigValue;
  source: LLMConfigSource;
  /** The stored value that was refused — only set when source === "policy". */
  rejected?: LLMConfigValue;
}

/**
 * Turn the raw `system_settings` value into the config the system will
 * actually use. PURE — exported so the policy fallback (the interesting half)
 * is testable without a database.
 *
 * The allowlist is enforced HERE and not only at write time: a row saved
 * before the check existed, or by a path that skips the admin controller, must
 * not keep routing student data to a provider we have never disclosed as a
 * processor. Falling back to the use-case default degrades the model choice;
 * honouring the row would degrade the transfer posture.
 */
export function resolveStoredLLMConfig(
  useCase: UseCaseKey,
  raw: string | null,
): ResolvedLLMConfig {
  const info = USE_CASES[useCase];
  const fallback: LLMConfigValue = {
    provider: info.defaultProvider,
    model: info.defaultModel,
  };
  if (!raw) return { config: fallback, source: "absent" };

  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return { config: fallback, source: "invalid_json" };
  }
  const candidate = stored as Partial<LLMConfigValue> | null;
  if (!candidate || typeof candidate.provider !== "string" || typeof candidate.model !== "string") {
    return { config: fallback, source: "invalid_json" };
  }
  if (!isProviderAllowed(useCase, candidate.provider as LLMConfigValue["provider"])) {
    return { config: fallback, source: "policy", rejected: candidate as LLMConfigValue };
  }
  return { config: candidate as LLMConfigValue, source: "stored" };
}

export class SettingsRepository {
  // System settings
  async getSetting(key: string, defaultValue?: string): Promise<string | null> {
    try {
      const [setting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, key));

      return setting?.value || defaultValue || null;
    } catch (error) {
      console.error(`Error getting setting ${key}:`, error);
      return defaultValue || null;
    }
  }

  async updateSetting(key: string, value: string): Promise<void> {
    try {
      await db
        .insert(systemSettings)
        .values({ key, value })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value, updatedAt: new Date() },
        });
    } catch (error) {
      console.error(`Error updating setting ${key}:`, error);
      throw error;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // LLM Config Helpers
  // ──────────────────────────────────────────────────────────────────

  async getLLMConfig(useCase: UseCaseKey): Promise<LLMConfigValue> {
    const key = SETTING_KEYS[useCase];
    const raw = await this.getSetting(key);
    const resolved = resolveStoredLLMConfig(useCase, raw);
    switch (resolved.source) {
      case "invalid_json":
        console.warn(`[SettingsRepository] Invalid JSON for ${key}, using default`);
        break;
      case "policy":
        this.warnPolicyFallbackOnce(useCase, resolved.rejected!, resolved.config);
        break;
    }
    return resolved.config;
  }

  /**
   * One warning per use case per process. The marker is stable so a CloudWatch
   * metric filter can alarm on it — a stored config that violates the transfer
   * policy is a finding, not noise, but it would otherwise be emitted on every
   * session start.
   */
  private policyFallbackWarned = new Set<UseCaseKey>();

  private warnPolicyFallbackOnce(
    useCase: UseCaseKey,
    rejected: LLMConfigValue,
    fallback: LLMConfigValue,
  ): void {
    if (this.policyFallbackWarned.has(useCase)) return;
    this.policyFallbackWarned.add(useCase);
    console.warn(
      `${LLM_CONFIG_POLICY_FALLBACK} useCase=${useCase} stored=${rejected.provider}/${rejected.model} ` +
        `falling back to ${fallback.provider}/${fallback.model} — ` +
        (providerPolicyReason(useCase, rejected.provider) ?? ""),
    );
  }

  /**
   * Write a use-case → provider/model routing setting.
   *
   * Two things happen here that did not before: the pairing is checked against
   * the transfer policy (callers that skip the admin controller — a persona
   * override, a script — are covered too), and the change is written to the
   * audit log with both sides of it. Changing where PHI goes is a
   * transfer-destination change; it must be visible after the fact.
   *
   * @param actor id of the acting admin, threaded from the controller.
   */
  async updateLLMConfig(
    useCase: UseCaseKey,
    config: LLMConfigValue,
    actor?: string | null,
  ): Promise<void> {
    assertProviderAllowed(useCase, config.provider);
    const key = SETTING_KEYS[useCase];
    // Read the previous value BEFORE the write so the audit row carries both
    // sides. Uses getLLMConfig so a policy-violating stored row is reported as
    // what the system was actually using.
    const previous = await this.getLLMConfig(useCase);
    await this.updateSetting(key, JSON.stringify(config));
    activityLogService.log({
      userId: actor ?? null,
      eventType: "update",
      subjectType1: "llm_config",
      subjectId1: useCase,
      details: {
        from: { provider: previous.provider, model: previous.model },
        to: { provider: config.provider, model: config.model },
      },
    });
  }

  async getAllLLMConfigs(): Promise<Record<UseCaseKey, LLMConfigValue>> {
    const result = {} as Record<UseCaseKey, LLMConfigValue>;
    const useCases = Object.keys(SETTING_KEYS) as UseCaseKey[];
    for (const uc of useCases) {
      result[uc] = await this.getLLMConfig(uc);
    }
    return result;
  }

  // System prompt operations
  async getSystemPrompt(): Promise<string> {
    return ""; // Temporarily disabled
  }

  async updateSystemPrompt(prompt: string): Promise<void> {
    // Temporarily disabled
  }

  // ──────────────────────────────────────────────────────────────────
  // CRM Landing-Page Chat
  // ──────────────────────────────────────────────────────────────────

  async getCrmChatEnabled(): Promise<boolean> {
    const raw = await this.getSetting("crm_chat_enabled", "false");
    return raw === "true";
  }

  async setCrmChatEnabled(enabled: boolean): Promise<void> {
    await this.updateSetting("crm_chat_enabled", enabled ? "true" : "false");
  }

  /** Returns the admin override if set, otherwise null. Callers fall back to CRM_DEFAULT_SYSTEM_PROMPT. */
  async getCrmChatSystemPromptOverride(): Promise<string | null> {
    return await this.getSetting("crm_chat_system_prompt");
  }

  async setCrmChatSystemPromptOverride(prompt: string | null): Promise<void> {
    // Empty string or null clears the override (falls back to default).
    await this.updateSetting("crm_chat_system_prompt", prompt ?? "");
  }

  // Password reset token operations
  async createPasswordResetToken(
    token: InsertPasswordResetToken
  ): Promise<PasswordResetToken> {
    const [resetToken] = await db
      .insert(passwordResetTokens)
      .values(token)
      .returning();
    return resetToken;
  }

  async getPasswordResetToken(token: string): Promise<PasswordResetToken | undefined> {
    const [resetToken] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, token));
    return resetToken || undefined;
  }

  async markTokenAsUsed(tokenId: string): Promise<void> {
    await db
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(eq(passwordResetTokens.id, tokenId));
  }

  async cleanupExpiredTokens(): Promise<void> {
    const now = new Date();
    await db
      .delete(passwordResetTokens)
      .where(sql`${passwordResetTokens.expiresAt} < ${now}`);
  }

  // Subscription plan operations
  async createSubscriptionPlan(plan: InsertSubscriptionPlan): Promise<SubscriptionPlan> {
    const [subscriptionPlan] = await db
      .insert(subscriptionPlans)
      .values(plan)
      .returning();
    return subscriptionPlan;
  }

  async getAllSubscriptionPlans(): Promise<SubscriptionPlan[]> {
    return await db
      .select()
      .from(subscriptionPlans)
      .orderBy(subscriptionPlans.price);
  }

  /**
   * The plan sold as a given Paddle catalog price. `paddle_price_id` is UNIQUE,
   * so this is at most one row — that uniqueness is what lets a webhook resolve
   * a purchased line item to exactly one plan.
   */
  async getSubscriptionPlanByPaddlePriceId(
    paddlePriceId: string
  ): Promise<SubscriptionPlan | undefined> {
    const [plan] = await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.paddlePriceId, paddlePriceId));
    return plan || undefined;
  }

  async updateSubscriptionPlan(
    id: string,
    updates: Partial<SubscriptionPlan>
  ): Promise<SubscriptionPlan | undefined> {
    const [plan] = await db
      .update(subscriptionPlans)
      .set(updates)
      .where(eq(subscriptionPlans.id, id))
      .returning();
    return plan || undefined;
  }

  // Admin user operations (for Replit Auth)
  async getAdminUser(id: string): Promise<AdminUser | undefined> {
    const [user] = await db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.id, id));
    return user || undefined;
  }

  async upsertAdminUser(userData: UpsertAdminUser): Promise<AdminUser> {
    const [user] = await db
      .insert(adminUsers)
      .values(userData)
      .onConflictDoUpdate({
        target: adminUsers.id,
        set: {
          ...userData,
          updatedAt: new Date(),
        },
      })
      .returning();
    return user;
  }
}

export const settingsRepository = new SettingsRepository();
