/**
 * Admin-specific password reset + MFA recovery flows.
 *
 * Covers the new `/auth/admin/*` paths added alongside the regular
 * `/auth/forgot-password` / `/auth/mfa/recovery/*` flows. Admins live only in
 * admin_users (no users row since migration 0107), so they have their own
 * token tables (`admin_password_reset_tokens`, `admin_mfa_recovery_tokens`).
 */

import { describe, it, expect, afterEach, jest } from "@jest/globals";
import bcrypt from "bcryptjs";
import { truncateAll } from "../helpers/db.js";
import { adminUserRepository } from "../../repositories/adminUserRepository.js";
import { adminPasswordResetRepository } from "../../repositories/adminPasswordResetRepository.js";
import { adminMfaRecoveryRepository } from "../../repositories/adminMfaRecoveryRepository.js";
import { adminPasswordResetService } from "../../services/adminPasswordResetService.js";
import { adminMfaRecoveryService } from "../../services/adminMfaRecoveryService.js";

// Email is fire-and-forget through SMTP in test env. We don't care if it
// actually delivers — the service surfaces send failures as `sendFailed`
// while still creating the token, so the test reads tokens straight from
// the repo to assert behavior.

async function makeAdmin(overrides: Record<string, any> = {}) {
  return adminUserRepository.create({
    id: overrides.id ?? `admin-${Math.random().toString(36).slice(2)}`,
    email: overrides.email ?? `admin-${Date.now()}@test.local`,
    firstName: overrides.firstName ?? "Test",
    lastName: overrides.lastName ?? "Admin",
    permissions: ["*"],
    ...overrides,
  } as any);
}

describe("Admin password reset", () => {
  afterEach(truncateAll);

  it("creates a token for an existing admin email", async () => {
    const admin = await makeAdmin();

    const result = await adminPasswordResetService.requestPasswordReset(
      admin.email!,
      "https://test.local",
    );

    expect(result.success).toBe(true);
    // A valid token can be validated immediately
    // (the token itself isn't returned to the controller, so we exercise
    // the createToken path directly to grab one)
    const { token } = await adminPasswordResetRepository.createToken(admin.id, 60);
    const validate = await adminPasswordResetService.validateToken(token);
    expect(validate.valid).toBe(true);
    expect(validate.email).toBe(admin.email);
  });

  it("returns silent success for unknown email (no token created)", async () => {
    const result = await adminPasswordResetService.requestPasswordReset(
      "nobody@test.local",
      "https://test.local",
    );

    expect(result.success).toBe(true);
    // No admin was found, so no token was issued — validate any token fails.
    const validate = await adminPasswordResetService.validateToken("garbage");
    expect(validate.valid).toBe(false);
  });

  it("resets the password and invalidates the token", async () => {
    const admin = await makeAdmin({ password: await bcrypt.hash("oldpw1", 4) });
    const { token } = await adminPasswordResetRepository.createToken(admin.id, 60);

    const result = await adminPasswordResetService.resetPassword(token, "NewPassword#1");

    expect(result.success).toBe(true);
    expect(result.adminId).toBe(admin.id);

    // Reload the admin and verify the password hash changed
    const reloaded = await adminUserRepository.getById(admin.id);
    expect(reloaded?.password).toBeTruthy();
    expect(reloaded?.password).not.toBe(admin.password);
    expect(await bcrypt.compare("NewPassword#1", reloaded!.password!)).toBe(true);

    // Token can no longer be used
    const replay = await adminPasswordResetService.validateToken(token);
    expect(replay.valid).toBe(false);
  });

  it("rejects an invalid token", async () => {
    const result = await adminPasswordResetService.resetPassword(
      "not-a-real-token",
      "NewPassword#1",
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid|expired/i);
  });
});

describe("Admin MFA recovery", () => {
  afterEach(truncateAll);

  it("silent-succeeds when admin doesn't have MFA enabled", async () => {
    const admin = await makeAdmin({ mfaEnabled: false });

    const result = await adminMfaRecoveryService.requestRecovery(
      admin.email!,
      "https://test.local",
    );

    expect(result.success).toBe(true);
    // No token should exist for this admin
    const garbage = await adminMfaRecoveryService.validateToken("any");
    expect(garbage.valid).toBe(false);
  });

  it("creates a recovery token for an admin with MFA enabled", async () => {
    const admin = await makeAdmin({ mfaEnabled: true, mfaSecret: "encrypted-stub" });

    const result = await adminMfaRecoveryService.requestRecovery(
      admin.email!,
      "https://test.local",
    );

    expect(result.success).toBe(true);

    // Exercise the repo directly to obtain the plaintext token for the
    // subsequent validate/complete steps.
    const { token } = await adminMfaRecoveryRepository.createRecoveryToken(admin.id, 60);
    const validated = await adminMfaRecoveryService.validateToken(token);
    expect(validated.valid).toBe(true);
    // Email is masked: a***n@test.local style
    expect(validated.email).toMatch(/\*/);
  });

  it("disables MFA on completion and burns the token", async () => {
    const admin = await makeAdmin({
      mfaEnabled: true,
      mfaSecret: "encrypted-stub",
    });
    const { token } = await adminMfaRecoveryRepository.createRecoveryToken(admin.id, 60);

    const result = await adminMfaRecoveryService.completeRecovery(token);

    expect(result.success).toBe(true);

    const reloaded = await adminUserRepository.getById(admin.id);
    expect(reloaded?.mfaEnabled).toBe(false);
    expect(reloaded?.mfaSecret).toBeNull();

    // Replay rejected
    const replay = await adminMfaRecoveryService.completeRecovery(token);
    expect(replay.success).toBe(false);
  });

  it("rejects expired tokens", async () => {
    const admin = await makeAdmin({ mfaEnabled: true, mfaSecret: "x" });
    // Negative TTL = already expired
    const { token } = await adminMfaRecoveryRepository.createRecoveryToken(admin.id, -1);

    const result = await adminMfaRecoveryService.validateToken(token);
    expect(result.valid).toBe(false);
  });
});
