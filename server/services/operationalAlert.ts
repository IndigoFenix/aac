// One way to get an operational alert in front of a human.
//
// Extracted from providerAlertService, which had the only copy: the security
// incident deadline sweep needs exactly the same capability, and a second
// hand-rolled HTML email shell is how two alert channels quietly drift apart.
//
// This is the APPLICATION-side alert path (SES → a mailbox). It is separate
// from the infrastructure alarm path (CloudWatch → SNS → `alert_email` in
// Terraform), which watches the platform rather than the domain. Both currently
// land in the same mailbox; keeping them distinct means either can be
// re-pointed without touching the other.

import { emailService } from "./emailService";

/** Where operational alerts go when a caller does not name a recipient. */
export const DEFAULT_OPS_ALERT_RECIPIENT =
  process.env.OPS_ALERT_EMAIL || "alerts@aivota.ai";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderHtml(text: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background-color:#f4f4f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;padding:20px;">
    <tr><td>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#dc2626;border-radius:12px 12px 0 0;padding:24px;text-align:center;">
        <tr><td><h1 style="color:#ffffff;margin:0;font-size:20px;">Aivota — Operational Alert</h1></td></tr>
      </table>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#ffffff;padding:32px 30px;border-radius:0 0 12px 12px;">
        <tr><td>
          <pre style="color:#18181b;font-size:14px;line-height:1.6;margin:0;white-space:pre-wrap;font-family:inherit;">${escapeHtml(text)}</pre>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();
}

export interface OperationalAlertResult {
  sent: boolean;
  /** Why it was not sent — for the caller's log line and for tests. */
  reason?: "email_not_configured" | "send_failed";
}

/**
 * Send an operational alert. Never throws: an alert that takes down the sweep
 * that raised it is worse than a missed alert, and every caller is on a
 * background path where there is nobody to catch.
 *
 * When e-mail is not configured (local dev, a task without SES credentials)
 * the alert is logged rather than dropped silently, so it is still visible in
 * CloudWatch.
 */
export async function sendOperationalAlert(
  subject: string,
  lines: string[],
  opts: { recipient?: string; logPrefix?: string } = {},
): Promise<OperationalAlertResult> {
  const recipient = opts.recipient || DEFAULT_OPS_ALERT_RECIPIENT;
  const prefix = opts.logPrefix ?? "[opsAlert]";
  const text = lines.join("\n");

  if (!emailService.isReady()) {
    console.warn(
      `${prefix} Email not configured; would have sent to ${recipient}: ${subject}\n${text}`,
    );
    return { sent: false, reason: "email_not_configured" };
  }

  try {
    await emailService.sendEmail({
      to: recipient,
      subject,
      text,
      html: renderHtml(text),
    });
    return { sent: true };
  } catch (err) {
    console.error(`${prefix} Failed to send alert "${subject}":`, err);
    return { sent: false, reason: "send_failed" };
  }
}
