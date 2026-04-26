// src/hooks/useSharesApi.tsx
// React Query hooks for the cross-institute sharing API.
// See planning-docs/cross-institute-sharing-plan.md and
// server/controllers/shareInviteController.ts.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import type {
  StudentShareInvite,
  ShareInviteBundle,
  ShareableObjectType,
  SharePermission,
  ObjectShare,
  StandingShare,
} from '@shared/schema';

export type {
  StudentShareInvite,
  ShareInviteBundle,
  ShareableObjectType,
  SharePermission,
  ObjectShare,
  StandingShare,
};

export type SharesRole = 'source' | 'target';

// =============================================================================
// QUERIES
// =============================================================================

/** Invites where this institute is the source OR target. */
export function useShareInvites(
  role: SharesRole,
  instituteId: string | undefined,
  enabled = true,
) {
  return useQuery<{ invites: StudentShareInvite[] }>({
    queryKey: ['/api/shares/invites', role, instituteId],
    queryFn: async () => {
      if (!instituteId) throw new Error('No institute selected');
      const res = await apiRequest(
        'GET',
        `/api/shares/invites?role=${role}&instituteId=${instituteId}`,
      );
      return res.json();
    },
    enabled: enabled && !!instituteId,
  });
}

/** Invites awaiting the current user as named guardian. */
export function useGuardianInbox(enabled = true) {
  return useQuery<{ invites: StudentShareInvite[] }>({
    queryKey: ['/api/shares/invites/inbox'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/shares/invites/inbox');
      return res.json();
    },
    enabled,
  });
}

/** Single invite detail. */
export function useShareInvite(inviteId: string | undefined, enabled = true) {
  return useQuery<{ invite: StudentShareInvite }>({
    queryKey: ['/api/shares/invites', inviteId],
    queryFn: async () => {
      if (!inviteId) throw new Error('No invite selected');
      const res = await apiRequest('GET', `/api/shares/invites/${inviteId}`);
      return res.json();
    },
    enabled: enabled && !!inviteId,
  });
}

// =============================================================================
// MUTATIONS
// =============================================================================

export interface CreateInviteRequest {
  studentId: string;
  sourceInstituteId: string | null;
  guardianUserId: string;
  bundle: ShareInviteBundle;
  message?: string | null;
  codeTtlHours?: number;
  shareExpiresAt?: string | null;
}

export interface CreateInviteResponse {
  success: true;
  invite: StudentShareInvite;
  /** Plaintext code — shown ONCE on creation; only the hash is persisted. */
  code: string;
}

/**
 * Create a share invite. Throws on `sensitive_unacknowledged` (422) — the
 * caller is expected to surface a confirmation dialog and resubmit with
 * `bundle.sensitiveAcknowledged: true`.
 */
export function useCreateShareInvite() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation<CreateInviteResponse, Error, CreateInviteRequest>({
    mutationFn: async (req) => {
      const res = await apiRequest('POST', '/api/shares/invites', req);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/shares/invites'] });
    },
    onError: (err) => {
      toast({
        title: 'Could not create share',
        description: err.message,
        variant: 'destructive',
      });
    },
  });
}

export function useApproveShareInvite() {
  const qc = useQueryClient();
  return useMutation<{ success: true; invite: StudentShareInvite }, Error, { inviteId: string }>({
    mutationFn: async ({ inviteId }) => {
      const res = await apiRequest('POST', `/api/shares/invites/${inviteId}/approve`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/shares/invites'] });
      qc.invalidateQueries({ queryKey: ['/api/shares/invites/inbox'] });
    },
  });
}

export function useDeclineShareInvite() {
  const qc = useQueryClient();
  return useMutation<
    { success: true; invite: StudentShareInvite },
    Error,
    { inviteId: string; by: 'guardian' | 'target' }
  >({
    mutationFn: async ({ inviteId, by }) => {
      const res = await apiRequest(
        'POST',
        `/api/shares/invites/${inviteId}/decline?by=${by}`,
      );
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/shares/invites'] });
      qc.invalidateQueries({ queryKey: ['/api/shares/invites/inbox'] });
    },
  });
}

export function useRedeemShareCode() {
  const qc = useQueryClient();
  return useMutation<
    { success: true; invite: StudentShareInvite },
    Error,
    { code: string; targetInstituteId: string }
  >({
    mutationFn: async (body) => {
      const res = await apiRequest('POST', '/api/shares/redeem', body);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/shares/invites'] });
    },
  });
}

export function useAcceptShareInvite() {
  const qc = useQueryClient();
  return useMutation<
    {
      success: true;
      invite: StudentShareInvite;
      objectShares: ObjectShare[];
      standingShares: StandingShare[];
    },
    Error,
    { inviteId: string }
  >({
    mutationFn: async ({ inviteId }) => {
      const res = await apiRequest('POST', `/api/shares/invites/${inviteId}/accept`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/shares/invites'] });
    },
  });
}

export function useRevokeShareInvite() {
  const qc = useQueryClient();
  return useMutation<{ success: true; invite: StudentShareInvite }, Error, { inviteId: string }>({
    mutationFn: async ({ inviteId }) => {
      const res = await apiRequest('POST', `/api/shares/invites/${inviteId}/revoke`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/shares/invites'] });
      qc.invalidateQueries({ queryKey: ['/api/shares/invites/inbox'] });
    },
  });
}

// =============================================================================
// ACTIVE SHARES (materialized object_shares + standing_shares for an institute)
// =============================================================================

export interface ActiveSharesResponse {
  success: true;
  objectShares: ObjectShare[];
  standingShares: StandingShare[];
  /** Map of student id → display name, for grouped rendering. */
  students: Record<string, { id: string; name: string }>;
}

/** Materialized shares for an institute, in the source or target role. */
export function useActiveShares(
  role: SharesRole,
  instituteId: string | undefined,
  enabled = true,
) {
  return useQuery<ActiveSharesResponse>({
    queryKey: ['/api/shares/active', role, instituteId],
    queryFn: async () => {
      if (!instituteId) throw new Error('No institute selected');
      const res = await apiRequest(
        'GET',
        `/api/shares/active?role=${role}&instituteId=${instituteId}`,
      );
      return res.json();
    },
    enabled: enabled && !!instituteId,
  });
}

/** Granular per-object-share revoke. Distinct from invite-level revoke. */
export function useRevokeObjectShare() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation<{ success: true; share: ObjectShare }, Error, { objectShareId: string }>({
    mutationFn: async ({ objectShareId }) => {
      const res = await apiRequest(
        'POST',
        `/api/shares/object-shares/${objectShareId}/revoke`,
      );
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/shares/active'] });
      qc.invalidateQueries({ queryKey: ['/api/shares/invites'] });
    },
    onError: (err) => {
      toast({
        title: 'Failed to revoke',
        description: err.message,
        variant: 'destructive',
      });
    },
  });
}

/** Granular per-standing-share revoke. Distinct from invite-level revoke. */
export function useRevokeStandingShare() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation<{ success: true; share: StandingShare }, Error, { standingShareId: string }>({
    mutationFn: async ({ standingShareId }) => {
      const res = await apiRequest(
        'POST',
        `/api/shares/standing-shares/${standingShareId}/revoke`,
      );
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/shares/active'] });
      qc.invalidateQueries({ queryKey: ['/api/shares/standing-shares/inbox'] });
      qc.invalidateQueries({ queryKey: ['/api/shares/invites'] });
    },
    onError: (err) => {
      toast({
        title: 'Failed to revoke',
        description: err.message,
        variant: 'destructive',
      });
    },
  });
}

// =============================================================================
// STANDING-SHARE RENEWAL
// =============================================================================

/** Standing share paired with its parent invite, as returned by the inbox endpoint. */
export interface StandingShareWithInvite {
  share: StandingShare;
  invite: StudentShareInvite;
}

/**
 * Standing shares whose parent invite names the current user as guardian.
 * Includes active, expiring, expired, and revoked rows — UI filters as needed.
 */
export function useStandingSharesInbox(enabled = true) {
  return useQuery<{ shares: StandingShareWithInvite[] }>({
    queryKey: ['/api/shares/standing-shares/inbox'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/shares/standing-shares/inbox');
      return res.json();
    },
    enabled,
  });
}

/**
 * Bulk-revoke every active share (object + standing) the calling guardian
 * granted to a specific recipient institute for a specific student. Used
 * when a student transfers institutes and the guardian wants to wind down
 * access in one click.
 */
export interface BulkRevokeRequest {
  studentId: string;
  targetInstituteId: string;
}
export interface BulkRevokeResponse {
  success: true;
  objectSharesRevoked: number;
  standingSharesRevoked: number;
}
export function useBulkRevokeShares() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation<BulkRevokeResponse, Error, BulkRevokeRequest>({
    mutationFn: async (req) => {
      const res = await apiRequest('POST', '/api/shares/bulk-revoke', req);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/shares/active'] });
      qc.invalidateQueries({ queryKey: ['/api/shares/standing-shares/inbox'] });
      qc.invalidateQueries({ queryKey: ['/api/shares/invites'] });
    },
    onError: (err) => {
      toast({
        title: 'Failed to revoke',
        description: err.message,
        variant: 'destructive',
      });
    },
  });
}

/**
 * Renew a standing share. The server extends `shareExpiresAt` by 1 year
 * from the current moment (not from the existing expiry — see service docs).
 * Permission: only the named guardian on the parent invite.
 */
export function useRenewStandingShare() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation<{ success: true; share: StandingShare }, Error, { standingShareId: string }>({
    mutationFn: async ({ standingShareId }) => {
      const res = await apiRequest(
        'POST',
        `/api/shares/standing-shares/${standingShareId}/renew`,
      );
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/shares/standing-shares/inbox'] });
    },
    onError: (err) => {
      toast({
        title: 'Failed to renew',
        description: err.message,
        variant: 'destructive',
      });
    },
  });
}

// =============================================================================
// HELPERS
// =============================================================================

/** Human label for a shareable object type — fed into i18n via `shares.objectType.{type}`. */
export const SHAREABLE_OBJECT_TYPES: ShareableObjectType[] = [
  'program',
  'medical_record',
  'functional_report',
  'educational_report',
  'incident',
  'deep_analysis',
  'custom_app_assignment',
  'monitor_note',
];
