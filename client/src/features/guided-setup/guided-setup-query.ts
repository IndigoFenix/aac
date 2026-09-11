// client/src/features/guided-setup/guided-setup-query.ts
//
// The guided-setup view's react-query key, and the one invalidator.
//
// Its own module (rather than useGuidedSetup.tsx) because `useChat` invalidates
// on turn completion and `useGuidedSetup` imports `useChat` — a key living in
// the provider would be an import cycle. Same shape and same reasoning as
// `studentContactsQueryKey` / `invalidateConsentForStudent` in useConsentApi.

import type { QueryClient } from '@tanstack/react-query';

/**
 * One entry per (institute, student). `null` is a real key: it holds the view
 * of a flow that has not bound to anybody yet ("New student" before the AI has
 * created the row), which no GET can answer — it is written straight into the
 * cache from the POST that opened the flow.
 */
export const guidedSetupQueryKey = (
  instituteId: string | null | undefined,
  studentId: string | null | undefined,
) => ['guided-setup', instituteId ?? null, studentId ?? null] as const;

/**
 * The app-wide react-query default is `staleTime: Infinity`
 * (client/src/lib/queryClient.ts), so a view resolved before the AI wrote
 * anything never refetches on its own. Every chat turn that ran a guided flow
 * calls this — it is the single replacement for the server→client view push.
 */
export function invalidateGuidedSetup(
  qc: QueryClient,
  instituteId: string | null | undefined,
  studentId: string | null | undefined,
): void {
  if (!instituteId) return;
  void qc.invalidateQueries({ queryKey: guidedSetupQueryKey(instituteId, studentId) });
}
