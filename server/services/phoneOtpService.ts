// server/services/phoneOtpService.ts
// Phone OTP verification — generates 6-digit codes, dispatches via smsService,
// verifies user-supplied codes with attempt-cap and rate-limit. Used by the
// consent magic-link flow as the `verified_phone_otp` non-repudiation leg.

import { phoneOtpCodeRepository } from "../repositories/phoneOtpCodeRepository.js";
import { smsService } from "./smsService.js";
import type { PhoneOtpCode } from "@shared/schema";

export type PhoneOtpErrorCode =
  | "phone_invalid"
  | "rate_limited"
  | "send_failed"
  | "code_not_found"
  | "code_expired"
  | "code_already_used"
  | "code_attempts_exceeded"
  | "code_mismatch";

export class PhoneOtpError extends Error {
  readonly code: PhoneOtpErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: PhoneOtpErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.code = code;
    this.details = details;
    this.name = "PhoneOtpError";
  }
}

const TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 min
const RATE_LIMIT_MAX_REQUESTS = 5;
const FRESHNESS_WINDOW_MS = 15 * 60 * 1000; // verified OTP usable for 15 min

/**
 * Bypass code for dev/test. Only honored when smsService.isVerificationBypassEnabled()
 * returns true (which short-circuits in production). Lets test suites and local
 * dev exercise the flow without round-tripping a real SMS.
 */
const BYPASS_CODE = "000000";

class PhoneOtpService {
  /**
   * Generate + send an OTP. Rate-limited per (purpose, scopeId, phone).
   * Returns the OTP record id and expiry; never returns the plaintext code.
   */
  async request(args: {
    phone: string;
    purpose: string;
    scopeId: string | null;
  }): Promise<{ id: string; expiresAt: Date; bypass: boolean }> {
    const phone = normalizeE164(args.phone);
    if (!phone) throw new PhoneOtpError("phone_invalid");

    const recent = await phoneOtpCodeRepository.countRecent({
      purpose: args.purpose,
      scopeId: args.scopeId,
      phone,
      windowMs: RATE_LIMIT_WINDOW_MS,
    });
    if (recent >= RATE_LIMIT_MAX_REQUESTS) {
      throw new PhoneOtpError("rate_limited", undefined, {
        windowMinutes: RATE_LIMIT_WINDOW_MS / 60_000,
        maxRequests: RATE_LIMIT_MAX_REQUESTS,
      });
    }

    const bypass = smsService.isVerificationBypassEnabled();
    const code = bypass ? BYPASS_CODE : phoneOtpCodeRepository.generateCode();
    const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000);

    const row = await phoneOtpCodeRepository.create({
      phone,
      code,
      purpose: args.purpose,
      scopeId: args.scopeId,
      expiresAt,
      maxAttempts: MAX_ATTEMPTS,
    });

    if (bypass) {
      console.log(
        `[phoneOtpService] BYPASS active — accepting "${BYPASS_CODE}" for purpose=${args.purpose} scope=${args.scopeId ?? "null"} phone=${phone}`,
      );
      await phoneOtpCodeRepository.recordSendAttempt({
        id: row.id,
        provider: "bypass",
      });
      return { id: row.id, expiresAt, bypass: true };
    }

    const result = await smsService.sendOtp(phone, code);
    await phoneOtpCodeRepository.recordSendAttempt({
      id: row.id,
      providerMessageId: result.providerMessageId,
      provider: smsServiceProviderName(),
    });
    if (!result.success) {
      // Leave the row in place for audit; surface a clean error.
      throw new PhoneOtpError("send_failed", result.error);
    }

    return { id: row.id, expiresAt, bypass: false };
  }

  /**
   * Verify a user-submitted code. On success the OTP row is marked consumed
   * and returned. Downstream callers (consent sign) should consult
   * getRecentlyVerified() within the freshness window rather than re-verifying.
   */
  async verify(args: {
    phone: string;
    purpose: string;
    scopeId: string | null;
    code: string;
  }): Promise<PhoneOtpCode> {
    const phone = normalizeE164(args.phone);
    if (!phone) throw new PhoneOtpError("phone_invalid");

    const active = await phoneOtpCodeRepository.getActive({
      purpose: args.purpose,
      scopeId: args.scopeId,
      phone,
    });
    if (!active) throw new PhoneOtpError("code_not_found");
    if (active.expiresAt.getTime() <= Date.now()) {
      throw new PhoneOtpError("code_expired");
    }
    if (active.consumedAt) throw new PhoneOtpError("code_already_used");
    if (active.attempts >= active.maxAttempts) {
      throw new PhoneOtpError("code_attempts_exceeded");
    }

    const submittedHash = phoneOtpCodeRepository.hashCode(args.code.trim());
    if (submittedHash !== active.codeHash) {
      await phoneOtpCodeRepository.incrementAttempts(active.id);
      throw new PhoneOtpError("code_mismatch", undefined, {
        attemptsRemaining: Math.max(0, active.maxAttempts - active.attempts - 1),
      });
    }

    const consumed = await phoneOtpCodeRepository.markConsumed(active.id);
    return consumed ?? active;
  }

  /**
   * Returns the most recently consumed OTP row for the (purpose, scope, phone)
   * tuple if it falls within the freshness window. Used by sign endpoints to
   * confirm "this OTP was verified recently" without re-verifying.
   */
  async getRecentlyVerified(args: {
    phone: string;
    purpose: string;
    scopeId: string | null;
    freshnessMs?: number;
  }): Promise<PhoneOtpCode | null> {
    const phone = normalizeE164(args.phone);
    if (!phone) return null;
    const row = await phoneOtpCodeRepository.getMostRecentConsumed({
      purpose: args.purpose,
      scopeId: args.scopeId,
      phone,
    });
    if (!row || !row.consumedAt) return null;
    const ageMs = Date.now() - row.consumedAt.getTime();
    if (ageMs > (args.freshnessMs ?? FRESHNESS_WINDOW_MS)) return null;
    return row;
  }

  get freshnessWindowMs(): number {
    return FRESHNESS_WINDOW_MS;
  }

  get ttlMinutes(): number {
    return TTL_MINUTES;
  }
}

function normalizeE164(phone: string): string | null {
  const trimmed = phone.trim().replace(/[\s-()]/g, "");
  if (!/^\+[1-9]\d{6,14}$/.test(trimmed)) return null;
  return trimmed;
}

function smsServiceProviderName(): string {
  // smsService doesn't directly expose the provider name in the message
  // result, so we ask it. Keeps the service-level audit accurate.
  return smsService.getProviderName();
}

export const phoneOtpService = new PhoneOtpService();
