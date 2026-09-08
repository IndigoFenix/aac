// client/src/features/guided-setup/auto-launch.ts
//
// Pure decision function for the Guided Setup auto-launch effect, split out
// of useGuidedSetup.tsx so it can be unit-tested without dragging in React
// context providers (useStudent/useInstitute/useChat/wouter, etc).

export interface ShouldAutoLaunchGuidedSetupInput {
  instituteId: string | null;
  /** useStudent().studentsInstituteId — see that hook for the tri-state contract. */
  studentsInstituteId: string | null | undefined;
  studentsLoading: boolean;
  studentCount: number;
  isDashboard: boolean;
  /** isActive || !!view */
  hasFlow: boolean;
  notNow: boolean;
  alreadyLaunchedFor: string | null;
  /**
   * True only the FIRST time the student list has settled (any institute)
   * this session. Auto-launch is a login-time affordance; switching to a
   * different, empty institute mid-session is not a login and must not
   * re-trigger it — the "New student" button covers that case.
   */
  isFirstSettle: boolean;
}

/**
 * Whether the zero-student auto-launch should fire right now. Requires
 * POSITIVE evidence that the empty `students` array actually belongs to
 * `instituteId` (`studentsInstituteId === instituteId`) — `!studentsLoading`
 * alone is not enough, since `isLoading` can go false with a stale, empty
 * list while the institute is still resolving.
 */
export function shouldAutoLaunchGuidedSetup(input: ShouldAutoLaunchGuidedSetupInput): boolean {
  const {
    instituteId,
    studentsInstituteId,
    studentsLoading,
    studentCount,
    isDashboard,
    hasFlow,
    notNow,
    alreadyLaunchedFor,
    isFirstSettle,
  } = input;

  if (!instituteId) return false;
  if (!isDashboard) return false;
  if (studentsInstituteId !== instituteId) return false;
  if (studentsLoading) return false;
  if (studentCount !== 0) return false;
  if (hasFlow) return false;
  if (notNow) return false;
  if (alreadyLaunchedFor === instituteId) return false;
  if (!isFirstSettle) return false;

  return true;
}
