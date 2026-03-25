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
  userType: z.string().optional(),
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

/** Parse multipart form body where JSON fields arrive as strings */
function parseMultipartBody(body: Record<string, any>): Record<string, any> {
  const parsed = { ...body };
  // Boolean fields sent as strings from FormData
  if (typeof parsed.isTrial === "string") parsed.isTrial = parsed.isTrial === "true";
  if (typeof parsed.createInstitute === "string") parsed.createInstitute = parsed.createInstitute === "true";
  // JSON fields
  if (typeof parsed.permissions === "string") {
    try { parsed.permissions = JSON.parse(parsed.permissions); } catch { delete parsed.permissions; }
  }
  return parsed;
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

  async createLicense(req: Request & { file?: Express.Multer.File }, res: Response): Promise<void> {
    try {
      const body = req.is("multipart/form-data") ? parseMultipartBody(req.body) : req.body;
      const parsed = createLicenseSchema.safeParse(body);
      if (!parsed.success) {
        res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
        return;
      }

      // Convert uploaded logo file to base64 data URI
      let instituteLogo: string | undefined;
      if (req.file) {
        const base64 = req.file.buffer.toString("base64");
        instituteLogo = `data:${req.file.mimetype};base64,${base64}`;
      }

      const baseUrl = getBaseUrl(req);
      const currentUser = req.user as any;
      const license = await licenseService.createLicenseWithSetup(
        { ...parsed.data, instituteLogo },
        baseUrl,
        currentUser.id,
      );
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

      const { trialExpiresAt, ...rest } = parsed.data;
      const updates = {
        ...rest,
        trialExpiresAt: trialExpiresAt ? new Date(trialExpiresAt) : trialExpiresAt === null ? null : undefined,
      };
      const license = await licenseService.updateLicense(req.params.id, updates);
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
