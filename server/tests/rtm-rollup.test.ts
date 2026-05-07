/**
 * Unit tests for the RTM rollup service helpers.
 *
 * Focuses on the trickiest pure functions: sleep window pairing, [a,b] vs
 * windows overlap, and local-date bucketing across timezone boundaries (incl.
 * DST). DB-backed integration tests live elsewhere — these run in milliseconds.
 */

import { describe, it, expect } from '@jest/globals';
import { __test } from '../services/insurance/rtmRollupService.js';
import {
  isSessionBillable,
  BILLABLE_SESSION_RULE_DESCRIPTION,
} from '../services/insurance/sessionBillability.js';

const { buildSleepWindows, overlapSeconds, localDateString, localDatesInPeriod, periodScanBoundsUtc } = __test;

const ev = (iso: string, toState: string) => ({
  studentId: 's1',
  createdAt: new Date(iso),
  details: { toState },
});

describe('buildSleepWindows', () => {
  it('pairs an asleep entry with the next non-sleep transition', () => {
    const windows = buildSleepWindows(
      [
        ev('2026-05-10T10:00:00Z', 'asleep'),
        ev('2026-05-10T10:05:00Z', 'awake'),
      ],
      new Date('2026-05-31T23:59:59Z'),
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].start.toISOString()).toBe('2026-05-10T10:00:00.000Z');
    expect(windows[0].end.toISOString()).toBe('2026-05-10T10:05:00.000Z');
  });

  it('treats hibernation as a sleep state', () => {
    const windows = buildSleepWindows(
      [
        ev('2026-05-10T10:00:00Z', 'hibernation'),
        ev('2026-05-10T10:10:00Z', 'awake'),
      ],
      new Date('2026-05-31T23:59:59Z'),
    );
    expect(windows).toHaveLength(1);
  });

  it('ignores duplicate sleep transitions while a window is open', () => {
    const windows = buildSleepWindows(
      [
        ev('2026-05-10T10:00:00Z', 'asleep'),
        ev('2026-05-10T10:01:00Z', 'hibernation'), // still sleep — no new window
        ev('2026-05-10T10:05:00Z', 'awake'),
      ],
      new Date('2026-05-31T23:59:59Z'),
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].end.toISOString()).toBe('2026-05-10T10:05:00.000Z');
  });

  it('closes an unclosed final window at unclosedClosesAt', () => {
    const windows = buildSleepWindows(
      [ev('2026-05-10T10:00:00Z', 'asleep')],
      new Date('2026-05-10T11:00:00Z'),
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].end.toISOString()).toBe('2026-05-10T11:00:00.000Z');
  });

  it('produces no windows when the stream stays awake', () => {
    expect(
      buildSleepWindows(
        [
          ev('2026-05-10T10:00:00Z', 'awake'),
          ev('2026-05-10T10:05:00Z', 'resting'),
        ],
        new Date('2026-05-31T23:59:59Z'),
      ),
    ).toEqual([]);
  });
});

describe('overlapSeconds', () => {
  const win = (s: string, e: string) => ({ start: new Date(s), end: new Date(e) });

  it('sums non-overlapping windows that fall inside the interval', () => {
    const seconds = overlapSeconds(
      new Date('2026-05-10T10:00:00Z'),
      new Date('2026-05-10T11:00:00Z'),
      [
        win('2026-05-10T10:10:00Z', '2026-05-10T10:20:00Z'), // 600s
        win('2026-05-10T10:40:00Z', '2026-05-10T10:50:00Z'), // 600s
      ],
    );
    expect(seconds).toBe(1200);
  });

  it('clips windows that extend past the interval bounds', () => {
    const seconds = overlapSeconds(
      new Date('2026-05-10T10:00:00Z'),
      new Date('2026-05-10T10:30:00Z'),
      [win('2026-05-10T09:00:00Z', '2026-05-10T11:00:00Z')], // window covers entire interval
    );
    expect(seconds).toBe(1800);
  });

  it('returns 0 when interval is empty or inverted', () => {
    const w = [win('2026-05-10T10:00:00Z', '2026-05-10T11:00:00Z')];
    expect(overlapSeconds(new Date('2026-05-10T10:30:00Z'), new Date('2026-05-10T10:30:00Z'), w)).toBe(0);
    expect(overlapSeconds(new Date('2026-05-10T11:00:00Z'), new Date('2026-05-10T10:00:00Z'), w)).toBe(0);
  });
});

describe('localDateString', () => {
  it('formats UTC midnight as the previous day in negative-offset zones', () => {
    // 2026-05-15T00:00:00Z is 2026-05-14T20:00 in America/New_York (EDT, UTC-4)
    expect(localDateString(new Date('2026-05-15T00:00:00Z'), 'America/New_York')).toBe('2026-05-14');
    // 2026-05-15T05:00:00Z is 2026-05-15T01:00 in America/New_York
    expect(localDateString(new Date('2026-05-15T05:00:00Z'), 'America/New_York')).toBe('2026-05-15');
  });

  it('formats UTC late-evening as next day in positive-offset zones', () => {
    // 2026-05-14T23:00:00Z is 2026-05-15T02:00 in Asia/Jerusalem (IDT, UTC+3)
    expect(localDateString(new Date('2026-05-14T23:00:00Z'), 'Asia/Jerusalem')).toBe('2026-05-15');
  });

  it('falls through to UTC when timezone is "UTC"', () => {
    expect(localDateString(new Date('2026-05-15T00:00:00Z'), 'UTC')).toBe('2026-05-15');
  });
});

describe('localDatesInPeriod', () => {
  it('returns a single date for a sub-day session', () => {
    const dates = localDatesInPeriod(
      new Date('2026-05-15T14:00:00Z'),
      new Date('2026-05-15T15:00:00Z'),
      'UTC',
      '2026-05',
    );
    expect(dates).toEqual(['2026-05-15']);
  });

  it('captures both dates for a session that crosses local midnight', () => {
    // 2026-05-14T22:00Z = 18:00 in NY; 2026-05-15T03:00Z = 23:00 in NY (still 5/14)
    const stillSameDay = localDatesInPeriod(
      new Date('2026-05-14T22:00:00Z'),
      new Date('2026-05-15T03:00:00Z'),
      'America/New_York',
      '2026-05',
    );
    expect(stillSameDay).toEqual(['2026-05-14']);

    // 2026-05-15T03:00Z = 23:00 NY (5/14); 2026-05-15T05:00Z = 01:00 NY (5/15)
    const crossesMidnight = localDatesInPeriod(
      new Date('2026-05-15T03:00:00Z'),
      new Date('2026-05-15T05:00:00Z'),
      'America/New_York',
      '2026-05',
    );
    expect(crossesMidnight.sort()).toEqual(['2026-05-14', '2026-05-15']);
  });

  it('drops dates outside the requested period', () => {
    const dates = localDatesInPeriod(
      new Date('2026-04-30T20:00:00Z'),
      new Date('2026-05-01T05:00:00Z'),
      'UTC',
      '2026-05',
    );
    expect(dates).toEqual(['2026-05-01']);
  });

  it('handles a multi-day session by returning every day touched', () => {
    const dates = localDatesInPeriod(
      new Date('2026-05-10T08:00:00Z'),
      new Date('2026-05-13T08:00:00Z'),
      'UTC',
      '2026-05',
    );
    expect(dates.sort()).toEqual(['2026-05-10', '2026-05-11', '2026-05-12', '2026-05-13']);
  });
});

describe('periodScanBoundsUtc', () => {
  it('returns a window that comfortably brackets any institute timezone', () => {
    const { startUtc, endUtc } = periodScanBoundsUtc('2026-05');
    expect(startUtc.toISOString()).toBe('2026-04-29T00:00:00.000Z');
    expect(endUtc.toISOString()).toBe('2026-06-03T00:00:00.000Z');
  });
});

describe('isSessionBillable', () => {
  it('counts a session with creditsUsed > 0', () => {
    expect(isSessionBillable({ creditsUsed: 0.01, log: [] })).toBe(true);
  });

  it('counts a session with more than one log entry', () => {
    expect(
      isSessionBillable({
        creditsUsed: 0,
        log: [{ role: 'user' }, { role: 'assistant' }] as any,
      }),
    ).toBe(true);
  });

  it('rejects an empty session (no credits, ≤1 log entry)', () => {
    expect(isSessionBillable({ creditsUsed: 0, log: [] })).toBe(false);
    expect(isSessionBillable({ creditsUsed: 0, log: [{ role: 'user' }] as any })).toBe(false);
  });

  it('exposes a human-readable description for admin display', () => {
    expect(BILLABLE_SESSION_RULE_DESCRIPTION).toMatch(/credits/i);
  });
});
