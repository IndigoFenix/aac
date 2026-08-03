/**
 * Jest Test Setup
 *
 * This file is run before each test file to set up the test environment.
 */

import { jest, beforeAll, afterAll } from '@jest/globals';
import dotenv from 'dotenv';

// Load .env so TEST_DATABASE_URL is visible inside test workers
// (jest workers don't auto-load it).
dotenv.config();

// Set test environment variables.
process.env.NODE_ENV = 'test';

// Force the connection at the TEST database, in every worker, BEFORE any test
// file imports server/db.ts (setupFilesAfterEnv runs first). Configs that drop
// `globalSetup` (jest.config.unit.js, jest.config.engine.js) never get the
// parent's redirect, so without this the worker would inherit whatever
// DATABASE_URL `.env` loaded — i.e. the REAL database. We deliberately do NOT
// honor a pre-existing DATABASE_URL here: TEST_DATABASE_URL is the source of
// truth for tests. (This once wiped a live DB via truncateAll — never again.)
const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test_db';

const testDbName = (() => {
  try {
    return new URL(TEST_DB_URL).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();

if (!testDbName.toLowerCase().includes('test')) {
  throw new Error(
    `[test setup] Refusing to run: test database name "${testDbName}" does not contain ` +
      `"test". Set TEST_DATABASE_URL to a dedicated test database.`,
  );
}

process.env.DATABASE_URL = TEST_DB_URL;

// Increase timeout for async operations
jest.setTimeout(30000);

// Mock console methods for cleaner test output (optional)
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

// NOTE — the full-suite crash is NOT an unhandled rejection.
// A full `npm test` dies partway through on an `ApiError: API key not valid`
// from @google/genai (a detached real-LLM call escaping some earlier suite).
// A `process.on('unhandledRejection')` handler here was TRIED on 2026-08-03 and
// did NOT fire: the handler never printed, and the process still died, so the
// throw reaches Node as an uncaught exception rather than a rejection — most
// likely because it surfaces after the originating test file's environment has
// been torn down, when jest has already removed the sandbox's listeners.
// Anything that does catch it would have to sit outside the per-file sandbox —
// globalSetup, a custom testEnvironment, or a runner-level wrapper. Until then,
// verify changes with focused suites (`npm run test:unit -- <word>`,
// `npm run test:engine`, or a single integration file) rather than a full run.

beforeAll(() => {
  // Suppress logs during tests unless DEBUG is set
  if (!process.env.DEBUG) {
    console.log = jest.fn();
    console.warn = jest.fn();
    // Keep error logs visible
    // console.error = jest.fn();
  }
});

afterAll(() => {
  // Restore console methods
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
});

// Global test utilities
declare global {
  var testUtils: {
    generateUUID: () => string;
    waitFor: (ms: number) => Promise<void>;
  };
}

globalThis.testUtils = {
  generateUUID: () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  },
  waitFor: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
};

export {};
