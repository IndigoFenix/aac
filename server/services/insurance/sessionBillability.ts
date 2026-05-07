import type { ChatSession } from "@shared/schema";

/**
 * Human-readable description of the billable-session rule. Surfaced in the
 * Insurance Bridge admin UI so the operator can see exactly what counts as
 * a billable session today, and so the rule doesn't become invisible tribal
 * knowledge. Update this string whenever `isSessionBillable` changes.
 */
export const BILLABLE_SESSION_RULE_DESCRIPTION =
  "A session counts toward RTM billing if it consumed any AI credits OR " +
  "logged more than one message exchange. Empty/aborted sessions are excluded.";

/**
 * Pluggable predicate: does this AAC session count toward RTM billing?
 *
 * v1 rule (kept simple intentionally): credits used > 0, OR more than one
 * message in the chat log. Both signals indicate the student actually
 * interacted — sessions that opened but recorded nothing are filtered out.
 *
 * Centralized so future tightening (e.g. "must include at least one
 * board_press utterance") is a single edit. Per-regime variations belong
 * here too — branch on the institute's `billingRegime` if/when they diverge.
 */
export function isSessionBillable(session: Pick<ChatSession, "creditsUsed" | "log">): boolean {
  if ((session.creditsUsed ?? 0) > 0) return true;
  const log = session.log;
  if (Array.isArray(log) && log.length > 1) return true;
  return false;
}
