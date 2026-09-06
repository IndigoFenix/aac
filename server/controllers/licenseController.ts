// server/controllers/licenseController.ts
// Controller for admin license management

import type { Request, Response } from "express";
import { licenseService } from "../services/licenseService";
import { studentService } from "../services/studentService";
import { studentRepository, instituteRepository } from "../repositories";
import { paddleService } from "../services/paddleService";
import { activityLogService } from "../services/activityLogService";
import type { License } from "@shared/schema";
import { licensePermissionsSchema } from "@shared/license-permissions";
import { ADMIN_WILDCARD_PERMISSION } from "@shared/admin-sections";
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

/**
 * Per-license pricing, shared by create and update.
 *
 * `priceAmount` is in the currency's MINOR unit (cents/agorot) because that is
 * what Paddle's API takes and a second representation is a second bug. Null
 * means "not purchasable online" — an invoice or bank-transfer customer, whom
 * an admin activates by setting `isTrial: false` and a `subscriptionExpiresAt`
 * by hand.
 */
const priceAmountSchema = z.number().int().min(0).nullable().optional();
const priceCurrencySchema = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "ISO 4217 currency code")
  .transform((c) => c.toUpperCase())
  .optional();

const createLicenseSchema = z.object({
  priceAmount: priceAmountSchema,
  priceCurrency: priceCurrencySchema,
  subscriptionExpiresAt: z.string().nullable().optional(),
  name: z.string().optional(),
  licenseType: z.string().optional(),
  subscriptionType: z.string().optional(),
  permissions: licensePermissionsSchema.optional(),
  allowSessionRecording: z.boolean().optional(),
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
  allowSessionRecording: z.boolean().optional(),
  isActive: z.boolean().optional(),
  isTrial: z.boolean().optional(),
  trialExpiresAt: z.string().nullable().optional(),
  inviteEmail: z.string().email().optional().nullable(),
  // Marking an invoice/bank-transfer customer as paid is exactly this pair:
  // isTrial → false and a subscriptionExpiresAt in the future.
  priceAmount: priceAmountSchema,
  priceCurrency: priceCurrencySchema,
  subscriptionExpiresAt: z.string().nullable().optional(),
});

function getBaseUrl(req: Request): string {
  return process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
}

/**
 * Whether this admin is a FULL system admin rather than a section-scoped one.
 *
 * Not `user.isSystemAdmin`: `adaptAdminAsUser` sets that to `true`
 * unconditionally for every admin identity, so it cannot tell the two apart.
 * The wildcard permission is the real discriminator — it is what
 * `requireAdminSection` itself measures against — and these routes are only
 * reachable by an admin identity in the first place.
 */
function isFullSystemAdmin(user: any): boolean {
  return Array.isArray(user?.adminPermissions)
    && user.adminPermissions.includes(ADMIN_WILDCARD_PERMISSION);
}

/**
 * Guard the one license field that is NOT a licenses-section privilege.
 *
 * `allowSessionRecording` turns on a camera pointed at a child (see
 * shared/aac/session-recording.ts). It is an operator-granted marketing
 * entitlement, so it stays with whoever holds the whole backoffice rather than
 * with anyone who happens to have been given the Licenses page. Returns true
 * when the request has been refused and the caller must stop.
 */
function refusedSessionRecordingField(req: Request, res: Response): boolean {
  if (!("allowSessionRecording" in (req.body ?? {}))) return false;
  if (isFullSystemAdmin(req.user)) return false;
  res.status(403).json({
    message: "Only a full system admin may change the session-recording entitlement",
    code: "SESSION_RECORDING_ADMIN_ONLY",
  });
  return true;
}

/**
 * Audit a change to the session-recording entitlement.
 *
 * License rows have no subject type of their own, and adding one would be a
 * database enum migration for a single row shape — so the subject is the party
 * the license belongs to (its institute, or the user for a private license),
 * with the license id in the details. An unassigned license (a pending invite,
 * belonging to neither yet) still logs, with a null subject id, because a
 * silent grant is worse than an imprecisely-addressed one.
 */
function auditSessionRecordingGrant(
  req: Request,
  license: License,
  allowSessionRecording: boolean,
  route: string,
): void {
  const admin = req.user as any;
  activityLogService.log({
    instituteId: license.instituteId ?? null,
    userId: admin?.id ?? null,
    eventType: "update",
    subjectType1: license.instituteId ? "institute" : "user",
    subjectId1: license.instituteId ?? license.userId ?? null,
    details: {
      route,
      licenseId: license.id,
      field: "allowSessionRecording",
      allowSessionRecording,
    },
  });
}

/**
 * May this caller pay for this license?
 *
 * Institute admin-ness is asked of `instituteRepository.isUserAdminOfInstitute`
 * rather than recomputed — it already folds in customer-support mode and the
 * `isActive` membership check, and two answers to one question is how they
 * drift apart.
 */
async function callerMayPayFor(license: License, user: any): Promise<boolean> {
  if (!user?.id) return false;
  if (user.isSystemAdmin) return true;
  if (license.userId && license.userId === user.id) return true;
  if (license.instituteId) {
    return instituteRepository.isUserAdminOfInstitute(license.instituteId, user.id);
  }
  return false;
}

/** Parse multipart form body where JSON fields arrive as strings */
function parseMultipartBody(body: Record<string, any>): Record<string, any> {
  const parsed = { ...body };
  // Boolean fields sent as strings from FormData
  if (typeof parsed.isTrial === "string") parsed.isTrial = parsed.isTrial === "true";
  if (typeof parsed.createInstitute === "string") parsed.createInstitute = parsed.createInstitute === "true";
  if (typeof parsed.allowSessionRecording === "string") {
    parsed.allowSessionRecording = parsed.allowSessionRecording === "true";
  }
  // Numeric fields sent as strings from FormData. An empty string means the
  // admin cleared the field, which is null (not purchasable), not 0 (free).
  if (typeof parsed.priceAmount === "string") {
    const trimmed = parsed.priceAmount.trim();
    parsed.priceAmount = trimmed === "" ? null : Number(trimmed);
    if (Number.isNaN(parsed.priceAmount)) delete parsed.priceAmount;
  }
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
      // Measured against the PARSED body: over multipart the field arrives as a
      // string, and a guard reading req.body directly would see "false" (truthy)
      // as an attempt to set it.
      req.body = body;
      if (refusedSessionRecordingField(req, res)) return;
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
      if (license.allowSessionRecording) {
        auditSessionRecordingGrant(req, license, true, "POST /api/admin/licenses");
      }
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
      if (refusedSessionRecordingField(req, res)) return;
      const parsed = updateLicenseSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
        return;
      }

      const { trialExpiresAt, subscriptionExpiresAt, ...rest } = parsed.data;
      const updates = {
        ...rest,
        trialExpiresAt: trialExpiresAt ? new Date(trialExpiresAt) : trialExpiresAt === null ? null : undefined,
        subscriptionExpiresAt: subscriptionExpiresAt
          ? new Date(subscriptionExpiresAt)
          : subscriptionExpiresAt === null
            ? null
            : undefined,
      };
      const license = await licenseService.updateLicense(req.params.id, updates);
      if (!license) {
        res.status(404).json({ message: "License not found" });
        return;
      }
      if (parsed.data.allowSessionRecording !== undefined) {
        auditSessionRecordingGrant(
          req,
          license,
          license.allowSessionRecording,
          "PATCH /api/admin/licenses/:id",
        );
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

  /**
   * POST /api/licenses/:id/checkout — start paying for THIS license.
   *
   * NOT an admin route: the whole point is that the customer pays for
   * themselves. Who may: the user the license is assigned to, an admin of the
   * license's institute, or a system admin. Anyone else gets a 403 — including
   * a plain member of the institute, because a licence purchase is a financial
   * commitment on the organisation's behalf.
   *
   * Refusals carry an `error:` CODE, not prose: the client renders a
   * translated `errors.<CODE>` string, so an English sentence here would be an
   * untranslatable one on a Hebrew screen.
   */
  async createCheckout(req: Request, res: Response): Promise<void> {
    try {
      const license = await licenseService.getLicenseById(req.params.id);
      if (!license) {
        res.status(404).json({ message: "License not found", error: "LICENSE_NOT_FOUND" });
        return;
      }

      const currentUser = req.user as any;
      const allowed = await callerMayPayFor(license, currentUser);
      if (!allowed) {
        res.status(403).json({ message: "Not allowed to pay for this license", error: "FORBIDDEN" });
        return;
      }

      if (!paddleService.isConfigured()) {
        res
          .status(503)
          .json({ message: "Paddle is not configured", error: "PADDLE_NOT_CONFIGURED" });
        return;
      }

      const result = await licenseService.createCheckout(license.id);
      if (!result.ok) {
        res.status(409).json({ message: "License cannot be purchased", error: result.code });
        return;
      }
      res.json({ transactionId: result.transactionId });
    } catch (error: any) {
      console.error("Error creating license checkout:", error);
      res.status(500).json({ message: "Failed to start checkout", error: "CHECKOUT_FAILED" });
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
