import { z } from "zod";

export interface LicensePermissions {
  all?: boolean;
  maxStudents: number;
  aacEnabled: boolean;
  boardMakerEnabled: boolean;
  customAppsEnabled: boolean;
  unrestrictedAI: boolean;
  calendar: boolean;
  dashboardLevel: 0 | 1 | 2 | -1; // 0=none, 1=basic, 2=advanced, -1=full
  expertAgentsCount: number;
}

export const DEFAULT_LICENSE_PERMISSIONS: LicensePermissions = {
  all: false,
  maxStudents: 0,
  aacEnabled: false,
  boardMakerEnabled: false,
  customAppsEnabled: false,
  unrestrictedAI: false,
  calendar: false,
  dashboardLevel: 0,
  expertAgentsCount: 0,
};

export const MAX_LICENSE_PERMISSIONS: LicensePermissions = {
  all: true,
  maxStudents: -1, // -1 = unlimited
  aacEnabled: true,
  boardMakerEnabled: true,
  customAppsEnabled: true,
  unrestrictedAI: true,
  calendar: true,
  dashboardLevel: -1,
  expertAgentsCount: -1, // -1 = unlimited
};

export const licensePermissionsSchema: z.ZodType<LicensePermissions> = z.object({
  all: z.boolean().optional(),
  maxStudents: z.number().int(),
  aacEnabled: z.boolean(),
  boardMakerEnabled: z.boolean(),
  customAppsEnabled: z.boolean(),
  unrestrictedAI: z.boolean(),
  calendar: z.boolean(),
  dashboardLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(-1)]),
  expertAgentsCount: z.number().int(),
});

/**
 * Resolve permissions: if `all` is true, return MAX permissions.
 * Otherwise, fill in defaults for any missing fields.
 */
export function resolvePermissions(raw: Partial<LicensePermissions> | null | undefined): LicensePermissions {
  if (!raw) return { ...DEFAULT_LICENSE_PERMISSIONS };
  if (raw.all) return { ...MAX_LICENSE_PERMISSIONS };
  return {
    ...DEFAULT_LICENSE_PERMISSIONS,
    ...raw,
  };
}
