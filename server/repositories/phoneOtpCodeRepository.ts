// server/repositories/phoneOtpCodeRepository.ts
// Repository for short-lived phone OTP codes used by the consent-magic-link
// flow (and any other phone-verification need). See phoneOtpService for the
// lifecycle and the table comment in shared/schema-private.ts for design.

import crypto from "crypto";
import {
  phoneOtpCodes,
  type PhoneOtpCode,
} from "@shared/schema";
import { db } from "../db.js";
import { and, eq, isNull, gt, sql, desc } from "drizzle-orm";

const CODE_DIGITS = 6;

export class PhoneOtpCodeRepository {
  /** 6-digit numeric code, generated with crypto-strong randomness. */
  generateCode(): string {
    // Pull 4 bytes, convert to a number, mod by 10^N. Bias is negligible at 4
    // bytes range (2^32) over 10^6 (~0.0002% bias on the last digit).
    const buf = crypto.randomBytes(4);
    const n = buf.readUInt32BE(0) % 10 ** CODE_DIGITS;
    return n.toString().padStart(CODE_DIGITS, "0");
  }

  hashCode(code: string): string {
    return crypto.createHash("sha256").update(code).digest("hex");
  }

  async create(input: {
    phone: string;
    code: string;
    purpose: string;
    scopeId: string | null;
    expiresAt: Date;
    maxAttempts?: number;
  }): Promise<PhoneOtpCode> {
    const [row] = await db
      .insert(phoneOtpCodes)
      .values({
        phone: input.phone,
        codeHash: this.hashCode(input.code),
        purpose: input.purpose,
        scopeId: input.scopeId,
        expiresAt: input.expiresAt,
        maxAttempts: input.maxAttempts ?? 5,
      })
      .returning();
    return row;
  }

  /** Most recent active (unconsumed, unexpired) row for the scope+phone. */
  async getActive(args: {
    purpose: string;
    scopeId: string | null;
    phone: string;
  }): Promise<PhoneOtpCode | undefined> {
    const [row] = await db
      .select()
      .from(phoneOtpCodes)
      .where(
        and(
          eq(phoneOtpCodes.purpose, args.purpose),
          args.scopeId === null
            ? isNull(phoneOtpCodes.scopeId)
            : eq(phoneOtpCodes.scopeId, args.scopeId),
          eq(phoneOtpCodes.phone, args.phone),
          isNull(phoneOtpCodes.consumedAt),
          gt(phoneOtpCodes.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(phoneOtpCodes.createdAt))
      .limit(1);
    return row || undefined;
  }

  /** Most recent consumed row for the scope+phone — used by sign endpoint
   * to confirm OTP was verified within the freshness window. */
  async getMostRecentConsumed(args: {
    purpose: string;
    scopeId: string | null;
    phone: string;
  }): Promise<PhoneOtpCode | undefined> {
    const [row] = await db
      .select()
      .from(phoneOtpCodes)
      .where(
        and(
          eq(phoneOtpCodes.purpose, args.purpose),
          args.scopeId === null
            ? isNull(phoneOtpCodes.scopeId)
            : eq(phoneOtpCodes.scopeId, args.scopeId),
          eq(phoneOtpCodes.phone, args.phone),
          sql`consumed_at IS NOT NULL`,
        ),
      )
      .orderBy(desc(phoneOtpCodes.consumedAt))
      .limit(1);
    return row || undefined;
  }

  async incrementAttempts(id: string): Promise<PhoneOtpCode | undefined> {
    const [row] = await db
      .update(phoneOtpCodes)
      .set({
        attempts: sql`${phoneOtpCodes.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(phoneOtpCodes.id, id))
      .returning();
    return row || undefined;
  }

  async markConsumed(id: string): Promise<PhoneOtpCode | undefined> {
    const [row] = await db
      .update(phoneOtpCodes)
      .set({ consumedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(phoneOtpCodes.id, id), isNull(phoneOtpCodes.consumedAt)))
      .returning();
    return row || undefined;
  }

  async recordSendAttempt(args: {
    id: string;
    providerMessageId?: string;
    provider: string;
  }): Promise<void> {
    await db
      .update(phoneOtpCodes)
      .set({
        sendCount: sql`${phoneOtpCodes.sendCount} + 1`,
        lastProviderMessageId: args.providerMessageId ?? null,
        lastProvider: args.provider,
        updatedAt: new Date(),
      })
      .where(eq(phoneOtpCodes.id, args.id));
  }

  /**
   * Count how many OTP rows have been created for this scope+phone within the
   * given window. Used for rate-limiting requests.
   */
  async countRecent(args: {
    purpose: string;
    scopeId: string | null;
    phone: string;
    windowMs: number;
  }): Promise<number> {
    const since = new Date(Date.now() - args.windowMs);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(phoneOtpCodes)
      .where(
        and(
          eq(phoneOtpCodes.purpose, args.purpose),
          args.scopeId === null
            ? isNull(phoneOtpCodes.scopeId)
            : eq(phoneOtpCodes.scopeId, args.scopeId),
          eq(phoneOtpCodes.phone, args.phone),
          gt(phoneOtpCodes.createdAt, since),
        ),
      );
    return Number(count ?? 0);
  }
}

export const phoneOtpCodeRepository = new PhoneOtpCodeRepository();
