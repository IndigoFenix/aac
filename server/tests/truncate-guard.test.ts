/**
 * Regression test for the truncateAll safety guard.
 *
 * Background: `truncateAll()` once wiped a real database because a test config
 * that dropped `globalSetup` left DATABASE_URL pointing at the live `postgres`
 * database. `assertTruncatable` is the hard, connection-level backstop that
 * refuses to truncate anything that isn't the configured test database. These
 * tests exercise the pure guard directly — no DB connection needed.
 */

import { describe, it, expect } from '@jest/globals';
import { assertTruncatable } from './helpers/db.js';

describe('assertTruncatable — truncateAll safety guard', () => {
  it('allows the exact configured test database', () => {
    expect(() => assertTruncatable('aac_integration_test', 'aac_integration_test')).not.toThrow();
  });

  it('allows a test-named DB when no expected name is configured', () => {
    expect(() => assertTruncatable('test_db', undefined)).not.toThrow();
  });

  it('REFUSES the real "postgres" database (the actual incident)', () => {
    expect(() => assertTruncatable('postgres', 'aac_integration_test')).toThrow(/REFUSING/);
    // and even with no expected name, "postgres" has no "test" in it:
    expect(() => assertTruncatable('postgres', undefined)).toThrow(/does not contain/);
  });

  it('REFUSES a real DB whose name lacks "test", regardless of instance name', () => {
    // The instance may be called "aac-test", but the DATABASE is what matters.
    expect(() => assertTruncatable('aac_staging', undefined)).toThrow(/REFUSING/);
    expect(() => assertTruncatable('production', undefined)).toThrow(/REFUSING/);
  });

  it('REFUSES a test-named DB that is not the configured one', () => {
    // Coincidental "test" in the name is not enough — must match TEST_DATABASE_URL.
    expect(() => assertTruncatable('some_other_test', 'aac_integration_test')).toThrow(
      /not the configured test database/,
    );
  });

  it('is case-insensitive on the "test" substring check', () => {
    expect(() => assertTruncatable('MyTESTdb', undefined)).not.toThrow();
  });
});
