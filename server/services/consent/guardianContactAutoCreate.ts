// server/services/consent/guardianContactAutoCreate.ts
// When a family-institute admin creates a student in their family institute,
// auto-create a studentContacts row pointing back at the parent's user record
// so the consent wizard can prefill identity fields the admin captured at
// license provisioning. See planning-docs/student-consent-onboarding-plan.md.

import { db } from "../../db.js";
import { eq, and } from "drizzle-orm";
import { studentContacts, type StudentContact } from "@shared/schema";
import { instituteRepository } from "../../repositories/instituteRepository.js";
import { licenseRepository } from "../../repositories/licenseRepository.js";
import { userRepository } from "../../repositories/userRepository.js";

export interface AutoCreateArgs {
  studentId: string;
  creatingUserId: string;
  instituteIds: string[];
}

/**
 * Returns the new contact, or null when:
 *   - none of the institutes are 'family' type
 *   - the user isn't admin of the matching family institute
 *   - a contact for this student already links to this user (idempotent)
 */
export async function autoCreateGuardianContactForFamilyAdmin(
  args: AutoCreateArgs,
): Promise<StudentContact | null> {
  // 1. Find the first family institute the user admins from the supplied list.
  let familyInstituteId: string | null = null;
  for (const id of args.instituteIds) {
    const inst = await instituteRepository.getInstituteById(id);
    if (inst?.type !== "family") continue;
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(id, args.creatingUserId);
    if (isAdmin) {
      familyInstituteId = id;
      break;
    }
  }
  if (!familyInstituteId) return null;

  // 2. Idempotency: skip if a guardian contact already links to this user.
  const [existing] = await db
    .select()
    .from(studentContacts)
    .where(
      and(
        eq(studentContacts.studentId, args.studentId),
        eq(studentContacts.linkedUserId, args.creatingUserId),
      ),
    );
  if (existing) return existing;

  // 3. Pull what we know from the user record + license inviteDefaults.
  const user = await userRepository.getUser(args.creatingUserId);
  if (!user) return null;

  const licenses = await licenseRepository.getLicensesByInstituteId(familyInstituteId);
  const activeLicense = licenses.find((l) => l.isActive) ?? licenses[0];
  const defaults = activeLicense?.inviteDefaults ?? null;

  const fullName = user.fullName
    ?? [user.firstName, user.lastName].filter(Boolean).join(" ").trim()
    ?? user.email;

  // 4. Create the row. isLegalGuardian remains FALSE — it flips true only
  //    when the parent ticks the declaration in the consent wizard.
  const [created] = await db
    .insert(studentContacts)
    .values({
      studentId: args.studentId,
      name: fullName || "Guardian",
      relationship: "parent_guardian",
      role: "parent_guardian",
      linkedUserId: args.creatingUserId,
      contactEmail: user.email ?? null,
      contactPhone: (user as any).phone ?? null,
      governmentIdNumber: defaults?.governmentIdNumber ?? null,
      governmentIdType: defaults?.governmentIdType ?? null,
      governmentIdCountry: defaults?.governmentIdCountry ?? null,
      governmentIdVerifiedVia: defaults?.governmentIdNumber ? "manual_entry" : null,
      governmentIdVerificationProvider: defaults?.governmentIdNumber ? "admin_attested" : null,
      governmentIdVerifiedAt: defaults?.governmentIdNumber ? new Date() : null,
      isLegalGuardian: false,
      coGuardianAcknowledged: false,
    })
    .returning();
  return created ?? null;
}
