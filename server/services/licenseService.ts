// server/services/licenseService.ts
// Business logic for license management

import { licenseRepository, instituteRepository, studentRepository } from "../repositories";
import { emailService } from "./emailService";
import type { InsertLicense, UpdateLicense, License } from "@shared/schema";
import { type LicensePermissions, resolvePermissions, MAX_LICENSE_PERMISSIONS } from "@shared/license-permissions";
import crypto from "crypto";

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
      });
      instituteId = institute.id;
    }

    // Step 2: Generate invite token for non-institute licenses
    const inviteToken = instituteId ? undefined : crypto.randomBytes(32).toString("hex");

    // Step 3: Build invite defaults from recipient info
    const inviteDefaults = (data.firstName || data.lastName || data.userType)
      ? { firstName: data.firstName, lastName: data.lastName, userType: data.userType }
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
