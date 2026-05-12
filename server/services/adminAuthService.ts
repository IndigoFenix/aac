/**
 * Admin Auth Service
 *
 * Bridges the `admin_users` table into the Passport login flow. The session's
 * identity is stored as a tagged value (`{ kind: 'admin' | 'user', id }`).
 * When a user logs in via Passport (local or Google), we check whether the
 * authenticated email matches an `admin_users` row; if so, the session is
 * established under the admin identity instead of the regular user. The
 * downstream code (`requireAdmin`, `isCustomerSupport`, license checks, etc.)
 * reads `user.isSystemAdmin` — we set that flag on the adapted pseudo-user so
 * those checks continue to work without modification.
 *
 * Existing system admins keep their `users` row so password + MFA verification
 * continues to operate against it; the admin row carries the same `id` (set
 * by migration 0104), so audit/log references remain stable.
 */

import type { User, AdminUser } from "@shared/schema";
import { adminUserRepository } from "../repositories/adminUserRepository";

export type SessionIdentity =
  | { kind: "admin"; id: string }
  | { kind: "user"; id: string };

/**
 * A pseudo-`User` synthesized from an `admin_users` row. Carries enough of the
 * User shape to satisfy downstream consumers (`isSystemAdmin`, `isAdmin`,
 * `email`, etc.), plus an `adminPermissions` array and an `_identityKind`
 * tag so callers that care can tell the two apart.
 */
export type AdminPseudoUser = User & {
  adminPermissions: string[];
  _identityKind: "admin";
};

/**
 * Wraps an `admin_users` row in a `User`-shaped object. The optional
 * `sourceUser` parameter is the matching `users` row (if one exists) — its
 * MFA/credit/auth-provider fields are carried over so flows that read those
 * fields off `req.user` still see consistent values.
 */
export function adaptAdminAsUser(admin: AdminUser, sourceUser?: User): AdminPseudoUser {
  const now = new Date();
  // Start from the source user (if any) so fields we don't explicitly override
  // (MFA, credits, biometric, etc.) keep their values.
  const base: any = sourceUser ? { ...sourceUser } : {};
  return {
    ...base,
    id: admin.id,
    email: admin.email ?? base.email ?? null,
    firstName: admin.firstName ?? base.firstName ?? null,
    lastName: admin.lastName ?? base.lastName ?? null,
    fullName: base.fullName ?? null,
    profileImageUrl: admin.profileImageUrl ?? base.profileImageUrl ?? null,
    userType: "admin",
    isAdmin: true,
    isSystemAdmin: true,
    isActive: base.isActive ?? true,
    onboardingStep: base.onboardingStep ?? 3,
    credits: base.credits ?? 0,
    subscriptionType: base.subscriptionType ?? "enterprise",
    referralCode: base.referralCode ?? null,
    referredById: base.referredById ?? null,
    mfaEnabled: base.mfaEnabled ?? false,
    mfaSecret: base.mfaSecret ?? null,
    mfaEnforcedByAdmin: base.mfaEnforcedByAdmin ?? false,
    password: base.password ?? null,
    authProvider: base.authProvider ?? "email",
    googleId: base.googleId ?? null,
    phone: base.phone ?? null,
    phoneVerifiedAt: base.phoneVerifiedAt ?? null,
    biometricDataId: base.biometricDataId ?? null,
    externalStorage: base.externalStorage ?? null,
    chatMemory: base.chatMemory ?? {},
    chatCreditsUsed: base.chatCreditsUsed ?? 0,
    chatCreditsUpdated: base.chatCreditsUpdated ?? now,
    subscriptionExpiresAt: base.subscriptionExpiresAt ?? null,
    lastActiveAt: base.lastActiveAt ?? now,
    genCapOverride: base.genCapOverride ?? null,
    dlCapOverride: base.dlCapOverride ?? null,
    storedBoardsCap: base.storedBoardsCap ?? null,
    createdAt: admin.createdAt ?? now,
    updatedAt: admin.updatedAt ?? now,
    adminPermissions: admin.permissions ?? ["*"],
    _identityKind: "admin",
  } as AdminPseudoUser;
}

/**
 * Given a freshly-authenticated regular user (returned by a Passport strategy
 * or impersonation flow), return the identity that should actually be stored
 * in the session. If the user's email matches an `admin_users` row, returns
 * the adapted admin pseudo-user; otherwise returns the user unchanged.
 */
export async function resolveLoginIdentity(user: User): Promise<User | AdminPseudoUser> {
  if (!user?.email) return user;
  const admin = await adminUserRepository.getByEmail(user.email);
  if (!admin) return user;
  return adaptAdminAsUser(admin, user);
}

/**
 * Check whether a pseudo-user came from `admin_users`.
 */
export function isAdminIdentity(user: unknown): user is AdminPseudoUser {
  return !!(user && typeof user === "object" && (user as any)._identityKind === "admin");
}
