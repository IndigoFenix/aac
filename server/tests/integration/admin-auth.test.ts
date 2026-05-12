/**
 * Admin-first auth integration tests.
 *
 * Covers the rule that a user whose email matches an `admin_users` row signs
 * in under the admin identity (not the regular `users` row), while preserving
 * the customer-support flow that depends on `user.isSystemAdmin`.
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import { truncateAll } from "../helpers/db.js";
import { makeUser } from "../helpers/factories.js";
import { adminUserRepository } from "../../repositories/adminUserRepository.js";
import {
  resolveLoginIdentity,
  adaptAdminAsUser,
  isAdminIdentity,
} from "../../services/adminAuthService.js";
import { isCustomerSupport } from "../../services/customerSupportService.js";

describe("Admin-first login", () => {
  afterEach(truncateAll);

  it("returns the admin pseudo-user when the email matches admin_users", async () => {
    const user = await makeUser({ isSystemAdmin: true });
    await adminUserRepository.create({
      id: user.id,
      email: user.email!,
      firstName: user.firstName,
      lastName: user.lastName,
    } as any);

    const identity = await resolveLoginIdentity(user);

    expect(isAdminIdentity(identity)).toBe(true);
    expect(identity.id).toBe(user.id);
    expect(identity.email).toBe(user.email);
    expect((identity as any).adminPermissions).toEqual(["*"]);
    // Critical: downstream code still checks isSystemAdmin off req.user.
    expect((identity as any).isSystemAdmin).toBe(true);
    expect((identity as any).isAdmin).toBe(true);
  });

  it("returns the plain user when no admin_users row matches", async () => {
    const user = await makeUser();

    const identity = await resolveLoginIdentity(user);

    expect(isAdminIdentity(identity)).toBe(false);
    expect(identity.id).toBe(user.id);
    expect((identity as any).isSystemAdmin).toBe(false);
  });

  it("admin pseudo-user satisfies isCustomerSupport()", async () => {
    const user = await makeUser({ isSystemAdmin: true });
    const admin = await adminUserRepository.create({
      id: user.id,
      email: user.email!,
      firstName: user.firstName,
      lastName: user.lastName,
    } as any);

    const pseudo = adaptAdminAsUser(admin, user);

    expect(isCustomerSupport(pseudo)).toBe(true);
  });

  it("admin pseudo-user carries MFA fields from the source user row", async () => {
    const user = await makeUser({ isSystemAdmin: true });
    const admin = await adminUserRepository.create({
      id: user.id,
      email: user.email!,
    } as any);

    const pseudo = adaptAdminAsUser(admin, {
      ...user,
      mfaEnabled: true,
      mfaSecret: "encrypted-secret",
    } as any);

    expect(pseudo.mfaEnabled).toBe(true);
    expect(pseudo.mfaSecret).toBe("encrypted-secret");
  });

  it("works without a source user (admin added only to admin_users)", async () => {
    const admin = await adminUserRepository.create({
      id: "admin-no-user",
      email: "standalone-admin@test.local",
      firstName: "Stand",
      lastName: "Alone",
      permissions: ["personas", "voices"],
    } as any);

    const pseudo = adaptAdminAsUser(admin);

    expect(pseudo.id).toBe("admin-no-user");
    expect(pseudo.isSystemAdmin).toBe(true);
    expect((pseudo as any).adminPermissions).toEqual(["personas", "voices"]);
    expect(pseudo.mfaEnabled).toBe(false);
  });
});
