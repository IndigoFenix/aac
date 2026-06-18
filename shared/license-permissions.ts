import { z } from "zod";

/**
 * Insurance Bridge billing regime. Determines RTM thresholds, ICD code list,
 * and LMN template the module uses for an institute. Single enum is enough
 * for v1 — split into separate documentTemplate/codeSystem fields if a future
 * regime needs the orthogonal mix.
 *  - "none": module hidden / disabled (default)
 *  - "us_cpt": US CPT codes 98977/98979/98980/98985 + ICD-10-CM + US LMN
 */
export type BillingRegime = "none" | "us_cpt";

export interface LicensePermissions {
  all?: boolean;
  maxStudents: number;
  // Max AAC devices that can be registered per student under this license.
  // -1 = unlimited, 0 = none. Optional so payloads/rows predating the field
  // stay valid; resolvePermissions fills the default (-1, so pre-existing
  // licenses are unaffected). A student enrolled in several institutes gets
  // the SUM of their institutes' limits (any -1 makes the total unlimited).
  maxDevicesPerStudent?: number;
  aacEnabled: boolean;
  boardMakerEnabled: boolean;
  customAppsEnabled: boolean;
  unrestrictedAI: boolean;
  calendar: boolean;
  dashboardLevel: 0 | 1 | 2 | -1; // 0=none, 1=basic, 2=advanced, -1=full
  expertAgentsCount: number;
  deepAnalysisEnabled: boolean;
  // Video Caption Studio — upload a video + caption file, convert captions to
  // timestamped glyph overlays, preview and export. Optional so payloads/rows
  // predating the field stay valid; resolvePermissions fills the default.
  videoCaptionEnabled?: boolean;
  // Compliance regime slugs that apply to this license. Free-form strings
  // resolved against shared/regime/regimes.ts. Stored as data so adding a
  // new regime is a registry update, not a migration.
  complianceRegimes?: string[];
  // Insurance Bridge module — RTM dashboard, LMN generator, ICD picker.
  insuranceBridgeEnabled: boolean;
  // Which billing market shapes the module's behavior when enabled.
  billingRegime: BillingRegime;
}

export const DEFAULT_LICENSE_PERMISSIONS: LicensePermissions = {
  all: false,
  maxStudents: 0,
  maxDevicesPerStudent: -1,
  aacEnabled: false,
  boardMakerEnabled: false,
  customAppsEnabled: false,
  unrestrictedAI: false,
  calendar: false,
  dashboardLevel: 0,
  expertAgentsCount: 0,
  deepAnalysisEnabled: false,
  videoCaptionEnabled: false,
  complianceRegimes: [],
  insuranceBridgeEnabled: false,
  billingRegime: "none",
};

export const MAX_LICENSE_PERMISSIONS: LicensePermissions = {
  all: true,
  maxStudents: -1, // -1 = unlimited
  maxDevicesPerStudent: -1, // -1 = unlimited
  aacEnabled: true,
  boardMakerEnabled: true,
  customAppsEnabled: true,
  unrestrictedAI: true,
  calendar: true,
  dashboardLevel: -1,
  expertAgentsCount: -1, // -1 = unlimited
  deepAnalysisEnabled: true,
  videoCaptionEnabled: true,
  complianceRegimes: [],
  insuranceBridgeEnabled: true,
  billingRegime: "us_cpt",
};

export const licensePermissionsSchema: z.ZodType<LicensePermissions> = z.object({
  all: z.boolean().optional(),
  maxStudents: z.number().int(),
  maxDevicesPerStudent: z.number().int().optional(),
  aacEnabled: z.boolean(),
  boardMakerEnabled: z.boolean(),
  customAppsEnabled: z.boolean(),
  unrestrictedAI: z.boolean(),
  calendar: z.boolean(),
  dashboardLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(-1)]),
  expertAgentsCount: z.number().int(),
  deepAnalysisEnabled: z.boolean(),
  videoCaptionEnabled: z.boolean().optional(),
  complianceRegimes: z.array(z.string()).optional(),
  insuranceBridgeEnabled: z.boolean(),
  billingRegime: z.enum(["none", "us_cpt"]),
});

/**
 * Resolve permissions: if `all` is true, return MAX permissions.
 * Otherwise, fill in defaults for any missing fields.
 */
export function resolvePermissions(raw: Partial<LicensePermissions> | null | undefined): LicensePermissions {
  if (!raw) return { ...DEFAULT_LICENSE_PERMISSIONS };
  if (raw.all) {
    // `all` grants max capabilities but preserves any explicit regime
    // declarations — regimes describe which market/jurisdiction the
    // institute operates in, not which features are unlocked.
    return {
      ...MAX_LICENSE_PERMISSIONS,
      complianceRegimes: raw.complianceRegimes ?? [],
      billingRegime: raw.billingRegime ?? "none",
    };
  }
  return {
    ...DEFAULT_LICENSE_PERMISSIONS,
    ...raw,
  };
}
