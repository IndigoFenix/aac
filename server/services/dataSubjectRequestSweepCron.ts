// The clock on data-subject requests. AKIM appendix §18.3.
//
// A register that merely STORES the 72-hour forward deadline is a record, not a
// control: something has to look at it and shout. Same reasoning as the
// security-incident sweep, and the same two phases so a deadline is met rather
// than merely reported as missed:
//   * approaching — inside the warning horizon, not yet late
//   * overdue     — past due, nothing forwarded
//
// HOURLY, not daily. A 72-hour window checked once a day can be blown by nearly
// a full day before anyone hears about it, which makes the alert useless for
// the deadline it exists to protect.
//
// De-duplication is a pair of columns on the request row (`lastAlertKind`,
// `lastAlertAt`) rather than a timeline table: a DSR has no event log of its
// own, and inventing one to hold two fields would be a table for the sake of
// symmetry. The columns survive a restart, which is the property that actually
// matters — under the multi-task ECS profile the process that alerted is often
// not the one that runs next. Escalation still gets through: a request that was
// warned about as `approaching` will alert again once it goes `overdue`,
// because the kind changed.

import {
  dataSubjectRequestService,
} from "./dataSubjectRequestService";
import {
  classifyForward,
  requestReference,
  DEFAULT_WARNING_HORIZON_HOURS,
  type ForwardState,
} from "./data-subject-deadlines";
import {
  sendOperationalAlert,
  type OperationalAlertResult,
} from "./operationalAlert";
import type { DataSubjectRequest } from "@shared/schema";

const WARNING_HORIZON_HOURS = Number(
  process.env.DATA_SUBJECT_WARNING_HORIZON_HOURS || DEFAULT_WARNING_HORIZON_HOURS,
);

export interface DataSubjectSweepFinding {
  requestId: string;
  reference: string;
  kind: string;
  studentId: string;
  phase: "approaching" | "overdue";
  deadlineAt: Date;
}

export interface DataSubjectSweepResult {
  scanned: number;
  /** Findings raised THIS run — already-announced ones are not repeated. */
  raised: DataSubjectSweepFinding[];
  /** Findings suppressed because the same phase was already announced. */
  suppressed: number;
  alerted: boolean;
}

/** The alert channel, injectable so tests never reach live SES. */
export type AlertSender = (
  subject: string,
  lines: string[],
) => Promise<OperationalAlertResult>;

export interface DataSubjectSweepDeps {
  alert?: AlertSender;
}

function phaseOf(state: ForwardState): "approaching" | "overdue" | null {
  return state === "approaching" || state === "overdue" ? state : null;
}

/**
 * Scan requests still awaiting a forward for deadlines that are approaching or
 * blown.
 *
 * Never throws — it runs on a background timer where there is nobody to catch.
 * A failure on one request must not stop the rest being checked.
 *
 * `deps.alert` exists because the test environment carries real SES
 * credentials: a sweep test running against the default sender would mail a
 * live "deadline missed" alert to the on-call mailbox.
 */
export async function runDataSubjectRequestSweep(
  now: Date = new Date(),
  deps: DataSubjectSweepDeps = {},
): Promise<DataSubjectSweepResult> {
  const alert: AlertSender =
    deps.alert ??
    ((subject, lines) =>
      sendOperationalAlert(subject, lines, {
        logPrefix: "[dataSubjectRequestSweep]",
      }));

  let pending: DataSubjectRequest[] = [];
  try {
    pending = await dataSubjectRequestService.listAwaitingForward();
  } catch (err) {
    console.error("[dataSubjectRequestSweep] could not list pending requests:", err);
    return { scanned: 0, raised: [], suppressed: 0, alerted: false };
  }

  const raised: DataSubjectSweepFinding[] = [];
  let suppressed = 0;

  for (const request of pending) {
    try {
      const phase = phaseOf(classifyForward(request, now, WARNING_HORIZON_HOURS));
      if (!phase) continue;
      if (request.lastAlertKind === phase) {
        suppressed++;
        continue;
      }
      await dataSubjectRequestService.recordAlert(request.id, phase, now);
      raised.push({
        requestId: request.id,
        reference: requestReference(request.id),
        kind: request.kind,
        studentId: request.studentId,
        phase,
        deadlineAt: request.forwardDeadlineAt,
      });
    } catch (err) {
      console.error(`[dataSubjectRequestSweep] request ${request.id} check failed:`, err);
    }
  }

  let alerted = false;
  if (raised.length > 0) {
    const overdueCount = raised.filter((f) => f.phase === "overdue").length;
    const subject =
      overdueCount > 0
        ? `🚨 Data-subject request forward deadline MISSED (${overdueCount})`
        : `⚠️ Data-subject request forward deadline approaching (${raised.length})`;

    const lines = [
      overdueCount > 0
        ? "One or more data-subject requests have passed the 72-hour forwarding deadline."
        : "One or more data-subject requests are approaching the 72-hour forwarding deadline.",
      "",
      // Deliberately no subject NAME: the ops mailbox is a wider audience than
      // the record. The reference and the student id are enough to act on.
      ...raised.map(
        (f) =>
          `${f.phase === "overdue" ? "OVERDUE" : "due    "} ${f.reference}  ` +
          `${f.kind}  due ${f.deadlineAt.toISOString()}  student ${f.studentId}`,
      ),
      "",
      "Forward the request to the controlling institute, then record it so this",
      "alert stops. An unforwarded request keeps counting as overdue.",
    ];

    const result = await alert(subject, lines);
    alerted = result.sent;
  }

  return { scanned: pending.length, raised, suppressed, alerted };
}
