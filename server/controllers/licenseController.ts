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
  inviteEmail: z.string().email(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  createInstitute: z.boolean().optional(),
  instituteName: z.string().optional(),
  instituteType: z.enum(["school", "hospital"]).optional(),
});

const updateLicenseSchema = z.object({
  name: z.string().optional(),
  licenseType: z.string().optional(),
  subscriptionType: z.string().optional(),
  permissions: licensePermissionsSchema.optional().nullable(),
  isActive: z.boolean().optional(),
  inviteEmail: z.string().email().optional().nullable(),
});

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

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const license = await licenseService.createLicenseWithSetup(parsed.data, baseUrl);
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
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const sent = await licenseService.resendInvite(req.params.id, baseUrl);
      if (!sent) {
        res.status(404).json({ message: "License not found or no invite email" });
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
