// Server-side regime resolution. Reads the active license for an institute
// (or user) and returns the compliance regimes declared on it, normalized
// against the registry in shared/regime/regimes.ts.
//
// Regimes are stored on `licensePermissions.complianceRegimes` (JSONB).
// This service is the single read-path for "which regimes apply here?" —
// callers should never reach into permissions.complianceRegimes directly.

import {
  type RegimeSlug,
  type RegimeBundle,
  getRegimeBundle,
  normalizeRegimes,
  hasRegime as hasRegimeIn,
  resolveAccessibilityStandard,
  resolveAuditRetentionDays,
  resolveBreachNotificationHours,
} from "@shared/regime";
import { licenseService } from "./licenseService";

export class RegimeService {
  /** Regime slugs declared on the active license for an institute. */
  async getRegimesForInstitute(instituteId: string | undefined, isSystemAdmin = false): Promise<RegimeSlug[]> {
    const perms = await licenseService.getInstitutePermissions(instituteId, isSystemAdmin);
    return normalizeRegimes(perms.complianceRegimes);
  }

  /** Regime slugs declared on the user's first institute license (legacy/fallback). */
  async getRegimesForUser(userId: string, isSystemAdmin = false): Promise<RegimeSlug[]> {
    const { permissions } = await licenseService.getUserLicenseInfo(userId, isSystemAdmin);
    return normalizeRegimes(permissions.complianceRegimes);
  }

  /** Resolved bundles for the institute. Useful when callers need policies. */
  async getRegimeBundlesForInstitute(instituteId: string | undefined, isSystemAdmin = false): Promise<RegimeBundle[]> {
    const slugs = await this.getRegimesForInstitute(instituteId, isSystemAdmin);
    return slugs.map(getRegimeBundle).filter((b): b is RegimeBundle => b !== null);
  }

  async instituteHasRegime(instituteId: string | undefined, slug: RegimeSlug, isSystemAdmin = false): Promise<boolean> {
    const slugs = await this.getRegimesForInstitute(instituteId, isSystemAdmin);
    return hasRegimeIn(slugs, slug);
  }

  /** Strictest accessibility standard required across the institute's regimes. */
  async getAccessibilityStandardForInstitute(instituteId: string | undefined, isSystemAdmin = false) {
    const slugs = await this.getRegimesForInstitute(instituteId, isSystemAdmin);
    return resolveAccessibilityStandard(slugs);
  }

  /** Longest audit-retention required across the institute's regimes. */
  async getAuditRetentionDaysForInstitute(instituteId: string | undefined, isSystemAdmin = false) {
    const slugs = await this.getRegimesForInstitute(instituteId, isSystemAdmin);
    return resolveAuditRetentionDays(slugs);
  }

  /** Shortest breach-notification window across the institute's regimes (hours). */
  async getBreachNotificationHoursForInstitute(instituteId: string | undefined, isSystemAdmin = false) {
    const slugs = await this.getRegimesForInstitute(instituteId, isSystemAdmin);
    return resolveBreachNotificationHours(slugs);
  }
}

export const regimeService = new RegimeService();
