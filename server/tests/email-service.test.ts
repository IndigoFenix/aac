// Sender identity for transactional email.
//
// Regression origin: the From address used to fall back through
// EMAIL_FROM → SMTP_FROM → SMTP_USER → "cs@aivota.ai". Long after the switch
// from Gmail SMTP to the Resend API, the deployed environments still carried
// SMTP_FROM/SMTP_USER = a real person's mailbox — so every invite, password
// reset and license email went out under that person's name, and nobody could
// see why. On top of that, both the leftover address and the hardcoded default
// were Google Workspace mailboxes/aliases, which Gmail resolves against the
// directory to render the owner's profile name no matter what display name we
// send.
//
// The rules these tests pin:
//   • EMAIL_FROM is the ONLY source of sender identity — no fallback chain.
//   • The default sender lives on the Resend-verified sending subdomain and is
//     not a human mailbox.
//   • Every send carries a Reply-To, because the sender is unattended.
//
// See docs/EMAIL.md.

import { jest } from "@jest/globals";
import { EmailService } from "../services/emailService";

/** Env keys these tests scribble on, restored after each case. */
const TOUCHED = [
  "EMAIL_FROM",
  "EMAIL_REPLY_TO",
  "RESEND_API_KEY",
  "SMTP_FROM",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_HOST",
  "SMTP_PORT",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
  // Quiet the boot-time warnings this service intentionally emits.
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  jest.restoreAllMocks();
});

/**
 * Build a service with a stubbed Resend client. We swap the transport rather
 * than mocking the `resend` module so the test exercises the real payload the
 * service hands to the SDK.
 */
function serviceWithStubbedTransport() {
  process.env.RESEND_API_KEY = "re_test_key";
  const service = new EmailService();
  const send = jest
    .fn<(payload: any) => Promise<{ data: { id: string }; error: null }>>()
    .mockResolvedValue({ data: { id: "msg_1" }, error: null });
  (service as any).resend = { emails: { send } };
  return { service, send };
}

const MESSAGE = {
  to: "clinician@example.com",
  subject: "Subject",
  text: "Body",
  html: "<p>Body</p>",
};

describe("sender identity", () => {
  it("uses EMAIL_FROM verbatim", () => {
    process.env.EMAIL_FROM = "Aivota <noreply@send.aivota.ai>";
    expect(new EmailService().getFromAddress()).toBe(
      "Aivota <noreply@send.aivota.ai>"
    );
  });

  it("trims surrounding whitespace on EMAIL_FROM", () => {
    process.env.EMAIL_FROM = "  Aivota <noreply@send.aivota.ai>  ";
    expect(new EmailService().getFromAddress()).toBe(
      "Aivota <noreply@send.aivota.ai>"
    );
  });

  it("IGNORES legacy SMTP_FROM / SMTP_USER", () => {
    // The exact shape of the original bug: no EMAIL_FROM, stale Gmail creds.
    process.env.SMTP_FROM = "opher@aivota.ai";
    process.env.SMTP_USER = "opher@aivota.ai";

    const from = new EmailService().getFromAddress();

    expect(from).not.toContain("opher@aivota.ai");
    expect(from).toBe("Aivota <noreply@send.aivota.ai>");
  });

  it("defaults to an address on the verified sending subdomain, not a Workspace mailbox", () => {
    const from = new EmailService().getFromAddress();

    // On the sending subdomain — the apex can never be Resend-verified
    // (its MX belongs to Google Workspace), so an apex From fails to send.
    expect(from).toMatch(/@send\.aivota\.ai>$/);
    // Not a human mailbox or an alias of one: Gmail would override the
    // display name with the directory owner's name.
    expect(from).not.toContain("cs@aivota.ai");
    // Display name present, so recipients see "Aivota" rather than a bare
    // address their client is free to label however it likes.
    expect(from).toMatch(/^Aivota </);
  });

  it("emits an explicit warning when legacy SMTP vars linger", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM = "Aivota <noreply@send.aivota.ai>";
    process.env.SMTP_PASS = "app-password";

    new EmailService();

    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("SMTP_PASS"))).toBe(true);
  });
});

describe("send payload", () => {
  it("sends from EMAIL_FROM with a Reply-To", async () => {
    process.env.EMAIL_FROM = "Aivota <noreply@send.aivota.ai>";
    process.env.EMAIL_REPLY_TO = "cs@aivota.ai";
    const { service, send } = serviceWithStubbedTransport();

    const result = await service.sendEmail(MESSAGE);

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = (send.mock.calls[0] as any[])[0];
    expect(payload.from).toBe("Aivota <noreply@send.aivota.ai>");
    expect(payload.replyTo).toBe("cs@aivota.ai");
  });

  it("always sets a Reply-To, since the sender is unattended", async () => {
    const { service, send } = serviceWithStubbedTransport();

    await service.sendEmail(MESSAGE);

    const payload = (send.mock.calls[0] as any[])[0];
    expect(payload.replyTo).toBe("cs@aivota.ai");
    expect(payload.replyTo).not.toBe(payload.from);
  });

  it("honours EMAIL_REPLY_TO", async () => {
    process.env.EMAIL_REPLY_TO = "support@aivota.ai";
    const { service, send } = serviceWithStubbedTransport();

    await service.sendEmail(MESSAGE);

    expect((send.mock.calls[0] as any[])[0].replyTo).toBe("support@aivota.ai");
  });

  it("reports a failure rather than sending when unconfigured", async () => {
    const service = new EmailService(); // no RESEND_API_KEY

    const result = await service.sendEmail(MESSAGE);

    expect(result.success).toBe(false);
    expect(service.isReady()).toBe(false);
  });

  it("surfaces a Resend validation_error to the caller", async () => {
    const { service, send } = serviceWithStubbedTransport();
    send.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "domain is not verified" },
    } as any);
    jest.spyOn(console, "error").mockImplementation(() => {});

    const result = await service.sendEmail(MESSAGE);

    expect(result.success).toBe(false);
    expect(result.error).toContain("validation_error");
  });
});
