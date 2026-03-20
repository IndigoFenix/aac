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

  // Optional institute creation
  createInstitute?: boolean;
  instituteName?: string;
  instituteType?: "school" | "clinic";
}

class LicenseService {
  async createLicenseWithSetup(
    data: CreateLicenseInput,
    baseUrl: string,
  ): Promise<License> {
    let instituteId: string | undefined;

    // Step 1: Create institute if requested
    if (data.createInstitute && data.instituteName && data.instituteType) {
      const institute = await instituteRepository.createInstitute({
        name: data.instituteName,
        type: data.instituteType,
      });
      instituteId = institute.id;
    }

    // Step 2: Generate invite token for non-institute licenses
    const inviteToken = instituteId ? undefined : crypto.randomBytes(32).toString("hex");

    // Step 3: Create the license
    const licenseData: InsertLicense = {
      name: data.name || `License for ${data.inviteEmail}`,
      licenseType: data.licenseType || "standard",
      subscriptionType: data.subscriptionType || "free",
      permissions: data.permissions || null,
      inviteEmail: data.inviteEmail,
      inviteToken: inviteToken || null,
      instituteId: instituteId || null,
      isActive: true,
    };

    const license = await licenseRepository.createLicense(licenseData);

    // Step 4: Send invite email
    if (instituteId) {
      try {
        const invite = await instituteRepository.createInvite(
          instituteId,
          data.inviteEmail,
          "system",
          { role: "admin", grantAdmin: true, expiresInDays: 30 },
        );

        const inviteLink = `${baseUrl}/invite/${invite.token}`;
        await emailService.sendLicenseInvite({
          inviteeEmail: data.inviteEmail,
          licenseName: license.name || "Your License",
          licenseType: license.licenseType,
          instituteName: data.instituteName,
          inviteLink,
          expiresAt: invite.expiresAt,
        });
      } catch (err) {
        console.error("Failed to send institute invite for license:", err);
      }
    } else {
      // Non-institute: use the license invite token
      try {
        const inviteLink = `${baseUrl}/invite/${inviteToken}`;
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);

        await emailService.sendLicenseInvite({
          inviteeEmail: data.inviteEmail,
          licenseName: license.name || "Your License",
          licenseType: license.licenseType,
          inviteLink,
          expiresAt,
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

  async resendInvite(licenseId: string, baseUrl: string): Promise<boolean> {
    const license = await licenseRepository.getLicenseById(licenseId);
    if (!license || !license.inviteEmail) return false;

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    // For non-institute licenses, regenerate the invite token if missing
    let inviteLink: string;
    if (license.instituteId) {
      // Institute licenses use the institute invite token
      inviteLink = `${baseUrl}/invite/${crypto.randomBytes(32).toString("hex")}`;
    } else {
      // Regenerate token if it was consumed or missing
      let token = license.inviteToken;
      if (!token) {
        token = crypto.randomBytes(32).toString("hex");
        await licenseRepository.updateLicense(license.id, { inviteToken: token });
      }
      inviteLink = `${baseUrl}/invite/${token}`;
    }

    const result = await emailService.sendLicenseInvite({
      inviteeEmail: license.inviteEmail,
      licenseName: license.name || "Your License",
      licenseType: license.licenseType,
      instituteName: undefined,
      inviteLink,
      expiresAt,
    });

    return result.success;
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
   * Resolve the effective license info for a user.
   * Checks: direct user license first, then institute licenses.
   * System admins get MAX permissions with "enterprise" type.
   */
  async getUserLicenseInfo(userId: string, isSystemAdmin?: boolean): Promise<{ permissions: LicensePermissions; licenseType: string }> {
    if (isSystemAdmin) return { permissions: { ...MAX_LICENSE_PERMISSIONS }, licenseType: "enterprise" };

    // 1. Check direct user license
    const directLicense = await licenseRepository.getLicenseByUserId(userId);
    if (directLicense?.isActive && directLicense.permissions) {
      return { permissions: resolvePermissions(directLicense.permissions), licenseType: directLicense.licenseType };
    }

    // 2. Check institute licenses
    const institutes = await instituteRepository.getInstitutesByUserId(userId);
    for (const inst of institutes) {
      const instituteLicenses = await licenseRepository.getLicensesByInstituteId(inst.id);
      const activeLicense = instituteLicenses.find((l) => l.isActive && l.permissions);
      if (activeLicense) {
        return { permissions: resolvePermissions(activeLicense.permissions), licenseType: activeLicense.licenseType };
      }
    }

    // 3. No license found — return defaults (all disabled)
    return { permissions: resolvePermissions(null), licenseType: "none" };
  }

  /** Convenience: just the permissions */
  async getUserPermissions(userId: string, isSystemAdmin?: boolean): Promise<LicensePermissions> {
    const { permissions } = await this.getUserLicenseInfo(userId, isSystemAdmin);
    return permissions;
  }

  /**
   * Check if a user can add more students based on their license.
   * Returns { allowed: true } or { allowed: false, reason: string }.
   */
  async checkMaxStudents(userId: string, isSystemAdmin?: boolean): Promise<{ allowed: boolean; reason?: string }> {
    const perms = await this.getUserPermissions(userId, isSystemAdmin);
    if (perms.maxStudents === -1) return { allowed: true }; // unlimited

    const students = await studentRepository.getStudentsByUserId(userId);
    const currentCount = students.length;

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
