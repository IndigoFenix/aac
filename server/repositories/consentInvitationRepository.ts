// server/repositories/consentInvitationRepository.ts
// Repository for token-based consent invitations sent to parents who don't
// have a user account. The token IS the auth — see consentInvitationService.

import crypto from "crypto";
import {
  consentInvitations,
  type ConsentInvitation,
  type InsertConsentInvitation,
} from "@shared/schema";
import { db } from "../db.js";
import { and, eq, isNull, gt, sql } from "drizzle-orm";

/**
 * Same alphabet as the share-invite codes — unambiguous to type. 12 chars
 * over a 31-char alphabet is ~60 bits entropy; combined with a finite expiry
 * and unique-indexed hash lookup, online brute-force is infeasible.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 12;

export class ConsentInvitationRepository {
  generateCode(): string {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    let out = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return out;
  }

  hashCode(code: string): string {
    return crypto.createHash("sha256").update(code).digest("hex");
  }

  async create(
    input: Omit<InsertConsentInvitation, "codeHash"> & { codeHash?: string },
  ): Promise<{ invitation: ConsentInvitation; code: string }> {
    const code = this.generateCode();
    const codeHash = this.hashCode(code);
    const [row] = await db
      .insert(consentInvitations)
      .values({ ...input, codeHash })
      .returning();
    return { invitation: row, code };
  }

  async getById(id: string): Promise<ConsentInvitation | undefined> {
    const [row] = await db
      .select()
      .from(consentInvitations)
      .where(eq(consentInvitations.id, id));
    return row || undefined;
  }

  async getByCode(code: string): Promise<ConsentInvitation | undefined> {
    const [row] = await db
      .select()
      .from(consentInvitations)
      .where(eq(consentInvitations.codeHash, this.hashCode(code)));
    return row || undefined;
  }

  async listPendingForStudent(studentId: string): Promise<ConsentInvitation[]> {
    return db
      .select()
      .from(consentInvitations)
      .where(
        and(
          eq(consentInvitations.studentId, studentId),
          isNull(consentInvitations.redeemedAt),
          isNull(consentInvitations.revokedAt),
          gt(consentInvitations.expiresAt, new Date()),
        ),
      );
  }

  async markRedeemed(
    id: string,
    signedConsentId: string,
  ): Promise<ConsentInvitation | undefined> {
    const [row] = await db
      .update(consentInvitations)
      .set({ redeemedAt: new Date(), signedConsentId, updatedAt: new Date() })
      .where(
        and(
          eq(consentInvitations.id, id),
          isNull(consentInvitations.redeemedAt),
          isNull(consentInvitations.revokedAt),
        ),
      )
      .returning();
    return row || undefined;
  }

  /**
   * Atomically increment the ID-verify attempt counter and return the new
   * value. Used by the email-channel child-ID gate to cap brute force.
   */
  async incrementIdVerifyAttempts(id: string): Promise<number> {
    const [row] = await db
      .update(consentInvitations)
      .set({
        idVerifyAttempts: sql`${consentInvitations.idVerifyAttempts} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(consentInvitations.id, id))
      .returning({ attempts: consentInvitations.idVerifyAttempts });
    return row?.attempts ?? 0;
  }

  /** Stamp the invitation as having passed the child-ID knowledge check. */
  async markIdVerified(id: string): Promise<ConsentInvitation | undefined> {
    const [row] = await db
      .update(consentInvitations)
      .set({ idVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(consentInvitations.id, id))
      .returning();
    return row || undefined;
  }

  async revoke(
    id: string,
    revokedByUserId: string,
  ): Promise<ConsentInvitation | undefined> {
    const [row] = await db
      .update(consentInvitations)
      .set({ revokedAt: new Date(), revokedByUserId, updatedAt: new Date() })
      .where(
        and(
          eq(consentInvitations.id, id),
          isNull(consentInvitations.redeemedAt),
          isNull(consentInvitations.revokedAt),
        ),
      )
      .returning();
    return row || undefined;
  }
}

export const consentInvitationRepository = new ConsentInvitationRepository();
