import type { Request, Response } from "express";
import { adminService, userService, creditService } from "../services";
import { userRepository, interpretationRepository } from "../repositories";
import { insertApiProviderSchemaWithValidation } from "@shared/schema";

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
      const users = await adminService.getAllUsersWithAacUsers();
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

  // API usage stats
  async getUsageStats(req: Request, res: Response): Promise<void> {
    try {
      console.log("Admin API usage-stats: Starting request");
      const stats = await adminService.getApiUsageStats();
      console.log("Admin API usage-stats: Got stats, sending response");
      res.json({ success: true, stats });
    } catch (error: any) {
      console.error("Error fetching API usage stats:", error);
      res
        .status(500)
        .json({ message: "Failed to fetch API usage statistics" });
    }
  }

  async getApiCalls(req: Request, res: Response): Promise<void> {
    try {
      const limitParam = parseInt(req.query.limit as string);
      const offsetParam = parseInt(req.query.offset as string);
      const providerIdParam = req.query.providerId as string | undefined;

      if (
        (req.query.limit && isNaN(limitParam)) ||
        (req.query.offset && isNaN(offsetParam))
      ) {
        res.status(400).json({
          message:
            "Invalid query parameters: limit and offset must be valid numbers",
        });
        return;
      }

      const limit = Math.min(Math.max(limitParam || 50, 1), 1000);
      const offset = Math.max(offsetParam || 0, 0);

      const totalCalls = await adminService.getApiCallsCount(providerIdParam);

      let apiCalls;
      if (providerIdParam) {
        apiCalls = await adminService.getApiCallsByProvider(
          providerIdParam,
          limit,
          offset
        );
      } else {
        apiCalls = await adminService.getApiCalls(limit, offset);
      }

      res.json({
        success: true,
        apiCalls,
        pagination: {
          total: totalCalls,
          limit,
          offset,
          hasMore: offset + limit < totalCalls,
        },
      });
    } catch (error: any) {
      console.error("Error fetching API calls:", error);
      res.status(500).json({ message: "Failed to fetch API calls" });
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
}

export const adminController = new AdminController();
