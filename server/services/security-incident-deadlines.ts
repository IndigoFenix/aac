// Deadline arithmetic for the security incident register.
//
// Split out from securityIncidentService so it can be tested without a
// database: this is the part that decides when we are late, and it is the part
// most worth pinning. The service does the persistence; this file does the
// policy.
//
// Two windows, deliberately distinct:
//   * regulatory — from shared/regime/regimes.ts, strictest regime wins, may be
//     absent entirely if no regime is in play.
//   * contractual — a term in a specific customer's agreement. AKIM's is 48
//     hours (appendix §6.4). Another customer's may differ, or not exist.
//
// Both run from AWARENESS (discovery), not from occurrence. The investigation
// report (§6.3) is the exception: it runs from the event ENDING.

/** Contractual notice window in hours. AKIM appendix §6.4. */
export const DEFAULT_CONTRACTUAL_NOTIFY_HOURS = 48;

/** Days from the event ending to the investigation report. AKIM appendix §6.3. */
export const DEFAULT_INVESTIGATION_REPORT_DAYS = 3;

export function addHours(from: Date, hours: number): Date {
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

export function addDays(from: Date, days: number): Date {
  return addHours(from, days * 24);
}

/**
 * Human-readable handle used in e-mails and on the phone. Derived from the
 * row's ordinal rather than stored, so it cannot drift from the row.
 */
export function incidentReference(seq: number): string {
  return `INC-${String(seq).padStart(5, "0")}`;
}

export interface DeadlineInput {
  discoveredAt: Date;
  /** Hours from the regime resolver. Null when no regime imposes a window. */
  regulatorNotifyHours: number | null;
  /** Null when no contract imposes a window. */
  contractualNotifyHours: number | null;
}

export interface ComputedDeadlines {
  regulatorNotifyDueAt: Date | null;
  customerNotifyDueAt: Date | null;
}

/**
 * Freeze an incident's notification deadlines at open time.
 *
 * Computed once and stored, never re-derived on read: if the regime registry
 * changes next year, this incident must still show the deadline it was
 * actually held to.
 */
export function computeNotificationDeadlines(input: DeadlineInput): ComputedDeadlines {
  return {
    regulatorNotifyDueAt:
      input.regulatorNotifyHours === null
        ? null
        : addHours(input.discoveredAt, input.regulatorNotifyHours),
    customerNotifyDueAt:
      input.contractualNotifyHours === null
        ? null
        : addHours(input.discoveredAt, input.contractualNotifyHours),
  };
}

/** The §6.3 report window opens when the event ends, not when we found it. */
export function computeInvestigationReportDueAt(
  endedAt: Date | null,
  days: number = DEFAULT_INVESTIGATION_REPORT_DAYS,
): Date | null {
  return endedAt === null ? null : addDays(endedAt, days);
}

export type OverdueObligation = "regulator" | "customer" | "investigation_report";

/** The subset of an incident row this module needs to judge lateness. */
export interface DeadlineBearing {
  status: string;
  regulatorNotifyDueAt: Date | null;
  regulatorNotifiedAt: Date | null;
  customerNotifyDueAt: Date | null;
  customerNotifiedAt: Date | null;
  investigationReportDueAt: Date | null;
  investigationReportSentAt: Date | null;
}

/** Statuses whose missed deadlines are history rather than a live alarm. */
const TERMINAL_STATUSES = new Set(["closed", "dismissed"]);

/**
 * Which obligations are past due and unmet, as of `now`.
 *
 * A terminal incident returns nothing: re-alerting forever on a closed
 * incident's missed deadline trains people to ignore the alert, which costs
 * more than the reminder is worth. The miss stays visible on the row and in
 * the timeline.
 */
export function classifyOverdue(
  incident: DeadlineBearing,
  now: Date = new Date(),
): OverdueObligation[] {
  if (TERMINAL_STATUSES.has(incident.status)) return [];

  const overdue: OverdueObligation[] = [];
  if (
    incident.regulatorNotifyDueAt &&
    incident.regulatorNotifyDueAt <= now &&
    !incident.regulatorNotifiedAt
  ) {
    overdue.push("regulator");
  }
  if (
    incident.customerNotifyDueAt &&
    incident.customerNotifyDueAt <= now &&
    !incident.customerNotifiedAt
  ) {
    overdue.push("customer");
  }
  if (
    incident.investigationReportDueAt &&
    incident.investigationReportDueAt <= now &&
    !incident.investigationReportSentAt
  ) {
    overdue.push("investigation_report");
  }
  return overdue;
}

/**
 * Obligations due within `withinHours` but not yet late — what the sweep warns
 * on so a deadline is met rather than merely reported as missed.
 */
export function classifyApproaching(
  incident: DeadlineBearing,
  now: Date = new Date(),
  withinHours = 12,
): OverdueObligation[] {
  if (TERMINAL_STATUSES.has(incident.status)) return [];
  const horizon = addHours(now, withinHours);

  const approaching: OverdueObligation[] = [];
  const check = (
    due: Date | null,
    done: Date | null,
    label: OverdueObligation,
  ) => {
    if (due && !done && due > now && due <= horizon) approaching.push(label);
  };
  check(incident.regulatorNotifyDueAt, incident.regulatorNotifiedAt, "regulator");
  check(incident.customerNotifyDueAt, incident.customerNotifiedAt, "customer");
  check(
    incident.investigationReportDueAt,
    incident.investigationReportSentAt,
    "investigation_report",
  );
  return approaching;
}
