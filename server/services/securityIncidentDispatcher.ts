// Sends an incident notification, and records that it was sent.
//
// This is the caller `incidentTemplateService` never had. Before it, the
// service could render a counsel-reviewed notification and nothing anywhere
// would put it in an envelope — so meeting the AKIM appendix §6.4 48-hour
// notice was a manual act with no record that it happened.
//
// The composition is deliberately one-way:
//   securityIncidentService  — owns the record and the clock
//   incidentTemplateService  — owns the wording
//   emailService             — owns delivery
//   this file                — owns the ORDER, and the refusals
//
// Two refusals matter more than anything else here:
//
//   1. An unfilled template is never sent. If any `{token}` is still
//      unsubstituted the send is refused, because a breach notification that
//      reaches a customer reading "{remediation_summary}" is worse than one
//      that arrives an hour later. The caller can see exactly which tokens are
//      missing and supply them.
//
//   2. The clock is only stamped for a message that actually went out. A
//      partial failure across several recipients does not count as notified;
//      an unsent notification must keep showing as overdue.
//
// See docs/AKIM_REMEDIATION_PLAN.md.

import {
  fillIncidentTemplate,
  type IncidentTemplateLocale,
  type IncidentTemplateType,
} from "./incidentTemplateService";
import { emailService } from "./emailService";
import {
  securityIncidentService,
  type NotifiedParty,
} from "./securityIncidentService";
import { incidentReference } from "./security-incident-deadlines";
import type { SecurityIncident } from "@shared/schema";

/** The register's classification maps 1:1 onto a template file. */
const TEMPLATE_FOR_KIND: Record<SecurityIncident["kind"], IncidentTemplateType> = {
  phi_breach: "phi-breach",
  security_breach: "security-breach",
  vendor_incident: "vendor-incident",
};

export interface DispatchInput {
  incidentId: string;
  /** Who is being told. `investigation_report` stamps the §6.3 column. */
  target: NotifiedParty | "investigation_report";
  recipients: string[];
  locale?: IncidentTemplateLocale;
  /** Override the template implied by the incident's kind. */
  templateType?: IncidentTemplateType;
  /**
   * The narrative tokens a human has to write: what happened, what data was
   * involved, what we are doing about it. Merged over the facts derived from
   * the register row, so a caller can also correct a derived value.
   */
  vars?: Record<string, string>;
  actorAdminUserId?: string | null;
  /** Render and validate, but send nothing and stamp nothing. */
  dryRun?: boolean;
}

export type DispatchResult =
  | {
      ok: true;
      subject: string;
      text: string;
      recipients: string[];
      dryRun: boolean;
      incident: SecurityIncident | undefined;
    }
  | {
      ok: false;
      reason: "incident_not_found" | "no_recipients" | "unfilled_tokens" | "send_failed";
      /** Present on `unfilled_tokens` — exactly what the caller still owes. */
      missingTokens?: string[];
      /** Present on `send_failed` — who we could not reach. */
      failedRecipients?: string[];
      subject?: string;
      text?: string;
    };

function formatTimestamp(value: Date | null): string {
  // ISO-8601 UTC. Unambiguous across the parties who read these letters, and
  // it never renders as an empty string — an absent time reads as "unknown"
  // rather than silently disappearing from the sentence.
  return value ? value.toISOString().replace(/\.\d{3}Z$/, "Z") : "unknown";
}

/**
 * Facts the register already knows. Everything here is derived from the row so
 * a notification cannot contradict the record it is sent against.
 */
export function deriveTemplateVars(
  incident: SecurityIncident,
  now: Date = new Date(),
): Record<string, string> {
  return {
    incident_ref: incidentReference(incident.seq),
    incident_occurred_at: formatTimestamp(incident.occurredAt),
    incident_discovered_at: formatTimestamp(incident.discoveredAt),
    notification_sent_at: formatTimestamp(now),
    incident_summary: incident.description ?? "",
    affected_data_categories: incident.affectedScope ?? "",
    affected_subject_count:
      incident.affectedSubjectCount === null
        ? "unknown"
        : String(incident.affectedSubjectCount),
  };
}

/** How a message actually leaves. Injectable so tests never touch live SES. */
export type SendMail = (msg: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) => Promise<{ success: boolean; error?: string }>;

export interface DispatchDeps {
  sendMail?: SendMail;
}

/**
 * Render, validate, send, and stamp — in that order. Returns a discriminated
 * result rather than throwing: every caller is either an operator at 2am or a
 * background job, and both need the failure reason as data.
 *
 * `deps.sendMail` exists because the test environment carries real SES
 * credentials: a test that exercised the delivery path against the default
 * sender would mail a breach notification to whatever address it made up.
 */
export async function dispatchIncidentNotification(
  input: DispatchInput,
  deps: DispatchDeps = {},
): Promise<DispatchResult> {
  const sendMail: SendMail = deps.sendMail ?? ((msg) => emailService.sendEmail(msg));
  const incident = await securityIncidentService.getById(input.incidentId);
  if (!incident) return { ok: false, reason: "incident_not_found" };

  const recipients = input.recipients.filter((r) => r.trim().length > 0);
  if (recipients.length === 0) return { ok: false, reason: "no_recipients" };

  const templateType = input.templateType ?? TEMPLATE_FOR_KIND[incident.kind];
  const locale = input.locale ?? "he"; // AKIM is an Israeli counterparty.

  const filled = await fillIncidentTemplate(templateType, locale, {
    ...deriveTemplateVars(incident),
    ...(input.vars ?? {}),
  });

  // Refusal 1: never send a letter with holes in it.
  if (filled.missingTokens.length > 0) {
    return {
      ok: false,
      reason: "unfilled_tokens",
      missingTokens: filled.missingTokens,
      subject: filled.subject,
      text: filled.text,
    };
  }

  if (input.dryRun) {
    return {
      ok: true,
      subject: filled.subject,
      text: filled.text,
      recipients,
      dryRun: true,
      incident,
    };
  }

  const failedRecipients: string[] = [];
  for (const to of recipients) {
    try {
      const result = await sendMail({
        to,
        subject: filled.subject,
        text: filled.text,
        // Plain-text notification; the text body carries the content and the
        // HTML part exists so clients that demand one do not render blank.
        html: `<pre style="white-space:pre-wrap;font-family:inherit;">${filled.text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</pre>`,
      });
      if (!result.success) failedRecipients.push(to);
    } catch {
      failedRecipients.push(to);
    }
  }

  // Refusal 2: nothing delivered means nothing was notified. The obligation
  // stays overdue and the sweep keeps alerting, which is the correct outcome.
  if (failedRecipients.length === recipients.length) {
    return {
      ok: false,
      reason: "send_failed",
      failedRecipients,
      subject: filled.subject,
      text: filled.text,
    };
  }

  const delivered = recipients.filter((r) => !failedRecipients.includes(r));
  const detail = {
    channel: "email",
    recipients: delivered,
    templateType,
  };

  const updated =
    input.target === "investigation_report"
      ? await securityIncidentService.recordInvestigationReport(
          incident.id,
          detail,
          input.actorAdminUserId,
        )
      : await securityIncidentService.recordNotification(
          incident.id,
          input.target,
          detail,
          input.actorAdminUserId,
        );

  // A partial failure is stamped (some recipients were told) but must not be
  // invisible — the timeline carries who we could not reach.
  if (failedRecipients.length > 0) {
    await securityIncidentService.addNote(
      incident.id,
      `Delivery failed for: ${failedRecipients.join(", ")}`,
      input.actorAdminUserId,
    );
  }

  return {
    ok: true,
    subject: filled.subject,
    text: filled.text,
    recipients: delivered,
    dryRun: false,
    incident: updated,
  };
}
