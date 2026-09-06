// server/services/licenseService.ts
// Business logic for license management

import { licenseRepository, instituteRepository, studentRepository } from "../repositories";
import { emailService } from "./emailService";
import type { InsertLicense, UpdateLicense, License } from "@shared/schema";
import { type LicensePermissions, resolvePermissions, MAX_LICENSE_PERMISSIONS } from "@shared/license-permissions";
import {
  computeLicenseStatus,
  licenseExpiryDate,
  licenseStatusRank,
  type LicenseStatus,
} from "@shared/license-status";
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

  /**
   * On-device session recording (shared/aac/session-recording.ts). An
   * operator-granted marketing entitlement, not a sold permission — which is
   * why it rides here as its own field rather than inside `permissions`.
   * Settable by a SYSTEM admin only; the controller enforces that.
   */
  allowSessionRecording?: boolean;

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

  // Per-license pricing. Organisations are quoted individually, so the price
  // lives on the row rather than on a catalog tier. `priceAmount` is in the
  // currency's MINOR unit (cents/agorot), as Paddle expects.
  priceAmount?: number | null;
  priceCurrency?: string | null;
  /** Paid-through date. Set by fulfillment, or by an admin marking an
   *  invoice/bank-transfer customer as paid. */
  subscriptionExpiresAt?: string | null;
}

/**
 * What every caller asking "what may this party do" gets back.
 *
 * `permissions` is already expiry-adjusted (an expired license resolves to the
 * same permissions as none). The remaining fields describe the ROW so a client
 * can render a paywall for it; they are populated even when the permissions are
 * empty, which is the whole point.
 */
export interface LicenseInfo {
  permissions: LicensePermissions;
  licenseType: string;
  isTrial: boolean;
  trialExpiresAt: Date | null;
  licenseId: string | null;
  status: LicenseStatus;
  /** Whichever date applies: trial end for a trial, subscription end otherwise. */
  expiresAt: Date | null;
  priceAmount: number | null;
  priceCurrency: string | null;
  subscriptionType: string | null;
}

const NO_LICENSE_INFO: LicenseInfo = {
  permissions: resolvePermissions(null),
  licenseType: "none",
  isTrial: false,
  trialExpiresAt: null,
  licenseId: null,
  status: "none",
  expiresAt: null,
  priceAmount: null,
  priceCurrency: null,
  subscriptionType: null,
};

/** Project one license row into the info payload, applying expiry. */
function licenseInfoOf(license: License, now: Date = new Date()): LicenseInfo {
  const status = computeLicenseStatus(license, now);
  return {
    // An expired license grants exactly what no license grants.
    permissions:
      status === "active" || status === "trial"
        ? resolvePermissions(license.permissions)
        : resolvePermissions(null),
    licenseType: status === "none" ? "none" : license.licenseType,
    isTrial: license.isTrial,
    trialExpiresAt: license.trialExpiresAt,
    licenseId: license.id,
    status,
    expiresAt: licenseExpiryDate(license),
    priceAmount: license.priceAmount ?? null,
    priceCurrency: license.priceCurrency ?? null,
    subscriptionType: license.subscriptionType ?? null,
  };
}

/** The most useful of several licenses: live beats expired, expired beats none. */
function bestLicense(candidates: License[], now: Date = new Date()): License | undefined {
  let best: License | undefined;
  let bestRank = 0;
  for (const candidate of candidates) {
    const rank = licenseStatusRank(computeLicenseStatus(candidate, now));
    if (rank > bestRank) {
      best = candidate;
      bestRank = rank;
    }
  }
  return best;
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
      allowSessionRecording: data.allowSessionRecording === true,
      isTrial: data.isTrial || false,
      trialExpiresAt: data.trialExpiresAt ? new Date(data.trialExpiresAt) : null,
      subscriptionExpiresAt: data.subscriptionExpiresAt ? new Date(data.subscriptionExpiresAt) : null,
      priceAmount: data.priceAmount ?? null,
      priceCurrency: data.priceCurrency ?? "USD",
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

  /**
   * Start a Paddle checkout for ONE license, at the price quoted on its own row.
   *
   * Non-catalog pricing on purpose: organisations are quoted individually, so
   * there is no catalog price to point at. Paddle accepts a price object inline
   * on the transaction item — it needs a productId to hang off, which is the
   * single shared "Aivota License" product (see paddleService.ensureLicenseProduct).
   *
   * Refusals are RETURNED, not thrown, because each maps to a distinct HTTP
   * status the client translates. The caller checks authorisation; this method
   * checks only whether the license is in a state that can be bought.
   */
  async createCheckout(
    licenseId: string,
  ): Promise<
    | { ok: true; transactionId: string }
    | { ok: false; code: "LICENSE_NOT_PURCHASABLE" | "LICENSE_ALREADY_PAID" }
  > {
    const license = await licenseRepository.getLicenseById(licenseId);
    if (!license) return { ok: false, code: "LICENSE_NOT_PURCHASABLE" };
    if (!license.isActive) return { ok: false, code: "LICENSE_NOT_PURCHASABLE" };
    if (!license.priceAmount || license.priceAmount <= 0) {
      // No quoted price = invoice-paid or admin-granted; nothing to charge.
      return { ok: false, code: "LICENSE_NOT_PURCHASABLE" };
    }
    if (
      !license.isTrial &&
      license.subscriptionExpiresAt &&
      license.subscriptionExpiresAt.getTime() > Date.now()
    ) {
      return { ok: false, code: "LICENSE_ALREADY_PAID" };
    }

    const { paddleService } = await import("./paddleService");
    const transactionId = await paddleService.createLicenseTransaction({
      licenseId: license.id,
      userId: license.userId ?? null,
      name: license.name || "Aivota License",
      priceAmount: license.priceAmount,
      priceCurrency: license.priceCurrency || "USD",
      subscriptionType: license.subscriptionType === "yearly" ? "yearly" : "monthly",
      paddleCustomerId: license.paddleCustomerId ?? null,
    });

    await licenseRepository.updateLicense(license.id, { paddleTransactionId: transactionId });
    return { ok: true, transactionId };
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
   * Resolve the recipient's invite ("verification") link WITHOUT sending mail,
   * so an admin can hand it over out-of-band when the invite email bounces or
   * lands in a spam trap.
   *
   * Unlike resendInvite this never rotates a token that is still live: a link
   * already sitting in the recipient's inbox has to keep working. A new invite
   * is minted only when none exists or the existing one has expired.
   */
  async getInviteLink(
    licenseId: string,
    baseUrl: string,
    adminUserId: string,
  ): Promise<{ success: boolean; inviteLink?: string; expiresAt?: Date | null; error?: string }> {
    const license = await licenseRepository.getLicenseById(licenseId);
    if (!license) return { success: false, error: "License not found" };
    if (!license.inviteEmail) return { success: false, error: "No invite email on this license" };

    if (license.instituteId) {
      const pending = await instituteRepository.getPendingInviteByEmail(
        license.instituteId,
        license.inviteEmail,
      );
      const invite =
        pending && pending.expiresAt > new Date()
          ? pending
          : await instituteRepository.createInvite(
              license.instituteId,
              license.inviteEmail,
              adminUserId,
              { role: "admin", grantAdmin: true, expiresInDays: 30 },
            );
      return {
        success: true,
        inviteLink: `${baseUrl}/invite/${invite.token}`,
        expiresAt: invite.expiresAt,
      };
    }

    // Non-institute licenses carry the token on the license row itself, with no
    // stored expiry — regenerate only if it is missing or was consumed.
    let token = license.inviteToken;
    if (!token) {
      token = crypto.randomBytes(32).toString("hex");
      await licenseRepository.updateLicense(license.id, { inviteToken: token });
    }
    return { success: true, inviteLink: `${baseUrl}/invite/${token}`, expiresAt: null };
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
   *
   * EXPIRY IS ENFORCED HERE (and only here): an expired license resolves to the
   * same permissions as no license at all, but the payload still names the row
   * — id, status, dates, price — because the client cannot render a "renew"
   * button for a license it was never told about.
   */
  async getInstituteLicenseInfo(instituteId?: string, isSystemAdmin?: boolean): Promise<LicenseInfo> {
    if (isSystemAdmin) {
      return {
        ...NO_LICENSE_INFO,
        permissions: { ...MAX_LICENSE_PERMISSIONS },
        licenseType: "enterprise",
        status: "active",
      };
    }

    if (!instituteId) return { ...NO_LICENSE_INFO };

    const instituteLicenses = await licenseRepository.getLicensesByInstituteId(instituteId);
    const best = bestLicense(instituteLicenses.filter((l) => l.isActive && l.permissions));
    return best ? licenseInfoOf(best) : { ...NO_LICENSE_INFO };
  }

  /**
   * Which of these students may record sessions to their device's disk.
   *
   * Deliberately NOT routed through getInstituteLicenseInfo / resolvePermissions
   * above, for two reasons that would each be a silent bug:
   *   1. That path only considers a license whose `permissions` jsonb is
   *      non-null, and this entitlement is a column on the license row.
   *   2. It returns MAX_LICENSE_PERMISSIONS for system admins and expands
   *      `all: true` for everyone else — so an entitlement resolved that way
   *      would switch itself on for licenses nobody granted it to. See the
   *      column comment on `licenses.allowSessionRecording`.
   *
   * The whole rule is therefore: an ACTIVE license the student actually sits
   * under has the flag set. Nothing else grants it — not the license type, not
   * `all`, not being a system admin.
   */
  async sessionRecordingLicensedFor(studentIds: readonly string[]): Promise<Set<string>> {
    return licenseRepository.getSessionRecordingLicensedStudentIds(studentIds);
  }

  /** Single-student form of {@link sessionRecordingLicensedFor}. Prefer the
   *  batch when answering for a list — this is 2 queries per call. */
  async isSessionRecordingLicensed(studentId: string): Promise<boolean> {
    const allowed = await this.sessionRecordingLicensedFor([studentId]);
    return allowed.has(studentId);
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
  async getUserLicenseInfo(userId: string, isSystemAdmin?: boolean): Promise<LicenseInfo> {
    if (isSystemAdmin) {
      return {
        ...NO_LICENSE_INFO,
        permissions: { ...MAX_LICENSE_PERMISSIONS },
        licenseType: "enterprise",
        status: "active",
      };
    }

    // Check institute licenses (getInstitutesByUserId respects support mode).
    // A LIVE license anywhere wins; an expired one is remembered as a fallback
    // so the paywall has a row to offer, but never short-circuits the search —
    // a second institute with a paid license must still get through.
    const institutes = await instituteRepository.getInstitutesByUserId(userId);
    let expiredFallback: LicenseInfo | null = null;
    for (const inst of institutes) {
      const result = await this.getInstituteLicenseInfo(inst.id);
      if (result.status === "active" || result.status === "trial") return result;
      if (result.status === "expired" && !expiredFallback) expiredFallback = result;
    }

    return expiredFallback ?? { ...NO_LICENSE_INFO };
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
