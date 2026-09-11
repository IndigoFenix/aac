// server/services/userView.ts
//
// POSITIVE ALLOWLISTS for every `users` row that leaves the admin API.
//
// Why a positive list rather than "delete password and mfaSecret":
// `userRepository.getAllUsers()` is `db.select().from(users)` followed by
// `hydrateRecords("users", rows)`, and that hydration is the external-storage
// REHYDRATOR, not a redaction step — `server/external-storage/registry.ts`
// declares the `users` core tier as
// `["email","firstName","lastName","fullName","password","mfaSecret","profileImageUrl"]`,
// so it actively pulls the externalised bcrypt hash and the encrypted TOTP seed
// BACK INTO the row object. A denylist of the two columns anyone happened to
// notice would be re-broken the next time a column is added to the table or to
// that tier. Here, a field that is not named below cannot be emitted at all.
//
// Found by the 2026-09-10 authorization audit (finding C1). See
// docs/SECURITY_ARCHITECTURE.md §5.8.

/**
 * The `users` columns the admin user-management surface may see.
 *
 * Deliberately absent, and the reason for each:
 *  - `password`     — bcrypt hash (credential)
 *  - `mfaSecret`    — AES-GCM encrypted TOTP seed (credential)
 *  - `chatMemory`   — free-form clinician memory blob, log-tier PHI
 *  - `googleId`     — federated subject identifier, of no use to this screen
 *  - `externalStorage` — internal storage routing, not user data
 */
export const ADMIN_USER_VIEW_FIELDS = [
  "id",
  "email",
  "firstName",
  "lastName",
  "fullName",
  "profileImageUrl",
  "authProvider",
  "userType",
  "isAdmin",
  "isSystemAdmin",
  "credits",
  "subscriptionType",
  "subscriptionExpiresAt",
  "isActive",
  "lastActiveAt",
  "onboardingStep",
  "referralCode",
  "referredById",
  "createdAt",
  "updatedAt",
  "genCapOverride",
  "dlCapOverride",
  "storedBoardsCap",
  "chatCreditsUsed",
  "chatCreditsUpdated",
  "slpMode",
  "mfaEnabled",
  "mfaEnforcedByAdmin",
  "phone",
  "phoneVerifiedAt",
  "biometricDataId",
] as const;

/**
 * The `students` columns allowed onto an admin USER row. This list exists
 * because `getAllUsersWithStudents` hangs each user's students off their record:
 * a students row carries `birthDate`, `gender`, `chatMemory`,
 * `communicationProfile` and `biometricDataId` — PHI that the account-management
 * screen has no business with. It needs to say WHICH students an account
 * reaches, so it gets identity and nothing else.
 */
export const ADMIN_STUDENT_SUMMARY_FIELDS = [
  "id",
  "name",
  "createdAt",
] as const;

/** Build a new object holding only `fields`. Never mutates or re-wraps `row`. */
function project<K extends string>(
  row: Record<string, unknown> | null | undefined,
  fields: readonly K[],
): Record<K, unknown> {
  const out = {} as Record<K, unknown>;
  if (!row) return out;
  for (const field of fields) {
    if (field in row) out[field] = row[field];
  }
  return out;
}

/** One `users` row, reduced to the admin-visible allowlist. */
export function toAdminUserView(user: unknown): Record<string, unknown> {
  return project(user as Record<string, unknown>, ADMIN_USER_VIEW_FIELDS);
}

/** One `students` row, reduced to the identity fields the admin screen needs. */
export function toAdminStudentSummary(student: unknown): Record<string, unknown> {
  return project(student as Record<string, unknown>, ADMIN_STUDENT_SUMMARY_FIELDS);
}

/** A `users` row plus its students, both reduced to their allowlists. */
export function toAdminUserWithStudentsView(
  user: unknown,
  students: unknown[] | null | undefined,
): Record<string, unknown> {
  return {
    ...toAdminUserView(user),
    students: (students ?? []).map(toAdminStudentSummary),
  };
}
