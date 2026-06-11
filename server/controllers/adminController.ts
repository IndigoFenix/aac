import type { Request, Response } from "express";
import { adminService, userService, creditService } from "../services";
import { mfaService } from "../services/mfaService";
import { activityLogService } from "../services/activityLogService";
import { userRepository, interpretationRepository, settingsRepository, instituteRepository, crmRepository } from "../repositories";
import { chatRepository } from "../repositories/chatRepository";
import { insertApiProviderSchemaWithValidation } from "@shared/schema";
import { MODEL_OPTIONS, USE_CASES, type UseCaseKey, type LLMConfigValue } from "@shared/llm-options";
import { CRM_DEFAULT_SYSTEM_PROMPT } from "../services/crmChat/prompts";
import type { CrmPotentialCustomer } from "@shared/schema";

/**
 * Flatten a CRM customer for the admin UI: surface the Customer_* memory
 * fields as top-level properties so the page doesn't need to know about the
 * memory key prefix. The raw memory blob is also returned for completeness
 * (admins occasionally want to see the unstructured notes array etc.).
 */
function serializeCrmCustomer(c: CrmPotentialCustomer) {
  const memory = (c.chatMemory as Record<string, any>) ?? {};
  return {
    id: c.id,
    countryCode: c.countryCode,
    region: c.region,
    isBlocked: c.isBlocked,
    firstSeenAt: c.firstSeenAt,
    lastSeenAt: c.lastSeenAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    firstName: memory.Customer_FirstName ?? null,
    lastName: memory.Customer_LastName ?? null,
    email: memory.Customer_Email ?? null,
    organization: memory.Customer_Organization ?? null,
    role: memory.Customer_Role ?? null,
    scratchpad: typeof memory.Customer_Scratchpad === "string" ? memory.Customer_Scratchpad : null,
    memory,
  };
}

export class AdminController {
  // Dashboard
  async getStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = await adminService.getDashboardStats();
      res.json(stats);
    } catch (error: any) {
      console.error("Error fetching stats:", error);
      res.status(500).json({ message: "Failed to fetch statistics" });
    }
  }

  // User management
  async getUsers(req: Request, res: Response): Promise<void> {
    try {
      const users = await adminService.getAllUsersWithStudents();
      res.json({ users });
    } catch (error: any) {
      console.error("Error fetching users:", error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  }

  async getUser(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.params.id;
      const user = await userService.getUser(userId);

      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }

      res.json({ user });
    } catch (error: any) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  }

  async updateUser(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id;
      const updates = req.body;

      const updatedUser = await adminService.updateUserAdmin(id, updates);

      if (!updatedUser) {
        res.status(404).json({ message: "User not found" });
        return;
      }

      res.json({ success: true, user: updatedUser });
      activityLogService.log({
        userId: (req as any).user?.id,
        eventType: "update",
        subjectType1: "user",
        subjectId1: req.params.id,
      });
    } catch (error: any) {
      console.error("Error updating user:", error);
      if (error.message === "Invalid user type") {
        res.status(400).json({ message: error.message });
        return;
      }
      res.status(500).json({ message: "Failed to update user" });
    }
  }

  async deleteUser(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.params.id;

      const user = await userService.getUser(userId);
      if (!user) {
        res.status(404).json({
          success: false,
          message: "User not found",
        });
        return;
      }

      const deleted = await userService.deleteUser(userId);

      if (deleted) {
        console.log(`User deleted: ${user.email} (ID: ${userId})`);
        res.json({
          success: true,
          message: "User deleted successfully",
        });
        activityLogService.log({
          userId: (req as any).user?.id,
          eventType: "delete",
          subjectType1: "user",
          subjectId1: userId,
          details: { email: user.email },
        });
      } else {
        res.status(500).json({
          success: false,
          message: "Failed to delete user",
        });
      }
    } catch (error: any) {
      console.error("Error deleting user:", error);
      res.status(500).json({
        success: false,
        message: "Failed to delete user",
      });
    }
  }

  // Credits management
  async updateCredits(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.params.id;
      const { amount, type, description, operation = "add" } = req.body;

      if (!amount || !description) {
        res
          .status(400)
          .json({ message: "Amount and description are required" });
        return;
      }

      if (operation === "set") {
        await creditService.setUserCredits(userId, amount, description);
      } else {
        if (!type) {
          res.status(400).json({ message: "Type is required for add operation" });
          return;
        }
        await creditService.addCredits(userId, amount, type, description);
      }

      res.json({ message: "Credits updated successfully" });
    } catch (error: any) {
      console.error("Error updating credits:", error);
      res.status(500).json({ message: "Failed to update credits" });
    }
  }

  async getUserTransactions(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.params.id;
      const transactions = await creditService.getUserCreditTransactions(userId);
      res.json({ transactions });
    } catch (error: any) {
      console.error("Error fetching transactions:", error);
      res.status(500).json({ message: "Failed to fetch transactions" });
    }
  }

  // System prompt
  async getSystemPrompt(req: Request, res: Response): Promise<void> {
    try {
      console.log("Admin prompt endpoint called - attempting to fetch system prompt");
      const prompt = await adminService.getSystemPrompt();
      console.log("System prompt retrieved successfully, length:", prompt.length);
      res.json({ success: true, prompt });
    } catch (error: any) {
      console.error("Error fetching system prompt:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch system prompt",
        error: error.message,
      });
    }
  }

  async updateSystemPrompt(req: Request, res: Response): Promise<void> {
    try {
      console.log("Admin prompt update endpoint called");
      const { prompt } = req.body;
      if (!prompt || typeof prompt !== "string") {
        res
          .status(400)
          .json({ success: false, message: "Invalid prompt data" });
        return;
      }

      console.log("Attempting to update system prompt, length:", prompt.length);
      await adminService.updateSystemPrompt(prompt);
      console.log("System prompt update completed successfully");
      res.json({
        success: true,
        message: "System prompt updated successfully",
      });
    } catch (error: any) {
      console.error("Error updating system prompt:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update system prompt",
        error: error.message,
      });
    }
  }

  // Settings
  async getSetting(req: Request, res: Response): Promise<void> {
    try {
      const { key } = req.params;
      console.log(`Admin settings GET endpoint called for key: ${key}`);

      const value = await adminService.getSetting(key, "50");
      console.log(`Setting ${key} retrieved:`, value);

      res.json({ success: true, value });
    } catch (error: any) {
      console.error(`Error fetching setting ${req.params.key}:`, error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch setting",
        error: error.message,
      });
    }
  }

  async updateSetting(req: Request, res: Response): Promise<void> {
    try {
      const { key } = req.params;
      const { value } = req.body;

      console.log(`Admin settings PUT endpoint called for key: ${key}, value: ${value}`);

      if (value === undefined || value === null) {
        res.status(400).json({
          success: false,
          message: "Value is required",
        });
        return;
      }

      await adminService.updateSetting(key, value.toString());
      console.log(`Setting ${key} updated successfully`);

      res.json({
        success: true,
        message: "Setting updated successfully",
      });
    } catch (error: any) {
      console.error(`Error updating setting ${req.params.key}:`, error);
      res.status(500).json({
        success: false,
        message: "Failed to update setting",
        error: error.message,
      });
    }
  }

  // Subscription plans
  async getSubscriptionPlans(req: Request, res: Response): Promise<void> {
    try {
      const plans = await adminService.getAllSubscriptionPlans();
      res.json({ plans });
    } catch (error: any) {
      console.error("Error fetching subscription plans:", error);
      res.status(500).json({ message: "Failed to fetch subscription plans" });
    }
  }

  // Interpretations
  async getInterpretations(req: Request, res: Response): Promise<void> {
    try {
      const limit = req.query.limit
        ? parseInt(req.query.limit as string)
        : undefined;
      const interpretations = await adminService.getAllInterpretationsWithUsers(limit);
      res.json({ success: true, interpretations });
    } catch (error: any) {
      console.error("Admin interpretations fetch error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch interpretations",
      });
    }
  }

  async getInterpretation(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id;
      const interpretation = await interpretationRepository.getInterpretation(id);

      if (!interpretation) {
        res.status(404).json({
          success: false,
          message: "Interpretation not found",
        });
        return;
      }

      res.json({ success: true, interpretation });
    } catch (error: any) {
      console.error("Admin interpretation fetch error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch interpretation",
      });
    }
  }

  // API providers
  async getApiProviders(req: Request, res: Response): Promise<void> {
    try {
      console.log("Admin API api-providers: Starting request");
      const providers = await adminService.getApiProviders();
      console.log("Admin API api-providers: Got providers, sending response");
      res.json({ success: true, providers });
    } catch (error: any) {
      console.error("Error fetching API providers:", error);
      res.status(500).json({ message: "Failed to fetch API providers" });
    }
  }

  async createApiProvider(req: Request, res: Response): Promise<void> {
    try {
      const validatedData = insertApiProviderSchemaWithValidation.parse(req.body);
      const provider = await adminService.createApiProvider(validatedData);
      res.json({ success: true, provider });
    } catch (error: any) {
      console.error("Error creating API provider:", error);
      if (
        error instanceof Error &&
        (error.name === "ZodError" || error.message.includes("validation"))
      ) {
        res
          .status(400)
          .json({ message: "Invalid provider data: " + error.message });
      } else {
        res.status(500).json({ message: "Failed to create API provider" });
      }
    }
  }

  async updateApiProvider(req: Request, res: Response): Promise<void> {
    try {
      const providerId = req.params.id;

      const partialSchema = insertApiProviderSchemaWithValidation.partial();
      const validatedData = partialSchema.parse(req.body);

      const provider = await adminService.updateApiProvider(
        providerId,
        validatedData
      );

      if (!provider) {
        res.status(404).json({ message: "API provider not found" });
        return;
      }

      res.json({ success: true, provider });
    } catch (error: any) {
      console.error("Error updating API provider:", error);
      if (
        error instanceof Error &&
        (error.name === "ZodError" || error.message.includes("validation"))
      ) {
        res
          .status(400)
          .json({ message: "Invalid provider data: " + error.message });
      } else {
        res.status(500).json({ message: "Failed to update API provider" });
      }
    }
  }

  // Current admin user
  async getCurrentAdmin(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      res.json({
        success: true,
        admin: true,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          fullName: user.fullName,
          userType: user.userType,
          isAdmin: user.isAdmin,
        },
      });
    } catch (error: any) {
      console.error("Error fetching admin user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  }

  // LLM Config
  async getLLMConfigs(req: Request, res: Response): Promise<void> {
    try {
      const configs = await settingsRepository.getAllLLMConfigs();
      res.json({
        success: true,
        configs,
        useCases: USE_CASES,
        modelOptions: MODEL_OPTIONS,
      });
    } catch (error: any) {
      console.error("Error fetching LLM configs:", error);
      res.status(500).json({ success: false, message: "Failed to fetch LLM configs" });
    }
  }

  async updateLLMConfigs(req: Request, res: Response): Promise<void> {
    try {
      const { configs } = req.body as { configs: Record<string, LLMConfigValue> };

      if (!configs || typeof configs !== "object") {
        res.status(400).json({ success: false, message: "configs object is required" });
        return;
      }

      const validUseCases = Object.keys(USE_CASES) as UseCaseKey[];

      for (const [useCase, config] of Object.entries(configs)) {
        if (!validUseCases.includes(useCase as UseCaseKey)) {
          res.status(400).json({ success: false, message: `Invalid use case: ${useCase}` });
          return;
        }

        // Validate model exists in catalog
        const modelOption = MODEL_OPTIONS.find(
          (m) => m.provider === config.provider && m.modelId === config.model
        );
        if (!modelOption) {
          res.status(400).json({
            success: false,
            message: `Invalid model ${config.model} for provider ${config.provider}`,
          });
          return;
        }

        // Validate live requirement
        const useCaseInfo = USE_CASES[useCase as UseCaseKey];
        if (useCaseInfo?.requiresLive && !modelOption.supportsLive) {
          res.status(400).json({
            success: false,
            message: `${useCaseInfo.label} requires a Live/Realtime model. ${modelOption.displayName} does not support live sessions.`,
          });
          return;
        }

        await settingsRepository.updateLLMConfig(useCase as UseCaseKey, config);
      }

      const updated = await settingsRepository.getAllLLMConfigs();
      res.json({ success: true, configs: updated });
    } catch (error: any) {
      console.error("Error updating LLM configs:", error);
      res.status(500).json({ success: false, message: "Failed to update LLM configs" });
    }
  }

  // CRM landing-page chat settings
  async getCrmChatSettings(req: Request, res: Response): Promise<void> {
    try {
      const [enabled, override] = await Promise.all([
        settingsRepository.getCrmChatEnabled(),
        settingsRepository.getCrmChatSystemPromptOverride(),
      ]);
      res.json({
        success: true,
        enabled,
        // The textarea shows the active prompt. Empty override → default.
        systemPrompt: override && override.length > 0 ? override : CRM_DEFAULT_SYSTEM_PROMPT,
        usingDefault: !override || override.length === 0,
        defaultSystemPrompt: CRM_DEFAULT_SYSTEM_PROMPT,
      });
    } catch (error: any) {
      console.error("Error fetching CRM chat settings:", error);
      res.status(500).json({ success: false, message: "Failed to fetch CRM chat settings" });
    }
  }

  async updateCrmChatSettings(req: Request, res: Response): Promise<void> {
    try {
      const { enabled, systemPrompt, useDefault } = req.body as {
        enabled?: boolean;
        systemPrompt?: string;
        useDefault?: boolean;
      };

      if (typeof enabled === "boolean") {
        await settingsRepository.setCrmChatEnabled(enabled);
      }

      if (useDefault === true) {
        await settingsRepository.setCrmChatSystemPromptOverride(null);
      } else if (typeof systemPrompt === "string") {
        // Empty string also resets to default — matches the existing settings convention.
        await settingsRepository.setCrmChatSystemPromptOverride(
          systemPrompt.trim().length === 0 ? null : systemPrompt
        );
      }

      const [nowEnabled, override] = await Promise.all([
        settingsRepository.getCrmChatEnabled(),
        settingsRepository.getCrmChatSystemPromptOverride(),
      ]);
      res.json({
        success: true,
        enabled: nowEnabled,
        systemPrompt: override && override.length > 0 ? override : CRM_DEFAULT_SYSTEM_PROMPT,
        usingDefault: !override || override.length === 0,
        defaultSystemPrompt: CRM_DEFAULT_SYSTEM_PROMPT,
      });
    } catch (error: any) {
      console.error("Error updating CRM chat settings:", error);
      res.status(500).json({ success: false, message: "Failed to update CRM chat settings" });
    }
  }

  // CRM customer admin — list / detail / update / delete
  async listCrmCustomers(req: Request, res: Response): Promise<void> {
    try {
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "")) || 25, 1), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? "")) || 0, 0);
      const country = typeof req.query.country === "string" && req.query.country.length > 0
        ? req.query.country
        : undefined;
      const search = typeof req.query.search === "string" && req.query.search.length > 0
        ? req.query.search
        : undefined;
      let blocked: boolean | undefined;
      if (req.query.blocked === "true") blocked = true;
      else if (req.query.blocked === "false") blocked = false;

      const opts = { limit, offset, country, blocked, search };
      const [customers, total] = await Promise.all([
        crmRepository.listCustomersAdmin(opts),
        crmRepository.listCustomersAdminCount({ country, blocked, search }),
      ]);

      res.json({
        success: true,
        data: customers.map(serializeCrmCustomer),
        pagination: { total, limit, offset, hasMore: offset + limit < total },
      });
    } catch (error: any) {
      console.error("Error listing CRM customers:", error);
      res.status(500).json({ success: false, message: "Failed to list CRM customers" });
    }
  }

  async getCrmCustomer(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const customer = await crmRepository.getCustomerById(id);
      if (!customer) {
        res.status(404).json({ success: false, message: "Customer not found" });
        return;
      }
      const sessions = await crmRepository.listSessionsForCustomer(id);
      res.json({
        success: true,
        customer: serializeCrmCustomer(customer),
        sessions: sessions.map((s) => ({
          id: s.id,
          status: s.status,
          started: s.started,
          lastUpdate: s.lastUpdate,
          creditsUsed: s.creditsUsed,
          costBreakdown: s.costBreakdown,
        })),
      });
    } catch (error: any) {
      console.error("Error fetching CRM customer:", error);
      res.status(500).json({ success: false, message: "Failed to fetch CRM customer" });
    }
  }

  async updateCrmCustomer(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { isBlocked, memory } = req.body ?? {};
      const patch: { isBlocked?: boolean; memory?: Record<string, any> } = {};
      if (typeof isBlocked === "boolean") patch.isBlocked = isBlocked;
      if (memory && typeof memory === "object" && !Array.isArray(memory)) {
        patch.memory = memory as Record<string, any>;
      }
      const customer = await crmRepository.updateCustomer(id, patch);
      if (!customer) {
        res.status(404).json({ success: false, message: "Customer not found" });
        return;
      }
      res.json({ success: true, customer: serializeCrmCustomer(customer) });
    } catch (error: any) {
      console.error("Error updating CRM customer:", error);
      res.status(500).json({ success: false, message: "Failed to update CRM customer" });
    }
  }

  async deleteCrmCustomer(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const existing = await crmRepository.getCustomerById(id);
      if (!existing) {
        res.status(404).json({ success: false, message: "Customer not found" });
        return;
      }
      await crmRepository.deleteCustomer(id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting CRM customer:", error);
      res.status(500).json({ success: false, message: "Failed to delete CRM customer" });
    }
  }

  async getCrmSessionLog(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      // Reuse the chat-session log getter — CRM sessions live in chat_sessions.
      const session = await chatRepository.getSessionLog(id);
      if (!session) {
        res.status(404).json({ success: false, message: "Session not found" });
        return;
      }
      res.json({ success: true, data: session.log });
    } catch (error: any) {
      console.error("Error fetching CRM session log:", error);
      res.status(500).json({ success: false, message: "Failed to fetch session log" });
    }
  }

  // MFA enforcement
  async setMfaEnforcement(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.params.id;
      const { enforced } = req.body;

      if (typeof enforced !== "boolean") {
        res.status(400).json({
          success: false,
          message: "enforced must be a boolean",
        });
        return;
      }

      const user = await userService.getUser(userId);
      if (!user) {
        res.status(404).json({
          success: false,
          message: "User not found",
        });
        return;
      }

      const success = await mfaService.setMfaEnforcement(userId, enforced);

      if (success) {
        res.json({
          success: true,
          message: enforced
            ? "MFA enforcement enabled for user"
            : "MFA enforcement disabled for user",
        });
      } else {
        res.status(500).json({
          success: false,
          message: "Failed to update MFA enforcement",
        });
      }
    } catch (error: any) {
      console.error("Error setting MFA enforcement:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update MFA enforcement",
      });
    }
  }

  /**
   * GET /api/admin/institutes
   * Get all active institutes (for admin dropdowns)
   */
  async getAllInstitutes(req: Request, res: Response): Promise<void> {
    try {
      const allInstitutes = await instituteRepository.getAllActiveInstitutes();
      res.json({ success: true, institutes: allInstitutes });
    } catch (error: any) {
      console.error("Error fetching institutes:", error);
      res.status(500).json({ success: false, message: "Failed to fetch institutes" });
    }
  }
}

export const adminController = new AdminController();
