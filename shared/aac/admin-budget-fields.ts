// shared/aac/admin-budget-fields.ts
//
// The AAC-settings fields that make up the "Token Budget" section. These are
// cost/governance controls managed by the system admin (under Licenses), NOT by
// the clinician in the per-student AAC Settings page. They are writable only
// through the admin budget endpoint; the normal student-update path strips them.

export const ADMIN_ONLY_AAC_FIELDS = [
  "budgetTier",
  "fullAttentionMode",
  "boardManagerLiveModel",
  "allowFacilitatorControl",
] as const;

export type AdminOnlyAacField = (typeof ADMIN_ONLY_AAC_FIELDS)[number];

export const ADMIN_ONLY_AAC_FIELD_SET: ReadonlySet<string> = new Set(
  ADMIN_ONLY_AAC_FIELDS,
);
