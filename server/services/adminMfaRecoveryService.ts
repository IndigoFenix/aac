// server/services/adminMfaRecoveryService.ts
// MFA recovery for admins. Parallel to the recovery half of mfaService, but
// operates against admin_users via the admin-specific token table.

import { adminMfaRecoveryRepository } from "../repositories/adminMfaRecoveryRepository";
import { adminUserRepository } from "../repositories/adminUserRepository";
import { emailService } from "./emailService";

const RECOVERY_TOKEN_EXPIRY_MINUTES = 60;

interface AdminRecoveryRequestResult {
  success: boolean;
  error?: string;
  sendFailed?: boolean;
  sendError?: string;
}

class AdminMfaRecoveryService {
  /**
   * Send an MFA recovery email to an admin. Silent success if the email
   * doesn't match an admin with MFA enabled — never leak account existence.
   */
  async requestRecovery(
    email: string,
    baseUrl: string,
  ): Promise<AdminRecoveryRequestResult> {
    try {
      const admin = await adminUserRepository.getByEmail(email.toLowerCase());
      if (!admin || !admin.mfaEnabled) {
        return { success: true };
      }

      const { token, expiresAt } = await adminMfaRecoveryRepository.createRecoveryToken(
        admin.id,
        RECOVERY_TOKEN_EXPIRY_MINUTES,
      );

      const recoveryLink = `${baseUrl}/admin/mfa-recovery/${token}`;

      const sendResult = await emailService.sendMfaRecoveryEmail({
        email: admin.email ?? email,
        firstName: admin.firstName ?? undefined,
        recoveryLink,
        expiresAt,
      });

      if (!sendResult.success) {
        console.error(`Failed to send admin MFA recovery email to ${email}:`, sendResult.error);
        return { success: true, sendFailed: true, sendError: sendResult.error };
      }

      return { success: true };
    } catch (error) {
      console.error("Admin MFA recovery request error:", error);
      return { success: false, error: "Failed to process recovery request" };
    }
  }

  /**
   * Validate a recovery token without consuming it (used by the UI to
   * decide whether to render the "disable MFA" confirmation).
   */
  async validateToken(
    token: string,
  ): Promise<{ valid: boolean; email?: string; error?: string }> {
    const result = await adminMfaRecoveryRepository.validateToken(token);
    if (!result.valid || !result.admin) {
      return { valid: false, error: result.error };
    }

    const email = result.admin.email ?? "";
    const [localPart, domain] = email.split("@");
    const maskedLocal =
      localPart && localPart.length > 2
        ? localPart[0] + "***" + localPart[localPart.length - 1]
        : "***";
    const maskedEmail = domain ? `${maskedLocal}@${domain}` : maskedLocal;

    return { valid: true, email: maskedEmail };
  }

  /**
   * Complete recovery: disable MFA on the admin row and burn the token.
   */
  async completeRecovery(
    token: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await adminMfaRecoveryRepository.validateToken(token);
      if (!result.valid || !result.admin || !result.tokenRecord) {
        return { success: false, error: result.error || "Invalid recovery link" };
      }

      await adminUserRepository.update(result.admin.id, {
        mfaEnabled: false,
        mfaSecret: null,
      } as any);

      await adminMfaRecoveryRepository.markTokenUsed(result.tokenRecord.id);
      await adminMfaRecoveryRepository.invalidateAdminTokens(result.admin.id);

      console.log(`MFA disabled via recovery for admin ${result.admin.id}`);
      return { success: true };
    } catch (error) {
      console.error("Admin MFA recovery completion error:", error);
      return { success: false, error: "Failed to complete recovery" };
    }
  }

  async cleanupExpiredTokens(): Promise<number> {
    return adminMfaRecoveryRepository.cleanupExpiredTokens();
  }
}

export const adminMfaRecoveryService = new AdminMfaRecoveryService();
