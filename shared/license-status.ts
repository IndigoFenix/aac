/**
 * license-status — is this license live, and until when?
 *
 * Pure, dependency-free, and shared with the clients: the paywall the client
 * renders and the permissions the server resolves must agree about the same
 * row, and the only way to guarantee that is one function both call.
 *
 * Three rules that each look like an omission and are not:
 *
 *  1. A NULL EXPIRY IS PERPETUAL, NOT EXPIRED. Every license granted by an
 *     admin before billing existed has `subscriptionExpiresAt = null`. Reading
 *     null as "expired at the epoch" would cut off every existing customer the
 *     moment expiry enforcement shipped. Same for a trial with no
 *     `trialExpiresAt`: an open-ended trial keeps working.
 *
 *  2. PAID GETS A GRACE PERIOD, TRIAL DOES NOT. A card retry, a webhook that
 *     arrives late, a renewal that lands an hour after the old period ends —
 *     these are normal for a paying customer, so a paid license keeps working
 *     for {@link PAID_GRACE_DAYS} past its expiry. A trial has no renewal to be
 *     late, so its end date is the end.
 *
 *  3. `isActive = false` IS 'none', NOT 'expired'. Expired means "you had this
 *     and can buy it back"; inactive means an operator switched the row off,
 *     which is not a thing the customer can pay their way out of.
 */

export type LicenseStatus = "active" | "trial" | "expired" | "none";

/** Days a PAID license keeps working past `subscriptionExpiresAt`. See rule 2. */
export const PAID_GRACE_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The fields of a `licenses` row this module reads. Structural rather than the
 * Drizzle `License` type so the clients can call it with a JSON payload whose
 * dates are ISO strings.
 */
export interface LicenseStatusInput {
  isActive?: boolean | null;
  isTrial?: boolean | null;
  trialExpiresAt?: Date | string | null;
  subscriptionExpiresAt?: Date | string | null;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The date this license runs out — the trial end for a trial, the subscription
 * end for a paid one. Null means perpetual (rule 1).
 */
export function licenseExpiryDate(license: LicenseStatusInput): Date | null {
  return license.isTrial
    ? toDate(license.trialExpiresAt)
    : toDate(license.subscriptionExpiresAt);
}

/** Status of one license row at `now`. Pure; see the rules in the file header. */
export function computeLicenseStatus(
  license: LicenseStatusInput | null | undefined,
  now: Date = new Date(),
): LicenseStatus {
  if (!license) return "none";
  if (license.isActive === false) return "none";

  if (license.isTrial) {
    const ends = toDate(license.trialExpiresAt);
    if (!ends) return "trial"; // open-ended trial
    return ends.getTime() > now.getTime() ? "trial" : "expired";
  }

  const ends = toDate(license.subscriptionExpiresAt);
  if (!ends) return "active"; // perpetual / admin-granted
  return now.getTime() <= ends.getTime() + PAID_GRACE_DAYS * DAY_MS ? "active" : "expired";
}

/** True when the status still grants access. */
export function licenseStatusGrantsAccess(status: LicenseStatus): boolean {
  return status === "active" || status === "trial";
}

/**
 * Preference order when a party holds several licenses: a live one beats an
 * expired one, and an expired one beats nothing (it is what the paywall needs
 * in order to offer a pay button).
 */
export function licenseStatusRank(status: LicenseStatus): number {
  switch (status) {
    case "active":
      return 3;
    case "trial":
      return 2;
    case "expired":
      return 1;
    default:
      return 0;
  }
}
