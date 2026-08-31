// When does an account stop being an account someone still needs?
//
// AKIM §2.8 asks two separate things: that access is REVOKED when it is no
// longer needed, and that access is REVIEWED periodically. The two have very
// different risk profiles, so they are split here:
//
//   * The REVIEW list is always on. Naming an account dormant costs nothing
//     and is the input a human needs to decide anything.
//   * AUTO-DEACTIVATION is off unless `DORMANT_AUTO_DEACTIVATE_DAYS` is set.
//     Disabling a clinician in the middle of a school term because they were
//     on maternity leave for three months is a product decision, not a
//     security default. The switch exists so the decision can be made per
//     deployment rather than re-argued in code.
//
// Pure and DB-free on purpose: the thresholds and the boundaries are the part
// worth testing exhaustively, and they should be testable without Postgres.

/** Idle days after which an account appears on the periodic review list. */
export const DORMANT_AFTER_DAYS = 90;

/** Environment switch for automatic deactivation. Unset ⇒ report only. */
export const AUTO_DEACTIVATE_ENV_VAR = "DORMANT_AUTO_DEACTIVATE_DAYS";

export type AccountClassification =
  /** Signed in inside the dormancy window. */
  | "active"
  /** Signed in once, but not for `DORMANT_AFTER_DAYS`. */
  | "dormant"
  /** Provisioned and never used — an invitation nobody took up. */
  | "never_used"
  /** Already switched off; on the list as evidence, not as an action item. */
  | "deactivated";

/** The only fields any of this needs. Works for `users` and `admin_users`. */
export interface ReviewableAccount {
  lastActiveAt?: Date | string | null;
  createdAt?: Date | string | null;
  isActive?: boolean | null;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days between `from` and `now`. A future timestamp (clock skew between
 * tasks, a hand-edited row) yields 0 rather than a negative number, so it can
 * never make an account look MORE idle than it is.
 */
export function daysSince(
  from: Date | string | null | undefined,
  now: Date = new Date(),
): number | null {
  const d = toDate(from);
  if (!d) return null;
  const diff = now.getTime() - d.getTime();
  return diff <= 0 ? 0 : Math.floor(diff / MS_PER_DAY);
}

/**
 * The timestamp dormancy is measured from.
 *
 * `lastActiveAt` when there is one; otherwise `createdAt` — an account
 * provisioned two years ago and never signed into is not "new", and measuring
 * a never-used account from nothing would leave it permanently unreviewable.
 */
export function idleSince(account: ReviewableAccount): Date | null {
  return toDate(account.lastActiveAt) ?? toDate(account.createdAt);
}

/** Idle days by the same reference `classifyAccount` uses, or null if unknowable. */
export function idleDays(
  account: ReviewableAccount,
  now: Date = new Date(),
): number | null {
  return daysSince(idleSince(account), now);
}

/**
 * Classify one account for the review list.
 *
 * `deactivated` wins over everything: an account that is already off is not a
 * pending action, whatever its timestamps say.
 */
export function classifyAccount(
  account: ReviewableAccount,
  now: Date = new Date(),
): AccountClassification {
  // The column is NOT NULL default true; an absent flag means active, matching
  // `canAuthenticate()` in server/userAuth.ts. One rule, two places that must
  // not disagree about what "off" means.
  if (account.isActive === false) return "deactivated";

  const lastActive = toDate(account.lastActiveAt);
  if (!lastActive) return "never_used";

  const days = daysSince(lastActive, now) ?? 0;
  return days >= DORMANT_AFTER_DAYS ? "dormant" : "active";
}

/**
 * The auto-deactivation threshold in days, or null when the feature is off.
 *
 * Read at call time, never cached: a deployment flips this by restarting with
 * a different environment, and tests flip it between cases.
 *
 * A value that is not a positive finite number is treated as OFF rather than
 * as zero — a typo must not disable every account in the system.
 */
export function autoDeactivateAfterDays(): number | null {
  const raw = process.env[AUTO_DEACTIVATE_ENV_VAR];
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[accessReview] ignoring ${AUTO_DEACTIVATE_ENV_VAR}="${raw}" — expected a positive number of days; auto-deactivation stays OFF`,
    );
    return null;
  }
  return parsed;
}

/**
 * Should this account be switched off automatically on this run?
 *
 * False whenever the switch is unset — the default posture is "report it to a
 * human". Also false for an account already off, and for one whose idleness
 * cannot be established (no `lastActiveAt` AND no `createdAt`): we do not
 * revoke on missing evidence.
 */
export function shouldAutoDeactivate(
  account: ReviewableAccount,
  now: Date = new Date(),
): boolean {
  const threshold = autoDeactivateAfterDays();
  if (threshold === null) return false;
  if (account.isActive === false) return false;

  const days = idleDays(account, now);
  if (days === null) return false;
  return days >= threshold;
}
