// Auto-provisioning logic for SSO. Lives in its own module so it can be
// imported and tested without pulling in the heavyweight `openid-client`
// transitive dependency that `identityService.ts` requires.
//
// Used by the unauthenticated SSO callback when the provider has
// `autoProvision = true` and no existing link is found. Creates a new
// user from the canonical claims, or links an existing user matched by
// email when the institute already provisioned the roster.

import { userRepository } from "../repositories/userRepository";
import { identityProviderRepository } from "../repositories/identityProviderRepository";
import type { CanonicalProfile } from "./identity-claim-mapping";
import type { IdentityProvider, User } from "@shared/schema";

/** Map IdP-supplied userType claims into our internal user_type buckets.
 *  Anything we don't recognize falls through to "Caregiver". */
const USER_TYPE_MAP: Record<string, string> = {
  teacher: "Teacher",
  staff: "Teacher",
  slp: "SLP",
  parent: "Parent",
  guardian: "Parent",
  caregiver: "Caregiver",
};

export async function autoProvisionFromProfile(
  provider: IdentityProvider,
  profile: CanonicalProfile,
): Promise<{ user: User; created: boolean }> {
  if (!provider.autoProvision) {
    throw new Error("Provider has auto-provisioning disabled");
  }
  if (!profile.email) {
    throw new Error("Cannot auto-provision: SSO assertion has no email claim");
  }

  const email = profile.email.toLowerCase();
  const existing = await userRepository.getUserByEmail(email);
  if (existing) {
    await identityProviderRepository.upsertExternalIdentity({
      userId: existing.id,
      providerId: provider.id,
      externalId: profile.externalId,
      email: profile.email,
      claims: profile.raw,
      verifiedAt: new Date(),
    });
    return { user: existing, created: false };
  }

  const givenName = profile.givenName ?? profile.fullName?.split(/\s+/)[0] ?? "";
  const familyName = profile.familyName ?? profile.fullName?.split(/\s+/).slice(1).join(" ") ?? "";

  const userType = profile.userType
    ? (USER_TYPE_MAP[profile.userType.toLowerCase()] ?? "Caregiver")
    : "Caregiver";

  const created = await userRepository.createUser({
    email,
    firstName: givenName || null,
    lastName: familyName || null,
    authProvider: provider.protocol === "saml" ? "saml" : "sso",
    userType,
    password: null,
  } as any);

  await identityProviderRepository.upsertExternalIdentity({
    userId: created.id,
    providerId: provider.id,
    externalId: profile.externalId,
    email: profile.email,
    claims: profile.raw,
    verifiedAt: new Date(),
  });
  return { user: created, created: true };
}
