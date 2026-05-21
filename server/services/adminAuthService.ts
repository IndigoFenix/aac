/**
 * Admin Auth Service
 *
 * Bridges the `admin_users` table into the Passport login flow. The session's
 * identity is stored as a tagged value (`{ kind: 'admin' | 'user', id }`).
 * `admin_users` is fully self-contained as of migration 0107: password, MFA
 * secret, auth_provider, and google_id all live on the admin row, and the
 * legacy `users` row for each admin has been dropped. Downstream code
 * (`requireAdmin`, `isCustomerSupport`, license checks, etc.) reads
 * `user.isSystemAdmin` — we set that flag on the adapted pseudo-user so
 * those checks continue to work without modification.
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
 * Wraps an `admin_users` row in a `User`-shaped object. Auth fields
 * (password, MFA, authProvider, googleId) come straight from the admin row;
 * student/clinician-specific User fields (credits, biometric, etc.) get
 * sensible defaults since admins don't carry that state.
 */
export function adaptAdminAsUser(admin: AdminUser): AdminPseudoUser {
  const now = new Date();
  return {
    id: admin.id,
    email: admin.email ?? null,
    firstName: admin.firstName ?? null,
    lastName: admin.lastName ?? null,
    fullName: null,
    profileImageUrl: admin.profileImageUrl ?? null,
    userType: "admin",
    isAdmin: true,
    isSystemAdmin: true,
    isActive: true,
    onboardingStep: 3,
    credits: 0,
    subscriptionType: "enterprise",
    referralCode: null,
    referredById: null,
    mfaEnabled: admin.mfaEnabled ?? false,
    mfaSecret: admin.mfaSecret ?? null,
    mfaEnforcedByAdmin: admin.mfaEnforcedByAdmin ?? false,
    password: admin.password ?? null,
    authProvider: admin.authProvider ?? "email",
    googleId: admin.googleId ?? null,
    phone: null,
    phoneVerifiedAt: null,
    biometricDataId: null,
    externalStorage: null,
    chatMemory: {},
    chatCreditsUsed: 0,
    chatCreditsUpdated: now,
    subscriptionExpiresAt: null,
    lastActiveAt: admin.lastActiveAt ?? now,
    genCapOverride: null,
    dlCapOverride: null,
    storedBoardsCap: null,
    createdAt: admin.createdAt ?? now,
    updatedAt: admin.updatedAt ?? now,
    adminPermissions: admin.permissions ?? ["*"],
    _identityKind: "admin",
  } as AdminPseudoUser;
}

/**
 * Given a freshly-authenticated regular user, return the identity that should
 * actually be stored in the session. Kept for the rare path where a Passport
 * strategy or impersonation flow returns a bare `users` row whose email also
 * happens to belong to an admin — we promote to the admin identity. Direct
 * admin lookups (LocalStrategy/Google) call `adaptAdminAsUser` themselves.
 */
export async function resolveLoginIdentity(user: User): Promise<User | AdminPseudoUser> {
  if (!user?.email) return user;
  if ((user as any)?._identityKind === "admin") return user as AdminPseudoUser;
  const admin = await adminUserRepository.getByEmail(user.email);
  if (!admin) return user;
  return adaptAdminAsUser(admin);
}

/**
 * Check whether a pseudo-user came from `admin_users`.
 */
export function isAdminIdentity(user: unknown): user is AdminPseudoUser {
  return !!(user && typeof user === "object" && (user as any)._identityKind === "admin");
}
