/**
 * Global email-transport safety net for the whole test process.
 *
 * `server/tests/setup.ts` installs `fakeSesClient` into the `emailService`
 * singleton (via `setSesClientForTesting`) once, before ANY suite's tests
 * run — so no test, regardless of what it imports or forgets to mock, can
 * reach live SES. `sendEmail()` still runs its normal validation/formatting
 * logic and returns its normal `{ success: true, messageId }` shape; only
 * the actual network call is replaced, with a canned response recorded here.
 *
 * Origin: a serial run of the consent suites made 30 real SES API calls —
 * all rejected only because the fixture addresses (`@test.local`,
 * `@example.test`) carry invalid TLDs, against production-region SES
 * credentials the test environment happens to hold. Per-suite injection
 * (`consentWithdrawalService`'s `setWithdrawalDispatcher`) still leaked,
 * because `sendConsentReceipt` reaches `emailService` directly, bypassing
 * that seam. This file is the one seam every path funnels through.
 *
 * A suite that cares whether (and what) an email was "sent" reads
 * `sentEmails` — no network round trip required to find out:
 *
 *   import { sentEmails, resetSentEmails } from '../helpers/email-mock.js';
 *   // ... call code that dispatches an invitation email ...
 *   expect(sentEmails).toHaveLength(1);
 *   expect(sentEmails[0].to).toBe('parent@test.local');
 *   expect(sentEmails[0].subject).toContain('consent');
 *
 * `setup.ts` clears `sentEmails` in a global `beforeEach`, so counts are
 * scoped to one test case, not the whole file.
 */

import type { SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { SesSendClient } from '../../services/emailService.js';

export interface RecordedEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  from: string;
  replyTo?: string;
}

/** Every email `emailService.sendEmail()` attempted to send, in order. */
export const sentEmails: RecordedEmail[] = [];

export function resetSentEmails(): void {
  sentEmails.length = 0;
}

let messageCounter = 0;

/**
 * Drop-in replacement for the SESv2Client `emailService` normally holds.
 * Reads the same `SendEmailCommand.input` shape the real service builds, so
 * it exercises the service's actual request-construction logic and only
 * fakes the bytes-over-HTTPS part.
 */
export const fakeSesClient: SesSendClient = {
  async send(command: SendEmailCommand): Promise<{ MessageId: string }> {
    const input: any = (command as any).input ?? command;
    messageCounter += 1;
    sentEmails.push({
      to: input?.Destination?.ToAddresses?.[0] ?? '',
      subject: input?.Content?.Simple?.Subject?.Data ?? '',
      text: input?.Content?.Simple?.Body?.Text?.Data ?? '',
      html: input?.Content?.Simple?.Body?.Html?.Data ?? '',
      from: input?.FromEmailAddress ?? '',
      replyTo: input?.ReplyToAddresses?.[0],
    });
    return { MessageId: `test-fake-message-${messageCounter}` };
  },
};
