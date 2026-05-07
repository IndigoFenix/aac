// Generic claim-mapping layer. SAML attributes (e.g. urn:oid:1.2.840.113549.1.9.1)
// and OIDC claim names (e.g. "email", "preferred_username") both feed the same
// canonical profile shape. The mapping is stored per-provider in
// `identity_providers.claim_mappings` JSONB.
//
// Mapping format:
//   { externalId: ["sub", "uid"], email: ["email", "mail"], ... }
//
// The first source key found in the claims dict wins. Source keys are tried
// in order, so providers can declare a preferred order.

export interface CanonicalProfile {
  externalId: string;
  email?: string;
  givenName?: string;
  familyName?: string;
  fullName?: string;
  nationalIdNumber?: string;
  userType?: string;          // e.g. "teacher" | "student" | "staff"
  instituteCode?: string;     // institute identifier issued by the IdP
  raw: Record<string, unknown>;
}

export type ClaimMapping = Partial<Record<keyof Omit<CanonicalProfile, "raw">, string[]>>;

// Default mapping that works for most OIDC providers (Google, Microsoft, generic).
// Per-provider mappings override these.
const DEFAULT_MAPPING: ClaimMapping = {
  externalId: ["sub", "uid", "nameID"],
  email: ["email", "mail", "preferred_username"],
  givenName: ["given_name", "givenName", "first_name", "firstName"],
  familyName: ["family_name", "familyName", "last_name", "lastName", "surname"],
  fullName: ["name", "full_name", "fullName", "displayName"],
  nationalIdNumber: ["national_id", "nationalId", "id_number", "teudat_zehut"],
  userType: ["user_type", "userType", "role"],
  instituteCode: ["institute_code", "instituteCode", "school_id", "schoolId"],
};

function pickFirst(claims: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined {
  for (const k of keys) {
    const v = claims[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/**
 * Apply a (possibly partial) per-provider mapping on top of the default
 * mapping and produce a canonical profile. Throws if `externalId` cannot
 * be resolved — every successful authn must yield a stable user identifier.
 */
export function applyClaimMapping(
  claims: Record<string, unknown>,
  mapping: ClaimMapping | null | undefined,
): CanonicalProfile {
  const m: ClaimMapping = { ...DEFAULT_MAPPING, ...(mapping ?? {}) };

  const externalId = pickFirst(claims, m.externalId ?? DEFAULT_MAPPING.externalId!);
  if (!externalId) {
    throw new Error("Claim mapping resolved no externalId — provider claims missing sub/uid/nameID");
  }

  return {
    externalId,
    email: pickFirst(claims, m.email ?? []),
    givenName: pickFirst(claims, m.givenName ?? []),
    familyName: pickFirst(claims, m.familyName ?? []),
    fullName: pickFirst(claims, m.fullName ?? []),
    nationalIdNumber: pickFirst(claims, m.nationalIdNumber ?? []),
    userType: pickFirst(claims, m.userType ?? []),
    instituteCode: pickFirst(claims, m.instituteCode ?? []),
    raw: claims,
  };
}
