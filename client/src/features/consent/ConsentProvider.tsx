// client/src/features/consent/ConsentProvider.tsx
//
// ONE place in the clinician client that observes the student-scoped consent
// queries. Mounted in App.tsx beside GuidedSetupProvider, it fetches consent
// once per SELECTED student, independent of which panel happens to be open,
// and hands every consumer the result through context.
//
// ── Why a provider and not four hooks ────────────────────────────────────────
// The consent reads were fetched by whoever needed them, and several
// components need the same ones:
//   consent-active            → StudentInfoPanel + ConsentMissingIndicator,
//                               and the indicator is mounted in THREE places
//                               (TopHeader, ChatFeature, ChatPopup)
//   consent-authority         → StudentInfoPanel + ConsentAuthorityPanel
//                               + SendConsentRequestDialog
//   consent-history           → StudentInfoPanel + ConsentHistoryPanel
//   consent-pending-invitations → StudentInfoPanel + PendingInvitationsList
//
// While those requests SUCCEED react-query dedupes them by key, so the extra
// observers cost nothing and the multiplicity is invisible. The moment one
// ERRORS it stops being invisible: an errored query holds an error and no
// data, `shouldLoadOnMount` is `data === undefined && !(status === 'error' &&
// retryOnMount === false)`, and `staleTime: Infinity` only governs queries
// that HAVE data — so every newly-mounted observer on an errored key starts a
// fresh fetch. StudentInfoPanel's block settled on error, mounted its
// children, whose observers re-fetched, which flipped the queries back to
// pending, which un-settled the block and unmounted the children, and round it
// went: 124 requests to three endpoints in one page view, measured live.
//
// Removing the child observers removes the mechanism. Consumers below read
// context; only this file calls the query hooks, so a key has exactly one
// observer no matter how many components display it. The hooks additionally
// set `retryOnMount: false` (see the note in useConsentApi.tsx) so that even
// this provider re-mounting cannot re-drive an errored query.
//
// ── What is still react-query, and why that matters ──────────────────────────
// The fetch mechanism is unchanged: this file calls the same hooks against the
// same query keys. `invalidateConsentForStudent` / `invalidateAfterContactChange`
// (useConsentApi.tsx) — fired by every contact write, including the AI's path
// in useChat — therefore still refresh this provider's observers. That
// invalidation is what fixed "adding yourself as guardian needed a page
// reload"; replacing these hooks with bare fetches would silently undo it.
//
// ── Eager vs. lazy ───────────────────────────────────────────────────────────
// `active` loads for the selected student everywhere, because the header's
// ConsentMissingIndicator is on every page. `authority`, `history` and
// `invitations` are DETAIL: nothing outside the student-info panel shows them,
// each is a PHI read that writes an audit row, and a clinician clicking down a
// roster would otherwise fire an audit trail of consent-history reads for
// students they only glanced at. A consumer opts in by calling
// `useConsentDetail()`, which retains the detail slices for as long as it is
// mounted.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useStudent } from '@/hooks/useStudent';
import {
  consentBlockState,
  useActiveConsent,
  useConsentAuthority,
  useConsentHistory,
  usePendingInvitations,
  type ConsentAuthorityResponse,
  type ConsentGateStatus,
  type PendingInvitation,
  type StudentConsentRecord,
} from '@/hooks/useConsentApi';

// ============================================================================
// TYPES
// ============================================================================

/**
 * One consent read, as consumers see it.
 *
 * `isSettled` is the honest "we have an answer" flag: it is true for an ERROR
 * as well as for data. Rendering off `isLoading` alone is what let a failed
 * read be displayed as an empty one — no invitations, no authority, no
 * history — which states a fact nobody established. Check `isError` before
 * treating `data` as absence.
 */
export interface ConsentSlice<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  isSettled: boolean;
}

export interface ConsentContextValue {
  /** The student these slices describe — the selected student, or undefined. */
  studentId: string | undefined;
  /** The consent record currently in force; `null` when there is none. */
  active: ConsentSlice<StudentConsentRecord | null>;
  /**
   * The server's own gate decision for this student — `writesAllowed` is
   * literally "would a gated PHI write (e.g. report finalize) be refused".
   *
   * Rides the SAME `/active` request as `active`, so reading it costs no extra
   * observer and no extra round trip. Use it instead of inferring refusal from
   * `active.data === null`: the decision also folds in `CONSENT_GATE_ENABLED`
   * and the legacy grace window, and an absent record is not a refusal under
   * either. `data` is undefined when the read failed OR when the server predates
   * the field — in both cases treat the gate as UNKNOWN and let the 412 speak.
   */
  gate: ConsentSlice<ConsentGateStatus | undefined>;
  /** Detail — requires `useConsentDetail()`. */
  authority: ConsentSlice<ConsentAuthorityResponse>;
  /** Detail — requires `useConsentDetail()`. */
  history: ConsentSlice<StudentConsentRecord[]>;
  /** Detail — requires `useConsentDetail()`. */
  invitations: ConsentSlice<PendingInvitation[]>;
  /** All four slices have answered (success OR error). */
  blockSettled: boolean;
  /** At least one of the four answered with an error. */
  blockFailed: boolean;
  /** User-driven recovery. `retryOnMount: false` means nothing else re-drives
   *  an errored consent read, so this is the way back from a failure. */
  retry: () => void;
  /** Retain the detail slices; returns the release function (use in an effect). */
  retainDetail: () => () => void;
}

const ConsentContext = createContext<ConsentContextValue | null>(null);

/**
 * Read the consent state of the selected student. `active` is always live;
 * the detail slices only load while something holds them (`useConsentDetail`).
 */
export function useConsent(): ConsentContextValue {
  const ctx = useContext(ConsentContext);
  if (!ctx) {
    throw new Error('useConsent must be used within a ConsentProvider');
  }
  return ctx;
}

/**
 * Same value, but declares that this component needs the DETAIL slices
 * (authority / history / invitations) — they are fetched while it is mounted
 * and stop being fetched when the last holder unmounts.
 */
export function useConsentDetail(): ConsentContextValue {
  const ctx = useConsent();
  const { retainDetail } = ctx;
  useEffect(() => retainDetail(), [retainDetail]);
  return ctx;
}

// ============================================================================
// PROVIDER
// ============================================================================

function toSlice<TQuery, TData>(
  query: { data: TQuery | undefined; status: 'pending' | 'error' | 'success'; isError: boolean },
  select: (data: TQuery) => TData,
): ConsentSlice<TData> {
  return {
    data: query.data === undefined ? undefined : select(query.data),
    isLoading: query.status === 'pending',
    isError: query.isError,
    isSettled: query.status !== 'pending',
  };
}

export function ConsentProvider({ children }: { children: ReactNode }) {
  const { student } = useStudent();
  const studentId = student?.id;

  // Refcount rather than a boolean: the panel, its authority card and the
  // send-request dialog can each hold the detail slices, and the last one to
  // unmount is the one that releases them.
  const [detailHolders, setDetailHolders] = useState(0);
  const retainDetail = useCallback(() => {
    setDetailHolders((n) => n + 1);
    return () => setDetailHolders((n) => Math.max(0, n - 1));
  }, []);
  const detailEnabled = detailHolders > 0;

  const activeQuery = useActiveConsent(studentId);
  const authorityQuery = useConsentAuthority(studentId, detailEnabled);
  const historyQuery = useConsentHistory(studentId, detailEnabled);
  const invitationsQuery = usePendingInvitations(studentId, detailEnabled);

  const { refetch: refetchActive } = activeQuery;
  const { refetch: refetchAuthority } = authorityQuery;
  const { refetch: refetchHistory } = historyQuery;
  const { refetch: refetchInvitations } = invitationsQuery;
  const retry = useCallback(() => {
    void refetchActive();
    void refetchAuthority();
    void refetchHistory();
    void refetchInvitations();
  }, [refetchActive, refetchAuthority, refetchHistory, refetchInvitations]);

  const block = consentBlockState([activeQuery, authorityQuery, historyQuery, invitationsQuery]);

  const value = useMemo<ConsentContextValue>(
    () => ({
      studentId,
      active: toSlice(activeQuery, (d) => d.consent),
      gate: toSlice(activeQuery, (d) => d.gate),
      authority: toSlice(authorityQuery, (d) => d),
      history: toSlice(historyQuery, (d) => d.history),
      invitations: toSlice(invitationsQuery, (d) => d.invitations),
      blockSettled: !!studentId && block.settled,
      blockFailed: !!studentId && block.failed,
      retry,
      retainDetail,
    }),
    [
      studentId,
      activeQuery.data,
      activeQuery.status,
      activeQuery.isError,
      authorityQuery.data,
      authorityQuery.status,
      authorityQuery.isError,
      historyQuery.data,
      historyQuery.status,
      historyQuery.isError,
      invitationsQuery.data,
      invitationsQuery.status,
      invitationsQuery.isError,
      block.settled,
      block.failed,
      retry,
      retainDetail,
    ],
  );

  return <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>;
}
