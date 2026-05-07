import type { BillingRegime } from "@shared/license-permissions";

/**
 * Per-regime threshold rules for the Insurance Bridge module. The schema
 * stores totals only — these rules live on the surface so switching markets
 * is a config change, not a data migration.
 *
 * Each rule maps a totals row → an optional billing code label. The first
 * matching rule wins (highest threshold first). UI components read this
 * to render threshold pills and progress strips.
 */
export interface RtmThresholdRule {
  /** CPT code or local-market equivalent shown to the clinician. */
  code: string;
  /** Inclusive lower bound of `daysActive`. */
  minDaysActive: number;
  /** Inclusive upper bound of `daysActive`. Omit for "no upper bound". */
  maxDaysActive?: number;
  /** Short human description for tooltips. */
  description: string;
  /** Visual hint for the UI — pill color tier. */
  tier: "green" | "amber" | "none";
}

export interface ClinicianTimeRule {
  /** CPT code or local-market equivalent. */
  code: string;
  /** Inclusive lower bound of `totalMinutes`. */
  minMinutes: number;
  /** Inclusive upper bound of `totalMinutes`. Omit for "no upper bound". */
  maxMinutes?: number;
  /** Short human description for tooltips. */
  description: string;
  /** Whether the regime requires at least one interactive session in the period. */
  requiresInteractive: boolean;
  /** Visual hint for the UI — pill color tier. */
  tier: "green" | "amber" | "none";
}

export interface BillingRegimeConfig {
  regime: BillingRegime;
  /** Display label for the regime badge in the admin UI. */
  label: string;
  /** RTM rules ordered by descending priority (highest threshold first). */
  rtmRules: RtmThresholdRule[];
  /** Clinician review-time rules ordered by descending priority. */
  clinicianTimeRules: ClinicianTimeRule[];
  /** ISO currency code used for any reimbursement-amount displays. */
  currency: string | null;
}

const US_CPT: BillingRegimeConfig = {
  regime: "us_cpt",
  label: "US CPT",
  currency: "USD",
  rtmRules: [
    {
      code: "98977",
      minDaysActive: 16,
      description: "Remote therapeutic monitoring — 16+ days of device usage",
      tier: "green",
    },
    {
      code: "98985",
      minDaysActive: 2,
      maxDaysActive: 15,
      description: "Remote therapeutic monitoring — 2-15 days of device usage (2026 update)",
      tier: "amber",
    },
  ],
  clinicianTimeRules: [
    {
      code: "98980",
      minMinutes: 20,
      description: "RTM treatment management — 20+ minutes of professional time",
      requiresInteractive: true,
      tier: "green",
    },
    {
      code: "98979",
      minMinutes: 10,
      maxMinutes: 19,
      description: "RTM treatment management — first 10-19 minutes (requires ≥1 interactive session)",
      requiresInteractive: true,
      tier: "amber",
    },
  ],
};

const NONE: BillingRegimeConfig = {
  regime: "none",
  label: "No regime",
  currency: null,
  rtmRules: [],
  clinicianTimeRules: [],
};

const REGISTRY: Record<BillingRegime, BillingRegimeConfig> = {
  none: NONE,
  us_cpt: US_CPT,
};

export function getBillingRegimeConfig(regime: BillingRegime): BillingRegimeConfig {
  return REGISTRY[regime] ?? NONE;
}

/**
 * Resolve the highest-priority billing code a daysActive count satisfies
 * under the given regime. Returns null when no rule matches.
 */
export function resolveRtmCode(
  regime: BillingRegime,
  daysActive: number,
): RtmThresholdRule | null {
  const cfg = getBillingRegimeConfig(regime);
  for (const rule of cfg.rtmRules) {
    if (daysActive < rule.minDaysActive) continue;
    if (rule.maxDaysActive !== undefined && daysActive > rule.maxDaysActive) continue;
    return rule;
  }
  return null;
}

export interface ClinicianTimeResolution {
  rule: ClinicianTimeRule | null;
  /** True when a rule matches by minutes but is blocked because hadInteractive is false. */
  blockedByInteractive: boolean;
}

/**
 * Resolve the highest-priority clinician-time code for a totals row. Honors
 * the `requiresInteractive` gate — when a matching rule requires interaction
 * but `hadInteractive` is false, the result is `{ rule: null, blockedByInteractive: true }`
 * so the UI can explain *why* nothing's billable.
 */
export function resolveClinicianTimeCode(
  regime: BillingRegime,
  totalMinutes: number,
  hadInteractive: boolean,
): ClinicianTimeResolution {
  const cfg = getBillingRegimeConfig(regime);
  for (const rule of cfg.clinicianTimeRules) {
    if (totalMinutes < rule.minMinutes) continue;
    if (rule.maxMinutes !== undefined && totalMinutes > rule.maxMinutes) continue;
    if (rule.requiresInteractive && !hadInteractive) {
      return { rule: null, blockedByInteractive: true };
    }
    return { rule, blockedByInteractive: false };
  }
  return { rule: null, blockedByInteractive: false };
}
