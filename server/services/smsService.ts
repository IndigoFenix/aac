// server/services/smsService.ts
// SMS service with pluggable providers. Default provider is a no-op that
// logs instead of sending — lets the rest of the system depend on the SMS
// surface in dev/test before any real send happens.
//
// Available providers:
//   - "console" (default): logs the message body, returns success.
//   - "sns":               AWS SNS Publish API (transactional class by default).
//
// To add a provider: implement SmsProvider in a new module and add a case
// to selectProvider() below.

import {
  SNSClient,
  PublishCommand,
  type MessageAttributeValue,
} from "@aws-sdk/client-sns";

interface SmsMessage {
  to: string; // E.164 (e.g. "+972541234567")
  body: string;
  category?: "otp" | "notification" | "verification" | "other";
}

interface SmsSendResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
}

interface SmsProvider {
  readonly name: string;
  isConfigured(): boolean;
  send(msg: SmsMessage): Promise<SmsSendResult>;
}

class ConsoleSmsProvider implements SmsProvider {
  readonly name = "console";
  isConfigured(): boolean {
    return true;
  }
  async send(msg: SmsMessage): Promise<SmsSendResult> {
    console.log(
      `[SMS console provider] to=${msg.to} category=${msg.category ?? "other"} body=${JSON.stringify(msg.body)}`,
    );
    return { success: true, providerMessageId: `console-${Date.now()}` };
  }
}

/**
 * AWS SNS provider. Uses the Publish API with per-message SMS attributes —
 * no Topic, no Subscription. Region defaults to us-east-1; override with
 * SMS_AWS_REGION (falls back to AWS_REGION). Optional SMS_SENDER_ID is
 * applied where the destination country supports it (most non-US markets).
 *
 * Defaults to the "Transactional" SMS class so OTPs are prioritized for
 * delivery. Pass category: "notification" to relax to "Promotional".
 */
class SnsSmsProvider implements SmsProvider {
  readonly name = "sns";
  private client: SNSClient;
  private senderId: string | undefined;
  private smsType: "Transactional" | "Promotional";

  constructor() {
    const region =
      process.env.SMS_AWS_REGION ||
      process.env.AWS_REGION ||
      process.env.AWS_SECRETS_REGION ||
      "us-east-1";
    this.client = new SNSClient({
      region,
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    });
    this.senderId = process.env.SMS_SENDER_ID || undefined;
    this.smsType =
      (process.env.SMS_DEFAULT_CLASS as "Transactional" | "Promotional") ||
      "Transactional";
  }

  isConfigured(): boolean {
    // SNS works with EC2/Lambda IAM-role creds, so we can't require explicit
    // keys. Region resolution above always returns a value.
    return true;
  }

  async send(msg: SmsMessage): Promise<SmsSendResult> {
    if (!/^\+[1-9]\d{6,14}$/.test(msg.to)) {
      return { success: false, error: "phone_not_e164" };
    }

    const attrs: Record<string, MessageAttributeValue> = {
      "AWS.SNS.SMS.SMSType": {
        DataType: "String",
        StringValue:
          msg.category === "notification" ? "Promotional" : this.smsType,
      },
    };
    if (this.senderId) {
      attrs["AWS.SNS.SMS.SenderID"] = {
        DataType: "String",
        StringValue: this.senderId,
      };
    }

    try {
      const out = await this.client.send(
        new PublishCommand({
          PhoneNumber: msg.to,
          Message: msg.body,
          MessageAttributes: attrs,
        }),
      );
      return { success: true, providerMessageId: out.MessageId };
    } catch (err: any) {
      console.error(
        `[SMS sns provider] publish failed to=${msg.to}: ${err?.name ?? "Error"}: ${err?.message ?? String(err)}`,
      );
      return {
        success: false,
        error: err?.name ?? err?.message ?? "sns_publish_failed",
      };
    }
  }
}

class SmsService {
  private provider: SmsProvider;

  constructor() {
    this.provider = this.selectProvider();
    console.log(`SMS service: using provider "${this.provider.name}"`);
  }

  private selectProvider(): SmsProvider {
    const providerName = (process.env.SMS_PROVIDER || "console").toLowerCase();
    switch (providerName) {
      case "sns":
        return new SnsSmsProvider();
      case "console":
        return new ConsoleSmsProvider();
      default:
        console.warn(
          `SMS service: unknown provider "${providerName}", falling back to console`,
        );
        return new ConsoleSmsProvider();
    }
  }

  /** For tests — swap the provider in place. */
  _setProviderForTesting(provider: SmsProvider): void {
    this.provider = provider;
  }

  /** For tests — read provider name. */
  getProviderName(): string {
    return this.provider.name;
  }

  isReady(): boolean {
    return this.provider.isConfigured();
  }

  /**
   * Whether OTP verification can be bypassed for testing/dev. Consent flows
   * that would otherwise require a real SMS round-trip should check this and,
   * when true, mark the consent record's nonRepudiationEvidence with
   * { bypassed: true, reason: 'sms_not_configured' } so audit can identify
   * non-production records. Refuses to enable when NODE_ENV is 'production'.
   */
  isVerificationBypassEnabled(): boolean {
    if (process.env.NODE_ENV === "production") return false;
    return process.env.SMS_VERIFICATION_BYPASS === "true";
  }

  /**
   * Send a one-time passcode. Caller is responsible for generating and storing
   * the OTP hash + expiry; this only delivers the code.
   */
  async sendOtp(to: string, code: string): Promise<SmsSendResult> {
    const body = `Your Aivota CliniAACian verification code is ${code}. It expires in 10 minutes. Do not share this code.`;
    return this.provider.send({ to, body, category: "otp" });
  }

  /**
   * Generic send. Prefer the typed helpers (sendOtp, etc.) when one fits.
   */
  async send(msg: SmsMessage): Promise<SmsSendResult> {
    return this.provider.send(msg);
  }
}

export const smsService = new SmsService();
export type { SmsMessage, SmsSendResult, SmsProvider };
