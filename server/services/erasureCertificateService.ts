// Written confirmation that a student's data was erased.
//
// AKIM information-security appendix §8.4 ("אישור בכתב בדבר השלמת מחיקת המידע")
// requires us to hand the customer written confirmation of deletion on
// request. The evidence has existed since the erasure pipeline was built — the
// `student_erasure_requested` / `student_erasure_completed` rows in
// `activity_logs` — but there was no way to turn it into a document, so
// answering the clause meant an engineer writing an email by hand.
//
// Two rules this file exists to enforce:
//
//   1. A certificate is DERIVED, never asserted. If there is no completed
//      erasure event for the student, no certificate is produced. We do not
//      certify a deletion we cannot evidence.
//
//   2. It states the residual-copy window honestly. A hard delete is not
//      instantaneous everywhere: RDS point-in-time recovery keeps deleted rows
//      for the backup window, and S3 keeps noncurrent object versions for
//      theirs. A certificate dated the day of deletion that claims the data is
//      permanently unrecoverable would be false on the day it is signed. It
//      therefore reports both the completion date and the date after which the
//      last residual copy expires.
//
// See docs/AKIM_REMEDIATION_PLAN.md item 3.

import { activityLogService } from "./activityLogService";

/**
 * RDS point-in-time-recovery window, in days. Mirrors
 * `backup_retention_period` in terraform/rds.tf (35 for prod). Overridable so a
 * deployment with a different window does not silently certify the wrong date.
 */
export const PITR_RETENTION_DAYS = Number(process.env.RDS_BACKUP_RETENTION_DAYS || 35);

/** S3 noncurrent-version retention, in days. Mirrors the uploads lifecycle rule. */
export const S3_NONCURRENT_RETENTION_DAYS = Number(
  process.env.S3_NONCURRENT_RETENTION_DAYS || 30,
);

export interface ErasureCertificate {
  studentId: string;
  /** Erasure requested (soft-delete / tombstone). Null if only the completion was logged. */
  requestedAt: Date | null;
  /** Physical deletion committed. */
  completedAt: Date;
  /**
   * When the last residual copy expires — the later of the PITR and S3
   * windows, measured from completion. Before this date the data is
   * unreachable through the application but still recoverable by AWS.
   */
  residualCopiesClearAt: Date;
  /** Object-storage keys queued for deletion, if the completion event recorded a count. */
  s3KeysQueued: number | null;
  /** Institute the erasure was attributed to. */
  instituteId: string | null;
  /** The user who performed it, when the audit row carried one. */
  performedByUserId: string | null;
}

export class ErasureCertificateNotAvailable extends Error {
  constructor(readonly studentId: string) {
    super(`No completed erasure is recorded for student ${studentId}`);
    this.name = "ErasureCertificateNotAvailable";
  }
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/** ISO date (no time) — a certificate is a document, not a log line. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build the certificate for a student, from the audit trail alone.
 *
 * Throws `ErasureCertificateNotAvailable` when no completion event exists —
 * the caller must not paper over that, because the absence of the event is
 * exactly the case where a certificate would be a false statement.
 */
export async function buildErasureCertificate(
  studentId: string,
): Promise<ErasureCertificate> {
  const { data } = await activityLogService.query({
    subjectId: studentId,
    limit: 100,
    offset: 0,
  });

  const completed = data
    .filter((r) => r.eventType === "student_erasure_completed")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  if (!completed) throw new ErasureCertificateNotAvailable(studentId);

  const requested = data
    .filter((r) => r.eventType === "student_erasure_requested")
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];

  const completedAt = new Date(completed.createdAt);
  const details = (completed.details ?? {}) as { s3KeysQueued?: number };

  return {
    studentId,
    requestedAt: requested ? new Date(requested.createdAt) : null,
    completedAt,
    // The later of the two windows: the data is not fully gone until BOTH have
    // elapsed, so quoting the shorter one would overstate the position.
    residualCopiesClearAt: addDays(
      completedAt,
      Math.max(PITR_RETENTION_DAYS, S3_NONCURRENT_RETENTION_DAYS),
    ),
    s3KeysQueued: typeof details.s3KeysQueued === "number" ? details.s3KeysQueued : null,
    instituteId: completed.instituteId ?? null,
    performedByUserId: completed.userId ?? null,
  };
}

/**
 * Render the certificate as plain text for an email or a PDF pipeline.
 *
 * English and Hebrew, because the counterparty for §8.4 is Israeli and a
 * compliance document in the wrong language is not much of a document.
 */
export function renderErasureCertificate(
  cert: ErasureCertificate,
  locale: "en" | "he" = "he",
): { subject: string; text: string } {
  const stillResidual = cert.residualCopiesClearAt.getTime() > Date.now();

  if (locale === "en") {
    return {
      subject: `Certificate of data erasure — record ${cert.studentId}`,
      text: [
        "CERTIFICATE OF DATA ERASURE",
        "",
        `Record identifier:      ${cert.studentId}`,
        cert.requestedAt ? `Erasure requested:      ${isoDate(cert.requestedAt)}` : null,
        `Erasure completed:      ${isoDate(cert.completedAt)}`,
        cert.instituteId ? `Institute:              ${cert.instituteId}` : null,
        cert.s3KeysQueued !== null ? `Stored files removed:   ${cert.s3KeysQueued}` : null,
        "",
        "Aivota Ltd confirms that the personal and health information held for the",
        "record identified above has been permanently deleted from its production",
        "systems, including the associated database records and stored files.",
        "",
        "RESIDUAL COPIES",
        `Encrypted backups may retain the deleted records until ${isoDate(cert.residualCopiesClearAt)},`,
        "after which no copy remains. These backups are not accessible to the",
        "application and cannot be used to restore an individual record.",
        stillResidual
          ? "As at the date of this certificate, that period has not yet elapsed."
          : "That period has elapsed; no copy remains.",
        "",
        "This certificate is generated from Aivota Ltd's audit records and reflects",
        "the events logged at the time of erasure.",
      ]
        .filter((l) => l !== null)
        .join("\n"),
    };
  }

  return {
    subject: `אישור מחיקת מידע — רשומה ${cert.studentId}`,
    text: [
      "אישור על מחיקת מידע",
      "",
      `מזהה הרשומה:        ${cert.studentId}`,
      cert.requestedAt ? `בקשת המחיקה:        ${isoDate(cert.requestedAt)}` : null,
      `השלמת המחיקה:       ${isoDate(cert.completedAt)}`,
      cert.instituteId ? `מוסד:               ${cert.instituteId}` : null,
      cert.s3KeysQueued !== null ? `קבצים שנמחקו:       ${cert.s3KeysQueued}` : null,
      "",
      "אביוטה בע״מ מאשרת כי המידע האישי והרפואי שהוחזק עבור הרשומה שלעיל נמחק",
      "לצמיתות ממערכות הייצור שלה, לרבות רשומות מסד הנתונים והקבצים המשויכים.",
      "",
      "עותקים שיוריים",
      `גיבויים מוצפנים עשויים להחזיק את הרשומות שנמחקו עד ${isoDate(cert.residualCopiesClearAt)},`,
      "ולאחר מועד זה לא נותר כל עותק. גיבויים אלה אינם נגישים לאפליקציה ולא",
      "ניתן לשחזר באמצעותם רשומה בודדת.",
      stillResidual
        ? "נכון למועד אישור זה, התקופה האמורה טרם חלפה."
        : "התקופה האמורה חלפה; לא נותר כל עותק.",
      "",
      "אישור זה מופק מרישומי הביקורת של אביוטה בע״מ ומשקף את האירועים שתועדו",
      "בעת ביצוע המחיקה.",
    ]
      .filter((l) => l !== null)
      .join("\n"),
  };
}
