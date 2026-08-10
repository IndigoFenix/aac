// server/controllers/licenseController.ts
// Controller for admin license management

import type { Request, Response } from "express";
import { licenseService } from "../services/licenseService";
import { studentService } from "../services/studentService";
import { studentRepository } from "../repositories";
import { licensePermissionsSchema } from "@shared/license-permissions";
import type { StudentWithAacSettings } from "@shared/schema";
import { z } from "zod";

/** Shape a student's admin-managed budget settings + live usage snapshot for
 *  the Licenses → students budget UI. Tier lives on aacSettings; the meter
 *  snapshot lives on the students row (budgetMeters). */
function toBudgetSummary(student: StudentWithAacSettings) {
  const aac = (student.aacSettings ?? {}) as Record<string, any>;
  return {
    id: student.id,
    firstName: student.firstName ?? null,
    lastName: student.lastName ?? null,
    name: student.name ?? null,
    budgetTier: (aac.budgetTier as string | null) ?? null,
    fullAttentionMode: aac.fullAttentionMode ?? false,
    boardManagerLiveModel: aac.boardManagerLiveModel ?? false,
    allowFacilitatorControl: aac.allowFacilitatorControl ?? false,
    budgetMeters: ((student as any).budgetMeters ?? {}) as Record<string, unknown>,
  };
}

const updateBudgetSchema = z.object({
  budgetTier: z.string().nullable().optional(),
  fullAttentionMode: z.boolean().optional(),
  boardManagerLiveModel: z.boolean().optional(),
  allowFacilitatorControl: z.boolean().optional(),
});

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
  instituteType: z.enum(["school", "clinic", "family"]).optional(),
  language: z.string().optional(),
  // Family-institute provisioning: guardian-identity bits ride into
  // license.inviteDefaults so the consent wizard prefills.
  country: z.string().optional(),
  phone: z.string().optional(),
  governmentIdNumber: z.string().optional(),
  governmentIdType: z.enum(["national_id", "passport", "driver_license", "other"]).optional(),
  governmentIdCountry: z.string().optional(),
  identityProvenanceNote: z.string().optional(),
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
      if (error?.name === "LicenseValidationError") {
        res.status(400).json({ message: error.message, code: error.code });
        return;
      }
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

  /** GET /api/admin/licenses/:id/students — all students in the license's
   *  institute, with their budget settings + live usage snapshot. */
  async listLicenseStudents(req: Request, res: Response): Promise<void> {
    try {
      const license = await licenseService.getLicenseById(req.params.id);
      if (!license) {
        res.status(404).json({ message: "License not found" });
        return;
      }
      if (!license.instituteId) {
        // Unassigned license (pending invite) — no institute, no students yet.
        res.json({ students: [], instituteId: null });
        return;
      }
      const students = await studentRepository.getStudentsWithAacSettingsByInstituteId(
        license.instituteId,
      );
      res.json({
        students: students.map(toBudgetSummary),
        instituteId: license.instituteId,
      });
    } catch (error: any) {
      console.error("Error listing license students:", error);
      res.status(500).json({ message: "Failed to fetch students" });
    }
  }

  /** GET /api/admin/students/:studentId/budget — one student's budget settings. */
  async getStudentBudget(req: Request, res: Response): Promise<void> {
    try {
      const student = await studentRepository.getStudentWithAacSettings(req.params.studentId);
      if (!student) {
        res.status(404).json({ message: "Student not found" });
        return;
      }
      res.json({ budget: toBudgetSummary(student) });
    } catch (error: any) {
      console.error("Error fetching student budget:", error);
      res.status(500).json({ message: "Failed to fetch student budget" });
    }
  }

  /** PATCH /api/admin/students/:studentId/budget — set admin-managed budget
   *  fields (bypasses the clinician-path strip via allowAdminOnlyAacFields). */
  async updateStudentBudget(req: Request, res: Response): Promise<void> {
    try {
      const parsed = updateBudgetSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
        return;
      }
      // Normalize: empty tier string → null (inherit the deployment default).
      const updates: Record<string, any> = { ...parsed.data };
      if (updates.budgetTier === "") updates.budgetTier = null;

      const updated = await studentService.updateStudent(
        req.params.studentId,
        updates,
        { allowAdminOnlyAacFields: true },
      );
      if (!updated) {
        res.status(404).json({ message: "Student not found" });
        return;
      }
      res.json({ budget: toBudgetSummary(updated) });
    } catch (error: any) {
      console.error("Error updating student budget:", error);
      res.status(500).json({ message: "Failed to update student budget" });
    }
  }

  /** GET /api/admin/licenses/:id/invite-link — the recipient's invite
   *  ("verification") link, so an admin can pass it on by other means when the
   *  invite email fails to arrive. Sends no mail and does not invalidate a
   *  link that is still live. */
  async getInviteLink(req: Request, res: Response): Promise<void> {
    try {
      const baseUrl = getBaseUrl(req);
      const currentUser = req.user as any;
      const result = await licenseService.getInviteLink(req.params.id, baseUrl, currentUser.id);
      if (!result.success) {
        res.status(400).json({ message: result.error });
        return;
      }
      res.json({ inviteLink: result.inviteLink, expiresAt: result.expiresAt ?? null });
    } catch (error: any) {
      console.error("Error building license invite link:", error);
      res.status(500).json({ message: "Failed to build invite link" });
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
