// client/src/features/guided-setup/auto-launch.test.ts
//
/// <reference types="jest" />
//
// NOTE: no jest config currently covers `client/src/**` (jest.config.client.js
// only roots client-aac/ and client-shared/, and the server configs root
// server/). This test cannot be run via any existing npm script today — kept
// here anyway per the pure-function split, ready to run once a client/ jest
// project exists.

import { shouldAutoLaunchGuidedSetup, type ShouldAutoLaunchGuidedSetupInput } from './auto-launch';

const base: ShouldAutoLaunchGuidedSetupInput = {
  instituteId: 'inst-1',
  studentsInstituteId: 'inst-1',
  studentsLoading: false,
  studentCount: 0,
  isDashboard: true,
  hasFlow: false,
  notNow: false,
  alreadyLaunchedFor: null,
  isFirstSettle: true,
};

describe('shouldAutoLaunchGuidedSetup', () => {
  it('does NOT launch during the login race: institute resolved but the list still describes a different (or no) institute', () => {
    expect(
      shouldAutoLaunchGuidedSetup({ ...base, studentsInstituteId: null }),
    ).toBe(false);
    expect(
      shouldAutoLaunchGuidedSetup({ ...base, studentsInstituteId: undefined }),
    ).toBe(false);
  });

  it('launches for a genuinely empty institute (list confirmed loaded for this institute, zero students)', () => {
    expect(shouldAutoLaunchGuidedSetup(base)).toBe(true);
  });

  it('does not launch when the institute has students', () => {
    expect(shouldAutoLaunchGuidedSetup({ ...base, studentCount: 3 })).toBe(false);
  });

  it('launches after a fetch failure too — an errored load still leaves studentsInstituteId set and count 0, which reads as "confirmed empty" (current/accepted behavior, not distinguished from a real empty institute)', () => {
    expect(
      shouldAutoLaunchGuidedSetup({
        ...base,
        studentsInstituteId: 'inst-1',
        studentCount: 0,
        studentsLoading: false,
      }),
    ).toBe(true);
  });

  it('does not launch after "not now"', () => {
    expect(shouldAutoLaunchGuidedSetup({ ...base, notNow: true })).toBe(false);
  });

  it('does not launch again for an institute it already launched for', () => {
    expect(
      shouldAutoLaunchGuidedSetup({ ...base, alreadyLaunchedFor: 'inst-1' }),
    ).toBe(false);
  });

  it('does not launch off the dashboard', () => {
    expect(shouldAutoLaunchGuidedSetup({ ...base, isDashboard: false })).toBe(false);
  });

  it('does not launch when a flow is already active/parked', () => {
    expect(shouldAutoLaunchGuidedSetup({ ...base, hasFlow: true })).toBe(false);
  });

  it('does not launch with no institute selected', () => {
    expect(shouldAutoLaunchGuidedSetup({ ...base, instituteId: null })).toBe(false);
  });

  it('does not launch while students are loading', () => {
    expect(shouldAutoLaunchGuidedSetup({ ...base, studentsLoading: true })).toBe(false);
  });

  it('launches on the first settle this session, with zero students', () => {
    expect(shouldAutoLaunchGuidedSetup({ ...base, isFirstSettle: true })).toBe(true);
  });

  it('does not launch on a later settle for a different, empty institute mid-session (an institute switch is not a login)', () => {
    expect(
      shouldAutoLaunchGuidedSetup({
        ...base,
        instituteId: 'inst-2',
        studentsInstituteId: 'inst-2',
        isFirstSettle: false,
      }),
    ).toBe(false);
  });
});
