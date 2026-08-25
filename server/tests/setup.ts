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

// ── No live LLM credentials in a test worker ─────────────────────────────────
// `dotenv.config()` above hands every worker the developer's REAL keys and GCP
// service account, so any suite that slips past its provider mock bills a live
// account instead of failing. That is not hypothetical: `startup-resolver.test.ts`
// spent real Vertex money on every run, because `AAC_STARTUP_RESOLVER_TIMEOUT_MS=0`
// issued the call before the "resolver disabled" guard could decline it. The
// tests all PASSED — the only visible symptom was the abandoned request
// outliving its worker and killing it with ERR_VM_MODULE_NOT_MODULE from deep
// inside gaxios, intermittently, after the PASS line had already printed.
//
// So we take the keys away rather than trusting each suite to mock everything
// it transitively reaches. Same reasoning as the DATABASE_URL redirect below:
// a leak should cost an auth error, not an invoice. Removing the GCP project
// also means `vertexClientOptions()` returns null, so the Vertex client — and
// the google-auth token fetch that produced that crash — cannot be built here
// at all.
//
// The real-LLM suites (`npm run test:llm`, `npm run test:ai`) share this file
// via the base config and DO need the keys, so they opt back in explicitly.
if (!process.env.ALLOW_REAL_LLM_CREDENTIALS) {
  for (const key of [
    'GEMINI_API_KEY',
    'GEMINI_API_KEY_2',
    'GOOGLE_CLOUD_PROJECT_ID',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_APPLICATION_CREDENTIALS_JSON',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
  ]) {
    delete process.env[key];
  }
}

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
