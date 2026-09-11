/**
 * Global SMS-transport safety net — the SMS counterpart to email-mock.ts.
 *
 * `.env` sets `SMS_PROVIDER=sns` for this environment (parity with the real
 * deployed stack's config shape), so `smsService`'s singleton constructs a
 * real `SnsSmsProvider` — backed by the live AWS SNS Publish API — the
 * moment the module is imported, before any individual test file gets a
 * chance to mock it.
 *
 * Found while closing the SES leak (open-items C): `consent-invitation.test
 * .ts`'s "SMS-channel OTP gate" cases create an invitation with `channel:
 * 'sms'` and a real-E.164-shaped phone number, which dispatches through
 * `smsService.send()` unmocked. Some suites already protect themselves
 * (`phone-otp.test.ts` swaps in its own recorder via `_setProviderForTesting`;
 * `guided-setup-*.test.ts` mock the whole module) — this file is the seam
 * that protects every OTHER suite, the same way `email-mock.ts` does for SES.
 *
 * `smsService` already exposes `_setProviderForTesting()` for exactly this,
 * so no class change was needed here — only wiring it in globally.
 */

import type { SmsMessage, SmsProvider, SmsSendResult } from '../../services/smsService.js';

export interface RecordedSms {
  to: string;
  body: string;
  category?: SmsMessage['category'];
}

/** Every SMS `smsService.send()`/`sendOtp()` attempted to send, in order. */
export const sentSms: RecordedSms[] = [];

export function resetSentSms(): void {
  sentSms.length = 0;
}

let counter = 0;

export const fakeSmsProvider: SmsProvider = {
  name: 'test-fake',
  isConfigured(): boolean {
    return true;
  },
  async send(msg: SmsMessage): Promise<SmsSendResult> {
    counter += 1;
    sentSms.push({ to: msg.to, body: msg.body, category: msg.category });
    // Mirrors ConsoleSmsProvider's own log line — visible with DEBUG=1, and
    // doubles as direct evidence (in a test transcript) that a send reached
    // this fake rather than the real SnsSmsProvider.
    console.log(
      `[SMS test-fake provider] to=${msg.to} category=${msg.category ?? 'other'} providerMessageId=test-fake-sms-${counter}`,
    );
    return { success: true, providerMessageId: `test-fake-sms-${counter}` };
  },
};
