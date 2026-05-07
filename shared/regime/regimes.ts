// Regime registry — the single source of truth for compliance regimes
// that the platform knows about. A regime is a slug + a bundle of policy
// defaults (accessibility statement, audit retention, identity provider
// hint, breach-notification window).
//
// Regimes are stored as strings in `LicensePermissions.complianceRegimes`
// (license JSONB). Adding a new regime = adding an entry here, not a
// migration. Per-entity tables never carry country/regime columns;
// regime-aware behavior reads through this registry.
//
// To resolve "which regimes apply to institute X", read the active license
// on X and look up each slug here. Helpers in this file do that resolution.

export type RegimeSlug =
  // Israeli Ministry of Education (Sapakim portal, IS 5568, Privacy Protection Law)
  | "il_moe"
  // Israeli Ministry of Health (PHI / medical records)
  | "il_health"
  // Israeli general consumer privacy (no MoE/MoH overlay)
  | "il_general"
  // US K-12 / FERPA
  | "us_ferpa"
  // US healthcare PHI / HIPAA
  | "us_hipaa"
  // US children's online privacy / COPPA
  | "us_coppa"
  // US Section 508 federal accessibility
  | "us_section_508"
  // EU GDPR (general)
  | "eu_gdpr"
  // EU EN 301 549 accessibility
  | "eu_en_301_549"
  // UK Department for Education / data protection
  | "uk_dfe"
  // UK Public Sector Bodies Accessibility Regs 2018
  | "uk_pba_2018";

export type AccessibilityStandard =
  | "wcag_2_1_aa"
  | "wcag_2_2_aa"
  | "il_5568"          // Israeli IS 5568 (defers to WCAG 2.1 AA)
  | "us_section_508"
  | "eu_en_301_549"
  | "uk_pba_2018";

export interface RegimeBundle {
  slug: RegimeSlug;
  /** Human-readable label for admin UIs. */
  label: string;
  /** ISO-3166-1 alpha-2 country (uppercase). Informational only. */
  country: string;
  /** Accessibility standard claimed in the statement page. */
  accessibilityStandard: AccessibilityStandard;
  /** Days a PHI/audit record must be retained at minimum. */
  auditRetentionDays: number;
  /** Breach-notification window in hours from awareness. */
  breachNotificationHours: number;
  /** Hint to the identity-provider system: which `instituteIdType` slug
   *  this regime expects (consumed by §1 SSO). Null = no specific IdP. */
  identityProviderHint: string | null;
  /** Whether the regime requires a signed accessibility statement. */
  requiresSignedAccessibilityStatement: boolean;
  /** Whether the regime requires PHI residency in-country. */
  requiresInCountryResidency: boolean;
}

const REGISTRY: Record<RegimeSlug, RegimeBundle> = {
  il_moe: {
    slug: "il_moe",
    label: "Israel — Ministry of Education",
    country: "IL",
    accessibilityStandard: "il_5568",
    auditRetentionDays: 7 * 365,
    breachNotificationHours: 30 * 24, // IL Privacy Protection Law: ~30 days
    identityProviderHint: "il_moe",
    requiresSignedAccessibilityStatement: true,
    requiresInCountryResidency: true,
  },
  il_health: {
    slug: "il_health",
    label: "Israel — Ministry of Health",
    country: "IL",
    accessibilityStandard: "il_5568",
    auditRetentionDays: 7 * 365,
    breachNotificationHours: 30 * 24,
    identityProviderHint: "il_health",
    requiresSignedAccessibilityStatement: true,
    requiresInCountryResidency: true,
  },
  il_general: {
    slug: "il_general",
    label: "Israel — General",
    country: "IL",
    accessibilityStandard: "il_5568",
    auditRetentionDays: 365,
    breachNotificationHours: 30 * 24,
    identityProviderHint: null,
    requiresSignedAccessibilityStatement: true,
    requiresInCountryResidency: false,
  },
  us_ferpa: {
    slug: "us_ferpa",
    label: "US — FERPA (K-12)",
    country: "US",
    accessibilityStandard: "wcag_2_1_aa",
    auditRetentionDays: 5 * 365,
    breachNotificationHours: 60 * 24,
    identityProviderHint: null,
    requiresSignedAccessibilityStatement: false,
    requiresInCountryResidency: false,
  },
  us_hipaa: {
    slug: "us_hipaa",
    label: "US — HIPAA",
    country: "US",
    accessibilityStandard: "wcag_2_1_aa",
    auditRetentionDays: 6 * 365,
    breachNotificationHours: 60 * 24, // HIPAA: 60 days
    identityProviderHint: null,
    requiresSignedAccessibilityStatement: false,
    requiresInCountryResidency: false,
  },
  us_coppa: {
    slug: "us_coppa",
    label: "US — COPPA (under 13)",
    country: "US",
    accessibilityStandard: "wcag_2_1_aa",
    auditRetentionDays: 365,
    breachNotificationHours: 72,
    identityProviderHint: null,
    requiresSignedAccessibilityStatement: false,
    requiresInCountryResidency: false,
  },
  us_section_508: {
    slug: "us_section_508",
    label: "US — Section 508 (federal accessibility)",
    country: "US",
    accessibilityStandard: "us_section_508",
    auditRetentionDays: 365,
    breachNotificationHours: 72,
    identityProviderHint: null,
    requiresSignedAccessibilityStatement: true,
    requiresInCountryResidency: false,
  },
  eu_gdpr: {
    slug: "eu_gdpr",
    label: "EU — GDPR",
    country: "EU",
    accessibilityStandard: "eu_en_301_549",
    auditRetentionDays: 365,
    breachNotificationHours: 72, // GDPR Art. 33
    identityProviderHint: null,
    requiresSignedAccessibilityStatement: true,
    requiresInCountryResidency: true,
  },
  eu_en_301_549: {
    slug: "eu_en_301_549",
    label: "EU — EN 301 549 (accessibility)",
    country: "EU",
    accessibilityStandard: "eu_en_301_549",
    auditRetentionDays: 365,
    breachNotificationHours: 72,
    identityProviderHint: null,
    requiresSignedAccessibilityStatement: true,
    requiresInCountryResidency: false,
  },
  uk_dfe: {
    slug: "uk_dfe",
    label: "UK — Department for Education",
    country: "GB",
    accessibilityStandard: "uk_pba_2018",
    auditRetentionDays: 7 * 365,
    breachNotificationHours: 72,
    identityProviderHint: "uk_dfe",
    requiresSignedAccessibilityStatement: true,
    requiresInCountryResidency: false,
  },
  uk_pba_2018: {
    slug: "uk_pba_2018",
    label: "UK — Public Sector Bodies Accessibility Regs 2018",
    country: "GB",
    accessibilityStandard: "uk_pba_2018",
    auditRetentionDays: 365,
    breachNotificationHours: 72,
    identityProviderHint: null,
    requiresSignedAccessibilityStatement: true,
    requiresInCountryResidency: false,
  },
};

export const KNOWN_REGIMES: ReadonlyArray<RegimeSlug> = Object.keys(REGISTRY) as RegimeSlug[];

/** Return the bundle for a slug, or null if the slug is unknown. */
export function getRegimeBundle(slug: string): RegimeBundle | null {
  return (REGISTRY as Record<string, RegimeBundle>)[slug] ?? null;
}

/** Filter a string array to known regime slugs, dropping unknowns. */
export function normalizeRegimes(raw: ReadonlyArray<string> | null | undefined): RegimeSlug[] {
  if (!raw) return [];
  const seen = new Set<RegimeSlug>();
  for (const s of raw) {
    if (s in REGISTRY) seen.add(s as RegimeSlug);
  }
  return Array.from(seen);
}

/** Test whether a regime slug appears in a list. */
export function hasRegime(regimes: ReadonlyArray<string> | null | undefined, slug: RegimeSlug): boolean {
  if (!regimes) return false;
  return regimes.includes(slug);
}

/** Test whether any regime in the list belongs to a country. */
export function hasCountry(regimes: ReadonlyArray<string> | null | undefined, country: string): boolean {
  if (!regimes) return false;
  for (const s of regimes) {
    const b = getRegimeBundle(s);
    if (b && b.country === country) return true;
  }
  return false;
}

/** Resolve the strictest accessibility standard claimed across a set of regimes.
 *  "Strictness" here is ordering: WCAG 2.2 > WCAG 2.1 ≈ IS 5568 ≈ EN 301 549 > UK PBA > Section 508.
 *  When no regime is declared, falls back to wcag_2_1_aa as the platform default. */
export function resolveAccessibilityStandard(
  regimes: ReadonlyArray<string> | null | undefined,
): AccessibilityStandard {
  const order: Record<AccessibilityStandard, number> = {
    us_section_508: 1,
    uk_pba_2018: 2,
    il_5568: 3,
    eu_en_301_549: 3,
    wcag_2_1_aa: 3,
    wcag_2_2_aa: 4,
  };
  let best: AccessibilityStandard | null = null;
  for (const s of regimes ?? []) {
    const b = getRegimeBundle(s);
    if (!b) continue;
    if (best === null || order[b.accessibilityStandard] > order[best]) {
      best = b.accessibilityStandard;
    }
  }
  return best ?? "wcag_2_1_aa";
}

/** Resolve the strictest (longest) audit retention required across regimes. */
export function resolveAuditRetentionDays(
  regimes: ReadonlyArray<string> | null | undefined,
): number {
  let max = 0;
  for (const s of regimes ?? []) {
    const b = getRegimeBundle(s);
    if (b && b.auditRetentionDays > max) max = b.auditRetentionDays;
  }
  return max;
}

/** Resolve the shortest breach-notification window (most strict) in hours. */
export function resolveBreachNotificationHours(
  regimes: ReadonlyArray<string> | null | undefined,
): number | null {
  let min: number | null = null;
  for (const s of regimes ?? []) {
    const b = getRegimeBundle(s);
    if (b && (min === null || b.breachNotificationHours < min)) min = b.breachNotificationHours;
  }
  return min;
}
