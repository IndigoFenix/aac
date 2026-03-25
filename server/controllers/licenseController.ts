// server/controllers/licenseController.ts
// Controller for admin license management

import type { Request, Response } from "express";
import { licenseService } from "../services/licenseService";
import { licensePermissionsSchema } from "@shared/license-permissions";
import { z } from "zod";

const createLicenseSchema = z.object({
  name: z.string().optional(),
  licenseType: z.string().optional(),
  subscriptionType: z.string().optional(),
  permissions: licensePermissionsSchema.optional(),
  isTrial: z.boolean().optional(),
  trialExpiresAt: z.string().optional(),
  inviteEmail: z.string().email(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  createInstitute: z.boolean().optional(),
  instituteName: z.string().optional(),
  instituteType: z.enum(["school", "clinic"]).optional(),
});

const updateLicenseSchema = z.object({
  name: z.string().optional(),
  licenseType: z.string().optional(),
  subscriptionType: z.string().optional(),
  permissions: licensePermissionsSchema.optional().nullable(),
  isActive: z.boolean().optional(),
  isTrial: z.boolean().optional(),
  trialExpiresAt: z.string().nullable().optional(),
  inviteEmail: z.string().email().optional().nullable(),
});

function getBaseUrl(req: Request): string {
  return process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
}

class LicenseController {
  async listLicenses(req: Request, res: Response): Promise<void> {
    try {
      const licenses = await licenseService.getAllLicenses();
      res.json({ licenses });
    } catch (error: any) {
      console.error("Error listing licenses:", error);
      res.status(500).json({ message: "Failed to fetch licenses" });
    }
  }

  async getLicense(req: Request, res: Response): Promise<void> {
    try {
      const license = await licenseService.getLicenseById(req.params.id);
      if (!license) {
        res.status(404).json({ message: "License not found" });
        return;
      }
      res.json({ license });
    } catch (error: any) {
      console.error("Error fetching license:", error);
      res.status(500).json({ message: "Failed to fetch license" });
    }
  }

  async createLicense(req: Request, res: Response): Promise<void> {
    try {
      const parsed = createLicenseSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
        return;
      }

      const baseUrl = getBaseUrl(req);
      const currentUser = req.user as any;
      const license = await licenseService.createLicenseWithSetup(parsed.data, baseUrl, currentUser.id);
      res.status(201).json({ license });
    } catch (error: any) {
      console.error("Error creating license:", error);
      res.status(500).json({ message: "Failed to create license" });
    }
  }

  async updateLicense(req: Request, res: Response): Promise<void> {
    try {
      const parsed = updateLicenseSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
        return;
      }

      const license = await licenseService.updateLicense(req.params.id, parsed.data);
      if (!license) {
        res.status(404).json({ message: "License not found" });
        return;
      }
      res.json({ license });
    } catch (error: any) {
      console.error("Error updating license:", error);
      res.status(500).json({ message: "Failed to update license" });
    }
  }

  async deleteLicense(req: Request, res: Response): Promise<void> {
    try {
      const deleted = await licenseService.deleteLicense(req.params.id);
      if (!deleted) {
        res.status(404).json({ message: "License not found" });
        return;
      }
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting license:", error);
      res.status(500).json({ message: "Failed to delete license" });
    }
  }

  async resendInvite(req: Request, res: Response): Promise<void> {
    try {
      const baseUrl = getBaseUrl(req);
      const currentUser = req.user as any;
      const result = await licenseService.resendInvite(req.params.id, baseUrl, currentUser.id);
      if (!result.success) {
        res.status(400).json({ message: result.error });
        return;
      }
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error resending invite:", error);
      res.status(500).json({ message: "Failed to resend invite" });
    }
  }
}

export const licenseController = new LicenseController();
