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
/**
 * Where the receipt's withdrawal link points.
 *
 * 🚨 THIS IS A REFERENCE URL, NOT A TOKEN. The consent record's id rides in the
 * fragment; opening it asks the server to MINT a fresh 72-hour single-use
 * withdrawal token and mail it to the address already on file. Holding this URL
 * therefore buys exactly one thing: an email to an address you must already
 * control. It is the password-reset shape.
 *
 * The alternative — putting a real withdrawal token in the receipt — was
 * rejected. `consentInvitationService` caps sign links at 72 hours on the PPA
 * Feb-2026 rule that a stale link in an inbox must not stay redeemable, and a
 * receipt is a document the guardian is explicitly told to KEEP, potentially for
 * years, and may forward to a co-parent, a lawyer or a school. A live token in
 * it would be a multi-year standing capability to terminate a child's AAC
 * session, held by everyone that email ever reached.
 *
 * The id is a `gen_random_uuid()` v4 (122 bits), so it is not guessable — but
 * the request endpoint answers identically for a real and a bogus reference
 * regardless, because "unguessable" is a reason not to fear brute force, not a
 * licence to answer questions about the one reference you were handed.
 *
 * The fragment (`#ref=`) is never sent to the server by the browser, so the
 * reference stays out of CDN/ALB access logs and Referer headers — the same
 * rule the sign link follows.
 */
function withdrawalUrl(consentId: string): string {
  const base = process.env.APP_URL || "https://aivota.ai";
  return `${base}/consent/withdraw#ref=${encodeURIComponent(consentId)}`;
}

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

    // GDPR Art. 7(3) — withdrawal must be as easy as giving. Giving was a link
    // in an email; this is the same. Both the self-serve route and the clinic
    // are named, because a guardian with no phone or email on file (or one who
    // simply prefers to speak to a person) still needs the second one.
    const withdrawLink = withdrawalUrl(consent.id);

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
      `withdraw this consent at any time. Withdrawing stops further processing`,
      `and revokes any data sharing that was authorized.`,
      ``,
      `To withdraw, open this page and we will send you a one-time confirmation`,
      `link at the email or phone number the clinic already has for you:`,
      withdrawLink,
      ``,
      `You can also withdraw by contacting the clinic.`,
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
      `withdraw this consent at any time. Withdrawing stops further processing and ` +
      `revokes any data sharing that was authorized.</p>` +
      `<p><a href="${withdrawLink}">Withdraw this consent</a> — we will send a ` +
      `one-time confirmation link to the email or phone number the clinic already ` +
      `has for you. You can also withdraw by contacting the clinic.</p>` +
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
