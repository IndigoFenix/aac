// Deadline arithmetic for data-subject access ("produce") and amendment
// ("correct") requests. AKIM appendix §18.3 / §18.4.
//
// Split out from dataSubjectRequestService for the same reason the incident
// register's deadlines are split out: this is the part that decides when we are
// late, it is pure, and it is the part most worth pinning. The service does the
// persistence; this file does the policy.
//
// ONE window, and it is ours rather than the regulator's. For records held on
// behalf of an institute we are a processor: the substantive answer — hand over
// the copy, change the field, refuse and say why — belongs to the customer. Our
// obligation is to get the request in front of them within 72 hours of it
// reaching us. Missing that is our failure even when the eventual answer is
// theirs and is given on time.
//
// The deadline is computed ONCE, at open, and stored on the row. Nothing here
// is called on read. If FORWARD_DEADLINE_HOURS changes next year, every request
// opened before the change still shows the deadline it was actually held to —
// which is the only version a regulator or a customer can hold us to.

/** Hours from receipt to forwarding the request to the controller. AKIM §18.3. */
export const FORWARD_DEADLINE_HOURS = 72;

/** How far ahead of the deadline the sweep starts warning. */
export const DEFAULT_WARNING_HORIZON_HOURS = 24;

export function addHours(from: Date, hours: number): Date {
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

/**
 * Freeze a request's forward deadline at open time.
 *
 * `hours` is a parameter only so tests and a future per-contract override can
 * supply one; production always uses the constant.
 */
export function computeForwardDeadline(
  receivedAt: Date,
  hours: number = FORWARD_DEADLINE_HOURS,
): Date {
  return addHours(receivedAt, hours);
}

/**
 * Human-readable handle used in e-mails and on the phone.
 *
 * Derived from the row's id rather than stored, so it cannot drift from the
 * row. Unlike the incident register there is no ordinal column: a DSR is
 * referenced by the people handling that one request, not quoted in a breach
 * notification, so the short id prefix is enough to disambiguate.
 */
export function requestReference(id: string): string {
  return `DSR-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

/**
 * `na`        — nothing owed: already forwarded, or the request is over.
 * `met`       — still owed, deadline comfortably ahead.
 * `approaching` — still owed, inside the warning horizon.
 * `overdue`   — still owed, deadline passed.
 */
export type ForwardState = "met" | "approaching" | "overdue" | "na";

/** Statuses where forwarding is no longer owed — a missed deadline is history. */
const TERMINAL_STATUSES = new Set(["fulfilled", "denied", "withdrawn"]);

/** The subset of a request row this module needs to judge lateness. */
export interface ForwardDeadlineBearing {
  status: string;
  forwardDeadlineAt: Date | null;
  forwardedAt: Date | null;
}

/**
 * Where this request stands against its forward deadline, as of `now`.
 *
 * A request that has been forwarded, or that ended without needing to be
 * (withdrawn, or fulfilled by us because we are the controller), returns `na`.
 * Re-alerting forever on a closed request's missed deadline trains people to
 * ignore the alert, which costs more than the reminder is worth — the miss
 * stays visible on the row.
 */
export function classifyForward(
  request: ForwardDeadlineBearing,
  now: Date = new Date(),
  withinHours: number = DEFAULT_WARNING_HORIZON_HOURS,
): ForwardState {
  if (request.forwardedAt) return "na";
  if (TERMINAL_STATUSES.has(request.status)) return "na";
  if (!request.forwardDeadlineAt) return "na";

  if (request.forwardDeadlineAt <= now) return "overdue";
  if (request.forwardDeadlineAt <= addHours(now, withinHours)) return "approaching";
  return "met";
}

/** Milliseconds left before the forward deadline; negative once it has passed. */
export function forwardTimeRemainingMs(
  request: ForwardDeadlineBearing,
  now: Date = new Date(),
): number | null {
  if (!request.forwardDeadlineAt) return null;
  return request.forwardDeadlineAt.getTime() - now.getTime();
}
