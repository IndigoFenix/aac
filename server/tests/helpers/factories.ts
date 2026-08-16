/**
 * Test fixture factories.
 *
 * Each factory wraps a real service or repository call so creating fixtures
 * also exercises the production code path. The goal is to keep test files
 * readable: most setup should be one or two factory calls.
 */

import { userService } from '../../services/userService.js';
import { studentService } from '../../services/studentService.js';
import { instituteService } from '../../services/instituteService.js';
import { licenseService } from '../../services/licenseService.js';
import { userRepository, instituteRepository, licenseRepository } from '../../repositories/index.js';
import type { User, Student, Institute, InstituteUser, UserStudent, License, StudentWithAacSettings } from '@shared/schema';
import type { LicensePermissions } from '@shared/license-permissions';
import type { ProgramFramework } from '@shared/program-framework';

let userCounter = 0;
let studentCounter = 0;
let instituteCounter = 0;

function uniqueEmail(prefix = 'user'): string {
  userCounter += 1;
  return `${prefix}-${Date.now()}-${userCounter}@test.local`;
}

// ==================== Users ====================

export interface MakeUserOptions {
  email?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  userType?: string;
  isAdmin?: boolean;
  isSystemAdmin?: boolean;
}

/**
 * Create a user via the real registration path. Default password: "test-password-123".
 */
export async function makeUser(opts: MakeUserOptions = {}): Promise<User> {
  const email = opts.email ?? uniqueEmail();
  const firstName = opts.firstName ?? 'Test';
  const lastName = opts.lastName ?? 'User';
  const { user } = await userService.registerUser({
    email,
    password: opts.password ?? 'test-password-123',
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    userType: opts.userType ?? 'Caregiver',
  } as any);

  // Apply admin flags after registration (registerUser ignores these on insert).
  if (opts.isAdmin || opts.isSystemAdmin) {
    return (await userRepository.updateUser(user.id, {
      isAdmin: opts.isAdmin ?? user.isAdmin,
      isSystemAdmin: opts.isSystemAdmin ?? user.isSystemAdmin,
    } as any)) as User;
  }
  return user;
}

// ==================== Institutes ====================

export interface MakeInstituteOptions {
  name?: string;
  type?: 'school' | 'clinic' | 'family';
  language?: string;
}

/**
 * Create an institute with `creatorUserId` as its admin.
 */
export async function makeInstitute(
  creatorUserId: string,
  opts: MakeInstituteOptions = {},
): Promise<{ institute: Institute; membership: InstituteUser }> {
  instituteCounter += 1;
  return instituteService.createInstitute(
    {
      name: opts.name ?? `Test Institute ${instituteCounter}`,
      type: opts.type ?? 'school',
      language: opts.language ?? null,
    } as any,
    creatorUserId,
  );
}

/**
 * Add an existing user to an institute as a non-admin member by default.
 * Bypasses the invite/email flow — direct repo call.
 */
export async function addUserToInstitute(
  instituteId: string,
  userId: string,
  opts: { role?: string; isAdmin?: boolean; userType?: string } = {},
): Promise<InstituteUser> {
  return instituteRepository.addUserToInstitute(
    instituteId,
    userId,
    opts.role ?? 'staff',
    opts.isAdmin ?? false,
    opts.userType,
  );
}

// ==================== Students ====================

export interface MakeStudentOptions {
  name?: string;
  firstName?: string;
  lastName?: string;
  framework?: ProgramFramework;
  primaryLanguage?: string;
  country?: string;
}

/**
 * Create a student with a userStudents link to `ownerUserId`.
 * Default role: "owner" (full medical + educational rights).
 */
export async function makeStudent(
  ownerUserId: string,
  opts: MakeStudentOptions & { role?: string } = {},
): Promise<{ student: StudentWithAacSettings; link: UserStudent }> {
  studentCounter += 1;
  const firstName = opts.firstName ?? 'TestStudent';
  const lastName = opts.lastName ?? String(studentCounter);
  return studentService.createStudentWithLink(
    {
      name: opts.name ?? `${firstName} ${lastName}`,
      firstName,
      lastName,
      framework: opts.framework ?? 'us_iep',
      primaryLanguage: opts.primaryLanguage ?? 'en',
      country: opts.country ?? 'US',
    } as any,
    ownerUserId,
    opts.role ?? 'owner',
  );
}

/**
 * Enroll a student into an institute.
 */
export async function enrollStudent(
  instituteId: string,
  studentId: string,
  requestingUserId: string,
): Promise<void> {
  const result = await instituteService.assignStudentToInstitute(
    instituteId,
    studentId,
    requestingUserId,
  );
  if (!result.success) {
    throw new Error(`enrollStudent failed: ${result.error ?? 'unknown error'}`);
  }
}

// ==================== Licenses ====================

export interface MakeLicenseOptions {
  inviteEmail?: string;
  permissions?: Partial<LicensePermissions> & { all?: boolean };
  isTrial?: boolean;
  trialExpiresAt?: string;
  licenseType?: string;
  instituteId?: string;
}

/**
 * Create a license. If `instituteId` is provided, the license is bound to that
 * institute (no email invite is sent). Skips the heavyweight createLicenseWithSetup
 * path so tests don't depend on email/SMTP.
 */
export async function makeLicense(
  opts: MakeLicenseOptions = {},
): Promise<License> {
  const inviteEmail = opts.inviteEmail ?? uniqueEmail('license');
  return licenseRepository.createLicense({
    name: `Test License ${inviteEmail}`,
    licenseType: opts.licenseType ?? 'standard',
    subscriptionType: 'monthly',
    permissions: (opts.permissions as LicensePermissions) ?? null,
    isTrial: opts.isTrial ?? false,
    trialExpiresAt: opts.trialExpiresAt ? new Date(opts.trialExpiresAt) : null,
    inviteEmail,
    instituteId: opts.instituteId ?? null,
    isActive: true,
  } as any);
}

// ==================== Re-exports for convenience ====================

export { userService, studentService, instituteService, licenseService };
export { userRepository, instituteRepository, licenseRepository };
