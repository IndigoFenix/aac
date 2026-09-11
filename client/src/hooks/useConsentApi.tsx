// React Query hooks for the student informed-consent endpoints.
// Backed by /api/consent/* routes — see server/controllers/consentController.ts.

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

// ============================================================================
// Cross-domain cache invalidation
//
// The consent surface is DERIVED from the student's contacts: the wizard's
// guardian, the "who may consent" resolution and every pending invitation all
// read a studentContacts row. The app's react-query default is
// `staleTime: Infinity` (client/src/lib/queryClient.ts), so a consent query
// that resolved before a contact existed never refetches on its own — which is
// why adding yourself as a guardian used to need a page reload before the
// approval affordance appeared.
//
// Anything that creates / edits / confirms / deletes a contact must call
// `invalidateConsentForStudent`, and anything that signs consent (which flips
// `isLegalGuardian` on the contact row, see consentController) must invalidate
// the contacts list. Keep both key shapes here rather than re-typing literal
// key arrays at each call site.
// ============================================================================

/** The contacts-list query key used by StudentContactsPanel + ContactEditorModal. */
export const studentContactsQueryKey = (studentId: string | undefined) =>
  ["/api/biometric/students", studentId, "contacts"] as const;

/** Every consent query whose answer can change when a contact changes. */
export function invalidateConsentForStudent(
  qc: QueryClient,
  studentId: string | undefined,
): void {
  if (!studentId) return;
  // The wizard's guardianContact — the one that decides between "no guardian
  // contact" and the real signing flow.
  qc.invalidateQueries({ queryKey: ["consent-wizard-context", studentId] });
  // Resolved signer type (a new contact can satisfy a guardian requirement).
  qc.invalidateQueries({ queryKey: ["consent-authority", studentId] });
  // Invitations are addressed to a contact id; deleting one retires them.
  qc.invalidateQueries({ queryKey: ["consent-pending-invitations", studentId] });
  // The banner's gate. Cheap, and a contact change is exactly the moment the
  // user expects the consent card to re-evaluate.
  qc.invalidateQueries({ queryKey: ["consent-active", studentId] });
}

/** One call for every contact create / update / confirm / delete. */
export function invalidateAfterContactChange(
  qc: QueryClient,
  studentId: string | undefined,
): void {
  if (!studentId) return;
  qc.invalidateQueries({ queryKey: studentContactsQueryKey(studentId) });
  invalidateConsentForStudent(qc, studentId);
}

// ============================================================================
// Types matching the server payloads
// ============================================================================

export interface ConsentNoticeContent {
  title: string;
  purposeStatement: string;
  voluntarinessStatement: string;
  thirdPartyTransfersStatement: string;
  retentionStatement: string;
  rightsStatement: string;
}

export interface ConsentRecipientCategory {
  category:
    | "cloud_hosting"
    | "llm_provider"
    | "tts_provider"
    | "auth_provider"
    | "billing_provider"
    | "sub_processor";
  name: string;
  purpose: string;
}

export interface ConsentNoticeResponse {
  success: true;
  country: string;
  locale: string;
  version: string;
  hash: string;
  content: ConsentNoticeContent;
  thirdPartyRecipients: ConsentRecipientCategory[];
}

export interface StudentConsentRecord {
  id: string;
  studentId: string;
  signedByContactId: string;
  country: string;
  ageAtSigningYears: number;
  isMinorEnhancedProtection: boolean;
  enhancedProtectionRegime: string | null;
  consentTextVersion: string;
  consentTextHash: string;
  thirdPartyRecipients: ConsentRecipientCategory[];
  purposeAcknowledged: boolean;
  voluntarinessAcknowledged: boolean;
  thirdPartyTransfersAcknowledged: boolean;
  optInModelTraining: boolean;
  optInAdvertising: boolean;
  optInThirdPartyResearch: boolean;
  optInMarketingComms: boolean;
  optInsForcedOff: boolean;
  identityVerificationMethod: string;
  nonRepudiationMethod: string;
  signedAt: string;
  revokedAt: string | null;
  revocationReason?: string | null;
  /**
   * Server-computed: may the CURRENT caller revoke THIS record? Present only on
   * the `/history` response — the endpoint that feeds the revoke affordance.
   *
   * Reading a student's consent and being allowed to withdraw it are different
   * permissions: `/history` admits any institute member, while revoking wants
   * the original signer, a system admin, or — for a clinician-attested record
   * only — someone who could have attested it (see `revokePathFor` in
   * `server/controllers/consentController.ts`). The flag exists so the button
   * and the 403 cannot disagree; treat its ABSENCE as "not permitted", never as
   * "unknown, show it anyway".
   */
  canRevoke?: boolean;
  /**
   * Server-computed: may the CURRENT caller have a WITHDRAWAL LINK sent to this
   * record's signer? (§5.3 — the "the guardian phoned / lost the email" path.)
   *
   * True only when the caller is an institute admin for the student AND the
   * signer is someone the link could actually reach: no user account of their
   * own (a signer who has one uses their session) and an email or phone on
   * file. The client can see neither fact, so — as with `canRevoke` — absence
   * means "not offered", never "unknown, show it anyway".
   */
  canSendWithdrawalLink?: boolean;
}

export type ConsentAuthorityMode = "auto" | "guardian_required" | "self";
export type ConsentSignerType = "guardian" | "self";
export type GuardianshipBasis =
  | "minor"
  | "court_appointed_guardian"
  | "limited_guardian"
  | "supported_decision_making"
  | "power_of_attorney";

export interface ConsentAuthorityResponse {
  success: true;
  consentAuthority: ConsentAuthorityMode;
  guardianshipBasis: GuardianshipBasis | null;
  guardianshipEvidence: Record<string, unknown> | null;
  guardianshipReviewDate: string | null;
  resolved: { signerType: ConsentSignerType; basis: string; source: "override" | "age" } | null;
}

export interface WizardContextResponse {
  success: true;
  signerType?: ConsentSignerType | null;
  consentAuthority?: ConsentAuthorityMode;
  student: {
    id: string;
    name: string;
    firstName: string | null;
    lastName: string | null;
    birthDate: string | null;
    country: string | null;
    primaryLanguage: string | null;
  };
  user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    fullName: string | null;
    email: string;
    country: string | null;
    phone: string | null;
  } | null;
  guardianContact: {
    id: string;
    studentId: string;
    name: string;
    linkedUserId: string | null;
    governmentIdNumber: string | null;
    governmentIdType: string | null;
    governmentIdCountry: string | null;
    isLegalGuardian: boolean;
    coGuardianAcknowledged: boolean;
  } | null;
  activeConsent: StudentConsentRecord | null;
}

/**
 * The server's own answer to "would a gated PHI write be refused right now",
 * computed by `getConsentStatus` in server/services/consent/consentGate.ts and
 * shipped on the `/active` response.
 *
 * Read `writesAllowed`. Do NOT recompute it from `consent === null`: the gate
 * also honours the `CONSENT_GATE_ENABLED` flag and the legacy grace window, so
 * an absent record does not by itself mean a finalize would 412.
 */
export interface ConsentGateStatus {
  /** False means a gated write (e.g. report finalize) would return 412. */
  writesAllowed: boolean;
  hasActiveConsent: boolean;
  inLegacyGrace: boolean;
  legacyConsentDeadline: string | null;
  gateEnabled: boolean;
}

/** Supplemental signature evidence (type-to-sign or draw-to-sign). */
export interface ConsentSignaturePayload {
  mode: "typed" | "drawn";
  typedName?: string;
  /** PNG data URL when drawn. */
  image?: string;
  signedAt: string;
}

export interface SignConsentRequest {
  /** Omitted for self-consent (the logged-in student signs). */
  signedByContactId?: string;
  locale: string;
  consentTextVersion: string;
  consentTextHash: string;
  guardianFields?: {
    governmentIdNumber?: string;
    governmentIdType?: "national_id" | "passport" | "driver_license" | "other";
    governmentIdCountry?: string;
    coGuardianAcknowledged?: boolean;
  };
  purposeAcknowledged: boolean;
  voluntarinessAcknowledged: boolean;
  thirdPartyTransfersAcknowledged: boolean;
  optInModelTraining?: boolean;
  optInAdvertising?: boolean;
  optInThirdPartyResearch?: boolean;
  optInMarketingComms?: boolean;
  signature?: ConsentSignaturePayload;
  isSensitive?: boolean;
}

// ============================================================================
// Hooks
// ============================================================================

// 🚨 THE FOUR STUDENT-SCOPED CONSENT READS BELONG TO ConsentProvider.
//
// `useActiveConsent`, `useConsentAuthority`, `useConsentHistory` and
// `usePendingInvitations` must be called from exactly ONE place —
// `client/src/features/consent/ConsentProvider.tsx`. Everything else reads
// `useConsent()` / `useConsentDetail()`. Calling one of these from a component
// mounts a second observer on the key, and observer multiplicity is the
// mechanism behind the request loop documented in that file: an errored query
// holds an error and no data, react-query's `shouldLoadOnMount` is
// `data === undefined && !(status === 'error' && retryOnMount === false)`, and
// `staleTime: Infinity` only governs queries that HAVE data — so every newly
// mounted observer on an errored key fires another request. Measured live:
// 124 requests to three endpoints in a single page view.
//
// `retryOnMount: false` below is the second half of that fix: even the
// provider re-mounting cannot re-drive a query that has already failed. Its
// cost is that a transient failure no longer heals on its own — recovery is an
// explicit `refetch()` (the consent block's "Try again" button) or one of the
// `invalidate*` helpers above. `retry` was never the mechanism: the app
// default only retries 503s, and the loop ran anyway.

/** One query's settle state, as `consentBlockState` reads it. */
export interface ConsentQueryState {
  status: "pending" | "error" | "success";
  isError: boolean;
}

/**
 * The consent block's render decision, as a pure function so the rule is one
 * expression rather than four `isLoading` checks that drift.
 *
 * `settled` deliberately keys off `status`, not `isLoading`: a query that has
 * errored is decided, and treating it as still-loading holds the block on a
 * skeleton forever. `failed` exists so the block can SAY so — rendering an
 * errored consent query as "no invitations, no authority, no history" states a
 * fact nobody established.
 *
 * NOTE: there is no jest project over `client/src`, so this function has no
 * test. It is pure and exported for that reason.
 */
export function consentBlockState(queries: readonly ConsentQueryState[]): {
  settled: boolean;
  failed: boolean;
} {
  const settled = queries.every((q) => q.status !== "pending");
  return { settled, failed: settled && queries.some((q) => q.isError) };
}

export function useConsentNotice(country: string | undefined, locale: string) {
  return useQuery<ConsentNoticeResponse>({
    queryKey: ["consent-notice", country, locale],
    enabled: !!country,
    queryFn: async () => {
      const params = new URLSearchParams({ country: country!, locale });
      const res = await apiRequest("GET", `/api/consent/notice?${params}`);
      if (!res.ok) throw new Error(`Failed to load consent notice (${res.status})`);
      return res.json();
    },
  });
}

/**
 * `contactId` is the in-person-attestation variant: the signing guardian is a
 * contact the CALLER does not own, so the server's default "contact linked to
 * the current user" lookup finds nothing. The server gates that param behind
 * institute membership.
 *
 * It is part of the query key (a different contact is a different answer), and
 * the key stays PREFIXED by `["consent-wizard-context", studentId]` so
 * `invalidateConsentForStudent` keeps reaching it — react-query invalidation is
 * prefix-matched.
 */
export function useConsentWizardContext(
  studentId: string | undefined,
  contactId?: string,
) {
  return useQuery<WizardContextResponse>({
    queryKey: ["consent-wizard-context", studentId, contactId ?? null],
    enabled: !!studentId,
    queryFn: async () => {
      const suffix = contactId
        ? `?${new URLSearchParams({ contactId }).toString()}`
        : "";
      const res = await apiRequest(
        "GET",
        `/api/consent/students/${studentId}/wizard-context${suffix}`,
      );
      if (!res.ok) throw new Error(`Failed to load wizard context (${res.status})`);
      return res.json();
    },
  });
}

/** @internal ConsentProvider only — see the note above. Read `useConsentDetail()`. */
export function useConsentHistory(studentId: string | undefined, enabled = true) {
  return useQuery<{ success: true; history: StudentConsentRecord[] }>({
    queryKey: ["consent-history", studentId],
    enabled: !!studentId && enabled,
    retryOnMount: false, // see the note above the hooks
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/consent/students/${studentId}/history`);
      if (!res.ok) throw new Error(`Failed to load history (${res.status})`);
      return res.json();
    },
  });
}

/** @internal ConsentProvider only — see the note above. Read `useConsent()`. */
export function useActiveConsent(studentId: string | undefined) {
  return useQuery<{
    success: true;
    consent: StudentConsentRecord | null;
    /** Optional so an older/cached server response still types. */
    gate?: ConsentGateStatus;
  }>({
    queryKey: ["consent-active", studentId],
    enabled: !!studentId,
    retryOnMount: false, // see the note above the hooks
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/consent/students/${studentId}/active`,
      );
      if (!res.ok) throw new Error(`Failed to load active consent (${res.status})`);
      return res.json();
    },
  });
}

/**
 * Reads the consent-authority determination + resolved signer for a student.
 * @internal ConsentProvider only — see the note above. Read `useConsentDetail()`.
 */
export function useConsentAuthority(studentId: string | undefined, enabled = true) {
  return useQuery<ConsentAuthorityResponse>({
    queryKey: ["consent-authority", studentId],
    enabled: !!studentId && enabled,
    retryOnMount: false, // see the note above the hooks
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/consent/students/${studentId}/authority`);
      if (!res.ok) throw new Error(`Failed to load consent authority (${res.status})`);
      return res.json();
    },
  });
}

export interface SetConsentAuthorityRequest {
  mode: ConsentAuthorityMode;
  basis?: GuardianshipBasis | null;
  evidence?: Record<string, unknown> | null;
  reviewDate?: string | null;
}

export function useSetConsentAuthority(studentId: string) {
  const qc = useQueryClient();
  return useMutation<ConsentAuthorityResponse, Error, SetConsentAuthorityRequest>({
    mutationFn: async (body) => {
      const res = await apiRequest("PUT", `/api/consent/students/${studentId}/authority`, body);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const e = new Error(err.message ?? `Update failed (${res.status})`);
        (e as any).code = err.code;
        throw e;
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consent-authority", studentId] });
      qc.invalidateQueries({ queryKey: ["consent-wizard-context", studentId] });
    },
  });
}

export function useSignConsent(studentId: string) {
  const qc = useQueryClient();
  return useMutation<
    { success: true; consent: StudentConsentRecord },
    Error,
    SignConsentRequest
  >({
    mutationFn: async (body) => {
      const res = await apiRequest(
        "POST",
        `/api/consent/students/${studentId}/sign`,
        body,
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // Keep the server's code and zod issues on the error: the wizard
        // turns them into a translated sentence (features/consent/sign-error).
        const e = new Error(err.message ?? `Sign failed (${res.status})`);
        (e as any).code = err.code;
        (e as any).issues = err.issues;
        throw e;
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consent-active", studentId] });
      qc.invalidateQueries({ queryKey: ["consent-wizard-context", studentId] });
      qc.invalidateQueries({ queryKey: ["consent-history", studentId] });
      // Signing WRITES to the contact row (isLegalGuardian = true, plus the
      // government-ID fields) — see consentController's sign handler. Without
      // this the contacts list keeps the pre-signature copy forever
      // (staleTime: Infinity).
      qc.invalidateQueries({ queryKey: studentContactsQueryKey(studentId) });
    },
  });
}

/**
 * The clinic-desk sign: the guardian is in the room and the clinician records
 * the consent from their own session.
 *
 * Note what this payload does NOT carry: `identityVerificationMethod`,
 * `nonRepudiationMethod` and `isSensitive`. The server forces all three — see
 * `IN_PERSON_IDV_METHOD` in `server/controllers/consentController.ts`. Adding
 * them here would be dead weight at best (the server's zod schema strips them)
 * and a false suggestion that the client gets a say at worst.
 */
export interface AttestInPersonRequest {
  signedByContactId: string;
  locale: string;
  consentTextVersion: string;
  consentTextHash: string;
  /** The GUARDIAN's own signature — required on this path, not optional. */
  signature: ConsentSignaturePayload;
  attestation: {
    guardianPresent: true;
    identificationType: "national_id" | "passport" | "driver_license" | "other";
    identificationCountry?: string;
    notes?: string;
  };
  guardianFields?: {
    governmentIdNumber?: string;
    governmentIdCountry?: string;
    coGuardianAcknowledged?: boolean;
  };
  purposeAcknowledged: boolean;
  voluntarinessAcknowledged: boolean;
  thirdPartyTransfersAcknowledged: boolean;
  optInModelTraining?: boolean;
  optInAdvertising?: boolean;
  optInThirdPartyResearch?: boolean;
  optInMarketingComms?: boolean;
}

export function useAttestConsentInPerson(studentId: string) {
  const qc = useQueryClient();
  return useMutation<
    { success: true; consent: StudentConsentRecord },
    Error,
    AttestInPersonRequest
  >({
    mutationFn: async (body) => {
      const res = await apiRequest(
        "POST",
        `/api/consent/students/${studentId}/attest-in-person`,
        body,
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const e = new Error(err.message ?? `Attestation failed (${res.status})`);
        (e as any).code = err.code;
        (e as any).issues = err.issues;
        throw e;
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consent-active", studentId] });
      qc.invalidateQueries({ queryKey: ["consent-wizard-context", studentId] });
      qc.invalidateQueries({ queryKey: ["consent-history", studentId] });
      // Attesting WRITES to the contact row (isLegalGuardian, gov-ID type,
      // verification provider) — same reason as useSignConsent.
      qc.invalidateQueries({ queryKey: studentContactsQueryKey(studentId) });
      // A pending magic link for the same guardian is now moot.
      qc.invalidateQueries({ queryKey: ["consent-pending-invitations", studentId] });
    },
  });
}

// ============================================================================
// Token-based magic-link flow (parents without an account)
// ============================================================================

export interface ConsentInvitationContextResponse {
  success: true;
  invitationId: string;
  channel: "email" | "sms" | "manual";
  recipientType: "guardian" | "self";
  requiresPhoneOtp: boolean;
  requiresIdVerification: boolean;
  idVerified: boolean;
  contactPhoneMasked: string | null;
  student: {
    id: string;
    name: string;
    firstName: string | null;
    lastName: string | null;
    birthDate: string | null;
    country: string | null;
    primaryLanguage: string | null;
  };
  // Null for self-consent invitations — the student signs for themselves.
  contact: {
    id: string;
    name: string;
    relationship: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    governmentIdNumber: string | null;
    governmentIdType: string | null;
    governmentIdCountry: string | null;
    isLegalGuardian: boolean;
    coGuardianAcknowledged: boolean;
  } | null;
  expiresAt: string;
}

export interface SignWithTokenRequest {
  code: string;
  locale: string;
  consentTextVersion: string;
  consentTextHash: string;
  guardianFields?: SignConsentRequest["guardianFields"];
  purposeAcknowledged: boolean;
  voluntarinessAcknowledged: boolean;
  thirdPartyTransfersAcknowledged: boolean;
  optInModelTraining?: boolean;
  optInAdvertising?: boolean;
  optInThirdPartyResearch?: boolean;
  optInMarketingComms?: boolean;
  signature?: ConsentSignaturePayload;
  isSensitive?: boolean;
}

export interface CreateInvitationRequest {
  studentId: string;
  /** Required for guardian invitations; omitted for self-consent. */
  contactId?: string;
  /** Defaults to the student's resolved signer. "self" sends to the student. */
  recipientType?: "guardian" | "self";
  /** The student's own email/phone for a self-consent invitation. */
  selfDestination?: string;
  sourceInstituteId: string;
  channel: "email" | "sms" | "manual";
  ttlDays?: number;
}

export interface CreateInvitationResponse {
  success: true;
  invitation: { id: string; expiresAt: string; channel: string; sentTo: string };
  code: string;             // shown once
  redemptionUrl: string;
}

export interface PendingInvitation {
  id: string;
  studentId: string;
  contactId: string;
  channel: "email" | "sms" | "manual";
  sentTo: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Lists active (pending, unexpired, unrevoked) invitations for a student.
 * @internal ConsentProvider only — see the note above. Read `useConsentDetail()`.
 */
export function usePendingInvitations(studentId: string | undefined, enabled = true) {
  return useQuery<{ success: true; invitations: PendingInvitation[] }>({
    queryKey: ["consent-pending-invitations", studentId],
    enabled: !!studentId && enabled,
    retryOnMount: false, // see the note above the hooks
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/consent/students/${studentId}/invitations`,
      );
      if (!res.ok) throw new Error(`Failed to load invitations (${res.status})`);
      return res.json();
    },
  });
}

export function useRevokeConsentInvitation() {
  const qc = useQueryClient();
  return useMutation<{ success: true }, Error, { invitationId: string; studentId: string }>({
    mutationFn: async ({ invitationId }) => {
      const res = await apiRequest(
        "POST",
        `/api/consent/invitations/${invitationId}/revoke`,
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const e = new Error(err.message ?? `Revoke failed (${res.status})`);
        (e as any).code = err.code;
        throw e;
      }
      return res.json();
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["consent-pending-invitations", variables.studentId] });
    },
  });
}

export function useCreateConsentInvitation() {
  const qc = useQueryClient();
  return useMutation<CreateInvitationResponse, Error, CreateInvitationRequest>({
    mutationFn: async (req) => {
      const res = await apiRequest("POST", "/api/consent/invitations", req);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const e = new Error(err.message ?? `Send failed (${res.status})`);
        (e as any).code = err.code;
        throw e;
      }
      return res.json();
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["consent-pending-invitations", variables.studentId] });
    },
  });
}

/**
 * Public — no auth required. Reads the magic-link code from the URL and
 * resolves the wizard context. Same shape as useConsentWizardContext so
 * the wizard component can consume either.
 */
export function useConsentInvitation(code: string | undefined) {
  return useQuery<ConsentInvitationContextResponse>({
    queryKey: ["consent-invitation", code],
    enabled: !!code,
    retry: false,
    queryFn: async () => {
      // POST with the code in the body — it must not appear in a request URL.
      const res = await apiRequest("POST", "/api/consent/invitations/redeem", { code: code! });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const e = new Error(err.message ?? `Code lookup failed (${res.status})`);
        (e as any).code = err.code;
        throw e;
      }
      return res.json();
    },
  });
}

/** Public — no auth. Sends an SMS OTP to the contact phone for this invitation. */
export function useRequestPhoneOtp() {
  return useMutation<
    { success: true; sentTo: string; expiresAt: string; bypass: boolean },
    Error,
    { code: string }
  >({
    mutationFn: async ({ code }) => {
      const res = await apiRequest("POST", "/api/consent/invitations/request-otp", { code });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const e = new Error(err.message ?? `Request failed (${res.status})`);
        (e as any).code = err.code;
        (e as any).details = err.details;
        throw e;
      }
      return res.json();
    },
  });
}

/** Public — no auth. Verifies the OTP entered by the parent. */
export function useVerifyPhoneOtp() {
  return useMutation<
    { success: true; verifiedAt: string; sentTo: string },
    Error,
    { code: string; otpCode: string }
  >({
    mutationFn: async (body) => {
      const res = await apiRequest("POST", "/api/consent/invitations/verify-otp", body);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const e = new Error(err.message ?? `Verify failed (${res.status})`);
        (e as any).code = err.code;
        (e as any).details = err.details;
        throw e;
      }
      return res.json();
    },
  });
}

/**
 * Public — no auth. Verifies the last-4 of the child's institute ID for an
 * email-channel invitation. On failure, the thrown error carries `.code`
 * (e.g. child_id_mismatch / child_id_verify_locked) and `.details`
 * (`attemptsRemaining`).
 */
export function useVerifyChildId() {
  return useMutation<
    { success: true; verifiedAt: string; attemptsRemaining: number },
    Error,
    { code: string; last4: string }
  >({
    mutationFn: async (body) => {
      const res = await apiRequest("POST", "/api/consent/invitations/verify-id", body);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const e = new Error(err.message ?? `Verify failed (${res.status})`);
        (e as any).code = err.code;
        (e as any).details = err.details;
        throw e;
      }
      return res.json();
    },
  });
}

/** Public — no auth. Submits the wizard with the token. */
export function useSignWithToken() {
  return useMutation<
    { success: true; consent: StudentConsentRecord },
    Error,
    SignWithTokenRequest
  >({
    mutationFn: async (body) => {
      const res = await apiRequest("POST", "/api/consent/invitations/sign", body);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const e = new Error(err.message ?? `Sign failed (${res.status})`);
        (e as any).code = err.code;
        (e as any).issues = err.issues;
        throw e;
      }
      return res.json();
    },
  });
}

// ============================================================================
// Self-serve withdrawal — a signer with NO user account (§5.3)
//
// Every hook in this block is PUBLIC (no session) and lives OUTSIDE
// ConsentProvider: the withdrawal page is rendered for a guardian who has no
// account, so none of the provider's student-scoped reads exist for them and
// none of the `@internal` rules above apply. They are all mutations, so they
// also add no observer to any query key — the request-loop mechanism documented
// above cannot be reached from here.
//
// The only exception is `useReissueWithdrawalLink`, which IS authenticated: it
// is the clinic's "the guardian phoned" affordance in ConsentHistoryPanel.
// ============================================================================

export interface WithdrawalContextResponse {
  success: true;
  invitationId: string;
  channel: "email" | "sms";
  requiresPhoneOtp: boolean;
  requiresIdVerification: boolean;
  idVerified: boolean;
  contactPhoneMasked: string | null;
  student: { id: string; name: string; firstName: string | null; lastName: string | null };
  contact: { id: string; name: string; relationship: string | null } | null;
  consent: { id: string; signedAt: string; consentTextVersion: string };
  expiresAt: string;
}

/** Attach the server's `code`/`details` to a thrown Error so the page can branch. */
async function throwApiError(res: Response, fallback: string): Promise<never> {
  const err = await res.json().catch(() => ({} as any));
  const e = new Error(err.message ?? `${fallback} (${res.status})`);
  (e as any).code = err.code;
  (e as any).details = err.details;
  throw e;
}

/**
 * PUBLIC — the receipt's reference URL lands here.
 *
 * The server ALWAYS answers 200 with the same body, on purpose: it must not
 * reveal whether the reference names a real consent record. So there is nothing
 * to branch on and the page must show the same "check your email/phone" message
 * either way. Do not add error handling that implies otherwise.
 */
export function useRequestWithdrawalLink() {
  return useMutation<{ success: true }, Error, { reference: string }>({
    mutationFn: async (body) => {
      const res = await apiRequest("POST", "/api/consent/withdraw/request-link", body);
      if (!res.ok) return throwApiError(res, "Request failed");
      return res.json();
    },
  });
}

/**
 * PUBLIC — resolve a withdrawal token. A MUTATION rather than a query because
 * the code must travel in a POST body, never a URL (it would otherwise land in
 * CDN/ALB access logs), and because resolving it is a step the page drives
 * once rather than a cache entry.
 */
export function useWithdrawalContext() {
  return useMutation<WithdrawalContextResponse, Error, { code: string }>({
    mutationFn: async (body) => {
      const res = await apiRequest("POST", "/api/consent/withdraw/context", body);
      if (!res.ok) return throwApiError(res, "Code lookup failed");
      return res.json();
    },
  });
}

/** PUBLIC — send/re-send the SMS OTP for a withdrawal token. */
export function useRequestWithdrawalOtp() {
  return useMutation<
    { success: true; sentTo: string; expiresAt: string; bypass: boolean },
    Error,
    { code: string }
  >({
    mutationFn: async (body) => {
      const res = await apiRequest("POST", "/api/consent/withdraw/request-otp", body);
      if (!res.ok) return throwApiError(res, "Request failed");
      return res.json();
    },
  });
}

/** PUBLIC — verify the OTP for a withdrawal token. */
export function useVerifyWithdrawalOtp() {
  return useMutation<
    { success: true; verifiedAt: string; sentTo: string },
    Error,
    { code: string; otpCode: string }
  >({
    mutationFn: async (body) => {
      const res = await apiRequest("POST", "/api/consent/withdraw/verify-otp", body);
      if (!res.ok) return throwApiError(res, "Verify failed");
      return res.json();
    },
  });
}

/** PUBLIC — verify the child-ID last-4 for an email-channel withdrawal token. */
export function useVerifyWithdrawalChildId() {
  return useMutation<
    { success: true; verifiedAt: string; attemptsRemaining: number },
    Error,
    { code: string; last4: string }
  >({
    mutationFn: async (body) => {
      const res = await apiRequest("POST", "/api/consent/withdraw/verify-id", body);
      if (!res.ok) return throwApiError(res, "Verify failed");
      return res.json();
    },
  });
}

/**
 * PUBLIC — the withdrawal itself.
 *
 * `confirm: true` is required by the server (`z.literal(true)`). It is passed
 * here rather than defaulted server-side so that the affirmative act is visible
 * at the call site: this mutation must only ever be fired from a human clicking
 * the confirmation button, never from an effect on page load.
 */
export function useConfirmWithdrawal() {
  return useMutation<
    { success: true; revokedAt: string | null },
    Error,
    { code: string; reason?: string }
  >({
    mutationFn: async ({ code, reason }) => {
      const res = await apiRequest("POST", "/api/consent/withdraw/confirm", {
        code,
        confirm: true,
        reason,
      });
      if (!res.ok) return throwApiError(res, "Withdrawal failed");
      return res.json();
    },
  });
}

/**
 * AUTHENTICATED — the clinic re-issues a withdrawal link because the guardian
 * phoned or lost the email. Institute-admin gated server-side.
 *
 * The response carries a MASKED destination only; the clinician never sees the
 * code, which is what keeps this from becoming a way to withdraw a
 * parent-signed consent from the clinic side.
 */
export function useReissueWithdrawalLink() {
  return useMutation<
    { success: true; channel: "email" | "sms"; sentTo: string; expiresAt: string },
    Error,
    { consentId: string; channel?: "email" | "sms" }
  >({
    mutationFn: async ({ consentId, channel }) => {
      const res = await apiRequest(
        "POST",
        `/api/consent/${consentId}/withdrawal-link`,
        channel ? { channel } : {},
      );
      if (!res.ok) return throwApiError(res, "Send failed");
      return res.json();
    },
  });
}

export function useRevokeConsent() {
  const qc = useQueryClient();
  return useMutation<
    { success: true; consent: StudentConsentRecord },
    Error,
    { consentId: string; reason?: string }
  >({
    mutationFn: async ({ consentId, reason }) => {
      const res = await apiRequest(
        "POST",
        `/api/consent/${consentId}/revoke`,
        { reason },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const e = new Error(err.message ?? `Revoke failed (${res.status})`);
        (e as any).code = err.code;
        throw e;
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consent-active"] });
      qc.invalidateQueries({ queryKey: ["consent-wizard-context"] });
      qc.invalidateQueries({ queryKey: ["consent-history"] });
    },
  });
}
