// The clock that does not depend on anyone remembering.
//
// AKIM appendix §6.4 gives us 48 hours to notify and §6.3 gives us 3 days from
// the event ending to file the investigation report. A register that merely
// stores those deadlines is a record, not a control: something has to look at
// it and shout.
//
// Runs HOURLY, not daily like the other maintenance crons. A 48-hour window
// checked once a day can be blown by nearly 24 hours before anyone hears about
// it, which would make the alert useless for the deadline it exists to protect.
//
// Two phases, so a deadline is met rather than merely reported as missed:
//   * approaching — inside the warning horizon, not yet late
//   * missed      — past due with nothing sent
//
// Both are written to the incident timeline AND alerted, and both are
// idempotent: the timeline is checked before writing, so an hourly sweep does
// not produce an hourly alert for the same obligation. Alert fatigue would
// defeat the purpose as surely as no alert at all.

import { securityIncidentService } from "./securityIncidentService";
import {
  classifyApproaching,
  classifyOverdue,
  incidentReference,
  type OverdueObligation,
} from "./security-incident-deadlines";
import {
  sendOperationalAlert,
  type OperationalAlertResult,
} from "./operationalAlert";
import type { SecurityIncident, SecurityIncidentEvent } from "@shared/schema";

/** How far ahead of a deadline the first warning fires. */
const WARNING_HORIZON_HOURS = Number(
  process.env.SECURITY_INCIDENT_WARNING_HORIZON_HOURS || 12,
);

const OBLIGATION_LABEL: Record<OverdueObligation, string> = {
  regulator: "regulator notification",
  customer: "customer notification (contractual)",
  investigation_report: "investigation report",
};

export interface SweepFinding {
  incidentId: string;
  reference: string;
  title: string;
  obligation: OverdueObligation;
  phase: "approaching" | "missed";
  dueAt: Date | null;
}

export interface SweepResult {
  scanned: number;
  /** Findings raised THIS run — already-announced ones are not repeated. */
  raised: SweepFinding[];
  /** Findings that were already on the timeline from an earlier run. */
  suppressed: number;
  alerted: boolean;
}

function dueAtFor(
  incident: SecurityIncident,
  obligation: OverdueObligation,
): Date | null {
  switch (obligation) {
    case "regulator":
      return incident.regulatorNotifyDueAt;
    case "customer":
      return incident.customerNotifyDueAt;
    case "investigation_report":
      return incident.investigationReportDueAt;
  }
}

/**
 * Has this exact (obligation, phase) already been announced for this incident?
 *
 * Keyed off the timeline rather than a separate "last alerted" column: the
 * timeline is the record we already keep, and reusing it means the evidence
 * trail and the de-duplication cannot disagree about what was announced.
 */
function alreadyAnnounced(
  timeline: SecurityIncidentEvent[],
  obligation: OverdueObligation,
  phase: "approaching" | "missed",
): boolean {
  const kind = phase === "missed" ? "deadline_missed" : "deadline_warning";
  return timeline.some(
    (e) =>
      e.kind === kind &&
      (e.metadata as { obligation?: string } | null)?.obligation === obligation,
  );
}

/** The alert channel, injectable so tests never reach live SES. */
export type AlertSender = (
  subject: string,
  lines: string[],
) => Promise<OperationalAlertResult>;

export interface SweepDeps {
  alert?: AlertSender;
}

/**
 * Scan open incidents for deadlines that are approaching or blown.
 *
 * Never throws — it runs on a background timer where there is nobody to catch.
 * A failure on one incident must not stop the rest being checked.
 *
 * `deps.alert` exists because the test environment carries real SES
 * credentials: a sweep test running against the default sender would mail a
 * live "deadline missed" alert to the on-call mailbox.
 */
export async function runSecurityIncidentDeadlineSweep(
  now: Date = new Date(),
  deps: SweepDeps = {},
): Promise<SweepResult> {
  const alert: AlertSender =
    deps.alert ??
    ((subject, lines) =>
      sendOperationalAlert(subject, lines, {
        logPrefix: "[securityIncidentSweep]",
      }));
  const open = await securityIncidentService.listOpen();
  const raised: SweepFinding[] = [];
  let suppressed = 0;

  for (const incident of open) {
    try {
      const missed = classifyOverdue(incident, now);
      const approaching = classifyApproaching(incident, now, WARNING_HORIZON_HOURS);
      if (missed.length === 0 && approaching.length === 0) continue;

      const timeline = await securityIncidentService.getTimeline(incident.id);

      for (const [phase, obligations] of [
        ["missed", missed],
        ["approaching", approaching],
      ] as const) {
        for (const obligation of obligations) {
          if (alreadyAnnounced(timeline, obligation, phase)) {
            suppressed++;
            continue;
          }
          const dueAt = dueAtFor(incident, obligation);
          await securityIncidentService.recordDeadlineEvent(incident.id, {
            phase,
            obligation,
            dueAt,
          });
          raised.push({
            incidentId: incident.id,
            reference: incidentReference(incident.seq),
            title: incident.title,
            obligation,
            phase,
            dueAt,
          });
        }
      }
    } catch (err) {
      console.error(
        `[securityIncidentSweep] incident ${incident.id} check failed:`,
        err,
      );
    }
  }

  let alerted = false;
  if (raised.length > 0) {
    const missedCount = raised.filter((f) => f.phase === "missed").length;
    const subject =
      missedCount > 0
        ? `🚨 Security incident deadline MISSED (${missedCount})`
        : `⚠️ Security incident deadline approaching (${raised.length})`;

    const lines = [
      missedCount > 0
        ? "One or more incident notification deadlines have passed with nothing sent."
        : "One or more incident notification deadlines are approaching.",
      "",
      ...raised.map(
        (f) =>
          `${f.phase === "missed" ? "MISSED " : "due    "} ${f.reference}  ` +
          `${OBLIGATION_LABEL[f.obligation]}  ` +
          `${f.dueAt ? f.dueAt.toISOString() : "unknown"}  — ${f.title}`,
      ),
      "",
      "Open the incident register to send the notification, then record it so",
      "this alert stops. An unsent notification keeps counting as overdue.",
    ];

    const result = await alert(subject, lines);
    alerted = result.sent;
  }

  return { scanned: open.length, raised, suppressed, alerted };
}
