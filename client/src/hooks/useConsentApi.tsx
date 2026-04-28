// React Query hooks for the student informed-consent endpoints.
// Backed by /api/consent/* routes — see server/controllers/consentController.ts.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

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
}

export interface WizardContextResponse {
  success: true;
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

export interface SignConsentRequest {
  signedByContactId: string;
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
  isSensitive?: boolean;
}

// ============================================================================
// Hooks
// ============================================================================

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

export function useConsentWizardContext(studentId: string | undefined) {
  return useQuery<WizardContextResponse>({
    queryKey: ["consent-wizard-context", studentId],
    enabled: !!studentId,
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/consent/students/${studentId}/wizard-context`,
      );
      if (!res.ok) throw new Error(`Failed to load wizard context (${res.status})`);
      return res.json();
    },
  });
}

export function useConsentHistory(studentId: string | undefined) {
  return useQuery<{ success: true; history: StudentConsentRecord[] }>({
    queryKey: ["consent-history", studentId],
    enabled: !!studentId,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/consent/students/${studentId}/history`);
      if (!res.ok) throw new Error(`Failed to load history (${res.status})`);
      return res.json();
    },
  });
}

export function useActiveConsent(studentId: string | undefined) {
  return useQuery<{ success: true; consent: StudentConsentRecord | null }>({
    queryKey: ["consent-active", studentId],
    enabled: !!studentId,
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
        throw new Error(err.message ?? `Sign failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consent-active", studentId] });
      qc.invalidateQueries({ queryKey: ["consent-wizard-context", studentId] });
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
  requiresPhoneOtp: boolean;
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
  };
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
  isSensitive?: boolean;
}

export interface CreateInvitationRequest {
  studentId: string;
  contactId: string;
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

/** Lists active (pending, unexpired, unrevoked) invitations for a student. */
export function usePendingInvitations(studentId: string | undefined) {
  return useQuery<{ success: true; invitations: PendingInvitation[] }>({
    queryKey: ["consent-pending-invitations", studentId],
    enabled: !!studentId,
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
        throw new Error(err.message ?? `Revoke failed (${res.status})`);
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
      const params = new URLSearchParams({ code: code! });
      const res = await apiRequest("GET", `/api/consent/invitations/redeem?${params}`);
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
        throw e;
      }
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
        throw new Error(err.message ?? `Revoke failed (${res.status})`);
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
