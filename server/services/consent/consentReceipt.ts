// server/services/consent/consentReceipt.ts
//
// Auto-emails the signing parent a copy of the consent they just signed.
// Required by the ticket (PPA Feb-2026 "Right to Information" / transparency):
// after a successful sign the parent must receive their own record of what was
// authorized, when, and how to withdraw it.
//
// The send is best-effort and NEVER throws — a receipt failure must not fail
// the sign that already committed. Callers should `await` this BEFORE sending
// their HTTP response: on Lambda the container is frozen at response time, so
// a detached (non-awaited) send would be killed mid-flight.

import type { StudentConsentRecord } from "@shared/schema";
import { emailService } from "../emailService.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function optInSummary(consent: StudentConsentRecord): string[] {
  const on: string[] = [];
  if (consent.optInModelTraining) on.push("AI model training");
  if (consent.optInAdvertising) on.push("Advertising");
  if (consent.optInThirdPartyResearch) on.push("Third-party research");
  if (consent.optInMarketingComms) on.push("Product update emails");
  return on;
}

/**
 * Send the signed-consent receipt. Returns void and swallows all errors —
 * inspect logs for delivery failures. `to` may be null/empty (e.g. an SMS-only
 * contact with no email on file), in which case this is a no-op.
 */
export async function sendConsentReceipt(args: {
  to: string | null | undefined;
  studentName: string;
  consent: StudentConsentRecord;
}): Promise<void> {
  const to = args.to?.trim();
  if (!to) {
    // No email channel for this contact — nothing to send. Not an error.
    return;
  }

  try {
    const { consent, studentName } = args;
    const signedOn = consent.signedAt
      ? new Date(consent.signedAt).toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0];
    const optsOn = optInSummary(consent);
    const optsLine = optsOn.length > 0 ? optsOn.join(", ") : "None — all optional uses are off";

    const subject = `Your signed consent for ${studentName}'s clinical record`;

    const text = [
      `This is your copy of the informed consent you just signed.`,
      ``,
      `Child: ${studentName}`,
      `Signed on: ${signedOn}`,
      `Notice version: ${consent.consentTextVersion}`,
      `Verified via: ${consent.identityVerificationMethod}`,
      `Optional uses you allowed: ${optsLine}`,
      ``,
      `Keep this email for your records. Taking part is voluntary, and you can`,
      `withdraw this consent at any time by contacting the clinic. Withdrawing`,
      `stops further processing and revokes any data sharing that was authorized.`,
      ``,
      `Reference: ${consent.id}`,
    ].join("\n");

    const html =
      `<p>This is your copy of the informed consent you just signed.</p>` +
      `<table cellpadding="4" style="border-collapse:collapse">` +
      `<tr><td><strong>Child</strong></td><td>${escapeHtml(studentName)}</td></tr>` +
      `<tr><td><strong>Signed on</strong></td><td>${signedOn}</td></tr>` +
      `<tr><td><strong>Notice version</strong></td><td>${escapeHtml(consent.consentTextVersion)}</td></tr>` +
      `<tr><td><strong>Verified via</strong></td><td>${escapeHtml(consent.identityVerificationMethod)}</td></tr>` +
      `<tr><td><strong>Optional uses allowed</strong></td><td>${escapeHtml(optsLine)}</td></tr>` +
      `</table>` +
      `<p>Keep this email for your records. Taking part is voluntary, and you can ` +
      `withdraw this consent at any time by contacting the clinic. Withdrawing stops ` +
      `further processing and revokes any data sharing that was authorized.</p>` +
      `<p style="color:#888;font-size:12px">Reference: ${escapeHtml(consent.id)}</p>`;

    const result = await emailService.sendEmail({ to, subject, text, html });
    if (!result.success) {
      // Domain only — the address identifies the guardian.
      console.error(
        `[consentReceipt] Receipt send returned failure to=@${String(to).split("@")[1] ?? "?"} consent=${consent.id} error=${result.error ?? "unknown"}`,
      );
    }
  } catch (err) {
    console.error("[consentReceipt] Receipt dispatch failed:", err);
  }
}
