// client/src/features/guided-setup/rail-status.test.ts
//
/// <reference types="jest" />
//
// Run with:  npm run test:client-app -- rail-status

import { railStatus, type RailStatusInput } from './rail-status';

const idle: RailStatusInput = {
  isLaunching: false,
  isBusy: false,
  live: false,
  isChatBusy: false,
  isRefreshing: false,
};

describe('railStatus', () => {
  it('says nothing when nothing is in flight', () => {
    expect(railStatus(idle)).toBeNull();
  });

  it('launching wins over everything — the provider folds it into isBusy too', () => {
    expect(
      railStatus({ ...idle, isLaunching: true, isBusy: true, live: true, isChatBusy: true }),
    ).toBe('launching');
  });

  it('a rail request reads as saving, even while a turn is in flight', () => {
    expect(railStatus({ ...idle, isBusy: true })).toBe('saving');
    expect(railStatus({ ...idle, isBusy: true, live: true, isChatBusy: true })).toBe('saving');
  });

  it('a chat turn is the flow working ONLY while a flow is live in this chat', () => {
    expect(railStatus({ ...idle, live: true, isChatBusy: true })).toBe('working');
    // The compact banner (no live flow) must not claim the user's own chatting.
    expect(railStatus({ ...idle, live: false, isChatBusy: true })).toBeNull();
  });

  it('a background refetch reads as refreshing, and yields to a turn', () => {
    expect(railStatus({ ...idle, isRefreshing: true })).toBe('refreshing');
    expect(railStatus({ ...idle, isRefreshing: true, live: true, isChatBusy: true })).toBe('working');
  });

  it('the end-of-turn refetch keeps the rail busy after the turn ends', () => {
    // A turn finishing invalidates the view; the rail must not go quiet in
    // the gap between the reply landing and the checklist catching up.
    expect(railStatus({ ...idle, live: true, isChatBusy: false, isRefreshing: true })).toBe(
      'refreshing',
    );
  });
});
