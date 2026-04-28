/**
 * Phone-OTP service tests.
 *
 * Covers: request inserts hashed code + dispatches to smsService; verify
 * accepts the matching code and rejects mismatches/expired/exhausted; bypass
 * mode lets dev/test sign without round-tripping; getRecentlyVerified is the
 * source of truth for downstream sign endpoints.
 *
 * The smsService is swapped out with a recording fake so no real SMS is sent.
 */

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';

import { truncateAll, db } from '../helpers/db.js';
import { phoneOtpService } from '../../services/phoneOtpService.js';
import { phoneOtpCodeRepository } from '../../repositories/phoneOtpCodeRepository.js';
import { smsService } from '../../services/smsService.js';
import { phoneOtpCodes } from '@shared/schema';
import { eq } from 'drizzle-orm';

interface RecordedSend {
  to: string;
  body: string;
  category?: string;
}

class RecordingProvider {
  readonly name = 'recording';
  sends: RecordedSend[] = [];
  isConfigured() { return true; }
  async send(msg: { to: string; body: string; category?: string }) {
    this.sends.push({ to: msg.to, body: msg.body, category: msg.category });
    return { success: true, providerMessageId: `rec-${this.sends.length}` };
  }
}

let recorder: RecordingProvider;

beforeEach(() => {
  recorder = new RecordingProvider();
  (smsService as any)._setProviderForTesting(recorder);
  // Force bypass off for these tests so we exercise the real code paths.
  delete process.env.SMS_VERIFICATION_BYPASS;
});

const PHONE = '+972541234567';
const PURPOSE = 'consent_invitation';
const SCOPE = 'inv-test-1';

function extractCode(body: string): string {
  const m = body.match(/\b(\d{6})\b/);
  if (!m) throw new Error(`No 6-digit code in body: ${body}`);
  return m[1];
}

describe('phoneOtpService', () => {
  afterEach(truncateAll);

  describe('request', () => {
    it('inserts a hashed code, dispatches via SMS, records send fingerprint', async () => {
      const out = await phoneOtpService.request({
        phone: PHONE,
        purpose: PURPOSE,
        scopeId: SCOPE,
      });
      expect(out.id).toBeDefined();
      expect(out.bypass).toBe(false);
      expect(recorder.sends).toHaveLength(1);
      expect(recorder.sends[0].to).toBe(PHONE);
      expect(recorder.sends[0].category).toBe('otp');

      const [row] = await db
        .select()
        .from(phoneOtpCodes)
        .where(eq(phoneOtpCodes.id, out.id));
      // Plaintext code should never appear in the DB.
      const code = extractCode(recorder.sends[0].body);
      expect(row.codeHash).not.toBe(code);
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.sendCount).toBe(1);
      expect(row.lastProvider).toBe('recording');
    });

    it('rate-limits requests beyond the per-window cap', async () => {
      for (let i = 0; i < 5; i++) {
        await phoneOtpService.request({ phone: PHONE, purpose: PURPOSE, scopeId: SCOPE });
      }
      await expect(
        phoneOtpService.request({ phone: PHONE, purpose: PURPOSE, scopeId: SCOPE }),
      ).rejects.toMatchObject({ code: 'rate_limited' });
    });

    it('rejects malformed phone numbers', async () => {
      await expect(
        phoneOtpService.request({ phone: '5551212', purpose: PURPOSE, scopeId: SCOPE }),
      ).rejects.toMatchObject({ code: 'phone_invalid' });
    });
  });

  describe('verify', () => {
    it('accepts the matching code and marks consumed', async () => {
      await phoneOtpService.request({ phone: PHONE, purpose: PURPOSE, scopeId: SCOPE });
      const code = extractCode(recorder.sends[0].body);

      const consumed = await phoneOtpService.verify({
        phone: PHONE,
        purpose: PURPOSE,
        scopeId: SCOPE,
        code,
      });
      expect(consumed.consumedAt).not.toBeNull();
    });

    it('rejects a mismatched code and increments attempts', async () => {
      const { id } = await phoneOtpService.request({
        phone: PHONE,
        purpose: PURPOSE,
        scopeId: SCOPE,
      });

      await expect(
        phoneOtpService.verify({ phone: PHONE, purpose: PURPOSE, scopeId: SCOPE, code: '999999' }),
      ).rejects.toMatchObject({ code: 'code_mismatch' });

      const [row] = await db.select().from(phoneOtpCodes).where(eq(phoneOtpCodes.id, id));
      expect(row.attempts).toBe(1);
    });

    it('locks out after max attempts', async () => {
      await phoneOtpService.request({ phone: PHONE, purpose: PURPOSE, scopeId: SCOPE });
      for (let i = 0; i < 5; i++) {
        await expect(
          phoneOtpService.verify({ phone: PHONE, purpose: PURPOSE, scopeId: SCOPE, code: '000001' }),
        ).rejects.toMatchObject({ code: 'code_mismatch' });
      }
      // Even submitting the right code now hits the attempt cap.
      const real = extractCode(recorder.sends[0].body);
      await expect(
        phoneOtpService.verify({ phone: PHONE, purpose: PURPOSE, scopeId: SCOPE, code: real }),
      ).rejects.toMatchObject({ code: 'code_attempts_exceeded' });
    });

    it('refuses to verify an already-consumed code', async () => {
      await phoneOtpService.request({ phone: PHONE, purpose: PURPOSE, scopeId: SCOPE });
      const code = extractCode(recorder.sends[0].body);
      await phoneOtpService.verify({ phone: PHONE, purpose: PURPOSE, scopeId: SCOPE, code });
      await expect(
        phoneOtpService.verify({ phone: PHONE, purpose: PURPOSE, scopeId: SCOPE, code }),
      ).rejects.toMatchObject({ code: 'code_not_found' });
    });
  });

  describe('bypass mode', () => {
    it('accepts 000000 when SMS_VERIFICATION_BYPASS=true', async () => {
      const prev = process.env.SMS_VERIFICATION_BYPASS;
      const prevEnv = process.env.NODE_ENV;
      process.env.SMS_VERIFICATION_BYPASS = 'true';
      // Make sure we're not in production (the bypass refuses prod).
      process.env.NODE_ENV = 'test';
      try {
        const out = await phoneOtpService.request({
          phone: PHONE,
          purpose: PURPOSE,
          scopeId: SCOPE,
        });
        expect(out.bypass).toBe(true);
        // No real SMS dispatch — provider was bypassed.
        expect(recorder.sends).toHaveLength(0);

        const consumed = await phoneOtpService.verify({
          phone: PHONE,
          purpose: PURPOSE,
          scopeId: SCOPE,
          code: '000000',
        });
        expect(consumed.consumedAt).not.toBeNull();
      } finally {
        if (prev === undefined) delete process.env.SMS_VERIFICATION_BYPASS;
        else process.env.SMS_VERIFICATION_BYPASS = prev;
        if (prevEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prevEnv;
      }
    });
  });

  describe('getRecentlyVerified', () => {
    it('returns the consumed row within the freshness window', async () => {
      await phoneOtpService.request({ phone: PHONE, purpose: PURPOSE, scopeId: SCOPE });
      const code = extractCode(recorder.sends[0].body);
      await phoneOtpService.verify({ phone: PHONE, purpose: PURPOSE, scopeId: SCOPE, code });

      const fresh = await phoneOtpService.getRecentlyVerified({
        phone: PHONE,
        purpose: PURPOSE,
        scopeId: SCOPE,
      });
      expect(fresh).not.toBeNull();
      expect(fresh!.consumedAt).not.toBeNull();
    });

    it('returns null when no consumed row exists', async () => {
      await phoneOtpService.request({ phone: PHONE, purpose: PURPOSE, scopeId: SCOPE });
      const fresh = await phoneOtpService.getRecentlyVerified({
        phone: PHONE,
        purpose: PURPOSE,
        scopeId: SCOPE,
      });
      expect(fresh).toBeNull();
    });

    it('honors the freshnessMs override', async () => {
      await phoneOtpService.request({ phone: PHONE, purpose: PURPOSE, scopeId: SCOPE });
      const code = extractCode(recorder.sends[0].body);
      await phoneOtpService.verify({ phone: PHONE, purpose: PURPOSE, scopeId: SCOPE, code });

      // Window of 0 ms — anything should be stale.
      const stale = await phoneOtpService.getRecentlyVerified({
        phone: PHONE,
        purpose: PURPOSE,
        scopeId: SCOPE,
        freshnessMs: 0,
      });
      expect(stale).toBeNull();
    });
  });
});
