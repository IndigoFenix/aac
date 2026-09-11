import type { Request, Response } from "express";
import { adminService, userService, creditService } from "../services";
import { mfaService } from "../services/mfaService";
import { settingsRepository, instituteRepository, crmRepository } from "../repositories";
import { chatRepository } from "../repositories/chatRepository";
import { MODEL_OPTIONS, USE_CASES, modelAllowedForUseCase, type UseCaseKey, type LLMConfigValue } from "@shared/llm-options";
import { providerPolicyReason } from "@shared/llm-policy";
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

        // Validate http requirement — live/native-audio models 404 on the
        // generateContent path these use cases run on.
        if (useCaseInfo?.requiresHttp && !modelAllowedForUseCase(modelOption, useCaseInfo)) {
          res.status(400).json({
            success: false,
            message: `${useCaseInfo.label} runs on the HTTP path. ${modelOption.displayName} is a Live/native-audio model and can't be used here.`,
          });
          return;
        }

        // The per-agent HTTP overrides are wired only for Gemini (Vertex
        // generateContent + prompt cache). Reject other providers so the
        // admin can't save a config the coordinator will silently ignore.
        if (useCaseInfo?.requiresHttp && config.provider !== "gemini") {
          res.status(400).json({
            success: false,
            message: `${useCaseInfo.label} supports Gemini models only.`,
          });
          return;
        }

        // Transfer policy (AKIM §14): a PHI-bearing use case may only be
        // pointed at a disclosed processor. Checked before ANY write in the
        // batch lands, so a rejected save is atomic from the admin's side.
        const policyReason = providerPolicyReason(useCase as UseCaseKey, config.provider);
        if (policyReason) {
          res.status(400).json({
            success: false,
            code: "LLM_PROVIDER_NOT_PERMITTED",
            message: policyReason,
          });
          return;
        }
      }

      const actor = (req as any).user?.id as string | undefined;
      for (const [useCase, config] of Object.entries(configs)) {
        await settingsRepository.updateLLMConfig(useCase as UseCaseKey, config, actor);
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
