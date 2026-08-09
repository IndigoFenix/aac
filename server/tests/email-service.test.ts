// Sender identity for transactional email (SES).
//
// Regression origin: the From address used to fall back through
// EMAIL_FROM → SMTP_FROM → SMTP_USER → a hardcoded alias. Long after the move
// off Gmail SMTP, deployed environments still carried SMTP_FROM/SMTP_USER = a
// real person's mailbox — so every invite, password reset and license email
// went out under that person's name, and nobody could see why. Separately,
// both the leftover address and the old hardcoded default were Google
// Workspace mailboxes/aliases, which Gmail resolves against the directory to
// render the owner's profile name no matter what display name we send.
//
// The rules these tests pin:
//   • EMAIL_FROM is the ONLY source of sender identity — no fallback chain.
//   • The default sender is not a human mailbox or a Workspace alias.
//   • Every send carries a Reply-To, because the sender is unattended.
//
// See docs/EMAIL.md.

import { jest } from "@jest/globals";
import { EmailService } from "../services/emailService";

/** Env keys these tests scribble on, restored after each case. */
const TOUCHED = [
  "EMAIL_FROM",
  "EMAIL_REPLY_TO",
  "SES_REGION",
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
 * Build a service with a stubbed SES client. We swap the client rather than
 * mocking the SDK module so the test exercises the real command input the
 * service constructs.
 */
function serviceWithStubbedTransport() {
  const service = new EmailService();
  const send = jest
    .fn<(cmd: any) => Promise<{ MessageId: string }>>()
    .mockResolvedValue({ MessageId: "msg_1" });
  (service as any).ses = { send };
  return { service, send };
}

/** The SendEmailCommand input of the n-th (default first) send call. */
function sentInput(send: jest.Mock, n = 0): any {
  return (send.mock.calls[n] as any[])[0].input;
}

const MESSAGE = {
  to: "clinician@example.com",
  subject: "Subject",
  text: "Body",
  html: "<p>Body</p>",
};

describe("sender identity", () => {
  it("uses EMAIL_FROM verbatim", () => {
    process.env.EMAIL_FROM = "Aivota <noreply@aivota.ai>";
    expect(new EmailService().getFromAddress()).toBe(
      "Aivota <noreply@aivota.ai>"
    );
  });

  it("trims surrounding whitespace on EMAIL_FROM", () => {
    process.env.EMAIL_FROM = "  Aivota <noreply@aivota.ai>  ";
    expect(new EmailService().getFromAddress()).toBe(
      "Aivota <noreply@aivota.ai>"
    );
  });

  it("IGNORES legacy SMTP_FROM / SMTP_USER", () => {
    // The exact shape of the original bug: no EMAIL_FROM, stale Gmail creds.
    process.env.SMTP_FROM = "opher@aivota.ai";
    process.env.SMTP_USER = "opher@aivota.ai";

    const from = new EmailService().getFromAddress();

    expect(from).not.toContain("opher@aivota.ai");
    expect(from).toBe("Aivota <noreply@aivota.ai>");
  });

  it("defaults to a non-human address with an explicit display name", () => {
    const from = new EmailService().getFromAddress();

    // noreply@ is not in the Workspace directory, so Gmail can't swap our
    // display name for a person's profile name. cs@ is an alias on a real
    // mailbox and would show its owner.
    expect(from).toMatch(/<noreply@aivota\.ai>$/);
    expect(from).not.toContain("cs@aivota.ai");
    expect(from).toMatch(/^Aivota </);
  });

  it("warns when settings from retired transports linger", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    process.env.EMAIL_FROM = "Aivota <noreply@aivota.ai>";
    process.env.SMTP_PASS = "app-password";
    process.env.RESEND_API_KEY = "re_dead_key";

    new EmailService();

    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("SMTP_PASS"))).toBe(true);
    expect(messages.some((m) => m.includes("RESEND_API_KEY"))).toBe(true);
  });
});

describe("send payload", () => {
  it("sends from EMAIL_FROM with a Reply-To", async () => {
    process.env.EMAIL_FROM = "Aivota <noreply@aivota.ai>";
    process.env.EMAIL_REPLY_TO = "cs@aivota.ai";
    const { service, send } = serviceWithStubbedTransport();

    const result = await service.sendEmail(MESSAGE);

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("msg_1");
    expect(send).toHaveBeenCalledTimes(1);
    const input = sentInput(send);
    expect(input.FromEmailAddress).toBe("Aivota <noreply@aivota.ai>");
    expect(input.ReplyToAddresses).toEqual(["cs@aivota.ai"]);
    expect(input.Destination.ToAddresses).toEqual([MESSAGE.to]);
  });

  it("always sets a Reply-To, since the sender is unattended", async () => {
    const { service, send } = serviceWithStubbedTransport();

    await service.sendEmail(MESSAGE);

    const input = sentInput(send);
    expect(input.ReplyToAddresses).toEqual(["cs@aivota.ai"]);
    expect(input.ReplyToAddresses[0]).not.toBe(input.FromEmailAddress);
  });

  it("honours EMAIL_REPLY_TO", async () => {
    process.env.EMAIL_REPLY_TO = "support@aivota.ai";
    const { service, send } = serviceWithStubbedTransport();

    await service.sendEmail(MESSAGE);

    expect(sentInput(send).ReplyToAddresses).toEqual(["support@aivota.ai"]);
  });

  it("declares UTF-8 charsets (subjects and bodies are often Hebrew)", async () => {
    const { service, send } = serviceWithStubbedTransport();

    await service.sendEmail({ ...MESSAGE, subject: "הוזמנת להצטרף" });

    const simple = sentInput(send).Content.Simple;
    expect(simple.Subject).toEqual({ Data: "הוזמנת להצטרף", Charset: "UTF-8" });
    expect(simple.Body.Text.Charset).toBe("UTF-8");
    expect(simple.Body.Html.Charset).toBe("UTF-8");
  });

  it("surfaces an SES rejection to the caller instead of throwing", async () => {
    const { service, send } = serviceWithStubbedTransport();
    const rejection = Object.assign(
      new Error("Email address is not verified."),
      { name: "MessageRejected" }
    );
    send.mockRejectedValue(rejection);
    jest.spyOn(console, "error").mockImplementation(() => {});

    const result = await service.sendEmail(MESSAGE);

    expect(result.success).toBe(false);
    expect(result.error).toContain("MessageRejected");
  });
});
