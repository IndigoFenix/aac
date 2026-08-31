// The periodic access review nobody has to remember to run.
//
// AKIM §2.8 wants access revoked when it is no longer needed AND reviewed
// periodically. A register of accounts is not a review: something has to look
// at it on a schedule and put the result in front of a human. This is that
// something.
//
// Weekly, not daily: dormancy is measured in months, so a daily mail about the
// same 30 accounts is alert fatigue with extra steps. One message per week,
// only when there is something on the list.
//
// Auto-deactivation is deliberately narrow (see access-review-policy.ts for
// why it is off by default):
//   * never an admin_users row — every backoffice account going dormant at
//     once would lock the last door from the inside, with no API left to
//     re-open it;
//   * never a users row carrying isAdmin/isSystemAdmin — the admin shell rows
//     (adminAuthService.ensureAdminShellUser) are never "signed into" as
//     users, so they look permanently dormant and are not evidence of
//     anything.
// Both are still REPORTED. Reporting is the part that is always safe.

import { userRepository } from "../repositories/userRepository";
import { adminUserRepository } from "../repositories/adminUserRepository";
import { deleteUserSessions } from "./sessionInvalidation";
import { activityLogService } from "./activityLogService";
import {
  DORMANT_AFTER_DAYS,
  autoDeactivateAfterDays,
  classifyAccount,
  idleDays,
  shouldAutoDeactivate,
  type AccountClassification,
} from "./access-review-policy";
import {
  sendOperationalAlert,
  type OperationalAlertResult,
} from "./operationalAlert";

/** One line of the review. Personal data is held to id + email by design. */
export interface ReviewedAccount {
  kind: "user" | "admin";
  id: string;
  email: string | null;
  lastActiveAt: Date | null;
  idleDays: number | null;
  classification: AccountClassification;
  /** Why auto-deactivation skipped it, when it was otherwise eligible. */
  protectedReason?: "admin_account" | "system_admin";
}

export interface AccessReviewResult {
  /** Candidate rows examined (users idle past the cutoff + every admin row). */
  scanned: number;
  /** Everything on the review list — dormant and never-used. */
  flagged: ReviewedAccount[];
  /** The subset switched off on this run. Empty whenever the env switch is unset. */
  deactivated: ReviewedAccount[];
  /** The active threshold, or null when auto-deactivation is off. */
  autoDeactivateAfterDays: number | null;
  alerted: boolean;
}

/** The alert channel, injectable so tests never reach live SES. */
export type AlertSender = (
  subject: string,
  lines: string[],
) => Promise<OperationalAlertResult>;

export interface AccessReviewDeps {
  alert?: AlertSender;
}

function describe(account: ReviewedAccount): string {
  const last = account.lastActiveAt
    ? account.lastActiveAt.toISOString().slice(0, 10)
    : "never";
  const idle = account.idleDays === null ? "?" : `${account.idleDays}d`;
  return (
    `${account.kind.padEnd(5)} ${account.id}  ${account.email ?? "(no email)"}  ` +
    `last active ${last} (${idle} idle)  ${account.classification}` +
    (account.protectedReason ? `  [not auto-disabled: ${account.protectedReason}]` : "")
  );
}

/**
 * Run one access review.
 *
 * Never throws — it runs on a background timer where there is nobody to catch,
 * and a failure on one account must not stop the rest being reviewed.
 *
 * `deps.alert` exists because the test environment carries real SES
 * credentials: a review test running against the default sender would mail a
 * live "dormant accounts" list to the ops mailbox.
 */
export async function runAccessReview(
  now: Date = new Date(),
  deps: AccessReviewDeps = {},
): Promise<AccessReviewResult> {
  const alert: AlertSender =
    deps.alert ??
    ((subject, lines) =>
      sendOperationalAlert(subject, lines, { logPrefix: "[accessReview]" }));

  const threshold = autoDeactivateAfterDays();
  const cutoff = new Date(now.getTime() - DORMANT_AFTER_DAYS * 24 * 60 * 60 * 1000);

  const flagged: ReviewedAccount[] = [];
  const deactivated: ReviewedAccount[] = [];
  let scanned = 0;

  // ---- users -------------------------------------------------------------
  const candidates = await userRepository.listInactiveSince(cutoff);
  scanned += candidates.length;

  for (const user of candidates) {
    try {
      const classification = classifyAccount(user, now);
      if (classification === "active" || classification === "deactivated") continue;

      const entry: ReviewedAccount = {
        kind: "user",
        id: user.id,
        email: user.email ?? null,
        lastActiveAt: user.lastActiveAt ?? null,
        idleDays: idleDays(user, now),
        classification,
      };
      if (user.isSystemAdmin || user.isAdmin) entry.protectedReason = "system_admin";
      flagged.push(entry);

      if (!entry.protectedReason && shouldAutoDeactivate(user, now)) {
        await userRepository.updateUser(user.id, { isActive: false } as any);
        // Revocation has to end access NOW, not at cookie expiry — the same
        // contract removeMember has.
        await deleteUserSessions(user.id);
        activityLogService.log({
          userId: null,
          eventType: "update",
          subjectType1: "user",
          subjectId1: user.id,
          details: {
            isActive: { from: true, to: false },
            reason: "dormant",
            idleDays: entry.idleDays,
            thresholdDays: threshold,
          },
        });
        entry.classification = "deactivated";
        deactivated.push(entry);
      }
    } catch (err) {
      console.error(`[accessReview] user ${user.id} review failed:`, err);
    }
  }

  // ---- admins ------------------------------------------------------------
  // Reported, never auto-disabled. See the header note.
  try {
    const admins = await adminUserRepository.list();
    scanned += admins.length;
    for (const admin of admins) {
      const classification = classifyAccount(admin, now);
      if (classification === "active" || classification === "deactivated") continue;
      flagged.push({
        kind: "admin",
        id: admin.id,
        email: admin.email ?? null,
        lastActiveAt: admin.lastActiveAt ?? null,
        idleDays: idleDays(admin, now),
        classification,
        protectedReason: "admin_account",
      });
    }
  } catch (err) {
    console.error("[accessReview] admin review failed:", err);
  }

  // ---- report ------------------------------------------------------------
  let alerted = false;
  if (flagged.length > 0) {
    const subject =
      deactivated.length > 0
        ? `🔒 Access review: ${flagged.length} dormant account(s), ${deactivated.length} deactivated`
        : `⚠️ Access review: ${flagged.length} dormant account(s)`;

    const lines = [
      `Accounts with no sign-in for ${DORMANT_AFTER_DAYS}+ days, or never used.`,
      threshold === null
        ? "Automatic deactivation is OFF (DORMANT_AUTO_DEACTIVATE_DAYS unset) — this is a report, nothing was changed."
        : `Automatic deactivation is ON at ${threshold} days; ${deactivated.length} account(s) were disabled and their sessions evicted.`,
      "",
      ...flagged.map(describe),
      "",
      "Review each: an account that is no longer needed should be deactivated",
      "(PATCH /api/admin/users/:id { isActive: false }), and one that is still",
      "needed should simply be used — the next sign-in clears it from this list.",
    ];

    const result = await alert(subject, lines);
    alerted = result.sent;
  }

  return {
    scanned,
    flagged,
    deactivated,
    autoDeactivateAfterDays: threshold,
    alerted,
  };
}
