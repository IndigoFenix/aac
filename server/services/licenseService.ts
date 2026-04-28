// server/services/licenseService.ts
// Business logic for license management

import { licenseRepository, instituteRepository, studentRepository } from "../repositories";
import { emailService } from "./emailService";
import type { InsertLicense, UpdateLicense, License } from "@shared/schema";
import { type LicensePermissions, resolvePermissions, MAX_LICENSE_PERMISSIONS } from "@shared/license-permissions";
import { toE164 } from "@shared/phone";
import crypto from "crypto";

class LicenseValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "LicenseValidationError";
  }
}

interface CreateLicenseInput {
  // License fields
  name?: string;
  licenseType?: string;
  subscriptionType?: string;
  permissions?: LicensePermissions;

  // Recipient
  inviteEmail: string;
  firstName?: string;
  lastName?: string;

  // Trial
  isTrial?: boolean;
  trialExpiresAt?: string;

  // User type for invite form
  userType?: string;

  // Optional institute creation
  createInstitute?: boolean;
  instituteName?: string;
  instituteType?: "school" | "clinic" | "family";
  instituteLogo?: string; // base64 data URI

  // Family-institute provisioning: optional guardian-identity bits captured
  // off-band by the admin (intake call, signed paperwork, etc.). Stored on
  // license.inviteDefaults so the in-product consent wizard prefills.
  // See planning-docs/student-consent-onboarding-plan.md.
  country?: string;                                            // ISO 3166-1 alpha-2
  phone?: string;                                              // E.164
  governmentIdNumber?: string;
  governmentIdType?: 'national_id' | 'passport' | 'driver_license' | 'other';
  governmentIdCountry?: string;                                // ISO 3166-1 alpha-2
  identityProvenanceNote?: string;                             // admin attestation

  // Language for email (e.g. 'he' for Hebrew)
  language?: string;
}

class LicenseService {
  async createLicenseWithSetup(
    data: CreateLicenseInput,
    baseUrl: string,
    adminUserId: string,
  ): Promise<License> {
    let instituteId: string | undefined;

    // Step 1: Create institute if requested
    if (data.createInstitute && data.instituteName && data.instituteType) {
      const institute = await instituteRepository.createInstitute({
        name: data.instituteName,
        type: data.instituteType,
        logoUrl: data.instituteLogo || null,
        language: data.language || null,
      });
      instituteId = institute.id;
    }

    // Step 2: Generate invite token for non-institute licenses
    const inviteToken = instituteId ? undefined : crypto.randomBytes(32).toString("hex");

    // Step 3: Build invite defaults from recipient info. Guardian-identity
    // fields are accepted only for family-institute provisioning — capturing
    // them on a school/clinic license would store irrelevant data on the
    // wrong record.
    const isFamilyProvisioning = data.instituteType === "family";
    const baseDefaults = (data.firstName || data.lastName || data.userType)
      ? { firstName: data.firstName, lastName: data.lastName, userType: data.userType }
      : {};
    // Normalize the captured phone to E.164 using the captured country.
    // We reject rather than accept-then-fail-later: bad data on a license
    // ripples downstream into the consent wizard and the OTP send path.
    let normalizedPhone: string | undefined = undefined;
    if (isFamilyProvisioning && data.phone && data.phone.trim()) {
      const e164 = toE164(data.phone, data.country ?? "IL");
      if (!e164) {
        throw new LicenseValidationError(
          "phone_invalid",
          `Phone "${data.phone}" cannot be normalized to E.164 (country=${data.country ?? "unknown"}). ` +
            `Use the country dropdown or enter the number in international format.`,
        );
      }
      normalizedPhone = e164;
    }

    const familyDefaults = isFamilyProvisioning
      ? {
          country: data.country,
          phone: normalizedPhone,
          governmentIdNumber: data.governmentIdNumber,
          governmentIdType: data.governmentIdType,
          governmentIdCountry: data.governmentIdCountry,
          identityProvenanceNote: data.identityProvenanceNote,
        }
      : {};
    const merged = { ...baseDefaults, ...familyDefaults };
    const inviteDefaults = Object.values(merged).some((v) => v !== undefined && v !== null)
      ? merged
      : null;

    // Normalize email to lowercase for consistent lookups
    const normalizedEmail = data.inviteEmail.trim().toLowerCase();

    // Step 4: Create the license
    const licenseData: InsertLicense = {
      name: data.name || `License for ${normalizedEmail}`,
      licenseType: data.licenseType || "standard",
      subscriptionType: data.subscriptionType || "monthly",
      permissions: data.permissions || null,
      isTrial: data.isTrial || false,
      trialExpiresAt: data.trialExpiresAt ? new Date(data.trialExpiresAt) : null,
      inviteEmail: normalizedEmail,
      inviteToken: inviteToken || null,
      instituteId: instituteId || null,
      inviteDefaults,
      isActive: true,
    };

    const license = await licenseRepository.createLicense(licenseData);

    // Step 4: Create invite and send email
    if (instituteId) {
      const invite = await instituteRepository.createInvite(
        instituteId,
        normalizedEmail,
        adminUserId,
        { role: "admin", grantAdmin: true, expiresInDays: 30 },
      );

      try {
        const inviteLink = `${baseUrl}/invite/${invite.token}`;
        await emailService.sendLicenseInvite({
          inviteeEmail: normalizedEmail,
          licenseName: license.name || "Your License",
          licenseType: license.licenseType,
          instituteName: data.instituteName,
          inviteLink,
          expiresAt: invite.expiresAt,
          language: data.language,
        });
      } catch (err) {
        console.error("Failed to send institute invite email for license:", err);
      }
    } else {
      // Non-institute: use the license invite token
      try {
        const inviteLink = `${baseUrl}/invite/${inviteToken}`;
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);

        await emailService.sendLicenseInvite({
          inviteeEmail: normalizedEmail,
          licenseName: license.name || "Your License",
          licenseType: license.licenseType,
          inviteLink,
          expiresAt,
          language: data.language,
        });
      } catch (err) {
        console.error("Failed to send license invite email:", err);
      }
    }

    return license;
  }

  async getAllLicenses() {
    return licenseRepository.getAllLicenses();
  }

  async getLicenseById(id: string) {
    return licenseRepository.getLicenseById(id);
  }

  async updateLicense(id: string, updates: UpdateLicense) {
    return licenseRepository.updateLicense(id, updates);
  }

  async deleteLicense(id: string) {
    return licenseRepository.deleteLicense(id);
  }

  async resendInvite(licenseId: string, baseUrl: string, adminUserId: string): Promise<{ success: boolean; error?: string }> {
    const license = await licenseRepository.getLicenseById(licenseId);
    if (!license) return { success: false, error: "License not found" };
    if (!license.inviteEmail) return { success: false, error: "No invite email on this license" };

    let inviteLink: string;
    let instituteName: string | undefined;

    let language: string | undefined;

    if (license.instituteId) {
      // Institute licenses: find existing pending invite or create a new one
      const invite = await instituteRepository.createInvite(
        license.instituteId,
        license.inviteEmail,
        adminUserId,
        { role: "admin", grantAdmin: true, expiresInDays: 30 },
      );
      inviteLink = `${baseUrl}/invite/${invite.token}`;

      const institute = await instituteRepository.getInstituteById(license.instituteId);
      instituteName = institute?.name;
      language = institute?.language || undefined;
    } else {
      // Regenerate token if it was consumed or missing
      let token = license.inviteToken;
      if (!token) {
        token = crypto.randomBytes(32).toString("hex");
        await licenseRepository.updateLicense(license.id, { inviteToken: token });
      }
      inviteLink = `${baseUrl}/invite/${token}`;
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const result = await emailService.sendLicenseInvite({
      inviteeEmail: license.inviteEmail,
      licenseName: license.name || "Your License",
      licenseType: license.licenseType,
      instituteName,
      inviteLink,
      expiresAt,
      language,
    });

    if (!result.success) return { success: false, error: result.error || "Failed to send email" };
    return { success: true };
  }

  /**
   * Link a license to a user by email.
   * Call this after user registration to auto-link pending licenses.
   */
  async linkLicenseToUser(email: string, userId: string): Promise<License | undefined> {
    const license = await licenseRepository.getLicenseByInviteEmail(email);
    if (!license) return undefined;

    return licenseRepository.updateLicense(license.id, {
      userId,
      activatedAt: new Date(),
    });
  }

  /**
   * Resolve the effective license info for an institute.
   * If no instituteId is provided, returns defaults (no optional permissions).
   * System admins always get MAX permissions.
   */
  async getInstituteLicenseInfo(instituteId?: string, isSystemAdmin?: boolean): Promise<{ permissions: LicensePermissions; licenseType: string; isTrial: boolean; trialExpiresAt: Date | null }> {
    if (isSystemAdmin) return { permissions: { ...MAX_LICENSE_PERMISSIONS }, licenseType: "enterprise", isTrial: false, trialExpiresAt: null };

    if (!instituteId) {
      return { permissions: resolvePermissions(null), licenseType: "none", isTrial: false, trialExpiresAt: null };
    }

    const instituteLicenses = await licenseRepository.getLicensesByInstituteId(instituteId);
    const activeLicense = instituteLicenses.find((l) => l.isActive && l.permissions);
    if (activeLicense) {
      return { permissions: resolvePermissions(activeLicense.permissions), licenseType: activeLicense.licenseType, isTrial: activeLicense.isTrial, trialExpiresAt: activeLicense.trialExpiresAt };
    }

    return { permissions: resolvePermissions(null), licenseType: "none", isTrial: false, trialExpiresAt: null };
  }

  /** Convenience: just the permissions for an institute */
  async getInstitutePermissions(instituteId?: string, isSystemAdmin?: boolean): Promise<LicensePermissions> {
    const { permissions } = await this.getInstituteLicenseInfo(instituteId, isSystemAdmin);
    return permissions;
  }

  /**
   * @deprecated Use getInstituteLicenseInfo instead. This resolves based on the user's
   * institutes (picks the first one with an active license). Kept for callers that
   * don't have an instituteId available.
   */
  async getUserLicenseInfo(userId: string, isSystemAdmin?: boolean): Promise<{ permissions: LicensePermissions; licenseType: string; isTrial: boolean; trialExpiresAt: Date | null }> {
    if (isSystemAdmin) return { permissions: { ...MAX_LICENSE_PERMISSIONS }, licenseType: "enterprise", isTrial: false, trialExpiresAt: null };

    // Check institute licenses (getInstitutesByUserId respects support mode)
    const institutes = await instituteRepository.getInstitutesByUserId(userId);
    for (const inst of institutes) {
      const result = await this.getInstituteLicenseInfo(inst.id);
      if (result.licenseType !== "none") return result;
    }

    return { permissions: resolvePermissions(null), licenseType: "none", isTrial: false, trialExpiresAt: null };
  }

  /** @deprecated Use getInstitutePermissions instead */
  async getUserPermissions(userId: string, isSystemAdmin?: boolean): Promise<LicensePermissions> {
    const { permissions } = await this.getUserLicenseInfo(userId, isSystemAdmin);
    return permissions;
  }

  /**
   * True if ANY of the user's institute licenses grants the given permission.
   * Used by `requireLicensePermission` so a user whose selected-institute differs
   * from the "first non-none" institute still gets through.
   */
  async userHasPermission(
    userId: string,
    permKey: keyof LicensePermissions,
    isSystemAdmin?: boolean,
  ): Promise<boolean> {
    if (isSystemAdmin) return true;
    const institutes = await instituteRepository.getInstitutesByUserId(userId);
    for (const inst of institutes) {
      const { permissions } = await this.getInstituteLicenseInfo(inst.id);
      const value = permissions[permKey];
      const granted =
        typeof value === "boolean"
          ? value
          : typeof value === "number"
            ? value > 0 || value === -1
            : false;
      if (granted) return true;
    }
    return false;
  }

  /**
   * Check if more students can be added to an institute based on its license.
   * Returns { allowed: true } or { allowed: false, reason: string }.
   */
  async checkMaxStudents(instituteId?: string, isSystemAdmin?: boolean): Promise<{ allowed: boolean; reason?: string }> {
    const perms = await this.getInstitutePermissions(instituteId, isSystemAdmin);
    if (perms.maxStudents === -1) return { allowed: true }; // unlimited
    if (perms.maxStudents === 0) return { allowed: false, reason: "Your license does not allow adding students." };

    if (!instituteId) return { allowed: false, reason: "No institute selected." };

    // Count students in the institute
    const studentsResult = await instituteRepository.getStudentsInInstitute(instituteId);
    const currentCount = studentsResult.length;

    if (currentCount >= perms.maxStudents) {
      return {
        allowed: false,
        reason: `Student limit reached (${currentCount}/${perms.maxStudents}). Upgrade your license to add more students.`,
      };
    }
    return { allowed: true };
  }
}

export const licenseService = new LicenseService();
